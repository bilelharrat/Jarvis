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
  env = makeEnv({ EDEN_TRAVEL: '1', TRAVEL_PLUS: '0' }) // the Plus gate has its own test below;
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

async function signedIn(sub = 'traveller-1') {
  const r = await hit('/api/account/apple', { method: 'POST', headers: { origin: null }, body: { identity_token: await identityToken({ sub }), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } } });
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

test('/travel: the Eden app when signed in with Travel on; the front page otherwise', async () => {
  const out = await hit('/travel');
  assert.equal(out.status, 302);
  const session = await signedIn();
  const on = await hit('/travel', { session });
  assert.equal(on.status, 200, await on.clone().text());
  env = makeEnv(); // EDEN_TRAVEL unset
  const s2 = await signedIn();
  assert.equal((await hit('/travel', { session: s2 })).status, 302);
});

test('Eden Travel is part of Plus: without it the list is empty with plus: false, and trip actions are refused', async () => {
  env.TRAVEL_PLUS = '1';
  const session = await signedIn();
  const list = await chat(session);
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { trips: [], plus: false });
  const made = await travel(session, 'sample');
  assert.equal(made.status, 402);
  assert.equal(made.body.code, 'plus_required');
});

test('a trip shared with the people on it: the plan and its checks, never prices, references or notes; a calendar file; it can be ended', async () => {
  const session = await signedIn();
  const made = await travel(session, 'sample');
  const id = made.body.trip.id;
  const stop = made.body.trip.days[0].stops[0];
  await travel(session, 'mark-booked', { id, stop: stop.id, ref: 'SECRET-REF-1', provider: 'Some Hotel', cost: { amount: 321, currency: 'EUR' }, confirm: true });
  const link = await travel(session, 'link-create', { id });
  assert.equal(link.status, 200, JSON.stringify(link.body));
  assert.match(link.body.url, /^\/t\/[a-z0-9]{12}$/);
  const data = await hit(`${link.body.url}/data`);
  assert.equal(data.status, 200);
  assert.match(data.headers.get('x-robots-tag'), /noindex/);
  const text = await data.text();
  const view = JSON.parse(text).trip;
  assert.equal(view.title, made.body.trip.title);
  assert.equal(view.days[0].stops[0].booked, true);
  for (const secret of ['SECRET-REF-1', '321', 'Some Hotel', '"cost"', '"link"', '"note"']) assert.ok(!text.includes(secret), `the guest view leaves out ${secret}`);
  const ics = await hit(`${link.body.url}/calendar.ics`);
  assert.equal(ics.headers.get('content-type'), 'text/calendar; charset=utf-8');
  const cal = await ics.text();
  assert.match(cal, /^BEGIN:VCALENDAR\r\n/);
  assert.ok(!cal.includes('SECRET-REF-1'));
  const own = await chat(session, { path: `/api/chat/travel/calendar?id=${id}` });
  assert.equal(own.status, 200);
  assert.match(await own.text(), /BEGIN:VEVENT/);
  const listed = await travel(session, 'links', { id });
  assert.equal(listed.body.links.length, 1);
  await travel(session, 'link-revoke', { code: listed.body.links[0].code });
  assert.equal((await hit(`${link.body.url}/data`)).status, 404, 'an ended link shows nothing');
});

test('without Plus a trip link can still be ended (and stops showing), and a trip deleted', async () => {
  const session = await signedIn();
  const made = await travel(session, 'sample');
  const link = await travel(session, 'link-create', { id: made.body.trip.id });
  env.TRAVEL_PLUS = '1';
  assert.equal((await hit(`${link.body.url}/data`)).status, 404, 'its owner has no Plus: the link shows nothing');
  assert.equal((await travel(session, 'links', {})).status, 200);
  assert.equal((await travel(session, 'link-revoke', { code: link.body.code })).status, 200);
  assert.equal((await travel(session, 'delete', { id: made.body.trip.id })).status, 200);
  assert.equal((await travel(session, 'sample')).status, 402);
});

test('planning together: an invite, a member who sees the whole trip and suggests, the organiser who applies; a member can’t change it', async () => {
  const owner = await signedIn('organiser-1');
  const friend = await signedIn('friend-1');
  const made = await travel(owner, 'sample');
  const id = made.body.trip.id;
  const inv = await travel(owner, 'invite-create', { id });
  assert.equal(inv.status, 200, JSON.stringify(inv.body));
  assert.match(inv.body.url, /^\/join\/[a-z0-9]{12}$/);
  const page = await hit(inv.body.url, { session: friend });
  assert.equal(page.headers.get('location'), `/travel?join=${inv.body.code}`);
  const joined = await travel(friend, 'join', { code: inv.body.code, name: 'Sam' });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const list = await travel(friend, 'shared-list', {});
  assert.deepEqual(list.body.shared.map((x) => x.trip), [id]);
  const seen = await travel(friend, 'shared-get', { owner: joined.body.owner, trip: id });
  assert.equal(seen.body.trip.title, made.body.trip.title);
  assert.ok(!('rewards' in seen.body), 'never the organiser’s cards');
  // a member can't act on the organiser's trip through their own account
  assert.equal((await travel(friend, 'apply', { id, proposal: 'x', confirm: true })).status, 404);
  const stop = made.body.trip.days[0].stops[1];
  const sug = await travel(friend, 'shared-propose', { owner: joined.body.owner, trip: id, title: 'Later lunch', ops: [{ op: 'time', stop: stop.id, at: '14:00' }] });
  assert.equal(sug.status, 200, JSON.stringify(sug.body));
  const mine = await (await chat(owner, { path: `/api/chat/travel?id=${id}` })).json();
  assert.equal(mine.proposal.by, 'member');
  assert.equal(mine.proposal.by_name, 'Sam');
  const applied = await travel(owner, 'apply', { id, proposal: mine.proposal.id, confirm: true });
  assert.equal(applied.status, 200);
  // the organiser takes them off: the trip is gone for them
  await travel(owner, 'member-remove', { id, member: (await travel(owner, 'members', { id })).body.members[0].member });
  assert.equal((await travel(friend, 'shared-get', { owner: joined.body.owner, trip: id })).status, 404);
  assert.equal((await travel(friend, 'join', { code: 'aaaaaaaaaaaa' })).status, 404, 'a made-up invite');
});

test('the shared trip page: photos only of the trip’s own stops; the map from the day’s stops', async () => {
  const session = await signedIn();
  const made = await travel(session, 'sample');
  const link = await travel(session, 'link-create', { id: made.body.trip.id });
  const r = await hit(`${link.body.url}/photo?n=${encodeURIComponent('places/ChIJnotOnThisTrip0/photos/AbCdEfGhIjKlMn')}`);
  assert.equal(r.status, 404, 'not any Google photo on Eden’s key');
});

test('planning together, the edges: someone taken off can’t rejoin with the old invite, and a suggestion never replaces the organiser’s waiting change', async () => {
  const owner = await signedIn('organiser-2');
  const friend = await signedIn('friend-2');
  const made = await travel(owner, 'sample');
  const id = made.body.trip.id;
  const inv = await travel(owner, 'invite-create', { id });
  const joined = await travel(friend, 'join', { code: inv.body.code, name: 'Sam' });
  const stop = made.body.trip.days[0].stops[1];
  await travel(owner, 'propose', { id, title: 'Mine', ops: [{ op: 'time', stop: stop.id, at: '13:30' }] });
  const busy = await travel(friend, 'shared-propose', { owner: joined.body.owner, trip: id, title: 'Theirs', ops: [{ op: 'time', stop: stop.id, at: '14:00' }] });
  assert.equal(busy.status, 409);
  const member = (await travel(owner, 'members', { id })).body.members[0].member;
  await travel(owner, 'member-remove', { id, member });
  assert.equal((await travel(friend, 'join', { code: inv.body.code, name: 'Sam' })).status, 403, 'the old invite doesn’t let them back');
  const again = await travel(owner, 'invite-create', { id });
  assert.equal((await travel(friend, 'join', { code: again.body.code, name: 'Sam' })).status, 200, 'a new invite does');
});
