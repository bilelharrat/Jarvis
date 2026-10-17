// Where conversations live in this browser: IndexedDB (hundreds of MB, where localStorage held
// ~5 MB), one record per conversation. localStorage keeps only the small id list (jchat:index) for
// the first paint and for chats saved by older versions, which loadAll() moves over once. When
// IndexedDB isn't available (some private windows) it falls back to localStorage as before.

import { store } from './util.js';

// The connection can be lost under the page: WebKit drops it while the iPhone app is suspended ("Connection to
// Indexed Database server lost") and closes it, and every transaction after that threw, so each save failed
// without a word until a reload. Now a closed connection is opened again, and a transaction that fails is tried
// once more on a new one.
let dbp = null;
function open() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (dbp) return dbp;
  const p = new Promise((resolve) => {
    try {
      const r = indexedDB.open('eden-chats', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('convs', { keyPath: 'id' });
      r.onsuccess = () => {
        const d = r.result;
        d.onclose = () => { if (dbp === p) dbp = null; };
        d.onversionchange = () => { try { d.close(); } catch { /* closed */ } if (dbp === p) dbp = null; };
        resolve(d);
      };
      r.onerror = () => resolve(null);
      r.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  dbp = p;
  return p;
}

/** One transaction: its result (true when it has none), or undefined when it failed, on a fresh connection too. */
async function run(mode, fn) {
  for (let tries = 0; tries < 2; tries++) {
    const p = open();
    const d = await p;
    if (!d) return undefined;
    const got = await new Promise((resolve) => {
      try {
        const tx = d.transaction('convs', mode);
        const req = fn(tx.objectStore('convs'));
        tx.oncomplete = () => resolve({ ok: true, value: req ? req.result : true });
        tx.onerror = () => resolve({ ok: false, error: tx.error });
        tx.onabort = () => resolve({ ok: false, error: tx.error });
      } catch (e) { resolve({ ok: false, error: e }); }
    });
    if (got.ok) return got.value;
    if (got.error && got.error.name === 'QuotaExceededError') return undefined; // full: a new connection won't help
    if (dbp === p) { dbp = null; try { d.close(); } catch { /* closed */ } } // (InvalidStateError, UnknownError: lost)
  }
  return undefined;
}

/**
 * Saves one conversation: true when it was kept; 'backup' when IndexedDB failed even on a new connection and the
 * chat went to localStorage instead (the next load takes it: loadAll); false when neither could keep it.
 */
export async function put(c) {
  if (await open()) {
    if ((await run('readwrite', (s) => s.put(c))) !== undefined) return true;
    return store.set(`${PENDING}${c.id}`, c) ? 'backup' : false;
  }
  return store.set(`jchat:conv:${c.id}`, c);
}
/** One saved conversation, or null (another tab saved it: state.js). */
export async function get(id) {
  if (await open()) return (await run('readonly', (s) => s.get(id))) || null;
  return store.get(`jchat:conv:${id}`, null);
}
export async function del(id) {
  if (await open()) await run('readwrite', (s) => s.delete(id));
  store.del(`jchat:conv:${id}`);
}
export async function clear() {
  if (await open()) await run('readwrite', (s) => s.clear());
}

/** A save the page was closed in the middle of (state.js keeps it here, synchronously, at pagehide). */
export const PENDING = 'jchat:pending:';

let unread = false;
/** True when the last loadAll couldn't read IndexedDB (cloud-sync.js then doesn't take a missing chat as lost). */
export const loadFailed = () => unread;

/** Every saved conversation, in the order of the id list; chats still in localStorage are moved to IndexedDB. */
export async function loadAll() {
  const ids = store.get('jchat:index', []);
  const d = await open();
  const byId = new Map();
  const all = d ? await run('readonly', (s) => s.getAll()) : [];
  unread = Boolean(d) && !Array.isArray(all);
  for (const c of Array.isArray(all) ? all : []) if (c && c.id) byId.set(c.id, c);
  // Saves cut short by a reload or close: newer than what's stored (a save that landed removes its copy).
  const pending = [];
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(PENDING)) pending.push(k); } } catch { /* blocked */ }
  for (const k of pending) {
    const c = store.get(k, null);
    if (!c || !c.id) { store.del(k); continue; }
    if (d) { byId.set(c.id, c); if ((await put(c)) === true) store.del(k); } // (a 'backup' is this same key again: kept)
    else if (store.set(`jchat:conv:${c.id}`, c)) store.del(k);
  }
  const legacy = new Set(ids);
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('jchat:conv:')) legacy.add(k.slice(11)); } } catch { /* blocked */ }
  const order = [...ids];
  for (const id of legacy) {
    const c = store.get(`jchat:conv:${id}`, null);
    if (!c || !c.id) continue;
    let moved = byId.has(id);
    if (!moved) {
      const kept = d ? await put(c) : true;
      if (kept) byId.set(id, c);
      moved = kept === true;
    }
    if (d && moved) store.del(`jchat:conv:${id}`); // moved: the space is free again
    if (!order.includes(id)) order.push(id);
  }
  const out = [];
  for (const id of order) if (byId.has(id)) { out.push(byId.get(id)); byId.delete(id); }
  for (const c of byId.values()) out.push(c); // in the database but not in the list (a crash between the two)
  return out;
}
