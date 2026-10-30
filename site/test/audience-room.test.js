// Eden Slides' audience room on askeden.com (src/eden/audience-room.js) and share permissions for decks and chats
// (src/accounts/shared-chats.js seatAccess, src/eden/deck-room.js admit): the room's rules through the Worker (sealed
// bodies only, votes counted under a burst, Q&A, hide, the presenter's token, the end), the core matching askeden's
// copy byte for byte, and links with roles, their own expiry, seat-only shares and invitations for one Eden account.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { forgetSessions } from '../src/eden/session.js';
import { AudienceRoom } from '../src/eden/audience-room.js';
import { DeckRoom } from '../src/eden/deck-room.js';
import { seatAccess } from '../src/accounts/shared-chats.js';
import { Account, Link, appleJwk, identityToken, namespace } from './fakes.js';

const ASKEDEN = new URL('../../../askeden/web/chat/', import.meta.url);
const crypt = await import(new URL('audience-crypto.js', ASKEDEN));
const ORIGIN = 'https://askeden.com';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';

let env, waits;
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;
const pairs = [];
DeckRoom.prototype.upgrade = function upgrade(tags) {
  const server = { readyState: 1, send() {}, close(code) { this.readyState = 3; this.code = code; } };
  this.ctx.acceptWebSocket(server, tags);
  pairs.push({ server, tags });
  return { response: new Response(null, { status: 200, headers: { 'x-upgraded': '1', 'x-pair': String(pairs.length - 1) } }), server };
};
beforeEach(() => {
  waits = [];
  forgetAppleKeys();
  forgetSessions();
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    throw new Error(`unexpected fetch ${url}`);
  };
  env = { ANTHROPIC_API_KEY: 'sk-test', TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '20' };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.DECK_ROOMS = namespace(DeckRoom, env);
  env.AUDIENCE_ROOMS = namespace(AudienceRoom, env);
  env.ASSETS = { fetch: async (req) => new Response(`asset ${new URL(req.url).pathname}`) };
});
after(() => { globalThis.fetch = realFetch; });

async function hit(p, { method = 'GET', body, headers = {}, session, token, browser = true } = {}) {
  const h = { ...headers };
  if (browser) { h['user-agent'] ??= SAFARI; if (method !== 'GET' && method !== 'HEAD') h.origin ??= ORIGIN; }
  if (session) h.cookie = `__Host-eden=${session}`;
  if (token) h.authorization = `Bearer ${token}`;
  const init = { method, headers: h };
  if (body !== undefined) { init.body = typeof body === 'string' ? body : JSON.stringify(body); h['content-type'] ??= 'application/json'; }
  const response = await worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx);
  while (waits.length) await Promise.all(waits.splice(0));
  return response;
}
const cookieValue = (response, name) => { const found = (response.headers.getSetCookie ? response.headers.getSetCookie() : []).find((c) => c.startsWith(`${name}=`)); return found ? found.slice(name.length + 1).split(';')[0] : undefined; };
async function phone(sub = 'apple-user-1') {
  const r = await hit('/api/account/apple', { method: 'POST', browser: false, body: { identity_token: await identityToken({ sub }), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } } });
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}
async function browserOf(owner) {
  const started = await hit('/api/web/link', { method: 'POST', body: {} });
  const link = await started.json();
  const linkCookie = `__Host-eden-link=${cookieValue(started, '__Host-eden-link')}`;
  assert.equal((await hit(`/api/link/${link.code}/approve`, { method: 'POST', browser: false, token: owner.token, body: { sealed_key: null, sender_key: null } })).status, 200);
  const done = await hit('/api/web/link/poll', { method: 'POST', body: {}, headers: { cookie: linkCookie } });
  return cookieValue(done, '__Host-eden');
}
const post = (session) => async (path, body) => {
  const r = await hit(path, { method: 'POST', session, body, headers: { 'x-jarvis-chat': '1' } });
  const out = await r.json();
  if (r.status >= 400) { const e = new Error(out.error); e.status = r.status; throw e; }
  return out;
};
const aud = async (id, sub, body, headers = {}) => {
  const r = await hit(`/a/${id}${sub}`, body === undefined ? { headers } : { method: 'POST', body, headers });
  return { status: r.status, body: await r.json().catch(() => null) };
};
/** The first `view` event of the room's stream (the stream stays open; one read is enough here). */
async function view(id, headers = {}) {
  const r = await hit(`/a/${id}/events`, { headers });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const reader = r.body.getReader();
  const { value } = await reader.read();
  reader.cancel().catch(() => {});
  const text = new TextDecoder().decode(value);
  return JSON.parse(text.split('\n').find((l) => l.startsWith('data: ')).slice(6));
}

test('the audience core here is askeden’s, byte for byte', () => {
  const ours = fs.readFileSync(new URL('../src/eden/audience-core.js', import.meta.url), 'utf8');
  const theirs = fs.readFileSync(new URL('audience-core.js', ASKEDEN), 'utf8');
  assert.equal(ours, theirs, 'copy askeden/web/chat/audience-core.js to site/src/eden/audience-core.js');
});

test('a presentation through the Worker: sealed poll, a burst of votes counted exactly, Q&A with upvotes and hiding, the presenter only, the end forgets', async () => {
  const me = await browserOf(await phone());
  assert.equal((await hit('/api/chat/audience', { method: 'POST', body: {}, headers: { 'x-jarvis-chat': '1' } })).status, 401, 'signed out: no room');
  const { id, owner } = await post(me)('/api/chat/audience', {});
  assert.match(id, /^[\w-]{22}$/);
  const key = crypt.newKey();
  const O = { 'x-room-owner': owner };
  // the page and its files; anything else under /a/ is not served
  const pageR = await hit(`/a/${id}`);
  assert.equal(pageR.status, 200);
  assert.match(pageR.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(pageR.headers.get('x-robots-tag'), /noindex/);
  assert.equal(await (await hit('/a/audience.js')).text(), 'asset /eden/audience.js');
  assert.notEqual(await (await hit('/a/worker.js')).text(), 'asset /eden/worker.js', 'only the page’s own files');
  // only sealed bodies: the Worker never reads a question or an option
  const plainPoll = { kind: 'poll', id: 'poll01', n: 3, body: JSON.stringify({ q: 'Lunch?', o: ['a', 'b', 'c'] }) };
  assert.equal((await aud(id, '/control', { t: 'show', k: 2, total: 9, live: plainPoll }, O)).status, 400, 'unsealed refused');
  const poll = { ...plainPoll, body: await crypt.sealBody({ q: 'Lunch?', o: ['Pizza', 'Salad', 'Soup'] }, key, 'poll') };
  assert.equal((await aud(id, '/control', { t: 'show', k: 2, total: 9, live: poll })).status, 403, 'no owner token');
  assert.equal((await aud(id, '/control', { t: 'show', k: 2, total: 9, live: poll }, { 'x-room-owner': 'A'.repeat(32) })).status, 403, 'a wrong owner token');
  assert.equal((await aud(id, '/control', { t: 'show', k: 2, total: 9, live: poll }, O)).status, 200);
  // 60 phones vote at once, then 20 change their minds at once: every vote counted once
  const voters = [];
  for (let i = 0; i < 60; i++) { const j = await aud(id, '/join', {}, { 'cf-connecting-ip': `10.0.0.${i}` }); assert.equal(j.status, 200); voters.push(j.body.voter); }
  const results = await Promise.all(voters.map((v, i) => aud(id, '/act', { t: 'vote', poll: 'poll01', option: i % 3 }, { 'x-voter': v, 'cf-connecting-ip': `10.0.0.${i}` })));
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.find((r) => r.status !== 200)));
  await Promise.all(voters.slice(0, 20).map((v, i) => aud(id, '/act', { t: 'vote', poll: 'poll01', option: 2 }, { 'x-voter': v, 'cf-connecting-ip': `10.0.0.${i}` })));
  let v = await view(id);
  assert.deepEqual(v.live.counts, [13, 13, 34]);
  assert.equal(v.live.votes, 60);
  assert.equal(v.people, undefined, 'phones don’t see how many joined');
  assert.equal((await view(id, O)).people, 60, 'the presenter does');
  const opened = await crypt.openBody(v.live.body, key, 'poll');
  assert.deepEqual(opened, { q: 'Lunch?', o: ['Pizza', 'Salad', 'Soup'] });
  assert.equal(await crypt.openBody(v.live.body, crypt.newKey(), 'poll'), null, 'a wrong key reads nothing');
  assert.equal(await crypt.openBody(v.live.body, key, 'question'), null, 'a poll can’t pass as a question');
  // hostile votes
  const bad = async (m, h = { 'x-voter': voters[0] }) => (await aud(id, '/act', m, h)).status;
  assert.equal(await bad({ t: 'vote', poll: 'poll01', option: 3 }), 400, 'no option 4');
  assert.equal(await bad({ t: 'vote', poll: 'poll01', option: -1 }), 400);
  assert.equal(await bad({ t: 'vote', poll: 'poll01', option: '1' }), 400);
  assert.equal(await bad({ t: 'vote', poll: 'nope99', option: 1 }), 404);
  assert.equal(await bad({ t: 'vote', poll: 'poll01', option: 1 }, { 'x-voter': 'B'.repeat(22) }), 401, 'a made-up voter');
  assert.equal(await bad({ t: 'vote', poll: 'poll01', option: 1 }, {}), 401);
  assert.equal(await bad({ t: '__proto__', poll: 'poll01' }), 400);
  assert.equal((await hit(`/a/${id}/act`, { method: 'POST', body: '{"t":"vote"}', headers: { 'content-type': 'text/plain', 'x-voter': voters[0] } })).status, 415, 'a form post from another page');
  assert.equal((await hit(`/a/${id}/act`, { method: 'POST', body: {}, headers: { origin: 'https://evil.example', 'x-voter': voters[0] } })).status, 403, 'another site');
  // close voting
  await aud(id, '/control', { t: 'lock', poll: 'poll01' }, O);
  assert.equal(await bad({ t: 'vote', poll: 'poll01', option: 1 }), 409);
  // Q&A
  const qa = { kind: 'qa', id: 'qa0001', body: await crypt.sealBody({ q: 'Questions?' }, key, 'qa') };
  assert.equal(await bad({ t: 'ask', qa: 'qa0001', body: await crypt.sealBody({ text: 'early' }, key, 'question') }), 409, 'not open until it is on screen');
  await aud(id, '/control', { t: 'show', k: 3, total: 9, live: qa }, O);
  const ask = async (who, text) => (await aud(id, '/act', { t: 'ask', qa: 'qa0001', body: await crypt.sealBody({ text }, key, 'question'), name: 'Sam‮' }, { 'x-voter': who })).body.id;
  assert.equal(await bad({ t: 'ask', qa: 'qa0001', body: JSON.stringify({ text: 'plain' }) }), 400, 'a plain question refused');
  const q1 = await ask(voters[1], 'Is it vegan?');
  const q2 = await ask(voters[2], 'Rude words here');
  for (const w of voters.slice(3, 8)) assert.equal((await aud(id, '/act', { t: 'up', q: q2 }, { 'x-voter': w })).body.up, true);
  await aud(id, '/act', { t: 'up', q: q1 }, { 'x-voter': voters[9] });
  assert.equal((await aud(id, '/act', { t: 'up', q: q1 }, { 'x-voter': voters[1] })).status, 409, 'not your own');
  await aud(id, '/act', { t: 'up', q: q2, on: false }, { 'x-voter': voters[3] });
  v = await view(id);
  assert.deepEqual(v.live.questions.map((q) => [q.id, q.up]), [[q2, 4], [q1, 1]], 'most upvoted first');
  assert.equal(v.live.questions[0].name, 'Sam', 'no bidi trickery in a name');
  assert.ok(!JSON.stringify(v).includes(voters[1]), 'voter ids never shown');
  await aud(id, '/control', { t: 'hide', q: q2 }, O);
  assert.deepEqual((await view(id)).live.questions.map((q) => q.id), [q1], 'hidden from phones');
  assert.equal((await view(id, O)).live.questions.find((q) => q.id === q2).hidden, true, 'the presenter still sees it');
  assert.equal((await aud(id, '/act', { t: 'up', q: q2 }, { 'x-voter': voters[20] })).status, 404, 'a hidden question can’t be upvoted');
  for (let i = 0; i < 10; i++) await ask(voters[10], `q${i}`);
  assert.equal((await aud(id, '/act', { t: 'ask', qa: 'qa0001', body: await crypt.sealBody({ text: 'eleventh' }, key, 'question') }, { 'x-voter': voters[10] })).status, 409, '10 questions a phone');
  // follow-along slides: sealed, fetched once
  const deck = await crypt.sealBody({ title: 'T', slides: [{ k: 0, doc: '<!doctype html><p>hi' }] }, key, 'deck');
  assert.equal((await aud(id, '/control', { t: 'deck', body: deck }, O)).body.deckV, 1);
  assert.equal((await aud(id, '/deck')).body.body, deck);
  // a burst of actions from one phone is slowed (the room's own limit, per voter)
  const burst = await Promise.all(Array.from({ length: 40 }, (_, i) => aud(id, '/act', { t: 'up', q: q1, on: i % 2 === 0 }, { 'x-voter': voters[30] })));
  assert.ok(burst.some((r) => r.status === 429), 'slowed down');
  // the end: the room forgets everything; the link stops
  assert.equal((await aud(id, '/control', { t: 'close' }, O)).status, 200);
  assert.equal(env.AUDIENCE_ROOMS.objects.get(id).storage.map.size, 0);
  assert.equal((await aud(id, '/join', {})).status, 404);
  assert.equal((await hit(`/a/${id}/events`)).status, 404);
});

test('a room survives the object going to sleep (state reloaded from storage) and forgets itself a day after the last change', async () => {
  const me = await browserOf(await phone());
  const { id, owner } = await post(me)('/api/chat/audience', {});
  const key = crypt.newKey();
  await aud(id, '/control', { t: 'show', k: 0, total: 2, live: { kind: 'poll', id: 'poll02', n: 2, body: await crypt.sealBody({ q: 'x', o: ['a', 'b'] }, key, 'poll') } }, { 'x-room-owner': owner });
  const { voter } = (await aud(id, '/join', {})).body;
  await aud(id, '/act', { t: 'vote', poll: 'poll02', option: 1 }, { 'x-voter': voter });
  const obj = env.AUDIENCE_ROOMS.objects.get(id);
  obj.room = null; // evicted
  assert.deepEqual((await view(id)).live.counts, [0, 1]);
  assert.equal((await aud(id, '/act', { t: 'me' }, { 'x-voter': voter })).body.vote.poll02, 1, 'the phone is remembered');
  assert.ok(obj.storage.alarm > Date.now() + 23 * 3600e3);
  obj.now = () => Date.now() + 25 * 3600e3;
  obj.room = null;
  await obj.alarm();
  assert.equal(obj.storage.map.size, 0);
});

// ── share permissions ──

const BLOB = JSON.stringify({ v: 1, iv: 'AAECAwQFBgcICQoL', ct: 'eA' });
const tok = (c) => c.repeat(24);

test('seatAccess: roles, a link’s own expiry, seat-only shares, an invitation kept by the first Eden account', async () => {
  const { b64url, sha256 } = await import('../src/accounts/util.js');
  const h = async (t) => b64url(await sha256(t));
  const now = Date.now();
  const share = { access: 'seat', collaborators: [
    { id: 'seatview1', role: 'viewer', tokenHash: await h(tok('v')) },
    { id: 'seatold01', role: 'commenter', tokenHash: await h(tok('o')), expires: now - 1 },
    { id: 'seatppl01', role: 'collaborator', tokenHash: await h(tok('p')), people: true },
  ] };
  await assert.rejects(seatAccess(share, '', null, now), /only opens with the invitation/);
  assert.equal((await seatAccess({}, '', null, now)).seat, null, 'a plain share: anyone with the link');
  assert.equal((await seatAccess(share, tok('v'), null, now)).seat.role, 'viewer');
  await assert.rejects(seatAccess(share, tok('o'), null, now), /expired/);
  await assert.rejects(seatAccess(share, tok('x'), null, now), /revoked/);
  await assert.rejects(seatAccess(share, 'short', null, now), /revoked/);
  await assert.rejects(seatAccess(share, tok('p'), null, now), (e) => e.status === 401);
  const first = await seatAccess(share, tok('p'), 'acct-A', now);
  assert.equal(first.claimed, true);
  assert.equal((await seatAccess(share, tok('p'), 'acct-A', now)).claimed, undefined, 'the same account again');
  await assert.rejects(seatAccess(share, tok('p'), 'acct-B', now), /another Eden account/);
});

test('share links through the Worker: commenter replies, viewer can’t, a link’s expiry, seat-only data, an invitation, an owner can’t forge a claim', async () => {
  const owner = await phone();
  const me = await browserOf(owner);
  const now = Date.now();
  const s = await post(me)('/api/chat/share', { blob: BLOB, expires: null, access: 'seat', collaborators: [
    { id: 'seatview1', role: 'viewer', token: tok('v') },
    { id: 'seatcomm1', role: 'commenter', token: tok('c'), expires: now + 3600e3 },
    { id: 'seatppl01', role: 'collaborator', token: tok('p'), people: true, label: 'Sam\u0007' },
  ] });
  assert.equal(s.access, 'seat');
  const data = (t, session) => hit(`/s/${s.id}/data`, { headers: t ? { 'x-seat': t } : {}, session });
  assert.equal((await data('')).status, 403, 'no seat, no data');
  const v = await (await data(tok('v'))).json();
  assert.deepEqual(v.me, { id: 'seatview1', role: 'viewer' });
  assert.equal(v.seats, undefined, 'a seat-only share lists no seats');
  assert.equal((await data(tok('z'))).status, 403);
  const reply = (t) => hit(`/s/${s.id}/reply`, { method: 'POST', body: { blob: BLOB, token: t } });
  assert.equal((await reply(tok('v'))).status, 403, 'a viewer can’t reply');
  assert.equal((await reply(tok('c'))).status, 200, 'a commenter can');
  assert.equal((await reply('')).status, 403);
  // the invitation: signed out → sign in; the first account keeps it; another is refused
  assert.equal((await data(tok('p'))).status, 401);
  const sam = await browserOf(await phone('apple-user-sam'));
  const eve = await browserOf(await phone('apple-user-eve'));
  assert.equal((await data(tok('p'), sam)).status, 200);
  assert.equal((await data(tok('p'), eve)).status, 403, 'a forwarded invitation');
  assert.equal((await data(tok('p'), sam)).status, 200);
  // the owner edits the seats: the claim stays (it can't be set or moved by the owner)
  await post(me)('/api/chat/shares/update', { id: s.id, collaborators: [{ id: 'seatppl01', role: 'collaborator', token: tok('p'), people: true, account: 'acct-forged' }] });
  assert.equal((await data(tok('p'), sam)).status, 200, 'still Sam’s');
  assert.equal((await data(tok('v'))).status, 403, 'a seat taken away stops working');
  await assert.rejects(post(me)('/api/chat/shares/update', { id: s.id, collaborators: [{ id: 'seatnew01', role: 'commenter', token: tok('n'), expires: now - 5 }] }), /expiry/);
  await assert.rejects(post(me)('/api/chat/shares/update', { id: s.id, collaborators: [{ id: 'seatnew01', role: 'owner', token: tok('n') }] }), /Invalid/, 'no such role');
  // a plain old share still works for anyone with the link, and lists its live seats for older pages
  const old = await post(me)('/api/chat/share', { blob: BLOB, expires: null, collaborators: [{ id: 'seatcoll1', role: 'collaborator', token: tok('k') }] });
  const od = await (await hit(`/s/${old.id}/data`)).json();
  assert.equal(od.seats.length, 1);
  assert.equal(od.me, undefined);
});

test('the deck room: a commenter comments but never edits; an expired link and someone else’s invitation stay out', async () => {
  const me = await browserOf(await phone());
  const now = Date.now();
  const s = await post(me)('/api/chat/share', { blob: BLOB, expires: null, mode: 'collaborate', access: 'seat', collaborators: [
    { id: 'seatcomm1', role: 'commenter', token: tok('c') },
    { id: 'seatgone1', role: 'collaborator', token: tok('g'), expires: now + 60e3 },
    { id: 'seatppl01', role: 'collaborator', token: tok('p'), people: true },
  ] });
  const up = (t, session) => hit(`/api/chat/deck-room/${s.id}`, { session, headers: { upgrade: 'websocket', origin: ORIGIN, 'sec-websocket-protocol': `eden-deck.v1, seat.${t}` } });
  assert.equal((await up(tok('c'))).status, 200);
  assert.ok(pairs.at(-1).tags.includes('role:commenter'));
  const room = env.DECK_ROOMS.objects.get(s.id);
  const ws = pairs.at(-1).server;
  const said = [];
  room.error = (w, code) => said.push(code);
  const ENC = JSON.stringify({ v: 1, iv: 'AAECAwQFBgcICQoL', ct: 'c2VhbGVk' });
  await room.webSocketMessage(ws, JSON.stringify({ t: 'version', id: 'v1', at: 1, enc: ENC }));
  await room.webSocketMessage(ws, JSON.stringify({ t: 'comments', at: 2, enc: ENC }));
  assert.deepEqual(said, ['forbidden'], 'the version refused, the comments taken');
  assert.equal((await room.storage.get('cm')).enc, ENC);
  // a link with its own time: in now, out once it passes (that socket alone)
  assert.equal((await up(tok('g'))).status, 200);
  const g = pairs.at(-1);
  assert.ok(g.tags.some((t) => t.startsWith('e:')));
  room.now = () => now + 120e3;
  await room.webSocketMessage(g.server, JSON.stringify({ t: 'presence', here: true }));
  assert.equal(g.server.code, 4404, 'its own time is up');
  assert.notEqual(ws.readyState, 3, 'the others stay');
  room.now = () => Date.now();
  const realNow = Date.now;
  Date.now = () => now + 120e3;
  try { assert.equal((await up(tok('g'))).status, 403); } finally { Date.now = realNow; }
  // an invitation: signed out → 401; Sam keeps it; Eve can't use it
  assert.equal((await up(tok('p'))).status, 401);
  const sam = await browserOf(await phone('apple-user-sam'));
  const eve = await browserOf(await phone('apple-user-eve'));
  assert.equal((await up(tok('p'), sam)).status, 200);
  assert.equal((await up(tok('p'), eve)).status, 403);
  assert.equal((await up(tok('p'), sam)).status, 200);
});
