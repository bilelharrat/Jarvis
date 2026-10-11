// Chat history that follows the account, with nothing to set up (ROADMAP H1 follow-up;
// docs/accounts.md "Chat sync"). Every signed-in account at askeden.com: conversations are sent to
// the account and kept there sealed at rest by askeden.com (chat-sync.js on the server), so a
// new browser, the Mac app or the iPhone app shows the same list after signing in. People who
// want a key only their devices hold use End-to-end encryption (sync.js) instead; while that is
// set up, this stays off.
//
// The list comes first (the sidebar fills in at once, each chat a stub), then the newest chats are
// fetched in the background and the rest when opened (`eden:conv-opened`). Pull, then push, every
// ~30 s while the tab is visible and in use (every 2 minutes while it sits idle) and when it gets
// focus. Two devices' branches are united by message id (sync-model.js merge); a delete is a
// tombstone; temporary chats never leave the browser; images stay local (a placeholder travels; a conversation over ~1.4 MB isn't synced).

import { state, ui, persistConversation } from './state.js';
import { store } from './util.js';
import { apiUrl, isMock } from './api.js';
import { applyConv, removeConv, refreshStatus } from './sync.js';
import { merge, payload, syncable, stub, planList, onConflict, differs, stampOf, takeIn, MAX_ACCOUNT_JSON } from './sync-model.js';

const PUSH_DELAY = 2500;
const EVERY = 30_000;
// Visible but not in use (no key, click, touch or wheel for 2 minutes): other devices' changes are looked for every
// 2 minutes instead of every 30 s (r2 iOS sweep: an idle phone listed every 30 s all day). Using the page, a saved
// chat, focus and coming back to the page still sync at once.
const IDLE_AFTER = 2 * 60_000;
const IDLE_EVERY = 2 * 60_000;
const USE = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
const EAGER = 40; // chats fetched right after the list; the rest when opened
const PARALLEL = 3;
// Several chats a request (csync/batch, chat-sync.js): up to BATCH chats with their JSON under BATCH_CHARS, and
// up to BATCH_DELETES deletes. A server without it answers 404 and this page goes back to one chat a request.
const BATCH = 25;
const BATCH_CHARS = 3_000_000;
const BATCH_DELETES = 100;
// Several chats' bodies a request (csync/getmany): a new device's first downloads were one request a chat. An older
// server answers 404 and this page fetches one chat a request again.
const GET_MANY = 25;
// The state's version: 2 lists everything again once (version 1 kept a cursor that skipped all but the first 200 rows of a list).
const VERSION = 2;
// `gen`: which run of this state it is (a wipe starts a new one); another tab's saved state is taken in only from the same run (AS2-2).
const blank = () => ({ v: VERSION, gen: Math.random().toString(36).slice(2, 10), since: 0, revs: {}, seen: {}, deleted: [], last: 0 });

let account = null;
let local = null; // { since, revs: {id: rev}, seen: {id: updated}, deleted: [ids], last }
let enabled = false;
let running = false;
let again = false;
let timer = null;
let pushTimer = null;
let lastError = '';
let tooBig = 0;
let backoffUntil = 0; // askeden.com asked for a pause (429 retry-after): nothing is sent before then
let lastUse = Date.now(); // the person's last key, click, touch or wheel on the page
let lastLook = 0; // the last pass's start
let batching = true; // false once askeden.com said it has no csync/batch (an older server)
let getMany = true; // false once askeden.com said it has no csync/getmany
const dirty = new Set();
const ownRevs = new Set(); // revisions this pass's puts made (each put is the account's next revision)
const fetching = new Set();
const listeners = new Set();

const stateKey = () => `jchat:csync:${account}`;
// Deletes askeden.com answered for, from this tab: never queued again from what another tab saved before it knew (AS2-2).
const sent = new Set();
/**
 * Every tab of this browser keeps its sync state under one key (bug sweep AS2-2: a tab's save wrote over a delete
 * another tab had queued and not sent yet, so it was never sent). Before a pass and before each save, what another
 * tab saved is taken in: its unsent deletes, and its revisions for chats this tab holds as that tab sent them.
 */
function adopt() {
  if (!local) return;
  const have = new Map(state.convs.map((c) => [c.id, c]));
  const took = takeIn(local, store.get(stateKey(), null), { sent, stampHere: (id) => { const c = have.get(id); return !c ? undefined : c.remote ? null : stampOf(c); } });
  for (const id of took) dirty.delete(id);
}
const save = () => { if (!local) return; adopt(); store.set(stateKey(), local); };
const notify = () => { for (const fn of listeners) { try { fn(info()); } catch { /* a listener's problem */ } } };
export const onCloudChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

async function api(path, body = {}) {
  const init = { cache: 'no-store', method: 'POST', headers: { 'X-Jarvis-Chat': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) };
  let res;
  try { res = await fetch(apiUrl(path), init); }
  catch { throw Object.assign(new Error('Can’t reach askeden.com. Check your connection.'), { status: 0 }); }
  let out = {};
  try { out = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const wait = Number(res.headers.get('retry-after')) || 0;
    const text = res.status === 429 ? 'askeden.com asked this device to slow down; syncing goes on in a minute.' : out.error || `askeden.com said ${res.status}.`;
    throw Object.assign(new Error(text), { status: res.status, code: out.code, wait });
  }
  return out;
}

/** What askeden.com holds for this account: { count } or null. */
export async function serverStatus() { try { return await api('/api/web/csync/status'); } catch { return null; } }

export function info() {
  return {
    on: enabled, running, last: local ? local.last || 0 : 0, error: lastError, tooBig,
    chats: state.convs.filter((c) => !c.temp).length, waiting: state.convs.filter((c) => c.remote).length,
  };
}

/** One chat's body from askeden.com (csync/get, or one of csync/getmany's) into this device. → whether the sidebar changed. */
function applyGot(id, got) {
  if (got.deleted) { delete local.revs[id]; return removeConv(id); }
  if (state.streams.has(id)) return false;
  const mine = state.convs.find((x) => x.id === id);
  const remote = got.conv;
  if (!remote || remote.id !== id) return false;
  const merged = mine && !mine.remote ? merge(payload(mine, Infinity).conv, remote) : remote;
  const wasCurrent = mine && state.current === mine;
  applyConv(merged);
  local.revs[id] = got.rev;
  if (mine && !mine.remote && differs(remote, merged)) dirty.add(id);
  else local.seen[id] = stampOf(merged);
  if (wasCurrent) { const c = state.convs.find((x) => x.id === id); if (c) c.loading = false; ui.render(); }
  return true;
}

function failed(e) {
  if (e.status !== 404) lastError = e.message;
  if (e.status === 429) backoffUntil = Math.max(backoffUntil, Date.now() + Math.max(10, e.wait || 20) * 1000);
}

async function hydrate(id) {
  if (fetching.has(id) || !enabled || Date.now() < backoffUntil) return;
  fetching.add(id);
  try {
    if (applyGot(id, await api('/api/web/csync/get', { id }))) ui.renderSidebar();
  } catch (e) { failed(e); } finally { fetching.delete(id); }
}

/**
 * Many chats' bodies: GET_MANY a request (csync/getmany; askeden.com answers as many as fit, at least one, and the
 * rest go in the next request). An older askeden.com (404): one chat a request, PARALLEL at a time, as before.
 */
async function hydrateMany(ids) {
  const queue = ids.filter((id) => !fetching.has(id));
  while (getMany && queue.length > 1 && enabled && Date.now() >= backoffUntil) {
    const part = queue.slice(0, GET_MANY);
    for (const id of part) fetching.add(id);
    let got;
    try { got = await api('/api/web/csync/getmany', { ids: part }); }
    catch (e) {
      if (e.status === 404 && !e.code) { getMany = false; break; } // (a 404 with a code is the server's own answer)
      failed(e);
      return;
    } finally { for (const id of part) fetching.delete(id); }
    const items = Array.isArray(got.items) ? got.items : [];
    if (!items.length) break;
    let changed = false;
    const answered = new Set();
    for (const it of items) {
      if (!it || !part.includes(it.id) || answered.has(it.id)) continue;
      answered.add(it.id);
      if (!it.missing && !it.error && applyGot(it.id, it)) changed = true;
    }
    if (changed) ui.renderSidebar();
    if (!answered.size) break;
    for (let i = queue.length - 1; i >= 0; i--) if (answered.has(queue[i])) queue.splice(i, 1);
  }
  const worker = async () => { while (queue.length && enabled && Date.now() >= backoffUntil) await hydrate(queue.shift()); };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
}

async function pull() {
  const fresh = [];
  let listed = null; // a full list again (old tombstones were cleaned up): the ids it holds
  let whole = false; // the list reached its end (not cut off by the page limit)
  for (let page = 0; page < 200; page++) {
    const got = await api('/api/web/csync/list', { since: local.since });
    // Every server copy was removed after this device last synced (end-to-end took over, sync.js): start over, and see why.
    if (local.since > 0 && (got.rev < local.since || (got.wiped || 0) > local.since)) throw Object.assign(new Error(''), { wiped: true });
    // Tombstones newer than this device's cursor were cleaned up: list everything, and drop what's no longer there.
    // Once a pass (AS2-1): during the full list the cursor is a page's last row, still behind `pruned`, and starting
    // over on every page looped to the page limit, then dropped every chat after the first page.
    if (!listed && local.since > 0 && (got.pruned || 0) > local.since) { local.since = 0; listed = new Set(); continue; }
    if (listed) for (const it of got.items) listed.add(it.id);
    const have = new Map(state.convs.map((c) => [c.id, c]));
    const plan = planList(got.items, local.revs, have, new Set(state.streams.keys()));
    let changed = false;
    for (const id of plan.remove) { if (removeConv(id)) changed = true; delete local.revs[id]; delete local.seen[id]; }
    for (const it of got.items) if (it.deleted) delete local.revs[it.id];
    for (const meta of plan.stubs) {
      const s = stub(meta);
      const at = state.convs.findIndex((x) => (x.updated || 0) < (s.updated || 0));
      if (at < 0) state.convs.push(s); else state.convs.splice(at, 0, s);
      persistConversation(s);
      changed = true;
    }
    fresh.push(...plan.fetch);
    local.since = Math.max(local.since, got.rev);
    if (changed) ui.renderSidebar();
    if (!got.more) { whole = true; break; }
  }
  if (listed && whole) {
    let changed = false;
    const have = new Map(state.convs.map((c) => [c.id, c]));
    for (const id of Object.keys(local.revs)) {
      if (listed.has(id)) continue;
      // Changed here since it was last synced: it goes up again (as a put that finds a tombstone resurrects it), not away.
      const c = have.get(id);
      if (c && !c.remote && (dirty.has(id) || (local.seen[id] !== undefined && local.seen[id] !== stampOf(c)))) { delete local.revs[id]; dirty.add(id); continue; }
      if (removeConv(id)) changed = true;
      delete local.revs[id]; delete local.seen[id];
    }
    if (changed) ui.renderSidebar();
  }
  // Newest first: what changed, then stubs from earlier launches; the rest wait until opened.
  const waiting = state.convs.filter((c) => c.remote && !fresh.includes(c.id)).sort((a, b) => (b.updated || 0) - (a.updated || 0)).map((c) => c.id);
  await hydrateMany([...fresh, ...waiting].slice(0, EAGER));
}

async function pushOne(c) {
  const id = c.id;
  const p = payload(c, MAX_ACCOUNT_JSON);
  if (!p) { tooBig += 1; local.seen[id] = stampOf(c); dirty.delete(id); return; }
  const stamp = stampOf(c);
  const res = await api('/api/web/csync/put', { id, conv: p.conv, base_rev: local.revs[id] || 0 });
  afterPut(c, p, stamp, res);
}

/** What askeden.com said to one chat's put (alone, or in a batch). */
function afterPut(c, p, stamp, res) {
  const id = c.id;
  if (res.rev) { local.revs[id] = res.rev; local.seen[id] = stamp; dirty.delete(id); ownRevs.add(res.rev); return; }
  if (res.conflict) {
    const act = onConflict(c, res.conflict);
    if (act.action === 'drop') { if (removeConv(id)) ui.renderSidebar(); delete local.revs[id]; return; }
    if (act.action === 'resurrect') { local.revs[id] = act.rev; dirty.add(id); again = true; return; }
    if (res.conflict.conv) {
      applyConv(merge(p.conv, res.conflict.conv));
      ui.renderSidebar();
      if (state.current && state.current.id === id) ui.render();
    }
    local.revs[id] = act.rev;
    dirty.add(id);
    again = true;
    return;
  }
  if (res.code === 'too_big' || res.code === 'too_many') { tooBig += 1; lastError = res.error || ''; local.seen[id] = stamp; dirty.delete(id); }
}

/** A batch request; null when askeden.com has no csync/batch (then this page sends one chat a request from now on). */
async function batch(body) {
  try { return await api('/api/web/csync/batch', body); }
  catch (e) { if (e.status === 404) { batching = false; return null; } throw e; }
}

/** Deletes, BATCH_DELETES a request; each leaves the queue only when askeden.com answered for it. */
async function pushDeletes(gone) {
  while (batching && gone.length > 1) {
    const ids = gone.slice(0, BATCH_DELETES);
    let res;
    try { res = await batch({ deletes: ids }); }
    catch (e) { (local.deleted ||= []).push(...gone); throw e; }
    if (!res) break;
    const answered = new Set((res.deletes || []).filter((d) => d && d.rev !== undefined).map((d) => d.id));
    for (const id of ids) {
      if (answered.has(id)) { delete local.revs[id]; delete local.seen[id]; sent.add(id); }
      else (local.deleted ||= []).push(id); // not answered: the next pass
    }
    gone = gone.slice(ids.length);
  }
  for (const id of gone) {
    try { await api('/api/web/csync/delete', { id }); delete local.revs[id]; delete local.seen[id]; sent.add(id); }
    catch (e) { (local.deleted ||= []).push(...gone.slice(gone.indexOf(id))); throw e; }
  }
}

/** Puts, up to BATCH chats (BATCH_CHARS of JSON) a request; returns the chats left for one-at-a-time (no batches here). */
async function pushBatches(work) {
  let i = 0;
  while (batching && work.length - i > 1) {
    const group = [];
    let chars = 0;
    for (; i < work.length && group.length < BATCH; i++) {
      const c = work[i];
      const p = payload(c, MAX_ACCOUNT_JSON);
      if (!p) { tooBig += 1; local.seen[c.id] = stampOf(c); dirty.delete(c.id); continue; }
      const size = JSON.stringify(p.conv).length;
      if (group.length && chars + size > BATCH_CHARS) break;
      chars += size;
      group.push({ c, p, stamp: stampOf(c) });
    }
    if (!group.length) continue;
    const res = await batch({ puts: group.map(({ c, p }) => ({ id: c.id, conv: p.conv, base_rev: local.revs[c.id] || 0 })) });
    if (!res) return [...group.map((g) => g.c), ...work.slice(i)];
    const byId = new Map((res.puts || []).map((r) => [r && r.id, r]));
    for (const { c, p, stamp } of group) afterPut(c, p, stamp, byId.get(c.id) || {});
  }
  return work.slice(i);
}

async function push() {
  const gone = [...new Set(local.deleted || [])].filter((id) => !sent.has(id));
  local.deleted = [];
  await pushDeletes(gone);
  tooBig = 0;
  let work = state.convs.filter((c) => syncable(c, state.streams.has(c.id)) && (dirty.has(c.id) || local.seen[c.id] !== stampOf(c) || !local.revs[c.id]));
  work = await pushBatches(work);
  for (let i = 0; i < work.length; i += PARALLEL) {
    const done = await Promise.allSettled(work.slice(i, i + PARALLEL).map(pushOne));
    const bad = done.find((d) => d.status === 'rejected');
    if (bad) throw bad.reason;
  }
}

/** Web Locks, where the browser has them: one tab of this browser syncs an account at a time (AS2-2). */
const locks = () => (typeof navigator !== 'undefined' && navigator && navigator.locks && typeof navigator.locks.request === 'function' ? navigator.locks : null);

/**
 * One pass now: pull, then push; more when a conflict asked for it. Not before askeden.com's retry-after (the timer
 * it set runs then). While another tab of this browser is syncing, this one waits for it (a little later), then
 * starts from what that tab saved, so one edit is one upload, not one a tab.
 */
export async function syncNow() {
  if (!enabled || !local) return info();
  if (Date.now() < backoffUntil) return info();
  if (running) { again = true; return info(); }
  running = true;
  lastLook = Date.now();
  const L = locks();
  if (!L) return onePass();
  let ran = false;
  try {
    await L.request(`eden-csync:${account}`, { ifAvailable: true }, async (lock) => { if (!lock) return; ran = true; await onePass(); });
  } catch { if (!ran) return onePass(); } // (no locks here after all)
  if (!ran) { running = false; later(); }
  return info();
}

async function onePass() {
  running = true;
  let wiped = false;
  notify();
  try {
    adopt();
    for (let pass = 0; pass < 3; pass++) {
      again = false;
      ownRevs.clear();
      await pull();
      await push();
      // The rows this pass just put are the account's next revisions: when nothing else was written in between,
      // the cursor moves past them, so the next list doesn't send this device's own uploads back to it.
      while (ownRevs.has(local.since + 1)) local.since += 1;
      if (!again) break;
    }
    local.last = Date.now();
    lastError = '';
  } catch (e) {
    if (e.wiped) { wiped = true; local = blank(); lastError = ''; }
    else {
      lastError = e.message || String(e);
      // Too fast (a big first upload) or no network: keep what was done, try again soon rather than in 30 s of nothing.
      // A 429 holds every sync until its retry-after (saves, the interval, focus), not just this timer.
      if (e.status === 429 || e.status === 0 || e.status >= 500) {
        const wait = Math.max(10_000, (e.wait || 20) * 1000 + 2000);
        if (e.status === 429) backoffUntil = Date.now() + wait - 500; // (the timer below, a little after)
        clearTimeout(pushTimer); pushTimer = setTimeout(() => syncNow(), wait);
      }
    }
  } finally {
    running = false;
    save();
    notify();
  }
  if (wiped) await afterWipe();
  return info();
}

/**
 * Another device removed every server copy (Settings › Sync › end-to-end, sync.js). This device
 * stops at once (so it doesn't upload its chats again), then asks which mode the account is in now:
 * end-to-end set up → stays off (account.js hands over to sync.js); not → starts over from nothing.
 * Can't tell (offline) → asks again in a minute, still off.
 */
async function afterWipe() {
  const id = account;
  enabled = false;
  stop();
  notify();
  const st = await refreshStatus().catch(() => null);
  if (account !== id || enabled) return; // account.js already turned it back on (or another account)
  if (!st) { setTimeout(() => { if (account === id && !enabled) afterWipe(); }, 60_000); return; }
  if (st.key) return; // end-to-end now
  initCloud(id);
}

const later = () => { clearTimeout(pushTimer); pushTimer = setTimeout(() => syncNow(), Math.max(PUSH_DELAY, backoffUntil - Date.now())); };
function onSaved(e) { if (!enabled) return; dirty.add(e.detail.id); later(); }
function onDeleted(e) { if (!enabled) return; (local.deleted ||= []).push(e.detail.id); dirty.delete(e.detail.id); save(); later(); }
function onOpened(e) {
  const c = e.detail && e.detail.conv;
  if (enabled && c && c.remote) { c.loading = true; hydrate(c.id); }
}
const onVisible = () => { if (document.visibilityState === 'visible') syncNow(); };
const onUse = () => { lastUse = Date.now(); };
function onTick() {
  if (document.visibilityState !== 'visible' || Date.now() < backoffUntil) return;
  if (Date.now() - lastUse > IDLE_AFTER && Date.now() - lastLook < IDLE_EVERY) return; // idle: every 2 minutes
  syncNow();
}

function start() {
  if (timer) return;
  addEventListener('eden:conv-saved', onSaved);
  addEventListener('eden:conv-deleted', onDeleted);
  addEventListener('eden:conv-opened', onOpened);
  addEventListener('focus', onVisible);
  document.addEventListener('visibilitychange', onVisible);
  for (const t of USE) addEventListener(t, onUse, { capture: true, passive: true });
  timer = setInterval(onTick, EVERY);
}
function stop() {
  clearInterval(timer);
  timer = null;
  clearTimeout(pushTimer);
  removeEventListener('eden:conv-saved', onSaved);
  removeEventListener('eden:conv-deleted', onDeleted);
  removeEventListener('eden:conv-opened', onOpened);
  removeEventListener('focus', onVisible);
  document.removeEventListener('visibilitychange', onVisible);
  for (const t of USE) removeEventListener(t, onUse, { capture: true });
}

/** At page load once the account is known. `e2e`: end-to-end mode is set up for the account (sync.js), so this stays off. */
/** Why sync couldn't even start (account.js: askeden.com's sync settings wouldn't answer): shown in Settings › Sync. */
export function setStartError(message) { if (!enabled) { lastError = message || ''; notify(); } }

export function initCloud(accountId, { e2e = false } = {}) {
  if (!accountId || isMock) return info();
  account = accountId;
  stop();
  enabled = !e2e;
  lastError = '';
  if (!enabled) { notify(); return info(); }
  local = store.get(stateKey(), null) || blank();
  local.revs ||= {}; local.seen ||= {}; local.deleted ||= [];
  if (local.v !== VERSION) { local.v = VERSION; local.since = 0; } // list everything once more (what it knows is kept)
  start();
  syncNow();
  return info();
}

/** Removes every server copy (end-to-end mode takes over) and forgets what was synced. */
export async function wipeCloud() {
  if (!account) return;
  await api('/api/web/csync/wipe', {});
  if (local) { local = blank(); save(); }
}

export function turnOff() { enabled = false; stop(); notify(); }

/** "Delete all chats": every one here, and so (tombstones) on the server and every device. */
export async function deleteAllChats(deleteConversation) {
  for (const c of [...state.convs]) deleteConversation(c);
  state.current = null;
  ui.renderSidebar();
  ui.render();
  if (enabled) { clearTimeout(pushTimer); await syncNow(); }
}
