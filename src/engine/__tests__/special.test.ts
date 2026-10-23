import { describe, it, expect } from 'vitest';
import {
  betaI,
  erf,
  gammaP,
  invBetaI,
  invGammaP,
  normCdf,
  normInv,
  studentTInv,
} from '../special';

const close = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

describe('error function and normal', () => {
  it('erf anchors', () => {
    expect(close(erf(0), 0)).toBe(true);
    expect(close(erf(10), 1)).toBe(true);
    expect(close(erf(-10), -1)).toBe(true);
    // erf(1) = 0.8427007929...
    expect(close(erf(1), 0.8427007929497149, 1e-10)).toBe(true);
  });

  it('normal CDF anchors', () => {
    expect(close(normCdf(0), 0.5, 1e-12)).toBe(true);
    expect(close(normCdf(1.959963985), 0.975, 1e-7)).toBe(true);
  });

  it('normInv is the inverse of normCdf', () => {
    for (const p of [0.001, 0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999]) {
      expect(close(normCdf(normInv(p)), p, 1e-9)).toBe(true);
    }
    // Known quantile z_{0.975} = 1.9599639845...
    expect(close(normInv(0.975), 1.959963984540054, 1e-7)).toBe(true);
    expect(close(normInv(0.5), 0, 1e-12)).toBe(true);
  });
});

describe('incomplete gamma / beta inverses', () => {
  it('invGammaP inverts gammaP', () => {
    for (const a of [0.5, 1, 2.5, 7, 40]) {
      for (const p of [0.05, 0.3, 0.5, 0.8, 0.95]) {
        const x = invGammaP(p, a);
        expect(close(gammaP(a, x), p, 1e-6)).toBe(true);
      }
    }
  });

  it('invBetaI inverts betaI', () => {
    for (const [a, b] of [
      [2, 2],
      [0.5, 0.5],
      [5, 2],
      [2, 8],
    ]) {
      for (const p of [0.05, 0.3, 0.5, 0.8, 0.95]) {
        const x = invBetaI(p, a, b);
        expect(close(betaI(x, a, b), p, 1e-6)).toBe(true);
      }
    }
  });

  it("Student's t quantile matches a known table value", () => {
    // t_{0.975, 10} = 2.228138...
    expect(close(studentTInv(0.975, 10), 2.2281388519649385, 1e-4)).toBe(true);
    expect(close(studentTInv(0.5, 7), 0, 1e-9)).toBe(true);
    // symmetric
    expect(close(studentTInv(0.1, 5), -studentTInv(0.9, 5), 1e-9)).toBe(true);
  });
});
