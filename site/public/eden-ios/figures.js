// Figures in course materials (askeden ROADMAP Q6): which pages and slides have pictures, charts,
// diagrams or equations worth describing, and how a description is kept with its page's text.
// Pure (no DOM): course-extract.js finds the candidates, courses.js has the included AI describe
// them (POST …/ocr with describe: true, after the professor confirms the cost), and study.js shows
// them under the page as "Figure description" and reads them aloud. The tests load this file as served.
//
// A description is stored in the page's own text, after a marker line, so search (words and
// meaning), citations ("file · page") and the quote check all work on it with no change:
//
//   The page's text…
//
//   [Figure description]
//   A bar chart of enzyme activity against temperature: it rises to a peak at 37 °C, then falls.

export const FIGURE_MARK = '[Figure description]';
const MARK_LINE = /(^|\n)\[Figure description\]\n/;

/** A page's text with one more figure description under the marker (one marker a page). */
export function addFigure(text, desc) {
  text = String(text || '').trimEnd();
  desc = String(desc || '').split(FIGURE_MARK).join('').trim();
  if (!desc) return text;
  if (MARK_LINE.test(text)) return `${text}\n${desc}`;
  return `${text ? `${text}\n\n` : ''}${FIGURE_MARK}\n${desc}`;
}

/** { text, figure }: a page's own text and its figure description ('' without one). */
export function splitFigure(text) {
  text = String(text || '');
  const m = MARK_LINE.exec(text);
  if (!m) return { text, figure: '' };
  return { text: text.slice(0, m.index).trimEnd(), figure: text.slice(m.index + m[0].length).trim() };
}

/** Parts plus descriptions ([{ loc, text }]): each added to its page or slide, a picture-only one becoming a part, in order. */
export function mergeFigures(parts, descs) {
  const byLoc = new Map(parts.map((p) => [p.loc, { ...p }]));
  for (const d of descs || []) {
    if (!d || !String(d.text || '').trim()) continue;
    const p = byLoc.get(d.loc) || { loc: d.loc, text: '' };
    p.text = addFigure(p.text, d.text);
    byLoc.set(d.loc, p);
  }
  const num = (p) => Number(String(p.loc).replace(/\D+/g, '')) || 0;
  return [...byLoc.values()].filter((p) => p.text.trim()).sort((a, b) => num(a) - num(b));
}

/* ---------- PDF pages: what pdf.js draws on them ---------- */

// symbols that mean an equation (extracted text keeps them even when the layout is lost)
const MATH = /[∑∫∬∮∏√∂∇∞≈≠≡≤≥±∓×÷∈∉⊂⊆⊃∪∩∧∨¬→←↔⇒⇔∀∃∝∠⊥ℝℕℤℚαβγδεζηθλμνξπρστφχψωΓΔΘΛΞΠΣΦΨΩ]/g;
export const mathCount = (text) => (String(text || '').match(MATH) || []).length;

/** What a page draws, from pdf.js's operator list: each picture's share of the page (by the transform
 * it's painted with) and how many lines and curves its drawings have. `OPS` is pdfjs.OPS. */
export function opStats(fnArray, argsArray, OPS, pageArea) {
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const images = [];
  let segments = 0;
  const paints = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintJpegXObject, OPS.paintImageMaskXObject, OPS.paintImageXObjectRepeat].filter((x) => x !== undefined));
  const lines = new Set([OPS.lineTo, OPS.curveTo, OPS.curveTo2, OPS.curveTo3].filter((x) => x !== undefined));
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], args = argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform && args && args.length === 6) ctm = mul(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) { stack.push(ctm); if (args && args[0] && args[0].length === 6) ctm = mul(ctm, Array.from(args[0])); }
    else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
    else if (paints.has(fn)) images.push({ id: args && typeof args[0] === 'string' ? args[0] : null, share: Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]) / (pageArea || 1) });
    else if (fn === OPS.constructPath && args && args[0]) for (const op of args[0]) if (lines.has(op)) segments++;
  }
  return { images, segments };
}

/** Why a PDF page is worth describing ('pictures', 'a chart or diagram', 'equations'), or null.
 * `common`: picture ids drawn on most pages (a logo, a letterhead), which don't count. */
export function pageReason({ text = '', images = [], segments = 0 }, common = new Set()) {
  const share = images.filter((im) => !(im.id && common.has(im.id)) && im.share >= 0.04).reduce((a, im) => a + im.share, 0);
  if (share >= 0.08) return 'pictures';
  if (segments >= 50) return 'a chart or diagram';
  if (mathCount(text) >= 3) return 'equations';
  return null;
}

/** Picture ids drawn on at least half of a document's pages (4 pages or more): logos and backgrounds. */
export function commonImages(pages) {
  const seen = new Map();
  for (const p of pages) for (const id of new Set((p.images || []).map((im) => im.id).filter(Boolean))) seen.set(id, (seen.get(id) || 0) + 1);
  return new Set(pages.length >= 4 ? [...seen].filter(([, n]) => n >= pages.length / 2).map(([id]) => id) : []);
}

/* ---------- PowerPoint slides: the media, charts, diagrams and equations on them ---------- */

const RASTER = /\.(png|jpe?g|gif|bmp|webp|svg)$/i;
const unxml = (t) => String(t).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const runs = (xml, tag) => [...String(xml || '').matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g'))].map((m) => unxml(m[1]));

/** A slide's relationships (ppt/slides/_rels/slideN.xml.rels): id → the part's path in the zip. */
export function slideRels(relsXml, base = 'ppt/slides/') {
  const out = new Map();
  for (const m of String(relsXml || '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[0]), target = /\bTarget="([^"]+)"/.exec(m[0]);
    if (!id || !target || /TargetMode="External"/.test(m[0])) continue;
    const parts = (target[1].startsWith('/') ? target[1].slice(1) : base + target[1]).split('/');
    const path = [];
    for (const p of parts) { if (p === '..') path.pop(); else if (p && p !== '.') path.push(p); }
    out.set(id[1], path.join('/'));
  }
  return out;
}

/** What's on a slide besides its text: { media: [picture paths], charts: [paths], diagrams: [paths], equations: ['x = …'] }. */
export function slideFigures(slideXml, rels) {
  const xml = String(slideXml || '');
  const ids = (re) => [...new Set([...xml.matchAll(re)].map((m) => m[1]))].map((id) => rels.get(id)).filter(Boolean);
  const media = ids(/<a:blip\b[^>]*\br:embed="([^"]+)"/g).filter((p) => RASTER.test(p));
  const charts = ids(/<c:chart\b[^>]*\br:id="([^"]+)"/g);
  const diagrams = ids(/<dgm:relIds\b[^>]*\br:dm="([^"]+)"/g);
  const equations = [...xml.matchAll(/<m:oMath\b[^>]*>([\s\S]*?)<\/m:oMath>/g)].map((m) => runs(m[1], 'm:t').join('').trim()).filter(Boolean);
  return { media: [...new Set(media)], charts, diagrams, equations: [...new Set(equations)] };
}

/** A chart part's words and numbers (ppt/charts/chartN.xml), as a sentence a student can search and hear. */
export function chartText(xml) {
  xml = String(xml || '');
  const kind = (/<c:(bar|line|pie|area|scatter|doughnut|radar|bubble|bar3D|line3D|pie3D|area3D)Chart\b/.exec(xml) || [])[1];
  const titleXml = (/<c:title>([\s\S]*?)<\/c:title>/.exec(xml) || [])[1] || '';
  const title = runs(titleXml, 'a:t').join('').trim();
  const series = [...xml.matchAll(/<c:ser>([\s\S]*?)<\/c:ser>/g)].map((m) => {
    const s = m[1];
    const name = runs((/<c:tx>([\s\S]*?)<\/c:tx>/.exec(s) || [])[1] || '', 'c:v').join('').trim();
    const cats = runs((/<c:(?:cat|xVal)>([\s\S]*?)<\/c:(?:cat|xVal)>/.exec(s) || [])[1] || '', 'c:v');
    const vals = runs((/<c:(?:val|yVal)>([\s\S]*?)<\/c:(?:val|yVal)>/.exec(s) || [])[1] || '', 'c:v').map((v) => (Number.isFinite(Number(v)) ? String(Math.round(Number(v) * 1000) / 1000) : v));
    const pairs = vals.slice(0, 24).map((v, i) => (cats[i] ? `${cats[i]}: ${v}` : v)).join(', ');
    return `${name ? `${name}: ` : ''}${pairs}${vals.length > 24 ? ', …' : ''}`;
  }).filter((s) => s.replace(/[:\s,]/g, ''));
  if (!series.length && !title) return '';
  const what = kind ? `A ${kind.replace(/3D$/, ' (3D)').toLowerCase()} chart` : 'A chart';
  return `${what}${title ? ` titled “${title}”` : ''}${series.length ? `. ${series.join('. ')}.` : '.'}`.replace(/\.\./g, '.');
}

/** A SmartArt diagram's words (ppt/diagrams/dataN.xml), in order. */
export function diagramText(xml) {
  const items = runs(xml, 'a:t').map((t) => t.trim()).filter(Boolean);
  return items.length ? `A diagram: ${items.join(' → ')}.` : '';
}

/** Pictures used on at least half of a deck's slides (4 slides or more): a logo or background, not worth describing. */
export function commonMedia(slides) {
  const seen = new Map();
  for (const s of slides) for (const m of new Set(s.media || [])) seen.set(m, (seen.get(m) || 0) + 1);
  return new Set(slides.length >= 4 ? [...seen].filter(([, n]) => n >= slides.length / 2).map(([m]) => m) : []);
}

/** About what describing `n` pictures costs on the included AI (Claude Haiku: a picture in, a paragraph out). */
export const figureCost = (n) => Math.max(0.01, n * 0.004);
