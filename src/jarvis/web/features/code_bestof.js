// Eden Code's best of N (features/code_bestof.py): one request, two or three models or
// efforts at once, each in its own isolated copy; then side by side (what each changed, the
// project's tests when a command is given, a short judgment) and "Keep this one", or "Merge
// best parts": the judge's merged patch, hunk by hunk (which attempt each came from and
// why), in a copy of its own, tested there and reviewed in its session's Changes pane.
// A variant can be another agent over ACP (Other agents) or the Model Router's pick.
// Pure helpers are exported for node --test (tests/web/code-bestof.test.mjs).
(function (root) {
  'use strict';

  const ROUTER = 'router';  // the model menu's "Model Router's pick": resolved when Start is pressed

  // The model menu: the models in Settings › Models, the agents added in Other agents (acp:…),
  // and the router's pick when the Model Router is there.
  function modelOptions(models, agents, routerThere) {
    const out = models.map((m) => [m.ref, m.label]);
    for (const a of agents || []) out.push([`acp:${a.id}`, `${a.name} (agent)`]);
    if (routerThere) out.push([ROUTER, 'Model Router’s pick']);
    return out;
  }

  // What Start sends for the variants, or why not: [ok, variants | reason]. pick(prompt) is
  // the Model Router's {ref, effort?} for the request (null while it isn't ready).
  function variantsToSend(variants, prompt, pick) {
    const out = [];
    for (const v of variants) {
      if (v.model === ROUTER) {
        const route = typeof pick === 'function' ? pick(prompt) : null;
        if (!route || !route.ref) return [false, 'Model Router isn’t ready yet. Try again in a moment, or pick a model.'];
        out.push({ model: route.ref, effort: route.effort || '', routed: true });
      } else if (String(v.model || '').startsWith('acp:')) {
        out.push({ model: v.model });  // (another agent takes no effort)
      } else {
        out.push({ model: v.model, effort: v.effort || '' });
      }
    }
    return [true, out];
  }

  // A merged hunk as the merge's list reads it: where, from which attempt, and why.
  // A merged hunk's line, in parts: the file, the function it's in, the model and the
  // judge's reason are never translated (own); "line 12", "in" and "from" are Eden's
  // (web/i18n/code_bestof.json).
  function hunkParts(h) {
    const parts = [{ text: h.file, own: true }, { text: ` line ${h.line}` }];
    if (h.where) parts.push({ text: ' in ' }, { text: h.where, own: true });
    parts.push({ text: ': from ' }, { text: h.label, own: true }, { text: ` (+${h.added} −${h.removed})`, own: true });
    if (h.why) parts.push({ text: '. ', own: true }, { text: h.why, own: true });
    return parts;
  }
  function hunkLine(h) { return hunkParts(h).map((p) => p.text).join(''); }

  const api = { modelOptions, variantsToSend, hunkLine, hunkParts, ROUTER };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, send } = F;
  // Drawn anew with the keyboard kept in its place (code-focus.js): after Stop, Merge and
  // the like the focus would otherwise fall to the page.
  const keepFocus = (box, drawIt) => (root.jarvisFocus ? root.jarvisFocus.keep(box, drawIt) : drawIt());
  const EFFORTS = [['', 'Default effort'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']];
  const MODES = [['edits', 'Accept edits'], ['ask', 'Manual'], ['smart', 'Auto'], ['plan', 'Plan'], ['auto', 'Bypass permissions']];
  const BUILTIN = [['opus', 'Opus 5.5'], ['sonnet', 'Sonnet 5.5'], ['haiku', 'Haiku 4.5'], ['fable', 'Fable 5.1']];
  const state = {
    models: [], // [{ ref, label }] from the providers event
    agents: [], // [{ id, name }] from acp_state (Other agents, when that Labs module is on)
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
        select(modelOptions(models(), state.agents, typeof F.routePick === 'function'), v.model, (value) => { v.model = value; render(); }, 'Model'));
      if (!String(v.model || '').startsWith('acp:') && v.model !== ROUTER) row.append(select(EFFORTS, v.effort, (value) => { v.effort = value; }, 'Effort'));
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
    const problem = el('p', 'jc-dim jcx-bproblem');
    problem.setAttribute('role', 'status');
    const start = button('Start', 'jc-btn filled jcx-bstart', () => {
      const [ok, variants] = variantsToSend(form.variants, form.prompt, F.routePick);
      if (!ok) { problem.textContent = F.t(variants); return; }
      send({ type: 'code_bestof', directory: project(), prompt: form.prompt, variants, mode: form.mode, tests: form.tests });
      state.showForm = false;
      state.form = null;
      render();
    });
    start.disabled = !form.prompt.trim();
    request.addEventListener('input', () => { start.disabled = !request.value.trim(); });
    wrap.append(problem, start);
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
    const status = { running: 'Working…', comparing: 'Comparing…', done: 'Done: pick the one to keep, or merge the best parts.', kept: 'Kept.' }[group.status] || group.status;
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
    drawMerge(wrap, group);
  }

  // Merge best parts: the button once they're all done, then the merge as it goes.
  function drawMerge(wrap, group) {
    const merge = group.merge;
    const box = el('section', 'jcx-bmerge');
    box.setAttribute('aria-label', 'Merge best parts');
    const head = el('div', 'jcx-bhead');
    head.append(el('strong', '', 'Merge best parts'));
    const canAsk = group.status === 'done' && !(merge && merge.status === 'merging');
    if (canAsk) head.append(button(merge ? 'Merge again' : 'Merge best parts', 'jc-btn small', () => send({ type: 'code_bestof_merge', group: group.group }), 'The judge (Haiku) proposes one patch from the best hunks of each; it’s applied and tested in a copy of its own'));
    box.append(head);
    if (!merge) {
      if (group.status === 'done') box.append(el('p', 'jc-dim', 'Or take the best hunks of each: the judge proposes a merged patch, applied and tested in a copy of its own, for you to review hunk by hunk.'));
      if (group.status !== 'kept') wrap.append(box);
      return;
    }
    const live = el('p', `jc-dim${merge.status === 'merging' ? ' jc-sheen' : ''}`, { merging: 'Merging…', ready: 'Merged: review it, then keep it or pick one above.', failed: 'Couldn’t merge.' }[merge.status] || merge.status);
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    box.append(live);
    if (merge.error) { const e = el('p', 'jcx-berror', merge.error); e.dataset.noI18n = ''; box.append(e); }
    if (merge.summary) { const s = el('p', 'jcx-bsummary', merge.summary); s.dataset.noI18n = ''; box.append(s); }
    if (merge.hunks && merge.hunks.length) {
      const list = el('ul', 'jcx-bhunks');
      list.setAttribute('aria-label', 'Merged changes');
      for (const h of merge.hunks) {
        const item = el('li', `jcx-bhunk from${h.from}`);
        for (const part of hunkParts(h)) {
          const bit = el('span', '', part.text);
          if (part.own) bit.dataset.noI18n = '';
          item.append(bit);
        }
        list.append(item);
      }
      box.append(list);
    }
    const notes = [];
    for (const c of merge.clashes || []) notes.push(`${c.left_out} left out: it changes the same lines as ${c.kept}.`);
    for (const h of merge.failed || []) notes.push(`${hunkLine(h)}: didn’t apply.`);
    for (const f of merge.left_out || []) notes.push(`${f}: not merged a hunk at a time.`);
    if (notes.length) {
      const more = el('details', 'jcx-bnotes');
      more.append(el('summary', '', `Left out (${notes.length})`));
      for (const n of notes) { const p = el('p', 'jc-dim', n); p.dataset.noI18n = ''; more.append(p); }
      box.append(more);
    }
    if (merge.test) {
      const passed = merge.test.code === 0;
      const test = el('details', 'jcx-btest');
      const sum = el('summary');
      sum.append(el('span', `jcx-chip ${passed ? 'ok' : 'bad'}`, passed ? 'tests passed' : `tests failed (${merge.test.code})`));
      const out = el('pre', 'jc-code', merge.test.tail || '');
      out.dataset.noI18n = '';
      test.append(sum, out);
      box.append(test);
    }
    if (merge.status === 'ready') {
      const actions = el('div', 'jcx-bactions');
      const open = () => { if (typeof selectTask === 'function' && merge.task_id) selectTask(merge.task_id); };
      actions.append(button('Review in Changes', 'jc-btn small', () => { open(); F.openPane('diff'); }, 'Each merged hunk, to undo or keep, in the merge’s own session'));
      if (group.status === 'done') actions.append(button('Keep the merge', 'jc-btn small filled', () => send({ type: 'code_bestof_keep', group: group.group, n: 0 }), 'Land the merge and discard every attempt (asks first)'));
      box.append(actions);
    }
    if (group.status === 'kept' && group.kept === 0) box.classList.add('kept');
    wrap.append(box);
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
    keepFocus(target, () => target.replaceChildren(wrap));
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
  F.on('acp_state', (ev) => { state.agents = (ev.agents || []).map((a) => ({ id: a.id, name: a.name })); render(); });
  // (no answer while Other agents is off: then there are none to offer)
  F.on('hello', () => send({ type: 'acp_state' }), { replay: true });
})(typeof window === 'object' ? window : globalThis);
