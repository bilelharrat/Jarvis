// "Bring over from…" (features/code_import.py, code_import.py and its adapters in
// import_sources/): moves what the owner has in Claude Code, Codex, Cursor, Windsurf, Copilot,
// Gemini CLI, Cline, Roo Code, Aider, Zed, OpenCode, Continue, Amp, Kiro, Warp or Junie into
// Eden Code, in one sheet:
// 1. Pick a tool: those found on this computer first, with what was brought over before.
// 2. Preview: everything found, by group, each with what Import would do. Only "new" ones have
//    a box (ticked unless it moves a key, is off in the tool, or would change a default the
//    owner picked); the rest say they already work in Eden Code, need the owner (and where),
//    or can't move (and why). Nothing changes until Import.
// 3. Summary: what came over, what didn't and why, what's left for the owner. Undo import
//    takes away what that tool's import added (never anything of the tool's own).
// And the history from other tools: past chats brought over, read-only.
//
// Entry points: a card in the welcome (no session open) when a tool is found that hasn't been
// brought over and the card wasn't answered (code_import_offered), and Eden Code settings ›
// General › Other coding tools (data-ecs-section="general"), with the code_import_on switch.
// The composer is never touched.
//
// No model calls; text only (textContent): names and paths come from the owner's files, and a
// key never reaches this window (the backend masks them). Pure helpers are exported for
// node --test (tests/web/code-import.test.mjs).
(function (root) {
  'use strict';

  const ON = 'code_import_on';
  const OFFERED = 'code_import_offered';
  const GROUP_ORDER = ['Sign-in', 'Projects', 'Past conversations', 'Rules and instructions', 'MCP servers',
    'Commands and saved prompts', 'Models and modes', 'Settings'];
  const STATUS = {
    new: 'Will come over',
    already: 'Already works',
    added: 'Brought over',
    manual: 'Needs you',
    skip: 'Can’t move',
    error: 'Couldn’t read',
  };

  // The preview's items by group, in GROUP_ORDER (any other group after), each group's own
  // order kept: "new" ones first, then the rest.
  function groups(items) {
    const by = new Map();
    for (const item of items || []) {
      const g = item.group || 'Settings';
      if (!by.has(g)) by.set(g, []);
      by.get(g).push(item);
    }
    const rank = (s) => (s === 'new' ? 0 : s === 'added' ? 1 : s === 'already' ? 2 : 3);
    const names = [...by.keys()].sort((a, b) => {
      const ia = GROUP_ORDER.indexOf(a), ib = GROUP_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return names.map((name) => ({ name, items: by.get(name).slice().sort((a, b) => rank(a.status) - rank(b.status)) }));
  }

  // The line over the preview: how many of each.
  function summary(counts) {
    const c = counts || {};
    const parts = [];
    if (c.new) parts.push(`${c.new} to bring over`);
    if (c.already || c.added) parts.push(`${(c.already || 0) + (c.added || 0)} already in Eden Code`);
    if (c.manual) parts.push(`${c.manual} need you`);
    if (c.skip) parts.push(`${c.skip} can’t move`);
    if (c.error) parts.push(`${c.error} couldn’t be read`);
    return parts.join(' · ') || 'Nothing found to bring over.';
  }

  // The ids Import sends: the ticked boxes of items that can come.
  function chosen(items, ticks) {
    return (items || []).filter((i) => i.can_import && (ticks && i.id in ticks ? ticks[i.id] : i.checked)).map((i) => i.id);
  }

  // The tools in the picker: found ones first, then by name; and whether the welcome's card
  // shows (the card not answered and, once the owner has looked, a tool found that wasn't
  // brought over). Nothing looks on its own: reading another app's folders unasked makes macOS
  // say "Eden Code tried to read data from other apps" (Data Access Blocked), so the window asks
  // for cimp_sources only when the owner opens the sheet. Before that (sources null) the card
  // is a plain offer, [] here, that names no tool.
  function ordered(sources) {
    return (sources || []).slice().sort((a, b) => (b.found - a.found) || 0);
  }
  function offer(sources, features) {
    if ((features || {})[OFFERED] === true) return null;
    if (sources == null) return [];
    const fresh = sources.filter((s) => s.found && !(s.imported && s.imported.at));
    return fresh.length ? fresh : null;
  }
  function offerTitle(fresh) {
    const names = (fresh || []).map((s) => s.name);
    if (!names.length) return 'Coming from another coding tool?';
    if (names.length === 1) return `Bring over from ${names[0]}`;
    return names[0] === 'Claude Code' ? 'Bring over from Claude Code and more' : 'Bring over from your other coding tools';
  }
  function when(seconds) {
    if (!seconds) return '';
    const d = new Date(seconds * 1000);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function imported(s) {
    const i = s && s.imported;
    if (!i || !i.at) return '';
    const n = (i.projects || 0) + (i.mcp || 0) + (i.rules || 0) + (i.commands || 0) + (i.prefs || 0) + (i.chats || 0);
    return `Brought over ${when(i.at)} (${n})`;
  }

  const api = { groups, summary, chosen, ordered, offer, offerTitle, imported, STATUS, ON, OFFERED };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, send, t } = F;
  const doc = root.document;
  let features = {};
  let sources = null;
  let preview = null;  // the last cimp_preview
  let ticks = {};  // id -> ticked, as the owner changed them
  let view = 'pick';  // pick | preview | done | history | chat
  let done = null;
  let history = [];
  let chat = null;
  let busy = false;
  let dialog = null;
  let body = null;

  function button(label, cls, run) {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', (e) => { e.preventDefault(); run(b); });
    return b;
  }
  function raw(tag, cls, text) {  // (the owner's own words: never translated)
    const n = el(tag, cls, text);
    n.dataset.noI18n = '';
    return n;
  }

  // ── the sheet ──

  function open(source) {
    if (!dialog) {
      dialog = el('dialog', 'cimp-dialog');
      dialog.setAttribute('aria-labelledby', 'cimp-title');
      const head = el('div', 'cimp-head');
      const title = el('h2', 'cimp-title', 'Bring over from…');
      title.id = 'cimp-title';
      head.append(title, button('Close', 'jc-btn small', close));
      body = el('div', 'cimp-body');
      dialog.append(head, body);
      dialog.addEventListener('close', () => { view = 'pick'; });
      (F.$('cc') || doc.body).append(dialog);
    }
    if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal(); else dialog.setAttribute('open', '');
    if (source) pick(source); else { view = 'pick'; send({ type: 'cimp_sources' }); }
    draw();
  }
  function close() {
    if (!dialog) return;
    if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
    view = 'pick';
  }
  function pick(id) {
    view = 'preview';
    preview = { source: id, loading: true, items: [], counts: {} };
    ticks = {};
    send({ type: 'cimp_preview', source: id });
    draw();
  }

  function drawPick() {
    body.append(el('p', 'cimp-intro', 'Eden Code finds what your other coding tools keep on this computer and shows you everything before anything changes. Their own files are only ever read.'));
    if (!sources) { body.append(el('p', 'cimp-note', 'Looking for your coding tools…')); return; }
    const list = el('div', 'cimp-sources');
    for (const s of ordered(sources)) {
      const row = el('button', `cimp-source${s.found ? '' : ' off'}`);
      row.type = 'button';
      row.disabled = !s.found;
      const name = el('span', 'cimp-source-name', s.name);
      const note = raw('span', 'cimp-source-note', s.found ? (imported(s) || t('Found on this computer')) : t('Not found'));
      row.append(name, el('span', 'cimp-source-blurb', s.blurb || ''), note);
      row.addEventListener('click', () => pick(s.id));
      list.append(row);
    }
    body.append(list);
    body.append(button('History from other tools', 'jc-btn small', () => { view = 'history'; send({ type: 'cimp_history' }); draw(); }));
  }

  function drawPreview() {
    const back = button('‹ All tools', 'jc-btn small cimp-back', () => { view = 'pick'; send({ type: 'cimp_sources' }); draw(); });
    body.append(back);
    if (!preview || preview.loading) { body.append(el('p', 'cimp-note', 'Reading its settings…')); return; }
    if (preview.error) { body.append(el('p', 'cimp-note', preview.error)); return; }
    body.append(raw('h3', 'cimp-tool', preview.name || preview.source));
    body.append(raw('p', 'cimp-summary', t(summary(preview.counts))));
    const list = el('div', 'cimp-groups');
    for (const g of groups(preview.items)) {
      const box = el('section', 'cimp-group');
      box.setAttribute('aria-label', t(g.name));
      const head = el('p', 'jcs-label cimp-group-name', g.name);
      head.append(raw('span', 'cimp-count', ` ${g.items.length}`));
      box.append(head);
      const group = el('div', 'jcs-group');
      for (const item of g.items) group.append(itemRow(item));
      box.append(group);
      list.append(box);
    }
    body.append(list);
    const acts = el('div', 'cimp-acts');
    const n = chosen(preview.items, ticks).length;
    const go = button(n ? `Import ${n}` : 'Nothing ticked', 'jc-btn filled', () => {
      busy = true;
      send({ type: 'cimp_import', source: preview.source, items: chosen(preview.items, ticks) });
      draw();
    });
    go.dataset.noI18n = '';
    go.disabled = !n || busy;
    const src = (sources || []).find((s) => s.id === preview.source);
    if (src && src.imported && src.imported.at) acts.append(button('Undo import', 'jc-btn danger', undo));
    acts.append(go);
    body.append(acts);
  }

  function itemRow(item) {
    const row = el(item.can_import ? 'label' : 'div', `jcs-row cimp-item ${item.status}`);
    const text = el('span', 'cimp-item-text');
    text.append(raw('span', 'cimp-item-title', item.title));
    if (item.detail) text.append(raw('small', 'cimp-item-detail', item.detail));
    if (item.why) text.append(el('small', 'cimp-item-why', item.why));
    const pill = el('span', `cimp-pill ${item.status}`, STATUS[item.status] || item.status);
    if (item.can_import) {
      const box = el('input', 'cimp-check');
      box.type = 'checkbox';
      box.checked = item.id in ticks ? ticks[item.id] : !!item.checked;
      box.setAttribute('aria-label', item.title);
      box.addEventListener('change', () => { ticks[item.id] = box.checked; draw(); });
      row.append(box, text, pill);
    } else {
      row.append(el('span', 'cimp-check-space'), text, pill);
    }
    return row;
  }

  function undo() {
    if (!preview) return;
    busy = true;
    send({ type: 'cimp_undo', source: preview.source });
    draw();
  }

  function list(title, rows, cls) {
    if (!rows || !rows.length) return null;
    const box = el('section', `cimp-result ${cls}`);
    box.append(el('p', 'jcs-label', title));
    const group = el('div', 'jcs-group');
    for (const r of rows) {
      const row = el('div', 'jcs-row');
      const text = el('span');
      text.append(raw('span', '', r.title));
      if (r.why) text.append(el('small', '', r.why));
      row.append(text);
      group.append(row);
    }
    box.append(group);
    return box;
  }

  function drawDone() {
    if (!done) return;
    const undone = done.kind === 'undone';
    body.append(raw('h3', 'cimp-tool', preview ? preview.name : ''));
    body.append(el('p', 'cimp-summary', undone ? 'Undone: what this import added is gone from Eden Code. Nothing of the tool’s own was touched.' : 'Done. Nothing of the tool’s own was changed.'));
    for (const part of undone
      ? [list('Taken away', done.removed, 'ok'), list('Kept', done.kept, 'kept')]
      : [list('Brought over', done.added, 'ok'), list('Didn’t come over', done.skipped, 'kept'), list('Left for you', done.manual, 'manual')]) {
      if (part) body.append(part);
    }
    const acts = el('div', 'cimp-acts');
    if (!undone && done.added && done.added.length) acts.append(button('Undo import', 'jc-btn danger', undo));
    acts.append(button('Back to the list', 'jc-btn', () => { view = 'preview'; draw(); }));
    acts.append(button('Done', 'jc-btn filled', close));
    body.append(acts);
  }

  function drawHistory() {
    body.append(button('‹ All tools', 'jc-btn small cimp-back', () => { view = 'pick'; draw(); }));
    body.append(el('p', 'cimp-intro', 'Past chats brought over from your other tools, to read. They stay in each tool’s own files.'));
    if (!history.length) { body.append(el('p', 'cimp-note', 'None yet: bring a tool’s past chats over first.')); return; }
    const group = el('div', 'jcs-group cimp-history');
    for (const c of history.slice(0, 500)) {
      const row = el('button', 'jcs-row cimp-chat-row');
      row.type = 'button';
      const text = el('span');
      text.append(raw('span', '', c.title));
      text.append(raw('small', '', [c.tool, c.project_name, when(c.when)].filter(Boolean).join(' · ')));
      row.append(text);
      row.addEventListener('click', () => { view = 'chat'; chat = { ...c, loading: true }; send({ type: 'cimp_chat', source: c.source, id: c.id }); draw(); });
      group.append(row);
    }
    body.append(group);
  }

  function drawChat() {
    body.append(button('‹ History', 'jc-btn small cimp-back', () => { view = 'history'; draw(); }));
    if (!chat) return;
    body.append(raw('h3', 'cimp-tool', chat.title || ''));
    if (chat.loading) { body.append(el('p', 'cimp-note', 'Reading it…')); return; }
    if (chat.error) { body.append(raw('p', 'cimp-note', chat.error)); return; }
    const box = el('div', 'cimp-messages');
    box.setAttribute('role', 'log');
    for (const m of chat.messages || []) {
      const b = el('div', `cimp-msg ${m.role === 'user' ? 'user' : 'assistant'}`);
      b.append(raw('p', '', m.text));
      box.append(b);
    }
    body.append(box);
  }

  function draw() {
    if (!body) return;
    body.replaceChildren();
    if (view === 'pick') drawPick();
    else if (view === 'preview') drawPreview();
    else if (view === 'done') drawDone();
    else if (view === 'history') drawHistory();
    else if (view === 'chat') drawChat();
  }

  // ── the welcome's card ──

  const welcome = doc && doc.getElementById('cc-welcome');
  const card = el('div', 'jc-card gs-card cimp-card');
  card.id = 'cimp-card';
  card.setAttribute('role', 'group');
  card.hidden = true;
  function drawCard() {
    if (!welcome) return;
    if (!card.isConnected) {
      const past = doc.getElementById('cc-past-wrap');
      if (past && past.parentNode === welcome) welcome.insertBefore(card, past); else welcome.append(card);
    }
    const fresh = offer(sources, features);
    card.hidden = !fresh;
    if (!fresh) { card.replaceChildren(); return; }
    const title = offerTitle(fresh);
    card.setAttribute('aria-label', t(title));
    const names = fresh.slice(0, 3).map((s) => s.name).join(', ') + (fresh.length > 3 ? ` +${fresh.length - 3}` : '');
    const text = fresh.length
      ? raw('p', 'gs-text', `${t('Found on this computer:')} ${names}. ${t('See what can come over (projects, past conversations, rules, MCP servers, commands) before anything changes.')}`)
      : el('p', 'gs-text', 'Bring over projects, past conversations, rules, MCP servers and commands from Claude Code, Codex, Cursor and others. Eden Code looks only when you ask, and shows you everything before anything changes.');
    const row = el('div', 'gs-actions');
    row.append(
      button('Have a look', 'jc-btn small filled', () => open(fresh.length === 1 ? fresh[0].id : '')),
      button('Not now', 'jc-btn small', () => { features = { ...features, [OFFERED]: true }; send({ type: 'feature_prefs', changes: { [OFFERED]: true } }); drawCard(); }),
    );
    card.replaceChildren(el('p', 'jc-label', title), text, row);
  }

  // ── Eden Code settings › General › Other coding tools ──

  const toggle = el('button', 'jcs-switch');
  toggle.type = 'button';
  toggle.id = 'cimp-on';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-label', 'Use what you brought over');
  toggle.addEventListener('click', () => {
    const on = toggle.getAttribute('aria-checked') !== 'true';
    toggle.setAttribute('aria-checked', String(on));
    send({ type: 'feature_prefs', changes: { [ON]: on } });
  });
  (function addSetting() {
    const general = doc && doc.getElementById('jcs-general');
    if (!general) return;
    const label = el('p', 'jcs-label', 'Other coding tools');
    label.dataset.ecsSection = 'general';
    const group = el('div', 'jcs-group cimp-setting');
    group.dataset.ecsSection = 'general';
    const r1 = el('div', 'jcs-row');
    const t1 = el('span');
    t1.append(doc.createTextNode(t('Bring over from another tool')),
      el('small', '', 'Claude Code, Codex, Cursor, Windsurf, Copilot, Gemini CLI, Cline, Aider, Zed and more: projects, past conversations, rules, MCP servers and commands. You see everything first.'));
    r1.append(t1, button('Choose…', 'jc-btn small', () => open('')));
    const r2 = el('div', 'jcs-row');
    const t2 = el('span');
    t2.append(doc.createTextNode(t('Use what you brought over')),
      el('small', '', 'Sessions read the rules files you brought over and get the MCP servers. Off: they’re kept, but not used.'));
    r2.append(t2, toggle);
    const r3 = el('div', 'jcs-row');
    r3.append(el('span', '', 'History from other tools'), button('Open', 'jc-btn small', () => { open(''); view = 'history'; send({ type: 'cimp_history' }); draw(); }));
    group.append(r1, r2, r3);
    const foot = general.querySelector('.jcs-foot');
    general.insertBefore(label, foot);
    general.insertBefore(group, foot);
  })();

  // ── events ──

  function onPrefs(p) {
    if (!p || !p.features) return;
    features = p.features;
    toggle.setAttribute('aria-checked', String(features[ON] !== false));
    drawCard();
  }
  // (No cimp_sources here: the backend looks through other apps' folders only when the sheet opens.)
  F.on('hello', (ev) => { onPrefs(ev.prefs); }, { replay: true });
  F.on('prefs', onPrefs);
  F.on('cimp_sources', (ev) => { sources = ev.sources || []; drawCard(); if (view === 'pick') draw(); });
  F.on('cimp_preview', (ev) => {
    if (!preview || ev.source !== preview.source) return;
    preview = ev;
    busy = false;
    if (view === 'preview') draw();
  });
  F.on('cimp_done', (ev) => { busy = false; done = { kind: 'done', ...ev }; view = 'done'; send({ type: 'cimp_sources' }); draw(); });
  F.on('cimp_undone', (ev) => { busy = false; done = { kind: 'undone', ...ev }; view = 'done'; send({ type: 'cimp_sources' }); draw(); });
  F.on('cimp_history', (ev) => { history = ev.chats || []; if (view === 'history') draw(); });
  F.on('cimp_chat', (ev) => {
    if (!chat || ev.id !== chat.id) return;
    chat = { ...chat, ...ev, loading: false };
    if (view === 'chat') draw();
  });
  if (F.registerSlash) F.registerSlash({ name: 'import', help: 'Bring over from Claude Code, Cursor, Codex and other tools', withoutSession: true, run() { open(''); return true; } });
  root.edenImport = { open };  // (the welcome and Settings call it; a test may too)
})(typeof window === 'object' ? window : globalThis);
