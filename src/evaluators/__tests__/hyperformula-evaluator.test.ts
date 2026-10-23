import { describe, it, expect } from 'vitest';
import { HyperFormulaEvaluator, WorkbookData } from '../hyperformula-evaluator';
import { runSimulation } from '../../engine/simulation';
import { Assumption, Forecast, SimulationConfig } from '../../engine/model';

describe('HyperFormula evaluator', () => {
  it('mirrors a model and recalculates on each trial', () => {
    const data: WorkbookData = {
      sheets: {
        Model: [[1], [2], ['=A1+A2'], ['=A1*A2'], ['=IF(A1>A2,A1,A2)']],
      },
      defaultSheet: 'Model',
    };
    const ev = new HyperFormulaEvaluator(
      data,
      ['Model!A1', 'Model!A2'],
      ['Model!A3', 'Model!A4', 'Model!A5'],
    );
    expect(ev.evaluate([3, 4])).toEqual([7, 12, 4]);
    expect(ev.evaluate([10, 0.5])).toEqual([10.5, 5, 10]);
    ev.dispose();
  });

  it('handles cross-sheet references and built-in functions', () => {
    const data: WorkbookData = {
      sheets: {
        Inputs: [[100], [0.2]],
        Model: [['=Inputs!A1*(1+Inputs!A2)'], ['=SUM(Inputs!A1:A2)']],
      },
      defaultSheet: 'Model',
    };
    const ev = new HyperFormulaEvaluator(data, ['Inputs!A1', 'Inputs!A2'], ['Model!A1', 'Model!A2']);
    expect(ev.evaluate([200, 0.5])).toEqual([300, 200.5]);
    ev.dispose();
  });

  it('flags a forecast cell with an unsupported function', () => {
    const data: WorkbookData = {
      sheets: { Model: [[1], ['=TOTALLYNOTAFUNCTION(A1)']] },
      defaultSheet: 'Model',
    };
    const ev = new HyperFormulaEvaluator(data, ['Model!A1'], ['Model!A2']);
    const warnings = ev.diagnostics(['Bad Forecast']);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('Bad Forecast');
    ev.dispose();
  });

  it('drives a full simulation through the real engine', async () => {
    const data: WorkbookData = {
      sheets: { Model: [[10], [2], ['=A1+A2']] },
      defaultSheet: 'Model',
    };
    const ev = new HyperFormulaEvaluator(data, ['Model!A1', 'Model!A2'], ['Model!A3']);
    const assumptions: Assumption[] = [
      { id: 'x', cell: 'Model!A1', name: 'X', type: 'normal', params: { mean: 10, stdev: 2 } },
      { id: 'y', cell: 'Model!A2', name: 'Y', type: 'uniform', params: { min: 0, max: 4 } },
    ];
    const forecasts: Forecast[] = [{ id: 's', cell: 'Model!A3', name: 'Sum' }];
    const config: SimulationConfig = {
      trials: 4000,
      sampling: 'mc',
      lhsSampleSize: 500,
      useSeed: true,
      seed: 999,
    };
    const res = await runSimulation(assumptions, forecasts, [], config, ev);
    ev.dispose();
    expect(res.forecasts[0].stats.mean).toBeCloseTo(12, 0);
    expect(res.forecasts[0].values.length).toBe(4000);
  });
});
