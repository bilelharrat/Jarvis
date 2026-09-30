// The built-in browser's own settings and its last session, kept beside browser.json (which
// holds history, bookmarks and the ad blocker's choices) in browser-state.json: the search
// engine, each site's permissions and zoom, whether tabs reopen, whether JARVIS browses signed
// out, and the tabs that were open.
// Read defensively (a hand-edited or damaged file keeps what's valid and never stops the app),
// saved atomically a moment after a change.
'use strict';

const fs = require('fs');
const { cleanSites } = require('./site-permissions');
const { ENGINES } = require('./url-input');
const { historyWindow, ENTRIES_MAX } = require('./browser-lib');

const TABS_MAX = 60;
const ZOOM_SITES_MAX = 1000;
const TEXT_MAX = 300;

const text = (v, max = TEXT_MAX) => (typeof v === 'string' ? v.slice(0, max) : '');
const pageUrl = (u) => typeof u === 'string' && u.length <= 8000 && /^(https?:|file:)/i.test(u);

// { host: factor }: a zoom that isn't 100 %, between 25 % and 500 %.
function cleanZoom(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [host, factor] of Object.entries(raw)) {
    if (Object.keys(out).length >= ZOOM_SITES_MAX) break;
    const f = Number(factor);
    if (host && host.length <= 255 && Number.isFinite(f) && f >= 0.25 && f <= 5 && Math.abs(f - 1) > 0.001) out[host] = Math.round(f * 1000) / 1000;
  }
  return out;
}

function cleanTab(t) {
  if (!t || typeof t !== 'object') return null;
  // The pages that are pages, the one on show found among them, then at most ENTRIES_MAX of
  // them with it (a list cut from its end would lose where the tab was).
  const raw = Array.isArray(t.entries) ? t.entries : [];
  const at = Number.isInteger(t.index) ? t.index : raw.length - 1;
  const pages = [];
  let index = -1;
  raw.forEach((e, n) => {
    if (!e || !pageUrl(e.url)) return;
    if (n <= at) index = pages.length;
    pages.push({ url: e.url, title: text(e.title) });
  });
  const kept = historyWindow(pages, index === -1 && pages.length ? 0 : index);
  const url = pageUrl(t.url) ? t.url : kept.entries.length ? kept.entries[kept.index].url : '';
  if (!url) return null;
  return { url, title: text(t.title), pinned: t.pinned === true, entries: kept.entries, index: kept.index };
}

function cleanSession(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { tabs: [], active: 0 };
  const tabs = (Array.isArray(raw.tabs) ? raw.tabs : []).map(cleanTab).filter(Boolean).slice(0, TABS_MAX);
  const active = Number.isInteger(raw.active) && raw.active >= 0 && raw.active < tabs.length ? raw.active : 0;
  return { tabs, active };
}

function clean(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    engine: Object.hasOwn(ENGINES, r.engine) ? r.engine : 'google',
    restore: r.restore !== false,
    agentProfile: r.agentProfile === true,
    sites: cleanSites(r.sites),
    zoom: cleanZoom(r.zoom),
    session: cleanSession(r.session),
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

module.exports = { BrowserStore, clean, cleanSession, cleanZoom, TABS_MAX, ENTRIES_MAX };
