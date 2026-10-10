// A deck as a PowerPoint file (ROADMAP Q14): real, editable text boxes, the speaker notes, the theme's
// colors and fonts, native PowerPoint charts and tables, diagrams as shapes, the person's pictures with
// their alt text. Built with PptxGenJS 3.12.0 (MIT; pptxgen.bundle.js vendored from npm as published,
// sha512 ZozkYKWb…RUA==, which bundles JSZip, MIT), loaded the first time someone exports.
// buildPptx() is pure given the PptxGenJS constructor (src/__tests__/deck.test.ts runs it in Node);
// the sizes are the same ones the canvas uses (deck-model.js layoutDeck), at 96 px to the inch.

import { SLIDE_W, SLIDE_H, PX_PER_IN, M, themeOf, titleFit, layoutDeck, partTitle, citeRuns, diagramLayout, linkEnds, deckFileName, shortNum } from './deck-model.js';
import { imageData } from './deck-render.js';

const IN = (px) => Math.round((px / PX_PER_IN) * 1000) / 1000;
const PT = (px) => Math.round(px * 0.75 * 10) / 10; // CSS px → points
const C = (hex) => String(hex || '#000000').replace('#', '').toUpperCase();
const PALETTE = (t) => [t.colors.accent, t.colors.accent2, '#F5A524', '#17A673', '#E5484D', '#8E8E93'].map(C);
const bulletText = (b) => (typeof b === 'string' ? b : b.text);

/** Text runs with citation markers as superscript. */
function runs(s, known, opts = {}) {
  return citeRuns(s, known).map((r) => ({ text: r.t, options: { ...opts, ...(r.cite ? { superscript: true } : {}) } }));
}

function bulletRuns(items, known, t, px) {
  const out = [];
  // one paragraph per bullet: only its first run carries the paragraph's options (a run with `bullet` starts a new one)
  const para = (str, first, rest) => {
    const r = runs(str, known, rest);
    if (r.length) r[0].options = { ...r[0].options, ...first };
    r[r.length - 1].options.breakLine = true;
    out.push(...r);
  };
  for (const b of items || []) {
    para(bulletText(b), { bullet: { indent: PT(px) * 1.1 }, paraSpaceAfter: PT(px * 0.45) }, { color: C(t.colors.text), fontSize: PT(px) });
    if (typeof b === 'object') for (const s of b.sub || []) para(s, { bullet: { indent: PT(px) }, indentLevel: 1, paraSpaceAfter: PT(px * 0.3) }, { color: C(t.colors.muted), fontSize: PT(px * 0.85) });
  }
  if (out.length) out[out.length - 1].options.breakLine = false;
  return out;
}

/**
 * The presentation for a deck. `Pptx` is the PptxGenJS constructor; `images` { id: { data, w, h } }.
 * → the PptxGenJS presentation (call .write()).
 */
export function buildPptx(Pptx, deck, { images = {}, label = '' } = {}) {
  const pres = new Pptx();
  const t = themeOf(deck);
  pres.layout = 'LAYOUT_WIDE'; // 13.333 × 7.5 in, the canvas's 1280 × 720
  pres.title = deck.title;
  pres.author = 'Eden';
  pres.company = '';
  pres.theme = { headFontFace: t.heading.pptx, bodyFontFace: t.body.pptx };
  const known = new Set((deck.sources || []).map((s) => s.n));
  const W = IN(SLIDE_W - 2 * M.x), X = IN(M.x);
  const drawn = layoutDeck(deck, { label });
  let sectionNo = 0;
  drawn.forEach((r, k) => {
    const s = r.slide;
    const slide = pres.addSlide();
    slide.background = { color: C(t.colors.bg) };
    const title = partTitle(r);
    const titleH = title ? Math.ceil((title.length * r.fit.title * 0.52 * 1.06) / (SLIDE_W - 2 * M.x)) * r.fit.title * 1.1 : 0;
    const bodyY = M.top + titleH + M.gap;
    const bodyH = SLIDE_H - bodyY - M.bottom - (s.caption ? 40 : 0);
    const head = (opts = {}) => { if (title) slide.addText(runs(title, known), { x: X, y: IN(M.top), w: W, h: IN(titleH + 8), fontFace: t.heading.pptx, fontSize: PT(r.fit.title), bold: true, color: C(t.colors.text), valign: 'top', margin: 0, fit: 'shrink', ...opts }); };
    const caption = () => { if (s.caption) slide.addText(runs(s.caption, known), { x: X, y: IN(SLIDE_H - M.bottom - 34), w: W, h: IN(30), fontSize: PT(18), color: C(t.colors.muted), fontFace: t.body.pptx, margin: 0 }); };
    const card = (x, y, w, h) => slide.addShape(pres.ShapeType.roundRect, { x: IN(x), y: IN(y), w: IN(w), h: IN(h), fill: { color: C(t.colors.surface), transparency: t.glass ? 35 : 0 }, line: { color: C(t.colors.surface), transparency: 100 }, rectRadius: 0.2 });
    if (s.layout !== 'title' && s.layout !== 'section') slide.addText(String(k + 1), { x: IN(SLIDE_W - M.x - 60), y: IN(SLIDE_H - 40), w: IN(60), h: IN(24), fontSize: 10, color: C(t.colors.muted), align: 'right', margin: 0 });
    switch (s.layout) {
      case 'title':
        slide.addShape(pres.ShapeType.roundRect, { x: X, y: IN(250), w: IN(96), h: IN(8), fill: { color: C(t.colors.accent) }, line: { color: C(t.colors.accent) }, rectRadius: 0.05 });
        {
          const th = titleFit(s.title || deck.title, SLIDE_W - 2 * M.x, [r.fit.title]).lines * r.fit.title * 1.15;
          slide.addText(runs(s.title || deck.title, known), { x: X, y: IN(272), w: W, h: IN(th + 10), fontFace: t.heading.pptx, fontSize: PT(r.fit.title), bold: true, color: C(t.colors.text), valign: 'top', margin: 0, fit: 'shrink' });
          if (s.subtitle) slide.addText(runs(s.subtitle, known), { x: X, y: IN(272 + th + 20), w: W, h: IN(90), fontSize: PT(r.fit.body), color: C(t.colors.muted), fontFace: t.body.pptx, valign: 'top', margin: 0 });
        }
        break;
      case 'section':
        sectionNo++;
        slide.addText(String(sectionNo).padStart(2, '0'), { x: X, y: IN(250), w: W, h: IN(40), fontSize: PT(28), bold: true, color: C(t.colors.accent), fontFace: t.heading.pptx, margin: 0 });
        slide.addText(runs(s.title || '', known), { x: X, y: IN(296), w: W, h: IN(r.fit.title * 2.4), fontFace: t.heading.pptx, fontSize: PT(r.fit.title), bold: true, color: C(t.colors.text), valign: 'top', margin: 0, fit: 'shrink' });
        if (s.subtitle) slide.addText(runs(s.subtitle, known), { x: X, y: IN(296 + r.fit.title * 2.5), w: W, h: IN(80), fontSize: PT(r.fit.body), color: C(t.colors.muted), margin: 0 });
        break;
      case 'two-column': {
        head();
        const cw = (SLIDE_W - 2 * M.x - 48) / 2;
        ['left', 'right'].forEach((side, i) => {
          const x = M.x + i * (cw + 48);
          card(x, bodyY, cw, bodyH);
          const items = [];
          if (s[side].heading) items.push({ text: s[side].heading, options: { bold: true, color: C(t.colors.accent), fontSize: PT(r.fit.body * 1.1), breakLine: true, paraSpaceAfter: 8 } });
          items.push(...bulletRuns(s[side].bullets, known, t, r.fit.body));
          slide.addText(items, { x: IN(x + 28), y: IN(bodyY + 24), w: IN(cw - 56), h: IN(bodyH - 48), valign: 'top', fontFace: t.body.pptx, margin: 0, fit: 'shrink' });
        });
        caption();
        break;
      }
      case 'image': {
        head();
        const im = images[s.image];
        const data = imageData(im);
        const boxW = s.bullets ? (SLIDE_W - 2 * M.x) * 0.55 : SLIDE_W - 2 * M.x;
        if (data && im.w && im.h) {
          const k2 = Math.min(boxW / im.w, bodyH / im.h);
          const w = im.w * k2, h = im.h * k2;
          slide.addImage({ data: data.replace(/^data:/, ''), x: IN(M.x + (boxW - w) / 2), y: IN(bodyY + (bodyH - h) / 2), w: IN(w), h: IN(h), altText: s.alt || '' });
        } else slide.addText(s.alt || 'Picture', { x: X, y: IN(bodyY), w: IN(boxW), h: IN(bodyH), align: 'center', color: C(t.colors.muted), fontSize: 16, line: { color: C(t.colors.muted), dashType: 'dash' } });
        if (s.bullets) slide.addText(bulletRuns(s.bullets, known, t, r.fit.body), { x: IN(M.x + boxW + 40), y: IN(bodyY), w: IN(SLIDE_W - 2 * M.x - boxW - 40), h: IN(bodyH), valign: 'middle', fontFace: t.body.pptx, margin: 0, fit: 'shrink' });
        caption();
        break;
      }
      case 'chart': {
        head();
        const c = s.chart;
        const type = { bar: pres.ChartType.bar, hbar: pres.ChartType.bar, line: pres.ChartType.line, area: pres.ChartType.area, pie: pres.ChartType.pie, doughnut: pres.ChartType.doughnut }[c.type];
        const round = c.type === 'pie' || c.type === 'doughnut';
        slide.addChart(type, c.series.map((se) => ({ name: se.name || 'Values', labels: c.labels, values: se.values })), {
          x: X, y: IN(bodyY), w: W, h: IN(bodyH),
          barDir: c.type === 'hbar' ? 'bar' : 'col', barGrouping: 'clustered',
          chartColors: PALETTE(t), showLegend: round || c.series.length > 1, legendPos: round ? 'r' : 't', legendColor: C(t.colors.text), legendFontSize: 12,
          showValue: !round && c.series.length === 1 && c.labels.length <= 12, dataLabelColor: C(t.colors.text), dataLabelFontSize: 11,
          showPercent: round, catAxisLabelColor: C(t.colors.text), valAxisLabelColor: C(t.colors.muted), catAxisLabelFontSize: 12, valAxisLabelFontSize: 11,
          valGridLine: { color: C(t.colors.muted), style: 'solid', size: 0.5 }, catGridLine: { style: 'none' }, lineSize: 3, lineDataSymbolSize: 7,
          ...(c.unit === '%' ? { valAxisLabelFormatCode: '0"%"' } : {}),
          holeSize: 58, altText: `${c.type} chart: ${c.labels.map((l, i) => `${l} ${shortNum(c.series[0].values[i], c.unit)}`).join(', ')}`,
        });
        if (s.caption || c.source) slide.addText(s.caption || `Source: ${c.source}`, { x: X, y: IN(SLIDE_H - M.bottom - 34), w: W, h: IN(30), fontSize: PT(18), color: C(t.colors.muted), margin: 0 });
        break;
      }
      case 'table': {
        head();
        const tb = s.table;
        const fs = PT(r.fit.body);
        const rows = [];
        if (tb.header.length) rows.push(tb.header.map((h) => ({ text: h, options: { bold: true, color: 'FFFFFF', fill: { color: C(t.colors.accent) } } })));
        tb.rows.forEach((row, i) => rows.push(row.map((cell) => ({ text: cell, options: { color: C(t.colors.text), fill: { color: C(i % 2 ? t.colors.surface : t.colors.bg) } } }))));
        slide.addTable(rows, { x: X, y: IN(bodyY), w: W, fontSize: fs, fontFace: t.body.pptx, border: { type: 'solid', pt: 0.5, color: C(t.colors.muted) }, autoPage: false, margin: 0.06, valign: 'middle' });
        caption();
        break;
      }
      case 'diagram': {
        head();
        const g = diagramLayout(s.diagram, M.x, bodyY, SLIDE_W - 2 * M.x, bodyH);
        const col = PALETTE(t);
        if (g.line) slide.addShape(pres.ShapeType.line, { x: IN(g.line.x1), y: IN(g.line.y), w: IN(g.line.x2 - g.line.x1), h: 0, line: { color: C(t.colors.accent), width: 3 } });
        for (const [a, b] of g.links) {
          const [x1, y1, x2, y2] = linkEnds(g, a, b);
          // PowerPoint lines run from the top-left corner: flip for the other directions
          slide.addShape(pres.ShapeType.line, { x: IN(Math.min(x1, x2)), y: IN(Math.min(y1, y2)), w: IN(Math.abs(x2 - x1)), h: IN(Math.abs(y2 - y1)), flipH: x2 < x1, flipV: y2 < y1, line: { color: C(t.colors.accent), width: 2, endArrowType: 'triangle' } });
        }
        g.boxes.forEach((b, i) => {
          if (b.dot) slide.addShape(pres.ShapeType.ellipse, { x: IN(b.dot.x - 10), y: IN(b.dot.y - 10), w: IN(20), h: IN(20), fill: { color: col[i % col.length] }, line: { color: col[i % col.length] } });
          const label = [{ text: b.label, options: { bold: true, fontSize: b.w < 170 ? 13 : 15, color: b.taper ? 'FFFFFF' : C(t.colors.text), breakLine: !!b.detail } }];
          if (b.detail) label.push({ text: b.detail, options: { fontSize: 11, color: b.taper ? 'FFFFFF' : C(t.colors.muted) } });
          slide.addText(label, {
            shape: b.taper ? pres.ShapeType.trapezoid : pres.ShapeType.roundRect, x: IN(b.x), y: IN(b.y), w: IN(b.w), h: IN(b.h), align: 'center', valign: 'middle',
            fill: { color: b.taper ? col[i % col.length] : C(t.colors.surface) }, line: { color: col[i % col.length], width: 2 }, rectRadius: 0.15, fontFace: t.body.pptx, margin: 4, fit: 'shrink',
          });
          if (b.children && b.children.length) slide.addText(b.children.join(' · '), { x: IN(b.x), y: IN(b.y + b.h + 6), w: IN(b.w), h: IN(30), fontSize: 11, align: 'center', color: C(t.colors.muted), margin: 0 });
        });
        caption();
        break;
      }
      case 'stats': {
        head();
        const n = s.stats.length, gap = 28, cw = (SLIDE_W - 2 * M.x - gap * (n - 1)) / n, ch = 220;
        const y = bodyY + Math.max(0, (bodyH - ch) / 2 - (s.bullets ? 60 : 0));
        s.stats.forEach((st, i) => {
          card(M.x + i * (cw + gap), y, cw, ch);
          slide.addText([{ text: st.value, options: { fontSize: PT(n > 3 ? 56 : 68), bold: true, color: C(t.colors.accent), fontFace: t.heading.pptx, breakLine: true } }, ...runs(st.label, known, { fontSize: PT(22), color: C(t.colors.muted) })], { x: IN(M.x + i * (cw + gap) + 28), y: IN(y + 20), w: IN(cw - 56), h: IN(ch - 40), valign: 'middle', margin: 0, fit: 'shrink' });
        });
        if (s.bullets) slide.addText(bulletRuns(s.bullets, known, t, 22), { x: X, y: IN(y + ch + 24), w: W, h: IN(SLIDE_H - M.bottom - y - ch - 24), valign: 'top', margin: 0 });
        caption();
        break;
      }
      case 'quote':
        slide.addText([{ text: `“${s.quote}”`, options: { fontSize: PT(r.fit.body), bold: true, color: C(t.colors.text), fontFace: t.heading.pptx, breakLine: !!s.by } }, ...(s.by ? [{ text: `— ${s.by}`, options: { fontSize: PT(24), color: C(t.colors.muted) } }] : [])], { x: IN(M.x + 40), y: IN(M.top), w: IN(SLIDE_W - 2 * M.x - 80), h: IN(SLIDE_H - M.top - M.bottom), valign: 'middle', margin: 0, fit: 'shrink', paraSpaceAfter: 18 });
        break;
      case 'sources': {
        head({ fontSize: PT(r.fit.title) });
        const list = (deck.sources || []).map((x) => ({ text: `${x.n}. ${x.title || x.url}${x.url && x.title ? ` — ${x.url}` : ''}`, options: { breakLine: true, fontSize: 13, color: C(t.colors.text), paraSpaceAfter: 6, ...(x.url ? { hyperlink: { url: x.url } } : {}) } }));
        if (list.length) list[list.length - 1].options.breakLine = false;
        slide.addText(list, { x: X, y: IN(bodyY), w: W, h: IN(bodyH - (r.label ? 40 : 0)), valign: 'top', margin: 0, fit: 'shrink' });
        if (r.label) slide.addText(`Eden’s check: ${r.label}`, { x: X, y: IN(SLIDE_H - M.bottom - 34), w: W, h: IN(30), fontSize: 12, color: C(t.colors.muted), margin: 0 });
        break;
      }
      default:
        head();
        if (s.bullets) slide.addText(bulletRuns(s.bullets, known, t, r.fit.body), { x: X, y: IN(bodyY), w: W, h: IN(bodyH), valign: 'top', fontFace: t.body.pptx, margin: 0, fit: 'shrink' });
        caption();
    }
    if (r.part === 1 && s.notes) slide.addNotes(s.notes);
  });
  return pres;
}

let loading = null;
/** PptxGenJS, loaded once from Eden's own copy (the page's CSP allows only its own scripts). */
export function loadPptx() {
  if (globalThis.PptxGenJS) return Promise.resolve(globalThis.PptxGenJS);
  loading ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('./pptxgen.bundle.js', import.meta.url).href;
    s.onload = () => (globalThis.PptxGenJS ? resolve(globalThis.PptxGenJS) : reject(new Error('PowerPoint export didn’t load.')));
    s.onerror = () => { loading = null; reject(new Error('PowerPoint export didn’t load.')); };
    document.head.append(s);
  });
  return loading;
}

/** The deck as a .pptx Blob and its file name. */
export async function pptxBlob(deck, opts) {
  const Pptx = await loadPptx();
  const pres = buildPptx(Pptx, deck, opts);
  const blob = await pres.write({ outputType: 'blob' });
  return { blob, name: deckFileName(deck.title, 'pptx') };
}
