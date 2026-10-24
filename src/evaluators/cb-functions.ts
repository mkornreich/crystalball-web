/**
 * Crystal Ball's in-cell spreadsheet functions for the in-browser evaluator.
 *
 * Probability functions (CB.Normal, CB.Triangular, CB.Binomial, …) work as in
 * Crystal Ball 11.1.3 (CBCallbacks CBFunctions): each call is an assumption of
 * its own, drawing from one stream shared by all calls — Crystal Ball's
 * "CBFunctionsOcbMgr", seeded with the run seed + 2910485164 — and returning
 * the distribution's (cut) inverse CDF of the next uniform. With Crystal Ball's
 * default cell preference a call returns the distribution's mean, without
 * drawing, while no trial has completed (the base case, and the run's first
 * trial). Missing cut arguments mean no cut.
 *
 * Calls draw in the order the formula engine evaluates them. Crystal Ball draws
 * in Excel's recalculation order, which Excel doesn't expose, so for models
 * built on these functions individual trials differ from Crystal Ball's while
 * every distribution (and so every statistic, up to sampling noise) matches.
 *
 * Reporting functions (CB.GetForeStatFN, CB.GetForePercentFN, CB.GetCertaintyFN,
 * CB.GetForeDataFN, CB.IterationsFN, CB.GetRunPrefsFN, CB.GetAssumPercentFN,
 * CB.Spearman) answer from the run in progress, like Crystal Ball's.
 */

import { FunctionArgumentType, FunctionPlugin, HyperFormula, SimpleCellAddress, SimpleRangeValue } from 'hyperformula';

// The slices of HyperFormula's (unexported) AST types these functions read.
interface Ast {
  type: string;
  reference?: { toSimpleCellAddress(base: SimpleCellAddress): SimpleCellAddress };
}
interface ProcedureAst {
  procedureName: string;
  args: Ast[];
}
interface InterpreterState {
  formulaAddress: SimpleCellAddress;
}
import { CustomPoint, Distribution, DistributionType, Params, createDistribution, truncate } from '../engine/distributions';
import { CB_MODULUS, CrystalBallRng } from '../engine/rng';
import { ForecastStatistics } from '../engine/model';
import { certainty, percentileSorted, spearman, summarize } from '../engine/statistics';
import { VAL_MAX } from '../engine/cbmath';

/** The run the functions answer to; owned by the evaluator. */
export interface CbFunctionContext {
  running: boolean;
  /** Trials completed so far in this run. */
  trialsDone: number;
  stream: CrystalBallRng | null;
  prefs: { trials: number; seed: number; useSeed: boolean; lhs: boolean; sampleSize: number };
  /** Forecast trial values so far, by "sheetId:row:col". */
  forecastValues: Map<string, number[]>;
  /** Assumption distributions by cell, for CB.GetAssumPercentFN. */
  assumptions: Map<string, Distribution>;
}

const FN_STREAM_OFFSET = 2910485164;

/** The function stream Crystal Ball creates at the start of a seeded run. */
export function functionStream(runSeed: number | null): CrystalBallRng {
  const seed = runSeed && runSeed > 0 ? (runSeed + FN_STREAM_OFFSET) >>> 0 : 1 + Math.floor(Math.random() * (CB_MODULUS - 2));
  return new CrystalBallRng(seed);
}

export function newContext(): CbFunctionContext {
  return {
    running: false,
    trialsDone: 0,
    stream: null,
    prefs: { trials: 1000, seed: 999, useSeed: true, lhs: false, sampleSize: 500 },
    forecastValues: new Map(),
    assumptions: new Map(),
  };
}

export const cellKey = (a: SimpleCellAddress) => `${a.sheet}:${a.row}:${a.col}`;

/**
 * The context of the evaluation in progress. HyperFormula evaluates
 * synchronously, so the evaluator wraps each call that may recalculate.
 */
let active: CbFunctionContext | null = null;
export function withContext<T>(ctx: CbFunctionContext, fn: () => T): T {
  const prev = active;
  active = ctx;
  try {
    return fn();
  } finally {
    active = prev;
  }
}

/** Excel formulas reference these as `_xll.CB.Normal(…)` or `CB.Normal(…)`. */
export function stripXll(formula: string): string {
  return formula.replace(/_xll\.(?=CB\.)/gi, '');
}

const NUM = { argumentType: FunctionArgumentType.NUMBER };
const OPT = { argumentType: FunctionArgumentType.NUMBER, optionalArg: true };
const NAME = { argumentType: FunctionArgumentType.ANY, optionalArg: true };
const cut = [OPT, OPT, NAME];

/** Each probability function: its arguments and how they map onto our distribution. */
interface ProbFn {
  params: unknown[];
  build(a: number[]): { type: DistributionType; params: Params; lo?: number; hi?: number };
}

const cuts = (lo: number, hi: number) => ({
  lo: Number.isFinite(lo) ? lo : undefined,
  hi: Number.isFinite(hi) ? hi : undefined,
});

const PROB: Record<string, ProbFn> = {
  'CB.NORMAL': { params: [NUM, NUM, ...cut], build: ([m, s, lo, hi]) => ({ type: 'normal', params: { mean: m, stdev: s }, ...cuts(lo, hi) }) },
  'CB.UNIFORM': { params: [NUM, NUM, ...cut], build: ([a, b, lo, hi]) => ({ type: 'uniform', params: { min: a, max: b }, ...cuts(lo, hi) }) },
  'CB.TRIANGULAR': { params: [NUM, NUM, NUM, ...cut], build: ([a, c, b, lo, hi]) => ({ type: 'triangular', params: { min: a, likely: c, max: b }, ...cuts(lo, hi) }) },
  'CB.BETAPERT': { params: [NUM, NUM, NUM, ...cut], build: ([a, c, b, lo, hi]) => ({ type: 'betapert', params: { min: a, likely: c, max: b }, ...cuts(lo, hi) }) },
  'CB.LOGNORMAL': {
    params: [NUM, NUM, ...cut, OPT],
    build: ([m, s, lo, hi, , loc]) => ({ type: 'lognormal', params: { mean: m, stdev: s, location: Number.isFinite(loc) ? loc : 0 }, ...cuts(lo, hi) }),
  },
  'CB.LOGNORMAL2': {
    params: [NUM, NUM, ...cut, OPT],
    build: ([m, s, lo, hi, , loc]) => ({ type: 'lognormal', params: { logMean: m, logStdev: s, location: Number.isFinite(loc) ? loc : 0 }, ...cuts(lo, hi) }),
  },
  'CB.LOGISTIC': { params: [NUM, NUM, ...cut], build: ([m, s, lo, hi]) => ({ type: 'logistic', params: { mean: m, scale: s }, ...cuts(lo, hi) }) },
  'CB.EXPONENTIAL': { params: [NUM, ...cut], build: ([r, lo, hi]) => ({ type: 'exponential', params: { rate: r }, ...cuts(lo, hi) }) },
  'CB.PARETO': { params: [NUM, NUM, ...cut], build: ([l, s, lo, hi]) => ({ type: 'pareto', params: { location: l, shape: s }, ...cuts(lo, hi) }) },
  'CB.WEIBULL': { params: [NUM, NUM, NUM, ...cut], build: ([l, sc, sh, lo, hi]) => ({ type: 'weibull', params: { location: l, scale: sc, shape: sh }, ...cuts(lo, hi) }) },
  'CB.GAMMA': { params: [NUM, NUM, NUM, ...cut], build: ([l, sc, sh, lo, hi]) => ({ type: 'gamma', params: { location: l, scale: sc, shape: sh }, ...cuts(lo, hi) }) },
  'CB.BETA': { params: [NUM, NUM, NUM, ...cut], build: ([al, be, sc, lo, hi]) => ({ type: 'beta', params: { min: 0, max: sc, alpha: al, beta: be }, ...cuts(lo, hi) }) },
  'CB.BETA2': { params: [NUM, NUM, NUM, NUM, ...cut], build: ([a, b, al, be, lo, hi]) => ({ type: 'beta', params: { min: a, max: b, alpha: al, beta: be }, ...cuts(lo, hi) }) },
  'CB.MAXEXTREME': { params: [NUM, NUM, ...cut], build: ([m, s, lo, hi]) => ({ type: 'maxextreme', params: { likeliest: m, scale: s }, ...cuts(lo, hi) }) },
  'CB.MINEXTREME': { params: [NUM, NUM, ...cut], build: ([m, s, lo, hi]) => ({ type: 'minextreme', params: { likeliest: m, scale: s }, ...cuts(lo, hi) }) },
  'CB.STUDENTT': { params: [NUM, NUM, NUM, ...cut], build: ([m, s, d, lo, hi]) => ({ type: 'studentt', params: { midpoint: m, scale: s, dof: d }, ...cuts(lo, hi) }) },
  'CB.YESNO': { params: [NUM, ...cut], build: ([p, lo, hi]) => ({ type: 'yesno', params: { probability: p }, ...cuts(lo, hi) }) },
  'CB.DISCRETEUNIFORM': { params: [NUM, NUM, ...cut], build: ([a, b, lo, hi]) => ({ type: 'discreteuniform', params: { min: a, max: b }, ...cuts(lo, hi) }) },
  'CB.POISSON': { params: [NUM, ...cut], build: ([r, lo, hi]) => ({ type: 'poisson', params: { rate: r }, ...cuts(lo, hi) }) },
  'CB.BINOMIAL': { params: [NUM, NUM, ...cut], build: ([p, n, lo, hi]) => ({ type: 'binomial', params: { trials: n, probability: p }, ...cuts(lo, hi) }) },
  'CB.NEGBINOMIAL': { params: [NUM, NUM, ...cut], build: ([p, r, lo, hi]) => ({ type: 'negbinomial', params: { probability: p, shape: r }, ...cuts(lo, hi) }) },
  'CB.GEOMETRIC': { params: [NUM, ...cut], build: ([p, lo, hi]) => ({ type: 'geometric', params: { probability: p }, ...cuts(lo, hi) }) },
  'CB.HYPERGEOMETRIC': {
    params: [NUM, NUM, NUM, ...cut],
    build: ([p, n, pop, lo, hi]) => ({ type: 'hypergeometric', params: { population: pop, successes: Math.round(p * pop), sample: n }, ...cuts(lo, hi) }),
  },
  'CB.HYPERGEOMETRIC2': {
    params: [NUM, NUM, NUM, ...cut],
    build: ([s, n, pop, lo, hi]) => ({ type: 'hypergeometric', params: { population: pop, successes: s, sample: n }, ...cuts(lo, hi) }),
  },
};

/** Crystal Ball's Custom function table: 1–5 columns per row (see CBCallbacks). */
export function customRows(rows: number[][], cumulative: boolean): CustomPoint[] {
  const out: CustomPoint[] = [];
  let prevCum = 0;
  for (const r of rows) {
    const v = r.map((x) => (typeof x === 'number' ? x : NaN));
    if (!Number.isFinite(v[0])) continue;
    let p: CustomPoint;
    switch (v.length) {
      case 1:
        p = { value: v[0], weight: 1 };
        break;
      case 2:
        p = { value: v[0], weight: v[1] };
        break;
      case 3:
        p = { min: v[0], max: v[1], weight: v[2] };
        break;
      case 4:
        p = Number.isFinite(v[3]) ? { min: v[0], max: v[1], weight: v[2], step: v[3] } : { min: v[0], max: v[1], weight: v[2] };
        break;
      default:
        p = { min: v[0], max: v[1], weight: v[2], endWeight: v[3], ...(Number.isFinite(v[4]) ? { step: v[4] } : {}) };
    }
    if (cumulative) {
      const w = p.weight - prevCum;
      prevCum = p.weight;
      p.weight = w;
    }
    out.push(p);
  }
  return out;
}

const STAT_BY_INDEX: (keyof ForecastStatistics | null)[] = [
  null, 'trials', 'mean', 'median', 'mode', 'stdDev', 'variance', 'skewness', 'kurtosis',
  'coeffOfVariability', 'min', 'max', 'range', 'meanStdError',
];

const distCache = new Map<string, Distribution>();
function cachedDistribution(type: DistributionType, params: Params, lo?: number, hi?: number, custom?: CustomPoint[]): Distribution {
  const key = `${type}|${JSON.stringify(params)}|${lo}|${hi}|${custom ? JSON.stringify(custom) : ''}`;
  let d = distCache.get(key);
  if (!d) {
    d = truncate(createDistribution(type, params, custom), lo, hi);
    if (distCache.size > 5000) distCache.clear();
    distCache.set(key, d);
  }
  return d;
}

class CrystalBallPlugin extends FunctionPlugin {
  private ctx(): CbFunctionContext {
    return active ?? fallback;
  }

  /** Draw (or report the mean of) a distribution, the way a CB function call does. */
  private sample(d: Distribution): number {
    const ctx = this.ctx();
    if (d.validate()) return NaN;
    if (!ctx.running || ctx.trialsDone === 0 || !ctx.stream) return d.mean();
    const v = d.quantile(ctx.stream.next());
    return Number.isFinite(v) && Math.abs(v) < VAL_MAX ? v : NaN;
  }

  probability(ast: ProcedureAst, state: InterpreterState) {
    const spec = PROB[ast.procedureName.toUpperCase()];
    return this.runFunction(ast.args as never, state as never, this.metadata(ast.procedureName.toUpperCase()), (...args: unknown[]) => {
      const nums = args.map((a) => (typeof a === 'number' ? a : NaN));
      const b = spec.build(nums);
      return this.sample(cachedDistribution(b.type, b.params, b.lo, b.hi));
    });
  }

  custom(ast: ProcedureAst, state: InterpreterState) {
    const name = ast.procedureName.toUpperCase();
    return this.runFunction(ast.args as never, state as never, this.metadata(name), (range: SimpleRangeValue) => {
      const rows = range.rawData().map((row) => row.map((x) => (typeof x === 'number' ? x : NaN)));
      const pts = customRows(rows, name === 'CB.CUSTOMCUMUL');
      if (!pts.length) return NaN;
      return this.sample(cachedDistribution('custom', {}, undefined, undefined, pts));
    });
  }

  iterations(ast: ProcedureAst, state: InterpreterState) {
    return this.runFunction(ast.args as never, state as never, this.metadata('CB.ITERATIONSFN'), () => this.ctx().trialsDone);
  }

  runPrefs(ast: ProcedureAst, state: InterpreterState) {
    return this.runFunction(ast.args as never, state as never, this.metadata('CB.GETRUNPREFSFN'), (index: number) => {
      const p = this.ctx().prefs;
      switch (index) {
        case 1:
          return p.trials;
        case 4:
          return p.useSeed;
        case 7:
          return p.lhs;
        case 8:
          return p.sampleSize;
        case 31:
          return p.seed;
        default:
          return NaN;
      }
    });
  }

  /** Values so far of the forecast whose cell the first argument references. */
  private forecastAt(ast: ProcedureAst, state: InterpreterState): number[] | undefined {
    const arg = ast.args[0];
    if (!arg || arg.type !== 'CELL_REFERENCE' || !arg.reference) return undefined;
    const addr = arg.reference.toSimpleCellAddress(state.formulaAddress);
    return this.ctx().forecastValues.get(cellKey(addr));
  }

  foreStat(ast: ProcedureAst, state: InterpreterState) {
    const values = this.forecastAt(ast, state);
    return this.runFunction(ast.args as never, state as never, this.metadata('CB.GETFORESTATFN'), (_cell: unknown, index: number) => {
      const kept = (values ?? []).filter(Number.isFinite);
      if (!kept.length) return index === 1 ? 0 : NaN;
      const key = STAT_BY_INDEX[index];
      if (!key) return NaN;
      const v = summarize(kept)[key];
      return typeof v === 'number' ? v : NaN;
    });
  }

  forePercent(ast: ProcedureAst, state: InterpreterState) {
    const values = this.forecastAt(ast, state);
    return this.runFunction(ast.args as never, state as never, this.metadata('CB.GETFOREPERCENTFN'), (_cell: unknown, pct: number) => {
      const kept = (values ?? []).filter(Number.isFinite).sort((a, b) => a - b);
      return kept.length ? percentileSorted(kept, pct) : NaN;
    });
  }

  certainty(ast: ProcedureAst, state: InterpreterState) {
    const values = this.forecastAt(ast, state);
    return this.runFunction(ast.args as never, state as never, this.metadata('CB.GETCERTAINTYFN'), (_cell: unknown, v: number) => {
      const kept = (values ?? []).filter(Number.isFinite);
      return kept.length ? certainty(kept, -Infinity, v) : NaN;
    });
  }

  foreData(ast: ProcedureAst, state: InterpreterState) {
    const values = this.forecastAt(ast, state);
    return this.runFunction(ast.args as never, state as never, this.metadata('CB.GETFOREDATAFN'), (_cell: unknown, i: number) => {
      const v = values?.[i - 1];
      return v !== undefined && Number.isFinite(v) ? v : NaN;
    });
  }

  assumPercent(ast: ProcedureAst, state: InterpreterState) {
    const arg = ast.args[0];
    const addr = arg && arg.type === 'CELL_REFERENCE' && arg.reference ? arg.reference.toSimpleCellAddress(state.formulaAddress) : undefined;
    return this.runFunction(ast.args as never, state as never, this.metadata('CB.GETASSUMPERCENTFN'), (_cell: unknown, pct: number) => {
      const d = addr ? this.ctx().assumptions.get(cellKey(addr)) : undefined;
      return d ? d.quantile(pct / 100) : NaN;
    });
  }

  spearmanFn(ast: ProcedureAst, state: InterpreterState) {
    return this.runFunction(ast.args as never, state as never, this.metadata('CB.SPEARMAN'), (a: SimpleRangeValue, b: SimpleRangeValue) => {
      const xs = a.rawNumbers().flat().filter(Number.isFinite);
      const ys = b.rawNumbers().flat().filter(Number.isFinite);
      return xs.length === ys.length ? spearman(xs, ys) : NaN;
    });
  }
}

const fallback = newContext();

const RANGE = { argumentType: FunctionArgumentType.RANGE };
const ANY = { argumentType: FunctionArgumentType.ANY };
const implemented: Record<string, { method: string; parameters?: unknown[]; isVolatile?: boolean }> = {};
for (const [name, spec] of Object.entries(PROB)) implemented[name] = { method: 'probability', parameters: spec.params, isVolatile: true };
Object.assign(implemented, {
  'CB.CUSTOM': { method: 'custom', parameters: [RANGE, NAME], isVolatile: true },
  'CB.CUSTOMCUMUL': { method: 'custom', parameters: [RANGE, NAME], isVolatile: true },
  'CB.ITERATIONSFN': { method: 'iterations', parameters: [], isVolatile: true },
  'CB.GETRUNPREFSFN': { method: 'runPrefs', parameters: [NUM], isVolatile: true },
  'CB.GETFORESTATFN': { method: 'foreStat', parameters: [NUM], isVolatile: true },
  'CB.GETFOREPERCENTFN': { method: 'forePercent', parameters: [NUM], isVolatile: true },
  'CB.GETCERTAINTYFN': { method: 'certainty', parameters: [NUM], isVolatile: true },
  'CB.GETFOREDATAFN': { method: 'foreData', parameters: [NUM], isVolatile: true },
  'CB.GETASSUMPERCENTFN': { method: 'assumPercent', parameters: [NUM], isVolatile: true },
  'CB.SPEARMAN': { method: 'spearmanFn', parameters: [RANGE, RANGE] },
});
// The reporting functions take a cell reference first; it is read from the AST, so
// HyperFormula must still accept (and not evaluate away) that argument.
for (const name of ['CB.GETFORESTATFN', 'CB.GETFOREPERCENTFN', 'CB.GETCERTAINTYFN', 'CB.GETFOREDATAFN', 'CB.GETASSUMPERCENTFN'])
  implemented[name].parameters = [ANY, NUM];
(CrystalBallPlugin as unknown as { implementedFunctions: unknown }).implementedFunctions = implemented;

let registered = false;
/** Register the CB.* functions with HyperFormula (idempotent). */
export function registerCrystalBallFunctions(): void {
  if (registered) return;
  const names = Object.fromEntries(Object.keys(implemented).map((n) => [n, n]));
  HyperFormula.registerFunctionPlugin(CrystalBallPlugin as never, { enGB: names, enUS: names });
  registered = true;
}
