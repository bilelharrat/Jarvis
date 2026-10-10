// Q10 end to end: a student's course turn about a graded assignment, through the Worker. The model's
// final answer never reaches the page (struck before it streams), thinking isn't shown, no web
// search, and the reply carries the "Hint mode: graded assignment" label; the professor's turn is normal.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { forgetSessions } from '../src/eden/session.js';
import { Course } from '../src/edu/course.js';
import { Account, Link, appleJwk, claudeAnswer, identityToken, namespace, readEvents, sseBody } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
let env, waits, anthropic, sent;
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;

beforeEach(() => {
  waits = [];
  sent = [];
  forgetAppleKeys();
  forgetSessions();
  anthropic = () => new Response(sseBody(claudeAnswer()), { headers: { 'content-type': 'text/event-stream' } });
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    if (url === 'https://api.anthropic.com/v1/messages') { const body = JSON.parse(init.body); sent.push(body); return anthropic(body); }
    throw new Error(`unexpected fetch ${url}`);
  };
  env = { ANTHROPIC_API_KEY: 'sk-test', TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '20' };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.COURSES = namespace(Course, env);
  env.ASSETS = { fetch: async () => new Response('asset') };
});
after(() => { globalThis.fetch = realFetch; });

async function settle() { while (waits.length) await Promise.all(waits.splice(0)); }
async function hit(p, { method = 'GET', body, headers = {}, session, token, browser = true } = {}) {
  const h = { ...headers };
  if (browser) { h['user-agent'] ??= SAFARI; if (method !== 'GET') h.origin ??= ORIGIN; }
  if (session) h.cookie = `__Host-eden=${session}`;
  if (token) h.authorization = `Bearer ${token}`;
  const init = { method, headers: h };
  if (body !== undefined) { init.body = JSON.stringify(body); h['content-type'] ??= 'application/json'; }
  const r = await worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx);
  await settle();
  return r;
}
const cookieValue = (r, name) => { const c = (r.headers.getSetCookie() || []).find((x) => x.startsWith(`${name}=`)); return c ? c.slice(name.length + 1).split(';')[0] : undefined; };
async function browserFor(sub) {
  const ph = await (await hit('/api/account/apple', { method: 'POST', browser: false, body: { identity_token: await identityToken({ sub }), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } } })).json();
  const start = await hit('/api/web/link', { method: 'POST', body: {} });
  const link = await start.json();
  const jar = `__Host-eden-link=${cookieValue(start, '__Host-eden-link')}`;
  await hit(`/api/link/${link.code}/approve`, { method: 'POST', browser: false, token: ph.token, body: { sealed_key: null, sender_key: null } });
  return cookieValue(await hit('/api/web/link/poll', { method: 'POST', body: {}, headers: { cookie: jar } }), '__Host-eden');
}
const api = (session, p, body) => hit(p, { session, method: body === undefined ? 'GET' : 'POST', body, headers: { 'x-jarvis-chat': '1' } }).then(async (r) => { const j = await r.json(); assert.ok(r.status < 300, JSON.stringify(j)); return j; });

test('a graded-assignment question gets hints: the final answer is struck before the page sees it, labeled, counted', async () => {
  const prof = await browserFor('apple-prof');
  const student = await browserFor('apple-student');
  const made = await api(prof, '/api/chat/courses', { name: 'PHYS 101' });
  const docs = await api(prof, `/api/chat/courses/${made.id}/docs`, { name: 'Lecture 3', kind: 'slides', parts: [{ loc: 'slide 7', text: 'For constant acceleration, v = v0 + a t, and a falling object accelerates at g = 9.8 m/s squared.' }] });
  await api(prof, `/api/chat/courses/${made.id}/assignments`, { name: 'Problem Set 2', graded: true, files: [{ doc: docs.docs[0].id }] });
  await api(student, '/api/chat/courses/join', { age13: true, code: made.code });

  anthropic = (body) => new Response(sseBody(claudeAnswer({ model: body.model, thinking: ['v = 0 + 9.8 * 3 = 29.4'], text: ['Use v = v0 + a t [1]. ', 'What is v0 here?\n\n', 'So v = 29.4 m/s.\n\n<sources>\n[1] S1 "For constant acceleration, v = v0 + a t"\n</sources>'] })), { headers: { 'content-type': 'text/event-stream' } });
  const r = await hit('/api/chat/send', { session: student, method: 'POST', headers: { 'x-jarvis-chat': '1' }, body: { course: made.id, mode: 'search', messages: [{ role: 'user', content: 'Solve this for me: a ball falls for 3 s from rest, what is the final velocity? constant acceleration' }], settings: { level: 3 } } });
  assert.equal(r.status, 200);
  const events = await readEvents(r);
  const text = events.filter((e) => e.type === 'text').map((e) => e.data.text).join('');
  assert.ok(!text.includes('29.4'), 'the final answer never reached the page');
  assert.match(text, /Use v = v0 \+ a t \[1\]\. What is v0 here\?/);
  assert.match(text, /Final answer removed/);
  assert.ok(!events.some((e) => e.type === 'thinking'), 'no thinking shown in hint mode');
  const g = events.find((e) => e.type === 'grounding').data;
  assert.equal(g.hint.label, 'Hint mode: graded assignment');
  assert.equal(g.hint.name, 'Problem Set 2');
  assert.equal(g.hint.struck, 1);
  assert.equal(g.status, 'verified');
  const sys = JSON.stringify(sent[0].system);
  assert.match(sys, /HINT MODE/);
  assert.ok(!sent[0].tools || !sent[0].tools.some((t) => /web_search/.test(t.type || '')), 'no web search on graded work');
  const ins = await api(prof, `/api/chat/courses/${made.id}/insights`);
  assert.equal(ins.hints[0].n, 1);

  // the professor asking the same thing gets a normal answer
  sent = [];
  const pr = await readEvents(await hit('/api/chat/send', { session: prof, method: 'POST', headers: { 'x-jarvis-chat': '1' }, body: { course: made.id, messages: [{ role: 'user', content: 'Solve this for me: a ball falls for 3 s from rest, what is the final velocity? constant acceleration' }], settings: { level: 3 } } }));
  assert.match(pr.filter((e) => e.type === 'text').map((e) => e.data.text).join(''), /29\.4/);
  assert.equal(pr.find((e) => e.type === 'grounding').data.hint, undefined);
  assert.doesNotMatch(JSON.stringify(sent[0].system), /HINT MODE/);
});
