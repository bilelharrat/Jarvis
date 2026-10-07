// Hosted Eden's part of "a router that learns from you" (askeden ROADMAP H2) and the spending
// autopilot (H3), src/eden/chat.js: the page's per-class adjustments checked and applied within
// the caps (or, learning off, only reported), the autopilot on the account's included AI (Plus:
// this month's share and forecast; the trial: the share spent) stepping the level down and
// leaving out the dearer models, a pick of your own skipping it, GET /api/chat/spend, and each
// usage event's `topUSD` (the top model's price for the same tokens).

import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { hostedAutopilot, hostedConfig, learnedOf, personalRoute, routePreview } from '../src/eden/chat.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Link, appleJwk, claudeAnswer, identityToken, namespace, readEvents, sseBody } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15';
const cfg = (({ models, ...rest }) => ({ ...rest, models: models.filter((m) => m.provider === 'anthropic') }))(hostedConfig({})); // a Worker with only an Anthropic key
const EMAIL = 'Write a short, friendly email declining a meeting.';

// ── the pure parts ──

test('the page’s adjustments: only hosted models and known classes, clamped to the largest cap; none → null', () => {
  assert.equal(learnedOf({}, cfg), null);
  assert.equal(learnedOf({ learned: { adj: { poetry: { 'claude-haiku-4-5': 2 } } } }, cfg), null);
  assert.deepEqual(learnedOf({ learned: { adj: { writing: { 'claude-haiku-4-5': 40, 'gpt-6-luna': 3, 'claude-opus-5-5': -2.04 } }, on: false } }, cfg), {
    adj: { writing: { 'claude-haiku-4-5': 8, 'claude-opus-5-5': -2 } },
    on: false,
  });
});

test('the autopilot on the allowance: Plus by this month’s forecast, the trial by its share, a shared pool not at all', () => {
  const env = { PLUS_BUDGET_USD: '20', TRIAL_BUDGET_USD: '1' };
  const mid = Date.UTC(2026, 9, 16, 12); // half of October gone
  assert.equal(hostedAutopilot(env, { ok: true, bucket: 'plus', left: 15 }, mid).stage, 0, '$5 by mid-month: ~$10');
  assert.equal(hostedAutopilot(env, { ok: true, bucket: 'plus', left: 11 }, mid).stage, 1, '$9: ~$18 (90%)');
  assert.equal(hostedAutopilot(env, { ok: true, bucket: 'plus', left: 10.2 }, mid).stage, 2, '$9.80: ~$19.6 (98%)');
  const plus = hostedAutopilot(env, { ok: true, bucket: 'plus', left: 0 }, mid);
  assert.equal(plus.stage, 3);
  assert.equal(plus.budgetUSD, 20);
  assert.equal(plus.periodStart, new Date(Date.UTC(2026, 9, 1)).toISOString());
  assert.equal(hostedAutopilot(env, { ok: true, bucket: 'trial', left: 0.15 }, mid).stage, 1, 'the trial: 85% spent');
  assert.equal(hostedAutopilot(env, { ok: true, bucket: 'trial', left: 0.5 }, mid).stage, 0);
  assert.equal(hostedAutopilot(env, { ok: true, bucket: 'plus|dlg:abc|me', left: 1 }, mid), null, 'a delegate’s pool has its own limit');
  assert.equal(hostedAutopilot(env, { ok: false, why: 'used up' }, mid).stage, 3);
});

test('routing with the stage: one level down, then no Opus, then only the cheapest model; the profile tips the pick or, off, only says so', () => {
  const base = personalRoute(cfg, EMAIL, { level: 4 });
  assert.equal(base.info.taskClass, 'writing');
  assert.equal(base.info.autopilot, undefined);
  const lean = personalRoute(cfg, EMAIL, { level: 4 }, { stage: 1 });
  assert.equal(lean.result.optimization.level.level, 3, 'Level 4 → 3');
  assert.match(lean.info.notes.join(), /autopilot: one level cheaper/);
  const save = personalRoute(cfg, EMAIL, { level: 4 }, { stage: 2 });
  assert.ok(!save.result.rows.some((r) => r.model === 'claude-opus-5-5'), 'no Opus at 95%');
  const cap = personalRoute(cfg, EMAIL, { level: 5 }, { stage: 3 });
  assert.deepEqual([...new Set(cap.result.rows.map((r) => r.model))], ['claude-haiku-4-5'], 'only the cheapest');
  assert.equal(cap.info.autopilot.label, 'Autopilot: budget reached');
  // The profile: Opus favoured strongly for writing, the others not.
  const picked = base.result.pick.model;
  const adj = { writing: Object.fromEntries(cfg.models.map((m) => [m.id, m.id === 'claude-opus-5-5' ? 8 : -8])) };
  const on = personalRoute(cfg, EMAIL, { level: 4 }, { learned: { adj, on: true } });
  assert.equal(on.info.learned.on, true);
  assert.equal(on.result.pick.model, 'claude-opus-5-5');
  assert.equal(on.info.learned.changed, picked !== 'claude-opus-5-5');
  const off = personalRoute(cfg, EMAIL, { level: 4 }, { learned: { adj, on: false } });
  assert.equal(off.result.pick.model, picked, 'learning off: routed as before');
  if (picked !== 'claude-opus-5-5') assert.equal(off.info.learned.with.model, 'claude-opus-5-5', 'the shadow: what it would pick');
  const other = personalRoute(cfg, 'Fix the off-by-one bug: for (let i = 0; i <= a.length; i++) sum += a[i];', { level: 4 }, { learned: { adj, on: true } });
  assert.equal(other.info.learned, undefined, 'another kind of task: untouched');
  // the preview takes the page's hint (the send checks the allowance itself)
  const preview = routePreview({ prompt: EMAIL, level: 5, autopilot: { stage: 3 }, learned: { adj, on: true } }, cfg);
  assert.equal(preview.pick.model, 'claude-haiku-4-5');
  assert.equal(preview.autopilot.stage, 3);
  assert.equal(preview.taskClass, 'writing');
  assert.equal(routePreview({ prompt: EMAIL, level: 5, autopilot: false }, cfg).autopilot, undefined);
});

// ── a turn, end to end (fakes) ──

let env;
let waits;
let anthropic;
let sent;
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;

beforeEach(() => {
  waits = [];
  sent = [];
  forgetAppleKeys();
  forgetSessions();
  anthropic = (body) => new Response(sseBody(claudeAnswer({ model: body.model, input: 1200, output: 400 })), { headers: { 'content-type': 'text/event-stream' } });
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    if (url === 'https://api.anthropic.com/v1/messages') {
      const body = JSON.parse(init.body);
      sent.push(body);
      return anthropic(body, init);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  env = { ANTHROPIC_API_KEY: 'sk-test', TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '20' };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.ASSETS = { fetch: async () => new Response('asset') };
});
after(() => {
  globalThis.fetch = realFetch;
});

async function settle() {
  while (waits.length) await Promise.all(waits.splice(0));
}
async function hit(p, { method = 'GET', body, headers = {}, browser = true, session, token } = {}) {
  const h = { ...headers };
  if (browser) {
    h['user-agent'] ??= SAFARI;
    if (method !== 'GET') h.origin ??= ORIGIN;
  }
  if (session) h.cookie = `__Host-eden=${session}`;
  if (token) h.authorization = `Bearer ${token}`;
  const init = { method, headers: h };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    h['content-type'] ??= 'application/json';
  }
  const response = await worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx);
  await settle();
  return response;
}
const cookieOf = (response, name) => {
  const c = (response.headers.getSetCookie ? response.headers.getSetCookie() : []).find((x) => x.startsWith(`${name}=`));
  return c ? c.slice(name.length + 1).split(';')[0] : undefined;
};
async function signedIn() {
  const owner = await (await hit('/api/account/apple', { method: 'POST', browser: false, body: { identity_token: await identityToken(), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } } })).json();
  const linkRes = await hit('/api/web/link', { method: 'POST', body: {} });
  const link = await linkRes.json();
  await hit(`/api/link/${link.code}/approve`, { method: 'POST', browser: false, token: owner.token, body: { sealed_key: null, sender_key: null } });
  const done = await hit('/api/web/link/poll', { method: 'POST', body: {}, headers: { cookie: `__Host-eden-link=${cookieOf(linkRes, '__Host-eden-link')}` } });
  return { owner, session: cookieOf(done, '__Host-eden') };
}
const chat = (p, session, opts = {}) => hit(p, { session, ...opts, headers: { 'x-jarvis-chat': '1', ...(opts.headers || {}) } });
const turn = (session, body) => chat('/api/chat/send', session, { method: 'POST', body: { messages: [{ role: 'user', content: EMAIL }], settings: { level: 5 }, ...body } });

test('a turn on askeden.com: the trial at 85% steps the level down; topUSD on the usage; the page’s profile applied; a pick of your own skips the autopilot', async () => {
  const { owner, session } = await signedIn();
  const account = env.ACCOUNTS.objects.get(owner.account.id);
  await account.storage.put('usage', { month: new Date().toISOString().slice(0, 7), spent: 0, trial_spent: 0.85 });

  const spend = await (await chat('/api/chat/spend', session)).json();
  assert.equal(spend.hosted, true);
  assert.equal(spend.bucket, 'trial');
  assert.equal(spend.autopilot.stage, 1);
  assert.equal(spend.budgetUSD, 1);

  const ev = await readEvents(await turn(session, {}));
  const route = ev.find((e) => e.type === 'route').data;
  assert.equal(route.autopilot.stage, 1);
  assert.equal(route.taskClass, 'writing');
  assert.ok(route.notes.some((n) => /^autopilot: one level cheaper/.test(n)), route.notes.join(' | '));
  const usage = ev.find((e) => e.type === 'usage').data;
  assert.ok(usage.topUSD >= usage.costUSD && usage.topUSD > 0, JSON.stringify(usage));

  const mine = await readEvents(await turn(session, { override: { model: 'claude-sonnet-5-5' } }));
  assert.equal(mine.find((e) => e.type === 'route').data.autopilot, undefined, 'your pick for one message');
  const level = await readEvents(await turn(session, { autopilot: false }));
  assert.equal(level.find((e) => e.type === 'route').data.autopilot, undefined, '“Use my level this time”');

  const adj = { writing: { 'claude-opus-5-5': 8, 'claude-sonnet-5-5': -8, 'claude-haiku-4-5': -8 } };
  sent.length = 0;
  const tuned = (await readEvents(await turn(session, { autopilot: false, learned: { adj, on: true } }))).find((e) => e.type === 'route').data;
  assert.equal(tuned.learned.on, true);
  assert.equal(tuned.model, 'claude-opus-5-5');
  assert.equal(sent[0].model, 'claude-opus-5-5', 'what was sent to Anthropic');
  const shadow = (await readEvents(await turn(session, { autopilot: false, learned: { adj, on: false } }))).find((e) => e.type === 'route').data;
  assert.equal(shadow.learned.on, false);
  if (shadow.model !== 'claude-opus-5-5') assert.equal(shadow.learned.with.model, 'claude-opus-5-5');
});
