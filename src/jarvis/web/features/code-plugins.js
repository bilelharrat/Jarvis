// Claude Code's plugins in Jarvis Code (features/code_plugins.py): the Plugins pane (More ›
// Plugins and skills, /plugins). Installed plugins, switched on and off, their inventory and
// what they add to every session's context, removed (a second press); the plugins the
// owner's marketplaces offer, installed after a card; marketplaces added (after a card) or
// removed; the project's and the owner's agents, skills, commands and hooks, edited in place
// (saved only over the version opened); and what fills the session's context now.
//
// Names, descriptions, file contents and errors are data: text only (textContent, a
// textarea's value), marked data-no-i18n. Pure helpers are exported for node --test
// (tests/web/code-plugins.test.mjs).
(function (root) {
  'use strict';

  const KINDS = { agents: 'Agent', skills: 'Skill', commands: 'Command' };
  const HOOK_SCOPES = { project: 'This project, shared', local: 'This project, just me', user: 'All my projects' };

  // The available plugins a search keeps (name, description or marketplace), at most 60.
  function filterAvailable(available, query) {
    const q = String(query || '').trim().toLowerCase();
    const found = (available || []).filter((p) => !q || [p.name, p.description, p.marketplace, p.id].some((s) => String(s || '').toLowerCase().includes(q)));
    return found.slice(0, 60);
  }

  // 1,200 tokens as "1.2k", under a thousand as it is.
  function fmtTokens(n) {
    const v = Math.max(0, Number(n) || 0);
    return v >= 1000 ? `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(Math.round(v));
  }

  // A name the owner types for a new file: what the backend takes, or '' when it isn't one.
  function cleanName(kind, text) {
    const s = String(text || '').trim();
    const part = '[A-Za-z0-9][A-Za-z0-9_.\\-]{0,63}';
    const re = new RegExp(kind === 'commands' ? `^(?:${part}/)?${part}$` : `^${part}$`);
    return re.test(s) ? s : '';
  }

  const api = { filterAvailable, fmtTokens, cleanName, KINDS };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, t } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };

  const states = new Map();  // task id -> its latest cx_state
  const details = new Map();  // plugin id -> { text, tokens }
  let open = null;  // the file in the editor: { id, file_kind, scope, name, text, stamp, exists, conflict?, error? }
  let draft = null;  // what's typed in the editor, kept across redraws
  let context = null;  // the latest cx_context
  let query = '';
  let marketDraft = '';
  let armed = null;  // { key, timer }: a Remove or Delete pressed once
  let paneBody = null;
  let asked = { id: null, at: 0 };
  const paneShown = () => paneBody && paneBody.isConnected && typeof currentPane !== 'undefined' && currentPane === 'plugins';

  function ask(task) {
    const now = Date.now();
    if (asked.id === task.id && now - asked.at < 400) return;
    asked = { id: task.id, at: now };
    F.send({ type: 'cx_state', id: task.id });
  }

  function button(label, cls, run) {
    const b = el('button', `jc-btn small ${cls}`, label);
    b.type = 'button';
    b.addEventListener('click', run);
    return b;
  }

  // A button that acts on its second press (the first arms it for a few seconds).
  function twice(key, label, again, cls, run) {
    const on = armed && armed.key === key;
    return button(on ? again : label, `${cls}${on ? ' armed' : ''}`, () => {
      if (!armed || armed.key !== key) {
        if (armed) clearTimeout(armed.timer);
        armed = { key, timer: setTimeout(() => { armed = null; redraw(); }, 4000) };
        redraw();
        return;
      }
      clearTimeout(armed.timer);
      armed = null;
      run();
    });
  }

  function section(title, ...nodes) {
    const box = el('section', 'cx-section');
    box.append(el('p', 'jc-label', title), ...nodes);
    return box;
  }

  function installedRow(task, p) {
    const li = el('li', 'cx-plugin');
    li.dataset.plugin = p.id;
    const head = el('div', 'cx-head');
    head.append(mine(el('strong', 'cx-name', p.id)));
    if (p.version) head.append(mine(el('small', 'cx-version', p.version)));
    const sw = el('button', 'jcs-switch cx-enable');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(!!p.enabled));
    sw.setAttribute('aria-label', t('On'));
    sw.addEventListener('click', () => F.send({ type: 'cx_enable', id: task.id, plugin: p.id, on: !p.enabled }));
    head.append(sw);
    li.append(head);
    const acts = el('div', 'cx-actions');
    const shown = details.get(p.id);
    acts.append(button(shown ? 'Hide what’s in it' : 'What’s in it', 'cx-details', () => {
      if (details.has(p.id)) { details.delete(p.id); redraw(); } else F.send({ type: 'cx_details', id: task.id, plugin: p.id });
    }));
    acts.append(twice(`rm:${p.id}`, 'Remove', 'Press again to remove', 'cx-remove', () => F.send({ type: 'cx_uninstall', id: task.id, plugin: p.id })));
    li.append(acts);
    if (shown) {
      if (shown.tokens !== null && shown.tokens !== undefined) {
        const cost = el('p', 'cx-cost');
        cost.append(el('span', '', 'Adds to every session:'), document.createTextNode(' '), mine(el('strong', '', `~${fmtTokens(shown.tokens)}`)), document.createTextNode(' '), el('span', '', 'tokens'));
        li.append(cost);
      }
      li.append(mine(el('pre', 'cx-details-text', shown.text || '')));
    }
    return li;
  }

  function availableRow(task, p) {
    const li = el('li', 'cx-plugin');
    li.dataset.plugin = p.id;
    const text = el('span', 'cx-text');
    const title = el('span', 'cx-title');
    title.append(mine(el('strong', '', p.name || p.id)), mine(el('small', 'cx-market', p.marketplace)));
    text.append(title);
    if (p.description) text.append(mine(el('small', 'cx-desc', p.description)));
    li.append(text, button('Install', 'cx-install', () => F.send({ type: 'cx_install', id: task.id, plugin: p.id })));
    return li;
  }

  function editor(task) {
    const box = el('div', 'cx-editor');
    const head = el('div', 'cx-head');
    const label = open.file_kind === 'hooks' ? el('strong', '', 'Hooks') : el('strong', '', KINDS[open.file_kind] || open.file_kind);
    head.append(label);
    if (open.name) head.append(mine(el('code', 'cx-file-name', open.name)));
    head.append(el('small', 'cx-scope', HOOK_SCOPES[open.scope] || (open.scope === 'project' ? 'This project' : 'All my projects')));
    head.append(button('Close', 'cx-close', () => { open = null; draft = null; redraw(); }));
    box.append(head);
    if (open.conflict) {
      const bar = el('div', 'cx-conflict');
      bar.append(el('span', '', 'It changed on disk since you opened it.'),
        button('Load theirs', 'cx-theirs', () => { draft = null; F.send({ type: 'cx_read', id: task.id, kind: open.file_kind, scope: open.scope, name: open.name }); }),
        button('Save mine anyway', 'cx-force', () => F.send({ type: 'cx_write', id: task.id, kind: open.file_kind, scope: open.scope, name: open.name, text: area.value, stamp: open.conflict })));
      box.append(bar);
    } else if (open.error) box.append(mine(el('p', 'cr-error', open.error)));
    const area = el('textarea', 'jc-field cx-text-area');
    area.spellcheck = false;
    area.value = draft !== null ? draft : (open.text || '');
    area.setAttribute('aria-label', 'The file');
    area.setAttribute('data-no-i18n', '');
    area.addEventListener('input', () => { draft = area.value; });
    area.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); } });
    const save = () => F.send({ type: 'cx_write', id: task.id, kind: open.file_kind, scope: open.scope, name: open.name, text: area.value, stamp: open.stamp || '' });
    const acts = el('div', 'cx-actions');
    acts.append(button('Save', 'filled cx-save', save));
    if (open.file_kind !== 'hooks' && open.exists) {
      acts.append(twice(`del:${open.file_kind}:${open.scope}:${open.name}`, 'Delete', 'Press again to delete', 'cx-delete',
        () => F.send({ type: 'cx_delete', id: task.id, kind: open.file_kind, scope: open.scope, name: open.name, stamp: open.stamp || '' })));
    }
    if (open.saved) acts.append(el('span', 'cr-note cx-saved', 'Saved.'));
    box.append(area, acts);
    return box;
  }

  function filesSection(task, state) {
    const parts = [];
    const files = state.files || [];
    if (!files.length) parts.push(el('p', 'jc-dim cr-none', 'No agents, skills or commands of your own yet.'));
    else {
      const ul = el('ul', 'jc-list cx-files');
      ul.append(...files.map((f) => {
        const li = el('li', 'cx-file');
        li.dataset.file = `${f.kind}:${f.scope}:${f.name}`;
        const b = el('button', 'cx-open');
        b.type = 'button';
        b.append(el('span', 'cx-kind', KINDS[f.kind] || f.kind), mine(el('code', '', f.name)), el('small', '', f.scope === 'project' ? 'This project' : 'All my projects'));
        b.addEventListener('click', () => { draft = null; F.send({ type: 'cx_read', id: task.id, kind: f.kind, scope: f.scope, name: f.name }); });
        li.append(b);
        return li;
      }));
      parts.push(ul);
    }
    // A new one: its kind, where, and a name.
    const row = el('div', 'cx-row cx-new');
    const kind = el('select', 'jc-field cx-new-kind');
    kind.setAttribute('aria-label', 'What to make');
    for (const [k, label] of Object.entries(KINDS)) { const o = el('option', '', label); o.value = k; kind.append(o); }
    const scope = el('select', 'jc-field cx-new-scope');
    scope.setAttribute('aria-label', 'For');
    for (const [s, label] of [['project', 'This project'], ['user', 'All my projects']]) { const o = el('option', '', label); o.value = s; scope.append(o); }
    const name = el('input', 'jc-field cx-new-name');
    name.placeholder = 'A name, like reviewer';
    name.setAttribute('aria-label', 'Its name');
    const note = el('span', 'cr-error cx-new-note');
    const make = button('New', 'cx-make', () => {
      const clean = cleanName(kind.value, name.value);
      if (!clean) { note.textContent = t('A name is letters, digits, dots, dashes or underscores.'); name.focus(); return; }
      note.textContent = '';
      draft = null;
      F.send({ type: 'cx_read', id: task.id, kind: kind.value, scope: scope.value, name: clean });
    });
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); make.click(); } });
    const named = el('div', 'cx-row cx-new-name-row');
    row.append(kind, scope);
    named.append(name, make);
    parts.push(row, named, note);
    const hooks = el('div', 'cx-hooks');
    hooks.append(el('span', 'jc-dim', 'Hooks:'));
    for (const [s, label] of Object.entries(HOOK_SCOPES)) {
      hooks.append(button(label, `cx-hooks-${s}`, () => { draft = null; F.send({ type: 'cx_read', id: task.id, kind: 'hooks', scope: s }); }));
    }
    parts.push(hooks);
    if (open && open.id === task.id) parts.push(editor(task));
    return parts;
  }

  function contextSection(task) {
    const parts = [];
    const acts = el('div', 'cx-actions');
    acts.append(button(context && context.id === task.id ? 'Check again' : 'Check', 'cx-context', () => F.send({ type: 'cx_context', id: task.id })));
    parts.push(acts);
    if (!context || context.id !== task.id) return parts;
    if (!context.live) { parts.push(el('p', 'jc-dim cr-none', 'The session isn’t running: what fills its context shows once it is.')); return parts; }
    if (context.total) {
      const sum = el('p', 'jc-dim cx-total');
      sum.append(el('span', '', 'In its context now:'), document.createTextNode(' '), mine(el('span', '', `${fmtTokens(context.total)}${context.max ? ` / ${fmtTokens(context.max)}` : ''}`)), document.createTextNode(' '), el('span', '', 'tokens'));
      parts.push(sum);
    }
    const rows = context.rows || [];
    if (!rows.length) { parts.push(el('p', 'jc-dim cr-none', 'No skills, agents, MCP tools or memory files in it.')); return parts; }
    const ul = el('ul', 'jc-list cx-context-list');
    ul.append(...rows.map((r) => {
      const li = el('li');
      li.append(el('small', 'cx-group', r.group), mine(el('span', '', r.name)), mine(el('small', 'cx-tokens', fmtTokens(r.tokens))));
      return li;
    }));
    parts.push(ul);
    return parts;
  }

  function render(body, task) {
    paneBody = body;
    if (!task) { body.replaceChildren(el('p', 'jc-empty', 'Open a session to see its plugins.')); return; }
    const state = states.get(task.id);
    if (!state) { body.replaceChildren(el('p', 'jc-empty', 'Reading plugins…')); return; }
    const parts = [];
    if (state.error) parts.push(mine(el('p', 'cr-error', state.error)));
    if (state.note) parts.push(mine(el('p', 'cr-note', state.note)));
    const installed = state.installed || [];
    const list = el('ul', 'jc-list cx-list');
    list.append(...installed.map((p) => installedRow(task, p)));
    parts.push(section('Installed', installed.length ? list : el('p', 'jc-dim cr-none', 'No plugins installed.')));
    const search = el('input', 'jc-field cx-search');
    search.placeholder = 'Search the marketplaces’ plugins';
    search.setAttribute('aria-label', 'Search plugins');
    search.value = query;
    const found = el('ul', 'jc-list cx-list cx-available');
    const fill = () => { found.replaceChildren(...filterAvailable(state.available, query).map((p) => availableRow(task, p))); };
    search.addEventListener('input', () => { query = search.value; fill(); });
    fill();
    parts.push(section('Available', search, (state.available || []).length ? found : el('p', 'jc-dim cr-none', 'Add a marketplace to see its plugins.'),
      el('p', 'jc-dim cr-intro', 'Installing asks first, with what the plugin brings: its hooks and MCP servers run on this Mac.')));
    const markets = el('ul', 'jc-list cx-list');
    markets.append(...(state.marketplaces || []).map((m) => {
      const li = el('li', 'cx-market-row');
      li.dataset.market = m.name;
      const text = el('span');
      text.append(mine(el('strong', '', m.name)), mine(el('small', '', m.where)));
      li.append(text, button('Update', 'cx-update', () => F.send({ type: 'cx_market', id: task.id, update: m.name })),
        twice(`mk:${m.name}`, 'Remove', 'Press again to remove', 'cx-market-remove', () => F.send({ type: 'cx_market', id: task.id, remove: m.name })));
      return li;
    }));
    const add = el('div', 'cx-row cx-market-add');
    const source = el('input', 'jc-field cx-market-input');
    source.placeholder = 'owner/repo, an address or a folder';
    source.setAttribute('aria-label', 'A marketplace to add');
    source.value = marketDraft;
    source.addEventListener('input', () => { marketDraft = source.value; });
    const go = () => { const s = source.value.trim(); if (s) { marketDraft = ''; F.send({ type: 'cx_market', id: task.id, add: s }); } };
    source.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    add.append(source, button('Add', 'cx-market-go', go));
    parts.push(section('Marketplaces', ...(state.marketplaces || []).length ? [markets] : [], add));
    parts.push(section('Agents, skills, commands and hooks', ...filesSection(task, state)));
    parts.push(section('What fills this session’s context', ...contextSection(task)));
    body.replaceChildren(...parts);
  }

  function redraw() {
    const task = F.currentTask();
    if (!paneShown() || !task) return;
    const focused = document.activeElement;
    const which = focused && focused.classList ? ['cx-search', 'cx-market-input', 'cx-text-area', 'cx-new-name'].find((c) => focused.classList.contains(c)) : null;
    const caret = which && typeof focused.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null;
    render(paneBody, task);
    if (which) {
      const again = paneBody.querySelector(`.${which}`);
      if (again) { again.focus(); if (caret) again.setSelectionRange(...caret); }
    }
  }

  F.registerPane('plugins', { title: 'Plugins', render(body, task) { render(body, task); if (task) ask(task); } });
  F.registerMoreItem({ label: 'Plugins and skills', note: 'Plugins, agents, skills, commands and hooks', run: () => F.openPane('plugins') });
  F.registerSlash({ name: 'plugins', help: 'Plugins, agents, skills and hooks', run() { F.openPane('plugins'); return true; } });

  F.on('cx_state', (ev) => { states.set(ev.id, ev); redraw(); });
  F.on('cx_details', (ev) => { details.set(ev.plugin, { text: ev.text, tokens: ev.tokens }); redraw(); });
  F.on('cx_file', (ev) => {
    if (ev.deleted) { open = null; draft = null; redraw(); return; }
    if (ev.conflict !== undefined || (ev.error && open)) { open = { ...open, conflict: ev.conflict, error: ev.error }; redraw(); return; }
    if (ev.error) { const task = F.currentTask(); if (task) states.set(task.id, { ...(states.get(task.id) || {}), error: ev.error }); redraw(); return; }
    open = { ...ev, conflict: undefined };
    if (!ev.saved) draft = null;
    redraw();
  });
  F.on('cx_context', (ev) => { context = ev; redraw(); });
})(typeof window === 'object' ? window : globalThis);
