// Builds the distribution test cases that tools/cb-oracle (the real Crystal Ball
// OCB.Net.dll, run under .NET on Linux) evaluates, and merges its answers into the
// fixture the vitest suite compares our distributions against.
//
//   node tools/cb-dist-cases.mjs cases  > cases.json      (what to evaluate)
//   <oracle> eval cases.json            > answers.json    (Crystal Ball's numbers)
//   node tools/cb-dist-cases.mjs merge cases.json answers.json > src/engine/__tests__/fixtures/cb-distributions.json

import { readFileSync } from 'node:fs';

const M = 2147483647;

/** First n uniforms of Crystal Ball's generator for a seed — the probabilities real runs feed. */
function cbUniforms(seed, n) {
  let r = BigInt(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    r = (62089911n * r) % BigInt(M);
    out.push(Number(r) / M);
  }
  return out;
}

const GRID = [
  1 / M, 1e-9, 1e-7, 1e-5, 1e-4, 0.001, 0.01, 0.025, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4,
  0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.975, 0.99, 0.999, 0.9999,
  1 - 1e-5, 1 - 1e-7, 1 - 1e-9, (M - 1) / M,
];
const PROBS = [...GRID, ...cbUniforms(999, 60), ...cbUniforms(12345, 40)];

const fmt = (v) => String(v);
const text = (name, kv) => [name, ...Object.entries(kv).map(([k, v]) => `${k}=${fmt(v)}`)].join(',');

// [our type, our params, CB text name, CB params (in CB's own parameter names)]
const CASES = [];
const add = (type, params, cbName, cbParams, extra = {}) =>
  CASES.push({ type, params, text: text(cbName, cbParams), ...extra });

for (const [mean, stdev] of [[0, 1], [15000, 1000], [-3.5, 0.02], [1e6, 2.5e5]])
  add('normal', { mean, stdev }, 'Normal', { Mean: mean, StdDev: stdev });
for (const [min, likely, max] of [[0, 5, 10], [10, 10, 20], [-4, 7, 7], [1.5, 1.6, 9]])
  add('triangular', { min, likely, max }, 'Triangular', { Min: min, Likeliest: likely, Max: max });
for (const [min, likely, max] of [[0, 5, 10], [10, 12, 30], [100, 100.5, 101], [-5, -4.9, 20]])
  add('betapert', { min, likely, max }, 'BetaPERT', { Min: min, Likeliest: likely, Max: max });
for (const [min, max] of [[0, 1], [-10, 10], [25, 37.5]])
  add('uniform', { min, max }, 'Uniform', { Min: min, Max: max });
for (const [mean, stdev, location] of [[10, 2, 0], [1, 0.1, 0], [400, 300, 50], [2, 5, -1]])
  add('lognormal', { mean, stdev, location }, 'LogNormal', { Mean: mean, StdDev: stdev, Location: location });
for (const rate of [5, 0.25, 1, 120])
  add('exponential', { rate }, 'Exponential', { Rate: rate });
for (const [location, scale, shape] of [[0, 1, 2], [1, 3, 0.5], [10, 2.5, 7.5], [0, 1, 1]])
  add('gamma', { location, scale, shape }, 'Gamma', { Location: location, Scale: scale, Shape: shape });
for (const [location, scale, shape] of [[0, 1, 2], [1, 3, 0.7], [5, 10, 3.6], [0, 1, 1]])
  add('weibull', { location, scale, shape }, 'Weibull', { Location: location, Scale: scale, Shape: shape });
for (const [min, max, alpha, beta] of [[0, 1, 2, 3], [0, 100, 0.5, 0.5], [-1, 1, 5, 1.2], [10, 20, 1, 1]])
  add('beta', { min, max, alpha, beta }, 'Beta', { Min: min, Max: max, Alpha: alpha, Beta: beta });
for (const [mean, scale] of [[0, 1], [5, 3], [-200, 0.5]])
  add('logistic', { mean, scale }, 'Logistic', { Mean: mean, Scale: scale });
for (const [location, shape] of [[1, 2], [10, 0.7], [3.5, 12]])
  add('pareto', { location, shape }, 'Pareto', { Location: location, Shape: shape });
for (const [midpoint, scale, dof] of [[0, 1, 5], [10, 2, 1], [-3, 0.5, 2], [0, 1, 30], [7, 3, 3.5]])
  add('studentt', { midpoint, scale, dof }, 'Student', { Midpoint: midpoint, Scale: scale, Degrees: dof });
for (const [likeliest, scale] of [[0, 1], [5, 3], [-20, 0.25]]) {
  add('maxextreme', { likeliest, scale }, 'MaxExtreme', { Likeliest: likeliest, Scale: scale });
  add('minextreme', { likeliest, scale }, 'MinExtreme', { Likeliest: likeliest, Scale: scale });
}
for (const p of [0.5, 0.25, 0.9, 0.001])
  add('yesno', { probability: p }, 'DYesNo', { Prob: p });
for (const [min, max] of [[0, 10], [30, 40], [-5, 5], [7, 7]])
  add('discreteuniform', { min, max }, 'DUniform', { Min: min, Max: max });
for (const [n, p] of [[5, 0.5], [10, 0.1], [100, 0.37], [1, 0.8]])
  add('binomial', { trials: n, probability: p }, 'DBinomial', { Trials: n, Prob: p });
for (const rate of [5, 0.3, 42, 1])
  add('poisson', { rate }, 'DPoisson', { Rate: rate });
for (const p of [0.5, 0.1, 0.9, 0.01])
  add('geometric', { probability: p }, 'DGeometric', { Prob: p });
for (const [success, n, population] of [[3, 5, 10], [20, 10, 100], [1, 1, 2], [40, 25, 60]])
  add('hypergeometric', { successes: success, sample: n, population }, 'DHypergeo', { Success: success, Trials: n, Popultn: population });
for (const [p, shape] of [[0.5, 5], [0.2, 1], [0.75, 12], [0.05, 3]])
  add('negbinomial', { probability: p, shape }, 'DNegBinomial', { Prob: p, Shape: shape });

// Lognormal in Crystal Ball's log-space and geometric parameter sets.
for (const [logMean, logStdev, location] of [[1, 0.5, 0], [2.3, 0.2, 10], [-1, 1.5, 0]])
  add('lognormal', { logMean, logStdev, location }, 'LogNormal', { LogMean: logMean, LogStdDev: logStdev, Location: location });
for (const [geoMean, geoStdev, location] of [[10, 1.5, 0], [3, 2.5, 1]])
  add('lognormal', { geoMean, geoStdev, location }, 'LogNormal', { GeoMean: geoMean, GeoStdDev: geoStdev, Location: location });

// Custom tables: [cb rows], [our outcomes]. Rows are [kind, …] as harness/dist expects.
const custom = (rows, points) => CASES.push({ type: 'custom', params: {}, custom: points, cbCustom: rows, text: 'Custom' });
custom([[1, 5, 0.2], [1, 1, 0.5], [1, 3, 0.3]], [{ value: 5, weight: 0.2 }, { value: 1, weight: 0.5 }, { value: 3, weight: 0.3 }]);
custom([[3, 0, 0.05, 0.75], [3, -0.15, -0.05, 0.25]], [{ min: 0, max: 0.05, weight: 0.75 }, { min: -0.15, max: -0.05, weight: 0.25 }]);
custom([[2, 10, 20, 0.6, 2], [1, 30, 0.4]], [{ min: 10, max: 20, step: 2, weight: 0.6 }, { value: 30, weight: 0.4 }]);
custom([[4, 0, 10, 0.1, 0.3]], [{ min: 0, max: 10, weight: 0.1, endWeight: 0.3 }]);
custom([[4, 5, 15, 0.4, 0.05], [3, 20, 30, 0.5]], [{ min: 5, max: 15, weight: 0.4, endWeight: 0.05 }, { min: 20, max: 30, weight: 0.5 }]);
custom([[5, 0, 10, 0.02, 0.2, 1]], [{ min: 0, max: 10, step: 1, weight: 0.02, endWeight: 0.2 }]);
custom([[5, 100, 200, 0.5, 0.1, 25], [1, 50, 0.3]], [{ min: 100, max: 200, step: 25, weight: 0.5, endWeight: 0.1 }, { value: 50, weight: 0.3 }]);

// Truncated variants (Crystal Ball's LoCut/HiCut), evaluated through CutInvCDF.
const cut = (i, lo, hi) => CASES.push({ ...CASES[i], cuts: [lo, hi], truncMin: lo, truncMax: hi });
const at = (type, k = 0) => CASES.findIndex((c, i) => c.type === type && CASES.slice(0, i).filter((d) => d.type === type).length === k);
cut(at('normal', 1), 14000, 1e300);
cut(at('normal', 0), -1, 2);
cut(at('lognormal', 0), 8, 12);
cut(at('triangular', 0), 2, 9);
cut(at('gamma', 1), -1e300, 4);
cut(at('poisson', 0), 2, 8);
cut(at('binomial', 2), 30, 45);

function casesCmd() {
  // Discrete distributions get their exact CDF steps as extra probabilities: the
  // tie rule (P(X<=k) == p) is where inverse transforms most often disagree.
  return CASES.map((c) => ({
    text: c.text,
    cuts: c.cuts ?? null,
    custom: c.cbCustom ?? null,
    probs: PROBS,
    xs: [-1e6, -10, -1, 0, 0.5, 1, 2, 3, 5, 7.5, 10, 12, 15, 20, 30, 35, 40, 100, 1000, 15000, 1e6],
  }));
}

function mergeCmd(casesPath, answersPath) {
  const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
  const answers = JSON.parse(readFileSync(answersPath, 'utf8'));
  const num = (v) => (typeof v === 'string' ? Number(v.replace('∞', 'Infinity')) : v);
  return CASES.map((c, i) => ({
    type: c.type,
    params: c.params,
    custom: c.custom,
    truncMin: c.truncMin,
    truncMax: c.truncMax,
    cbText: c.text,
    cbParsed: answers[i].parsed,
    error: answers[i].error,
    probs: cases[i].probs,
    quantiles: answers[i].inv?.map(num),
    xs: cases[i].xs,
    cdf: answers[i].cdf?.map(num),
  }));
}

const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'cases') process.stdout.write(JSON.stringify(casesCmd()));
else if (cmd === 'merge') process.stdout.write(JSON.stringify(mergeCmd(a, b)));
else {
  console.error('usage: cases | merge <cases.json> <answers.json>');
  process.exit(1);
}
