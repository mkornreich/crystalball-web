/**
 * Sensitivity analysis — Crystal Ball's "contribution to variance" tornado.
 *
 * For each assumption, take the Spearman rank correlation between its sampled
 * values and the forecast's trial values. Square the correlations and normalize
 * so they sum to 100%; each bar keeps the sign of its correlation to show
 * direction. This is an approximation (exact only for independent assumptions
 * and monotone models), reproduced the same way Crystal Ball reports it.
 */

import { Assumption, SensitivityEntry } from './model';
import { spearman } from './statistics';

export function sensitivity(
  assumptions: Assumption[],
  assumptionColumns: number[][],
  forecastValues: number[],
): SensitivityEntry[] {
  const corrs = assumptionColumns.map((col) => spearman(col, forecastValues));
  const sumSq = corrs.reduce((s, r) => s + r * r, 0);
  const entries: SensitivityEntry[] = assumptions.map((a, j) => {
    const r = corrs[j];
    const share = sumSq > 0 ? (100 * (r * r)) / sumSq : 0;
    return {
      assumptionId: a.id,
      name: a.name,
      rankCorrelation: r,
      contribution: Math.sign(r) * share, // signed % of variance
    };
  });
  entries.sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution));
  return entries;
}
