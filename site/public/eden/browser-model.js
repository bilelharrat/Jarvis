// The browser panel's logic without the page (browser-pane.js draws it; src/__tests__/browser-pane.test.ts):
// where it browses, what it remembers per viewer, what the address bar shows, and how the
// viewer's mouse, touch, wheel and keys become messages for the cloud browser.
//
// Where it browses:
// - 'app': Eden in the J.A.R.V.I.S. app's Ask Eden window (its preload gives the page
//   window.jarvisBrowser): Jarvis's own built-in browser, drawn in the panel's slot.
// - 'cloud': anywhere else: Eden's own browser, a Chrome on Cloudflare for this account
//   (the server's browser/session.js), shown as a live picture the viewer clicks and types in.
//   No Mac involved.

export const OPEN_KEY = 'eden:browser:open';

/** The bridge the J.A.R.V.I.S. app gives its Ask Eden window, when it's this one. */
export function appBridge(win) {
  const b = win && win.jarvisBrowser;
  return b && typeof b.show === 'function' && typeof b.nav === 'function' && typeof b.onState === 'function' ? b : null;
}

export const paneMode = ({ bridge }) => (bridge ? 'app' : 'cloud');

/** The panel's open state, per viewer (localStorage; it may refuse). */
export function wasOpen(storage) {
  try { return storage.getItem(OPEN_KEY) === '1'; } catch { return false; }
}
export function keepOpen(storage, on) {
  try { if (on) storage.setItem(OPEN_KEY, '1'); else storage.removeItem(OPEN_KEY); } catch { /* private window */ }
}

/** What's typed in the address bar: an address, or words to search. Never another scheme (the server checks again). */
export function typed(text) {
  const t = String(text || '').trim().slice(0, 2000);
  if (!t) return { ok: false, why: 'empty' };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(t);
  const hostPort = /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+):\d+(\/|$)/i.test(t); // example.com:8080, not javascript:1
  if (scheme && !/^https?$/i.test(scheme[1]) && !hostPort && !/\s/.test(t)) return { ok: false, why: 'scheme' };
  return { ok: true, value: t };
}

/** The address bar's words for a page: the whole address while editing, else the host and path. */
export function shownUrl(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return '';
    const host = u.host.replace(/^www\./, '');
    let rest = `${u.pathname === '/' ? '' : u.pathname}${u.search}`;
    try { rest = decodeURI(rest).replace(/%20/g, ' '); } catch { /* as it is */ }
    return `${host}${rest.length > 60 ? `${rest.slice(0, 59)}…` : rest}`;
  } catch { return ''; }
}
export const isSecure = (url) => /^https:\/\//i.test(String(url || ''));
export const siteOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** The cloud browser's socket, beside the page's API (wss on https). */
export function socketUrl(apiBase, href) {
  const u = new URL(`${apiBase}/browser`, href);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.href;
}

/** When to try the socket again after it dropped (ms), or 0 for not on its own. */
export function reconnectDelay(attempt, why = '') {
  if (why === 'replaced' || why === 'signed_out' || why === 'closed') return 0;
  return Math.min(15000, 500 * 2 ** Math.max(0, attempt));
}

// ── the viewer's input ──

const mods = (e) => ({ alt: !!e.altKey, ctrl: !!e.ctrlKey, meta: !!e.metaKey, shift: !!e.shiftKey });
const BUTTON = { 0: 0, 1: 1, 2: 2 };

/** A pointer event over the page picture (rect: the canvas's box) as a mouse message, in page CSS pixels. */
export function pointerMsg(kind, e, rect, extra = {}) {
  const x = Math.round(Math.max(0, Math.min(rect.width, e.clientX - rect.left)));
  const y = Math.round(Math.max(0, Math.min(rect.height, e.clientY - rect.top)));
  const msg = { t: 'mouse', e: kind, x, y, m: mods(e) };
  if (kind === 'down' || kind === 'up') { msg.b = BUTTON[e.button] ?? 0; msg.n = Math.max(1, Math.min(3, e.detail || 1)); }
  if (kind === 'move' && e.buttons & 1) msg.held = true;
  return { ...msg, ...extra };
}

/** A wheel event as pixels (lines are 16 px, pages the picture's height). */
export function wheelMsg(e, rect) {
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rect.height : 1;
  return { ...pointerMsg('wheel', e, rect), dx: Math.round(e.deltaX * unit), dy: Math.round(e.deltaY * unit) };
}

/** A touch drag: a scroll by how far the finger went (the other way, as pages scroll). */
export const touchScroll = (dx, dy, at) => ({ t: 'mouse', e: 'wheel', x: at.x, y: at.y, dx: Math.round(-dx) || 0, dy: Math.round(-dy) || 0, m: {} });
export const TAP_SLOP = 8;

/**
 * The panel's own shortcuts while the page has the keys (as in J.A.R.V.I.S.'s browser): the
 * action's name, or ''. ⌘ on a Mac, Ctrl elsewhere.
 */
export function shortcut(e, mac = true) {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (e.ctrlKey && e.key === 'Tab') return e.shiftKey ? 'prevtab' : 'nexttab';
  if (!mod || e.altKey) return '';
  const k = String(e.key || '').toLowerCase();
  if (e.shiftKey) {
    if (k === '[' || k === '{') return 'prevtab';
    if (k === ']' || k === '}') return 'nexttab';
    if (k === 'b') return 'closepanel';
    return '';
  }
  const map = { l: 'address', t: 'newtab', w: 'closetab', r: 'reload', '[': 'back', ']': 'forward', f: 'find', d: 'bookmark', y: 'history', '=': 'zoomin', '+': 'zoomin', '-': 'zoomout', 0: 'zoomreset', k: 'palette' };
  if (/^[1-9]$/.test(k)) return `tab${k}`;
  return map[k] || '';
}

/**
 * A key while the page has the keys: sent as a key (Enter, arrows, Backspace, ⌘A…), left for
 * the text box to send as text (letters, and whatever an IME composes), or 'paste' (⌘V: the
 * paste event brings the viewer's clipboard). null: nothing to send.
 */
export function keyMsg(e, kind = 'down') {
  if (e.isComposing || e.key === 'Process' || e.keyCode === 229) return null; // an IME at work: its text arrives as text
  const key = String(e.key || '');
  if (!key || key === 'Dead' || key === 'Unidentified') return null;
  const printable = [...key].length === 1;
  const cmd = e.metaKey || e.ctrlKey;
  if (printable && !cmd && !e.altKey) return null; // text, from the text box
  if (printable && e.altKey && !cmd) return null; // ⌥ characters on a Mac (é, ©…) are text
  if (cmd && key.toLowerCase() === 'v' && !e.altKey) return 'paste';
  if (['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(key)) return null;
  return { t: 'key', e: kind, key, code: String(e.code || ''), m: mods(e) };
}

/** A download the cloud browser was offered: the name shown (no paths, no control characters). */
export function downloadName(name, url) {
  let n = String(name || '').replace(/[\\/]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  if (!n) { try { n = decodeURIComponent(new URL(url).pathname.split('/').pop() || ''); } catch { n = ''; } }
  return n || 'download';
}

/** The zoom as the bar shows it: nothing at 100%. */
export const zoomLabel = (z) => (Math.abs((Number(z) || 1) - 1) < 0.01 ? '' : `${Math.round((Number(z) || 1) * 100)}%`);
/** The shield's count. */
export const blockedLabel = (n) => (n > 99 ? '99+' : n > 0 ? String(n) : '');
