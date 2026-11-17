// The GCP credit pacer's hooks in askeden.com's request paths (src/eden/credit-pacer.js): with CREDIT_PACER unset
// nothing changes and nothing is counted; on, a free account's chat turn, Help question and trip plan are refused at
// red before any model call and halved at amber, a paying account never is, Google spend is counted paid or unpaid,
// and a counter that fails never blocks anything. Fake Google and fake Durable Objects throughout.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker, { VoiceQuota } from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { COUNTER_OBJECT, PACER_COPY, pacerStatus, resetPacerCache, pacificParts } from '../src/eden/credit-pacer.js';
import { resetPool } from '../src/eden/key-pool.js';
import { forgetSessions } from '../src/eden/session.js';
import { tripOp } from '../src/travel/ops.js';
import { autodraftPass } from '../src/accounts/autodrafts.js';
import { cleanTask, runTask } from '../src/accounts/tasks.js';
import { bytesToB64 } from '../src/accounts/util.js';
import { Account, Identity, Link, Storage, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const A = '33333333-3333-4333-8333-333333333333';
const realFetch = globalThis.fetch;
let env;
let waits;
let calls;
let route; // (url, init) → Response | null
const ctx = { waitUntil: (p) => waits.push(p), passThroughOnException() {} };

const geminiText = (text, usage = { promptTokenCount: 1000, candidatesTokenCount: 200 }) => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], usageMetadata: usage });
function geminiDefault(url) {
  if (url.includes(':streamGenerateContent')) return new Response(`data: ${JSON.stringify(geminiText('A cat jumps.', { promptTokenCount: 12000, candidatesTokenCount: 20 }))}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  if (url.includes(':generateContent')) return Response.json(geminiText('Open J.A.R.V.I.S. on your Mac and check the link is on. [#err-mac-offline]'));
  return new Response('{}', { status: 404 });
}
const modelCalls = () => calls.filter((c) => c.url.startsWith('https://generativelanguage.googleapis.com/') && /:(stream)?[gG]enerateContent/.test(c.url));
const streamCalls = () => calls.filter((c) => c.url.includes(':streamGenerateContent'));

function makeEnv(extra = {}) {
  const e = { GEMINI_API_KEY: 'g-A', TRIAL_BUDGET_USD: '5', PLUS_BUDGET_USD: '20', LINK_RATE: rateLimiter(), API_RATE: rateLimiter(), EDEN_RATE: rateLimiter(), AUTH_RATE: rateLimiter(), USER_RATE: rateLimiter(), ...extra };
  e.ACCOUNTS = namespace(Account, e);
  e.LINKS = namespace(Link, e);
  e.IDENTITIES = namespace(Identity, e);
  e.VOICE_QUOTA = namespace(VoiceQuota, e);
  e.ASSETS = { fetch: async () => new Response('asset') };
  return e;
}
/** A counter that is down: every request to it throws (the VoiceQuota objects Help counts with still work). */
function brokenCounter(e) {
  const real = e.VOICE_QUOTA;
  e.VOICE_QUOTA = { objects: real.objects, idFromName: real.idFromName, get: (name) => (name === COUNTER_OBJECT ? { fetch: async () => { throw new Error('counter down'); } } : real.get(name)) };
}

beforeEach(() => {
  forgetSessions();
  resetPool({ rand: () => 0 });
  resetPacerCache();
  waits = [];
  calls = [];
  route = () => null;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push({ url, init });
    const r = await route(url, init);
    if (r) return r;
    if (url.startsWith('https://generativelanguage.googleapis.com/')) return geminiDefault(url);
    throw new Error(`unexpected fetch ${url}`);
  };
});
after(() => {
  globalThis.fetch = realFetch;
});

const settle = async () => {
  while (waits.length) await Promise.all(waits.splice(0));
};
const browser = async (email = 'free@example.com') => (await call(env, A, 'web-signin', { account_id: A, create: true, identity: { provider: 'google', sub_hash: 'p'.repeat(64), email }, device: { name: 'Eden on the web: Safari on a Mac' } })).token;
async function hit(path, token, { body } = {}) {
  const init = { method: 'POST', headers: { origin: ORIGIN, 'x-jarvis-chat': '1', cookie: `__Host-eden=${token}`, 'user-agent': 'Mozilla/5.0 Safari/605', 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const res = await worker.fetch(new Request(`${ORIGIN}${path}`, init), env, ctx);
  const text = await res.text();
  await settle();
  const events = [...text.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map(([, type, data]) => ({ type, data: JSON.parse(data) }));
  return { status: res.status, text, events, json: () => JSON.parse(text) };
}
const turn = (token) => hit('/api/chat/send', token, { body: { messages: [{ role: 'user', content: 'Say hello to the cat' }] } });
const helpAsk = (token, question = 'askeden says Your Mac is offline, what now?') => hit('/api/help/ask', token, { body: { question } });
/** Puts unpaid spend on today's (Pacific) counter. */
async function seedUnpaid(usd) {
  const p = pacificParts(Date.now());
  await env.VOICE_QUOTA.get(COUNTER_OBJECT).fetch('https://credit-pacer/add', { method: 'POST', body: JSON.stringify({ day: p.day, hour: p.hour, usd, paid: false, feature: 'seed' }) });
}
const status = () => pacerStatus(env, { fresh: true });

// ── chat ──

test('flag off: a free account\'s Gemini turn is as before, and nothing reaches the counter', async () => {
  env = makeEnv({ CREDIT_BALANCE_USD: '0' }); // would be red, but the pacer is off
  const token = await browser();
  const r = await turn(token);
  assert.equal(r.status, 200, r.text);
  assert.ok(r.events.some((e) => e.type === 'text'), r.text);
  assert.equal(streamCalls().length, 1);
  assert.ok(!env.VOICE_QUOTA.objects.has(COUNTER_OBJECT), 'no counter object was ever made');
});

test('red: a free account\'s turn is refused before any model call, with the allowance-used answer the page shows', async () => {
  env = makeEnv({ CREDIT_PACER: 'on', CREDIT_BALANCE_USD: '0' });
  const token = await browser();
  const r = await turn(token);
  assert.equal(r.status, 402, r.text);
  const body = r.json();
  assert.equal(body.code, 'no_allowance');
  assert.equal(body.error, PACER_COPY.full);
  assert.equal(modelCalls().length, 0, 'no Gemini call');
});

test('red: a paying account (owner family, Plus for good) is never throttled, and its Google spend counts as paid', async () => {
  env = makeEnv({ CREDIT_PACER: 'on', CREDIT_BALANCE_USD: '0', UNLIMITED_EMAILS: 'family@example.com' });
  const token = await browser('family@example.com');
  const r = await turn(token);
  assert.equal(r.status, 200, r.text);
  assert.ok(r.events.some((e) => e.type === 'text'), r.text);
  const s = await status();
  assert.ok(s.paidTodayUSD > 0, JSON.stringify(s));
  assert.equal(s.unpaidTodayUSD, 0);
});

test('warn: nothing is refused even at red, and a free turn\'s Gemini spend is counted unpaid', async () => {
  env = makeEnv({ CREDIT_PACER: 'warn', CREDIT_BALANCE_USD: '0' });
  const token = await browser();
  const r = await turn(token);
  assert.equal(r.status, 200, r.text);
  const s = await status();
  assert.ok(s.unpaidTodayUSD > 0, JSON.stringify(s));
  assert.equal(s.paidTodayUSD, 0);
  assert.ok(Object.keys(s.byFeature).some((k) => k.startsWith('unpaid:')), JSON.stringify(s.byFeature));
});

test('red: compare and EVES refuse a free account before any lane runs (EVES\'s models untouched: refused, never swapped)', async () => {
  env = makeEnv({ CREDIT_PACER: 'on', CREDIT_BALANCE_USD: '0' });
  const token = await browser();
  for (const path of ['/api/chat/compare', '/api/chat/eves']) {
    const r = await hit(path, token, { body: { messages: [{ role: 'user', content: 'Is the sky blue?' }] } });
    assert.equal(r.status, 402, `${path}: ${r.text}`);
    assert.equal(r.json().error, PACER_COPY.full, path);
  }
  assert.equal(modelCalls().length, 0);
});

test('red: a Plus subscriber past the month\'s Plus allowance (now on the trial) still gets answers, counted as paid, never told to get Plus', async () => {
  env = makeEnv({ CREDIT_PACER: 'on', CREDIT_BALANCE_USD: '0', UNLIMITED_EMAILS: 'family@example.com', UNLIMITED_BUDGET_USD: '0' });
  const token = await browser('family@example.com');
  const allow = await env.ACCOUNTS.objects.get(A).allowAi();
  assert.deepEqual([allow.bucket, allow.plan_active], ['trial', true], JSON.stringify(allow));
  const r = await turn(token);
  assert.equal(r.status, 200, r.text);
  assert.ok(r.events.some((e) => e.type === 'text'), r.text);
  const s = await status();
  assert.ok(s.paidTodayUSD > 0, JSON.stringify(s));
  assert.equal(s.unpaidTodayUSD, 0);
});

test('Help at red: a paying account still gets Help (its answers still count as unpaid: no one pays for Help)', async () => {
  env = makeEnv({ CREDIT_PACER: 'on', CREDIT_BALANCE_USD: '0', UNLIMITED_EMAILS: 'family@example.com' });
  const token = await browser('family@example.com');
  const r = await helpAsk(token);
  assert.equal(r.status, 200, r.text);
  const s = await status();
  assert.ok(s.byFeature['unpaid:help'] > 0, JSON.stringify(s.byFeature));
});

test('the owner\'s /api/admin/credit-pacer: the state now, and a day\'s spend made elsewhere; anyone else gets not found', async () => {
  env = makeEnv({ CREDIT_PACER: 'warn', ADMIN_EMAILS: 'owner@example.com', CREDIT_BALANCE_DATE: pacificParts(Date.now() - 3 * 86_400_000).day });
  const token = await browser('owner@example.com');
  const yesterday = pacificParts(Date.now() - 86_400_000).day;
  const posted = await hit('/api/admin/credit-pacer', token, { body: { day: yesterday, source: 'mac', usd: 42.5 } });
  assert.equal(posted.status, 200, posted.text);
  assert.equal(posted.json().mode, 'warn');
  assert.equal(posted.json().spentBeforeUSD, 42.5); // counted against the balance from today on
  const bad = await hit('/api/admin/credit-pacer', token, { body: { day: yesterday, source: 'mac', usd: 'lots' } });
  assert.equal(bad.status, 400, bad.text);
  const B = '44444444-4444-4444-8444-444444444444';
  const otherToken = (await call(env, B, 'web-signin', { account_id: B, create: true, identity: { provider: 'google', sub_hash: 'q'.repeat(64), email: 'someone@example.com' }, device: { name: 'Eden on the web: Safari on a Mac' } })).token;
  const other = await hit('/api/admin/credit-pacer', otherToken, { body: { day: yesterday, source: 'mac', usd: 1 } });
  assert.equal(other.status, 404);
  assert.equal((await status()).spentBeforeUSD, 42.5, 'nothing recorded for them');
});

test('fail open: with the counter down, a free turn still answers', async () => {
  env = makeEnv({ CREDIT_PACER: 'on' });
  brokenCounter(env);
  const token = await browser();
  const r = await turn(token);
  assert.equal(r.status, 200, r.text);
  assert.ok(r.events.some((e) => e.type === 'text'), r.text);
});

// ── Help ──

test('Help at red: no Help chat today, before the question is counted or any model is asked; off, the same question is answered', async () => {
  env = makeEnv({ CREDIT_PACER: 'on', CREDIT_BALANCE_USD: '0' });
  const token = await browser();
  const r = await helpAsk(token);
  assert.equal(r.status, 503, r.text);
  assert.equal(r.json().code, 'help_busy');
  assert.equal(r.json().error, PACER_COPY.help);
  assert.equal(modelCalls().length, 0);
  env.CREDIT_PACER = 'off';
  const ok = await helpAsk(token);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json().left.messages, 29); // the refused one wasn't counted
});

test('Help at amber: half the day\'s questions; its Gemini answers are counted unpaid', async () => {
  env = makeEnv({ CREDIT_PACER: 'on', CREDIT_UNPAID_DAILY_CAP_USD: '1', HELP_DAILY_MESSAGES: '4' });
  await seedUnpaid(0.75); // 75% of $1: amber
  const token = await browser();
  const first = await helpAsk(token);
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json().left.messages, 1); // 2 a day now, not 4
  assert.equal((await helpAsk(token)).status, 200);
  const third = await helpAsk(token);
  assert.equal(third.status, 429, third.text);
  assert.match(third.json().error, /today’s 2 Help questions/);
  const s = await status();
  assert.ok(s.byFeature['unpaid:help'] > 0, JSON.stringify(s.byFeature));
});

// ── the Travel planner (runs in the account's object: travel/ops.js) ──

function travelAccount(extra = {}, plan = null) {
  const m = new Map();
  const storage = {
    get: async (k) => (Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, m.get(x)])) : structuredClone(m.get(k))),
    put: async (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) m.set(a, structuredClone(b)); else m.set(k, structuredClone(v)); },
    delete: async (k) => { for (const x of [].concat(k)) m.delete(x); return true; },
    list: async ({ prefix }) => new Map([...m].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
  };
  m.set('account', { id: '11111111-1111-4111-8111-111111111111' });
  env = makeEnv(extra);
  return { m, storage, env, now: () => Date.now(), ...(plan ? { planNow: async () => plan } : {}) };
}
const ASK = { request: 'Two days in Florence, the Uffizi and good food', constraints: { start: '2026-12-02', days: 2, travelers: 2 } };
// the draft model runs out of room at once: a quick, counted failure (no Maps, no second model)
const cutOff = async (url) => (url.includes(':generateContent') ? Response.json({ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }], usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 8000, thoughtsTokenCount: 0 } }) : new Response('{}', { status: 404 }));
const deps = { fetch: cutOff, maps: {} };

// TRAVEL_PLUS = "0" (local dev): free accounts plan trips too, so the pacer may refuse them; by default Travel is Plus only
test('Travel at red (TRAVEL_PLUS off): a free account\'s plan is refused with the pacer\'s words; a Plus account\'s goes on', async () => {
  const free = travelAccount({ CREDIT_PACER: 'on', CREDIT_BALANCE_USD: '0', TRAVEL_PLUS: '0' });
  await assert.rejects(tripOp(free, 'trip-plan', ASK, deps), (e) => e.status === 429 && e.code === 'rate_limited' && e.message === PACER_COPY.travel);
  assert.equal(free.m.get('tplan:count'), undefined, 'not counted');
  const plus = travelAccount({ CREDIT_PACER: 'on', CREDIT_BALANCE_USD: '0', TRAVEL_PLUS: '0' }, { active: true });
  await assert.rejects(tripOp(plus, 'trip-plan', ASK, deps), (e) => e.message !== PACER_COPY.travel); // the planner itself ran (and ran out of room)
  assert.equal(plus.m.get('tplan:count').n, 1);
});

test('Travel Plus only (the default): plans count as paid, so Plus users\' trips never push free users to amber, and no counter read', async () => {
  const acct = travelAccount({ CREDIT_PACER: 'on', CREDIT_BALANCE_USD: '0' }); // red, and no planNow: account.js already let only Plus through
  const asked = [];
  const real = env.VOICE_QUOTA;
  env.VOICE_QUOTA = { objects: real.objects, idFromName: real.idFromName, get: (name) => { const stub = real.get(name); return { fetch: (input, init) => { asked.push(String(input)); return stub.fetch(input, init); } }; } };
  await assert.rejects(tripOp(acct, 'trip-plan', ASK, deps), (e) => e.code === 'incomplete'); // planned (and ran out of room)
  assert.equal(acct.m.get('tplan:count').n, 1);
  assert.ok(!asked.some((u) => u.endsWith('/status')), `no status read for a paying account: ${asked}`);
  await new Promise((r) => setTimeout(r, 20)); // the counter's adds (no ctx in the object: fire and forget)
  const s = await status();
  assert.ok(s.byFeature['paid:travel-plan'] > 0, JSON.stringify(s.byFeature));
  assert.equal(s.unpaidTodayUSD, 0);
});

test('Travel at amber (TRAVEL_PLUS off): half the plans a day; a free account\'s planner Gemini spend is counted unpaid', async () => {
  const acct = travelAccount({ CREDIT_PACER: 'on', CREDIT_UNPAID_DAILY_CAP_USD: '10', TRAVEL_PLANS_A_DAY: '4', TRAVEL_PLUS: '0' });
  await seedUnpaid(7.5); // amber
  for (let i = 0; i < 2; i++) await assert.rejects(tripOp(acct, 'trip-plan', ASK, deps), (e) => e.code === 'incomplete');
  await assert.rejects(tripOp(acct, 'trip-plan', ASK, deps), (e) => e.code === 'rate_limited' && /That’s 2 plans today/.test(e.message));
  await new Promise((r) => setTimeout(r, 20)); // the counter's adds (no ctx in the object: fire and forget)
  const s = await status();
  assert.ok(s.byFeature['unpaid:travel-plan'] > 0, JSON.stringify(s.byFeature));
});

test('Travel with the pacer off: the daily limit is the usual one and nothing is counted', async () => {
  const acct = travelAccount({ CREDIT_BALANCE_USD: '0', TRAVEL_PLANS_A_DAY: '1' });
  await assert.rejects(tripOp(acct, 'trip-plan', ASK, deps), (e) => e.code === 'incomplete');
  await assert.rejects(tripOp(acct, 'trip-plan', ASK, deps), (e) => e.code === 'rate_limited' && /That’s 1 plan today/.test(e.message));
  assert.ok(!env.VOICE_QUOTA.objects.has(COUNTER_OBJECT));
});

// ── background runs in the account's object: scheduled tasks and Auto Drafts (Gemini 3.8 Flash by default) ──

const TRIAL = { ok: true, bucket: 'trial', left: 0.8, allowance_left: 0.8, budget: 1, credits_usd: 0, plan_active: false };
function backgroundAccount(allow) {
  const storage = new Storage();
  storage.map.set('account', { id: 'acct-1' });
  const spent = [];
  return { storage, env, spent, now: () => Date.now(), allowAi: async () => allow, holdAi: async () => ({ ok: true, bucket: allow.bucket, hold: 'h1', ...(allow.plan_active ? { plan_active: true } : {}) }), spend: async (x) => { spent.push(x.usd); }, release: () => {} };
}
const MAIL = { id: 'm1', threadId: 't1', from: 'Priya Shah <priya@example.org>', subject: 'Contract', body: 'Could you confirm the 30-day terms by Wednesday?', messageId: '<a1@x>', attachments: [] };
const gmail = () => {
  const api = {
    search: async () => ({ messages: [{ ...MAIL, snippet: '' }], nextPageToken: null, estimate: 1 }),
    read: async () => ({ ...MAIL, to: 'me@x.com', cc: '', replyTo: '', references: null, inReplyTo: null, labelIds: [], bodyType: 'text', truncated: false, html: null, date: null, snippet: '', unread: true }),
    sendAs: async () => [{ email: 'me@x.com', name: 'Me', signature: '', isDefault: true, isPrimary: true, verified: true, replyTo: '' }],
  };
  return { email: 'me@x.com', scopes: ['https://www.googleapis.com/auth/gmail.modify'], gmail: () => api };
};

test('Auto Drafts at red: a free account\'s drafts on Google\'s AI wait (no model call); a paying account\'s go on, counted as paid', async () => {
  env = makeEnv({ CREDIT_PACER: 'on', CREDIT_BALANCE_USD: '0', EDEN_TOKEN_KEY: bytesToB64(new Uint8Array(32).fill(3)) });
  const asked = [];
  const ask = async () => { asked.push(1); return { ok: true, costUSD: 0.002, model: 'gemini-3.8-flash', value: { needs_reply: false, reason: 'FYI', body: null } }; };
  const free = backgroundAccount(TRIAL);
  const r = await autodraftPass(free, { on: true, perDay: 10 }, free.now(), { google: gmail(), ask, notify: async () => {} });
  assert.equal(r.skipped, PACER_COPY.background);
  assert.equal(asked.length, 0, 'no model call');
  const plus = backgroundAccount({ ...TRIAL, plan_active: true }); // Plus past its month's allowance, on the trial
  const p = await autodraftPass(plus, { on: true, perDay: 10 }, plus.now(), { google: gmail(), ask, notify: async () => {} });
  assert.equal(p.checked, 1, JSON.stringify(p));
  assert.equal(asked.length, 1);
  await new Promise((res) => setTimeout(res, 20)); // the counter's add (no ctx in the object)
  const s = await status();
  assert.equal(s.byFeature['paid:autodraft'], 0.002, JSON.stringify(s.byFeature));
});

test('a scheduled task\'s run at red: a free account\'s run on Google\'s AI is skipped before any hold or model call, and runs again next time', async () => {
  env = makeEnv({ CREDIT_PACER: 'on', CREDIT_BALANCE_USD: '0' });
  const now = Date.now();
  const task = { ...cleanTask({ plan: 'Remind me to stretch', trigger: { kind: 'time', at: new Date(now + 3_600_000).toISOString(), repeat: 'daily' }, actions: ['notify'] }, now), id: 't1', spent: { month: '', usd: 0 } };
  const free = { ...backgroundAccount(TRIAL), holdAi: async () => { throw new Error('never held'); } };
  const record = await runTask(free, task, now);
  assert.equal(record.outcome, 'skipped', JSON.stringify(record));
  assert.equal(record.error, PACER_COPY.background);
  assert.equal(record.wait_until, undefined, 'its usual next time');
  assert.equal(modelCalls().length, 0);
  // the pacer off: the same run goes on to the model
  env.CREDIT_PACER = 'off';
  const ran = await runTask(backgroundAccount(TRIAL), task, now);
  assert.notEqual(ran.error, PACER_COPY.background);
  assert.equal(modelCalls().length, 1);
});

test('the EVES thumbs-down repair (owner and owner family only) counts as paid, so a run of flags never pushes free users to amber', async () => {
  env = makeEnv({ CREDIT_PACER: 'warn', UNLIMITED_EMAILS: 'family@example.com' });
  const token = await browser('family@example.com');
  const r = await hit('/api/chat/eves/flag', token, { body: { rating: 'down', question: 'What colour is the sky on a clear day?', answer: 'The sky is green on a clear day.', model: 'eves' } });
  assert.equal(r.status, 200, r.text);
  assert.ok(modelCalls().length > 0, 'the repair asked Gemini');
  const s = await status();
  assert.ok(s.byFeature['paid:eves-repair'] > 0, JSON.stringify(s.byFeature));
  assert.equal(s.unpaidTodayUSD, 0);
});
