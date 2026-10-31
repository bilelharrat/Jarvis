// Eden Calendar's own site (askedencalendar.com, a separate Worker) signing in with askeden.com's sign-in:
// askeden.com's half, /hand/calendar (src/eden/calendar-handoff.js). The calendar's half is calendar-worker/src/hand.ts.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { bytesToB64 } from '../src/accounts/util.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Link, appleJwk, identityToken, namespace } from './fakes.js';

const MAIN = 'https://askeden.com';
const CAL = 'https://askedencalendar.com';
const SECRET = 'calendar-link-secret-for-tests-0123456789';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
const S = 'ab'.repeat(32); // the state's hash the calendar sends
let env;
let waits;
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;

beforeEach(() => {
  waits = [];
  forgetAppleKeys();
  forgetSessions();
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://appleid.apple.com/auth/keys')) return Response.json({ keys: [appleJwk] });
    throw new Error(`unexpected fetch ${url}`);
  };
  env = { ANTHROPIC_API_KEY: 'sk-test', EDEN_TOKEN_KEY: bytesToB64(new Uint8Array(32).fill(7)), EDEN_CALENDAR_LINK_SECRET: SECRET };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.ASSETS = { fetch: async (r) => new Response(`asset ${new URL(r.url).pathname}`) };
});
after(() => { globalThis.fetch = realFetch; });

async function hit(url, { method = 'GET', body, headers = {}, cookie } = {}) {
  const h = { 'user-agent': SAFARI, ...headers };
  if (method !== 'GET') h.origin ??= new URL(url).origin;
  if (cookie) h.cookie = cookie;
  const init = { method, headers: h };
  if (body !== undefined) { init.body = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const response = await worker.fetch(new Request(url, init), env, ctx);
  while (waits.length) await Promise.all(waits.splice(0));
  return response;
}
const cookieValue = (response, name) => ((response.headers.getSetCookie() || []).find((c) => c.startsWith(`${name}=`)) || '').slice(name.length + 1).split(';')[0];

/** A browser signed in to askeden.com, its account's sign-ins set to `identities`. */
async function signedIn(identities) {
  const r = await hit(`${MAIN}/api/account/apple`, { method: 'POST', headers: { origin: null }, body: { identity_token: await identityToken({ sub: 'cal-user-1' }), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } } });
  const me = await r.json();
  const started = await hit(`${MAIN}/api/web/link`, { method: 'POST', body: {} });
  const link = await started.json();
  await hit(`${MAIN}/api/link/${link.code}/approve`, { method: 'POST', headers: { origin: null, authorization: `Bearer ${me.token}` }, body: { sealed_key: null, sender_key: null } });
  const done = await hit(`${MAIN}/api/web/link/poll`, { method: 'POST', body: {}, cookie: `__Host-eden-link=${cookieValue(started, '__Host-eden-link')}` });
  const session = cookieValue(done, '__Host-eden');
  const { account_id } = await (await hit(`${MAIN}/api/web/session`, { cookie: `__Host-eden=${session}` })).json();
  await env.ACCOUNTS.objects.get(account_id).ctx.storage.put('identities', identities);
  return session;
}

/** The ticket's claims, after checking its signature the way the calendar does (HMAC-SHA256, base64url). */
function readTicket(t) {
  const [body, sig, extra] = t.split('.');
  assert.equal(extra, undefined);
  assert.equal(sig, createHmac('sha256', SECRET).update(body).digest('base64url'));
  return JSON.parse(Buffer.from(body, 'base64url').toString());
}

test('signed in: a minute-long ticket for the account’s first email and this state, sent to the calendar', async () => {
  const session = await signedIn([
    { provider: 'apple', sub_hash: 'a1', email: null, added: 1 },
    { provider: 'google', sub_hash: 'g1', email: 'Owner@Example.com', added: 2 },
    { provider: 'passkey', sub_hash: 'p1', email: 'later@example.com', added: 3 },
  ]);
  const r = await hit(`${MAIN}/hand/calendar?s=${S}&on=1`, { headers: { 'sec-fetch-site': 'same-origin' }, cookie: `__Host-eden=${session}` });
  assert.equal(r.status, 302);
  const to = new URL(r.headers.get('location'));
  assert.equal(to.origin + to.pathname, `${CAL}/auth/finish`);
  const claims = readTicket(to.searchParams.get('t'));
  assert.deepEqual([claims.sub, claims.aud, claims.s], ['owner@example.com', 'eden-calendar-hand', S]);
  const left = claims.exp - Date.now() / 1000;
  assert.ok(left > 50 && left <= 60, `exp in a minute (${left})`);
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
});

test('from another site the page hops to itself; signed out it goes to sign-in and back', async () => {
  const hop = await hit(`${MAIN}/hand/calendar?s=${S}`, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.match(await hop.text(), new RegExp(`url=/hand/calendar\\?s=${S}&on=1`));
  const out = await hit(`${MAIN}/hand/calendar?s=${S}&on=1`, { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(out.headers.get('location'), `/signin?return=${encodeURIComponent(`/hand/calendar?s=${S}&on=1`)}`);
});

test('no ticket without a state, without the secret, or for an account with no email', async () => {
  const session = await signedIn([{ provider: 'passkey', sub_hash: 'p1', email: null, added: 1 }]);
  const asked = (q) => hit(`${MAIN}/hand/calendar?${q}`, { headers: { 'sec-fetch-site': 'same-origin' }, cookie: `__Host-eden=${session}` });
  assert.equal((await asked('s=nothex&on=1')).headers.get('location'), '/');
  const noEmail = await asked(`s=${S}&on=1`);
  assert.equal(noEmail.status, 200);
  assert.match(await noEmail.text(), /no email yet/);
  env.EDEN_CALENDAR_LINK_SECRET = 'short';
  const off = await asked(`s=${S}&on=1`);
  assert.match(await off.text(), /switched on yet/);
});

test('the calendar’s address comes from the config only (CALENDAR_ORIGIN for local dev), never the request', async () => {
  const session = await signedIn([{ provider: 'google', sub_hash: 'g1', email: 'me@example.com', added: 1 }]);
  env.CALENDAR_ORIGIN = 'http://localhost:8798';
  const local = await hit(`${MAIN}/hand/calendar?s=${S}&on=1&to=https://evil.example`, { headers: { 'sec-fetch-site': 'same-origin' }, cookie: `__Host-eden=${session}` });
  assert.ok(local.headers.get('location').startsWith('http://localhost:8798/auth/finish?t='));
  env.CALENDAR_ORIGIN = 'http://evil.example';
  const bad = await hit(`${MAIN}/hand/calendar?s=${S}&on=1`, { headers: { 'sec-fetch-site': 'same-origin' }, cookie: `__Host-eden=${session}` });
  assert.ok(bad.headers.get('location').startsWith(`${CAL}/auth/finish?t=`));
});
