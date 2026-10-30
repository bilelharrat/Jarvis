// EVES search when Google's quota runs out (eden/search-fallback.js): Google stays the default; only a Gemini 429 /
// RESOURCE_EXHAUSTED / quota error retries the same search with Claude, then GPT; the trip lasts the Pacific day with an
// hourly re-probe of Google; the iPhone/Edu app and SEARCH_FALLBACK off keep today's behaviour exactly. Fakes only.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetSessions } from '../src/eden/session.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { clearHostedEvesVault } from '../src/eden/eves.js';
import { isQuotaError, nextPacificMidnight, resetSearchFallback, searchFallback, searchFallbackOn, searchFallbackState } from '../src/eden/search-fallback.js';
import { modelOf } from '../src/eden/providers.js';
import { Account, Link, appleJwk, claudeAnswer, identityToken, namespace, readEvents, sseBody } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
const APP_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 EdenApp/1.4';
const EDU_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 EdenEdu/1.0';
const realFetch = globalThis.fetch;
const realLog = console.log;
const SRC = [{ title: 'Pro Football Reference', url: 'https://www.pro-football-reference.com/players/H/HenrDe00.htm' }];
const CLAIM = 'Derrick Henry has 11,423 career rushing yards and 106 rushing touchdowns.';
const EVIDENCE = JSON.stringify({ verdict: 'supported', summary: 'Pro Football Reference lists 11,423 yards and 106 touchdowns through 2024.', sourceValue: '11,423', disputed: false, fixedSentence: null });

let env;
let waits;
let calls; // { who: 'gemini-search' | 'claude' | 'gpt-search', purpose }
let logs;
let fx; // { google: 'ok' | '429' | '403q' | '500', claude: 'ok' | 'fail', gpt: 'ok' | 'fail' }
const ctx = { waitUntil: (p) => waits.push(p) };

const openaiSse = (text) =>
  [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 400, completion_tokens: 60 } })}`,
    'data: [DONE]',
  ].join('\n\n') + '\n\n';
const geminiSse = (text, sources = []) =>
  `data: ${JSON.stringify({
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP', ...(sources.length ? { groundingMetadata: { webSearchQueries: ['q'], groundingChunks: sources.map((s) => ({ web: { uri: s.url, title: s.title } })) } } : {}) }],
    usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 80, thoughtsTokenCount: 200 },
  })}\n\n`;
const responsesSse = (text) =>
  [
    ['response.output_item.done', { type: 'response.output_item.done', item: { id: 'ws_1', type: 'web_search_call', status: 'completed' } }],
    ['response.output_text.delta', { type: 'response.output_text.delta', delta: text }],
    ['response.output_text.annotation.added', { type: 'response.output_text.annotation.added', annotation: { type: 'url_citation', url: SRC[0].url, title: 'PFR via GPT' } }],
    ['response.completed', { type: 'response.completed', response: { usage: { input_tokens: 1000, output_tokens: 300 } } }],
  ]
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
const sse = (body) => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
const judgeReply = JSON.stringify({
  winner: 'C',
  claims: [{ text: CLAIM, kind: 'number', by: ['C'], against: ['A', 'B'], status: 'disputed', quotes: { C: `Through the 2024 NFL season, ${CLAIM}` }, missingFromWinner: false, essential: true }],
  summary: 'The web-searched answer has current career totals.',
});
const isEvidence = (s) => /You check one claim against the web/.test(s);

beforeEach(() => {
  waits = [];
  calls = [];
  logs = [];
  fx = { google: 'ok', claude: 'ok', gpt: 'ok' };
  forgetAppleKeys();
  forgetSessions();
  resetSearchFallback();
  console.log = (...a) => {
    const s = a.join(' ');
    if (/"evt":"search_fallback"/.test(s)) logs.push(JSON.parse(s));
  };
  env = {
    OPENAI_API_KEY: 'o-test',
    GEMINI_API_KEY: 'g-test',
    ANTHROPIC_API_KEY: 'a-test',
    TRIAL_BUDGET_USD: '1',
    PLUS_BUDGET_USD: '20',
    EDEN_MODELS: 'claude-opus-5-5,claude-sonnet-5-5,claude-haiku-4-5,gpt-6.1-sol,gpt-6-sol,gpt-6-luna,gemini-3.1-pro-preview,gemini-3.8-flash,gemini-3.5-flash-lite,kimi-k3,kimi-k2.7-code',
  };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  clearHostedEvesVault(env);
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    const body = init.body ? JSON.parse(init.body) : {};
    if (url.includes('generativelanguage.googleapis.com') && url.includes(':streamGenerateContent')) {
      const sys = JSON.stringify(body.systemInstruction || '');
      const search = Array.isArray(body.tools) && body.tools.length > 0;
      if (search) {
        calls.push({ who: 'gemini-search', purpose: isEvidence(sys) ? 'evidence' : 'anchor' });
        if (fx.google === '429') return Response.json({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted (e.g. check quota).' } }, { status: 429 });
        if (fx.google === '403q') return Response.json({ error: { code: 403, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for quota metric generate_content_requests.' } }, { status: 403 });
        if (fx.google === '500') return Response.json({ error: { code: 500, message: 'internal' } }, { status: 500 });
        if (isEvidence(sys)) return sse(geminiSse(`Pro Football Reference.\n${EVIDENCE}`, SRC));
        return sse(geminiSse(`Through the 2024 NFL season, ${CLAIM}`, SRC));
      }
      if (/You are the judge in a fact-checking step/.test(sys)) return sse(geminiSse(judgeReply));
      return sse(geminiSse('Derrick Henry has 9,502 career rushing yards and 90 rushing touchdowns.'));
    }
    if (url.includes('api.anthropic.com')) {
      const sys = typeof body.system === 'string' ? body.system : JSON.stringify(body.system || '');
      calls.push({ who: 'claude', purpose: isEvidence(sys) ? 'evidence' : 'anchor', tools: body.tools });
      if (fx.claude === 'fail') return Response.json({ type: 'error', error: { type: 'api_error', message: 'Internal' } }, { status: 500 });
      const text = isEvidence(sys) ? [EVIDENCE] : [`Through the 2024 NFL season, ${CLAIM}`];
      return sse(sseBody(claudeAnswer({ text, citations: [{ url: SRC[0].url, title: 'PFR via Claude', cited_text: '11,423' }] })));
    }
    if (url.includes('api.openai.com/v1/responses')) {
      const sys = JSON.stringify(body.instructions || body.input || '');
      calls.push({ who: 'gpt-search', purpose: isEvidence(sys) ? 'evidence' : 'anchor' });
      if (fx.gpt === 'fail') return Response.json({ error: { message: 'server error' } }, { status: 500 });
      return sse(responsesSse(isEvidence(sys) ? EVIDENCE : `Through the 2024 NFL season, ${CLAIM}`));
    }
    if (url.includes('api.openai.com')) {
      const sys = body.messages?.[0]?.role === 'system' ? body.messages[0].content : '';
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
  for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
  const init = { method, headers: h };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    h['content-type'] ??= 'application/json';
  }
  return worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx);
}
const drain = async () => {
  while (waits.length) await Promise.all(waits.splice(0));
};
async function signedIn() {
  const owner = await (await hit('/api/account/apple', { method: 'POST', headers: { origin: undefined }, body: { identity_token: await identityToken(), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } } })).json();
  await drain();
  const link = await hit('/api/web/link', { method: 'POST', body: {} });
  const code = (await link.clone().json()).code;
  const cookie = link.headers.getSetCookie().find((c) => c.startsWith('__Host-eden-link=')).split(';')[0];
  await hit(`/api/link/${code}/approve`, { method: 'POST', headers: { authorization: `Bearer ${owner.token}`, origin: undefined, 'user-agent': undefined }, body: { sealed_key: null, sender_key: null } });
  const done = await hit('/api/web/link/poll', { method: 'POST', body: {}, headers: { cookie } });
  await drain();
  return done.headers.getSetCookie().find((c) => c.startsWith('__Host-eden=')).split(';')[0].slice('__Host-eden='.length);
}
async function turn(session, ua = UA) {
  const random = Math.random;
  let seed = 7;
  Math.random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  try {
    const res = await hit('/api/chat/eves', {
      method: 'POST',
      session,
      headers: { 'x-jarvis-chat': '1', 'user-agent': ua },
      body: { messages: [{ role: 'user', content: 'What are Derrick Henry career rushing yards and touchdowns?' }], mode: 'on', models: [{ model: 'gpt-6-luna', effort: 'none' }, { model: 'gemini-3.8-flash', effort: 'low' }], settings: { level: 3 } },
    });
    assert.equal(res.status, 200, await res.clone().text());
    const text = await res.text();
    await drain();
    return text;
  } finally {
    Math.random = random;
  }
}
const stable = (raw) =>
  raw
    .replace(/"id":"[0-9a-f]{24}"/g, '"id":"<id>"')
    .replace(/"turnId":"[^"]*"/g, '"turnId":"<id>"')
    .replace(/"(ms|latencyMs|totalMs|elapsedMs|latencyS|seconds)":\d+(\.\d+)?/g, '"$1":0');
const finalText = async (raw) => (await readEvents(new Response(raw))).filter((e) => e.type === 'text' && e.data.lane === 'final').map((e) => e.data.text).join('');
const fallbackCalls = () => calls.filter((c) => c.who !== 'gemini-search');
/** today's bytes for this situation: the switch off */
async function today(session, ua = UA) {
  const keep = env.SEARCH_FALLBACK;
  delete env.SEARCH_FALLBACK;
  const t = stable(await turn(session, ua));
  env.SEARCH_FALLBACK = keep;
  resetSearchFallback();
  calls.length = 0;
  logs.length = 0;
  return t;
}

test('switch and errors: off by default, on only for the website; a quota error is 429, RESOURCE_EXHAUSTED or quota', () => {
  const req = (ua) => new Request(ORIGIN, { headers: { 'user-agent': ua } });
  assert.equal(searchFallbackOn({}, req(UA)), false);
  assert.equal(searchFallbackOn({ SEARCH_FALLBACK: 'off' }, req(UA)), false);
  assert.equal(searchFallbackOn({ SEARCH_FALLBACK: 'on' }, req(UA)), true);
  assert.equal(searchFallbackOn({ SEARCH_FALLBACK: 'on' }, req(APP_UA)), false);
  assert.equal(searchFallbackOn({ SEARCH_FALLBACK: 'on' }, req(EDU_UA)), false);
  assert.equal(isQuotaError(Object.assign(new Error('Google Gemini is busy right now (HTTP 429).'), { status: 429 })), true);
  assert.equal(isQuotaError(new Error('Google Gemini HTTP 403: Quota exceeded for quota metric')), true);
  assert.equal(isQuotaError(new Error('Google Gemini HTTP 400: RESOURCE_EXHAUSTED')), true);
  assert.equal(isQuotaError(Object.assign(new Error('Google Gemini HTTP 500: internal'), { status: 500 })), false);
  assert.equal(isQuotaError(new Error('Gemini 3.8 Flash timed out after 30s.')), false);
});

test('the trip lasts until the next Pacific midnight (DST days too), with one Google re-probe an hour', () => {
  // 2026-10-26 15:00 PDT (UTC-7) → midnight PDT = 07:00 UTC on the 27th
  assert.equal(new Date(nextPacificMidnight(Date.UTC(2026, 9, 26, 22, 0))).toISOString(), '2026-10-27T07:00:00.000Z');
  // 2026-12-01 23:59 PST (UTC-8) → 08:00 UTC on the 2nd
  assert.equal(new Date(nextPacificMidnight(Date.UTC(2026, 11, 2, 7, 59))).toISOString(), '2026-12-02T08:00:00.000Z');
  // the night DST ends (Nov 1, 2026): Saturday 20:00 PDT → Sunday 00:00 PDT = 07:00 UTC
  assert.equal(new Date(nextPacificMidnight(Date.UTC(2026, 10, 1, 3, 0))).toISOString(), '2026-11-01T07:00:00.000Z');
  // Sunday Nov 1 10:00 PST → Monday 00:00 PST = 08:00 UTC
  assert.equal(new Date(nextPacificMidnight(Date.UTC(2026, 10, 1, 18, 0))).toISOString(), '2026-11-02T08:00:00.000Z');
  const fb = searchFallback({ models: [modelOf('claude-sonnet-5-5')], keys: { anthropic: { key: 'a' } }, turnId: 't1' });
  const t0 = Date.UTC(2026, 9, 26, 22, 0); // 15:00 Pacific
  assert.equal(fb.skipGoogle(t0), false, 'not tripped: Google');
  fb.tripped(t0);
  assert.equal(searchFallbackState().until, Date.UTC(2026, 9, 27, 7, 0));
  assert.equal(fb.skipGoogle(t0 + 60_000), true, 'tripped: straight to Claude');
  assert.equal(fb.skipGoogle(t0 + 59 * 60_000), true);
  assert.equal(fb.skipGoogle(t0 + 60 * 60_000), false, 'an hour on: Google is probed first');
  assert.equal(fb.skipGoogle(t0 + 61 * 60_000), true, 'one probe an hour, not one per call');
  fb.tripped(t0 + 60 * 60_000); // the probe hit the quota again
  assert.equal(fb.skipGoogle(t0 + 90 * 60_000), true);
  assert.equal(fb.skipGoogle(t0 + 120 * 60_000), false, 'next hourly probe');
  assert.equal(fb.skipGoogle(Date.UTC(2026, 9, 27, 7, 0)), false, 'a new Pacific day: Google again');
  assert.equal(searchFallbackState().until, 0);
});

test('Google answers: no fallback, the answer byte-identical to the switch off', async () => {
  const session = await signedIn();
  const base = await today(session);
  env.SEARCH_FALLBACK = 'on';
  const raw = await turn(session);
  assert.equal(stable(raw), base);
  assert.equal(fallbackCalls().length, 0);
  assert.equal(logs.length, 0);
  assert.ok(calls.some((c) => c.who === 'gemini-search' && c.purpose === 'anchor'));
  assert.ok(calls.some((c) => c.who === 'gemini-search' && c.purpose === 'evidence'));
});

test('a Gemini 500 is not a quota error: no fallback, as today', async () => {
  const session = await signedIn();
  fx.google = '500';
  const base = await today(session);
  env.SEARCH_FALLBACK = 'on';
  assert.equal(stable(await turn(session)), base);
  assert.equal(fallbackCalls().length, 0);
  assert.equal(searchFallbackState().until, 0);
});

test('SEARCH_FALLBACK off and Google 429: no fallback (today)', async () => {
  const session = await signedIn();
  fx.google = '429';
  await turn(session);
  assert.equal(fallbackCalls().length, 0);
  assert.equal(logs.length, 0);
});

test('Google 429: the same search is retried with Claude (web search tool), the trip skips Google for the rest of the turn and the next', async () => {
  const session = await signedIn();
  env.SEARCH_FALLBACK = 'on';
  fx.google = '429';
  const raw = await turn(session);
  const anchor = calls.filter((c) => c.purpose === 'anchor').map((c) => c.who);
  assert.deepEqual(anchor, ['gemini-search', 'claude'], 'Google first, then Claude once');
  assert.ok(calls.find((c) => c.who === 'claude').tools?.[0]?.name === 'web_search', 'Claude searches with its web search tool');
  const evidence = calls.filter((c) => c.purpose === 'evidence').map((c) => c.who);
  assert.deepEqual(evidence, ['claude'], 'tripped: the evidence check goes straight to Claude');
  assert.match(await finalText(raw), /11,423/);
  assert.deepEqual(logs.map((l) => [l.provider, l.reason]), [['anthropic', 'gemini_429'], ['anthropic', 'tripped']]);
  for (const l of logs) assert.deepEqual(Object.keys(l).sort(), ['evt', 'provider', 'reason', 'turn']);
  assert.match(logs[0].turn, /^[0-9a-f]{24}$/);
  assert.equal(searchFallbackState().until, nextPacificMidnight(Date.now()));
  calls.length = 0;
  await turn(session);
  assert.equal(calls.filter((c) => c.who === 'gemini-search').length, 0, 'the next turn too, within the hour');
});

test('a 403 RESOURCE_EXHAUSTED counts as quota too', async () => {
  const session = await signedIn();
  env.SEARCH_FALLBACK = 'on';
  fx.google = '403q';
  await turn(session);
  assert.equal(logs[0].reason, 'gemini_quota');
  assert.equal(logs[0].provider, 'anthropic');
});

test('Claude fails: GPT web search; the switches are logged', async () => {
  const session = await signedIn();
  env.SEARCH_FALLBACK = 'on';
  fx.google = '429';
  fx.claude = 'fail';
  const raw = await turn(session);
  assert.deepEqual(calls.filter((c) => c.purpose === 'anchor').map((c) => c.who), ['gemini-search', 'claude', 'gpt-search']);
  assert.match(await finalText(raw), /11,423/);
  assert.deepEqual(logs.slice(0, 2).map((l) => [l.provider, l.reason]), [['anthropic', 'gemini_429'], ['openai', 'anthropic_failed']]);
});

test('Google recovers: after the trip, the hourly probe finds Google working and the trip ends', async () => {
  const session = await signedIn();
  env.SEARCH_FALLBACK = 'on';
  fx.google = '429';
  // a fixed noon (Pacific), so "an hour later" never crosses midnight, when the trip ends on its own
  const realNow = Date.now;
  const start = Date.parse('2026-10-26T19:00:00Z');
  Date.now = () => start;
  try {
    await turn(session);
  } finally {
    Date.now = realNow;
  }
  assert.ok(searchFallbackState().until > 0);
  // an hour later: probe Google first
  Date.now = () => start + 61 * 60_000;
  try {
    fx.google = 'ok';
    calls.length = 0;
    logs.length = 0;
    await turn(session);
  } finally {
    Date.now = realNow;
  }
  assert.equal(calls[0].who, 'gemini-search', 'the probe goes to Google');
  assert.equal(fallbackCalls().length, 0);
  assert.deepEqual(logs.map((l) => [l.provider, l.reason]), [['gemini', 'recovered']]);
  assert.equal(searchFallbackState().until, 0);
});

test('Claude and GPT both fail: the turn is exactly today’s', async () => {
  const session = await signedIn();
  fx.google = '429';
  const base = await today(session);
  env.SEARCH_FALLBACK = 'on';
  fx.claude = 'fail';
  fx.gpt = 'fail';
  const raw = await turn(session);
  assert.equal(stable(raw), base);
  // each search call tried each fallback once, never twice
  assert.equal(calls.filter((c) => c.who === 'claude' && c.purpose === 'anchor').length, 1);
  assert.equal(calls.filter((c) => c.who === 'gpt-search' && c.purpose === 'anchor').length, 1);
});

test('the iPhone and Edu apps never fall back: today’s bytes and no Claude/GPT search, even while tripped', async () => {
  const session = await signedIn();
  fx.google = '429';
  for (const ua of [APP_UA, EDU_UA]) {
    const base = await today(session, ua);
    env.SEARCH_FALLBACK = 'on';
    const raw = await turn(session, ua);
    assert.equal(stable(raw), base, ua);
    assert.equal(fallbackCalls().length, 0);
    assert.equal(logs.length, 0);
  }
  // tripped by a website turn, then the app again
  await turn(session, UA);
  assert.ok(searchFallbackState().until > 0);
  calls.length = 0;
  logs.length = 0;
  await turn(session, APP_UA);
  assert.equal(fallbackCalls().length, 0);
  assert.ok(calls.some((c) => c.who === 'gemini-search'), 'the app still asks Google, as today');
});
