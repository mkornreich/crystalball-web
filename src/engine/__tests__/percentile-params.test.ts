import { describe, it, expect } from 'vitest';
import { distributionFromText } from '../../cbfile/model';
import { createDistribution } from '../distributions';
import { solvePercentileParams, PercentileFitError } from '../percentile-params';
import cases from './fixtures/cb-percentiles.json';

/**
 * Crystal Ball's inverse CDF after solving parameters entered as percentiles
 * (tools/cb-pct-refresh.sh): closed forms, golden-section search and the
 * Nelder–Mead fits all follow Crystal Ball step for step, on the C runtime's
 * math (libm.ts), so every value must match bit for bit.
 */
describe('parameters entered as percentiles (Crystal Ball oracle)', () => {
  for (const c of cases as { text: string; probs: number[]; inv?: (number | string)[]; error?: string }[]) {
    it(c.text, () => {
      const d = distributionFromText(c.text);
      if (!c.inv) {
        expect(d).toBeNull();
        return;
      }
      expect(d).not.toBeNull();
      const dist = createDistribution(d!.type, d!.params);
      c.probs.forEach((p, i) => {
        const ours = dist.quantile(p);
        const cb = Number(c.inv![i]);
        expect(ours).toBe(cb);
      });
      // Crystal Ball's fits stop once the targets are met to ~1e-5 (absolute, for the Nelder–Mead ones).
      for (const s of d!.entered ?? [])
        if (s.prob !== undefined)
          expect(Math.abs(dist.quantile(s.prob) - s.value)).toBeLessThan(1e-5 * Math.max(1, Math.abs(s.value)));
    });
  }

  it('keeps the solved parameters and the entered ones', () => {
    const d = distributionFromText('Normal,10%=80,90%=120')!;
    expect(d.type).toBe('normal');
    expect(d.params.mean).toBe(100);
    expect(d.entered).toEqual([
      { key: '10%', value: 80, prob: 0.1 },
      { key: '90%', value: 120, prob: 0.9 },
    ]);
  });

  it('rejects percentiles that do not match the parameters they replace', () => {
    expect(() => solvePercentileParams('normal', [{ value: 80, prob: 0.1 }])).toThrow(PercentileFitError);
    expect(() => solvePercentileParams('poisson', [{ value: 8, prob: 0.9 }])).toThrow(PercentileFitError);
  });
});
