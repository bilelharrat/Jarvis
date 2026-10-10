// Chat history that follows the account, with nothing to set up (ROADMAP H1 follow-up;
// docs/accounts.md "Chat sync"). Every signed-in account at askeden.com: conversations are sent to
// the account and kept there sealed at rest by askeden.com (chat-sync.js on the server), so a
// new browser, the Mac app or the iPhone app shows the same list after signing in. People who
// want a key only their devices hold use End-to-end encryption (sync.js) instead; while that is
// set up, this stays off.
//
// The list comes first (the sidebar fills in at once, each chat a stub), then the newest chats are
// fetched in the background and the rest when opened (`eden:conv-opened`). Pull, then push, every
// ~30 s while the tab is visible and when it gets focus. Two devices' branches are united by
// message id (sync-model.js merge); a delete is a tombstone; temporary chats never leave the
// browser; images stay local (a placeholder travels; a conversation over ~1.4 MB isn't synced).

import { state, ui, persistConversation } from './state.js';
import { store } from './util.js';
import { apiUrl, isMock } from './api.js';
import { applyConv, removeConv } from './sync.js';
import { merge, payload, syncable, stub, planList, onConflict, differs, MAX_ACCOUNT_JSON } from './sync-model.js';

const PUSH_DELAY = 2500;
const EVERY = 30_000;
const EAGER = 40; // chats fetched right after the list; the rest when opened
const PARALLEL = 3;

let account = null;
let local = null; // { since, revs: {id: rev}, seen: {id: updated}, deleted: [ids], last }
let enabled = false;
let running = false;
let again = false;
let timer = null;
let pushTimer = null;
let lastError = '';
let tooBig = 0;
const dirty = new Set();
const fetching = new Set();
const listeners = new Set();

const stateKey = () => `jchat:csync:${account}`;
const save = () => store.set(stateKey(), local);
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

async function hydrate(id) {
  if (fetching.has(id) || !enabled) return;
  fetching.add(id);
  try {
    const got = await api('/api/web/csync/get', { id });
    if (got.deleted) { if (removeConv(id)) ui.renderSidebar(); delete local.revs[id]; return; }
    if (state.streams.has(id)) return;
    const mine = state.convs.find((x) => x.id === id);
    const remote = got.conv;
    if (!remote || remote.id !== id) return;
    const merged = mine && !mine.remote ? merge(payload(mine, Infinity).conv, remote) : remote;
    const wasCurrent = mine && state.current === mine;
    applyConv(merged);
    local.revs[id] = got.rev;
    if (mine && !mine.remote && differs(remote, merged)) dirty.add(id);
    else local.seen[id] = merged.updated;
    ui.renderSidebar();
    if (wasCurrent) { const c = state.convs.find((x) => x.id === id); if (c) c.loading = false; ui.render(); }
  } catch (e) {
    if (e.status !== 404) lastError = e.message;
  } finally { fetching.delete(id); }
}

async function hydrateMany(ids) {
  const queue = [...ids];
  const worker = async () => { while (queue.length && enabled) await hydrate(queue.shift()); };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
}

async function pull() {
  const fresh = [];
  for (let page = 0; page < 200; page++) {
    const got = await api('/api/web/csync/list', { since: local.since });
    if (got.rev < local.since) { local.since = 0; local.revs = {}; local.seen = {}; continue; } // wiped on the server: start over
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
    if (!got.more) break;
  }
  // Newest first: what changed, then stubs from earlier launches; the rest wait until opened.
  const waiting = state.convs.filter((c) => c.remote && !fresh.includes(c.id)).sort((a, b) => (b.updated || 0) - (a.updated || 0)).map((c) => c.id);
  await hydrateMany([...fresh, ...waiting].slice(0, EAGER));
}

async function pushOne(c) {
  const id = c.id;
  const p = payload(c, MAX_ACCOUNT_JSON);
  if (!p) { tooBig += 1; local.seen[id] = c.updated; dirty.delete(id); return; }
  const updated = c.updated;
  const res = await api('/api/web/csync/put', { id, conv: p.conv, base_rev: local.revs[id] || 0 });
  if (res.rev) { local.revs[id] = res.rev; local.seen[id] = updated; dirty.delete(id); return; }
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
  if (res.code === 'too_big' || res.code === 'too_many') { tooBig += 1; lastError = res.error || ''; local.seen[id] = c.updated; dirty.delete(id); }
}

async function push() {
  const gone = local.deleted || [];
  local.deleted = [];
  for (const id of gone) {
    try { await api('/api/web/csync/delete', { id }); delete local.revs[id]; delete local.seen[id]; }
    catch (e) { (local.deleted ||= []).push(id); throw e; }
  }
  tooBig = 0;
  const work = state.convs.filter((c) => syncable(c, state.streams.has(c.id)) && (dirty.has(c.id) || local.seen[c.id] !== c.updated || !local.revs[c.id]));
  for (let i = 0; i < work.length; i += PARALLEL) {
    const done = await Promise.allSettled(work.slice(i, i + PARALLEL).map(pushOne));
    const bad = done.find((d) => d.status === 'rejected');
    if (bad) throw bad.reason;
  }
}

/** One pass now: pull, then push; more when a conflict asked for it. */
export async function syncNow() {
  if (!enabled || !local) return info();
  if (running) { again = true; return info(); }
  running = true;
  notify();
  try {
    for (let pass = 0; pass < 3; pass++) {
      again = false;
      await pull();
      await push();
      if (!again) break;
    }
    local.last = Date.now();
    lastError = '';
  } catch (e) {
    lastError = e.message || String(e);
    // Too fast (a big first upload) or no network: keep what was done, try again soon rather than in 30 s of nothing.
    if (e.status === 429 || e.status === 0 || e.status >= 500) { clearTimeout(pushTimer); pushTimer = setTimeout(() => syncNow(), Math.max(10_000, (e.wait || 20) * 1000 + 2000)); }
  } finally {
    running = false;
    save();
    notify();
  }
  return info();
}

const later = () => { clearTimeout(pushTimer); pushTimer = setTimeout(() => syncNow(), PUSH_DELAY); };
function onSaved(e) { if (!enabled) return; dirty.add(e.detail.id); later(); }
function onDeleted(e) { if (!enabled) return; (local.deleted ||= []).push(e.detail.id); dirty.delete(e.detail.id); save(); later(); }
function onOpened(e) {
  const c = e.detail && e.detail.conv;
  if (enabled && c && c.remote) { c.loading = true; hydrate(c.id); }
}
const onVisible = () => { if (document.visibilityState === 'visible') syncNow(); };

function start() {
  if (timer) return;
  addEventListener('eden:conv-saved', onSaved);
  addEventListener('eden:conv-deleted', onDeleted);
  addEventListener('eden:conv-opened', onOpened);
  addEventListener('focus', onVisible);
  document.addEventListener('visibilitychange', onVisible);
  timer = setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, EVERY);
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
  local = store.get(stateKey(), null) || { since: 0, revs: {}, seen: {}, deleted: [], last: 0 };
  local.revs ||= {}; local.seen ||= {}; local.deleted ||= [];
  start();
  syncNow();
  return info();
}

/** Removes every server copy (end-to-end mode takes over) and forgets what was synced. */
export async function wipeCloud() {
  if (!account) return;
  await api('/api/web/csync/wipe', {});
  if (local) { local.since = 0; local.revs = {}; local.seen = {}; local.deleted = []; save(); }
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
