/**
 * Iman–Conover rank-correlation induction.
 *
 * Reorders the per-assumption sample columns so their Spearman (rank)
 * correlations approximate a target matrix, while leaving every marginal
 * exactly as sampled — only the pairing across trials changes. This is the
 * method Crystal Ball uses to correlate assumptions.
 *
 * Algorithm (Iman & Conover, 1982):
 *   1. Build van der Waerden normal scores v_i = Φ⁻¹(i/(n+1)); each column of
 *      the score matrix S is an independent random permutation of v.
 *   2. E = corr(S). Cholesky: target C = P·Pᵀ, E = Q·Qᵀ.
 *   3. T = S · (P·Q⁻¹)ᵀ has sample correlation ≈ C.
 *   4. For each column, reorder the real samples to share T's rank pattern.
 */

import { normInv } from './special';
import { pearson } from './statistics';
import { Rng } from './rng';

/** Lower-triangular Cholesky factor L with C = L·Lᵀ, with a jitter fallback. */
export function choleskyLower(C: number[][]): number[][] {
  const k = C.length;
  const L: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  // Copy so we can add jitter to the diagonal if C is not quite PD.
  const A = C.map((row) => row.slice());
  let jitter = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    let ok = true;
    for (let i = 0; i < k; i++) L[i].fill(0);
    for (let i = 0; i < k && ok; i++) {
      for (let j = 0; j <= i; j++) {
        let sum = A[i][j];
        for (let m = 0; m < j; m++) sum -= L[i][m] * L[j][m];
        if (i === j) {
          if (sum <= 0) {
            ok = false;
            break;
          }
          L[i][j] = Math.sqrt(sum);
        } else {
          L[i][j] = sum / L[j][j];
        }
      }
    }
    if (ok) return L;
    jitter = jitter === 0 ? 1e-6 : jitter * 10;
    for (let i = 0; i < k; i++) A[i][i] = C[i][i] + jitter;
  }
  return L;
}

/** Inverse of a lower-triangular matrix via forward substitution. */
function invLowerTri(L: number[][]): number[][] {
  const k = L.length;
  const X: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let col = 0; col < k; col++) {
    X[col][col] = 1 / L[col][col];
    for (let i = col + 1; i < k; i++) {
      let sum = 0;
      for (let m = col; m < i; m++) sum += L[i][m] * X[m][col];
      X[i][col] = -sum / L[i][i];
    }
  }
  return X;
}

/** k×k matrix product. */
function matmul(A: number[][], B: number[][]): number[][] {
  const k = A.length;
  const out: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let i = 0; i < k; i++) {
    for (let m = 0; m < k; m++) {
      const a = A[i][m];
      if (a === 0) continue;
      for (let j = 0; j < k; j++) out[i][j] += a * B[m][j];
    }
  }
  return out;
}

/** Correlation matrix of a set of equal-length columns. */
function corrMatrix(cols: number[][]): number[][] {
  const k = cols.length;
  const C: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let i = 0; i < k; i++) {
    C[i][i] = 1;
    for (let j = i + 1; j < k; j++) {
      const r = pearson(cols[i], cols[j]);
      C[i][j] = r;
      C[j][i] = r;
    }
  }
  return C;
}

/** Ascending argsort (indices that would sort the array). */
function argsort(a: number[]): number[] {
  return Array.from({ length: a.length }, (_, i) => i).sort((x, y) => a[x] - a[y]);
}

/**
 * Impose the target rank-correlation matrix on the sample columns, in place.
 * `columns[j]` is assumption j's length-n sample; `target` is k×k.
 */
export function applyCorrelations(columns: number[][], target: number[][], rng: Rng): void {
  const k = columns.length;
  const n = columns[0]?.length ?? 0;
  if (k < 2 || n < 3) return;

  // 1. Van der Waerden scores and a score matrix (one permuted column each).
  const v = new Array<number>(n);
  for (let i = 0; i < n; i++) v[i] = normInv((i + 1) / (n + 1));
  const S: number[][] = [];
  for (let j = 0; j < k; j++) {
    const col = v.slice();
    for (let i = n - 1; i > 0; i--) {
      const r = Math.floor(rng.next() * (i + 1));
      const t = col[i];
      col[i] = col[r];
      col[r] = t;
    }
    S.push(col);
  }

  // 2. Factorize.
  const P = choleskyLower(target);
  const Q = choleskyLower(corrMatrix(S));
  const Qinv = invLowerTri(Q);
  const B = matmul(P, Qinv); // T = S · Bᵀ

  // 3. Transformed scores T (as columns), then 4. rank-match the samples.
  for (let c = 0; c < k; c++) {
    const Tc = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let m = 0; m < k; m++) s += S[m][i] * B[c][m];
      Tc[i] = s;
    }
    const orderT = argsort(Tc); // trial indices from smallest to largest T
    const sortedX = columns[c].slice().sort((a, b) => a - b);
    const newCol = new Array<number>(n);
    for (let r = 0; r < n; r++) newCol[orderT[r]] = sortedX[r];
    columns[c] = newCol;
  }
}

/** Build a k×k target matrix from pairwise coefficients (unit diagonal). */
export function buildTargetMatrix(
  ids: string[],
  pairs: { a: string; b: string; coefficient: number }[],
): { matrix: number[][]; hasAny: boolean } {
  const idx = new Map(ids.map((id, i) => [id, i]));
  const k = ids.length;
  const C: number[][] = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (_, j) => (i === j ? 1 : 0)),
  );
  let hasAny = false;
  for (const { a, b, coefficient } of pairs) {
    const i = idx.get(a);
    const j = idx.get(b);
    if (i === undefined || j === undefined || i === j) continue;
    const c = Math.max(-0.999, Math.min(0.999, coefficient));
    C[i][j] = c;
    C[j][i] = c;
    if (c !== 0) hasAny = true;
  }
  return { matrix: C, hasAny };
}
