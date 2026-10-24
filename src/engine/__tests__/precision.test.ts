import { describe, it, expect } from 'vitest';
import { checkPrecision, percentileStdErr, precisionMet } from '../precision';
import { runSimulation } from '../simulation';
import { Assumption, Forecast, ModelEvaluator, SimulationConfig } from '../model';
import { percentileSorted, summarize } from '../statistics';

const Z95 = 1.959963984540054;

/** n choose k, exactly enough for small n. */
function choose(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

describe('precision control', () => {
  const data = Array.from({ length: 200 }, (_, i) => Math.sin(i * 1.7) * 10 + i / 20);
  const sorted = [...data].sort((a, b) => a - b);
  const s = summarize(data);

  it('uses z·s/√n for the mean and z·s·√((kurt−1)/(4(n−1))) for the std. dev.', () => {
    const [mean, sd] = checkPrecision(
      data,
      [
        { stat: 'mean', absolute: true, value: 1 },
        { stat: 'stddev', absolute: true, value: 1 },
      ],
      0.95,
    );
    expect(mean.value).toBe(s.mean);
    expect(mean.halfWidth).toBeCloseTo((Z95 * s.stdDev) / Math.sqrt(200), 12);
    expect(sd.halfWidth).toBeCloseTo(Z95 * s.stdDev * Math.sqrt((s.kurtosis - 1) / (4 * 199)), 12);
    expect(mean.state).toBe(mean.halfWidth <= 1 ? 'passed' : 'failed');
  });

  it('weights order statistics by binomial probabilities for a percentile', () => {
    // Recompute the Maritz–Jarrett-style estimate with exact binomial terms.
    const n = sorted.length;
    const p = 0.9;
    const c = Math.round((n - 1) * p);
    const w = (j: number) => choose(n, c + 1) * ((j + 1) / n) ** (c + 1) * (1 - (j + 1) / n) ** (n - c - 1);
    const w0 = w(c);
    let sw = w0;
    let m1 = w0 * sorted[c];
    let m2 = w0 * sorted[c] ** 2;
    for (let i = c - 1, wi = 1; i >= 0 && wi >= 0.05 * w0; i--) {
      wi = w(i);
      sw += wi;
      m1 += wi * sorted[i];
      m2 += wi * sorted[i] ** 2;
    }
    for (let i = c + 1, wi = 1; i < n && wi >= 0.05 * w0; i++) {
      wi = w(i);
      sw += wi;
      m1 += wi * sorted[i];
      m2 += wi * sorted[i] ** 2;
    }
    m1 /= sw;
    const expected = Math.sqrt(m2 - m1 * m1 * sw);
    expect(percentileStdErr(sorted, p)).toBeCloseTo(expected, 9);
    const [chk] = checkPrecision(data, [{ stat: 'percentile', percentile: 90, absolute: true, value: 100 }], 0.95);
    expect(chk.value).toBe(percentileSorted(sorted, 90));
    expect(chk.halfWidth).toBeCloseTo(Z95 * expected, 9);
  });

  it('needs three order statistics either side of the percentile', () => {
    expect(percentileStdErr(sorted.slice(0, 20), 0.95)).toBe(-1);
    expect(percentileStdErr(sorted.slice(0, 20), 0.05)).toBe(-1);
    expect(percentileStdErr(sorted.slice(0, 20), 0.5)).toBeGreaterThan(0);
  });

  it('judges relative requirements as a percentage of the statistic and drops hopeless ones', () => {
    const [rel] = checkPrecision(data, [{ stat: 'mean', absolute: false, value: 1 }], 0.95);
    const pct = (100 * rel.halfWidth) / Math.abs(rel.value);
    expect(rel.state).toBe(pct > 500 ? 'eliminated' : pct <= 1 ? 'passed' : 'failed');
    const centred = data.map((v) => v - s.mean + 1e-6);
    expect(checkPrecision(centred, [{ stat: 'mean', absolute: false, value: 5 }], 0.95)[0].state).toBe('eliminated');
    expect(checkPrecision(data.slice(0, 19), [{ stat: 'mean', absolute: true, value: 1e9 }], 0.95)[0].state).toBe('failed');
  });

  it('stops only when something passed and nothing failed', () => {
    const c = (state: 'passed' | 'failed' | 'not-valid' | 'eliminated') => ({
      requirement: { stat: 'mean' as const, absolute: true, value: 1 },
      state,
      value: 0,
      halfWidth: 0,
    });
    expect(precisionMet([c('passed'), c('eliminated')])).toBe(true);
    expect(precisionMet([c('eliminated')])).toBe(false);
    expect(precisionMet([c('passed'), c('failed')])).toBe(false);
    expect(precisionMet([c('passed'), c('not-valid')])).toBe(false);
  });

  it('ends a run at the first check where the requirements are met', async () => {
    const assumptions: Assumption[] = [{ id: 'a', cell: 'S!A1', name: 'A', type: 'normal', params: { mean: 100, stdev: 10 } }];
    const forecasts: Forecast[] = [{ id: 'f', cell: 'S!B1', name: 'F', precision: [{ stat: 'mean', absolute: true, value: 1 }] }];
    const echo: ModelEvaluator = { inputCount: 1, outputCount: 1, evaluate: (x) => [x[0]], dispose() {} };
    const config: SimulationConfig = {
      trials: 100000,
      sampling: 'mc',
      lhsSampleSize: 500,
      useSeed: true,
      seed: 999,
      precision: { enabled: true, checkEvery: 50, confidence: 0.95 },
    };
    const res = await runSimulation(assumptions, forecasts, [], config, echo);
    expect(res.stoppedByPrecision).toBe(true);
    expect(res.trials % 50).toBe(0);
    // z·σ/√n ≤ 1 needs n ≈ (1.96·10)² ≈ 384, so the run ends a check or so after that.
    expect(res.trials).toBeGreaterThanOrEqual(300);
    expect(res.trials).toBeLessThanOrEqual(550);
    expect(res.forecasts[0].precision?.[0].state).toBe('passed');
    // The previous check (50 trials earlier) must not have passed.
    const earlier = checkPrecision(res.forecasts[0].values.slice(0, res.trials - 50), forecasts[0].precision!, 0.95);
    expect(precisionMet(earlier)).toBe(false);

    const full = await runSimulation(assumptions, forecasts, [], { ...config, trials: 2000, precision: { ...config.precision!, enabled: false } }, echo);
    expect(full.trials).toBe(2000);
    expect(full.stoppedByPrecision).toBeUndefined();
    expect(full.forecasts[0].values.slice(0, res.trials)).toEqual(res.forecasts[0].values);
  });
});
