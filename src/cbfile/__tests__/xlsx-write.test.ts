import { describe, expect, it } from 'vitest';
import { fileFormula, patchSheetXml, writeEditedWorkbook } from '../xlsx-write';
import { readCrystalBallModel } from '../model';
import { toWorkbookData } from '../workbook-data';
import { XlsxPackage } from '../xlsx';
import { HyperFormulaEvaluator } from '../../evaluators/hyperformula-evaluator';
import { hasOracle, oracleFile, ownFile } from './oracle-files';

// The project's own Futura workbook always; Oracle's (with Crystal Ball's model and calculation chain) when present.
const WORKBOOKS: [string, () => Buffer][] = [["the project's Futura Apartments", () => ownFile('futura_apartments.xlsx')]];
if (hasOracle('Futura Apartments.xlsx')) WORKBOOKS.push(["Oracle's Futura Apartments", () => oracleFile('Futura Apartments.xlsx')]);

describe.each(WORKBOOKS)('writing edits into %s', (_, bytes) => {
  it('changes only the edited cells and keeps the Crystal Ball model', async () => {
    const pkg = await XlsxPackage.open(bytes());
    const out = await writeEditedWorkbook(pkg, [
      { sheet: 'Model', row: 6, col: 3, input: '550' },
      { sheet: 'Model', row: 9, col: 4, input: '=C9/C5' },
      { sheet: 'Model', row: 12, col: 2, input: 'Note: rent & <costs>' },
      { sheet: 'Model', row: 1, col: 7, input: '' },
    ]);
    const back = await XlsxPackage.open(out);
    const ws = await back.worksheet('Model');
    expect(ws.cells.get('C6')?.value).toBe(550);
    expect(ws.cells.get('D9')?.formula).toBe('C9/C5');
    expect(ws.cells.get('B12')?.value).toBe('Note: rent & <costs>');
    expect(ws.cells.get('G1')?.value ?? null).toBeNull();
    expect(ws.cells.get('C9')?.formula).toBe('C5*C6-C7');

    // Excel recalculates on open, without the stale calculation chain.
    expect(back.zip.has('xl/calcChain.xml')).toBe(false);
    expect(await back.zip.readText(back.workbookPath)).toMatch(/fullCalcOnLoad="1"/);
    expect(await back.zip.readText('[Content_Types].xml')).not.toMatch(/calcChain/);

    // Every part the edit didn't have to change is byte for byte the same.
    const changed = new Set([pkg.sheetByName('Model')!.path, pkg.workbookPath, 'xl/_rels/workbook.xml.rels', '[Content_Types].xml']);
    for (const name of pkg.zip.entries.keys())
      if (!changed.has(name) && back.zip.has(name)) expect(await back.zip.read(name)).toEqual(await pkg.zip.read(name));
    expect([...pkg.zip.entries.keys()].filter((n) => !back.zip.has(n))).toEqual(pkg.zip.has('xl/calcChain.xml') ? ['xl/calcChain.xml'] : []);

    // The Crystal Ball model reads back unchanged, and the edits evaluate.
    const before = (await readCrystalBallModel(bytes())).model;
    const after = (await readCrystalBallModel(out)).model;
    expect(after.assumptions).toEqual(before.assumptions);
    expect(after.forecasts).toEqual(before.forecasts);
    const ev = new HyperFormulaEvaluator(await toWorkbookData(back), ['Model!C5'], ['Model!C9', 'Model!D9']);
    expect(ev.evaluate([35])).toEqual([35 * 550 - 15000, (35 * 550 - 15000) / 35]);
    ev.dispose();
  });

  it('saves resized columns and rows without touching the calculation', async () => {
    const pkg = await XlsxPackage.open(bytes());
    const out = await writeEditedWorkbook(pkg, [], [{ sheet: 'Model', cols: new Map([[2, 40]]), rows: new Map([[9, 30]]) }]);
    const back = await XlsxPackage.open(out);
    const ws = await back.worksheet('Model');
    expect(ws.cols.find((c) => c.min <= 2 && 2 <= c.max)?.width).toBe(40);
    expect(ws.rows.get(9)?.height).toBe(30);
    expect(ws.cells.get('C9')?.formula).toBe('C5*C6-C7');
    expect(back.zip.has('xl/calcChain.xml')).toBe(pkg.zip.has('xl/calcChain.xml'));
    expect(await back.zip.read(back.workbookPath)).toEqual(await pkg.zip.read(pkg.workbookPath));
  });
});

describe('writing sheet XML', () => {
  it('expands a shared formula when its master cell changes', () => {
    const xml =
      '<worksheet><dimension ref="A1:B4"/><sheetData>' +
      '<row r="2" spans="1:2"><c r="A2"><v>1</v></c><c r="B2" s="3"><f t="shared" ref="B2:B4" si="0">A2*2</f><v>2</v></c></row>' +
      '<row r="3"><c r="A3"><v>2</v></c><c r="B3"><f t="shared" si="0"/><v>4</v></c></row>' +
      '<row r="4"><c r="A4"><v>3</v></c><c r="B4"><f t="shared" si="0"/><v>6</v></c></row>' +
      '</sheetData></worksheet>';
    const out = patchSheetXml(xml, [
      { sheet: 'S', row: 2, col: 2, input: '=A2*3' },
      { sheet: 'S', row: 6, col: 3, input: '7' },
    ]);
    expect(out).toContain('<c r="B2" s="3"><f>A2*3</f></c>');
    expect(out).toContain('<c r="B3"><f>A3*2</f><v>4</v></c>');
    expect(out).toContain('<c r="B4"><f>A4*2</f><v>6</v></c>');
    expect(out).toContain('<row r="6"><c r="C6"><v>7</v></c></row>');
    expect(out).toContain('<dimension ref="A2:C6"/>');
    expect(out).not.toContain('spans="1:2"');
  });

  it('sets column widths and row heights, splitting shared column ranges', () => {
    const xml =
      '<worksheet><sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="1" width="9.140625" style="4"/>' +
      '<col min="3" max="16384" width="9.140625" style="4"/></cols><sheetData>' +
      '<row r="2" ht="30" customHeight="1"><c r="A2"><v>1</v></c></row></sheetData></worksheet>';
    const out = patchSheetXml(xml, [], { sheet: 'S', cols: new Map([[5, 20.5], [2, 12]]), rows: new Map([[2, 45], [7, 21.75]]) });
    expect(out).toContain(
      '<cols><col min="1" max="1" width="9.140625" style="4"/><col min="2" max="2" width="12" customWidth="1"/>' +
        '<col min="3" max="4" width="9.140625" style="4"/><col min="5" max="5" style="4" width="20.5" customWidth="1"/>' +
        '<col min="6" max="16384" width="9.140625" style="4"/></cols>',
    );
    expect(out).toContain('<row r="2" ht="45" customHeight="1"><c r="A2"><v>1</v></c></row>');
    expect(out).toContain('<row r="7" ht="21.75" customHeight="1"/>');
    // A sheet without <cols> gets one just before its cells.
    expect(patchSheetXml('<worksheet><sheetData/></worksheet>', [], { sheet: 'S', cols: new Map([[1, 30]]) })).toBe(
      '<worksheet><cols><col min="1" max="1" width="30" customWidth="1"/></cols><sheetData></sheetData></worksheet>',
    );
  });

  it('writes newer and Crystal Ball functions with their file prefixes', () => {
    expect(fileFormula('NORM.INV(0.5,0,1)+CB.Normal(0,1)')).toBe('_xlfn.NORM.INV(0.5,0,1)+_xll.CB.Normal(0,1)');
    expect(fileFormula('"NORM.INV("&A1&_xlfn.STDEV.S(B1:B3)')).toBe('"NORM.INV("&A1&_xlfn.STDEV.S(B1:B3)');
    expect(fileFormula('SUM(A1:A3)')).toBe('SUM(A1:A3)');
  });
});
