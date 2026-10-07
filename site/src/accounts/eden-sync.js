// Eden's chat history on every device, end to end encrypted (ROADMAP H1; docs/accounts.md
// "Eden sync"). The account keeps Eden's conversations as sealed items it can't open, in a
// space of their own (`eden/` keys, their own revision counter and caps), beside the apps'
// sync (`s:` items, docs/accounts.md "Sync"), which browsers still may not touch.
//
// The key: Eden's own 32 random bytes (not the apps' sync key: see the docs for why), made by
// the first browser that turns sync on and never sent in the clear. It reaches another device
// only sealed to that device's public key, by a device that already has it (a "Trust this
// browser" request, approved with matching six-digit codes on both screens), or wrapped with
// the owner's recovery passphrase (PBKDF2-SHA256). The server keeps the SHA-256 of a proof
// derived from the key (web/chat/eden-crypto.js proofOf), so only a holder of the key can
// mark a device as trusted, and only a trusted device can read, write or approve.
//
// Removing a device changes the key ("rotate", done by the browser that removes it, which holds
// the key): a new key with the next epoch, sealed by that browser to each remaining member whose
// public key a holder of the old key vouched for (`mac`; so askeden.com can't slip in a key of its
// own), the old key kept under the new one (`chain`: members with the new key still read items
// sealed before; members with only the old key check the new one follows from it), and a new
// proof, so the removed device can't prove its old key again. The epoch is compared and set in
// one step (two removals at once: the second is told to try again). Members pick the new key up
// (`rekey`) when they next ask; until then they may read but not write or approve. Items record
// the epoch they were written under and are sealed again under the new key bit by bit.
//
// In the account's object (account.js sends every `esync-` op here):
//   ek:meta              { gen, created, by, proof_hash, wrap | null, epoch?, chain?, wrap_stale?, rotated? }
//   ek:trust:<device>    { device_id, public_key, alg, via, added, epoch?, mac?, rekey? }
//   ek:req:<device>      { device_id, name, public_key, alg, created, expires, status, sealed_key?, sender_key?, mac? }
//   e:eden/<name>        { rev, updated, data | null, deleted, size, epoch? }
//   erev, ecount, ebytes the revision counter, live items, their size
// (no epoch: 1, everything from before keys changed.)
//
// The Worker's side, for a signed-in browser (eden/session.js hands in who's signed in; this
// module imports neither it nor accounts/index.js, which import the account object):
//   GET  /api/web/esync                 status: the key, this browser, trusted devices, requests
//   POST /api/web/esync/<op>            init, wrap, unwrap, prove, request, poll, approve, deny,
//                                       untrust, rotate, pull, push, wipe (bodies in docs/accounts.md)
// The apps reach the same ops as POST /api/esync/<op> with their bearer token (accounts/index.js).

import { ApiError, json, sameText, sha256Hex, validDeviceId } from './util.js';

export const EDEN_SYNC = {
  items: 1000, // conversations (and the key check) per account
  itemChars: 700_000, // one sealed item, in base64 (~512 KiB)
  totalChars: 40_000_000, // everything together (~30 MB)
  page: 100,
  batch: 25,
  requests: 5, // trust requests waiting at once
  requestMs: 15 * 60_000,
  chain: 500, // key changes (each keeps the old key under the new one, ~90 characters)
  members: 100, // devices a key change seals to at once
};
const KEY = /^eden\/[A-Za-z0-9._:-]{1,120}$/;
const B64 = /^[A-Za-z0-9+/=]+$/;
const ALGS = new Set(['x25519', 'p256']);
const PUBLIC_CHARS = { x25519: 44, p256: 88 };

const bad = (message) => new ApiError(400, 'bad_request', message);

function checkPublic(alg, key) {
  if (!ALGS.has(alg)) throw bad('alg must be "x25519" or "p256".');
  if (typeof key !== 'string' || key.length !== PUBLIC_CHARS[alg] || !B64.test(key)) throw bad('public_key must be the device’s raw public key, base64.');
  return key;
}

const checkSealed = (text, what) => {
  if (typeof text !== 'string' || !text || text.length > 400 || !B64.test(text)) throw bad(`${what} must be base64.`);
  return text;
};

function checkWrap(wrap) {
  if (!wrap || typeof wrap !== 'object' || wrap.v !== 1 || wrap.kdf !== 'PBKDF2-SHA256') throw bad('wrap must be { v: 1, kdf: "PBKDF2-SHA256", iterations, salt, data }.');
  const iterations = Number(wrap.iterations);
  if (!Number.isInteger(iterations) || iterations < 310_000 || iterations > 10_000_000) throw bad('A passphrase wrap needs at least 310 000 PBKDF2 rounds.');
  return { v: 1, kdf: 'PBKDF2-SHA256', iterations, salt: checkSealed(wrap.salt, 'salt'), data: checkSealed(wrap.data, 'data') };
}

const checkProof = (proof) => {
  if (typeof proof !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(proof)) throw bad('proof must be 43 base64url characters.');
  return proof;
};

const checkMac = (mac) => {
  if (typeof mac !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(mac)) throw bad('mac must be 43 base64url characters.');
  return mac;
};

const epochOf = (record) => (record && Number.isInteger(record.epoch) && record.epoch > 0 ? record.epoch : 1);
const STALE = 'This device has Eden’s key from before a device was removed. Open Eden sync on it once to pick up the new key (an older J.A.R.V.I.S. app: update it, or stop holding the key there and ask a browser again).';

// ── the Durable Object's side ──

/** account.js: `if (op.startsWith('esync-')) return await edenSyncOp(this, op, request);` */
export async function edenSyncOp(account, op, request) {
  try {
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    const device = await account.authenticate(request);
    const s = new Sync(account, device);
    switch (op) {
      case 'esync-status': return json(await s.status());
      case 'esync-init': return json(await s.init(body));
      case 'esync-wrap': return json(await s.setWrap(body));
      case 'esync-unwrap': return json(await s.unwrap());
      case 'esync-prove': return json(await s.prove(body));
      case 'esync-request': return json(await s.request(body));
      case 'esync-poll': return json(await s.poll());
      case 'esync-approve': return json(await s.approve(body));
      case 'esync-deny': return json(await s.deny(body));
      case 'esync-untrust': return json(await s.untrust(body));
      case 'esync-rotate': return json(await s.rotate(body));
      case 'esync-pull': return json(await s.pull(Number(body.since) || 0));
      case 'esync-push': return json(await s.push(body));
      case 'esync-wipe': return json(await s.wipe());
      default: throw new ApiError(404, 'not_found', 'No such thing.');
    }
  } catch (error) {
    if (error instanceof ApiError) return error.response();
    throw error;
  }
}

class Sync {
  constructor(account, device) {
    this.a = account;
    this.storage = account.storage;
    this.device = device;
  }

  now() {
    return this.a.now();
  }

  meta() {
    return this.storage.get('ek:meta');
  }

  // Trust records of devices still signed in (others are tidied away on the way).
  async trusted() {
    const out = [];
    for (const [key, t] of await this.storage.list({ prefix: 'ek:trust:' })) {
      const d = await this.storage.get(`dev:${t.device_id}`);
      if (!d || (d.expires && d.expires <= this.now())) await this.storage.delete(key);
      else out.push({ ...t, name: d.name, kind: d.kind });
    }
    return out;
  }

  async isTrusted() {
    return Boolean(await this.storage.get(`ek:trust:${this.device.id}`));
  }

  async mustBeTrusted() {
    if (!(await this.meta())) throw new ApiError(409, 'no_key', 'Sync isn’t turned on for this account yet.');
    if (!(await this.isTrusted())) throw new ApiError(403, 'not_trusted', 'This browser doesn’t have your sync key yet. Approve it from a device that syncs, or use your recovery passphrase.');
  }

  // Trusted, and with the key of now (not one from before a device was removed): to write,
  // approve, set the passphrase or change the key. Returns { meta, mine }.
  async mustBeCurrent() {
    await this.mustBeTrusted();
    const meta = await this.meta();
    const mine = await this.storage.get(`ek:trust:${this.device.id}`);
    if (epochOf(mine) !== epochOf(meta)) throw new ApiError(409, 'stale_key', STALE);
    return { meta, mine };
  }

  async requests() {
    const out = [];
    for (const [key, r] of await this.storage.list({ prefix: 'ek:req:' })) {
      const d = await this.storage.get(`dev:${r.device_id}`);
      if (!d || r.expires <= this.now()) await this.storage.delete(key);
      else out.push(r);
    }
    return out.sort((x, y) => x.created - y.created);
  }

  async status() {
    const meta = await this.meta();
    const trusted = meta ? await this.trusted() : [];
    const requests = meta ? await this.requests() : [];
    const mine = requests.find((r) => r.device_id === this.device.id) || null;
    const me = trusted.find((t) => t.device_id === this.device.id);
    return {
      key: meta ? { gen: meta.gen, created: meta.created, wrap: Boolean(meta.wrap), iterations: meta.wrap ? meta.wrap.iterations : null, epoch: epochOf(meta), wrap_stale: Boolean(meta.wrap_stale), rotated: meta.rotated || null } : null,
      me: { device_id: this.device.id, trusted: Boolean(me), request: mine ? publicRequest(mine) : null, epoch: me ? epochOf(me) : null, mac: Boolean(me && me.mac), rekey: me && me.rekey ? me.rekey : null },
      trusted: trusted.map((t) => ({ device_id: t.device_id, name: t.name, kind: t.kind, alg: t.alg, public_key: t.public_key, via: t.via, added: t.added, this: t.device_id === this.device.id, epoch: epochOf(t), mac: t.mac || null, pending: Boolean(t.rekey) })),
      // Only a trusted device sees what's waiting for its approval, and the old keys kept under the new ones.
      requests: me ? requests.filter((r) => r.status === 'waiting').map(publicRequest) : [],
      chain: me && meta.chain ? meta.chain : [],
      rev: (await this.storage.get('erev')) || 0,
      items: (await this.storage.get('ecount')) || 0,
      bytes: (await this.storage.get('ebytes')) || 0,
      caps: { items: EDEN_SYNC.items, item_bytes: Math.floor((EDEN_SYNC.itemChars * 3) / 4), bytes: Math.floor((EDEN_SYNC.totalChars * 3) / 4) },
    };
  }

  // This device trusted with the key of `epoch`. Proving again with the same public key (signed
  // in again, a new key picked up) keeps how and when it joined; `mac` vouches for its public key.
  async trust(via, { public_key, alg }, epoch = 1, mac = null) {
    checkPublic(alg, public_key);
    const was = await this.storage.get(`ek:trust:${this.device.id}`);
    const same = was && was.public_key === public_key && was.alg === alg;
    await this.storage.put(`ek:trust:${this.device.id}`, {
      device_id: this.device.id, public_key, alg,
      via: same ? was.via : via, added: same ? was.added : this.now(), epoch, mac: mac || (same ? was.mac || null : null),
    });
  }

  // The first device: the key's check item, its proof's hash, and (optionally) the passphrase wrap.
  async init({ gen, proof, keycheck, wrap, public_key, alg, mac }) {
    if (await this.meta()) throw new ApiError(409, 'key_exists', 'Sync is already on for this account. Approve this browser from a device that syncs, or use your recovery passphrase.');
    if (typeof gen !== 'string' || !/^[A-Za-z0-9_-]{8,40}$/.test(gen)) throw bad('gen must be 8–40 base64url characters.');
    checkPublic(alg, public_key);
    const check = checkSealed(keycheck, 'keycheck');
    const meta = { gen, created: this.now(), by: this.device.id, proof_hash: await sha256Hex(checkProof(proof)), wrap: wrap ? checkWrap(wrap) : null, epoch: 1 };
    const vouched = mac ? checkMac(mac) : null;
    await this.storage.put('ek:meta', meta);
    await this.trust('created', { public_key, alg }, 1, vouched);
    const { rev } = await this.write('eden/keycheck', 0, { data: check, deleted: false });
    return { gen, rev };
  }

  // The proof's hash first, then the key's record: what follows only waits on storage, so no
  // other request on this account runs in between (the object's input gate) and changes it.
  async checkProof(proof) {
    const hash = await sha256Hex(checkProof(proof));
    const meta = await this.meta();
    if (!meta) throw new ApiError(409, 'no_key', 'Sync isn’t turned on for this account yet.');
    if (!sameText(meta.proof_hash, hash)) {
      // After a key change, the likely reason: this device was removed (or missed the change).
      if (epochOf(meta) > 1) throw new ApiError(403, 'wrong_key', 'Eden’s sync key changed when a device was removed from sync, and this one doesn’t have the new key. Stop holding the old key here, then ask a device that syncs to approve this one again.');
      throw new ApiError(403, 'wrong_key', 'That isn’t this account’s sync key.');
    }
    return meta;
  }

  // A new (or first) recovery passphrase, from a device that has the key of now.
  async setWrap({ proof, wrap }) {
    await this.mustBeCurrent();
    const meta = await this.checkProof(proof);
    meta.wrap = wrap === null ? null : checkWrap(wrap);
    meta.wrap_stale = false;
    await this.storage.put('ek:meta', meta);
    return { wrap: Boolean(meta.wrap) };
  }

  async unwrap() {
    const meta = await this.meta();
    if (!meta) throw new ApiError(409, 'no_key', 'Sync isn’t turned on for this account yet.');
    if (!meta.wrap && meta.wrap_stale) throw new ApiError(404, 'no_wrap', 'The recovery passphrase was for Eden’s key before a device was removed, so it no longer unlocks. Approve this browser from a device that syncs, then set the passphrase again there.');
    if (!meta.wrap) throw new ApiError(404, 'no_wrap', 'There’s no recovery passphrase on this account. Approve this browser from a device that syncs.');
    return { gen: meta.gen, wrap: meta.wrap, epoch: epochOf(meta) };
  }

  // A device that opened the key (an approval, the passphrase, or a key change sealed to it)
  // proves it, and is trusted with the key of now. `mac` (newer devices) vouches for its public
  // key; else the one its approver gave, or the one it had.
  async prove({ proof, public_key, alg, via = 'approved', mac }) {
    const meta = await this.checkProof(proof);
    const r = await this.storage.get(`ek:req:${this.device.id}`);
    const vouched = mac ? checkMac(mac) : r && r.mac && r.status === 'approved' && r.public_key === public_key ? r.mac : null;
    await this.trust(via === 'passphrase' ? 'passphrase' : 'approved', { public_key, alg }, epochOf(meta), vouched);
    await this.storage.delete(`ek:req:${this.device.id}`);
    return { trusted: true, epoch: epochOf(meta) };
  }

  // "Trust this browser": waits (15 minutes) for a trusted device to seal the key to it.
  async request({ public_key, alg }) {
    if (!(await this.meta())) throw new ApiError(409, 'no_key', 'Sync isn’t turned on for this account yet.');
    checkPublic(alg, public_key);
    const waiting = await this.requests();
    for (const r of waiting.filter((x) => x.device_id !== this.device.id).slice(0, Math.max(0, waiting.length - (EDEN_SYNC.requests - 1)))) {
      await this.storage.delete(`ek:req:${r.device_id}`);
    }
    const r = { device_id: this.device.id, name: this.device.name, kind: this.device.kind, public_key, alg, created: this.now(), expires: this.now() + EDEN_SYNC.requestMs, status: 'waiting' };
    await this.storage.put(`ek:req:${this.device.id}`, r);
    return publicRequest(r);
  }

  async poll() {
    const r = await this.storage.get(`ek:req:${this.device.id}`);
    if (!r || r.expires <= this.now()) throw new ApiError(410, 'expired', 'That request ran out. Ask again.');
    if (r.status === 'denied') {
      await this.storage.delete(`ek:req:${this.device.id}`);
      return { status: 'denied' };
    }
    if (r.status !== 'approved') return { status: 'waiting' };
    return { status: 'approved', sealed_key: r.sealed_key, sender_key: r.sender_key, alg: r.alg, by: r.by_name || null };
  }

  // A trusted device seals the key to the request's own public key (echoed back, so it can't
  // have been swapped between what the approver checked and what it sealed to).
  // `mac` (optional): the approver vouches for the request's public key with the key, so a
  // later key change seals to it even if it never sends one itself (an older app).
  async approve({ device_id, public_key, sealed_key, sender_key, mac }) {
    await this.mustBeCurrent();
    const r = validDeviceId(device_id) ? await this.storage.get(`ek:req:${device_id}`) : null;
    if (!r || r.expires <= this.now() || r.status !== 'waiting') throw new ApiError(404, 'not_found', 'That request is gone. Ask again in the other browser.');
    if (!sameText(r.public_key, String(public_key || ''))) throw new ApiError(409, 'conflict', 'That browser’s key changed. Check the code again.');
    r.status = 'approved';
    r.sealed_key = checkSealed(sealed_key, 'sealed_key');
    r.sender_key = checkSealed(sender_key, 'sender_key');
    r.mac = mac ? checkMac(mac) : null;
    r.by = this.device.id;
    r.by_name = this.device.name;
    await this.storage.put(`ek:req:${device_id}`, r);
    return { approved: true };
  }

  async deny({ device_id }) {
    const id = device_id || this.device.id;
    if (id !== this.device.id) await this.mustBeTrusted();
    const r = validDeviceId(id) ? await this.storage.get(`ek:req:${id}`) : null;
    if (!r) return { denied: false };
    if (id === this.device.id) await this.storage.delete(`ek:req:${id}`);
    else await this.storage.put(`ek:req:${id}`, { ...r, status: 'denied', sealed_key: null, sender_key: null });
    return { denied: true };
  }

  // A device stops syncing: itself, or (from a trusted device) another one. The account page
  // removes another device with `rotate` instead, so the one removed can't prove its key again.
  async untrust({ device_id }) {
    const id = device_id || this.device.id;
    if (id !== this.device.id) await this.mustBeTrusted();
    await this.storage.delete(`ek:trust:${id}`);
    return { untrusted: id };
  }

  // Removing a device changes the key (see the top). The browser that removes it sends: the
  // epoch it holds (`from_epoch`: compared and set here in one step), proofs of the old key and
  // the new, the old key kept under the new (`prev`), and every other trusted device either in
  // `members` (the new key sealed to its public key, which it checked against its `mac`, and a
  // new `mac`) or in `drop` (no `mac` to check, or the one removed): a list that doesn't match
  // who's trusted now is refused (409 members_changed: ask again and redo it). The passphrase's
  // wrap can't follow without the passphrase: it goes (wrap_stale), unless a new one comes along.
  async rotate({ from_epoch, proof, new_proof, prev, remove, members, drop, wrap }) {
    const nextHash = await sha256Hex(checkProof(new_proof));
    await this.mustBeCurrent();
    const meta = await this.checkProof(proof); // from here to the writes: storage only
    const epoch = epochOf(meta);
    if (Number(from_epoch) !== epoch || epochOf(await this.storage.get(`ek:trust:${this.device.id}`)) !== epoch) throw new ApiError(409, 'rotated', 'Eden’s key just changed on another device. Try again.');
    const next = epoch + 1;
    if (sameText(nextHash, meta.proof_hash)) throw bad('new_proof must be a new key’s.');
    const link = checkSealed(prev, 'prev');
    if ((meta.chain || []).length >= EDEN_SYNC.chain) throw new ApiError(409, 'too_many', 'Eden’s key has changed too many times. Start over instead.');
    if (!Array.isArray(members) || !members.length || members.length > EDEN_SYNC.members) throw bad('members must list the devices that keep the key.');
    const dropping = new Set(Array.isArray(drop) ? drop.filter((id) => validDeviceId(id)) : []);
    if (remove !== undefined && remove !== null) {
      if (!validDeviceId(remove) || remove === this.device.id) throw bad('remove must be another device. To stop here, use untrust.');
      dropping.add(remove);
    }
    const changed = () => new ApiError(409, 'members_changed', 'The devices that sync just changed. Try again.');
    const trusted = new Map((await this.trusted()).map(({ name, kind, ...t }) => [t.device_id, t]));
    const writes = {};
    for (const m of members) {
      const t = m && validDeviceId(m.device_id) ? trusted.get(m.device_id) : null;
      if (!t || writes[`ek:trust:${t.device_id}`] || dropping.has(t.device_id) || !sameText(t.public_key, String(m.public_key || ''))) throw changed();
      const { rekey, ...kept } = t;
      writes[`ek:trust:${t.device_id}`] = t.device_id === this.device.id
        ? { ...kept, epoch: next, mac: checkMac(m.mac) }
        : { ...kept, epoch: epochOf(t), mac: checkMac(m.mac), rekey: { epoch: next, sealed_key: checkSealed(m.sealed_key, 'sealed_key'), sender_key: checkSealed(m.sender_key, 'sender_key'), alg: t.alg } };
    }
    if (!writes[`ek:trust:${this.device.id}`]) throw bad('The device changing the key keeps it too.');
    const gone = [];
    for (const id of trusted.keys()) {
      if (writes[`ek:trust:${id}`]) continue;
      if (!dropping.has(id)) throw changed();
      gone.push(id);
    }
    // Approved requests not collected yet hold the old key: they ask again.
    const collected = [...(await this.storage.list({ prefix: 'ek:req:' })).entries()].filter(([, r]) => r.status === 'approved').map(([key]) => key);
    const newWrap = wrap ? checkWrap(wrap) : null;
    writes['ek:meta'] = {
      ...meta,
      epoch: next,
      proof_hash: nextHash,
      chain: [...(meta.chain || []), { epoch: next, prev: link }],
      wrap: newWrap,
      wrap_stale: !newWrap && Boolean(meta.wrap || meta.wrap_stale),
      rotated: this.now(),
      rotated_by: this.device.id,
    };
    await this.storage.put(writes);
    const away = [...gone.map((id) => `ek:trust:${id}`), ...collected];
    if (away.length) await this.storage.delete(away);
    return { epoch: next, dropped: gone, wrap: Boolean(newWrap) };
  }

  async pull(since) {
    await this.mustBeTrusted();
    const items = [...(await this.storage.list({ prefix: 'e:' })).entries()]
      .map(([key, item]) => ({ key: key.slice(2), ...item }))
      .filter((item) => item.rev > since)
      .sort((x, y) => x.rev - y.rev);
    const page = items.slice(0, EDEN_SYNC.page);
    const more = items.length > page.length;
    const rev = more ? page[page.length - 1].rev : (await this.storage.get('erev')) || 0;
    return { rev, more, items: page.map((i) => ({ key: i.key, rev: i.rev, data: i.deleted ? null : i.data, deleted: Boolean(i.deleted), updated: i.updated, epoch: epochOf(i) })) };
  }

  // Several writes at once (each its own base_rev): { results: [{ key, rev } | { key, conflict } | { key, error, code }] }.
  // Only with the key of now (409 stale_key): a device that missed a key change would write
  // under a key the removed device has. Each item records that epoch (`epoch`, what sealed it).
  async push({ items }) {
    const { meta } = await this.mustBeCurrent();
    this.epoch = epochOf(meta);
    if (!Array.isArray(items) || !items.length) throw bad('items must be a non-empty list.');
    if (items.length > EDEN_SYNC.batch) throw bad(`At most ${EDEN_SYNC.batch} items at once.`);
    const results = [];
    for (const item of items) {
      const key = item && typeof item.key === 'string' ? item.key : '';
      try {
        if (!KEY.test(key)) throw bad('An Eden item key is eden/ and up to 120 of A–Z a–z 0–9 . _ : -');
        if (key === 'eden/keycheck') throw new ApiError(403, 'forbidden', 'The key check is written once, when sync is turned on.');
        if (item.deleted === true) {
          results.push({ key, ...(await this.write(key, item.base_rev ?? 0, { data: null, deleted: true })) });
        } else {
          if (typeof item.data !== 'string' || !item.data || !B64.test(item.data)) throw bad('data must be sealed base64.');
          if (item.data.length > EDEN_SYNC.itemChars) throw new ApiError(413, 'too_big', 'A synced conversation is at most 512 KB once sealed.');
          results.push({ key, ...(await this.write(key, item.base_rev ?? 0, { data: item.data, deleted: false })) });
        }
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        if (error.code === 'conflict') results.push({ key, conflict: error.extra.item });
        else results.push({ key, error: error.message, code: error.code });
      }
    }
    return { results, rev: (await this.storage.get('erev')) || 0 };
  }

  async write(key, base, change) {
    const current = await this.storage.get(`e:${key}`);
    const currentRev = current ? current.rev : 0;
    if (Number(base) !== currentRev) {
      const item = { key, rev: currentRev, data: current && !current.deleted ? current.data : null, deleted: Boolean(current?.deleted), epoch: epochOf(current) };
      throw new ApiError(409, 'conflict', 'Something newer is there; merge and try again.', {}, { item });
    }
    let count = (await this.storage.get('ecount')) || 0;
    let bytes = (await this.storage.get('ebytes')) || 0;
    const size = change.deleted ? 0 : change.data.length;
    const was = current && !current.deleted ? current.size || current.data.length : 0;
    if (!current || current.deleted) {
      if (!change.deleted && count >= EDEN_SYNC.items) throw new ApiError(413, 'too_many', `Sync keeps at most ${EDEN_SYNC.items} conversations.`);
      if (!change.deleted) count += 1;
    } else if (change.deleted) {
      count -= 1;
    }
    if (bytes - was + size > EDEN_SYNC.totalChars) throw new ApiError(413, 'too_big', 'Your synced conversations are at the most askeden.com keeps (about 30 MB). Delete some old ones.');
    bytes = Math.max(0, bytes - was + size);
    const rev = ((await this.storage.get('erev')) || 0) + 1;
    await this.storage.put({ [`e:${key}`]: { rev, updated: this.now(), size, ...change, epoch: this.epoch || 1 }, erev: rev, ecount: count, ebytes: bytes });
    return { rev };
  }

  // Start over: every synced conversation, the key's record, trust and requests go (the
  // revision keeps counting, so no device mistakes the new start for what it saw).
  async wipe() {
    const keys = [...(await this.storage.list({ prefix: 'e:' })).keys(), ...(await this.storage.list({ prefix: 'ek:' })).keys()];
    for (let i = 0; i < keys.length; i += 128) await this.storage.delete(keys.slice(i, i + 128));
    await this.storage.put({ ecount: 0, ebytes: 0 });
    return { wiped: true, rev: (await this.storage.get('erev')) || 0 };
  }
}

const publicRequest = (r) => ({ device_id: r.device_id, name: r.name, kind: r.kind, public_key: r.public_key, alg: r.alg, created: r.created, expires: r.expires, status: r.status });

// ── the Worker's side ──

const OPS = new Set(['init', 'wrap', 'unwrap', 'prove', 'request', 'poll', 'approve', 'deny', 'untrust', 'rotate', 'pull', 'push', 'wipe']);
// Ops a person repeats only now and then: a tighter limit (LINK_RATE, 30 a minute per account).
const CAREFUL = new Set(['unwrap', 'request', 'approve', 'init', 'wipe', 'rotate']);

async function ask(env, accountId, op, body, auth) {
  const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName(accountId));
  const response = await stub.fetch(`https://account/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-jarvis-device': auth.device, 'x-jarvis-secret': auth.secret },
    body: JSON.stringify(body),
  });
  const out = await response.json().catch(() => ({}));
  if (response.status >= 400) {
    const { error, code, ...extra } = out;
    throw new ApiError(response.status, code || 'error', error || 'Something went wrong.', {}, extra);
  }
  return out;
}

async function slowDown(env, binding, key) {
  const limiter = env[binding];
  if (!limiter) return;
  const { success } = await limiter.limit({ key });
  if (!success) throw new ApiError(429, 'slow_down', 'Too many tries; wait a minute.', { 'retry-after': '60' });
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > EDEN_SYNC.itemChars * EDEN_SYNC.batch + 64_000) throw new ApiError(413, 'too_big', 'That request is too big.');
  try {
    const value = JSON.parse(text || '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // below
  }
  throw bad('Send a JSON object.');
}

/**
 * /api/web/esync[/<op>] for a signed-in browser (`who`: { account, token }, its own session,
 * never a delegate's), and /api/esync/<op> for the apps (the same `who` from their token).
 */
export async function edenSyncApi(request, env, who, op) {
  await slowDown(env, 'API_RATE', who.account);
  if (!op) {
    if (request.method !== 'GET') throw new ApiError(405, 'bad_request', 'GET it.');
    return json(await ask(env, who.account, 'esync-status', {}, who.token));
  }
  if (!OPS.has(op)) throw new ApiError(404, 'not_found', 'No such thing.');
  if (request.method !== 'POST') throw new ApiError(405, 'bad_request', 'POST it.');
  if (CAREFUL.has(op)) await slowDown(env, 'LINK_RATE', `esync:${who.account}`);
  return json(await ask(env, who.account, `esync-${op}`, await readBody(request), who.token));
}
