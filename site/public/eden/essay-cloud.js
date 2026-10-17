// Essays on every device (askeden.com; the server is site/src/accounts/essay-sync.js). On whenever chat
// sync is (cloud-sync.js): askeden.com seals each essay at rest under the account's key, as it does chats,
// and End-to-end mode (whose key only the devices hold) keeps essays on the device instead.
//
// Each local essay carries `rev` (the server's revision it matches) and `synced` (its `updated` when it
// last matched). Pull: the list since the last revision seen; a newer server copy replaces an unchanged
// local one; when both changed, the server's is kept as a copy ("… (other device)") so neither is lost,
// and this device's goes up over it. Push: every essay changed since it last matched. A delete is a
// tombstone, so other devices drop it too. Runs when Essays opens, after saves, and every minute while
// the page is visible.

import { apiUrl, isMock } from './api.js';
import { state } from './state.js';

const EVERY = 60_000;
const SINCE = 'eden:essays:since';
const GONE = 'eden:essays:deleted'; // deletes not yet sent
const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

let H = null; // { list, get, save, remove, onPulled(essay, how), busy(id) }
let again = false, timer = 0, soonT = 0, lastError = '';

async function post(path, body) {
  let res;
  try { res = await fetch(apiUrl(path), { method: 'POST', cache: 'no-store', headers: { 'X-Jarvis-Chat': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
  catch { throw Object.assign(new Error('Can’t reach askeden.com.'), { status: 0 }); }
  let out = {};
  try { out = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw Object.assign(new Error(out.error || `askeden.com said ${res.status}.`), { status: res.status });
  return out;
}

/** Is essay sync on here? askeden.com, signed in, chat sync on (not End-to-end). */
export async function syncOn() {
  if (isMock || !(state.meta && state.meta.hosted)) return false;
  try { return (await import('./cloud-sync.js')).info().on === true; } catch { return false; }
}
export const lastSyncError = () => lastError;

/** An essay changed here since it last matched the server. */
export const dirty = (e) => !e.rev || (e.updated || 0) > (e.synced || 0);
const wire = (e) => { const { rev, synced, ...rest } = e; void rev; void synced; return rest; };

/** Start: hooks into essay.js's storage; syncs now, every minute, and when the page comes back. */
export function startEssaySync(hooks) {
  if (H) return;
  H = hooks;
  syncNow();
  timer = setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, EVERY);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNow(); });
}

/** Stop (tests; a signed-out page). */
export function stopEssaySync() { clearInterval(timer); clearTimeout(soonT); H = null; }

/** After a save: soon, not on every keystroke. */
export function syncSoon(ms = 2500) { clearTimeout(soonT); soonT = setTimeout(syncNow, ms); }

/** A deleted essay: its tombstone goes up (now, or when sync can). */
export function noteDeleted(e) {
  if (!e || !e.rev) return;
  write(GONE, [...new Set([...read(GONE, []), e.id])]);
  syncSoon(300);
}

/** Syncs now; a call while one runs waits for it and one more pass after it. */
let runP = null;
export function syncNow() {
  if (!H) return Promise.resolve();
  if (runP) { again = true; return runP; }
  runP = (async () => { do { again = false; await runOnce(); } while (again && H); })().finally(() => { runP = null; });
  return runP;
}

async function runOnce() {
  if (!H || !(await syncOn())) return;
  try {
    let changed = false;
    // deletes first, so a pull can't bring one back
    for (const id of read(GONE, [])) {
      try { await post('/api/web/essays/delete', { id }); write(GONE, read(GONE, []).filter((x) => x !== id)); } catch { /* next time */ }
    }
    // pull
    let since = Number(read(SINCE, 0)) || 0;
    for (let page = 0; page < 20; page++) {
      const out = await post('/api/web/essays/list', { since });
      for (const it of out.items) { if (await pullOne(it)) changed = true; since = Math.max(since, it.rev); }
      if (!out.more) break;
    }
    write(SINCE, since);
    // push
    for (const e of await H.list()) if (dirty(e) && !H.busy(e.id)) { if (await pushOne(e)) changed = true; }
    lastError = '';
    if (changed) H.onPulled(null, 'list');
    if (H.onSynced) H.onSynced();
  } catch (err) {
    lastError = err.message;
  }
}

async function fetchEssay(id) {
  const got = await post('/api/web/essays/get', { id });
  return got.deleted ? null : { ...got.essay, rev: got.rev, synced: got.essay.updated };
}

/** One list entry from the server; true when this device's essays changed. */
async function pullOne(it) {
  const local = await H.get(it.id);
  if (local && local.rev === it.rev) return false; // ours, or already have it
  if (it.deleted) {
    if (!local) return false;
    if (dirty(local) || H.busy(it.id)) return false; // changed here after it was deleted elsewhere: it goes up again
    await H.remove(it.id);
    H.onPulled(local, 'deleted');
    return true;
  }
  if (it.unreadable) return false;
  const remote = await fetchEssay(it.id);
  if (!remote) return false;
  if (!local) { await H.save(remote); return true; }
  if (!dirty(local) && !H.busy(it.id)) { await H.save(remote); H.onPulled(remote, 'updated'); return true; }
  // both changed: the server's becomes a copy here; this device's goes up over it
  await keepCopy(remote);
  local.rev = it.rev;
  await H.save(local);
  return true;
}

/** The other device's version, kept as its own essay (it syncs up too). */
async function keepCopy(remote) {
  const title = (remote.details && remote.details.title) || 'Untitled essay';
  const copy = { ...remote, id: `${remote.id}-c${Date.now().toString(36)}`, details: { ...remote.details, title: `${title} (other device)` }, rev: 0, synced: 0, updated: Date.now() };
  await H.save(copy);
}

/** One local essay up; true when this device's essays changed. */
async function pushOne(e, tries = 0) {
  const out = await post('/api/web/essays/put', { id: e.id, essay: wire(e), base_rev: e.rev || 0 });
  if (out.rev) {
    const now = await H.get(e.id);
    if (!now) return false;
    now.rev = out.rev;
    if ((now.updated || 0) <= (e.updated || 0)) now.synced = e.updated; // not changed again while it went up
    await H.save(now);
    return false;
  }
  if (out.conflict && tries < 2) {
    if (out.conflict.essay) await keepCopy({ ...out.conflict.essay, rev: out.conflict.rev });
    const now = await H.get(e.id);
    if (!now) return false;
    now.rev = out.conflict.rev; // a tombstone, or the copy just kept: write over it
    await H.save(now);
    await pushOne(now, tries + 1);
    return true;
  }
  if (out.code) lastError = out.error || 'This essay didn’t sync.';
  return false;
}
