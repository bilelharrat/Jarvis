// Jarvis Code hand-off (features/code_handoff.py): the Machines tab of Jarvis Code settings
// (hosts from the owner's SSH config: add, test, remove; and the sessions running on them),
// the session's More menu (Continue on… a machine, Bring back, Stop), and, for a session
// that's on another machine, a bar in its header: where, how it's doing, what its Claude
// reported it cost there (billed to that machine's sign-in, outside JARVIS's limits).
//
// Everything from the backend is data: text only (textContent); aliases, titles and costs
// are marked data-no-i18n. Pure helpers are exported for node --test
// (tests/web/code-handoff.test.mjs).
(function (root) {
  'use strict';

  const STATE_WORDS = {
    starting: 'Starting…',
    working: 'Working',
    idle: 'Waiting for you',
    ended: 'Ended',
    stopped: 'Stopped',
    failed: 'Failed',
  };

  // How a hand-off is doing, in a word (a dropped connection says so first).
  function stateWord(rec) {
    if (!rec) return '';
    if (rec.lost && ['starting', 'working', 'idle'].includes(rec.state)) return 'Reconnecting…';
    return STATE_WORDS[rec.state] || 'Ended';
  }

  // Running there (or about to): Stop applies, and a message goes straight to it.
  function isLive(rec) {
    return !!rec && ['starting', 'working', 'idle'].includes(rec.state);
  }

  // $0.42: what the remote's Claude Code reported.
  function fmtCost(value) {
    const v = Math.max(0, Number(value) || 0);
    return `$${v.toFixed(2)}`;
  }

  // The hand-off a session is in (by its number in this launch), or null.
  function handoffFor(handoffs, taskId) {
    if (!taskId) return null;
    return (handoffs || []).find((h) => h.task_id === taskId) || null;
  }

  // A machine's line: its status word, and the facts the check found (not translated).
  function machineStatus(m) {
    if (!m) return { word: '', facts: '' };
    if (!m.checked) return { word: 'Not checked yet', facts: '' };
    if (!m.ok) return { word: m.problem || 'Not ready', facts: '' };
    const facts = [m.claude_version ? `Claude Code ${m.claude_version.replace(/\s*\(Claude Code\)\s*$/, '')}` : '', m.tmux ? 'tmux' : ''];
    return { word: m.permissions ? 'Ready: asks you here' : 'Ready: Accept edits only', facts: facts.filter(Boolean).join(' · ') };
  }

  const api = { stateWord, isLive, fmtCost, handoffFor, machineStatus, STATE_WORDS };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, send, t } = F;
  const state = { machines: [], hosts: [], handoffs: [] };
  const busy = new Map();  // alias -> when its check was asked for (ms)

  const noI18n = (node) => { node.dataset.noI18n = ''; return node; };
  function button(label, run, cls = 'btn') {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', run);
    return b;
  }

  // ── Jarvis Code settings › Machines ──

  function machinesTab() {
    const existing = document.getElementById('jcs-machines');
    if (existing) return existing;
    const tabs = document.querySelector('.jcs-tabs');
    const card = document.querySelector('.jcs-card');
    if (!tabs || !card) return null;
    const tab = el('button', '', 'Machines');
    tab.type = 'button';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', 'false');
    tab.dataset.tab = 'machines';
    tabs.append(tab);
    const panel = el('div', 'jcs-body jch-panel');
    panel.id = 'jcs-machines';
    panel.setAttribute('role', 'tabpanel');
    panel.hidden = true;
    card.append(panel);
    tab.addEventListener('click', () => { if (typeof selectJcsTab === 'function') selectJcsTab('machines'); });
    new MutationObserver(() => {
      panel.hidden = tab.getAttribute('aria-selected') !== 'true';
      if (!panel.hidden) send({ type: 'code_machines' });
    }).observe(tab, { attributes: true, attributeFilter: ['aria-selected'] });
    return panel;
  }

  function openMachines() {
    if (typeof openJcSettings === 'function') openJcSettings('machines');
  }

  const panel = machinesTab();
  const list = el('ul', 'jch-list');
  const sessions = el('ul', 'jch-list');
  const sessionsLabel = el('p', 'jcs-label', 'Sessions on other machines');
  const input = el('input', 'jcs-input jch-alias');
  const hosts = el('datalist');
  const help = el('p', 'jcs-help');
  if (panel) {
    panel.append(el('p', 'jcs-intro', 'Continue a session on another machine you control, over SSH. JARVIS uses your own SSH config and agent, and never stores keys.'));
    panel.append(el('p', 'jcs-label in', 'Machines'), list);
    const form = el('form', 'jcs-group jch-add');
    form.autocomplete = 'off';
    hosts.id = 'jch-hosts';
    input.setAttribute('list', 'jch-hosts');
    input.placeholder = 'Host alias from ~/.ssh/config';
    input.setAttribute('aria-label', 'Host alias');
    input.spellcheck = false;
    const row = el('label', 'jcs-row');
    row.append(el('span', '', 'Add a machine'), input, hosts);
    const add = el('button', 'btn primary', 'Add');
    add.type = 'submit';
    row.append(add);
    form.append(row);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const alias = input.value.trim();
      if (!alias) return;
      busy.set(alias, Date.now());
      help.textContent = t('Checking…');
      send({ type: 'code_machine_add', alias });
      input.value = '';
    });
    panel.append(form, help);
    panel.append(el('p', 'jcs-foot', 'A check runs ssh -o BatchMode=yes, then looks for git and Claude Code there. Only the alias is kept.'));
    panel.append(sessionsLabel, sessions);
    panel.append(el('p', 'jcs-foot', 'Runs on another machine use its own Claude sign-in and are billed there. JARVIS’s spending limits can’t meter them; the cost shown is what its Claude Code reported.'));
  }

  function machineItem(m) {
    const li = el('li', 'jcs-provider jch-machine');
    const head = el('div', 'jcs-p-head');
    const title = el('span', 'jcs-p-title');
    title.append(noI18n(el('strong', '', m.alias)));
    const { word, facts } = machineStatus(m);
    const status = el('small', `jch-status ${m.ok ? 'ok' : m.checked ? 'bad' : ''}`, busy.has(m.alias) ? 'Checking…' : word);
    title.append(status);
    if (facts && !busy.has(m.alias)) title.append(noI18n(el('small', 'jch-facts', facts)));
    const test = button('Test', () => { busy.set(m.alias, Date.now()); draw(); send({ type: 'code_machine_test', alias: m.alias }); });
    const remove = button('Remove', () => send({ type: 'code_machine_remove', alias: m.alias }));
    test.disabled = busy.has(m.alias);
    head.append(title, test, remove);
    li.append(head);
    return li;
  }

  function sessionItem(h) {
    const li = el('li', 'jcs-provider jch-session');
    const head = el('div', 'jcs-p-head');
    const title = el('span', 'jcs-p-title');
    title.append(noI18n(el('strong', '', h.title || h.branch)));
    const where = el('small', 'jch-where');
    where.append(noI18n(el('span', '', `${h.project} · ${h.alias}`)), document.createTextNode(' · '), el('span', '', stateWord(h)));
    title.append(where);
    if (h.note) title.append(el('small', 'jch-status bad', h.note));
    head.append(title);
    head.append(noI18n(el('span', 'jch-cost', fmtCost(h.cost))));
    if (h.task_id) head.append(button('Open', () => F.selectTask(h.task_id)));
    if (isLive(h)) head.append(button('Stop', () => send({ type: 'code_handoff_stop', handoff: h.id })));
    head.append(button('Bring it back', () => send({ type: 'code_handoff_back', handoff: h.id })));
    if (!isLive(h)) head.append(button('Forget', () => send({ type: 'code_handoff_forget', handoff: h.id })));
    li.append(head);
    return li;
  }

  function drawPanel() {
    if (!panel) return;
    list.replaceChildren(...(state.machines.length ? state.machines.map(machineItem) : [el('li', 'jch-empty', 'No machines yet. Add a host from your SSH config.')]));
    hosts.replaceChildren(...state.hosts.map((h) => { const o = el('option'); o.value = h; return o; }));
    sessions.replaceChildren(...state.handoffs.map(sessionItem));
    sessionsLabel.hidden = !state.handoffs.length;
    sessions.hidden = !state.handoffs.length;
    if (!busy.size && help.textContent === t('Checking…')) help.textContent = '';
  }

  // ── the session's More menu ──

  const current = () => {
    const task = F.currentTask();
    return task && task.kind === 'code' ? task : null;
  };
  const mine = () => { const task = current(); return task ? handoffFor(state.handoffs, task.id) : null; };

  F.registerMoreItem({
    label: 'Continue on…',
    when: (task) => !!task && task.kind === 'code' && !handoffFor(state.handoffs, task.id),
    get note() {
      const task = current();
      return task && !(task.workspace && task.workspace.slug) ? 'Needs an isolated copy' : 'Another machine, over SSH';
    },
    get disabled() {
      const task = current();
      return !(task && task.workspace && task.workspace.slug) || !!(task && task.busy);
    },
    sub: () => {
      const task = current();
      const items = state.machines.map((m) => ({
        label: m.alias,
        mine: true,
        note: m.ok ? '' : machineStatus(m).word,
        run: () => task && send({ type: 'code_handoff', id: task.id, alias: m.alias }),
      }));
      return [...items, ...(items.length ? ['-'] : []), { label: items.length ? 'Machines…' : 'Add a machine…', run: openMachines }];
    },
  });
  F.registerMoreItem({
    get label() { const h = mine(); return h ? `Bring back from ${h.alias}` : 'Bring it back'; },
    note: 'Into its isolated copy, ready to land',
    when: (task) => !!task && !!handoffFor(state.handoffs, task.id),
    run: () => { const h = mine(); if (h) send({ type: 'code_handoff_back', handoff: h.id }); },
  });
  F.registerMoreItem({
    get label() { const h = mine(); return h ? `Stop on ${h.alias}` : 'Stop'; },
    when: (task) => !!task && isLive(handoffFor(state.handoffs, task.id)),
    run: () => { const h = mine(); if (h) send({ type: 'code_handoff_stop', handoff: h.id }); },
  });

  // ── the header's bar ──

  const bar = el('div', 'jch-bar');
  bar.hidden = true;
  const where = el('span', 'jch-bar-where');
  const how = el('span', 'jch-bar-state');
  const cost = noI18n(el('span', 'jch-bar-cost'));
  const billed = el('span', 'jch-bar-billed', 'billed there, outside JARVIS’s limits');
  const back = button('Bring it back', () => { const h = mine(); if (h) send({ type: 'code_handoff_back', handoff: h.id }); }, 'jch-bar-btn');
  const stop = button('Stop', () => { const h = mine(); if (h) send({ type: 'code_handoff_stop', handoff: h.id }); }, 'jch-bar-btn');
  bar.append(el('span', 'jch-bar-dot'), where, how, cost, billed, back, stop);

  function drawBar() {
    const titles = document.querySelector('.jc-titles');
    if (titles && !bar.isConnected) titles.append(bar);
    const h = mine();
    bar.hidden = !h;
    if (!h) return;
    bar.classList.toggle('lost', !!h.lost);
    where.textContent = t(`On ${h.alias}`);
    how.textContent = t(stateWord(h));
    cost.textContent = fmtCost(h.cost);
    stop.hidden = !isLive(h);
  }

  function draw() { drawPanel(); drawBar(); }

  const title = document.getElementById('jc-title');
  if (title) new MutationObserver(drawBar).observe(title, { childList: true, characterData: true, subtree: true });

  F.on('code_handoffs', (ev) => {
    state.machines = ev.machines || [];
    state.hosts = ev.hosts || [];
    state.handoffs = ev.handoffs || [];
    for (const [alias, asked] of [...busy]) {
      const m = state.machines.find((x) => x.alias === alias);
      if (!m || m.checked * 1000 >= asked - 1000) busy.delete(alias);
    }
    draw();
  }, { replay: true });
  F.on('hello', () => send({ type: 'code_machines' }), { replay: true });
  F.on('tasks', () => drawBar(), { replay: true });
  draw();
})(typeof window === 'object' ? window : globalThis);
