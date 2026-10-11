// Eden Code's split view: up to six sessions on screen at once, each live, with its own
// transcript, composer, status, Stop and approvals. The window's own pane is one of them; each
// other is this same window again in a frame (?pane=code: app.js inSplitPane, fed from this
// window's one connection: ?bridge=1, code-bridge.js) on one session, which leaves what a
// window does for the hub (the built-in browser, notifications, answering the hub's asks) to
// the window it's in. The panes are laid out by count (1; 2 side by side; 3 in a row; 4 as
// 2×2; 5–6 as 3×2, a fifth one wide) and fall back to fewer columns, then to one pane at a time
// with a switcher, when the window can't give each pane room. One pane has the focus (its head
// lit, its session marked in the sidebar): a session picked in the sidebar opens there, and
// what's typed goes there. ⌘⌥ and an arrow move the focus; ⌘1…⌘6 pick a pane.
//
// Ways in: a session's menu in the sidebar, dragging a session onto a pane (replaces it) or a
// pane's edge (adds one there), /split (/split close, off, swap, new, or a session's name),
// ⌘⇧\ (⌘\ is the sidebar's). The dividers drag (double-click: equal shares). The sessions (by
// their keys, which outlast a restart), the sizes and the focused pane are kept in prefs
// (features/code_split.py), so the split is back after a reload or a restart. Sessions' names
// are the user's: shown as data.
//
// This file is what every window loads: the pure helpers (exported for node --test,
// tests/web/code-split.test.mjs), a frame pane's side, and the window's doorway: /split, the
// keys, the menus and dragging. The window's machinery (the panes, their heads, the dividers)
// is code-split/window.js and .css, loaded the first time a split opens, so a window with one
// pane carries none of it.
(function codeSplit(root) {
  'use strict';

  // ── pure logic (tests/web/code-split.test.mjs) ──

  const MAX_PANES = 6;
  const MIN_PANE = 380;  // px wide a pane needs
  const MIN_PANE_H = 260;  // px tall
  const GAP = 8;  // px: a divider
  const FRAC_MIN = 0.05;  // a column's or row's share, at the least (code_split.py keeps the same)
  const MAX_COLS = 3;
  // The columns each count of panes starts from: 1; 2 side by side; 3 in a row; 2×2; 3×2.
  const COLUMNS = [1, 1, 2, 3, 2, 3, 3];

  // The grid n panes take in a room width × height px: the usual columns for n, else fewer,
  // else one pane at a time (one: true) when no grid gives each pane its room.
  function gridFor(n, width, height, min = MIN_PANE, minH = MIN_PANE_H, gap = GAP) {
    const count = Math.max(1, Math.min(MAX_PANES, Math.floor(Number(n)) || 1));
    if (count === 1) return { cols: 1, rows: 1, one: false };
    const w = Number(width);
    const h = Number(height);
    for (let cols = COLUMNS[count]; cols >= 1; cols -= 1) {
      const rows = Math.ceil(count / cols);
      if (w >= cols * min + (cols - 1) * gap && h >= rows * minH + (rows - 1) * gap) return { cols, rows, one: false };
    }
    return { cols: 1, rows: 1, one: true };
  }

  // Each pane's cell in a grid: row and column in reading order; the last pane takes what's
  // left of its row (a fifth pane under three is wide, never a hole).
  function cells(n, cols) {
    const out = [];
    for (let k = 0; k < n; k += 1) {
      const col = k % cols;
      out.push({ row: Math.floor(k / cols), col, span: k === n - 1 ? cols - col : 1 });
    }
    return out;
  }

  // Shares that add up to 1, one for each of count columns (or rows): equal when what's kept
  // isn't for that many.
  function cleanFracs(fracs, count) {
    const equal = Array.from({ length: count }, () => 1 / count);
    if (!Array.isArray(fracs) || fracs.length !== count || !fracs.every((f) => typeof f === 'number' && Number.isFinite(f) && f > 0)) return equal;
    const total = fracs.reduce((s, f) => s + f, 0);
    return fracs.map((f) => f / total);
  }

  // The shares kept where each part is at least min px of total px (gaps between them): equal
  // when even that can't be.
  function clampFracs(fracs, total, min = MIN_PANE, gap = GAP) {
    const count = fracs.length;
    const room = Number(total) - gap * (count - 1);
    if (!(room > 0)) return cleanFracs(fracs, count);
    const lo = Math.max(FRAC_MIN, min / room);
    if (lo * count > 1) return cleanFracs(null, count);
    const out = cleanFracs(fracs, count);
    const fixed = new Set();
    for (let round = 0; round < count; round += 1) {
      const under = out.map((f, i) => i).filter((i) => !fixed.has(i) && out[i] < lo);
      if (!under.length) break;
      for (const i of under) { out[i] = lo; fixed.add(i); }
      const free = out.map((f, i) => i).filter((i) => !fixed.has(i));
      const left = 1 - lo * fixed.size;
      const sum = free.reduce((s, i) => s + out[i], 0);
      for (const i of free) out[i] = sum > 0 ? (out[i] / sum) * left : left / free.length;
    }
    return out;
  }

  // Each pane's box (x, y, w, h: px from the room's corner) in a room width × height.
  function rects(n, grid, colFracs, rowFracs, width, height, gap = GAP) {
    if (grid.one) return Array.from({ length: n }, () => ({ x: 0, y: 0, w: width, h: height }));
    const cf = cleanFracs(colFracs, grid.cols);
    const rf = cleanFracs(rowFracs, grid.rows);
    const roomW = width - gap * (grid.cols - 1);
    const roomH = height - gap * (grid.rows - 1);
    const at = (fr, room, i) => fr.slice(0, i).reduce((s, f) => s + f, 0) * room + i * gap;
    const r2 = (v) => Math.round(v * 100) / 100;
    return cells(n, grid.cols).map(({ row, col, span }) => ({
      x: r2(at(cf, roomW, col)),
      y: r2(at(rf, roomH, row)),
      w: r2(cf.slice(col, col + span).reduce((s, f) => s + f, 0) * roomW + (span - 1) * gap),
      h: r2(rf[row] * roomH),
    }));
  }

  // The dividers of a grid: between columns (only as far down as panes meet there) and
  // between rows. Each: { kind: 'col' | 'row', index (the column or row after it), x, y, w, h }.
  function dividers(n, grid, colFracs, rowFracs, width, height, gap = GAP) {
    if (grid.one || n < 2) return [];
    const cf = cleanFracs(colFracs, grid.cols);
    const rf = cleanFracs(rowFracs, grid.rows);
    const roomW = width - gap * (grid.cols - 1);
    const roomH = height - gap * (grid.rows - 1);
    const at = (fr, room, i) => fr.slice(0, i).reduce((s, f) => s + f, 0) * room + i * gap;
    const lastRow = n - (grid.rows - 1) * grid.cols;  // panes in the last row
    const out = [];
    for (let b = 1; b < grid.cols; b += 1) {
      const rowsDown = b < lastRow ? grid.rows : grid.rows - 1;
      out.push({ kind: 'col', index: b, x: at(cf, roomW, b) - gap, y: 0, w: gap, h: rowsDown >= grid.rows ? height : at(rf, roomH, rowsDown) - gap });
    }
    for (let b = 1; b < grid.rows; b += 1) out.push({ kind: 'row', index: b, x: 0, y: at(rf, roomH, b) - gap, w: width, h: gap });
    return out;
  }

  // The shares after the divider before part b is dragged to pos px (along the room, from its
  // start): only the two parts beside it change, each kept at least min px.
  function dragFracs(fracs, b, pos, total, min = MIN_PANE, gap = GAP) {
    const out = fracs.slice();
    const room = total - gap * (out.length - 1);
    if (!(room > 0) || b < 1 || b >= out.length) return out;
    const lo = Math.max(FRAC_MIN, min / room);
    const before = out.slice(0, b - 1).reduce((s, f) => s + f, 0);
    const pair = out[b - 1] + out[b];
    if (pair < 2 * lo) return out;
    const share = (pos - (b - 1) * gap - gap / 2) / room - before;
    out[b - 1] = Math.min(pair - lo, Math.max(lo, share));
    out[b] = pair - out[b - 1];
    return out;
  }

  // Where a session dragged to (x, y) lands: { replace: i } (pane i shows it), { add: i, box,
  // side } (a new pane at place i, by the left or right edge of pane box), or null. A pane's
  // outer strips add one while there's room for one; with one pane, its right half does.
  function dropTarget(x, y, boxes, max = MAX_PANES, edge = 0.22) {
    const list = boxes || [];
    for (let i = 0; i < list.length; i += 1) {
      const b = list[i];
      if (!b || !(b.w > 0) || x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) continue;
      const rel = (x - b.x) / b.w;
      if (list.length >= max) return { replace: i };
      if (list.length === 1) return rel >= 0.5 ? { add: 1, box: 0, side: 'right' } : { replace: 0 };
      if (rel < edge) return { add: i, box: i, side: 'left' };
      if (rel > 1 - edge) return { add: i + 1, box: i, side: 'right' };
      return { replace: i };
    }
    return null;
  }

  // The pane the focus moves to from pane `from`, in a direction (left, right, up, down), by
  // where the boxes are; one pane at a time (one): the next or previous, round.
  function neighbor(boxes, from, dir, one = false) {
    const n = (boxes || []).length;
    if (n < 2 || from < 0 || from >= n) return from;
    if (one) return dir === 'right' || dir === 'down' ? (from + 1) % n : (from - 1 + n) % n;
    const c = (b) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
    const a = boxes[from];
    const ac = c(a);
    let best = from;
    let bestScore = Infinity;
    boxes.forEach((b, i) => {
      if (i === from) return;
      const bc = c(b);
      const dx = bc.x - ac.x;
      const dy = bc.y - ac.y;
      const ahead = { left: -dx, right: dx, up: -dy, down: dy }[dir];
      if (!(ahead > 1)) return;
      // Overlapping across the move (side by side, or one above the other) comes first.
      const overlap = dir === 'left' || dir === 'right'
        ? Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
        : Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const across = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
      const score = (overlap > 0 ? 0 : 1e6) + ahead + across * 2;
      if (score < bestScore) { bestScore = score; best = i; }
    });
    return best;
  }

  // A key or a backend's id as kept: printable, 64 at the most (code_split.py: _text).
  const text = (v) => (typeof v === 'string' && v.length <= 64 && !/[\u0000-\u001f\u007f-\u009f]/.test(v) ? v : '');
  // A kept pane's session: its id on the backend that kept it, and its key.
  function cleanPane(s) {
    const o = s && typeof s === 'object' ? s : {};
    return {
      id: Number.isInteger(o.id) && o.id > 0 && o.id < 2 ** 31 ? o.id : null,
      key: text(o.key),
    };
  }
  function cleanShares(value, most) {
    if (!Array.isArray(value) || !value.length || value.length > most) return [];
    if (!value.every((f) => typeof f === 'number' && Number.isFinite(f) && f > 0)) return [];
    const kept = value.map((f) => Math.max(FRAC_MIN, Math.min(1, f)));
    const total = kept.reduce((s, f) => s + f, 0);
    return kept.map((f) => Math.round((f / total) * 1e4) / 1e4);
  }
  const index = (v, n) => (Number.isInteger(v) && v >= 0 && v < n ? v : 0);

  // The split as prefs keep it (features/code_split.py), anything odd made safe. The two-pane
  // split of before ({ left, right, ratio, focus: 'left' | 'right' }) comes in as its panes.
  function cleanState(value) {
    const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    let panes;
    let cols;
    let focus = v.focus;
    if (Array.isArray(v.panes)) {
      panes = v.panes.slice(0, MAX_PANES).map(cleanPane);
      cols = cleanShares(v.cols, MAX_COLS);
    } else {
      const old = 'left' in v || 'right' in v || 'ratio' in v;
      panes = old && (v.left || v.right) ? [cleanPane(v.left), cleanPane(v.right)] : [];
      const ratio = typeof v.ratio === 'number' && Number.isFinite(v.ratio) ? Math.min(0.8, Math.max(0.2, v.ratio)) : 0.5;
      cols = old ? cleanShares([ratio, 1 - ratio], MAX_COLS) : [];
      focus = v.focus === 'right' ? 1 : 0;
    }
    const n = panes.length;
    return {
      on: v.on === true && n >= 2,
      panes,
      own: index(v.own, n),
      focus: index(focus, n),
      cols,
      rows: cleanShares(v.rows, MAX_PANES),
      hub: text(v.hub),
    };
  }

  // The session a kept pane means now: the one with its key (the same across restarts), else
  // its id, only on the backend that kept it (a restarted one numbers its sessions anew).
  function resolveSide(side, sameHub, ids, keyOf) {
    if (!side) return null;
    if (side.key) for (const id of ids) if (keyOf(id) === side.key) return id;
    return sameHub && side.id != null && ids.includes(side.id) ? side.id : null;
  }

  // The panes put back: each kept one's session now (resolve(pane) → id or null); the window's
  // own pane keeps its place, with its session or, gone, the one the window shows (here).
  // Panes whose session is gone, or on show already, are left out; fewer than two: no split.
  function restorePanes(state, resolve, here) {
    const kept = state.panes[state.own];
    const found = kept ? resolve(kept) : null;
    const ownId = found != null ? found : here;
    const list = [];
    const seen = new Set(ownId != null ? [ownId] : []);
    let focus = 0;
    state.panes.forEach((p, i) => {
      const own = i === state.own;
      const id = own ? ownId : resolve(p);
      if (!own && (id == null || seen.has(id))) return;
      seen.add(id);
      if (i === state.focus) focus = list.length;
      list.push({ id, own });
    });
    const ok = state.on && list.length >= 2 && list.some((x) => x.own);
    return { ok, panes: ok ? list : [], focus: ok ? focus : 0 };
  }

  // What /split's words ask for.
  function splitCommand(arg) {
    const word = String(arg || '').trim();
    const lower = word.toLowerCase();
    if (!word) return { action: 'open' };
    if (lower === 'close') return { action: 'close' };
    if (['off', 'stop', 'exit', 'end'].includes(lower)) return { action: 'off' };
    if (lower === 'swap') return { action: 'swap' };
    if (lower === 'new') return { action: 'new' };
    return { action: 'find', query: word };
  }

  // The session /split <words> means: its number (#12), its whole name, then the newest whose
  // name has the words in it; never one of `skip`.
  function findSession(tasks, query, skip = []) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return null;
    const pool = (tasks || []).filter((t) => !skip.includes(t.id));
    const number = /^#?\d+$/.test(q) ? Number(q.replace('#', '')) : null;
    const byNumber = number != null && pool.find((t) => t.id === number);
    if (byNumber) return byNumber.id;
    const named = (t) => String(t.title || t.prompt || '').trim().toLowerCase();
    const whole = pool.find((t) => named(t) === q);
    if (whole) return whole.id;
    const some = pool.filter((t) => named(t).includes(q)).sort((a, b) => b.id - a.id)[0];
    return some ? some.id : null;
  }

  // The sessions offered for an empty pane: not another pane's, not archived; the latest first.
  function pickable(tasks, others, metaOf) {
    const skip = Array.isArray(others) ? others : [others];
    const when = (t) => String((metaOf(t.id) || {}).updated || '');
    return (tasks || [])
      .filter((t) => !skip.includes(t.id) && !(metaOf(t.id) || {}).archived)
      .sort((a, b) => when(b).localeCompare(when(a)) || b.id - a.id);
  }

  // Where a session asked for goes while the split shows (a sidebar click, a new session, a
  // voice "show me…"): { focus: i } (pane i has it already: it takes the focus), { show: i }
  // (into pane i, the focused one), or null (the window's own pane, as without a split).
  function route(ids, ownAt, focus, id) {
    if (id == null) return null;
    const at = ids.indexOf(id);
    if (at >= 0) return at === ownAt ? null : { focus: at };
    return focus !== ownAt ? { show: focus } : null;
  }

  // Pane k went by itself (a fork, /clear, an Open somewhere in it) to session id, which pane j
  // shows: nothing is shown twice. The window's own pane keeps what it went to and j gets the
  // one it had (or, with none, j closes); a frame goes back to the one it had (or closes) and
  // j takes the focus. Null: nothing to fix.
  function afterChange(ids, ownAt, k, id, previous) {
    if (id == null) return null;
    const j = ids.findIndex((x, i) => i !== k && x === id);
    if (j < 0) return null;
    const free = previous != null && previous !== id && !ids.includes(previous);
    if (k === ownAt) return free ? { pane: j, show: previous } : { close: j };
    return free ? { pane: k, show: previous, focus: j } : { close: k, focus: j };
  }

  // The mark on an unfocused pane's head: an answer it waits for beats news since you looked.
  function paneMark(asks, fresh) {
    return asks > 0 ? 'needs' : fresh ? 'new' : '';
  }

  // The split's keys: ⌘⇧\ adds a pane ('split'); ⌘\ is the sidebar's ('side', forwarded from
  // a frame); ⌘⌥ and an arrow move the focus ('move-left'…); ⌘1…⌘6 pick a pane ('pane-1'…).
  function keyAction(e) {
    if (!e || !e.metaKey || e.ctrlKey) return null;
    if (e.altKey) {
      if (e.shiftKey) return null;
      const dir = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }[e.key];
      return dir ? `move-${dir}` : null;  // (⌥⌘\ is Logbook's margin)
    }
    if (e.code === 'Backslash' || e.key === '\\' || e.key === '|') return e.shiftKey ? 'split' : 'side';
    if (e.shiftKey) return null;
    const digit = /^Digit([1-6])$/.exec(e.code || '') || /^([1-6])$/.exec(e.key || '');
    return digit ? `pane-${digit[1]}` : null;
  }

  // (CF2-7) Where a split key goes: ⌘1–6 are the built-in browser's tabs while it's open
  // ('browser-tab3'), from a frame pane as from the window's own; typed in a field, nowhere
  // (null: the field keeps them, as the window's own do). Every other key is the split's.
  function keyTarget(act, browserOpen, typing) {
    if (!act || !act.startsWith('pane-') || !browserOpen) return act;
    return typing ? null : `browser-tab${act.slice(5)}`;
  }

  const api = {
    MAX_PANES, MIN_PANE, MIN_PANE_H, GAP, FRAC_MIN, MAX_COLS, gridFor, cells, cleanFracs, clampFracs, rects,
    dividers, dragFracs, dropTarget, neighbor, cleanState, resolveSide, restorePanes, splitCommand,
    findSession, pickable, route, afterChange, paneMark, keyAction, keyTarget,
  };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  const F = root.jarvisFeatures;
  if (!F || !F.registerSplit) return;

  const HELP = 'Split view: up to 6 sessions side by side · /split close';
  const KEY = '⌘⇧\\';
  const named = (task) => (task ? String(task.title || task.prompt || '') : '');
  if (typeof JC_KEYS !== 'undefined') {  // (what ? lists)
    for (const [key, help] of [[KEY, 'Split view: add a pane'], ['⌘⌥←→↑↓', 'Split view: move between panes'], ['⌘1–6', 'Split view: go to a pane']]) {
      if (!JC_KEYS.some(([k]) => k === key)) JC_KEYS.push([key, help]);
    }
  }

  if (F.splitPane) paneSide(); else doorway();

  // ── a frame pane: this window in a frame, on the session the window asks for ──

  function paneSide() {
    const host = root.parent;
    const tell = (msg) => { try { host.postMessage({ sv: 1, ...msg }, location.origin); } catch (_) { /* the window went */ } };
    const P = { want: null, others: [], focused: false };  // want: { id, hub }; others: the other panes' sessions
    // With no session yet: the sessions to open here, above the welcome's own (renderPicker).
    const pick = el('div', 'jc-card sv-pick');
    pick.hidden = true;
    const list = el('ul', 'sv-pick-list');
    pick.append(el('p', 'jc-label', 'Open a session here'), list);
    $('cc-welcome').insertBefore(pick, $('cc-past-wrap'));

    toggleCC(true);
    // A session asked for on a backend this frame hasn't heard from yet waits for its hello.
    function apply() {
      const w = P.want;
      if (!w || (w.hub && w.hub !== hubId)) return;
      if (ccSelected !== w.id) selectTask(w.id);
    }
    root.addEventListener('message', (e) => {
      const m = e.data;
      if (e.source !== host || e.origin !== location.origin || !m || m.sv !== 1) return;
      if (m.inApp !== undefined) document.body.classList.toggle('sv-app', !!m.inApp);
      if (m.focused !== undefined) P.focused = !!m.focused;
      if (Array.isArray(m.others)) P.others = m.others;
      if (m.project && ccSelected == null && m.project !== deckProject) selectProject(m.project);
      if (m.show !== undefined && m.show !== null) { P.want = { id: m.show, hub: m.hub || null }; apply(); }
      if (m.resume && m.resume.folder && m.resume.session_id) resumeSession(m.resume.folder, m.resume);
      if (m.start) { if (m.start !== deckProject) selectProject(m.start); newSession(false); }
      if (m.place) { const input = $('deck-input'); if (input) input.focus(); }
      renderPicker();
    });
    F.on('hello', () => { apply(); renderPicker(); }, { replay: true });
    F.on('jc_select', ({ id, previous }) => {
      P.want = id == null ? null : { id, hub: hubId };
      tell({ selected: id, previous });
      renderPicker();
    });
    // Another module's "open that session": the window decides which pane shows it.
    F.selectTask = (id) => tell({ route: id });
    // A hand or a key in here gives this pane the focus.
    const claim = () => { if (!P.focused) { P.focused = true; tell({ focus: true }); } };
    document.addEventListener('pointerdown', claim, true);
    document.addEventListener('keydown', claim, true);
    root.addEventListener('keydown', (e) => {
      const act = keyAction(e);
      if (!act) return;
      e.preventDefault();
      e.stopImmediatePropagation();  // (⌘\ here would fold this frame's own hidden sidebar)
      P.focused = true;
      const typing = !!document.activeElement && /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
      tell({ focus: true, key: act, typing });
    }, true);
    // The built-in browser docks in the window.
    const browserBtn = $('jc-browser');
    if (browserBtn) browserBtn.addEventListener('click', (e) => { e.stopImmediatePropagation(); tell({ browser: true }); }, true);
    F.registerSlash({ name: 'split', help: HELP, withoutSession: true, run(arg) { tell({ command: arg || '' }); return true; } });
    F.registerMoreItem({ label: 'Swap with the next pane', run: () => tell({ command: 'swap' }) });
    F.registerMoreItem({ label: 'Close this pane', run: () => tell({ command: 'close' }) });
    F.registerMoreItem({ label: 'Close split view', note: 'Keep only this session', run: () => tell({ command: 'off' }) });

    function renderPicker() {
      const S = F.codeSessions;
      const metaOf = (id) => (S && S.meta.get(id)) || {};
      const items = ccSelected == null ? pickable(ccTasks, P.others, metaOf).slice(0, 8) : [];
      pick.hidden = !items.length;
      const key = JSON.stringify(items.map((x) => [x.id, named(x), x.folder, statusOf(x)]));
      if (pick.dataset.key === key) return;
      pick.dataset.key = key;
      list.replaceChildren(...items.map((x) => {
        const b = el('button', 'sv-pick-row');
        b.type = 'button';
        b.append(el('span', `jc-dot ${statusOf(x)}`), named(x) ? mine(el('span', 'sv-pick-title', named(x))) : el('span', 'sv-pick-title', 'New session'), mine(el('small', '', x.folder)));
        b.addEventListener('click', () => selectTask(x.id));
        const li = el('li');
        li.append(b);
        return li;
      }));
    }
    for (const type of ['tasks', 'code_meta']) F.on(type, () => renderPicker());

    // The window moves this pane's session to another pane, or closes this one: its unsent
    // words and files go along (and the hub keeps the words).
    root.jarvisSplitPane = {
      park() {
        const id = ccSelected;
        if (id == null) return null;
        const text = $('deck-input').value;
        const held = attachments.slice();
        const S = F.codeSessions;
        if (S) {
          S.drafts.set(id, text);
          if ((S.kept.get(id) || '') !== text && F.send({ type: 'code_draft', id, text })) S.kept.set(id, text);
        }
        return { id, text, held };
      },
    };
    tell({ ready: true });
  }

  // ── the window: the doorway; the machinery (code-split/window.js) comes on first use ──

  function doorway() {
    let M = null;  // the machinery, once loaded
    let loading = null;
    const base = (() => {
      const me = document.currentScript && document.currentScript.src;
      return me ? me.replace(/code-split\.js(\?.*)?$/, 'code-split/') : '/static/features/code-split/';
    })();
    // This file's ?v= stamp, passed on (server.feature_assets makes it the newest of this file
    // and its folder's): kept by the window's cache, not asked about again at every load.
    const stamp = (() => {
      const me = document.currentScript && document.currentScript.src;
      const m = me ? /[?&](v=\d+)/.exec(me) : null;
      return m ? `?${m[1]}` : '';
    })();
    function load() {
      if (loading) return loading;
      loading = new Promise((resolve) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = `${base}window.css${stamp}`;
        document.head.append(link);
        const script = document.createElement('script');
        script.src = `${base}window.js${stamp}`;
        script.onload = () => {
          try { M = root.jarvisSplitWindow ? root.jarvisSplitWindow(api, { HELP, KEY, named }) : null; } catch (err) { console.error('split view', err); M = null; }
          resolve(M);
        };
        script.onerror = () => { console.error('split view failed to load'); loading = null; resolve(null); };
        document.body.append(script);
      });
      return loading;
    }
    const later = (fn) => (M ? fn(M) : load().then((m) => { if (m) fn(m); }));
    root.jarvisSplitLoad = load;  // (the tests' and a module's way to have it ready)

    // What the split shows, for other modules (code-logbook.js: the index's pane marks).
    F.splitState = () => (M ? M.state() : { on: false, right: null, focus: 'left', panes: [], own: 0 });

    // Kept on: the machinery comes at once and puts it back (it hears the hello itself).
    F.on('hello', (ev) => {
      const kept = cleanState(ev && ev.prefs && ev.prefs.features && ev.prefs.features.code_split);
      if (kept.on && !M) load();
    }, { replay: true });

    const S0 = F.codeSessions || null;
    if (S0 && S0.rowItems) {
      S0.rowItems.push((id) => {
        if (M) return M.rowItem(id);
        if (id === ccSelected) return { label: 'Open in split view', note: 'Open here already', disabled: true };
        return { label: 'Open in split view', key: KEY, run: () => later((m) => m.add(id)) };
      });
    }
    F.registerSlash({ name: 'split', help: HELP, withoutSession: true, run(arg) { later((m) => m.command(arg)); return true; } });
    F.registerMoreItem({ label: 'Split view', note: 'Another session beside this one', key: KEY, when: () => !(M && M.on()), run: () => later((m) => m.add(null)) });
    document.addEventListener('keydown', (e) => {
      if ($('cc').hidden) return;
      const act = keyAction(e);
      if (!act || act === 'side') return;
      // ⌘1…9 are the built-in browser's tabs while it's open; the moves are only for a split.
      if (act !== 'split' && (!M || !M.on() || (act.startsWith('pane-') && typeof browserOpenNow !== 'undefined' && browserOpenNow))) return;
      e.preventDefault();
      later((m) => m.key(act));
    });

    // Dragging a session from the sidebar: onto a pane (or, without a split, the left half)
    // shows it there; onto a pane's edge (or the right half) adds a pane for it.
    function decorateRows() {
      for (const row of $('deck-project-list').querySelectorAll('.jc-session[data-task], .jc-session.past[data-session]')) {
        if (row.dataset.svDrag) continue;
        row.dataset.svDrag = '1';
        row.draggable = true;
        row.addEventListener('dragstart', (e) => {
          const what = row.dataset.task ? { task: Number(row.dataset.task) } : { session: row.dataset.session };
          e.dataTransfer.effectAllowed = 'copyMove';
          const title = row.querySelector('.jc-stitle');
          e.dataTransfer.setData('text/plain', title ? title.textContent : '');
          later((m) => m.dragStart(what));
        });
        row.addEventListener('dragend', () => { if (M) M.dragEnd(); });
      }
    }
    new MutationObserver(decorateRows).observe($('deck-project-list'), { childList: true, subtree: true });
    decorateRows();
  }
})(typeof window === 'object' ? window : globalThis);
