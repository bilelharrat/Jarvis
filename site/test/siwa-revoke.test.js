// Sign in with Apple in the Eden and Edu apps (bug sweep 2026-10-09 C13, App Store 5.1.1(v)): the app's
// authorization code is exchanged with the identity token's `aud` as client_id (and as the client
// secret's `sub`), the refresh token is kept with that client id, and deleting the account revokes it
// with the same id. Apple's endpoints are faked (globalThis.fetch); the SIWA key is a P-256 key made here.

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { exchangeCode, forgetAppleKeys, revoke } from '../src/accounts/apple.js';
import { b64ToBytes, b64urlText, bytesToB64 } from '../src/accounts/util.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Identity, Link, appleJwk, identityToken, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
const ctx = { waitUntil: () => {} };
const realFetch = globalThis.fetch;

const siwa = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const SIWA_KEY = `-----BEGIN PRIVATE KEY-----\n${bytesToB64(new Uint8Array(await crypto.subtle.exportKey('pkcs8', siwa.privateKey)))}\n-----END PRIVATE KEY-----`;

let env;
let apple; // what reached Apple's token and revoke endpoints: { url, form }
let codeOwner; // code → { sub, aud } the faked Apple says it was issued for (else the sub the code names)

/** An id_token as Apple's /auth/token returns it (only its claims are read). */
const idToken = (claims) => `${b64urlText(JSON.stringify({ alg: 'RS256' }))}.${b64urlText(JSON.stringify({ iss: 'https://appleid.apple.com', ...claims }))}.sig`;

function makeEnv(extra = {}) {
  const e = { TRIAL_BUDGET_USD: '1', AUTH_RATE: rateLimiter(), LINK_RATE: rateLimiter(), EDEN_RATE: rateLimiter(), ...extra };
  e.ACCOUNTS = namespace(Account, e);
  e.LINKS = namespace(Link, e);
  e.IDENTITIES = namespace(Identity, e);
  e.ASSETS = { fetch: async () => new Response('asset') };
  return e;
}

beforeEach(() => {
  forgetAppleKeys();
  forgetSessions();
  apple = [];
  codeOwner = new Map();
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    if (url === 'https://appleid.apple.com/auth/token' || url === 'https://appleid.apple.com/auth/revoke') {
      const form = new URLSearchParams(init.body);
      apple.push({ url, form });
      if (url.endsWith('/token')) {
        const owner = codeOwner.get(form.get('code')) || { sub: subOfCode(form.get('code')), aud: form.get('client_id') };
        return Response.json({ access_token: 'at', refresh_token: `rt-for-${form.get('client_id')}`, id_token: idToken(owner) });
      }
      return new Response(null, { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  env = makeEnv({ SIWA_KEY, SIWA_KEY_ID: 'SIWAKEY123' });
});

after(() => {
  globalThis.fetch = realFetch;
});

async function hit(p, { method = 'GET', body, headers = {}, browser = true, session } = {}) {
  const h = { 'cf-connecting-ip': '198.51.100.9', ...headers };
  if (browser) {
    h['user-agent'] ??= SAFARI;
    if (method !== 'GET') h.origin ??= ORIGIN;
  }
  if (session) h.cookie = `__Host-eden=${session}`;
  const init = { method, headers: h };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  return worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx);
}

/** The app's native sign-in, then its web view's handoff: the session cookie. */
async function appSignIn({ sub, aud, code }) {
  if (code) subs.set(code, sub);
  const made = await hit('/api/web/native/apple', { method: 'POST', browser: false, body: { identity_token: await identityToken({ sub, nonce: 'n', aud }), nonce: 'n', ...(code ? { authorization_code: code } : {}) } });
  assert.equal(made.status, 200, await made.clone().text());
  const { handoff } = await made.json();
  const ok = await hit(`/api/web/handoff?code=${handoff}`, { headers: { 'sec-fetch-site': 'none' } });
  assert.equal(ok.status, 302);
  return ok.headers.getSetCookie().find((c) => c.startsWith('__Host-eden=')).split(';')[0].slice('__Host-eden='.length);
}

// The codes in these tests are issued to the user signing in: appSignIn records it.
const subs = new Map();
const subOfCode = (code) => subs.get(code) || 'nobody';

const decode = (part) => JSON.parse(new TextDecoder().decode(b64ToBytes(part)));

/** The client secret's header and claims, its ES256 signature checked against the SIWA key. */
async function secretOf(form) {
  const [head, body, sig] = form.get('client_secret').split('.');
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, siwa.publicKey, b64ToBytes(sig), new TextEncoder().encode(`${head}.${body}`));
  assert.ok(ok, 'signed with SIWA_KEY');
  return { header: decode(head), claims: decode(body) };
}

test('the Edu app’s sign-in: its code is exchanged as com.askeden.edu, kept with that id, revoked with it on deletion', async () => {
  const session = await appSignIn({ sub: 'apple-siwa-1', aud: 'com.askeden.edu', code: 'c-edu-1' });
  const exchanged = apple.filter((a) => a.url.endsWith('/auth/token'));
  assert.equal(exchanged.length, 1);
  const form = exchanged[0].form;
  assert.equal(form.get('client_id'), 'com.askeden.edu', 'the identity token’s aud');
  assert.equal(form.get('code'), 'c-edu-1');
  assert.equal(form.get('grant_type'), 'authorization_code');
  const { header, claims } = await secretOf(form);
  assert.deepEqual(header, { alg: 'ES256', kid: 'SIWAKEY123' });
  assert.equal(claims.sub, 'com.askeden.edu', 'the client secret is for the same app');
  assert.equal(claims.iss, '8CV4X23Y2T');
  assert.equal(claims.aud, 'https://appleid.apple.com');

  // Kept in the account's object by client id.
  const accountId = (await (await hit('/api/web/account', { session })).json()).account_id;
  assert.deepEqual(await env.ACCOUNTS.objects.get(accountId).storage.get('apple_grants'), { 'com.askeden.edu': 'rt-for-com.askeden.edu' });

  // Deleting the account revokes it with that client id.
  const done = await hit('/api/web/account/delete', { method: 'POST', session, body: { confirm: 'DELETE' } });
  assert.equal(done.status, 204, await done.clone().text());
  const revoked = apple.filter((a) => a.url.endsWith('/auth/revoke'));
  assert.equal(revoked.length, 1);
  assert.equal(revoked[0].form.get('client_id'), 'com.askeden.edu');
  assert.equal(revoked[0].form.get('token'), 'rt-for-com.askeden.edu');
  assert.equal(revoked[0].form.get('token_type_hint'), 'refresh_token');
  assert.equal((await secretOf(revoked[0].form)).claims.sub, 'com.askeden.edu');
});

test('both Eden apps on one Apple ID: each grant kept and revoked with its own client id', async () => {
  await appSignIn({ sub: 'apple-siwa-2', aud: 'com.askeden.eden', code: 'c-eden' });
  const session = await appSignIn({ sub: 'apple-siwa-2', aud: 'com.askeden.edu', code: 'c-edu' });
  assert.deepEqual(apple.map((a) => a.form.get('client_id')), ['com.askeden.eden', 'com.askeden.edu']);
  assert.equal((await hit('/api/web/account/delete', { method: 'POST', session, body: { confirm: 'DELETE' } })).status, 204);
  const revoked = apple.filter((a) => a.url.endsWith('/auth/revoke')).map((a) => [a.form.get('client_id'), a.form.get('token')]);
  assert.deepEqual(revoked.sort(), [['com.askeden.eden', 'rt-for-com.askeden.eden'], ['com.askeden.edu', 'rt-for-com.askeden.edu']]);
});

test('no SIWA_KEY: sign-in still works, nothing goes to Apple, a warning once (never a token)', async () => {
  env = makeEnv(); // no SIWA_KEY / SIWA_KEY_ID
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...args) => warned.push(args.join(' '));
  try {
    const session = await appSignIn({ sub: 'apple-siwa-3', aud: 'com.askeden.eden', code: 'c-secret-code' });
    await appSignIn({ sub: 'apple-siwa-3', aud: 'com.askeden.eden', code: 'c-secret-code-2' });
    assert.equal(apple.length, 0, 'no exchange without the key');
    assert.ok((await hit('/api/web/account', { session })).ok);
    assert.ok(warned.filter((w) => /SIWA_KEY/.test(w)).length <= 1, 'once at most');
    assert.ok(!warned.some((w) => w.includes('c-secret-code')), 'the code is never logged');
  } finally {
    console.warn = realWarn;
  }
});

test('Apple refusing the code: sign-in still works, nothing kept; a refusal log has no code or token in it', async () => {
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...args) => warned.push(args.join(' '));
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    apple.push({ url, form: new URLSearchParams(init.body) });
    return Response.json({ error: 'invalid_grant' }, { status: 400 });
  };
  try {
    const session = await appSignIn({ sub: 'apple-siwa-4', aud: 'com.askeden.eden', code: 'c-used-already' });
    const accountId = (await (await hit('/api/web/account', { session })).json()).account_id;
    assert.equal(await env.ACCOUNTS.objects.get(accountId).storage.get('apple_grants'), undefined);
    assert.ok(!warned.some((w) => w.includes('c-used-already')));
  } finally {
    console.warn = realWarn;
  }
});

test('exchangeCode / revoke: the client id given (default the J.A.R.V.I.S. app’s); an unknown one is never sent', async () => {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, form: new URLSearchParams(init.body) });
    return url.endsWith('/token') ? Response.json({ refresh_token: 'rt' }) : new Response(null, { status: 200 });
  };
  assert.equal(await exchangeCode(env, 'c1', fetcher), 'rt');
  assert.equal(calls[0].form.get('client_id'), 'com.askeden.jarvis', 'the J.A.R.V.I.S. app as before');
  assert.equal((await secretOf(calls[0].form)).claims.sub, 'com.askeden.jarvis');
  assert.equal(await revoke(env, 'rt', fetcher, 'com.askeden.eden'), true);
  assert.equal(calls[1].form.get('client_id'), 'com.askeden.eden');
  assert.equal((await secretOf(calls[1].form)).claims.sub, 'com.askeden.eden');
  assert.equal(await exchangeCode(env, 'c2', fetcher, 'com.evil.app'), null);
  assert.equal(await revoke(env, 'rt', fetcher, 'com.evil.app'), false);
  assert.equal(calls.length, 2, 'nothing sent for an unknown client id');
});

test('R2C-12: a code Apple says is another user’s (or another app’s) is never kept; sign-in still works', async () => {
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...args) => warned.push(args.join(' '));
  try {
    codeOwner.set('c-someone-else', { sub: 'apple-other-user', aud: 'com.askeden.eden' });
    codeOwner.set('c-other-app', { sub: 'apple-siwa-5', aud: 'com.askeden.edu' });
    codeOwner.set('c-no-id-token', null);
    await appSignIn({ sub: 'apple-siwa-5', aud: 'com.askeden.eden', code: 'c-someone-else' });
    const session = await appSignIn({ sub: 'apple-siwa-5', aud: 'com.askeden.eden', code: 'c-other-app' });
    const accountId = (await (await hit('/api/web/account', { session })).json()).account_id;
    assert.equal(apple.filter((a) => a.url.endsWith('/auth/token')).length, 2, 'both were exchanged');
    assert.equal(await env.ACCOUNTS.objects.get(accountId).storage.get('apple_grants'), undefined, 'neither kept');
    assert.ok(warned.some((w) => /another user or app/.test(w)));
    assert.ok(!warned.some((w) => w.includes('apple-other-user') || w.includes('rt-for-') || w.includes('c-someone-else')), 'no sub, token or code in the log');
    // The same user and app: kept.
    await appSignIn({ sub: 'apple-siwa-5', aud: 'com.askeden.eden', code: 'c-mine' });
    assert.deepEqual(await env.ACCOUNTS.objects.get(accountId).storage.get('apple_grants'), { 'com.askeden.eden': 'rt-for-com.askeden.eden' });
  } finally {
    console.warn = realWarn;
  }
  // exchangeCode itself: with `expect`, a missing or mismatched id_token is null.
  const fetcher = (claims) => async () => Response.json({ refresh_token: 'rt', ...(claims ? { id_token: idToken(claims) } : {}) });
  assert.equal(await exchangeCode(env, 'c', fetcher({ sub: 'u1', aud: 'com.askeden.eden' }), 'com.askeden.eden', { sub: 'u1' }), 'rt');
  assert.equal(await exchangeCode(env, 'c', fetcher({ sub: 'u2', aud: 'com.askeden.eden' }), 'com.askeden.eden', { sub: 'u1' }), null);
  assert.equal(await exchangeCode(env, 'c', fetcher({ sub: 'u1', aud: 'com.askeden.edu' }), 'com.askeden.eden', { sub: 'u1' }), null);
  assert.equal(await exchangeCode(env, 'c', fetcher(null), 'com.askeden.eden', { sub: 'u1' }), null);
});

test('R2C-11: the code exchange and a revoke each give up after 5 s (an AbortSignal), as a refusal', async () => {
  const signals = [];
  const stalled = async (url, init) => {
    signals.push(init.signal);
    assert.ok(init.signal instanceof AbortSignal, 'a signal is passed');
    return new Promise((_, reject) => {
      const hold = setTimeout(() => reject(new Error('never aborted')), 2000); // keeps the loop alive (the timeout's timer doesn't)
      init.signal.addEventListener('abort', () => (clearTimeout(hold), reject(init.signal.reason)), { once: true });
    });
  };
  const realTimeout = AbortSignal.timeout;
  const asked = [];
  AbortSignal.timeout = (ms) => {
    asked.push(ms);
    return realTimeout.call(AbortSignal, 1); // the test's 5 s, in 1 ms
  };
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await exchangeCode(env, 'c', stalled, 'com.askeden.eden', { sub: 'u' }), null);
    assert.equal(await revoke(env, 'rt', stalled, 'com.askeden.eden'), false);
  } finally {
    AbortSignal.timeout = realTimeout;
    console.warn = realWarn;
  }
  assert.deepEqual(asked, [5000, 5000]);
  assert.equal(signals.length, 2);
});

test('R2C-13: deleting the account revokes every grant at once; one failing is logged (no token) and the deletion goes on', async () => {
  await appSignIn({ sub: 'apple-siwa-6', aud: 'com.askeden.eden', code: 'c-eden-6' });
  const session = await appSignIn({ sub: 'apple-siwa-6', aud: 'com.askeden.edu', code: 'c-edu-6' });
  let inFlight = 0;
  let most = 0;
  const started = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    const form = new URLSearchParams(init.body);
    started.push(form.get('client_id'));
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    if (form.get('client_id') === 'com.askeden.eden') return new Response('{"error":"invalid_client"}', { status: 400 });
    return new Response(null, { status: 200 });
  };
  const warned = [];
  const realWarn = console.warn;
  console.warn = (...args) => warned.push(args.join(' '));
  let done;
  try {
    done = await hit('/api/web/account/delete', { method: 'POST', session, body: { confirm: 'DELETE' } });
  } finally {
    console.warn = realWarn;
  }
  assert.equal(done.status, 204, 'the deletion goes on');
  assert.deepEqual(started.sort(), ['com.askeden.eden', 'com.askeden.edu']);
  assert.equal(most, 2, 'both revokes in flight together');
  assert.ok(warned.some((w) => /could not be revoked/.test(w) && w.includes('400') && w.includes('com.askeden.eden')), 'the failure is logged with status and client id');
  assert.ok(!warned.some((w) => w.includes('rt-for-')), 'never a token');
});
