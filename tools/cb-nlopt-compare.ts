/**
 * Compare the optimizer port (src/engine/cb-nlopt.ts) with Crystal Ball's own
 * NLOptimizer on the harness's test problems (harness/dist `random` and `nlopt`
 * modes): .NET Random sequences, then every objective evaluation in order.
 *
 *   dotnet ../harness/dist/bin/Release/net8.0/CbDist.dll random > random.jsonl
 *   dotnet ../harness/dist/bin/Release/net8.0/CbDist.dll nlopt > nlopt.jsonl
 *   npx vite-node tools/cb-nlopt-compare.ts -- random.jsonl nlopt.jsonl
 */

import { readFileSync } from 'node:fs';
import { NetRandom, NLOVar, nlOptimize } from '../src/engine/cb-nlopt';
import { NL_PROBLEMS as PROBLEMS } from '../src/engine/__tests__/nlopt-problems';

const [randomFile, nloptFile] = process.argv.slice(2).filter((a) => a !== '--');
const lines = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
const num = (v: number | string) => (typeof v === 'number' ? v : Number(v));

for (const r of lines(randomFile)) {
  const a = new NetRandom(r.seed);
  const ok = r.doubles.every((d: number) => a.nextDouble() === d);
  const b = new NetRandom(r.seed);
  const ok2 = r.next30000.every((d: number) => b.next(30000) === d);
  console.log(`random seed ${r.seed}: ${ok && ok2 ? 'EXACT' : 'DIFF'}`);
}

for (const o of lines(nloptFile)) {
  const p = PROBLEMS[o.name];
  const vars = p.vars.map(([lo, hi, s]) => new NLOVar(lo, hi, s));
  const log: number[][] = [];
  let err: string | null = null;
  let res;
  try {
    res = nlOptimize(vars, { value: (x) => { const v = p.f(x); log.push([...x, v]); return v; }, expected: p.ev }, p.cons);
  } catch (e) {
    err = (e as Error).constructor.name;
  }
  const cb: number[][] = o.evals.map((r: (number | string)[]) => r.map(num));
  let firstDiff = -1;
  for (let i = 0; i < Math.max(cb.length, log.length); i++) {
    const a = cb[i];
    const b = log[i];
    if (!a || !b || a.some((x, j) => !Object.is(x, b[j]))) {
      firstDiff = i;
      break;
    }
  }
  const finalSame = o.final.every((v: number | string, i: number) => Object.is(num(v), vars[i].value));
  console.log(
    `${o.name.padEnd(9)} evals CB ${cb.length} ours ${log.length}; ${firstDiff < 0 ? 'ALL EQUAL' : `first diff at #${firstDiff}: CB ${JSON.stringify(cb[firstDiff])} ours ${JSON.stringify(log[firstDiff])}`}; final ${finalSame ? 'same' : `CB ${o.final} ours ${vars.map((v) => v.value)}`}; err CB ${o.error} ours ${err}; opt CB ${o.atOptimum} ours ${res?.atOptimum}`,
  );
}
