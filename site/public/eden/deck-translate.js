// One-click Translate (web only): every word a slide shows — titles, bullets, cards, captions,
// takeaways, table cells, chart labels and series names, diagram boxes, stats labels, alt text and
// speaker notes — sent to a model as a JSON list and put back in place, as a new deck version
// (undoable, deck.js commit). Numbers, links, e-mail addresses and citation marks never reach the
// model: each is swapped for a ⟦n⟧ marker first and put back after, and a translation that lost
// or invented a marker keeps the original text. Image ids, sources and the football playbook are
// left alone. The deck records its language (`deck.lang`); Arabic, Hebrew, Persian and Urdu draw
// right to left (deck-render.js, deck-resize.js). Pure down to `translateDeck`, which takes the
// model call as a function (src/__tests__/deck-resize.test.ts); `openTranslate` is the dialog.

import { normalizeDeck } from './deck-model.js';

export const LANGUAGES = [
  ['es', 'Spanish', 'Español'], ['fr', 'French', 'Français'], ['de', 'German', 'Deutsch'], ['it', 'Italian', 'Italiano'],
  ['pt', 'Portuguese', 'Português'], ['nl', 'Dutch', 'Nederlands'], ['pl', 'Polish', 'Polski'], ['sv', 'Swedish', 'Svenska'],
  ['tr', 'Turkish', 'Türkçe'], ['ru', 'Russian', 'Русский'], ['uk', 'Ukrainian', 'Українська'], ['ar', 'Arabic', 'العربية'],
  ['he', 'Hebrew', 'עברית'], ['fa', 'Persian', 'فارسی'], ['ur', 'Urdu', 'اردو'], ['hi', 'Hindi', 'हिन्दी'],
  ['zh', 'Chinese (Simplified)', '简体中文'], ['ja', 'Japanese', '日本語'], ['ko', 'Korean', '한국어'], ['vi', 'Vietnamese', 'Tiếng Việt'],
  ['id', 'Indonesian', 'Bahasa Indonesia'], ['en', 'English', 'English'],
];
const RTL = new Set(['ar', 'he', 'fa', 'ur', 'yi', 'ps', 'sd', 'dv', 'ku']);
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
/** A language code Eden keeps on a deck ('' when it isn't one). */
export const langCode = (v) => (typeof v === 'string' && LANG_RE.test(v.trim()) ? v.trim() : '');
/** 'rtl' for a right-to-left language, else 'ltr'. */
export const dirOf = (lang) => (RTL.has(langCode(lang).split('-')[0].toLowerCase()) ? 'rtl' : 'ltr');
export const languageName = (code) => (LANGUAGES.find((l) => l[0] === code) || [code, code])[1];

// the room each field has (deck-model.js normalizeSlide's limits)
const LIMIT = { title: 160, subtitle: 320, kicker: 60, takeaway: 220, caption: 320, alt: 300, quote: 600, by: 120, notes: 3000, bullet: 320, heading: 80, colHeading: 160, badge: 36, cell: 160, head: 80, chartLabel: 60, series: 60, dLabel: 80, dDetail: 140, child: 60, statLabel: 80, statValue: 16, delta: 32, deckTitle: 160 };
const LETTERS = /\p{L}/u;
const WORDY = /\p{L}{3,}/u;

/** Every string worth translating: [{ path: [...keys], text, max }]. `notes: false` leaves speaker notes out. */
export function deckStrings(deck, { notes = true } = {}) {
  const out = [];
  const add = (path, v, max, test = LETTERS) => { if (typeof v === 'string' && v.trim() && test.test(v)) out.push({ path, text: v, max }); };
  const bullets = (path, list) => (list || []).forEach((b, i) => {
    if (typeof b === 'string') add([...path, i], b, LIMIT.bullet);
    else if (b) { add([...path, i, 'text'], b.text, LIMIT.bullet); (b.sub || []).forEach((x, j) => add([...path, i, 'sub', j], x, LIMIT.bullet)); }
  });
  add(['title'], deck.title, LIMIT.deckTitle);
  deck.slides.forEach((s, k) => {
    const P = (...p) => ['slides', k, ...p];
    for (const f of ['kicker', 'title', 'subtitle', 'takeaway', 'caption', 'alt', 'quote', 'by']) add(P(f), s[f], LIMIT[f]);
    if (notes) add(P('notes'), s.notes, LIMIT.notes);
    bullets(P('bullets'), s.bullets);
    for (const side of ['left', 'right']) if (s[side]) { add(P(side, 'heading'), s[side].heading, LIMIT.colHeading); bullets(P(side, 'bullets'), s[side].bullets); }
    (s.cards || []).forEach((c, i) => { add(P('cards', i, 'heading'), c.heading, LIMIT.heading); add(P('cards', i, 'badge'), c.badge, LIMIT.badge, WORDY); bullets(P('cards', i, 'bullets'), c.bullets); });
    if (s.table) {
      s.table.header.forEach((h, i) => add(P('table', 'header', i), h, LIMIT.head));
      s.table.rows.forEach((r, ri) => r.forEach((c, ci) => add(P('table', 'rows', ri, ci), c, LIMIT.cell)));
    }
    if (s.chart) {
      s.chart.labels.forEach((l, i) => add(P('chart', 'labels', i), l, LIMIT.chartLabel, WORDY));
      s.chart.series.forEach((x, i) => add(P('chart', 'series', i, 'name'), x.name, LIMIT.series, WORDY));
    }
    if (s.diagram) s.diagram.items.forEach((it, i) => {
      add(P('diagram', 'items', i, 'label'), it.label, LIMIT.dLabel);
      add(P('diagram', 'items', i, 'detail'), it.detail, LIMIT.dDetail);
      (it.children || []).forEach((c, j) => add(P('diagram', 'items', i, 'children', j), c, LIMIT.child));
    });
    (s.stats || []).forEach((x, i) => { add(P('stats', i, 'label'), x.label, LIMIT.statLabel); add(P('stats', i, 'value'), x.value, LIMIT.statValue, WORDY); add(P('stats', i, 'delta'), x.delta, LIMIT.delta, WORDY); });
  });
  return out;
}

// what the model never sees: links, e-mail addresses, citation marks and numbers
const PROTECT = /\bhttps?:\/\/[^\s<>"]+|\bwww\.[^\s<>"]+\.[^\s<>"]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\[\d{1,3}\]|\d+(?:[.,:/]\d+)*/g;
/** Text with its protected parts swapped for ⟦n⟧ markers: { text, kept: [...] } */
export function mask(s) {
  const kept = [];
  const text = String(s).replace(PROTECT, (m) => `⟦${kept.push(m) - 1}⟧`);
  return { text, kept };
}
/** A translation with its markers put back; null when one is missing, repeated or unknown (the caller keeps the original). */
export function unmask(s, kept) {
  if (typeof s !== 'string') return null;
  const seen = new Array(kept.length).fill(0);
  let bad = false;
  const out = s.replace(/⟦\s*(\d+)\s*⟧/g, (_, d) => { const i = Number(d); if (i >= kept.length) { bad = true; return ''; } seen[i]++; return kept[i]; });
  if (bad || seen.some((c) => c !== 1) || /[⟦⟧]/.test(out)) return null;
  return out;
}
/** Text cut to `max` at a word where it can be (never splitting a surrogate pair). */
export function fit(s, max) {
  const str = String(s).replace(/\s+$/, '');
  if (str.length <= max) return str;
  let cut = str.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const sp = cut.lastIndexOf(' ');
  if (sp > max * 0.6) cut = cut.slice(0, sp);
  return `${cut.replace(/[\s,;:.–—-]+$/, '')}…`;
}

const getAt = (o, path) => path.reduce((x, k) => (x == null ? x : x[k]), o);
const setAt = (o, path, v) => { const last = path.at(-1); const parent = getAt(o, path.slice(0, -1)); if (parent != null) parent[last] = v; };

/** The model's instructions for one batch. */
export function translatePrompt(language, count) {
  return [
    `You translate the text of presentation slides into ${language}.`,
    `The user message is a JSON array of ${count} strings. Reply with ONLY a JSON array of exactly ${count} strings: each one's translation, in the same order. No commentary, no code fence.`,
    'Copy every marker like ⟦0⟧ exactly as written, once each: they stand for numbers, links and citations.',
    'Keep each translation about as short as the original: slides have little room. Keep line breaks. Keep names of people, brands and products as they are.',
    'If a string is already in the target language, or is a name or code, return it unchanged.',
  ].join('\n');
}
/** A JSON array of strings from a model's reply, or null. */
export function parseList(reply, count) {
  const s = String(reply || '');
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a < 0 || b <= a) return null;
  try {
    const v = JSON.parse(s.slice(a, b + 1));
    return Array.isArray(v) && v.length === count && v.every((x) => typeof x === 'string') ? v : null;
  } catch { return null; }
}
/** Batches of strings small enough for one quick reply. */
function batches(items, maxChars = 3500, maxItems = 60) {
  const out = [];
  let cur = [], size = 0;
  for (const it of items) {
    if (cur.length && (size + it.text.length > maxChars || cur.length >= maxItems)) { out.push(cur); cur = []; size = 0; }
    cur.push(it); size += it.text.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * The deck in another language. call(system, userText, signal) → Promise<reply text>.
 * → { deck, translated, kept, failed } (kept: strings whose markers didn't survive, left as they were;
 * failed: strings in batches the model didn't answer properly). Throws when nothing could be translated.
 */
export async function translateDeck(deck, lang, { call, notes = true, signal, onProgress = () => {}, language = languageName(lang) } = {}) {
  const code = langCode(lang);
  if (!code) throw new Error('Pick a language.');
  const items = deckStrings(deck, { notes });
  const copy = JSON.parse(JSON.stringify(deck));
  let translated = 0, kept = 0, failed = 0;
  const groups = batches(items.map((it) => ({ ...it, m: mask(it.text) })).map((it) => ({ ...it, text: it.m.text })));
  for (let g = 0; g < groups.length; g++) {
    if (signal && signal.aborted) throw Object.assign(new Error('Stopped.'), { name: 'AbortError' });
    onProgress(g + 1, groups.length);
    const group = groups[g];
    const input = group.map((it) => it.text);
    let list = null;
    for (let attempt = 0; attempt < 2 && !list; attempt++) { // one more try for a reply that wasn't a clean list
      try { list = parseList(await call(translatePrompt(language, input.length), JSON.stringify(input), signal), input.length); } catch (e) { if (e && e.name === 'AbortError') throw e; if (attempt) throw e; }
    }
    if (!list) { failed += group.length; continue; }
    group.forEach((it, i) => {
      const back = unmask(list[i], it.m.kept);
      if (back === null || !back.trim()) { kept++; return; }
      setAt(copy, it.path, fit(back, it.max));
      translated++;
    });
  }
  if (items.length && !translated) throw new Error('The translation didn’t come back. Try again.');
  const r = normalizeDeck({ ...copy, lang: code });
  if (!r.deck) throw new Error(r.error || 'The translated deck isn’t valid.');
  return { deck: { ...r.deck, lang: code }, translated, kept, failed };
}

/** The model call through Eden's own chat stream (a quick, cheap route; nothing is added to the chat). */
export async function modelCall(system, user, signal) {
  const [{ api }, { routeSettings }] = await Promise.all([import('./api.js'), import('./router.js')]);
  let text = '', error = '';
  await api.send({ messages: [{ role: 'user', content: user }], system, settings: { ...routeSettings(), level: 1 }, mode: 'chat', deck: false, deckJob: true, temporary: true }, {
    signal,
    onEvent: (type, d) => { if (type === 'text') text += (d && d.text) || ''; else if (type === 'error') error = (d && d.message) || 'The model call failed.'; },
  });
  if (error && !text) throw new Error(error);
  return text;
}

const CSS = `
.dtr-dialog{margin:auto;border:0;border-radius:20px;padding:0;width:min(420px,92vw);height:fit-content;max-height:92dvh;overflow:auto;color:var(--text);background:var(--content);font:15px/1.35 -apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue",sans-serif;box-shadow:0 2px 6px rgba(0,0,0,.08),0 24px 64px rgba(0,0,0,.16)}
.dtr-dialog::backdrop{background:rgba(0,0,0,.3)}
.dtr-dialog *{font-family:inherit}
.dtr-body{display:flex;flex-direction:column;gap:12px;padding:20px}
.dtr-body>*{flex:none}
.dtr-body h3{margin:0;font-size:17px;font-weight:600}
.dtr-body p{margin:0;font-size:13px;color:var(--text2)}
.dtr-body label{display:flex;gap:8px;align-items:center;font-size:13.5px}
.dtr-body select{min-height:40px;border:0;border-radius:9px;padding:0 10px;background:var(--content2);box-shadow:inset 0 0 0 1px var(--hairline);font:inherit;color:var(--text)}
.dtr-acts{display:flex;gap:8px;justify-content:flex-end;align-items:center}
.dtr-acts .btn{min-height:40px}
.dtr-status{margin-right:auto;font-size:12.5px;color:var(--text2)}
`;
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (v == null || v === false) continue; if (k === 'text') e.textContent = v; else e.setAttribute(k, v === true ? '' : v); }
  e.append(...kids.filter((x) => x != null));
  return e;
};

/**
 * The Translate dialog (web only; deck.js opens it from the More tray).
 * ctx: { deck, commit(deck, toastText), tx(text), toast(text), returnFocus }
 */
export function openTranslate(ctx) {
  if (!document.getElementById('deckTranslateCss')) document.head.append(Object.assign(document.createElement('style'), { id: 'deckTranslateCss', textContent: CSS }));
  const tx = ctx.tx || ((s) => s);
  const here = langCode((navigator.language || '').split('-')[0]);
  const sel = h('select', { id: 'dtLang', 'aria-label': tx('Language') }, ...LANGUAGES.filter((l) => l[0] !== (ctx.deck.lang || '')).map(([code, name, own]) => h('option', { value: code, selected: code === (here && here !== 'en' && here !== ctx.deck.lang ? here : 'es') }, `${tx(name)}${own !== name ? ` · ${own}` : ''}`)));
  const notes = h('input', { type: 'checkbox', id: 'dtNotes', checked: true });
  const status = h('span', { class: 'dtr-status', role: 'status' });
  const go = h('button', { type: 'button', class: 'btn primary' }, tx('Translate'));
  const cancel = h('button', { type: 'button', class: 'btn' }, tx('Cancel'));
  const dlg = h('dialog', { class: 'dtr-dialog', 'aria-labelledby': 'dtTitle' },
    h('div', { class: 'dtr-body' }, h('h3', { id: 'dtTitle', text: tx('Translate the deck') }),
      h('p', { text: tx('Every slide’s words, as a new version you can undo. Numbers, links and pictures stay as they are.') }),
      h('label', { for: 'dtLang' }, tx('Into'), sel), h('label', {}, notes, tx('Speaker notes too')),
      h('div', { class: 'dtr-acts' }, status, cancel, go)));
  let ctl = null;
  cancel.addEventListener('click', () => { if (ctl) ctl.abort(); dlg.close(); });
  dlg.addEventListener('close', () => { if (ctl) ctl.abort(); dlg.remove(); if (ctx.returnFocus) ctx.returnFocus.focus(); });
  dlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') e.stopPropagation(); }, true); // the dialog closes, not the canvas
  go.addEventListener('click', async () => {
    if (ctl) return;
    ctl = new AbortController();
    go.disabled = true; sel.disabled = true; notes.disabled = true;
    const code = sel.value;
    try {
      const r = await translateDeck(ctx.deck, code, { call: ctx.call || modelCall, notes: notes.checked, signal: ctl.signal, onProgress: (k, n) => { status.textContent = n > 1 ? `${tx('Translating')} ${k} / ${n}…` : `${tx('Translating')}…`; } });
      ctx.commit(r.deck, `${tx('Translated into')} ${tx(languageName(code))}${r.kept + r.failed ? ` · ${r.kept + r.failed} ${tx('kept as they were')}` : ''}`);
      ctl = null;
      dlg.close();
    } catch (e) {
      ctl = null;
      if (e && e.name === 'AbortError') return;
      status.textContent = `${tx('Translation failed:')} ${e.message}`;
      go.disabled = false; sel.disabled = false; notes.disabled = false;
    }
  });
  document.body.append(dlg);
  dlg.showModal();
  sel.focus();
  return dlg;
}
