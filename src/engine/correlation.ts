/**
 * Crystal Ball's assumption correlation: a per-trial Gaussian copula.
 *
 * Correlated assumptions fall into independent groups (connected components of
 * the pairs the user specified). For each group Crystal Ball works in Pearson
 * space — a Spearman target ρs becomes 2·sin(π·ρs/6) — fills pairs the user
 * left blank with the implied value (the product of Pearson coefficients along
 * the path that links them, unless "assume zero" is on), stores the result back
 * as Spearman, and factors the matrix rebuilt from those Spearman values as
 * V·Λ·Vᵀ with its own Householder + QL eigen solver. Each trial the group's
 * uniforms u become z = Φ⁻¹(u)·√λ, y = V·z and p = Φ(y): those p are what the
 * assumptions' inverse CDFs see, so marginals are exact and the rank
 * correlation lands on the target.
 *
 * Every step mirrors Crystal Ball 11.1.3 (OCB.Net Correlations, SharedMath
 * SymMatrix / SymTriDiagMatrix), including its round trips between the two
 * coefficient scales, so the same uniforms produce the same probabilities.
 */

import { ALMOST_0, inverseNormal, normalCdf } from './cbmath';
import * as libm from './libm';

/** One pairwise rank correlation as entered (assumption ids). */
export interface CorrelationPair {
  a: string;
  b: string;
  coefficient: number;
}

/** Spearman → Pearson, as Crystal Ball converts (exactly 0 becomes 5e-16). */
export function spearmanToPearson(s: number): number {
  return Math.abs(s) < ALMOST_0 ? ALMOST_0 : 2 * libm.sin(s * (Math.PI / 6));
}

/** Pearson → Spearman. */
export function pearsonToSpearman(p: number): number {
  return (6 / Math.PI) * libm.asin(p * 0.5);
}

/** A factored correlation group, ready to transform each trial's uniforms. */
export interface CorrelationGroup {
  /** Assumption ids in Crystal Ball's matrix order. */
  members: string[];
  /** The adjusted Spearman matrix (what Crystal Ball reports). */
  spearman: number[][];
  eigenvalues: number[];
  /** eigenvectors[j][k]: component j of the k-th eigenvector. */
  eigenvectors: number[][];
  /** √λ, with |λ| < 1e-8 treated as 0. */
  sqrtEigenvalues: number[];
  /** True when the pattern needed an approximation Crystal Ball may not share. */
  approximate: boolean;
}

/**
 * Group the pairs into Crystal Ball's correlation matrices: members and groups
 * appear in the order they are first mentioned.
 */
export function buildCorrelationGroups(
  pairs: CorrelationPair[],
  options: { assumeZero?: boolean } = {},
): CorrelationGroup[] {
  const valid = pairs.filter((p) => p.a !== p.b && Number.isFinite(p.coefficient));
  // Union-find over first-mention order.
  const order: string[] = [];
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    parent.set(x, r);
    return r;
  };
  for (const p of valid) {
    for (const id of [p.a, p.b]) {
      if (!parent.has(id)) {
        parent.set(id, id);
        order.push(id);
      }
    }
    const ra = find(p.a);
    const rb = find(p.b);
    if (ra !== rb) parent.set(rb, ra);
  }
  const groups = new Map<string, string[]>();
  for (const id of order) {
    const r = find(id);
    if (!groups.has(r)) groups.set(r, []);
    (groups.get(r) as string[]).push(id);
  }
  return [...groups.values()].map((members) =>
    factorGroup(
      members,
      valid.filter((p) => members.includes(p.a)),
      options.assumeZero ?? false,
    ),
  );
}

function factorGroup(members: string[], pairs: CorrelationPair[], assumeZero: boolean): CorrelationGroup {
  const n = members.length;
  const idx = new Map(members.map((id, i) => [id, i]));
  // Pearson matrix with the specified entries; NaN marks a blank.
  const P: number[][] = members.map((_, i) => members.map((__, j) => (i === j ? 1 : NaN)));
  const adj: number[][] = members.map(() => []);
  for (const p of pairs) {
    const i = idx.get(p.a) as number;
    const j = idx.get(p.b) as number;
    const v = spearmanToPearson(Math.max(-1, Math.min(1, p.coefficient)));
    if (Number.isNaN(P[i][j])) {
      adj[i].push(j);
      adj[j].push(i);
    }
    P[i][j] = v;
    P[j][i] = v;
  }

  let approximate = false;
  if (assumeZero) {
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (Number.isNaN(P[i][j])) P[i][j] = 0;
  } else {
    approximate = fillImplied(P, adj);
  }

  if (repairPsd(P) > 1) approximate = true;

  // Back to Spearman, then the Pearson matrix the copula factors.
  const S = P.map((row, i) => row.map((v, j) => (i === j ? 1 : v === 0 ? 0 : pearsonToSpearman(v))));
  const C = S.map((row, i) => row.map((v, j) => (i === j ? 1 : v === 0 ? 0 : 2 * libm.sin(v * (Math.PI / 6)))));
  if (!isPositiveSemidefinite(C)) approximate = true;
  const { values, vectors } = cbEigen(C);
  return {
    members,
    spearman: S,
    eigenvalues: values,
    eigenvectors: vectors,
    sqrtEigenvalues: values.map((l) => (Math.abs(l) < 1e-8 ? 0 : Math.sqrt(l))),
    approximate,
  };
}

/**
 * Fill blanks with the implied Pearson coefficient: the product along the path
 * linking the two assumptions, folded from the far end (Crystal Ball's order,
 * which matters in the last bit). Exact for tree-shaped patterns; a blank that
 * closes a cycle gets the product along one shortest path, and is reported as
 * approximate.
 */
function fillImplied(P: number[][], adj: number[][]): boolean {
  const n = P.length;
  let edges = 0;
  for (const a of adj) edges += a.length;
  const isTree = edges / 2 === n - 1;
  for (let i = 0; i < n; i++) {
    // BFS from i: prev[j] is j's neighbour on a shortest path back to i.
    const prev = new Array<number>(n).fill(-1);
    const seen = new Array<boolean>(n).fill(false);
    seen[i] = true;
    const queue = [i];
    while (queue.length) {
      const u = queue.shift() as number;
      for (const v of adj[u]) {
        if (!seen[v]) {
          seen[v] = true;
          prev[v] = u;
          queue.push(v);
        }
      }
    }
    for (let j = 0; j < n; j++) {
      if (!Number.isNaN(P[i][j]) || !seen[j]) continue;
      // Path i = p0, p1, …, pk = j; fold P(p0,p1)·(P(p1,p2)·(…·P(pk−1,pk))).
      const path: number[] = [];
      for (let v = j; v !== -1; v = prev[v]) path.unshift(v);
      let prod = P[path[path.length - 2]][path[path.length - 1]];
      for (let s = path.length - 3; s >= 0; s--) prod = P[path[s]][path[s + 1]] * prod;
      P[i][j] = prod;
      P[j][i] = prod;
    }
  }
  return !isTree;
}

/**
 * Crystal Ball's repair of an inconsistent (not positive semi-definite)
 * matrix, in place: eigenvalues below −1e-8 are raised to 0.0625 (its floor
 * of 2, halved while above 0.1), the spectrum is rescaled to trace n, and the
 * off-diagonal entries are rebuilt from it, clamped to ±0.9999. One pass
 * reproduces Crystal Ball exactly; the rare matrices that need more passes
 * repeat it. Returns the number of passes that changed the matrix.
 */
function repairPsd(P: number[][]): number {
  const n = P.length;
  const floor = 0.0625;
  let passes = 0;
  for (let iter = 0; iter < 300; iter++) {
    const { values, vectors } = cbEigen(P);
    let changed = false;
    let sum = 0;
    const lam = values.map((l) => {
      if (Math.abs(l) < 1e-8) return 0;
      if (l < 0) {
        changed = true;
        sum += floor;
        return floor;
      }
      sum += l;
      return l;
    });
    if (!changed) break;
    passes++;
    const k = n / sum;
    for (let i = 0; i < lam.length; i++) lam[i] *= k;
    for (let i = 1; i < n; i++) {
      for (let j = 0; j < i; j++) {
        let v = 0;
        for (let m = 0; m < n; m++) v += lam[m] * vectors[i][m] * vectors[j][m];
        v = Math.max(-0.9999, Math.min(0.9999, v));
        P[i][j] = v;
        P[j][i] = v;
      }
    }
  }
  return passes;
}

function isPositiveSemidefinite(C: number[][]): boolean {
  return cbEigen(C).values.every((l) => l > -1e-8);
}

/**
 * Crystal Ball's symmetric eigen decomposition: Householder reduction to
 * tridiagonal form, then implicit-shift QL. Eigenvalues come back in the order
 * QL leaves them (unsorted), eigenvectors as columns of `vectors`.
 */
export function cbEigen(M: number[][]): { values: number[]; vectors: number[][] } {
  const n = M.length;
  const A = M.map((r) => r.slice());
  const d = new Array<number>(n).fill(0); // tridiagonal diagonal
  const e = new Array<number>(n).fill(0); // e[i] couples i and i+1

  for (let i = n - 1; i > 0; i--) {
    const l = i - 1;
    if (l > 0) {
      let scale = 0;
      let h = 0;
      for (let k = 0; k <= l; k++) scale += Math.abs(A[i][k]);
      if (Math.abs(scale - 0) < 1e-14) {
        e[i - 1] = A[i][l];
      } else {
        let hh = 0;
        for (let k = 0; k <= l; k++) {
          A[i][k] /= scale;
          hh += A[i][k] * A[i][k];
        }
        const g = 0 - (A[i][l] >= 0 ? Math.abs(Math.sqrt(hh)) : 0 - Math.abs(Math.sqrt(hh)));
        h = hh - A[i][l] * g;
        A[i][l] -= g;
        e[i - 1] = scale * g;
        let f = 0;
        const w = new Array<number>(l + 1);
        for (let j = 0; j <= l; j++) {
          A[j][i] = A[i][j] / h;
          let gg = 0;
          for (let k = 0; k <= j; k++) gg += A[j][k] * A[i][k];
          for (let k = j + 1; k <= l; k++) gg += A[k][j] * A[i][k];
          w[j] = gg / h;
          f += A[i][j] * w[j];
        }
        f /= 2 * h;
        for (let j = 0; j <= l; j++) {
          w[j] -= f * A[i][j];
          for (let k = 0; k <= j; k++) A[j][k] -= w[k] * A[i][j] + A[i][k] * w[j];
        }
      }
      d[i] = h;
    } else {
      e[i - 1] = A[i][l];
    }
  }
  for (let i = 0; i < n; i++) {
    const l = i - 1;
    if (d[i] !== 0) {
      for (let j = 0; j <= l; j++) {
        let g = 0;
        for (let k = 0; k <= l; k++) g += A[i][k] * A[k][j];
        for (let k = 0; k <= l; k++) A[k][j] -= g * A[k][i];
      }
    }
    d[i] = A[i][i];
    A[i][i] = 1;
    for (let j = 0; j <= l; j++) {
      A[i][j] = 0;
      A[j][i] = 0;
    }
  }

  // Implicit-shift QL on (d, e), rotating A's columns.
  for (let l = 0; l < n; l++) {
    let iter = 0;
    for (;;) {
      let m = l;
      while (m < n - 1 && !(Math.abs(e[m]) < ALMOST_0)) m++;
      if (m === l) break;
      let g = (d[l + 1] - d[l]) / (2 * e[l]);
      let r = Math.sqrt(g * g + 1);
      g = d[m] - d[l] + e[l] / (g + (g >= 0 ? Math.abs(r) : -Math.abs(r)));
      let s = 1;
      let c = 1;
      let p = 0;
      let brokeAt = -1;
      for (let i = m - 1; i >= l; i--) {
        const f = s * e[i];
        const b = c * e[i];
        r = Math.sqrt(f * f + g * g);
        if (i < n - 2) e[i + 1] = r;
        if (r === 0) {
          d[i] -= p;
          e[m] = 0;
          brokeAt = i;
          break;
        }
        s = f / r;
        c = g / r;
        g = d[i + 1] - p;
        r = (d[i] - g) * s + 2 * c * b;
        p = s * r;
        d[i + 1] = g + p;
        g = c * r - b;
        for (let k = 0; k < n; k++) {
          const t = A[k][i + 1];
          A[k][i + 1] = s * A[k][i] + c * t;
          A[k][i] = c * A[k][i] - s * t;
        }
      }
      if (r === 0 && brokeAt >= l) continue;
      d[l] -= p;
      e[l] = g;
      if (m < n - 1) e[m] = 0;
      if (++iter > 100) break;
    }
  }
  return { values: d, vectors: A };
}

/**
 * Turn one trial's uniforms for a group's members (in `members` order) into
 * the correlated probabilities fed to their inverse CDFs.
 */
export function correlateTrial(group: CorrelationGroup, u: number[], out: number[]): void {
  const n = group.members.length;
  const z = new Array<number>(n);
  for (let k = 0; k < n; k++) z[k] = inverseNormal(u[k]) * group.sqrtEigenvalues[k];
  const V = group.eigenvectors;
  for (let j = 0; j < n; j++) {
    let y = 0;
    for (let k = 0; k < n; k++) y += z[k] * V[j][k];
    out[j] = normalCdf(y);
  }
}
