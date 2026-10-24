/**
 * Legacy Excel worksheet functions whose argument lists HyperFormula doesn't
 * accept in their pre-2010 form (workbooks of Crystal Ball's era use them).
 * workbook-data.ts renames calls to these stand-ins.
 */

import { FunctionArgumentType, FunctionPlugin, HyperFormula } from 'hyperformula';
import { betaI, normCdf } from '../engine/special';

const NUM = { argumentType: FunctionArgumentType.NUMBER };
const OPT_NUM = (v: number) => ({ argumentType: FunctionArgumentType.NUMBER, defaultValue: v });

class ExcelCompatPlugin extends FunctionPlugin {
  // NORMSDIST(z): the cumulative standard normal.
  normsdist(ast: { args: unknown[] }, state: unknown) {
    return this.runFunction(ast.args as never, state as never, this.metadata('XLCOMPAT.NORMSDIST'), (z: number) => normCdf(z));
  }
  // LOGNORMDIST(x, mean, sd): the cumulative lognormal.
  lognormdist(ast: { args: unknown[] }, state: unknown) {
    return this.runFunction(ast.args as never, state as never, this.metadata('XLCOMPAT.LOGNORMDIST'), (x: number, m: number, s: number) =>
      x > 0 && s > 0 ? normCdf((Math.log(x) - m) / s) : NaN,
    );
  }
  // BETADIST(x, alpha, beta, [A], [B]): the cumulative beta on [A, B].
  betadist(ast: { args: unknown[] }, state: unknown) {
    return this.runFunction(
      ast.args as never,
      state as never,
      this.metadata('XLCOMPAT.BETADIST'),
      (x: number, a: number, b: number, lo: number, hi: number) => (hi > lo ? betaI((x - lo) / (hi - lo), a, b) : NaN),
    );
  }
}
(ExcelCompatPlugin as unknown as { implementedFunctions: unknown }).implementedFunctions = {
  'XLCOMPAT.NORMSDIST': { method: 'normsdist', parameters: [NUM] },
  'XLCOMPAT.LOGNORMDIST': { method: 'lognormdist', parameters: [NUM, NUM, NUM] },
  'XLCOMPAT.BETADIST': { method: 'betadist', parameters: [NUM, NUM, NUM, OPT_NUM(0), OPT_NUM(1)] },
};

let registered = false;
export function registerExcelCompatFunctions(): void {
  if (registered) return;
  const names = { 'XLCOMPAT.NORMSDIST': 'XLCOMPAT.NORMSDIST', 'XLCOMPAT.LOGNORMDIST': 'XLCOMPAT.LOGNORMDIST', 'XLCOMPAT.BETADIST': 'XLCOMPAT.BETADIST' };
  HyperFormula.registerFunctionPlugin(ExcelCompatPlugin as never, { enGB: names, enUS: names });
  registered = true;
}
