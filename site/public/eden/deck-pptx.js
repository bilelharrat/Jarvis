// A deck as a PowerPoint file (ROADMAP Q14): real, editable text boxes, the speaker notes, the theme's
// colors and fonts, native PowerPoint charts and tables, diagrams as shapes, the person's pictures with
// their alt text. Built with PptxGenJS 3.12.0 (MIT; pptxgen.bundle.js vendored from npm as published,
// sha512 ZozkYKWb…RUA==, which bundles JSZip, MIT), loaded the first time someone exports.
// buildPptx() is pure given the PptxGenJS constructor (src/__tests__/deck.test.ts runs it in Node);
// the sizes are the same ones the canvas uses (deck-model.js layoutDeck), at 96 px to the inch.

import { SLIDE_W, SLIDE_H, PX_PER_IN, M, themeOf, titleFit, layoutDeck, partTitle, citeRuns, diagramLayout, linkEnds, deckFileName, shortNum, motionOf } from './deck-model.js';
import { imageData } from './deck-render.js';
import { logoBox, brandPitchNames, withFontClass } from './deck-brand-model.js';
import { addPptxMedia } from './deck-video.js';
import { stylePptx } from './deck-styles.js'; // styled themes' backgrounds and cards
import { freePptx } from './deck-freeform-draw.js';
import { runsFor, pptxRuns, alignFor, numbered } from './deck-rich.js'; // rich text as real PowerPoint runs
import { pptxBackground, pptxFooter, pptxChartLook, pptxTableRows, bakeBackgrounds } from './deck-format-draw.js'; // chart look, table styles, backgrounds, footer

const IN = (px) => Math.round((px / PX_PER_IN) * 1000) / 1000;
const PT = (px) => Math.round(px * 0.75 * 10) / 10; // CSS px → points
const C = (hex) => String(hex || '#000000').replace('#', '').toUpperCase();
const PALETTE = (t) => (t.palette || [t.colors.accent, t.colors.accent2, '#F5A524', '#17A673', '#E5484D', '#8E8E93']).map(C);
const bulletText = (b) => (typeof b === 'string' ? b : b.text);
const PPTX_IMAGE_DATA = /^data:image\/(png|jpe?g|gif);base64,/i;
const safePptxImage = (im) => {
  const data = imageData(im);
  return data && PPTX_IMAGE_DATA.test(data) ? data : '';
};

// the slide being written (buildPptx sets these): its rich-text formatting (deck-rich.js), theme and slide numbers
let FS = null, FT = null, slideOf = () => 0;
/** Text runs with citation markers as superscript; the person's bold, colours, sizes, fonts and links where `path` has them. */
function runs(s, known, opts = {}, path = '', boxPt = 0) {
  const fr = path && FS && FS.fmt ? runsFor(FS, path, String(s ?? '')) : null;
  const out = fr
    ? pptxRuns(fr, { ...(boxPt && !opts.fontSize ? { fontSize: boxPt } : {}), ...opts }, { theme: FT, pieces: (x) => citeRuns(x, known), slideOf })
    : citeRuns(s, known).map((r) => ({ text: r.t, options: { ...opts, ...(r.cite ? { superscript: true } : {}) } }));
  const al = path && FS && FS.fmt ? alignFor(FS, path) : '';
  if (al && out.length) out[0].options = { ...out[0].options, align: al };
  if (opts.breakLine) for (const r of out.slice(0, -1)) delete r.options.breakLine; // one paragraph, however many runs
  return out;
}

function bulletRuns(items, known, t, px, path = '', offset = 0) {
  const out = [];
  const num = path && FS ? numbered(FS, path) : false;
  // one paragraph per bullet: only its first run carries the paragraph's options (a run with `bullet` starts a new one)
  const para = (str, first, rest, p) => {
    const r = runs(str, known, rest, p);
    if (r.length) r[0].options = { ...r[0].options, ...first };
    r[r.length - 1].options.breakLine = true;
    out.push(...r);
  };
  (items || []).forEach((b, k) => {
    const i = k + offset;
    para(bulletText(b), { bullet: num ? { type: 'number', indent: PT(px) * 1.4, ...(offset ? { numberStartAt: offset + 1 } : {}) } : { indent: PT(px) * 1.1 }, paraSpaceAfter: PT(px * 0.45) }, { color: C(t.colors.text), fontSize: PT(px) }, path && `${path}.${i}`);
    if (typeof b === 'object') (b.sub || []).forEach((s, j) => para(s, { bullet: { indent: PT(px) }, indentLevel: 1, paraSpaceAfter: PT(px * 0.3) }, { color: C(t.colors.muted), fontSize: PT(px * 0.85) }, path && `${path}.${i}.sub.${j}`));
  });
  if (out.length) out[out.length - 1].options.breakLine = false;
  return out;
}

// PowerPoint's language tag for a deck's `lang` (spelling, fonts) and right to left for the scripts that read that way
const PPT_LANG = { ar: 'ar-SA', he: 'he-IL', fa: 'fa-IR', ur: 'ur-PK', ja: 'ja-JP', zh: 'zh-CN', ko: 'ko-KR', fr: 'fr-FR', es: 'es-ES', de: 'de-DE', it: 'it-IT', pt: 'pt-BR', nl: 'nl-NL' };
function deckLang(deck) {
  const l = typeof deck.lang === 'string' ? deck.lang : '';
  if (!l) return null;
  const base = l.split('-')[0].toLowerCase();
  return { lang: l.includes('-') ? l : PPT_LANG[base] || l, ...(/^(ar|he|fa|ur|yi|ps|sd|dv|ku)$/.test(base) ? { rtlMode: true, align: 'right' } : {}) }; // right to left reads from the right edge unless a shape says otherwise
}

/**
 * The presentation for a deck. `Pptx` is the PptxGenJS constructor; `images` { id: { data, w, h } }.
 * → the PptxGenJS presentation (call .write()).
 */
export function buildPptx(Pptx, deck, { images = {}, label = '', media = null, bgBaked = null, now = undefined } = {}) {
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
  FT = t; slideOf = (n) => drawn.findIndex((d) => d.index === n - 1 && d.part === 1) + 1; // a "go to slide N" link: its first page in this file (0: not in it)
  drawn.forEach((r, k) => {
    const s = r.slide;
    FS = s;
    const slide = pres.addSlide();
    // Every shape is named for its part (motion below): h heading, c a card's backing (it arrives with what follows),
    // d a diagram's pieces (they arrive as one), b the rest of the body.
    let role = 'b', seq = 0;
    const tongue = deckLang(deck); // a deck in another language (templates, deck-translate.js): its language and, for Arabic or Hebrew, right to left
    for (const m of ['addText', 'addShape', 'addImage', 'addChart', 'addTable']) {
      const add = slide[m].bind(slide);
      slide[m] = (...args) => {
        const i = args.length - 1;
        if (tongue && tongue.rtlMode && m === 'addText' && Array.isArray(args[0])) { const align = (args[i] && args[i].align) || 'right'; args[0] = args[0].map((x) => (x && typeof x === 'object' ? { ...x, options: { rtlMode: true, align, ...(x.options || {}) } } : x)); } // runs don't inherit it
        args[i] = { ...(tongue && (m === 'addText' || m === 'addTable') ? tongue : {}), ...(args[i] || {}), objectName: `eden-${role}-${++seq}` };
        return add(...args);
      };
    }
    const as = (r, f) => { const was = role; role = r; try { return f(); } finally { role = was; } };
    slide.background = { color: C(t.colors.bg) };
    const sty = stylePptx(t); // a styled theme's background shapes and cards (deck-styles.js)
    if (sty && !s.background) { const bg = sty.bg(s); if (bg) slide.background = { color: bg }; as('h', () => sty.decor({ slide, pres, s, IN, C })); }
    if (s.background) pptxBackground(s, { pres, slide, theme: t, images, imageData, baked: bgBaked, k, IN, as }); // its own colour, gradient or picture
    const title = partTitle(r);
    const kickerH = s.kicker && r.part === 1 ? 26 : 0;
    const titleH = title ? Math.ceil((title.length * r.fit.title * 0.52 * 1.06) / (SLIDE_W - 2 * M.x)) * r.fit.title * 1.1 : 0;
    const bodyY = M.top + kickerH + titleH + M.gap;
    const bodyH = SLIDE_H - bodyY - M.bottom - (s.caption ? 40 : 0) - (s.takeaway ? 56 : 0);
    const head = (opts = {}) => as('h', () => {
      if (s.kicker && r.part === 1) slide.addText(s.kicker.toUpperCase(), { x: X, y: IN(M.top), w: W, h: IN(24), fontFace: t.heading.pptx, fontSize: 10.5, bold: true, color: C(t.colors.accent), charSpacing: 2, margin: 0 });
      if (title) slide.addText(runs(title, known, {}, 'title', PT(r.fit.title)), { x: X, y: IN(M.top + kickerH), w: W, h: IN(titleH + 8), fontFace: t.heading.pptx, fontSize: PT(r.fit.title), bold: true, color: C(t.colors.text), valign: 'top', margin: 0, fit: 'shrink', ...opts });
    });
    const caption = () => {
      if (s.takeaway && r.part === r.parts) {
        const ty = SLIDE_H - M.bottom - (s.caption ? 86 : 48);
        as('c', () => slide.addShape(pres.ShapeType.roundRect, { x: X, y: IN(ty), w: W, h: IN(44), fill: { color: C(t.colors.surface) }, line: { color: C(t.colors.accent), width: 1.5 }, rectRadius: 0.1 }));
        slide.addText(runs(s.takeaway, known, {}, 'takeaway', PT(18)), { x: IN(M.x + 18), y: IN(ty + 6), w: IN(SLIDE_W - 2 * M.x - 36), h: IN(32), fontSize: PT(18), bold: true, color: C(t.colors.text), fontFace: t.body.pptx, valign: 'middle', margin: 0, fit: 'shrink' });
      }
      if (s.caption) slide.addText(runs(s.caption, known, {}, 'caption', PT(18)), { x: X, y: IN(SLIDE_H - M.bottom - 34), w: W, h: IN(30), fontSize: PT(18), color: C(t.colors.muted), fontFace: t.body.pptx, margin: 0 });
    };
    const card = (x, y, w, h) => as('c', () => (sty && sty.card({ slide, pres, x, y, w, h, IN, C })) || slide.addShape(pres.ShapeType.roundRect, { x: IN(x), y: IN(y), w: IN(w), h: IN(h), fill: { color: C(t.colors.surface), transparency: t.glass ? 35 : 0 }, line: { color: C(t.colors.surface), transparency: 100 }, rectRadius: 0.2 }));
    if (deck.footer) pptxFooter(deck, s, k + 1, drawn.length, { slide, theme: t, IN, as, now }); // the deck's slide numbers, footer and date
    else if (s.layout !== 'title' && s.layout !== 'section') as('h', () => slide.addText(String(k + 1), { x: IN(SLIDE_W - M.x - 60), y: IN(SLIDE_H - 40), w: IN(60), h: IN(24), fontSize: 10, color: C(t.colors.muted), align: 'right', margin: 0 }));
    switch (s.layout) {
      case 'title': {
        as('h', () => slide.addShape(pres.ShapeType.roundRect, { x: X, y: IN(250), w: IN(96), h: IN(8), fill: { color: C(t.colors.accent) }, line: { color: C(t.colors.accent) }, rectRadius: 0.05 }));
        const im = s.image && images[s.image];
        const data = safePptxImage(im);
        const textW = data && im.w && im.h ? (SLIDE_W - 2 * M.x) * 0.56 : SLIDE_W - 2 * M.x;
        const th = titleFit(s.title || deck.title, textW, [r.fit.title]).lines * r.fit.title * 1.15;
        as('h', () => slide.addText(runs(s.title || deck.title, known, {}, 'title', PT(r.fit.title)), { x: X, y: IN(272), w: IN(textW), h: IN(th + 10), fontFace: t.heading.pptx, fontSize: PT(r.fit.title), bold: true, color: C(t.colors.text), valign: 'top', margin: 0, fit: 'shrink' }));
        if (s.subtitle) slide.addText(runs(s.subtitle, known, {}, 'subtitle', PT(r.fit.body)), { x: X, y: IN(272 + th + 20), w: IN(textW), h: IN(90), fontSize: PT(r.fit.body), color: C(t.colors.muted), fontFace: t.body.pptx, valign: 'top', margin: 0 });
        if (data && im.w && im.h) {
          const heroW = (SLIDE_W - 2 * M.x) * 0.4;
          const heroH = 440;
          const k2 = Math.min(heroW / im.w, heroH / im.h);
          const w = im.w * k2, h = im.h * k2;
          slide.addImage({ data: data.replace(/^data:/, ''), x: IN(M.x + textW + 40 + (heroW - w) / 2), y: IN(140 + (heroH - h) / 2), w: IN(w), h: IN(h), altText: s.alt || s.title || '' });
        }
        break;
      }
      case 'section':
        sectionNo++;
        as('h', () => slide.addText(String(sectionNo).padStart(2, '0'), { x: X, y: IN(250), w: W, h: IN(40), fontSize: PT(28), bold: true, color: C(t.colors.accent), fontFace: t.heading.pptx, margin: 0 }));
        as('h', () => slide.addText(runs(s.title || '', known, {}, 'title', PT(r.fit.title)), { x: X, y: IN(296), w: W, h: IN(r.fit.title * 2.4), fontFace: t.heading.pptx, fontSize: PT(r.fit.title), bold: true, color: C(t.colors.text), valign: 'top', margin: 0, fit: 'shrink' }));
        if (s.subtitle) slide.addText(runs(s.subtitle, known, {}, 'subtitle', PT(r.fit.body)), { x: X, y: IN(296 + r.fit.title * 2.5), w: W, h: IN(80), fontSize: PT(r.fit.body), color: C(t.colors.muted), margin: 0 });
        break;
      case 'two-column': {
        head();
        const cw = (SLIDE_W - 2 * M.x - 48) / 2;
        ['left', 'right'].forEach((side, i) => {
          const x = M.x + i * (cw + 48);
          card(x, bodyY, cw, bodyH);
          const items = [];
          if (s[side].heading) items.push(...runs(s[side].heading, known, { bold: true, color: C(t.colors.accent), fontSize: PT(r.fit.body * 1.1), breakLine: true, paraSpaceAfter: 8 }, `${side}.heading`));
          items.push(...bulletRuns(s[side].bullets, known, t, r.fit.body, `${side}.bullets`));
          slide.addText(items, { x: IN(x + 28), y: IN(bodyY + 24), w: IN(cw - 56), h: IN(bodyH - 48), valign: 'top', fontFace: t.body.pptx, margin: 0, fit: 'shrink' });
        });
        caption();
        break;
      }
      case 'grid': {
        head();
        const cards = s.cards || [];
        const cols = cards.length === 3 ? 3 : 2;
        const rows = Math.ceil(cards.length / cols);
        const gap = 24;
        const cw = (SLIDE_W - 2 * M.x - gap * (cols - 1)) / cols;
        const ch = (bodyH - gap * (rows - 1)) / rows;
        cards.forEach((c, idx) => {
          const colIdx = idx % cols, rowIdx = Math.floor(idx / cols);
          const x = M.x + colIdx * (cw + gap), y = bodyY + rowIdx * (ch + gap);
          card(x, y, cw, ch);
          const items = [];
          if (c.badge) items.push({ text: c.badge.toUpperCase(), options: { bold: true, color: C(t.colors.accent), fontSize: 10, breakLine: true, paraSpaceAfter: 4 } });
          if (c.heading) items.push(...runs(c.heading, known, { bold: true, color: C(t.colors.text), fontSize: PT(r.fit.body * 1.08), breakLine: true, paraSpaceAfter: 8 }, `cards.${idx}.heading`));
          items.push(...bulletRuns(c.bullets, known, t, r.fit.body, `cards.${idx}.bullets`));
          slide.addText(items, { x: IN(x + 24), y: IN(y + 20), w: IN(cw - 48), h: IN(ch - 40), valign: 'top', fontFace: t.body.pptx, margin: 0, fit: 'shrink' });
        });
        caption();
        break;
      }
      case 'image': {
        head();
        const im = images[s.image];
        const data = safePptxImage(im);
        const boxW = s.bullets ? (SLIDE_W - 2 * M.x) * 0.55 : SLIDE_W - 2 * M.x;
        if (data && im.w && im.h) {
          const k2 = Math.min(boxW / im.w, bodyH / im.h);
          const w = im.w * k2, h = im.h * k2;
          slide.addImage({ data: data.replace(/^data:/, ''), x: IN(M.x + (boxW - w) / 2), y: IN(bodyY + (bodyH - h) / 2), w: IN(w), h: IN(h), altText: s.alt || '' });
        } else slide.addText(s.alt || 'Picture', { x: X, y: IN(bodyY), w: IN(boxW), h: IN(bodyH), align: 'center', color: C(t.colors.muted), fontSize: 16, line: { color: C(t.colors.muted), dashType: 'dash' } });
        if (s.bullets) slide.addText(bulletRuns(s.bullets, known, t, r.fit.body, 'bullets', r.offset || 0), { x: IN(M.x + boxW + 40), y: IN(bodyY), w: IN(SLIDE_W - 2 * M.x - boxW - 40), h: IN(bodyH), valign: 'middle', fontFace: t.body.pptx, margin: 0, fit: 'shrink' });
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
          ...pptxChartLook(c, t, PALETTE(t)), // the person's colours, legend, values, axis titles, unit (deck-format-draw.js)
          holeSize: 58, altText: `${c.type} chart: ${c.labels.map((l, i) => `${l} ${shortNum(c.series[0].values[i], c.unit)}`).join(', ')}`,
        });
        if (s.caption || c.source) slide.addText(s.caption || `Source: ${c.source}`, { x: X, y: IN(SLIDE_H - M.bottom - 34), w: W, h: IN(30), fontSize: PT(18), color: C(t.colors.muted), margin: 0 });
        break;
      }
      case 'table': {
        head();
        const tb = s.table;
        const fs = PT(r.fit.body);
        const rows = pptxTableRows(tb, t); // the table's style and column alignment (deck-format-draw.js)
        slide.addTable(rows, { x: X, y: IN(bodyY), w: W, fontSize: fs, fontFace: t.body.pptx, border: { type: 'solid', pt: 0.5, color: C(t.colors.muted) }, autoPage: false, margin: 0.06, valign: 'middle' });
        caption();
        break;
      }
      case 'diagram': {
        head();
        role = 'd';
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
        role = 'b';
        caption();
        break;
      }
      case 'playbook': {
        head();
        role = 'd';
        const pb = s.playbook || {};
        const hasBullets = Boolean(s.bullets && s.bullets.length);
        const pbW = hasBullets ? (SLIDE_W - 2 * M.x - 36) * 0.54 : SLIDE_W - 2 * M.x;
        const pbX = M.x;
        slide.addShape(pres.ShapeType.roundRect, { x: IN(pbX), y: IN(bodyY), w: IN(pbW), h: IN(bodyH), fill: { color: '0D3B26' }, line: { color: '15803D', width: 2 }, rectRadius: 0.12 });
        const losY = bodyY + bodyH * 0.68;
        slide.addShape(pres.ShapeType.line, { x: IN(pbX + 16), y: IN(losY), w: IN(pbW - 32), h: 0, line: { color: 'FACC15', width: 2.5, dashType: 'dash' } });
        if (pb.formation) {
          slide.addText(`${pb.formation}${pb.coverage ? `  ·  ${pb.coverage}` : ''}`, { x: IN(pbX + 16), y: IN(bodyY + 10), w: IN(pbW - 32), h: IN(24), fontSize: 10.5, bold: true, color: '93C5FD', margin: 0 });
        }
        const routes = (pb.routes || []).slice(0, 5);
        routes.forEach((rt, idx) => {
          const rx = pbX + 40 + (idx * (pbW - 80)) / Math.max(1, routes.length - 1);
          const isPrimary = Boolean(rt.primary || rt.read === 1 || idx === 0);
          const col = isPrimary ? 'FACC15' : rt.read === 2 ? '38BDF8' : 'FFFFFF';
          slide.addShape(pres.ShapeType.line, { x: IN(rx), y: IN(bodyY + 64), w: 0, h: IN(losY - (bodyY + 64)), flipV: true, line: { color: col, width: isPrimary ? 3 : 2, endArrowType: 'triangle' } });
          slide.addText(rt.pos || 'WR', { shape: pres.ShapeType.ellipse, x: IN(rx - 14), y: IN(losY - 12), w: IN(28), h: IN(24), align: 'center', valign: 'middle', fontSize: 9, bold: true, color: isPrimary ? '0F172A' : 'FFFFFF', fill: { color: isPrimary ? 'FACC15' : '2563EB' }, line: { color: 'FFFFFF', width: 1.5 }, margin: 0 });
          if (rt.label) {
            slide.addText(`${rt.read ? `[${rt.read}] ` : ''}${rt.label}`, { x: IN(rx - 52), y: IN(bodyY + 38), w: IN(104), h: IN(22), align: 'center', fontSize: 8.5, bold: true, color: col, margin: 0 });
          }
        });
        if (pb.concept) {
          slide.addText(pb.concept, { x: IN(pbX + 16), y: IN(bodyY + bodyH - 28), w: IN(pbW - 32), h: IN(22), align: 'center', fontSize: 10.5, bold: true, color: 'F8FAFC', margin: 0 });
        }
        role = 'b';
        if (hasBullets) {
          slide.addText(bulletRuns(s.bullets, known, t, r.fit.body, 'bullets', r.offset || 0), { x: IN(pbX + pbW + 36), y: IN(bodyY), w: IN(SLIDE_W - 2 * M.x - pbW - 36), h: IN(bodyH), valign: 'middle', fontFace: t.body.pptx, margin: 0, fit: 'shrink' });
        }
        caption();
        break;
      }
      case 'stats': {
        head();
        const n = s.stats.length, gap = 28, cw = (SLIDE_W - 2 * M.x - gap * (n - 1)) / n, ch = 220;
        const y = bodyY + Math.max(0, (bodyH - ch) / 2 - (s.bullets ? 60 : 0));
        s.stats.forEach((st, i) => {
          card(M.x + i * (cw + gap), y, cw, ch);
          const runsList = [];
          if (st.delta) runsList.push({ text: st.delta, options: { fontSize: 11, bold: true, color: C(t.colors.accent), breakLine: true } });
          runsList.push({ text: st.value, options: { fontSize: PT(n > 3 ? 54 : 64), bold: true, color: C(t.colors.accent), fontFace: t.heading.pptx, breakLine: true } });
          runsList.push(...runs(st.label, known, { fontSize: PT(21), color: C(t.colors.muted) }, `stats.${i}.label`));
          slide.addText(runsList, { x: IN(M.x + i * (cw + gap) + 28), y: IN(y + 20), w: IN(cw - 56), h: IN(ch - 40), valign: 'middle', margin: 0, fit: 'shrink' });
        });
        if (s.bullets) slide.addText(bulletRuns(s.bullets, known, t, 22, 'bullets'), { x: X, y: IN(y + ch + 24), w: W, h: IN(SLIDE_H - M.bottom - y - ch - 24), valign: 'top', margin: 0 });
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
      default: {
        head();
        const im = s.image && images[s.image];
        const data = safePptxImage(im);
        const hasPic = Boolean(data && im.w && im.h);
        const textW = hasPic ? (SLIDE_W - 2 * M.x) * 0.56 : SLIDE_W - 2 * M.x;
        if (s.bullets) slide.addText(bulletRuns(s.bullets, known, t, r.fit.body, 'bullets', r.offset || 0), { x: X, y: IN(bodyY), w: IN(textW), h: IN(bodyH), valign: 'top', fontFace: t.body.pptx, margin: 0, fit: 'shrink' });
        if (hasPic) {
          const boxW = (SLIDE_W - 2 * M.x) * 0.4;
          const k2 = Math.min(boxW / im.w, bodyH / im.h);
          const w = im.w * k2, h = im.h * k2;
          slide.addImage({ data: data.replace(/^data:/, ''), x: IN(M.x + textW + 40 + (boxW - w) / 2), y: IN(bodyY + (bodyH - h) / 2), w: IN(w), h: IN(h), altText: s.alt || s.title || '' });
        }
        caption();
      }
    }
    const lgIm = deck.brand && deck.brand.logo ? images[deck.brand.logo] : null, lgData = imageData(lgIm), lg = lgData && logoBox(deck.brand, lgIm);
    if (lg) as('l', () => slide.addImage({ data: lgData.replace(/^data:/, ''), x: IN(lg.x), y: IN(lg.y), w: IN(lg.w), h: IN(lg.h), altText: 'Logo' })); // a brand kit's logo (never animated)
    if (r.part === 1 && s.media) addPptxMedia(slide, s, { files: media, images, imageData, IN }); // video/audio inside the file, or its poster and a note
    if (r.part === 1 && r.index >= 0 && s.free) as('b', () => freePptx(pres, slide, s, { theme: t, image: (id) => safePptxImage(images[id]) })); // free-form elements on top, named eden-b-N
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
  if (deck.slides.some((s) => s.background && s.background.kind === 'image' && (s.background.blur || s.background.dim))) opts = { ...opts, bgBaked: await bakeBackgrounds(layoutDeck(deck, { label: (opts && opts.label) || '' }), (opts && opts.images) || {}, imageData, themeOf(deck)) }; // a picture background's blur and dim, drawn in
  const pres = buildPptx(Pptx, deck, opts);
  let blob = hasMotion(deck) && globalThis.JSZip
    ? await withMotion(globalThis.JSZip, await pres.write({ outputType: 'uint8array' }), deck, opts) // (JSZip comes with PptxGenJS)
    : await pres.write({ outputType: 'blob' });
  if (globalThis.JSZip && brandPitchNames(deck).length) blob = await withFontClass(globalThis.JSZip, blob, deck); // a brand's serif/mono faces: PowerPoint's class hint
  if (Array.isArray(deck.comments) && deck.comments.some((t) => !t.deleted) && globalThis.JSZip) { // comments as PowerPoint comments (deck-comments-model.js)
    const { withComments } = await import('./deck-comments-model.js');
    const drawn = layoutDeck(deck, { label: (opts && opts.label) || '' });
    return { blob: await withComments(globalThis.JSZip, blob, deck, (i) => drawn.findIndex((r) => r.index === i && r.part === 1) + 1), name: deckFileName(deck.title, 'pptx') };
  }
  return { blob, name: deckFileName(deck.title, 'pptx') };
}

// ── motion in the file: <p:transition> and <p:timing> in each slide's XML (PptxGenJS writes neither) ──

export const hasMotion = (deck) => Boolean(deck.motion || deck.slides.some((s) => (s.transition && s.transition !== 'none') || s.build));
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const MS = { fast: 300, medium: 500, slow: 800 };
const SPD = { fast: 'fast', medium: 'med', slow: 'slow' };
const TRANSITION_XML = { fade: '<p:fade/>', push: '<p:push/>', wipe: '<p:wipe/>', zoom: '<p:zoom/>' };

/** The .pptx bytes with each slide's transition and build added; a Blob. */
export async function withMotion(JSZip, bytes, deck, { label = '', type = 'blob' } = {}) {
  const zip = await JSZip.loadAsync(bytes);
  const drawn = layoutDeck(deck, { label });
  for (const [k, r] of drawn.entries()) {
    const f = zip.file(`ppt/slides/slide${k + 1}.xml`);
    if (f) zip.file(`ppt/slides/slide${k + 1}.xml`, slideMotionXml(await f.async('string'), motionOf(deck, r.slide)));
  }
  return zip.generateAsync({ type, mimeType: PPTX_MIME, compression: 'DEFLATE' });
}

/** The shapes Eden named (buildPptx), in drawing order: { id, role, kind: sp|pic|graphicFrame, paras: [lvl…] }. */
export function namedShapes(xml) {
  const out = [];
  for (const m of xml.matchAll(/<p:cNvPr\b[^>]*?\bid="(\d+)"[^>]*?\bname="eden-([hbcd])-\d+"/g)) {
    const at = m.index;
    const starts = [['sp', xml.lastIndexOf('<p:sp>', at)], ['pic', xml.lastIndexOf('<p:pic>', at)], ['graphicFrame', xml.lastIndexOf('<p:graphicFrame>', at)]];
    const [kind, from] = starts.reduce((a, b) => (b[1] > a[1] ? b : a));
    let paras = [];
    if (kind === 'sp') {
      const end = xml.indexOf('</p:sp>', at);
      const tx = /<p:txBody>([\s\S]*)<\/p:txBody>/.exec(xml.slice(from, end));
      if (tx) paras = [...tx[1].matchAll(/<a:p>([\s\S]*?)<\/a:p>|<a:p\/>/g)].map((p) => { const l = /<a:pPr\b[^>]*\blvl="(\d+)"/.exec(p[1] || ''); return l ? Number(l[1]) : 0; });
      if (!tx || !/<a:t>[^<]/.test(tx[1])) paras = [];
    }
    out.push({ id: m[1], role: m[2], kind, paras });
  }
  return out;
}

/** What arrives together, in order: a card's backing with what follows it, a diagram's pieces as one. */
function pieces(shapes) {
  const out = [];
  let open = null;
  for (const s of shapes) {
    if (s.role === 'h') continue;
    if (s.role === 'd') { const last = out.at(-1); if (last && last.diagram && !open) last.shapes.push(s); else out.push({ diagram: true, shapes: [s] }); continue; }
    if (s.role === 'c') { open = { shapes: [s] }; out.push(open); continue; }
    if (open) { open.shapes.push(s); open = null; continue; }
    out.push({ shapes: [s] });
  }
  return out;
}

/** One slide's XML with its motion: { transition, speed, build } (deck-model.js motionOf). */
export function slideMotionXml(xml, { transition = 'none', speed = 'medium', build = 'none' } = {}) {
  const parts = [];
  if (TRANSITION_XML[transition]) parts.push(`<p:transition spd="${SPD[speed] || 'med'}">${TRANSITION_XML[transition]}</p:transition>`);
  if (build !== 'none') { const t = timingXml(pieces(namedShapes(xml)), build, MS[speed] || 500); if (t) parts.push(t); }
  if (!parts.length) return xml;
  const clean = xml.replace(/<p:transition\b[\s\S]*?<\/p:transition>|<p:transition\b[^>]*\/>|<p:timing>[\s\S]*?<\/p:timing>/g, '');
  const at = clean.includes('</p:clrMapOvr>') ? clean.indexOf('</p:clrMapOvr>') + '</p:clrMapOvr>'.length : clean.indexOf('</p:cSld>') + '</p:cSld>'.length; // CT_Slide's order
  return clean.slice(0, at) + parts.join('') + clean.slice(at);
}

function timingXml(groups, build, ms) {
  let id = 2;
  const steps = []; // [[ { spid, range? } … ] per click] or one auto group
  const bld = new Map();
  const target = (s, range) => `<p:tgtEl><p:spTgt spid="${s.id}"${range ? `><p:txEl><p:pRg st="${range[0]}" end="${range[1]}"/></p:txEl></p:spTgt>` : '/>'}</p:tgtEl>`;
  const note = (s, byPara) => {
    if (s.kind === 'graphicFrame') bld.set(s.id, `<p:bldGraphic spid="${s.id}" grpId="0"><p:bldAsOne/></p:bldGraphic>`);
    else if (s.kind === 'sp' && s.paras.length) bld.set(s.id, byPara ? `<p:bldP spid="${s.id}" grpId="0" build="p"/>` : `<p:bldP spid="${s.id}" grpId="0" animBg="1"/>`);
  };
  for (const g of groups) {
    const loose = g.shapes.length === 1 && g.shapes[0].kind === 'sp' && g.shapes[0].paras.filter((l) => l === 0).length > 1;
    if (build === 'steps' && loose) { // a list on its own: one top-level point (with its sub-points) per click
      const s = g.shapes[0], starts = s.paras.map((l, i) => (l === 0 ? i : -1)).filter((i) => i >= 0);
      starts.forEach((st, j) => steps.push([{ s, range: [st, (starts[j + 1] ?? s.paras.length) - 1] }]));
      note(s, true);
    } else { steps.push(g.shapes.map((s) => ({ s }))); g.shapes.forEach((s) => note(s, false)); }
  }
  if (!steps.length) return '';
  const rise = build !== 'fade';
  const effect = (t, nodeType, delay) => {
    const tg = target(t.s, t.range);
    const c = () => ++id;
    return `<p:par><p:cTn id="${c()}" presetID="${rise ? 42 : 10}" presetClass="entr" presetSubtype="0" fill="hold"${t.s.kind === 'pic' ? '' : ' grpId="0"'} nodeType="${nodeType}"><p:stCondLst><p:cond delay="${delay}"/></p:stCondLst><p:childTnLst>`
      + `<p:set><p:cBhvr><p:cTn id="${c()}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>${tg}<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>`
      + `<p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="${c()}" dur="${ms}"/>${tg}</p:cBhvr></p:animEffect>`
      + (rise ? ['ppt_x', 'ppt_y'].map((a) => `<p:anim calcmode="lin" valueType="num"><p:cBhvr><p:cTn id="${c()}" dur="${ms}" decel="100000" fill="hold"/>${tg}<p:attrNameLst><p:attrName>${a}</p:attrName></p:attrNameLst></p:cBhvr><p:tavLst><p:tav tm="0"><p:val><p:strVal val="#${a}${a === 'ppt_y' ? '+.1' : ''}"/></p:val></p:tav><p:tav tm="100000"><p:val><p:strVal val="#${a}"/></p:val></p:tav></p:tavLst></p:anim>`).join('') : '')
      + '</p:childTnLst></p:cTn></p:par>';
  };
  const outer = (inner, auto) => `<p:par><p:cTn id="${++id}" fill="hold"><p:stCondLst><p:cond delay="indefinite"/>${auto ? '<p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond>' : ''}</p:stCondLst><p:childTnLst><p:par><p:cTn id="${++id}" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>${inner()}</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par>`;
  const body = build === 'steps'
    ? steps.map((group) => outer(() => group.map((t, i) => effect(t, i ? 'withEffect' : 'clickEffect', 0)).join(''), false)).join('')
    : outer(() => steps.flat().map((t, i) => effect(t, i ? 'withEffect' : 'afterEffect', i * 90)).join(''), true); // all on their own, a beat apart
  return `<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst>${body}</p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst>${bld.size ? `<p:bldLst>${[...bld.values()].join('')}</p:bldLst>` : ''}</p:timing>`;
}
