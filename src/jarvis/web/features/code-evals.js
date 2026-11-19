// Eden Code's evals for the owner's own repository (features/code_repo_evals.py): past tasks
// as eval cases (from landed work, or a commit), a suite run on one to four configurations
// (model, effort, engine, full or lean prompt, rules on or off, or the Model Router's pick),
// each attempt in a throwaway copy, then the configurations side by side: passed, cost, time,
// diff size. A run shows its forecast on a card first, and stops at its ceiling.
// Pure helpers are exported for node --test (tests/web/code-evals.test.mjs).
(function (root) {
  'use strict';

  const ROUTER = 'router';
  const MAX_CONFIGS = 4;

  function money(usd) {
    const n = Number(usd) || 0;
    return `$${n.toFixed(2)}`;
  }

  function duration(seconds) {
    if (seconds == null) return '—';
    const s = Math.round(Number(seconds) || 0);
    return s < 90 ? `${s}s` : `${Math.round(s / 60)} min`;
  }

  // What the window sends for the configurations, and the Model Router's pick for each case
  // when one of them is the router: [ok, {configs, routes} | reason].
  function suiteToSend(configs, cases, pick) {
    const out = [];
    const routes = {};
    let routed = false;
    for (const c of configs) {
      if (c.model === ROUTER) {
        routed = true;
        out.push({ router: true, prompt: c.prompt || 'full', rules: c.rules || 'on', engine: c.engine || '', engine_version: c.engine_version || '' });
      } else {
        out.push({ model: c.model || '', label: c.label || '', effort: c.effort || '', prompt: c.prompt || 'full', rules: c.rules || 'on', engine: c.engine || '', engine_version: c.engine_version || '' });
      }
    }
    if (routed) {
      for (const k of cases) {
        const route = typeof pick === 'function' ? pick(k.prompt) : null;
        if (!route || !route.ref) return [false, 'Model Router isn’t ready yet. Try again in a moment, or pick a model.'];
        routes[k.id] = { ref: route.ref, effort: route.effort || '' };
      }
    }
    return [true, { configs: out, routes }];
  }

  // The newest n cases' ids (the state lists the newest first).
  function lastN(cases, n) { return (cases || []).slice(0, n).map((c) => c.id); }

  // A run's side-by-side rows, best first: by passes, then by cost.
  function compareRows(record) {
    const summary = (record && record.summary) || {};
    const rows = ((record && record.configs) || []).map((c) => ({ id: c.id, label: c.label, ...(summary[c.id] || { total: 0, passed: 0 }) }));
    return rows.sort((a, b) => (b.passed - a.passed) || ((a.cost_usd || 0) - (b.cost_usd || 0)));
  }

  // One result as a grid cell reads it.
  function mark(result) {
    if (!result) return ['…', 'busy'];
    return { passed: ['✓', 'ok'], failed: ['✗', 'bad'], error: ['!', 'bad'], skipped: ['–', 'dim'] }[result.status] || ['?', 'dim'];
  }

  // What calibrating found, in words ('' when it's fine or not done).
  function verdictWords(verdict) {
    return {
      ok: 'Checked: fails at the start, passes as landed',
      passes_at_start: 'Its check passes before any attempt: it can’t tell configurations apart',
      fails_landed: 'Your own landed work fails this check: fix the check',
    }[verdict] || '';
  }

  const api = { money, duration, suiteToSend, lastN, compareRows, mark, verdictWords, ROUTER, MAX_CONFIGS };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;
  const t = F.t || ((s) => s);
  const keepFocus = (box, drawIt) => (root.jarvisFocus ? root.jarvisFocus.keep(box, drawIt) : drawIt());
  const own = (node) => { node.dataset.noI18n = ''; return node; };
  const EFFORTS = [['', 'Default effort'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];
  const BUILTIN = [['opus', 'Claude Opus 5.5'], ['sonnet', 'Claude Sonnet 5.5']];
  const state = {
    models: [],
    engines: [], // [{ path, version }] from the engine radar's cw_engines, when it's there
    features: {},
    byProject: new Map(), // project -> the latest code_evals event
    runs: new Map(), // run id -> its latest record
    shown: '', // the run on show
    forecast: null,
    configs: null, // the suite's configurations being set up
    picked: null, // Set of case ids, or null: the newest 20
  };
  let body = null;

  const project = () => (typeof deckProject === 'string' ? deckProject : '');
  const here = () => state.byProject.get(project()) || null;
  const showing = () => body && body.isConnected && body.querySelector('.jcv-evals');
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
    for (const [v, text, off] of options) {
      const o = el('option', '', text);
      if (off) o.disabled = true;
      o.value = v;
      o.selected = v === value;
      s.append(o);
    }
    s.addEventListener('change', () => onChange(s.value));
    return s;
  }

  function freshConfigs() {
    const can = models().filter((m) => !m.off);
    const pick = (i) => (can[i] || can[0] || models()[0]);
    return [0, 1].map((i) => ({ model: pick(i).ref, label: pick(i).label, effort: '', prompt: 'full', rules: 'on', engine: '', engine_version: '' }));
  }

  function picked(cases) {
    const ids = state.picked ? [...state.picked] : lastN(cases, 20);
    return cases.filter((c) => ids.includes(c.id));
  }

  function suiteMessage(type) {
    const now = here();
    const cases = picked((now && now.cases) || []);
    const [ok, suite] = suiteToSend(state.configs, cases, F.routePick);
    if (!ok) return [false, suite];
    return [true, { type, directory: project(), cases: cases.map((c) => c.id), ...suite }];
  }

  // ── the suite: configurations, cases, forecast, Run ──

  function drawConfigs(wrap) {
    const configs = state.configs || (state.configs = freshConfigs());
    const modelChoices = models().map((m) => (m.off ? [m.ref, m.label, true] : [m.ref, m.label]));
    if (typeof F.routePick === 'function') modelChoices.push([ROUTER, 'Model Router’s pick']);
    const engineChoices = [['', 'Current engine'], ...state.engines.map((e) => [e.path, `Engine ${e.version}`])];
    const list = el('div', 'jcv-configs');
    configs.forEach((c, i) => {
      const row = el('div', 'jcv-config');
      row.append(el('span', 'jcx-num', `#${i + 1}`));
      row.append(select(modelChoices, c.model, (v) => { c.model = v; const m = models().find((x) => x.ref === v); c.label = m ? m.label : ''; state.forecast = null; render(); }, 'Model'));
      if (c.model !== ROUTER) row.append(select(EFFORTS, c.effort, (v) => { c.effort = v; state.forecast = null; }, 'Effort'));
      row.append(select([['full', 'Full prompt'], ['lean', 'Lean prompt']], c.prompt, (v) => { c.prompt = v; state.forecast = null; }, 'Prompt'));
      row.append(select([['on', 'Rules on'], ['off', 'Rules off']], c.rules, (v) => { c.rules = v; state.forecast = null; }, 'Rules and guardrails'));
      if (engineChoices.length > 1) {
        row.append(select(engineChoices, c.engine, (v) => { c.engine = v; const e = state.engines.find((x) => x.path === v); c.engine_version = e ? e.version : ''; state.forecast = null; }, 'Engine'));
      }
      if (configs.length > 1) row.append(button('Remove', 'jc-mini', () => { configs.splice(i, 1); state.forecast = null; render(); }));
      list.append(row);
    });
    wrap.append(list);
    if (configs.length < MAX_CONFIGS) wrap.append(button('Add a configuration', 'jc-mini jcv-add', () => { configs.push({ ...configs[configs.length - 1] }); state.forecast = null; render(); }));
  }

  function drawSuite(wrap, now) {
    const box = el('section', 'jcv-card');
    box.setAttribute('aria-label', 'Run a suite');
    box.append(el('h3', 'jcv-head', 'Run a suite'));
    const cases = (now && now.cases) || [];
    if (!cases.length) {
      box.append(el('p', 'jc-dim', 'No cases yet. Add one from your landed work or from a commit below.'));
      wrap.append(box);
      return;
    }
    drawConfigs(box);
    const chosen = picked(cases);
    const which = el('div', 'jcv-which');
    which.append(el('span', 'jc-dim', `${chosen.length} of ${cases.length} cases`));
    which.append(button('Last 20', 'jc-mini', () => { state.picked = null; state.forecast = null; render(); }));
    which.append(button('All', 'jc-mini', () => { state.picked = new Set(cases.map((c) => c.id)); state.forecast = null; render(); }));
    box.append(which);
    const problem = el('p', 'jc-dim jcv-problem');
    problem.setAttribute('role', 'status');
    const fc = state.forecast;
    if (fc) {
      const line = el('p', 'jcv-forecast');
      line.append(document.createTextNode(`${t('Forecast')}: ${money(fc.usd)}${fc.rough ? ` ${t('(rough)')}` : ''} · ${fc.attempts} ${t('attempts')} · ~${Math.max(1, fc.minutes)} min · ${t('ceiling')} ${money(fc.ceiling)}`));
      box.append(line);
      if (fc.over_ceiling) box.append(el('p', 'jcv-warn', 'The forecast is more than the ceiling: some attempts will be skipped.'));
    }
    const actions = el('div', 'jcv-actions');
    actions.append(button('Forecast', 'jc-btn small', () => {
      const [ok, msg] = suiteMessage('cev_forecast');
      if (!ok) { problem.textContent = t(msg); return; }
      send(msg);
    }, 'What it would cost and take, before anything runs'));
    const running = now && now.running && now.running.length;
    const go = button('Run…', 'jc-btn small filled', () => {
      const [ok, msg] = suiteMessage('cev_run');
      if (!ok) { problem.textContent = t(msg); return; }
      send(msg);
    }, 'Asks first, with the forecast and the run’s ceiling');
    go.disabled = !!running || !chosen.length;
    actions.append(go);
    box.append(problem, actions);
    box.append(el('p', 'jc-dim jcv-note', 'Each attempt is a real session on its model, in a throwaway copy of the repository at the case’s start; the landed tests are copied in afterwards and run. It costs what it costs, up to the run’s ceiling.'));
    wrap.append(box);
  }

  // ── results ──

  function drawResults(wrap, now) {
    const runs = (now && now.runs) || [];
    if (!runs.length) return;
    const id = state.shown && runs.some((r) => r.run === state.shown) ? state.shown : runs[0].run;
    const record = state.runs.get(id) || runs.find((r) => r.run === id);
    const box = el('section', 'jcv-card');
    box.setAttribute('aria-label', 'Results');
    const head = el('div', 'jcv-row');
    head.append(el('h3', 'jcv-head', 'Results'));
    if (runs.length > 1) {
      head.append(select(runs.map((r) => [r.run, new Date((r.started || 0) * 1000).toLocaleString()]), id, (v) => { state.shown = v; send({ type: 'cev_run_get', run: v }); render(); }, 'Run'));
    }
    if (record.status === 'running') head.append(button('Stop', 'jc-mini', () => send({ type: 'cev_stop', run: id }), 'No more attempts start; those running are stopped'));
    box.append(head);
    const status = { running: 'Running…', done: 'Done.', stopped: 'Stopped.' }[record.status] || '';
    box.append(el('p', `jc-dim${record.status === 'running' ? ' jc-sheen' : ''}`, `${t(status)} ${t('Spent')} ${money(record.spent_usd)} ${t('of')} ${money(record.ceiling_usd)}`));
    const table = el('table', 'jcv-table');
    const hrow = el('tr');
    for (const h of ['Configuration', 'Passed', 'Cost', 'Per pass', 'Time', 'Diff']) hrow.append(el('th', '', h));
    table.append(hrow);
    for (const r of compareRows(record)) {
      const tr = el('tr');
      tr.append(own(el('td', 'jcv-label', r.label)));
      tr.append(own(el('td', 'jcv-num', `${r.passed}/${r.total}`)));
      tr.append(own(el('td', 'jcv-num', money(r.cost_usd))));
      tr.append(own(el('td', 'jcv-num', r.cost_per_pass == null ? '—' : money(r.cost_per_pass))));
      tr.append(own(el('td', 'jcv-num', duration(r.seconds_median))));
      tr.append(own(el('td', 'jcv-num', r.diff_lines_median == null ? '—' : `${r.diff_lines_median} lines`)));
      table.append(tr);
    }
    box.append(table);
    const full = state.runs.get(id);
    if (full && full.results) drawGrid(box, full, now);
    wrap.append(box);
  }

  function drawGrid(box, record, now) {
    const titles = new Map(((now && now.cases) || []).map((c) => [c.id, c.title || c.prompt]));
    const more = el('details', 'jcv-grid');
    more.append(el('summary', '', 'Case by case'));
    const table = el('table', 'jcv-table');
    const hrow = el('tr');
    hrow.append(el('th', '', 'Case'));
    for (const c of record.configs) hrow.append(own(el('th', 'jcv-num', `#${c.id.slice(1)}`)));
    table.append(hrow);
    for (const caseId of record.cases || []) {
      const tr = el('tr');
      tr.append(own(el('td', 'jcv-label', titles.get(caseId) || caseId)));
      for (const c of record.configs) {
        const result = record.results.find((r) => r.case === caseId && r.config === c.id);
        const [sign, cls] = mark(result);
        const td = own(el('td', `jcv-num jcv-mark ${cls}`, sign));
        if (result) td.title = `${result.status} · ${money(result.cost_usd)} · ${duration(result.seconds)} · +${result.added || 0} −${result.removed || 0}${result.error ? ` · ${result.error}` : ''}`;
        tr.append(td);
      }
      table.append(tr);
    }
    more.append(table);
    box.append(more);
  }

  // ── cases and where they come from ──

  function drawCases(wrap, now) {
    const cases = (now && now.cases) || [];
    const box = el('section', 'jcv-card');
    box.setAttribute('aria-label', 'Cases');
    box.append(el('h3', 'jcv-head', `${t('Cases')} (${cases.length})`));
    const calibrating = new Set((now && now.calibrating) || []);
    const chosen = new Set(picked(cases).map((c) => c.id));
    const list = el('ul', 'jc-list jcv-cases');
    for (const c of cases) {
      const li = el('li', 'jcv-case');
      const tick = el('input');
      tick.type = 'checkbox';
      tick.checked = chosen.has(c.id);
      tick.setAttribute('aria-label', 'In the suite');
      tick.addEventListener('change', () => {
        const set = new Set(chosen);
        if (tick.checked) set.add(c.id); else set.delete(c.id);
        state.picked = set;
        state.forecast = null;
        render();
      });
      const main = el('div', 'jcv-case-main');
      main.append(own(el('strong', '', c.title || c.prompt)));
      const cmd = own(el('input', 'jc-field jcv-cmd'));
      cmd.value = c.command;
      cmd.setAttribute('aria-label', 'Check command');
      cmd.addEventListener('change', () => { if (cmd.value.trim()) send({ type: 'cev_edit', case: c.id, command: cmd.value }); });
      main.append(cmd);
      const note = calibrating.has(c.id) ? 'Checking the check…' : verdictWords(c.verdict);
      if (note) main.append(el('small', `jc-dim jcv-verdict ${c.verdict || ''}`, note));
      const cal = c.calibrated || {};
      const tail = c.verdict === 'fails_landed' ? cal.landed_tail : c.verdict === 'passes_at_start' ? cal.base_tail : '';
      if (tail && !calibrating.has(c.id)) {
        const why = el('details', 'jcv-why');
        why.append(el('summary', '', 'What the check said'), own(el('pre', 'jc-code', tail)));
        main.append(why);
      }
      const acts = el('div', 'jcv-case-acts');
      acts.append(button('Check again', 'jc-mini', () => send({ type: 'cev_calibrate', case: c.id }), 'Runs its check at the start (it should fail) and as landed (it should pass); costs nothing'));
      acts.append(button('Remove', 'jc-mini', () => send({ type: 'cev_remove', case: c.id })));
      li.append(tick, main, acts);
      list.append(li);
    }
    if (cases.length) box.append(list);
    drawCandidates(box, now);
    drawFromCommit(box);
    wrap.append(box);
  }

  function drawCandidates(box, now) {
    const found = (now && now.candidates) || [];
    const more = el('details', 'jcv-more');
    if (found.length) more.open = true;
    more.append(el('summary', '', `${t('From your landed work')} (${found.length})`));
    if (!found.length) more.append(el('p', 'jc-dim', 'Work landed from an isolated copy shows up here, to turn into a case.'));
    const list = el('ul', 'jc-list jcv-cases');
    for (const c of found) {
      const li = el('li', 'jcv-case');
      const main = el('div', 'jcv-case-main');
      main.append(own(el('strong', '', c.title || c.prompt)));
      const tests = c.test_files && c.test_files.length ? `${c.test_files.length} test file${c.test_files.length === 1 ? '' : 's'}` : 'no tests';
      main.append(own(el('small', 'jc-dim', `${c.base} → ${c.landed} · ${tests}${c.cost ? ` · ${money(c.cost)}` : ''}`)));
      const acts = el('div', 'jcv-case-acts');
      acts.append(button('Add', 'jc-mini', () => send({ type: 'cev_add', directory: project(), candidate: c.id }), 'Its check: the tests it added or changed, else your project’s test command'));
      acts.append(button('Dismiss', 'jc-mini', () => send({ type: 'cev_dismiss', candidate: c.id })));
      li.append(main, acts);
      list.append(li);
    }
    if (found.length) more.append(list);
    box.append(more);
  }

  function drawFromCommit(box) {
    const more = el('details', 'jcv-more');
    more.append(el('summary', '', 'Add from a commit'));
    const sha = own(el('input', 'jc-field'));
    sha.placeholder = 'Commit (a SHA, a tag, HEAD~2)';
    const prompt = own(el('textarea', 'jc-field jcv-prompt'));
    prompt.rows = 3;
    prompt.placeholder = 'What the task asked for';
    const cmd = own(el('input', 'jc-field'));
    cmd.placeholder = 'Check command (optional: the commit’s tests, else the project’s)';
    more.append(sha, prompt, cmd, button('Add the case', 'jc-btn small', () => {
      if (!sha.value.trim() || !prompt.value.trim()) return;
      send({ type: 'cev_add', directory: project(), commit: sha.value.trim(), prompt: prompt.value, command: cmd.value });
      sha.value = ''; prompt.value = ''; cmd.value = '';
    }));
    box.append(more);
  }

  function draw(target) {
    body = target;
    const wrap = el('div', 'jcv-evals');
    if (!project()) wrap.append(el('p', 'jc-empty', 'Pick a project first.'));
    else {
      const now = here();
      wrap.append(el('p', 'jc-dim', 'Your past tasks as evals: run them on different models and settings, and compare.'));
      drawSuite(wrap, now);
      drawResults(wrap, now);
      drawCases(wrap, now);
    }
    keepFocus(target, () => target.replaceChildren(wrap));
  }

  function render() { if (showing()) draw(body); }

  F.registerPane('evals', {
    title: 'Evals',
    render(target) {
      draw(target);
      if (project()) send({ type: 'cev_state', directory: project() });
      send({ type: 'cw_engines' });  // (the engine radar's engines, when it's there)
    },
  });
  if (F.registerMoreItem) F.registerMoreItem({ label: 'Evals…', run: () => F.openPane('evals') });

  // ── Eden Code settings: collecting, attempts at once, the ceiling ──

  const collect = el('button', 'jcs-switch');
  collect.type = 'button';
  collect.setAttribute('role', 'switch');
  collect.setAttribute('aria-label', 'Collect landed work for evals');
  collect.addEventListener('click', () => send({ type: 'feature_prefs', changes: { code_evals_collect: state.features.code_evals_collect === false } }));
  const parallel = select([1, 2, 3, 4].map((n) => [String(n), String(n)]), '2', (v) => send({ type: 'feature_prefs', changes: { code_evals_parallel: Number(v) } }), 'Eval attempts at once');
  const ceiling = el('input', 'jc-field jcv-ceiling');
  ceiling.type = 'number';
  ceiling.min = '0.05';
  ceiling.max = '1000';
  ceiling.step = '1';
  ceiling.setAttribute('aria-label', 'Eval run ceiling (US dollars)');
  ceiling.addEventListener('change', () => { const usd = Number(ceiling.value); if (Number.isFinite(usd) && usd > 0) send({ type: 'feature_prefs', changes: { code_evals_ceiling: usd } }); });
  (function addSettings() {
    const general = document.getElementById('jcs-general');
    if (!general) return;
    const label = el('p', 'jcs-label', 'Evals');
    const group = el('div', 'jcs-group');
    const rows = [
      [collect, 'Collect landed work for evals', 'Each landed isolated copy is kept as a possible eval case: its start, its prompt, its tests. Nothing runs until you run a suite.'],
      [parallel, 'Eval attempts at once', 'Each is a real session in its own throwaway copy.'],
      [ceiling, 'Most an eval run may spend (US dollars)', 'A run stops starting attempts once it has spent this; your spending limits still hold.'],
    ];
    for (const [control, name, about] of rows) {
      const row = el('div', 'jcs-row');
      const text = el('span');
      text.append(document.createTextNode(t(name)), el('small', '', about));
      row.append(text, control);
      group.append(row);
    }
    const foot = general.querySelector('.jcs-foot');
    general.insertBefore(label, foot);
    general.insertBefore(group, foot);
  })();

  function drawSettings() {
    const f = state.features;
    collect.setAttribute('aria-checked', String(f.code_evals_collect !== false));
    parallel.value = String(f.code_evals_parallel || 2);
    if (document.activeElement !== ceiling) ceiling.value = String(f.code_evals_ceiling || 10);
  }
  const runnable = (p) => (p.picker || p.models || []).map((m) => ({ ref: m.ref, label: m.needs_key ? `${m.label} (needs a key)` : m.label, off: !!m.needs_key }));
  F.on('providers', (ev) => { state.models = runnable(ev); }, { replay: true });
  F.on('hello', (ev) => { if (ev.prefs && ev.prefs.features) state.features = ev.prefs.features; if (ev.providers) state.models = runnable(ev.providers); drawSettings(); }, { replay: true });
  F.on('prefs', (ev) => { if (ev.features) state.features = ev.features; drawSettings(); }, { replay: true });
  F.on('code_evals', (ev) => {
    state.byProject.set(ev.project, ev);
    const latest = (ev.runs || [])[0];
    if (latest && !state.runs.has(latest.run)) send({ type: 'cev_run_get', run: latest.run });
    render();
  });
  F.on('code_evals_run', (ev) => { state.runs.set(ev.run, ev); if (ev.status === 'running') state.shown = ev.run; render(); });
  F.on('code_evals_forecast', (ev) => { if (ev.project === project()) { state.forecast = ev; render(); } });
  F.on('cw_engines', (ev) => {
    state.engines = (ev.candidates || []).filter((c) => c && c.path && c.version && c.usable !== false && !c.current).map((c) => ({ path: c.path, version: c.version }));
    render();
  });
  drawSettings();
})(typeof window === 'object' ? window : globalThis);
