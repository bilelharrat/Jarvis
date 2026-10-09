// Other coding agents over the Agent Client Protocol (features/code_acp.py): the Other agents
// pane (More › Other agents, /acp). The agents the owner added by their command, a new
// session with one in the project on show (an ordinary Eden Code session, selected once it
// starts), and an agent added or removed (a second press).
//
// Names, commands and errors are data: text only, marked data-no-i18n. Pure helpers are
// exported for node --test (tests/web/code-acp.test.mjs).
(function (root) {
  'use strict';

  // Agents people commonly add, as examples for the form (never added by themselves).
  const EXAMPLES = [['Codex', 'codex-acp'], ['Gemini', 'gemini --experimental-acp'], ['OpenCode', 'opencode acp']];

  // What the form sends, or why not: [ok, name, command | reason].
  function formFor(name, command) {
    const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    const c = String(command || '').trim();
    if (!n) return [false, 'Give the agent a name, like Codex.'];
    if (!c) return [false, 'Type the command that starts it, like codex-acp.'];
    return [true, n, c];
  }

  const api = { formFor, EXAMPLES };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, t } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };

  let state = null;  // the latest acp_state
  let form = { name: '', command: '' };
  let note = '';
  let armed = null;
  let paneBody = null;
  const paneShown = () => paneBody && paneBody.isConnected && typeof currentPane !== 'undefined' && currentPane === 'acp';
  const project = () => (typeof deckProject !== 'undefined' && deckProject) || ((F.currentTask() || {}).folder) || '';
  const newMode = () => (typeof codeDefaults !== 'undefined' && codeDefaults.mode) || 'ask';

  function render(body) {
    paneBody = body;
    if (!state) { body.replaceChildren(el('p', 'jc-empty', 'Reading the agents…')); return; }
    const parts = [el('p', 'jc-dim ca-intro', 'Run a task with another coding agent that speaks the Agent Client Protocol. It works in the project on show as an ordinary session: JARVIS answers the steps it asks about, by your permission mode and rules; what it does without asking is up to its own settings.')];
    const agents = state.agents || [];
    if (!agents.length) parts.push(el('p', 'jc-dim cr-none', 'No agents yet: add one below by the command that starts it.'));
    else {
      const ul = el('ul', 'jc-list ca-list');
      ul.append(...agents.map((a) => {
        const li = el('li', 'ca-agent');
        li.dataset.agent = a.id;
        const text = el('span', 'ca-text');
        text.append(mine(el('strong', '', a.name)), mine(el('code', 'ca-command', a.command)));
        const start = el('button', 'jc-btn small filled ca-start', 'New session');
        start.type = 'button';
        start.disabled = !project();
        start.title = t('In the project on show');
        start.addEventListener('click', () => F.send({ type: 'acp_start', agent: a.id, directory: project(), mode: newMode() }));
        const again = armed && armed.id === a.id;
        const rm = el('button', `jc-btn small ca-remove${again ? ' armed' : ''}`, again ? 'Press again to remove' : 'Remove');
        rm.type = 'button';
        rm.addEventListener('click', () => {
          if (!armed || armed.id !== a.id) {
            if (armed) clearTimeout(armed.timer);
            armed = { id: a.id, timer: setTimeout(() => { armed = null; redraw(); }, 4000) };
            redraw();
            return;
          }
          clearTimeout(armed.timer);
          armed = null;
          F.send({ type: 'acp_remove', agent: a.id });
        });
        li.append(text, start, rm);
        return li;
      }));
      parts.push(ul);
    }
    const box = el('div', 'cr-add ca-add');
    box.append(el('p', 'jc-label', 'Add an agent'));
    const name = el('input', 'jc-field ca-name');
    name.placeholder = 'Name, like Codex';
    name.setAttribute('aria-label', 'Its name');
    name.value = form.name;
    name.maxLength = 40;
    name.addEventListener('input', () => { form.name = name.value; });
    const command = el('input', 'jc-field ca-command-input');
    command.placeholder = 'The command that starts it, like codex-acp';
    command.setAttribute('aria-label', 'The command that starts it');
    command.spellcheck = false;
    command.value = form.command;
    command.addEventListener('input', () => { form.command = command.value; });
    const add = el('button', 'jc-btn small filled ca-add-btn', 'Add');
    add.type = 'button';
    const go = () => {
      const [ok, n, c] = formFor(form.name, form.command);
      if (!ok) { note = n; redraw(); return; }
      note = '';
      F.send({ type: 'acp_add', name: n, command: c });
    };
    add.addEventListener('click', go);
    for (const input of [name, command]) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    const row = el('div', 'ca-row');
    row.append(command, add);
    const examples = el('p', 'jc-dim ca-examples');
    examples.append(el('span', '', 'For example:'));
    for (const [n, c] of EXAMPLES) {
      const b = el('button', 'jc-mini ca-example');
      b.type = 'button';
      b.append(mine(el('span', '', `${n}: ${c}`)));
      b.addEventListener('click', () => { form = { name: n, command: c }; redraw(); });
      examples.append(document.createTextNode(' '), b);
    }
    box.append(name, row, examples);
    const said = note ? t(note) : state.error;
    if (said) box.append(mine(el('p', 'cr-error', said)));
    parts.push(box, el('p', 'jc-dim ca-intro', 'An agent signs in by itself: run its command once in Terminal if it asks. It gets no MCP servers or files from JARVIS; it works with its own tools, as you, in the project’s folder.'));
    body.replaceChildren(...parts);
  }

  function redraw() {
    if (!paneShown()) return;
    const focused = document.activeElement;
    const which = focused && focused.classList ? ['ca-name', 'ca-command-input'].find((c) => focused.classList.contains(c)) : null;
    render(paneBody);
    if (which) { const again = paneBody.querySelector(`.${which}`); if (again) again.focus(); }
  }

  F.registerPane('acp', { title: 'Other agents', render(body) { render(body); F.send({ type: 'acp_state' }); } });
  F.registerMoreItem({ label: 'Other agents', note: 'Codex, Gemini and others, over ACP', run: () => F.openPane('acp') });
  F.registerSlash({ name: 'acp', help: 'Other coding agents, over ACP', withoutSession: true, run() { F.openPane('acp'); return true; } });

  F.on('acp_state', (ev) => {
    if (ev.added) form = { name: '', command: '' };
    state = ev;
    redraw();
  });
  F.on('acp_started', (ev) => { if (ev && ev.id) F.selectTask(ev.id); });
})(typeof window === 'object' ? window : globalThis);
