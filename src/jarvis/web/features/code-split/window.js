// Eden Code's split view, the window's machinery (features/code-split.js loads it the first
// time a split opens, or at the start when prefs kept one on): up to six panes laid out in a
// grid, the window's own pane among them and each other one a frame of this window
// (?pane=code&bridge=1) fed from this window's connection; a head on each (its session, its
// mark, swap, "only this one", close); the dividers; one pane at a time with a switcher when
// the window is too small for the grid; the drop zones while a session is dragged over; and
// the split kept in prefs and put back after a reload or a restart. The pure helpers it uses
// are code-split.js's (tests/web/code-split.test.mjs).
(function splitWindow(root) {
  'use strict';

  root.jarvisSplitWindow = function make(api, { HELP, KEY, named }) {
    const F = root.jarvisFeatures;
    const {
      MAX_PANES, MIN_PANE_H, gridFor, rects, dividers, clampFracs, cleanFracs, dragFracs, dropTarget, neighbor,
      cleanState, resolveSide, restorePanes, splitCommand, findSession, route, afterChange, paneMark, keyTarget,
    } = api;
    const cc = $('cc');
    const main = cc.querySelector('.jc-main');
    const shared = () => F.codeSessions || null;
    const metaOf = (id) => { const S = shared(); return (S && id != null && S.meta.get(id)) || {}; };
    const keyOf = (id) => metaOf(id).key || '';
    const taskOf = (id) => (id == null ? null : ccTasks.find((x) => x.id === id) || null);
    const asksOf = (id) => (id == null ? 0 : [...pendingApprovals.values()].filter((a) => a.task_id === id).length);
    const NS = 'http://www.w3.org/2000/svg';
    const GLYPHS = {
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

    // ── the panes ──

    // The window's own pane (its session: ccSelected), and the frames (each { id, key, frame,
    // ready, outbox, box, holder, head }), in the order they're laid out.
    const own = { own: true, key: '' };
    const R = {
      on: false,
      panes: [own],
      focus: 0,  // the pane with the focus (its index)
      cols: [], rows: [],  // the shares the dividers were dragged to (none: equal)
      grid: { cols: 1, rows: 1, one: false },
      boxes: [],  // each pane's box now
      fresh: new Set(),  // sessions with news since their pane last had the focus
      hub: null,
      restored: false,  // the split prefs kept has been put back (or there was none, or a hand came first)
    };
    let kept = null;  // the split prefs kept, until it's put back
    let metaFull = false;  // code-sessions has the session keys of this backend
    let saveTimer = 0;
    let saved = '';  // what prefs have now
    const idOf = (p) => (p.own ? ccSelected : p.id);
    const ids = () => R.panes.map(idOf);
    const ownAt = () => R.panes.indexOf(own);
    const focused = () => R.panes[R.focus] || own;
    const frames = () => R.panes.filter((p) => !p.own);
    const at = (p) => R.panes.indexOf(p);
    // A hand's first move wins over what prefs kept (still on its way).
    const claim = () => { if (!R.restored) { R.restored = true; kept = null; } };
    // A restarted backend, heard by app.js but not here yet: the panes' sessions are the old
    // one's numbers, so its pick (the session the window had open, again) is the window's own.
    const between = () => R.hub !== null && hubId !== R.hub;

    let uid = 0;
    function head(pane) {
      const box = el('div', 'sv-head');
      box.hidden = true;
      const dot = el('span', 'jc-dot');
      const title = el('span', 'sv-title');
      title.id = `sv-title-${(uid += 1)}`;
      const mark = el('span', 'sv-mark');
      mark.hidden = true;
      // One pane at a time: the panes, to pick from (in the head of the one on show).
      const tabs = el('div', 'sv-tabs');
      tabs.hidden = true;
      tabs.setAttribute('role', 'tablist');
      tabs.setAttribute('aria-label', 'Panes');
      tabs.addEventListener('keydown', tabKeys);
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
      const swap = button('sv-swap', 'Swap with the next pane', 'swap', 'swap', () => swapPane(at(pane)));
      const alone = button('sv-alone', 'Show only this session', 'alone', 'alone', () => only(at(pane)));
      const close = button('sv-close', 'Close this pane', 'close', 'close', () => closePane(at(pane)));
      box.append(dot, title, tabs, mark, swap, alone, close);
      box.addEventListener('pointerdown', (e) => { if (!e.target.closest('button')) setFocus(at(pane), true); });
      return { box, dot, title, mark, tabs, swap };
    }
    own.head = head(own);
    main.prepend(own.head.box);
    let lastBox = main;  // (new panes go after the last one made: none is ever moved, which would reload its frame)

    function makePane(id) {
      const p = { own: false, id, key: keyOf(id), frame: null, ready: false, outbox: [] };
      p.head = head(p);
      p.box = el('section', 'sv-pane');
      p.box.setAttribute('aria-labelledby', p.head.title.id);
      p.holder = el('div', 'sv-frame-wrap');
      p.box.append(p.head.box, p.holder);
      lastBox.after(p.box);
      lastBox = p.box;
      return p;
    }
    function dropPane(p) {
      unmount(p);
      if (lastBox === p.box) lastBox = p.box.previousElementSibling && cc.contains(p.box.previousElementSibling) ? p.box.previousElementSibling : main;
      p.box.remove();
    }

    // ── the frames ──

    function mount(p) {
      if (p.frame || !R.on || cc.hidden) return;
      p.ready = false;
      const frame = el('iframe', 'sv-frame');
      frame.title = 'Split view pane';
      // bridge=1: the pane opens no socket of its own; it hears this window's events, in
      // this window's order, and sends through it (web/code-store.js, code-bridge.js). app=code:
      // Eden Code's own window's page (its look, its modules only).
      const params = { token, pane: 'code', bridge: '1' };
      if (document.body.dataset.app === 'eden-code') params.app = 'code';
      frame.src = `/?${new URLSearchParams(params)}`;
      p.frame = frame;
      p.holder.append(frame);
      if (root.jarvisCodeStore) root.jarvisCodeStore.attachFrame(frame);
    }
    function unmount(p) {
      if (p.frame && root.jarvisCodeStore) root.jarvisCodeStore.detachFrame(p.frame);
      if (p.frame) p.frame.remove();
      p.frame = null;
      p.ready = false;
      p.outbox = [];
    }
    function post(p, msg) {
      try { p.frame.contentWindow.postMessage({ sv: 1, ...msg }, location.origin); } catch (_) { /* gone */ }
    }
    function tell(p, msg) {
      if (p.frame && p.ready) post(p, msg);
      else p.outbox.push(msg);
    }
    const others = (p) => ids().filter((id, k) => R.panes[k] !== p && id != null);
    // What a frame shows and knows: sent whole whenever it (re)starts listening.
    function sync(p) {
      if (!p.frame || !p.ready) return;
      post(p, { inApp: document.body.classList.contains('in-app'), focused: focused() === p, others: others(p), project: deckProject, show: p.id, hub: hubId });
    }
    // What changed for every frame: the others' sessions, which has the focus.
    function tellAll() {
      for (const p of frames()) if (p.frame && p.ready) post(p, { others: others(p), focused: focused() === p });
    }
    function frameShared(p) {
      try { return (p && p.frame && p.frame.contentWindow.jarvisFeatures && p.frame.contentWindow.jarvisFeatures.codeSessions) || null; } catch (_) { return null; }
    }
    // A frame's session, about to move to the window's pane or go: its unsent words and files.
    function park(p) {
      let parked = null;
      try { parked = p && p.frame ? p.frame.contentWindow.jarvisSplitPane.park() : null; } catch (_) { parked = null; }
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
      if (e.origin !== location.origin || !m || m.sv !== 1) return;
      const p = frames().find((x) => x.frame && e.source === x.frame.contentWindow);
      if (!p) return;
      if (m.ready) {
        p.ready = true;
        const shown = p.frame;
        setTimeout(() => shown.classList.add('sv-ready'), 60);  // (no flash of the window it starts as)
        sync(p);
        for (const msg of p.outbox.filter((x) => x.resume || x.start)) post(p, msg);
        p.outbox = [];
        if (focused() === p && [p.frame, document.body].includes(document.activeElement)) placeFocus();
      }
      if (m.selected !== undefined) frameSelected(p, m.selected, m.previous);
      if (m.focus) setFocus(at(p));
      if (typeof m.key === 'string') key(m.key, !!m.typing);
      if (typeof m.command === 'string') command(m.command, at(p));
      if (m.route !== undefined) F.selectTask(m.route);
      if (m.browser) $('jc-browser').click();
    });

    // ── opening, closing, moving ──

    function turnOn() {
      if (R.on) return;
      R.on = true;
      R.fresh.clear();
      main.setAttribute('role', 'region');
      main.setAttribute('aria-labelledby', own.head.title.id);
      F.registerSplit(view);  // (marks the sidebar)
    }
    function turnOff() {
      for (const p of frames()) dropPane(p);
      R.on = false;
      R.panes = [own];
      R.focus = 0;
      R.fresh.clear();
      main.removeAttribute('role');
      main.removeAttribute('aria-labelledby');
      F.registerSplit(null);
    }
    // Everything drawn again, told and kept, after the panes changed.
    function changed({ move = false } = {}) {
      remember();
      layout();
      render();
      renderProjects(deckProjects);
      tellAll();
      save();
      if (move) placeFocus();
    }

    // A pane for id (null: one offering sessions), at place `where` (the end: none); it takes
    // the focus. A session on show already: its pane takes the focus instead.
    function add(id, { where = null, focus = true, quiet = false } = {}) {
      claim();
      if (id != null && id === ccSelected && !R.on) { jcNote('That session is open here already: pick another one to see beside it.'); return null; }
      if (id != null && R.on && ids().includes(id)) { setFocus(ids().indexOf(id), true); return null; }
      if (R.panes.length >= MAX_PANES) { jcNote('Split view holds up to 6 sessions.'); return null; }
      const p = makePane(id);
      const was = focused();
      turnOn();
      const k = where == null ? R.panes.length : Math.max(0, Math.min(R.panes.length, where));
      R.panes.splice(k, 0, p);
      R.focus = focus ? k : at(was);
      if (id != null) { R.fresh.delete(id); const task = taskOf(id); if (task) openProjects.add(task.folder); }
      if (cc.hidden) { if (!quiet) toggleCC(true); } else mount(p);
      changed();
      if (!quiet && focus) setTimeout(placeFocus, 60);
      return p;
    }

    // id in pane k, which takes the focus (on show elsewhere: that pane takes it).
    function showIn(k, id) {
      const p = R.panes[k];
      if (!p || id == null) return;
      const j = ids().indexOf(id);
      if (j >= 0) { setFocus(j, true); return; }
      R.fresh.delete(id);
      const task = taskOf(id);
      if (task) openProjects.add(task.folder);
      if (p.own) { R.focus = k; F.selectHere(id); setFocus(k, true, true); return; }
      p.id = id;
      p.key = keyOf(id);
      tell(p, { show: id, hub: hubId });
      setFocus(k, true, true);
    }

    // Pane k closes; the others stay where they are. The window's own pane can't go: it takes
    // the session (and the place) of the pane nearest it, which goes instead.
    function closePane(k) {
      if (!R.on || !R.panes[k]) return;
      claim();
      const p = R.panes[k];
      const was = focused();
      let next = was;
      if (p.own) {
        const near = [k + 1, k - 1, ...R.panes.map((_, i) => i)].filter((i) => i >= 0 && i < R.panes.length && i !== k);
        const q = R.panes[near.find((i) => R.panes[i].id != null) ?? near[0]];
        const take = q.id;
        park(q);
        R.panes[at(q)] = own;
        R.panes.splice(k, 1);
        dropPane(q);
        if (was === p || was === q) next = own;
        if (take != null) F.selectHere(take);  // (its words and files came along: park)
      } else {
        park(p);
        R.panes.splice(k, 1);
        dropPane(p);
        if (was === p) next = R.panes[Math.max(0, k - 1)];
      }
      if (R.panes.length < 2) turnOff();
      else R.focus = Math.max(0, at(next));
      changed();
      if (!cc.hidden) placeFocus();
    }

    // Only pane k's session stays, in the window's own pane: split view closes.
    function only(k) {
      const keep = R.panes[k];
      if (!R.on || !keep) return;
      claim();
      for (const p of frames()) park(p);
      const take = keep.own ? null : keep.id;
      turnOff();
      if (take != null) F.selectHere(take);
      changed();
      if (!cc.hidden) $('deck-input').focus();
    }

    // Pane k trades places with the next one (two panes: they swap sides); the focus stays
    // with its session.
    function swapPane(k) {
      const n = R.panes.length;
      if (!R.on || n < 2 || !R.panes[k]) return;
      claim();
      const j = (k + 1) % n;
      const was = focused();
      [R.panes[k], R.panes[j]] = [R.panes[j], R.panes[k]];
      R.focus = at(was);
      changed({ move: true });
    }

    // Pane j's to place k (the others close up).
    function movePane(j, k) {
      const was = focused();
      const [p] = R.panes.splice(j, 1);
      R.panes.splice(Math.max(0, Math.min(R.panes.length, k > j ? k - 1 : k)), 0, p);
      R.focus = at(was);
      changed();
    }

    // A new session in a new pane, in the project on show.
    function startNew() {
      if (!deckProject) { jcNote('Pick a project first.'); return; }
      const p = add(null);
      if (p) tell(p, { start: deckProject });
    }

    // ── the focus ──

    function setFocus(k, move = false, force = false) {
      if (!R.on || !R.panes[k]) return;
      if (R.focus !== k || force) {
        R.focus = k;
        const id = idOf(R.panes[k]);
        if (id != null) {
          R.fresh.delete(id);
          const S = shared();
          if (S) S.unread.delete(id);
          const task = taskOf(id);
          if (task) openProjects.add(task.folder);
        }
        tellAll();
        renderProjects(deckProjects);  // the sidebar marks the focused pane's session
        layout();
        render();
        save();
      }
      if (move) placeFocus();
    }
    function placeFocus() {
      if (!R.on || cc.hidden) return;
      const p = focused();
      if (p.own) { $('deck-input').focus(); return; }
      try {
        const input = p.frame && p.frame.contentDocument && p.frame.contentDocument.getElementById('deck-input');
        if (input) { input.focus(); return; }
      } catch (_) { /* not loaded yet */ }
      if (p.frame) p.frame.focus();
    }
    // A hand or a key in the window's own pane gives it the focus (each frame says so for its).
    main.addEventListener('pointerdown', () => setFocus(ownAt()), true);
    main.addEventListener('keydown', () => setFocus(ownAt()), true);
    // A frame has the focus but a key lands outside every pane (a click in the sidebar left it
    // there): a number or Esc there would answer or stop the window's own pane's session.
    document.addEventListener('keydown', (e) => {
      if (!R.on || focused().own || cc.hidden || e.metaKey || e.ctrlKey || e.altKey) return;
      if (!(/^[1-9]$/.test(e.key) || e.key === 'Escape')) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target && (main.contains(target) || target.closest('input, textarea, select, [contenteditable="true"], .jc-menu, [role="dialog"], .sv-head, .sv-divider'))) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      placeFocus();
    }, true);

    // The split's keys (code-split.js keyAction), from the window or a frame.
    function key(act, typing = false) {
      // ⌘1–6 typed in a frame while the built-in browser is open: its tabs, as in the window's own pane.
      const to = keyTarget ? keyTarget(act, typeof browserOpenNow !== 'undefined' && browserOpenNow, typing) : act;
      if (to !== act) {
        if (to && typeof app !== 'undefined' && app && app.browser) app.browser.shortcut(to.slice('browser-'.length));
        return;
      }
      if (act === 'side') { setSide(cc.classList.contains('side-hidden')); return; }
      if (act === 'split') { add(null); return; }
      if (!R.on) return;
      claim();
      if (act.startsWith('move-')) { setFocus(neighbor(R.boxes, R.focus, act.slice(5), R.grid.one), true); return; }
      if (act.startsWith('pane-')) { const k = Number(act.slice(5)) - 1; if (R.panes[k]) setFocus(k, true); }
    }

    // ── the sessions the panes show ──

    // The window's own pane went to another session.
    F.on('jc_select', ({ id, previous }) => {
      if (previous != null && previous !== id) for (const p of frames()) carry(shared(), frameShared(p), previous);
      if (!R.on || between()) return;
      const fix = afterChange(ids(), ownAt(), ownAt(), id, previous);
      if (fix && fix.close != null) { closePane(fix.close); return; }
      if (fix && fix.show != null) {
        const p = R.panes[fix.pane];
        p.id = fix.show;
        p.key = keyOf(fix.show);
        tell(p, { show: fix.show, hub: hubId });
      }
      changed();
    });

    // A frame went to another session (a pick, a fork, /clear, an Open in it).
    function frameSelected(p, id, previous) {
      if (previous != null && previous !== id && previous !== ccSelected) carry(frameShared(p), shared(), previous);
      if (!R.on || id == null) return;
      const k = at(p);
      const now = ids();
      now[k] = id;
      const fix = afterChange(now, ownAt(), k, id, previous);
      if (fix) {
        const target = R.panes[fix.focus];
        if (fix.close != null) closePane(k);
        else tell(p, { show: fix.show, hub: hubId });
        setFocus(at(target), true);
        return;
      }
      if (id === p.id) { render(); return; }
      p.id = id;
      p.key = keyOf(id);
      const task = taskOf(id);
      if (task) openProjects.add(task.folder);
      changed();
    }

    // What app.js asks of the split (jcSplit there).
    const view = {
      take(id) {
        if (between()) return false;
        const where = route(ids(), ownAt(), R.focus, id);
        if (!where) {
          if (id != null && id === ccSelected && !focused().own) setFocus(ownAt());
          return false;
        }
        if (where.focus != null) { setFocus(where.focus, true); return true; }
        showIn(where.show, id);
        return true;
      },
      marked: () => idOf(focused()),
      shows(id) {
        if (id == null) return false;
        const k = ids().indexOf(id);
        if (k < 0) return false;
        if (!R.panes[k].own && !R.panes[k].frame) return false;
        return !R.grid.one || k === R.focus;
      },
    };

    // ── where it all goes ──

    // The room right of the sidebar: where the panes are (the looks' insets: --sv-l, --sv-t…).
    function area() {
      const box = cc.getBoundingClientRect();
      const style = getComputedStyle(cc);
      const v = (name) => parseFloat(style.getPropertyValue(name)) || 0;
      const l = v('--sv-l');
      const t = v('--sv-t');
      return { left: box.left + l, top: box.top + t, width: Math.max(0, box.width - l - v('--sv-r')), height: Math.max(0, box.height - t - v('--sv-b')) };
    }
    const place = (node, b) => {
      node.style.setProperty('--sv-x', `${b.x}px`);
      node.style.setProperty('--sv-y', `${b.y}px`);
      node.style.setProperty('--sv-w', `${b.w}px`);
      node.style.setProperty('--sv-h', `${b.h}px`);
    };
    const shares = (room) => ({
      cols: clampFracs(cleanFracs(R.cols, R.grid.cols), room.width),
      rows: clampFracs(cleanFracs(R.rows, R.grid.rows), room.height, MIN_PANE_H),
    });
    function layout() {
      cc.classList.toggle('sv-on', R.on);
      if (!R.on) {
        cc.classList.remove('sv-one');
        for (const name of ['--sv-x', '--sv-y', '--sv-w', '--sv-h']) main.style.removeProperty(name);
        main.classList.remove('sv-front', 'sv-corner');
        drawDividers([]);
        return;
      }
      const room = area();
      const n = R.panes.length;
      const grid = gridFor(n, room.width, room.height);
      const wasOne = R.grid.one;
      R.grid = grid;
      const { cols, rows } = shares(room);
      R.boxes = rects(n, grid, cols, rows, room.width, room.height);
      cc.classList.toggle('sv-one', grid.one);
      R.panes.forEach((p, k) => {
        const node = p.own ? main : p.box;
        const b = R.boxes[k];
        place(node, b);
        node.classList.toggle('sv-front', grid.one && k === R.focus);
        node.classList.toggle('sv-corner', b.x < 1 && b.y < 1);
        node.classList.toggle('sv-top', b.y < 1);
      });
      drawDividers(dividers(n, grid, cols, rows, room.width, room.height));
      if (wasOne !== grid.one) soon();  // (the heads' switcher)
    }
    new ResizeObserver(() => { if (R.on) layout(); }).observe(cc);
    // The sidebar folding, and Eden Code opening (the frames load once it's first seen).
    new MutationObserver(() => {
      if (!R.on) return;
      layout();
      if (!cc.hidden && frames().some((p) => !p.frame)) { for (const p of frames()) mount(p); setTimeout(placeFocus, 120); }
    }).observe(cc, { attributes: true, attributeFilter: ['hidden', 'class'] });

    // ── the dividers: dragged, double-clicked for equal shares, or moved with the arrow keys ──

    const bars = new Map();  // 'col1', 'row1'… -> its element
    function bar(kind, index) {
      const name = `${kind}${index}`;
      if (bars.has(name)) return bars.get(name);
      const d = el('div', `sv-divider sv-divider-${kind}`);
      d.tabIndex = 0;
      d.title = 'Drag to resize · double-click for equal sizes';
      const label = kind === 'col' ? 'Resize the columns' : 'Resize the rows';
      for (const [k, v] of Object.entries({ role: 'separator', 'aria-orientation': kind === 'col' ? 'vertical' : 'horizontal', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100' })) d.setAttribute(k, v);
      const across = kind === 'col' ? 'width' : 'height';
      const list = () => (kind === 'col' ? 'cols' : 'rows');
      const count = () => (kind === 'col' ? R.grid.cols : R.grid.rows);
      const minOf = kind === 'col' ? undefined : MIN_PANE_H;
      const moveTo = (pos) => {
        const room = area();
        const now = shares(room)[list()];
        R[list()] = dragFracs(now, index, pos, room[across], minOf);
        layout();
      };
      d.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        claim();
        d.setPointerCapture(e.pointerId);
        cc.classList.add('sv-dragging', `sv-dragging-${kind}`);
        const move = (ev) => { const room = area(); moveTo(kind === 'col' ? ev.clientX - room.left : ev.clientY - room.top); };
        const end = () => {
          cc.classList.remove('sv-dragging', `sv-dragging-${kind}`);
          d.removeEventListener('pointermove', move);
          d.removeEventListener('pointerup', end);
          d.removeEventListener('pointercancel', end);
          save();
        };
        d.addEventListener('pointermove', move);
        d.addEventListener('pointerup', end);
        d.addEventListener('pointercancel', end);
      });
      d.addEventListener('dblclick', () => { claim(); R[list()] = []; layout(); save(); });
      d.addEventListener('keydown', (e) => {
        const [back, on] = { col: ['ArrowLeft', 'ArrowRight'], row: ['ArrowUp', 'ArrowDown'] }[kind];
        if (![back, on, 'Enter', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        claim();
        if (e.key === 'Enter') { R[list()] = []; layout(); save(); return; }
        const room = area();
        const size = room[across];
        const gap = api.GAP;
        const fr = shares(room)[list()];
        const inner = size - gap * (count() - 1);
        const now = fr.slice(0, index).reduce((s, f) => s + f, 0) * inner + (index - 1) * gap + gap / 2;
        const step = (e.shiftKey ? 0.1 : 0.02) * size;
        const to = { [back]: now - step, [on]: now + step, Home: 0, End: size }[e.key];
        moveTo(to);
        save();
      });
      bars.set(name, d);
      return d;
    }
    function drawDividers(list) {
      const keep = new Set();
      for (const x of list) {
        const d = bar(x.kind, x.index);
        keep.add(d);
        if (!d.isConnected) cc.append(d);
        place(d, x);
        const fr = shares(area())[x.kind === 'col' ? 'cols' : 'rows'];
        const pct = Math.round(fr.slice(0, x.index).reduce((s, f) => s + f, 0) * 100);
        d.setAttribute('aria-valuenow', String(pct));
      }
      for (const d of bars.values()) if (!keep.has(d) && d.isConnected) d.remove();
    }

    // ── the heads ──

    function render() {
      own.head.box.hidden = !R.on;
      if (!R.on) return;
      const one = R.grid.one;
      const n = R.panes.length;
      R.panes.forEach((p, k) => {
        const h = p.head;
        const id = idOf(p);
        const task = taskOf(id);
        const asks = asksOf(id);
        const isFocused = R.focus === k;
        h.box.hidden = false;
        h.box.classList.toggle('sv-focused', isFocused);
        h.dot.className = `jc-dot ${task ? (asks ? 'needs' : statusOf(task)) : 'past'}`;
        const words = named(task);
        const label = words || (task ? 'New session' : p.own ? 'No session open' : 'Pick a session');
        const key = JSON.stringify([words, label]);
        if (h.title.dataset.key !== key) {
          h.title.dataset.key = key;
          h.title.replaceChildren(words ? mine(el('span', '', words)) : el('span', '', label));
        }
        markOn(h.mark, isFocused ? '' : paneMark(asks, id != null && R.fresh.has(id)));
        const swapLabel = n === 2 ? 'Swap sides' : 'Swap with the next pane';
        if (h.swap.dataset.label !== swapLabel) {
          h.swap.dataset.label = swapLabel;
          h.swap.title = swapLabel === 'Swap sides' ? 'Swap sides' : 'Swap with the next pane';
          h.swap.setAttribute('aria-label', h.swap.title);
        }
        const tabsOn = one && isFocused;
        h.tabs.hidden = !tabsOn;
        h.title.hidden = tabsOn;
        if (tabsOn) renderTabs(h.tabs);
        else h.tabs.dataset.key = '';
      });
    }
    function renderTabs(box) {
      const items = R.panes.map((p, k) => {
        const id = idOf(p);
        const task = taskOf(id);
        const asks = asksOf(id);
        return { k, words: named(task), task: !!task, own: p.own, dot: task ? (asks ? 'needs' : statusOf(task)) : 'past', mark: k === R.focus ? '' : paneMark(asks, id != null && R.fresh.has(id)) };
      });
      const key = JSON.stringify([items, R.focus]);
      if (box.dataset.key === key) return;
      const hadFocus = box.contains(document.activeElement);
      box.dataset.key = key;
      box.replaceChildren(...items.map((x) => {
        const b = el('button', 'sv-tab');
        b.type = 'button';
        b.setAttribute('role', 'tab');
        b.setAttribute('aria-selected', String(x.k === R.focus));
        b.tabIndex = x.k === R.focus ? 0 : -1;
        b.dataset.pane = String(x.k);
        const mark = el('span', 'sv-mark');
        markOn(mark, x.mark);
        b.append(el('span', `jc-dot ${x.dot}`), x.words ? mine(el('span', 'sv-tab-title', x.words)) : el('span', 'sv-tab-title', x.task ? 'New session' : x.own ? 'No session open' : 'Pick a session'), mark);
        b.addEventListener('click', () => setFocus(x.k, true));
        return b;
      }));
      if (hadFocus) { const sel = box.querySelector('[aria-selected="true"]'); if (sel) sel.focus(); }
    }
    // The switcher's keys: ← → (and Home, End) go along the panes; Enter or Space opens one.
    function tabKeys(e) {
      const tabs = [...e.currentTarget.querySelectorAll('.sv-tab')];
      const i = tabs.indexOf(document.activeElement);
      if (i < 0) return;
      const to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: tabs.length - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      const t = tabs[(to + tabs.length) % tabs.length];
      for (const x of tabs) x.tabIndex = x === t ? 0 : -1;
      t.focus();
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
        // A session that's gone takes its pane with it; the others stay.
        const gone = frames().filter((p) => p.id != null && !live.has(p.id));
        if (gone.length) {
          for (const p of gone) closePane(at(p));
          jcNote('A session in split view has gone, so its pane closed.');
          return;
        }
        if (ccSelected != null && !live.has(ccSelected) && frames().some((p) => p.id != null)) { closePane(ownAt()); return; }
      }
      soon();
    });
    let archived = new Set();
    F.on('code_meta', (ev) => {
      if (ev && ev.full) metaFull = true;
      const S = shared();
      const now = new Set(S ? [...S.meta].filter(([, m]) => m && m.archived).map(([id]) => id) : []);
      if (R.on && R.restored) {
        // Archived while in a pane: it's put away, and the others stay.
        const put = R.panes.filter((p) => { const id = idOf(p); return id != null && now.has(id) && !archived.has(id); });
        for (const p of put) if (R.on && (!p.own || frames().some((q) => q.id != null))) closePane(at(p));
      }
      archived = now;
      if (R.restored) remember();
      tryRestore();
      soon();
    }, { replay: true });
    for (const type of ['approval', 'approval_resolved']) F.on(type, () => soon());
    // News in a pane without the focus marks its head.
    const unfocused = (id) => R.on && id != null && id !== idOf(focused()) && ids().includes(id);
    F.on('task_log', (ev) => {
      const role = ev.entry && ev.entry.role;
      if (unfocused(ev.id) && ['assistant', 'plan'].includes(role)) { R.fresh.add(ev.id); soon(); }
    });
    F.on('task_finished', (ev) => {
      if (unfocused(ev.id)) { R.fresh.add(ev.id); soon(); }
    });

    // ── kept in prefs, put back after a reload or a restart ──

    function remember() {
      if (!R.restored) return;
      for (const p of R.panes) { const k = keyOf(idOf(p)); if (k) p.key = k; else if (idOf(p) == null) p.key = ''; }
    }
    function save() {
      if (!R.restored) return;  // (what prefs keep isn't overwritten before it's been put back)
      clearTimeout(saveTimer);
      saveTimer = setTimeout(keep, 1500);  // (a burst of moves is kept once: each keeping redraws every window's settings)
    }
    // The window closing or reloading before then: kept now.
    root.addEventListener('pagehide', () => { if (saveTimer) { clearTimeout(saveTimer); keep(); } });
    function keep() {
      saveTimer = 0;
      const state = cleanState(!R.on ? { on: false, panes: [], cols: R.cols, rows: R.rows } : {  // (off: only the sizes are kept)
        on: true,
        panes: R.panes.map((p) => { const id = idOf(p); return { id, key: keyOf(id) || p.key || '' }; }),
        own: ownAt(),
        focus: R.focus,
        cols: R.cols,
        rows: R.rows,
        hub: hubId || '',
      });
      const text = JSON.stringify(state);
      if (text !== saved && F.send({ type: 'feature_prefs', changes: { code_split: state } })) saved = text;
    }
    function tryRestore() {
      if (R.restored || !kept) return;
      const known = metaFull || !shared() || (ccTasks.length > 0 && ccTasks.every((t) => keyOf(t.id)));
      if (!known) return;
      R.restored = true;
      const state = kept;
      kept = null;
      saved = JSON.stringify(state);
      R.cols = state.cols;
      R.rows = state.rows;
      const all = ccTasks.map((x) => x.id);
      const sameHub = !!state.hub && state.hub === hubId;
      const back = restorePanes(state, (p) => resolveSide(p, sameHub, all, keyOf), ccSelected);
      if (!back.ok) {  // its sessions aren't there any more: no split
        if (R.on) only(R.focus);
        if (state.on) save();
        return;
      }
      const mine_ = back.panes.find((x) => x.own);
      if (mine_.id != null && mine_.id !== ccSelected) F.selectHere(mine_.id);
      // The frames there are (after a restart) show the panes' sessions by their new numbers.
      const pool = frames();
      const next = back.panes.map((x) => {
        if (x.own) return own;
        const p = pool.shift() || makePane(x.id);
        p.id = x.id;
        p.key = keyOf(x.id);
        return p;
      });
      for (const p of pool) dropPane(p);
      turnOn();
      R.panes = next;
      R.focus = back.focus;
      for (const p of frames()) { if (p.frame) tell(p, { show: p.id, hub: hubId }); else mount(p); }
      for (const p of frames()) sync(p);
      changed();
      if (!cc.hidden && document.hasFocus()) placeFocus();  // (the window's own pane took it, picking its session)
    }
    F.on('hello', (ev) => {
      const hub = ev.hub_id || null;
      if (R.hub !== null && hub !== R.hub && R.restored && R.on) {
        // A restarted backend numbers its sessions anew: the split is found again by its keys.
        kept = cleanState({ on: true, panes: R.panes.map((p) => ({ key: p.key })), own: ownAt(), focus: R.focus, cols: R.cols, rows: R.rows });
        R.restored = false;
        for (const p of frames()) p.id = null;  // (its number was the old backend's)
        metaFull = false;
      }
      R.hub = hub;
      if (!R.restored && !kept) kept = cleanState(ev.prefs && ev.prefs.features && ev.prefs.features.code_split);
      tryRestore();
      // Without the sessions' keys in a while (no code_sessions on this backend): by number.
      setTimeout(() => { if (!R.restored && kept) { metaFull = true; tryRestore(); } }, 5000);
    }, { replay: true });

    // ── ways in: the More menu, /split; the session menu's item; dragging one over ──

    F.registerMoreItem({ label: 'Add a pane', note: 'Another session beside these', key: KEY, when: () => R.on && R.panes.length < MAX_PANES, run: () => add(null) });
    F.registerMoreItem({ label: 'Swap with the next pane', when: () => R.on, run: () => swapPane(R.focus) });
    F.registerMoreItem({ label: 'Close this pane', when: () => R.on, run: () => closePane(R.focus) });
    F.registerMoreItem({ label: 'Close split view', note: 'Keep only this session', when: () => R.on, run: () => only(R.focus) });

    // /split, typed in a pane (from: its index; the window's own when not said): that pane
    // takes the focus first, as typing there does.
    function command(arg, from = ownAt()) {
      claim();
      if (R.on && R.panes[from] && R.focus !== from) setFocus(from);
      const { action, query } = splitCommand(arg);
      if (action === 'open') { add(null); return; }
      if (action === 'close') { if (R.on) closePane(R.focus); else jcNote('There’s no split view to close.'); return; }
      if (action === 'off') { if (R.on) only(R.focus); else jcNote('There’s no split view to close.'); return; }
      if (action === 'swap') { if (R.on) swapPane(R.focus); else jcNote('There’s no split view to swap.'); return; }
      if (action === 'new') { startNew(); return; }
      const id = findSession(ccTasks, query);
      if (id == null) { jcNote(`No session matches “${query}”.`); return; }
      add(id);  // (on show already: that pane takes the focus)
    }

    function rowItem(id) {
      if (!R.on && id === ccSelected) return { label: 'Open in split view', note: 'Open here already', disabled: true };
      if (R.on && ids().includes(id)) return { label: 'Open in split view', note: 'In a pane already', disabled: true };
      if (R.panes.length >= MAX_PANES) return { label: 'Open in split view', note: 'All 6 panes in use', disabled: true };
      return { label: 'Open in split view', key: R.on ? '' : KEY, run: () => add(id) };
    }

    // Dragging a session from the sidebar (code-split.js starts it).
    const drop = el('div', 'sv-drop');
    drop.hidden = true;
    const zone = el('div', 'sv-drop-zone');
    const zoneLabel = el('span', 'sv-drop-label');
    zone.append(zoneLabel);
    drop.append(zone);
    cc.append(drop);
    let dragged = null;  // { task: id } or { session: id }
    // The panes as a drop sees them: one pane at a time, only the one on show.
    function dropBoxes() {
      const room = area();
      if (!R.on) return { room, boxes: [{ x: 0, y: 0, w: room.width, h: room.height }], map: [0], max: MAX_PANES };
      if (R.grid.one) return { room, boxes: [R.boxes[R.focus]], map: [R.focus], max: MAX_PANES - R.panes.length + 1 };
      return { room, boxes: R.boxes, map: R.panes.map((_, k) => k), max: MAX_PANES };
    }
    function targetAt(e) {
      const { room, boxes, map, max } = dropBoxes();
      const t = dropTarget(e.clientX - room.left, e.clientY - room.top, boxes, max);
      if (!t) return null;
      if (t.replace != null) return { replace: map[t.replace], box: boxes[t.replace] };
      const b = boxes[t.box];
      const w = Math.min(b.w * 0.34, 260);
      return { add: boxes.length === 1 ? map[0] + t.add : t.add, box: { x: t.side === 'left' ? b.x : b.x + b.w - w, y: b.y, w, h: b.h } };
    }
    function dragStart(what) {
      dragged = what;
      drop.hidden = false;
      zone.hidden = true;
    }
    function dragEnd() {
      dragged = null;
      drop.hidden = true;
    }
    drop.addEventListener('dragover', (e) => {
      if (!dragged) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const t = targetAt(e);
      zone.hidden = !t;
      if (!t) return;
      place(zone, t.box);
      zone.classList.toggle('add', t.add != null);
      const words = t.add != null ? (R.on ? 'Add a pane here' : 'Open beside') : (R.on ? 'Show here' : 'Open here');
      if (zoneLabel.dataset.words !== words) { zoneLabel.dataset.words = words; zoneLabel.textContent = words; }
    });
    drop.addEventListener('dragleave', (e) => { if (!drop.contains(e.relatedTarget)) zone.hidden = true; });
    drop.addEventListener('drop', (e) => {
      if (!dragged) return;
      e.preventDefault();
      e.stopPropagation();
      const what = dragged;
      const t = targetAt(e);
      dragEnd();
      if (t) land(what, t);
    });
    function land(what, t) {
      claim();
      if (what.session) {
        const h = codeHistory.find((x) => x.session_id === what.session);
        if (!h) return;
        const resume = { folder: h.folder, session_id: h.session_id, title: h.title || '' };
        if (t.add != null) { const p = add(null, { where: t.add }); if (p) tell(p, { resume }); return; }
        const p = R.panes[t.replace] || own;
        if (p.own) { if (R.on) setFocus(t.replace); resumeSession(h.folder, h); return; }
        tell(p, { resume });
        setFocus(t.replace, true);
        return;
      }
      const id = what.task;
      const j = R.on ? ids().indexOf(id) : -1;
      if (t.add != null) {
        if (j >= 0) { movePane(j, t.add); setFocus(ids().indexOf(id), true); return; }
        add(id, { where: t.add });
        return;
      }
      const k = t.replace;
      if (j >= 0) {  // on show already: it trades places with the pane it's dropped on
        if (j !== k) { const was = focused(); [R.panes[j], R.panes[k]] = [R.panes[k], R.panes[j]]; R.focus = at(was); changed(); }
        setFocus(ids().indexOf(id), true);
        return;
      }
      if (!R.on || R.panes[k].own) {
        if (R.on) setFocus(k);
        F.selectHere(id);
        if (cc.hidden) toggleCC(true);
        return;
      }
      showIn(k, id);
    }

    // What the split shows, for other modules (code-logbook.js: the index's pane marks).
    function state() {
      const list = ids();
      const firstFrame = frames()[0];
      return { on: R.on, panes: R.on ? list : [], own: ownAt(), focused: R.focus, focus: focused().own ? 'left' : 'right', right: R.on && firstFrame ? firstFrame.id : null };
    }

    return { on: () => R.on, state, add, command, key, rowItem, dragStart, dragEnd, help: HELP };
  };
})(typeof window === 'object' ? window : globalThis);
