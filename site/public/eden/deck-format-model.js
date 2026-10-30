// Everyday editing for Eden Slides (web only): a chart's data and look, table editing, slide backgrounds, and slide
// numbers with a footer. Pure: no DOM. deck-model.js keeps these fields when it cleans a deck (chartStyle,
// tableStyle, normalizeBackground, normalizeFooter), deck-format-draw.js draws them in the frame and the .pptx,
// deck-format.js is the editor's panels. Tested in src/__tests__/deck-format.test.ts.
//
//   slide.chart  += { colors?: [#hex|''], axisTitle?, catTitle?, legend?: bool, dataLabels?: bool }
//                   colors line up with the series (bar, line, area) or the labels (pie, doughnut)
//   slide.table  += { style?: 'plain'|'lines'|'zebra'|'grid' (absent: the theme's), align?: ['left'|'center'|'right'] }
//                   header row off = no `header` (its cells become the first row)
//   slide.background = { kind: 'color', color } | { kind: 'gradient', from, to, angle } | { kind: 'image', image, dim, blur }
//   deck.footer  = { number?: true, text?, date?: true, dateText?, hideOnTitle?: true }   (absent: Eden's usual foot)

import { text, LIMITS, CHART_TYPES, imageId, normalizeSlide } from './deck-model.js';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const clone = (d) => JSON.parse(JSON.stringify(d));
export const hexColor = (v) => (typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v.trim()) ? `#${v.trim().replace('#', '').toLowerCase()}` : '');
const clampNum = (v, lo, hi, d) => { const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };

export const TABLE_STYLES = ['theme', 'plain', 'lines', 'zebra', 'grid'];
export const TABLE_STYLE_LABELS = { theme: 'Theme', plain: 'Plain', lines: 'Lines', zebra: 'Stripes', grid: 'Grid' };
export const ALIGNS = ['left', 'center', 'right'];
export const CHART_LABELS = { bar: 'Bar', hbar: 'Horizontal bar', line: 'Line', area: 'Area', pie: 'Pie', doughnut: 'Doughnut' };
export const BG_KINDS = ['theme', 'color', 'gradient', 'image'];
export const BG_MAX_DIM = 0.8, BG_MAX_BLUR = 24;

// ── cleaning (deck-model.js calls these, so a deck read back from storage or a model keeps only these shapes) ──

/** A chart's look, cleaned: only the fields that differ from Eden's defaults. */
export function chartStyle(c, count) {
  if (!isObj(c)) return {};
  const out = {};
  if (Array.isArray(c.colors)) { const cs = c.colors.slice(0, Math.max(0, count)).map((x) => hexColor(x)); if (cs.some(Boolean)) out.colors = cs; }
  const at = text(c.axisTitle, 60); if (at) out.axisTitle = at;
  const ct = text(c.catTitle, 60); if (ct) out.catTitle = ct;
  if (typeof c.legend === 'boolean') out.legend = c.legend;
  if (typeof c.dataLabels === 'boolean') out.dataLabels = c.dataLabels;
  return out;
}

/** A table's style and column alignment, cleaned (`cols` columns). */
export function tableStyle(t, cols) {
  if (!isObj(t)) return {};
  const out = {};
  if (TABLE_STYLES.includes(t.style) && t.style !== 'theme') out.style = t.style;
  if (Array.isArray(t.align)) { const a = Array.from({ length: cols }, (_, i) => (ALIGNS.includes(t.align[i]) ? t.align[i] : 'left')); if (a.some((x) => x !== 'left')) out.align = a; }
  return out;
}

/** A slide's background, cleaned; null for the theme's own. */
export function normalizeBackground(b) {
  if (!isObj(b)) return null;
  if (b.kind === 'color') { const color = hexColor(b.color); return color ? { kind: 'color', color } : null; }
  if (b.kind === 'gradient') {
    const from = hexColor(b.from), to = hexColor(b.to);
    return from && to ? { kind: 'gradient', from, to, angle: ((Math.round(clampNum(b.angle, -3600, 3600, 135)) % 360) + 360) % 360 } : null;
  }
  if (b.kind === 'image') {
    const image = imageId(b.image);
    return image ? { kind: 'image', image, dim: Math.round(clampNum(b.dim, 0, BG_MAX_DIM, 0) * 100) / 100, blur: Math.round(clampNum(b.blur, 0, BG_MAX_BLUR, 0)) } : null;
  }
  return null;
}

/** The deck's slide numbers and footer, cleaned; null when it was never set (Eden's usual foot). */
export function normalizeFooter(f) {
  if (!isObj(f)) return null;
  const out = {};
  if (f.number === true) out.number = true;
  const t = text(f.text, 120); if (t) out.text = t;
  if (f.date === true) out.date = true;
  const dt = text(f.dateText, 40); if (dt && out.date) out.dateText = dt;
  if (f.hideOnTitle === true) out.hideOnTitle = true;
  return out; // {} = everything off (unlike absent)
}

// ── charts ──

/** A starting chart for a slide that has none. */
export const sampleChart = () => ({ type: 'bar', labels: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: 'Series 1', values: [12, 19, 15, 24] }], unit: '', source: '' });

/** The deck with slide i's chart replaced by `chart` (cleaned; the slide shows it as a chart). */
export function setChart(deck, i, chart) {
  const s = deck.slides[i];
  if (!s || !isObj(chart)) return deck;
  const d = clone(deck);
  const next = normalizeSlide({ ...d.slides[i], chart, layout: 'chart' });
  if (!next || !next.chart) return deck;
  d.slides[i] = next;
  return d;
}

const blankSeriesName = (c) => `Series ${c.series.length + 1}`;
/** Chart grid edits: each returns a new chart (not yet cleaned) within LIMITS.labels × LIMITS.series. */
export function chartAddRow(c, at = c.labels.length) {
  if (c.labels.length >= LIMITS.labels) return c;
  const k = Math.max(0, Math.min(c.labels.length, at));
  const labels = [...c.labels]; labels.splice(k, 0, `Item ${c.labels.length + 1}`);
  return { ...c, labels, series: c.series.map((s) => { const v = [...s.values]; v.splice(k, 0, 0); return { ...s, values: v }; }) };
}
export function chartRemoveRow(c, at) {
  if (c.labels.length <= 1 || at < 0 || at >= c.labels.length) return c;
  const pie = c.type === 'pie' || c.type === 'doughnut';
  const colors = pie && c.colors ? c.colors.filter((_, j) => j !== at) : c.colors;
  return { ...c, labels: c.labels.filter((_, j) => j !== at), series: c.series.map((s) => ({ ...s, values: s.values.filter((_, j) => j !== at) })), ...(colors ? { colors } : {}) };
}
export function chartAddSeries(c) {
  if (c.series.length >= LIMITS.series || c.type === 'pie' || c.type === 'doughnut') return c;
  return { ...c, series: [...c.series, { name: blankSeriesName(c), values: c.labels.map(() => 0) }] };
}
export function chartRemoveSeries(c, at) {
  if (c.series.length <= 1 || at < 0 || at >= c.series.length) return c;
  const pie = c.type === 'pie' || c.type === 'doughnut';
  const colors = !pie && c.colors ? c.colors.filter((_, j) => j !== at) : c.colors;
  return { ...c, series: c.series.filter((_, j) => j !== at), ...(colors ? { colors } : {}) };
}
/** Set one cell: row -1 is the series names, column -1 the labels. */
export function chartSetCell(c, row, col, value) {
  const out = { ...c, labels: [...c.labels], series: c.series.map((s) => ({ ...s, values: [...s.values] })) };
  if (row === -1 && out.series[col]) out.series[col].name = text(value, 60);
  else if (col === -1 && row >= 0 && row < out.labels.length) out.labels[row] = text(value, 60);
  else if (out.series[col] && row >= 0 && row < out.labels.length) out.series[col].values[row] = cellNumber(value) ?? 0;
  return out;
}
export function chartSetType(c, type) { return CHART_TYPES.includes(type) ? { ...c, type } : c; }
/** A colour for series (or slice) j: '' goes back to the theme's. */
export function chartSetColor(c, j, color) {
  const pie = c.type === 'pie' || c.type === 'doughnut';
  const n = pie ? c.labels.length : c.series.length;
  if (j < 0 || j >= n) return c;
  const colors = Array.from({ length: n }, (_, k) => (c.colors && c.colors[k]) || '');
  colors[j] = hexColor(color);
  return { ...c, colors };
}

/** A number as people paste it: "1,234", "12%", "$5.50", "€ 3", "(7)" (negative), "−2" — else null. */
export function cellNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.trim().replace(/[−–]/g, '-').replace(/[\s  ]/g, '');
  const neg = /^\(.*\)$/.test(s);
  s = s.replace(/^\((.*)\)$/, '$1').replace(/^[$€£¥]|[$€£¥%]$/g, '').replace(/^([-+])[$€£¥]/, '$1');
  if (/^-?\d{1,3}(\.\d{3}){2,}(,\d+)?$|^-?\d{1,3}(\.\d{3})+,\d+$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); // 1.234.567 or 1.234,5 (European)
  else if (/^-?\d+,\d{1,2}$/.test(s)) s = s.replace(',', '.'); // 3,5
  else s = s.replace(/,(?=\d{3}(\D|$))/g, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -Math.abs(n) : n) : null;
}

/**
 * Tab-separated text as Excel, Numbers and Google Sheets copy it: rows of cells. Quoted cells may hold tabs,
 * newlines and "" for a quote. At most `maxRows` × `maxCols`, each cell at most 400 characters.
 */
export function parseTsv(src, { maxRows = 200, maxCols = 40 } = {}) {
  const s = String(src ?? '').slice(0, 200_000).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (!s.trim()) return [];
  const rows = [];
  let row = [], cell = '', q = false, i = 0;
  const push = () => { row.push(cell.slice(0, 400)); cell = ''; };
  while (i < s.length) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cell += '"'; i += 2; continue; }
      if (ch === '"') { q = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === '') { q = true; i++; continue; }
    if (ch === '\t') { push(); i++; continue; }
    if (ch === '\n') { push(); rows.push(row); row = []; i++; if (rows.length >= maxRows) break; continue; }
    cell += ch; i++;
  }
  if (rows.length < maxRows && (cell !== '' || row.length)) { push(); rows.push(row); }
  return rows.map((r) => r.slice(0, maxCols));
}
/** Rows as tab-separated text (for copying a grid back out). */
export const toTsv = (rows) => rows.map((r) => r.map((c) => { const s = String(c ?? ''); return /[\t\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join('\t')).join('\n');

/**
 * A chart from pasted rows. The first column is the labels; the first row is the series names when its cells
 * (after the first) aren't numbers. Keeps the chart's type and look. → the chart, or null when nothing is numeric.
 */
export function chartFromRows(rows, base = sampleChart()) {
  const rs = rows.filter((r) => r.some((x) => String(x).trim()));
  if (!rs.length) return null;
  const width = Math.max(...rs.map((r) => r.length));
  if (width < 2) { // one column of numbers
    const vals = rs.map((r) => cellNumber(r[0]));
    if (vals.every((v) => v === null)) return null;
    return { ...base, labels: vals.map((_, i) => `Item ${i + 1}`).slice(0, LIMITS.labels), series: [{ name: base.series[0]?.name || 'Series 1', values: vals.map((v) => v ?? 0).slice(0, LIMITS.labels) }] };
  }
  const head = rs.length > 1 && rs[0].slice(1).some((x) => String(x).trim() && cellNumber(x) === null);
  const body = (head ? rs.slice(1) : rs).slice(0, LIMITS.labels);
  if (!body.length) return null;
  const nSeries = Math.min(LIMITS.series, width - 1);
  const series = Array.from({ length: nSeries }, (_, j) => ({ name: text(head ? rs[0][j + 1] : '', 60) || `Series ${j + 1}`, values: body.map((r) => cellNumber(r[j + 1]) ?? 0) }));
  if (body.every((r) => r.slice(1).every((x) => cellNumber(x) === null))) return null;
  return { ...base, labels: body.map((r, i) => text(r[0], 60) || `Item ${i + 1}`), series };
}
/** The chart as rows (labels down, series across), for the grid or the clipboard. */
export const chartRows = (c) => [['', ...c.series.map((s) => s.name)], ...c.labels.map((l, i) => [l, ...c.series.map((s) => String(s.values[i]))])];

// ── tables ──

export const sampleTable = () => ({ header: ['Item', 'Detail'], rows: [['', ''], ['', '']] });
const cols = (t) => Math.max(t.header.length, ...t.rows.map((r) => r.length), 0);

/** The deck with slide i's table replaced (cleaned; the slide shows it as a table). */
export function setTable(deck, i, table) {
  const s = deck.slides[i];
  if (!s || !isObj(table)) return deck;
  const d = clone(deck);
  const next = normalizeSlide({ ...d.slides[i], table, layout: 'table' });
  if (!next || !next.table) return deck;
  d.slides[i] = next;
  return d;
}
const withAlign = (t, f) => (t.align ? { align: f(t.align) } : {});
export function tableAddRow(t, at = t.rows.length) {
  if (t.rows.length >= LIMITS.rows) return t;
  const k = Math.max(0, Math.min(t.rows.length, at));
  const rows = t.rows.map((r) => [...r]); rows.splice(k, 0, Array(cols(t) || 1).fill(''));
  return { ...t, rows };
}
export function tableRemoveRow(t, at) {
  if (at < 0 || at >= t.rows.length || t.rows.length + (t.header.length ? 1 : 0) <= 1) return t;
  return { ...t, rows: t.rows.filter((_, j) => j !== at) };
}
export function tableMoveRow(t, from, to) {
  if (from < 0 || from >= t.rows.length || to < 0 || to >= t.rows.length || from === to) return t;
  const rows = t.rows.map((r) => [...r]); const [r] = rows.splice(from, 1); rows.splice(to, 0, r);
  return { ...t, rows };
}
export function tableAddCol(t, at = cols(t)) {
  const n = cols(t);
  if (n >= LIMITS.cols) return t;
  const k = Math.max(0, Math.min(n, at));
  const ins = (r, v) => { const x = [...r]; while (x.length < n) x.push(''); x.splice(k, 0, v); return x; };
  return { ...t, header: t.header.length ? ins(t.header, `Column ${n + 1}`) : [], rows: t.rows.map((r) => ins(r, '')), ...withAlign(t, (a) => ins(a, 'left')) };
}
export function tableRemoveCol(t, at) {
  const n = cols(t);
  if (n <= 1 || at < 0 || at >= n) return t;
  const del = (r) => r.filter((_, j) => j !== at);
  return { ...t, header: t.header.length ? del(t.header) : [], rows: t.rows.map(del), ...withAlign(t, del) };
}
export function tableMoveCol(t, from, to) {
  const n = cols(t);
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return t;
  const mv = (r) => { const x = [...r]; while (x.length < n) x.push(''); const [c] = x.splice(from, 1); x.splice(to, 0, c); return x; };
  return { ...t, header: t.header.length ? mv(t.header) : [], rows: t.rows.map(mv), ...withAlign(t, mv) };
}
/** Header row on: the first row becomes the header; off: the header becomes the first row. */
export function tableSetHeader(t, on) {
  if (on && !t.header.length) { if (!t.rows.length) return t; const [h, ...rows] = t.rows; return { ...t, header: h, rows: rows.length ? rows : [Array(h.length).fill('')] }; }
  if (!on && t.header.length) return { ...t, header: [], rows: [t.header, ...t.rows].slice(0, LIMITS.rows) };
  return t;
}
/** Set one cell: row -1 is the header row. */
export function tableSetCell(t, row, col, value) {
  if (col < 0 || col >= LIMITS.cols) return t;
  const v = text(value, row === -1 ? 80 : 160);
  if (row === -1) { if (!t.header.length) return t; const header = [...t.header]; header[col] = v; return { ...t, header }; }
  if (row < 0 || row >= t.rows.length) return t;
  const rows = t.rows.map((r) => [...r]); rows[row][col] = v;
  return { ...t, rows };
}
export function tableSetAlign(t, col, align) {
  const n = cols(t);
  if (col < 0 || col >= n || !ALIGNS.includes(align)) return t;
  const a = Array.from({ length: n }, (_, k) => (t.align && t.align[k]) || 'left'); a[col] = align;
  return { ...t, align: a };
}
export function tableSetStyle(t, style) { return TABLE_STYLES.includes(style) ? { ...t, style } : t; }
/**
 * Pasted rows into the table at (row, col) (row -1 = the header): overwrites and grows the table as needed, within
 * LIMITS.rows × LIMITS.cols; what doesn't fit is dropped. → { table, dropped } (cells left out).
 */
export function tablePaste(t, rows, row = 0, col = 0) {
  let out = { ...t, header: [...t.header], rows: t.rows.map((r) => [...r]) };
  let dropped = 0;
  rows.forEach((cells, dr) => {
    const r = row + dr;
    if (r >= 0 && r >= out.rows.length) { if (out.rows.length >= LIMITS.rows) { dropped += cells.length; return; } while (out.rows.length <= r && out.rows.length < LIMITS.rows) out = tableAddRow(out); }
    if (r >= out.rows.length) { dropped += cells.length; return; }
    cells.forEach((v, dc) => {
      const c = col + dc;
      if (c >= LIMITS.cols) { dropped++; return; }
      while (cols(out) <= c) out = tableAddCol(out);
      out = tableSetCell(out, r, c, v);
    });
  });
  return { table: out, dropped };
}
/** A whole table from pasted rows (the first row as the header when `header`). */
export function tableFromRows(rows, { header = true } = {}) {
  const rs = rows.filter((r) => r.some((x) => String(x).trim())).slice(0, LIMITS.rows + (header ? 1 : 0)).map((r) => r.slice(0, LIMITS.cols));
  if (!rs.length) return null;
  const n = Math.max(...rs.map((r) => r.length));
  const pad = (r) => [...r, ...Array(n - r.length).fill('')];
  return header && rs.length > 1 ? { header: pad(rs[0]), rows: rs.slice(1).map(pad) } : { header: [], rows: rs.map(pad).slice(0, LIMITS.rows) };
}

// ── backgrounds ──

/** The deck with slide i's background set (null/'theme' = the theme's); with `all`, every slide's. */
export function setBackground(deck, i, bg, { all = false } = {}) {
  if (!all && !deck.slides[i]) return deck;
  const b = normalizeBackground(bg);
  const d = clone(deck);
  d.slides.forEach((s, j) => { if (!all && j !== i) return; if (b) s.background = { ...b }; else delete s.background; });
  return d;
}
/** Pictures a deck's backgrounds use (so pruning never drops one). */
export const backgroundImages = (deck) => [...new Set(deck.slides.map((s) => s.background && s.background.kind === 'image' ? s.background.image : '').filter(Boolean))];

// ── slide numbers and footer ──

export function setFooter(deck, f) {
  const d = clone(deck);
  const next = normalizeFooter({ ...(d.footer || {}), ...(isObj(f) ? f : {}) });
  if (next) d.footer = next; else delete d.footer;
  return d;
}
/** Back to Eden's usual foot (the deck's title and the number on content slides). */
export function resetFooter(deck) { const d = clone(deck); delete d.footer; return d; }

/** Today as people write it in the deck's language ("24 October 2026"). `now` for tests. */
export function footerDate(lang = 'en', now = new Date()) {
  try { return new Intl.DateTimeFormat(lang || 'en', { day: 'numeric', month: 'long', year: 'numeric' }).format(now); } catch { return now.toISOString().slice(0, 10); }
}
/**
 * What the foot of drawn slide k (1-based) of `total` shows: { left, date, number } (strings; '' for none), or null
 * when nothing shows. Without deck.footer: Eden's usual foot (title and number on content slides).
 */
export function footerFor(deck, layout, k, total, { now = new Date() } = {}) {
  const f = deck.footer;
  if (!f) return layout === 'title' || layout === 'section' ? null : { left: deck.title || '', date: '', number: `${String(k).padStart(2, '0')} / ${String(total).padStart(2, '0')}`, usual: true };
  if (f.hideOnTitle && layout === 'title') return null;
  const out = { left: f.text || '', date: f.date ? f.dateText || footerDate(deck.lang, now) : '', number: f.number ? String(k) : '' };
  return out.left || out.date || out.number ? out : null;
}

/**
 * Pasted rows into the chart's grid at (row, col): row -1 is the series names, col -1 the labels (a spreadsheet's
 * first row and column). At the corner (-1, -1) the paste replaces the data (its header found as chartFromRows does).
 * The grid grows within the limits. → the chart (not yet cleaned).
 */
export function chartPaste(c, rows, row = 0, col = 0) {
  if (!rows.length) return c;
  if (row === -1 && col === -1) return chartFromRows(rows, c) || c;
  const grid = chartRows(c).map((r) => [...r]);
  rows.forEach((cells, dr) => cells.forEach((v, dc) => {
    const r = row + 1 + dr, k = col + 1 + dc;
    if (r < 0 || k < 0 || r > LIMITS.labels || k > LIMITS.series) return;
    while (grid.length <= r) grid.push(Array(grid[0].length).fill(''));
    for (const g of grid) while (g.length <= k) g.push('');
    grid[r][k] = String(v);
  }));
  return {
    ...c,
    labels: grid.slice(1).map((g, i) => text(g[0], 60) || `Item ${i + 1}`),
    series: grid[0].slice(1).map((name, j) => ({ name: text(name, 60) || `Series ${j + 1}`, values: grid.slice(1).map((g) => cellNumber(g[j + 1]) ?? 0) })),
  };
}
