/**
 * End to end against Crystal Ball's own published output. The workbooks are
 * Oracle's shipped examples when present (read with the Crystal Ball model
 * reader), and always the project's own copies with the model Crystal Ball
 * saved written out as the dashboard defines it; formulas are evaluated in
 * HyperFormula. The expected numbers are copied from the forecast
 * windows in the Crystal Ball 11.1.3 User's Guide, whose screen captures were
 * all taken with Monte Carlo sampling and seed 999 — figures
 * futuraprofitfcmc, futurasplitmulti, netprofitstats and netprofitpctiles.
 * Every statistic is compared at the precision Crystal Ball displays.
 */
import { describe, expect, it } from 'vitest';
import { readCrystalBallModel } from '../model';
import { toWorkbookData } from '../workbook-data';
import { HyperFormulaEvaluator } from '../../evaluators/hyperformula-evaluator';
import { runSimulation } from '../../engine/simulation';
import { certainty } from '../../engine/statistics';
import { Assumption, Forecast, ForecastResult } from '../../engine/model';
import { EXAMPLES } from '../../dashboard/examples';
import { hasOracle, oracleFile, ownFile } from './oracle-files';

/** Run a workbook with seed 999 and Monte Carlo sampling; the model is what it saved plus `extra`. */
async function run(bytes: Buffer, trials: number, extra: Assumption[] = [], extraForecasts: Forecast[] = []) {
  const { pkg, model } = await readCrystalBallModel(bytes);
  const assumptions = [...model.assumptions, ...extra];
  const forecasts = [...model.forecasts, ...extraForecasts];
  const ev = new HyperFormulaEvaluator(
    await toWorkbookData(pkg),
    assumptions.map((a) => a.cell),
    forecasts.map((f) => f.cell),
  );
  const res = await runSimulation(assumptions, forecasts, model.correlations, {
    trials,
    sampling: 'mc',
    lhsSampleSize: 500,
    useSeed: true,
    seed: 999,
    sheetOrder: model.sheetOrder,
  }, ev);
  ev.dispose();
  return res.forecasts[0];
}

/** Assert `ours` rounds to Crystal Ball's displayed value at `digits` decimals. */
function shown(ours: number, cb: number, digits: number) {
  expect(Number(ours.toFixed(digits))).toBe(cb);
}

function checkPercentiles(f: ForecastResult, cb: number[], digits: number) {
  f.percentiles.forEach((p, i) => shown(p.value, cb[i], digits));
}

const example = (id: string) => EXAMPLES.find((e) => e.id === id)!;

/** Each tutorial as Oracle's workbook (when present) and as the project's own copy with the dashboard's model. */
function sources(id: string, oracle: string) {
  const ex = example(id);
  const own = ex.own!;
  const tutorial = ex.extraAssumptions ?? [];
  const out: [string, (trials: number) => Promise<ForecastResult>][] = [
    ["the project's own workbook", (t) => run(ownFile(own.file), t, [...own.assumptions, ...tutorial], [...own.forecasts, ...(ex.extraForecasts ?? [])])],
  ];
  if (hasOracle(oracle)) out.push(["Oracle's workbook", (t) => run(oracleFile(oracle), t, tutorial, ex.extraForecasts ?? [])]);
  return out;
}

describe.each(sources('futura', 'Futura Apartments.xlsx'))('Futura Apartments (Tutorial 1), %s', (_, runIt) => {
  it('1,000 trials: certainty of profit 90.09%', async () => {
    const f = await runIt(1000);
    shown(certainty(f.values, 0, Infinity), 90.09, 2);
  });

  it('5,000 trials: the full statistics and percentiles views', async () => {
    const f = await runIt(5000);
    const s = f.stats;
    shown(s.mean, 2473.72, 2);
    shown(s.median, 2486.58, 2);
    expect(s.mode).toBeNull(); // "---"
    shown(s.stdDev, 1850.66, 2);
    shown(s.variance, 3424956.14, 2);
    shown(s.skewness, 0.0053, 4);
    shown(s.kurtosis, 2.4, 2);
    shown(s.coeffOfVariability, 0.7481, 4);
    shown(s.min, -2732.96, 2);
    shown(s.max, 8275.85, 2);
    shown(s.meanStdError, 26.17, 2);
    checkPercentiles(f, [-2732.96, 12.51, 792.64, 1374.05, 1943.86, 2486.48, 2995.3, 3557.3, 4189.77, 4946.92, 8275.85], 2);
  });
});

describe.each(sources('vision', 'Vision Research.xlsx'))('Vision Research (Tutorial 2), %s', (_, runIt) => {
  // The tutorial has the user add three assumptions and the Net Profit forecast (see examples.ts).
  it('5,000 trials: Net Profit statistics and percentiles views', async () => {
    const f = await runIt(5000);
    const s = f.stats;
    shown(s.mean, 7.9, 1);
    shown(s.median, 8.4, 1);
    expect(s.mode).toBeNull();
    shown(s.stdDev, 11.1, 1);
    shown(s.variance, 122.9, 1);
    shown(s.skewness, -0.1734, 4);
    shown(s.kurtosis, 2.86, 2);
    shown(s.coeffOfVariability, 1.41, 2);
    shown(s.min, -15.0, 1);
    shown(s.max, 44.1, 1);
    shown(s.meanStdError, 0.2, 1);
    checkPercentiles(f, [-15.0, -7.3, -0.5, 2.6, 5.6, 8.4, 11.0, 13.6, 17.1, 21.6, 44.1], 1);
  });
});
