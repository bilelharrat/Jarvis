// Meaning vectors for the user's chats on this device: 256 numbers a chat in IndexedDB (`eden-chat-vecs`),
// hydrated into an in-memory cache so synchronous recall (`recallBlock`) and tool search (`searchChats`)
// can blend dense semantic similarity with BM25F lexical scoring.
import { chatDigest, chatDigestHash } from './recall-model.js';
import { privacyOn } from './privacy.js';
import { apiUrl, isMock } from './api.js';
import { state } from './state.js';

const DB = 'eden-chat-vecs';
const STORE = 'v';
const MAX_Q_CACHE = 64;
let embedCooldownUntil = 0;

function canCallEmbed() {
  if (isMock || typeof fetch !== 'function') return false;
  if (Date.now() < embedCooldownUntil) return false;
  if (state && state.settings && state.settings.recall === false) return false;
  const meta = state && state.meta;
  if (!meta) return false;
  if (meta.hosted) return meta.authenticated !== false;
  if (Array.isArray(meta.providers)) {
    return meta.providers.some((p) => (p.id === 'gemini' || p.id === 'openai') && p.available);
  }
  return true;
}

/** In-memory mirror of `{ [chatId]: number[] }` hydrated from IndexedDB and live `/api/chat/embed` calls. */
const memVecs = Object.create(null);
/** In-memory metadata `{ [chatId]: { updated: number, hash: string } }`. */
const memMeta = Object.create(null);
/** Chat IDs currently being embedded in-flight so concurrent calls never duplicate work. */
const inFlightIds = new Set();
let idbLoaded = false;
let idbLoadPromise = null;
let clearGen = 0;

/** LRU cache for query embeddings (`normalizedQuery -> number[]`) + in-flight deduplication. */
const qCache = new Map();
const qInflight = new Map();

export const normQuery = (q) => String(q || '').normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 800);

function deleteVecById(id) {
  if (!id) return;
  delete memVecs[id];
  delete memMeta[id];
  inFlightIds.delete(id);
  openDb().then((db) => {
    if (db) {
      try { db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id); } catch {}
    }
  });
}

if (typeof addEventListener === 'function') {
  addEventListener('eden:conv-deleted', (e) => {
    const id = e && e.detail && e.detail.id;
    if (id) deleteVecById(id);
  });
  addEventListener('eden:other-account', () => { clearChatVectors().catch(() => {}); });
  addEventListener('eden:owner-cleared', () => { clearChatVectors().catch(() => {}); });
}

function openDb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((res) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'id' }); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => res(null);
    } catch { res(null); }
  });
}

function hydrateFromIdb() {
  if (idbLoaded) return Promise.resolve();
  if (idbLoadPromise) return idbLoadPromise;
  idbLoadPromise = (async () => {
    const db = await openDb();
    if (db) {
      const all = await new Promise((res) => {
        try {
          const r = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
          r.onsuccess = () => res(r.result || []);
          r.onerror = () => res([]);
        } catch { res([]); }
      });
      for (const x of all) {
        if (x && x.id && Array.isArray(x.vec) && x.vec.length) {
          memVecs[x.id] = x.vec;
          memMeta[x.id] = { updated: x.updated || 0, hash: x.hash || '' };
        }
      }
    }
    idbLoaded = true;
  })();
  return idbLoadPromise;
}

/** Synchronous snapshot of all currently cached chat vectors (`{ [chatId]: number[] }`). */
export function peekChatVectors() {
  return memVecs;
}

/** Synchronous lookup of a cached query vector, or null if not yet embedded. */
export function peekQueryVector(q) {
  const k = normQuery(q);
  return k && qCache.has(k) ? qCache.get(k) : null;
}

/**
 * Prunes any cached vector whose chat was deleted, marked temporary/private, or is no longer in `allConvs`.
 */
async function pruneVectors(convs) {
  const stateConvs = Array.isArray(state && state.convs) ? state.convs : null;
  const fullList = stateConvs && stateConvs.length ? stateConvs : convs;
  if (!Array.isArray(fullList)) return;
  const authoritative = fullList === stateConvs || !stateConvs || stateConvs.length === 0;
  const validIds = new Set();
  const blockedIds = new Set();
  for (const c of fullList) {
    if (!c || !c.id) continue;
    if (c.temp || c.course || privacyOn(c) || !c.nodes) blockedIds.add(c.id);
    else validIds.add(c.id);
  }
  for (const c of convs || []) {
    if (c && c.id && (c.temp || c.course || privacyOn(c))) blockedIds.add(c.id);
  }
  const toDelete = [];
  for (const id of Object.keys(memVecs)) {
    if (blockedIds.has(id) || (authoritative && !validIds.has(id))) {
      delete memVecs[id];
      delete memMeta[id];
      toDelete.push(id);
    }
  }
  if (toDelete.length) {
    const db = await openDb();
    if (db) {
      try {
        const tx = db.transaction(STORE, 'readwrite').objectStore(STORE);
        for (const id of toDelete) tx.delete(id);
      } catch {}
    }
  }
}

/** Wipes all cached chat and query vectors from memory and IndexedDB (e.g. on sign-out or clear-all). */
export async function clearChatVectors() {
  clearGen++;
  for (const k of Object.keys(memVecs)) delete memVecs[k];
  for (const k of Object.keys(memMeta)) delete memMeta[k];
  qCache.clear();
  qInflight.clear();
  inFlightIds.clear();
  const db = await openDb();
  if (db) {
    try { db.transaction(STORE, 'readwrite').objectStore(STORE).clear(); } catch {}
  }
}

/**
 * Hydrates IndexedDB vectors, prunes deleted/privatized chats, and embeds up to 24 unindexed or modified chats via `/api/chat/embed`.
 * Returns `{ [chatId]: number[] }`.
 */
export async function chatVectors(convs) {
  await hydrateFromIdb();
  await pruneVectors(convs);
  const need = [];
  for (const c of convs || []) {
    if (!c || !c.id || c.temp || c.course || privacyOn(c) || !c.nodes || inFlightIds.has(c.id)) continue;
    const when = c.updated || c.created || 0;
    const hash = chatDigestHash(c);
    const meta = memMeta[c.id];
    const hasVec = Array.isArray(memVecs[c.id]) && memVecs[c.id].length > 0;
    const stale = !hasVec || !meta || meta.updated < when || (meta.hash && meta.hash !== hash);
    if (stale) {
      const text = chatDigest(c);
      if (text) need.push({ id: c.id, updated: when, hash, text });
    }
    if (need.length >= 24) break;
  }
  if (need.length && canCallEmbed()) {
    const gen = clearGen;
    for (const n of need) inFlightIds.add(n.id);
    try {
      const r = await fetch(apiUrl('/api/chat/embed'), {
        method: 'POST',
        headers: { 'X-Jarvis-Chat': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ texts: need.map((n) => n.text) }),
      });
      if (r.ok && gen === clearGen) {
        const { vectors = [] } = await r.json();
        if (gen === clearGen) {
          const db = await openDb();
          const tx = db ? db.transaction(STORE, 'readwrite').objectStore(STORE) : null;
          need.forEach((n, i) => {
            if (!inFlightIds.has(n.id)) return;
            if (Array.isArray(vectors[i]) && vectors[i].length) {
              memVecs[n.id] = vectors[i];
              memMeta[n.id] = { updated: n.updated, hash: n.hash };
              if (tx) try { tx.put({ id: n.id, updated: n.updated, hash: n.hash, vec: vectors[i] }); } catch {}
            }
          });
        }
      } else if (r.status === 401 || r.status === 403 || r.status === 409) {
        embedCooldownUntil = Date.now() + 120_000;
      }
    } catch {} finally {
      for (const n of need) inFlightIds.delete(n.id);
    }
  }
  return memVecs;
}

/** Non-blocking background hydration + incremental embedding for `convs`. */
export function warmChatVectors(convs) {
  chatVectors(convs).catch(() => {});
}

/**
 * Embeds a single search query `q` with LRU caching and in-flight deduplication.
 * Optional `timeoutMs` returns `null` if the network takes longer than `timeoutMs`, while allowing
 * the underlying fetch to finish and populate `qCache` in the background.
 */
export async function queryVector(q, { timeoutMs = 0 } = {}) {
  const key = normQuery(q);
  if (!key) return null;
  if (qCache.has(key)) {
    const v = qCache.get(key);
    qCache.delete(key);
    qCache.set(key, v);
    return v;
  }
  if (!canCallEmbed()) return null;
  let p = qInflight.get(key);
  if (!p) {
    const gen = clearGen;
    p = (async () => {
      try {
        const r = await fetch(apiUrl('/api/chat/embed'), {
          method: 'POST',
          headers: { 'X-Jarvis-Chat': '1', 'content-type': 'application/json' },
          body: JSON.stringify({ texts: [String(q || '').slice(0, 800)] }),
        });
        if (!r.ok) {
          if (r.status === 401 || r.status === 403 || r.status === 409) embedCooldownUntil = Date.now() + 120_000;
          return null;
        }
        const { vectors = [] } = await r.json();
        const vec = Array.isArray(vectors[0]) && vectors[0].length ? vectors[0] : null;
        if (vec && gen === clearGen) {
          if (qCache.size >= MAX_Q_CACHE) {
            const oldest = qCache.keys().next().value;
            if (oldest !== undefined) qCache.delete(oldest);
          }
          qCache.set(key, vec);
        }
        return gen === clearGen ? vec : null;
      } catch {
        return null;
      } finally {
        qInflight.delete(key);
      }
    })();
    qInflight.set(key, p);
  }
  if (timeoutMs > 0) {
    let timer = null;
    return Promise.race([
      p,
      new Promise((res) => { timer = setTimeout(() => res(null), timeoutMs); }),
    ]).finally(() => { if (timer !== null) clearTimeout(timer); });
  }
  return p;
}
