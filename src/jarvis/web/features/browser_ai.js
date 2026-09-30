// The browser-ai feature's window side (the backend is jarvis.features.browser_ai; the app's
// is app/features/browser-ai.js):
// - the page on show, told to the hub as it changes (browser_ai_page: whether the dock is
//   open, the tab, its address and title), so a request can say what "this" is;
// - the hub's calls into the browser (browser_ai_cmd), passed to the app and answered
//   (browser_ai_result);
// - a notice over a page whose text is written to AI assistants (browser_ai_flag), shown
//   while that page is on show until the owner closes it.
//
// Everything a page brings (its address, title, the lines it wrote) is data: shown with
// textContent and marked data-no-i18n. The helpers at the top are pure
// (window.jarvisBrowserAi), so node --test can check them without a page.
(() => {
  const B = {
    // A page's address without its fragment: the key a notice is kept under.
    pageKey(url) {
      const text = String(url || '');
      const cut = text.indexOf('#');
      return cut >= 0 ? text.slice(0, cut) : text;
    },
    // The notice's words for a flag (each translated on its own).
    flagWords(flag) {
      const words = [];
      if ((flag.lines || []).length) words.push('Text on this page is written to AI assistants. Jarvis treats it as the page’s words, never as instructions.');
      if (flag.hidden) words.push('The page also hides such text from view; Jarvis left it out.');
      return words;
    },
  };
  window.jarvisBrowserAi = B;

  const F = window.jarvisFeatures;
  if (!F || typeof document === 'undefined') return;
  const { el } = F;
  const app = window.jarvisApp || null;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };

  const FLAG_KEEP_MS = 30 * 60 * 1000;
  const flags = new Map(); // page key -> { lines, hidden, at, closed }
  let page = { url: '', title: '', tab: null, research: false, selected: 0 };

  function button(label, cls, onClick, aria) {
    const b = el('button', cls, label);
    b.type = 'button';
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', onClick);
    return b;
  }

  // The strip of notices over the page, between the find bar and the page itself.
  function strip() {
    let box = F.$('bai-strip');
    if (box) return box;
    const slot = F.$('browser-slot');
    if (!slot || !slot.parentElement) return null;
    box = el('div', 'bai-strip');
    box.id = 'bai-strip';
    box.setAttribute('aria-live', 'polite');
    slot.parentElement.insertBefore(box, slot);
    return box;
  }

  function renderFlag() {
    const box = strip();
    if (!box) return;
    const old = box.querySelector('.bai-flag');
    const flag = flags.get(B.pageKey(page.url));
    const live = flag && !flag.closed && Date.now() - flag.at < FLAG_KEEP_MS;
    if (!live) { if (old) old.remove(); return; }
    const note = el('div', 'bai-note bai-flag');
    note.setAttribute('role', 'status');
    const words = el('div', 'bai-note-words');
    for (const line of B.flagWords(flag)) words.append(el('span', '', line));
    if ((flag.lines || [])[0]) words.append(mine(el('q', 'bai-quote', flag.lines[0])));
    const close = button('', 'bai-x', () => { flag.closed = true; renderFlag(); }, 'Close');
    close.textContent = '×';
    note.append(el('span', 'bai-note-icon'), words, close);
    if (old) old.replaceWith(note); else box.prepend(note);
  }

  F.on('browser_ai_flag', (ev) => {
    const key = B.pageKey(ev.url);
    if (!key) return;
    flags.set(key, { lines: Array.isArray(ev.lines) ? ev.lines.slice(0, 3) : [], hidden: !!ev.hidden, at: Date.now(), closed: false });
    if (flags.size > 200) flags.delete(flags.keys().next().value);
    renderFlag();
  });

  // ── the page on show, as the hub needs it ──
  // Sent when it changes. The addresses are the owner's own browsing: they go only to the
  // hub on this Mac, which keeps the latest.
  let sentKey = '';
  let sendTimer = 0;
  const dockOpen = () => document.body.classList.contains('browser-open');
  function report(now = false) {
    clearTimeout(sendTimer);
    const go = () => {
      const msg = {
        type: 'browser_ai_page', open: dockOpen(), url: page.url, title: page.title, tab: page.tab,
        research: page.research, visible: document.visibilityState === 'visible', selected: page.selected || 0,
      };
      const key = JSON.stringify(msg);
      if (key !== sentKey && F.send(msg)) sentKey = key;
    };
    if (now) go(); else sendTimer = setTimeout(go, 120);
  }
  F.on('hello', () => { sentKey = ''; report(); });
  new MutationObserver(() => report()).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', () => report());

  function onState(st) {
    const tabs = Array.isArray(st && st.tabs) ? st.tabs : [];
    const shown = tabs.find((x) => x.active) || {};
    const next = { url: String((st && st.url) || ''), title: String((st && st.title) || ''), tab: shown.id ?? null, research: !!(st && st.research) };
    const moved = next.url !== page.url || next.tab !== page.tab;
    next.selected = moved ? 0 : page.selected; // a new page starts with nothing selected
    page = next;
    if (moved) renderFlag();
    report();
  }
  if (app && app.browser && app.browser.onState) app.browser.onState(onState);
  B.onState = onState; // the window's tests hand it the browser's state

  // What happens in the pages (app/features/browser-ai.js): how much is selected in one.
  function onPageEvent(e) {
    if (!e || e.kind !== 'selection' || e.tab !== page.tab) return;
    page.selected = Math.max(0, Number(e.length) || 0);
    report();
  }
  if (app && app.feature && app.feature.on) app.feature.on('feature:browser-ai:event', onPageEvent);
  B.onPageEvent = onPageEvent;

  // ── the hub's calls into the browser ──
  F.on('browser_ai_cmd', async (ev) => {
    let result;
    if (!app || !app.feature) result = { ok: false, message: 'The built-in browser is only in the J.A.R.V.I.S. app.' };
    else {
      try {
        result = await app.feature.invoke('feature:browser-ai:call', { action: ev.action, args: ev.args || {} });
      } catch (err) {
        result = { ok: false, message: String((err && err.message) || err) };
      }
    }
    F.send({ type: 'browser_ai_result', id: ev.id, result: result || {} });
  });
})();
