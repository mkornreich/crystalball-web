/**
 * Crystal Ball's own numerical kernels, reproduced operation-for-operation so
 * the distributions built on them return the same doubles the real engine
 * does (Crystal Ball 11.1.3, SharedMath `OcbMath` / `Combinatorics`).
 *
 * These are deliberately *not* the most accurate algorithms available — e.g.
 * the incomplete gamma stops at a relative step of 5e-16 and the Lanczos
 * log-gamma has six terms — because matching Crystal Ball's numbers, including
 * its rounding and its approximations, is the point. The textbook versions
 * live in special.ts and are still used for densities and moments.
 */

import * as libm from './libm';

/** Crystal Ball's "effectively zero" / "effectively one" probability guards. */
export const ALMOST_0 = 5e-16;
export const ALMOST_1 = 0.9999999999999994;
/** Crystal Ball's stand-ins for ±infinity and for an error value. */
export const VAL_MAX = 1.11e307;
export const VAL_ERR = 9e307;
/** Integer clamp used by every discrete distribution. */
export const D_CUT = 2e9;
/** Smallest probability InverseNormal accepts before it saturates. */
export const NORMAL_P_MIN = 9.009009009009009e-308;

const SQRT_TWO_PI = 2.5066282746310007;
const SQRT2 = 1.4142135623730951;
const INVERSE_EXP_TWO = 0.1353352832366127;

/** Clamp `x` into [min, max]; NaN passes through, as in OcbMath.LimitReal. */
export function limitReal(x: number, min: number, max: number): number {
  if (x > max) return max;
  if (x < min) return min;
  return x;
}

export function sqrtx(x: number): number {
  return x <= 0 ? 0 : Math.sqrt(x);
}

/** C# `(int)x` — truncation toward zero, wrapped to 32 bits. */
export function toInt(x: number): number {
  return x | 0;
}

function polevl(x: number, coef: readonly number[], n: number): number {
  let ans = coef[0];
  for (let i = 1; i <= n; i++) ans = ans * x + coef[i];
  return ans;
}

function p1evl(x: number, coef: readonly number[], n: number): number {
  let ans = x + coef[0];
  for (let i = 1; i < n; i++) ans = ans * x + coef[i];
  return ans;
}

// Cephes ndtri coefficients, as embedded in OcbMath.
const P0 = [-59.96335010141079, 98.00107541859997, -56.67628574690703, 13.931260938727968, -1.2391658386738125];
const Q0 = [1.9544885833814176, 4.676279128988815, 86.36024213908905, -225.46268785411937, 200.26021238006066, -82.03722561683334, 15.90562251262117, -1.1833162112133];
const P1 = [4.0554489230596245, 31.525109459989388, 57.16281922464213, 44.08050738932008, 14.684956192885803, 2.1866330685079025, -0.1402560791713545, -0.03504246268278482, -0.0008574567851546854];
const Q1 = [15.779988325646675, 45.39076351288792, 41.3172038254672, 15.04253856929075, 2.504649462083094, -0.14218292285478779, -0.03808064076915783, -0.0009332594808954574];
const P2 = [3.2377489177694603, 6.915228890689842, 3.9388102529247444, 1.3330346081580755, 0.20148538954917908, 0.012371663481782003, 0.00030158155350823543, 2.6580697468673755e-6, 6.239745391849833e-9];
const Q2 = [6.02427039364742, 3.6798356385616087, 1.3770209948908132, 0.21623699359449663, 0.013420400608854318, 0.00032801446468212774, 2.8924786474538068e-6, 6.790194080099813e-9];

/** Standard normal inverse CDF (Cephes ndtri), OcbMath.InverseNormal. */
export function inverseNormal(p: number): number {
  if (p === 0.5) return 0;
  p = limitReal(p, NORMAL_P_MIN, ALMOST_1);
  let negate = true;
  if (p > 0.8646647167633873) {
    p = 1 - p;
    negate = false;
  }
  if (p > INVERSE_EXP_TWO) {
    p -= 0.5;
    const y2 = p * p;
    const x = p + p * ((y2 * polevl(y2, P0, 4)) / p1evl(y2, Q0, 8));
    return x * SQRT_TWO_PI;
  }
  const x = Math.sqrt(-2 * libm.log(p));
  const x0 = x - libm.log(x) / x;
  const z = 1 / x;
  const x1 = x < 8 ? (z * polevl(z, P1, 8)) / p1evl(z, Q1, 8) : (z * polevl(z, P2, 8)) / p1evl(z, Q2, 8);
  const r = x0 - x1;
  return negate ? -r : r;
}

/** Six-term Lanczos log-gamma for z >= 1. */
function lanczos(z: number): number {
  const x = z - 1;
  let tmp = x + 5.5;
  tmp = (x + 0.5) * libm.log(tmp) - tmp;
  const ser =
    1 +
    76.18009172947146 / (x + 1) -
    86.50532032941678 / (x + 2) +
    24.01409824083091 / (x + 3) -
    1.231739572450155 / (x + 4) +
    0.001208650973866179 / (x + 5) -
    5.395239384953e-6 / (x + 6);
  return tmp + libm.log(SQRT_TWO_PI * ser);
}

export function gammln(z: number): number {
  return z >= 1 ? lanczos(z) : lanczos(z + 1) - libm.log(z);
}

/** Series for the lower regularized incomplete gamma P(a, x). */
function gser(a: number, x: number): number {
  if (x <= 0) return 0;
  let ap = a;
  let sum = 1 / a;
  let del = sum;
  while (Math.abs(del) > Math.abs(sum) * ALMOST_0) {
    ap += 1;
    del = (del * x) / ap;
    sum += del;
  }
  if (sum === 0) return 0;
  return sum * libm.exp(-x + a * libm.log(x) - gammln(a));
}

/** Continued fraction for the upper regularized incomplete gamma Q(a, x). */
function gcf(a: number, x: number): number {
  let g = 1;
  let gold = 0;
  let a0 = 1;
  let a1 = x;
  let b0 = 0;
  let b1 = 1;
  let fac = 1;
  let n = 1;
  while (Math.abs((g - gold) / g) > ALMOST_0) {
    gold = g;
    const ana = n - a;
    a0 = (a1 + a0 * ana) * fac;
    b0 = (b1 + b0 * ana) * fac;
    const anf = n * fac;
    a1 = x * a0 + anf * a1;
    b1 = x * b0 + anf * b1;
    if (a1 !== 0) {
      fac = 1 / a1;
      g = b1 * fac;
    }
    n += 1;
  }
  return libm.exp(-x + a * libm.log(x) - gammln(a)) * g;
}

export function gammp(a: number, x: number): number {
  return x < a + 1 ? gser(a, x) : 1 - gcf(a, x);
}

export function gammq(a: number, x: number): number {
  if (x < 0 || a <= 0) return 0;
  return x < a + 1 ? 1 - gser(a, x) : gcf(a, x);
}

export function erfc(x: number): number {
  x = limitReal(x, -15, 15);
  return x < 0 ? 1 + gammp(0.5, x * x) : gammq(0.5, x * x);
}

/** Standard normal CDF the way every Crystal Ball distribution computes it. */
export function normalCdf(z: number): number {
  return 1 - 0.5 * erfc(z / SQRT2);
}

/** Continued fraction for the incomplete beta (Numerical Recipes betacf, ≤100 terms). */
export function betaCf(a: number, b: number, x: number): number {
  let am = 1;
  let bm = 1;
  let az = 1;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let bz = 1 - (qab * x) / qap;
  for (let m = 1; m <= 100; m++) {
    const em = m;
    const tem = em + em;
    let d = (em * (b - m) * x) / ((qam + tem) * (a + tem));
    const ap = az + d * am;
    const bp = bz + d * bm;
    d = (-(a + em) * (qab + em) * x) / ((a + tem) * (qap + tem));
    const app = ap + d * az;
    const bpp = bp + d * bz;
    const aold = az;
    am = ap / bpp;
    bm = bp / bpp;
    az = app / bpp;
    bz = 1;
    if (Math.abs(az - aold) < ALMOST_0 * Math.abs(az)) break;
  }
  return az;
}

/** Regularized incomplete beta I_x(a, b), OcbMath.BetaInc. */
export function betaInc(a: number, b: number, x: number): number {
  const bt =
    x <= ALMOST_0 || x >= ALMOST_1
      ? 0
      : libm.exp(gammln(a + b) - gammln(a) - gammln(b) + a * libm.log(x) + b * libm.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betaCf(a, b, x)) / a;
  return 1 - (bt * betaCf(b, a, 1 - x)) / b;
}

/** Binomial coefficient by the running product Crystal Ball uses. */
export function nCombR(n: number, r: number): number {
  if (r > n - r) r = n - r;
  let num = 1;
  let i = n;
  let j = r;
  while (i > n - r) {
    num *= i;
    num /= j;
    i--;
    j--;
  }
  return num;
}

const POW10 = Array.from({ length: 16 }, (_, i) => Number(`1e${i}`));

/**
 * .NET `Math.Round(value, digits)`: scale, round half to even, unscale.
 * (Matches the .NET Core implementation for |value| < 1e16.)
 */
export function roundDotNet(value: number, digits: number): number {
  if (Math.abs(value) >= 1e16) return value;
  const p = POW10[digits];
  const scaled = value * p;
  let r = Math.round(scaled);
  // Math.round rounds .5 up; .NET rounds it to the even neighbour.
  if (r - scaled === 0.5 && r % 2 !== 0) r -= 1;
  return r / p;
}
