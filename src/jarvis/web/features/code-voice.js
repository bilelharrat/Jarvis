// Jarvis Code by voice across sessions, the window's side (features/code_voice.py):
// - tells the backend when the owner looks at a session (for "catch me up": what's new
//   since they last looked);
// - shows the file "open hub.py" or "read lines 10 to 20 of hub.py" asked for in the
//   Files viewer, those lines marked.
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

  const api = { looking, lineSpan, SEEN_EVERY_MS };
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
})(typeof window === 'object' ? window : globalThis);
