/**
 * The Monte Carlo runner. It samples every assumption, optionally correlates
 * them, drives the model evaluator trial by trial, and summarizes each
 * forecast (statistics, percentiles, sensitivity) — the end-to-end engine
 * that both the HyperFormula and native-Excel paths feed into.
 */

import { applyCorrelations, buildTargetMatrix } from './correlation';
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
import { makeRng } from './rng';
import { generateSamples } from './sampling';
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

  // 1. Sample every assumption into columns.
  onProgress?.({ done: 0, total: n, phase: 'sampling' });
  const rng = makeRng(config.useSeed ? config.seed : Date.now());
  const columns = generateSamples(dists, n, config.sampling, config.lhsSampleSize, rng);

  // 2. Correlate, if requested.
  if (correlations.length) {
    const { matrix, hasAny } = buildTargetMatrix(
      assumptions.map((a) => a.id),
      correlations,
    );
    if (hasAny) applyCorrelations(columns, matrix, rng);
  }

  // 3. Drive the model, trial by trial.
  const forecastValues: number[][] = Array.from({ length: m }, () => new Array<number>(n));
  const inputs = new Array<number>(k);
  let nonFiniteSeen = false;

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
  }

  return finalize(n);

  function finalize(trialsRun: number): SimulationResult {
    onProgress?.({ done: trialsRun, total: n, phase: 'summarizing' });
    if (nonFiniteSeen)
      warnings.push(
        'Some trials produced non-numeric forecast values (formula errors or blanks); they are included as NaN and may distort statistics.',
      );

    const results: ForecastResult[] = forecasts.map((f, fi) => {
      const values = forecastValues[fi].slice(0, trialsRun);
      const clean = values.filter((v) => Number.isFinite(v));
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
          values,
        ),
      };
    });

    return {
      trials: trialsRun,
      sampling: config.sampling,
      seed: config.useSeed ? config.seed : null,
      durationMs: Date.now() - started,
      forecasts: results,
      warnings,
    };
  }
}
