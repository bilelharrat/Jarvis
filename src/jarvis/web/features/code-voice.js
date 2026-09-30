// Jarvis Code by voice across sessions, the window's side (features/code_voice.py):
// - tells the backend when the owner looks at a session (for "catch me up": what's new
//   since they last looked);
// - shows the file "open hub.py" or "read lines 10 to 20 of hub.py" asked for in the
//   Files viewer, those lines marked;
// - point and speak: says when hand control points at the built-in browser's page or the
//   iOS Simulator pane, and, asked, what the hand points at (a page element, or a spot on
//   the simulator's screen) with a picture of it;
// - offers the other sessions as @mentions in the composer: a message that opens with
//   "@session-3" goes to session 3 (the backend routes it).
// Pure helpers are exported for node --test (tests/web/code-voice.test.mjs).
(function (root) {
  'use strict';

  const SEEN_EVERY_MS = 1500; // one "looked at it" a session per this long, not one per event

  // Whether the owner can see a session now: the window in front, Jarvis Code open on it.
  function looking(doc, panelHidden) {
    return doc.visibilityState === 'visible' && doc.hasFocus() && !panelHidden;
  }

  // The lines to mark as indexes [from, to) of a file shown with `count` lines.
  function lineSpan(start, end, count) {
    const from = Math.max(0, Math.min(count, (Number(start) || 1) - 1));
    const to = Math.max(from, Math.min(count, Number(end) || Number(start) || 0));
    return [from, to];
  }

  // Where a point is on a picture, in fractions of it (kept on it).
  function spotOn(point, rect) {
    const clamp = (v) => Math.min(1, Math.max(0, v));
    return {
      x: rect.width ? clamp((point.x - rect.left) / rect.width) : 0,
      y: rect.height ? clamp((point.y - rect.top) / rect.height) : 0,
    };
  }

  function inside(point, rect) {
    return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom;
  }

  // The part of a w × h picture to show around a spot: a square `share` of its shorter
  // side, kept inside the picture.
  function cropBox(spot, w, h, share = 0.4) {
    const side = Math.max(1, Math.round(Math.min(w, h) * share));
    const sx = Math.min(Math.max(0, Math.round(spot.x * w - side / 2)), Math.max(0, w - side));
    const sy = Math.min(Math.max(0, Math.round(spot.y * h - side / 2)), Math.max(0, h - side));
    return { sx, sy, sw: Math.min(side, w), sh: Math.min(side, h) };
  }

  // The other sessions a composer's "@…" can mean, by number, title or project: the
  // composer's suggestions (the current session left out).
  function sessionMentions(query, tasks, currentId, limit = 6) {
    const q = String(query || '').toLowerCase().replace(/^session-?/, '');
    return (tasks || [])
      .filter((t) => t && t.kind === 'code' && t.id !== currentId)
      .filter((t) => !q || String(t.id).startsWith(q) || String(t.title || t.prompt || '').toLowerCase().includes(q)
        || String(t.folder || '').toLowerCase().includes(q))
      .slice(0, limit)
      .map((t) => ({ label: `@session-${t.id}`, help: `${String(t.title || t.prompt || '').slice(0, 60)} · ${t.folder}`, value: `session-${t.id}` }));
  }

  const api = { looking, lineSpan, spotOn, inside, cropBox, sessionMentions, SEEN_EVERY_MS };
  if (typeof module === 'object' && module.exports) { module.exports = api; return; }

  const F = root.jarvisFeatures;
  if (!F) return;

  // ── "catch me up": the sessions the owner has looked at ──
  const seenAt = new Map(); // session id -> when it was last reported
  function reportSeen(id) {
    if (!id || !looking(document, F.$('cc').hidden)) return;
    const now = Date.now();
    if (now - (seenAt.get(id) || 0) < SEEN_EVERY_MS) return;
    seenAt.set(id, now);
    F.send({ type: 'code_voice_seen', id });
  }
  const shown = () => { const t = F.currentTask(); return t ? t.id : null; };
  F.on('task_transcript', (ev) => { if (ev.id === shown()) reportSeen(ev.id); });
  F.on('task_finished', (ev) => { if (ev.id === shown()) reportSeen(ev.id); });
  window.addEventListener('focus', () => reportSeen(shown()));

  // ── "open hub.py", "read lines 10 to 20 of hub.py": Jarvis Code's Files viewer ──
  let wanted = null; // { path, start, end } until that file's content arrives
  F.on('code_voice_file', (ev) => {
    if (typeof fileView === 'undefined' || !ev.path) return;
    wanted = { path: ev.path, start: ev.start || 0, end: ev.end || 0 };
    if (wanted.start) viewSource = true; // lines are shown as lines, never as a preview
    fileView = { path: ev.path };
    F.openPane('files');
    F.send({ type: 'file_read', directory: ev.directory, path: ev.path });
  });
  F.on('file_content', (ev) => {
    if (!wanted || ev.path !== wanted.path) return;
    const { start, end } = wanted;
    wanted = null;
    if (!start) return;
    const lines = document.querySelectorAll('#jc-pane-body .jc-viewer pre.jc-code > .ln');
    const [from, to] = lineSpan(start, end, lines.length);
    for (let i = from; i < to; i += 1) lines[i].classList.add('cv-mark');
    if (lines[from]) lines[from].scrollIntoView({ block: 'center' });
  });

  // ── point and speak: "make this bigger" with the hand on it ──
  const simImage = () => document.querySelector('#jc-pane-body .sim-img');
  function simInView() {
    return !F.$('jc-pane').hidden && typeof currentPane !== 'undefined' && currentPane === 'sim' && Boolean(simImage());
  }
  function pointingNow() {
    if (typeof handsOn === 'undefined' || !handsOn) return false;
    return (typeof browserOpenNow !== 'undefined' && browserOpenNow) || simInView();
  }
  let pointing = false;
  function reportHand(always) {
    const now = pointingNow();
    if (now === pointing && !always) return;
    pointing = now;
    F.send({ type: 'code_voice_hand', pointing: now });
  }
  const watch = new MutationObserver(() => reportHand(false));
  for (const id of ['hand-panel', 'browser', 'jc-pane']) {
    const node = F.$(id);
    if (node) watch.observe(node, { attributes: true, attributeFilter: ['hidden'] });
  }
  if (F.$('jc-pane-body')) watch.observe(F.$('jc-pane-body'), { childList: true });
  F.on('hello', () => reportHand(true)); // a backend that (re)connects hears it

  function crop(img, spot) {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return null;
    const { sx, sy, sw, sh } = cropBox(spot, w, h);
    const scale = Math.min(1, 640 / Math.max(sw, sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    try { return { media_type: 'image/png', data: canvas.toDataURL('image/png').split(',')[1] }; } catch (_) { return null; }
  }

  // What the hand points at now: the page element the page itself reports (with its
  // picture, cut out by the app), or the spot on the simulator's screen.
  async function pointedAt() {
    if (typeof handsOn === 'undefined' || !handsOn) return null;
    const browser = root.jarvisApp && root.jarvisApp.browser;
    if (typeof browserOpenNow !== 'undefined' && browserOpenNow && browser) {
      const r = await browser.command({ action: 'pointed' });
      if (!r || !r.ok) return null;
      return {
        kind: 'page', tag: r.tag, text: r.text, selector: r.selector, box: r.box, url: r.url, title: r.title,
        image: r.png ? { media_type: 'image/png', data: r.png } : null,
      };
    }
    const img = simImage();
    if (!simInView() || !img || typeof handPoint === 'undefined') return null;
    const rect = img.getBoundingClientRect();
    if (!inside(handPoint, rect)) return null;
    const spot = spotOn(handPoint, rect);
    const device = document.querySelector('#jc-pane-body .sim-pick-name');
    return { kind: 'simulator', x: spot.x, y: spot.y, device: device ? device.textContent : '', image: crop(img, spot) };
  }
  F.on('code_voice_point', async (ev) => {
    let ref = null;
    try { ref = await pointedAt(); } catch (_) { ref = null; }
    F.send({ type: 'code_voice_pointed', id: ev.id, ref });
  });

  // ── @session mentions: only as the first thing in a message (that's where they route) ──
  if (F.registerMentions) {
    F.registerMentions((query, before) => {
      if (!/^@[\w-]*$/.test(before.trim())) return [];
      const current = F.currentTask();
      return sessionMentions(query, typeof ccTasks !== 'undefined' ? ccTasks : [], current ? current.id : null);
    });
  }
})(typeof window === 'object' ? window : globalThis);
