// Eden Code's merge queue on the agent board (features/code_merge_queue.py): a lane that
// shows each project's queue in the order its work will land (isolated copies landed,
// pull requests merged, one at a time, each brought onto the newest tip and tested
// first), what each item is doing or why it waits, and what's ready to join it (copies
// with work in them and open pull requests not queued yet: Queue puts one in, behind a
// card). The owner moves an item up or down, pauses or resumes it, tries one again or
// takes it off, and pauses a whole project's queue. An item that needs the owner (a
// conflict it couldn't send back, failing tests, secrets) is marked, counted in the lane's
// head, and also a heads-up in the attention list. An item the semantic conflict guard
// holds (features/code_semantic_guard.py: its symbols collide with another session's work in
// a way git doesn't see) lists what collides, with Land anyway and Check again.
// Settings › General › Merge queue: what the guard does (code_mq_semantic) and who a
// conflict goes to (code_mq_conflicts).
//
// For a screen reader: the lane is a list, each item one list item that says in one line
// its place, what it is, where it stands and why; its buttons are named with the item.
// Branch names, titles and notes from git are data (data-no-i18n). Pure logic is exported
// for node's tests (tests/web/code-merge-queue.test.mjs).
(function codeMergeQueue(root) {
  'use strict';

  const STATES = {
    queued: 'Waiting its turn',
    working: 'Landing now',
    checks: 'Waiting for its checks',
    fixing: 'Back with its session',
    paused: 'Paused',
    owner: 'Needs you',
    held: 'Held: overlapping changes',
  };

  function stateLabel(item) {
    return STATES[item && item.state] || STATES.queued;
  }

  // What's ready to queue: copies with work and open pull requests, not queued yet.
  function candidates(copies, prs, queues) {
    const queued = new Set();
    for (const q of queues || []) for (const i of q.items || []) queued.add(`${i.kind}:${i.ref}`);
    const out = [];
    for (const c of copies || []) {
      const s = c.state || {};
      const work = (s.ahead || 0) > 0 || (s.dirty || 0) > 0;
      if (work && !c.busy && !queued.has(`copy:${c.slug}`)) {
        out.push({ kind: 'copy', ref: c.slug, title: c.title || c.branch, project: c.project, where: `${c.branch} → ${c.into}` });
      }
    }
    for (const p of prs || []) {
      if (p.state === 'open' && !p.draft && !queued.has(`pr:${p.key}`)) {
        out.push({ kind: 'pr', ref: p.key, title: `#${p.number} ${p.title || ''}`.trim(), project: p.project, where: `${p.branch} → ${p.base}` });
      }
    }
    return out.slice(0, 30);
  }

  // An item in one line: "2 of 3, small fix, isolated copy, waiting its turn: …".
  function itemSpeech(item, n, total, tr = (x) => x) {
    const kind = item.kind === 'pr' ? tr('pull request') : tr('isolated copy');
    const note = String(item.note || '').replace(/[.。…]+\s*$/, '');
    return `${n + 1}/${total}, ${item.title}, ${kind}, ${tr(stateLabel(item)).toLowerCase()}${note ? `: ${note}` : ''}.`;
  }

  // The actions an item offers, as [action, label].
  function actionsFor(item, n, total) {
    const acts = [];
    if (item.state === 'working') return acts;
    if (n > 0) acts.push(['up', '↑']);
    if (n < total - 1) acts.push(['down', '↓']);
    if (item.state === 'held') acts.push(['override', 'Land anyway'], ['retry', 'Check again']);
    if (item.state === 'owner' || item.state === 'fixing') acts.push(['retry', 'Try again']);
    if (item.state === 'paused') acts.push(['resume', 'Resume']);
    else if (['queued', 'fixing', 'owner', 'held'].includes(item.state)) acts.push(['pause', 'Pause']);
    acts.push(['remove', 'Remove']);
    return acts;
  }

  // What the semantic conflict guard found, still in force (the owner landing it anyway
  // sets those aside), as the sentences its card lists.
  function collisions(item) {
    return ((item && item.guard) || []).filter((f) => f && !f.overridden && f.text).map((f) => String(f.text));
  }

  const GUARD_MODES = [['hold', 'Hold the item and tell both sessions'], ['warn', 'Tell both sessions, don’t hold'], ['off', 'Off']];
  const CONFLICT_MODES = [['session', 'To its own session'], ['owner', 'To me']];

  const api = { STATES, stateLabel, candidates, itemSpeech, actionsFor, collisions, GUARD_MODES, CONFLICT_MODES };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  const F = root.jarvisFeatures;
  if (!F || !F.codeBoard) return;

  const t = (text) => F.t(text);
  const M = { queues: [], attention: 0, copies: [], prs: [] };
  const own = (node) => { node.setAttribute('data-no-i18n', ''); return node; };
  const lane = F.el('section', 'cs-lane mq-lane');
  lane.setAttribute('aria-label', 'Merge queue');

  function button(label, cls, run, focus, aria) {
    const b = F.el('button', `jc-btn small ${cls}`.trim(), label);
    b.type = 'button';
    if (focus) b.dataset.focus = `mq:${focus}`;
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
    return b;
  }

  function draw() {
    const head = F.el('h2', 'cs-lane-head');
    const count = M.queues.reduce((n, q) => n + (q.items || []).length, 0);
    head.append(F.el('span', 'cs-lane-dot mq'), F.el('span', '', 'Merge queue'), F.el('span', 'cs-lane-count', String(count)));
    if (M.attention) {
      const needs = F.el('span', 'mq-needs', `${M.attention} ${t('need you')}`);
      needs.setAttribute('role', 'status');
      head.append(needs);
    }
    const parts = [head];
    for (const q of M.queues) parts.push(queueEl(q));
    const ready = candidates(M.copies, M.prs, M.queues);
    if (ready.length) {
      const box = F.el('div', 'mq-ready');
      box.append(F.el('p', 'mq-sub', 'Ready to queue'));
      const list = F.el('div', 'cs-cards');
      list.setAttribute('role', 'list');
      list.setAttribute('aria-label', t('Ready to queue'));
      for (const c of ready) {
        const card = F.el('article', 'cs-card mq-card mq-candidate');
        card.setAttribute('role', 'listitem');
        card.append(own(F.el('h3', 'cs-card-title', c.title)), own(F.el('p', 'cs-card-project', `${c.project} · ${c.where}`)));
        const acts = F.el('div', 'cs-card-acts');
        acts.append(button('Queue', 'tinted', () => F.send(c.kind === 'copy' ? { type: 'code_mq_add', kind: 'copy', slug: c.ref } : { type: 'code_mq_add', kind: 'pr', key: c.ref }),
          `add:${c.kind}:${c.ref}`, `${t('Queue')}: ${c.title}`));
        card.append(acts);
        list.append(card);
      }
      box.append(list);
      parts.push(box);
    }
    if (!M.queues.length && !ready.length) parts.push(F.el('p', 'cs-lane-empty', 'Nothing to land. Copies and pull requests with work show here.'));
    const keep = lane.contains(document.activeElement) ? document.activeElement.dataset.focus : '';
    lane.replaceChildren(...parts);
    const again = keep && lane.querySelector(`[data-focus="${CSS.escape(keep)}"]`);
    if (again) again.focus();
    if (F.codeBoard.refresh) F.codeBoard.refresh();
  }

  function queueEl(q) {
    const box = F.el('div', 'mq-queue');
    const top = F.el('div', 'mq-queue-head');
    top.append(own(F.el('strong', 'mq-project', q.project)));
    top.append(button(q.paused ? 'Resume queue' : 'Pause queue', q.paused ? 'filled' : '',
      () => F.send({ type: 'code_mq_project', repo: q.repo, paused: !q.paused }), `proj:${q.repo}`, `${t(q.paused ? 'Resume queue' : 'Pause queue')}: ${q.project}`));
    box.append(top);
    const list = F.el('div', 'cs-cards');
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', `${t('Merge queue')}: ${q.project}`);
    const items = q.items || [];
    items.forEach((item, n) => {
      const card = F.el('article', `cs-card mq-card ${item.state}`);
      card.setAttribute('role', 'listitem');
      card.setAttribute('aria-label', itemSpeech(item, n, items.length, t));
      const row = F.el('div', 'cs-card-top');
      row.append(F.el('span', `jc-dot mq-${item.state}`), own(F.el('h3', 'cs-card-title', `${n + 1}. ${item.title}`)));
      card.append(row);
      card.append(own(F.el('p', 'cs-card-project', `${item.branch} → ${item.into} · ${(item.risk_why || []).join(' · ')}`)));
      card.append(F.el('p', 'cs-card-doing mq-state', stateLabel(item)));
      if (item.note) card.append(own(F.el('p', 'cs-card-stats mq-note', item.note)));
      const found = collisions(item);
      if (found.length) {
        const ul = own(F.el('ul', 'mq-guard'));
        ul.setAttribute('aria-label', `${t('Overlapping changes')}: ${item.title}`);
        for (const line of found) ul.append(F.el('li', '', line));
        card.append(ul);
      }
      const acts = F.el('div', 'cs-card-acts');
      for (const [action, label] of actionsFor(item, n, items.length)) {
        const aria = `${t(action === 'up' ? 'Move up' : action === 'down' ? 'Move down' : label)}: ${item.title}`;
        const look = action === 'remove' ? 'danger' : action === 'retry' || action === 'override' ? 'filled' : '';
        acts.append(button(label, look, () => F.send({ type: 'code_mq_item', id: item.id, action }), `${item.id}:${action}`, aria));
      }
      card.append(acts);
      list.append(card);
    });
    box.append(list);
    return box;
  }

  F.on('code_mq', (ev) => { M.queues = ev.queues || []; M.attention = Number(ev.attention) || 0; draw(); });
  F.on('code_copies', (ev) => { M.copies = ev.copies || []; draw(); });
  F.on('code_prs', (ev) => { M.prs = ev.items || []; draw(); });
  F.on('hello', () => { F.send({ type: 'code_mq' }); F.send({ type: 'code_copies' }); F.send({ type: 'code_prs' }); }, { replay: true });
  F.codeBoard.addLane({ order: 1, shows: () => `mq:${M.queues.length}:${M.attention}`, element: () => lane });
  draw();

  // ── Eden Code settings › General › Merge queue ──
  const picks = {};
  function settingRow(id, pref, title, small, modes) {
    const row = F.el('label', 'jcs-row');
    const words = F.el('span');
    words.append(document.createTextNode(t(title)), F.el('small', '', t(small)));
    const pick = F.el('select', 'jcs-select');
    pick.id = id;
    for (const [value, label] of modes) {
      const o = F.el('option', '', t(label));
      o.value = value;
      pick.append(o);
    }
    pick.addEventListener('change', () => F.send({ type: 'feature_prefs', changes: { [pref]: pick.value } }));
    picks[pref] = pick;
    row.append(words, pick);
    return row;
  }
  function buildSettings() {
    const general = typeof document !== 'undefined' && document.getElementById('jcs-general');
    if (!general || document.getElementById('mq-semantic')) return;
    const label = F.el('p', 'jcs-label', t('Merge queue'));
    const group = F.el('div', 'jcs-group');
    group.append(
      settingRow('mq-semantic', 'code_mq_semantic', 'Overlapping changes',
        'Before an item lands, Eden compares the functions and signatures it changed with the other sessions’ work, on this Mac (no model). Two changing one function, a new signature against new calls the old way, or something removed that the other still uses: both sessions are told.', GUARD_MODES),
      settingRow('mq-conflicts', 'code_mq_conflicts', 'Conflicts and failing tests',
        'Where the queue sends an item it can’t land: back to the session that made it (a turn of its model), or to you.', CONFLICT_MODES),
    );
    const foot = general.querySelector('.jcs-foot');
    if (foot) general.insertBefore(label, foot); else general.append(label);
    general.insertBefore(group, label.nextSibling);
  }
  const takePrefs = (features) => {
    const f = features || {};
    if (picks.code_mq_semantic) picks.code_mq_semantic.value = ['warn', 'off'].includes(f.code_mq_semantic) ? f.code_mq_semantic : 'hold';
    if (picks.code_mq_conflicts) picks.code_mq_conflicts.value = f.code_mq_conflicts === 'owner' ? 'owner' : 'session';
  };
  buildSettings();
  F.on('prefs', (ev) => takePrefs(ev.features), { replay: true });
  F.on('hello', (ev) => takePrefs(ev.prefs && ev.prefs.features), { replay: true });
})(typeof window === 'object' ? window : globalThis);
