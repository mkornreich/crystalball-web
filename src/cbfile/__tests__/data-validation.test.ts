import { describe, expect, it } from 'vitest';
import { DataValidation, dataValidationsXml, meetsRule, parseSqref, readDataValidations, ruleAt, setRule } from '../data-validation';
import { writeEditedWorkbook, patchSheetXml } from '../xlsx-write';
import { XlsxPackage } from '../xlsx';
import { parseXml } from '../xml';
import { hasOracle, oracleFile as fixture } from './oracle-files';

const rule = (over: Partial<DataValidation>): DataValidation => ({
  sqref: 'A1',
  type: 'decimal',
  operator: 'between',
  allowBlank: true,
  dropdown: true,
  showInput: true,
  showError: true,
  errorStyle: 'stop',
  ...over,
});
const constant = (f: string) => (Number.isFinite(Number(f)) ? Number(f) : f);

describe.skipIf(!hasOracle('Multi-Zone Reserves.xlsx'))("a Crystal Ball workbook's validation rules", () => {
  it('reads the correlation matrix rule of Multi-Zone Reserves', async () => {
    const pkg = await XlsxPackage.open(fixture('Multi-Zone Reserves.xlsx'));
    const all = await Promise.all(pkg.sheets.filter((s) => s.kind === 'worksheet').map((s) => pkg.worksheet(s.name)));
    const ws = all.find((w) => w.validations.length);
    expect(ws?.validations).toEqual([
      rule({
        sqref: 'B2:S19',
        formula1: '-1',
        formula2: '1',
        error: 'Correlation coefficient must be a decimal between -1 and 1',
      }),
    ]);
    const hit = ruleAt(ws!.validations, 5, 3);
    expect(hit?.dr).toBe(3);
    expect(ruleAt(ws!.validations, 1, 1)).toBeUndefined();
  });

  it('writes a changed rule back and reads it again, leaving the rest of the workbook alone', async () => {
    const pkg = await XlsxPackage.open(fixture('Multi-Zone Reserves.xlsx'));
    const sheet = (await Promise.all(pkg.sheets.map((s) => pkg.worksheet(s.name).catch(() => null)))).find((w) => w?.validations.length)!;
    const changed = [rule({ sqref: 'B2:S19', formula1: '-0.95', formula2: '0.95', errorStyle: 'warning', error: 'Keep |r| ≤ 0.95 & sane' })];
    const out = await writeEditedWorkbook(pkg, [], [{ sheet: sheet.name, validations: changed }]);
    const back = await XlsxPackage.open(out);
    expect((await back.worksheet(sheet.name)).validations).toEqual(changed);
    expect(await back.zip.read(back.workbookPath)).toEqual(await pkg.zip.read(pkg.workbookPath));
    const cleared = await writeEditedWorkbook(pkg, [], [{ sheet: sheet.name, validations: [] }]);
    const xml = await (await XlsxPackage.open(cleared)).zip.readText(pkg.sheetByName(sheet.name)!.path!);
    expect(xml).not.toMatch(/dataValidation/);
  });
});

describe('checking a value against a rule', () => {
  const ev = constant;
  it('checks numbers, whole numbers and the comparison operators', () => {
    const between = rule({ formula1: '-1', formula2: '1' });
    expect(meetsRule(between, 0.5, ev)).toBe(true);
    expect(meetsRule(between, 1.5, ev)).toBe(false);
    expect(meetsRule(between, 'high', ev)).toBe(false);
    expect(meetsRule(between, null, ev)).toBe(true);
    expect(meetsRule({ ...between, allowBlank: false }, null, ev)).toBe(false);
    expect(meetsRule({ ...between, operator: 'notBetween' }, 1.5, ev)).toBe(true);
    expect(meetsRule(rule({ type: 'whole', operator: 'greaterThanOrEqual', formula1: '0' }), 2.5, ev)).toBe(false);
    expect(meetsRule(rule({ type: 'whole', operator: 'greaterThanOrEqual', formula1: '0' }), 3, ev)).toBe(true);
    expect(meetsRule(rule({ operator: 'lessThan', formula1: 'C5' }), 10, (f) => (f === 'C5' ? 35 : NaN))).toBe(true);
    expect(meetsRule(between, { error: '#DIV/0!' }, ev)).toBe(false);
  });

  it('checks lists, text lengths, times and custom formulas', () => {
    const list = rule({ type: 'list', formula1: '"Yes,No, Maybe"' });
    expect(meetsRule(list, 'yes', ev)).toBe(true);
    expect(meetsRule(list, 'Maybe', ev)).toBe(true);
    expect(meetsRule(list, 'Perhaps', ev)).toBe(false);
    const range = rule({ type: 'list', formula1: '$F$2:$F$4' });
    expect(meetsRule(range, 20, () => [10, 20, 30])).toBe(true);
    expect(meetsRule(range, 25, () => [10, 20, 30])).toBe(false);
    expect(meetsRule(rule({ type: 'textLength', operator: 'lessThanOrEqual', formula1: '5' }), 'abcdef', ev)).toBe(false);
    expect(meetsRule(rule({ type: 'time', formula1: '0.25', formula2: '0.75' }), 0.5, ev)).toBe(true);
    expect(meetsRule(rule({ type: 'custom', formula1: 'C6>=C5' }), 600, () => true)).toBe(true);
    expect(meetsRule(rule({ type: 'custom', formula1: 'C6>=C5' }), 10, () => false)).toBe(false);
  });
});

describe('setting a rule on cells', () => {
  it('takes the cells from any rule that had them, as each cell has one rule', () => {
    const rules = [rule({ sqref: 'A1:C3' }), rule({ sqref: 'E5', type: 'whole' })];
    const out = setRule(rules, 'B2', rule({ type: 'list', formula1: '"a,b"' }), 0);
    expect(out.map((r) => [r.sqref, r.type])).toEqual([
      ['B2', 'list'],
      ['A1:C1 A3:C3 A2 C2', 'decimal'],
      ['E5', 'whole'],
    ]);
    expect(setRule(out, 'A1:E5', null)).toEqual([]);
    expect(() => parseSqref('B2:')).toThrow();
  });

  it('writes rules as Excel does, inserted where the schema puts them', () => {
    const rules = [rule({ sqref: 'C6', type: 'list', formula1: '"Low,High"', dropdown: false, prompt: 'Pick <one>' })];
    const el = dataValidationsXml(rules);
    expect(el).toBe(
      '<dataValidations count="1"><dataValidation type="list" allowBlank="1" showDropDown="1" showInputMessage="1" showErrorMessage="1" prompt="Pick &lt;one&gt;" sqref="C6"><formula1>&quot;Low,High&quot;</formula1></dataValidation></dataValidations>',
    );
    expect(readDataValidations(parseXml(`<worksheet>${el}</worksheet>`))).toEqual(rules);
    const sheet =
      '<worksheet><sheetData/><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells><pageMargins left="0.7"/>' +
      '<extLst><ext uri="{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}"><x14:dataValidations count="1"><x14:dataValidation type="list">' +
      '<x14:formula1><xm:f>Lists!$A$1:$A$3</xm:f></x14:formula1><xm:sqref>D4</xm:sqref></x14:dataValidation></x14:dataValidations></ext></extLst></worksheet>';
    expect(readDataValidations(parseXml(sheet)).map((r) => [r.sqref, r.formula1])).toEqual([['D4', 'Lists!$A$1:$A$3']]);
    const out = patchSheetXml(sheet, [], { sheet: 'S', validations: rules });
    expect(out).toBe(
      `<worksheet><sheetData></sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>${el}<pageMargins left="0.7"/></worksheet>`,
    );
  });
});
