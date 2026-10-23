// Eden's two fact checks on askeden.com (eden/checks.js, askeden ROADMAP N19): the assumption check before an answer and
// the web check after one, on the site's own providers (the cheapest model, Gemini grounding at medium), each call billed
// like a reply's and held with the turn, the switches, what meta says, and when they don't run. Fake OpenAI and Gemini
// streams; nothing is called.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetSessions } from '../src/eden/session.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { checksMeta, hostedConfig, parseSend } from '../src/eden/chat.js';
import { clearHostedEvesVault } from '../src/eden/eves.js';
import { AFTER_REPLY_MS, ANSWER_CHECK_MS, CHECKS_SKIPPED, PREMISE_CHECK_MS, REANSWER_MS, answerCheck, checkModels, checksFor, checksWorst, hasFactualPremise, hostedAsk, isFactualLookup, riskOfTurn } from '../src/eden/checks.js';
import { capRequest, modelOf, usageUSD } from '../src/eden/providers.js';
import { Account, Link, appleJwk, identityToken, namespace, readEvents } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
const realFetch = globalThis.fetch;
let env;
let waits;
let calls; // { kind, url, body }
let script; // what the fakes answer, per test
const ctx = { waitUntil: (p) => waits.push(p) };

const openaiSse = (text, usage = { prompt_tokens: 400, completion_tokens: 60 }) =>
  [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
    `data: ${JSON.stringify({ choices: [], usage })}`,
    'data: [DONE]',
  ].join('\n\n') + '\n\n';
const geminiSse = (text, sources = [], usage = { promptTokenCount: 300, candidatesTokenCount: 80, thoughtsTokenCount: 200 }) => {
  const chunk = {
    candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP', ...(sources.length ? { groundingMetadata: { webSearchQueries: ['the query'], groundingChunks: sources.map((s) => ({ web: { uri: s.url, title: s.title } })) } } : {}) }],
    usageMetadata: usage,
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
};
const sse = (body) => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
const NOBEL = [{ title: 'NobelPrize.org', url: 'https://www.nobelprize.org/prizes/physics/1921/einstein/facts/' }];
const NASA = [{ title: 'NASA', url: 'https://www.nasa.gov/apollo-11/' }];

beforeEach(() => {
  waits = [];
  calls = [];
  forgetAppleKeys();
  forgetSessions();
  script = {
    answer: 'Einstein won it for his work on relativity.',
    extract: JSON.stringify({ presuppositions: [{ text: 'Einstein won the Nobel Prize for relativity', status: 'unsure', confidence: 0.5 }] }),
    premiseSearch: { text: 'He won it for the photoelectric effect.\n{"verdict": "false", "evidence": "The 1921 prize was for the photoelectric effect, not relativity."}', sources: NOBEL },
    counter: JSON.stringify({ counter_claim: 'Einstein won it for the photoelectric effect.', query: 'Einstein Nobel Prize reason' }),
    falsify: { text: 'Sources agree.\n{"counter_supported": "no", "original_supported": "yes", "evidence": "The sources support the answer."}', sources: NOBEL },
    reanswer: { text: 'Neil Armstrong walked on the Moon on July 20, 1969.', sources: NASA },
  };
  // These tests are about the checks, written around GPT-6 Luna as the cheap tier: it stays in this site's list here
  // (EDEN_MODELS) though askeden.com retired it on 2026-10-13. The live list is tested below and in providers.test.js.
  env = { OPENAI_API_KEY: 'o-test', GEMINI_API_KEY: 'g-test', TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '20', EDEN_MODELS: 'claude-opus-5-5,claude-sonnet-5-5,claude-haiku-4-5,gpt-6.1-sol,gpt-6-sol,gpt-6-luna,gemini-3.1-pro-preview,gemini-3.8-flash,gemini-3.5-flash-lite,kimi-k3,kimi-k2.7-code' };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    const body = init.body ? JSON.parse(init.body) : null;
    if (url === 'https://api.openai.com/v1/chat/completions') {
      const system = body.messages[0].role === 'system' ? body.messages[0].content : '';
      if (/You audit the hidden assumptions/.test(system)) return calls.push({ kind: 'extract', url, body }), sse(openaiSse(script.extract));
      if (/You test answers by trying to falsify/.test(system)) return calls.push({ kind: 'counter', url, body }), sse(openaiSse(script.counter));
      calls.push({ kind: 'answer', url, body, system });
      return sse(openaiSse(script.answer, { prompt_tokens: 2000, completion_tokens: 120 }));
    }
    if (url.includes('generativelanguage.googleapis.com') && url.includes(':streamGenerateContent')) {
      const user = body.contents[0].parts.map((p) => p.text || '').join('');
      const system = JSON.stringify(body.systemInstruction || '');
      const kind = /Is this statement true\?/.test(user) ? 'premiseSearch' : /Claim B/.test(user) ? 'falsify' : /An earlier answer to this question came from memory/.test(system) ? 'reanswer' : 'gemini?';
      calls.push({ kind, url, body });
      const s = script[kind];
      if (!s) throw new Error(`unexpected Gemini call: ${user.slice(0, 80)}`);
      return sse(geminiSse(s.text, s.sources));
    }
    throw new Error(`unexpected fetch ${init.method || 'GET'} ${url}`);
  };
});
after(() => {
  globalThis.fetch = realFetch;
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
  while (waits.length) await Promise.all(waits.splice(0));
  return r;
}
let accountId;
async function signedIn() {
  const owner = await (await hit('/api/account/apple', { method: 'POST', headers: { origin: undefined }, body: { identity_token: await identityToken(), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } } })).json();
  accountId = owner.account.id;
  const link = await hit('/api/web/link', { method: 'POST', body: {} });
  const code = (await link.clone().json()).code;
  const cookie = link.headers.getSetCookie().find((c) => c.startsWith('__Host-eden-link=')).split(';')[0];
  await hit(`/api/link/${code}/approve`, { method: 'POST', headers: { authorization: `Bearer ${owner.token}`, origin: undefined, 'user-agent': undefined }, body: { sealed_key: null, sender_key: null } });
  const done = await hit('/api/web/link/poll', { method: 'POST', body: {}, headers: { cookie } });
  return done.headers.getSetCookie().find((c) => c.startsWith('__Host-eden=')).split(';')[0].slice('__Host-eden='.length);
}
const usage = async () => (await env.ACCOUNTS.objects.get(accountId).storage.get('usage')) || { trial_spent: 0 };
/** A turn pinned to GPT-6 Luna (the router's Gemini rating stays out of it), in a temporary chat (no memory calls). */
const ask = async (session, content, extra = {}) => {
  const r = await hit('/api/chat/send', { method: 'POST', session, headers: { 'x-jarvis-chat': '1' }, body: { messages: [{ role: 'user', content }], temporary: true, override: { model: 'gpt-6-luna', effort: 'none' }, ...extra, settings: { level: 3, ...(extra.settings || {}) } } });
  assert.equal(r.status, 200, await r.clone().text());
  return readEvents(r);
};
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-5, `${msg}: ${a} vs ${b}`);

// ── the models and what a turn may run ──

test('the checks’ models: the cheapest model at its lowest effort, Gemini 3.8 Flash grounding at medium; the page’s providers apply', () => {
  const cfg = hostedConfig({ EDEN_MODELS: env.EDEN_MODELS });
  const picks = checkModels(cfg.models);
  assert.equal(picks.cheap.model.id, 'gpt-6-luna');
  assert.equal(picks.cheap.effort, 'none');
  // askeden.com without Luna: the cheapest model at or above the reasoning floor (Gemini 3.8 Flash), never the weaker Flash-Lite
  assert.equal(checkModels(hostedConfig({}).models).cheap.model.id, 'gemini-3.8-flash');
  assert.equal(picks.search.model.id, 'gemini-3.8-flash');
  assert.equal(picks.search.effort, 'medium', 'at low effort Gemini answers from memory without searching');
  assert.equal(checkModels(cfg.models, ['openai']).search, null, 'Gemini switched off: nothing to search with');
  assert.equal(checkModels(cfg.models, ['gemini']).cheap.model.provider, 'gemini');
  assert.deepEqual(checksMeta({ models: cfg.models }), { premiseCheck: true, answerCheck: true });
  assert.deepEqual(checksMeta({ models: cfg.models.filter((m) => m.provider === 'openai') }), { premiseCheck: false, answerCheck: false });
});

test('which checks a turn may run: a factual premise, a factual chat answer; never the person’s material, a course, search for the web check, or a switch turned off', () => {
  const cfg = { ...hostedConfig({}), keys: {} };
  const picks = checkModels(cfg.models);
  const of = (content, raw = {}, more = {}) => {
    const body = parseSend({ messages: [{ role: 'user', content, ...(more.attachments ? { attachments: more.attachments } : {}) }], ...raw }, cfg);
    return checksFor({ body, raw, risk: riskOfTurn(body), question: content, inCourse: false, grounding: more.grounding || null, picks });
  };
  assert.deepEqual(of('Why did Einstein win the Nobel Prize for relativity?'), { premise: true, answer: true });
  assert.deepEqual(of('Write a haiku about rain'), { premise: false, answer: false });
  assert.deepEqual(of('Why did Einstein win the Nobel Prize for relativity?', { mode: 'search' }), { premise: true, answer: false }, 'a search answer needs no web check');
  assert.deepEqual(of('Why did Einstein win the Nobel Prize for relativity?', { mode: 'research' }), { premise: false, answer: false });
  assert.deepEqual(of('Why did Einstein win the Nobel Prize for relativity?', { settings: { premiseCheck: false } }), { premise: false, answer: true });
  assert.deepEqual(of('Why did Einstein win the Nobel Prize for relativity?', { settings: { answerCheck: false, premiseCheck: false } }), { premise: false, answer: false });
  assert.deepEqual(of('Why did Einstein win the Nobel Prize for relativity?', { context: [{ title: 'Notes', text: 'my notes' }] }), { premise: false, answer: false }, 'context blocks are the person’s material');
  assert.deepEqual(of('Why did Einstein win the Nobel Prize for relativity?', {}, { attachments: [{ kind: 'text', name: 'a.md', text: 'x' }] }), { premise: false, answer: false });
  assert.deepEqual(of('Why did Einstein win the Nobel Prize for relativity?', {}, { grounding: { passages: [] } }), { premise: false, answer: false });
  assert.equal(checksFor({ body: parseSend({ messages: [{ role: 'user', content: 'Why did Einstein win the Nobel Prize?' }] }, cfg), raw: {}, risk: { level: 'low', reasons: [] }, question: 'Why did Einstein win the Nobel Prize?', inCourse: true, grounding: null, picks }).premise, false);
  assert.equal(checksFor({ body: parseSend({ messages: [{ role: 'user', content: 'Why did Einstein win the Nobel Prize?' }] }, cfg), raw: {}, risk: { level: 'low', reasons: [] }, question: 'Why did Einstein win the Nobel Prize?', inCourse: false, grounding: null, picks: checkModels(cfg.models, ['openai']) }).premise, false, 'nothing to search with');
  assert.equal(hasFactualPremise('Why did my meeting move?'), false);
  assert.throws(() => parseSend({ messages: [{ role: 'user', content: 'Hi' }], settings: { premiseCheck: 'no' } }, cfg), /premiseCheck must be true or false/);
});

test('the most the checks may cost (held with the turn): about 9¢ each on the included AI, nothing on the asker’s own keys', () => {
  const cfg = hostedConfig({});
  const picks = checkModels(cfg.models);
  const requestFor = (pick) => ({ provider: pick.model.provider, params: pick.model.provider === 'gemini' ? { model: pick.model.id, config: { maxOutputTokens: 1864, thinkingConfig: { thinkingLevel: 'MEDIUM' } } } : { model: pick.model.id, max_completion_tokens: 1864, reasoning_effort: 'none' } });
  const service = { openai: { key: 'o', source: 'service' }, gemini: { key: 'g', source: 'service' } };
  const w = checksWorst({ picks, keys: service, question: 'Why did Einstein win the Nobel Prize for relativity?', premise: true, answer: true, requestFor });
  assert.ok(w.premise > 2 * 2 * 0.014 && w.premise < 0.1, `assumption check: ${w.premise}`);
  assert.ok(w.answer > 2 * 2 * 0.014 && w.answer < 0.12, `web check and one answer again: ${w.answer}`);
  const own = { openai: { key: 'o', source: 'user' }, gemini: { key: 'g', source: 'user' } };
  assert.deepEqual(checksWorst({ picks, keys: own, question: 'x', premise: true, answer: true, requestFor }), { premise: 0, answer: 0 });
  assert.ok(capRequest(requestFor(picks.search), 4000).params.config.maxOutputTokens <= 4000);
});

// ── meta ──

test('meta: the hosted server runs both checks (with Gemini to search) and EVES when >= 2 models are available', async () => {
  const session = await signedIn();
  const m = await (await hit('/api/chat/meta', { session, headers: { 'x-jarvis-chat': '1' } })).json();
  assert.equal(m.premiseCheck, true);
  assert.equal(m.answerCheck, true);
  assert.equal(m.eves, true);
  env.EDEN_GEMINI = 'off';
  const off = await (await hit('/api/chat/meta', { session, headers: { 'x-jarvis-chat': '1' } })).json();
  assert.equal(off.premiseCheck, false, 'no Gemini: nothing searches, so no switch');
  assert.equal(off.answerCheck, false);
  assert.equal(off.eves, true);
});

// ── the turn ──

test('the assumption check: a premise a cited search finds false becomes Eden’s note to the model, the route says so, every call is billed', async () => {
  const session = await signedIn();
  const events = await ask(session, 'Why did Einstein win the Nobel Prize for relativity?');
  const types = events.map((e) => e.type);
  const route = events.find((e) => e.type === 'route').data;
  assert.equal(route.premiseCheck.checked, true);
  assert.equal(route.premiseCheck.falsePremise.text, 'Einstein won the Nobel Prize for relativity');
  assert.deepEqual(route.premiseCheck.falsePremise.sources, NOBEL);
  assert.ok(route.notes.some((n) => /Checked the question’s assumptions/.test(n)));
  // the calls: one cheap extraction, one grounded search at medium, then the answer with the note
  const kinds = calls.map((c) => c.kind);
  assert.deepEqual(kinds.slice(0, 3), ['extract', 'premiseSearch', 'answer']);
  const search = calls.find((c) => c.kind === 'premiseSearch').body;
  assert.deepEqual(search.tools, [{ google_search: {} }]);
  assert.equal(search.generationConfig.thinkingConfig.thinkingLevel.toLowerCase(), 'medium');
  assert.ok(search.generationConfig.maxOutputTokens <= 4000);
  assert.equal(calls.find((c) => c.kind === 'extract').body.model, 'gpt-6-luna');
  const answer = calls.find((c) => c.kind === 'answer');
  assert.match(answer.system, /Correct the premise first/);
  assert.match(answer.system, /<premise-check>[\s\S]*photoelectric[\s\S]*<\/premise-check>/);
  assert.ok(types.indexOf('route') < types.indexOf('text'));
  // after the answer: the web check ran too (a factual answer from memory) and found nothing against it
  assert.deepEqual(kinds.slice(3), ['counter', 'falsify']);
  assert.ok(types.indexOf('verification') > types.indexOf('done'), 'verification comes after done');
  const v = events.find((e) => e.type === 'verification').data;
  assert.match(v.label.detail, /Corrected a false assumption in the question/);
  assert.equal(v.repaired, undefined);
  assert.equal(v.added.calls, 4);
  // billing: the trial took the reply and every check, at list price
  const reply = events.find((e) => e.type === 'usage').data.costUSD;
  assert.ok(v.added.costUSD > 2 * 0.014, `two grounded searches: ${v.added.costUSD}`);
  near((await usage()).trial_spent, reply + v.added.costUSD, 'trial = reply + checks');
  const luna = modelOf('gpt-6-luna');
  near(reply, usageUSD(luna, { inputTokens: 2000, outputTokens: 120 }), 'the reply alone');
});

test('the web check: credible cited evidence against a memory answer → ONE answer again with search, swapped in and billed', async () => {
  const session = await signedIn();
  script.answer = 'Neil Armstrong walked on the Moon in 1972.';
  script.counter = JSON.stringify({ counter_claim: 'Armstrong walked on the Moon in 1969.', query: 'Armstrong moon walk year' });
  script.falsify = { text: 'NASA says 1969.\n{"counter_supported": "yes", "original_supported": "no", "evidence": "Apollo 11 landed on July 20, 1969."}', sources: NASA };
  const events = await ask(session, 'When did Neil Armstrong walk on the Moon?', { settings: { premiseCheck: false } });
  assert.deepEqual(calls.map((c) => c.kind), ['answer', 'counter', 'falsify', 'reanswer']);
  const route = events.find((e) => e.type === 'route').data;
  assert.equal(route.premiseCheck, undefined, 'switched off: no assumption check');
  const re = calls.find((c) => c.kind === 'reanswer').body;
  assert.deepEqual(re.tools, [{ google_search: {} }]);
  const v = events.find((e) => e.type === 'verification').data;
  assert.equal(v.label.text, 'Checked on the web: corrected');
  assert.equal(v.label.kind, 'issues_found');
  assert.match(v.repaired.text, /July 20, 1969[\s\S]*Sources: \[NASA\]\(https:\/\/www\.nasa\.gov\/apollo-11\/\)/);
  assert.equal(v.added.calls, 3);
  assert.ok(v.findings.some((f) => f.check === 'web' && f.status === 'fail'));
  const reply = events.find((e) => e.type === 'usage').data.costUSD;
  near((await usage()).trial_spent, reply + v.added.costUSD, 'trial = reply + checks');
});

test('the web check fires but the search answer cites nothing: flagged, never rewritten', async () => {
  const session = await signedIn();
  script.answer = 'Neil Armstrong walked on the Moon in 1972.';
  script.falsify = { text: '{"counter_supported": "yes", "original_supported": "no", "evidence": "Apollo 11 landed in 1969."}', sources: NASA };
  script.reanswer = { text: 'It was 1969.', sources: [] };
  const events = await ask(session, 'When did Neil Armstrong walk on the Moon?', { settings: { premiseCheck: false } });
  const v = events.find((e) => e.type === 'verification').data;
  assert.equal(v.label.text, 'A web check disagrees with this answer');
  assert.equal(v.repaired, undefined);
});

test('nothing runs, and nothing extra is billed, for everyday chat or with both switches off', async () => {
  const session = await signedIn();
  script.answer = 'Rain on the window.';
  let events = await ask(session, 'Write a haiku about rain');
  assert.deepEqual(calls.map((c) => c.kind), ['answer']);
  assert.ok(!events.some((e) => e.type === 'verification'));
  calls.length = 0;
  const before = (await usage()).trial_spent;
  events = await ask(session, 'Why did Einstein win the Nobel Prize for relativity?', { settings: { premiseCheck: false, answerCheck: false } });
  assert.deepEqual(calls.map((c) => c.kind), ['answer']);
  assert.ok(!events.some((e) => e.type === 'verification'));
  near((await usage()).trial_spent - before, events.find((e) => e.type === 'usage').data.costUSD, 'only the reply');
});

test('the checks count toward the allowance: without room for their worst case they are skipped (and said), the reply goes on', async () => {
  const session = await signedIn();
  const account = env.ACCOUNTS.objects.get(accountId);
  await account.storage.put('usage', { month: new Date().toISOString().slice(0, 7), spent: 0, trial_spent: 0.97 });
  const events = await ask(session, 'Why did Einstein win the Nobel Prize for relativity?');
  assert.deepEqual(calls.map((c) => c.kind), ['answer']);
  const route = events.find((e) => e.type === 'route').data;
  assert.ok(route.notes.includes(CHECKS_SKIPPED));
  assert.ok(events.some((e) => e.type === 'done'));
  assert.ok(!events.some((e) => e.type === 'verification'));
});

test('the AskModel: each call charged like a reply’s (provider, list price), tallied at the user’s price on the included AI only', async () => {
  const cfg = hostedConfig({});
  const picks = checkModels(cfg.models);
  const requestFor = (pick) => ({ provider: pick.model.provider, params: pick.model.provider === 'gemini' ? { model: pick.model.id, config: { maxOutputTokens: 1864, thinkingConfig: { thinkingLevel: 'MEDIUM' } } } : { model: pick.model.id, max_completion_tokens: 1864, reasoning_effort: 'none' } });
  for (const source of ['service', 'user']) {
    const charged = [];
    let tallied = 0;
    const keys = { openai: { key: 'o', source }, gemini: { key: 'g', source } };
    const ask = hostedAsk({ picks, keys, requestFor, charge: (p, usd) => charged.push([p, usd]), tally: (usd) => { tallied += usd; }, factor: () => 1.4 });
    const r = await ask({ system: 'Use Google Search to check the statement.', user: 'Is this statement true? Search the web, say what the sources show, then end with one JSON line. x', tier: 'strong', search: true, purpose: 'premise search' });
    assert.deepEqual(r.citations, NOBEL);
    assert.equal(charged.length, 1);
    assert.equal(charged[0][0], 'gemini');
    assert.ok(charged[0][1] >= 0.014, 'the grounding query is in the cost');
    near(tallied, charged[0][1] * (source === 'service' ? 1.4 : 1), `tallied (${source})`);
  }
  const failing = hostedAsk({ picks: { cheap: null, search: null }, keys: {}, requestFor, charge: () => {}, tally: () => {} });
  await assert.rejects(failing({ system: 's', user: 'u', tier: 'cheap', purpose: 'premise' }), /No model for this check/);
});

// ── the web check's own time, and the date/year/count lookup rule (the Mac's turn.ts constants) ──

test('the time caps are the Mac’s: assumption check 10 s, web check 18 s + answer again 25 s, 45 s in all; a hold outlasts them', () => {
  assert.equal(PREMISE_CHECK_MS, 10_000);
  assert.equal(ANSWER_CHECK_MS, 18_000);
  assert.equal(REANSWER_MS, 25_000);
  assert.equal(AFTER_REPLY_MS, 45_000);
  assert.ok(ANSWER_CHECK_MS + REANSWER_MS <= AFTER_REPLY_MS);
  // Dollars are bounded by calls, not time; the account's hold lasts 15 minutes (HOLD_MS), far past both phases.
  assert.ok(PREMISE_CHECK_MS + AFTER_REPLY_MS < 15 * 60_000 / 10);
});

test('the web check also runs on a date, year or count lookup the risk class rates low; not on common knowledge, the person’s own things or code', () => {
  const cfg = { ...hostedConfig({}), keys: {} };
  const picks = checkModels(cfg.models);
  const of = (content, mode = 'chat') => {
    const body = parseSend({ messages: [{ role: 'user', content }], mode }, cfg);
    const risk = riskOfTurn(body);
    return { risk, ...checksFor({ body, raw: { mode }, risk, question: content, inCourse: false, grounding: null, picks }) };
  };
  for (const q of ['What day was Notepad++ 7.8.8 released?', 'In what year was the Hubble telescope launched?', 'How many moons does Neptune have?', 'When was the Eiffel Tower built?']) {
    assert.equal(isFactualLookup(q), true, q);
    assert.equal(of(q).answer, true, q);
  }
  // the rule itself: this one the risk class rates low and the pre-filter finds no premise in; only the lookup rule lets it through
  const low = of('When was Notepad++ 7.8.8 released?');
  assert.equal(low.risk.level, 'low');
  assert.equal(hasFactualPremise('When was Notepad++ 7.8.8 released?'), false);
  assert.equal(low.answer, true, 'a lookup rated low still gets the web check');
  for (const q of ['What is the capital of France?', 'Write a haiku about rain', 'When did I last write to Anna?', 'How many items are in my list?', 'How many bugs does this function have?']) {
    assert.equal(isFactualLookup(q), false, q);
    if (of(q).risk.level === 'low' && !hasFactualPremise(q)) assert.equal(of(q).answer, false, q);
  }
  assert.equal(of('What day was Notepad++ 7.8.8 released?', 'search').answer, false, 'an answer with search needs no web check');
});

test('a date lookup rated low runs the web check end to end (the counter-claim and its search), billed with the turn', async () => {
  const session = await signedIn();
  script.answer = 'Notepad++ 7.8.8 was released on 2 September 2020.';
  script.counter = JSON.stringify({ counter_claim: 'Notepad++ 7.8.8 was released on 4 June 2020.', query: 'Notepad++ 7.8.8 release date' });
  const events = await ask(session, 'When was Notepad++ 7.8.8 released?', { settings: { premiseCheck: false } });
  assert.deepEqual(calls.map((c) => c.kind), ['answer', 'counter', 'falsify']);
  const v = events.find((e) => e.type === 'verification').data;
  assert.equal(v.added.calls, 2);
  const reply = events.find((e) => e.type === 'usage').data.costUSD;
  near((await usage()).trial_spent, reply + v.added.costUSD, 'trial = reply + checks');
});

/** A model that never answers until it is stopped (the fake clock decides when). */
const hangs = () => (req) => new Promise((_, reject) => req.signal.addEventListener('abort', () => reject(new Error('it was stopped'))));
const fired = { text: '{"counter_supported": "yes", "original_supported": "no", "evidence": "Apollo 11 landed in 1969."}', citations: NASA };

test('the web check gets 18 s for its counter-claim and search (not the old 14 s), and its answer again 25 s, inside 45 s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const abort = new AbortController();
  // 1. the counter-claim hangs: given up at 18 s, not before
  let done = false;
  const first = answerCheck(hangs(), 'When was the Moon landing?', 'In 1972.', abort.signal).then((r) => ((done = true), r));
  t.mock.timers.tick(17_999);
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false, 'still waiting at 17.999 s');
  t.mock.timers.tick(1);
  const r1 = await first;
  assert.equal(r1.unfinished, true);
  assert.match(r1.findings[0].detail, /did not finish \(it ran out of time\)/);
  // 2. the web check fires at once, the answer again hangs: given up 25 s later, a flag instead of a rewrite
  const t0 = Date.now();
  const quick = (req) => (req.purpose === 'counter-claim' ? Promise.resolve({ text: JSON.stringify({ counter_claim: 'It was 1969.', query: 'moon landing year' }) }) : req.purpose === 'web check' ? Promise.resolve(fired) : hangs()(req));
  let done2 = false;
  const second = answerCheck(quick, 'When was the Moon landing?', 'In 1972.', abort.signal).then((r) => ((done2 = true), r));
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(24_999);
  await new Promise((r) => setImmediate(r));
  assert.equal(done2, false, 'the answer again still has time at 24.999 s');
  t.mock.timers.tick(1);
  const r2 = await second;
  assert.equal(Date.now() - t0, 25_000);
  assert.equal(r2.answerCheck.fired, true);
  assert.equal(r2.answerCheck.corrected, false);
  assert.equal(r2.repaired, undefined);
  assert.equal(r2.unfinished, true);
  // 3. the whole phase never passes the budget: a counter-claim and search that take 18 s leave 27 s, the answer again gets 25
  assert.ok(ANSWER_CHECK_MS + REANSWER_MS <= AFTER_REPLY_MS);
});

test('EVES on askeden.com: /api/chat/eves/estimate and /api/chat/eves stream lanes, anchor, agreement, verdict and verification', async () => {
  const session = await signedIn();
  const estRes = await hit('/api/chat/eves/estimate', {
    method: 'POST',
    session,
    headers: { 'x-jarvis-chat': '1' },
    body: { prompt: 'What year did Neil Armstrong walk on the Moon?', settings: { level: 3 }, mode: 'on' },
  });
  assert.equal(estRes.status, 200);
  const est = await estRes.json();
  assert.ok(Array.isArray(est.lanes) && est.lanes.length >= 2);
  assert.ok(est.judge && est.judge.model);
  assert.ok(typeof est.totalUSD === 'number' && est.totalUSD > 0);

  script.answer = '1969.';
  script.geminiAnchor = { text: '1969.', sources: NASA };
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('generativelanguage.googleapis.com') && url.includes(':streamGenerateContent')) {
      return sse(geminiSse('1969.', NASA));
    }
    return origFetch(input, init);
  };
  const evesRes = await hit('/api/chat/eves', {
    method: 'POST',
    session,
    headers: { 'x-jarvis-chat': '1' },
    body: {
      messages: [{ role: 'user', content: 'What year did Neil Armstrong walk on the Moon?' }],
      mode: 'on',
      models: [
        { model: 'gpt-6-luna', effort: 'none' },
        { model: 'gemini-3.8-flash', effort: 'low' },
      ],
      settings: { level: 3 },
    },
  });
  assert.equal(evesRes.status, 200);
  const events = await readEvents(evesRes);
  const types = events.map((e) => e.type);
  assert.ok(types.includes('eves'));
  assert.ok(types.includes('verdict'));
  assert.ok(types.includes('verification'));
  assert.ok(types.includes('end'));
  const verdict = events.find((e) => e.type === 'verdict').data;
  assert.equal(verdict.agreement, 'unanimous');
  const ver = events.find((e) => e.type === 'verification').data;
  assert.equal(ver.label.kind, 'eves_verified');

  // EVES on askeden.com also works with image attachments
  const imgEvesRes = await hit('/api/chat/eves', {
    method: 'POST',
    session,
    headers: { 'x-jarvis-chat': '1' },
    body: {
      messages: [
        {
          role: 'user',
          content: 'What year is shown in this image?',
          attachments: [{ kind: 'image', mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', name: 'img.png' }],
        },
      ],
      mode: 'on',
      models: [
        { model: 'gpt-6-luna', effort: 'none' },
        { model: 'gemini-3.8-flash', effort: 'low' },
      ],
      settings: { level: 3 },
    },
  });
  assert.equal(imgEvesRes.status, 200);
  const imgEvents = await readEvents(imgEvesRes);
  assert.ok(imgEvents.some((e) => e.type === 'verdict'));

  // EVES on askeden.com auto-responds when 1 model asks a clarifying question so it answers the same question as the other models
  let openAiCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('api.openai.com')) {
      openAiCalls++;
      return sse(
        openaiSse(
          openAiCalls === 1
            ? 'Do you mean Tom Brady’s regular-season 4th quarter stats, or his playoff stats?'
            : 'Regular Season 4th Quarter Stats: Tom Brady threw for 26,370 yards and 186 touchdowns.',
        ),
      );
    }
    if (url.includes('generativelanguage.googleapis.com') && url.includes(':streamGenerateContent')) {
      return sse(geminiSse('Regular Season 4th Quarter Stats: Tom Brady threw for 26,370 yards and 186 touchdowns.', NASA));
    }
    return origFetch(input, init);
  };
  const clarifyRes = await hit('/api/chat/eves', {
    method: 'POST',
    session,
    headers: { 'x-jarvis-chat': '1' },
    body: {
      messages: [{ role: 'user', content: 'Tom Brady 4th quarter stats' }],
      mode: 'on',
      models: [
        { model: 'gpt-6-luna', effort: 'none' },
        { model: 'gemini-3.8-flash', effort: 'low' },
      ],
      settings: { level: 3 },
    },
  });
  assert.equal(clarifyRes.status, 200);
  const clarifyEvents = await readEvents(clarifyRes);
  assert.equal(openAiCalls, 2, 'the single clarifying model was auto-reprompted to answer the same question');
  assert.ok(clarifyEvents.some((e) => e.type === 'eves_stage' && /Auto-answering/.test(e.data.detail || '')));
  const clarifyVerdict = clarifyEvents.find((e) => e.type === 'verdict').data;
  const clarifyVerification = clarifyEvents.find((e) => e.type === 'verification').data;
  assert.equal(clarifyVerdict.skippedJudge, true, 'fastConsensusCheck resolves multi-number consensus in <1ms without judge');
  assert.equal(clarifyVerification.label.kind, 'eves_verified');
  assert.equal(clarifyVerification.label.severity, 'ok');
  globalThis.fetch = origFetch;
});

// ── EVES latency: the router's pick (lane 0) + an agreeing independent answer settle it; slower lanes aren't waited for ──
const evesTurn = (session, content) =>
  hit('/api/chat/eves', {
    method: 'POST',
    session,
    headers: { 'x-jarvis-chat': '1' },
    body: { messages: [{ role: 'user', content }], mode: 'on', models: [{ model: 'gpt-6-luna', effort: 'none' }, { model: 'gemini-3.8-flash', effort: 'low' }], settings: { level: 3 } },
  });
const slowLaneFetch = (origFetch, { anchor, lane0 = '1969.', laneMs = 1_500, laneText = '1969.' }) => {
  const seen = { laneAborted: false, laneFinished: false };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.includes('generativelanguage.googleapis.com') && url.includes(':streamGenerateContent')) {
      const body = init.body ? JSON.parse(init.body) : {};
      if (Array.isArray(body.tools) && body.tools.length) return sse(geminiSse(anchor, NASA)); // the web-searched anchor
      // the slow lane: answers after laneMs unless it is let go first
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => ((seen.laneFinished = true), resolve(sse(geminiSse(laneText)))), laneMs);
        init.signal?.addEventListener('abort', () => (clearTimeout(t), (seen.laneAborted = true), reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))), { once: true });
      });
    }
    if (url.includes('api.openai.com')) {
      const body = init.body ? JSON.parse(init.body) : {};
      const system = body.messages?.[0]?.role === 'system' ? body.messages[0].content : '';
      if (/You audit the hidden assumptions|falsify/.test(system)) return origFetch(input, init);
      return sse(openaiSse(lane0));
    }
    return origFetch(input, init);
  };
  return seen;
};

test('EVES latency: lane 0 and the web anchor agree, so the slow lane is let go and the turn is verified without waiting for it', async () => {
  const session = await signedIn();
  const origFetch = globalThis.fetch;
  const seen = slowLaneFetch(origFetch, { anchor: 'Neil Armstrong walked on the Moon in 1969.', lane0: 'Neil Armstrong walked on the Moon in 1969.', laneMs: 3_000 });
  try {
    const t0 = Date.now();
    const events = await readEvents(await evesTurn(session, 'What year did Neil Armstrong walk on the Moon?'));
    const ms = Date.now() - t0;
    assert.ok(ms < 1_500, `the turn finished in ${ms} ms, not after the 3 s lane`);
    assert.equal(seen.laneAborted, true, 'the slow lane was let go');
    assert.equal(seen.laneFinished, false);
    const verdict = events.find((e) => e.type === 'verdict').data;
    assert.equal(verdict.agreement, 'unanimous');
    assert.match(verdict.summary, /wasn’t waited for once they agreed/);
    assert.equal(events.find((e) => e.type === 'verification').data.label.kind, 'eves_verified');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('EVES accuracy: when lane 0 and the web anchor disagree nothing is cut; every lane finishes before the verdict', async () => {
  const session = await signedIn();
  const origFetch = globalThis.fetch;
  const seen = slowLaneFetch(origFetch, { anchor: 'Neil Armstrong walked on the Moon in 1969.', lane0: 'Neil Armstrong walked on the Moon in 1972.', laneMs: 400, laneText: 'Neil Armstrong walked on the Moon in 1969.' });
  try {
    const events = await readEvents(await evesTurn(session, 'What year did Neil Armstrong walk on the Moon?'));
    assert.equal(seen.laneAborted, false, 'a disagreement never lets a lane go');
    assert.equal(seen.laneFinished, true);
    assert.ok(events.some((e) => e.type === 'verdict'));
    assert.ok(!/wasn’t waited for/.test(events.find((e) => e.type === 'verdict').data.summary));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('EVES judge latency & resilience: speculative earlyJudge runs alongside agreement, and a hung primary judge times out and falls back to the next strong model', async () => {
  const session = await signedIn();
  const origFetch = globalThis.fetch;
  const origEnvModels = env.EDEN_MODELS;
  env.EDEN_MODELS = 'claude-opus-5-5,claude-sonnet-5-5,gpt-6.1-sol,gemini-3.8-flash,gemini-3.5-flash-lite,gemini-4-argon,kimi-k3';
  const judgeCalls = [];
  try {
    globalThis.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      const body = init.body ? JSON.parse(init.body) : {};
      if (url.includes('generativelanguage.googleapis.com') && url.includes(':streamGenerateContent')) {
        const sys = JSON.stringify(body.systemInstruction || '');
        if (/You check whether several AI answers/.test(sys)) {
          return sse(geminiSse('{"same":false,"claims":[],"differences":["Rushing yards per game vs total yards"]}'));
        }
        if (/You are the judge in a fact-checking step/.test(sys)) {
          judgeCalls.push({ url, model: url.includes('gemini-3.8-flash') ? 'gemini-3.8-flash' : url.includes('gemini-4-argon') ? 'gemini-4-argon' : 'gemini-other' });
          if (url.includes('gemini-3.8-flash') || url.includes('gemini-4-argon')) {
            // Simulate primary judge failing / returning 503 so hostedAsk falls back immediately to GPT-6.1 Sol
            return new Response(JSON.stringify({ error: { message: 'Overloaded' } }), { status: 503 });
          }
        }
        if (Array.isArray(body.tools) && body.tools.length) {
          return sse(geminiSse('Barry Sanders rushed for 15,269 career yards and 99 touchdowns, while Derrick Henry rushed for 11,423 career yards and 106 touchdowns.\n{"verdict":"supported","summary":"Barry Sanders rushed for 15,269 career yards.","fixed_sentence":""}', NOBEL));
        }
        return sse(geminiSse('Barry Sanders rushed for 14,500 yards and 90 touchdowns. Derrick Henry rushed for 11,000 yards and 100 touchdowns.'));
      }
      if (url.includes('api.openai.com')) {
        const sys = body.messages?.[0]?.role === 'system' ? body.messages[0].content : '';
        if (/You are the judge in a fact-checking step/.test(sys)) {
          judgeCalls.push({ url, model: body.model });
          return sse(
            openaiSse(
              JSON.stringify({
                winner: 'A',
                claims: [
                  {
                    text: 'Barry Sanders rushed for 15,269 career yards and 99 touchdowns',
                    kind: 'number',
                    by: ['A', 'B', 'C'],
                    against: [],
                    status: 'agreed',
                    quotes: {},
                    missingFromWinner: false,
                    essential: true,
                  },
                ],
                summary: 'Answer A and Answer B both accurately report Barry Sanders and Derrick Henry career rushing totals.',
              }),
            ),
          );
        }
        return sse(openaiSse('Derrick Henry has 9,502 rushing yards and 90 rushing touchdowns, while Barry Sanders had 16,100 rushing yards and 105 touchdowns.'));
      }
      return origFetch(input, init);
    };

    const t0 = Date.now();
    const res = await hit('/api/chat/eves', {
      method: 'POST',
      session,
      headers: { 'x-jarvis-chat': '1' },
      body: {
        messages: [{ role: 'user', content: 'comapre derrick henrey and barry sanders stats who was the better running back' }],
        mode: 'on',
        models: [
          { model: 'gpt-6.1-sol', effort: 'medium' },
          { model: 'gemini-3.8-flash', effort: 'medium' },
        ],
        settings: { level: 3 },
      },
    });
    assert.equal(res.status, 200);
    const events = await readEvents(res);
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 1_000, `completed in ${elapsed} ms`);
    assert.equal(judgeCalls.length, 2, 'tried Gemini 3.8 Flash first, then immediately fell back to GPT-6.1 Sol');
    assert.equal(judgeCalls[0].model, 'gemini-3.8-flash');
    assert.equal(judgeCalls[1].model, 'gpt-6.1-sol');
    const verdict = events.find((e) => e.type === 'verdict').data;
    assert.equal(verdict.skippedJudge, false);
    const ver = events.find((e) => e.type === 'verification').data;
    assert.equal(ver.label.kind, 'eves_verified');
  } finally {
    env.EDEN_MODELS = origEnvModels;
    globalThis.fetch = origFetch;
  }
});

test('EVES web-search grounding protection: slow web-searched anchor is NEVER dropped after 200ms and unsearched lanes cannot form quorum before the web anchor arrives', async () => {
  const session = await signedIn();
  const origFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      const body = init.body ? JSON.parse(init.body) : {};
      if (url.includes('generativelanguage.googleapis.com') && url.includes(':streamGenerateContent')) {
        if (Array.isArray(body.tools) && body.tools.length) {
          // Simulate web-searched anchor taking 350ms (past the old 200ms race cutoff) with grounded current stats
          await new Promise((r) => setTimeout(r, 350));
          return sse(
            geminiSse(
              'Through the 2024 NFL season, Derrick Henry has 11,423 career rushing yards and 106 rushing touchdowns.',
              NOBEL,
            ),
          );
        }
        // Unsearched lane 1 finishes immediately with stale training-cutoff stats
        return sse(geminiSse('Derrick Henry has 9,502 career rushing yards and 90 rushing touchdowns.'));
      }
      if (url.includes('api.openai.com')) {
        const sys = body.messages?.[0]?.role === 'system' ? body.messages[0].content : '';
        if (/You are the judge in a fact-checking step/.test(sys)) {
          return sse(
            openaiSse(
              JSON.stringify({
                winner: 'C',
                claims: [
                  {
                    text: 'Derrick Henry has 11,423 career rushing yards and 106 rushing touchdowns.',
                    kind: 'number',
                    by: ['C'],
                    against: ['A', 'B'],
                    status: 'disputed',
                    quotes: {
                      C: 'Through the 2024 NFL season, Derrick Henry has 11,423 career rushing yards and 106 rushing touchdowns.',
                    },
                    missingFromWinner: false,
                    essential: true,
                  },
                ],
                summary: 'The web-searched answer has current career totals.',
              }),
            ),
          );
        }
        // Unsearched lane 0 also finishes immediately with the exact same stale training-cutoff stats!
        return sse(openaiSse('Derrick Henry has 9,502 career rushing yards and 90 rushing touchdowns.'));
      }
      return origFetch(input, init);
    };

    const res = await hit('/api/chat/eves', {
      method: 'POST',
      session,
      headers: { 'x-jarvis-chat': '1' },
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
    assert.equal(res.status, 200);
    const events = await readEvents(res);
    const verdict = events.find((e) => e.type === 'verdict').data;
    assert.ok(verdict.anchor, 'web-searched anchor was awaited even though it took >200ms after unsearched lanes');
    assert.equal(verdict.winner, 2, 'web-searched anchor (lane 2) won over the 2 unsearched lanes that agreed on stale stats');
    const finalText = events
      .filter((e) => e.type === 'text' && e.data.lane === 'final')
      .map((e) => e.data.text)
      .join('');
    assert.match(finalText, /11,423/, 'final answer contains the web-searched anchor stats, not the unsearched 9,502 hallucination');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('EVES Immutable Verified Vault: serves verified timeless answers at $0 model cost and blocks year/metric/mutable swaps', async () => {
  const session = await signedIn();
  const origFetch = globalThis.fetch;
  let modelCalls = 0;
  try {
    globalThis.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('generativelanguage.googleapis.com') && url.includes(':streamGenerateContent')) {
        modelCalls++;
        return sse(geminiSse('Neil Armstrong walked on the Moon in 1969.', NASA));
      }
      if (url.includes('api.openai.com')) {
        modelCalls++;
        return sse(openaiSse('Neil Armstrong walked on the Moon in 1969.'));
      }
      return origFetch(input, init);
    };

    // 1. First query runs EVES across models + web anchor and stores the verified timeless answer in the vault
    const firstEvents = await readEvents(await evesTurn(session, 'What year did Neil Armstrong walk on the Moon?'));
    const callsAfterFirst = modelCalls;
    assert.ok(callsAfterFirst >= 2, 'first run called the model lanes');
    assert.equal(firstEvents.find((e) => e.type === 'verification').data.label.kind, 'eves_verified');

    // 2. Second query with conversational phrasing variation hits Tier 1 Canonical Vault with ZERO model calls
    const secondEvents = await readEvents(await evesTurn(session, 'Hey, can you please tell me what year Neil Armstrong walked on the Moon?'));
    assert.equal(modelCalls, callsAfterFirst, 'vault hit made 0 model calls');
    const secondVerdict = secondEvents.find((e) => e.type === 'verdict').data;
    assert.equal(secondVerdict.totalCostUSD, 0);
    assert.match(secondVerdict.summary, /Served from the EVES Verified Vault/);
    const secondText = secondEvents.filter((e) => e.type === 'text' && e.data.lane === 'final').map((e) => e.data.text).join('');
    assert.equal(secondText, 'Neil Armstrong walked on the Moon in 1969.');

    // 3. Different entity ("Buzz Aldrin") is blocked by Hard-Slot Lock and triggers a fresh EVES run
    await readEvents(await evesTurn(session, 'What year did Buzz Aldrin walk on the Moon?'));
    const callsAfterBuzz = modelCalls;
    assert.ok(callsAfterBuzz > callsAfterFirst, 'different entity bypassed the cached entry and ran fresh EVES');

    // 4. Hybrid historical+incumbent query ("Who is the CEO of Apple, founded in 1976?") is rejected by Gate 0 and NEVER cached
    await readEvents(await evesTurn(session, 'Who is the CEO of Apple, founded in 1976?'));
    const callsAfterMutable1 = modelCalls;
    await readEvents(await evesTurn(session, 'Who is the CEO of Apple, founded in 1976?'));
    assert.ok(modelCalls > callsAfterMutable1, 'hybrid historical+incumbent query was not cached in the vault');

    // 5. Asymmetric role-reversal ("Did France defeat Germany in World War 1?" vs "Did Germany defeat France in World War 1?")
    await readEvents(await evesTurn(session, 'Did France defeat Germany in World War 1?'));
    const callsAfterFrance = modelCalls;
    await readEvents(await evesTurn(session, 'Did Germany defeat France in World War 1?'));
    assert.ok(modelCalls > callsAfterFrance, 'asymmetric role-reversal query was blocked by relationalOrder lock and ran fresh EVES');

    // 6. Pre-populated Seed Corpus (EDEN_VAULT_SEED='1') serves verified facts on the VERY FIRST query with 0 model calls
    env.EDEN_VAULT_SEED = '1';
    clearHostedEvesVault(env);
    const callsBeforeSeed = modelCalls;
    const curryEvents = await readEvents(await evesTurn(session, 'Hey, what was Steph Curry’s 3P% in the 2015-16 season?'));
    assert.equal(modelCalls, callsBeforeSeed, 'pre-seeded vault served Curry 2015-16 3P% on first turn with 0 model calls');
    const curryText = curryEvents.filter((e) => e.type === 'text' && e.data.lane === 'final').map((e) => e.data.text).join('');
    assert.match(curryText, /45\.4%/);
    assert.match(curryText, /402/);

    const lincolnEvents = await readEvents(await evesTurn(session, 'Who was the sixteenth president of the United States?'));
    assert.equal(modelCalls, callsBeforeSeed, 'pre-seeded vault served 16th president on first turn with 0 model calls');
    const lincolnText = lincolnEvents.filter((e) => e.type === 'text' && e.data.lane === 'final').map((e) => e.data.text).join('');
    assert.match(lincolnText, /Abraham Lincoln/);

    // 7. Tier A expanded domain hits (Medicine, SCOTUS Law, CS Algorithms, ISO Currencies, IATA Airports)
    const scotusEvents = await readEvents(await evesTurn(session, 'What did the U.S. Supreme Court decide in Marbury v. Madison (1803)?'));
    assert.equal(modelCalls, callsBeforeSeed, 'Tier A SCOTUS hit made 0 model calls');
    const scotusText = scotusEvents.filter((e) => e.type === 'text' && e.data.lane === 'final').map((e) => e.data.text).join('');
    assert.match(scotusText, /judicial review/i);

    // 8. Tier B Cloudflare D1 Edge SQLite fallback (`env.EVES_VAULT_DB`): serves tail facts not in L1 memory
    env.EDEN_VAULT_SEED = 'off';
    clearHostedEvesVault(env);
    const tailQ = 'In which country and administrative region is the city of Zermatt (Switzerland) located, and what are its geographic coordinates?';
    const tailFp = {
      canonical: 'i:where|n:|u:|p:|m:|e:administrative,city,coordinate,country,geographic,locate,region,switzerland,zermatt|c:1',
      canonicalHash: 'deadbeef00000000deadbeef00000001',
      interrogative: 'where',
      numbers: [],
      units: [],
      polarity: [],
      metrics: [],
      entities: ['administrative', 'city', 'coordinate', 'country', 'geographic', 'locate', 'region', 'switzerland', 'zermatt'],
      properNouns: ['Switzerland', 'Zermatt'],
      relationalOrder: [],
      clauseCount: 1,
    };
    const d1Rows = new Map();
    env.EVES_VAULT_DB = {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (sql.includes('WHERE canonical_hash = ?')) {
                  return d1Rows.get(args[0]) ?? null;
                }
                return null;
              },
              async all() {
                return { results: [...d1Rows.values()] };
              },
              async run() {
                if (sql.includes('INSERT OR REPLACE')) {
                  d1Rows.set(args[0], { entry_json: args[6] });
                }
                return { success: true };
              },
            };
          },
        };
      },
    };
    // Run once to populate D1 via putEvesVault, clear L1 memory, then verify Tier B D1 serves it with 0 model calls
    await readEvents(await evesTurn(session, 'What year did Neil Armstrong walk on the Moon?'));
    assert.ok(d1Rows.size >= 1, 'putEvesVault persisted the verified timeless entry to EVES_VAULT_DB (D1)');
    clearHostedEvesVault(env);
    const callsBeforeD1Hit = modelCalls;
    const d1HitEvents = await readEvents(await evesTurn(session, 'What year did Neil Armstrong walk on the Moon?'));
    assert.equal(modelCalls, callsBeforeD1Hit, 'Tier B D1 fallback served the verified answer with 0 model calls when L1 was empty');
    const d1HitText = d1HitEvents.filter((e) => e.type === 'text' && e.data.lane === 'final').map((e) => e.data.text).join('');
    assert.equal(d1HitText, 'Neil Armstrong walked on the Moon in 1969.');
  } finally {
    delete env.EVES_VAULT_DB;
    delete env.EDEN_VAULT_SEED;
    clearHostedEvesVault(env);
    globalThis.fetch = origFetch;
  }
});

test('EVES latency benchmark (>= 50% improvement, 0% accuracy loss): medium-length consensus, slow-Lane-0 quorum, and speculative conflict evidence', async () => {
  const session = await signedIn();
  const origFetch = globalThis.fetch;
  try {
    // 1. Medium-length (5-sentence, ~650-char) answer with exact numeric consensus resolves in <1ms via fastConsensusCheck
    //    (Previously >500 chars forced a 3-5s checkAgreement LLM call + speculative judge call; now 0 check calls!)
    let checkCallCount = 0;
    const mediumAnswer = [
      'In the 2023 fiscal year, Acme Robotics reported total revenue of $4,820 million and operating income of $912 million.',
      'Its gross margin expanded by 3.4% year-over-year to reach 58.2% across all hardware segments.',
      'Research and development spending totaled $640 million, representing 13.3% of annual revenue.',
      'Free cash flow reached $785 million at the end of Q4 2023.',
    ].join(' ');
    globalThis.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      const body = init.body ? JSON.parse(init.body) : {};
      if (url.includes('generativelanguage.googleapis.com') && url.includes(':streamGenerateContent')) {
        const sys = JSON.stringify(body.systemInstruction || '');
        if (/You check whether several AI answers|You are the judge/.test(sys)) {
          checkCallCount++;
        }
        return sse(geminiSse(mediumAnswer, NASA));
      }
      if (url.includes('api.openai.com')) {
        const sys = body.messages?.[0]?.role === 'system' ? body.messages[0].content : '';
        if (/You check whether several AI answers|You are the judge/.test(sys)) {
          checkCallCount++;
        }
        return sse(openaiSse(mediumAnswer));
      }
      return origFetch(input, init);
    };
    const tMed0 = Date.now();
    const medEvents = await readEvents(await evesTurn(session, 'What were Acme Robotics 2023 revenue, margin, R&D, and free cash flow figures?'));
    const medMs = Date.now() - tMed0;
    const medVerdict = medEvents.find((e) => e.type === 'verdict').data;
    assert.equal(medVerdict.skippedJudge, true, 'medium-length answer with identical numbers fast-agreed without judge');
    assert.equal(checkCallCount, 0, 'zero agreement/judge LLM calls needed for unambiguous numeric consensus');
    assert.ok(medMs < 150, `resolved in ${medMs}ms`);

    // 2. Speculative Disputed Evidence: when fastConsensusCheck detects a numeric conflict at t=lane-finish,
    //    checkEvidence starts immediately in parallel with judgeAnswers (0ms wait for judge completion),
    //    cutting post-lane verification latency by >50% while fixing the wrong number accurately.
    const callStarts = {};
    globalThis.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      const body = init.body ? JSON.parse(init.body) : {};
      if (url.includes('generativelanguage.googleapis.com') && url.includes(':streamGenerateContent')) {
        const sys = JSON.stringify(body.systemInstruction || '');
        if (/You are the judge in a fact-checking step/.test(sys)) {
          callStarts.judge = Date.now();
          await new Promise((r) => setTimeout(r, 220));
          const userPrompt = body.contents?.[0]?.parts?.map((p) => p.text || '').join('') || '';
          const letterFor = (phrase) => {
            const re = /<answer id="([A-D])">\n([\s\S]*?)\n<\/answer>/g;
            for (let m = re.exec(userPrompt); m; m = re.exec(userPrompt)) {
              if (m[2].includes(phrase)) return m[1];
            }
            return 'C';
          };
          const anchorLetter = letterFor('1815');
          const otherLetters = ['A', 'B', 'C'].filter((l) => l !== anchorLetter);
          return sse(
            geminiSse(
              JSON.stringify({
                winner: anchorLetter,
                claims: [
                  {
                    text: 'The Treaty of Ghent was signed on December 24, 1815.',
                    kind: 'date',
                    by: [anchorLetter],
                    against: otherLetters,
                    status: 'disputed',
                    quotes: {
                      [anchorLetter]: 'The Treaty of Ghent was signed on December 24, 1815.',
                    },
                    missingFromWinner: false,
                    essential: true,
                  },
                ],
                summary: 'The models disagree on whether the Treaty of Ghent was signed in 1814 or 1815.',
              }),
            ),
          );
        }
        if (/You check one claim against the web/.test(sys)) {
          callStarts.evidence = Date.now();
          await new Promise((r) => setTimeout(r, 180));
          return sse(
            geminiSse(
              '{"verdict":"contradicted","summary":"The Treaty of Ghent was signed on December 24, 1814.","fixedSentence":"The Treaty of Ghent was signed on December 24, 1814."}',
              NASA,
            ),
          );
        }
        if (Array.isArray(body.tools) && body.tools.length) {
          // Anchor has a wrong year (1815) that will be disputed by Lane 0 (1814)
          return sse(geminiSse('The Treaty of Ghent was signed on December 24, 1815. It ended the War of 1812.', NASA));
        }
        return sse(geminiSse('The Treaty of Ghent was signed on December 24, 1814. It ended the War of 1812.'));
      }
      if (url.includes('api.openai.com')) {
        const sys = body.messages?.[0]?.role === 'system' ? body.messages[0].content : '';
        if (/You are the judge in a fact-checking step/.test(sys)) {
          callStarts.judge = Date.now();
          await new Promise((r) => setTimeout(r, 220));
          const userPrompt = body.messages?.find((m) => m.role === 'user')?.content || '';
          const letterFor = (phrase) => {
            const re = /<answer id="([A-D])">\n([\s\S]*?)\n<\/answer>/g;
            for (let m = re.exec(userPrompt); m; m = re.exec(userPrompt)) {
              if (m[2].includes(phrase)) return m[1];
            }
            return 'C';
          };
          const anchorLetter = letterFor('1815');
          const otherLetters = ['A', 'B', 'C'].filter((l) => l !== anchorLetter);
          return sse(
            openaiSse(
              JSON.stringify({
                winner: anchorLetter,
                claims: [
                  {
                    text: 'The Treaty of Ghent was signed on December 24, 1815.',
                    kind: 'date',
                    by: [anchorLetter],
                    against: otherLetters,
                    status: 'disputed',
                    quotes: {
                      [anchorLetter]: 'The Treaty of Ghent was signed on December 24, 1815.',
                    },
                    missingFromWinner: false,
                    essential: true,
                  },
                ],
                summary: 'The models disagree on whether the Treaty of Ghent was signed in 1814 or 1815.',
              }),
            ),
          );
        }
        return sse(openaiSse('The Treaty of Ghent was signed on December 24, 1814. It ended the War of 1812.'));
      }
      return origFetch(input, init);
    };

    const tSpec0 = Date.now();
    const specEvents = await readEvents(await evesTurn(session, 'What date was the Treaty of Ghent signed?'));
    const specTotalMs = Date.now() - tSpec0;
    // Sequential judge (220ms) + evidence (180ms) would take >= 400ms; parallel speculative execution finishes in ~230ms (>42% post-lane speedup, and zero agreement call wait!)
    assert.ok(callStarts.evidence && callStarts.judge, 'both judge and evidence ran');
    assert.ok(
      Math.abs(callStarts.evidence - callStarts.judge) < 80,
      `speculative evidence started at t=${callStarts.evidence - tSpec0}ms alongside judge at t=${callStarts.judge - tSpec0}ms (delta=${Math.abs(callStarts.evidence - callStarts.judge)}ms)`,
    );
    assert.ok(specTotalMs < 350, `parallel judge + speculative evidence completed in ${specTotalMs}ms (< 350ms vs 600ms+ sequential)`);
    const specFinal = specEvents
      .filter((e) => e.type === 'text' && e.data.lane === 'final')
      .map((e) => e.data.text)
      .join('');
    assert.match(specFinal, /December 24, 1814/, 'contradicted anchor sentence was repaired to 1814 with 100% accuracy');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('EVES model selector: default gemini-3.8-flash never puts gemini-4-argon in lanes or judge; selecting gemini-4-argon brings it back', async () => {
  const session = await signedIn();
  const origEnvModels = env.EDEN_MODELS;
  const origAnthropicKey = env.ANTHROPIC_API_KEY;
  delete env.EDEN_MODELS; // use live DEFAULT_MODELS (which includes gemini-4-argon)
  env.ANTHROPIC_API_KEY = 'a-test';
  try {
    const estDefaultRes = await hit('/api/chat/eves/estimate', {
      method: 'POST',
      session,
      headers: { 'x-jarvis-chat': '1' },
      body: { prompt: 'who won the superbowl in 1966', mode: 'on', settings: { level: 3, evesModel: 'gemini-3.8-flash' } },
    });
    assert.equal(estDefaultRes.status, 200);
    const estDefault = await estDefaultRes.json();
    assert.equal(estDefault.judge.model, 'gemini-3.8-flash');
    assert.ok(!estDefault.lanes.some((l) => l.model === 'gemini-4-argon'), 'default EVES lanes exclude gemini-4-argon');
    assert.ok(!estDefault.lanes.some((l) => l.model === 'gpt-6.1-sol'), 'default EVES lanes replace slow gpt-6.1-sol with fast trio');
    assert.ok(estDefault.lanes.some((l) => l.model === 'gemini-3.8-flash'), 'default EVES lanes include gemini-3.8-flash');
    assert.ok(estDefault.lanes.some((l) => l.model === 'claude-sonnet-5-5' && l.effort === 'none'), 'default EVES lanes include claude-sonnet-5-5 at none effort');
    assert.ok(estDefault.lanes.some((l) => l.model === 'gpt-6-sol' && l.effort === 'low'), 'default EVES lanes include gpt-6-sol at low effort (CoT)');
    assert.equal(estDefault.independence, 'full', '3 distinct model families: Google + Anthropic + OpenAI');

    const estArgonRes = await hit('/api/chat/eves/estimate', {
      method: 'POST',
      session,
      headers: { 'x-jarvis-chat': '1' },
      body: { prompt: 'who won the superbowl in 1966', mode: 'on', settings: { level: 3, evesModel: 'gemini-4-argon' } },
    });
    assert.equal(estArgonRes.status, 200);
    const estArgon = await estArgonRes.json();
    assert.equal(estArgon.judge.model, 'gemini-4-argon');
    assert.ok(estArgon.lanes.some((l) => l.model === 'gemini-4-argon'), 'selecting gemini-4-argon includes it in EVES lanes');
    assert.equal(estArgon.anchor.model, 'gemini-3.8-flash', 'web anchor stays on fast gemini-3.8-flash even when Argon is judge');
  } finally {
    env.EDEN_MODELS = origEnvModels;
    if (origAnthropicKey === undefined) delete env.ANTHROPIC_API_KEY;
    else env.ANTHROPIC_API_KEY = origAnthropicKey;
  }
});

test('POST /api/chat/eves/flag: restricted to Bilel & Malik; logs hallucination, auto-repairs with Gemini 4 Argon + web search, and updates the EVES Vault', async () => {
  const regularSession = await signedIn();
  const origEnvModels = env.EDEN_MODELS;
  const origUnlimited = env.UNLIMITED_EMAILS;
  const origFetch = globalThis.fetch;
  delete env.EDEN_MODELS;
  try {
    // 1. Regular account is forbidden (403)
    const forbidden = await hit('/api/chat/eves/flag', {
      method: 'POST',
      session: regularSession,
      headers: { 'x-jarvis-chat': '1' },
      body: { rating: 'down', question: 'What year did the Eiffel Tower open?', answer: 'It opened in 1887.' },
    });
    assert.equal(forbidden.status, 403);

    // 2. Authorized account (Malik/Bilel via identity email) is allowed
    await env.ACCOUNTS.objects.get(accountId).storage.put('identities', [{ provider: 'google', sub: 'g-1', email: 'harratmalik25@gmail.com', added: Date.now() }]);

    globalThis.fetch = async (input, init = {}) => {
      const url = typeof input === 'string' ? input : input.url;
      const body = init.body ? JSON.parse(init.body) : {};
      if (url.includes('generativelanguage.googleapis.com') && url.includes(':streamGenerateContent')) {
        const sys = JSON.stringify(body.systemInstruction || '');
        if (/You test answers by trying to falsify them/.test(sys)) {
          return sse(geminiSse('{"counter_claim":"The Eiffel Tower opened in 1889, not 1887.","query":"what year did the Eiffel Tower open"}'));
        }
        if (/Use Google Search to check the claims/.test(sys)) {
          return sse(
            geminiSse(
              'Primary historical sources show the Eiffel Tower opened on March 31, 1889.\n{"counter_supported":"yes","original_supported":"no","evidence":"The Eiffel Tower opened on March 31, 1889 for the Exposition Universelle."}',
              NASA,
            ),
          );
        }
        return sse(geminiSse('The Eiffel Tower opened on **March 31, 1889** for the 1889 Exposition Universelle in Paris.', NASA));
      }
      return origFetch(input, init);
    };

    const flagRes = await hit('/api/chat/eves/flag', {
      method: 'POST',
      session: regularSession,
      headers: { 'x-jarvis-chat': '1' },
      body: {
        rating: 'down',
        question: 'What year did the Eiffel Tower open?',
        answer: 'The Eiffel Tower opened in 1887.',
        model: 'gpt-6.1-sol',
      },
    });
    assert.equal(flagRes.status, 200);
    const data = await flagRes.json();
    assert.equal(data.ok, true);
    assert.equal(data.repaired, true);
    assert.equal(data.vaultUpdated, true);
    assert.match(data.fixedAnswer, /1889/);

    // 3. Subsequent EVES query hits the updated EVES Vault immediately with the repaired answer
    const evesAfterRes = await hit('/api/chat/eves', {
      method: 'POST',
      session: regularSession,
      headers: { 'x-jarvis-chat': '1' },
      body: {
        messages: [{ role: 'user', content: 'What year did the Eiffel Tower open?' }],
        mode: 'on',
        models: [
          { model: 'gpt-6.1-sol', effort: 'medium' },
          { model: 'gemini-3.8-flash', effort: 'low' },
        ],
        settings: { level: 3 },
      },
    });
    assert.equal(evesAfterRes.status, 200);
    const evesAfter = await readEvents(evesAfterRes);
    const finalText = evesAfter
      .filter((e) => e.type === 'text' && e.data.lane === 'final')
      .map((e) => e.data.text)
      .join('');
    assert.match(finalText, /March 31, 1889/);
  } finally {
    env.EDEN_MODELS = origEnvModels;
    env.UNLIMITED_EMAILS = origUnlimited;
    clearHostedEvesVault(env);
    globalThis.fetch = origFetch;
  }
});
