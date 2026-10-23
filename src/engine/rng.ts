/**
 * Seedable pseudo-random number generator matching Oracle Crystal Ball.
 *
 * Crystal Ball documents its generator (Oracle Crystal Ball Reference &
 * Examples, "Random Number Generation") as the multiplicative congruential
 * generator
 *
 *      r  ←  (62089911 · r)  mod  (2^31 − 1)
 *
 * with period 2^31 − 2 (= 2,147,483,646). Uniform variates on (0,1) are
 * r / (2^31 − 1). This is one of Fishman & Moore's best-spectral multipliers
 * for the prime modulus 2^31 − 1. Every non-uniform assumption in the engine
 * is produced from this stream by inverse transform, exactly as Crystal Ball
 * layers its distributions on top of this base generator, so fixing the seed
 * reproduces a run.
 *
 * `Math.random` is never used in the engine, so a given seed is fully
 * reproducible. The product 62089911 · r can reach ~1.3e17, past the 2^53
 * exact-integer limit of a JS double, so `mulmod` evaluates it without loss
 * by splitting r into 15-bit halves and reducing modulo m between steps.
 */

export interface Rng {
  /** Next float in (0, 1). */
  next(): number;
  /** Re-seed the stream. */
  reseed(seed: number | string): void;
  /** Current raw integer state in [1, m-1] (exposed for tests/inspection). */
  readonly state: number;
}

/** Crystal Ball multiplier a. */
export const CB_MULTIPLIER = 62089911;
/** Crystal Ball modulus m = 2^31 − 1. */
export const CB_MODULUS = 2147483647;

/**
 * Exact (a · x) mod m for a, x in [0, 2^31), m < 2^31, with no value ever
 * exceeding 2^53 — so every intermediate is an exact JS integer.
 */
export function mulmod(a: number, x: number, m: number): number {
  const xhi = Math.floor(x / 32768); // x >> 15, up to 2^16
  const xlo = x % 32768; //            x & 0x7fff, up to 2^15
  let t = (a * xhi) % m; //            a·xhi < 2^26·2^16 = 2^42
  t = (t * 32768) % m; //              t < m < 2^31, ·2^15 < 2^46
  t = (t + ((a * xlo) % m)) % m; //    a·xlo < 2^26·2^15 = 2^41
  return t;
}

/** Hash an arbitrary string/number seed into a valid state in [1, m-1]. */
function seedToState(seed: number | string): number {
  let h: number;
  if (typeof seed === 'number') {
    h = Math.abs(Math.floor(seed)) % CB_MODULUS;
  } else {
    // FNV-1a over the characters, then fold into the modulus.
    let x = 2166136261 >>> 0;
    for (let i = 0; i < seed.length; i++) {
      x ^= seed.charCodeAt(i);
      x = Math.imul(x, 16777619);
    }
    h = (x >>> 0) % CB_MODULUS;
  }
  // State 0 is a fixed point of a multiplicative generator; avoid it.
  return h === 0 ? 1 : h;
}

export class CrystalBallRng implements Rng {
  state = 1;

  constructor(seed: number | string = 1) {
    this.reseed(seed);
  }

  reseed(seed: number | string): void {
    this.state = seedToState(seed);
  }

  next(): number {
    this.state = mulmod(CB_MULTIPLIER, this.state, CB_MODULUS);
    return this.state / CB_MODULUS;
  }
}

/** Convenience factory for the Crystal Ball generator. */
export function makeRng(seed: number | string = 1): Rng {
  return new CrystalBallRng(seed);
}
