// Drawing a slide deck (ROADMAP Q14): the deck (deck-model.js) as one HTML document, built as a
// string with every piece of text escaped. Pure: no DOM here (src/__tests__/deck.test.ts checks
// the escaping). The document is shown the way every canvas artifact is: served by Eden under the
// artifact sandbox CSP (an opaque origin, no network, no cookies, no way into Eden's page), so
// even a slip in escaping could not reach the page; nothing a model wrote is ever HTML or script.
// The only script in it is Eden's own viewer below (navigation, present mode, editing), which
// talks to the page by postMessage; the page checks each message (deck.js).
//
// Modes: 'edit' (the canvas: slide strip, direct text editing), 'present' (one slide at a time,
// keys/click/swipe, overview, presenter view with notes and timer, laser), 'static' (no script:
// print to PDF, one slide a page).

import { SLIDE_W, SLIDE_H, M, themeOf, layoutDeck, partTitle, citeRuns, axis, shortNum, wedges, diagramLayout, linkEnds, motionOf } from './deck-model.js';
import { logoBox, fontFaceCss } from './deck-brand-model.js';
import { styleCss } from './deck-styles.js'; // a styled theme's own look (Swiss grid, magazine…)
import { mediaLayer, mediaFrame, MEDIA_CSS } from './deck-video.js'; // video and audio on slides (live: web only)
import { freeHtml, FREE_CSS, freeEditor } from './deck-freeform-draw.js'; // free-form elements (the editor: web only)
import { frameScript } from './deck-presence.js'; // comments and presence drawn in the web editor's frame (progressive: web only)
import { runsFor, runsHtml, alignFor, numbered, RICH_CSS } from './deck-rich.js'; // rich text: bold, colours, links, alignment, numbered lists
import { richFrame } from './deck-rich-frame.js'; // selecting and formatting slide text in the frame (progressive: web only)
import { arrangeFrame } from './deck-arrange-frame.js'; // right-click menus, hidden slides, sections, zoom, rulers, guides (progressive: web only)
import { SHELL_FRAME_CSS, shellFrame } from './deck-shell-frame.js'; // the editor shell's navigator, selection and right-click messages (progressive: web only)
import { marksFrame } from './deck-find-frame.js'; // find highlights and spelling underlines (progressive: web only)
import { liveFrame } from './deck-live-frame.js'; // poll results, questions and join codes on live slides, targets in the presenter view (progressive: web only)
import { aiFrame } from './deck-ai-frame.js'; // EVES fact-check marks on checked text (progressive: web only)
import { chartColors, sliceColors, showLegend, showValues, axisTitlesSvg, tableClass, cellAlign, FORMAT_CSS, backgroundLayer, backgroundClass, footerHtml } from './deck-format-draw.js'; // chart look, table styles, backgrounds, footer

export const LABELS = {
  slide: 'Slide', of: 'of', slides: 'Slides', notes: 'Speaker notes', noNotes: 'No notes for this slide.', next: 'Next', prev: 'Previous',
  overview: 'Overview', presenter: 'Presenter view', laser: 'Laser pointer', exit: 'Exit', end: 'End of the deck', timer: 'Timer', reset: 'Reset',
  regen: 'Regenerate', shorter: 'Shorter', expand: 'Expand', magicLayout: 'Switch layout', swapPhoto: 'Swap photo', aiVisual: 'AI visual', playbook: 'Playbook X/O',
  add: 'Add slide after', dup: 'Duplicate', del: 'Delete slide', up: 'Move up', down: 'Move down',
  editHint: 'Click any text to edit it. Drag slides in the strip to reorder.', altNeeded: 'Alt text needed', source: 'Source', sources: 'Sources',
  checked: 'Eden’s check', present: 'Present', cont: 'continued', picture: 'Picture', missing: 'Picture not on this device', chart: 'Chart', diagram: 'Diagram',
};

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Text as HTML text or an attribute value: nothing in it is markup. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const n = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : 0); // a number for markup: only digits ever
const DATA_URL = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
// The first bytes each type starts with, as base64: a damaged picture, or another file named as one, is no picture
// (PowerPoint asks to repair a file holding one).
const SIGNATURE = { png: 'iVBORw0KGgo', jpeg: '/9j/', gif: 'R0lGOD', webp: 'UklGR' };
/** A picture's data URL when it's one Eden accepts (PNG, JPEG, GIF, WebP as base64, and really that type), else ''. */
export const imageData = (im) => {
  const m = im && typeof im.data === 'string' ? DATA_URL.exec(im.data) : null;
  return m && im.data.startsWith(SIGNATURE[m[1]], im.data.indexOf(',') + 1) ? im.data : '';
};

/** The deck's brand logo on a slide: its element, the section's corner class and its width (the foot and heading make room). */
function brandLogo(ctx) {
  const b = ctx.deck && ctx.deck.brand;
  const im = b && b.logo && ctx.images ? ctx.images[b.logo] : null;
  const src = imageData(im);
  const box = src ? logoBox(b, im) : null;
  if (!box) return { html: '', cls: '', style: '' };
  return { html: `<img class="brand-logo" src="${src}" alt="" style="left:${n(box.x)}px;top:${n(box.y)}px;width:${n(box.w)}px;height:${n(box.h)}px">`, cls: ` lg-${box.corner}`, style: ` style="--lw:${n(box.w)}px"` };
}

function palette(t) { return t.palette || [t.colors.accent, t.colors.accent2, '#f5a524', '#17a673', '#e5484d', '#8e8e93']; }

/** Words with citation markers as superscripts; the person's text escaped. */
let RS = null; // the slide being drawn (slideHtml sets it): its rich-text formatting (deck-rich.js)
function rich(s, known, path = '') {
  const piece = (str) => citeRuns(str, known).map((r) => (r.cite ? `<sup class="cite">${esc(r.t)}</sup>` : esc(r.t))).join('');
  const runs = path && RS && RS.fmt ? runsFor(RS, path, String(s ?? '')) : null;
  return runs ? runsHtml(runs, piece, esc) : piece(s);
}
const plainOr = (s, path) => (RS && RS.fmt && runsFor(RS, path, String(s ?? '')) ? rich(s, null, path) : esc(s)); // texts drawn without citations
const editable = (path, ctx) => `${ctx.edit ? ` data-path="${esc(path)}"` : ''}${RS && RS.fmt && alignFor(RS, path) ? ` data-al="${esc(alignFor(RS, path))}"` : ''}`;

function bulletList(items, path, px, ctx, offset = 0) {
  if (!items || !items.length) return '';
  const tag = RS && numbered(RS, path) ? 'ol' : 'ul';
  return `<${tag} class="bl"${tag === 'ol' && offset ? ` start="${offset + 1}" style="font-size:${n(px)}px;counter-reset:bn ${offset}"` : ` style="font-size:${n(px)}px"`}${RS && RS.fmt && alignFor(RS, path) ? ` data-al="${esc(alignFor(RS, path))}"` : ''}>${items.map((b, k) => {
    const i = k + offset;
    if (typeof b === 'string') return `<li><span${editable(`${path}.${i}`, ctx)}>${rich(b, ctx.known, `${path}.${i}`)}</span></li>`;
    return `<li><span${editable(`${path}.${i}`, ctx)}>${rich(b.text, ctx.known, `${path}.${i}`)}</span>${b.sub && b.sub.length ? `<ul>${b.sub.map((x, j) => `<li><span${editable(`${path}.${i}.sub.${j}`, ctx)}>${rich(x, ctx.known, `${path}.${i}.sub.${j}`)}</span></li>`).join('')}</ul>` : ''}</li>`;
  }).join('')}</${tag}>`;
}

// ── charts (inline SVG; the data also as a table for screen readers) ──

function wrap(s, max) {
  const words = String(s).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > max && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}
/** Every line of `s` wrapped to a box `w` wide at `px` (no cap: the caller decides what fits). */
function fitWrap(s, w, px) {
  const max = Math.max(8, Math.floor((w - 24) / (px * 0.52)));
  const lines = [];
  let cur = '';
  for (const word of String(s || '').split(/\s+/).filter(Boolean)) { if ((cur + ' ' + word).trim().length > max && cur) { lines.push(cur); cur = word; } else cur = (cur + ' ' + word).trim(); }
  if (cur) lines.push(cur);
  return lines;
}
const tspans = (lines, x, dy) => lines.map((l, i) => `<tspan x="${n(x)}" dy="${i ? n(dy) : 0}">${esc(l)}</tspan>`).join('');

export function chartSvg(c, t, W, H) {
  const col = c.type === 'pie' || c.type === 'doughnut' ? sliceColors(c, palette(t)) : chartColors(c, palette(t)); // the chart's own colours (deck-format-draw.js)
  const fg = t.colors.text, mu = t.colors.muted;
  const label = `${c.type} chart: ${c.series.map((s) => `${s.name ? `${s.name}: ` : ''}${c.labels.map((l, k) => `${l} ${shortNum(s.values[k], c.unit)}`).join(', ')}`).join('; ')}`;
  const legend = showLegend(c), vals = showValues(c);
  let body = '';
  if (c.type === 'pie' || c.type === 'doughnut') {
    const cx = legend ? W * 0.35 : W / 2, cy = H / 2, r = Math.min(W * 0.3, H / 2 - 10), ri = c.type === 'doughnut' ? r * 0.58 : 0;
    const pt = (a, rr) => `${n(cx + rr * Math.sin(a))} ${n(cy - rr * Math.cos(a))}`;
    body += wedges(c).map((w, i) => {
      if (w.share >= 0.9999) return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${col[i % col.length]}"/>${ri ? `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(ri)}" fill="${t.colors.bg}"/>` : ''}`;
      const big = w.a1 - w.a0 > Math.PI ? 1 : 0;
      const d = ri ? `M${pt(w.a0, r)} A${n(r)} ${n(r)} 0 ${big} 1 ${pt(w.a1, r)} L${pt(w.a1, ri)} A${n(ri)} ${n(ri)} 0 ${big} 0 ${pt(w.a0, ri)}Z` : `M${n(cx)} ${n(cy)} L${pt(w.a0, r)} A${n(r)} ${n(r)} 0 ${big} 1 ${pt(w.a1, r)}Z`;
      return `<path d="${d}" fill="${col[i % col.length]}" stroke="${t.colors.bg}" stroke-width="2"/>`;
    }).join('');
    if (legend) body += wedges(c).map((w, i) => `<g transform="translate(${n(W * 0.7)} ${n(H / 2 - (c.labels.length * 34) / 2 + i * 34)})"><rect width="18" height="18" rx="4" fill="${col[i % col.length]}"/><text x="28" y="15" fill="${fg}" font-size="20">${esc(w.label)}${c.dataLabels === false ? '' : ` · ${esc(shortNum(w.value, c.unit))} (${Math.round(w.share * 100)}%)`}</text></g>`).join('');
    else if (c.dataLabels !== false) body += wedges(c).filter((w) => w.share >= 0.04).map((w) => { const a = (w.a0 + w.a1) / 2, rr = ri ? (r + ri) / 2 : r * 0.64; return `<text x="${n(cx + rr * Math.sin(a))}" y="${n(cy - rr * Math.cos(a) + 6)}" text-anchor="middle" fill="#fff" font-size="17" font-weight="700">${Math.round(w.share * 100)}%</text>`; }).join('');
  } else {
    const all = c.series.flatMap((s) => s.values);
    const ax = axis(all);
    const hb = c.type === 'hbar';
    const L = (hb ? 170 : 70) + ((hb ? c.catTitle : c.axisTitle) ? 26 : 0), R = 20, T = legend ? 44 : 14, B = (hb ? 34 : 54) + ((hb ? c.axisTitle : c.catTitle) ? 24 : 0);
    const pw = W - L - R, ph = H - T - B;
    const k = c.labels.length, sN = c.series.length;
    const val = (v) => (v - ax.min) / (ax.max - ax.min);
    // grid and value axis
    for (const tk of ax.ticks) {
      if (hb) { const x = L + val(tk) * pw; body += `<line x1="${n(x)}" y1="${T}" x2="${n(x)}" y2="${n(T + ph)}" stroke="${mu}" stroke-opacity=".25"/><text x="${n(x)}" y="${n(T + ph + 26)}" text-anchor="middle" fill="${mu}" font-size="16">${esc(shortNum(tk, c.unit))}</text>`; }
      else { const y = T + ph - val(tk) * ph; body += `<line x1="${L}" y1="${n(y)}" x2="${n(L + pw)}" y2="${n(y)}" stroke="${mu}" stroke-opacity=".25"/><text x="${L - 10}" y="${n(y + 5)}" text-anchor="end" fill="${mu}" font-size="16">${esc(shortNum(tk, c.unit))}</text>`; }
    }
    const zero = val(0);
    if (c.type === 'bar' || hb) {
      const band = (hb ? ph : pw) / k, gw = band * 0.72, bw = gw / sN;
      c.labels.forEach((lab, i) => {
        c.series.forEach((s, j) => {
          const v = val(s.values[i]);
          const a = Math.min(v, zero), b = Math.max(v, zero);
          if (hb) body += `<rect x="${n(L + a * pw)}" y="${n(T + i * band + (band - gw) / 2 + j * bw)}" width="${n(Math.max(1, (b - a) * pw))}" height="${n(bw - 3)}" rx="5" fill="${col[j % col.length]}"/>`;
          else body += `<rect x="${n(L + i * band + (band - gw) / 2 + j * bw)}" y="${n(T + ph - b * ph)}" width="${n(bw - 3)}" height="${n(Math.max(1, (b - a) * ph))}" rx="5" fill="${col[j % col.length]}"/>`;
          if (vals) { // on each bar (one series: the middle of its band)
            const mid = sN === 1 ? band / 2 : (band - gw) / 2 + j * bw + (bw - 3) / 2, fs = sN > 2 ? 13 : 17;
            if (hb) body += `<text x="${n(L + b * pw + 8)}" y="${n(T + i * band + mid + 6)}" fill="${fg}" font-size="${fs}">${esc(shortNum(s.values[i], c.unit))}</text>`;
            else body += `<text x="${n(L + i * band + mid)}" y="${n(T + ph - b * ph - 8)}" text-anchor="middle" fill="${fg}" font-size="${fs}">${esc(shortNum(s.values[i], c.unit))}</text>`;
          }
        });
        if (hb) body += `<text x="${L - 10}" y="${n(T + i * band + band / 2 + 6)}" text-anchor="end" fill="${fg}" font-size="17">${esc(lab.length > 18 ? `${lab.slice(0, 17)}…` : lab)}</text>`;
        else body += `<text x="${n(L + i * band + band / 2)}" y="${n(T + ph + 28)}" text-anchor="middle" fill="${fg}" font-size="${k > 8 ? 14 : 17}">${esc(lab.length > 14 ? `${lab.slice(0, 13)}…` : lab)}</text>`;
      });
    } else { // line, area
      const x = (i) => L + (k === 1 ? pw / 2 : (i / (k - 1)) * pw);
      c.series.forEach((s, j) => {
        const pts = s.values.map((v, i) => `${n(x(i))},${n(T + ph - val(v) * ph)}`);
        if (c.type === 'area') body += `<polygon points="${n(x(0))},${n(T + ph - zero * ph)} ${pts.join(' ')} ${n(x(k - 1))},${n(T + ph - zero * ph)}" fill="${col[j % col.length]}" fill-opacity="${sN > 1 ? 0.25 : 0.35}"/>`;
        body += `<polyline points="${pts.join(' ')}" fill="none" stroke="${col[j % col.length]}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>`;
        body += s.values.map((v, i) => `<circle cx="${n(x(i))}" cy="${n(T + ph - val(v) * ph)}" r="5.5" fill="${col[j % col.length]}"/>`).join('');
        if (vals) body += s.values.map((v, i) => `<text x="${n(x(i))}" y="${n(T + ph - val(v) * ph - 12)}" text-anchor="middle" fill="${fg}" font-size="${sN > 2 ? 13 : 16}">${esc(shortNum(v, c.unit))}</text>`).join('');
      });
      c.labels.forEach((lab, i) => { if (k <= 12 || i % Math.ceil(k / 12) === 0) body += `<text x="${n(x(i))}" y="${n(T + ph + 28)}" text-anchor="middle" fill="${fg}" font-size="${k > 8 ? 14 : 17}">${esc(lab.length > 14 ? `${lab.slice(0, 13)}…` : lab)}</text>`; });
    }
    body += axisTitlesSvg(c, { L, T, pw, ph, W, H, fill: mu, hb });
    if (legend) body += c.series.map((s, j) => `<g transform="translate(${L + j * 200} 6)"><rect width="16" height="16" rx="4" fill="${col[j % col.length]}"/><text x="24" y="14" fill="${fg}" font-size="17">${esc((s.name || `Series ${j + 1}`).slice(0, 18))}</text></g>`).join('');
  }
  const table = `<table class="sr-only"><caption>${esc(label)}</caption>${c.series.length ? `<tr><th></th>${c.series.map((s) => `<th>${esc(s.name || 'Value')}</th>`).join('')}</tr>` : ''}${c.labels.map((l, i) => `<tr><th>${esc(l)}</th>${c.series.map((s) => `<td>${esc(shortNum(s.values[i], c.unit))}</td>`).join('')}</tr>`).join('')}</table>`;
  return `<svg class="chart" viewBox="0 0 ${n(W)} ${n(H)}" width="${n(W)}" height="${n(H)}" role="img" aria-label="${esc(label)}" font-family="inherit">${body}</svg>${table}`;
}

// ── diagrams ──

export function diagramSvg(d, t, W, H) {
  const g = diagramLayout(d, 0, 0, W, H);
  const fg = t.colors.text, mu = t.colors.muted, ac = t.colors.accent;
  const col = palette(t);
  let s = ''; // arrowheads are drawn as shapes (a <marker> found by id fails in a hidden slide's copy)
  if (g.shape === 'timeline') s += `<line x1="${n(g.line.x1)}" y1="${n(g.line.y)}" x2="${n(g.line.x2)}" y2="${n(g.line.y)}" stroke="${ac}" stroke-width="4" stroke-linecap="round"/>`;
  for (const [a, b] of g.links) {
    const [x1, y1, x2, y2] = linkEnds(g, a, b);
    const ang = Math.atan2(y2 - y1, x2 - x1), len = 14, half = 7;
    const bx = x2 - len * Math.cos(ang), by = y2 - len * Math.sin(ang);
    s += `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(bx)}" y2="${n(by)}" stroke="${ac}" stroke-width="3"/><polygon points="${n(x2)},${n(y2)} ${n(bx + half * Math.sin(ang))},${n(by - half * Math.cos(ang))} ${n(bx - half * Math.sin(ang))},${n(by + half * Math.cos(ang))}" fill="${ac}"/>`;
  }
  g.boxes.forEach((b, i) => {
    if (b.dot) s += `<line x1="${n(b.dot.x)}" y1="${n(b.dot.y)}" x2="${n(b.dot.x)}" y2="${n(b.y < b.dot.y ? b.y + b.h : b.y)}" stroke="${mu}" stroke-opacity=".5" stroke-width="2"/><circle cx="${n(b.dot.x)}" cy="${n(b.dot.y)}" r="10" fill="${col[i % col.length]}"/>`;
    if (b.taper) { // a pyramid layer
      const top = (b.taper.top * W), bot = b.w;
      s += `<polygon points="${n(W / 2 - top / 2)},${n(b.y)} ${n(W / 2 + top / 2)},${n(b.y)} ${n(W / 2 + bot / 2)},${n(b.y + b.h)} ${n(W / 2 - bot / 2)},${n(b.y + b.h)}" fill="${col[i % col.length]}" fill-opacity="${0.9 - i * 0.08}"/>`;
    } else s += `<rect x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="16" fill="${t.colors.surface}" fill-opacity="${t.glass ? 0.7 : 1}" stroke="${col[i % col.length]}" stroke-width="2.5"/>`;
    // The label and its detail are fitted to the box: the type steps down until every line fits, and only text that
    // still can't fit ends in "…" (a timeline's details were cut mid-sentence, with no sign anything was missing)
    const room = b.h - 20;
    let fs = b.w < 170 ? 18 : 21, lab = fitWrap(b.label, b.w, fs), dfs = 15, det = [];
    for (const size of [15, 14, 13, 12, 11]) {
      dfs = size;
      det = b.detail ? fitWrap(b.detail, b.w, size) : [];
      if (lab.length * fs * 1.15 + det.length * size * 1.2 <= room) break;
      if (size === 13 && fs > 16) { fs = 16; lab = fitWrap(b.label, b.w, fs); }
    }
    const fitsLines = Math.max(1, Math.floor((room - lab.length * fs * 1.15) / (dfs * 1.2)));
    if (det.length > fitsLines) det = [...det.slice(0, fitsLines - 1), `${det[fitsLines - 1].replace(/[\s,;:.]*$/, '')}…`];
    const kids = b.children && b.children.length ? [b.children.join(' · ')] : [];
    const total = lab.length * fs * 1.15 + det.length * dfs * 1.2 + (kids.length ? 22 : 0);
    const y0 = b.y + b.h / 2 - total / 2 + fs * 0.85;
    s += `<text x="${n(b.x + b.w / 2)}" y="${n(y0)}" text-anchor="middle" fill="${b.taper ? '#ffffff' : fg}" font-size="${fs}" font-weight="650">${tspans(lab, b.x + b.w / 2, fs * 1.15)}</text>`;
    if (det.length) s += `<text x="${n(b.x + b.w / 2)}" y="${n(y0 + lab.length * fs * 1.15 + 2)}" text-anchor="middle" fill="${b.taper ? '#ffffff' : mu}" font-size="${dfs}">${tspans(det, b.x + b.w / 2, dfs * 1.2)}</text>`;
    if (kids.length) s += `<text x="${n(b.x + b.w / 2)}" y="${n(b.y + b.h + 26)}" text-anchor="middle" fill="${mu}" font-size="15">${esc(wrap(kids[0], Math.floor(b.w / 8))[0] || '')}</text>`;
  });
  const label = `${d.type} diagram: ${d.items.map((it) => `${it.label}${it.detail ? ` (${it.detail})` : ''}`).join(d.type === 'flow' || d.type === 'cycle' ? ' → ' : '; ')}`;
  return `<svg class="diagram" viewBox="0 0 ${n(W)} ${n(H)}" width="${n(W)}" height="${n(H)}" role="img" aria-label="${esc(label)}" font-family="inherit">${s}</svg>`;
}

export function playbookSvg(pb, t, W, H) {
  const losY = H * 0.68;
  const cx = W * 0.5;
  const s = [];
  // Football turf field with yard lines & hash marks
  s.push(`<rect x="0" y="0" width="${n(W)}" height="${n(H)}" rx="18" fill="#0d3b26" stroke="#15803d" stroke-width="2"/>`);
  s.push(`<rect x="0" y="0" width="${n(W)}" height="${n(H * 0.14)}" rx="18" fill="#092c1c" opacity="0.75"/>`);
  for (let y = H * 0.14; y < H; y += H * 0.135) {
    const isLos = Math.abs(y - losY) < H * 0.04;
    s.push(`<line x1="16" y1="${n(y)}" x2="${n(W - 16)}" y2="${n(y)}" stroke="${isLos ? '#facc15' : 'rgba(255,255,255,0.22)'}" stroke-width="${isLos ? 3 : 1.5}" ${isLos ? 'stroke-dasharray="10,6"' : ''}/>`);
    for (const hx of [W * 0.36, W * 0.64]) {
      s.push(`<line x1="${n(hx - 6)}" y1="${n(y - 4)}" x2="${n(hx + 6)}" y2="${n(y - 4)}" stroke="rgba(255,255,255,0.28)" stroke-width="1.5"/>`);
    }
  }
  // Top header banner on field (Formation & Coverage)
  if (pb.formation) {
    s.push(`<rect x="18" y="14" width="${n(Math.min(W * 0.46, 310))}" height="28" rx="8" fill="rgba(15,23,42,0.78)" stroke="rgba(255,255,255,0.2)"/>`);
    s.push(`<text x="30" y="33" fill="#93c5fd" font-size="12.5" font-weight="700">${esc(pb.formation.slice(0, 38))}</text>`);
  }
  if (pb.coverage) {
    const cw = Math.min(W * 0.46, 310);
    s.push(`<rect x="${n(W - cw - 18)}" y="14" width="${n(cw)}" height="28" rx="8" fill="rgba(15,23,42,0.78)" stroke="rgba(255,255,255,0.2)"/>`);
    s.push(`<text x="${n(W - 30)}" y="33" text-anchor="end" fill="#fca5a5" font-size="12.5" font-weight="700">${esc(pb.coverage.slice(0, 38))}</text>`);
  }
  // Defensive X's (Secondary & LB shell)
  const defPositions = [
    [W * 0.16, losY - H * 0.16, 'CB'],
    [W * 0.84, losY - H * 0.16, 'CB'],
    [W * 0.34, losY - H * 0.20, 'SS'],
    [W * 0.66, losY - H * 0.42, 'FS'],
    [W * 0.43, losY - H * 0.15, 'WLB'],
    [W * 0.56, losY - H * 0.15, 'MLB'],
  ];
  for (const [dx, dy, dlab] of defPositions) {
    s.push(`<text x="${n(dx)}" y="${n(dy)}" text-anchor="middle" fill="rgba(252,165,165,0.78)" font-size="15" font-weight="800">✕</text>`);
    s.push(`<text x="${n(dx)}" y="${n(dy - 12)}" text-anchor="middle" fill="rgba(255,255,255,0.45)" font-size="10" font-weight="700">${dlab}</text>`);
  }
  // 5 Offensive Linemen + QB
  const olSpacing = 28;
  for (let i = -2; i <= 2; i++) {
    const ox = cx + i * olSpacing;
    if (i === 0) {
      s.push(`<rect x="${n(ox - 10)}" y="${n(losY - 6)}" width="20" height="16" rx="3" fill="#f8fafc" stroke="#0f172a" stroke-width="2"/>`);
    } else {
      s.push(`<circle cx="${n(ox)}" cy="${n(losY + 2)}" r="10" fill="#f8fafc" stroke="#0f172a" stroke-width="2"/>`);
    }
  }
  const qbx = cx, qby = losY + 46;
  s.push(`<circle cx="${n(qbx)}" cy="${n(qby)}" r="13" fill="#facc15" stroke="#0f172a" stroke-width="2.5"/>`);
  s.push(`<text x="${n(qbx)}" y="${n(qby + 4)}" text-anchor="middle" fill="#0f172a" font-size="11" font-weight="850">QB</text>`);

  // Eligible skill players & route vectors
  const defaultSlots = [
    { side: 'left', x: W * 0.13, y: losY + 4 },
    { side: 'slot-l', x: W * 0.27, y: losY + 14 },
    { side: 'te-r', x: cx + 3.2 * olSpacing, y: losY + 4 },
    { side: 'right', x: W * 0.87, y: losY + 4 },
    { side: 'back', x: cx + 38, y: losY + 46 },
  ];
  const slotMap = {
    left: { x: W * 0.13, y: losY + 4 },
    l: { x: W * 0.13, y: losY + 4 },
    'slot-l': { x: W * 0.26, y: losY + 14 },
    'te-l': { x: cx - 3.2 * olSpacing, y: losY + 4 },
    'te-r': { x: cx + 3.2 * olSpacing, y: losY + 4 },
    'slot-r': { x: W * 0.74, y: losY + 14 },
    right: { x: W * 0.87, y: losY + 4 },
    r: { x: W * 0.87, y: losY + 4 },
    back: { x: cx + 40, y: losY + 46 },
    rb: { x: cx + 40, y: losY + 46 },
  };

  const routes = (pb.routes || []).slice(0, 5);
  routes.forEach((rt, idx) => {
    const start = (rt.side && slotMap[rt.side]) || defaultSlots[idx % defaultSlots.length];
    const sx = start.x, sy = start.y;
    const isLeft = sx < cx;
    const dirToMid = isLeft ? 1 : -1;
    const dirToOut = isLeft ? -1 : 1;
    const isPrimary = Boolean(rt.primary || rt.read === 1 || idx === 0);
    const col = isPrimary ? '#facc15' : rt.read === 2 ? '#38bdf8' : '#e2e8f0';

    let pts = [[sx, sy]];
    switch (rt.route) {
      case 'seam':
        pts.push([sx, losY - H * 0.24], [sx + dirToMid * 22, losY - H * 0.48]);
        break;
      case 'post':
        pts.push([sx, losY - H * 0.26], [sx + dirToMid * 95, losY - H * 0.50]);
        break;
      case 'corner':
        pts.push([sx, losY - H * 0.24], [sx + dirToOut * 82, losY - H * 0.46]);
        break;
      case 'slant':
        pts.push([sx, losY - H * 0.08], [sx + dirToMid * 85, losY - H * 0.24]);
        break;
      case 'out':
        pts.push([sx, losY - H * 0.20], [Math.max(24, Math.min(W - 24, sx + dirToOut * 78)), losY - H * 0.20]);
        break;
      case 'in':
      case 'cross':
        pts.push([sx, losY - H * 0.22], [sx + dirToMid * 150, losY - H * 0.24]);
        break;
      case 'juke':
        pts.push([sx, losY - H * 0.18], [sx - dirToMid * 18, losY - H * 0.22], [sx + dirToMid * 74, losY - H * 0.26]);
        break;
      case 'wheel':
        pts.push([sx + dirToOut * 65, losY + 6], [sx + dirToOut * 82, losY - H * 0.36]);
        break;
      case 'flat':
      case 'check':
        pts.push([sx + dirToOut * 54, losY - H * 0.05], [Math.max(28, Math.min(W - 28, sx + dirToOut * 95)), losY - H * 0.08]);
        break;
      case 'curl':
      case 'comeback':
        pts.push([sx, losY - H * 0.24], [sx + dirToMid * 18, losY - H * 0.17]);
        break;
      case 'block':
        pts.push([sx + dirToMid * 12, losY - 12]);
        break;
      default: // go
        pts.push([sx, losY - H * 0.48]);
        break;
    }

    const poly = pts.map(([px, py]) => `${n(px)},${n(py)}`).join(' ');
    s.push(`<polyline points="${poly}" fill="none" stroke="${col}" stroke-width="${isPrimary ? 4 : 3}" stroke-linecap="round" stroke-linejoin="round"/>`);
    const [ex, ey] = pts[pts.length - 1];
    const [px0, py0] = pts[pts.length - 2] || [sx, sy];
    const ang = Math.atan2(ey - py0, ex - px0);
    const alen = 12, ahalf = 6;
    const bx = ex - alen * Math.cos(ang), by = ey - alen * Math.sin(ang);
    if (rt.route === 'block') {
      s.push(`<line x1="${n(ex - 9)}" y1="${n(ey)}" x2="${n(ex + 9)}" y2="${n(ey)}" stroke="${col}" stroke-width="3.5"/>`);
    } else {
      s.push(`<polygon points="${n(ex)},${n(ey)} ${n(bx + ahalf * Math.sin(ang))},${n(by - ahalf * Math.cos(ang))} ${n(bx - ahalf * Math.sin(ang))},${n(by + ahalf * Math.cos(ang))}" fill="${col}"/>`);
    }
    // Option route dashed secondary branch for juke/option
    if (rt.route === 'juke') {
      const [mx, my] = pts[1];
      const ox2 = Math.max(28, Math.min(W - 28, mx + dirToOut * 62)), oy2 = my - 10;
      s.push(`<line x1="${n(mx)}" y1="${n(my)}" x2="${n(ox2)}" y2="${n(oy2)}" stroke="${col}" stroke-width="2.2" stroke-dasharray="6,5" opacity="0.85"/>`);
    }
    // Receiver node & position tag
    s.push(`<circle cx="${n(sx)}" cy="${n(sy)}" r="12" fill="${isPrimary ? '#facc15' : '#2563eb'}" stroke="#ffffff" stroke-width="2.2"/>`);
    s.push(`<text x="${n(sx)}" y="${n(sy + 4)}" text-anchor="middle" fill="${isPrimary ? '#0f172a' : '#ffffff'}" font-size="10.5" font-weight="850">${esc(rt.pos.slice(0, 3))}</text>`);
    // Route read pill at tip
    if (rt.label || rt.read) {
      const tag = `${rt.read ? `[${rt.read}] ` : ''}${(rt.label || rt.route).slice(0, 24)}`;
      const tw = Math.max(66, tag.length * 6.6 + 14);
      const tx = Math.max(tw / 2 + 10, Math.min(W - tw / 2 - 10, ex));
      const ty = Math.max(52, ey - 18);
      s.push(`<rect x="${n(tx - tw / 2)}" y="${n(ty - 11)}" width="${n(tw)}" height="20" rx="6" fill="rgba(15,23,42,0.86)" stroke="${col}" stroke-width="1.2"/>`);
      s.push(`<text x="${n(tx)}" y="${n(ty + 3)}" text-anchor="middle" fill="${col}" font-size="11" font-weight="750">${esc(tag)}</text>`);
    }
  });

  if (pb.concept) {
    s.push(`<rect x="18" y="${n(H - 38)}" width="${n(W - 36)}" height="26" rx="8" fill="rgba(15,23,42,0.82)"/>`);
    s.push(`<text x="${n(cx)}" y="${n(H - 21)}" text-anchor="middle" fill="#f8fafc" font-size="12.5" font-weight="750">${esc(pb.concept.slice(0, 68))}</text>`);
  }
  return `<svg class="playbook-svg" viewBox="0 0 ${n(W)} ${n(H)}" width="${n(W)}" height="${n(H)}" role="img" aria-label="${esc(pb.concept || 'Football Playbook Diagram')}" font-family="inherit">${s.join('')}</svg>`;
}

// ── one slide ──

/**
 * One drawn slide (deck-model layoutSlide's { slide, index, part, parts, offset, fit }) as a <section>.
 * ctx: { theme, images, edit, known (cited numbers), deck, total, k (its number), labels }
 */
export function slideHtml(r, ctx) {
  const s = r.slide, t = ctx.theme, L = ctx.labels;
  RS = s;
  const E = (p) => editable(p, { edit: ctx.edit && r.index >= 0 && (r.parts === 1 || !/^title$/.test(p)) });
  const title = partTitle(r);
  const tp = r.fit.title, bp = r.fit.body;
  const kickerEl = s.kicker && r.part === 1 ? `<div class="eyebrow"${E('kicker')}><span class="eb-dot" aria-hidden="true"></span><span>${plainOr(s.kicker, 'kicker')}</span></div>` : '';
  const H = (tag, cls = 's-title') => `<header class="s-head">${kickerEl}${title ? `<${tag} class="${cls}" style="font-size:${n(tp)}px"${r.parts === 1 ? E('title') : ''}>${rich(title, ctx.known, 'title')}</${tag}>` : ''}</header>`;
  const bodyTop = M.top + (s.kicker ? 26 : 0) + (title ? Math.ceil(title.length * tp * 0.52 * 1.06 / (SLIDE_W - 2 * M.x)) * tp * 1.1 : 0) + M.gap;
  const bodyH = SLIDE_H - bodyTop - M.bottom - (s.caption ? 40 : 0) - (s.takeaway ? 56 : 0);
  const takeawayEl = s.takeaway && r.part === r.parts ? `<div class="takeaway"><span class="tk-pill">KEY TAKEAWAY</span><span class="tk-text"${E('takeaway')}>${rich(s.takeaway, ctx.known, 'takeaway')}</span></div>` : '';
  const caption = `${takeawayEl}${s.caption ? `<p class="caption"${E('caption')}>${rich(s.caption, ctx.known, 'caption')}</p>` : ''}`;
  let inner = '';
  const ctxE = { ...ctx, edit: ctx.edit && r.index >= 0 };
  const imObj = s.image && ctx.images && ctx.images[s.image];
  const imgSrc = imageData(imObj);
  const pendingQuery = !imgSrc && (s.imageQuery || s.imageGen || s.macImage);
  const sideFigure = (cls = 'side-pic') =>
    imgSrc
      ? `<figure class="${cls}"><img src="${imgSrc}" alt="${esc(s.alt || s.title || '')}">${s.alt || s.imageQuery ? `<figcaption class="pic-badge">${esc((s.alt || s.imageQuery || '').slice(0, 70))}</figcaption>` : ''}</figure>`
      : pendingQuery
        ? `<figure class="${cls} is-loading" role="img" aria-label="${esc(s.alt || L.picture)}"><div class="noimg loading-img"><div class="img-shimmer"></div><span>${esc(s.alt || pendingQuery)}</span></div></figure>`
        : '';

  switch (s.layout) {
    case 'title': {
      const hero = imgSrc
        ? `<div class="title-hero"><img src="${imgSrc}" alt="${esc(s.alt || s.title || '')}"><div class="hero-glow" aria-hidden="true"></div></div>`
        : pendingQuery
          ? `<div class="title-hero is-loading"><div class="noimg loading-img"><div class="img-shimmer"></div><span>${esc(s.alt || pendingQuery)}</span></div></div>`
          : '';
      inner = `<div class="title-split${hero ? ' with-hero' : ''}"><div class="center">${s.kicker ? `<div class="eyebrow title-eyebrow"${E('kicker')}><span class="eb-dot" aria-hidden="true"></span><span>${plainOr(s.kicker, 'kicker')}</span></div>` : '<div class="kicker"></div>'}<h1 class="s-title big" style="font-size:${n(tp)}px"${E('title')}>${rich(s.title || ctx.deck.title, ctx.known, 'title')}</h1>${s.subtitle ? `<p class="subtitle" style="font-size:${n(bp)}px"${E('subtitle')}>${rich(s.subtitle, ctx.known, 'subtitle')}</p>` : ''}<div class="title-meta"><span class="tm-chip">${ctx.total} ${esc(L.slides)}</span><span class="tm-dot">·</span><span class="tm-brand">Eden Studio</span></div></div>${hero}</div>`;
      break;
    }
    case 'section': {
      const secHero = sideFigure('sec-pic');
      inner = `<div class="section-split${secHero ? ' with-pic' : ''}"><div class="section-wrap"><div class="sec-pill"><span class="sec-n">${String(ctx.sectionNo || 1).padStart(2, '0')}</span><span class="sec-line"></span></div><h2 class="s-title big" style="font-size:${n(tp)}px"${E('title')}>${rich(s.title || '', ctx.known, 'title')}</h2>${s.subtitle ? `<p class="subtitle" style="font-size:${n(bp)}px"${E('subtitle')}>${rich(s.subtitle, ctx.known, 'subtitle')}</p>` : ''}</div>${secHero}</div>`;
      break;
    }
    case 'two-column': {
      const sidePic = imgSrc || pendingQuery ? sideFigure('side-pic cols-pic') : '';
      const colsEl = `<div class="cols">${['left', 'right'].map((side, si) => `<div class="col card col-${si}"><div class="col-bar" aria-hidden="true"></div>${s[side].heading ? `<h3 style="font-size:${n(bp * 1.08)}px"${E(`${side}.heading`)}><span class="col-num">0${si + 1}</span><span>${rich(s[side].heading, ctx.known, `${side}.heading`)}</span></h3>` : ''}${bulletList(s[side].bullets, `${side}.bullets`, bp, ctxE)}</div>`).join('')}</div>`;
      inner = `${H('h2')}${sidePic ? `<div class="split-body">${colsEl}${sidePic}</div>` : colsEl}${caption}`;
      break;
    }
    case 'grid': {
      const cards = s.cards || [];
      const sidePic = cards.length <= 2 || imgSrc || pendingQuery ? sideFigure('side-pic grid-pic') : '';
      const gridEl = `<div class="bento-grid g-${cards.length}${sidePic && cards.length === 3 ? ' with-side-pic' : ''}">${cards.map((c, ci) => `<div class="bento-card card bc-${ci % 4}"><div class="bento-top"><div class="bento-badge"${c.badge ? E(`cards.${ci}.badge`) : ''}>${(c.badge ? plainOr(c.badge, `cards.${ci}.badge`) : esc(`0${ci + 1}`))}</div><span class="bento-orb" aria-hidden="true"></span></div>${c.heading ? `<h3 style="font-size:${n(bp * 1.06)}px"${E(`cards.${ci}.heading`)}>${rich(c.heading, ctx.known, `cards.${ci}.heading`)}</h3>` : ''}${bulletList(c.bullets, `cards.${ci}.bullets`, bp, ctxE)}</div>`).join('')}</div>`;
      inner = `${H('h2')}${sidePic ? `<div class="split-body">${gridEl}${sidePic}</div>` : gridEl}${caption}`;
      break;
    }
    case 'image': {
      const needAlt = ctx.edit && !s.alt && !!imgSrc;
      const pic = imgSrc
        ? `<img src="${imgSrc}" alt="${esc(s.alt || '')}"${s.alt ? '' : ' data-noalt="1"'}>${s.alt || s.imageQuery ? `<figcaption class="pic-badge">${esc((s.alt || s.imageQuery || '').slice(0, 75))}</figcaption>` : ''}`
        : pendingQuery
          ? `<div class="noimg loading-img" role="img" aria-label="${esc(s.alt || L.picture)}"><div class="img-shimmer"></div><span>${esc(s.alt || pendingQuery)}</span></div>`
          : `<div class="noimg" role="img" aria-label="${esc(s.alt || L.picture)}">${esc(L.missing)}</div>`;
      inner = `${H('h2')}<div class="imgrow${s.bullets ? '' : ' solo'}"><figure class="pic">${pic}${needAlt ? `<span class="alt-flag">${esc(L.altNeeded)}</span>` : ''}</figure>${s.bullets ? `<div class="imgtext card">${bulletList(s.bullets, 'bullets', bp, ctxE)}</div>` : ''}</div>${caption}`;
      break;
    }
    case 'chart':
      inner = `${H('h2')}<figure class="chartbox card">${chartSvg(s.chart, t, SLIDE_W - 2 * M.x - 60, Math.max(220, bodyH - 48))}</figure>${caption || (s.chart.source ? `<p class="caption">${esc(L.source)}: ${esc(s.chart.source)}</p>` : '')}`;
      break;
    case 'table': {
      const tb = s.table;
      inner = `${H('h2')}<div class="tablebox card"><table class="${tableClass(tb)}" style="font-size:${n(bp)}px">${tb.header.length ? `<thead><tr>${tb.header.map((h, i) => `<th scope="col"${cellAlign(tb, i)}${E(`table.header.${i}`)}>${rich(h, ctx.known, `table.header.${i}`)}</th>`).join('')}</tr></thead>` : ''}<tbody>${tb.rows.map((row, ri) => `<tr>${row.map((c, ci) => `<td${cellAlign(tb, ci)}${E(`table.rows.${ri + r.offset}.${ci}`)}>${rich(c, ctx.known, `table.rows.${ri + r.offset}.${ci}`)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${caption}`;
      break;
    }
    case 'diagram':
      inner = `${H('h2')}<figure class="diagbox card">${diagramSvg(s.diagram, t, SLIDE_W - 2 * M.x - 56, Math.max(220, bodyH - 44))}</figure>${caption}`;
      break;
    case 'playbook': {
      const hasBullets = Boolean(s.bullets && s.bullets.length);
      const pbW = hasBullets ? Math.round((SLIDE_W - 2 * M.x - 28) * 0.56) : SLIDE_W - 2 * M.x - 32;
      const pbH = Math.max(260, bodyH - 16);
      const pbFig = `<figure class="playbook-box">${playbookSvg(s.playbook, t, pbW, pbH)}</figure>`;
      inner = `${H('h2')}${hasBullets ? `<div class="split-body">${pbFig}<div class="bullets-card card">${bulletList(s.bullets, 'bullets', bp, ctxE, r.offset)}</div></div>` : pbFig}${caption}`;
      break;
    }
    case 'stats': {
      const sidePic = sideFigure('side-pic stats-pic');
      const statsBlock = `<div class="stats-col"><div class="stats n${s.stats.length}">${s.stats.map((x, i) => `<div class="stat card st-${i % 4}"><div class="stat-head"><span class="stat-idx">0${i + 1}</span>${x.delta ? `<span class="stat-delta"${E(`stats.${i}.delta`)}>${plainOr(x.delta, `stats.${i}.delta`)}</span>` : ''}</div><div class="sv"${E(`stats.${i}.value`)}>${plainOr(x.value, `stats.${i}.value`)}</div><div class="sl"${E(`stats.${i}.label`)}>${rich(x.label, ctx.known, `stats.${i}.label`)}</div></div>`).join('')}</div>${s.bullets && s.bullets.length ? `<div class="stats-bullets card">${bulletList(s.bullets, 'bullets', 21, ctxE)}</div>` : ''}</div>`;
      inner = `${H('h2')}${sidePic ? `<div class="split-body">${statsBlock}${sidePic}</div>` : statsBlock}${caption}`;
      break;
    }
    case 'quote': {
      const qPic = sideFigure('quote-pic');
      inner = `<div class="quote-wrap${qPic ? ' with-pic' : ''}"><figure class="quote card"><div class="quote-mark" aria-hidden="true">“</div><blockquote style="font-size:${n(bp)}px"${E('quote')}>${rich(s.quote, ctx.known, 'quote')}</blockquote>${s.by ? `<figcaption${E('by')}><span class="q-dash"></span><span>${plainOr(s.by, 'by')}</span></figcaption>` : ''}</figure>${qPic}</div>`;
      break;
    }
    case 'sources': {
      const src = (ctx.deck.sources || []);
      inner = `<header class="s-head"><div class="eyebrow"><span class="eb-dot" aria-hidden="true"></span><span>REFERENCES &amp; CITATIONS</span></div><h2 class="s-title" style="font-size:${n(tp)}px">${esc(s.title && !s.auto ? s.title : L.sources)}</h2></header><div class="card srcs-card"><ol class="srcs">${src.map((x) => `<li value="${x.n}"><span class="st">${esc(x.title || x.url)}</span>${x.url ? `<span class="su">${esc(x.url)}</span>` : ''}</li>`).join('')}</ol></div>${r.label ? `<p class="checked"><b>${esc(L.checked)}:</b> ${esc(r.label)}</p>` : ''}`;
      break;
    }
    default: { // bullets
      const pbFig = s.playbook ? `<figure class="playbook-box">${playbookSvg(s.playbook, t, Math.round((SLIDE_W - 2 * M.x - 28) * 0.48), Math.max(250, bodyH - 16))}</figure>` : '';
      const sidePic = pbFig || sideFigure('side-pic');
      const bCard = `<div class="bullets-card card">${bulletList(s.bullets, 'bullets', bp, ctxE, r.offset)}</div>`;
      inner = `${H('h2')}${sidePic ? `<div class="split-body">${bCard}${sidePic}</div>` : bCard}${caption}`;
    }
  }
  const notes = r.part === 1 && r.slide.notes ? r.slide.notes : '';
  const name = `${L.slide} ${ctx.k} ${L.of} ${ctx.total}${title ? `: ${title}` : s.quote ? `: ${s.quote.slice(0, 60)}` : ''}`;
  const numStr = `${String(ctx.k).padStart(2, '0')} / ${String(ctx.total).padStart(2, '0')}`;
  const mo = ctx.motion ? motionOf(ctx.deck, s) : null; // web only: how it arrives and builds when presenting
  const moAttr = mo ? `${mo.transition !== 'none' ? ` data-tr="${esc(mo.transition)}"` : ''}${mo.build !== 'none' ? ` data-build="${esc(mo.build)}"` : ''}${mo.transition !== 'none' || mo.build !== 'none' ? ` data-sp="${esc(mo.speed)}"` : ''}` : '';
  const lg = brandLogo(ctx); // a brand kit's logo (web only: deck.brand is set in the web editor)
  const bgSrc = (id) => imageData(ctx.images && ctx.images[id]); // the slide's own background (deck-format-draw.js)
  return `<section class="slide l-${esc(s.layout)}${lg.cls}${backgroundClass(s, bgSrc)}${t.style ? ` st-${esc(t.style)}` : ''}${ctx.deck.template ? ' tpl' : ''}"${lg.style} data-k="${ctx.k - 1}" data-index="${r.index}" data-part="${r.part}"${moAttr} role="group" aria-roledescription="slide" aria-label="${esc(name)}"><div class="bgfx" aria-hidden="true"><div class="orb orb-1"></div><div class="orb orb-2"></div><div class="bg-grid"></div></div>${backgroundLayer(s, bgSrc)}<div class="inner">${inner}</div>${lg.html}${r.part === 1 && r.index >= 0 ? freeHtml(s, { edit: ctx.freeEdit === true, src: (id) => imageData(ctx.images && ctx.images[id]) }) : ''}${s.media && r.part === 1 ? mediaLayer(s, { live: ctx.mediaLive, images: ctx.images, imageData, labels: L }) : ''}${ctx.deck.footer ? footerHtml(ctx.deck, s, ctx.k, ctx.total) : `<div class="foot" aria-hidden="true"><span class="fd"><span class="fd-dot"></span>${esc(ctx.deck.title)}</span><span class="fn">${numStr}</span></div>`}<aside class="notes" hidden${ctx.edit && r.index >= 0 && r.part === 1 ? ' data-path="notes"' : ''}>${esc(notes)}</aside></section>`;
}

// ── the document ──

function css(t) {
  const c = t.colors;
  return `
:root{--bg:${c.bg};--bg2:${c.bg2};--surface:${c.surface};--text:${c.text};--muted:${c.muted};--accent:${c.accent};--accent2:${c.accent2};--hf:${t.heading.css};--bf:${t.body.css};--s:1;color-scheme:${t.dark ? 'dark' : 'light'}}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{font-family:var(--bf);color:var(--text);background:#e6eaf2;-webkit-font-smoothing:antialiased;overflow:hidden}
body.dark-ui{background:#0e1117}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.slide{position:relative;width:${SLIDE_W}px;height:${SLIDE_H}px;overflow:hidden;background:var(--bg);color:var(--text);flex:none}
.bgfx{position:absolute;inset:0;background:linear-gradient(135deg,var(--bg) 0%,var(--bg2) 100%);overflow:hidden}
.glass .bgfx{background:radial-gradient(65% 75% at 10% 6%,color-mix(in srgb,var(--accent) 24%,transparent),transparent 72%),radial-gradient(60% 65% at 92% 94%,color-mix(in srgb,var(--accent2) 22%,transparent),transparent 72%),linear-gradient(135deg,var(--bg),var(--bg2))}
.orb{position:absolute;border-radius:50%;filter:blur(68px);opacity:.38;pointer-events:none}
.dark .orb{opacity:.28}
.orb-1{width:520px;height:520px;top:-180px;right:-110px;background:radial-gradient(circle,var(--accent),transparent 70%)}
.orb-2{width:460px;height:460px;bottom:-180px;left:-100px;background:radial-gradient(circle,var(--accent2),transparent 70%)}
.bg-grid{position:absolute;inset:0;background-image:radial-gradient(color-mix(in srgb,var(--muted) 22%,transparent) 1px,transparent 1px);background-size:28px 28px;opacity:.45;mask-image:radial-gradient(ellipse 85% 80% at 50% 45%,#000 35%,transparent 100%);-webkit-mask-image:radial-gradient(ellipse 85% 80% at 50% 45%,#000 35%,transparent 100%)}
.inner{position:absolute;inset:44px 68px 46px;display:flex;flex-direction:column;z-index:1;overflow:hidden}
.s-head{display:flex;flex-direction:column;align-items:flex-start;margin-bottom:16px;flex:none}
.eyebrow{font-family:var(--hf);font-size:12px;font-weight:750;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);margin:0 0 8px;display:inline-flex;align-items:center;gap:8px;padding:4px 12px;border-radius:999px;background:color-mix(in srgb,var(--accent) 12%,var(--surface));border:1px solid color-mix(in srgb,var(--accent) 28%,transparent);box-shadow:0 2px 8px color-mix(in srgb,var(--accent) 10%,transparent)}
.eb-dot{width:7px;height:7px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 0 8px var(--accent);flex:none}
.title-eyebrow{font-size:13px;padding:6px 15px;margin-bottom:4px}
.title-split{margin:auto 0;display:flex;align-items:center;gap:40px;width:100%;height:100%}
.title-split.with-hero .center{flex:1.15;max-width:650px}
.title-hero{flex:.85;height:470px;border-radius:26px;overflow:hidden;position:relative;box-shadow:0 24px 60px rgba(0,0,0,.22),0 0 0 1px color-mix(in srgb,#fff 28%,transparent);background:color-mix(in srgb,var(--surface) 65%,transparent)}
.title-hero img{width:100%;height:100%;object-fit:cover;display:block}
.hero-glow{position:absolute;inset:0;border-radius:26px;box-shadow:inset 0 1px 0 rgba(255,255,255,.35),inset 0 -40px 60px rgba(0,0,0,.22);pointer-events:none}
.title-meta{display:inline-flex;align-items:center;gap:10px;margin-top:8px;font-size:14px;font-weight:600;color:var(--muted)}
.tm-chip{padding:4px 11px;border-radius:999px;background:color-mix(in srgb,var(--surface) 80%,transparent);border:1px solid color-mix(in srgb,var(--muted) 22%,transparent);color:var(--text);font-weight:650}
.tm-brand{color:var(--accent);font-weight:700}
.s-title{font-family:var(--hf);font-weight:800;letter-spacing:-.028em;line-height:1.08;margin:0;text-wrap:balance}
.s-title .cite,.bl .cite,.caption .cite,td .cite,.takeaway .cite{font-size:.55em;color:var(--accent);vertical-align:super;line-height:0;margin-left:.1em}
.center{margin:auto 0;display:flex;flex-direction:column;align-items:flex-start;gap:16px;max-width:980px}
.kicker{width:88px;height:7px;border-radius:8px;background:linear-gradient(90deg,var(--accent),var(--accent2))}
.big{margin:0;line-height:1.05}.subtitle{margin:0;color:var(--muted);line-height:1.36;font-size:23px;font-weight:450}
.section-split{margin:auto 0;display:flex;align-items:center;gap:40px;width:100%;height:100%}
.section-split.with-pic .section-wrap{flex:1.1}
.section-wrap{margin:auto 0;display:flex;flex-direction:column;gap:14px}
.sec-pill{display:inline-flex;align-items:center;gap:14px;margin-bottom:4px}
.sec-n{font-family:var(--hf);font-size:20px;font-weight:800;color:#fff;background:linear-gradient(135deg,var(--accent),var(--accent2));padding:6px 16px;border-radius:999px;box-shadow:0 6px 18px color-mix(in srgb,var(--accent) 35%,transparent)}
.sec-line{width:64px;height:3px;border-radius:3px;background:linear-gradient(90deg,var(--accent),transparent)}
.sec-pic{margin:0;flex:.9;height:430px;border-radius:26px;overflow:hidden;position:relative;box-shadow:0 20px 48px rgba(0,0,0,.18);border:1px solid color-mix(in srgb,#fff 22%,transparent)}
.sec-pic img{width:100%;height:100%;object-fit:cover;display:block}
.bl{margin:0;padding:0;list-style:none;line-height:1.3;display:flex;flex-direction:column;gap:.4em}
.bl>li{position:relative;padding-left:1.35em;margin:0}
.bl>li::before{content:"";position:absolute;left:.15em;top:.42em;width:.48em;height:.48em;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
.bl ul{margin:.24em 0 0;padding-left:1.05em;list-style:none;font-size:.86em;color:var(--muted);display:flex;flex-direction:column;gap:.2em}
.bl ul>li{position:relative;padding-left:1.05em}
.bl ul>li::before{content:"";position:absolute;left:.15em;top:.52em;width:.34em;height:.34em;border-radius:50%;background:var(--accent2);opacity:.75}
.card{background:var(--surface);border-radius:22px;padding:20px 24px;box-shadow:0 2px 4px rgba(0,0,0,.04),0 14px 34px rgba(0,0,0,.06),inset 0 1px 0 rgba(255,255,255,.55);border:1px solid color-mix(in srgb,var(--muted) 16%,transparent);position:relative;overflow:hidden}
.glass .card{background:color-mix(in srgb,var(--surface) 84%,transparent);border:1px solid color-mix(in srgb,#fff 68%,transparent);backdrop-filter:blur(24px) saturate(1.5);-webkit-backdrop-filter:blur(24px) saturate(1.5)}
.dark .card{box-shadow:0 4px 12px rgba(0,0,0,.25),0 20px 44px rgba(0,0,0,.32),inset 0 1px 0 rgba(255,255,255,.1)}
.dark .glass .card,.glass.dark .card{background:color-mix(in srgb,var(--surface) 78%,transparent);border-color:rgba(255,255,255,.14)}
.bullets-card{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center;border-left:4px solid var(--accent)}
.split-body{display:flex;gap:24px;flex:1;min-height:0;align-items:stretch}
.split-body>.bullets-card,.split-body>.bento-grid,.split-body>.stats-col,.split-body>.cols{flex:1.35;min-width:0}
.bento-grid.g-3.with-side-pic{grid-template-columns:1fr 1fr}
.bento-grid.g-3.with-side-pic>.bento-card:last-child{grid-column:1 / -1}
.side-pic.grid-pic,.side-pic.cols-pic{flex:.72;min-width:270px;max-width:360px}
.side-pic{margin:0;flex:.82;min-width:320px;max-width:430px;height:100%;border-radius:22px;overflow:hidden;position:relative;box-shadow:0 16px 38px rgba(0,0,0,.15);border:1px solid color-mix(in srgb,var(--muted) 22%,transparent);background:color-mix(in srgb,var(--surface) 60%,transparent);display:flex;align-items:center;justify-content:center}
.side-pic img{width:100%;height:100%;object-fit:cover;display:block}
.pic-badge{position:absolute;left:12px;right:12px;bottom:12px;padding:6px 12px;border-radius:10px;background:rgba(15,23,42,.74);color:#f8fafc;font-size:12.5px;font-weight:600;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border:1px solid rgba(255,255,255,.16);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:24px;flex:1;min-height:0}
.col{display:flex;flex-direction:column;min-height:0;overflow:hidden}
.col-bar{position:absolute;top:0;left:0;right:0;height:4px;background:linear-gradient(90deg,var(--accent),var(--accent2))}
.col-1 .col-bar{background:linear-gradient(90deg,var(--accent2),var(--accent))}
.col h3{font-family:var(--hf);margin:0 0 10px;color:var(--text);display:flex;align-items:center;gap:10px;flex:none}
.col-num{font-size:12px;font-weight:800;color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,transparent);padding:3px 9px;border-radius:999px;flex:none}
.col-1 .col-num{color:var(--accent2);background:color-mix(in srgb,var(--accent2) 14%,transparent)}
.bento-grid{display:grid;gap:18px;flex:1;min-height:0;grid-template-columns:1fr 1fr}
.bento-grid.g-3{grid-template-columns:repeat(3,1fr)}
.bento-grid.g-4{grid-template-columns:1fr 1fr;grid-template-rows:minmax(0,1fr) minmax(0,1fr)}
.bento-card{display:flex;flex-direction:column;min-height:0;overflow:hidden;position:relative;border-top:3px solid var(--accent);padding:16px 20px}
.bento-card.bc-1,.bento-card.bc-3{border-top-color:var(--accent2)}
.bento-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;flex:none}
.bento-badge{font-family:var(--hf);font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--accent);background:color-mix(in srgb,var(--accent) 13%,transparent);padding:3px 9px;border-radius:999px;border:1px solid color-mix(in srgb,var(--accent) 24%,transparent)}
.bc-1 .bento-badge,.bc-3 .bento-badge{color:var(--accent2);background:color-mix(in srgb,var(--accent2) 13%,transparent);border-color:color-mix(in srgb,var(--accent2) 24%,transparent)}
.bento-orb{width:8px;height:8px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent2));opacity:.65}
.bento-card h3{font-family:var(--hf);margin:0 0 8px;color:var(--text);line-height:1.16;font-weight:750;flex:none}
.takeaway{margin-top:12px;padding:9px 16px;border-radius:14px;background:linear-gradient(90deg,color-mix(in srgb,var(--accent) 12%,var(--surface)),color-mix(in srgb,var(--accent2) 8%,var(--surface)));border:1px solid color-mix(in srgb,var(--accent) 28%,transparent);font-size:16px;font-weight:600;color:var(--text);display:flex;align-items:center;gap:12px;box-shadow:0 4px 12px rgba(0,0,0,.04);flex:none}
.tk-pill{font-family:var(--hf);font-size:10.5px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#fff;background:linear-gradient(135deg,var(--accent),var(--accent2));padding:4px 9px;border-radius:999px;flex:none}
.tk-text{flex:1;min-width:0;line-height:1.25}
.imgrow{display:flex;gap:32px;flex:1;min-height:0;align-items:stretch}.pic{margin:0;flex:1.12;height:100%;display:flex;align-items:center;justify-content:center;position:relative;min-width:0;border-radius:24px;overflow:hidden;background:color-mix(in srgb,var(--surface) 55%,transparent);box-shadow:0 16px 40px rgba(0,0,0,.18);border:1px solid color-mix(in srgb,var(--muted) 20%,transparent)}
.imgrow.solo .pic{flex:1}.pic img{width:100%;height:100%;border-radius:24px;object-fit:cover;display:block}
.imgtext{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;border-left:4px solid var(--accent)}.noimg{width:100%;height:100%;border:2px dashed color-mix(in srgb,var(--muted) 40%,transparent);border-radius:22px;display:flex;flex-direction:column;gap:12px;align-items:center;justify-content:center;color:var(--muted);font-size:19px;padding:24px;text-align:center}
.loading-img .img-shimmer{width:52px;height:52px;border-radius:16px;background:linear-gradient(135deg,var(--accent),var(--accent2));opacity:.45}
.alt-flag{position:absolute;top:12px;left:12px;background:#b00020;color:#fff;font-size:14px;font-weight:650;padding:4px 10px;border-radius:8px}
.chartbox,.diagbox{margin:0;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:18px 22px}.chartbox svg,.diagbox svg{width:100%;height:100%}
.playbook-box{margin:0;flex:1.25;min-height:0;display:flex;align-items:center;justify-content:center;border-radius:20px;overflow:hidden;box-shadow:0 16px 38px rgba(0,0,0,.22)}.playbook-box svg{width:100%;height:100%;display:block}
.caption{margin:8px 0 0;color:var(--muted);font-size:16px}
.tablebox{flex:1;min-height:0;overflow:hidden;padding:18px 22px}.tbl{width:100%;border-collapse:separate;border-spacing:0;line-height:1.24}
.tbl th{text-align:left;background:linear-gradient(90deg,var(--accent),color-mix(in srgb,var(--accent) 75%,var(--accent2)));color:#fff;padding:12px 16px;font-weight:700;font-size:.94em;letter-spacing:.02em}.tbl th:first-child{border-radius:12px 0 0 0}.tbl th:last-child{border-radius:0 12px 0 0}
.tbl td{padding:11px 16px;border-bottom:1px solid color-mix(in srgb,var(--muted) 20%,transparent)}.tbl tr:nth-child(even) td{background:color-mix(in srgb,var(--surface) 55%,transparent)}
.stats-col{display:flex;flex-direction:column;gap:20px;flex:1;min-height:0;justify-content:center}
.stats{display:grid;gap:22px}.stats.n1{grid-template-columns:1fr}.stats.n2{grid-template-columns:1fr 1fr}.stats.n3{grid-template-columns:repeat(3,1fr)}.stats.n4{grid-template-columns:repeat(4,1fr)}
.stat{text-align:left;position:relative;border-top:3px solid var(--accent)}
.stat.st-1,.stat.st-3{border-top-color:var(--accent2)}
.stat-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.stat-idx{font-family:var(--hf);font-size:12px;font-weight:800;color:var(--muted);opacity:.75}
.stat-delta{display:inline-block;font-size:13px;font-weight:750;color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,transparent);padding:3px 10px;border-radius:999px;border:1px solid color-mix(in srgb,var(--accent) 26%,transparent)}
.sv{font-family:var(--hf);font-size:62px;font-weight:850;letter-spacing:-.035em;line-height:1.05;background:linear-gradient(120deg,var(--accent),var(--accent2));-webkit-background-clip:text;background-clip:text;color:transparent}
.sl{font-size:19px;color:var(--muted);margin-top:8px;line-height:1.28;font-weight:500}
.stats-bullets{padding:18px 24px}
.quote-wrap{margin:auto 0;display:flex;align-items:center;gap:36px;flex:1;min-height:0}
.quote-wrap.with-pic .quote{flex:1.25}
.quote-pic{margin:0;flex:.75;height:420px;border-radius:26px;overflow:hidden;position:relative;box-shadow:0 20px 48px rgba(0,0,0,.22);border:1px solid color-mix(in srgb,#fff 22%,transparent)}
.quote-pic img{width:100%;height:100%;object-fit:cover;display:block}
.quote{margin:auto 0;padding:42px 48px;position:relative;border-left:5px solid var(--accent);flex:1}
.quote-mark{font-family:var(--hf);font-size:96px;line-height:.6;color:var(--accent);opacity:.28;margin-bottom:12px;user-select:none}
.quote blockquote{margin:0;font-family:var(--hf);font-weight:650;line-height:1.32;letter-spacing:-.015em}
.quote figcaption{margin-top:22px;font-size:22px;font-weight:600;color:var(--accent);display:flex;align-items:center;gap:12px}
.q-dash{width:28px;height:3px;border-radius:3px;background:linear-gradient(90deg,var(--accent),var(--accent2))}
.srcs-card{flex:1;min-height:0;overflow:hidden}
.srcs{margin:0;padding-left:1.5em;font-size:18px;line-height:1.34;columns:2;column-gap:44px}.srcs li{margin:0 0 12px;break-inside:avoid}.srcs .st{display:block;font-weight:600}.srcs .su{display:block;color:var(--muted);font-size:14px;word-break:break-all}
.checked{margin-top:12px;font-size:16px;color:var(--muted)}
.foot{position:absolute;left:${M.x}px;right:${M.x}px;bottom:16px;display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:600;color:var(--muted);opacity:.85;z-index:1}
.fd{display:inline-flex;align-items:center;gap:8px}
.fd-dot{width:6px;height:6px;border-radius:50%;background:var(--accent)}
.fn{font-family:var(--hf);font-variant-numeric:tabular-nums;padding:3px 10px;border-radius:999px;background:color-mix(in srgb,var(--surface) 75%,transparent);border:1px solid color-mix(in srgb,var(--muted) 20%,transparent);font-size:12px;font-weight:700;color:var(--text)}
.l-title .foot,.l-section .foot{display:none}
.brand-logo{position:absolute;z-index:2;object-fit:contain;pointer-events:none}
.lg-br .foot{right:calc(var(--lw) + 40px)}.lg-bl .foot{left:calc(var(--lw) + 40px)}
.lg-tr .s-head{margin-right:max(0px,calc(var(--lw) - 30px))}.lg-tl .s-head{margin-left:max(0px,calc(var(--lw) - 30px))}
[data-path]{outline:none;border-radius:6px;transition:box-shadow .15s}
.mode-edit [data-path]:hover{box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 45%,transparent);cursor:text}
.mode-edit [data-path]:focus{box-shadow:0 0 0 3px var(--accent);background:color-mix(in srgb,var(--surface) 40%,transparent)}
/* the viewer */
#app{position:fixed;inset:0;display:flex;flex-direction:column}
#main{flex:1;min-height:0;display:flex}
#strip{width:184px;flex:none;overflow-y:auto;padding:12px 10px;display:flex;flex-direction:column;gap:10px;border-right:1px solid rgba(0,0,0,.08)}
.dark-ui #strip{border-color:rgba(255,255,255,.1)}
.thumb{text-align:left;color:inherit;font:inherit;line-height:normal;position:relative;flex:none;width:160px;height:90px;border-radius:9px;overflow:hidden;border:2px solid transparent;background:none;padding:0;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.15)}
.thumb.on{border-color:var(--accent)}.thumb.drop{box-shadow:0 -4px 0 0 var(--accent)}
.thumb .slide{transform:scale(.125);transform-origin:0 0;pointer-events:none}
.thumb .tn{position:absolute;left:4px;bottom:3px;font:600 11px -apple-system,system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.55);border-radius:5px;padding:1px 5px}
#stage{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:safe center;padding:14px;gap:10px;position:relative}
#frame{position:relative;width:calc(${SLIDE_W}px * var(--s));height:calc(${SLIDE_H}px * var(--s));flex:none;border-radius:calc(14px * var(--s) + 2px);overflow:hidden;box-shadow:0 2px 6px rgba(0,0,0,.12),0 18px 50px rgba(0,0,0,.14)}
#frame>.slide{position:absolute;left:0;top:0;transform:scale(var(--s));transform-origin:0 0}
#frame>.slide:not(.cur){display:none}
#frame>.slide.leaving{display:block;z-index:1}#frame>.slide.cur{z-index:2}.b-hidden{visibility:hidden}
#bar{display:flex;gap:6px;flex-wrap:nowrap;overflow-x:auto;max-width:100%;align-items:center;font:12.5px -apple-system,system-ui,sans-serif;scrollbar-width:none;padding:2px}#bar::-webkit-scrollbar{display:none}#bar button{flex:none;white-space:nowrap}#bar .sep{flex:none;width:1px;height:20px;background:rgba(127,127,127,.3)}
#bar button,#pv button,#ov-close{font:inherit;font-weight:550;border:1px solid rgba(0,0,0,.12);background:rgba(255,255,255,.75);color:#1c1f26;border-radius:999px;padding:5px 11px;cursor:pointer}
.dark-ui #bar button,.dark-ui #pv button{background:rgba(255,255,255,.08);color:#eef0f5;border-color:rgba(255,255,255,.16)}
.progressive #bar{flex-wrap:wrap;overflow:visible;justify-content:center}
.progressive #bar button,.progressive #bar summary{min-height:40px}
.progressive .slide-tools summary{cursor:pointer;padding:8px 12px;border:1px solid rgba(0,0,0,.12);border-radius:14px;background:#f7f7f9;color:#1d1d1f}
.progressive.dark-ui .slide-tools summary{background:#242426;color:#f5f5f7;border-color:rgba(255,255,255,.16)}
.progressive .slide-tools[open]{flex-basis:100%}
.progressive .slide-tools>div{display:flex;flex-wrap:wrap;gap:6px;padding:8px;max-height:130px;overflow:auto}
.progressive summary:focus-visible{outline:3px solid #2f6df6;outline-offset:2px}
@media (max-height:460px){.progressive.mode-edit .hint{display:none}.progressive.mode-edit #notesbox{max-height:2.9em;padding:4px 10px}.progressive.mode-edit #bar button,.progressive.mode-edit #bar summary{min-height:32px}}
#bar button:focus-visible,.thumb:focus-visible,#pv button:focus-visible{outline:3px solid #2f6df6;outline-offset:2px}
#bar .pos{color:#5b6475;min-width:70px;text-align:center}.dark-ui #bar .pos{color:#a3abbd}
#notesbox{width:min(100%,calc(${SLIDE_W}px * var(--s)));font:14px/1.45 -apple-system,system-ui,sans-serif;color:#2b2f38;background:rgba(255,255,255,.7);border:1px solid rgba(0,0,0,.08);border-radius:12px;padding:8px 12px;max-height:18vh;overflow:auto}
.dark-ui #notesbox{background:rgba(255,255,255,.06);color:#dfe3ec;border-color:rgba(255,255,255,.12)}
#notesbox .nl{font-weight:650;font-size:12px;color:#7a8191;margin-bottom:2px}#notesbox [data-path]{display:block;white-space:pre-wrap;min-height:1.4em}
.hint{font:12px -apple-system,system-ui,sans-serif;color:#7a8191;text-align:center;margin:0}
.mode-present #strip,.mode-present #notesbox,.mode-present .hint,.mode-present .edit-only{display:none!important}
.mode-present{background:#000}.mode-present #stage{padding:0}.mode-present #frame{border-radius:0;box-shadow:none}
.mode-present #bar{position:absolute;bottom:10px;left:50%;transform:translateX(-50%);opacity:0;transition:opacity .25s;background:rgba(20,22,28,.7);padding:6px 8px;border-radius:999px;-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px)}
.mode-present #bar button{background:transparent;color:#fff;border-color:rgba(255,255,255,.2)}.mode-present #bar .pos{color:#ccd}
.mode-present #bar:hover,.mode-present #bar:focus-within,.mode-present.show-bar #bar{opacity:1}
.mode-present.blank #frame{visibility:hidden}
#laser{position:fixed;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:radial-gradient(circle,#ff3b30 35%,rgba(255,59,48,.35) 60%,transparent 70%);pointer-events:none;display:none;z-index:9}
.laser #laser{display:block}.laser #frame{cursor:none}
#ov{position:fixed;inset:0;background:rgba(10,12,18,.92);overflow:auto;padding:24px;display:none;z-index:8}
.overview #ov{display:block}#ov .grid{display:flex;flex-wrap:wrap;gap:16px;justify-content:center}
#ov .thumb{width:240px;height:135px}#ov .thumb .slide{transform:scale(.1875)}#ov>h2{color:#fff;font:600 16px -apple-system,system-ui,sans-serif;margin:0 0 14px}
#ov-close{position:absolute;top:16px;right:110px}
#presentation-exit{position:fixed;top:max(10px,env(safe-area-inset-top));right:10px;z-index:10;min-width:40px;min-height:40px;padding:8px 16px;border:1px solid rgba(255,255,255,.4);border-radius:999px;background:#202228;color:#fff;font:600 13px -apple-system,system-ui,sans-serif;cursor:pointer}
#presentation-exit[hidden]{display:none}
#presentation-exit:focus-visible{outline:3px solid #0a84ff;outline-offset:2px}
#pv{display:none;position:fixed;inset:0;background:#101217;color:#eef0f5;font:15px -apple-system,system-ui,sans-serif;z-index:7;padding:18px;gap:18px;grid-template-columns:62% 1fr;grid-template-rows:1fr auto}
.presenter #pv{display:grid}.presenter #frame{visibility:hidden}
#pv .now,#pv .nxt{position:relative;overflow:hidden;border-radius:10px;background:#000}
#pv .now{align-self:start}#pv .now .slide,#pv .nxt .slide{position:absolute;left:0;top:0;transform-origin:0 0}
#pv .side{display:flex;flex-direction:column;gap:10px;min-height:0;overflow:auto}#pv .nxt{flex:none}#pv .nl{color:#9aa3b5;font-size:12px;font-weight:650;text-transform:uppercase;letter-spacing:.06em}
#pv .pvnotes{flex:1 0 auto;white-space:pre-wrap;font-size:20px;line-height:1.45}#pv .clock{font-variant-numeric:tabular-nums;font-size:30px;font-weight:650}
#pv .ctl{grid-column:1/3;display:flex;gap:8px;align-items:center}
@media (max-width:640px){#main{flex-direction:column-reverse}#strip{width:auto;height:84px;flex-direction:row;overflow-x:auto;overflow-y:hidden;border-right:0;border-top:1px solid rgba(0,0,0,.08);padding:8px}
.thumb{width:112px;height:63px}.thumb .slide{transform:scale(.0875)}#stage{padding:8px}#pv{grid-template-columns:1fr;grid-template-rows:auto 1fr auto;overflow:auto}#pv .ctl{grid-column:auto;flex-wrap:wrap}}
/* print: one slide a page */
.mode-static{background:#fff;overflow:visible}.mode-static .slide{page-break-after:always;break-after:page}
@page{size:13.333in 7.5in;margin:0}
@media print{body{background:#fff;overflow:visible}.slide{page-break-after:always;break-after:page;-webkit-print-color-adjust:exact;print-color-adjust:exact}#app{position:static}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`;
}

/**
 * The deck as a whole HTML document. opts: { images: { id: { data, w, h } }, mode: 'edit'|'present'|'static',
 * start (slide number from 0), label (Eden's check, on the sources slide), labels, darkUi, lang }
 */
export function deckDocument(deck, opts = {}) {
  const mode = ['edit', 'present', 'static'].includes(opts.mode) ? opts.mode : 'present';
  const t = themeOf(deck);
  const L = { ...LABELS, ...(opts.labels || {}) };
  const drawn = layoutDeck(deck, { label: opts.label || '' });
  const known = new Set((deck.sources || []).map((s) => s.n));
  let sectionNo = 0;
  const total = drawn.length;
  const slides = drawn.map((r, k) => {
    if (r.slide.layout === 'section') sectionNo++;
    return slideHtml(r, { theme: t, images: opts.images || {}, edit: mode === 'edit', known, deck, total, k: k + 1, labels: L, sectionNo, motion: mode !== 'static' && opts.motion === true, mediaLive: mode !== 'static' && opts.media === true, freeEdit: mode === 'edit' && opts.progressive === true });
  }).join('\n').replace(/<section class="slide /g, deck.lang ? `<section lang="${esc(deck.lang)}"${/^(ar|he|fa|ur|yi|ps|sd|dv|ku)(-|$)/i.test(deck.lang) ? ' dir="rtl"' : ''} class="slide ` : '$&'); // a translated deck (deck-translate.js): its language, right to left where it reads that way
  const themeCls = `${t.glass ? 'glass' : ''}${t.dark ? ' dark' : ''}`;
  const head = `<!doctype html><html lang="${esc(opts.lang || 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(deck.title)}</title><style>${fontFaceCss(opts.fonts)}${css(t)}${styleCss(t)}${deck.slides.some((x) => x.media) ? MEDIA_CSS : ''}${opts.progressive === true || deck.slides.some((x) => x.free) ? FREE_CSS : ''}${FORMAT_CSS}${opts.progressive === true || deck.slides.some((x) => x.fmt) ? RICH_CSS : ''}${opts.progressive === true && mode === 'edit' ? SHELL_FRAME_CSS : ''}</style></head>`; // opts.fonts: a brand kit's uploaded faces (web only)
  if (mode === 'static') return `${head}<body class="mode-static ${themeCls}">${slides}</body></html>`;
  const cfg = { mode, start: Math.max(0, Math.min(total - 1, Math.floor(opts.start || 0))), total, labels: L, embedded: opts.embedded !== false, persistentExit: opts.persistentExit === true, progressive: opts.progressive === true, motion: opts.motion === true };
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const B = (id, label, cls = '') => `<button type="button" id="${id}"${cls ? ` class="${cls}"` : ''}>${esc(label)}</button>`;
  return `${head}<body class="mode-${mode} ${themeCls}${opts.darkUi ? ' dark-ui' : ''}${cfg.progressive ? ' progressive' : ''}">
<div id="app"><div id="main"><nav id="strip" aria-label="${esc(L.slides)}"></nav>
<div id="stage"><div id="frame" class="${themeCls}">${slides}</div>
<div id="bar" role="toolbar" aria-label="${esc(L.slides)}">${B('b-prev', `← ${L.prev}`)}<span class="pos" id="pos" aria-hidden="true"></span>${B('b-next', `${L.next} →`)}${B('b-ov', L.overview)}${B('b-pv', L.presenter, 'pres-only')}${B('b-laser', L.laser, 'pres-only')}<span class="sep edit-only" aria-hidden="true"></span>${cfg.progressive ? '<details class="edit-only slide-tools"><summary>Slide tools</summary><div>' : ''}${B('b-layout', L.magicLayout, 'edit-only')}${B('b-photo', L.swapPhoto, 'edit-only')}${B('b-ai', L.aiVisual, 'edit-only')}${B('b-play', L.playbook, 'edit-only')}${B('b-regen', L.regen, 'edit-only')}${B('b-short', L.shorter, 'edit-only')}${B('b-expand', L.expand, 'edit-only')}${B('b-add', L.add, 'edit-only')}${B('b-dup', L.dup, 'edit-only')}${B('b-up', L.up, 'edit-only')}${B('b-down', L.down, 'edit-only')}${B('b-del', L.del, 'edit-only')}${cfg.progressive ? '</div></details>' : ''}</div>
<div id="notesbox" aria-label="${esc(L.notes)}"><div class="nl">${esc(L.notes)}</div><div id="notesed"></div></div><p class="hint">${esc(L.editHint)}</p></div></div></div>
<div id="ov" role="dialog" aria-modal="true" aria-label="${esc(L.overview)}"><h2>${esc(L.overview)}</h2><button type="button" id="ov-close">${esc(L.exit)}</button><div class="grid"></div></div>
<div id="pv" role="region" aria-label="${esc(L.presenter)}"><div class="now"></div><div class="side"><div class="nl">${esc(L.next)}</div><div class="nxt"></div><div class="nl">${esc(L.timer)}</div><div class="clock" id="pv-timer">0:00</div><div class="nl">${esc(L.notes)}</div><div class="pvnotes" id="pv-notes"></div></div><div class="ctl">${B('pv-prev', `← ${L.prev}`)}${B('pv-next', `${L.next} →`)}<span id="pv-pos"></span>${B('pv-reset', L.reset)}${B('pv-exit', L.exit)}</div></div>
${cfg.persistentExit && cfg.embedded ? B('presentation-exit', L.exit) : ''}
<div id="laser" aria-hidden="true"></div><div id="live" class="sr-only" aria-live="polite"></div>
<script>(${viewer.toString()})(${json});</script>${cfg.progressive && mode === 'edit' && cfg.embedded ? `<script>(${freeEditor.toString()})(${json});</script>` : ''}${opts.media === true && cfg.embedded && deck.slides.some((x) => x.media) ? `<script>(${mediaFrame.toString()})();</script>` : ''}${cfg.progressive && mode === 'edit' && cfg.embedded ? `<script>(${frameScript.toString()})();</script>` : ''}${cfg.progressive && mode === 'edit' && cfg.embedded ? `<script>(${richFrame.toString()})();</script>` : ''}${cfg.progressive && mode === 'edit' && cfg.embedded ? `<script>(${arrangeFrame.toString()})();</script>` : ''}${cfg.progressive && mode === 'edit' && cfg.embedded ? `<script>(${marksFrame.toString()})();</script>` : ''}${cfg.progressive && mode === 'edit' && cfg.embedded ? `<script>(${aiFrame.toString()})();</script>` : ''}${cfg.progressive && mode === 'edit' && cfg.embedded ? `<script>(${shellFrame.toString()})();</script>` : ''}${cfg.progressive && mode === 'edit' && cfg.embedded ? `<script>(${liveFrame.toString()})();</script>` : ''}</body></html>`;
}

/* The viewer: runs inside the sandboxed document only (stringified above; never in Eden's page). */
function viewer(cfg) {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const body = document.body;
  const slides = [...document.querySelectorAll('#frame > .slide')];
  const L = cfg.labels;
  let k = cfg.start || 0;
  let mode = cfg.mode;
  const post = (m) => { if (cfg.embedded && window.parent !== window) window.parent.postMessage(m, '*'); }; // the page checks event.source; nothing secret is sent
  // scale the slide to the stage
  function fit() {
    const stage = $('stage');
    const pad = mode === 'present' ? 0 : 28 + (window.edenPad || 0); // (the editor's rulers: deck-arrange-frame.js)
    const hint = document.querySelector('.hint');
    const reserve = mode === 'present' ? 0 : $('bar').offsetHeight + $('notesbox').offsetHeight + (hint ? hint.offsetHeight : 0) + 3 * 10 + 6;
    const z = mode === 'edit' && window.edenZoom > 0 ? window.edenZoom : 0; // the editor's zoom (deck-arrange-frame.js); 0 fits
    const s = z || Math.max(0.1, Math.min((stage.clientWidth - pad) / 1280, (stage.clientHeight - reserve - (window.edenPad || 0)) / 720));
    document.documentElement.style.setProperty('--s', String(s));
    shrinkOverflow(slides[k]);
    if (body.classList.contains('presenter')) drawPresenter();
  }
  // a font wider than estimated: shrink the box's text until it fits inside its card AND slide (once per slide)
  function shrinkOverflow(sl) {
    if (!sl || sl.dataset.fitted) return;
    sl.dataset.fitted = '1';
    for (const titleEl of sl.querySelectorAll('.s-title')) {
      let g = 0;
      const maxH = sl.classList.contains('l-title') || sl.classList.contains('l-section') ? 210 : 108;
      while (titleEl.offsetHeight > maxH && g++ < 10) {
        const px = parseFloat(getComputedStyle(titleEl).fontSize);
        if (px <= 24) break;
        titleEl.style.fontSize = `${px * 0.92}px`;
      }
    }
    for (const card of sl.querySelectorAll('.bento-card, .col, .bullets-card, .imgtext, .tablebox, .stat, .stats-bullets, .quote, .srcs-card')) {
      let g = 0;
      while ((card.scrollHeight > card.clientHeight + 2 || card.scrollWidth > card.clientWidth + 4) && g++ < 16) {
        const bl = card.querySelector('.bl, .tbl, blockquote, .srcs, .sl');
        const h3 = card.querySelector('h3, .sv');
        if (bl) {
          const px = parseFloat(getComputedStyle(bl).fontSize);
          if (px > 11.5) bl.style.fontSize = `${px * 0.92}px`;
        }
        if (h3) {
          const hpx = parseFloat(getComputedStyle(h3).fontSize);
          if (hpx > 14) h3.style.fontSize = `${hpx * 0.93}px`;
        }
        if (g > 6) {
          card.style.paddingTop = '12px';
          card.style.paddingBottom = '12px';
        }
      }
    }
    for (const box of sl.querySelectorAll('.bl, .tbl, .subtitle, .quote blockquote, .imgtext .bl')) {
      const holder = box.closest('.inner');
      let guard = 0;
      while (holder && holder.scrollHeight > holder.clientHeight + 2 && guard++ < 14) {
        const px = parseFloat(getComputedStyle(box).fontSize);
        if (px <= 11.5) break;
        box.style.fontSize = `${px * 0.92}px`;
      }
    }
  }
  function notesOf(sl) { const a = sl.querySelector('aside.notes'); return a ? a.textContent : ''; }
  // motion (web only: cfg.motion): the slide's transition in, and its content building — on its own (fade, rise) or
  // one piece per Next ('steps'); Previous takes a piece back first. Reduced motion: nothing moves, steps still step.
  const UNIT = '.fr-el,.subtitle,.title-meta,.title-hero,.sec-pic,.col,.bento-card,.quote,.stat,.chartbox,.diagbox,.tablebox,.playbook-box,figure.pic,.side-pic,.quote-pic,.takeaway,.caption';
  const SPEED = { fast: 300, medium: 500, slow: 800 };
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const moving = () => cfg.motion && mode === 'present';
  let items = [], step = 0, running = [];
  function buildItems(sl) { // the pieces, in reading order: a card, stat or figure whole; a loose bullet on its own
    const all = [...sl.querySelectorAll(`${UNIT},.bl > li`)].filter((e) => !e.closest('.s-head,.foot,aside'));
    return all.filter((e) => !all.some((o) => o !== e && o.contains(e)));
  }
  function settle() { for (const a of running) { try { a.finish(); } catch { /* gone */ } } running = []; slides.forEach((s) => s.classList.remove('leaving')); }
  const dur = (sl) => SPEED[sl.dataset.sp] || SPEED.medium;
  function reveal(el, kind, delay = 0, sl = slides[k]) {
    el.classList.remove('b-hidden');
    if (still() || !el.animate) return;
    const frames = kind === 'fade' ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, translate: '0 28px' }, { opacity: 1, translate: '0 0' }];
    running.push(el.animate(frames, { duration: dur(sl) * 0.9, delay, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'backwards' }));
  }
  function transition(out, inn, dir) {
    const tr = inn.dataset.tr;
    if (!tr || tr === 'none' || still() || !inn.animate) return 0;
    const f = $('frame'), W = f.clientWidth, H = f.clientHeight, o = { duration: dur(inn), easing: 'cubic-bezier(.2,.7,.2,1)' };
    if (out && out !== inn) out.classList.add('leaving');
    let a, gone = null;
    if (tr === 'push' && out && out !== inn) {
      const d = dir < 0 ? -1 : 1;
      running.push(gone = out.animate([{ translate: '0 0' }, { translate: `${-d * W}px 0` }], { ...o, fill: 'forwards' }));
      a = inn.animate([{ translate: `${d * W}px 0` }, { translate: '0 0' }], o);
    } else if (tr === 'wipe') a = inn.animate([{ clipPath: dir < 0 ? 'inset(0 0 0 100%)' : 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], o);
    else if (tr === 'zoom') a = inn.animate([{ opacity: 0, scale: 0.9, translate: `${W * 0.05}px ${H * 0.05}px` }, { opacity: 1, scale: 1, translate: '0 0' }], o); // from the middle (the slide scales from its corner)
    else a = inn.animate([{ opacity: 0 }, { opacity: 1 }], o);
    running.push(a);
    const done = () => { if (out) out.classList.remove('leaving'); if (gone) { gone.cancel(); running = running.filter((x) => x !== gone); } }; // its fill would bring the slide back off-screen (Firefox)
    a.finished.then(done, done);
    return o.duration;
  }
  function enter(prev, dir) {
    slides.forEach((s) => s.querySelectorAll('.b-hidden').forEach((e) => e.classList.remove('b-hidden')));
    items = []; step = 0;
    if (!moving()) return;
    const sl = slides[k], build = sl.dataset.build;
    const after = prev === null ? 0 : transition(slides[prev], sl, dir) * 0.6;
    if (build === 'steps') { items = buildItems(sl); if (dir < 0) step = items.length; else items.forEach((e) => e.classList.add('b-hidden')); }
    else if (build === 'fade' || build === 'rise') buildItems(sl).forEach((e, i) => reveal(e, build, after + 80 + i * 90));
  }
  /** The editor's Preview: the current slide's transition and build, played once in place. */
  function preview() {
    if (!cfg.motion) return;
    settle();
    const sl = slides[k], build = sl.dataset.build, list = buildItems(sl);
    const after = transition(k > 0 ? slides[k - 1] : null, sl, 1) * 0.6;
    if (build === 'steps') { list.forEach((e) => e.classList.add('b-hidden')); list.forEach((e, i) => setTimeout(() => reveal(e, 'rise', 0, sl), after + 300 + i * 450)); }
    else if (build === 'fade' || build === 'rise') list.forEach((e, i) => reveal(e, build, after + 80 + i * 90, sl));
  }
  function go(i, { announce = true } = {}) {
    if (moving() && items.length) { // a build step before the next slide, and back
      if (i === k + 1 && step < items.length) { settle(); reveal(items[step], 'rise'); $('live').textContent = items[step].textContent.replace(/\s+/g, ' ').trim().slice(0, 300); step++; return; }
      if (i === k - 1 && step > 0) { settle(); step--; items[step].classList.add('b-hidden'); return; }
    }
    if (mode === 'present' && slides[i] && slides[i].dataset.hide) { // a hidden slide (deck-arrange-frame.js marks them) is skipped
      const d = i >= k ? 1 : -1;
      let j = i;
      while (slides[j] && slides[j].dataset.hide) j += d;
      if (!slides[j]) { if (slides[k] && !slides[k].dataset.hide) return; j = slides.findIndex((s) => !s.dataset.hide); if (j < 0) j = i; }
      i = j;
    }
    const prev = k;
    settle();
    k = Math.max(0, Math.min(slides.length - 1, i));
    slides.forEach((s, j) => { s.classList.toggle('cur', j === k); s.toggleAttribute('inert', j !== k); s.setAttribute('aria-hidden', String(j !== k)); });
    $('pos').textContent = `${k + 1} / ${slides.length}`;
    shrinkOverflow(slides[k]);
    document.querySelectorAll('#strip .thumb').forEach((t, j) => { t.classList.toggle('on', j === k); t.setAttribute('aria-current', j === k ? 'true' : 'false'); if (j === k && mode === 'edit') t.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
    drawNotes();
    if (body.classList.contains('presenter')) drawPresenter();
    if (announce) $('live').textContent = slides[k].getAttribute('aria-label') + (k === slides.length - 1 && mode === 'present' ? `. ${L.end}.` : '');
    post({ type: 'deck-at', k, index: Number(slides[k].dataset.index), part: Number(slides[k].dataset.part) });
    enter(prev === k ? null : prev, k >= prev ? 1 : -1);
  }
  function drawNotes() {
    const box = $('notesed');
    const a = slides[k].querySelector('aside.notes');
    box.replaceChildren();
    const d = document.createElement('div');
    d.textContent = a ? a.textContent : '';
    if (a && a.dataset.path && mode === 'edit') { d.dataset.path = 'notes'; d.dataset.index = slides[k].dataset.index; d.setAttribute('role', 'textbox'); d.setAttribute('aria-multiline', 'true'); d.setAttribute('aria-label', L.notes); d.tabIndex = 0; }
    if (!d.textContent && !(a && a.dataset.path)) d.textContent = L.noNotes;
    box.append(d);
  }
  function thumb(sl, j) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'thumb'; b.dataset.k = String(j);
    b.setAttribute('aria-label', sl.getAttribute('aria-label'));
    const c = sl.cloneNode(true);
    c.classList.add('cur'); c.removeAttribute('inert'); c.setAttribute('aria-hidden', 'true');
    c.querySelectorAll('[data-path]').forEach((e) => e.removeAttribute('data-path'));
    c.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));
    c.classList.remove('leaving'); c.querySelectorAll('.b-hidden').forEach((e) => e.classList.remove('b-hidden'));
    const wrap = document.createElement('div'); wrap.className = document.getElementById('frame').className; wrap.append(c);
    const tn = document.createElement('span'); tn.className = 'tn'; tn.textContent = String(j + 1);
    b.append(wrap, tn);
    return b;
  }
  function buildStrip() {
    const strip = $('strip');
    if (mode !== 'edit') return;
    strip.replaceChildren(...slides.map(thumb));
    let dragFrom = -1;
    strip.querySelectorAll('.thumb').forEach((t) => {
      const j = Number(t.dataset.k);
      const sl = slides[j];
      const movable = Number(sl.dataset.index) >= 0 && sl.dataset.part === '1';
      t.addEventListener('click', () => go(j));
      t.draggable = movable;
      t.addEventListener('dragstart', (e) => { dragFrom = j; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(j)); });
      t.addEventListener('dragover', (e) => { if (dragFrom < 0) return; e.preventDefault(); t.classList.add('drop'); });
      t.addEventListener('dragleave', () => t.classList.remove('drop'));
      t.addEventListener('drop', (e) => { e.preventDefault(); t.classList.remove('drop'); const to = Number(slides[j].dataset.index); const from = Number(slides[dragFrom].dataset.index); dragFrom = -1; if (from >= 0 && to >= 0 && from !== to) post({ type: 'deck-move', from, to }); });
      t.addEventListener('dragend', () => { dragFrom = -1; });
      t.addEventListener('keydown', (e) => {
        const idx = Number(sl.dataset.index);
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowLeft') && idx > 0) { e.preventDefault(); post({ type: 'deck-move', from: idx, to: idx - 1 }); }
        else if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowRight') && idx >= 0) { e.preventDefault(); post({ type: 'deck-move', from: idx, to: idx + 1 }); }
        else if ((e.key === 'Delete' || e.key === 'Backspace') && idx >= 0) { e.preventDefault(); post({ type: 'deck-delete', index: idx }); }
        else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); const n = strip.querySelectorAll('.thumb')[j + 1]; if (n) { n.focus(); go(j + 1); } }
        else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); const p = strip.querySelectorAll('.thumb')[j - 1]; if (p) { p.focus(); go(j - 1); } }
      });
    });
  }
  if (cfg.progressive && mode === 'edit') {
    document.querySelectorAll('#frame [data-path]:not(aside)').forEach((t) => {
      t.tabIndex = 0;
      t.setAttribute('role', 'textbox');
      t.setAttribute('aria-label', t.dataset.path.replace(/\\./g, ' '));
    });
    const tools = document.querySelector('.slide-tools');
    tools.addEventListener('toggle', fit);
    tools.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); tools.open = false; tools.querySelector('summary').focus(); }
    });
  }
  // direct editing: click a text, type, leave it (or Enter) to keep; Esc puts it back
  function editable(e) {
    if (mode !== 'edit') return;
    const t = e.target.closest('[data-path]');
    if (!t || t.isContentEditable) return;
    t.dataset.was = t.textContent;
    try { t.contentEditable = 'plaintext-only'; } catch { t.contentEditable = 'true'; }
    if (!t.isContentEditable) t.contentEditable = 'true';
    t.focus();
  }
  function commit(t, keep, next) {
    const was = t.dataset.was;
    t.contentEditable = 'false';
    delete t.dataset.was;
    if (!keep) { t.textContent = was; return false; }
    const value = t.textContent;
    if (value === was) return false;
    const sl = t.closest('.slide');
    const index = Number(t.dataset.index || (sl && sl.dataset.index));
    post({ type: 'deck-text', index, path: t.dataset.path, value, ...(next ? { next } : {}) }); // next: the table cell Tab moved to (edited again after the redraw)
    return true;
  }
  function tabCell(t, back) { // Tab / Shift+Tab in a table cell: on to the next cell, still editing
    const cells = [...t.closest('table').querySelectorAll('[data-path^="table."]')];
    const to = cells[cells.indexOf(t) + (back ? -1 : 1)];
    if (!to) return false;
    if (!commit(t, true, to.dataset.path)) { t.blur(); editable({ target: to }); }
    return true;
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a.rl'); // a link in slide text (deck-rich.js): edited when editing, followed when presenting
    if (a && mode === 'edit') e.preventDefault();
    if (mode === 'edit') { editable(e); return; }
    if (a && !body.classList.contains('overview')) {
      e.stopPropagation();
      if (a.dataset.go) { e.preventDefault(); const j = slides.findIndex((x) => x.dataset.index === String(Number(a.dataset.go) - 1)); if (j >= 0) go(j); }
      else if (cfg.embedded) { e.preventDefault(); post({ type: 'deck-open', url: a.getAttribute('href') }); } // the sandbox opens no tabs: the page does, after its own check
      return;
    }
    if (mode !== 'present' || body.classList.contains('presenter') || body.classList.contains('overview')) return;
    if (e.target.closest('button,#bar')) return;
    if (e.clientX < innerWidth / 3) go(k - 1); else go(k + 1);
  });
  document.addEventListener('focusin', (e) => { if (mode === 'edit' && e.target.matches && e.target.matches('#notesed [data-path]')) editable(e); });
  document.addEventListener('focusout', (e) => { const t = e.target; if (t && t.dataset && t.dataset.path && t.dataset.was !== undefined) commit(t, true); });
  document.addEventListener('paste', (e) => { const t = e.target.closest && e.target.closest('[data-path]'); if (!t) return; e.preventDefault(); document.execCommand('insertText', false, (e.clipboardData && e.clipboardData.getData('text/plain')) || ''); });
  // keys
  let typed = '';
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && t.isContentEditable) {
      if (e.key === 'Escape') { e.preventDefault(); commit(t, false); t.blur(); }
      else if (e.key === 'Tab' && t.closest('table') && /^table\./.test(t.dataset.path || '') && tabCell(t, e.shiftKey)) e.preventDefault();
      else if (e.key === 'Enter' && !(t.dataset.path === 'notes' && e.shiftKey)) { e.preventDefault(); t.blur(); }
      return;
    }
    if (cfg.progressive && mode === 'edit' && t.matches('[data-path]') && (e.key === 'Enter' || e.key === 'F2')) { e.preventDefault(); editable(e); return; }
    if (cfg.progressive && t.closest('summary,button,input,select,textarea')) return;
    if (e.metaKey || e.ctrlKey) { if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); post({ type: 'deck-undo', redo: e.shiftKey }); } return; }
    if (e.target.closest && e.target.closest('#strip')) return;
    const kk = e.key;
    // Space/Enter on a button must activate it, not navigate the deck.
    if (cfg.persistentExit && (kk === ' ' || kk === 'Enter') && t.closest && t.closest('button')) return;
    if (kk === 'ArrowRight' || kk === 'ArrowDown' || kk === 'PageDown' || (kk === ' ' && mode === 'present') || kk === 'n') { e.preventDefault(); go(k + 1); }
    else if (kk === 'ArrowLeft' || kk === 'ArrowUp' || kk === 'PageUp' || kk === 'p' || (kk === 'Backspace' && mode === 'present')) { e.preventDefault(); go(k - 1); }
    else if (kk === 'Home') { e.preventDefault(); go(0); } else if (kk === 'End') { e.preventDefault(); go(slides.length - 1); }
    else if (/^[0-9]$/.test(kk)) typed += kk;
    else if (kk === 'Enter' && typed) { go(Number(typed) - 1); typed = ''; }
    else if (kk === 'g' || kk === 'o') toggleOverview();
    else if ((kk === 'l') && mode === 'present') toggleLaser();
    else if ((kk === 's' || kk === 'v') && mode === 'present') togglePresenter();
    else if ((kk === 'b' || kk === '.') && mode === 'present') body.classList.toggle('blank');
    else if (kk === 'Escape') {
      if (body.classList.contains('overview')) toggleOverview(false);
      else if (body.classList.contains('presenter')) togglePresenter(false);
      else if (mode === 'present') post({ type: 'deck-exit' });
    }
  });
  // swipe
  let sx = null, sy = 0;
  document.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') { sx = e.clientX; sy = e.clientY; } });
  document.addEventListener('pointerup', (e) => {
    if (sx === null) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    sx = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && !(e.target.closest && e.target.closest('#strip,[contenteditable="true"],[contenteditable="plaintext-only"]'))) go(k + (dx < 0 ? 1 : -1));
  });
  // overview grid
  function toggleOverview(on = !body.classList.contains('overview')) {
    body.classList.toggle('overview', on);
    if (!on) { const b = $('b-ov'); if (b) b.focus(); return; }
    const grid = document.querySelector('#ov .grid');
    grid.replaceChildren(...slides.map((s, j) => { const t = thumb(s, j); t.addEventListener('click', (ev) => { ev.stopPropagation(); toggleOverview(false); go(j); }); return t; }));
    const cur = grid.children[k]; if (cur) cur.focus();
  }
  // laser
  function toggleLaser() { body.classList.toggle('laser'); $('b-laser').setAttribute('aria-pressed', String(body.classList.contains('laser'))); }
  document.addEventListener('pointermove', (e) => { if (body.classList.contains('laser')) { $('laser').style.left = `${e.clientX}px`; $('laser').style.top = `${e.clientY}px`; } if (mode === 'present') { body.classList.add('show-bar'); clearTimeout(fit.t); fit.t = setTimeout(() => body.classList.remove('show-bar'), 1800); } });
  // presenter view: this slide, the next, the notes, a timer
  let t0 = 0, tick = 0;
  function drawInto(box, sl) {
    box.replaceChildren();
    box.style.height = '';
    if (!sl) return;
    const c = sl.cloneNode(true); c.classList.add('cur'); c.removeAttribute('inert'); c.setAttribute('aria-hidden', 'true');
    c.querySelectorAll('[data-path]').forEach((e) => e.removeAttribute('data-path'));
    const w = document.createElement('div'); w.className = document.getElementById('frame').className; w.append(c);
    box.append(w);
    box.style.width = '';
    const maxH = box.classList.contains('nxt') ? innerHeight * 0.26 : innerHeight * 0.75;
    const s = Math.min(box.clientWidth / 1280, maxH / 720);
    c.style.transform = `scale(${s})`;
    box.style.height = `${720 * s}px`;
    box.style.width = `${1280 * s}px`;
  }
  function drawPresenter() {
    drawInto(document.querySelector('#pv .now'), slides[k]);
    drawInto(document.querySelector('#pv .nxt'), slides[k + 1]);
    $('pv-notes').textContent = notesOf(slides[k]) || L.noNotes;
    $('pv-pos').textContent = `${L.slide} ${k + 1} / ${slides.length}`;
  }
  function togglePresenter(on = !body.classList.contains('presenter')) {
    body.classList.toggle('presenter', on);
    clearInterval(tick);
    if (on) { if (!t0) t0 = Date.now(); tick = setInterval(timer, 1000); timer(); drawPresenter(); $('pv-next').focus(); }
  }
  function timer() { const s = Math.floor((Date.now() - t0) / 1000); $('pv-timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
  // buttons
  const on = (id, f) => { const b = $(id); if (b) b.addEventListener('click', (e) => { e.stopPropagation(); f(); }); };
  on('b-prev', () => go(k - 1)); on('b-next', () => go(k + 1)); on('b-ov', () => toggleOverview()); on('ov-close', () => toggleOverview(false));
  on('b-pv', () => togglePresenter()); on('b-laser', toggleLaser);
  const exitPresentation = () => post({ type: 'deck-exit' });
  on('presentation-exit', exitPresentation);
  on('pv-prev', () => go(k - 1)); on('pv-next', () => go(k + 1)); on('pv-reset', () => { t0 = Date.now(); timer(); }); on('pv-exit', () => cfg.persistentExit && cfg.embedded ? exitPresentation() : togglePresenter(false));
  const act = (a) => () => { const idx = Number(slides[k].dataset.index); if (idx >= 0) post({ type: 'deck-act', act: a, index: idx }); };
  on('b-layout', act('layout')); on('b-photo', act('photo')); on('b-ai', act('ai-visual')); on('b-play', act('playbook'));
  on('b-regen', act('regen')); on('b-short', act('shorter')); on('b-expand', act('expand')); on('b-add', act('add')); on('b-dup', act('dup')); on('b-del', act('delete')); on('b-up', act('up')); on('b-down', act('down'));
  document.querySelectorAll('.pres-only').forEach((b) => { b.hidden = mode !== 'present'; });
  const updateExit = () => { const b = $('presentation-exit'); if (b) b.hidden = mode !== 'present'; };
  updateExit();
  // the page: switch mode, go to a slide
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const m = e.data || {};
    if (m.type === 'deck-edit' && mode === 'edit' && typeof m.path === 'string') { // after the redraw a table Tab caused: keep typing in the next cell
      const sl = slides.find((x) => x.dataset.index === String(m.index));
      const to = sl && [...sl.querySelectorAll('[data-path]')].find((x) => x.dataset.path === m.path);
      if (to) { editable({ target: to }); try { getSelection().selectAllChildren(to); } catch { /* no selection */ } }
      return;
    }
    if (m.type === 'deck-mode' && (m.mode === 'present' || m.mode === 'edit')) {
      mode = m.mode;
      if (cfg.persistentExit) { clearInterval(tick); tick = 0; updateExit(); }
      body.classList.remove('mode-present', 'mode-edit', 'presenter', 'overview', 'laser', 'blank');
      body.classList.add(`mode-${mode}`);
      document.querySelectorAll('.pres-only').forEach((b) => { b.hidden = mode !== 'present'; });
      if (mode === 'edit') buildStrip();
      if (m.presenter) togglePresenter(true);
      fit(); go(k);
      if (!cfg.persistentExit || mode === 'present') document.body.focus(); // back to editing on the web: the page returns focus to Present
    } else if (m.type === 'deck-go' && Number.isInteger(m.k)) go(m.k);
    else if (m.type === 'deck-preview') preview();
  });
  addEventListener('resize', fit);
  if (window.ResizeObserver) { const ro = new ResizeObserver(() => fit()); ro.observe($('stage')); ro.observe($('bar')); } // Firefox can lay the stage out after the first fit, with no resize event
  buildStrip();
  fit();
  go(k, { announce: false });
  if (!document.body.hasAttribute('tabindex')) document.body.tabIndex = -1;
  post({ type: 'deck-ready', total: slides.length });
}
