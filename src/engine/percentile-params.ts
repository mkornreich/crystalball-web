/**
 * Distribution parameters entered as percentiles — Crystal Ball's "10%=80"
 * parameter sets (OCB.Net ah / au and the al, a2, ax, l fits). Any parameter
 * slot may hold a percentile instead of its value; Crystal Ball then solves for
 * the parameters those percentiles stand in for, and the distribution samples
 * with the solved parameters. This follows Crystal Ball's solver step for step:
 *
 *  - Named parameters fill their slots; percentiles fill the remaining slots in
 *    order, and a slot a percentile stands in for starts out holding its value.
 *  - Location/scale/shape families (Normal, Uniform, Logistic, Min/Max
 *    Extreme, Student's t, Gamma, Weibull, Pareto, Exponential, Triangular):
 *    location and scale come from a least-squares fit of the targets on the
 *    standardized quantiles (location 0, scale 1); with only one unknown,
 *    location = mean(target − quantile) and scale = mean((target − location)/
 *    (quantile − location)). An unknown shape is found by a golden-section
 *    search on a normalized shape u ∈ (0, 1), refitting location/scale at every
 *    step, until the targets are met within 1e-6 of their spread (500 tries).
 *  - Triangular falls back to, and BetaPERT, Beta and Lognormal always use,
 *    Crystal Ball's Nelder–Mead fits (cb-nlopt.ts) on the L1 distance between
 *    the quantiles and the targets, with Crystal Ball's bounds and start points;
 *    those stop once the distance is below 1e-5, which is why Crystal Ball's
 *    fitted quantiles miss the targets by ~1e-6.
 */

import { createDistribution, DistributionType, Params } from './distributions';
import { inverseNormal, limitReal, sqrtx } from './cbmath';
import { NLOException, NLOVar, nlOptimize, qsort } from './cb-nlopt';
import * as libm from './libm';

/** One parameter slot in Crystal Ball's order: a value, or a percentile (prob in (0,1)) and its value. */
export interface ParamSlot {
  value: number;
  prob?: number;
}

export class PercentileFitError extends Error {}

const fail = (): never => {
  throw new PercentileFitError('The percentile parameters could not be fitted.');
};

const TAN_SCALE = Math.PI / 2;
/** au.h / au.d: map a normalized shape u ∈ (0,1) to (0,∞) and back. */
const toShape = (u: number) => libm.tan(TAN_SCALE * limitReal(u, 1e-6, 0.999999));
const fromShape = (s: number) => libm.atan(s) / TAN_SCALE;
const pow10 = (k: number) => libm.pow(10.0, k); // Math.Pow(10.0, k)

/** Crystal Ball's hooks for one family (the au virtuals), on the slot values `v`. */
interface Family {
  keys: string[];
  locUnknown(known: boolean[]): boolean;
  shapeUnknown(known: boolean[]): boolean;
  scaleUnknown(known: boolean[]): boolean;
  getLoc(v: number[], known: boolean[]): number;
  setLoc(v: number[], x: number, known: boolean[]): void;
  getScale(v: number[], known: boolean[]): number;
  setScale(v: number[], x: number, known: boolean[]): void;
  getShape?(v: number[], known: boolean[]): number;
  setShape?(v: number[], u: number, known: boolean[]): void;
}

const NO_LOC = () => {
  throw new PercentileFitError('no location parameter');
};

/** Location in slot 0, scale in slot 1 (Normal, Logistic, Extreme Value, …). */
function locScale(keys: string[]): Family {
  return {
    keys,
    locUnknown: (k) => !k[0],
    shapeUnknown: () => false,
    scaleUnknown: (k) => !k[1],
    getLoc: (v) => v[0],
    setLoc: (v, x) => (v[0] = x),
    getScale: (v) => v[1],
    setScale: (v, x) => (v[1] = x),
  };
}

/** Location, scale, shape in slots 0–2 (Gamma, Weibull). */
function locScaleShape(keys: string[], lo: number, hi: number): Family {
  return {
    ...locScale(keys),
    shapeUnknown: (k) => !k[2],
    getShape: (v) => fromShape(v[2]),
    setShape: (v, u) => (v[2] = toShape(limitReal(u, lo, hi))),
  };
}

const is = (k: boolean[], a: boolean, b: boolean, c: boolean) => k[0] === a && k[1] === b && k[2] === c;
const T = true;
const F = false;

/** Triangular (al): scale = max − min, shape = the likeliest's relative position. */
const TRIANGULAR: Family = {
  keys: ['min', 'likely', 'max'],
  // The predicates look at every slot, the cuts' included (unknown once percentiles are given).
  locUnknown: (k) => !k[0] && !k[1] && !k[2],
  shapeUnknown: (k) => !(k[0] && k[1] && k[2]),
  scaleUnknown: (k) => !(k.filter(Boolean).length > 1),
  getLoc: (v, k) => (is(k, T, F, F) ? v[0] : is(k, F, F, T) ? v[2] : v[1]),
  setLoc(v, x, k) {
    const d = x - this.getLoc(v, k);
    v[0] += d;
    v[2] += d;
    v[1] += d;
  },
  getScale: (v) => v[2] - v[0],
  setScale(v, s, k) {
    let [mn, lk, mx] = v;
    const r = (lk - mn) / (mx - mn);
    let done = false;
    if (is(k, T, F, F)) {
      mx = mn + s;
      lk = mn + s * r;
      done = true;
    }
    if (is(k, F, F, F) || is(k, F, T, F)) {
      mn = lk - s * r;
      mx = mn + s;
      done = true;
    }
    if (is(k, F, F, T)) {
      mn = mx - s;
      lk = mn + s * r;
      done = true;
    }
    if (!done) throw new PercentileFitError('invalid scale');
    v[0] = mn;
    v[1] = lk;
    v[2] = mx;
  },
  getShape: (v) => (v[1] - v[0]) / (v[2] - v[0]),
  setShape(v, u, k) {
    let [mn, lk, mx] = v;
    const w = mx - mn;
    if (is(k, T, F, F) || is(k, F, F, T) || is(k, T, F, T)) lk = mn + w * u;
    else if (is(k, F, F, F) || is(k, F, T, F)) {
      mn = lk - w * u;
      mx = mn + w;
    } else if (is(k, T, T, F)) {
      if (u === 0) throw new PercentileFitError('invalid shape');
      mx = mn + (lk - mn) / u;
    } else if (is(k, F, T, T)) {
      if (u === 1) throw new PercentileFitError('invalid shape');
      mn = (lk - mx * u) / (1.0 - u);
    } else throw new PercentileFitError('invalid shape');
    v[0] = mn;
    v[1] = lk;
    v[2] = mx;
  },
};

const FAMILIES: Partial<Record<DistributionType, Family>> = {
  normal: locScale(['mean', 'stdev']),
  logistic: locScale(['mean', 'scale']),
  minextreme: locScale(['likeliest', 'scale']),
  maxextreme: locScale(['likeliest', 'scale']),
  studentt: {
    ...locScale(['midpoint', 'scale', 'dof']),
    shapeUnknown: (k) => !k[2],
    // Crystal Ball maps degrees ↔ u as 1 + 29u and (degrees − 1)·29 (sic).
    getShape: (v) => (v[2] - 1) * 29,
    setShape: (v, u) => (v[2] = 1 + limitReal(u, 0, 1) * 29),
  },
  gamma: locScaleShape(['location', 'scale', 'shape'], 3e-7, 0.9999997),
  weibull: locScaleShape(['location', 'scale', 'shape'], 5e-16, 0.9999999999999994),
  triangular: TRIANGULAR,
  uniform: {
    keys: ['min', 'max'],
    locUnknown: (k) => !k[0] && !k[1],
    shapeUnknown: () => false,
    scaleUnknown: (k) => !(k[0] && k[1]),
    getLoc: (v, k) => (k[1] ? v[1] : v[0]),
    setLoc: (v, x, k) => {
      if (k[1]) {
        v[0] += x - v[1];
        v[1] = x;
      } else {
        v[1] += x - v[0];
        v[0] = x;
      }
    },
    getScale: (v) => v[1] - v[0],
    setScale: (v, x, k) => {
      if (k[1]) v[0] = v[1] - x;
      else v[1] = v[0] + x;
    },
  },
  pareto: {
    keys: ['location', 'shape'],
    locUnknown: () => false,
    shapeUnknown: (k) => !k[1],
    scaleUnknown: (k) => !k[0],
    getLoc: () => 0,
    setLoc: NO_LOC,
    getScale: (v) => v[0],
    setScale: (v, x) => (v[0] = x),
    getShape: (v) => fromShape(v[1]),
    setShape: (v, u) => (v[1] = toShape(limitReal(u, 3e-7, 0.9999997))),
  },
  exponential: {
    keys: ['rate'],
    locUnknown: () => false,
    shapeUnknown: () => false,
    scaleUnknown: (k) => !k[0],
    getLoc: () => 0,
    setLoc: NO_LOC,
    getScale: (v) => 1 / v[0],
    setScale: (v, x) => (v[0] = 1 / x),
  },
};

/** Crystal Ball's slot names (lower case) per type, and its default values for slots left out. */
const SLOTS: Partial<Record<DistributionType, { names: string[][]; defaults: number[] }>> = {
  normal: { names: [['mean'], ['stddev']], defaults: [5, 2] },
  triangular: { names: [['min'], ['likeliest'], ['max']], defaults: [0, 5, 10] },
  betapert: { names: [['min'], ['likeliest'], ['max']], defaults: [0, 5, 10] },
  uniform: { names: [['min'], ['max']], defaults: [0, 5] },
  lognormal: {
    names: [['mean', 'logmean', 'geomean'], ['stddev', 'logstddev', 'geostddev'], ['location']],
    defaults: [10, 2, 0],
  },
  exponential: { names: [['rate']], defaults: [5] },
  gamma: { names: [['location'], ['scale'], ['shape']], defaults: [1, 1, 2] },
  weibull: { names: [['location'], ['scale'], ['shape']], defaults: [1, 1, 2] },
  beta: { names: [['min'], ['max'], ['alpha'], ['beta']], defaults: [0, 1, 2, 3] },
  logistic: { names: [['mean'], ['scale']], defaults: [5, 3] },
  pareto: { names: [['location'], ['shape']], defaults: [1, 2] },
  studentt: { names: [['midpoint'], ['scale'], ['degrees']], defaults: [0, 1, 5] },
  minextreme: { names: [['likeliest'], ['scale']], defaults: [5, 3] },
  maxextreme: { names: [['likeliest'], ['scale']], defaults: [5, 3] },
};

/** Whether Crystal Ball accepts percentile parameters for this distribution type. */
export function supportsPercentiles(type: DistributionType): boolean {
  return type in SLOTS;
}

/**
 * Crystal Ball's text entries ("Likeliest=5", "10%=2", …) → slots: named
 * parameters go to their slot, percentiles fill the other slots in order, and
 * a slot that gets neither keeps Crystal Ball's default.
 */
export function assignPercentileSlots(
  type: DistributionType,
  entries: { key: string; value: number; prob?: number }[],
): { slots: ParamSlot[]; keys: string[] } {
  const spec = SLOTS[type];
  if (!spec) throw new PercentileFitError(`Percentile parameters are not supported for this distribution type (${type}).`);
  const slots: (ParamSlot | undefined)[] = spec.names.map(() => undefined);
  const keys = spec.names.map((n) => n[0]);
  for (const e of entries) {
    if (e.prob !== undefined) continue;
    const i = spec.names.findIndex((n) => n.includes(e.key));
    if (i >= 0) {
      slots[i] = { value: e.value };
      keys[i] = e.key;
    }
  }
  let next = 0;
  for (const e of entries) {
    if (e.prob === undefined) continue;
    while (next < slots.length && slots[next]) next++;
    if (next >= slots.length) throw new PercentileFitError('Too many percentile parameters.');
    slots[next] = { value: e.value, prob: e.prob };
    keys[next] = `${e.key}`;
  }
  return { slots: slots.map((s, i) => s ?? { value: spec.defaults[i] }), keys };
}

/**
 * Solve a distribution's parameters from slots that may hold percentiles.
 * `slots` follow Crystal Ball's parameter order for the type (e.g. Triangular
 * min, likeliest, max); for Lognormal, `keys` name the parameter set
 * (mean/stddev, logmean/logstddev or geomean/geostddev). Throws
 * PercentileFitError when Crystal Ball would.
 */
export function solvePercentileParams(type: DistributionType, slots: ParamSlot[], keys: string[] = []): Params {
  const spec = SLOTS[type];
  if (!spec) throw new PercentileFitError(`Percentile parameters are not supported for this distribution type (${type}).`);
  if (slots.length !== spec.names.length) throw new PercentileFitError(`${type} takes ${spec.names.length} parameters.`);
  const known = slots.map((s) => s.prob === undefined);
  const probs = slots.filter((s) => s.prob !== undefined).map((s) => s.prob!);
  const targets = slots.filter((s) => s.prob !== undefined).map((s) => s.value);
  const v = slots.map((s) => s.value);
  checkOrder(probs, targets);
  if (type === 'lognormal') {
    const set = lognormalSet(keys, known);
    if (!probs.length) return lognormalIn(set, v[0], v[1], v[2]) ?? fail();
    return fitLognormal(set, probs, targets, known, v);
  }
  if (type === 'beta') {
    if (probs.length) fitBeta(probs, targets, known, v);
    return { min: v[0], max: v[1], alpha: v[2], beta: v[3] };
  }
  if (type === 'betapert') {
    if (probs.length && !fitPertLike('betapert', probs, targets, known, v)) fail();
    return { min: v[0], likely: v[1], max: v[2] };
  }
  const fam = FAMILIES[type]!;
  if (probs.length) solveFamily(type, fam, v, known, probs, targets);
  return Object.fromEntries(fam.keys.map((k, i) => [k, v[i]]));
}

/** ah.g: walking the percentiles upward, each value must exceed the one before. */
function checkOrder(probs: number[], targets: number[]) {
  let last = 0.0;
  let lastX = 0.0;
  for (;;) {
    let next = 0.0;
    let at = -1;
    for (let i = 0; i < probs.length; i++)
      if (probs[i] > last && (next === 0.0 || probs[i] <= next)) {
        next = probs[i];
        at = i;
      }
    if (at < 0) return;
    if (last > 0.0 && lastX >= targets[at]) throw new PercentileFitError('Percentile values must increase with the percentiles.');
    last = probs[at];
    lastX = targets[at];
  }
}

/** au.a(types, values, known, count): Crystal Ball's solver for the location/scale/shape families. */
function solveFamily(type: DistributionType, fam: Family, v: number[], known: boolean[], probs: number[], targets: number[]) {
  const toParams = () => Object.fromEntries(fam.keys.map((k, i) => [k, v[i]]));
  const quantile = (p: number) => createDistribution(type, toParams()).quantile(p);

  if (type === 'triangular' && known[1] && nearLikeliest(v[1], targets)) {
    // A percentile at (or next to) the likeliest value: straight to the Nelder–Mead fit.
    if (!fitPertLike('triangular', probs, targets, known, v)) fail();
    return;
  }

  const locU = fam.locUnknown(known);
  const shapeU = fam.shapeUnknown(known);
  const scaleU = fam.scaleUnknown(known);
  if ((locU ? 1 : 0) + (shapeU ? 1 : 0) + (scaleU ? 1 : 0) !== probs.length)
    throw new PercentileFitError('The percentiles given do not match the parameters they replace.');

  /** au.a(bool, bool, …): fit location/scale at the current shape; the relative residual. */
  const fitLocScale = (): number => {
    const n = probs.length;
    const q = new Array<number>(n).fill(0);
    let lo = targets[0];
    let hi = targets[0];
    try {
      if (locU) fam.setLoc(v, 0, known);
      if (scaleU) fam.setScale(v, 1, known);
      for (let i = 0; i < n; i++) {
        q[i] = quantile(probs[i]);
        if (lo > targets[i]) lo = targets[i];
        if (hi < targets[i]) hi = targets[i];
      }
    } catch {
      /* Crystal Ball carries on with what it has */
    }
    let norm: number;
    if (n === 0) norm = 1;
    else if (n === 1) norm = lo === 0 ? 1 : Math.abs(lo);
    else {
      if (hi === lo) return 1e20;
      norm = hi - lo;
    }
    norm = 1 / norm;
    if (locU && scaleU) {
      let sq = 0;
      let sxy = 0;
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < n; i++) {
        sx += q[i];
        sq += q[i] * q[i];
        sy += targets[i];
        sxy += q[i] * targets[i];
      }
      sx /= n;
      sy /= n;
      sq -= sx * sx * n;
      sxy -= sx * sy * n;
      if (Math.abs(sq) < libm.pow(10, -14)) return 1e20; // OcbMath.AreEqual(sq, 0, 14)
      const scale = sxy / sq;
      const loc = sy - scale * sx;
      if (scale <= 0) return 1e20;
      fam.setScale(v, scale, known);
      fam.setLoc(v, loc, known);
      for (let i = 0; i < n; i++) q[i] = loc + scale * q[i];
    } else if (locU) {
      let mq = 0;
      let mt = 0;
      for (let i = 0; i < n; i++) {
        mt += targets[i];
        mq += q[i];
      }
      mq /= n;
      mt /= n;
      mt -= mq;
      fam.setLoc(v, mt, known);
      for (let i = 0; i < n; i++) q[i] += mt;
    } else if (scaleU) {
      const loc = fam.getLoc(v, known);
      let s = 0;
      for (let i = 0; i < n; i++) {
        if (targets[i] === loc || q[i] === loc) return 1e20;
        const r = (targets[i] - loc) / (q[i] - loc);
        if (r < 0) return 1e20;
        s += r;
      }
      s /= n;
      fam.setScale(v, s, known);
      for (let i = 0; i < n; i++) q[i] = (q[i] - loc) * s + loc;
    }
    let ss = 0;
    for (let i = 0; i < n; i++) {
      const d = targets[i] - q[i];
      ss += d * d;
    }
    return Math.sqrt(ss) * norm;
  };

  /** au.a(int, …): golden-section search on the normalized shape. */
  const searchShape = (tol: number, width: number): number => {
    const f = (u: number) => {
      fam.setShape!(v, u, known);
      return fitLocScale();
    };
    let dir = 1;
    let mid = fam.getShape!(v, known);
    width = limitReal(width, 0.001, 1);
    let a = limitReal(mid - width, 1e-6, 0.999999);
    let b = limitReal(mid + width, 1e-6, 0.999999);
    tol = limitReal(tol, 1e-9, 0.1);
    f(a);
    f(b);
    let best = f(mid);
    let steps = 0;
    while (b - a > tol && best > 1e-6) {
      if (++steps > 10000) throw new PercentileFitError('The percentile fit did not converge.');
      if (dir !== 0) {
        const x = mid * 0.6180339887498949 + b * 0.38196601125010515;
        const fx = f(x);
        if (fx < best) {
          a = mid;
          mid = x;
          best = fx;
        } else b = x;
      } else {
        const x = mid * 0.6180339887498949 + a * 0.38196601125010515;
        const fx = f(x);
        if (fx < best) {
          b = mid;
          mid = x;
          best = fx;
        } else a = x;
      }
      dir = 1 - dir;
    }
    return best;
  };

  const residual = fitLocScale();
  let ok = false;
  if (!shapeU) {
    if (residual > 1e-6) fail();
    ok = true;
  }
  const before = [...v];
  for (let k = 0; k < 500 && !ok; k++) {
    try {
      if (searchShape(1e-9, 1) <= 1e-6) ok = true;
    } catch {
      break;
    }
  }
  if (!ok && type === 'triangular') {
    v.splice(0, v.length, ...before);
    ok = fitPertLike('triangular', probs, targets, known, v);
  }
  if (!ok) fail();
}

/** au.a's check for a percentile value at the likeliest one (to ~1e-4). */
function nearLikeliest(likely: number, targets: number[]): boolean {
  const eL = Math.floor(libm.log10(Math.abs(likely)));
  for (const x of targets) {
    const e = Math.floor(libm.log10(Math.abs(x)));
    const d = Math.abs(x - likely);
    if (e === eL && e !== -Infinity) {
      if (e >= 0 && d < 0.0001) return true;
      if (e < 0 && d / pow10(e) < 0.0001) return true;
    } else if (eL === -Infinity || e === -Infinity) {
      if (d < 0.001) return true;
    }
  }
  return false;
}

/**
 * al.b / a2.b: Triangular or BetaPERT by Nelder–Mead over the unknown min, max
 * and likeliest (in that order), bounded by the spread of the given values and
 * percentiles, under min < likeliest < max.
 */
function fitPertLike(type: 'triangular' | 'betapert', probs: number[], targets: number[], known: boolean[], v: number[]): boolean {
  const pr = pertLikeProblem(type, probs, targets, known, v);
  if (!pr) return false;
  try {
    nlOptimize(pr.vars, pr.objective, pr.constraint);
  } catch (e) {
    if (e instanceof NLOException) return false;
    throw e;
  }
  const [mn, lk, mx] = pr.unpack(pr.vars.map((x) => x.value));
  v[0] = mn;
  v[1] = lk;
  v[2] = mx;
  return true;
}

/** The Triangular/BetaPERT fit's variables, objective and constraint (exported for tools/cb-pct-trace.ts). */
export function pertLikeProblem(type: 'triangular' | 'betapert', probs: number[], targets: number[], known: boolean[], v: number[]) {
  const sortedV = [...v];
  qsort(sortedV);
  const p = [...probs];
  qsort(p);
  let spreadP = 0;
  if (probs.length <= 1) {
    if (!known[0]) {
      if (known[2]) spreadP = 1.0 - probs[0];
    } else spreadP = probs[0];
  } else spreadP = p[p.length - 1] - p[0];
  const cap = spreadP < 0.5 ? 100.0 : 2.0 - (spreadP * 100.0 - 50.0) / 25.0;
  const top = known[2] ? 1.0 : p[p.length - 1];
  const hiExp = Math.min(cap, top < 0.05 ? 8.0 - top * 100.0 : 5.0 - (3.0 * (top * 100.0 - 5.0)) / 95.0);
  const bottom = known[0] ? 0.0 : p[0];
  const loExp = Math.min(cap, bottom > 0.95 ? 5.0 + (3.0 * (bottom * 100.0 - 95.0)) / 5.0 : 2.0 + (3.0 * bottom * 100.0) / 95.0);
  const width = Math.abs(sortedV[0] - sortedV[sortedV.length - 1]);
  if (width === 0.0) return null;
  const vars: NLOVar[] = [];
  let min = 0.0;
  let max = 0.0;
  if (!known[0]) {
    min = sortedV[0] - width * libm.exp(loExp);
    vars.push(new NLOVar(min, sortedV[0], sortedV[0]));
  } else min = v[0];
  if (!known[2]) {
    max = sortedV[sortedV.length - 1] + width * libm.exp(hiExp);
    vars.push(new NLOVar(sortedV[sortedV.length - 1], max, sortedV[sortedV.length - 1]));
  } else max = v[2];
  if (!known[1]) vars.push(new NLOVar(min, max, sortedV[0]));
  // Point coordinates: min, max, likeliest — whichever are unknown.
  const unpack = (x: number[]) => {
    let i = 0;
    const mn = known[0] ? v[0] : x[i++];
    const mx = known[2] ? v[2] : x[i++];
    const lk = known[1] ? v[1] : x[i++];
    return [mn, lk, mx];
  };
  const objective = {
    expected: 0.0,
    value(x: number[]) {
      const [mn, lk, mx] = unpack(x);
      const d = createDistribution(type, { min: mn, likely: lk, max: mx });
      let s = 0.0;
      for (let i = 0; i < targets.length; i++) s += Math.abs(d.quantile(probs[i]) - targets[i]);
      return s;
    },
  };
  const constraint = (x: number[]) => {
    const [mn, lk, mx] = unpack(x);
    if (mn >= mx || mn > lk || lk > mx) return false;
    return !(mx !== 0.0 && Math.abs(mx - mn) / Math.abs(mx) < 1e-10);
  };
  return { vars, objective, constraint, unpack };
}

/** The standard Beta's quantile (Crystal Ball's ax.a(α, β, p)). */
const betaQ = (alpha: number, beta: number, p: number) =>
  createDistribution('beta', { min: 0, max: 1, alpha, beta }).quantile(p);

/**
 * ax.b: Beta. Known shapes: min and/or max in closed form. Otherwise Nelder–
 * Mead over the unknown α and β (0.3–1000, start 100, α + β < 1000); at each
 * point min/max follow in closed form from the first percentile(s), and the
 * rest are scored.
 */
function fitBeta(probs: number[], x: number[], known: boolean[], v: number[]) {
  if (known[2] && known[3]) {
    if (!known[1] && !known[0]) {
      const q5 = betaQ(v[2], v[3], probs[0]);
      const q6 = betaQ(v[2], v[3], probs[1]);
      const d = q5 * (1.0 - q6) - q6 * (1.0 - q5);
      v[1] = (x[0] * (1.0 - q6) - x[1] * (1.0 - q5)) / d;
      v[0] = (x[1] * q5 - x[0] * q6) / d;
    } else {
      const q = betaQ(v[2], v[3], probs[0]);
      if (known[1]) v[0] = (x[0] - v[1] * q) / (1.0 - q);
      else v[1] = (x[0] - v[0] * (1.0 - q)) / q;
    }
    return;
  }
  const vars: NLOVar[] = [];
  if (!known[2]) vars.push(new NLOVar(0.3, 1000.0, 100.0));
  if (!known[3]) vars.push(new NLOVar(0.3, 1000.0, 100.0));
  let lo = known[0] ? v[0] : 0.0; // the objective's min/max fields
  let hi = known[1] ? v[1] : 0.0;
  let alpha = known[2] ? v[2] : 2;
  let beta = known[3] ? v[3] : 3;
  const shapes = (pt: number[]) => {
    let i = 0;
    if (!known[2]) alpha = pt[i++];
    if (!known[3]) beta = pt[i];
  };
  /** min/max from the first percentile(s); returns how many were used. */
  const ends = (): number => {
    if (!known[1] && !known[0]) {
      const q0 = betaQ(alpha, beta, probs[0]);
      const q1 = betaQ(alpha, beta, probs[1]);
      const d = q0 * (1.0 - q1) - q1 * (1.0 - q0);
      lo = (x[1] * q0 - x[0] * q1) / d;
      hi = (x[0] * (1.0 - q1) - x[1] * (1.0 - q0)) / d;
      return 2;
    }
    if (known[1] && known[0]) return 0;
    const q = betaQ(alpha, beta, probs[0]);
    if (!known[0]) lo = (x[0] - hi * q) / (1.0 - q);
    else hi = (x[0] - lo * (1.0 - q)) / q;
    return 1;
  };
  const objective = {
    expected: 0.0,
    value(pt: number[]) {
      shapes(pt);
      const used = ends();
      let s = 0.0;
      if (!known[2] && !known[3]) {
        const q0 = betaQ(alpha, beta, probs[used]);
        const q1 = betaQ(alpha, beta, probs[used + 1]);
        s += Math.abs(q0 * hi + (1.0 - q0) * lo - x[used]);
        s += Math.abs(q1 * hi + (1.0 - q1) * lo - x[used + 1]);
      } else {
        const q = betaQ(alpha, beta, probs[used]);
        s += Math.abs(q * hi + (1.0 - q) * lo - x[used]);
      }
      return s;
    },
  };
  const fixed = (known[2] ? v[2] : 0.0) + (known[3] ? v[3] : 0.0);
  const constraint = (pt: number[]) => (fixed !== 0.0 ? fixed + pt[0] < 1000.0 : pt[0] + pt[1] < 1000.0);
  try {
    nlOptimize(vars, objective, constraint);
  } catch (e) {
    if (e instanceof NLOException) fail();
    throw e;
  }
  shapes(vars.map((x) => x.value));
  if (!known[2]) v[2] = alpha;
  if (!known[3]) v[3] = beta;
  if (!known[1] && !known[0]) {
    const q0 = betaQ(alpha, beta, probs[0]);
    const q1 = betaQ(alpha, beta, probs[1]);
    const d = q0 * (1.0 - q1) - q1 * (1.0 - q0);
    v[0] = (x[1] * q0 - x[0] * q1) / d;
    v[1] = (x[0] * (1.0 - q1) - x[1] * (1.0 - q0)) / d;
  } else if (!(known[1] && known[0])) {
    const q = betaQ(alpha, beta, probs[0]);
    if (!known[0]) v[0] = (x[0] - hi * q) / (1.0 - q);
    else v[1] = (x[0] - lo * (1.0 - q)) / q;
  }
}

type LogSet = 3 | 5 | 7; // log, arithmetic, geometric (Crystal Ball's parameter-set codes)

/** l.a(types, known): the parameter set named by the known first two slots (log when neither is). */
function lognormalSet(keys: string[], known: boolean[]): LogSet {
  let set = 0;
  for (let i = 0; i < 2; i++) {
    if (!known[i]) continue;
    const k = keys[i] ?? '';
    const s: LogSet = k.startsWith('log') ? 3 : k.startsWith('geo') ? 7 : 5;
    if (set !== 0 && set !== s) throw new PercentileFitError('Lognormal parameters mix parameter sets.');
    set = s;
  }
  return set === 0 ? 3 : (set as LogSet);
}

const LOG_RATIO_MAX = 65659969.0;

/** A Lognormal in set terms → our parameters, or null where Crystal Ball's validation rejects it. */
function lognormalIn(set: LogSet, a: number, b: number, loc: number): Params | null {
  if (loc < -2e15 || loc > 2e15) return null;
  let mean: number;
  let sd: number;
  if (set === 3) {
    if (a < -700 || a > 700 || b < 5e-6 || b > 10) return null;
    mean = loc + libm.exp(a + 0.5 * b * b);
    sd = libm.exp(a) * sqrtx(libm.exp(b * b) * (libm.exp(b * b) - 1.0));
  } else if (set === 7) {
    if (a < 1e-304 || a > 1e304 || b < 1.000005 || b > 22000) return null;
    const mu = libm.log(a);
    const sg = libm.log(b);
    mean = loc + libm.exp(mu + 0.5 * sg * sg);
    sd = libm.exp(mu) * sqrtx(libm.exp(sg * sg) * (libm.exp(sg * sg) - 1.0));
  } else {
    if (a > 3e304 || b < 5e-16 || b > 1e304 || !(b > 0) || !(a > loc)) return null;
    mean = a;
    sd = b;
  }
  if ((mean - loc) / sd > LOG_RATIO_MAX) return null;
  if (set === 3) return { logMean: a, logStdev: b, location: loc };
  if (set === 7) return { geoMean: a, geoStdev: b, location: loc };
  return { mean: a, stdev: b, location: loc };
}

/**
 * l.b: Lognormal. Probabilities and values are sorted; each unknown slot gets
 * Crystal Ball's bounds and closed-form start, then Nelder–Mead on the L1
 * distance (three percentiles first fit σ on location-free ratios). The
 * result is converted to log-space parameters.
 */
function fitLognormal(set: LogSet, probsIn: number[], valsIn: number[], known: boolean[], o: number[]): Params {
  const p = [...probsIn];
  const x = [...valsIn];
  qsort(p);
  qsort(x);
  const z = p.map((q) => inverseNormal(q));
  const [kM, kS, kL] = known;
  const M = o[0];
  const S = o[1];
  const L = o[2];
  const n = p.length;
  const types = set === 3 ? [3, 4, 9] : set === 5 ? [5, 6, 9] : [7, 8, 9];
  let locLo = NaN;
  let locHi = NaN;
  let s33 = NaN; // σ bounds from the three-percentile ratio fit
  let s21 = NaN;
  const maxX = Math.max(...x);
  const minX = Math.min(...x);
  const maxP = Math.max(...p);
  if (!kL) {
    if (n >= 2) {
      const slope = (x[1] - x[0]) / (p[1] - p[0]);
      const icpt = x[0] - slope * p[0];
      locLo = icpt - slope * 100.0 * (1.0 - p[0]);
    } else locLo = -2e15;
    locHi = minX;
    if (kM && set === 5) locHi = Math.min(locHi, M);
    locHi -= 5e-16;
  }
  const quantileL1 = (pt: number[]) => {
    let i = 0;
    const a = kM ? o[0] : pt[i++];
    const b = kS ? o[1] : pt[i++];
    const c = kL ? o[2] : pt[i++];
    const prm = lognormalIn(set, a, b, c);
    if (!prm) return NaN;
    const d = createDistribution('lognormal', prm);
    let s = 0.0;
    for (let j = 0; j < n; j++) s += Math.abs(d.quantile(p[j]) - x[j]);
    return s;
  };
  let done = false;
  if (n === 3) {
    s33 = libm.log((x[2] - locLo) / (x[1] - locLo)) / (z[2] - z[1]);
    s21 = libm.log((x[2] - x[0]) / (x[1] - x[0])) / (z[2] - z[1]);
    const vars = [new NLOVar(s33, s21, 0.5 * (s33 + s21))];
    const e = (c: number, i: number) => libm.exp(c * inverseNormal(p[i]));
    const ratio = {
      expected: 0.0,
      value(pt: number[]) {
        const c = pt[0];
        let n6 = (x[0] - x[1]) / (x[0] - x[2]);
        let n7 = (e(c, 0) - e(c, 1)) / (e(c, 0) - e(c, 2));
        const v1 = n6 - n7;
        n6 = (x[1] - x[2]) / (x[1] - x[0]);
        n7 = (e(c, 1) - e(c, 2)) / (e(c, 1) - e(c, 0));
        const v2 = n6 - n7;
        n6 = (x[2] - x[0]) / (x[2] - x[1]);
        n7 = (e(c, 2) - e(c, 0)) / (e(c, 2) - e(c, 1));
        const v3 = n6 - n7;
        return Math.abs(v1) + Math.abs(v2) + Math.abs(v3);
      },
    };
    let at = false;
    try {
      at = nlOptimize(vars, ratio).atOptimum;
    } catch (err) {
      if (!(err instanceof NLOException)) throw err;
    }
    if (at) {
      const sg = vars[0].value;
      const mu = libm.log((x[0] - x[1]) / (libm.exp(sg * inverseNormal(p[0])) - libm.exp(sg * inverseNormal(p[1]))));
      const loc = x[0] - libm.exp(mu + sg * inverseNormal(p[0]));
      if (mu < -700 || mu > 700 || sg < 5e-6 || sg > 10 || loc < -2e15 || loc > 2e15) fail();
      o[0] = mu;
      o[1] = sg;
      o[2] = loc;
      done = true;
    }
  }
  if (!done) {
    const vars: NLOVar[] = [];
    for (let slot = 0; slot < 3; slot++) {
      if (known[slot]) continue;
      let start = NaN;
      let lo = NaN;
      let hi = NaN;
      switch (types[slot]) {
        case 3: {
          lo = -700.0;
          hi = 700.0;
          if (kL && kS) start = libm.log(x[0] - L) - S * inverseNormal(p[0]);
          else if (!kL && kS) start = libm.log((x[0] - x[1]) / (libm.exp(S * z[0]) - libm.exp(S * z[1])));
          else if (!kL) {
            const n19 = libm.log((x[2] - x[1]) / (libm.exp(s21 * z[2]) - libm.exp(s21 * z[1])));
            const n17 = libm.log((x[2] - x[0]) / (libm.exp(s33 * z[2]) - libm.exp(s33 * z[0])));
            if (n19 < -700.0 || n17 > 700.0) fail();
            lo = n19;
            hi = s21;
            start = 0.5 * (n19 + n17);
          }
          if (!Number.isNaN(start) && (start < -700.0 || start > 700.0)) fail();
          vars.push(new NLOVar(lo, hi, start));
          break;
        }
        case 4: {
          lo = 5e-6;
          hi = 10.0;
          if (kL && kM) start = (libm.log(x[0] - L) - M) / z[0];
          else if (kL) {
            start = libm.log((x[0] - L) / (x[1] - L)) / (z[0] - z[1]);
            const mu = libm.log(x[0] - L) - start * z[0];
            const mlo = mu - 1.0 > -700.0 ? mu - 1.0 : -700.0;
            const mhi = mu + 1.0 < 700.0 ? mu + 1.0 : 700.0;
            if (mu < -700.0 || mu > 700.0) fail();
            vars[vars.length - 1] = new NLOVar(mlo, mhi, mu);
          } else if (!kM) {
            lo = s33;
            hi = s21;
            start = 0.5 * (s33 + s21);
          }
          if (!Number.isNaN(start) && (start < 5e-6 || start > 10.0)) fail();
          vars.push(new NLOVar(lo, hi, start));
          break;
        }
        case 5: {
          lo = kL ? L : -2e15;
          hi = 3e304;
          start = maxX;
          if (start < -2e15) start = -2e15;
          else if (start > 3e304) start = 3e304;
          vars.push(new NLOVar(lo, hi, start));
          break;
        }
        case 6: {
          lo = 1e-7;
          hi = 1e304;
          let off = 0.0;
          if (kL) off = L;
          else if (n === 2) off = (Math.abs(maxX) - Math.abs(minX)) / (10.0 * (maxP - maxP));
          start = (Math.abs(maxX) - off) / (10.0 * maxP);
          if (!(start < 1e-7)) {
            if (start > 1e304) start = 1e304;
          } else start = 1e-7;
          vars.push(new NLOVar(lo, hi, start));
          break;
        }
        case 7: {
          lo = 1e-304;
          hi = 1e304;
          if (kL && kS) start = (x[0] - L) / libm.pow(S, z[0]);
          else if (!kL && kS) start = (x[0] - x[1]) / (libm.pow(S, z[0]) - libm.pow(S, z[1]));
          if (!Number.isNaN(start)) {
            if (start < 1e-304 || start > 1e304) fail();
            lo = start - 1.0 > lo ? start - 1.0 : lo;
            hi = start + 1.0 < hi ? start + 1.0 : hi;
          }
          vars.push(new NLOVar(lo, hi, start));
          break;
        }
        case 8: {
          lo = 1.000005;
          hi = 22000.0;
          if (kL && kM) start = libm.exp(libm.log((x[0] - L) / M) / z[0]);
          if (!Number.isNaN(start)) {
            if (start < 1.000005 || start > 22000.0) fail();
            lo = start - 1.0 > lo ? start - 1.0 : lo;
            hi = start + 1.0 < hi ? start + 1.0 : hi;
          }
          vars.push(new NLOVar(lo, hi, start));
          break;
        }
        default: {
          lo = locLo;
          hi = locHi;
          if (set === 3) {
            const mu = kM ? M : vars[0].value;
            if (kS) start = x[0] - libm.exp(mu + S * inverseNormal(p[0]));
          } else if (set === 7) {
            const gm = kM ? M : vars[0].value;
            if (kS) start = x[0] - libm.pow(S, inverseNormal(p[0])) * gm;
          } else start = 1.0;
          if (Number.isNaN(start)) start = 0.5 * (lo + hi);
          else if (start < -2e15 || start > 2e15) fail();
          vars.push(new NLOVar(lo, hi, start));
        }
      }
    }
    try {
      nlOptimize(vars, { expected: 0.0, value: quantileL1 });
    } catch (err) {
      if (err instanceof NLOException) fail();
      throw err;
    }
    let i = 0;
    for (let slot = 0; slot < 3; slot++) if (!known[slot]) o[slot] = vars[i++].value;
    if (set === 5) {
      // l.i: arithmetic → log space.
      const sg = sqrtx(libm.log(libm.exp(2.0 * libm.log(o[1] / (o[0] - o[2]))) + 1.0));
      const mu = libm.log((o[0] - o[2]) / libm.exp(0.5 * (sg * sg)));
      o[0] = mu;
      o[1] = sg;
    } else if (set === 7) {
      o[0] = libm.log(o[0]);
      o[1] = libm.log(o[1]);
    }
  }
  return { logMean: o[0], logStdev: o[1], location: o[2] };
}
