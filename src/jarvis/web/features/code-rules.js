// Permission rules (features/code_rules.py): the Permissions pane, in place of the built-in
// one, and all it had (the read-only commands switch, the commands a session won't ask about
// again) with the project's own rules: deny, ask or allow, in Claude Code's rule syntax, a
// field to add one, and import from and export to the project's .claude settings files (a
// second press writes).
//
// Rules, project and file names are data: text only (textContent), marked data-no-i18n.
// Pure helpers are exported for node --test (tests/web/code-rules.test.mjs).
(function (root) {
  'use strict';

  const BEHAVIORS = ['deny', 'ask', 'allow'];
  const HEADS = { deny: 'Deny', ask: 'Ask first', allow: 'Allow' };
  const NOTES = {
    deny: 'Never, in any mode.',
    ask: 'A card every time, even in Bypass.',
    allow: 'Without asking.',
  };

  // What a rule is about, for its badge: web, mcp, files, command or tool.
  function ruleKind(rule) {
    const text = String(rule || '');
    if (text.startsWith('mcp__')) return 'mcp';
    const m = /^([A-Za-z]+)(?:\((.*)\))?$/s.exec(text);
    if (!m) return 'tool';
    if (m[1] === 'WebFetch' || m[1] === 'WebSearch') return 'web';
    if (m[1] === 'Bash') return 'command';
    if (m[2] !== undefined && ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Grep', 'Glob', 'LS', 'NotebookRead'].includes(m[1])) return 'files';
    return 'tool';
  }

  // The rules in a project's .claude settings files, as rows: [file, behavior, rule].
  function claudeRows(claude) {
    const rows = [];
    for (const [file, rules] of Object.entries(claude || {})) {
      for (const behavior of BEHAVIORS) {
        for (const rule of (rules && rules[behavior]) || []) rows.push([file, behavior, String(rule)]);
      }
    }
    return rows;
  }

  // How many rules there are in all ({deny, ask, allow}).
  function count(rules) {
    return BEHAVIORS.reduce((n, b) => n + (((rules || {})[b] || []).length), 0);
  }

  const api = { ruleKind, claudeRows, count, BEHAVIORS };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, t } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };
  const KIND_LABEL = { web: 'Web', mcp: 'MCP', files: 'Files', command: 'Command', tool: 'Tool' };

  const states = new Map();  // task id -> its latest cr_state
  let readOnly = true;  // prefs.code_read_only
  let behavior = 'deny';  // what the add field adds
  let draft = '';  // what's typed there, kept across redraws
  let asked = { id: null, at: 0 };
  let paneBody = null;
  let armed = null;  // { target, timer }: an export pressed once, waiting for the second press
  const paneShown = () => paneBody && paneBody.isConnected && typeof currentPane !== 'undefined' && currentPane === 'rules';

  function ask(task) {
    const now = Date.now();
    if (asked.id === task.id && now - asked.at < 400) return;  // (opening the pane asks twice)
    asked = { id: task.id, at: now };
    F.send({ type: 'cr_state', id: task.id });
  }

  function readOnlySwitch() {
    const row = el('div', 'jc-audit-switch');
    const text = el('span');
    text.append(el('strong', '', 'Read-only commands without asking'),
      el('small', '', 'ls, cat, grep, git status, git log, git diff… Anything that writes, deletes, installs or chains commands still asks.'));
    const sw = el('button', `sw${readOnly ? ' on' : ''}`);
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(readOnly));
    sw.setAttribute('aria-label', 'Read-only commands without asking');
    sw.addEventListener('click', () => F.send({ type: 'set_prefs', changes: { code_read_only: !readOnly } }));
    row.append(text, sw);
    return row;
  }

  function ruleRow(task, b, rule) {
    const li = el('li', `cr-rule ${b}`);
    const kind = ruleKind(rule);
    li.append(mine(el('code', 'cr-text', rule)), el('small', `cr-kind ${kind}`, KIND_LABEL[kind]));
    const rm = el('button', 'jc-btn small cr-remove', 'Remove');
    rm.type = 'button';
    rm.setAttribute('aria-label', t('Remove this rule'));
    rm.addEventListener('click', () => F.send({ type: 'cr_remove', id: task.id, behavior: b, rule }));
    li.append(rm);
    return li;
  }

  function addForm(task, state) {
    const box = el('div', 'cr-add');
    const seg = el('div', 'cr-seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'What the rule does');
    for (const b of BEHAVIORS) {
      const btn = el('button', `cr-seg-${b}`, HEADS[b]);
      btn.type = 'button';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(b === behavior));
      btn.addEventListener('click', () => { behavior = b; seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === btn))); });
      seg.append(btn);
    }
    const row = el('div', 'cr-add-row');
    const input = el('input', 'jc-field cr-input');
    input.placeholder = 'WebFetch(domain:example.com)';
    input.setAttribute('aria-label', 'A rule, in Claude Code’s syntax');
    input.spellcheck = false;
    input.value = draft;
    input.maxLength = 500;
    input.addEventListener('input', () => { draft = input.value; });
    const add = el('button', 'jc-btn small filled cr-add-btn', 'Add');
    add.type = 'button';
    const go = () => {
      const rule = input.value.trim();
      if (!rule) { input.focus(); return; }
      F.send({ type: 'cr_add', id: task.id, behavior, rule });
    };
    add.addEventListener('click', go);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    row.append(input, add);
    const help = el('p', 'jc-dim cr-help');
    help.append(el('span', '', 'For example:'), document.createTextNode(' '),
      mine(el('code', '', 'WebFetch(domain:github.com)')), document.createTextNode(' · '),
      mine(el('code', '', 'mcp__github')), document.createTextNode(' · '),
      mine(el('code', '', 'Read(src/**)')), document.createTextNode(' · '),
      mine(el('code', '', 'Edit(//etc/**)')), document.createTextNode(' · '),
      mine(el('code', '', 'Bash(git push:*)')));
    box.append(seg, row, help);
    if (state && state.error) box.append(mine(el('p', 'cr-error', state.error)));
    return box;
  }

  function exportButton(task, target, file) {
    const b = el('button', 'jc-btn small cr-export', target === 'local' ? 'Export to settings.local.json' : 'Export to settings.json');
    b.type = 'button';
    b.dataset.target = target;
    b.addEventListener('click', () => {
      if (!armed || armed.target !== target) {
        if (armed) clearTimeout(armed.timer);
        armed = { target, timer: setTimeout(() => { armed = null; if (paneShown()) render(paneBody, F.currentTask()); }, 4000) };
        b.textContent = t(target === 'local' ? 'Press again to write settings.local.json' : 'Press again to write settings.json (shared with the project)');
        b.classList.add('armed');
        return;
      }
      clearTimeout(armed.timer);
      armed = null;
      F.send({ type: 'cr_export', id: task.id, target });
    });
    b.title = t(`Adds these rules to .claude/${file}, keeping what’s there`);
    return b;
  }

  function render(body, task) {
    paneBody = body;
    if (!task) { body.replaceChildren(el('p', 'jc-empty', 'Open a session to see its permissions.')); return; }
    const state = states.get(task.id);
    const parts = [readOnlySwitch()];
    if (!state) {
      parts.push(el('p', 'jc-empty', 'Reading the rules…'));
      body.replaceChildren(...parts);
      return;
    }
    // The project's rules.
    const head = el('p', 'jc-label cr-head');
    head.append(el('span', '', 'Rules for'), document.createTextNode(' '), mine(el('span', '', state.name || '')));
    parts.push(head, el('p', 'jc-dim cr-intro', 'Deny beats ask, and ask beats allow. They hold in every permission mode, Bypass too, for every session in this project.'));
    const rules = state.rules || {};
    if (!count(rules)) parts.push(el('p', 'jc-dim cr-none', 'No rules yet.'));
    for (const b of BEHAVIORS) {
      const list = rules[b] || [];
      if (!list.length) continue;
      const group = el('div', `cr-group ${b}`);
      const gh = el('p', 'cr-group-head');
      gh.append(el('strong', '', HEADS[b]), el('small', '', NOTES[b]));
      const ul = el('ul', 'jc-list cr-list');
      ul.append(...list.map((rule) => ruleRow(task, b, rule)));
      group.append(gh, ul);
      parts.push(group);
    }
    parts.push(addForm(task, state));
    if (state.note) parts.push(el('p', 'cr-note', state.note));
    // The commands "Yes, and don't ask again" let by.
    const legacy = state.legacy || [];
    parts.push(el('p', 'jc-label cr-head', 'Commands it runs here without asking'));
    if (!legacy.length) parts.push(el('p', 'jc-dim cr-none', 'None yet. “Yes, and don’t ask again” on a command adds it here.'));
    else {
      const ul = el('ul', 'jc-list cr-list');
      ul.append(...legacy.map((r) => {
        const li = el('li');
        const rm = el('button', 'jc-btn small', 'Remove');
        rm.type = 'button';
        rm.addEventListener('click', () => F.send({ type: 'task_rules', id: task.id, remove: r }));
        li.append(mine(el('code', 'cr-text', `${r} …`)), rm);
        return li;
      }));
      parts.push(ul);
    }
    // The project's .claude settings files.
    parts.push(el('p', 'jc-label cr-head', 'Claude Code’s settings in this project'));
    const rows = claudeRows(state.claude);
    if (!rows.length) parts.push(el('p', 'jc-dim cr-none', 'No rules in .claude/settings.json or settings.local.json.'));
    else {
      const ul = el('ul', 'jc-list cr-list cr-claude');
      ul.append(...rows.slice(0, 60).map(([file, b, rule]) => {
        const li = el('li', `cr-rule ${b}`);
        li.append(mine(el('code', 'cr-text', rule)), el('small', 'cr-kind', HEADS[b]), mine(el('small', 'cr-file', file)));
        return li;
      }));
      parts.push(ul);
    }
    const actions = el('div', 'cr-actions');
    const imp = el('button', 'jc-btn small cr-import', 'Import them');
    imp.type = 'button';
    imp.disabled = !rows.length;
    imp.addEventListener('click', () => F.send({ type: 'cr_import', id: task.id }));
    actions.append(imp, exportButton(task, 'local', 'settings.local.json'), exportButton(task, 'project', 'settings.json'));
    if (armed) {
      const b = actions.querySelector(`.cr-export[data-target="${armed.target}"]`);
      if (b) { b.classList.add('armed'); b.textContent = t(armed.target === 'local' ? 'Press again to write settings.local.json' : 'Press again to write settings.json (shared with the project)'); }
    }
    parts.push(actions, el('p', 'jc-dim cr-intro', 'Export adds JARVIS’s rules and its “don’t ask again” commands to the file, keeping everything already there; settings.json is shared with everyone who works on the project.'));
    body.replaceChildren(...parts);
  }

  F.registerPane('rules', {
    title: 'Permissions',
    render(body, task) { render(body, task); if (task) ask(task); },
  });

  F.on('cr_state', (ev) => {
    states.set(ev.id, ev);
    if (ev.added) draft = '';  // (a rule added: the field starts over)
    const task = F.currentTask();
    if (paneShown() && task && task.id === ev.id) {
      const focused = paneBody.querySelector('.cr-input') === document.activeElement;
      render(paneBody, task);
      if (focused) { const input = paneBody.querySelector('.cr-input'); if (input) input.focus(); }
    }
  });
  const readPrefs = (p) => { if (p && typeof p.code_read_only === 'boolean') readOnly = p.code_read_only; };
  F.on('prefs', (ev) => { readPrefs(ev); if (paneShown()) render(paneBody, F.currentTask()); }, { replay: true });
  F.on('hello', (ev) => readPrefs(ev.prefs), { replay: true });
})(typeof window === 'object' ? window : globalThis);
