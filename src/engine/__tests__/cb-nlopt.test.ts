import { describe, it, expect } from 'vitest';
import { NetRandom, NLOVar, nextCombination, nlOptimize, qsort, sortIndex } from '../cb-nlopt';
import { NL_PROBLEMS } from './nlopt-problems';
import fixture from './fixtures/cb-nlopt.json';

/** Crystal Ball's own NLOptimizer and .NET Random, recorded by tools/cb-nlopt-refresh.sh. */
const num = (v: number | string) => (typeof v === 'number' ? v : Number(v));

describe('Crystal Ball optimizer port', () => {
  it('reproduces .NET System.Random(seed)', () => {
    for (const r of fixture.random) {
      const a = new NetRandom(r.seed);
      for (const d of r.doubles) expect(a.nextDouble()).toBe(d);
      const b = new NetRandom(r.seed);
      for (const k of r.next30000) expect(b.next(30000)).toBe(k);
    }
  });

  it('sorts like QSort', () => {
    const a = [3, 1, 2, 1, 5, 0];
    const idx = a.map((_, i) => i);
    sortIndex(a, idx);
    expect(idx.map((i) => a[i])).toEqual([0, 1, 1, 2, 3, 5]);
    qsort(a);
    expect(a).toEqual([0, 1, 1, 2, 3, 5]);
  });

  it('steps through combinations as Crystal Ball does', () => {
    // Combinatorics.NextCombination only ever moves the leftmost 1, so for k = 3
    // it reaches 21 of the 56 masks before the first k slots fill up.
    for (const k of [2, 3]) {
      let c: number[] = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => (i < 8 - k ? 0 : 1));
      const seen = new Set([c.join('')]);
      for (;;) {
        try {
          c = nextCombination(c, k);
        } catch {
          break;
        }
        expect(c.filter((x) => x === 1).length).toBe(k);
        seen.add(c.join(''));
      }
      expect(seen.size).toBe(k === 2 ? 28 : 21);
    }
  });

  for (const o of fixture.problems) {
    it(`walks the same simplex as Crystal Ball: ${o.name}`, () => {
      const p = NL_PROBLEMS[o.name];
      const vars = p.vars.map(([lo, hi, s]) => new NLOVar(lo, hi, s));
      const log: number[][] = [];
      let err: string | null = null;
      try {
        nlOptimize(vars, { value: (x) => { const v = p.f(x); log.push([...x, v]); return v; }, expected: p.ev }, p.cons);
      } catch (e) {
        err = (e as Error).constructor.name;
      }
      expect(err).toBe(o.error);
      expect(log.length).toBe(o.evalCount);
      o.evals.forEach((row, i) => {
        const cb = (row as (number | string)[]).map(num);
        cb.forEach((x, j) => expect(log[i][j]).toBe(x));
      });
      o.final.forEach((x, i) => expect(vars[i].value).toBe(num(x)));
    });
  }
});
