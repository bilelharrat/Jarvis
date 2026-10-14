// Eden Code's Bug Fix Mode (features/code_bugfix.py): the owner's bug protocol behind one
// switch. The composer's "Bug Fix Mode" switch turns it on for the project in front (the
// backend puts the whole scope, spending ceiling included, on a card first); the session's
// header says so while it runs. The Bug Fix Mode pane shows each run: its round and step
// (sweep, break, fix, efficiency; ship; land), what it has spent of its ceiling, its findings
// with their severity and fix status, its reports and the steps left for the owner, with
// Stop, Resume (a run the app quit during, or one stopped) and Land (a card with Touch ID).
// Pure helpers are exported for node --test (tests/web/code-bugfix.test.mjs).
(function (root) {
  'use strict';

  const STEPS = ['sweep', 'break', 'fix', 'efficiency'];
  const STEP_LABELS = { sweep: 'Sweep', break: 'Break', fix: 'Fix', efficiency: 'Efficiency', ship: 'Ship', land: 'Land' };
  const SEVERITY = ['blocker', 'high', 'medium', 'low'];
  const STATUS = {
    open: 'Open', verified: 'Fixed · test failed first', fixed: 'Fixed', unproven: 'Fixed · not proven',
    failing: 'Still failing', wontfix: 'Won’t fix', owner: 'Yours',
  };
  const STATE = { running: 'Running', stopping: 'Stopping', paused: 'Paused', stopped: 'Stopped', done: 'Done' };

  // The protocol's steps, in order, for a run of so many rounds: [{key, round, step}].
  function stepsOf(rounds) {
    const out = [];
    for (let r = 1; r <= rounds; r += 1) {
      for (const step of STEPS) {
        if (step === 'efficiency' && r === rounds) continue;  // (none after the last round)
        out.push({ key: `r${r}-${step}`, round: r, step });
      }
    }
    out.push({ key: 'ship', round: rounds, step: 'ship' }, { key: 'land', round: rounds, step: 'land' });
    return out;
  }

  // Each step done, current or still to do, for a run as the backend lists it.
  function progress(run) {
    const steps = stepsOf(run.rounds || 3);
    const here = run.step === 'ship' || run.step === 'land' ? run.step : `r${run.round}-${run.step}`;
    let at = steps.findIndex((s) => s.key === here);
    if (run.state === 'done') at = run.landed ? steps.length : steps.length - 1;
    return steps.map((s, i) => ({ ...s, state: i < at ? 'done' : i === at ? (run.state === 'running' ? 'current' : 'halted') : 'todo' }));
  }

  // How many findings at each severity: {blocker, high, medium, low}.
  function severityCounts(findings) {
    const out = { blocker: 0, high: 0, medium: 0, low: 0 };
    for (const f of findings || []) if (f.severity in out) out[f.severity] += 1;
    return out;
  }

  // Findings worst first, then by their id's number.
  function sorted(findings) {
    const n = (id) => Number(String(id).split('-')[1]) || 0;
    return [...(findings || [])].sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity) || n(a.id) - n(b.id));
  }

  const canStop = (run) => run.state === 'running';
  const canResume = (run) => (run.state === 'paused' || run.state === 'stopped') && !!run.folder;
  const canLand = (run) => !run.landed && !!run.slug && run.state !== 'running' && run.state !== 'stopping'
    && (run.findings || []).some((f) => ['verified', 'fixed', 'unproven'].includes(f.status));

  // The run a session is (by its id), or the one running in a project.
  function runFor(runs, active, taskId, project) {
    const id = taskId != null ? (active || {})[String(taskId)] : null;
    if (id) return (runs || []).find((r) => r.id === id) || null;
    return (runs || []).find((r) => r.state === 'running' && project && r.project === project) || null;
  }

  const money = (n) => `$${Number(n || 0).toFixed(2)}`;

  const api = { stepsOf, progress, severityCounts, sorted, canStop, canResume, canLand, runFor, STATUS };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, send, t } = F;
  // Drawn anew with the keyboard kept in its place (code-focus.js): after Stop, Merge and
  // the like the focus would otherwise fall to the page.
  const keepFocus = (box, drawIt) => (root.jarvisFocus ? root.jarvisFocus.keep(box, drawIt) : drawIt());
  const state = { runs: [], active: {}, open: new Set() };
  let body = null;

  const project = () => {
    const task = F.currentTask();
    if (task && task.kind === 'code') {
      const run = runFor(state.runs, state.active, task.id, '');
      if (run) return run.project;
      return task.folder || '';
    }
    return typeof deckProject === 'string' ? deckProject : '';
  };
  const sessions = () => (typeof ccTasks !== 'undefined' ? ccTasks : []);
  const showing = () => body && body.isConnected && body.querySelector('.jcx-bf');
  const render = () => { if (showing()) draw(body); };

  function mine(text, tag = 'span', cls = '') {
    const node = el(tag, cls, text);
    node.dataset.noI18n = '';
    return node;
  }

  function button(label, cls, run, title) {
    const b = el('button', `jc-btn small ${cls || ''}`.trim(), label);
    b.type = 'button';
    if (title) b.title = t(title);
    b.addEventListener('click', (e) => { e.preventDefault(); run(b); });
    return b;
  }

  // ── the composer's switch ──

  const pill = el('button', 'jc-pill jcx-bf-switch');
  pill.type = 'button';
  pill.id = 'jcx-bf-switch';
  // A button, not a switch: on, it opens the run's pane (with Stop) rather than turning it
  // off, so its name says which it does (drawSwitch).
  pill.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><ellipse cx="8" cy="9" rx="3.2" ry="4.2"/><path d="M8 4.8V3M5.6 6.2 3.5 4.8M10.4 6.2l2.1-1.4M4.8 9H2.5M11.2 9h2.3M5.4 11.8l-1.9 1.4M10.6 11.8l1.9 1.4"/></svg>';
  pill.append(el('span', '', 'Bug Fix Mode'));
  pill.addEventListener('click', () => {
    const name = project();
    if (!name) return;
    const run = runFor(state.runs, state.active, F.currentTask() && F.currentTask().id, name);
    if (run) { F.openPane('bugfix'); return; }  // (on: its pane, with Stop)
    send({ type: 'code_bugfix_start', project: name });  // a card with the whole scope comes first
  });

  function drawSwitch() {
    const row = document.querySelector('#deck-composer .jc-composer-row');
    if (row && !pill.isConnected) row.insertBefore(pill, row.querySelector('.jc-spacer'));
    const name = project();
    pill.hidden = !name;
    const run = name ? runFor(state.runs, state.active, F.currentTask() && F.currentTask().id, name) : null;
    pill.setAttribute('aria-label', t(run ? 'Bug Fix Mode is on: show its progress' : 'Bug Fix Mode: turn it on for this project…'));
    pill.classList.toggle('on', !!run);
    pill.title = t(run
      ? 'Bug Fix Mode is on here. Click for its progress, and Stop.'
      : 'Run your bug protocol on this project: 3 rounds of sweep, break and fix, in an isolated copy. Asks first, with the spending ceiling.');
  }

  // ── the header's badge ──

  const badge = el('button', 'jcx-bf-badge');
  badge.type = 'button';
  badge.hidden = true;
  badge.addEventListener('click', () => F.openPane('bugfix'));

  function drawBadge() {
    const titles = document.querySelector('.jc-titles');
    if (titles && !badge.isConnected) titles.append(badge);
    const task = F.currentTask();
    const run = task ? runFor(state.runs, state.active, task.id, '') : null;
    badge.hidden = !run;
    if (!run) return;
    const step = run.step === 'ship' || run.step === 'land' ? t(STEP_LABELS[run.step]) : `${t('Round')} ${run.round} · ${t(STEP_LABELS[run.step] || run.step)}`;
    badge.replaceChildren(el('span', 'jcx-bf-dot'), el('span', '', 'Bug Fix Mode'), mine(` · ${step}`));
    badge.setAttribute('aria-label', `${t('Bug Fix Mode')}: ${step}. ${money(run.spent)} / ${money(run.spend_cap)}`);
  }

  function redraw() { drawSwitch(); drawBadge(); }

  // ── the pane ──

  function chip(text, cls) { return el('span', `jcx-chip ${cls || ''}`.trim(), text); }

  function stepper(run) {
    const list = el('ol', 'jcx-bf-steps');
    list.setAttribute('aria-label', t('Progress'));
    for (const s of progress(run)) {
      const label = s.step === 'ship' || s.step === 'land' ? t(STEP_LABELS[s.step]) : `R${s.round} ${t(STEP_LABELS[s.step])}`;
      const li = mine(label, 'li', `jcx-bf-step ${s.state}`);
      if (s.state === 'current') li.setAttribute('aria-current', 'step');
      li.title = t({ done: 'Done', current: 'Now', halted: 'Stopped here', todo: 'To do' }[s.state]);
      list.append(li);
    }
    return list;
  }

  function findingRow(f) {
    const li = el('li', `jcx-bf-finding sev-${f.severity}`);
    const head = el('div', 'jcx-bf-fhead');
    head.append(chip(f.severity, `sev ${f.severity}`), mine(f.id, 'code'), mine(f.title, 'span', 'jcx-bf-ftitle'),
      chip(STATUS[f.status] || f.status, ['verified', 'fixed'].includes(f.status) ? 'good' : ['failing', 'unproven'].includes(f.status) ? 'warn' : ''));
    li.append(head, mine(`${f.where} · ${f.lane}`, 'p', 'jc-dim jcx-bf-where'));
    li.title = f.scenario || '';
    // (A title is never read by a screen reader: the scenario is said in the item too.)
    if (f.scenario) li.append(mine(f.scenario, 'span', 'sr-only'));
    return li;
  }

  function runCard(run) {
    const card = el('section', 'jcx-bf-run');
    card.setAttribute('aria-label', `${t('Bug Fix Mode')}: ${run.project}`);
    const head = el('div', 'jcx-bf-head');
    head.append(mine(run.project, 'strong', 'jcx-bf-title'), chip(STATE[run.state] || run.state, run.state === 'running' ? 'busy' : run.state === 'done' ? 'good' : 'warn'));
    if (run.landed) head.append(chip('Landed', 'good'));
    card.append(head);
    const facts = el('p', 'jc-dim jcx-bf-facts');
    const counts = severityCounts(run.findings);
    facts.append(
      el('span', '', `${money(run.spent)} / ${money(run.spend_cap)}`), document.createTextNode(' · '),
      el('span', '', `${(run.findings || []).length} findings`), document.createTextNode(' · '),
      mine(SEVERITY.filter((s) => counts[s]).map((s) => `${counts[s]} ${t(s)}`).join(', ') || '–'),
    );
    if (run.dropped) facts.append(document.createTextNode(' · '), el('span', '', `${run.dropped} dropped (not verified or duplicates)`));
    card.append(facts, stepper(run));
    const meter = el('div', 'jcx-bf-meter');
    meter.setAttribute('role', 'meter');
    meter.setAttribute('aria-label', t('Spent of the spending ceiling'));
    meter.setAttribute('aria-valuemin', '0');
    meter.setAttribute('aria-valuemax', String(run.spend_cap));
    meter.setAttribute('aria-valuenow', String(run.spent || 0));
    const fill = el('span');
    fill.style.width = `${Math.min(100, Math.round(((run.spent || 0) / (run.spend_cap || 1)) * 100))}%`;
    meter.append(fill);
    card.append(meter);

    const actions = el('div', 'jcx-bf-actions');
    if (sessions().some((s) => s.id === run.task_id && s.kind === 'code')) actions.append(button('Show session', '', () => F.selectTask(run.task_id)));
    if (canStop(run)) actions.append(button('Stop', 'danger', () => send({ type: 'code_bugfix_stop', run: run.id }), 'Ends the run where it is; its copy and reports are kept'));
    if (canResume(run)) actions.append(button('Resume', 'filled', () => send({ type: 'code_bugfix_resume', run: run.id }), 'Carries on from the step it was on, in the same copy'));
    if (canLand(run)) actions.append(button('Land the fixes…', '', () => send({ type: 'code_bugfix_land', run: run.id }), 'Asks first, with Touch ID'));
    if ((run.findings || []).length) {
      actions.append(button(state.open.has(run.id) ? 'Hide findings' : 'Findings', 'plain', () => {
        if (state.open.has(run.id)) state.open.delete(run.id); else state.open.add(run.id);
        render();
      }));
    }
    card.append(actions);

    if (state.open.has(run.id) || (run.state === 'running' && state.open.size === 0)) {
      const list = el('ul', 'jcx-bf-findings');
      list.setAttribute('aria-label', t('Findings'));
      list.append(...sorted(run.findings).slice(0, 80).map(findingRow));
      card.append(list);
    }
    if (run.ship && run.ship.source) {
      const ship = el('div', 'jcx-bf-ship');
      ship.append(el('p', 'jcs-label', 'Ship'), mine(run.ship.source, 'p'), mine(run.ship.built_text || '', 'p'), mine(run.ship.installed || '', 'p'));
      card.append(ship);
    }
    if ((run.owner_steps || []).length) {
      const box = el('div', 'jcx-bf-owner');
      box.append(el('p', 'jcs-label', 'Yours to do'));
      const list = el('ul');
      list.append(...run.owner_steps.map((s) => mine(s, 'li')));
      box.append(list);
      card.append(box);
    }
    if ((run.reports || []).length) {
      const box = el('div', 'jcx-bf-reports');
      box.append(el('p', 'jcs-label', 'Reports'));
      const list = el('ul');
      list.append(...run.reports.map((r) => mine(r, 'li')));
      box.append(list);
      card.append(box);
    }
    return card;
  }

  function draw(target) {
    body = target;
    const wrap = el('div', 'jcx-bf');
    wrap.append(el('p', 'jc-dim', 'Your bug protocol, on any project: 3 rounds of sweep (read-only audit agents in parallel), break (the suite, hostile inputs, the dev server) and fix (each with a test that fails first), an efficiency pass between rounds that loses no feature, then reports, a receipt and the ship step.'));
    const name = project();
    if (name && !runFor(state.runs, state.active, null, name)) {
      const start = button('Turn on for this project…', 'filled', () => send({ type: 'code_bugfix_start', project: name }), 'Asks first, with the whole scope and the spending ceiling');
      const row = el('div', 'jcx-bf-actions');
      row.append(mine(name, 'span', 'jcx-bf-project'), el('span', 'jc-spacer'), start);
      wrap.append(row);
    }
    if (!state.runs.length) wrap.append(el('p', 'jc-dim', 'No runs yet.'));
    wrap.append(...state.runs.slice(0, 12).map(runCard));
    keepFocus(target, () => target.replaceChildren(wrap));
  }

  F.registerPane('bugfix', {
    title: 'Bug Fix Mode',
    render(target) { draw(target); send({ type: 'code_bugfix' }); },
  });
  F.registerMoreItem({ label: 'Bug Fix Mode…', run: () => F.openPane('bugfix') });

  const title = document.getElementById('jc-title');
  if (title) new MutationObserver(redraw).observe(title, { childList: true, characterData: true, subtree: true });

  F.on('code_bugfix', (ev) => {
    state.runs = ev.runs || [];
    state.active = ev.active || {};
    render();
    redraw();
  }, { replay: true });
  F.on('tasks', () => { redraw(); render(); });
  F.on('hello', () => send({ type: 'code_bugfix' }));
  redraw();
})(typeof window === 'object' ? window : globalThis);
