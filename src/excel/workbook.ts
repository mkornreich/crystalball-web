/**
 * Office.js bridge: everything that touches the real workbook.
 *
 *  - `readWorkbook` mirrors every sheet's used range (formulas + literals,
 *    anchored at A1) into the plain `WorkbookData` the HyperFormula evaluator
 *    consumes.
 *  - `getSelectedCell` returns the active cell's full A1 reference plus a
 *    suggested name (the text in the cell to its left, as Crystal Ball does).
 *  - `markCell` / `clearMark` tint assumption and forecast cells so the model
 *    is readable at a glance.
 *  - `loadState` / `saveState` persist the add-in's assumptions, forecasts,
 *    correlations and run settings in the document so they survive save/reopen.
 */

import { WorkbookData, RawCell } from '../evaluators/hyperformula-evaluator';

declare const Excel: any;
declare const Office: any;

const SETTINGS_KEY = 'crystalball.state.v1';

export const ASSUMPTION_COLOR = '#C6E8C6'; // soft green
export const FORECAST_COLOR = '#BBD7F0'; // soft blue

/** Mirror the whole workbook for the in-browser engine. */
export async function readWorkbook(): Promise<WorkbookData> {
  const sheets: Record<string, RawCell[][]> = {};
  let defaultSheet = '';

  await Excel.run(async (context: any) => {
    const worksheets = context.workbook.worksheets;
    worksheets.load('items/name');
    const active = context.workbook.getActiveWorksheet();
    active.load('name');
    await context.sync();

    defaultSheet = active.name;

    const blocks: { name: string; range: any }[] = [];
    for (const ws of worksheets.items) {
      const used = ws.getUsedRangeOrNullObject(true);
      used.load(['rowIndex', 'columnIndex', 'rowCount', 'columnCount', 'isNullObject']);
      blocks.push({ name: ws.name, range: used });
    }
    await context.sync();

    // For each non-empty sheet, re-read an A1-anchored block so the array
    // lines up with HyperFormula's 0-based, A1-origin addressing.
    const anchored: { name: string; range: any }[] = [];
    for (const { name, range } of blocks) {
      if (range.isNullObject) {
        sheets[name] = [[]];
        continue;
      }
      const lastRow = range.rowIndex + range.rowCount;
      const lastCol = range.columnIndex + range.columnCount;
      const ws = worksheets.items.find((w: any) => w.name === name);
      const block = ws.getRangeByIndexes(0, 0, lastRow, lastCol);
      block.load('formulas');
      anchored.push({ name, range: block });
    }
    await context.sync();

    for (const { name, range } of anchored) {
      sheets[name] = range.formulas as RawCell[][];
    }
  });

  return { sheets, defaultSheet };
}

export interface SelectedCell {
  address: string; // full A1, e.g. "Model!B4"
  name: string; // suggested display name
}

/** The active cell's reference and a suggested name from its left neighbor. */
export async function getSelectedCell(): Promise<SelectedCell> {
  let address = '';
  let name = '';
  await Excel.run(async (context: any) => {
    const sel = context.workbook.getSelectedRange();
    sel.load(['address', 'rowIndex', 'columnIndex', 'worksheet']);
    await context.sync();

    address = sel.address; // includes sheet name
    if (sel.columnIndex > 0) {
      const ws = sel.worksheet;
      const left = ws.getRangeByIndexes(sel.rowIndex, sel.columnIndex - 1, 1, 1);
      left.load('text');
      await context.sync();
      const label = left.text?.[0]?.[0];
      if (label && typeof label === 'string') name = label.trim();
    }
  });
  if (!name) name = address.includes('!') ? address.split('!')[1] : address;
  return { address, name };
}

/** Tint a cell to show it's an assumption or forecast. */
export async function markCell(address: string, color: string): Promise<void> {
  await Excel.run(async (context: any) => {
    const range = rangeFromAddress(context, address);
    range.format.fill.color = color;
    await context.sync();
  });
}

/** Remove any tint from a cell. */
export async function clearMark(address: string): Promise<void> {
  await Excel.run(async (context: any) => {
    const range = rangeFromAddress(context, address);
    range.format.fill.clear();
    await context.sync();
  });
}

/** Select and scroll a cell into view (used from the assumptions list). */
export async function gotoCell(address: string): Promise<void> {
  await Excel.run(async (context: any) => {
    const range = rangeFromAddress(context, address);
    range.select();
    await context.sync();
  });
}

function rangeFromAddress(context: any, address: string): any {
  const bang = address.lastIndexOf('!');
  if (bang < 0) {
    return context.workbook.worksheets.getActiveWorksheet().getRange(address);
  }
  let sheet = address.slice(0, bang);
  if (sheet.startsWith("'") && sheet.endsWith("'")) {
    sheet = sheet.slice(1, -1).replace(/''/g, "'");
  }
  return context.workbook.worksheets.getItem(sheet).getRange(address.slice(bang + 1));
}

/* --------------------------- persisted state --------------------------- */

export function loadState<T>(): T | null {
  try {
    const raw = Office.context.document.settings.get(SETTINGS_KEY);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function saveState<T>(state: T): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      Office.context.document.settings.set(SETTINGS_KEY, JSON.stringify(state));
      Office.context.document.settings.saveAsync((res: any) => {
        if (res.status === Office.AsyncResultStatus.Succeeded) resolve();
        else reject(res.error);
      });
    } catch (e) {
      reject(e);
    }
  });
}
