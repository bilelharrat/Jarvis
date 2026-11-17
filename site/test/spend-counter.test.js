// The company spend counter (src/eden/spend-counter.js): every provider but Google on its own day records, paid and
// unpaid, behind CREDIT_PACER; optional unpaid caps per provider (SPEND_CAP_<PROVIDER>_USD); Maps only read from
// travel/spend.js; never a throw, never a wait on a counter that is down. Fake Durable Objects throughout.
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { VoiceQuota } from '../src/worker.js';
import { Account } from '../src/accounts/account.js';
import { COUNTER_OBJECT, meterGoogle, pacificParts, resetPacerCache } from '../src/eden/credit-pacer.js';
import {
  PROVIDERS,
  SPEND_COPY,
  capFor,
  companySpendStatus,
  fishCostUSD,
  meterProvider,
  modalCostUSD,
  providerCapCheck,
  providersCapCheck,
  providerCostUSD,
  providerFull,
  providerId,
  resetSpendCache,
} from '../src/eden/spend-counter.js';
import { COLD_PING_MS, mayWake, meterJudge, shadowCapped, shadowMayWake } from '../src/eden/gemma-spend.js';
import { namespace } from './fakes.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

function envWith(extra = {}) {
  const e = { ...extra };
  const ns = namespace(VoiceQuota, e);
  const seen = [];
  e.VOICE_QUOTA = {
    objects: ns.objects,
    seen,
    idFromName: ns.idFromName,
    get(name) {
      const stub = ns.get(name);
      return { fetch: (input, init) => { seen.push({ name, url: String(input) }); return stub.fetch(input, init); } };
    },
  };
  e.ACCOUNTS = namespace(Account, e);
  return e;
}
const broken = () => ({ idFromName: (n) => n, get: () => ({ fetch: async () => { throw new Error('counter down'); } }) });
const waitsCtx = () => {
  const waits = [];
  return { waits, ctx: { waitUntil: (p) => waits.push(p) } };
};

beforeEach(() => {
  resetPacerCache();
  resetSpendCache();
});

test('which provider: by name (aliases folded), else by model; Google and Maps are never this counter’s own', () => {
  assert.equal(providerId('gemini'), 'google');
  assert.equal(providerId('vertex'), 'google');
  assert.equal(providerId('kimi'), 'moonshot');
  assert.equal(providerId('anthropic'), 'anthropic');
  assert.equal(providerId('deepinfra'), 'deepinfra');
  assert.equal(providerId(null, 'claude-haiku-4-5'), 'anthropic');
  assert.equal(providerId(null, 'gpt-6.1-sol'), 'openai');
  assert.equal(providerId(null, 'kimi-k3'), 'moonshot');
  assert.equal(providerId(null, 'sonar-pro'), 'perplexity');
  assert.equal(providerId(null, 'models/gemini-3.8-flash'), 'google');
  assert.equal(providerId(null, 'mystery'), 'other');
  assert.equal(providerId('Not A Provider!'), 'other');
  assert.deepEqual(PROVIDERS.map((p) => p.id), ['google', 'anthropic', 'openai', 'moonshot', 'perplexity', 'deepinfra', 'fish', 'modal', 'maps']);
});

test('costs: the path’s dollars, else its tokens at the registry’s price; Fish per byte; Modal’s GPU estimate', () => {
  assert.equal(providerCostUSD({ usd: 0.25 }), 0.25);
  // Claude Haiku 4.5 at $1 / $5: 1000 in (100 of them cached at 10%), 1000 out
  close(providerCostUSD({ model: 'claude-haiku-4-5', usage: { inputTokens: 1000, cachedInputTokens: 100, outputTokens: 1000 } }), (900 + 10) / 1e6 + 5000 / 1e6);
  assert.equal(providerCostUSD({ model: 'no-such-model', usage: { inputTokens: 1000 } }), 0);
  assert.equal(providerCostUSD({}), 0);
  close(fishCostUSD('hello'), (5 * 15) / 1e6);
  close(fishCostUSD('é'), (2 * 15) / 1e6); // UTF-8 bytes, not characters
  close(modalCostUSD({ ms: 2000 }), 2 * 0.000694);
  close(modalCostUSD({ woke: true }), 360 * 0.000694);
  assert.equal(modalCostUSD({}), 0);
});

test('off (the default): nothing is counted and no counter object is ever made', async () => {
  const env = envWith();
  assert.equal(meterProvider(env, null, { provider: 'anthropic', usd: 1 }), null);
  assert.equal(meterGoogle(env, null, { provider: 'openai', usd: 1 }), null);
  assert.equal(env.VOICE_QUOTA.seen.length, 0);
  assert.deepEqual(await providerFull(env, 'anthropic'), { full: false, retryAfter: null });
  const s = await companySpendStatus(env);
  assert.equal(s.mode, 'off');
  assert.deepEqual(s.providers, []);
  assert.equal(env.VOICE_QUOTA.seen.length, 0);
});

test('warn: every other provider is counted on its own day record, paid or unpaid, after the reply; Google stays the pacer’s', async () => {
  const env = envWith({ CREDIT_PACER: 'warn' });
  const { waits, ctx } = waitsCtx();
  meterGoogle(env, ctx, { provider: 'anthropic', model: 'claude-haiku-4-5', usd: 0.5, bucket: 'trial', feature: 'chat' }); // handed on by the pacer
  meterGoogle(env, ctx, { provider: 'openai', usd: 0.25, bucket: 'plus', feature: 'chat' }); // a paid bucket
  meterProvider(env, ctx, { provider: 'deepinfra', usd: 0.01, paid: false, feature: 'privacy' });
  meterProvider(env, ctx, { provider: 'fish', usd: fishCostUSD('Hi there'), feature: 'chat-voice' });
  meterProvider(env, ctx, { provider: 'gemini', usd: 1 }); // Google: never here
  meterProvider(env, ctx, { provider: 'maps', usd: 1 }); // Maps: travel/spend.js's
  meterProvider(env, ctx, { provider: 'anthropic', usd: 0 }); // nothing spent: nothing sent
  assert.equal(waits.length, 4);
  await Promise.all(waits);
  const s = await companySpendStatus(env);
  const by = Object.fromEntries(s.providers.map((p) => [p.id, p]));
  close(by.anthropic.unpaidUSD, 0.5);
  assert.equal(by.anthropic.paidUSD, 0);
  close(by.anthropic.byFeature['unpaid:chat'], 0.5);
  close(by.openai.paidUSD, 0.25);
  close(by.deepinfra.unpaidUSD, 0.01);
  assert.ok(by.fish.unpaidUSD > 0);
  assert.match(by.fish.note, /list price/);
  assert.equal(by.google.totalUSD, 0, 'the pacer’s own day: nothing Google was sent');
  assert.equal(by.anthropic.level, 'no-cap');
  assert.equal(s.unpaidTodayUSD, 0, 'nothing reached the credits’ counter');
  assert.ok(env.VOICE_QUOTA.objects.get(COUNTER_OBJECT), 'kept in the pacer’s own object');
});

test('the counter refuses what isn’t its own: Google and Maps, bad dollars, bad days', async () => {
  const env = envWith({ CREDIT_PACER: 'warn' });
  const post = (path, body) => env.VOICE_QUOTA.get(COUNTER_OBJECT).fetch(`https://credit-pacer${path}`, { method: 'POST', body: JSON.stringify(body) });
  const day = pacificParts(Date.now()).day;
  assert.equal((await post('/spend', { day, provider: 'google', usd: 1 })).status, 400);
  assert.equal((await post('/spend', { day, provider: 'maps', usd: 1 })).status, 400);
  assert.equal((await post('/spend', { day, provider: 'anthropic', usd: -1 })).status, 400);
  assert.equal((await post('/spend', { day: '2026-02-31', provider: 'anthropic', usd: 1 })).status, 400);
  assert.equal((await post('/spend-status', { day: 'nope' })).status, 400);
  const ok = await (await post('/spend', { day, provider: 'anthropic', usd: 1, paid: true, feature: 'x' })).json();
  assert.deepEqual(ok.providers.anthropic, { paid: 1, unpaid: 0, calls: 1, by: { 'paid:x': 1 } });
  // the pacer's own requests still work through the same object
  assert.equal((await post('/status', { today: day })).status, 200);
});

test('caps: SPEND_CAP_<PROVIDER>_USD refuses unpaid use once reached (on only); paid, warn, no cap, “allow today” and Google never are', async () => {
  assert.equal(capFor({ SPEND_CAP_ANTHROPIC_USD: '2' }, 'anthropic'), 2);
  assert.equal(capFor({ SPEND_CAP_ANTHROPIC_USD: '' }, 'anthropic'), null);
  assert.equal(capFor({ SPEND_CAP_ANTHROPIC_USD: 'x' }, 'anthropic'), null);
  assert.equal(capFor({ SPEND_CAP_GOOGLE_USD: '1' }, 'google'), null, 'Google keeps the credit pacing rule');
  const env = envWith({ CREDIT_PACER: 'on', SPEND_CAP_ANTHROPIC_USD: '1', SPEND_CAP_DEEPINFRA_USD: '0' });
  assert.equal((await providerFull(env, 'anthropic')).full, false);
  await meterProvider(env, null, { provider: 'anthropic', usd: 0.7, paid: false });
  let s = await companySpendStatus(env);
  assert.equal(s.providers.find((p) => p.id === 'anthropic').level, 'amber');
  await meterProvider(env, null, { provider: 'anthropic', usd: 0.3, paid: false });
  const full = await providerFull(env, 'anthropic');
  assert.equal(full.full, true);
  assert.ok(full.retryAfter >= 60);
  await assert.rejects(providerCapCheck(env, 'anthropic'), (e) => e.status === 402 && e.code === 'no_allowance' && e.message === SPEND_COPY.model);
  await assert.rejects(providerCapCheck(env, 'deepinfra', { copy: SPEND_COPY.privacy }), (e) => e.message === SPEND_COPY.privacy, 'a cap of $0: no free use at all');
  assert.equal((await providerFull(env, 'anthropic', { paid: true })).full, false, 'paid: never');
  assert.equal((await providerFull(env, 'anthropic', { paid: async () => true })).full, false, 'paid (asked only when full): never');
  assert.equal((await providerFull(env, 'openai')).full, false, 'no cap set');
  assert.equal((await providerFull(env, 'gemini')).full, false, 'Google: the credit pacer decides');
  assert.equal((await providerFull({ ...env, CREDIT_PACER: 'warn' }, 'anthropic')).full, false, 'warn: counted only');
  assert.equal((await providerFull({ ...env, CREDIT_ALLOW_DAY: pacificParts(Date.now()).day }, 'anthropic')).full, false, 'allow today');
  s = await companySpendStatus(env);
  assert.equal(s.providers.find((p) => p.id === 'anthropic').level, 'red');
  assert.equal(s.providers.find((p) => p.id === 'anthropic').capUSD, 1);
});

test('fail open: a counter that is down never throws, never refuses, and /admin says it couldn’t read it', async () => {
  const env = { CREDIT_PACER: 'on', SPEND_CAP_ANTHROPIC_USD: '0', VOICE_QUOTA: broken() };
  const work = meterProvider(env, null, { provider: 'anthropic', usd: 1 });
  await work; // logged, not thrown
  assert.deepEqual(await providerFull(env, 'anthropic'), { full: false, retryAfter: null });
  await providerCapCheck(env, 'anthropic'); // no throw
  const s = await companySpendStatus(env);
  assert.equal(s.providers.find((p) => p.id === 'anthropic').level, 'failed');
  assert.equal(s.providers.find((p) => p.id === 'maps').level, 'no-cap', 'no ACCOUNTS binding: Maps not set up here');
});

test('/admin’s list: Google from the pacer, Maps read from travel/spend.js’s own counter (UTC day), Modal marked an estimate', async () => {
  const env = envWith({ CREDIT_PACER: 'on' });
  await meterGoogle(env, null, { provider: 'gemini', model: 'gemini-3.8-flash', usd: 0.4, paid: false, feature: 'chat' });
  const utc = new Date().toISOString().slice(0, 10);
  const g = env.ACCOUNTS.get('tspend:global');
  const took = await (await g.fetch('https://account/tspend-take', { method: 'POST', body: JSON.stringify({ day: utc, sku: 'details_pro', n: 10, cap: 20 }) })).json();
  assert.equal(took.ok, true);
  meterJudge(env, null, { woke: true, feature: 'gemma-wake' });
  await new Promise((r) => setTimeout(r, 20));
  const s = await companySpendStatus(env);
  const by = Object.fromEntries(s.providers.map((p) => [p.id, p]));
  close(by.google.unpaidUSD, 0.4);
  assert.equal(by.google.capUSD, s.allowanceUSD);
  close(by.maps.totalUSD, 0.17);
  assert.match(by.maps.note, /UTC day/);
  close(by.modal.unpaidUSD, 360 * 0.000694);
  assert.match(by.modal.note, /estimate/);
});

test('Gemma: shadow turns may wake the judge only with GEMMA_SHADOW_WAKE=on; owner turns always; the Modal cap stops shadow only', async () => {
  assert.equal(shadowMayWake({}), false);
  assert.equal(shadowMayWake({ GEMMA_SHADOW_WAKE: 'on' }), true);
  assert.equal(mayWake({}, true), true);
  assert.equal(mayWake({}, false), false);
  assert.equal(mayWake({ GEMMA_SHADOW_WAKE: 'ON ' }, false), true);
  assert.ok(COLD_PING_MS >= 5000);
  const env = envWith({ CREDIT_PACER: 'on', SPEND_CAP_MODAL_USD: '0.2' });
  assert.equal(await shadowCapped(env), false);
  meterJudge(env, null, { woke: true });
  await new Promise((r) => setTimeout(r, 20));
  resetSpendCache();
  assert.equal(await shadowCapped(env), true, 'one wake ($0.25) is past a $0.20 cap');
  assert.equal(await shadowCapped({ ...env, CREDIT_PACER: 'warn' }), false);
});

test('providersCapCheck: every provider a turn may call, aliases folded, each asked once; refuses if any is full', async () => {
  const env = envWith({ CREDIT_PACER: 'on', SPEND_CAP_PERPLEXITY_USD: '0.5' });
  await providersCapCheck(env, ['openai', 'gemini', 'perplexity', null]); // nothing spent yet
  await meterProvider(env, null, { provider: 'perplexity', usd: 0.5, paid: false });
  resetSpendCache();
  await assert.rejects(providersCapCheck(env, ['gemini', 'openai', 'perplexity']), (e) => e.status === 402 && e.message === SPEND_COPY.model);
  await providersCapCheck(env, ['gemini', 'openai', 'perplexity'], { paid: true }); // paid: never
  await providersCapCheck(env, ['gemini', 'kimi', 'claude']); // none of them capped
  await providersCapCheck({ ...env, CREDIT_PACER: 'warn' }, ['perplexity']); // warn: counted only
  assert.match(SPEND_COPY.voice, /voice is full for today/);
});
