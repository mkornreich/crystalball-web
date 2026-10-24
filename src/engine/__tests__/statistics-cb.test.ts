/**
 * Crystal Ball's forecast statistics semantics (OCB.Net Frc / Helpers Ranker),
 * pinned on small hand-checkable samples.
 */
import { describe, expect, it } from 'vitest';
import { certainty, fractionBelow, pearson, percentileSorted, ranks, spearman, summarize } from '../statistics';
import { sensitivity } from '../sensitivity';

describe('summary statistics', () => {
  const xs = [4, 1, 3, 2, 5, 2];
  const s = summarize(xs);
  it('uses the sample variance and the classic median', () => {
    expect(s.mean).toBeCloseTo(17 / 6, 14);
    const m = 17 / 6;
    const ss = xs.reduce((a, x) => a + (x - m) ** 2, 0);
    expect(s.variance).toBeCloseTo(ss / 5, 14);
    expect(s.median).toBe(2.5); // mean of the two middle values
    expect(s.meanStdError).toBeCloseTo(Math.sqrt(ss / 5) / Math.sqrt(6), 14);
  });
  it('normalizes skewness and kurtosis by the sample std. dev. over n', () => {
    const m = 17 / 6;
    const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / 5);
    const z = xs.map((x) => (x - m) / sd);
    expect(s.skewness).toBeCloseTo(z.reduce((a, v) => a + v ** 3, 0) / 6, 13);
    expect(s.kurtosis).toBeCloseTo(z.reduce((a, v) => a + v ** 4, 0) / 6, 13);
  });
  it('reports the most frequent value as the mode', () => {
    expect(s.mode).toBe(2);
    expect(summarize([1, 2, 3, 4, 5, 6]).mode).toBeNull(); // nothing repeats: "---"
    expect(summarize([1, 1, 2, 2, 3]).mode).toBe(1); // first of the tied runs
    expect(summarize([1, 2, 3]).mode).toBeNull(); // fewer than 5 trials
  });
  it('keeps Crystal Ball\'s undercount of a run that ends the data', () => {
    // 5 appears twice but its run reaches the end, so Crystal Ball counts it once.
    expect(summarize([1, 2, 3, 4, 5, 5]).mode).toBeNull();
    expect(summarize([1, 2, 3, 5, 5, 6]).mode).toBe(5);
  });
});

describe('percentiles and certainty', () => {
  const sorted = [10, 20, 20, 30, 40];
  it('skips ties to the end of their run', () => {
    // 20 covers cumulative probability 0.2 → 0.6.
    expect(percentileSorted(sorted, 40)).toBe(20);
    expect(percentileSorted(sorted, 60)).toBe(20);
    // Crystal Ball's LimitPrecision(·, 15) can't round this one either: 24.999999999999996.
    expect(percentileSorted(sorted, 70)).toBeCloseTo(25, 13);
  });
  it('splits exact hits into "below" and "at or below"', () => {
    expect(fractionBelow(sorted, 20, false)).toBeCloseTo(0.2, 15);
    expect(fractionBelow(sorted, 20, true)).toBeCloseTo(0.6, 15);
    expect(fractionBelow(sorted, 35, true)).toBeCloseTo(0.9, 15); // interpolated
    expect(fractionBelow(sorted, 5, true)).toBe(0);
    expect(fractionBelow(sorted, 50, true)).toBe(1);
  });
  it('certainty interpolates between trial values', () => {
    expect(certainty(sorted, 20, 30)).toBeCloseTo(60, 12); // 0.8 − 0.2
    expect(certainty(sorted, 25, Infinity)).toBeCloseTo(30, 12); // 1 − 0.7
    // low > high: both tails, P(X ≤ 20) + P(X ≥ 30) — every value here.
    expect(certainty(sorted, 30, 20)).toBeCloseTo(100, 12);
  });
  it('uses the binary search above ten trials', () => {
    const big = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(fractionBelow(big, 10, true)).toBeCloseTo(0.5, 15);
    expect(fractionBelow(big, 10.5, true)).toBeCloseTo(0.525, 15);
  });
});

describe('rank correlation', () => {
  it('averages tied ranks', () => {
    expect(ranks([3, 1, 3, 2])).toEqual([3.5, 1, 3.5, 2]);
  });
  it('follows Crystal Ball\'s edge rules', () => {
    expect(pearson([1, 2], [3, 4])).toBeNaN(); // fewer than three pairs
    expect(pearson([1, 1, 1], [2, 2, 2])).toBe(1); // both constant
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNaN();
    expect(spearman([1, 2, 3, 4], [10, 40, 90, 160])).toBeCloseTo(1, 14);
  });
  it('drops error trials and normalizes c² with signs', () => {
    const a = [1, 2, 3, 4, 5, 6];
    const b = [6, 5, 4, 3, 2, 1];
    const f = [1, 2, NaN, 4, 5, 6];
    const s = sensitivity(
      [
        { id: 'a', cell: 'S!A1', name: 'A', type: 'normal', params: {} },
        { id: 'b', cell: 'S!A2', name: 'B', type: 'normal', params: {} },
      ],
      [a, b],
      f,
    );
    expect(s.map((e) => Math.round(e.contribution))).toEqual([50, -50]);
  });
});
