import { describe, it, expect } from 'vitest';
import * as libm from '../libm';
import fixture from './fixtures/libm-glibc.json';

/**
 * The C runtime's math functions bit for bit: a sample of glibc 2.43's results
 * (x86-64, FMA variants — what .NET's Math calls on Linux) from
 * tools/libm-fixture.py. tools/libm-check.ts runs the full 2-million-case sets.
 */
const buf = new DataView(new ArrayBuffer(8));
const fromBits = (h: string) => {
  buf.setBigUint64(0, BigInt(`0x${h}`));
  return buf.getFloat64(0);
};
const FNS = libm as unknown as Record<string, (...a: number[]) => number>;

describe('libm matches glibc', () => {
  for (const [fn, rows] of Object.entries(fixture as Record<string, string[][]>)) {
    it(`${fn} (${rows.length} cases)`, () => {
      let bad = 0;
      const shown: string[] = [];
      for (const row of rows) {
        const v = row.map(fromBits);
        const want = v[v.length - 1];
        const got = FNS[fn](...v.slice(0, -1));
        if (!Object.is(got, want)) {
          bad++;
          if (shown.length < 3) shown.push(`${fn}(${v.slice(0, -1).join(', ')}) = ${got}, glibc ${want}`);
        }
      }
      expect(bad, shown.join('\n')).toBe(0);
    });
  }

  it('fma rounds once', () => {
    // (1 + 2^-52)(1 - 2^-52) - 1 = -2^-104 exactly; a·b + c separately gives 0.
    expect(libm.fma(1 + 2 ** -52, 1 - 2 ** -52, -1)).toBe(-(2 ** -104));
    expect(libm.fma(0.1, 10, -1)).toBe(5.551115123125783e-17);
  });
});
