// Eden Code settings › Dependency upgrades (features/code_deps.py): a project, Check now (its
// package managers' own outdated commands: nothing else is fetched), the plan as rows (one
// batch of patch and minor upgrades per manager, each major on its own) with Upgrade… on
// each (the backend reads the release notes then, finds the call sites and puts the whole
// scope on a card), whether release notes are read and each upgrade's spending cap, and the
// scheduled dependency check (features/code_triggers.py: daily or weekly, tell or also
// upgrade the batch; turned on behind a card).
//
// Package names and versions are data: text only (textContent), marked data-no-i18n. Pure
// helpers are exported for node --test (tests/web/code-deps.test.mjs).
(function (root) {
  'use strict';

  const KIND = { patch: 'Patch', minor: 'Minor', major: 'Major', unknown: 'Unknown jump' };
  const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  // The plan's rows: batches first, then majors, each with its packages' lines.
  function rowsOf(groups) {
    const list = Array.isArray(groups) ? groups.filter((g) => g && g.id && Array.isArray(g.packages)) : [];
    return list.slice().sort((a, b) => (a.kind === 'batch' ? 0 : 1) - (b.kind === 'batch' ? 0 : 1))
      .map((g) => ({
        id: String(g.id),
        kind: g.kind === 'batch' ? 'batch' : 'major',
        title: String(g.title || g.id),
        lines: g.packages.map((p) => `${p.name} ${p.current} → ${p.latest}`),
        kinds: [...new Set(g.packages.map((p) => KIND[p.kind] || KIND.unknown))],
      }));
  }

  // "Checked 5 minutes ago" (or not yet).
  function checkedLine(ts, now = Date.now() / 1000) {
    const t = Number(ts) || 0;
    if (!t) return 'Not checked yet.';
    const mins = Math.max(0, Math.round((now - t) / 60));
    if (mins < 1) return 'Checked just now.';
    if (mins < 60) return `Checked ${mins} minute${mins === 1 ? '' : 's'} ago.`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `Checked ${hours} hour${hours === 1 ? '' : 's'} ago.`;
    return `Checked ${Math.round(hours / 24)} days ago.`;
  }

  // The scheduled check in words ('' when it's off).
  function scheduleLine(config) {
    const c = config || {};
    if (!Array.isArray(c.projects) || !c.projects.length || !c.time) return '';
    const when = c.every === 'weekly' ? `every ${DAYS[Number(c.day) || 0]} at ${c.time}` : `every day at ${c.time}`;
    const what = c.upgrade === 'batch' ? 'tells you and upgrades the patch and minor ones' : 'tells you what’s out of date';
    return `${c.projects.join(', ')}: ${when}; ${what}.`;
  }

  // The schedule's message, or why it can't be sent.
  function scheduleMsg(form) {
    const f = form || {};
    if (!f.project) return { error: 'Pick a project first.' };
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(f.time || ''))) return { error: 'The time is HH:MM, like 09:00.' };
    return {
      msg: {
        type: 'code_deps_schedule_set', projects: [f.project], every: f.every === 'weekly' ? 'weekly' : 'daily',
        day: Math.min(6, Math.max(0, Number(f.day) || 0)), time: f.time, upgrade: f.upgrade === 'batch' ? 'batch' : 'tell',
      },
    };
  }

  const api = { KIND, DAYS, rowsOf, checkedLine, scheduleLine, scheduleMsg };
  if (typeof module === 'object' && module.exports) module.exports = api;

  const F = root.jarvisFeatures;
  if (!F || typeof document === 'undefined') return;
  const { el, send, t } = F;
  const keepFocus = (box, drawIt) => (root.jarvisFocus ? root.jarvisFocus.keep(box, drawIt) : drawIt());
  const projects = () => (typeof deckProjects !== 'undefined' ? deckProjects.map((p) => p.name) : []);
  const state = { project: '', checks: {}, schedule: null, notes: true, spend: 5,
    form: { every: 'daily', day: 0, time: '09:00', upgrade: 'tell' }, error: '' };
  let group = null;

  function mine(text, tag = 'span', cls = '') {
    const node = el(tag, cls, text);
    node.dataset.noI18n = '';
    return node;
  }

  function button(label, cls, run, aria) {
    const b = el('button', `jc-btn small ${cls || ''}`.trim(), label);
    b.type = 'button';
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', (e) => { e.preventDefault(); run(b); });
    return b;
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

  function select(options, value, label, run) {
    const pick = el('select', 'jcs-select');
    pick.setAttribute('aria-label', t(label));
    for (const [v, words, raw] of options) {
      const o = raw ? mine(words, 'option') : el('option', '', words);
      o.value = v;
      o.selected = String(v) === String(value);
      pick.append(o);
    }
    pick.addEventListener('change', () => run(pick.value));
    return pick;
  }

  function projectBlock() {
    const names = projects();
    if (!state.project && names.length) state.project = names[0];
    const check = state.checks[state.project] || {};
    const tools = el('span', 'jcx-dep-tools');
    tools.append(
      select(names.map((n) => [n, n, true]), state.project, 'Project', (v) => { state.project = v; send({ type: 'code_deps', project: v }); draw(); }),
      button(check.checking ? 'Checking…' : 'Check now', '', () => { if (state.project) send({ type: 'code_deps_check', project: state.project }); }, t('Check now')),
    );
    const box = el('div');
    box.append(row('Project', t(checkedLine(check.checked)), tools));
    for (const e of check.errors || []) {
      const warn = mine(e, 'p', 'jcx-dep-error');
      warn.setAttribute('role', 'status');
      box.append(warn);
    }
    if (check.checked && !(check.groups || []).length && !(check.errors || []).length) {
      box.append(el('p', 'jc-dim jcx-dep-note', (check.managers || []).length ? 'Everything is up to date.' : 'No package manager found in this project.'));
    }
    const list = el('ul', 'jcx-dep-list');
    list.setAttribute('aria-label', t('Upgrades'));
    const running = new Set(check.running || []);
    for (const r of rowsOf(check.groups)) {
      const li = el('li', `jcx-dep-row jcx-dep-${r.kind}`);
      const head = el('div', 'jcx-dep-head');
      head.append(mine(r.title, 'strong'), el('span', `jcx-chip ${r.kind === 'major' ? 'warn' : 'good'}`, r.kind === 'major' ? 'Major' : 'Patch and minor'), el('span', 'jc-spacer'));
      head.append(running.has(r.id)
        ? el('span', 'jc-dim', 'Upgrading…')
        : button('Upgrade…', '', () => send({ type: 'code_deps_upgrade', project: state.project, group: r.id }), `${t('Upgrade…')} ${r.title}`));
      li.append(head);
      if (r.kind === 'batch') li.append(mine(r.lines.join(' · '), 'p', 'jcx-dep-pkgs'));  // (a major's title says it)
      list.append(li);
    }
    if (list.childElementCount) box.append(list);
    return box;
  }

  function optionsBlock() {
    const box = el('div');
    const sw = el('button', 'jcs-switch');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-checked', String(state.notes));
    sw.setAttribute('aria-label', t('Read release notes'));
    sw.addEventListener('click', () => send({ type: 'feature_prefs', changes: { code_deps_notes: !state.notes } }));
    box.append(row('Read release notes', 'When an upgrade starts, its release notes are read from the package’s registry and GitHub, to find what broke and where this project uses it. Off: the session works from the tests alone.', sw));
    const spend = el('input', 'jcs-input');
    spend.type = 'number';
    spend.min = '0.5';
    spend.max = '50';
    spend.step = '0.5';
    spend.value = String(state.spend);
    spend.setAttribute('aria-label', t('Spending cap ($)'));
    spend.addEventListener('change', () => {
      const n = Number(spend.value);
      if (n >= 0.5 && n <= 50) send({ type: 'feature_prefs', changes: { code_deps_spend: n } });
    });
    box.append(row('Spending cap ($)', 'For each upgrade session; it also stops after 2 hours.', spend));
    return box;
  }

  function scheduleBlock() {
    const box = el('section', 'jcx-dep-schedule');
    box.setAttribute('aria-label', t('Dependency check'));
    const config = state.schedule && state.schedule.config;
    const line = scheduleLine(config);
    if (line) {
      const head = el('div', 'jcx-dep-head');
      head.append(el('strong', '', 'Dependency check'), el('span', 'jcx-chip good', 'On'), el('span', 'jc-spacer'),
        button('Turn off', 'danger', () => send({ type: 'code_deps_schedule_off' }), t('Turn off the dependency check')));
      box.append(head, mine(line, 'p', 'jc-dim jcx-dep-note'));
      return box;
    }
    const f = state.form;
    box.append(row('Dependency check', 'Checks the project above on a schedule and tells you what’s out of date. No model is used.', null));
    const when = el('span', 'jcx-dep-tools');
    when.append(select([['daily', t('Every day')], ['weekly', t('Every week')]], f.every, 'How often', (v) => { f.every = v; draw(); }));
    if (f.every === 'weekly') when.append(select(DAYS.map((d, i) => [i, t(d)]), f.day, 'Day', (v) => { f.day = Number(v); }));
    const time = el('input', 'jcs-input');
    time.type = 'time';
    time.value = f.time;
    time.setAttribute('aria-label', t('Time'));
    time.addEventListener('input', () => { f.time = time.value; });
    when.append(time);
    box.append(row('How often', '', when));
    box.append(row('After each check', '', select([['tell', t('Tell me')], ['batch', t('Also upgrade the patch and minor ones')]], f.upgrade, 'After each check', (v) => { f.upgrade = v; })));
    const actions = el('div', 'jcx-dep-actions');
    const why = el('small', 'jcx-dep-error');
    why.setAttribute('role', 'status');
    why.textContent = state.error ? t(state.error) : '';
    actions.append(why, el('span', 'jc-spacer'), button('Turn it on…', 'filled', () => {
      const made = scheduleMsg({ ...f, project: state.project });
      state.error = made.error || '';
      if (made.msg) send(made.msg);
      draw();
    }, t('Turn on the dependency check')));
    box.append(actions);
    return box;
  }

  function draw() {
    if (!group) return;
    keepFocus(group, () => group.replaceChildren(
      row('Dependency upgrades', 'Finds what’s out of date with the package managers’ own commands. An upgrade runs as a session in an isolated copy with the release notes’ breaking changes and where this project uses them, runs the tests, and its pull request waits for your OK.'),
      projectBlock(),
      optionsBlock(),
      scheduleBlock(),
    ));
  }

  (function addSettings() {
    const general = document.getElementById('jcs-general');
    if (!general) return;
    const label = el('p', 'jcs-label', 'Dependency upgrades');
    group = el('div', 'jcs-group jcx-dep');
    const foot = general.querySelector('.jcs-foot');
    general.insertBefore(label, foot);
    general.insertBefore(group, foot);
    draw();
  })();

  const take = (features) => {
    const f = features || {};
    state.notes = f.code_deps_notes !== false;
    state.spend = typeof f.code_deps_spend === 'number' ? f.code_deps_spend : 5;
    draw();
  };
  F.on('hello', (ev) => {
    take(ev.prefs && ev.prefs.features);
    send({ type: 'code_deps_schedule' });
    if (state.project) send({ type: 'code_deps', project: state.project });
  }, { replay: true });
  F.on('prefs', (ev) => take(ev.features), { replay: true });
  F.on('code_deps', (ev) => {
    if (!ev.project) return;
    state.checks[ev.project] = ev;
    draw();
  });
  F.on('code_deps_schedule', (ev) => { state.schedule = ev; state.error = ''; draw(); });
  F.on('claude_projects', () => draw());
  root.JarvisDeps = { state };
})(typeof window === 'object' ? window : globalThis);
