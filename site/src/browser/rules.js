// The cloud browser's rules, without Cloudflare (browser/session.js runs them; test/browser.test.js
// checks them): what an address bar entry becomes, which addresses the browser may load, the
// ad and tracker blocklist, what the page's mouse and keys become in Chrome (CDP), how fast a
// viewer may send, the history, bookmarks and suggestions (as J.A.R.V.I.S.'s own browser ranks
// them: app/browser-lib.js), zoom, and each account's monthly browser minutes.

import { BLOCKED_HOSTS } from './blocklist.js';

export const LIMITS = {
  idleMs: 5 * 60 * 1000, // nothing from the viewer this long: the browser closes
  maxSessionMs: 60 * 60 * 1000, // one browser at most this long; a new one starts on the next visit
  keepAliveMs: 10 * 60 * 1000, // Browser Rendering's keep_alive (its maximum)
  graceMs: 60 * 1000, // the panel closed (socket gone): the browser waits this long for it to come back
  maxTabs: 8,
  history: 2000,
  bookmarks: 2000,
  zoomSites: 1000,
  allowSites: 500,
  titleMax: 300,
  urlMax: 8000,
  findMax: 200,
  textMax: 40000, // page text handed to Eden's chat ("Ask about this page")
  insertMax: 5000, // characters typed or pasted in one message
};
/** Browser minutes a month per account (Browser Rendering is billed by the hour). */
export const MINUTES = { free: 60, plus: 600 };

export const ENGINES = {
  google: { name: 'Google', search: 'https://www.google.com/search?q=', home: 'https://www.google.com' },
  duckduckgo: { name: 'DuckDuckGo', search: 'https://duckduckgo.com/?q=', home: 'https://duckduckgo.com' },
  bing: { name: 'Bing', search: 'https://www.bing.com/search?q=', home: 'https://www.bing.com' },
  brave: { name: 'Brave', search: 'https://search.brave.com/search?q=', home: 'https://search.brave.com' },
  kagi: { name: 'Kagi', search: 'https://kagi.com/search?q=', home: 'https://kagi.com' },
};
export const engineOf = (id) => ENGINES[id] || ENGINES.duckduckgo;
export const searchUrl = (words, id) => engineOf(id).search + encodeURIComponent(String(words ?? '').trim());

// ── which addresses ──

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const HOST = /^(\[[0-9A-Fa-f:.]+\]|[\w-]+(?:\.[\w-]+)*)(?::(\d{1,5}))?([/?#]\S*)?$/;

/** An IPv4 address that isn't on the public internet. */
function privateV4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 // this network, private, loopback, multicast and reserved
    || (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
    || (a === 169 && b === 254) // link-local (cloud metadata)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && p[2] === 0) || (a === 192 && b === 0 && p[2] === 2)
    || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && p[2] === 100) || (a === 203 && b === 0 && p[2] === 113);
}

/** A host (as URL gives it: lowercase, IPs normalized, IPv6 in brackets) that is this machine, a local network or not public. */
export function privateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || /\.(localhost|local|internal|intranet|lan|home|corp|home\.arpa|localdomain)$/.test(h)) return true;
  if (!h.includes('.') && !h.startsWith('[')) return true; // a bare name: only a local network has those
  if (IPV4.test(h)) return privateV4(h);
  if (h.startsWith('[')) {
    const v6 = h.slice(1, -1);
    if (v6 === '::' || v6 === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6);
    if (mapped) return privateV4(mapped[1]);
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(v6)) { // ::ffff:7f00:1 (URL's form of ::ffff:127.0.0.1)
      const [hi, lo] = v6.slice(7).split(':').map((x) => parseInt(x, 16));
      return privateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::|$)/.exec(v6); // 6to4: the IPv4 address sits in the next 32 bits
    if (sixToFour) {
      const [hi, lo] = [parseInt(sixToFour[1], 16), parseInt(sixToFour[2], 16)];
      if (privateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)) return true;
    }
    return /^(f[cd]|fe[89a-f]|ff)/.test(v6) || /^(64:ff9b|2001:db8|100::)/.test(v6) || /^::/.test(v6);
  }
  return false;
}

/**
 * Whether the browser may load an address. kind: 'page' (what a tab shows: http and https only)
 * or 'resource' (what a page loads: also data:, blob: and web sockets). Never this machine, a
 * local network or anything not public.
 */
export function addressAllowed(url, kind = 'page') {
  let u;
  try { u = new URL(String(url || '')); } catch { return { ok: false, why: 'bad' }; }
  const schemes = kind === 'page' ? ['http:', 'https:'] : ['http:', 'https:', 'ws:', 'wss:', 'data:', 'blob:'];
  if (u.href === 'about:blank') return { ok: true, url: u.href };
  if (!schemes.includes(u.protocol)) return { ok: false, why: 'scheme' };
  if (u.protocol === 'data:' || u.protocol === 'blob:') return { ok: true, url: u.href };
  if (u.username || u.password) return { ok: false, why: 'credentials' };
  if (privateHost(u.hostname)) return { ok: false, why: 'private' };
  if (u.href.length > LIMITS.urlMax) return { ok: false, why: 'long' };
  return { ok: true, url: u.href };
}

export const REFUSED = {
  bad: 'That isn’t a web address.',
  scheme: 'Only web pages (http and https) open here.',
  private: 'The cloud browser doesn’t open local or private network addresses.',
  credentials: 'Addresses with a user name or password in them aren’t opened.',
  long: 'That address is too long.',
};

/**
 * What the address bar makes of what's typed (J.A.R.V.I.S.'s app/url-input.js, for a browser
 * in the cloud): http(s) as it is, a host gets https, words are a search. Local addresses and
 * other schemes are refused, never searched for silently.
 */
export function toUrl(input, engine = 'duckduckgo') {
  const text = String(input ?? '').trim().slice(0, LIMITS.urlMax);
  if (!text) return { ok: false, why: 'bad' };
  if (/^https?:\/\//i.test(text)) return addressAllowed(text);
  const scheme = /^([a-z][a-z0-9+.-]*):(?!\d)/i.exec(text);
  if (scheme && !/\s/.test(text)) return { ok: false, why: 'scheme' };
  const m = HOST.exec(text);
  if (m) {
    const [, host, port] = m;
    const top = host.split('.').pop();
    if (!port || Number(port) <= 65535) {
      if (IPV4.test(host) || host.startsWith('[') || (port && !host.includes('.'))) return addressAllowed(`http://${text}`);
      if (host.includes('.') && /[a-z]/i.test(top)) return addressAllowed(`https://${text}`);
    }
  }
  return { ok: true, url: searchUrl(text, engine), search: true };
}

// ── ads and trackers: blocked by host, as the lists J.A.R.V.I.S.'s browser uses say ──

let blocked = null;
const blockedSet = () => (blocked ??= new Set(BLOCKED_HOSTS.split('\n')));

/** The host, or a parent of it, is on the blocklist. */
export function hostBlocked(hostname, set = blockedSet()) {
  const parts = String(hostname || '').toLowerCase().replace(/\.$/, '').split('.');
  for (let i = 0; i < parts.length - 1; i++) if (set.has(parts.slice(i).join('.'))) return true;
  return false;
}

/** A request the page makes: let it through, block it as an ad or tracker, or refuse it as unsafe. */
export function requestVerdict(url, { adblock = true, pageHost = '' } = {}) {
  const ok = addressAllowed(url, 'resource');
  if (!ok.ok) return ok.why === 'scheme' ? 'scheme' : 'unsafe';
  if (!adblock || !/^(https?|wss?):/.test(url)) return 'allow';
  let host;
  try { host = new URL(url).hostname; } catch { return 'unsafe'; }
  if (pageHost && (host === pageHost || host.endsWith(`.${pageHost}`) || pageHost.endsWith(`.${host}`)) && !hostBlocked(pageHost)) return 'allow'; // a site's own requests
  return hostBlocked(host) ? 'ad' : 'allow';
}

export const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };
/** The site a setting is kept for: the host without www. */
export const siteOf = (url) => hostOf(url).replace(/^www\./, '');

// ── the viewer's mouse and keys, as Chrome takes them (CDP Input.*) ──

const BUTTONS = ['left', 'middle', 'right'];
/** Modifier bits as CDP counts them: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function modifiers(m = {}) {
  return (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0);
}
const clampN = (v, lo, hi, d = lo) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);

/** The page's size in CSS pixels for a panel of w×h at a zoom: zoomed in, the page is narrower. */
/**
 * The viewer's screen density for the picture: 1 to 2 (a 3x phone gets 2), lowered while the
 * picture would pass about 4.5 million pixels, so frames stay small enough to keep up.
 */
export const MAX_PIXELS = 2560 * 1760;
export function density(dpr, w, h) {
  let d = clampN(dpr, 1, 2, 1);
  while (d > 1 && w * h * d * d > MAX_PIXELS) d = Math.max(1, d - 0.25);
  return d;
}
/** The page's size in its own CSS pixels at the zoom, drawn at the viewer's density (Retina: 2x). */
export function viewport(w, h, zoom = 1, dpr = 1, mobile = false) {
  const z = clampN(zoom, ZOOM.min, ZOOM.max, 1);
  const cw = clampN(w, 240, 2560, 1024);
  const ch = clampN(h, 240, 2000, 768);
  const width = Math.round(cw / z);
  const height = Math.round(ch / z);
  const d = density(dpr, cw, ch);
  return { width, height, deviceScaleFactor: Math.round(z * d * 1000) / 1000, mobile: Boolean(mobile) };
}

/**
 * A pointer message ({ t: 'mouse', e: 'down'|'up'|'move'|'wheel', x, y, b, n, dx, dy, m }) in
 * the panel's CSS pixels, as CDP's Input.dispatchMouseEvent params in the page's.
 */
export function mouseEvent(msg, zoom = 1) {
  const z = clampN(zoom, ZOOM.min, ZOOM.max, 1);
  const x = clampN(msg.x, 0, 4000, 0) / z;
  const y = clampN(msg.y, 0, 4000, 0) / z;
  const button = BUTTONS[msg.b] || 'left';
  const base = { x, y, modifiers: modifiers(msg.m) };
  switch (msg.e) {
    case 'down': return { ...base, type: 'mousePressed', button, buttons: 1 << (msg.b === 2 ? 1 : msg.b === 1 ? 2 : 0), clickCount: clampN(msg.n, 1, 3, 1) };
    case 'up': return { ...base, type: 'mouseReleased', button, buttons: 0, clickCount: clampN(msg.n, 1, 3, 1) };
    case 'move': return { ...base, type: 'mouseMoved', button: msg.held ? 'left' : 'none', buttons: msg.held ? 1 : 0 };
    case 'wheel': return { ...base, type: 'mouseWheel', button: 'none', deltaX: clampN(msg.dx, -5000, 5000, 0) / z, deltaY: clampN(msg.dy, -5000, 5000, 0) / z };
    default: return null;
  }
}

// Keys that aren't text: their codes (Windows virtual keys, as Chrome wants them).
const KEYCODES = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, Pause: 19, CapsLock: 20, Escape: 27, ' ': 32,
  PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Insert: 45, Delete: 46, Meta: 91, ContextMenu: 93, F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
  F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
};
// Editing shortcuts: a Mac's ⌘ is Ctrl on the cloud browser (Linux), and Chrome's own editing commands do them.
const COMMANDS = { a: 'selectAll', z: 'undo', y: 'redo', x: 'cut', c: 'copy', v: 'paste' };

/**
 * A key message ({ t: 'key', e: 'down'|'up', key, code, m }) as CDP Input.dispatchKeyEvent
 * params, or null when it isn't sent as a key: printable characters arrive as text instead
 * (Input.insertText: IME-safe), and ⌘ shortcuts become Ctrl ones.
 */
export function keyEvent(msg) {
  const key = typeof msg.key === 'string' ? msg.key.slice(0, 24) : '';
  if (!key) return null;
  const m = { ...(msg.m || {}) };
  if (m.meta) { m.ctrl = true; m.meta = false; } // ⌘ on the viewer's Mac
  const printable = [...key].length === 1;
  const mods = modifiers(m);
  if (printable && !m.ctrl && !m.alt) return null; // text: Input.insertText
  const type = msg.e === 'up' ? 'keyUp' : printable && !m.ctrl ? 'keyDown' : 'rawKeyDown';
  const upper = printable ? key.toUpperCase() : '';
  const code = typeof msg.code === 'string' ? msg.code.slice(0, 24) : '';
  const vk = KEYCODES[key] ?? (printable && /^[A-Z0-9]$/.test(upper) ? upper.charCodeAt(0) : 0);
  const out = { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods };
  if (key === 'Enter' && type !== 'keyUp') { out.type = 'keyDown'; out.text = '\r'; out.unmodifiedText = '\r'; }
  if (m.ctrl && printable && type !== 'keyUp' && COMMANDS[key.toLowerCase()] && !m.alt) out.commands = [COMMANDS[key.toLowerCase()]];
  return out;
}

/** Text typed or pasted (after an IME settles, too): as Input.insertText takes it. */
export function textInput(text) {
  const t = String(text ?? '').replace(/\r\n?/g, '\n').slice(0, LIMITS.insertMax);
  return t ? { text: t } : null;
}

// ── how fast a viewer may send ──

/** A token bucket: rate a second, burst at most. take() says whether this one may go. */
export class Bucket {
  constructor(rate, burst, now = () => Date.now()) {
    Object.assign(this, { rate, burst, now, tokens: burst, at: now() });
  }
  take(n = 1) {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.at) / 1000) * this.rate);
    this.at = t;
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }
}
/** Per socket: input events (mouse moves are many), and the costlier things (loads, finds, page text). */
export const RATES = { input: [300, 600], action: [6, 24] }; // input: moves and wheels (each once a frame at most), keys, acks

// ── zoom: ×1.1 steps, kept per site ──

export const ZOOM = { min: 0.33, max: 3, step: 1.1 };
export function zoomStep(z, dir) {
  const cur = clampN(z, ZOOM.min, ZOOM.max, 1);
  if (dir === 0) return 1;
  const next = dir > 0 ? cur * ZOOM.step : cur / ZOOM.step;
  const r = Math.round(next * 100) / 100;
  return Math.abs(r - 1) < 0.04 ? 1 : clampN(r, ZOOM.min, ZOOM.max, 1);
}

// ── history and bookmarks (per account, in its browser object) ──

const cleanTitle = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, LIMITS.titleMax);
const PAGE = /^https?:\/\//i;

/** A visit: the newest first; a page that sent itself somewhere else at once shares one row. */
export function addVisit(history, { url, title, at, redirectOf = '' }) {
  if (!PAGE.test(String(url || '')) || url.length > LIMITS.urlMax) return history;
  const list = Array.isArray(history) ? history : [];
  const top = list[0];
  if (top && (top.url === url || (redirectOf && top.url === redirectOf && at - top.at < 3000))) {
    return [{ url, title: cleanTitle(title) || top.title, at, n: (top.n || 1) + (top.url === url && !redirectOf ? 1 : 0) }, ...list.slice(1)];
  }
  return [{ url, title: cleanTitle(title), at }, ...list].slice(0, LIMITS.history);
}
export function setTitle(history, url, title) {
  if (!history[0] || history[0].url !== url || !title) return history;
  return [{ ...history[0], title: cleanTitle(title) }, ...history.slice(1)];
}

export function toggleBookmark(bookmarks, { url, title, folder = '' }) {
  if (!PAGE.test(String(url || ''))) return { bookmarks, on: false };
  const list = Array.isArray(bookmarks) ? bookmarks : [];
  if (list.some((b) => b.url === url)) return { bookmarks: list.filter((b) => b.url !== url), on: false };
  const f = String(folder || '').split('/').map((p) => p.trim().slice(0, 60)).filter(Boolean).slice(0, 6).join('/');
  return { bookmarks: [{ url, title: cleanTitle(title) || url, ...(f ? { folder: f } : {}), at: Date.now() }, ...list].slice(0, LIMITS.bookmarks), on: true };
}

// The address bar's suggestions, ranked as J.A.R.V.I.S.'s browser does (app/browser-lib.js suggest).
const DAY = 864e5;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const afterScheme = (url) => String(url || '').replace(/^[a-z]+:\/\/(www\.)?/i, '').toLowerCase();
function hostPart(path) { const end = path.search(/[/?#]/); return (end < 0 ? path : path.slice(0, end)).replace(/:\d+$/, ''); }
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
  return 18 * Math.log2(1 + Math.max(0, visits)) + (age < DAY ? 30 : age < 7 * DAY ? 20 : age < 30 * DAY ? 10 : 0);
}
export function suggest(query, { tabs = [], bookmarks = [], history = [], now = Date.now(), limit = 8 } = {}) {
  const tokens = String(query || '').toLowerCase().slice(0, 200).split(/\s+/).filter(Boolean).slice(0, 8);
  if (!tokens.length) return [];
  const match = matcher(tokens);
  const pages = new Map();
  for (const h of history) {
    if (!h || typeof h.url !== 'string') continue;
    const p = pages.get(h.url) || { url: h.url, title: '', visits: 0, last: 0 };
    p.visits += Math.max(1, Math.min(100000, Number(h.n) || 1));
    if ((Number(h.at) || 0) >= p.last) { p.last = Number(h.at) || 0; if (h.title) p.title = h.title; }
    pages.set(h.url, p);
  }
  const found = new Map();
  const add = (url, title) => { let f = found.get(url); if (!f) { f = { url, title: '' }; found.set(url, f); } if (!f.title && title) f.title = String(title); return f; };
  for (const t of tabs) if (t && PAGE.test(t.url || '') && !t.active) add(t.url, t.title).tab = t.id;
  for (const b of bookmarks) if (b && typeof b.url === 'string') add(b.url, b.title).bookmark = true;
  for (const p of pages.values()) add(p.url, p.title);
  const rows = [];
  for (const f of found.values()) {
    const m = match(f.url, f.title);
    if (m < 0) continue;
    const page = pages.get(f.url);
    const tab = f.tab !== undefined;
    rows.push({ kind: tab ? 'tab' : f.bookmark ? 'bookmark' : 'history', url: f.url, title: f.title.slice(0, LIMITS.titleMax), score: m + (f.bookmark ? 25 : 0) + (tab ? 100 : 0) + (page ? frecency(page.visits, page.last, now) : 0), ...(tab ? { tab: f.tab } : {}) });
  }
  return rows.sort((a, b) => b.score - a.score || a.url.length - b.url.length).slice(0, limit).map(({ score, ...r }) => r);
}

// ── browser minutes, a month per account ──

export const monthOf = (now) => new Date(now).toISOString().slice(0, 7);
export function allowance(env = {}, plus = false) {
  const n = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return plus ? n(env.BROWSER_MINUTES_PLUS, MINUTES.plus) : n(env.BROWSER_MINUTES_FREE, MINUTES.free);
}
/** Minutes used this month, after ms more of an open browser (whole months only: a new month starts at 0). */
export function addUse(usage, ms, now) {
  const month = monthOf(now);
  const base = usage && usage.month === month ? usage.ms : 0;
  return { month, ms: base + Math.max(0, ms) };
}
export const minutesLeft = (usage, limit, now) => Math.max(0, limit - ((usage && usage.month === monthOf(now) ? usage.ms : 0) / 60000));

/** When the open browser has to close: idle, its longest session, or the month's minutes run out. */
export function closeReason({ now, startedAt, lastInput, connected, disconnectedAt, usage, limit }) {
  if (minutesLeft(usage, limit, now) <= 0) return 'allowance';
  if (now - startedAt >= LIMITS.maxSessionMs) return 'max';
  if (now - lastInput >= LIMITS.idleMs) return 'idle';
  if (!connected && disconnectedAt && now - disconnectedAt >= LIMITS.graceMs) return 'gone';
  return '';
}
export const CLOSED = {
  allowance: 'This month’s browser time is used up.',
  max: 'The browser closes after an hour. Start it again any time.',
  idle: 'The browser closed after 5 minutes without use.',
  gone: 'The browser closed.',
  busy: 'The cloud browser is busy right now. Try again in a minute.',
  error: 'The browser stopped. Start it again.',
};

// ── the picture's flow ──

/**
 * The screencast: JPEG at CAST.moving while things move (scrolling, loading); once nothing has
 * changed for CAST.restMs, one crisp WebP at CAST.rest. At most CAST.inflight frames are on the
 * way to the viewer: Chrome's next frame waits for the viewer's ack, so frames never queue up
 * (a slow connection skips frames rather than falling behind).
 */
export const CAST = { moving: 64, rest: 90, restMs: 220, inflight: 2 };
export class FrameFlow {
  constructor(max = CAST.inflight) { this.max = max; this.reset(); }
  reset() { this.inflight = 0; this.stashed = null; }
  /** Room for one more on the way. */
  get room() { return this.inflight < this.max; }
  /** A frame went out: true to ack Chrome now (id: the screencast's; null for a crisp frame). */
  sent(id = null) {
    this.inflight += 1;
    if (id == null) return false;
    if (this.inflight < this.max) return true;
    this.stashed = id;
    return false;
  }
  /** The viewer drew one: the screencast frame to ack now, if one was waiting. */
  acked() {
    this.inflight = Math.max(0, this.inflight - 1);
    if (this.stashed != null && this.inflight < this.max) { const id = this.stashed; this.stashed = null; return id; }
    return null;
  }
}

/** The page's mouse cursor, as the panel shows it over the picture: CSS keywords only. */
const CURSORS = new Set(['default', 'pointer', 'text', 'vertical-text', 'crosshair', 'move', 'grab', 'grabbing', 'not-allowed', 'no-drop', 'wait', 'progress', 'help', 'zoom-in', 'zoom-out', 'col-resize', 'row-resize', 'n-resize', 's-resize', 'e-resize', 'w-resize', 'ne-resize', 'nw-resize', 'se-resize', 'sw-resize', 'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize', 'all-scroll', 'cell', 'copy', 'alias', 'context-menu', 'none']);
export function cursorOf(c) {
  const k = String(c || '').split(',').pop().trim().toLowerCase();
  return CURSORS.has(k) ? k : 'default';
}

/** A page that turned the cloud browser away (a bot check or a block page), by its title. */
export const botWall = (title) => /^(just a moment|attention required|access denied|access to this page has been denied|pardon our interruption|are you a robot|verify you are human|please verify you are a human|403 forbidden|request blocked|you have been blocked|robot or human)/i.test(String(title || '').trim());

/** Why a page didn't open, in words, from Chrome's error (net::ERR_…). */
const FAILS = {
  ERR_NAME_NOT_RESOLVED: ['Can’t find that site', 'The address may be mistyped, or the site no longer exists.'],
  ERR_NAME_RESOLUTION_FAILED: ['Can’t find that site', 'The address may be mistyped, or the site no longer exists.'],
  ERR_CONNECTION_TIMED_OUT: ['The site took too long to answer', 'It may be down or very busy. Try again in a moment.'],
  ERR_TIMED_OUT: ['The site took too long to answer', 'It may be down or very busy. Try again in a moment.'],
  ERR_CONNECTION_REFUSED: ['The site refused to connect', 'It may not accept visits from a cloud browser. Your own browser may get in.'],
  ERR_CONNECTION_RESET: ['The connection was cut', 'The site closed it, perhaps because the cloud browser isn’t welcome there.'],
  ERR_CONNECTION_CLOSED: ['The connection was cut', 'The site closed it, perhaps because the cloud browser isn’t welcome there.'],
  ERR_EMPTY_RESPONSE: ['The site sent nothing back', 'It may not accept visits from a cloud browser.'],
  ERR_TOO_MANY_REDIRECTS: ['The site keeps redirecting', 'It sent the browser round in circles.'],
  ERR_SSL_PROTOCOL_ERROR: ['This site’s connection isn’t secure', 'It couldn’t set up a private connection.'],
  ERR_ADDRESS_UNREACHABLE: ['Can’t reach that address', 'The site may be down.'],
  ERR_HTTP2_PROTOCOL_ERROR: ['The site sent something broken', 'Try again, or open it in your own browser.'],
};
export function navFailure(errorText) {
  const code = String(errorText || '').replace(/^net::/, '').trim().slice(0, 60);
  const [title, text] = FAILS[code] || (/^ERR_CERT/.test(code) ? ['This site’s connection isn’t private', 'Its certificate isn’t valid, so the cloud browser stopped.'] : ['Couldn’t open that page', 'Something went wrong on the way. Try again, or open it in your own browser.']);
  return { code, title, text };
}

/** The new tab page's recent sites: the latest page of each site, newest first. */
export function recentSites(history = [], n = 8) {
  const seen = new Set();
  const out = [];
  for (const h of history) {
    const site = siteOf(h.url);
    if (!site || seen.has(site)) continue;
    seen.add(site);
    out.push({ url: h.url, title: h.title || site, site });
    if (out.length >= n) break;
  }
  return out;
}

/** A site's icon as a data: address (small images only), or ''. */
export const ICON_MAX = 48 * 1024;
export function iconData(bytes, type) {
  const t = String(type || '').split(';')[0].trim().toLowerCase();
  if (!/^image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|jpeg|gif|webp|avif)$/.test(t)) return '';
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (!b.length || b.length > ICON_MAX) return '';
  let bin = '';
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return `data:${t};base64,${btoa(bin)}`;
}
