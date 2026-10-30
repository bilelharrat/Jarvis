// Magic Resize (web only): the deck re-flowed for other formats — 4:3 slides, square and portrait
// posts, a 9:16 story, A4 and US Letter documents — previewed, then downloaded as PNG pictures (a
// .zip), a PDF, or (4:3) PowerPoint. The 16:9 path (SLIDE_W/SLIDE_H, deck-render.js, deck-pptx.js)
// is untouched: each page here is laid out afresh for its own size (title, bullets, cards, tables,
// pictures cropped to fill, charts and diagrams drawn by the renderer at the new size) and drawn as
// one standalone SVG, every string escaped. Pure down to `pageSvg`, `pdfBytes` and
// `buildResizedPptx` (src/__tests__/deck-resize.test.ts); the DOM is only touched by `rasterize`
// and `openResize` (the dialog, from the Export tray in deck.js).

import { themeOf, citeRuns, deckFileName } from './deck-model.js';
import { esc, imageData, chartSvg, diagramSvg, playbookSvg } from './deck-render.js';
import { dirOf } from './deck-translate.js';

/** The formats: page size in CSS px (96/in), the PNG scale, and the PDF page in points. */
export const FORMATS = {
  '4x3': { name: 'Slides 4:3', hint: 'PowerPoint, older projectors', w: 960, h: 720, scale: 2, pptx: true },
  square: { name: 'Square post', hint: '1:1 · Instagram, LinkedIn', w: 1080, h: 1080, scale: 1 },
  portrait: { name: 'Portrait post', hint: '4:5 · Instagram feed', w: 1080, h: 1350, scale: 1 },
  story: { name: 'Story', hint: '9:16 · Stories, Reels, TikTok', w: 1080, h: 1920, scale: 1 },
  a4: { name: 'A4 document', hint: '210 × 297 mm', w: 794, h: 1123, scale: 2, pt: [595.28, 841.89] },
  letter: { name: 'US Letter document', hint: '8.5 × 11 in', w: 816, h: 1056, scale: 2, pt: [612, 792] },
};
export const FORMAT_IDS = Object.keys(FORMATS);
const fmt = (id) => FORMATS[id] || FORMATS['4x3'];
/** The PNG's size in pixels for a format. */
export const pngSize = (id) => { const F = fmt(id); return { w: Math.round(F.w * F.scale), h: Math.round(F.h * F.scale) }; };
/** The PDF page in points (1/72 in). */
export const pdfPageSize = (id) => { const F = fmt(id); return F.pt ? [...F.pt] : [F.w * 0.75, F.h * 0.75]; };

// ── measuring text (no DOM: an estimate, like deck-model's; the SVG then holds exactly these lines) ──

const WIDE_RE = /[ᄀ-ᅟ⺀-〾぀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
const NARROW_RE = /[ilIjtf.,:;'!|()[\]\s]/;
/** The width of `s` at `px`, in px (CJK as one em, narrow glyphs a quarter, the rest about half). */
export function textWidth(s, px) {
  let w = 0;
  for (const ch of String(s)) w += WIDE_RE.test(ch) ? px : NARROW_RE.test(ch) ? px * 0.3 : /[A-Z0-9MWmw@%#&]/.test(ch) ? px * 0.64 : px * 0.53;
  return w * 1.03;
}
const TOKEN_RE = /(\s*)([ᄀ-ᅟ⺀-〾぀-꓏가-힣豈-﫿＀-｠]|[^\sᄀ-ᅟ⺀-〾぀-꓏가-힣豈-﫿＀-｠]+)/g;
/** `s` broken into lines no wider than `width` at `px` (CJK breaks between characters; a long word between letters). */
export function wrapText(s, px, width) {
  const out = [];
  for (const para of String(s ?? '').split('\n')) {
    let cur = '';
    const place = (word, sp) => {
      const cand = cur ? cur + sp + word : word;
      if (textWidth(cand, px) <= width) { cur = cand; return; }
      if (cur) out.push(cur);
      cur = '';
      if (textWidth(word, px) <= width) { cur = word; return; }
      for (const ch of word) { if (cur && textWidth(cur + ch, px) > width) { out.push(cur); cur = ch; } else cur += ch; }
    };
    for (const m of para.matchAll(TOKEN_RE)) place(m[2], m[1] ? ' ' : '');
    out.push(cur);
  }
  return out.length > 1 && out.at(-1) === '' ? out.slice(0, -1) : out;
}
/** Lines cut to `max`, the last ending in an ellipsis when something was left out. */
function clip(lines, max, px, width) {
  if (lines.length <= max) return lines;
  const kept = lines.slice(0, Math.max(1, max));
  let last = kept.at(-1);
  while (last && textWidth(`${last}…`, px) > width) last = last.slice(0, -1);
  kept[kept.length - 1] = `${last.trimEnd()}…`;
  return kept;
}
/** The largest size in `sizes` at which `s` fits `width` × `height` (line height `lh`); the smallest, clipped, otherwise. */
export function fitText(s, width, height, sizes, lh = 1.2) {
  for (const px of sizes) {
    const lines = wrapText(s, px, width);
    if (lines.length * px * lh <= height) return { px, lines, h: lines.length * px * lh };
  }
  const px = sizes.at(-1);
  const lines = clip(wrapText(s, px, width), Math.max(1, Math.floor(height / (px * lh))), px, width);
  return { px, lines, h: lines.length * px * lh };
}
const plain = (s) => citeRuns(s).map((r) => r.t).join('').replace(/\s+([.,;:!?])/g, '$1').trim(); // citation marks left out of a post
const bulletText = (b) => (typeof b === 'string' ? b : b.text);

// ── pages: each slide laid out for the format ──

/**
 * The deck as pages for a format: [{ w, h, index, part, parts, title, notes, items }]. An item is
 *   text  { x, y, w, lines, px, lh, color, weight, font: 'h'|'b', align: 'start'|'center', str }
 *   list  { x, y, w, px, entries: [{ str, lines, level, y }] }
 *   rect  { x, y, w, h, rx, fill, opacity, stroke }
 *   image { x, y, w, h, rx, id, alt }
 *   svg   { x, y, w, h, kind: 'chart'|'diagram'|'playbook', data, label }
 *   table { x, y, w, px, header, rows, colW, rowH: [header?, ...rows] }
 * Bullets or table rows that don't fit at the smallest size go on to a next page ("Title (2/3)").
 */
export function resizeDeck(deck, formatId, { label = '' } = {}) {
  const F = fmt(formatId);
  const t = themeOf(deck);
  const W = F.w, H = F.h, minD = Math.min(W, H), u = minD / 1080;
  const land = W / H > 1.15, tall = H / W > 1.5;
  const m = Math.round(minD * 0.07);
  const C = t.colors;
  const R = (px) => Math.round(px * u * 10) / 10;
  const slides = [...deck.slides];
  if (deck.sources && deck.sources.length && !slides.some((s) => s.layout === 'sources')) slides.push({ layout: 'sources', title: 'Sources', auto: true });
  const pages = [];
  let sectionNo = 0;

  slides.forEach((s, index) => {
    if (s.layout === 'section') sectionNo++;
    const make = (part = 1, parts = 1) => ({ w: W, h: H, index: index < deck.slides.length ? index : -1, layout: s.layout, part, parts, title: s.title || '', notes: part === 1 ? s.notes || '' : '', items: [] });
    const footH = R(34);
    const bottom = H - m - footH;
    const X = m, CW = W - 2 * m;
    const text = (P, str, x, y, w, h, sizes, o = {}) => {
      const f = fitText(str, w, h, sizes.map(R), o.lh || 1.2);
      P.items.push({ type: 'text', x, y, w, lines: f.lines, px: f.px, lh: o.lh || 1.2, color: o.color || C.text, weight: o.weight || 400, font: o.font || 'b', align: o.align || 'start', str, ...(o.upper ? { upper: true } : {}) });
      return f.h;
    };
    // the header: kicker and title (a continuation page says which part it is)
    const head = (P) => {
      let y = m;
      if (s.kicker && P.part === 1) { y += text(P, s.kicker.toUpperCase(), X, y, CW, R(30), [20], { color: C.accent, weight: 750, font: 'h' }) + R(10); }
      const ttl = P.parts > 1 && s.title ? `${plain(s.title)} (${P.part}/${P.parts})` : plain(s.title || '');
      if (ttl) y += text(P, ttl, X, y, CW, R(land ? 150 : tall ? 260 : 200), land ? [56, 50, 44, 40, 36, 32] : [72, 64, 58, 52, 46, 40, 36], { weight: 750, font: 'h', lh: 1.1 }) + R(26);
      return y;
    };
    // the foot: caption, takeaway (each part keeps them; they're short)
    const foot = (P) => {
      let b = bottom;
      if (s.caption) { const f = fitText(plain(s.caption), CW, R(60), [20, 18].map(R)); b -= f.h; P.items.push({ type: 'text', x: X, y: b, w: CW, lines: f.lines, px: f.px, lh: 1.2, color: C.muted, weight: 400, font: 'b', align: 'start', str: plain(s.caption) }); b -= R(12); }
      if (s.takeaway && P.part === P.parts) {
        const f = fitText(plain(s.takeaway), CW - R(44), R(90), [24, 22, 20].map(R));
        const h = f.h + R(28);
        b -= h;
        P.items.push({ type: 'rect', x: X, y: b, w: CW, h, rx: R(16), fill: C.surface, opacity: 0.85, stroke: C.accent });
        P.items.push({ type: 'text', x: X + R(22), y: b + R(14), w: CW - R(44), lines: f.lines, px: f.px, lh: 1.2, color: C.text, weight: 700, font: 'b', align: 'start', str: plain(s.takeaway) });
        b -= R(16);
      }
      return b;
    };
    const picture = (P, x, y, w, h) => P.items.push({ type: 'image', x, y, w, h, rx: R(22), id: s.image || '', alt: s.alt || s.imageQuery || s.title || '' });
    const hasPic = Boolean(s.image);
    const card = (P, x, y, w, h) => P.items.push({ type: 'rect', x, y, w, h, rx: R(20), fill: C.surface, opacity: t.glass ? 0.78 : 1, stroke: '' });
    // a bullet list in a box: the size it fits at, or null
    const listFit = (items, w, h, sizes = [34, 30, 28, 26, 24, 22, 20, 18]) => {
      for (const px0 of sizes) {
        const px = R(px0);
        const entries = [];
        let y = 0;
        for (const b of items) {
          const lines = wrapText(plain(bulletText(b)), px, w - px * 1.3);
          entries.push({ str: plain(bulletText(b)), lines, level: 0, y, px });
          y += lines.length * px * 1.25 + px * 0.5;
          if (typeof b === 'object') for (const sub of b.sub || []) {
            const spx = px * 0.85;
            const sl = wrapText(plain(sub), spx, w - px * 2.6);
            entries.push({ str: plain(sub), lines: sl, level: 1, y, px: spx });
            y += sl.length * spx * 1.25 + px * 0.35;
          }
        }
        if (y - px * 0.5 <= h) return { px, entries, h: y - px * 0.5 };
      }
      return null;
    };
    const list = (P, items, x, y, w, h, sizes) => {
      const f = listFit(items, w, h, sizes) || listFit(items.slice(0, 1), w, h, [sizes ? sizes.at(-1) : 18]);
      if (f) P.items.push({ type: 'list', x, y, w, px: f.px, entries: f.entries.map((e) => ({ ...e, y: y + e.y })), color: C.text, muted: C.muted, accent: C.accent });
      return f ? f.h : 0;
    };
    // split a picture off a body box: beside it when landscape, above it otherwise
    const split = (box, share = 0.42) => (land
      ? { pic: { x: box.x + box.w * (1 - share) + R(14), y: box.y, w: box.w * share - R(14), h: box.h }, rest: { x: box.x, y: box.y, w: box.w * (1 - share) - R(14), h: box.h } }
      : { pic: { x: box.x, y: box.y, w: box.w, h: Math.min(box.h * 0.46, box.w * 0.75) }, rest: { x: box.x, y: box.y + Math.min(box.h * 0.46, box.w * 0.75) + R(24), w: box.w, h: box.h - Math.min(box.h * 0.46, box.w * 0.75) - R(24) } });

    // pages for a run of items (bullets, table rows, sources) that may not fit one page
    const paged = (all, fits, draw) => {
      const chunks = [];
      let start = 0;
      while (start < all.length) {
        let end = all.length;
        while (end > start + 1 && !fits(all.slice(start, end), chunks.length === 0)) end--;
        chunks.push(all.slice(start, end));
        start = end;
      }
      if (!chunks.length) chunks.push([]);
      chunks.forEach((items, k) => { const P = make(k + 1, chunks.length); draw(P, items); pages.push(P); });
    };

    switch (s.layout) {
      case 'title':
      case 'section': {
        const P = make();
        let box = { x: X, y: m, w: CW, h: bottom - m };
        if (hasPic) { const sp = split(box, 0.45); picture(P, sp.pic.x, sp.pic.y, sp.pic.w, sp.pic.h); box = sp.rest; }
        const parts = [];
        if (s.layout === 'section') parts.push(['n', String(sectionNo || 1).padStart(2, '0'), [40], { color: C.accent, weight: 800, font: 'h' }, R(60)]);
        else if (s.kicker) parts.push(['k', s.kicker.toUpperCase(), [22], { color: C.accent, weight: 750, font: 'h' }, R(36)]);
        parts.push(['t', plain(s.title || deck.title), land ? [72, 64, 56, 50, 44, 38] : [96, 86, 76, 68, 60, 52, 44], { weight: 800, font: 'h', lh: 1.08 }, box.h * 0.6]);
        if (s.subtitle) parts.push(['s', plain(s.subtitle), [32, 28, 26, 24, 22], { color: C.muted }, box.h * 0.3]);
        // measure, then centre the block in the box (or keep it at the top under a picture)
        const sized = parts.map(([, str, sizes, o, maxH]) => ({ str, sizes, o, f: fitText(str, box.w, maxH, sizes.map(R), o.lh || 1.2) }));
        const total = sized.reduce((n, p) => n + p.f.h, 0) + R(18) * (sized.length - 1);
        let y = land || !hasPic ? box.y + Math.max(0, (box.h - total) / 2) : box.y + R(10);
        for (const p of sized) { text(P, p.str, box.x, y, box.w, p.f.h + 1, p.sizes, p.o); y += p.f.h + R(18); }
        P.items.push({ type: 'rect', x: box.x, y: y + R(4), w: R(96), h: R(8), rx: R(4), fill: C.accent, opacity: 1, stroke: '' });
        pages.push(P);
        break;
      }
      case 'bullets':
      case 'image':
      case 'playbook': {
        const items = s.bullets || [];
        const probe = make();
        const top = head(probe), end = foot(probe);
        const body = { x: X, y: top, w: CW, h: end - top };
        // the first page shares its body with the picture (or playbook); the pages after it are all list
        const figKind = s.layout === 'playbook' && s.playbook ? 'playbook' : hasPic || s.layout === 'image' ? 'image' : '';
        const sp = figKind && items.length ? split(body, figKind === 'image' && s.layout === 'image' ? 0.58 : figKind === 'playbook' ? 0.55 : 0.42) : null;
        const fig = figKind ? (sp ? sp.pic : body) : null;
        const inset = R(28);
        const boxFor = (P, y0) => (P.part === 1 && sp ? sp.rest : { x: X, y: y0, w: CW, h: end - y0 });
        const fits = (chunk, first) => { const b = first && sp ? sp.rest : body; return Boolean(listFit(chunk, b.w - 2 * inset, b.h - 2 * inset - (first ? 0 : R(60)))); }; // (a later page's title says "(2/3)")
        paged(items, fits, (P, chunk) => {
          const y0 = head(P);
          foot(P);
          if (fig && P.part === 1) {
            if (figKind === 'image') picture(P, fig.x, fig.y, fig.w, fig.h);
            else P.items.push({ type: 'svg', kind: 'playbook', x: fig.x, y: fig.y, w: fig.w, h: fig.h, data: s.playbook, label: s.playbook.concept || 'Playbook' });
          }
          if (chunk.length) {
            const b = boxFor(P, y0);
            card(P, b.x, b.y, b.w, b.h);
            list(P, chunk, b.x + inset, b.y + inset, b.w - 2 * inset, b.h - 2 * inset);
          }
        });
        break;
      }
      case 'two-column':
      case 'grid': {
        const P = make();
        const top = head(P), end = foot(P);
        const groups = s.layout === 'grid' ? (s.cards || []) : [s.left, s.right].filter(Boolean);
        const n = Math.max(1, groups.length);
        const cols = s.layout === 'two-column' ? (land ? 2 : 1) : land ? (n === 3 ? 3 : 2) : tall ? 1 : n >= 4 ? 2 : 1;
        const rows = Math.ceil(n / cols);
        const gap = R(20);
        const cw = (CW - gap * (cols - 1)) / cols, ch = (end - top - gap * (rows - 1)) / rows;
        const pad = R(24);
        // one body size for every card: the largest that fits them all
        const sizes = [28, 26, 24, 22, 20, 18, 17, 16, 15, 14];
        let px = sizes.at(-1);
        for (const p of sizes) {
          const hp = R(p * 1.15);
          if (groups.every((g) => { const hh = g.heading ? fitText(plain(g.heading), cw - 2 * pad, R(200), [hp]).h + R(10) : 0; return listFit(g.bullets || [], cw - 2 * pad, ch - 2 * pad - hh - (g.badge ? R(36) : 0), [p]); })) { px = p; break; }
        }
        groups.forEach((g, i) => {
          const cx = X + (i % cols) * (cw + gap), cy = top + Math.floor(i / cols) * (ch + gap);
          card(P, cx, cy, cw, ch);
          let y = cy + pad;
          if (g.badge) { y += text(P, g.badge.toUpperCase(), cx + pad, y, cw - 2 * pad, R(30), [16], { color: C.accent, weight: 750, font: 'h' }) + R(8); }
          if (g.heading) y += text(P, plain(g.heading), cx + pad, y, cw - 2 * pad, R(px * 3.6), [px * 1.15, px], { weight: 700, font: 'h' }) + R(10);
          list(P, g.bullets || [], cx + pad, y, cw - 2 * pad, cy + ch - pad - y, [px]);
        });
        pages.push(P);
        break;
      }
      case 'chart':
      case 'diagram': {
        const P = make();
        const top = head(P), end = foot(P);
        const data = s.layout === 'chart' ? s.chart : s.diagram;
        if (data) {
          card(P, X, top, CW, end - top);
          P.items.push({ type: 'svg', kind: s.layout, x: X + R(16), y: top + R(16), w: CW - R(32), h: end - top - R(32), data, label: s.title || s.layout });
        }
        if (s.layout === 'chart' && data && data.source && !s.caption) text(P, `Source: ${data.source}`, X, end + R(6), CW, R(30), [16], { color: C.muted });
        pages.push(P);
        break;
      }
      case 'table': {
        const tb = s.table || { header: [], rows: [] };
        const cols = Math.max(1, tb.header.length || (tb.rows[0] || []).length);
        const sizes = [24, 22, 20, 18, 16, 15, 14, 13];
        const measure = (rows, px) => {
          const colW = CW / cols;
          const rh = (r) => Math.max(...r.map((c) => wrapText(plain(c || ' '), px, colW - R(24)).length)) * px * 1.24 + R(18);
          return { colW, rowH: [...(tb.header.length ? [rh(tb.header)] : []), ...rows.map(rh)] };
        };
        const probe = make();
        const room = foot(probe) - head(probe);
        const fitAt = (rows) => { for (const p of sizes) { const px = R(p); const mm = measure(rows, px); if (mm.rowH.reduce((a, b) => a + b, 0) <= room) return { px, ...mm }; } return null; };
        paged(tb.rows.length ? tb.rows : [[]], (chunk) => Boolean(fitAt(chunk)), (P, chunk) => {
          const top = head(P);
          foot(P);
          const f = fitAt(chunk) || { px: R(sizes.at(-1)), ...measure(chunk, R(sizes.at(-1))) };
          P.items.push({ type: 'table', x: X, y: top, w: CW, px: f.px, colW: f.colW, rowH: f.rowH, header: tb.header.map(plain), rows: chunk.map((r) => r.map(plain)), color: C.text, muted: C.muted, accent: C.accent, surface: C.surface });
        });
        break;
      }
      case 'quote': {
        const P = make();
        let box = { x: X, y: m, w: CW, h: bottom - m };
        if (hasPic) { const sp = split(box, 0.4); picture(P, sp.pic.x, sp.pic.y, sp.pic.w, sp.pic.h); box = sp.rest; }
        const q = fitText(`“${plain(s.quote || '')}”`, box.w, box.h * 0.75, [64, 56, 50, 44, 38, 34, 30, 26, 22].map(R), 1.3);
        const by = s.by ? fitText(`— ${s.by}`, box.w, R(80), [26, 22].map(R)) : null;
        let y = box.y + Math.max(0, (box.h - q.h - (by ? by.h + R(24) : 0)) / 2);
        P.items.push({ type: 'text', x: box.x, y, w: box.w, lines: q.lines, px: q.px, lh: 1.3, color: C.text, weight: 600, font: 'h', align: 'start', str: `“${plain(s.quote || '')}”` });
        y += q.h + R(24);
        if (by) P.items.push({ type: 'text', x: box.x, y, w: box.w, lines: by.lines, px: by.px, lh: 1.2, color: C.accent, weight: 700, font: 'b', align: 'start', str: `— ${s.by}` });
        pages.push(P);
        break;
      }
      case 'stats': {
        const P = make();
        const top = head(P), end = foot(P);
        const st = s.stats || [];
        const n = Math.max(1, st.length);
        const cols = land ? n : tall ? 1 : n >= 3 ? 2 : n;
        const rows = Math.ceil(n / cols);
        const extra = s.bullets && s.bullets.length ? Math.min((end - top) * 0.32, R(260)) : 0;
        const gap = R(20), cw = (CW - gap * (cols - 1)) / cols, ch = (end - top - extra - (extra ? gap : 0) - gap * (rows - 1)) / rows;
        st.forEach((x, i) => {
          const cx = X + (i % cols) * (cw + gap), cy = top + Math.floor(i / cols) * (ch + gap), pad = R(24);
          card(P, cx, cy, cw, ch);
          const v = fitText(x.value, cw - 2 * pad, ch * 0.5, [96, 84, 72, 60, 52, 44, 36].map(R), 1.05);
          let y = cy + Math.max(pad, (ch - v.h - R(80)) / 2);
          P.items.push({ type: 'text', x: cx + pad, y, w: cw - 2 * pad, lines: v.lines, px: v.px, lh: 1.05, color: C.accent, weight: 800, font: 'h', align: 'start', str: x.value });
          y += v.h + R(10);
          y += text(P, plain(x.label), cx + pad, y, cw - 2 * pad, cy + ch - pad - y - (x.delta ? R(30) : 0), [26, 24, 22, 20, 18, 16], { color: C.text });
          if (x.delta) text(P, x.delta, cx + pad, y + R(6), cw - 2 * pad, R(30), [18], { color: C.muted, weight: 700 });
        });
        if (extra) { const by = end - extra; card(P, X, by, CW, extra); list(P, s.bullets, X + R(24), by + R(20), CW - R(48), extra - R(40), [24, 22, 20, 18, 16]); }
        pages.push(P);
        break;
      }
      case 'sources': {
        const src = deck.sources || [];
        const probe = make();
        const room = bottom - head(probe) - (label ? R(70) : 0);
        const entry = (x) => `${x.n}. ${x.title || x.url}${x.url && x.title ? `\n${x.url}` : ''}`;
        const fitsAt = (chunk) => { let h = 0; for (const x of chunk) h += fitText(entry(x), CW, R(400), [18].map(R)).h + R(12); return h <= room; };
        paged(src.length ? src : [null], (chunk) => chunk[0] === null || fitsAt(chunk), (P, chunk) => {
          let y = head(P);
          for (const x of chunk) if (x) y += text(P, entry(x), X, y, CW, R(400), [18], { color: C.text }) + R(12);
          if (label && P.part === P.parts) text(P, `Eden’s check: ${label}`, X, bottom - R(50), CW, R(50), [16], { color: C.muted });
        });
        break;
      }
      default: {
        const P = make();
        const top = head(P), end = foot(P);
        if (s.bullets) { card(P, X, top, CW, end - top); list(P, s.bullets, X + R(28), top + R(28), CW - R(56), end - top - R(56)); }
        pages.push(P);
      }
    }
  });
  // the foot of every page: the deck's title and the page number
  const total = pages.length;
  pages.forEach((P, k) => {
    P.items.push({ type: 'text', x: m, y: H - m - R(22), w: (W - 2 * m) * 0.75, lines: clip(wrapText(plain(deck.title), R(16), (W - 2 * m) * 0.75), 1, R(16), (W - 2 * m) * 0.75), px: R(16), lh: 1.2, color: C.muted, weight: 600, font: 'b', align: 'start', str: plain(deck.title), foot: true });
    P.items.push({ type: 'text', x: W - m - R(120), y: H - m - R(22), w: R(120), lines: [`${k + 1} / ${total}`], px: R(16), lh: 1.2, color: C.muted, weight: 600, font: 'b', align: 'end', str: `${k + 1} / ${total}`, foot: true });
  });
  return pages;
}

// ── drawing a page: one standalone SVG (no script, no outside resource; pictures are data: URLs) ──

const n1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : 0);
const COLOR = /^#[0-9a-f]{3,8}$/i;
const col = (c, d = '#000000') => (COLOR.test(String(c)) ? c : d);

/** The inner SVG the renderer draws for a chart, diagram or playbook at this box's size (its screen-reader table left out). */
export function itemSvg(it, theme) {
  const draw = it.kind === 'chart' ? chartSvg : it.kind === 'diagram' ? diagramSvg : playbookSvg;
  const svg = draw(it.data, theme, it.w, it.h);
  return svg.slice(0, svg.indexOf('</svg>') + 6);
}

/** A page as SVG text. opts: { images: { id: { data } }, theme, rtl, lang } */
export function pageSvg(page, deck, { images = {}, lang = '' } = {}) {
  const t = themeOf(deck);
  const C = t.colors;
  const rtl = dirOf(lang || deck.lang) === 'rtl';
  const W = page.w, H = page.h;
  const font = (f) => esc(f === 'h' ? t.heading.css : t.body.css);
  const out = [];
  let clipN = 0;
  const defs = [`<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${col(C.bg)}"/><stop offset="1" stop-color="${col(C.bg2, C.bg)}"/></linearGradient>`,
    `<radialGradient id="o1"><stop offset="0" stop-color="${col(C.accent)}" stop-opacity="${t.dark ? 0.32 : 0.22}"/><stop offset="1" stop-color="${col(C.accent)}" stop-opacity="0"/></radialGradient>`,
    `<radialGradient id="o2"><stop offset="0" stop-color="${col(C.accent2)}" stop-opacity="${t.dark ? 0.28 : 0.18}"/><stop offset="1" stop-color="${col(C.accent2)}" stop-opacity="0"/></radialGradient>`];
  out.push(`<rect width="${W}" height="${H}" fill="url(#bg)"/>`);
  const r = Math.max(W, H) * 0.42;
  out.push(`<circle cx="${n1(W * 0.92)}" cy="${n1(H * 0.04)}" r="${n1(r)}" fill="url(#o1)"/><circle cx="${n1(W * 0.06)}" cy="${n1(H * 0.98)}" r="${n1(r)}" fill="url(#o2)"/>`);
  // one line of text at (x, top y): RTL anchors at the right edge
  const lineX = (it) => (it.align === 'center' ? it.x + it.w / 2 : (it.align === 'end') !== rtl ? it.x + it.w : it.x);
  const anchor = (it) => (it.align === 'center' ? 'middle' : (it.align === 'end') !== rtl ? 'end' : 'start');
  const dirAttr = rtl ? ' direction="rtl" unicode-bidi="embed"' : '';
  const textEl = (it, lines, x, y, px, lh, fill, weight, f, anc) =>
    `<text x="${n1(x)}" y="${n1(y + px * 0.92)}" font-size="${n1(px)}" font-weight="${weight}" font-family="${font(f)}" fill="${col(fill)}" text-anchor="${anc}"${dirAttr}>${lines.map((l, i) => `<tspan x="${n1(x)}" dy="${i ? n1(px * lh) : 0}">${esc(l)}</tspan>`).join('')}</text>`;
  for (const it of page.items) {
    if (it.type === 'rect') out.push(`<rect x="${n1(it.x)}" y="${n1(it.y)}" width="${n1(it.w)}" height="${n1(Math.max(0, it.h))}" rx="${n1(it.rx)}" fill="${col(it.fill)}" fill-opacity="${it.opacity ?? 1}"${it.stroke ? ` stroke="${col(it.stroke)}" stroke-width="2"` : ` stroke="${col(C.text)}" stroke-opacity=".06"`}/>`);
    else if (it.type === 'text') out.push(textEl(it, it.lines, lineX(it), it.y, it.px, it.lh, it.color, it.weight, it.font, anchor(it)));
    else if (it.type === 'list') {
      for (const e of it.entries) {
        const ind = e.level ? it.px * 1.3 : 0, gut = it.px * 1.3;
        const tx = rtl ? it.x + it.w - ind - gut : it.x + ind + gut;
        const dotX = rtl ? it.x + it.w - ind - it.px * 0.45 : it.x + ind + it.px * 0.45;
        out.push(`<circle cx="${n1(dotX)}" cy="${n1(e.y + e.px * 0.62)}" r="${n1(e.px * (e.level ? 0.14 : 0.2))}" fill="${col(e.level ? it.muted : it.accent)}"/>`);
        out.push(textEl(it, e.lines, tx, e.y, e.px, 1.25, e.level ? it.muted : it.color, 400, 'b', 'start'));
      }
    } else if (it.type === 'image') {
      const src = imageData(images[it.id]);
      const id = `c${clipN++}`;
      defs.push(`<clipPath id="${id}"><rect x="${n1(it.x)}" y="${n1(it.y)}" width="${n1(it.w)}" height="${n1(Math.max(0, it.h))}" rx="${n1(it.rx)}"/></clipPath>`);
      if (src) out.push(`<image href="${esc(src)}" x="${n1(it.x)}" y="${n1(it.y)}" width="${n1(it.w)}" height="${n1(Math.max(0, it.h))}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id})"><title>${esc(it.alt)}</title></image>`);
      else out.push(`<rect x="${n1(it.x)}" y="${n1(it.y)}" width="${n1(it.w)}" height="${n1(Math.max(0, it.h))}" rx="${n1(it.rx)}" fill="${col(C.surface)}" stroke="${col(C.muted)}" stroke-dasharray="8 6"/>${textEl({ align: 'center' }, wrapText(it.alt || 'Picture', 20, it.w - 40).slice(0, 3), it.x + it.w / 2, it.y + it.h / 2 - 20, 20, 1.2, C.muted, 500, 'b', 'middle')}`);
    } else if (it.type === 'svg') {
      out.push(`<g transform="translate(${n1(it.x)} ${n1(it.y)})" font-family="${font('b')}">${itemSvg(it, t)}</g>`);
    } else if (it.type === 'table') {
      let y = it.y;
      const all = [...(it.header.length ? [it.header] : []), ...it.rows];
      all.forEach((row, ri) => {
        const h = it.rowH[ri] || 0;
        const isHead = ri === 0 && it.header.length;
        out.push(`<rect x="${n1(it.x)}" y="${n1(y)}" width="${n1(it.w)}" height="${n1(h)}" fill="${col(isHead ? it.accent : it.surface)}" fill-opacity="${isHead ? 0.14 : ri % 2 ? 0.55 : 0.85}"/>`);
        row.forEach((c, ci) => {
          const cx = rtl ? it.x + it.w - (ci + 1) * it.colW : it.x + ci * it.colW;
          const lines = wrapText(c || '', it.px, it.colW - 24);
          out.push(textEl({ align: 'start' }, lines, rtl ? cx + it.colW - 12 : cx + 12, y + 9, it.px, 1.24, isHead ? it.color : it.color, isHead ? 700 : 400, isHead ? 'h' : 'b', 'start'));
        });
        y += h;
      });
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"${lang || deck.lang ? ` lang="${esc(lang || deck.lang)}"` : ''}${rtl ? ' direction="rtl"' : ''} role="img" aria-label="${esc(page.title || deck.title)}"><defs>${defs.join('')}</defs>${out.join('')}</svg>`;
}

// ── PDF: one picture a page (JPEG, DCTDecode), at the format's page size ──

const enc = (s) => new TextEncoder().encode(s);
/** A PDF string: plain ASCII as (…), anything else as UTF-16BE hex with a BOM. */
function pdfText(s) {
  const str = String(s || '');
  if (/^[\x20-\x7e]*$/.test(str)) return `(${str.replace(/[\\()]/g, (c) => `\\${c}`)})`;
  let hex = 'FEFF';
  for (let i = 0; i < str.length; i++) hex += str.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${hex}>`;
}
/**
 * A PDF file of pictures. pages: [{ jpeg: Uint8Array, px: [w, h] (the picture's pixels), pt: [w, h] }] → Uint8Array.
 */
export function pdfBytes(pages, { title = '' } = {}) {
  const parts = [];
  const offsets = [];
  let len = 0;
  const put = (b) => { const u = typeof b === 'string' ? enc(b) : b; parts.push(u); len += u.length; };
  const obj = (id, body) => { offsets[id] = len; put(`${id} 0 obj\n`); for (const b of [].concat(body)) put(b); put('\nendobj\n'); };
  put('%PDF-1.4\n');
  const n = pages.length;
  const pageId = (k) => 4 + k * 3;
  obj(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  obj(2, `<< /Type /Pages /Count ${n} /Kids [${pages.map((_, k) => `${pageId(k)} 0 R`).join(' ')}] >>`);
  obj(3, `<< /Producer (Eden) /Title ${pdfText(title)} >>`);
  pages.forEach((p, k) => {
    const [w, h] = p.pt.map((v) => Math.round(v * 100) / 100);
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    obj(pageId(k), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${pageId(k) + 2} 0 R >> >> /Contents ${pageId(k) + 1} 0 R >>`);
    obj(pageId(k) + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    obj(pageId(k) + 2, [`<< /Type /XObject /Subtype /Image /Width ${p.px[0]} /Height ${p.px[1]} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`, p.jpeg, '\nendstream']);
  });
  const total = 4 + n * 3;
  const xref = len;
  put(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let id = 1; id < total; id++) put(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  put(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const outBytes = new Uint8Array(len);
  let at = 0;
  for (const b of parts) { outBytes.set(b, at); at += b.length; }
  return outBytes;
}

// ── PowerPoint (4:3): editable text, the pictures cropped to fill, charts and diagrams as pictures ──

const IN = (px) => Math.round((px / 96) * 1000) / 1000;
const PT = (px) => Math.round(px * 0.75 * 10) / 10;
const HEX = (c) => col(c).replace('#', '').toUpperCase().slice(0, 6);
const PPTX_IMAGE = /^data:image\/(png|jpe?g|gif);base64,/i;

/**
 * The 4:3 presentation. `Pptx` is the PptxGenJS constructor; pages from resizeDeck(deck, '4x3').
 * opts: { images: { id: { data, w, h } }, rasters: { 'page:item': pngDataUrl } (charts/diagrams drawn as PNG), lang }
 */
export function buildResizedPptx(Pptx, deck, pages, { images = {}, rasters = {}, lang = '' } = {}) {
  const pres = new Pptx();
  const t = themeOf(deck);
  const rtl = dirOf(lang || deck.lang) === 'rtl';
  pres.defineLayout({ name: 'EDEN_4X3', width: 10, height: 7.5 });
  pres.layout = 'EDEN_4X3';
  pres.title = deck.title;
  pres.author = 'Eden';
  pres.theme = { headFontFace: t.heading.pptx, bodyFontFace: t.body.pptx };
  const align = (a) => (a === 'center' ? 'center' : (a === 'end') !== rtl ? 'right' : 'left');
  pages.forEach((page, k) => {
    const slide = pres.addSlide();
    slide.background = { color: HEX(t.colors.bg) };
    page.items.forEach((it, j) => {
      if (it.type === 'rect') slide.addShape(pres.ShapeType.roundRect, { x: IN(it.x), y: IN(it.y), w: IN(it.w), h: IN(Math.max(1, it.h)), fill: { color: HEX(it.fill), transparency: Math.round((1 - (it.opacity ?? 1)) * 100) }, line: it.stroke ? { color: HEX(it.stroke), width: 1.5 } : { color: HEX(it.fill), transparency: 100 }, rectRadius: Math.min(0.3, IN(it.rx)) });
      else if (it.type === 'text') slide.addText(it.str.replace(/\n/g, ' ').trim() === it.str.trim() ? it.str : it.str, { x: IN(it.x), y: IN(it.y), w: IN(it.w), h: IN(it.lines.length * it.px * it.lh + it.px * 0.4), fontFace: it.font === 'h' ? t.heading.pptx : t.body.pptx, fontSize: PT(it.px), bold: it.weight >= 650, color: HEX(it.color), align: align(it.align), valign: 'top', margin: 0, fit: 'shrink', rtlMode: rtl, ...(it.foot ? {} : {}) });
      else if (it.type === 'list') {
        const runs = it.entries.map((e, i) => ({ text: e.str, options: { bullet: { indent: PT(it.px) * 1.1 }, ...(e.level ? { indentLevel: 1 } : {}), fontSize: PT(e.px), color: HEX(e.level ? it.muted : it.color), paraSpaceAfter: PT(it.px * 0.4), breakLine: i < it.entries.length - 1, rtlMode: rtl } }));
        const last = it.entries.at(-1);
        const h = last ? last.y - it.y + last.lines.length * last.px * 1.25 : it.px;
        if (runs.length) slide.addText(runs, { x: IN(it.x), y: IN(it.y), w: IN(it.w), h: IN(h + it.px * 0.5), fontFace: t.body.pptx, valign: 'top', margin: 0, fit: 'shrink', align: rtl ? 'right' : 'left', rtlMode: rtl });
      } else if (it.type === 'image') {
        const im = images[it.id];
        const data = imageData(im);
        if (data && PPTX_IMAGE.test(data)) {
          // cropped to fill the box: the picture's own proportions, scaled to cover it
          const iw = (im && im.w) || it.w, ih = (im && im.h) || it.h;
          const s = Math.max(it.w / iw, it.h / ih);
          slide.addImage({ data: data.replace(/^data:/, ''), x: IN(it.x), y: IN(it.y), w: IN(iw * s), h: IN(ih * s), sizing: { type: 'cover', w: IN(it.w), h: IN(it.h) }, altText: it.alt || '' });
        } else slide.addText(it.alt || 'Picture', { x: IN(it.x), y: IN(it.y), w: IN(it.w), h: IN(it.h), align: 'center', color: HEX(t.colors.muted), fontSize: 14, line: { color: HEX(t.colors.muted), dashType: 'dash' } });
      } else if (it.type === 'svg') {
        const png = rasters[`${k}:${j}`];
        if (png && /^data:image\/png;base64,/.test(png)) slide.addImage({ data: png.replace(/^data:/, ''), x: IN(it.x), y: IN(it.y), w: IN(it.w), h: IN(it.h), altText: String(it.label || it.kind) });
      } else if (it.type === 'table') {
        const row = (r, head) => r.map((c) => ({ text: c || '', options: { bold: head, color: HEX(it.color), fill: { color: HEX(head ? t.colors.surface : t.colors.bg) }, rtlMode: rtl, align: rtl ? 'right' : 'left' } }));
        const rows = [...(it.header.length ? [row(it.header, true)] : []), ...it.rows.map((r) => row(r, false))];
        if (rows.length) slide.addTable(rows, { x: IN(it.x), y: IN(it.y), w: IN(it.w), colW: rows[0].map(() => IN(it.colW)), fontSize: PT(it.px), fontFace: t.body.pptx, border: { type: 'solid', color: HEX(t.colors.muted), pt: 0.5 }, margin: 0.06, autoPage: false });
      }
    });
    if (page.notes) slide.addNotes(page.notes);
  });
  return pres;
}

// ── in the browser: pictures of pages, the downloads, the dialog ──

/** An SVG drawn to a canvas → Blob ('image/png' or 'image/jpeg'). */
export async function rasterize(svg, w, h, type = 'image/png', quality = 0.92) {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    if (type === 'image/jpeg') { g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); }
    g.drawImage(img, 0, 0, w, h);
    const blob = await new Promise((res) => c.toBlob(res, type, quality));
    if (!blob) throw new Error('The browser couldn’t draw this page.');
    return blob;
  } finally { URL.revokeObjectURL(url); }
}
const dataUrl = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
/** Pictures' natural sizes (PowerPoint needs them to crop), read from the data where the store has none. */
async function withSizes(images, ids) {
  const out = { ...images };
  for (const id of ids) {
    const im = out[id];
    const data = imageData(im);
    if (!data || (im.w && im.h)) continue;
    try { const i = new Image(); i.src = data; await i.decode(); out[id] = { ...im, w: i.naturalWidth, h: i.naturalHeight }; } catch { /* left to fill as drawn */ }
  }
  return out;
}

/** The pages as PNG files in a .zip → { blob, name } */
export async function pngZip(deck, formatId, { images = {}, label = '', onProgress = () => {} } = {}) {
  const { loadPptx } = await import('./deck-pptx.js');
  await loadPptx(); // JSZip comes with PptxGenJS
  const JSZip = globalThis.JSZip;
  if (!JSZip) throw new Error('The zip library didn’t load.');
  const pages = resizeDeck(deck, formatId, { label });
  const { w, h } = pngSize(formatId);
  const zip = new JSZip();
  const base = deckFileName(deck.title, 'png').replace(/\.png$/, '');
  for (let k = 0; k < pages.length; k++) {
    onProgress(k + 1, pages.length);
    zip.file(`${base}-${formatId}-${String(k + 1).padStart(2, '0')}.png`, await rasterize(pageSvg(pages[k], deck, { images }), w, h));
  }
  return { blob: await zip.generateAsync({ type: 'blob' }), name: `${base}-${formatId}.zip` };
}

/** The pages as a PDF → { blob, name } */
export async function pdfBlob(deck, formatId, { images = {}, label = '', onProgress = () => {} } = {}) {
  const pages = resizeDeck(deck, formatId, { label });
  const { w, h } = pngSize(formatId);
  const pt = pdfPageSize(formatId);
  const out = [];
  for (let k = 0; k < pages.length; k++) {
    onProgress(k + 1, pages.length);
    const jpeg = new Uint8Array(await (await rasterize(pageSvg(pages[k], deck, { images }), w, h, 'image/jpeg', 0.9)).arrayBuffer());
    out.push({ jpeg, px: [w, h], pt });
  }
  return { blob: new Blob([pdfBytes(out, { title: deck.title })], { type: 'application/pdf' }), name: deckFileName(deck.title, 'pdf').replace(/\.pdf$/, `-${formatId}.pdf`) };
}

/** The 4:3 PowerPoint → { blob, name } */
export async function pptx43Blob(deck, { images = {}, label = '', onProgress = () => {} } = {}) {
  const { loadPptx } = await import('./deck-pptx.js');
  const Pptx = await loadPptx();
  const pages = resizeDeck(deck, '4x3', { label });
  const t = themeOf(deck);
  const rasters = {};
  for (let k = 0; k < pages.length; k++) {
    onProgress(k + 1, pages.length);
    for (const [j, it] of pages[k].items.entries()) {
      if (it.type !== 'svg') continue;
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${n1(it.w)}" height="${n1(it.h)}" font-family="${esc(t.body.css)}">${itemSvg(it, t)}</svg>`;
      rasters[`${k}:${j}`] = await dataUrl(await rasterize(svg, Math.round(it.w * 2), Math.round(it.h * 2)));
    }
  }
  const sized = await withSizes(images, [...new Set(pages.flatMap((p) => p.items.filter((i) => i.type === 'image').map((i) => i.id)))]);
  const pres = buildResizedPptx(Pptx, deck, pages, { images: sized, rasters });
  return { blob: await pres.write({ outputType: 'blob' }), name: deckFileName(deck.title, 'pptx').replace(/\.pptx$/, '-4x3.pptx') };
}

const CSS = `
.drz-dialog{margin:auto;border:0;border-radius:20px;padding:0;width:min(760px,94vw);height:fit-content;max-height:92dvh;overflow:auto;color:var(--text);background:var(--content);font:15px/1.35 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.08),0 24px 64px rgba(0,0,0,.16)}
.drz-dialog::backdrop{background:rgba(0,0,0,.3)}
.drz-dialog *{font-family:inherit}
.drz-body{display:flex;flex-direction:column;gap:12px;padding:20px;box-sizing:border-box}
.drz-body>*{flex:none}
.drz-body h3{margin:0;font-size:17px;font-weight:600}
.drz-body p{margin:0;font-size:13px;color:var(--text2)}
.drz-formats{display:flex;gap:8px;overflow-x:auto;padding:2px;scroll-snap-type:x proximity}
.drz-format{flex:none;display:flex;flex-direction:column;align-items:center;gap:6px;width:104px;min-height:40px;padding:8px 6px;border:1px solid var(--hairline);border-radius:14px;background:var(--content2);color:var(--text);font:inherit;font-size:12px;line-height:1.25;text-align:center;cursor:pointer;scroll-snap-align:start}
.drz-format[aria-pressed="true"]{outline:2px solid var(--accent);outline-offset:-2px}
.drz-format small{color:var(--text2);font-size:10.5px}
.drz-shape{display:block;border-radius:4px;background:color-mix(in srgb,var(--accent) 22%,transparent);border:1.5px solid var(--accent)}
.drz-preview{display:flex;gap:12px;overflow-x:auto;min-height:180px;padding:6px 2px 10px;scroll-snap-type:x proximity}
.drz-preview figure{flex:none;margin:0;display:flex;flex-direction:column;gap:4px;align-items:center;scroll-snap-align:start}
.drz-preview img{display:block;width:auto;height:auto;max-height:min(340px,42dvh);max-width:76vw;border-radius:9px;box-shadow:0 1px 2px rgba(0,0,0,.05),0 12px 32px rgba(0,0,0,.10)}
.drz-preview figcaption{font-size:11px;color:var(--text2)}
.drz-acts{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;align-items:center}
.drz-acts .drz-status{margin-right:auto;font-size:12.5px;color:var(--text2)}
.drz-acts .btn{min-height:40px}
.drz-acts .btn[disabled]{opacity:.5;cursor:default}
`;
function addCss() {
  if (document.getElementById('deckResizeCss')) return;
  const st = document.createElement('style');
  st.id = 'deckResizeCss';
  st.textContent = CSS;
  document.head.append(st);
}
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (v == null) continue; if (k === 'onclick') e.addEventListener('click', v); else if (k === 'text') e.textContent = v; else e.setAttribute(k, v); }
  e.append(...kids.filter((x) => x != null));
  return e;
};

/**
 * The Magic Resize dialog (web only; deck.js opens it from the Export tray).
 * ctx: { deck, images, label, download(blob, name), toast(text), tx(text) }
 */
export function openResize(ctx) {
  addCss();
  const tx = ctx.tx || ((s) => s);
  const { deck, images = {}, label = '' } = ctx;
  let current = '4x3';
  let urls = [];
  let busy = false;
  const status = h('span', { class: 'drz-status', role: 'status' });
  const preview = h('div', { class: 'drz-preview', role: 'list', 'aria-label': tx('Preview') });
  const btnPng = h('button', { type: 'button', class: 'btn' }, tx('Download PNG (.zip)'));
  const btnPdf = h('button', { type: 'button', class: 'btn' }, tx('Download PDF'));
  const btnPptx = h('button', { type: 'button', class: 'btn primary' }, tx('Download PowerPoint'));
  const formats = h('div', { class: 'drz-formats', role: 'group', 'aria-label': tx('Formats') });
  const choose = (id) => {
    current = id;
    formats.querySelectorAll('.drz-format').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === id)));
    btnPptx.hidden = !FORMATS[id].pptx;
    btnPng.className = FORMATS[id].pptx ? 'btn' : 'btn primary';
    draw();
  };
  for (const id of FORMAT_IDS) {
    const F = FORMATS[id];
    const k = 34 / Math.max(F.w, F.h);
    formats.append(h('button', { type: 'button', class: 'drz-format', 'data-id': id, 'aria-pressed': 'false', onclick: () => choose(id) },
      h('span', { class: 'drz-shape', 'aria-hidden': 'true', style: `width:${Math.round(F.w * k)}px;height:${Math.round(F.h * k)}px` }), h('span', { text: tx(F.name) }), h('small', { text: tx(F.hint) })));
  }
  formats.addEventListener('keydown', (e) => { // ← → along the formats
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const all = [...formats.querySelectorAll('.drz-format')];
    const next = all[all.indexOf(e.target) + (e.key === 'ArrowRight' ? 1 : -1)];
    if (next) { e.preventDefault(); next.focus(); }
  });
  function draw() {
    for (const u of urls) URL.revokeObjectURL(u);
    urls = [];
    let pages;
    try { pages = resizeDeck(deck, current, { label }); } catch (e) { status.textContent = tx('Couldn’t lay out this format: ') + e.message; preview.replaceChildren(); return; }
    preview.replaceChildren(...pages.map((p, k) => {
      const u = URL.createObjectURL(new Blob([pageSvg(p, deck, { images })], { type: 'image/svg+xml' }));
      urls.push(u);
      return h('figure', { role: 'listitem' }, h('img', { src: u, alt: `${tx('Page')} ${k + 1}: ${p.title || deck.title}`, loading: k > 3 ? 'lazy' : null }), h('figcaption', { text: `${k + 1}` }));
    }));
    const { w, h: hh } = pngSize(current);
    status.textContent = `${pages.length} ${pages.length === 1 ? tx('page') : tx('pages')} · PNG ${w}×${hh}`;
  }
  const run = (make, done) => async () => {
    if (busy) return;
    busy = true;
    for (const b of [btnPng, btnPdf, btnPptx]) b.disabled = true;
    try {
      const { blob, name } = await make({ images, label, onProgress: (k, nn) => { status.textContent = `${tx('Drawing page')} ${k} / ${nn}…`; } });
      ctx.download(blob, name);
      status.textContent = tx(done);
    } catch (e) { status.textContent = `${tx('Export failed:')} ${e.message}`; }
    finally { busy = false; for (const b of [btnPng, btnPdf, btnPptx]) b.disabled = false; }
  };
  btnPng.addEventListener('click', run((o) => pngZip(deck, current, o), 'Saved the pictures (.zip)'));
  btnPdf.addEventListener('click', run((o) => pdfBlob(deck, current, o), 'Saved as PDF'));
  btnPptx.addEventListener('click', run((o) => pptx43Blob(deck, o), 'Saved as a 4:3 PowerPoint'));
  const close = h('button', { type: 'button', class: 'btn' }, tx('Close'));
  const dlg = h('dialog', { class: 'drz-dialog', 'aria-labelledby': 'drTitle' },
    h('div', { class: 'drz-body' }, h('h3', { id: 'drTitle', text: tx('Magic Resize') }), h('p', { text: tx('The deck laid out again for another size. Your slides stay as they are.') }),
      formats, preview, h('div', { class: 'drz-acts' }, status, close, btnPng, btnPdf, btnPptx)));
  close.addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => { for (const u of urls) URL.revokeObjectURL(u); dlg.remove(); if (ctx.returnFocus) ctx.returnFocus.focus(); });
  dlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.stopPropagation(); }, true); // the dialog closes, not the canvas
  document.body.append(dlg);
  dlg.showModal();
  choose(current);
  formats.querySelector('.drz-format').focus();
  return dlg;
}
