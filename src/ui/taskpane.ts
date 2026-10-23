/**
 * Task-pane controller: the whole add-in UI.
 *
 * Holds the model (assumptions, forecasts, correlations, run settings),
 * persists it in the document, and drives a run through either the
 * HyperFormula evaluator (fast, in-browser) or the native Excel evaluator
 * (authentic recalc). Results are rendered as Crystal Ball-style forecast
 * statistics, a frequency histogram with a certainty band, percentiles, and a
 * sensitivity tornado.
 */

import './styles.css';
import {
  CustomPoint,
  DISTRIBUTIONS,
  DistributionType,
  createDistribution,
  defaultParams,
  getDistributionDef,
} from '../engine/distributions';
import {
  Assumption,
  Correlation,
  DEFAULT_CONFIG,
  Forecast,
  ModelEvaluator,
  SimulationConfig,
  SimulationResult,
} from '../engine/model';
import { percentileSorted } from '../engine/statistics';
import { runSimulation, ProgressInfo } from '../engine/simulation';
import { HyperFormulaEvaluator } from '../evaluators/hyperformula-evaluator';
import { ExcelEvaluator } from '../evaluators/excel-evaluator';
import {
  ASSUMPTION_COLOR,
  FORECAST_COLOR,
  clearMark,
  getSelectedCell,
  gotoCell,
  loadState,
  markCell,
  readWorkbook,
  saveState,
} from '../excel/workbook';
import { drawDistributionPreview, drawHistogram, drawTornado } from './charts';

interface AppState {
  assumptions: Assumption[];
  forecasts: Forecast[];
  correlations: Correlation[];
  config: SimulationConfig;
  engine: 'hf' | 'excel';
}

const state: AppState = {
  assumptions: [],
  forecasts: [],
  correlations: [],
  config: { ...DEFAULT_CONFIG },
  engine: 'hf',
};

let lastResult: SimulationResult | null = null;
let selectedForecastId: string | null = null;
let cancelRequested = false;

/* ------------------------------- helpers ------------------------------- */

function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function $(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing #${id}`);
  return e;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<Record<string, string>> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

function fmt(v: number | null, digits = 3): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-4 || a >= 1e7)) return v.toExponential(2);
  return v.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function persist(): void {
  saveState(state).catch((e) => console.warn('save failed', e));
}

function setStatus(msg: string, kind: 'info' | 'error' = 'info'): void {
  const s = $('status');
  s.textContent = msg;
  s.className = `status ${kind}`;
}

/* --------------------------------- tabs -------------------------------- */

function switchTab(name: string): void {
  for (const t of ['model', 'run', 'results']) {
    $(`tab-${t}`).classList.toggle('active', t === name);
    $(`panel-${t}`).classList.toggle('hidden', t !== name);
  }
  if (name === 'results') renderResults();
}

/* ----------------------------- assumptions ----------------------------- */

async function addAssumption(): Promise<void> {
  try {
    const sel = await getSelectedCell();
    if (state.assumptions.some((a) => a.cell === sel.address)) {
      setStatus(`${sel.address} is already an assumption.`, 'error');
      return;
    }
    if (state.forecasts.some((f) => f.cell === sel.address)) {
      setStatus(`${sel.address} is already a forecast.`, 'error');
      return;
    }
    const a: Assumption = {
      id: uid('a'),
      cell: sel.address,
      name: sel.name,
      type: 'normal',
      params: defaultParams('normal'),
    };
    state.assumptions.push(a);
    await markCell(sel.address, ASSUMPTION_COLOR).catch(() => undefined);
    persist();
    renderAssumptions();
    setStatus(`Added assumption on ${sel.address}.`);
  } catch (e) {
    setStatus(`Could not read selection: ${(e as Error).message}`, 'error');
  }
}

function deleteAssumption(id: string): void {
  const a = state.assumptions.find((x) => x.id === id);
  state.assumptions = state.assumptions.filter((x) => x.id !== id);
  state.correlations = state.correlations.filter((c) => c.a !== id && c.b !== id);
  if (a) clearMark(a.cell).catch(() => undefined);
  persist();
  renderAssumptions();
}

function parseCustom(text: string): CustomPoint[] {
  const pts: CustomPoint[] = [];
  for (const line of text.split(/\n+/)) {
    const nums = line
      .split(/[,:\t]/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
    if (nums.length === 1) pts.push({ value: nums[0], weight: 1 });
    else if (nums.length === 2) pts.push({ value: nums[0], weight: nums[1] });
    else if (nums.length >= 3) pts.push({ min: nums[0], max: nums[1], weight: nums[2] });
  }
  return pts;
}

function customToText(custom: CustomPoint[]): string {
  return custom
    .map((p) =>
      p.min !== undefined && p.max !== undefined
        ? `${p.min}, ${p.max}, ${p.weight}`
        : `${p.value}, ${p.weight}`,
    )
    .join('\n');
}

function assumptionEditor(a: Assumption): HTMLElement {
  const def = getDistributionDef(a.type);
  const wrap = el('div', { class: 'editor' });

  // Distribution picker.
  const select = el('select', { class: 'dist-select' }) as HTMLSelectElement;
  for (const d of DISTRIBUTIONS) {
    const opt = el('option', { value: d.type, text: d.label }) as HTMLOptionElement;
    if (d.type === a.type) opt.selected = true;
    select.append(opt);
  }
  select.onchange = () => {
    a.type = select.value as DistributionType;
    a.params = defaultParams(a.type);
    if (a.type === 'custom' && !a.custom) a.custom = [{ value: 0, weight: 1 }];
    persist();
    renderAssumptions();
  };
  wrap.append(el('label', { class: 'field' }, ['Distribution', select]));
  wrap.append(el('div', { class: 'blurb', text: def.blurb }));

  const preview = el('canvas', { class: 'preview' }) as HTMLCanvasElement;

  const redraw = () => {
    try {
      const dist = createDistribution(a.type, a.params, a.custom);
      const err = dist.validate();
      if (err) {
        setStatus(`${a.name}: ${err}`, 'error');
      } else {
        setStatus('');
      }
      drawDistributionPreview(preview, dist);
    } catch {
      /* ignore transient invalid params */
    }
  };

  if (a.type === 'custom') {
    const ta = el('textarea', {
      class: 'custom-input',
      rows: '4',
      placeholder: 'point:  value, weight\nrange:  min, max, weight\n0, 1\n1, 2\n-0.15, -0.05, 0.25',
    }) as HTMLTextAreaElement;
    ta.value = customToText(a.custom ?? []);
    ta.oninput = () => {
      a.custom = parseCustom(ta.value);
      persist();
      redraw();
    };
    wrap.append(el('label', { class: 'field' }, ['Outcomes', ta]));
  } else {
    const grid = el('div', { class: 'param-grid' });
    for (const spec of def.params) {
      const input = el('input', {
        type: 'number',
        step: 'any',
        value: String(a.params[spec.key] ?? spec.default),
      }) as HTMLInputElement;
      input.oninput = () => {
        const v = Number(input.value);
        if (Number.isFinite(v)) {
          a.params[spec.key] = v;
          persist();
          redraw();
        }
      };
      grid.append(el('label', { class: 'field small' }, [spec.label, input]));
    }
    wrap.append(grid);
  }

  wrap.append(preview);

  // Draw after the canvas is laid out.
  requestAnimationFrame(redraw);
  return wrap;
}

function renderAssumptions(): void {
  const list = $('assumption-list');
  list.innerHTML = '';
  if (state.assumptions.length === 0) {
    list.append(el('div', { class: 'empty', text: 'No assumptions yet. Select an input cell and click “+ Assumption”.' }));
  }
  for (const a of state.assumptions) {
    const card = el('div', { class: 'card' });
    const head = el('div', { class: 'card-head' });

    const name = el('input', { class: 'name-input', value: a.name }) as HTMLInputElement;
    name.oninput = () => {
      a.name = name.value;
      persist();
    };

    const cell = el('button', { class: 'cell-chip', title: 'Go to cell', text: a.cell });
    cell.onclick = () => gotoCell(a.cell).catch(() => undefined);

    const del = el('button', { class: 'icon-btn', title: 'Delete', text: '✕' });
    del.onclick = () => deleteAssumption(a.id);

    head.append(el('span', { class: 'dot green' }), name, cell, del);
    card.append(head, assumptionEditor(a));
    list.append(card);
  }
  renderCorrelations();
}

/* ------------------------------ forecasts ------------------------------ */

async function addForecast(): Promise<void> {
  try {
    const sel = await getSelectedCell();
    if (state.forecasts.some((f) => f.cell === sel.address)) {
      setStatus(`${sel.address} is already a forecast.`, 'error');
      return;
    }
    if (state.assumptions.some((a) => a.cell === sel.address)) {
      setStatus(`${sel.address} is already an assumption.`, 'error');
      return;
    }
    const f: Forecast = { id: uid('f'), cell: sel.address, name: sel.name };
    state.forecasts.push(f);
    await markCell(sel.address, FORECAST_COLOR).catch(() => undefined);
    persist();
    renderForecasts();
    setStatus(`Added forecast on ${sel.address}.`);
  } catch (e) {
    setStatus(`Could not read selection: ${(e as Error).message}`, 'error');
  }
}

function deleteForecast(id: string): void {
  const f = state.forecasts.find((x) => x.id === id);
  state.forecasts = state.forecasts.filter((x) => x.id !== id);
  if (f) clearMark(f.cell).catch(() => undefined);
  persist();
  renderForecasts();
}

function renderForecasts(): void {
  const list = $('forecast-list');
  list.innerHTML = '';
  if (state.forecasts.length === 0) {
    list.append(el('div', { class: 'empty', text: 'No forecasts yet. Select an output cell and click “+ Forecast”.' }));
  }
  for (const f of state.forecasts) {
    const row = el('div', { class: 'row' });
    const name = el('input', { class: 'name-input', value: f.name }) as HTMLInputElement;
    name.oninput = () => {
      f.name = name.value;
      persist();
    };
    const cell = el('button', { class: 'cell-chip', title: 'Go to cell', text: f.cell });
    cell.onclick = () => gotoCell(f.cell).catch(() => undefined);
    const units = el('input', { class: 'units-input', placeholder: 'units', value: f.units ?? '' }) as HTMLInputElement;
    units.oninput = () => {
      f.units = units.value || undefined;
      persist();
    };
    const del = el('button', { class: 'icon-btn', title: 'Delete', text: '✕' });
    del.onclick = () => deleteForecast(f.id);
    row.append(el('span', { class: 'dot blue' }), name, units, cell, del);
    list.append(row);
  }
}

/* ----------------------------- correlations ---------------------------- */

function renderCorrelations(): void {
  const box = $('correlation-list');
  box.innerHTML = '';
  if (state.assumptions.length < 2) {
    box.append(el('div', { class: 'empty', text: 'Add two or more assumptions to define correlations.' }));
    return;
  }
  for (const c of state.correlations) {
    const a = state.assumptions.find((x) => x.id === c.a);
    const b = state.assumptions.find((x) => x.id === c.b);
    if (!a || !b) continue;
    const row = el('div', { class: 'row' });
    row.append(el('span', { class: 'corr-text', text: `${a.name} ↔ ${b.name}` }));
    const coef = el('input', { type: 'number', step: '0.05', min: '-1', max: '1', value: String(c.coefficient), class: 'coef-input' }) as HTMLInputElement;
    coef.oninput = () => {
      c.coefficient = Math.max(-1, Math.min(1, Number(coef.value) || 0));
      persist();
    };
    const del = el('button', { class: 'icon-btn', title: 'Remove', text: '✕' });
    del.onclick = () => {
      state.correlations = state.correlations.filter((x) => x !== c);
      persist();
      renderCorrelations();
    };
    row.append(coef, del);
    box.append(row);
  }

  // Add-pair form.
  const form = el('div', { class: 'row corr-form' });
  const selA = el('select', { class: 'mini-select' }) as HTMLSelectElement;
  const selB = el('select', { class: 'mini-select' }) as HTMLSelectElement;
  for (const a of state.assumptions) {
    selA.append(el('option', { value: a.id, text: a.name }));
    selB.append(el('option', { value: a.id, text: a.name }));
  }
  if (state.assumptions[1]) selB.value = state.assumptions[1].id;
  const coef = el('input', { type: 'number', step: '0.05', min: '-1', max: '1', value: '0.5', class: 'coef-input' }) as HTMLInputElement;
  const add = el('button', { class: 'mini-btn', text: '+ Add' });
  add.onclick = () => {
    if (selA.value === selB.value) {
      setStatus('Pick two different assumptions to correlate.', 'error');
      return;
    }
    const exists = state.correlations.some(
      (c) =>
        (c.a === selA.value && c.b === selB.value) ||
        (c.a === selB.value && c.b === selA.value),
    );
    if (exists) {
      setStatus('That pair is already correlated.', 'error');
      return;
    }
    state.correlations.push({ a: selA.value, b: selB.value, coefficient: Math.max(-1, Math.min(1, Number(coef.value) || 0)) });
    persist();
    renderCorrelations();
  };
  form.append(selA, el('span', { text: '↔' }), selB, coef, add);
  box.append(form);
}

/* -------------------------------- run ---------------------------------- */

function wireRunControls(): void {
  const trials = $('cfg-trials') as HTMLInputElement;
  trials.value = String(state.config.trials);
  trials.onchange = () => {
    state.config.trials = Math.max(1, Math.floor(Number(trials.value) || 1000));
    persist();
  };

  const sampling = $('cfg-sampling') as HTMLSelectElement;
  sampling.value = state.config.sampling;
  sampling.onchange = () => {
    state.config.sampling = sampling.value as SimulationConfig['sampling'];
    $('cfg-lhs-wrap').classList.toggle('hidden', state.config.sampling !== 'lhs');
    persist();
  };
  $('cfg-lhs-wrap').classList.toggle('hidden', state.config.sampling !== 'lhs');

  const lhs = $('cfg-lhs') as HTMLInputElement;
  lhs.value = String(state.config.lhsSampleSize);
  lhs.onchange = () => {
    state.config.lhsSampleSize = Math.max(10, Math.min(5000, Math.floor(Number(lhs.value) || 500)));
    persist();
  };

  const engine = $('cfg-engine') as HTMLSelectElement;
  engine.value = state.engine;
  engine.onchange = () => {
    state.engine = engine.value as AppState['engine'];
    persist();
  };

  const useSeed = $('cfg-useseed') as HTMLInputElement;
  useSeed.checked = state.config.useSeed;
  useSeed.onchange = () => {
    state.config.useSeed = useSeed.checked;
    $('cfg-seed').toggleAttribute('disabled', !useSeed.checked);
    persist();
  };
  const seed = $('cfg-seed') as HTMLInputElement;
  seed.value = String(state.config.seed);
  seed.disabled = !state.config.useSeed;
  seed.onchange = () => {
    state.config.seed = Math.floor(Number(seed.value) || 999);
    persist();
  };

  ($('run-btn') as HTMLButtonElement).onclick = run;
  ($('cancel-btn') as HTMLButtonElement).onclick = () => {
    cancelRequested = true;
  };
}

function showProgress(on: boolean): void {
  $('progress-wrap').classList.toggle('hidden', !on);
  ($('run-btn') as HTMLButtonElement).disabled = on;
  ($('cancel-btn') as HTMLButtonElement).classList.toggle('hidden', !on);
}

function onProgress(info: ProgressInfo): void {
  const pct = info.total ? Math.round((info.done / info.total) * 100) : 0;
  ($('progress-bar') as HTMLElement).style.width = `${pct}%`;
  $('progress-label').textContent = `${info.phase}… ${info.done.toLocaleString()} / ${info.total.toLocaleString()}`;
}

async function run(): Promise<void> {
  if (state.assumptions.length === 0) return setStatus('Add at least one assumption.', 'error');
  if (state.forecasts.length === 0) return setStatus('Add at least one forecast.', 'error');

  cancelRequested = false;
  showProgress(true);
  setStatus('');
  const started = performance.now();

  const assumptionCells = state.assumptions.map((a) => a.cell);
  const forecastCells = state.forecasts.map((f) => f.cell);

  let evaluator: ModelEvaluator;
  const preWarnings: string[] = [];
  try {
    if (state.engine === 'hf') {
      onProgress({ done: 0, total: state.config.trials, phase: 'sampling' });
      const data = await readWorkbook();
      const hf = new HyperFormulaEvaluator(data, assumptionCells, forecastCells);
      preWarnings.push(...hf.diagnostics(state.forecasts.map((f) => f.name)));
      evaluator = hf;
    } else {
      evaluator = new ExcelEvaluator(assumptionCells, forecastCells);
    }
  } catch (e) {
    showProgress(false);
    return setStatus(`Could not prepare the model: ${(e as Error).message}`, 'error');
  }

  try {
    const result = await runSimulation(
      state.assumptions,
      state.forecasts,
      state.correlations,
      state.config,
      evaluator,
      { onProgress, shouldCancel: () => cancelRequested },
    );
    result.warnings.unshift(...preWarnings);
    lastResult = result;
    selectedForecastId = result.forecasts[0]?.forecastId ?? null;
    const secs = ((performance.now() - started) / 1000).toFixed(2);
    setStatus(`Ran ${result.trials.toLocaleString()} trials in ${secs}s (${state.engine === 'hf' ? 'in-browser' : 'Excel'} engine).`);
    switchTab('results');
  } catch (e) {
    setStatus(`Run failed: ${(e as Error).message}`, 'error');
  } finally {
    evaluator.dispose();
    showProgress(false);
  }
}

/* ------------------------------ results -------------------------------- */

function statRow(label: string, value: string): HTMLElement {
  return el('div', { class: 'stat' }, [
    el('span', { class: 'stat-label', text: label }),
    el('span', { class: 'stat-value', text: value }),
  ]);
}

function renderResults(): void {
  const root = $('results-body');
  root.innerHTML = '';
  if (!lastResult) {
    root.append(el('div', { class: 'empty', text: 'Run a simulation to see forecast results here.' }));
    return;
  }

  // Meta line.
  root.append(
    el('div', { class: 'meta' }, [
      `${lastResult.trials.toLocaleString()} trials · ${lastResult.sampling === 'lhs' ? 'Latin Hypercube' : 'Monte Carlo'}` +
        (lastResult.seed !== null ? ` · seed ${lastResult.seed}` : '') +
        ` · ${lastResult.durationMs} ms`,
    ]),
  );

  for (const w of lastResult.warnings) {
    root.append(el('div', { class: 'warn', text: `⚠ ${w}` }));
  }

  // Forecast selector.
  if (lastResult.forecasts.length > 1) {
    const sel = el('select', { class: 'forecast-select' }) as HTMLSelectElement;
    for (const f of lastResult.forecasts) {
      const opt = el('option', { value: f.forecastId, text: f.name }) as HTMLOptionElement;
      if (f.forecastId === selectedForecastId) opt.selected = true;
      sel.append(opt);
    }
    sel.onchange = () => {
      selectedForecastId = sel.value;
      renderResults();
    };
    root.append(el('label', { class: 'field' }, ['Forecast', sel]));
  }

  const fc = lastResult.forecasts.find((f) => f.forecastId === selectedForecastId) ?? lastResult.forecasts[0];
  if (!fc) return;
  const unit = fc.units ? ` ${fc.units}` : '';

  // Histogram + certainty.
  root.append(el('h3', { text: `${fc.name} — Frequency` }));
  const hist = el('canvas', { class: 'chart hist' }) as HTMLCanvasElement;
  root.append(hist);

  const sorted = [...fc.values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const certWrap = el('div', { class: 'cert-wrap' });
  const certInput = el('input', { type: 'number', min: '1', max: '100', step: '1', value: '90', class: 'cert-input' }) as HTMLInputElement;
  const certOut = el('span', { class: 'cert-out' });
  const redrawHist = () => {
    const level = Math.max(1, Math.min(100, Number(certInput.value) || 90));
    const low = percentileSorted(sorted, (100 - level) / 2);
    const high = percentileSorted(sorted, 100 - (100 - level) / 2);
    drawHistogram(hist, fc.values, { certainty: [low, high], mean: fc.stats.mean });
    certOut.textContent = `${level}% certainty: ${fmt(low)} to ${fmt(high)}${unit}`;
  };
  certInput.oninput = redrawHist;
  certWrap.append(el('span', { class: 'cert-label', text: 'Certainty' }), certInput, el('span', { text: '%' }), certOut);
  root.append(certWrap);
  requestAnimationFrame(redrawHist);

  // Statistics.
  root.append(el('h3', { text: 'Statistics' }));
  const s = fc.stats;
  const grid = el('div', { class: 'stat-grid' });
  grid.append(
    statRow('Trials', s.trials.toLocaleString()),
    statRow('Mean', fmt(s.mean)),
    statRow('Median', fmt(s.median)),
    statRow('Mode', fmt(s.mode)),
    statRow('Std. Dev.', fmt(s.stdDev)),
    statRow('Variance', fmt(s.variance)),
    statRow('Skewness', fmt(s.skewness)),
    statRow('Kurtosis', fmt(s.kurtosis)),
    statRow('Coeff. of Var.', fmt(s.coeffOfVariability)),
    statRow('Minimum', fmt(s.min)),
    statRow('Maximum', fmt(s.max)),
    statRow('Range', fmt(s.range)),
    statRow('Mean Std. Err.', fmt(s.meanStdError)),
  );
  root.append(grid);

  // Percentiles.
  root.append(el('h3', { text: 'Percentiles' }));
  const pgrid = el('div', { class: 'stat-grid' });
  for (const p of fc.percentiles) pgrid.append(statRow(`${p.p}%`, fmt(p.value)));
  root.append(pgrid);

  // Sensitivity tornado.
  if (fc.sensitivity.length) {
    root.append(el('h3', { text: 'Sensitivity — Contribution to Variance' }));
    const tor = el('canvas', { class: 'chart tornado' }) as HTMLCanvasElement;
    root.append(tor);
    requestAnimationFrame(() => drawTornado(tor, fc.sensitivity));
  }
}

/* -------------------------------- init --------------------------------- */

function hydrate(): void {
  const saved = loadState<AppState>();
  if (saved) {
    state.assumptions = saved.assumptions ?? [];
    state.forecasts = saved.forecasts ?? [];
    state.correlations = saved.correlations ?? [];
    state.config = { ...DEFAULT_CONFIG, ...(saved.config ?? {}) };
    state.engine = saved.engine ?? 'hf';
  }
}

function boot(): void {
  hydrate();
  $('tab-model').onclick = () => switchTab('model');
  $('tab-run').onclick = () => switchTab('run');
  $('tab-results').onclick = () => switchTab('results');
  ($('add-assumption') as HTMLButtonElement).onclick = addAssumption;
  ($('add-forecast') as HTMLButtonElement).onclick = addForecast;
  wireRunControls();
  renderAssumptions();
  renderForecasts();
  switchTab('model');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const Office: any;
Office.onReady((info: any) => {
  if (info.host === Office.HostType.Excel) {
    boot();
  } else {
    document.body.innerHTML = '<p style="padding:16px">This add-in runs in Excel.</p>';
  }
});
