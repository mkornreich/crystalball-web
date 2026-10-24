/**
 * Read-only access to the parts of an .xlsx/.xlsm package that a Crystal Ball
 * workbook needs: the sheet list, defined names (CB keeps its object → cell
 * map and per-sheet metadata in hidden names), shared strings, and cell
 * values/formulas of individual worksheets.
 */

import { ZipArchive } from './zip';
import { DataValidation, readDataValidations } from './data-validation';
import { XmlElement, childElements, decodeXString, firstChild, parseXml, textContent } from './xml';

export interface XlsxSheet {
  /** Position in the workbook's <sheets> list (what defined names' localSheetId refers to). */
  index: number;
  name: string;
  sheetId: number;
  state: 'visible' | 'hidden' | 'veryHidden';
  /** Package path of the part, e.g. "xl/worksheets/sheet2.xml" (undefined for chart sheets etc). */
  path?: string;
  kind: 'worksheet' | 'chartsheet' | 'dialogsheet' | 'macrosheet' | 'other';
}

export interface XlsxDefinedName {
  name: string;
  /** Sheet index for sheet-scoped names; undefined for workbook-scoped names. */
  localSheetId?: number;
  hidden: boolean;
  /** The raw refersTo text (no leading "="), e.g. `Model!$C$9` or `"'7.0.0.0"`. */
  refersTo: string;
}

export type CellValue = string | number | boolean | null;

export interface XlsxCell {
  /** A1 address without sheet, e.g. "C9". */
  ref: string;
  row: number; // 1-based
  col: number; // 1-based
  /** Cached value (strings resolved from the shared-string table, errors as "#REF!" text). */
  value: CellValue;
  /** True when the cached value is an error such as #REF!. */
  error?: boolean;
  /** Formula text without the leading "=" (shared-formula children get the master's text). */
  formula?: string;
  /** For a shared-formula child: the master cell's address (its formula text is not re-based). */
  sharedFrom?: string;
  arrayFormula?: boolean;
  /** For an array formula's master cell: the range it fills, e.g. "B2:B5". */
  arrayRef?: string;
  /** Index into the workbook's cell formats (styles.xml cellXfs). */
  style?: number;
}

export interface XlsxColumn {
  min: number;
  max: number;
  /** Width in characters of the default font. */
  width?: number;
  hidden: boolean;
  /** Cell format of the column's empty cells. */
  style?: number;
}

export interface XlsxRow {
  /** Height in points. */
  height?: number;
  hidden: boolean;
}

export interface XlsxWorksheet {
  name: string;
  cells: Map<string, XlsxCell>;
  /** Layout, for showing the sheet: column widths and row heights Excel saved. */
  cols: XlsxColumn[];
  rows: Map<number, XlsxRow>;
  defaultColWidth?: number;
  defaultRowHeight?: number;
  /** Excel data validation rules. */
  validations: DataValidation[];
}

/* ------------------------------ A1 helpers ------------------------------ */

export function colToLetters(col: number): string {
  let s = '';
  for (let c = col; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s;
  return s;
}

export function lettersToCol(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

export function cellRef(row: number, col: number): string {
  return colToLetters(col) + row;
}

export function parseCellRef(ref: string): { row: number; col: number } {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref.trim());
  if (!m) throw new Error(`bad cell reference "${ref}"`);
  return { col: lettersToCol(m[1]), row: parseInt(m[2], 10) };
}

/**
 * Split a reference such as `Model!$C$9`, `'My Sheet'!$B$2:$D$4` or `$C$9`
 * into its sheet name (quotes removed, '' unescaped) and the bare address.
 */
export function splitSheetRef(ref: string): { sheet?: string; address: string } {
  let s = ref.trim();
  if (s.startsWith('=')) s = s.slice(1);
  const bang = s.lastIndexOf('!');
  if (bang < 0) return { address: s };
  let sheet = s.slice(0, bang);
  if (sheet.startsWith("'") && sheet.endsWith("'")) sheet = sheet.slice(1, -1).replace(/''/g, "'");
  return { sheet, address: s.slice(bang + 1) };
}

/* ------------------------------- package ------------------------------- */

const REL_TYPE_SUFFIX: Record<string, XlsxSheet['kind']> = {
  '/worksheet': 'worksheet',
  '/chartsheet': 'chartsheet',
  '/dialogsheet': 'dialogsheet',
  '/xlMacrosheet': 'macrosheet',
};

function resolvePath(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = (baseDir ? baseDir.split('/') : []).concat(target.split('/'));
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  return out.join('/');
}

export class XlsxPackage {
  sheets: XlsxSheet[] = [];
  definedNames: XlsxDefinedName[] = [];
  sharedStrings: string[] = [];
  /** Package path of the workbook part. */
  workbookPath = 'xl/workbook.xml';
  /** Package path of the styles part, if any. */
  stylesPath?: string;
  private sheetCache = new Map<string, XlsxWorksheet>();

  private constructor(readonly zip: ZipArchive) {}

  static async open(data: Uint8Array | ArrayBuffer): Promise<XlsxPackage> {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const pkg = new XlsxPackage(new ZipArchive(bytes));
    await pkg.load();
    return pkg;
  }

  private async load(): Promise<void> {
    // Locate the workbook part via the package relationships.
    if (this.zip.has('_rels/.rels')) {
      const rels = parseXml(await this.zip.readText('_rels/.rels'));
      for (const r of childElements(rels, 'Relationship')) {
        if ((r.attrs.Type ?? '').endsWith('/officeDocument')) this.workbookPath = resolvePath('', r.attrs.Target);
      }
    }
    const wbDir = this.workbookPath.includes('/') ? this.workbookPath.slice(0, this.workbookPath.lastIndexOf('/')) : '';
    const relsPath = `${wbDir ? wbDir + '/' : ''}_rels/${this.workbookPath.slice(wbDir.length ? wbDir.length + 1 : 0)}.rels`;
    const relTargets = new Map<string, { path: string; type: string }>();
    let sharedStringsPath: string | undefined;
    if (this.zip.has(relsPath)) {
      const rels = parseXml(await this.zip.readText(relsPath));
      for (const r of childElements(rels, 'Relationship')) {
        const path = resolvePath(wbDir, r.attrs.Target ?? '');
        const type = r.attrs.Type ?? '';
        relTargets.set(r.attrs.Id, { path, type });
        if (type.endsWith('/sharedStrings')) sharedStringsPath = path;
        if (type.endsWith('/styles')) this.stylesPath = path;
      }
    }

    const wb = parseXml(await this.zip.readText(this.workbookPath));
    const sheetsEl = firstChild(wb, 'sheets');
    this.sheets = (sheetsEl ? childElements(sheetsEl, 'sheet') : []).map((s, index) => {
      const rel = relTargets.get(s.attrs.id);
      let kind: XlsxSheet['kind'] = 'other';
      for (const [suffix, k] of Object.entries(REL_TYPE_SUFFIX)) if (rel?.type.endsWith(suffix)) kind = k;
      return {
        index,
        name: decodeXString(s.attrs.name ?? ''),
        sheetId: Number(s.attrs.sheetId),
        state: (s.attrs.state as XlsxSheet['state']) ?? 'visible',
        path: rel?.path,
        kind,
      };
    });
    const namesEl = firstChild(wb, 'definedNames');
    this.definedNames = (namesEl ? childElements(namesEl, 'definedName') : []).map((d) => ({
      name: d.attrs.name ?? '',
      localSheetId: d.attrs.localSheetId !== undefined ? Number(d.attrs.localSheetId) : undefined,
      hidden: d.attrs.hidden === '1' || d.attrs.hidden === 'true',
      refersTo: decodeXString(textContent(d)),
    }));

    if (sharedStringsPath && this.zip.has(sharedStringsPath)) {
      const sst = parseXml(await this.zip.readText(sharedStringsPath));
      this.sharedStrings = childElements(sst, 'si').map(stringItemText);
    }
  }

  sheetByName(name: string): XlsxSheet | undefined {
    return this.sheets.find((s) => s.name === name) ?? this.sheets.find((s) => s.name.toLowerCase() === name.toLowerCase());
  }

  /** Defined names visible from a sheet (its sheet-scoped names first, then workbook-scoped). */
  namesFor(sheetIndex?: number): XlsxDefinedName[] {
    return this.definedNames.filter((d) => d.localSheetId === sheetIndex);
  }

  /** Look up a defined name in the given scope (sheet index) or the workbook scope. */
  definedName(name: string, sheetIndex?: number): XlsxDefinedName | undefined {
    const lower = name.toLowerCase();
    return this.definedNames.find((d) => d.localSheetId === sheetIndex && d.name.toLowerCase() === lower);
  }

  async worksheet(name: string): Promise<XlsxWorksheet> {
    const cached = this.sheetCache.get(name);
    if (cached) return cached;
    const sheet = this.sheetByName(name);
    if (!sheet || !sheet.path) throw new Error(`xlsx: no worksheet "${name}"`);
    const ws: XlsxWorksheet = { name: sheet.name, cells: new Map(), cols: [], rows: new Map(), validations: [] };
    if (sheet.kind === 'worksheet' || sheet.kind === 'macrosheet') {
      const xml = parseXml(await this.zip.readText(sheet.path));
      readLayout(xml, ws);
      ws.validations = readDataValidations(xml);
      readCells(xml, this.sharedStrings, ws);
    }
    this.sheetCache.set(name, ws);
    return ws;
  }
}

/** Text of a shared-string item / inline string (plain <t> or rich-text runs; phonetic runs ignored). */
function stringItemText(si: XmlElement): string {
  let s = '';
  for (const c of si.children) {
    if (typeof c === 'string') continue;
    if (c.name === 't') s += textContent(c);
    else if (c.name === 'r') {
      const t = firstChild(c, 't');
      if (t) s += textContent(t);
    }
  }
  return decodeXString(s);
}

const isTrue = (v: string | undefined) => v === '1' || v === 'true';

function readLayout(sheetXml: XmlElement, ws: XlsxWorksheet): void {
  const fmt = firstChild(sheetXml, 'sheetFormatPr');
  if (fmt?.attrs.defaultColWidth) ws.defaultColWidth = Number(fmt.attrs.defaultColWidth);
  else if (fmt?.attrs.baseColWidth) ws.defaultColWidth = Number(fmt.attrs.baseColWidth) + 0.71;
  if (fmt?.attrs.defaultRowHeight) ws.defaultRowHeight = Number(fmt.attrs.defaultRowHeight);
  const cols = firstChild(sheetXml, 'cols');
  for (const c of cols ? childElements(cols, 'col') : [])
    ws.cols.push({
      min: Number(c.attrs.min),
      max: Number(c.attrs.max),
      width: c.attrs.width !== undefined ? Number(c.attrs.width) : undefined,
      hidden: isTrue(c.attrs.hidden),
      style: c.attrs.style !== undefined ? Number(c.attrs.style) : undefined,
    });
}

function readCells(sheetXml: XmlElement, sst: string[], ws: XlsxWorksheet): void {
  const out = ws.cells;
  const data = firstChild(sheetXml, 'sheetData');
  if (!data) return;
  const sharedMasters = new Map<string, { text: string; ref: string }>();
  let rowNum = 0;
  for (const row of childElements(data, 'row')) {
    rowNum = row.attrs.r ? Number(row.attrs.r) : rowNum + 1;
    if (row.attrs.ht !== undefined || isTrue(row.attrs.hidden))
      ws.rows.set(rowNum, { height: row.attrs.ht !== undefined ? Number(row.attrs.ht) : undefined, hidden: isTrue(row.attrs.hidden) });
    let colNum = 0;
    for (const c of childElements(row, 'c')) {
      let r: number;
      let col: number;
      if (c.attrs.r) {
        ({ row: r, col } = parseCellRef(c.attrs.r));
      } else {
        r = rowNum;
        col = colNum + 1;
      }
      colNum = col;
      const t = c.attrs.t ?? 'n';
      const vEl = firstChild(c, 'v');
      const raw = vEl ? textContent(vEl) : undefined;
      let value: CellValue = null;
      let error = false;
      if (t === 'inlineStr') {
        const is = firstChild(c, 'is');
        value = is ? stringItemText(is) : '';
      } else if (raw !== undefined) {
        switch (t) {
          case 's':
            value = sst[Number(raw)] ?? '';
            break;
          case 'str':
            value = decodeXString(raw);
            break;
          case 'b':
            value = raw === '1' || raw === 'true';
            break;
          case 'e':
            value = raw;
            error = true;
            break;
          default:
            value = Number(raw);
        }
      }
      const cell: XlsxCell = { ref: cellRef(r, col), row: r, col, value };
      if (error) cell.error = true;
      if (c.attrs.s !== undefined && c.attrs.s !== '0') cell.style = Number(c.attrs.s);
      const f = firstChild(c, 'f');
      if (f) {
        const text = textContent(f);
        if (f.attrs.t === 'shared' && f.attrs.si !== undefined) {
          if (text) {
            sharedMasters.set(f.attrs.si, { text, ref: cell.ref });
            cell.formula = text;
          } else {
            const master = sharedMasters.get(f.attrs.si);
            if (master) {
              cell.formula = master.text;
              cell.sharedFrom = master.ref;
            }
          }
        } else if (text) {
          cell.formula = text;
          if (f.attrs.t === 'array') {
            cell.arrayFormula = true;
            if (f.attrs.ref) cell.arrayRef = f.attrs.ref;
          }
        }
      }
      out.set(cell.ref, cell);
    }
  }
}
