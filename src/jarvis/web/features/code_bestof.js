// Eden Code's best of N (features/code_bestof.py): one request, two or three models or
// efforts at once, each in its own isolated copy; then side by side (what each changed, the
// project's tests when a command is given, a short judgment) and "Keep this one".
(() => {
  const F = window.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;
  const EFFORTS = [['', 'Default effort'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];
  const MODES = [['edits', 'Accept edits'], ['ask', 'Manual'], ['smart', 'Auto'], ['plan', 'Plan'], ['auto', 'Bypass permissions']];
  const BUILTIN = [['opus', 'Opus 5.5'], ['sonnet', 'Sonnet 5.5'], ['haiku', 'Haiku 4.5'], ['fable', 'Fable 5.1']];
  const state = {
    models: [], // [{ ref, label }] from the providers event
    groups: new Map(), // group id -> the latest code_bestof event
    features: {},
    form: null, // what's being set up: { prompt, variants: [{ model, effort }], mode, tests }
    showForm: false,
  };
  let body = null;

  const project = () => (typeof deckProject === 'string' ? deckProject : '');
  const showing = () => body && body.isConnected && body.querySelector('.jcx-bestof');
  const models = () => (state.models.length ? state.models : BUILTIN.map(([ref, label]) => ({ ref, label })));

  function button(label, cls, run, title) {
    const b = el('button', cls, label);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('click', (e) => { e.preventDefault(); run(b); });
    return b;
  }

  function select(options, value, onChange, label) {
    const s = el('select', 'jcs-select');
    s.setAttribute('aria-label', label);
    for (const [v, text] of options) {
      const o = el('option', '', text);
      o.value = v;
      o.selected = v === value;
      s.append(o);
    }
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }

  function freshForm() {
    const input = document.getElementById('deck-input');
    const tests = (state.features.code_quick_tests || {})[project()] || '';
    const list = models();
    const pick = (i) => (list[i] || list[0]).ref;
    return { prompt: input ? input.value.trim() : '', variants: [{ model: pick(1), effort: '' }, { model: pick(0), effort: '' }], mode: 'edits', tests };
  }

  function drawForm(wrap) {
    const form = state.form || (state.form = freshForm());
    wrap.append(el('p', 'jc-dim', 'One request, run by two or three models or efforts at once, each in its own isolated copy. Then compare them side by side and keep the best.'));
    const request = el('textarea', 'jc-field jcx-bprompt');
    request.rows = 3;
    request.placeholder = 'What should they all do?';
    request.value = form.prompt;
    request.dataset.noI18n = '';
    request.addEventListener('input', () => { form.prompt = request.value; });
    wrap.append(request);
    const rows = el('div', 'jcx-bvariants');
    form.variants.forEach((v, i) => {
      const row = el('div', 'jcx-bvariant');
      row.append(el('span', 'jcx-num', `#${i + 1}`),
        select(models().map((m) => [m.ref, m.label]), v.model, (value) => { v.model = value; }, 'Model'),
        select(EFFORTS, v.effort, (value) => { v.effort = value; }, 'Effort'));
      if (form.variants.length > 2) row.append(button('Remove', 'jc-mini', () => { form.variants.splice(i, 1); render(); }));
      rows.append(row);
    });
    wrap.append(rows);
    if (form.variants.length < 3) wrap.append(button('Add a third', 'jc-mini jcx-badd', () => { form.variants.push({ model: models()[0].ref, effort: 'high' }); render(); }));
    const mode = el('label', 'jcx-bfield');
    mode.append(el('span', '', 'Permission mode'), select(MODES, form.mode, (value) => { form.mode = value; }, 'Permission mode'));
    const tests = el('label', 'jcx-bfield');
    const testInput = el('input', 'jc-field');
    testInput.placeholder = 'npm test, uv run pytest -q…';
    testInput.value = form.tests;
    testInput.dataset.noI18n = '';
    testInput.addEventListener('input', () => { form.tests = testInput.value; });
    tests.append(el('span', '', 'Tests (optional)'), testInput);
    wrap.append(mode, tests, el('p', 'jc-dim jcx-bnote', 'The test command runs in each copy once they’re all done. Each variant is a real session on its model, and costs what it costs; a short judgment (Haiku) follows.'));
    const start = button('Start', 'jc-btn filled jcx-bstart', () => {
      send({ type: 'code_bestof', directory: project(), prompt: form.prompt, variants: form.variants, mode: form.mode, tests: form.tests });
      state.showForm = false;
      state.form = null;
      render();
    });
    start.disabled = !form.prompt.trim();
    request.addEventListener('input', () => { start.disabled = !request.value.trim(); });
    wrap.append(start);
  }

  function variantCard(group, v) {
    const card = el('div', `jcx-bcard ${v.status}`);
    const head = el('div', 'jcx-bhead');
    head.append(el('strong', '', v.label), el('span', `jcx-chip ${v.status === 'failed' ? 'bad' : v.status === 'working' ? 'busy' : ''}`, { working: 'working', done: 'done', failed: 'failed' }[v.status] || v.status));
    card.append(head);
    const stats = v.stats || {};
    card.append(el('p', 'jcx-bstats', stats.files !== undefined ? `${stats.files} file${stats.files === 1 ? '' : 's'} +${stats.added} −${stats.removed}` : '—'));
    if (v.test) {
      const passed = v.test.code === 0;
      const test = el('details', 'jcx-btest');
      const sum = el('summary');
      sum.append(el('span', `jcx-chip ${passed ? 'ok' : 'bad'}`, passed ? 'tests passed' : `tests failed (${v.test.code})`));
      const out = el('pre', 'jc-code', v.test.tail || '');
      out.dataset.noI18n = '';
      test.append(sum, out);
      card.append(test);
    }
    const actions = el('div', 'jcx-bactions');
    const open = () => { if (typeof selectTask === 'function') selectTask(v.task_id); };
    actions.append(button('Open', 'jc-btn small', open), button('Changes', 'jc-btn small', () => { open(); F.openPane('diff'); }));
    if (group.status === 'done') actions.append(button('Keep this one', 'jc-btn small filled', () => send({ type: 'code_bestof_keep', group: group.group, n: v.n }), 'Land this copy and discard the others (asks first)'));
    card.append(actions);
    if (group.status === 'kept' && group.kept === v.n) card.classList.add('kept');
    return card;
  }

  function drawGroup(wrap, group) {
    const head = el('div', 'jcx-bgroup-head');
    const request = el('p', 'jcx-brequest', group.prompt);
    request.dataset.noI18n = '';
    head.append(request, button('New comparison', 'jc-mini', () => { state.showForm = true; state.form = null; render(); }));
    wrap.append(head);
    const status = { running: 'Working…', comparing: 'Comparing…', done: 'Done: pick the one to keep.', kept: 'Kept.' }[group.status] || group.status;
    wrap.append(el('p', `jc-dim${group.status === 'running' || group.status === 'comparing' ? ' jc-sheen' : ''}`, status));
    if (group.judge) {
      const judge = el('div', 'jcx-bjudge');
      const text = el('span', '', group.judge);
      text.dataset.noI18n = '';
      judge.append(el('strong', '', 'Judge (Haiku)'), text);
      wrap.append(judge);
    }
    const grid = el('div', `jcx-bgrid n${group.variants.length}`);
    grid.append(...group.variants.map((v) => variantCard(group, v)));
    wrap.append(grid);
  }

  function latest() {
    let found = null;
    for (const g of state.groups.values()) if (g.project === project() && (!found || g.started > found.started)) found = g;
    return found;
  }

  function draw(target) {
    body = target;
    const wrap = el('div', 'jcx-bestof');
    if (!project()) wrap.append(el('p', 'jc-empty', 'Pick a project first.'));
    else {
      const group = latest();
      if (group && !state.showForm) drawGroup(wrap, group); else drawForm(wrap);
    }
    target.replaceChildren(wrap);
  }

  function render() { if (showing()) draw(body); }

  F.registerPane('bestof', {
    title: 'Best of N',
    render(target) {
      draw(target);
      if (project()) send({ type: 'code_bestof_state', directory: project() });
    },
  });
  F.registerMoreItem({ label: 'Best of N…', run: () => { state.showForm = !latest(); F.openPane('bestof'); } });

  F.on('providers', (ev) => { state.models = (ev.models || []).map((m) => ({ ref: m.ref, label: m.label })); }, { replay: true });
  F.on('hello', (ev) => { if (ev.prefs && ev.prefs.features) state.features = ev.prefs.features; if (ev.providers) state.models = (ev.providers.models || []).map((m) => ({ ref: m.ref, label: m.label })); }, { replay: true });
  F.on('prefs', (ev) => { if (ev.features) state.features = ev.features; }, { replay: true });
  F.on('code_bestof', (ev) => { state.groups.set(ev.group, ev); render(); });
})();
