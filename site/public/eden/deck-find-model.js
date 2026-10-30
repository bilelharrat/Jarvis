// Find and replace, and the words spell check reads (web only; the UI is deck-find.js). Pure, no DOM:
// src/__tests__/deck-find.test.ts covers it.
//
// Every piece of text a slide shows is a "field": { slide, path, fid, keys, text, label }.
//   - `path` is the frame's data-path for it (deck-render.js `editable`), so the frame can find and mark it;
//     free text boxes and shape text have `fid` instead (deck-freeform-draw.js data-fid).
//   - `keys` is where the text lives inside the slide object (a bullet with sub-points keeps its words in `.text`).
// A field's value is a string, or rich runs (deck-richtext): an array of { text, …style }, or { runs: [...] }.
// Replacing inside runs keeps every run's style: the new words take the style of the run the match starts in.

import { normalizeSlide } from './deck-model.js';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isRuns = (v) => (Array.isArray(v) && v.every((r) => isObj(r) && typeof r.text === 'string')) || (isObj(v) && Array.isArray(v.runs));
const runsOf = (v) => (Array.isArray(v) ? v : v.runs);
/** A field's plain text (runs joined). */
export const plain = (v) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : v && isRuns(v) ? runsOf(v).map((r) => r.text).join('') : '');

const LABEL = { kicker: 'Kicker', title: 'Title', subtitle: 'Subtitle', takeaway: 'Takeaway', caption: 'Caption', quote: 'Quote', by: 'Quote author', notes: 'Speaker notes', alt: 'Picture description' };

/** Every text field of the deck, in reading order (slide by slide, then speaker notes last on each slide). */
export function deckFields(deck, { notes = true, alt = true } = {}) {
  const out = [];
  (deck && Array.isArray(deck.slides) ? deck.slides : []).forEach((s, slide) => {
    if (!isObj(s)) return;
    const add = (keys, label, path = keys.join('.'), fid = '') => {
      let v = s;
      for (const k of keys) v = v == null ? v : v[k];
      const t = plain(v);
      if (t) out.push({ slide, path: fid ? '' : path, fid, keys, text: t, label });
    };
    const bullets = (base, list, label) => (Array.isArray(list) ? list : []).forEach((b, i) => {
      if (typeof b === 'string' || isRuns(b)) add([...base, i], label);
      else if (isObj(b)) {
        add([...base, i, 'text'], label, [...base, i].join('.'));
        (b.sub || []).forEach((_, j) => add([...base, i, 'sub', j], label));
      }
    });
    for (const f of ['kicker', 'title', 'subtitle']) add([f], LABEL[f]);
    bullets(['bullets'], s.bullets, 'Bullet');
    for (const side of ['left', 'right']) if (isObj(s[side])) { add([side, 'heading'], 'Column heading'); bullets([side, 'bullets'], s[side].bullets, 'Bullet'); }
    (s.cards || []).forEach((c, i) => { if (!isObj(c)) return; add(['cards', i, 'badge'], 'Card badge'); add(['cards', i, 'heading'], 'Card heading'); bullets(['cards', i, 'bullets'], c.bullets, 'Card text'); });
    if (isObj(s.table)) {
      (s.table.header || []).forEach((_, i) => add(['table', 'header', i], 'Table heading'));
      (s.table.rows || []).forEach((r, ri) => (Array.isArray(r) ? r : []).forEach((_, ci) => add(['table', 'rows', ri, ci], 'Table cell')));
    }
    (s.stats || []).forEach((_, i) => { add(['stats', i, 'value'], 'Number'); add(['stats', i, 'label'], 'Number label'); add(['stats', i, 'delta'], 'Number change'); });
    if (isObj(s.diagram)) (s.diagram.items || []).forEach((it, i) => {
      add(['diagram', 'items', i, 'label'], 'Diagram box'); add(['diagram', 'items', i, 'detail'], 'Diagram detail');
      (it && it.children || []).forEach((_, j) => add(['diagram', 'items', i, 'children', j], 'Diagram box'));
    });
    if (isObj(s.chart)) {
      (s.chart.labels || []).forEach((_, i) => add(['chart', 'labels', i], 'Chart label'));
      (s.chart.series || []).forEach((_, i) => add(['chart', 'series', i, 'name'], 'Chart series'));
      add(['chart', 'source'], 'Chart source');
    }
    for (const f of ['takeaway', 'caption', 'quote', 'by']) add([f], LABEL[f]);
    (s.free || []).forEach((e, i) => { if (isObj(e) && (e.type === 'text' || e.type === 'shape')) add(['free', i, 'text'], e.type === 'text' ? 'Text box' : 'Shape text', '', e.id || `f${i}`); });
    if (alt) add(['alt'], LABEL.alt);
    if (notes) add(['notes'], LABEL.notes);
  });
  return out;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD = '[\\p{L}\\p{N}\\p{M}_]';
/** The search as a global RegExp ('' query → null). Whole words: not inside a longer word, in any script. */
export function findRegex(query, { matchCase = false, wholeWord = false } = {}) {
  const q = String(query || '');
  if (!q) return null;
  const body = escRe(q).replace(/\s+/g, '\\s+'); // a space finds a line break or several spaces too
  return new RegExp(wholeWord ? `(?<!${WORD})${body}(?!${WORD})` : body, `g${matchCase ? '' : 'i'}u`);
}

/** Every match: [{ slide, path, fid, label, start, end, nth, text, before, after }], in reading order. `nth` counts within its field. */
export function findMatches(deck, query, opts = {}) {
  const re = findRegex(query, opts);
  if (!re) return [];
  const out = [];
  for (const f of deckFields(deck, opts)) {
    re.lastIndex = 0;
    let m, nth = 0;
    while ((m = re.exec(f.text))) {
      if (!m[0]) { re.lastIndex++; continue; }
      out.push({ slide: f.slide, path: f.path, fid: f.fid, keys: f.keys, label: f.label, start: m.index, end: m.index + m[0].length, nth: nth++, text: m[0],
        before: f.text.slice(Math.max(0, m.index - 30), m.index), after: f.text.slice(m.index + m[0].length, m.index + m[0].length + 30) });
      if (out.length >= 2000) return out;
    }
  }
  return out;
}

/** Runs with the spans [start, end) replaced by `rep`; each run keeps its style (the new words join the run a match starts in). */
export function replaceRuns(runs, spans, rep) {
  const out = runs.map((r) => ({ ...r }));
  for (const [start, end] of [...spans].sort((a, b) => b[0] - a[0])) { // from the end: earlier offsets stay right
    const total = out.reduce((n, r) => n + r.text.length, 0);
    let at = 0, put = false;
    for (const r of out) {
      const a = at, b = at + r.text.length; // (in this pass's coordinates, before the run changes)
      at = b;
      if (!put && start >= a && (start < b || start === total)) { r.text = r.text.slice(0, start - a) + rep + r.text.slice(Math.min(end, b) - a); put = true; }
      else if (end > a && start < b) r.text = r.text.slice(0, Math.max(start, a) - a) + r.text.slice(Math.min(end, b) - a);
    }
  }
  const kept = out.filter((r) => r.text);
  return kept.length ? kept : [{ ...out[0], text: '' }];
}

const getAt = (o, keys) => keys.reduce((x, k) => (x == null ? x : x[k]), o);
const setAt = (o, keys, v) => { const p = getAt(o, keys.slice(0, -1)); if (p != null) p[keys.at(-1)] = v; };
const sameField = (a, b) => a.slide === b.slide && a.path === b.path && a.fid === b.fid;

/**
 * The deck with matches replaced: `only` is one match from findMatches (Replace), or omitted for every match
 * (Replace All). Returns { deck, count }; the deck itself when nothing changed. Touched slides are re-cleaned
 * (deck-model.js normalizeSlide), so limits and layouts hold; a slide that would end up empty is left as it was.
 */
export function replaceMatches(deck, query, replacement, opts = {}, only = null) {
  const all = findMatches(deck, query, opts);
  const picked = only ? all.filter((m) => sameField(m, only) && m.nth === only.nth) : all;
  return replaceSpans(deck, picked, replacement);
}

/**
 * The deck with exact spans replaced: [{ slide, keys, path, start, end, text | word }] (from findMatches or spellIssues).
 * A span whose words are no longer there (the deck changed since) is skipped. Returns { deck, count }.
 */
export function replaceSpans(deck, spans, replacement) {
  const picked = (spans || []).filter((m) => { const v = deck.slides[m.slide] && plain(getAt(deck.slides[m.slide], m.keys)); const want = m.text ?? m.word; return typeof v === 'string' && m.end > m.start && (want === undefined || v.slice(m.start, m.end) === want); });
  if (!picked.length) return { deck, count: 0 };
  const d = JSON.parse(JSON.stringify(deck));
  const rep = String(replacement ?? '');
  const byField = new Map();
  for (const m of picked) { const k = `${m.slide}|${m.keys.join('.')}`; if (!byField.has(k)) byField.set(k, []); byField.get(k).push(m); }
  const touched = new Set();
  let count = 0;
  for (const ms of byField.values()) {
    const s = d.slides[ms[0].slide];
    const v = getAt(s, ms[0].keys);
    const spans = ms.map((m) => [m.start, m.end]);
    if (typeof v === 'string' || typeof v === 'number') {
      let str = String(v);
      for (const [a, b] of [...spans].sort((x, y) => y[0] - x[0])) str = str.slice(0, a) + rep + str.slice(b);
      setAt(s, ms[0].keys, str);
      // rich text (deck-rich.js): slide.fmt.runs[path] = [{ t, b, color… }] joined to the plain text; each match is
      // replaced inside its own run, so the styles around and between matches stay where they were
      const fr = ms[0].path && s.fmt && s.fmt.runs && s.fmt.runs[ms[0].path];
      if (Array.isArray(fr) && fr.map((r) => r.t).join('') === String(v)) {
        s.fmt.runs[ms[0].path] = replaceRuns(fr.map(({ t, ...r }) => ({ ...r, text: String(t) })), spans, rep).map(({ text, ...r }) => ({ ...r, t: text }));
      }
    } else if (isRuns(v)) {
      const runs = replaceRuns(runsOf(v), spans, rep);
      setAt(s, ms[0].keys, Array.isArray(v) ? runs : { ...v, runs });
    } else continue;
    touched.add(ms[0].slide);
    count += ms.length;
  }
  for (const i of touched) {
    const again = normalizeSlide(d.slides[i]);
    if (again) d.slides[i] = again; else { d.slides[i] = deck.slides[i]; count -= picked.filter((m) => m.slide === i).length; }
  }
  return count > 0 ? { deck: d, count } : { deck, count: 0 };
}

// ── spelling: the words to check ──

// Letters (any script) with inner apostrophes or hyphens; numbers, links, e-mail addresses and citation marks are skipped.
const SKIP = /\bhttps?:\/\/\S+|\bwww\.\S+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\[\d{1,3}(?:\s*,\s*\d{1,3})*\]/gu;
const WORDS = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;
/** The words of one text: [{ word, start, end }] (skipping acronyms, words with digits next to them, and one-letter words). */
export function wordsOf(text) {
  const s = String(text || '').replace(SKIP, (m) => ' '.repeat(m.length));
  const out = [];
  let m;
  WORDS.lastIndex = 0;
  while ((m = WORDS.exec(s))) {
    const w = m[0], a = m.index, b = a + w.length;
    if (w.length < 2 || /[\p{N}_]/u.test(s[a - 1] || '') || /[\p{N}_]/u.test(s[b] || '')) continue;
    if (w === w.toUpperCase() && w !== w.toLowerCase()) continue; // NASA, USD
    if (/\p{Ll}\p{Lu}/u.test(w) || (w.match(/\p{Lu}/gu) || []).length > 1) continue; // iPhone, PowerPoint: names; MWh, GHz: units
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u.test(w)) continue; // no spaces between words: nothing to check
    out.push({ word: w.replace(/’/g, "'"), start: a, end: b });
  }
  return out;
}

/**
 * Spelling issues, given a checker ({ correct(word) → bool }) and the words to let pass (`skip`, lower case: the
 * person's dictionary and ignored words): [{ slide, path, fid, label, start, end, word, nth }], `nth` counting
 * that word within its field (as findMatches does with whole words and case kept).
 */
export function spellIssues(deck, checker, { skip = new Set(), notes = true } = {}) {
  const out = [];
  const verdict = new Map();
  for (const f of deckFields(deck, { notes, alt: true })) {
    const seen = new Map();
    for (const w of wordsOf(f.text)) {
      const nth = seen.get(w.word) || 0;
      seen.set(w.word, nth + 1);
      const low = w.word.toLowerCase();
      if (skip.has(low)) continue;
      if (!verdict.has(w.word)) verdict.set(w.word, !!checker.correct(w.word)); // (the checker handles capitals: nspell knows 'Growth' from 'growth')
      if (!verdict.get(w.word)) out.push({ slide: f.slide, path: f.path, fid: f.fid, keys: f.keys, label: f.label, start: w.start, end: w.end, word: w.word, text: f.text.slice(w.start, w.end), nth });
    }
  }
  return out;
}

/** The dictionary for a deck's language: 'en', 'fr' or 'es' (the open word lists Eden ships), else '' (the browser's own check only). */
export const SPELL_LANGS = ['en', 'fr', 'es'];
export const spellLang = (lang) => { const l = String(lang || 'en').toLowerCase().split('-')[0]; return SPELL_LANGS.includes(l) ? l : ''; };
