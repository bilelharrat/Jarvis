// Eden Code's agent board: every session as a card, by where it stands (needs you,
// working, done, failed, resting), with its project, branch, lines changed, cost, last
// activity and what it's doing, and a click to open it, stop it or answer what it asks.
// The Dock's badge says how many sessions need you (app/features/code-sessions.js).
// Its pure logic is exported for node's tests.
(function codeBoard(root) {
  'use strict';

  const COLUMNS = [
    ['needs', 'Needs you'],
    ['working', 'Working'],
    ['done', 'Done'],
    ['failed', 'Failed'],
    ['resting', 'Resting'],
  ];

  // Where a session stands: a question or approval waiting beats everything else.
  function column(task, asks) {
    if (asks > 0) return 'needs';
    if (task.busy || task.status === 'running') return 'working';
    if (task.status === 'failed') return 'failed';
    if (task.status === 'waiting') return 'done';
    return 'resting';
  }

  // One line of what it's doing (or did last).
  function doing(task, ask) {
    const firstLine = (text) => String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
    if (ask) return ask.question || 'Waiting for your answer';
    if (task.busy) return task.last_action && task.last_action !== 'Working' ? task.last_action : 'Working';
    const said = firstLine(task.result);
    if (said) return said.length > 160 ? `${said.slice(0, 160)}…` : said;
    return task.status === 'resting' ? 'Resting: it picks up where it left off' : task.last_action || '';
  }

  // "just now", "4 min ago", "2 h ago", then the date.
  function ago(iso, now = Date.now()) {
    const at = new Date(iso).getTime();
    if (!iso || Number.isNaN(at)) return '';
    const secs = Math.max(0, Math.round((now - at) / 1000));
    if (secs < 60) return 'just now';
    if (secs < 3600) return `${Math.round(secs / 60)} min ago`;
    if (secs < 86400) return `${Math.round(secs / 3600)} h ago`;
    return '';
  }

  // Sessions by column, the newest first within one; archived ones only when asked for.
  function arrange(tasks, metaOf, asksOf, showArchived) {
    const out = Object.fromEntries(COLUMNS.map(([id]) => [id, []]));
    for (const task of tasks) {
      if (!showArchived && metaOf(task.id).archived) continue;
      out[column(task, asksOf(task.id))].push(task);
    }
    for (const list of Object.values(out)) list.sort((a, b) => b.id - a.id);
    return out;
  }

  const api = { COLUMNS, column, doing, ago, arrange };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  const F = root.jarvisFeatures;
  if (!F) return;

  const t = (text) => F.t(text);
  const board = el('section', 'cs-board glass-panel');
  board.setAttribute('aria-label', 'Agent board');
  board.hidden = true;
  $('cc').querySelector('.jc-main').append(board);
  const B = { figures: {}, showArchived: false, timer: 0, badge: -1 };
  const shared = () => F.codeSessions || { meta: new Map(), unread: new Set() };
  const metaOf = (id) => shared().meta.get(id) || {};
  const asksOf = (id) => [...pendingApprovals.values()].filter((a) => a.task_id === id);

  function isOpen() { return !board.hidden; }
  function open() {
    if ($('cc').hidden) toggleCC(true);
    board.hidden = false;
    $('cc').classList.add('cs-board-on');
    toggle.setAttribute('aria-pressed', 'true');
    F.send({ type: 'code_board' });
    clearInterval(B.timer);
    B.timer = setInterval(() => { if (isOpen() && !$('cc').hidden) F.send({ type: 'code_board' }); }, 15000);
    render();
    board.querySelector('.cs-board-close').focus();
  }
  function close() {
    board.hidden = true;
    $('cc').classList.remove('cs-board-on');
    toggle.setAttribute('aria-pressed', 'false');
    clearInterval(B.timer);
    if (typeof moveGlider === 'function') moveGlider();
  }

  const toggle = el('button', 'jc-icon cs-foot-btn cs-board-btn');
  toggle.type = 'button';
  toggle.setAttribute('aria-label', 'Agent board');
  toggle.setAttribute('aria-pressed', 'false');
  toggle.title = 'Agent board: every session at a glance (⇧⌘B)';
  toggle.insertAdjacentHTML('beforeend', '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2" y="2.5" width="3.4" height="11" rx="1.2"/><rect x="6.3" y="2.5" width="3.4" height="7" rx="1.2"/><rect x="10.6" y="2.5" width="3.4" height="9" rx="1.2"/></svg>');
  toggle.addEventListener('click', () => (isOpen() ? close() : open()));
  $('jc-side').querySelector('.jc-side-foot').append(toggle);  // beside "2 working · 1 waiting"
  F.registerMoreItem({ label: 'Agent board', note: 'Every session at a glance', run: open });
  document.addEventListener('keydown', (e) => {
    if ($('cc').hidden) return;
    if (e.key.toLowerCase() === 'b' && e.metaKey && e.shiftKey && !e.altKey && !e.ctrlKey) { e.preventDefault(); if (isOpen()) close(); else open(); }
  });
  // Esc closes the board, but what's over it first: a menu, or any dialog shown (Settings, a
  // name being asked for, the effort, a picture shown larger), which closes by itself.
  const covered = () => !$('jc-menu').hidden || [...document.querySelectorAll('[role="dialog"]')].some((d) => !d.closest('[hidden]'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen() && !$('cc').hidden && !covered()) { e.stopPropagation(); e.preventDefault(); close(); }
  }, true);
  F.on('jc_select', () => { if (isOpen()) close(); });
  F.on('code_board', (ev) => { B.figures = ev.items || {}; schedule(); });
  for (const type of ['tasks', 'approval', 'approval_resolved', 'code_meta', 'task_finished']) F.on(type, () => { schedule(); badge(); });

  let frame = 0;
  // A card or button held down is never replaced under the pointer (its click would be lost):
  // the board is drawn once it's let go.
  let pressing = false;
  board.addEventListener('pointerdown', (e) => { if (e.button === 0 && e.target.closest('button, .cs-card')) pressing = true; });
  for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, () => { if (pressing) { pressing = false; schedule(); } }, true);
  function schedule() {
    if (frame || !isOpen()) return;
    frame = requestAnimationFrame(() => { frame = 0; if (!pressing) render(); });
  }

  // The Dock's badge: sessions waiting on an answer from you.
  function badge() {
    const count = ccTasks.filter((x) => asksOf(x.id).length).length;
    if (count === B.badge) return;
    B.badge = count;
    if (app && app.feature) app.feature.send('feature:code-sessions:badge', count);
  }

  let drawn = '';  // what the board showed when last drawn
  function render() {
    const tasks = ccTasks;
    // Drawn anew only when what it shows has changed: the hub resends the task list up to ten
    // times a second while sessions work.
    const shows = JSON.stringify([B.showArchived, uiLocale(), tasks.map((task) => {
      const meta = metaOf(task.id);
      const asks = asksOf(task.id);
      const figures = B.figures[String(task.id)] || {};
      const at = figures.updated || meta.updated;
      return [task.id, task.title, task.prompt, task.folder, task.status, task.busy, doing(task, asks[0]), (task.files_changed || []).length, task.cost_usd,
        meta.archived, meta.pinned, meta.group, asks.map((a) => [a.id, a.detail, a.choices]), figures.branch, figures.added, figures.removed, at, ago(at), shared().unread.has(task.id)];
    })]);
    if (shows === drawn) return;
    drawn = shows;
    const columns = arrange(tasks, metaOf, (id) => asksOf(id).length, B.showArchived);
    const archived = tasks.filter((x) => metaOf(x.id).archived).length;
    const head = el('header', 'cs-board-head');
    const title = el('div', 'cs-board-titles');
    const sub = el('p', 'cs-board-sub');
    const said = { needs: 'need you', working: 'working', done: 'done', failed: 'failed' };
    for (const id of Object.keys(said)) {
      if (!columns[id].length) continue;
      if (sub.childNodes.length) sub.append(document.createTextNode(' · '));
      sub.append(el('span', '', `${columns[id].length} ${said[id]}`));
    }
    if (!sub.childNodes.length) sub.append(el('span', '', tasks.length ? 'All quiet' : 'No sessions yet'));
    title.append(el('h1', 'cs-board-title', 'Agent board'), sub);
    const tools = el('div', 'cs-board-tools');
    if (archived) {
      const arch = el('button', 'jc-btn small', B.showArchived ? 'Hide archived' : `Show archived (${archived})`);
      arch.type = 'button';
      arch.addEventListener('click', () => { B.showArchived = !B.showArchived; render(); });
      tools.append(arch);
    }
    const x = el('button', 'jc-icon cs-board-close');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close the board');
    x.title = 'Close the board (Esc)';
    x.insertAdjacentHTML('beforeend', '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>');
    x.addEventListener('click', close);
    tools.append(x);
    head.append(title, tools);
    const lanes = el('div', 'cs-lanes');
    for (const [id, label] of COLUMNS) {
      const list = columns[id];
      const lane = el('section', `cs-lane ${id}`);
      lane.setAttribute('aria-label', label);
      const lh = el('h2', 'cs-lane-head');
      lh.append(el('span', `cs-lane-dot ${id}`), el('span', '', label), el('span', 'cs-lane-count', String(list.length)));
      const cards = el('div', 'cs-cards');
      if (!list.length) cards.append(el('p', 'cs-lane-empty', id === 'needs' ? 'Nothing waiting on you.' : 'None'));
      cards.append(...list.map((task) => cardFor(task, id)));
      lane.append(lh, cards);
      lanes.append(lane);
    }
    const had = board.querySelector('.cs-lanes');
    const scroll = had ? had.scrollTop : 0;
    const focused = document.activeElement && board.contains(document.activeElement) ? document.activeElement.dataset.focus : '';
    board.replaceChildren(head, lanes);
    lanes.scrollTop = scroll;
    const again = focused && board.querySelector(`[data-focus="${CSS.escape(focused)}"]`);
    if (again) again.focus();
  }

  function cardFor(task, col) {
    const meta = metaOf(task.id);
    const asks = asksOf(task.id);
    const figures = B.figures[String(task.id)] || {};
    const card = el('article', `cs-card ${col}`);
    card.dataset.task = task.id;
    const top = el('div', 'cs-card-top');
    const named = task.title || task.prompt;  // the user's words; "New session" is the window's
    top.append(el('span', `jc-dot ${col === 'needs' ? 'needs' : statusOf(task)}`), named ? mine(el('h3', 'cs-card-title', named)) : el('h3', 'cs-card-title', 'New session'));
    if (shared().unread.has(task.id)) { const u = el('span', 'cs-unread'); u.title = t('New since you looked'); top.append(u); }
    if (meta.pinned) { const pin = el('span', 'cs-pin'); pin.insertAdjacentHTML('beforeend', shared().pinIcon || ''); pin.title = t('Pinned'); top.append(pin); }
    const project = el('p', 'cs-card-project');
    const branch = figures.branch || '';
    project.append(mine(el('span', '', task.folder)));
    if (branch) project.append(document.createTextNode(' · '), mine(el('span', 'cs-card-branch', `⎇ ${branch}`)));
    if (meta.group) project.append(document.createTextNode(' · '), mine(el('span', 'cs-card-group', meta.group)));
    const line = el('p', 'cs-card-doing', doing(task, asks[0]));
    // Its own words (the last reply), not ours ("Resting: …", "Stopped" and the like).
    if (!asks.length && !task.busy && String(task.result || '').trim()) mine(line);
    const detail = asks.length && asks[0].detail ? [mine(el('pre', 'cs-card-detail', asks[0].detail.split('\n').slice(0, 3).join('\n')))] : [];
    const stats = el('p', 'cs-card-stats');
    const files = (task.files_changed || []).length;
    if (files) stats.append(el('span', '', `${files} file${files === 1 ? '' : 's'}`));
    if (figures.added || figures.removed) {
      const lines = el('span', 'cs-card-lines');
      lines.append(el('span', 'jc-plus', `+${figures.added || 0}`), document.createTextNode(' '), el('span', 'jc-minus', `−${figures.removed || 0}`));
      stats.append(lines);
    }
    if (task.cost_usd) stats.append(el('span', '', `$${task.cost_usd.toFixed(2)}`));
    const at = figures.updated || meta.updated;
    const when = ago(at) || (at ? new Date(at).toLocaleDateString(uiLocale(), { month: 'short', day: 'numeric' }) : '');
    if (when && when !== 'Invalid Date') stats.append(el('span', '', when));
    const acts = el('div', 'cs-card-acts');
    const button = (label, cls, run, focus) => { const b = el('button', `jc-btn small ${cls}`, label); b.type = 'button'; b.dataset.focus = `${task.id}:${focus}`; b.addEventListener('click', (e) => { e.stopPropagation(); run(); }); return b; };
    if (asks.length) {
      const a = asks[0];
      for (const c of a.choices.slice(0, 4)) {
        if (c.id === 'deny' || c.id === 'plan_keep') continue;  // "no" wants a reason: Open
        acts.append(button(c.label, 'filled', () => answerApproval(a, c.id), c.id));
      }
      acts.append(button('Open', '', () => F.selectTask(task.id), 'open'));
    } else {
      acts.append(button('Open', 'tinted', () => F.selectTask(task.id), 'open'));
      if (task.busy) acts.append(button('Stop', 'danger', () => F.send({ type: 'task_interrupt', id: task.id }), 'stop'));
    }
    card.append(top, project, line, ...detail, ...(stats.childElementCount ? [stats] : []), acts);
    card.addEventListener('click', () => F.selectTask(task.id));
    return card;
  }

  badge();
})(typeof window === 'object' ? window : globalThis);
