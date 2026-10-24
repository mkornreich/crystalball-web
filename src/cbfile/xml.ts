/**
 * A tiny, dependency-free XML parser — just enough for SpreadsheetML parts
 * (workbook.xml, sheetN.xml, sharedStrings.xml, *.rels). It builds a light
 * element tree with namespace prefixes stripped from element/attribute names.
 * Processing instructions, comments, DOCTYPE and CDATA are handled; DTD
 * entities beyond the five predefined ones and numeric references are not.
 */

export interface XmlElement {
  name: string; // local name (prefix stripped)
  attrs: Record<string, string>; // local attribute names (prefix stripped; xmlns:* dropped)
  children: XmlNode[];
}

export type XmlNode = XmlElement | string;

const ENTITY_RE = /&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g;

export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(ENTITY_RE, (_m, e: string) => {
    switch (e) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    }
  });
}

function localName(qname: string): string {
  const i = qname.indexOf(':');
  return i < 0 ? qname : qname.slice(i + 1);
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseAttrs(src: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(src))) {
    const q = m[1];
    if (q === 'xmlns' || q.startsWith('xmlns:')) continue;
    attrs[localName(q)] = decodeEntities(m[3] ?? m[4] ?? '');
  }
  return attrs;
}

/** Parse an XML document and return its root element. */
export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: '#document', attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      pushText(stack[stack.length - 1], xml.slice(i));
      break;
    }
    if (lt > i) pushText(stack[stack.length - 1], xml.slice(i, lt));
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      const text = xml.slice(lt + 9, end < 0 ? n : end);
      stack[stack.length - 1].children.push(text);
      i = end < 0 ? n : end + 3;
    } else if (xml[lt + 1] === '?' || xml[lt + 1] === '!') {
      const end = xml.indexOf('>', lt);
      i = end < 0 ? n : end + 1;
    } else if (xml[lt + 1] === '/') {
      const end = xml.indexOf('>', lt);
      const name = localName(xml.slice(lt + 2, end).trim());
      // Pop to the matching element (tolerates sloppy nesting).
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
      i = end < 0 ? n : end + 1;
    } else {
      const end = findTagEnd(xml, lt + 1);
      let body = xml.slice(lt + 1, end);
      const selfClosing = body.endsWith('/');
      if (selfClosing) body = body.slice(0, -1);
      const ws = body.search(/\s/);
      const qname = ws < 0 ? body : body.slice(0, ws);
      const el: XmlElement = {
        name: localName(qname),
        attrs: ws < 0 ? {} : parseAttrs(body.slice(ws)),
        children: [],
      };
      stack[stack.length - 1].children.push(el);
      if (!selfClosing) stack.push(el);
      i = end + 1;
    }
  }
  const first = root.children.find((c): c is XmlElement => typeof c !== 'string');
  if (!first) throw new Error('xml: empty document');
  return first;
}

function findTagEnd(xml: string, from: number): number {
  let quote = '';
  for (let k = from; k < xml.length; k++) {
    const ch = xml[k];
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '>') return k;
  }
  return xml.length;
}

function pushText(parent: XmlElement, raw: string): void {
  if (raw.length) parent.children.push(decodeEntities(raw));
}

/* ---------------------------- tree helpers ---------------------------- */

export function childElements(el: XmlElement, name?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const c of el.children) if (typeof c !== 'string' && (!name || c.name === name)) out.push(c);
  return out;
}

export function firstChild(el: XmlElement, name: string): XmlElement | undefined {
  for (const c of el.children) if (typeof c !== 'string' && c.name === name) return c;
  return undefined;
}

/** Concatenated text content of an element (all descendants). */
export function textContent(el: XmlElement): string {
  let s = '';
  for (const c of el.children) s += typeof c === 'string' ? c : textContent(c);
  return s;
}

/** Decode SpreadsheetML `_xHHHH_` escapes (ST_Xstring) used for code points XML can't carry. */
export function decodeXString(s: string): string {
  if (s.indexOf('_x') < 0) return s;
  return s.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}
