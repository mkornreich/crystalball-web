/**
 * Shared types tying the simulation together: an assumption (a distribution
 * attached to an input cell), a forecast (an output cell to track), the
 * run configuration, and the abstract `ModelEvaluator` the engine calls to
 * turn a set of input values into forecast values.
 *
 * Two evaluators implement that interface: the in-browser HyperFormula engine
 * (fast, the default) and the native Excel recalculation engine (authentic,
 * slower) — so the Monte Carlo core never needs to know which is in use.
 */

import { CustomPoint, DistributionType, Params } from './distributions';

export type SamplingMethod = 'mc' | 'lhs';

/** A probability distribution attached to a worksheet input cell. */
export interface Assumption {
  /** Stable id (used as a map key across UI and storage). */
  id: string;
  /** A1 cell reference including sheet, e.g. "Model!B4". */
  cell: string;
  /** Display name (defaults to the cell's row label or the cell itself). */
  name: string;
  type: DistributionType;
  params: Params;
  /** Outcomes for the Custom distribution. */
  custom?: CustomPoint[];
  /** Optional lower/upper truncation bounds (Crystal Ball's "More" fields). */
  truncMin?: number;
  truncMax?: number;
}

/** A worksheet output cell whose distribution we want to characterize. */
export interface Forecast {
  id: string;
  cell: string;
  name: string;
  /** Optional display units, e.g. "$" or "days". */
  units?: string;
}

/** One pairwise rank correlation between two assumptions. */
export interface Correlation {
  a: string; // assumption id
  b: string; // assumption id
  coefficient: number; // Spearman target in [-1, 1]
}

export interface SimulationConfig {
  trials: number;
  sampling: SamplingMethod;
  /** Latin Hypercube block size (CB default 500, range 10–5000). */
  lhsSampleSize: number;
  /** Fix the seed for a reproducible run. */
  useSeed: boolean;
  seed: number;
}

export const DEFAULT_CONFIG: SimulationConfig = {
  trials: 1000,
  sampling: 'mc',
  lhsSampleSize: 500,
  useSeed: false,
  seed: 999,
};

/**
 * Turns input (assumption) values into output (forecast) values by evaluating
 * the workbook model. Implementations may be synchronous (HyperFormula) or
 * asynchronous (native Excel recalc); the runner awaits either.
 */
export interface ModelEvaluator {
  readonly inputCount: number;
  readonly outputCount: number;
  /** Evaluate one trial: given N input values, return M forecast values. */
  evaluate(inputs: number[]): number[] | Promise<number[]>;
  /** Release any held resources (e.g. the HyperFormula instance). */
  dispose(): void;
}

/** Per-forecast summary statistics (Crystal Ball's forecast view). */
export interface ForecastStatistics {
  trials: number;
  mean: number;
  median: number;
  mode: number | null;
  stdDev: number;
  variance: number;
  skewness: number;
  kurtosis: number; // non-excess (normal = 3), to match Crystal Ball
  coeffOfVariability: number;
  min: number;
  max: number;
  range: number;
  meanStdError: number;
}

/** One assumption's sensitivity contribution to a forecast. */
export interface SensitivityEntry {
  assumptionId: string;
  name: string;
  rankCorrelation: number; // signed Spearman, [-1, 1]
  contribution: number; // signed % of variance, sums to ±100 across entries
}

/** Everything computed for a single forecast after a run. */
export interface ForecastResult {
  forecastId: string;
  name: string;
  units?: string;
  values: number[]; // one value per trial
  stats: ForecastStatistics;
  percentiles: { p: number; value: number }[];
  sensitivity: SensitivityEntry[];
}

export interface SimulationResult {
  trials: number;
  sampling: SamplingMethod;
  seed: number | null;
  durationMs: number;
  forecasts: ForecastResult[];
  /** Any non-fatal warnings (unsupported formula, degenerate forecast, …). */
  warnings: string[];
}
