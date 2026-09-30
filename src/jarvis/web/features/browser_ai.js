// The browser-ai feature's window side (the backend is jarvis.features.browser_ai; the app's
// is app/features/browser-ai.js):
// - the page on show, told to the hub as it changes (browser_ai_page: whether the dock is
//   open, the tab, its address and title), so a request can say what "this" is;
// - the hub's calls into the browser (browser_ai_cmd), passed to the app and answered
//   (browser_ai_result); the page's own controls (page_ui: the instant page commands,
//   pagevoice.py) are worked here, as the dock's buttons and Chrome's shortcuts work them;
// - a notice over a page whose text is written to AI assistants (browser_ai_flag), shown
//   while that page is on show until the owner closes it;
// - Settings › Browser: the sensitive sites (banks, email, health: JARVIS acts there only
//   while the owner can see the tab) and the owner's rule for any site (always, ask first,
//   never), changed only here (browser_ai_sites, browser_ai_site).
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
  let nav = { canBack: false, canForward: false, tabs: 0 }; // the page on show's history, the tab count
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  // ── Settings › Browser ──
  const KINDS = [['bank', 'Banks and payments'], ['email', 'Email'], ['health', 'Health'], ['other', 'Other']];
  const KIND_CHOICES = [['bank', 'Bank'], ['email', 'Email'], ['health', 'Health'], ['other', 'Other']]; // short: the select is narrow
  const RULES = [['always', 'Always'], ['ask', 'Ask first'], ['never', 'Never']];
  let sites = { sites: [], removed: [], rules: {} };

  function option(value, label) {
    const o = el('option', '', label);
    o.value = value;
    return o;
  }
  function siteForm(id, placeholder, choices, onAdd) {
    const form = el('form', 'folder-form');
    form.id = id;
    const input = el('input');
    input.id = `${id}-input`;
    input.maxLength = 300;
    input.placeholder = placeholder;
    input.spellcheck = false;
    input.autocomplete = 'off';
    const label = el('label', 'sr-only', placeholder);
    label.htmlFor = input.id;
    const select = el('select');
    select.id = `${id}-choice`;
    select.setAttribute('aria-label', id === 'bai-site-form' ? 'Kind of site' : 'What Jarvis may do');
    for (const [value, text] of choices) select.append(option(value, text));
    const add = el('button', 'btn', 'Add');
    add.type = 'submit';
    form.append(label, input, select, add);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const host = input.value.trim();
      if (!host) return;
      onAdd(host, select.value);
      input.value = '';
    });
    return form;
  }
  function sitesGroup() {
    const settings = F.$('settings');
    if (!settings || F.$('bai-settings')) return;
    const group = el('section', 'group');
    group.id = 'bai-settings';
    group.append(el('h3', '', 'Browser'),
      el('p', 'small-status', 'On banks, email and health sites Jarvis acts only while their tab is on show for you to watch, and what it reads there stays your private data.'));
    const details = el('details', 'bai-sites');
    const summary = el('summary', '', 'Sensitive sites');
    summary.id = 'bai-sites-summary';
    const kinds = el('div', 'bai-kinds');
    kinds.id = 'bai-kinds';
    details.append(summary, kinds,
      siteForm('bai-site-form', 'Add a site, e.g. mybank.com', KIND_CHOICES, (host, kind) => F.send({ type: 'browser_ai_site', op: 'add', host, kind })));
    const rulesHead = el('p', 'small-status', 'Where Jarvis may act: always (in a tab behind too), only after asking you, or never. Reading a page is still fine.');
    const rules = el('ul', 'folders bai-rules');
    rules.id = 'bai-rules';
    const error = el('p', 'small-status warn-line');
    error.id = 'bai-sites-error';
    error.hidden = true;
    group.append(details, rulesHead, rules,
      siteForm('bai-rule-form', 'A site, e.g. example.com', RULES, (host, rule) => F.send({ type: 'browser_ai_site', op: 'rule', host, rule })), error);
    const after = F.$('research-url') && F.$('research-url').closest('section');
    if (after) after.after(group); else settings.append(group);
  }
  function chip(host, sign, label, onClick) {
    const box = el('span', 'bai-chip');
    const b = button(sign, 'bai-chip-x', onClick, label);
    box.append(mine(el('span', 'bai-chip-host', host)), b);
    return box;
  }
  function renderSites() {
    const kinds = F.$('bai-kinds');
    const rules = F.$('bai-rules');
    if (!kinds || !rules) return;
    F.$('bai-sites-summary').textContent = `Sensitive sites · ${sites.sites.length}`;
    const groups = [];
    for (const [kind, name] of KINDS) {
      const here = sites.sites.filter((x) => x.kind === kind);
      if (!here.length) continue;
      const box = el('div', 'bai-kind');
      const chips = el('div', 'bai-chips');
      for (const x of here) chips.append(chip(x.host, '×', `Take ${x.host} off the list`, () => F.send({ type: 'browser_ai_site', op: 'remove', host: x.host })));
      box.append(el('p', 'bai-kind-name', name), chips);
      groups.push(box);
    }
    if (sites.removed.length) {
      const box = el('div', 'bai-kind bai-removed');
      const chips = el('div', 'bai-chips');
      for (const host of sites.removed) chips.append(chip(host, '+', `Put ${host} back on the list`, () => F.send({ type: 'browser_ai_site', op: 'add', host })));
      box.append(el('p', 'bai-kind-name', 'Taken off'), chips);
      groups.push(box);
    }
    kinds.replaceChildren(...groups);
    const rows = Object.entries(sites.rules || {}).sort((a, b) => a[0].localeCompare(b[0])).map(([host, rule]) => {
      const li = el('li', 'bai-rule');
      const seg = el('div', 'segmented modes compact');
      seg.setAttribute('role', 'radiogroup');
      seg.setAttribute('aria-label', `What Jarvis may do on ${host}`);
      for (const [value, text] of RULES) {
        const b = button(text, '', () => F.send({ type: 'browser_ai_site', op: 'rule', host, rule: value }));
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', String(rule === value));
        seg.append(b);
      }
      const rm = button('Remove', 'btn', () => F.send({ type: 'browser_ai_site', op: 'rule', host, rule: '' }), `Remove the rule for ${host}`);
      li.append(mine(el('span', 'bai-rule-host', host)), seg, rm);
      return li;
    });
    rules.replaceChildren(...(rows.length ? rows : [el('li', 'muted', 'No rules: Jarvis asks as usual everywhere.')]));
  }
  F.on('browser_ai_sites', (ev) => {
    sites = { sites: Array.isArray(ev.sites) ? ev.sites : [], removed: Array.isArray(ev.removed) ? ev.removed : [], rules: ev.rules && typeof ev.rules === 'object' ? ev.rules : {} };
    const error = F.$('bai-sites-error');
    if (error) { error.hidden = !ev.error; error.textContent = ev.error || ''; }
    renderSites();
  });
  sitesGroup();
  F.on('hello', () => F.send({ type: 'browser_ai_sites' }), { replay: true });

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
    nav = { canBack: !!(st && st.canBack), canForward: !!(st && st.canForward), tabs: tabs.length };
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
  const call = (action, args = {}) => app.feature.invoke('feature:browser-ai:call', { action, args });

  // The page's own controls, for a spoken command: what the dock's buttons do, and Chrome's
  // shortcuts through the dock's own handler (the app sends it browser:shortcut).
  async function pageUi(args) {
    const b = app.browser;
    if (!b) return { ok: false, message: 'The built-in browser is only in the J.A.R.V.I.S. app.' };
    switch (args.op) {
      case 'scroll': {
        const r = await b.command({ action: 'scroll', args: { direction: String(args.direction || 'down'), amount: Number(args.amount) || 1 } });
        return r && (r.error || r.ok === false) ? r : { ok: true };
      }
      case 'back':
        if (!nav.canBack) return { ok: false, message: "There's no page to go back to." }; // spoken by the hub (lang.translate)
        await b.nav('back');
        return { ok: true };
      case 'forward':
        if (!nav.canForward) return { ok: false, message: "There's no page to go forward to." };
        await b.nav('forward');
        return { ok: true };
      case 'reload':
        await b.nav('reload');
        return { ok: true };
      case 'zoom': {
        const way = args.direction === 'in' ? 'zoom-in' : args.direction === 'out' ? 'zoom-out' : 'zoom-reset';
        return { ok: Boolean(await b.shortcut(way)) };
      }
      case 'new_tab':
        await b.tab('new');
        setTimeout(() => { const url = F.$('br-url'); if (url) url.focus(); }, 120); // as the + button does
        return { ok: true };
      case 'close_tab': {
        const url = F.$('br-url');
        if (url && document.activeElement === url) url.blur(); // so the next page's address shows in it
        if (nav.tabs > 1) { await b.tab('close'); return { ok: true }; }
        return call('shortcut', { name: 'close' }); // the last tab: the dock closes, as ⌘W does
      }
      case 'find': {
        const r = await call('shortcut', { name: 'find' });
        if (!r || r.ok === false) return r || { ok: false };
        const text = String(args.text || '').slice(0, 100);
        const bar = F.$('bd-find');
        const input = F.$('bd-find-input');
        for (let i = 0; i < 25 && bar && bar.hidden; i += 1) await sleep(20); // the dock opens its bar
        if (text && input && bar && !bar.hidden) {
          input.value = text;
          input.dispatchEvent(new Event('input')); // the bar finds as you type
        }
        return { ok: true };
      }
      case 'bookmark': {
        const lib = await b.data();
        if (lib && (lib.bookmarks || []).some((x) => x && x.url === page.url)) return { ok: true, already: true };
        return call('shortcut', { name: 'bookmark' }); // ★, as ⌘D presses it
      }
      default:
        return { ok: false, message: `Unknown page command ${String(args.op)}` };
    }
  }

  F.on('browser_ai_cmd', async (ev) => {
    let result;
    if (!app || !app.feature) result = { ok: false, message: 'The built-in browser is only in the J.A.R.V.I.S. app.' };
    else {
      try {
        result = ev.action === 'page_ui' ? await pageUi(ev.args || {}) : await call(ev.action, ev.args || {});
      } catch (err) {
        result = { ok: false, message: String((err && err.message) || err) };
      }
    }
    F.send({ type: 'browser_ai_result', id: ev.id, result: result || {} });
  });
})();
