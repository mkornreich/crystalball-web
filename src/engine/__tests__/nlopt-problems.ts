/** The harness's NLOptimizer test problems (harness/dist `nlopt`), shared by the tests and tools/cb-nlopt-compare.ts. */
import * as libm from '../libm';

export interface NlProblem {
  vars: number[][]; // [min, max, start]
  f: (x: number[]) => number;
  cons: ((x: number[]) => boolean) | null;
  ev: number;
}

export const NL_PROBLEMS: Record<string, NlProblem> = {
  '1d-exp': { vars: [[5e-6, 10, 1.3]], f: (x) => Math.abs(libm.exp(x[0]) - 2.5), cons: null, ev: 0 },
  '2d-free': { vars: [[-10, 10, 0.5], [-10, 10, 0.5]], f: (x) => Math.abs(x[0] * x[0] + x[1] - 3) + Math.abs(x[0] - x[1] * x[1] + 1), cons: null, ev: 0 },
  '2d-cons': { vars: [[-5, 5, -4], [-5, 5, 4]], f: (x) => Math.abs(x[0] - 1) + 2 * Math.abs(x[1] - 1.5), cons: (x) => x[0] < x[1], ev: 0 },
  '2d-nan': {
    vars: [[0.3, 1000, 100], [0.3, 1000, 100]],
    f: (x) => Math.abs(libm.log(x[0]) - 1.1) + Math.abs(Math.sqrt(x[1]) - 2.2),
    cons: (x) => x[0] + x[1] < 1000,
    ev: 0,
  },
  '2d-nofit': { vars: [[-5, 5, 3], [-5, 5, -3]], f: (x) => Math.abs(x[0] - 1) + Math.abs(x[1] + 2) + 0.01, cons: (x) => x[0] > x[1], ev: 0 },
  '2d-noev': { vars: [[-10, 10, 2], [-10, 10, 2]], f: (x) => (x[0] - 1.25) * (x[0] - 1.25) + 3 * (x[1] + 0.5) * (x[1] + 0.5), cons: null, ev: NaN },
  '3d-cons': {
    vars: [[-20, 2, 2], [9, 30, 9], [-20, 30, 2]],
    f: (x) => Math.abs(x[0] + 0.3 * (x[2] - x[0]) - 2) + Math.abs(x[1] - 0.2 * (x[1] - x[2]) - 9) + 0.5 * Math.abs(x[2] - 5),
    cons: (x) => !(x[0] >= x[1]) && !(x[0] > x[2]) && !(x[2] > x[1]),
    ev: 0,
  },
};
