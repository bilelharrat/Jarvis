// Interrupting J.A.R.V.I.S. by talking over him (voice.js Talk, tutor.js). The mic's level alone
// rarely works: while the voice plays, the browser's echo cancelling turns the mic right down, your
// voice included. So while he speaks, speech recognition listens too, and words that aren't his
// (the echo that gets through is his own words) stop him; what you said starts your turn.

// the page's speech language from i18n.js (no import: the tests load this file alone)
const speechLang = () => (globalThis.edenI18n ? globalThis.edenI18n.speechLang() : (globalThis.navigator && navigator.language) || 'en-US');

const Recognition = () => window.SpeechRecognition || window.webkitSpeechRecognition || null;

const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}\s']/gu, ' ').split(/\s+/).filter(Boolean);

/** Did the recognizer hear you, not his voice coming back through the mic? */
export function heardYou(heard, spoken) {
  const his = new Set(words(spoken));
  const w = words(heard);
  const yours = w.filter((x) => !his.has(x));
  return yours.length >= 2 && yours.length / w.length >= 0.5;
}

/**
 * Listens while J.A.R.V.I.S. speaks; `spoken()` is what he's saying, `onInterrupt(heard)` runs once
 * when you talk over him. Returns stop(). No recognition here: a no-op (the mic level still works).
 */
export function watchForInterrupt({ spoken, onInterrupt, lang }) {
  const R = Recognition();
  if (!R) return () => {};
  let on = true, rec = null, fails = 0, timer = 0;
  const start = () => {
    if (!on) return;
    const r = new R();
    r.lang = lang || speechLang();
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      if (!on || rec !== r) return;
      fails = 0;
      let heard = '';
      for (const x of e.results) heard += x[0].transcript;
      if (heardYou(heard, spoken())) { stop(); onInterrupt(heard.replace(/\s+/g, ' ').trim()); }
    };
    r.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') on = false; else fails++; };
    r.onend = () => { if (on && rec === r && fails < 5) timer = setTimeout(start, 150); }; // it ends itself after a quiet while
    rec = r;
    try { r.start(); } catch { fails++; }
  };
  const stop = () => {
    on = false;
    clearTimeout(timer);
    const r = rec;
    rec = null;
    if (r) { try { r.abort(); } catch { /* ended */ } }
  };
  start();
  return stop;
}

/** Space (outside a text field) interrupts, like tapping the orb. */
export const isSpaceToInterrupt = (e) => e.key === ' ' && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.target && e.target.closest && e.target.closest('input, textarea, [contenteditable="true"], select'));
