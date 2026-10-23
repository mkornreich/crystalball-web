import { describe, it, expect } from 'vitest';
import { CB_MODULUS, CB_MULTIPLIER, CrystalBallRng, makeRng, mulmod } from '../rng';

/** Exact reference for (a·x) mod m using BigInt. */
function mulmodRef(a: number, x: number, m: number): number {
  return Number((BigInt(a) * BigInt(x)) % BigInt(m));
}

describe('Crystal Ball generator', () => {
  it('uses the documented constants', () => {
    expect(CB_MULTIPLIER).toBe(62089911);
    expect(CB_MODULUS).toBe(2147483647); // 2^31 - 1
    expect(CB_MODULUS).toBe(2 ** 31 - 1);
  });

  it('mulmod is exact (matches BigInt) across the range', () => {
    const rng = makeRng(12345);
    for (let i = 0; i < 20000; i++) {
      const x = Math.floor(rng.next() * CB_MODULUS);
      expect(mulmod(CB_MULTIPLIER, x, CB_MODULUS)).toBe(
        mulmodRef(CB_MULTIPLIER, x, CB_MODULUS),
      );
    }
  });

  it('the sequence equals the exact BigInt recurrence r <- (62089911 r) mod (2^31-1)', () => {
    const rng = new CrystalBallRng(1);
    let ref = 1n;
    const M = BigInt(CB_MODULUS);
    const A = BigInt(CB_MULTIPLIER);
    for (let i = 0; i < 100000; i++) {
      rng.next();
      ref = (A * ref) % M;
      expect(rng.state).toBe(Number(ref));
    }
  });

  it('first draw from seed 1 is 62089911 / (2^31-1)', () => {
    const rng = new CrystalBallRng(1);
    const u = rng.next();
    expect(rng.state).toBe(62089911);
    expect(u).toBeCloseTo(62089911 / 2147483647, 12);
  });

  it('stays strictly inside (0, 1)', () => {
    const rng = makeRng('crystal');
    for (let i = 0; i < 50000; i++) {
      const u = rng.next();
      expect(u).toBeGreaterThan(0);
      expect(u).toBeLessThan(1);
    }
  });

  it('is reproducible from a seed and differs across seeds', () => {
    const a = makeRng(999);
    const b = makeRng(999);
    const c = makeRng(1000);
    const seqA: number[] = [];
    const seqB: number[] = [];
    const seqC: number[] = [];
    for (let i = 0; i < 1000; i++) {
      seqA.push(a.next());
      seqB.push(b.next());
      seqC.push(c.next());
    }
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
  });

  it('is roughly uniform (mean ~ 0.5)', () => {
    const rng = makeRng(42);
    let sum = 0;
    const n = 500000;
    for (let i = 0; i < n; i++) sum += rng.next();
    expect(Math.abs(sum / n - 0.5)).toBeLessThan(0.005);
  });
});
