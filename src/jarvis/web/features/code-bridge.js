// Pane frames fed from the window's one connection (the store: web/code-store.js).
//
// A pane frame (split view's second pane: app.js in ?bridge=1) is attached with
// jarvisCodeStore.attachFrame(frame): when it says it's ready it gets the latest state (the
// snapshot first), then every event in the order the window heard it; what it sends goes
// up the window's own socket. So both panes always agree, and a reconnect resumes both at
// once (the hub replays what was missed after its snapshot).
(function codeBridge(root) {
  'use strict';

  const F = root.jarvisFeatures;
  if (!F || !F.store) return;
  const store = F.store;  // app.js's own, fed every event the window hears

  const frames = new Map();  // a frame's window -> { ready }
  let online = false;
  function post(win, data) { try { win.postMessage(data, location.origin); } catch (_) { /* the frame went */ } }

  F.on('*', (ev) => {
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
