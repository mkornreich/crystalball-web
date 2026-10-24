/**
 * Write cell edits back into an .xlsx/.xlsm package. Only the edited cells'
 * XML changes; every other part is copied byte for byte (Crystal Ball's data,
 * styles, charts, macros). Edited cells keep their style, formulas are written
 * without a cached value and the workbook is marked to recalculate on open, and
 * the calculation chain (Excel's cache of formula order) is dropped so Excel
 * rebuilds it. A shared formula whose master cell is edited is first expanded
 * into explicit formulas in the cells that shared it. Column widths and row
 * heights changed in the dashboard are written too, and so are its data
 * validation rules when they were changed.
 */

import { CellEdit, ParsedInput, SheetChanges, parseInput } from './workbook-edits';
import { DataValidation, dataValidationsXml } from './data-validation';
import { shiftFormula } from './workbook-data';
import { decodeEntities } from './xml';
import { XlsxPackage, cellRef, colToLetters, parseCellRef } from './xlsx';
import { writeZip, ZipSource } from './zip';

/** Functions Excel stores with the _xlfn. prefix (newer than Excel 2007). */
const FUTURE = new Set(
  [
    'NORM.DIST', 'NORM.INV', 'NORM.S.DIST', 'NORM.S.INV', 'LOGNORM.DIST', 'LOGNORM.INV', 'BETA.DIST', 'BETA.INV',
    'BINOM.DIST', 'BINOM.INV', 'GAMMA.DIST', 'GAMMA.INV', 'GAMMALN.PRECISE', 'T.DIST', 'T.DIST.2T', 'T.DIST.RT',
    'T.INV', 'T.INV.2T', 'CHISQ.DIST', 'CHISQ.INV', 'EXPON.DIST', 'POISSON.DIST', 'WEIBULL.DIST', 'F.DIST', 'F.INV',
    'STDEV.S', 'STDEV.P', 'VAR.S', 'VAR.P', 'PERCENTILE.INC', 'PERCENTILE.EXC', 'QUARTILE.INC', 'QUARTILE.EXC',
    'RANK.EQ', 'RANK.AVG', 'MODE.SNGL', 'MODE.MULT', 'CEILING.MATH', 'FLOOR.MATH', 'CEILING.PRECISE', 'FLOOR.PRECISE',
    'IFS', 'MAXIFS', 'MINIFS', 'SWITCH', 'CONCAT', 'TEXTJOIN', 'XLOOKUP', 'XMATCH', 'IFNA', 'XOR', 'DAYS', 'ISOWEEKNUM',
    'SEQUENCE', 'FILTER', 'SORT', 'UNIQUE', 'LET', 'COVARIANCE.P', 'COVARIANCE.S', 'CONFIDENCE.NORM', 'AGGREGATE',
  ].map((f) => f.toUpperCase()),
);

/** A formula as typed (no "=") → file syntax: _xlfn. on newer functions, _xll. on Crystal Ball's. */
export function fileFormula(f: string): string {
  let out = '';
  let i = 0;
  while (i < f.length) {
    const ch = f[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < f.length && !(f[j] === ch && f[j + 1] !== ch)) j += f[j] === ch ? 2 : 1;
      out += f.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_.]*(?=\()/.exec(f.slice(i));
    if (m && !/[A-Za-z0-9_.]/.test(f[i - 1] ?? '')) {
      const name = m[0];
      const upper = name.toUpperCase();
      if (FUTURE.has(upper)) out += `_xlfn.${name}`;
      else if (upper.startsWith('CB.')) out += `_xll.${name}`;
      else out += name;
      i += name.length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const escapeXml = (s: string) =>
  s
    .replace(/_x([0-9A-Fa-f]{4})_/g, '_x005F_x$1_')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, (c) => `_x${c.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase()}_`);

function cellXml(ref: string, style: string | undefined, p: ParsedInput): string | null {
  const s = style ? ` s="${style}"` : '';
  switch (p.kind) {
    case 'formula':
      return `<c r="${ref}"${s}><f>${escapeXml(fileFormula(p.text))}</f></c>`;
    case 'number':
      return `<c r="${ref}"${s}><v>${String(p.value)}</v></c>`;
    case 'bool':
      return `<c r="${ref}"${s} t="b"><v>${p.value ? 1 : 0}</v></c>`;
    case 'string':
      return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(p.value)}</t></is></c>`;
    default:
      return style ? `<c r="${ref}"${s}/>` : null;
  }
}

interface RowPart {
  r: number;
  attrs: string;
  cells: { col: number; xml: string }[];
  rest: string;
}

const CELL_RE = /<c\b([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g;
const ROW_RE = /<row\b([^>]*?)(\/>|>([\s\S]*?)<\/row>)/g;
const attr = (attrs: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];

/** Set column widths (characters) in the <cols> list, splitting the ranges that cover them. */
function patchCols(xml: string, widths: Map<number, number>): string {
  if (!widths.size) return xml;
  const el = /<cols>([\s\S]*?)<\/cols>|<cols\/>/.exec(xml);
  let ranges = [...(el?.[1] ?? '').matchAll(/<col\b([^>]*?)\/?>/g)].map((c) => ({
    min: Number(attr(c[1], 'min')),
    max: Number(attr(c[1], 'max')),
    attrs: c[1].replace(/\s+(min|max)="[^"]*"/g, ''),
  }));
  for (const [col, w] of [...widths].sort((a, b) => a[0] - b[0])) {
    const sized = (attrs: string) =>
      `${attrs.replace(/\s+(width|customWidth|bestFit|hidden)="[^"]*"/g, '')} width="${w}" customWidth="1"`;
    const i = ranges.findIndex((r) => r.min <= col && col <= r.max);
    if (i < 0) {
      ranges.push({ min: col, max: col, attrs: sized('') });
      continue;
    }
    const r = ranges[i];
    const parts = [];
    if (r.min < col) parts.push({ ...r, max: col - 1 });
    parts.push({ min: col, max: col, attrs: sized(r.attrs) });
    if (col < r.max) parts.push({ ...r, min: col + 1 });
    ranges.splice(i, 1, ...parts);
  }
  ranges = ranges.sort((a, b) => a.min - b.min);
  const cols = `<cols>${ranges.map((r) => `<col min="${r.min}" max="${r.max}"${r.attrs}/>`).join('')}</cols>`;
  if (el) return xml.slice(0, el.index) + cols + xml.slice(el.index + el[0].length);
  // <cols> comes just before <sheetData> in the schema's order.
  const at = xml.indexOf('<sheetData');
  return xml.slice(0, at) + cols + xml.slice(at);
}

/** Elements that follow <dataValidations> in a worksheet, in the schema's order. */
const AFTER_VALIDATIONS = [
  'hyperlinks', 'printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks', 'customProperties',
  'cellWatches', 'ignoredErrors', 'smartTags', 'drawing', 'legacyDrawing', 'legacyDrawingHF', 'drawingHF', 'picture',
  'oleObjects', 'controls', 'webPublishItems', 'tableParts', 'extLst',
];

/** Replace a worksheet's validation rules (both the main list and the Excel 2010 extension's). */
function patchValidations(xml: string, rules: DataValidation[]): string {
  let out = xml.replace(/<dataValidations\b[^>]*?(?:\/>|>[\s\S]*?<\/dataValidations>)/, '');
  // The extension that holds rules pointing at other sheets.
  out = out.replace(/<(\w+:)?ext\b[^>]*uri="\{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF\}"[^>]*>[\s\S]*?<\/(\w+:)?ext>/i, '');
  out = out.replace(/<extLst>\s*<\/extLst>/, '');
  const el = dataValidationsXml(rules, fileFormula);
  if (!el) return out;
  let at = out.lastIndexOf('</worksheet>');
  for (const name of AFTER_VALIDATIONS) {
    const m = new RegExp(`<${name}\\b`).exec(out);
    if (m && m.index < at) at = m.index;
  }
  return out.slice(0, at) + el + out.slice(at);
}

/** Apply edits (and column widths/row heights, validation rules) to one worksheet part's XML. */
export function patchSheetXml(xml: string, edits: CellEdit[], changes?: SheetChanges): string {
  const sd = /<sheetData\b([^>]*?)(\/>|>([\s\S]*?)<\/sheetData>)/.exec(xml);
  if (!sd) throw new Error('xlsx: worksheet has no sheetData');
  const rows = new Map<number, RowPart>();
  for (const m of (sd[3] ?? '').matchAll(ROW_RE)) {
    const r = Number(attr(m[1], 'r'));
    if (!Number.isFinite(r)) throw new Error('xlsx: a row without a row number');
    const content = m[3] ?? '';
    const cells: RowPart['cells'] = [];
    for (const c of content.matchAll(CELL_RE)) {
      const ref = attr(c[1], 'r');
      if (!ref) throw new Error('xlsx: a cell without a reference');
      cells.push({ col: parseCellRef(ref).col, xml: c[0] });
    }
    rows.set(r, { r, attrs: m[1], cells, rest: content.replace(CELL_RE, '') });
  }
  const cellAt = (r: number, col: number) => rows.get(r)?.cells.find((c) => c.col === col);

  // Shared formulas whose master is about to change: write them out in the other cells.
  for (const e of edits) {
    const master = cellAt(e.row, e.col);
    const f = master && /<f\b([^>]*)>([\s\S]*?)<\/f>/.exec(master.xml);
    if (!f || attr(f[1], 't') !== 'shared' || !f[2]) continue;
    const si = attr(f[1], 'si');
    const text = decodeEntities(f[2]);
    for (const row of rows.values())
      for (const c of row.cells) {
        if (c === master) continue;
        const child = /<f\b([^>]*?)(?:\/>|><\/f>)/.exec(c.xml);
        if (!child || attr(child[1], 't') !== 'shared' || attr(child[1], 'si') !== si) continue;
        const shifted = shiftFormula(text, row.r - e.row, c.col - e.col);
        c.xml = c.xml.replace(child[0], `<f>${escapeXml(shifted)}</f>`);
      }
  }

  for (const e of edits) {
    const ref = cellRef(e.row, e.col);
    let row = rows.get(e.row);
    const old = cellAt(e.row, e.col);
    const style = old ? attr(/^<c\b([^>]*?)(?:\/>|>)/.exec(old.xml)?.[1] ?? '', 's') : undefined;
    const next = cellXml(ref, style, parseInput(e.input));
    if (!row) {
      if (next === null) continue;
      row = { r: e.row, attrs: ` r="${e.row}"`, cells: [], rest: '' };
      rows.set(e.row, row);
    }
    row.attrs = row.attrs.replace(/\s+spans="[^"]*"/, ''); // an optional hint, now possibly stale
    row.cells = row.cells.filter((c) => c.col !== e.col);
    if (next !== null) row.cells.push({ col: e.col, xml: next });
    row.cells.sort((a, b) => a.col - b.col);
  }

  for (const [r, ht] of changes?.rows ?? []) {
    let row = rows.get(r);
    if (!row) {
      row = { r, attrs: ` r="${r}"`, cells: [], rest: '' };
      rows.set(r, row);
    }
    row.attrs = `${row.attrs.replace(/\s+(ht|customHeight|hidden)="[^"]*"/g, '')} ht="${ht}" customHeight="1"`;
  }

  let minR = Infinity;
  let maxR = 0;
  let minC = Infinity;
  let maxC = 0;
  const body = [...rows.values()]
    .sort((a, b) => a.r - b.r)
    .map((row) => {
      for (const c of row.cells) {
        minR = Math.min(minR, row.r);
        maxR = Math.max(maxR, row.r);
        minC = Math.min(minC, c.col);
        maxC = Math.max(maxC, c.col);
      }
      const inner = row.cells.map((c) => c.xml).join('') + row.rest;
      return inner ? `<row${row.attrs}>${inner}</row>` : `<row${row.attrs}/>`;
    })
    .join('');
  let out = xml.slice(0, sd.index) + `<sheetData${sd[1]}>${body}</sheetData>` + xml.slice(sd.index + sd[0].length);
  if (maxR > 0) {
    const dim = `${colToLetters(minC)}${minR}:${colToLetters(maxC)}${maxR}`;
    out = /<dimension\b[^>]*\/>/.test(out) ? out.replace(/<dimension\b[^>]*\/>/, `<dimension ref="${dim}"/>`) : out;
  }
  if (changes?.cols) out = patchCols(out, changes.cols);
  if (changes?.validations) out = patchValidations(out, changes.validations);
  return out;
}

/** Mark the workbook to recalculate fully when Excel opens it. */
function setFullCalcOnLoad(xml: string): string {
  const calc = /<calcPr\b([^>]*?)(\/?)>/.exec(xml);
  if (calc) {
    const attrs = /\bfullCalcOnLoad="[^"]*"/.test(calc[1])
      ? calc[1].replace(/\bfullCalcOnLoad="[^"]*"/, 'fullCalcOnLoad="1"')
      : `${calc[1]} fullCalcOnLoad="1"`;
    return xml.replace(calc[0], `<calcPr${attrs}${calc[2]}>`);
  }
  // calcPr follows definedNames (or sheets) in the schema's order.
  const after = /<\/definedNames>/.exec(xml) ?? /<\/sheets>/.exec(xml);
  if (!after) return xml;
  const at = after.index + after[0].length;
  return `${xml.slice(0, at)}<calcPr fullCalcOnLoad="1"/>${xml.slice(at)}`;
}

/** The package with the edits (and any column widths/row heights) written in, as .xlsx/.xlsm bytes. */
export async function writeEditedWorkbook(pkg: XlsxPackage, edits: CellEdit[], changes: SheetChanges[] = []): Promise<Uint8Array> {
  const changed = new Map<string, string>();
  const bySheet = new Map<string, CellEdit[]>();
  for (const e of edits) {
    if (!bySheet.has(e.sheet)) bySheet.set(e.sheet, []);
    bySheet.get(e.sheet)!.push(e);
  }
  for (const l of changes) if (!bySheet.has(l.sheet)) bySheet.set(l.sheet, []);
  for (const [name, list] of bySheet) {
    const sheet = pkg.sheetByName(name);
    if (!sheet?.path || sheet.kind !== 'worksheet') throw new Error(`xlsx: no worksheet "${name}"`);
    const sizes = changes.find((l) => l.sheet === name);
    changed.set(sheet.path, patchSheetXml(await pkg.zip.readText(sheet.path), list, sizes));
  }
  const removed = new Set<string>();
  if (edits.length) {
    changed.set(pkg.workbookPath, setFullCalcOnLoad(await pkg.zip.readText(pkg.workbookPath)));
    const dir = pkg.workbookPath.includes('/') ? pkg.workbookPath.slice(0, pkg.workbookPath.lastIndexOf('/') + 1) : '';
    const rels = `${dir}_rels/${pkg.workbookPath.slice(dir.length)}.rels`;
    if (pkg.zip.has(rels)) {
      const text = await pkg.zip.readText(rels);
      const chain = /<Relationship\b[^>]*Type="[^"]*\/calcChain"[^>]*\/>/.exec(text);
      if (chain) {
        const target = attr(chain[0], 'Target') ?? 'calcChain.xml';
        const path = target.startsWith('/') ? target.slice(1) : dir + target;
        changed.set(rels, text.replace(chain[0], ''));
        removed.add(path);
        const ct = '[Content_Types].xml';
        if (pkg.zip.has(ct)) {
          const types = await pkg.zip.readText(ct);
          changed.set(ct, types.replace(new RegExp(`<Override\\b[^>]*PartName="/${path.replace(/[.[\]]/g, '\\$&')}"[^>]*/>`), ''));
        }
      }
    }
  }
  const enc = new TextEncoder();
  const sources: ZipSource[] = [];
  for (const entry of pkg.zip.entries.values()) {
    if (removed.has(entry.name)) continue;
    const text = changed.get(entry.name);
    if (text !== undefined) sources.push({ name: entry.name, data: enc.encode(text) });
    else
      sources.push({
        name: entry.name,
        raw: pkg.zip.readRaw(entry.name),
        method: entry.method,
        crc32: entry.crc32,
        size: entry.uncompressedSize,
      });
  }
  return writeZip(sources);
}
