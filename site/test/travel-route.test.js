// Eden Travel end to end through the Worker: a signed-in browser → /api/chat/travel → the
// account object (travel/ops.js) and back. Stand-in maps; nothing reaches Google or Apple.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { bytesToB64 } from '../src/accounts/util.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Link, appleJwk, identityToken, namespace } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
let env;
let waits;
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;

function makeEnv(extra = {}) {
  const e = { ANTHROPIC_API_KEY: 'sk-test', EDEN_TOKEN_KEY: bytesToB64(new Uint8Array(32).fill(7)), ...extra };
  e.ACCOUNTS = namespace(Account, e);
  e.LINKS = namespace(Link, e);
  e.ASSETS = { fetch: async () => new Response('asset') };
  return e;
}

beforeEach(() => {
  waits = [];
  forgetAppleKeys();
  forgetSessions();
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://appleid.apple.com/auth/keys')) return Response.json({ keys: [appleJwk] });
    throw new Error(`unexpected fetch ${url}`);
  };
  env = makeEnv({ EDEN_TRAVEL: '1' });
});
after(() => {
  globalThis.fetch = realFetch;
});

async function hit(p, { method = 'GET', body, headers = {}, session, cookie, token } = {}) {
  const h = { 'user-agent': SAFARI, ...headers };
  if (method !== 'GET') h.origin ??= ORIGIN;
  const jar = [];
  if (session) jar.push(`__Host-eden=${session}`);
  if (cookie) jar.push(cookie);
  if (jar.length) h.cookie = jar.join('; ');
  if (token) h.authorization = `Bearer ${token}`;
  const init = { method, headers: h };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  const response = await worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx);
  while (waits.length) await Promise.all(waits.splice(0));
  return response;
}
const cookieValue = (response, name) => ((response.headers.getSetCookie() || []).find((c) => c.startsWith(`${name}=`)) || '').slice(name.length + 1).split(';')[0];

async function signedIn() {
  const r = await hit('/api/account/apple', { method: 'POST', headers: { origin: null }, body: { identity_token: await identityToken({ sub: 'traveller-1' }), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } } });
  assert.equal(r.status, 200, await r.clone().text());
  const me = await r.json();
  const started = await hit('/api/web/link', { method: 'POST', body: {} });
  const link = await started.json();
  await hit(`/api/link/${link.code}/approve`, { method: 'POST', headers: { origin: null }, token: me.token, body: { sealed_key: null, sender_key: null } });
  const done = await hit('/api/web/link/poll', { method: 'POST', body: {}, cookie: `__Host-eden-link=${cookieValue(started, '__Host-eden-link')}` });
  return cookieValue(done, '__Host-eden');
}
const chat = (session, opts = {}) => hit(opts.path || '/api/chat/travel', { session, ...opts, headers: { 'x-jarvis-chat': '1', ...(opts.headers || {}) } });
const travel = async (session, action, args = {}) => {
  const r = await chat(session, { method: 'POST', body: { action, args } });
  return { status: r.status, body: await r.json() };
};

test('a signed-in browser makes the sample trip, Eden proposes, the person applies, then undoes', async () => {
  const session = await signedIn();
  assert.ok(session);
  const made = await travel(session, 'sample');
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const id = made.body.trip.id;
  assert.ok(made.body.checks.alerts.some((a) => a.kind === 'closed_that_day'));

  const list = await (await chat(session)).json();
  assert.deepEqual(list.trips.map((t) => t.id), [id]);
  assert.equal(list.maps, 'standin');

  const tiles = made.body.trip.days[2].stops.find((s) => s.place.id === 'standin:tiles');
  const prop = await travel(session, 'propose', { id, ops: [{ op: 'move', stop: tiles.id, day: 1, at: '17:30' }], title: 'Tiles on Sunday', by: 'eden' });
  assert.equal(prop.status, 200, JSON.stringify(prop.body));
  const refused = await travel(session, 'apply', { id, proposal: prop.body.proposal.id });
  assert.equal(refused.status, 400);
  const applied = await travel(session, 'apply', { id, proposal: prop.body.proposal.id, confirm: true });
  assert.equal(applied.body.trip.rev, 2);

  const one = await (await chat(session, { path: `/api/chat/travel?id=${id}` })).json();
  assert.equal(one.trip.rev, 2);
  const undone = await travel(session, 'undo', { id });
  assert.equal(undone.body.trip.rev, 3);
  const bad = await travel(session, 'apply', { id, proposal: 'nope', confirm: true });
  assert.equal(bad.status, 409);
  assert.equal(bad.body.code, 'gone');
});

test('signed out, or with Travel off, there is nothing at /api/chat/travel', async () => {
  const out = await chat(null);
  assert.ok(out.status === 401 || out.status === 403, `signed out got ${out.status}`);
  env = makeEnv(); // EDEN_TRAVEL unset
  const session = await signedIn();
  const off = await chat(session);
  assert.equal(off.status, 404);
});
