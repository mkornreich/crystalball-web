/**
 * Probability-distribution library for assumptions.
 *
 * Every distribution exposes an inverse CDF `quantile(p)` so the engine can
 * sample by inverse transform — the same mechanism serves ordinary Monte
 * Carlo (p ~ Uniform(0,1)) and Latin Hypercube (p stratified), and lets the
 * correlation routine reorder samples without re-sampling. Distributions
 * also report their theoretical `mean`/`variance`, a `pdf`/`pmf`, and a `cdf`
 * for the live preview chart and for the unit tests.
 *
 * `quantile` and `cdf` reproduce Crystal Ball 11.1.3's own algorithms — its
 * inverse-normal, its Newton/bisection inverses, its mode-centred discrete
 * recurrences, its truncation ("cut") handling and its edge-case clamps — so a
 * given probability maps to the same value Crystal Ball would draw. The
 * kernels are in cbmath.ts; tests/fixtures compare against the real engine.
 */

import {
  ALMOST_0,
  ALMOST_1,
  D_CUT,
  NORMAL_P_MIN,
  VAL_ERR,
  VAL_MAX,
  betaCf,
  betaInc,
  gammln,
  gammp,
  inverseNormal,
  limitReal,
  nCombR,
  normalCdf,
  roundDotNet,
  sqrtx,
  toInt,
} from './cbmath';
import { gamma as gammaFn, logBinom, logGamma, normPdf } from './special';
import * as libm from './libm';

const EULER = 0.5772156649015329;

export type DistributionType =
  | 'normal'
  | 'triangular'
  | 'betapert'
  | 'uniform'
  | 'lognormal'
  | 'exponential'
  | 'gamma'
  | 'weibull'
  | 'beta'
  | 'logistic'
  | 'pareto'
  | 'studentt'
  | 'maxextreme'
  | 'minextreme'
  | 'yesno'
  | 'discreteuniform'
  | 'binomial'
  | 'poisson'
  | 'geometric'
  | 'hypergeometric'
  | 'negbinomial'
  | 'custom';

export type Params = Record<string, number>;

/**
 * One Custom-distribution outcome, carrying a relative `weight`. Either a
 * discrete point (`value`) or a range (`min`/`max`). A range is continuous
 * unless it has a `step` (Crystal Ball's discrete ranges); giving `endWeight`
 * makes it a sloping range whose density runs linearly from `weight` at `min`
 * to `endWeight` at `max`. Points and ranges can be mixed, as in Crystal Ball.
 */
export interface CustomPoint {
  weight: number;
  value?: number;
  min?: number;
  max?: number;
  step?: number;
  endWeight?: number;
}

export interface Distribution {
  readonly type: DistributionType;
  readonly discrete: boolean;
  /** Inverse CDF. p in (0,1) -> value. */
  quantile(p: number): number;
  /** Probability density (continuous) or mass (discrete) at x. */
  density(x: number): number;
  /** Cumulative distribution P(X <= x). */
  cdf(x: number): number;
  /** Theoretical mean, or NaN if undefined for the parameters. */
  mean(): number;
  /** Theoretical variance, or NaN if undefined. */
  variance(): number;
  /** A sensible [low, high] window for plotting the pdf. */
  plotRange(): [number, number];
  /** Returns an error message if the parameters are invalid, else null. */
  validate(): string | null;
}

/** Metadata describing a single parameter of a distribution (drives the UI). */
export interface ParamSpec {
  key: string;
  label: string;
  default: number;
  integer?: boolean;
}

export interface DistributionDef {
  type: DistributionType;
  label: string;
  discrete: boolean;
  /** Short human description shown in the picker. */
  blurb: string;
  params: ParamSpec[];
  create(params: Params, custom?: CustomPoint[]): Distribution;
}

/* ===================== Crystal Ball cut handling ===================== */

/**
 * Crystal Ball's truncation window. Without user cuts it is the full range
 * (±1.11e307, or ±2e9 for discrete distributions) with q = 0, r = 1; with
 * cuts, q and r are the CDF just below the lower and at the upper cut, and a
 * lower cut above the upper one ("split") excludes the middle instead.
 */
interface CutWindow {
  lo: number;
  hi: number;
  q: number;
  r: number;
  split: boolean;
}

abstract class CbDistribution implements Distribution {
  abstract readonly type: DistributionType;
  abstract readonly discrete: boolean;
  /** Crystal Ball's Geometric widens its upper cut by one (see cutWindow). */
  readonly geometric: boolean = false;
  /** Whether Crystal Ball applies its integer cut rules (Custom never does). */
  get integerCuts(): boolean {
    return this.discrete;
  }
  /** Crystal Ball's uncut CDF. */
  abstract rawCdf(x: number): number;
  /** Crystal Ball's uncut inverse CDF. */
  abstract rawQuantile(p: number): number;
  abstract density(x: number): number;
  abstract mean(): number;
  abstract variance(): number;
  abstract plotRange(): [number, number];
  abstract validate(): string | null;

  private window?: CutWindow;

  quantile(p: number): number {
    this.window ??= cutWindow(this);
    return cutQuantile(this, this.window, p);
  }
  cdf(x: number): number {
    this.window ??= cutWindow(this);
    return cutCdf(this, this.window, x);
  }
}

function cutWindow(d: CbDistribution, lo?: number, hi?: number): CutWindow {
  if (lo === undefined && hi === undefined) {
    const lim = d.integerCuts ? D_CUT : VAL_MAX;
    return { lo: -lim, hi: lim, q: 0, r: 1, split: false };
  }
  const a = lo ?? -VAL_MAX;
  const b = hi ?? VAL_MAX;
  let q = a > -VAL_MAX ? d.rawCdf(a) : 0;
  if (Number.isNaN(q)) q = 0;
  let r = b < VAL_MAX ? d.rawCdf(b) : 1;
  if (Number.isNaN(r)) r = 1;
  if (d.integerCuts) {
    // Integer cuts include their end points: q is the mass strictly below.
    const ka = Math.ceil(limitReal(a, -D_CUT, D_CUT));
    const kb = Math.floor(limitReal(b, -D_CUT, D_CUT));
    if (ka !== kb) {
      q = d.rawCdf(ka - 1);
      if (ka < kb && d.geometric) r = d.rawCdf(kb + 1);
    }
  }
  return { lo: a, hi: b, q, r, split: a > b };
}

function cutQuantile(d: CbDistribution, w: CutWindow, u: number): number {
  u = limitReal(u, 0, 1);
  let x: number;
  if (!w.split) {
    const p = u > 0 && u < 1 ? u * (w.r - w.q) + w.q : u;
    x = limitReal(d.rawQuantile(p), w.lo, w.hi);
  } else {
    let p = u * (1 + (w.r - w.q));
    if (p > w.r) p += w.q - w.r;
    x = d.rawQuantile(p);
    if (w.hi < x && x < w.lo) x = VAL_ERR;
  }
  if (d.integerCuts) {
    if (x === -D_CUT) return -VAL_MAX;
    if (x === D_CUT) return VAL_MAX;
  }
  return x;
}

function cutCdf(d: CbDistribution, w: CutWindow, x: number): number {
  if (!w.split) {
    if (x < w.lo) return 0;
    if (w.hi < x) return 1;
    const f = d.rawCdf(x);
    if (f <= w.q) return 0;
    if (w.r <= f) return 1;
    return (f - w.q) / (w.r - w.q);
  }
  const kept = 1 - (w.q - w.r);
  if (w.hi < x && x < w.lo) return kept > 0 ? w.r / kept : 0;
  const f = d.rawCdf(x);
  if (f < w.r) return kept > 0 ? f / kept : 0;
  if (f < w.q) return kept > 0 ? w.r / kept : 0;
  return kept > 0 ? (f - (w.q - w.r)) / kept : 0;
}

/* ========================= continuous ============================ */

class Uniform extends CbDistribution {
  readonly type = 'uniform' as const;
  readonly discrete = false;
  private width: number;
  private invWidth: number;
  constructor(private min: number, private max: number) {
    super();
    this.width = max - min;
    this.invWidth = 1 / this.width;
  }
  rawQuantile(p: number) {
    return limitReal(p, 0, 1) * this.width + this.min;
  }
  rawCdf(x: number) {
    if (x <= this.min) return 0;
    if (this.max <= x) return 1;
    return (x - this.min) * this.invWidth;
  }
  density(x: number) {
    return x >= this.min && x <= this.max ? 1 / (this.max - this.min) : 0;
  }
  mean() {
    return (this.min + this.max) / 2;
  }
  variance() {
    return (this.max - this.min) ** 2 / 12;
  }
  plotRange(): [number, number] {
    const pad = (this.max - this.min) * 0.1;
    return [this.min - pad, this.max + pad];
  }
  validate() {
    return this.max > this.min ? null : 'Maximum must exceed minimum.';
  }
}

class Normal extends CbDistribution {
  readonly type = 'normal' as const;
  readonly discrete = false;
  constructor(private mu: number, private sigma: number) {
    super();
  }
  rawQuantile(p: number) {
    p = limitReal(p, 0, 1);
    if (p < NORMAL_P_MIN) return -VAL_MAX;
    if (p > ALMOST_1) return VAL_MAX;
    return inverseNormal(p) * this.sigma + this.mu;
  }
  rawCdf(x: number) {
    return normalCdf((x - this.mu) / this.sigma);
  }
  density(x: number) {
    return normPdf((x - this.mu) / this.sigma) / this.sigma;
  }
  mean() {
    return this.mu;
  }
  variance() {
    return this.sigma * this.sigma;
  }
  plotRange(): [number, number] {
    return [this.mu - 4 * this.sigma, this.mu + 4 * this.sigma];
  }
  validate() {
    return this.sigma > 0 ? null : 'Std. dev. must be positive.';
  }
}

class Triangular extends CbDistribution {
  readonly type = 'triangular' as const;
  readonly discrete = false;
  constructor(private a: number, private c: number, private b: number) {
    super();
  }
  rawQuantile(p: number) {
    const { a, b, c } = this;
    p = limitReal(p, 0, 1);
    if (p <= (c - a) / (b - a)) return a + sqrtx((c - a) * (b - a) * p);
    return b - sqrtx((b - c) * (b - a) * (1 - p));
  }
  rawCdf(x: number) {
    const { a, b, c } = this;
    if (x <= a) return 0;
    if (b <= x) return 1;
    if (x <= c) return ((x - a) * (x - a)) / ((b - a) * (c - a));
    return 1 - ((b - x) * (b - x)) / ((b - a) * (b - c));
  }
  density(x: number) {
    const { a, b, c } = this;
    if (x < a || x > b) return 0;
    if (x < c) return (2 * (x - a)) / ((b - a) * (c - a));
    if (x > c) return (2 * (b - x)) / ((b - a) * (b - c));
    return 2 / (b - a);
  }
  mean() {
    return (this.a + this.b + this.c) / 3;
  }
  variance() {
    const { a, b, c } = this;
    return (a * a + b * b + c * c - a * b - a * c - b * c) / 18;
  }
  plotRange(): [number, number] {
    const pad = (this.b - this.a) * 0.1;
    return [this.a - pad, this.b + pad];
  }
  validate() {
    if (!(this.a <= this.c && this.c <= this.b && this.a < this.b))
      return 'Need min ≤ likeliest ≤ max.';
    return null;
  }
}

class Lognormal extends CbDistribution {
  readonly type = 'lognormal' as const;
  readonly discrete = false;
  private mu: number;
  private sig: number;
  // Parameterized by the arithmetic mean & std dev of the variable itself,
  // plus an optional location shift (Crystal Ball's default form), converted
  // to log-space parameters exactly the way Crystal Ball does — or given the
  // log-space parameters directly (Crystal Ball's internal form).
  private m: number;
  private s: number;
  constructor(m: number, s: number, private loc: number, logSpace?: { mu: number; sigma: number }) {
    super();
    if (logSpace) {
      this.mu = logSpace.mu;
      this.sig = logSpace.sigma;
      const g = libm.exp(this.sig * this.sig);
      this.m = loc + libm.exp(this.mu) * Math.sqrt(g);
      this.s = libm.exp(this.mu) * Math.sqrt(g * (g - 1));
    } else {
      this.m = m;
      this.s = s;
      this.sig = sqrtx(libm.log(libm.exp(2 * libm.log(s / (m - loc))) + 1));
      this.mu = libm.log((m - loc) / libm.exp(0.5 * (this.sig * this.sig)));
    }
  }
  rawQuantile(p: number) {
    p = limitReal(p, 0, 1);
    if (p < ALMOST_0) return this.loc;
    if (p > ALMOST_1) return VAL_MAX;
    return this.loc + libm.exp(inverseNormal(p) * this.sig + this.mu);
  }
  rawCdf(x: number) {
    if (!(x > this.loc)) return 0;
    return normalCdf((libm.log(x - this.loc) - this.mu) / this.sig);
  }
  density(x: number) {
    const z = x - this.loc;
    if (z <= 0) return 0;
    return normPdf((libm.log(z) - this.mu) / this.sig) / (z * this.sig);
  }
  mean() {
    return this.m;
  }
  variance() {
    return this.s * this.s;
  }
  plotRange(): [number, number] {
    return [this.loc, this.quantile(0.995)];
  }
  validate() {
    if (!(this.s > 0)) return 'Std. dev. must be positive.';
    if (!(this.m - this.loc > 0)) return 'Mean must exceed location.';
    return null;
  }
}

class Exponential extends CbDistribution {
  readonly type = 'exponential' as const;
  readonly discrete = false;
  constructor(private rate: number) {
    super();
  }
  rawQuantile(p: number) {
    p = limitReal(p, 0, 1);
    if (p > ALMOST_1) return VAL_MAX;
    return -libm.log(1 - p) / this.rate;
  }
  rawCdf(x: number) {
    return x < ALMOST_0 ? 0 : 1 - libm.exp(-this.rate * x);
  }
  density(x: number) {
    return x < 0 ? 0 : this.rate * libm.exp(-this.rate * x);
  }
  mean() {
    return 1 / this.rate;
  }
  variance() {
    return 1 / (this.rate * this.rate);
  }
  plotRange(): [number, number] {
    return [0, this.quantile(0.995)];
  }
  validate() {
    return this.rate > 0 ? null : 'Rate must be positive.';
  }
}

class Gamma extends CbDistribution {
  readonly type = 'gamma' as const;
  readonly discrete = false;
  constructor(private loc: number, private scale: number, private shape: number) {
    super();
  }
  rawQuantile(p: number) {
    p = limitReal(p, 0, 1);
    if (p < ALMOST_0) return this.loc;
    if (p > ALMOST_1) return VAL_MAX;
    return this.solve(p) + this.loc;
  }
  /**
   * Crystal Ball's Gamma inverse: a lognormal starting guess (using the log
   * variance where a std. dev. would be expected), then Newton steps until the
   * step drops below √5e-16 absolute — which is why it agrees with an exact
   * inverse only to ~1e-8.
   */
  private solve(p: number): number {
    const { scale, shape } = this;
    p = limitReal(p, ALMOST_0, ALMOST_1);
    const m = shape * scale;
    const v = m * scale;
    const lv = libm.log(v + m * m);
    const mu = 2 * libm.log(m) - 0.5 * lv;
    const s2 = -2 * libm.log(m) + lv;
    let x = libm.exp(inverseNormal(p) * s2 + mu);
    let dx = 1;
    const tol = Math.sqrt(ALMOST_0);
    for (let iter = 0; Math.abs(dx) > 2.5e-31 * Math.abs(x) && Math.abs(dx) > tol && iter < 100; iter++) {
      dx = (gammp(shape, x / scale) - p) / this.kernelPdf(x);
      let next = x - dx;
      if (next < 0) {
        next = x / 10;
        dx = x - next;
      }
      x = next;
    }
    return x;
  }
  private kernelPdf(x: number): number {
    const { scale, shape } = this;
    if (x === 0) {
      if (shape === 1) return 1 / scale;
      if (shape < 1) return VAL_MAX;
    }
    return libm.exp((shape - 1) * libm.log(x) - x / scale - gammln(shape) - shape * libm.log(scale));
  }
  rawCdf(x: number) {
    if (x <= this.loc) return 0;
    if (x >= VAL_MAX) return 1;
    return gammp(this.shape, (x - this.loc) / this.scale);
  }
  density(x: number) {
    const z = (x - this.loc) / this.scale;
    if (z <= 0) return 0;
    return libm.exp((this.shape - 1) * libm.log(z) - z - logGamma(this.shape)) / this.scale;
  }
  mean() {
    return this.loc + this.scale * this.shape;
  }
  variance() {
    return this.scale * this.scale * this.shape;
  }
  plotRange(): [number, number] {
    return [this.loc, this.quantile(0.995)];
  }
  validate() {
    if (!(this.scale > 0)) return 'Scale must be positive.';
    if (!(this.shape > 0)) return 'Shape must be positive.';
    return null;
  }
}

class Weibull extends CbDistribution {
  readonly type = 'weibull' as const;
  readonly discrete = false;
  constructor(private loc: number, private scale: number, private shape: number) {
    super();
  }
  rawQuantile(p: number) {
    p = limitReal(p, 0, 1);
    if (p > ALMOST_1) return VAL_MAX;
    return libm.exp(libm.log(libm.log(1 / (1 - p))) / this.shape + libm.log(this.scale)) + this.loc;
  }
  rawCdf(x: number) {
    if (x <= this.loc) return 0;
    return 1 - 1 / libm.exp(libm.exp((libm.log(x - this.loc) - libm.log(this.scale)) * this.shape));
  }
  density(x: number) {
    const z = (x - this.loc) / this.scale;
    if (z < 0) return 0;
    const k = this.shape;
    return (k / this.scale) * libm.pow(z, k - 1) * libm.exp(-libm.pow(z, k));
  }
  mean() {
    return this.loc + this.scale * gammaFn(1 + 1 / this.shape);
  }
  variance() {
    const g1 = gammaFn(1 + 1 / this.shape);
    const g2 = gammaFn(1 + 2 / this.shape);
    return this.scale * this.scale * (g2 - g1 * g1);
  }
  plotRange(): [number, number] {
    return [this.loc, this.quantile(0.995)];
  }
  validate() {
    if (!(this.scale > 0)) return 'Scale must be positive.';
    if (!(this.shape > 0)) return 'Shape must be positive.';
    return null;
  }
}

/**
 * Crystal Ball's inverse of the regularized incomplete beta: a normal (or
 * small-x) starting point followed by exactly 100 damped multiplicative
 * corrections. It is not a converged root-finder — in the tails it can stop
 * well short of the true quantile (even for Beta(1,1)) — and that is
 * reproduced on purpose.
 */
function cbBetaInv(a: number, b: number, p: number): number {
  if (p <= ALMOST_0) return 0;
  if (p >= ALMOST_1) return 1;
  let lnB = gammln(a + b) - gammln(a) - gammln(b);
  let split = (a + 1) / (a + b + 2);
  const front = libm.exp(lnB + a * libm.log(split) + b * libm.log(1 - split));
  let direct = true;
  if (!(p <= (front * betaCf(a, b, split)) / a)) {
    [a, b] = [b, a];
    split = 1 - split;
    p = 1 - p;
    direct = false;
  }
  let x: number;
  if (a >= 1 && b >= 1) {
    const y = -inverseNormal(p);
    const lam = (y * y - 3) / 6;
    const r1 = 1 / (2 * a - 1);
    const r2 = 1 / (2 * b - 1);
    const h = 2 / (r1 + r2);
    let w = lam + 5 / 6 - 2 / (3 * h);
    w = (y * Math.sqrt(h + lam)) / h - (r2 - r1) * w;
    x = a / (a + b * libm.exp(2 * w));
  } else {
    x = libm.exp((libm.log(p) + libm.log(a) - lnB) / a);
  }
  if (x > split) x = split;
  if (!(ALMOST_0 > x) && !(ALMOST_0 > 1 - x)) {
    lnB -= libm.log(a * p);
    for (let j = 0; j < 100; j++) {
      const cf = betaCf(a, b, x);
      const lg = a * libm.log(x) + b * libm.log(1 - x) + libm.log(cf) + lnB;
      let t = ((1 - x) * cf * lg) / a;
      if (0.9 < t) t = 0.9;
      const at = Math.abs(t);
      if (!(ALMOST_0 > at) && !(ALMOST_0 > 1 - at)) {
        x *= 1 - t;
        if (x > split) x = split;
      }
    }
  }
  return direct ? x : 1 - x;
}

class Beta extends CbDistribution {
  readonly type: DistributionType = 'beta';
  readonly discrete = false;
  constructor(
    private min: number,
    private max: number,
    private alpha: number,
    private beta: number,
  ) {
    super();
  }
  private span() {
    return this.max - this.min;
  }
  rawQuantile(p: number) {
    const z = cbBetaInv(this.alpha, this.beta, limitReal(p, 0, 1));
    return this.max * z + this.min * (1 - z);
  }
  rawCdf(x: number) {
    const z = limitReal((x - this.min) / (this.max - this.min), 0, 1);
    return betaInc(this.alpha, this.beta, z);
  }
  density(x: number) {
    const z = (x - this.min) / this.span();
    if (z <= 0 || z >= 1) return 0;
    const lb = logGamma(this.alpha + this.beta) - logGamma(this.alpha) - logGamma(this.beta);
    return (
      libm.exp(lb + (this.alpha - 1) * libm.log(z) + (this.beta - 1) * libm.log(1 - z)) /
      this.span()
    );
  }
  mean() {
    return this.min + this.span() * (this.alpha / (this.alpha + this.beta));
  }
  variance() {
    const a = this.alpha;
    const b = this.beta;
    return (this.span() ** 2 * (a * b)) / ((a + b) ** 2 * (a + b + 1));
  }
  plotRange(): [number, number] {
    return [this.min, this.max];
  }
  validate() {
    if (!(this.max > this.min)) return 'Maximum must exceed minimum.';
    if (!(this.alpha > 0 && this.beta > 0)) return 'Alpha and beta must be positive.';
    return null;
  }
}

class BetaPert extends CbDistribution {
  readonly type = 'betapert' as const;
  readonly discrete = false;
  // PERT: Crystal Ball builds a Beta on [min, max] with
  // α = (4·mode + max − 5·min)/(max − min), β = (5·max − min − 4·mode)/(max − min).
  private inner: Beta;
  constructor(private a: number, private c: number, private b: number) {
    super();
    const alpha = (4 * c + b - 5 * a) / (b - a);
    const beta = (5 * b - a - 4 * c) / (b - a);
    this.inner = new Beta(a, b, alpha, beta);
  }
  rawQuantile(p: number) {
    return this.inner.quantile(p);
  }
  rawCdf(x: number) {
    return this.inner.cdf(x);
  }
  density(x: number) {
    return this.inner.density(x);
  }
  mean() {
    return (this.a + 4 * this.c + this.b) / 6;
  }
  variance() {
    return this.inner.variance();
  }
  plotRange(): [number, number] {
    return [this.a, this.b];
  }
  validate() {
    if (!(this.a <= this.c && this.c <= this.b && this.a < this.b))
      return 'Need min ≤ likeliest ≤ max.';
    return null;
  }
}

class Logistic extends CbDistribution {
  readonly type = 'logistic' as const;
  readonly discrete = false;
  constructor(private m: number, private scale: number) {
    super();
  }
  rawQuantile(p: number) {
    p = limitReal(p, 0, 1);
    if (p < ALMOST_0) return -VAL_MAX;
    if (p > ALMOST_1) return VAL_MAX;
    return this.m + this.scale * libm.log(p / (1 - p));
  }
  rawCdf(x: number) {
    return 1 / (1 + libm.exp((this.m - x) / this.scale));
  }
  density(x: number) {
    const z = libm.exp(-(x - this.m) / this.scale);
    return z / (this.scale * (1 + z) ** 2);
  }
  mean() {
    return this.m;
  }
  variance() {
    return (this.scale * this.scale * Math.PI * Math.PI) / 3;
  }
  plotRange(): [number, number] {
    return [this.quantile(0.005), this.quantile(0.995)];
  }
  validate() {
    return this.scale > 0 ? null : 'Scale must be positive.';
  }
}

class Pareto extends CbDistribution {
  readonly type = 'pareto' as const;
  readonly discrete = false;
  private exponent: number;
  constructor(private loc: number, private shape: number) {
    super();
    this.exponent = -1 / shape;
  }
  rawQuantile(p: number) {
    p = limitReal(p, 0, 1);
    if (p > ALMOST_1) return VAL_MAX;
    return this.loc * libm.pow(1 - p, this.exponent);
  }
  rawCdf(x: number) {
    if (x <= this.loc) return 0;
    return 1 - libm.pow(this.loc / x, this.shape);
  }
  density(x: number) {
    if (x < this.loc) return 0;
    return (this.shape * libm.pow(this.loc, this.shape)) / libm.pow(x, this.shape + 1);
  }
  mean() {
    return this.shape > 1 ? (this.shape * this.loc) / (this.shape - 1) : NaN;
  }
  variance() {
    const a = this.shape;
    if (a <= 2) return NaN;
    return (this.loc * this.loc * a) / ((a - 1) ** 2 * (a - 2));
  }
  plotRange(): [number, number] {
    return [this.loc, this.quantile(0.99)];
  }
  validate() {
    if (!(this.loc > 0)) return 'Location must be positive.';
    if (!(this.shape > 0)) return 'Shape must be positive.';
    return null;
  }
}

/** Student's t CDF in standard units, via the incomplete beta. */
function cbStudentCdf(dof: number, t: number): number {
  const ib = 1 - betaInc(dof * 0.5, 0.5, dof / (dof + t * t));
  return t < 0 ? 0.5 * (1 - ib) : 0.5 * (1 + ib);
}

class StudentT extends CbDistribution {
  readonly type = 'studentt' as const;
  readonly discrete = false;
  constructor(private mid: number, private scale: number, private dof: number) {
    super();
  }
  /**
   * Crystal Ball inverts the t CDF by 40 bisection steps on [−100, 100]
   * standard units, so draws never leave midpoint ± 100·scale and carry
   * ~1e-10 bisection error.
   */
  rawQuantile(p: number) {
    p = limitReal(p, 0, 1);
    if (p < ALMOST_0) return -VAL_MAX;
    if (p > ALMOST_1) return VAL_MAX;
    let t = 0;
    if (p !== 0.5) {
      let lo = -100;
      let hi = 100;
      for (let i = 0; i < 40; i++) {
        const m = (lo + hi) * 0.5;
        if (cbStudentCdf(this.dof, m) > p) hi = m;
        else lo = m;
      }
      t = (lo + hi) * 0.5;
    }
    return t * this.scale + this.mid;
  }
  rawCdf(x: number) {
    return cbStudentCdf(this.dof, (x - this.mid) / this.scale);
  }
  density(x: number) {
    const t = (x - this.mid) / this.scale;
    const nu = this.dof;
    const c = libm.exp(logGamma((nu + 1) / 2) - logGamma(nu / 2) - 0.5 * libm.log(nu * Math.PI));
    return (c / this.scale) * libm.pow(1 + (t * t) / nu, -(nu + 1) / 2);
  }
  mean() {
    return this.dof > 1 ? this.mid : NaN;
  }
  variance() {
    return this.dof > 2 ? (this.scale * this.scale * this.dof) / (this.dof - 2) : NaN;
  }
  plotRange(): [number, number] {
    return [this.quantile(0.005), this.quantile(0.995)];
  }
  validate() {
    if (!(this.scale > 0)) return 'Scale must be positive.';
    if (!(this.dof > 0)) return 'Degrees of freedom must be positive.';
    return null;
  }
}

class MaxExtreme extends CbDistribution {
  readonly type = 'maxextreme' as const;
  readonly discrete = false;
  // Gumbel (maximum) distribution.
  constructor(private mode: number, private scale: number) {
    super();
  }
  rawQuantile(p: number) {
    p = limitReal(p, 0, 1);
    if (p < ALMOST_0) return -VAL_MAX;
    return this.mode - this.scale * libm.log(-libm.log(p));
  }
  rawCdf(x: number) {
    return libm.exp(-libm.exp(-(x - this.mode) / this.scale));
  }
  density(x: number) {
    const z = (x - this.mode) / this.scale;
    return libm.exp(-z - libm.exp(-z)) / this.scale;
  }
  mean() {
    return this.mode + this.scale * EULER;
  }
  variance() {
    return (this.scale * this.scale * Math.PI * Math.PI) / 6;
  }
  plotRange(): [number, number] {
    return [this.quantile(0.005), this.quantile(0.995)];
  }
  validate() {
    return this.scale > 0 ? null : 'Scale must be positive.';
  }
}

class MinExtreme extends CbDistribution {
  readonly type = 'minextreme' as const;
  readonly discrete = false;
  constructor(private mode: number, private scale: number) {
    super();
  }
  rawQuantile(p: number) {
    p = limitReal(p, 0, 1);
    if (p > ALMOST_1) return VAL_MAX;
    return this.mode + this.scale * libm.log(-libm.log(1 - p));
  }
  rawCdf(x: number) {
    return 1 - libm.exp(-libm.exp((x - this.mode) / this.scale));
  }
  density(x: number) {
    const z = (x - this.mode) / this.scale;
    return libm.exp(z - libm.exp(z)) / this.scale;
  }
  mean() {
    return this.mode - this.scale * EULER;
  }
  variance() {
    return (this.scale * this.scale * Math.PI * Math.PI) / 6;
  }
  plotRange(): [number, number] {
    return [this.quantile(0.005), this.quantile(0.995)];
  }
  validate() {
    return this.scale > 0 ? null : 'Scale must be positive.';
  }
}

/* ========================== discrete ============================= */

/**
 * Crystal Ball's generic discrete machinery: the CDF and inverse CDF walk
 * outward from a starting index (`mode`, where the cumulative `cumMode` and
 * mass `pmfMode` are precomputed) using each distribution's pmf recurrences,
 * so floating-point ties resolve exactly as they do in Crystal Ball.
 */
abstract class CbDiscrete extends CbDistribution {
  readonly discrete = true;
  protected kMin = 0;
  protected kMax = 1;
  protected mode = 0;
  protected cumMode = 0.5;
  protected pmfMode = 0.5;
  /** pmf(k) computed directly. */
  protected abstract pmfAt(k: number): number;
  /** pmf(k + 1) from pmf(k). */
  protected abstract up(k: number, pk: number): number;
  /** pmf(k − 1) from pmf(k). */
  protected abstract down(k: number, pk: number): number;

  /** Cumulative mass up to the starting index (Crystal Ball sums downward). */
  protected initCumulative() {
    this.pmfMode = this.pmfAt(this.mode);
    this.cumMode = this.pmfMode;
    let pk = this.pmfMode;
    for (let j = this.mode - 1; j >= this.kMin; j--) {
      pk = this.down(j + 1, pk);
      this.cumMode += pk;
      if (pk <= ALMOST_0) break;
    }
  }

  protected walkCdf(x: number): number {
    const k = x < 0 ? -1 : Math.floor(limitReal(x, -D_CUT, D_CUT));
    if (k < this.kMin) return 0;
    if (k > this.kMax) return 1;
    let cum = this.cumMode;
    let pk = this.pmfMode;
    if (k > this.mode) {
      for (let j = this.mode + 1; j <= k; j++) {
        pk = this.up(j - 1, pk);
        cum += pk;
        if (cum > ALMOST_1 || pk < ALMOST_0) break;
      }
    } else {
      for (let j = this.mode - 1; j >= k; j--) {
        cum -= pk;
        pk = this.down(j + 1, pk);
        if (cum < ALMOST_0 || pk < ALMOST_0) break;
      }
    }
    return cum;
  }

  protected walkQuantile(p: number): number {
    let k = this.mode;
    let pk = this.pmfMode;
    let cum = this.cumMode;
    if (p > cum) {
      while (k < this.kMax) {
        pk = this.up(k, pk);
        k++;
        cum += pk;
        if (cum >= p) return k;
      }
      return k;
    }
    while (k > this.kMin) {
      cum -= pk;
      if (cum < p) return k;
      pk = this.down(k, pk);
      k--;
    }
    return k;
  }

  rawCdf(x: number) {
    return this.walkCdf(x);
  }
}

class YesNo extends CbDiscrete {
  readonly type = 'yesno' as const;
  // Crystal Ball draws Yes-No through an internal Binomial(1, p).
  private inner: Binomial;
  constructor(private prob: number) {
    super();
    this.inner = new Binomial(1, prob);
    this.mode = 0;
    this.kMin = 0;
    this.kMax = 1;
    this.initCumulative();
  }
  protected pmfAt(k: number) {
    return this.inner.pmfOf(k);
  }
  protected up(k: number, pk: number) {
    return this.inner.upOf(k, pk);
  }
  protected down(k: number, pk: number) {
    return this.inner.downOf(k, pk);
  }
  rawQuantile(p: number) {
    return this.walkQuantile(p);
  }
  density(x: number) {
    if (x === 1) return this.prob;
    if (x === 0) return 1 - this.prob;
    return 0;
  }
  mean() {
    return this.prob;
  }
  variance() {
    return this.prob * (1 - this.prob);
  }
  plotRange(): [number, number] {
    return [0, 1];
  }
  validate() {
    return this.prob >= 0 && this.prob <= 1 ? null : 'Probability must be in [0,1].';
  }
}

class DiscreteUniform extends CbDiscrete {
  readonly type = 'discreteuniform' as const;
  private count: number;
  private inv: number;
  constructor(private min: number, private max: number) {
    super();
    this.kMax = Math.floor(max);
    this.kMin = Math.floor(min);
    this.mode = this.kMin;
    this.count = 1 + this.kMax - this.kMin;
    this.inv = 1 / this.count;
    this.pmfMode = this.inv;
    this.cumMode = this.inv;
  }
  protected pmfAt(k: number) {
    return k < this.min || this.max < k ? 0 : this.inv;
  }
  protected up() {
    return this.inv;
  }
  protected down() {
    return this.inv;
  }
  /**
   * Crystal Ball's closed form ceil(p·n − 1 + min − 1e-7). Note the 1e-7
   * nudge: for the very smallest uniforms (p < ~1e-7/n) it returns min − 1,
   * and Crystal Ball really does draw that value.
   */
  rawQuantile(p: number) {
    if (p < ALMOST_0) return this.min;
    if (p > ALMOST_1) return this.max;
    const v = Math.ceil(p * this.count - 1 + this.min - 1e-7);
    return v < ALMOST_0 && v > -ALMOST_0 ? 0 : v;
  }
  rawCdf(x: number) {
    x = Math.floor(limitReal(x, -D_CUT, D_CUT));
    if (x < this.min) return 0;
    if (this.max <= x) return 1;
    return (1 + x - this.min) * this.inv;
  }
  density(x: number) {
    return x >= this.min && x <= this.max && Number.isInteger(x) ? this.inv : 0;
  }
  mean() {
    return (this.min + this.max) / 2;
  }
  variance() {
    return (this.count ** 2 - 1) / 12;
  }
  plotRange(): [number, number] {
    return [this.min - 0.5, this.max + 0.5];
  }
  validate() {
    return this.max > this.min ? null : 'Maximum must exceed minimum.';
  }
}

class Binomial extends CbDiscrete {
  readonly type = 'binomial' as const;
  private f: number;
  private q: number;
  private odds: number;
  constructor(private n: number, private p: number) {
    super();
    this.f = toInt(n);
    this.q = 1 - p;
    this.odds = p / this.q;
    this.mode = toInt(n * p);
    this.kMin = 0;
    this.kMax = this.f;
    this.initCumulative();
  }
  pmfOf(k: number) {
    return this.pmfAt(k);
  }
  upOf(k: number, pk: number) {
    return this.up(k, pk);
  }
  downOf(k: number, pk: number) {
    return this.down(k, pk);
  }
  protected pmfAt(k: number) {
    if (k < 0 || k > this.n) return 0;
    if (this.f <= 1000) return nCombR(this.f, k) * libm.pow(this.p, k) * libm.pow(this.q, this.f - k);
    const p = this.p === 0 ? ALMOST_0 : this.p === 1 ? ALMOST_1 : this.p;
    return libm.exp(
      gammln(this.f + 1) - gammln(k + 1) - gammln(this.f - k + 1) + k * libm.log(p) + (this.f - k) * libm.log(this.q),
    );
  }
  protected up(k: number, pk: number) {
    return pk === 0 ? 0 : (pk * (this.f - k) * this.odds) / (k + 1);
  }
  protected down(k: number, pk: number) {
    return (pk * k) / (this.odds * (this.f - k + 1));
  }
  rawQuantile(p: number) {
    p = limitReal(p, 0, 1);
    if (p < ALMOST_0) return 0;
    if (p > ALMOST_1) return this.n;
    return this.walkQuantile(p);
  }
  density(x: number) {
    return Number.isInteger(x) && x >= 0 && x <= this.n
      ? libm.exp(logBinom(this.n, x) + x * libm.log(this.p) + (this.n - x) * libm.log(1 - this.p))
      : 0;
  }
  mean() {
    return this.n * this.p;
  }
  variance() {
    return this.n * this.p * (1 - this.p);
  }
  plotRange(): [number, number] {
    return [-0.5, this.n + 0.5];
  }
  validate() {
    if (!(Number.isInteger(this.n) && this.n > 0)) return 'Trials must be a positive integer.';
    if (!(this.p >= 0 && this.p <= 1)) return 'Probability must be in [0,1].';
    return null;
  }
}

class Poisson extends CbDiscrete {
  readonly type = 'poisson' as const;
  constructor(private lambda: number) {
    super();
    this.mode = toInt(lambda + 0.5);
    this.kMin = 0;
    this.kMax = Math.max(1000000000, toInt(lambda) << 1);
    this.initCumulative();
  }
  protected pmfAt(k: number) {
    return libm.exp(libm.log(this.lambda) * k - gammln(k + 1) - this.lambda);
  }
  protected up(k: number, pk: number) {
    return (pk * this.lambda) / (k + 1);
  }
  protected down(k: number, pk: number) {
    return (pk * k) / this.lambda;
  }
  rawQuantile(p: number) {
    p = limitReal(p, 0, 1);
    if (p < ALMOST_0) return 0;
    if (p > ALMOST_1) return VAL_MAX;
    return this.walkQuantile(p);
  }
  density(x: number) {
    return Number.isInteger(x) && x >= 0
      ? libm.exp(-this.lambda + x * libm.log(this.lambda) - logGamma(x + 1))
      : 0;
  }
  mean() {
    return this.lambda;
  }
  variance() {
    return this.lambda;
  }
  plotRange(): [number, number] {
    return [-0.5, this.lambda + 4 * Math.sqrt(this.lambda) + 1];
  }
  validate() {
    return this.lambda > 0 ? null : 'Rate must be positive.';
  }
}

class Geometric extends CbDiscrete {
  readonly type = 'geometric' as const;
  readonly geometric = true;
  // Number of trials up to and including the first success (support 1,2,3,…).
  private logFail: number;
  private invLogFail: number;
  constructor(private p: number) {
    super();
    this.mode = 0;
    this.kMin = 1;
    this.kMax = 2000;
    this.pmfMode = p;
    this.cumMode = p;
    this.logFail = libm.log(1 - p);
    this.invLogFail = 1 / this.logFail;
  }
  protected pmfAt(k: number) {
    return k < 1 ? 0 : this.p * libm.pow(1 - this.p, k - 1);
  }
  protected up(_k: number, pk: number) {
    return pk * (1 - this.p);
  }
  protected down(_k: number, pk: number) {
    return pk / (1 - this.p);
  }
  rawQuantile(pp: number) {
    pp = limitReal(pp, ALMOST_0, ALMOST_1);
    return Math.floor(this.invLogFail * libm.log(1 - pp)) + 1;
  }
  rawCdf(x: number) {
    const k = toInt(limitReal(x, -D_CUT, D_CUT));
    return k < 1 ? 0 : 1 - libm.exp(this.logFail * k);
  }
  density(x: number) {
    return Number.isInteger(x) && x >= 1 ? this.p * (1 - this.p) ** (x - 1) : 0;
  }
  mean() {
    return 1 / this.p;
  }
  variance() {
    return (1 - this.p) / (this.p * this.p);
  }
  plotRange(): [number, number] {
    return [0.5, this.quantile(0.99)];
  }
  validate() {
    return this.p > 0 && this.p <= 1 ? null : 'Probability must be in (0,1].';
  }
}

class Hypergeometric extends CbDiscrete {
  readonly type = 'hypergeometric' as const;
  // N population, K successes in population, n drawn.
  private iN: number;
  private iK: number;
  private iDraw: number;
  private invTotal = NaN;
  constructor(private N: number, private K: number, private n: number) {
    super();
    this.iK = toInt(K);
    this.iDraw = toInt(n);
    this.iN = toInt(N);
    this.mode = toInt((this.iDraw * this.iK) / this.iN);
    this.kMin = Math.max(0, this.iDraw + this.iK - this.iN);
    this.kMax = Math.min(this.iDraw, this.iK);
    if (this.iN <= 1000) this.invTotal = 1 / nCombR(this.iN, this.iDraw);
    this.initCumulative();
  }
  protected pmfAt(k: number) {
    if (k > this.kMax || k < this.kMin) return 0;
    const { iN, iK, iDraw } = this;
    if (iN <= 1000) return this.invTotal * nCombR(iK, k) * nCombR(iN - iK, iDraw - k);
    return libm.exp(
      gammln(iK + 1) - gammln(k + 1) - gammln(iK - k + 1) +
        (gammln(iN - iK + 1) - gammln(iDraw - k + 1) - gammln(iN - iK - iDraw + k + 1)) -
        (gammln(iN + 1) - gammln(iDraw + 1) - gammln(iN - iDraw + 1)),
    );
  }
  // Crystal Ball multiplies the denominators as 32-bit ints; imul keeps that.
  protected up(k: number, pk: number) {
    const { iN, iK, iDraw } = this;
    return (pk * (iK - k) * (iDraw - k)) / Math.imul(k + 1, iN - iK - iDraw + k + 1);
  }
  protected down(k: number, pk: number) {
    const { iN, iK, iDraw } = this;
    return (pk * k * (iN - iK - iDraw + k)) / Math.imul(iDraw - k + 1, iK - k + 1);
  }
  rawQuantile(p: number) {
    p = limitReal(p, 0, 1);
    if (p < ALMOST_0) return Math.max(0, this.iK + this.iDraw - this.iN);
    if (p > ALMOST_1) return Math.min(this.iDraw, this.iK);
    return this.walkQuantile(p);
  }
  density(x: number) {
    return Number.isInteger(x) && x >= this.kMin && x <= this.kMax
      ? libm.exp(logBinom(this.K, x) + logBinom(this.N - this.K, this.n - x) - logBinom(this.N, this.n))
      : 0;
  }
  mean() {
    return (this.n * this.K) / this.N;
  }
  variance() {
    const N = this.N;
    const K = this.K;
    const n = this.n;
    return (n * (K / N) * ((N - K) / N) * (N - n)) / (N - 1);
  }
  plotRange(): [number, number] {
    return [this.kMin - 0.5, this.kMax + 0.5];
  }
  validate() {
    if (!(Number.isInteger(this.N) && this.N > 0)) return 'Population must be a positive integer.';
    if (!(this.K >= 0 && this.K <= this.N)) return 'Successes must be in [0, population].';
    if (!(this.n >= 0 && this.n <= this.N)) return 'Sample must be in [0, population].';
    return null;
  }
}

class NegBinomial extends CbDiscrete {
  readonly type = 'negbinomial' as const;
  // r = required number of successes, p = success probability.
  // Support: total number of trials k >= r.
  private ir: number;
  private fail: number;
  constructor(private r: number, private p: number) {
    super();
    this.ir = toInt(r);
    this.fail = 1 - p;
    this.mode = toInt(r / p);
    // Crystal Ball's search window for the recurrences.
    if (this.ir < 1000 && this.mode <= 1000) {
      this.kMin = this.ir;
      this.kMax = 8000;
    } else if (this.ir < 10 && this.mode > 1000) {
      this.kMin = this.ir;
      this.kMax = toInt(this.mode * 8);
    } else {
      this.kMin = toInt(this.mode / 8);
      this.kMax = toInt(this.mode * 2.5);
    }
    this.initCumulative();
  }
  protected pmfAt(k: number) {
    if (k < this.ir) return 0;
    if (this.ir <= 1000 && this.mode < 1000)
      return nCombR(k - 1, this.ir - 1) * libm.pow(this.p, this.ir) * libm.pow(this.fail, k - this.ir);
    const p = this.p === 0 ? ALMOST_0 : this.p === 1 ? ALMOST_1 : this.p;
    return libm.exp(
      gammln(k) - gammln(this.ir) - gammln(k - this.ir + 1) + this.ir * libm.log(p) + (k - this.ir) * libm.log(this.fail),
    );
  }
  protected up(k: number, pk: number) {
    return (pk * k * this.fail) / (k - this.ir + 1);
  }
  protected down(k: number, pk: number) {
    return (pk * (k - this.ir)) / (this.fail * (k - 1));
  }
  rawQuantile(pp: number) {
    pp = limitReal(pp, 0, 1);
    if (pp < ALMOST_0) return this.r;
    if (pp > ALMOST_1) return D_CUT;
    return this.walkQuantile(pp);
  }
  density(x: number) {
    return Number.isInteger(x) && x >= this.r
      ? libm.exp(logBinom(x - 1, this.r - 1) + this.r * libm.log(this.p) + (x - this.r) * libm.log(1 - this.p))
      : 0;
  }
  mean() {
    return this.r / this.p;
  }
  variance() {
    return (this.r * (1 - this.p)) / (this.p * this.p);
  }
  plotRange(): [number, number] {
    return [this.r - 0.5, this.quantile(0.99)];
  }
  validate() {
    if (!(Number.isInteger(this.r) && this.r > 0)) return 'Shape must be a positive integer.';
    if (!(this.p > 0 && this.p <= 1)) return 'Probability must be in (0,1].';
    return null;
  }
}

/* ============================ custom ============================== */

type SegmentKind = 'point' | 'range' | 'steps' | 'sloped' | 'slopedSteps';

interface CustomSegment {
  kind: SegmentKind;
  lo: number; // point value, or range min
  hi: number; // range max (== lo for a point)
  step: number;
  stepCount: number;
  w: number; // the segment's (unnormalized) probability mass
  w0: number; // sloped ranges: density height at lo
  w1: number; // sloped ranges: density height at hi
  cum: number; // cumulative mass through this segment
}

/**
 * Crystal Ball's Custom distribution: outcomes sorted by value, masses
 * accumulated unnormalized, and p scaled by the total before the segment
 * lookup — so tables entered in any order sample the same as in Crystal Ball.
 */
class Custom extends CbDistribution {
  readonly type = 'custom' as const;
  readonly discrete: boolean;
  private seg: CustomSegment[] = [];
  private total = 0;

  constructor(points: CustomPoint[]) {
    super();
    const segs = points.map((pt): CustomSegment => {
      const isRange = pt.min !== undefined && pt.max !== undefined;
      const lo = isRange ? (pt.min as number) : (pt.value ?? 0);
      const hi = isRange ? (pt.max as number) : lo;
      const weight = Math.max(0, pt.weight);
      if (!isRange) return { kind: 'point', lo, hi, step: 0, stepCount: 1, w: weight, w0: weight, w1: weight, cum: 0 };
      if (pt.endWeight !== undefined) {
        const w1 = Math.max(0, pt.endWeight);
        if (pt.step && pt.step > 0) {
          // Sloping discrete range: step i carries weight + slope·(i·step); the
          // segment's mass is the sum over its steps.
          const stepCount = toInt((hi - lo) / pt.step) + 1;
          const slope = (w1 - weight) / (hi - lo);
          let mass = 0;
          for (let i = 0; i < stepCount; i++) mass += slope * (i * pt.step) + weight;
          return { kind: 'slopedSteps', lo, hi, step: pt.step, stepCount, w: mass, w0: weight, w1, cum: 0 };
        }
        // Sloping range: the weights are the density heights at each end.
        const area = (Math.min(weight, w1) + Math.abs(w1 - weight) / 2) * (hi - lo);
        return { kind: 'sloped', lo, hi, step: 0, stepCount: 1, w: area, w0: weight, w1, cum: 0 };
      }
      if (pt.step && pt.step > 0) {
        const stepCount = toInt((hi - lo) / pt.step) + 1;
        return { kind: 'steps', lo, hi, step: pt.step, stepCount, w: weight, w0: weight, w1: weight, cum: 0 };
      }
      return { kind: 'range', lo, hi, step: 0, stepCount: 1, w: weight, w0: weight, w1: weight, cum: 0 };
    });
    segs.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
    let c = 0;
    for (const s of segs) s.cum = c += s.w;
    this.seg = segs;
    this.total = c;
    this.discrete = segs.every((s) => s.kind === 'point' || s.kind === 'steps' || s.kind === 'slopedSteps');
  }
  get integerCuts() {
    return false;
  }

  rawQuantile(p: number) {
    const segs = this.seg;
    if (!segs.length) return VAL_ERR;
    if (p <= 0) return segs[0].lo;
    if (p >= 1) return segs[segs.length - 1].hi;
    p *= this.total;
    let before = 0;
    for (const s of segs) {
      if (p >= before && p <= s.cum) {
        let mass = s.cum - before;
        if (mass === 0) mass = -VAL_MAX;
        return segmentQuantile(s, (p - before) / mass);
      }
      before = s.cum;
    }
    return VAL_ERR;
  }
  rawCdf(x: number) {
    let c = 0;
    for (const s of this.seg) {
      if (s.kind === 'point') {
        if (s.lo <= x) c += s.w;
      } else if (x >= s.hi) c += s.w;
      // A stepped range already holds its first step's mass at its minimum.
      else if (x > s.lo || (x === s.lo && (s.kind === 'steps' || s.kind === 'slopedSteps')))
        c += s.kind === 'sloped' ? slopedMass(s, x - s.lo) : s.w * segmentCdf(s, x);
    }
    return this.total > 0 ? c / this.total : 0;
  }
  density(x: number) {
    let d = 0;
    for (const s of this.seg) {
      const w = s.w / (this.total || 1);
      if (s.kind === 'point') {
        if (x === s.lo) d += w;
      } else if (s.kind === 'steps' || s.kind === 'slopedSteps') {
        const k = (x - s.lo) / s.step;
        if (k >= 0 && k < s.stepCount && Math.abs(k - Math.round(k)) < 1e-9)
          d += s.kind === 'steps' ? w / s.stepCount : (w * slopedStepWeight(s, Math.round(k))) / (s.w || 1);
      } else if (x >= s.lo && x <= s.hi && s.hi > s.lo) {
        if (s.kind === 'range') d += w / (s.hi - s.lo);
        else d += (w * (s.w0 + ((s.w1 - s.w0) * (x - s.lo)) / (s.hi - s.lo))) / (s.w || 1);
      }
    }
    return d;
  }
  mean() {
    // Numeric over the inverse so every segment kind is covered uniformly.
    let s = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) s += this.quantile((i + 0.5) / N);
    return s / N;
  }
  variance() {
    const m = this.mean();
    let s = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const v = this.quantile((i + 0.5) / N);
      s += (v - m) * (v - m);
    }
    return s / N;
  }
  plotRange(): [number, number] {
    const lo = Math.min(...this.seg.map((s) => s.lo));
    const hi = Math.max(...this.seg.map((s) => s.hi));
    const pad = (hi - lo || 1) * 0.1;
    return [lo - pad, hi + pad];
  }
  validate() {
    if (!this.seg.length) return 'Add at least one outcome.';
    for (const s of this.seg) if (s.hi < s.lo) return 'Range max must be ≥ min.';
    if (!(this.total > 0)) return 'Probabilities must add up to more than zero.';
    return null;
  }
}

function segmentQuantile(s: CustomSegment, rel: number): number {
  switch (s.kind) {
    case 'point':
      return s.lo;
    case 'range':
      return rel * (s.hi - s.lo) + s.lo;
    case 'steps':
      return (Math.ceil(roundDotNet(rel * s.stepCount, 12)) - 1) * s.step + s.lo;
    case 'sloped': {
      const width = s.hi - s.lo;
      const slope = (s.w1 - s.w0) / width;
      if (slope === 0) return rel * width + s.lo;
      return s.lo + (-s.w0 + sqrtx(s.w0 * s.w0 + 2 * slope * (rel * s.w))) / slope;
    }
    case 'slopedSteps': {
      if (rel === 0) return s.lo;
      if (rel === 1) return s.lo + (s.stepCount - 1) * s.step;
      const target = rel * s.w;
      let cum = 0;
      for (let i = 0; i < s.stepCount; i++) {
        cum += slopedStepWeight(s, i);
        if (target <= cum) return s.lo + i * s.step;
      }
      return 0;
    }
  }
}

/** Weight of step i of a sloping discrete range. */
function slopedStepWeight(s: CustomSegment, i: number): number {
  return ((s.w1 - s.w0) / (s.hi - s.lo)) * (i * s.step) + s.w0;
}

/** A sloped range's mass below lo + d, as Crystal Ball's sloped CustomValueDst computes it. */
function slopedMass(s: CustomSegment, d: number): number {
  const range = s.hi - s.lo;
  if (d <= 0) return 0;
  if (range <= d) return s.w;
  const lin = d / range;
  let quad: number;
  if (s.w1 > s.w0) quad = (d * d) / (range * range);
  else {
    const rest = range - d;
    quad = 1.0 - (rest * rest) / (range * range);
  }
  return quad * ((Math.abs(s.w1 - s.w0) / 2.0) * range) + lin * (Math.min(s.w0, s.w1) * range);
}

/** Fraction of a segment's mass at or below x (lo < x < hi). */
function segmentCdf(s: CustomSegment, x: number): number {
  const width = s.hi - s.lo;
  if (s.kind === 'steps') return Math.min(1, (Math.floor((x - s.lo) / s.step + 1e-9) + 1) / s.stepCount);
  if (s.kind === 'slopedSteps') {
    const last = Math.min(s.stepCount - 1, Math.floor((x - s.lo) / s.step + 1e-9));
    let c = 0;
    for (let i = 0; i <= last; i++) c += slopedStepWeight(s, i);
    return c / (s.w || 1);
  }
  if (s.kind === 'sloped') {
    const d = x - s.lo;
    return (s.w0 * d + ((s.w1 - s.w0) * d * d) / (2 * width)) / (s.w || 1);
  }
  return (x - s.lo) / width;
}

/**
 * Truncation wrapper: Crystal Ball's assumption "cuts". The inverse transform
 * is remapped to u → q + u·(r − q) and clamped to the window; integer cuts
 * include both end values. A lower cut above the upper cut excludes the band
 * between them instead.
 */
class Truncated implements Distribution {
  readonly type: DistributionType;
  readonly discrete: boolean;
  private w: CutWindow;
  constructor(
    private base: CbDistribution,
    private a: number,
    private b: number,
  ) {
    this.type = base.type;
    this.discrete = base.discrete;
    this.w = cutWindow(base, a, b);
  }
  quantile(p: number) {
    return cutQuantile(this.base, this.w, p);
  }
  density(x: number) {
    if (x < this.a || x > this.b) return 0;
    return this.base.density(x) / (this.w.r - this.w.q || 1);
  }
  cdf(x: number) {
    return cutCdf(this.base, this.w, x);
  }
  mean() {
    // Numeric estimate over the truncated range.
    let s = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) s += this.quantile((i + 0.5) / N);
    return s / N;
  }
  variance() {
    const m = this.mean();
    let s = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const v = this.quantile((i + 0.5) / N);
      s += (v - m) * (v - m);
    }
    return s / N;
  }
  plotRange(): [number, number] {
    const [lo, hi] = this.base.plotRange();
    return [Math.max(lo, this.a), Math.min(hi, this.b)];
  }
  validate() {
    return this.base.validate();
  }
}

/** Wrap a distribution with optional lower/upper truncation bounds. */
export function truncate(base: Distribution, min?: number, max?: number): Distribution {
  if (min === undefined && max === undefined) return base;
  if (!(base instanceof CbDistribution)) throw new Error('Only built-in distributions can be truncated.');
  return new Truncated(base, min ?? -VAL_MAX, max ?? VAL_MAX);
}

/* ========================== registry ============================= */

/**
 * The full catalogue of distributions, with parameter metadata the UI uses
 * to render input fields and the factory that builds a live Distribution.
 */
export const DISTRIBUTIONS: DistributionDef[] = [
  {
    type: 'normal',
    label: 'Normal',
    discrete: false,
    blurb: 'Symmetric bell curve around a mean.',
    params: [
      { key: 'mean', label: 'Mean', default: 0 },
      { key: 'stdev', label: 'Std. Dev.', default: 1 },
    ],
    create: (p) => new Normal(p.mean, p.stdev),
  },
  {
    type: 'triangular',
    label: 'Triangular',
    discrete: false,
    blurb: 'Min / most-likely / max — great when you only have estimates.',
    params: [
      { key: 'min', label: 'Minimum', default: 0 },
      { key: 'likely', label: 'Likeliest', default: 5 },
      { key: 'max', label: 'Maximum', default: 10 },
    ],
    create: (p) => new Triangular(p.min, p.likely, p.max),
  },
  {
    type: 'betapert',
    label: 'BetaPERT',
    discrete: false,
    blurb: 'Smooth min / likeliest / max — a softer Triangular for risk work.',
    params: [
      { key: 'min', label: 'Minimum', default: 0 },
      { key: 'likely', label: 'Likeliest', default: 5 },
      { key: 'max', label: 'Maximum', default: 10 },
    ],
    create: (p) => new BetaPert(p.min, p.likely, p.max),
  },
  {
    type: 'uniform',
    label: 'Uniform',
    discrete: false,
    blurb: 'Every value between min and max equally likely.',
    params: [
      { key: 'min', label: 'Minimum', default: 0 },
      { key: 'max', label: 'Maximum', default: 10 },
    ],
    create: (p) => new Uniform(p.min, p.max),
  },
  {
    type: 'lognormal',
    label: 'Lognormal',
    discrete: false,
    blurb: 'Positive, right-skewed — prices, durations, multiplicative effects.',
    params: [
      { key: 'mean', label: 'Mean', default: 10 },
      { key: 'stdev', label: 'Std. Dev.', default: 3 },
      { key: 'location', label: 'Location', default: 0 },
    ],
    // Alternate forms Crystal Ball accepts: logMean/logStdev, geoMean/geoStdev.
    create: (p) =>
      Number.isFinite(p.logMean) && Number.isFinite(p.logStdev)
        ? new Lognormal(NaN, NaN, p.location ?? 0, { mu: p.logMean, sigma: p.logStdev })
        : Number.isFinite(p.geoMean) && Number.isFinite(p.geoStdev)
          ? new Lognormal(NaN, NaN, p.location ?? 0, { mu: libm.log(p.geoMean), sigma: libm.log(p.geoStdev) })
          : new Lognormal(p.mean, p.stdev, p.location),
  },
  {
    type: 'exponential',
    label: 'Exponential',
    discrete: false,
    blurb: 'Time between independent events at a constant rate.',
    params: [{ key: 'rate', label: 'Rate', default: 1 }],
    create: (p) => new Exponential(p.rate),
  },
  {
    type: 'gamma',
    label: 'Gamma',
    discrete: false,
    blurb: 'Flexible positive distribution; sum of exponentials.',
    params: [
      { key: 'location', label: 'Location', default: 0 },
      { key: 'scale', label: 'Scale', default: 1 },
      { key: 'shape', label: 'Shape', default: 2 },
    ],
    create: (p) => new Gamma(p.location, p.scale, p.shape),
  },
  {
    type: 'weibull',
    label: 'Weibull',
    discrete: false,
    blurb: 'Reliability and lifetime modelling.',
    params: [
      { key: 'location', label: 'Location', default: 0 },
      { key: 'scale', label: 'Scale', default: 1 },
      { key: 'shape', label: 'Shape', default: 2 },
    ],
    create: (p) => new Weibull(p.location, p.scale, p.shape),
  },
  {
    type: 'beta',
    label: 'Beta',
    discrete: false,
    blurb: 'Bounded between a min and max with an adjustable shape.',
    params: [
      { key: 'min', label: 'Minimum', default: 0 },
      { key: 'max', label: 'Maximum', default: 1 },
      { key: 'alpha', label: 'Alpha', default: 2 },
      { key: 'beta', label: 'Beta', default: 2 },
    ],
    create: (p) => new Beta(p.min, p.max, p.alpha, p.beta),
  },
  {
    type: 'logistic',
    label: 'Logistic',
    discrete: false,
    blurb: 'Bell-shaped with heavier tails than normal.',
    params: [
      { key: 'mean', label: 'Mean', default: 0 },
      { key: 'scale', label: 'Scale', default: 1 },
    ],
    create: (p) => new Logistic(p.mean, p.scale),
  },
  {
    type: 'pareto',
    label: 'Pareto',
    discrete: false,
    blurb: 'Heavy-tailed "80/20" phenomena.',
    params: [
      { key: 'location', label: 'Location', default: 1 },
      { key: 'shape', label: 'Shape', default: 2 },
    ],
    create: (p) => new Pareto(p.location, p.shape),
  },
  {
    type: 'studentt',
    label: "Student's t",
    discrete: false,
    blurb: 'Bell curve with fat tails controlled by degrees of freedom.',
    params: [
      { key: 'midpoint', label: 'Midpoint', default: 0 },
      { key: 'scale', label: 'Scale', default: 1 },
      { key: 'dof', label: 'Deg. Freedom', default: 5 },
    ],
    create: (p) => new StudentT(p.midpoint, p.scale, p.dof),
  },
  {
    type: 'maxextreme',
    label: 'Max Extreme',
    discrete: false,
    blurb: 'Distribution of maxima (Gumbel).',
    params: [
      { key: 'likeliest', label: 'Likeliest', default: 0 },
      { key: 'scale', label: 'Scale', default: 1 },
    ],
    create: (p) => new MaxExtreme(p.likeliest, p.scale),
  },
  {
    type: 'minextreme',
    label: 'Min Extreme',
    discrete: false,
    blurb: 'Distribution of minima.',
    params: [
      { key: 'likeliest', label: 'Likeliest', default: 0 },
      { key: 'scale', label: 'Scale', default: 1 },
    ],
    create: (p) => new MinExtreme(p.likeliest, p.scale),
  },
  {
    type: 'yesno',
    label: 'Yes-No',
    discrete: true,
    blurb: 'Bernoulli: 1 with a given probability, else 0.',
    params: [{ key: 'probability', label: 'Probability', default: 0.5 }],
    create: (p) => new YesNo(p.probability),
  },
  {
    type: 'discreteuniform',
    label: 'Discrete Uniform',
    discrete: true,
    blurb: 'Equally-likely integers between min and max.',
    params: [
      { key: 'min', label: 'Minimum', default: 1, integer: true },
      { key: 'max', label: 'Maximum', default: 6, integer: true },
    ],
    create: (p) => new DiscreteUniform(p.min, p.max),
  },
  {
    type: 'binomial',
    label: 'Binomial',
    discrete: true,
    blurb: 'Number of successes in n independent trials.',
    params: [
      { key: 'trials', label: 'Trials', default: 10, integer: true },
      { key: 'probability', label: 'Probability', default: 0.5 },
    ],
    create: (p) => new Binomial(p.trials, p.probability),
  },
  {
    type: 'poisson',
    label: 'Poisson',
    discrete: true,
    blurb: 'Count of events in a fixed interval at a constant rate.',
    params: [{ key: 'rate', label: 'Rate', default: 3 }],
    create: (p) => new Poisson(p.rate),
  },
  {
    type: 'geometric',
    label: 'Geometric',
    discrete: true,
    blurb: 'Number of trials until the first success.',
    params: [{ key: 'probability', label: 'Probability', default: 0.3 }],
    create: (p) => new Geometric(p.probability),
  },
  {
    type: 'hypergeometric',
    label: 'Hypergeometric',
    discrete: true,
    blurb: 'Successes drawn without replacement from a finite population.',
    params: [
      { key: 'population', label: 'Population', default: 50, integer: true },
      { key: 'successes', label: 'Successes', default: 20, integer: true },
      { key: 'sample', label: 'Sample Size', default: 10, integer: true },
    ],
    create: (p) => new Hypergeometric(p.population, p.successes, p.sample),
  },
  {
    type: 'negbinomial',
    label: 'Negative Binomial',
    discrete: true,
    blurb: 'Trials needed to reach a target number of successes.',
    params: [
      { key: 'shape', label: 'Successes (r)', default: 3, integer: true },
      { key: 'probability', label: 'Probability', default: 0.4 },
    ],
    create: (p) => new NegBinomial(p.shape, p.probability),
  },
  {
    type: 'custom',
    label: 'Custom (Discrete)',
    discrete: true,
    blurb: 'Your own discrete values and/or continuous ranges, each weighted.',
    params: [],
    create: (_p, custom) => new Custom(custom && custom.length ? custom : [{ value: 0, weight: 1 }]),
  },
];

const BY_TYPE = new Map(DISTRIBUTIONS.map((d) => [d.type, d]));

export function getDistributionDef(type: DistributionType): DistributionDef {
  const def = BY_TYPE.get(type);
  if (!def) throw new Error(`Unknown distribution type: ${type}`);
  return def;
}

/** Build a live Distribution from a type, parameter map, and optional custom points. */
export function createDistribution(
  type: DistributionType,
  params: Params,
  custom?: CustomPoint[],
): Distribution {
  return getDistributionDef(type).create(params, custom);
}

/** Default parameter map for a distribution type (used when first created). */
export function defaultParams(type: DistributionType): Params {
  const out: Params = {};
  for (const spec of getDistributionDef(type).params) out[spec.key] = spec.default;
  return out;
}
