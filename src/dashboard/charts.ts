/**
 * SVG charts for the dashboard: Crystal Ball's forecast frequency chart (with
 * the certainty range shaded) and its sensitivity tornado. Colors come from
 * CSS custom properties so light/dark themes swap in one place; every mark
 * has a hover tooltip.
 */

import { CbBins } from '../engine/bins';
import { SensitivityEntry } from '../engine/model';

const SVG = 'http://www.w3.org/2000/svg';

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

export function formatNumber(v: number, units = ''): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  let s: string;
  if (a === 0) s = '0';
  else if (a < 1e-4 || a >= 1e9) s = v.toExponential(3);
  else if (a >= 10) s = v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  else if (a >= 1) s = v.toLocaleString(undefined, { maximumFractionDigits: 3 });
  else s = String(Number(v.toPrecision(4)));
  return units && units !== '%' ? (units === '$' ? `$${s}` : `${s} ${units}`) : s;
}

/** "Nice" axis ticks spanning [lo, hi]. */
function ticks(lo: number, hi: number, count = 5): number[] {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) out.push(Math.abs(t) < step * 1e-9 ? 0 : t);
  return out;
}

/** Path of a bar with 4px rounded ends away from the baseline. */
function barPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

interface Tip {
  show(html: string, evt: MouseEvent): void;
  hide(): void;
}

function tooltip(host: HTMLElement): Tip {
  let tip = host.querySelector<HTMLDivElement>('.chart-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.setAttribute('role', 'status');
    tip.hidden = true;
    host.appendChild(tip);
  }
  const t = tip;
  return {
    show(html, evt) {
      t.innerHTML = html;
      t.hidden = false;
      const box = host.getBoundingClientRect();
      const x = evt.clientX - box.left;
      const y = evt.clientY - box.top;
      t.style.left = `${Math.min(Math.max(8, x + 12), box.width - t.offsetWidth - 8)}px`;
      t.style.top = `${Math.max(4, y - t.offsetHeight - 10)}px`;
    },
    hide() {
      t.hidden = true;
    },
  };
}

export interface HistogramOptions {
  low: number;
  high: number;
  units?: string;
}

/**
 * Forecast frequency chart over Crystal Ball's bins (engine/bins.ts): columns
 * inside [low, high] in the series color, the rest recessive — Crystal Ball's
 * certainty shading.
 */
export function drawHistogram(host: HTMLElement, bins: CbBins, opts: HistogramOptions): void {
  host.querySelector('svg')?.remove();
  const width = Math.max(280, host.clientWidth || 640);
  const height = 260;
  const pad = { l: 44, r: 12, t: 10, b: 30 };
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img' });
  svg.setAttribute('aria-label', `Frequency chart of ${bins.total} trials, ${bins.displayed} displayed`);
  host.prepend(svg);
  if (!bins.counts.length) return;

  const { min: lo, max: hi, counts, width: bw, total } = bins;
  const nb = counts.length;
  const span = hi - lo || 1;
  const maxC = Math.max(1, ...counts);
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const x = (v: number) => pad.l + ((v - lo) / span) * plotW;
  const y = (c: number) => pad.t + plotH - (c / maxC) * plotH;

  const grid = el('g', { class: 'grid' });
  for (const t of ticks(0, maxC / total, 4)) {
    const yy = pad.t + plotH - (t * total * plotH) / maxC;
    if (yy < pad.t - 1) continue;
    grid.appendChild(el('line', { x1: pad.l, x2: width - pad.r, y1: yy, y2: yy }));
    const lab = el('text', { x: pad.l - 6, y: yy + 4, class: 'tick', 'text-anchor': 'end' });
    lab.textContent = t === 0 ? '0%' : `${(t * 100).toFixed(t < 0.01 ? 1 : 0)}%`;
    grid.appendChild(lab);
  }
  svg.appendChild(grid);

  const tip = tooltip(host);
  const bars = el('g', {});
  const colW = plotW / nb;
  const gap = colW > 6 ? 2 : colW > 3 ? 1 : 0;
  counts.forEach((c, i) => {
    const b0 = lo + i * bw;
    const b1 = b0 + bw;
    const inside = b1 > opts.low && b0 < opts.high;
    const bx = pad.l + i * colW + gap / 2;
    const bwPx = Math.max(1, colW - gap);
    if (c > 0) {
      bars.appendChild(
        el('path', { d: barPath(bx, y(c), bwPx, pad.t + plotH - y(c), colW > 8 ? 4 : 1), class: inside ? 'bar in' : 'bar out' }),
      );
    }
    // A full-height hit target, larger than the mark.
    const hit = el('rect', { x: pad.l + i * colW, y: pad.t, width: colW, height: plotH, class: 'hit' });
    const label = bins.discrete && bw === 1 ? formatNumber(b0 + 0.5, opts.units) : `${formatNumber(b0, opts.units)} – ${formatNumber(b1, opts.units)}`;
    hit.addEventListener('mousemove', (evt) =>
      tip.show(`<b>${label}</b><br>${c} trials · ${((100 * c) / total).toFixed(2)}%`, evt),
    );
    hit.addEventListener('mouseleave', () => tip.hide());
    bars.appendChild(hit);
  });
  svg.appendChild(bars);

  const axis = el('g', { class: 'axis' });
  axis.appendChild(el('line', { x1: pad.l, x2: width - pad.r, y1: pad.t + plotH, y2: pad.t + plotH }));
  for (const t of ticks(lo, hi, Math.max(3, Math.floor(plotW / 110)))) {
    const xx = x(t);
    if (xx < pad.l - 1 || xx > width - pad.r + 1) continue;
    axis.appendChild(el('line', { x1: xx, x2: xx, y1: pad.t + plotH, y2: pad.t + plotH + 4 }));
    const lab = el('text', { x: xx, y: height - 10, class: 'tick', 'text-anchor': 'middle' });
    lab.textContent = formatNumber(t, opts.units);
    axis.appendChild(lab);
  }
  // Certainty grabbers at the range ends, like Crystal Ball's triangles.
  for (const edge of [opts.low, opts.high]) {
    if (!Number.isFinite(edge) || edge < lo || edge > hi) continue;
    const xx = x(edge);
    axis.appendChild(el('line', { x1: xx, x2: xx, y1: pad.t, y2: pad.t + plotH, class: 'edge' }));
  }
  svg.appendChild(axis);
}

/**
 * Sensitivity tornado: contribution to variance, positive drivers in one pole
 * of the diverging pair and negative in the other, labelled with names and
 * percentages (never color alone).
 */
export function drawTornado(host: HTMLElement, entries: SensitivityEntry[], max = 12): void {
  host.querySelector('svg')?.remove();
  const shown = entries.filter((e) => Number.isFinite(e.contribution)).slice(0, max);
  const width = Math.max(280, host.clientWidth || 640);
  const rowH = 26;
  const labelW = Math.min(240, Math.round(width * 0.36));
  const height = shown.length * rowH + 30;
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img' });
  svg.setAttribute('aria-label', 'Contribution to variance by assumption');
  host.prepend(svg);
  if (!shown.length) return;
  const zero = labelW + (width - labelW - 60) / 2;
  const half = (width - labelW - 60) / 2;
  const maxAbs = Math.max(...shown.map((e) => Math.abs(e.contribution)), 1e-9);
  const tip = tooltip(host);

  svg.appendChild(el('line', { x1: zero, x2: zero, y1: 4, y2: height - 22, class: 'baseline' }));
  shown.forEach((e, i) => {
    const yy = 6 + i * rowH;
    const w = (Math.abs(e.contribution) / maxAbs) * half;
    const neg = e.contribution < 0;
    const name = el('text', { x: labelW - 8, y: yy + rowH / 2 + 1, class: 'label', 'text-anchor': 'end' });
    const budget = Math.max(8, Math.floor((labelW - 12) / 6.4));
    name.textContent = e.name.length > budget ? `${e.name.slice(0, budget - 1)}…` : e.name;
    svg.appendChild(name);
    const bx = neg ? zero - w : zero;
    if (w > 0.5) {
      const r = Math.min(4, w / 2);
      const h = rowH - 8;
      const d = neg
        ? `M${zero},${yy + 4}H${bx + r}Q${bx},${yy + 4} ${bx},${yy + 4 + r}V${yy + 4 + h - r}Q${bx},${yy + 4 + h} ${bx + r},${yy + 4 + h}H${zero}Z`
        : `M${zero},${yy + 4}H${bx + w - r}Q${bx + w},${yy + 4} ${bx + w},${yy + 4 + r}V${yy + 4 + h - r}Q${bx + w},${yy + 4 + h} ${bx + w - r},${yy + 4 + h}H${zero}Z`;
      svg.appendChild(el('path', { d, class: neg ? 'bar neg' : 'bar pos' }));
    }
    // A short negative bar leaves no room for its value before the names, so
    // that value goes on the other side of the zero line.
    const flip = neg && bx - labelW < 44;
    const val = el('text', {
      x: neg && !flip ? bx - 6 : flip ? zero + 6 : bx + w + 6,
      y: yy + rowH / 2 + 1,
      class: 'value',
      'text-anchor': neg && !flip ? 'end' : 'start',
    });
    val.textContent = `${e.contribution.toFixed(1)}%`;
    svg.appendChild(val);
    const hit = el('rect', { x: 0, y: yy, width, height: rowH, class: 'hit' });
    hit.addEventListener('mousemove', (evt) =>
      tip.show(
        `<b>${e.name}</b><br>Contribution to variance ${e.contribution.toFixed(2)}%<br>Rank correlation ${Number.isFinite(e.rankCorrelation) ? e.rankCorrelation.toFixed(3) : '—'}`,
        evt,
      ),
    );
    hit.addEventListener('mouseleave', () => tip.hide());
    svg.appendChild(hit);
  });
  const note = el('text', { x: zero, y: height - 6, class: 'tick', 'text-anchor': 'middle' });
  note.textContent = entries.length > max ? `Top ${max} of ${entries.length} assumptions` : 'Contribution to variance';
  svg.appendChild(note);
}
