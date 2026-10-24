/**
 * Dump the raw decoded Crystal Ball data blocks of a workbook as JSON — the
 * storage layout plus every block's BinaryFormatter object graph. Useful for
 * reverse-engineering fields the model extractor does not interpret yet.
 *
 *   npx vite-node tools/dump-cb-blocks.ts -- <workbook.xlsx> [--raw] [--out file.json]
 *
 * --raw keeps framework collections unsimplified (ArrayList as {_items,_size}, …).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { XlsxPackage } from '../src/cbfile/xlsx';
import { readCbStorage } from '../src/cbfile/storage';
import { decodeBlock } from '../src/cbfile/payload';
import { toJsonSafe } from '../src/cbfile/jsonsafe';

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const raw = args.includes('--raw');
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args[outIdx + 1] : undefined;
  const file = args.find((a, i) => !a.startsWith('--') && (outIdx < 0 || i !== outIdx + 1));
  if (!file) {
    console.error('usage: dump-cb-blocks.ts <workbook.xlsx> [--raw] [--out file.json]');
    process.exit(2);
  }
  const pkg = await XlsxPackage.open(readFileSync(file));
  const storage = await readCbStorage(pkg);
  if (!storage) {
    console.log('no Crystal Ball data');
    return;
  }
  const result: Record<string, unknown> = { ...storage, sheets: [] as unknown[] };
  for (const s of storage.sheets) {
    const blocks: unknown[] = [];
    for (const b of s.blocks) {
      try {
        blocks.push({ id: b.id, extendedData: b.extendedData, cells: b.cells, length: b.text.length, value: await decodeBlock(b.text, { simplify: !raw }) });
      } catch (e) {
        blocks.push({ id: b.id, extendedData: b.extendedData, cells: b.cells, error: String(e) });
      }
    }
    (result.sheets as unknown[]).push({ ...s, blocks });
  }
  const json = JSON.stringify(toJsonSafe(result), null, 1);
  if (out) writeFileSync(out, json);
  else console.log(json);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
