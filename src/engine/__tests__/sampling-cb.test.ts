/**
 * Assumption generation against Crystal Ball. The fixture (built by
 * harness/sampling from the real OCB.Net.dll's ungated primitives composed in
 * the order the licence-gated trial loop uses them) holds per-trial
 * probabilities and values for Monte Carlo and Latin Hypercube runs, several
 * worksheets, truncation and correlation groups.
 */
import { describe, expect, it } from 'vitest';
import fixture from './fixtures/cb-sampling.json';
import { createDistribution, DistributionType, truncate } from '../distributions';
import { cbEigen } from '../correlation';
import { generateSamples, placementOf } from '../sampling';

interface Scenario {
  name: string;
  seed: number;
  method: 'mc' | 'lhs';
  sampleSize: number;
  trials: number;
  sheetOrder: string[];
  assumeZero: boolean;
  assumptions: { id: string; sheet: string; cell: string; type: string; params: Record<string, number>; truncMin: number | null; truncMax: number | null }[];
  correlations: { a: string; b: string; coefficient: number }[] | null;
  cbOrder: string[];
  groups: { sheet: string; groupSeed: number; members: string[] }[];
  corrMatrices: { members: string[]; spearman: number[][]; eigenvalues: number[] }[];
  probs: Record<string, number[]>;
  values: Record<string, number[]>;
}

const scenarios = (fixture as unknown as { scenarios: Scenario[] }).scenarios;
const eigenCases = (fixture as unknown as { eigen: { matrix: number[][]; eigenvalues: number[]; eigenvectors: number[][] }[] }).eigen;

function run(sc: Scenario) {
  return generateSamples({
    dists: sc.assumptions.map((a) =>
      truncate(createDistribution(a.type as DistributionType, a.params), a.truncMin ?? undefined, a.truncMax ?? undefined),
    ),
    placements: sc.assumptions.map((a) => placementOf(`${a.sheet}!${a.cell}`)),
    ids: sc.assumptions.map((a) => a.id),
    trials: sc.trials,
    method: sc.method,
    lhsSampleSize: sc.sampleSize,
    seed: sc.seed,
    sheetOrder: sc.sheetOrder,
    correlations: sc.correlations ?? undefined,
    assumeZero: sc.assumeZero,
  });
}

const rel = (a: number, b: number) =>
  a === b ? 0 : Number.isFinite(a) && Number.isFinite(b) ? Math.abs(a - b) / Math.max(1, Math.abs(b)) : Infinity;

describe('generation order and seeds equal Crystal Ball', () => {
  it.each(scenarios.map((s) => [s.name, s] as const))('%s', (_, sc) => {
    const out = run(sc);
    const ids = sc.assumptions.map((a) => a.id);
    expect(out.groups.map((g) => g.seed)).toEqual(sc.groups.map((g) => g.groupSeed));
    expect(out.groups.flatMap((g) => g.members.map((i) => ids[i]))).toEqual(sc.cbOrder);
  });
});

describe('correlation matrices equal Crystal Ball', () => {
  it.each(scenarios.filter((s) => s.corrMatrices.length).map((s) => [s.name, s] as const))('%s', (_, sc) => {
    const out = run(sc);
    expect(out.correlationGroups.map((g) => g.members)).toEqual(sc.corrMatrices.map((m) => m.members));
    out.correlationGroups.forEach((g, gi) => {
      const want = sc.corrMatrices[gi];
      g.spearman.forEach((row, i) => row.forEach((v, j) => expect(rel(v, want.spearman[i][j]), `S[${i}][${j}]`).toBe(0)));
      g.eigenvalues.forEach((v, i) => expect(rel(v, want.eigenvalues[i]), `λ${i}`).toBe(0));
    });
  });
});

describe('per-trial probabilities and values equal Crystal Ball', () => {
  it.each(scenarios.map((s) => [s.name, s] as const))('%s', (_, sc) => {
    const out = run(sc);
    const bad: string[] = [];
    sc.assumptions.forEach((a, i) => {
      for (let t = 0; t < sc.trials; t++) {
        const p = out.probabilities[i][t];
        const v = out.columns[i][t];
        if (rel(p, sc.probs[a.id][t]) > 0) bad.push(`${a.id} t${t} p ours=${p} cb=${sc.probs[a.id][t]}`);
        else if (rel(v, sc.values[a.id][t]) > 0) bad.push(`${a.id} t${t} v ours=${v} cb=${sc.values[a.id][t]}`);
      }
    });
    expect(bad.length, `${bad.length} mismatches\n${bad.slice(0, 8).join('\n')}`).toBe(0);
  });
});

describe('eigen decomposition equals Crystal Ball', () => {
  it.each(eigenCases.map((c, i) => [i, c] as const))('case %i', (_, c) => {
    const { values, vectors } = cbEigen(c.matrix);
    values.forEach((v, i) => expect(rel(v, c.eigenvalues[i])).toBe(0));
    vectors.forEach((row, i) => row.forEach((v, j) => expect(Math.abs(v - c.eigenvectors[i][j])).toBe(0)));
  });
});
