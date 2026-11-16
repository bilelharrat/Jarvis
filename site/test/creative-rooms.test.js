// Creative rooms (src/creative/rooms.js, docs/creative-rooms.md): editing one project together. Requests
// go through the Worker (src/worker.js) with the dev tokens of wrangler.creative-rooms-dev.toml on
// localhost (and, in one test, a real `creative` token checked by a fake account object); the rooms and
// their index objects are in-memory Durable Objects (fakes.js), and each app's socket is a fake: what
// the room sends it lands in `sent`, and its frames go in through the room's webSocketMessage, as the
// runtime's would.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { CreativeRoom, ROOMS, roomsApi } from '../src/creative/rooms.js';
import { verifyCreativeToken } from '../src/creative/rooms-auth.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { b64url, randomBytes, sha256Hex } from '../src/accounts/util.js';
import { Account, Link, appleJwk, identityToken, namespace } from './fakes.js';

const PEOPLE = {
  'dev-ana': { account: 'acct-ana', name: 'Ana', email: 'ana@example.com' },
  'dev-maya': { account: 'acct-maya', name: 'Maya', email: 'maya@example.com' },
  'dev-jon': { account: 'acct-jon', name: 'Jon', email: 'jon@example.com' },
  'dev-lee': { account: 'acct-lee', name: 'Lee', email: 'Lee@Example.COM' }, // signs in with capitals
};
const LOCAL = 'http://localhost:8788';
const DEFAULTS = { ...ROOMS };
const SECOND = 254_016_000_000; // the engine's ticks

class Socket {
  constructor({ attachments = true } = {}) {
    this.sent = [];
    this.closed = null;
    this.readyState = 1;
    if (attachments) {
      this.serializeAttachment = (value) => {
        this.att = structuredClone(value);
      };
      this.deserializeAttachment = () => structuredClone(this.att ?? null);
    }
  }
  send(message) {
    if (this.readyState !== 1) throw new Error('closed');
    this.sent.push(message);
  }
  close(code, reason) {
    if (!this.closed) this.closed = { code, reason };
    this.readyState = 3;
  }
  take() {
    const out = this.sent.map((m) => JSON.parse(m));
    this.sent = [];
    return out;
  }
}

let env;
let opened;
let plainSockets;

CreativeRoom.prototype.upgrade = function upgrade(tags) {
  const server = new Socket({ attachments: !plainSockets });
  this.ctx.acceptWebSocket(server, tags);
  opened.push(server);
  return { response: new Response('upgraded', { status: 200, headers: { 'x-upgraded': '1' } }), server };
};

beforeEach(() => {
  Object.assign(ROOMS, DEFAULTS);
  opened = [];
  plainSockets = false;
  env = { CREATIVE_ROOMS_DEV: '1', CREATIVE_ROOMS_DEV_TOKENS: JSON.stringify(PEOPLE) };
  env.CREATIVE_ROOMS = namespace(CreativeRoom, env);
});

afterEach(() => Object.assign(ROOMS, DEFAULTS));

async function call(token, path, { method = 'GET', body, headers = {}, base = LOCAL } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  const init = { method, headers: h };
  if (body !== undefined) {
    if (body instanceof Uint8Array || typeof body === 'string') init.body = body;
    else {
      init.body = JSON.stringify(body);
      h['content-type'] = 'application/json';
    }
  }
  return worker.fetch(new Request(`${base}/api/creative/rooms${path}`, init), env, {});
}

async function ok(response, status = 200) {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return JSON.parse(text);
}

async function refused(response, status, code) {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.code, code, JSON.stringify(body));
  assert.equal(typeof body.error, 'string');
  return body;
}

const roomOf = (id) => env.CREATIVE_ROOMS.objects.get(`room:${id}`);
const indexOf = (name) => env.CREATIVE_ROOMS.objects.get(name);
const mailKey = async (email) => `mail:${await sha256Hex(email)}`;

async function makeRoom(token = 'dev-ana', name = 'Trailer') {
  return (await ok(await call(token, '', { method: 'POST', body: { name } }), 201)).room;
}

const invite = (id, email, role = 'edit', token = 'dev-ana') => call(token, `/${id}/invite`, { method: 'POST', body: { email, role } });

/** Ana's room, with each of these people invited (email local part = token name) and signed in. */
async function roomWith(people = { maya: 'edit' }) {
  const room = await makeRoom();
  for (const [who, role] of Object.entries(people)) {
    await ok(await invite(room.id, `${who}@example.com`, role), 201);
    await ok(await call(`dev-${who}`, `/${room.id}`));
  }
  return room;
}

async function connect(token, id) {
  const response = await call(token, `/${id}/socket`, { headers: { upgrade: 'websocket' } });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(response.headers.get('x-upgraded'), '1');
  return opened.at(-1);
}

const send = (id, ws, msg) => roomOf(id).webSocketMessage(ws, typeof msg === 'string' ? msg : JSON.stringify(msg));

async function hello(id, ws, since = 0) {
  await send(id, ws, { t: 'hello', since });
  return ws.take();
}

const op = (n, extra = {}) => ({ t: 'op', id: `op-${n}`, base: 0, label: `Change ${n}`, op: `{"move":${n}}`, ...extra });
const only = (frames, t) => frames.filter((f) => f.t === t);

function noise(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

const putSnapshot = (token, id, bytes, seq, hash) => call(token, `/${id}/snapshot`, { method: 'PUT', body: bytes, headers: { 'x-seq': String(seq), 'x-hash': hash, 'content-type': 'application/octet-stream' } });

// ── auth ──

test('rooms refuse no token, a token that isn’t a dev one, a dev token off localhost or with dev mode off, and any Origin', async () => {
  for (const [token, base] of [[null, LOCAL], ['nope', LOCAL], ['es1.acct-ana.x.y', LOCAL], ['__proto__', LOCAL], ['constructor', LOCAL], ['dev-ana', 'https://askeden.com'], ['dev-ana', 'https://127.0.0.2:8788'], ['dev-ana', 'https://localhost.askeden.com']]) {
    const body = await refused(await call(token, '', { base }), 401, 'not_connected');
    assert.deepEqual(Object.keys(body).sort(), ['code', 'error'], `${token} at ${base}`);
  }
  env.CREATIVE_ROOMS_DEV = '0';
  await refused(await call('dev-ana', ''), 401, 'not_connected');
  delete env.CREATIVE_ROOMS_DEV;
  await refused(await call('dev-ana', ''), 401, 'not_connected');
  env.CREATIVE_ROOMS_DEV = '1';
  assert.deepEqual(await ok(await call('dev-ana', '', { base: 'http://127.0.0.1:8788' })), { rooms: [] });

  // As creative/api.js: the apps send no Origin, so any Origin is a browser, refused for reads too (no CORS).
  for (const origin of ['https://evil.example', 'null', LOCAL, 'https://askeden.com']) {
    await refused(await call('dev-ana', '', { headers: { origin } }), 403, 'forbidden');
    await refused(await call('dev-ana', '', { method: 'POST', body: {}, headers: { origin } }), 403, 'forbidden');
  }
  await refused(await call('dev-ana', '', { method: 'OPTIONS' }), 403, 'forbidden');

  // Identity headers from outside never reach a room.
  const room = await makeRoom();
  await refused(await call('dev-maya', `/${room.id}`, { headers: { 'x-eden-account': 'acct-ana', 'x-eden-email': 'ana%40example.com', 'x-eden-name': 'Ana' } }), 404, 'not_found');
  await refused(await call(null, `/${room.id}`, { headers: { 'x-eden-account': 'acct-ana' } }), 401, 'not_connected');
  // …nor can a path reach an index object.
  await refused(await call('dev-ana', `/${room.id}/idx/list`), 404, 'not_found');
  await refused(await call('dev-ana', '/idx/list'), 404, 'not_found');

  // The stub itself.
  const asAna = (url, e) => verifyCreativeToken(new Request(url, { headers: { authorization: 'Bearer dev-ana' } }), e);
  assert.deepEqual(await asAna('http://localhost/x', env), PEOPLE['dev-ana']);
  assert.equal(await asAna('http://localhost/x', { CREATIVE_ROOMS_DEV_TOKENS: env.CREATIVE_ROOMS_DEV_TOKENS }), null);
  assert.equal(await asAna('http://localhost/x', { CREATIVE_ROOMS_DEV: '1', CREATIVE_ROOMS_DEV_TOKENS: 'not json' }), null);
  assert.equal(await asAna('https://askeden.com/x', env), null);

  // The check is one injectable function: the real one plugs in the same way.
  const real = async () => ({ account: 'acct-ana', name: 'Ana', email: 'ana@example.com' });
  const viaDeps = await roomsApi(new Request('https://askeden.com/api/creative/rooms', { headers: { authorization: 'Bearer es1.real' } }), env, {}, '/api/creative/rooms', { verify: real });
  assert.deepEqual((await ok(viaDeps)).rooms.map((r) => r.id), [room.id]);
  for (const hostile of [{ account: '../x' }, { account: 'me' }, { account: 'a'.repeat(65) }, { account: 7 }, 'acct-ana', null]) {
    await refused(await roomsApi(new Request('https://askeden.com/api/creative/rooms'), env, {}, '/api/creative/rooms', { verify: async () => hostile }), 401, 'not_connected');
  }
  await refused(await roomsApi(new Request('https://askeden.com/api/creative/rooms'), {}, {}, '/api/creative/rooms', { verify: real }), 503, 'not_set_up');
});

test('the real check: a `creative` token verified in its account object; malformed, wrong, expired, another app’s, revoked or a barred account refused', async () => {
  const realFetch = globalThis.fetch;
  forgetAppleKeys();
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    env.TRIAL_BUDGET_USD = '1';
    env.ACCOUNTS = namespace(Account, env);
    env.LINKS = namespace(Link, env);
    const made = await worker.fetch(new Request('https://askeden.com/api/account/apple', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ identity_token: await identityToken({ sub: 'rooms-ana' }), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } }) }), env, {});
    assert.equal(made.status, 200, await made.clone().text());
    const account = (await made.json()).account.id;
    const object = env.ACCOUNTS.objects.get(account);
    await object.storage.put('identities', [{ provider: 'google', sub_hash: 'x', email: 'ana.real@example.com', added: Date.now() }]);
    // A connection as the link flow leaves it (accounts/scoped.js `scoped:<id>`; creative.test.js runs the flow itself).
    const mint = async (client = 'creative', expires = Date.now() + 86400_000) => {
      const id = [...randomBytes(8)].map((b) => b.toString(16).padStart(2, '0')).join('');
      const secret = b64url(randomBytes(32));
      await object.storage.put(`scoped:${id}`, { id, client, scope: client === 'creative' ? 'creative' : 'ask', secret_hash: await sha256Hex(secret), created: Date.now(), expires, last_used: Date.now() });
      return { id, secret, token: `es1.${account}.${id}.${secret}` };
    };
    const good = await mint();
    const real = (token, path = '', init = {}) => call(token, path, { base: 'https://askeden.com', ...init });
    const { room } = await ok(await real(good.token, '', { method: 'POST', body: { name: 'Real' } }), 201);
    assert.deepEqual([room.owner, room.you.key, room.you.email, room.you.name], [account, account, 'ana.real@example.com', 'ana.real@example.com']);
    assert.deepEqual((await ok(await real(good.token))).rooms.map((r) => r.id), [room.id]);
    assert.deepEqual(await verifyCreativeToken(new Request('https://askeden.com/x', { headers: { authorization: `Bearer ${good.token}` } }), env), { account, name: 'ana.real@example.com', email: 'ana.real@example.com' });
    const expired = (await mint('creative', Date.now() - 1)).token;
    for (const bad of ['es1.nope', `es1.${account}.${good.id}.${'x'.repeat(43)}`, `es1.${account}.${'0'.repeat(16)}.${good.secret}`, `jv1.${account}.${good.id}.${good.secret}`, expired, 'dev-ana']) {
      await refused(await real(bad), 401, 'not_connected');
    }
    await refused(await real((await mint('messenger')).token), 403, 'forbidden');
    env.EDEN_ACCOUNTS = 'someone-else';
    await refused(await real(good.token), 403, 'forbidden');
    delete env.EDEN_ACCOUNTS;
    await object.storage.delete(`scoped:${good.id}`); // revoked
    await refused(await real(good.token), 401, 'not_connected');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── people ──

test('a room: made, an invite by email, the invite becomes a member at first sign-in, and the listing shows each', async () => {
  const room = await makeRoom('dev-ana', '  Trailer\u0000 cut ');
  assert.match(room.id, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(room.name, 'Trailer cut');
  assert.equal(room.owner, 'acct-ana');
  assert.equal(room.head, 0);
  assert.equal(room.snapshot, null);
  assert.deepEqual(room.settings, { invite: 'owner' });
  assert.deepEqual(room.you, { key: 'acct-ana', account: 'acct-ana', name: 'Ana', email: 'ana@example.com', role: 'owner', slot: 0, status: 'in', here: false });

  const ana = await connect('dev-ana', room.id);
  const maya = await mailKey('maya@example.com');
  const { member } = await ok(await invite(room.id, ' Maya@Example.com ', 'edit'), 201);
  assert.deepEqual(member, { key: maya, account: null, name: 'maya@example.com', email: 'maya@example.com', role: 'edit', slot: 1, status: 'pending', here: false });
  assert.deepEqual(only(ana.take(), 'members')[0].members.map((m) => [m.key, m.status]), [['acct-ana', 'in'], [maya, 'pending']]);
  await refused(await invite(room.id, 'maya@example.com', 'view'), 409, 'already');
  await refused(await invite(room.id, 'ANA@example.com', 'view'), 409, 'already');

  assert.deepEqual((await ok(await call('dev-maya', ''))).rooms, [{ id: room.id, name: 'Trailer cut', role: 'edit', owner: 'acct-ana', ownerName: 'Ana', status: 'pending' }]);
  assert.deepEqual((await ok(await call('dev-jon', ''))).rooms, []);
  await refused(await call('dev-jon', `/${room.id}`), 404, 'not_found');

  // Maya signs in with that email: she's in, on the slot her invite had.
  const seen = await ok(await call('dev-maya', `/${room.id}`));
  assert.deepEqual(seen.room.you, { key: 'acct-maya', account: 'acct-maya', name: 'Maya', email: 'maya@example.com', role: 'edit', slot: 1, status: 'in', here: false });
  assert.deepEqual(seen.room.members.map((m) => [m.key, m.slot, m.status, m.here]), [['acct-ana', 0, 'in', true], ['acct-maya', 1, 'in', false]]);
  const told = ana.take();
  assert.deepEqual(only(told, 'members')[0].members.map((m) => m.key), ['acct-ana', 'acct-maya']);
  assert.deepEqual(only(told, 'activity').map((f) => [f.activity.kind, f.activity.by, f.activity.text]), [['member', 'acct-maya', 'joined']]);
  assert.deepEqual((await ok(await call('dev-maya', ''))).rooms, [{ id: room.id, name: 'Trailer cut', role: 'edit', owner: 'acct-ana', ownerName: 'Ana', status: 'in' }]);
  assert.equal(indexOf(`idx:mail:${maya.slice(5)}`).storage.map.size, 0, 'the email’s invite is gone from its index');
  assert.deepEqual((await ok(await call('dev-ana', ''))).rooms, [{ id: room.id, name: 'Trailer cut', role: 'owner', owner: 'acct-ana', ownerName: 'Ana', status: 'in' }]);

  // Emails compare lower-cased: Lee's token says Lee@Example.COM.
  await ok(await invite(room.id, 'lee@example.com', 'view'), 201);
  assert.equal((await ok(await call('dev-lee', `/${room.id}`))).room.you.status, 'in');
  // The same person by account can't be invited twice under their email either.
  await refused(await invite(room.id, 'lee@example.com', 'view'), 409, 'already');
});

test('roles: a viewer watches, a commenter comments, an editor edits (and invites only when allowed), only the owner runs the room', async () => {
  const room = await roomWith({ maya: 'edit', jon: 'comment', lee: 'view' });
  const [ana, maya, jon, lee] = [await connect('dev-ana', room.id), await connect('dev-maya', room.id), await connect('dev-jon', room.id), await connect('dev-lee', room.id)];
  for (const ws of [ana, maya, jon, lee]) await hello(room.id, ws);
  const note = { t: 'comment', op: 'add', cid: 'c1', sequence: 1, clip: 2, offset: 0, time: 0, text: 'Hi' };

  await send(room.id, lee, op(1));
  assert.deepEqual(lee.take().map((f) => [f.t, f.code, f.id]), [['error', 'forbidden', 'op-1']]);
  await send(room.id, lee, note);
  assert.deepEqual(lee.take().map((f) => [f.t, f.code, f.cid]), [['error', 'forbidden', 'c1']]);
  await send(room.id, lee, { t: 'note', to: 'acct-ana', text: 'hey' });
  assert.equal(lee.take()[0].code, 'forbidden');
  await send(room.id, jon, op(2));
  assert.deepEqual(jon.take().map((f) => [f.t, f.code, f.id]), [['error', 'forbidden', 'op-2']]);
  await send(room.id, jon, note);
  assert.equal(only(ana.take(), 'comment').length, 1, 'a commenter’s comment reaches everyone');
  await send(room.id, maya, op(3));
  assert.deepEqual(only(ana.take(), 'op').map((f) => [f.seq, f.by]), [[1, 'acct-maya']]);
  assert.equal(roomOf(room.id).storage.map.has('op:0000000000000002'), false, 'nothing but the editor’s op was ordered');

  await refused(await invite(room.id, 'x@example.com', 'view', 'dev-maya'), 403, 'forbidden');
  await ok(await call('dev-ana', `/${room.id}`, { method: 'PATCH', body: { settings: { invite: 'editors' } } }));
  assert.deepEqual(only(maya.take(), 'room'), [{ t: 'room', name: 'Trailer', settings: { invite: 'editors' } }]);
  assert.equal((await ok(await invite(room.id, 'x@example.com', 'view', 'dev-maya'), 201)).member.slot, 4);
  await refused(await invite(room.id, 'y@example.com', 'view', 'dev-jon'), 403, 'forbidden');
  await refused(await invite(room.id, 'y@example.com', 'view', 'dev-lee'), 403, 'forbidden');

  for (const [path, method, body] of [[`/${room.id}/members/acct-jon`, 'PATCH', { role: 'edit' }], [`/${room.id}`, 'PATCH', { name: 'Mine' }], [`/${room.id}`, 'DELETE'], [`/${room.id}/members/acct-jon`, 'DELETE']]) {
    await refused(await call('dev-maya', path, { method, body }), 403, 'forbidden');
  }
  await refused(await putSnapshot('dev-jon', room.id, new Uint8Array([1]), 0, 'h'), 403, 'forbidden');
  await refused(await putSnapshot('dev-lee', room.id, new Uint8Array([1]), 0, 'h'), 403, 'forbidden');

  await refused(await call('dev-ana', `/${room.id}/members/acct-jon`, { method: 'PATCH', body: { role: 'owner' } }), 400, 'bad_request');
  await refused(await call('dev-ana', `/${room.id}/members/acct-ana`, { method: 'PATCH', body: { role: 'view' } }), 409, 'owner');
  await refused(await call('dev-ana', `/${room.id}/members/me`, { method: 'DELETE' }), 409, 'owner');
  await refused(await call('dev-ana', `/${room.id}/members/acct-nobody`, { method: 'PATCH', body: { role: 'view' } }), 404, 'not_found');

  // The owner makes Jon an editor: his next op goes through at once, and his index entry says so.
  const changed = await ok(await call('dev-ana', `/${room.id}/members/acct-jon`, { method: 'PATCH', body: { role: 'edit' } }));
  assert.equal(changed.member.role, 'edit');
  assert.ok(only(ana.take(), 'members').at(-1).members.some((m) => m.key === 'acct-jon' && m.role === 'edit'));
  jon.take();
  await send(room.id, jon, op(4));
  assert.deepEqual(only(jon.take(), 'op').map((f) => f.seq), [2]);
  assert.equal((await ok(await call('dev-jon', ''))).rooms[0].role, 'edit');

  // A viewer's presence never claims a lock or editing.
  await send(room.id, lee, { t: 'presence', sequence: 1, playhead: 5, selection: [2], lock: 2, doing: 'editing' });
  const p = only(ana.take(), 'presence')[0];
  assert.equal(p.lock, null);
  assert.equal(p.doing, 'viewing');
});

test('slots: 0 for the owner, then one each in invite order, never reused; at most 20 people', async () => {
  const room = await makeRoom();
  const slot = async (email, role = 'edit') => (await ok(await invite(room.id, email, role), 201)).member.slot;
  assert.equal(await slot('maya@example.com'), 1);
  assert.equal(await slot('jon@example.com'), 2);
  await ok(await call('dev-ana', `/${room.id}/members/${encodeURIComponent(await mailKey('maya@example.com'))}`, { method: 'DELETE' }));
  assert.equal(await slot('lee@example.com'), 3);
  assert.equal(await slot('maya@example.com'), 4, 'Maya again: a new slot, never her old one');
  assert.equal((await ok(await call('dev-jon', `/${room.id}`))).room.you.slot, 2);
  await ok(await call('dev-jon', `/${room.id}/members/me`, { method: 'DELETE' }));
  assert.equal(await slot('jon@example.com'), 5);
  const { room: seen } = await ok(await call('dev-ana', `/${room.id}`));
  const slots = seen.members.map((m) => m.slot);
  assert.deepEqual(slots, [0, 3, 4, 5]);
  for (let i = seen.members.length; i < ROOMS.people; i++) await slot(`p${i}@example.com`, 'view');
  await refused(await invite(room.id, 'one-too-many@example.com', 'view'), 409, 'too_many');
});

// ── the log ──

test('ops: one order for everyone, the sender’s copy is its confirmation, and the command is never parsed', async () => {
  const room = await roomWith();
  const ana = await connect('dev-ana', room.id);
  const maya = await connect('dev-maya', room.id);
  await hello(room.id, ana);
  await hello(room.id, maya);
  const big = '{"clip":1152921504606846977,"at":9007199254740993,"name":"\\u00e9"}';
  await Promise.all(Array.from({ length: 12 }, (_, i) => send(room.id, i % 2 ? maya : ana, { t: 'op', id: `${i % 2 ? 'm' : 'a'}${i}`, base: 0, label: `L${i}`, op: big })));
  const a = only(ana.take(), 'op');
  const m = only(maya.take(), 'op');
  assert.deepEqual(a.map((f) => f.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.deepEqual(m, a, 'both see the same entries in the same order');
  assert.deepEqual(a.filter((f) => f.by === 'acct-ana').map((f) => f.id).sort(), ['a0', 'a10', 'a2', 'a4', 'a6', 'a8']);
  assert.deepEqual(a.filter((f) => f.by === 'acct-maya').map((f) => f.id).sort(), ['m1', 'm11', 'm3', 'm5', 'm7', 'm9']);
  for (const f of a) {
    assert.equal(f.op, big);
    assert.equal(f.name, f.by === 'acct-ana' ? 'Ana' : 'Maya');
    assert.equal(f.slot, f.by === 'acct-ana' ? 0 : 1);
    assert.equal(f.via, null);
    assert.equal(f.note, null);
    assert.equal(typeof f.at, 'number');
  }
  assert.equal((await ok(await call('dev-maya', `/${room.id}`))).room.head, 12);
  const keys = [...roomOf(room.id).storage.map.keys()].filter((k) => k.startsWith('op:')).sort();
  assert.equal(keys.length, 12);
  assert.equal(keys[0], 'op:0000000000000001');

  // An integer id stays an integer; a label and note are cleaned.
  await send(room.id, ana, { t: 'op', id: 77, base: 12, label: 'Trim\nclip', note: 'why', op: 'x' });
  const [entry] = only(maya.take(), 'op');
  assert.deepEqual([entry.seq, entry.id, entry.label, entry.note, entry.base], [13, 77, 'Trim clip', 'why', 12]);
});

test('ops: a re-sent id answers its entry to that socket only; base ahead, oversize and malformed ops are refused', async () => {
  const room = await roomWith();
  const ana = await connect('dev-ana', room.id);
  const maya = await connect('dev-maya', room.id);
  await hello(room.id, ana);
  await hello(room.id, maya);
  await send(room.id, maya, op(1));
  const [first] = only(maya.take(), 'op');
  ana.take();
  await send(room.id, maya, op(1));
  assert.deepEqual(maya.take(), [{ t: 'op', ...first }]);
  assert.deepEqual(ana.take(), [], 'the others hear nothing');
  assert.equal((await ok(await call('dev-ana', `/${room.id}`))).room.head, 1);
  await send(room.id, ana, op(1)); // the same id from someone else is their own op
  assert.equal(only(ana.take(), 'op')[0].seq, 2);
  maya.take();

  const errors = async (msg) => {
    await send(room.id, maya, msg);
    return maya.take().map((f) => [f.t, f.code, f.id]);
  };
  assert.deepEqual(await errors(op(5, { base: 3 })), [['error', 'bad_base', 'op-5']]);
  assert.deepEqual(await errors(op(6, { op: 'x'.repeat(ROOMS.opBytes + 1) })), [['error', 'too_big', 'op-6']]);
  assert.deepEqual(await errors(op(7, { op: 'é'.repeat(ROOMS.opBytes / 2 + 1) })), [['error', 'too_big', 'op-7']], 'bytes, not characters');
  assert.deepEqual(await errors(op(8, { base: 2 ** 53 })), [['error', 'bad_request', 'op-8']]);
  assert.deepEqual(await errors(op(9, { base: -1 })), [['error', 'bad_request', 'op-9']]);
  assert.deepEqual(await errors(op(10, { via: 'siri' })), [['error', 'bad_request', 'op-10']]);
  assert.deepEqual(await errors(op(11, { op: { not: 'a string' } })), [['error', 'bad_request', 'op-11']]);
  assert.deepEqual(await errors(op(12, { op: '' })), [['error', 'bad_request', 'op-12']]);
  assert.deepEqual(await errors(op(13, { label: 'x'.repeat(201) })), [['error', 'too_big', 'op-13']]);
  assert.deepEqual(await errors(op(14, { label: 5 })), [['error', 'bad_request', 'op-14']]);
  assert.deepEqual(await errors(op(0, { id: undefined })), [['error', 'bad_request', undefined]]);
  assert.deepEqual(await errors(op(0, { id: 'x'.repeat(65) })), [['error', 'bad_request', undefined]]);
  assert.deepEqual(await errors(op(0, { id: 2 ** 53 })), [['error', 'bad_request', undefined]]);
  assert.deepEqual(await errors(op(0, { id: 'a b' })), [['error', 'bad_request', undefined]]);
  assert.deepEqual(await errors('not json'), [['error', 'bad_request', undefined]]);
  assert.deepEqual(await errors('[1,2]'), [['error', 'bad_request', undefined]]);
  assert.deepEqual(await errors({ t: 'teleport' }), [['error', 'bad_request', undefined]]);
  assert.deepEqual(await errors('x'.repeat(ROOMS.frame + 1)), [['error', 'too_big', undefined]]);
  await roomOf(room.id).webSocketMessage(maya, new ArrayBuffer(8));
  assert.equal(maya.take()[0].code, 'bad_request');
  assert.equal((await ok(await call('dev-ana', `/${room.id}`))).room.head, 2, 'nothing refused was ordered');

  // Exactly the limit is fine.
  await send(room.id, maya, op(20, { base: 2, op: 'x'.repeat(ROOMS.opBytes) }));
  assert.equal(only(maya.take(), 'op')[0].seq, 3);
});

test('ops: 120 per 10 s a socket, then slow_down until the window passes', async () => {
  const room = await roomWith();
  const ana = await connect('dev-ana', room.id);
  const object = roomOf(room.id);
  let now = 1_000_000;
  object.now = () => now;
  for (let i = 0; i < ROOMS.ops; i++) await send(room.id, ana, op(i));
  assert.equal(only(ana.take(), 'op').length, ROOMS.ops);
  await send(room.id, ana, op(500));
  assert.deepEqual(ana.take().map((f) => [f.t, f.code, f.id]), [['error', 'slow_down', 'op-500']]);
  now += ROOMS.opWindow;
  await send(room.id, ana, op(500));
  assert.equal(only(ana.take(), 'op')[0].seq, ROOMS.ops + 1);
});

test('hello: welcome with the tail after `since`, the others’ presence, comments and activity; resync behind the snapshot', async () => {
  const room = await roomWith();
  const ana = await connect('dev-ana', room.id);
  const first = (await hello(room.id, ana))[0];
  assert.equal(first.t, 'welcome');
  assert.deepEqual(first.ops, []);
  assert.equal(first.resync, undefined);
  for (let i = 1; i <= 5; i++) await send(room.id, ana, op(i));
  await send(room.id, ana, { t: 'presence', sequence: 1, playhead: 3 * SECOND, selection: [9], lock: 9, doing: 'editing' });
  await send(room.id, ana, { t: 'comment', op: 'add', sequence: 1, clip: 9, offset: 0, time: SECOND, text: 'Look here' });
  const maya = await connect('dev-maya', room.id);
  const [welcome, ...rest] = await hello(room.id, maya, 2);
  assert.deepEqual(rest, []);
  assert.equal(welcome.t, 'welcome');
  assert.equal(welcome.you.key, 'acct-maya');
  assert.equal(welcome.room.head, 5);
  assert.deepEqual(welcome.ops.map((e) => [e.seq, e.id]), [[3, 'op-3'], [4, 'op-4'], [5, 'op-5']]);
  assert.deepEqual(welcome.presence, [{ key: 'acct-ana', name: 'Ana', slot: 0, sequence: 1, playhead: 3 * SECOND, selection: [9], lock: 9, doing: 'editing' }]);
  assert.deepEqual(welcome.comments.map((c) => c.text), ['Look here']);
  assert.deepEqual(welcome.activity.slice(0, 2).map((a) => [a.kind, a.text]), [['comment', 'Look here'], ['op', 'Change 5']], 'newest first');
  assert.ok(welcome.room.members.find((m) => m.key === 'acct-ana').here);

  await ok(await putSnapshot('dev-ana', room.id, new Uint8Array([1, 2, 3]), 3, 'h3'));
  assert.equal((await hello(room.id, maya, 1))[0].resync, true);
  const behind = (await hello(room.id, maya, 1))[0];
  assert.equal(behind.ops, undefined);
  assert.deepEqual(behind.room.snapshot, { seq: 3, hash: 'h3', bytes: 3 });
  assert.deepEqual((await hello(room.id, maya, 3))[0].ops.map((e) => e.seq), [4, 5]);
  assert.equal((await hello(room.id, maya, 99))[0].resync, true, 'ahead of the room: start again');
  assert.deepEqual((await hello(room.id, maya, 5))[0].ops, []);
  await send(room.id, maya, { t: 'hello', since: -1 });
  assert.equal(maya.take()[0].code, 'bad_request');
});

test('hello: a tail too long for one frame comes as the welcome then op and comment frames, in order', async () => {
  ROOMS.welcomeBudget = 1000;
  const room = await roomWith();
  const ana = await connect('dev-ana', room.id);
  for (let i = 1; i <= 5; i++) await send(room.id, ana, op(i, { op: 'x'.repeat(400) }));
  for (let i = 1; i <= 3; i++) await send(room.id, ana, { t: 'comment', op: 'add', sequence: 1, clip: null, offset: 0, time: 0, text: `${i}`.repeat(400) });
  const maya = await connect('dev-maya', room.id);
  const [welcome, ...rest] = await hello(room.id, maya);
  assert.equal(welcome.more, true);
  assert.deepEqual(welcome.ops.map((e) => e.seq), [1]);
  assert.deepEqual(welcome.comments.map((c) => c.id), [1]);
  assert.deepEqual(rest.map((f) => [f.t, f.seq ?? f.comment.id]), [['op', 2], ['op', 3], ['op', 4], ['op', 5], ['comment', 2], ['comment', 3]]);
});

// ── snapshots ──

test('snapshots: a multi-chunk upload and download round trip; the next one replaces it and the log up to it', async () => {
  const room = await roomWith({ maya: 'edit', jon: 'view' });
  await refused(await call('dev-ana', `/${room.id}/snapshot`), 404, 'not_found');
  const bytes = noise(2.5 * 1024 * 1024);
  assert.deepEqual(await ok(await putSnapshot('dev-ana', room.id, bytes, 0, 'start')), { snapshot: { seq: 0, hash: 'start', bytes: bytes.length } });
  const object = roomOf(room.id);
  const chunks = () => [...object.storage.map.keys()].filter((k) => k.startsWith('snap:'));
  assert.equal(chunks().length, 3, '1 MiB chunks');
  for (const token of ['dev-ana', 'dev-maya', 'dev-jon']) {
    const got = await call(token, `/${room.id}/snapshot`);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('x-seq'), '0');
    assert.equal(got.headers.get('x-hash'), 'start');
    assert.ok(Buffer.from(await got.arrayBuffer()).equals(Buffer.from(bytes)), token);
  }
  assert.deepEqual((await ok(await call('dev-jon', `/${room.id}`))).room.snapshot, { seq: 0, hash: 'start', bytes: bytes.length });

  const ana = await connect('dev-ana', room.id);
  for (let i = 1; i <= 4; i++) await send(room.id, ana, op(i));
  const second = noise(1024 * 1024 + 1);
  await ok(await putSnapshot('dev-maya', room.id, second, 3, 'three'));
  assert.equal(chunks().length, 2, 'the old generation is gone');
  assert.deepEqual([...object.storage.map.keys()].filter((k) => k.startsWith('op:')), ['op:0000000000000004'], 'the log up to the snapshot is gone');
  assert.ok(Buffer.from(await (await call('dev-ana', `/${room.id}/snapshot`)).arrayBuffer()).equals(Buffer.from(second)));

  await refused(await putSnapshot('dev-ana', room.id, second, 2, 'two'), 409, 'bad_seq');
  await refused(await putSnapshot('dev-ana', room.id, second, 5, 'five'), 409, 'bad_seq');
  await refused(await putSnapshot('dev-ana', room.id, second, 'abc', 'x'), 400, 'bad_request');
  await refused(await putSnapshot('dev-ana', room.id, second, 4, 'bad hash'), 400, 'bad_request');
  await refused(await putSnapshot('dev-ana', room.id, new Uint8Array(0), 4, 'four'), 400, 'bad_request');
  ROOMS.snapshotBytes = 1000;
  await refused(await putSnapshot('dev-ana', room.id, noise(1001), 4, 'four'), 413, 'too_big');
  assert.equal(chunks().length, 2, 'a refused upload leaves nothing behind');
  assert.deepEqual((await ok(await call('dev-ana', `/${room.id}`))).room.snapshot, { seq: 3, hash: 'three', bytes: second.length });
});

test('checks: a different hash from another Mac answers diverged, and a snapshot that disagrees with the room’s hash is refused', async () => {
  const room = await roomWith({ maya: 'edit', jon: 'view' });
  const [ana, maya, jon] = [await connect('dev-ana', room.id), await connect('dev-maya', room.id), await connect('dev-jon', room.id)];
  for (const ws of [ana, maya, jon]) await hello(room.id, ws);
  await send(room.id, ana, op(1));
  await send(room.id, ana, op(2));
  for (const ws of [ana, maya, jon]) ws.take();
  await send(room.id, ana, { t: 'check', seq: 2, hash: 'AAA' });
  await send(room.id, jon, { t: 'check', seq: 2, hash: 'AAA' });
  assert.deepEqual([...ana.take(), ...jon.take()], [], 'the same hash: nothing to say');
  await send(room.id, maya, { t: 'check', seq: 2, hash: 'BBB' });
  assert.deepEqual(maya.take(), [{ t: 'diverged', seq: 2 }]);
  assert.deepEqual(ana.take(), []);

  await refused(await putSnapshot('dev-maya', room.id, new Uint8Array([9]), 2, 'BBB'), 409, 'diverged');
  assert.equal((await ok(await call('dev-ana', `/${room.id}`))).room.snapshot, null);
  await ok(await putSnapshot('dev-maya', room.id, new Uint8Array([9]), 2, 'AAA'));
  await send(room.id, maya, { t: 'check', seq: 2, hash: 'BBB' });
  assert.deepEqual(maya.take(), [{ t: 'diverged', seq: 2 }], 'against the snapshot’s hash too');
  await send(room.id, maya, { t: 'check', seq: 1, hash: 'old' });
  assert.deepEqual(maya.take(), [], 'behind the snapshot: nothing to compare');
  for (const bad of [{ seq: 3, hash: 'x' }, { seq: 2 ** 53, hash: 'x' }, { seq: 2, hash: 'a b' }, { seq: 2, hash: 'x'.repeat(129) }]) {
    await send(room.id, maya, { t: 'check', ...bad });
    assert.equal(maya.take()[0].code, 'bad_request', JSON.stringify(bad));
  }
});

test('the log asks for a snapshot at 500 ops past the last one, and refuses ops at 20 000 until one comes', async () => {
  ROOMS.snapshotWanted = 3;
  ROOMS.logMax = 5;
  const room = await roomWith({ maya: 'edit', jon: 'view' });
  const [ana, maya, jon] = [await connect('dev-ana', room.id), await connect('dev-maya', room.id), await connect('dev-jon', room.id)];
  for (let i = 1; i <= 3; i++) await send(room.id, ana, op(i));
  assert.deepEqual(only(ana.take(), 'snapshot_wanted'), [{ t: 'snapshot_wanted', seq: 3 }]);
  assert.deepEqual(only(maya.take(), 'snapshot_wanted'), [{ t: 'snapshot_wanted', seq: 3 }]);
  assert.deepEqual(only(jon.take(), 'snapshot_wanted'), [], 'a viewer can’t upload one');
  await send(room.id, ana, op(4));
  await send(room.id, ana, op(5));
  ana.take();
  maya.take();
  await send(room.id, ana, op(6));
  assert.deepEqual(ana.take().map((f) => [f.t, f.code, f.id]), [['error', 'log_full', 'op-6']]);
  const frames = await hello(room.id, maya, 5);
  assert.deepEqual(frames.map((f) => f.t), ['welcome', 'snapshot_wanted']);
  await ok(await putSnapshot('dev-maya', room.id, new Uint8Array([5]), 5, 'five'));
  await send(room.id, ana, op(6));
  assert.equal(only(ana.take(), 'op')[0].seq, 6);
  // A re-send of an op the snapshot holds is told so, not ordered again.
  await send(room.id, ana, op(2));
  assert.deepEqual(ana.take().map((f) => [f.code, f.id, f.seq]), [['in_snapshot', 'op-2', 2]]);
});

// ── presence, notes, comments, activity ──

test('presence: relayed to the others only, with who it is; never stored; over 30 a second dropped silently', async () => {
  const room = await roomWith({ maya: 'edit', jon: 'view' });
  const [ana, maya] = [await connect('dev-ana', room.id), await connect('dev-maya', room.id)];
  const object = roomOf(room.id);
  let now = 5_000_000;
  object.now = () => now;
  const p = { t: 'presence', sequence: 1, playhead: 762_048_000_123, selection: [5, 6, 5], lock: 5, doing: 'editing' };
  await send(room.id, ana, p);
  assert.deepEqual(maya.take(), [{ t: 'presence', key: 'acct-ana', name: 'Ana', slot: 0, sequence: 1, playhead: 762_048_000_123, selection: [5, 6], lock: 5, doing: 'editing' }]);
  assert.deepEqual(ana.take(), [], 'not back to the sender');
  assert.ok(!JSON.stringify([...object.storage.map.values()]).includes('762048000123'), 'presence is never stored');

  for (let i = 0; i < 40; i++) await send(room.id, ana, { ...p, playhead: i });
  assert.equal(maya.take().length, ROOMS.presence - 1, '30 a second (one already sent this second)');
  assert.deepEqual(ana.take(), [], 'dropped without an error');
  now += 1000;
  await send(room.id, ana, { ...p, playhead: 41 });
  assert.equal(maya.take()[0].playhead, 41);

  for (const bad of [{ playhead: 2 ** 53 }, { selection: 'all' }, { selection: Array.from({ length: 65 }, (_, i) => i) }, { doing: 'dancing' }, { sequence: -2 }, { lock: 1.5 }]) {
    now += 1000;
    await send(room.id, ana, { ...p, ...bad });
    assert.equal(ana.take()[0].code, 'bad_request', JSON.stringify(bad));
  }
  assert.deepEqual(maya.take(), []);

  // A late joiner hears it in the welcome; a runtime without attachments keeps it in memory.
  plainSockets = true;
  const jon = await connect('dev-jon', room.id);
  const [welcome] = await hello(room.id, jon);
  assert.deepEqual(welcome.presence.map((x) => [x.key, x.playhead]), [['acct-ana', 41]]);
  await send(room.id, jon, { t: 'presence', sequence: 1, playhead: 7 });
  assert.deepEqual(only(maya.take(), 'presence').map((x) => [x.key, x.playhead, x.doing]), [['acct-jon', 7, 'viewing']]);
});

test('left: when someone’s last socket closes', async () => {
  const room = await roomWith();
  const ana = await connect('dev-ana', room.id);
  const mac1 = await connect('dev-maya', room.id);
  const mac2 = await connect('dev-maya', room.id);
  mac1.close(1000);
  await roomOf(room.id).webSocketClose(mac1, 1000, 'bye', true);
  assert.deepEqual(ana.take(), [], 'Maya is still here on her other Mac');
  mac2.close(1006);
  await roomOf(room.id).webSocketError(mac2);
  assert.deepEqual(ana.take(), [{ t: 'left', key: 'acct-maya' }]);
  assert.equal((await ok(await call('dev-ana', `/${room.id}`))).room.members.find((m) => m.key === 'acct-maya').here, false);
});

test('notes: delivered only to the person asked, never stored', async () => {
  const room = await roomWith({ maya: 'edit', jon: 'comment', lee: 'view' });
  const [ana, maya, jon] = [await connect('dev-ana', room.id), await connect('dev-maya', room.id), await connect('dev-jon', room.id)];
  const before = JSON.stringify([...roomOf(room.id).storage.map]);
  await send(room.id, jon, { t: 'note', to: 'acct-maya', text: 'Can you look at this cut?', clip: 7 });
  assert.deepEqual(maya.take(), [{ t: 'note', from: 'acct-jon', name: 'Jon', text: 'Can you look at this cut?', clip: 7 }]);
  assert.deepEqual([...ana.take(), ...jon.take()], []);
  assert.equal(JSON.stringify([...roomOf(room.id).storage.map]), before);
  await send(room.id, jon, { t: 'note', to: 'acct-lee', text: 'hi' });
  assert.equal(jon.take()[0].code, 'not_here', 'Lee has no app in the room');
  for (const bad of [{ to: 'acct-nobody', text: 'hi' }, { to: '__proto__', text: 'hi' }, { to: 'acct-maya', text: '' }, { to: 'acct-maya', text: 'x'.repeat(1001) }, { to: 'acct-maya', text: 'hi', clip: 'seven' }]) {
    await send(room.id, jon, { t: 'note', ...bad });
    assert.ok(['not_found', 'bad_request', 'too_big'].includes(jon.take()[0].code), JSON.stringify(bad));
  }
  assert.deepEqual(maya.take(), []);
});

test('comments: add, reply, resolve and delete, mentions of people in the room only, sent to everyone', async () => {
  const room = await roomWith({ maya: 'edit', jon: 'comment' });
  await ok(await invite(room.id, 'pending@example.com', 'view'), 201);
  const [ana, maya, jon] = [await connect('dev-ana', room.id), await connect('dev-maya', room.id), await connect('dev-jon', room.id)];
  const add = { t: 'comment', op: 'add', cid: 'c-1', sequence: 1, clip: 2, offset: SECOND, time: 2 * SECOND, text: '  Too long\r\nhere  ', mentions: ['acct-ana', 'acct-ana'] };
  await send(room.id, maya, add);
  const [made] = only(ana.take(), 'comment');
  assert.equal(made.cid, 'c-1');
  const { at, ...rest } = made.comment;
  assert.equal(typeof at, 'number');
  assert.deepEqual(rest, { id: 1, by: 'acct-maya', name: 'Maya', sequence: 1, clip: 2, offset: SECOND, time: 2 * SECOND, text: 'Too long\nhere', mentions: ['acct-ana'], replies: [], resolved: false, resolvedBy: null });
  assert.deepEqual(only(jon.take(), 'comment'), [made]);
  assert.deepEqual(only(maya.take(), 'comment'), [made]);

  const fails = async (ws, msg) => {
    ws.take();
    await send(room.id, ws, msg);
    return ws.take().map((f) => [f.code, f.cid]);
  };
  assert.deepEqual(await fails(maya, { ...add, mentions: ['acct-jon', 'acct-lee'] }), [['bad_mention', 'c-1']]);
  assert.deepEqual(await fails(maya, { ...add, mentions: [await mailKey('pending@example.com')] }), [['bad_mention', 'c-1']]);
  assert.deepEqual(await fails(maya, { ...add, mentions: ['__proto__'] }), [['bad_mention', 'c-1']]);
  assert.deepEqual(await fails(maya, { ...add, text: 'x'.repeat(4001) }), [['too_big', 'c-1']]);
  assert.deepEqual(await fails(maya, { ...add, text: '  \n ' }), [['bad_request', 'c-1']]);
  assert.deepEqual(await fails(maya, { ...add, time: 2 ** 53 }), [['bad_request', 'c-1']]);
  assert.deepEqual(await fails(maya, { ...add, sequence: undefined }), [['bad_request', 'c-1']]);
  assert.deepEqual(await fails(maya, { ...add, op: 'edit' }), [['bad_request', 'c-1']]);
  assert.deepEqual(await fails(maya, { t: 'comment', op: 'reply', comment: 99, text: 'hm' }), [['not_found', undefined]]);
  assert.equal(made.comment.id, 1);

  await send(room.id, ana, { t: 'comment', op: 'reply', comment: 1, text: 'Agreed', mentions: ['acct-maya'] });
  const replied = only(jon.take(), 'comment')[0].comment;
  assert.deepEqual(replied.replies.map((r) => [r.id, r.by, r.name, r.text, r.mentions]), [[2, 'acct-ana', 'Ana', 'Agreed', ['acct-maya']]]);
  await send(room.id, jon, { t: 'comment', op: 'resolve', comment: 1, resolved: true });
  const resolved = only(ana.take(), 'comment').at(-1).comment;
  assert.deepEqual([resolved.resolved, resolved.resolvedBy], [true, 'acct-jon']);
  assert.deepEqual(await fails(jon, { t: 'comment', op: 'resolve', comment: 1, resolved: 'yes' }), [['bad_request', undefined]]);
  await send(room.id, jon, { t: 'comment', op: 'resolve', comment: 1, resolved: false });
  assert.deepEqual(only(ana.take(), 'comment').at(-1).comment.resolvedBy, null);

  assert.deepEqual(await fails(jon, { t: 'comment', op: 'delete', comment: 1, cid: 'd' }), [['forbidden', 'd']], 'not his, and not the owner');
  await send(room.id, maya, { t: 'comment', op: 'delete', comment: 1, cid: 'd' });
  assert.deepEqual(only(ana.take(), 'comment').at(-1), { t: 'comment', comment: { id: 1, deleted: true }, cid: 'd' });
  assert.ok(![...roomOf(room.id).storage.map.keys()].some((k) => k.startsWith('cm:')));

  // The owner may delete anyone's; a room keeps at most 2000 (comments and replies together).
  await send(room.id, jon, { ...add, mentions: [] });
  const jons = only(ana.take(), 'comment').at(-1).comment.id;
  await send(room.id, ana, { t: 'comment', op: 'delete', comment: jons });
  assert.equal(only(jon.take(), 'comment').at(-1).comment.deleted, true);
  ROOMS.comments = 2;
  await send(room.id, jon, { ...add, mentions: [] });
  await send(room.id, jon, { t: 'comment', op: 'reply', comment: jons + 1, text: 'and' });
  assert.deepEqual(await fails(jon, { ...add, mentions: [] }), [['too_many', 'c-1']]);
});

test('activity: every op, comment and change of people, an op by Eden credited to who asked; paged; the last 1000 kept', async () => {
  const room = await roomWith();
  const maya = await connect('dev-maya', room.id);
  await send(room.id, maya, op(1, { label: 'Tighten the cut', via: 'eden' }));
  const frames = maya.take();
  assert.equal(only(frames, 'op')[0].via, 'eden');
  const { at, n, ...act } = only(frames, 'activity')[0].activity;
  assert.deepEqual(act, { by: 'acct-maya', name: 'Maya', kind: 'op', text: 'asked Eden: Tighten the cut', seq: 1, via: 'eden' });
  await send(room.id, maya, op(2, { label: '' }));
  assert.equal(only(maya.take(), 'activity')[0].activity.text, 'made a change');

  const { activity } = await ok(await call('dev-maya', `/${room.id}/activity`));
  assert.deepEqual(activity.map((a) => [a.kind, a.text]), [['op', 'made a change'], ['op', 'asked Eden: Tighten the cut'], ['member', 'joined'], ['member', 'invited maya@example.com'], ['room', 'made the room']]);
  assert.deepEqual(activity.map((a) => a.n), [5, 4, 3, 2, 1]);
  assert.deepEqual((await ok(await call('dev-maya', `/${room.id}/activity?before=3`))).activity.map((a) => a.n), [2, 1]);
  await refused(await call('dev-maya', `/${room.id}/activity?before=-1`), 400, 'bad_request');
  await refused(await call('dev-jon', `/${room.id}/activity`), 404, 'not_found');

  ROOMS.activityKept = 4;
  for (let i = 3; i <= 8; i++) await send(room.id, maya, op(i));
  const kept = [...roomOf(room.id).storage.map.keys()].filter((k) => k.startsWith('act:'));
  assert.equal(kept.length, 4);
  assert.deepEqual((await ok(await call('dev-maya', `/${room.id}/activity`))).activity.map((a) => a.n), [11, 10, 9, 8]);
});

// ── removal, deletion, the index ──

test('removing a member closes their sockets; leaving and turning down an invite work for anyone', async () => {
  const room = await roomWith({ maya: 'edit', jon: 'comment' });
  await ok(await invite(room.id, 'lee@example.com', 'view'), 201);
  const ana = await connect('dev-ana', room.id);
  const [mac1, mac2] = [await connect('dev-maya', room.id), await connect('dev-maya', room.id)];
  assert.deepEqual(await ok(await call('dev-ana', `/${room.id}/members/acct-maya`, { method: 'DELETE' })), { removed: 'acct-maya' });
  for (const ws of [mac1, mac2]) {
    assert.deepEqual(ws.take(), [{ t: 'removed' }]);
    assert.equal(ws.closed.code, 4001);
  }
  const told = ana.take();
  assert.deepEqual(only(told, 'members')[0].members.map((m) => m.key).includes('acct-maya'), false);
  assert.equal(only(told, 'activity')[0].activity.text, 'removed Maya');
  assert.deepEqual((await ok(await call('dev-maya', ''))).rooms, []);
  await refused(await call('dev-maya', `/${room.id}`), 404, 'not_found');
  await refused(await call('dev-maya', `/${room.id}/socket`, { headers: { upgrade: 'websocket' } }), 404, 'not_found');

  await ok(await call('dev-jon', `/${room.id}/members/me`, { method: 'DELETE' }));
  assert.equal(only(ana.take(), 'activity')[0].activity.text, 'left');
  assert.deepEqual((await ok(await call('dev-lee', ''))).rooms.map((r) => r.status), ['pending']);
  await ok(await call('dev-lee', `/${room.id}/members/me`, { method: 'DELETE' }));
  assert.equal(only(ana.take(), 'activity')[0].activity.text, 'turned down the invitation');
  assert.deepEqual((await ok(await call('dev-lee', ''))).rooms, []);
  await refused(await call('dev-ana', `/${room.id}/members/acct-maya`, { method: 'DELETE' }), 404, 'not_found');
  assert.deepEqual((await ok(await call('dev-ana', `/${room.id}`))).room.members.map((m) => m.key), ['acct-ana']);
});

test('deleting a room: sockets get deleted, its storage is wiped, and every index entry goes', async () => {
  const room = await roomWith({ maya: 'edit' });
  await ok(await invite(room.id, 'jon@example.com', 'view'), 201);
  const [ana, maya] = [await connect('dev-ana', room.id), await connect('dev-maya', room.id)];
  await send(room.id, ana, op(1));
  await send(room.id, maya, { t: 'comment', op: 'add', sequence: 1, clip: 1, offset: 0, time: 0, text: 'x' });
  await ok(await putSnapshot('dev-ana', room.id, noise(1500), 1, 'one'));
  const object = roomOf(room.id);
  object.storage.alarm = Date.now() + 1000;
  object.storage.deleteAlarm = async () => {
    object.storage.alarm = null;
  };
  for (const ws of [ana, maya]) ws.take();
  assert.deepEqual(await ok(await call('dev-ana', `/${room.id}`, { method: 'DELETE' })), { deleted: room.id });
  for (const ws of [ana, maya]) {
    assert.deepEqual(ws.take(), [{ t: 'deleted' }]);
    assert.equal(ws.closed.code, 4002);
  }
  assert.equal(object.storage.map.size, 0);
  assert.equal(object.storage.alarm, null);
  for (const name of ['idx:acct:acct-ana', 'idx:acct:acct-maya', `idx:mail:${(await mailKey('jon@example.com')).slice(5)}`]) {
    assert.equal(indexOf(name).storage.map.has(`r:${room.id}`), false, name);
  }
  for (const token of ['dev-ana', 'dev-maya', 'dev-jon']) assert.deepEqual((await ok(await call(token, ''))).rooms, []);
  await refused(await call('dev-ana', `/${room.id}`), 404, 'not_found');
  await refused(await call('dev-ana', `/${room.id}/socket`, { headers: { upgrade: 'websocket' } }), 404, 'not_found');
  const stale = new Socket();
  stale.att = { sid: 'x', key: 'acct-ana', at: 0, presence: null, pat: 0 };
  await send(room.id, stale, op(2));
  assert.deepEqual(stale.take(), [{ t: 'deleted' }]);
});

test('the listing: rooms owned, invited to and joined; renames reach it; 100 owned at most', async () => {
  const mine = await makeRoom('dev-ana', 'Mine');
  const mayas = await makeRoom('dev-maya', 'Maya’s');
  await ok(await invite(mayas.id, 'ana@example.com', 'comment', 'dev-maya'), 201);
  const jons = await makeRoom('dev-jon', 'Jon’s');
  await ok(await invite(jons.id, 'ana@example.com', 'view', 'dev-jon'), 201);
  await ok(await call('dev-ana', `/${jons.id}`));
  const list = (await ok(await call('dev-ana', ''))).rooms;
  assert.deepEqual(list.map((r) => [r.id, r.name, r.role, r.owner, r.ownerName, r.status]).sort(), [
    [jons.id, 'Jon’s', 'view', 'acct-jon', 'Jon', 'in'],
    [mayas.id, 'Maya’s', 'comment', 'acct-maya', 'Maya', 'pending'],
    [mine.id, 'Mine', 'owner', 'acct-ana', 'Ana', 'in'],
  ].sort());
  await ok(await call('dev-jon', `/${jons.id}`, { method: 'PATCH', body: { name: 'Jon’s cut' } }));
  await ok(await call('dev-maya', `/${mayas.id}`, { method: 'PATCH', body: { name: 'Maya’s cut' } }));
  const names = (await ok(await call('dev-ana', ''))).rooms.map((r) => r.name).sort();
  assert.deepEqual(names, ['Jon’s cut', 'Maya’s cut', 'Mine']);

  ROOMS.owned = 2;
  await makeRoom('dev-ana', 'Second');
  await refused(await call('dev-ana', '', { method: 'POST', body: { name: 'Third' } }), 409, 'too_many');
  assert.equal((await ok(await call('dev-ana', ''))).rooms.filter((r) => r.role === 'owner').length, 2);
});

test('hostile requests: bad emails, roles, names, settings, ids, paths, methods and sizes are refused', async () => {
  const room = await makeRoom('dev-ana', 'x'.repeat(500));
  assert.equal(room.name.length, 80);
  for (const email of ['maya', 'a@b', 'maya@example.com\nBcc: x@y.z', `${'m'.repeat(250)}@example.com`, 'a b@example.com', 42, null, ['maya@example.com']]) {
    await refused(await invite(room.id, email, 'edit'), 400, 'bad_request');
  }
  for (const role of ['owner', 'admin', '', 3]) await refused(await invite(room.id, 'maya@example.com', role), 400, 'bad_request');
  assert.equal((await ok(await call('dev-ana', `/${room.id}/invite`, { method: 'POST', body: { email: 'maya@example.com' } }), 201)).member.role, 'edit');
  for (const body of [{}, { name: 5 }, { settings: { invite: 'everyone' } }, { settings: { invite: 'owner', open: true } }, { settings: [] }]) {
    await refused(await call('dev-ana', `/${room.id}`, { method: 'PATCH', body }), 400, 'bad_request');
  }
  await refused(await call('dev-ana', '', { method: 'POST', body: '{not json' }), 400, 'bad_request');
  await refused(await call('dev-ana', `/${room.id}/invite`, { method: 'POST', body: { email: 'jon@example.com', pad: 'x'.repeat(20_000) } }), 413, 'too_big');
  await refused(await call('dev-ana', '/short'), 404, 'not_found');
  await refused(await call('dev-ana', `/${room.id}/teleport`), 404, 'not_found');
  await refused(await call('dev-ana', `/${room.id}/members`, { method: 'DELETE' }), 404, 'not_found');
  await refused(await call('dev-ana', `/${room.id}/members/..%2Fx`, { method: 'DELETE' }), 404, 'not_found');
  await refused(await call('dev-ana', `/${room.id}/members/acct-ana/x`, { method: 'DELETE' }), 404, 'not_found');
  await refused(await call('dev-ana', `/${room.id}/snapshot`, { method: 'POST' }), 405, 'bad_request');
  await refused(await call('dev-ana', '', { method: 'DELETE' }), 405, 'bad_request');
  await refused(await call('dev-ana', `/${room.id}/socket`), 426, 'bad_request');
  await refused(await call('dev-ana', `/${'A'.repeat(22)}`), 404, 'not_found');
  for (let i = 0; i < ROOMS.socketsPerMember; i++) await connect('dev-ana', room.id);
  await refused(await call('dev-ana', `/${room.id}/socket`, { headers: { upgrade: 'websocket' } }), 429, 'too_many');
});
