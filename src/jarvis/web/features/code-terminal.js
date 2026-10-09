// Eden Code's terminals and "!" commands (features/code_terminal.py, code_terminals.py).
// - The Terminal pane, in place of the core's single terminal: tabs, each a shell of its own
//   in the project's folder; + opens another, × hangs one up (asking first when something
//   runs in it); Split shows two at once, one above the other.
// - Closing the pane only detaches: the shells go on, and opening the pane again (or after a
//   reload) shows them with what they printed meanwhile.
// - "Send to Eden Code" puts the selected text in the composer, as a code block.
// - "!" commands in the composer stream their output into the transcript as it comes, with
//   a Cancel, and no time limit.
// Pure helpers are exported for node --test (tests/web/code-terminal.test.mjs).
(function (root) {
  'use strict';

  const LIVE_LINES = 2000;  // lines of a "!" command's output shown while it runs

  // A "!" command's output so far, as lines: a line rewritten with \r (a progress bar) shows
  // as it ended up, a backspace takes a character back, and only the last LIVE_LINES stay.
  // say: the window's words in the window's language (its output box isn't translated).
  function liveOutput() { return { lines: [''], dropped: 0, cr: false }; }
  function applyOutput(out, text, skipped = 0, say = String) {
    if (skipped > 0) out.lines.push(say(`… (${skipped} characters more, not shown) …`), '');
    // A terminal ends its lines with \r\n; a \r at the end of one message may be the start
    // of the next's \r\n, so it waits for it.
    let s = `${out.cr ? '\r' : ''}${String(text || '')}`;
    out.cr = s.endsWith('\r');
    if (out.cr) s = s.slice(0, -1);
    const parts = s.replace(/\r\n/g, '\n').split('\n');
    parts.forEach((part, i) => {
      if (i > 0) out.lines.push('');
      let line = out.lines[out.lines.length - 1];
      for (const piece of part.split(/(\r|\x08)/)) {
        if (piece === '\r') line = '';  // (what comes next writes over it)
        else if (piece === '\x08') line = line.slice(0, -1);
        else if (piece) line += piece;
      }
      out.lines[out.lines.length - 1] = line;
    });
    if (out.lines.length > LIVE_LINES) {
      out.dropped += out.lines.length - LIVE_LINES;
      out.lines.splice(0, out.lines.length - LIVE_LINES);
    }
    return out;
  }

  // Selected terminal text for the composer: a code block its own backticks can't close.
  function selectionBlock(text, before = '') {
    const body = String(text || '').replace(/\s+$/, '');
    let fence = '```';
    while (body.includes(fence)) fence += '`';
    const lead = before && !/\n\s*$/.test(before) ? '\n' : '';
    return `${lead}From the terminal:\n${fence}\n${body}\n${fence}\n`;
  }

  // A shell's output as it comes (base64) as the bytes the terminal is given. By a loop:
  // Uint8Array.from(text, fn) calls fn once a character through the iterator, some twenty
  // times slower, on every chunk a busy shell prints and on a reopened pane's whole 512 KB.
  function termBytes(data) {
    const text = atob(data);
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
    return bytes;
  }

  const api = { liveOutput, applyOutput, selectionBlock, termBytes, LIVE_LINES };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, t } = F;  // (t: the window's words written into a terminal or an output box)
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };

  // ── the Terminal pane ──

  const THEME = { background: '#0d0d10', foreground: '#e6e6ea', cursor: '#40b0f0', selectionBackground: 'rgba(64,176,240,0.35)' };
  const views = new Map();  // term id -> { xterm, fit, box, replayed, observer, sized }
  const lists = new Map();  // folder -> [{ term, title, alive, cwd, folder }]
  const folderOf = new Map();  // the pane's key (a session's folder, a project) -> folder
  const layouts = new Map();  // key -> { top, bottom, focus: 'top' | 'bottom', split }
  const asked = new Set();  // keys whose terminals were asked for
  const making = new Set();  // keys a terminal is being made for
  const armed = new Map();  // term -> timer: × clicked once while something runs in it
  let startFor = '';  // the key the pane was opened for, until its list is seen: none there starts one
  // The key whose terminal takes the keys when it's next drawn: the pane was opened, or a tab,
  // +, Split or × pressed. Never on a redraw from elsewhere (another session, a new list), so
  // what's typed in the composer never goes to the shell.
  let focusFor = '';
  // Whether the pane was closed, or showed another one, since the terminal was drawn in it: its
  // next drawing is then the owner opening it. Else it's only drawn again (another session
  // shown, Eden Code opened again, a new list).
  let away = true;
  let rootEl = null;
  let busyNote = null;

  function project() { return typeof deckProject !== 'undefined' ? deckProject : ''; }
  function keyNow() { const t = F.currentTask(); return t ? `task:${t.path || t.id}` : `project:${project()}`; }
  function whereNow() { const t = F.currentTask(); return t ? { id: t.id, directory: project() } : { directory: project() }; }
  function paneShown() { return typeof currentPane !== 'undefined' && currentPane === 'terminal' && !F.$('jc-pane').hidden; }
  function layoutOf(key) {
    if (!layouts.has(key)) layouts.set(key, { top: '', bottom: '', focus: 'top', split: false });
    return layouts.get(key);
  }

  function button(label, cls, run, title) {
    const b = el('button', cls, label);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', run);
    return b;
  }

  function mount(body) {
    if (!rootEl) {
      rootEl = el('div', 'ct-root');
      const bar = el('div', 'ct-bar');
      const tabs = el('div', 'ct-tabs');
      tabs.setAttribute('role', 'tablist');
      tabs.setAttribute('aria-label', 'Terminals');
      const add = button('+', 'jc-icon ct-add', () => { focusFor = keyNow(); newTerminal(); }, 'New terminal');
      add.setAttribute('aria-label', 'New terminal');
      const split = button('Split', 'jc-mini ct-split', () => toggleSplit(), 'Two terminals, one above the other');
      const sendSel = button('Send to Eden Code', 'jc-mini ct-send', () => sendSelection(), 'Put the selected text in the message');
      sendSel.disabled = true;
      bar.append(tabs, add, el('span', 'jc-spacer'), split, sendSel);
      const note = el('div', 'ct-note');
      note.hidden = true;
      const area = el('div', 'ct-area');
      const top = el('div', 'ct-slot');
      top.dataset.slot = 'top';
      const bottom = el('div', 'ct-slot');
      bottom.dataset.slot = 'bottom';
      for (const slot of [top, bottom]) slot.addEventListener('mousedown', () => { layoutOf(keyNow()).focus = slot.dataset.slot; drawTabs(); updateSend(); });
      area.append(top, bottom);
      rootEl.append(bar, note, area);
    }
    if (body.firstChild !== rootEl || body.childNodes.length !== 1) body.replaceChildren(rootEl);
  }

  function status(text) {
    const area = rootEl.querySelector('.ct-area');
    area.querySelectorAll('.ct-slot').forEach((s) => { s.hidden = true; });
    let p = area.querySelector('.ct-status');
    if (!text) { if (p) p.remove(); return; }
    if (!p) { p = el('p', 'jc-empty ct-status'); area.append(p); }
    p.textContent = text;
  }

  async function render(body) {
    mount(body);
    const key = keyNow();
    if (!F.currentTask() && !project()) { status('Pick a project first.'); return; }
    if (!asked.has(key)) { asked.add(key); F.send({ type: 'cw_terms', ...whereNow(), ref: key }); }
    const folder = folderOf.get(key);
    const items = folder ? lists.get(folder) || [] : null;
    // (while its list comes, no tabs: not another folder's, nor those from before a reconnect)
    if (items === null) { drawTabs(); status('Opening a terminal…'); return; }
    const opening = startFor === key;
    if (opening) startFor = '';
    const extra = F.$('jc-pane-extra');
    if (extra) extra.replaceChildren(mine(el('span', 'jc-dim', folder.split('/').pop())));
    if (!items.length) {
      // One starts when the pane is opened on a folder with none, never after the last one
      // is closed (nor on another session shown).
      if (opening && !making.has(key)) newTerminal();
      drawTabs();
      status(making.has(key) ? 'Starting a shell…' : 'No terminals here: + opens one.');
      return;
    }
    try {
      if (typeof ensureXterm === 'function') await ensureXterm();
    } catch (_) { status('The terminal component didn’t load.'); return; }
    if (!window.Terminal || !window.FitAddon) { status('The terminal component didn’t load.'); return; }
    if (key !== keyNow() || !paneShown()) return;  // (moved on while it loaded)
    status('');
    arrange(key, items);
    drawTabs();
    drawArea();
  }

  // Which terminals the slots show: the ones picked, while they're there; else the first.
  function arrange(key, items) {
    const lay = layoutOf(key);
    const ids = items.map((i) => i.term);
    if (!ids.includes(lay.top)) lay.top = ids.find((t) => t !== lay.bottom) || ids[0];
    if (lay.split) {
      if (!ids.includes(lay.bottom) || lay.bottom === lay.top) lay.bottom = ids.find((t) => t !== lay.top) || '';
      if (!lay.bottom) lay.split = false;
    } else lay.bottom = '';
    if (!lay.split) lay.focus = 'top';
  }

  function currentItems() {
    const folder = folderOf.get(keyNow());
    return folder ? lists.get(folder) || [] : [];
  }

  function drawTabs() {
    if (!rootEl) return;
    const lay = layoutOf(keyNow());
    const focused = lay.focus === 'bottom' && lay.split ? lay.bottom : lay.top;
    const tabs = rootEl.querySelector('.ct-tabs');
    tabs.replaceChildren(...currentItems().map((item) => {
      const shown = item.term === lay.top || (lay.split && item.term === lay.bottom);
      const tab = el('div', `ct-tab${shown ? ' shown' : ''}${item.term === focused ? ' on' : ''}${item.alive ? '' : ' ended'}`);
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(item.term === focused));
      const name = mine(button(item.title, 'ct-tab-name', () => show(item.term)));
      name.title = item.alive ? item.cwd : `${item.cwd} (ended)`;
      const x = button('×', 'ct-tab-x', () => closeTerminal(item.term, x), 'Close this terminal');
      if (armed.has(item.term)) x.classList.add('armed');
      tab.append(name, x);
      return tab;
    }));
    const split = rootEl.querySelector('.ct-split');
    split.setAttribute('aria-pressed', String(lay.split));
    split.disabled = currentItems().length < 1;
    updateSend();
  }

  function viewOf(term) {
    let view = views.get(term);
    if (view) return view;
    const box = el('div', 'jc-term ct-term');
    const xterm = new window.Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace', fontSize: 12.5, cursorBlink: true, allowProposedApi: false, scrollback: 5000, theme: THEME,
    });
    const fit = new window.FitAddon.FitAddon();
    xterm.loadAddon(fit);
    xterm.onData((data) => F.send({ type: 'cw_term_input', term, data }));
    xterm.onSelectionChange(() => updateSend());
    view = { xterm, fit, box, replayed: false, observer: null, opened: false, cols: 0, rows: 0 };
    views.set(term, view);
    F.send({ type: 'cw_term_attach', term });
    return view;
  }

  function fitView(term, view) {
    if (!view.box.isConnected || view.box.offsetParent === null) return;
    try { view.fit.fit(); } catch (_) { return; }
    const { cols, rows } = view.xterm;
    if (cols !== view.cols || rows !== view.rows) {
      view.cols = cols;
      view.rows = rows;
      F.send({ type: 'cw_term_resize', term, cols, rows });
    }
  }

  function drawArea() {
    const key = keyNow();
    const lay = layoutOf(key);
    const area = rootEl.querySelector('.ct-area');
    area.classList.toggle('split', lay.split);
    for (const [slotName, term] of [['top', lay.top], ['bottom', lay.split ? lay.bottom : '']]) {
      const slot = area.querySelector(`.ct-slot[data-slot="${slotName}"]`);
      slot.hidden = !term;
      slot.classList.toggle('focused', lay.split && lay.focus === slotName);
      if (!term) { slot.replaceChildren(); continue; }
      const view = viewOf(term);
      if (slot.firstChild !== view.box) slot.replaceChildren(view.box);
      if (!view.opened) { view.xterm.open(view.box); view.opened = true; }
      if (!view.observer) {
        view.observer = new ResizeObserver(() => fitView(term, view));
        view.observer.observe(view.box);
      }
    }
    requestAnimationFrame(() => {
      for (const term of [lay.top, lay.split ? lay.bottom : '']) if (term && views.has(term)) fitView(term, views.get(term));
      const focusTerm = lay.focus === 'bottom' && lay.split ? lay.bottom : lay.top;
      if (focusTerm && views.has(focusTerm) && paneShown() && focusFor === key) { focusFor = ''; views.get(focusTerm).xterm.focus(); }
    });
  }

  function show(term) {
    focusFor = keyNow();
    const lay = layoutOf(focusFor);
    if (lay.split && lay.focus === 'bottom') {
      if (term === lay.top) lay.top = lay.bottom;
      lay.bottom = term;
    } else {
      if (term === lay.bottom) lay.bottom = lay.top;
      lay.top = term;
    }
    drawTabs();
    drawArea();
  }

  function newTerminal() {
    const key = keyNow();
    making.add(key);
    F.send({ type: 'cw_term_new', ...whereNow(), ref: key });
  }

  function toggleSplit() {
    const key = keyNow();
    focusFor = key;
    const lay = layoutOf(key);
    if (lay.split) { lay.split = false; lay.bottom = ''; lay.focus = 'top'; drawTabs(); drawArea(); return; }
    lay.split = true;
    lay.focus = 'bottom';
    const other = currentItems().find((i) => i.term !== lay.top);
    if (other) { lay.bottom = other.term; drawTabs(); drawArea(); return; }
    lay.wantBottom = true;  // a new one fills the bottom when it comes
    newTerminal();
  }

  function closeTerminal(term, x) {
    focusFor = keyNow();  // (the one left takes the keys)
    if (armed.has(term)) {
      clearTimeout(armed.get(term));
      armed.delete(term);
      F.send({ type: 'cw_term_close', term, force: true });
      return;
    }
    F.send({ type: 'cw_term_close', term });
    if (x) x.disabled = true;
  }

  function focusedView() {
    const lay = layoutOf(keyNow());
    const term = lay.focus === 'bottom' && lay.split ? lay.bottom : lay.top;
    return term ? views.get(term) : null;
  }

  function updateSend() {
    if (!rootEl) return;
    const view = focusedView();
    rootEl.querySelector('.ct-send').disabled = !(view && view.xterm.hasSelection());
  }

  function sendSelection() {
    const view = focusedView();
    const input = F.$('deck-input');
    if (!view || !input || !view.xterm.hasSelection()) return;
    const at = input.selectionStart ?? input.value.length;
    const text = selectionBlock(view.xterm.getSelection(), input.value.slice(0, at));
    input.value = input.value.slice(0, at) + text + input.value.slice(at);
    input.selectionStart = input.selectionEnd = at + text.length;
    input.dispatchEvent(new Event('input'));
    input.focus();
  }

  function dispose(term) {
    const view = views.get(term);
    if (!view) return;
    views.delete(term);
    if (view.observer) view.observer.disconnect();
    try { view.xterm.dispose(); } catch (_) { /* gone already */ }
    view.box.remove();
  }

  F.registerPane('terminal', {
    title: 'Terminal',
    render: (body) => {
      if (away) { away = false; startFor = focusFor = keyNow(); } else startFor = focusFor = '';
      render(body);
    },
  });
  // (closed: the pane hides; another pane shown: its title changes)
  const left = () => { if (!paneShown()) away = true; };
  if (F.$('jc-pane')) new MutationObserver(left).observe(F.$('jc-pane'), { attributes: true, attributeFilter: ['hidden'] });
  if (F.$('jc-pane-title')) new MutationObserver(left).observe(F.$('jc-pane-title'), { childList: true, characterData: true, subtree: true });

  F.on('cw_terms', (ev) => {
    const before = new Set((lists.get(ev.folder) || []).map((i) => i.term));
    lists.set(ev.folder, ev.items || []);
    if (ev.ref) folderOf.set(ev.ref, ev.folder);
    const now = new Set((ev.items || []).map((i) => i.term));
    for (const term of before) if (!now.has(term)) { dispose(term); armed.delete(term); }
    if (paneShown() && folderOf.get(keyNow()) === ev.folder) render(F.$('jc-pane-body'));
  });

  F.on('cw_term_new', (ev) => {
    if (!ev.ref) return;
    making.delete(ev.ref);
    if (ev.error) {  // (too many, or no shell): said, and the pane says it too
      const lay = layoutOf(ev.ref);
      lay.wantBottom = false;
      if (paneShown() && keyNow() === ev.ref && rootEl) {
        if (!currentItems().length) status(ev.error);
        else { lay.split = !!lay.bottom; drawTabs(); drawArea(); }
      }
      return;
    }
    folderOf.set(ev.ref, ev.cwd);
    const lay = layoutOf(ev.ref);
    if (lay.wantBottom) { lay.wantBottom = false; lay.bottom = ev.term; lay.split = true; lay.focus = 'bottom'; } else { lay.top = ev.term; if (lay.split) lay.focus = 'top'; }
  });

  F.on('cw_term_replay', (ev) => {
    const view = views.get(ev.term);
    if (!view || view.replayed) return;
    view.replayed = true;
    view.xterm.reset();
    view.xterm.write(termBytes(ev.data || ''));
    if (!ev.alive) view.xterm.write(`\r\n${t('[this shell has ended]')}\r\n`);
  });

  F.on('cw_term_data', (ev) => {
    const view = views.get(ev.term);
    if (!view || !view.replayed) return;  // (what came before the replay is in it)
    view.xterm.write(termBytes(ev.data));
  });

  F.on('cw_term_exit', (ev) => {
    for (const items of lists.values()) for (const item of items) if (item.term === ev.term) item.alive = false;
    const view = views.get(ev.term);
    if (view && view.replayed) view.xterm.write(`\r\n${t('[this shell has ended]')}\r\n`);
    if (paneShown()) drawTabs();
  });

  F.on('cw_term_busy', (ev) => {
    focusFor = '';  // (nothing closed: nothing new to give the keys to)
    const item = currentItems().find((i) => i.term === ev.term);
    armed.set(ev.term, setTimeout(() => { armed.delete(ev.term); if (paneShown()) drawTabs(); if (busyNote) busyNote.hidden = true; }, 5000));
    if (!rootEl) return;
    busyNote = rootEl.querySelector('.ct-note');
    busyNote.replaceChildren(el('span', '', 'Still running:'), mine(el('code', '', ev.what || '')), el('span', '', 'Click × again to close it anyway.'));
    busyNote.hidden = !item;
    if (paneShown()) drawTabs();
  });

  // A reconnect, or another backend (a restart: its terminals are other ones): what was shown
  // goes, and an open pane is drawn again from the list asked for anew, attaching again to the
  // shells still there.
  F.on('hello', () => {
    for (const term of [...views.keys()]) dispose(term);
    lists.clear();
    folderOf.clear();
    asked.clear();
    making.clear();
    if (paneShown() && rootEl) render(F.$('jc-pane-body'));
  });

  // ── "!" commands, streaming into the transcript ──

  const bangs = new Map();  // ref -> { li, pre, cancel, out }

  F.on('cw_bang_start', (ev) => {
    const entry = typeof bangEntries !== 'undefined' ? bangEntries.get(ev.ref) : null;
    if (!entry || !entry.li) return;
    const pre = mine(el('pre', 'jc-bang-out ct-bang-live'));
    pre.hidden = true;
    const cancel = el('button', 'jc-mini ct-bang-cancel', 'Cancel');
    cancel.type = 'button';
    cancel.title = 'Stop this command';
    cancel.addEventListener('click', () => {
      cancel.disabled = true;
      cancel.textContent = 'Stopping…';
      F.send({ type: 'cw_bang_cancel', ref: ev.ref });
    });
    const head = entry.li.querySelector('.jc-bang-head');
    if (head) head.append(cancel);
    entry.li.append(pre);
    bangs.set(ev.ref, { li: entry.li, pre, cancel, out: liveOutput() });
  });

  F.on('cw_bang_data', (ev) => {
    const b = bangs.get(ev.ref);
    if (!b) return;
    applyOutput(b.out, ev.text, ev.skipped, t);
    const atEnd = b.pre.scrollTop + b.pre.clientHeight >= b.pre.scrollHeight - 8;
    b.pre.hidden = false;
    b.pre.textContent = (b.out.dropped ? `${t(`… (${b.out.dropped} earlier lines)`)}\n` : '') + b.out.lines.join('\n');
    if (atEnd) b.pre.scrollTop = b.pre.scrollHeight;
  });

  // Done: the core draws what it printed (app.js onBang); the live view goes.
  F.on('task_bash', (ev) => {
    const b = bangs.get(ev.ref);
    if (!b) return;
    bangs.delete(ev.ref);
    b.pre.remove();
    b.cancel.remove();
    const state = b.li.querySelector('.jc-bang-state');
    if (ev.cancelled && state) state.textContent = 'Cancelled';
  });
})(typeof window === 'object' ? window : globalThis);
