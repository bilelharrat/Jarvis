// The try-it tour's pure part (ROADMAP I1): the practice sandbox's storage and network guard,
// the tour's progress (resume, skip, chapters), when it starts by itself, and the detection
// helpers a step's check() uses. No DOM and no imports, so the tests load it as is
// (src/__tests__/tour.test.ts); practice.js installs the sandbox, tour.js draws the tour.

/** Where the tour keeps its own progress and the per-device opt-out (the real localStorage). */
export const TOUR_KEY = 'eden:tour';
/** Every key the practice page writes lives under this prefix, and only there. */
export const PRACTICE_PREFIX = 'eden:practice:';

/* ---------------- the practice sandbox's storage ---------------- */

/**
 * A Storage that keeps its keys inside another one under a prefix: what the practice page
 * writes never touches (or sees) the real keys, and leaving the tour removes the prefix only.
 */
export function scopedStorage(backing, prefix) {
  const own = () => {
    const out = [];
    for (let i = 0; i < backing.length; i++) { const k = backing.key(i); if (k !== null && k.startsWith(prefix)) out.push(k.slice(prefix.length)); }
    return out;
  };
  const api = {
    getItem: (k) => backing.getItem(prefix + String(k)),
    setItem: (k, v) => backing.setItem(prefix + String(k), String(v)),
    removeItem: (k) => backing.removeItem(prefix + String(k)),
    clear: () => { for (const k of own()) backing.removeItem(prefix + k); },
    key: (i) => own()[i] ?? null,
    get length() { return own().length; },
  };
  // localStorage.foo and Object.keys(localStorage) work on a real Storage: the same here
  return new Proxy(api, {
    get(t, p) { if (p in t) return t[p]; if (typeof p === 'symbol') return undefined; const v = t.getItem(p); return v === null ? undefined : v; },
    set(t, p, v) { if (p in t) return false; t.setItem(p, v); return true; },
    deleteProperty(t, p) { t.removeItem(p); return true; },
    has(t, p) { return p in t || t.getItem(p) !== null; },
    ownKeys() { return own(); },
    getOwnPropertyDescriptor(t, p) { const v = typeof p === 'string' ? t.getItem(p) : null; return v === null ? undefined : { value: v, writable: true, enumerable: true, configurable: true }; },
  });
}

/** Every key and value in a Storage (for the tests and the "untouched" check). */
export function snapshot(storage) {
  const out = {};
  for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k !== null) out[k] = storage.getItem(k); }
  return out;
}

/** Removes the practice keys (and only those). Returns how many went. */
export function purgePractice(storage, prefix = PRACTICE_PREFIX) {
  const gone = [];
  for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.startsWith(prefix)) gone.push(k); }
  for (const k of gone) storage.removeItem(k);
  return gone.length;
}

/**
 * Whether the practice page may make this request for real: only reading the page's own static
 * files (scripts, styles, images). Every API call is answered by the mock, and anything else
 * (another origin, a POST, Eden's server, askeden.com's account) is refused.
 */
export function practiceAllows(url, method, origin) {
  let u;
  try { u = new URL(String(url), origin); } catch { return false; }
  if (u.protocol === 'blob:' || u.protocol === 'data:') return true;
  if (u.origin !== origin) return false;
  if (String(method || 'GET').toUpperCase() !== 'GET') return false;
  return !/\/(api|artifact|auth|signin|v1)(\/|$)/.test(u.pathname);
}

/**
 * Turns a window into the practice sandbox: localStorage and sessionStorage scoped under the
 * prefix, IndexedDB (sync's keys) hidden, and the network limited to the page's own files.
 * `win` is the real window (or the tests' fake). Returns the guard's record.
 */
export function installSandbox(win, { prefix = PRACTICE_PREFIX, onBlocked } = {}) {
  const record = { blocked: [], prefix };
  const realLocal = win.localStorage;
  const realSession = win.sessionStorage;
  const define = (name, value) => Object.defineProperty(win, name, { configurable: true, enumerable: true, get: () => value, set: () => {} });
  define('localStorage', scopedStorage(realLocal, `${prefix}ls:`));
  define('sessionStorage', scopedStorage(realSession, `${prefix}ss:`));
  define('indexedDB', undefined); // sync.js reads "no IndexedDB" as "sync off on this device"
  const origin = win.location && win.location.origin;
  const block = (what, url) => {
    record.blocked.push({ what, url: String(url).slice(0, 200) });
    if (onBlocked) onBlocked(what, url);
  };
  const realFetch = win.fetch && win.fetch.bind(win);
  define('fetch', (input, init = {}) => {
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input && input.url;
    const method = (init && init.method) || (input && typeof input === 'object' && input.method) || 'GET';
    if (realFetch && practiceAllows(url, method, origin)) return realFetch(input, init);
    block('fetch', url);
    return Promise.reject(new TypeError('Practice mode: nothing leaves this page.'));
  });
  if (win.navigator) { try { Object.defineProperty(win.navigator, 'sendBeacon', { configurable: true, value: (url) => { block('beacon', url); return false; } }); } catch { /* read-only */ } }
  for (const name of ['WebSocket', 'EventSource']) {
    define(name, function Refused(url) { block(name, url); throw new Error('Practice mode: nothing leaves this page.'); });
  }
  return { record, realLocal, realSession };
}

/* ---------------- progress ---------------- */

export function newProgress() {
  return { v: 1, seen: false, optOut: false, active: false, step: null, done: [], skipped: [], ctx: null, updated: 0 };
}

export function loadProgress(storage) {
  try {
    const p = JSON.parse(storage.getItem(TOUR_KEY) || 'null');
    if (!p || p.v !== 1) return newProgress();
    return { ...newProgress(), ...p, done: Array.isArray(p.done) ? p.done : [], skipped: Array.isArray(p.skipped) ? p.skipped : [] };
  } catch { return newProgress(); }
}

export function saveProgress(storage, p, now = Date.now()) {
  try { storage.setItem(TOUR_KEY, JSON.stringify({ ...p, updated: now })); return true; } catch { return false; }
}

const uniq = (a) => [...new Set(a)];
export function markDone(p, id) { return { ...p, done: uniq([...p.done, id]), skipped: p.skipped.filter((x) => x !== id) }; }
export function markSkipped(p, id) { return p.done.includes(id) ? p : { ...p, skipped: uniq([...p.skipped, id]) }; }

/** The step after `fromId` that isn't finished yet (wrapping once to pick up skipped ones is the caller's choice). */
export function nextStep(steps, p, fromId) {
  const start = fromId ? steps.findIndex((s) => s.id === fromId) + 1 : 0;
  for (let i = start; i < steps.length; i++) if (!p.done.includes(steps[i].id) && !p.skipped.includes(steps[i].id)) return steps[i];
  return null;
}

/** Where a resumed tour picks up: the saved step if it's still open, else the first open one. */
export function resumeStep(steps, p) {
  const at = p.step && steps.find((s) => s.id === p.step);
  if (at && !p.done.includes(at.id)) return at;
  return nextStep(steps, p, null) || steps.find((s) => !p.done.includes(s.id)) || null;
}

export function percent(steps, p) {
  if (!steps.length) return 0;
  return Math.round((steps.filter((s) => p.done.includes(s.id) || p.skipped.includes(s.id)).length / steps.length) * 100);
}

/** Each chapter with its steps, minutes and how far along it is. */
export function chapterStatus(chapters, steps, p) {
  return chapters.map((c) => {
    const own = steps.filter((s) => s.chapter === c.id);
    const done = own.filter((s) => p.done.includes(s.id)).length;
    const skipped = own.filter((s) => p.skipped.includes(s.id)).length;
    return { ...c, total: own.length, done, skipped, minutes: Math.max(1, Math.round(own.reduce((m, s) => m + (s.seconds || 40), 0) / 60)), complete: own.length > 0 && done + skipped === own.length };
  });
}

/** Where step `id` sits: its index in its chapter, the chapter's size, and overall. */
export function position(steps, id) {
  const i = steps.findIndex((s) => s.id === id);
  if (i < 0) return null;
  const ch = steps.filter((s) => s.chapter === steps[i].chapter);
  return { index: i, total: steps.length, inChapter: ch.findIndex((s) => s.id === id), chapterTotal: ch.length };
}

/**
 * Whether the welcome sheet opens by itself: on a person's first visit to the real page, never
 * after they've said no (per device), never on a dev page (?mock=1, a test browser), and not in
 * the iPhone app, whose own welcome hands off to the tour. ?tour=1 always opens it.
 */
export function shouldAutoStart({ progress, params, inApp = false, webdriver = false }) {
  const q = params || new URLSearchParams('');
  if (q.get('tour') === '1') return true;
  if (q.get('tour') === '0' || progress.optOut || progress.seen) return false;
  if (inApp || webdriver || q.get('mock') === '1' || q.get('practice') === '1') return false;
  return true;
}

/**
 * Why a step's feature isn't available where the person really uses Eden (null when it is):
 * the practice version is offered instead. `ctx` is what the real page knew before the tour
 * opened: { hosted, mac, signedIn, inApp }.
 */
export function unavailableReason(step, ctx) {
  if (!ctx || !step.needs) return null;
  const needs = [].concat(step.needs);
  for (const n of needs) {
    if (n === 'mac' && !ctx.mac) return ctx.hosted ? 'Your Mac isn’t linked to askeden.com yet, so this needs the Jarvis app on your Mac.' : 'The Jarvis app on your Mac isn’t connected right now.';
    if (n === 'account' && !ctx.hosted) return 'Accounts live at askeden.com; Eden on your own Mac has no sign-in.';
    if (n === 'account' && !ctx.signedIn) return 'You aren’t signed in to askeden.com in this browser.';
    if (n === 'app' && !ctx.inApp) return 'This is part of the Eden iPhone app.';
  }
  return null;
}

/* ---------------- detection ---------------- */

/**
 * The checks' view of what happened since the step began: `events` are records the page
 * collected ({ type, key, mod, shift, alt, detail, match(sel) }), `query`/`queryAll` look at the
 * page, `base` is what start() measured, `state` the app's state, `stored(key)` reads the
 * page's storage and `inView(sel)` says whether an element is on screen.
 */
export function detector({ events = [], query = () => null, queryAll = () => [], base = {}, state = {}, stored = () => null, inView = () => false, now = Date.now } = {}) {
  return {
    events, base, state, now, inView,
    q: query,
    /** A JSON value the page keeps in (practice) localStorage. */
    stored: (key) => { try { return JSON.parse(stored(key) || 'null'); } catch { return null; } },
    count: (sel) => queryAll(sel).length,
    has: (sel) => !!query(sel),
    text: (sel) => { const n = query(sel); return n ? String(n.textContent || '').trim() : ''; },
    /** An event of `type` (on an element inside `sel`, and passing `pred`) since the step began. */
    saw: (type, sel, pred) => events.some((e) => e.type === type && (!sel || (e.match && e.match(sel))) && (!pred || pred(e))),
    key: (k, { mod = false, shift = null } = {}) => events.some((e) => e.type === 'keydown' && String(e.key).toLowerCase() === k && !!e.mod === mod && (shift === null || !!e.shift === shift)),
  };
}

/** Runs a step's check safely: a check that throws (a panel half-drawn) is "not yet". */
export function passes(step, d) {
  try { return !!step.check(d); } catch { return false; }
}
