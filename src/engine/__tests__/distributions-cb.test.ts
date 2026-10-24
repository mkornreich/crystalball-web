/**
 * Our distributions against Crystal Ball's own math. The fixture holds inverse
 * CDF and CDF values computed by the real Crystal Ball 11.1.3 engine
 * (OCB.Net.dll, Dst.CalcInvCDF / CutInvCDF / CalcCDF) for a grid of
 * probabilities plus the uniforms its generator actually emits for seeds 999
 * and 12345 — regenerate with tools/cb-dist-cases.mjs.
 */
import { describe, expect, it } from 'vitest';
import fixture from './fixtures/cb-distributions.json';
import { createDistribution, truncate, CustomPoint, DistributionType } from '../distributions';

interface Row {
  type: DistributionType;
  params: Record<string, number>;
  custom?: CustomPoint[];
  truncMin?: number;
  truncMax?: number;
  cbText: string;
  error?: string;
  probs: number[];
  quantiles?: number[];
  xs: number[];
  cdf?: number[];
}

const TOL = Number(process.env.CB_TOL ?? 0);

/** Every value must equal Crystal Ball's bit for bit (CB_TOL loosens it for diagnosis). */
function tolFor(_r: Row, _p: number): number {
  return TOL;
}
const rows = (fixture as unknown as Row[]).filter((r) => !r.error);

function relErr(a: number, b: number): number {
  if (a === b) return 0;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.abs(a - b) / Math.max(1, Math.abs(b));
}

const label = (r: Row) => `${r.cbText}${r.custom ? ` ${JSON.stringify(r.custom)}` : ''}${r.truncMin !== undefined ? ` cut[${r.truncMin},${r.truncMax}]` : ''}`;

describe('inverse CDF equals Crystal Ball', () => {
  it.each(rows.map((r) => [label(r), r] as const))('%s', (_, r) => {
    const d = truncate(createDistribution(r.type, r.params, r.custom), r.truncMin, r.truncMax);
    const bad: string[] = [];
    r.probs.forEach((p, i) => {
      const ours = d.quantile(p);
      const cb = r.quantiles![i];
      if (relErr(ours, cb) > tolFor(r, p)) bad.push(`p=${p}: ours=${ours} cb=${cb}`);
    });
    expect(bad.length, `${bad.length} mismatches\n${bad.slice(0, 6).join("\n")}`).toBe(0);
  });
});

describe('CDF equals Crystal Ball', () => {
  it.each(rows.filter((r) => r.truncMin === undefined).map((r) => [label(r), r] as const))('%s', (_, r) => {
    const d = createDistribution(r.type, r.params, r.custom);
    const bad: string[] = [];
    r.xs.forEach((x, i) => {
      const ours = d.cdf(x);
      const cb = r.cdf![i];
      if (Math.abs(ours - cb) > TOL) bad.push(`x=${x}: ours=${ours} cb=${cb}`);
    });
    expect(bad.length, `${bad.length} mismatches\n${bad.slice(0, 6).join("\n")}`).toBe(0);
  });
});
