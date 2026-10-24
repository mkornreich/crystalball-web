/**
 * Assumption-value generation, the way Crystal Ball 11.1.3 does it.
 *
 *  - Assumptions are ordered as Crystal Ball creates them — worksheet tab
 *    order, then row, then column — and grouped by worksheet.
 *  - Each worksheet group draws from its own copy of Crystal Ball's generator,
 *    seeded with the group seed (run seed + 3 + g + 10000·g for the g-th
 *    sheet). Every trial, each group hands its members one uniform apiece, in
 *    order.
 *  - Latin Hypercube keeps a fixed stratum permutation per assumption, built
 *    from its own generator seeded with group seed + index in group, plus ten
 *    block offsets; a trial's uniform is placed inside the chosen stratum by
 *    the fractional part of u·(n+1).
 *  - Correlated assumptions then pass their uniforms through the copula in
 *    correlation.ts, and every probability goes through the assumption's
 *    Crystal Ball inverse CDF (with its cuts).
 */

import { buildCorrelationGroups, CorrelationGroup, CorrelationPair, correlateTrial } from './correlation';
import { toInt } from './cbmath';
import { Distribution } from './distributions';
import { SamplingMethod } from './model';
import { CB_MODULUS, CrystalBallRng, Rng } from './rng';

/** Crystal Ball's `RandNum.NextUIntVal(min, max)`: truncates min + (max − min)·u. */
function nextIntIn(rng: Rng, min: number, max: number): number {
  return toInt(min + (max - min) * rng.next());
}

/**
 * Crystal Ball's Latin Hypercube generator for one assumption: a permutation
 * of the n strata (random start, linear probing to the next free slot) and ten
 * block offsets drawn from the same stream restarted.
 */
export class CbLatinHypercube {
  private perm: Int32Array;
  private offsets: number[] = [];
  constructor(seed: number, private n: number) {
    if (!(n > 0)) this.n = n = 500;
    const rng = new CrystalBallRng(seed > 0 ? seed : Date.now() % CB_MODULUS);
    const taken = new Uint8Array(n);
    this.perm = new Int32Array(n);
    for (let filled = 0; filled < n; ) {
      let j = nextIntIn(rng, 0, n - 1);
      while (taken[j]) j = (j + 1) % n;
      taken[j] = 1;
      this.perm[filled++] = j;
    }
    rng.reseed(seed > 0 ? seed : 1);
    for (let i = 0; i < 10; i++) this.offsets.push(nextIntIn(rng, 0, n - 1));
  }
  /** Stratify uniform `u` for 1-based global trial number `trial`. */
  apply(u: number, trial: number): number {
    const n = this.n;
    const block = Math.floor((trial - 1) / n) % this.offsets.length;
    const k = (this.offsets[block] + ((trial - 1) % n)) % n;
    const x = u * (n + 1);
    return (x - toInt(x) + this.perm[k]) / n;
  }
}

/** Where an assumption lives, for Crystal Ball's creation order. */
export interface AssumptionPlacement {
  sheet: string;
  /** 1-based row and column. */
  row: number;
  col: number;
}

/** Parse "Sheet!B12" / "'My Sheet'!$B$12" / "B12" into a placement. */
export function placementOf(cell: string, defaultSheet = ''): AssumptionPlacement {
  const bang = cell.lastIndexOf('!');
  const sheet = bang >= 0 ? cell.slice(0, bang).replace(/^'(.*)'$/, '$1').replace(/''/g, "'") : defaultSheet;
  const m = /^\$?([A-Za-z]+)\$?(\d+)/.exec(cell.slice(bang + 1));
  if (!m) return { sheet, row: 0, col: 0 };
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { sheet, row: Number(m[2]), col };
}

/**
 * Indices of `placements` in Crystal Ball's creation order: worksheet tab
 * order (sheets not in `sheetOrder` keep their first-seen order, after the
 * listed ones), then row, then column.
 */
export function cbCreationOrder(placements: AssumptionPlacement[], sheetOrder: string[] = []): number[] {
  const rank = new Map(sheetOrder.map((s, i) => [s, i]));
  for (const p of placements) if (!rank.has(p.sheet)) rank.set(p.sheet, rank.size);
  return placements
    .map((p, i) => i)
    .sort(
      (i, j) =>
        (rank.get(placements[i].sheet) as number) - (rank.get(placements[j].sheet) as number) ||
        placements[i].row - placements[j].row ||
        placements[i].col - placements[j].col ||
        i - j,
    );
}

export interface SampleRequest {
  dists: Distribution[];
  placements: AssumptionPlacement[];
  /** Assumption ids, parallel to dists (used to resolve correlations). */
  ids: string[];
  trials: number;
  method: SamplingMethod;
  lhsSampleSize: number;
  /** The run seed (Crystal Ball's "use same sequence" value); 0 = random. */
  seed: number;
  sheetOrder?: string[];
  correlations?: CorrelationPair[];
  /** Crystal Ball's "assume zero for unspecified coefficients" run option. */
  assumeZero?: boolean;
}

export interface SampleResult {
  /** One column per assumption (in the request's order), one value per trial. */
  columns: number[][];
  /** The probabilities each value was drawn at (after LHS and correlation). */
  probabilities: number[][];
  correlationGroups: CorrelationGroup[];
  /** Per worksheet group, in Crystal Ball order: its seed and member indices. */
  groups: { sheet: string; seed: number; members: number[] }[];
}

/** The seed of the g-th assumption worksheet (0-based), as a uint32. */
export function groupSeed(runSeed: number, g: number): number {
  return (runSeed + 3 + g + 10000 * g) >>> 0;
}

/** Generate every assumption's trial values exactly as Crystal Ball would. */
export function generateSamples(req: SampleRequest): SampleResult {
  const { dists, placements, ids, trials: n } = req;
  const k = dists.length;
  const order = cbCreationOrder(placements, req.sheetOrder);
  const randomRun = !(req.seed > 0);

  // Worksheet groups in creation order.
  const groups: { sheet: string; seed: number; members: number[] }[] = [];
  for (const i of order) {
    const sheet = placements[i].sheet;
    let g = groups.find((x) => x.sheet === sheet);
    if (!g) {
      const seed = randomRun
        ? 1 + Math.floor(Math.random() * (CB_MODULUS - 2))
        : groupSeed(req.seed, groups.length);
      g = { sheet, seed, members: [] };
      groups.push(g);
    }
    g.members.push(i);
  }
  const streams = groups.map((g) => new CrystalBallRng(g.seed));
  const lhs: (CbLatinHypercube | null)[] = new Array(k).fill(null);
  if (req.method === 'lhs') {
    for (const g of groups) {
      g.members.forEach((i, varIndex) => {
        let s = toInt(g.seed) + varIndex;
        s = toInt(s);
        if (s < 0) s = -s;
        lhs[i] = new CbLatinHypercube(s, req.lhsSampleSize);
      });
    }
  }

  const corrGroups = req.correlations?.length
    ? buildCorrelationGroups(req.correlations, { assumeZero: req.assumeZero })
    : [];
  const idIndex = new Map(ids.map((id, i) => [id, i]));
  const corrMembers = corrGroups.map((cg) => cg.members.map((id) => idIndex.get(id)));

  const columns = Array.from({ length: k }, () => new Array<number>(n));
  const probabilities = Array.from({ length: k }, () => new Array<number>(n));
  const u = new Array<number>(k);
  for (let t = 0; t < n; t++) {
    groups.forEach((g, gi) => {
      for (const i of g.members) {
        let x = streams[gi].next();
        const l = lhs[i];
        if (l) x = l.apply(x, t + 1);
        u[i] = x;
      }
    });
    const p = u.slice();
    corrGroups.forEach((cg, ci) => {
      const members = corrMembers[ci];
      if (members.some((i) => i === undefined)) return;
      const out = new Array<number>(members.length);
      correlateTrial(cg, members.map((i) => u[i as number]), out);
      members.forEach((i, j) => (p[i as number] = out[j]));
    });
    for (let i = 0; i < k; i++) {
      probabilities[i][t] = p[i];
      columns[i][t] = dists[i].quantile(p[i]);
    }
  }
  return { columns, probabilities, correlationGroups: corrGroups, groups };
}
