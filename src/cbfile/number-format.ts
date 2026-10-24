/**
 * Excel number formats, for showing a cell's value as Excel does: "General",
 * fixed and scientific number patterns with thousands separators, scaling and
 * percent, literal text and currency, positive;negative;zero;text sections,
 * and dates and times. Rounding is decimal, at the 15 significant digits Excel
 * keeps, so 1.005 with "0.00" shows 1.01 as in Excel.
 *
 * Not covered: fractions ("# ?/?"), conditional sections ("[>100]…"),
 * colours, and the 1904 date system; those fall back to General.
 */

import { CellValue } from './xlsx';

/** Excel's built-in format codes by numFmtId (en-US). */
export const BUILTIN_FORMATS: Record<number, string> = {
  0: 'General',
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  5: '"$"#,##0_);\\("$"#,##0\\)',
  6: '"$"#,##0_);[Red]\\("$"#,##0\\)',
  7: '"$"#,##0.00_);\\("$"#,##0.00\\)',
  8: '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  12: '# ?/?',
  13: '# ??/??',
  14: 'm/d/yyyy',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'm/d/yyyy h:mm',
  37: '#,##0_);(#,##0)',
  38: '#,##0_);[Red](#,##0)',
  39: '#,##0.00_);(#,##0.00)',
  40: '#,##0.00_);[Red](#,##0.00)',
  41: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)',
  42: '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)',
  44: '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mm:ss.0',
  48: '##0.0E+0',
  49: '@',
};

type Token =
  | { t: 'lit'; s: string }
  | { t: 'ph'; s: string } // 0 # ? . , % E+ E-
  | { t: 'date'; s: string } // y… m… d… h… s… [h] ampm ap
  | { t: 'text' }
  | { t: 'general' };

/** Split a format code into its ;-separated sections, ignoring ; inside quotes. */
function sections(code: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '"') {
      const j = code.indexOf('"', i + 1);
      const end = j < 0 ? code.length : j;
      cur += code.slice(i, end + 1);
      i = end;
    } else if (c === '\\') {
      cur += code.slice(i, i + 2);
      i++;
    } else if (c === ';') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function tokenize(sec: string): Token[] | null {
  const out: Token[] = [];
  let i = 0;
  while (i < sec.length) {
    const c = sec[i];
    if (c === '"') {
      const j = sec.indexOf('"', i + 1);
      const end = j < 0 ? sec.length : j;
      out.push({ t: 'lit', s: sec.slice(i + 1, end) });
      i = end + 1;
    } else if (c === '\\') {
      out.push({ t: 'lit', s: sec[i + 1] ?? '' });
      i += 2;
    } else if (c === '_') {
      out.push({ t: 'lit', s: ' ' });
      i += 2;
    } else if (c === '*') {
      i += 2; // repeat-to-fill: no fill in a fixed-width grid
    } else if (c === '[') {
      const j = sec.indexOf(']', i);
      const inner = sec.slice(i + 1, j < 0 ? sec.length : j);
      i = j < 0 ? sec.length : j + 1;
      if (inner.startsWith('$')) out.push({ t: 'lit', s: inner.slice(1).split('-')[0] });
      else if (/^(h+|m+|s+)$/i.test(inner)) out.push({ t: 'date', s: `[${inner[0].toLowerCase()}]` });
      else if (/^[<>=]/.test(inner)) return null; // conditional section
      // colours and locale tags are dropped
    } else if (/^general/i.test(sec.slice(i, i + 7))) {
      out.push({ t: 'general' });
      i += 7;
    } else if (c === '@') {
      out.push({ t: 'text' });
      i++;
    } else if ('0#?.,%'.includes(c)) {
      out.push({ t: 'ph', s: c });
      i++;
    } else if ((c === 'E' || c === 'e') && (sec[i + 1] === '+' || sec[i + 1] === '-')) {
      out.push({ t: 'ph', s: `E${sec[i + 1]}` });
      i += 2;
    } else if (/^am\/pm/i.test(sec.slice(i, i + 5))) {
      out.push({ t: 'date', s: 'ampm' });
      i += 5;
    } else if (/^a\/p/i.test(sec.slice(i, i + 3))) {
      out.push({ t: 'date', s: 'ap' });
      i += 3;
    } else if (/[ymdhs]/i.test(c)) {
      let j = i;
      while (j < sec.length && sec[j].toLowerCase() === c.toLowerCase()) j++;
      out.push({ t: 'date', s: sec.slice(i, j).toLowerCase() });
      i = j;
    } else {
      out.push({ t: 'lit', s: c });
      i++;
    }
  }
  return out;
}

/**
 * Round x ≥ 0 to d decimals, half away from zero, on its decimal digits at 15
 * significant figures. Returns the integer and fraction digits.
 */
function decimalParts(x: number, d: number): [string, string] {
  const [m, e] = x.toExponential(14).split('e');
  let digits = m.replace('.', '');
  let point = Number(e) + 1;
  const keep = point + d;
  if (keep < 0) return ['0', '0'.repeat(d)];
  if (keep < digits.length) {
    const up = digits.charCodeAt(keep) >= 53;
    const arr = digits.slice(0, keep).split('');
    if (up) {
      let i = arr.length - 1;
      for (; i >= 0; i--) {
        if (arr[i] === '9') arr[i] = '0';
        else {
          arr[i] = String(Number(arr[i]) + 1);
          break;
        }
      }
      if (i < 0) {
        arr.unshift('1');
        point++;
      }
    }
    digits = arr.join('');
  } else digits = digits.padEnd(keep, '0');
  if (point <= 0) return ['0', '0'.repeat(-point) + digits];
  return [digits.slice(0, point).replace(/^0+(?=\d)/, ''), digits.slice(point)];
}

function scientific(a: number, dec: number, trim: boolean, expDigits: number, plus: boolean, group = 1): string {
  let e = a === 0 ? 0 : Math.floor(Math.log10(a));
  if (group > 1) e = Math.floor(e / group) * group;
  let [i, f] = decimalParts(a / 10 ** e, dec);
  if (a !== 0 && i.length > group) {
    // rounding carried into another digit (9.995 → 10.00)
    e += group === 1 ? 1 : group;
    [i, f] = decimalParts(a / 10 ** e, dec);
  }
  if (trim) f = f.replace(/0+$/, '');
  const mant = f ? `${i}.${f}` : i;
  const es = String(Math.abs(e)).padStart(expDigits, '0');
  return `${mant}E${e < 0 ? '-' : plus ? '+' : ''}${es}`;
}

/** Excel's General format: up to 11 characters, switching to scientific for very large or small numbers. */
export function formatGeneral(v: number): string {
  if (!Number.isFinite(v)) return v > 0 ? '#NUM!' : v < 0 ? '-#NUM!' : '#NUM!';
  if (v === 0) return '0';
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1e11 || a < 1e-5) return sign + scientific(a, 5, true, 2, true);
  const intDigits = decimalParts(a, 0)[0].length;
  let [i, f] = decimalParts(a, Math.max(0, 10 - intDigits));
  if (i.length > intDigits) [i, f] = decimalParts(a, Math.max(0, 10 - i.length));
  f = f.replace(/0+$/, '');
  return sign + (f ? `${i}.${f}` : i);
}

function groupThousands(i: string): string {
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** A numeric section without date codes. `a` is the value to show (sign handled by the caller). */
function numberSection(tokens: Token[], a: number): string {
  const first = tokens.findIndex((t) => t.t === 'ph' && t.s !== '%');
  let last = -1;
  tokens.forEach((t, k) => t.t === 'ph' && t.s !== '%' && (last = k));
  const lits = (ts: Token[]) =>
    ts.map((t) => (t.t === 'lit' ? t.s : t.t === 'ph' && t.s === '%' ? '%' : t.t === 'general' ? formatGeneral(a) : '')).join('');
  const pct = tokens.filter((t) => t.t === 'ph' && t.s === '%').length;
  if (first < 0) return lits(tokens);
  const middle = tokens.slice(first, last + 1);
  if (middle.some((t) => t.t === 'lit' && t.s === '/')) return lits(tokens.slice(0, first)) + formatGeneral(a);
  const pattern = middle.map((t) => (t.t === 'ph' && t.s !== '%' ? t.s : '')).join('');
  const midLits = middle.filter((t) => t.t === 'lit').map((t) => (t as { s: string }).s).join('');
  a *= 100 ** pct;

  const sciAt = pattern.search(/E[+-]/);
  let mant = sciAt < 0 ? pattern : pattern.slice(0, sciAt);
  // Commas after the last digit placeholder (or just before the point) divide by 1000 each.
  const scale = (/,+$/.exec(mant)?.[0].length ?? 0) + (/,+(?=\.)/.exec(mant)?.[0].length ?? 0);
  mant = mant.replace(/,+$/, '').replace(/,+(?=\.)/, '');
  if (scale && sciAt < 0) a /= 1000 ** scale;
  const dot = mant.indexOf('.');
  const intPat = (dot < 0 ? mant : mant.slice(0, dot)).replace(/,/g, '');
  const fracPat = dot < 0 ? '' : mant.slice(dot + 1).replace(/,/g, '');
  const thousands = (dot < 0 ? mant : mant.slice(0, dot)).includes(',');
  const zeros = (intPat.match(/0/g) ?? []).length;
  const blanks = (intPat.match(/\?/g) ?? []).length;
  const minDec = (fracPat.match(/[0?]/g) ?? []).length;

  let body: string;
  if (sciAt >= 0) {
    const expPat = pattern.slice(sciAt + 2);
    const group = intPat.includes('#') && intPat.length > 1 ? intPat.length : 1;
    body = scientific(a, fracPat.length, false, Math.max(1, (expPat.match(/0/g) ?? []).length), pattern[sciAt + 1] === '+', group);
  } else {
    let [i, f] = decimalParts(a, fracPat.length);
    // Drop trailing zeros that only '#' positions would show.
    while (f.length > minDec && f.endsWith('0')) f = f.slice(0, -1);
    if (fracPat.includes('?')) f = f.padEnd(fracPat.length, ' ');
    if (i === '0' && zeros === 0) i = '';
    i = i.padStart(zeros, '0');
    if (thousands) i = groupThousands(i);
    i = i.padStart(zeros + blanks, ' ');
    body = dot >= 0 ? `${i}.${f}` : i;
  }
  return lits(tokens.slice(0, first)) + body + midLits + lits(tokens.slice(last + 1));
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** The date code of a token, or '' for any other token. */
const dateCode = (t: Token | undefined) => (t?.t === 'date' ? t.s : '');

/** An Excel date serial (1900 system, with its 29 February 1900) in a date/time section. */
function dateSection(tokens: Token[], serial: number): string {
  if (serial < 0 || serial >= 2958466) return '#'.repeat(8);
  const fracSecDigits = (() => {
    const k = tokens.findIndex((t, j) => t.t === 'ph' && t.s === '.' && dateCode(tokens[j - 1]).startsWith('s'));
    if (k < 0) return 0;
    let n = 0;
    while (tokens[k + 1 + n]?.t === 'ph' && (tokens[k + 1 + n] as { s: string }).s === '0') n++;
    return n;
  })();
  const unit = 86400 * 10 ** fracSecDigits;
  let ticks = Math.round(serial * unit);
  const days = Math.floor(ticks / unit);
  ticks -= days * unit;
  let y: number, mo: number, d: number, wd: number;
  if (days === 60) [y, mo, d, wd] = [1900, 1, 29, 3];
  else {
    const dt = new Date(Date.UTC(1899, 11, days < 60 ? 31 : 30) + days * 86400000);
    [y, mo, d, wd] = [dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), dt.getUTCDay()];
  }
  const secsTotal = Math.floor(ticks / 10 ** fracSecDigits);
  const frac = ticks - secsTotal * 10 ** fracSecDigits;
  const hh = Math.floor(secsTotal / 3600);
  const mi = Math.floor((secsTotal % 3600) / 60);
  const ss = secsTotal % 60;
  const twelve = tokens.some((t) => t.t === 'date' && (t.s === 'ampm' || t.s === 'ap'));
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  const isMinute = (k: number) => {
    for (let j = k - 1; j >= 0; j--) if (dateCode(tokens[j])) return /^(h|\[h\])/.test(dateCode(tokens[j]));
    for (let j = k + 1; j < tokens.length; j++) if (dateCode(tokens[j])) return dateCode(tokens[j]).startsWith('s');
    return false;
  };
  let out = '';
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.t === 'lit') out += t.s;
    else if (t.t === 'ph') {
      if (t.s === '.' && fracSecDigits && tokens[k - 1]?.t === 'date') {
        out += `.${pad(frac, fracSecDigits)}`;
        k += fracSecDigits;
      } else out += t.s === '%' ? '%' : t.s;
    } else if (t.t === 'date') {
      const s = t.s;
      const n = s.length;
      if (s === '[h]') out += String(days * 24 + hh);
      else if (s === '[m]') out += String((days * 24 + hh) * 60 + mi);
      else if (s === '[s]') out += String(((days * 24 + hh) * 60 + mi) * 60 + ss);
      else if (s === 'ampm') out += hh < 12 ? 'AM' : 'PM';
      else if (s === 'ap') out += hh < 12 ? 'A' : 'P';
      else if (s[0] === 'y') out += n <= 2 ? pad(y % 100, 2) : String(y);
      else if (s[0] === 'd') out += n === 1 ? String(d) : n === 2 ? pad(d, 2) : n === 3 ? DAYS[wd].slice(0, 3) : DAYS[wd];
      else if (s[0] === 'h') {
        const h = twelve ? (hh % 12 || 12) : hh;
        out += n >= 2 ? pad(h, 2) : String(h);
      } else if (s[0] === 's') out += n >= 2 ? pad(ss, 2) : String(ss);
      else if (s[0] === 'm') {
        if (n <= 2 && isMinute(k)) out += n === 2 ? pad(mi, 2) : String(mi);
        else out += n === 1 ? String(mo + 1) : n === 2 ? pad(mo + 1, 2) : n === 3 ? MONTHS[mo].slice(0, 3) : n === 5 ? MONTHS[mo][0] : MONTHS[mo];
      }
    }
  }
  return out;
}

/** A cell value shown with its number format, as Excel's grid shows it. */
export function formatValue(v: CellValue, code = 'General'): string {
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  const secs = sections(code);
  if (typeof v === 'string') {
    const sec = secs.length >= 4 ? secs[3] : secs.length === 1 && secs[0].includes('@') ? secs[0] : undefined;
    const tokens = sec === undefined ? null : tokenize(sec);
    if (!tokens) return v;
    return tokens.map((t) => (t.t === 'text' ? v : t.t === 'lit' ? t.s : '')).join('');
  }
  if (!Number.isFinite(v)) return formatGeneral(v);
  let sec = secs[0];
  let a = v;
  let sign = '';
  if (v < 0 && secs.length >= 2 && secs[1] !== '') {
    sec = secs[1];
    a = -v;
  } else if (v === 0 && secs.length >= 3) sec = secs[2];
  else if (v < 0) {
    a = -v;
    sign = '-';
  }
  const tokens = tokenize(sec);
  if (!tokens || tokens.some((t) => t.t === 'text') && !tokens.some((t) => t.t === 'ph' || t.t === 'general')) return formatGeneral(v);
  if (tokens.some((t) => t.t === 'date')) return dateSection(tokens, v);
  if (!tokens.length || (tokens.length === 1 && tokens[0].t === 'general')) return formatGeneral(v);
  return sign + numberSection(tokens, a);
}
