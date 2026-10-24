/** Crystal Ball's forecast-chart binning rules (CBForms ChartScaling). */
import { describe, expect, it } from 'vitest';
import { cbBinCount, cbBins, displayRoundRange } from '../bins';

describe('column count', () => {
  it('follows the chart width and density, always odd', () => {
    expect(cbBinCount(600)).toBe(61); // ⌊6⌋·100/12 = 50, ×1.2 = 60 → 61
    expect(cbBinCount(860)).toBe(79);
    expect(cbBinCount(860, 'low')).toBe(47);
    expect(cbBinCount(50)).toBe(5); // fewer than 100px: 4 columns, made odd
  });
});

describe('display range', () => {
  it('widens to round bounds', () => {
    expect(displayRoundRange(0.3, 9.7)).toEqual([0, 10]);
    const [a, b] = displayRoundRange(-2541.3, 7489.6);
    expect(a).toBeLessThanOrEqual(-2541.3);
    expect(b).toBeGreaterThanOrEqual(7489.6);
    expect(Number.isInteger(a / 500) && Number.isInteger(b / 500)).toBe(true);
  });
  it('clips continuous forecasts to the mean ± 2.8 sd and counts what is shown', () => {
    const xs = Array.from({ length: 1000 }, (_, i) => (i === 0 ? 100 : (i % 100) / 10));
    const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / (xs.length - 1));
    const b = cbBins(xs, { widthPx: 600, mean, stdDev: sd });
    expect(b.total).toBe(1000);
    expect(b.displayed).toBe(999); // the outlier at 100 is off the chart
    expect(b.counts.reduce((s, c) => s + c, 0)).toBe(999);
  });
  it('gives discrete forecasts one column per integer', () => {
    const b = cbBins([1, 2, 2, 3, 3, 3, 4, 5, 5, 6, 6, 6], { widthPx: 600, mean: 3.8, stdDev: 1.6 });
    expect(b.discrete).toBe(true);
    expect(b.counts).toEqual([1, 2, 3, 1, 2, 3]);
  });
});
