/**
 * Turn a parsed .xlsx package into the in-browser evaluator's WorkbookData:
 * every worksheet's cached values and formulas, with Excel's shared formulas
 * re-based onto each child cell and `_xlfn.` future-function prefixes removed
 * so HyperFormula can parse them. Crystal Ball's hidden CB_DATA_ sheet is left
 * out (its formulas are deliberate #REF!s). Workbook-level defined names are
 * returned too, for the evaluator to register as named expressions.
 */

import { RawCell, WorkbookData } from '../evaluators/hyperformula-evaluator';
import { CB_DATA_SHEET } from './storage';
import { XlsxPackage, parseCellRef } from './xlsx';

export interface WorkbookContents extends WorkbookData {
  /** Non-Crystal Ball defined names: name → "Sheet!$A$1" style expression. */
  names: { name: string; expression: string; scope?: string }[];
  /** Per sheet, the plain-reference names inlined into its formulas (NAME → reference). */
  refNames: Record<string, [string, string][]>;
}

const REF = /(\$?)([A-Z]{1,3})(\$?)(\d+)/y;

function colToNum(letters: string): number {
  let c = 0;
  for (const ch of letters) c = c * 26 + (ch.charCodeAt(0) - 64);
  return c;
}
function numToCol(n: number): string {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/**
 * Shift the relative A1 references in `formula` by (dr, dc), leaving
 * $-anchored parts, string literals, function names and defined names alone.
 */
export function shiftFormula(formula: string, dr: number, dc: number): string {
  let out = '';
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i];
    if (ch === '"') {
      const end = formula.indexOf('"', i + 1);
      const stop = end < 0 ? formula.length : end + 1;
      out += formula.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'") {
      // Quoted sheet name: copy through the closing quote ('' escapes a quote).
      let j = i + 1;
      while (j < formula.length && !(formula[j] === "'" && formula[j + 1] !== "'")) j += formula[j] === "'" ? 2 : 1;
      out += formula.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const prev = i > 0 ? formula[i - 1] : '';
    if (!/[A-Za-z0-9_.]/.test(prev)) {
      REF.lastIndex = i;
      const m = REF.exec(formula);
      if (m) {
        const next = formula[REF.lastIndex] ?? '';
        if (!/[A-Za-z0-9_(.]/.test(next)) {
          const [, cAbs, col, rAbs, row] = m;
          const c = cAbs ? col : numToCol(colToNum(col) + dc);
          const r = rAbs ? row : String(Number(row) + dr);
          out += `${cAbs}${c}${rAbs}${r}`;
          i = REF.lastIndex;
          continue;
        }
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** Legacy Excel functions whose arity HyperFormula doesn't accept, and their stand-ins (excel-compat.ts). */
const LEGACY: Record<string, string> = {
  NORMSDIST: 'XLCOMPAT.NORMSDIST',
  LOGNORMDIST: 'XLCOMPAT.LOGNORMDIST',
  BETADIST: 'XLCOMPAT.BETADIST',
};

const SIMPLE_REF = /^(?:'(?:[^']|'')+'|[A-Za-z0-9_.]+)!\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?$/;

/**
 * Token-level rewrite for HyperFormula: inline names that are plain cell or
 * range references (Excel resolves them by implicit intersection, and some
 * HyperFormula functions mishandle range-valued names), turn bare TRUE/FALSE
 * into function calls, and point legacy functions at compatible versions.
 * String literals and quoted sheet names are left alone.
 */
export function rewriteFormula(f: string, refNames: Map<string, string>): string {
  let out = '';
  let i = 0;
  while (i < f.length) {
    const ch = f[i];
    if (ch === '"') {
      const end = f.indexOf('"', i + 1);
      const stop = end < 0 ? f.length : end + 1;
      out += f.slice(i, stop);
      i = stop;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      while (j < f.length && !(f[j] === "'" && f[j + 1] !== "'")) j += f[j] === "'" ? 2 : 1;
      out += f.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const prev = i > 0 ? f[i - 1] : '';
    if (/[A-Za-z_\\]/.test(ch) && !/[A-Za-z0-9_.$!:\\]/.test(prev)) {
      const m = /[A-Za-z_\\][A-Za-z0-9_.\\]*/y;
      m.lastIndex = i;
      const tok = (m.exec(f) as RegExpExecArray)[0];
      const next = f[i + tok.length] ?? '';
      const upper = tok.toUpperCase();
      let rep = tok;
      if (next === '(') rep = LEGACY[upper] ?? tok;
      else if (next === '!' || next === ':' || /^\$?[A-Za-z]{1,3}\$?\d+$/.test(tok)) rep = tok;
      else if (upper === 'TRUE' || upper === 'FALSE') rep = `${upper}()`;
      else rep = refNames.get(upper) ?? tok;
      out += rep;
      i += tok.length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export function cleanFormula(f: string): string {
  // Future-function prefixes, and the `_xll.` add-in prefix on Crystal Ball's functions.
  return f.replace(/_xlfn\.(_xlws\.)?/g, '').replace(/_xlpm\./g, '').replace(/_xll\.(?=CB\.)/gi, '');
}

/**
 * Excel's SUBTOTAL leaves out cells that are themselves SUBTOTAL/AGGREGATE
 * results (so a grand total over subtotals isn't double counted); HyperFormula
 * doesn't, so same-sheet ranges are split around those cells.
 */
export function excludeNestedSubtotals(f: string, isSubtotal: (row: number, col: number) => boolean): string {
  return f.replace(
    /\bSUBTOTAL\(\s*(\d+)\s*,\s*(\$?)([A-Z]{1,3})(\$?)(\d+):(\$?)([A-Z]{1,3})(\$?)(\d+)\s*\)/gi,
    (whole, fn: string, ...p: string[]) => {
      const c0 = colToNum(p[1].toUpperCase());
      const r0 = Number(p[3]);
      const c1 = colToNum(p[5].toUpperCase());
      const r1 = Number(p[7]);
      const parts: string[] = [];
      let skipped = false;
      for (let c = c0; c <= c1; c++) {
        let start = -1;
        for (let r = r0; r <= r1 + 1; r++) {
          const keep = r <= r1 && !isSubtotal(r, c);
          if (r <= r1 && !keep) skipped = true;
          if (keep && start < 0) start = r;
          if (!keep && start >= 0) {
            const col = numToCol(c);
            parts.push(start === r - 1 ? `${col}${start}` : `${col}${start}:${col}${r - 1}`);
            start = -1;
          }
        }
      }
      if (!skipped) return whole;
      return parts.length ? `SUBTOTAL(${fn},${parts.join(',')})` : '0';
    },
  );
}

export async function toWorkbookData(pkg: XlsxPackage): Promise<WorkbookContents> {
  const sheets: Record<string, RawCell[][]> = {};
  const refNames: Record<string, [string, string][]> = {};
  let defaultSheet = '';
  const usable = pkg.definedNames.filter(
    (d) => !/^(CB_|CBx_|CBCR_|CBWorkbook|_xlnm\.|ZZCB_)/i.test(d.name) && !d.hidden && !/#REF!|\[\d+\]/.test(d.refersTo),
  );
  // Plain-reference names, inlined per sheet (a sheet-scoped name wins).
  const globalRefs = new Map<string, string>();
  const sheetRefs = new Map<number, Map<string, string>>();
  for (const d of usable) {
    const ref = d.refersTo.replace(/^=/, '');
    if (!SIMPLE_REF.test(ref)) continue;
    if (d.localSheetId === undefined) globalRefs.set(d.name.toUpperCase(), ref);
    else {
      if (!sheetRefs.has(d.localSheetId)) sheetRefs.set(d.localSheetId, new Map());
      sheetRefs.get(d.localSheetId)?.set(d.name.toUpperCase(), ref);
    }
  }
  for (const s of pkg.sheets) {
    if (s.kind !== 'worksheet' || s.name === CB_DATA_SHEET) continue;
    const ws = await pkg.worksheet(s.name);
    const refs = new Map([...globalRefs, ...(sheetRefs.get(s.index) ?? [])]);
    refNames[s.name] = [...refs];
    const subtotalCells = new Set<string>();
    for (const cell of ws.cells.values())
      if (cell.formula && /\b(SUBTOTAL|AGGREGATE)\(/i.test(cell.formula)) subtotalCells.add(`${cell.row}:${cell.col}`);
    const rows: RawCell[][] = [];
    const spilled: { r0: number; c0: number; r1: number; c1: number }[] = [];
    for (const cell of ws.cells.values()) {
      let content: RawCell = cell.value;
      if (cell.formula !== undefined) {
        let f = cell.formula;
        if (cell.sharedFrom) {
          const master = parseCellRef(cell.sharedFrom);
          f = shiftFormula(f, cell.row - master.row, cell.col - master.col);
        }
        f = rewriteFormula(cleanFormula(f), refs);
        if (subtotalCells.size && /\bSUBTOTAL\(/i.test(f)) f = excludeNestedSubtotals(f, (r, c) => subtotalCells.has(`${r}:${c}`));
        if (cell.arrayFormula) {
          // An array (Ctrl+Shift+Enter) formula: evaluate as one, spilling over its range.
          f = `ARRAYFORMULA(${f})`;
          if (cell.arrayRef?.includes(':')) {
            const [a, b] = cell.arrayRef.split(':').map(parseCellRef);
            spilled.push({ r0: a.row, c0: a.col, r1: b.row, c1: b.col });
          }
        }
        content = `=${f}`;
      } else if (cell.error) content = null;
      const r = cell.row - 1;
      while (rows.length <= r) rows.push([]);
      rows[r][cell.col - 1] = content;
    }
    for (const a of spilled)
      for (let r = a.r0; r <= a.r1; r++)
        for (let c = a.c0; c <= a.c1; c++) if ((r !== a.r0 || c !== a.c0) && rows[r - 1]) rows[r - 1][c - 1] = null;
    for (const row of rows) for (let c = 0; c < row.length; c++) if (row[c] === undefined) row[c] = null;
    sheets[s.name] = rows;
    if (!defaultSheet) defaultSheet = s.name;
  }
  // The rest (constants and formulas) become named expressions; names that point
  // at deleted cells or other workbooks can't be evaluated here.
  const names = usable
    .filter((d) => !SIMPLE_REF.test(d.refersTo.replace(/^=/, '')))
    .map((d) => ({
      name: d.name,
      expression: `=${rewriteFormula(cleanFormula(d.refersTo.replace(/^=/, '')), globalRefs)}`,
      scope: d.localSheetId !== undefined ? pkg.sheets[d.localSheetId]?.name : undefined,
    }));
  return { sheets, defaultSheet, names, refNames };
}

/** A formula as typed (Excel syntax, no "=") → what the evaluator runs, as for the workbook's own formulas. */
export function evaluatorFormula(f: string, refNames: [string, string][] = []): string {
  return `=${rewriteFormula(cleanFormula(f), new Map(refNames))}`;
}
