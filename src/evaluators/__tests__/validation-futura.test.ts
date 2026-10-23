/**
 * Validation against Oracle Crystal Ball's "Futura Apartments" example — the
 * very first tutorial in the Getting Started guide.
 *
 * Model (from the shipped Futura Apartments.xlsx):
 *   C5 Number of Rental Units  (assumption)
 *   C6 Rent per Unit = 500
 *   C7 Monthly Expenses        (assumption)
 *   C9 Profit or Loss = C5*C6 - C7     (forecast)
 *
 * The exact assumption definitions are taken from the notes attached to the
 * assumption cells in the shipped workbook:
 *   C5  Discrete Uniform(min=30, max=40)
 *   C7  Normal(mean=15000, std dev=1000), no truncation
 *
 * Crystal Ball's published result (1,000 trials, default settings) is that the
 * certainty of Profit ≥ $0 is ≈ 90% (the Getting Started guide's forecast chart
 * reads 90.09%). We reproduce the run and check we land there.
 */

import { describe, it, expect } from 'vitest';
import { HyperFormulaEvaluator, WorkbookData } from '../hyperformula-evaluator';
import { runSimulation } from '../../engine/simulation';
import { Assumption, Forecast, SimulationConfig } from '../../engine/model';

function buildFutura(): WorkbookData {
  const rows: (string | number | null)[][] = [];
  for (let i = 0; i < 9; i++) rows.push([null, null, null]);
  rows[4][2] = 35; //   C5 units   (assumption)
  rows[5][2] = 500; //  C6 rent
  rows[6][2] = 15000; // C7 expenses (assumption)
  rows[8][2] = '=C5*C6-C7'; // C9 profit (forecast)
  return { sheets: { Model: rows }, defaultSheet: 'Model' };
}

const ASSUMPTIONS: Assumption[] = [
  { id: 'u', cell: 'Model!C5', name: 'Number of Rental Units', type: 'discreteuniform', params: { min: 30, max: 40 } },
  { id: 'e', cell: 'Model!C7', name: 'Monthly Expenses', type: 'normal', params: { mean: 15000, stdev: 1000 } },
];
const FORECASTS: Forecast[] = [{ id: 'p', cell: 'Model!C9', name: 'Profit or Loss', units: '$' }];
const CONFIG: SimulationConfig = {
  trials: 1000,
  sampling: 'mc',
  lhsSampleSize: 500,
  useSeed: true,
  seed: 999,
};

describe('validation: Oracle Crystal Ball — Futura Apartments', () => {
  it("reproduces Crystal Ball's ~90% certainty of profit", async () => {
    const data = buildFutura();
    const ev = new HyperFormulaEvaluator(data, ASSUMPTIONS.map((a) => a.cell), FORECASTS.map((f) => f.cell));
    const res = await runSimulation(ASSUMPTIONS, FORECASTS, [], CONFIG, ev);
    ev.dispose();

    const profit = res.forecasts[0].values;
    const pProfit = profit.filter((v) => v >= 0).length / profit.length;
    // eslint-disable-next-line no-console
    console.log(
      `Futura — mean Profit $${res.forecasts[0].stats.mean.toFixed(0)}, ` +
        `P(>=0)=${(pProfit * 100).toFixed(1)}% (CB 90.09%)`,
    );

    expect(res.forecasts[0].stats.mean).toBeGreaterThan(2200);
    expect(res.forecasts[0].stats.mean).toBeLessThan(2800); // CB center ~$2,500
    expect(pProfit).toBeGreaterThan(0.87);
    expect(pProfit).toBeLessThan(0.93); // CB: 90.09%
  });
});
