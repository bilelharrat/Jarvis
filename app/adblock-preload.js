'use strict';
// Ad blocking inside each page and frame of the built-in browser (adblock.js sets it up;
// it runs sandboxed, in an isolated world, before any of the page's scripts):
// - the page's scriptlets (uBlock Origin's: what defuses YouTube's in-player ads, anti-
//   adblock walls, trackers) run in the page's world before its own scripts do;
// - the hiding rules are in place for the first paint, so ads never flash;
// - classes, ids and links that appear later get their generic rules as they come;
// - procedural rules (:has-text, :upward, :xpath, :remove…) run in a world of their own,
//   and again as the page changes.

const { ipcRenderer, webFrame } = require('electron');

const WORLD = 1107; // the procedural rules' own isolated world (not the page's, not this one)

(() => {
  const url = location.href;
  if (!/^https?:/.test(url)) return;
  let rules = null;
  try { rules = ipcRenderer.sendSync('jarvis-adblock:start', url); } catch { return; }
  if (!rules) return;

  // Scriptlets first: webFrame.executeJavaScript runs each at once, in the page's world,
  // and bypasses the page's CSP as an extension's would. Each declares its helpers
  // (safeSelf, JSONPath…) at the top of its code: its own block keeps them its own, as
  // Ghostery's injection does, or the second to declare one fails and the helpers they
  // redefine for each other recurse.
  for (const code of rules.scripts) webFrame.executeJavaScript(`try{${code}\n}catch(e){}`).catch(() => {});
  if (rules.styles) webFrame.insertCSS(rules.styles, { cssOrigin: 'user' });

  if (rules.extended.length && rules.lib) {
    webFrame.executeJavaScriptInIsolatedWorld(WORLD, [{ code: proceduralRunner(rules.lib, rules.extended) }]).catch(() => {});
  }
  if (rules.observe) watchFeatures(url);
})();

// The classes, ids and links in the page, sent as they first appear; the generic rules
// that match them come back as a stylesheet.
function watchFeatures(url) {
  const seen = { classes: new Set(), ids: new Set(), hrefs: new Set() };
  let batch = { classes: [], ids: [], hrefs: [] };
  let queued = 0;
  let timer = 0;
  let deadline = 0;

  const add = (kind, value) => {
    if (!value || seen[kind].has(value) || seen[kind].size >= 20000) return;
    seen[kind].add(value);
    batch[kind].push(value);
    queued += 1;
  };
  const note = (el) => {
    if (el.nodeType !== 1) return;
    if (el.id) add('ids', el.id);
    const cls = el.classList;
    for (let i = 0; i < cls.length; i++) add('classes', cls[i]);
    const href = el.getAttribute('href');
    if (href) add('hrefs', href);
  };
  const scan = (root) => {
    note(root);
    if (root.querySelectorAll) for (const el of root.querySelectorAll('[id],[class],[href]')) note(el);
  };
  const flush = () => {
    clearTimeout(timer);
    clearTimeout(deadline);
    timer = deadline = 0;
    if (!queued) return;
    const sending = batch;
    batch = { classes: [], ids: [], hrefs: [] };
    queued = 0;
    ipcRenderer.invoke('jarvis-adblock:dom', url, sending)
      .then((css) => { if (css) webFrame.insertCSS(css, { cssOrigin: 'user' }); })
      .catch(() => {});
  };
  // Soon after the page stops changing, and at least once a second while it keeps on.
  const soon = () => {
    if (queued > 1000) { flush(); return; }
    clearTimeout(timer);
    timer = setTimeout(flush, 25);
    if (!deadline) deadline = setTimeout(flush, 1000);
  };

  const start = () => {
    scan(document.documentElement);
    flush();
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes') note(m.target);
        else for (const node of m.addedNodes) if (node.nodeType === 1) scan(node);
      }
      if (queued) soon();
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'id', 'href'] });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}

// The script for the procedural rules' world: Ghostery's selector engine, then a loop that
// marks what the rules match (the stylesheet hides marked elements) or applies their
// directive (:remove, :remove-attr, :remove-class), at DOMContentLoaded and as the page
// changes, never more often than it can afford.
function proceduralRunner(lib, extended) {
  const run = function (rules) {
    const engine = globalThis.adblocker;
    if (!engine || !engine.querySelectorAll) return;
    let wait = 100;
    let timer = 0;
    const apply = () => {
      timer = 0;
      const began = performance.now();
      for (const rule of rules) {
        let found;
        try { found = engine.querySelectorAll(document.documentElement, rule.ast); } catch (_) { continue; }
        for (const el of found) {
          if (rule.attribute) { if (!el.hasAttribute(rule.attribute)) el.setAttribute(rule.attribute, ''); }
          else if (rule.directive) { try { engine.handlePseudoDirective(el, rule.directive); } catch (_) { /* a rule that doesn't fit this page */ } }
        }
      }
      // A slow page is looked at less often: at most a tenth of the time goes on this.
      wait = Math.min(2000, Math.max(100, (performance.now() - began) * 10));
    };
    const later = () => { if (!timer) timer = setTimeout(apply, wait); };
    const start = () => {
      apply();
      new MutationObserver(later).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  };
  return `${lib}\n;(${run.toString()})(${JSON.stringify(extended)});`;
}
