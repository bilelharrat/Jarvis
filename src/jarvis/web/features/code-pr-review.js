// Eden Code's automated review of anyone's pull request (features/code_pr_review.py): in
// Eden Code settings › GitHub, the repositories whose pull requests are reviewed (opting one
// in sends the scope to the backend, which puts it on a card first); and the Pull request
// reviews pane (the More menu), each review with its findings, "Fix it" on each one and
// "Fix all", and a field to review one pull request now (a draft too).
//
// Repository names, titles and findings are someone else's words: text only (textContent),
// marked data-no-i18n. Pure helpers are exported for node --test
// (tests/web/code-pr-review.test.mjs).
(function (root) {
  'use strict';

  const STATUS = {
    done: 'Findings posted on GitHub',
    clean: 'Nothing found',
    failed: 'The review didn’t finish',
  };

  // What a review's row says about it.
  function statusLine(review) {
    if (!review) return '';
    if (review.status === 'done') {
      const n = (review.findings || []).length;
      return n === 1 ? '1 finding posted on GitHub' : `${n} findings posted on GitHub`;
    }
    return STATUS[review.status] || '';
  }

  // Where a finding points: file:line, or the file alone.
  function findingWhere(f) {
    if (!f || !f.file) return '';
    return f.line ? `${f.file}:${f.line}` : f.file;
  }

  // "acme/app#12" or "12" (with the repository picked) as {repo, number}; null otherwise.
  function parsePull(text, repo) {
    const raw = String(text || '').trim();
    let m = /^([\w.-]+\/[\w.-]+)#(\d{1,7})$/.exec(raw);
    if (m) return { repo: m[1], number: Number(m[2]) };
    m = /^#?(\d{1,7})$/.exec(raw);
    if (m && repo) return { repo, number: Number(m[1]) };
    m = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d{1,7})/.exec(raw);
    if (m) return { repo: m[1], number: Number(m[2]) };
    return null;
  }

  const api = { statusLine, findingWhere, parsePull, STATUS };
  if (typeof module === 'object' && module.exports) module.exports = api;

  const F = root.jarvisFeatures;
  if (!F || typeof document === 'undefined') return;
  const { el, send, t } = F;
  // Drawn anew with the keyboard kept in its place (code-focus.js): after Stop, Merge and
  // the like the focus would otherwise fall to the page.
  const keepFocus = (box, drawIt) => (root.jarvisFocus ? root.jarvisFocus.keep(box, drawIt) : drawIt());
  const state = {
    repos: [],
    reviews: [],
    connected: true,
    form: { project: '', drafts: false, commands: '', spend: '5', sandbox: true },
    detected: {}, // project -> { repo, note }
    ask: '',
  };
  const projects = () => (typeof deckProjects !== 'undefined' ? deckProjects.map((p) => p.name) : []);
  let group = null;
  let paneBody = null;

  function mine(text, tag = 'span', cls = '') {
    const node = el(tag, cls, text);
    node.dataset.noI18n = '';
    return node;
  }

  function button(label, cls, run, aria) {
    const b = el('button', `jc-btn small ${cls || ''}`.trim(), label);
    b.type = 'button';
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); run(b); });
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

  // ── settings ──

  function addForm() {
    const f = state.form;
    const names = projects();
    if (!f.project && names.length) f.project = names[0];
    const box = el('form', 'jcx-prr-form');
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
    const where = el('p', 'jc-dim jcx-prr-where');
    if (found && found.repo) where.append(mine(found.repo, 'code'));
    else if (found && found.note) where.append(el('span', '', found.note));
    const commands = el('input', 'jcs-input');
    commands.placeholder = t('npm test, uv run pytest');
    commands.value = f.commands;
    commands.setAttribute('aria-label', 'Commands a fix may run');
    commands.dataset.noI18n = '';
    commands.addEventListener('input', () => { f.commands = commands.value; });
    const spend = el('input', 'jcs-input jcx-prr-num');
    spend.type = 'number';
    spend.min = '0.5';
    spend.max = '50';
    spend.step = '0.5';
    spend.value = f.spend;
    spend.setAttribute('aria-label', 'Spending cap for a fix ($)');
    spend.addEventListener('input', () => { f.spend = spend.value; });
    const add = el('button', 'jc-btn small filled', 'Turn reviews on…');
    add.type = 'submit';
    add.disabled = !(found && found.repo);
    box.append(
      row('Project', '', pick),
      where,
      row('Review drafts too', 'Off: a draft is reviewed only when you ask.', sw('Review drafts too', f.drafts, (on) => { f.drafts = on; draw(); })),
      row('Commands a fix may run', 'Beyond the read-only ones and the project’s own rules.', commands),
      row('Spending cap for a fix ($)', 'For each fix; it also stops after an hour.', spend),
      row('Fixes without network access', 'A fix’s commands run in a sandbox. Turn it off if its tests need the network.', sw('Fixes without network access', f.sandbox, (on) => { f.sandbox = on; draw(); })),
    );
    const actions = el('div', 'jcx-prr-actions');
    actions.append(el('span', 'jc-spacer'), add);
    box.append(actions);
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      send({
        type: 'code_prr_add',
        project: f.project,
        drafts: !!f.drafts,
        commands: f.commands.split(',').map((c) => c.trim()).filter(Boolean),
        spend_cap: Number(f.spend) || 5,
        sandbox: !!f.sandbox,
      });
    });
    return box;
  }

  function draw() {
    if (!group) return;
    const parts = [row('Review pull requests', 'Claude (Haiku) reads each new pull request in these repositories once at each new commit and posts what it finds there as a review comment. 20 a day at most.')];
    if (!state.connected) parts.push(el('p', 'jcx-prr-connect', 'Connect GitHub in Tools & Accounts first.'));
    if (state.repos.length) {
      const list = el('ul', 'jcx-prr-list');
      list.append(...state.repos.map((r) => {
        const li = el('li');
        const text = el('span', 'jcx-prr-repo');
        text.append(mine(r.repo, 'code'), mine(` · ${r.project}`));
        if (r.drafts) text.append(el('small', '', 'drafts too'));
        li.append(text, button('Remove', 'danger', () => send({ type: 'code_prr_remove', repo: r.repo }), `${t('Remove')} ${r.repo}`));
        return li;
      }));
      parts.push(list);
    }
    parts.push(addForm());
    keepFocus(group, () => group.replaceChildren(...parts));
  }

  (function addSettings() {
    const general = document.getElementById('jcs-general');
    if (!general) return;
    const label = el('p', 'jcs-label', 'GitHub: reviewing pull requests');
    group = el('div', 'jcs-group jcx-prr');
    const foot = general.querySelector('.jcs-foot');
    general.insertBefore(label, foot);
    general.insertBefore(group, foot);
    draw();
  })();

  // ── the pane ──

  function findingRow(review, f) {
    const li = el('li', `jcx-prr-finding sev-${f.severity}`);
    const head = el('div', 'jcx-fhead');
    head.append(el('span', `jcx-sev ${f.severity}`, f.severity), mine(f.title, 'strong'));
    li.append(head, mine(findingWhere(f), 'code'));
    if (f.detail) li.append(mine(f.detail, 'p', 'jcx-fdetail'));
    if (f.fix) li.append(mine(f.fix, 'p', 'jcx-ffix'));
    const fixIt = button('Fix it', '', () => send({ type: 'code_prr_fix', key: review.key, finding: f.id }), `${t('Fix it')}: ${f.title}`);
    li.append(fixIt);
    return li;
  }

  function reviewCard(review) {
    const card = el('section', `jcx-prr-card ${review.status}`);
    card.setAttribute('aria-label', `${review.repo}#${review.number}`);
    const head = el('div', 'jcx-prr-head');
    const a = el('a', 'jcx-prr-link');
    a.href = review.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.append(mine(`${review.repo}#${review.number}`, 'code'), mine(` ${review.title || ''}`));
    head.append(a);
    if (review.draft) head.append(el('span', 'jcx-chip', 'Draft'));
    card.append(head, el('p', 'jc-dim jcx-prr-status', statusLine(review)));
    if (review.note) card.append(mine(review.note, 'p', 'jc-dim'));
    const findings = review.findings || [];
    if (findings.length) {
      const list = el('ul', 'jcx-prr-findings');
      list.append(...findings.map((f) => findingRow(review, f)));
      card.append(list);
      if (findings.length > 1) {
        const bar = el('div', 'jcx-prr-actions');
        bar.append(el('span', 'jc-spacer'), button('Fix all', 'filled', () => send({ type: 'code_prr_fix', key: review.key, all: true })));
        card.append(bar);
      }
    }
    return card;
  }

  function renderPane(target) {
    paneBody = target;
    const wrap = el('div', 'jcx-prr-pane');
    const ask = el('form', 'jcx-prr-ask');
    const field = el('input', 'jcs-input');
    field.placeholder = 'acme/app#12';
    field.value = state.ask;
    field.setAttribute('aria-label', 'Pull request to review now');
    field.dataset.noI18n = '';
    field.addEventListener('input', () => { state.ask = field.value; });
    const go = el('button', 'jc-btn small', 'Review now');
    go.type = 'submit';
    ask.append(field, go);
    ask.addEventListener('submit', (e) => {
      e.preventDefault();
      const found = parsePull(state.ask, state.repos.length === 1 ? state.repos[0].repo : '');
      if (found) send({ type: 'code_prr_review', repo: found.repo, number: found.number });
    });
    wrap.append(ask);
    if (!state.repos.length) wrap.append(el('p', 'jc-empty', 'No repository is reviewed yet: turn it on in Eden Code settings › GitHub.'));
    if (!state.reviews.length) wrap.append(el('p', 'jc-empty', 'No reviews yet.'));
    else wrap.append(...state.reviews.map(reviewCard));
    keepFocus(target, () => target.replaceChildren(wrap));
  }

  const shown = () => paneBody && paneBody.isConnected && paneBody.querySelector('.jcx-prr-pane');

  F.registerPane('pr-reviews', { title: 'Pull request reviews', render(target) { renderPane(target); send({ type: 'code_prr' }); } });
  F.registerMoreItem({ label: 'Pull request reviews', run: () => F.openPane('pr-reviews') });

  F.on('hello', () => send({ type: 'code_prr' }), { replay: true });
  F.on('code_prr', (ev) => {
    state.repos = ev.repos || [];
    state.reviews = ev.reviews || [];
    state.connected = ev.connected !== false;
    draw();
    if (shown()) renderPane(paneBody);
  });
  F.on('code_issue_repo', (ev) => { state.detected[ev.project] = { repo: ev.repo, note: ev.note }; draw(); });
  F.on('claude_projects', () => {
    const f = state.form;
    if (!f.project && projects().length) { f.project = projects()[0]; send({ type: 'code_issue_detect', project: f.project }); }
    draw();
  });
  root.JarvisPullReviews = { state };
})(typeof window === 'object' ? window : globalThis);
