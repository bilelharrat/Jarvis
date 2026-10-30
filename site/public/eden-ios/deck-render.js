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

import { SLIDE_W, SLIDE_H, M, themeOf, layoutDeck, partTitle, citeRuns, axis, shortNum, wedges, diagramLayout, linkEnds } from './deck-model.js';

export const LABELS = {
  slide: 'Slide', of: 'of', slides: 'Slides', notes: 'Speaker notes', noNotes: 'No notes for this slide.', next: 'Next', prev: 'Previous',
  overview: 'Overview', presenter: 'Presenter view', laser: 'Laser pointer', exit: 'Exit', end: 'End of the deck', timer: 'Timer', reset: 'Reset',
  regen: 'Regenerate', shorter: 'Shorter', add: 'Add slide after', dup: 'Duplicate', del: 'Delete slide', up: 'Move up', down: 'Move down',
  editHint: 'Click any text to edit it. Drag slides in the strip to reorder.', altNeeded: 'Alt text needed', source: 'Source', sources: 'Sources',
  checked: 'Eden’s check', present: 'Present', cont: 'continued', picture: 'Picture', missing: 'Picture not on this device', chart: 'Chart', diagram: 'Diagram',
};

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Text as HTML text or an attribute value: nothing in it is markup. */
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const n = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : 0); // a number for markup: only digits ever
const DATA_URL = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
/** A picture's data URL when it's one Eden accepts (PNG, JPEG, GIF, WebP as base64), else ''. */
export const imageData = (im) => (im && typeof im.data === 'string' && DATA_URL.test(im.data) ? im.data : '');

function palette(t) { return [t.colors.accent, t.colors.accent2, '#f5a524', '#17a673', '#e5484d', '#8e8e93']; }

/** Words with citation markers as superscripts; the person's text escaped. */
function rich(s, known) {
  return citeRuns(s, known).map((r) => (r.cite ? `<sup class="cite">${esc(r.t)}</sup>` : esc(r.t))).join('');
}
const editable = (path, ctx) => (ctx.edit ? ` data-path="${esc(path)}"` : '');

function bulletList(items, path, px, ctx, offset = 0) {
  if (!items || !items.length) return '';
  return `<ul class="bl" style="font-size:${n(px)}px">${items.map((b, k) => {
    const i = k + offset;
    if (typeof b === 'string') return `<li><span${editable(`${path}.${i}`, ctx)}>${rich(b, ctx.known)}</span></li>`;
    return `<li><span${editable(`${path}.${i}`, ctx)}>${rich(b.text, ctx.known)}</span>${b.sub && b.sub.length ? `<ul>${b.sub.map((x, j) => `<li><span${editable(`${path}.${i}.sub.${j}`, ctx)}>${rich(x, ctx.known)}</span></li>`).join('')}</ul>` : ''}</li>`;
  }).join('')}</ul>`;
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
const tspans = (lines, x, dy) => lines.map((l, i) => `<tspan x="${n(x)}" dy="${i ? n(dy) : 0}">${esc(l)}</tspan>`).join('');

export function chartSvg(c, t, W, H) {
  const col = palette(t);
  const fg = t.colors.text, mu = t.colors.muted;
  const label = `${c.type} chart: ${c.series.map((s) => `${s.name ? `${s.name}: ` : ''}${c.labels.map((l, k) => `${l} ${shortNum(s.values[k], c.unit)}`).join(', ')}`).join('; ')}`;
  const legend = c.series.length > 1 || c.type === 'pie' || c.type === 'doughnut';
  let body = '';
  if (c.type === 'pie' || c.type === 'doughnut') {
    const cx = W * 0.35, cy = H / 2, r = Math.min(W * 0.3, H / 2 - 10), ri = c.type === 'doughnut' ? r * 0.58 : 0;
    const pt = (a, rr) => `${n(cx + rr * Math.sin(a))} ${n(cy - rr * Math.cos(a))}`;
    body += wedges(c).map((w, i) => {
      if (w.share >= 0.9999) return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${col[i % col.length]}"/>${ri ? `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(ri)}" fill="${t.colors.bg}"/>` : ''}`;
      const big = w.a1 - w.a0 > Math.PI ? 1 : 0;
      const d = ri ? `M${pt(w.a0, r)} A${n(r)} ${n(r)} 0 ${big} 1 ${pt(w.a1, r)} L${pt(w.a1, ri)} A${n(ri)} ${n(ri)} 0 ${big} 0 ${pt(w.a0, ri)}Z` : `M${n(cx)} ${n(cy)} L${pt(w.a0, r)} A${n(r)} ${n(r)} 0 ${big} 1 ${pt(w.a1, r)}Z`;
      return `<path d="${d}" fill="${col[i % col.length]}" stroke="${t.colors.bg}" stroke-width="2"/>`;
    }).join('');
    body += wedges(c).map((w, i) => `<g transform="translate(${n(W * 0.7)} ${n(H / 2 - (c.labels.length * 34) / 2 + i * 34)})"><rect width="18" height="18" rx="4" fill="${col[i % col.length]}"/><text x="28" y="15" fill="${fg}" font-size="20">${esc(w.label)} · ${esc(shortNum(w.value, c.unit))} (${Math.round(w.share * 100)}%)</text></g>`).join('');
  } else {
    const all = c.series.flatMap((s) => s.values);
    const ax = axis(all);
    const hb = c.type === 'hbar';
    const L = hb ? 170 : 70, R = 20, T = legend ? 44 : 14, B = hb ? 34 : 54;
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
          if (sN === 1 && k <= 12) {
            if (hb) body += `<text x="${n(L + b * pw + 8)}" y="${n(T + i * band + band / 2 + 6)}" fill="${fg}" font-size="17">${esc(shortNum(s.values[i], c.unit))}</text>`;
            else body += `<text x="${n(L + i * band + band / 2)}" y="${n(T + ph - b * ph - 8)}" text-anchor="middle" fill="${fg}" font-size="17">${esc(shortNum(s.values[i], c.unit))}</text>`;
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
      });
      c.labels.forEach((lab, i) => { if (k <= 12 || i % Math.ceil(k / 12) === 0) body += `<text x="${n(x(i))}" y="${n(T + ph + 28)}" text-anchor="middle" fill="${fg}" font-size="${k > 8 ? 14 : 17}">${esc(lab.length > 14 ? `${lab.slice(0, 13)}…` : lab)}</text>`; });
    }
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
    const fs = b.w < 170 ? 18 : 21;
    const lab = wrap(b.label, Math.max(8, Math.floor(b.w / (fs * 0.55)) - 1));
    const det = b.detail ? wrap(b.detail, Math.max(10, Math.floor(b.w / (15 * 0.55)) - 1)).slice(0, b.h >= 108 ? 3 : 2) : [];
    const kids = b.children && b.children.length ? [b.children.join(' · ')] : [];
    const total = lab.length * fs * 1.15 + det.length * 18 + (kids.length ? 22 : 0);
    const y0 = b.y + b.h / 2 - total / 2 + fs * 0.85;
    s += `<text x="${n(b.x + b.w / 2)}" y="${n(y0)}" text-anchor="middle" fill="${b.taper ? '#ffffff' : fg}" font-size="${fs}" font-weight="650">${tspans(lab, b.x + b.w / 2, fs * 1.15)}</text>`;
    if (det.length) s += `<text x="${n(b.x + b.w / 2)}" y="${n(y0 + lab.length * fs * 1.15 + 2)}" text-anchor="middle" fill="${b.taper ? '#ffffff' : mu}" font-size="15">${tspans(det, b.x + b.w / 2, 18)}</text>`;
    if (kids.length) s += `<text x="${n(b.x + b.w / 2)}" y="${n(b.y + b.h + 26)}" text-anchor="middle" fill="${mu}" font-size="15">${esc(wrap(kids[0], Math.floor(b.w / 8))[0] || '')}</text>`;
  });
  const label = `${d.type} diagram: ${d.items.map((it) => `${it.label}${it.detail ? ` (${it.detail})` : ''}`).join(d.type === 'flow' || d.type === 'cycle' ? ' → ' : '; ')}`;
  return `<svg class="diagram" viewBox="0 0 ${n(W)} ${n(H)}" width="${n(W)}" height="${n(H)}" role="img" aria-label="${esc(label)}" font-family="inherit">${s}</svg>`;
}

// ── one slide ──

/**
 * One drawn slide (deck-model layoutSlide's { slide, index, part, parts, offset, fit }) as a <section>.
 * ctx: { theme, images, edit, known (cited numbers), deck, total, k (its number), labels }
 */
export function slideHtml(r, ctx) {
  const s = r.slide, t = ctx.theme, L = ctx.labels;
  const E = (p) => editable(p, { edit: ctx.edit && r.index >= 0 && (r.parts === 1 || !/^title$/.test(p)) });
  const title = partTitle(r);
  const tp = r.fit.title, bp = r.fit.body;
  const H = (tag, cls = 's-title') => (title ? `<${tag} class="${cls}" style="font-size:${n(tp)}px"${r.parts === 1 ? E('title') : ''}>${rich(title, ctx.known)}</${tag}>` : '');
  const bodyTop = M.top + (title ? Math.ceil(title.length * tp * 0.52 * 1.06 / (SLIDE_W - 2 * M.x)) * tp * 1.1 : 0) + M.gap;
  const bodyH = SLIDE_H - bodyTop - M.bottom - (s.caption ? 40 : 0);
  const caption = s.caption ? `<p class="caption"${E('caption')}>${rich(s.caption, ctx.known)}</p>` : '';
  let inner = '';
  const ctxE = { ...ctx, edit: ctx.edit && r.index >= 0 };
  switch (s.layout) {
    case 'title':
      inner = `<div class="center"><div class="kicker"></div><h1 class="s-title big" style="font-size:${n(tp)}px"${E('title')}>${rich(s.title || ctx.deck.title, ctx.known)}</h1>${s.subtitle ? `<p class="subtitle" style="font-size:${n(bp)}px"${E('subtitle')}>${rich(s.subtitle, ctx.known)}</p>` : ''}</div>`;
      break;
    case 'section':
      inner = `<div class="section-wrap"><div class="sec-n">${String(ctx.sectionNo || 1).padStart(2, '0')}</div><h2 class="s-title big" style="font-size:${n(tp)}px"${E('title')}>${rich(s.title || '', ctx.known)}</h2>${s.subtitle ? `<p class="subtitle" style="font-size:${n(bp)}px"${E('subtitle')}>${rich(s.subtitle, ctx.known)}</p>` : ''}</div>`;
      break;
    case 'two-column':
      inner = `${H('h2')}<div class="cols">${['left', 'right'].map((side) => `<div class="col card">${s[side].heading ? `<h3 style="font-size:${n(bp * 1.1)}px"${E(`${side}.heading`)}>${rich(s[side].heading, ctx.known)}</h3>` : ''}${bulletList(s[side].bullets, `${side}.bullets`, bp, ctxE)}</div>`).join('')}</div>${caption}`;
      break;
    case 'image': {
      const im = ctx.images && ctx.images[s.image];
      const src = imageData(im);
      const needAlt = ctx.edit && !s.alt;
      const pic = src ? `<img src="${src}" alt="${esc(s.alt || '')}"${s.alt ? '' : ' data-noalt="1"'}>` : `<div class="noimg" role="img" aria-label="${esc(s.alt || L.picture)}">${esc(L.missing)}</div>`;
      inner = `${H('h2')}<div class="imgrow${s.bullets ? '' : ' solo'}"><figure class="pic">${pic}${needAlt ? `<span class="alt-flag">${esc(L.altNeeded)}</span>` : ''}</figure>${s.bullets ? `<div class="imgtext">${bulletList(s.bullets, 'bullets', bp, ctxE)}</div>` : ''}</div>${caption}`;
      break;
    }
    case 'chart':
      inner = `${H('h2')}<figure class="chartbox">${chartSvg(s.chart, t, SLIDE_W - 2 * M.x, Math.max(220, bodyH))}</figure>${caption || (s.chart.source ? `<p class="caption">${esc(L.source)}: ${esc(s.chart.source)}</p>` : '')}`;
      break;
    case 'table': {
      const tb = s.table;
      inner = `${H('h2')}<div class="tablebox"><table class="tbl" style="font-size:${n(bp)}px">${tb.header.length ? `<thead><tr>${tb.header.map((h, i) => `<th scope="col"${E(`table.header.${i}`)}>${rich(h, ctx.known)}</th>`).join('')}</tr></thead>` : ''}<tbody>${tb.rows.map((row, ri) => `<tr>${row.map((c, ci) => `<td${E(`table.rows.${ri + r.offset}.${ci}`)}>${rich(c, ctx.known)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${caption}`;
      break;
    }
    case 'diagram':
      inner = `${H('h2')}<figure class="diagbox">${diagramSvg(s.diagram, t, SLIDE_W - 2 * M.x, Math.max(220, bodyH))}</figure>${caption}`;
      break;
    case 'stats':
      inner = `${H('h2')}<div class="stats n${s.stats.length}">${s.stats.map((x, i) => `<div class="stat card"><div class="sv"${E(`stats.${i}.value`)}>${esc(x.value)}</div><div class="sl"${E(`stats.${i}.label`)}>${rich(x.label, ctx.known)}</div></div>`).join('')}</div>${bulletList(s.bullets, 'bullets', 22, ctxE)}${caption}`;
      break;
    case 'quote':
      inner = `<figure class="quote"><blockquote style="font-size:${n(bp)}px"${E('quote')}>${rich(s.quote, ctx.known)}</blockquote>${s.by ? `<figcaption${E('by')}>${esc(s.by)}</figcaption>` : ''}</figure>`;
      break;
    case 'sources': {
      const src = (ctx.deck.sources || []);
      inner = `<h2 class="s-title" style="font-size:${n(tp)}px">${esc(s.title && !s.auto ? s.title : L.sources)}</h2><ol class="srcs">${src.map((x) => `<li value="${x.n}"><span class="st">${esc(x.title || x.url)}</span>${x.url ? `<span class="su">${esc(x.url)}</span>` : ''}</li>`).join('')}</ol>${r.label ? `<p class="checked"><b>${esc(L.checked)}:</b> ${esc(r.label)}</p>` : ''}`;
      break;
    }
    default: // bullets
      inner = `${H('h2')}${bulletList(s.bullets, 'bullets', bp, ctxE, r.offset)}${caption}`;
  }
  const notes = r.part === 1 && r.slide.notes ? r.slide.notes : '';
  const name = `${L.slide} ${ctx.k} ${L.of} ${ctx.total}${title ? `: ${title}` : s.quote ? `: ${s.quote.slice(0, 60)}` : ''}`;
  return `<section class="slide l-${esc(s.layout)}" data-k="${ctx.k - 1}" data-index="${r.index}" data-part="${r.part}" role="group" aria-roledescription="slide" aria-label="${esc(name)}"><div class="bgfx" aria-hidden="true"></div><div class="inner">${inner}</div><div class="foot" aria-hidden="true"><span class="fd">${esc(ctx.deck.title)}</span><span class="fn">${ctx.k}</span></div><aside class="notes" hidden${ctx.edit && r.index >= 0 && r.part === 1 ? ' data-path="notes"' : ''}>${esc(notes)}</aside></section>`;
}

// ── the document ──

function css(t) {
  const c = t.colors;
  return `
:root{--bg:${c.bg};--bg2:${c.bg2};--surface:${c.surface};--text:${c.text};--muted:${c.muted};--accent:${c.accent};--accent2:${c.accent2};--hf:${t.heading.css};--bf:${t.body.css};--s:1;color-scheme:${t.dark ? 'dark' : 'light'}}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{font-family:var(--bf);color:var(--text);background:#e9ecf2;-webkit-font-smoothing:antialiased;overflow:hidden}
body.dark-ui{background:#14161b}
.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.slide{position:relative;width:${SLIDE_W}px;height:${SLIDE_H}px;overflow:hidden;background:var(--bg);color:var(--text);flex:none}
.bgfx{position:absolute;inset:0;background:linear-gradient(135deg,var(--bg),var(--bg2))}
.glass .bgfx{background:radial-gradient(60% 70% at 12% 8%,color-mix(in srgb,var(--accent) 22%,transparent),transparent 70%),radial-gradient(55% 60% at 92% 95%,color-mix(in srgb,var(--accent2) 22%,transparent),transparent 70%),linear-gradient(135deg,var(--bg),var(--bg2))}
.inner{position:absolute;inset:${M.top}px ${M.x}px ${M.bottom}px;display:flex;flex-direction:column}
.s-title{font-family:var(--hf);font-weight:700;letter-spacing:-.02em;line-height:1.1;margin:0 0 ${M.gap}px;text-wrap:balance}
.s-title .cite,.bl .cite,.caption .cite,td .cite{font-size:.55em;color:var(--accent);vertical-align:super;line-height:0;margin-left:.1em}
.center{margin:auto 0;display:flex;flex-direction:column;align-items:flex-start;gap:20px;max-width:1000px}
.kicker{width:96px;height:8px;border-radius:8px;background:linear-gradient(90deg,var(--accent),var(--accent2))}
.big{margin:0}.subtitle{margin:0;color:var(--muted);line-height:1.3;font-size:28px}
.section-wrap{margin:auto 0}.sec-n{font-family:var(--hf);font-size:28px;font-weight:700;color:var(--accent);margin-bottom:12px}
.bl{margin:0;padding:0 0 0 1.25em;line-height:1.22}.bl>li{margin:0 0 .5em}.bl>li::marker{color:var(--accent)}
.bl ul{margin:.3em 0 0;padding-left:1.2em;font-size:.85em;color:var(--muted)}
.card{background:var(--surface);border-radius:22px;padding:28px 30px;box-shadow:0 1px 2px rgba(0,0,0,.06),0 10px 30px rgba(0,0,0,.06)}
.glass .card{background:color-mix(in srgb,var(--surface) 62%,transparent);border:1px solid color-mix(in srgb,#fff 55%,transparent);backdrop-filter:blur(18px) saturate(1.4);-webkit-backdrop-filter:blur(18px) saturate(1.4)}
.dark .glass .card,.glass.dark .card{border-color:rgba(255,255,255,.14)}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:48px;flex:1;min-height:0}.col h3{font-family:var(--hf);margin:0 0 14px;color:var(--accent)}
.imgrow{display:flex;gap:40px;flex:1;min-height:0;align-items:center}.pic{margin:0;flex:1.25;height:100%;display:flex;align-items:center;justify-content:center;position:relative;min-width:0}
.imgrow.solo .pic{flex:1}.pic img{max-width:100%;max-height:100%;border-radius:18px;object-fit:contain;box-shadow:0 10px 30px rgba(0,0,0,.15)}
.imgtext{flex:1;min-width:0}.noimg{width:100%;height:100%;border:2px dashed var(--muted);border-radius:18px;display:grid;place-items:center;color:var(--muted);font-size:22px}
.alt-flag{position:absolute;top:10px;left:10px;background:#b00020;color:#fff;font-size:16px;font-weight:600;padding:4px 10px;border-radius:8px}
.chartbox,.diagbox{margin:0;flex:1;min-height:0}.chartbox svg,.diagbox svg{width:100%;height:100%}
.caption{margin:12px 0 0;color:var(--muted);font-size:18px}
.tablebox{flex:1;min-height:0;overflow:hidden}.tbl{width:100%;border-collapse:separate;border-spacing:0;line-height:1.2}
.tbl th{text-align:left;background:var(--accent);color:#fff;padding:10px 14px;font-weight:650}.tbl th:first-child{border-radius:12px 0 0 0}.tbl th:last-child{border-radius:0 12px 0 0}
.tbl td{padding:9px 14px;border-bottom:1px solid color-mix(in srgb,var(--muted) 30%,transparent)}.tbl tr:nth-child(even) td{background:color-mix(in srgb,var(--surface) 55%,transparent)}
.stats{display:grid;gap:28px;margin:auto 0}.stats.n1{grid-template-columns:1fr}.stats.n2{grid-template-columns:1fr 1fr}.stats.n3{grid-template-columns:repeat(3,1fr)}.stats.n4{grid-template-columns:repeat(4,1fr)}
.stat{text-align:left}.sv{font-family:var(--hf);font-size:68px;font-weight:750;letter-spacing:-.03em;background:linear-gradient(90deg,var(--accent),var(--accent2));-webkit-background-clip:text;background-clip:text;color:transparent}
.sl{font-size:22px;color:var(--muted);margin-top:6px;line-height:1.25}
.quote{margin:auto 40px}.quote blockquote{margin:0;font-family:var(--hf);font-weight:600;line-height:1.3;letter-spacing:-.01em;quotes:"“" "”"}
.quote blockquote::before{content:open-quote;color:var(--accent);margin-right:.05em}.quote blockquote::after{content:close-quote;color:var(--accent)}
.quote figcaption{margin-top:24px;font-size:24px;color:var(--muted)}.quote figcaption::before{content:"— "}
.srcs{margin:0;padding-left:1.6em;font-size:19px;line-height:1.3;columns:2;column-gap:48px}.srcs li{margin:0 0 12px;break-inside:avoid}.srcs .st{display:block}.srcs .su{display:block;color:var(--muted);font-size:15px;word-break:break-all}
.checked{margin-top:auto;font-size:17px;color:var(--muted)}
.foot{position:absolute;left:${M.x}px;right:${M.x}px;bottom:18px;display:flex;justify-content:space-between;font-size:14px;color:var(--muted);opacity:.8}
.l-title .foot,.l-section .foot{display:none}
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
#bar{display:flex;gap:6px;flex-wrap:nowrap;overflow-x:auto;max-width:100%;align-items:center;font:12.5px -apple-system,system-ui,sans-serif;scrollbar-width:none;padding:2px}#bar::-webkit-scrollbar{display:none}#bar button{flex:none;white-space:nowrap}#bar .sep{flex:none;width:1px;height:20px;background:rgba(127,127,127,.3)}
#bar button,#pv button,#ov-close{font:inherit;font-weight:550;border:1px solid rgba(0,0,0,.12);background:rgba(255,255,255,.75);color:#1c1f26;border-radius:999px;padding:5px 11px;cursor:pointer}
.dark-ui #bar button,.dark-ui #pv button{background:rgba(255,255,255,.08);color:#eef0f5;border-color:rgba(255,255,255,.16)}
#bar button:focus-visible,.thumb:focus-visible,#pv button:focus-visible{outline:3px solid #2f6df6;outline-offset:2px}
#bar .pos{color:#5b6475;min-width:70px;text-align:center}.dark-ui #bar .pos{color:#a3abbd}
#notesbox{width:min(100%,calc(${SLIDE_W}px * var(--s)));font:14px/1.45 -apple-system,system-ui,sans-serif;color:#2b2f38;background:rgba(255,255,255,.7);border:1px solid rgba(0,0,0,.08);border-radius:12px;padding:8px 12px;max-height:18vh;overflow:auto}
.dark-ui #notesbox{background:rgba(255,255,255,.06);color:#dfe3ec;border-color:rgba(255,255,255,.12)}
#notesbox .nl{font-weight:650;font-size:12px;color:#7a8191;margin-bottom:2px}#notesbox [data-path]{display:block;white-space:pre-wrap;min-height:1.4em}
.hint{font:12px -apple-system,system-ui,sans-serif;color:#7a8191;text-align:center;margin:0}
.mode-present #strip,.mode-present #notesbox,.mode-present .hint,.mode-present .edit-only{display:none!important}
.mode-present{background:#000}.mode-present #stage{padding:0}.mode-present #frame{border-radius:0;box-shadow:none}
.mode-present #bar{position:absolute;bottom:10px;left:50%;transform:translateX(-50%);opacity:0;transition:opacity .25s;background:rgba(20,22,28,.7);padding:6px 8px;border-radius:999px;backdrop-filter:blur(14px)}
.mode-present #bar button{background:transparent;color:#fff;border-color:rgba(255,255,255,.2)}.mode-present #bar .pos{color:#ccd}
.mode-present #bar:hover,.mode-present #bar:focus-within,.mode-present.show-bar #bar{opacity:1}
.mode-present.blank #frame{visibility:hidden}
#laser{position:fixed;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:radial-gradient(circle,#ff3b30 35%,rgba(255,59,48,.35) 60%,transparent 70%);pointer-events:none;display:none;z-index:9}
.laser #laser{display:block}.laser #frame{cursor:none}
#ov{position:fixed;inset:0;background:rgba(10,12,18,.92);overflow:auto;padding:24px;display:none;z-index:8}
.overview #ov{display:block}#ov .grid{display:flex;flex-wrap:wrap;gap:16px;justify-content:center}
#ov .thumb{width:240px;height:135px}#ov .thumb .slide{transform:scale(.1875)}#ov>h2{color:#fff;font:600 16px -apple-system,system-ui,sans-serif;margin:0 0 14px}
#ov-close{position:absolute;top:16px;right:110px}
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
    return slideHtml(r, { theme: t, images: opts.images || {}, edit: mode === 'edit', known, deck, total, k: k + 1, labels: L, sectionNo });
  }).join('\n');
  const themeCls = `${t.glass ? 'glass' : ''}${t.dark ? ' dark' : ''}`;
  const head = `<!doctype html><html lang="${esc(opts.lang || 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(deck.title)}</title><style>${css(t)}</style></head>`;
  if (mode === 'static') return `${head}<body class="mode-static ${themeCls}">${slides}</body></html>`;
  const cfg = { mode, start: Math.max(0, Math.min(total - 1, Math.floor(opts.start || 0))), total, labels: L, embedded: opts.embedded !== false };
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const B = (id, label, cls = '') => `<button type="button" id="${id}"${cls ? ` class="${cls}"` : ''}>${esc(label)}</button>`;
  return `${head}<body class="mode-${mode} ${themeCls}${opts.darkUi ? ' dark-ui' : ''}">
<div id="app"><div id="main"><nav id="strip" aria-label="${esc(L.slides)}"></nav>
<div id="stage"><div id="frame" class="${themeCls}">${slides}</div>
<div id="bar" role="toolbar" aria-label="${esc(L.slides)}">${B('b-prev', `← ${L.prev}`)}<span class="pos" id="pos" aria-hidden="true"></span>${B('b-next', `${L.next} →`)}${B('b-ov', L.overview)}${B('b-pv', L.presenter, 'pres-only')}${B('b-laser', L.laser, 'pres-only')}<span class="sep edit-only" aria-hidden="true"></span>${B('b-regen', L.regen, 'edit-only')}${B('b-short', L.shorter, 'edit-only')}${B('b-add', L.add, 'edit-only')}${B('b-dup', L.dup, 'edit-only')}${B('b-up', L.up, 'edit-only')}${B('b-down', L.down, 'edit-only')}${B('b-del', L.del, 'edit-only')}</div>
<div id="notesbox" aria-label="${esc(L.notes)}"><div class="nl">${esc(L.notes)}</div><div id="notesed"></div></div><p class="hint">${esc(L.editHint)}</p></div></div></div>
<div id="ov" role="dialog" aria-modal="true" aria-label="${esc(L.overview)}"><h2>${esc(L.overview)}</h2><button type="button" id="ov-close">${esc(L.exit)}</button><div class="grid"></div></div>
<div id="pv" role="region" aria-label="${esc(L.presenter)}"><div class="now"></div><div class="side"><div class="nl">${esc(L.next)}</div><div class="nxt"></div><div class="nl">${esc(L.timer)}</div><div class="clock" id="pv-timer">0:00</div><div class="nl">${esc(L.notes)}</div><div class="pvnotes" id="pv-notes"></div></div><div class="ctl">${B('pv-prev', `← ${L.prev}`)}${B('pv-next', `${L.next} →`)}<span id="pv-pos"></span>${B('pv-reset', L.reset)}${B('pv-exit', L.exit)}</div></div>
<div id="laser" aria-hidden="true"></div><div id="live" class="sr-only" aria-live="polite"></div>
<script>(${viewer.toString()})(${json});</script></body></html>`;
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
    const pad = mode === 'present' ? 0 : 28;
    const hint = document.querySelector('.hint');
    const reserve = mode === 'present' ? 0 : $('bar').offsetHeight + $('notesbox').offsetHeight + (hint ? hint.offsetHeight : 0) + 3 * 10 + 6;
    const s = Math.max(0.1, Math.min((stage.clientWidth - pad) / 1280, (stage.clientHeight - reserve) / 720));
    document.documentElement.style.setProperty('--s', String(s));
    shrinkOverflow(slides[k]);
    if (body.classList.contains('presenter')) drawPresenter();
  }
  // a font wider than estimated: shrink the box's text until it fits (once per slide)
  function shrinkOverflow(sl) {
    if (!sl || sl.dataset.fitted) return;
    sl.dataset.fitted = '1';
    for (const box of sl.querySelectorAll('.bl, .tbl, .subtitle, .quote blockquote, .imgtext .bl')) {
      const holder = box.closest('.inner');
      let guard = 0;
      while (holder.scrollHeight > holder.clientHeight + 2 && guard++ < 12) {
        const px = parseFloat(getComputedStyle(box).fontSize);
        if (px <= 13) break;
        box.style.fontSize = `${px * 0.94}px`;
      }
    }
  }
  function notesOf(sl) { const a = sl.querySelector('aside.notes'); return a ? a.textContent : ''; }
  function go(i, { announce = true } = {}) {
    k = Math.max(0, Math.min(slides.length - 1, i));
    slides.forEach((s, j) => { s.classList.toggle('cur', j === k); s.toggleAttribute('inert', j !== k); s.setAttribute('aria-hidden', String(j !== k)); });
    $('pos').textContent = `${k + 1} / ${slides.length}`;
    shrinkOverflow(slides[k]);
    document.querySelectorAll('#strip .thumb').forEach((t, j) => { t.classList.toggle('on', j === k); t.setAttribute('aria-current', j === k ? 'true' : 'false'); if (j === k && mode === 'edit') t.scrollIntoView({ block: 'nearest', inline: 'nearest' }); });
    drawNotes();
    if (body.classList.contains('presenter')) drawPresenter();
    if (announce) $('live').textContent = slides[k].getAttribute('aria-label') + (k === slides.length - 1 && mode === 'present' ? `. ${L.end}.` : '');
    post({ type: 'deck-at', k, index: Number(slides[k].dataset.index), part: Number(slides[k].dataset.part) });
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
  function commit(t, keep) {
    const was = t.dataset.was;
    t.contentEditable = 'false';
    delete t.dataset.was;
    if (!keep) { t.textContent = was; return; }
    const value = t.textContent;
    if (value === was) return;
    const sl = t.closest('.slide');
    const index = Number(t.dataset.index || (sl && sl.dataset.index));
    post({ type: 'deck-text', index, path: t.dataset.path, value });
  }
  document.addEventListener('click', (e) => {
    if (mode === 'edit') { editable(e); return; }
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
      else if (e.key === 'Enter' && !(t.dataset.path === 'notes' && e.shiftKey)) { e.preventDefault(); t.blur(); }
      return;
    }
    if (e.metaKey || e.ctrlKey) { if (e.key === 'z' || e.key === 'Z') { e.preventDefault(); post({ type: 'deck-undo', redo: e.shiftKey }); } return; }
    if (e.target.closest && e.target.closest('#strip')) return;
    const kk = e.key;
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
  on('pv-prev', () => go(k - 1)); on('pv-next', () => go(k + 1)); on('pv-reset', () => { t0 = Date.now(); timer(); }); on('pv-exit', () => togglePresenter(false));
  const act = (a) => () => { const idx = Number(slides[k].dataset.index); if (idx >= 0) post({ type: 'deck-act', act: a, index: idx }); };
  on('b-regen', act('regen')); on('b-short', act('shorter')); on('b-add', act('add')); on('b-dup', act('dup')); on('b-del', act('delete')); on('b-up', act('up')); on('b-down', act('down'));
  document.querySelectorAll('.pres-only').forEach((b) => { b.hidden = mode !== 'present'; });
  // the page: switch mode, go to a slide
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent) return;
    const m = e.data || {};
    if (m.type === 'deck-mode' && (m.mode === 'present' || m.mode === 'edit')) {
      mode = m.mode;
      body.classList.remove('mode-present', 'mode-edit', 'presenter', 'overview', 'laser', 'blank');
      body.classList.add(`mode-${mode}`);
      document.querySelectorAll('.pres-only').forEach((b) => { b.hidden = mode !== 'present'; });
      if (mode === 'edit') buildStrip();
      if (m.presenter) togglePresenter(true);
      fit(); go(k); document.body.focus();
    } else if (m.type === 'deck-go' && Number.isInteger(m.k)) go(m.k);
  });
  addEventListener('resize', fit);
  buildStrip();
  fit();
  go(k, { announce: false });
  if (!document.body.hasAttribute('tabindex')) document.body.tabIndex = -1;
  post({ type: 'deck-ready', total: slides.length });
}
