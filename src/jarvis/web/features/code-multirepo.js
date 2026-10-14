// Multi-repo tasks (features/code_multirepo.py): the "Multi-repo tasks" pane starts one task
// across several projects (one session, an isolated copy of each in its folder) and lists
// the tasks: each repository's branch and changes, Open, Land all (all or nothing), linked
// pull requests (opened together, merged together when all are green), Discard all.
// helpers is exported for node --test (tests/web/code-multirepo.test.mjs).
(function (root) {
  'use strict';

  const helpers = {
    // Why the task can't start yet ('' when it can).
    startProblem(picked, prompt, most) {
      const n = (picked || []).length;
      if (n < 2) return 'Pick at least two projects.';
      if (n > (most || 8)) return `Pick at most ${most || 8} projects.`;
      if (!String(prompt || '').trim()) return 'Say what the task should do.';
      return '';
    },
    // One repository's line, in parts: its branch (the owner's words, never translated),
    // then what changed in it (Eden's, translated: web/i18n/code-multirepo.json).
    repoParts(r) {
      const s = r.state || {};
      const parts = [{ text: `${r.branch} → ${r.into}`, own: true }];
      if (s.files) parts.push({ text: `${s.files} file${s.files === 1 ? '' : 's'} +${s.added || 0} −${s.removed || 0}` });
      else parts.push({ text: 'no changes yet' });
      if (r.conflicts && r.conflicts.length) parts.push({ text: `conflicts in ${r.conflicts.slice(0, 3).join(', ')}` });
      return parts;
    },
    repoLine(r) { return helpers.repoParts(r).map((p) => p.text).join(' · '); },
  };

  if (typeof module === 'object' && module.exports) { module.exports = helpers; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el, send, t } = F;
  // starting: a code_multi_start is out (the form waits, its picks and request kept, until
  // code_multi_started says it took); why: the last refusal, said under the form.
  const state = { groups: [], most: 8, body: null, picked: new Set(), prompt: '', prFor: '', starting: false, why: '' };
  /* global deckProjects */
  const projectNames = () => (typeof deckProjects !== 'undefined' && Array.isArray(deckProjects) ? deckProjects.map((p) => p.name) : []);

  function button(label, cls, run) {
    const b = el('button', `jc-btn small ${cls || ''}`.trim(), label);
    b.type = 'button';
    b.addEventListener('click', run);
    return b;
  }

  function startForm() {
    const form = el('form', 'jcx-multi-start');
    const legend = el('fieldset', 'jcx-multi-pick');
    legend.append(el('legend', '', 'Projects'));
    for (const name of projectNames()) {
      const label = el('label', 'jcx-multi-project');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = state.picked.has(name);
      box.addEventListener('change', () => { if (box.checked) state.picked.add(name); else state.picked.delete(name); });
      const text = el('span', '', name);
      text.dataset.noI18n = '';
      label.append(box, text);
      legend.append(label);
    }
    const promptLabel = el('label', 'jcx-multi-label', 'What should it do?');
    const prompt = el('textarea', 'jcs-input jcx-multi-prompt');
    prompt.id = 'jcx-multi-prompt';
    promptLabel.htmlFor = prompt.id;
    prompt.rows = 3;
    prompt.value = state.prompt;
    prompt.addEventListener('input', () => { state.prompt = prompt.value; });
    const why = el('p', 'jcx-multi-why');
    why.setAttribute('role', 'status');
    why.textContent = state.starting ? t('Starting it: making a copy of each project…') : state.why;
    const go = el('button', 'jc-btn small filled', state.starting ? 'Starting…' : 'Start the task');
    go.type = 'submit';
    go.disabled = state.starting;
    form.setAttribute('aria-busy', String(state.starting));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (state.starting) return;
      const picked = [...state.picked];
      const problem = helpers.startProblem(picked, prompt.value, state.most);
      if (problem) { why.textContent = t(problem); return; }
      // The picks and the request stay until the backend says the task started (a refusal,
      // two copies of one project or too many copies, would otherwise lose them).
      if (send({ type: 'code_multi_start', projects: picked, prompt: prompt.value.trim() }) === false) return;
      state.starting = true;
      state.why = '';
      go.disabled = true;
      go.textContent = t('Starting…');
      form.setAttribute('aria-busy', 'true');
      why.textContent = t('Starting it: making a copy of each project…');
    });
    form.append(legend, promptLabel, prompt, why, go);
    return form;
  }

  function prForm(g) {
    const form = el('form', 'jcx-multi-prs');
    const titleLabel = el('label', 'jcx-multi-label', 'Title');
    const title = el('input', 'jcs-input');
    title.id = `jcx-multi-pr-title-${g.slug}`;
    titleLabel.htmlFor = title.id;
    title.value = g.title;
    const bodyLabel = el('label', 'jcx-multi-label', 'Description');
    const body = el('textarea', 'jcs-input');
    body.id = `jcx-multi-pr-body-${g.slug}`;
    bodyLabel.htmlFor = body.id;
    body.rows = 3;
    const draftLabel = el('label', 'jcx-multi-project');
    const draft = el('input');
    draft.type = 'checkbox';
    draftLabel.append(draft, el('span', '', 'Draft'));
    const open = el('button', 'jc-btn small filled', 'Open them');
    open.type = 'submit';
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      send({ type: 'code_multi_prs', group: g.slug, title: title.value.trim(), body: body.value, draft: draft.checked });
      state.prFor = '';
    });
    form.append(titleLabel, title, bodyLabel, body, draftLabel, open, button('Cancel', '', () => { state.prFor = ''; render(); }));
    return form;
  }

  function groupCard(g) {
    const card = el('li', 'jcx-copy jcx-multi');
    const head = el('div', 'jcx-copy-head');
    const name = el('strong', '', g.title || g.slug);
    name.dataset.noI18n = '';
    head.append(name);
    if (g.busy) head.append(el('span', 'jcx-chip busy', 'working'));
    card.append(head);
    const list = el('ul', 'jcx-multi-repos');
    for (const r of g.repos) {
      const li = el('li');
      const proj = el('strong', '', r.project);
      proj.dataset.noI18n = '';
      const line = el('span');
      helpers.repoParts(r).forEach((part, k) => {
        if (k) line.append(document.createTextNode(' · '));
        const bit = el('span', '', part.text);
        if (part.own) bit.dataset.noI18n = '';
        line.append(bit);
      });
      li.append(proj, line);
      list.append(li);
    }
    card.append(list);
    if (g.prs && g.prs.length) {
      const prs = el('p', 'jcx-multi-links');
      prs.append(el('span', '', 'Pull requests: '));
      g.prs.forEach((p, k) => {
        if (k) prs.append(document.createTextNode(', '));
        const a = el('a', '', `${p.repo}#${p.number}`);
        a.href = p.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.dataset.noI18n = '';
        prs.append(a);
      });
      card.append(prs);
    }
    const actions = el('div', 'jcx-copy-actions');
    actions.append(button('Open', '', () => send({ type: 'code_multi_open', group: g.slug })));
    actions.append(button('Land all', 'filled', () => send({ type: 'code_multi_land', group: g.slug })));
    if (g.prs && g.prs.length) actions.append(button('Merge all', 'tinted', () => send({ type: 'code_multi_merge', group: g.slug })));
    else actions.append(button('Open linked pull requests', 'tinted', () => { state.prFor = g.slug; render(); }));
    actions.append(button('Discard all', 'danger', () => send({ type: 'code_multi_discard', group: g.slug })));
    card.append(actions);
    if (state.prFor === g.slug) card.append(prForm(g));
    return card;
  }

  // Whether the Multi-repo pane is the one showing (the pane's body is every pane's: being on
  // the page isn't enough, or a code_multis answer would draw over whatever pane is open).
  /* global currentPane */
  const paneShown = () => state.body && state.body.isConnected && typeof currentPane !== 'undefined' && currentPane === 'multirepo';

  function render() {
    const body = state.body;
    if (!paneShown()) return;
    // (Not .jcx-copies: that's how the Copies pane, code_isolation.js, knows its own body,
    // and it would draw itself over this one.)
    const wrap = el('div', 'jcx-multis');
    wrap.append(el('p', 'jc-dim', 'One task across several repositories: one session works in a folder with an isolated copy of each. Landing lands all of them or none; pull requests are opened together, each linking the others, and merged together once all are green.'));
    wrap.append(el('p', 'jcs-label', 'New multi-repo task'));
    wrap.append(startForm());
    wrap.append(el('p', 'jcs-label', 'Tasks'));
    if (!state.groups.length) wrap.append(el('p', 'jc-empty', 'No multi-repo tasks.'));
    else {
      const list = el('ul', 'jcx-copy-list');
      list.append(...state.groups.map(groupCard));
      wrap.append(list);
    }
    body.replaceChildren(wrap);
  }

  F.registerPane('multirepo', {
    title: 'Multi-repo tasks',
    render(body) { state.body = body; render(); send({ type: 'code_multis' }); },
  });
  F.registerMoreItem({ label: 'Multi-repo tasks', run: () => F.openPane('multirepo') });
  F.on('code_multis', (ev) => { state.groups = ev.groups || []; state.most = ev.most || 8; render(); });
  F.on('code_multi_started', (ev) => {
    state.starting = false;
    if (ev.ok) { state.picked.clear(); state.prompt = ''; state.why = ''; } else state.why = String(ev.text || '');
    render();
  });
  // (A backend that restarted mid-start never answers: the form is usable again.)
  F.on('hello', () => { if (state.starting) { state.starting = false; render(); } });
})(typeof window !== 'undefined' ? window : globalThis);
