// The browser panel's logic without the page (browser-pane.js draws it; src/__tests__/browser-pane.test.ts):
// where it browses, what it remembers per viewer, what the address bar shows, and how often
// the live view on askeden.com asks the Mac for a new picture.
//
// Where it browses:
// - 'app': Eden in the J.A.R.V.I.S. app's Ask Eden window (its preload gives the page
//   window.jarvisBrowser): Jarvis's own built-in browser, drawn in the panel's slot.
// - 'remote': anywhere else, with the Mac linked and online: a live look at a tab of its own in
//   that browser, through Jarvis (browser_view: the owner says yes on a card on the Mac first;
//   address, back, forward and reload only, never a click or a keystroke).
// - 'offline': no Mac to ask: the panel says so, with Get J.A.R.V.I.S. and Link this Mac.

export const OPEN_KEY = 'eden:browser:open';
export const VIEW_KEY = 'eden:browser:view';
export const VIEW_ID = /^bv-[0-9a-f]{10}$/;
/** How often the live view asks for a new picture (ms): quicker just after a step. */
export const POLL = { live: 1600, after: 500, waiting: 1500, hidden: 8000, away: 4000 };

/** The bridge the J.A.R.V.I.S. app gives its Ask Eden window, when it's this one. */
export function appBridge(win) {
  const b = win && win.jarvisBrowser;
  return b && typeof b.show === 'function' && typeof b.nav === 'function' && typeof b.onState === 'function' ? b : null;
}

export function paneMode({ bridge, jarvisAvailable }) {
  if (bridge) return 'app';
  return jarvisAvailable ? 'remote' : 'offline';
}

/** The panel's open state, per viewer (localStorage; it may refuse). */
export function wasOpen(storage) {
  try { return storage.getItem(OPEN_KEY) === '1'; } catch { return false; }
}
export function keepOpen(storage, on) {
  try { if (on) storage.setItem(OPEN_KEY, '1'); else storage.removeItem(OPEN_KEY); } catch { /* private window */ }
}

/** The live view this tab is watching (sessionStorage), when it's a view's id. */
export function keptView(storage) {
  try { const id = storage.getItem(VIEW_KEY) || ''; return VIEW_ID.test(id) ? id : ''; } catch { return ''; }
}
export function keepView(storage, id) {
  try { if (id && VIEW_ID.test(id)) storage.setItem(VIEW_KEY, id); else storage.removeItem(VIEW_KEY); } catch { /* private window */ }
}

/** What's typed in the address bar, as Jarvis takes it: an address, or words to search. Never another scheme. */
export function typed(text) {
  const t = String(text || '').trim().slice(0, 2000);
  if (!t) return { ok: false, why: 'empty' };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(t);
  const hostPort = /^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+):\d+(\/|$)/i.test(t); // example.com:8080, not javascript:1
  if (scheme && !/^https?$/i.test(scheme[1]) && !hostPort) return { ok: false, why: 'scheme' };
  return { ok: true, value: t };
}

/** A view's first page (Jarvis takes only an address for it): words become a search. */
export function startUrl(text) {
  const t = typed(text);
  if (!t.ok) return t;
  if (/\s/.test(t.value) || !/[.:]/.test(t.value)) return { ok: true, value: `https://duckduckgo.com/?q=${encodeURIComponent(t.value)}` };
  return t;
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

/** When to ask the Mac again, by the view's state and whether the page is on screen. */
export function nextPoll({ status, hidden, failed, justActed }) {
  if (status !== 'waiting_owner' && status !== 'live') return 0; // over: no more asking
  if (hidden) return POLL.hidden;
  if (failed) return POLL.away;
  if (status === 'waiting_owner') return POLL.waiting;
  return justActed ? POLL.after : POLL.live;
}

/** The view's words for its state. */
export const VIEW_WORDS = {
  waiting_owner: 'Waiting for your OK on your Mac',
  live: 'Live from your Mac',
  declined: 'You said no on your Mac',
  ended: 'Ended',
};
