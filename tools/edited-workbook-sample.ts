/**
 * Write an edited copy of an example workbook (cell edits, a resized column
 * and row, and data validation rules), for checking with other readers:
 *
 *   npx vite-node tools/edited-workbook-sample.ts -- <in.xlsx> <out.xlsx>
 *   python3 tools/check-edited-workbook.py <out.xlsx>
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { XlsxPackage } from '../src/cbfile/xlsx';
import { writeEditedWorkbook } from '../src/cbfile/xlsx-write';
import { DataValidation } from '../src/cbfile/data-validation';

const [input, output] = process.argv.slice(2).filter((a) => a !== '--');
const base: DataValidation = {
  sqref: 'C6',
  type: 'list',
  operator: 'between',
  formula1: '"500,550,600"',
  allowBlank: true,
  dropdown: true,
  showInput: true,
  showError: true,
  errorStyle: 'warning',
  promptTitle: 'Rent per unit',
  prompt: 'Pick the monthly rent.',
};

async function main() {
  const pkg = await XlsxPackage.open(readFileSync(input));
  const out = await writeEditedWorkbook(
    pkg,
    [
      { sheet: 'Model', row: 6, col: 3, input: '550' },
      { sheet: 'Model', row: 9, col: 4, input: '=NORM.INV(0.5,C9,1)/C5' },
      { sheet: 'Model', row: 12, col: 2, input: 'Note & <check>' },
    ],
    [
      {
        sheet: 'Model',
        cols: new Map([[2, 40]]),
        rows: new Map([[12, 30]]),
        validations: [base, { ...base, sqref: 'C7', type: 'decimal', operator: 'greaterThanOrEqual', formula1: '0', errorStyle: 'stop' }],
      },
    ],
  );
  writeFileSync(output, out);
}

void main();
