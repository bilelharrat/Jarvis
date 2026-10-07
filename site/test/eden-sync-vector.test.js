// Eden sync and the J.A.R.V.I.S. apps (docs/accounts.md "Eden sync", "The J.A.R.V.I.S. apps"):
// the vector the apps' tests share (companion/Tests/Fixtures/eden-sync-vector.json, made by
// scripts/eden-sync-vector.mjs) still opens with the browser's eden-crypto.js, and an app joins
// and approves a browser with its token alone, through /api/esync/<op>.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { Space } from '../src/accounts/space.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';
import * as E from '../public/eden/eden-crypto.js';
import { makeVector } from '../scripts/eden-sync-vector.mjs';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VECTOR = JSON.parse(fs.readFileSync(path.resolve(SITE, '..', 'companion', 'Tests', 'Fixtures', 'eden-sync-vector.json'), 'utf8'));
const ORIGIN = 'https://askeden.com';
const A = '11111111-1111-4111-8111-111111111111';

/** A private key from the vector's raw bytes, as Web Crypto holds one. */
async function privateOf(alg, b64, publicB64) {
  const d = Buffer.from(b64, 'base64');
  if (alg === 'x25519') {
    const der = Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), d]);
    return crypto.subtle.importKey('pkcs8', der, { name: 'X25519' }, false, ['deriveBits']);
  }
  const pub = Buffer.from(publicB64, 'base64');
  const jwk = { kty: 'EC', crv: 'P-256', d: d.toString('base64url'), x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') };
  return crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}

test('vector: what the browser sealed and what an app seals both open with eden-crypto.js', async () => {
  const secret = E.unb64(VECTOR.secret);
  assert.equal(await E.proofOf(secret), VECTOR.proof);
  for (const alg of ['x25519', 'p256']) {
    const v = VECTOR[alg];
    const me = await privateOf(alg, v.private, v.public);
    assert.equal(await E.verifyCode(v.public), v.code);
    for (const s of [v.browser_sealed, v.app_sealed]) assert.deepEqual(await E.openSealed(me, alg, s.sealed_key, s.sender_key), secret);
  }
  assert.deepEqual(await E.unwrapWithPassphrase(VECTOR.passphrase.passphrase, VECTOR.passphrase.wrap), secret);
  // A key change: the macs the apps send, and the chain link they open to check the new key.
  const rot = VECTOR.rotation;
  for (const alg of ['x25519', 'p256']) assert.equal(await E.memberMac(secret, alg, VECTOR[alg].public), rot.mac[alg]);
  assert.equal(await E.memberMac(E.unb64(rot.next), 'x25519', VECTOR.x25519.public), rot.next_mac.x25519);
  assert.deepEqual(await E.followRekey(E.unb64(rot.next), rot.epoch, rot.chain, rot.gen, secret, 1), []);
  // The fixed-key seals are made again byte for byte (what the apps must match).
  const again = await makeVector();
  for (const alg of ['x25519', 'p256']) {
    assert.deepEqual(again[alg].app_sealed, VECTOR[alg].app_sealed);
    assert.equal(again[alg].public, VECTOR[alg].public);
  }
});

// ── an app through the Worker ──

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

const browser = async (name) => (await call(env, A, 'web-signin', { account_id: A, create: true, device: { name } })).token;
const phone = async (name = 'Bilel’s iPhone') => (await call(env, A, 'signin', { account_id: A, device: { name, kind: 'iphone' } })).token;

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

test('apps: the iPhone joins with its token (a browser approves it), then approves a new browser', async () => {
  // A browser turns Eden sync on.
  const first = { session: await browser('Eden on the web: Chrome on a Mac') };
  const secret = E.newSecret();
  const fp = await E.deviceKeyPair('x25519');
  const init = await as(first, '/init', { gen: 'gen-abcdef12', proof: await E.proofOf(secret), keycheck: await E.sealItem(await E.itemKey(secret), 'eden/keycheck', { v: 1 }), wrap: null, public_key: fp.public, alg: fp.alg });
  assert.equal(init.status, 200);
  // The iPhone asks with its own X25519 key (here the vector's): the browser sees it, named and with the same code.
  const app = { token: await phone() };
  const v = VECTOR.x25519;
  assert.equal((await as(app, '/request', { public_key: v.public, alg: 'x25519' })).status, 200);
  const seen = (await as(first, '')).body.requests;
  assert.equal(seen.length, 1);
  assert.deepEqual([seen[0].name, seen[0].kind, await E.verifyCode(seen[0].public_key)], ['Bilel’s iPhone', 'iphone', v.code]);
  const sealed = await E.sealTo(seen[0].public_key, seen[0].alg, secret);
  assert.equal((await as(first, '/approve', { device_id: seen[0].device_id, public_key: seen[0].public_key, ...sealed })).status, 200);
  // The iPhone opens it with its private key, proves it, and is trusted.
  const got = (await as(app, '/poll', {})).body;
  assert.equal(got.status, 'approved');
  const opened = await E.openSealed(await privateOf('x25519', v.private), 'x25519', got.sealed_key, got.sender_key);
  assert.deepEqual(opened, secret);
  assert.equal((await as(app, '/prove', { proof: await E.proofOf(opened), public_key: v.public, alg: 'x25519', via: 'approved' })).status, 200);
  const mine = (await as(app, '')).body;
  assert.equal(mine.me.trusted, true);
  assert.ok(mine.trusted.some((t) => t.kind === 'iphone' && t.this));
  // A new browser asks; the iPhone (trusted) sees it and seals the key to it.
  const second = { session: await browser('Eden on the web: Safari on an iPhone') };
  const sp = await E.deviceKeyPair('p256');
  await as(second, '/request', { public_key: sp.public, alg: sp.alg });
  const waiting = (await as(app, '')).body.requests;
  assert.equal(waiting.length, 1);
  assert.equal(await E.verifyCode(waiting[0].public_key), await E.verifyCode(sp.public));
  // A key swapped after the code was compared is refused; the one compared goes through.
  const evil = await E.deviceKeyPair('p256');
  const toSecond = await E.sealTo(waiting[0].public_key, 'p256', opened);
  assert.equal((await as(app, '/approve', { device_id: waiting[0].device_id, public_key: evil.public, ...toSecond })).status, 409);
  assert.equal((await as(app, '/approve', { device_id: waiting[0].device_id, public_key: waiting[0].public_key, ...toSecond })).status, 200);
  const done = (await as(second, '/poll', {})).body;
  assert.deepEqual([done.status, done.by], ['approved', 'Bilel’s iPhone']);
  assert.deepEqual(await E.openSealed(sp.privateKey, done.alg, done.sealed_key, done.sender_key), secret);
  // An app that hasn't proved the key can't approve anything.
  const other = { token: await phone('iPad') };
  assert.equal((await as(other, '/approve', { device_id: waiting[0].device_id, public_key: waiting[0].public_key, ...toSecond })).status, 403);
});
