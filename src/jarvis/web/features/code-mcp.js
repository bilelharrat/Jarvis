// Jarvis Code's MCP manager (features/code_mcp.py): the MCP servers pane, in place of the
// built-in list. Each of the session's servers with its scope and how it's doing, switched off
// for the session, signed in to, reconnected, removed (a second press), or, for one a
// project shares (.mcp.json), approved or refused here; a server added as a command or an
// address, for this project (shared or just the owner's) or every project; and JARVIS's own
// connectors (Tools & Accounts) shared into the session.
//
// Names, commands, addresses and errors are data: text only, marked data-no-i18n. Pure
// helpers are exported for node --test (tests/web/code-mcp.test.mjs).
(function (root) {
  'use strict';

  const SCOPES = {
    project: 'This project, shared',
    local: 'This project, just me',
    user: 'All my projects',
    shared: 'From Tools & Accounts',
    other: 'From JARVIS or a plugin',
  };

  // How a server is doing, in words, and its dot's class.
  function statusOf(s) {
    if (s.approved === null && s.scope === 'project') return ['Waiting for your OK', 'idle'];
    if (s.approved === false) return ['Refused here', 'idle'];
    if (s.off) return ['Off in this session', 'idle'];
    switch (s.status) {
      case 'connected': return [s.tools ? (s.tools === 1 ? 'Connected · 1 tool' : `Connected · ${s.tools} tools`) : 'Connected', 'waiting'];
      case 'needs-auth': return ['Needs sign-in', 'failed'];
      case 'failed': return ['Couldn’t start', 'failed'];
      case 'pending': return ['Starting…', 'busy'];
      case 'disabled': return ['Turned off', 'idle'];
      default: return ['', 'idle'];
    }
  }

  // What can be done with a server from the pane.
  function actionsOf(s, live, signing) {
    const out = [];
    if (s.approved === null && s.scope === 'project') return ['approve', 'refuse', 'remove'];
    if (s.approved === false) return ['approve', 'remove'];
    if (signing) out.push('signing');
    else if (s.status === 'needs-auth' || (['http', 'sse'].includes(s.kind) && s.status !== 'connected' && live)) out.push('signin');
    if (live && ['failed', 'needs-auth'].includes(s.status) && !signing) out.push('reconnect');
    if (live) out.push('switch');
    if (s.removable) out.push('remove');
    return out;
  }

  const api = { statusOf, actionsOf, SCOPES };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, t } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };

  const states = new Map();  // task id -> its latest cm_state
  let paneBody = null;
  let asked = { id: null, at: 0 };
  let form = { open: false, name: '', kind: 'command', target: '', transport: 'http', scope: 'local' };
  let armed = null;  // { name, timer }: a Remove pressed once
  const paneShown = () => paneBody && paneBody.isConnected && typeof currentPane !== 'undefined' && currentPane === 'mcp';

  function ask(task) {
    const now = Date.now();
    if (asked.id === task.id && now - asked.at < 400) return;
    asked = { id: task.id, at: now };
    F.send({ type: 'cm_state', id: task.id });
  }

  function button(label, cls, run) {
    const b = el('button', `jc-btn small ${cls}`, label);
    b.type = 'button';
    b.addEventListener('click', run);
    return b;
  }

  function serverRow(task, s, state) {
    const li = el('li', 'cm-server');
    li.dataset.name = s.name;
    const [words, dot] = statusOf(s);
    const head = el('div', 'cm-head');
    head.append(el('span', `jc-dot ${dot}`), mine(el('strong', 'cm-name', s.name)), el('span', 'cm-scope', SCOPES[s.scope] || SCOPES.other));
    if (words) head.append(el('span', `cm-status ${dot}`, words));
    li.append(head);
    if (s.target) li.append(mine(el('code', 'cm-target', s.target)));
    if (s.error) li.append(mine(el('p', 'cm-error', s.error)));
    const acts = el('div', 'cm-actions');
    const signing = (state.signing || []).includes(s.name);
    for (const act of actionsOf(s, state.live, signing)) {
      if (act === 'signing') acts.append(el('span', 'jc-dim cm-signing', 'Signing in… finish in your browser'));
      if (act === 'signin') acts.append(button('Sign in', 'cm-signin', () => F.send({ type: 'cm_login', id: task.id, name: s.name })));
      if (act === 'reconnect') acts.append(button('Reconnect', 'cm-reconnect', () => F.send({ type: 'cm_reconnect', id: task.id, name: s.name })));
      if (act === 'approve') acts.append(button('Approve', 'filled cm-approve', () => F.send({ type: 'cm_approve', id: task.id, name: s.name, approve: true })));
      if (act === 'refuse') acts.append(button('Refuse', 'cm-refuse', () => F.send({ type: 'cm_approve', id: task.id, name: s.name, approve: false })));
      if (act === 'remove') {
        const again = armed && armed.name === s.name;
        const b = button(again ? 'Press again to remove' : 'Remove', `cm-remove${again ? ' armed' : ''}`, () => {
          if (!armed || armed.name !== s.name) {
            if (armed) clearTimeout(armed.timer);
            armed = { name: s.name, timer: setTimeout(() => { armed = null; redraw(task.id); }, 4000) };
            redraw(task.id);
            return;
          }
          clearTimeout(armed.timer);
          armed = null;
          F.send({ type: 'cm_remove', id: task.id, name: s.name, scope: s.scope });
        });
        acts.append(b);
      }
      if (act === 'switch') {
        const sw = el('button', 'jcs-switch cm-switch');
        sw.type = 'button';
        sw.setAttribute('role', 'switch');
        sw.setAttribute('aria-checked', String(!s.off));
        sw.setAttribute('aria-label', t('On in this session'));
        sw.addEventListener('click', () => { F.send({ type: 'task_mcp_toggle', id: task.id, name: s.name, enabled: !!s.off }); F.send({ type: 'cm_state', id: task.id }); });
        acts.append(sw);
      }
    }
    if (acts.childNodes.length) li.append(acts);
    return li;
  }

  function addForm(task, state) {
    const det = el('details', 'cm-add');
    det.open = form.open;
    det.addEventListener('toggle', () => { form.open = det.open; });
    det.append(el('summary', '', 'Add a server'));
    const name = el('input', 'jc-field cm-name-input');
    name.placeholder = 'Name, like github';
    name.setAttribute('aria-label', 'Name');
    name.value = form.name;
    name.maxLength = 64;
    name.addEventListener('input', () => { form.name = name.value; });
    const seg = el('div', 'cr-seg cm-kind');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'It runs as');
    const target = el('input', 'jc-field cm-target-input');
    target.spellcheck = false;
    const transport = el('select', 'jc-field cm-transport');
    for (const [v, label] of [['http', 'HTTP'], ['sse', 'SSE']]) { const o = el('option', '', label); o.value = v; transport.append(o); }
    transport.value = form.transport;
    transport.addEventListener('change', () => { form.transport = transport.value; });
    const shape = () => {
      target.placeholder = form.kind === 'url' ? 'https://mcp.example.com/mcp' : 'npx -y some-mcp-server';
      target.setAttribute('aria-label', form.kind === 'url' ? t('Its address') : t('The command that starts it'));
      transport.hidden = form.kind !== 'url';
      seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.kind === form.kind)));
    };
    for (const [kind, label] of [['command', 'A command'], ['url', 'An address']]) {
      const b = el('button', '', label);
      b.type = 'button';
      b.dataset.kind = kind;
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => { form.kind = kind; shape(); });
      seg.append(b);
    }
    target.value = form.target;
    target.addEventListener('input', () => { form.target = target.value; });
    const scope = el('select', 'jc-field cm-scope-select');
    scope.setAttribute('aria-label', 'For');
    for (const v of ['local', 'project', 'user']) { const o = el('option', '', SCOPES[v]); o.value = v; scope.append(o); }
    scope.value = form.scope;
    scope.addEventListener('change', () => { form.scope = scope.value; });
    const add = button('Add', 'filled cm-add-btn', () => F.send({ type: 'cm_add', id: task.id, name: form.name.trim(), kind: form.kind, target: form.target.trim(), transport: form.transport, scope: form.scope }));
    const row1 = el('div', 'cm-add-row');
    row1.append(name, seg);
    const row2 = el('div', 'cm-add-row');
    row2.append(target, transport);
    const row3 = el('div', 'cm-add-row');
    row3.append(scope, add);
    det.append(row1, row2, row3, el('p', 'jc-dim cm-help', 'A command runs on this Mac each time a session starts. For a server that needs a key, sign in to it, or connect it in Tools & Accounts and share it below.'));
    if (state.error) det.append(mine(el('p', 'cr-error', state.error)));
    shape();
    return det;
  }

  function render(body, task) {
    paneBody = body;
    if (!task) { body.replaceChildren(el('p', 'jc-empty', 'Open a session to see its MCP servers.')); return; }
    const state = states.get(task.id);
    if (!state) { body.replaceChildren(el('p', 'jc-empty', 'Checking MCP servers…')); return; }
    const parts = [];
    if (!state.live) parts.push(el('p', 'jc-dim cm-intro', 'The session isn’t running: how each server is doing shows once it is.'));
    const servers = state.servers || [];
    if (!servers.length) parts.push(el('p', 'jc-empty', 'No MCP servers for this project yet.'));
    else {
      const ul = el('ul', 'jc-list cm-list');
      ul.append(...servers.map((s) => serverRow(task, s, state)));
      parts.push(ul);
    }
    if (state.note) parts.push(el('p', 'cr-note', state.note));
    parts.push(addForm(task, state));
    parts.push(el('p', 'jc-label cr-head', 'JARVIS’s connectors'));
    const conns = state.connectors || [];
    if (!conns.length) parts.push(el('p', 'jc-dim cr-none', 'Connect services in Tools & Accounts, then share them with a session here.'));
    else {
      const ul = el('ul', 'jc-list cm-list cm-connectors');
      ul.append(...conns.map((c) => {
        const li = el('li', 'cm-connector');
        li.dataset.connector = c.id;
        const text = el('span');
        text.append(mine(el('strong', '', c.name)), el('small', '', c.status === 'connected' ? (c.on ? 'Shared with this session' : 'Not shared') : 'Not connected'));
        const sw = el('button', 'jcs-switch cm-share');
        sw.type = 'button';
        sw.setAttribute('role', 'switch');
        sw.setAttribute('aria-checked', String(!!c.on));
        sw.setAttribute('aria-label', t('Share with this session'));
        sw.disabled = c.status !== 'connected' && !c.on;
        sw.addEventListener('click', () => F.send({ type: 'cm_share', id: task.id, connector: c.id, on: !c.on }));
        li.append(text, sw);
        return li;
      }));
      parts.push(ul, el('p', 'jc-dim cr-intro', 'JARVIS keeps their sign-in; their read-only tools run without asking, the rest ask as any step does.'));
    }
    body.replaceChildren(...parts);
  }

  function redraw(id) {
    const task = F.currentTask();
    if (!paneShown() || !task || task.id !== id) return;
    const focused = document.activeElement;
    const which = focused && focused.classList ? ['cm-name-input', 'cm-target-input'].find((c) => focused.classList.contains(c)) : null;
    render(paneBody, task);
    if (which) { const again = paneBody.querySelector(`.${which}`); if (again) again.focus(); }
  }

  F.registerPane('mcp', { title: 'MCP servers', render(body, task) { render(body, task); if (task) ask(task); } });
  F.on('cm_state', (ev) => {
    if (ev.added) form = { ...form, open: false, name: '', target: '' };  // (added: the form starts over)
    states.set(ev.id, ev);
    redraw(ev.id);
  });
})(typeof window === 'object' ? window : globalThis);
