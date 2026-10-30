// Video, audio and caption files on slides (deck-video.js), kept in this browser's IndexedDB: a deck only names
// them by id (slide.media[].src), so a 100 MB video never goes into the conversation's JSON. Modelled on
// convstore.js: a lost connection (WebKit drops it while a tab sleeps) is opened again, and a failed
// transaction is tried once more on a new one. Records: { id, blob, type, name, size, conv, at }.

let dbp = null;
function open() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  if (dbp) return dbp;
  const p = new Promise((resolve) => {
    try {
      const r = indexedDB.open('eden-deck-media', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('files', { keyPath: 'id' });
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

/** One transaction: { ok, value } or { ok: false, error } (a full disk is not tried again). */
async function run(mode, fn) {
  let last = null;
  for (let tries = 0; tries < 2; tries++) {
    const p = open();
    const d = await p;
    if (!d) return { ok: false, error: new Error('This browser can’t store files (private window?).') };
    const got = await new Promise((resolve) => {
      try {
        const tx = d.transaction('files', mode);
        const req = fn(tx.objectStore('files'));
        tx.oncomplete = () => resolve({ ok: true, value: req ? req.result : true });
        tx.onerror = () => resolve({ ok: false, error: tx.error });
        tx.onabort = () => resolve({ ok: false, error: tx.error });
      } catch (e) { resolve({ ok: false, error: e }); }
    });
    if (got.ok) return got;
    last = got;
    if (got.error && got.error.name === 'QuotaExceededError') return got;
    if (dbp === p) { dbp = null; try { d.close(); } catch { /* closed */ } }
  }
  return last;
}

/** Keeps a file; throws with a readable message when it can't (the browser's storage is full, or there is none). */
export async function putMedia(rec) {
  const r = await run('readwrite', (s) => s.put({ ...rec, at: rec.at || Date.now() }));
  if (!r.ok) throw new Error(r.error && r.error.name === 'QuotaExceededError' ? 'This browser has no room left for the file.' : (r.error && r.error.message) || 'The file couldn’t be stored.');
  return true;
}
/** One file's record, or null (not on this device). */
export async function getMedia(id) {
  const r = await run('readonly', (s) => s.get(id));
  return r.ok && r.value && r.value.blob ? r.value : null;
}
export async function delMedia(id) { return (await run('readwrite', (s) => s.delete(id))).ok; }
/** Every stored id with its conversation and time (the blobs stay on disk). */
export async function listMedia() {
  const r = await run('readonly', (s) => s.getAll());
  return r.ok && Array.isArray(r.value) ? r.value.map((x) => ({ id: x.id, conv: x.conv, at: x.at, size: x.size })) : [];
}
