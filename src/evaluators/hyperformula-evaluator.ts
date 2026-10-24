/**
 * In-browser model evaluator backed by HyperFormula.
 *
 * The workbook's cells (values and formula strings) are mirrored into a
 * HyperFormula instance once. Each trial then batch-writes the assumption
 * cells — triggering an incremental recalculation of just their dependents —
 * and reads the forecast cells back from cache. No round trip to Excel, so a
 * run of thousands of trials completes in well under a second.
 *
 * HyperFormula is licensed GPL-3.0; the `licenseKey: 'gpl-v3'` config below
 * is the library's required acknowledgement for open-source use.
 */

import {
  DetailedCellError,
  HyperFormula,
  SimpleCellAddress,
} from 'hyperformula';
import { ModelEvaluator, SamplingMethod } from '../engine/model';
import {
  CbFunctionContext,
  cellKey,
  functionStream,
  newContext,
  registerCrystalBallFunctions,
  withContext,
} from './cb-functions';
import { registerExcelCompatFunctions } from './excel-compat';

/** Raw worksheet contents: numbers/strings/booleans, or '=...' formula strings. */
export type RawCell = string | number | boolean | null;

export interface WorkbookData {
  /** Sheet name -> rectangular 2D array of cell contents (row-major). */
  sheets: Record<string, RawCell[][]>;
  /** Sheet used to resolve A1 references that carry no "Sheet!" prefix. */
  defaultSheet: string;
  /** Workbook defined names (e.g. `Rate` → `=Model!$B$2`); `scope` is a sheet name. */
  names?: { name: string; expression: string; scope?: string }[];
}

const HF_CONFIG = {
  licenseKey: 'gpl-v3',
  // Full double precision, as Excel computes (smart rounding would cut results to 10 decimals).
  smartRounding: false,
  // Excel's pre-dynamic-array semantics (implicit intersection), as Crystal Ball's
  // workbooks were built for; array formulas arrive wrapped in ARRAYFORMULA().
  useArrayArithmetic: false,
  evaluateNullToZero: true,
};

/**
 * Build the engine; names HyperFormula can't accept (e.g. ones that look like
 * cell addresses, or refer to other workbooks) are dropped one by one.
 */
function buildTolerantly(
  sheets: Record<string, RawCell[][]>,
  named: { name: string; expression: string; scope?: number }[],
): HyperFormula {
  let rest = named;
  for (;;) {
    try {
      return HyperFormula.buildFromSheets(sheets, HF_CONFIG, rest);
    } catch (e) {
      const msg = (e as Error).message;
      const bad = rest.findIndex((n) => msg.includes(n.name));
      if (bad < 0 || !rest.length) return HyperFormula.buildFromSheets(sheets, HF_CONFIG);
      rest = rest.filter((_, i) => i !== bad);
    }
  }
}

export class HyperFormulaEvaluator implements ModelEvaluator {
  private hf: HyperFormula;
  private inputAddrs: SimpleCellAddress[];
  private outputAddrs: SimpleCellAddress[];
  readonly inputCount: number;
  readonly outputCount: number;
  /** What Crystal Ball's spreadsheet functions see (base case until a run starts). */
  private cb: CbFunctionContext = newContext();

  constructor(data: WorkbookData, inputCells: string[], outputCells: string[]) {
    registerCrystalBallFunctions();
    registerExcelCompatFunctions();
    const sheetNames = Object.keys(data.sheets);
    const named = (data.names ?? [])
      .map((n) => ({
        name: n.name,
        expression: n.expression,
        scope: n.scope === undefined ? undefined : sheetNames.indexOf(n.scope),
      }))
      .filter((n) => n.scope === undefined || n.scope >= 0);
    this.hf = withContext(this.cb, () => buildTolerantly(data.sheets, named));
    const defId = this.hf.getSheetId(data.defaultSheet) ?? 0;
    const resolve = (a1: string): SimpleCellAddress => {
      const r = this.hf.simpleCellAddressFromString(a1, defId);
      if (!r) throw new Error(`Could not resolve cell reference "${a1}".`);
      return r;
    };
    this.inputAddrs = inputCells.map(resolve);
    this.outputAddrs = outputCells.map(resolve);
    this.inputCount = this.inputAddrs.length;
    this.outputCount = this.outputAddrs.length;
  }

  evaluate(inputs: number[]): number[] {
    const { hf, inputAddrs, outputAddrs } = this;
    const out = withContext(this.cb, () => {
      hf.batch(() => {
        for (let i = 0; i < inputAddrs.length; i++) {
          hf.setCellContents(inputAddrs[i], inputs[i]);
        }
      });
      const vals = new Array<number>(outputAddrs.length);
      for (let f = 0; f < outputAddrs.length; f++) {
        const v = hf.getCellValue(outputAddrs[f]);
        vals[f] = typeof v === 'number' ? v : NaN;
      }
      return vals;
    });
    if (this.cb.running) {
      outputAddrs.forEach((a, f) => this.cb.forecastValues.get(cellKey(a))?.push(out[f]));
      this.cb.trialsDone++;
    }
    return out;
  }

  /**
   * Evaluate a formula expression (no leading "=") as if it sat in `sheet`, e.g.
   * a Crystal Ball name like `$I12&" - "&J$11`. Undefined if it doesn't evaluate.
   */
  evaluateExpression(expr: string, sheet: string): string | undefined {
    const id = this.hf.getSheetId(sheet);
    if (id === undefined) return undefined;
    try {
      const v = withContext(this.cb, () => this.hf.calculateFormula(`=${expr}`, id));
      if (v instanceof DetailedCellError || v === null || typeof v === 'object') return undefined;
      return String(v);
    } catch {
      return undefined;
    }
  }

  /** Replace one cell's contents (row and column 1-based); its dependents recalculate. */
  setCell(sheet: string, row: number, col: number, content: RawCell): void {
    const id = this.hf.getSheetId(sheet);
    if (id === undefined) throw new Error(`No sheet "${sheet}".`);
    withContext(this.cb, () => this.hf.setCellContents({ sheet: id, row: row - 1, col: col - 1 }, content));
  }

  /** A cell's current value (row and column 1-based); errors come back as e.g. { error: '#DIV/0!' }. */
  cellValue(sheet: string, row: number, col: number): RawCell | { error: string } {
    const id = this.hf.getSheetId(sheet);
    if (id === undefined) return null;
    const v = this.hf.getCellValue({ sheet: id, row: row - 1, col: col - 1 });
    if (v instanceof DetailedCellError) return { error: v.value };
    return typeof v === 'object' ? null : v;
  }

  /** Whether a formula (with its "=") parses. */
  isValidFormula(formula: string): boolean {
    try {
      return this.hf.validateFormula(formula);
    } catch {
      return false;
    }
  }

  /**
   * Evaluate a formula (with its "=") on a sheet: a value, the values of a
   * range (row by row), or e.g. { error: '#NAME?' }.
   */
  calculate(formula: string, sheet: string): RawCell | { error: string } | (RawCell | { error: string })[] {
    const id = this.hf.getSheetId(sheet);
    if (id === undefined) return { error: '#REF!' };
    const one = (v: unknown): RawCell | { error: string } =>
      v instanceof DetailedCellError ? { error: v.value } : v === undefined || (typeof v === 'object' && v !== null) ? null : (v as RawCell);
    try {
      const v = withContext(this.cb, () => this.hf.calculateFormula(formula, id));
      return Array.isArray(v) ? v.flat().map(one) : one(v);
    } catch {
      return { error: '#VALUE!' };
    }
  }

  /** The underlying engine, for diagnostics tools. */
  get engine(): HyperFormula {
    return this.hf;
  }

  beginRun(run: { trials: number; seed: number | null; sampling: SamplingMethod; lhsSampleSize: number }): void {
    this.cb = {
      ...this.cb,
      running: true,
      trialsDone: 0,
      stream: functionStream(run.seed),
      prefs: {
        trials: run.trials,
        seed: run.seed ?? 0,
        useSeed: run.seed !== null,
        lhs: run.sampling === 'lhs',
        sampleSize: run.lhsSampleSize,
      },
      forecastValues: new Map(this.outputAddrs.map((a) => [cellKey(a), [] as number[]])),
    };
  }

  endRun(): void {
    this.cb.running = false;
  }

  /**
   * Report any forecast cells that don't currently evaluate to a number
   * (e.g. an unsupported function surfaces as #NAME?), so the UI can warn
   * before a run rather than returning all-NaN results.
   */
  diagnostics(outputNames: string[]): string[] {
    const warnings: string[] = [];
    this.outputAddrs.forEach((addr, f) => {
      const v = this.hf.getCellValue(addr);
      if (v instanceof DetailedCellError) {
        warnings.push(`Forecast "${outputNames[f]}" evaluates to ${v.value} (${v.type}).`);
      } else if (typeof v !== 'number') {
        warnings.push(`Forecast "${outputNames[f]}" is not numeric.`);
      }
    });
    return warnings;
  }

  dispose(): void {
    this.hf.destroy();
  }
}
