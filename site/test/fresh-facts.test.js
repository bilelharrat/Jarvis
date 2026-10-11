// 2026-10-10 (Kirk Cousins): a follow-up and a correction were answered from a model's memory, with no date in the prompt,
// and the person was told "That is not Kirk Cousins" when they said he was on the Raiders. These turns now go to the web
// (askeden src/verify/risk.ts through vendor/verify.js), and every prompt has today's date and the changing-facts rule.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetSessions } from '../src/eden/session.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { freshnessNote, parseSend, systemPrompt } from '../src/eden/chat.js';
import { changingFacts, disputedAnswer } from '../src/eden/vendor/verify.js';
import { Account, Link, appleJwk, identityToken, namespace, readEvents } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
const realFetch = globalThis.fetch;
let env;
let waits;
let answers; // every answering call to Gemini: { tools, system }
const ctx = { waitUntil: (p) => waits.push(p) };
const geminiSse = (text) =>
  `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 40 } })}\n\n`;

beforeEach(() => {
  waits = [];
  answers = [];
  forgetAppleKeys();
  forgetSessions();
  env = { GEMINI_API_KEY: 'g-test', TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '20' };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    if (url.includes('generativelanguage.googleapis.com') && url.includes(':streamGenerateContent')) {
      const body = JSON.parse(init.body);
      answers.push({ tools: body.tools || [], system: JSON.stringify(body.systemInstruction || '') });
      return new Response(geminiSse('An answer.'), { headers: { 'content-type': 'text/event-stream' } });
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
async function signedIn() {
  const owner = await (await hit('/api/account/apple', { method: 'POST', headers: { origin: undefined }, body: { identity_token: await identityToken(), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } } })).json();
  const link = await hit('/api/web/link', { method: 'POST', body: {} });
  const code = (await link.clone().json()).code;
  const cookie = link.headers.getSetCookie().find((c) => c.startsWith('__Host-eden-link=')).split(';')[0];
  await hit(`/api/link/${code}/approve`, { method: 'POST', headers: { authorization: `Bearer ${owner.token}`, origin: undefined, 'user-agent': undefined }, body: { sealed_key: null, sender_key: null } });
  const done = await hit('/api/web/link/poll', { method: 'POST', body: {}, headers: { cookie } });
  return done.headers.getSetCookie().find((c) => c.startsWith('__Host-eden=')).split(';')[0].slice('__Host-eden='.length);
}
/** A routed turn (no model pick), the router's rating off, both fact checks off: only the answer calls Gemini. */
const send = async (session, messages, settings = {}) => {
  const r = await hit('/api/chat/send', { method: 'POST', session, headers: { 'x-jarvis-chat': '1' }, body: { messages, temporary: true, settings: { level: 3, classifier: 'off', premiseCheck: false, answerCheck: false, ...settings } } });
  assert.equal(r.status, 200, await r.clone().text());
  return readEvents(r);
};
const searched = (call) => call.tools.some((t) => t.google_search);

const CHAT = [
  { role: 'user', content: 'was kirk cousins falcons contract fully guaranteed' },
  { role: 'assistant', content: 'No, Kirk Cousins’ contract with the Atlanta Falcons was not fully guaranteed.' },
  { role: 'user', content: 'how much did he leave with' },
  { role: 'assistant', content: 'Cousins hasn’t left Atlanta. He’s under contract with the Falcons through the 2027 season.' },
];

test('every system prompt has today’s date and the changing-facts rule', () => {
  const body = parseSend({ messages: [{ role: 'user', content: 'hi' }] }, { maxInputTokens: 1e6 });
  const prompt = systemPrompt({ ...body, now: new Date(Date.UTC(2026, 9, 10, 12)) });
  assert.ok(prompt.includes('Today is 2026-10-10.'), prompt.slice(0, 200));
  assert.ok(prompt.includes(changingFacts));
  assert.match(freshnessNote(new Date(Date.UTC(2026, 9, 10))), /^Today is 2026-10-10\. .*never tell the user they are wrong about something recent/);
});

test('the Kirk Cousins chat: the follow-up and the correction both search the web; the correction is told not to defend its answer', async () => {
  const session = await signedIn();
  await send(session, CHAT.slice(0, 3));
  assert.equal(answers.length, 1);
  assert.ok(searched(answers[0]), 'how much did he leave with: searched');
  assert.ok(answers[0].system.includes('Today is'));
  assert.ok(!answers[0].system.includes("Don't defend it from memory"));
  answers = [];
  await send(session, [...CHAT, { role: 'user', content: 'wtf r u talking about hes on the raiders' }]);
  assert.equal(answers.length, 1);
  assert.ok(searched(answers[0]), 'the correction: searched');
  assert.ok(answers[0].system.includes(JSON.stringify(disputedAnswer).slice(1, -1)), 'the disputed-answer rule is in the prompt');
});

test('a roster question searches; an everyday follow-up does not; Auto-search off keeps a dispute in Chat but still says not to defend it', async () => {
  const session = await signedIn();
  await send(session, [{ role: 'user', content: 'who does kirk cousins play for' }]);
  assert.ok(searched(answers[0]), 'roster question searched');
  answers = [];
  await send(session, [{ role: 'user', content: 'write a haiku about autumn' }, { role: 'assistant', content: 'Leaves fall…' }, { role: 'user', content: 'make it shorter' }]);
  assert.ok(!searched(answers[0]), 'an edit stays in Chat');
  assert.ok(!answers[0].system.includes("Don't defend it from memory"));
  answers = [];
  await send(session, [...CHAT, { role: 'user', content: 'no hes on the raiders now' }], { autoSearch: false });
  assert.ok(!searched(answers[0]), 'Auto-search off: no search');
  assert.ok(answers[0].system.includes("Don't defend it from memory"));
});
