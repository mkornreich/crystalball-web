/**
 * Crystal Ball 7+ "cell data" workbook storage (CBx_StorageType = 2).
 *
 * Layout of the hidden CB_DATA_ worksheet (1-based rows/cols):
 *
 *   A1  "Crystal Ball Data"
 *   row 3   "Workbook Variables" | "Last Var Column" | n
 *   row 4/5 variable names / values in columns B.. (CB rarely uses them)
 *   row 7   "Worksheet Data" | "Last Data Column Used";  B8 = last data column
 *   Each worksheet that carries CB data owns one column (column A = CB_DATA_ itself):
 *     row 11  "=<Sheet>!#REF!"    sheet back-reference (a formula, so renames follow)
 *     row 14  sheet GUID          matches that sheet's hidden name CBx_Sheet_Guid
 *     row 17  deleted-sheet count
 *     row 20  last row used in the data area
 *     rows 26… data items, 3 rows each:  block id | block text | extended data
 *   A block longer than 32767 characters (Excel's cell limit) continues in more
 *   items whose ids are "<id>-1", "<id>-2", … ; the extended data (a version tag
 *   such as "Decisioneering:7.0.0.0") is only on the first item.
 *
 * Small per-sheet "local" blocks (≤ 255 chars) live in sheet-scoped hidden
 * names instead: CB_Block_<guid32> = "'<text>" and CB_BlockExt_<guid32> =
 * "'<extended>". Crystal Ball uses guid …00 for the storage version
 * ("7.0.0.0"), …01 for a save timestamp (.NET ticks), …02 for a sheet
 * password and …03 for the build version ("11.1.3833.0" / "11.1.2.4.000").
 */

import { XlsxPackage, splitSheetRef, parseCellRef } from './xlsx';

export const CB_DATA_SHEET = 'CB_DATA_';
const DATA_ROW_SHEET_REF = 11;
const DATA_ROW_SHEET_GUID = 14;
const DATA_ROW_LAST = 20;
const DATA_ROW_START = 26;
const ROWS_PER_ITEM = 3;

export interface CbDataBlock {
  /** Block id, e.g. "CB_Block_0" (sheet preferences) or "CB_Block_7.0.0.0:1". */
  id: string;
  text: string;
  /** e.g. "Decisioneering:7.0.0.0" — the storage version that wrote the block. */
  extendedData: string;
  /** CB_DATA_ cell addresses that held the text (one per 32767-char part). */
  cells: string[];
}

export interface CbLocalBlock {
  id: string;
  text: string;
  extendedData?: string;
}

export interface CbSheetStorage {
  sheetName: string;
  sheetIndex: number;
  sheetGuid?: string;
  /** 1-based CB_DATA_ column holding the sheet's data (undefined if none found). */
  dataColumn?: number;
  /** CBx_StorageType: 1 = Office "scripts" (CB 7 on Excel 2003), 2 = CB_DATA_ cells. */
  storageType?: number;
  blocks: CbDataBlock[];
  localBlocks: CbLocalBlock[];
  /** Storage version from the …00 local block, e.g. "7.0.0.0". */
  storageVersion?: string;
  /** Build that last saved the sheet, from the …03 local block (text / extended). */
  buildVersion?: string;
  marketingVersion?: string;
  /** Save timestamp in .NET ticks, from the …01 local block. */
  timestamp?: string;
}

export interface CbStorage {
  dataSheetName: string;
  workbookVariables: Record<string, string>;
  /** CBWorkbookPriority defined name (orders workbooks when several are open). */
  workbookPriority?: number;
  sheets: CbSheetStorage[];
  warnings: string[];
}

const LOCAL_VERSION = '00000000000000000000000000000000';
const LOCAL_TIMESTAMP = '00000000000000000000000000000001';
const LOCAL_BUILD = '00000000000000000000000000000003';

/** Text of a "local" name value: `"'text"` or `="'text"` → `text`. */
export function trimNameRef(refersTo: string): string {
  let s = refersTo;
  if (s.startsWith('=')) s = s.slice(1);
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) s = s.slice(1, -1).replace(/""/g, '"');
  if (s.startsWith("'")) s = s.slice(1);
  return s;
}

/** Split "CB_Block_7.0.0.0:1-2" into its base id and part index (CellDataItem.GetItemIDAndIndex). */
export function splitItemId(id: string): { base: string; part: number } {
  const dash = id.lastIndexOf('-');
  if (dash > 1 && dash > id.length - 10 && dash < id.length - 1) {
    const suffix = id.slice(dash + 1);
    if (/^\d+$/.test(suffix)) return { base: id.slice(0, dash), part: parseInt(suffix, 10) };
  }
  return { base: id, part: 0 };
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : String(v);
}

/** Read the CB_DATA_ storage of a workbook; returns null when it carries no Crystal Ball data. */
export async function readCbStorage(pkg: XlsxPackage): Promise<CbStorage | null> {
  const dataSheet = pkg.sheetByName(CB_DATA_SHEET);
  const hasCbNames = pkg.definedNames.some((d) => d.name.startsWith('CBx_') || d.name.startsWith('CB_Block_'));
  if (!dataSheet && !hasCbNames) return null;

  const storage: CbStorage = {
    dataSheetName: dataSheet?.name ?? CB_DATA_SHEET,
    workbookVariables: {},
    sheets: [],
    warnings: [],
  };
  const prio = pkg.definedNames.find((d) => d.name === 'CBWorkbookPriority');
  if (prio && /^-?\d+$/.test(prio.refersTo.trim())) storage.workbookPriority = Number(prio.refersTo.trim());

  const ws = dataSheet ? await pkg.worksheet(dataSheet.name) : undefined;
  const at = (row: number, col: number) => ws?.cells.get(colRef(col, row));

  if (ws) {
    // Workbook variables: names in row 4, values in row 5, columns B...
    for (const cell of ws.cells.values()) {
      if (cell.row === 4 && cell.col >= 2 && cell.value !== null && cell.value !== '') {
        storage.workbookVariables[cellText(cell.value)] = cellText(at(5, cell.col)?.value);
      }
    }
  }

  // Column → sheet GUID (row 14) for every allocated data column.
  const columnGuids = new Map<string, number>();
  if (ws) {
    for (const cell of ws.cells.values()) {
      if (cell.row === DATA_ROW_SHEET_GUID && typeof cell.value === 'string' && cell.value) {
        columnGuids.set(cell.value.toLowerCase(), cell.col);
      }
    }
  }

  for (const sheet of pkg.sheets) {
    const names = pkg.namesFor(sheet.index);
    const guidName = names.find((d) => d.name === 'CBx_Sheet_Guid');
    const typeName = names.find((d) => d.name === 'CBx_StorageType');
    const refName = names.find((d) => d.name === 'CBx_SheetRef');
    const localBlocks = readLocalBlocks(names);
    if (!guidName && !typeName && !localBlocks.length) continue;

    const s: CbSheetStorage = {
      sheetName: sheet.name,
      sheetIndex: sheet.index,
      blocks: [],
      localBlocks,
    };
    if (guidName) s.sheetGuid = trimNameRef(guidName.refersTo).toLowerCase();
    if (typeName && /^\d+$/.test(typeName.refersTo.trim())) s.storageType = Number(typeName.refersTo.trim());
    for (const lb of localBlocks) {
      const key = lb.id.slice('CB_'.length);
      if (key === LOCAL_VERSION) s.storageVersion = lb.text;
      else if (key === LOCAL_TIMESTAMP) s.timestamp = lb.text;
      else if (key === LOCAL_BUILD) {
        s.buildVersion = lb.text;
        s.marketingVersion = lb.extendedData;
      }
    }

    // Find the sheet's CB_DATA_ column: by GUID (as Crystal Ball does), else via CBx_SheetRef.
    let col = s.sheetGuid ? columnGuids.get(s.sheetGuid) : undefined;
    if (col === undefined && refName) {
      try {
        const { sheet: refSheet, address } = splitSheetRef(refName.refersTo);
        if (!refSheet || refSheet === storage.dataSheetName) col = parseCellRef(address).col;
      } catch {
        /* ignore malformed refs */
      }
    }
    if (col !== undefined && ws) {
      s.dataColumn = col;
      const sheetRef = at(DATA_ROW_SHEET_REF, col)?.formula;
      if (sheetRef) {
        // Crystal Ball writes `=Sheet!#REF!` on purpose (the sheet part follows renames).
        const { sheet: refSheet } = splitSheetRef(sheetRef.replace(/!#REF!?$/, '!A1'));
        if (refSheet && refSheet !== sheet.name) {
          storage.warnings.push(`CB_DATA_ column ${col} refers to sheet "${refSheet}" but its GUID matches "${sheet.name}"`);
        }
      }
      s.blocks = readColumnBlocks(ws.cells, col, storage.warnings, storage.dataSheetName);
    } else if (s.storageType === 2) {
      storage.warnings.push(`sheet "${sheet.name}": no CB_DATA_ column found for its GUID`);
    } else if (s.storageType === 1) {
      storage.warnings.push(`sheet "${sheet.name}": uses the legacy Office-scripts storage (not supported)`);
    }
    storage.sheets.push(s);
  }
  return storage;
}

function colRef(col: number, row: number): string {
  let s = '';
  for (let c = col; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s;
  return s + row;
}

function readLocalBlocks(names: { name: string; refersTo: string }[]): CbLocalBlock[] {
  const out: CbLocalBlock[] = [];
  for (const n of names) {
    const m = /^CB_Block_([0-9a-fA-F]{32})$/.exec(n.name);
    if (!m) continue;
    const ext = names.find((x) => x.name === `CB_BlockExt_${m[1]}`);
    const block: CbLocalBlock = { id: `CB_${m[1].toLowerCase()}`, text: trimNameRef(n.refersTo) };
    if (ext) block.extendedData = trimNameRef(ext.refersTo);
    out.push(block);
  }
  return out;
}

function readColumnBlocks(
  cells: Map<string, { row: number; col: number; value: unknown }>,
  col: number,
  warnings: string[],
  dataSheetName: string,
): CbDataBlock[] {
  const lastUsedRaw = cells.get(colRef(col, DATA_ROW_LAST))?.value;
  let lastRow = typeof lastUsedRaw === 'number' ? lastUsedRaw : 0;
  if (lastRow < DATA_ROW_START) {
    // No (valid) "last row used": scan whatever the column holds.
    for (const c of cells.values()) if (c.col === col && c.row > lastRow) lastRow = c.row;
  }
  const itemCount = Math.ceil((lastRow - DATA_ROW_START + 1) / ROWS_PER_ITEM);
  const parts = new Map<string, { block: CbDataBlock; pieces: { part: number; text: string; cell: string }[] }>();
  for (let i = 0; i < itemCount; i++) {
    const row = DATA_ROW_START + ROWS_PER_ITEM * i;
    const id = cellText(cells.get(colRef(col, row))?.value);
    if (!id) continue;
    const { base, part } = splitItemId(id);
    let entry = parts.get(base);
    if (!entry) {
      entry = { block: { id: base, text: '', extendedData: '', cells: [] }, pieces: [] };
      parts.set(base, entry);
    }
    const dataCell = colRef(col, row + 1);
    entry.pieces.push({ part, text: cellText(cells.get(dataCell)?.value), cell: `${dataSheetName}!${dataCell}` });
    if (part === 0) entry.block.extendedData = cellText(cells.get(colRef(col, row + 2))?.value);
  }
  const blocks: CbDataBlock[] = [];
  for (const { block, pieces } of parts.values()) {
    pieces.sort((a, b) => a.part - b.part);
    pieces.forEach((p, i) => {
      if (p.part !== i) warnings.push(`block ${block.id}: missing part ${i}`);
    });
    block.text = pieces.map((p) => p.text).join('');
    block.cells = pieces.map((p) => p.cell);
    blocks.push(block);
  }
  return blocks;
}
