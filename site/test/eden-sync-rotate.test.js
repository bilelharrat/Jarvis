// Eden sync (H1): removing a device changes the key (docs/accounts.md "Eden sync", "Removing a
// device"). The browser's own code makes and checks the change (public/eden/eden-crypto.js:
// planRotation, followRekey, chainBack, the copy scripts/sync-eden.mjs makes of web/chat); the
// server compares and sets the epoch in one step, seals nothing itself, and stops the removed
// device and members that missed the change from writing.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { Space } from '../src/accounts/space.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';
import * as E from '../public/eden/eden-crypto.js';

const ORIGIN = 'https://askeden.com';
const A = '11111111-1111-4111-8111-111111111111';
const GEN = 'gen-abcdef12';

let env;
const ctx = { waitUntil: () => {} };

beforeEach(() => {
  forgetSessions();
  env = { ANTHROPIC_API_KEY: 'sk-test', TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '20', LINK_RATE: rateLimiter(), API_RATE: rateLimiter(), EDEN_RATE: rateLimiter() };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.IDENTITIES = namespace(Identity, env);
  env.SPACES = namespace(Space, env);
  env.ASSETS = { fetch: async () => new Response('asset') };
});

const browserSession = async (name) => (await call(env, A, 'web-signin', { account_id: A, create: true, device: { name } })).token;
const phoneToken = async (name = 'Bilel’s iPhone') => (await call(env, A, 'signin', { account_id: A, device: { name, kind: 'iphone' } })).token;

async function as(who, p, body) {
  const headers = who.session
    ? { 'x-jarvis-chat': '1', cookie: `__Host-eden=${who.session}`, origin: ORIGIN, 'user-agent': 'Mozilla/5.0 Chrome/140' }
    : { authorization: `Bearer ${who.token}` };
  const init = { method: body === undefined ? 'GET' : 'POST', headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }
  const prefix = who.session ? '/api/web/esync' : '/api/esync';
  const r = await worker.fetch(new Request(`${ORIGIN}${prefix}${p}`, init), env, ctx);
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** A device of the account with its own key pair: a browser (session) or an app (token). */
async function device(kind, name, alg = 'x25519') {
  const who = kind === 'web' ? { session: await browserSession(`Eden on the web: ${name}`) } : { token: await phoneToken(name) };
  return Object.assign(who, { name, pair: await E.deviceKeyPair(alg) });
}

/** The first browser turns sync on (vouching for itself, as web/chat/sync.js turnOn does). */
async function turnOn(d) {
  const secret = E.newSecret();
  const r = await as(d, '/init', {
    gen: GEN,
    proof: await E.proofOf(secret),
    keycheck: await E.sealItem(await E.itemKey(secret), 'eden/keycheck', { v: 1, check: 'eden-sync-v1', gen: GEN }),
    wrap: await E.wrapWithPassphrase('a long recovery passphrase', secret, 310_000),
    public_key: d.pair.public,
    alg: d.pair.alg,
    mac: await E.memberMac(secret, d.pair.alg, d.pair.public),
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  d.secret = secret;
  return secret;
}

/**
 * `joiner` asks, `approver` approves (vouching for it unless `vouch` is false: an older client),
 * and the joiner proves the key (vouching for itself unless `self` is false: an older app).
 */
async function join(joiner, approver, { vouch = true, self = true } = {}) {
  assert.equal((await as(joiner, '/request', { public_key: joiner.pair.public, alg: joiner.pair.alg })).status, 200);
  const req = (await as(approver, '')).body.requests.find((r) => r.public_key === joiner.pair.public);
  const sealed = await E.sealTo(req.public_key, req.alg, approver.secret);
  const mac = vouch ? await E.memberMac(approver.secret, req.alg, req.public_key) : undefined;
  assert.equal((await as(approver, '/approve', { device_id: req.device_id, public_key: req.public_key, ...sealed, mac })).status, 200);
  const got = (await as(joiner, '/poll', {})).body;
  const secret = await E.openSealed(joiner.pair.privateKey, got.alg, got.sealed_key, got.sender_key);
  const proved = await as(joiner, '/prove', { proof: await E.proofOf(secret), public_key: joiner.pair.public, alg: joiner.pair.alg, via: 'approved', ...(self ? { mac: await E.memberMac(secret, joiner.pair.alg, joiner.pair.public) } : {}) });
  assert.equal(proved.status, 200);
  joiner.secret = secret;
  joiner.epoch = proved.body.epoch;
  return req.device_id;
}

/** What web/chat/sync.js removeDevice does: plan with the status, post `rotate`. */
async function remove(by, id, epoch = 1) {
  const st = (await as(by, '')).body;
  const plan = await E.planRotation(by.secret, { gen: GEN, epoch, trusted: st.trusted, self: { device_id: st.me.device_id, public: by.pair.public, alg: by.pair.alg }, remove: id });
  const r = await as(by, '/rotate', plan.body);
  if (r.status === 200) by.secret = plan.next;
  return { r, plan };
}

/** What sync.js pickUp does: the rekey opened and checked against the key this device has. */
async function pickUp(d) {
  const st = (await as(d, '')).body;
  const next = await E.openSealed(d.pair.privateKey, st.me.rekey.alg, st.me.rekey.sealed_key, st.me.rekey.sender_key);
  const between = await E.followRekey(next, st.me.rekey.epoch, st.chain, GEN, d.secret, st.me.epoch);
  const proved = await as(d, '/prove', { proof: await E.proofOf(next), public_key: d.pair.public, alg: d.pair.alg, via: 'approved', mac: await E.memberMac(next, d.pair.alg, d.pair.public) });
  assert.equal(proved.status, 200, JSON.stringify(proved.body));
  d.secret = next;
  return between;
}

test('crypto: a member mac is the key’s vouching for one public key; a chain link opens only under its new key, gen and epoch', async () => {
  const k1 = E.newSecret();
  const k2 = E.newSecret();
  const p = await E.deviceKeyPair('x25519');
  const mac = await E.memberMac(k1, 'x25519', p.public);
  assert.match(mac, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(mac, await E.memberMac(k1, 'x25519', p.public));
  assert.notEqual(mac, await E.memberMac(k2, 'x25519', p.public));
  assert.notEqual(mac, await E.memberMac(k1, 'p256', p.public));
  assert.notEqual(mac, await E.proofOf(k1));
  const link = await E.chainLink(k2, k1, GEN, 2);
  assert.deepEqual(await E.openChainLink(k2, link, GEN, 2), k1);
  await assert.rejects(E.openChainLink(k1, link, GEN, 2), /doesn’t open/);
  await assert.rejects(E.openChainLink(k2, link, 'gen-other123', 2), /doesn’t open/);
  await assert.rejects(E.openChainLink(k2, link, GEN, 3), /doesn’t open/);
  // Several rotations: walked back from the newest; a key ring opens items of any epoch.
  const k3 = E.newSecret();
  const chain = [{ epoch: 2, prev: link }, { epoch: 3, prev: await E.chainLink(k3, k2, GEN, 3) }];
  const back = await E.chainBack(k3, 3, chain, GEN);
  assert.deepEqual(back.map((b) => b.epoch), [2, 1]);
  assert.deepEqual(back[1].secret, k1);
  assert.deepEqual(await E.followRekey(k3, 3, chain, GEN, k1, 1), [back[0]]);
  const old = await E.sealItem(await E.itemKey(k1), 'eden/conv.c1', { v: 1, t: 'old' });
  const ring = [await E.itemKey(k3), await E.itemKey(k2), await E.itemKey(k1)];
  assert.deepEqual(await E.openItem(ring, 'eden/conv.c1', old), { v: 1, t: 'old' });
  await assert.rejects(E.openItem(ring.slice(0, 2), 'eden/conv.c1', old), /wrong key/);
});

test('crypto: a key askeden.com made up doesn’t follow from the member’s key', async () => {
  const k1 = E.newSecret();
  const k2 = E.newSecret();
  const real = [{ epoch: 2, prev: await E.chainLink(k2, k1, GEN, 2) }];
  // The server knows neither key: it can seal a key of its own to a member, but not chain it to k1.
  const fake = E.newSecret();
  await assert.rejects(E.followRekey(fake, 2, real, GEN, k1, 1), /doesn’t open/);
  const forgedChain = [{ epoch: 2, prev: await E.chainLink(fake, E.newSecret(), GEN, 2) }];
  await assert.rejects(E.followRekey(fake, 2, forgedChain, GEN, k1, 1), /doesn’t follow/);
  await assert.rejects(E.followRekey(fake, 2, [], GEN, k1, 1), /doesn’t follow/);
  assert.equal((await E.followRekey(k2, 2, real, GEN, k1, 1)).length, 0);
});

test('rotate: removing a browser seals a new key to the vouched-for members only; the removed one can’t prove, read or write', async () => {
  const first = await device('web', 'Chrome on a Mac');
  await turnOn(first);
  const old = await device('web', 'Safari on an iPhone', 'p256');
  const oldId = await join(old, first);
  const phone = await device('app', 'Bilel’s iPhone');
  await join(phone, first, { self: false }); // an older app: only its approver vouched for it
  const legacy = await device('web', 'Firefox on Windows');
  await join(legacy, first, { vouch: false, self: false }); // trusted before anyone vouched
  // Something synced under the first key.
  const before = await E.sealItem(await E.itemKey(first.secret), 'eden/conv.c1', { v: 1, t: 'before' });
  assert.equal((await as(first, '/push', { items: [{ key: 'eden/conv.c1', data: before, base_rev: 0 }] })).body.results[0].rev, 2);
  const k1 = first.secret;

  // Only a holder of the key of now can change it, and only from the epoch there is.
  const st = (await as(first, '')).body;
  assert.equal(st.key.epoch, 1);
  assert.equal(st.trusted.find((t) => t.this).mac, await E.memberMac(k1, first.pair.alg, first.pair.public));
  const self = { device_id: st.me.device_id, public: first.pair.public, alg: first.pair.alg };
  const wrongEpoch = await E.planRotation(k1, { gen: GEN, epoch: 2, trusted: st.trusted, self, remove: oldId });
  assert.equal((await as(first, '/rotate', wrongEpoch.body)).body.code, 'rotated');
  const notTheKey = await E.planRotation(E.newSecret(), { gen: GEN, epoch: 1, trusted: st.trusted, self, remove: oldId });
  assert.equal((await as(first, '/rotate', notTheKey.body)).status, 403);
  // A list that leaves out a trusted device is refused (it would keep the old key unnoticed).
  const partial = await E.planRotation(k1, { gen: GEN, epoch: 1, trusted: st.trusted, self, remove: oldId });
  const missing = { ...partial.body, members: partial.body.members.filter((m) => m.device_id === st.me.device_id), drop: [] };
  assert.equal((await as(first, '/rotate', missing)).body.code, 'members_changed');

  const { r, plan } = await remove(first, oldId);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.epoch, 2);
  // Dropped: the removed browser, and the one nobody vouched for (it must be approved again).
  assert.deepEqual(r.body.dropped.sort(), [oldId, (await as(legacy, '')).body.me.device_id].sort());
  assert.deepEqual(plan.dropped.map((x) => x.name), ['Eden on the web: Firefox on Windows']);
  const after = (await as(first, '')).body;
  assert.deepEqual([after.key.epoch, after.key.wrap, after.key.wrap_stale, after.me.epoch], [2, false, true, 2]);
  assert.equal(after.chain.length, 1);
  assert.deepEqual(after.trusted.map((t) => [t.name, t.epoch, t.pending]).sort(), [['Bilel’s iPhone', 1, true], ['Eden on the web: Chrome on a Mac', 2, false]]);

  // The removed browser: not trusted, its old key proves nothing, it reads and writes nothing.
  const gone = (await as(old, '')).body;
  assert.deepEqual([gone.me.trusted, gone.me.rekey, gone.chain], [false, null, []]);
  const reprove = await as(old, '/prove', { proof: await E.proofOf(k1), public_key: old.pair.public, alg: old.pair.alg });
  assert.equal(reprove.status, 403);
  assert.match(reprove.body.error, /changed when a device was removed/);
  assert.equal((await as(old, '/pull', { since: 0 })).status, 403);
  assert.equal((await as(old, '/push', { items: [{ key: 'eden/conv.c2', data: before, base_rev: 0 }] })).status, 403);
  assert.equal((await as(legacy, '/pull', { since: 0 })).status, 403);
  // The recovery passphrase was for the old key: it's gone, and says why.
  const unwrap = await as(old, '/unwrap', {});
  assert.equal(unwrap.status, 404);
  assert.match(unwrap.body.error, /before a device was removed/);

  // The iPhone missed the change: it may read, but not write or approve, until it picks it up.
  const phoneSt = (await as(phone, '')).body;
  assert.deepEqual([phoneSt.me.trusted, phoneSt.me.epoch, phoneSt.me.rekey.epoch, phoneSt.key.epoch], [true, 1, 2, 2]);
  assert.equal((await as(phone, '/pull', { since: 0 })).status, 200);
  const stale = await as(phone, '/push', { items: [{ key: 'eden/conv.c3', data: before, base_rev: 0 }] });
  assert.deepEqual([stale.status, stale.body.code], [409, 'stale_key']);
  // What an older app does with its old key: approving is refused (it can't hand out the old key).
  const newcomer = await device('web', 'Edge on Windows');
  await as(newcomer, '/request', { public_key: newcomer.pair.public, alg: newcomer.pair.alg });
  const waiting = phoneSt.requests.length ? phoneSt.requests : (await as(phone, '')).body.requests;
  const toNewcomer = await E.sealTo(waiting[0].public_key, waiting[0].alg, k1);
  assert.equal((await as(phone, '/approve', { device_id: waiting[0].device_id, public_key: waiting[0].public_key, ...toNewcomer })).body.code, 'stale_key');
  // A newer one picks it up (the chain leads back to the key it has), then works as before.
  assert.deepEqual(await pickUp(phone), []);
  const picked = (await as(phone, '')).body;
  assert.deepEqual([picked.me.epoch, picked.me.rekey, picked.me.mac], [2, null, true]);
  assert.deepEqual(phone.secret, first.secret);

  // Items: the old one says epoch 1 and opens with the ring; new writes say 2.
  const k2 = first.secret;
  const newer = await E.sealItem(await E.itemKey(k2), 'eden/conv.c4', { v: 1, t: 'after' });
  assert.ok((await as(first, '/push', { items: [{ key: 'eden/conv.c4', data: newer, base_rev: 0 }] })).body.results[0].rev);
  const pulled = (await as(phone, '/pull', { since: 0 })).body.items;
  const byKey = Object.fromEntries(pulled.map((i) => [i.key, i]));
  assert.deepEqual([byKey['eden/keycheck'].epoch, byKey['eden/conv.c1'].epoch, byKey['eden/conv.c4'].epoch], [1, 1, 2]);
  const older = await E.chainBack(k2, 2, picked.chain, GEN);
  const ring = [await E.itemKey(k2), ...(await Promise.all(older.map((o) => E.itemKey(o.secret))))];
  assert.deepEqual(await E.openItem(ring, 'eden/conv.c1', byKey['eden/conv.c1'].data), { v: 1, t: 'before' });
  // Sealed again under the new key (sync.js does it a few at a time): now epoch 2.
  const again = await E.sealItem(await E.itemKey(k2), 'eden/conv.c1', { v: 1, t: 'before' });
  assert.ok((await as(first, '/push', { items: [{ key: 'eden/conv.c1', data: again, base_rev: byKey['eden/conv.c1'].rev }] })).body.results[0].rev);
  assert.equal((await as(first, '/pull', { since: 0 })).body.items.find((i) => i.key === 'eden/conv.c1').epoch, 2);
  // The removed browser's old key opens none of what came after.
  await assert.rejects(E.openItem(await E.itemKey(k1), 'eden/conv.c4', newer), /wrong key/);
  // A new passphrase for the new key clears the warning.
  assert.equal((await as(first, '/wrap', { proof: await E.proofOf(k2), wrap: await E.wrapWithPassphrase('another long passphrase', k2, 310_000) })).status, 200);
  assert.deepEqual([(await as(first, '')).body.key.wrap, (await as(first, '')).body.key.wrap_stale], [true, false]);
});

test('rotate: two removals at once: the second is told to try again; a joiner approved with the old key asks again; a new member gets the old keys from the chain', async () => {
  const first = await device('web', 'Chrome on a Mac');
  await turnOn(first);
  const second = await device('web', 'Safari on a Mac');
  await join(second, first);
  const third = await device('web', 'Firefox on Linux');
  const thirdId = await join(third, first);
  const k1 = first.secret;
  // Both plan from epoch 1; the first to arrive wins.
  const stA = (await as(first, '')).body;
  const stB = (await as(second, '')).body;
  const planA = await E.planRotation(k1, { gen: GEN, epoch: 1, trusted: stA.trusted, self: { device_id: stA.me.device_id, public: first.pair.public, alg: first.pair.alg }, remove: thirdId });
  const planB = await E.planRotation(k1, { gen: GEN, epoch: 1, trusted: stB.trusted, self: { device_id: stB.me.device_id, public: second.pair.public, alg: second.pair.alg }, remove: thirdId });
  // An approval that hasn't been collected yet carries the old key.
  const late = await device('web', 'Edge on Windows');
  await as(late, '/request', { public_key: late.pair.public, alg: late.pair.alg });
  const req = (await as(first, '')).body.requests[0];
  await as(first, '/approve', { device_id: req.device_id, public_key: req.public_key, ...(await E.sealTo(req.public_key, req.alg, k1)) });
  assert.equal((await as(first, '/rotate', planA.body)).status, 200);
  first.secret = planA.next;
  const lost = await as(second, '/rotate', planB.body);
  assert.equal(lost.status, 409);
  assert.ok(['rotated', 'stale_key'].includes(lost.body.code));
  assert.equal((await as(late, '/poll', {})).status, 410);
  // The second browser picks the new key up instead.
  await pickUp(second);
  assert.deepEqual(second.secret, planA.next);
  // A browser approved after the change gets the key of now, and the older ones from the chain.
  const fresh = await device('web', 'Chrome on Windows');
  await join(fresh, second);
  assert.equal(fresh.epoch, 2);
  const chain = (await as(fresh, '')).body.chain;
  assert.deepEqual((await E.chainBack(fresh.secret, 2, chain, GEN)).map((o) => o.secret), [k1]);
  // A device can't remove itself with a key change (it stops syncing with untrust).
  const st = (await as(first, '')).body;
  const selfRemove = await E.planRotation(first.secret, { gen: GEN, epoch: 2, trusted: st.trusted, self: { device_id: st.me.device_id, public: first.pair.public, alg: first.pair.alg }, remove: null });
  assert.equal((await as(first, '/rotate', { ...selfRemove.body, remove: st.me.device_id })).status, 400);
});
