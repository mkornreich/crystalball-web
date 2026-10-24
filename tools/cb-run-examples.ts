/**
 * Run real Crystal Ball workbooks end to end through this engine: read the
 * Crystal Ball model, mirror the sheets into the in-browser evaluator, and
 * simulate with Crystal Ball's settings (default: 1000 trials, Monte Carlo,
 * seed 999 — the settings behind every figure in the Crystal Ball docs).
 *
 *   npx vite-node tools/cb-run-examples.ts -- <dir-or-files...> [--trials N] [--lhs] [--seed S] [--precision] [--json out.json]
 *
 * --precision turns on Crystal Ball's precision control (its default: check every
 * 50 trials at 95% confidence) for forecasts that carry precision targets.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { readCrystalBallModel, resolveFormulaNames } from '../src/cbfile/model';
import { toWorkbookData } from '../src/cbfile/workbook-data';
import { HyperFormulaEvaluator } from '../src/evaluators/hyperformula-evaluator';
import { runSimulation } from '../src/engine/simulation';
import { certainty } from '../src/engine/statistics';

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== '--');
  const opt = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const trials = Number(opt('--trials') ?? 1000);
  const seed = Number(opt('--seed') ?? 999);
  const lhs = args.includes('--lhs');
  const jsonOut = opt('--json');
  const skip = new Set([opt('--trials'), opt('--seed'), jsonOut].filter(Boolean));
  const files: string[] = [];
  for (const a of args) {
    if (a.startsWith('--') || skip.has(a)) continue;
    if (statSync(a).isDirectory()) {
      for (const f of readdirSync(a).sort()) if (/\.xls[xm]$/i.test(f)) files.push(join(a, f));
    } else {
      files.push(a);
    }
  }
  const out: unknown[] = [];
  for (const file of files) {
    const name = basename(file);
    try {
      const { pkg, model } = await readCrystalBallModel(readFileSync(file));
      if (!model.assumptions.length || !model.forecasts.length) {
        console.log(`${name}: skipped (${model.assumptions.length} assumptions, ${model.forecasts.length} forecasts)`);
        continue;
      }
      const data = await toWorkbookData(pkg);
      const ev = new HyperFormulaEvaluator(data, model.assumptions.map((a) => a.cell), model.forecasts.map((f) => f.cell));
      resolveFormulaNames([...model.assumptions, ...model.forecasts], (e, sh) => ev.evaluateExpression(e, sh));
      const diag = ev.diagnostics(model.forecasts.map((f) => f.name));
      const t0 = Date.now();
      const res = await runSimulation(model.assumptions, model.forecasts, model.correlations, {
        trials,
        sampling: lhs ? 'lhs' : 'mc',
        lhsSampleSize: 500,
        useSeed: true,
        seed,
        sheetOrder: model.sheetOrder,
        precision: { enabled: args.includes('--precision'), checkEvery: 50, confidence: 0.95 },
      }, ev);
      ev.dispose();
      console.log(
        `${name}: ${res.trials} trials${res.stoppedByPrecision ? ' (precision met)' : ''} in ${Date.now() - t0} ms${diag.length ? `  ! ${diag.join('; ')}` : ''}`,
      );
      for (const f of res.forecasts) {
        const s = f.stats;
        console.log(
          `   ${f.name.slice(0, 34).padEnd(34)} n=${s.trials} mean=${s.mean.toPrecision(7)} sd=${s.stdDev.toPrecision(6)} ` +
            `med=${s.median.toPrecision(6)} P(>=0)=${certainty(f.values.filter(Number.isFinite), 0, Infinity).toFixed(2)}%` +
            ` top=${f.sensitivity[0]?.name ?? '-'} ${f.sensitivity[0]?.contribution.toFixed(1) ?? ''}%`,
        );
      }
      for (const w of [...model.warnings, ...res.warnings]) console.log(`   ! ${w}`);
      out.push({ file: name, forecasts: res.forecasts.map((f) => ({ name: f.name, stats: f.stats, percentiles: f.percentiles })) });
    } catch (e) {
      console.log(`${name}: FAILED ${(e as Error).message}`);
    }
  }
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(out, null, 1));
}

void main();
