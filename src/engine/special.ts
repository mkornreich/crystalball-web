/**
 * Special mathematical functions used by the distribution library:
 * the error function, the (log) gamma function, and the regularized
 * incomplete gamma and beta functions together with their inverses.
 *
 * The incomplete-gamma / incomplete-beta routines follow the classic
 * algorithms in *Numerical Recipes* (3rd ed.); the normal quantile uses
 * Acklam's rational approximation refined by a single Halley step. These
 * give close-to-double-precision accuracy, which is what the inverse-CDF
 * (inverse-transform) samplers in distributions.ts rely on.
 */

const SQRT2 = Math.SQRT2;
const SQRT2PI = Math.sqrt(2 * Math.PI);

/* ------------------------------------------------------------------ *
 *  Error function (erf / erfc) — Chebyshev approximation, |err|<1e-15 *
 * ------------------------------------------------------------------ */

const ERF_COF = [
  -1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2,
  -9.561514786808631e-3, -9.46595344482036e-4, 3.66839497852761e-4,
  4.2523324806907e-5, -2.0278578112534e-5, -1.624290004647e-6,
  1.303655835580e-6, 1.5626441722e-8, -8.5238095915e-8,
  6.529054439e-9, 5.059343495e-9, -9.91364156e-10,
  -2.27365122e-10, 9.6467911e-11, 2.394038e-12,
  -6.886027e-12, 8.94487e-13, 3.13092e-13,
  -1.12708e-13, 3.81e-16, 7.106e-15,
];

/** Complementary error function erfc(x) for all real x. */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 2 / (2 + z);
  const ty = 4 * t - 2;
  let d = 0;
  let dd = 0;
  for (let j = ERF_COF.length - 1; j > 0; j--) {
    const tmp = d;
    d = ty * d - dd + ERF_COF[j];
    dd = tmp;
  }
  const res = t * Math.exp(-z * z + 0.5 * (ERF_COF[0] + ty * d) - dd);
  return x >= 0 ? res : 2 - res;
}

/** Error function erf(x). */
export function erf(x: number): number {
  return 1 - erfc(x);
}

/* ------------------------------------------------------------------ *
 *  Standard-normal CDF and inverse CDF (quantile)                     *
 * ------------------------------------------------------------------ */

/** Standard-normal cumulative distribution Φ(x). */
export function normCdf(x: number): number {
  return 0.5 * erfc(-x / SQRT2);
}

/** Standard-normal probability density φ(x). */
export function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT2PI;
}

// Coefficients for Acklam's inverse-normal rational approximation.
const A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
  1.38357751867269e2, -3.066479806614716e1, 2.506628277459239,
];
const B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
  6.680131188771972e1, -1.328068155288572e1,
];
const C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
  -2.549732539343734, 4.374664141464968, 2.938163982698783,
];
const D = [
  7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
  3.754408661907416,
];

/**
 * Inverse standard-normal CDF (quantile). Returns z such that Φ(z) = p.
 * Acklam's approximation, then one Halley iteration for full accuracy.
 */
export function normInv(p: number): number {
  if (p <= 0) return p === 0 ? -Infinity : NaN;
  if (p >= 1) return p === 1 ? Infinity : NaN;

  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let x: number;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x =
      (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
      ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  } else if (p <= pHigh) {
    const q = p - 0.5;
    const r = q * q;
    x =
      ((((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q) /
      (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x =
      -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
      ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  }

  // One Halley step: refine against the true CDF for ~double precision.
  const e = normCdf(x) - p;
  const u = e * SQRT2PI * Math.exp(0.5 * x * x);
  x = x - u / (1 + (x * u) / 2);
  return x;
}

/* ------------------------------------------------------------------ *
 *  Log-gamma (Lanczos) and gamma                                      *
 * ------------------------------------------------------------------ */

const LANCZOS = [
  57.1562356658629235, -59.5979603554754912, 14.1360979747417471,
  -0.491913816097620199, 0.339946499848118887e-4, 0.465236289270485756e-4,
  -0.983744753048795646e-4, 0.158088703224912494e-3, -0.210264441724104883e-3,
  0.217439618115212643e-3, -0.164318106536763890e-3, 0.844182239838527433e-4,
  -0.261908384015814087e-4, 0.368991826595316234e-5,
];

/** Natural log of the gamma function, ln Γ(x), for x > 0. */
export function logGamma(x: number): number {
  if (x <= 0) return NaN;
  let y = x;
  const tmp = x + 5.2421875;
  let ser = 0.999999999999997092;
  for (let j = 0; j < 14; j++) ser += LANCZOS[j] / ++y;
  return (x + 0.5) * Math.log(tmp) - tmp + Math.log((SQRT2PI * ser) / x);
}

/** Gamma function Γ(x). */
export function gamma(x: number): number {
  if (x < 0.5) {
    // Reflection formula for the negative half-line.
    return Math.PI / (Math.sin(Math.PI * x) * gamma(1 - x));
  }
  return Math.exp(logGamma(x));
}

/** Natural log of the binomial coefficient ln C(n, k). */
export function logBinom(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  return logGamma(n + 1) - logGamma(k + 1) - logGamma(n - k + 1);
}

/* ------------------------------------------------------------------ *
 *  Regularized incomplete gamma P(a,x), Q(a,x) and inverse            *
 * ------------------------------------------------------------------ */

const ASWITCH = 100;

function gammpSeries(a: number, x: number): number {
  const gln = logGamma(a);
  let ap = a;
  let sum = 1 / a;
  let del = sum;
  for (let n = 0; n < 200; n++) {
    ap++;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * 1e-16) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - gln);
}

function gammpContinuedFraction(a: number, x: number): number {
  const gln = logGamma(a);
  const FPMIN = Number.MIN_VALUE / 1e-16;
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 200; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  // This returns Q(a,x); caller converts.
  return Math.exp(-x + a * Math.log(x) - gln) * h;
}

/** Regularized lower incomplete gamma P(a, x) = γ(a,x)/Γ(a). */
export function gammaP(a: number, x: number): number {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 0;
  if (a >= ASWITCH) return gammpApprox(a, x, true);
  if (x < a + 1) return gammpSeries(a, x);
  return 1 - gammpContinuedFraction(a, x);
}

/** Regularized upper incomplete gamma Q(a, x) = 1 − P(a, x). */
export function gammaQ(a: number, x: number): number {
  if (x < 0 || a <= 0) return NaN;
  if (x === 0) return 1;
  if (a >= ASWITCH) return gammpApprox(a, x, false);
  if (x < a + 1) return 1 - gammpSeries(a, x);
  return gammpContinuedFraction(a, x);
}

// Gauss–Legendre quadrature used for large a (Numerical Recipes gammpapprox).
const GAU_Y = [
  0.0021695375159141994, 0.011413521097787704, 0.027972308950302116,
  0.051727015600492421, 0.082502225484340941, 0.12007019910960293,
  0.16415283300752470, 0.21442376986779355, 0.27051082840644336,
  0.33199876341447887, 0.39843234186401943, 0.46931971407375483,
  0.54413605556657973, 0.62232745288031077, 0.70331500465597174,
  0.78649910768313447, 0.87126389619061517, 0.95698180152629142,
];
const GAU_W = [
  0.0055657196642445571, 0.012915947284065419, 0.020181515297735382,
  0.027298621498568734, 0.034213810770299537, 0.040875750923644895,
  0.047235083490265582, 0.053244713977759692, 0.058860144245324798,
  0.064039797355015485, 0.068745323835736408, 0.072941885005653087,
  0.076598410645870640, 0.079687828912071670, 0.082187266704339706,
  0.084078218979661945, 0.085346685739338721, 0.085983275670394821,
];

function gammpApprox(a: number, x: number, lower: boolean): number {
  const a1 = a - 1;
  const lna1 = Math.log(a1);
  const sqrta1 = Math.sqrt(a1);
  const gln = logGamma(a);
  const xu =
    x > a1
      ? Math.max(a1 + 11.5 * sqrta1, x + 6 * sqrta1)
      : Math.max(0, Math.min(a1 - 7.5 * sqrta1, x - 5 * sqrta1));
  let sum = 0;
  for (let j = 0; j < 18; j++) {
    const t = x + (xu - x) * GAU_Y[j];
    sum += GAU_W[j] * Math.exp(-(t - a1) + a1 * (Math.log(t) - lna1));
  }
  const ans = (sum * (xu - x) * Math.exp(a1 * (lna1 - 1) - gln));
  const p = ans > 0 ? 1 - ans : -ans;
  return lower ? (x > a1 ? 1 - p : p) : x > a1 ? p : 1 - p;
}

/** Inverse of the regularized lower incomplete gamma: x such that P(a,x)=p. */
export function invGammaP(p: number, a: number): number {
  const gln = logGamma(a);
  const a1 = a - 1;
  const EPS = 1e-10;
  let x: number;
  if (p <= 0) return 0;
  if (p >= 1) return Math.max(100, a + 100 * Math.sqrt(a));

  if (a > 1) {
    const lna1 = Math.log(a1);
    const afac = Math.exp(a1 * (lna1 - 1) - gln);
    const pp = p < 0.5 ? p : 1 - p;
    const t = Math.sqrt(-2 * Math.log(pp));
    x = (2.30753 + t * 0.27061) / (1 + t * (0.99229 + t * 0.04481)) - t;
    if (p < 0.5) x = -x;
    x = Math.max(1e-3, a * Math.pow(1 - 1 / (9 * a) - x / (3 * Math.sqrt(a)), 3));
    for (let j = 0; j < 12; j++) {
      if (x <= 0) return 0;
      const err = gammaP(a, x) - p;
      let t2: number;
      if (a > 1) t2 = afac * Math.exp(-(x - a1) + a1 * (Math.log(x) - lna1));
      else t2 = Math.exp(-x + a1 * Math.log(x) - gln);
      const u = err / t2;
      x -= t2 = u / (1 - 0.5 * Math.min(1, u * (a1 / x - 1)));
      if (x <= 0) x = 0.5 * (x + t2);
      if (Math.abs(t2) < EPS * x) break;
    }
  } else {
    const t = 1 - a * (0.253 + a * 0.12);
    if (p < t) x = Math.pow(p / t, 1 / a);
    else x = 1 - Math.log(1 - (p - t) / (1 - t));
    for (let j = 0; j < 12; j++) {
      if (x <= 0) return 0;
      const err = gammaP(a, x) - p;
      const t2 = Math.exp(-x + a1 * Math.log(x) - gln);
      const u = err / t2;
      let dx = u / (1 - 0.5 * Math.min(1, u * (a1 / x - 1)));
      x -= dx;
      if (x <= 0) x = 0.5 * (x + dx);
      if (Math.abs(dx) < EPS * x) break;
    }
  }
  return x;
}

/* ------------------------------------------------------------------ *
 *  Regularized incomplete beta I_x(a,b) and inverse                   *
 * ------------------------------------------------------------------ */

function betacf(a: number, b: number, x: number): number {
  const FPMIN = Number.MIN_VALUE / 1e-16;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m < 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) <= 1e-16) break;
  }
  return h;
}

/** Regularized incomplete beta function I_x(a, b). */
export function betaI(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbeta = logGamma(a + b) - logGamma(a) - logGamma(b);
  const bt = Math.exp(lbeta + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Inverse regularized incomplete beta: x such that I_x(a,b) = p. */
export function invBetaI(p: number, a: number, b: number): number {
  const EPS = 1e-10;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let x: number;
  const a1 = a - 1;
  const b1 = b - 1;

  if (a >= 1 && b >= 1) {
    const pp = p < 0.5 ? p : 1 - p;
    const t = Math.sqrt(-2 * Math.log(pp));
    let xx =
      (2.30753 + t * 0.27061) / (1 + t * (0.99229 + t * 0.04481)) - t;
    if (p < 0.5) xx = -xx;
    const al = (xx * xx - 3) / 6;
    const h = 2 / (1 / (2 * a - 1) + 1 / (2 * b - 1));
    const w =
      (xx * Math.sqrt(al + h)) / h -
      (1 / (2 * b - 1) - 1 / (2 * a - 1)) * (al + 5 / 6 - 2 / (3 * h));
    x = a / (a + b * Math.exp(2 * w));
  } else {
    const lna = Math.log(a / (a + b));
    const lnb = Math.log(b / (a + b));
    const t = Math.exp(a * lna) / a;
    const u = Math.exp(b * lnb) / b;
    const w = t + u;
    if (p < t / w) x = Math.pow(a * w * p, 1 / a);
    else x = 1 - Math.pow(b * w * (1 - p), 1 / b);
  }

  const afac = -logGamma(a) - logGamma(b) + logGamma(a + b);
  for (let j = 0; j < 12; j++) {
    if (x === 0 || x === 1) return x;
    const err = betaI(x, a, b) - p;
    const t = Math.exp(a1 * Math.log(x) + b1 * Math.log(1 - x) + afac);
    const u = err / t;
    let dx = u / (1 - 0.5 * Math.min(1, u * (a1 / x - b1 / (1 - x))));
    x -= dx;
    if (x <= 0) x = 0.5 * (x + dx);
    if (x >= 1) x = 0.5 * (x + dx + 1);
    if (Math.abs(dx) < EPS * x && j > 0) break;
  }
  return x;
}

/** Student-t inverse CDF (quantile) with ν degrees of freedom. */
export function studentTInv(p: number, nu: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  // Map through the symmetric incomplete-beta relationship.
  const twoTail = p < 0.5 ? 2 * p : 2 * (1 - p);
  const x = invBetaI(twoTail, nu / 2, 0.5);
  const t = Math.sqrt((nu * (1 - x)) / x);
  return p < 0.5 ? -t : t;
}
