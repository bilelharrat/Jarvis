// Pane frames fed from the window's one connection (the store: web/code-store.js).
//
// A pane frame (split view's second pane: app.js in ?bridge=1) is attached with
// jarvisCodeStore.attachFrame(frame): when it says it's ready it gets the latest state (the
// snapshot first), then every event in the order the window heard it; what it sends goes
// up the window's own socket. So both panes always agree, and a reconnect resumes both at
// once (the hub replays what was missed after its snapshot).
//
// (CF2-1) An answer is the asking pane's alone. Each frame has a pane number; the ref of a
// command it sends that's answered by ref (a file read or save, a search, a "!" command…)
// goes up marked with it ("~sv3~" + its own ref), and the answer comes back to that frame
// only, with its own ref again. An answer with an unmarked ref is the window's own (or
// another window's): no frame gets it. Two panes on one file then never take each other's
// "Saved." for their own, and the window's 1 MB file answers aren't copied into every frame.
(function codeBridge(root) {
  'use strict';

  // Window commands whose ref is the asking page's own, and the answers that carry it back.
  const ASKS = new Set([
    'cw_file_read', 'cw_file_save', 'cw_file_compare', 'cw_file_stat', 'cw_search', 'cw_symbols',
    'cw_terms', 'cw_term_new', 'cw_term_close', 'cw_export', 'cw_media', 'task_bash', 'cw_bang_cancel',
  ]);
  const ANSWERS = new Set([
    'cw_file', 'cw_file_saved', 'cw_file_compare', 'cw_file_stat', 'cw_search', 'cw_symbols',
    'cw_terms', 'cw_term_new', 'cw_term_busy', 'cw_export', 'cw_media', 'task_bash', 'cw_bang_start', 'cw_bang_data',
  ]);
  const MARK = /^~sv(\d+)~/;

  // A frame's command on its way up: its ref marked with the frame's pane number.
  function marked(msg, pane) {
    if (!msg || !ASKS.has(msg.type) || typeof msg.ref !== 'string' || !msg.ref) return msg;
    return { ...msg, ref: `~sv${pane}~${msg.ref}` };
  }
  // Where an event the window heard goes: { pane: 0 } to every frame, { pane: n, event } to
  // that frame only (its ref as it sent it), null to none.
  function routeOf(ev) {
    const ref = ev && typeof ev.ref === 'string' ? ev.ref : '';
    const m = ref ? MARK.exec(ref) : null;
    if (m) return { pane: Number(m[1]), event: { ...ev, ref: ref.slice(m[0].length) } };
    if (ref && ANSWERS.has(ev.type)) return null;
    return { pane: 0, event: ev };
  }
  const api = { marked, routeOf, ASKS, ANSWERS };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F || !F.store) return;
  const store = F.store;  // app.js's own, fed every event the window hears

  const frames = new Map();  // a frame's window -> { ready, pane }
  let panes = 0;
  let online = false;
  function post(win, data) { try { win.postMessage(data, location.origin); } catch (_) { /* the frame went */ } }

  // Only what the hub says: jc_select is this window's own (which session its pane shows),
  // and a frame that heard it would take it for its own pick.
  const LOCAL = new Set(['jc_select']);
  F.on('*', (ev) => {
    if (!ev || LOCAL.has(ev.type)) return;
    const to = routeOf(ev);
    if (!to) return;
    for (const [win, f] of frames) {
      if (f.ready && (!to.pane || to.pane === f.pane)) post(win, { jarvisBridge: 'event', event: to.event });
    }
  });

  // The window's own connection, as the frames should see it.
  function setOnline(value) {
    if (value === online) return;
    online = value;
    for (const [win, f] of frames) if (f.ready) post(win, { jarvisBridge: 'online', value });
  }
  const offline = F.$('offline');
  if (offline && typeof MutationObserver !== 'undefined') {
    new MutationObserver(() => setOnline(offline.hidden)).observe(offline, { attributes: true, attributeFilter: ['hidden'] });
    online = offline.hidden;
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || !e.data || !frames.has(e.source)) return;
    const f = frames.get(e.source);
    if (e.data.jarvisBridge === 'ready') {
      f.ready = true;
      post(e.source, { jarvisBridge: 'online', value: online });
      for (const ev of store.catchUp()) post(e.source, { jarvisBridge: 'event', event: ev });
    } else if (e.data.jarvisBridge === 'send' && e.data.msg && typeof e.data.msg.type === 'string') {
      F.send(marked(e.data.msg, f.pane));
    }
  });

  root.jarvisCodeStore = {
    store,
    // A pane frame fed from this window's connection (its src: app's page with ?bridge=1).
    attachFrame(frame) { if (frame && frame.contentWindow) frames.set(frame.contentWindow, { ready: false, pane: ++panes }); },
    detachFrame(frame) { if (frame && frame.contentWindow) frames.delete(frame.contentWindow); },
  };
})(typeof window === 'object' ? window : globalThis);
