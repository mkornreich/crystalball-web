/**
 * Sensitivity analysis — Crystal Ball's "contribution to variance" tornado.
 *
 * For each assumption, take the Spearman rank correlation between its sampled
 * values and the forecast's trial values (trials whose forecast value is an
 * error are left out of both series, and ties share average ranks). Square
 * the correlations and normalize them — c²·(1/Σc²), keeping each sign — so
 * they sum to 100%; an undefined correlation is left out of the sum. This is
 * Crystal Ball's own (approximate) measure: exact only for independent
 * assumptions and monotone models, reproduced the same way it reports it.
 */

import { Assumption, SensitivityEntry } from './model';
import { spearman } from './statistics';

export function sensitivity(
  assumptions: Assumption[],
  assumptionColumns: number[][],
  forecastValues: number[],
): SensitivityEntry[] {
  const keep: number[] = [];
  forecastValues.forEach((v, t) => {
    if (Number.isFinite(v)) keep.push(t);
  });
  const fc = keep.map((t) => forecastValues[t]);
  const corrs = assumptionColumns.map((col) => spearman(keep.map((t) => col[t]), fc));
  let sumSq = 0;
  for (const r of corrs) if (Number.isFinite(r)) sumSq += r * r;
  const scale = 1 / sumSq;
  const entries: SensitivityEntry[] = assumptions.map((a, j) => {
    const r = corrs[j];
    const share = Number.isFinite(r) && sumSq > 0 ? r * r * scale : 0;
    return {
      assumptionId: a.id,
      name: a.name,
      rankCorrelation: r,
      contribution: 100 * (r < 0 ? -share : share), // signed % of variance
    };
  });
  entries.sort((x, y) => Math.abs(y.contribution) - Math.abs(x.contribution));
  return entries;
}
