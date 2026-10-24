/**
 * The Monte Carlo runner. It samples every assumption, optionally correlates
 * them, drives the model evaluator trial by trial, and summarizes each
 * forecast (statistics, percentiles, sensitivity) — the end-to-end engine
 * that both the HyperFormula and native-Excel paths feed into.
 */

import { createDistribution, Distribution, truncate } from './distributions';
import {
  Assumption,
  Correlation,
  Forecast,
  ForecastResult,
  ModelEvaluator,
  SimulationConfig,
  SimulationResult,
} from './model';
import { checkPrecision, precisionMet } from './precision';
import { CB_MODULUS } from './rng';
import { generateSamples, placementOf } from './sampling';
import { sensitivity } from './sensitivity';
import { percentiles, summarize } from './statistics';

export interface ProgressInfo {
  done: number;
  total: number;
  phase: 'sampling' | 'evaluating' | 'summarizing';
}

export interface RunOptions {
  onProgress?: (info: ProgressInfo) => void;
  /** Return true to abort the run early. */
  shouldCancel?: () => boolean;
  /** Yield to the event loop every this many trials (keeps the UI alive). */
  yieldEvery?: number;
}

function buildDistribution(a: Assumption): Distribution {
  const base = createDistribution(a.type, a.params, a.custom);
  return truncate(base, a.truncMin, a.truncMax);
}

const sleep = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * Run a full simulation. The evaluator maps one trial's assumption values to
 * that trial's forecast values; it may be synchronous (HyperFormula) or async
 * (native Excel).
 */
export async function runSimulation(
  assumptions: Assumption[],
  forecasts: Forecast[],
  correlations: Correlation[],
  config: SimulationConfig,
  evaluator: ModelEvaluator,
  options: RunOptions = {},
): Promise<SimulationResult> {
  const started = Date.now();
  const warnings: string[] = [];
  const { onProgress, shouldCancel, yieldEvery = 2000 } = options;
  const n = Math.max(1, Math.floor(config.trials));
  const k = assumptions.length;
  const m = forecasts.length;

  if (k === 0) throw new Error('Define at least one assumption before running.');
  if (m === 0) throw new Error('Define at least one forecast before running.');

  // Validate distributions up front.
  const dists = assumptions.map(buildDistribution);
  dists.forEach((d, i) => {
    const err = d.validate();
    if (err) throw new Error(`Assumption "${assumptions[i].name}": ${err}`);
  });

  // 1–2. Sample (and correlate) every assumption exactly as Crystal Ball does.
  onProgress?.({ done: 0, total: n, phase: 'sampling' });
  const seed = config.useSeed ? config.seed : 1 + (Date.now() % (CB_MODULUS - 2));
  const sample = generateSamples({
    dists,
    placements: assumptions.map((a) => placementOf(a.cell)),
    ids: assumptions.map((a) => a.id),
    trials: n,
    method: config.sampling,
    lhsSampleSize: config.lhsSampleSize,
    seed,
    sheetOrder: config.sheetOrder,
    correlations,
    assumeZero: config.assumeZeroCorrelations,
  });
  const columns = sample.columns;
  if (sample.correlationGroups.some((g) => g.approximate))
    warnings.push(
      'A correlation pattern needed an approximation (a blank coefficient closing a cycle, or a matrix that took more than one consistency repair); results may differ slightly from Crystal Ball.',
    );

  // 3. Drive the model, trial by trial.
  evaluator.beginRun?.({
    trials: n,
    seed: config.useSeed ? config.seed : null,
    sampling: config.sampling,
    lhsSampleSize: config.lhsSampleSize,
  });
  const forecastValues: number[][] = Array.from({ length: m }, () => new Array<number>(n));
  const inputs = new Array<number>(k);
  let nonFiniteSeen = false;
  // Precision control (OcbMgr): from trial 20, every `checkEvery` trials.
  const prec = config.precision;
  const precise = prec?.enabled ? forecasts.map((f, i) => (f.precision?.length ? i : -1)).filter((i) => i >= 0) : [];
  const checkEvery = Math.max(1, Math.floor(prec?.checkEvery ?? 50));
  let lastCheck = 0;

  for (let t = 0; t < n; t++) {
    if (shouldCancel?.()) {
      warnings.push(`Run cancelled after ${t} of ${n} trials.`);
      return finalize(t);
    }
    for (let j = 0; j < k; j++) inputs[j] = columns[j][t];
    const out = await evaluator.evaluate(inputs);
    for (let f = 0; f < m; f++) {
      const v = out[f];
      if (!Number.isFinite(v)) nonFiniteSeen = true;
      forecastValues[f][t] = v;
    }
    if (t % yieldEvery === yieldEvery - 1) {
      onProgress?.({ done: t + 1, total: n, phase: 'evaluating' });
      await sleep();
    }
    const done = t + 1;
    if (precise.length && done < n && done >= 20 && done - lastCheck >= checkEvery) {
      lastCheck = Math.floor(done / checkEvery) * checkEvery;
      const checks = precise.flatMap((fi) =>
        checkPrecision(keptValues(fi, done), forecasts[fi].precision!, prec!.confidence),
      );
      if (precisionMet(checks)) return finalize(done, true);
    }
  }

  return finalize(n);

  function keptValues(fi: number, trialsRun: number): number[] {
    const f = forecasts[fi];
    const lo = f.filterMin ?? -Infinity;
    const hi = f.filterMax ?? Infinity;
    return forecastValues[fi].slice(0, trialsRun).map((v) => (Number.isFinite(v) && v >= lo && v <= hi ? v : NaN));
  }

  function finalize(trialsRun: number, stoppedByPrecision = false): SimulationResult {
    evaluator.endRun?.();
    onProgress?.({ done: trialsRun, total: n, phase: 'summarizing' });
    if (nonFiniteSeen)
      warnings.push(
        'Some trials produced non-numeric forecast values (formula errors or blanks); they are included as NaN and may distort statistics.',
      );

    const results: ForecastResult[] = forecasts.map((f, fi) => {
      const values = forecastValues[fi].slice(0, trialsRun);
      // Error trials and filtered-out values don't count (Crystal Ball's kept trials).
      const kept = keptValues(fi, trialsRun);
      const clean = kept.filter((v) => Number.isFinite(v));
      const usable = clean.length ? clean : values;
      return {
        forecastId: f.id,
        name: f.name,
        units: f.units,
        values,
        stats: summarize(usable),
        percentiles: percentiles(usable),
        sensitivity: sensitivity(
          assumptions,
          columns.map((c) => c.slice(0, trialsRun)),
          kept,
        ),
        precision:
          prec?.enabled && f.precision?.length ? checkPrecision(kept, f.precision, prec.confidence) : undefined,
      };
    });

    return {
      trials: trialsRun,
      sampling: config.sampling,
      seed: config.useSeed ? config.seed : null,
      durationMs: Date.now() - started,
      forecasts: results,
      warnings,
      ...(stoppedByPrecision ? { stoppedByPrecision } : {}),
    };
  }
}
