/**
 * Check src/engine/libm.ts against the system libm, bit for bit, on the raw
 * cases written by extract/glibc/build/gencases (pairs [x, f(x)], pow triples).
 *
 *   npx vite-node tools/libm-check.ts -- <cases-dir> [fn...] [--limit N]
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as libm from '../src/engine/libm';

const args = process.argv.slice(2).filter((a) => a !== '--');
const li = args.indexOf('--limit');
const limit = li >= 0 ? Number(args[li + 1]) : Infinity;
const rest = li >= 0 ? args.filter((_, i) => i !== li && i !== li + 1) : args;
const dir = rest[0];
const fns = rest.length > 1 ? rest.slice(1) : ['fma', 'exp', 'log', 'log10', 'pow', 'sin', 'cos', 'tan', 'atan', 'asin'];
const OURS = libm as unknown as Record<string, (...a: number[]) => number>;

for (const fn of fns) {
  const file = join(dir, `${fn}.bin`);
  if (!existsSync(file) || !OURS[fn]) {
    console.log(`${fn}: skipped`);
    continue;
  }
  const buf = readFileSync(file);
  const v = new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
  const arity = fn === 'pow' ? 3 : fn === 'fma' ? 4 : 2;
  const n = Math.min(v.length / arity, limit);
  let bad = 0;
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const o = i * arity;
    const want = v[o + arity - 1];
    const got = arity === 2 ? OURS[fn](v[o]) : arity === 3 ? OURS[fn](v[o], v[o + 1]) : OURS[fn](v[o], v[o + 1], v[o + 2]);
    if (!Object.is(got, want)) {
      if (bad < 4) console.log(`  ${fn}(${Array.from(v.subarray(o, o + arity - 1)).join(', ')}) ours ${got} system ${want}`);
      bad++;
    }
  }
  console.log(`${fn.padEnd(6)} ${bad} of ${n} differ  (${((performance.now() - t0) / n * 1e3).toFixed(3)} µs/call)`);
}
