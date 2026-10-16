// Eden Code's agent board: every session as a card, by where it stands (needs you,
// working, done, failed, resting), with its project, branch, lines changed, cost, last
// activity and what it's doing, and a click to open it, stop it or answer what it asks.
// The Dock's badge says how many sessions need you (app/features/code-sessions.js), unless
// the Needs attention inbox is there to say how much is waiting in all (code-attention.js).
//
// For a screen reader and the keyboard alone (F16, Eden Daredevil): each lane is a list and
// each card a list item that says, in one line, which session it is, where it stands and
// what it's doing or asks. One card at a time is in the Tab order: the arrows move between
// cards (up and down in a lane, left and right across lanes, Home and End), Enter opens the
// session, and 1 to 4 press the card's own buttons (an approval's answers first: the same
// press as a click, so its checks — Touch ID, the settle time — still apply). Anywhere in
// Eden Code, ⌥⌘↓ and ⌥⌘↑ go to the next and previous session in the board's order (those
// that need you first), and say where they landed.
// Other features add lanes of their own before the sessions' (F.codeBoard.addLane: the
// to-do column, features/code-todo.js). Its pure logic is exported for node's tests.
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

  const LANE_SAID = { needs: 'needs you', working: 'working', done: 'done', failed: 'failed', resting: 'resting' };

  // A card in one line, for a screen reader: "Session 3, Add a retry, needs you: Eden Code in
  // jarvis wants to run a command. jarvis, branch main. 2 files, 10 lines added, 3 removed."
  // tr: the window's translation (F.t), for Eden's own words after the lane (what it's
  // doing, "branch", the figures; web/i18n/code-board.json): the line's head ("Session 3,
  // …, needs you:") is translated whole by the board's patterns, which took the rest as
  // one name and left it English. The session's name, folder and branch stay as they are.
  function cardSpeech(task, col, ask, figures = {}, tr = (x) => x) {
    const named = task.title || task.prompt || tr('New session');
    const what = tr(doing(task, ask)).replace(/[.。…]+\s*$/, '');  // (each part ends on its own full stop)
    const parts = [`Session ${task.id}, ${String(named).split('\n')[0].slice(0, 120)}, ${LANE_SAID[col] || col}${what ? `: ${what}` : ''}`];
    const where = [task.folder, figures.branch ? `${tr('branch')} ${figures.branch}` : ''].filter(Boolean).join(', ');
    if (where) parts.push(where);
    const files = (task.files_changed || []).length;
    const stats = [];
    if (files) stats.push(tr(`${files} file${files === 1 ? '' : 's'}`));
    if (figures.added || figures.removed) stats.push(tr(`${figures.added || 0} lines added, ${figures.removed || 0} removed`));
    if (stats.length) parts.push(stats.join(', '));
    return `${parts.join('. ')}.`;
  }

  // Where the focus goes from a card, by key: lanes is the ids of each lane's cards, at the
  // card it's on ({ lane, index }); null when the key isn't one of the board's.
  function moveIn(lanes, at, key) {
    const full = lanes.map((ids, lane) => (ids.length ? lane : -1)).filter((lane) => lane >= 0);
    if (!full.length) return null;
    const lane = full.includes(at.lane) ? at.lane : full[0];
    const ids = lanes[lane];
    const index = Math.min(Math.max(0, at.index), ids.length - 1);
    if (key === 'ArrowDown') return { lane, index: Math.min(ids.length - 1, index + 1) };
    if (key === 'ArrowUp') return { lane, index: Math.max(0, index - 1) };
    if (key === 'Home') return { lane, index: 0 };
    if (key === 'End') return { lane, index: ids.length - 1 };
    if (key === 'ArrowRight' || key === 'ArrowLeft') {
      const step = key === 'ArrowRight' ? 1 : -1;
      const next = full[full.indexOf(lane) + step];
      if (next === undefined) return { lane, index };
      return { lane: next, index: Math.min(index, lanes[next].length - 1) };
    }
    return null;
  }

  // The next (dir 1) or previous (-1) session in the board's order, round the end; the first
  // when none is open.
  function nextSession(order, current, dir) {
    if (!order.length) return null;
    const at = order.indexOf(current);
    if (at < 0) return dir > 0 ? order[0] : order[order.length - 1];
    return order[(at + dir + order.length) % order.length];
  }

  const api = { COLUMNS, column, doing, ago, arrange, cardSpeech, moveIn, nextSession };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  const F = root.jarvisFeatures;
  if (!F) return;

  const t = (text) => F.t(text);
  const board = el('section', 'cs-board glass-panel');
  board.setAttribute('aria-label', 'Agent board');
  board.hidden = true;
  $('cc').querySelector('.jc-main').append(board);
  const B = { figures: {}, showArchived: false, timer: 0, badge: -1, lanes: [], focusId: null };
  // Lanes other features put first: { shows() -> what it draws (a change redraws the
  // board), element() -> its lane, kept by the feature itself (so what's being done in it
  // outlives a redraw) }.
  const extraLanes = [];
  F.codeBoard = {
    board,
    isOpen: () => isOpen(),
    open: () => open(),
    addLane(lane) { extraLanes.push(lane); drawn = ''; schedule(); },
    refresh() { drawn = ''; schedule(); },
  };
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
    const hadFocus = board.contains(document.activeElement);
    board.hidden = true;
    if (hadFocus) toggle.focus();  // (not lost to the page when the board goes)
    $('cc').classList.remove('cs-board-on');
    toggle.setAttribute('aria-pressed', 'false');
    clearInterval(B.timer);
    if (typeof moveGlider === 'function') moveGlider();
  }

  const toggle = el('button', 'jc-icon cs-foot-btn cs-board-btn');
  toggle.type = 'button';
  toggle.setAttribute('aria-label', 'Agent board');
  toggle.setAttribute('aria-pressed', 'false');
  toggle.title = 'Agent board: every session at a glance (⌘⇧B)';  // (written as the window's other shortcuts are: ⌘⇧I, ⌘⇧F)
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

  // The Dock's badge: sessions waiting on an answer from you. The Needs attention inbox
  // (code-attention.js) counts those and everything else waiting, and badges the Dock itself.
  function badge() {
    if (F.codeAttention && F.codeAttention.badges) return;
    const count = ccTasks.filter((x) => asksOf(x.id).length).length;
    if (count === B.badge) return;
    B.badge = count;
    if (app && app.feature) app.feature.send('feature:code-sessions:badge', count);
  }

  let drawn = '';  // what the board showed when last drawn
  // Each session's card as last drawn, by its session, with what it showed: a redraw keeps
  // the cards whose session hasn't changed and builds only the others. A busy session's
  // step changes its own card ten times a second, and every other card was built again
  // with it (thirty sessions: some four hundred elements an event).
  const drawnCards = new Map();  // task id -> { shows, card }
  let cardShows = new Map();  // task id -> what its card shows now (this draw's)
  function render() {
    const tasks = ccTasks;
    const locale = uiLocale();
    // Drawn anew only when what it shows has changed: the hub resends the task list up to ten
    // times a second while sessions work.
    cardShows = new Map(tasks.map((task) => {
      const meta = metaOf(task.id);
      const asks = asksOf(task.id);
      const figures = B.figures[String(task.id)] || {};
      const at = figures.updated || meta.updated;
      return [task.id, JSON.stringify([task.id, task.title, task.prompt, task.folder, task.status, task.busy, doing(task, asks[0]), (task.files_changed || []).length, task.cost_usd,
        meta.archived, meta.pinned, meta.group, asks.map((a) => [a.id, a.detail, a.choices]), figures.branch, figures.added, figures.removed, at, ago(at), shared().unread.has(task.id), locale])];
    }));
    const shows = JSON.stringify([B.showArchived, locale, [...cardShows.values()], extraLanes.map((lane) => { try { return lane.shows(); } catch { return null; } })]);
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
      // (The header is made anew each draw: a data-focus is how the keys find it again, U3.)
      arch.dataset.focus = 'board-archived';
      arch.addEventListener('click', () => { B.showArchived = !B.showArchived; render(); });
      tools.append(arch);
    }
    const x = el('button', 'jc-icon cs-board-close');
    x.type = 'button';
    x.dataset.focus = 'board-close';
    x.setAttribute('aria-label', 'Close the board');
    x.title = 'Close the board (Esc)';
    x.insertAdjacentHTML('beforeend', '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>');
    x.addEventListener('click', close);
    tools.append(x);
    head.append(title, tools);
    // Where the keys are, read before anything moves: a lane of another feature's (the to-do
    // column) is its own element, taken off the board as it's put in the new lanes, and the
    // focus goes with it to the page.
    const active = document.activeElement && board.contains(document.activeElement) ? document.activeElement : null;
    const focused = active ? active.dataset.focus : '';
    // The lanes stay on the board from one draw to the next, and in each only what changed is
    // put in: other features' lanes first (the to-do column), then a list of cards for each
    // column, its count, and "None" when it's empty. Nothing that stays the same leaves the
    // page, so the keys stay where they are and the lanes keep their scroll.
    const lanes = laneBox();
    const firsts = [];
    for (const lane of extraLanes) {
      try { firsts.push(lane.element()); } catch (err) { console.error('board lane', err); }
    }
    const order = [...firsts, ...COLUMNS.map(([id]) => columnLanes[id].lane)];
    // Put in order only when they aren't (the first draw, a lane another feature made anew).
    if (order.length !== lanes.children.length || order.some((node, at) => lanes.children[at] !== node)) {
      lanes.replaceChildren();
      for (const lane of extraLanes) {
        try { lanes.append(lane.element()); } catch (err) { console.error('board lane', err); }
      }
      lanes.append(...COLUMNS.map(([id]) => columnLanes[id].lane));
    }
    lanes.classList.toggle('cs-lanes-more', firsts.length > 0);
    B.lanes = COLUMNS.map(([id]) => columns[id].map((task) => task.id));
    // The one card in the Tab order: the one the keys were last on, else the first.
    const ids = B.lanes.flat();
    if (!ids.includes(B.focusId)) B.focusId = ids.length ? ids[0] : null;
    for (const [id] of COLUMNS) {
      const list = columns[id];
      const parts = columnLanes[id];
      setText(parts.count, String(list.length));
      // (An empty lane says so beside its list, not in it: a list holds only its items.)
      if (list.length && parts.empty.isConnected) parts.empty.remove();
      else if (!list.length && !parts.empty.isConnected) parts.lane.insertBefore(parts.empty, parts.cards);
      const now = list.map((task) => cardFor(task, id));
      if (now.length !== parts.cards.children.length || now.some((card, at) => parts.cards.children[at] !== card)) parts.cards.replaceChildren(...now);
    }
    if (shownHead && shownHead.parentNode === board) { board.insertBefore(head, shownHead); shownHead.remove(); } else board.prepend(head);
    shownHead = head;
    for (const id of drawnCards.keys()) if (!cardShows.has(id)) drawnCards.delete(id);  // (a session gone)
    // The same element when it's still there, else its namesake (a card drawn anew).
    if (active && document.activeElement === active) return;
    const again = active && board.contains(active) ? active : focused && board.querySelector(`[data-focus="${CSS.escape(focused)}"]`);
    if (again) again.focus();
  }

  // The board's lanes, made once: the box they're in and each column's lane, head, count,
  // empty line and list of cards ("Needs you, list, 2 items" to a screen reader).
  const columnLanes = {};
  let lanesBox = null;
  let shownHead = null;
  function laneBox() {
    if (lanesBox) {
      if (lanesBox.parentNode !== board) board.append(lanesBox);
      return lanesBox;
    }
    lanesBox = el('div', 'cs-lanes');
    lanesBox.addEventListener('keydown', onCardKey);
    for (const [id, label] of COLUMNS) {
      const lane = el('section', `cs-lane ${id}`);
      lane.setAttribute('aria-label', label);
      const lh = el('h2', 'cs-lane-head');
      lh.id = `cs-lane-${id}`;
      const count = el('span', 'cs-lane-count', '');
      lh.append(el('span', `cs-lane-dot ${id}`), el('span', '', label), count);
      const cards = el('div', 'cs-cards');
      cards.setAttribute('role', 'list');
      cards.setAttribute('aria-labelledby', lh.id);
      const empty = el('p', 'cs-lane-empty', id === 'needs' ? 'Nothing waiting on you.' : 'None');
      lane.append(lh, cards);
      columnLanes[id] = { lane, count, empty, cards };
    }
    board.append(lanesBox);
    return lanesBox;
  }
  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

  // A session's card: the one drawn before when it shows the same, else a new one. (Its
  // place in the Tab order is the board's, set each time.)
  function cardFor(task, col) {
    const shows = `${col} ${cardShows.get(task.id)}`;
    const kept = drawnCards.get(task.id);
    if (kept && kept.shows === shows) {
      kept.card.tabIndex = task.id === B.focusId ? 0 : -1;
      return kept.card;
    }
    const card = buildCard(task, col);
    drawnCards.set(task.id, { shows, card });
    return card;
  }

  function buildCard(task, col) {
    const meta = metaOf(task.id);
    const asks = asksOf(task.id);
    const figures = B.figures[String(task.id)] || {};
    const card = el('article', `cs-card ${col}`);
    card.dataset.task = task.id;
    card.dataset.focus = `${task.id}:card`;
    card.setAttribute('role', 'listitem');
    card.setAttribute('aria-label', cardSpeech(task, col, asks[0], figures, t));
    card.tabIndex = task.id === B.focusId ? 0 : -1;
    card.addEventListener('focus', () => { B.focusId = task.id; });
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

  // ── the keyboard alone ──

  function cardOf(id) { return board.querySelector(`.cs-card[data-task="${CSS.escape(String(id))}"]`); }
  function focusCard(id) {
    const card = cardOf(id);
    if (!card) return;
    for (const other of board.querySelectorAll('.cs-card[tabindex="0"]')) other.tabIndex = -1;
    card.tabIndex = 0;
    B.focusId = id;
    card.focus();
  }
  function onCardKey(e) {
    // A session's card only: the to-do lane's cards are .cs-card too, and 1 to 4 there would
    // press Start (a paid session) or Delete, or Enter open no session at all.
    const card = e.target.closest && e.target.closest('.cs-card[data-task]');
    if (!card || e.metaKey || e.ctrlKey || e.altKey) return;
    const id = Number(card.dataset.task);
    if (e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); F.selectTask(id); return; }
    if (/^[1-4]$/.test(e.key)) {
      const pressed = card.querySelectorAll('.cs-card-acts button')[Number(e.key) - 1];
      if (pressed) { e.preventDefault(); pressed.click(); }
      return;
    }
    const lane = B.lanes.findIndex((ids) => ids.includes(id));
    const to = lane < 0 ? null : moveIn(B.lanes, { lane, index: B.lanes[lane].indexOf(id) }, e.key);
    if (!to) return;
    e.preventDefault();
    focusCard(B.lanes[to.lane][to.index]);
  }

  // ⌥⌘↓ / ⌥⌘↑: the next or previous session, those that need you first, and where it is said.
  function boardOrder() {
    const columns = arrange(ccTasks, metaOf, (id) => asksOf(id).length, false);
    return COLUMNS.flatMap(([id]) => columns[id].map((task) => task.id));
  }
  document.addEventListener('keydown', (e) => {
    if ($('cc').hidden || !e.metaKey || !e.altKey || e.ctrlKey || e.shiftKey) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const current = F.currentTask();
    const to = nextSession(boardOrder(), current ? current.id : null, e.key === 'ArrowDown' ? 1 : -1);
    if (to === null || to === undefined) return;
    e.preventDefault();
    const task = ccTasks.find((x) => x.id === to);
    if (isOpen()) { focusCard(to); return; }  // on the board: its card (Enter opens it)
    F.selectTask(to);
    const a11y = root.jarvisAccessibility;
    if (task && a11y && a11y.announce) {
      const asks = asksOf(to);
      a11y.announce(cardSpeech(task, column(task, asks.length), asks[0], B.figures[String(to)] || {}, t));
    }
  });

  badge();
})(typeof window === 'object' ? window : globalThis);
