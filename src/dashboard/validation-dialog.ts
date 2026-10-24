/**
 * The workbook grid's dialogs: Excel's validation alert (Stop, Warning or
 * Information, with its buttons) and the Data Validation dialog for setting
 * a rule on cells — what to allow, the input message and the error alert.
 */

import { DataValidation, ErrorStyle, ValidationOperator, ValidationType } from '../cbfile/data-validation';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

const STYLE_LABEL: Record<ErrorStyle, [string, string]> = {
  stop: ['✕', 'Stop'],
  warning: ['!', 'Warning'],
  information: ['i', 'Information'],
};

export interface AlertOptions {
  style: ErrorStyle;
  title: string;
  message: string;
  /** A question under the message, e.g. "Continue?". */
  question?: string;
  /** [label, value]; the first is the default. */
  buttons: [string, string][];
}

/** Show an alert and resolve to the value of the button pressed ('' for Esc). */
export function showAlert(dlg: HTMLDialogElement, o: AlertOptions): Promise<string> {
  const [icon, label] = STYLE_LABEL[o.style];
  dlg.className = `wb-alert al-${o.style}`;
  dlg.setAttribute('aria-labelledby', 'al-title');
  dlg.innerHTML =
    `<form method="dialog"><div class="al-head"><span class="al-icon" aria-hidden="true">${icon}</span>` +
    `<div><span class="al-kind">${label}</span><h3 id="al-title">${esc(o.title)}</h3></div></div>` +
    `<p class="al-msg">${esc(o.message).replace(/\n/g, '<br>')}</p>${o.question ? `<p class="al-q">${esc(o.question)}</p>` : ''}` +
    `<div class="al-btns">${o.buttons
      .map(([text, value], i) => `<button value="${esc(value)}" class="${i === 0 ? 'primary' : 'ghost'}"${i === 0 ? ' autofocus' : ''}>${esc(text)}</button>`)
      .join('')}</div></form>`;
  return new Promise((resolve) => {
    // Answer as soon as a button is pressed (or Esc), not on 'close', which some browsers deliver late.
    const form = dlg.querySelector('form') as HTMLFormElement;
    form.addEventListener('submit', (e) => resolve((e.submitter as HTMLButtonElement | null)?.value ?? ''), { once: true });
    dlg.addEventListener('cancel', () => resolve(''), { once: true });
    dlg.addEventListener('close', () => resolve(''), { once: true });
    dlg.showModal();
  });
}

/* --------------------------- the rule dialog --------------------------- */

export type RuleDialogResult = { action: 'save'; sqref: string; rule: DataValidation } | { action: 'remove'; sqref: string };

export interface RuleDialogInit {
  /** The cells, e.g. "C6" or the rule's own "B2:S19". */
  sqref: string;
  rule?: DataValidation;
  /** A message if "Applies to" isn't a valid list of cells. */
  checkSqref(sqref: string): string | null;
  /** Whether a formula (without "=") parses. */
  checkFormula(formula: string): boolean;
}

const TYPES: [ValidationType, string][] = [
  ['none', 'Any value'],
  ['whole', 'Whole number'],
  ['decimal', 'Decimal'],
  ['list', 'List'],
  ['date', 'Date'],
  ['time', 'Time'],
  ['textLength', 'Text length'],
  ['custom', 'Custom'],
];
const OPERATORS: [ValidationOperator, string][] = [
  ['between', 'between'],
  ['notBetween', 'not between'],
  ['equal', 'equal to'],
  ['notEqual', 'not equal to'],
  ['greaterThan', 'greater than'],
  ['lessThan', 'less than'],
  ['greaterThanOrEqual', 'greater than or equal to'],
  ['lessThanOrEqual', 'less than or equal to'],
];

const isNumber = (s: string) => s.trim() !== '' && Number.isFinite(Number(s));
/** A stored formula as the dialog shows it: constants as typed, anything else after "=". */
const shown = (f?: string) => (f === undefined ? '' : isNumber(f) ? f : `=${f}`);

/** Open the Data Validation dialog; resolves to what to do, or null if cancelled. */
export function editRule(dlg: HTMLDialogElement, init: RuleDialogInit): Promise<RuleDialogResult | null> {
  const r = init.rule;
  const opt = (pairs: [string, string][], cur: string) =>
    pairs.map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${l}</option>`).join('');
  const list = r?.type === 'list' ? /^"((?:[^"]|"")*)"$/.exec(r.formula1 ?? '') : null;
  const f1 = list ? list[1].replace(/""/g, '"') : shown(r?.formula1);
  const chk = (name: string, on: boolean, text: string, cls = '') =>
    `<label class="check ${cls}"><input type="checkbox" name="${name}"${on ? ' checked' : ''} /> ${text}</label>`;
  dlg.className = 'dv-dialog';
  dlg.setAttribute('aria-labelledby', 'dv-title');
  dlg.innerHTML = `<form method="dialog" class="dv-form" novalidate>
    <h3 id="dv-title">Data validation</h3>
    <label class="dv-line">Applies to <input name="sqref" value="${esc(init.sqref)}" spellcheck="false" autocomplete="off" /></label>
    <fieldset><legend>Settings</legend>
      <label class="dv-line">Allow <select name="type">${opt(TYPES, r?.type ?? 'whole')}</select></label>
      <label class="dv-line dv-op">Data <select name="operator">${opt(OPERATORS, r?.operator ?? 'between')}</select></label>
      <label class="dv-line dv-f1"><span>Minimum</span> <input name="formula1" value="${esc(f1)}" spellcheck="false" autocomplete="off" /></label>
      <label class="dv-line dv-f2"><span>Maximum</span> <input name="formula2" value="${esc(shown(r?.formula2))}" spellcheck="false" autocomplete="off" /></label>
      <p class="sub dv-hint"></p>
      ${chk('allowBlank', r?.allowBlank ?? true, 'Ignore blank')}
      ${chk('dropdown', r?.dropdown ?? true, 'In-cell dropdown', 'dv-dd')}
    </fieldset>
    <fieldset><legend>Input message</legend>
      ${chk('showInput', r?.showInput ?? true, 'Show input message when the cell is selected')}
      <label class="dv-line">Title <input name="promptTitle" maxlength="32" value="${esc(r?.promptTitle ?? '')}" /></label>
      <label class="dv-line">Message <textarea name="prompt" maxlength="255" rows="2">${esc(r?.prompt ?? '')}</textarea></label>
    </fieldset>
    <fieldset><legend>Error alert</legend>
      ${chk('showError', r?.showError ?? true, 'Show an error alert after invalid data is entered')}
      <label class="dv-line">Style <select name="errorStyle">${opt(
        [
          ['stop', 'Stop — refuse the value'],
          ['warning', 'Warning — ask before keeping it'],
          ['information', 'Information — tell, then keep it'],
        ],
        r?.errorStyle ?? 'stop',
      )}</select></label>
      <label class="dv-line">Title <input name="errorTitle" maxlength="32" value="${esc(r?.errorTitle ?? '')}" /></label>
      <label class="dv-line">Message <textarea name="error" maxlength="225" rows="2">${esc(r?.error ?? '')}</textarea></label>
    </fieldset>
    <p class="dv-err" role="alert" hidden></p>
    <div class="dv-btns">
      <button value="remove" class="ghost"${r ? '' : ' hidden'}>Clear rule</button>
      <span class="grow"></span>
      <button value="cancel" class="ghost" formnovalidate>Cancel</button>
      <button value="save" class="primary">OK</button>
    </div>
  </form>`;
  const form = dlg.querySelector('form') as HTMLFormElement;
  const el = <T extends HTMLElement>(name: string) => form.elements.namedItem(name) as unknown as T;
  const type = el<HTMLSelectElement>('type');
  const op = el<HTMLSelectElement>('operator');
  const err = form.querySelector('.dv-err') as HTMLElement;

  const layout = () => {
    const t = type.value as ValidationType;
    const o = op.value as ValidationOperator;
    const two = o === 'between' || o === 'notBetween';
    const ranged = t !== 'none' && t !== 'list' && t !== 'custom';
    (form.querySelector('.dv-op') as HTMLElement).hidden = !ranged;
    const l1 = form.querySelector('.dv-f1') as HTMLElement;
    const l2 = form.querySelector('.dv-f2') as HTMLElement;
    l1.hidden = t === 'none';
    l2.hidden = !ranged || !two;
    const label1 =
      t === 'list' ? 'Source' : t === 'custom' ? 'Formula' : two ? 'Minimum' : o === 'equal' || o === 'notEqual' ? 'Value' : o.startsWith('less') ? 'Maximum' : 'Minimum';
    (l1.firstElementChild as HTMLElement).textContent = label1;
    (form.querySelector('.dv-dd') as HTMLElement).hidden = t !== 'list';
    (form.querySelector('.dv-hint') as HTMLElement).textContent =
      t === 'list'
        ? 'Items separated by commas (Yes,No,Maybe), or a range such as =$F$2:$F$9.'
        : t === 'custom'
          ? 'A formula that is TRUE for allowed values, e.g. =C6>=C5.'
          : t === 'date'
            ? 'Dates as Excel serial numbers (45000 is 15 March 2023), or a formula such as =TODAY().'
            : t === 'time'
              ? 'Times as fractions of a day (0.5 is noon).'
              : ranged
                ? 'A number, or a formula such as =C5.'
                : '';
  };
  type.addEventListener('change', layout);
  op.addEventListener('change', layout);
  layout();

  /** The rule as filled in, or an error message. */
  const read = (): DataValidation | string => {
    const t = type.value as ValidationType;
    const o = op.value as ValidationOperator;
    const two = o === 'between' || o === 'notBetween';
    const ranged = t !== 'none' && t !== 'list' && t !== 'custom';
    const raw1 = el<HTMLInputElement>('formula1').value.trim();
    const raw2 = el<HTMLInputElement>('formula2').value.trim();
    let formula1: string | undefined;
    let formula2: string | undefined;
    if (t === 'list') {
      if (!raw1) return 'Type the list’s items, or a range of cells that holds them.';
      formula1 = raw1.startsWith('=') ? raw1.slice(1) : `"${raw1.replace(/"/g, '""')}"`;
    } else if (t !== 'none') {
      if (!raw1) return `Enter the ${t === 'custom' ? 'formula' : 'value'} the rule compares with.`;
      formula1 = raw1.replace(/^=/, '');
      if (ranged && two) {
        if (!raw2) return 'Enter the Maximum too.';
        formula2 = raw2.replace(/^=/, '');
        if (isNumber(formula1) && isNumber(formula2) && Number(formula2) < Number(formula1))
          return 'The Maximum must be greater than or equal to the Minimum.';
      }
      if (t === 'whole' && [formula1, formula2].some((f) => f !== undefined && isNumber(f) && !Number.isInteger(Number(f))))
        return 'A whole-number rule needs whole-number bounds.';
    }
    for (const f of [formula1, formula2])
      if (f !== undefined && !isNumber(f) && !(t === 'list' && f.startsWith('"')) && !init.checkFormula(f))
        return `There's a problem with the formula ${f}.`;
    const text = (name: string) => el<HTMLInputElement>(name).value.trim() || undefined;
    return {
      sqref: '',
      type: t,
      operator: ranged ? o : 'between',
      formula1,
      formula2,
      allowBlank: el<HTMLInputElement>('allowBlank').checked,
      dropdown: el<HTMLInputElement>('dropdown').checked,
      showInput: el<HTMLInputElement>('showInput').checked,
      showError: el<HTMLInputElement>('showError').checked,
      errorStyle: el<HTMLSelectElement>('errorStyle').value as ErrorStyle,
      errorTitle: text('errorTitle'),
      error: text('error'),
      promptTitle: text('promptTitle'),
      prompt: text('prompt'),
    };
  };

  return new Promise((resolve) => {
    form.addEventListener('submit', (e) => {
      const action = (e.submitter as HTMLButtonElement | null)?.value;
      if (action === 'cancel') {
        resolve(null);
        return;
      }
      const sqref = el<HTMLInputElement>('sqref').value.trim().replace(/\$/g, '').toUpperCase();
      const bad = init.checkSqref(sqref);
      const rule = action === 'save' ? read() : null;
      const problem = bad ?? (typeof rule === 'string' ? rule : null);
      if (problem) {
        e.preventDefault();
        err.textContent = problem;
        err.hidden = false;
        return;
      }
      resolve(action === 'remove' ? { action: 'remove', sqref } : { action: 'save', sqref, rule: rule as DataValidation });
    });
    dlg.addEventListener('cancel', () => resolve(null), { once: true });
    dlg.addEventListener('close', () => resolve(null), { once: true });
    dlg.showModal();
  });
}
