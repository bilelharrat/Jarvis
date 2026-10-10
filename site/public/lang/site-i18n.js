// askeden.com's own pages in French: the front page, sign-in, Link a Mac, the apps page,
// Daredevil's page, Eden for Education's landing page, and the legal pages.
//
// The rule is the app's (web/chat/i18n.js in the askeden repo): localStorage "eden:lang" =
// "en" | "fr" | absent (absent: the browser's first French or English language), and
// ?lang=fr|en in the address wins. A page loads this file in its <head> (a plain script, so it
// runs before the page is drawn) with data-page="<name>"; in French it hides the page, fetches
// /lang/fr-<name>.js (which calls SiteI18n.add) and shows the page once it's translated
// (or after FAILSAFE_MS, in English, if that file never comes). English costs one small file.
//
// A page's French has, all optional:
//   title, description   the tab title and the meta description
//   blocks    { 'English text of an element': 'French HTML' }: for a paragraph or item mixing
//             text with <b>, <a>…, matched on its whole textContent (whitespace collapsed);
//             its contents are replaced, so keep links and markup in the French
//   exact     { 'English text node or attribute': 'French' }: like the app's dictionary
//   patterns  [[/^…$/, 'French with $1'], …]: text made by a script (statuses, sizes)
//   insert    [[selector, 'beforebegin' | 'afterbegin' | 'beforeend' | 'afterend', 'French HTML']]
// Text that changes later (signin.js's statuses, a version fetched by the page) is translated
// as it appears (a MutationObserver). Elements with data-no-i18n are never touched.
//
// [data-lang-switch] elements get the EN · FR switch, which saves the choice and reloads.
(() => {
  const KEY = 'eden:lang';
  const FAILSAFE_MS = 2500;
  const script = document.currentScript || document.querySelector('script[data-page]');
  const pageName = (script && script.getAttribute('data-page')) || '';

  const pref = () => {
    try { const v = localStorage.getItem(KEY); return v === 'en' || v === 'fr' ? v : 'auto'; } catch { return 'auto'; }
  };
  const browserLang = () => {
    const list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language];
    for (const l of list) {
      const p = String(l || '').toLowerCase().slice(0, 2);
      if (p === 'fr' || p === 'en') return p;
    }
    return 'en';
  };
  const lang = (() => {
    try { const q = new URLSearchParams(location.search).get('lang'); if (q === 'fr' || q === 'en') return q; } catch { /* none */ }
    const p = pref();
    return p === 'auto' ? browserLang() : p;
  })();
  const isFr = lang === 'fr';

  // ── the dictionary ──
  const norm = (s) => String(s).trim().replace(/\s+/g, ' ');
  // French typography: a no-break space before : ; ! ? » and after «
  const nb = (s) => (typeof s === 'string' ? s.replace(/ ([:;!?»])/g, ' $1').replace(/« /g, '« ') : s);
  const exact = new Map();
  const blocks = new Map();
  const patterns = [];
  const inserts = [];
  let title = '';
  let description = '';
  let added = false;

  const LETTER = /[A-Za-z]/;
  function core(raw) {
    const key = raw.replace(/\s+/g, ' ');
    const v = exact.get(key);
    if (v !== undefined) return v;
    for (const [re, rep] of patterns) {
      if (re.test(key)) return key.replace(re, rep);
    }
    const tail = /^(.*?)([:….!?]+)$/.exec(key); // "Label:" / "Label…" when only "Label" is listed
    if (tail && tail[1]) {
      const w = exact.get(tail[1]);
      if (w !== undefined) return tail[2] === ':' ? `${w} :` : w + tail[2];
    }
    return key;
  }
  /** The French for one English string (outer spaces kept), or the string itself. */
  function t(s) {
    if (!isFr || typeof s !== 'string' || !s.trim() || (!LETTER.test(s) && !exact.has(norm(s)))) return s;
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
    const out = core(m[2]);
    return out === m[2].replace(/\s+/g, ' ') ? s : m[1] + out + m[3];
  }

  // ── the page ──
  const ATTRS = ['title', 'aria-label', 'alt', 'placeholder'];
  const SKIP = 'script,style,code,pre,kbd,svg,iframe,textarea,[data-no-i18n],[translate="no"]';
  const skipped = (el) => Boolean(el && el.closest && el.closest(SKIP));

  function doText(node) {
    const v = node.nodeValue;
    if (!v) return;
    const out = t(v);
    if (out !== v) node.nodeValue = out;
  }
  function doAttrs(el) {
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v && LETTER.test(v)) { const out = t(v); if (out !== v) el.setAttribute(a, out); }
    }
    if (el.tagName === 'INPUT' && /^(button|submit|reset)$/i.test(el.type) && el.value) { const out = t(el.value); if (out !== el.value) el.value = out; }
  }
  const KEEP = 'video,audio,iframe,img,picture,canvas,svg,input,select,textarea,button,form,object,embed';
  function walk(node) {
    if (node.nodeType === 3) { doText(node); return; }
    if (node.nodeType !== 1 || node.matches(SKIP)) return;
    doAttrs(node);
    // a block's HTML is swapped only when it holds text and links: never a box with a video, picture or field
    // (the figure around the home page's video reads exactly like the video's fallback text)
    if (node.firstElementChild && blocks.size && !node.querySelector(KEEP)) {
      const html = blocks.get(norm(node.textContent));
      if (html !== undefined) { node.innerHTML = html; return; }
    }
    for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
  }
  function walkFrom(node) {
    const parent = node.nodeType === 1 ? node : node.parentElement;
    if (parent && !skipped(parent)) walk(node);
  }

  const show = () => { document.documentElement.style.visibility = ''; };

  let ran = false;
  function translatePage() {
    if (ran || !added) return;
    ran = true;
    document.documentElement.lang = 'fr';
    try {
      for (const [sel, where, html] of inserts) {
        const at = document.querySelector(sel);
        if (at) at.insertAdjacentHTML(where, html);
      }
      walk(document.body);
      document.title = title || t(document.title);
      const meta = document.querySelector('meta[name="description"]');
      if (meta && description) meta.setAttribute('content', description);
      new MutationObserver((list) => {
        for (const m of list) {
          if (m.type === 'childList') for (const n of m.addedNodes) walkFrom(n);
          else if (m.type === 'characterData') { if (!skipped(m.target.parentElement)) doText(m.target); }
          else if (m.type === 'attributes' && !skipped(m.target)) doAttrs(m.target);
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS, 'value'] });
    } finally {
      show();
    }
  }

  /** Called by /lang/fr-<page>.js with that page's French. */
  function add(part) {
    for (const [k, v] of Object.entries(part.exact || {})) exact.set(norm(k), nb(v));
    for (const [k, v] of Object.entries(part.blocks || {})) blocks.set(norm(k), nb(v));
    for (const [re, rep] of part.patterns || []) patterns.push([re, nb(rep)]);
    for (const [sel, where, html] of part.insert || []) inserts.push([sel, where, nb(html)]);
    if (part.title) title = nb(part.title);
    if (part.description) description = nb(part.description);
    added = true;
    if (document.readyState !== 'loading') translatePage();
  }

  // ── the EN · FR switch ──
  function setLang(v) {
    try { localStorage.setItem(KEY, v); } catch { /* private mode: ?lang= still works */ }
    const url = new URL(location.href);
    if (url.searchParams.has('lang')) {
      url.searchParams.delete('lang');
      location.replace(url.toString());
    } else {
      location.reload();
    }
  }
  function drawSwitch() {
    for (const box of document.querySelectorAll('[data-lang-switch]')) {
      if (box.childNodes.length) continue;
      box.setAttribute('data-no-i18n', '');
      box.setAttribute('role', 'group');
      box.setAttribute('aria-label', isFr ? 'Langue' : 'Language');
      [['en', 'EN', 'English'], ['fr', 'FR', 'Français']].forEach(([code, short, name], i) => {
        if (i) box.append(' · ');
        const a = document.createElement('a');
        const url = new URL(location.href);
        url.searchParams.set('lang', code);
        a.href = url.pathname + url.search + url.hash;
        a.lang = code;
        a.hreflang = code;
        a.textContent = short;
        a.setAttribute('aria-label', name);
        if (code === lang) { a.setAttribute('aria-current', 'true'); a.style.fontWeight = '600'; }
        a.addEventListener('click', (e) => { e.preventDefault(); setLang(code); });
        box.append(a);
      });
    }
  }

  window.SiteI18n = { lang, isFr, t, add };

  const ready = () => { drawSwitch(); translatePage(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
  else drawSwitch();

  if (isFr && pageName && /^[a-z-]+$/.test(pageName)) {
    document.documentElement.lang = 'fr';
    document.documentElement.style.visibility = 'hidden';
    const english = () => { if (!ran) { document.documentElement.lang = 'en'; show(); } };
    setTimeout(english, FAILSAFE_MS);
    const s = document.createElement('script');
    s.src = `/lang/fr-${pageName}.js`;
    s.onerror = english;
    (document.head || document.documentElement).append(s);
  }
})();
