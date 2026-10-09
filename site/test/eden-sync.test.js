// Eden sync (H1), delegated access (H14) and team spaces (G8): the browser's own crypto
// (public/eden/eden-crypto.js, the copy scripts/sync-eden.mjs makes of web/chat) round trips,
// the server's boundaries (a browser still can't touch the apps' sync; only a trusted device
// reads or writes Eden's items; a delegate or space member can only chat, within its pool),
// revocation, and the Durable Object migrations.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { Space } from '../src/accounts/space.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Identity, Link, claudeAnswer, namespace, rateLimiter, readEvents, sseBody } from './fakes.js';
import * as E from '../public/eden/eden-crypto.js';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://askeden.com';
const A = '11111111-1111-4111-8111-111111111111'; // the owner
const B = '22222222-2222-4222-8222-222222222222'; // a delegate, a space member
const C = '33333333-3333-4333-8333-333333333333'; // someone else

let env;
let waits;
let anthropic;
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;

beforeEach(() => {
  waits = [];
  forgetSessions();
  anthropic = () => new Response(sseBody(claudeAnswer({ model: 'claude-sonnet-5-5', input: 1000, output: 2000 })), { headers: { 'content-type': 'text/event-stream' } });
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://api.anthropic.com/v1/messages') return anthropic(JSON.parse(init.body));
    throw new Error(`unexpected fetch ${url}`);
  };
  env = { ANTHROPIC_API_KEY: 'sk-test', TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '20', LINK_RATE: rateLimiter(), API_RATE: rateLimiter(), EDEN_RATE: rateLimiter() };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.IDENTITIES = namespace(Identity, env);
  env.SPACES = namespace(Space, env);
  env.ASSETS = { fetch: async () => new Response('asset') };
});

after(() => {
  globalThis.fetch = realFetch;
});

async function settle() {
  while (waits.length) await Promise.all(waits.splice(0));
}

/** A browser of an account (its session token), as the web sign-in makes one. */
const browser = async (account, name = 'Eden on the web: Chrome on a Mac') => (await call(env, account, 'web-signin', { account_id: account, create: true, device: { name } })).token;
const iphone = async (account) => (await call(env, account, 'signin', { account_id: account, device: { name: 'iPhone', kind: 'iphone' } })).token;
const plus = (account) => env.ACCOUNTS.objects.get(account).storage.put('plan', { product_id: 'com.askeden.jarvis.plus.monthly', expires: Date.now() + 30 * 86400_000 });

async function hit(p, { method = 'GET', body, session, acting, token, headers = {} } = {}) {
  const h = { 'user-agent': 'Mozilla/5.0 Chrome/140', 'x-jarvis-chat': '1', ...headers };
  if (method !== 'GET') h.origin ??= ORIGIN;
  const jar = [];
  if (session) jar.push(`__Host-eden=${session}`);
  if (acting) jar.push(`__Host-eden-as=${acting}`);
  if (jar.length) h.cookie = jar.join('; ');
  if (token) h.authorization = `Bearer ${token}`;
  const init = { method, headers: h };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  const response = await worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx);
  await settle();
  return response;
}

const post = (p, body, opts = {}) => hit(p, { method: 'POST', body, ...opts });
const cookieOf = (response, name) => {
  const c = response.headers.getSetCookie().find((x) => x.startsWith(`${name}=`));
  return c ? c.slice(name.length + 1).split(';')[0] : undefined;
};

// ── the browser's crypto ──

test('crypto: X25519 and P-256 sealing round-trips, and only the right key opens it', async () => {
  for (const alg of ['x25519', 'p256']) {
    const me = await E.deviceKeyPair(alg);
    const other = await E.deviceKeyPair(alg);
    assert.equal(me.alg, alg);
    assert.equal(E.unb64(me.public).length, alg === 'x25519' ? 32 : 65);
    const secret = E.newSecret();
    const sealed = await E.sealTo(me.public, alg, secret);
    assert.deepEqual(await E.openSealed(me.privateKey, alg, sealed.sealed_key, sealed.sender_key), secret);
    await assert.rejects(E.openSealed(other.privateKey, alg, sealed.sealed_key, sealed.sender_key), /didn’t open/);
    // Another label (a space's key) doesn't open as a sync key.
    await assert.rejects(E.openSealed(me.privateKey, alg, sealed.sealed_key, sealed.sender_key, E.SPACE_SEAL_LABEL), /didn’t open/);
    await assert.rejects(E.sealTo(me.public.slice(4), alg, secret), /isn’t a device key/);
  }
  // The private half is non-extractable.
  const pair = await E.deviceKeyPair();
  assert.equal(pair.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('pkcs8', pair.privateKey));
});

test('crypto: items open only with their key and their own item key; big ones are compressed', async () => {
  const secret = E.newSecret();
  const key = await E.itemKey(secret);
  const conv = { v: 1, conv: { id: 'c0123456789abcdef', title: 'Trip', nodes: { m1: { role: 'user', content: 'x'.repeat(5000) } } } };
  const data = await E.sealItem(key, 'eden/conv.c0123456789abcdef', conv);
  assert.ok(data.length < 2000, 'gzip makes repeated text small');
  assert.deepEqual(await E.openItem(key, 'eden/conv.c0123456789abcdef', data), conv);
  await assert.rejects(E.openItem(key, 'eden/conv.other', data), /wrong key/);
  await assert.rejects(E.openItem(await E.itemKey(E.newSecret()), 'eden/conv.c0123456789abcdef', data), /wrong key/);
  const small = await E.sealItem(key, 'eden/keycheck', { v: 1 });
  assert.deepEqual(await E.openItem(key, 'eden/keycheck', small), { v: 1 });
  assert.notEqual(await E.sealItem(key, 'eden/keycheck', { v: 1 }), small, 'a fresh nonce each time');
  assert.equal((await E.proofOf(secret)).length, 43);
  assert.notEqual(await E.proofOf(secret), await E.proofOf(secret, E.SPACE_LABEL));
});

test('crypto: the recovery passphrase wraps the key (PBKDF2), and a wrong one fails', async () => {
  const secret = E.newSecret();
  const wrap = await E.wrapWithPassphrase('correct horse battery staple', secret);
  assert.equal(wrap.iterations, E.PBKDF2_ROUNDS);
  assert.equal(wrap.kdf, 'PBKDF2-SHA256');
  assert.deepEqual(await E.unwrapWithPassphrase('correct horse battery staple', wrap), secret);
  await assert.rejects(E.unwrapWithPassphrase('wrong horse battery staple', wrap), /wrong passphrase/);
  await assert.rejects(E.unwrapWithPassphrase('x', { ...wrap, iterations: 1000 }), /unknown wrap/);
  assert.match(E.passphraseProblem('short'), /12 characters/);
  assert.match(E.passphraseProblem('aaaaaaaaaaaaaaaa'), /different/);
  assert.equal(E.passphraseProblem(E.suggestPassphrase()), '');
  assert.match(E.suggestPassphrase(), /^([0-9A-Z]{5}-){4}[0-9A-Z]{5}$/);
  assert.match(await E.verifyCode('AAAA'), /^\d{3} \d{3}$/);
  assert.equal(await E.verifyCode('AAAA'), await E.verifyCode('AAAA'));
});

// ── Eden sync on the server ──

/** Turns sync on in a browser: { secret, key, pair, gen }. */
async function turnOn(session, { passphrase = 'a long recovery passphrase' } = {}) {
  const pair = await E.deviceKeyPair('x25519');
  const secret = E.newSecret();
  const key = await E.itemKey(secret);
  const gen = 'gen-abcdef12';
  const r = await post('/api/web/esync/init', {
    gen,
    proof: await E.proofOf(secret),
    keycheck: await E.sealItem(key, 'eden/keycheck', { v: 1, check: 'eden-sync-v1', gen }),
    wrap: passphrase ? await E.wrapWithPassphrase(passphrase, secret, 310_000) : null,
    public_key: pair.public,
    alg: pair.alg,
  }, { session });
  assert.equal(r.status, 200, await r.clone().text());
  return { secret, key, pair, gen };
}

test('sync: browsers still may not touch the apps’ sync, and Eden’s space needs a trusted device', async () => {
  const s1 = await browser(A);
  for (const [method, p] of [['GET', '/api/sync'], ['PUT', '/api/sync/memory'], ['DELETE', '/api/sync']]) {
    const r = await hit(p, { method, token: s1, body: method === 'PUT' ? { data: 'AAAA', base_rev: 0 } : undefined, headers: { origin: undefined } });
    assert.equal(r.status, 403, `${method} ${p}`);
  }
  const status = await (await hit('/api/web/esync', { session: s1 })).json();
  assert.equal(status.key, null);
  assert.equal((await post('/api/web/esync/pull', { since: 0 }, { session: s1 })).status, 409);
  const { key } = await turnOn(s1);
  // Trusted: write, read; keys outside eden/ and the key check itself are refused.
  const data = await E.sealItem(key, 'eden/conv.c1', { v: 1, conv: { id: 'c1' } });
  const pushed = await (await post('/api/web/esync/push', { items: [
    { key: 'eden/conv.c1', data, base_rev: 0 },
    { key: 'memory', data, base_rev: 0 },
    { key: 'eden/keycheck', data, base_rev: 1 },
  ] }, { session: s1 })).json();
  assert.equal(pushed.results[0].rev, 2);
  assert.equal(pushed.results[1].code, 'bad_request');
  assert.equal(pushed.results[2].code, 'forbidden');
  // A second browser of the same account is signed in but not trusted.
  const s2 = await browser(A, 'Eden on the web: Safari on an iPhone');
  assert.equal((await post('/api/web/esync/pull', { since: 0 }, { session: s2 })).status, 403);
  assert.equal((await post('/api/web/esync/push', { items: [{ key: 'eden/conv.c2', data, base_rev: 0 }] }, { session: s2 })).status, 403);
  // The server holds only sealed base64: nothing of the conversation in the clear.
  const stored = JSON.stringify([...env.ACCOUNTS.objects.get(A).storage.map.entries()]);
  assert.ok(!stored.includes('conv":{"id'), 'no plaintext');
  // Another account sees nothing of it.
  const other = await browser(C);
  assert.equal((await (await hit('/api/web/esync', { session: other })).json()).key, null);
});

test('sync: "Trust this browser" seals the key to the new browser; the codes match; conflicts and tombstones', async () => {
  const s1 = await browser(A);
  const { secret, key } = await turnOn(s1);
  const s2 = await browser(A, 'Eden on the web: Safari on an iPhone');
  const pair2 = await E.deviceKeyPair('p256');
  const asked = await (await post('/api/web/esync/request', { public_key: pair2.public, alg: pair2.alg }, { session: s2 })).json();
  assert.equal(asked.status, 'waiting');
  // The trusted browser sees the request (and its key) and shows the same code.
  const st = await (await hit('/api/web/esync', { session: s1 })).json();
  assert.equal(st.requests.length, 1);
  const req = st.requests[0];
  assert.equal(await E.verifyCode(req.public_key), await E.verifyCode(pair2.public));
  // An untrusted browser can't approve, and nothing waits for it to see.
  assert.equal((await (await hit('/api/web/esync', { session: s2 })).json()).requests.length, 0);
  const sealed = await E.sealTo(req.public_key, req.alg, secret);
  assert.equal((await post('/api/web/esync/approve', { device_id: req.device_id, public_key: req.public_key, ...sealed }, { session: s2 })).status, 403);
  // A swapped key is refused.
  const evil = await E.deviceKeyPair('p256');
  assert.equal((await post('/api/web/esync/approve', { device_id: req.device_id, public_key: evil.public, ...sealed }, { session: s1 })).status, 409);
  assert.equal((await post('/api/web/esync/approve', { device_id: req.device_id, public_key: req.public_key, ...sealed }, { session: s1 })).status, 200);
  const got = await (await post('/api/web/esync/poll', {}, { session: s2 })).json();
  assert.equal(got.status, 'approved');
  const opened = await E.openSealed(pair2.privateKey, got.alg, got.sealed_key, got.sender_key);
  assert.deepEqual(opened, secret);
  // A wrong proof doesn't make it trusted; the right one does.
  assert.equal((await post('/api/web/esync/prove', { proof: await E.proofOf(E.newSecret()), public_key: pair2.public, alg: pair2.alg }, { session: s2 })).status, 403);
  assert.equal((await post('/api/web/esync/prove', { proof: await E.proofOf(opened), public_key: pair2.public, alg: pair2.alg }, { session: s2 })).status, 200);
  // Both write the same conversation: the second gets a conflict with the first's copy.
  const key2 = await E.itemKey(opened);
  await post('/api/web/esync/push', { items: [{ key: 'eden/conv.c9', data: await E.sealItem(key, 'eden/conv.c9', { v: 1, t: 'one' }), base_rev: 0 }] }, { session: s1 });
  const clash = await (await post('/api/web/esync/push', { items: [{ key: 'eden/conv.c9', data: await E.sealItem(key2, 'eden/conv.c9', { v: 1, t: 'two' }), base_rev: 0 }] }, { session: s2 })).json();
  assert.ok(clash.results[0].conflict);
  assert.deepEqual(await E.openItem(key2, 'eden/conv.c9', clash.results[0].conflict.data), { v: 1, t: 'one' });
  // A delete is a tombstone the other browser pulls.
  const del = await (await post('/api/web/esync/push', { items: [{ key: 'eden/conv.c9', deleted: true, base_rev: clash.results[0].conflict.rev }] }, { session: s2 })).json();
  assert.ok(del.results[0].rev);
  const pulled = await (await post('/api/web/esync/pull', { since: 0 }, { session: s1 })).json();
  const c9 = pulled.items.find((i) => i.key === 'eden/conv.c9');
  assert.equal(c9.deleted, true);
  assert.equal(c9.data, null);
  // Untrusting a browser ends its access.
  await post('/api/web/esync/untrust', { device_id: req.device_id }, { session: s1 });
  assert.equal((await post('/api/web/esync/pull', { since: 0 }, { session: s2 })).status, 403);
});

test('sync: the recovery passphrase unlocks a browser with no other device; caps hold', async () => {
  const s1 = await browser(A);
  const { secret } = await turnOn(s1, { passphrase: 'a long recovery passphrase' });
  const s2 = await browser(A, 'Eden on the web: Firefox on Windows');
  const { wrap } = await (await post('/api/web/esync/unwrap', {}, { session: s2 })).json();
  await assert.rejects(E.unwrapWithPassphrase('not the passphrase!!', wrap));
  const back = await E.unwrapWithPassphrase('a long recovery passphrase', wrap);
  assert.deepEqual(back, secret);
  const pair = await E.deviceKeyPair();
  assert.equal((await post('/api/web/esync/prove', { proof: await E.proofOf(back), public_key: pair.public, alg: pair.alg, via: 'passphrase' }, { session: s2 })).status, 200);
  // Weak wraps are refused by the server too.
  const weak = await E.wrapWithPassphrase('a long recovery passphrase', secret, 100_000);
  assert.equal((await post('/api/web/esync/wrap', { proof: await E.proofOf(secret), wrap: weak }, { session: s2 })).status, 400);
  // Too big an item.
  const huge = 'A'.repeat(700_004);
  const big = await (await post('/api/web/esync/push', { items: [{ key: 'eden/conv.big', data: huge, base_rev: 0 }] }, { session: s2 })).json();
  assert.equal(big.results[0].code, 'too_big');
  // A second init is refused; start over wipes it all.
  assert.equal((await post('/api/web/esync/init', {}, { session: s2 })).status, 409);
  assert.equal((await post('/api/web/esync/wipe', {}, { session: s1 })).status, 200);
  assert.equal((await (await hit('/api/web/esync', { session: s1 })).json()).key, null);
});

test('sync: the apps reach the same ops with their token', async () => {
  const phone = await iphone(A);
  const r = await hit('/api/esync', { token: phone, headers: { origin: undefined, 'x-jarvis-chat': undefined } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).key, null);
});

// ── delegates ──

async function delegate({ cap = 1, features = ['chat'] } = {}) {
  const owner = await browser(A);
  await iphone(A); // the owner's account exists with its app
  const inv = await (await post('/api/web/deleg/invite', { name: 'Sam', from: 'Bilel', cap_usd: cap, features, days: 30 }, { session: owner })).json();
  assert.match(inv.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(inv.link, `${ORIGIN}/#delegate=${inv.code}`);
  const sam = await browser(B);
  const accepted = await (await post('/api/web/deleg/accept', { code: inv.code.toLowerCase() }, { session: sam })).json();
  assert.equal(accepted.accepted.from, 'Bilel');
  const mine = await (await hit('/api/web/deleg', { session: sam })).json();
  assert.equal(mine.mine.length, 1);
  const use = await post('/api/web/deleg/use', { id: mine.mine[0].id }, { session: sam });
  assert.equal(use.status, 200, await use.clone().text());
  const acting = cookieOf(use, '__Host-eden-as');
  assert.ok(acting);
  return { owner, sam, acting, id: inv.delegate.id, code: inv.code };
}

test('delegates: the code is single use, never your own, and the delegate sees only their limit', async () => {
  const { owner, sam, acting, code } = await delegate();
  assert.equal((await post('/api/web/deleg/accept', { code }, { session: await browser(C) })).status, 404, 'used');
  const inv2 = await (await post('/api/web/deleg/invite', { name: 'Me', cap_usd: 1, days: 7 }, { session: owner })).json();
  assert.equal((await post('/api/web/deleg/accept', { code: inv2.code }, { session: owner })).status, 409);
  const session = await (await hit('/api/web/session', { session: sam, acting })).json();
  assert.equal(session.acting.type, 'delegate');
  assert.equal(session.acting.label, 'Bilel');
  assert.equal(session.usage.budget_usd, 1);
  // The account page stays the delegate's own account.
  const page = await (await hit('/api/web/account', { session: sam, acting })).json();
  assert.equal(page.account_id, B);
  assert.equal(page.acting.type, 'delegate');
  // The owner lists them; their session isn't one of the owner's browsers.
  const listed = await (await hit('/api/web/deleg', { session: owner })).json();
  assert.equal(listed.delegates[0].status, 'active');
  const ownerPage = await (await hit('/api/web/account', { session: owner })).json();
  assert.ok(ownerPage.devices.every((d) => !/^Delegate/.test(d.name)));
});

test('delegates: server-enforced: chat only, never account settings, devices, sign-in methods, sync or the Mac', async () => {
  const { sam, acting } = await delegate();
  const token = (raw) => {
    const [, account, device, secret] = raw.split('.');
    return { account, device, secret };
  };
  const t = token(acting);
  for (const op of ['browsers-signout', 'identity-unlink', 'device-update', 'voice', 'esync-status', 'deleg-list', 'web-status', 'pub-list', 'task-list', 'google-save', 'google-get', 'add-device']) {
    await assert.rejects(call(env, A, op, { eden: true, all: true }, t), (e) => e.status === 403, op);
  }
  // Allowed: meta and the routing preview; refused: publishing, tasks, the Mac's Jarvis.
  const meta = await hit('/api/chat/meta', { session: sam, acting });
  assert.equal(meta.status, 200);
  // The owner's Mac is never offered to the delegate: no Jarvis, no Code (the page hides them).
  const m = await meta.json();
  assert.equal(m.jarvis.available, false);
  assert.equal(m.code.available, false);
  assert.match(m.jarvis.reason, /someone else’s Eden/);
  const status = await (await hit('/api/chat/jarvis/status', { session: sam, acting })).json();
  assert.deepEqual(status, { available: false, reason: m.jarvis.reason });
  // Their own published pages stay theirs while acting (listed from their own account).
  assert.equal((await hit('/api/chat/published', { session: sam, acting })).status, 200);
  for (const [method, p] of [['POST', '/api/chat/jarvis'], ['GET', '/api/chat/projects'], ['POST', '/api/chat/tasks'], ['POST', '/api/chat/gmail']]) {
    const r = await hit(p, { method, session: sam, acting, body: method === 'POST' ? {} : undefined });
    assert.equal(r.status, 403, `${method} ${p}`);
    assert.equal((await r.json()).code, 'grant_forbidden');
  }
  // Its own acting session can't be used as a session cookie.
  assert.equal((await hit('/api/web/account', { session: acting })).status, 401);
  // Someone else holding the acting cookie gets their own account, not the grant.
  const other = await browser(C);
  const theirs = await (await hit('/api/web/session', { session: other, acting })).json();
  assert.equal(theirs.acting, null);
  assert.equal(theirs.account_id, C);
});

test('delegates: the monthly cap is enforced on spend, counted per delegate, and mail needs the grant', async () => {
  const { sam, acting, id } = await delegate({ cap: 0.05, features: ['chat', 'mail'] });
  const t = (() => { const [, account, device, secret] = acting.split('.'); return { account, device, secret }; })();
  const allow = await call(env, A, 'allow-ai', { eden: true }, t);
  assert.equal(allow.ok, true);
  assert.equal(allow.left, 0.05);
  assert.match(allow.bucket, new RegExp(`^trial\\|dlg:${id}\\|`));
  // A turn through hosted Eden: spent on the owner's account and on the delegate's pool.
  const r = await post('/api/chat/send', { messages: [{ role: 'user', content: 'Hello there' }], settings: { level: 1 } }, { session: sam, acting });
  const events = await readEvents(r);
  assert.ok(events.some((e) => e.type === 'done'), JSON.stringify(events.slice(-2)));
  const owner = env.ACCOUNTS.objects.get(A).storage;
  const usage = await owner.get('usage');
  const pool = await owner.get(`pool:dlg:${id}`);
  assert.ok(usage.trial_spent > 0);
  assert.equal(pool.spent, usage.trial_spent);
  assert.equal(Object.values(pool.by)[0], pool.spent);
  // Past the cap: refused before anything is sent.
  await call(env, A, 'spend', { usd: 1, bucket: allow.bucket });
  assert.equal((await call(env, A, 'allow-ai', { eden: true }, t)).ok, false);
  const refused = await post('/api/chat/send', { messages: [{ role: 'user', content: 'Again' }] }, { session: sam, acting });
  assert.equal(refused.status, 402);
  // Mail was granted: google-get is reachable (no grant there yet), calendar routes aren't.
  assert.deepEqual(await call(env, A, 'google-get', {}, t), { record: null });
  assert.equal((await hit('/api/chat/gcal/status', { session: sam, acting })).status, 403);
});

test('delegates: revoking ends the session at once, and the delegate falls back to their own account', async () => {
  const { owner, sam, acting, id } = await delegate();
  const t = (() => { const [, account, device, secret] = acting.split('.'); return { account, device, secret }; })();
  assert.equal((await post('/api/web/deleg/revoke', { id }, { session: owner })).status, 200);
  await assert.rejects(call(env, A, 'hold-ai', { eden: true, usd: 0.01 }, t), (e) => e.status === 401);
  const session = await (await hit('/api/web/session', { session: sam, acting })).json();
  assert.equal(session.acting, null);
  assert.equal(session.acting_ended, true);
  assert.equal(session.account_id, B);
  // Hosted Eden refuses, rather than quietly spending the delegate's own allowance.
  const turn = await post('/api/chat/send', { messages: [{ role: 'user', content: 'Hi' }] }, { session: sam, acting });
  assert.equal(turn.status, 403);
  assert.equal((await turn.json()).code, 'grant_ended');
  // Reads go on as the delegate themselves, so the page loads and can switch back.
  assert.equal((await hit('/api/chat/meta', { session: sam, acting })).status, 200);
  assert.equal((await env.ACCOUNTS.objects.get(B).storage.get('usage')), undefined);
  assert.equal((await (await hit('/api/web/deleg', { session: sam })).json()).mine.length, 0);
  // Leaving clears the cookie.
  const left = await post('/api/web/deleg/leave', {}, { session: sam, acting });
  assert.match(left.headers.getSetCookie().join(), /__Host-eden-as=;/);
});

// ── team spaces ──

test('spaces: Plus to create; invite, join, budget per member, removal, and only sealed blobs stored', async () => {
  const owner = await browser(A);
  assert.equal((await post('/api/web/space/create', { name: 'Launch', budget_usd: 2, level: 4 }, { session: owner })).status, 402);
  await plus(A);
  const made = await (await post('/api/web/space/create', { name: 'Launch', budget_usd: 2, level: 4, label: 'Bilel' }, { session: owner })).json();
  const id = made.space.id;
  assert.equal(made.me.role, 'owner');
  assert.equal(made.space.level, 4);
  const { code, link } = await (await post('/api/web/space/invite', { id }, { session: owner })).json();
  assert.equal(link, `${ORIGIN}/#space=${code}`);
  const sam = await browser(B);
  assert.equal((await post('/api/web/space/view', { id }, { session: sam })).status, 404, 'not a member yet');
  const joined = await (await post('/api/web/space/join', { code, label: 'Sam' }, { session: sam })).json();
  assert.equal(joined.joined.name, 'Launch');
  assert.equal((await post('/api/web/space/join', { code }, { session: await browser(C) })).status, 404, 'single use');
  const view = await (await post('/api/web/space/view', { id }, { session: sam })).json();
  assert.equal(view.members.length, 2);
  assert.ok(!JSON.stringify(view).includes(A) && !JSON.stringify(view).includes(B), 'no account ids shown');
  assert.equal((await post('/api/web/space/update', { id, budget_usd: 50 }, { session: sam })).status, 403, 'owner only');
  // Chat in the space: the owner's Plus pays, capped by the space budget, counted per member.
  const use = await post('/api/web/space/use', { id }, { session: sam });
  const acting = cookieOf(use, '__Host-eden-as');
  assert.equal((await use.json()).acting.level, 4);
  const r = await post('/api/chat/send', { messages: [{ role: 'user', content: 'Plan the launch' }] }, { session: sam, acting });
  assert.ok((await readEvents(r)).some((e) => e.type === 'done'));
  const after = await (await post('/api/web/space/view', { id }, { session: owner })).json();
  assert.ok(after.space.spent_usd > 0);
  assert.equal(after.members.find((m) => !m.this).spent_usd, after.space.spent_usd);
  assert.equal((await env.ACCOUNTS.objects.get(A).storage.get('usage')).spent, after.space.spent_usd);
  // The budget runs out: refused.
  await post('/api/web/space/update', { id, budget_usd: 0 }, { session: owner });
  assert.equal((await post('/api/chat/send', { messages: [{ role: 'user', content: 'More' }] }, { session: sam, acting })).status, 402);
  // Shared conversations: only sealed blobs, sealed with a key the server never sees.
  const pair = await E.deviceKeyPair();
  await post('/api/web/space/key-register', { id, public_key: pair.public, alg: pair.alg }, { session: owner });
  const spaceSecret = E.newSecret();
  const self = await E.sealTo(pair.public, pair.alg, spaceSecret, E.SPACE_SEAL_LABEL);
  assert.equal((await post('/api/web/space/key-init', { id, gen: 'space-gen-1', proof: await E.proofOf(spaceSecret, E.SPACE_LABEL), ...self }, { session: owner })).status, 200);
  const samPair = await E.deviceKeyPair('p256');
  await post('/api/web/space/key-register', { id, public_key: samPair.public, alg: samPair.alg }, { session: sam });
  const waiting = (await (await post('/api/web/space/view', { id }, { session: owner })).json()).keys.find((k) => !k.sealed);
  const toSam = await E.sealTo(waiting.public_key, waiting.alg, spaceSecret, E.SPACE_SEAL_LABEL);
  assert.equal((await post('/api/web/space/key-seal', { id, proof: await E.proofOf(spaceSecret, E.SPACE_LABEL), target: `${waiting.member}:${waiting.device}`, public_key: waiting.public_key, ...toSam }, { session: owner })).status, 200);
  const mine = (await (await post('/api/web/space/key-mine', { id }, { session: sam })).json()).sealed;
  const samSecret = await E.openSealed(samPair.privateKey, mine.alg, mine.sealed_key, mine.sender_key, E.SPACE_SEAL_LABEL);
  assert.deepEqual(samSecret, spaceSecret);
  const blob = await E.sealItem(await E.itemKey(spaceSecret), `${id}:launch-plan`, { title: 'Launch plan', text: 'Ship it Tuesday' }, E.SPACE_LABEL);
  assert.equal((await post('/api/web/space/conv-put', { id, conv: 'launch-plan', data: blob, base_rev: 0 }, { session: owner })).status, 200);
  const shared = await (await post('/api/web/space/conv-get', { id, conv: 'launch-plan' }, { session: sam })).json();
  assert.deepEqual(await E.openItem(await E.itemKey(samSecret), `${id}:launch-plan`, shared.data, E.SPACE_LABEL), { title: 'Launch plan', text: 'Ship it Tuesday' });
  const raw = JSON.stringify([...env.SPACES.objects.get(id).storage.map.entries()]);
  assert.ok(!raw.includes('Ship it Tuesday') && !raw.includes('Launch plan'), 'no plaintext in the space');
  // A shared workflow (H9) is the same kind of sealed item, listed apart by its kind.
  const recipe = await E.sealItem(await E.itemKey(samSecret), `${id}:wf-weekly`, { v: 1, kind: 'workflow', workflow: { name: 'Weekly update', template: 'Summarize {project}' } }, E.SPACE_LABEL);
  assert.equal((await post('/api/web/space/conv-put', { id, conv: 'wf-weekly', data: recipe, base_rev: 0, kind: 'workflow' }, { session: sam })).status, 200);
  assert.equal((await post('/api/web/space/conv-put', { id, conv: 'wf-odd', data: recipe, base_rev: 0, kind: 'script' }, { session: sam })).status, 400);
  const kinds = (await (await post('/api/web/space/view', { id }, { session: owner })).json()).convs.map((c) => [c.id, c.kind]).sort();
  assert.deepEqual(kinds, [['launch-plan', 'conv'], ['wf-weekly', 'workflow']]);
  const gotRecipe = await (await post('/api/web/space/conv-get', { id, conv: 'wf-weekly' }, { session: owner })).json();
  assert.equal(gotRecipe.kind, 'workflow');
  assert.equal((await E.openItem(await E.itemKey(spaceSecret), `${id}:wf-weekly`, gotRecipe.data, E.SPACE_LABEL)).workflow.name, 'Weekly update');
  assert.ok(!JSON.stringify([...env.SPACES.objects.get(id).storage.map.entries()]).includes('Weekly update'), 'sealed too');
  // Removing a member ends their space session; deleting the space ends the owner's list entry.
  const samMember = after.members.find((m) => !m.this).member;
  await post('/api/web/space/remove', { id, member: samMember }, { session: owner });
  const t = (() => { const [, account, device, secret] = acting.split('.'); return { account, device, secret }; })();
  await assert.rejects(call(env, A, 'allow-ai', { eden: true }, t), (e) => e.status === 401);
  assert.equal((await (await hit('/api/web/space', { session: sam })).json()).spaces.length, 0);
  await post('/api/web/space/delete', { id }, { session: owner });
  assert.equal((await (await hit('/api/web/space', { session: owner })).json()).spaces.length, 0);
});

// ── the Durable Object migrations ──

test('migrations: v1–v7 in order, Space is new in v4, BrowserSession in v5, Course in v6 and Promo in v7 (SQLite), bound, and exported', async () => {
  const toml = fs.readFileSync(path.join(SITE, 'wrangler.toml'), 'utf8');
  const tags = [...toml.matchAll(/\[\[migrations\]\]\s*\ntag = "(v\d+)"\s*\nnew_sqlite_classes = \[([^\]]*)\]/g)].map((m) => [m[1], m[2].replace(/"/g, '').split(',').map((x) => x.trim())]);
  assert.deepEqual(tags, [['v1', ['VoiceQuota']], ['v2', ['Account', 'Link']], ['v3', ['Identity']], ['v4', ['Space']], ['v5', ['BrowserSession']], ['v6', ['Course']], ['v7', ['Promo']]]);
  assert.ok(!/deleted_classes|renamed_classes/.test(toml), 'no class is ever deleted or renamed');
  assert.match(toml, /name = "SPACES"\s*\nclass_name = "Space"/);
  assert.match(toml, /name = "BROWSER_SESSIONS"\s*\nclass_name = "BrowserSession"/);
  assert.match(toml, /name = "COURSES"\s*\nclass_name = "Course"/);
  assert.match(toml, /name = "PROMOS"\s*\nclass_name = "Promo"/);
  const mod = await import('../src/worker.js');
  assert.equal(mod.Space, Space);
  assert.equal(typeof mod.BrowserSession, 'function');
  assert.equal(typeof mod.Course, 'function');
  assert.equal(typeof mod.Promo, 'function');
});

// ── account deletion: team spaces and delegations ──

test('deleting an account erases its team data: memberships, shared items, owned spaces, invites, delegations', async () => {
  const owner = await browser(A);
  await iphone(A);
  await plus(A);
  const sam = await browser(B);
  const spaceStore = (name) => env.SPACES.objects.get(name).storage;
  const made = await (await post('/api/web/space/create', { name: 'Launch', budget_usd: 2, label: 'Owner' }, { session: owner })).json();
  const id = made.space.id;
  const invite = async () => (await (await post('/api/web/space/invite', { id }, { session: owner })).json()).code;
  const code = await invite();
  assert.equal((await post('/api/web/space/join', { code, label: 'Sam' }, { session: sam })).status, 200);
  const open = await invite(); // an invitation nobody used: its index object lives on
  const { sha256Hex } = await import('../src/accounts/util.js');
  const openIndex = `inv:${await sha256Hex(open)}`;
  assert.ok(env.SPACES.objects.has(openIndex));
  // Sam shares something; Sam also holds a delegation from the owner, and the owner an open delegate invite.
  const pair = await E.deviceKeyPair();
  await post('/api/web/space/key-register', { id, public_key: pair.public, alg: pair.alg }, { session: owner });
  const secret = E.newSecret();
  await post('/api/web/space/key-init', { id, gen: 'space-gen-1', proof: await E.proofOf(secret, E.SPACE_LABEL), ...(await E.sealTo(pair.public, pair.alg, secret, E.SPACE_SEAL_LABEL)) }, { session: owner });
  const put = await post('/api/web/space/conv-put', { id, conv: 'sams-note', data: 'c2VhbGVk', base_rev: 0 }, { session: sam });
  assert.equal(put.status, 200, await put.clone().text());
  const inv = await (await post('/api/web/deleg/invite', { name: 'Sam', from: 'Owner', cap_usd: 1, features: ['chat'], days: 30 }, { session: owner })).json();
  assert.equal((await post('/api/web/deleg/accept', { code: inv.code }, { session: sam })).status, 200);
  const inv2 = await (await post('/api/web/deleg/invite', { name: 'Open', cap_usd: 1, days: 7 }, { session: owner })).json();
  const dinv = `dinv:${await sha256Hex(inv2.code)}`;
  assert.ok(env.ACCOUNTS.objects.has(dinv));

  // Sam (a member, a delegate) deletes the account: gone from the space, their note removed, the owner's delegation ended.
  assert.equal((await post('/api/web/account/delete', { confirm: 'DELETE' }, { session: sam })).status, 204);
  const members = [...(await spaceStore(id).list({ prefix: 'm:' })).values()];
  assert.deepEqual(members.map((m) => m.role), ['owner']);
  assert.equal((await spaceStore(id).get('c:sams-note')).deleted, true);
  assert.equal([...(await env.ACCOUNTS.objects.get(A).storage.list({ prefix: 'dlg:' })).values()].filter((d) => d.delegate === B).length, 0, 'the owner’s record of Sam is gone');

  // The owner deletes theirs: the space, its open invitation index and the open delegate invite go.
  const del = await post('/api/web/account/delete', { confirm: 'DELETE' }, { session: owner });
  assert.equal(del.status, 204, await del.clone().text());
  assert.equal(await spaceStore(id).get('space'), undefined);
  assert.equal([...(await spaceStore(openIndex).list()).keys()].length, 0, 'invitation index erased');
  assert.equal([...(await env.ACCOUNTS.objects.get(dinv).storage.list()).keys()].length, 0, 'delegate invite index erased');
});
