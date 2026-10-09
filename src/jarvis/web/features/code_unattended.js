// Eden Code's runs without the owner (features/code_unattended.py): the "Without you"
// pane, from the More menu. A form for the scope (what to do, the project, the mode, the
// commands it may run, a spending cap and a time cap, now or on a schedule): the backend
// puts the whole scope on a card before anything starts. Below it, the runs (stop one
// that's running, open its session, what it was refused) and the scheduled ones. A running
// one's session says so in its header.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send, t } = F;
  const state = {
    runs: [],
    jobs: [],
    active: {}, // session id -> run id, while it runs
    form: { prompt: '', project: '', mode: 'edits', commands: '', spend: '5', hours: '2', when: 'now', time: '01:00', date: '' },
    open: new Set(), // runs whose refused steps are shown
  };
  let body = null;

  const showing = () => body && body.isConnected && body.querySelector('.jcx-runs');
  const render = () => { if (showing()) draw(body); };
  const projects = () => (typeof deckProjects !== 'undefined' ? deckProjects.map((p) => p.name) : []);
  const current = () => (typeof deckProject === 'string' ? deckProject : '');
  const sessions = () => (typeof ccTasks !== 'undefined' ? ccTasks : []);

  function button(label, cls, run, title) {
    const b = el('button', `jc-btn small ${cls || ''}`.trim(), label);
    b.type = 'button';
    if (title) b.title = t(title);
    b.addEventListener('click', (e) => { e.preventDefault(); run(b); });
    return b;
  }

  function mine(text, tag = 'span', cls = '') {
    const node = el(tag, cls, text);
    node.dataset.noI18n = '';
    return node;
  }

  function field(label, input, note) {
    const row = el('label', 'jcx-run-field');
    row.append(el('span', 'jcx-run-label', label), input);
    if (note) row.append(el('small', 'jc-dim', note));
    return row;
  }

  function select(options, value, change, label) {
    const pick = el('select', 'jcs-select');
    if (label) pick.setAttribute('aria-label', label);
    for (const [v, text] of options) {
      const o = el('option', '', text);
      o.value = v;
      o.selected = v === value;
      pick.append(o);
    }
    pick.addEventListener('change', () => change(pick.value));
    return pick;
  }

  // ── the form ──

  function form() {
    const f = state.form;
    if (!f.project) f.project = current() || projects()[0] || '';
    const box = el('form', 'jcx-run-form');
    const what = el('textarea', 'jc-field');
    what.rows = 3;
    what.placeholder = t('What should it do? (Run the tests and fix what fails)');
    what.value = f.prompt;
    what.dataset.noI18n = '';
    what.addEventListener('input', () => { f.prompt = what.value; go.disabled = !ready(); });
    const names = projects();
    if (f.project && !names.includes(f.project)) names.unshift(f.project);
    const project = select(names.map((n) => [n, n]), f.project, (v) => { f.project = v; }, 'Project');
    project.dataset.noI18n = '';
    const mode = select([['edits', 'Accept edits'], ['smart', 'Auto']], f.mode, (v) => { f.mode = v; }, 'Mode');
    const commands = el('input', 'jc-field');
    commands.placeholder = t('npm test, uv run pytest');
    commands.value = f.commands;
    commands.dataset.noI18n = '';
    commands.addEventListener('input', () => { f.commands = commands.value; });
    const spend = el('input', 'jc-field jcx-run-num');
    spend.type = 'number';
    spend.min = '0.5';
    spend.max = '50';
    spend.step = '0.5';
    spend.value = f.spend;
    spend.addEventListener('input', () => { f.spend = spend.value; });
    const hours = el('input', 'jc-field jcx-run-num');
    hours.type = 'number';
    hours.min = '0.25';
    hours.max = '12';
    hours.step = '0.25';
    hours.value = f.hours;
    hours.addEventListener('input', () => { f.hours = hours.value; });
    const when = select([['now', 'Now'], ['daily', 'Every day'], ['weekdays', 'Weekdays'], ['once', 'Once']], f.when, (v) => { f.when = v; render(); }, 'When');
    const time = el('input', 'jc-field jcx-run-time');
    time.type = 'time';
    time.value = f.time;
    time.addEventListener('input', () => { f.time = time.value; });
    const date = el('input', 'jc-field jcx-run-time');
    date.type = 'date';
    date.value = f.date;
    date.addEventListener('input', () => { f.date = date.value; go.disabled = !ready(); });
    const caps = el('div', 'jcx-run-caps');
    caps.append(field('Spending cap ($)', spend), field('Time cap (hours)', hours));
    const schedule = el('div', 'jcx-run-caps');
    schedule.append(field('When', when));
    if (f.when !== 'now') schedule.append(field('At', time));
    if (f.when === 'once') schedule.append(field('Date', date));
    const go = el('button', 'jc-btn small filled', f.when === 'now' ? 'Start…' : 'Schedule…');
    go.type = 'submit';
    go.title = t('Asks first, with the whole scope on the card');
    const ready = () => Boolean(f.prompt.trim()) && (f.when !== 'once' || Boolean(f.date));
    go.disabled = !ready();
    box.append(
      field('What to do', what),
      field('Project', project),
      field('Mode', mode, 'Accept edits: edits in its copy go ahead, and the commands below. Auto: besides those, Claude’s own safety check lets through what it judges safe.'),
      field('Commands it may run', commands, 'Beyond the read-only ones and the project’s own “don’t ask again” rules. Nothing that sends, deletes or changes the Mac.'),
      caps,
      schedule,
    );
    const actions = el('div', 'jcx-run-actions');
    actions.append(el('span', 'jc-dim', 'Always in an isolated copy; it never pushes.'), el('span', 'jc-spacer'), go);
    box.append(actions);
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!ready()) return;
      const msg = {
        type: 'code_run_start',
        prompt: f.prompt.trim(),
        project: f.project,
        mode: f.mode,
        commands: f.commands.split(',').map((c) => c.trim()).filter(Boolean),
        spend_cap: Number(f.spend) || 5,
        hours: Number(f.hours) || 2,
      };
      if (f.when !== 'now') msg.schedule = { kind: f.when, time: f.time, date: f.when === 'once' ? f.date : '' };
      send(msg);
    });
    return box;
  }

  // ── the runs ──

  const WHY = {
    finished: 'Finished',
    spend: 'Stopped: spending cap',
    time: 'Stopped: time cap',
    copy: 'Stopped: no isolated copy',
    owner: 'Stopped by you',
    restart: 'Stopped when the app quit',
    failed: 'Stopped with an error',
  };

  function chip(text, cls) { return el('span', `jcx-chip ${cls || ''}`.trim(), text); }

  function runRow(run) {
    const li = el('li', 'jcx-run');
    const head = el('div', 'jcx-run-head');
    head.append(mine(run.title, 'strong', 'jcx-run-title'));
    if (run.state === 'running') head.append(chip('Running', 'busy'));
    else head.append(chip(WHY[run.why] || WHY.failed, run.why === 'finished' ? 'good' : 'warn'));
    if (run.origin === 'issue' && run.issue && run.issue.number) head.append(mine(`#${run.issue.number}`, 'code'));
    li.append(head);
    const facts = el('p', 'jc-dim jcx-run-facts');
    const parts = [run.project];
    if (run.state !== 'running') {
      const minutes = Math.max(1, Math.round((run.ended - run.started) / 60));
      parts.push(`$${Number(run.cost || 0).toFixed(2)} of $${Number(run.spend_cap).toFixed(2)}`, `${minutes} min`);
      parts.push(`${run.files} file${run.files === 1 ? '' : 's'} changed`);
    } else {
      parts.push(`up to $${Number(run.spend_cap).toFixed(2)}`, `until ${new Date((run.started + run.hours * 3600) * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`);
    }
    parts.forEach((p, k) => { if (k) facts.append(document.createTextNode(' · ')); facts.append(k ? el('span', '', p) : mine(p)); });
    li.append(facts);
    const actions = el('div', 'jcx-run-actions');
    const listed = sessions().find((s) => s.id === run.task_id && s.kind === 'code');
    if (listed) actions.append(button('Show session', '', () => F.selectTask(run.task_id)));
    if (run.state === 'running') actions.append(button('Stop', 'danger', () => send({ type: 'code_run_stop', run: run.id })));
    if ((run.denied || []).length) {
      const n = run.denied.length;
      actions.append(button(state.open.has(run.id) ? 'Hide what it was refused' : `${n} step${n === 1 ? '' : 's'} refused`, 'plain', () => {
        if (state.open.has(run.id)) state.open.delete(run.id); else state.open.add(run.id);
        render();
      }));
    }
    li.append(actions);
    if (state.open.has(run.id)) {
      const list = el('ul', 'jcx-run-denied');
      list.append(...run.denied.map((d) => mine(d, 'li')));
      li.append(list);
    }
    return li;
  }

  function jobRow(job) {
    const li = el('li', 'jcx-run');
    const head = el('div', 'jcx-run-head');
    head.append(mine(job.title, 'strong', 'jcx-run-title'), chip(job.on ? 'Scheduled' : 'Paused', job.on ? '' : 'warn'));
    li.append(head);
    const facts = el('p', 'jc-dim jcx-run-facts');
    facts.append(el('span', '', job.when), document.createTextNode(' · '), mine(job.project), document.createTextNode(' · '), el('span', '', `up to $${Number(job.spend_cap).toFixed(2)}`));
    li.append(facts);
    const actions = el('div', 'jcx-run-actions');
    actions.append(button('Remove', 'danger', () => send({ type: 'code_run_forget', job: job.id }), 'Removes the schedule and its routine'));
    li.append(actions);
    return li;
  }

  function draw(target) {
    body = target;
    const wrap = el('div', 'jcx-runs');
    wrap.append(el('p', 'jc-dim', 'A session that works while you’re away, within a scope you approve now. Anything outside it is refused, never asked, and it reports back when it’s done.'));
    wrap.append(form());
    if (state.runs.length) {
      wrap.append(el('p', 'jcs-label', 'Runs'));
      const list = el('ul', 'jcx-run-list');
      list.append(...state.runs.slice(0, 20).map(runRow));
      wrap.append(list);
    }
    if (state.jobs.length) {
      wrap.append(el('p', 'jcs-label', 'Scheduled'));
      const list = el('ul', 'jcx-run-list');
      list.append(...state.jobs.map(jobRow));
      wrap.append(list);
    }
    target.replaceChildren(wrap);
  }

  F.registerPane('unattended', {
    title: 'Without you',
    render(target) {
      const input = document.getElementById('deck-input');
      if (input && input.value.trim() && !state.form.prompt.trim()) state.form.prompt = input.value.trim();
      if (!state.form.project) state.form.project = current();
      draw(target);
      send({ type: 'code_runs' });
    },
  });
  F.registerMoreItem({ label: 'Run without me…', run: () => F.openPane('unattended') });

  // ── the header's badge, for a session that's running without you ──

  const badge = el('button', 'jcx-run-badge');
  badge.type = 'button';
  badge.hidden = true;
  badge.addEventListener('click', () => F.openPane('unattended'));

  function drawBadge() {
    const titles = document.querySelector('.jc-titles');
    if (titles && !badge.isConnected) titles.append(badge);
    const task = F.currentTask();
    const runId = task ? state.active[String(task.id)] : null;
    const run = runId ? state.runs.find((r) => r.id === runId) : null;
    badge.hidden = !run;
    if (!run) return;
    badge.replaceChildren(el('span', 'jcx-run-dot'), el('span', '', 'Without you'));
    const until = new Date((run.started + run.hours * 3600) * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    badge.title = t(`Running without you: it stops at $${Number(run.spend_cap).toFixed(2)} spent or at ${until}.`);
  }
  const title = document.getElementById('jc-title');
  if (title) new MutationObserver(drawBadge).observe(title, { childList: true, characterData: true, subtree: true });

  // ── events ──

  F.on('code_runs', (ev) => {
    state.runs = ev.runs || [];
    state.jobs = ev.jobs || [];
    state.active = ev.active || {};
    render();
    drawBadge();
  }, { replay: true });
  F.on('tasks', () => { drawBadge(); render(); });
  F.on('hello', () => send({ type: 'code_runs' }));
  drawBadge();
})();
