/**
 * The dashboard's workbook view: the workbook's worksheets as an Excel-like
 * grid you can edit. Values recalculate as you type (a HyperFormula instance
 * holds the workbook with the edits applied), cells show with the workbook's
 * own number formats, column widths and row heights, and Crystal Ball's cells
 * are coloured as Crystal Ball colours them: assumptions green, forecasts
 * blue, decision variables yellow.
 *
 * Columns and rows resize by dragging their header edges (double-click an
 * edge to fit the contents), and those sizes are saved with the edits. A
 * number too wide for its column shows as ##### and text that's cut off shows
 * in full on hover, as in Excel.
 *
 * Typed values are checked before they're kept: a formula must parse, a
 * Crystal Ball assumption or decision variable cell must hold a number, a
 * forecast's formula isn't replaced by a constant without asking, and the
 * cell's Excel data validation rule (from the workbook, or set here in the
 * Data Validation dialog) is applied with its Stop, Warning or Information
 * alert. A rule's input message shows when its cell is selected, list rules
 * get Excel's in-cell dropdown, and Circle Invalid Data marks the cells whose
 * values break their rules.
 *
 * Only the rows and columns in view are in the DOM, so large sheets scroll
 * as quickly as small ones.
 */

import { CellEdit, SheetChanges, cellInputText, editKey, parseInput, toCellContent } from '../cbfile/workbook-edits';
import { WorkbookContents, evaluatorFormula, shiftFormula } from '../cbfile/workbook-data';
import {
  CellRange,
  CheckValue,
  DataValidation,
  FormulaEval,
  describeRule,
  listItems,
  meetsRule,
  parseSqref,
  setRule,
} from '../cbfile/data-validation';
import { AlertOptions, editRule, showAlert } from './validation-dialog';
import { XlsxPackage, XlsxWorksheet, colToLetters, parseCellRef, splitSheetRef } from '../cbfile/xlsx';
import { CellFormat, GENERAL_FORMAT, readCellFormats } from '../cbfile/xlsx-styles';
import { formatValue } from '../cbfile/number-format';
import { HyperFormulaEvaluator, RawCell } from '../evaluators/hyperformula-evaluator';

export type MarkKind = 'assumption' | 'forecast' | 'decision';
export interface CellMark {
  kind: MarkKind;
  label: string;
}

export interface GridHost {
  pkg: XlsxPackage;
  data: WorkbookContents;
  /** Crystal Ball's cells, by editKey(sheet, row, col). */
  marks: Map<string, CellMark>;
  /** Called after every change: to cells, or only to column widths/row heights. */
  onEdit(kind: 'cells' | 'layout'): void;
}

export interface GridElements {
  tabs: HTMLElement;
  /** The scrolling container (focusable). */
  grid: HTMLElement;
  name: HTMLInputElement;
  bar: HTMLInputElement;
  /** For validation alerts and the Data Validation dialog. */
  alert: HTMLDialogElement;
  ruleDialog: HTMLDialogElement;
  /** A line about the sheet's validation rules. */
  status: HTMLElement;
}

interface SheetView {
  name: string;
  ws: XlsxWorksheet;
  rows: number[]; // visible row numbers, 1-based
  cols: number[];
  rowTop: number[]; // px, prefix sums (length rows.length + 1)
  colLeft: number[];
  colStyle: Map<number, number>;
}

type Axis = 'col' | 'row';

type Change =
  | { kind: 'cell'; sheet: string; row: number; col: number; before?: CellEdit; after?: CellEdit }
  /** A column width or row height in px; undefined is the workbook's own size. */
  | { kind: 'size'; sheet: string; axis: Axis; index: number; before?: number; after?: number }
  | { kind: 'rules'; sheet: string; before: DataValidation[]; after: DataValidation[] };

/** A cell's validation rule, with the cell's offset from the rule's first cell. */
interface RuleHit {
  rule: DataValidation;
  index: number;
  dr: number;
  dc: number;
}

const HEAD_H = 22;
const ROWHEAD_W = 46;
const MIN_ROWS = 60;
const MIN_COLS = 16;

/** Excel column width (characters of the default font) → pixels, for an 11pt Calibri sheet. */
const colPx = (w: number) => Math.max(0, Math.min(900, Math.floor(w * 7 + 5)));
/** Row height in points → pixels. */
const rowPx = (pt: number) => Math.max(0, Math.round((pt * 4) / 3));

/** Largest i with prefix[i] <= x, clamped to a valid row/column index. */
function indexAt(prefix: number[], x: number): number {
  let lo = 0;
  let hi = prefix.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (prefix[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

const FONT = "13px system-ui, -apple-system, 'Segoe UI', sans-serif";
/** Horizontal padding plus border of a cell. */
const CELL_PAD = 9;
const LINE_H = 18;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

export class WorkbookGrid {
  /** The edits, by editKey. */
  readonly edits = new Map<string, CellEdit>();
  private undoStack: Change[][] = [];
  private ev: HyperFormulaEvaluator;
  private formats: CellFormat[] = [GENERAL_FORMAT];
  private worksheets = new Map<string, XlsxWorksheet>();
  private view: SheetView | null = null;
  private sel = { row: 1, col: 1 };
  private lastSel = new Map<string, { row: number; col: number }>();
  private editing: { mode: 'enter' | 'edit'; row: number; col: number } | null = null;
  private barCell: { sheet: string; row: number; col: number; orig: string } | null = null;
  private table: HTMLElement;
  private editor: HTMLInputElement;
  private frame = 0;
  private resize: ResizeObserver | null = null;
  /** Column widths and row heights set here, in px, by sheet. */
  private sizes = new Map<string, Record<Axis, Map<number, number>>>();
  private drag: { axis: Axis; index: number; start: number; startPx: number; before?: number; px: number } | null = null;
  private measure = document.createElement('canvas').getContext('2d');
  private widths = new Map<string, number>();
  /** Data validation rules by sheet: the file's until changed here. */
  private rules = new Map<string, DataValidation[]>();
  private ruleIndex = new Map<string, { rule: DataValidation; index: number; ranges: CellRange[] }[]>();
  /** Whether each checked cell meets its rule, until the next change. */
  private okCache = new Map<string, boolean>();
  private circle = false;
  private note: HTMLElement;
  private dropBtn: HTMLButtonElement;
  private listBox: HTMLElement;
  private list: { items: CheckValue[]; active: number; row: number; col: number } | null = null;
  private readonly sheets: string[];
  private readonly listeners: [EventTarget, string, EventListener][] = [];

  private constructor(
    private host: GridHost,
    private els: GridElements,
    edits: CellEdit[],
  ) {
    for (const e of edits) this.edits.set(editKey(e.sheet, e.row, e.col), e);
    const { pkg, data } = host;
    this.sheets = pkg.sheets.filter((s) => s.state === 'visible' && data.sheets[s.name]).map((s) => s.name);
    if (!this.sheets.length) this.sheets = Object.keys(data.sheets);
    this.ev = new HyperFormulaEvaluator(data, [], []);
    for (const e of edits) this.ev.setCell(e.sheet, e.row, e.col, toCellContent(e.input, data.refNames[e.sheet]));
    els.grid.innerHTML = '';
    this.table = document.createElement('div');
    this.editor = document.createElement('input');
    this.editor.className = 'cell-editor';
    this.editor.hidden = true;
    this.editor.spellcheck = false;
    this.editor.autocomplete = 'off';
    this.editor.setAttribute('aria-label', 'Edit cell');
    this.note = document.createElement('div');
    this.note.className = 'dv-note';
    this.note.hidden = true;
    this.note.setAttribute('role', 'note');
    this.dropBtn = document.createElement('button');
    this.dropBtn.type = 'button';
    this.dropBtn.className = 'dv-drop';
    this.dropBtn.tabIndex = -1;
    this.dropBtn.hidden = true;
    this.dropBtn.setAttribute('aria-label', 'Show the list of allowed values (Alt+Down)');
    this.dropBtn.textContent = '▾';
    this.listBox = document.createElement('div');
    this.listBox.className = 'dv-list';
    this.listBox.setAttribute('role', 'listbox');
    this.listBox.hidden = true;
    els.grid.append(this.table, this.editor, this.note, this.dropBtn, this.listBox);
    this.wire();
  }

  /** Show the workbook in the given elements, starting with these edits (from an earlier view). */
  static async create(host: GridHost, els: GridElements, edits: CellEdit[] = []): Promise<WorkbookGrid> {
    const g = new WorkbookGrid(host, els, edits);
    g.formats = await readCellFormats(host.pkg);
    await g.showSheet(g.sheets[0]);
    return g;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  editList(): CellEdit[] {
    return [...this.edits.values()];
  }

  /** Columns and rows resized here. */
  get resizedCount(): number {
    let n = 0;
    for (const s of this.sizes.values()) n += s.col.size + s.row.size;
    return n;
  }

  /** The resized columns and rows, in the units Excel stores (characters and points). */
  layout(): SheetChanges[] {
    const out = new Map<string, SheetChanges>();
    for (const [sheet, s] of this.sizes)
      if (s.col.size || s.row.size)
        out.set(sheet, {
          sheet,
          // The smallest width (in Excel's 1/256 steps) that is still this many pixels.
          cols: new Map([...s.col].map(([c, px]) => [c, Math.ceil(((px - 5) / 7) * 256) / 256])),
          rows: new Map([...s.row].map(([r, px]) => [r, Math.round(px * 3) / 4])),
        });
    for (const sheet of this.rulesChangedOn()) {
      const entry = out.get(sheet) ?? { sheet };
      entry.validations = this.rules.get(sheet) ?? [];
      out.set(sheet, entry);
    }
    return [...out.values()];
  }

  /** Sheets whose validation rules were changed here. */
  rulesChangedOn(): string[] {
    return [...this.rules]
      .filter(([sheet, list]) => JSON.stringify(list) !== JSON.stringify(this.worksheets.get(sheet)?.validations ?? []))
      .map(([sheet]) => sheet);
  }

  /** Turn Circle Invalid Data on or off; returns whether it's on. */
  toggleCircle(on = !this.circle): boolean {
    this.circle = on;
    this.render();
    this.updateStatus();
    return on;
  }

  /** Edited cells on a sheet. */
  editsOn(sheet: string): number {
    let n = 0;
    for (const e of this.edits.values()) if (e.sheet === sheet) n++;
    return n;
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    this.resize?.disconnect();
    for (const [t, type, fn] of this.listeners) t.removeEventListener(type, fn);
    this.ev.dispose();
    this.els.grid.innerHTML = '';
    this.els.tabs.innerHTML = '';
  }

  /* ---------------------------- editing ---------------------------- */

  /** Set a cell to typed input ("" clears it). Typing the cell's original contents removes the edit. */
  edit(sheet: string, row: number, col: number, input: string): boolean {
    const key = editKey(sheet, row, col);
    const before = this.edits.get(key);
    const orig = this.originalText(sheet, row, col);
    const after = input === orig ? undefined : { sheet, row, col, input };
    if (before?.input === after?.input) return false;
    const change: Change = { kind: 'cell', sheet, row, col, before, after };
    this.undoStack.push([change]);
    this.apply([change], true);
    return true;
  }

  /** Set a column's width or a row's height on the sheet in view (px; undefined restores the workbook's). */
  resizeTo(axis: Axis, index: number, px: number | undefined): void {
    const v = this.view;
    if (!v) return;
    const before = this.sizesOf(v.name)[axis].get(index);
    if (before === px) return;
    const change: Change = { kind: 'size', sheet: v.name, axis, index, before, after: px };
    this.undoStack.push([change]);
    this.apply([change], true);
  }

  private sizesOf(sheet: string): Record<Axis, Map<number, number>> {
    let s = this.sizes.get(sheet);
    if (!s) this.sizes.set(sheet, (s = { col: new Map(), row: new Map() }));
    return s;
  }

  private setSize(sheet: string, axis: Axis, index: number, px: number | undefined): void {
    const m = this.sizesOf(sheet)[axis];
    if (px === undefined) m.delete(index);
    else m.set(index, px);
  }

  /** The current size in px of a column or row in view. */
  private sizeInView(axis: Axis, index: number): number {
    const v = this.view;
    if (!v) return 0;
    const [list, prefix] = axis === 'col' ? [v.cols, v.colLeft] : [v.rows, v.rowTop];
    const i = list.indexOf(index);
    return i < 0 ? 0 : prefix[i + 1] - prefix[i];
  }

  undo(): void {
    const changes = this.undoStack.pop();
    if (!changes) return;
    this.apply(changes, false);
    const last = changes[changes.length - 1];
    if (last.kind === 'cell') void this.showSheet(last.sheet, { row: last.row, col: last.col });
    else if (last.sheet !== this.view?.name) void this.showSheet(last.sheet);
  }

  /** Drop every edit and every resized column and row (one step to undo). */
  revertAll(): void {
    const changes: Change[] = [...this.edits.values()].map((e) => ({ kind: 'cell', sheet: e.sheet, row: e.row, col: e.col, before: e }));
    for (const [sheet, s] of this.sizes)
      for (const axis of ['col', 'row'] as const)
        for (const [index, px] of s[axis]) changes.push({ kind: 'size', sheet, axis, index, before: px });
    for (const sheet of this.rulesChangedOn())
      changes.push({ kind: 'rules', sheet, before: this.rules.get(sheet) ?? [], after: this.worksheets.get(sheet)?.validations ?? [] });
    if (!changes.length) return;
    this.undoStack.push(changes);
    this.apply(changes, true);
  }

  private apply(changes: Change[], forward: boolean): void {
    const refNames = this.host.data.refNames;
    let cells = false;
    this.okCache.clear();
    for (const ch of changes) {
      if (ch.kind === 'rules') {
        this.rules.set(ch.sheet, forward ? ch.after : ch.before);
        this.ruleIndex.delete(ch.sheet);
        continue;
      }
      if (ch.kind === 'size') {
        this.setSize(ch.sheet, ch.axis, ch.index, forward ? ch.after : ch.before);
        if (this.view?.name === ch.sheet) this.view = this.buildView(ch.sheet, this.view.ws, this.sel);
        continue;
      }
      cells = true;
      const e = forward ? ch.after : ch.before;
      const key = editKey(ch.sheet, ch.row, ch.col);
      if (e) this.edits.set(key, e);
      else this.edits.delete(key);
      const content = e ? toCellContent(e.input, refNames[ch.sheet]) : this.originalContent(ch.sheet, ch.row, ch.col);
      this.ev.setCell(ch.sheet, ch.row, ch.col, content);
    }
    this.renderTabs();
    this.render();
    this.updateBar();
    this.updateStatus();
    this.host.onEdit(cells ? 'cells' : 'layout');
  }

  /** Undo the change just made (a value a validation alert turned back). */
  private undoLast(): void {
    const changes = this.undoStack.pop();
    if (changes) this.apply(changes, false);
  }

  /* --------------------------- validation --------------------------- */

  /** A sheet's rules with their parsed ranges. */
  private indexOf(sheet: string): { rule: DataValidation; index: number; ranges: CellRange[] }[] {
    let idx = this.ruleIndex.get(sheet);
    if (!idx) {
      idx = (this.rules.get(sheet) ?? []).flatMap((rule, index) => {
        try {
          return [{ rule, index, ranges: parseSqref(rule.sqref) }];
        } catch {
          return [];
        }
      });
      this.ruleIndex.set(sheet, idx);
    }
    return idx;
  }

  private ruleFor(sheet: string, row: number, col: number): RuleHit | undefined {
    for (const e of this.indexOf(sheet))
      if (e.ranges.some((g) => g.r0 <= row && row <= g.r1 && g.c0 <= col && col <= g.c1))
        return { rule: e.rule, index: e.index, dr: row - e.ranges[0].r0, dc: col - e.ranges[0].c0 };
    return undefined;
  }

  /** Evaluate a rule's formulas as Excel does: relative references move with the cell; a range gives its values. */
  private evalFor(sheet: string, hit: RuleHit): FormulaEval {
    return (f) => {
      const shifted = shiftFormula(f, hit.dr, hit.dc);
      return this.readRange(sheet, shifted) ?? this.ev.calculate(evaluatorFormula(shifted, this.host.data.refNames[sheet]), sheet);
    };
  }

  /** The values of a range reference (or a name for one), or null if it isn't one. */
  private readRange(sheet: string, ref: string): CheckValue[] | null {
    let r = ref.trim();
    const named = this.host.data.refNames[sheet]?.find(([n]) => n === r.toUpperCase());
    if (named) r = named[1];
    if (!/^(?:(?:'(?:[^']|'')+'|[A-Za-z0-9_.]+)!)?\$?[A-Za-z]{1,3}\$?\d+:\$?[A-Za-z]{1,3}\$?\d+$/.test(r)) return null;
    const { sheet: s, address } = splitSheetRef(r);
    const target = s ? Object.keys(this.host.data.sheets).find((n) => n.toLowerCase() === s.toLowerCase()) : sheet;
    if (!target) return [{ error: '#REF!' }];
    const g = parseSqref(address)[0];
    if ((g.r1 - g.r0 + 1) * (g.c1 - g.c0 + 1) > 20000) return [{ error: '#VALUE!' }];
    const out: CheckValue[] = [];
    for (let row = g.r0; row <= g.r1; row++) for (let col = g.c0; col <= g.c1; col++) out.push(this.ev.cellValue(target, row, col));
    return out;
  }

  /** Whether a cell's value meets its rule (undefined when it has none). */
  private meets(sheet: string, row: number, col: number): boolean | undefined {
    const hit = this.ruleFor(sheet, row, col);
    if (!hit || hit.rule.type === 'none') return undefined;
    const key = editKey(sheet, row, col);
    let ok = this.okCache.get(key);
    if (ok === undefined) {
      ok = meetsRule(hit.rule, this.ev.cellValue(sheet, row, col), this.evalFor(sheet, hit));
      this.okCache.set(key, ok);
    }
    return ok;
  }

  private alertBox(o: AlertOptions): Promise<string> {
    return showAlert(this.els.alert, o);
  }

  /**
   * Check typed input and keep it if it passes: the formula must parse, a
   * Crystal Ball assumption or decision variable needs a number, a forecast's
   * formula isn't replaced by a constant without asking, and the cell's
   * validation rule applies with its alert. 'retry' means go back to editing.
   */
  private async commitChecked(sheet: string, row: number, col: number, input: string): Promise<'kept' | 'retry' | 'cancel'> {
    const current = this.inputText(sheet, row, col);
    if (input === current) return 'kept';
    const p = parseInput(input);
    const back = (answer: string) => (answer === 'retry' ? 'retry' : 'cancel');
    if (p.kind === 'formula' && !this.ev.isValidFormula(evaluatorFormula(p.text, this.host.data.refNames[sheet]))) {
      return back(
        await this.alertBox({
          style: 'stop',
          title: "There's a problem with this formula",
          message:
            'Check for a missing bracket or quote, an operator with nothing after it, or a mistyped reference. ' +
            "To enter text that starts with \"=\", type an apostrophe first: '=",
          buttons: [['Retry', 'retry'], ['Cancel', 'cancel']],
        }),
      );
    }
    const mark = this.host.marks.get(editKey(sheet, row, col));
    if (mark && mark.kind !== 'forecast' && p.kind !== 'number') {
      const what = p.kind === 'formula' ? 'a formula' : p.kind === 'empty' ? 'an empty cell' : p.kind === 'bool' ? 'TRUE or FALSE' : 'text';
      const role = mark.kind === 'assumption' ? 'assumption' : 'decision variable';
      return back(
        await this.alertBox({
          style: 'stop',
          title: `This cell is a Crystal Ball ${role}`,
          message:
            `${mark.label.split(' — ')[0]}.\nA Crystal Ball ${role} cell must hold a number: it's the ${
              role === 'assumption' ? "assumption's base value, which every trial replaces with a sample" : "variable's starting value"
            }. Crystal Ball can't use ${what} here.`,
          buttons: [['Retry', 'retry'], ['Cancel', 'cancel']],
        }),
      );
    }
    if (mark?.kind === 'forecast' && p.kind !== 'formula' && current.startsWith('=')) {
      const answer = await this.alertBox({
        style: 'warning',
        title: 'Replace a forecast formula?',
        message: `${mark.label}.\nWith a constant in place of its formula (${current}), every trial gives this forecast the same value.`,
        question: 'Continue?',
        buttons: [['Yes', 'yes'], ['No', 'retry'], ['Cancel', 'cancel']],
      });
      if (answer !== 'yes') return back(answer);
    }
    const changed = this.edit(sheet, row, col, input);
    const hit = this.ruleFor(sheet, row, col);
    if (!changed || !hit || !hit.rule.showError || p.kind === 'empty' || this.meets(sheet, row, col) !== false) return 'kept';
    const r = hit.rule;
    const answer = await this.alertBox({
      style: r.errorStyle,
      title: r.errorTitle ?? (r.errorStyle === 'stop' ? 'Invalid entry' : 'Check this value'),
      message: r.error ?? `This value doesn't match the data validation rule for this cell: it must be ${describeRule(r)}.`,
      question: r.errorStyle === 'warning' ? 'Continue?' : undefined,
      buttons:
        r.errorStyle === 'stop'
          ? [['Retry', 'retry'], ['Cancel', 'cancel']]
          : r.errorStyle === 'warning'
            ? [['Yes', 'yes'], ['No', 'retry'], ['Cancel', 'cancel']]
            : [['OK', 'yes'], ['Cancel', 'cancel']],
    });
    if (answer === 'yes') return 'kept';
    this.undoLast();
    return back(answer);
  }

  /** Open the Data Validation dialog for the selected cell (or its rule's cells). */
  async editValidation(): Promise<void> {
    const v = this.view;
    if (!v || !(await this.finishEdit())) return;
    const hit = this.ruleFor(v.name, this.sel.row, this.sel.col);
    const res = await editRule(this.els.ruleDialog, {
      sqref: hit?.rule.sqref ?? `${colToLetters(this.sel.col)}${this.sel.row}`,
      rule: hit?.rule,
      checkSqref: (sq) => {
        try {
          return parseSqref(sq).length ? null : 'Enter the cells the rule applies to, such as C6 or B2:B9.';
        } catch {
          return `"${sq}" isn't a list of cells. Use references such as C6, B2:B9, or both separated by a space.`;
        }
      },
      checkFormula: (f) => this.ev.isValidFormula(evaluatorFormula(f, this.host.data.refNames[v.name])),
    });
    this.els.grid.focus({ preventScroll: true });
    if (!res) return;
    const before = this.rules.get(v.name) ?? [];
    const after = res.action === 'save' ? setRule(before, res.sqref, res.rule, hit?.index) : setRule(before, res.sqref, null);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const change: Change = { kind: 'rules', sheet: v.name, before, after };
    this.undoStack.push([change]);
    this.apply([change], true);
  }

  /** The status line: how many rules the sheet has, and with Circle Invalid Data on, how many cells break them. */
  private updateStatus(): void {
    const v = this.view;
    const el = this.els.status;
    if (!v) return;
    const idx = this.indexOf(v.name);
    if (!idx.length) {
      el.textContent = this.circle ? `No validation rules on ${v.name}.` : '';
      return;
    }
    const rules = `${idx.length} validation rule${idx.length === 1 ? '' : 's'} on ${v.name}`;
    if (!this.circle) {
      el.textContent = `${rules}.`;
      return;
    }
    const lastRow = v.rows[v.rows.length - 1];
    const lastCol = v.cols[v.cols.length - 1];
    let bad = 0;
    for (const e of idx)
      for (const g of e.ranges)
        for (let r = g.r0; r <= Math.min(g.r1, lastRow); r++)
          for (let c = g.c0; c <= Math.min(g.c1, lastCol); c++) if (this.meets(v.name, r, c) === false) bad++;
    el.textContent = bad
      ? `${rules} · ${bad} cell${bad === 1 ? " doesn't" : "s don't"} meet ${bad === 1 ? 'its rule' : 'their rules'} (circled).`
      : `${rules} · every validated cell meets its rule.`;
  }

  /** The selected cell's input message and list dropdown. */
  private updateAids(): void {
    const v = this.view;
    const r = v ? this.ruleFor(v.name, this.sel.row, this.sel.col)?.rule : undefined;
    const box = this.cellBox(this.sel.row, this.sel.col);
    const note = !!(r && box && r.showInput && (r.promptTitle || r.prompt));
    this.note.hidden = !note;
    if (note && r && box) {
      this.note.innerHTML = (r.promptTitle ? `<b>${esc(r.promptTitle)}</b>` : '') + (r.prompt ? `<span>${esc(r.prompt)}</span>` : '');
      Object.assign(this.note.style, { left: `${box.x + Math.min(box.w, 48)}px`, top: `${box.y + box.h + 6}px` });
    }
    const drop = !!(r && box && r.type === 'list' && r.dropdown);
    this.dropBtn.hidden = !drop;
    if (drop && box) Object.assign(this.dropBtn.style, { left: `${box.x + box.w}px`, top: `${box.y}px`, height: `${box.h}px` });
    if (!drop || (this.list && (this.list.row !== this.sel.row || this.list.col !== this.sel.col))) this.closeList();
  }

  private openList(): void {
    const v = this.view;
    const hit = v ? this.ruleFor(v.name, this.sel.row, this.sel.col) : undefined;
    const box = this.cellBox(this.sel.row, this.sel.col);
    if (!v || !hit || hit.rule.type !== 'list' || !box) return;
    const items = listItems(hit.rule, this.evalFor(v.name, hit));
    const cur = this.ev.cellValue(v.name, this.sel.row, this.sel.col);
    const text = (x: CheckValue) => (x !== null && typeof x === 'object' ? x.error : typeof x === 'boolean' ? (x ? 'TRUE' : 'FALSE') : String(x ?? ''));
    const active = Math.max(0, items.findIndex((x) => text(x).toLowerCase() === text(cur as CheckValue).toLowerCase()));
    this.list = { items, active, row: this.sel.row, col: this.sel.col };
    this.listBox.innerHTML = items.length
      ? items.map((x, i) => `<div role="option" data-i="${i}" aria-selected="${i === active}">${esc(text(x))}</div>`).join('')
      : '<div class="sub">The list is empty.</div>';
    Object.assign(this.listBox.style, { left: `${box.x}px`, top: `${box.y + box.h}px`, minWidth: `${box.w + 18}px` });
    this.listBox.hidden = false;
    this.note.hidden = true;
  }

  private closeList(): void {
    this.list = null;
    this.listBox.hidden = true;
  }

  private moveList(d: number): void {
    const l = this.list;
    if (!l || !l.items.length) return;
    l.active = Math.max(0, Math.min(l.items.length - 1, l.active + d));
    this.listBox.querySelectorAll('[role="option"]').forEach((o, i) => o.setAttribute('aria-selected', String(i === l.active)));
    this.listBox.children[l.active]?.scrollIntoView({ block: 'nearest' });
  }

  private async pickFromList(i: number): Promise<void> {
    const l = this.list;
    const v = this.view;
    if (!l || !v || i < 0 || i >= l.items.length) return;
    this.closeList();
    const x = l.items[i];
    const input = typeof x === 'boolean' ? (x ? 'TRUE' : 'FALSE') : String(x);
    // Text that would otherwise read as a number or formula keeps its type.
    const typed = typeof x === 'string' && parseInput(x).kind !== 'string' ? `'${x}` : input;
    await this.commitChecked(v.name, l.row, l.col, typed);
    this.els.grid.focus({ preventScroll: true });
  }

  private originalContent(sheet: string, row: number, col: number): RawCell {
    return this.host.data.sheets[sheet]?.[row - 1]?.[col - 1] ?? null;
  }

  private originalText(sheet: string, row: number, col: number): string {
    const ws = this.worksheets.get(sheet);
    return ws ? cellInputText(ws.cells.get(`${colToLetters(col)}${row}`)) : '';
  }

  /** What the formula bar shows for a cell. */
  private inputText(sheet: string, row: number, col: number): string {
    return this.edits.get(editKey(sheet, row, col))?.input ?? this.originalText(sheet, row, col);
  }

  /* ----------------------------- sheets ----------------------------- */

  private async showSheet(name: string, at?: { row: number; col: number }): Promise<void> {
    if (!(await this.finishEdit())) return;
    if (this.view && this.view.name !== name) this.lastSel.set(this.view.name, { ...this.sel });
    let ws = this.worksheets.get(name);
    if (!ws) {
      ws = await this.host.pkg.worksheet(name);
      this.worksheets.set(name, ws);
    }
    if (!this.rules.has(name)) this.rules.set(name, ws.validations);
    const switching = this.view?.name !== name;
    this.view = this.buildView(name, ws, at);
    this.sel = at ?? (switching ? this.lastSel.get(name) : this.sel) ?? { row: 1, col: 1 };
    if (switching && !at) {
      this.els.grid.scrollTop = 0;
      this.els.grid.scrollLeft = 0;
    }
    this.renderTabs();
    this.select(this.sel.row, this.sel.col);
    this.updateStatus();
  }

  private buildView(name: string, ws: XlsxWorksheet, include?: { row: number; col: number }): SheetView {
    const data = this.host.data.sheets[name] ?? [];
    let maxRow = data.length;
    let maxCol = data.reduce((m, r) => Math.max(m, r.length), 0);
    for (const c of ws.cells.values()) {
      maxRow = Math.max(maxRow, c.row);
      maxCol = Math.max(maxCol, c.col);
    }
    for (const e of this.edits.values())
      if (e.sheet === name) {
        maxRow = Math.max(maxRow, e.row);
        maxCol = Math.max(maxCol, e.col);
      }
    if (include) {
      maxRow = Math.max(maxRow, include.row);
      maxCol = Math.max(maxCol, include.col);
    }
    maxRow = Math.min(1048576, Math.max(MIN_ROWS, maxRow + 30));
    maxCol = Math.min(16384, Math.max(MIN_COLS, maxCol + 6));

    const defW = colPx(ws.defaultColWidth ?? 8.43);
    const set = this.sizes.get(name);
    const widths = new Map<number, number>();
    const hiddenCols = new Set<number>();
    const colStyle = new Map<number, number>();
    for (const c of ws.cols) {
      for (let k = c.min; k <= Math.min(c.max, maxCol); k++) {
        if (c.hidden) hiddenCols.add(k);
        if (c.width !== undefined) widths.set(k, colPx(c.width));
        if (c.style) colStyle.set(k, c.style);
      }
    }
    const cols: number[] = [];
    const colLeft = [0];
    for (let k = 1; k <= maxCol; k++) {
      const own = set?.col.get(k);
      const w = own ?? widths.get(k) ?? defW;
      if (own === undefined && (hiddenCols.has(k) || w === 0)) continue;
      cols.push(k);
      colLeft.push(colLeft[colLeft.length - 1] + w);
    }
    const defH = rowPx(ws.defaultRowHeight ?? 15) || 20;
    const rows: number[] = [];
    const rowTop = [0];
    for (let r = 1; r <= maxRow; r++) {
      const info = ws.rows.get(r);
      const own = set?.row.get(r);
      const h = own ?? (info?.height !== undefined ? rowPx(info.height) : defH);
      if (own === undefined && (info?.hidden || h === 0)) continue;
      rows.push(r);
      rowTop.push(rowTop[rowTop.length - 1] + h);
    }
    return { name, ws, rows, cols, rowTop, colLeft, colStyle };
  }

  private renderTabs(): void {
    const cur = this.view?.name;
    this.els.tabs.innerHTML = this.sheets
      .map((s) => {
        const n = this.editsOn(s);
        return `<button type="button" role="tab" data-sheet="${esc(s)}" aria-selected="${s === cur}">${esc(s)}${
          n ? `<span class="tab-edits" title="${n} edited cell${n === 1 ? '' : 's'}">${n}</span>` : ''
        }</button>`;
      })
      .join('');
  }

  /* ----------------------------- drawing ---------------------------- */

  private schedule(): void {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.render());
  }

  /** Width in px of text in the grid's font. */
  private textWidth(text: string, bold: boolean): number {
    const key = (bold ? '\u0001' : '') + text;
    let w = this.widths.get(key);
    if (w === undefined) {
      if (!this.measure) return text.length * 7;
      this.measure.font = bold ? `700 ${FONT}` : FONT;
      w = this.measure.measureText(text).width;
      if (this.widths.size > 20000) this.widths.clear();
      this.widths.set(key, w);
    }
    return w;
  }

  /** Lines wrapped text takes in a column of this width (a little generous, as words don't break evenly). */
  private wrappedLines(text: string, bold: boolean, width: number): number {
    const avail = Math.max(1, width - CELL_PAD);
    return text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil((this.textWidth(line, bold) * 1.06) / avail)), 0);
  }

  /** Fit a column to the widest value in it (wrapped cells don't count, as in Excel). */
  private autofitCol(col: number): void {
    const v = this.view;
    if (!v) return;
    let need = 0;
    for (const r of v.rows) {
      const c = this.cell(v, r, col);
      if (c.text && !c.cls.includes('wrap')) need = Math.max(need, this.textWidth(c.text, c.cls.includes('b')));
    }
    this.resizeTo('col', col, need ? Math.ceil(need) + CELL_PAD + 3 : colPx(v.ws.defaultColWidth ?? 8.43));
  }

  /** Fit a row to its tallest cell (wrapped text over as many lines as it takes). */
  private autofitRow(row: number): void {
    const v = this.view;
    if (!v) return;
    let lines = 1;
    for (const col of v.cols) {
      const c = this.cell(v, row, col);
      if (c.text && c.cls.includes('wrap')) lines = Math.max(lines, this.wrappedLines(c.text, c.cls.includes('b'), this.sizeInView('col', col)));
    }
    this.resizeTo('row', row, lines === 1 ? rowPx(v.ws.defaultRowHeight ?? 15) || 20 : lines * LINE_H + 3);
  }

  private format(ws: XlsxWorksheet, row: number, col: number, v: SheetView): CellFormat {
    const style = ws.cells.get(`${colToLetters(col)}${row}`)?.style ?? v.colStyle.get(col) ?? 0;
    return this.formats[style] ?? GENERAL_FORMAT;
  }

  /** A cell's text and classes. */
  private cell(v: SheetView, row: number, col: number): { text: string; cls: string[]; align?: string; invalid?: string } {
    const value = this.ev.cellValue(v.name, row, col);
    const fmt = this.format(v.ws, row, col, v);
    const cls: string[] = [];
    let text: string;
    if (value !== null && typeof value === 'object') {
      text = value.error;
      cls.push('err');
    } else {
      text = formatValue(value, fmt.numFmt);
      cls.push(typeof value === 'number' ? 'num' : typeof value === 'boolean' ? 'bool' : 'txt');
    }
    if (fmt.bold) cls.push('b');
    if (fmt.italic) cls.push('i');
    if (fmt.wrap) cls.push('wrap');
    const key = editKey(v.name, row, col);
    const mark = this.host.marks.get(key);
    if (mark) cls.push(`cb-${mark.kind}`);
    if (this.edits.has(key)) cls.push('edited');
    let invalid: string | undefined;
    if (this.circle && this.meets(v.name, row, col) === false) {
      cls.push('invalid');
      const r = this.ruleFor(v.name, row, col)?.rule;
      invalid = r ? `Doesn't meet its validation rule: must be ${describeRule(r)}.` : undefined;
    }
    const align = fmt.align === 'center' || fmt.align === 'right' || fmt.align === 'left' ? fmt.align : undefined;
    return { text, cls, align, invalid };
  }

  private render(): void {
    const v = this.view;
    if (!v) return;
    const g = this.els.grid;
    const h = g.clientHeight || 480;
    const w = g.clientWidth || 900;
    const r0 = Math.max(0, indexAt(v.rowTop, g.scrollTop - HEAD_H) - 2);
    const r1 = Math.min(v.rows.length - 1, indexAt(v.rowTop, g.scrollTop - HEAD_H + h) + 2);
    const c0 = Math.max(0, indexAt(v.colLeft, g.scrollLeft - ROWHEAD_W) - 1);
    const c1 = Math.min(v.cols.length - 1, indexAt(v.colLeft, g.scrollLeft - ROWHEAD_W + w) + 1);
    const nCols = v.cols.length;
    const padL = v.colLeft[c0];
    const padR = v.colLeft[nCols] - v.colLeft[c1 + 1];
    const totalW = ROWHEAD_W + v.colLeft[nCols];

    let html = `<table class="sheet" style="width:${totalW}px"><colgroup><col style="width:${ROWHEAD_W}px">`;
    if (padL) html += `<col style="width:${padL}px">`;
    for (let j = c0; j <= c1; j++) html += `<col style="width:${v.colLeft[j + 1] - v.colLeft[j]}px">`;
    if (padR) html += `<col style="width:${padR}px">`;
    html += '</colgroup><thead><tr><th class="corner"></th>';
    if (padL) html += '<th></th>';
    for (let j = c0; j <= c1; j++) {
      const c = v.cols[j];
      html += `<th scope="col"${c === this.sel.col ? ' class="hl"' : ''}>${colToLetters(c)}<span class="rs rs-c" data-col="${c}" title="Drag to resize · double-click to fit"></span></th>`;
    }
    if (padR) html += '<th></th>';
    html += '</tr></thead><tbody>';
    const span = 1 + (padL ? 1 : 0) + (c1 - c0 + 1) + (padR ? 1 : 0);
    if (v.rowTop[r0] > 0) html += `<tr class="pad" style="height:${v.rowTop[r0]}px"><td colspan="${span}"></td></tr>`;
    for (let i = r0; i <= r1; i++) {
      const r = v.rows[i];
      const rh = v.rowTop[i + 1] - v.rowTop[i];
      const cells = [];
      for (let j = c0; j <= Math.min(nCols - 1, c1 + 1); j++) cells.push(this.cell(v, r, v.cols[j]));
      html += `<tr data-r="${r}" style="height:${rh}px"${rh < 19 ? ` class="short"` : ''}><th scope="row"${r === this.sel.row ? ' class="hl"' : ''}>${r}<span class="rs rs-r" data-row="${r}" title="Drag to resize · double-click to fit"></span></th>`;
      if (padL) html += '<td class="padc"></td>';
      for (let j = c0; j <= c1; j++) {
        const c = v.cols[j];
        const { text, cls, align, invalid } = cells[j - c0];
        const cw = v.colLeft[j + 1] - v.colLeft[j];
        const wrap = cls.includes('wrap');
        // Left-aligned text runs on over empty neighbours, as in Excel.
        if (cls.includes('txt') && !wrap && (!align || align === 'left') && text && cells[j - c0 + 1]?.text === '') cls.push('spill');
        // Text that doesn't fit shows in full on hover; a number that doesn't fit shows as ####, as in Excel.
        let shown = text;
        let cut = false;
        if (text && !cls.includes('spill')) {
          const bold = cls.includes('b');
          cut = wrap
            ? this.wrappedLines(text, bold, cw) * LINE_H > rh
            : text.length * 13 > cw - CELL_PAD && this.textWidth(text, bold) > cw - CELL_PAD; // 13px: wider than any character
          if (cut && cls.includes('num')) shown = '#'.repeat(Math.max(1, Math.floor((cw - CELL_PAD) / this.textWidth('#', bold))));
        }
        if (r === this.sel.row && c === this.sel.col) cls.push('sel');
        const mark = this.host.marks.get(editKey(v.name, r, c));
        const tip = [mark?.label, cut ? text : '', invalid].filter(Boolean).join('\n');
        const title = tip ? ` title="${esc(tip)}"` : '';
        const style = align ? ` style="text-align:${align}"` : '';
        const body = wrap ? `<div class="wrapbox" style="max-height:${rh - 1}px">${esc(shown)}</div>` : esc(shown);
        html += `<td data-c="${c}" class="${cls.join(' ')}"${style}${title}>${body}</td>`;
      }
      if (padR) html += '<td class="padc"></td>';
      html += '</tr>';
    }
    const below = v.rowTop[v.rows.length] - v.rowTop[r1 + 1];
    if (below > 0) html += `<tr class="pad" style="height:${below}px"><td colspan="${span}"></td></tr>`;
    html += '</tbody></table>';
    this.table.innerHTML = html;
    if (this.editing) this.placeEditor();
    this.updateAids();
  }

  /* ---------------------------- selection --------------------------- */

  private cellBox(row: number, col: number): { x: number; y: number; w: number; h: number } | null {
    const v = this.view;
    if (!v) return null;
    const i = v.rows.indexOf(row);
    const j = v.cols.indexOf(col);
    if (i < 0 || j < 0) return null;
    return {
      x: ROWHEAD_W + v.colLeft[j],
      y: HEAD_H + v.rowTop[i],
      w: v.colLeft[j + 1] - v.colLeft[j],
      h: v.rowTop[i + 1] - v.rowTop[i],
    };
  }

  private select(row: number, col: number): void {
    const v = this.view;
    if (!v) return;
    row = Math.max(1, Math.min(1048576, row));
    col = Math.max(1, Math.min(16384, col));
    if (row > v.rows[v.rows.length - 1] - 10 || col > v.cols[v.cols.length - 1] - 3) this.view = this.buildView(v.name, v.ws, { row, col });
    this.sel = { row, col };
    const box = this.cellBox(row, col);
    if (box) {
      const g = this.els.grid;
      if (box.y - HEAD_H < g.scrollTop) g.scrollTop = box.y - HEAD_H;
      else if (box.y + box.h > g.scrollTop + g.clientHeight) g.scrollTop = box.y + box.h - g.clientHeight;
      if (box.x - ROWHEAD_W < g.scrollLeft) g.scrollLeft = box.x - ROWHEAD_W;
      else if (box.x + box.w > g.scrollLeft + g.clientWidth) g.scrollLeft = box.x + box.w - g.clientWidth;
    }
    this.render();
    this.updateBar();
  }

  /** Move the selection by visible rows/columns (skipping hidden ones). */
  private move(dr: number, dc: number): void {
    const v = this.view;
    if (!v) return;
    const step = (list: number[], cur: number, d: number) => {
      if (!d) return cur;
      let i = list.indexOf(cur);
      if (i < 0) i = list.findIndex((x) => x > cur);
      return list[Math.max(0, Math.min(list.length - 1, i + d))] ?? cur;
    };
    this.select(step(v.rows, this.sel.row, dr), step(v.cols, this.sel.col, dc));
  }

  private updateBar(): void {
    const v = this.view;
    if (!v) return;
    this.els.name.value = `${colToLetters(this.sel.col)}${this.sel.row}`;
    if (document.activeElement !== this.els.bar) this.els.bar.value = this.inputText(v.name, this.sel.row, this.sel.col);
    const mark = this.host.marks.get(editKey(v.name, this.sel.row, this.sel.col));
    this.els.name.title = mark?.label ?? '';
  }

  /** Go to a reference typed in the name box: "C9" or "Model!C9". */
  private async goTo(text: string): Promise<void> {
    try {
      const { sheet, address } = splitSheetRef(text);
      const { row, col } = parseCellRef(address.split(':')[0]);
      const target = sheet ? this.sheets.find((s) => s.toLowerCase() === sheet.toLowerCase()) : this.view?.name;
      if (!target) throw new Error('no such sheet');
      await this.showSheet(target, { row, col });
      this.els.grid.focus({ preventScroll: true });
    } catch {
      this.updateBar();
    }
  }

  /* ------------------------------ editor ---------------------------- */

  private startEdit(mode: 'enter' | 'edit', initial?: string, selectAll = false): void {
    const v = this.view;
    if (!v) return;
    this.closeList();
    this.editing = { mode, row: this.sel.row, col: this.sel.col };
    this.editor.value = initial ?? this.inputText(v.name, this.sel.row, this.sel.col);
    this.editor.hidden = false;
    this.placeEditor();
    this.editor.focus({ preventScroll: true });
    const end = this.editor.value.length;
    this.editor.setSelectionRange(selectAll ? 0 : end, end);
    this.els.bar.value = this.editor.value;
  }

  private placeEditor(): void {
    if (!this.editing) return;
    const box = this.cellBox(this.editing.row, this.editing.col);
    if (!box) return;
    Object.assign(this.editor.style, {
      left: `${box.x}px`,
      top: `${box.y}px`,
      minWidth: `${Math.max(box.w, 60)}px`,
      height: `${Math.max(box.h, 20)}px`,
    });
  }

  /**
   * Close the in-cell editor or the formula bar, checking what was typed and
   * keeping it if it passes. Resolves false when the person went back to fix
   * it (Retry) or dropped it (Cancel), so the caller shouldn't move on.
   */
  private async finishEdit(): Promise<boolean> {
    let at: { sheet: string; row: number; col: number } | null = null;
    let text = '';
    if (this.editing && this.view) {
      at = { sheet: this.view.name, row: this.editing.row, col: this.editing.col };
      text = this.editor.value;
      this.editing = null;
      this.editor.hidden = true;
    } else if (this.barCell) {
      const b = this.barCell;
      this.barCell = null;
      text = this.els.bar.value;
      if (text === b.orig) {
        this.updateBar();
        return true;
      }
      at = b;
    }
    if (!at) return true;
    const res = await this.commitChecked(at.sheet, at.row, at.col, text);
    if (res === 'kept') return true;
    if (res === 'retry') {
      if (at.sheet !== this.view?.name) await this.showSheet(at.sheet, at);
      else this.select(at.row, at.col);
      this.startEdit('edit', text, true);
    } else {
      this.updateBar();
      this.els.grid.focus({ preventScroll: true });
    }
    return false;
  }

  private cancelEditor(): void {
    this.editing = null;
    this.editor.hidden = true;
    this.updateBar();
    this.els.grid.focus({ preventScroll: true });
  }

  /* ------------------------------ events ---------------------------- */

  private on<K extends keyof HTMLElementEventMap>(t: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void): void {
    t.addEventListener(type, fn as EventListener);
    this.listeners.push([t, type, fn as EventListener]);
  }

  private wire(): void {
    const { grid, tabs, name, bar } = this.els;
    this.on(grid, 'scroll', () => this.schedule());
    this.on(grid, 'mousedown', (e) => {
      const td = (e.target as HTMLElement).closest('td[data-c]');
      const tr = td?.parentElement as HTMLElement | null;
      if (!td || !tr?.dataset.r) return;
      e.preventDefault();
      const row = Number(tr.dataset.r);
      const col = Number((td as HTMLElement).dataset.c);
      void this.finishEdit().then((ok) => {
        if (!ok) return;
        this.select(row, col);
        grid.focus({ preventScroll: true });
      });
    });
    // The list rule's dropdown.
    this.on(this.dropBtn, 'mousedown', (e) => e.preventDefault());
    this.on(this.dropBtn, 'click', () => {
      if (this.list) this.closeList();
      else this.openList();
      grid.focus({ preventScroll: true });
    });
    this.on(this.listBox, 'mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const opt = (e.target as HTMLElement).closest<HTMLElement>('[role="option"]');
      if (opt) void this.pickFromList(Number(opt.dataset.i));
    });
    this.on(grid, 'dblclick', (e) => {
      const edge = (e.target as HTMLElement).closest<HTMLElement>('.rs');
      if (edge) {
        if (edge.dataset.col) this.autofitCol(Number(edge.dataset.col));
        else this.autofitRow(Number(edge.dataset.row));
      } else if ((e.target as HTMLElement).closest('td[data-c]')) this.startEdit('edit');
    });
    // Resizing: drag a header's edge; the size updates as you drag and is one step to undo.
    this.on(grid, 'pointerdown', (e) => {
      const edge = (e.target as HTMLElement).closest<HTMLElement>('.rs');
      const v = this.view;
      if (!edge || !v || e.button !== 0) return;
      e.preventDefault();
      void this.finishEdit();
      const axis: Axis = edge.dataset.col ? 'col' : 'row';
      const index = Number(edge.dataset.col ?? edge.dataset.row);
      const startPx = this.sizeInView(axis, index);
      const start = axis === 'col' ? e.clientX : e.clientY;
      this.drag = { axis, index, start, startPx, before: this.sizesOf(v.name)[axis].get(index), px: startPx };
      grid.setPointerCapture(e.pointerId);
      grid.classList.add(`resizing-${axis}`);
    });
    this.on(grid, 'pointermove', (e) => {
      const d = this.drag;
      const v = this.view;
      if (!d || !v) return;
      const px = Math.max(8, Math.round(d.startPx + (d.axis === 'col' ? e.clientX : e.clientY) - d.start));
      if (px === d.px) return;
      d.px = px;
      this.setSize(v.name, d.axis, d.index, px);
      this.view = this.buildView(v.name, v.ws, this.sel);
      this.schedule();
    });
    const endDrag = () => {
      const d = this.drag;
      const v = this.view;
      if (!d || !v) return;
      this.drag = null;
      grid.classList.remove(`resizing-${d.axis}`);
      this.setSize(v.name, d.axis, d.index, d.before);
      if (d.px !== d.startPx) this.resizeTo(d.axis, d.index, d.px);
      else {
        this.view = this.buildView(v.name, v.ws, this.sel);
        this.render();
      }
    };
    this.on(grid, 'pointerup', endDrag);
    this.on(grid, 'pointercancel', endDrag);
    this.on(grid, 'keydown', (e) => {
      if (e.target !== grid) return;
      this.onGridKey(e);
    });
    this.on(this.editor, 'keydown', (e) => this.onEditorKey(e));
    this.on(this.editor, 'input', () => (bar.value = this.editor.value));
    this.on(this.editor, 'blur', (e) => {
      if (this.editing && e.relatedTarget !== bar) void this.finishEdit();
    });
    this.on(tabs, 'click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button[data-sheet]');
      if (b?.dataset.sheet) void this.showSheet(b.dataset.sheet).then(() => grid.focus({ preventScroll: true }));
    });
    this.on(bar, 'focus', () => {
      const v = this.view;
      if (!v) return;
      const typed = this.editing ? this.editor.value : undefined;
      if (this.editing) {
        this.editing = null;
        this.editor.hidden = true;
      }
      this.barCell = { sheet: v.name, row: this.sel.row, col: this.sel.col, orig: this.inputText(v.name, this.sel.row, this.sel.col) };
      if (typed !== undefined) bar.value = typed;
    });
    this.on(bar, 'keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const step: [number, number] = e.key === 'Enter' ? [e.shiftKey ? -1 : 1, 0] : [0, e.shiftKey ? -1 : 1];
        void this.finishEdit().then((ok) => {
          if (!ok) return;
          grid.focus({ preventScroll: true });
          this.move(...step);
        });
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.barCell = null;
        this.updateBar();
        grid.focus({ preventScroll: true });
      }
    });
    this.on(bar, 'blur', () => {
      if (this.barCell) void this.finishEdit();
    });
    this.on(name, 'focus', () => name.select());
    this.on(name, 'keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void this.goTo(name.value);
      } else if (e.key === 'Escape') {
        this.updateBar();
        grid.focus({ preventScroll: true });
      }
    });
    this.resize = new ResizeObserver(() => this.schedule());
    this.resize.observe(grid);
  }

  private onGridKey(e: KeyboardEvent): void {
    const v = this.view;
    if (!v) return;
    const page = Math.max(1, Math.floor(this.els.grid.clientHeight / 20) - 2);
    const mod = e.ctrlKey || e.metaKey;
    if (this.list) {
      const listKeys: Record<string, () => void> = {
        ArrowDown: () => this.moveList(1),
        ArrowUp: () => this.moveList(-1),
        Enter: () => void this.pickFromList(this.list?.active ?? -1),
        Escape: () => this.closeList(),
        Tab: () => this.closeList(),
      };
      if (listKeys[e.key]) {
        e.preventDefault();
        listKeys[e.key]();
        return;
      }
    }
    if (e.altKey && e.key === 'ArrowDown' && !this.dropBtn.hidden) {
      e.preventDefault();
      this.openList();
      return;
    }
    const keys: Record<string, () => void> = {
      ArrowUp: () => this.move(-1, 0),
      ArrowDown: () => this.move(1, 0),
      ArrowLeft: () => this.move(0, -1),
      ArrowRight: () => this.move(0, 1),
      Enter: () => this.move(e.shiftKey ? -1 : 1, 0),
      Tab: () => this.move(0, e.shiftKey ? -1 : 1),
      PageDown: () => this.move(page, 0),
      PageUp: () => this.move(-page, 0),
      Home: () => (mod ? this.select(v.rows[0], v.cols[0]) : this.select(this.sel.row, v.cols[0])),
      F2: () => this.startEdit('edit'),
      Delete: () => void this.commitChecked(v.name, this.sel.row, this.sel.col, '').then(() => this.els.grid.focus({ preventScroll: true })),
      Backspace: () => this.startEdit('enter', ''),
    };
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      this.undo();
      return;
    }
    const fn = keys[e.key];
    if (fn) {
      e.preventDefault();
      fn();
    } else if (e.key.length === 1 && !mod && !e.altKey) {
      e.preventDefault();
      this.startEdit('enter', e.key);
    }
  }

  private onEditorKey(e: KeyboardEvent): void {
    const nav: Record<string, [number, number]> = {
      Enter: [e.shiftKey ? -1 : 1, 0],
      Tab: [0, e.shiftKey ? -1 : 1],
    };
    if (this.editing?.mode === 'enter')
      Object.assign(nav, { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] });
    if (e.key === 'Escape') {
      e.preventDefault();
      this.cancelEditor();
    } else if (nav[e.key]) {
      e.preventDefault();
      const step = nav[e.key];
      void this.finishEdit().then((ok) => {
        if (!ok) return;
        this.els.grid.focus({ preventScroll: true });
        this.move(...step);
      });
    }
  }
}
