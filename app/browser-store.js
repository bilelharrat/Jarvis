// The built-in browser's own settings, kept beside browser.json (which holds history,
// bookmarks and the ad blocker's choices) in browser-state.json: the search engine and each
// site's permissions. Read defensively (a hand-edited or damaged file keeps what's valid and
// never stops the app), saved atomically a moment after a change.
'use strict';

const fs = require('fs');
const { cleanSites } = require('./site-permissions');
const { ENGINES } = require('./url-input');

function clean(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    engine: Object.hasOwn(ENGINES, r.engine) ? r.engine : 'google',
    sites: cleanSites(r.sites),
  };
}

class BrowserStore {
  constructor(file, { delay = 400 } = {}) {
    this.file = file;
    this.delay = delay;
    this.timer = null;
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet, or damaged: defaults */ }
    this.data = clean(raw);
  }

  save() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.delay);
    if (this.timer.unref) this.timer.unref();
  }

  // Quitting: a save still waiting is written now.
  flushPending() {
    return this.timer ? this.flush() : true;
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    try {
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
      return true;
    } catch {
      return false;
    }
  }
}

module.exports = { BrowserStore, clean };
