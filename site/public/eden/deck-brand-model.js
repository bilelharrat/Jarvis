// Brand kits for Eden Slides (web only): the pure part, shared by the editor (deck-brand.js), the model
// (deck-model.js keeps `deck.brand`), the slide frame (deck-render.js draws the logo and the uploaded fonts) and
// the PowerPoint file (deck-pptx.js). No DOM here, so the tests run it in Node.
//
// A kit: { id, name, palette: [{ name, hex, role }], fonts: { heading, body: { family, fallback } },
//   files: [{ family, data (data: URL), format }], logos: [{ id, name, data, w, h }], logo: { corner, size } }.
// Applying one gives the deck a theme ({ base, colors, fonts, fallback }) and `deck.brand` ({ kit, logo, corner,
// size }); the logo's picture goes in the chat's deckImages like any other picture.

import { isFreeFont, closestFree, freeFaces, fontKind, PITCH } from './deck-fonts.js';
import { richFonts } from './deck-rich.js';

export const ROLES = ['bg', 'bg2', 'surface', 'text', 'muted', 'accent', 'accent2'];
export const ROLE_LABEL = { bg: 'Background', bg2: 'Background 2', surface: 'Cards', text: 'Text', muted: 'Muted text', accent: 'Accent', accent2: 'Accent 2' };
export const CORNERS = ['tl', 'tr', 'bl', 'br'];
export const SIZES = { s: 40, m: 56, l: 80 }; // logo height on the 1280 × 720 slide, px
export const KIT_LIMITS = { kits: 12, name: 60, palette: 12, files: 4, fileBytes: 1.5 * 1024 * 1024, logos: 6, logoBytes: 2 * 1024 * 1024, logoPx: 512 };

// Faces PowerPoint has on Mac and Windows (Office installs Calibri, Cambria, Century Gothic and Gill Sans MT on
// both). `css` is the canvas stack; uploaded fonts fall back to one of these in the .pptx.
const GENERIC = { sans: 'Arial, sans-serif', serif: 'Georgia, serif', mono: 'monospace' };
export const SAFE_FONTS = [
  ['Arial', 'sans'], ['Calibri', 'sans', 'Carlito'], ['Century Gothic', 'sans', 'Futura'], ['Gill Sans MT', 'sans', 'Gill Sans'], ['Tahoma', 'sans'],
  ['Trebuchet MS', 'sans'], ['Verdana', 'sans'], ['Cambria', 'serif', 'Caladea'], ['Georgia', 'serif'], ['Times New Roman', 'serif'], ['Courier New', 'mono'],
].map(([name, kind, alt]) => ({ name, kind, css: `"${name}", ${alt ? `"${alt}", ` : ''}${GENERIC[kind]}` }));
export const isSafeFont = (f) => SAFE_FONTS.some((s) => s.name === f);
/** A face any copy of the deck can show: PowerPoint-safe, or one of the free fonts Eden ships (deck-fonts.js). */
export const isSharedFont = (f) => isSafeFont(f) || isFreeFont(f);

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
export const hex = (v) => (typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v.trim()) ? `#${v.trim().replace('#', '').toLowerCase()}` : '');
const short = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '');
/** Same rule as deck-model's fontName: it ends up quoted inside CSS and in the .pptx XML. */
export const family = (v) => (typeof v === 'string' ? v.replace(/[^A-Za-z0-9 \-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) : '');
export const kitId = (v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : '');

// ── colour ──

const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const toHex = (c) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
export function luminance(h) {
  const [r, g, b] = rgb(h).map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); }
const saturation = (h) => { const c = rgb(h); const mx = Math.max(...c), mn = Math.min(...c); return mx === 0 ? 0 : (mx - mn) / mx; };
const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return toHex(x.map((v, i) => v + (y[i] - v) * t)); };

/**
 * The theme's seven colours from a palette: roles the person set win; the rest are filled in (lightest or darkest
 * as the background, the most contrasting as text, colourful ones, in the palette's order, as accents). Text that fails AA on the
 * background is replaced with near-black or near-white.
 */
export function paletteColors(palette) {
  const p = (Array.isArray(palette) ? palette : []).map((c) => ({ ...c, hex: hex(c && c.hex) })).filter((c) => c.hex);
  const out = {};
  for (const c of p) if (ROLES.includes(c.role) && !out[c.role]) out[c.role] = c.hex;
  const free = p.filter((c) => !Object.values(out).includes(c.hex)).map((c) => c.hex);
  const all = p.map((c) => c.hex);
  if (!out.bg) out.bg = all.length ? [...all].sort((a, b) => luminance(b) - luminance(a))[0] : '#ffffff';
  const dark = luminance(out.bg) < 0.2;
  if (!out.text) {
    const best = [...free, ...all].filter((h) => h !== out.bg).sort((a, b) => contrast(b, out.bg) - contrast(a, out.bg))[0];
    out.text = best && contrast(best, out.bg) >= 4.5 ? best : dark ? '#f8fafc' : '#0f172a';
  }
  const rest = free.filter((h) => h !== out.bg && h !== out.text);
  const vivid = [...rest.filter((h) => saturation(h) > 0.25), ...rest.filter((h) => saturation(h) <= 0.25).sort((a, b) => saturation(b) - saturation(a))]; // the person's order first
  if (!out.accent) out.accent = vivid[0] || (dark ? '#60a5fa' : '#2563eb');
  if (!out.accent2) out.accent2 = vivid.find((h) => h !== out.accent) || mix(out.accent, out.text, 0.35);
  if (!out.bg2) out.bg2 = mix(out.bg, out.accent, 0.06);
  if (!out.surface) out.surface = dark ? mix(out.bg, '#ffffff', 0.07) : '#ffffff';
  if (!out.muted) out.muted = mix(out.text, out.bg, 0.38);
  return out;
}

// ── kits ──

const FONT_SIG = { woff2: 'wOF2', ttf: ['\x00\x01\x00\x00', 'true'], otf: 'OTTO' }; // a font file's first four bytes
/** An uploaded font as a data: URL, checked by its first bytes; its format, or ''. */
export function fontFormat(data) {
  const m = typeof data === 'string' && /^data:[a-z0-9.+\/-]*;base64,([A-Za-z0-9+/]+={0,2})$/i.exec(data);
  if (!m || m[1].length * 0.75 > KIT_LIMITS.fileBytes) return '';
  let b = '';
  try { b = atob(m[1].slice(0, 8)).slice(0, 4); } catch { return ''; }
  if (b === FONT_SIG.woff2) return 'woff2';
  if (FONT_SIG.ttf.includes(b)) return 'truetype';
  if (b === FONT_SIG.otf) return 'opentype';
  return '';
}
/** A logo as a PNG or JPEG data: URL (SVGs are drawn to PNG first, in the page), checked by its first bytes. */
export function logoData(data) {
  const m = typeof data === 'string' && /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
  if (!m || m[2].length * 0.75 > KIT_LIMITS.logoBytes) return '';
  return (m[1] === 'png' ? m[2].startsWith('iVBORw0KGgo') : m[2].startsWith('/9j/')) ? data : '';
}
const fontPick = (f, files) => {
  if (!isObj(f)) return null;
  const fam = family(f.family);
  const file = files.find((x) => x.family === fam);
  if (!fam || (!isSharedFont(fam) && !file && !f.external)) return null; // an uploaded face needs its file
  // shared copies and exports: a shared face is itself; an uploaded one uses the alternative set on its file
  const fallback = isSharedFont(fam) ? fam : file ? file.fallback : isSharedFont(f.fallback) ? f.fallback : closestFree(fam);
  return { family: fam, fallback, ...(f.external && !isSharedFont(fam) && !file ? { external: true } : {}) };
};

/** A kit, cleaned (anything read from storage or another tab goes through here), or null. */
export function normalizeKit(raw) {
  if (!isObj(raw)) return null;
  const id = kitId(raw.id);
  if (!id) return null;
  const palette = (Array.isArray(raw.palette) ? raw.palette : []).slice(0, KIT_LIMITS.palette).filter(isObj)
    .map((c) => ({ name: short(c.name, 30), hex: hex(c.hex), role: ROLES.includes(c.role) ? c.role : '' })).filter((c) => c.hex);
  const seenFam = new Set();
  const files = (Array.isArray(raw.files) ? raw.files : []).slice(0, KIT_LIMITS.files).filter(isObj)
    .map((f) => ({ family: family(f.family), data: f.data, format: fontFormat(f.data), fallback: isSharedFont(f.fallback) ? f.fallback : closestFree(family(f.family)) }))
    .filter((f) => f.family && f.format && !isSharedFont(f.family) && !seenFam.has(f.family) && seenFam.add(f.family));
  const fonts = {};
  for (const k of ['heading', 'body']) { const f = fontPick(raw.fonts && raw.fonts[k], files); if (f) fonts[k] = f; }
  const logos = (Array.isArray(raw.logos) ? raw.logos : []).slice(0, KIT_LIMITS.logos).filter(isObj)
    .map((l) => ({ id: kitId(l.id), name: short(l.name, 60), data: logoData(l.data), w: Math.max(1, Math.min(4096, Math.round(+l.w) || 0)), h: Math.max(1, Math.min(4096, Math.round(+l.h) || 0)) }))
    .filter((l) => l.id && l.data);
  const lg = isObj(raw.logo) ? raw.logo : {};
  const logo = { corner: CORNERS.includes(lg.corner) ? lg.corner : 'tr', size: SIZES[lg.size] ? lg.size : 's', use: logos.some((l) => l.id === lg.use) ? lg.use : logos[0] ? logos[0].id : '' };
  return { id, name: short(raw.name, KIT_LIMITS.name) || 'Brand kit', palette, fonts, files, logos, logo, updated: Number.isFinite(+raw.updated) ? +raw.updated : 0 };
}

/** A kit from a theme (a deck's, or the one "Brand from a PowerPoint…" read): its colours, named by role, and fonts. */
export function kitFromTheme(theme, { id, name = 'Brand kit' } = {}) {
  const t = isObj(theme) ? theme : {};
  const colors = isObj(t.colors) ? t.colors : {};
  const palette = ROLES.filter((r) => hex(colors[r])).map((r) => ({ name: ROLE_LABEL[r], hex: hex(colors[r]), role: r }));
  const fonts = {};
  for (const k of ['heading', 'body']) {
    const fam = family(t.fonts && t.fonts[k]);
    if (!fam) continue;
    const fb = t.fallback && isSharedFont(t.fallback[k]) ? t.fallback[k] : closestFree(fam);
    fonts[k] = isSharedFont(fam) ? { family: fam } : { family: fam, fallback: fb, external: true }; // named in the file; drawn where installed, else its free stand-in
  }
  return normalizeKit({ id: id || `k${Date.now().toString(36)}`, name, palette, fonts });
}

/** The deck theme a kit gives (deck-model normalizeTheme keeps base, colors, fonts and fallback). */
export function kitTheme(kit, baseNow = 'glass', themes = null) {
  const colors = paletteColors(kit.palette);
  const dark = luminance(colors.bg) < 0.2;
  const baseDark = themes && themes[baseNow] ? !!themes[baseNow].dark : false;
  const base = dark === baseDark ? baseNow : dark ? 'glass-dark' : 'glass';
  const out = { base, colors };
  const fonts = {}, fallback = {};
  for (const k of ['heading', 'body']) { const f = kit.fonts && kit.fonts[k]; if (f) { fonts[k] = f.family; if (f.fallback !== f.family && !f.external) fallback[k] = f.fallback; } } // a face read from a PowerPoint keeps its name in the export
  if (Object.keys(fonts).length) out.fonts = fonts;
  if (Object.keys(fallback).length) out.fallback = fallback;
  return out;
}

/** The deck with a kit applied: its theme and, with `logoId`, the kit's logo on every slide. A new object. */
export function applyKit(deck, kit, { logoId = '', themes = null } = {}) {
  const d = JSON.parse(JSON.stringify(deck));
  d.theme = kitTheme(kit, (deck.theme && deck.theme.base) || 'glass', themes);
  const brand = { kit: kit.id };
  if (logoId) Object.assign(brand, { logo: logoId, corner: kit.logo.corner, size: kit.logo.size });
  d.brand = brand;
  return d;
}

/** `deck.brand`, cleaned: { kit?, logo?, corner, size } or null. */
export function normalizeBrand(b) {
  if (!isObj(b)) return null;
  const out = {};
  if (kitId(b.kit)) out.kit = b.kit;
  if (kitId(b.logo)) Object.assign(out, { logo: b.logo, corner: CORNERS.includes(b.corner) ? b.corner : 'tr', size: SIZES[b.size] ? b.size : 's' });
  return Object.keys(out).length ? out : null;
}
/** Move the deck's logo to another corner, change its size, or take it off (corner 'none'). */
export function setLogo(deck, { corner, size } = {}) {
  const d = JSON.parse(JSON.stringify(deck));
  if (!d.brand || !d.brand.logo) return deck;
  if (corner === 'none') { delete d.brand.logo; delete d.brand.corner; delete d.brand.size; if (!d.brand.kit) delete d.brand; return d; }
  if (CORNERS.includes(corner)) d.brand.corner = corner;
  if (SIZES[size]) d.brand.size = size;
  return d;
}

/** Where the logo sits on a 1280 × 720 slide: { x, y, w, h } in px, or null. `im` is its picture ({ w, h }). */
export function logoBox(brand, im, W = 1280, H = 720) {
  if (!brand || !brand.logo || !im) return null;
  const h0 = SIZES[brand.size] || SIZES.s;
  const ratio = im.w > 0 && im.h > 0 ? im.w / im.h : 1;
  let h = h0, w = h * ratio;
  const maxW = h0 * 4;
  if (w > maxW) { w = maxW; h = w / ratio; }
  const m = 22;
  const c = CORNERS.includes(brand.corner) ? brand.corner : 'tr';
  return { x: Math.round(c[1] === 'l' ? m : W - m - w), y: Math.round(c[0] === 't' ? m - 4 : H - m - h), w: Math.round(w), h: Math.round(h), corner: c };
}

/**
 * @font-face rules for a deck's fonts: [{ family, data, weight?, style? }] (an uploaded file, or one face of a free
 * family). Only checked data: URLs and plain names reach the CSS.
 */
export function fontFaceCss(files) {
  return (Array.isArray(files) ? files : []).filter((f) => f && family(f.family) === f.family && fontFormat(f.data))
    .map((f) => `@font-face{font-family:"${f.family}";src:url(${f.data}) format("${fontFormat(f.data)}");${f.weight === 700 ? 'font-weight:700;' : f.weight === 400 ? 'font-weight:400;' : ''}${f.style === 'italic' ? 'font-style:italic;' : ''}font-display:swap}`).join('\n');
}
/** The free face drawn when a named one isn't there: the theme's fallback, else the closest free family ('' for a shared face). */
export function cssAlternative(name, fallback) { return fallback || (isSharedFont(name) ? '' : closestFree(name)); }
/**
 * What a deck's frame embeds: { uploaded: [the kits' files it uses], free: [free families] }. With `shared` (a shared
 * copy, the PDF), no uploaded file: their alternatives draw instead.
 */
export function fontNeeds(deck, kits, { shared = false } = {}) {
  const t = (deck && deck.theme) || {};
  const fonts = t.fonts || {}, fb = t.fallback || {};
  const free = new Set(), want = new Set();
  for (const k of ['heading', 'body']) {
    const name = fonts[k];
    if (!name) continue;
    if (isFreeFont(name)) free.add(name);
    else want.add(name);
    const alt = cssAlternative(name, fb[k]);
    if (isFreeFont(alt)) free.add(alt);
  }
  for (const f of richFonts(deck)) free.add(f); // fonts picked for words in slide text (deck-rich.js): free families only
  const uploaded = [], seen = new Set();
  if (!shared) for (const k of kits || []) for (const f of k.files || []) if (want.has(f.family) && !seen.has(f.family)) { seen.add(f.family); uploaded.push(f); }
  return { uploaded, free: [...free] };
}
/** The uploaded font files a deck needs, out of every kit on this device. */
export const fontsFor = (deck, kits) => fontNeeds(deck, kits).uploaded;
export { freeFaces };

/** The .pptx slide XML with each serif or mono face's pitchFamily set (PptxGenJS writes 34, sans, for every face). */
export function pptxFontClass(xml, names) {
  let out = xml;
  for (const n of new Set(names)) {
    const kind = fontKind(n);
    if (kind === 'sans' || family(n) !== n) continue;
    out = out.split(`typeface="${n}" pitchFamily="34"`).join(`typeface="${n}" pitchFamily="${PITCH[kind]}"`);
  }
  return out;
}
/** The serif and mono faces a deck's .pptx names (the brand's, after fallbacks). */
export function brandPitchNames(deck) {
  const t = (deck && deck.theme) || {};
  return ['heading', 'body'].map((k) => (t.fallback && t.fallback[k]) || (t.fonts && t.fonts[k])).filter((n) => n && fontKind(n) !== 'sans' && family(n) === n);
}
/** The .pptx (Blob or bytes) with brandPitchNames' pitchFamily fixed in every slide; same type back. */
export async function withFontClass(JSZip, file, deck) {
  const names = brandPitchNames(deck);
  if (!names.length) return file;
  const zip = await JSZip.loadAsync(file);
  for (const n of Object.keys(zip.files).filter((x) => /^ppt\/(slides\/slide\d+|slideMasters\/slideMaster\d+|theme\/theme\d+)\.xml$/.test(x))) {
    const xml = await zip.file(n).async('string');
    const out = pptxFontClass(xml, names);
    if (out !== xml) zip.file(n, out);
  }
  const bytes = file instanceof Uint8Array;
  return zip.generateAsync({ type: bytes ? 'uint8array' : 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', compression: 'DEFLATE' });
}
