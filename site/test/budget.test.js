// Who pays for students' AI in a course (src/edu/budget.js, askeden ROADMAP L9): the course budget,
// then the student's free daily allowance, then a plain stop (the student's own allowance only when
// they choose it); the professor's budget view; abuse limits on joining; the tutor's voice.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { grantCredits } from '../src/accounts/credits.js';
import { forgetSessions } from '../src/eden/session.js';
import { Course } from '../src/edu/course.js';
import { EDU_ABUSE, EDU_BUDGET, EDU_FREE, allowanceWords, courseVoice, shapeFreeTurn, studentId } from '../src/edu/budget.js';
import { Account, Link, appleJwk, claudeAnswer, identityToken, namespace, readEvents, sseBody } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
let env;
let waits;
let anthropic;
let requests;
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;

beforeEach(() => {
  waits = [];
  requests = [];
  forgetAppleKeys();
  forgetSessions();
  anthropic = () => new Response(sseBody(claudeAnswer({ input: 3000, output: 300, text: ['Oxygen is the final electron acceptor [S1].'] })), { headers: { 'content-type': 'text/event-stream' } });
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    if (url === 'https://api.anthropic.com/v1/messages') { const b = JSON.parse(init.body); requests.push(b); return anthropic(b, init); }
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

async function hit(p, { method = 'GET', body, headers = {}, browser = true, session, token, raw = false, signal, ip = '203.0.113.7' } = {}) {
  const h = { 'cf-connecting-ip': ip, ...headers };
  if (browser) { h['user-agent'] ??= SAFARI; if (method !== 'GET') h.origin ??= ORIGIN; }
  if (session) h.cookie = `__Host-eden=${session}`;
  if (token) h.authorization = `Bearer ${token}`;
  const init = { method, headers: h, ...(signal ? { signal } : {}) };
  if (body !== undefined) { init.body = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const response = await worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx);
  if (!raw) await settle();
  return response;
}

async function person(sub) {
  const r = await hit('/api/account/apple', { method: 'POST', browser: false, body: { identity_token: await identityToken({ sub }), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } } });
  assert.equal(r.status, 200, await r.clone().text());
  const phone = await r.json();
  const link = await hit('/api/web/link', { method: 'POST', body: {} });
  const l = await link.json();
  const jar = link.headers.getSetCookie().find((c) => c.startsWith('__Host-eden-link=')).split(';')[0];
  await hit(`/api/link/${l.code}/approve`, { method: 'POST', browser: false, token: phone.token, body: { sealed_key: null, sender_key: null } });
  const done = await hit('/api/web/link/poll', { method: 'POST', body: {}, headers: { cookie: jar } });
  const session = done.headers.getSetCookie().find((c) => c.startsWith('__Host-eden=')).split(';')[0].slice('__Host-eden='.length);
  return { id: phone.account.id, token: phone.token, session };
}

const chat = (who, p, opts = {}) => hit(p, { session: who.session, ...opts, headers: { 'x-jarvis-chat': '1', ...(opts.headers || {}) } });
const getJ = async (who, p) => { const r = await chat(who, p); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
const postJ = async (who, p, body) => { const r = await chat(who, p, { method: 'POST', body }); assert.equal(r.status, 200, await r.clone().text()); return r.json(); };
const ask = (who, course, extra = {}, opts = {}) => chat(who, '/api/chat/send', { method: 'POST', ...opts, body: { messages: [{ role: 'user', content: 'What does oxygen do at complex IV?' }], course, temporary: true, settings: { level: 4 }, ...extra } });
const accountOf = (id) => { env.ACCOUNTS.get(id); return env.ACCOUNTS.objects.get(id); };
const ownUsage = async (who) => (await (await hit('/api/account', { browser: false, token: who.token })).json()).usage;

async function classroom() {
  const prof = await person('prof');
  const student = await person('student');
  const c = await postJ(prof, '/api/chat/courses', { name: 'BIO 201' });
  await postJ(prof, `/api/chat/courses/${c.id}/docs`, { name: 'Lecture 5', kind: 'slides', parts: [{ loc: 'slide 22', text: 'At complex IV oxygen is the final electron acceptor and combines with H+ to form water.' }] });
  await postJ(student, '/api/chat/courses/join', { code: c.code, age13: true, label: 'Sam' });
  return { prof, student, course: c.id, code: c.code };
}

test('a free study turn: the student’s free daily allowance pays on an efficient model, never their own allowance', async () => {
  const { prof, student, course } = await classroom();
  const r = await ask(student, course, { override: { model: 'claude-opus-5-5', effort: 'high' } });
  assert.equal(r.status, 200, await r.clone().text());
  const events = await readEvents(r);
  assert.ok(events.some((e) => e.type === 'done'), JSON.stringify(events));
  assert.notEqual(requests[0].model, 'claude-opus-5-5', 'a free turn ignores the student’s model pick');
  const route = events.find((e) => e.type === 'route').data;
  assert.ok(JSON.stringify(route).includes('free study turns use an efficient model'));
  assert.equal((await ownUsage(student)).trial_left_usd, 1, 'the student’s own trial is untouched');
  const left = await getJ(student, `/api/chat/courses/${course}/allowance`);
  assert.ok(left.free.left_usd < EDU_FREE.dailyUSD && left.free.left_usd > 0);
  assert.equal(left.course.funded, false);
  assert.match(left.text, /^Free today: about \d+ more questions and about 9 minutes of Eden’s voice\. It refills at midnight UTC\.$/);
  assert.equal(accountOf(student.id).holds.size, 0, 'the hold is released');
  // the professor's own turn in the course stays on the professor's own allowance
  await readEvents(await ask(prof, course));
  assert.ok((await ownUsage(prof)).trial_left_usd < 1);
  assert.equal((await getJ(prof, `/api/chat/courses/${course}/allowance`)).role, 'owner');
});

test('a funded course pays first, within the per-student daily cap; the professor sees spend by day, top usage (anonymous), alerts and can pause', async () => {
  const { prof, student, course } = await classroom();
  // no Plus and no credits: a budget can't be set
  const refused = await chat(prof, `/api/chat/courses/${course}/budget`, { method: 'POST', body: { monthly_usd: 10 } });
  assert.equal(refused.status, 402);
  assert.equal((await chat(student, `/api/chat/courses/${course}/budget`)).status, 403, 'students never see the budget');
  await grantCredits(accountOf(prof.id), { id: 'test-pack', usd: 5, source: 'test' });
  const set = await postJ(prof, `/api/chat/courses/${course}/budget`, { monthly_usd: 10, student_daily_usd: 0.5 });
  assert.equal(set.monthly_usd, 10);
  assert.equal(set.funding_ok, true);
  await assert.rejects(postJ(prof, `/api/chat/courses/${course}/budget`, { monthly_usd: EDU_BUDGET.maxMonthlyUSD + 1 }));

  const words = await getJ(student, `/api/chat/courses/${course}/allowance`);
  assert.match(words.text, /^Your professor’s course budget covers your studying today/);
  const r = await ask(student, course, { override: { model: 'claude-opus-5-5', effort: 'low' } });
  const events = await readEvents(r);
  assert.ok(events.some((e) => e.type === 'done'), JSON.stringify(events));
  assert.equal(requests[0].model, 'claude-opus-5-5', 'a funded turn keeps the student’s pick');
  const view = await getJ(prof, `/api/chat/courses/${course}/budget`);
  assert.ok(view.spent_usd > 0);
  assert.equal(view.days.length, 1);
  assert.equal(view.top[0].student, await studentId(course, student.id), 'the class list’s anonymous id, never an account');
  assert.equal(JSON.stringify(view).includes(student.id), false);
  assert.equal(view.alert, null);
  const free = await getJ(student, `/api/chat/courses/${course}/allowance`);
  assert.equal(free.free.left_usd, EDU_FREE.dailyUSD, 'the free allowance is untouched');
  assert.equal(accountOf(prof.id).holds.size, 0);

  // alerts: 80% and 100% of the month
  await postJ(prof, `/api/chat/courses/${course}/budget`, { monthly_usd: Math.round((view.spent_usd / 0.85) * 1e6) / 1e6 });
  const at80 = await getJ(prof, `/api/chat/courses/${course}/budget`);
  assert.equal(at80.alert, 80, JSON.stringify(at80));
  // used up: the free allowance takes over; the budget never goes negative
  await postJ(prof, `/api/chat/courses/${course}/budget`, { monthly_usd: 0.01 });
  await readEvents(await ask(student, course));
  const full = await getJ(prof, `/api/chat/courses/${course}/budget`);
  assert.equal(full.alert, 100);
  assert.equal(full.left_usd, 0);
  assert.ok((await getJ(student, `/api/chat/courses/${course}/allowance`)).free.left_usd < EDU_FREE.dailyUSD, 'the free allowance paid once the budget ran out');

  // paused: the free allowance pays
  await postJ(prof, `/api/chat/courses/${course}/budget`, { monthly_usd: 10, paused: true });
  const paused = await getJ(student, `/api/chat/courses/${course}/allowance`);
  assert.equal(paused.course.ok, false);
  assert.match(paused.text, /^Free today/);
});

test('a stopped funded turn is still charged and its hold let go', async () => {
  const { prof, student, course } = await classroom();
  await grantCredits(accountOf(prof.id), { id: 'test-pack', usd: 5, source: 'test' });
  await postJ(prof, `/api/chat/courses/${course}/budget`, { monthly_usd: 10 });
  let upstream;
  anthropic = () => {
    upstream = sseBody(claudeAnswer({ input: 5000, text: ['x'.repeat(3000)], final: false }), { hold: true });
    return new Response(upstream, { headers: { 'content-type': 'text/event-stream' } });
  };
  const gone = new AbortController();
  const r = await ask(student, course, {}, { raw: true, signal: gone.signal });
  const reader = r.body.getReader();
  let seen = '';
  while (!seen.includes('event: text')) seen += new TextDecoder().decode((await reader.read()).value);
  assert.equal(accountOf(prof.id).holds.size, 1, 'held while it runs');
  gone.abort();
  await settle();
  assert.ok(upstream.wasCancelled());
  assert.equal(accountOf(prof.id).holds.size, 0, 'released');
  assert.ok((await getJ(prof, `/api/chat/courses/${course}/budget`)).spent_usd > 0, 'what it used is charged');
});

test('nothing left: a plain stop, and the student’s own allowance only when they choose it', async () => {
  const { student, course } = await classroom();
  const acct = accountOf(student.id);
  await acct.storage.put('edu_free', { day: new Date().toISOString().slice(0, 10), spent: EDU_FREE.dailyUSD, turns: 3, voice: 0, joins: 1 });
  const r = await ask(student, course);
  assert.equal(r.status, 402);
  const out = await r.json();
  assert.equal(out.code, 'edu_allowance_used');
  assert.match(out.error, /used today’s free study AI/);
  assert.equal(requests.length, 0);
  assert.match((await getJ(student, `/api/chat/courses/${course}/allowance`)).text, /used today’s free study AI/);
  const own = await ask(student, course, { eduOwn: true });
  assert.equal(own.status, 200);
  await readEvents(own);
  assert.ok((await ownUsage(student)).trial_left_usd < 1, 'their own allowance, because they chose it');
});

test('abuse limits: new courses an account joins a day, and joins and free accounts per network', async () => {
  const prof = await person('prof');
  const student = await person('student');
  const codes = [];
  for (let i = 0; i < EDU_ABUSE.joinsPerAccountDay + 1; i++) codes.push((await postJ(prof, '/api/chat/courses', { name: `Course ${i}` })).code);
  for (const code of codes.slice(0, -1)) await postJ(student, '/api/chat/courses/join', { code, age13: true });
  await postJ(student, '/api/chat/courses/join', { code: codes[0], age13: true }); // already in it: not counted
  const sixth = await chat(student, '/api/chat/courses/join', { method: 'POST', body: { code: codes.at(-1), age13: true } });
  assert.equal(sixth.status, 429);
  assert.match((await sixth.json()).error, /at most 5 new courses a day/);

  // a network that already gave the free allowance to its day's number of accounts
  const net = accountOf(`eduip:${await (await import('../src/accounts/util.js')).sha256Hex('edu-ip:198.51.100.9')}`);
  await net.storage.put('eduip', { day: new Date().toISOString().slice(0, 10), accounts: Array.from({ length: EDU_ABUSE.freeAccountsPerIpDay }, (_, i) => `x${i}`), joins: EDU_ABUSE.joinsPerIpDay });
  const late = await person('late');
  const blocked = await chat(late, '/api/chat/courses/join', { method: 'POST', body: { code: codes.at(-1), age13: true }, ip: '198.51.100.9' });
  assert.equal(blocked.status, 429);
  await postJ(late, '/api/chat/courses/join', { code: codes.at(-1), age13: true }); // from elsewhere
  const courseId = (await getJ(late, '/api/chat/courses')).courses[0].id;
  await postJ(prof, `/api/chat/courses/${courseId}/docs`, { name: 'Notes', kind: 'text', parts: [{ loc: 'section 1', text: 'Oxygen accepts electrons.' }] });
  const r = await ask(late, courseId, {}, { ip: '198.51.100.9' });
  assert.equal(r.status, 402);
  assert.match((await r.json()).error, /limited on this network today/);
});

test('the tutor’s voice: the free study characters, more while the course is funded; the professor’s own stays theirs', async () => {
  const { prof, student, course } = await classroom();
  const token = { account: student.id };
  assert.equal(await courseVoice(env, { account: prof.id }, course, 100), null);
  assert.equal(await courseVoice(env, token, course, 100, { own: true }), null);
  assert.equal((await courseVoice(env, token, course, EDU_FREE.voiceChars - 100)).ok, true);
  const out = await courseVoice(env, token, course, 200);
  assert.equal(out.ok, false);
  await grantCredits(accountOf(prof.id), { id: 'test-pack', usd: 5, source: 'test' });
  await postJ(prof, `/api/chat/courses/${course}/budget`, { monthly_usd: 10 });
  assert.equal((await courseVoice(env, token, course, 200)).ok, true, 'a funded course raises the cap');
});

test('a free turn’s shape and the plain words', () => {
  const body = { settings: { level: 5, efficiency: 10 }, override: { model: 'claude-opus-5-5' }, mode: 'research' };
  const raw = {};
  assert.deepEqual(shapeFreeTurn(body, raw, { source: 'free' }), ['free study turns use an efficient model']);
  assert.deepEqual(body, { settings: { level: EDU_FREE.level, classifier: 'off' }, override: null, mode: 'search' });
  assert.equal(raw.autopilot, false);
  const tutor = { settings: {}, override: { model: 'quick' }, mode: 'chat' };
  shapeFreeTurn(tutor, {}, { source: 'free' }, { autoPick: 'the tutor’s quick model' });
  assert.equal(tutor.override.model, 'quick');
  const funded = { settings: { level: 5 }, override: { model: 'x' }, mode: 'chat' };
  assert.deepEqual(shapeFreeTurn(funded, {}, { source: 'course' }), []);
  assert.equal(funded.override.model, 'x');
  assert.equal(allowanceWords({ course: null, free: { ok: true, today_left: 0.01, turns_left: 60, voice_left: 0 } }), 'Free today: about 5 more questions. It refills at midnight UTC.');
});

// QA 2026-10-09: one turn took a student to $0.16 against a $0.10 day; the allowance was checked before the turn,
// and the turn's real input can be more than its estimate. A provider that bills a fifth more input than the
// request's own bytes / 3 and uses every reply token it's allowed: the turn still fits in what was left.
const greedy = (b) => {
  const bytes = Buffer.byteLength(JSON.stringify(b.system || '')) + Buffer.byteLength(JSON.stringify(b.messages));
  return new Response(sseBody(claudeAnswer({ input: Math.ceil((bytes / 3) * 1.2), output: b.max_tokens, text: ['Oxygen is the final electron acceptor [S1].'] })), { headers: { 'content-type': 'text/event-stream' } });
};
const today = () => new Date().toISOString().slice(0, 10);
const costOf = (events) => events.find((e) => e.type === 'usage').data.costUSD;

test('a free turn is sized to what’s left today, with room for the estimate, and never past it', async () => {
  const { student, course } = await classroom();
  const acct = accountOf(student.id);
  anthropic = greedy;
  await acct.storage.put('edu_free', { day: today(), spent: EDU_FREE.dailyUSD - 0.02, turns: 3, voice: 0, joins: 1 });
  const events = await readEvents(await ask(student, course));
  assert.ok(events.some((e) => e.type === 'done'), JSON.stringify(events));
  const cost = costOf(events);
  assert.ok(cost > 0 && cost <= 0.02, `the turn cost ${cost}, with $0.02 left`);
  const s = await acct.storage.get('edu_free');
  assert.ok(Math.abs(s.spent - (EDU_FREE.dailyUSD - 0.02 + cost)) < 1e-6, 'charged in full: nothing past the day hidden by the clamp');
  assert.ok(s.spent <= EDU_FREE.dailyUSD);
  // a fresh day: one turn at most the per-turn cap, however long the reply could be
  await acct.storage.put('edu_free', { day: today(), spent: 0, turns: 0, voice: 0, joins: 1 });
  const fresh = costOf(await readEvents(await ask(student, course, { messages: [{ role: 'user', content: 'Explain everything in the course in full detail. '.repeat(40) }] })));
  assert.ok(fresh <= EDU_FREE.turnUSD, `one turn cost ${fresh}`);
  assert.equal(acct.holds.size, 0);
});

test('too little left for even a short reply: a clean stop before anything is sent', async () => {
  const { student, course } = await classroom();
  await accountOf(student.id).storage.put('edu_free', { day: today(), spent: EDU_FREE.dailyUSD - EDU_FREE.minTurnUSD - 0.0005, turns: 3, voice: 0, joins: 1 });
  const r = await ask(student, course);
  assert.equal(r.status, 402);
  const out = await r.json();
  assert.equal(out.code, 'edu_allowance_used', 'the page offers the student’s own allowance, as when the day is used up');
  assert.match(out.error, /used today’s free study AI/);
  assert.equal(requests.length, 0);
  assert.equal(accountOf(student.id).holds.size, 0);
});

test('the course budget’s per-student daily cap holds the same way', async () => {
  const { prof, student, course } = await classroom();
  await grantCredits(accountOf(prof.id), { id: 'test-pack', usd: 5, source: 'test' });
  await postJ(prof, `/api/chat/courses/${course}/budget`, { monthly_usd: 10, student_daily_usd: 0.5 });
  const by = await studentId(course, student.id);
  const key = `edu:crs:${course}`;
  const pool = await accountOf(prof.id).storage.get(key);
  await accountOf(prof.id).storage.put(key, { ...pool, today: { day: today(), by: { [by]: 0.48 } } });
  anthropic = greedy;
  const events = await readEvents(await ask(student, course));
  assert.ok(events.some((e) => e.type === 'done'), JSON.stringify(events));
  const cost = costOf(events);
  assert.ok(cost > 0 && cost <= 0.02, `the turn cost ${cost}, with $0.02 of the student’s share left`);
  const after = await accountOf(prof.id).storage.get(key);
  assert.ok(after.today.by[by] <= 0.5 + 1e-9, `the student’s day: ${after.today.by[by]}`);
  assert.equal((await getJ(student, `/api/chat/courses/${course}/allowance`)).free.left_usd, EDU_FREE.dailyUSD, 'the free allowance untouched');
});
