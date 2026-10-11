// Where conversations live in this browser: IndexedDB (hundreds of MB, where localStorage held
// ~5 MB), one record per conversation. localStorage keeps only the small id list (jchat:index) for
// the first paint and for chats saved by older versions, which loadAll() moves over once. When
// IndexedDB isn't available (some private windows) it falls back to localStorage as before.

import { store } from './util.js';

// The sidebar's list records (askeden opt2-ae-web) live beside them in a separate small database,
// eden-chat-list: one record per saved chat with only what the sidebar draws (title, dates, pin, folder,
// kind, project, persona, a few flags), written after each put and delete, so the page can paint the
// list before the bodies load (state.js loadListRecords, app.js). They are a hint: the full load is what
// counts, and it reconciles them (reconcileList). Two traps it avoids (r1-optimize-client-compute §5): the
// `convs` records keep their format (a tab still on the old code merges what it reads, and would save a
// chat with no messages back), and eden-chats stays at version 1 (an old tab holding version 1 open would
// block an upgrade, and onblocked would leave this page with no chats); an old tab's own saves leave the
// list behind until the next full load puts it right.

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
  if (await open()) {
    const ok = (await run('readwrite', (s) => s.put(c))) !== undefined;
    if (ok) listQueue(c.id, listRecord(c));
    return ok;
  }
  return store.set(`jchat:conv:${c.id}`, c);
}
/** One saved conversation, or null (another tab saved it: state.js). */
export async function get(id) {
  if (await open()) return (await run('readonly', (s) => s.get(id))) || null;
  return store.get(`jchat:conv:${id}`, null);
}
export async function del(id) {
  if (await open()) { await run('readwrite', (s) => s.delete(id)); listQueue(id, null); }
  store.del(`jchat:conv:${id}`);
}
export async function clear() {
  if (await open()) { await run('readwrite', (s) => s.clear()); listQueue(null, null); }
}

/* ---------- the sidebar's list records (eden-chat-list) ---------- */

const LIST_V = 1; // a record of another shape is ignored by the first paint and rewritten by reconcileList
let ldbp = null;
function openList() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  ldbp ||= new Promise((resolve) => {
    try {
      const r = indexedDB.open('eden-chat-list', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('list', { keyPath: 'id' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return ldbp;
}
function runList(mode, fn) {
  return openList().then((d) => (!d ? undefined : new Promise((resolve) => {
    try {
      const tx = d.transaction('list', mode);
      const req = fn(tx.objectStore('list'));
      tx.oncomplete = () => resolve(req ? req.result : true);
      tx.onerror = () => resolve(undefined);
      tx.onabort = () => resolve(undefined);
    } catch { resolve(undefined); }
  })));
}
// The list's writes, never holding up the body's save: queued by id (the newest record wins) and written in one
// transaction, again for whatever arrived while one was being written. A sync storing thousands of chats at once makes a
// few transactions, not one per chat. `id` null: clear the list first. listFlushed() resolves once the queue is written.
let listPending = new Map();
let listClear = false;
let listFlush = null; // the running flush (a promise), or null
function listQueue(id, rec) {
  if (id === null) { listPending = new Map(); listClear = true; } else listPending.set(id, rec);
  listFlush ??= (async () => {
    try {
      while (listPending.size || listClear) {
        const q = listPending, wipe = listClear;
        listPending = new Map();
        listClear = false;
        await runList('readwrite', (s) => { if (wipe) s.clear(); for (const [k, r] of q) { if (r) s.put(r); else s.delete(k); } });
      }
    } catch { /* a hint: the next full load puts it right */ } finally { listFlush = null; }
  })();
  return listFlush;
}
export const listFlushed = () => listFlush || Promise.resolve();
/** Another tab's save or delete as this tab read it (a tab on older code doesn't write the list itself). */
export function listSaw(id, c) {
  if (typeof indexedDB === 'undefined') return;
  listQueue(id, c && !c.temp ? listRecord(c) : null);
}

/** What the sidebar needs of a conversation, and nothing else (no messages). */
export function listRecord(c) {
  const p = c.project && typeof c.project === 'object' ? c.project : null;
  const r = { v: LIST_V, id: c.id, title: c.title, updated: c.updated || 0, kind: c.kind || 'chat', has: Boolean(c.root && c.root.children && c.root.children.length) };
  if (c.titleSet) r.titleSet = true;
  if (c.created) r.created = c.created;
  if (c.metaAt) r.metaAt = c.metaAt;
  if (c.pinned) r.pinned = true;
  if (c.folder) r.folder = c.folder;
  if (p) r.project = { name: p.name, path: p.path, ...(p.branch ? { branch: p.branch } : {}) };
  if (c.personaId) r.personaId = c.personaId;
  if (c.source) r.source = c.source;
  if (c.status === 'waiting') r.status = 'waiting';
  if (c.remote) r.remote = true;
  if (c.temp) r.temp = true;
  return r;
}

/** The list records, for the first paint (null: none, or no IndexedDB). Never written back as conversations. */
export async function loadList() {
  const all = await runList('readonly', (s) => s.getAll());
  const out = (all || []).filter((r) => r && r.v === LIST_V && typeof r.id === 'string');
  return out.length ? out : null;
}

/**
 * After the full load: the list made to match the bodies (`convs`, what loadAll returned): records written for chats
 * that are new or changed (another device, an old tab, the first load with this code), and dropped for chats that are
 * gone. One transaction; the conversations themselves are never written here.
 */
export async function reconcileList(convs) {
  if (!(await open())) return 0;
  const have = new Map();
  for (const r of (await runList('readonly', (s) => s.getAll())) || []) if (r && typeof r.id === 'string') have.set(r.id, JSON.stringify(r));
  const puts = [];
  const ids = new Set();
  for (const c of convs) {
    if (!c || !c.id || ids.has(c.id)) continue;
    ids.add(c.id);
    const r = listRecord(c);
    if (have.get(c.id) !== JSON.stringify(r)) puts.push(r);
  }
  const dels = [...have.keys()].filter((id) => !ids.has(id));
  if (!puts.length && !dels.length) return 0;
  for (const r of puts) listQueue(r.id, r);
  for (const id of dels) listQueue(id, null);
  await listFlushed();
  return puts.length + dels.length;
}

/** A save the page was closed in the middle of (state.js keeps it here, synchronously, at pagehide). */
export const PENDING = 'jchat:pending:';

/** Every saved conversation, in the order of the id list; chats still in localStorage are moved to IndexedDB. */
export async function loadAll() {
  const ids = store.get('jchat:index', []);
  const d = await open();
  const byId = new Map();
  if (d) for (const c of (await run('readonly', (s) => s.getAll())) || []) if (c && c.id) byId.set(c.id, c);
  // Saves cut short by a reload or close: newer than what's stored (a save that landed removes its copy).
  const pending = [];
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(PENDING)) pending.push(k); } } catch { /* blocked */ }
  for (const k of pending) {
    const c = store.get(k, null);
    if (!c || !c.id) { store.del(k); continue; }
    if (d) { byId.set(c.id, c); if (await put(c)) store.del(k); }
    else if (store.set(`jchat:conv:${c.id}`, c)) store.del(k);
  }
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
