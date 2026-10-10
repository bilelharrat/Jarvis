// Shared chats (askeden ROADMAP Q3, accounts/shared-chats.js): a read-only link to messages an
// owner picked, at /s/<id>#<key>. The browser encrypts the snapshot; askeden.com keeps only
// ciphertext (the key stays in the link's #fragment), serves it to anyone with the link, never
// indexes it, and deletes it on revoke, expiry or account deletion.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { SHARED, SHARED_CSP, SHARED_FILES, newSharedId, validSharedId } from '../src/accounts/shared-chats.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Link, appleJwk, identityToken, namespace } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';

let env;
let waits;
let calls;
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;

function makeEnv() {
  const e = { ANTHROPIC_API_KEY: 'sk-test', TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '20' };
  e.ACCOUNTS = namespace(Account, e);
  e.LINKS = namespace(Link, e);
  e.ASSETS = { fetch: async (req) => new Response(`asset ${new URL(req.url).pathname}`, { headers: { 'content-type': 'text/html' } }) };
  return e;
}

beforeEach(() => {
  waits = [];
  calls = [];
  forgetAppleKeys();
  forgetSessions();
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    throw new Error(`unexpected fetch ${url}`);
  };
  env = makeEnv();
});

after(() => {
  globalThis.fetch = realFetch;
});

async function hit(p, { method = 'GET', body, headers = {}, session, token, browser = true } = {}) {
  const h = { ...headers };
  if (browser) {
    h['user-agent'] ??= SAFARI;
    if (method !== 'GET' && method !== 'HEAD') h.origin ??= ORIGIN;
  }
  if (session) h.cookie = `__Host-eden=${session}`;
  if (token) h.authorization = `Bearer ${token}`;
  const init = { method, headers: h };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    h['content-type'] ??= 'application/json';
  }
  const response = await worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx);
  while (waits.length) await Promise.all(waits.splice(0));
  return response;
}

const cookieValue = (response, name) => {
  const found = (response.headers.getSetCookie ? response.headers.getSetCookie() : []).find((c) => c.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1).split(';')[0] : undefined;
};

async function phone(sub = 'apple-user-1') {
  const response = await hit('/api/account/apple', {
    method: 'POST',
    browser: false,
    body: { identity_token: await identityToken({ sub }), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } },
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

async function browserOf(owner) {
  const started = await hit('/api/web/link', { method: 'POST', body: {} });
  const link = await started.json();
  const linkCookie = `__Host-eden-link=${cookieValue(started, '__Host-eden-link')}`;
  assert.equal((await hit(`/api/link/${link.code}/approve`, { method: 'POST', browser: false, token: owner.token, body: { sealed_key: null, sender_key: null } })).status, 200);
  const done = await hit('/api/web/link/poll', { method: 'POST', body: {}, headers: { cookie: linkCookie } });
  return cookieValue(done, '__Host-eden');
}

const chat = (p, session, opts = {}) => hit(p, { session, ...opts, headers: { 'x-jarvis-chat': '1', ...(opts.headers || {}) } });
const share = (session, body) => chat('/api/chat/share', session, { method: 'POST', body });
// What the page sends: { v: 1, iv, ct } (AES-GCM; here just base64url bytes: the server can't tell, and mustn't need to).
const BLOB = JSON.stringify({ v: 1, iv: 'AAECAwQFBgcICQoL', ct: 'c2VhbGVkLWNoYXQtYnl0ZXMtbm90LXJlYWRhYmxl' });

test('share: anyone with the link gets the page and the ciphertext; no sign-in, noindex, the account never in the link', async () => {
  const owner = await phone();
  const me = await browserOf(owner);
  const made = await share(me, { blob: BLOB, expires: null });
  assert.equal(made.status, 200, await made.clone().text());
  const s = await made.json();
  assert.ok(validSharedId(s.id));
  assert.deepEqual(Object.keys(s).sort(), ['bytes', 'created', 'expires', 'id', 'url']);
  assert.equal(s.url, `/s/${s.id}`);
  assert.equal(s.expires, null);
  assert.ok(!s.url.includes(owner.account.id));

  const page = await hit(s.url); // signed out
  assert.equal(page.status, 200);
  assert.equal(await page.text(), 'asset /eden/share');
  assert.equal(page.headers.get('content-security-policy'), SHARED_CSP);
  assert.match(page.headers.get('x-robots-tag'), /noindex/);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.headers.get('cache-control'), 'no-store');

  const data = await hit(`${s.url}/data`);
  assert.equal(data.status, 200);
  assert.deepEqual(await data.json(), { blob: BLOB, created: s.created, expires: null });
  assert.match(data.headers.get('x-robots-tag'), /noindex/);
  assert.equal(data.headers.get('cache-control'), 'no-store');

  // The page's own files are public; nothing else of Eden's is reachable this way.
  for (const f of SHARED_FILES) {
    const r = await hit(`/s/${f}`);
    assert.equal(r.status, 200, f);
    assert.equal(await r.text(), `asset /eden/${f}`);
  }
  assert.notEqual((await hit('/s/app.js')).status, 200);
  assert.notEqual((await hit('/s/account.js')).status, 200);
  assert.ok(!calls.some((u) => u.includes('anthropic')), 'sharing spends no AI');
});

test('listed and revoked by the owner only; revoked means gone at once, pieces and index too', async () => {
  const owner = await phone();
  const me = await browserOf(owner);
  const a = await (await share(me, { blob: BLOB })).json();
  const b = await (await share(me, { blob: BLOB, expires: Date.now() + 864e5 })).json();
  const list = await (await chat('/api/chat/shares', me)).json();
  assert.equal(list.max, SHARED.max);
  assert.deepEqual(list.shares.map((x) => x.id).sort(), [a.id, b.id].sort());
  assert.ok(!JSON.stringify(list).includes('c2VhbGVk'), 'the list never carries the content');

  const stranger = await browserOf(await phone('apple-user-2'));
  assert.deepEqual((await (await chat('/api/chat/shares', stranger)).json()).shares, []);
  assert.equal((await chat('/api/chat/shares/revoke', stranger, { method: 'POST', body: { id: a.id } })).status, 404);
  assert.equal((await hit(`${a.url}/data`)).status, 200);

  const gone = await chat('/api/chat/shares/revoke', me, { method: 'POST', body: { id: a.id } });
  assert.deepEqual(await gone.json(), { id: a.id, revoked: true });
  const after = await hit(`${a.url}/data`);
  assert.equal(after.status, 404);
  assert.match((await after.json()).error, /revoked/);
  assert.equal((await hit(a.url)).status, 200, 'the page itself loads and says it’s gone');
  assert.equal(await env.ACCOUNTS.objects.get(`shr:${a.id}`).storage.get('shrindex'), undefined, 'the index entry goes too');
  const account = env.ACCOUNTS.objects.get(owner.account.id);
  assert.equal([...account.storage.map.keys()].filter((k) => k.includes(a.id)).length, 0, 'its pieces go');
  assert.equal((await chat('/api/chat/shares/revoke', me, { method: 'POST', body: { id: a.id } })).status, 404);
});

test('expiry: the link stops working when it expires, and the share is deleted', async () => {
  const owner = await phone();
  const me = await browserOf(owner);
  const s = await (await share(me, { blob: BLOB, expires: Date.now() + 3_600_000 })).json();
  assert.equal((await hit(`${s.url}/data`)).status, 200);
  const account = env.ACCOUNTS.objects.get(owner.account.id);
  const real = account.now;
  account.now = () => real() + 2 * 3_600_000;
  assert.equal((await hit(`${s.url}/data`)).status, 404);
  assert.equal([...account.storage.map.keys()].filter((k) => k.includes(s.id)).length, 0);
  assert.equal(await env.ACCOUNTS.objects.get(`shr:${s.id}`).storage.get('shrindex'), undefined);
  assert.deepEqual((await (await chat('/api/chat/shares', me)).json()).shares, []);
  account.now = real;
  assert.equal((await share(me, { blob: BLOB, expires: Date.now() - 1 })).status, 400, 'not in the past');
  assert.equal((await share(me, { blob: BLOB, expires: Date.now() + 400 * 864e5 })).status, 400, 'at most a year');
});

test('only ciphertext is accepted; size and count caps; bad ids are "not here"; the API needs sign-in, its header and same origin', async () => {
  const owner = await phone();
  const me = await browserOf(owner);
  assert.equal((await share(me, { blob: '{"v":1,"iv":"x","ct":"plain text"}' })).status, 400);
  assert.equal((await share(me, { blob: 'Hello, plaintext' })).status, 400);
  assert.equal((await share(me, { blob: { v: 1 } })).status, 400);
  assert.equal((await share(me, { blob: JSON.stringify({ v: 1, iv: 'AAECAwQFBgcICQoL', ct: 'A'.repeat(SHARED.blobChars) }) })).status, 413);
  const big = JSON.stringify({ v: 1, iv: 'AAECAwQFBgcICQoL', ct: 'B'.repeat(1_000_000) });
  const s = await (await share(me, { blob: big })).json();
  assert.equal((await (await hit(`${s.url}/data`)).json()).blob, big, 'reassembled from its pieces');
  for (const p of ['/s/short/data', `/s/${'a'.repeat(23)}/data`, `/s/${newSharedId()}/data`, '/s/..%2f../data']) assert.notEqual((await hit(p)).status, 200, p);

  assert.equal((await hit('/api/chat/share', { method: 'POST', body: { blob: BLOB }, headers: { 'x-jarvis-chat': '1' } })).status, 401, 'signed out');
  assert.equal((await hit('/api/chat/share', { method: 'POST', session: me, body: { blob: BLOB } })).status, 403, 'no X-Jarvis-Chat');
  assert.equal((await hit('/api/chat/share', { method: 'POST', session: me, body: { blob: BLOB }, headers: { 'x-jarvis-chat': '1', origin: 'https://evil.example' } })).status, 403);
  // The index ops refuse to run on a real account's object; the owner ops need the device's credentials.
  assert.equal((await env.ACCOUNTS.get(owner.account.id).fetch('https://account/share-index-claim', { method: 'POST', body: JSON.stringify({ account: 'x' }) })).status, 400);
  assert.equal((await env.ACCOUNTS.get(owner.account.id).fetch('https://account/share-list', { method: 'POST', body: '{}' })).status, 401);
});

test('an account keeps at most SHARED.max links; a refused one leaves no index behind', async () => {
  const owner = await phone();
  const me = await browserOf(owner);
  for (let i = 0; i < SHARED.max; i++) assert.equal((await share(me, { blob: BLOB })).status, 200);
  const full = await share(me, { blob: BLOB });
  assert.equal(full.status, 409);
  assert.equal((await full.json()).code, 'too_many');
  const indexes = [...env.ACCOUNTS.objects.entries()].filter(([k, o]) => k.startsWith('shr:') && o.storage.map.has('shrindex'));
  assert.equal(indexes.length, SHARED.max);
});
