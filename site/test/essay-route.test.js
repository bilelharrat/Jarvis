// Essay turns on askeden.com (askeden ROADMAP T18, src/eden/essay-route.js): the page's `essay: { kind, words }`
// routes the turn among strong writers only (no fast tier, writing ≥ 90), with task hints for the router, no Gemini
// rating, room for the reply, no fact checks, the same floor for students, and the routing preview priced the same
// way. The router bundle (vendor/model-router.js) takes the hints only after the next sync-eden: the tests that need
// them check whether the bundle does first. Fake OpenAI and Gemini; nothing is called.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetSessions } from '../src/eden/session.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { Course } from '../src/edu/course.js';
import { EDU_FREE } from '../src/edu/budget.js';
import { hostedConfig, personalRoute, routePreview } from '../src/eden/chat.js';
import { ESSAY_MIN_REPLY_TOKENS, ESSAY_NOTE, ESSAY_NO_FLOOR_NOTE, TOOL_BLOCK_TAG, essayFloor, essayHints, essayOf, essayRoom, withoutToolBlocks } from '../src/eden/essay-route.js';
import { createLocalRouter } from '../src/eden/vendor/model-router.js';
import { Account, Link, appleJwk, identityToken, namespace, readEvents } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
const FAST_OR_WEAK = ['gpt-6-luna', 'gemini-3.5-flash-lite', 'claude-haiku-4-5', 'kimi-k2.7-code'];
const FLOOR = ['claude-opus-5-5', 'claude-sonnet-5-5', 'gpt-6.1-sol', 'gpt-6-sol', 'gemini-3.1-pro-preview', 'gemini-3.8-flash', 'kimi-k3'];
const ESSAY = 'Social media has changed how teenagers live, sleep and talk to one another. '.repeat(90);
const realFetch = globalThis.fetch;
let env;
let waits;
let calls; // { kind: 'answer' | 'rating' | 'check', provider, model, maxTokens }
const ctx = { waitUntil: (p) => waits.push(p) };

/** Does this router bundle take task hints (after the sync from the Model Router's browser.ts)? */
const bundleTakesHints = (() => {
  try {
    const r = createLocalRouter({ models: ['gpt-6-luna'] }).routeSync({ prompt: 'continue', hints: { complexity: 'expert' } });
    return r.task.complexity === 'expert';
  } catch {
    return false;
  }
})();

const openaiSse = (text) =>
  [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3000, completion_tokens: 900 } })}`,
    'data: [DONE]',
  ].join('\n\n') + '\n\n';
const geminiSse = (text) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 900 } })}\n\n`;
const sse = (body) => new Response(body, { headers: { 'content-type': 'text/event-stream' } });
const REPLY = 'Here is the next paragraph.\n<eden-essay where="end">Sleep is where the harm is easiest to measure. "Phones keep me up" is what most said.</eden-essay>';

beforeEach(() => {
  waits = [];
  calls = [];
  forgetAppleKeys();
  forgetSessions();
  env = { OPENAI_API_KEY: 'o-test', GEMINI_API_KEY: 'g-test', TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '20' };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.COURSES = namespace(Course, env);
  env.ASSETS = { fetch: async () => new Response('asset') };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    const body = init.body ? JSON.parse(init.body) : null;
    if (url === 'https://api.openai.com/v1/chat/completions') {
      const system = body.messages[0].role === 'system' ? body.messages[0].content : '';
      if (/You audit the hidden assumptions|You test answers by trying to falsify/.test(system)) {
        calls.push({ kind: 'check', provider: 'openai', model: body.model });
        return sse(openaiSse('{}'));
      }
      calls.push({ kind: 'answer', provider: 'openai', model: body.model, maxTokens: body.max_completion_tokens ?? body.max_tokens });
      return sse(openaiSse(REPLY));
    }
    if (url.includes('generativelanguage.googleapis.com')) {
      const model = /models\/([^/:?]+)/.exec(url)[1];
      if (url.includes(':generateContent')) {
        calls.push({ kind: 'rating', provider: 'gemini', model });
        return new Response('{"error":{"message":"no rating in this test"}}', { status: 500 });
      }
      calls.push({ kind: /Is this statement true\?|Claim B/.test(JSON.stringify(body.contents)) ? 'check' : 'answer', provider: 'gemini', model, maxTokens: body.generationConfig && body.generationConfig.maxOutputTokens });
      return sse(geminiSse(REPLY));
    }
    throw new Error(`unexpected fetch ${init.method || 'GET'} ${url}`);
  };
});
after(() => {
  globalThis.fetch = realFetch;
});

async function hit(p, { method = 'GET', body, headers = {}, session, token, browser = true } = {}) {
  const h = { 'cf-connecting-ip': '203.0.113.9', ...headers };
  if (browser) {
    h['user-agent'] ??= UA;
    if (method !== 'GET') h.origin ??= ORIGIN;
  }
  if (session) h.cookie = `__Host-eden=${session}`;
  if (token) h.authorization = `Bearer ${token}`;
  const init = { method, headers: h };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    h['content-type'] ??= 'application/json';
  }
  const r = await worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx);
  while (waits.length) await Promise.all(waits.splice(0));
  return r;
}
async function person(sub = 'apple-user-1') {
  const r = await hit('/api/account/apple', { method: 'POST', browser: false, body: { identity_token: await identityToken({ sub }), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } } });
  assert.equal(r.status, 200, await r.clone().text());
  const phone = await r.json();
  const link = await hit('/api/web/link', { method: 'POST', body: {} });
  const code = (await link.clone().json()).code;
  const cookie = link.headers.getSetCookie().find((c) => c.startsWith('__Host-eden-link=')).split(';')[0];
  await hit(`/api/link/${code}/approve`, { method: 'POST', browser: false, token: phone.token, body: { sealed_key: null, sender_key: null } });
  const done = await hit('/api/web/link/poll', { method: 'POST', body: {}, headers: { cookie } });
  const session = done.headers.getSetCookie().find((c) => c.startsWith('__Host-eden=')).split(';')[0].slice('__Host-eden='.length);
  return { id: phone.account.id, token: phone.token, session };
}
const chat = (who, p, opts = {}) => hit(p, { session: who.session, ...opts, headers: { 'x-jarvis-chat': '1', ...(opts.headers || {}) } });
const postJ = async (who, p, body) => {
  const r = await chat(who, p, { method: 'POST', body });
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
};
/** A turn beside the open essay: the essay rides in a context block, the message is the student's few words. */
const essayTurn = (who, content, extra = {}) =>
  chat(who, '/api/chat/send', {
    method: 'POST',
    body: { messages: [{ role: 'user', content }], context: [{ title: 'Your essay', text: ESSAY }], temporary: true, ...extra, settings: { level: 3, ...(extra.settings || {}) } },
  });
const routeOf = (events) => events.find((e) => e.type === 'route').data;
const answers = () => calls.filter((c) => c.kind === 'answer');

// ── the rules ──

test('the page’s essay mark, checked leniently: kinds, words clamped, anything else no essay turn', () => {
  assert.equal(essayOf({}), null);
  assert.equal(essayOf({ essay: false }), null);
  assert.equal(essayOf({ essay: 'yes' }), null);
  assert.deepEqual(essayOf({ essay: true }), { kind: 'write', words: 600 });
  assert.deepEqual(essayOf({ essay: { kind: 'feedback', words: 10 } }), { kind: 'feedback', words: 30 });
  assert.deepEqual(essayOf({ essay: { kind: 'rubric' } }), { kind: 'rubric', words: 500 });
  assert.deepEqual(essayOf({ essay: { kind: 'outline', words: 99_999 } }), { kind: 'write', words: 6000 }, 'a kind this server doesn’t know yet is still an essay turn');
});

test('the floor: no fast tier and writing ≥ 90 (Luna, Flash-Lite, Haiku, Kimi K2.7 Code left out)', () => {
  const ids = essayFloor(hostedConfig({}).models).map((m) => m.id);
  assert.deepEqual(ids.slice().sort(), FLOOR.slice().sort());
  for (const id of FAST_OR_WEAK) assert.ok(!ids.includes(id), id);
});

test('the hints: complex (a full draft of 600+ words at level 4 and up: expert), the reply’s tokens from its words, writing emphasized', () => {
  assert.deepEqual(essayHints({ kind: 'write', words: 1000 }, 3), { complexity: 'complex', outputTokens: 1480, emphasize: { writing: 2 } });
  assert.equal(essayHints({ kind: 'write', words: 1000 }, 4).complexity, 'expert');
  assert.equal(essayHints({ kind: 'write', words: 300 }, 5).complexity, 'complex', 'a paragraph is careful work, not expert work');
  assert.deepEqual(essayHints({ kind: 'feedback', words: 400 }, 5), { complexity: 'complex', outputTokens: 640, emphasize: { writing: 1.5, analysis: 1.5 } });
});

test('the room: words × 1.6 + 3,000 within 4,000–16,000 for a draft, 6,000 for comments, never past the cap', () => {
  assert.equal(essayRoom({ kind: 'write', words: 100 }), 4000);
  assert.equal(essayRoom({ kind: 'write', words: 1500 }), 5400);
  assert.equal(essayRoom({ kind: 'write', words: 6000 }), 12600);
  assert.equal(essayRoom({ kind: 'feedback', words: 400 }), 6000);
  assert.equal(essayRoom({ kind: 'rubric', words: 400 }), 6000);
  assert.equal(essayRoom({ kind: 'write', words: 6000 }, 8000), 8000);
});

test('tool and essay blocks are left out of what the checks read, an unfinished one at the end too', () => {
  const reply = 'Done.\n<eden-tool>{"name":"essay_title","args":{"title":"A"}}</eden-tool>\nMore prose.\n<eden-essay where="end">"A quote" in the essay.</eden-essay>\n<eden-essay-edit>x</eden-essay-edit><eden-essay-title>T</eden-essay-title>\n<eden-essay-source>{"title":"S"}</eden-essay-source>\nLast.\n<eden-essay where="end">cut off';
  assert.equal(withoutToolBlocks(reply).replace(/\s+/g, ' ').trim(), 'Done. More prose. Last.');
  assert.ok(TOOL_BLOCK_TAG.test('<eden-essay-edit>') && TOOL_BLOCK_TAG.test('<eden-tool>') && !TOOL_BLOCK_TAG.test('<eden-essayist>'));
});

// ── routing (the preview, as the page's estimate line asks for it) ──

const cfgOf = (models) => ({ ...hostedConfig({}), ...(models ? { models: hostedConfig({}).models.filter((m) => models.includes(m.id)) } : {}), keys: {} });

test('T18d: the preview of an essay turn routes among the writers, with the open essay as the session, and says so', () => {
  const cfg = cfgOf(hostedConfig({}).models.filter((m) => m.provider !== 'anthropic').map((m) => m.id));
  const plain = routePreview({ prompt: 'continue', level: 3 }, cfg);
  const essay = routePreview({ prompt: 'continue', level: 3, essay: { kind: 'write', words: 800 }, context: { sessionTokens: 9000 } }, cfg);
  assert.ok(FLOOR.includes(essay.pick.model), essay.pick.model);
  assert.ok(essay.notes.includes(ESSAY_NOTE), JSON.stringify(essay.notes));
  assert.ok(!plain.notes.includes(ESSAY_NOTE));
  assert.ok(essay.task.inputTokens >= 9000, `the open essay counts as the session (${essay.task.inputTokens})`);
  assert.ok(essay.pick.costUSD > plain.pick.costUSD, `priced as an essay turn (${essay.pick.costUSD} vs ${plain.pick.costUSD})`);
  if (bundleTakesHints) {
    assert.equal(essay.task.complexity, 'complex');
    assert.equal(essay.task.outputTokens, Math.ceil(800 * 1.4) + 80);
  }
  // none of the writers here: the usual pool, and the note says why
  const weak = routePreview({ prompt: 'continue', essay: { kind: 'write', words: 300 } }, cfgOf(['gpt-6-luna', 'gemini-3.5-flash-lite']));
  assert.ok(['gpt-6-luna', 'gemini-3.5-flash-lite'].includes(weak.pick.model));
  assert.ok(weak.notes.includes(ESSAY_NO_FLOOR_NOTE));
});

test('the autopilot within the floor: stage 2 leaves out the frontier writers, stage 3 keeps the cheapest writer', () => {
  const essay = { kind: 'write', words: 800 };
  const floor = { ...cfgOf(), models: essayFloor(hostedConfig({}).models) };
  const two = personalRoute(floor, 'continue', { level: 4 }, { stage: 2, essay, floored: true });
  assert.ok(two.pool.models.every((m) => m.tier !== 'frontier' && FLOOR.includes(m.id)), two.pool.models.map((m) => m.id).join());
  const three = personalRoute(floor, 'continue', { level: 4 }, { stage: 3, essay, floored: true });
  assert.deepEqual(three.pool.models.map((m) => m.id), ['gemini-3.8-flash']);
  assert.equal(three.result.pick.model, 'gemini-3.8-flash');
  // not an essay turn: stage 3 is the fast tier, as before
  const plain = personalRoute(cfgOf(), 'continue', { level: 4 }, { stage: 3 });
  assert.ok(plain.pool.models.every((m) => m.tier === 'fast'));
});

// ── a turn ──

test('an essay turn: a writer from the floor, no Gemini rating, room for the reply, the route says so; without the mark, as before', async () => {
  const me = await person();
  const ask = 'write the next paragraph about sleep';
  const plain = await readEvents(await essayTurn(me, ask));
  assert.ok(plain.some((e) => e.type === 'done'), JSON.stringify(plain));
  assert.ok(calls.some((c) => c.kind === 'rating'), 'an ordinary turn is rated by Gemini');
  calls = [];
  const events = await readEvents(await essayTurn(me, ask, { essay: { kind: 'write', words: 1500 } }));
  assert.ok(events.some((e) => e.type === 'done'), JSON.stringify(events));
  assert.equal(calls.filter((c) => c.kind === 'rating').length, 0, 'no rating on an essay turn');
  const [a] = answers();
  assert.ok(FLOOR.includes(a.model), a.model);
  assert.equal(a.maxTokens, essayRoom({ kind: 'write', words: 1500 }), 'room for a 1,500-word reply and the thinking before it');
  const route = routeOf(events);
  assert.ok(route.notes.includes(ESSAY_NOTE), JSON.stringify(route.notes));
  assert.ok(FLOOR.includes(route.model));
});

test('feedback on the essay gets a page of comments’ room; a model the person picked is used as picked', async () => {
  const me = await person();
  await readEvents(await essayTurn(me, 'Give me feedback on my essay', { essay: { kind: 'feedback', words: 400 } }));
  assert.equal(answers()[0].maxTokens, 6000);
  calls = [];
  const events = await readEvents(await essayTurn(me, 'continue', { essay: { kind: 'write', words: 300 }, override: { model: 'gpt-6-luna', effort: 'low' } }));
  assert.equal(answers()[0].model, 'gpt-6-luna');
  assert.ok(!routeOf(events).notes.includes(ESSAY_NOTE));
});

test('no fact checks after an essay reply, even on a question they would check', async () => {
  const me = await person();
  const q = 'Why did Einstein win the Nobel Prize for relativity? Write the paragraph about it.';
  await readEvents(await essayTurn(me, q, { context: [] }));
  assert.ok(calls.some((c) => c.kind === 'check'), 'the same question in an ordinary turn is checked');
  calls = [];
  const events = await readEvents(await essayTurn(me, q, { essay: { kind: 'write', words: 200 }, context: [] }));
  assert.ok(events.some((e) => e.type === 'done'));
  assert.equal(calls.filter((c) => c.kind === 'check').length, 0, JSON.stringify(calls));
  assert.ok(!events.some((e) => e.type === 'verification' || e.type === 'grounding'));
});

test('an essay turn on little allowance: the room shrinks to what fits, the cheapest writer before a refusal, then a clear stop', async () => {
  // $0.02 left: a 2,500-token reply fits on Gemini 3.8 Flash, not on the frontier writers
  env.TRIAL_BUDGET_USD = '0.02';
  const me = await person();
  // (at level 5 the router's writer for this is GPT-6.1 Sol)
  const r = await essayTurn(me, 'Write a 5 paragraph essay analyzing the theme of ambition in Macbeth', { essay: { kind: 'write', words: 3000 }, settings: { level: 5 } });
  assert.equal(r.status, 200, await r.clone().text());
  const events = await readEvents(r);
  const [a] = answers();
  assert.equal(a.model, 'gemini-3.8-flash');
  const route = routeOf(events);
  assert.ok(route.notes.includes('essay: on Gemini 3.8 Flash, the strong writer your allowance has room for'), JSON.stringify(route.notes));
  assert.ok(a.maxTokens >= ESSAY_MIN_REPLY_TOKENS && a.maxTokens < essayRoom({ kind: 'write', words: 3000 }), `shrunk to what the allowance holds (${a.maxTokens})`);
  // too little for even that: refused before anything is sent, saying why; an ordinary short turn still goes
  env.TRIAL_BUDGET_USD = '0.004';
  calls = [];
  const poor = await person('apple-user-2');
  const refused = await essayTurn(poor, 'continue', { essay: { kind: 'write', words: 600 } });
  assert.equal(refused.status, 402);
  const out = await refused.json();
  assert.equal(out.code, 'no_allowance');
  assert.match(out.error, /essay writing/);
  assert.equal(answers().length, 0);
  const ok = await essayTurn(poor, 'continue', { context: [] });
  assert.equal(ok.status, 200, await ok.clone().text());
});

// ── students: the same floor (owner, 2026-10-10) ──

async function classroom() {
  const prof = await person('prof');
  const student = await person('student');
  const c = await postJ(prof, '/api/chat/courses', { name: 'ENG 101' });
  await postJ(prof, `/api/chat/courses/${c.id}/docs`, { name: 'Essay guide', kind: 'text', parts: [{ loc: 'p 1', text: 'A thesis states a claim the essay argues; each paragraph supports it with evidence.' }] });
  await postJ(student, '/api/chat/courses/join', { code: c.code, age13: true, label: 'Sam' });
  return { prof, student, course: c.id };
}
const today = () => new Date().toISOString().slice(0, 10);

test('a free study turn on an essay: the floor at the efficient level, room fitted to the free allowance; too little left, a clear stop', async () => {
  const { student, course } = await classroom();
  const r = await essayTurn(student, 'write the introduction', { course, essay: { kind: 'write', words: 800 }, override: { model: 'gpt-6-luna', effort: 'low' } });
  assert.equal(r.status, 200, await r.clone().text());
  const events = await readEvents(r);
  assert.ok(events.some((e) => e.type === 'done'), JSON.stringify(events));
  const [a] = answers();
  assert.ok(FLOOR.includes(a.model), `a free turn's pick is dropped, and the floor applies (${a.model})`);
  assert.ok(a.maxTokens >= ESSAY_MIN_REPLY_TOKENS, `room ${a.maxTokens}`);
  const route = routeOf(events);
  assert.ok(route.notes.includes(ESSAY_NOTE), JSON.stringify(route.notes));
  assert.ok(route.notes.some((n) => /free study allowance/.test(n)));
  assert.ok(!events.some((e) => e.type === 'grounding'), 'no quote check on the essay');
  // almost nothing left today: refused with the student's choice of their own allowance, nothing sent
  calls = [];
  env.ACCOUNTS.get(student.id);
  await env.ACCOUNTS.objects.get(student.id).storage.put('edu_free', { day: today(), spent: EDU_FREE.dailyUSD - 0.004, turns: 3, voice: 0, joins: 1 });
  const refused = await essayTurn(student, 'continue', { course, essay: { kind: 'write', words: 800 } });
  assert.equal(refused.status, 402);
  const out = await refused.json();
  assert.equal(out.code, 'edu_allowance_used');
  assert.match(out.error, /free study AI is left for essay writing/);
  assert.equal(answers().length, 0);
});
