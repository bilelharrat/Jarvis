// Eden Code for screen readers (Daredevil depends on it): one short live status line.
//
// The transcript is a log (index.html: role="log", aria-live off), so streamed words and its
// 400 entries are never read out as they arrive; what's worth hearing is said once, here, in
// a line of its own: "Eden Code finished: 3 files changed." or "Eden Code stopped with an
// error." (another session's says its name). The reader reads the transcript when the owner
// moves into it. Window events: task_finished (heard, Eden Code sessions only). No model is
// called; nothing is sent.
(function (root) {
  'use strict';

  // The line for a finished turn, or '' (not Eden Code's, or stopped by the owner: not news).
  // shownId: the session on show (its line needs no name).
  function finishedLine(ev, shownId) {
    if (!ev || ev.task_kind !== 'code') return '';
    const name = ev.id === shownId ? '' : String(ev.label || ev.folder || '').trim();
    const who = name ? `Eden Code (${name})` : 'Eden Code';
    if (ev.status === 'failed') return `${who} stopped with an error.`;
    if (ev.status !== 'done') return '';
    const n = Array.isArray(ev.files) ? ev.files.length : 0;
    return n ? `${who} finished: ${n} file${n === 1 ? '' : 's'} changed.` : `${who} finished.`;
  }

  if (typeof module === 'object' && module.exports) { module.exports = { finishedLine }; return; }
  const F = root.jarvisFeatures;
  const cc = root.document && root.document.getElementById('cc');
  if (!F || !cc) return;

  const line = root.document.createElement('p');
  line.id = 'jc-live';
  line.className = 'sr-only';
  line.setAttribute('role', 'status');
  line.setAttribute('aria-live', 'polite');
  line.setAttribute('aria-atomic', 'true');
  cc.append(line);

  let timer = 0;
  function say(text) {
    // Emptied first, then set: the same words twice in a row are still read the second time.
    line.textContent = '';
    root.clearTimeout(timer);
    timer = root.setTimeout(() => { line.textContent = F.t(text); }, 60);
  }

  F.on('task_finished', (ev) => {
    const shown = F.currentTask && F.currentTask();
    const text = finishedLine(ev, shown ? shown.id : null);
    if (text && !cc.hidden) say(text);
  });
})(typeof window !== 'undefined' ? window : globalThis);
