// The browser-ai feature's window side (the backend is jarvis.features.browser_ai; the app's
// is app/features/browser-ai.js):
// - the page on show, told to the hub as it changes (browser_ai_page: whether the dock is
//   open, the tab, its address and title), so a request can say what "this" is;
// - the hub's calls into the browser (browser_ai_cmd), passed to the app and answered
//   (browser_ai_result); the page's own controls (page_ui: the instant page commands,
//   pagevoice.py) are worked here, as the dock's buttons and Chrome's shortcuts work them;
// - a notice over a page whose text is written to AI assistants (browser_ai_flag), shown
//   while that page is on show until the owner closes it;
// - "Your turn" over a page that needs the owner (browser_ai_handback: a captcha, a
//   password, card details, a code, a sign-in), its tab brought forward; Carry on asks
//   JARVIS to pick up (browser_ai_carry_on), × lets it go (browser_ai_handback_cancel);
// - reader mode: the page's article, as a reader view finds it, in place of the page (the
//   address bar's Reader button, or "reader mode" / "read this to me" said), read aloud in
//   JARVIS's voice on Listen (browser_ai_read; the hub's reader.py says where it is:
//   browser_ai_reading), with pause, back and skip;
// - Settings › Browser: the sensitive sites (banks, email, health: JARVIS acts there only
//   while the owner can see the tab) and the owner's rule for any site (always, ask first,
//   never), changed only here (browser_ai_sites, browser_ai_site); and browser memories,
//   opt-in: a page on show for a minute is told to the hub (browser_ai_dwell), which keeps
//   its text in the second brain's Browsing source (browser_ai_memories to list and forget).
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

  // ── the hand back: "Your turn" over a page that needs the owner ──
  let turn = null; // { tab, url, host, kind }
  const TURN_WORDS = {
    captcha: 'This page wants you to prove you’re human. Jarvis never tries those.',
    password: 'This page wants your password. Jarvis never types it.',
    card: 'This page wants your card details. Jarvis never types them.',
    code: 'This page wants a one-time code.',
    login: 'This page wants you to sign in.',
  };
  B.turnWords = (kind) => TURN_WORDS[kind] || 'This page needs you.';
  function renderTurn() {
    const box = strip();
    if (!box) return;
    const old = box.querySelector('.bai-turn');
    if (!turn || turn.tab !== page.tab) { if (old) old.remove(); return; }
    const note = el('div', 'bai-note bai-turn');
    note.setAttribute('role', 'status');
    const words = el('div', 'bai-note-words');
    words.append(el('strong', '', 'Your turn'), el('span', '', B.turnWords(turn.kind)),
      el('span', 'bai-turn-hint', 'Say “carry on” when you’re done.'));
    const go = button('Carry on', 'bai-turn-go', () => F.send({ type: 'browser_ai_carry_on' }));
    const close = button('', 'bai-x', () => { turn = null; renderTurn(); F.send({ type: 'browser_ai_handback_cancel' }); }, 'Close');
    close.textContent = '×';
    note.append(el('span', 'bai-note-icon bai-turn-icon'), words, go, close);
    if (old) old.replaceWith(note); else box.prepend(note);
  }
  F.on('browser_ai_handback', (ev) => {
    if (ev.tab === null || ev.tab === undefined) { turn = null; renderTurn(); return; }
    turn = { tab: ev.tab, url: String(ev.url || ''), host: String(ev.host || ''), kind: String(ev.need || '') };
    const b = app && app.browser;
    if (b && b.tab && ev.tab !== page.tab) b.tab('select', ev.tab); // the owner's turn is in that tab
    if (!document.body.classList.contains('browser-open')) { const btn = F.$('browser-btn'); if (btn && !btn.hidden) btn.click(); }
    renderTurn();
  });

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

  // Browser memories: the switch is the second brain's Browsing source (brain_source).
  let memories = { on: false, count: 0, clips: 0, recent: [] };
  function memoriesRows() {
    const group = F.$('bai-settings');
    if (!group || F.$('sw-bai-memories')) return;
    const row = el('div', 'row');
    const text = el('span');
    text.append(el('strong', '', 'Remember pages I read'),
      el('small', '', 'A page you keep on show for a minute is kept as text in your second brain (Browsing), to find and ask about later. Never banks, email or health sites; nothing leaves your Mac.'));
    const sw = el('button', 'switch');
    sw.type = 'button';
    sw.id = 'sw-bai-memories';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', 'false');
    sw.setAttribute('aria-label', 'Remember pages I read');
    sw.addEventListener('click', () => {
      memories.on = sw.getAttribute('aria-checked') !== 'true';
      sw.setAttribute('aria-checked', String(memories.on));
      F.send({ type: 'brain_source', source: 'browsing', on: memories.on });
      renderMemories();
    });
    row.append(text, sw);
    const box = el('div', 'bai-memories');
    box.id = 'bai-memories';
    box.hidden = true;
    group.insertBefore(row, group.querySelector('.bai-sites'));
    group.insertBefore(box, group.querySelector('.bai-sites'));
    renderMemories();
  }
  function renderMemories() {
    const sw = F.$('sw-bai-memories');
    const box = F.$('bai-memories');
    if (!sw || !box) return;
    sw.setAttribute('aria-checked', String(memories.on));
    if (!memories.count && !memories.clips) { box.replaceChildren(); box.hidden = true; return; }
    box.hidden = false;
    const head = el('div', 'bai-memories-head');
    const counts = el('span', 'bai-memory-counts');
    if (memories.count) counts.append(el('span', 'small-status', `${memories.count} ${memories.count === 1 ? 'page' : 'pages'} remembered`));
    if (memories.clips) counts.append(el('span', 'small-status', `${memories.clips} saved from the page menu`));
    head.append(counts, button('Forget all', 'btn', () => F.send({ type: 'browser_ai_memory_forget', all: true })));
    const list = el('ul', 'folders bai-memory-list');
    for (const m of memories.recent) {
      const li = el('li');
      const words = el('span', 'bai-memory');
      const where = el('small');
      where.append(mine(el('span', '', m.site || '')));
      if (m.kind === 'clip') where.append(el('span', 'bai-memory-kind', 'Saved'));
      words.append(mine(el('b', '', m.title || m.url)), where);
      li.append(words, button('Forget', 'btn', () => F.send({ type: 'browser_ai_memory_forget', id: m.id, kind: m.kind }), `Forget ${m.title || m.url}`));
      list.append(li);
    }
    box.replaceChildren(head, list);
  }
  F.on('browser_ai_memories', (ev) => {
    memories = {
      on: !!ev.on, count: Math.max(0, Number(ev.count) || 0), clips: Math.max(0, Number(ev.clips) || 0),
      recent: Array.isArray(ev.recent) ? ev.recent.slice(0, 12) : [],
    };
    renderMemories();
  });
  const memoriesPref = (p) => { if (p && p.features && 'browser_memories' in p.features) { memories.on = p.features.browser_memories === true; renderMemories(); } };
  F.on('prefs', memoriesPref, { replay: true });
  memoriesRows();
  F.on('hello', (ev) => {
    memoriesPref(ev.prefs);
    F.send({ type: 'browser_ai_sites' });
    F.send({ type: 'browser_ai_memories' });
  }, { replay: true });
  // The galaxy shows the Browsing source's pages in a color and name of their own.
  if (window.GALAXY_SOURCES) {
    window.GALAXY_SOURCES.colors.browsing = '#38bdf8';
    window.GALAXY_SOURCES.names.browsing = 'Browsing';
  }

  // ── Reader mode: the article in place of the page, and read aloud ──
  const READ_KINDS = new Set(['h', 'p', 'li', 'quote', 'caption']); // as reader.py reads them (never code)
  let reader = null; // { tab, url, title, byline, site, blocks, readable: [block index...] }
  let reading = { state: 'idle', at: 0, count: 0 };
  function slotRect() {
    const r = F.$('browser-slot').getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }
  function readerPanel() {
    let panel = F.$('bai-reader');
    if (panel) return panel;
    const slot = F.$('browser-slot');
    if (!slot) return null;
    panel = el('div', 'bai-reader');
    panel.id = 'bai-reader';
    panel.hidden = true;
    const bar = el('div', 'bai-reader-bar');
    const play = button('Listen', 'bai-read-play', () => {
      if (!reader) return;
      if (reading.state === 'playing') F.send({ type: 'browser_ai_read', action: 'pause' });
      else if (reading.state === 'paused' && reading.url === reader.url) F.send({ type: 'browser_ai_read', action: 'resume' });
      else startReading(0);
    });
    play.id = 'bai-read-play';
    const back = button('‹', 'bai-read-step', () => F.send({ type: 'browser_ai_read', action: 'back' }), 'Previous paragraph');
    back.id = 'bai-read-back';
    const skip = button('›', 'bai-read-step', () => F.send({ type: 'browser_ai_read', action: 'skip' }), 'Next paragraph');
    skip.id = 'bai-read-skip';
    const where = mine(el('span', 'bai-read-where'));
    where.id = 'bai-read-where';
    const note = el('span', 'bai-read-note', 'Jarvis’s voice is off.');
    note.id = 'bai-read-note';
    note.hidden = true;
    const done = button('Done', 'bd-find-done', () => closeReader());
    done.id = 'bai-reader-done';
    bar.append(play, back, skip, where, note, el('span', 'bai-reader-gap'), done);
    const scroller = el('div', 'bai-reader-scroll');
    const body = mine(el('article', 'bai-reader-body'));
    body.id = 'bai-reader-body';
    scroller.append(body);
    panel.append(bar, scroller);
    panel.addEventListener('keydown', (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeReader(); } }); // (a key's name, not shown)
    slot.append(panel);
    return panel;
  }
  function renderReading() {
    const panel = F.$('bai-reader');
    if (!panel || !reader) return;
    const mineNow = reading.url === reader.url;
    const state = mineNow ? reading.state : 'idle';
    F.$('bai-read-play').textContent = F.t(state === 'playing' ? 'Pause' : state === 'paused' ? 'Resume' : 'Listen');
    F.$('bai-read-play').setAttribute('aria-pressed', String(state === 'playing'));
    F.$('bai-read-back').disabled = F.$('bai-read-skip').disabled = state === 'idle';
    F.$('bai-read-where').textContent = state === 'idle' ? '' : `${Math.min(reading.at + 1, reading.count)} / ${reading.count}`;
    F.$('bai-read-note').hidden = !(mineNow && reading.muted && state !== 'playing');
    for (const node of panel.querySelectorAll('.bai-reading')) node.classList.remove('bai-reading');
    if (state === 'idle') return;
    const node = panel.querySelector(`[data-read="${reading.at}"]`);
    if (node) { node.classList.add('bai-reading'); node.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  }
  function renderReader() {
    const panel = readerPanel();
    if (!panel || !reader) return;
    const body = F.$('bai-reader-body');
    const parts = [];
    const meta = [reader.site, reader.byline].filter(Boolean).join(' · ');
    if (meta) parts.push(el('p', 'bai-reader-meta', meta));
    if (reader.title) parts.push(el('h1', 'bai-reader-title', reader.title));
    let n = 0;
    let list = null;
    for (const b of reader.blocks) {
      const tag = { h: 'h2', p: 'p', li: 'li', quote: 'blockquote', pre: 'pre', caption: 'p' }[b.kind] || 'p';
      const node = el(tag, b.kind === 'caption' ? 'bai-reader-caption' : '', b.text);
      if (READ_KINDS.has(b.kind)) node.dataset.read = String(n++);
      if (b.kind === 'li') {
        if (!list) { list = el('ul'); parts.push(list); }
        list.append(node);
      } else {
        list = null;
        parts.push(node);
      }
    }
    body.replaceChildren(...parts);
    renderReading();
  }
  async function openReader(listen = false) {
    if (!app || !app.feature || page.tab === null || !/^https?:/.test(page.url) || page.research) return { ok: false, message: 'There is no page to read.' };
    const r = await call('extract', { tab: page.tab });
    if (!r || r.ok === false || !Array.isArray(r.blocks)) return r || { ok: false };
    if (!r.blocks.some((b) => READ_KINDS.has(b.kind))) return { ok: false, message: 'This page has nothing to read.' };
    reader = { tab: page.tab, url: B.pageKey(r.url || page.url), title: r.title || page.title, byline: r.byline || '', site: r.site || '', blocks: r.blocks.slice(0, 400) };
    const panel = readerPanel();
    renderReader();
    panel.hidden = false;
    if (app.browser && app.browser.hide) app.browser.hide(); // the page is a native view over the slot: it steps aside
    const btn = F.$('bai-reader-btn');
    if (btn) btn.setAttribute('aria-pressed', 'true');
    F.$('bai-reader-done').focus();
    if (listen) startReading(0);
    return { ok: true };
  }
  function startReading(at) {
    if (!reader) return;
    const blocks = reader.blocks.filter((b) => READ_KINDS.has(b.kind)).map((b) => ({ kind: b.kind, text: b.text }));
    F.send({ type: 'browser_ai_read', action: 'start', blocks, at, title: reader.title, url: reader.url });
  }
  function closeReader(showPage = true) {
    const panel = F.$('bai-reader');
    if (!panel || panel.hidden) { reader = null; return; }
    panel.hidden = true;
    if (reading.state !== 'idle' && reader && reading.url === reader.url) F.send({ type: 'browser_ai_read', action: 'stop' });
    reader = null;
    const btn = F.$('bai-reader-btn');
    if (btn) btn.setAttribute('aria-pressed', 'false');
    if (showPage && dockOpenNow() && app && app.browser && app.browser.show) app.browser.show(slotRect());
  }
  const dockOpenNow = () => document.body.classList.contains('browser-open');
  F.on('browser_ai_reading', (ev) => {
    reading = { state: String(ev.state || 'idle'), at: Math.max(0, Number(ev.at) || 0), count: Math.max(0, Number(ev.count) || 0), url: String(ev.url || ''), muted: !!ev.muted };
    renderReading();
  });
  // The address bar's Reader button (a web page on show, not the Research Center).
  function readerButton() {
    const star = F.$('br-star');
    if (!star || F.$('bai-reader-btn')) return;
    const b = button('', 'bd-star bai-reader-btn', () => { if (reader) closeReader(); else openReader(false); }, 'Reader');
    b.id = 'bai-reader-btn';
    b.title = F.t('Reader');
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M3 3.5h10M3 6.5h10M3 9.5h10M3 12.5h6"/></svg>';
    b.hidden = true;
    star.before(b);
  }
  readerButton();
  // The reader follows the page: another page, another tab, the dock closed or the
  // bookmarks and history put in its place end it.
  const lib = F.$('bd-lib');
  if (lib) new MutationObserver(() => { if (!lib.hidden) closeReader(false); }).observe(lib, { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(() => { if (!dockOpenNow()) closeReader(false); }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  B.openReader = openReader;

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

  // A web page on show in the dock of a window in view, counted a second at a time: at a
  // minute it's told to the hub once (it keeps the page when memories are on).
  const DWELL_MS = 60 * 1000;
  const dwell = { key: '', ms: 0, told: new Set() };
  B.dwellTick = (ms = 1000) => {
    if (!memories.on || !dockOpen() || document.visibilityState !== 'visible' || page.research || !/^https?:/.test(page.url)) return;
    const key = B.pageKey(page.url);
    if (key !== dwell.key) { dwell.key = key; dwell.ms = 0; }
    dwell.ms += ms;
    if (dwell.ms < DWELL_MS || dwell.told.has(key)) return;
    dwell.told.add(key);
    if (dwell.told.size > 500) dwell.told.delete(dwell.told.values().next().value);
    F.send({ type: 'browser_ai_dwell', url: page.url, tab: page.tab, seconds: Math.round(dwell.ms / 1000) });
  };
  setInterval(() => B.dwellTick(), 1000);

  function onState(st) {
    const tabs = Array.isArray(st && st.tabs) ? st.tabs : [];
    const shown = tabs.find((x) => x.active) || {};
    const next = { url: String((st && st.url) || ''), title: String((st && st.title) || ''), tab: shown.id ?? null, research: !!(st && st.research) };
    const moved = next.url !== page.url || next.tab !== page.tab;
    next.selected = moved ? 0 : page.selected; // a new page starts with nothing selected
    page = next;
    nav = { canBack: !!(st && st.canBack), canForward: !!(st && st.canForward), tabs: tabs.length };
    if (moved) renderFlag();
    if (reader && (page.tab !== reader.tab || B.pageKey(page.url) !== reader.url)) closeReader();
    const rb = F.$('bai-reader-btn');
    if (rb) rb.hidden = !/^https?:/.test(page.url) || page.research;
    if (turn && tabs.length && !tabs.some((x) => x.id === turn.tab)) { // its tab closed: let it go
      turn = null;
      F.send({ type: 'browser_ai_handback_cancel' });
    }
    renderTurn();
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

  // ── Ask Jarvis in the page's own menu (app/features/browser-ai.js puts it there) ──
  // What the owner picked goes to the hub (menuask.py); the menu gets its words in the
  // owner's language.
  const ASK_KEYS = ['action', 'save', 'url', 'title', 'tab', 'selection', 'link', 'link_text', 'image', 'png'];
  if (app && app.feature && app.feature.on) {
    app.feature.on('feature:browser-ai:ask', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      const out = { type: 'browser_ai_ask' };
      for (const key of ASK_KEYS) if (key in msg) out[key] = msg[key];
      F.send(out);
    });
  }
  const MENU_WORDS = {
    ask: 'Ask Jarvis', explain: 'Explain', summarize: 'Summarize', translate: 'Translate', reply: 'Draft a Reply',
    save: 'Save to Second Brain', link: 'Summarize the Linked Page', image: 'Explain This Picture',
  };
  function menuWords() {
    if (!app || !app.feature || !app.feature.send) return;
    const words = {};
    for (const [key, text] of Object.entries(MENU_WORDS)) words[key] = F.t(text);
    app.feature.send('feature:browser-ai:labels', words);
  }
  F.on('prefs', menuWords, { replay: true });
  B.menuWords = menuWords;

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
      case 'reader': return openReader(Boolean(args.listen)); // "reader mode", "read this to me"
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
