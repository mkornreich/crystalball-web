/**
 * For each forecast of a Crystal Ball workbook that evaluates to an error in
 * the in-browser evaluator, walk its precedents back to the cell where the
 * error originates and print that cell's formula.
 *
 *   npx vite-node tools/hf-trace-errors.ts -- <workbook.xlsx> [...more]
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { DetailedCellError, SimpleCellAddress } from 'hyperformula';
import { readCrystalBallModel } from '../src/cbfile/model';
import { toWorkbookData } from '../src/cbfile/workbook-data';
import { HyperFormulaEvaluator } from '../src/evaluators/hyperformula-evaluator';

async function main(): Promise<void> {
  for (const file of process.argv.slice(2).filter((a) => a !== '--')) {
    const { pkg, model } = await readCrystalBallModel(readFileSync(file));
    const ev = new HyperFormulaEvaluator(await toWorkbookData(pkg), model.assumptions.map((a) => a.cell), model.forecasts.map((f) => f.cell));
    const hf = ev.engine;
    console.log(`== ${basename(file)}`);
    const seen = new Set<string>();
    for (const f of model.forecasts) {
      let addr = hf.simpleCellAddressFromString(f.cell, 0) as SimpleCellAddress;
      for (let depth = 0; depth < 60; depth++) {
        const v = hf.getCellValue(addr);
        if (!(v instanceof DetailedCellError)) break;
        const prec = hf.getCellPrecedents(addr).filter((p): p is SimpleCellAddress => 'col' in p);
        const bad = prec.find((p) => hf.getCellValue(p) instanceof DetailedCellError);
        if (!bad) {
          const where = hf.simpleCellAddressToString(addr, -1) ?? '';
          if (!seen.has(where)) {
            seen.add(where);
            console.log(`   ${f.name.slice(0, 30).padEnd(30)} ← ${where}: ${String(hf.getCellFormula(addr)).slice(0, 140)}  → ${v.value} ${v.message}`);
          }
          break;
        }
        addr = bad;
      }
    }
    ev.dispose();
  }
}

void main();
