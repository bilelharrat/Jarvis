// Charts from a range of the spreadsheet canvas (ROADMAP Q15), drawn as inline SVG text (no
// library, no scripts): bar (grouped columns), line and pie. The range's first column holds the
// labels and its first row the series names (when it's text). Every value is escaped; each mark has
// a <title> (the hover tooltip). Colours: the validated categorical palette (dataviz reference
// instance, light surface), in fixed order; the chart sits on its own white card, in the canvas and
// in the .xlsx picture alike. Text wears ink colours, never the series colour; ≥2 series get a legend.

import { a1, parseRange, valueOf, formatValue, toText, isErr } from './sheet-model.mjs';

export const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const INK = '#1d1d1f', INK2 = '#5f5f66', GRID = '#e6e6ea';
export const MAX_POINTS = 200;
export const MAX_SERIES = 8;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The chart's data from the sheet: { labels, series: [{ name, values, z }], cut } or { error }. */
export function chartData(sheet, range, calc) {
  const r = typeof range === 'string' ? parseRange(range) : range;
  if (!r) return { error: 'That isn’t a range.' };
  const width = r.c2 - r.c1 + 1, height = r.r2 - r.r1 + 1;
  if (width < 1 || height < 1) return { error: 'The range is empty.' };
  const at = (row, col) => valueOf(sheet, a1(row, col), calc);
  const textish = (v) => typeof v === 'string' && v.trim() !== '' && !isFinite(Number(v));
  // a header row when the first row's value cells are text
  const header = height > 1 && Array.from({ length: Math.max(1, width - 1) }, (_, k) => at(r.r1, r.c1 + (width > 1 ? 1 : 0) + k)).every((v) => textish(v) || v === null);
  const labelsCol = width > 1;
  const first = r.r1 + (header ? 1 : 0);
  const rows = Math.min(r.r2 - first + 1, MAX_POINTS);
  const labels = [];
  for (let i = 0; i < rows; i++) labels.push(labelsCol ? toText(formatOrRaw(sheet, first + i, r.c1, calc)) : String(i + 1));
  const series = [];
  for (let c = r.c1 + (labelsCol ? 1 : 0); c <= r.c2 && series.length < MAX_SERIES; c++) {
    const values = [];
    for (let i = 0; i < rows; i++) { const v = at(first + i, c); values.push(typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && isFinite(Number(v)) ? Number(v) : null); }
    if (values.every((v) => v === null)) continue;
    const cell = sheet.cells[a1(first, c)];
    series.push({ name: header ? toText(at(r.r1, c)) || `Series ${series.length + 1}` : `Series ${series.length + 1}`, values, z: cell && cell.z });
  }
  if (!series.length) return { error: 'There are no numbers in that range to chart.' };
  return { labels, series, cut: r.r2 - first + 1 > MAX_POINTS || (r.c2 - r.c1) > MAX_SERIES };
}
function formatOrRaw(sheet, row, col, calc) {
  const v = valueOf(sheet, a1(row, col), calc);
  const cell = sheet.cells[a1(row, col)];
  return isErr(v) ? v.message : formatValue(v, cell && cell.z);
}

function niceTicks(min, max, n = 5) {
  if (min === max) { max = min + 1; min = Math.min(0, min); }
  const span = max - min;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) || 10 * mag;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  return { lo, hi, ticks };
}
const short = (v, z) => {
  if (z && !/^General$/i.test(z)) return formatValue(v, z);
  const a = Math.abs(v);
  return a >= 1e9 ? `${+(v / 1e9).toFixed(1)}B` : a >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : a >= 1e4 ? `${+(v / 1e3).toFixed(1)}K` : formatValue(v, null);
};

/** The SVG text for a chart { type: bar|line|pie, title } over chartData(). */
export function chartSvg(data, { type = 'bar', title = '', width = 560, height = 320 } = {}) {
  if (data.error) return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="80" viewBox="0 0 ${width} 80" role="img"><rect width="100%" height="100%" rx="10" fill="#fff"/><text x="16" y="44" font-family="-apple-system,Helvetica,sans-serif" font-size="13" fill="${INK2}">${esc(globalThis.edenI18n ? globalThis.edenI18n.t(data.error) : data.error)}</text></svg>`; // the French when the page is in French (no import: tests load this file alone)
  const font = 'font-family="-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif"';
  const parts = [];
  const top = title ? 40 : 18;
  const multi = data.series.length > 1;
  const legendH = multi && type !== 'pie' ? 24 : 0;
  parts.push(`<rect width="${width}" height="${height}" rx="10" fill="#ffffff"/>`);
  if (title) parts.push(`<text x="16" y="26" ${font} font-size="14" font-weight="600" fill="${INK}">${esc(clip(title, 70))}</text>`);
  if (type === 'pie') return wrap(parts.concat(pie(data, { width, height, top, font })), width, height, title);
  const left = 56, right = 16, bottom = 40 + legendH;
  const pw = width - left - right, ph = height - top - bottom;
  const all = data.series.flatMap((s) => s.values).filter((v) => v !== null);
  const { lo, hi, ticks } = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
  const y = (v) => top + ph - ((v - lo) / (hi - lo)) * ph;
  const z = data.series[0].z;
  for (const t of ticks) {
    parts.push(`<line x1="${left}" x2="${width - right}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" stroke="${t === 0 ? '#c7c7cc' : GRID}" stroke-width="1"/>`);
    parts.push(`<text x="${left - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end" ${font} font-size="11" fill="${INK2}">${esc(short(t, z))}</text>`);
  }
  const n = data.labels.length;
  const band = pw / n;
  const every = Math.max(1, Math.ceil(n / Math.floor(pw / 56)));
  data.labels.forEach((l, i) => {
    if (i % every) return;
    parts.push(`<text x="${(left + band * (i + 0.5)).toFixed(1)}" y="${top + ph + 18}" text-anchor="middle" ${font} font-size="11" fill="${INK2}">${esc(clip(l, Math.max(4, Math.floor((band * every) / 7))))}</text>`);
  });
  if (type === 'line') {
    data.series.forEach((s, k) => {
      const color = PALETTE[k % PALETTE.length];
      let d = '';
      s.values.forEach((v, i) => { if (v === null) return; d += `${d && s.values[i - 1] !== null ? 'L' : 'M'}${(left + band * (i + 0.5)).toFixed(1)},${y(v).toFixed(1)}`; });
      parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
      s.values.forEach((v, i) => { if (v === null) return; parts.push(`<circle cx="${(left + band * (i + 0.5)).toFixed(1)}" cy="${y(v).toFixed(1)}" r="${n > 40 ? 2 : 4}" fill="${color}" stroke="#fff" stroke-width="2"><title>${esc(`${data.labels[i]} · ${s.name}: ${formatValue(v, s.z)}`)}</title></circle>`); });
    });
  } else {
    const groups = data.series.length;
    const inner = band * 0.72;
    const bw = Math.max(1, (inner - (groups - 1) * 2) / groups);
    data.series.forEach((s, k) => {
      const color = PALETTE[k % PALETTE.length];
      s.values.forEach((v, i) => {
        if (v === null) return;
        const x = left + band * i + (band - inner) / 2 + k * (bw + 2);
        const y0 = y(Math.max(0, lo)), y1 = y(v);
        const h = Math.abs(y0 - y1), yt = Math.min(y0, y1);
        const rad = Math.min(4, bw / 2, h);
        // rounded at the data end, square at the baseline
        const path = v >= 0
          ? `M${x.toFixed(1)},${(yt + h).toFixed(1)}V${(yt + rad).toFixed(1)}Q${x.toFixed(1)},${yt.toFixed(1)} ${(x + rad).toFixed(1)},${yt.toFixed(1)}H${(x + bw - rad).toFixed(1)}Q${(x + bw).toFixed(1)},${yt.toFixed(1)} ${(x + bw).toFixed(1)},${(yt + rad).toFixed(1)}V${(yt + h).toFixed(1)}Z`
          : `M${x.toFixed(1)},${yt.toFixed(1)}V${(yt + h - rad).toFixed(1)}Q${x.toFixed(1)},${(yt + h).toFixed(1)} ${(x + rad).toFixed(1)},${(yt + h).toFixed(1)}H${(x + bw - rad).toFixed(1)}Q${(x + bw).toFixed(1)},${(yt + h).toFixed(1)} ${(x + bw).toFixed(1)},${(yt + h - rad).toFixed(1)}V${yt.toFixed(1)}Z`;
        parts.push(`<path d="${path}" fill="${color}"><title>${esc(`${data.labels[i]}${multi ? ` · ${s.name}` : ''}: ${formatValue(v, s.z)}`)}</title></path>`);
      });
    });
  }
  if (multi) {
    let x = left;
    const ly = height - 14;
    data.series.forEach((s, k) => {
      const name = clip(s.name, 22);
      parts.push(`<rect x="${x}" y="${ly - 9}" width="10" height="10" rx="2" fill="${PALETTE[k % PALETTE.length]}"/><text x="${x + 14}" y="${ly}" ${font} font-size="11" fill="${INK}">${esc(name)}</text>`);
      x += 24 + name.length * 6.5;
    });
  }
  return wrap(parts, width, height, title);
}

function pie(data, { width, height, top, font }) {
  const s = data.series[0];
  const items = s.values.map((v, i) => ({ v: v && v > 0 ? v : 0, label: data.labels[i] })).filter((x) => x.v > 0);
  const total = items.reduce((a, b) => a + b.v, 0);
  if (!total) return [`<text x="16" y="${top + 24}" ${font} font-size="13" fill="${INK2}">Nothing above zero to show as a pie.</text>`];
  // 8 slices at most: the rest fold into "Other" (colours never cycle)
  items.sort((a, b) => b.v - a.v);
  const shown = items.length > 8 ? [...items.slice(0, 7), { v: items.slice(7).reduce((a, b) => a + b.v, 0), label: 'Other' }] : items;
  const cx = Math.min(width * 0.32, (height - top) / 2 + 20), cy = top + (height - top - 16) / 2, r = Math.min(cx - 20, (height - top - 24) / 2);
  const out = [];
  let a0 = -Math.PI / 2;
  shown.forEach((it, k) => {
    const a1 = a0 + (it.v / total) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (a) => `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
    const d = shown.length === 1 ? `M${cx - r},${cy}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0Z` : `M${cx},${cy}L${p(a0)}A${r},${r} 0 ${large},1 ${p(a1)}Z`;
    out.push(`<path d="${d}" fill="${PALETTE[k]}" stroke="#fff" stroke-width="2"><title>${esc(`${it.label}: ${formatValue(it.v, s.z)} (${Math.round((it.v / total) * 100)}%)`)}</title></path>`);
    const ly = top + 8 + k * 20;
    out.push(`<rect x="${cx + r + 28}" y="${ly}" width="10" height="10" rx="2" fill="${PALETTE[k]}"/><text x="${cx + r + 44}" y="${ly + 9}" ${font} font-size="12" fill="${INK}">${esc(clip(it.label, 24))} <tspan fill="${INK2}">${Math.round((it.v / total) * 100)}%</tspan></text>`);
    a0 = a1;
  });
  return out;
}

const wrap = (parts, width, height, title) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(title || 'Chart')}">${parts.join('')}</svg>`;
