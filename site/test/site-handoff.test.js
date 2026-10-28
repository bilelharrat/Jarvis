// Eden Travel's own address signing in with askeden.com's sign-in (src/eden/site-handoff.js).
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { bytesToB64 } from '../src/accounts/util.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Link, appleJwk, identityToken, namespace } from './fakes.js';

const MAIN = 'https://askeden.com';
const TRAVEL = 'https://askedentravel.com';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
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
  env = { ANTHROPIC_API_KEY: 'sk-test', EDEN_TOKEN_KEY: bytesToB64(new Uint8Array(32).fill(7)), EDEN_TRAVEL: '1', TRAVEL_HOST: 'askedentravel.com' };
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
async function signedIn() {
  const r = await hit(`${MAIN}/api/account/apple`, { method: 'POST', headers: { origin: null }, body: { identity_token: await identityToken({ sub: 'traveller-1' }), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } } });
  const me = await r.json();
  const started = await hit(`${MAIN}/api/web/link`, { method: 'POST', body: {} });
  const link = await started.json();
  await hit(`${MAIN}/api/link/${link.code}/approve`, { method: 'POST', headers: { origin: null, authorization: `Bearer ${me.token}` }, body: { sealed_key: null, sender_key: null } });
  const done = await hit(`${MAIN}/api/web/link/poll`, { method: 'POST', body: {}, cookie: `__Host-eden-link=${cookieValue(started, '__Host-eden-link')}` });
  return cookieValue(done, '__Host-eden');
}

test('signed out on askedentravel.com: its site at the front, and askeden.com/travel and www forward there', async () => {
  const front = await hit(`${TRAVEL}/`);
  assert.equal(await front.text(), 'asset /travel-home/');
  assert.equal((await hit(`${MAIN}/travel`)).headers.get('location'), `${TRAVEL}/`);
  assert.equal((await hit('https://www.askedentravel.com/x')).headers.get('location'), `${TRAVEL}/x`);
  assert.equal((await hit(`${TRAVEL}/signin`)).headers.get('location'), '/api/web/site-handoff/start');
});

test('the handoff: state in this browser, askeden.com’s session makes a one-time code, the travel address gets its own cookie', async () => {
  const session = await signedIn();
  const start = await hit(`${TRAVEL}/api/web/site-handoff/start`);
  const state = cookieValue(start, '__Host-eden-hand');
  assert.match((start.headers.getSetCookie() || []).join(), /__Host-eden-hand=[^;]+; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600/);
  const to = new URL(start.headers.get('location'));
  assert.equal(to.origin + to.pathname, `${MAIN}/hand`);
  // arriving from another site: no Strict cookie, so the page moves on to itself first
  const hop = await hit(to.href, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.match(await hop.text(), /url=\/hand\?s=[0-9a-f]{64}&amp;on=1|url=\/hand\?s=[0-9a-f]{64}&on=1/);
  // signed out there: askeden.com's sign-in, and back
  const out = await hit(`${MAIN}/hand?s=${to.searchParams.get('s')}&on=1`, { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(out.headers.get('location'), `/signin?return=${encodeURIComponent(`/hand?s=${to.searchParams.get('s')}&on=1`)}`);
  const minted = await hit(`${MAIN}/hand?s=${to.searchParams.get('s')}&on=1`, { headers: { 'sec-fetch-site': 'same-origin' }, cookie: `__Host-eden=${session}` });
  const fin = new URL(minted.headers.get('location'));
  assert.equal(fin.origin + fin.pathname, `${TRAVEL}/api/web/site-handoff/finish`);
  // another browser (no state, or another state) can't use the code
  const stolen = await hit(fin.href, { cookie: '__Host-eden-hand=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
  assert.match(await stolen.text(), /started in another browser/);
  assert.equal(cookieValue(stolen, '__Host-eden'), '');
  // the code was taken by that try: a fresh one for the right browser
  const minted2 = await hit(`${MAIN}/hand?s=${to.searchParams.get('s')}&on=1`, { headers: { 'sec-fetch-site': 'same-origin' }, cookie: `__Host-eden=${session}` });
  const done = await hit(minted2.headers.get('location'), { cookie: `__Host-eden-hand=${state}` });
  assert.equal(done.headers.get('location'), '/');
  const travelSession = cookieValue(done, '__Host-eden');
  assert.ok(travelSession && travelSession !== session, 'its own session, a new browser device');
  const again = await hit(minted2.headers.get('location'), { cookie: `__Host-eden-hand=${state}` });
  assert.match(await again.text(), /ran out or was already used/, 'a code works once');
  // signed in on the travel address: the app at the front, and its API answers there
  assert.equal(await (await hit(`${TRAVEL}/`, { cookie: `__Host-eden=${travelSession}` })).text(), 'asset /eden/');
  const trips = await hit(`${TRAVEL}/api/chat/travel`, { cookie: `__Host-eden=${travelSession}`, headers: { 'x-jarvis-chat': '1' } });
  assert.equal(trips.status, 200, await trips.clone().text());
});

test('the handoff is held without TRAVEL_HOST, and never on askeden.com itself', async () => {
  assert.equal((await hit(`${MAIN}/api/web/site-handoff/start`)).status, 404);
  delete env.TRAVEL_HOST;
  assert.equal((await hit(`${MAIN}/hand?s=${'a'.repeat(64)}`)).headers.get('location'), '/');
});
