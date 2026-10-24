/**
 * Read the Crystal Ball model of every workbook in a directory and print a
 * per-workbook summary: assumptions by distribution, forecasts, correlations,
 * decision variables and any warnings.
 *
 *   npx vite-node tools/cb-examples-report.ts -- <dir> [--json out.json]
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readCrystalBallModel } from '../src/cbfile/model';

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const jsonIdx = args.indexOf('--json');
  const jsonOut = jsonIdx >= 0 ? args[jsonIdx + 1] : undefined;
  const dir = args.find((a, i) => !a.startsWith('--') && i !== jsonIdx + 1);
  if (!dir) {
    console.error('usage: cb-examples-report.ts <dir> [--json out.json]');
    process.exit(2);
  }
  const files = readdirSync(dir).filter((f) => /\.xls[xm]$/i.test(f)).sort();
  const rows: unknown[] = [];
  for (const f of files) {
    try {
      const { model } = await readCrystalBallModel(readFileSync(join(dir, f)));
      const byType: Record<string, number> = {};
      for (const a of model.assumptions) byType[a.type] = (byType[a.type] ?? 0) + 1;
      const types = Object.entries(byType).map(([t, n]) => `${t}×${n}`).join(' ');
      console.log(
        `${f.padEnd(52)} A=${String(model.assumptions.length).padStart(3)} F=${String(model.forecasts.length).padStart(2)} ` +
          `C=${String(model.correlations.length).padStart(3)} D=${String(model.decisionVariables.length).padStart(2)}  ${types}`,
      );
      for (const w of model.warnings) console.log(`    ! ${w}`);
      rows.push({ file: f, ...model });
    } catch (e) {
      console.log(`${f.padEnd(52)} FAILED: ${(e as Error).message}`);
    }
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(rows, null, 1));
}

void main();
