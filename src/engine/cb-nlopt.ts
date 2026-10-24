/**
 * Crystal Ball's nonlinear optimizer (SharedMath XMathKernel.NLOpt), used to
 * fit Triangular, BetaPERT, Beta and Lognormal parameters entered as
 * percentiles. A port, step for step, of:
 *
 *  - NLOptimizer.runOptimization: up to five Nelder–Mead runs, seeded 20001,
 *    24820, 22648 and two draws of .NET's Random(22648).Next(30000), each
 *    continuing from the previous run's best point, until the objective is
 *    "at optimum" (else NLOException);
 *  - the Nelder–Mead algorithm (class aj): reflection 1, expansion 2,
 *    contraction and shrink ½, points clamped to the variables' bounds and
 *    pulled toward the centroid until the constraint holds; the start simplex
 *    perturbs one coordinate per vertex (unconstrained) or scatters 2n random
 *    vertices over the bounds (constrained); a reflection that ties the best
 *    vertex within 1e-8 triggers one of two local pattern searches; it stops
 *    once the best value is within 1e-5 of the expected value, or when the
 *    spread of the vertex values stops changing;
 *  - .NET's seeded System.Random, QSort.SortIndex and Combinatorics.NextCombination.
 */

import * as libm from './libm';

export class NLOException extends Error {}

/** .NET's System.Random(seed) — Knuth's subtractive generator (Net5CompatSeedImpl). */
export class NetRandom {
  private seedArray = new Array<number>(56).fill(0);
  private inext = 0;
  private inextp = 21;

  constructor(seed: number) {
    const MBIG = 2147483647;
    const subtraction = seed === -2147483648 ? MBIG : Math.abs(seed);
    let mj = 161803398 - subtraction;
    this.seedArray[55] = mj;
    let mk = 1;
    let ii = 0;
    for (let i = 1; i < 55; i++) {
      if ((ii += 21) >= 55) ii -= 55;
      this.seedArray[ii] = mk;
      mk = mj - mk;
      if (mk < 0) mk += MBIG;
      mj = this.seedArray[ii];
    }
    for (let k = 1; k < 5; k++)
      for (let i = 1; i < 56; i++) {
        let n = i + 30;
        if (n >= 55) n -= 55;
        this.seedArray[i] -= this.seedArray[1 + n];
        if (this.seedArray[i] < 0) this.seedArray[i] += MBIG;
      }
  }

  private internalSample(): number {
    let a = this.inext;
    let b = this.inextp;
    if (++a >= 56) a = 1;
    if (++b >= 56) b = 1;
    let r = this.seedArray[a] - this.seedArray[b];
    if (r === 2147483647) r--;
    if (r < 0) r += 2147483647;
    this.seedArray[a] = r;
    this.inext = a;
    this.inextp = b;
    return r;
  }

  nextDouble(): number {
    return this.internalSample() * (1.0 / 2147483647);
  }

  next(maxValue: number): number {
    return Math.trunc(this.nextDouble() * maxValue);
  }
}

/** Helpers.QSort.Sort: in-place quicksort (middle pivot), as Crystal Ball sorts. */
export function qsort(a: number[], lo = 0, hi = a.length - 1): void {
  if (hi <= lo) return;
  let i = lo;
  let j = hi;
  const pivot = a[Math.trunc((lo + hi) / 2)];
  while (i <= j) {
    while (i < hi && !(a[i] >= pivot)) i++;
    while (j > lo && !(a[j] <= pivot)) j--;
    if (i <= j) {
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
      i++;
      j--;
    }
  }
  if (lo < j) qsort(a, lo, j);
  if (i < hi) qsort(a, i, hi);
}

/** QSort.SortIndex: order `idx` by a[idx[·]] (a itself is untouched). */
export function sortIndex(a: number[], idx: number[], lo = 0, hi = a.length - 1): void {
  if (hi <= lo) return;
  let i = lo;
  let j = hi;
  const pivot = a[idx[Math.trunc((lo + hi) / 2)]];
  while (i <= j) {
    while (i < hi && !(a[idx[i]] >= pivot)) i++;
    while (j > lo && !(a[idx[j]] <= pivot)) j--;
    if (i <= j) {
      const t = idx[i];
      idx[i] = idx[j];
      idx[j] = t;
      i++;
      j--;
    }
  }
  if (lo < j) sortIndex(a, idx, lo, j);
  if (i < hi) sortIndex(a, idx, i, hi);
}

/** Combinatorics.NextCombination(current, k): the next 0/1 mask with k ones; throws when exhausted. */
export function nextCombination(c: number[], k: number): number[] {
  let invalid = false;
  let last = true; // the first k entries are all 1
  let first = 0;
  let firstSeen = false;
  let lastOne = 0;
  let lastSeen = false;
  let ones = 0;
  for (let i = 0; i < c.length; i++) {
    if (c[i] !== 0 && c[i] !== 1) invalid = true;
    if (i < k && c[i] === 0) last = false;
    if (!firstSeen && c[i] === 1) {
      first = i;
      firstSeen = true;
    }
    if (!lastSeen && c[c.length - i - 1] === 1) {
      lastOne = c.length - i - 1;
      lastSeen = true;
    }
    if (c[i] === 1) ones++;
  }
  if (invalid) throw new Error('invalid combination');
  if (last) throw new Error('no more combinations');
  if (ones > k) throw new Error('too many objects');
  const a = [...c];
  if (first > 0) {
    a[first] = 0;
    a[first - 1] = 1;
    return a;
  }
  a[lastOne] = 0;
  for (let j = lastOne - 1; !(j < lastOne - k); j--) a[j] = 1;
  for (let j = lastOne - k - 1; !(j < 0); j--) a[j] = 0;
  return a;
}

/** NLOVar: a variable with bounds (NaN → unbounded) and a current value. */
export class NLOVar {
  readonly min: number;
  readonly max: number;
  private v: number;
  constructor(min: number, max: number, suggested: number) {
    this.min = Number.isNaN(min) ? -Infinity : min;
    this.max = Number.isNaN(max) ? Infinity : max;
    this.v = Number.isNaN(suggested) ? (this.min + this.max) / 2 : suggested;
  }
  get value(): number {
    return this.v;
  }
  set value(x: number) {
    if (x < this.min || x > this.max) throw new NLOException('value out of range');
    this.v = x;
  }
}

/** NLOObj: the function minimized, plus the optimizer's bookkeeping. */
export interface NLObjective {
  value(x: number[]): number;
  /** NaN, or the value that counts as reached (Crystal Ball's fits use 0). */
  expected: number;
}

interface ObjState {
  f: NLObjective;
  precision: number; // ExpectedValuePrecision
  current: number;
  atOptimum: boolean;
}

type Point = number[];
const add = (a: Point, b: Point) => a.map((x, i) => x + b[i]);
const sub = (a: Point, b: Point) => a.map((x, i) => x - b[i]);
const mul = (a: Point, s: number) => a.map((x) => x * s);
const div = (a: Point, s: number) => {
  if (s === 0) throw new Error('divide by zero');
  return a.map((x) => x / s);
};
const same = (a: Point, b: Point) => a === b || (a.length === b.length && a.every((x, i) => x === b[i]));
const bad = (v: number) => Number.isNaN(v) || v === Infinity || v === -Infinity;
const pow10 = (k: number) => libm.pow(10.0, k); // Math.Pow(10.0, k)

/** aj: Crystal Ball's Nelder–Mead. */
class NelderMead {
  private d: Point[] | null = null;
  private e: number[] = [];
  private f: number[] = [];
  private g = -Infinity;
  iterations = 0;

  constructor(
    private n: number,
    private maxIterations: number,
    private constraint: ((x: Point) => boolean) | null,
    private seed: number,
  ) {}

  /** NLOAlgo.setVarValue: clamp to the bounds (in place); optionally store as the variables' values. */
  private clamp(vars: NLOVar[], p: Point, store: boolean): Point {
    for (let i = 0; i < vars.length; i++) {
      const c = p[i];
      if (c < vars[i].min) p[i] = vars[i].min;
      else if (c > vars[i].max) p[i] = vars[i].max;
      if (store) vars[i].value = p[i];
    }
    return p;
  }

  /** aj.a(point, centroid): move toward the centroid until the constraint holds (≤ 200 steps). */
  private repair(p: Point, c: Point): Point {
    if (!this.constraint) return p;
    let k = 0.5;
    for (let it = 0; ; ) {
      if (this.constraint(p)) return p;
      let q = mul(add(p, c), k);
      if (same(q, p)) {
        k *= 0.5;
        q = mul(add(p, c), k);
      }
      p = q;
      if (!(++it <= 200)) return p;
    }
  }

  private init(vars: NLOVar[], obj: ObjState): boolean {
    const n = this.n;
    let d: Point[];
    if (!this.constraint) {
      d = [];
      for (let v = 0; v < n + 1; v++) {
        const p = vars.map((x) => x.value);
        if (v < n) {
          const coord = p[v];
          const toMin = (Math.abs(coord - vars[v].min) * 100.0) / Math.abs(coord);
          const toMax = (Math.abs(coord - vars[v].max) * 100.0) / Math.abs(coord);
          if (!(toMin > toMax)) {
            if (toMax < 50.0) p[v] = coord * 0.5 + vars[v].max * 0.5;
            else if (toMax >= 50.0 && toMax <= 200.0) p[v] = coord * 0.75 + vars[v].max * 0.25;
            else p[v] = coord + Math.abs(coord) * 2.0;
          } else if (toMin < 50.0) p[v] = 0.5 * (vars[v].min + coord);
          else if (toMin >= 50.0 && toMin <= 200.0) p[v] = vars[v].min * 0.25 + coord * 0.75;
          else p[v] = coord - Math.abs(coord) * 2.0;
        }
        d.push(p);
      }
    } else {
      d = [vars.map((x) => x.value)];
      let centroid = vars.map((x) => x.value);
      const rnd = new NetRandom(this.seed);
      const grid = vars.map((x) => Array.from({ length: 2 * n + 1 }, (_, j) => x.min + (j / (2 * n)) * (x.max - x.min)));
      for (let k = 1; k < 2 * n + 1; k++) {
        let p = vars.map((_, i) => grid[i][k - 1] + rnd.nextDouble() * (grid[i][k] - grid[i][k - 1]));
        p = this.repair(p, centroid);
        d.push(p);
        centroid = div(add(mul(centroid, k), p), k + 1);
      }
    }
    this.d = d;
    try {
      const e = new Array<number>(d.length);
      const failed: number[] = [];
      let c: Point = new Array<number>(n).fill(0);
      for (let i = 0; i < d.length; i++) {
        e[i] = obj.f.value(d[i]);
        if (bad(e[i])) failed.push(i);
        else c = add(c, d[i]);
      }
      this.e = e;
      if (failed.length > 0) {
        c = div(c, e.length - failed.length);
        if (bad(obj.f.value(c))) {
          for (let i = 0; i < d.length; i++)
            if (!bad(e[i])) {
              c = d[i];
              break;
            }
        }
        for (const k of failed) {
          const step = sub(d[k], c);
          let j = 0;
          for (let guard = 0; ; guard++) {
            if (guard > 1e6) throw new NLOException('could not move a vertex to a finite value');
            if (step[j] > 0.0) d[k][j] = d[k][j] - 0.01 * Math.abs(step[j]);
            else if (step[j] < 0.0) d[k][j] = d[k][j] + 0.01 * Math.abs(step[j]);
            j = j === n - 1 ? 0 : j + 1;
            e[k] = obj.f.value(d[k]);
            if (!bad(e[k])) break;
          }
        }
      }
      this.f = e.map((_, i) => i);
      sortIndex(e, this.f);
      return true;
    } catch (err) {
      if (err instanceof NLOException) throw err;
      return false;
    }
  }

  /** runOneIteration: one Nelder–Mead step; false when the run is over. */
  step(vars: NLOVar[], obj: ObjState, precision: number): boolean {
    this.iterations++;
    if (!this.d && !this.init(vars, obj)) return false;
    const d = this.d!;
    const e = this.e;
    const len = e.length;
    const worst = this.f[len - 1];
    const second = this.f[len - 2];
    const best = this.f[0];
    let c: Point = new Array<number>(this.n).fill(0);
    for (let i = 0; i < d.length; i++) if (i !== worst) c = add(c, d[i]);
    c = div(c, d.length - 1);
    const fc = obj.f.value(c);
    let r = this.clamp(vars, add(c, mul(sub(c, d[worst]), 1.0)), false);
    r = this.repair(r, c);
    const fr = obj.f.value(r);
    const shrink = () => {
      for (let i = 0; i < d.length; i++) {
        d[i] = this.clamp(vars, add(d[i], mul(sub(d[best], d[i]), 0.5)), false);
        d[i] = this.repair(d[i], d[best]);
        e[i] = obj.f.value(d[i]);
      }
    };
    const contract = () => {
      const towardWorst = e[worst] < fr;
      const target = towardWorst ? d[worst] : r;
      const fTarget = towardWorst ? e[worst] : fr;
      const k = this.clamp(vars, add(c, mul(sub(target, c), 0.5)), false);
      const fk = obj.f.value(k);
      if (!(fk >= fTarget) && !Number.isNaN(fk)) {
        d[worst] = k;
        e[worst] = fk;
      } else shrink();
    };
    if (fr < e[best]) {
      let x = this.clamp(vars, add(c, mul(sub(r, c), 2.0)), false);
      x = this.repair(x, c);
      const fx = obj.f.value(x);
      if (!(fx >= fr) && !Number.isNaN(fx)) {
        d[worst] = x;
        e[worst] = fx;
      } else {
        d[worst] = r;
        e[worst] = fr;
      }
    } else if (e[best] <= fr && fr <= e[second]) {
      if (Math.abs(fr - e[best]) < 1e-8) {
        const at = { p: r, v: fr };
        const ev = obj.f.expected;
        if (!Number.isNaN(ev) && !(Math.abs(ev - at.v) > 0.1)) {
          if (Math.abs(ev - at.v) < 0.1) this.searchNear(at, vars, c, obj);
        } else this.searchWide(at, vars, c, obj);
        d[worst] = at.p;
        e[worst] = at.v;
      } else {
        d[worst] = r;
        e[worst] = fr;
      }
    } else if (!(fr > e[second]) && !Number.isNaN(fr)) {
      /* unchanged (only reachable with a NaN best value) */
    } else contract();

    this.f = e.map((_, i) => i);
    sortIndex(e, this.f);
    obj.current = e[this.f[0]];
    this.clamp(vars, d[this.f[0]], true);
    let s = 0;
    for (let i = 0; i < d.length; i++) {
      const t = e[i] - fc;
      s += t * t;
    }
    s = Math.sqrt(s / d.length);
    const ev = obj.f.expected;
    if (Number.isNaN(ev)) {
      if (s !== this.g && !(s < precision) && !(this.iterations > this.maxIterations)) {
        this.g = s;
        return true;
      }
      obj.atOptimum = true;
      return false;
    }
    if (Math.abs(ev - obj.current) < obj.precision) {
      obj.atOptimum = true;
      return false;
    }
    if (s !== this.g && !(s < precision) && !(this.iterations > this.maxIterations)) {
      this.g = s;
      return true;
    }
    if (Math.abs(ev - obj.current) < obj.precision * 10.0) obj.atOptimum = true;
    return false;
  }

  /** aj.b: pattern search around a point that ties the best vertex (expected value unknown or far). */
  private searchWide(at: { p: Point; v: number }, vars: NLOVar[], centroid: Point, obj: ObjState): boolean {
    const dim = at.p.length;
    let step: Point = new Array<number>(dim).fill(0);
    let cur = at.p;
    let i = 0;
    let s = 9;
    let flag6 = false;
    let up = true;
    let down = true;
    let pos = true;
    let neg = true;
    let improved = false;
    let nSteps = 0;
    let nUp = 0;
    let nDown = 0;
    let base: Point = step;
    let prev: Point | null = null;
    let v0 = 0;
    let rel = 0;
    let sign = 1;
    let fv = 0;
    let fv2 = 0;
    let mag = 0;
    let absx = 0;
    let comboVals: number[] = [];
    let combo: number[] = [];
    let ci = 0;
    let k3 = 0;
    let k11 = 0;
    const move = () => {
      prev = cur;
      cur = this.repair(this.clamp(vars, add(cur, mul(step, sign)), false), centroid);
    };
    for (;;) {
      switch (s) {
        case 9:
          if (i >= at.p.length) {
            s = 103;
            break;
          }
          absx = Math.abs(at.p[i]);
          s = absx === 0 ? 12 : 52;
          break;
        case 12:
          mag = 0;
          s = 22;
          break;
        case 52:
          mag = Math.floor(libm.log10(absx));
          s = 22;
          break;
        case 22:
          if (mag < -6) mag = -6;
          else if (mag > 6) mag = 6;
          step[i] = pow10(mag);
          i++;
          s = 9;
          break;
        case 103:
          flag6 = false;
          up = true;
          down = true;
          pos = true;
          neg = true;
          improved = false;
          nSteps = 0;
          nUp = 0;
          nDown = 0;
          base = step;
          prev = null;
          v0 = at.v;
          rel = 0;
          sign = 1;
          s = 35;
          break;
        case 35:
          if (improved) {
            s = 5;
            break;
          }
          pos = true;
          neg = true;
          nSteps = 0;
          s = 94;
          break;
        case 94:
          if (improved) {
            s = 54;
            break;
          }
          sign = 1;
          s = !(!pos && neg) ? 97 : 76;
          break;
        case 76:
          sign = -1;
          s = 60;
          break;
        case 97:
          if (!pos) s = !neg ? 11 : 60;
          else s = 60;
          break;
        case 60:
          move();
          fv2 = obj.f.value(cur);
          if (fv2 < at.v) {
            const r14 = (at.v - fv2) / at.v;
            rel = (v0 - fv2) / v0;
            at.p = cur;
            at.v = fv2;
            if (r14 > 0.5 || rel > 0.5) improved = true;
            nSteps++;
          } else {
            cur = prev!;
            if (sign === 1.0) pos = false;
            else neg = false;
          }
          s = nSteps !== 10 ? 94 : 54;
          break;
        case 11:
          step = base;
          s = flag6 ? 50 : 78;
          break;
        case 78:
          flag6 = true;
          s = 54;
          break;
        case 50:
          if (flag6 && up && nUp >= 3) {
            up = false;
            s = 54;
            break;
          }
          s = 31;
          break;
        case 31:
          if (!up && down && nDown >= 3) down = false;
          s = 54;
          break;
        case 54:
          if (up) {
            step = mul(step, 10.0);
            nUp++;
            s = 35;
          } else if (down) {
            step = div(step, 10.0);
            nDown++;
            s = 35;
          } else s = 5;
          break;
        case 5:
          s = rel === 0.0 ? 79 : 41;
          break;
        case 79:
          if (!(step.length > 1)) {
            s = 41;
            break;
          }
          step = base;
          comboVals = [-3, -2, -1, -100, 0, 1, 2, 3];
          combo = comboVals.map((_, j) => (j < comboVals.length - step.length ? 0 : 1));
          s = 46;
          break;
        case 46:
          if (improved) {
            s = 41;
            break;
          }
          k3 = 0;
          for (k11 = 0; k11 < combo.length; k11++)
            if (combo[k11] === 1) step[k3++] = comboVals[k11] === -100 ? 0.0 : pow10(comboVals[k11]);
          pos = true;
          neg = true;
          s = 16;
          break;
        case 16:
          if (improved) {
            s = 41;
            break;
          }
          sign = !pos && neg ? -1.0 : 1.0;
          move();
          fv = obj.f.value(cur);
          if (fv < at.v) {
            rel = (v0 - fv) / v0;
            at.p = cur;
            at.v = fv;
            improved = true;
          } else {
            cur = prev!;
            if (sign === 1.0) pos = false;
            else neg = false;
          }
          if (pos || neg) break;
          if (improved) {
            s = 41;
            break;
          }
          try {
            combo = nextCombination(combo, step.length);
          } catch {
            s = 41;
            break;
          }
          s = 46;
          break;
        case 41:
          void ci;
          return improved;
      }
    }
  }

  /** aj.a(ref): step search around a point that ties the best vertex near the expected value. */
  private searchNear(at: { p: Point; v: number }, vars: NLOVar[], centroid: Point, obj: ObjState): void {
    const dim = at.p.length;
    let bigGain = false;
    let pos = true;
    let neg = true;
    let step: Point = new Array<number>(dim).fill(0);
    for (let i = 0; i < dim; i++) {
      const dist = Math.abs(at.p[i] - centroid[i]);
      step[i] = pow10(dist === 0.0 ? 0 : Math.floor(libm.log10(dist)));
    }
    let cur = at.p;
    let steps = 0;
    let shrinks = 0;
    for (;;) {
      if (shrinks >= 5) return;
      const sign = !pos && neg ? -1.0 : 1.0;
      const prev = cur;
      cur = this.repair(this.clamp(vars, add(cur, mul(step, sign)), false), centroid);
      const fv = obj.f.value(cur);
      if (fv < at.v) {
        const gain = (at.v - fv) / at.v;
        at.p = cur;
        at.v = fv;
        if (gain > 0.5) bigGain = true;
        steps++;
      } else {
        cur = prev;
        if (sign === 1.0) pos = false;
        else neg = false;
      }
      if (bigGain) return;
      if (!pos && !neg) {
        pos = true;
        neg = true;
        step = div(step, 10.0);
        shrinks++;
      }
      if (steps === 10) {
        pos = true;
        neg = true;
        step = mul(step, 10.0);
        steps = 0;
      }
    }
  }
}

export interface NLResult {
  atOptimum: boolean;
  objective: number;
  iterations: number;
}

/**
 * NLOptimizer.runOptimization: minimize `obj` over `vars` (their values are the
 * start, and receive the result), under an optional constraint. Throws
 * NLOException when five runs end without reaching the optimum.
 */
export function nlOptimize(
  vars: NLOVar[],
  obj: NLObjective,
  constraint: ((x: number[]) => boolean) | null = null,
  maxIterations = 2000,
): NLResult {
  const rnd = new NetRandom(22648);
  const seeds = [20001, 24820, 22648, rnd.next(30000), rnd.next(30000)];
  const state: ObjState = { f: obj, precision: 1e-5, current: 0, atOptimum: false };
  for (let k = 1; ; k++) {
    const nm = new NelderMead(vars.length, maxIterations, constraint, seeds[k - 1]);
    while (nm.step(vars, state, 5e-16)) {
      /* iterate */
    }
    if (state.atOptimum) return { atOptimum: true, objective: state.current, iterations: nm.iterations };
    if (k === 5) throw new NLOException('The optimizer did not reach the optimum.');
  }
}
