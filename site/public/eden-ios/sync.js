// Chat history on every device, end-to-end encrypted (ROADMAP H1; JARVIS V1/docs/accounts.md
// "Eden sync"). Only at askeden.com (a signed-in browser); the local server has no accounts.
//
// This browser has its own key pair (eden-crypto.js; the private half non-extractable, kept in
// IndexedDB, per account). The account's Eden key reaches it sealed to that key, either from a
// browser that already syncs ("Trust this browser": both screens show the same six digits), or
// unwrapped with the recovery passphrase; the first browser makes the key. askeden.com stores
// conversations only as AES-256-GCM items it can't open (POST /api/web/esync/*).
//
// The engine: pull what changed since the last revision and merge it into the conversations
// in localStorage (message trees are unions by message id, so two devices' turns both stay;
// the newer side wins the title and pins); push what changed here (state.js says so with
// `eden:conv-saved` / `eden:conv-deleted`), each with the revision it was based on. A conflict
// hands back the other copy, which is merged and pushed again. A deleted conversation is a
// tombstone everywhere. Image data never leaves the browser (state.js never stores it), and a
// conversation over ~450 KB drops its text attachments' contents, or isn't synced.
//
// Removing a device changes the key (removeDevice; docs "Removing a device"): this browser makes
// a new one (the next epoch), seals it to every other member whose public key a holder of the
// key vouched for (memberMac; the others must be approved again), keeps the old key under the
// new one on askeden.com (the chain) and proves the new key, all in one step there. A member
// picks the new key up when it next asks (refreshStatus: only if the chain from it leads back to
// the key it has, so askeden.com can't slip in a key of its own). Old keys stay in this browser
// to read what they sealed; such items are sealed again under the new key a few at a time.

import { state, ui, persistConversation, takeDeletes, forgetOwner, heldElsewhere, otherAccount, accountSwitched } from './state.js';
import * as Convs from './convstore.js';
import { store, whileVisible } from './util.js';
import { askedenJSON } from './api.js';
import * as E from './eden-crypto.js';
import { merge, wire, payload as payloadOf, stampOf, takeIn, cleanTitle } from './sync-model.js';

const PUSH_DELAY = 2500;
const EVERY = 60_000;
const BATCH = 25;
const MAX_JSON = 450_000; // (sync-model.js)
const POLL_MS = 3000;
const WATCH_MS = 4000; // the account page's Sync, while it's open and the tab is visible
const RESEAL = 20; // items sealed again under a new key, each pass

let account = null; // this browser's account id (GET /api/web/session)
let local = null; // { since, revs: {key: rev}, hashes: {key: digest}, deleted: [ids], last, tooBig, reseal: [keys] }
let status = null; // the server's GET /api/web/esync
// This browser's copy of the Eden key: { key: CryptoKey, envelope, gen, epoch, ring: [{ epoch, key }]
// (the keys before key changes, newest first), keys: [key, ...ring keys] (for workflows.js) }.
let sealed = null;
let running = false;
let again = false;
let timer = null;
let pushTimer = null;
let lastError = '';
const dirty = new Set();
const listeners = new Set();

/* ---------- askeden.com ---------- */

// (api.js: the same call spaces.js makes), saying which account this page syncs for: askeden.com refuses it once
// this browser signed in to another one (another tab), and this page's sync stops (state.js otherAccount).
async function api(path, body) {
  try { return await askedenJSON(path, body, account ? { 'X-Eden-Account': account } : {}); }
  catch (e) { if (e.status === 409 && e.code === 'other_account') otherAccount(); throw e; }
}

/* ---------- this browser's keys (IndexedDB) ---------- */

let dbp = null;
function db() {
  dbp ||= new Promise((resolve, reject) => {
    const r = indexedDB.open('eden-keys', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('keys');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}
async function idb(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('keys', mode);
    const req = fn(tx.objectStore('keys'));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  });
}
export const keyGet = (k) => idb('readonly', (s) => s.get(`${account}:${k}`));
export const keyPut = (k, v) => idb('readwrite', (s) => s.put(v, `${account}:${k}`));
export const keyDel = (k) => idb('readwrite', (s) => s.delete(`${account}:${k}`));

/** This browser's key pair for this account (made once): { alg, privateKey, public }. */
export async function deviceKey() {
  let d = await keyGet('device');
  if (!d) {
    const pair = await E.deviceKeyPair();
    d = { alg: pair.alg, privateKey: pair.privateKey, public: pair.public };
    await keyPut('device', d);
  }
  return d;
}

/** The six digits this browser shows while it waits to be trusted. */
export async function myCode() { return E.verifyCode((await deviceKey()).public); }

/** The raw Eden key again (to seal it to another device), from this browser's envelope. */
async function secretBytes(rec = sealed, label = E.SEAL_LABEL) {
  const d = await deviceKey();
  return E.openSealed(d.privateKey, rec.envelope.alg, rec.envelope.sealed_key, rec.envelope.sender_key, label);
}

/** Keeps `secret` here: as a non-extractable AES key, and sealed to this browser's own key. */
export async function keepSecret(name, secret, gen, label = E.SEAL_LABEL, envelope = null, extra = null) {
  const d = await deviceKey();
  const rec = { key: await E.itemKey(secret), envelope: envelope || (await E.sealTo(d.public, d.alg, secret, label)), gen, ...(extra || {}) };
  if (rec.ring) rec.keys = [rec.key, ...rec.ring.map((k) => k.key)];
  await keyPut(name, rec);
  return rec;
}
export { secretBytes as openEnvelope };

/* ---------- the key's epochs (a new key each time a device is removed) ---------- */

const epochOf = (x) => (x && Number.isInteger(x.epoch) && x.epoch > 0 ? x.epoch : 1);

/** The keys that may open an item, the one of its epoch first. */
function keysFor(epoch) {
  const ring = [{ epoch: epochOf(sealed), key: sealed.key }, ...(sealed.ring || [])];
  const first = ring.find((k) => k.epoch === epoch);
  return first ? [first.key, ...ring.filter((k) => k !== first).map((k) => k.key)] : ring.map((k) => k.key);
}
const openSynced = (item) => E.openItem(keysFor(epochOf(item)), item.key, item.data);
const ringComplete = () => epochOf(sealed) === 1 || (sealed.ring || []).some((k) => k.epoch === 1);

async function ringOf(older) {
  const ring = [];
  for (const s of older) ring.push({ epoch: s.epoch, key: await E.itemKey(s.secret) });
  return ring;
}

/** Proves this browser holds `secret` (the key of now) and vouches for its public key with it. */
async function proveHere(secret, via = 'approved') {
  const d = await deviceKey();
  return api('/api/web/esync/prove', { proof: await E.proofOf(secret), public_key: d.public, alg: d.alg, via, mac: await E.memberMac(secret, d.alg, d.public) });
}

/**
 * The key changed elsewhere and was sealed to this browser (`rekey`): taken only when the chain
 * from the new key leads back to the one this browser has, i.e. a holder of it made the new one.
 */
async function pickUp(rekey, chain) {
  const d = await deviceKey();
  const from = epochOf(sealed);
  let next;
  let between;
  try {
    next = await E.openSealed(d.privateKey, d.alg, rekey.sealed_key, rekey.sender_key);
    between = await E.followRekey(next, rekey.epoch, chain, sealed.gen, await secretBytes(), from);
  } catch (e) {
    throw Object.assign(new Error(e.message || 'The new key didn’t check out.'), { forged: true });
  }
  const ring = [...(await ringOf(between)), { epoch: from, key: sealed.key }, ...(sealed.ring || [])];
  await proveHere(next);
  sealed = await keepSecret('sync', next, sealed.gen, E.SEAL_LABEL, { sealed_key: rekey.sealed_key, sender_key: rekey.sender_key, alg: d.alg }, { epoch: rekey.epoch, ring });
  if (local) { local.since = 0; saveLocal(); } // read again what the old key couldn't open
}

/** A browser that joined after key changes: the older keys, from the chain, to read older items. */
async function fillRing(st) {
  const epoch = epochOf(sealed);
  if (epoch === 1 || ringComplete() || !(st.chain || []).length) return;
  const older = await E.chainBack(await secretBytes(), epoch, st.chain, sealed.gen, 0);
  if (older.length <= (sealed.ring || []).length) return;
  sealed = { ...sealed, ring: await ringOf(older) };
  sealed.keys = [sealed.key, ...sealed.ring.map((k) => k.key)];
  await keyPut('sync', sealed);
}

/* ---------- state ---------- */

const stateKey = () => `jchat:esync:${account}`;
// `gen`: which run of this state it is (a new key or a restarted server makes a new one); another tab's is taken in only from the same run.
const newGen = () => Math.random().toString(36).slice(2, 10);
const fresh = () => ({ gen: newGen(), since: 0, revs: {}, hashes: {}, deleted: [], last: 0, tooBig: 0 });
// Deletes askeden.com answered for, from this tab: never queued again from what another tab saved before it knew.
const sent = new Set();
/**
 * Every tab of this browser keeps its sync state under one key (bug sweep AS2-2, as cloud-sync.js): before a pass
 * and before each save, what another tab saved is taken in (its unsent deletes; its revisions for chats this tab
 * holds as that tab sent them), so a delete queued in a tab closed early is still sent, and an edit goes up once.
 */
function takeShared() {
  if (!local) return;
  const have = new Map(state.convs.map((c) => [c.id, c]));
  const took = takeIn(local, store.get(stateKey(), null), { sent, keyOf: itemName, stampHere: (id) => { const c = have.get(id); return !c ? undefined : c.remote ? null : stampOf(c); } });
  for (const id of took) dirty.delete(id);
  // deletes made while no sync was running, or before it had started on this page (state.js); written at once, as
  // cloud-sync.js adopt does (only in memory, they were lost with a page closed before the pass ended)
  const waiting = sealed ? takeDeletes(account) : [];
  if (waiting.length) { local.deleted = [...new Set([...(local.deleted || []), ...waiting])]; store.set(stateKey(), local); }
}
const saveLocal = () => { if (!local) return; takeShared(); store.set(stateKey(), local); };
const itemName = (id) => `eden/conv.${id}`;
const idOf = (key) => (key.startsWith('eden/conv.') ? key.slice(10) : null);

function notify() { for (const fn of listeners) { try { fn(info()); } catch { /* a listener's problem */ } } }
export function onSyncChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** What the account page shows. */
export function info() {
  return {
    account,
    server: status,
    on: Boolean(sealed && status && status.me && status.me.trusted),
    hasKey: Boolean(sealed),
    running,
    last: local ? local.last : 0,
    tooBig: local ? local.tooBig || 0 : 0,
    synced: local ? Object.keys(local.revs || {}).filter((k) => k.startsWith('eden/conv.')).length : 0, // conversations (other eden/ items, e.g. workflows, aren't chats)
    error: lastError,
  };
}

export async function refreshStatus() {
  status = await api('/api/web/esync');
  // Started over elsewhere (a new key), or turned off: what this browser has is stale.
  if (sealed && (!status.key || status.key.gen !== sealed.gen)) await forgetHere({ server: false });
  // The key changed (a device was removed): sealed to this browser, or this one was left out.
  if (sealed && status.key && epochOf(status.key) > epochOf(sealed)) {
    const r = status.me.rekey;
    if (status.me.trusted && r && r.epoch === epochOf(status.key)) {
      try {
        await pickUp(r, status.chain);
      } catch (e) {
        if (!e.forged) throw e; // offline for a moment: next time
        stop();
        lastError = 'askeden.com offered a new sync key this browser couldn’t check, so it isn’t used. Stop syncing here, then approve this browser again.';
        notify();
        return status;
      }
    } else {
      await forgetHere({ server: false });
      lastError = 'Eden’s sync key changed and this browser was left out (it was removed from sync on another device). Approve it again to sync here.';
    }
    status = await api('/api/web/esync');
  }
  if (sealed && status.key && !status.me.trusted) {
    // A browser that has the key but isn't listed (signed in again: a new device) proves it.
    try { await proveHere(await secretBytes()); }
    catch (e) {
      if (e.status !== 403 || e.code !== 'wrong_key') throw e;
      await forgetHere({ server: false }); // not the key of now: removed while it was signed out
      lastError = e.message;
    }
    status = await api('/api/web/esync');
  } else if (sealed && status.me.trusted && !status.me.mac && epochOf(status.me) === epochOf(sealed)) {
    // Trusted before members were vouched for: vouch now, so a key change still seals to it.
    await proveHere(await secretBytes()).then(async () => { status = await api('/api/web/esync'); }).catch(() => {});
  }
  if (sealed && status.me && status.me.trusted) await fillRing(status).catch(() => {});
  notify();
  return status;
}

let watching = null;
/**
 * While the account page's Sync is open: asks askeden.com every few seconds (not while the tab
 * is hidden), so a browser waiting to be approved shows up without a reload, and a key change
 * is picked up. `open()` says whether it still is; stops by itself when it isn't. Returns stop().
 */
export function watchStatus(open) {
  if (watching) watching();
  let t = null;
  let busy = false;
  let done = false;
  const halt = () => { done = true; clearTimeout(t); document.removeEventListener('visibilitychange', onVis); if (watching === halt) watching = null; };
  const later = () => { clearTimeout(t); if (!done && document.visibilityState === 'visible') t = setTimeout(tick, WATCH_MS); };
  async function tick() {
    if (done) return;
    if (!open()) { halt(); return; }
    if (account && !busy && document.visibilityState === 'visible') {
      busy = true;
      try { await refreshStatus(); } catch { /* offline for a moment: next time */ } finally { busy = false; }
    }
    later();
  }
  function onVis() { if (document.visibilityState === 'visible') tick(); else clearTimeout(t); }
  document.addEventListener('visibilitychange', onVis);
  later();
  watching = halt;
  return halt;
}

/* ---------- turning it on ---------- */

/** The first browser: makes the Eden key, with the recovery passphrase (required). */
export async function turnOn(passphrase) {
  const problem = E.passphraseProblem(passphrase);
  if (problem) throw new Error(problem);
  const d = await deviceKey();
  const secret = E.newSecret();
  const gen = E.b64(E.randomBytes(9)).replace(/\+/g, '-').replace(/\//g, '_');
  const key = await E.itemKey(secret);
  await api('/api/web/esync/init', {
    gen,
    proof: await E.proofOf(secret),
    keycheck: await E.sealItem(key, 'eden/keycheck', { v: 1, check: 'eden-sync-v1', gen }),
    wrap: await E.wrapWithPassphrase(passphrase, secret),
    public_key: d.public,
    alg: d.alg,
    mac: await E.memberMac(secret, d.alg, d.public),
  });
  sealed = await keepSecret('sync', secret, gen, E.SEAL_LABEL, null, { epoch: 1, ring: [] });
  local = fresh();
  store.set(stateKey(), local); // (a new key: nothing of an earlier state is taken in)
  await refreshStatus();
  start();
  return syncNow();
}

/** Another browser: the passphrase opens the key askeden.com keeps wrapped. */
export async function unlock(passphrase) {
  const { wrap, gen } = await api('/api/web/esync/unwrap', {});
  let secret;
  try { secret = await E.unwrapWithPassphrase(passphrase, wrap); }
  catch { throw new Error('That isn’t the recovery passphrase. Check it and try again.'); }
  await adopt(secret, gen, null, 'passphrase');
  return syncNow();
}

async function adopt(secret, gen, envelope, via) {
  const proved = await proveHere(secret, via); // its epoch: the key of now (the older ones come from the chain)
  sealed = await keepSecret('sync', secret, gen, E.SEAL_LABEL, envelope, { epoch: epochOf(proved), ring: [] });
  local = store.get(stateKey(), null) || fresh();
  local.since = 0; // everything, merged with what's here
  saveLocal();
  await refreshStatus();
  start();
}

let polling = null;
/** "Trust this browser": waits for a browser that syncs to approve it. Resolves 'approved' | 'denied' | 'expired'. */
export async function requestTrust({ onCode } = {}) {
  const d = await deviceKey();
  await api('/api/web/esync/request', { public_key: d.public, alg: d.alg });
  if (onCode) onCode(await E.verifyCode(d.public));
  if (polling) polling.stop = true;
  const me = { stop: false };
  polling = me;
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (me.stop) return 'cancelled';
    let got;
    try { got = await api('/api/web/esync/poll', {}); }
    catch (e) { if (e.status === 410) return 'expired'; continue; }
    if (got.status === 'denied') return 'denied';
    if (got.status !== 'approved') continue;
    const envelope = { sealed_key: got.sealed_key, sender_key: got.sender_key, alg: got.alg };
    const secret = await E.openSealed(d.privateKey, got.alg, got.sealed_key, got.sender_key);
    await adopt(secret, status && status.key ? status.key.gen : '', envelope, 'approved');
    syncNow();
    return 'approved';
  }
}
export function cancelRequest() {
  if (polling) polling.stop = true;
  api('/api/web/esync/deny', {}).catch(() => {});
}

/** From a browser that syncs: seal the key to a waiting one (after the codes matched). */
export async function approve(request) {
  if (!sealed) throw new Error('This browser doesn’t have the key.');
  const secret = await secretBytes();
  const s = await E.sealTo(request.public_key, request.alg, secret);
  // Vouches for the key whose code matched, so a later key change seals to it (an app may not vouch itself).
  await api('/api/web/esync/approve', { device_id: request.device_id, public_key: request.public_key, ...s, mac: await E.memberMac(secret, request.alg, request.public_key) });
  await refreshStatus();
}
export async function deny(deviceId) { await api('/api/web/esync/deny', { device_id: deviceId }); await refreshStatus(); }
export async function untrust(deviceId) { await api('/api/web/esync/untrust', { device_id: deviceId }); await refreshStatus(); }

/**
 * Removes another device from sync and changes the key, so it can't read what's synced from
 * now on (what it already has, it keeps). The new key is sealed to each other member whose
 * public key checks out against its `mac` under the key of now; a member without one (it never
 * vouched: an older app) is dropped and must be approved again. Resolves { dropped: [names] }.
 */
export async function removeDevice(deviceId) {
  if (!sealed) throw new Error('This browser doesn’t have the key.');
  for (let tries = 0; ; tries++) {
    const st = await refreshStatus();
    if (!sealed || !st.key || !st.me.trusted) throw new Error(lastError || 'This browser doesn’t have the key.');
    const d = await deviceKey();
    const { gen } = sealed;
    const from = epochOf(sealed);
    const plan = await E.planRotation(await secretBytes(), { gen, epoch: from, trusted: st.trusted, self: { device_id: st.me.device_id, public: d.public, alg: d.alg }, remove: deviceId });
    try {
      await api('/api/web/esync/rotate', plan.body);
    } catch (e) {
      // Someone joined, left or changed the key meanwhile: look again and redo it.
      if (tries < 2 && e.status === 409 && ['members_changed', 'rotated', 'stale_key'].includes(e.code)) continue;
      throw e;
    }
    const ring = [{ epoch: from, key: sealed.key }, ...(sealed.ring || [])];
    sealed = await keepSecret('sync', plan.next, gen, E.SEAL_LABEL, plan.mine, { epoch: from + 1, ring });
    await refreshStatus();
    syncNow();
    return { dropped: plan.dropped.map((x) => String(x.name || 'A device').replace(/^Eden on the web: /, '')) };
  }
}

export async function changePassphrase(passphrase) {
  const problem = E.passphraseProblem(passphrase);
  if (problem) throw new Error(problem);
  const secret = await secretBytes();
  await api('/api/web/esync/wrap', { proof: await E.proofOf(secret), wrap: await E.wrapWithPassphrase(passphrase, secret) });
  await refreshStatus();
}

/** Stops syncing here: this browser's copy of the key goes (its conversations stay). */
export async function forgetHere({ server = true } = {}) {
  stop();
  if (server) await api('/api/web/esync/untrust', {}).catch(() => {});
  sealed = null;
  if (account) { await keyDel('sync').catch(() => {}); store.del(stateKey()); }
  local = null;
  notify();
}

/** Start over: every synced conversation on askeden.com goes (this browser's stay), and the key. */
export async function startOver() {
  await api('/api/web/esync/wipe', {});
  await forgetHere({ server: false });
  await refreshStatus();
}

/** Signing out: nothing of this account's keys is left in this browser (nor whose chats the next page shows first). */
export async function forgetAllKeys() {
  forgetOwner();
  stop();
  if (!account) return;
  const d = await db().catch(() => null);
  if (!d) return;
  await idb('readwrite', (s) => {
    const req = s.openCursor();
    req.onsuccess = () => { const c = req.result; if (!c) return; if (String(c.key).startsWith(`${account}:`)) c.delete(); c.continue(); };
    return req;
  }).catch(() => {});
  store.del(stateKey());
}

/* ---------- the engine ---------- */

function payload(c) {
  const p = payloadOf(c, MAX_JSON);
  return p ? { value: { v: 1, conv: p.conv }, text: p.text } : null;
}

export { merge };

// A chat's parts that never travel (sync-model.js wire leaves the pictures out): the copy from another device
// lacking them doesn't drop them here (a merged chat lost its deck's pictures).
const DEVICE_ONLY = new Set(['queue', 'status', 'deckImages', 'account', 'syncRev']);
export function applyConv(c) {
  // A title from another device, cleaned (AS2-9: an older page or an import could send any characters).
  if (typeof c.title === 'string') { const t = cleanTitle(c.title); if (t !== c.title) c.title = t || 'New chat'; }
  c.queue = [];
  c.status = 'idle';
  const existing = state.convs.find((x) => x.id === c.id);
  if (!existing && heldElsewhere(c.id)) return null; // (another account's chat by that id is stored here: state.js)
  if (existing) {
    for (const k of Object.keys(existing)) if (!(k in c) && !DEVICE_ONLY.has(k)) delete existing[k];
    Object.assign(existing, c);
  } else {
    const at = state.convs.findIndex((x) => (x.updated || 0) < (c.updated || 0));
    if (at < 0) state.convs.push(c); else state.convs.splice(at, 0, c);
  }
  persistConversation(existing || c);
  return existing || c;
}

const deleteStored = (id) => { Convs.del(id); store.set('jchat:index', state.convs.filter((x) => !x.temp).map((x) => x.id)); };
export function removeConv(id) {
  const c = state.convs.find((x) => x.id === id);
  if (!c) return false;
  if (state.current === c || state.streams.has(id)) return false; // open now: it goes next time
  state.convs = state.convs.filter((x) => x !== c);
  deleteStored(id);
  return true;
}

async function pull() {
  let changedView = false;
  let current = false;
  for (let page = 0; page < 50; page++) {
    const got = await api('/api/web/esync/pull', { since: local.since });
    if (got.rev < local.since) { local.since = 0; local.revs = {}; local.hashes = {}; local.gen = newGen(); continue; } // wiped and restarted
    for (const item of got.items) {
      if (item.key === 'eden/keycheck') {
        if (!item.deleted) {
          try { await openSynced(item); }
          catch { if (ringComplete()) throw new Error('This browser’s sync key doesn’t open this account’s history. Stop syncing here, then approve it again.'); }
        }
        continue;
      }
      if (extras.has(item.key)) { await pullExtra(item); continue; } // another module's sealed item (syncItem)
      const id = idOf(item.key);
      if (!id || heldElsewhere(id)) continue; // (another account's chat by that id is stored here: left alone)
      // A private chat here (privacy.js) is left as it is, as cloud-sync.js does: another device's newer copy merged in
      // would turn its privacy off (the newer side's settings win) and send this device's turns up. Made shareable
      // again, its push (on the revision it had) conflicts and merges what the others added meanwhile.
      if (!item.deleted && (state.convs.find((x) => x.id === id) || {}).privacy === true) continue;
      // Mid-reply (before it's opened, or once it is: the reply may start meanwhile): merged next pass, from the revision
      // it had, so the push after the reply conflicts and merges. Taking this one's revision sent ours over it, unmerged.
      const before = local.revs[item.key];
      const midReply = () => { if (before === undefined) delete local.revs[item.key]; else local.revs[item.key] = before; delete local.hashes[item.key]; dirty.add(id); };
      local.revs[item.key] = item.rev;
      // Sealed under a key from before a key change: sealed again under the new one, a few a pass.
      local.reseal = (local.reseal || []).filter((k) => k !== item.key);
      if (item.deleted) {
        const here = state.convs.find((x) => x.id === id);
        if (here && here.privacy === true) { delete local.revs[item.key]; delete local.hashes[item.key]; continue; } // a private chat stays here
        if (removeConv(id)) { changedView = true; delete local.revs[item.key]; delete local.hashes[item.key]; }
        continue;
      }
      if (state.streams.has(id)) { midReply(); continue; }
      let value;
      try { value = await openSynced(item); } catch { continue; } // not ours to read: left alone
      if (!value || !value.conv || value.conv.id !== id) continue;
      if (state.streams.has(id)) { midReply(); continue; }
      const mine = state.convs.find((x) => x.id === id);
      const merged = mine ? merge(wire(mine), value.conv) : value.conv;
      const theirs = JSON.stringify(value.conv);
      applyConv(merged);
      changedView = true;
      if (mine && state.current === mine) current = true;
      local.hashes[item.key] = await E.digest(theirs);
      if (JSON.stringify(wire(merged)) !== theirs) dirty.add(id);
      if (epochOf(item) < epochOf(sealed)) local.reseal.push(item.key); // opened and merged: safe to write back
    }
    local.since = Math.max(local.since, got.rev);
    if (!got.more) break;
  }
  if (changedView) { ui.renderSidebar(); if (current) ui.render(); }
}

// Nothing is taken off the queue (deletes, dirty chats, their `seen` stamp, extras) until askeden.com
// answered for it: a push that fails leaves all of it for the next pass (bug sweep AS3).
async function push() {
  const work = [];
  // A delete of a chat that never synced has nothing to send (nor one this tab already had answered).
  local.deleted = (local.deleted || []).filter((id) => local.revs[itemName(id)] && !sent.has(id));
  for (const id of new Set(local.deleted)) {
    const key = itemName(id);
    work.push({ id, key, item: { key, deleted: true, base_rev: local.revs[key] } });
  }
  // A few items still sealed under an older key: pushed again (same content, the new key).
  const reseal = new Set((local.reseal || []).slice(0, RESEAL));
  local.reseal = (local.reseal || []).filter((k) => !reseal.has(k));
  for (const key of reseal) { const id = idOf(key); if (id) { dirty.add(id); delete local.hashes[key]; } }
  let tooBig = 0;
  for (const c of state.convs) {
    if (c.temp || state.streams.has(c.id) || !c.nodes || !Object.keys(c.nodes).length) continue;
    const key = itemName(c.id);
    if (!/^eden\/[A-Za-z0-9._:-]{1,120}$/.test(key)) continue;
    // Private (privacy.js: it stays on this device): never sent, nor its changes. One sent before it was made private
    // keeps that copy (deleting it took it off the other devices too, with the turns they had added: cloud-sync.js).
    if (c.privacy === true) continue;
    const stamp = stampOf(c);
    if (local.hashes[key] && !dirty.has(c.id) && local.seen && local.seen[c.id] === stamp) continue;
    const p = payload(c);
    if (!p) { tooBig += 1; continue; }
    const h = await E.digest(p.text);
    if (local.hashes[key] === h) { (local.seen ||= {})[c.id] = stamp; dirty.delete(c.id); continue; } // nothing new to send
    work.push({ id: c.id, key, hash: h, stamp, item: { key, data: await E.sealItem(sealed.key, key, p.value), base_rev: local.revs[key] || 0 } });
  }
  local.tooBig = tooBig;
  for (const [key, x] of extras) {
    if (!x.dirty) continue;
    const value = x.value();
    const text = JSON.stringify(value);
    x.dirty = false;
    if (text.length > MAX_JSON) continue;
    const h = await E.digest(text);
    if (local.hashes[key] === h) continue;
    work.push({ id: null, key, hash: h, extra: x, item: { key, data: await E.sealItem(sealed.key, key, value), base_rev: local.revs[key] || 0 } });
  }
  for (let i = 0; i < work.length; i += BATCH) {
    const chunk = work.slice(i, i + BATCH);
    let results;
    try { ({ results } = await api('/api/web/esync/push', { items: chunk.map((w) => w.item) })); }
    catch (e) { for (const w of work.slice(i)) if (w.extra) w.extra.dirty = true; throw e; } // not sent: all of it waits for the next pass
    for (const [j, r] of results.entries()) {
      const w = chunk[j];
      // askeden.com answered for it: off the queue (a conflict or a refusal is handled below, not sent again as is)
      if (w.item.deleted) { local.deleted = (local.deleted || []).filter((id) => id !== w.id); sent.add(w.id); }
      else if (w.id) { (local.seen ||= {})[w.id] = w.stamp; dirty.delete(w.id); }
      if (r.rev) {
        if (w.item.deleted) { delete local.revs[w.key]; delete local.hashes[w.key]; } else { local.revs[w.key] = r.rev; local.hashes[w.key] = w.hash; }
      } else if (r.conflict) {
        // Someone wrote it first: take theirs into account and push the merge next round. A reply streaming into the
        // chat now: merged once it's saved, from the revision it had (merging now cut the reply off: cloud-sync.js afterPut).
        if (w.id && !w.item.deleted && state.streams.has(w.id)) { delete local.hashes[w.key]; dirty.add(w.id); continue; }
        local.revs[w.key] = r.conflict.rev;
        if (extras.has(w.key)) {
          if (r.conflict.data) { try { extras.get(w.key).merge(await E.openItem(keysFor(epochOf(r.conflict)), w.key, r.conflict.data)); } catch { /* unreadable: ours replaces it */ } }
          extras.get(w.key).dirty = true;
          delete local.hashes[w.key];
          again = true;
          continue;
        }
        if (w.item.deleted) continue; // deleted here, changed there: keep theirs
        if (r.conflict.data) {
          try {
            const value = await E.openItem(keysFor(epochOf(r.conflict)), w.key, r.conflict.data);
            const mine = state.convs.find((x) => x.id === w.id);
            if (mine && value && value.conv) applyConv(merge(wire(mine), value.conv));
          } catch { /* unreadable: ours replaces it */ }
        }
        delete local.hashes[w.key];
        dirty.add(w.id);
        again = true;
      } else if (r.code === 'too_big' || r.code === 'too_many') {
        local.tooBig = (local.tooBig || 0) + 1;
        lastError = r.error || '';
      }
    }
  }
}

/** One pass now (pull, then push); a second pass follows when a conflict asked for it. `pushOnly`: the page was just hidden. */
export async function syncNow({ pushOnly = false } = {}) {
  if (!sealed || !local || accountSwitched()) return info();
  // This device's saved chats couldn't be read (convstore.js): another device's copy would be written over the one
  // stored here, losing what wasn't sent yet. It waits for a reload (cloud-sync.js initCloud says the same).
  if (Convs.loadFailed()) { lastError = 'This browser’s saved chats couldn’t be read, so syncing waits. Reload the page.'; notify(); return info(); }
  if (running) { again = true; return info(); }
  running = true;
  // One tab of this browser syncs at a time (Web Locks, where there are any); the other goes a little later, from what it saved.
  const L = typeof navigator !== 'undefined' && navigator && navigator.locks && typeof navigator.locks.request === 'function' ? navigator.locks : null;
  if (!L) return onePass(pushOnly);
  let ran = false;
  try {
    await L.request(`eden-esync:${account}`, { ifAvailable: true }, async (lock) => { if (!lock) return; ran = true; await onePass(pushOnly); });
  } catch { if (!ran) return onePass(pushOnly); }
  if (!ran) { running = false; clearTimeout(pushTimer); pushTimer = setTimeout(() => syncNow(), PUSH_DELAY); }
  return info();
}

async function onePass(pushOnly = false) {
  running = true;
  notify();
  try {
    takeShared();
    for (let pass = 0; pass < (pushOnly ? 1 : 3); pass++) {
      again = false;
      if (!pushOnly) await pull();
      await push();
      if (!again) break;
    }
    if (pushOnly && again) { clearTimeout(pushTimer); pushTimer = setTimeout(() => syncNow(), PUSH_DELAY); } // (a conflict: the next whole pass)
    local.last = Date.now();
    lastError = '';
    if (!pushOnly) status = await api('/api/web/esync').catch(() => status); // the counts the page shows
  } catch (e) {
    lastError = e.message || String(e);
    if (e.status === 403 && e.code === 'not_trusted') await refreshStatus().catch(() => {});
    // The key changed meanwhile: pick it up, then sync again under it.
    if (e.status === 409 && e.code === 'stale_key') {
      const from = sealed ? epochOf(sealed) : 0;
      await refreshStatus().catch(() => {});
      if (sealed && epochOf(sealed) > from) { lastError = ''; clearTimeout(pushTimer); pushTimer = setTimeout(() => syncNow(), PUSH_DELAY); }
    }
  } finally {
    running = false;
    saveLocal();
    notify();
  }
  return info();
}

/* ---------- other sealed items (learned.js: the profile the router learned from you, H2) ---------- */

const extras = new Map(); // key → { key, value(), merge(value), dirty }
/**
 * Another module's own item, sealed like the conversations: `value()` what this browser has,
 * `merge(value)` what another device synced (true when it changed something here), and
 * `bind({ changed })`, called with a function to push after a local change.
 */
export function syncItem(item) {
  extras.set(item.key, { ...item, dirty: true });
  if (item.bind) item.bind({ changed: () => { const x = extras.get(item.key); if (x) x.dirty = true; if (!sealed) return; clearTimeout(pushTimer); pushTimer = setTimeout(() => syncNow(), PUSH_DELAY); } });
}
async function pullExtra(item) {
  local.revs[item.key] = item.rev;
  if (item.deleted) return;
  let value;
  try { value = await openSynced(item); } catch { return; } // not ours to read: left alone
  const x = extras.get(item.key);
  // Under an older key: no hash, so it's pushed again under the new one.
  if (epochOf(item) < epochOf(sealed)) delete local.hashes[item.key];
  else local.hashes[item.key] = await E.digest(JSON.stringify(value));
  x.merge(value);
  x.dirty = true; // pushed back only if what's here now differs (push compares the hashes)
}

function onSaved(e) {
  if (!sealed) return;
  dirty.add(e.detail.id);
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => syncNow(), PUSH_DELAY);
}
function onDeleted(e) {
  if (!sealed || !local) return;
  (local.deleted ||= []).push(e.detail.id);
  saveLocal();
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => syncNow(), PUSH_DELAY);
}
// Hidden: what changed here goes up now, before an iPhone suspends the page (the pull waits for the next pass).
const onVisible = () => {
  if (document.visibilityState === 'visible') syncNow();
  else if (document.visibilityState === 'hidden' && (dirty.size || (local && (local.deleted || []).length))) { clearTimeout(pushTimer); syncNow({ pushOnly: true }); }
};

function start() {
  if (timer) return;
  addEventListener('eden:conv-saved', onSaved);
  addEventListener('eden:conv-deleted', onDeleted);
  document.addEventListener('visibilitychange', onVisible);
  timer = whileVisible(syncNow, EVERY); // (no timer while hidden: onVisible syncs on coming back)
}
function stop() {
  if (timer) timer();
  timer = null;
  clearTimeout(pushTimer);
  removeEventListener('eden:conv-saved', onSaved);
  removeEventListener('eden:conv-deleted', onDeleted);
  document.removeEventListener('visibilitychange', onVisible);
}
// This browser signed in to another account since the page started (state.js otherAccount): no syncing until a reload.
if (typeof addEventListener === 'function') {
  addEventListener('eden:other-account', () => { stop(); lastError = 'This browser is now signed in to another Eden account. Reload the page.'; notify(); });
}

/**
 * At page load (account.js, once askeden.com's account is known): picks up this browser's key
 * and starts syncing when it has one. `accountId` from /api/web/account.
 */
export async function initSync(accountId) {
  if (!accountId || typeof indexedDB === 'undefined' || !globalThis.crypto || !crypto.subtle) return info();
  account = accountId;
  try {
    const rec = await keyGet('sync');
    if (rec && rec.key && rec.envelope) sealed = rec;
    local = sealed ? store.get(stateKey(), null) || fresh() : null;
    await refreshStatus();
    if (sealed && status.me.trusted) { start(); syncNow(); }
  } catch (e) {
    lastError = e.message || String(e);
    notify();
  }
  return info();
}

export const syncAccount = () => account;
