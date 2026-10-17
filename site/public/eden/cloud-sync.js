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

import { state, ui, persistConversation, rewriteConversation, takeDeletes, heldElsewhere, otherAccount, accountSwitched } from './state.js';
import { store, whileVisible, toast } from './util.js';
import { apiUrl, isMock } from './api.js';
import { applyConv, removeConv, refreshStatus } from './sync.js';
import { loadFailed } from './convstore.js';
import { merge, payload, wire, syncable, stub, planList, onConflict, differs, stampOf, takeIn, MAX_ACCOUNT_JSON } from './sync-model.js';

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
let unsaved = false; // a copy this pass wrote didn't reach this device's storage: the next list starts from the beginning
let leaving = false; // the page was just hidden: the pass sends what changed here, its requests kept alive past a suspension
let saidSignedOut = false;
// Account sync is off here because end-to-end sync took over (initCloud, wipeCloud): chats this device holds only
// as stubs are still downloaded, nothing is sent (fetchStubs).
let fetchOnly = false;
const dirty = new Set();
const lost = new Set(); // stubs askeden.com has no chat for, still open here: they go once left
const ownRevs = new Set(); // revisions this pass's puts made (each put is the account's next revision)
const fetching = new Set();
const listeners = new Set();

const stateKey = () => `jchat:csync:${account}`;
// Deletes askeden.com answered for, from this tab: never queued again from what another tab saved before it knew (AS2-2).
const sent = new Set();
// Chats askeden.com said are deleted, whose revision this tab forgot: one still here (open, or a reply streaming) goes
// once it's left, by the put that finds the tombstone. The saved state's revision for it is from before the delete, so
// it isn't taken back in (adopt): it stopped that put, and the chat stayed (found porting AS2-2 to ios-app-store-prep).
const gone = new Set();
/**
 * Every tab of this browser keeps its sync state under one key (bug sweep AS2-2: a tab's save wrote over a delete
 * another tab had queued and not sent yet, so it was never sent). Before a pass and before each save, what another
 * tab saved is taken in: its unsent deletes, and its revisions for chats this tab holds as that tab sent them.
 */
function adopt() {
  if (!local) return;
  const have = new Map(state.convs.map((c) => [c.id, c]));
  const stored = store.get(stateKey(), null);
  const took = takeIn(local, stored, { sent, stampHere: (id) => { const c = have.get(id); return !c || gone.has(id) ? undefined : c.remote ? null : stampOf(c); } });
  for (const id of took) dirty.delete(id);
  // deletes made while no sync was running, or in a page where it hadn't started yet (state.js). Written at once: taken
  // off state.js's list, they were only in memory until the pass ended, and a page closed meanwhile brought the chat back.
  const waiting = enabled ? takeDeletes(account) : [];
  if (waiting.length) { local.deleted = [...new Set([...(local.deleted || []), ...waiting])]; store.set(stateKey(), local); }
}
const save = () => { if (!local) return; adopt(); store.set(stateKey(), local); };
const notify = () => { for (const fn of listeners) { try { fn(info()); } catch { /* a listener's problem */ } } };
export const onCloudChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

async function api(path, body = {}) {
  // (X-Eden-Account: the account this page syncs for; askeden.com refuses it once this browser signed in to another one)
  const init = { cache: 'no-store', method: 'POST', headers: { 'X-Jarvis-Chat': '1', 'content-type': 'application/json', ...(account ? { 'X-Eden-Account': account } : {}) }, body: JSON.stringify(body) };
  // (keepalive: the browser finishes it even if the page is suspended or closed; it allows 64 KB of body at most)
  if (leaving && init.body.length < 60_000) init.keepalive = true;
  let res;
  try { res = await fetch(apiUrl(path), init); }
  catch { throw Object.assign(new Error('Can’t reach askeden.com. Check your connection.'), { status: 0 }); }
  let out = {};
  try { out = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    if (res.status === 409 && out.code === 'other_account') otherAccount(); // (this page's sync stops: onOtherAccount)
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

const isPrivate = (c) => Boolean(c && c.privacy === true); // privacy.js: stays on this device (sync-model.js syncable)

/** One chat's body from askeden.com (csync/get, or one of csync/getmany's) into this device. → whether the sidebar changed. */
function applyGot(id, got) {
  if (heldElsewhere(id)) return false; // (another account's chat by that id is stored here: state.js)
  const mine = state.convs.find((x) => x.id === id);
  if (got.deleted) { delete local.revs[id]; gone.add(id); return isPrivate(mine) ? false : removeConv(id); }
  if (state.streams.has(id) || isPrivate(mine)) return false;
  const remote = got.conv;
  if (!remote || remote.id !== id) return false;
  // Anything this device holds is merged in, a stub's too: a message typed into a chat still downloading was
  // replaced by the server's copy and lost (the copy here is never thrown away for the one from askeden.com),
  // and so was a rename, pin or folder move made on it (its newer `metaAt`).
  const nodes = Boolean(mine && Object.keys(mine.nodes || {}).length);
  const renamed = Boolean(mine && !nodes && (mine.metaAt || 0) > (remote.metaAt || 0));
  const held = nodes || renamed;
  const merged = nodes ? merge(payload(mine, Infinity).conv, remote) : renamed ? merge(remote, payload(mine, Infinity).conv) : remote;
  const wasCurrent = mine && state.current === mine;
  merged.syncRev = got.rev; // (stored with it: baseOf)
  applyConv(merged);
  local.revs[id] = got.rev;
  if (held && differs(remote, merged)) dirty.add(id);
  else local.seen[id] = stampOf(merged);
  if (wasCurrent) ui.render();
  return true;
}

function failed(e) {
  if (e.status !== 404) lastError = e.message;
  if (e.status === 429) backoffUntil = Math.max(backoffUntil, Date.now() + Math.max(10, e.wait || 20) * 1000);
  // Signed out (another browser signed this one out, or its sign-in ran out): said once where it's seen, not only in Settings › Sync.
  if (e.status === 401 && !saidSignedOut) { saidSignedOut = true; try { toast('This browser is signed out of Eden. Reload the page to sign in.'); } catch { /* no page (tests) */ } }
}

/** A chat listed but not downloaded yet, as the page draws it (app.js): loading, or why it couldn't load. */
function stubShows(id, { loading = false, error = '' } = {}) {
  const c = state.convs.find((x) => x.id === id);
  if (!c || !c.remote) return;
  if (Boolean(c.loading) === loading && (c.loadError || '') === error) return;
  c.loading = loading;
  if (error) c.loadError = error; else delete c.loadError;
  if (state.current === c) ui.render();
}

/**
 * askeden.com has no chat by that id (deleted and cleaned up, or a stub left from another account): the stub goes
 * (once it's left, if it's open); one that holds messages typed here stays as this device's chat, and goes up.
 */
function missing(id) {
  const c = state.convs.find((x) => x.id === id);
  if (!c || !c.remote) return false;
  if (Object.keys(c.nodes || {}).length) {
    delete c.remote; delete c.loading; delete c.loadError;
    persistConversation(c);
    dirty.add(id);
    return true;
  }
  if (removeConv(id)) return true;
  lost.add(id);
  stubShows(id, { error: 'This chat isn’t in your account any more.' });
  return false;
}

async function hydrate(id) {
  if (fetching.has(id) || !(enabled || fetchOnly)) return;
  if (Date.now() < backoffUntil) { stubShows(id, { error: lastError || 'askeden.com asked this device to slow down; syncing goes on in a minute.' }); return; }
  fetching.add(id);
  stubShows(id, { loading: true });
  try {
    if (applyGot(id, await api('/api/web/csync/get', { id }))) ui.renderSidebar();
  } catch (e) {
    failed(e);
    if (e.status === 404) { if (missing(id)) ui.renderSidebar(); } else stubShows(id, { error: e.message || 'It didn’t load.' });
  } finally { fetching.delete(id); stubShows(id, { error: (state.convs.find((x) => x.id === id) || {}).loadError || '' }); }
}

/**
 * Many chats' bodies: GET_MANY a request (csync/getmany; askeden.com answers as many as fit, at least one, and the
 * rest go in the next request). An older askeden.com (404): one chat a request, PARALLEL at a time, as before.
 */
async function hydrateMany(ids) {
  const queue = ids.filter((id) => !fetching.has(id));
  while (getMany && queue.length > 1 && (enabled || fetchOnly) && Date.now() >= backoffUntil) {
    const part = queue.slice(0, GET_MANY);
    for (const id of part) fetching.add(id);
    let got;
    try { got = await api('/api/web/csync/getmany', { ids: part }); }
    catch (e) {
      // (an older askeden.com answers an op it doesn't have with 404 'not_found'; a 404 with another code is the server's own answer)
      if (e.status === 404 && (!e.code || e.code === 'not_found')) { getMany = false; break; }
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
      if (it.missing) { if (missing(it.id)) changed = true; }
      else if (it.error) stubShows(it.id, { error: 'That chat couldn’t be opened.' });
      else if (applyGot(it.id, it)) changed = true;
    }
    if (changed) ui.renderSidebar();
    if (!answered.size) break;
    for (let i = queue.length - 1; i >= 0; i--) if (answered.has(queue[i])) queue.splice(i, 1);
  }
  const worker = async () => { while (queue.length && (enabled || fetchOnly) && Date.now() >= backoffUntil) await hydrate(queue.shift()); };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
}

/** Stubs askeden.com has no chat for that were open: gone now, unless one still is (pull, and onOpened while sync is off). */
function dropLost() {
  for (const id of lost) {
    const c = state.convs.find((x) => x.id === id);
    if (!c || !c.remote) lost.delete(id);
    else if (removeConv(id)) { lost.delete(id); ui.renderSidebar(); }
  }
}

/**
 * End-to-end sync took over (it brings only what was sent through it): every chat this device holds only as a stub
 * is downloaded from askeden.com once, then goes up through end-to-end sync like any chat here. One askeden.com no
 * longer has (its copies went when end-to-end was set up) goes, the open one once it's left (missing). Before,
 * each said "Loading this chat…" for ever, and refused every message sent into it.
 */
async function fetchStubs() {
  const ids = state.convs.filter((c) => c.remote).map((c) => c.id);
  if (!ids.length || loadFailed()) return;
  fetchOnly = true;
  local ||= blank(); // (in memory: what applyGot notes is never saved, nothing is sent)
  await hydrateMany(ids);
}

async function pull() {
  const fresh = [];
  let listed = null; // a full list again (old tombstones were cleaned up): the ids it holds
  let whole = false; // the list reached its end (not cut off by the page limit)
  dropLost();
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
    // Left alone: a chat being replied to, a private one (it stays as it is here), one deleted here whose delete
    // isn't sent yet (it came back as a new chat when sync started after the delete), and one whose id another
    // account's chat holds in this browser (stored over it, that one was lost: state.js heldElsewhere).
    const queued = new Set(local.deleted || []);
    const busy = new Set([...state.streams.keys(), ...state.convs.filter(isPrivate).map((c) => c.id)]);
    const plan = planList(got.items.filter((it) => !queued.has(it.id) && !heldElsewhere(it.id)), local.revs, have, busy);
    let changed = false;
    for (const id of plan.remove) { if (removeConv(id)) changed = true; delete local.revs[id]; delete local.seen[id]; gone.add(id); }
    for (const it of got.items) if (it.deleted) { delete local.revs[it.id]; gone.add(it.id); }
    for (const meta of plan.stubs) {
      const s = stub(meta);
      const at = state.convs.findIndex((x) => (x.updated || 0) < (s.updated || 0));
      if (at < 0) state.convs.push(s); else state.convs.splice(at, 0, s);
      persistConversation(s);
      changed = true;
    }
    // A stub whose chat was renamed, pinned, moved or continued elsewhere: its entry now, in its new place.
    for (const meta of plan.restub) {
      const s = have.get(meta.id);
      if (!s || !s.remote || Object.keys(s.nodes || {}).length || (s.metaAt || 0) > (meta.metaAt || 0)) continue; // (renamed here: kept, it goes up once downloaded)
      const next = stub(meta);
      for (const k of ['title', 'titleSet', 'created', 'updated', 'pinned', 'folder', 'metaAt', 'personaId']) { if (next[k] === undefined) delete s[k]; else s[k] = next[k]; }
      state.convs = state.convs.filter((x) => x !== s);
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
      if (isPrivate(c)) { delete local.revs[id]; delete local.seen[id]; continue; } // (it stays here, as a tombstone leaves it)
      if (c && !c.remote && (dirty.has(id) || (local.seen[id] !== undefined && local.seen[id] !== stampOf(c)))) { delete local.revs[id]; dirty.add(id); continue; }
      if (removeConv(id)) changed = true;
      delete local.revs[id]; delete local.seen[id]; gone.add(id);
    }
    if (changed) ui.renderSidebar();
  }
  // The chat open now first, then newest first: what changed, then stubs from earlier launches (and ones left from a
  // page where sync couldn't start); the rest wait until opened.
  const waiting = state.convs.filter((c) => c.remote && !fresh.includes(c.id) && !lost.has(c.id)).sort((a, b) => (b.updated || 0) - (a.updated || 0)).map((c) => c.id);
  const open = state.current && state.current.remote ? [state.current.id] : [];
  await hydrateMany([...new Set([...open, ...fresh, ...waiting])].slice(0, EAGER));
}

/**
 * The revision a put is based on: the one the copy stored here was synced at (`syncRev`, written with it), never past
 * what this page knows (`revs`). With `revs` alone, a chat whose newest write never reached this device's storage
 * was put back over askeden.com's newer copy after a reload; now that put conflicts and the two merge.
 */
function baseOf(c) {
  const known = local.revs[c.id] || 0;
  return Number.isInteger(c.syncRev) ? Math.min(c.syncRev, known) : known;
}
/** Uploaded at `rev`: noted in the chat's own record too (baseOf). */
function syncedAt(c, rev) {
  c.syncRev = rev;
  rewriteConversation(c);
}

async function pushOne(c) {
  const id = c.id;
  const p = payload(c, MAX_ACCOUNT_JSON);
  if (!p) { tooBig += 1; local.seen[id] = stampOf(c); dirty.delete(id); return; }
  const stamp = stampOf(c);
  const res = await api('/api/web/csync/put', { id, conv: p.conv, base_rev: baseOf(c) });
  afterPut(c, p, stamp, res);
}

/** What askeden.com said to one chat's put (alone, or in a batch). */
function afterPut(c, p, stamp, res) {
  const id = c.id;
  if (res.rev) { local.revs[id] = res.rev; local.seen[id] = stamp; dirty.delete(id); ownRevs.add(res.rev); gone.delete(id); syncedAt(c, res.rev); return; }
  if (res.conflict) {
    const act = onConflict(c, res.conflict);
    if (act.action === 'drop') { if (removeConv(id)) ui.renderSidebar(); delete local.revs[id]; gone.add(id); return; }
    if (act.action === 'resurrect') { local.revs[id] = act.rev; c.syncRev = act.rev; dirty.add(id); again = true; return; }
    // A reply streaming into it now (it started while the put was out): merged once the reply is saved, on the
    // revision it had. Merging now put copies in place of the chat's nodes, so the reply went on into a node no
    // longer in it, and was saved cut off ('aborted').
    if (res.conflict.conv && state.streams.has(id)) { dirty.add(id); return; }
    if (res.conflict.conv) {
      // (from the whole chat, not the copy slimmed to fit: that one has no text attachments' contents)
      const merged = merge(wire(c), res.conflict.conv);
      merged.syncRev = act.rev;
      applyConv(merged);
      ui.renderSidebar();
      if (state.current && state.current.id === id) ui.render();
    } else c.syncRev = act.rev;
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
    const res = await batch({ puts: group.map(({ c, p }) => ({ id: c.id, conv: p.conv, base_rev: baseOf(c) })) });
    if (!res) return [...group.map((g) => g.c), ...work.slice(i)];
    const byId = new Map((res.puts || []).map((r) => [r && r.id, r]));
    for (const { c, p, stamp } of group) afterPut(c, p, stamp, byId.get(c.id) || {});
  }
  return work.slice(i);
}

// A private chat (privacy.js: "stays on this iPhone", "stays on your Mac") never goes up (syncable), nor do its
// changes here. One that went up before it was made private keeps that copy on askeden.com: deleting it took it off
// the other devices too, with the turns they had added to it (whether it should go from askeden.com is still to be decided).
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
export async function syncNow({ pushOnly = false } = {}) {
  if (!enabled || !local) return info();
  if (Date.now() < backoffUntil) return info();
  if (running) { again = true; return info(); }
  running = true;
  lastLook = Date.now();
  const L = locks();
  if (!L) return onePass(pushOnly);
  let ran = false;
  try {
    await L.request(`eden-csync:${account}`, { ifAvailable: true }, async (lock) => { if (!lock) return; ran = true; await onePass(pushOnly); });
  } catch { if (!ran) return onePass(pushOnly); } // (no locks here after all)
  if (!ran) { running = false; later(); }
  return info();
}

/**
 * `pushOnly`: the page was just hidden (an iPhone going to the background is suspended a few seconds later): only
 * what changed here is sent, at once and kept alive, not after a full list and downloads. The rest comes next time.
 */
async function onePass(pushOnly = false) {
  running = true;
  leaving = pushOnly;
  let wiped = false;
  notify();
  try {
    adopt();
    if (pushOnly) {
      again = false;
      ownRevs.clear();
      await push();
      if (again) later(); // (a conflict: merged, and sent again on the next whole pass)
    } else {
      // The chat open now first, when it's a stub (restored at load, or opened before sync had started).
      if (state.current && state.current.remote) await hydrate(state.current.id);
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
    }
    local.last = Date.now();
    lastError = '';
  } catch (e) {
    // (askeden.com refusing uploads because the account syncs end to end now: the same as noticing its wipe)
    if (e.wiped || (e.status === 409 && e.code === 'end_to_end')) { wiped = true; local = blank(); gone.clear(); lastError = ''; }
    else {
      if (e.status === 401) failed(e);
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
    leaving = false;
    // A copy written this pass didn't reach this device's storage (state.js: eden:conv-unsaved): the cursor
    // doesn't count it as held here, so the next list starts over and brings it again (it was never listed again).
    if (unsaved && local) { local.since = 0; unsaved = false; }
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
  if (st.key) { fetchStubs(); return; } // end-to-end now (its stubs: askeden.com says what's left of them)
  initCloud(id);
}

const later = () => { clearTimeout(pushTimer); pushTimer = setTimeout(() => syncNow(), Math.max(PUSH_DELAY, backoffUntil - Date.now())); };
function onSaved(e) { if (!enabled) return; dirty.add(e.detail.id); later(); }
// (state.js also keeps every delete until an engine takes it: adopt, in save, takes that copy off its list now)
function onDeleted(e) { if (!enabled || !local) return; (local.deleted ||= []).push(e.detail.id); dirty.delete(e.detail.id); save(); later(); }
/** A stub opened (app.js switchTo, a Retry, a send into it): fetched now; before sync has started, asked to start. */
function onOpened(e) {
  if (!enabled) dropLost(); // (a pass does it while sync runs)
  const c = e.detail && e.detail.conv;
  if (!c || !c.remote) return;
  if (enabled || fetchOnly) { hydrate(c.id); return; }
  // (it's fetched first once sync starts: onePass) — and account.js tries to start it now, if it's waiting to retry.
  // Meanwhile it says why sync hasn't started (setStartError), not "Loading this chat…" for ever.
  if (lastError) stubShows(c.id, { error: lastError });
  dispatchEvent(new CustomEvent('eden:sync-retry'));
}
/** A copy that didn't reach this device's storage (state.js): the list starts over, so a chat missing here comes back. */
function onUnsaved() {
  if (!local) return;
  if (running) { unsaved = true; return; }
  local.since = 0;
  save();
}
/** This browser signed in to another account since the page started (state.js otherAccount): off until a reload. */
function onOtherAccount() {
  enabled = false;
  fetchOnly = false;
  stop();
  lastError = 'This browser is now signed in to another Eden account. Reload the page.';
  notify();
}
if (typeof addEventListener === 'function') { addEventListener('eden:conv-opened', onOpened); addEventListener('eden:conv-unsaved', onUnsaved); addEventListener('eden:other-account', onOtherAccount); }
// Visible again: a whole pass. Hidden: what changed here goes up now (state.js has just written the saves still
// waiting), before an iPhone suspends the page: the last turn waited for the next launch (finding 26).
const onVisible = () => {
  if (document.visibilityState === 'visible') syncNow();
  else if (document.visibilityState === 'hidden' && (dirty.size || (local && (local.deleted || []).length))) { clearTimeout(pushTimer); syncNow({ pushOnly: true }); }
};
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
  addEventListener('focus', onVisible);
  document.addEventListener('visibilitychange', onVisible);
  for (const t of USE) addEventListener(t, onUse, { capture: true, passive: true });
  timer = whileVisible(onTick, EVERY); // (no timer while hidden: onVisible syncs on coming back)
}
function stop() {
  if (timer) timer();
  timer = null;
  clearTimeout(pushTimer);
  removeEventListener('eden:conv-saved', onSaved);
  removeEventListener('eden:conv-deleted', onDeleted);
  removeEventListener('focus', onVisible);
  document.removeEventListener('visibilitychange', onVisible);
  for (const t of USE) removeEventListener(t, onUse, { capture: true });
}

/**
 * Why sync couldn't even start (account.js: askeden.com didn't answer, it asks again): shown in Settings › Sync, and
 * on a stub that's open (it can't download until sync runs).
 */
export function setStartError(message) {
  if (enabled) return;
  lastError = message || '';
  if (state.current && state.current.remote) stubShows(state.current.id, { error: lastError });
  notify();
}

/**
 * What this device's storage holds against what the saved sync state says (finding: a lost IndexedDB write). A chat
 * noted as synced but stored older than that copy is merged with askeden.com's again (no base revision: its put
 * conflicts and merges) instead of replacing the newer one there; one noted as synced but not stored at all is
 * listed again from the start (its cursor had moved past it, so it was never downloaded again).
 */
function reconcile() {
  if (loadFailed()) return; // (nothing could be read: that isn't the chats being gone)
  const have = new Map(state.convs.map((c) => [c.id, c]));
  const queued = new Set(local.deleted || []);
  for (const id of Object.keys(local.revs)) {
    const c = have.get(id);
    if (!c) {
      if (queued.has(id)) continue;
      delete local.revs[id]; delete local.seen[id];
      local.since = 0;
    } else if (!c.remote && local.seen[id] !== undefined && stampOf(c) < local.seen[id]) {
      delete local.revs[id]; delete local.seen[id];
    }
  }
}

/** At page load once the account is known. `e2e`: end-to-end mode is set up for the account (sync.js), so this stays off. */
export function initCloud(accountId, { e2e = false } = {}) {
  if (!accountId || isMock || accountSwitched()) return info();
  account = accountId;
  stop();
  // This device's saved chats couldn't be read (convstore.js): the list would make a stub of every chat changed
  // elsewhere and write it over the full copy stored here (its turns not synced yet, its pictures). It waits for a reload.
  if (loadFailed()) { enabled = false; lastError = 'This browser’s saved chats couldn’t be read, so syncing waits. Reload the page.'; notify(); return info(); }
  enabled = !e2e;
  fetchOnly = false;
  lastError = '';
  if (!enabled) { notify(); fetchStubs(); return info(); }
  local = store.get(stateKey(), null) || blank();
  local.revs ||= {}; local.seen ||= {}; local.deleted ||= [];
  if (local.v !== VERSION) { local.v = VERSION; local.since = 0; } // list everything once more (what it knows is kept)
  reconcile();
  start();
  syncNow();
  return info();
}

/** Removes every server copy (end-to-end mode takes over) and forgets what was synced. */
export async function wipeCloud() {
  if (!account) return;
  // Chats this device holds only as stubs are downloaded first (fetchStubs; account.js turns sync off meanwhile):
  // the wipe took the one full copy of every chat no device had opened, and end-to-end sync sends up what's here.
  await fetchStubs();
  await api('/api/web/csync/wipe', {});
  if (local) { local = blank(); gone.clear(); save(); }
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
