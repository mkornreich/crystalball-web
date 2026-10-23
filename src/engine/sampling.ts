/**
 * Sample-matrix generation. Produces one column of `n` sampled values per
 * assumption, by inverse transform through each distribution's quantile.
 *
 *  - Monte Carlo: each value uses an independent Uniform(0,1) draw.
 *  - Latin Hypercube: the probability axis (0,1) is split into equal-probability
 *    bands; one value is drawn at a random point inside each band, and the bands
 *    are assigned to trials by an independent random permutation per assumption
 *    (this is what removes the artificial lockstep between assumptions). When the
 *    trial count exceeds the LHS sample size, sampling runs in independent blocks
 *    of that size, exactly as Crystal Ball does.
 *
 * Every random number comes from the Crystal Ball generator in rng.ts, so a
 * fixed seed reproduces the whole matrix.
 */

import { Distribution } from './distributions';
import { SamplingMethod } from './model';
import { Rng } from './rng';

/** In-place Fisher–Yates shuffle using the seeded generator. */
function shuffle<T>(arr: T[], rng: Rng): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
}

function sampleMonteCarloColumn(dist: Distribution, n: number, rng: Rng): number[] {
  const col = new Array<number>(n);
  for (let i = 0; i < n; i++) col[i] = dist.quantile(rng.next());
  return col;
}

function sampleLhsColumn(
  dist: Distribution,
  n: number,
  blockSize: number,
  rng: Rng,
): number[] {
  const col: number[] = [];
  let remaining = n;
  while (remaining > 0) {
    const block = Math.min(blockSize, remaining);
    const us = new Array<number>(block);
    for (let i = 0; i < block; i++) us[i] = (i + rng.next()) / block;
    shuffle(us, rng);
    for (let i = 0; i < block; i++) col.push(dist.quantile(us[i]));
    remaining -= block;
  }
  return col;
}

/**
 * Generate the `k × n` sample matrix (returned as `k` columns of length `n`),
 * one column per distribution, before any correlation is imposed.
 */
export function generateSamples(
  dists: Distribution[],
  n: number,
  method: SamplingMethod,
  lhsSampleSize: number,
  rng: Rng,
): number[][] {
  return dists.map((d) =>
    method === 'lhs'
      ? sampleLhsColumn(d, n, Math.max(2, lhsSampleSize), rng)
      : sampleMonteCarloColumn(d, n, rng),
  );
}
