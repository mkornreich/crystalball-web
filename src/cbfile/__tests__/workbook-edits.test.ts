import { describe, expect, it } from 'vitest';
import { applyEdits, cellInputText, parseInput } from '../workbook-edits';
import { toWorkbookData } from '../workbook-data';
import { XlsxPackage } from '../xlsx';
import { HyperFormulaEvaluator } from '../../evaluators/hyperformula-evaluator';
import { ownFile } from './oracle-files';

const futura = () => XlsxPackage.open(ownFile('futura_apartments.xlsx'));

describe('typed cell input', () => {
  it('reads numbers, percentages, booleans, text and formulas as Excel does', () => {
    expect(parseInput('=A1*2')).toEqual({ kind: 'formula', text: 'A1*2' });
    expect(parseInput('1,250')).toEqual({ kind: 'number', value: 1250 });
    expect(parseInput('$1,000.50')).toEqual({ kind: 'number', value: 1000.5 });
    expect(parseInput('15%')).toEqual({ kind: 'number', value: 0.15 });
    expect(parseInput(' -3.5e2 ')).toEqual({ kind: 'number', value: -350 });
    expect(parseInput('true')).toEqual({ kind: 'bool', value: true });
    expect(parseInput("'123")).toEqual({ kind: 'string', value: '123' });
    expect(parseInput('1.2.3')).toEqual({ kind: 'string', value: '1.2.3' });
    expect(parseInput('')).toEqual({ kind: 'empty' });
  });
});

describe('editing a workbook for the evaluator', () => {
  it('recalculates the model with the edits applied', async () => {
    const pkg = await futura();
    const data = await toWorkbookData(pkg);
    const edited = applyEdits(data, [
      { sheet: 'Model', row: 6, col: 3, input: '600' },
      { sheet: 'Model', row: 9, col: 4, input: '=C9*2' },
    ]);
    const ev = new HyperFormulaEvaluator(edited, ['Model!C5'], ['Model!C9', 'Model!D9']);
    expect(ev.evaluate([35])).toEqual([35 * 600 - 15000, 2 * (35 * 600 - 15000)]);
    ev.dispose();
    // The original contents are untouched.
    expect(data.sheets.Model[5][2]).toBe(500);
  });

  it("shows a cell as Excel's formula bar does", async () => {
    const ws = await (await futura()).worksheet('Model');
    expect(cellInputText(ws.cells.get('C9'))).toBe('=C5*C6-C7');
    expect(cellInputText(ws.cells.get('C6'))).toBe('500');
    expect(cellInputText(ws.cells.get('B9'))).toBe('Profit or Loss');
    expect(cellInputText(undefined)).toBe('');
  });
});
