// Jarvis Code's one session store in the window, and the bridge that feeds pane frames from it.
//
// The window's socket is the only connection: every event it hears (numbered by the hub:
// seq) goes through here. The store keeps what any view of the sessions needs: each session
// (the hub's "tasks"), its sidebar facts (code_meta), each open transcript as it grew, and
// the latest of each kind of state event. A view subscribes and reads; it never needs a
// socket of its own.
//
// A pane frame (split view's second pane: app.js in ?bridge=1) is attached with
// jarvisCodeStore.attachFrame(frame): when it says it's ready it gets the latest state (the
// snapshot first), then every event in the order the window heard it; what it sends goes
// up the window's own socket. So both panes always agree, and a reconnect resumes both at
// once (the hub replays what was missed after its snapshot). Pure logic is exported for
// node --test (tests/web/code-store.test.mjs).
(function codeStore(root) {
  'use strict';

  // State a newly attached frame needs, newest of each, in this order (the snapshot first).
  const STATE = ['hello', 'prefs', 'tasks', 'code_meta', 'claude_projects', 'claude_history', 'code_copies'];
  const KEEP_ENTRIES = 400;  // per transcript, as the hub keeps them

  function createStore() {
    const s = {
      seq: 0,
      hub: null,
      tasks: new Map(),  // id -> the hub's public view of the session
      meta: new Map(),  // id -> its sidebar facts (code_meta)
      transcripts: new Map(),  // id -> entries, as far as they were heard
      latest: new Map(),  // state kind -> its newest event
      listeners: new Set(),
    };

    function entries(id) {
      if (!s.transcripts.has(id)) s.transcripts.set(id, []);
      return s.transcripts.get(id);
    }

    function setTasks(items) {
      const live = new Set();
      for (const t of items || []) { s.tasks.set(t.id, t); live.add(t.id); }
      for (const id of [...s.tasks.keys()]) {
        if (!live.has(id)) { s.tasks.delete(id); s.transcripts.delete(id); s.meta.delete(id); }
      }
    }

    // Take one event (in the order heard); true when the store changed.
    function take(ev) {
      if (!ev || typeof ev.type !== 'string') return false;
      if (ev.type === 'hello') {
        if (s.hub !== null && ev.hub_id !== s.hub) { s.tasks.clear(); s.meta.clear(); s.transcripts.clear(); }
        s.hub = ev.hub_id || null;
        s.seq = Number(ev.seq) || 0;
      } else if (ev.seq > s.seq) {
        s.seq = ev.seq;
      }
      if (STATE.includes(ev.type)) s.latest.set(ev.type, ev);
      let changed = true;
      switch (ev.type) {
        case 'hello': setTasks(ev.tasks); break;
        case 'tasks': setTasks(ev.items); break;
        case 'code_meta':
          if (ev.full) s.meta.clear();
          for (const [id, m] of Object.entries(ev.items || {})) s.meta.set(Number(id), m);
          break;
        case 'task_transcript': s.transcripts.set(ev.id, [...(ev.entries || [])].slice(-KEEP_ENTRIES)); break;
        case 'task_log': {
          const list = entries(ev.id);
          if (!ev.entry || list.some((e) => e.n === ev.entry.n)) { changed = false; break; }  // (a replay of one already here)
          list.push(ev.entry);
          if (list.length > KEEP_ENTRIES) list.splice(0, list.length - KEEP_ENTRIES);
          break;
        }
        case 'task_log_update': {
          // A step's result, to its entry (by the step's tool id).
          const entry = entries(ev.id).find((e) => e.tool_id && e.tool_id === ev.tool_id);
          if (entry) Object.assign(entry, { status: ev.status, output: ev.output });
          else changed = false;
          break;
        }
        case 'task_entry_meta': {
          const entry = entries(ev.id).find((e) => e.n === ev.n);
          if (entry) entry.uuid = ev.uuid; else changed = false;
          break;
        }
        default: changed = STATE.includes(ev.type);
      }
      if (changed) for (const fn of s.listeners) { try { fn(ev); } catch (err) { console.error('code store listener', err); } }
      return changed;
    }

    // The events a newly attached view needs to catch up: the latest state, snapshot first.
    function catchUp() {
      return STATE.filter((k) => s.latest.has(k)).map((k) => s.latest.get(k));
    }

    return {
      take,
      catchUp,
      subscribe(fn) { s.listeners.add(fn); return () => s.listeners.delete(fn); },
      task: (id) => s.tasks.get(id) || null,
      tasks: () => [...s.tasks.values()],
      meta: (id) => s.meta.get(id) || null,
      transcript: (id) => [...(s.transcripts.get(id) || [])],
      get seq() { return s.seq; },
      get hub() { return s.hub; },
    };
  }

  const api = { createStore, STATE };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }
  const F = root.jarvisFeatures;
  if (!F) return;

  const store = createStore();
  // The state kinds: what the window heard before this file loaded (replay), then each new.
  for (const kind of STATE) F.on(kind, (ev) => store.take(ev), { replay: true });

  const frames = new Map();  // a frame's window -> { ready }
  let online = false;
  function post(win, data) { try { win.postMessage(data, location.origin); } catch (_) { /* the frame went */ } }

  F.on('*', (ev) => {
    if (!STATE.includes(ev.type)) store.take(ev);  // (the state kinds are taken below, once)
    for (const [win, f] of frames) if (f.ready) post(win, { jarvisBridge: 'event', event: ev });
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
      F.send(e.data.msg);
    }
  });

  root.jarvisCodeStore = {
    store,
    // A pane frame fed from this window's connection (its src: app's page with ?bridge=1).
    attachFrame(frame) { if (frame && frame.contentWindow) frames.set(frame.contentWindow, { ready: false }); },
    detachFrame(frame) { if (frame && frame.contentWindow) frames.delete(frame.contentWindow); },
  };
})(typeof window === 'object' ? window : globalThis);
