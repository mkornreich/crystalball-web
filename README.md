# Crystal Ball Web

**Try the dashboard: https://mkornreich.github.io/crystalball-web/**

A reimplementation of **Oracle Crystal Ball**'s Monte Carlo simulation in
TypeScript. It comes as an **Excel task-pane add-in that runs in Excel on the
web** (Office.js) and as a standalone **web dashboard**. You attach
probability distributions to input cells ("assumptions"), mark output cells
("forecasts"), run a Monte Carlo simulation, and get Crystal Ball's forecast
statistics, a histogram with a certainty band, percentiles, and a sensitivity
tornado.

It reproduces Crystal Ball 11.1.3's calculations exactly. The algorithms were
studied in Crystal Ball itself, and results are checked against Crystal
Ball's own engine (below).

Oracle and Crystal Ball are trademarks of Oracle and/or its affiliates. This
project is not an Oracle product and isn't endorsed by Oracle. Oracle's
example workbooks aren't included.

## Validated against the real Crystal Ball

The engine reproduces Crystal Ball 11.1.3's own calculations, not just its
methods. Its numerical routines were analyzed (with Oracle's permission) and
re-implemented, and they are checked three ways:

1. **Against the real engine, number for number.** `harness/` loads Crystal
   Ball's own `OCB.Net.dll` under .NET on Linux and calls its *ungated* public
   functions (distribution CDF/inverse CDF, the random generator, Latin
   Hypercube, correlation matrices, eigen decomposition). The fixtures it writes
   are compared **bit for bit** in `src/engine/__tests__/distributions-cb.test.ts`
   (189 distribution cases, inverse CDF and CDF), `percentile-params.test.ts`
   (79 parameter sets entered as percentiles), `cb-nlopt.test.ts` (Crystal
   Ball's optimizer: every simplex step on seven problems, and .NET's `Random`),
   `cb-functions.test.ts` (the in-cell functions' random stream) and
   `sampling-cb.test.ts` (15 runs: Monte Carlo, Latin Hypercube, several
   worksheets, cuts, correlations incl. an inconsistent matrix — every trial's
   probability and value, the correlation matrices and their eigen
   decompositions equal). Crystal Ball's license-gated functions (the
   trial loop, forecast statistics) are never called or worked around; their
   logic was re-implemented from the decompiled code instead.
2. **Against Crystal Ball's published output.** The User's Guide figures were
   all captured with Monte Carlo and seed 999. Running Oracle's shipped
   workbooks through this engine (`src/cbfile/__tests__/published-results.test.ts`):

   | Model | Crystal Ball published | This engine |
   |---|---|---|
   | Futura Apartments, 1,000 trials — certainty Profit ≥ $0 | **90.09%** | **90.09%** |
   | Futura Apartments, 5,000 trials — all 10 statistics + 11 percentiles | mean $2,473.72, variance $3,424,956.14, … | **all equal** at CB's displayed precision |
   | Vision Research (Tutorial 2), 5,000 trials — all 10 statistics + 11 percentiles | mean $7.9, skewness −0.1734, … | **all equal** |

3. **Against every shipped example.** `tools/cb-run-examples.ts` reads and runs
   all of Crystal Ball's example workbooks: all 36 that contain a model run in
   the in-browser evaluator, 34 of them cleanly (the two that rely on Excel's
   iterative calculation are in Notes). `tools/hf-fidelity.ts` checks the
   evaluator against the values Excel saved in each workbook (38 of 40 agree in
   every cell).

What "exact" took — Crystal Ball behaviours this engine reproduces on purpose:

- One generator stream per worksheet (`r ← 62089911·r mod 2³¹−1`), seeded
  `seed + 3 + g + 10000·g` for the g-th sheet; assumptions drawn in tab, row,
  column order.
- Latin Hypercube: a fixed stratum permutation per assumption plus ten block
  offsets; the point in a stratum is the fractional part of u·(n+1).
- Correlation is a per-trial Gaussian copula (Spearman → 2·sin(πρ/6), CB's
  Householder+QL eigen solver), blank pairs implied as Pearson path products,
  inconsistent matrices repaired by flooring negative eigenvalues at 0.0625.
- Distributions use CB's kernels: Cephes inverse normal, 6-term Lanczos
  log-gamma, Student's t by 40-step bisection on ±100 (so draws never pass
  midpoint ± 100·scale), Beta by 100 damped iterations (inexact tails, as in
  CB), Gamma by Newton stopping at 2.2e-8, discrete inverses walking from the
  mode, cuts including both integer ends, Discrete Uniform's min−1 for the
  tiniest uniforms, Custom tables sorted by value.
- Statistics: sample variance by a corrected two-pass sum over sorted values,
  skewness/kurtosis with the sample std. dev. over n, classic median, mode =
  most frequent value (CB's "---" when none repeats), percentiles and
  certainty on CB's interpolated empirical CDF, sensitivity = average-rank
  Spearman normalized to contribution to variance.

### Crystal Ball features beyond the basic loop

- **In-cell functions** (`src/evaluators/cb-functions.ts`): the probability
  functions (`CB.Normal`, `CB.Triangular`, `CB.Binomial`, … 25 in all, with
  Crystal Ball's argument orders, plus `CB.Custom`) draw from Crystal Ball's
  separate function stream (seeded `runSeed + 2910485164`, one draw per call)
  and return the distribution's mean outside a run and on its first trial, as
  Crystal Ball does. The reporting functions (`CB.GetForeStatFN`,
  `CB.GetForePercentFN`, `CB.GetCertaintyFN`, `CB.GetRunPrefsFN`,
  `CB.IterationsFN`, …) read the run in progress.
- **Precision control** (`src/engine/precision.ts`): a forecast can ask for its
  mean, median, standard deviation or a percentile to within ± a value or a
  percentage at a confidence level; the run checks every N trials (CB default
  50, from trial 20) and stops once some target passed and none failed. The
  half-widths are Crystal Ball's: z·s/√n for the mean, z·s·√((kurtosis−1)/(4(n−1)))
  for the standard deviation, and its binomially weighted order-statistic
  estimate for percentiles; relative targets beyond 500% drop out of the check.
  Targets saved in a workbook (Define Forecast ▸ Precision) are read.
- **Crystal Ball's histogram** (`src/engine/bins.ts`): display range mean ± 2.8σ
  clipped to the data and widened by CB's `DisplayRoundRange`, column count
  from the chart width and density setting, one column per integer for
  discrete forecasts.
- **Parameters entered as percentiles** (`src/engine/percentile-params.ts`):
  `10%=80` may stand in for any parameter, from a workbook or typed in the add-in;
  named parameters fill their slots and percentiles the rest, in order. Every
  family follows Crystal Ball's solver step for step: least-squares
  location/scale on standardized quantiles and a golden-section search on the
  shape (starting from the percentile's value) for Normal, Uniform, Logistic,
  Min/Max Extreme, Student's t, Gamma, Weibull, Pareto, Exponential and
  Triangular; Crystal Ball's Nelder–Mead fits for Triangular (when a percentile
  sits at the likeliest), BetaPERT, Beta and Lognormal, through a port of its
  optimizer (`src/engine/cb-nlopt.ts`: the simplex, its two pattern searches,
  five restarts seeded through .NET's `Random`, stopping once the L1 distance
  to the targets is below 1e-5 — hence Crystal Ball's ~1e-6 misses, reproduced).
- **Sloping discrete Custom ranges**: the step weights run linearly from the
  start height to the end height, as in Crystal Ball.

### The C runtime's math, not JavaScript's

Crystal Ball calls .NET's `Math.Exp`, `Log`, `Pow`, `Log10`, `Sin`, `Tan`,
`Atan` and `Asin`, which hand off to the C runtime. JavaScript's `Math` functions
(V8's fdlibm ports) round differently in the last bit for 1–10% of inputs, enough
to move a Gamma tail, a Nelder–Mead path or a correlated draw.
`src/engine/libm.ts` therefore ports the C runtime the oracle runs on — glibc
2.43's x86-64 variants compiled with FMA — line for line: the fused
multiply-adds are where GCC fused them (read from its optimized GIMPLE, and from
the system library's machine code where Ubuntu's compiler fused differently),
done with an exact software `fma`, and the tables are glibc's own
(`libm-data.ts`). `tools/libm-check.ts` compares it with the system library on
2 million inputs per function (`tools/libm-refresh.sh` writes them): no
differences, including glibc's own departures from correct rounding. The engine
uses these functions everywhere it mirrors Crystal Ball, at a cost of about 8% in
run time.

## Project layout

```
src/engine/        pure Monte Carlo engine (no Office dependency, fully unit-tested)
  rng.ts           Crystal Ball's exact generator
  cbmath.ts        Crystal Ball's numerical kernels (inverse normal, Lanczos, betacf, …)
  special.ts       textbook special functions (densities, moments)
  distributions.ts the 21 distributions + Crystal Ball cuts
  sampling.ts      per-sheet streams, Monte Carlo / Latin Hypercube
  correlation.ts   Gaussian copula, implied coefficients, eigen solver
  statistics.ts    forecast stats, percentiles, ranking
  sensitivity.ts   contribution to variance
  simulation.ts    the runner
src/evaluators/    HyperFormula (in-browser) and native Excel model evaluators
src/excel/         Office.js bridge (read workbook, selection, settings, cell tint)
src/cbfile/        reads Crystal Ball workbooks (xlsx, CB_DATA_, MS-NRBF, model), Excel
                   number formats and data validation, and writes edited workbooks back
src/dashboard/     standalone web dashboard + example gallery + editable workbook grid
src/ui/            task-pane UI + canvas charts
tools/             parity fixtures, example reports/runs (run with `npx vite-node`)
examples/          clean example workbooks (Futura, Vision Research)
manifest.xml       Excel add-in manifest (XML)
```

## Build & run

Requires Node 18+ (developed on Node 22).

```bash
npm install
npm test            # 463 tests (471 with Oracle's example workbooks): engine math, Crystal Ball parity, published results, editing
npm run typecheck
npm run build       # production bundle into dist/
```

### Web dashboard

```bash
npm run examples    # optional: copy Crystal Ball's example workbooks from an install
npm run dashboard   # http://localhost:3100/dashboard.html
```

The same dashboard is published at
https://mkornreich.github.io/crystalball-web/. GitHub Actions builds and
deploys it on every push to `main` (`.github/workflows/pages.yml`).

Open any Crystal Ball workbook, review the model Crystal Ball saved in it, and
run it in the browser. You get a frequency chart with an editable certainty
range, the Statistics and Percentiles views, and the sensitivity tornado.
Workbooks are read in the browser and never uploaded.

Two of Crystal Ball's tutorials are built in: Futura Apartments and Vision
Research. They run on the project's own copies of the workbooks
(`examples/`, built by `tools/make_examples.py`), with the model Crystal Ball
saves for them defined in `src/dashboard/examples.ts`. The page compares each
run with Crystal Ball's published result, line by line.

`npm run examples` copies Oracle's example workbooks from an extracted
Crystal Ball install (`CB_EXAMPLES=/path/to/Examples`). After that, a local
build's gallery offers 21 of them, and the tests that read three of them
run too. Those files are Oracle's, so they're git-ignored and never
published.

**Editing the workbook.** Open the **Workbook** section to see the workbook's
sheets as a spreadsheet and edit them:

- **Cells.** Type in a cell, or double-click it, or use the formula bar.
  Enter keeps the value, Esc cancels, and you can undo. Values recalculate as
  you type.
- **How it looks.** Cells show the workbook's own number formats, column
  widths and row heights. Crystal Ball's assumption, forecast and
  decision-variable cells are coloured green, blue and yellow.
- **Resizing.** Drag a column or row edge in the headers to resize it, or
  double-click the edge to fit the contents. A number too wide for its column
  shows as `####`, and text that's cut off shows in full on hover, as in Excel.
- **Running.** Runs use the edited workbook, and the results panel tells you
  when they're out of date.
- **Saving.** **Download edited workbook** writes the edits into a copy of
  the .xlsx/.xlsm: cells, column widths, row heights and validation rules.
  Crystal Ball's model and everything else in the file are copied unchanged,
  and Excel recalculates the copy when it opens.

**Validation.** Typed values are checked before they're kept:

- A formula has to parse.
- A Crystal Ball assumption or decision-variable cell has to hold a number,
  since Crystal Ball requires one.
- Replacing a forecast's formula with a constant asks first.
- The cell's Excel **data validation** rule is enforced with its own Stop,
  Warning or Information alert. That covers whole numbers, decimals, lists,
  dates, times, text lengths and custom formulas, using rules from the
  workbook or ones you set. Multi-Zone Reserves, for example, keeps its
  correlation matrix between −1 and 1.

The **Data validation…** dialog sets or clears a rule: what to allow, the
input message shown when the cell is selected, and the error alert. List
rules get Excel's in-cell dropdown (Alt+↓). **Circle invalid data** marks and
counts the cells whose current values break their rules.

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
- Not yet exposed in the add-in UI (the engine supports it): assumption
  truncation bounds. OptQuest-style optimization and distribution fitting are out
  of scope for this version.
- In-cell probability functions draw in HyperFormula's evaluation order, which
  can differ from Excel's recalculation order: each function sees Crystal Ball's
  stream, but two CB-function cells may swap draws compared with Excel.
- Value Stream and Workforce with Queuing need Excel's iterative calculation
  (circular references resolved by iteration), which HyperFormula doesn't do;
  run them with the native-Excel engine.
- The histogram's column count follows the chart's pixel width as in Crystal
  Ball, so it matches a Crystal Ball chart of the same width and density.
- The math matches the C runtime the oracle uses (glibc on x86-64 with FMA).
  Crystal Ball on Windows runs on Microsoft's C runtime, which is also
  accurately rounded but not identical in every last bit; where the two
  runtimes disagree, Crystal Ball itself would differ between platforms.
- Run preferences are a per-user Crystal Ball setting, not stored in workbooks;
  reproduce a Crystal Ball run by matching trials, sampling and seed.
- The workbook grid edits one cell at a time. There's no multi-cell selection,
  copy/paste, inserting or deleting rows and columns, or editing of
  formatting. A typed date stays text rather than becoming a date serial. Fill
  colours, fonts other than bold and italic, merged cells and charts aren't
  drawn. Number formats with fractions, conditions or colours fall back to
  General.
- Data validation is checked when a value is typed, as in Excel, not on undo.
  The dialog shows date and time bounds as serial numbers. When a sheet's
  rules are changed, they are all written to its main `<dataValidations>`
  list; Excel 2010 and later read rules that point at other sheets from there
  too.
- The assumptions an example adds for its tutorial (Vision Research) live in
  the dashboard, not in the workbook, so a downloaded copy has only your cell
  edits.
- `harness/` (outside this repo) needs a Crystal Ball install. The committed
  fixtures (numbers recorded from Crystal Ball's engine) let the tests run
  without it. Three tests read Oracle's example workbooks and are skipped
  until `npm run examples` copies those into `src/cbfile/__tests__/fixtures/`.

## License

GPL-3.0-or-later (see `LICENSE`), as required by HyperFormula's GPL license
and the GNU C Library code in `src/engine/libm.ts`.
