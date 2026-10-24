/**
 * Forecast statistics and the shared ranking utilities, computed the way
 * Crystal Ball 11.1.3 computes them for its forecast window (OCB.Net Frc /
 * Helpers Ranker), including its summation order:
 *
 *   - mean = (Σ x in trial order) · (1/n);
 *   - variance = corrected two-pass over the sorted values, n − 1 denominator
 *     (clamped to 0 below 2.5e-31); mean std. error = s·√(1/n);
 *   - skewness = (1/n)·Σ((x − mean)/s)³ and kurtosis = (1/n)·Σ((x − mean)/s)⁴
 *     with the *sample* s — kurtosis is non-excess (normal ≈ 3);
 *   - median = middle value (mean of the two middle values for even n);
 *   - mode = the most frequent value (first on ties); undefined when no value
 *     repeats, as for continuous forecasts — Crystal Ball shows "---";
 *   - percentile p: sorted value x[k] sits at cumulative probability (k+1)/n,
 *     ties take the last of their run, and values in between are linearly
 *     interpolated (so the 50th percentile of 1..5 is 2.5, not the median 3);
 *   - certainty of [low, high] = P(X ≤ high) − P(X < low) on the same
 *     interpolated empirical CDF.
 */

import { roundDotNet } from './cbmath';
import { ForecastStatistics } from './model';

/** Crystal Ball's `LimitPrecision(x, 15)`: round to 15 decimals unless x < 0.01. */
function limitPrecision15(x: number): number {
  return x < 0.01 ? x : roundDotNet(x, 15);
}

/** Average ranks (1..n), ties sharing their mean rank. */
export function ranks(values: number[]): number[] {
  const n = values.length;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => values[a] - values[b]);
  const r = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[order[j + 1]] === values[order[i]]) j++;
    const avg = (j - i) / 2 + (i + 1); // Crystal Ball: (run − 1)/2 + first rank
    for (let k = i; k <= j; k++) r[order[k]] = avg;
    i = j + 1;
  }
  return r;
}

/**
 * Pearson correlation by Crystal Ball's one-pass sums. Fewer than three pairs
 * is undefined (NaN); two constant series correlate perfectly (1).
 */
export function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n !== b.length || n < 3) return NaN;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    sa += x;
    sb += y;
    saa += x * x;
    sbb += y * y;
    sab += x * y;
  }
  const ma = sa / n;
  const mb = sb / n;
  saa -= ma * ma * n;
  sbb -= mb * mb * n;
  sab -= ma * mb * n;
  if (saa <= 0) return sbb <= 0 ? 1 : NaN;
  if (sbb <= 0) return NaN;
  return sab / Math.sqrt(saa * sbb);
}

/** Spearman rank correlation (Pearson on average ranks), as Crystal Ball's sensitivity uses. */
export function spearman(a: number[], b: number[]): number {
  return pearson(ranks(a), ranks(b));
}

/**
 * Value at percentile `p` (0–100) of an ascending array, by Crystal Ball's
 * empirical-CDF rule.
 */
export function percentileSorted(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const prob = Math.max(0, Math.min(1, p / 100));
  let k = Math.trunc(n * prob - 1);
  if (k < 0) k = 0;
  const v0 = sorted[k];
  while (k + 1 < n && sorted[k + 1] === v0) k++;
  const q0 = (k + 1) / n;
  let v: number;
  if (prob <= q0) v = sorted[k];
  else {
    const q1 = (k + 2) / n;
    v = ((prob - q0) / (q1 - q0)) * (sorted[k + 1] - v0) + v0;
  }
  return limitPrecision15(v);
}

/** A list of {p, value} percentiles (default every 10%, Crystal Ball's Percentiles view). */
export function percentiles(
  values: number[],
  ps: number[] = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
): { p: number; value: number }[] {
  const sorted = [...values].sort((x, y) => x - y);
  return ps.map((p) => ({ p, value: percentileSorted(sorted, p) }));
}

/**
 * Fraction (0–1) of the forecast at or below `val` (`inclusive`) or strictly
 * below it — Crystal Ball's CalcPercentile on an ascending array.
 */
export function fractionBelow(sorted: number[], val: number, inclusive: boolean): number {
  const n = sorted.length;
  if (n <= 0) return 0;
  let f: number;
  if (sorted[n - 1] < val) f = 1;
  else if (val < sorted[0]) f = 0;
  else {
    // Index of a value ≤ val (an exact hit stops the search early).
    let k = 0;
    let exact = false;
    if (n < 10) {
      for (let i = 0; i < n && !exact; i++) {
        if (sorted[i] <= val) {
          exact = sorted[i] === val;
          k = i;
        }
      }
    } else {
      let lo = 0;
      let hi = n - 1;
      while (!exact && hi - lo > 1) {
        const mid = Math.trunc((hi + lo) / 2);
        if (sorted[mid] <= val) {
          exact = sorted[mid] === val;
          lo = mid;
        } else hi = mid;
      }
      k = lo;
    }
    if (exact) {
      const v = sorted[k];
      if (inclusive) {
        while (k + 1 < n && sorted[k + 1] === v) k++;
        f = (k + 1) / n;
      } else {
        while (k - 1 >= 0 && sorted[k - 1] === v) k--;
        f = k / n;
      }
    } else {
      const q0 = (k + 1) / n;
      const q1 = (k + 2) / n;
      f = ((val - sorted[k]) / (sorted[k + 1] - sorted[k])) * (q1 - q0) + q0;
    }
  }
  return Math.max(0, Math.min(1, limitPrecision15(f)));
}

/** The most frequent value of an ascending array, by Crystal Ball's run scan. */
function cbMode(sorted: number[]): number | null {
  const n = sorted.length;
  if (n < 5) return null;
  let mode = 0;
  let prev = 0;
  let best = 0;
  let run = 0;
  for (let i = 0; i < n; i++) {
    const v = sorted[i];
    run++;
    if (v === prev && i !== n - 1) continue;
    if (run > best) {
      mode = prev;
      best = run;
    }
    run = 0;
    prev = v;
  }
  return best > 1 ? mode : null;
}

/** Full Crystal Ball statistics for a forecast's (kept) trial values, in trial order. */
export function summarize(values: number[]): ForecastStatistics {
  const n = values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const inv = 1 / (n || 1);

  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum * inv;

  let dev = 0;
  let m2 = 0;
  for (const x of sorted) {
    const d = x - mean;
    dev += d;
    m2 += d * d;
  }
  let variance = n > 1 ? (m2 - dev * dev * inv) / (n - 1) : 0;
  if (!(variance >= 2.5e-31)) variance = 0;
  const stdDev = Math.sqrt(variance);

  let skewness = 0;
  let kurtosis = 0;
  if (variance !== 0 && n > 3) {
    let s3 = 0;
    let s4 = 0;
    for (const x of sorted) {
      const z = (x - mean) / stdDev;
      const z3 = z * z * z;
      s3 += z3;
      s4 += z3 * z;
    }
    skewness = s3 * inv;
    kurtosis = s4 * inv;
  }

  const median = n === 0 ? NaN : n % 2 ? sorted[(n - 1) / 2] : 0.5 * (sorted[n / 2 - 1] + sorted[n / 2]);
  const min = sorted[0];
  const max = sorted[n - 1];

  return {
    trials: n,
    mean,
    median,
    mode: cbMode(sorted),
    stdDev,
    variance,
    skewness,
    kurtosis,
    coeffOfVariability: mean !== 0 ? stdDev / mean : NaN,
    min,
    max,
    range: max - min,
    meanStdError: stdDev * Math.sqrt(inv),
  };
}

/**
 * Certainty (as a percentage) that the forecast lies in [low, high], by
 * Crystal Ball's interpolated empirical CDF. low > high gives the two tails.
 */
export function certainty(values: number[], low: number, high: number): number {
  const sorted = [...values].sort((x, y) => x - y);
  let f: number;
  if (low > high) f = 1 - fractionBelow(sorted, low, false) + fractionBelow(sorted, high, true);
  else f = fractionBelow(sorted, high, true) - fractionBelow(sorted, low, false);
  return 100 * Math.max(0, Math.min(1, limitPrecision15(f)));
}
