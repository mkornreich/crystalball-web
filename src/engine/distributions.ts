/**
 * Probability-distribution library for assumptions.
 *
 * Every distribution exposes an inverse CDF `quantile(p)` so the engine can
 * sample by inverse transform — the same mechanism serves ordinary Monte
 * Carlo (p ~ Uniform(0,1)) and Latin Hypercube (p stratified), and lets the
 * Iman–Conover routine reorder samples without re-sampling. Distributions
 * also report their theoretical `mean`/`variance`, a `pdf`/`pmf`, and a `cdf`
 * for the live preview chart and for the unit tests.
 *
 * This mirrors the set of assumption types offered by Oracle Crystal Ball,
 * reimplemented from the public mathematical definitions.
 */

import {
  betaI,
  gamma as gammaFn,
  gammaP,
  invBetaI,
  invGammaP,
  logBinom,
  logGamma,
  normCdf,
  normInv,
  normPdf,
  studentTInv,
} from './special';

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
 * One Custom-distribution outcome. Either a discrete point (`value`) or a
 * continuous uniform range (`min`/`max`), carrying a relative `weight`. A mix
 * of points and ranges is allowed, exactly as Crystal Ball's Custom
 * distribution supports.
 */
export interface CustomPoint {
  weight: number;
  value?: number;
  min?: number;
  max?: number;
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

/* ============================ helpers ============================ */

function clampP(p: number): number {
  // Keep inverse transforms away from the singular endpoints.
  const eps = 1e-12;
  if (p < eps) return eps;
  if (p > 1 - eps) return 1 - eps;
  return p;
}

/** Build a discrete distribution's inverse CDF by scanning cumulative mass. */
function discreteQuantile(
  pmf: (k: number) => number,
  p: number,
  kMin: number,
  kMax: number,
): number {
  const target = clampP(p);
  let cum = 0;
  for (let k = kMin; k <= kMax; k++) {
    cum += pmf(k);
    if (cum >= target) return k;
  }
  return kMax;
}

function discreteCdf(pmf: (k: number) => number, x: number, kMin: number): number {
  let cum = 0;
  const kx = Math.floor(x);
  for (let k = kMin; k <= kx; k++) cum += pmf(k);
  return Math.min(1, cum);
}

/* ========================= continuous ============================ */

class Uniform implements Distribution {
  readonly type = 'uniform' as const;
  readonly discrete = false;
  constructor(private min: number, private max: number) {}
  quantile(p: number) {
    return this.min + clampP(p) * (this.max - this.min);
  }
  density(x: number) {
    return x >= this.min && x <= this.max ? 1 / (this.max - this.min) : 0;
  }
  cdf(x: number) {
    if (x <= this.min) return 0;
    if (x >= this.max) return 1;
    return (x - this.min) / (this.max - this.min);
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

class Normal implements Distribution {
  readonly type = 'normal' as const;
  readonly discrete = false;
  constructor(private mu: number, private sigma: number) {}
  quantile(p: number) {
    return this.mu + this.sigma * normInv(clampP(p));
  }
  density(x: number) {
    return normPdf((x - this.mu) / this.sigma) / this.sigma;
  }
  cdf(x: number) {
    return normCdf((x - this.mu) / this.sigma);
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

class Triangular implements Distribution {
  readonly type = 'triangular' as const;
  readonly discrete = false;
  constructor(private a: number, private c: number, private b: number) {}
  quantile(p: number) {
    const { a, b, c } = this;
    const fc = (c - a) / (b - a);
    const pp = clampP(p);
    if (pp < fc) return a + Math.sqrt(pp * (b - a) * (c - a));
    return b - Math.sqrt((1 - pp) * (b - a) * (b - c));
  }
  density(x: number) {
    const { a, b, c } = this;
    if (x < a || x > b) return 0;
    if (x < c) return (2 * (x - a)) / ((b - a) * (c - a));
    if (x > c) return (2 * (b - x)) / ((b - a) * (b - c));
    return 2 / (b - a);
  }
  cdf(x: number) {
    const { a, b, c } = this;
    if (x <= a) return 0;
    if (x >= b) return 1;
    if (x <= c) return (x - a) ** 2 / ((b - a) * (c - a));
    return 1 - (b - x) ** 2 / ((b - a) * (b - c));
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

class Lognormal implements Distribution {
  readonly type = 'lognormal' as const;
  readonly discrete = false;
  private mu: number;
  private sig: number;
  // Parameterized by the arithmetic mean & std dev of the variable itself,
  // plus an optional location shift (Crystal Ball's default form).
  constructor(private m: number, private s: number, private loc: number) {
    const shiftedMean = m - loc;
    const variance = s * s;
    this.sig = Math.sqrt(Math.log(1 + variance / (shiftedMean * shiftedMean)));
    this.mu = Math.log(shiftedMean) - (this.sig * this.sig) / 2;
  }
  quantile(p: number) {
    return this.loc + Math.exp(this.mu + this.sig * normInv(clampP(p)));
  }
  density(x: number) {
    const z = x - this.loc;
    if (z <= 0) return 0;
    return (
      normPdf((Math.log(z) - this.mu) / this.sig) / (z * this.sig)
    );
  }
  cdf(x: number) {
    const z = x - this.loc;
    if (z <= 0) return 0;
    return normCdf((Math.log(z) - this.mu) / this.sig);
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

class Exponential implements Distribution {
  readonly type = 'exponential' as const;
  readonly discrete = false;
  constructor(private rate: number) {}
  quantile(p: number) {
    return -Math.log(1 - clampP(p)) / this.rate;
  }
  density(x: number) {
    return x < 0 ? 0 : this.rate * Math.exp(-this.rate * x);
  }
  cdf(x: number) {
    return x < 0 ? 0 : 1 - Math.exp(-this.rate * x);
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

class Gamma implements Distribution {
  readonly type = 'gamma' as const;
  readonly discrete = false;
  constructor(private loc: number, private scale: number, private shape: number) {}
  quantile(p: number) {
    return this.loc + this.scale * invGammaP(clampP(p), this.shape);
  }
  density(x: number) {
    const z = (x - this.loc) / this.scale;
    if (z <= 0) return 0;
    return (
      Math.exp(
        (this.shape - 1) * Math.log(z) - z - logGamma(this.shape),
      ) / this.scale
    );
  }
  cdf(x: number) {
    const z = (x - this.loc) / this.scale;
    return z <= 0 ? 0 : gammaP(this.shape, z);
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

class Weibull implements Distribution {
  readonly type = 'weibull' as const;
  readonly discrete = false;
  constructor(private loc: number, private scale: number, private shape: number) {}
  quantile(p: number) {
    return (
      this.loc + this.scale * Math.pow(-Math.log(1 - clampP(p)), 1 / this.shape)
    );
  }
  density(x: number) {
    const z = (x - this.loc) / this.scale;
    if (z < 0) return 0;
    const k = this.shape;
    return (
      (k / this.scale) * Math.pow(z, k - 1) * Math.exp(-Math.pow(z, k))
    );
  }
  cdf(x: number) {
    const z = (x - this.loc) / this.scale;
    return z < 0 ? 0 : 1 - Math.exp(-Math.pow(z, this.shape));
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

class Beta implements Distribution {
  readonly type = 'beta' as const;
  readonly discrete = false;
  constructor(
    private min: number,
    private max: number,
    private alpha: number,
    private beta: number,
  ) {}
  private span() {
    return this.max - this.min;
  }
  quantile(p: number) {
    return this.min + this.span() * invBetaI(clampP(p), this.alpha, this.beta);
  }
  density(x: number) {
    const z = (x - this.min) / this.span();
    if (z <= 0 || z >= 1) return 0;
    const lb = logGamma(this.alpha + this.beta) - logGamma(this.alpha) - logGamma(this.beta);
    return (
      Math.exp(lb + (this.alpha - 1) * Math.log(z) + (this.beta - 1) * Math.log(1 - z)) /
      this.span()
    );
  }
  cdf(x: number) {
    const z = (x - this.min) / this.span();
    return betaI(z, this.alpha, this.beta);
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

class BetaPert implements Distribution {
  readonly type = 'betapert' as const;
  readonly discrete = false;
  // PERT: a re-parameterized Beta from min / likeliest / max estimates.
  private inner: Beta;
  private alpha: number;
  private beta: number;
  constructor(private a: number, private c: number, private b: number) {
    const mu = (a + 4 * c + b) / 6;
    const span = b - a || 1;
    this.alpha = (6 * (mu - a)) / span;
    this.beta = (6 * (b - mu)) / span;
    this.inner = new Beta(a, b, this.alpha, this.beta);
  }
  quantile(p: number) {
    return this.inner.quantile(p);
  }
  density(x: number) {
    return this.inner.density(x);
  }
  cdf(x: number) {
    return this.inner.cdf(x);
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

class Logistic implements Distribution {
  readonly type = 'logistic' as const;
  readonly discrete = false;
  constructor(private m: number, private scale: number) {}
  quantile(p: number) {
    const pp = clampP(p);
    return this.m + this.scale * Math.log(pp / (1 - pp));
  }
  density(x: number) {
    const z = Math.exp(-(x - this.m) / this.scale);
    return z / (this.scale * (1 + z) ** 2);
  }
  cdf(x: number) {
    return 1 / (1 + Math.exp(-(x - this.m) / this.scale));
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

class Pareto implements Distribution {
  readonly type = 'pareto' as const;
  readonly discrete = false;
  constructor(private loc: number, private shape: number) {}
  quantile(p: number) {
    return this.loc * Math.pow(1 - clampP(p), -1 / this.shape);
  }
  density(x: number) {
    if (x < this.loc) return 0;
    return (this.shape * Math.pow(this.loc, this.shape)) / Math.pow(x, this.shape + 1);
  }
  cdf(x: number) {
    if (x < this.loc) return 0;
    return 1 - Math.pow(this.loc / x, this.shape);
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

class StudentT implements Distribution {
  readonly type = 'studentt' as const;
  readonly discrete = false;
  constructor(private mid: number, private scale: number, private dof: number) {}
  quantile(p: number) {
    return this.mid + this.scale * studentTInv(clampP(p), this.dof);
  }
  density(x: number) {
    const t = (x - this.mid) / this.scale;
    const nu = this.dof;
    const c = Math.exp(
      logGamma((nu + 1) / 2) - logGamma(nu / 2) - 0.5 * Math.log(nu * Math.PI),
    );
    return (c / this.scale) * Math.pow(1 + (t * t) / nu, -(nu + 1) / 2);
  }
  cdf(x: number) {
    const t = (x - this.mid) / this.scale;
    const xb = this.dof / (this.dof + t * t);
    const ib = 0.5 * betaI(xb, this.dof / 2, 0.5);
    return t > 0 ? 1 - ib : ib;
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

class MaxExtreme implements Distribution {
  readonly type = 'maxextreme' as const;
  readonly discrete = false;
  // Gumbel (maximum) distribution.
  constructor(private mode: number, private scale: number) {}
  quantile(p: number) {
    return this.mode - this.scale * Math.log(-Math.log(clampP(p)));
  }
  density(x: number) {
    const z = (x - this.mode) / this.scale;
    return (Math.exp(-z - Math.exp(-z))) / this.scale;
  }
  cdf(x: number) {
    return Math.exp(-Math.exp(-(x - this.mode) / this.scale));
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

class MinExtreme implements Distribution {
  readonly type = 'minextreme' as const;
  readonly discrete = false;
  constructor(private mode: number, private scale: number) {}
  quantile(p: number) {
    return this.mode + this.scale * Math.log(-Math.log(1 - clampP(p)));
  }
  density(x: number) {
    const z = (x - this.mode) / this.scale;
    return (Math.exp(z - Math.exp(z))) / this.scale;
  }
  cdf(x: number) {
    return 1 - Math.exp(-Math.exp((x - this.mode) / this.scale));
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

class YesNo implements Distribution {
  readonly type = 'yesno' as const;
  readonly discrete = true;
  constructor(private prob: number) {}
  quantile(p: number) {
    return clampP(p) > 1 - this.prob ? 1 : 0;
  }
  density(x: number) {
    if (x === 1) return this.prob;
    if (x === 0) return 1 - this.prob;
    return 0;
  }
  cdf(x: number) {
    if (x < 0) return 0;
    if (x < 1) return 1 - this.prob;
    return 1;
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

class DiscreteUniform implements Distribution {
  readonly type = 'discreteuniform' as const;
  readonly discrete = true;
  constructor(private min: number, private max: number) {}
  private n() {
    return Math.round(this.max - this.min) + 1;
  }
  quantile(p: number) {
    const k = this.min + Math.floor(clampP(p) * this.n());
    return Math.min(this.max, k);
  }
  density(x: number) {
    return x >= this.min && x <= this.max && Number.isInteger(x) ? 1 / this.n() : 0;
  }
  cdf(x: number) {
    if (x < this.min) return 0;
    if (x >= this.max) return 1;
    return (Math.floor(x) - this.min + 1) / this.n();
  }
  mean() {
    return (this.min + this.max) / 2;
  }
  variance() {
    return (this.n() ** 2 - 1) / 12;
  }
  plotRange(): [number, number] {
    return [this.min - 0.5, this.max + 0.5];
  }
  validate() {
    return this.max > this.min ? null : 'Maximum must exceed minimum.';
  }
}

class Binomial implements Distribution {
  readonly type = 'binomial' as const;
  readonly discrete = true;
  constructor(private n: number, private p: number) {}
  private pmf = (k: number) =>
    Math.exp(logBinom(this.n, k) + k * Math.log(this.p) + (this.n - k) * Math.log(1 - this.p));
  quantile(p: number) {
    return discreteQuantile(this.pmf, p, 0, this.n);
  }
  density(x: number) {
    return Number.isInteger(x) && x >= 0 && x <= this.n ? this.pmf(x) : 0;
  }
  cdf(x: number) {
    return discreteCdf(this.pmf, x, 0);
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

class Poisson implements Distribution {
  readonly type = 'poisson' as const;
  readonly discrete = true;
  constructor(private lambda: number) {}
  private pmf = (k: number) =>
    Math.exp(-this.lambda + k * Math.log(this.lambda) - logGamma(k + 1));
  quantile(p: number) {
    const hi = Math.ceil(this.lambda + 10 * Math.sqrt(this.lambda) + 10);
    return discreteQuantile(this.pmf, p, 0, hi);
  }
  density(x: number) {
    return Number.isInteger(x) && x >= 0 ? this.pmf(x) : 0;
  }
  cdf(x: number) {
    // P(X <= k) = Q(k+1, lambda) via the regularized incomplete gamma.
    return x < 0 ? 0 : 1 - gammaP(Math.floor(x) + 1, this.lambda);
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

class Geometric implements Distribution {
  readonly type = 'geometric' as const;
  readonly discrete = true;
  // Number of trials up to and including the first success (support 1,2,3,…).
  constructor(private p: number) {}
  quantile(pp: number) {
    return Math.ceil(Math.log(1 - clampP(pp)) / Math.log(1 - this.p));
  }
  density(x: number) {
    return Number.isInteger(x) && x >= 1 ? this.p * (1 - this.p) ** (x - 1) : 0;
  }
  cdf(x: number) {
    return x < 1 ? 0 : 1 - (1 - this.p) ** Math.floor(x);
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

class Hypergeometric implements Distribution {
  readonly type = 'hypergeometric' as const;
  readonly discrete = true;
  // N population, K successes in population, n drawn.
  constructor(private N: number, private K: number, private n: number) {}
  private pmf = (k: number) =>
    Math.exp(
      logBinom(this.K, k) + logBinom(this.N - this.K, this.n - k) - logBinom(this.N, this.n),
    );
  private kMin() {
    return Math.max(0, this.n - (this.N - this.K));
  }
  private kMax() {
    return Math.min(this.n, this.K);
  }
  quantile(p: number) {
    return discreteQuantile(this.pmf, p, this.kMin(), this.kMax());
  }
  density(x: number) {
    return Number.isInteger(x) && x >= this.kMin() && x <= this.kMax() ? this.pmf(x) : 0;
  }
  cdf(x: number) {
    return discreteCdf(this.pmf, x, this.kMin());
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
    return [this.kMin() - 0.5, this.kMax() + 0.5];
  }
  validate() {
    if (!(Number.isInteger(this.N) && this.N > 0)) return 'Population must be a positive integer.';
    if (!(this.K >= 0 && this.K <= this.N)) return 'Successes must be in [0, population].';
    if (!(this.n >= 0 && this.n <= this.N)) return 'Sample must be in [0, population].';
    return null;
  }
}

class NegBinomial implements Distribution {
  readonly type = 'negbinomial' as const;
  readonly discrete = true;
  // r = required number of successes, p = success probability.
  // Support: total number of trials k >= r.
  constructor(private r: number, private p: number) {}
  private pmf = (k: number) =>
    Math.exp(
      logBinom(k - 1, this.r - 1) +
        this.r * Math.log(this.p) +
        (k - this.r) * Math.log(1 - this.p),
    );
  quantile(pp: number) {
    const mean = this.r / this.p;
    const hi = Math.ceil(mean + 12 * Math.sqrt(mean / this.p) + 20);
    return discreteQuantile(this.pmf, pp, this.r, hi);
  }
  density(x: number) {
    return Number.isInteger(x) && x >= this.r ? this.pmf(x) : 0;
  }
  cdf(x: number) {
    return discreteCdf(this.pmf, x, this.r);
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

interface CustomSegment {
  isRange: boolean;
  lo: number; // point value, or range min
  hi: number; // range max (== lo for a point)
  w: number; // normalized probability
  c0: number; // cumulative probability at segment start
  c1: number; // cumulative probability at segment end
}

class Custom implements Distribution {
  readonly type = 'custom' as const;
  readonly discrete: boolean;
  private seg: CustomSegment[] = [];

  constructor(points: CustomPoint[]) {
    const total = points.reduce((s, pt) => s + Math.max(0, pt.weight), 0) || 1;
    let c = 0;
    let allPoints = true;
    for (const pt of points) {
      const isRange = pt.min !== undefined && pt.max !== undefined;
      const lo = isRange ? (pt.min as number) : (pt.value ?? 0);
      const hi = isRange ? (pt.max as number) : (pt.value ?? 0);
      const w = Math.max(0, pt.weight) / total;
      this.seg.push({ isRange, lo, hi, w, c0: c, c1: c + w });
      c += w;
      if (isRange) allPoints = false;
    }
    this.discrete = allPoints;
  }

  quantile(p: number) {
    const t = clampP(p);
    for (const s of this.seg) {
      if (t <= s.c1 || s === this.seg[this.seg.length - 1]) {
        if (!s.isRange) return s.lo;
        const frac = s.c1 > s.c0 ? (t - s.c0) / (s.c1 - s.c0) : 0;
        return s.lo + frac * (s.hi - s.lo);
      }
    }
    return this.seg.length ? this.seg[this.seg.length - 1].hi : 0;
  }
  density(x: number) {
    let d = 0;
    for (const s of this.seg) {
      if (!s.isRange) {
        if (x === s.lo) d += s.w;
      } else if (x >= s.lo && x <= s.hi && s.hi > s.lo) {
        d += s.w / (s.hi - s.lo);
      }
    }
    return d;
  }
  cdf(x: number) {
    let c = 0;
    for (const s of this.seg) {
      if (!s.isRange) {
        if (s.lo <= x) c += s.w;
      } else if (x >= s.hi) c += s.w;
      else if (x > s.lo) c += (s.w * (x - s.lo)) / (s.hi - s.lo);
    }
    return c;
  }
  mean() {
    return this.seg.reduce((s, g) => s + g.w * ((g.lo + g.hi) / 2), 0);
  }
  variance() {
    const m = this.mean();
    let ex2 = 0;
    for (const g of this.seg) {
      const e2 = g.isRange ? (g.lo * g.lo + g.lo * g.hi + g.hi * g.hi) / 3 : g.lo * g.lo;
      ex2 += g.w * e2;
    }
    return ex2 - m * m;
  }
  plotRange(): [number, number] {
    const lo = Math.min(...this.seg.map((s) => s.lo));
    const hi = Math.max(...this.seg.map((s) => s.hi));
    const pad = (hi - lo || 1) * 0.1;
    return [lo - pad, hi + pad];
  }
  validate() {
    if (!this.seg.length) return 'Add at least one outcome.';
    for (const s of this.seg) if (s.isRange && s.hi < s.lo) return 'Range max must be ≥ min.';
    return null;
  }
}

/**
 * Truncation wrapper: restricts a base distribution to [min, max] by remapping
 * the inverse transform, u -> F(min) + u·(F(max) − F(min)). Preserves the
 * base shape between the bounds and never produces a value outside them, which
 * is how Crystal Ball's assumption truncation fields behave.
 */
class Truncated implements Distribution {
  readonly type: DistributionType;
  readonly discrete: boolean;
  private fa: number;
  private fb: number;
  constructor(
    private base: Distribution,
    private a: number,
    private b: number,
  ) {
    this.type = base.type;
    this.discrete = base.discrete;
    this.fa = Number.isFinite(a) ? base.cdf(a) : 0;
    this.fb = Number.isFinite(b) ? base.cdf(b) : 1;
    if (this.fb <= this.fa) {
      // Degenerate window; fall back to the full distribution.
      this.fa = 0;
      this.fb = 1;
    }
  }
  quantile(p: number) {
    return this.base.quantile(this.fa + clampP(p) * (this.fb - this.fa));
  }
  density(x: number) {
    if (x < this.a || x > this.b) return 0;
    return this.base.density(x) / (this.fb - this.fa);
  }
  cdf(x: number) {
    if (x <= this.a) return 0;
    if (x >= this.b) return 1;
    return (this.base.cdf(x) - this.fa) / (this.fb - this.fa);
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
  return new Truncated(
    base,
    min === undefined ? -Infinity : min,
    max === undefined ? Infinity : max,
  );
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
    create: (p) => new Lognormal(p.mean, p.stdev, p.location),
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
