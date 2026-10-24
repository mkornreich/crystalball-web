/**
 * Crystal Ball's in-cell functions. The stream values come from the real
 * OCB.Net.dll (harness/dist `fnstream`): a CBFunctionsOcbMgr seeded with 999,
 * four calls — Normal(0,1), Triangular(0,5,10), Binomial(10, 0.3), Normal(0,1) —
 * evaluated three times.
 */
import { describe, expect, it } from 'vitest';
import { createDistribution, truncate } from '../../engine/distributions';
import { functionStream } from '../cb-functions';
import { HyperFormulaEvaluator, WorkbookData } from '../hyperformula-evaluator';
import { runSimulation } from '../../engine/simulation';

const CB_SEED_999 = [
  1.6582516740435254, 3.7866242089826585, 2, -0.11957227672184441,
  -0.955623112412525, 6.942138496037218, 4, -0.13333139941802666,
  -0.49956036825055933, 5.505161369539842, 2, 1.039088868344385,
];

describe('function stream', () => {
  it('draws what Crystal Ball draws', () => {
    const calls = [
      createDistribution('normal', { mean: 0, stdev: 1 }),
      createDistribution('triangular', { min: 0, likely: 5, max: 10 }),
      createDistribution('binomial', { trials: 10, probability: 0.3 }),
      createDistribution('normal', { mean: 0, stdev: 1 }),
    ];
    const s = functionStream(999);
    const got: number[] = [];
    for (let t = 0; t < 3; t++) for (const d of calls) got.push(d.quantile(s.next()));
    got.forEach((v, i) => expect(v).toBeCloseTo(CB_SEED_999[i], 13));
  });
});

describe('spreadsheet functions in a run', () => {
  const sheet = (): WorkbookData => ({
    sheets: {
      Model: [
        [1, '=_xll.CB.Normal(10, 2)'.replace('_xll.', ''), '=B1*2'],
        [null, '=CB.Triangular(0, 5, 10, 2)', '=CB.GetForeStatFN(C1, 2)'],
        [null, '=CB.IterationsFN()', '=CB.GetRunPrefsFN(1)'],
        [null, '=CB.Custom(E1:F2)', null, null, 1, 0.25],
        [null, null, null, null, null, null],
      ],
    },
    defaultSheet: 'Model',
  });
  // E1:F2 holds the Custom table rows (value, probability).
  const data = sheet();
  data.sheets.Model[0][4] = 1;
  data.sheets.Model[0][5] = 0.25;
  data.sheets.Model[1][4] = 3;
  data.sheets.Model[1][5] = 0.75;

  it('shows the mean before a run and on its first trial, then draws', async () => {
    const ev = new HyperFormulaEvaluator(data, ['Model!A1'], ['Model!C1', 'Model!B2', 'Model!B3', 'Model!C3', 'Model!B4', 'Model!C2']);
    // Base case: each function shows its distribution's mean; no run stats yet.
    const truncTriMean = truncate(createDistribution('triangular', { min: 0, likely: 5, max: 10 }), 2).mean();
    const base = ev.evaluate([1]);
    expect(base.slice(0, 5)).toEqual([20, truncTriMean, 0, 1000, 2.5]);
    expect(base[5]).toBeNaN();
    const res = await runSimulation(
      [{ id: 'a', cell: 'Model!A1', name: 'A', type: 'uniform', params: { min: 0, max: 1 } }],
      [
        { id: 'c1', cell: 'Model!C1', name: 'C1' },
        { id: 'b2', cell: 'Model!B2', name: 'B2' },
        { id: 'b3', cell: 'Model!B3', name: 'B3' },
        { id: 'c3', cell: 'Model!C3', name: 'C3' },
        { id: 'b4', cell: 'Model!B4', name: 'B4' },
        { id: 'c2', cell: 'Model!C2', name: 'C2' },
      ],
      [],
      { trials: 200, sampling: 'mc', lhsSampleSize: 500, useSeed: true, seed: 999 },
      ev,
    );
    const [c1, b2, b3, c3, b4, c2] = res.forecasts.map((f) => f.values);
    expect(c1[0]).toBe(20); // first trial: the mean, no draw
    expect(b2[0]).toBe(truncTriMean);
    expect(c1.slice(1).some((v) => v !== 20)).toBe(true);
    expect(b2.slice(1).every((v) => v >= 2 && v <= 10)).toBe(true); // truncated below at 2
    expect(b3.slice(0, 4)).toEqual([0, 1, 2, 3]); // IterationsFN = trials completed
    expect(c3.every((v) => v === 200)).toBe(true); // GetRunPrefsFN(1) = trials
    expect(new Set(b4.slice(1))).toEqual(new Set([1, 3]));
    // GetForeStatFN(C1, 2): the mean of C1 over the trials completed before this one.
    expect(Number.isNaN(c2[0])).toBe(true);
    expect(c2[1]).toBe(20);
    expect(c2[2]).toBeCloseTo((c1[0] + c1[1]) / 2, 12);
    ev.dispose();
  });
});
