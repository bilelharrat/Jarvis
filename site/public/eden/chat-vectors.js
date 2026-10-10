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

/** { chatId: vector } for the chats that have one, embedding up to MAX_NEW new or changed ones first. */
export async function chatVectors(convs) {
  const have = new Map(((await tx('readonly', (s) => s.getAll())) || []).map((r) => [r.id, r]));
  const sig = (c) => `${c.updated || 0}:${(c.title || '').length}`;
  const todo = convs.filter((c) => !c.temp && c.nodes && (!have.has(c.id) || have.get(c.id).sig !== sig(c))).slice(0, MAX_NEW);
  for (let i = 0; i < todo.length; i += BATCH) {
    const part = todo.slice(i, i + BATCH);
    try {
      const r = await postJSON('/api/chat/embed', { texts: part.map(chatDigest) });
      if (!r || !Array.isArray(r.vectors) || r.vectors.length !== part.length) break;
      part.forEach((c, k) => have.set(c.id, { id: c.id, sig: sig(c), vec: r.vectors[k] }));
      await tx('readwrite', (s) => { part.forEach((c, k) => s.put({ id: c.id, sig: sig(c), vec: r.vectors[k] })); });
    } catch { break; }
  }
  const out = {};
  for (const c of convs) { const r = have.get(c.id); if (r && Array.isArray(r.vec)) out[c.id] = r.vec; }
  return out;
}

/** The question's vector, or null. */
export async function queryVector(q) {
  try { const r = await postJSON('/api/chat/embed', { texts: [String(q).slice(0, 500)] }); return r && r.vectors && r.vectors[0] ? r.vectors[0] : null; } catch { return null; }
}
