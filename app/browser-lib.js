// The built-in browser's everyday logic that needs no Electron (browser-parity.js wires it
// up): the user agent Google sign-in accepts; which window.open is a real popup, where it
// goes and what its title bar says; which sign-in request may ask; which failed load is a
// certificate's; the tabs kept for next time and their order (pinned tabs first); what the
// address bar suggests, in which order; each site's zoom; bookmark folders; and what's
// imported from another browser. node --test tests/web/ covers it.
'use strict';

// ── the user agent: Chromium's own, without the app's name and Electron's tokens (Google's
// sign-in refuses a browser that says it's Electron). Nothing else is changed or claimed. ──
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanUserAgent(ua, appName = '') {
  let out = String(ua || '').replace(/\s*\bElectron\/\S+/g, '');
  if (appName) out = out.replace(new RegExp(`\\s*${escapeRe(appName)}/\\S+`, 'g'), '');
  return out.replace(/\s{2,}/g, ' ').trim();
}

// ── popups: window.open with window features (a size, popup=1) is a real window with its
// opener, as sign-in and payment pages expect; a link with target=_blank, or window.open
// without features, is a new tab ──
function isPopup(details = {}) {
  const url = String(details.url || '');
  return details.disposition === 'new-window' && /\S/.test(String(details.features || ''))
    && (/^https?:\/\//i.test(url) || url === 'about:blank' || url === '');
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

function originOfUrl(url) {
  try {
    const u = new URL(String(url || ''));
    return /^https?:$/.test(u.protocol) ? u.origin : '';
  } catch {
    return '';
  }
}

// A popup's title bar names the site it's really on: a page can't pass itself off as another.
function popupTitle(url, title) {
  const host = hostOf(url);
  const own = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!host) return own;
  return own && own !== host && !own.startsWith(`${host}/`) ? `${host} — ${own}` : host;
}

// Where a popup opens: the size the page asked for (window features), at least big enough to
// use and never past the screen's edge; where the page asked, else centred on the window it
// came from. area and near are { x, y, width, height }.
const POPUP_MIN = { width: 320, height: 240 };
const POPUP_DEFAULT = { width: 500, height: 600 };

function popupBounds(features, area, near = null) {
  const f = {};
  for (const part of String(features || '').split(',')) {
    const at = part.indexOf('=');
    const key = (at < 0 ? part : part.slice(0, at)).trim().toLowerCase();
    if (key) f[key] = at < 0 ? '' : part.slice(at + 1).trim();
  }
  const num = (...keys) => {
    for (const k of keys) {
      const n = Number.parseInt(f[k], 10);
      if (Number.isFinite(n)) return n;
    }
    return null;
  };
  const width = Math.min(area.width, Math.max(POPUP_MIN.width, num('width', 'innerwidth') ?? POPUP_DEFAULT.width));
  const height = Math.min(area.height, Math.max(POPUP_MIN.height, num('height', 'innerheight') ?? POPUP_DEFAULT.height));
  let x = num('left', 'screenx');
  let y = num('top', 'screeny');
  if (x === null || y === null) {
    const c = near || area;
    x = Math.round(c.x + (c.width - width) / 2);
    y = Math.round(c.y + (c.height - height) / 2);
  }
  return {
    x: Math.min(area.x + area.width - width, Math.max(area.x, x)),
    y: Math.min(area.y + area.height - height, Math.max(area.y, y)),
    width,
    height,
  };
}

// ── a site asking for a user name and password (HTTP sign-in): the page's own site, or the
// page a tab is going to, may ask; another site's picture or script inside the page may not
// (Chrome's rule: a sign-in box from a site you didn't open is how passwords get phished).
// A proxy always asks. ──
function authAllowed({ url, page, going, proxy = false } = {}) {
  if (proxy) return true;
  const origin = originOfUrl(url);
  return Boolean(origin) && (origin === originOfUrl(going) || origin === originOfUrl(page));
}

// A sign-in over plain http sends the password as it is (a proxy's too). This Mac and the
// local network aside.
function authInsecure(url) {
  try {
    const u = new URL(String(url || ''));
    if (u.protocol === 'https:') return false;
    return !/^(localhost|127(?:\.\d+){3}|\[::1\]|.*\.localhost)$/i.test(u.hostname);
  } catch {
    return true;
  }
}

// ── certificate errors: net error codes -200 to -299 ──
const isCertError = (code) => Number(code) <= -200 && Number(code) > -300;

// What's wrong with a site's certificate (Chromium's net error names), as a key the window and
// the Mac's box both put in words.
function certProblem(error) {
  const e = String(error || '');
  if (/AUTHORITY_INVALID/.test(e)) return 'authority';
  if (/DATE_INVALID/.test(e)) return 'date';
  if (/COMMON_NAME_INVALID/.test(e)) return 'name';
  if (/REVOKED/.test(e)) return 'revoked';
  if (/WEAK/.test(e)) return 'weak';
  return 'other';
}

// ── the session: the tabs to reopen next time (never a private tab, an Eden Code session's,
// or a page whose address must not be kept), each with its back and forward list ──
const PAGE = /^(https?:|file:)/i;
const TITLE_MAX = 300;
const ENTRIES_MAX = 25; // a tab's back and forward list, as kept

// At most max entries of a back and forward list, always with the page on show among them
// (its pages before it first, then after it); index: where the page on show is in them.
function historyWindow(entries, index, max = ENTRIES_MAX) {
  if (!entries.length || index < 0) return { entries: [], index: -1 };
  const at = Math.min(index, entries.length - 1);
  const start = Math.max(0, Math.min(at - (max - 1), entries.length - max));
  return { entries: entries.slice(start, start + max), index: at - start };
}

function sessionOf(tabs, { active = 0, keep = () => true } = {}) {
  const out = [];
  let activeAt = 0;
  tabs.forEach((t, i) => {
    if (!t || t.skip) return;
    const url = String(t.url || '');
    if (!PAGE.test(url) || !keep(url)) return;
    const all = Array.isArray(t.entries) ? t.entries : [];
    const at = Number.isInteger(t.index) ? t.index : all.length - 1;
    const entries = [];
    let index = -1;
    all.forEach((e, n) => {
      if (!e || !PAGE.test(String(e.url || '')) || !keep(e.url)) return;
      if (n <= at) index = entries.length; // the page on show, or the last one kept before it
      entries.push({ url: e.url, title: String(e.title || '').slice(0, TITLE_MAX) });
    });
    if (i === active) activeAt = out.length;
    const kept = historyWindow(entries, index);
    out.push({ url, title: String(t.title || '').slice(0, TITLE_MAX), pinned: Boolean(t.pinned), entries: kept.entries, index: kept.index });
  });
  return { tabs: out, active: activeAt };
}

// ── tab order: pinned tabs first; a dragged tab stays in its own group ──
function pinnedFirst(list) {
  return [...list.filter((t) => t.pinned), ...list.filter((t) => !t.pinned)];
}

function moveTab(list, item, to) {
  const from = list.indexOf(item);
  if (from < 0) return list.slice();
  const out = list.slice();
  out.splice(from, 1);
  const pinned = out.filter((t) => t.pinned).length;
  const lo = item.pinned ? 0 : pinned;
  const hi = item.pinned ? pinned : out.length;
  out.splice(Math.min(hi, Math.max(lo, Math.round(Number(to) || 0))), 0, item);
  return out;
}

// ── what the address bar suggests: open tabs to switch to, bookmarks and history, ranked by
// how well they match what's typed and how often and how lately the page was visited ──
const DAY = 24 * 60 * 60 * 1000;

function afterScheme(url) {
  return String(url || '').replace(/^[a-z]+:\/\/(www\.)?/i, '').toLowerCase();
}

// The host of an address as afterScheme gives it (no www., no port): read off the string,
// since a URL parse for every page on every keystroke is the slow part.
function hostPart(path) {
  const end = path.search(/[/?#]/);
  const host = end < 0 ? path : path.slice(0, end);
  return host.replace(/:\d+$/, '');
}

// One entry per page: its visits (each one in history, or the count an import brought), its
// last visit and title.
function pagesOf(history = []) {
  const pages = new Map();
  for (const h of history) {
    if (!h || typeof h.url !== 'string') continue;
    const p = pages.get(h.url) || { url: h.url, title: '', visits: 0, last: 0 };
    p.visits += Math.max(1, Math.min(100000, Number(h.n) || 1));
    const at = Number(h.at) || 0;
    if (at >= p.last) { p.last = at; if (h.title) p.title = String(h.title); }
    if (!p.title && h.title) p.title = String(h.title);
    pages.set(h.url, p);
  }
  return pages;
}

function matcher(tokens) {
  const rules = tokens.map((t) => ({ t, word: new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}`, 'u'), part: new RegExp(`(^|[/.?=&#_-])${escapeRe(t)}`) }));
  return (url, title) => {
    const words = String(title || '').toLowerCase();
    const path = afterScheme(url);
    if (!tokens.every((t) => words.includes(t) || path.includes(t))) return -1;
    const host = hostPart(path);
    const first = tokens[0];
    let score = 0;
    if (host.startsWith(first)) score += 120;
    else if (host.split('.').some((part) => part.startsWith(first))) score += 70;
    else if (path.startsWith(first)) score += 60;
    for (const r of rules) {
      if (r.word.test(words)) score += 25;
      else if (words.includes(r.t)) score += 8;
      if (r.part.test(path)) score += 10;
    }
    return score;
  };
}

function frecency(visits, last, now) {
  const age = now - (Number(last) || 0);
  const recent = age < DAY ? 30 : age < 7 * DAY ? 20 : age < 30 * DAY ? 10 : 0;
  return 18 * Math.log2(1 + Math.max(0, Number(visits) || 0)) + recent;
}

// Each page once: an open tab that matches comes first (switched to, not loaded again), a
// bookmark ranks above the same page only visited. tabs: [{ id, url, title, active }].
function suggest(query, { tabs = [], bookmarks = [], history = [], now = Date.now(), limit = 8 } = {}) {
  const tokens = String(query || '').toLowerCase().slice(0, 200).split(/\s+/).filter(Boolean).slice(0, 8);
  if (!tokens.length) return [];
  const match = matcher(tokens);
  const pages = pagesOf(history);
  const found = new Map(); // url -> { url, title, bookmark, folder, tab }
  const add = (url, title) => {
    let f = found.get(url);
    if (!f) { f = { url, title: '' }; found.set(url, f); }
    if (!f.title && title) f.title = String(title);
    return f;
  };
  for (const t of tabs) {
    if (t && typeof t.url === 'string' && PAGE.test(t.url) && !t.active) add(t.url, t.title).tab = t.id;
  }
  for (const b of bookmarks) {
    if (!b || typeof b.url !== 'string') continue;
    const f = add(b.url, b.title);
    f.bookmark = true;
    if (b.folder) f.folder = String(b.folder);
  }
  for (const p of pages.values()) add(p.url, p.title);
  const rows = [];
  for (const f of found.values()) {
    const m = match(f.url, f.title);
    if (m < 0) continue;
    const page = pages.get(f.url);
    const tab = f.tab !== undefined;
    const score = m + (f.bookmark ? 25 : 0) + (tab ? 100 : 0) + (page ? frecency(page.visits, page.last, now) : 0);
    const kind = tab ? 'tab' : f.bookmark ? 'bookmark' : 'history';
    rows.push({ kind, url: f.url, title: f.title.slice(0, TITLE_MAX), score, ...(tab ? { tab: f.tab } : {}), ...(f.folder ? { folder: f.folder } : {}) });
  }
  return rows.sort((a, b) => b.score - a.score || a.url.length - b.url.length).slice(0, limit)
    .map(({ score, ...row }) => row);
}

// ── media: every video and sound on the page paused (the dock closed), frame by frame ──
const PAUSE_MEDIA = "(() => { let n = 0; for (const m of document.querySelectorAll('video, audio')) { if (!m.paused) { m.pause(); n += 1; } } return n; })()";

// ── zoom: kept per site (its host), as in Chrome ──
function zoomKey(url) {
  try {
    const u = new URL(String(url || ''));
    return /^https?:$/.test(u.protocol) ? u.host : u.protocol === 'file:' ? 'file://' : '';
  } catch {
    return '';
  }
}

// ── bookmark folders: a bookmark's folder is a path ("Work/Reading"), none at the top ──
const FOLDER_DEPTH = 6;

function cleanFolder(path) {
  return String(path || '').split('/').map((p) => p.replace(/\s+/g, ' ').trim().slice(0, 60)).filter(Boolean)
    .slice(0, FOLDER_DEPTH).join('/');
}

// Every folder the bookmarks are in, and the folders those are in, sorted.
function folders(bookmarks = []) {
  const found = new Set();
  for (const b of bookmarks) {
    const f = cleanFolder(b && b.folder);
    if (!f) continue;
    const parts = f.split('/');
    for (let i = 1; i <= parts.length; i++) found.add(parts.slice(0, i).join('/'));
  }
  return [...found].sort((a, b) => a.localeCompare(b));
}

function editBookmark(bookmarks, url, { title, folder } = {}) {
  const b = bookmarks.find((x) => x && x.url === url);
  if (!b) return false;
  if (typeof title === 'string') b.title = title.replace(/\s+/g, ' ').trim().slice(0, 200) || b.url;
  if (typeof folder === 'string') {
    const f = cleanFolder(folder);
    if (f) b.folder = f; else delete b.folder;
  }
  return true;
}

// A folder renamed (or moved: "Work/Reading" to "Reading"), its subfolders with it; the
// number of bookmarks that moved.
function renameFolder(bookmarks, from, to) {
  const old = cleanFolder(from);
  const next = cleanFolder(to);
  if (!old) return 0;
  let n = 0;
  for (const b of bookmarks) {
    const f = cleanFolder(b && b.folder);
    if (f === old || f.startsWith(`${old}/`)) {
      const moved = cleanFolder(next + f.slice(old.length));
      if (moved) b.folder = moved; else delete b.folder;
      n += 1;
    }
  }
  return n;
}

// ── imports: another browser's bookmarks (under "Imported from <it>") and history, into
// this one's; a page already bookmarked or in history isn't added twice ──
const BOOKMARKS_MAX = 5000;
const HISTORY_MAX = 2000;

function mergeImport(store, data = {}, { label = 'Imported' } = {}) {
  const added = { bookmarks: 0, history: 0 };
  const have = new Set(store.bookmarks.map((b) => b && b.url));
  for (const b of Array.isArray(data.bookmarks) ? data.bookmarks : []) {
    if (store.bookmarks.length >= BOOKMARKS_MAX) break;
    if (!b || typeof b.url !== 'string' || !/^https?:\/\//i.test(b.url) || b.url.length > 4000 || have.has(b.url)) continue;
    have.add(b.url);
    const folder = cleanFolder(`${label}/${b.folder || ''}`);
    store.bookmarks.push({ url: b.url, title: String(b.title || b.url).slice(0, 200), ...(folder ? { folder } : {}) });
    added.bookmarks += 1;
  }
  const seen = new Set(store.history.map((h) => h && h.url));
  const incoming = [];
  for (const h of Array.isArray(data.history) ? data.history : []) {
    if (incoming.length >= HISTORY_MAX) break;
    if (!h || typeof h.url !== 'string' || !/^https?:\/\//i.test(h.url) || h.url.length > 4000 || seen.has(h.url)) continue;
    const at = Number(h.at);
    if (!Number.isFinite(at) || at <= 0) continue;
    seen.add(h.url);
    incoming.push({ url: h.url, title: String(h.title || '').slice(0, 300), at, n: Math.max(1, Math.min(100000, Math.round(Number(h.visits) || 1))) });
  }
  if (incoming.length) {
    const merged = [...store.history, ...incoming].sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
    const kept = merged.slice(-HISTORY_MAX);
    const keptSet = new Set(kept);
    added.history = incoming.filter((h) => keptSet.has(h)).length;
    store.history.splice(0, store.history.length, ...kept);
  }
  return added;
}

module.exports = {
  cleanUserAgent, isPopup, hostOf, originOfUrl, popupTitle, popupBounds, POPUP_MIN,
  authAllowed, authInsecure, isCertError, certProblem,
  sessionOf, pinnedFirst, moveTab, suggest, pagesOf, PAUSE_MEDIA, zoomKey,
  cleanFolder, folders, editBookmark, renameFolder, mergeImport, BOOKMARKS_MAX, HISTORY_MAX,
  historyWindow, ENTRIES_MAX,
};
