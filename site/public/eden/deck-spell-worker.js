// Spell check off the main thread (web only): nspell with the open Hunspell word lists Eden ships
// (deck-dict-<lang>-aff.txt / -dic.txt, licences in deck-dict-licenses.txt), each fetched from Eden's own
// origin the first time its language is checked. Started as a module worker by deck-spell.js; the same
// `checkWords` runs on the page where workers can't start. Nothing leaves the device.

import nspell from './deck-spell-nspell.min.mjs';

const engines = new Map();
/** The checker for a language ('en', 'fr', 'es'), loaded once. `load(url)` → the file's text. */
export function engine(lang, load) {
  if (!engines.has(lang)) {
    const p = Promise.all(['aff', 'dic'].map((x) => load(new URL(`./deck-dict-${lang}-${x}.txt`, import.meta.url).href))).then(([aff, dic]) => nspell(aff, dic));
    p.catch(() => engines.delete(lang)); // offline: tried again next time
    engines.set(lang, p);
  }
  return engines.get(lang);
}
/** Which words are wrong, and up to five suggestions for the first `suggest` of them: { bad: [...], sugg: { word: [...] } }. */
export function checkWords(sp, words, { suggest = 80 } = {}) {
  const bad = [...new Set(words)].filter((w) => typeof w === 'string' && w.length < 60 && !sp.correct(w) && !(w !== w.toLowerCase() && sp.correct(w.toLowerCase())));
  const sugg = {};
  for (const w of bad.slice(0, suggest)) sugg[w] = sp.suggest(w).slice(0, 5);
  return { bad, sugg };
}
export const fetchText = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`word list ${r.status}`); return r.text(); };

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  self.addEventListener('message', async (e) => {
    const { id, lang, words, suggest } = e.data || {};
    try { self.postMessage({ id, ...checkWords(await engine(lang, fetchText), Array.isArray(words) ? words.slice(0, 20000) : [], { suggest }) }); }
    catch (err) { self.postMessage({ id, error: String((err && err.message) || err) }); }
  });
}
