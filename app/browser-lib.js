// The built-in browser's everyday logic that needs no Electron (browser-parity.js wires it
// up): the user agent Google sign-in accepts; which window.open is a real popup, where it
// goes and what its title bar says; which sign-in request may ask; which failed load is a
// certificate's; the tabs kept for next time and their order (pinned tabs first); what the
// address bar suggests, in which order; each site's zoom. node --test tests/web/ covers it.
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

// ── the session: the tabs to reopen next time (never a private tab, a Jarvis Code session's,
// or a page whose address must not be kept), each with its back and forward list ──
const PAGE = /^(https?:|file:)/i;
const TITLE_MAX = 300;

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
    out.push({ url, title: String(t.title || '').slice(0, TITLE_MAX), pinned: Boolean(t.pinned), entries: index >= 0 ? entries : [], index: index >= 0 ? index : -1 });
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

module.exports = {
  cleanUserAgent, isPopup, hostOf, originOfUrl, popupTitle, popupBounds, POPUP_MIN,
  authAllowed, authInsecure, isCertError, certProblem,
  sessionOf, pinnedFirst, moveTab, suggest, pagesOf, PAUSE_MEDIA, zoomKey,
};
