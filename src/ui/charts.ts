/**
 * Lightweight canvas charts — no charting dependency. Three charts cover the
 * Crystal Ball views we reproduce: a distribution preview (the assumption
 * dialog's live curve), a forecast frequency histogram with a shaded certainty
 * band, and a sensitivity tornado.
 */

import { Distribution } from '../engine/distributions';
import { SensitivityEntry } from '../engine/model';

const AXIS = '#9aa4b2';
const TEXT = '#44505f';
const BAR = '#2e7cd6';
const BAR_SOFT = '#bcd6f2';
const BAND = 'rgba(46, 124, 214, 0.28)';
const POS = '#2e7cd6';
const NEG = '#e08a2e';
const MEAN = '#c0392b';
const GREEN = '#3c9a5f';

interface Ctx {
  ctx: CanvasRenderingContext2D;
  w: number;
  h: number;
}

/** Size the backing store for the device pixel ratio and return a context. */
function prep(canvas: HTMLCanvasElement): Ctx {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 280;
  const h = canvas.clientHeight || 140;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function niceNum(v: number): string {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(2);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

/** Live preview of an assumption's probability curve. */
export function drawDistributionPreview(canvas: HTMLCanvasElement, dist: Distribution): void {
  const { ctx, w, h } = prep(canvas);
  const padL = 6;
  const padR = 6;
  const padB = 16;
  const padT = 8;
  const [lo, hi] = dist.plotRange();
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const xOf = (x: number) => padL + ((x - lo) / (hi - lo || 1)) * plotW;

  if (dist.discrete) {
    const xs: number[] = [];
    for (let x = Math.ceil(lo); x <= Math.floor(hi); x++) xs.push(x);
    const dens = xs.map((x) => dist.density(x));
    const maxD = Math.max(...dens, 1e-9);
    const bw = Math.max(2, (plotW / Math.max(xs.length, 1)) * 0.6);
    ctx.fillStyle = BAR;
    xs.forEach((x, i) => {
      const bh = (dens[i] / maxD) * plotH;
      ctx.fillRect(xOf(x) - bw / 2, padT + plotH - bh, bw, bh);
    });
  } else {
    const N = 160;
    const pts: [number, number][] = [];
    let maxD = 1e-9;
    for (let i = 0; i <= N; i++) {
      const x = lo + ((hi - lo) * i) / N;
      const d = dist.density(x);
      if (Number.isFinite(d)) {
        maxD = Math.max(maxD, d);
        pts.push([x, d]);
      }
    }
    ctx.beginPath();
    ctx.moveTo(padL, padT + plotH);
    for (const [x, d] of pts) ctx.lineTo(xOf(x), padT + plotH - (d / maxD) * plotH);
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.closePath();
    ctx.fillStyle = BAR_SOFT;
    ctx.fill();
    ctx.beginPath();
    pts.forEach(([x, d], i) => {
      const px = xOf(x);
      const py = padT + plotH - (d / maxD) * plotH;
      i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
    });
    ctx.strokeStyle = BAR;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Baseline + end labels.
  ctx.strokeStyle = AXIS;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT + plotH + 0.5);
  ctx.lineTo(padL + plotW, padT + plotH + 0.5);
  ctx.stroke();
  ctx.fillStyle = TEXT;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(niceNum(lo), padL, padT + plotH + 3);
  ctx.textAlign = 'right';
  ctx.fillText(niceNum(hi), padL + plotW, padT + plotH + 3);
}

export interface HistogramOptions {
  bins?: number;
  certainty?: [number, number]; // shade values within this range
  mean?: number;
}

/** Forecast frequency histogram with an optional shaded certainty band. */
export function drawHistogram(
  canvas: HTMLCanvasElement,
  values: number[],
  options: HistogramOptions = {},
): void {
  const { ctx, w, h } = prep(canvas);
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return;

  const padL = 8;
  const padR = 8;
  const padB = 18;
  const padT = 8;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  let lo = Math.min(...clean);
  let hi = Math.max(...clean);
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }
  const bins = options.bins ?? Math.min(Math.max(Math.round(Math.sqrt(clean.length)), 16), 60);
  const width = (hi - lo) / bins;
  const counts = new Array<number>(bins).fill(0);
  for (const v of clean) {
    let b = Math.floor((v - lo) / width);
    if (b < 0) b = 0;
    if (b >= bins) b = bins - 1;
    counts[b]++;
  }
  const maxC = Math.max(...counts, 1);
  const xOf = (x: number) => padL + ((x - lo) / (hi - lo)) * plotW;

  const [cLow, cHigh] = options.certainty ?? [lo - 1, hi + 1];
  for (let i = 0; i < bins; i++) {
    const bx = lo + i * width;
    const inBand = bx + width / 2 >= cLow && bx + width / 2 <= cHigh;
    const bh = (counts[i] / maxC) * plotH;
    ctx.fillStyle = inBand ? BAR : BAR_SOFT;
    ctx.fillRect(xOf(bx) + 0.5, padT + plotH - bh, Math.max(1, plotW / bins - 1), bh);
  }

  if (options.certainty) {
    ctx.fillStyle = BAND;
    ctx.fillRect(xOf(Math.max(cLow, lo)), padT, xOf(Math.min(cHigh, hi)) - xOf(Math.max(cLow, lo)), plotH);
  }

  if (options.mean !== undefined && Number.isFinite(options.mean)) {
    const mx = xOf(options.mean);
    ctx.strokeStyle = MEAN;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(mx, padT);
    ctx.lineTo(mx, padT + plotH);
    ctx.stroke();
  }

  ctx.strokeStyle = AXIS;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT + plotH + 0.5);
  ctx.lineTo(padL + plotW, padT + plotH + 0.5);
  ctx.stroke();
  ctx.fillStyle = TEXT;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(niceNum(lo), padL, padT + plotH + 4);
  ctx.textAlign = 'right';
  ctx.fillText(niceNum(hi), padL + plotW, padT + plotH + 4);
}

/** Sensitivity tornado — signed contribution bars, sorted by magnitude. */
export function drawTornado(canvas: HTMLCanvasElement, entries: SensitivityEntry[]): void {
  const top = entries.slice(0, 10);
  const rowH = 22;
  const gap = 6;
  const neededH = top.length * (rowH + gap) + 8;
  canvas.style.height = `${neededH}px`;
  const { ctx, w, h } = prep(canvas);

  const labelW = Math.min(110, w * 0.4);
  const valW = 42;
  const barAreaX = labelW + 6;
  const barAreaW = w - barAreaX - valW - 6;
  const maxMag = Math.max(...top.map((e) => Math.abs(e.contribution)), 1);

  ctx.font = '11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';

  top.forEach((e, i) => {
    const y = 6 + i * (rowH + gap) + rowH / 2;
    // name
    ctx.fillStyle = TEXT;
    ctx.textAlign = 'left';
    const name = e.name.length > 16 ? e.name.slice(0, 15) + '…' : e.name;
    ctx.fillText(name, 0, y);
    // bar
    const bw = (Math.abs(e.contribution) / maxMag) * barAreaW;
    ctx.fillStyle = e.contribution >= 0 ? POS : NEG;
    ctx.fillRect(barAreaX, y - rowH / 2 + 3, Math.max(2, bw), rowH - 6);
    // value
    ctx.fillStyle = TEXT;
    ctx.textAlign = 'right';
    ctx.fillText(`${e.contribution >= 0 ? '' : '−'}${Math.abs(e.contribution).toFixed(1)}%`, w, y);
  });

  void h;
  void GREEN;
}
