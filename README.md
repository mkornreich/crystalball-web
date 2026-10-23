# Crystal Ball Web

A clean-room TypeScript reimplementation of **Oracle Crystal Ball**'s core Monte
Carlo simulation, packaged as an **Excel task-pane add-in that runs in Excel on
the web** (Office.js). You attach probability distributions to input cells
("assumptions"), mark output cells ("forecasts"), run a Monte Carlo simulation,
and get Crystal Ball-style forecast statistics, a histogram with a certainty
band, percentiles, and a sensitivity tornado.

This is an independent reimplementation of the Monte Carlo *technique* and the
assumptions/forecasts paradigm from public mathematical definitions. It contains
no Oracle code.

## Validated against the real Crystal Ball

The engine is checked against two of Oracle Crystal Ball's own shipped example
models, reproducing Crystal Ball's **published** forecast numbers (same RNG, same
distributions, same run settings — 1000/5000 trials, seed 999):

| Model | Crystal Ball published | This engine |
|---|---|---|
| **Futura Apartments** — P(Profit ≥ $0) | **90.09 %** | **89.5 %** (mean $2,510) |
| **Vision Research** — P(Net Profit ≥ $0) | **~79 %** | **79.3 %** |
| **Vision Research** — P(Net Profit ≥ $2M) | **~72 %** | **73.1 %** |

See `src/evaluators/__tests__/validation-*.test.ts`. The exact model formulas and
assumption definitions were taken from the shipped example workbooks and the
Getting Started tutorials.

### Crystal Ball's exact random number generator

Crystal Ball documents its generator as the multiplicative congruential generator
`r ← (62089911 · r) mod (2³¹ − 1)` (period 2³¹−2), with uniforms `r / (2³¹−1)`.
`src/engine/rng.ts` implements exactly this, and a test verifies it against a
BigInt reference over 100,000 iterations. Because `62089911 · r` overflows 2⁵³,
the modular product is evaluated exactly via 15-bit splitting.

## Features

- **22 assumption distributions** (Normal, Triangular, BetaPERT, Uniform,
  Lognormal, Exponential, Gamma, Weibull, Beta, Logistic, Pareto, Student's t,
  Max/Min Extreme, Yes-No, Discrete Uniform, Binomial, Poisson, Geometric,
  Hypergeometric, Negative Binomial, Custom) — each with an exact inverse CDF, so
  sampling is inverse-transform (works for both Monte Carlo and Latin Hypercube).
  Custom supports discrete points **and** continuous ranges; any continuous
  distribution can be **truncated**.
- **Monte Carlo and Latin Hypercube** sampling.
- **Correlated assumptions** via the Iman–Conover rank-correlation method.
- **Forecast statistics** (mean, median, mode, std dev, variance, skewness,
  non-excess kurtosis, CoV, range, mean std error), **percentiles**, and a
  **certainty band**.
- **Sensitivity** as contribution-to-variance (rank-correlation tornado).
- **Hybrid engine**: an in-browser HyperFormula engine (fast — thousands of
  trials in well under a second) by default, or **native Excel recalculation**
  through Office.js for full-fidelity formula support.
- Reproducible runs via a fixed seed; model is saved in the document.

## Project layout

```
src/engine/        pure Monte Carlo engine (no Office dependency, fully unit-tested)
  rng.ts           Crystal Ball's exact generator
  special.ts       erf, Φ⁻¹, incomplete gamma/beta + inverses
  distributions.ts the 22 distributions + truncation
  sampling.ts      Monte Carlo / Latin Hypercube
  correlation.ts   Iman–Conover
  statistics.ts    forecast stats, percentiles, ranking
  sensitivity.ts   contribution to variance
  simulation.ts    the runner
src/evaluators/    HyperFormula (in-browser) and native Excel model evaluators
src/excel/         Office.js bridge (read workbook, selection, settings, cell tint)
src/ui/            task-pane UI + canvas charts
examples/          clean example workbooks (Futura, Vision Research)
manifest.xml       Excel add-in manifest (XML)
```

## Build & run

Requires Node 18+ (developed on Node 22).

```bash
npm install
npm test            # 89 tests: engine math, RNG, and the Crystal Ball validations
npm run typecheck
npm run build       # production bundle into dist/
```

### Sideload in Excel on the web

1. `npm run dev-certs` once (installs a trusted localhost HTTPS cert via
   `office-addin-dev-certs`).
2. `npm start` — serves the add-in at `https://localhost:3000`.
3. In **Excel on the web**, open a workbook, then **Home → Add-ins →
   More Add-ins → My Add-ins → Upload My Add-in**, and choose this project's
   `manifest.xml`.
4. A **Crystal Ball** group appears on the Home ribbon → click **Simulator** to
   open the task pane.

(For Excel desktop, `npm start` sideloads automatically via
`office-addin-debugging`.)

### Try an example

Open `examples/futura_apartments.xlsx` (or `vision_research.xlsx`). The
**Setup (read me)** sheet lists exactly which distribution to assign to each
green cell and which blue cells are forecasts, plus the run settings and the
Crystal Ball result to expect. Define them in the task pane, run, and compare.

## Notes & limitations

- HyperFormula is licensed GPL-3.0; the engine passes `licenseKey: 'gpl-v3'`
  (valid for open-source/personal use). For a closed-source product you'd need a
  commercial HyperFormula key, or use the native-Excel engine only.
- The native-Excel engine round-trips to the host once per trial, so keep trial
  counts modest with it; the in-browser engine is the default for speed.
- A function your model uses that HyperFormula doesn't implement surfaces as a
  warning before the run (switch to the native engine for those models).
- Not yet exposed in the UI (engine already supports them): assumption
  truncation bounds, and the alternate percentile parameter entry. OptQuest-style
  optimization and distribution fitting are out of scope for this version.
