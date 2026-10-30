// The Gemma claim judge next to EVES (eden/gemma-judge.js): off by default, shadow logs only, owner accounts use settled
// verdicts, the iPhone/Edu app never reaches it, and a cold, slow or failing judge leaves the turn exactly as today.
// Fake model streams and a fake judge; nothing is called.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetSessions } from '../src/eden/session.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { clearHostedEvesVault } from '../src/eden/eves.js';
import { evidenceRows, gemmaMode, resetGemmaJudge } from '../src/eden/gemma-judge.js';
import { Account, Link, appleJwk, identityToken, namespace, readEvents } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
const APP_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 EdenApp/1.4';
const EDU_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 EdenEdu/1.0';
const JUDGE = 'https://bilel--claim-judge-judge-web.modal.run';
const realFetch = globalThis.fetch;
const realLog = console.log;
const SOURCES = [{ title: 'Pro Football Reference', url: 'https://www.pro-football-reference.com/players/H/HenrDe00.htm' }];
const CLAIM = 'Derrick Henry has 11,423 career rushing yards and 106 rushing touchdowns.';

let env;
let waits;
let judgeCalls; // { path, body, headers }
let logs;
let gemma; // what the fake judge does: { verdict } | { status } | { hang: true } | { badJson: true }
let evidenceVerdict;
const ctx = { waitUntil: (p) => waits.push(p) };

const openaiSse = (text, usage = { prompt_tokens: 400, completion_tokens: 60 }) =>
  [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
    `data: ${JSON.stringify({ choices: [], usage })}`,
    'data: [DONE]',
  ].join('\n\n') + '\n\n';
const geminiSse = (text, sources = [], usage = { promptTokenCount: 300, candidatesTokenCount: 80, thoughtsTokenCount: 200 }) =>
  `data: ${JSON.stringify({
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP', ...(sources.length ? { groundingMetadata: { webSearchQueries: ['q'], groundingChunks: sources.map((s) => ({ web: { uri: s.url, title: s.title } })) } } : {}) }],
    usageMetadata: usage,
  })}\n\n`;
const sse = (body) => new Response(body, { headers: { 'content-type': 'text/event-stream' } });

const judgeReply = JSON.stringify({
  winner: 'C',
  claims: [{ text: CLAIM, kind: 'number', by: ['C'], against: ['A', 'B'], status: 'disputed', quotes: { C: `Through the 2024 NFL season, ${CLAIM}` }, missingFromWinner: false, essential: true }],
  summary: 'The web-searched answer has current career totals.',
});

beforeEach(() => {
  waits = [];
  judgeCalls = [];
  logs = [];
  gemma = { verdict: 'supported' };
  evidenceVerdict = 'unverifiable';
  forgetAppleKeys();
  forgetSessions();
  resetGemmaJudge();
  console.log = (...a) => {
    const s = a.join(' ');
    if (/"evt":"gemma_/.test(s)) logs.push(JSON.parse(s));
  };
  env = {
    OPENAI_API_KEY: 'o-test',
    GEMINI_API_KEY: 'g-test',
    TRIAL_BUDGET_USD: '1',
    PLUS_BUDGET_USD: '20',
    EDEN_MODELS: 'claude-opus-5-5,claude-sonnet-5-5,claude-haiku-4-5,gpt-6.1-sol,gpt-6-sol,gpt-6-luna,gemini-3.1-pro-preview,gemini-3.8-flash,gemini-3.5-flash-lite,kimi-k3,kimi-k2.7-code',
    GEMMA_JUDGE_URL: JUDGE,
    GEMMA_JUDGE_KEY: 'wk-test',
    GEMMA_JUDGE_SECRET: 'ws-test',
  };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  clearHostedEvesVault(env);
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    if (url.startsWith(JUDGE)) {
      const path = new URL(url).pathname;
      judgeCalls.push({ path, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
      if (path === '/health') return Response.json({ ok: true, loaded: true, config: 'cfgsha' });
      if (gemma.hang) {
        return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'TimeoutError')), { once: true }));
      }
      if (gemma.status) return new Response('busy', { status: gemma.status });
      if (gemma.badJson) return new Response('<html>oops</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      const claims = JSON.parse(init.body).claims;
      return Response.json({ results: claims.map((c) => ({ id: c.id, verdict: gemma.verdict, S: 0.9995, C: 0.01, reason: '', rows: [] })), config: 'cfgsha', rows: claims.length, seconds: 0.4 });
    }
    const body = init.body ? JSON.parse(init.body) : {};
    if (url.includes('generativelanguage.googleapis.com') && url.includes(':streamGenerateContent')) {
      const sys = JSON.stringify(body.systemInstruction || '');
      if (/You check one claim against the web/.test(sys)) {
        return sse(geminiSse(JSON.stringify({ verdict: evidenceVerdict, summary: 'Pro Football Reference lists Derrick Henry with 11,423 rushing yards and 106 rushing touchdowns through 2024.', sourceValue: '11,423', disputed: false, fixedSentence: null }), SOURCES));
      }
      if (/You are the judge in a fact-checking step/.test(sys)) return sse(geminiSse(judgeReply));
      if (Array.isArray(body.tools) && body.tools.length) return sse(geminiSse(`Through the 2024 NFL season, ${CLAIM}`, SOURCES));
      return sse(geminiSse('Derrick Henry has 9,502 career rushing yards and 90 rushing touchdowns.'));
    }
    if (url.includes('api.openai.com')) {
      const sys = body.messages?.[0]?.role === 'system' ? body.messages[0].content : '';
      if (/You check one claim against the web/.test(sys)) {
        return sse(openaiSse(JSON.stringify({ verdict: evidenceVerdict, summary: 'Pro Football Reference lists Derrick Henry with 11,423 rushing yards and 106 rushing touchdowns through 2024.', sourceValue: '11,423', disputed: false, fixedSentence: null })));
      }
      if (/You are the judge in a fact-checking step/.test(sys)) return sse(openaiSse(judgeReply));
      return sse(openaiSse('Derrick Henry has 9,502 career rushing yards and 90 rushing touchdowns.'));
    }
    throw new Error(`unexpected fetch ${init.method || 'GET'} ${url}`);
  };
});
after(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
});

async function hit(p, { method = 'GET', body, headers = {}, session } = {}) {
  const h = { 'user-agent': UA, ...headers };
  if (method !== 'GET') h.origin ??= ORIGIN;
  if (session) h.cookie = `__Host-eden=${session}`;
  const init = { method, headers: h };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    h['content-type'] ??= 'application/json';
  }
  const r = await worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx);
  return r;
}
const drain = async () => {
  while (waits.length) await Promise.all(waits.splice(0));
};
let accountId;
async function signedIn() {
  const owner = await (await hit('/api/account/apple', { method: 'POST', headers: { origin: undefined }, body: { identity_token: await identityToken(), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } } })).json();
  await drain();
  accountId = owner.account.id;
  const link = await hit('/api/web/link', { method: 'POST', body: {} });
  const code = (await link.clone().json()).code;
  const cookie = link.headers.getSetCookie().find((c) => c.startsWith('__Host-eden-link=')).split(';')[0];
  await hit(`/api/link/${code}/approve`, { method: 'POST', headers: { authorization: `Bearer ${owner.token}`, origin: undefined, 'user-agent': undefined }, body: { sealed_key: null, sender_key: null } });
  const done = await hit('/api/web/link/poll', { method: 'POST', body: {}, headers: { cookie } });
  await drain();
  return done.headers.getSetCookie().find((c) => c.startsWith('__Host-eden=')).split(';')[0].slice('__Host-eden='.length);
}
const makeOwner = () => env.ACCOUNTS.objects.get(accountId).storage.put('identities', [{ provider: 'google', sub: 'g-1', email: 'bilel@askeden.com', added: Date.now() }]);

/** One EVES turn whose judge disputes one numeric claim of the web-searched anchor, so the web evidence check runs. */
async function turn(session, ua = UA) {
  // the judge sees the answers in a random order (vendor/verify.js); fixed here so two runs can be compared byte for byte
  const random = Math.random;
  let seed = 7;
  Math.random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  try {
    return await turnOnce(session, ua);
  } finally {
    Math.random = random;
  }
}
async function turnOnce(session, ua) {
  const res = await hit('/api/chat/eves', {
    method: 'POST',
    session,
    headers: { 'x-jarvis-chat': '1', 'user-agent': ua },
    body: {
      messages: [{ role: 'user', content: 'What are Derrick Henry career rushing yards and touchdowns?' }],
      mode: 'on',
      models: [
        { model: 'gpt-6-luna', effort: 'none' },
        { model: 'gemini-3.8-flash', effort: 'low' },
      ],
      settings: { level: 3 },
    },
  });
  assert.equal(res.status, 200, await res.clone().text());
  const text = await res.text();
  await drain();
  return text;
}
// The run id and timings differ between any two runs; everything else must be the same bytes
const stable = (raw) =>
  raw
    .replace(/"id":"[0-9a-f]{24}"/g, '"id":"<id>"')
    .replace(/"turnId":"[^"]*"/g, '"turnId":"<id>"')
    .replace(/"(ms|latencyMs|totalMs|elapsedMs|latencyS|seconds)":\d+(\.\d+)?/g, '"$1":0');
const events = (raw) => readEvents(new Response(raw));
const claimVerdict = async (raw) => (await events(raw)).find((e) => e.type === 'verdict').data.claims[0].verdict;
const judgePosts = () => judgeCalls.filter((c) => c.path === '/judge');

let baseline;
async function today(session) {
  // the current path: the judge switched off
  const keep = { ...env };
  delete env.GEMMA_JUDGE_URL;
  const raw = await turn(session);
  Object.assign(env, keep);
  return raw;
}

test('config: off unless GEMMA_JUDGE_MODE is shadow/owner and the URL, key and secret are all set; the iPhone and Edu apps are always off', () => {
  const req = (ua) => new Request(ORIGIN, { headers: { 'user-agent': ua } });
  const full = { GEMMA_JUDGE_URL: JUDGE, GEMMA_JUDGE_KEY: 'k', GEMMA_JUDGE_SECRET: 's' };
  assert.equal(gemmaMode(full, req(UA)), 'off', 'default off');
  assert.equal(gemmaMode({ ...full, GEMMA_JUDGE_MODE: 'shadow' }, req(UA)), 'shadow');
  assert.equal(gemmaMode({ ...full, GEMMA_JUDGE_MODE: 'Owner ' }, req(UA)), 'owner');
  assert.equal(gemmaMode({ ...full, GEMMA_JUDGE_MODE: 'live' }, req(UA)), 'off', 'unknown value is off');
  assert.equal(gemmaMode({ ...full, GEMMA_JUDGE_MODE: 'owner', GEMMA_JUDGE_SECRET: '' }, req(UA)), 'off');
  assert.equal(gemmaMode({ ...full, GEMMA_JUDGE_MODE: 'owner' }, req(APP_UA)), 'off');
  assert.equal(gemmaMode({ ...full, GEMMA_JUDGE_MODE: 'owner' }, req(EDU_UA)), 'off');
  assert.deepEqual(evidenceRows({ verdict: 'unresolved', summary: 'x', sources: SOURCES }), []);
  assert.deepEqual(evidenceRows({ verdict: 'unverifiable', summary: 'The web search found no clear evidence either way.', sources: SOURCES }), []);
  assert.deepEqual(evidenceRows({ verdict: 'supported', summary: 'A page says so.', sources: [] }), [], 'no sources, no evidence');
  assert.deepEqual(evidenceRows({ verdict: 'supported', summary: 'A page says so.', sources: SOURCES }), ['A page says so.']);
});

test('mode off (secrets set, no GEMMA_JUDGE_MODE): zero calls to the judge, answer as today', async () => {
  const session = await signedIn();
  await makeOwner();
  baseline = stable(await today(session));
  const raw = await turn(session);
  assert.equal(judgeCalls.length, 0);
  assert.equal(logs.length, 0);
  assert.equal(stable(raw), baseline);
});

test('the iPhone app and the Edu app (owner mode, owner account, judge warm): zero calls to the judge, not even a ping', async () => {
  const session = await signedIn();
  await makeOwner();
  env.GEMMA_JUDGE_MODE = 'owner';
  await turn(session); // web turn: warms the judge
  assert.equal(await claimVerdict(await turn(session)), 'supported', 'the same owner on the website: Gemma used');
  assert.equal(judgePosts().length, 1);
  judgeCalls.length = 0;
  logs.length = 0;
  for (const ua of [APP_UA, EDU_UA]) {
    assert.equal(await claimVerdict(await turn(session, ua)), 'unverifiable', 'the app turn ran EVES’s web check, as today');
    await turn(session, ua);
  }
  assert.equal(judgeCalls.length, 0);
  assert.equal(logs.length, 0);
});

test('shadow: the judge runs in the background and is logged; the answer is byte-identical to today, also for owners', async () => {
  const session = await signedIn();
  await makeOwner();
  const base = stable(await today(session));
  env.GEMMA_JUDGE_MODE = 'shadow';
  const cold = await turn(session);
  assert.equal(stable(cold), base);
  assert.deepEqual(judgeCalls.map((c) => c.path), ['/health'], 'cold: one warm-up ping, no claim waits on it');
  assert.equal(judgeCalls[0].headers['Modal-Key'], 'wk-test');
  assert.equal(judgeCalls[0].headers['Modal-Secret'], 'ws-test');
  assert.equal(logs[0].evt, 'gemma_shadow');
  assert.equal(logs[0].cold, true);
  const warm = await turn(session);
  assert.equal(stable(warm), base, 'Gemma said supported, EVES unverifiable: the shadow answer is still EVES’s');
  assert.equal(await claimVerdict(warm), 'unverifiable');
  const posts = judgePosts();
  assert.equal(posts.length, 1, 'one batched POST /judge for the turn');
  assert.deepEqual(posts[0].body.claims, [{ id: '0', claim: CLAIM, type: 'number', evidence: ['Pro Football Reference lists Derrick Henry with 11,423 rushing yards and 106 rushing touchdowns through 2024.'] }]);
  const line = logs.find((l) => l.cold === false);
  assert.equal(line.evt, 'gemma_shadow');
  assert.equal(line.gemma, 'supported');
  assert.equal(line.eves, 'unverifiable');
  assert.equal(line.used, false);
  assert.equal(line.S, 0.9995);
  assert.equal(typeof line.ms, 'number');
  assert.match(line.claim, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(logs).includes('Derrick'), 'no user text in the logs, only a claim hash');
});

test('owner mode: an owner account’s settled claims take Gemma’s verdict; a non-owner’s turn is shadow only', async () => {
  const session = await signedIn();
  env.GEMMA_JUDGE_MODE = 'owner';
  // a non-owner first: shadow, byte-identical
  const base = stable(await today(session));
  await turn(session); // cold: ping
  const other = await turn(session);
  assert.equal(stable(other), base);
  assert.equal(logs.filter((l) => l.cold === false)[0].evt, 'gemma_shadow');
  // the owner: Gemma's "supported" replaces EVES's "unverifiable"
  await makeOwner();
  logs.length = 0;
  const owned = await turn(session);
  assert.equal(await claimVerdict(owned), 'supported');
  assert.notEqual(stable(owned), base);
  const line = logs.find((l) => l.cold === false);
  assert.equal(line.evt, 'gemma_owner');
  assert.equal(line.used, true);
  // "escalate" is EVES as today
  gemma = { verdict: 'escalate' };
  const esc = await turn(session);
  assert.equal(await claimVerdict(esc), 'unverifiable');
  assert.equal(stable(esc), base);
  // a cold judge is never waited on: as today, plus at most one ping a minute
  resetGemmaJudge();
  gemma = { verdict: 'supported' };
  judgeCalls.length = 0;
  const c1 = await turn(session);
  assert.equal(stable(c1), base);
  assert.deepEqual(judgeCalls.map((c) => c.path), ['/health']);
});

test('owner mode, judge failing: 5xx, 429, bad JSON and a 6 s timeout leave the owner’s turn identical to today', async () => {
  const session = await signedIn();
  await makeOwner();
  env.GEMMA_JUDGE_MODE = 'owner';
  const base = stable(await today(session));
  for (const g of [{ status: 503 }, { status: 500 }, { status: 429 }, { badJson: true }, { hang: true }]) {
    resetGemmaJudge();
    gemma = { verdict: 'supported' };
    await turn(session); // cold: ping warms it
    gemma = g;
    logs.length = 0;
    const t0 = Date.now();
    const raw = await turn(session);
    const took = Date.now() - t0;
    assert.equal(stable(raw), base, JSON.stringify(g));
    const line = logs.find((l) => l.error);
    assert.equal(line.evt, 'gemma_owner');
    assert.equal(line.error, g.status ? `http_${g.status}` : g.badJson ? 'bad_json' : 'timeout');
    if (g.hang) assert.ok(took >= 5_900 && took < 9_000, `timed out at 6 s (${took} ms)`);
    // after a failure the judge counts as cold: the next turn does not call it (the ping is held for a minute)
    judgeCalls.length = 0;
    const next = await turn(session);
    assert.equal(stable(next), base);
    assert.equal(judgeCalls.length, 0);
  }
});

test('shadow sample: GEMMA_SHADOW_SHARE picks a share of website turns; unset or 1 means every turn', async () => {
  const { shadowSampled } = await import('../src/eden/gemma-judge.js');
  assert.equal(shadowSampled({}), true);
  assert.equal(shadowSampled({ GEMMA_SHADOW_SHARE: '1' }), true);
  assert.equal(shadowSampled({ GEMMA_SHADOW_SHARE: '0' }, () => 0), false);
  assert.equal(shadowSampled({ GEMMA_SHADOW_SHARE: '0.2' }, () => 0.1), true);
  assert.equal(shadowSampled({ GEMMA_SHADOW_SHARE: '0.2' }, () => 0.5), false);
  assert.equal(shadowSampled({ GEMMA_SHADOW_SHARE: 'junk' }), true);
});
