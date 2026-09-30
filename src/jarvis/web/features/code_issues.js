// Jarvis Code settings › GitHub (features/code_pr.py and code_issues.py): whether new pull
// requests fix their failing checks by themselves, and the repositories whose issues,
// labelled for Jarvis, start a session without the owner. Opting one in sends the scope to
// the backend, which puts it on a card first.
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send, t } = F;
  const state = {
    features: {},
    repos: [],
    connected: true,
    form: { project: '', label: 'jarvis', commands: '', spend: '5', sandbox: true },
    detected: {}, // project -> { repo, note }
  };
  const projects = () => (typeof deckProjects !== 'undefined' ? deckProjects.map((p) => p.name) : []);
  let group = null;

  function mine(text, tag = 'span', cls = '') {
    const node = el(tag, cls, text);
    node.dataset.noI18n = '';
    return node;
  }

  function button(label, cls, run) {
    const b = el('button', `jc-btn small ${cls || ''}`.trim(), label);
    b.type = 'button';
    b.addEventListener('click', (e) => { e.preventDefault(); run(b); });
    return b;
  }

  function sw(label, on, run) {
    const toggle = el('button', 'jcs-switch');
    toggle.type = 'button';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', String(!!on));
    toggle.setAttribute('aria-label', label);
    toggle.addEventListener('click', () => run(!on));
    return toggle;
  }

  function row(title, note, control) {
    const r = el('div', 'jcs-row');
    const text = el('span');
    text.append(document.createTextNode(t(title)));
    if (note) text.append(el('small', '', note));
    r.append(text);
    if (control) r.append(control);
    return r;
  }

  function addForm() {
    const f = state.form;
    const names = projects();
    if (!f.project && names.length) f.project = names[0];
    const box = el('form', 'jcx-issue-form');
    const pick = el('select', 'jcs-select');
    pick.setAttribute('aria-label', 'Project');
    pick.dataset.noI18n = '';
    for (const name of names) {
      const o = el('option', '', name);
      o.value = name;
      o.selected = name === f.project;
      pick.append(o);
    }
    pick.addEventListener('change', () => { f.project = pick.value; send({ type: 'code_issue_detect', project: f.project }); draw(); });
    const found = state.detected[f.project];
    const where = el('p', 'jc-dim jcx-issue-where');
    if (found && found.repo) where.append(mine(found.repo, 'code'));
    else if (found && found.note) where.append(el('span', '', found.note));
    const label = el('input', 'jcs-input');
    label.value = f.label;
    label.maxLength = 50;
    label.setAttribute('aria-label', 'Label');
    label.dataset.noI18n = '';
    label.addEventListener('input', () => { f.label = label.value; });
    const commands = el('input', 'jcs-input');
    commands.placeholder = t('npm test, uv run pytest');
    commands.value = f.commands;
    commands.setAttribute('aria-label', 'Commands it may run');
    commands.dataset.noI18n = '';
    commands.addEventListener('input', () => { f.commands = commands.value; });
    const spend = el('input', 'jcs-input jcx-issue-num');
    spend.type = 'number';
    spend.min = '0.5';
    spend.max = '50';
    spend.step = '0.5';
    spend.value = f.spend;
    spend.setAttribute('aria-label', 'Spending cap ($)');
    spend.addEventListener('input', () => { f.spend = spend.value; });
    const add = el('button', 'jc-btn small filled', 'Opt it in…');
    add.type = 'submit';
    add.disabled = !(found && found.repo);
    box.append(
      row('Project', '', pick),
      where,
      row('Label', 'An issue with this label starts a session.', label),
      row('Commands it may run', 'Beyond the read-only ones and the project’s own rules.', commands),
      row('Spending cap ($)', 'For each session; it also stops after an hour.', spend),
      row('Commands without network access', 'Its commands run in a sandbox. Turn it off if its tests need the network.', sw('Commands without network access', f.sandbox, (on) => { f.sandbox = on; draw(); })),
    );
    const actions = el('div', 'jcx-issue-actions');
    actions.append(el('span', 'jc-spacer'), add);
    box.append(actions);
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      send({
        type: 'code_issue_add',
        project: f.project,
        label: f.label.trim() || 'jarvis',
        commands: f.commands.split(',').map((c) => c.trim()).filter(Boolean),
        spend_cap: Number(f.spend) || 5,
        sandbox: !!f.sandbox,
      });
    });
    return box;
  }

  function draw() {
    if (!group) return;
    const autofix = state.features.code_pr_autofix !== false;
    const parts = [
      row('Fix failing checks by themselves', 'New pull requests send their failing checks’ logs to the session, at most 3 times. Each has its own switch in its pane.',
        sw('Fix failing checks by themselves', autofix, (on) => send({ type: 'feature_prefs', changes: { code_pr_autofix: on } }))),
      row('Issues for Jarvis', 'An issue labelled for Jarvis in one of these repositories starts a session without you. Its text is only data, and its pull request waits for your OK.'),
    ];
    group.replaceChildren(...parts);
    if (!state.connected) {
      const note = el('div', 'jcx-issue-connect');
      note.append(el('span', '', 'Connect GitHub in Tools & Accounts first.'),
        button('Open Tools & Accounts', '', () => { if (typeof toggleAccounts === 'function') toggleAccounts(true); }));
      group.append(note);
    }
    if (state.repos.length) {
      const list = el('ul', 'jcx-issue-list');
      list.append(...state.repos.map((r) => {
        const li = el('li');
        const text = el('span', 'jcx-issue-repo');
        text.append(mine(r.repo, 'code'), mine(` · “${r.label}” · ${r.project}`));
        li.append(text, button('Remove', 'danger', () => send({ type: 'code_issue_remove', repo: r.repo })));
        return li;
      }));
      group.append(list);
    }
    group.append(addForm());
  }

  (function addSettings() {
    const general = document.getElementById('jcs-general');
    if (!general) return;
    const label = el('p', 'jcs-label', 'GitHub: pull requests and issues');
    group = el('div', 'jcs-group jcx-issues');
    const foot = general.querySelector('.jcs-foot');
    general.insertBefore(label, foot);
    general.insertBefore(group, foot);
    draw();
  })();

  function prefsFrom(prefs) {
    if (prefs && prefs.features) state.features = prefs.features;
    draw();
  }
  F.on('hello', (ev) => { prefsFrom(ev.prefs); send({ type: 'code_issues' }); }, { replay: true });
  F.on('prefs', (ev) => prefsFrom(ev), { replay: true });
  F.on('code_issues', (ev) => { state.repos = ev.repos || []; state.connected = ev.connected !== false; draw(); });
  F.on('code_issue_repo', (ev) => { state.detected[ev.project] = { repo: ev.repo, note: ev.note }; draw(); });
  F.on('claude_projects', () => {
    const f = state.form;
    if (!f.project && projects().length) { f.project = projects()[0]; send({ type: 'code_issue_detect', project: f.project }); }
    draw();
  });
})();
