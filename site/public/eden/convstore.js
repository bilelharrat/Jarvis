// Where conversations live in this browser: IndexedDB (hundreds of MB, where localStorage held
// ~5 MB), one record per conversation. localStorage keeps only the small id list (jchat:index) for
// the first paint and for chats saved by older versions, which loadAll() moves over once. When
// IndexedDB isn't available (some private windows) it falls back to localStorage as before.

import { store } from './util.js';

let dbp = null;
function open() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  dbp ||= new Promise((resolve) => {
    try {
      const r = indexedDB.open('eden-chats', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('convs', { keyPath: 'id' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbp;
}

function run(mode, fn) {
  return open().then((d) => (!d ? undefined : new Promise((resolve) => {
    try {
      const tx = d.transaction('convs', mode);
      const req = fn(tx.objectStore('convs'));
      tx.oncomplete = () => resolve(req ? req.result : true);
      tx.onerror = () => resolve(undefined);
      tx.onabort = () => resolve(undefined);
    } catch { resolve(undefined); }
  })));
}

/** Saves one conversation; true when it was kept. */
export async function put(c) {
  if (await open()) return (await run('readwrite', (s) => s.put(c))) !== undefined;
  return store.set(`jchat:conv:${c.id}`, c);
}
export async function del(id) {
  if (await open()) await run('readwrite', (s) => s.delete(id));
  store.del(`jchat:conv:${id}`);
}
export async function clear() {
  if (await open()) await run('readwrite', (s) => s.clear());
}

/** Every saved conversation, in the order of the id list; chats still in localStorage are moved to IndexedDB. */
export async function loadAll() {
  const ids = store.get('jchat:index', []);
  const d = await open();
  const byId = new Map();
  if (d) for (const c of (await run('readonly', (s) => s.getAll())) || []) if (c && c.id) byId.set(c.id, c);
  const legacy = new Set(ids);
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('jchat:conv:')) legacy.add(k.slice(11)); } } catch { /* blocked */ }
  const order = [...ids];
  for (const id of legacy) {
    const c = store.get(`jchat:conv:${id}`, null);
    if (!c || !c.id) continue;
    if (!byId.has(id)) {
      if (d && (await put(c))) byId.set(id, c);
      else if (!d) byId.set(id, c);
    }
    if (d && byId.has(id)) store.del(`jchat:conv:${id}`); // moved: the space is free again
    if (!order.includes(id)) order.push(id);
  }
  const out = [];
  for (const id of order) if (byId.has(id)) { out.push(byId.get(id)); byId.delete(id); }
  for (const c of byId.values()) out.push(c); // in the database but not in the list (a crash between the two)
  return out;
}
