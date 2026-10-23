/**
 * Validation against a REAL Oracle Crystal Ball example model.
 *
 * This reconstructs the "Vision Research — ClearView" model exactly as it ships
 * in Crystal Ball's Examples (Tutorial 2 of the Getting Started guide): the
 * worksheet formulas come from the shipped Vision Research.xlsx, and the five
 * assumptions are defined verbatim from the tutorial:
 *
 *   C5  Testing Costs       Uniform(3, 5)                       [$MM]
 *   C6  Marketing Costs     Triangular(12, 16, 18)              [$MM]
 *   C10 Patients Cured      Binomial(trials=100, p=0.25)
 *   C15 Growth Rate         Custom: [0%,5%]@75%, [-15%,-5%]@25%
 *   C19 Market Penetration  Normal(8%, 2%), truncated below 5%
 *
 * Model:  C7=SUM(C4:C6), C11=(C10>=20), C16=C14*(1+C15),
 *         C21=C16*C19*C20, C23=IF(C11, C21-C7, -C4-C5)   (Net Profit)
 *
 * Crystal Ball's own published results for Net Profit (5000 trials, Monte
 * Carlo, initial seed 999) are:
 *   • certainty of Net Profit ≥ $0   ≈ 79%   ("79% certain of achieving a net profit")
 *   • certainty of Net Profit ≥ $2MM ≈ 72%
 * We reproduce the run and check we land on those numbers within Monte Carlo
 * error. (Exact trial-for-trial equality isn't expected — Crystal Ball's draw
 * ordering across assumptions isn't public — but the RNG, distributions and
 * sampling are Crystal Ball's, so the forecast statistics converge to the same
 * values.)
 */

import { describe, it, expect } from 'vitest';
import { HyperFormulaEvaluator, WorkbookData } from '../hyperformula-evaluator';
import { runSimulation } from '../../engine/simulation';
import { Assumption, Forecast, SimulationConfig } from '../../engine/model';

function buildVisionResearch(): WorkbookData {
  const rows: (string | number | null)[][] = [];
  for (let i = 0; i < 23; i++) rows.push([null, null, null]);
  const C = (excelRow: number, v: string | number) => {
    rows[excelRow - 1][2] = v;
  };
  C(4, 10); //  Development cost to date
  C(5, 4); //   Testing costs        (assumption)
  C(6, 16); //  Marketing costs      (assumption)
  C(7, '=SUM(C4:C6)'); // Total costs
  C(10, 25); //  Patients cured      (assumption)
  C(11, '=C10>=20'); //  FDA approved?
  C(14, 40); //  Persons nearsighted today ($MM people)
  C(15, 0.02); // Growth rate         (assumption)
  C(16, '=C14*(1+C15)'); // Persons after one year
  C(19, 0.08); // Market penetration  (assumption)
  C(20, 12); //  Profit per customer
  C(21, '=C16*C19*C20'); // Gross profit if approved
  C(23, '=IF(C11,C21-C7,-C4-C5)'); // Net profit (forecast)
  return { sheets: { Model: rows }, defaultSheet: 'Model' };
}

const ASSUMPTIONS: Assumption[] = [
  { id: 't', cell: 'Model!C5', name: 'Testing Costs', type: 'uniform', params: { min: 3, max: 5 } },
  { id: 'm', cell: 'Model!C6', name: 'Marketing Costs', type: 'triangular', params: { min: 12, likely: 16, max: 18 } },
  { id: 'p', cell: 'Model!C10', name: 'Patients Cured', type: 'binomial', params: { trials: 100, probability: 0.25 } },
  {
    id: 'g',
    cell: 'Model!C15',
    name: 'Growth Rate',
    type: 'custom',
    params: {},
    custom: [
      { min: 0, max: 0.05, weight: 0.75 },
      { min: -0.15, max: -0.05, weight: 0.25 },
    ],
  },
  {
    id: 'mp',
    cell: 'Model!C19',
    name: 'Market Penetration',
    type: 'normal',
    params: { mean: 0.08, stdev: 0.02 },
    truncMin: 0.05,
  },
];

const FORECASTS: Forecast[] = [{ id: 'net', cell: 'Model!C23', name: 'Net Profit', units: '$MM' }];

const CONFIG: SimulationConfig = {
  trials: 5000,
  sampling: 'mc',
  lhsSampleSize: 500,
  useSeed: true,
  seed: 999,
};

function certaintyAtLeast(values: number[], threshold: number): number {
  let c = 0;
  for (const v of values) if (v >= threshold) c++;
  return c / values.length;
}

describe('validation: Oracle Crystal Ball — Vision Research (ClearView)', () => {
  it("reproduces Crystal Ball's published Net Profit certainties", async () => {
    const data = buildVisionResearch();
    const ev = new HyperFormulaEvaluator(
      data,
      ASSUMPTIONS.map((a) => a.cell),
      FORECASTS.map((f) => f.cell),
    );
    // Sanity: the deterministic model evaluates (no formula errors).
    expect(ev.diagnostics(['Net Profit'])).toEqual([]);

    const res = await runSimulation(ASSUMPTIONS, FORECASTS, [], CONFIG, ev);
    ev.dispose();

    const net = res.forecasts[0].values;
    const pProfit = certaintyAtLeast(net, 0); // CB: ~79%
    const pTwoMM = certaintyAtLeast(net, 2); // CB: ~72%

    // Report the numbers for the record.
    // eslint-disable-next-line no-console
    console.log(
      `Vision Research — mean Net Profit $${res.forecasts[0].stats.mean.toFixed(2)}MM, ` +
        `P(>=0)=${(pProfit * 100).toFixed(1)}% (CB 79%), ` +
        `P(>=2)=${(pTwoMM * 100).toFixed(1)}% (CB 72%)`,
    );

    // Crystal Ball published ~79% and ~72%; allow Monte Carlo + truncation slack.
    expect(pProfit).toBeGreaterThan(0.76);
    expect(pProfit).toBeLessThan(0.82);
    expect(pTwoMM).toBeGreaterThan(0.69);
    expect(pTwoMM).toBeLessThan(0.75);

    // The tutorial's forecast chart *displays* roughly -$15MM .. $38MM (it
    // trims extreme values from the view), so check the bulk via percentiles
    // rather than the absolute extremes.
    const p = (pct: number) => res.forecasts[0].percentiles.find((x) => x.p === pct)!.value;
    expect(res.forecasts[0].stats.min).toBeGreaterThan(-16); // ~ -C4-max(testing)
    expect(p(90)).toBeGreaterThan(20);
    expect(p(90)).toBeLessThan(40);
  });
});
