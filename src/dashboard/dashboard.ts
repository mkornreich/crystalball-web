/**
 * The standalone web dashboard: open one of Crystal Ball's example workbooks
 * (or your own), see the model Crystal Ball saved in it, run it with Crystal
 * Ball's sampling and statistics in the browser, and read the results the way
 * Crystal Ball's forecast window shows them — frequency chart with certainty,
 * statistics and percentiles views, and the sensitivity tornado. The
 * workbook's sheets can be viewed and edited in place (sheet-grid.ts); runs use
 * the edited workbook, and the edits can be saved back into the .xlsx.
 */

import './dashboard.css';
import { readCrystalBallModel, resolveFormulaNames, CbWorkbookModel } from '../cbfile/model';
import { toWorkbookData, WorkbookContents } from '../cbfile/workbook-data';
import { applyEdits, editKey } from '../cbfile/workbook-edits';
import { writeEditedWorkbook } from '../cbfile/xlsx-write';
import { XlsxPackage, parseCellRef, splitSheetRef } from '../cbfile/xlsx';
import { getDistributionDef } from '../engine/distributions';
import { Assumption, Forecast, ForecastResult, SimulationResult } from '../engine/model';
import { PrecisionCheck, PrecisionRequirement, PrecisionStatistic } from '../engine/precision';
import { runSimulation } from '../engine/simulation';
import { certainty } from '../engine/statistics';
import { cbBins, ChartDensity } from '../engine/bins';
import { HyperFormulaEvaluator } from '../evaluators/hyperformula-evaluator';
import { drawHistogram, drawTornado, formatNumber } from './charts';
import { EXAMPLES, Example, PublishedResult } from './examples';
import { CellMark, WorkbookGrid } from './sheet-grid';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Crystal Ball's example workbooks this build ships (set by webpack; none in the public build). */
declare const __CB_EXAMPLE_FILES__: string[];
const SHIPPED = new Set(typeof __CB_EXAMPLE_FILES__ === 'undefined' ? [] : __CB_EXAMPLE_FILES__);
/** Examples that can be opened here: Oracle's workbook is shipped, or the project has its own copy. */
const AVAILABLE = EXAMPLES.filter((ex) => SHIPPED.has(ex.file) || ex.own);

interface Loaded {
  title: string;
  /** The workbook's file name, for saving the edited copy. */
  fileName: string;
  pkg: XlsxPackage;
  model: CbWorkbookModel;
  assumptions: Assumption[];
  forecasts: Forecast[];
  example?: Example;
  data?: WorkbookContents;
  /** The project's own copy of an example workbook, with Crystal Ball's model defined in the dashboard. */
  ownCopy?: boolean;
}

let loaded: Loaded | null = null;
let result: SimulationResult | null = null;
let lastRun: { trials: number; seed: number | null; sampling: string; edited: number } | null = null;
let precisionConfidence = 0.95;
let grid: WorkbookGrid | null = null;
/** Bumped on every edit; a run remembers the value it ran with. */
let editsVersion = 0;
let runVersion = 0;

/* ------------------------------ theme -------------------------------- */

function initTheme() {
  const btn = $('theme');
  const stored = safeGet('cb-theme');
  if (stored === 'light' || stored === 'dark') document.documentElement.dataset.theme = stored;
  btn.addEventListener('click', () => {
    const dark =
      document.documentElement.dataset.theme === 'dark' ||
      (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    const next = dark ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    safeSet('cb-theme', next);
    if (result) renderForecast();
  });
}
function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string) {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage unavailable */
  }
}

/* ----------------------------- examples ------------------------------ */

function renderExamples() {
  const ul = $('examples');
  ul.innerHTML = '';
  for (const ex of AVAILABLE) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.id = ex.id;
    const tags = ex.features.map((f) => `<span class="tag">${esc(f)}</span>`).join('');
    const verified = ex.published ? '<span class="tag verified">✓ matches published CB result</span>' : '';
    b.innerHTML = `<b>${esc(ex.title)}</b><span class="blurb">${esc(ex.blurb)}</span><span class="tags">${verified}${tags}</span>`;
    b.addEventListener('click', () => void openExample(ex));
    li.appendChild(b);
    ul.appendChild(li);
  }
}

async function openExample(ex: Example) {
  markCurrent(ex.id);
  try {
    // Oracle's workbook when this build has it, otherwise the project's own copy with Crystal Ball's model added.
    const own = !SHIPPED.has(ex.file) && ex.own;
    const file = own ? own.file : ex.file;
    const res = await fetch(own ? `examples/${encodeURIComponent(file)}` : `examples/crystal-ball/${encodeURIComponent(file)}`);
    if (!res.ok) throw new Error(`could not load ${file} (${res.status}) — run tools/copy-cb-examples.sh`);
    const example: Example = own
      ? {
          ...ex,
          extraAssumptions: [...own.assumptions, ...(ex.extraAssumptions ?? [])],
          extraForecasts: [...own.forecasts, ...(ex.extraForecasts ?? [])],
        }
      : ex;
    await openWorkbook(new Uint8Array(await res.arrayBuffer()), ex.title, file, example, !!own);
  } catch (e) {
    showError(e as Error);
  }
}

function markCurrent(id: string | null) {
  for (const b of document.querySelectorAll<HTMLButtonElement>('#examples button'))
    b.setAttribute('aria-current', String(b.dataset.id === id));
}

/* ------------------------------ loading ------------------------------ */

async function openWorkbook(bytes: Uint8Array, title: string, fileName: string, example?: Example, ownCopy = false) {
  const { pkg, model } = await readCrystalBallModel(bytes);
  const assumptions = [...model.assumptions];
  for (const a of example?.extraAssumptions ?? []) if (!assumptions.some((x) => x.cell === a.cell)) assumptions.push(a);
  const forecasts = [...model.forecasts, ...(example?.extraForecasts ?? [])];
  grid?.dispose();
  grid = null;
  $('wb-circle').setAttribute('aria-pressed', 'false');
  $('wb-status').textContent = '';
  editsVersion = runVersion = 0;
  if (ownCopy) model.warnings = model.warnings.filter((w) => !/^No Crystal Ball data/.test(w));
  loaded = { title, fileName, pkg, model, assumptions, forecasts, example, ownCopy };
  await resolveNames(loaded);
  result = null;
  $('results').hidden = true;
  $('stale').hidden = true;
  $('empty').hidden = true;
  $('model').hidden = false;
  $<HTMLInputElement>('trials').value = String(example?.trials ?? 1000);
  $<HTMLSelectElement>('sampling').value = example?.sampling ?? 'mc';
  $<HTMLInputElement>('useseed').checked = true;
  $<HTMLInputElement>('seed').value = '999';
  renderModel();
  updateEditControls();
  if ($<HTMLDetailsElement>('wb-block').open) await showWorkbook();
}

/* ----------------------------- workbook ------------------------------ */

/** Crystal Ball's cells in the grid: assumptions, forecasts and decision variables. */
function cellMarks(l: Loaded): Map<string, CellMark> {
  const marks = new Map<string, CellMark>();
  const add = (ref: string, mark: CellMark) => {
    try {
      const { sheet, address } = splitSheetRef(ref);
      const { row, col } = parseCellRef(address);
      const name = (sheet && l.pkg.sheetByName(sheet)?.name) ?? l.model.sheetOrder[0];
      if (name) marks.set(editKey(name, row, col), mark);
    } catch {
      /* not a single cell */
    }
  };
  for (const d of l.model.decisionVariables) add(d.cell, { kind: 'decision', label: `Decision variable: ${d.name}` });
  for (const a of l.assumptions) add(a.cell, { kind: 'assumption', label: `Assumption: ${a.name} — ${describe(a)}` });
  for (const f of l.forecasts) add(f.cell, { kind: 'forecast', label: `Forecast: ${f.name}` });
  return marks;
}

/** Build the workbook grid the first time it's shown for a workbook. */
async function showWorkbook() {
  const l = loaded;
  if (!l || grid) return;
  try {
    l.data ??= await toWorkbookData(l.pkg);
    const g = await WorkbookGrid.create(
      { pkg: l.pkg, data: l.data, marks: cellMarks(l), onEdit },
      {
        tabs: $('wb-tabs'),
        grid: $('wb-grid'),
        name: $<HTMLInputElement>('wb-name'),
        bar: $<HTMLInputElement>('wb-input'),
        alert: $<HTMLDialogElement>('wb-alert'),
        ruleDialog: $<HTMLDialogElement>('dv-dialog'),
        status: $('wb-status'),
      },
    );
    if (loaded !== l || grid) g.dispose();
    else {
      grid = g;
      updateEditControls();
    }
  } catch (e) {
    showError(e as Error);
  }
}

function onEdit(kind: 'cells' | 'layout') {
  if (kind === 'cells') editsVersion++;
  updateEditControls();
}

function updateEditControls() {
  const n = grid?.edits.size ?? 0;
  const sized = grid?.resizedCount ?? 0;
  const ruled = grid?.rulesChangedOn().length ?? 0;
  const cells = n ? `${n} edited cell${n === 1 ? '' : 's'}` : '';
  const sizes = sized ? (sized === 1 ? '1 column or row resized' : `${sized} columns and rows resized`) : '';
  const rules = ruled ? `validation changed on ${ruled} sheet${ruled === 1 ? '' : 's'}` : '';
  $('wb-count').textContent = [cells, sizes, rules].filter(Boolean).join(' · ');
  const changed = !!(n || sized || ruled);
  $<HTMLButtonElement>('wb-undo').disabled = !grid?.canUndo;
  $<HTMLButtonElement>('wb-revert').disabled = !changed;
  $<HTMLButtonElement>('wb-download').disabled = !changed;
  $<HTMLButtonElement>('wb-dv').disabled = !grid;
  $<HTMLButtonElement>('wb-circle').disabled = !grid;
  const sheets = loaded?.model.sheetOrder.length ?? 0;
  $('wb-summary').textContent = `Workbook (${sheets} sheet${sheets === 1 ? '' : 's'}${n ? ` · ${n} edited` : ''})`;
  $('stale').hidden = !result || editsVersion === runVersion;
}

/** Save the workbook with the edits written into its cells. */
async function downloadEdited() {
  if (!loaded || !grid || (!grid.edits.size && !grid.resizedCount && !grid.rulesChangedOn().length)) return;
  try {
    const bytes = await writeEditedWorkbook(loaded.pkg, grid.editList(), grid.layout());
    const m = /^(.*?)(\.[^.]+)?$/.exec(loaded.fileName) as RegExpExecArray;
    const ext = m[2] ?? '.xlsx';
    const type = /\.xlsm$/i.test(ext) ? 'application/vnd.ms-excel.sheet.macroEnabled.12' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${m[1]} (edited)${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (e) {
    showError(e as Error);
  }
}

/** Crystal Ball names that are formulas (`$I12&" - "&J$11`) shown as the text they evaluate to. */
async function resolveNames(l: Loaded) {
  const items = [...l.assumptions, ...l.forecasts];
  if (!items.some((x) => /[&"]/.test(x.name))) return;
  try {
    l.data ??= await toWorkbookData(l.pkg);
    const ev = new HyperFormulaEvaluator(l.data, [], []);
    try {
      resolveFormulaNames(items, (e, sh) => ev.evaluateExpression(e, sh));
    } finally {
      ev.dispose();
    }
  } catch {
    /* keep the names as written */
  }
}

function describe(a: Assumption): string {
  const def = getDistributionDef(a.type);
  if (a.type === 'custom') {
    const rows = a.custom ?? [];
    const parts = rows.slice(0, 4).map((c) =>
      c.min !== undefined ? `[${fmt(c.min)}, ${fmt(c.max ?? c.min)}]${c.step ? ` step ${fmt(c.step)}` : ''} @ ${fmt(c.weight)}` : `${fmt(c.value ?? 0)} @ ${fmt(c.weight)}`,
    );
    return `${def.label}: ${parts.join('; ')}${rows.length > 4 ? ` … (${rows.length} rows)` : ''}`;
  }
  const alt =
    a.type === 'lognormal' && a.params.logMean !== undefined
      ? `log mean ${fmt(a.params.logMean)}, log std. dev. ${fmt(a.params.logStdev)}`
      : a.type === 'lognormal' && a.params.geoMean !== undefined
        ? `geometric mean ${fmt(a.params.geoMean)}, geometric std. dev. ${fmt(a.params.geoStdev)}`
        : '';
  const ps = alt
    ? `${alt}${a.params.location ? `, location ${fmt(a.params.location)}` : ''}`
    : def.params.map((p) => `${p.label} ${fmt(a.params[p.key])}`).join(', ');
  if (a.entered) {
    const given = a.entered.map((e) => (e.prob !== undefined ? `${fmt(e.prob * 100)}%=${fmt(e.value)}` : `${e.key}=${fmt(e.value)}`));
    return `${def.label}(${given.join(', ')}) → ${ps}`;
  }
  return `${def.label}(${ps})`;
}
const PREC_STATS: [PrecisionStatistic, string][] = [
  ['mean', 'Mean'],
  ['median', 'Median'],
  ['stddev', 'Std. dev.'],
  ['percentile', 'Percentile'],
];

/** A forecast's precision target as Crystal Ball's Define Forecast dialog sets it: statistic, ± value, % or units. */
function precisionEditor(f: Forecast, i: number): string {
  const [r, ...more] = f.precision ?? [];
  const opt = (v: string, label: string, on: boolean) => `<option value="${v}"${on ? ' selected' : ''}>${label}</option>`;
  const name = esc(f.name);
  return (
    `<div class="prec-edit" data-i="${i}">` +
    `<select data-k="stat" aria-label="Precision statistic for ${name}">${opt('', 'Off', !r)}${PREC_STATS.map(([v, l]) => opt(v, l, r?.stat === v)).join('')}</select>` +
    `<input data-k="pct" type="number" min="0.01" max="99.99" step="any" value="${r?.percentile ?? 90}" aria-label="Percentile for ${name}"${r?.stat === 'percentile' ? '' : ' hidden'} />` +
    `<span>±</span><input data-k="value" type="number" min="0" step="any" value="${r ? fmt(r.value) : 5}" aria-label="Required precision for ${name}"${r ? '' : ' disabled'} />` +
    `<select data-k="abs" aria-label="Precision units for ${name}"${r ? '' : ' disabled'}>${opt('rel', '%', !r?.absolute)}${opt('abs', 'units', !!r?.absolute)}</select>` +
    (more.length ? `<span class="sub">+ ${more.map(precLabel).join(', ')}</span>` : '') +
    '</div>'
  );
}

function precLabel(r: PrecisionRequirement): string {
  const stat = r.stat === 'percentile' ? `P${fmt(r.percentile ?? 50)}` : PREC_STATS.find(([v]) => v === r.stat)?.[1] ?? r.stat;
  return `${stat} ±${fmt(r.value)}${r.absolute ? '' : '%'}`;
}

/** Read one forecast's precision editor back into its requirements. */
function onPrecisionEdit(evt: Event) {
  const row = (evt.target as HTMLElement).closest<HTMLElement>('.prec-edit');
  if (!row || !loaded) return;
  const f = loaded.forecasts[Number(row.dataset.i)];
  const get = <T extends HTMLInputElement | HTMLSelectElement>(k: string) => row.querySelector<T>(`[data-k="${k}"]`)!;
  const stat = get<HTMLSelectElement>('stat').value as PrecisionStatistic | '';
  get('pct').hidden = stat !== 'percentile';
  get('value').disabled = get('abs').disabled = !stat;
  row.querySelector('.sub')?.remove();
  const value = Number(get('value').value);
  if (!stat || !(value > 0)) {
    f.precision = undefined;
    return;
  }
  const pct = Math.min(99.99, Math.max(0.01, Number(get('pct').value) || 90));
  f.precision = [{ stat, absolute: get('abs').value === 'abs', value, ...(stat === 'percentile' ? { percentile: pct } : {}) }];
}

function fmt(v: number): string {
  return Number.isFinite(v) ? String(Number(v.toPrecision(8))) : '—';
}
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

function renderModel() {
  if (!loaded) return;
  const { model, assumptions, forecasts, example } = loaded;
  $('model-title').textContent = loaded.title;
  $('model-sub').textContent =
    `${assumptions.length} assumptions · ${forecasts.length} forecasts · ${model.correlations.length} correlations` +
    (model.decisionVariables.length ? ` · ${model.decisionVariables.length} decision variables` : '') +
    (model.savedBy ? ` · saved by Crystal Ball ${model.savedBy}` : '');
  const notes = [...model.warnings];
  if (loaded.ownCopy)
    notes.unshift(
      "This is the project's own copy of the tutorial workbook (Oracle's example files aren't published here). " +
        `The dashboard defines the model Crystal Ball saved in Oracle's copy${
          EXAMPLES.find((e) => e.id === example?.id)?.extraAssumptions?.length ? ' and the additions the tutorial has you make' : ''
        }.`,
    );
  else if (example?.extraAssumptions?.length)
    notes.unshift(`Adds the ${example.extraAssumptions.length} assumptions and the forecast the tutorial has you define.`);
  $('model-warnings').innerHTML = notes.length ? `<ul>${notes.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '';

  $('asm-summary').textContent = `Assumptions (${assumptions.length})`;
  $('asm-table').innerHTML =
    '<thead><tr><th>Name</th><th>Cell</th><th>Distribution</th><th>Cuts</th></tr></thead><tbody>' +
    assumptions
      .map(
        (a) =>
          `<tr><td>${esc(a.name)}</td><td>${esc(a.cell)}</td><td>${esc(describe(a))}</td><td>${
            a.truncMin !== undefined || a.truncMax !== undefined ? `${fmt(a.truncMin ?? -Infinity)} … ${fmt(a.truncMax ?? Infinity)}` : ''
          }</td></tr>`,
      )
      .join('') +
    '</tbody>';
  $('frc-summary').textContent = `Forecasts (${forecasts.length})`;
  $('frc-table').innerHTML =
    '<thead><tr><th>Name</th><th>Cell</th><th>Filter</th><th>Precision target</th></tr></thead><tbody>' +
    forecasts
      .map(
        (f, i) =>
          `<tr><td>${esc(f.name)}</td><td>${esc(f.cell)}</td><td>${
            f.filterMin !== undefined || f.filterMax !== undefined ? `${fmt(f.filterMin ?? -Infinity)} … ${fmt(f.filterMax ?? Infinity)}` : ''
          }</td><td>${precisionEditor(f, i)}</td></tr>`,
      )
      .join('') +
    '</tbody>';
  const names = new Map(assumptions.map((a) => [a.id, a.name]));
  $('corr-block').hidden = !model.correlations.length;
  $('corr-summary').textContent = `Correlations (${model.correlations.length})`;
  $('corr-table').innerHTML =
    '<thead><tr><th>Assumption</th><th>Assumption</th><th class="num">Rank correlation</th></tr></thead><tbody>' +
    model.correlations
      .map((c) => `<tr><td>${esc(names.get(c.a) ?? c.a)}</td><td>${esc(names.get(c.b) ?? c.b)}</td><td class="num">${c.coefficient}</td></tr>`)
      .join('') +
    '</tbody>';
}

/* ------------------------------- run --------------------------------- */

async function run() {
  if (!loaded) return;
  const btn = $<HTMLButtonElement>('run');
  const bar = $('progress');
  btn.disabled = true;
  bar.hidden = false;
  const fill = bar.firstElementChild as HTMLElement;
  try {
    loaded.data ??= await toWorkbookData(loaded.pkg);
    const { assumptions, forecasts, model } = loaded;
    if (!assumptions.length || !forecasts.length) throw new Error('This workbook has no assumptions or no forecasts to simulate.');
    const edits = grid?.editList() ?? [];
    const version = editsVersion;
    const data = edits.length ? applyEdits(loaded.data, edits) : loaded.data;
    const ev = new HyperFormulaEvaluator(data, assumptions.map((a) => a.cell), forecasts.map((f) => f.cell));
    const diag = ev.diagnostics(forecasts.map((f) => f.name));
    const trials = Math.max(1, Math.min(200000, Number($<HTMLInputElement>('trials').value) || 1000));
    const useSeed = $<HTMLInputElement>('useseed').checked;
    const seed = Math.max(1, Math.floor(Number($<HTMLInputElement>('seed').value) || 999));
    const sampling = $<HTMLSelectElement>('sampling').value as 'mc' | 'lhs';
    const precision = {
      enabled: $<HTMLInputElement>('prec').checked,
      checkEvery: Math.max(1, Math.floor(Number($<HTMLInputElement>('prec-every').value) || 50)),
      confidence: Math.min(0.9999, Math.max(0.0001, (Number($<HTMLInputElement>('prec-conf').value) || 95) / 100)),
    };
    const t0 = performance.now();
    result = await runSimulation(
      assumptions,
      forecasts,
      model.correlations,
      {
        trials,
        sampling,
        lhsSampleSize: Number($<HTMLInputElement>('lhs').value) || 500,
        useSeed,
        seed,
        sheetOrder: model.sheetOrder,
        precision,
      },
      ev,
      {
        yieldEvery: 100,
        onProgress: (p) => (fill.style.width = `${(100 * p.done) / p.total}%`),
      },
    );
    ev.dispose();
    result.warnings.unshift(...diag);
    lastRun = { trials: result.trials, seed: useSeed ? seed : null, sampling, edited: edits.length };
    runVersion = version;
    updateEditControls();
    $('run-sub').textContent =
      `${result.trials.toLocaleString()} trials${result.stoppedByPrecision ? ` of ${trials.toLocaleString()} (precision met)` : ''} · ` +
      `${sampling === 'mc' ? 'Monte Carlo' : 'Latin Hypercube'} · ` +
      `${useSeed ? `seed ${seed}` : 'random seed'} · ${Math.round(performance.now() - t0)} ms` +
      (edits.length ? ` · ${edits.length} edited cell${edits.length === 1 ? '' : 's'}` : '');
    precisionConfidence = precision.confidence;
    const sel = $<HTMLSelectElement>('forecast');
    sel.innerHTML = result.forecasts.map((f, i) => `<option value="${i}">${esc(f.name)}</option>`).join('');
    const low = loaded.example?.certaintyLow;
    $<HTMLInputElement>('cert-low').value = low === undefined ? '-Infinity' : String(low);
    $<HTMLInputElement>('cert-high').value = 'Infinity';
    $('results').hidden = false;
    renderForecast();
    $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    showError(e as Error);
  } finally {
    btn.disabled = false;
    bar.hidden = true;
    fill.style.width = '0';
  }
}

function parseBound(s: string, fallback: number): number {
  const t = s.trim().toLowerCase().replace(/[$,\s]/g, '');
  if (t === 'infinity' || t === '+infinity' || t === 'inf') return Infinity;
  if (t === '-infinity' || t === '-inf') return -Infinity;
  const v = Number(t);
  return Number.isFinite(v) ? v : fallback;
}

/* ------------------------------ results ------------------------------ */

function current(): ForecastResult | null {
  if (!result) return null;
  return result.forecasts[Number($<HTMLSelectElement>('forecast').value) || 0] ?? null;
}

function renderForecast() {
  const f = current();
  if (!f || !result) return;
  const units = f.units ?? '';
  $('run-warnings').innerHTML = result.warnings.length
    ? `<ul>${result.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
    : '';
  const low = parseBound($<HTMLInputElement>('cert-low').value, -Infinity);
  const high = parseBound($<HTMLInputElement>('cert-high').value, Infinity);
  const kept = f.values.filter(Number.isFinite);
  const cert = certainty(kept, low, high);
  $('cert-value').textContent = `${cert.toFixed(2)}%`;
  const s = f.stats;
  const tile = (k: string, v: string) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div></div>`;
  $('tiles').innerHTML =
    tile('Mean', formatNumber(s.mean, units)) +
    tile('Median', formatNumber(s.median, units)) +
    tile('Std. deviation', formatNumber(s.stdDev, units)) +
    tile(`Certainty ${rangeLabel(low, high, units)}`, `${cert.toFixed(2)}%`);

  renderPrecision(f, units);

  const host = $('hist');
  const bins = cbBins(kept, {
    widthPx: host.clientWidth || 640,
    density: $<HTMLSelectElement>('density').value as ChartDensity,
    mean: s.mean,
    stdDev: s.stdDev,
  });
  drawHistogram(host, bins, { low, high, units });
  $('hist-note').textContent =
    `${bins.total.toLocaleString()} trials · ${bins.displayed.toLocaleString()} displayed · ${bins.counts.length} columns`;

  const rows: [string, string][] = [
    ['Trials', s.trials.toLocaleString()],
    ['Mean', formatNumber(s.mean, units)],
    ['Median', formatNumber(s.median, units)],
    ['Mode', s.mode === null ? '---' : formatNumber(s.mode, units)],
    ['Standard Deviation', formatNumber(s.stdDev, units)],
    ['Variance', formatNumber(s.variance)],
    ['Skewness', s.skewness.toFixed(4)],
    ['Kurtosis', s.kurtosis.toFixed(2)],
    ['Coeff. of Variation', Number.isFinite(s.coeffOfVariability) ? s.coeffOfVariability.toFixed(4) : '---'],
    ['Minimum', formatNumber(s.min, units)],
    ['Maximum', formatNumber(s.max, units)],
    ['Range Width', formatNumber(s.range, units)],
    ['Mean Std. Error', formatNumber(s.meanStdError, units)],
  ];
  $('stats').innerHTML =
    '<thead><tr><th>Statistic</th><th class="num">Forecast values</th></tr></thead><tbody>' +
    rows.map(([k, v]) => `<tr><td>${k}</td><td class="num">${v}</td></tr>`).join('') +
    '</tbody>';
  $('pct').innerHTML =
    '<thead><tr><th>Percentile</th><th class="num">Forecast values</th></tr></thead><tbody>' +
    f.percentiles.map((p) => `<tr><td>${p.p}%</td><td class="num">${formatNumber(p.value, units)}</td></tr>`).join('') +
    '</tbody>';
  drawTornado($('tornado'), f.sensitivity);
  renderComparison(f);
}

const PREC_STATE: Record<PrecisionCheck['state'], [string, string]> = {
  passed: ['ok', '✓ met'],
  failed: ['miss', '✗ not met'],
  'not-valid': ['miss', 'too few trials to judge'],
  eliminated: ['', 'dropped — too imprecise to judge'],
};

/** The forecast's precision targets at the end of the run. */
function renderPrecision(f: ForecastResult, units: string) {
  const note = $('prec-note');
  note.hidden = !f.precision?.length;
  if (!f.precision?.length || !result) return;
  const conf = `${Number((precisionConfidence * 100).toFixed(2))}%`;
  const head = result.stoppedByPrecision
    ? `Precision control stopped the run at ${result.trials.toLocaleString()} trials.`
    : `Precision targets checked at ${conf} confidence:`;
  const items = f.precision.map((c) => {
    const [cls, label] = PREC_STATE[c.state];
    const width = Number.isFinite(c.halfWidth)
      ? ` ± ${formatNumber(c.halfWidth, units)}${c.value ? ` (${((100 * c.halfWidth) / Math.abs(c.value)).toFixed(2)}%)` : ''}`
      : '';
    return `${esc(precLabel(c.requirement))}: ${formatNumber(c.value, units)}${width} <span class="${cls}">${label}</span>`;
  });
  note.innerHTML = `${esc(head)} ${items.join(' · ')}${result.stoppedByPrecision ? ` (${conf} confidence)` : ''}`;
}

function rangeLabel(low: number, high: number, units: string): string {
  if (!Number.isFinite(low) && !Number.isFinite(high)) return '(all)';
  if (!Number.isFinite(high)) return `≥ ${formatNumber(low, units)}`;
  if (!Number.isFinite(low)) return `≤ ${formatNumber(high, units)}`;
  return `${formatNumber(low, units)} … ${formatNumber(high, units)}`;
}

const STAT_LABELS: Record<string, string> = {
  mean: 'Mean',
  median: 'Median',
  stdDev: 'Standard Deviation',
  variance: 'Variance',
  skewness: 'Skewness',
  kurtosis: 'Kurtosis',
  coeffOfVariability: 'Coeff. of Variation',
  min: 'Minimum',
  max: 'Maximum',
  meanStdError: 'Mean Std. Error',
};

/** Show the published Crystal Ball result that matches this run's settings, if any. */
function renderComparison(f: ForecastResult) {
  const box = $('compare');
  const ex = loaded?.example;
  const pub: PublishedResult | undefined = ex?.published?.find(
    (p) => lastRun && !lastRun.edited && p.trials === lastRun.trials && lastRun.seed === 999 && lastRun.sampling === 'mc',
  );
  if (ex?.published && lastRun?.edited) {
    box.hidden = false;
    $('compare-src').textContent = "This run used the edited workbook, so it isn't compared with Crystal Ball's published result for the original. Revert the edits and run again to compare.";
    $('compare-table').innerHTML = '';
    return;
  }
  if (!pub || result?.forecasts[0] !== f) {
    box.hidden = !ex?.published;
    if (ex?.published) {
      $('compare-src').textContent = `Run ${ex.published.map((p) => p.trials.toLocaleString()).join(' or ')} trials, Monte Carlo, seed 999 on the first forecast to compare with Crystal Ball's published output.`;
      $('compare-table').innerHTML = '';
    }
    return;
  }
  box.hidden = false;
  $('compare-src').textContent = `Crystal Ball 11.1.3 — ${pub.source}. Each value is compared at the precision Crystal Ball displays.`;
  const rows: string[] = [];
  const line = (label: string, ours: number, cb: number, digits: number) => {
    const shown = Number(ours.toFixed(digits));
    const ok = shown === cb;
    rows.push(
      `<tr><td>${label}</td><td class="num">${shown.toFixed(digits)}</td><td class="num">${cb.toFixed(digits)}</td><td class="${ok ? 'ok' : 'miss'}">${ok ? '✓ match' : '✗ differs'}</td></tr>`,
    );
  };
  if (pub.certainty) {
    const c = certainty(f.values.filter(Number.isFinite), pub.certainty.low, pub.certainty.high);
    line(`Certainty ${rangeLabel(pub.certainty.low, pub.certainty.high, '')} (%)`, c, pub.certainty.value, 2);
  }
  for (const [k, v] of Object.entries(pub.stats ?? {})) {
    if (!v) continue;
    line(STAT_LABELS[k] ?? k, f.stats[k as keyof typeof STAT_LABELS & keyof typeof f.stats] as number, v[0], v[1]);
  }
  for (const [p, cb] of pub.percentiles?.values ?? []) {
    const ours = f.percentiles.find((x) => x.p === p)?.value ?? NaN;
    line(`${p}th percentile`, ours, cb, pub.percentiles!.digits);
  }
  $('compare-table').innerHTML =
    '<thead><tr><th>Statistic</th><th class="num">This engine</th><th class="num">Crystal Ball</th><th></th></tr></thead><tbody>' +
    rows.join('') +
    '</tbody>';
}

function showError(e: Error) {
  const target = loaded ? $('model-warnings') : $('empty');
  const note = document.createElement('p');
  note.className = 'miss';
  note.textContent = `Error: ${e.message}`;
  target.hidden = false;
  target.prepend(note);
}

/* ------------------------------- boot -------------------------------- */

function boot() {
  initTheme();
  renderExamples();
  $('run').addEventListener('click', () => void run());
  $('rerun').addEventListener('click', () => void run());
  const wb = $<HTMLDetailsElement>('wb-block');
  if (safeGet('cb-workbook-open') === '1') wb.open = true;
  wb.addEventListener('toggle', () => {
    safeSet('cb-workbook-open', wb.open ? '1' : '0');
    if (wb.open) void showWorkbook();
  });
  $('wb-undo').addEventListener('click', () => grid?.undo());
  $('wb-revert').addEventListener('click', () => grid?.revertAll());
  $('wb-download').addEventListener('click', () => void downloadEdited());
  $('wb-dv').addEventListener('click', () => void grid?.editValidation());
  $('wb-circle').addEventListener('click', () => {
    if (grid) $('wb-circle').setAttribute('aria-pressed', String(grid.toggleCircle()));
  });
  $('forecast').addEventListener('change', renderForecast);
  $('frc-table').addEventListener('change', onPrecisionEdit);
  $('frc-table').addEventListener('input', onPrecisionEdit);
  for (const id of ['cert-low', 'cert-high', 'density']) $(id).addEventListener('change', renderForecast);
  $<HTMLInputElement>('file').addEventListener('change', async (evt) => {
    const file = (evt.target as HTMLInputElement).files?.[0];
    if (!file) return;
    markCurrent(null);
    try {
      await openWorkbook(new Uint8Array(await file.arrayBuffer()), file.name, file.name);
    } catch (e) {
      showError(e as Error);
    }
  });
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => result && renderForecast(), 150);
  });
  const id = new URLSearchParams(location.search).get('example');
  const ex = EXAMPLES.find((e) => e.id === id);
  if (ex) void openExample(ex);
}

boot();
