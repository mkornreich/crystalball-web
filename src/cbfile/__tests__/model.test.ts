/** Reading Crystal Ball's saved model out of a real workbook. */
import { describe, expect, it } from 'vitest';
import { parseDstText, readCrystalBallModel } from '../model';
import { hasOracle, oracleFile } from './oracle-files';

describe('distribution text', () => {
  it('reads named and unnamed (leading) cuts', () => {
    expect(parseDstText('Normal,LoCut=0,Mean=8,StdDev=2')).toMatchObject({ name: 'Normal', loCut: 0, hiCut: undefined });
    expect(parseDstText('LogNormal,=500000,=750000,Mean=600000,StdDev=50000,Location=0')).toMatchObject({
      name: 'LogNormal',
      loCut: 500000,
      hiCut: 750000,
      values: { mean: 600000, stddev: 50000, location: 0 },
    });
    // Crystal Ball's "no cut" sentinels are ignored.
    expect(parseDstText('Normal,LoCut=-1.11E+307,Mean=1,StdDev=1').loCut).toBeUndefined();
  });
});

describe.skipIf(!hasOracle('Futura Apartments.xlsx'))("Oracle's Futura Apartments.xlsx", () => {
  it('yields the model Crystal Ball saved', async () => {
    const { model } = await readCrystalBallModel(oracleFile('Futura Apartments.xlsx'));
    expect(model.savedBy).toBe('11.1.3833.0');
    expect(model.sheetOrder).toEqual(['Description', 'Model']);
    expect(model.assumptions.map((a) => [a.name, a.cell, a.type, a.params])).toEqual(
      expect.arrayContaining([
        ['Monthly Expenses', 'Model!C7', 'normal', { mean: 15000, stdev: 1000 }],
        ['Number of Rental Units', 'Model!C5', 'discreteuniform', { min: 30, max: 40 }],
      ]),
    );
    expect(model.forecasts.map((f) => [f.name, f.cell])).toEqual([['Profit or Loss', 'Model!C9']]);
    expect(model.warnings).toEqual([]);
  });
});
