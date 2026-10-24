/**
 * Edits to a workbook's cells, as a person types them in the dashboard: "=B4*2",
 * "1,250", "15%", "text", or nothing to clear. They are applied on top of the
 * workbook's contents for the in-browser evaluator, and written back into the
 * .xlsx by xlsx-write.ts.
 */

import { RawCell } from '../evaluators/hyperformula-evaluator';
import { DataValidation } from './data-validation';
import { evaluatorFormula, shiftFormula, WorkbookContents } from './workbook-data';
import { XlsxCell, parseCellRef } from './xlsx';

export interface CellEdit {
  sheet: string;
  row: number; // 1-based
  col: number; // 1-based
  /** What was typed, e.g. "=SUM(B2:B5)". */
  input: string;
}

/** What else about a sheet was changed in the dashboard: column widths, row heights, validation rules. */
export interface SheetChanges {
  sheet: string;
  /** Column (1-based) → width in characters of the default font, as Excel stores it. */
  cols?: Map<number, number>;
  /** Row (1-based) → height in points. */
  rows?: Map<number, number>;
  /** The sheet's data validation rules, when they were changed (all of them, replacing the file's). */
  validations?: DataValidation[];
}

export type ParsedInput =
  | { kind: 'formula'; text: string } // without the "="
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'string'; value: string }
  | { kind: 'empty' };

const NUMBER = /^[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?$/;

/** Read typed input the way Excel does for the common cases. */
export function parseInput(input: string): ParsedInput {
  if (input === '') return { kind: 'empty' };
  if (input.startsWith("'")) return { kind: 'string', value: input.slice(1) };
  if (input.startsWith('=') && input.length > 1) return { kind: 'formula', text: input.slice(1) };
  const t = input.trim();
  const upper = t.toUpperCase();
  if (upper === 'TRUE' || upper === 'FALSE') return { kind: 'bool', value: upper === 'TRUE' };
  const pct = t.endsWith('%');
  const body = (pct ? t.slice(0, -1) : t).replace(/^\$/, '').replace(/^([-+])\$/, '$1');
  if (body && /\d/.test(body) && NUMBER.test(body)) {
    const v = Number(body.replace(/,/g, ''));
    if (Number.isFinite(v)) return { kind: 'number', value: pct ? v / 100 : v };
  }
  return { kind: 'string', value: input };
}

/** Typed input → evaluator cell contents. */
export function toCellContent(input: string, refNames?: [string, string][]): RawCell {
  const p = parseInput(input);
  switch (p.kind) {
    case 'formula':
      return evaluatorFormula(p.text, refNames);
    case 'number':
    case 'bool':
    case 'string':
      return p.value;
    default:
      return null;
  }
}

export const editKey = (sheet: string, row: number, col: number) => `${sheet}\u0000${row}:${col}`;

/** The workbook's contents with the edits applied (edited sheets are copied, the rest shared). */
export function applyEdits(data: WorkbookContents, edits: Iterable<CellEdit>): WorkbookContents {
  const sheets = { ...data.sheets };
  const copied = new Set<string>();
  for (const e of edits) {
    if (!sheets[e.sheet]) continue;
    if (!copied.has(e.sheet)) {
      sheets[e.sheet] = sheets[e.sheet].map((row) => [...row]);
      copied.add(e.sheet);
    }
    const rows = sheets[e.sheet];
    while (rows.length < e.row) rows.push([]);
    const row = rows[e.row - 1];
    while (row.length < e.col) row.push(null);
    row[e.col - 1] = toCellContent(e.input, data.refNames?.[e.sheet]);
  }
  // Keep every row as long as the longest, as HyperFormula expects rectangular input.
  for (const name of copied) {
    const rows = sheets[name];
    const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
    for (const r of rows) while (r.length < width) r.push(null);
  }
  return { ...data, sheets };
}

/** A cell as Excel's formula bar shows it: "=formula" (file prefixes like _xlfn. removed) or its value. */
export function cellInputText(cell: XlsxCell | undefined): string {
  if (!cell) return '';
  if (cell.formula !== undefined) {
    let f = cell.formula;
    if (cell.sharedFrom) {
      const m = parseCellRef(cell.sharedFrom);
      f = shiftFormula(f, cell.row - m.row, cell.col - m.col);
    }
    return `=${f.replace(/_xlfn\.|_xll\.|_xlpm\./g, '')}`;
  }
  if (cell.error) return String(cell.value ?? '');
  if (cell.value === null) return '';
  if (typeof cell.value === 'boolean') return cell.value ? 'TRUE' : 'FALSE';
  return String(cell.value);
}
