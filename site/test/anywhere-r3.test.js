// Bug sweep round 3, server fixes (askeden/docs/bug-sweep/anywhere/r3-server-fix.md). Each test names the
// finding it covers. The setup is round 2's (anywhere-r2.test.js).
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { CLIENTS, challengeOf } from '../src/accounts/scoped.js';
import { BEARER, TIMING, TRAILER, forgetBearers } from '../src/eden/ask.js';
import { parseSheet, sheetPrompt } from '../src/eden/sheets.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, GEMINI_STREAM, Link, appleJwk, asGemini, claudeAnswer, claudeShaped, identityToken, namespace, rateLimiter, sseBody } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const EXT_ID = 'cgincgeifceekdgpbboafpjdiapafggm';
const EXT = `chrome-extension://${EXT_ID}`;
const SCRIPT = 'AKfycbx_TestScriptId_0123456789abcdef';
const MSG = 'https://messenger.askeden.com';
const BACK = {
  chrome: `https://${EXT_ID}.chromiumapp.org/`,
  excel: `${ORIGIN}/addins/excel/connected`,
  sheets: `https://script.google.com/macros/d/${SCRIPT}/usercallback`,
  messenger: `${MSG}/eden/connected`,
};
const FROM = { chrome: EXT, excel: ORIGIN, sheets: null, messenger: MSG };
const ROUTE = { chrome: '/api/eden/text', excel: '/api/eden/sheet', sheets: '/api/eden/sheet', messenger: '/api/eden/ask' };
const BODY = {
  chrome: { action: 'explain', text: 'photosynthesis' },
  excel: { action: 'ask', app: 'excel', instruction: 'total?', sheet: { range: 'A1:A2', values: [['1'], ['2']] } },
  sheets: { action: 'ask', app: 'sheets', instruction: 'total?', sheet: { range: 'A1:A2', values: [['1'], ['2']] } },
  messenger: { question: 'Where?', messages: [{ author: 'Ben', text: 'Lyon.' }] },
};
const VERIFIER = 'v'.repeat(20) + '-._~' + 'x'.repeat(30);
const savedTiming = { ...TIMING };
const savedBearer = { ...BEARER };

let env;
let waits;
let sent;
let upstream;
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;
const answer = (opts) => () => new Response(sseBody(claudeAnswer({ input: 900, output: 60, ...opts })), { headers: { 'content-type': 'text/event-stream' } });

beforeEach(() => {
  waits = [];
  sent = [];
  Object.assign(TIMING, savedTiming);
  Object.assign(BEARER, savedBearer);
  forgetBearers();
  forgetAppleKeys();
  forgetSessions();
  upstream = answer({ text: ['Their ', 'reply.'] });
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    // Claude on Eden's key for the apps' edits (Claude for everyone, 2026-10-10); Gemini Flash for the rest (R3X2).
    if (url === 'https://api.anthropic.com/v1/messages') {
      sent.push(JSON.parse(init.body));
      return upstream(init);
    }
    if (GEMINI_STREAM.test(url)) {
      sent.push(claudeShaped(url, init));
      return asGemini(await upstream(init));
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  env = { ANTHROPIC_API_KEY: 'sk-test', GEMINI_API_KEY: 'g-test', TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '20', EDEN_SHEETS_SCRIPT_IDS: SCRIPT };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.ASSETS = { fetch: async (req) => new Response(`asset ${new URL(req.url).pathname}`, { headers: { 'content-type': 'text/html' } }) };
});

after(() => {
  globalThis.fetch = realFetch;
  Object.assign(TIMING, savedTiming);
});

async function settle() {
  while (waits.length) await Promise.all(waits.splice(0));
}

async function hit(p, { method = 'GET', body, raw, headers = {}, origin, session, bearer, form, ip, noSettle = false } = {}) {
  const h = { ...headers };
  if (origin != null) h.origin = origin;
  if (session) h.cookie = `__Host-eden=${session}`;
  if (bearer) h.authorization = `Bearer ${bearer}`;
  if (ip) h['cf-connecting-ip'] = ip;
  const init = { method, headers: h };
  if (form) {
    init.body = new URLSearchParams(form).toString();
    h['content-type'] = 'application/x-www-form-urlencoded';
  } else if (raw !== undefined) {
    init.body = raw;
    if (raw instanceof ReadableStream) init.duplex = 'half';
    h['content-type'] ??= 'application/json';
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    h['content-type'] ??= 'application/json';
  }
  const response = await worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx);
  if (!noSettle) await settle();
  return response;
}

const cookieValue = (response, name) => {
  const found = (response.headers.getSetCookie?.() || []).find((c) => c.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1).split(';')[0] : undefined;
};

async function signedIn(sub) {
  const made = await hit('/api/account/apple', { method: 'POST', body: { identity_token: await identityToken({ sub }), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } } });
  assert.equal(made.status, 200, await made.clone().text());
  const owner = await made.json();
  const start = await hit('/api/web/link', { method: 'POST', origin: ORIGIN, body: {} });
  const link = await start.json();
  const linkCookie = `__Host-eden-link=${cookieValue(start, '__Host-eden-link')}`;
  assert.equal((await hit(`/api/link/${link.code}/approve`, { method: 'POST', bearer: owner.token, body: {} })).status, 200);
  const done = await hit('/api/web/link/poll', { method: 'POST', origin: ORIGIN, body: {}, headers: { cookie: linkCookie } });
  return { owner, session: cookieValue(done, '__Host-eden') };
}

const params = async (client, extra = {}) => ({ client_id: client, redirect_uri: BACK[client], state: 'state-r3-anywhere-123456', code_challenge: await challengeOf(VERIFIER), code_challenge_method: 'S256', ...extra });

async function codeFor(session, client) {
  const approve = await hit('/api/eden/connect', { method: 'POST', origin: ORIGIN, session, form: { ...(await params(client)), decision: 'allow' } });
  assert.equal(approve.status, 303, await approve.clone().text());
  return new URL(approve.headers.get('location')).searchParams.get('code');
}

const redeem = (code, client, extra = {}) => hit('/api/eden/token', { method: 'POST', origin: FROM[client], ...extra, body: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: client, redirect_uri: BACK[client] } });

/** A connected account: its tokens for the clients asked for. */
async function connected(sub, clients = ['chrome']) {
  const { owner, session } = await signedIn(sub);
  const tokens = {};
  for (const client of clients) {
    const response = await redeem(await codeFor(session, client), client);
    assert.equal(response.status, 200, await response.clone().text());
    tokens[client] = (await response.json()).access_token;
  }
  return { owner, session, tokens, account: env.ACCOUNTS.objects.get(owner.account.id) };
}

const askAs = (client, bearer, body = BODY[client], extra = {}) => hit(ROUTE[client], { method: 'POST', origin: FROM[client], bearer, body, ...extra });
/** Counts every account-object request, by account. */
function countOps() {
  const ops = [];
  const get = env.ACCOUNTS.get.bind(env.ACCOUNTS);
  env.ACCOUNTS.get = (name) => {
    const stub = get(name);
    return { fetch: (input, init) => (ops.push({ name, op: new URL(input instanceof Request ? input.url : input).pathname.slice(1) }), stub.fetch(input, init)) };
  };
  return ops;
}

/** A stream's text and its trailer: { text, end } (end null when there is none). */
async function trailed(response) {
  const all = await response.text();
  const at = all.lastIndexOf(TRAILER);
  return at < 0 ? { text: all, end: null } : { text: all.slice(0, at), end: JSON.parse(all.slice(at + 1)) };
}
const TRAILED = { headers: { 'x-eden-trailer': '1' } };

const madeUp = (account, i) => `es1.${account}.${i.toString(16).padStart(16, '0')}.${'A'.repeat(43)}`;
/** A Claude whose headers never come: it ends only when the request is aborted. */
const silentClaude = (init) => new Promise((resolve, reject) => {
  init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
});
const bytesOf = async (response) => new Uint8Array(await response.arrayBuffer());
const hasReplacement = (bytes) => bytes.some((b, i) => b === 0xef && bytes[i + 1] === 0xbf && bytes[i + 2] === 0xbd);

// ── R3V1: made-up tokens never lock out a real one ──

test('R3V1: made-up tokens naming an account, from its own network, never keep its real tokens out', async () => {
  const victim = await connected('r3-victim', ['chrome', 'sheets']);
  const id = victim.owner.account.id;
  env.AUTH_RATE = rateLimiter(3);
  const ops = countOps();
  const from = (ip, client, bearer) => askAs(client, bearer, BODY[client], { ip });
  // 10 made-up tokens naming the victim, from the shared network: each refused (401), counted per network.
  for (let i = 0; i < 10; i += 1) assert.equal((await from('1.1.1.1', 'chrome', madeUp(id, i))).status, 401, `made-up ${i}`);
  assert.deepEqual(env.AUTH_RATE.keys, Array(10).fill('eden-bearer:1.1.1.1'));
  // The victim's real tokens from that network: answered, every time, and never counted.
  for (let i = 0; i < 5; i += 1) assert.equal((await from('1.1.1.1', 'chrome', victim.tokens.chrome)).status, 200, `real ${i}`);
  assert.equal((await from('1.1.1.1', 'sheets', victim.tokens.sheets)).status, 200);
  assert.equal(env.AUTH_RATE.keys.length, 10);
  // A made-up token tried again from there is boxed: 429 with no account-object request.
  ops.length = 0;
  for (let i = 0; i < 20; i += 1) {
    const again = await from('1.1.1.1', 'chrome', madeUp(id, 9));
    assert.equal(again.status, 429);
    assert.equal(again.headers.get('retry-after'), '60');
  }
  assert.equal(ops.length, 0, 'a boxed token never reaches the account’s object');
  // Same id, another secret: another token, not boxed (refused by the account's object).
  assert.equal((await from('1.1.1.1', 'chrome', `es1.${id}.${(9).toString(16).padStart(16, '0')}.${'B'.repeat(43)}`)).status, 401);
  // The real token still answers after all that.
  assert.equal((await from('1.1.1.1', 'chrome', victim.tokens.chrome)).status, 200);
});

test('R3V1: disconnect is never a 429: a real token is revoked from a busy network; a boxed one is already gone (204, no account call)', async () => {
  const victim = await connected('r3-disconnect', ['chrome']);
  const id = victim.owner.account.id;
  env.AUTH_RATE = rateLimiter(1);
  const ops = countOps();
  const off = (bearer, ip) => hit('/api/eden/disconnect', { method: 'POST', origin: EXT, bearer, ip });
  for (let i = 0; i < 3; i += 1) assert.equal((await askAs('chrome', madeUp(id, i), BODY.chrome, { ip: '1.1.1.1' })).status, 401);
  // A boxed made-up token: done, without asking the account's object.
  ops.length = 0;
  assert.equal((await off(madeUp(id, 2), '1.1.1.1')).status, 204);
  assert.equal(ops.length, 0);
  // The real token, from the same network: revoked for real.
  assert.equal((await off(victim.tokens.chrome, '1.1.1.1')).status, 204);
  assert.deepEqual(ops.map((o) => o.op), ['scoped-revoke']);
  assert.equal((await askAs('chrome', victim.tokens.chrome, BODY.chrome, { ip: '9.9.9.9' })).status, 401, 'gone everywhere');
});

// ── R3V4: the idle rule before Claude's headers ──

test('R3V4: headers that never come end at idleMs as "<provider> stopped answering" (502), the hold already gone', async () => {
  const { tokens, account } = await connected('r3-headers', ['chrome', 'sheets']);
  TIMING.idleMs = 100;
  TIMING.streamMs = 5000;
  TIMING.bufferedMs = 5000;
  upstream = silentClaude;
  for (const [client, extra] of [['chrome', {}], ['chrome', TRAILED], ['sheets', {}]]) {
    const t0 = Date.now();
    const response = await askAs(client, tokens[client], BODY[client], { ...extra, noSettle: true });
    const took = Date.now() - t0;
    assert.equal(response.status, 502, client);
    const body = await response.json();
    assert.equal(body.code, 'upstream');
    assert.match(body.error, /Google Gemini stopped answering/);
    assert.doesNotMatch(body.error, /Select less/);
    assert.ok(took < 2000, `${client}: ${took} ms (the deadline is 5,000)`);
    assert.equal(account.holds.size, 0, 'let go before the answer, not later');
    await settle();
  }
  // The deadline first (a buffered answer's 150 ms before the 60 s idle rule): still 504 too_slow.
  TIMING.idleMs = 60_000;
  TIMING.bufferedMs = 150;
  const late = await askAs('sheets', tokens.sheets);
  assert.equal(late.status, 504);
  assert.equal((await late.json()).code, 'too_slow');
  assert.equal(account.holds.size, 0);
  // Headers in time, then a normal answer: untouched.
  TIMING.idleMs = 100;
  upstream = answer({ text: ['fine'] });
  assert.equal(await (await askAs('chrome', tokens.chrome)).text(), 'fine');
  // R3X2: the apps' models all stream (no whole-answer stand-in any more), so the idle rule holds for each:
  // headers inside idleMs answer; slower ones end as above.
  upstream = (init) => new Promise((resolve) => setTimeout(() => resolve(answer({ text: ['in ', 'time'] })(init)), 50)); // ½ idleMs
  const whole = await askAs('chrome', tokens.chrome);
  assert.equal(whole.status, 200);
  assert.equal(await whole.text(), 'in time');
  assert.equal(account.holds.size, 0);
});

// ── R3V6: a character split between two deltas ──

test('R3V6: a surrogate pair split over two deltas streams as one character; a lone one at the end as U+FFFD', async () => {
  const { tokens, account } = await connected('r3-pair', ['chrome', 'sheets']);
  upstream = answer({ text: ['a\ud83d', '\ude00b'] });
  const plain = await askAs('chrome', tokens.chrome);
  const bytes = await bytesOf(plain);
  assert.equal(new TextDecoder().decode(bytes), 'a😀b');
  assert.equal(hasReplacement(bytes), false);
  upstream = answer({ text: ['a\ud83d', '\ude00b', ' c\ud83d', '\ude01'] });
  assert.deepEqual(await trailed(await askAs('chrome', tokens.chrome, BODY.chrome, TRAILED)), { text: 'a😀b c😁', end: { answer: 'complete' } });
  // Buffered was already whole.
  upstream = answer({ text: ['a\ud83d', '\ude00b'] });
  assert.equal(await (await askAs('sheets', tokens.sheets)).text(), 'a😀b');
  // A high surrogate with no low half after it: sent at the end, before the trailer, as U+FFFD.
  upstream = answer({ text: ['x\ud83d'] });
  assert.deepEqual(await trailed(await askAs('chrome', tokens.chrome, BODY.chrome, TRAILED)), { text: 'x�', end: { answer: 'complete' } });
  // Cut off right after one: the note follows it.
  upstream = answer({ text: ['y\ud83d'], stop: 'max_tokens' });
  const cut = await askAs('messenger', (await connected('r3-pair-m', ['messenger'])).tokens.messenger, BODY.messenger, TRAILED);
  const { text, end } = await trailed(cut);
  assert.equal(end.answer, 'cut');
  assert.ok(text.startsWith('y�'), JSON.stringify(text));
  assert.equal(account.holds.size, 0);
});

// ── R3V7: sheet.rows against the formulas and the range ──

test('R3V7: with sheet.rows, formulas can’t be taller than values, and rows start at the range’s top row', () => {
  const ask = (sheet) => () => parseSheet({ action: 'ask', app: 'sheets', instruction: 'why?', sheet });
  assert.throws(ask({ range: 'A10:A50', values: [['a'], ['b']], formulas: [['=1'], ['=2'], ['=3'], ['=4']], rows: [10, 50] }), (e) => e.status === 400 && /sheet\.formulas has at most one row per row of values/.test(e.message));
  assert.throws(ask({ range: 'Sheet1!B5:C6', values: [['a', 'b'], ['c', 'd']], rows: [2, 3] }), (e) => e.status === 400 && /from the range’s top row \(5\)/.test(e.message));
  assert.throws(ask({ range: "'Q1!Z9'!C5:D9", values: [['a'], ['b']], rows: [4, 9] }), (e) => e.status === 400);
  // Accepted: rows from the top row on, formulas as tall or shorter, no range, no formulas.
  const fine = parseSheet({ action: 'ask', app: 'sheets', instruction: 'why?', sheet: { range: 'A10:A50', values: [['a'], ['b']], formulas: [['=1'], ['=2']], rows: [10, 50] } });
  assert.match(sheetPrompt(fine).messages.at(-1).content, /A10: =1\nA50: =2/);
  assert.doesNotThrow(ask({ range: 'B5:C9', values: [['a'], ['b']], formulas: [['=1']], rows: [5, 9] }));
  assert.doesNotThrow(ask({ values: [['a'], ['b']], rows: [1, 3] }));
  // Without sheet.rows nothing changed: formulas may be taller.
  assert.doesNotThrow(ask({ range: 'A1:A2', values: [['a']], formulas: [['=1'], ['=2']] }));
});

// ── R3V8: a request already past its deadline never reaches Claude ──

test('R3V8: a body that arrives after the deadline gets 504 too_slow: no hold, no Claude request', async () => {
  const { tokens, account } = await connected('r3-upload', ['sheets', 'chrome']);
  const trickle = (body, ms) => {
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const half = Math.floor(bytes.length / 2);
    return new ReadableStream({
      async start(c) {
        c.enqueue(bytes.slice(0, half));
        await new Promise((r) => setTimeout(r, ms));
        c.enqueue(bytes.slice(half));
        c.close();
      },
    });
  };
  const ops = countOps();
  TIMING.bufferedMs = 100;
  const slow = await askAs('sheets', tokens.sheets, undefined, { raw: trickle(BODY.sheets, 200) });
  assert.equal(slow.status, 504);
  assert.equal((await slow.json()).code, 'too_slow');
  TIMING.streamMs = 100;
  const streamed = await askAs('chrome', tokens.chrome, undefined, { raw: trickle(BODY.chrome, 200), ...TRAILED });
  assert.equal(streamed.status, 504);
  assert.equal((await streamed.json()).code, 'too_slow');
  assert.equal(sent.length, 0, 'Claude never asked');
  assert.deepEqual(ops.filter((o) => o.op === 'scoped-hold').length, 2, 'only the two token checks: no answer hold');
  assert.equal(account.holds.size, 0);
});

// ── R3V3: the consent page says what each app sends ──

test('R3V3: the consent wording names the text around the cursor, the page for Summarize, and Fill’s neighbouring columns', async () => {
  assert.match(CLIENTS.chrome.sends, /the page’s main text or the text around your cursor/);
  assert.match(CLIENTS.chrome.sends, /files you attach/, 'the side panel’s own line is kept');
  for (const app of ['excel', 'sheets']) assert.match(CLIENTS[app].sends, /to fill an empty column, the filled columns beside it/);
  const { session } = await signedIn('r3-consent');
  const chrome = await (await hit(`/eden/connect?${new URLSearchParams(await params('chrome'))}`, { session })).text();
  assert.match(chrome, /the text around your cursor/);
  const sheets = await (await hit(`/eden/connect?${new URLSearchParams(await params('sheets'))}`, { session })).text();
  assert.match(sheets, /the filled columns beside it/);
});
