// The credits markup on the service's own small calls (chat.js memoryCharge: the memory extractor
// beside a reply, and Eden Mail's embeddings) is applied once, by the account's `spend`, exactly
// as for a reply: `spend` takes the provider's cost and charges the credits cost × 1.40 (Free) or
// × 1.25 (Plus). Before 2026-10-09 these two paths passed cost × markup to `spend`, which marked
// it up again (cost × 1.96 on Free). Providers are fakes answering fetch.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { MARKUP } from '../src/accounts/credits.js';
import { parseToken } from '../src/accounts/util.js';
import { embedUSD } from '../src/eden/embed.js';
import { EXTRACT_MODEL } from '../src/eden/memory.js';
import { modelOf, usageUSD } from '../src/eden/providers.js';
import { forgetSessions } from '../src/eden/session.js';
import { Account, Identity, Link, claudeAnswer, namespace, rateLimiter, readEvents, sseBody } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const A = '22222222-2222-4222-8222-222222222222';
const DAY = 86400_000;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 2e-6, `${msg}: expected ${b}, got ${a}`);

let env;
let waits;
let spends; // every `spend` the account object took: { usd (what it was asked), charged (what it charged) }
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;
const realSpend = Account.prototype.spend;

beforeEach(() => {
  forgetSessions();
  waits = [];
  spends = [];
  Account.prototype.spend = async function spend(args) {
    const out = await realSpend.call(this, args);
    spends.push({ usd: Number(args.usd), charged: out.charged_usd });
    return out;
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://api.anthropic.com/v1/messages') return new Response(sseBody(claudeAnswer({ input: 1000, output: 2000 })), { headers: { 'content-type': 'text/event-stream' } });
    if (url.includes(`${EXTRACT_MODEL}:generateContent`)) {
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ action: 'add', text: 'Is a designer at Acme' }) }] } }], usageMetadata: { promptTokenCount: 30_000, candidatesTokenCount: 2_000 } });
    }
    if (url.includes(':batchEmbedContents')) return Response.json({ embeddings: JSON.parse(init.body).requests.map(() => ({ values: [0.1, 0.2] })) });
    throw new Error(`unexpected fetch ${url}`);
  };
  env = {
    ANTHROPIC_API_KEY: 'sk-test',
    GEMINI_API_KEY: 'test-gemini',
    EDEN_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
    TRIAL_BUDGET_USD: '1',
    PLUS_BUDGET_USD: '6',
    LINK_RATE: rateLimiter(),
    API_RATE: rateLimiter(),
    EDEN_RATE: rateLimiter(),
    AUTH_RATE: rateLimiter(),
  };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.IDENTITIES = namespace(Identity, env);
  env.ASSETS = { fetch: async () => new Response('asset') };
});

after(() => {
  globalThis.fetch = realFetch;
  Account.prototype.spend = realSpend;
});

const settle = async () => { while (waits.length) await Promise.all(waits.splice(0)); };
const post = (p, body, session) => worker.fetch(new Request(`${ORIGIN}${p}`, {
  method: 'POST',
  headers: { 'user-agent': 'Mozilla/5.0 Safari/605', 'x-jarvis-chat': '1', origin: ORIGIN, cookie: `__Host-eden=${session}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
}), env, ctx);

/** A signed-in browser whose trial is used up and who has $10 of credits: its turns are on the credits. */
async function onCredits({ plus = false } = {}) {
  const session = (await call(env, A, 'web-signin', { account_id: A, create: true, device: { name: 'Eden on the web: Safari on a Mac' } })).token;
  const account = env.ACCOUNTS.objects.get(A);
  const now = Date.now();
  if (plus) {
    await account.storage.put('stripe_plan', { customer: 'cus_1', subscription: 'sub_1', status: 'active', price: 'price_plus', period_end: now + 30 * DAY, renews: true });
    env.STRIPE_PRICE_PLUS = 'price_plus';
  }
  await account.storage.put('credits', { customer: null, payment_method: null, lots: [{ id: 'pi_test', usd: 10, left: 10, at: now, expires: now + 365 * DAY, source: 'stripe' }] });
  await call(env, A, 'spend', { usd: 1, bucket: 'trial' }); // the trial, used up
  if (plus) await call(env, A, 'spend', { usd: 6, bucket: 'plus' }); // and the month's Plus allowance
  assert.equal((await call(env, A, 'allow-ai', { eden: true }, parseToken(session))).bucket, 'credits');
  spends = [];
  return { session, balance: async () => (await account.storage.get('credits')).lots[0].left };
}

for (const plus of [false, true]) {
  const markup = plus ? MARKUP.plus : MARKUP.free;
  test(`embeddings on the credits (${plus ? 'Plus' : 'Free'}): cost × ${markup} once, not twice`, async () => {
    const { session, balance } = await onCredits({ plus });
    const texts = Array.from({ length: 100 }, (_, i) => `${i}`.padEnd(2000, 'x')); // the most one call takes: ~67k tokens
    const sent = embedUSD('gemini', texts); // the provider's cost (an estimate from the length)
    const r = await post('/api/chat/embed', { texts }, session);
    assert.equal(r.status, 200, await r.clone().text());
    await settle();
    assert.equal(spends.length, 1);
    near(spends[0].usd, sent, '`spend` is given the provider cost');
    near(spends[0].charged, sent * markup, 'the user pays cost × the markup');
    near(await balance(), 10 - Math.round(sent * markup * 1e6) / 1e6, 'the credits go down by cost × the markup');
  });
}

test('the memory extractor beside a reply on the credits: cost × 1.40 once, the same as the reply', async () => {
  const { session, balance } = await onCredits();
  const r = await post('/api/chat/send', { messages: [{ role: 'user', content: 'I work at Acme as a designer, what should I read this week?' }], settings: { level: 3 }, mode: 'chat' }, session);
  assert.equal(r.status, 200, await r.clone().text());
  const events = await readEvents(r);
  await settle();
  const usage = events.find((e) => e.type === 'usage');
  assert.ok(usage, JSON.stringify(events.map((e) => e.type)));
  const memCost = usageUSD(modelOf(EXTRACT_MODEL), { inputTokens: 30_000, outputTokens: 2_000, reasoningTokens: 0 });
  assert.ok(memCost > 0);
  const mem = spends.find((s) => Math.abs(s.usd - memCost) < 2e-6 || Math.abs(s.usd - memCost * MARKUP.free) < 2e-6);
  assert.ok(mem, `a spend for the extractor in ${JSON.stringify(spends)}`);
  near(mem.usd, memCost, 'the extractor: `spend` is given the provider cost');
  near(mem.charged, memCost * MARKUP.free, 'the extractor: the user pays cost × 1.40');
  // The reply: `spend` given the provider cost, the user pays (and is shown) cost × 1.40.
  const reply = spends.find((s) => s !== mem);
  near(reply.charged, reply.usd * MARKUP.free, 'the reply: cost × 1.40');
  near(usage.data.costUSD, reply.usd * MARKUP.free, 'the reply shows the user’s price');
  const total = spends.reduce((n, s) => n + s.charged, 0);
  near(await balance(), Math.round((10 - total) * 1e6) / 1e6, 'the credits go down by what was charged');
});
