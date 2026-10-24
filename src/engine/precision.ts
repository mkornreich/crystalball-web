/**
 * Crystal Ball's precision control (OCB.Net OcbPrecision / PrecisionStat):
 * stop a run once every requested forecast statistic is known to the required
 * precision at the chosen confidence level. The confidence half-width of a
 * statistic is z·SE with z = Φ⁻¹((1 + confidence)/2) and
 *
 *   mean:          s/√n
 *   std. dev.:     s·√((kurtosis − 1)/(4(n − 1)))
 *   median, pth percentile: a Maritz–Jarrett estimate — order statistics around
 *                  index round((n−1)p) weighted by binomial probabilities, out to
 *                  where a weight first drops below 5% of the central one.
 *
 * A requirement passes when the half-width is ≤ the required value (absolute)
 * or ≤ that percentage of the statistic (relative); a relative half-width over
 * 500% drops the requirement from the check ("eliminated"). The run stops at a
 * check (every `checkEvery` trials, from trial 20) once at least one requirement
 * has passed and none has failed or can't be judged (OcbPrecision.CheckPrecisionMet).
 */

import { gammln, inverseNormal, roundDotNet } from './cbmath';
import { percentileSorted, summarize } from './statistics';
import * as libm from './libm';

export type PrecisionStatistic = 'mean' | 'stddev' | 'median' | 'percentile';

export interface PrecisionRequirement {
  stat: PrecisionStatistic;
  /** For 'percentile': the percentile, 0–100. */
  percentile?: number;
  /** True: `value` is in the forecast's units; false: a percentage of the statistic. */
  absolute: boolean;
  value: number;
}

export interface PrecisionSettings {
  enabled: boolean;
  /** Check every this many trials (Crystal Ball default 50). */
  checkEvery: number;
  /** Confidence level, e.g. 0.95 (Crystal Ball default). */
  confidence: number;
}

export const DEFAULT_PRECISION: PrecisionSettings = { enabled: false, checkEvery: 50, confidence: 0.95 };

export type PrecisionState = 'passed' | 'failed' | 'not-valid' | 'eliminated';

export interface PrecisionCheck {
  requirement: PrecisionRequirement;
  state: PrecisionState;
  /** The statistic's current value and its confidence half-width. */
  value: number;
  halfWidth: number;
}

/** Binomial(N, (j+1)/N) probability of k+1 — the weight Crystal Ball gives order statistic j. */
function weight(j: number, center: number, n: number): number {
  const k = center + 1;
  const m = j + 1;
  if (m === 0) return k === 0 ? 1 : 0;
  if (m === n) return k === n ? 1 : 0;
  const p = m / n;
  return libm.exp(gammln(n + 1) - gammln(n + 1 - k) - gammln(k + 1) + libm.log(p) * k + libm.log(1 - p) * (n - k));
}

/** Standard error of the p-quantile (0–1) of ascending data; −1 when there's too little data. */
export function percentileStdErr(sorted: number[], p: number): number {
  const n = sorted.length;
  const c = roundDotNet((n - 1) * p, 0) + 1;
  if (n - c < 3 || c < 3) return -1;
  const center = c - 1;
  const w0 = weight(center, center, n);
  const floor = w0 * 0.05;
  let sw = w0;
  let m1 = w0 * sorted[center];
  let m2 = w0 * sorted[center] * sorted[center];
  let w = 1;
  for (let i = center - 1; i >= 0 && !(w < floor); i--) {
    w = weight(i, center, n);
    sw += w;
    m1 += w * sorted[i];
    m2 += w * sorted[i] * sorted[i];
  }
  w = 1;
  for (let i = center + 1; i < n && !(w < floor); i++) {
    w = weight(i, center, n);
    sw += w;
    m1 += w * sorted[i];
    m2 += w * sorted[i] * sorted[i];
  }
  m1 /= sw;
  m2 -= m1 * m1 * sw;
  return m2 > 0 ? Math.sqrt(m2) : 0;
}

/** Judge each requirement against a forecast's kept values (PrecisionStat.CheckPrecision). */
export function checkPrecision(values: number[], reqs: PrecisionRequirement[], confidence: number): PrecisionCheck[] {
  const kept = values.filter(Number.isFinite);
  const z = inverseNormal((1 + confidence) / 2);
  const sorted = [...kept].sort((a, b) => a - b);
  const stats = kept.length ? summarize(kept) : null;
  return reqs.map((requirement): PrecisionCheck => {
    if (!stats || kept.length < 20) return { requirement, state: 'failed', value: NaN, halfWidth: NaN };
    let value: number;
    let se: number;
    switch (requirement.stat) {
      case 'mean':
        value = stats.mean;
        se = stats.stdDev / Math.sqrt(kept.length);
        break;
      case 'stddev':
        value = stats.stdDev;
        se = stats.kurtosis > 1 && kept.length > 1 ? stats.stdDev * Math.sqrt((stats.kurtosis - 1) / (4 * (kept.length - 1))) : -1;
        break;
      case 'median':
        value = percentileSorted(sorted, 50);
        se = percentileStdErr(sorted, 0.5);
        break;
      default: {
        const p = (requirement.percentile ?? 50) / 100;
        value = percentileSorted(sorted, p * 100);
        se = percentileStdErr(sorted, p);
      }
    }
    if (!Number.isFinite(se) || se <= -1) return { requirement, state: 'not-valid', value, halfWidth: NaN };
    if (se <= 0) return { requirement, state: 'passed', value, halfWidth: 0 };
    const halfWidth = z * se;
    if (requirement.absolute) return { requirement, state: halfWidth <= requirement.value ? 'passed' : 'failed', value, halfWidth };
    if (value === 0) return { requirement, state: 'not-valid', value, halfWidth };
    const rel = halfWidth / Math.abs(value);
    const state = rel > 5 ? 'eliminated' : rel <= requirement.value / 100 ? 'passed' : 'failed';
    return { requirement, state, value, halfWidth };
  });
}

/** Crystal Ball's stop rule: some requirement passed and none failed or was invalid. */
export function precisionMet(checks: PrecisionCheck[]): boolean {
  let met = false;
  for (const c of checks) {
    if (c.state === 'failed' || c.state === 'not-valid') return false;
    if (c.state === 'passed') met = true;
  }
  return met;
}
