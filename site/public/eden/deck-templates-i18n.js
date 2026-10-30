// Eden Slides templates in other languages (web only). Each language is its own file, `deck-templates-<lang>.js`,
// loaded only when someone picks it: { lang, ui: { gallery string: … }, t: { English text: translation } }. The
// translations were written by hand; a pack is a dictionary over the English copy, so a translated template keeps the
// English one's structure, numbers and chart data exactly (src/__tests__/deck-templates.test.ts checks every pack).
// The text fields are the ones deck-translate.js's deckStrings walks, plus a chart's source line.

import { deckStrings, dirOf } from './deck-translate.js';

/** The languages templates come in: [code, name in that language]. */
export const TEMPLATE_LANGS = [['en', 'English'], ['fr', 'Français'], ['es', 'Español'], ['de', 'Deutsch'], ['pt', 'Português'], ['it', 'Italiano'], ['ar', 'العربية'], ['ja', '日本語']];
export const templateLang = (v) => { const base = String(v || '').toLowerCase().split('-')[0]; return TEMPLATE_LANGS.some(([c]) => c === base) ? base : 'en'; };
export { dirOf };

const packs = new Map();
/** The pack for `lang` (null for English); loaded once. A failed load is tried again next time. */
export function loadTemplateLang(lang) {
  const l = templateLang(lang);
  if (l === 'en') return Promise.resolve(null);
  if (!packs.has(l)) packs.set(l, import(`./deck-templates-${l}.js`).then((m) => m.default, (e) => { packs.delete(l); throw e; }));
  return packs.get(l);
}

/** One string in the pack's language (the English when the pack has none, or for English). */
export const tl = (s, pack) => (pack && typeof s === 'string' && Object.prototype.hasOwnProperty.call(pack.t, s) ? pack.t[s] : s);

/** A cleaned deck in the pack's language, marked with it (`lang`: the slide frame reads Arabic right to left). */
export function localizeDeck(deck, pack) {
  if (!pack) return deck;
  const d = JSON.parse(JSON.stringify(deck));
  for (const { path, text } of deckStrings(d)) {
    let o = d;
    for (const k of path.slice(0, -1)) o = o[k];
    o[path.at(-1)] = tl(text, pack);
  }
  for (const s of d.slides) if (s.chart && s.chart.source) s.chart.source = tl(s.chart.source, pack);
  d.lang = pack.lang;
  return d;
}

/**
 * Whether `pack` translates every text of template `t` (a deck template, or a single slide: { name, slide }). A language
 * that hasn't caught up with newer templates shows those in English, labelled, never half translated.
 */
export function covers(t, pack, normalize) {
  if (!pack) return true;
  const has = (s) => typeof s !== 'string' || !/\p{L}/u.test(s) || Object.prototype.hasOwnProperty.call(pack.t, s);
  const deck = normalize(t.deck || { title: t.name, slides: [t.slide] });
  if (!deck) return false;
  const texts = [t.name, t.description, t.category, ...deckStrings(deck).filter((x) => t.deck || x.path[0] !== 'title').map((x) => x.text), ...deck.slides.map((s) => s.chart && s.chart.source)];
  return texts.every(has);
}
