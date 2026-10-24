/**
 * Read the Crystal Ball model saved in a real Crystal Ball workbook (.xlsx /
 * .xlsm) into this engine's types: assumptions (distribution, parameters,
 * cuts, Custom tables), forecasts (with their filter), pairwise correlations
 * (CorrelationRef objects and worksheet correlation matrices) and decision
 * variables. Run preferences are a per-user Crystal Ball setting and are not
 * stored in workbooks, so callers supply them.
 *
 * Storage layout: storage.ts / payload.ts / nrbf.ts. Each data block is a
 * BinaryFormatter ArrayList of CB7 "cell refs"; an object's cell is found
 * through the hidden defined name CB_<object guid without dashes>.
 */

import { CustomPoint, DistributionType, Params } from '../engine/distributions';
import { Assumption, Correlation, Forecast } from '../engine/model';
import { assignPercentileSlots, solvePercentileParams, supportsPercentiles } from '../engine/percentile-params';
import type { PrecisionRequirement } from '../engine/precision';
import { NrbfValue, isNrbfObject } from './nrbf';
import { decodeBlock } from './payload';
import { CB_DATA_SHEET, readCbStorage } from './storage';
import { XlsxPackage, splitSheetRef, parseCellRef, cellRef } from './xlsx';

export interface CbDecisionVariable {
  id: string;
  name: string;
  cell: string;
}

export interface CbWorkbookModel {
  assumptions: Assumption[];
  forecasts: Forecast[];
  correlations: Correlation[];
  decisionVariables: CbDecisionVariable[];
  /** Worksheet tab order (Crystal Ball's sampling order follows it). */
  sheetOrder: string[];
  /** Crystal Ball build that saved the workbook, e.g. "11.1.3833.0". */
  savedBy?: string;
  warnings: string[];
}

type Obj = Record<string, unknown>;

const NO_CUT = 1e300;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function typeOf(v: unknown): string {
  return isObj(v) && typeof v.$type === 'string' ? v.$type : '';
}
function num(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  return NaN;
}
function guidKey(guid: string): string {
  return guid.replace(/-/g, '').toLowerCase();
}
function list(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (isObj(v) && Array.isArray(v._items)) return (v._items as unknown[]).slice(0, num(v._size));
  return [];
}

/** "Model!$C$9" / "'My Sheet'!$C$9" → "Model!C9" (quoted when needed). */
function normalizeRef(refersTo: string, fallbackSheet: string): string | undefined {
  const { sheet, address } = splitSheetRef(refersTo.replace(/^=/, ''));
  const a = address.replace(/\$/g, '').split(':')[0];
  if (!/^[A-Za-z]+\d+$/.test(a)) return undefined;
  const s = sheet ?? fallbackSheet;
  return `${/^[A-Za-z_][A-Za-z0-9_.]*$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`}!${a.toUpperCase()}`;
}

/* ------------------------- distribution text ------------------------- */

interface ParsedDst {
  name: string;
  values: Record<string, number>;
  /** The named parameters in order; "10%=80" is a percentile (prob 0.1) standing in for its slot. */
  slots: { key: string; value: number; prob?: number }[];
  loCut?: number;
  hiCut?: number;
}

/** "LogNormal,=500000,=750000,Mean=600000,StdDev=50000,Location=0" → parts. */
export function parseDstText(text: string): ParsedDst {
  const [name, ...rest] = text.split(',').map((s) => s.trim());
  const values: Record<string, number> = {};
  const slots: ParsedDst['slots'] = [];
  const unnamed: number[] = [];
  for (const tok of rest) {
    const eq = tok.indexOf('=');
    if (eq < 0) continue;
    const key = tok.slice(0, eq).trim();
    const v = Number(tok.slice(eq + 1));
    if (key === '') {
      unnamed.push(v);
      continue;
    }
    const k = key.toLowerCase();
    values[k] = v;
    const pct = /^(\d+(?:\.\d*)?|\.\d+)\s*%$/.exec(k);
    if (pct) slots.push({ key: k, value: v, prob: Number(pct[1]) / 100 });
    else if (k !== 'locut' && k !== 'hicut') slots.push({ key: k, value: v });
  }
  // Unnamed leading values are the cut positions (LoCut, HiCut).
  const lo = values.locut ?? unnamed[0];
  const hi = values.hicut ?? unnamed[1];
  return {
    name,
    values,
    slots,
    loCut: lo !== undefined && Number.isFinite(lo) && Math.abs(lo) < NO_CUT ? lo : undefined,
    hiCut: hi !== undefined && Number.isFinite(hi) && Math.abs(hi) < NO_CUT ? hi : undefined,
  };
}

/** Crystal Ball distribution name + parameters → ours. */
function mapDistribution(
  d: ParsedDst,
  warn: (m: string) => void,
): { type: DistributionType; params: Params; entered?: ParsedDst['slots'] } | null {
  if (d.slots.some((s) => s.prob !== undefined)) return mapPercentiles(d, warn);
  const v = d.values;
  const need = (...keys: string[]) => keys.every((k) => Number.isFinite(v[k]));
  switch (d.name.toLowerCase()) {
    case 'normal':
      if (need('mean', 'stddev')) return { type: 'normal', params: { mean: v.mean, stdev: v.stddev } };
      break;
    case 'triangular':
      if (need('min', 'likeliest', 'max'))
        return { type: 'triangular', params: { min: v.min, likely: v.likeliest, max: v.max } };
      break;
    case 'betapert':
      if (need('min', 'likeliest', 'max'))
        return { type: 'betapert', params: { min: v.min, likely: v.likeliest, max: v.max } };
      break;
    case 'uniform':
      if (need('min', 'max')) return { type: 'uniform', params: { min: v.min, max: v.max } };
      break;
    case 'lognormal': {
      const location = Number.isFinite(v.location) ? v.location : 0;
      if (need('mean', 'stddev')) return { type: 'lognormal', params: { mean: v.mean, stdev: v.stddev, location } };
      if (need('logmean', 'logstddev'))
        return { type: 'lognormal', params: { logMean: v.logmean, logStdev: v.logstddev, location } };
      if (need('geomean', 'geostddev'))
        return { type: 'lognormal', params: { geoMean: v.geomean, geoStdev: v.geostddev, location } };
      break;
    }
    case 'exponential':
      if (need('rate')) return { type: 'exponential', params: { rate: v.rate } };
      break;
    case 'gamma':
      if (need('scale', 'shape'))
        return { type: 'gamma', params: { location: v.location ?? 0, scale: v.scale, shape: v.shape } };
      break;
    case 'weibull':
      if (need('scale', 'shape'))
        return { type: 'weibull', params: { location: v.location ?? 0, scale: v.scale, shape: v.shape } };
      break;
    case 'beta':
      if (need('min', 'max', 'alpha', 'beta'))
        return { type: 'beta', params: { min: v.min, max: v.max, alpha: v.alpha, beta: v.beta } };
      break;
    case 'logistic':
      if (need('mean', 'scale')) return { type: 'logistic', params: { mean: v.mean, scale: v.scale } };
      break;
    case 'pareto':
      if (need('location', 'shape')) return { type: 'pareto', params: { location: v.location, shape: v.shape } };
      break;
    case 'student':
      if (need('midpoint', 'scale', 'degrees'))
        return { type: 'studentt', params: { midpoint: v.midpoint, scale: v.scale, dof: v.degrees } };
      break;
    case 'maxextreme':
    case 'minextreme':
      if (need('likeliest', 'scale'))
        return {
          type: d.name.toLowerCase() === 'maxextreme' ? 'maxextreme' : 'minextreme',
          params: { likeliest: v.likeliest, scale: v.scale },
        };
      break;
    case 'dyesno':
      if (need('prob')) return { type: 'yesno', params: { probability: v.prob } };
      break;
    case 'duniform':
      if (need('min', 'max')) return { type: 'discreteuniform', params: { min: v.min, max: v.max } };
      break;
    case 'dbinomial':
      if (need('trials', 'prob')) return { type: 'binomial', params: { trials: v.trials, probability: v.prob } };
      break;
    case 'dpoisson':
      if (need('rate')) return { type: 'poisson', params: { rate: v.rate } };
      break;
    case 'dgeometric':
      if (need('prob')) return { type: 'geometric', params: { probability: v.prob } };
      break;
    case 'dnegbinomial':
      if (need('prob', 'shape')) return { type: 'negbinomial', params: { probability: v.prob, shape: v.shape } };
      break;
    case 'dhypergeo':
      if (need('trials', 'popultn') && Number.isFinite(v.success))
        return { type: 'hypergeometric', params: { population: v.popultn, successes: v.success, sample: v.trials } };
      if (need('trials', 'popultn', 'prob'))
        return {
          type: 'hypergeometric',
          params: { population: v.popultn, successes: Math.round(v.prob * v.popultn), sample: v.trials },
        };
      break;
    default:
      warn(`Unsupported distribution "${d.name}".`);
      return null;
  }
  warn(`Could not read the parameters of "${d.name}" (percentile or other alternate form?).`);
  return null;
}

/** A Crystal Ball distribution text ("Normal,10%=80,90%=120") as our type and parameters. */
export function distributionFromText(
  text: string,
  warn: (m: string) => void = () => {},
): { type: DistributionType; params: Params; entered?: ParsedDst['slots'] } | null {
  return mapDistribution(parseDstText(text), warn);
}

const PERCENTILE_TYPES: Record<string, DistributionType> = {
  normal: 'normal',
  triangular: 'triangular',
  betapert: 'betapert',
  uniform: 'uniform',
  lognormal: 'lognormal',
  exponential: 'exponential',
  gamma: 'gamma',
  weibull: 'weibull',
  beta: 'beta',
  logistic: 'logistic',
  pareto: 'pareto',
  student: 'studentt',
  maxextreme: 'maxextreme',
  minextreme: 'minextreme',
};

/** Parameters entered as percentiles: solve the distribution's parameters the way Crystal Ball does. */
function mapPercentiles(
  d: ParsedDst,
  warn: (m: string) => void,
): { type: DistributionType; params: Params; entered: ParsedDst['slots'] } | null {
  const type = PERCENTILE_TYPES[d.name.toLowerCase()];
  if (!type || !supportsPercentiles(type)) {
    warn(`Percentile parameters are not supported for "${d.name}".`);
    return null;
  }
  try {
    const { slots, keys } = assignPercentileSlots(type, d.slots);
    const params = solvePercentileParams(type, slots, keys);
    return { type, params, entered: d.slots };
  } catch (e) {
    warn(`${d.name}: ${(e as Error).message}`);
    return null;
  }
}

/** Crystal Ball CustomValue rows → our Custom outcomes. */
function mapCustom(data: unknown, warn: (m: string) => void): CustomPoint[] {
  const out: CustomPoint[] = [];
  for (const row of list(data)) {
    if (!isObj(row)) continue;
    const value = num(row.mValue);
    const end = num(row.mEndValue);
    const prob = num(row.mProb);
    const endProb = num(row.mEndProb);
    const step = num(row.mStep);
    switch (num(row.mCustomType)) {
      case 1: // Discrete
        out.push({ value, weight: prob });
        break;
      case 2: // UniformDiscreteRange
        out.push({ min: value, max: end, step, weight: prob });
        break;
      case 3: // UniformRange
        out.push({ min: value, max: end, weight: prob });
        break;
      case 4: // SlopedRange
        out.push({ min: value, max: end, weight: prob, endWeight: endProb });
        break;
      case 5: // SlopedDiscreteRange
        out.push({ min: value, max: end, step, weight: prob, endWeight: endProb });
        break;
      default:
        warn('Skipped an unrecognized Custom row.');
    }
  }
  return out;
}

/* ------------------------------ reader ------------------------------- */

/**
 * Crystal Ball names can be formulas (`$I12&" - "&J$11`, `"CP - " & $C$8`)
 * that it evaluates in the object's sheet; replace those with their text.
 */
export function resolveFormulaNames(
  items: { name: string; cell: string }[],
  evaluate: (expr: string, sheet: string) => string | undefined,
): void {
  for (const it of items) {
    if (!/[&"]|\$[A-Z]+\$?\d|\b[A-Z]{1,3}\$\d/.test(it.name)) continue;
    const bang = it.cell.lastIndexOf('!');
    const sheet = it.cell.slice(0, bang).replace(/^'(.*)'$/, '$1').replace(/''/g, "'");
    const text = evaluate(it.name, sheet);
    if (text !== undefined && text.trim()) it.name = text.trim();
  }
}

/** Parse the Crystal Ball model of an .xlsx/.xlsm workbook (bytes). */
export async function readCrystalBallModel(
  data: Uint8Array | ArrayBuffer,
): Promise<{ pkg: XlsxPackage; model: CbWorkbookModel }> {
  const pkg = await XlsxPackage.open(data);
  const model: CbWorkbookModel = {
    assumptions: [],
    forecasts: [],
    correlations: [],
    decisionVariables: [],
    sheetOrder: pkg.sheets.filter((s) => s.kind === 'worksheet' && s.name !== CB_DATA_SHEET).map((s) => s.name),
    warnings: [],
  };
  const storage = await readCbStorage(pkg);
  if (!storage) {
    model.warnings.push('No Crystal Ball data found in this workbook.');
    return { pkg, model };
  }
  model.warnings.push(...storage.warnings);

  const items: { sheet: string; sheetIndex: number; item: Obj }[] = [];
  for (const sh of storage.sheets) {
    if (sh.buildVersion && !model.savedBy) model.savedBy = sh.buildVersion;
    for (const block of sh.blocks) {
      let value: NrbfValue;
      try {
        value = await decodeBlock(block.text);
      } catch (e) {
        model.warnings.push(`${sh.sheetName}: could not decode ${block.id} (${(e as Error).message}).`);
        continue;
      }
      for (const item of list(value)) if (isObj(item)) items.push({ sheet: sh.sheetName, sheetIndex: sh.sheetIndex, item });
    }
  }

  const cellOf = (item: Obj, sheet: string, sheetIndex: number): string | undefined => {
    const ident = isObj(item.mObjectIdentity) ? item.mObjectIdentity : undefined;
    const guid = typeof ident?.mObjectGuid === 'string' ? ident.mObjectGuid : typeof item.mGuid === 'string' ? item.mGuid : '';
    const name = pkg.definedName(`CB_${guidKey(guid)}`, sheetIndex) ?? pkg.definedName(`CB_${guidKey(guid)}`);
    return name ? normalizeRef(name.refersTo, sheet) : undefined;
  };
  const idOf = (item: Obj): string => {
    const ident = isObj(item.mObjectIdentity) ? item.mObjectIdentity : undefined;
    return String(ident?.mObjectGuid ?? item.mGuid ?? `cb-${items.indexOf(items.find((x) => x.item === item)!)}`);
  };

  const byName = new Map<string, string>(); // assumption name → id
  for (const { sheet, sheetIndex, item } of items) {
    const t = typeOf(item);
    // A name of "=H8" means "use the label in H8" (Crystal Ball's name-from-cell).
    let name = String(item.mVarName ?? '');
    if (name.startsWith('=')) name = await resolveLabel(pkg, name.slice(1), sheet);
    if (t.endsWith('.AssumptionCellRef')) {
      const cell = cellOf(item, sheet, sheetIndex);
      const warn = (m: string) => model.warnings.push(`${name || cell}: ${m}`);
      if (!cell) {
        warn('cell not found; skipped.');
        continue;
      }
      const text = String(item.mDstParms ?? '');
      const parsed = parseDstText(text);
      const id = idOf(item);
      let a: Assumption | null = null;
      if (parsed.name.toLowerCase() === 'custom') {
        const dst = isObj(item.mVar) && isObj(item.mVar.mDst) ? item.mVar.mDst : undefined;
        const custom = mapCustom(dst?.CustomData, warn);
        if (custom.length) a = { id, cell, name: name || cell, type: 'custom', params: {}, custom };
        else warn('Custom distribution has no data; skipped.');
      } else {
        const mapped = mapDistribution(parsed, warn);
        if (mapped) a = { id, cell, name: name || cell, type: mapped.type, params: mapped.params };
        if (a && mapped?.entered) a.entered = mapped.entered;
      }
      if (!a) continue;
      if (parsed.loCut !== undefined) a.truncMin = parsed.loCut;
      if (parsed.hiCut !== undefined) a.truncMax = parsed.hiCut;
      model.assumptions.push(a);
      if (name) byName.set(name, id);
    } else if (t.endsWith('.ForecastCellRef')) {
      const cell = cellOf(item, sheet, sheetIndex);
      if (!cell) {
        model.warnings.push(`${name}: forecast cell not found; skipped.`);
        continue;
      }
      const f: Forecast = { id: idOf(item), cell, name: name || cell };
      const frc = isObj(item.mVar) ? item.mVar : undefined;
      const lo = num(frc?.mLoCut);
      const hi = num(frc?.mHiCut);
      if (Number.isFinite(lo) && Math.abs(lo) < NO_CUT) f.filterMin = lo;
      if (Number.isFinite(hi) && Math.abs(hi) < NO_CUT) f.filterMax = hi;
      const prefs = isObj(item.mPreferences) ? item.mPreferences : undefined;
      const precision = mapPrecision(isObj(prefs?.fPrecisionPrefs) ? prefs.fPrecisionPrefs : undefined);
      if (precision) f.precision = precision;
      model.forecasts.push(f);
    } else if (t.endsWith('.DecVarCellRef')) {
      const cell = cellOf(item, sheet, sheetIndex);
      if (cell) model.decisionVariables.push({ id: idOf(item), name: name || cell, cell });
    }
  }

  // Correlations: pair objects, then worksheet matrices.
  const ids = new Set(model.assumptions.map((a) => a.id));
  for (const { item } of items) {
    const t = typeOf(item);
    if (t.endsWith('.CorrelationRef')) {
      const a = String(item.mAssumption1Guid ?? '');
      const b = String(item.mAssumption2Guid ?? '');
      let c = num(item.mCoefficient);
      if (typeof item.mCoeffiecientRefersTo === 'string' && item.mCoeffiecientRefersTo) {
        const linked = await readRefNumber(pkg, item.mCoeffiecientRefersTo);
        if (Number.isFinite(linked)) c = linked;
      }
      if (ids.has(a) && ids.has(b) && Number.isFinite(c)) model.correlations.push({ a, b, coefficient: c });
      else model.warnings.push('A correlation refers to an assumption that was not read; skipped.');
    } else if (t.endsWith('.CorrelationMatrixRef')) {
      await readMatrix(pkg, item, byName, model);
    }
  }
  return { pkg, model };
}

/**
 * A forecast's precision settings (CBPrefs FrcPrecisionPrefs) as requirements,
 * the way SimEngine registers them: mean, then the chosen percentile, then the
 * standard deviation, all with the one absolute-units or relative-% target.
 */
function mapPrecision(p: Obj | undefined): PrecisionRequirement[] | undefined {
  if (!p || p.fUsePrecision !== true) return undefined;
  const absolute = p.fAbsolute === true;
  const value = absolute ? num(p.fAbsoluteUnits) : num(p.fRelativePct) * 100;
  if (!Number.isFinite(value)) return undefined;
  const reqs: PrecisionRequirement[] = [];
  if (p.fUseMean === true) reqs.push({ stat: 'mean', absolute, value });
  if (p.fUsePercentile === true) reqs.push({ stat: 'percentile', percentile: num(p.fUsePercentileValue) * 100, absolute, value });
  if (p.fUseStdDev === true) reqs.push({ stat: 'stddev', absolute, value });
  return reqs.length ? reqs : undefined;
}

async function resolveLabel(pkg: XlsxPackage, ref: string, sheet: string): Promise<string> {
  const { sheet: s, address } = splitSheetRef(ref);
  try {
    const ws = await pkg.worksheet(s ?? sheet);
    const v = ws.cells.get(address.replace(/\$/g, '').toUpperCase())?.value;
    return v === null || v === undefined ? ref : String(v).trim();
  } catch {
    return ref;
  }
}

async function readRefNumber(pkg: XlsxPackage, refersTo: string): Promise<number> {
  const { sheet, address } = splitSheetRef(refersTo.replace(/^=/, ''));
  if (!sheet) return NaN;
  const ws = await pkg.worksheet(sheet);
  const cell = ws.cells.get(address.replace(/\$/g, '').toUpperCase());
  return typeof cell?.value === 'number' ? cell.value : NaN;
}

/** A correlation matrix kept on a worksheet: names above and to the left of the coefficients. */
async function readMatrix(pkg: XlsxPackage, item: Obj, byName: Map<string, string>, model: CbWorkbookModel) {
  const loc = String(item._MatrixLocation ?? '').replace(/^=/, '');
  const { sheet, address } = splitSheetRef(loc);
  const [from, to] = address.replace(/\$/g, '').split(':');
  if (!sheet || !from || !to) {
    model.warnings.push(`Correlation matrix at "${loc}" could not be located.`);
    return;
  }
  const ws = await pkg.worksheet(sheet);
  const tl = parseCellRef(from);
  const br = parseCellRef(to);
  const at = (r: number, c: number) => ws.cells.get(cellRef(r, c))?.value;
  const n = br.row - tl.row + 1;
  const rowIds: (string | undefined)[] = [];
  for (let i = 0; i < n; i++) {
    const label = at(tl.row + i, tl.col - 1) ?? at(tl.row - 1, tl.col + i);
    rowIds.push(typeof label === 'string' ? byName.get(label.trim()) : undefined);
  }
  if (rowIds.some((x) => !x)) model.warnings.push(`Correlation matrix at "${loc}": some labels did not match an assumption name.`);
  const lower = item._IsLowerTriangular === true;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j || (lower ? j > i : j < i)) continue;
      const v = at(tl.row + i, tl.col + j);
      const a = rowIds[i];
      const b = rowIds[j];
      if (typeof v === 'number' && a && b) model.correlations.push({ a, b, coefficient: v });
    }
  }
}
