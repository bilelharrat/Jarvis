// Eden's languages: English (the source text in every module) and French.
//
// app.js and edu-app.js import this first. When French is on it loads the French strings
// (i18n-fr.js, which gathers the i18n-fr-*.js files) and translates the page as it's drawn:
// every text node and the attributes people read (placeholder, title, aria-label…), now and
// whenever a module adds or changes them (a MutationObserver), plus alert/confirm/prompt and
// the tab title. The modules keep writing English; nothing in them has to change, except:
//   - text that's the person's own (messages, mail, notes) sits inside SKIP or [data-no-i18n],
//     so a message that happens to read "Send" stays as written;
//   - code never reads a label back to decide something (textContent === 'Pause'): use a
//     data- attribute for that, since the label may be French;
//   - dates and speech use locale() / speechLang() from here, not navigator.language.
// English costs nothing: the French file is only fetched when French is on.
//
// The choice: localStorage "eden:lang" = "en" | "fr" | absent (follow the browser). It's read
// before practice.js scopes storage, so it's the same in the tour.

export const LANGS = [['auto', 'Automatic'], ['en', 'English'], ['fr', 'Français']];
const KEY = 'eden:lang';

function readPref() {
  try { const v = globalThis.localStorage && localStorage.getItem(KEY); return v === 'en' || v === 'fr' ? v : 'auto'; } catch { return 'auto'; }
}
function browserLang() {
  const nav = globalThis.navigator;
  const list = nav ? (nav.languages && nav.languages.length ? nav.languages : [nav.language]) : [];
  for (const l of list) {
    const p = String(l || '').toLowerCase().slice(0, 2);
    if (p === 'fr') return 'fr';
    if (p === 'en') return 'en';
  }
  return 'en';
}

/** 'auto' | 'en' | 'fr': what the person picked in Settings. */
export const langPref = readPref();
/** 'en' | 'fr': the language the page is in. ?lang=fr|en in the address wins (for links and tests). */
export const lang = (() => {
  try { const q = new URLSearchParams(globalThis.location ? location.search : '').get('lang'); if (q === 'fr' || q === 'en') return q; } catch { /* none */ }
  return langPref === 'auto' ? browserLang() : langPref;
})();
export const isFr = lang === 'fr';

/** The locale for Intl / toLocale*String: the browser's when it matches the page's language, else fr-FR / en-US. */
export function locale() {
  const nav = globalThis.navigator;
  const b = nav ? (nav.languages && nav.languages[0]) || nav.language || '' : '';
  if (b.toLowerCase().startsWith(lang)) return b;
  return isFr ? 'fr-FR' : 'en-US';
}
/** The language for speech recognition and speech synthesis. */
export const speechLang = () => locale();

/** Saves the choice and reloads, so every module draws in the new language. */
export function setLang(v) {
  try { if (v === 'en' || v === 'fr') localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch { /* private mode */ }
  location.reload();
}

/** The line added to the system prompt so Eden answers in the page's language. */
export function replyLanguageNote() {
  return isFr
    ? 'The person uses Eden in French. Reply in French (natural, idiomatic French; use "vous" unless they use "tu"), unless they write to you in another language or ask for one.'
    : '';
}

/** For prompts that answer in JSON (mail triage, digests): the words inside it in French, the shape unchanged. */
export function contentLanguageNote() {
  return isFr
    ? 'The person reads Eden in French: write every piece of text they will read (summaries, reasons, short labels you write) in French. Keep the JSON keys and any fixed values exactly as specified.'
    : '';
}

/* ---------- the dictionary ---------- */

const exact = new Map();
const patterns = [];
if (isFr) {
  try {
    const mod = await import('./i18n-fr.js');
    for (const part of mod.default || []) {
      for (const [k, v] of Object.entries(part.exact || {})) exact.set(k.trim().replace(/\s+/g, ' '), v);
      for (const p of part.patterns || []) patterns.push(p);
    }
  } catch (e) { console.warn('Eden: the French strings did not load', e); }
  // the most specific first, whichever file it came from: more literal text outranks a catch-all like /^Remove (.+)$/
  const literal = (re) => re.source.replace(/\\.|\[[^\]]*\]|\([^)]*\)|[.*+?^${}()|]/g, '').length;
  patterns.sort((a, b) => literal(b[0]) - literal(a[0]));
}

const memo = new Map();
const LETTER = /[A-Za-z]/;
/** The French for one English string (whole string, trimmed; its outer spaces are kept), or the string itself. */
export function t(s) {
  if (!isFr || typeof s !== 'string' || !LETTER.test(s)) return s;
  const hit = memo.get(s);
  if (hit !== undefined) return hit;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
  const out = m[1] + translateCore(m[2]) + m[3];
  if (memo.size > 5000) memo.clear();
  memo.set(s, out);
  return out;
}
function translateCore(raw) {
  const key = raw.replace(/\s+/g, ' '); // text from the HTML's indentation reads as one line
  const v = exact.get(key);
  if (v !== undefined) return v;
  for (const [re, rep] of patterns) {
    re.lastIndex = 0;
    if (re.test(key)) { re.lastIndex = 0; return key.replace(re, rep); }
  }
  // "Label:" / "Label…" / "Label." when only "Label" is listed
  const tail = /^(.*?)([:…．.!?]+)$/.exec(key);
  if (tail && tail[1]) { const w = exact.get(tail[1]); if (w !== undefined) return (tail[2] === ':' ? `${w}\u00a0:` : w + tail[2]); }
  return key;
}
/** For French patterns: translate a captured piece too (e.g. a label inside "Open {label}"). */
export const tr = (s) => translateCore(String(s));

// For the few modules that must stay import-free (their tests load them alone, as data: URLs):
// they read this when it's there and use English when it isn't.
globalThis.edenI18n = { t, locale, speechLang, isFr, lang };

/* ---------- the page ---------- */

const ATTRS = ['placeholder', 'title', 'aria-label', 'aria-description', 'aria-roledescription', 'aria-valuetext', 'alt', 'data-tip', 'data-tooltip', 'data-placeholder', 'label'];
// The person's own text and what the AI wrote: never translated.
export const SKIP = [
  'script', 'style', 'code', 'pre', 'textarea', 'kbd', 'samp', 'svg', 'iframe',
  '[contenteditable=""]', '[contenteditable="true"]', '[data-no-i18n]', '[translate="no"]',
  '.md', '.think-body', '.user-text', '.msg-text', '.mail-body', '.msg-user',
];
let SKIP_SEL = SKIP.join(',');
/** Modules can add their own user-content containers. */
export function skipSelector(sel) { SKIP.push(sel); SKIP_SEL = SKIP.join(','); }

const skipped = (elm) => !!(elm && elm.closest && elm.closest(SKIP_SEL));
// A text field's contents are the person's, but its placeholder and label are the page's.
const FIELD = 'textarea,input,[contenteditable=""],[contenteditable="true"]';
const OWN = '[data-no-i18n],[translate="no"]';
const fieldAttrs = (elm) => elm.matches(FIELD) && !elm.matches(OWN) && !(elm.parentElement && elm.parentElement.closest(SKIP_SEL));
const attrsOk = (elm) => !skipped(elm) || fieldAttrs(elm);

function doText(node) {
  const v = node.nodeValue;
  if (!v || !LETTER.test(v)) return;
  const p = node.parentElement;
  if (!p || skipped(p)) return;
  const out = t(v);
  if (out !== v) node.nodeValue = out;
}
function doAttrs(elm) {
  for (const a of ATTRS) {
    const v = elm.getAttribute(a);
    if (v && LETTER.test(v)) { const out = t(v); if (out !== v) elm.setAttribute(a, out); }
  }
  if (elm.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(elm.type) && elm.value) { const out = t(elm.value); if (out !== elm.value) elm.value = out; }
}
function walk(root) {
  if (root.nodeType === 3) { doText(root); return; }
  if (root.nodeType !== 1 && root.nodeType !== 11) return;
  if (root.nodeType === 1) {
    if (skipped(root)) { if (fieldAttrs(root)) doAttrs(root); return; }
    doAttrs(root);
  }
  const w = document.createTreeWalker(root, 5 /* SHOW_ELEMENT | SHOW_TEXT */, {
    acceptNode: (n) => {
      if (n.nodeType !== 1 || !n.matches(SKIP_SEL)) return 1;
      if (fieldAttrs(n)) doAttrs(n);
      return 2; // REJECT: skip the subtree
    },
  });
  let n = w.nextNode();
  while (n) {
    if (n.nodeType === 3) doText(n); else doAttrs(n);
    n = w.nextNode();
  }
}

/** Translates everything under root now (also done automatically for the document). */
export function translateTree(root) { if (isFr && root) walk(root); }

if (isFr && typeof document !== 'undefined') {
  document.documentElement.lang = 'fr';
  const start = () => {
    walk(document.body || document.documentElement);
    new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'childList') for (const n of m.addedNodes) walk(n);
        else if (m.type === 'characterData') doText(m.target);
        else if (m.type === 'attributes' && m.target.nodeType === 1 && attrsOk(m.target)) doAttrs(m.target);
      }
    }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS, 'value'] });
    // the tab title
    const head = document.querySelector('title');
    if (head) {
      document.title = t(document.title);
      new MutationObserver(() => { const v = t(document.title); if (v !== document.title) document.title = v; }).observe(head, { childList: true, characterData: true, subtree: true });
    }
  };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
  // the browser's own dialogs
  const wrap = (name) => { const f = window[name]; if (typeof f === 'function') window[name] = function (msg, ...rest) { return f.call(window, typeof msg === 'string' ? t(msg) : msg, ...rest); }; };
  wrap('alert'); wrap('confirm'); wrap('prompt');
}
