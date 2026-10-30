// A PowerPoint file as an Eden deck (ROADMAP Q14: "import a PPTX to restyle or continue"): each slide's
// title, bullets (with levels), tables, charts (their data), pictures (with their alt text) and speaker
// notes, in the deck's order, plus the file's look (theme colors and fonts) so "use this brand" works.
// Read in this browser; nothing is uploaded. parsePptx() is pure over the zip's entries (tested in Node
// with a deck Eden exported: src/__tests__/deck.test.ts); importPptx() unzips a File first.
// The XML is read with patterns, not a DOM, which is enough for OOXML's regular shape and keeps
// this testable; whatever it can't place is left out, never guessed.

import { normalizeDeck, normalizeTheme, fontName } from './deck-model.js';

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export const unxml = (s) => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()]));
const all = (re, s) => [...String(s || '').matchAll(re)];
const attr = (tag, name) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? unxml(m[1]) : ''; };
const EMU_PX = 9525;

/** Relationships file → Map id → target path (resolved against `base`, e.g. 'ppt/slides/'). */
export function rels(xml, base) {
  const out = new Map();
  for (const m of all(/<Relationship\b[^>]*>/g, xml)) {
    const id = attr(m[0], 'Id'), target = attr(m[0], 'Target');
    if (!id || !target || attr(m[0], 'TargetMode') === 'External') continue;
    const parts = (target.startsWith('/') ? target.slice(1) : base + target).split('/');
    const path = [];
    for (const p of parts) { if (p === '..') path.pop(); else if (p !== '.') path.push(p); }
    out.set(id, path.join('/'));
  }
  return out;
}

/** The paragraphs of a text body: [{ text, lvl, size, bold, color }]. */
export function paragraphs(xml) {
  return all(/<a:p>([\s\S]*?)<\/a:p>|<a:p\s[^>]*>([\s\S]*?)<\/a:p>/g, xml).map((m) => {
    const p = m[1] ?? m[2] ?? '';
    const ppr = /<a:pPr\b[^>]*>/.exec(p);
    const rpr = /<a:rPr\b[^>]*>/.exec(p);
    const color = /<a:rPr\b[^>]*>[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(p);
    const text = all(/<a:t>([\s\S]*?)<\/a:t>|<a:t\s[^>]*>([\s\S]*?)<\/a:t>/g, p).map((t) => unxml(t[1] ?? t[2] ?? '')).join('');
    return { text: text.replace(/\s+/g, ' ').trim(), lvl: ppr ? Number(attr(ppr[0], 'lvl')) || 0 : 0, size: rpr ? Number(attr(rpr[0], 'sz')) || 0 : 0, bold: rpr ? attr(rpr[0], 'b') === '1' : false, color: color ? `#${color[1]}` : '' };
  }).filter((p) => p.text);
}

function chartData(xml) {
  if (!xml) return null;
  const type = /<c:pieChart>/.test(xml) ? 'pie' : /<c:doughnutChart>/.test(xml) ? 'doughnut' : /<c:lineChart>/.test(xml) ? 'line' : /<c:areaChart>/.test(xml) ? 'area' : /<c:barDir val="bar"/.test(xml) ? 'hbar' : 'bar';
  const pts = (s) => all(/<c:pt idx="(\d+)">\s*<c:v>([\s\S]*?)<\/c:v>/g, s).sort((a, b) => a[1] - b[1]).map((m) => unxml(m[2]));
  const series = all(/<c:ser>([\s\S]*?)<\/c:ser>/g, xml).map((m) => {
    const s = m[1];
    const name = /<c:tx>[\s\S]*?<c:v>([\s\S]*?)<\/c:v>/.exec(s);
    const cat = /<c:cat>([\s\S]*?)<\/c:cat>/.exec(s);
    const val = /<c:val>([\s\S]*?)<\/c:val>/.exec(s);
    return { name: name ? unxml(name[1]) : '', labels: cat ? pts(cat[1]) : [], values: val ? pts(val[1]).map(Number) : [] };
  }).filter((s) => s.values.length);
  if (!series.length) return null;
  const labels = series[0].labels.length ? series[0].labels : series[0].values.map((_, i) => String(i + 1));
  return { type, labels, series: series.map((s) => ({ name: s.name, values: s.values })) };
}

function tableData(xml) {
  const rows = all(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g, xml).map((r) => all(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g, r[1]).map((c) => paragraphs(c[1]).map((p) => p.text).join(' ')));
  if (!rows.length) return null;
  return { header: rows[0], rows: rows.slice(1) };
}

const b64 = (bytes) => {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' };
const MAX_IMAGE = 1_500_000;

/** One slide's content from its XML (and what it points at). */
function readSlide(xml, rel, get, images, n) {
  const shapes = all(/<p:sp>([\s\S]*?)<\/p:sp>|<p:sp\s[^>]*>([\s\S]*?)<\/p:sp>/g, xml).map((m) => {
    const s = m[1] ?? m[2] ?? '';
    const ph = /<p:ph\b[^>]*>/.exec(s);
    return { type: ph ? attr(ph[0], 'type') || 'body' : '', paras: paragraphs((/<p:txBody>([\s\S]*?)<\/p:txBody>/.exec(s) || [])[1] || '') };
  }).filter((s) => s.paras.length);
  const slide = {};
  let titleShape = shapes.find((s) => s.type === 'title' || s.type === 'ctrTitle');
  if (!titleShape && shapes.length) { // no placeholders (files made by code, Eden's own): the biggest text near the top
    const big = Math.max(...shapes.map((s) => Math.max(...s.paras.map((p) => p.size))));
    titleShape = shapes.find((s) => s.paras.some((p) => p.size === big && big >= 2600)) || null;
  }
  if (titleShape) slide.title = titleShape.paras.map((p) => p.text).join(' ');
  const sub = shapes.find((s) => s.type === 'subTitle');
  if (sub) slide.subtitle = sub.paras.map((p) => p.text).join(' ');
  const bullets = [];
  for (const s of shapes) {
    if (s === titleShape || s === sub || ['dt', 'ftr', 'sldNum'].includes(s.type)) continue;
    if (s.paras.length === 1 && /^\d{1,3}$/.test(s.paras[0].text)) continue; // a slide number
    for (const p of s.paras) {
      if (p.lvl > 0 && bullets.length) { const last = bullets.at(-1); bullets[bullets.length - 1] = typeof last === 'string' ? { text: last, sub: [p.text] } : { ...last, sub: [...last.sub, p.text] }; }
      else bullets.push(p.text);
    }
  }
  // tables, charts
  const tbl = /<a:tbl>([\s\S]*?)<\/a:tbl>/.exec(xml);
  if (tbl) slide.table = tableData(tbl[1]);
  const ch = /<c:chart\b[^>]*r:id="([^"]+)"/.exec(xml);
  if (ch && rel.get(ch[1])) { const c = chartData(get(rel.get(ch[1]))); if (c) slide.chart = c; }
  // the first picture
  const pic = /<p:pic>([\s\S]*?)<\/p:pic>/.exec(xml);
  if (pic) {
    const embed = /<a:blip\b[^>]*r:embed="([^"]+)"/.exec(pic[1]);
    const target = embed && rel.get(embed[1]);
    const ext = target ? target.split('.').pop().toLowerCase() : '';
    const bytes = target && MIME[ext] ? get(target, true) : null;
    if (bytes && bytes.length <= MAX_IMAGE) {
      const id = `pptx${n}`;
      const size = /<a:ext cx="(\d+)" cy="(\d+)"/.exec(pic[1]);
      images[id] = { data: `data:${MIME[ext]};base64,${b64(bytes)}`, w: size ? Math.round(Number(size[1]) / EMU_PX) : 0, h: size ? Math.round(Number(size[2]) / EMU_PX) : 0 };
      slide.image = id;
      const nv = /<p:cNvPr\b[^>]*>/.exec(pic[1]);
      slide.alt = nv ? attr(nv[0], 'descr') : '';
    }
  }
  if (bullets.length && !(slide.table && bullets.length === 0)) slide.bullets = bullets.slice(0, 14);
  // the layout
  if (slide.chart) slide.layout = 'chart';
  else if (slide.table) slide.layout = 'table';
  else if (slide.image) slide.layout = 'image';
  else if (n === 1 && (!slide.bullets || slide.bullets.length <= 1)) { slide.layout = 'title'; if (!slide.subtitle && slide.bullets) { slide.subtitle = typeof slide.bullets[0] === 'string' ? slide.bullets[0] : slide.bullets[0].text; delete slide.bullets; } }
  else if (!slide.bullets) slide.layout = 'section';
  else slide.layout = 'bullets';
  if (slide.layout === 'chart' || slide.layout === 'table') delete slide.bullets;
  // speaker notes
  const notesPath = [...rel.values()].find((p) => /notesSlides\/notesSlide\d+\.xml$/.test(p));
  if (notesPath) {
    const nx = get(notesPath);
    const body = all(/<p:sp>([\s\S]*?)<\/p:sp>/g, nx || '').filter((m) => /<p:ph\b[^>]*type="body"/.test(m[1]));
    const notes = body.map((m) => paragraphs(m[1]).map((p) => p.text).join('\n')).join('\n').trim();
    if (notes) slide.notes = notes;
  }
  return slide;
}

/** The theme's colors and fonts (a brand to reuse). */
export function pptxTheme(themeXml, firstSlideXml = '') {
  const color = (name) => {
    const m = new RegExp(`<a:${name}>([\\s\\S]*?)</a:${name}>`).exec(themeXml || '');
    if (!m) return '';
    const c = /srgbClr val="([0-9A-Fa-f]{6})"/.exec(m[1]) || /lastClr="([0-9A-Fa-f]{6})"/.exec(m[1]);
    return c ? `#${c[1].toLowerCase()}` : '';
  };
  const bgm = /<p:bg>[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(firstSlideXml);
  const major = /<a:majorFont>\s*<a:latin typeface="([^"]*)"/.exec(themeXml || '');
  const minor = /<a:minorFont>\s*<a:latin typeface="([^"]*)"/.exec(themeXml || '');
  const bg = bgm ? `#${bgm[1].toLowerCase()}` : color('lt1');
  const dark = bg && luminance(bg) < 0.35;
  const colors = { bg, text: dark ? color('lt1') || '#ffffff' : color('dk1'), muted: dark ? color('lt2') : color('dk2'), surface: dark ? color('dk2') : color('lt2'), accent: color('accent1'), accent2: color('accent2') };
  if (bgm && dark && colors.text === bg) colors.text = '#ffffff';
  for (const k of Object.keys(colors)) if (!colors[k]) delete colors[k];
  const fonts = { heading: fontName(major ? unxml(major[1]) : ''), body: fontName(minor ? unxml(minor[1]) : '') };
  for (const k of Object.keys(fonts)) if (!fonts[k]) delete fonts[k];
  return normalizeTheme({ base: dark ? 'glass-dark' : 'glass', colors, fonts });
}
function luminance(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
}

/**
 * A deck from a .pptx's entries: `get(name, raw)` gives an entry's text (or bytes with `raw`), or undefined.
 * → { deck, images, theme } or { error }.
 */
export function parsePptx(get, { title = '' } = {}) {
  const pres = get('ppt/presentation.xml');
  if (!pres) return { error: 'That isn’t a PowerPoint (.pptx) file.' };
  const prel = rels(get('ppt/_rels/presentation.xml.rels') || '', 'ppt/');
  let order = all(/<p:sldId\b[^>]*r:id="([^"]+)"/g, pres).map((m) => prel.get(m[1])).filter(Boolean);
  if (!order.length) order = [...prel.values()].filter((p) => /slides\/slide\d+\.xml$/.test(p)).sort((a, b) => Number(/(\d+)\.xml$/.exec(a)[1]) - Number(/(\d+)\.xml$/.exec(b)[1]));
  const images = {};
  const slides = order.slice(0, 60).map((p, i) => {
    const xml = get(p) || '';
    const name = p.split('/').pop();
    const rel = rels(get(p.replace(name, `_rels/${name}.rels`)) || '', p.slice(0, p.length - name.length));
    return readSlide(xml, rel, get, images, i + 1);
  });
  const themePath = [...prel.values()].find((p) => /theme\/theme\d+\.xml$/.test(p)) || 'ppt/theme/theme1.xml';
  const theme = pptxTheme(get(themePath) || '', order[0] ? get(order[0]) || '' : '');
  const coreTitle = /<dc:title>([\s\S]*?)<\/dc:title>/.exec(get('docProps/core.xml') || '');
  const r = normalizeDeck({ title: (coreTitle && unxml(coreTitle[1])) || title || (slides[0] && slides[0].title) || 'Imported deck', theme, slides });
  if (r.error) return { error: 'Eden found no slides with text in that file.' };
  for (const id of Object.keys(images)) if (!r.deck.slides.some((s) => s.image === id)) delete images[id];
  return { deck: r.deck, images, theme };
}

/** A .pptx File → parsePptx's result (unzipped here with course-extract.js's reader). */
export async function importPptx(file) {
  if (!/\.pptx$/i.test(file.name)) return { error: 'Choose a PowerPoint (.pptx) file.' };
  if (file.size > 80 * 1024 * 1024) return { error: 'That file is over 80 MB.' };
  const { unzip } = await import('./course-extract.js');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const want = (n) => /^(ppt\/(presentation\.xml|_rels\/presentation\.xml\.rels|slides\/(_rels\/)?slide\d+\.xml(\.rels)?|notesSlides\/notesSlide\d+\.xml|charts\/chart\d+\.xml|theme\/theme\d+\.xml|media\/[^/]+\.(png|jpe?g|gif))|docProps\/core\.xml)$/i.test(n);
  const zip = await unzip(bytes, want, (n) => /^ppt\/media\//.test(n));
  return parsePptx((name) => zip.get(name), { title: file.name.replace(/\.pptx$/i, '') });
}
