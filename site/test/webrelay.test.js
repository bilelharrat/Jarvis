// Eden's web relay (accounts/webrelay.js): hosted Eden's Mac-only requests through the owner's
// Mac's link: the framing, the forward and its answer, streamed server-sent events, Stop
// reaching the Mac, "Your Mac is offline", the caps, and who may ask and answer. The Mac is a
// fake socket in the account's object: what the object sends it lands in `sent`, and the
// Mac's frames go in through the object's webSocketMessage, as the runtime's would.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { bytesToB64, parseToken } from '../src/accounts/util.js';
import { MAC_OFFLINE, MAC_ROUTES, WEB_RELAY, frame, macRoute, unframe } from '../src/accounts/webrelay.js';
import { PRIVACY_MAC_OFFLINE, PRIVACY_NEEDS_MAC } from '../src/eden/chat.js';
import { forgetSessions } from '../src/eden/session.js';
import { CLAUDE_NEEDS_KEY, testOnlyServiceClaude } from '../src/eden/providers.js';
import { Account, Link, appleJwk, identityToken, namespace } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
const DEFAULTS = { ...WEB_RELAY };
const enc = new TextEncoder();
const dec = new TextDecoder();

let env;
let waits;
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;

beforeEach(() => {
  Object.assign(WEB_RELAY, DEFAULTS);
  waits = [];
  forgetAppleKeys();
  forgetSessions();
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    throw new Error(`unexpected fetch ${url}`);
  };
  env = { TRIAL_BUDGET_USD: '1' };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.ASSETS = { fetch: async () => new Response('asset') };
});

after(() => {
  globalThis.fetch = realFetch;
  Object.assign(WEB_RELAY, DEFAULTS);
});

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settle() {
  while (waits.length) await Promise.all(waits.splice(0));
}

async function hit(p, { method = 'GET', body, headers = {}, browser = true, session, token } = {}) {
  const h = { ...headers };
  if (browser) {
    h['user-agent'] ??= SAFARI;
    if (method !== 'GET') h.origin ??= ORIGIN;
  }
  if (session) h.cookie = `__Host-eden=${session}`;
  if (token) h.authorization = `Bearer ${token}`;
  const init = { method, headers: h };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    h['content-type'] ??= 'application/json';
  }
  return worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx);
}

const chat = (p, session, opts = {}) => hit(p, { session, ...opts, headers: { 'x-jarvis-chat': '1', ...(opts.headers || {}) } });

/** An owner: their iPhone, a browser signed in to Eden, and (unless `mac: false`) a linked Mac. */
async function owner({ mac = true } = {}) {
  const phone = await (await hit('/api/account/apple', { method: 'POST', browser: false, body: { identity_token: await identityToken(), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } } })).json();
  const link = await hit('/api/web/link', { method: 'POST', body: {} });
  const { code } = await link.json();
  const linkCookie = link.headers.getSetCookie().find((c) => c.startsWith('__Host-eden-link=')).split(';')[0];
  await hit(`/api/link/${code}/approve`, { method: 'POST', browser: false, token: phone.token, body: {} });
  const done = await hit('/api/web/link/poll', { method: 'POST', body: {}, headers: { cookie: linkCookie } });
  const session = done.headers.getSetCookie().find((c) => c.startsWith('__Host-eden=')).split(';')[0].slice('__Host-eden='.length);
  const out = { phone, session, browser: parseToken(session), account: env.ACCOUNTS.objects.get(phone.account.id) };
  if (mac) out.mac = await linkMac(phone);
  return out;
}

async function linkMac(phone, fill = 7) {
  const started = await (await hit('/api/link/start', { method: 'POST', browser: false, body: { name: 'MacBook Air', kind: 'mac', public_key: bytesToB64(new Uint8Array(32).fill(fill)) } })).json();
  await hit(`/api/link/${started.code}/approve`, { method: 'POST', browser: false, token: phone.token, body: {} });
  return (await hit('/api/link/poll', { method: 'POST', browser: false, body: started })).json();
}

/** The Mac opens its web channel: the fake socket the object accepted. */
async function connect(o, mac = o.mac) {
  const response = await hit('/api/relay/web', { browser: false, token: mac.token, headers: { upgrade: 'websocket' } });
  assert.equal(response.status, 200, await response.clone().text());
  const ws = o.account.ctx.getWebSockets(`web:${mac.device_id}`)[0];
  ws.read = 0;
  return ws;
}

/** What the object sent the Mac since last asked: JSON objects, and { id, body } for bytes. */
function frames(ws) {
  const out = ws.sent.slice(ws.read).map((m) => (typeof m === 'string' ? JSON.parse(m) : { bin: true, ...unframe(m) }));
  ws.read = ws.sent.length;
  return out;
}

const say = (o, ws, message) => o.account.webSocketMessage(ws, typeof message === 'string' || message instanceof Uint8Array ? message : JSON.stringify(message));

/** The Mac's request as it arrived: { head, body }. */
async function request(ws) {
  for (let i = 0; i < 50 && !ws.sent.slice(ws.read).some((m) => typeof m === 'string' && JSON.parse(m).t === 'end'); i++) await tick();
  const got = frames(ws);
  const head = got.find((f) => f.t === 'req');
  const body = dec.decode(Buffer.concat(got.filter((f) => f.bin && f.id === head.id).map((f) => f.payload)));
  assert.ok(got.some((f) => f.t === 'end' && f.id === head.id), 'the request ends');
  return { head, body };
}

/** A Mac that answers every request with answer({ head, body }) → { status, type, chunks }. */
function autoAnswer(o, ws, answer) {
  ws.answer = answer;
  if (ws.auto) return;
  ws.auto = true;
  const send = ws.send.bind(ws);
  const parts = new Map();
  ws.send = (message) => {
    send(message);
    if (typeof message !== 'string') {
      const f = unframe(message);
      parts.get(f.id)?.push(f.payload);
      return;
    }
    const m = JSON.parse(message);
    if (m.t === 'req') parts.set(m.id, [m]);
    if (m.t === 'end' && parts.has(m.id)) {
      const [head, ...body] = parts.get(m.id);
      setImmediate(() => {
        const { status = 200, type = 'application/json', chunks = [] } = ws.answer({ head, body: dec.decode(Buffer.concat(body)) });
        say(o, ws, { t: 'res', id: m.id, status, headers: { 'content-type': type } });
        for (const c of chunks) say(o, ws, frame(m.id, enc.encode(c)));
        say(o, ws, { t: 'end', id: m.id });
      });
    }
  };
}

// ── the framing ──

test('a binary frame is the stream id then the bytes; anything else is not a frame', () => {
  const f = frame('0123456789abcdef', enc.encode('data: hi\n\n'));
  assert.equal(f.byteLength, 16 + 10);
  const back = unframe(f.buffer);
  assert.equal(back.id, '0123456789abcdef');
  assert.equal(dec.decode(back.payload), 'data: hi\n\n');
  assert.equal(unframe(new Uint8Array(4)), null);
  assert.equal(unframe(enc.encode('NOT-AN-ID-AT-ALLxyz')), null);
});

test('only the Mac-only routes hosted Eden needs go through, and only in plain shapes', () => {
  assert.deepEqual([...MAC_ROUTES].sort(), ['GET /api/chat/actions', 'GET /api/chat/code/changes', 'GET /api/chat/jarvis/status', 'GET /api/chat/local', 'GET /api/chat/meta', 'GET /api/chat/projects', 'POST /api/chat/actions/undo', 'POST /api/chat/brief', 'POST /api/chat/code', 'POST /api/chat/code/steer', 'POST /api/chat/jarvis', 'POST /api/chat/mac/send', 'POST /api/chat/meetings/actions', 'POST /api/chat/send', 'POST /api/route']);
  assert.equal(macRoute('POST', '/api/chat/brief'), 'POST /api/chat/brief');
  assert.equal(macRoute('GET', '/api/chat/code/changes?project=%2FUsers%2Fme%2Fapp'), 'GET /api/chat/code/changes');
  for (const [method, target] of [
    ['POST', '/api/chat/keys'],
    ['GET', '/api/chat/keys'],
    ['POST', '/api/chat/projects'],
    ['GET', '/download'],
    ['GET', '/api/route'],
    ['POST', '/api/chat/compare'],
    ['GET', '/api/chat/send'],
    ['GET', '/api/chat/local?fresh=1'],
    ['GET', '/api/chat/jarvis'],
    ['POST', '/api/chat/jarvis/../keys'],
    ['POST', '//evil/api/chat/jarvis'],
    ['POST', '/api/chat/%6aarvis'],
    ['GET', '/api/chat/projects?x=1'],
    ['POST', 'api/chat/jarvis'],
    ['GET', '/api/chat/brief'],
    ['POST', '/api/chat/brief?kind=send'],
  ]) {
    assert.equal(macRoute(method, target), null, `${method} ${target}`);
  }
});

// ── offline ──

test('no Mac linked: "needs your Mac"; a Mac linked but not connected: "Your Mac is offline"', async () => {
  const lone = await owner({ mac: false });
  const r1 = await chat('/api/chat/code', lone.session, { method: 'POST', body: { prompt: 'hi' } });
  assert.equal(r1.status, 503);
  assert.equal((await r1.json()).code, 'needs_mac');

  forgetSessions();
  env.ACCOUNTS.objects.clear();
  const o = await owner();
  const r2 = await chat('/api/chat/jarvis', o.session, { method: 'POST', body: { tool: 'recall', arguments: {} } });
  assert.equal(r2.status, 503);
  assert.deepEqual(await r2.json(), { error: MAC_OFFLINE, code: 'mac_offline' });
  assert.deepEqual(await (await chat('/api/chat/jarvis/status', o.session)).json(), { available: false, reason: MAC_OFFLINE });
  const meta = await (await chat('/api/chat/meta', o.session)).json();
  assert.equal(meta.jarvis.reason, MAC_OFFLINE);
  assert.equal(meta.code.available, false);
});

// ── forwarding ──

test('a Mac-only request goes to the Mac as frames, from the asking browser, and its answer comes back', async () => {
  const o = await owner();
  const ws = await connect(o);
  const pending = chat('/api/chat/jarvis', o.session, { method: 'POST', body: { tool: 'recall', arguments: { query: 'trip' } } });
  const { head, body } = await request(ws);
  assert.equal(head.method, 'POST');
  assert.equal(head.path, '/api/chat/jarvis');
  assert.equal(head.from, o.browser.device, 'the browser device that asked');
  assert.deepEqual(head.headers, { 'content-type': 'application/json' }, 'no cookie, no token, no origin');
  assert.match(head.id, /^[0-9a-f]{16}$/);
  assert.deepEqual(JSON.parse(body), { tool: 'recall', arguments: { query: 'trip' } });
  say(o, ws, { t: 'res', id: head.id, status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'set-cookie': 'x=1' } });
  say(o, ws, frame(head.id, enc.encode('{"text":"Lyon in May",')));
  say(o, ws, frame(head.id, enc.encode('"is_error":false}')));
  say(o, ws, { t: 'end', id: head.id });
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('set-cookie'), null, 'only safe headers come back');
  assert.deepEqual(await response.json(), { text: 'Lyon in May', is_error: false });
  assert.equal(o.account.webStreams.size, 0);

  // The Mac's own refusal (its allowlist, its device check) comes back as an error answer.
  const refused = chat('/api/chat/code/changes?project=%2Ftmp%2Fx', o.session);
  const second = await request(ws);
  assert.equal(second.head.path, '/api/chat/code/changes?project=%2Ftmp%2Fx');
  say(o, ws, { t: 'error', id: second.head.id, status: 403, error: 'Not from this account’s browsers.', code: 'forbidden' });
  const r = await refused;
  assert.equal(r.status, 403);
  assert.deepEqual(await r.json(), { error: 'Not from this account’s browsers.', code: 'forbidden' });

  // Still Mac-only, never forwarded: keys and adding a project folder.
  for (const [p, method] of [['/api/chat/keys', 'GET'], ['/api/chat/keys', 'POST'], ['/api/chat/projects', 'POST']]) {
    const res = await chat(p, o.session, { method, ...(method === 'POST' ? { body: {} } : {}) });
    assert.equal(res.status, 503, p);
    assert.equal((await res.json()).code, 'needs_mac');
  }
  assert.equal(frames(ws).length, 0, 'nothing else reached the Mac');
});

test('the morning brief goes to the Mac like Jarvis does', async () => {
  const o = await owner();
  const ws = await connect(o);
  const pending = chat('/api/chat/brief', o.session, { method: 'POST', body: { kind: 'brief', day: '2026-10-06', tzOffset: -60 } });
  const { head, body } = await request(ws);
  assert.equal(head.path, '/api/chat/brief');
  assert.equal(head.from, o.browser.device);
  assert.deepEqual(JSON.parse(body), { kind: 'brief', day: '2026-10-06', tzOffset: -60 });
  say(o, ws, { t: 'res', id: head.id, status: 200, headers: { 'content-type': 'application/json' } });
  say(o, ws, frame(head.id, enc.encode('{"kind":"brief","events":[]}')));
  say(o, ws, { t: 'end', id: head.id });
  const response = await pending;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { kind: 'brief', events: [] });
});

test('meetings, the Activity timeline and Undo go to the Mac like Jarvis does', async () => {
  const o = await owner();
  const ws = await connect(o);
  for (const [method, path, sent] of [
    ['POST', '/api/chat/meetings/actions', { id: '2026-10-06 1000 Standup' }],
    ['GET', '/api/chat/actions', null],
    ['POST', '/api/chat/actions/undo', { id: 'ea-0123456789ab', confirm: true }],
  ]) {
    const pending = chat(path, o.session, sent ? { method, body: sent } : { method });
    const { head, body } = await request(ws);
    assert.equal(head.method, method);
    assert.equal(head.path, path);
    if (sent) assert.deepEqual(JSON.parse(body), sent);
    say(o, ws, { t: 'res', id: head.id, status: 200, headers: { 'content-type': 'application/json' } });
    say(o, ws, frame(head.id, enc.encode('{"ok":true}')));
    say(o, ws, { t: 'end', id: head.id });
    const response = await pending;
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  }
});

test('a "Use my Mac" turn streams from the Mac like a Code turn (src/chat/mac.ts)', async () => {
  const o = await owner();
  const ws = await connect(o);
  const sent = { messages: [{ role: 'user', content: 'Find my lease' }], mac: { files: true } };
  const pending = chat('/api/chat/mac/send', o.session, { method: 'POST', body: sent });
  const { head, body } = await request(ws);
  assert.equal(head.path, '/api/chat/mac/send');
  assert.deepEqual(JSON.parse(body), sent);
  say(o, ws, { t: 'res', id: head.id, status: 200, headers: { 'content-type': 'text/event-stream' } });
  say(o, ws, frame(head.id, enc.encode('event: mac\ndata: {"id":"m1","state":"running"}\n\n')));
  say(o, ws, { t: 'end', id: head.id });
  const response = await pending;
  assert.equal(response.status, 200);
  assert.match(await response.text(), /event: mac/);
});

test('privacy mode: a private turn is answered on the Mac by its local model, never by Claude here', async () => {
  const calls = [];
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    calls.push(url);
    throw new Error('no cloud for a private turn');
  };
  env.ANTHROPIC_API_KEY = 'sk-fake';
  const turn = { messages: [{ role: 'user', content: 'my lab results say…' }], privacy: true, localModel: 'llama3.2' };
  // No Mac on the account, then a Mac linked but offline: said plainly, nothing sent anywhere.
  const lone = await owner({ mac: false });
  const r1 = await chat('/api/chat/send', lone.session, { method: 'POST', body: turn });
  assert.equal(r1.status, 503);
  assert.deepEqual(await r1.json(), { error: PRIVACY_NEEDS_MAC, code: 'needs_mac' });
  forgetSessions();
  env.ACCOUNTS.objects.clear();
  const o = await owner();
  const r2 = await chat('/api/chat/send', o.session, { method: 'POST', body: turn });
  assert.equal(r2.status, 503);
  assert.deepEqual(await r2.json(), { error: PRIVACY_MAC_OFFLINE, code: 'mac_offline' });
  assert.match(PRIVACY_MAC_OFFLINE, /^Your Mac is offline: privacy mode needs it\./);
  assert.deepEqual((await (await chat('/api/chat/meta', o.session)).json()).local, { available: false, viaMac: true, reason: PRIVACY_MAC_OFFLINE, models: [], servers: [] });
  // Online: the turn goes to Eden's send on the Mac as it was, and its stream comes back.
  const ws = await connect(o);
  const pending = chat('/api/chat/send', o.session, { method: 'POST', body: turn });
  const { head, body } = await request(ws);
  assert.equal(head.method, 'POST');
  assert.equal(head.path, '/api/chat/send');
  assert.deepEqual(JSON.parse(body), turn);
  say(o, ws, { t: 'res', id: head.id, status: 200, headers: { 'content-type': 'text/event-stream' } });
  say(o, ws, frame(head.id, enc.encode('event: route\ndata: {"provider":"local","where":{"place":"mac","label":"On your Mac"}}\n\nevent: text\ndata: {"text":"Private answer"}\n\n')));
  say(o, ws, { t: 'end', id: head.id });
  const response = await pending;
  assert.equal(response.status, 200);
  assert.match(await response.text(), /"label":"On your Mac"[\s\S]*Private answer/);
  // The Mac's own refusal (no local model running) comes back as it said it; still nothing to Claude.
  const none = chat('/api/chat/send', o.session, { method: 'POST', body: turn });
  const again = await request(ws);
  say(o, ws, { t: 'res', id: again.head.id, status: 422, headers: { 'content-type': 'application/json' } });
  say(o, ws, frame(again.head.id, enc.encode('{"error":"Turn on Ollama or LM Studio to use privacy mode."}')));
  say(o, ws, { t: 'end', id: again.head.id });
  const refused = await none;
  assert.equal(refused.status, 422);
  assert.deepEqual(await refused.json(), { error: 'Turn on Ollama or LM Studio to use privacy mode.' });
  // privacy that isn't true or false is refused here; a cloud turn never goes to the Mac.
  assert.equal((await chat('/api/chat/send', o.session, { method: 'POST', body: { ...turn, privacy: 'yes' } })).status, 400);
  assert.ok(!frames(ws).some((f) => f.t === 'req'), 'no request reached the Mac');
  // The local models for the page's picker, from the Mac, without its addresses.
  autoAnswer(o, ws, ({ head: h }) => {
    assert.equal(`${h.method} ${h.path}`, 'GET /api/chat/local');
    return { chunks: [JSON.stringify({ available: true, reason: null, models: [{ id: 'llama3.2', server: 'ollama', serverName: 'Ollama' }], servers: [{ id: 'ollama', name: 'Ollama', url: 'http://127.0.0.1:11434/v1', available: true, models: ['llama3.2'], reason: null }], refused: [] })] };
  });
  assert.deepEqual(await (await chat('/api/chat/local', o.session)).json(), {
    available: true, viaMac: true, reason: null,
    models: [{ id: 'llama3.2', server: 'ollama', serverName: 'Ollama' }],
    servers: [{ id: 'ollama', name: 'Ollama', available: true, models: ['llama3.2'], reason: null }],
  });
  assert.deepEqual(calls, [], 'nothing went to a cloud model');
  delete env.ANTHROPIC_API_KEY;
});

test('online: meta and the Jarvis status come from the Mac; Code is available', async () => {
  env.ANTHROPIC_API_KEY = 'sk-fake'; // Claude here; with no key, chat goes through the Mac (below)
  const o = await owner();
  const ws = await connect(o);
  const asked = [];
  autoAnswer(o, ws, ({ head }) => {
    asked.push(`${head.method} ${head.path}`);
    return { chunks: [JSON.stringify({ available: true, reason: null })] };
  });
  assert.deepEqual(await (await chat('/api/chat/jarvis/status', o.session)).json(), { available: true, reason: null });
  const meta = await (await chat('/api/chat/meta', o.session)).json();
  assert.deepEqual(meta.jarvis, { available: true, reason: null });
  assert.equal(meta.code.available, true);
  assert.deepEqual(asked.sort(), ['GET /api/chat/jarvis/status', 'GET /api/chat/jarvis/status', 'GET /api/chat/local']);
  assert.deepEqual(meta.local, { available: true, viaMac: true, reason: null, models: [], servers: [] });
  // A Mac whose Eden isn't running says so; the page shows why.
  autoAnswer(o, ws, () => ({ status: 502, chunks: [JSON.stringify({ error: 'Eden isn’t running on your Mac.' })] }));
  assert.deepEqual(await (await chat('/api/chat/jarvis/status', o.session)).json(), { available: false, reason: 'Eden isn’t running on your Mac.' });
  delete env.ANTHROPIC_API_KEY;
});

test('a Code turn streams its events as they come, with acks to the Mac; Stop reaches the Mac as a cancel', async () => {
  const o = await owner();
  const ws = await connect(o);
  const response = await (async () => {
    const pending = chat('/api/chat/code', o.session, { method: 'POST', body: { prompt: 'fix it', project: '/tmp/app' } });
    const { head } = await request(ws);
    ws.id = head.id;
    say(o, ws, { t: 'res', id: head.id, status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
    return pending;
  })();
  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const reader = response.body.getReader();
  say(o, ws, frame(ws.id, enc.encode('event: text\ndata: {"text":"Look"}\n\n')));
  assert.equal(dec.decode((await reader.read()).value), 'event: text\ndata: {"text":"Look"}\n\n', 'the first event, before the turn ends');
  say(o, ws, frame(ws.id, enc.encode('event: text\ndata: {"text":"ing"}\n\n')));
  assert.match(dec.decode((await reader.read()).value), /ing/);
  const acks = frames(ws).filter((f) => f.t === 'ack');
  assert.ok(acks.length >= 1 && acks.every((a) => a.id === ws.id && a.n > 0), 'the Mac hears what was delivered');

  await reader.cancel(); // the Stop button
  await settle();
  const cancels = frames(ws).filter((f) => f.t === 'cancel');
  assert.ok(cancels.length >= 1 && cancels.every((c) => c.id === ws.id), 'the Mac is told to stop');
  assert.equal(o.account.webStreams.size, 0);
  // What the Mac still sends for it is dropped.
  say(o, ws, frame(ws.id, enc.encode('late')));
  say(o, ws, { t: 'end', id: ws.id });
});

test('Stop while the Mac is still deciding cancels it there too', async () => {
  const o = await owner();
  const ws = await connect(o);
  const abort = new AbortController();
  const req = new Request(`${ORIGIN}/api/chat/jarvis`, {
    method: 'POST',
    signal: abort.signal,
    headers: { 'x-jarvis-chat': '1', origin: ORIGIN, 'content-type': 'application/json', cookie: `__Host-eden=${o.session}`, 'user-agent': SAFARI },
    body: JSON.stringify({ tool: 'mail_search', arguments: {} }),
  });
  const pending = worker.fetch(req, env, ctx);
  const { head } = await request(ws);
  abort.abort();
  await settle();
  assert.ok(frames(ws).some((f) => f.t === 'cancel' && f.id === head.id));
  const response = await pending;
  assert.equal(response.status, 499);
});

test('the Mac going away ends what it was answering: "offline" before an answer, a broken stream after', async () => {
  const o = await owner();
  const ws = await connect(o);
  const waiting = chat('/api/chat/projects', o.session);
  const streaming = chat('/api/chat/code', o.session, { method: 'POST', body: { prompt: 'go' } });
  for (let i = 0; i < 50 && ws.sent.slice(ws.read).filter((m) => typeof m === 'string' && JSON.parse(m).t === 'end').length < 2; i++) await tick();
  const reqs = frames(ws).filter((f) => f.t === 'req');
  const code = reqs.find((r) => r.path === '/api/chat/code');
  say(o, ws, { t: 'res', id: code.id, status: 200, headers: { 'content-type': 'text/event-stream' } });
  const stream = await streaming;
  ws.close(1006, 'gone');
  await o.account.webSocketClose(ws, 1006);
  const offline = await waiting;
  assert.equal(offline.status, 503);
  assert.deepEqual(await offline.json(), { error: MAC_OFFLINE, code: 'mac_offline' });
  await assert.rejects(stream.text());
  // And with the channel gone, the next request is "offline" straight away.
  const next = await chat('/api/chat/projects', o.session);
  assert.equal(next.status, 503);
  assert.equal((await next.json()).code, 'mac_offline');
});

test('many requests at once, each answered on its own stream', async () => {
  const o = await owner();
  const ws = await connect(o);
  autoAnswer(o, ws, ({ head, body }) => ({ chunks: [JSON.stringify({ echo: JSON.parse(body).text, path: head.path })] }));
  const answers = await Promise.all(Array.from({ length: 12 }, (_, i) => chat('/api/chat/code/steer', o.session, { method: 'POST', body: { turnId: 'a'.repeat(24), text: `n${i}` } })));
  const bodies = await Promise.all(answers.map((r) => r.json()));
  assert.deepEqual(bodies.map((b) => b.echo), Array.from({ length: 12 }, (_, i) => `n${i}`));
  assert.equal(o.account.webStreams.size, 0);
});

// ── caps ──

test('caps: body size, streams at once, time to answer, the window, frame sizes, response size', async () => {
  const o = await owner();
  const ws = await connect(o);

  WEB_RELAY.body = 1000;
  const big = await chat('/api/chat/jarvis', o.session, { method: 'POST', body: { tool: 'recall', arguments: { query: 'x'.repeat(2000) } } });
  assert.equal(big.status, 413);
  assert.equal(frames(ws).length, 0, 'nothing reached the Mac');
  WEB_RELAY.body = DEFAULTS.body;

  WEB_RELAY.streams = 1;
  const first = chat('/api/chat/projects', o.session);
  const one = await request(ws);
  const second = await chat('/api/chat/projects', o.session);
  assert.equal(second.status, 429);
  WEB_RELAY.streams = DEFAULTS.streams;

  say(o, ws, { t: 'error', id: one.head.id, status: 500, error: 'no' });
  assert.equal((await first).status, 500);

  WEB_RELAY.headMs = 30; // this one never gets an answer
  const late = chat('/api/chat/projects', o.session);
  const { head } = await request(ws);
  const timedOut = await late;
  assert.equal(timedOut.status, 504);
  assert.ok(frames(ws).some((f) => f.t === 'cancel' && f.id === head.id && f.why === 'timeout'));
  WEB_RELAY.headMs = DEFAULTS.headMs;

  // A Mac that ignores the window (nobody reading) is cut off.
  WEB_RELAY.window = 1024;
  const flood = chat('/api/chat/code', o.session, { method: 'POST', body: { prompt: 'go' } });
  const f = await request(ws);
  say(o, ws, { t: 'res', id: f.head.id, status: 200, headers: { 'content-type': 'text/event-stream' } });
  const r = await flood;
  for (let i = 0; i < 10; i++) say(o, ws, frame(f.head.id, new Uint8Array(1000)));
  assert.ok(frames(ws).some((x) => x.t === 'cancel' && x.why === 'window'));
  await assert.rejects(r.text());
  WEB_RELAY.window = DEFAULTS.window;

  // A response past its cap is cut off too.
  WEB_RELAY.response = 3000;
  const huge = chat('/api/chat/code', o.session, { method: 'POST', body: { prompt: 'go' } });
  const h = await request(ws);
  say(o, ws, { t: 'res', id: h.head.id, status: 200, headers: { 'content-type': 'text/event-stream' } });
  const hr = await huge;
  const reading = hr.text();
  for (let i = 0; i < 4; i++) say(o, ws, frame(h.head.id, new Uint8Array(1000)));
  await assert.rejects(reading);
  assert.ok(frames(ws).some((x) => x.t === 'cancel' && x.why === 'too_big'));
  WEB_RELAY.response = DEFAULTS.response;

  // Frames past their size close the channel.
  say(o, ws, frame('0123456789abcdef', new Uint8Array(WEB_RELAY.frame + 1)));
  assert.deepEqual(ws.closed, { code: 1009, reason: 'frame too big' });
});

// ── who may ask, who may answer ──

test('only a Mac opens the web channel; only a browser forwards; a Mac answers only its own streams', async () => {
  const o = await owner();
  assert.equal((await hit('/api/relay/web', { browser: false, token: o.phone.token, headers: { upgrade: 'websocket' } })).status, 403, 'not an iPhone');
  assert.equal((await hit('/api/relay/web', { browser: false, token: o.session, headers: { upgrade: 'websocket' } })).status, 403, 'not a browser');
  assert.equal((await hit('/api/relay/web', { browser: false, token: o.mac.token })).status, 426, 'WebSocket only');
  assert.equal((await hit('/api/relay/web', { browser: true, token: o.mac.token, headers: { upgrade: 'websocket', origin: 'https://evil.example' } })).status, 403, 'no foreign Origin');
  const ws = await connect(o);

  // The account's object refuses a forward from anything but a `web` device, and paths outside the list.
  const phone = parseToken(o.phone.token);
  const stub = env.ACCOUNTS.get(o.phone.account.id);
  const forward = (who, path) =>
    stub.fetch('https://account/web-forward', {
      method: 'POST',
      headers: { 'x-jarvis-device': who.device, 'x-jarvis-secret': who.secret, 'x-eden-stream': 'aaaaaaaaaaaaaaaa', 'x-eden-method': 'GET', 'x-eden-path': path },
    });
  assert.equal((await forward(phone, '/api/chat/projects')).status, 403);
  assert.equal((await forward({ device: o.browser.device, secret: 'x'.repeat(43) }, '/api/chat/projects')).status, 401);
  const bad = await forward(o.browser, '/download');
  assert.equal(bad.status, 403);
  assert.equal((await bad.json()).code, 'not_allowed');
  assert.equal(frames(ws).length, 0);

  // A second Mac on the account can't answer the first one's stream; the newest Mac answers.
  const other = await linkMac(o.phone, 9);
  const pending = chat('/api/chat/projects', o.session);
  const { head } = await request(ws);
  const ws2 = await connect(o, other);
  say(o, ws2, { t: 'res', id: head.id, status: 200, headers: { 'content-type': 'application/json' } });
  say(o, ws2, { t: 'end', id: head.id });
  assert.equal(o.account.webStreams.get(head.id).phase, 'head', 'ignored');
  say(o, ws, { t: 'res', id: head.id, status: 200, headers: { 'content-type': 'application/json' } });
  say(o, ws, frame(head.id, enc.encode('{"projects":[]}')));
  say(o, ws, { t: 'end', id: head.id });
  assert.deepEqual(await (await pending).json(), { projects: [] });

  // Signing the Mac out closes its channel.
  await hit(`/api/devices/${other.device_id}`, { method: 'DELETE', browser: false, token: o.phone.token });
  assert.deepEqual(ws2.closed, { code: 4001, reason: 'signed out' });
  // A browser can't cancel another browser's stream: web-cancel only ends the asker's own.
  const mine = chat('/api/chat/projects', o.session);
  const m = await request(ws);
  await stub.fetch('https://account/web-cancel', { method: 'POST', headers: { 'x-jarvis-device': phone.device, 'x-jarvis-secret': phone.secret }, body: JSON.stringify({ id: m.head.id }) });
  assert.ok(o.account.webStreams.has(m.head.id));
  say(o, ws, { t: 'res', id: m.head.id, status: 200, headers: { 'content-type': 'application/json' } });
  say(o, ws, frame(m.head.id, enc.encode('{}')));
  say(o, ws, { t: 'end', id: m.head.id });
  assert.equal((await mine).status, 200);
});

test('Claude without a key here: the owner gets it through their Mac while it’s online; a Claude pick goes to the Mac', async () => {
  testOnlyServiceClaude(false);
  env.ANTHROPIC_API_KEY = 'sk-fake'; // never used for hosted chat
  env.GEMINI_API_KEY = 'gm-fake'; // hosted chat runs here, on Gemini
  try {
    const o = await owner();
    const offline = await (await chat('/api/chat/meta', o.session)).json();
    assert.ok(offline.models.filter((m) => m.provider === 'anthropic').every((m) => !m.available && m.reason === CLAUDE_NEEDS_KEY));
    const ws = await connect(o);
    const seen = [];
    autoAnswer(o, ws, ({ head, body }) => {
      seen.push({ path: head.path, body });
      if (head.path === '/api/chat/send') return { type: 'text/event-stream', chunks: ['event: done\ndata: {"finish":"stop"}\n\n'] };
      return { chunks: [JSON.stringify({ available: true, reason: null })] };
    });
    const meta = await (await chat('/api/chat/meta', o.session)).json();
    const claude = meta.models.filter((m) => m.provider === 'anthropic');
    assert.ok(claude.length && claude.every((m) => m.available && m.keySource === 'mac' && !m.needsKey));
    assert.equal(meta.providers.find((p) => p.id === 'anthropic').via, 'your Mac');
    // The turn itself goes to Eden on the Mac, as sent.
    const sent = { messages: [{ role: 'user', content: 'hi' }], override: { model: 'claude-sonnet-5-5' } };
    const response = await chat('/api/chat/send', o.session, { method: 'POST', body: sent });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /event: done/);
    assert.deepEqual(JSON.parse(seen.find((x) => x.path === '/api/chat/send').body), sent);
  } finally {
    testOnlyServiceClaude(true);
    delete env.ANTHROPIC_API_KEY;
    delete env.GEMINI_API_KEY;
  }
});
