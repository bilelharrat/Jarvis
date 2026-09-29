// Chinese for the window. The window is written in English; when the language setting is
// 中文, every text, placeholder, title and label it shows is swapped for its Chinese as it
// appears (a dictionary for fixed texts, patterns for texts with numbers and names in
// them), and put back when the language goes back to English. What the user and the
// assistant say (the conversation, transcripts, code, notes) is never touched: those
// containers carry data-no-i18n.

(() => {
  const ATTRS = ['placeholder', 'title', 'aria-label'];
  const SKIP = 'script, style, code, pre, textarea, [contenteditable="true"], [data-no-i18n], .xterm, .jc-code';
  // A text box's placeholder and label are the window's words even though what's typed
  // in it isn't: attributes are only skipped inside user data.
  const SKIP_ATTRS = 'script, style, [data-no-i18n], .xterm, .jc-code';
  const state = {
    lang: 'en',
    strings: null,
    patterns: [],
    loading: null,
    source: new WeakMap(), // text node -> the English it was given
    shown: new WeakMap(), // text node -> the Chinese we put there
    attrSource: new WeakMap(), // element -> { attr: English }
    observer: null,
  };

  function lookup(text) {
    const key = text.replace(/\s+/g, ' ').trim();
    if (!key || !state.strings) return null;
    let out = state.strings[key];
    if (out === undefined) {
      for (const [re, rep] of state.patterns) {
        if (re.test(key)) { out = key.replace(re, rep); break; }
      }
    }
    if (out === undefined || out === key) return null;
    const lead = text.match(/^\s*/)[0];
    const tail = text.match(/\s*$/)[0];
    return lead + out + tail;
  }

  function skipped(el) {
    return !el || Boolean(el.closest(SKIP));
  }

  function attrsSkipped(el) {
    return !el || Boolean(el.closest(SKIP_ATTRS));
  }

  function doText(node) {
    if (skipped(node.parentElement)) return;
    const current = node.nodeValue;
    if (state.shown.get(node) === current) return; // ours already
    // Anything else there now is the app's (new) English.
    state.source.set(node, current);
    if (state.lang !== 'zh') return;
    const zh = lookup(current);
    if (zh !== null) {
      state.shown.set(node, zh);
      node.nodeValue = zh;
    }
  }

  function doAttrs(el) {
    if (attrsSkipped(el)) return;
    let saved = state.attrSource.get(el);
    for (const attr of ATTRS) {
      const current = el.getAttribute(attr);
      if (current === null) continue;
      saved = saved || {};
      const mine = saved[`zh:${attr}`];
      if (mine === current) continue;
      saved[attr] = current;
      if (state.lang === 'zh') {
        const zh = lookup(current);
        if (zh !== null) {
          saved[`zh:${attr}`] = zh;
          el.setAttribute(attr, zh);
        }
      }
    }
    if (saved) state.attrSource.set(el, saved);
  }

  function walk(root) {
    if (root.nodeType === Node.TEXT_NODE) { doText(root); return; }
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    doAttrs(root);
    if (skipped(root)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.nodeType === Node.TEXT_NODE) doText(n);
      else doAttrs(n);
    }
  }

  function restore(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const n = walker.currentNode;
      if (n.nodeType === Node.TEXT_NODE) {
        const english = state.source.get(n);
        if (english !== undefined && state.shown.get(n) === n.nodeValue) n.nodeValue = english;
        state.shown.delete(n);
      } else {
        const saved = state.attrSource.get(n);
        if (!saved) continue;
        for (const attr of ATTRS) {
          if (saved[`zh:${attr}`] !== undefined && n.getAttribute(attr) === saved[`zh:${attr}`]) n.setAttribute(attr, saved[attr]);
          delete saved[`zh:${attr}`];
        }
      }
    }
  }

  function watch() {
    if (state.observer) return;
    state.observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'characterData') doText(r.target);
        else if (r.type === 'attributes') doAttrs(r.target);
        else r.addedNodes.forEach((n) => walk(n));
      }
    });
    state.observer.observe(document.body, {
      childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS,
    });
  }

  async function load() {
    if (state.strings) return;
    if (!state.loading) {
      state.loading = fetch('/static/i18n-zh.json', { cache: 'no-cache' })
        .then((r) => (r.ok ? r.json() : { strings: {}, patterns: [] }))
        .then((d) => {
          state.strings = d.strings || {};
          state.patterns = (d.patterns || []).flatMap(([p, rep]) => {
            try { return [[new RegExp(p), rep]]; } catch (_) { return []; }
          });
        })
        .catch(() => { state.strings = {}; state.patterns = []; });
    }
    await state.loading;
  }

  async function setLang(lang) {
    lang = lang === 'zh' ? 'zh' : 'en';
    if (lang === state.lang && (lang === 'en' || state.strings)) return;
    if (lang === 'zh') await load();
    state.lang = lang;
    document.documentElement.lang = lang === 'zh' ? 'zh-Hans' : 'en';
    if (lang === 'zh') walk(document.body);
    else restore(document.body);
    watch();
  }

  window.jarvisI18n = {
    setLang,
    lang: () => state.lang,
    t: (text) => (state.lang === 'zh' ? lookup(String(text)) ?? String(text) : String(text)),
  };
})();
