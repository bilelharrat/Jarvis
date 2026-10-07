// Chat through the Mac (eden/chat.js chatViaMac) and linking a Mac from the browser
// (eden/session.js linkMac, askeden.com/link). With no ANTHROPIC_API_KEY here (or
// EDEN_CHAT_VIA_MAC = "1"), hosted Eden's turns, routing preview and model list are Eden's on the
// owner's Mac, through its web relay, for the account's owner only: never a delegate or a team
// space, which a subscription can't serve. A browser may approve linking a Mac only within 10
// minutes of signing in, only into its own account, and only a Mac's code.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { Space } from '../src/accounts/space.js';
import { bytesToB64, parseToken } from '../src/accounts/util.js';
import { WEB_RELAY, frame, unframe } from '../src/accounts/webrelay.js';
import { WEB_LINK_MAC_STALE } from '../src/accounts/account.js';
import { VIA_MAC_COMPARE, VIA_MAC_LABEL, VIA_MAC_NEEDS_MAC, VIA_MAC_OFFLINE, VIA_MAC_OWNER_ONLY, labelRoutes, macRouteEvent, viaMacFor } from '../src/eden/via-mac.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const A = '11111111-1111-4111-8111-111111111111'; // the owner
const B = '22222222-2222-4222-8222-222222222222'; // a delegate, a space member
const C = '33333333-3333-4333-8333-333333333333'; // someone else
const DEFAULTS = { ...WEB_RELAY };
const enc = new TextEncoder();
const dec = new TextDecoder();

let env;
let waits;
let cloud;
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;

beforeEach(() => {
  Object.assign(WEB_RELAY, DEFAULTS);
  waits = [];
  cloud = [];
  forgetSessions();
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    cloud.push(url);
    throw new Error(`unexpected fetch ${url}`);
  };
  env = { TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '20', LINK_RATE: rateLimiter(), API_RATE: rateLimiter(), EDEN_RATE: rateLimiter() };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.IDENTITIES = namespace(Identity, env);
  env.SPACES = namespace(Space, env);
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

const browser = async (account) => (await call(env, account, 'web-signin', { account_id: account, create: true, device: { name: 'Eden on the web: Safari on a Mac' } })).token;
const iphone = async (account) => (await call(env, account, 'signin', { account_id: account, device: { name: 'iPhone', kind: 'iphone' } })).token;
const plus = (account) => env.ACCOUNTS.objects.get(account).storage.put('plan', { product_id: 'com.askeden.jarvis.plus.monthly', expires: Date.now() + 30 * 86400_000 });
const object = (account) => env.ACCOUNTS.objects.get(account);

async function hit(p, { method = 'GET', body, session, acting, token, headers = {}, chat = true } = {}) {
  const h = { 'user-agent': 'Mozilla/5.0 Safari/605', ...(chat ? { 'x-jarvis-chat': '1' } : {}), ...headers };
  if (method !== 'GET') h.origin ??= ORIGIN;
  const jar = [];
  if (session) jar.push(`__Host-eden=${session}`);
  if (acting) jar.push(`__Host-eden-as=${acting}`);
  if (jar.length) h.cookie = jar.join('; ');
  if (token) h.authorization = `Bearer ${token}`;
  const init = { method, headers: h };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    h['content-type'] = 'application/json';
  }
  return worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx);
}
const post = (p, body, opts = {}) => hit(p, { method: 'POST', body, ...opts });

/** A Mac asks for a code (POST /api/link/start), as J.A.R.V.I.S. does. */
const macStart = async (name = 'MacBook Pro') => (await post('/api/link/start', { name, kind: 'mac', public_key: bytesToB64(new Uint8Array(32).fill(9)) }, { chat: false })).json();
const macPoll = async (started) => post('/api/link/poll', started, { chat: false });

/** A Mac linked to `account` from its owner's fresh browser (askeden.com/link). */
async function linkedMac(session) {
  const started = await macStart();
  const approved = await post(`/api/web/mac-link/${started.code}/approve`, {}, { session });
  assert.equal(approved.status, 200, await approved.clone().text());
  return (await macPoll(started)).json();
}

/** The Mac opens its web channel: the fake socket the object accepted. */
async function connect(account, mac) {
  const response = await hit('/api/relay/web', { token: mac.token, headers: { upgrade: 'websocket' }, chat: false });
  assert.equal(response.status, 200, await response.clone().text());
  const ws = object(account).ctx.getWebSockets(`web:${mac.device_id}`)[0];
  ws.read = 0;
  return ws;
}

function frames(ws) {
  const out = ws.sent.slice(ws.read).map((m) => (typeof m === 'string' ? JSON.parse(m) : { bin: true, ...unframe(m) }));
  ws.read = ws.sent.length;
  return out;
}

const say = (account, ws, message) => object(account).webSocketMessage(ws, typeof message === 'string' || message instanceof Uint8Array ? message : JSON.stringify(message));

async function request(ws) {
  for (let i = 0; i < 50 && !ws.sent.slice(ws.read).some((m) => typeof m === 'string' && JSON.parse(m).t === 'end'); i++) await tick();
  const got = frames(ws);
  const head = got.find((f) => f.t === 'req');
  assert.ok(head, 'a request reached the Mac');
  const body = dec.decode(Buffer.concat(got.filter((f) => f.bin && f.id === head.id).map((f) => f.payload)));
  return { head, body };
}

/** The Mac answers one request: status, type, body pieces. */
function answer(account, ws, id, { status = 200, type = 'application/json', chunks = [] } = {}) {
  say(account, ws, { t: 'res', id, status, headers: { 'content-type': type } });
  for (const c of chunks) say(account, ws, frame(id, enc.encode(c)));
  say(account, ws, { t: 'end', id });
}

const MAC_META = {
  providers: [
    { id: 'anthropic', name: 'Anthropic', available: true, via: 'claude-cli', reason: null },
    { id: 'openai', name: 'OpenAI', available: false, via: null, reason: 'No OpenAI API key' },
  ],
  models: [
    { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', provider: 'anthropic', tier: 'flagship', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', available: true, vision: true },
    { id: 'claude-fable-5', name: 'Claude Fable 5', provider: 'anthropic', tier: 'flagship', efforts: ['low', 'high'], defaultEffort: 'high', available: true, vision: true },
    { id: 'gpt-6', name: 'GPT-6', provider: 'openai', tier: 'flagship', efforts: ['low'], defaultEffort: 'low', available: false, vision: true },
  ],
  classifier: { mode: 'off', available: false, reason: 'No Gemini API key', model: 'gemini-x' },
  search: { available: true, via: 'claude-cli' },
  scope: 'All models (config: /Users/owner/.config/model-router/model-router.config.json)',
  jarvis: { available: true, reason: null },
  code: { available: true, reason: null },
  local: { available: false, reason: 'No local model is running.', models: [], servers: [{ id: 'ollama', name: 'Ollama', url: 'http://127.0.0.1:11434/v1', available: false, models: [], reason: 'off' }] },
};

const TURN = { messages: [{ role: 'user', content: 'Plan my week' }], settings: { level: 3 } };

// ── chat through the Mac ──

test('no API key: the owner’s turn, preview and model list come from Eden on the Mac, labelled, with nothing spent', async () => {
  const owner = await browser(A);
  const mac = await linkedMac(owner);
  const ws = await connect(A, mac);

  // meta: the Mac's own models, so the model menu matches; nothing of the Mac's paths.
  const metaP = hit('/api/chat/meta', { session: owner });
  const m1 = await request(ws);
  assert.equal(`${m1.head.method} ${m1.head.path}`, 'GET /api/chat/meta');
  assert.equal(m1.head.owner, true);
  answer(A, ws, m1.head.id, { chunks: [JSON.stringify(MAC_META)] });
  const meta = await (await metaP).json();
  assert.deepEqual(meta.models.map((x) => x.id), ['claude-opus-5-5', 'claude-fable-5', 'gpt-6']);
  assert.equal(meta.models[0].efforts.includes('max'), true, 'the Mac’s efforts, not askeden.com’s cap');
  assert.deepEqual(meta.providers.map((p) => [p.id, p.available, p.via]), [['anthropic', true, 'claude-cli'], ['openai', false, null]]);
  assert.equal(meta.hosted.viaMac, true);
  assert.ok(meta.scope.includes(VIA_MAC_LABEL) && meta.scope.includes('Claude Opus 5.5'));
  assert.deepEqual(meta.jarvis, { available: true, reason: null });
  assert.equal(meta.code.available, true);
  assert.deepEqual(meta.local.servers, [{ id: 'ollama', name: 'Ollama', available: false, models: [], reason: 'off' }]);
  assert.ok(!JSON.stringify(meta).includes('/Users/owner') && !JSON.stringify(meta).includes('11434'), 'no paths or addresses');

  // The routing preview: the Mac's router, passed on.
  const routeP = post('/api/route', { prompt: 'Plan my week' }, { session: owner, chat: false });
  const r1 = await request(ws);
  assert.equal(`${r1.head.method} ${r1.head.path}`, 'POST /api/route');
  assert.deepEqual(JSON.parse(r1.body), { prompt: 'Plan my week' });
  answer(A, ws, r1.head.id, { chunks: ['{"pick":{"model":"claude-fable-5"}}'] });
  assert.deepEqual(await (await routeP).json(), { pick: { model: 'claude-fable-5' } });

  // A turn: to Eden's send on the Mac as it was, streamed back, its route event labelled.
  const before = structuredClone(await object(A).storage.get('usage'));
  const sendP = post('/api/chat/send', TURN, { session: owner });
  const s1 = await request(ws);
  assert.equal(`${s1.head.method} ${s1.head.path}`, 'POST /api/chat/send');
  assert.equal(s1.head.owner, true);
  assert.deepEqual(JSON.parse(s1.body), TURN);
  answer(A, ws, s1.head.id, {
    type: 'text/event-stream',
    chunks: ['event: route\ndata: {"model":"claude-fable-5","provider":"anthropic","via":"claude-cli","where":{"place":"cloud","label":"Anthropic cloud"},"notes":["n1"]}\n', '\nevent: text\ndata: {"text":"Mon"}\n\nevent: text\ndata: {"text":"day"}\n\nevent: done\ndata: {}\n\n'],
  });
  const response = await sendP;
  assert.equal(response.status, 200);
  const text = await response.text();
  const route = JSON.parse(/event: route\ndata: (.*)\n\n/.exec(text)[1]);
  assert.equal(route.viaMac, VIA_MAC_LABEL);
  assert.deepEqual(route.where, { place: 'cloud', label: VIA_MAC_LABEL });
  assert.equal(route.notes[0], 'n1');
  assert.match(route.notes[1], /on your Claude subscription/);
  assert.match(text, /event: text\ndata: \{"text":"Mon"\}\n\nevent: text\ndata: \{"text":"day"\}\n\nevent: done/);
  assert.deepEqual(await object(A).storage.get('usage'), before, 'no allowance spent');
  assert.equal(object(A).holds.size, 0, 'nothing held');

  // Compare needs a key; nothing went to a cloud model from here.
  const compare = await post('/api/chat/compare', { ...TURN, models: ['claude-opus-5-5', 'claude-haiku-4-5'] }, { session: owner });
  assert.equal(compare.status, 503);
  assert.deepEqual(await compare.json(), { error: VIA_MAC_COMPARE, code: 'needs_key' });
  assert.deepEqual(cloud, []);
});

test('EDEN_CHAT_VIA_MAC = "1" sends turns to the Mac even with a key here', async () => {
  env.ANTHROPIC_API_KEY = 'sk-test';
  env.EDEN_CHAT_VIA_MAC = '1';
  const owner = await browser(A);
  const ws = await connect(A, await linkedMac(owner));
  const sendP = post('/api/chat/send', TURN, { session: owner });
  const { head } = await request(ws);
  assert.equal(head.path, '/api/chat/send');
  answer(A, ws, head.id, { type: 'text/event-stream', chunks: ['event: done\ndata: {}\n\n'] });
  assert.equal((await sendP).status, 200);
  assert.deepEqual(cloud, []);
});

test('Stop reaches the Mac as a cancel, mid-answer', async () => {
  const owner = await browser(A);
  const ws = await connect(A, await linkedMac(owner));
  const sendP = post('/api/chat/send', TURN, { session: owner });
  const { head } = await request(ws);
  say(A, ws, { t: 'res', id: head.id, status: 200, headers: { 'content-type': 'text/event-stream' } });
  const response = await sendP;
  const reader = response.body.getReader();
  say(A, ws, frame(head.id, enc.encode('event: text\ndata: {"text":"Hel"}\n\n')));
  assert.match(dec.decode((await reader.read()).value), /Hel/, 'streams before the turn ends');
  await reader.cancel(); // the Stop button
  await settle();
  for (let i = 0; i < 20 && !frames(ws).some((f) => f.t === 'cancel' && f.id === head.id); i++) {
    ws.read = 0;
    await tick();
  }
  ws.read = 0;
  assert.ok(frames(ws).some((f) => f.t === 'cancel' && f.id === head.id), 'the Mac is told to stop');
  assert.equal(object(A).webStreams.size, 0);
});

test('offline and no Mac: said plainly, nothing to pick', async () => {
  const owner = await browser(A);
  const none = await post('/api/chat/send', TURN, { session: owner });
  assert.equal(none.status, 503);
  assert.deepEqual(await none.json(), { error: VIA_MAC_NEEDS_MAC, code: 'needs_mac' });
  await linkedMac(owner); // linked, not connected
  const off = await post('/api/chat/send', TURN, { session: owner });
  assert.equal(off.status, 503);
  assert.deepEqual(await off.json(), { error: VIA_MAC_OFFLINE, code: 'mac_offline' });
  assert.equal(VIA_MAC_OFFLINE, 'Your Mac is offline. Eden on askeden.com answers through your Mac until askeden.com has AI provider keys set up.');
  const preview = await post('/api/route', { prompt: 'hi' }, { session: owner, chat: false });
  assert.equal((await preview.json()).code, 'mac_offline');
  const meta = await (await hit('/api/chat/meta', { session: owner })).json();
  assert.ok(meta.providers.every((p) => !p.available && p.reason === VIA_MAC_OFFLINE));
  assert.ok(meta.models.every((x) => !x.available));
  assert.equal(meta.scope, VIA_MAC_OFFLINE);
});

test('only the owner: a delegate and a space member are refused, before anything reaches the Mac', async () => {
  const owner = await browser(A);
  await iphone(A);
  const ws = await connect(A, await linkedMac(owner));
  // A delegate of A's, acting for A.
  const inv = await (await post('/api/web/deleg/invite', { name: 'Sam', from: 'Bilel', cap_usd: 1, features: ['chat'], days: 30 }, { session: owner })).json();
  const sam = await browser(B);
  await post('/api/web/deleg/accept', { code: inv.code }, { session: sam });
  const mine = await (await hit('/api/web/deleg', { session: sam })).json();
  const use = await post('/api/web/deleg/use', { id: mine.mine[0].id }, { session: sam });
  const acting = use.headers.getSetCookie().find((c) => c.startsWith('__Host-eden-as=')).split(';')[0].slice('__Host-eden-as='.length);
  const send = await post('/api/chat/send', TURN, { session: sam, acting });
  assert.equal(send.status, 403);
  assert.deepEqual(await send.json(), { error: VIA_MAC_OWNER_ONLY, code: 'owner_only' });
  assert.equal((await post('/api/route', { prompt: 'hi' }, { session: sam, acting, chat: false })).status, 403);
  const meta = await (await hit('/api/chat/meta', { session: sam, acting })).json();
  assert.ok(meta.models.every((x) => !x.available) && meta.providers.every((p) => p.reason === VIA_MAC_OWNER_ONLY));
  // The account's object refuses a grant's device on the relay too, whatever the Worker did.
  const grant = parseToken(acting);
  const direct = await env.ACCOUNTS.get(A).fetch('https://account/web-forward', {
    method: 'POST',
    headers: { 'x-jarvis-device': grant.device, 'x-jarvis-secret': grant.secret, 'x-eden-stream': '0123456789abcdef', 'x-eden-method': 'POST', 'x-eden-path': '/api/chat/send' },
    body: JSON.stringify(TURN),
  });
  assert.equal(direct.status, 403);
  // A team space member.
  await plus(A);
  const made = await (await post('/api/web/space/create', { name: 'Launch', budget_usd: 2, level: 4, label: 'Bilel' }, { session: owner })).json();
  const { code } = await (await post('/api/web/space/invite', { id: made.space.id }, { session: owner })).json();
  const kim = await browser(C);
  await post('/api/web/space/join', { code, label: 'Kim' }, { session: kim });
  const spaceUse = await post('/api/web/space/use', { id: made.space.id }, { session: kim });
  const inSpace = spaceUse.headers.getSetCookie().find((c) => c.startsWith('__Host-eden-as=')).split(';')[0].slice('__Host-eden-as='.length);
  const spaceSend = await post('/api/chat/send', TURN, { session: kim, acting: inSpace });
  assert.equal(spaceSend.status, 403);
  assert.equal((await spaceSend.json()).code, 'owner_only');
  assert.ok(!frames(ws).some((f) => f.t === 'req'), 'nothing reached the Mac');
});

test('the decision: through the Mac with no key for the turn, or when asked to', () => {
  assert.equal(viaMacFor({}), true);
  assert.equal(viaMacFor({ ANTHROPIC_API_KEY: 'k' }), false);
  assert.equal(viaMacFor({ ANTHROPIC_API_KEY: 'k', EDEN_CHAT_VIA_MAC: '1' }), true);
  assert.equal(viaMacFor({}, null, { hasKeys: true }), false, 'the caller may say it has other providers’ keys');
  assert.equal(viaMacFor({ GEMINI_API_KEY: 'g' }), false, 'a service Gemini or OpenAI key counts too (service-ai.js)');
});

test('route events: a Mac’s local or API-key turns say where they ran; other events pass untouched', async () => {
  assert.deepEqual(macRouteEvent({ provider: 'local', where: { place: 'mac', label: 'On your Mac' } }).where, { place: 'mac', label: 'On your Mac' });
  assert.equal(macRouteEvent({ provider: 'openai', via: 'api', where: { place: 'cloud', label: 'OpenAI cloud' } }).where.label, 'OpenAI cloud, via your Mac');
  // Split across pieces, CRLF or not.
  const stream = new ReadableStream({
    start(c) {
      for (const piece of ['event: text\ndata: {"t', 'ext":"a"}\n\nevent: ro', 'ute\r\ndata: {"via":"claude-cli"}\r\n\r\nevent: done\ndata: {}\n\n']) c.enqueue(enc.encode(piece));
      c.close();
    },
  });
  const text = await new Response(stream.pipeThrough(labelRoutes())).text();
  assert.match(text, /^event: text\ndata: \{"text":"a"\}\n\nevent: route\ndata: .*via your Mac \(Claude Max\).*\n\nevent: done\ndata: \{\}\n\n$/);
});

// ── linking a Mac from the browser ──

test('a browser signed in within 10 minutes links a Mac to its own account; the Mac gets no sync key', async () => {
  const owner = await browser(A);
  const fresh = await (await hit('/api/web/mac-link', { session: owner })).json();
  assert.equal(fresh.fresh, true);
  assert.ok(fresh.seconds === 599 || fresh.seconds === 600, `seconds: ${fresh.seconds}`); // the clock may or may not tick between sign-in and asking
  const started = await macStart('Bilel’s MacBook Pro');
  assert.equal((await macPoll(started)).status, 202);
  const peek = await (await hit(`/api/web/mac-link/${started.code.toLowerCase()}`, { session: owner })).json();
  assert.deepEqual(peek, { code: started.code, name: 'Bilel’s MacBook Pro', kind: 'mac', expires_in: 600, fresh: true });
  const ok = await post(`/api/web/mac-link/${started.code}/approve`, {}, { session: owner });
  assert.equal(ok.status, 200);
  const got = await (await macPoll(started)).json();
  assert.equal(got.account_id, A);
  assert.equal(got.sealed_key, null);
  assert.equal(got.sender_key, null);
  const device = await object(A).storage.get(`dev:${got.device_id}`);
  assert.equal(device.kind, 'mac');
  assert.equal(device.name, 'Bilel’s MacBook Pro');
  // Used: a second approval (anyone's) finds nothing; approved and not yet polled, it's "used".
  assert.equal((await post(`/api/web/mac-link/${started.code}/approve`, {}, { session: await browser(C) })).status, 404);
  const twice = await macStart();
  assert.equal((await post(`/api/web/mac-link/${twice.code}/approve`, {}, { session: owner })).status, 200);
  assert.equal((await post(`/api/web/mac-link/${twice.code}/approve`, {}, { session: await browser(C) })).status, 410);
  assert.equal((await (await macPoll(twice)).json()).account_id, A, 'still the first approver’s');
  // Denied: the Mac hears no.
  const other = await macStart();
  assert.equal((await post(`/api/web/mac-link/${other.code}/deny`, {}, { session: owner })).status, 204);
  assert.equal((await macPoll(other)).status, 410);
});

test('a stale session can’t approve a Mac, here or in the account itself', async () => {
  const owner = await browser(A);
  const token = parseToken(owner);
  const kept = await object(A).storage.get(`dev:${token.device}`);
  await object(A).storage.put(`dev:${token.device}`, { ...kept, created: Date.now() - 11 * 60_000 });
  forgetSessions();
  assert.deepEqual(await (await hit('/api/web/mac-link', { session: owner })).json(), { fresh: false, seconds: 0 });
  const started = await macStart();
  assert.equal((await (await hit(`/api/web/mac-link/${started.code}`, { session: owner })).json()).fresh, false);
  const refused = await post(`/api/web/mac-link/${started.code}/approve`, {}, { session: owner });
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: WEB_LINK_MAC_STALE, code: 'sign_in_again' });
  // The account's object says the same, whatever the Worker did.
  await assert.rejects(call(env, A, 'add-device', { name: 'Mac', kind: 'mac' }, token), (e) => e.status === 403 && e.code === 'sign_in_again');
  assert.equal((await macPoll(started)).status, 202, 'still waiting: nothing was made');
  assert.ok(![...(await object(A).devices())].some((d) => d.kind === 'mac'));
});

test('a browser never approves outside this: not a browser’s code, not by its token, not another kind, not a grant', async () => {
  const owner = await browser(A);
  const token = parseToken(owner);
  // A browser's sign-in code is not a Mac's.
  const webCode = (await (await post('/api/web/link', {})).json()).code;
  const notMac = await hit(`/api/web/mac-link/${webCode}`, { session: owner });
  assert.equal(notMac.status, 403);
  assert.equal((await notMac.json()).code, 'not_a_mac');
  assert.equal((await post(`/api/web/mac-link/${webCode}/approve`, {}, { session: owner })).status, 403);
  assert.equal((await hit('/api/web/mac-link/nope', { session: owner })).status, 404);
  // A Mac's code needs a session at all.
  const started = await macStart();
  assert.equal((await post(`/api/web/mac-link/${started.code}/approve`, {})).status, 401);
  // The apps' route stays the apps': a browser's token is refused there, fresh or not.
  assert.equal((await post(`/api/link/${started.code}/approve`, {}, { token: owner, chat: false, headers: { origin: undefined } })).status, 403);
  // The account's object: a browser approves a Mac only, never a browser or a phone.
  for (const kind of ['web', 'iphone']) {
    await assert.rejects(call(env, A, 'add-device', { name: 'x', kind }, token), (e) => e.status === 403 && e.code === 'forbidden');
  }
  // From another site: refused before anything.
  assert.equal((await post(`/api/web/mac-link/${started.code}/approve`, {}, { session: owner, headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await macPoll(started)).status, 202);
});

test('cross-account: a Mac lands only in the approving browser’s own account, never the one it acts for', async () => {
  const owner = await browser(A);
  await iphone(A);
  const inv = await (await post('/api/web/deleg/invite', { name: 'Sam', from: 'Bilel', cap_usd: 1, features: ['chat'], days: 30 }, { session: owner })).json();
  const sam = await browser(B);
  await post('/api/web/deleg/accept', { code: inv.code }, { session: sam });
  const mine = await (await hit('/api/web/deleg', { session: sam })).json();
  const use = await post('/api/web/deleg/use', { id: mine.mine[0].id }, { session: sam });
  const acting = use.headers.getSetCookie().find((c) => c.startsWith('__Host-eden-as=')).split(';')[0].slice('__Host-eden-as='.length);
  const started = await macStart();
  const ok = await post(`/api/web/mac-link/${started.code}/approve`, {}, { session: sam, acting });
  assert.equal(ok.status, 200);
  const got = await (await macPoll(started)).json();
  assert.equal(got.account_id, B, 'Sam’s own account');
  assert.ok(![...(await object(A).devices())].some((d) => d.kind === 'mac'), 'never the owner’s');
  // A grant's own device can't approve on the owner's account either.
  const grant = parseToken(acting);
  await assert.rejects(call(env, A, 'add-device', { name: 'Mac', kind: 'mac' }, grant), (e) => e.status === 403);
});

test('the /link page: signed in only, under the sign-in page’s policy', async () => {
  const out = await hit('/link', { chat: false });
  assert.equal(out.status, 302);
  assert.equal(out.headers.get('location'), '/signin?return=%2Flink');
  const page = await hit('/link', { session: await browser(A), chat: false });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await hit('/link/link.js', { chat: false })).status, 200);
  assert.equal((await hit('/link/other.js', { chat: false })).status, 302, 'not a file of the page');
});
