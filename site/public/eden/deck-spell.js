// Spell check in Eden Slides (web only). Two layers:
//   - while typing, the browser's own spell check, in the slide's language (deck-find-frame.js turns it on for
//     every editable piece; a translated deck's slides carry their `lang`);
//   - Eden's own pass over every slide's words with open Hunspell word lists (English, French, Spanish: nspell in a
//     worker, deck-spell-worker.js), which underlines misspellings in the frame (wavy red) and lists them per slide
//     in "Check spelling" with suggestions, Ignore and Add to dictionary.
// Ignored words are kept per deck and the person's dictionary per language, both on this device (localStorage).
// A deck in another language gets the browser's check only, and the section says so. Nothing leaves the device.
// UI: the Document tab's "Spelling" section and the File menu (deck-shell.js contract).

import { el } from './util.js';
import { t as tx } from './i18n.js';
import { IN_APP } from './native.js';
import { registerInspector, registerContextMenu, context, kit, icon } from './deck-shell.js';
import { deckFields, wordsOf, spellIssues, spellLang, replaceSpans } from './deck-find-model.js';
import { featureCss } from './deck-find.js';

const NAMES = { en: 'English', fr: 'French', es: 'Spanish' };
const store = {
  get(k, d) { try { const v = localStorage.getItem(`eden-slides:spell:${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`eden-slides:spell:${k}`, JSON.stringify(v)); } catch { /* private window: this visit only */ } },
};
export const underlineOn = () => store.get('underline', true) !== false;
const words = (lang) => new Set(store.get(`words:${lang}`, []));
const ignoredKey = (ctx) => `ignore:${(ctx.conv && ctx.conv.id) || 'deck'}`;
const ignored = (ctx) => new Set(store.get(ignoredKey(ctx), []));
const addTo = (key, w) => { const s = new Set(store.get(key, [])); s.add(w.toLowerCase()); store.set(key, [...s].slice(-2000)); };

// ── the checker: a module worker, or the same code on the page where a worker can't start ──
let worker = null, seq = 0;
const waiting = new Map();
function viaWorker(msg) {
  if (worker === false) return null;
  try {
    if (!worker) {
      worker = new Worker(new URL('./deck-spell-worker.js', import.meta.url), { type: 'module' });
      worker.addEventListener('message', (e) => { const w = waiting.get(e.data && e.data.id); if (w) { waiting.delete(e.data.id); if (e.data.error) w.reject(new Error(e.data.error)); else w.resolve(e.data); } });
      worker.addEventListener('error', () => { worker = false; for (const w of waiting.values()) w.fallback(); waiting.clear(); });
    }
  } catch { worker = false; return null; }
  const id = ++seq;
  return new Promise((resolve, reject) => { waiting.set(id, { resolve, reject, fallback: () => onPage(msg).then(resolve, reject) }); worker.postMessage({ id, ...msg }); });
}
async function onPage({ lang, words: list, suggest }) {
  const W = await import('./deck-spell-worker.js');
  return W.checkWords(await W.engine(lang, W.fetchText), list, { suggest });
}
const check = (msg) => viaWorker(msg) || onPage(msg);

/** Spell-check the deck: { lang, supported, issues: [...with suggestions] }. */
export async function checkDeck(deck, ctx, { suggest = 80 } = {}) {
  const lang = spellLang(deck.lang);
  if (!lang) return { lang: deck.lang || '', supported: false, issues: [] };
  const all = [...new Set(deckFields(deck).flatMap((f) => wordsOf(f.text).map((w) => w.word)))];
  const { bad, sugg } = await check({ lang, words: all, suggest });
  const wrong = new Set(bad);
  const skip = new Set([...words(lang), ...ignored(ctx)]);
  const issues = spellIssues(deck, { correct: (w) => !wrong.has(w) }, { skip }).map((x) => ({ ...x, suggestions: sugg[x.word] || [] }));
  return { lang, supported: true, issues };
}

// ── underlines in the frame ──
let lastKey = '', timer = 0, latest = null;
const markOf = (x) => ({ index: x.slide, ...(x.fid ? { fid: x.fid } : { path: x.path }), start: x.start, end: x.end, text: x.text });
export function underline(ctx = context(), { force = false } = {}) { // (exported for the QA harness, research_notes/slides-qa/qa-find)
  clearTimeout(timer);
  timer = setTimeout(async () => {
    const deck = ctx.currentDeck && ctx.currentDeck();
    if (!deck || !underlineOn()) { ctx.post({ type: 'deck-marks', spell: [] }); return; }
    const key = JSON.stringify([deck.lang, deck.slides, [...ignored(ctx)].length, [...words(spellLang(deck.lang) || 'x')].length]);
    if (key === lastKey && latest && !force) { ctx.post({ type: 'deck-marks', spell: latest.issues.map(markOf) }); return; }
    try {
      const r = await checkDeck(deck, ctx, { suggest: 0 });
      lastKey = key; latest = r;
      ctx.post({ type: 'deck-marks', spell: r.issues.map(markOf) });
    } catch { /* no word list (offline): the browser's own check still runs while typing */ }
  }, force ? 0 : 400);
}

// ── "Check spelling": the issues per slide ──
export async function openSpelling(ctx = context()) {
  if (IN_APP) return;
  featureCss();
  const deck = ctx.currentDeck();
  if (!deck) return;
  const list = el('div', { class: 'dspell-list', role: 'list', 'aria-busy': 'true' }, el('p', { class: 'dspell-done' }, tx('Checking…')));
  const head = el('p', { class: 'dspell-note', role: 'status' });
  const { close } = kit.sheet({ title: tx('Check spelling'), content: el('div', { class: 'dspell-sec' }, head, list), actions: [kit.button({ label: tx('Done'), primary: true, onClick: () => close() })], wide: true });
  let current = -1;
  const draw = async () => {
    const d = ctx.currentDeck();
    let r;
    try { r = await checkDeck(d, ctx); } catch (e) { list.replaceChildren(el('p', { class: 'dspell-done' }, tx(`Couldn’t load the word list: ${e.message}. Try again when you’re online.`))); list.removeAttribute('aria-busy'); return; }
    list.removeAttribute('aria-busy');
    if (!r.supported) { head.textContent = tx('Eden has no word list for this deck’s language yet. Your browser still underlines misspellings while you type in a slide.'); list.replaceChildren(); return; }
    head.textContent = r.issues.length ? tx(`${r.issues.length} possible misspellings · ${NAMES[r.lang]}`) : '';
    if (!r.issues.length) { list.replaceChildren(el('p', { class: 'dspell-done' }, tx('No spelling issues found.'))); return; }
    const by = new Map();
    r.issues.forEach((x, i) => { if (!by.has(x.slide)) by.set(x.slide, []); by.get(x.slide).push([x, i]); });
    list.replaceChildren(...[...by].map(([slide, items]) => el('section', { class: 'dspell-slide', role: 'listitem' }, el('h3', '', tx(`Slide ${slide + 1}`)),
      ...items.map(([x, i]) => {
        const f = deckFields(d).find((y) => y.slide === x.slide && y.keys.join('.') === x.keys.join('.'));
        const t = f ? f.text : x.text;
        const fix = (word) => { const res = replaceSpans(ctx.currentDeck(), [x], word); if (res.count) { ctx.commit(res.deck, { toastText: tx(`Changed to “${word}”`) }); setTimeout(draw, 350); } };
        const item = el('div', { class: 'dspell-item', 'aria-current': String(i === current) },
          el('p', { class: 'dspell-ctx' }, el('span', { class: 'sr-only' }, `${tx(x.label)}: `), t.slice(Math.max(0, x.start - 40), x.start), el('mark', '', t.slice(x.start, x.end)), t.slice(x.end, x.end + 40)),
          el('div', { class: 'dspell-acts' },
            ...(x.suggestions.length ? x.suggestions.map((s) => el('button', { type: 'button', class: 'dfind-btn dspell-sugg', 'aria-label': tx(`Change to ${s}`), onclick: () => fix(s) }, s)) : [el('span', { class: 'dspell-note' }, tx('No suggestions'))]),
            el('button', { type: 'button', class: 'dfind-btn', onclick: () => { current = i; ctx.post({ type: 'deck-marks', find: [markOf(x)], cur: 0, go: true }); list.querySelectorAll('.dspell-item').forEach((n) => n.setAttribute('aria-current', 'false')); item.setAttribute('aria-current', 'true'); } }, tx('Show')),
            el('button', { type: 'button', class: 'dfind-btn', title: tx('Skip this word in this deck, on this device'), onclick: () => { addTo(ignoredKey(ctx), x.word); underline(ctx, { force: true }); draw(); } }, tx('Ignore')),
            el('button', { type: 'button', class: 'dfind-btn', title: tx('Accept this word in every deck, on this device'), onclick: () => { addTo(`words:${r.lang}`, x.word); underline(ctx, { force: true }); draw(); } }, tx('Add to dictionary'))));
        return item;
      }))));
  };
  draw();
  // the Show highlight goes when the sheet does
  const d = list.closest('dialog');
  if (d) d.addEventListener('close', () => ctx.post({ type: 'deck-marks', find: [], cur: -1 }));
}

function section(ctx) {
  featureCss();
  const deck = ctx.deck;
  if (!deck) return null;
  const lang = spellLang(deck.lang);
  const mine = lang ? [...words(lang)] : [];
  const listEl = mine.length ? el('ul', { class: 'dspell-words', 'aria-label': tx('Your dictionary') }, ...mine.slice(0, 60).map((w) => el('li', '', w,
    el('button', { type: 'button', 'aria-label': tx(`Remove ${w} from your dictionary`), 'data-key': `spell-rm:${w}`, onclick: () => { store.set(`words:${lang}`, mine.filter((x) => x !== w)); underline(ctx, { force: true }); ctx.refresh(); } }, icon('close', 12))))) : null;
  return el('div', { class: 'dspell-sec' },
    kit.button({ label: tx('Check spelling…'), icon: 'check', key: 'spell-check', onClick: () => openSpelling(ctx) }),
    kit.segmented({ label: tx('Underline misspellings'), key: 'spell-underline', value: underlineOn() ? 'on' : 'off', options: [{ value: 'on', label: tx('Underline') }, { value: 'off', label: tx('Off') }],
      onChange: (v) => { store.set('underline', v === 'on'); underline(ctx, { force: true }); } }),
    el('p', { class: 'dspell-note' }, lang ? tx(`Checking in ${NAMES[lang]} with an open word list, on this device.`) : tx('Eden has no word list for this deck’s language yet; your browser underlines misspellings while you type.')),
    listEl ? el('p', { class: 'dspell-note' }, tx('Your dictionary (this device):')) : null, listEl);
}

if (!IN_APP && typeof addEventListener === 'function') {
  registerInspector({ id: 'spelling', tab: 'document', title: 'Spelling', icon: 'check', order: 70, render: (ctx) => section(ctx) });
  registerContextMenu({ id: 'spelling', target: 'file', order: 16, items: (ctx) => [{ label: tx('Check spelling…'), icon: 'check', run: () => openSpelling(ctx) }] });
  // each redraw of the frame (an edit, a new version, opening a deck) gets its underlines again
  addEventListener('message', (e) => {
    const ctx = context();
    const f = ctx.frame && ctx.frame();
    if (f && e.source === f.contentWindow && e.data && e.data.type === 'deck-ready') underline(ctx);
  });
}
