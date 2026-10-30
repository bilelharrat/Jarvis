// Rich text on slides (web editor): bold, italic, underline, strikethrough, colour, highlight, size, font and links
// on parts of a text, plus each text's alignment and numbered lists. Pure: no DOM (tested in deck-rich.test.ts).
//
// The format is backward compatible: every text stays a plain string where it always was, so everything that reads
// a deck (layout, outline, translate, resize, the model's prompt) keeps working. The formatting sits beside it:
//   slide.fmt = { runs: { [path]: [{ t, b, i, u, s, color, hl, size, font, link }] },
//                 align: { [path]: 'left'|'center'|'right'|'justify' }, list: { [listPath]: 'num' } }
// A path is the same one the editor already uses (deck-model.js setText: 'title', 'bullets.2', 'bullets.1.sub.0',
// 'cards.0.heading'…). A run's `t` pieces join to exactly the plain text; when the text changed under them (an AI
// rewrite, translate, find/replace, a typed edit) normalizeFmt() keeps the formatting of the unchanged start and end
// and gives new words the formatting of their neighbour. Formatting follows a text that moved (a deleted or indented
// bullet, a slide the model rewrote) by its exact words. Old decks have no `fmt` and draw exactly as before.
//
// Run fields: b/i/u/s booleans (false undoes a bold heading); color/hl a theme colour name or #rrggbb; size a
// multiple of the text's own size (0.5–3, so the slide's fit still works); font one of the free families in
// deck-fonts.js; link an http(s) URL or '#N' (go to slide N).

import { isFreeFont, FREE_FONTS } from './deck-fonts.js';

export const RICH_COLORS = ['accent', 'accent2', 'text', 'muted']; // theme colours a run may name
export const HIGHLIGHTS = { yellow: '#fde68a', green: '#bbf7d0', pink: '#fbcfe8', blue: '#bfdbfe' }; // the format bar's markers
export const ALIGNS = ['left', 'center', 'right', 'justify'];
export const RICH_MAX_RUNS = 48; // per text
const MAX_ENTRIES = 160; // texts with formatting, per slide
const SIZE_MIN = 0.5, SIZE_MAX = 3, SIZE_STEP = 1.15;
const ATTRS = ['b', 'i', 'u', 's', 'color', 'hl', 'size', 'font', 'link'];
const BOOLS = ['b', 'i', 'u', 's'];

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// what deck-model.js text() strips: control and invisible direction characters, and what XML can't hold
const HIDDEN = /[\u0000-\u001F\u007F-\u009F​-‏‪-‮⁠⁦-⁩﻿]/g;
const NOT_XML = /[￾￿﷐-﷯]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const hex = (v) => (typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v.trim()) ? `#${v.trim().replace('#', '').toLowerCase()}` : '');
const colorOf = (v) => (RICH_COLORS.includes(v) ? v : hex(v));
const hlOf = (v) => (own(HIGHLIGHTS, v) ? HIGHLIGHTS[v] : colorOf(v));
/** The same check as deck-model.js safeUrl (http and https only), or '#N' for a slide of the deck. */
export function richLink(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  const m = /^#(\d{1,2})$/.exec(s);
  if (m) { const n = Number(m[1]); return n >= 1 && n <= 60 ? `#${n}` : ''; }
  return /^https?:\/\/[^\s<>"]{1,2000}$/i.test(s) ? s : '';
}

// ── paths ──

// texts that can carry formatting: the editable ones (deck-model.js PATHS) except notes and alt text
const RICH_PATHS = [
  /^(title|subtitle|kicker|takeaway|caption|quote|by)$/,
  /^bullets\.(\d{1,2})(\.sub\.(\d{1,2}))?$/,
  /^(left|right)\.(heading|bullets\.(\d{1,2})(\.sub\.(\d{1,2}))?)$/,
  /^cards\.(\d)\.(heading|badge|bullets\.(\d{1,2})(\.sub\.(\d{1,2}))?)$/,
  /^table\.(header\.(\d{1,2})|rows\.(\d{1,2})\.(\d{1,2}))$/,
  /^stats\.(\d)\.(value|label|delta)$/,
  /^diagram\.items\.(\d{1,2})\.(label|detail)$/,
  /^chart\.labels\.(\d{1,2})$/,
];
export const richPath = (p) => typeof p === 'string' && p.length < 40 && RICH_PATHS.some((re) => re.test(p));
const LIST_PATH = /^(bullets|(left|right)\.bullets|cards\.\d\.bullets)$/;
export const listPath = (p) => typeof p === 'string' && LIST_PATH.test(p);
/** The list a bullet path belongs to: 'cards.1.bullets.2.sub.0' → 'cards.1.bullets'. */
export const listOf = (p) => { const m = /^((?:(?:left|right|cards\.\d)\.)?bullets)\.\d/.exec(String(p || '')); return m ? m[1] : ''; };

/** The plain text at `path` on a slide ('' when there is none). A bullet with sub-points is its `text`. */
export function textAt(slide, path) {
  let o = slide;
  for (const k of String(path).split('.')) {
    if (o === null || typeof o !== 'object') return '';
    o = Array.isArray(o) ? (/^\d+$/.test(k) ? o[Number(k)] : undefined) : own(o, k) ? o[k] : undefined;
  }
  if (isObj(o) && typeof o.text === 'string') return o.text;
  return typeof o === 'string' ? o : '';
}

/** Every formattable text on a slide: [[path, text]]. */
export function textPaths(s) {
  const out = [];
  if (!isObj(s)) return out;
  const add = (p, v) => { const t = isObj(v) ? v.text : v; if (typeof t === 'string' && t) out.push([p, t]); };
  for (const k of ['title', 'subtitle', 'kicker', 'takeaway', 'caption', 'quote', 'by']) add(k, s[k]);
  const bl = (pre, items) => (Array.isArray(items) ? items : []).forEach((b, i) => { add(`${pre}.${i}`, b); if (isObj(b) && Array.isArray(b.sub)) b.sub.forEach((x, j) => add(`${pre}.${i}.sub.${j}`, x)); });
  bl('bullets', s.bullets);
  for (const side of ['left', 'right']) if (isObj(s[side])) { add(`${side}.heading`, s[side].heading); bl(`${side}.bullets`, s[side].bullets); }
  (Array.isArray(s.cards) ? s.cards : []).forEach((c, i) => { if (!isObj(c)) return; add(`cards.${i}.heading`, c.heading); add(`cards.${i}.badge`, c.badge); bl(`cards.${i}.bullets`, c.bullets); });
  if (isObj(s.table)) { (s.table.header || []).forEach((h, i) => add(`table.header.${i}`, h)); (s.table.rows || []).forEach((r, i) => (Array.isArray(r) ? r : []).forEach((c, j) => add(`table.rows.${i}.${j}`, c))); }
  (Array.isArray(s.stats) ? s.stats : []).forEach((x, i) => { if (isObj(x)) for (const k of ['value', 'label', 'delta']) add(`stats.${i}.${k}`, x[k]); });
  if (isObj(s.diagram)) (s.diagram.items || []).forEach((x, i) => { if (isObj(x)) { add(`diagram.items.${i}.label`, x.label); add(`diagram.items.${i}.detail`, x.detail); } });
  if (isObj(s.chart)) (s.chart.labels || []).forEach((l, i) => add(`chart.labels.${i}`, l));
  return out.filter(([p]) => richPath(p));
}

// ── runs ──

const attrsOf = (r) => { const a = {}; for (const k of ATTRS) if (r[k] !== undefined) a[k] = r[k]; return a; };
const sameAttrs = (a, b) => ATTRS.every((k) => a[k] === b[k]);
const hasAttrs = (r) => ATTRS.some((k) => r[k] !== undefined);
const joined = (runs) => runs.map((r) => r.t).join('');
// never cut between the two halves of an emoji
const snap = (s, at) => (at > 0 && at < s.length && /[\uD800-\uDBFF]/.test(s[at - 1]) ? at - 1 : at);

/** One run, cleaned: known fields with good values only. */
function cleanRun(r) {
  if (typeof r === 'string') r = { t: r };
  if (!isObj(r)) return null;
  const raw = typeof r.t === 'string' ? r.t : typeof r.text === 'string' ? r.text : '';
  const t = raw.slice(0, 2000).replace(/[\t\n\r]/g, ' ').replace(HIDDEN, '').replace(NOT_XML, '');
  if (!t) return null;
  const out = { t };
  for (const k of BOOLS) if (typeof r[k] === 'boolean') out[k] = r[k];
  const color = colorOf(r.color); if (color) out.color = color;
  const hl = hlOf(r.hl); if (hl) out.hl = hl;
  const size = typeof r.size === 'number' && Number.isFinite(r.size) ? Math.round(Math.min(SIZE_MAX, Math.max(SIZE_MIN, r.size)) * 100) / 100 : 0;
  if (size && size !== 1) out.size = size;
  if (isFreeFont(r.font)) out.font = r.font;
  const link = richLink(r.link); if (link) out.link = link;
  return out;
}

/** Runs restricted to characters [a, b). */
function slice(runs, a, b) {
  const out = [];
  let at = 0;
  for (const r of runs) {
    const end = at + r.t.length;
    if (end > a && at < b) out.push({ ...r, t: r.t.slice(Math.max(0, a - at), Math.min(r.t.length, b - at)) });
    at = end;
    if (at >= b) break;
  }
  return out.filter((r) => r.t);
}
const attrsAt = (runs, i) => { let at = 0; for (const r of runs) { if (i < at + r.t.length) return attrsOf(r); at += r.t.length; } return runs.length ? attrsOf(runs[runs.length - 1]) : {}; };

/** Adjacent runs with the same formatting become one; capped (the rest keeps the last run's formatting). */
function merge(runs) {
  const out = [];
  for (const r of runs) {
    if (!r.t) continue;
    const last = out[out.length - 1];
    if (last && sameAttrs(last, r)) last.t += r.t; else out.push({ ...r });
  }
  if (out.length > RICH_MAX_RUNS) { const tail = out.splice(RICH_MAX_RUNS - 1); out.push({ ...tail[0], t: joined(tail) }); }
  return out;
}

/**
 * Runs whose text is `plain`: the formatting of the unchanged start and end kept, the changed middle formatted
 * like the character before it (or, at the very start, like the first character it replaced).
 */
export function reconcile(runs, plain) {
  const old = joined(runs);
  if (old === plain) return runs;
  if (!plain) return [];
  if (!old) return [{ t: plain }];
  let p = 0;
  const max = Math.min(old.length, plain.length);
  while (p < max && old[p] === plain[p]) p++;
  p = Math.min(snap(old, p), snap(plain, p));
  let q = 0;
  while (q < max - p && old[old.length - 1 - q] === plain[plain.length - 1 - q]) q++;
  while (q > 0 && (snap(old, old.length - q) !== old.length - q || snap(plain, plain.length - q) !== plain.length - q)) q--;
  const mid = plain.slice(p, plain.length - q);
  const anchor = attrsAt(runs, old.length - q > p || p === 0 ? p : p - 1); // replaced words look like what they replaced; inserted ones like the word before
  // inside the changed middle, formatted words that are still there (in order) keep their formatting: typing at both ends
  const marks = [];
  let from = 0, oldAt = p;
  for (const r of slice(runs, p, old.length - q)) {
    oldAt += r.t.length;
    if (!hasAttrs(r) || r.t.trim().length < 2) continue;
    const at = mid.indexOf(r.t, from);
    if (at < 0 || (at > 0 && snap(mid, at) !== at)) continue;
    marks.push([at, at + r.t.length, attrsOf(r), oldAt < old.length ? attrsAt(runs, oldAt) : attrsOf(r)]); // and what followed it, for new words after it
    from = at + r.t.length;
  }
  const midRuns = [];
  let cur = 0, gap = anchor; // new words before the first kept one look like the anchor; later ones like what followed the kept word
  for (const [a, b, at, after] of marks) { if (a > cur) midRuns.push({ ...gap, t: mid.slice(cur, a) }); midRuns.push({ ...at, t: mid.slice(a, b) }); cur = b; gap = after; }
  if (cur < mid.length) midRuns.push({ ...gap, t: mid.slice(cur) });
  return [...slice(runs, 0, p), ...midRuns, ...slice(runs, old.length - q, old.length)];
}

/** Clean runs for `plain` (null when nothing in them is formatted). */
export function normalizeRuns(runs, plain) {
  if (!Array.isArray(runs) || typeof plain !== 'string' || !plain) return null;
  const clean = runs.slice(0, 400).map(cleanRun).filter(Boolean);
  if (!clean.length) return null;
  const out = merge(reconcile(merge(clean), plain));
  return out.some(hasAttrs) && joined(out) === plain ? out : null;
}

// ── a slide's formatting ──

/** slide.fmt cleaned against the slide's own texts (null when there's nothing left). */
export function normalizeFmt(fmt, slide) {
  if (!isObj(fmt) || !isObj(slide)) return null;
  const out = {};
  const texts = new Map(textPaths(slide));
  // runs: kept where their words still are; followed by exact words to where the text moved; else re-fitted in place
  if (isObj(fmt.runs)) {
    const entries = Object.keys(fmt.runs).slice(0, MAX_ENTRIES * 2).filter(richPath)
      .map((p) => { const r = Array.isArray(fmt.runs[p]) ? fmt.runs[p].slice(0, 400).map(cleanRun).filter(Boolean) : []; return { p, runs: merge(r), t: joined(r) }; })
      .filter((e) => e.runs.length && e.runs.some(hasAttrs));
    const runs = {}, used = new Set(), left = [];
    for (const e of entries) if (texts.get(e.p) === e.t && !used.has(e.p)) { runs[e.p] = e.runs; used.add(e.p); } else left.push(e);
    const late = [];
    for (const e of left) {
      const to = [...texts].find(([p, t]) => t === e.t && !used.has(p));
      if (to) { runs[to[0]] = e.runs; used.add(to[0]); } else late.push(e);
    }
    for (const e of late) if (texts.has(e.p) && !used.has(e.p)) { const r = normalizeRuns(e.runs, texts.get(e.p)); if (r) { runs[e.p] = r; used.add(e.p); } }
    for (const p of Object.keys(runs)) { const r = normalizeRuns(runs[p], texts.get(p)); if (r) runs[p] = r; else delete runs[p]; }
    const keys = Object.keys(runs).slice(0, MAX_ENTRIES);
    if (keys.length) out.runs = Object.fromEntries(keys.map((k) => [k, runs[k]]));
  }
  if (isObj(fmt.align)) {
    const a = Object.keys(fmt.align).slice(0, MAX_ENTRIES * 2).filter((p) => (richPath(p) && texts.has(p)) || (listPath(p) && listItems(slide, p).length)).filter((p) => ALIGNS.includes(fmt.align[p]));
    if (a.length) out.align = Object.fromEntries(a.slice(0, MAX_ENTRIES).map((p) => [p, fmt.align[p]]));
  }
  if (isObj(fmt.list)) {
    const l = Object.keys(fmt.list).slice(0, 20).filter((p) => listPath(p) && fmt.list[p] === 'num' && listItems(slide, p).length);
    if (l.length) out.list = Object.fromEntries(l.map((p) => [p, 'num']));
  }
  return Object.keys(out).length ? out : null;
}
function listItems(slide, p) {
  let o = slide;
  for (const k of p.split('.')) { if (o === null || typeof o !== 'object') return []; o = Array.isArray(o) ? o[Number(k)] : o[k]; }
  return Array.isArray(o) ? o : [];
}

/** The runs to draw for `path` ([{ t }] when it has no formatting); null when `shown` isn't the stored text (a "(2/3)" title). */
export function runsFor(slide, path, shown) {
  const r = slide && slide.fmt && slide.fmt.runs && own(slide.fmt.runs, path) ? slide.fmt.runs[path] : null;
  if (!r) return null;
  return joined(r) === shown ? r : null;
}
export const alignFor = (slide, path) => { const a = slide && slide.fmt && slide.fmt.align; if (!a) return ''; const v = own(a, path) ? a[path] : own(a, listOf(path)) ? a[listOf(path)] : ''; return ALIGNS.includes(v) ? v : ''; };
export const numbered = (slide, list) => !!(slide && slide.fmt && slide.fmt.list && slide.fmt.list[list] === 'num');

// bold where nothing says otherwise: a run's b:false is what un-bolds these
const BOLD_BASE = /^(title|(left|right|cards\.\d)\.heading|takeaway|stats\.\d\.value|table\.header\.\d+|cards\.\d\.badge)$/;
export const baseBold = (path) => BOLD_BASE.test(String(path || ''));

/** What the text at path [start, end) looks like: { b, i, u, s, color, hl, size, font, link } (mixed → undefined, booleans → false). */
export function formatAt(slide, path, start = 0, end = Infinity) {
  const plain = textAt(slide, path);
  const runs = (slide && slide.fmt && slide.fmt.runs && slide.fmt.runs[path]) || [{ t: plain }];
  const a = Math.max(0, Math.min(plain.length, start)), b = Math.max(a, Math.min(plain.length, end));
  const parts = a === b ? (plain ? [attrsAt(runs, Math.max(0, a - 1))] : [{}]) : slice(runs, a, b).map(attrsOf);
  const out = { mixed: [] };
  for (const k of ATTRS) {
    const vals = new Set(parts.map((x) => (BOOLS.includes(k) ? (x[k] ?? (k === 'b' && baseBold(path))) === true : x[k])));
    if (vals.size === 1) out[k] = [...vals][0]; else out.mixed.push(k); // mixed: undefined, named in `mixed`
  }
  out.align = alignFor(slide, path) || 'left';
  out.list = listOf(path) ? (numbered(slide, listOf(path)) ? 'num' : 'bullet') : '';
  return out;
}

const clone = (d) => JSON.parse(JSON.stringify(d));
function withFmt(deck, i, f) {
  const d = clone(deck);
  const s = d.slides[i];
  const next = f(s, s.fmt ? clone(s.fmt) : {});
  const fmt = normalizeFmt(next, s);
  if (fmt) s.fmt = fmt; else delete s.fmt;
  return d;
}

/**
 * The deck with `patch` applied to the text at `path` on slide `i`, characters [start, end) (the whole text when
 * start === end). patch: { b|i|u|s: true|false|'toggle', color, hl, font, link: value or null to clear,
 * size: 'up'|'down'|number|null }.
 */
export function formatRange(deck, i, path, start, end, patch) {
  const s = deck && deck.slides && deck.slides[i];
  if (!s || !richPath(path) || !isObj(patch)) return deck;
  const plain = textAt(s, path);
  if (!plain) return deck;
  let a = Math.max(0, Math.min(plain.length, Math.floor(Number(start) || 0))), b = Math.max(0, Math.min(plain.length, Math.floor(Number(end) || 0)));
  if (a > b) [a, b] = [b, a];
  if (a === b) { a = 0; b = plain.length; }
  a = snap(plain, a); b = snap(plain, b) === b ? b : b + 1;
  const now = formatAt(s, path, a, b);
  return withFmt(deck, i, (sl, fmt) => {
    const runs = fmt.runs && fmt.runs[path] && joined(fmt.runs[path]) === plain ? fmt.runs[path] : [{ t: plain }];
    const mid = slice(runs, a, b).map((r) => {
      const n = { ...r };
      for (const k of BOOLS) if (own(patch, k)) {
        const want = patch[k] === 'toggle' ? now[k] !== true : patch[k] === true;
        if (want === (k === 'b' && baseBold(path))) delete n[k]; else n[k] = want;
      }
      for (const k of ['color', 'hl', 'font', 'link']) if (own(patch, k)) { if (patch[k] === null || patch[k] === '') delete n[k]; else n[k] = patch[k]; }
      if (own(patch, 'size')) {
        const cur = n.size || 1;
        const v = patch.size === 'up' ? cur * SIZE_STEP : patch.size === 'down' ? cur / SIZE_STEP : patch.size === null ? 1 : Number(patch.size);
        if (Number.isFinite(v)) n.size = Math.round(Math.min(SIZE_MAX, Math.max(SIZE_MIN, v)) * 100) / 100;
        if (n.size === 1 || Math.abs(n.size - 1) < 0.02) delete n.size;
      }
      return n;
    });
    const next = merge([...slice(runs, 0, a), ...mid, ...slice(runs, b, plain.length)]);
    fmt.runs = { ...(fmt.runs || {}), [path]: next };
    return fmt;
  });
}

/** The deck with the text at `path` (or its whole list) aligned. */
export function setAlign(deck, i, path, align) {
  const s = deck && deck.slides && deck.slides[i];
  if (!s || !(richPath(path) || listPath(path)) || !ALIGNS.includes(align)) return deck;
  const key = listOf(path) || path; // a bullet aligns its whole list, like Keynote's text box
  return withFmt(deck, i, (sl, fmt) => {
    const al = { ...(fmt.align || {}) };
    for (const p of Object.keys(al)) if (p === key || listOf(p) === key) delete al[p];
    if (align !== 'left') al[key] = align;
    fmt.align = al;
    return fmt;
  });
}

/** The deck with a bullet list numbered ('num') or bulleted. `path` may be the list or any of its bullets. */
export function setList(deck, i, path, kind) {
  const s = deck && deck.slides && deck.slides[i];
  const key = listPath(path) ? path : listOf(path);
  if (!s || !key || !listItems(s, key).length) return deck;
  return withFmt(deck, i, (sl, fmt) => {
    const l = { ...(fmt.list || {}) };
    if (kind === 'num') l[key] = 'num'; else delete l[key];
    fmt.list = l;
    return fmt;
  });
}

/**
 * Tab / Shift+Tab on a bullet: in (+1) makes it a sub-point of the one above (its own sub-points come along);
 * out (-1) makes a sub-point a bullet after its parent, taking the sub-points below it. Formatting follows the words.
 * Returns { deck, path } (the bullet's new path), or null when it can't move (first bullet, list full, one level only).
 */
export function indentBullet(deck, i, path, dir, limits = { bullets: 14, sub: 6 }) {
  const s = deck && deck.slides && deck.slides[i];
  const m = /^((?:(?:left|right|cards\.\d)\.)?bullets)\.(\d+)(?:\.sub\.(\d+))?$/.exec(String(path || ''));
  if (!s || !m) return null;
  const d = clone(deck);
  const sl = d.slides[i];
  const items = listItems(sl, m[1]);
  const n = Number(m[2]);
  const toObj = (b) => (isObj(b) ? { text: b.text, sub: [...(b.sub || [])] } : { text: b, sub: [] });
  if (!items[n]) return null;
  let to;
  if (dir > 0 && m[3] === undefined) {
    if (n === 0) return null;
    const prev = toObj(items[n - 1]), cur = toObj(items[n]);
    if (!cur.text) return null;
    if (prev.sub.length + 1 + cur.sub.length > limits.sub) return null;
    prev.sub.push(cur.text, ...cur.sub);
    items.splice(n - 1, 2, prev);
    to = `${m[1]}.${n - 1}.sub.${prev.sub.length - 1 - cur.sub.length}`;
  } else if (dir < 0 && m[3] !== undefined) {
    if (items.length >= limits.bullets) return null;
    const parent = toObj(items[n]);
    const j = Number(m[3]);
    if (j >= parent.sub.length) return null;
    const lifted = { text: parent.sub[j], sub: parent.sub.slice(j + 1) };
    parent.sub = parent.sub.slice(0, j);
    items.splice(n, 1, parent.sub.length ? parent : parent.text, lifted.sub.length ? lifted : lifted.text);
    to = `${m[1]}.${n + 1}`;
  } else return null;
  const fmt = normalizeFmt(sl.fmt, sl); // the words moved: their formatting follows them (normalizeFmt matches exact text)
  if (fmt) sl.fmt = fmt; else delete sl.fmt;
  return { deck: d, path: to };
}

/**
 * A rewritten deck (Eden wrote a whole new deck) keeps the formatting of every text whose words didn't change:
 * the same slide first, then any slide. Lists and alignment follow a slide with the same title.
 */
export function carryFmt(prev, next) {
  if (!prev || !next || !Array.isArray(prev.slides) || !Array.isArray(next.slides)) return next;
  const all = new Map();
  prev.slides.forEach((s) => { for (const [p, r] of Object.entries((s.fmt && s.fmt.runs) || {})) { const t = joined(r); if (!all.has(t)) all.set(t, r); } });
  if (!all.size && !prev.slides.some((s) => s.fmt)) return next;
  next.slides.forEach((s, j) => {
    if (s.fmt) return; // the model kept it (or wrote its own): normalizeSlide already cleaned it
    const old = prev.slides.find((x) => x.title && x.title === s.title) || prev.slides[j];
    const mine = new Map(Object.entries((old && old.fmt && old.fmt.runs) || {}).map(([p, r]) => [joined(r), r]));
    const runs = {};
    for (const [p, t] of textPaths(s)) { const r = mine.get(t) || all.get(t); if (r) runs[p] = r; }
    const f = normalizeFmt({ runs, ...(old && old.title === s.title && old.fmt ? { align: old.fmt.align, list: old.fmt.list } : {}) }, s);
    if (f) s.fmt = f;
  });
  return next;
}

/** The free font families a deck's runs use (deck-brand-model.js fontNeeds loads them into the frame). */
export function richFonts(deck) {
  const out = new Set();
  for (const s of (deck && deck.slides) || []) for (const r of Object.values((s.fmt && s.fmt.runs) || {})) for (const x of r) if (x.font) out.add(x.font);
  return [...out];
}

/** A deck without formatting (what the model is shown: plain words only). */
export const withoutFmt = (slides) => slides.map((s) => { if (!s.fmt) return s; const { fmt, ...rest } = s; return rest; });

// ── drawing (the frame's HTML and PowerPoint's runs) ──

const CSS_COLOR = { accent: 'var(--accent)', accent2: 'var(--accent2)', text: 'var(--text)', muted: 'var(--muted)' };
const FONT_FALLBACK = { sans: 'var(--bf)', serif: 'Georgia,serif', mono: 'ui-monospace,Menlo,monospace' };
/** Inline CSS for a run (every value is from a closed list or #rrggbb, so nothing can break out of the attribute). */
export function runCss(r) {
  const css = [];
  if (r.b === true) css.push('font-weight:700'); else if (r.b === false) css.push('font-weight:400');
  if (r.i === true) css.push('font-style:italic'); else if (r.i === false) css.push('font-style:normal');
  const deco = [r.u ? 'underline' : '', r.s ? 'line-through' : ''].filter(Boolean);
  if (deco.length) css.push(`text-decoration:${deco.join(' ')}`);
  if (r.color && (CSS_COLOR[r.color] || hex(r.color))) css.push(`color:${CSS_COLOR[r.color] || hex(r.color)}`);
  if (r.hl && (CSS_COLOR[r.hl] || hex(r.hl))) css.push(`background:${CSS_COLOR[r.hl] ? `color-mix(in srgb,${CSS_COLOR[r.hl]} 30%,transparent)` : hex(r.hl)};border-radius:.12em;-webkit-box-decoration-break:clone;box-decoration-break:clone`);
  if (r.size) css.push(`font-size:${Math.round(r.size * 100) / 100}em`);
  if (r.font && isFreeFont(r.font)) css.push(`font-family:"${r.font}",${FONT_FALLBACK[FREE_FONTS[r.font].kind] || 'var(--bf)'}`);
  return css.join(';');
}

/**
 * The HTML for runs; `piece(text)` draws plain words (escaped, citations as superscripts). Links: a web address opens
 * in a new tab; '#N' goes to slide N when presenting (data-go; the viewer handles it).
 */
export function runsHtml(runs, piece, esc) {
  return runs.map((r) => {
    const css = runCss(r);
    let h = piece(r.t);
    if (css) h = `<span class="rt" style="${esc(css)}">${h}</span>`;
    const link = richLink(r.link);
    if (link) h = link[0] === '#' ? `<a class="rl" href="${esc(link)}" data-go="${esc(link.slice(1))}">${h}</a>` : `<a class="rl" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${h}</a>`;
    return h;
  }).join('');
}
export const RICH_CSS = '[data-al=center]{text-align:center}[data-al=right]{text-align:right}[data-al=justify]{text-align:justify}span[data-al]{display:block}.rl{color:inherit;text-decoration:underline;text-decoration-color:color-mix(in srgb,var(--accent) 70%,transparent);text-underline-offset:.12em}.rl .rt{text-decoration-color:inherit}.mode-edit .rl{cursor:text}ol.bl{counter-reset:bn}ol.bl>li{counter-increment:bn;padding-left:1.7em}ol.bl>li::before{content:counter(bn) ".";top:0;left:0;width:auto;height:auto;border-radius:0;background:none;box-shadow:none;color:var(--accent);font-weight:700;font-variant-numeric:tabular-nums}';

const mixHex = (a, b, w) => { const p = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16)); const x = p(a), y = p(b); return `#${x.map((v, k) => Math.round(v * w + y[k] * (1 - w)).toString(16).padStart(2, '0')).join('')}`; };
/**
 * PowerPoint text runs (PptxGenJS { text, options }) for one text: `base` is the options the box gives it, `pieces`
 * splits plain words into citation runs ([{ t, cite }]), `slideOf(n)` the .pptx slide a '#N' link opens (0 = none).
 */
export function pptxRuns(runs, base, { theme, pieces, slideOf = () => 0 }) {
  const C = (h) => h.replace('#', '').toUpperCase();
  const col = (v) => (theme && theme.colors && theme.colors[v] ? theme.colors[v] : hex(v));
  const out = [];
  for (const r of runs) {
    const o = { ...base };
    if (r.b !== undefined) o.bold = r.b;
    if (r.i !== undefined) o.italic = r.i;
    if (r.u) o.underline = { style: 'sng' };
    if (r.s) o.strike = 'sngStrike';
    if (r.color && col(r.color)) o.color = C(col(r.color));
    if (r.hl) { const h = RICH_COLORS.includes(r.hl) && theme ? mixHex(col(r.hl), theme.colors.bg, 0.3) : hex(r.hl); if (h) o.highlight = C(h); }
    if (r.size && base.fontSize) o.fontSize = Math.round(base.fontSize * r.size * 10) / 10;
    if (r.font && isFreeFont(r.font)) o.fontFace = r.font;
    const link = richLink(r.link);
    if (link && link[0] === '#') { const n = slideOf(Number(link.slice(1))); if (n > 0) o.hyperlink = { slide: n }; } else if (link) o.hyperlink = { url: link };
    for (const p of pieces(r.t)) out.push({ text: p.t, options: { ...o, ...(p.cite ? { superscript: true } : {}) } });
  }
  return out;
}

// ── PowerPoint import: a paragraph's runs back to Eden runs ──

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s) => String(s || '').replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/gi, (m, e) => { if (e[0] !== '#') return ENT[e.toLowerCase()]; const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)); return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ''; });
/** The text between each open…close pair, in one pass (a lazy regex rescans to the end for every unclosed tag). */
function between(s, open, close) {
  const out = [];
  for (let i = s.indexOf(open); i >= 0; i = s.indexOf(open, i)) {
    const end = s.indexOf(close, i + open.length);
    if (end < 0) break;
    out.push(s.slice(i + open.length, end));
    i = end + close.length;
  }
  return out;
}
const xattr = (tag, name) => { const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag); return m ? unxml(m[1]) : ''; };

/**
 * A slide's hyperlink relationships: Map rId → URL (http/https only) or '#N' for a link to another slide;
 * `slideNo(target)` gives the deck's number for a slide file (its place in the presentation's order).
 */
export function linkRels(relsXml, slideNo = (target) => { const n = /slide(\d+)\.xml$/.exec(target); return n ? Number(n[1]) : 0; }) {
  const out = new Map();
  for (const m of String(relsXml || '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = xattr(m[0], 'Id'), target = xattr(m[0], 'Target'), type = xattr(m[0], 'Type');
    if (!id) continue;
    if (/\/hyperlink$/.test(type) && xattr(m[0], 'TargetMode') === 'External') { const u = richLink(target); if (u && u[0] !== '#') out.set(id, u); }
    else if (/\/slide$/.test(type)) { const n = slideNo(target); const u = richLink(`#${n}`); if (u) out.set(id, u); }
  }
  return out;
}

/**
 * slide.fmt from an imported slide: `texts` = [{ path, paras: [<a:p> inner XML…], box: [every <a:p> of the same
 * shape and level] }], `lists` = { [listPath]: [<a:p>…] } (numbered when most of them are). The box's common style
 * is left out (it's the box, not formatting); normalizeFmt fits the runs to the cleaned words.
 */
export function pptxSlideFmt(texts, lists = {}, links = new Map()) {
  const runs = {}, align = {}, list = {};
  const seen = new Map(), styles = new Map();
  const pr = (p) => { if (!seen.has(p)) seen.set(p, paragraphRuns(p, links)); return seen.get(p); };
  const styleOf = (b) => { if (!styles.has(b)) styles.set(b, boxStyle(b.slice(0, 60).flatMap((p) => pr(p).runs))); return styles.get(b); };
  for (const e of (texts || []).slice(0, 200)) {
    if (!richPath(e.path) || !Array.isArray(e.paras) || !e.paras.length) continue;
    const parsed = e.paras.slice(0, 60).map(pr);
    const box = styleOf(e.box || e.paras);
    const raw = parsed.flatMap((x, k) => (k ? [{ t: ' ' }, ...x.runs] : x.runs));
    const r = pptxFmtRuns(raw, box);
    if (r.some(hasAttrs)) runs[e.path] = r;
    const al = parsed[0].align;
    if (al && al !== 'left' && !listOf(e.path)) align[e.path] = al;
  }
  for (const [p, paras] of Object.entries(lists)) if (listPath(p) && paras.length && paras.filter((x) => pr(x).num).length * 2 > paras.length) list[p] = 'num';
  const out = {};
  if (Object.keys(runs).length) out.runs = runs;
  if (Object.keys(align).length) out.align = align;
  if (Object.keys(list).length) out.list = list;
  return Object.keys(out).length ? out : null;
}

/**
 * One <a:p>'s runs, raw: [{ t, b, i, u, s, color, hl, sz, font, link }] plus the paragraph's align and whether it's
 * numbered. `links` from linkRels. Attributes are as written; pptxFmt() decides which are the box's own style.
 */
export function paragraphRuns(pXml, links = new Map()) {
  const p = String(pXml || '');
  const ppr = /<a:pPr\b[^>]*\/?>/.exec(p);
  const algn = ppr ? xattr(ppr[0], 'algn') : '';
  const runs = [];
  for (const r of between(p, '<a:r>', '</a:r>').slice(0, 400)) {
    if (r.length > 20000) continue;
    const t = between(r, '<a:t>', '</a:t>').map(unxml).join('');
    if (!t) continue;
    const rpr = (/<a:rPr\b[^>]*\/>|<a:rPr\b[^>]*>[\s\S]*?<\/a:rPr>/.exec(r) || [''])[0];
    const tag = (/<a:rPr\b[^>]*>/.exec(rpr) || [''])[0];
    const run = { t };
    if (xattr(tag, 'b')) run.b = xattr(tag, 'b') === '1' || xattr(tag, 'b') === 'true';
    if (xattr(tag, 'i')) run.i = xattr(tag, 'i') === '1' || xattr(tag, 'i') === 'true';
    const u = xattr(tag, 'u'); if (u) run.u = u !== 'none';
    const st = xattr(tag, 'strike'); if (st) run.s = st !== 'noStrike';
    const sz = Number(xattr(tag, 'sz')); if (sz > 0) run.sz = sz;
    const fill = /<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(rpr.replace(/<a:highlight>[\s\S]*?<\/a:highlight>/, ''));
    if (fill) run.color = `#${fill[1].toLowerCase()}`;
    const hl = /<a:highlight>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(rpr);
    if (hl) run.hl = `#${hl[1].toLowerCase()}`;
    const latin = /<a:latin\b[^>]*typeface="([^"]*)"/.exec(rpr);
    if (latin && isFreeFont(unxml(latin[1]))) run.font = unxml(latin[1]);
    const hk = /<a:hlinkClick\b[^>]*r:id="([^"]+)"/.exec(rpr);
    if (hk && links.has(hk[1])) run.link = links.get(hk[1]);
    runs.push(run);
  }
  return { runs, align: { ctr: 'center', r: 'right', just: 'justify', l: 'left' }[algn] || '', num: /<a:buAutoNum\b/.test(p) };
}

/**
 * Eden runs for one text from the raw runs of the paragraphs it came from, keeping only what stands out: a value
 * every run of the box shares (`box`: the dominant value of each attribute, from boxStyle) is the box's style, not
 * formatting. Sizes become multiples of the box's usual size.
 */
export function pptxFmtRuns(raw, box) {
  const runs = raw.map((r) => {
    const o = { t: r.t.replace(/\s+/g, ' ') };
    for (const k of ['b', 'i', 'u', 's']) if (r[k] !== undefined && r[k] !== (box[k] || false)) o[k] = r[k];
    if (r.color && r.color !== box.color) o.color = r.color;
    if (r.hl) o.hl = r.hl;
    if (r.font && r.font !== box.font) o.font = r.font;
    if (r.sz && box.sz && Math.abs(r.sz / box.sz - 1) > 0.05) o.size = r.sz / box.sz;
    if (r.link) o.link = r.link;
    return o;
  });
  return runs;
}
/** Each attribute's most common value across a box's raw runs (weighted by characters). */
export function boxStyle(rawRuns) {
  const out = {};
  for (const k of ['b', 'i', 'u', 's', 'color', 'font', 'sz']) {
    const w = new Map();
    for (const r of rawRuns) { const v = r[k] ?? (BOOLS.includes(k) ? false : ''); w.set(v, (w.get(v) || 0) + r.t.length); }
    let best, n = -1;
    for (const [v, c] of w) if (c > n) { best = v; n = c; }
    out[k] = best;
  }
  return out;
}
