// Drawing the everyday-editing fields (deck-format-model.js) in the sandboxed frame and in PowerPoint: a chart's own
// colours, table styles and column alignment, slide backgrounds (colour, gradient, picture with dim and blur), and
// slide numbers with a footer. Pure apart from bakeBackgrounds (a canvas, browser only). Only checked hex colours,
// numbers and accepted picture data URLs ever reach the markup.

import { SLIDE_W, SLIDE_H, M } from './deck-model.js';
import { footerFor } from './deck-format-model.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const n = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);
const HEX = /^#[0-9a-f]{6}$/;
const C = (hex) => String(hex || '#000000').replace('#', '').toUpperCase();

// ── charts ──

/** The chart's palette: its own colours where set, the theme's elsewhere. */
export const chartColors = (c, base) => base.map((x, i) => (c.colors && HEX.test(c.colors[i] || '') ? c.colors[i] : x));
/** For pie and doughnut, one colour per slice (more slices than the palette repeat it, own colours win). */
export const sliceColors = (c, base) => c.labels.map((_, i) => (c.colors && HEX.test(c.colors[i] || '') ? c.colors[i] : base[i % base.length]));
/** Whether the legend shows (the chart's choice, else Eden's default). */
export const showLegend = (c) => (typeof c.legend === 'boolean' ? c.legend : c.series.length > 1 || c.type === 'pie' || c.type === 'doughnut');
/** Whether values are written on the bars/points (the chart's choice, else one series of at most 12). */
export const showValues = (c) => (typeof c.dataLabels === 'boolean' ? c.dataLabels : c.series.length === 1 && c.labels.length <= 12 && c.type !== 'line' && c.type !== 'area');

/** Axis titles inside the chart's box (SVG). */
export function axisTitlesSvg(c, { L, T, pw, ph, W, H, fill, hb }) {
  let out = '';
  if (c.axisTitle) out += hb
    ? `<text x="${n(L + pw / 2)}" y="${n(H - 4)}" text-anchor="middle" fill="${fill}" font-size="15" font-weight="600">${esc(c.axisTitle)}</text>`
    : `<text transform="translate(16 ${n(T + ph / 2)}) rotate(-90)" text-anchor="middle" fill="${fill}" font-size="15" font-weight="600">${esc(c.axisTitle)}</text>`;
  if (c.catTitle) out += hb
    ? `<text transform="translate(16 ${n(T + ph / 2)}) rotate(-90)" text-anchor="middle" fill="${fill}" font-size="15" font-weight="600">${esc(c.catTitle)}</text>`
    : `<text x="${n(L + pw / 2)}" y="${n(H - 4)}" text-anchor="middle" fill="${fill}" font-size="15" font-weight="600">${esc(c.catTitle)}</text>`;
  return out;
}

// ── tables ──

/** The table element's class and each column's text alignment. */
export const tableClass = (tb) => `tbl${tb.style ? ` ts-${tb.style}` : ''}`;
export const cellAlign = (tb, ci) => (tb.align && tb.align[ci] && tb.align[ci] !== 'left' ? ` style="text-align:${tb.align[ci]}"` : '');

// ── backgrounds and the footer in the frame ──

export const FORMAT_CSS = `
.bgx{position:absolute;inset:0;overflow:hidden;pointer-events:none}
.bgx img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.bgx .bgdim{position:absolute;inset:0;background:var(--bg)}
.has-bg .bgfx .orb,.has-bg .bgfx .bg-grid{display:none}
.tbl.ts-plain th{background:none;color:var(--text);border-bottom:2px solid color-mix(in srgb,var(--text) 70%,transparent);border-radius:0!important}
.tbl.ts-plain td{border-bottom:0}.tbl.ts-plain tr:nth-child(even) td{background:none}
.tbl.ts-lines th{background:none;color:var(--text);border-bottom:1.5px solid var(--text);border-radius:0!important}
.tbl.ts-lines td{border-bottom:1px solid color-mix(in srgb,var(--muted) 30%,transparent)}.tbl.ts-lines tr:nth-child(even) td{background:none}
.tbl.ts-zebra th{background:color-mix(in srgb,var(--text) 8%,transparent);color:var(--text);border-radius:0!important}
.tbl.ts-zebra td{border-bottom:0}.tbl.ts-zebra tr:nth-child(even) td{background:color-mix(in srgb,var(--text) 5%,transparent)}
.tbl.ts-grid{border-collapse:collapse}.tbl.ts-grid th,.tbl.ts-grid td{border:1px solid color-mix(in srgb,var(--muted) 40%,transparent);border-radius:0!important}
.tbl.ts-grid th{background:color-mix(in srgb,var(--accent) 10%,transparent);color:var(--text)}.tbl.ts-grid tr:nth-child(even) td{background:none}
.slide .foot.ff{display:flex}.ff .fdate{margin-left:auto;margin-right:18px}.ff .fn{min-width:0}
`;

/** The slide's own background, drawn over the theme's (or ''); `src(id)` is a picture's data URL or ''. */
export function backgroundLayer(s, src) {
  const b = s && s.background;
  if (!b) return '';
  if (b.kind === 'color' && HEX.test(b.color)) return `<div class="bgx" aria-hidden="true" style="background:${b.color}"></div>`;
  if (b.kind === 'gradient' && HEX.test(b.from) && HEX.test(b.to)) return `<div class="bgx" aria-hidden="true" style="background:linear-gradient(${n(b.angle)}deg,${b.from},${b.to})"></div>`;
  if (b.kind === 'image') {
    const data = src(b.image);
    if (!data) return '';
    const blur = Math.max(0, Math.min(24, Number(b.blur) || 0)), dim = Math.max(0, Math.min(0.8, Number(b.dim) || 0));
    // a blurred picture is drawn a little larger so its soft edge stays off the slide
    return `<div class="bgx" aria-hidden="true"><img src="${data}" alt=""${blur ? ` style="filter:blur(${n(blur)}px);inset:-${n(blur * 2)}px;width:calc(100% + ${n(blur * 4)}px);height:calc(100% + ${n(blur * 4)}px)"` : ''}>${dim ? `<div class="bgdim" style="opacity:${n(dim)}"></div>` : ''}</div>`;
  }
  return '';
}
/** ' has-bg' when the slide has a background of its own that draws (the theme's orbs step aside). */
export const backgroundClass = (s, src) => (backgroundLayer(s, src) ? ' has-bg' : '');

/** The foot for drawn slide k of total, with the deck's footer settings (deck.footer set). */
export function footerHtml(deck, s, k, total, opts = {}) {
  const f = footerFor(deck, s.layout, k, total, opts);
  if (!f) return '';
  return `<div class="foot ff" aria-hidden="true"><span class="fd">${f.left ? `<span class="fd-dot"></span>${esc(f.left)}` : ''}</span>${f.date ? `<span class="fdate">${esc(f.date)}</span>` : ''}${f.number ? `<span class="fn">${esc(f.number)}</span>` : ''}</div>`;
}

// ── a gradient as a picture (PowerPoint's slide background takes a colour or a picture) ──

const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
const crc32 = (bytes) => { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
function chunk(type, data) { const td = [...type].map((ch) => ch.charCodeAt(0)).concat(data); return [...u32(data.length), ...td, ...u32(crc32(td))]; }
const rgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

/** A w × h PNG of a linear gradient (CSS angle: 0deg goes up, 90deg right), as base64 (stored, uncompressed deflate). */
export function gradientPng(from, to, angle = 135, w = 160, h = 90) {
  const a = rgb(HEX.test(from) ? from : '#000000'), b = rgb(HEX.test(to) ? to : '#000000');
  const rad = (angle * Math.PI) / 180, dx = Math.sin(rad), dy = -Math.cos(rad);
  // CSS: the gradient line's length makes the corners hit 0 and 1 exactly (in slide proportions)
  const sw = 16, sh = 9, len = Math.abs(sw * dx) + Math.abs(sh * dy);
  const raw = [];
  for (let y = 0; y < h; y++) {
    raw.push(0);
    for (let x = 0; x < w; x++) {
      const px = ((x + 0.5) / w - 0.5) * sw, py = ((y + 0.5) / h - 0.5) * sh;
      const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len + 0.5));
      raw.push(Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t));
    }
  }
  const z = [0x78, 0x01]; // zlib, stored blocks of at most 65535 bytes
  for (let i = 0; i < raw.length; i += 65535) { const part = raw.slice(i, i + 65535), last = i + 65535 >= raw.length ? 1 : 0; z.push(last, part.length & 255, part.length >> 8, ~part.length & 255, (~part.length >> 8) & 255, ...part); }
  let s1 = 1, s2 = 0; for (const v of raw) { s1 = (s1 + v) % 65521; s2 = (s2 + s1) % 65521; }
  z.push(...u32(((s2 << 16) | s1) >>> 0));
  const png = [137, 80, 78, 71, 13, 10, 26, 10, ...chunk('IHDR', [...u32(w), ...u32(h), 8, 2, 0, 0, 0]), ...chunk('IDAT', z), ...chunk('IEND', [])];
  let bin = ''; for (let i = 0; i < png.length; i += 8192) bin += String.fromCharCode(...png.slice(i, i + 8192));
  return btoa(bin);
}

// ── PowerPoint ──

/**
 * Slide i's background in PowerPoint. ctx: { pres, slide, theme, images, imageData, baked (drawn index → data URL of
 * the picture with its blur and dim already in it), k (drawn index), IN, as (names a shape's role) }.
 * A picture without a baked copy gets its dim as a see-through rectangle in the theme's background colour.
 */
export function pptxBackground(s, { pres, slide, theme, images, imageData, baked, k, IN, as }) {
  const b = s && s.background;
  if (!b) return false;
  if (b.kind === 'color') { slide.background = { color: C(b.color) }; return true; }
  if (b.kind === 'gradient') { slide.background = { data: `image/png;base64,${gradientPng(b.from, b.to, b.angle)}` }; return true; }
  if (b.kind === 'image') {
    const pre = baked && baked[k];
    if (pre && /^data:image\/(png|jpeg);base64,/.test(pre)) { slide.background = { data: pre.replace(/^data:/, '') }; return true; }
    const data = imageData(images[b.image]);
    if (!data || !/^data:image\/(png|jpe?g|gif);base64,/.test(data)) return false;
    slide.background = { data: data.replace(/^data:/, '') };
    if (b.dim > 0) as('l', () => slide.addShape(pres.ShapeType.rect, { x: 0, y: 0, w: IN(SLIDE_W), h: IN(SLIDE_H), fill: { color: C(theme.colors.bg), transparency: Math.round((1 - b.dim) * 100) }, line: { type: 'none' } }));
    return true;
  }
  return false;
}

/** The deck's footer in PowerPoint (deck.footer set): text and date as text boxes, the number as PowerPoint's own field. */
export function pptxFooter(deck, s, k, total, { slide, theme, IN, as, now }) {
  const f = footerFor(deck, s.layout, k, total, { now });
  if (!f) return;
  const y = IN(SLIDE_H - 40), opt = { y, h: IN(24), fontSize: 10, color: C(theme.colors.muted), margin: 0, fontFace: theme.body.pptx };
  as('l', () => {
    if (f.left) slide.addText(f.left, { ...opt, x: IN(M.x), w: IN(560) });
    if (f.date) slide.addText(f.date, { ...opt, x: IN(SLIDE_W - M.x - 420), w: IN(300), align: 'right' });
  });
  if (f.number) slide.slideNumber = { x: IN(SLIDE_W - M.x - 60), y, w: IN(60), h: IN(24), fontSize: 10, color: C(theme.colors.muted), fontFace: theme.body.pptx, align: 'right' };
}

/**
 * Browser only: each picture background with its blur or dim baked in (a JPEG drawn on a canvas), keyed by drawn
 * slide index, for pptxBackground. Skipped quietly where there's no canvas.
 */
export async function bakeBackgrounds(drawn, images, imageData, theme) {
  const out = {};
  if (typeof document === 'undefined') return out;
  for (const [k, r] of drawn.entries()) {
    const b = r.slide.background;
    if (!b || b.kind !== 'image' || (!b.blur && !b.dim)) continue;
    const data = imageData(images[b.image]);
    if (!data) continue;
    try {
      const img = new Image();
      img.src = data;
      await img.decode();
      const W = 1600, H = 900, cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      const g = cv.getContext('2d');
      const sc = Math.max(W / img.naturalWidth, H / img.naturalHeight), bl = b.blur * (W / SLIDE_W);
      const dw = img.naturalWidth * sc + bl * 4, dh = img.naturalHeight * sc + bl * 4;
      if (bl) g.filter = `blur(${bl}px)`;
      g.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
      g.filter = 'none';
      if (b.dim) { g.globalAlpha = b.dim; g.fillStyle = theme.colors.bg; g.fillRect(0, 0, W, H); }
      out[k] = cv.toDataURL('image/jpeg', 0.86);
    } catch { /* this one keeps the plain picture */ }
  }
  return out;
}

const mix = (a, b, p) => { const x = rgb(a), y = rgb(b); return x.map((v, i) => Math.round(v * p + y[i] * (1 - p)).toString(16).padStart(2, '0')).join('').toUpperCase(); };
/** The chart's colours for PptxGenJS (no #): its own where set. */
export const pptxChartColors = (c, base) => (c.type === 'pie' || c.type === 'doughnut' ? sliceColors(c, base) : chartColors(c, base)).map(C);
/** A number format that carries the chart's unit ("12%", "$5", "40 km"), or '' for none. */
export function unitFormat(unit) {
  const u = String(unit || '').replace(/["\\]/g, '').slice(0, 12);
  if (!u) return '';
  if (u === '%') return '0"%"';
  if (/^[$€£¥]$/.test(u)) return `"${u}"#,##0.##`;
  return `General" ${u}"`;
}
/** PptxGenJS options for a chart's look: colours, legend, values, axis titles, unit. */
export function pptxChartLook(c, t, base) {
  const round = c.type === 'pie' || c.type === 'doughnut', fmt = unitFormat(c.unit);
  return {
    chartColors: pptxChartColors(c, base), showLegend: showLegend(c),
    showValue: !round && showValues(c), showPercent: round && c.dataLabels !== false,
    ...(c.axisTitle && !round ? { showValAxisTitle: true, valAxisTitle: c.axisTitle, valAxisTitleColor: C(t.colors.muted), valAxisTitleFontSize: 12 } : {}),
    ...(c.catTitle && !round ? { showCatAxisTitle: true, catAxisTitle: c.catTitle, catAxisTitleColor: C(t.colors.muted), catAxisTitleFontSize: 12 } : {}),
    ...(fmt && !round ? { valAxisLabelFormatCode: fmt, dataLabelFormatCode: fmt } : {}),
  };
}
/** A table's rows for PptxGenJS (header first) with the table's style and each column's alignment. */
export function pptxTableRows(tb, t) {
  const st = tb.style || 'theme', al = (ci) => (tb.align && tb.align[ci]) || 'left';
  const tx = C(t.colors.text), mu = C(t.colors.muted), none = { type: 'none' }, line = (pt, color) => ({ type: 'solid', pt, color });
  const hair = line(0.5, mu), rows = [];
  const head = { theme: { color: 'FFFFFF', fill: { color: C(t.colors.accent) }, border: hair }, plain: { color: tx, border: [none, none, line(1.5, tx), none] }, lines: { color: tx, border: [none, none, line(1.25, tx), none] }, zebra: { color: tx, fill: { color: mix(t.colors.text, t.colors.bg, 0.08) }, border: none }, grid: { color: tx, fill: { color: mix(t.colors.accent, t.colors.bg, 0.1) }, border: hair } }[st];
  const body = (i) => ({ theme: { fill: { color: C(i % 2 ? t.colors.surface : t.colors.bg) }, border: hair }, plain: { border: none }, lines: { border: [none, none, line(0.5, mu), none] }, zebra: { ...(i % 2 ? { fill: { color: mix(t.colors.text, t.colors.bg, 0.05) } } : {}), border: none }, grid: { border: hair } }[st]);
  if (tb.header.length) rows.push(tb.header.map((h, ci) => ({ text: h, options: { bold: true, align: al(ci), ...head } })));
  tb.rows.forEach((row, i) => rows.push(row.map((cell, ci) => ({ text: cell, options: { color: tx, align: al(ci), ...body(i) } }))));
  return rows;
}
