/**
 * The C library's math functions, bit for bit: ports of glibc 2.43's exp, log,
 * pow, log10, sin, cos, tan, atan and asin as Ubuntu's x86-64 libm runs them —
 * the variants compiled with FMA (-mfma -mavx2), which is what .NET's Math
 * calls on Linux, so what Crystal Ball's engine computes there. V8's Math
 * functions (fdlibm ports) differ from these in the last bit for 1–10% of
 * inputs, which is enough to move Crystal Ball's results.
 *
 * Each function follows glibc's source with the fused multiply-adds GCC formed
 * (read from its optimized GIMPLE, and from the system's machine code where
 * the distribution's compiler fused differently), using an exact software
 * fma. Tables are glibc's own (libm-data.ts). Checked against the system
 * libm on millions of inputs per function (tools/libm-check.ts).
 *
 * Derived from the GNU C Library, copyright the Free Software Foundation and
 * contributors (exp, log and pow by Arm Ltd.; sin, tan, atan and asin from
 * IBM's Accurate Mathematical Library), licensed under the LGPL 2.1 or later
 * and used here under the GPL 3.0 or later, as the LGPL's section 3 allows.
 */

import * as T from './libm-data';

/* ------------------------------ bit access ----------------------------- */

const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer); // little-endian: [0] = low word, [1] = high word

const hiWord = (x: number) => {
  F64[0] = x;
  return U32[1];
};
const fromWords = (hi: number, lo: number) => {
  U32[1] = hi;
  U32[0] = lo;
  return F64[0];
};

/* ------------------------------- exact fma ------------------------------ */

const SPLIT = 134217729; // 2^27 + 1
const TWO_M900 = 2 ** -900;
const TWO_900 = 2 ** 900;
void TWO_900;

/** a·b + c with a single rounding (IEEE fusedMultiplyAdd). */
export function fma(a: number, b: number, c: number): number {
  const p = a * b;
  const ap = Math.abs(a);
  const bp = Math.abs(b);
  const pp = Math.abs(p);
  if (!(ap < TWO_900 && bp < TWO_900 && pp > TWO_M900 && pp < TWO_900) || !Number.isFinite(c))
    return fmaSlow(a, b, c);
  // Dekker: a·b = p + e exactly.
  let t = SPLIT * a;
  const ah = t - (t - a);
  const al = a - ah;
  t = SPLIT * b;
  const bh = t - (t - b);
  const bl = b - bh;
  const e = ah * bh - p + ah * bl + al * bh + al * bl;
  // Boldo–Melquiond: c + p = th + tl exactly; result = RN(th + RO(tl + e)).
  const th = c + p;
  const bv = th - c;
  const tl = c - (th - bv) + (p - bv);
  const s = tl + e;
  const bw = s - tl;
  const err = tl - (s - bw) + (e - bw);
  if (err !== 0) {
    F64[0] = s;
    if ((U32[0] & 1) === 0) {
      // Round to odd: step to the odd neighbour on the side of the error.
      const up = (err > 0) === (s > 0);
      let lo = U32[0];
      let hi = U32[1];
      if (up) {
        lo = (lo + 1) >>> 0;
        if (lo === 0) hi = (hi + 1) >>> 0;
      } else {
        if (lo === 0) hi = (hi - 1) >>> 0;
        lo = (lo - 1) >>> 0;
      }
      U32[0] = lo;
      U32[1] = hi;
      return th + F64[0];
    }
  }
  return th + s;
}

/** Exact fma by integer arithmetic, for the ranges the fast path doesn't cover. */
function fmaSlow(a: number, b: number, c: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return a * b + c;
  if (a === 0 || b === 0) return a * b + c;
  const [ma, ea] = decompose(a);
  const [mb, eb] = decompose(b);
  let m = ma * mb;
  let e = ea + eb;
  if (c !== 0) {
    const [mc, ec] = decompose(c);
    if (ec < e) {
      m <<= BigInt(e - ec);
      e = ec;
      m += mc;
    } else m += mc << BigInt(ec - e);
  }
  if (m === 0n) return (a * b) + c; // exact zero: sign as IEEE addition gives it
  return roundBig(m, e);
}

/** x = m·2^e with integer m (signed BigInt). */
function decompose(x: number): [bigint, number] {
  F64[0] = x;
  const hi = U32[1];
  const lo = U32[0];
  const ex = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e: number;
  if (ex === 0) e = -1074;
  else {
    m |= 1n << 52n;
    e = ex - 1075;
  }
  return [hi >>> 31 ? -m : m, e];
}

/** Round m·2^e to the nearest double (ties to even). */
function roundBig(m: bigint, e: number): number {
  const neg = m < 0n;
  if (neg) m = -m;
  const bits = m.toString(2).length;
  // Keep 53 significant bits, or fewer in the subnormal range.
  let shift = bits - 53;
  if (e + shift < -1074) shift = -1074 - e;
  if (shift > 0) {
    const big = BigInt(shift);
    const q = m >> big;
    const rem = m - (q << big);
    const half = 1n << (big - 1n);
    m = q + (rem > half || (rem === half && (q & 1n) === 1n) ? 1n : 0n);
    e += shift;
  }
  const v = Number(m) * 2 ** e; // m < 2^54 and e in range: exact up to the final overflow check
  const r = e > 970 ? Number(m) * 2 ** 970 * 2 ** (e - 970) : e < -1000 ? Number(m) * 2 ** (e + 1000) * 2 ** -1000 : v;
  return neg ? -r : r;
}

/* ---------------------------------- exp --------------------------------- */

/** glibc e_exp.c (FMA build). */
export function exp(x: number): number {
  F64[0] = x;
  const xhi = U32[1];
  let abstop = (xhi >>> 20) & 0x7ff;
  if (((abstop - 969) >>> 0) > 62) {
    if (abstop - 969 < 0) return x + 1.0;
    if (abstop > 1032) {
      if (x === -Infinity) return 0.0;
      if (abstop === 2047) return x + 1.0;
      return xhi >>> 31 ? 0.0 : Infinity; // __math_uflow / __math_oflow
    }
    abstop = 0;
  }
  const kd0 = fma(T.EXP_INVLN2N, x, T.EXP_SHIFT);
  F64[0] = kd0;
  const ki = U32[0];
  const kd = kd0 - T.EXP_SHIFT;
  const r = fma(T.EXP_NEGLN2LON, kd, fma(T.EXP_NEGLN2HIN, kd, x));
  const i = ki & 127;
  const topHi = ki << 13; // (ki << 45) has only a high word
  const r2 = r * r;
  const t18 = r + T.EXP_TAIL[i];
  const t24 = fma(fma(T.EXP_POLY[1], r, T.EXP_POLY[0]), r2, t18);
  const tmp = fma(r2 * r2, fma(T.EXP_POLY[3], r, T.EXP_POLY[2]), t24);
  const sHi = (T.EXP_SBITS_HI[i] + topHi) >>> 0;
  const sLo = T.EXP_SBITS_LO[i];
  if (abstop === 0) return expSpecial(tmp, sHi, sLo, ki);
  const scale = fromWords(sHi, sLo);
  return fma(tmp, scale, scale);
}

function expSpecial(tmp: number, sHi: number, sLo: number, ki: number): number {
  if ((ki & 0x80000000) === 0) {
    const scale = fromWords((sHi - (1009 << 20)) >>> 0, sLo);
    return fma(tmp, scale, scale) * 5.486124068793689e303; // 0x1p1009
  }
  const scale = fromWords((sHi + (1022 << 20)) >>> 0, sLo);
  const t = tmp * scale;
  let y = scale + t;
  if (y < 1.0) {
    const lo0 = t + (scale - y);
    const hi = y + 1.0;
    const lo = lo0 + (y + (1.0 - hi));
    y = hi + lo - 1.0;
    if (y === 0.0) return 0.0;
  }
  return y * 2.2250738585072014e-308; // 0x1p-1022
}

/* ---------------------------------- log --------------------------------- */

const LN2_LO_OFF = 0x3fe60000; // high word of e_log.c's OFF

/** glibc e_log.c (FMA build). */
export function log(x: number): number {
  if (x >= 0.9375 && x < 1.064697265625) {
    // |x - 1| small: 1 - 0x1p-4 <= x < 1 + 0.064697265625.
    if (x === 1.0) return 0;
    const B = T.LOG_POLY1;
    const r = x - 1.0;
    const r2 = r * r;
    const r3 = r * r2;
    const p14 = fma(B[3], r2, fma(B[2], r, B[1]));
    const p21 = fma(B[6], r2, fma(B[5], r, B[4]));
    const p28 = fma(B[9], r2, fma(B[8], r, B[7]));
    const p35 = fma(fma(fma(B[10], r3, p28), r3, p21), r3, p14);
    const rhi = fma(-r, 134217728, fma(r, 134217728, r));
    const rlo = r - rhi;
    const t37 = rhi * rhi;
    const hi = fma(t37, B[0], r);
    const lo113 = fma(t37, B[0], r - hi);
    const lo = fma(B[0] * rlo, r + rhi, lo113);
    return hi + fma(p35, r3, lo);
  }
  F64[0] = x;
  let ixh = U32[1];
  let ixl = U32[0];
  const top = ixh >>> 16;
  if (((top - 16) >>> 0) > 32735) {
    if ((ixh & 0x7fffffff) === 0 && ixl === 0) return -Infinity; // __math_divzero(1)
    if (x === Infinity) return x;
    if (top & 0x8000 || (top & 0x7ff0) === 0x7ff0) return (x - x) / (x - x); // __math_invalid
    F64[0] = x * 4503599627370496; // subnormal: scale by 2^52
    ixh = (U32[1] - (52 << 20)) >>> 0;
    ixl = U32[0];
  }
  const tmph = (ixh - LN2_LO_OFF) | 0;
  const i = (tmph >>> 13) & 127;
  const k = tmph >> 20;
  const z = fromWords((ixh - (tmph & 0xfff00000)) >>> 0, ixl);
  const invc = T.LOG_INVC[i];
  const logc = T.LOG_LOGC[i];
  const A = T.LOG_POLY;
  const r = fma(invc, z, -1.0);
  const kd = k;
  const w = fma(T.LOG_LN2HI, kd, logc);
  const hi = r + w;
  const lo = fma(T.LOG_LN2LO, kd, w - hi + r);
  const r2 = r * r;
  const t64 = fma(A[0], r2, lo);
  const t65 = r * r2;
  const t75 = fma(fma(A[4], r, A[3]), r2, fma(A[2], r, A[1]));
  return fma(t65, t75, t64) + hi;
}

/* ---------------------------------- pow --------------------------------- */

const POW_OFF = 0x3fe69555; // high word of e_pow.c's OFF (low word 0)
const SIGN_BIAS = 0x800 << 7;

const bitsOf = (x: number) => {
  F64[0] = x;
  return (BigInt(U32[1]) << 32n) | BigInt(U32[0]);
};
const ofBits = (b: bigint) => fromWords(Number((b >> 32n) & 0xffffffffn), Number(b & 0xffffffffn));
const INF_BITS = 0x7ff0000000000000n;
const ONE_BITS = 0x3ff0000000000000n;
const M64 = 0xffffffffffffffffn;

/** 0 if not an integer, 1 if odd, 2 if even (e_pow.c checkint). */
function checkint(iy: bigint): number {
  const e = Number((iy >> 52n) & 0x7ffn);
  if (e < 0x3ff) return 0;
  if (e > 0x3ff + 52) return 2;
  const sh = BigInt(0x3ff + 52 - e);
  if (iy & ((1n << sh) - 1n)) return 0;
  if (iy & (1n << sh)) return 1;
  return 2;
}
const zeroinfnan = (i: bigint) => ((2n * i - 1n) & M64) >= 2n * INF_BITS - 1n;

/** glibc e_pow.c (FMA build). */
export function pow(x: number, y: number): number {
  let signBias = 0;
  F64[0] = x;
  let ixh = U32[1];
  let ixl = U32[0];
  F64[0] = y;
  const iyh = U32[1];
  let topx = ixh >>> 20;
  const topy = iyh >>> 20;
  if (((topx - 1) >>> 0) >= 0x7fe || (((topy & 0x7ff) - 0x3be) >>> 0) >= 0x80) {
    const ix0 = bitsOf(x);
    const iy = bitsOf(y);
    let ix = ix0;
    if (zeroinfnan(iy)) {
      if (((2n * iy) & M64) === 0n) return 1.0; // (signaling NaNs aside)
      if (ix === ONE_BITS) return 1.0;
      if (((2n * ix) & M64) > 2n * INF_BITS || ((2n * iy) & M64) > 2n * INF_BITS) return x + y;
      if (((2n * ix) & M64) === 2n * ONE_BITS) return 1.0;
      if ((((2n * ix) & M64) < 2n * ONE_BITS) === !(iy >> 63n)) return 0.0;
      return y * y;
    }
    if (zeroinfnan(ix)) {
      let x2 = x * x;
      if (ix >> 63n && checkint(iy) === 1) {
        x2 = -x2;
        signBias = 1;
      }
      if (((2n * ix) & M64) === 0n && iy >> 63n) return signBias ? -Infinity : Infinity; // __math_divzero
      return iy >> 63n ? 1 / x2 : x2;
    }
    if (ix >> 63n) {
      const yint = checkint(iy);
      if (yint === 0) return (x - x) / (x - x); // __math_invalid
      if (yint === 1) signBias = SIGN_BIAS;
      ix &= 0x7fffffffffffffffn;
      topx &= 0x7ff;
    }
    if ((((topy & 0x7ff) - 0x3be) >>> 0) >= 0x80) {
      if (ix === ONE_BITS) return 1.0;
      if ((topy & 0x7ff) < 0x3be) return ix > ONE_BITS ? 1.0 + y : 1.0 - y;
      return (ix > ONE_BITS) === topy < 0x800 ? Infinity : 0.0; // __math_oflow(0) / __math_uflow(0)
    }
    if (topx === 0) {
      ix = bitsOf(x * 4503599627370496) & 0x7fffffffffffffffn;
      ix = (ix - (52n << 52n)) & M64;
    }
    ixh = Number(ix >> 32n);
    ixl = Number(ix & 0xffffffffn);
  }
  // log_inline
  const tmph = (ixh - POW_OFF) | 0;
  const i = (tmph >>> 13) & 127;
  const k = tmph >> 20;
  const z = fromWords((ixh - (tmph & 0xfff00000)) >>> 0, ixl);
  const kd = k;
  const invc = T.POW_INVC[i];
  const logc = T.POW_LOGC[i];
  const logctail = T.POW_LOGCTAIL[i];
  const A = T.POW_POLY;
  const r = fma(z, invc, -1.0);
  const t1 = fma(kd, T.POW_LN2HI, logc);
  const t2 = r + t1;
  const lo1 = fma(kd, T.POW_LN2LO, logctail);
  const lo2 = r + (t1 - t2);
  const ar = r * A[0];
  const ar2 = r * ar;
  const ar3 = r * ar2;
  const hi = t2 + ar2;
  const lo3 = fma(r, ar, -ar2);
  const lo4 = ar2 + (t2 - hi);
  const t216 = fma(r, A[2], A[1]);
  const t220 = fma(r, A[4], A[3]);
  const t224 = fma(r, A[6], A[5]);
  const t228 = fma(ar2, fma(ar2, t224, t220), t216);
  const lo = fma(ar3, t228, lo4 + (lo3 + (lo1 + lo2)));
  const ly = hi + lo;
  const ehi = y * ly;
  // exp_inline(ehi, elo, signBias)
  F64[0] = ehi;
  const ehiHi = U32[1];
  let abstop = (ehiHi >>> 20) & 0x7ff;
  if (((abstop - 969) >>> 0) > 62) {
    if (abstop - 969 < 0) {
      const one = ehi + 1.0;
      return signBias ? -one : one;
    }
    if (abstop > 1032) {
      if (ehiHi >>> 31) return signBias ? -0.0 : 0.0; // __math_uflow
      return signBias ? -Infinity : Infinity; // __math_oflow
    }
    abstop = 0;
  }
  const tail = lo + (hi - ly);
  const elo = fma(y, tail, fma(y, ly, -ehi));
  const kd0 = fma(ehi, T.EXP_INVLN2N, T.EXP_SHIFT);
  F64[0] = kd0;
  const ki = U32[0];
  const ekd = kd0 - T.EXP_SHIFT;
  const er = elo + fma(ekd, T.EXP_NEGLN2LON, fma(ekd, T.EXP_NEGLN2HIN, ehi));
  const j = ki & 127;
  const topHi = (ki + signBias) << 13;
  const r2 = er * er;
  const t162 = fma(r2, fma(er, T.EXP_POLY[1], T.EXP_POLY[0]), er + T.EXP_TAIL[j]);
  const tmp = fma(r2 * r2, fma(er, T.EXP_POLY[3], T.EXP_POLY[2]), t162);
  const sHi = (T.EXP_SBITS_HI[j] + topHi) >>> 0;
  const sLo = T.EXP_SBITS_LO[j];
  if (abstop === 0) return powSpecial(tmp, sHi, sLo, ki);
  const scale = fromWords(sHi, sLo);
  return fma(tmp, scale, scale);
}

function powSpecial(tmp: number, sHi: number, sLo: number, ki: number): number {
  if ((ki & 0x80000000) === 0) {
    const scale = fromWords((sHi - (1009 << 20)) >>> 0, sLo);
    return fma(tmp, scale, scale) * 5.486124068793689e303;
  }
  const sb = (sHi + (1022 << 20)) >>> 0;
  const scale = fromWords(sb, sLo);
  const t = tmp * scale;
  let y = scale + t;
  if (Math.abs(y) < 1.0) {
    const one = y < 0.0 ? -1.0 : 1.0;
    const lo0 = t + (scale - y);
    const hi = y + one;
    const lo = lo0 + (y + (one - hi));
    y = hi + lo - one;
    if (y === 0.0) y = sb >>> 31 ? -0.0 : 0.0;
  }
  return y * 2.2250738585072014e-308;
}

/* --------------------------------- log10 -------------------------------- */

/** glibc e_log10.c (built without FMA; calls the FMA log above). */
export function log10(x: number): number {
  F64[0] = x;
  let hxh = U32[1];
  let hxl = U32[0];
  let k = 0;
  if ((hxh | 0) < 0x00100000) {
    if ((hxh & 0x7fffffff) === 0 && hxl === 0) return -18014398509481984 / Math.abs(x);
    if ((hxh | 0) < 0) return (x - x) / (x - x);
    k -= 54;
    x *= 18014398509481984; // 2^54
    F64[0] = x;
    hxh = U32[1];
    hxl = U32[0];
  }
  if (hxh >= 0x7ff00000) return x + x;
  k += (hxh >>> 20) - 1023;
  const i = k < 0 ? 1 : 0;
  const m = fromWords(((hxh & 0x000fffff) | ((0x3ff - i) << 20)) >>> 0, hxl);
  const y = k + i;
  const z = y * 3.69423907715893078616e-13 + 4.34294481903251816668e-1 * log(m);
  return z + y * 3.01029995663611771306e-1;
}

/* ------------------------------- sin (IBM) ------------------------------ */

// usncs.h / s_sin.c constants.
const S1 = -0.16666666666666666;
const S2 = 0.008333333333332329;
const S3 = -0.00019841269834414642;
const S4 = 2.755729806860771e-06;
const S5 = -2.5022014848318398e-08;
const SN3 = -1.666666666666648810579687278732308186590671539306640625e-1;
const SN5 = 8.33333214285722316538862486368088866584002971649169921875e-3;
const CS2 = 0.5;
const CS4 = -4.1666666666666442309097106999615789391100406646728515625e-2;
const CS6 = 1.38888874007937605271900682879504529410041868686676025391e-3;
const BIG = 52776558133248.0;
const HP0 = 1.5707963267948966;
const HP1 = 6.123233995736766e-17;
const MP1 = 1.5707963407039642;
const MP2 = -1.3909067564377153e-08;
const PP3 = -4.97899623147991e-17;
const PP4 = -1.9034889620193266e-25;
const HPINV = 0.6366197723675814;
const TOINT = 6755399441055744.0;

const copysign = (a: number, b: number) => (b < 0 || Object.is(b, -0) ? -Math.abs(a) : Math.abs(a));
const lowWord = (x: number) => {
  F64[0] = x;
  return U32[0];
};

/** The table half of do_sin: |a| ≥ 0.126 reduced against __sincostab, result signed like `signOf`. */
function sinTable(ax: number, dx: number, signOf: number): number {
  const u = ax + BIG;
  const x = ax - (u - BIG);
  const xx = x * x;
  const s = x + fma(x * xx, fma(xx, SN5, SN3), dx);
  const c = fma(x, dx, xx * fma(xx, fma(xx, CS6, CS4), CS2));
  const k = lowWord(u) << 2;
  const t = T.IBM_SINCOSTAB;
  const sn = t[k];
  const ssn = t[k + 1];
  const cs = t[k + 2];
  const ccs = t[k + 3];
  const cor = fma(s, cs, fma(-c, sn, fma(s, ccs, ssn)));
  return copysign(sn + cor, signOf);
}

/** do_sin(a, da) as inlined after a range reduction. */
function doSin(a: number, da: number): number {
  const ax = Math.abs(a);
  if (ax < 0.126) {
    const xx = a * a;
    const p = fma(xx, fma(xx, fma(xx, fma(xx, S5, S4), S3), S2), S1);
    return fma(xx, fma(p, a, -(da * 0.5)), da) + a;
  }
  return sinTable(ax, a <= 0 ? -da : da, a);
}

/** do_cos(a, da). */
function doCos(a: number, da: number): number {
  const dx = a < 0 ? -da : da;
  const ax = Math.abs(a);
  const u = ax + BIG;
  const x = ax - (u - BIG) + dx;
  const xx = x * x;
  const s = fma(x * xx, fma(xx, SN5, SN3), x);
  const c = xx * fma(xx, fma(xx, CS6, CS4), CS2);
  const k = lowWord(u) << 2;
  const t = T.IBM_SINCOSTAB;
  const sn = t[k];
  const ssn = t[k + 1];
  const cs = t[k + 2];
  const ccs = t[k + 3];
  const cor = fma(-s, sn, fma(-c, cs, fma(-s, ssn, ccs)));
  return cs + cor;
}

/** reduce_sincos: x = n·π/2 + (a + da), |x| < 105414350. */
function reduceSinCos(x: number): [number, number, number] {
  const t = fma(x, HPINV, TOINT);
  const xn = t - TOINT;
  const y = fma(-xn, MP2, fma(-xn, MP1, x));
  const n = lowWord(t);
  const t2 = fma(-xn, PP3, y);
  const db0 = fma(-xn, PP3, y - t2);
  const b = fma(-xn, PP4, t2);
  const db = db0 + fma(-xn, PP4, t2 - b);
  return [b, db, n];
}

/** glibc s_sin.c sin (FMA build). */
export function sin(x: number): number {
  F64[0] = x;
  const k = U32[1] & 0x7fffffff;
  if (k < 0x3e500000) return x;
  if (k < 0x3feb6000) {
    const ax = Math.abs(x);
    if (ax < 0.126) {
      const xx = x * x;
      const p = fma(xx, fma(xx, fma(xx, fma(xx, S5, S4), S3), S2), S1);
      return x + fma(xx, fma(x, p, -0.0), 0.0);
    }
    return sinTable(ax, x <= 0 ? -0.0 : 0.0, x);
  }
  if (k < 0x400368fd) return copysign(doCos(HP0 - Math.abs(x), HP1), x);
  let a: number;
  let da: number;
  let n: number;
  if (k < 0x419921fb) [a, da, n] = reduceSinCos(x);
  else if (k < 0x7ff00000) [a, da, n] = branred(x);
  else return x / x;
  const r = n & 1 ? doCos(a, da) : doSin(a, da);
  return n & 2 ? -r : r;
}

/* ------------------------------- branred -------------------------------- */

const SPLIT_CN = 134217729;
const T576 = 2 ** 576;
const TM600 = 2 ** -600;
const TM24 = 2 ** -24;
const BIG1 = 27021597764222976;
const BR_MP2 = -1.3909067675399456e-8; // branred.h's mp2 (0xBE4DDE9740000000)

/** glibc branred.c (no FMA): x = n·π/2 + (a + aa), returns [a, aa, n mod 4]. */
export function branred(xIn: number): [number, number, number] {
  const toverp = T.IBM_TOVERP;
  const x = xIn * TM600;
  let t = x * SPLIT_CN;
  const x1 = t - (t - x);
  const x2 = x - x1;
  const part = (xp: number): [number, number, number] => {
    const r = new Array<number>(6);
    let sum = 0;
    let k = (hiWord(xp) >>> 20) & 2047;
    k = Math.trunc((k - 450) / 24);
    if (k < 0) k = 0;
    let gor = fromWords((hiWord(T576) - ((k * 24) << 20)) >>> 0, 0);
    for (let i = 0; i < 6; i++) {
      r[i] = xp * toverp[k + i] * gor;
      gor *= TM24;
    }
    for (let i = 0; i < 3; i++) {
      const s = r[i] + TOINT - TOINT;
      sum += s;
      r[i] -= s;
    }
    let tt = 0;
    for (let i = 0; i < 6; i++) tt += r[5 - i];
    let bb = r[0] - tt + r[1] + r[2] + r[3] + r[4] + r[5];
    let s = tt + TOINT - TOINT;
    sum += s;
    tt -= s;
    const b = tt + bb;
    bb = tt - b + bb;
    s = sum + BIG1 - BIG1;
    sum -= s;
    return [b, bb, sum];
  };
  const [b1, bb1, sum1] = part(x1);
  const [b2, bb2, sum2] = part(x2);
  let sum = sum1 + sum2;
  let b = b1 + b2;
  let bb = Math.abs(b1) > Math.abs(b2) ? b1 - b + b2 : b2 - b + b1;
  if (b > 0.5) {
    b -= 1.0;
    sum += 1.0;
  } else if (b < -0.5) {
    b += 1.0;
    sum -= 1.0;
  }
  let s = b + (bb + bb1 + bb2);
  t = b - s + bb + (bb1 + bb2);
  b = s * SPLIT_CN;
  const t1 = b - (b - s);
  const t2 = s - t1;
  b = s * HP0;
  bb = t1 * MP1 - b + t1 * BR_MP2 + t2 * MP1 + (t2 * BR_MP2 + s * HP1 + t * HP0);
  s = b + bb;
  t = b - s + bb;
  return [s, t, Math.trunc(sum) & 3];
}

/* ------------------------------- tan (IBM) ------------------------------ */

const TD3 = 3.33333333333333314829616256247390992939472198486328125e-1;
const TD5 = 1.33333333333267300968572044439497403800487518310546875e-1;
const TD7 = 5.3968254110954329283433850150686339475214481353759765625e-2;
const TD9 = 2.1869380598167252605090737915816134773194789886474609375e-2;
const TD11 = 8.8965463495349235423237388431516592390835285186767578125e-3;
const TE0 = 3.33333333333225401151622691031661815941333770751953125e-1;
const TE1 = 1.333335492066991256887575900691444985568523406982421875e-1;
const TG1 = 1.2589993048095493577420711517333984375e-8;
const TG2 = 6.07999861240386962890625e-2; // also gy2
const TG3 = 7.8699970245361328125e-1;
const TMP3 = -4.97899625051479936836749653361622010187153937661209968102e-17;

const tanPoly = (a2: number) => fma(a2, fma(a2, fma(a2, fma(a2, TD11, TD9), TD7), TD5), TD3);

/** The common tail of tan's reduced cases: tan or −cot of a + da (n odd → −cot). */
function tanTail(a: number, da: number, n: number): number {
  let sy = 1.0;
  let ya = a;
  let yya = da;
  if (a < 0.0) {
    sy = -1.0;
    ya = -a;
    yya = -da;
  }
  if (ya <= TG2) {
    const a2 = a * a;
    const t2 = fma(a * a2, tanPoly(a2), da);
    const b = a + t2;
    if (!n) return b;
    // EADD then DIV2(1, 0, b, db): -1/(a + t2) in double length.
    const db = Math.abs(a) > Math.abs(t2) ? a - b + t2 : t2 - b + a;
    const t1 = 1.0 / b;
    const t3 = t1 * b;
    const t4 = fma(t1, b, -t3);
    const t2b = fma(-db, t1, 1.0 - t3 - t4 + 0.0) / b;
    const c = t1 + t2b;
    const dc = t1 - c + t2b;
    return -(c + dc);
  }
  const i = Math.trunc(fma(ya, 256, -15.5));
  const z = yya + (ya - T.IBM_XFG[i * 4]);
  const z2 = z * z;
  const pz = fma(z * z2, fma(z2, TE1, TE0), z);
  const fi = T.IBM_XFG[i * 4 + 1];
  const gi = T.IBM_XFG[i * 4 + 2];
  const num = pz * (fi + gi);
  if (n) return -sy * (gi - num / (pz + fi));
  return sy * (fi + num / (gi - pz));
}

/** glibc s_tan.c tan (FMA build). */
export function tan(x: number): number {
  F64[0] = x;
  const ux = U32[1];
  if ((ux & 0x7ff00000) === 0x7ff00000) return x - x;
  const w = x < 0.0 ? -x : x;
  if (w <= TG1) return x;
  if (w <= TG2) {
    const x2 = x * x;
    return fma(x * x2, tanPoly(x2), x);
  }
  if (w <= TG3) {
    const i = Math.trunc(fma(w, 256, -15.5));
    const z = w - T.IBM_XFG[i * 4];
    const z2 = z * z;
    const s = x < 0.0 ? -1.0 : 1.0;
    const pz = fma(z * z2, fma(z2, TE1, TE0), z);
    const fi = T.IBM_XFG[i * 4 + 1];
    const gi = T.IBM_XFG[i * 4 + 2];
    return s * (fi + ((fi + gi) * pz) / (gi - pz));
  }
  if (w <= 25) {
    const t = fma(x, HPINV, TOINT);
    const xn = t - TOINT;
    const t1 = fma(-xn, MP2, fma(-xn, MP1, x));
    const n = lowWord(t) & 1;
    const a = fma(-xn, TMP3, t1);
    const da = fma(-xn, TMP3, t1 - a);
    return tanTail(a, da, n);
  }
  let a: number;
  let da: number;
  let n: number;
  if (w <= 1e8) {
    const t = fma(x, HPINV, TOINT);
    const xn = t - TOINT;
    const t1 = fma(-xn, MP2, fma(-xn, MP1, x));
    n = lowWord(t) & 1;
    const tt = fma(-xn, PP3, t1);
    const d1 = fma(-xn, PP3, t1 - tt);
    a = fma(-xn, PP4, tt);
    da = d1 + fma(-xn, PP4, tt - a);
  } else {
    const r = branred(x);
    a = r[0];
    da = r[1];
    n = r[2] & 1;
  }
  const s = a + da;
  const ss = Math.abs(a) > Math.abs(da) ? da + (a - s) : a + (da - s);
  return tanTail(s, ss, n);
}

/* ------------------------------ atan (IBM) ------------------------------ */

const AD3 = -3.33333333333333314829616256247390992939472198486328125e-1;
const AD5 = 1.999999999999885480495009915102855302393436431884765625e-1;
const AD7 = -1.428571428395316311732443637083633802831172943115234375e-1;
const AD9 = 1.1111109821886426540782366600979003123939037322998046875e-1;
const AD11 = -9.090424391727987274425260011412319727241992950439453125e-2;
const AD13 = 7.60183658438073617258368130933376960456371307373046875e-2;
const ATAN_A = 1.29047776908919331617653369903564453125e-8;
const ATAN_E = 5.805361265115136e15;
const HPI = 1.5707963267948965579989817342720925807952880859375;
const HPI1 = 6.12323399573676603586882014729198302312846062338790031898e-17;
const TWO52 = 4503599627370496;

const atanPoly = (v: number) => fma(v, fma(v, fma(v, fma(v, fma(v, AD13, AD11), AD9), AD7), AD5), AD3);

/** glibc s_atan.c atan (FMA build; the 16 ≤ |x| < 5.8e15 branch as Ubuntu's compiler fused it). */
export function atan(x: number): number {
  F64[0] = x;
  const ux = U32[1];
  if ((ux & 0x7ff00000) === 0x7ff00000 && ((ux & 0x000fffff) | U32[0]) !== 0) return x * 2.0;
  const u = x < 0 ? -x : x;
  if (u < 1) {
    if (u < 0.0625) {
      if (u < ATAN_A) return x;
      const v = x * x;
      return fma(x * v, atanPoly(v), x);
    }
    const i = Math.trunc(fma(u, 256, TWO52) - TWO52) - 16;
    const c = T.IBM_CIJ;
    const o = i * 7;
    const z = u - c[o];
    const yy = fma(z, fma(z, fma(z, fma(c[o + 6], z, c[o + 5]), c[o + 4]), c[o + 3]), c[o + 2]);
    return copysign(fma(z, yy, c[o + 1]), x);
  }
  if (u < 16) {
    const w = 1.0 / u;
    const t1 = w * u;
    const t2 = fma(w, u, -t1);
    const i = Math.trunc(fma(w, 256, TWO52) - TWO52) - 16;
    const c = T.IBM_CIJ;
    const o = i * 7;
    const z = fma(1.0 - t1 - t2, w, w - c[o]);
    const yy = fma(-z, fma(z, fma(z, fma(z, fma(c[o + 6], z, c[o + 5]), c[o + 4]), c[o + 3]), c[o + 2]), HPI1);
    return copysign(yy + (HPI - c[o + 1]), x);
  }
  if (u < ATAN_E) {
    const w = 1.0 / u;
    const v = w * w;
    const t1 = w * u;
    const t2 = fma(w, u, -t1);
    const p = atanPoly(v);
    const t3 = HPI - w;
    const cor = Math.abs(HPI) > Math.abs(w) ? HPI - t3 - w : HPI - (w + t3);
    const yy = fma(-(w * v), p, fma(-(1.0 - t1 - t2), w, cor + HPI1));
    return copysign(t3 + yy, x);
  }
  return x > 0 ? HPI : -HPI;
}

/* ------------------------------ asin (IBM) ------------------------------ */

const AF1 = 1.666666666666641039018514902636525221168994903564453125e-1;
const AF2 = 7.500000000261226873465858488998492248356342315673828125e-2;
const AF3 = 4.46428561421059744152017856322345323860645294189453125e-2;
const AF4 = 3.03821268582119309586975219872329034842550754547119140625e-2;
const AF5 = 2.23551211026525621650140607243884005583822727203369140625e-2;
const AF6 = 1.8138290340456504623478650728429784066975116729736328125e-2;
const RT0 = 9.9999999985999077356524367132806219160556793212890625e-1;
const RT1 = 4.999999994959554161511050551780499517917633056640625e-1;
const RT2 = 3.7501750086734519928910458475002087652683258056640625e-1;
const RT3 = 3.12523626554518652032044201405369676649570465087890625e-1;
const T24 = 16777216;

const asinF = (z: number) => fma(fma(fma(fma(fma(z, AF6, AF5), z, AF4), z, AF3), z, AF2), z, AF1);

/** One of asin's table intervals: Horner on asncs[n+2..top], then the constant and the value. */
function asinTable(x: number, pos: boolean, n: number, top: number): number {
  const c = T.IBM_ASNCS;
  const xx = (pos ? x : -x) - c[n];
  let acc = c[top];
  for (let j = top - 1; j >= n + 2; j--) acc = fma(acc, xx, c[j]);
  const p = fma(xx * xx, acc, c[top + 1]);
  const res = c[top + 2] + fma(c[n + 1], xx, p);
  return pos ? res : -res;
}

/** glibc e_asin.c asin (FMA build). */
export function asin(x: number): number {
  F64[0] = x;
  const m = U32[1] | 0;
  const lo = U32[0];
  const k = m & 0x7fffffff;
  const pos = m > 0;
  if (k < 0x3e500000) return x;
  if (k < 0x3fc00000) {
    const x2 = x * x;
    return fma(asinF(x2), x * x2, x);
  }
  if (k < 0x3fe00000) {
    const n = k < 0x3fd00000 ? ((k >> 15) & 31) * 11 : ((k >> 14) & 63) * 11 + 352;
    return asinTable(x, pos, n, n + 6);
  }
  if (k < 0x3fe80000) {
    const n = 1056 + ((k >> 11) & 508) * 3;
    return asinTable(x, pos, n, n + 7);
  }
  if (k < 0x3fed8000) {
    const n = 992 + ((k >> 13) & 127) * 13;
    return asinTable(x, pos, n, n + 8);
  }
  if (k < 0x3fee8000) {
    const n = 884 + ((k >> 13) & 127) * 14;
    return asinTable(x, pos, n, n + 9);
  }
  if (k < 0x3fef0000) {
    const n = 768 + ((k >> 13) & 127) * 15;
    return asinTable(x, pos, n, n + 10);
  }
  if (k < 0x3ff00000) {
    const z = (pos ? 1.0 - x : x + 1.0) * 0.5;
    const kz = hiWord(z) | 0;
    let t = T.IBM_INROOT[(kz >> 14) & 127] * T.IBM_POWTWO[511 - (kz >> 21)];
    const r = fma(-(t * t), z, 1.0);
    t = fma(fma(fma(r, RT3, RT2), r, RT1), r, RT0) * t;
    const c = z * t;
    const h = fma(-(t * 0.5), c, 1.5);
    const y = c + T24 - T24;
    const cc = fma(-y, y, z) / fma(h, c, y);
    const p = asinF(z) * z;
    const cor = fma(-((y + cc) * 2.0), p, fma(-cc, 2.0, HP1));
    const res = cor + fma(-y, 2.0, HP0);
    return pos ? res : -res;
  }
  if (k === 0x3ff00000 && lo === 0) return pos ? HP0 : -HP0;
  return (x - x) / (x - x);
}
