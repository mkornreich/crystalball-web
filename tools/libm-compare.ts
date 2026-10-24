/**
 * Compare math-function implementations with glibc (what .NET's Math calls on
 * Linux) and with correct rounding, on the cases from tools/libm-cases.py.
 *
 *   python3 -I tools/libm-cases.py 20000 > libm-cases.json
 *   npx vite-node tools/libm-compare.ts -- libm-cases.json
 */

import { readFileSync } from 'node:fs';
import * as libm from '../src/engine/libm';

const file = process.argv.slice(2).filter((a) => a !== '--')[0];
const data: Record<string, [string[], string, string][]> = JSON.parse(readFileSync(file, 'utf8'));
const buf = new DataView(new ArrayBuffer(8));
const fromBits = (h: string) => {
  buf.setBigUint64(0, BigInt(`0x${h}`));
  return buf.getFloat64(0);
};

const V8: Record<string, (...a: number[]) => number> = {
  exp: Math.exp,
  log: Math.log,
  log10: Math.log10,
  pow: Math.pow,
  sin: Math.sin,
  asin: Math.asin,
  tan: Math.tan,
  atan: Math.atan,
};
const OURS = libm as unknown as Record<string, ((...a: number[]) => number) | undefined>;

console.log('function   cases   glibc≠CR   V8≠glibc   ours≠glibc   ours≠CR');
for (const [name, rows] of Object.entries(data)) {
  let gNotCr = 0;
  let v8 = 0;
  let ours = 0;
  let oursCr = 0;
  const f = OURS[name];
  const examples: string[] = [];
  for (const [args, g, c] of rows) {
    const x = args.map(fromBits);
    const gv = fromBits(g);
    const cv = fromBits(c);
    if (!Object.is(gv, cv)) gNotCr++;
    if (!Object.is(V8[name](...x), gv)) v8++;
    if (f) {
      const o = f(...x);
      if (!Object.is(o, gv)) {
        ours++;
        if (examples.length < 3) examples.push(`${name}(${x.join(', ')}) ours ${o} glibc ${gv} cr ${cv}`);
      }
      if (!Object.is(o, cv)) oursCr++;
    }
  }
  const pct = (k: number) => `${k} (${((100 * k) / rows.length).toFixed(3)}%)`.padEnd(13);
  console.log(`${name.padEnd(8)} ${String(rows.length).padStart(7)}   ${pct(gNotCr)}${pct(v8)}${f ? pct(ours) + pct(oursCr) : '—'}`);
  for (const e of examples) console.log(`    ${e}`);
}
