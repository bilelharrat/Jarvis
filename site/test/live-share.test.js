// Eden Code's Share live through askeden.com (src/accounts/live.js, public/live/): the Mac
// registers and revokes its shares with its own token (nobody else can, not even its account's
// phone or browser), pushes sealed frames on its relay control line, the room keeps what a new
// viewer needs and never anything it could read, caps viewers, rate-limits what they send up and
// ends itself when the share expires. The viewer page opens the Mac's seal (the shared test
// vector) and its scripts are pinned with SRI. Durable Objects in memory (fakes.js).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { LIVE, LiveRoom } from '../src/accounts/live.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { bytesToB64 } from '../src/accounts/util.js';
import { Account, Link, appleJwk, identityToken, namespace, rateLimiter } from './fakes.js';

// The page's script, as a browser would run it but with a `module` to hand its helpers to (the site is ESM).
function load(url) {
  const module = { exports: {} };
  new Function('module', readFileSync(url, 'utf8'))(module);
  return module.exports;
}
const viewer = load(new URL('../public/live/live.js', import.meta.url));
const VECTOR = JSON.parse(readFileSync(new URL('../../tests/fixtures/share_seal_vector.json', import.meta.url), 'utf8'));

class Socket {
  constructor() { this.sent = []; this.closed = null; }
  send(m) { if (this.closed) throw new Error('closed'); this.sent.push(m); }
  close(code, reason) { this.closed = { code, reason }; }
}
LiveRoom.prototype.upgrade = function upgrade(tags) {
  const server = new Socket();
  this.ctx.acceptWebSocket(server, tags);
  return { response: new Response('upgraded', { status: 200, headers: { 'x-upgraded': '1' } }), server };
};

let env;
const waits = [];
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;
const upgrade = { upgrade: 'websocket' };
const SHARE = 'a'.repeat(32);
const sent = (socket) => socket.sent.map((m) => JSON.parse(m));

beforeEach(() => {
  forgetAppleKeys();
  globalThis.fetch = (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/keys') return Promise.resolve(Response.json({ keys: [appleJwk] }));
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  };
  env = { LIVE_RATE: rateLimiter(1000) };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.LIVE_ROOMS = namespace(LiveRoom, env);
});
after(() => { globalThis.fetch = realFetch; });

async function api(path, { method = 'GET', token, body, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.authorization = `Bearer ${token}`;
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  const response = await worker.fetch(new Request(`https://askeden.com/api${path}`, init), env, ctx);
  await Promise.all(waits.splice(0));
  return response;
}

async function signIn(sub = 'apple-user-1') {
  const response = await api('/account/apple', { method: 'POST', body: { identity_token: await identityToken({ sub }), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone', app_version: '1.0' } } });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

async function linkMac(phone) {
  const start = await (await api('/link/start', { method: 'POST', body: { name: 'MacBook', kind: 'mac', public_key: bytesToB64(new Uint8Array(32).fill(7)), app_version: '0.1.6' } })).json();
  await api(`/link/${start.code}/approve`, { method: 'POST', token: phone.token, body: {} });
  return (await api('/link/poll', { method: 'POST', body: { code: start.code, poll: start.poll } })).json();
}

async function owner() {
  const phone = await signIn();
  const mac = await linkMac(phone);
  assert.equal((await api('/relay/listen', { token: mac.token, headers: upgrade })).status, 200);
  const account = env.ACCOUNTS.objects.get(phone.account.id);
  const line = account.ctx.getWebSockets('listen')[0];
  return { phone, mac, account, line };
}

const register = (token, body = {}) => api('/live', { method: 'POST', token, body: { share: SHARE, expires: Date.now() / 1000 + 600, max_viewers: 2, up: true, ...body } });
const room = () => env.LIVE_ROOMS.objects.get(SHARE);
const push = (o, frame) => o.account.webSocketMessage(o.line, JSON.stringify({ type: 'share_push', share: SHARE, ...frame }));
const watch = () => api(`/live/${SHARE}/watch`, { headers: upgrade });

test('only the Mac that made a share registers and revokes it', async () => {
  const o = await owner();
  assert.equal((await register(o.phone.token)).status, 403, "the account's phone can't");
  assert.equal((await register(undefined)).status, 401);
  assert.equal((await register(o.mac.token, { share: 'nope' })).status, 400);
  assert.equal((await register(o.mac.token, { expires: Date.now() / 1000 - 5 })).status, 400);
  const made = await register(o.mac.token, { expires: Date.now() / 1000 + 7 * 86400, max_viewers: 999 });
  assert.equal(made.status, 200, await made.clone().text());
  const body = await made.json();
  assert.ok(body.expires <= Date.now() / 1000 + 86400 + 1, 'a day at most');
  assert.equal(body.max_viewers, LIVE.viewers);
  assert.equal((await register(o.mac.token)).status, 409, 'once');
  // Someone else's Mac can't take the id over, nor revoke it.
  const other = await signIn('apple-user-2');
  const otherMac = await linkMac(other);
  assert.equal((await register(otherMac.token)).status, 409);
  assert.equal((await api(`/live/${SHARE}`, { method: 'DELETE', token: otherMac.token })).status, 404);
  assert.equal((await api(`/live/${SHARE}`, { method: 'DELETE', token: o.phone.token })).status, 403);
  assert.equal((await watch()).status, 200, 'still live');
  assert.equal((await api(`/live/${SHARE}`, { method: 'DELETE', token: o.mac.token })).status, 204);
  assert.equal((await watch()).status, 404, 'revoked: gone at once');
  assert.equal((await register(otherMac.token)).status, 409, 'and its id stays its owner’s');
});

test('pushes reach viewers and a new viewer gets the last full snapshot and what came after', async () => {
  const o = await owner();
  await register(o.mac.token);
  const early = await watch();
  assert.equal(early.status, 200);
  const first = room().ctx.getWebSockets('viewer')[0];
  assert.deepEqual(sent(first)[0], { type: 'hello', expires: sent(first)[0].expires, up: true });
  assert.deepEqual(sent(o.line).at(-1), { type: 'share_viewers', share: SHARE, count: 1 });
  await push(o, { seq: 1, kind: 'full', part: 0, parts: 2, blob: 'QUFB' });
  await push(o, { seq: 1, kind: 'full', part: 1, parts: 2, blob: 'QkJC' });
  await push(o, { seq: 2, kind: 'delta', part: 0, parts: 1, blob: 'Q0ND' });
  assert.deepEqual(sent(first).slice(1).map((m) => [m.seq, m.part, m.blob]), [[1, 0, 'QUFB'], [1, 1, 'QkJC'], [2, 0, 'Q0ND']]);
  await push(o, { seq: 3, kind: 'full', part: 0, parts: 1, blob: 'RERE' });
  await watch();
  const second = room().ctx.getWebSockets('viewer')[1];
  assert.deepEqual(sent(second).slice(1).map((m) => m.blob), ['RERE'], 'only from the latest full one');
  // Not frames: dropped, nothing sent on.
  const before = sent(second).length;
  await push(o, { seq: 4, kind: 'other', part: 0, parts: 1, blob: 'RERE' });
  await push(o, { seq: 4, kind: 'delta', part: 0, parts: 1, blob: '<script>' });
  await push(o, { seq: 4, kind: 'delta', part: 3, parts: 1, blob: 'RERE' });
  await push(o, { seq: 4, kind: 'delta', part: 0, parts: 1, blob: 'x'.repeat(LIVE.part + 4) });
  assert.equal(sent(second).length, before);
  // What the room keeps is what the Mac sealed, as it came: never anything it could read.
  const kept = [...room().ctx.storage.map.entries()].filter(([k]) => k.startsWith('f:')).map(([, v]) => v.blob);
  assert.deepEqual(kept, ['RERE']);
});

test("another account's Mac can't push into a share, nor can a phone's socket", async () => {
  const o = await owner();
  await register(o.mac.token);
  await watch();
  const v = room().ctx.getWebSockets('viewer')[0];
  const other = await signIn('apple-user-2');
  const otherMac = await linkMac(other);
  await api('/relay/listen', { token: otherMac.token, headers: upgrade });
  const otherAccount = env.ACCOUNTS.objects.get(other.account.id);
  const otherLine = otherAccount.ctx.getWebSockets('listen')[0];
  await otherAccount.webSocketMessage(otherLine, JSON.stringify({ type: 'share_push', share: SHARE, seq: 1, kind: 'full', part: 0, parts: 1, blob: 'RVZJTA==' }));
  assert.equal(sent(v).length, 1, 'nothing but the hello');
  // A forged room op with the right account but the wrong device is refused too.
  const forged = await room().fetch(new Request('https://live/push', { method: 'POST', body: JSON.stringify({ account: o.phone.account.id, device: o.phone.device_id, frame: { seq: 1, kind: 'full', part: 0, parts: 1, blob: 'QQ==' } }) }));
  assert.equal(forged.status, 403);
});

test('viewers are capped, what they send up is limited and goes to the Mac sealed as it came', async () => {
  const o = await owner();
  await register(o.mac.token, { max_viewers: 2 });
  assert.equal((await watch()).status, 200);
  assert.equal((await watch()).status, 200);
  assert.equal((await watch()).status, 429, 'two at most');
  assert.equal((await api(`/live/${SHARE}/watch`)).status, 426, 'a WebSocket only');
  const v = room().ctx.getWebSockets('viewer')[0];
  const up = (id, blob = 'c2VhbGVk') => room().webSocketMessage(v, JSON.stringify({ type: 'up', id, blob }));
  await up('0123456789abcdef');
  assert.deepEqual(sent(o.line).at(-1), { type: 'share_up', share: SHARE, id: '0123456789abcdef', blob: 'c2VhbGVk' });
  const count = sent(o.line).length;
  await up('nope');
  await up('0123456789abcdee', '<b>');
  await room().webSocketMessage(v, JSON.stringify({ type: 'push', seq: 1 }));
  assert.equal(sent(o.line).length, count, 'not an up: dropped');
  for (let i = 0; i < LIVE.upPerMinute + 3; i += 1) await up(`${'1'.repeat(15)}${i.toString(16)}`);
  assert.equal(sent(o.line).length, count + LIVE.upPerMinute - 1, 'six a minute a viewer');
  assert.equal(sent(v).at(-1).type, 'slow_down');
  await room().webSocketMessage(v, 'x'.repeat(LIVE.up + 1000));
  assert.equal(v.closed.code, 1009);
  // A share made without up: nothing goes up at all.
  await api(`/live/${SHARE}`, { method: 'DELETE', token: o.mac.token });
  const two = 'b'.repeat(32);
  await api('/live', { method: 'POST', token: o.mac.token, body: { share: two, expires: Date.now() / 1000 + 600, up: false } });
  await api(`/live/${two}/watch`, { headers: upgrade });
  const w = env.LIVE_ROOMS.objects.get(two).ctx.getWebSockets('viewer')[0];
  const before = sent(o.line).length;
  await env.LIVE_ROOMS.objects.get(two).webSocketMessage(w, JSON.stringify({ type: 'up', id: '0123456789abcdef', blob: 'QQ==' }));
  assert.equal(sent(o.line).length, before);
});

test('a share ends by itself: viewers told and closed, every frame gone, the Mac told', async () => {
  const o = await owner();
  await register(o.mac.token);
  await watch();
  const v = room().ctx.getWebSockets('viewer')[0];
  await push(o, { seq: 1, kind: 'full', part: 0, parts: 1, blob: 'QUFB' });
  assert.ok(room().ctx.storage.alarm > Date.now());
  await room().alarm();
  assert.equal(sent(v).at(-1).type, 'ended');
  assert.equal(v.closed.code, 4004);
  assert.deepEqual([...room().ctx.storage.map.keys()], ['meta'], 'a tombstone only');
  assert.deepEqual(sent(o.line).at(-1), { type: 'share_ended', share: SHARE });
  assert.equal(await o.account.storage.get(`live:${SHARE}`), undefined);
  assert.equal((await watch()).status, 404);
});

test('the room asks the Mac for a full snapshot when its history gets too long', async () => {
  const o = await owner();
  await register(o.mac.token);
  await push(o, { seq: 1, kind: 'full', part: 0, parts: 1, blob: 'QUFB' });
  const big = 'Q'.repeat(LIVE.part);
  let seq = 2;
  while (!sent(o.line).some((m) => m.type === 'share_resync')) {
    await push(o, { seq, kind: 'delta', part: 0, parts: 1, blob: big });
    seq += 1;
    assert.ok(seq < 100);
  }
  const kept = [...room().ctx.storage.map.keys()].filter((k) => k.startsWith('f:')).length;
  assert.ok(kept * LIVE.part <= LIVE.history + LIVE.part);
});

test('at most ten live shares an account', async () => {
  const o = await owner();
  for (let i = 0; i < LIVE.shares; i += 1) {
    assert.equal((await register(o.mac.token, { share: i.toString(16).padStart(32, '0') })).status, 200);
  }
  assert.equal((await register(o.mac.token, { share: 'f'.repeat(32) })).status, 429);
});

// ── the viewer page ──

test('the page opens the Mac’s seal and nothing else, and seals what it sends the same way', async () => {
  const link = viewer.parseFragment(`#k=${VECTOR.key}&i=deadbeef.${'s'.repeat(32)}`);
  assert.equal(link.key.length, 32);
  assert.equal(link.invite, `deadbeef.${'s'.repeat(32)}`);
  assert.equal(viewer.parseFragment('#k=short'), null);
  assert.equal(viewer.parseFragment(`#k=${VECTOR.key}&i=<script>`).invite, '');
  const key = await viewer.importKey(link.key, crypto.subtle);
  const down = await viewer.openBlob(key, VECTOR.share, 'down', VECTOR.down.seq, VECTOR.down.blob, crypto.subtle);
  assert.deepEqual(JSON.parse(down), JSON.parse(VECTOR.down.plaintext));
  assert.equal(await viewer.openBlob(key, VECTOR.share, 'down', VECTOR.down.seq + 1, VECTOR.down.blob, crypto.subtle), null);
  assert.equal(await viewer.openBlob(key, 'f'.repeat(32), 'down', VECTOR.down.seq, VECTOR.down.blob, crypto.subtle), null);
  // The page's up seal is the Mac's: the vector's bytes exactly, with its nonce.
  const nonce = Uint8Array.from({ length: 12 }, (_, i) => 100 + i);
  const again = await viewer.sealBlob(key, VECTOR.share, 'up', VECTOR.up.id, VECTOR.up.plaintext, crypto.subtle, nonce);
  assert.equal(again, VECTOR.up.blob.replace(/\s/g, ''));
  const message = await viewer.upMessage(key, VECTOR.share, link.invite, { kind: 'comment', text: 'hi' }, crypto.subtle, crypto);
  assert.match(message.id, /^[0-9a-f]{16}$/);
  const opened = JSON.parse(await viewer.openBlob(key, VECTOR.share, 'up', message.id, message.blob, crypto.subtle));
  assert.equal(opened.invite, link.invite);
  assert.ok(Math.abs(opened.at - Date.now()) < 5000);
});

test('the page joins parts by seq, and a lost part holds nothing up', () => {
  const join = viewer.joiner();
  assert.equal(join({ seq: 1, part: 1, parts: 2, blob: 'b', kind: 'full' }), null);
  assert.deepEqual(join({ seq: 1, part: 0, parts: 2, blob: 'a', kind: 'full' }), { seq: 1, kind: 'full', blob: 'ab' });
  assert.equal(join({ seq: 2, part: 0, parts: 2, blob: 'x', kind: 'delta' }), null);
  assert.deepEqual(join({ seq: 3, part: 0, parts: 1, blob: 'y', kind: 'delta' }), { seq: 3, kind: 'delta', blob: 'y' });
  assert.equal(join({ seq: 2, part: 1, parts: 2, blob: 'z', kind: 'delta' }), null, 'older: dropped');
  assert.equal(viewer.roleOf({ roles: { deadbeef: 'driver' } }, 'deadbeef.x'), 'driver');
  assert.equal(viewer.roleOf({ roles: {} }, 'deadbeef.x'), '', 'a revoked link');
  assert.equal(viewer.roleOf({ comments: true }, ''), 'commenter');
});

test('the page and its files are served pinned: SRI, a strict CSP, no referrer, no framing', async () => {
  const dir = new URL('../public/live/', import.meta.url);
  const html = readFileSync(new URL('index.html', dir), 'utf8');
  for (const name of ['live.js', 'share-view.js', 'share.css']) {
    const sri = `sha384-${createHash('sha384').update(readFileSync(new URL(name, dir))).digest('base64')}`;
    assert.ok(html.includes(`integrity="${sri}"`), `${name}'s SRI is stale: rebuild public/live/index.html's integrity attributes`);
  }
  assert.doesNotMatch(html, /<script>(?!<)/, 'no inline script');
  for (const name of ['live.js', 'share-view.js']) assert.doesNotMatch(readFileSync(new URL(name, dir), 'utf8'), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  // The same drawing and look as the Mac's own page, byte for byte.
  for (const name of ['share-view.js', 'share.css']) {
    assert.equal(readFileSync(new URL(name, dir), 'utf8'), readFileSync(new URL(`../../src/jarvis/web/${name}`, import.meta.url), 'utf8'), `${name} differs from the Mac's`);
  }
  env.ASSETS = { fetch: async (request) => new Response(`asset ${new URL(request.url).pathname}`, { headers: { 'content-type': 'text/html' } }) };
  const pageReply = await worker.fetch(new Request(`https://askeden.com/live/${SHARE}`), env, ctx);
  assert.equal(pageReply.status, 200);
  assert.equal(await pageReply.text(), 'asset /live/');
  const csp = pageReply.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /connect-src 'self' wss:\/\/askeden\.com/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(pageReply.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await worker.fetch(new Request('https://askeden.com/live/live.js'), env, ctx)).status, 200);
  assert.equal((await worker.fetch(new Request('https://askeden.com/live/secret.json'), env, ctx)).status, 404);
  assert.equal((await worker.fetch(new Request('https://askeden.com/live/nothex'), env, ctx)).status, 404);
});
