// Click an element to send it (features/code_pick.py), the window's side: Pick mode from the
// Preview pane's "Pick an element", the More menu or /pick (the app outlines what the pointer
// is over in the browser's tab, a click takes it: app/features/element-pick.js), and what was
// taken on the composer as one chip ("Element: button.buy": its document and picture, sent
// with the next message). The spoken way's errands for the backend too: the page's tree
// (cp_find), and the element once the owner said yes (cp_capture).
//
// Only in the app: a window in a browser can't reach the dev server's page, and says how to
// pick there instead. Only a page on this Mac, or a file the owner opened, is ever picked from
// (the app checks the tab; the backend checks the address again). Pure helpers are exported
// for node --test (tests/web/code-pick.test.mjs).
(function codePick(root) {
  'use strict';

  const NO_APP = 'Picking an element works in the Eden Code app: its Preview opens in the app’s own browser.';

  // A ref of this window's own, for the backend to send its answer back to it alone.
  function newRef() {
    return `p${Math.random().toString(36).slice(2, 10)}`;
  }

  // Whether the tab already shows the page to pick from (same origin), else it's opened.
  function showsAlready(shown, url) {
    try { return Boolean(shown) && new URL(shown).origin === new URL(url).origin; } catch (_) { return false; }
  }

  // The words said when Pick mode starts, and when it ends with something on the composer.
  function startWords() { return 'Pick mode: point at an element on the page and click it. Escape gives up.'; }
  function attachedWords(label) { return `${label} is on your message. Say or type what to do with it.`; }

  const api = { newRef, showsAlready, startWords, attachedWords, NO_APP };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  const F = root.jarvisFeatures;
  if (!F) return;

  const app = root.jarvisApp && root.jarvisApp.feature ? root.jarvisApp : null;
  const mine = new Set(); // refs this window asked with (a pick, a capture): its answers are ours
  const trees = new Set(); // the backend's tree calls this window answered
  let picking = false;

  function note(text) {
    if (typeof jcNote === 'function') jcNote(F.t(text));
    const a11y = root.jarvisAccessibility;
    if (a11y && a11y.announce) a11y.announce(F.t(text));
  }

  // Pick mode in the browser's tab: url (the Preview pane's dev server) opened first when the
  // tab isn't on it; otherwise the tab on show, else the newest with a page on this Mac.
  async function start(url = '') {
    if (!app) { note(NO_APP); return; }
    if (picking) { app.feature.invoke('feature:element-pick:stop', {}); return; }
    if (url && root.jarvisApp.browser) {
      if (typeof toggleBrowser === 'function') toggleBrowser(true);
      const shown = typeof browserState !== 'undefined' && browserState ? browserState.url : '';
      if (!showsAlready(shown, url)) {
        root.jarvisApp.browser.nav('go', url);
        await new Promise((r) => setTimeout(r, 1500)); // its page loads (the preload starts with it)
      }
    }
    picking = true;
    note(startWords());
    let result;
    try {
      result = await app.feature.invoke('feature:element-pick:start', {});
    } catch (err) {
      result = { ok: false, message: String(err && err.message ? err.message : err) };
    } finally {
      picking = false;
    }
    if (!result || !result.ok) {
      if (result && !result.cancelled && result.message) note(result.message);
      return;
    }
    const ref = newRef();
    mine.add(ref);
    const now = F.currentTask();
    F.send({ type: 'cp_picked', pick: result.pick, id: now ? now.id : 0, ref });
  }
  root.jarvisCodePick = { start, available: () => Boolean(app) };

  F.on('cp_attach', (ev) => {
    if (!ev.ref || !mine.delete(ev.ref)) return; // another window's pick
    if (F.attach && F.attach(ev.items || [])) note(attachedWords(ev.label || 'The element'));
  });
  F.on('cp_error', (ev) => note(ev.text || 'That element couldn’t be picked.'));

  // ── the spoken way: the backend's errands ──

  F.on('cp_find', async (ev) => {
    if (!app) return;
    let result;
    try { result = await app.feature.invoke('feature:element-pick:tree', {}); } catch (_) { result = null; }
    // A window with no page on this Mac stays quiet: another may have one.
    if (!result || !result.ok) return;
    trees.add(ev.id);
    F.send({ type: 'cp_tree', id: ev.id, result });
  });
  F.on('cp_capture', async (ev) => {
    if (!app || !trees.delete(ev.find)) return; // only the window that read the tree takes it
    let result;
    try { result = await app.feature.invoke('feature:element-pick:capture', { index: ev.index }); } catch (_) { result = null; }
    if (!result || !result.ok) return;
    mine.add(ev.id);
    F.send({ type: 'cp_captured', id: ev.id, pick: result.pick });
  });

  // ── where it starts ──

  F.registerMoreItem({ label: 'Pick an element on the page', note: 'Send it with your next message', run: () => start() });
  F.registerSlash({ name: 'pick', help: 'Pick an element of the Preview to send', run: () => start() });
})(typeof window === 'object' ? window : globalThis);
