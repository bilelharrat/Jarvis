// A short trace of how the app starts and runs, app.log in the folder backend.log is in: every step with the
// time and the seconds since the start, so a start that shows nothing at all can be read afterwards (what
// was reached, what the engine said, what Windows or Chromium reported). It never throws, and the file turns
// into app.1.log past 1 MB.
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 1024 * 1024;

function createTrace(file, { max = MAX_BYTES, fsys = fs, now = Date.now } = {}) {
  const began = now();
  let opened = false;

  function open() {
    opened = true;
    fsys.mkdirSync(path.dirname(file), { recursive: true });
    let size = 0;
    try { size = fsys.statSync(file).size; } catch { /* none yet */ }
    if (size > max) {
      try { fsys.renameSync(file, path.join(path.dirname(file), `${path.basename(file, '.log')}.1.log`)); } catch { /* a new one starts */ }
    }
  }

  function write(text) {
    const at = now();
    const line = `${new Date(at).toISOString()} +${((at - began) / 1000).toFixed(1)}s ${String(text).replace(/\r?\n/g, '\n    ')}\n`;
    try {
      if (!opened) open();
      fsys.appendFileSync(file, line);
    } catch { /* the trace is never a reason to stop */ }
    return line;
  }

  return { write, file };
}

// The last lines the backend printed (what it said before it stopped): kept in memory, a little at a time.
function createTail(maxChars = 4000) {
  let text = '';
  return {
    add(chunk) {
      text += String(chunk);
      if (text.length > maxChars * 2) text = text.slice(-maxChars);
    },
    reset() { text = ''; }, // a new start: only what it says counts
    last(lines = 6, chars = 900) {
      const kept = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).slice(-lines).join('\n');
      return kept.length > chars ? kept.slice(-chars) : kept;
    },
  };
}

module.exports = { createTrace, createTail, MAX_BYTES };
