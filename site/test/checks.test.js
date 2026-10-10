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
  env = { OPENAI_API_KEY: 'o-test', GEMINI_API_KEY: 'g-test', TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '20' };
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
  const cfg = hostedConfig({});
  const picks = checkModels(cfg.models);
  assert.equal(picks.cheap.model.id, 'gpt-6-luna');
  assert.equal(picks.cheap.effort, 'none');
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

test('meta: the hosted server runs both checks (with Gemini to search) and never EVES', async () => {
  const session = await signedIn();
  const m = await (await hit('/api/chat/meta', { session, headers: { 'x-jarvis-chat': '1' } })).json();
  assert.equal(m.premiseCheck, true);
  assert.equal(m.answerCheck, true);
  assert.equal(m.eves, false);
  env.EDEN_GEMINI = 'off';
  const off = await (await hit('/api/chat/meta', { session, headers: { 'x-jarvis-chat': '1' } })).json();
  assert.equal(off.premiseCheck, false, 'no Gemini: nothing searches, so no switch');
  assert.equal(off.answerCheck, false);
  assert.equal(off.eves, false);
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
