/**
 * Excel's data validation: the rules a worksheet keeps on which values its
 * cells accept (whole numbers or decimals in a range, an item from a list, a
 * date or time, a text length, or any formula that must come out TRUE), with
 * the input message shown when such a cell is selected and the Stop, Warning
 * or Information alert shown when a typed value breaks the rule.
 *
 * Rules are read from both places Excel writes them: the worksheet's
 * <dataValidations>, and the Excel 2010 extension list used for rules that
 * point at other sheets. They are written back as one <dataValidations>.
 */

import { XmlElement, childElements, firstChild, textContent } from './xml';
import { parseCellRef } from './xlsx';

export type ValidationType = 'none' | 'whole' | 'decimal' | 'list' | 'date' | 'time' | 'textLength' | 'custom';
export type ValidationOperator =
  | 'between'
  | 'notBetween'
  | 'equal'
  | 'notEqual'
  | 'greaterThan'
  | 'lessThan'
  | 'greaterThanOrEqual'
  | 'lessThanOrEqual';
export type ErrorStyle = 'stop' | 'warning' | 'information';

export interface DataValidation {
  /** The cells it applies to, as Excel lists them: "B2:S19 D50". */
  sqref: string;
  type: ValidationType;
  operator: ValidationOperator;
  /** Excel formulas without "=" (constants like "0", a list like "\"Yes,No\"", or references). */
  formula1?: string;
  formula2?: string;
  /** "Ignore blank": an empty cell is always valid. */
  allowBlank: boolean;
  /** Show the in-cell dropdown of a list (the file's showDropDown="1" means the opposite). */
  dropdown: boolean;
  showInput: boolean;
  showError: boolean;
  errorStyle: ErrorStyle;
  errorTitle?: string;
  error?: string;
  promptTitle?: string;
  prompt?: string;
}

export interface CellRange {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

const on = (v: string | undefined) => v === '1' || v === 'true';

function readRule(el: XmlElement, sqref: string): DataValidation {
  const a = el.attrs;
  const formula = (name: string) => {
    const f = firstChild(el, name);
    if (!f) return undefined;
    const inner = firstChild(f, 'f'); // the 2010 extension wraps it in <xm:f>
    const text = textContent(inner ?? f).trim();
    return text ? text.replace(/^=/, '').replace(/_xlfn\.|_xll\./g, '') : undefined;
  };
  return {
    sqref,
    type: (a.type as ValidationType) ?? 'none',
    operator: (a.operator as ValidationOperator) ?? 'between',
    formula1: formula('formula1'),
    formula2: formula('formula2'),
    allowBlank: on(a.allowBlank),
    dropdown: !on(a.showDropDown),
    showInput: on(a.showInputMessage),
    showError: on(a.showErrorMessage),
    errorStyle: (a.errorStyle as ErrorStyle) ?? 'stop',
    errorTitle: a.errorTitle || undefined,
    error: a.error || undefined,
    promptTitle: a.promptTitle || undefined,
    prompt: a.prompt || undefined,
  };
}

/** The data validation rules of a worksheet (its parsed root element). */
export function readDataValidations(sheet: XmlElement): DataValidation[] {
  const out: DataValidation[] = [];
  const main = firstChild(sheet, 'dataValidations');
  for (const dv of main ? childElements(main, 'dataValidation') : []) out.push(readRule(dv, dv.attrs.sqref ?? ''));
  const ext = firstChild(sheet, 'extLst');
  for (const e of ext ? childElements(ext, 'ext') : []) {
    const list = firstChild(e, 'dataValidations');
    for (const dv of list ? childElements(list, 'dataValidation') : []) {
      const sq = firstChild(dv, 'sqref');
      out.push(readRule(dv, sq ? textContent(sq).trim() : dv.attrs.sqref ?? ''));
    }
  }
  return out.filter((r) => r.sqref);
}

/** "B2:S19 D50" → its rectangles (1-based, inclusive). Throws on a bad reference. */
export function parseSqref(sqref: string): CellRange[] {
  return sqref
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((part) => {
      const [a, b = a] = part.replace(/\$/g, '').split(':');
      const p = parseCellRef(a);
      const q = parseCellRef(b);
      return { r0: Math.min(p.row, q.row), c0: Math.min(p.col, q.col), r1: Math.max(p.row, q.row), c1: Math.max(p.col, q.col) };
    });
}

export function formatSqref(ranges: CellRange[]): string {
  const ref = (r: number, c: number) => {
    let s = '';
    for (let k = c; k > 0; k = Math.floor((k - 1) / 26)) s = String.fromCharCode(65 + ((k - 1) % 26)) + s;
    return s + r;
  };
  return ranges.map((g) => (g.r0 === g.r1 && g.c0 === g.c1 ? ref(g.r0, g.c0) : `${ref(g.r0, g.c0)}:${ref(g.r1, g.c1)}`)).join(' ');
}

const contains = (g: CellRange, row: number, col: number) => g.r0 <= row && row <= g.r1 && g.c0 <= col && col <= g.c1;

/** The rule covering a cell, with the cell's offset from the rule's first cell (relative references shift by it). */
export function ruleAt(rules: DataValidation[], row: number, col: number): { rule: DataValidation; index: number; dr: number; dc: number } | undefined {
  for (let index = 0; index < rules.length; index++) {
    let ranges: CellRange[];
    try {
      ranges = parseSqref(rules[index].sqref);
    } catch {
      continue;
    }
    if (ranges.some((g) => contains(g, row, col))) return { rule: rules[index], index, dr: row - ranges[0].r0, dc: col - ranges[0].c0 };
  }
  return undefined;
}

/** a minus b, as up to four rectangles. */
function subtract(a: CellRange, b: CellRange): CellRange[] {
  if (b.r1 < a.r0 || b.r0 > a.r1 || b.c1 < a.c0 || b.c0 > a.c1) return [a];
  const out: CellRange[] = [];
  if (a.r0 < b.r0) out.push({ r0: a.r0, r1: b.r0 - 1, c0: a.c0, c1: a.c1 });
  if (a.r1 > b.r1) out.push({ r0: b.r1 + 1, r1: a.r1, c0: a.c0, c1: a.c1 });
  const r0 = Math.max(a.r0, b.r0);
  const r1 = Math.min(a.r1, b.r1);
  if (a.c0 < b.c0) out.push({ r0, r1, c0: a.c0, c1: b.c0 - 1 });
  if (a.c1 > b.c1) out.push({ r0, r1, c0: b.c1 + 1, c1: a.c1 });
  return out;
}

/**
 * The sheet's rules with `rule` set on its cells (each cell has at most one
 * rule, so other rules give those cells up), or, with `rule` null, the rules
 * with these cells cleared.
 */
export function setRule(rules: DataValidation[], sqref: string, rule: DataValidation | null, at?: number): DataValidation[] {
  const target = parseSqref(sqref);
  const out: DataValidation[] = [];
  let insert = at ?? rules.length;
  rules.forEach((r, i) => {
    let own: CellRange[];
    try {
      own = parseSqref(r.sqref);
    } catch {
      out.push(r);
      return;
    }
    let left = own;
    for (const t of target) left = left.flatMap((g) => subtract(g, t));
    if (!left.length) {
      if (i < (at ?? rules.length)) insert--;
    } else out.push(formatSqref(left) === formatSqref(own) ? r : { ...r, sqref: formatSqref(left) });
  });
  if (rule) out.splice(Math.min(insert, out.length), 0, { ...rule, sqref: formatSqref(target) });
  return out;
}

/* ------------------------------ checking ------------------------------ */

export type CheckValue = string | number | boolean | null | { error: string };
/** Evaluate one of the rule's formulas for the cell being checked: a value, or a range's values. */
export type FormulaEval = (formula: string) => CheckValue | CheckValue[];

const isError = (v: CheckValue): v is { error: string } => v !== null && typeof v === 'object';

function asNumber(v: CheckValue | CheckValue[] | undefined): number {
  const x = Array.isArray(v) ? v[0] : v;
  if (typeof x === 'number') return x;
  if (typeof x === 'boolean') return x ? 1 : 0;
  if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x);
  return NaN;
}

function compare(op: ValidationOperator, x: number, a: number, b: number): boolean {
  switch (op) {
    case 'between':
      return x >= a && x <= b;
    case 'notBetween':
      return x < a || x > b;
    case 'equal':
      return x === a;
    case 'notEqual':
      return x !== a;
    case 'greaterThan':
      return x > a;
    case 'lessThan':
      return x < a;
    case 'greaterThanOrEqual':
      return x >= a;
    case 'lessThanOrEqual':
      return x <= a;
  }
}

/** The items of a list rule: a typed list ("Yes,No") or the values of the range it points at. */
export function listItems(rule: DataValidation, evaluate: FormulaEval): CheckValue[] {
  const f = rule.formula1 ?? '';
  const quoted = /^"((?:[^"]|"")*)"$/.exec(f.trim());
  if (quoted) return quoted[1].replace(/""/g, '"').split(',').map((s) => s.trim());
  const v = evaluate(f);
  return (Array.isArray(v) ? v : [v]).filter((x) => x !== null && x !== '' && !isError(x));
}

/** Text as Excel compares it for a list or a text length: numbers in their shortest form. */
const asText = (v: CheckValue) => (typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));

/** Whether a cell's value meets its rule. */
export function meetsRule(rule: DataValidation, value: CheckValue, evaluate: FormulaEval): boolean {
  if (value === null || value === '') return rule.allowBlank || rule.type === 'none';
  if (rule.type === 'none') return true;
  if (rule.type === 'custom') {
    const r = evaluate(rule.formula1 ?? 'TRUE');
    const x = Array.isArray(r) ? r[0] : r;
    return x === true || (typeof x === 'number' && x !== 0);
  }
  if (isError(value)) return false;
  if (rule.type === 'list') {
    const items = listItems(rule, evaluate);
    const text = asText(value).toLowerCase();
    return items.some((it) => (typeof it === 'number' && typeof value === 'number' ? it === value : asText(it).toLowerCase() === text));
  }
  const a = asNumber(rule.formula1 === undefined ? undefined : evaluate(rule.formula1));
  const b = asNumber(rule.formula2 === undefined ? undefined : evaluate(rule.formula2));
  if (rule.type === 'textLength') return compare(rule.operator, asText(value).length, a, b);
  if (typeof value !== 'number') return false;
  if (rule.type === 'whole' && !Number.isInteger(value)) return false;
  if (rule.type === 'time' && (value < 0 || value >= 1)) return false;
  return compare(rule.operator, value, a, b);
}

const OP_TEXT: Record<ValidationOperator, string> = {
  between: 'between {1} and {2}',
  notBetween: 'not between {1} and {2}',
  equal: 'equal to {1}',
  notEqual: 'not equal to {1}',
  greaterThan: 'greater than {1}',
  lessThan: 'less than {1}',
  greaterThanOrEqual: 'greater than or equal to {1}',
  lessThanOrEqual: 'less than or equal to {1}',
};

/** A rule in words, e.g. "a decimal between -1 and 1". */
export function describeRule(rule: DataValidation): string {
  const bounds = OP_TEXT[rule.operator].replace('{1}', rule.formula1 ?? '?').replace('{2}', rule.formula2 ?? '?');
  switch (rule.type) {
    case 'whole':
      return `a whole number ${bounds}`;
    case 'decimal':
      return `a number ${bounds}`;
    case 'date':
      return `a date ${bounds}`;
    case 'time':
      return `a time ${bounds}`;
    case 'textLength':
      return `text with a length ${bounds}`;
    case 'list': {
      const typed = /^"((?:[^"]|"")*)"$/.exec(rule.formula1 ?? '');
      return typed ? `one of ${typed[1].replace(/""/g, '"').split(',').map((x) => x.trim()).join(', ')}` : `a value from ${rule.formula1 ?? 'the list'}`;
    }
    case 'custom':
      return `a value for which ${rule.formula1 ?? 'the formula'} is TRUE`;
    default:
      return 'any value';
  }
}

/* ------------------------------- writing ------------------------------- */

const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The rules as a <dataValidations> element ('' for none). Formulas go through `fileFormula` for their file prefixes. */
export function dataValidationsXml(rules: DataValidation[], fileFormula: (f: string) => string = (f) => f): string {
  if (!rules.length) return '';
  const body = rules
    .map((r) => {
      const at: [string, string | undefined][] = [
        ['type', r.type === 'none' ? undefined : r.type],
        ['errorStyle', r.errorStyle === 'stop' ? undefined : r.errorStyle],
        ['operator', r.operator === 'between' ? undefined : r.operator],
        ['allowBlank', r.allowBlank ? '1' : undefined],
        ['showDropDown', r.type === 'list' && !r.dropdown ? '1' : undefined],
        ['showInputMessage', r.showInput ? '1' : undefined],
        ['showErrorMessage', r.showError ? '1' : undefined],
        ['errorTitle', r.errorTitle],
        ['error', r.error],
        ['promptTitle', r.promptTitle],
        ['prompt', r.prompt],
        ['sqref', r.sqref],
      ];
      const attrs = at.filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => ` ${k}="${escAttr(v as string)}"`).join('');
      const f = (name: string, v?: string) => (v ? `<${name}>${escAttr(fileFormula(v))}</${name}>` : '');
      const inner = f('formula1', r.formula1) + f('formula2', r.formula2);
      return inner ? `<dataValidation${attrs}>${inner}</dataValidation>` : `<dataValidation${attrs}/>`;
    })
    .join('');
  return `<dataValidations count="${rules.length}">${body}</dataValidations>`;
}
