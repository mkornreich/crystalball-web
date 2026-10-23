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
import { ModelEvaluator } from '../engine/model';

/** Raw worksheet contents: numbers/strings/booleans, or '=...' formula strings. */
export type RawCell = string | number | boolean | null;

export interface WorkbookData {
  /** Sheet name -> rectangular 2D array of cell contents (row-major). */
  sheets: Record<string, RawCell[][]>;
  /** Sheet used to resolve A1 references that carry no "Sheet!" prefix. */
  defaultSheet: string;
}

const HF_CONFIG = {
  licenseKey: 'gpl-v3',
  smartRounding: true,
  useArrayArithmetic: true,
  evaluateNullToZero: true,
};

export class HyperFormulaEvaluator implements ModelEvaluator {
  private hf: HyperFormula;
  private inputAddrs: SimpleCellAddress[];
  private outputAddrs: SimpleCellAddress[];
  readonly inputCount: number;
  readonly outputCount: number;

  constructor(data: WorkbookData, inputCells: string[], outputCells: string[]) {
    this.hf = HyperFormula.buildFromSheets(data.sheets, HF_CONFIG);
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
    hf.batch(() => {
      for (let i = 0; i < inputAddrs.length; i++) {
        hf.setCellContents(inputAddrs[i], inputs[i]);
      }
    });
    const out = new Array<number>(outputAddrs.length);
    for (let f = 0; f < outputAddrs.length; f++) {
      const v = hf.getCellValue(outputAddrs[f]);
      out[f] = typeof v === 'number' ? v : NaN;
    }
    return out;
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
