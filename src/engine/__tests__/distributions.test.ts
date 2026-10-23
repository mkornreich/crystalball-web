import { describe, it, expect } from 'vitest';
import { createDistribution, defaultParams, DISTRIBUTIONS, Params } from '../distributions';
import { makeRng } from '../rng';

const P_GRID = [0.01, 0.05, 0.2, 0.4, 0.5, 0.6, 0.8, 0.95, 0.99];

// Representative, finite-moment parameterizations for each distribution.
const CASES: { type: string; params: Params; custom?: { value: number; weight: number }[] }[] = [
  { type: 'normal', params: { mean: 5, stdev: 2 } },
  { type: 'uniform', params: { min: 0, max: 10 } },
  { type: 'triangular', params: { min: 0, likely: 5, max: 10 } },
  { type: 'betapert', params: { min: 0, likely: 5, max: 10 } },
  { type: 'lognormal', params: { mean: 10, stdev: 3, location: 0 } },
  { type: 'exponential', params: { rate: 2 } },
  { type: 'gamma', params: { location: 0, scale: 2, shape: 3 } },
  { type: 'weibull', params: { location: 0, scale: 1, shape: 2 } },
  { type: 'beta', params: { min: 0, max: 1, alpha: 2, beta: 3 } },
  { type: 'logistic', params: { mean: 0, scale: 1 } },
  { type: 'pareto', params: { location: 1, shape: 4 } },
  { type: 'studentt', params: { midpoint: 0, scale: 1, dof: 10 } },
  { type: 'maxextreme', params: { likeliest: 0, scale: 1 } },
  { type: 'minextreme', params: { likeliest: 0, scale: 1 } },
  { type: 'yesno', params: { probability: 0.3 } },
  { type: 'discreteuniform', params: { min: 1, max: 6 } },
  { type: 'binomial', params: { trials: 10, probability: 0.5 } },
  { type: 'poisson', params: { rate: 3 } },
  { type: 'geometric', params: { probability: 0.3 } },
  { type: 'hypergeometric', params: { population: 50, successes: 20, sample: 10 } },
  { type: 'negbinomial', params: { shape: 3, probability: 0.4 } },
  { type: 'custom', params: {}, custom: [
    { value: 0, weight: 1 },
    { value: 1, weight: 1 },
    { value: 2, weight: 2 },
  ] },
];

describe('registry', () => {
  it('every registered distribution builds with its defaults', () => {
    for (const def of DISTRIBUTIONS) {
      const d = createDistribution(def.type, defaultParams(def.type), [
        { value: 0, weight: 1 },
      ]);
      expect(d.validate()).toBeNull();
    }
  });

  it('covers all 22 Crystal Ball distributions', () => {
    expect(DISTRIBUTIONS.length).toBe(22);
  });
});

describe('continuous inverse-CDF round-trips (cdf(quantile(p)) == p)', () => {
  for (const c of CASES) {
    const d = createDistribution(c.type as any, c.params, c.custom);
    if (d.discrete) continue;
    it(c.type, () => {
      for (const p of P_GRID) {
        const x = d.quantile(p);
        expect(Math.abs(d.cdf(x) - p)).toBeLessThan(1e-4);
      }
    });
  }
});

describe('quantile is monotonic non-decreasing', () => {
  for (const c of CASES) {
    const d = createDistribution(c.type as any, c.params, c.custom);
    it(c.type, () => {
      let prev = -Infinity;
      for (const p of P_GRID) {
        const x = d.quantile(p);
        expect(x).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = x;
      }
    });
  }
});

describe('sampled moments match theory (ties the generator to each distribution)', () => {
  const N = 400000;
  for (const c of CASES) {
    it(c.type, () => {
      const d = createDistribution(c.type as any, c.params, c.custom);
      const rng = makeRng(2024);
      let sum = 0;
      let sumSq = 0;
      for (let i = 0; i < N; i++) {
        const x = d.quantile(rng.next());
        sum += x;
        sumSq += x * x;
      }
      const sampleMean = sum / N;
      const sampleVar = sumSq / N - sampleMean * sampleMean;
      const theoMean = d.mean();
      const theoVar = d.variance();

      // Mean: within 2% relative, or 0.03 absolute for near-zero means.
      const meanTol = Math.max(0.03, Math.abs(theoMean) * 0.02);
      expect(Math.abs(sampleMean - theoMean)).toBeLessThan(meanTol);

      if (Number.isFinite(theoVar)) {
        // Variance converges more slowly for skewed/heavy tails.
        const varTol = Math.max(0.05, theoVar * 0.1);
        expect(Math.abs(sampleVar - theoVar)).toBeLessThan(varTol);
      }
    });
  }
});
