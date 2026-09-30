// Subagent lanes (features/code_lanes.py): the Subagents pane, each Agent call a session
// made as a tree (a subagent may start its own), with its steps, tokens, time and estimated
// cost, and Stop for one subagent while the session goes on; its More item and /subagents.
//
// Everything shown from the backend is data: text only (textContent); what a subagent was
// asked to do is marked data-no-i18n. Pure helpers are exported for node --test
// (tests/web/code-lanes.test.mjs).
(function (root) {
  'use strict';

  // 45.2k tokens, 1.2M tokens, 800 tokens.
  function fmtTokens(n) {
    const v = Math.max(0, Number(n) || 0);
    if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
    if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
    return String(Math.round(v));
  }

  // 12s, 1m 3s, 1h 2m.
  function fmtSeconds(s) {
    const v = Math.max(0, Math.round(Number(s) || 0));
    if (v < 60) return `${v}s`;
    if (v < 3600) return `${Math.floor(v / 60)}m ${v % 60}s`;
    return `${Math.floor(v / 3600)}h ${Math.floor((v % 3600) / 60)}m`;
  }

  // An estimate: ≈ $0.08, < $0.01, or nothing while no price is known.
  function fmtCost(c) {
    if (c === null || c === undefined || Number.isNaN(Number(c))) return '';
    const v = Number(c);
    if (v > 0 && v < 0.01) return '< $0.01';
    return `≈ $${v.toFixed(2)}`;
  }

  // The lanes as a tree, depth first: [lane, depth] pairs, parents before their own, in the
  // order they started. A lane whose parent isn't there is at the top.
  function tree(lanes) {
    const ids = new Set((lanes || []).map((l) => l.id));
    const children = new Map();
    for (const lane of lanes || []) {
      const parent = lane.parent && ids.has(lane.parent) ? lane.parent : '';
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(lane);
    }
    const out = [];
    const seen = new Set();
    const walk = (parent, depth) => {
      for (const lane of children.get(parent) || []) {
        if (seen.has(lane.id)) continue;  // (never round in circles)
        seen.add(lane.id);
        out.push([lane, depth]);
        walk(lane.id, depth + 1);
      }
    };
    walk('', 0);
    return out;
  }

  // What's running now, for the More item's note.
  function running(lanes) { return (lanes || []).filter((l) => l.status === 'running' || l.status === 'stopping').length; }

  const api = { fmtTokens, fmtSeconds, fmtCost, tree, running };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;
  const { el } = F;
  const mine = (node) => { node.setAttribute('data-no-i18n', ''); return node; };

  const bySession = new Map();  // task id -> lanes
  let paneBody = null;
  let ticker = 0;  // a running lane's time goes on between pushes

  const paneShown = () => paneBody && paneBody.isConnected && typeof currentPane !== 'undefined' && currentPane === 'lanes';
  const STATUS = { running: 'Working', stopping: 'Stopping…', done: 'Done', failed: 'Failed', stopped: 'Stopped' };
  const DOT = { running: 'busy', stopping: 'busy', done: 'waiting', failed: 'failed', stopped: 'idle' };

  function laneRow(lane, depth, task) {
    const li = el('li', `cl-lane ${lane.status}${depth ? ' nested' : ''}`);
    li.dataset.lane = lane.id;
    li.style.setProperty('--depth', String(Math.min(depth, 6)));
    const head = el('div', 'cl-head');
    head.append(el('span', `jc-dot ${DOT[lane.status] || 'idle'}`), mine(el('strong', 'cl-agent', lane.agent)));
    if (lane.background) head.append(el('span', 'cl-badge', 'Background'));
    head.append(el('span', 'cl-state', STATUS[lane.status] || lane.status));
    if (lane.can_stop) {
      const stop = el('button', 'jc-btn small danger cl-stop', 'Stop');
      stop.type = 'button';
      stop.title = F.t('Stop this subagent; the session goes on');
      stop.addEventListener('click', () => { stop.disabled = true; F.send({ type: 'cl_stop', id: task.id, lane: lane.id }); });
      head.append(stop);
    }
    li.append(head);
    if (lane.description) li.append(mine(el('p', 'cl-desc', lane.description)));
    const facts = el('p', 'cl-facts jc-dim');
    const steps = el('span');
    steps.append(el('span', 'cl-n', String(lane.steps)), document.createTextNode(' '), el('span', '', lane.steps === 1 ? 'step' : 'steps'));
    const tokens = el('span');
    tokens.append(el('span', 'cl-n', fmtTokens(lane.tokens)), document.createTextNode(' '), el('span', '', 'tokens'));
    const time = el('span', 'cl-n cl-time', fmtSeconds(lane.seconds));
    time.dataset.seconds = String(lane.seconds);
    facts.append(steps, tokens, time);
    const cost = fmtCost(lane.cost);
    if (cost) { const c = el('span', 'cl-n', cost); c.title = F.t('An estimate: its tokens at what Claude Code says each model cost'); facts.append(c); }
    li.append(facts);
    if (lane.last && (lane.status === 'running' || lane.status === 'stopping')) li.append(mine(el('p', 'cl-last', lane.last)));
    return li;
  }

  function renderPane(body, task) {
    paneBody = body;
    if (!task) { body.replaceChildren(el('p', 'jc-empty', 'Open a session to see its subagents.')); return; }
    const lanes = bySession.get(task.id) || [];
    if (!lanes.length) {
      body.replaceChildren(el('p', 'jc-empty', 'No subagents in this session yet. When Claude hands part of the work to one, it shows here.'));
      return;
    }
    const ul = el('ul', 'cl-tree');
    ul.append(...tree(lanes).map(([lane, depth]) => laneRow(lane, depth, task)));
    const n = running(lanes);
    const head = el('p', 'jc-dim cl-intro');
    head.append(el('span', '', n ? 'Working now:' : 'All finished.'), document.createTextNode(n ? ` ${n}` : ''));
    body.replaceChildren(head, ul);
    tick();
  }

  // A running lane's clock goes on between pushes, once a second while the pane shows.
  function tick() {
    clearInterval(ticker);
    ticker = setInterval(() => {
      if (!paneShown()) { clearInterval(ticker); return; }
      paneBody.querySelectorAll('.cl-lane.running .cl-time').forEach((n) => {
        const s = Number(n.dataset.seconds) + 1;
        n.dataset.seconds = String(s);
        n.textContent = fmtSeconds(s);
      });
    }, 1000);
  }

  F.registerPane('lanes', { title: 'Subagents', render(body, task) { renderPane(body, task); if (task) F.send({ type: 'cl_lanes', id: task.id }); } });
  F.registerMoreItem({
    label: 'Subagents',
    get note() { const task = F.currentTask(); const n = task ? running(bySession.get(task.id)) : 0; return n ? `${n} working` : 'Each subagent’s steps, tokens and cost'; },
    when: (task) => !!task && (bySession.get(task.id) || []).length > 0,
    run: () => F.openPane('lanes'),
  });
  F.registerSlash({ name: 'subagents', help: 'What each subagent is doing, and what it cost', run() { F.openPane('lanes'); return true; } });

  F.on('cl_lanes', (ev) => {
    bySession.set(ev.id, ev.lanes || []);
    const task = F.currentTask();
    if (paneShown() && task && task.id === ev.id) renderPane(paneBody, task);
  });
  // A session on show: its lanes, once (then they're pushed as they change).
  let askedFor = null;
  const ask = () => {
    const task = F.currentTask();
    if (!task || task.id === askedFor || task.kind !== 'code') return;
    askedFor = task.id;
    F.send({ type: 'cl_lanes', id: task.id });
  };
  F.on('tasks', ask);
  F.on('task_transcript', ask);
})(typeof window === 'object' ? window : globalThis);
