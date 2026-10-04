// Jarvis Code's split view: two sessions side by side in the window, each live, with its own
// transcript, composer, status, Stop and approvals. The left pane is the window's own; the
// right one is this same window again in a frame (?pane=code: app.js inSplitPane) on one
// session, which leaves what a window does for the hub (the built-in browser, notifications,
// answering the hub's asks) to the window it's in. One pane has the focus (its head lit, its
// session marked in the sidebar): a session picked in the sidebar opens there, and what's
// typed goes there. A split opens from a session's menu in the sidebar, by dragging a session
// onto the right half, with /split (/split close, swap, new, or a session's name) or ⌘⇧\ (⌘\
// is the sidebar's). The divider drags (double-click: half and half); a window too narrow for
// two shows one pane at a time, with a button for the other. The two sessions (by their keys,
// which outlast a restart), the divider and the focused side are kept in prefs
// (features/code_split.py), so the split is back after a reload or a restart. Sessions' names
// are the user's: shown as data. Pure helpers are exported for node --test
// (tests/web/code-split.test.mjs).
(function codeSplit(root) {
  'use strict';

  // ── pure logic (tests/web/code-split.test.mjs) ──

  const MIN_PANE = 380;  // px a pane needs: narrower, the window shows one pane at a time
  const GAP = 8;  // px: the divider
  const RATIO_MIN = 0.2;  // the left pane's share of the width (code_split.py keeps it the same)
  const RATIO_MAX = 0.8;

  // The left pane's share of a room width px wide, kept where each pane has min px.
  function clampRatio(ratio, width, min = MIN_PANE, gap = GAP) {
    let r = Number(ratio);
    if (!Number.isFinite(r)) r = 0.5;
    let lo = RATIO_MIN;
    let hi = RATIO_MAX;
    const room = Number(width) - gap;
    if (Number.isFinite(room) && room > 0) {
      lo = Math.max(lo, min / room);
      hi = Math.min(hi, 1 - min / room);
    }
    if (lo > hi) return 0.5;
    return Math.min(hi, Math.max(lo, r));
  }

  // Too narrow for two panes side by side.
  function narrow(width, min = MIN_PANE, gap = GAP) {
    return !(Number(width) >= 2 * min + gap);
  }

  // The share the divider makes when it's dragged to x, in a room from left, width wide.
  function ratioAt(x, left, width, gap = GAP) {
    const room = width - gap;
    return room > 0 ? (x - left - gap / 2) / room : 0.5;
  }

  // The half of the room a session dragged to (x, y) lands in: 'left', 'right', or null.
  function dropSide(x, y, box) {
    if (!box || !(box.width > 0) || x < box.left || x > box.left + box.width || y < box.top || y > box.top + box.height) return null;
    return x >= box.left + box.width / 2 ? 'right' : 'left';
  }

  // The split as prefs keep it (features/code_split.py), anything odd made safe.
  function cleanState(value) {
    const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const side = (s) => {
      const o = s && typeof s === 'object' ? s : {};
      return {
        id: Number.isInteger(o.id) && o.id > 0 ? o.id : null,
        key: typeof o.key === 'string' && o.key.length <= 64 ? o.key : '',
      };
    };
    const ratio = typeof v.ratio === 'number' && Number.isFinite(v.ratio) ? Math.min(RATIO_MAX, Math.max(RATIO_MIN, v.ratio)) : 0.5;
    return {
      on: v.on === true,
      ratio,
      focus: v.focus === 'right' ? 'right' : 'left',
      left: side(v.left),
      right: side(v.right),
      hub: typeof v.hub === 'string' ? v.hub.slice(0, 64) : '',
    };
  }

  // The session a kept side means now: the one with its key (the same across restarts), else
  // its id, only on the backend that kept it (a restarted one numbers its sessions anew).
  function resolveSide(side, sameHub, ids, keyOf) {
    if (!side) return null;
    if (side.key) for (const id of ids) if (keyOf(id) === side.key) return id;
    return sameHub && side.id != null && ids.includes(side.id) ? side.id : null;
  }

  // What /split's words ask for.
  function splitCommand(arg) {
    const word = String(arg || '').trim();
    const lower = word.toLowerCase();
    if (!word) return { action: 'open' };
    if (['close', 'off', 'stop', 'exit', 'end'].includes(lower)) return { action: 'close' };
    if (lower === 'swap') return { action: 'swap' };
    if (lower === 'new') return { action: 'new' };
    return { action: 'find', query: word };
  }

  // The session /split <words> means: its number (#12), its whole name, then the newest whose
  // name has the words in it; never one of `skip` (the panes' own).
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

  // The sessions offered for an empty pane: not the other pane's, not archived; the latest first.
  function pickable(tasks, other, metaOf) {
    const when = (t) => String((metaOf(t.id) || {}).updated || '');
    return (tasks || [])
      .filter((t) => t.id !== other && !(metaOf(t.id) || {}).archived)
      .sort((a, b) => when(b).localeCompare(when(a)) || b.id - a.id);
  }

  // Where a session asked for goes while the split shows (a sidebar click, a new session, a
  // voice "show me…"): 'focus-right' (the right pane has it already: it takes the focus),
  // 'right' (into the right pane, the focused one), or 'left' (the window's own, as without).
  function route(state, id) {
    if (id == null) return 'left';
    if (id === state.right) return 'focus-right';
    if (id === state.left) return 'left';
    return state.focus === 'right' ? 'right' : 'left';
  }

  // A pane that went by itself (a fork, /clear, an Open somewhere in it) to the session the other
  // pane shows: it goes back to the one it had, or, with none, the pane beside closes. Null:
  // nothing is shown twice.
  function afterChange(state, side, id, previous) {
    const other = side === 'left' ? state.right : state.left;
    if (id == null || id !== other) return null;
    if (previous != null && previous !== id) return { side, show: previous };
    return { close: true };
  }

  // The mark on an unfocused pane's head: an answer it waits for beats news since you looked.
  function paneMark(asks, fresh) {
    return asks > 0 ? 'needs' : fresh ? 'new' : '';
  }

  // ⌘⇧\ opens or closes the split; ⌘\ is the sidebar's (forwarded from the right pane).
  function keyAction(e) {
    if (!e || !e.metaKey || e.ctrlKey || e.altKey) return null;
    if (!(e.code === 'Backslash' || e.key === '\\' || e.key === '|')) return null;
    return e.shiftKey ? 'split' : 'side';
  }

  const api = {
    MIN_PANE, GAP, RATIO_MIN, RATIO_MAX, clampRatio, narrow, ratioAt, dropSide, cleanState,
    resolveSide, splitCommand, findSession, pickable, route, afterChange, paneMark, keyAction,
  };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  const F = root.jarvisFeatures;
  if (!F || !F.registerSplit) return;

  const HELP = 'Split view: another session beside this one · /split close';
  const KEY = '⌘⇧\\';
  const NS = 'http://www.w3.org/2000/svg';
  const GLYPHS = {
    split: ['M3.8 3h8.4A1.8 1.8 0 0 1 14 4.8v6.4a1.8 1.8 0 0 1-1.8 1.8H3.8A1.8 1.8 0 0 1 2 11.2V4.8A1.8 1.8 0 0 1 3.8 3z', 'M8 3v10'],
    swap: ['M3 5.5h9.5', 'M10 3l2.5 2.5L10 8', 'M13 10.5H3.5', 'M6 8l-2.5 2.5L6 13'],
    alone: ['M9.5 2.5h4v4', 'M13.5 2.5L9 7', 'M6.5 13.5h-4v-4', 'M2.5 13.5L7 9'],
    close: ['M4.5 4.5l7 7', 'M11.5 4.5l-7 7'],
  };
  function glyph(name, size = 14) {
    const svg = document.createElementNS(NS, 'svg');
    for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, String(v));
    for (const d of GLYPHS[name]) {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    return svg;
  }
  const named = (task) => (task ? String(task.title || task.prompt || '') : '');
  if (typeof JC_KEYS !== 'undefined' && !JC_KEYS.some(([k]) => k === KEY)) JC_KEYS.push([KEY, 'Split view: open or close']);  // (what ? lists)

  if (F.splitPane) paneSide(); else windowSide();

  // ── the right pane: this window in a frame, on the session the window asks for ──

  function paneSide() {
    const host = root.parent;
    const tell = (msg) => { try { host.postMessage({ sv: 1, ...msg }, location.origin); } catch (_) { /* the window went */ } };
    const P = { want: null, other: null, focused: false };  // want: { id, hub }; other: the left pane's session
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
      if (m.other !== undefined) P.other = m.other;
      if (m.project && ccSelected == null && m.project !== deckProject) selectProject(m.project);
      if (m.show !== undefined && m.show !== null) { P.want = { id: m.show, hub: m.hub || null }; apply(); }
      if (m.resume && m.resume.folder && m.resume.session_id) resumeSession(m.resume.folder, m.resume);
      if (m.start) { if (m.start !== deckProject) selectProject(m.start); newSession(false); }
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
      tell({ focus: true, key: act });
    }, true);
    // The built-in browser docks in the window.
    const browserBtn = $('jc-browser');
    if (browserBtn) browserBtn.addEventListener('click', (e) => { e.stopImmediatePropagation(); tell({ browser: true }); }, true);
    F.registerSlash({ name: 'split', help: HELP, withoutSession: true, run(arg) { tell({ command: arg || '' }); return true; } });
    F.registerMoreItem({ label: 'Swap sides', run: () => tell({ command: 'swap' }) });
    F.registerMoreItem({ label: 'Close split view', key: KEY, run: () => tell({ command: 'close' }) });

    function renderPicker() {
      const S = F.codeSessions;
      const metaOf = (id) => (S && S.meta.get(id)) || {};
      const items = ccSelected == null ? pickable(ccTasks, P.other, metaOf).slice(0, 8) : [];
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

    // The window moves this pane's session to its own pane, or closes this one: its unsent
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

  // ── the window: its own pane on the left, the frame on the right ──

  function windowSide() {
    const cc = $('cc');
    const main = cc.querySelector('.jc-main');
    const shared = () => F.codeSessions || null;
    const metaOf = (id) => { const S = shared(); return (S && id != null && S.meta.get(id)) || {}; };
    const keyOf = (id) => metaOf(id).key || '';
    const taskOf = (id) => (id == null ? null : ccTasks.find((x) => x.id === id) || null);
    const asksOf = (id) => (id == null ? 0 : [...pendingApprovals.values()].filter((a) => a.task_id === id).length);
    const other = (side) => (side === 'left' ? 'right' : 'left');
    const R = {
      on: false,
      right: null,  // the right pane's session (null: it offers some)
      focus: 'left',
      ratio: 0.5,
      fresh: new Set(),  // sessions with news since their pane last had the focus
      keys: { left: '', right: '' },  // the panes' session keys, to find them after a restart
      hub: null,
      restored: false,  // the split prefs kept has been put back (or there was none)
    };
    let kept = null;  // the split prefs kept, until it's put back
    let metaFull = false;  // code-sessions has the session keys of this backend
    let frame = null;
    let ready = false;  // the frame's module is listening
    let outbox = [];  // what's for the frame once it listens
    let saveTimer = 0;
    let saved = '';  // what prefs have now

    // The pane heads, the divider and the pane on the right.
    function head(side) {
      const box = el('div', `sv-head sv-head-${side}`);
      box.hidden = true;
      const dot = el('span', 'jc-dot');
      const title = el('span', 'sv-title');
      const mark = el('span', 'sv-mark');
      mark.hidden = true;
      const flip = el('button', 'sv-flip');
      flip.type = 'button';
      flip.hidden = true;
      flip.setAttribute('aria-label', 'Show the other pane');
      flip.addEventListener('click', () => setFocus(other(side), true));
      // (each with its word too, which the Logbook look shows instead of the glyph)
      const button = (cls, label, icon, word, run) => {
        const b = el('button', `jc-icon sv-btn ${cls}`);
        b.type = 'button';
        b.title = label;
        b.setAttribute('aria-label', label);
        b.append(glyph(icon), el('span', 'sv-word', word));
        b.addEventListener('click', run);
        return b;
      };
      const swap = button('sv-swap', 'Swap sides', 'swap', 'swap', () => swapSides());
      const alone = button('sv-alone', 'Show only this session', 'alone', 'alone', () => closePane(other(side)));
      const close = button('sv-close', 'Close this pane', 'close', 'close', () => closePane(side));
      box.append(dot, title, mark, flip, swap, alone, close);
      box.addEventListener('pointerdown', (e) => { if (!e.target.closest('button')) setFocus(side, true); });
      return { box, dot, title, mark, flip, swap };
    }
    const heads = { left: head('left'), right: head('right') };
    main.prepend(heads.left.box);
    const divider = el('div', 'sv-divider');
    divider.hidden = true;
    divider.tabIndex = 0;
    divider.title = 'Drag to resize · double-click for half and half';
    for (const [k, v] of Object.entries({ role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize the panes', 'aria-valuemin': '20', 'aria-valuemax': '80' })) divider.setAttribute(k, v);
    const pane = el('section', 'sv-pane');
    pane.hidden = true;
    pane.setAttribute('aria-label', 'The session beside');
    const holder = el('div', 'sv-frame-wrap');
    pane.append(heads.right.box, holder);
    main.after(divider, pane);

    // ── the frame ──

    function mount() {
      if (frame || !R.on || cc.hidden) return;
      ready = false;
      frame = el('iframe', 'sv-frame');
      frame.title = 'The session beside';
      frame.src = `/?${new URLSearchParams({ token, pane: 'code' })}`;
      holder.append(frame);
    }
    function unmount() {
      if (frame) frame.remove();
      frame = null;
      ready = false;
      outbox = [];
    }
    function post(msg) {
      try { frame.contentWindow.postMessage({ sv: 1, ...msg }, location.origin); } catch (_) { /* gone */ }
    }
    function tell(msg) {
      if (frame && ready) post(msg);
      else outbox.push(msg);
    }
    // What the frame shows and knows: sent whole whenever it (re)starts listening.
    function sync() {
      if (!frame || !ready) return;
      post({ inApp: document.body.classList.contains('in-app'), focused: R.focus === 'right', other: ccSelected, project: deckProject, show: R.right, hub: hubId });
    }
    function frameShared() {
      try { return (frame && frame.contentWindow.jarvisFeatures && frame.contentWindow.jarvisFeatures.codeSessions) || null; } catch (_) { return null; }
    }
    // The frame's session, about to move here or go: its unsent words and files.
    function park() {
      let parked = null;
      try { parked = frame ? frame.contentWindow.jarvisSplitPane.park() : null; } catch (_) { parked = null; }
      const S = shared();
      if (parked && S) {
        S.drafts.set(parked.id, parked.text);
        if (parked.held && parked.held.length) S.held.set(parked.id, parked.held); else S.held.delete(parked.id);
      }
      return parked;
    }
    // A session that leaves one pane takes its unsent words and files to the other's keeping.
    function carry(from, to, id) {
      if (!from || !to || id == null) return;
      if (from.drafts.has(id)) to.drafts.set(id, from.drafts.get(id));
      if (from.held.has(id)) { to.held.set(id, from.held.get(id)); from.held.delete(id); }
    }
    root.addEventListener('message', (e) => {
      const m = e.data;
      if (!frame || e.source !== frame.contentWindow || e.origin !== location.origin || !m || m.sv !== 1) return;
      if (m.ready) {
        ready = true;
        const shown = frame;
        setTimeout(() => shown.classList.add('sv-ready'), 60);  // (no flash of the window it starts as)
        sync();
        for (const msg of outbox.filter((x) => x.resume || x.start)) post(msg);
        outbox = [];
        if (R.focus === 'right' && [frame, document.body].includes(document.activeElement)) placeFocus();
      }
      if (m.selected !== undefined) frameSelected(m.selected, m.previous);
      if (m.focus) setFocus('right');
      if (m.key === 'split') toggle();
      if (m.key === 'side') setSide(cc.classList.contains('side-hidden'));
      if (typeof m.command === 'string') command(m.command, 'right');
      if (m.route !== undefined) F.selectTask(m.route);
      if (m.browser) $('jc-browser').click();
    });

    // ── opening, closing, swapping ──

    // The split, with id in the right pane (null: it offers sessions to open there).
    function open(id, { focus = 'right', quiet = false } = {}) {
      if (id != null && id === ccSelected) { jcNote('That session is open here already: pick another one to see beside it.'); return; }
      if (R.on) { if (id != null) showRight(id); return; }
      R.on = true;
      R.right = id;
      R.focus = focus;
      R.fresh.clear();
      remember();
      F.registerSplit(view);  // (marks the sidebar)
      if (cc.hidden) { if (!quiet) toggleCC(true); } else mount();
      layout();
      render();
      save();
      if (!quiet) setTimeout(placeFocus, 60);
    }

    // id in the right pane, which takes the focus.
    function showRight(id) {
      if (id == null) return;
      if (id === ccSelected) { setFocus('left', true); return; }
      if (!R.on) { open(id); return; }
      R.right = id;
      R.fresh.delete(id);
      const task = taskOf(id);
      if (task) openProjects.add(task.folder);
      tell({ show: id, hub: hubId });
      remember();
      setFocus('right', true, true);
      save();
    }

    // Closing a pane leaves the other as the window's one view.
    function closePane(side) {
      if (!R.on) return;
      park();
      const keep = side === 'left' ? R.right : null;
      R.on = false;
      R.right = null;
      R.focus = 'left';
      R.fresh.clear();
      unmount();
      F.registerSplit(null);
      if (keep != null) F.selectHere(keep);  // the right pane's session, in the window's own
      layout();
      render();
      save();
      if (!cc.hidden) $('deck-input').focus();
    }

    // The two sessions trade places; the focus stays with its session.
    function swapSides() {
      if (!R.on || R.right == null || ccSelected == null) return;
      const left = ccSelected;
      const right = R.right;
      park();
      R.right = left;  // (first: the window's own selection mustn't read as the same session twice)
      F.selectHere(right);
      R.focus = other(R.focus);
      tell({ show: left, hub: hubId });
      remember();
      layout();
      render();
      renderProjects(deckProjects);
      tell({ other: ccSelected, focused: R.focus === 'right' });
      save();
      placeFocus();
    }

    function toggle() {
      if (R.on) closePane(other(R.focus));  // the focused pane stays
      else open(null);
    }

    // A new session in the right pane, in the project on show.
    function startRight() {
      if (!deckProject) { jcNote('Pick a project first.'); return; }
      open(null);
      tell({ start: deckProject });
    }

    // A past session (from the sidebar's history) resumed in the right pane.
    function resumeRight(h) {
      open(null);
      tell({ resume: { folder: h.folder, session_id: h.session_id, title: h.title || '' } });
    }

    // ── the focus ──

    function setFocus(side, move = false, force = false) {
      if (!R.on) return;
      if (R.focus !== side || force) {
        R.focus = side;
        const id = side === 'right' ? R.right : ccSelected;
        if (id != null) {
          R.fresh.delete(id);
          const S = shared();
          if (S) S.unread.delete(id);
          const task = taskOf(id);
          if (task) openProjects.add(task.folder);
        }
        tell({ focused: side === 'right' });
        renderProjects(deckProjects);  // the sidebar marks the focused pane's session
        layout();
        render();
        save();
      }
      if (move) placeFocus();
    }
    function placeFocus() {
      if (!R.on || cc.hidden) return;
      if (R.focus === 'left') { $('deck-input').focus(); return; }
      try {
        const input = frame && frame.contentDocument && frame.contentDocument.getElementById('deck-input');
        if (input) { input.focus(); return; }
      } catch (_) { /* not loaded yet */ }
      if (frame) frame.focus();
    }
    // A hand or a key in the window's own pane gives it the focus (the frame says so for its).
    main.addEventListener('pointerdown', () => setFocus('left'), true);
    main.addEventListener('keydown', () => setFocus('left'), true);
    // The right pane has the focus but a key lands outside both panes (a click in the sidebar
    // left it there): a number or Esc there would answer or stop the left pane's session.
    document.addEventListener('keydown', (e) => {
      if (!R.on || R.focus !== 'right' || cc.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!(/^[1-9]$/.test(e.key) || e.key === 'Escape')) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target && (main.contains(target) || target.closest('input, textarea, select, [contenteditable="true"], .jc-menu, [role="dialog"]'))) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      placeFocus();
    }, true);

    // ── the session the window's own pane shows, and the frame's ──

    F.on('jc_select', ({ id, previous }) => {
      if (previous != null && previous !== id) carry(shared(), frameShared(), previous);
      if (!R.on) return;
      const fix = afterChange({ left: id, right: R.right }, 'left', id, previous);
      if (fix && fix.close) { closePane('right'); return; }
      if (fix && fix.show != null) { R.right = fix.show; tell({ show: fix.show, hub: hubId }); }
      remember();
      tell({ other: id });
      render();
      save();
    });

    function frameSelected(id, previous) {
      if (previous != null && previous !== id && previous !== ccSelected) carry(frameShared(), shared(), previous);
      if (!R.on || id == null) return;
      const fix = afterChange({ left: ccSelected, right: id }, 'right', id, previous);
      if (fix && fix.close) { closePane('right'); setFocus('left', true); return; }
      if (fix && fix.show != null) { tell({ show: fix.show, hub: hubId }); setFocus('left', true); return; }
      if (id === R.right) { render(); return; }
      R.right = id;
      const task = taskOf(id);
      if (task) openProjects.add(task.folder);
      remember();
      renderProjects(deckProjects);
      render();
      save();
    }

    // What app.js asks of the split (jcSplit there).
    const view = {
      take(id) {
        const where = route({ left: ccSelected, right: R.right, focus: R.focus }, id);
        if (where === 'focus-right') { setFocus('right', true); return true; }
        if (where === 'right') { showRight(id); return true; }
        if (id != null && id === ccSelected && R.focus !== 'left') setFocus('left');
        return false;
      },
      marked: () => (R.focus === 'right' ? R.right : ccSelected),
      shows(id) {
        if (id == null) return false;
        const one = cc.classList.contains('sv-narrow');
        if (id === ccSelected) return !one || R.focus === 'left';
        if (id === R.right) return !!frame && (!one || R.focus === 'right');
        return false;
      },
    };

    // What the split shows, for other modules (code-logbook.js: the index's L and R).
    F.splitState = () => ({ on: R.on, right: R.right, focus: R.focus });

    // ── where it all goes ──

    // The room right of the sidebar: where the panes are.
    function area() {
      const box = cc.getBoundingClientRect();
      const inset = parseFloat(getComputedStyle(cc).getPropertyValue('--sv-l')) || 0;
      return { left: box.left + inset, top: box.top, width: box.width - inset, height: box.height };
    }
    function layout() {
      cc.classList.toggle('sv-on', R.on);
      divider.hidden = !R.on;
      pane.hidden = !R.on;
      if (!R.on) { cc.classList.remove('sv-narrow', 'sv-right-front'); return; }
      const room = area();
      const one = narrow(room.width);
      if (one !== cc.classList.contains('sv-narrow')) soon();  // (the heads' button for the other pane)
      cc.classList.toggle('sv-narrow', one);
      cc.classList.toggle('sv-right-front', one && R.focus === 'right');
      const ratio = clampRatio(R.ratio, room.width);
      cc.style.setProperty('--sv-ratio', ratio.toFixed(4));
      const pct = Math.round(ratio * 100);
      divider.setAttribute('aria-valuenow', String(pct));
      divider.setAttribute('aria-valuetext', `${pct}% · ${100 - pct}%`);
    }
    new ResizeObserver(() => { if (R.on) layout(); }).observe(cc);
    // The sidebar folding, and Jarvis Code opening (the frame loads once it's first seen).
    new MutationObserver(() => {
      if (!R.on) return;
      layout();
      if (!cc.hidden && !frame) { mount(); setTimeout(placeFocus, 120); }
    }).observe(cc, { attributes: true, attributeFilter: ['hidden', 'class'] });

    // The divider: dragged, double-clicked for half and half, or moved with the arrow keys.
    divider.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      divider.setPointerCapture(e.pointerId);
      cc.classList.add('sv-dragging');
      const move = (ev) => { const room = area(); R.ratio = clampRatio(ratioAt(ev.clientX, room.left, room.width), room.width); layout(); };
      const end = () => {
        cc.classList.remove('sv-dragging');
        divider.removeEventListener('pointermove', move);
        divider.removeEventListener('pointerup', end);
        divider.removeEventListener('pointercancel', end);
        save();
      };
      divider.addEventListener('pointermove', move);
      divider.addEventListener('pointerup', end);
      divider.addEventListener('pointercancel', end);
    });
    divider.addEventListener('dblclick', () => { R.ratio = 0.5; layout(); save(); });
    divider.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.1 : 0.02;
      const to = { ArrowLeft: R.ratio - step, ArrowRight: R.ratio + step, Home: 0, End: 1, Enter: 0.5 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      R.ratio = clampRatio(to, area().width);
      layout();
      save();
    });

    // ── the heads ──

    function render() {
      heads.left.box.hidden = !R.on;
      heads.right.box.hidden = !R.on;
      if (!R.on) return;
      const one = cc.classList.contains('sv-narrow');
      for (const side of ['left', 'right']) {
        const h = heads[side];
        const id = side === 'left' ? ccSelected : R.right;
        const task = taskOf(id);
        const asks = asksOf(id);
        const focused = R.focus === side;
        h.box.classList.toggle('sv-focused', focused);
        h.dot.className = `jc-dot ${task ? (asks ? 'needs' : statusOf(task)) : 'past'}`;
        const words = named(task);
        const label = words || (task ? 'New session' : side === 'right' ? 'Pick a session' : 'No session open');
        const key = JSON.stringify([words, label]);
        if (h.title.dataset.key !== key) {
          h.title.dataset.key = key;
          h.title.replaceChildren(words ? mine(el('span', '', words)) : el('span', '', label));
        }
        markOn(h.mark, focused ? '' : paneMark(asks, id != null && R.fresh.has(id)));
        h.swap.disabled = R.right == null || ccSelected == null;
        // One pane at a time: the shown pane's head has a button for the other, with its mark.
        h.flip.hidden = !one || !focused;
        if (!h.flip.hidden) {
          const otherId = side === 'left' ? R.right : ccSelected;
          const otherTask = taskOf(otherId);
          const flipKey = JSON.stringify([named(otherTask), paneMark(asksOf(otherId), otherId != null && R.fresh.has(otherId))]);
          if (h.flip.dataset.key !== flipKey) {
            h.flip.dataset.key = flipKey;
            const mark = el('span', 'sv-mark');
            markOn(mark, paneMark(asksOf(otherId), otherId != null && R.fresh.has(otherId)));
            h.flip.replaceChildren(glyph('swap', 12), named(otherTask) ? mine(el('span', 'sv-flip-title', named(otherTask))) : el('span', 'sv-flip-title', side === 'left' ? 'Pick a session' : 'No session open'), mark);
          }
        }
      }
    }
    function markOn(node, kind) {
      node.hidden = !kind;
      if (node.dataset.kind === kind) return;  // (its words may be Chinese by now)
      node.dataset.kind = kind;
      node.className = `sv-mark ${kind}`;
      node.textContent = kind === 'needs' ? 'Needs you' : kind === 'new' ? 'New reply' : '';
    }
    let frameDue = 0;
    function soon() {  // one redraw a frame, however many events came
      if (frameDue) return;
      frameDue = requestAnimationFrame(() => { frameDue = 0; render(); });
    }

    // ── the sessions as they change ──

    F.on('tasks', () => {
      if (R.on && R.restored) {
        const live = new Set(ccTasks.map((x) => x.id));
        // A session that's gone takes its pane with it; the other stays.
        if (R.right != null && !live.has(R.right)) { closePane('right'); jcNote('The session beside has gone, so split view closed.'); return; }
        if (ccSelected != null && !live.has(ccSelected) && R.right != null) { closePane('left'); return; }
      }
      soon();
    });
    let archived = new Set();
    F.on('code_meta', (ev) => {
      if (ev && ev.full) metaFull = true;
      const S = shared();
      const now = new Set(S ? [...S.meta].filter(([, m]) => m && m.archived).map(([id]) => id) : []);
      if (R.on && R.restored) {
        // Archived while in a pane: it's put away, and the other pane stays.
        if (R.right != null && now.has(R.right) && !archived.has(R.right)) closePane('right');
        else if (ccSelected != null && now.has(ccSelected) && !archived.has(ccSelected) && R.right != null) closePane('left');
      }
      archived = now;
      if (R.restored) remember();
      tryRestore();
      soon();
    }, { replay: true });
    for (const type of ['approval', 'approval_resolved']) F.on(type, () => soon());
    // News in the pane without the focus marks its head.
    const unfocused = () => (R.focus === 'right' ? ccSelected : R.right);
    F.on('task_log', (ev) => {
      const role = ev.entry && ev.entry.role;
      if (R.on && ev.id === unfocused() && ['assistant', 'plan'].includes(role)) { R.fresh.add(ev.id); soon(); }
    });
    F.on('task_finished', (ev) => {
      if (R.on && ev.id === unfocused()) { R.fresh.add(ev.id); soon(); }
    });

    // ── kept in prefs, put back after a reload or a restart ──

    function remember() {
      if (!R.restored) return;
      R.keys = { left: keyOf(ccSelected), right: keyOf(R.right) };
    }
    function save() {
      if (!R.restored) return;  // (what prefs keep isn't overwritten before it's been put back)
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        const ratio = Math.round(R.ratio * 1e4) / 1e4;
        const state = cleanState(!R.on ? { on: false, ratio } : {  // (off: only the divider is kept)
          on: true,
          ratio,
          focus: R.focus,
          left: { id: ccSelected, key: keyOf(ccSelected) || R.keys.left },
          right: { id: R.right, key: keyOf(R.right) || R.keys.right },
          hub: hubId || '',
        });
        const text = JSON.stringify(state);
        if (text !== saved && F.send({ type: 'feature_prefs', changes: { code_split: state } })) saved = text;
      }, 1500);  // (a burst of moves is kept once: each keeping redraws every window's settings)
    }
    function tryRestore() {
      if (R.restored || !kept || (shared() && !metaFull)) return;
      R.restored = true;
      const state = kept;
      kept = null;
      saved = JSON.stringify(state);
      R.ratio = state.ratio;
      const ids = ccTasks.map((x) => x.id);
      const sameHub = !!state.hub && state.hub === hubId;
      const left = resolveSide(state.left, sameHub, ids, keyOf);
      const right = resolveSide(state.right, sameHub, ids, keyOf);
      if (!state.on || right == null || right === left) {  // its session isn't there any more: no split
        if (R.on) closePane('right');
        if (state.on) save();
        return;
      }
      if (R.on) {  // the same split, after a restart: its sessions by their new numbers
        R.right = right;
        R.focus = state.focus;
        if (left != null && left !== ccSelected) F.selectHere(left);
        tell({ show: right, hub: hubId });
        remember();
        renderProjects(deckProjects);
        layout();
        render();
        sync();
        save();
        if (!cc.hidden && document.hasFocus()) placeFocus();  // (the window's own pane took it, picking its session)
        return;
      }
      if (left != null && left !== ccSelected) F.selectHere(left);
      open(right, { focus: state.focus, quiet: true });
    }
    F.on('hello', (ev) => {
      const hub = ev.hub_id || null;
      if (R.hub !== null && hub !== R.hub && R.restored && R.on) {
        // A restarted backend numbers its sessions anew: the split is found again by its keys.
        kept = cleanState({ on: true, ratio: R.ratio, focus: R.focus, left: { key: R.keys.left }, right: { key: R.keys.right } });
        R.restored = false;
        R.right = null;  // (its number was the old backend's)
        metaFull = false;
      }
      R.hub = hub;
      if (!R.restored && !kept) kept = cleanState(ev.prefs && ev.prefs.features && ev.prefs.features.code_split);
      tryRestore();
      // Without the sessions' keys in a while (no code_sessions on this backend): by number.
      setTimeout(() => { if (!R.restored && kept) { metaFull = true; tryRestore(); } }, 5000);
    }, { replay: true });

    // ── ways in: a session's menu, dragging one over, /split, ⌘⇧\, More ──

    const S0 = shared();
    if (S0 && S0.rowItems) {
      S0.rowItems.push((id) => {
        if (id === ccSelected) return { label: 'Open in split view', note: 'Open here already', disabled: true };
        if (R.on && id === R.right) return { label: 'Open in split view', note: 'Beside, already', disabled: true };
        return { label: 'Open in split view', key: R.on ? '' : KEY, run: () => showRight(id) };
      });
    }
    F.registerSlash({ name: 'split', help: HELP, withoutSession: true, run(arg) { command(arg, 'left'); return true; } });
    F.registerMoreItem({ label: 'Split view', note: 'Another session beside this one', key: KEY, when: () => !R.on, run: () => open(null) });
    F.registerMoreItem({ label: 'Swap sides', when: () => R.on && R.right != null && ccSelected != null, run: () => swapSides() });
    F.registerMoreItem({ label: 'Close split view', key: KEY, when: () => R.on, run: () => closePane('right') });
    document.addEventListener('keydown', (e) => {
      if (cc.hidden || keyAction(e) !== 'split') return;
      e.preventDefault();
      toggle();
    });

    // /split, typed in either pane (from: the pane it was typed in).
    function command(arg, from) {
      const { action, query } = splitCommand(arg);
      if (action === 'open') { if (R.on) jcNote('Split view is on: /split close closes it, /split swap swaps the sides.'); else open(null); return; }
      if (action === 'close') { if (R.on) closePane(other(from)); else jcNote('There’s no split view to close.'); return; }
      if (action === 'swap') { if (R.on && R.right != null && ccSelected != null) swapSides(); else jcNote('Swapping needs a session on each side.'); return; }
      if (action === 'new') { startRight(); return; }
      const id = findSession(ccTasks, query, [ccSelected]);
      if (id == null) { jcNote(`No session matches “${query}”.`); return; }
      showRight(id);
    }

    // Dragging a session from the sidebar: onto the right half opens it beside, onto the left
    // half in the window's own pane.
    const drop = el('div', 'sv-drop');
    drop.hidden = true;
    const halves = { left: el('div', 'sv-drop-half'), right: el('div', 'sv-drop-half') };
    const labels = { left: el('span', 'sv-drop-label'), right: el('span', 'sv-drop-label') };
    for (const side of ['left', 'right']) { halves[side].append(labels[side]); drop.append(halves[side]); }
    cc.append(drop);
    let dragged = null;  // { task: id } or { session: id }
    function decorateRows() {
      for (const row of $('deck-project-list').querySelectorAll('.jc-session[data-task], .jc-session.past[data-session]')) {
        if (row.dataset.svDrag) continue;
        row.dataset.svDrag = '1';
        row.draggable = true;
        row.addEventListener('dragstart', (e) => {
          dragged = row.dataset.task ? { task: Number(row.dataset.task) } : { session: row.dataset.session };
          e.dataTransfer.effectAllowed = 'copyMove';
          const title = row.querySelector('.jc-stitle');
          e.dataTransfer.setData('text/plain', title ? title.textContent : '');
          setTimeout(() => { if (dragged) showDrop(); });  // (not while the drag is starting)
        });
        row.addEventListener('dragend', hideDrop);
      }
    }
    new MutationObserver(decorateRows).observe($('deck-project-list'), { childList: true, subtree: true });
    decorateRows();
    function showDrop() {
      labels.left.textContent = R.on ? 'Show on the left' : 'Open here';
      labels.right.textContent = R.on ? 'Show on the right' : 'Open beside';
      for (const side of ['left', 'right']) halves[side].classList.remove('on');
      drop.hidden = false;
    }
    function hideDrop() {
      dragged = null;
      drop.hidden = true;
    }
    drop.addEventListener('dragover', (e) => {
      if (!dragged) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const side = dropSide(e.clientX, e.clientY, area());
      for (const s of ['left', 'right']) halves[s].classList.toggle('on', s === side);
    });
    drop.addEventListener('dragleave', (e) => {
      if (!drop.contains(e.relatedTarget)) for (const s of ['left', 'right']) halves[s].classList.remove('on');
    });
    drop.addEventListener('drop', (e) => {
      if (!dragged) return;
      e.preventDefault();
      e.stopPropagation();
      const what = dragged;
      const side = dropSide(e.clientX, e.clientY, area());
      hideDrop();
      if (side) land(what, side);
    });
    function land(what, side) {
      if (what.session) {
        const h = codeHistory.find((x) => x.session_id === what.session);
        if (!h) return;
        if (side === 'right') { resumeRight(h); return; }
        if (R.on) setFocus('left');
        resumeSession(h.folder, h);
        return;
      }
      const id = what.task;
      if (side === 'right') {
        if (id === ccSelected) { if (R.on && R.right != null) swapSides(); else jcNote('That session is open here already: pick another one to see beside it.'); return; }
        showRight(id);
        return;
      }
      if (R.on && id === R.right) { if (ccSelected != null) swapSides(); else closePane('left'); return; }
      if (R.on) setFocus('left');
      F.selectHere(id);
      if ($('cc').hidden) toggleCC(true);
    }
  }
})(typeof window === 'object' ? window : globalThis);
