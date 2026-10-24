/**
 * List every forecast precision setting (FrcPrecisionPrefs) stored in Crystal
 * Ball workbooks, with the object path that holds it — which forecasts ask for
 * precision control, and with what statistics and requirement.
 *
 *   npx vite-node tools/cb-precision-census.ts -- <workbook.xlsx | dir> ...
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { XlsxPackage } from '../src/cbfile/xlsx';
import { readCbStorage } from '../src/cbfile/storage';
import { decodeBlock } from '../src/cbfile/payload';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function* walk(v: unknown, path: string, seen = new Set<unknown>()): Generator<[string, Obj]> {
  if (!v || typeof v !== 'object' || seen.has(v)) return;
  seen.add(v);
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) yield* walk(v[i], `${path}[${i}]`, seen);
    return;
  }
  const o = v as Obj;
  if (String(o.$type ?? '').endsWith('FrcPrecisionPrefs')) yield [path, o];
  for (const [k, x] of Object.entries(o)) yield* walk(x, `${path}.${k}`, seen);
}

async function census(file: string): Promise<void> {
  const pkg = await XlsxPackage.open(readFileSync(file));
  const storage = await readCbStorage(pkg);
  if (!storage) return;
  for (const s of storage.sheets)
    for (const b of s.blocks) {
      let value: unknown;
      try {
        value = await decodeBlock(b.text);
      } catch {
        continue;
      }
      for (const [path, p] of walk(value, `${s.sheetName}/${b.id}`)) {
        const top = path.split('.')[0];
        const item = Array.isArray(value) ? value[Number(/\[(\d+)\]/.exec(top)?.[1] ?? 0)] : value;
        const type = isObj(item) ? String(item.$type ?? '').split('.').pop() : '';
        const fields = ['fUsePrecision', 'fUseMean', 'fUseStdDev', 'fUsePercentile', 'fUsePercentileValue', 'fAbsolute', 'fAbsoluteUnits', 'fRelativePct']
          .map((k) => `${k.slice(1)}=${String(p[k])}`)
          .join(' ');
        console.log(`${file.split('/').pop()}  ${path} (${type})  ${fields}`);
      }
    }
}

async function main(): Promise<void> {
  const files: string[] = [];
  for (const a of process.argv.slice(2).filter((x) => x !== '--')) {
    if (statSync(a).isDirectory()) {
      for (const f of readdirSync(a)) if (/\.xls[xm]$/i.test(f)) files.push(join(a, f));
    } else files.push(a);
  }
  for (const f of files) await census(f).catch((e) => console.error(`${f}: ${(e as Error).message}`));
}

main();
