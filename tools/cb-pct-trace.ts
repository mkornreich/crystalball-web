/**
 * Trace a Triangular/BetaPERT percentile fit against Crystal Ball step by step:
 * writes the fit's problem (bounds, starts) for harness/dist `pertfit`, which runs
 * Crystal Ball's NLOptimizer on Crystal Ball's own quantiles, then compares the
 * two evaluation logs.
 *
 *   npx vite-node tools/cb-pct-trace.ts -- spec <dist> <min|pct> <likeliest|pct> <max|pct> > spec.json
 *     (a slot is a number, or "p:x" for percentile p (0–1) at value x)
 *   dotnet ../harness/dist/bin/Release/net8.0/CbDist.dll pertfit spec.json | tail -1 > cb.json
 *   npx vite-node tools/cb-pct-trace.ts -- compare spec.json cb.json
 */

import { readFileSync } from 'node:fs';
import { pertLikeProblem } from '../src/engine/percentile-params';
import { nlOptimize } from '../src/engine/cb-nlopt';

const args = process.argv.slice(2).filter((a) => a !== '--');
type Spec = { dist: string; known: boolean[]; v: number[]; probs: number[]; targets: number[]; vars: number[][] };

function build(dist: string, cells: string[]): Spec {
  const known = cells.map((c) => !c.includes(':'));
  const v = cells.map((c) => Number(c.includes(':') ? c.split(':')[1] : c));
  const probs = cells.filter((c) => c.includes(':')).map((c) => Number(c.split(':')[0]));
  const targets = cells.filter((c) => c.includes(':')).map((c) => Number(c.split(':')[1]));
  const type = dist.toLowerCase() === 'betapert' ? 'betapert' : 'triangular';
  const pr = pertLikeProblem(type, probs, targets, known, v)!;
  return { dist, known, v, probs, targets, vars: pr.vars.map((x) => [x.min, x.max, x.value]) };
}

if (args[0] === 'spec') console.log(JSON.stringify([build(args[1], args.slice(2))]));
else {
  const spec: Spec = JSON.parse(readFileSync(args[1], 'utf8'))[0];
  const cb = JSON.parse(readFileSync(args[2], 'utf8'));
  const type = spec.dist.toLowerCase() === 'betapert' ? 'betapert' : 'triangular';
  const pr = pertLikeProblem(type, spec.probs, spec.targets, spec.known, spec.v)!;
  const log: number[][] = [];
  const obj = { expected: 0, value: (x: number[]) => { const r = pr.objective.value(x); log.push([...x, r]); return r; } };
  try {
    nlOptimize(pr.vars, obj, pr.constraint);
  } catch (e) {
    console.log('ours threw', (e as Error).message);
  }
  const num = (x: number | string) => Number(x);
  let shown = 0;
  for (let i = 0; i < Math.max(log.length, cb.evals.length) && shown < 6; i++) {
    const a = cb.evals[i]?.map(num);
    const b = log[i];
    if (!a || !b || a.some((x: number, j: number) => x !== b[j])) {
      const pointSame = a && b && a.slice(0, -1).every((x: number, j: number) => x === b[j]);
      console.log(`#${i} ${pointSame ? 'same point, value differs' : 'POINT DIFFERS'}: CB ${JSON.stringify(a)} ours ${JSON.stringify(b)}`);
      shown++;
      if (!pointSame) break;
    }
  }
  console.log(`evals CB ${cb.evals.length} ours ${log.length}; final CB ${cb.final} ours ${pr.vars.map((x) => x.value)}; CB error ${cb.error}`);
}
