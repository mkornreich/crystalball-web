/**
 * The parts of a workbook's cell formats (styles.xml) needed to show its
 * cells as Excel does: the number format code, bold/italic, wrapping and
 * horizontal alignment of each cellXfs entry.
 */

import { XlsxPackage } from './xlsx';
import { childElements, firstChild, parseXml } from './xml';
import { BUILTIN_FORMATS } from './number-format';

export interface CellFormat {
  /** Number format code, e.g. `"$"#,##0.00_);\("$"#,##0.00\)` or "General". */
  numFmt: string;
  bold: boolean;
  italic: boolean;
  wrap: boolean;
  /** Horizontal alignment when set: left, center, right, fill, justify… */
  align?: string;
}

export const GENERAL_FORMAT: CellFormat = { numFmt: 'General', bold: false, italic: false, wrap: false };

/** Cell formats by cellXfs index (a cell's `s` attribute). */
export async function readCellFormats(pkg: XlsxPackage): Promise<CellFormat[]> {
  if (!pkg.stylesPath || !pkg.zip.has(pkg.stylesPath)) return [GENERAL_FORMAT];
  const doc = parseXml(await pkg.zip.readText(pkg.stylesPath));
  const custom = new Map<number, string>();
  const numFmts = firstChild(doc, 'numFmts');
  for (const n of numFmts ? childElements(numFmts, 'numFmt') : []) custom.set(Number(n.attrs.numFmtId), n.attrs.formatCode ?? 'General');
  const fontsEl = firstChild(doc, 'fonts');
  const fonts = (fontsEl ? childElements(fontsEl, 'font') : []).map((f) => ({
    bold: on(firstChild(f, 'b')?.attrs.val),
    italic: on(firstChild(f, 'i')?.attrs.val),
    present: { b: !!firstChild(f, 'b'), i: !!firstChild(f, 'i') },
  }));
  const xfsEl = firstChild(doc, 'cellXfs');
  const xfs = xfsEl ? childElements(xfsEl, 'xf') : [];
  if (!xfs.length) return [GENERAL_FORMAT];
  return xfs.map((xf) => {
    const id = Number(xf.attrs.numFmtId ?? 0);
    const font = fonts[Number(xf.attrs.fontId ?? 0)];
    const al = firstChild(xf, 'alignment');
    return {
      numFmt: custom.get(id) ?? BUILTIN_FORMATS[id] ?? 'General',
      bold: !!font?.present.b && font.bold,
      italic: !!font?.present.i && font.italic,
      wrap: al?.attrs.wrapText === '1' || al?.attrs.wrapText === 'true',
      align: al?.attrs.horizontal && al.attrs.horizontal !== 'general' ? al.attrs.horizontal : undefined,
    };
  });
}

/** A boolean font property: present with no val, or val="1"/"true". */
const on = (val: string | undefined) => val === undefined || val === '1' || val === 'true';
