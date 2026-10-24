/**
 * List the worksheet functions a workbook's formulas use that HyperFormula
 * (the in-browser evaluator) doesn't implement, with one example cell each.
 *
 *   npx vite-node tools/hf-function-gaps.ts -- <workbook.xlsx> [...more]
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { HyperFormula } from 'hyperformula';
import { XlsxPackage } from '../src/cbfile/xlsx';
import { toWorkbookData } from '../src/cbfile/workbook-data';

async function main(): Promise<void> {
  const known = new Set(HyperFormula.getRegisteredFunctionNames('enGB').map((n) => n.toUpperCase()));
  for (const file of process.argv.slice(2).filter((a) => a !== '--')) {
    const pkg = await XlsxPackage.open(readFileSync(file));
    const data = await toWorkbookData(pkg);
    const missing = new Map<string, string>();
    for (const [sheet, rows] of Object.entries(data.sheets)) {
      rows.forEach((row, r) =>
        row.forEach((v, c) => {
          if (typeof v !== 'string' || !v.startsWith('=')) return;
          for (const m of v.matchAll(/([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g)) {
            const fn = m[1].toUpperCase();
            if (!known.has(fn) && !missing.has(fn)) missing.set(fn, `${sheet}!R${r + 1}C${c + 1}: ${v.slice(0, 80)}`);
          }
        }),
      );
    }
    console.log(`${basename(file)}: ${missing.size ? '' : 'all functions supported'}`);
    for (const [fn, where] of missing) console.log(`   ${fn.padEnd(22)} ${where}`);
  }
}

void main();
