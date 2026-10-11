// Meaning-based search over the user's chats: each chat's title and opening lines are embedded once
// (POST /api/chat/embed, 256 numbers) and the vector is kept in this browser (IndexedDB), so a search
// embeds only the question and whatever chats are new. Any failure leaves word matching to do the work.

import { postJSON } from './api.js';
import { chatDigest } from './recall-model.js';

let dbp = null;
function open() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  dbp ||= new Promise((resolve) => {
    try {
      const r = indexedDB.open('eden-chat-vecs', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('v', { keyPath: 'id' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = r.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbp;
}
const tx = (mode, fn) => open().then((d) => (!d ? undefined : new Promise((resolve) => {
  try { const t = d.transaction('v', mode); const q = fn(t.objectStore('v')); t.oncomplete = () => resolve(q ? q.result : true); t.onerror = t.onabort = () => resolve(undefined); } catch { resolve(undefined); }
})));

const BATCH = 50;
const MAX_NEW = 600; // chats embedded in one search; the rest on the next one

/** What a chat's vector was made from (bug sweep AS2-4): a hash of the very text embedded, so new opening lines (a synced stub filled in) embed it again. */
function sig(c) {
  const text = chatDigest(c);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `d${text.length}:${h.toString(36)}`;
}

/**
 * { chatId: vector } for the chats that have one, embedding up to MAX_NEW new or changed ones first. A temporary,
 * course or private chat (`privacy: true`, or `isPrivate(c)`: privacy.js privacyOn) is never sent to the embedding
 * call, and a vector it had from before (made while it wasn't private) is deleted (bug sweep AS2-3).
 */
export async function chatVectors(convs, { isPrivate = () => false } = {}) {
  const have = new Map(((await tx('readonly', (s) => s.getAll())) || []).map((r) => [r.id, r]));
  const off = (c) => !c || c.temp || c.course || c.privacy === true || isPrivate(c);
  const ok = (convs || []).filter((c) => !off(c) && c.nodes);
  const drop = (convs || []).filter((c) => c && off(c) && have.has(c.id)).map((c) => c.id);
  if (drop.length) { for (const id of drop) have.delete(id); await tx('readwrite', (s) => { for (const id of drop) s.delete(id); }); }
  const todo = ok.filter((c) => !have.has(c.id) || have.get(c.id).sig !== sig(c)).slice(0, MAX_NEW);
  for (let i = 0; i < todo.length; i += BATCH) {
    const part = todo.slice(i, i + BATCH);
    try {
      const r = await postJSON('/api/chat/embed', { texts: part.map(chatDigest) });
      if (!r || !Array.isArray(r.vectors) || r.vectors.length !== part.length) break;
      const recs = part.map((c, k) => ({ id: c.id, sig: sig(c), vec: r.vectors[k] }));
      for (const rec of recs) have.set(rec.id, rec);
      await tx('readwrite', (s) => { for (const rec of recs) s.put(rec); });
    } catch { break; }
  }
  const out = {};
  for (const c of ok) { const r = have.get(c.id); if (r && Array.isArray(r.vec)) out[c.id] = r.vec; }
  return out;
}

/** The question's vector, or null. */
export async function queryVector(q) {
  try { const r = await postJSON('/api/chat/embed', { texts: [String(q).slice(0, 500)] }); return r && r.vectors && r.vectors[0] ? r.vectors[0] : null; } catch { return null; }
}
