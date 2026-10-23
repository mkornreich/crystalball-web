/**
 * Native model evaluator that recalculates the real workbook through Office.js.
 *
 * Each trial writes the assumption values into their cells, forces a full
 * recalculation, and reads the forecast cells back — so every Excel formula
 * behaves exactly as it does in the app, including functions HyperFormula does
 * not implement. The cost is one host round trip per trial, which is why this
 * is the "authentic but slower" half of the hybrid engine; keep trial counts
 * modest when using it.
 *
 * Office.js is loaded globally by the add-in, so `Excel` is ambient here.
 */

import { ModelEvaluator } from '../engine/model';

declare const Excel: any;

interface CellRef {
  sheet: string; // '' means the active sheet
  addr: string; // local A1, e.g. "B4"
}

function splitRef(ref: string, defaultSheet: string): CellRef {
  const bang = ref.lastIndexOf('!');
  if (bang < 0) return { sheet: defaultSheet, addr: ref };
  let sheet = ref.slice(0, bang);
  if (sheet.startsWith("'") && sheet.endsWith("'")) {
    sheet = sheet.slice(1, -1).replace(/''/g, "'");
  }
  return { sheet, addr: ref.slice(bang + 1) };
}

export class ExcelEvaluator implements ModelEvaluator {
  private inputRefs: CellRef[];
  private outputRefs: CellRef[];
  readonly inputCount: number;
  readonly outputCount: number;

  constructor(inputCells: string[], outputCells: string[], defaultSheet = '') {
    this.inputRefs = inputCells.map((c) => splitRef(c, defaultSheet));
    this.outputRefs = outputCells.map((c) => splitRef(c, defaultSheet));
    this.inputCount = this.inputRefs.length;
    this.outputCount = this.outputRefs.length;
  }

  async evaluate(inputs: number[]): Promise<number[]> {
    const outputs = new Array<number>(this.outputRefs.length);
    await Excel.run(async (ctx: any) => {
      const sheets = ctx.workbook.worksheets;
      const ws = (name: string) =>
        name ? sheets.getItem(name) : sheets.getActiveWorksheet();

      for (let i = 0; i < this.inputRefs.length; i++) {
        const { sheet, addr } = this.inputRefs[i];
        ws(sheet).getRange(addr).values = [[inputs[i]]];
      }

      // Force a full recalculation so dependents update before we read.
      ctx.workbook.application.calculate(Excel.CalculationType.Full);

      const ranges = this.outputRefs.map(({ sheet, addr }) => {
        const r = ws(sheet).getRange(addr);
        r.load('values');
        return r;
      });
      await ctx.sync();

      ranges.forEach((r, f) => {
        const v = r.values?.[0]?.[0];
        outputs[f] = typeof v === 'number' ? v : NaN;
      });
    });
    return outputs;
  }

  dispose(): void {
    /* nothing to release */
  }
}
