import { describe, it, expect } from 'vitest';
import { createDistribution } from '../distributions';
import { generateSamples, placementOf } from '../sampling';
import { percentileSorted, spearman, summarize } from '../statistics';
import { sensitivity } from '../sensitivity';
import { runSimulation } from '../simulation';
import { Assumption, Forecast, ModelEvaluator, SimulationConfig } from '../model';
import { Distribution } from '../distributions';

/** Columns for `dists` on one sheet, rows 1.., as Crystal Ball would draw them. */
function sample(
  dists: Distribution[],
  trials: number,
  method: 'mc' | 'lhs',
  seed: number,
  correlations?: { a: string; b: string; coefficient: number }[],
): number[][] {
  return generateSamples({
    dists,
    placements: dists.map((_, i) => placementOf(`S!A${i + 1}`)),
    ids: dists.map((_, i) => String.fromCharCode(97 + i)),
    trials,
    method,
    lhsSampleSize: 500,
    seed,
    correlations,
  }).columns;
}

describe('statistics', () => {
  it('summarizes a known sample', () => {
    const s = summarize([1, 2, 3, 4, 5]);
    expect(s.mean).toBeCloseTo(3, 12);
    expect(s.median).toBeCloseTo(3, 12);
    expect(s.variance).toBeCloseTo(2.5, 12); // sample (n-1)
    expect(s.stdDev).toBeCloseTo(Math.sqrt(2.5), 12);
    expect(s.min).toBe(1);
    expect(s.max).toBe(5);
    expect(s.range).toBe(4);
    expect(s.meanStdError).toBeCloseTo(Math.sqrt(2.5) / Math.sqrt(5), 12);
  });

  it('percentiles interpolate the empirical CDF like Crystal Ball', () => {
    // x[k] sits at cumulative probability (k+1)/n.
    const sorted = [1, 2, 3, 4, 5];
    expect(percentileSorted(sorted, 0)).toBe(1);
    expect(percentileSorted(sorted, 50)).toBe(2.5);
    expect(percentileSorted(sorted, 100)).toBe(5);
    expect(percentileSorted(sorted, 25)).toBe(1.25);
  });

  it('spearman handles monotone and reversed relations', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 12);
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 12);
    // monotone but nonlinear -> still 1 for rank correlation
    expect(spearman([1, 2, 3, 4], [1, 4, 9, 16])).toBeCloseTo(1, 12);
  });
});

describe('Latin Hypercube', () => {
  it('estimates the mean more tightly than it must', () => {
    const d = createDistribution('uniform', { min: 0, max: 10 });
    const [col] = sample([d], 1000, 'lhs', 7);
    const mean = col.reduce((a, b) => a + b, 0) / col.length;
    expect(Math.abs(mean - 5)).toBeLessThan(0.1);
  });
});

describe('copula correlation', () => {
  it('induces the target rank correlation while preserving marginals', () => {
    const a = createDistribution('normal', { mean: 0, stdev: 1 });
    const b = createDistribution('normal', { mean: 0, stdev: 1 });
    const cols = sample([a, b], 4000, 'mc', 123, [{ a: 'a', b: 'b', coefficient: 0.8 }]);
    expect(spearman(cols[0], cols[1])).toBeGreaterThan(0.74);
    expect(spearman(cols[0], cols[1])).toBeLessThan(0.86);
    // the first member's marginal is still a standard normal
    const mean = cols[0].reduce((x, y) => x + y, 0) / cols[0].length;
    expect(Math.abs(mean)).toBeLessThan(0.06);
  });

  it('handles a negative target', () => {
    const a = createDistribution('normal', { mean: 0, stdev: 1 });
    const b = createDistribution('uniform', { min: 0, max: 1 });
    const cols = sample([a, b], 3000, 'mc', 55, [{ a: 'a', b: 'b', coefficient: -0.6 }]);
    expect(spearman(cols[0], cols[1])).toBeLessThan(-0.52);
    expect(spearman(cols[0], cols[1])).toBeGreaterThan(-0.68);
  });
});

describe('sensitivity (contribution to variance)', () => {
  it('ranks the dominant driver first and sums to 100%', () => {
    const a = createDistribution('normal', { mean: 0, stdev: 1 });
    const b = createDistribution('normal', { mean: 0, stdev: 1 });
    const cols = sample([a, b], 5000, 'mc', 9);
    const forecast = cols[0].map((av, i) => 3 * av + cols[1][i]); // a dominates
    const assumptions: Assumption[] = [
      { id: 'a', cell: 'S!A1', name: 'A', type: 'normal', params: {} },
      { id: 'b', cell: 'S!A2', name: 'B', type: 'normal', params: {} },
    ];
    const entries = sensitivity(assumptions, cols, forecast);
    expect(entries[0].assumptionId).toBe('a');
    expect(entries[0].contribution).toBeGreaterThan(entries[1].contribution);
    expect(entries[0].contribution).toBeGreaterThan(0); // positive driver
    const total = entries.reduce((s, e) => s + Math.abs(e.contribution), 0);
    expect(total).toBeCloseTo(100, 6);
  });
});

/** A synthetic evaluator: forecast = sum of inputs, and product of inputs. */
class SumEvaluator implements ModelEvaluator {
  inputCount: number;
  outputCount = 2;
  constructor(n: number) {
    this.inputCount = n;
  }
  evaluate(inputs: number[]): number[] {
    let sum = 0;
    let prod = 1;
    for (const v of inputs) {
      sum += v;
      prod *= v;
    }
    return [sum, prod];
  }
  dispose() {}
}

describe('end-to-end simulation', () => {
  const assumptions: Assumption[] = [
    { id: 'x', cell: 'S!A1', name: 'X', type: 'normal', params: { mean: 10, stdev: 2 } },
    { id: 'y', cell: 'S!A2', name: 'Y', type: 'uniform', params: { min: 0, max: 4 } },
  ];
  const forecasts: Forecast[] = [
    { id: 'sum', cell: 'S!A3', name: 'Sum' },
    { id: 'prod', cell: 'S!A4', name: 'Product' },
  ];
  const config: SimulationConfig = {
    trials: 5000,
    sampling: 'mc',
    lhsSampleSize: 500,
    useSeed: true,
    seed: 999,
  };

  it('produces correct forecast statistics', async () => {
    const res = await runSimulation(
      assumptions,
      forecasts,
      [],
      config,
      new SumEvaluator(2),
    );
    const sum = res.forecasts[0];
    expect(sum.values.length).toBe(5000);
    expect(sum.stats.mean).toBeCloseTo(12, 0); // 10 + mean(Uniform 0..4)=2
    // Var(X)+Var(Y) = 4 + 16/12 = 5.333..., sd ~ 2.309
    expect(sum.stats.stdDev).toBeGreaterThan(2.0);
    expect(sum.stats.stdDev).toBeLessThan(2.6);
    expect(sum.percentiles[0].p).toBe(0);
    expect(sum.sensitivity.length).toBe(2);
  });

  it('is reproducible with a fixed seed', async () => {
    const r1 = await runSimulation(assumptions, forecasts, [], config, new SumEvaluator(2));
    const r2 = await runSimulation(assumptions, forecasts, [], config, new SumEvaluator(2));
    expect(r1.forecasts[0].values).toEqual(r2.forecasts[0].values);
  });

  it('awaits an async evaluator and supports cancellation', async () => {
    class AsyncEval implements ModelEvaluator {
      inputCount = 2;
      outputCount = 2;
      async evaluate(inputs: number[]): Promise<number[]> {
        return [inputs[0] + inputs[1], inputs[0] * inputs[1]];
      }
      dispose() {}
    }
    let calls = 0;
    const res = await runSimulation(
      assumptions,
      forecasts,
      [],
      { ...config, trials: 100 },
      new AsyncEval(),
      { shouldCancel: () => ++calls > 50, yieldEvery: 10 },
    );
    expect(res.trials).toBeLessThanOrEqual(51);
    expect(res.warnings.some((w) => w.includes('cancelled'))).toBe(true);
  });
});
