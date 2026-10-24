/**
 * Census of the .NET types and selected field values found in the Crystal
 * Ball data blocks of a set of workbooks — a reverse-engineering aid for
 * finding which serialized classes/fields occur in practice.
 *
 *   npx vite-node tools/cb-type-census.ts -- <dir-or-files...> [--field mDstParms] [--type Asm]
 *
 * Prints: per type, the number of instances and the workbooks it occurs in;
 * with --field NAME, every distinct value of that member (strings/numbers);
 * with --type SUBSTR, one JSON sample of each matching type.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { XlsxPackage } from '../src/cbfile/xlsx';
import { readCbStorage } from '../src/cbfile/storage';
import { decodeBlock } from '../src/cbfile/payload';
import { NrbfValue, isNrbfObject } from '../src/cbfile/nrbf';
import { toJsonSafe } from '../src/cbfile/jsonsafe';

function listWorkbooks(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (statSync(p).isDirectory()) {
      for (const f of readdirSync(p)) {
        const full = join(p, f);
        if (statSync(full).isDirectory()) out.push(...listWorkbooks([full]));
        else if (/\.xls[xm]$/i.test(f)) out.push(full);
      }
    } else out.push(p);
  }
  return out.sort();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const opt = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    args.splice(i, 2);
    return v;
  };
  const field = opt('--field');
  const typeFilter = opt('--type');
  const files = listWorkbooks(args);
  const types = new Map<string, { count: number; books: Set<string> }>();
  const values = new Map<string, Set<string>>();
  const samples = new Map<string, NrbfValue>();

  for (const file of files) {
    const book = basename(file);
    const pkg = await XlsxPackage.open(readFileSync(file));
    const storage = await readCbStorage(pkg);
    if (!storage) continue;
    for (const s of storage.sheets) {
      for (const b of s.blocks) {
        let graph: NrbfValue;
        try {
          graph = await decodeBlock(b.text);
        } catch (e) {
          console.log(`!! ${book} ${s.sheetName} ${b.id}: ${e}`);
          continue;
        }
        const seen = new Set<object>();
        const walk = (v: NrbfValue): void => {
          if (typeof v !== 'object' || v === null || seen.has(v)) return;
          seen.add(v);
          if (Array.isArray(v)) return v.forEach(walk);
          if (v instanceof Map) {
            for (const [k, x] of v) (walk(k), walk(x));
            return;
          }
          if (!isNrbfObject(v)) return;
          const t = types.get(v.$type) ?? { count: 0, books: new Set<string>() };
          t.count++;
          t.books.add(book);
          types.set(v.$type, t);
          if (typeFilter && v.$type.includes(typeFilter) && !samples.has(v.$type)) samples.set(v.$type, v);
          for (const [k, x] of Object.entries(v)) {
            if (field && k === field && (typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean')) {
              const set = values.get(v.$type) ?? new Set<string>();
              set.add(`${String(x)}    [${book}]`);
              values.set(v.$type, set);
            }
            walk(x as NrbfValue);
          }
        };
        walk(graph);
      }
    }
  }

  for (const [t, info] of [...types].sort((a, b) => a[0].localeCompare(b[0]))) {
    const where = info.books.size <= 4 ? `: ${[...info.books].join(', ')}` : '';
    console.log(`${String(info.count).padStart(6)}  ${t}  (${info.books.size} workbooks${where})`);
  }
  for (const [t, set] of values) {
    console.log(`\n== ${t}.${field}`);
    for (const v of [...set].sort()) console.log('   ' + v);
  }
  for (const [t, v] of samples) {
    console.log(`\n== sample ${t}`);
    console.log(JSON.stringify(toJsonSafe(v), null, 1));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
