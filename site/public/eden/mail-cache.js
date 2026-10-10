// Eden Mail's speed (ROADMAP P1): the mailbox lists and opened emails kept in this browser
// (IndexedDB), so Mail draws at once and refreshes after; and a small timing recorder behind the
// Speed tab in Mail settings (how long opening Mail, opening an email and each action take).
//
//   lists  `${source}:${account}:${mailbox}` → { rows, historyId, at }   (the list as last shown)
//   msgs   `${source}:${id}`                 → { msg, at }               (an email as read; at most MAX_MSGS)
//
// Mail is the owner's own data: kept only in this browser, cleared from Mail settings ("Clear
// cached mail") and whenever Gmail is disconnected. Mock mode (?mock=1) uses its own database.

import { isMock } from './api.js';

const DB = isMock ? 'eden-mail-cache-mock' : 'eden-mail-cache';
const MAX_MSGS = 300;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB, 1); } catch { resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('lists')) db.createObjectStore('lists');
      if (!db.objectStoreNames.contains('msgs')) db.createObjectStore('msgs').createIndex('at', 'at');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null); // private mode or blocked: Mail works without the cache
    req.onblocked = () => resolve(null);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const db = await open();
  if (!db) return undefined;
  return new Promise((resolve) => {
    let out;
    try {
      const t = db.transaction(store, mode);
      const st = t.objectStore(store);
      out = fn(st);
      t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
      t.onerror = () => resolve(undefined);
      t.onabort = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}

export const listKey = (source, account, mailbox) => `${source}:${account || ''}:${mailbox}`;
export const getList = (key) => tx('lists', 'readonly', (s) => s.get(key));
export const putList = (key, value) => tx('lists', 'readwrite', (s) => s.put({ ...value, at: Date.now() }, key));
export const getMsg = (key) => tx('msgs', 'readonly', (s) => s.get(key)).then((v) => (v ? v.msg : null));

let puts = 0;
export async function putMsg(key, msg) {
  await tx('msgs', 'readwrite', (s) => s.put({ msg, at: Date.now() }, key));
  if (++puts % 25 === 0) prune();
}
/** The oldest emails go once there are more than MAX_MSGS. */
async function prune() {
  const db = await open();
  if (!db) return;
  const count = await tx('msgs', 'readonly', (s) => s.count());
  if (!(count > MAX_MSGS)) return;
  let drop = count - MAX_MSGS;
  await tx('msgs', 'readwrite', (s) => {
    const cur = s.index('at').openCursor();
    cur.onsuccess = () => { const c = cur.result; if (c && drop-- > 0) { c.delete(); c.continue(); } };
    return cur;
  });
}
/** Everything gone (Mail settings › Clear cached mail; Gmail disconnected). */
export async function clearMailCache() {
  await tx('lists', 'readwrite', (s) => s.clear());
  await tx('msgs', 'readwrite', (s) => s.clear());
}

/* ---------------- timings (the Speed tab) ---------------- */

const KINDS = { panel: 'Opening Mail (first list on screen)', open: 'Opening an email', action: 'Done, snooze, star, move', refresh: 'Checking Gmail for changes' };
const samples = Object.fromEntries(Object.keys(KINDS).map((k) => [k, []]));
/** Starts a timing: call the returned function when the result is on screen. */
export function timing(kind) {
  const t0 = performance.now();
  return () => {
    const ms = performance.now() - t0;
    const list = samples[kind] || (samples[kind] = []);
    list.push(ms);
    if (list.length > 200) list.shift();
    return ms;
  };
}
const pct = (xs, p) => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]); };
/** [{ kind, label, n, p50, p95 }] for every kind measured this session. */
export const timings = () => Object.entries(samples).map(([kind, xs]) => ({ kind, label: KINDS[kind] || kind, n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95) }));
export const SPEED_TARGETS = { panel: 300, open: 100, action: 50, refresh: 1500 };
