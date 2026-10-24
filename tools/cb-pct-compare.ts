/**
 * Compare our percentile-parameter fits with Crystal Ball's: for each case of
 * tools/cb-pct-cases.mjs and the oracle's answers (harness/dist eval), solve the
 * parameters from the text and compare the inverse CDF at the case's probabilities.
 *
 *   node tools/cb-pct-cases.mjs > cases.json
 *   dotnet ../harness/dist/bin/Release/net8.0/CbDist.dll eval cases.json | tail -1 > answers.json
 *   npx vite-node tools/cb-pct-compare.ts -- cases.json answers.json
 */

import { readFileSync } from 'node:fs';
import { distributionFromText } from '../src/cbfile/model';
import { createDistribution } from '../src/engine/distributions';

const [casesFile, answersFile] = process.argv.slice(2).filter((a) => a !== '--');
const cases: { text: string; probs: number[] }[] = JSON.parse(readFileSync(casesFile, 'utf8'));
const answers: { text: string; inv?: (number | string)[]; error?: string }[] = JSON.parse(readFileSync(answersFile, 'utf8'));
let exact = 0;
let close = 0;
let bad = 0;
cases.forEach((c, i) => {
  const a = answers[i];
  const warns: string[] = [];
  const d = distributionFromText(c.text, (m) => warns.push(m));
  if (a.error || !a.inv) {
    const ok = !d;
    console.log(`${ok ? 'OK   ' : 'DIFF '} ${c.text.padEnd(44)} CB error: ${a.error}${d ? ' — we solved it' : ` — we: ${warns.join('; ')}`}`);
    ok ? exact++ : bad++;
    return;
  }
  if (!d) {
    console.log(`FAIL  ${c.text.padEnd(44)} ${warns.join('; ')}`);
    bad++;
    return;
  }
  const dist = createDistribution(d.type, d.params);
  let worst = 0;
  let same = true;
  c.probs.forEach((p, j) => {
    const ours = dist.quantile(p);
    const cb = Number(a.inv![j]);
    if (ours !== cb) same = false;
    worst = Math.max(worst, Math.abs(ours - cb) / Math.max(1e-300, Math.abs(cb)));
  });
  if (same) exact++;
  else if (worst < 1e-9) close++;
  else bad++;
  const tag = same ? 'EXACT' : worst < 1e-9 ? 'CLOSE' : 'DIFF ';
  console.log(`${tag} ${c.text.padEnd(44)} max rel ${worst.toExponential(2)}  ${JSON.stringify(d.params)}`);
});
console.log(`\n${exact} exact, ${close} within 1e-9, ${bad} different, of ${cases.length}`);
