// Eden Code's Rollouts (features/code_rollouts.py): the watch after one of Eden's pull requests
// merges. In Eden Code settings › Watching after a merge: the switch, the watch window, and
// each project's own window, health-check addresses and the page to load in the built-in
// browser before and after the deploy. The Rollouts pane (the More menu, and Needs
// attention's Open): each watch as a card, a regression's first, with its evidence (the
// deploy, the merge commit's checks, the errors since the merge and where their traces meet
// the change, the health checks, the page's new errors) and its offers: Open a fix session
// (failing test first, as Exterminator Mode) or Prepare a revert PR, each a session the
// owner drives; nothing here pushes, merges, reverts or deploys. Then Dismiss, Look now and
// Stop; and the merged pull requests not watched, with Watch it.
//
// Titles, errors, addresses and file names are someone else's words: text only
// (textContent), marked data-no-i18n. Pure helpers are exported for node --test
// (tests/web/code-rollouts.test.mjs).
(function (root) {
  'use strict';

  const STATES = { watching: 'Watching', healthy: 'Looked healthy', regressed: 'Looks broken', stopped: 'Stopped' };
  const DEPLOYS = {
    none: 'No deployment seen',
    success: 'Deployed',
    failure: 'The deployment failed',
    error: 'The deployment failed',
    in_progress: 'Deploying',
    queued: 'Waiting to deploy',
    pending: 'Waiting to deploy',
    inactive: 'Replaced by a later deployment',
  };
  const ACTED = { fix: 'A fix session is open', revert: 'A revert is being prepared', dismissed: 'Put away' };
  const LEVELS = { line: 'a changed line', function: 'a changed function', file: 'a changed file' };

  // What a watch's chip says: a regression the owner hasn't acted on says so, whatever its
  // window.
  function stateLabel(w) {
    if (!w) return '';
    if ((w.reasons || []).length && !w.acted && (w.state === 'watching' || w.state === 'regressed')) return 'Looks broken';
    return STATES[w.state] || w.state || '';
  }

  // The chip's look: bad, good or plain.
  function stateTone(w) {
    const label = stateLabel(w);
    return label === 'Looks broken' ? 'bad' : label === 'Looked healthy' ? 'good' : '';
  }

  function deployLine(deploy) {
    const d = deploy || {};
    const said = DEPLOYS[d.state] || d.state || DEPLOYS.none;
    return d.environment && d.state !== 'none' ? `${said} (${d.environment})` : said;
  }

  // "14 events in 2 issues since the merge, about 7 an hour"; '' with none.
  function rateLine(rate) {
    const r = rate || {};
    if (!r.issues) return '';
    const issues = r.issues === 1 ? '1 issue' : `${r.issues} issues`;
    const events = r.events === 1 ? '1 event' : `${r.events} events`;
    return `${events} in ${issues} since the merge, about ${r.per_hour} an hour`;
  }

  // How long the window has left, in minutes ("18 min left"), or '' once it's over.
  function timeLeft(w, now = Date.now() / 1000) {
    if (!w || w.state !== 'watching') return '';
    const left = Math.max(0, Math.round((Number(w.ends) - now) / 60));
    return left ? `${left} min left` : 'Ending now';
  }

  function hitWhere(hit) {
    if (!hit || !hit.file) return '';
    let where = hit.line ? `${hit.file}:${hit.line}` : hit.file;
    if (hit.function) where += ` (${hit.function})`;
    return where;
  }

  // The addresses typed in a field (commas, spaces or new lines between them).
  function listOf(text) {
    return String(text || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean).slice(0, 5);
  }

  // Whether a watch's offers are shown: a regression not acted on yet.
  function offers(w) {
    return !!w && (w.reasons || []).length > 0 && !w.acted && (w.state === 'watching' || w.state === 'regressed');
  }

  // A regression first, then the ones still watching, then the newest.
  function ordered(watches) {
    const rank = (w) => (offers(w) ? 0 : w.state === 'watching' ? 1 : 2);
    return [...(watches || [])].sort((a, b) => rank(a) - rank(b) || Number(b.merged_at) - Number(a.merged_at));
  }

  const api = { STATES, DEPLOYS, stateLabel, stateTone, deployLine, rateLine, timeLeft, hitWhere, listOf, offers, ordered };
  if (typeof module === 'object' && module.exports) module.exports = api;

  const F = root.jarvisFeatures;
  if (!F || typeof document === 'undefined') return;
  const { el, send, t } = F;
  const keepFocus = (box, drawIt) => (root.jarvisFocus ? root.jarvisFocus.keep(box, drawIt) : drawIt());
  const projects = () => (typeof deckProjects !== 'undefined' ? deckProjects.map((p) => p.name) : []);
  const state = {
    on: true,
    minutes: 60,
    projects: {},
    watches: [],
    browser: false,
    prs: [],
    form: { minutes: '', project: '', own: '', health: '', page: '' },
  };
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
    toggle.setAttribute('aria-label', t(label));
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

  function input(value, label, run, opts = {}) {
    const box = el('input', `jcs-input ${opts.cls || ''}`.trim());
    box.value = value || '';
    if (opts.type) box.type = opts.type;
    if (opts.placeholder) box.placeholder = opts.placeholder;
    box.setAttribute('aria-label', t(label));
    box.dataset.noI18n = '';
    box.autocomplete = 'off';
    box.addEventListener('input', () => run(box.value));
    return box;
  }

  // ── settings ──

  function pickProject(f) {
    const names = projects();
    if (!f.project && names.length) f.project = names[0];
    const pick = el('select', 'jcs-select');
    pick.setAttribute('aria-label', t('Project'));
    pick.dataset.noI18n = '';
    for (const name of names) {
      const o = el('option', '', name);
      o.value = name;
      o.selected = name === f.project;
      pick.append(o);
    }
    pick.addEventListener('change', () => {
      f.project = pick.value;
      const own = state.projects[f.project] || {};
      f.own = own.minutes ? String(own.minutes) : '';
      f.health = (own.health || []).join(', ');
      f.page = own.page || '';
      draw();
    });
    return pick;
  }

  function projectForm() {
    const f = state.form;
    const box = el('form', 'jcx-ro-form');
    box.append(
      row('Project', '', pickProject(f)),
      row('Its own window (minutes)', 'Empty: the window above.', input(f.own, 'Its own window (minutes)', (v) => { f.own = v; }, { type: 'number', cls: 'jcx-ro-num' })),
      row('Health checks', 'Addresses that answer when it’s up: https, or http on this Mac. Up to 5.', input(f.health, 'Health checks', (v) => { f.health = v; }, { placeholder: 'https://app.example.com/health' })),
      row('Page to load', 'Loaded in a background tab of the built-in browser before and after the deploy; its new console errors and failed requests count. It clicks and types nothing.', input(f.page, 'Page to load', (v) => { f.page = v; }, { placeholder: 'https://app.example.com/' })),
    );
    const actions = el('div', 'jcx-ro-actions');
    const save = el('button', 'jc-btn small filled', 'Save');
    save.type = 'submit';
    actions.append(el('span', 'jc-spacer'), save);
    box.append(actions);
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      send({ type: 'code_rollouts_project', project: f.project, minutes: f.own.trim() ? Number(f.own) : null, health: listOf(f.health), page: f.page.trim() });
    });
    return box;
  }

  function draw() {
    if (!group) return;
    const f = state.form;
    if (!f.minutes) f.minutes = String(state.minutes || 60);
    const minutes = input(f.minutes, 'Watch window (minutes)', (v) => { f.minutes = v; }, { type: 'number', cls: 'jcx-ro-num' });
    const tools = el('span', 'jcx-ro-tools');
    tools.append(minutes, button('Save', '', () => send({ type: 'code_rollouts_set', minutes: Number(f.minutes) || 60 }), `${t('Save')} ${t('Watch window (minutes)')}`));
    const parts = [
      row('Watch after a merge', 'When a pull request Eden opened is merged, Eden watches the deploy, its checks and new errors for a while, and tells you if it looks like it broke something. It never reverts or deploys by itself.',
        sw('Watch after a merge', state.on, (on) => send({ type: 'code_rollouts_set', on }))),
      row('Watch window (minutes)', 'From the merge. New errors come from Production alerts’ Sentry and Datadog links.', tools),
    ];
    const own = Object.entries(state.projects || {});
    if (own.length) {
      const list = el('ul', 'jcx-ro-list');
      list.append(...own.map(([name, cfg]) => {
        const li = el('li');
        const text = el('span', 'jcx-ro-proj');
        text.append(mine(name, 'strong'));
        const bits = [];
        if (cfg.minutes) bits.push(`${cfg.minutes} min`);
        if ((cfg.health || []).length) bits.push(cfg.health.join(', '));
        if (cfg.page) bits.push(cfg.page);
        if (bits.length) text.append(mine(` · ${bits.join(' · ')}`, 'small'));
        li.append(text, button('Remove', 'danger', () => send({ type: 'code_rollouts_project', project: name, remove: true }), `${t('Remove')} ${name}`));
        return li;
      }));
      parts.push(list);
    }
    parts.push(projectForm());
    keepFocus(group, () => group.replaceChildren(...parts));
  }

  (function addSettings() {
    const general = document.getElementById('jcs-general');
    if (!general) return;
    const label = el('p', 'jcs-label', 'Watching after a merge');
    group = el('div', 'jcs-group jcx-ro');
    const foot = general.querySelector('.jcs-foot');
    general.insertBefore(label, foot);
    general.insertBefore(group, foot);
    draw();
  })();

  // ── the pane ──

  function fact(label, value, tone) {
    const r = el('div', `jcx-ro-fact ${tone || ''}`.trim());
    const v = typeof value === 'string' ? el('span', 'jcx-ro-fact-v', value) : value;
    v.classList.add('jcx-ro-fact-v');
    r.append(el('span', 'jcx-ro-fact-k', label), v);
    return r;
  }

  function issueRow(i) {
    const li = el('li', `jcx-ro-issue${(i.hits || []).length ? ' hit' : ''}`);
    const head = el('div', 'jcx-ro-issue-head');
    const name = i.url ? el('a', 'jcx-ro-link') : el('span');
    if (i.url) { name.href = i.url; name.target = '_blank'; name.rel = 'noopener noreferrer'; }
    name.append(mine(`${i.service} ${i.what}`, 'code'));
    head.append(name, mine(i.title, 'span', 'jcx-ro-issue-title'));
    li.append(head);
    const meta = el('p', 'jc-dim jcx-ro-issue-meta');
    meta.append(el('span', '', i.new ? 'First seen since the merge' : 'Regressed'), mine(` · ${i.count || 1}`), el('span', '', ` ${Number(i.count) === 1 ? 'event' : 'events'}`));
    li.append(meta);
    for (const h of (i.hits || []).slice(0, 2)) {
      const p = el('p', 'jcx-ro-hit');
      p.append(el('span', '', `In ${LEVELS[h.level] || 'a changed file'}:`), mine(` ${hitWhere(h)}`, 'code'));
      li.append(p);
    }
    return li;
  }

  function card(w) {
    const box = el('section', `jcx-ro-card ${stateTone(w)}`.trim());
    box.setAttribute('aria-label', `${w.repo}#${w.number}`);
    const head = el('div', 'jcx-ro-head');
    const a = el('a', 'jcx-ro-link');
    a.href = w.url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.append(mine(`#${w.number}`, 'code'), mine(` ${w.title || ''}`));
    const chip = el('span', `jcx-chip ${stateTone(w)}`.trim(), stateLabel(w));
    head.append(a, chip);
    box.append(head);
    const where = el('p', 'jc-dim jcx-ro-where');
    where.append(mine(`${w.project} · ${w.base} · ${String(w.sha || '').slice(0, 7)}`));
    const left = timeLeft(w);
    if (left) where.append(mine(' · '), el('span', '', left));
    box.append(where);
    const facts = el('div', 'jcx-ro-facts');
    const d = w.deploy || {};
    facts.append(fact('Deploy', deployLine(d), d.state === 'failure' || d.state === 'error' ? 'bad' : d.state === 'success' ? 'good' : ''));
    const checks = w.checks || {};
    if (checks.state && checks.state !== 'none') {
      const value = checks.state === 'failed' ? mine((checks.failing || []).join(', ') || '?') : el('span', '', checks.state === 'passed' ? 'Passed' : 'Running');
      facts.append(fact('Checks on the merge', value, checks.state === 'failed' ? 'bad' : checks.state === 'passed' ? 'good' : ''));
    }
    const rate = rateLine(w.rate);
    facts.append(fact('Errors', rate || 'None new', rate ? '' : 'good'));
    for (const h of w.health || []) {
      const how = h.ok === null || h.ok === undefined ? 'Not checked yet' : h.ok ? `Up (${h.status})` : h.status ? `Down (${h.status})` : `Down (${h.error || 'no answer'})`;
      const v = el('span', 'jcx-ro-fact-v');
      v.append(mine(h.url, 'code'), mine(` ${how}`));
      facts.append(fact('Health check', v, h.ok === false ? 'bad' : h.ok ? 'good' : ''));
    }
    const s = w.synthetic || {};
    if (s.url) {
      const said = s.after ? ((s.new || []).length ? `${s.new.length} new errors` : 'No new errors') : s.baseline ? 'Checked before the deploy' : state.browser ? 'Not loaded yet' : 'Needs the built-in browser (the Eden Code window)';
      facts.append(fact('Page', said, (s.new || []).length ? 'bad' : s.after ? 'good' : ''));
    }
    box.append(facts);
    if ((w.reasons || []).length) {
      const why = el('ul', 'jcx-ro-why');
      why.setAttribute('aria-label', t('Evidence'));
      why.append(...w.reasons.map((r) => {
        const li = el('li', `${r.strong ? 'strong' : 'suspect'}${r.past ? ' past' : ''}`);
        li.append(mine(r.text));
        if (!r.strong) li.append(el('small', '', ' (a suspicion)'));
        if (r.past) li.append(el('small', '', ' (seen earlier, gone since)'));
        return li;
      }));
      box.append(why);
    }
    if ((w.issues || []).length) {
      const list = el('ul', 'jcx-ro-issues');
      list.append(...w.issues.map(issueRow));
      box.append(list);
    }
    for (const e of (s.new || []).slice(0, 5)) box.append(mine(e, 'p', 'jcx-ro-page'));
    for (const n of w.notes || []) box.append(mine(n, 'p', 'jc-dim jcx-ro-note'));
    const bar = el('div', 'jcx-ro-actions');
    if (offers(w)) {
      bar.append(
        button('Open a fix session', 'filled', () => send({ type: 'code_rollout_fix', id: w.id }), `${t('Open a fix session')}: #${w.number}`),
        button('Prepare a revert PR', '', () => send({ type: 'code_rollout_revert', id: w.id }), `${t('Prepare a revert PR')}: #${w.number}`),
        button('Dismiss', 'tinted', () => send({ type: 'code_rollout_dismiss', id: w.id }), `${t('Dismiss')}: #${w.number}`),
      );
      const note = el('p', 'jc-dim jcx-ro-offer', 'Each opens a session in an isolated copy that you drive. Nothing is pushed, reverted or deployed without you.');
      box.append(note);
    } else if (w.acted && ACTED[w.acted]) {
      bar.append(el('span', 'jc-dim', ACTED[w.acted]));
      if (w.session) bar.append(button('Show it', '', () => F.selectTask(w.session), `${t('Show it')}: #${w.number}`));
    }
    if (bar.childNodes.length) box.append(bar);
    if (w.state === 'watching') {
      const watching = el('div', 'jcx-ro-actions');
      watching.append(el('span', 'jc-spacer'),
        button('Look now', '', () => send({ type: 'code_rollout_check', id: w.id }), `${t('Look now')}: #${w.number}`),
        button('Stop', 'danger', () => send({ type: 'code_rollout_stop', id: w.id }), `${t('Stop watching')}: #${w.number}`));
      box.append(watching);
    }
    return box;
  }

  function unwatched() {
    const watched = new Set(state.watches.map((w) => w.key));
    return (state.prs || []).filter((p) => p.state === 'merged' && !watched.has(p.key)).slice(0, 5);
  }

  function renderPane(target) {
    paneBody = target;
    const wrap = el('div', 'jcx-ro-pane');
    if (!state.on) wrap.append(el('p', 'jc-empty', 'Watching after a merge is off: turn it on in Eden Code settings.'));
    const watches = ordered(state.watches);
    if (!watches.length) wrap.append(el('p', 'jc-empty', 'Nothing watched yet: a watch starts when a pull request Eden opened is merged.'));
    else wrap.append(...watches.map(card));
    const rest = unwatched();
    if (rest.length) {
      const box = el('div', 'jcx-ro-others');
      box.append(el('p', 'jcs-label', 'Merged, not watched'));
      const list = el('ul', 'jcx-ro-list');
      list.append(...rest.map((p) => {
        const li = el('li');
        li.append(mine(`#${p.number} ${p.title || ''}`, 'span', 'jcx-ro-proj'),
          button('Watch it', '', () => send({ type: 'code_rollout_watch', key: p.key }), `${t('Watch it')}: #${p.number}`));
        return li;
      }));
      box.append(list);
      wrap.append(box);
    }
    keepFocus(target, () => target.replaceChildren(wrap));
  }

  const shown = () => paneBody && paneBody.isConnected && paneBody.querySelector('.jcx-ro-pane');

  F.registerPane('rollouts', { title: 'Rollouts', render(target) { renderPane(target); send({ type: 'code_rollouts' }); } });
  F.registerMoreItem({ label: 'Rollouts', run: () => F.openPane('rollouts') });

  F.on('hello', () => send({ type: 'code_rollouts' }), { replay: true });
  F.on('code_rollouts', (ev) => {
    state.on = ev.on !== false;
    state.minutes = ev.minutes || 60;
    state.projects = ev.projects || {};
    state.watches = ev.watches || [];
    state.browser = !!ev.browser;
    draw();
    if (shown()) renderPane(paneBody);
  });
  F.on('code_prs', (ev) => { state.prs = ev.items || []; if (shown()) renderPane(paneBody); });
  F.on('claude_projects', () => draw());
  root.JarvisRollouts = { state };
})(typeof window === 'object' ? window : globalThis);
