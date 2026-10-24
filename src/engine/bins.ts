/**
 * Crystal Ball's forecast-chart binning (CBForms ChartScaling / FrcDataProvider
 * and OCB.Net Frc.CalcBin):
 *
 *  - display range: for a continuous forecast with at least 10 trials, the
 *    mean ± 2.8 standard deviations, clipped to the data; otherwise min…max.
 *    Values beyond it are counted but not drawn ("n Displayed");
 *  - the range is widened to round bounds by Crystal Ball's DisplayRoundRange;
 *  - the column count follows the chart's pixel width and the density setting:
 *    ⌊width/100⌋·100/12 columns × 1.2 for a column chart × density factor,
 *    made odd; a discrete forecast gets one column per integer when they fit.
 */

import * as libm from './libm';

export type ChartDensity = 'lowest' | 'low' | 'medium' | 'high' | 'highest';

const DENSITY: Record<ChartDensity, number> = { lowest: 0.4, low: 0.6, medium: 1, high: 1.5, highest: 2 };
const LN10 = libm.log(10);

/** Crystal Ball's column count for a chart `widthPx` pixels wide. */
export function cbBinCount(widthPx: number, density: ChartDensity = 'medium', columnChart = true): number {
  let factor = (columnChart ? 1.2 : 3.0) * DENSITY[density];
  if (factor <= 0) factor = 1;
  let n = Math.trunc((Math.trunc(widthPx / 100) * 100) / 12);
  if (n === 0) n = 4;
  if (factor !== 1) n = Math.trunc(n * factor);
  if (n % 2 === 0) n++;
  return n;
}

/** Crystal Ball's DisplayRoundRange: widen [min, max] to round bounds (≈12 ticks). */
export function displayRoundRange(min: number, max: number): [number, number] {
  if (min === max) return [min, max];
  if (max !== 0 && Math.abs(max - min) / Math.abs(max) < 1e-16) return [min, min];
  let lo = Math.min(Math.abs(min), Math.abs(max));
  const hiAbs = Math.max(Math.abs(min), Math.abs(max));
  if (lo === 0) lo = hiAbs;
  let shift = 0;
  let scaled = false;
  if (lo !== 0) {
    shift = Math.floor(libm.log(lo) / LN10 - 0.5);
    if (shift < -15 && libm.log(hiAbs) / LN10 < -15) {
      shift = -10 - shift;
      min *= libm.exp(shift * LN10);
      max *= libm.exp(shift * LN10);
      scaled = true;
    }
  }
  const ticks = 12;
  let e = libm.log((max - min + 1e-16) / ticks) / LN10;
  const base = e >= 0 ? Math.floor(e) : Math.floor(e) - 1;
  let k = 0;
  let mag = 1;
  let step = 0;
  let a: number;
  let b: number;
  do {
    k++;
    step = k === 1 ? libm.pow(10, base + mag) / 4 : step * 2;
    if (step === 0) step = 3e-7;
    if (k === 4) {
      k = 0;
      mag += 1;
    }
    e = Math.floor(min / step + 3e-7);
    a = min >= 0 ? e * step : (e - 1) * step;
    e = Math.floor(max / step - 3e-7);
    b = max >= 0 ? e * step + step : (e - 1) * step + step;
  } while ((b - a) / step > ticks);
  if (scaled) {
    const u = libm.exp(-shift * LN10);
    min *= u;
    max *= u;
    a *= u;
    b *= u;
  }
  return [Math.min(min, a), Math.max(max, b)];
}

export interface CbBins {
  /** Display range. */
  min: number;
  max: number;
  width: number;
  /** Trials per column. */
  counts: number[];
  /** Trials inside the display range (Crystal Ball's "Displayed"). */
  displayed: number;
  total: number;
  discrete: boolean;
}

/** Bin a forecast's (kept) values the way Crystal Ball's forecast chart does. */
export function cbBins(values: number[], opts: { widthPx: number; density?: ChartDensity; mean: number; stdDev: number }): CbBins {
  const data = values.filter(Number.isFinite);
  const total = data.length;
  if (!total) return { min: 0, max: 1, width: 1, counts: [], displayed: 0, total, discrete: false };
  let lo = Infinity;
  let hi = -Infinity;
  let integral = true;
  for (const v of data) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    if (integral && v % 1 !== 0) integral = false;
  }
  const discrete = integral && hi - lo <= 10000;
  let dMin = lo;
  let dMax = hi;
  if (lo === hi) {
    const pad = discrete ? 1 : Math.abs(lo) <= 10 ? 1 : 0.05 * Math.abs(lo);
    dMin = lo - pad;
    dMax = lo + pad;
  } else if (total >= 10 && !discrete) {
    dMin = Math.max(lo, opts.mean - 2.8 * opts.stdDev);
    dMax = Math.min(hi, opts.mean + 2.8 * opts.stdDev);
  }
  let n = cbBinCount(opts.widthPx, opts.density);
  let width: number;
  if (discrete) {
    // One column per integer when they fit; otherwise integer-wide groups.
    const k0 = Math.ceil(dMin);
    const k1 = Math.floor(dMax);
    const span = k1 - k0 + 1;
    const step = span > n ? Math.max(1, Math.round((k1 - k0) / n)) : 1;
    n = Math.ceil(span / step);
    width = step;
    dMin = k0 - 0.5 * step;
    dMax = dMin + n * step;
  } else {
    [dMin, dMax] = displayRoundRange(dMin, dMax);
    width = (dMax - dMin) / n;
  }
  const counts = new Array<number>(n).fill(0);
  let displayed = 0;
  for (const v of data) {
    if (v < dMin || v > dMax) continue;
    displayed++;
    counts[Math.min(n - 1, Math.trunc((v - dMin) / width))]++;
  }
  return { min: dMin, max: dMax, width, counts, displayed, total, discrete };
}
