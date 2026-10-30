// EVES_STRONG (eden/checks.js evesStrongMode, eden/eves.js): askeden.com's website-only accuracy mode. When on, the anchor's
// Gemini 3.8 Flash runs at medium effort and a second answer with GPT's web search runs beside it; claims the two dispute
// go to the web evidence check (and its correction). Off, the iPhone/Edu app, or a failed second answer: today's turn.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetSessions } from '../src/eden/session.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { clearHostedEvesVault } from '../src/eden/eves.js';
import { evesAnchorMode, evesStrongMode, strongSecondPick } from '../src/eden/checks.js';
import { resetSearchFallback } from '../src/eden/search-fallback.js';
import { modelOf } from '../src/eden/providers.js';
import { Account, Link, appleJwk, identityToken, namespace, readEvents } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
const APP_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 EdenApp/1.4';
const EDU_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 EdenEdu/1.0';
const realFetch = globalThis.fetch;
const realLog = console.log;
const SRC = [{ title: 'Pro Football Reference', url: 'https://www.pro-football-reference.com/players/H/HenrDe00.htm' }];
const RIGHT = 'Derrick Henry has 11,423 career rushing yards.';
const WRONG = 'Derrick Henry has 12,345 career rushing yards.';
const QUESTION = 'How many career rushing yards does Derrick Henry have?';
const ANCHOR_SYS = /Answer the question concisely and factually in at most 200 words/;
const isEvidence = (s) => /You check one claim against the web/.test(s);

let env;
let waits;
let calls; // { who, purpose, effort?, tools? }
let logs;
let fx; // { anchor: Gemini's searched text, lanes: text, second: GPT's searched text | 'fail', evidence, gptAnchor? }
let judgeSeen;
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
const PREMISE_FALSE = 'React has no built-in hook named useStableCallback.';
const evidenceReply = (claimText = '') =>
  JSON.stringify(
    fx.premiseFalse && claimText.includes(fx.premiseFalse)
      ? { verdict: 'contradicted', summary: PREMISE_FALSE, sourceValue: 'no such hook', disputed: true, fixedSentence: null }
      : fx.evidence === 'contradicted'
      ? { verdict: 'contradicted', summary: 'Pro Football Reference lists 11,423 career rushing yards.', sourceValue: '11,423', disputed: true, fixedSentence: RIGHT }
      : { verdict: 'supported', summary: 'Pro Football Reference lists 11,423 career rushing yards.', sourceValue: '11,423', disputed: false, fixedSentence: null },
  );
/** The judge: the answers saying 11,423 against those saying 12,345, the claim the anchor's (the letters read off the prompt). */
const judgeReply = (prompt) => {
  judgeSeen.push(prompt);
  const letters = (needle) => [...prompt.matchAll(/<answer id="([A-F])">\s*([^<]*)/g)].filter((m) => m[2].includes(needle)).map((m) => m[1]);
  const wrong = letters('12,345');
  const right = letters('11,423');
  const anchorSaysWrong = (fx.gptAnchor ? fx.second : fx.anchor) === WRONG; // the kept anchor's text (gptAnchor: GPT's)
  const by = anchorSaysWrong ? wrong : right;
  const against = anchorSaysWrong ? right : wrong;
  const claim = anchorSaysWrong ? WRONG : RIGHT;
  return JSON.stringify({ winner: by[0] ?? 'A', claims: [{ text: claim, kind: 'number', by, against, status: 'disputed', quotes: Object.fromEntries(by.map((l) => [l, claim])), missingFromWinner: false, essential: true }], summary: 'They disagree on the yards.' });
};

beforeEach(() => {
  waits = [];
  calls = [];
  logs = [];
  judgeSeen = [];
  fx = { anchor: RIGHT, lanes: RIGHT, second: RIGHT, evidence: 'supported' };
  forgetAppleKeys();
  forgetSessions();
  resetSearchFallback();
  console.log = (...a) => {
    const s = a.join(' ');
    if (/"evt":"eves_second"/.test(s)) logs.push(JSON.parse(s));
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
    if ((url.includes('generativelanguage.googleapis.com') || url.includes('aiplatform.googleapis.com')) && url.includes(':streamGenerateContent')) {
      const isVertex = url.includes('aiplatform.googleapis.com');
      if (isVertex && fx.vertexFail) return Response.json({ error: { code: 401, message: 'UNAUTHENTICATED' } }, { status: 401 });
      const sys = JSON.stringify(body.systemInstruction || '');
      const search = Array.isArray(body.tools) && body.tools.length > 0;
      if (search) {
        const purpose = isEvidence(sys) ? 'evidence' : /premise-check/.test(sys) ? 'rewrite' : ANCHOR_SYS.test(sys) ? 'anchor' : 'search';
        calls.push({ who: isVertex ? 'vertex-search' : 'gemini-search', purpose, thinking: body.generationConfig?.thinkingConfig ?? null, url, auth: init.headers?.authorization ?? null, tools: body.tools });
        if (purpose === 'evidence') {
          if (fx.evidence === 'fail') return Response.json({ error: { code: 500, message: 'internal' } }, { status: 500 });
          return sse(geminiSse(`Pro Football Reference.\n${evidenceReply(JSON.stringify(body.contents))}`, SRC));
        }
        if (purpose === 'rewrite') return sse(geminiSse(fx.rewritten, SRC));
        return sse(geminiSse(fx.anchor, SRC));
      }
      if (/You list what a question takes for granted/.test(sys)) {
        calls.push({ who: 'premise' });
        return sse(geminiSse(JSON.stringify({ claims: fx.premises || [] })));
      }
      if (/You are the judge in a fact-checking step/.test(sys)) {
        calls.push({ who: 'judge' });
        if (fx.badJudge && fx.badJudge-- > 0) return sse(geminiSse('Sorry, here is my view in prose.'));
        return sse(geminiSse(judgeReply(body.contents.flatMap((c) => c.parts.map((x) => x.text || '')).join('\n'))));
      }
      calls.push({ who: 'gemini', model: url.match(/models\/([^:]+)/)?.[1] });
      if (fx.slowLite && url.includes('gemini-3.5-flash-lite')) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, 300);
          init.signal?.addEventListener('abort', () => (clearTimeout(t), reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))), { once: true });
        });
      }
      return sse(geminiSse(fx.lanes));
    }
    if (url.includes('api.openai.com/v1/responses')) {
      const sys = JSON.stringify(body.instructions || body.input || '');
      if (isEvidence(sys)) {
        calls.push({ who: 'gpt-evidence', purpose: 'cross' });
        const verdict = fx.crossEvidence || 'supported';
        return sse(responsesSse(`PFR via GPT.\n${JSON.stringify({ verdict, summary: verdict === 'contradicted' ? 'GPT: the sources do not show this.' : 'GPT: the sources show this.', sourceValue: '', disputed: verdict === 'contradicted', fixedSentence: null })}`));
      }
      if (/premise-check/.test(sys)) {
        calls.push({ who: 'gpt-rewrite' });
        return sse(responsesSse(fx.rewritten));
      }
      calls.push({ who: 'gpt-search', purpose: ANCHOR_SYS.test(sys) ? 'second' : 'other', tools: body.tools, maxToolCalls: body.max_tool_calls, effort: body.reasoning?.effort ?? null, model: body.model });
      if (fx.second === 'fail') return Response.json({ error: { message: 'server error' } }, { status: 500 });
      return sse(responsesSse(fx.second));
    }
    if (url.includes('api.openai.com')) {
      const sys = body.messages?.[0]?.role === 'system' ? body.messages[0].content : '';
      if (/You list what a question takes for granted/.test(sys)) {
        calls.push({ who: 'premise' });
        return sse(openaiSse(JSON.stringify({ claims: fx.premises || [] })));
      }
      if (/You are the judge in a fact-checking step/.test(sys)) {
        calls.push({ who: 'judge' });
        return sse(openaiSse(judgeReply(body.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n'))));
      }
      calls.push({ who: 'gpt' });
      return sse(openaiSse(fx.lanes));
    }
    if (url.includes('api.perplexity.ai/v1/responses')) {
      calls.push({ who: 'pplx-evidence', preset: body.preset });
      const verdict = fx.evidence || 'supported';
      return Response.json({
        status: 'completed',
        model: 'openai/gpt-6-luna',
        output: [
          { type: 'search_results', results: [{ url: 'https://www.pro-football-reference.com/players/H/HenrDe00.htm', title: 'PFR' }] },
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: `PFR via Perplexity.\n${JSON.stringify({ verdict, summary: verdict === 'contradicted' ? 'PPLX: contradicted.' : 'PPLX: supported.', sourceValue: '11,423', disputed: verdict === 'contradicted', fixedSentence: verdict === 'contradicted' ? RIGHT : null })}`,
              },
            ],
          },
        ],
        usage: { cost: { total_cost: 0.0017 } },
      });
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
const TWO = [{ model: 'gpt-6-luna', effort: 'none' }, { model: 'gemini-3.8-flash', effort: 'low' }];
async function turn(session, ua = UA, models = TWO, question = QUESTION) {
  const random = Math.random;
  let seed = 7;
  Math.random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  try {
    const res = await hit('/api/chat/eves', {
      method: 'POST',
      session,
      headers: { 'x-jarvis-chat': '1', 'user-agent': ua },
      body: { messages: [{ role: 'user', content: question }], mode: 'on', vault: false, models, settings: { level: 3 } },
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
const events = (raw) => readEvents(new Response(raw));
const finalText = async (raw) => (await events(raw)).filter((e) => e.type === 'text' && e.data.lane === 'final').map((e) => e.data.text).join('');
const verdictOf = async (raw) => (await events(raw)).find((e) => e.type === 'verdict').data;
/** today's bytes and calls for this situation: the switch unset */
async function today(session, ua = UA) {
  const keep = env.EVES_STRONG;
  delete env.EVES_STRONG;
  calls.length = 0;
  logs.length = 0;
  const t = stable(await turn(session, ua));
  const c = calls.map((x) => x.who + ':' + (x.purpose ?? ''));
  env.EVES_STRONG = keep;
  calls.length = 0;
  logs.length = 0;
  judgeSeen.length = 0;
  return { t, c };
}
const secondCalls = () => calls.filter((c) => c.who === 'gpt-search');
const anchorCall = () => calls.find((c) => c.who === 'gemini-search' && c.purpose === 'anchor');
/** every event but the opening `eves` one (the plan names the second answer it was going to ask) */
const afterPlan = (raw) => raw.split('\n\n').filter((b) => !b.startsWith('event: eves\n')).join('\n\n');

test('the switch: off by default, on / owner from EVES_STRONG, junk is off, the iPhone and Edu apps always off', () => {
  const req = (ua) => new Request(ORIGIN, { headers: { 'user-agent': ua } });
  assert.equal(evesStrongMode({}, req(UA)), 'off');
  assert.equal(evesStrongMode({ EVES_STRONG: 'off' }, req(UA)), 'off');
  assert.equal(evesStrongMode({ EVES_STRONG: 'on' }, req(UA)), 'on');
  assert.equal(evesStrongMode({ EVES_STRONG: ' Owner ' }, req(UA)), 'owner');
  assert.equal(evesStrongMode({ EVES_STRONG: 'yes' }, req(UA)), 'off');
  for (const m of ['on', 'owner']) {
    assert.equal(evesStrongMode({ EVES_STRONG: m }, req(APP_UA)), 'off');
    assert.equal(evesStrongMode({ EVES_STRONG: m }, req(EDU_UA)), 'off');
  }
  const gpt = [modelOf('gpt-6.1-sol'), modelOf('gpt-6-sol')].filter(Boolean);
  assert.equal(strongSecondPick(gpt, { openai: { key: 'o' } }).model.id, 'gpt-6.1-sol');
  assert.equal(strongSecondPick(gpt, {}), null, 'no OpenAI key: no second answer');
  assert.equal(strongSecondPick(gpt, { openai: { key: 'o' } }, ['gemini']), null, 'OpenAI switched off: none');
  assert.equal(strongSecondPick([modelOf('gemini-3.8-flash')], { openai: { key: 'o' } }), null, 'not on the list: none');
});

test('off (unset or "off"): the same bytes, no second answer, the anchor forced to low effort', async () => {
  const session = await signedIn();
  fx.second = WRONG; // would dispute, if it ran
  const base = await today(session);
  env.EVES_STRONG = 'off';
  const raw = await turn(session);
  assert.equal(stable(raw), base.t);
  assert.deepEqual(calls.map((x) => x.who + ':' + (x.purpose ?? '')), base.c);
  assert.equal(secondCalls().length, 0);
  assert.equal(logs.length, 0);
  assert.doesNotMatch(raw, /"second"/);
  const est = await (await hit('/api/chat/eves/estimate', { method: 'POST', session, headers: { 'x-jarvis-chat': '1' }, body: { prompt: QUESTION, settings: { level: 3 }, mode: 'on' } })).json();
  assert.equal(est.second, undefined);
});

test('on: the anchor at medium effort, and a second answer from GPT with web search, same prompt, waited for', async () => {
  const session = await signedIn();
  await today(session);
  delete env.EVES_STRONG;
  await turn(session);
  const offThinking = anchorCall().thinking;
  calls.length = 0;
  env.EVES_STRONG = 'on';
  const raw = await turn(session);
  const onThinking = anchorCall().thinking;
  assert.notDeepEqual(onThinking, offThinking, 'the anchor’s effort changed');
  assert.match(JSON.stringify(onThinking), /medium|MEDIUM|\d{3,}/);
  const s = secondCalls();
  assert.equal(s.length, 1, 'one second searched answer');
  assert.equal(s[0].purpose, 'second', 'with the anchor’s own system prompt');
  assert.equal(s[0].model, 'gpt-6.1-sol');
  assert.ok((s[0].tools || []).some((t) => /web_search/.test(t.type)), 'with OpenAI web search');
  assert.equal(s[0].maxToolCalls, 2);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].ok, true);
  assert.equal(logs[0].model, 'gpt-6.1-sol');
  // they all agree: no judge and no evidence check beyond today's
  assert.equal(calls.filter((c) => c.who === 'judge').length, 0);
  assert.equal(calls.filter((c) => c.purpose === 'evidence').length, 0);
  const v = await verdictOf(raw);
  assert.equal(v.winner, v.anchor.lane, 'the anchor stays the winner');
  assert.equal(v.second.model, 'gpt-6.1-sol');
  assert.match(await finalText(raw), /11,423/);
  // the estimate prices it
  delete env.EVES_STRONG;
  const off = await (await hit('/api/chat/eves/estimate', { method: 'POST', session, headers: { 'x-jarvis-chat': '1' }, body: { prompt: QUESTION, settings: { level: 3 }, mode: 'on' } })).json();
  env.EVES_STRONG = 'on';
  const on = await (await hit('/api/chat/eves/estimate', { method: 'POST', session, headers: { 'x-jarvis-chat': '1' }, body: { prompt: QUESTION, settings: { level: 3 }, mode: 'on' } })).json();
  assert.equal(on.second.model, 'gpt-6.1-sol');
  assert.ok(on.totalUSD > off.totalUSD + 0.02, `${on.totalUSD} vs ${off.totalUSD}: two $0.01 searches and the answer`);
  assert.ok(on.typicalUSD > off.typicalUSD);
  assert.ok(on.notes.some((n) => /GPT-6\.1 Sol also answers with its own web search/.test(n)));
});

test('on: when the second answer disputes the anchor, the claim goes to the web evidence check and is corrected', async () => {
  const session = await signedIn();
  env.EVES_STRONG = 'on';
  fx.anchor = WRONG; // the anchor is wrong, every other answer and the web say 11,423
  fx.lanes = WRONG;
  fx.second = RIGHT;
  fx.evidence = 'contradicted';
  const raw = await turn(session);
  assert.equal(secondCalls().length, 1);
  assert.equal(calls.filter((c) => c.who === 'judge').length >= 1, true, 'the judge compared them');
  assert.ok(judgeSeen.some((p) => p.includes('12,345') && p.includes('11,423')), 'the judge saw both searched answers');
  assert.equal(calls.filter((c) => c.purpose === 'evidence').length, 1, 'the disputed claim went to the web');
  const v = await verdictOf(raw);
  assert.equal(v.winner, v.anchor.lane, 'the anchor stays the winner');
  assert.ok(v.claims.some((c) => c.status === 'disputed' && c.by.includes(v.anchor.lane) && c.against.includes(v.second.lane) && c.verdict === 'contradicted'));
  assert.ok(v.corrections.some((c) => c.action === 'fix'));
  const text = await finalText(raw);
  assert.match(text, /11,423/);
  assert.doesNotMatch(text, /12,345/);
});

test('off, the same disagreement: no second answer, no web check of it (the anchor agrees with every lane)', async () => {
  const session = await signedIn();
  fx.anchor = WRONG;
  fx.lanes = WRONG;
  fx.second = RIGHT;
  fx.evidence = 'contradicted';
  const raw = await turn(session);
  assert.equal(secondCalls().length, 0);
  assert.equal(calls.filter((c) => c.purpose === 'evidence').length, 0);
  assert.match(await finalText(raw), /12,345/);
});

test('the iPhone and Edu apps: today’s bytes with EVES_STRONG on or owner, no second answer', async () => {
  const session = await signedIn();
  fx.second = WRONG;
  for (const ua of [APP_UA, EDU_UA]) {
    for (const m of ['on', 'owner']) {
      const base = await today(session, ua);
      env.EVES_STRONG = m;
      const raw = await turn(session, ua);
      assert.equal(stable(raw), base.t, `${ua} ${m}`);
      assert.deepEqual(calls.map((x) => x.who + ':' + (x.purpose ?? '')), base.c);
      assert.equal(secondCalls().length, 0);
      assert.equal(logs.length, 0);
    }
  }
});

test('owner mode: a non-owner account gets today’s turn', async () => {
  const session = await signedIn();
  fx.second = WRONG;
  const base = await today(session);
  env.EVES_STRONG = 'owner';
  const raw = await turn(session);
  assert.equal(stable(raw), base.t);
  assert.equal(secondCalls().length, 0);
});

test('on, the second answer fails: today’s answer and verdict (only the plan named it), and a failure log', async () => {
  const session = await signedIn();
  fx.anchor = RIGHT;
  fx.lanes = WRONG; // a dispute today's way: the lanes against the anchor
  fx.evidence = 'supported';
  fx.second = 'fail';
  const base = await today(session);
  env.EVES_STRONG = 'on';
  const raw = await turn(session);
  assert.equal(secondCalls().length, 1, 'it was asked');
  assert.equal(logs.length, 1);
  assert.equal(logs[0].ok, false);
  assert.equal(afterPlan(stable(raw)), afterPlan(base.t));
  assert.deepEqual(calls.filter((x) => x.who !== 'gpt-search').map((x) => x.who + ':' + (x.purpose ?? '')), base.c);
});

test('on, three lanes: the judge still gets at most 4 answers (the lane from GPT’s provider sits out) and the dispute is checked', async () => {
  const session = await signedIn();
  env.EVES_STRONG = 'on';
  fx.anchor = WRONG;
  fx.lanes = WRONG;
  fx.second = RIGHT;
  fx.evidence = 'contradicted';
  const three = [{ model: 'gpt-6-luna', effort: 'none' }, { model: 'gemini-3.8-flash', effort: 'low' }, { model: 'gemini-3.5-flash-lite', effort: 'none' }];
  const raw = await turn(session, UA, three);
  const v = await verdictOf(raw);
  assert.equal(v.anchor.lane, 3);
  assert.equal(v.second.lane, 4);
  assert.ok(judgeSeen.length >= 1);
  for (const p of judgeSeen) assert.ok((p.match(/<answer id="/g) || []).length <= 4, 'at most 4 answers compared');
  assert.ok(judgeSeen.some((p) => p.includes('11,423')), 'the second answer is among them');
  assert.equal(calls.filter((c) => c.purpose === 'evidence').length, 1);
  assert.equal(v.winner, 3);
  assert.match(await finalText(raw), /11,423/);
  const checks = (await events(raw)).filter((e) => e.type === 'checks').map((e) => e.data.lane).sort();
  assert.deepEqual(checks, [0, 1, 2], 'every lane still gets its checks');
});

// ── EVES_ANCHOR=gpt: GPT's web-search answer is the anchor, Gemini 3.8 Flash's (Google search, medium) the second ──
const geminiSearched = () => calls.find((c) => c.who === 'gemini-search' && c.purpose === 'anchor');
const estimate = async (session, ua = UA) => (await hit('/api/chat/eves/estimate', { method: 'POST', session, headers: { 'x-jarvis-chat': '1', 'user-agent': ua }, body: { prompt: QUESTION, settings: { level: 3 }, mode: 'on' } })).json();

test('EVES_ANCHOR: gemini by default, gpt only when it says so', () => {
  assert.equal(evesAnchorMode({}), 'gemini');
  assert.equal(evesAnchorMode({ EVES_ANCHOR: 'gemini' }), 'gemini');
  assert.equal(evesAnchorMode({ EVES_ANCHOR: ' GPT ' }), 'gpt');
  assert.equal(evesAnchorMode({ EVES_ANCHOR: 'claude' }), 'gemini');
});

test('EVES_ANCHOR=gpt without EVES_STRONG (unset or off), or in the iPhone/Edu app: today’s bytes', async () => {
  const session = await signedIn();
  fx.second = WRONG;
  for (const ua of [UA, APP_UA, EDU_UA]) {
    for (const st of [undefined, 'off', ...(ua === UA ? [] : ['on', 'owner'])]) {
      const base = await today(session, ua);
      env.EVES_ANCHOR = 'gpt';
      if (st) env.EVES_STRONG = st;
      const raw = await turn(session, ua);
      assert.equal(stable(raw), base.t, `${ua} ${st}`);
      assert.equal(secondCalls().length, 0);
      const est = await estimate(session, ua);
      assert.equal(est.anchor.model, 'gemini-3.8-flash');
      assert.equal(est.second, undefined);
      delete env.EVES_ANCHOR;
      delete env.EVES_STRONG;
    }
  }
});

test('EVES_STRONG=on + EVES_ANCHOR=gpt: GPT-6.1 Sol with web search is the kept anchor, Gemini 3.8 Flash (Google, medium) the second; the estimate prices it so', async () => {
  const session = await signedIn();
  env.EVES_STRONG = 'on';
  env.EVES_ANCHOR = 'gpt';
  fx.gptAnchor = true;
  const raw = await turn(session);
  const g = secondCalls();
  assert.equal(g.length, 1);
  assert.equal(g[0].purpose, 'second', 'GPT with the anchor’s system prompt');
  assert.equal(g[0].model, 'gpt-6.1-sol');
  assert.equal(g[0].effort, 'medium');
  assert.ok((g[0].tools || []).some((t) => /web_search/.test(t.type)));
  assert.equal(g[0].maxToolCalls, 2);
  assert.deepEqual(geminiSearched().thinking?.thinkingLevel, 'MEDIUM', 'Gemini’s searched answer at medium');
  const v = await verdictOf(raw);
  assert.equal(v.anchor.model, 'gpt-6.1-sol');
  assert.equal(v.second.model, 'gemini-3.8-flash');
  assert.equal(v.winner, v.anchor.lane);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].model, 'gemini-3.8-flash', 'the second-answer log names Gemini');
  const ev = (await events(raw)).find((e) => e.type === 'eves').data;
  assert.equal(ev.anchor.model, 'gpt-6.1-sol');
  assert.equal(ev.second.model, 'gemini-3.8-flash');
  const est = await estimate(session);
  assert.equal(est.anchor.model, 'gpt-6.1-sol');
  assert.equal(est.second.model, 'gemini-3.8-flash');
  delete env.EVES_ANCHOR;
  const gem = await estimate(session);
  assert.equal(gem.anchor.model, 'gemini-3.8-flash');
  assert.equal(gem.second.model, 'gpt-6.1-sol');
  assert.ok(Math.abs(est.totalUSD - gem.totalUSD) < 1e-9, 'the same two searched answers, priced the same either way round');
});

test('EVES_ANCHOR=gpt: when Gemini’s second answer disputes GPT’s, the claim goes to the web check and GPT’s is corrected', async () => {
  const session = await signedIn();
  env.EVES_STRONG = 'on';
  env.EVES_ANCHOR = 'gpt';
  fx.gptAnchor = true;
  fx.second = WRONG; // GPT (the anchor) is wrong
  fx.lanes = WRONG;
  fx.anchor = RIGHT; // Gemini (the second) and the web say 11,423
  fx.evidence = 'contradicted';
  const raw = await turn(session);
  assert.equal(calls.filter((c) => c.purpose === 'evidence').length, 1);
  const v = await verdictOf(raw);
  assert.equal(v.anchor.model, 'gpt-6.1-sol');
  assert.equal(v.winner, v.anchor.lane);
  assert.ok(v.claims.some((c) => c.status === 'disputed' && c.by.includes(v.anchor.lane) && c.against.includes(v.second.lane) && c.verdict === 'contradicted'));
  const text = await finalText(raw);
  assert.match(text, /11,423/);
  assert.doesNotMatch(text, /12,345/);
});

test('EVES_ANCHOR=gpt and GPT’s answer fails: Gemini’s searched answer becomes the anchor (never a turn without one)', async () => {
  const session = await signedIn();
  env.EVES_STRONG = 'on';
  env.EVES_ANCHOR = 'gpt';
  fx.second = 'fail';
  fx.anchor = RIGHT;
  fx.lanes = WRONG;
  fx.evidence = 'supported';
  const raw = await turn(session);
  assert.equal(secondCalls().length, 1, 'GPT was asked');
  assert.ok(geminiSearched(), 'Gemini answered with search');
  const v = await verdictOf(raw);
  assert.equal(v.anchor.model, 'gemini-3.8-flash');
  assert.equal(v.anchor.name, 'Gemini 3.8 Flash');
  assert.equal(v.second, undefined);
  assert.equal(v.winner, v.anchor.lane, 'Gemini’s searched answer is kept');
  assert.match(v.summary, /Gemini 3\.8 Flash \(with web search\) searched the web/);
  assert.match(await finalText(raw), /11,423/);
});

// ── EVES_STRONG's fixes: EVES_PREMISE (F1), EVES_NO_EARLY_CUT (F2), EVES_HEDGE_UNRESOLVED (F3) ──
const REACT_Q = 'How do I use the React useStableCallback hook to keep a stable function reference?';
const REACT_FAKE = 'Use useStableCallback(fn) from React: it returns a function whose identity never changes.';
const REACT_RIGHT = 'React has no built-in useStableCallback hook; use useCallback, or the useEffectEvent pattern.';
const FIXES = ['EVES_PREMISE', 'EVES_NO_EARLY_CUT', 'EVES_HEDGE_UNRESOLVED', 'EVES_EVIDENCE_CROSS', 'EVES_EVIDENCE_SEARCH', 'PERPLEXITY_API_KEY'];
const allFixes = () => FIXES.forEach((k) => (env[k] = 'on'));
const premiseSetup = () => {
  fx.anchor = REACT_FAKE;
  fx.lanes = REACT_FAKE;
  fx.second = REACT_FAKE;
  fx.rewritten = REACT_RIGHT;
  fx.premiseFalse = 'useStableCallback';
  fx.premises = [{ text: 'React has a built-in hook named useStableCallback.', kind: 'code' }];
};

test('the fixes switches: each off unless "on"; the premise gate is false on everyday chat', async () => {
  const { evesStrongFixes, premiseTurn } = await import('../src/eden/checks.js');
  assert.deepEqual(evesStrongFixes({}), { premise: false, noEarlyCut: false, hedge: false, cross: false });
  assert.deepEqual(evesStrongFixes({ EVES_PREMISE: 'on', EVES_NO_EARLY_CUT: 'yes', EVES_HEDGE_UNRESOLVED: ' ON ', EVES_EVIDENCE_CROSS: 'on' }), { premise: true, noEarlyCut: false, hedge: true, cross: true });
  for (const q of [REACT_Q, 'What does git rebase --keep-committer-date do?', 'Which European diplomat visited the Golestan Palace in 1840?']) assert.equal(premiseTurn(q), true, q);
  for (const q of ['hi, how are you?', 'write me a poem about cats', 'Explain how photosynthesis works']) assert.equal(premiseTurn(q), false, q);
});

test('the fixes without EVES_STRONG (unset or off), or in the iPhone/Edu app: today’s bytes, no premise call', async () => {
  const session = await signedIn();
  premiseSetup();
  for (const ua of [UA, APP_UA, EDU_UA]) {
    for (const st of [undefined, 'off', ...(ua === UA ? [] : ['on', 'owner'])]) {
      const base = await today(session, ua);
      allFixes();
      env.EVES_ANCHOR = 'gpt';
      if (st) env.EVES_STRONG = st;
      const raw = await turn(session, ua);
      assert.equal(stable(raw), base.t, `${ua} ${st}`);
      assert.equal(calls.filter((c) => c.who === 'premise').length, 0);
      for (const k of [...FIXES, 'EVES_ANCHOR', 'EVES_STRONG']) delete env[k];
    }
  }
});

test('EVES_PREMISE off (EVES_STRONG on): no premise extraction; the fake hook is answered as real (today’s strong)', async () => {
  const session = await signedIn();
  premiseSetup();
  env.EVES_STRONG = 'on';
  const raw = await turn(session, UA, TWO, REACT_Q);
  assert.equal(calls.filter((c) => c.who === 'premise').length, 0);
  assert.match(await finalText(raw), /useStableCallback\(fn\)/);
});

test('EVES_PREMISE: every answer agrees on a fake API, the premise check finds it false, and the kept answer says so', async () => {
  const session = await signedIn();
  premiseSetup();
  env.EVES_STRONG = 'on';
  env.EVES_PREMISE = 'on';
  const raw = await turn(session, UA, TWO, REACT_Q);
  assert.equal(calls.filter((c) => c.who === 'premise').length, 1, 'one cheap extraction');
  const ev = calls.filter((c) => c.purpose === 'evidence');
  assert.ok(ev.length >= 1, 'the premise went through the web evidence check');
  assert.equal(calls.filter((c) => c.purpose === 'rewrite').length, 1, 'the Gemini anchor answered again with the premise note');
  const v = await verdictOf(raw);
  assert.equal(v.premises[0].verdict, 'contradicted');
  assert.equal(v.premiseCorrected, true);
  assert.equal(v.winner, v.anchor.lane);
  const text = await finalText(raw);
  assert.match(text, /no built-in useStableCallback/);
  assert.doesNotMatch(text, /useStableCallback\(fn\)/);
  const ver = (await events(raw)).find((e) => e.type === 'verification').data;
  assert.ok(ver.findings.some((f) => f.check === 'evidence' && f.status === 'fail' && /useStableCallback/.test(f.subject)));
  // the estimate prices it
  const est = await estimate(session);
  const r1 = await (await hit('/api/chat/eves/estimate', { method: 'POST', session, headers: { 'x-jarvis-chat': '1' }, body: { prompt: REACT_Q, settings: { level: 3 }, mode: 'on' } })).json();
  delete env.EVES_PREMISE;
  const r0 = await (await hit('/api/chat/eves/estimate', { method: 'POST', session, headers: { 'x-jarvis-chat': '1' }, body: { prompt: REACT_Q, settings: { level: 3 }, mode: 'on' } })).json();
  assert.ok(r1.totalUSD > r0.totalUSD, `${r1.totalUSD} > ${r0.totalUSD}`);
  assert.equal(r1.fixes.premise, true);
  assert.ok(est.fixes);
});

test('EVES_PREMISE with the GPT anchor: GPT answers again with the note', async () => {
  const session = await signedIn();
  premiseSetup();
  env.EVES_STRONG = 'on';
  env.EVES_ANCHOR = 'gpt';
  env.EVES_PREMISE = 'on';
  fx.gptAnchor = true;
  const raw = await turn(session, UA, TWO, REACT_Q);
  assert.equal(calls.filter((c) => c.who === 'gpt-rewrite').length, 1);
  assert.match(await finalText(raw), /no built-in useStableCallback/);
});

test('EVES_PREMISE: a premise the web supports changes nothing; on everyday chat no extraction runs', async () => {
  const session = await signedIn();
  env.EVES_STRONG = 'on';
  const base = stable(await turn(session));
  calls.length = 0;
  env.EVES_PREMISE = 'on';
  fx.premises = [{ text: 'Derrick Henry is an NFL running back.', kind: 'fact' }];
  const raw = await turn(session);
  assert.equal(calls.filter((c) => c.who === 'premise').length, 1);
  assert.equal(calls.filter((c) => c.purpose === 'rewrite').length, 0);
  assert.equal(await finalText(raw), await finalText(base));
  calls.length = 0;
  await turn(session, UA, TWO, 'write me a poem about cats');
  assert.equal(calls.filter((c) => c.who === 'premise').length, 0);
});

test('EVES_NO_EARLY_CUT: on a premise turn, a slow lane is waited for instead of cut by the quorum', async () => {
  const session = await signedIn();
  env.EVES_STRONG = 'on';
  fx.slowLite = true;
  const three = [{ model: 'gpt-6-luna', effort: 'none' }, { model: 'gemini-3.8-flash', effort: 'low' }, { model: 'gemini-3.5-flash-lite', effort: 'none' }];
  const doneOf = async (raw) => (await events(raw)).filter((e) => e.type === 'done' && e.data.lane === 2).map((e) => e.data.finish);
  const cutRaw = await turn(session, UA, three);
  assert.deepEqual(await doneOf(cutRaw), ['aborted'], 'today: the agreeing quorum lets the slow lane go');
  env.EVES_NO_EARLY_CUT = 'on';
  const raw = await turn(session, UA, three);
  assert.deepEqual(await doneOf(raw), ['stop'], 'waited for');
  assert.doesNotMatch((await verdictOf(raw)).summary, /waited for/);
});

test('EVES_HEDGE_UNRESOLVED: a disputed claim whose web check fails is retried once, then not stated as fact', async () => {
  const session = await signedIn();
  env.EVES_STRONG = 'on';
  fx.anchor = WRONG;
  fx.lanes = RIGHT;
  fx.second = RIGHT;
  fx.evidence = 'fail';
  const before = await turn(session);
  const evToday = calls.filter((c) => c.purpose === 'evidence').length;
  assert.match(await finalText(before), /^Derrick Henry has 12,345 career rushing yards\.$/m, 'today: kept as fact');
  calls.length = 0;
  env.EVES_HEDGE_UNRESOLVED = 'on';
  const raw = await turn(session);
  assert.ok(calls.filter((c) => c.purpose === 'evidence').length > evToday, 'one more try');
  const text = await finalText(raw);
  assert.match(text, /I couldn’t verify this on the web: Derrick Henry has 12,345|12,345 career rushing yards\. \(unverified\)/);
  const v = await verdictOf(raw);
  assert.ok(v.corrections.length >= 1);
});


test('EVES_EVIDENCE_CROSS: the web check wrongly confirms the anchor; GPT’s own check says no, so it is not stated as fact', async () => {
  const session = await signedIn();
  env.EVES_STRONG = 'on';
  env.EVES_HEDGE_UNRESOLVED = 'on';
  fx.anchor = WRONG;
  fx.lanes = RIGHT;
  fx.second = RIGHT;
  fx.evidence = 'supported'; // Gemini's check "confirms" 12,345
  const before = await turn(session);
  assert.match(await finalText(before), /^Derrick Henry has 12,345 career rushing yards\.$/m, 'without it: kept as fact');
  assert.equal(calls.filter((c) => c.who === 'gpt-evidence').length, 0);
  calls.length = 0;
  env.EVES_EVIDENCE_CROSS = 'on';
  fx.crossEvidence = 'contradicted';
  const raw = await turn(session);
  assert.ok(calls.filter((c) => c.who === 'gpt-evidence').length >= 1, 'GPT checked it again');
  assert.match(await finalText(raw), /I couldn’t verify this on the web: Derrick Henry has 12,345/);
  const v = await verdictOf(raw);
  assert.ok(v.claims.some((c) => c.verdict === 'unresolved'));
  // the estimate prices the second checks
  const est = await estimate(session);
  assert.equal(est.fixes.cross, true);
});

test('EVES_EVIDENCE_CROSS: when GPT’s check agrees, the answer is unchanged', async () => {
  const session = await signedIn();
  env.EVES_STRONG = 'on';
  fx.anchor = RIGHT;
  fx.lanes = WRONG;
  fx.second = RIGHT;
  const base = await finalText(await turn(session));
  calls.length = 0;
  env.EVES_EVIDENCE_CROSS = 'on';
  fx.crossEvidence = 'supported';
  const raw = await turn(session);
  assert.ok(calls.filter((c) => c.who === 'gpt-evidence').length >= 1);
  assert.equal(await finalText(raw), base);
});

test('EVES_HEDGE_UNRESOLVED: a judge reply that can’t be read is asked once more instead of shipping an unchecked answer', async () => {
  const session = await signedIn();
  env.EVES_STRONG = 'on';
  fx.anchor = WRONG;
  fx.lanes = RIGHT;
  fx.second = RIGHT;
  fx.evidence = 'contradicted';
  fx.badJudge = 1;
  const before = await verdictOf(await turn(session));
  assert.match(before.summary, /expected JSON/, 'without it: unchecked');
  calls.length = 0;
  env.EVES_HEDGE_UNRESOLVED = 'on';
  fx.badJudge = 1;
  const raw = await turn(session);
  assert.equal(calls.filter((c) => c.who === 'judge').length, 2);
  assert.doesNotMatch((await verdictOf(raw)).summary, /expected JSON/);
  assert.doesNotMatch(await finalText(raw), /12,345/);
});

test('EVES_PREMISE: skips a redundant second searched rewrite when the anchor already rejects the false premise', async () => {
  const session = await signedIn();
  env.EVES_STRONG = 'on';
  env.EVES_ANCHOR = 'gpt';
  env.EVES_PREMISE = 'on';
  premiseSetup();
  fx.second = REACT_RIGHT;
  const raw = await turn(session, { messages: [{ role: 'user', content: REACT_Q }] });
  assert.equal(calls.filter((c) => c.who === 'gpt-rewrite').length, 0, 'no second GPT search rewrite when the anchor already rejects the premise');
  assert.equal(await finalText(raw), REACT_RIGHT);
  const v = await verdictOf(raw);
  assert.equal(Boolean(v.premiseCorrected), false);
});

test('EVES_NO_EARLY_CUT: raises the GPT anchor web-search cap from 2 to 4 on premise turns', async () => {
  const session = await signedIn();
  env.EVES_STRONG = 'on';
  env.EVES_ANCHOR = 'gpt';
  env.EVES_NO_EARLY_CUT = 'on';
  await turn(session, { messages: [{ role: 'user', content: REACT_Q }] });
  const g = calls.filter((c) => c.who === 'gpt-search');
  assert.equal(g.length, 1);
  assert.equal(g[0].maxToolCalls, 4);
});

test('EVES_HEDGE_UNRESOLVED: when the second searched answer wins a web-checked dispute against a multi-sentence anchor answer, keeps the second searched answer whole', async () => {
  const session = await signedIn();
  env.EVES_STRONG = 'on';
  env.EVES_HEDGE_UNRESOLVED = 'on';
  fx.anchor = 'The colony was Natal, in present-day South Africa. Derrick Henry has 12,345 career rushing yards.';
  fx.lanes = RIGHT;
  fx.second = RIGHT;
  const raw = await turn(session);
  const txt = await finalText(raw);
  assert.doesNotMatch(txt, /Natal/, 'does not leave the anchor’s wrong first sentence intact');
  assert.equal(txt, RIGHT);
  const v = await verdictOf(raw);
  assert.equal(v.winner, v.second.lane);
});

test('EVES_EVIDENCE_SEARCH=perplexity: runs web evidence checks on Perplexity with 0 Gemini evidence calls', async () => {
  const session = await signedIn();
  env.EVES_STRONG = 'on';
  env.EVES_EVIDENCE_SEARCH = 'perplexity';
  env.PERPLEXITY_API_KEY = 'pplx-test';
  fx.anchor = WRONG;
  fx.lanes = RIGHT;
  fx.second = RIGHT;
  fx.evidence = 'contradicted';
  const raw = await turn(session);
  assert.equal(calls.filter((c) => c.who === 'pplx-evidence').length, 1, 'evidence check ran on Perplexity');
  assert.equal(calls.filter((c) => c.who === 'gemini' && c.purpose === 'evidence').length, 0, 'zero Gemini evidence calls');
  assert.equal(await finalText(raw), RIGHT);
});

test('Vertex AI Gemini grounding: routes Gemini search calls to project gen-lang-client-0068133515 and fails over to GEMINI_API_KEY on error', async () => {
  const session = await signedIn();
  env.EVES_STRONG = 'on';
  env.VERTEX_ACCESS_TOKEN = 'ya29.test-vertex-token';
  const raw = await turn(session);
  const vCalls = calls.filter((c) => c.who === 'vertex-search');
  assert.ok(vCalls.length >= 1, 'used Vertex AI endpoint');
  assert.match(vCalls[0].url, /aiplatform\.googleapis\.com\/v1beta1\/projects\/gen-lang-client-0068133515\/locations\/global\/publishers\/google\/models\/gemini-3\.8-flash:streamGenerateContent/);
  assert.equal(vCalls[0].auth, 'Bearer ya29.test-vertex-token');
  assert.deepEqual(vCalls[0].tools, [{ googleSearch: {} }]);
  assert.equal(await finalText(raw), RIGHT);

  // When Vertex returns 401, automatically fails over to GEMINI_API_KEY
  calls.length = 0;
  fx.vertexFail = true;
  const raw2 = await turn(session);
  assert.ok(calls.filter((c) => c.who === 'gemini-search').length >= 1, 'fell back to AI Studio key');
  assert.equal(await finalText(raw2), RIGHT);
});
