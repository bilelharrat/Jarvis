// Eden Code's to-do column on the agent board (features/code_todo.py, code_queue.py): cards
// written ahead for a project (a title, the prompt a session starts with, and how it starts:
// a model or the Model Router's pick, a mode, an isolated copy, the cloud), first in the
// board's lanes. Drag a card up or down to reorder it (or its ↑ ↓ buttons), drag it onto
// any other lane or press Start to start it; it then links to the session it started. A card
// can come from a GitHub issue's address. With the routing queue on in Labs, "Run my queue"
// starts the project's cards one or more at a time, each on the cheapest model that passed
// Eden's checks there, within a dollar ceiling.
// The editors are modal dialogs (the board redraws under them as sessions work). Its pure
// logic is exported for node's tests.
(function codeTodo(root) {
  'use strict';

  const MODE_NAMES = { plan: 'Plan', ask: 'Manual', edits: 'Accept edits', smart: 'Auto', auto: 'Bypass permissions' };
  const OUTSIDE_MODES = ['plan', 'ask', 'edits'];  // what a card from an issue may start in
  const STATE_NAMES = {
    todo: 'To do', queued: 'In the queue', running: 'Running', started: 'Started',
    done: 'Done', failed: 'Checks failed', stopped: 'Stopped',
  };
  const ISSUE = /^https:\/\/(?:www\.)?github\.com\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/(?:issues|pull)\/\d{1,9}\/?(?:[#?].*)?$/;

  // A project's cards, in the owner's order.
  function cardsFor(cards, folder) {
    return (cards || []).filter((c) => c.folder === folder);
  }

  // The project's card ids once one is moved to index (what todo_move does).
  function moved(ids, id, index) {
    const out = ids.filter((x) => x !== id);
    if (out.length === ids.length) return ids.slice();
    out.splice(Math.max(0, Math.min(index, out.length)), 0, id);
    return out;
  }

  // Where a card stands, in words: its state, and for a queued one how its checks went.
  function stateLabel(card) {
    const base = STATE_NAMES[card.state] || STATE_NAMES.todo;
    if (card.state === 'done' && card.verified === true) return 'Done · checks passed';
    if (card.state === 'done' && card.attempts && card.attempts.length && card.verified !== true) return 'Done · nothing to check';
    return base;
  }

  // A queued card's tries: "Haiku 4.5 ✗ → Sonnet 5.5 ✓" (names from the model list).
  function attemptsLine(card, nameOf = (ref) => ref) {
    const tries = (card.attempts || []).filter((a) => a && a.model);
    if (!tries.length) return '';
    const mark = (o) => (o === true ? ' ✓' : o === false ? ' ✗' : '');
    return tries.map((a) => `${nameOf(a.model)}${mark(a.outcome)}`).join(' → ');
  }

  const money = (v) => `$${(Number(v) || 0).toFixed(2)}`;

  // The queue's line under the lane's head.
  function queueLine(q) {
    if (!q) return '';
    if (q.on) {
      const at = q.parallel > 1 ? `${q.parallel} at a time` : 'one at a time';
      const line = `Queue running, ${at}: ${money(q.spent)} of ${money(q.ceiling)}`;
      return q.note ? `${line}. ${q.note}` : line;
    }
    return q.note || '';
  }

  const issueAddress = (text) => ISSUE.test(String(text || '').trim());

  // Where a card's link goes: the open session, else its Claude Code session to reopen.
  function sessionLink(card, tasks) {
    if (card.task != null && (tasks || []).some((t) => t.id === card.task)) return { open: card.task };
    if (card.session) return { resume: card.session };
    return null;
  }

  // The project the lane shows: the one chosen, else the open session's, else the first
  // with cards, else the first.
  function projectFor(projects, cards, chosen, current) {
    const paths = (projects || []).map((p) => p.path);
    if (chosen && (paths.includes(chosen) || (cards || []).some((c) => c.folder === chosen))) return chosen;
    if (current && paths.includes(current)) return current;
    const withCards = paths.find((p) => (cards || []).some((c) => c.folder === p));
    return withCards || paths[0] || ((cards || [])[0] || {}).folder || '';
  }

  const api = { cardsFor, moved, stateLabel, attemptsLine, queueLine, issueAddress, sessionLink, projectFor, MODE_NAMES, OUTSIDE_MODES };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  const F = root.jarvisFeatures;
  if (!F || !F.codeBoard) return;

  const t = (text) => F.t(text);
  const T = { cards: [], queues: {}, queueOn: false, projects: [], folder: '', error: '' };
  const DRAG = 'application/x-eden-todo';
  const models = () => (typeof modelList !== 'undefined' ? modelList : []);
  const nameOf = (ref) => { const m = models().find((x) => x.ref === ref); return m ? (m.label || m.name || ref) : ref; };
  const tasksNow = () => (typeof ccTasks !== 'undefined' ? ccTasks : []);
  const own = (node) => { node.setAttribute('data-no-i18n', ''); return node; };  // the owner's words

  const lane = F.el('section', 'cs-lane todo ct-lane');
  lane.setAttribute('aria-label', 'To do');

  function button(label, cls, run, focus, aria) {
    const b = F.el('button', `jc-btn small ${cls}`, label);
    b.type = 'button';
    if (focus) b.dataset.focus = `todo:${focus}`;
    if (aria) b.setAttribute('aria-label', aria);
    b.addEventListener('click', (e) => { e.stopPropagation(); run(); });
    return b;
  }

  function folderName(folder) {
    const p = T.projects.find((x) => x.path === folder);
    return p ? p.name : String(folder || '').split('/').filter(Boolean).pop() || '';
  }

  function currentFolder() {
    const task = F.currentTask && F.currentTask();
    return task && task.path && !(task.workspace && task.workspace.slug) ? task.path : '';
  }

  // ── the lane ──

  let dragging = false;  // (the lane isn't redrawn under a card being dragged)
  function draw() {
    if (dragging) return;
    T.folder = projectFor(T.projects, T.cards, T.folder, currentFolder());
    const mine = cardsFor(T.cards, T.folder);
    const waiting = mine.filter((c) => c.state === 'todo' || c.state === 'queued');
    const head = F.el('h2', 'cs-lane-head');
    head.append(F.el('span', 'cs-lane-dot todo'), F.el('span', '', 'To do'), F.el('span', 'cs-lane-count', String(waiting.length)));
    const tools = F.el('div', 'ct-tools');
    const pick = F.el('select', 'ct-project');
    pick.setAttribute('aria-label', t('Project'));
    pick.dataset.focus = 'todo:project';
    const folders = [...new Set([...T.projects.map((p) => p.path), ...T.cards.map((c) => c.folder)])];
    for (const folder of folders) {
      const o = own(F.el('option', '', folderName(folder)));
      o.value = folder;
      o.selected = folder === T.folder;
      pick.append(o);
    }
    pick.disabled = !folders.length;
    pick.addEventListener('change', () => { T.folder = pick.value; draw(); });
    tools.append(pick);
    const adds = F.el('div', 'ct-adds');
    adds.append(
      button('New card', 'tinted', () => editCard(null), 'new'),
      button('From issue…', '', () => fromIssue(), 'issue', t('New card from a GitHub issue')),
    );
    const q = T.queues[T.folder];
    const queueRow = [];
    if (T.queueOn && T.folder) {
      const row = F.el('div', 'ct-queue');
      if (q && q.on) row.append(button('Stop the queue', 'danger', () => F.send({ type: 'todo_queue_stop', directory: T.folder }), 'qstop'));
      else row.append(button('Run my queue…', 'filled', () => runQueue(), 'qrun'));
      queueRow.push(row);
    }
    const said = F.el('p', 'ct-queue-line');
    said.setAttribute('role', 'status');
    said.textContent = queueLine(q);
    const problem = F.el('p', 'ct-error');
    problem.setAttribute('role', 'alert');
    problem.textContent = T.error;
    problem.hidden = !T.error;
    // A list (a name on a plain div is never read), its cards the items; an empty one says so
    // beside it.
    const list = F.el('div', 'cs-cards ct-cards');
    list.setAttribute('role', 'list');
    list.setAttribute('aria-label', t('Cards to do'));
    const empty = mine.length ? [] : [F.el('p', 'cs-lane-empty', T.folder ? 'Write the next thing to do here.' : 'Open a project first.')];
    mine.forEach((card, n) => list.append(cardEl(card, n, mine.length)));
    list.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer && e.dataTransfer.types) || []].includes(DRAG)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
    });
    list.addEventListener('drop', (e) => {
      const id = e.dataTransfer && e.dataTransfer.getData(DRAG);
      if (!id) return;
      e.preventDefault();
      e.stopPropagation();
      const over = e.target.closest('.ct-card');
      const ids = mine.map((c) => c.id);
      let index = over ? ids.indexOf(over.dataset.card) : ids.length - 1;
      if (over && e.clientY > over.getBoundingClientRect().top + over.offsetHeight / 2) index += 1;
      if (ids.indexOf(id) < index) index -= 1;  // (its own place goes when it leaves)
      F.send({ type: 'todo_move', id, index: Math.max(0, index) });
    });
    const keep = lane.contains(document.activeElement) ? document.activeElement.dataset.focus : '';
    lane.replaceChildren(head, tools, adds, ...queueRow, said, problem, ...empty, list);
    const again = keep && lane.querySelector(`[data-focus="${CSS.escape(keep)}"]`);
    if (again) again.focus();
  }

  function cardEl(card, n, count) {
    const el = F.el('article', `cs-card ct-card ${card.state}`);
    el.dataset.card = card.id;
    const running = card.state === 'running' || card.state === 'queued';
    el.draggable = !running;
    el.setAttribute('role', 'listitem');
    el.setAttribute('aria-label', card.title);
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(DRAG, card.id);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('ct-dragging');
      dragging = true;
    });
    el.addEventListener('dragend', () => { el.classList.remove('ct-dragging'); dragging = false; draw(); });
    const top = F.el('div', 'cs-card-top');
    top.append(F.el('span', `jc-dot ${card.state === 'running' ? 'ct-run' : card.state === 'failed' ? 'failed' : 'todo'}`), own(F.el('h3', 'cs-card-title', card.title)));
    const meta = F.el('p', 'cs-card-project ct-meta');
    const bits = [card.model ? nameOf(card.model) : t('Model Router'), t(MODE_NAMES[card.mode] || 'Default mode')];
    if (card.isolated === true) bits.push(t('Isolated copy'));
    if (card.cloud) bits.push(t('Cloud'));
    meta.textContent = bits.join(' · ');
    const parts = [top, meta];
    if (card.issue) {
      const from = F.el('p', 'cs-card-project ct-from');
      from.append(document.createTextNode(`${t('From GitHub')} · `), own(F.el('span', '', `${card.issue.repo}#${card.issue.number}`)));
      from.title = t('Its text was written on GitHub: Eden treats it as data, and it never starts in Auto or Bypass.');
      parts.push(from);
    }
    const state = F.el('p', 'cs-card-doing ct-state', stateLabel(card));
    parts.push(state);
    const tries = attemptsLine(card, nameOf);
    if (tries) parts.push(own(F.el('p', 'cs-card-stats ct-tries', tries)));
    if (card.cost) parts.push(F.el('p', 'cs-card-stats', money(card.cost)));
    const acts = F.el('div', 'cs-card-acts');
    const link = sessionLink(card, tasksNow());
    if (!running) acts.append(button(card.state === 'todo' ? 'Start' : 'Start again', card.state === 'todo' ? 'filled' : '', () => start(card), `${card.id}:start`, `${t('Start')}: ${card.title}`));
    if (link) acts.append(button('Open session', 'tinted', () => openSession(card, link), `${card.id}:open`));
    if (!running) {
      acts.append(button('Edit', '', () => editCard(card), `${card.id}:edit`, `${t('Edit')}: ${card.title}`));
      if (n > 0) acts.append(button('↑', 'ct-move', () => F.send({ type: 'todo_move', id: card.id, index: n - 1 }), `${card.id}:up`, t('Move up')));
      if (n < count - 1) acts.append(button('↓', 'ct-move', () => F.send({ type: 'todo_move', id: card.id, index: n + 1 }), `${card.id}:down`, t('Move down')));
      acts.append(button('Delete', 'danger', () => remove(card), `${card.id}:delete`, `${t('Delete')}: ${card.title}`));
    }
    el.append(...parts, acts);
    return el;
  }

  function start(card) {
    const route = !card.model && !card.cloud && F.codeRouter ? F.codeRouter.pick(card.prompt) : null;
    F.send(route ? { type: 'todo_start', id: card.id, route } : { type: 'todo_start', id: card.id });
  }

  function openSession(card, link) {
    if (link.open != null) F.selectTask(link.open);
    else F.send({ type: 'task_new', directory: card.folder, session_id: link.resume });
  }

  function remove(card) {
    if (!confirm(t('Delete this card? Its session, if it started one, stays.'))) return;
    F.send({ type: 'todo_delete', id: card.id });
  }

  // A card dropped on any of the board's other lanes starts.
  const board = F.codeBoard.board;
  board.addEventListener('dragover', (e) => {
    const target = e.target.closest('.cs-lane');
    if (!target || target === lane || ![...(e.dataTransfer.types || [])].includes(DRAG)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    for (const l of board.querySelectorAll('.ct-drop')) if (l !== target) l.classList.remove('ct-drop');
    target.classList.add('ct-drop');
  });
  board.addEventListener('dragleave', (e) => { const l = e.target.closest('.cs-lane'); if (l && !l.contains(e.relatedTarget)) l.classList.remove('ct-drop'); });
  board.addEventListener('drop', (e) => {
    const target = e.target.closest('.cs-lane');
    for (const l of board.querySelectorAll('.ct-drop')) l.classList.remove('ct-drop');
    const id = e.dataTransfer.getData(DRAG);
    if (!target || target === lane || !id) return;
    e.preventDefault();
    const card = T.cards.find((c) => c.id === id);
    if (card) start(card);
  });

  // ── the dialogs ──

  function dialog(title, build, save, saveLabel) {
    const d = F.el('dialog', 'ct-dialog');
    d.setAttribute('role', 'dialog');  // (the board's Esc leaves it to the dialog)
    const form = F.el('form', 'ct-form');
    form.method = 'dialog';
    const h = F.el('h2', 'ct-dialog-title', title);
    h.id = `ct-title-${Date.now()}`;
    d.setAttribute('aria-labelledby', h.id);
    const body = F.el('div', 'ct-fields');
    build(body);
    const acts = F.el('div', 'ct-dialog-acts');
    const cancel = F.el('button', 'jc-btn', 'Cancel');
    cancel.type = 'button';
    const ok = F.el('button', 'jc-btn filled', saveLabel);
    ok.type = 'submit';
    acts.append(cancel, ok);
    form.append(h, body, acts);
    d.append(form);
    const done = () => { if (d.open) d.close(); d.remove(); };
    cancel.addEventListener('click', done);
    d.addEventListener('close', () => d.remove());
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (save(body) !== false) done();
    });
    (F.$('cc') || document.body).append(d);  // (inside Eden Code: its look's colors)
    if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', '');
    const first = body.querySelector('input, textarea, select');
    if (first) first.focus();
    return d;
  }

  function field(body, label, control, note) {
    const wrap = F.el('label', 'ct-field');
    wrap.append(F.el('span', 'ct-label', label), control);
    if (note) wrap.append(F.el('span', 'ct-note', note));
    body.append(wrap);
    return control;
  }

  function select(options, value) {
    const s = F.el('select', 'ct-input');
    for (const [v, label, words] of options) {
      const o = F.el('option', '', label);
      if (words) own(o);
      o.value = v;
      o.selected = v === value;
      s.append(o);
    }
    return s;
  }

  function editCard(card) {
    if (!T.folder) return;
    const was = card || { title: '', prompt: '', model: '', mode: '', isolated: null, cloud: false };
    let title, prompt, model, mode, isolated, cloud;
    dialog(card ? t('Edit the card') : `${t('New card for')} ${folderName(T.folder)}`, (body) => {
      title = field(body, t('Title'), F.el('input', 'ct-input'));
      title.value = was.title || '';
      title.maxLength = 120;
      title.placeholder = t('Optional: the prompt’s first line');
      prompt = field(body, t('What should the session do?'), F.el('textarea', 'ct-input ct-prompt'));
      prompt.value = was.prompt || '';
      prompt.required = true;
      prompt.rows = 6;
      const choices = [['', t('Model Router’s pick, or your default')], ...models().filter((m) => m.ref).map((m) => [m.ref, m.label || m.name || m.ref, true])];
      model = field(body, t('Model'), select(choices, was.model || ''));
      const modes = (card && card.untrusted ? OUTSIDE_MODES : Object.keys(MODE_NAMES)).map((m) => [m, t(MODE_NAMES[m])]);
      mode = field(body, t('Mode'), select(card && card.untrusted ? modes : [['', t('Your default')], ...modes], was.mode || ''),
        card && card.untrusted ? t('From GitHub: never Auto or Bypass.') : '');
      isolated = field(body, t('Where'), select([['', t('Your default')], ['yes', t('In an isolated copy')], ['no', t('In the project folder')]],
        was.isolated === true ? 'yes' : was.isolated === false ? 'no' : ''));
      cloud = F.el('input', 'ct-check');
      cloud.type = 'checkbox';
      cloud.checked = Boolean(was.cloud);
      field(body, t('On the cloud machine'), cloud);
    }, () => {
      if (!prompt.value.trim()) { prompt.focus(); return false; }
      const settings = {
        title: title.value, prompt: prompt.value, model: model.value, mode: mode.value,
        isolated: isolated.value === 'yes' ? true : isolated.value === 'no' ? false : null, cloud: cloud.checked,
      };
      F.send(card ? { type: 'todo_edit', id: card.id, ...settings } : { type: 'todo_add', directory: T.folder, ...settings });
      return true;
    }, card ? 'Save' : 'Add card');
  }

  function fromIssue() {
    if (!T.folder) return;
    let url;
    dialog(t('New card from a GitHub issue'), (body) => {
      url = field(body, t('The issue’s address'), F.el('input', 'ct-input'),
        t('Its title and text become the card; Eden treats them as data, since anyone can write an issue.'));
      url.type = 'url';
      url.placeholder = 'https://github.com/owner/repo/issues/12';
    }, () => {
      if (!issueAddress(url.value)) { url.setCustomValidity(t('Paste a GitHub issue’s address.')); url.reportValidity(); url.setCustomValidity(''); return false; }
      F.send({ type: 'todo_from_issue', directory: T.folder, url: url.value.trim() });
      return true;
    }, 'Add card');
  }

  function runQueue() {
    const q = T.queues[T.folder] || {};
    let parallel, ceiling;
    dialog(`${t('Run the queue for')} ${folderName(T.folder)}`, (body) => {
      body.append(F.el('p', 'ct-note', t('Each card goes to the cheapest model that passed Eden’s checks in this project (else the Model Router’s pick); one whose checks fail moves up to a stronger model. Your spending limits still hold.')));
      parallel = field(body, t('Cards at once'), select([1, 2, 3, 4].map((n) => [String(n), String(n)]), String(q.parallel || 1)));
      ceiling = field(body, t('Spend at most (US dollars, for the whole queue)'), F.el('input', 'ct-input'));
      ceiling.type = 'number';
      ceiling.min = '0.05';
      ceiling.max = '1000';
      ceiling.step = '0.5';
      ceiling.value = String(q.ceiling || 5);
    }, () => {
      const usd = Number(ceiling.value);
      if (!Number.isFinite(usd) || usd <= 0) { ceiling.focus(); return false; }
      const routes = {};
      for (const card of cardsFor(T.cards, T.folder)) {
        if (card.state !== 'todo' || card.model || card.cloud || !F.codeRouter) continue;
        const route = F.codeRouter.pick(card.prompt);
        if (route) routes[card.id] = route;
      }
      F.send({ type: 'todo_queue_run', directory: T.folder, parallel: Number(parallel.value), ceiling: usd, routes });
      return true;
    }, 'Run my queue');
  }

  // ── what the backend says ──

  F.on('todo_state', (ev) => {
    T.cards = ev.cards || [];
    T.queues = ev.queues || {};
    T.queueOn = ev.queue === true;
    T.error = '';
    if (ev.added) { const c = T.cards.find((x) => x.id === ev.added); if (c) T.folder = c.folder; }
    draw();
  });
  F.on('todo_error', (ev) => { T.error = String(ev.text || ''); draw(); });
  F.on('claude_projects', (ev) => { T.projects = (ev.items || []).map((p) => ({ name: p.name, path: p.path })); draw(); }, { replay: true });
  F.on('hello', () => F.send({ type: 'todo_state' }), { replay: true });
  for (const type of ['tasks', 'task_finished']) F.on(type, () => { if (F.codeBoard.isOpen()) drawSoon(); });
  let soon = 0;
  function drawSoon() { if (!soon) soon = setTimeout(() => { soon = 0; draw(); }, 400); }

  F.codeBoard.addLane({ shows: () => 'todo', element: () => lane });
  draw();
})(typeof window === 'object' ? window : globalThis);
