// Bug sweep round 2, server fixes (askeden/docs/bug-sweep/anywhere/r2-server-fix.md). Each test names the
// finding it covers. The setup is round 1's (anywhere-r1.test.js).
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { challengeOf } from '../src/accounts/scoped.js';
import { BEARER, CUT_NOTE, CUT_OFF, TIMING, TRAILER, forgetBearers } from '../src/eden/ask.js';
import { TEXT, answerTokens, editTokens, parseText, strip, textPrompt, textTokens, utf8Bytes } from '../src/eden/ext.js';
import { priceOf } from '../src/accounts/proxy.js';
import { SHEET, cellsBlock, fillTokens, parseSheet, sheetPrompt, topLeft } from '../src/eden/sheets.js';
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

const params = async (client, extra = {}) => ({ client_id: client, redirect_uri: BACK[client], state: 'state-r2-anywhere-123456', code_challenge: await challengeOf(VERIFIER), code_challenge_method: 'S256', ...extra });

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

// ── R2V1: made-up tokens are limited per network ──

test('R2V1: refused tokens count per network; past the limit that network is kept out for that account, with no account-object request', async () => {
  const { owner, tokens } = await connected('r2-forged', ['chrome']);
  const other = await connected('r2-forged-other', ['chrome']);
  env.AUTH_RATE = rateLimiter(3);
  const ops = countOps();
  const forged = `es1.${owner.account.id}.${'0'.repeat(16)}.${'A'.repeat(43)}`;
  const from = (ip, bearer) => askAs('chrome', bearer, BODY.chrome, { ip });
  for (let i = 0; i < 4; i += 1) assert.equal((await from('9.9.9.9', forged)).status, 401, `try ${i + 1}`);
  assert.deepEqual(env.AUTH_RATE.keys, Array(4).fill('eden-bearer:9.9.9.9'), 'only refusals are counted, per network');
  ops.length = 0;
  for (let i = 0; i < 50; i += 1) {
    const kept = await from('9.9.9.9', forged);
    assert.equal(kept.status, 429);
    assert.equal(kept.headers.get('retry-after'), '60');
  }
  assert.equal(ops.length, 0, 'the account’s object is never asked');
  assert.equal(env.AUTH_RATE.keys.length, 4);
  // The person, from their own network: answered. Another account on the same network: answered.
  assert.equal((await from('1.2.3.4', tokens.chrome)).status, 200);
  assert.equal((await from('9.9.9.9', other.tokens.chrome)).status, 200);
  assert.equal(env.AUTH_RATE.keys.length, 4, 'a good token is never counted');
  // Disconnect with a made-up token: counted too, and kept out while boxed. Round 3 (R3V1): a boxed token
  // was just refused, so disconnect says done (204, never 429) still without asking the account's object.
  ops.length = 0;
  assert.equal((await hit('/api/eden/disconnect', { method: 'POST', origin: EXT, bearer: forged, ip: '9.9.9.9' })).status, 204);
  assert.equal(ops.length, 0);
  assert.equal((await hit('/api/eden/disconnect', { method: 'POST', origin: EXT, bearer: `es1.${other.owner.account.id}.${'1'.repeat(16)}.${'B'.repeat(43)}`, ip: '8.8.8.8' })).status, 204);
  assert.ok(env.AUTH_RATE.keys.includes('eden-bearer:8.8.8.8'));
  // The box ends.
  BEARER.boxMs = 1;
  forgetBearers();
  env.AUTH_RATE = rateLimiter(1);
  await from('7.7.7.7', forged);
  await from('7.7.7.7', forged); // over: boxed for 1 ms
  await new Promise((r) => setTimeout(r, 5));
  ops.length = 0;
  assert.equal((await from('7.7.7.7', forged)).status, 401);
  assert.deepEqual(ops.map((o) => o.op), ['scoped-hold']);
});

test('R2V1: the box is bounded in memory', async () => {
  const { owner } = await connected('r2-box', ['chrome']);
  env.AUTH_RATE = rateLimiter(0);
  BEARER.boxMax = 3;
  const forged = `es1.${owner.account.id}.${'0'.repeat(16)}.${'A'.repeat(43)}`;
  for (const ip of ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4']) assert.equal((await askAs('chrome', forged, BODY.chrome, { ip })).status, 401);
  assert.equal((await askAs('chrome', forged, BODY.chrome, { ip: '4.4.4.4' })).status, 429);
  assert.equal((await askAs('chrome', forged, BODY.chrome, { ip: '1.1.1.1' })).status, 401, 'the oldest went first');
});

// ── R2X13, R2C4: how a stream ended, readable by the client ──

test('R2X13/R2C4: with x-eden-trailer, every stream ends with U+0000 and JSON: complete, cut, or the error and its code', async () => {
  const { tokens, account } = await connected('r2-trailer', ['chrome', 'excel', 'messenger']);
  const ok = await askAs('chrome', tokens.chrome, BODY.chrome, TRAILED);
  assert.equal(ok.headers.get('x-eden-trailer'), '1');
  assert.deepEqual(await trailed(ok), { text: 'Their reply.', end: { answer: 'complete' } });
  upstream = answer({ text: ['No.'], stop: 'refusal' });
  const refused = await trailed(await askAs('chrome', tokens.chrome, { action: 'fix', text: 'teh' }, TRAILED));
  assert.deepEqual(refused.end, { status: 422, code: 'refused', error: 'Eden declined this request. Try asking another way.' });
  upstream = answer({ text: ['=SUM(A1:'], stop: 'max_tokens' });
  const cut = await trailed(await askAs('excel', tokens.excel, { action: 'formula', app: 'excel', instruction: 'sum' }, TRAILED));
  assert.deepEqual(cut, { text: '=SUM(A1:', end: { status: 413, code: 'cut_off', error: CUT_OFF } });
  const write = await trailed(await askAs('chrome', tokens.chrome, { action: 'write', instruction: 'a long post' }, TRAILED));
  assert.equal(write.end.code, 'cut_off');
  assert.match(write.end.error, /longer than Eden can write in one answer/, 'nothing selected: no “select less”');
  const prose = await trailed(await askAs('messenger', tokens.messenger, BODY.messenger, TRAILED));
  assert.deepEqual(prose, { text: `=SUM(A1:${CUT_NOTE}`, end: { answer: 'cut' } });
  upstream = answer({ text: ['Half'], final: false });
  assert.deepEqual((await trailed(await askAs('chrome', tokens.chrome, BODY.chrome, TRAILED))).end, { status: 502, code: 'upstream', error: 'The answer ended early.' });
  // The answer's text never holds the trailer's mark.
  upstream = answer({ text: ['a\u0000b', '\u0000'] });
  assert.deepEqual(await trailed(await askAs('chrome', tokens.chrome, BODY.chrome, TRAILED)), { text: 'ab', end: { answer: 'complete' } });
  // Without the header: as before (a failure errors the stream; no trailer).
  upstream = answer({ text: ['No.'], stop: 'refusal' });
  const old = await askAs('chrome', tokens.chrome, { action: 'fix', text: 'teh' }, { noSettle: true });
  assert.equal(old.headers.get('x-eden-trailer'), null);
  await assert.rejects(old.text());
  await settle();
  assert.equal(account.holds.size, 0);
});

test('R2X13: CORS lets the extension send x-eden-trailer and read it back', async () => {
  const pre = await hit('/api/eden/text', { method: 'OPTIONS', origin: EXT });
  assert.match(pre.headers.get('access-control-allow-headers'), /\bx-eden-trailer\b/);
  const { tokens } = await connected('r2-trailer-cors', ['chrome']);
  const ok = await askAs('chrome', tokens.chrome, BODY.chrome, TRAILED);
  assert.match(ok.headers.get('access-control-expose-headers'), /\bx-eden-trailer\b/);
  await ok.text();
});

test('R2X13: Google Sheets stays buffered (the trailer header changes nothing there); its refusal words name Eden', async () => {
  const { tokens } = await connected('r2-trailer-sheets', ['sheets']);
  upstream = answer({ text: ['No.'], stop: 'refusal' });
  const r = await askAs('sheets', tokens.sheets, BODY.sheets, TRAILED);
  assert.equal(r.status, 422);
  assert.deepEqual(await r.json(), { error: 'Eden declined this request. Try asking another way.', code: 'refused' });
});

// ── R2C3: Chrome's answer budgets ──

test('R2C3: write, reply and longer have budgets of their own; the input limits are unchanged', () => {
  const tokensOf = (body) => textPrompt(parseText(body)).maxTokens;
  assert.equal(tokensOf({ action: 'write', instruction: 'Write a 1500-word blog post about tide pools.' }), 4000);
  assert.equal(tokensOf({ action: 'reply', text: 'Can you send the deck?' }), 2000);
  assert.equal(tokensOf({ action: 'longer', text: 'Short note.' }), 2000);
  assert.equal(tokensOf({ action: 'fix', text: 'teh cat' }), 1000);
  assert.equal(tokensOf({ action: 'explain', text: 'x' }), TEXT.proseTokens);
  assert.equal(tokensOf({ action: 'write', instruction: 'go on', text: 'x'.repeat(16_000) }), Math.ceil(16_000 / 2.2) + 400, 'a long draft: its own size');
  assert.equal(tokensOf({ action: 'translate', language: 'Hindi', text: 'x'.repeat(1000) }), Math.ceil(3000 / 2.2) + 400, 'translate: 3 × bytes ÷ 2.2');
  assert.equal(tokensOf({ action: 'translate', language: 'Thai', text: 'x'.repeat(10_000) }), TEXT.editTokens, 'never over 8,000');
  for (const action of ['reply', 'rewrite', 'fix', 'shorter', 'longer', 'tone', 'translate', 'write']) {
    for (const n of [0, 10, 500, 5000, 16_000]) {
      const text = 'x'.repeat(n);
      const t = answerTokens({ action, text });
      assert.ok(t <= TEXT.editTokens && t >= Math.min(TEXT.editTokens, editTokens(action, text)), `${action} ${n}: ${t}`);
    }
  }
  assert.ok(parseText({ action: 'fix', text: 'x'.repeat(16_000) }));
  assert.throws(() => parseText({ action: 'fix', text: 'x'.repeat(17_000) }), (e) => e.status === 413);
  assert.throws(() => parseText({ action: 'translate', language: 'French', text: 'x'.repeat(11_000) }), (e) => e.status === 413);
});

// ── R2X2: a fill's budget follows the cells' length ──

test('R2X2: fill budget = Σ max(35, longest cell × 1.6 ÷ 2.2) + 1 per row, + 200, capped per app, never below the old one', () => {
  const rows = (n, text) => Array.from({ length: n }, () => [text]);
  assert.equal(fillTokens(rows(10, 'x')), 10 * 36 + 200);
  assert.equal(fillTokens([['short', 'é'.repeat(150)]]), Math.ceil((300 * 1.6) / 2.2) + 1 + 200, 'the row’s longest cell, in bytes');
  assert.equal(SHEET.apps.excel.fillTokens, 8000);
  assert.equal(SHEET.apps.sheets.fillTokens, 2000);
  const fill = (app, values) => sheetPrompt(parseSheet({ action: 'fill', app, instruction: 'in French', sheet: { values } })).maxTokens;
  assert.equal(fill('excel', rows(20, 'x'.repeat(200))), 20 * (Math.ceil(320 / 2.2) + 1) + 200, 'translations of 200-character cells fit');
  assert.equal(fill('excel', rows(200, 'x'.repeat(250))), 8000);
  assert.equal(fill('sheets', rows(50, 'x'.repeat(300))), 2000);
  assert.equal(fill('sheets', rows(50, 'x')), 2000);
  assert.equal(fill('excel', rows(3, 'x')), 500);
  for (const app of ['excel', 'sheets']) {
    for (const n of [1, 5, 20, SHEET.apps[app].fillRows]) {
      for (const text of ['x', 'x'.repeat(100), '漢'.repeat(400)]) {
        if (n * text.length > 55_000) continue; // over the 60,000 characters
        const t = fill(app, rows(n, text));
        assert.ok(t >= Math.max(500, n * SHEET.rowTokens + 200), `${app} ${n}: never less than before`);
        assert.ok(t <= Math.max(SHEET.apps[app].fillTokens, 500));
      }
    }
  }
  assert.ok(parseSheet({ action: 'fill', app: 'sheets', sheet: { values: rows(25, 'x'.repeat(2000)) } }), 'not refused over the budget: categories fit anyway');
});

// ── R2X3, R2X16: Excel's Clean escapes ──

test('R2X3: Excel’s Clean is told its cells’ \\n, \\t and \\\\ are escapes to keep; Google Sheets’ and other actions aren’t', () => {
  const prompt = (app, action) => sheetPrompt(parseSheet({ action, app, instruction: 'x', sheet: { range: 'A1:A2', values: [['line one\\nline two'], ['C:\\\\new']] } })).system;
  assert.match(prompt('excel', 'clean'), /Inside a cell, \\n, \\t and \\\\ .* are escapes for a line break, a tab, a backslash/);
  assert.match(prompt('excel', 'clean'), /Never remove, expand, add or move them/);
  assert.doesNotMatch(prompt('sheets', 'clean'), /escapes/);
  assert.doesNotMatch(prompt('excel', 'fill'), /escapes/);
});

// ── R2X7: lone surrogates never reach Claude ──

test('R2X7: strip drops lone surrogates (pairs kept), so no client cut can send half an emoji', async () => {
  assert.equal(strip('a\ud83d'), 'a');
  assert.equal(strip('\udc00b\ud83d\ude00c\ud83d'), 'b😀c');
  assert.equal(strip('😀\u0007ok'), '😀ok');
  const cell = parseSheet({ action: 'ask', app: 'excel', instruction: 'what\ud83d?', sheet: { values: [[`${'a'.repeat(1999)}\ud83d`]] }, history: [{ role: 'user', text: 'hi \ude00' }] });
  assert.equal(cell.sheet.values[0][0], 'a'.repeat(1999));
  assert.equal(cell.instruction, 'what?');
  assert.equal(cell.history[0].text, 'hi ');
  const { tokens } = await connected('r2-lone', ['excel']);
  await (await askAs('excel', tokens.excel, { action: 'ask', app: 'excel', instruction: 'sum\ud83d', sheet: { range: 'A1', values: [['x\udc00']] } })).text();
  const sentBody = JSON.stringify(sent.at(-1));
  assert.ok(sentBody.isWellFormed());
  assert.doesNotMatch(sentBody, /\\ud[89ab][0-9a-f]{2}(?!\\udc)/i);
  assert.ok(sent.at(-1).messages.every((m) => m.content.isWellFormed()) && sent.at(-1).system.isWellFormed());
});

// ── R2S9: real row numbers when hidden rows were skipped ──

test('R2S9: sheet.rows labels each row with its real sheet row; checked, documented, optional', () => {
  const sheet = (rows, extra = {}) => ({ action: 'fill', app: 'sheets', instruction: 'x', sheet: { range: 'A2:B6', values: [['a', '1'], ['d', '4'], ['e', '5']], rows, ...extra } });
  const req = parseSheet(sheet([2, 5, 6]));
  assert.deepEqual(req.sheet.rows, [2, 5, 6]);
  assert.equal(cellsBlock(req.sheet), 'row\tA\tB\n2\ta\t1\n5\td\t4\n6\te\t5');
  const content = sheetPrompt(req).messages.at(-1).content;
  assert.match(content, /Rows not listed are hidden/);
  assert.equal(cellsBlock(parseSheet(sheet(undefined)).sheet), 'row\tA\tB\n2\ta\t1\n3\td\t4\n4\te\t5', 'without rows: counted from the range');
  assert.doesNotMatch(sheetPrompt(parseSheet(sheet([2, 3, 4]))).messages.at(-1).content, /hidden/, 'no gap, no note');
  const formulas = sheetPrompt(parseSheet({ action: 'explain', app: 'excel', sheet: { range: 'C2:C4', values: [['1'], ['2'], ['3']], formulas: [['=A2'], [''], ['=A9*2']], rows: [2, 7, 9] } })).messages.at(-1).content;
  assert.match(formulas, /C2: =A2\nC9: =A9\*2/);
  for (const bad of [[2, 5], [2, 5, 6, 7], [2, 2, 3], [5, 4, 6], [0, 1, 2], [1.5, 2, 3], ['2', 3, 4], [1, 2, SHEET.maxRow + 1], 'x']) {
    assert.throws(() => parseSheet(sheet(bad)), (e) => e.status === 400 && /sheet\.rows/.test(e.message), JSON.stringify(bad));
  }
  assert.throws(() => parseSheet({ action: 'ask', app: 'excel', instruction: 'x', sheet: { rows: [1] } }), (e) => e.status === 400 && /needs sheet\.values/.test(e.message));
  // The too-long-cell message names the real cell.
  assert.throws(() => parseSheet({ action: 'clean', app: 'excel', sheet: { range: 'B2:B9', values: [['a'], ['x'.repeat(2001)]], rows: [2, 9] } }), (e) => e.status === 413 && /Cell B9 is too long/.test(e.message));
});

// ── R2S15: a "!" inside a quoted sheet name ──

test('R2S15: topLeft reads after the last "!"', () => {
  assert.deepEqual(topLeft("'Q1!AB12'!C5:D9"), { col: 2, row: 5 });
  assert.deepEqual(topLeft('Sheet1!B3:D9'), { col: 1, row: 3 });
  assert.deepEqual(topLeft('$B$3:D9'), { col: 1, row: 3 });
  assert.deepEqual(topLeft("'A!B'!$AA$10"), { col: 26, row: 10 });
  assert.deepEqual(topLeft('AB12!C5'), { col: 2, row: 5 });
  assert.deepEqual(topLeft("'Q1!AB12'!A:A"), { col: 0, row: 1 });
  assert.deepEqual(topLeft(''), { col: 0, row: 1 });
});

// ── R2S16: the deadline counts from when the request arrived ──

test('R2S16: a buffered answer’s deadline counts from arrival; Claude’s time to headers is inside it', async () => {
  const { tokens, account } = await connected('r2-deadline', ['sheets', 'chrome']);
  TIMING.bufferedMs = 150;
  const later = (ms, make) => (init) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(make()), ms);
    init.signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('aborted', 'AbortError'));
    });
  });
  // Headers never come in time: 504 at the deadline, not whenever Claude answers.
  upstream = later(5000, answer({ text: ['late'] }));
  let t0 = Date.now();
  const slow = await askAs('sheets', tokens.sheets);
  assert.equal(slow.status, 504);
  assert.equal((await slow.json()).code, 'too_slow');
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  // Headers at 100 ms, then 100 ms of data: inside 150 ms from the headers, past it from arrival.
  upstream = later(100, () => {
    const enc = new TextEncoder();
    const events = sseBody(claudeAnswer({ text: ['a', 'b'] }));
    const body = new ReadableStream({
      async start(c) {
        const reader = events.getReader ? events.getReader() : new Response(events).body.getReader();
        await new Promise((r) => setTimeout(r, 100));
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          c.enqueue(typeof value === 'string' ? enc.encode(value) : value);
        }
        c.close();
      },
    });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  });
  t0 = Date.now();
  const mid = await askAs('sheets', tokens.sheets);
  assert.equal(mid.status, 504);
  assert.equal(account.holds.size, 0);
  // A streamed answer's 5 minutes count from arrival too; a quick one is untouched.
  upstream = answer({ text: ['quick'] });
  assert.equal(await (await askAs('chrome', tokens.chrome)).text(), 'quick');
});

// ── efficiency pass 2 (askeden/docs/bug-sweep/anywhere/e2-server.md): same results, less work ──

test('E2: utf8Bytes is TextEncoder’s count at any length (either side of its scratch buffer), lone surrogates and non-strings included', () => {
  const enc = new TextEncoder();
  for (const n of [0, 1, 21_844, 21_845, 21_846, 40_000]) {
    for (const unit of ['a', 'é', '漢', '😀', '\ud800', '\udc00', 'a\ud800']) {
      const text = unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
      assert.equal(utf8Bytes(text), enc.encode(text).length, `${n} × ${JSON.stringify(unit)}`);
    }
  }
  for (const x of [undefined, null, 5, true]) assert.equal(utf8Bytes(x), enc.encode(x).length, String(x));
  assert.equal(textTokens(2200), 1000);
  assert.equal(textTokens(2200, 1.6), Math.ceil((2200 * 1.6) / 2.2));
  assert.equal(editTokens('translate', 'é'.repeat(1100)), textTokens(2200, 1.6) + 400);
});

test('E2: the formulas block stops at 400 lines, the first ones in order, labelled by sheet.rows', () => {
  const formulas = Array.from({ length: 300 }, (_, r) => ['', `=A${r}*2`, `=B${r}+1`]);
  const values = formulas.map((row) => row.map(() => 1));
  const rows = values.map((_, i) => 3 + i * 2);
  const { messages } = sheetPrompt(parseSheet({ action: 'explain', app: 'excel', sheet: { range: 'C3', values, formulas, rows } }));
  const block = /<formulas_[0-9a-f]+>\n([\s\S]*?)\n<\/formulas_/.exec(messages.at(-1).content)[1].split('\n');
  assert.equal(block.length, 400);
  assert.deepEqual(block.slice(0, 3), ['D3: =A0*2', 'E3: =B0+1', 'D5: =A1*2']);
  assert.equal(block.at(-1), `E${3 + 199 * 2}: =B199+1`);
});

test('E2: empty, number and true/false cells parse as before', () => {
  const sheet = { values: [['', 0, -0, 1e21, 0.5, true, false, null, ' a\u0000b ']], formulas: [['', '', '=A1']] };
  const req = parseSheet({ action: 'analyze', app: 'excel', sheet });
  assert.deepEqual(req.sheet.values, [['', '0', '0', '1e+21', '0.5', 'true', 'false', '', ' ab ']]);
  assert.deepEqual(req.sheet.formulas, [['', '', '=A1']]);
  // Every character still counts against the 60,000.
  const big = Array.from({ length: 5 }, () => Array.from({ length: 1000 }, () => 1234567890123)); // 13 characters each
  assert.throws(() => parseSheet({ action: 'analyze', app: 'excel', sheet: { values: big, formulas: [] } }), (e) => e.status === 413);
  assert.doesNotThrow(() => parseSheet({ action: 'analyze', app: 'excel', sheet: { values: big.slice(0, 4) } }));
});

test('E2: the hold covers every byte of the prompt the model gets (counted piece by piece, never joined)', async () => {
  const { tokens } = await connected('e2-hold', ['chrome', 'excel']);
  const held = [];
  const get = env.ACCOUNTS.get;
  env.ACCOUNTS.get = (name) => {
    const stub = get(name);
    return {
      fetch: async (input, init) => {
        const req = input instanceof Request ? input : new Request(input, init);
        if (new URL(req.url).pathname === '/scoped-hold') held.push((await req.clone().json()).usd);
        return stub.fetch(req);
      },
    };
  };
  const asks = [
    ['chrome', { action: 'rewrite', text: 'Grüße 😀 漢字 '.repeat(200), history: [{ role: 'user', text: 'é' }, { role: 'eden', text: '😀' }], page: { title: 'Ünï', url: 'https://x' } }],
    ['excel', { action: 'analyze', app: 'excel', sheet: { name: 'Feuille', range: 'A1', values: [['😀', 'é'], [1, true]] }, active: { address: 'A1', value: '漢' } }],
  ];
  for (const [client, body] of asks) {
    held.length = 0;
    sent = [];
    assert.equal((await askAs(client, tokens[client], body)).status, 200);
    const p = sent[0];
    const [inPrice, outPrice] = priceOf(p.model); // the model that answered: Claude Sonnet for the rewrite, Gemini Flash for the analysis
    const input = Math.ceil(new TextEncoder().encode(p.system + p.messages.map((m) => m.content).join('')).length / 3);
    assert.deepEqual(held, [0, Math.round(((input * inPrice + p.max_tokens * outPrice) / 1e6) * 1e6) / 1e6], client);
    assert.equal(p.model, client === 'chrome' ? 'claude-sonnet-5-5' : 'gemini-3.8-flash', client);
  }
  env.ACCOUNTS.get = get;
});
