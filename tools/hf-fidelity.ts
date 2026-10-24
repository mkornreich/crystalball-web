/**
 * How faithfully the in-browser evaluator reproduces Excel: rebuild each
 * workbook from its formulas, then compare every formula cell's value with the
 * value Excel cached in the file when it last calculated (Crystal Ball
 * functions show their distribution's mean, as they do in a saved workbook).
 *
 *   npx vite-node tools/hf-fidelity.ts -- <dir-or-files...> [--show N]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DetailedCellError } from 'hyperformula';
import { readCrystalBallModel } from '../src/cbfile/model';
import { toWorkbookData } from '../src/cbfile/workbook-data';
import { HyperFormulaEvaluator } from '../src/evaluators/hyperformula-evaluator';

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const si = args.indexOf('--show');
  const show = si >= 0 ? Number(args[si + 1]) : 3;
  const files: string[] = [];
  for (const a of args.filter((x, i) => !x.startsWith('--') && (si < 0 || i !== si + 1))) {
    if (statSync(a).isDirectory()) {
      for (const f of readdirSync(a).sort()) if (/\.xls[xm]$/i.test(f)) files.push(join(a, f));
    } else files.push(a);
  }
  for (const file of files) {
    const { pkg, model } = await readCrystalBallModel(readFileSync(file));
    const data = await toWorkbookData(pkg);
    const ev = new HyperFormulaEvaluator(data, [], []);
    const hf = ev.engine;
    let total = 0;
    let same = 0;
    const bad: string[] = [];
    for (const [sheetName, rows] of Object.entries(data.sheets)) {
      const ws = await pkg.worksheet(sheetName);
      const sheet = hf.getSheetId(sheetName) as number;
      for (const cell of ws.cells.values()) {
        if (cell.formula === undefined) continue;
        const cached = cell.value;
        if (cached === null || cell.error) continue;
        total++;
        const v = hf.getCellValue({ sheet, row: cell.row - 1, col: cell.col - 1 });
        const ok =
          typeof cached === 'number' && typeof v === 'number'
            ? Math.abs(v - cached) <= 1e-9 * Math.max(1, Math.abs(cached))
            : typeof cached === 'boolean'
              ? v === cached
              : String(v) === String(cached);
        if (ok) same++;
        else if (bad.length < show)
          bad.push(`${sheetName}!${cell.ref} excel=${JSON.stringify(cached)} ours=${v instanceof DetailedCellError ? v.value : JSON.stringify(v)}  ${String(rows[cell.row - 1]?.[cell.col - 1]).slice(0, 90)}`);
      }
    }
    ev.dispose();
    const pct = total ? ((100 * same) / total).toFixed(2) : '—';
    console.log(`${basename(file).padEnd(50)} ${String(same).padStart(6)}/${String(total).padEnd(6)} ${pct}% match${model.assumptions.length ? '' : ' (no CB model)'}`);
    for (const b of bad) console.log(`    ${b}`);
  }
}

void main();
