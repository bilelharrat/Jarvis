// Eden Code: set up a cloud machine of your own (features/code_provision.py), in Eden Code
// settings › Machines, under the machines code-handoff.js lists. Pick a provider (Google
// Cloud, AWS, Hetzner, DigitalOcean, Fly.io, or Docker/OrbStack or Tart on this Mac), a size
// and a name; "Plan" shows every command that would run and what it would cost (nothing is
// made); "Create…" puts up a card with the same plan, and only its yes makes anything. Then
// the machines Eden made (start, stop, delete, save a warm image for a project), the warm
// images, and the idle stop that caps cost.
//
// Everything from the backend is data: text only (textContent); names, commands and prices
// are marked data-no-i18n. Pure helpers are exported for node --test
// (tests/web/code-provision.test.mjs).
(function (root) {
  'use strict';

  const STATE_WORDS = { creating: 'Creating…', running: 'Running', stopped: 'Stopped', failed: 'Failed' };
  const IDLE_CHOICES = [[0, 'Never'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [120, '2 hours']];

  // $0.022/h; "Free" for a machine on this Mac.
  function fmtHourly(hourly) {
    const v = Number(hourly) || 0;
    return v > 0 ? `$${v.toFixed(3)}/h` : 'Free';
  }

  // A size as the menu lists it.
  function sizeLabel(size) {
    return `${size.id} · ${size.label} · ${fmtHourly(size.hourly)}`;
  }

  // A name nobody has yet: jarvis-cloud first (what Cloud runs look for), then eden-<provider>.
  function defaultName(providerId, taken) {
    const used = new Set(taken || []);
    const base = used.has('jarvis-cloud') ? `eden-${providerId}` : 'jarvis-cloud';
    if (!used.has(base)) return base;
    for (let i = 2; i < 100; i += 1) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
    return base;
  }

  // A machine's line: what's being done to it, else its state (and its problem).
  function machineWord(m) {
    if (!m) return '';
    if (m.busy) return m.busy;
    const word = STATE_WORDS[m.state] || 'Unknown';
    return m.problem && m.state !== 'running' ? `${word}: ${m.problem}` : word;
  }

  // What a provider's check said, in a line.
  function checkWord(check) {
    if (!check) return '';
    if (check.problem) return check.problem;
    if (check.signed_in) return check.account ? `Signed in as ${check.account}` : 'Signed in';
    return '';
  }

  // Which buttons a machine gets.
  function actions(m, provider) {
    if (!m || m.busy) return [];
    const out = [];
    if (m.state === 'stopped') out.push('start');
    if (m.state === 'running') out.push('stop');
    if (m.state === 'running' && provider && provider.images) out.push('image');
    out.push('delete');
    return out;
  }

  const api = { fmtHourly, sizeLabel, defaultName, machineWord, checkWord, actions, IDLE_CHOICES };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, send, t } = F;
  const state = { providers: [], machines: [], envs: [], projects: [], key: false, checks: {}, plan: null, features: {}, hosts: [] };
  const noI18n = (node) => { node.dataset.noI18n = ''; return node; };
  function button(label, run, cls = 'btn') {
    const b = el('button', cls, label);
    b.type = 'button';
    b.addEventListener('click', run);
    return b;
  }
  function row(label, control, small) {
    const r = el('label', 'jcs-row');
    const words = el('span');
    words.append(document.createTextNode(t(label)));
    if (small) words.append(el('small', '', t(small)));
    r.append(words, control);
    return r;
  }

  const panel = document.getElementById('jcs-machines');
  if (!panel) return;
  const section = el('section', 'jcp');
  section.setAttribute('aria-label', t('Set up a cloud machine'));

  // ── the form ──
  const provider = el('select', 'jcs-select');
  provider.id = 'jcp-provider';
  const size = el('select', 'jcs-select');
  size.id = 'jcp-size';
  const region = noI18n(el('input', 'jcs-input jcp-mono'));
  region.id = 'jcp-region';
  region.spellcheck = false;
  const name = noI18n(el('input', 'jcs-input jcp-mono'));
  name.id = 'jcp-name';
  name.spellcheck = false;
  const project = el('select', 'jcs-select');
  project.id = 'jcp-project';
  const checkLine = el('p', 'jcs-help jcp-check');
  checkLine.setAttribute('aria-live', 'polite');
  const planBtn = button('Plan', () => askPlan(), 'btn');
  const planBox = el('div', 'jcp-plan');
  planBox.hidden = true;
  planBox.setAttribute('aria-live', 'polite');
  const regionRow = row('Region', region);
  const form = el('div', 'jcs-group');
  form.append(row('Provider', provider), checkLine, row('Size', size), regionRow, row('Name', name, 'The SSH alias, and the machine’s name there'),
    row('For project', project, 'Optional: starts from its warm image, and its Cloud runs go here'));
  const planRow = el('div', 'jcp-buttons');
  planRow.append(planBtn);
  form.append(planRow);

  // ── what Eden made ──
  const madeLabel = el('p', 'jcs-label', 'Machines Eden made');
  const made = el('ul', 'jch-list');
  const envLabel = el('p', 'jcs-label', 'Warm images');
  const envs = el('ul', 'jch-list');

  // ── cost caps ──
  const idle = el('select', 'jcs-select');
  idle.id = 'jcp-idle';
  for (const [value, words] of IDLE_CHOICES) {
    const o = el('option', '', t(words));
    o.value = String(value);
    idle.append(o);
  }
  idle.addEventListener('change', () => send({ type: 'feature_prefs', changes: { code_provision_idle_minutes: Number(idle.value) } }));
  const action = el('select', 'jcs-select');
  action.id = 'jcp-action';
  for (const [value, words] of [['stop', 'Stop it'], ['delete', 'Delete it (only with no hand-off work on it)']]) {
    const o = el('option', '', t(words));
    o.value = value;
    action.append(o);
  }
  action.addEventListener('change', () => send({ type: 'feature_prefs', changes: { code_provision_idle_action: action.value } }));
  const wake = el('button', 'jcs-switch');
  wake.type = 'button';
  wake.id = 'jcp-wake';
  wake.setAttribute('role', 'switch');
  wake.setAttribute('aria-label', t('Start a stopped machine when a session needs it'));
  wake.addEventListener('click', () => {
    const on = wake.getAttribute('aria-checked') !== 'true';
    wake.setAttribute('aria-checked', String(on));
    send({ type: 'feature_prefs', changes: { code_provision_wake: on } });
  });
  const caps = el('div', 'jcs-group');
  caps.append(
    row('Stop machines idle for', idle, 'The machine stops itself too, with the Mac shut. Nothing running and nobody connected counts as idle.'),
    row('When idle', action, 'Hetzner and DigitalOcean bill a machine while it’s off: delete caps their cost (save a warm image first).'),
    row('Start a stopped machine when a session needs it', wake),
  );

  section.append(
    el('p', 'jcs-label', 'Set up a cloud machine'),
    el('p', 'jcs-intro', 'A machine of your own, at a provider you pick, with your own login: your code and prompts go nowhere Eden runs. Plan shows every command and the cost first; nothing is made until you say yes.'),
    form, planBox, madeLabel, made, envLabel, envs,
    el('p', 'jcs-label', 'Cost caps'), caps,
    el('p', 'jcs-foot', 'Machines are billed by their provider to your account. Prices are estimates from list prices; Eden doesn’t bill or meter them.'),
  );
  panel.append(section);

  function current() { return state.providers.find((p) => p.id === provider.value) || state.providers[0] || null; }
  function taken() { return [...state.machines.map((m) => m.alias), ...state.hosts]; }

  function drawForm(keepName) {
    const chosen = provider.value;
    provider.replaceChildren(...state.providers.map((p) => {
      const o = el('option', '', p.installed ? p.name : `${p.name} (${p.cli} not installed)`);
      o.value = p.id;
      return o;
    }));
    if (chosen && state.providers.some((p) => p.id === chosen)) provider.value = chosen;
    const p = current();
    if (!p) return;
    const sizeWas = size.value;
    size.replaceChildren(...p.sizes.map((s) => { const o = noI18n(el('option', '', sizeLabel(s))); o.value = s.id; return o; }));
    if (p.sizes.some((s) => s.id === sizeWas)) size.value = sizeWas;
    regionRow.hidden = !!p.local;
    regionRow.querySelector('span').firstChild.textContent = t(p.region_label || 'Region');
    if (!keepName || !region.value) region.value = p.region;
    if (!keepName || !name.value) name.value = defaultName(p.id, taken());
    const projWas = project.value;
    const none = el('option', '', t('None'));
    none.value = '';
    project.replaceChildren(none, ...state.projects.map((n) => { const o = noI18n(el('option', '', n)); o.value = n; return o; }));
    if (state.projects.includes(projWas)) project.value = projWas;
    checkLine.textContent = t(checkWord(state.checks[p.id]) || (p.installed ? 'Checking the sign-in…' : `${p.cli} isn't installed. ${p.install}.`));
  }

  provider.addEventListener('change', () => {
    state.plan = null;
    drawForm(false);
    drawPlan();
    send({ type: 'code_provision_check', provider: provider.value });
  });
  for (const input of [size, region, name, project]) input.addEventListener('change', () => { state.plan = null; drawPlan(); });

  function askPlan() {
    planBox.hidden = false;
    planBox.replaceChildren(el('p', 'jcs-help', t('Planning… (nothing is made)')));
    send({ type: 'code_provision_plan', provider: provider.value, size: size.value, region: region.value.trim(), alias: name.value.trim(), project: project.value });
  }

  function drawPlan() {
    const plan = state.plan;
    planBox.hidden = !plan;
    if (!plan) { planBox.replaceChildren(); return; }
    if (plan.problem && !plan.steps) { planBox.replaceChildren(el('p', 'jch-status bad', plan.problem)); return; }
    const parts = [];
    const cost = el('ul', 'jcp-cost');
    for (const line of (plan.estimate && plan.estimate.lines) || []) cost.append(el('li', '', line));
    parts.push(el('p', 'jcs-label', 'Cost'), cost);
    for (const c of plan.checks || []) parts.push(el('p', `jch-status ${c.ok ? 'ok' : 'bad'}`, c.ok ? `${c.label}: OK` : `${c.label}: ${c.said}`));
    parts.push(el('p', 'jcs-label', 'Runs, with your own login'));
    parts.push(noI18n(el('pre', 'jcp-steps', (plan.steps || []).join('\n'))));
    const then = el('ul', 'jcp-cost');
    for (const line of plan.finish || []) then.append(el('li', '', line));
    parts.push(el('p', 'jcs-label', 'Then'), then);
    for (const note of plan.notes || []) parts.push(el('p', 'jcs-help', note));
    const boot = el('details', 'jcp-boot');
    boot.append(el('summary', '', t('First-boot script')), noI18n(el('pre', 'jcp-steps', plan.bootstrap || '')));
    parts.push(boot);
    if (plan.problem) parts.push(el('p', 'jch-status bad', plan.problem));
    const create = button('Create…', () => send({ type: 'code_provision_create', plan: plan.id }), 'btn primary');
    create.disabled = !!plan.problem;
    const buttons = el('div', 'jcp-buttons');
    buttons.append(create);
    parts.push(buttons);
    planBox.replaceChildren(...parts);
  }

  function machineItem(m) {
    const li = el('li', 'jcs-provider jch-machine');
    const head = el('div', 'jcs-p-head');
    const title = el('span', 'jcs-p-title');
    const p = state.providers.find((x) => x.id === m.provider);
    title.append(noI18n(el('strong', '', m.alias)));
    title.append(el('small', `jch-status ${m.state === 'running' ? 'ok' : m.state === 'failed' ? 'bad' : ''}`, machineWord(m)));
    const facts = [p ? p.name : m.provider, m.size, m.region !== 'local' ? m.region : '', m.ip, m.project ? `for ${m.project}` : ''].filter(Boolean).join(' · ');
    title.append(noI18n(el('small', 'jch-facts', facts)));
    head.append(title);
    for (const what of actions(m, p)) {
      if (what === 'start') head.append(button('Start', () => send({ type: 'code_provision_start', alias: m.alias })));
      if (what === 'stop') head.append(button('Stop', () => send({ type: 'code_provision_stop', alias: m.alias })));
      if (what === 'delete') head.append(button('Delete…', () => send({ type: 'code_provision_delete', alias: m.alias })));
      if (what === 'image') {
        const pick = el('select', 'jcs-select jcp-pick');
        pick.setAttribute('aria-label', t(`Project for ${m.alias}'s warm image`));
        for (const n of state.projects) { const o = noI18n(el('option', '', n)); o.value = n; pick.append(o); }
        if (m.project && state.projects.includes(m.project)) pick.value = m.project;
        const save = button('Save warm image…', () => pick.value && send({ type: 'code_provision_env_save', alias: m.alias, project: pick.value }));
        save.disabled = !state.projects.length;
        head.append(pick, save);
      }
    }
    li.append(head);
    return li;
  }

  function envItem(e) {
    const li = el('li', 'jcs-provider');
    const head = el('div', 'jcs-p-head');
    const title = el('span', 'jcs-p-title');
    const p = state.providers.find((x) => x.id === e.provider);
    title.append(noI18n(el('strong', '', e.project)));
    title.append(noI18n(el('small', 'jch-facts', [p ? p.name : e.provider, e.image, e.region !== 'local' ? e.region : ''].filter(Boolean).join(' · '))));
    head.append(title, button('Delete…', () => send({ type: 'code_provision_env_forget', project: e.project, provider: e.provider })));
    li.append(head);
    return li;
  }

  function drawLists() {
    made.replaceChildren(...state.machines.map(machineItem));
    made.hidden = madeLabel.hidden = !state.machines.length;
    envs.replaceChildren(...state.envs.map(envItem));
    envs.hidden = envLabel.hidden = !state.envs.length;
  }

  function drawCaps() {
    const f = state.features || {};
    const minutes = Number.isFinite(f.code_provision_idle_minutes) ? f.code_provision_idle_minutes : 30;
    idle.value = String(IDLE_CHOICES.some(([v]) => v === minutes) ? minutes : 30);
    action.value = f.code_provision_idle_action === 'delete' ? 'delete' : 'stop';
    wake.setAttribute('aria-checked', String(f.code_provision_wake !== false));
  }

  let first = true;
  F.on('code_provision', (ev) => {
    state.providers = ev.providers || [];
    state.machines = ev.machines || [];
    state.envs = ev.envs || [];
    state.projects = ev.projects || [];
    state.key = !!ev.key;
    drawForm(!first);
    drawLists();
    if (first && state.providers.length) { first = false; send({ type: 'code_provision_check', provider: provider.value }); }
  }, { replay: true });
  F.on('code_provision_checked', (ev) => { state.checks[ev.provider] = ev; drawForm(true); });
  F.on('code_provision_plan', (ev) => { state.plan = ev; drawPlan(); });
  F.on('code_handoffs', (ev) => { state.hosts = ev.hosts || []; });
  F.on('prefs', (ev) => { state.features = ev.features || {}; drawCaps(); }, { replay: true });
  F.on('hello', (ev) => { state.features = (ev.prefs && ev.prefs.features) || {}; drawCaps(); send({ type: 'code_provision_state' }); }, { replay: true });
  new MutationObserver(() => { if (!panel.hidden) send({ type: 'code_provision_state' }); })
    .observe(panel, { attributes: true, attributeFilter: ['hidden'] });
  drawCaps();
})(typeof window === 'object' ? window : globalThis);
