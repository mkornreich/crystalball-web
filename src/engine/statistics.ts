/**
 * Forecast statistics and the shared ranking utilities used by both the
 * sensitivity analysis and the Iman–Conover correlation layer.
 *
 * Conventions follow Oracle Crystal Ball's forecast view:
 *   - standard deviation / variance use the sample (n − 1) denominator;
 *   - skewness is the moment skewness m3 / m2^(3/2);
 *   - kurtosis is reported non-excess (a normal distribution gives 3);
 *   - percentiles use linear interpolation of the empirical CDF, with
 *     position h = (p/100)(n − 1) + 1 (p = 0 → min, p = 100 → max).
 */

import { ForecastStatistics } from './model';

/** Average ranks (1..n), ties sharing their mean rank. */
export function ranks(values: number[]): number[] {
  const n = values.length;
  const order = Array.from({ length: n }, (_, i) => i).sort(
    (a, b) => values[a] - values[b],
  );
  const r = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[order[j + 1]] === values[order[i]]) j++;
    const avg = (i + j) / 2 + 1; // average of ranks i+1 .. j+1
    for (let k = i; k <= j; k++) r[order[k]] = avg;
    i = j + 1;
  }
  return r;
}

/** Pearson correlation of two equal-length vectors. */
export function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n === 0) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  const denom = Math.sqrt(saa * sbb);
  return denom === 0 ? 0 : sab / denom;
}

/** Spearman rank correlation (Pearson on average ranks; tolerant of ties). */
export function spearman(a: number[], b: number[]): number {
  return pearson(ranks(a), ranks(b));
}

/** Linear-interpolated percentile of an already-sorted ascending array. */
export function percentileSorted(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  if (n === 1) return sorted[0];
  const h = (p / 100) * (n - 1);
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/** A list of {p, value} percentiles (default every 10%). */
export function percentiles(
  values: number[],
  ps: number[] = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
): { p: number; value: number }[] {
  const sorted = [...values].sort((x, y) => x - y);
  return ps.map((p) => ({ p, value: percentileSorted(sorted, p) }));
}

/** Approximate the mode of a continuous sample from its densest histogram bin. */
function estimateMode(sorted: number[]): number | null {
  const n = sorted.length;
  const lo = sorted[0];
  const hi = sorted[n - 1];
  if (hi === lo) return lo;
  // Freedman–Diaconis-ish bin count, bounded.
  const bins = Math.min(Math.max(Math.ceil(Math.sqrt(n)), 10), 200);
  const width = (hi - lo) / bins;
  const counts = new Array<number>(bins).fill(0);
  for (const v of sorted) {
    let b = Math.floor((v - lo) / width);
    if (b >= bins) b = bins - 1;
    counts[b]++;
  }
  let best = 0;
  for (let i = 1; i < bins; i++) if (counts[i] > counts[best]) best = i;
  return lo + (best + 0.5) * width;
}

/** Full Crystal Ball-style statistics for a forecast's trial values. */
export function summarize(values: number[]): ForecastStatistics {
  const n = values.length;
  const sorted = [...values].sort((a, b) => a - b);

  let mean = 0;
  for (const v of values) mean += v;
  mean /= n || 1;

  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const v of values) {
    const d = v - mean;
    const d2 = d * d;
    m2 += d2;
    m3 += d2 * d;
    m4 += d2 * d2;
  }
  m2 /= n || 1;
  m3 /= n || 1;
  m4 /= n || 1;

  const variance = n > 1 ? (m2 * n) / (n - 1) : 0; // sample variance
  const stdDev = Math.sqrt(variance);
  const sd2 = Math.sqrt(m2); // population SD for moment ratios
  const skewness = sd2 > 0 ? m3 / (sd2 * sd2 * sd2) : 0;
  const kurtosis = m2 > 0 ? m4 / (m2 * m2) : 0; // non-excess

  const median = percentileSorted(sorted, 50);
  const min = sorted[0];
  const max = sorted[n - 1];

  return {
    trials: n,
    mean,
    median,
    mode: estimateMode(sorted),
    stdDev,
    variance,
    skewness,
    kurtosis,
    coeffOfVariability: mean !== 0 ? stdDev / mean : NaN,
    min,
    max,
    range: max - min,
    meanStdError: n > 0 ? stdDev / Math.sqrt(n) : 0,
  };
}

/**
 * Certainty: the fraction (as a percentage) of trials within [low, high].
 */
export function certainty(values: number[], low: number, high: number): number {
  let count = 0;
  for (const v of values) if (v >= low && v <= high) count++;
  return (100 * count) / (values.length || 1);
}
