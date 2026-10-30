// Eden Slides, editing together (src/eden/deck-room.js): the room's own rules (roles, sizes, rates, keeping versions and
// comments, presence, revoking, forgetting), who the Worker lets in (the owner's session, a seat's token, nobody from
// another site), and two of askeden's real browser clients (askeden/web/chat/deck-room.js) editing one deck through the
// Worker and the room, with everything sealed so the room never sees a deck.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { forgetSessions } from '../src/eden/session.js';
import { DeckRoom, ROOM, readProtocols } from '../src/eden/deck-room.js';
import { Account, Link, Storage, appleJwk, identityToken, namespace } from './fakes.js';

const ASKEDEN = new URL('../../../askeden/web/chat/', import.meta.url);
const client = await import(new URL('deck-room.js', ASKEDEN));
const comments = await import(new URL('deck-comments-model.js', ASKEDEN));
const presenceMod = await import(new URL('deck-presence.js', ASKEDEN));

const ORIGIN = 'https://askeden.com';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
const flush = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 2)); };

// ── a WebSocket pair in memory: the room's end (accepted by the object) and the browser's end ──
const pairs = [];
class End {
  constructor() { this.readyState = 1; this.onmessage = null; this.onclose = null; this.onopen = null; this.sent = []; }
  send(s) { if (this.readyState !== 1) throw new Error('closed'); this.sent.push(s); this.peer.deliver(s); }
  deliver(s) { if (this.onmessage) queueMicrotask(() => this.onmessage({ data: s })); }
  close(code = 1000) { if (this.readyState === 3) return; this.readyState = 3; this.closed = { code }; this.peer.gone(code); }
  gone(code) { if (this.readyState !== 3) { this.readyState = 3; this.closed = { code }; } if (this.onclose) queueMicrotask(() => this.onclose({ code })); }
}
DeckRoom.prototype.upgrade = function upgrade(tags) {
  const server = new End(), browser = new End();
  server.peer = browser; browser.peer = server;
  const room = this;
  server.deliver = (s) => queueMicrotask(() => room.webSocketMessage(server, s)); // what the browser sends reaches the room
  server.gone = () => { server.readyState = 3; room.webSocketClose(server); };
  this.ctx.acceptWebSocket(server, tags);
  pairs.push({ server, browser, tags });
  return { response: new Response(null, { status: 200, headers: { 'x-upgraded': '1', 'x-pair': String(pairs.length - 1), 'sec-websocket-protocol': ROOM.protocol } }), server };
};

/** A room on its own (unit tests): its fake storage, and a connect() that hands back the browser's end. */
function lone({ now = () => Date.now() } = {}) {
  const env = {};
  const ns = namespace(DeckRoom, env);
  const stub = ns.get('room1');
  const room = ns.objects.get('room1');
  room.now = now;
  const connect = async (role = 'owner', seat = role === 'owner' ? 'owner' : `seat_${role}`) => {
    const r = await stub.fetch('https://deck-room/connect', { headers: { upgrade: 'websocket', 'x-room': 'room1', 'x-role': role, 'x-seat': seat, 'x-expires': '' } });
    assert.equal(r.status, 200, await r.clone().text());
    const end = pairs[Number(r.headers.get('x-pair'))].browser;
    const got = [];
    end.onmessage = (e) => got.push(JSON.parse(e.data));
    return { end, got, say: (m) => end.send(typeof m === 'string' ? m : JSON.stringify(m)) };
  };
  return { room, stub, connect, storage: room.ctx.storage };
}
const ENC = (n = 1) => JSON.stringify({ v: 1, iv: 'AAECAwQFBgcICQoL', ct: `c2VhbGVk${'A'.repeat(n)}` });

test('the room: versions kept once each (the newest 40), comments, presence passed on, welcome with what a newcomer lacks', async () => {
  const { connect, storage } = lone();
  const a = await connect('owner');
  const b = await connect('collaborator');
  a.say({ t: 'hello', since: [] });
  await flush();
  assert.equal(a.got[0].t, 'welcome');
  assert.equal(a.got[0].role, 'owner');
  for (let i = 1; i <= 45; i++) a.say({ t: 'version', id: `ver${i}`, at: 1000 + i, enc: ENC(i) });
  a.say({ t: 'version', id: 'ver45', at: 1045, enc: ENC(45) }); // the same again: kept once
  await flush(10);
  const kept = [...(await storage.list({ prefix: 'v:' })).values()].map((v) => v.id);
  assert.equal(kept.length, 40);
  assert.equal(kept[0], 'ver6');
  assert.equal(kept.at(-1), 'ver45');
  assert.equal((await storage.list({ prefix: 'vi:' })).size, 40, 'its index pruned with it');
  assert.equal(b.got.filter((m) => m.t === 'version').length, 46, 'each one passed on (the repeat too: harmless, ids are kept once)');
  assert.ok(b.got.every((m) => m.from && m.from !== 'room'));
  a.say({ t: 'comments', at: 5, enc: ENC(2) });
  a.say({ t: 'presence', enc: ENC(3) });
  await flush();
  assert.deepEqual(b.got.filter((m) => m.t === 'comments').map((m) => m.enc), [ENC(2)]);
  assert.equal(b.got.filter((m) => m.t === 'presence').length, 1);
  assert.equal(a.got.filter((m) => m.t === 'presence').length, 0, 'never echoed to the sender');
  assert.equal((await storage.get('cm')).enc, ENC(2));
  // a newcomer who has some versions gets the rest, one frame each, then the comments
  const c = await connect('viewer');
  c.say({ t: 'hello', since: ['ver44', 'ver45', '../x'] });
  await flush();
  assert.equal(c.got[0].t, 'welcome');
  assert.equal(c.got[0].ids.length, 40);
  assert.deepEqual(c.got.filter((m) => m.t === 'version').map((m) => m.id), kept.slice(0, 38));
  assert.equal(c.got.at(-1).t, 'comments');
  // leaving: the others are told
  b.end.close();
  await flush();
  assert.ok(a.got.some((m) => m.t === 'left'));
});

test('the room refuses: a viewer writing, junk, plain text where a sealed envelope belongs, too big, too fast', async () => {
  const { connect, storage } = lone();
  const v = await connect('viewer');
  v.say({ t: 'version', id: 'v1', at: 1, enc: ENC() });
  v.say({ t: 'comments', at: 1, enc: ENC() });
  v.say({ t: 'presence', enc: ENC() }); // a viewer may still be seen
  await flush();
  assert.deepEqual(v.got.map((m) => m.code), ['forbidden', 'forbidden']);
  assert.equal((await storage.list({ prefix: 'v:' })).size, 0);
  const o = await connect('owner');
  for (const bad of ['not json', '[1]', { t: 'nope' }, { t: 'version', id: '../../x', at: 1, enc: ENC() }, { t: 'version', id: 'v1', at: -1, enc: ENC() },
    { t: 'version', id: 'v1', at: 1, enc: '<script>alert(1)</script>' }, { t: 'version', id: 'v1', at: 1, enc: { v: 1 } }, { t: 'comments', at: 'x', enc: ENC() }, { t: 'presence', enc: ENC(5000) }]) o.say(bad);
  o.say('x'.repeat(ROOM.maxMessage + 1));
  await flush();
  assert.deepEqual(o.got.map((m) => m.code).sort(), [...Array(9).fill('bad_request'), 'too_big']);
  assert.equal((await storage.list({ prefix: 'v:' })).size, 0);
  // more than perSecond in one second: refused; past dropAfter: closed
  const fast = await connect('owner');
  for (let i = 0; i < ROOM.dropAfter + 5; i++) fast.say({ t: 'presence', enc: ENC() });
  await flush(20);
  assert.ok(fast.got.filter((m) => m.code === 'rate').length > 100);
  assert.equal(fast.end.closed && fast.end.closed.code, 1008);
});

test('the room: a seat taken away is closed out, a revoke closes everyone and forgets everything, an idle room empties itself', async () => {
  let now = 1_800_000_000_000;
  const { connect, stub, storage, room } = lone({ now: () => now });
  const owner = await connect('owner');
  const keep = await connect('collaborator', 'seat_keep');
  const drop = await connect('viewer', 'seat_drop');
  owner.say({ t: 'version', id: 'v1', at: 1, enc: ENC() });
  await flush();
  await stub.fetch('https://deck-room/seats', { method: 'POST', body: JSON.stringify({ seats: ['seat_keep'] }) });
  await flush();
  assert.equal(drop.end.readyState, 3);
  assert.equal(drop.end.closed.code, 4403);
  assert.equal(keep.end.readyState, 1);
  assert.equal(owner.end.readyState, 1, 'the owner is never a seat');
  // an alarm before 30 idle days keeps it; after, empties it
  await room.alarm();
  assert.ok(await storage.get('v:0000000000000001:v1'));
  now += ROOM.idleMs + 1;
  await room.alarm();
  assert.equal(owner.end.readyState, 3);
  assert.equal((await storage.list()).size, 0);
  // revoke
  const again = await connect('owner');
  again.say({ t: 'version', id: 'v2', at: 2, enc: ENC() });
  await flush();
  await stub.fetch('https://deck-room/close', { method: 'POST' });
  await flush();
  assert.equal(again.end.closed.code, 4403);
  assert.equal((await storage.list()).size, 0);
  // at most ROOM.sockets at once
  const many = [];
  for (let i = 0; i < ROOM.sockets; i++) many.push(await connect('owner'));
  const full = await stub.fetch('https://deck-room/connect', { headers: { upgrade: 'websocket', 'x-role': 'owner', 'x-seat': 'owner' } });
  assert.equal(full.status, 429);
  // only roles the Worker gives
  for (const m of many) m.end.close();
  await flush();
  assert.equal((await stub.fetch('https://deck-room/connect', { headers: { upgrade: 'websocket', 'x-role': 'admin', 'x-seat': 'owner' } })).status, 400);
});

test('protocols: eden-deck.v1, and a seat token only when it looks like one', () => {
  assert.deepEqual(readProtocols('eden-deck.v1, seat.abcdefghijklmnopqrstuvwxyz012345'), { ok: true, token: 'abcdefghijklmnopqrstuvwxyz012345' });
  assert.deepEqual(readProtocols('eden-deck.v1'), { ok: true, token: '' });
  assert.deepEqual(readProtocols('chat, seat.short'), { ok: false, token: '' });
});

// ── through the Worker: sign-in, a share with seats, the upgrade ──

let env;
let waits;
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;
function makeEnv() {
  const e = { ANTHROPIC_API_KEY: 'sk-test', TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '20' };
  e.ACCOUNTS = namespace(Account, e);
  e.LINKS = namespace(Link, e);
  e.DECK_ROOMS = namespace(DeckRoom, e);
  e.ASSETS = { fetch: async (req) => new Response(`asset ${new URL(req.url).pathname}`) };
  return e;
}
beforeEach(() => {
  waits = [];
  forgetAppleKeys();
  forgetSessions();
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    throw new Error(`unexpected fetch ${url}`);
  };
  env = makeEnv();
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
  if (r.status >= 400) throw new Error(out.error);
  return out;
};
const upgrade = (id, { session, protocols = 'eden-deck.v1', origin = ORIGIN, headers = {} } = {}) => hit(`/api/chat/deck-room/${id}`, { session, headers: { upgrade: 'websocket', origin, 'sec-websocket-protocol': protocols, ...headers } });
/** A socket for askeden's RoomClient that goes through the Worker (the upgrade) to the room. */
const viaWorker = (id, opts) => () => {
  const s = { readyState: 0, onopen: null, onmessage: null, onclose: null, send() { throw new Error('not open'); }, close() {} };
  upgrade(id, opts).then((r) => {
    if (r.status !== 200) { s.readyState = 3; queueMicrotask(() => s.onclose && s.onclose({ code: r.status === 403 || r.status === 404 ? 4403 : 1006 })); return; }
    const end = pairs[Number(r.headers.get('x-pair'))].browser;
    s.send = (x) => end.send(x);
    s.close = (code) => end.close(code);
    end.onmessage = (e) => s.onmessage && s.onmessage(e);
    end.onclose = (e) => { s.readyState = 3; if (s.onclose) s.onclose(e); };
    s.readyState = 1;
    if (s.onopen) s.onopen();
  });
  return s;
};

test('the Worker lets in the owner and seats, from askeden.com only, and never trusts a role the browser sends', async () => {
  const owner = await phone();
  const me = await browserOf(owner);
  const c = { id: 'conv1', title: 'Q3', deckVersions: [] };
  const room = await client.startRoom(c, { post: post(me), origin: ORIGIN });
  assert.match(room.links.edit, /^https:\/\/askeden\.com\/chat\/#deck-room&room=[\w-]{22}&key=[\w-]{43}&seat=[\w-]{32}$/);
  const edit = client.readRoomLink(new URL(room.links.edit).hash), view = client.readRoomLink(new URL(room.links.view).hash);
  const id = room.id;
  // the share's data is ciphertext; nothing of the key reached the server
  const data = await (await hit(`/s/${id}/data`)).json();
  assert.ok(!JSON.stringify(data).includes(room.key));
  assert.equal(data.mode, 'collaborate');
  assert.ok(!JSON.stringify(data).includes(edit.token), 'only token hashes are kept');

  assert.equal((await upgrade(id, { session: me })).headers.get('x-upgraded'), '1', 'the owner, by session');
  assert.equal(pairs.at(-1).tags.includes('role:owner'), true);
  assert.equal((await upgrade(id, { protocols: `eden-deck.v1, seat.${edit.token}` })).status, 200, 'an edit seat, signed out');
  assert.ok(pairs.at(-1).tags.includes('role:collaborator'));
  assert.equal((await upgrade(id, { protocols: `eden-deck.v1, seat.${view.token}`, headers: { 'x-role': 'owner' } })).status, 200);
  assert.ok(pairs.at(-1).tags.includes('role:viewer'), 'x-role from a browser is ignored');
  const status = async (o) => (await upgrade(o.id || id, o)).status;
  assert.equal(await status({ protocols: `eden-deck.v1, seat.${'x'.repeat(32)}` }), 403, 'a wrong token');
  assert.equal(await status({}), 401, 'nobody');
  assert.equal(await status({ session: me, origin: 'https://evil.example' }), 403, 'another site');
  assert.equal(await status({ session: me, protocols: 'chat' }), 400, 'without the protocol');
  assert.equal(await status({ session: me, id: 'A'.repeat(22) }), 404, 'no such share');
  assert.equal((await hit(`/api/chat/deck-room/${id}`, { session: me })).status, 426, 'not a WebSocket');
  const other = await browserOf(await phone('apple-user-2'));
  assert.equal(await status({ session: other }), 401, 'someone else signed in is not the owner');
  // a plain read-only share isn't a room
  const plain = await post(me)('/api/chat/share', { blob: JSON.stringify({ v: 1, iv: 'AAECAwQFBgcICQoL', ct: 'eA' }), expires: null });
  assert.equal(await status({ session: me, id: plain.id }), 403);
  // revoking: everyone in the room is closed, the room forgets, the links stop working
  const inRoom = pairs.slice(-3).map((p) => p.browser);
  await client.stopRoom(c, { post: post(me) });
  await flush();
  assert.ok(inRoom.every((e) => e.readyState === 3 && e.closed.code === 4403));
  assert.equal(await status({ protocols: `eden-deck.v1, seat.${edit.token}` }), 404);
  assert.equal(c.deckRoom, undefined);
});

test('two people edit one deck through the Worker and the room: edits, comments and presence arrive sealed; a viewer only watches; a revoke ends it', async () => {
  const owner = await phone();
  const me = await browserOf(owner);
  const deck = { title: 'Q3 review', slides: [{ layout: 'title', title: 'Q3 review', subtitle: 'Numbers' }, { layout: 'bullets', title: 'Wins', bullets: ['Revenue up'] }] };
  const ana = { id: 'ana-conv', title: 'Q3', deckVersions: [{ id: 'v1', at: 1000, kind: 'model', deck }] };
  await client.startRoom(ana, { post: post(me), origin: ORIGIN });
  const edit = client.readRoomLink(new URL(ana.deckRoom.links.edit).hash);
  const view = client.readRoomLink(new URL(ana.deckRoom.links.view).hash);
  const bo = { id: 'bo-conv', deckRoom: edit, deckVersions: [] };
  const cy = { id: 'cy-conv', deckRoom: view, deckVersions: [] };
  const statuses = { ana: [], bo: [], cy: [] };
  const mk = (c, who, opts) => new client.RoomClient({ connect: viaWorker(c.deckRoom.id, opts), key: c.deckRoom.key, getConv: () => c, onStatus: (s, d) => statuses[who].push(d ? `${s}:${d}` : s) });
  const A = mk(ana, 'ana', { session: me });
  await flush(10);
  const B = mk(bo, 'bo', { protocols: `eden-deck.v1, seat.${edit.token}` });
  const C = mk(cy, 'cy', { protocols: `eden-deck.v1, seat.${view.token}` });
  await flush(15);
  assert.ok(statuses.ana.includes('open:owner') && statuses.bo.includes('open:collaborator') && statuses.cy.includes('open:viewer'), JSON.stringify(statuses));
  assert.deepEqual(bo.deckVersions.map((v) => v.id), ['v1'], 'Bo gets the deck Ana had before he came');
  assert.equal(bo.deckVersions[0].deck.slides[1].title, 'Wins');
  assert.equal(cy.deckVersions.length, 1);
  // what the room holds is sealed: no slide text, no title
  const roomObj = env.DECK_ROOMS.objects.get(ana.deckRoom.id);
  const stored = JSON.stringify([...roomObj.ctx.storage.map.values()]);
  assert.ok(!stored.includes('Wins') && !stored.includes('Q3 review') && !stored.includes('Revenue'), 'the room never sees the deck');
  // Bo edits; Ana gets it
  bo.deckVersions = [...bo.deckVersions, { id: 'v2', at: 2000, kind: 'edit', deck: { ...deck, slides: [deck.slides[0], { ...deck.slides[1], title: 'Wins (Bo)' }] } }];
  await B.push(bo);
  await flush(10);
  assert.equal(ana.deckVersions.at(-1).deck.slides[1].title, 'Wins (Bo)');
  assert.equal(cy.deckVersions.at(-1).deck.slides[1].title, 'Wins (Bo)', 'the viewer watches it happen');
  // comments from both at once: both end up with both
  ana.deckVersions.at(-1).deck.comments = comments.addComment([], { by: 'Ana', text: 'Good', anchor: { slide: 1 }, id: 'ca', now: 3000 });
  bo.deckVersions.at(-1).deck.comments = comments.addComment([], { by: 'Bo', text: 'Thanks @Ana', anchor: { slide: 1 }, id: 'cb', now: 3001 });
  await Promise.all([A.push(ana), B.push(bo)]);
  await flush(25);
  const ids = (c) => comments.commentsOf(c).map((t) => t.id).sort().join();
  assert.equal(ids(ana), 'ca,cb');
  assert.equal(ids(bo), 'ca,cb');
  assert.equal(ids(cy), 'ca,cb');
  // a viewer's edits never leave its browser
  cy.deckVersions = [...cy.deckVersions, { id: 'v9', at: 9000, kind: 'edit', deck }];
  await C.push(cy);
  await flush(10);
  assert.ok(!ana.deckVersions.some((v) => v.id === 'v9'));
  // presence through the room (sealed too)
  const timers = { setInterval: () => 0, clearInterval: () => {} };
  const pa = new presenceMod.Presence({ channel: A.channel, deck: ana.deckRoom.id, me: { id: 'tabAna', name: 'Ana' }, timers });
  const pb = new presenceMod.Presence({ channel: B.channel, deck: bo.deckRoom.id, me: { id: 'tabBo', name: 'Bo' }, timers });
  await flush(10);
  pb.set({ index: 1, k: 1, path: 'title' });
  await flush(10);
  assert.equal(presenceMod.peerLine(pa.list().find((p) => p.id === 'tabBo')), 'Bo is editing slide 2');
  // Bo's connection drops: Ana sees him go; he comes back and catches up on what he missed
  const boPair = pairs.filter((p) => p.tags.includes('role:collaborator')).at(-1);
  boPair.server.readyState = 3; await roomObj.webSocketClose(boPair.server); boPair.browser.gone(1006); // the network drops: both ends see it
  await flush(10);
  assert.ok(!pa.list().some((p) => p.id === 'tabBo'), 'gone from Ana’s line');
  assert.ok(statuses.bo.includes('offline'));
  ana.deckVersions = [...ana.deckVersions, { id: 'v3', at: 4000, kind: 'edit', deck: { ...deck, title: 'Q3 final' } }];
  await A.push(ana);
  await new Promise((r) => setTimeout(r, 1700)); // Bo's first retry (about a second)
  await flush(15);
  assert.ok(bo.deckVersions.some((v) => v.id === 'v3'), 'caught up after reconnecting');
  // a tampered envelope opens to nothing
  assert.equal(await client.unseal(JSON.stringify({ v: 1, iv: 'AAECAwQFBgcICQoL', ct: 'AAAA' }), ana.deckRoom.key, 'comments'), null);
  const sealedV = await client.seal({ id: 'v1', at: 1, deck }, ana.deckRoom.key, 'version', 'v1');
  assert.equal(await client.unseal(sealedV, ana.deckRoom.key, 'version', 'v2'), null, 'a version sealed under one id can’t be passed off as another');
  // the owner revokes: everyone is told it's over and nobody tries again
  await client.stopRoom(ana, { post: post(me) });
  await flush(10);
  assert.ok(statuses.bo.includes('closed:revoked') && statuses.cy.includes('closed:revoked'), JSON.stringify(statuses));
  for (const x of [A, B, C, pa, pb]) x.close();
});
