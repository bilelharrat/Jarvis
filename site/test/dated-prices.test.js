// Dated prices in charging (src/eden/dated-prices.js): Argon $4 / $20 from 2026-12-01 and 3.8 Flash $1.50 / $7.50 from
// 2027-01-01 (Pacific) in what an account is charged (providers.js usageUSD and fitCall, accounts/proxy.js priceOf, the
// Travel planner's table), the registry's cached share kept; model choice (ratesOf) untouched; the counter never scales
// a dated cost twice; DATED_PRICES=off goes back to the registry's one price.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { configureDatedPrices, chargePriceOn, datedCharging, datedModel, datedPair, priceOn, pricingDay, registryInput } from '../src/eden/dated-prices.js';
import { fitCall, modelOf, ratesOf, usageUSD } from '../src/eden/providers.js';
import { priceOf } from '../src/accounts/proxy.js';
import { googleCostUSD } from '../src/eden/credit-pacer.js';

const ms = (iso) => Date.parse(iso);
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const realNow = Date.now;
const at = (iso, fn) => {
  Date.now = () => ms(iso);
  try {
    return fn();
  } finally {
    Date.now = realNow;
  }
};
afterEach(() => {
  Date.now = realNow;
  configureDatedPrices({});
});

test('the table: Pacific days, the old price until the day before', () => {
  assert.equal(pricingDay(ms('2026-12-01T07:59:00Z')), '2026-11-30');
  assert.equal(pricingDay(ms('2026-12-01T08:00:00Z')), '2026-12-01');
  assert.equal(priceOn('gemini-4-argon', '2026-11-30').input, 2);
  assert.equal(priceOn('models/gemini-4-argon', '2026-12-01').output, 20);
  assert.equal(priceOn('gemini-3.8-flash', '2027-01-01').input, 1.5);
  assert.equal(priceOn('claude-opus-5-5', '2027-01-01'), null);
  assert.equal(registryInput('gemini-4-argon'), 2, 'the registry itself is untouched');
});

test('charging: usageUSD prices Argon and Flash by the call’s day, with the registry’s 10% cached share', () => {
  const argon = modelOf('gemini-4-argon');
  const u = { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000, reasoningTokens: 100_000 };
  // before: 600k × $2 + 400k × $0.20 (10%) + 200k × $10
  close(at('2026-11-30T20:00:00Z', () => usageUSD(argon, u)), 1.2 + 0.08 + 2);
  // from 1 Dec (Pacific): $4 / $0.40 / $20
  close(at('2026-12-01T09:00:00Z', () => usageUSD(argon, u)), 2.4 + 0.16 + 4);
  const flash = modelOf('gemini-3.8-flash');
  close(at('2027-01-01T20:00:00Z', () => usageUSD(flash, { inputTokens: 1_000_000, outputTokens: 1_000_000 })), 1.5 + 7.5);
  close(at('2026-12-31T20:00:00Z', () => usageUSD(flash, { inputTokens: 1_000_000, outputTokens: 1_000_000 })), 0.75 + 3.75);
  // another model: as it was
  const sonnet = modelOf('claude-sonnet-5-5');
  if (sonnet) close(at('2027-02-01T20:00:00Z', () => usageUSD(sonnet, { inputTokens: 1000 })), at('2026-11-01T20:00:00Z', () => usageUSD(sonnet, { inputTokens: 1000 })));
});

test('holds (fitCall) cover the call’s day’s price; model choice (ratesOf) and the registry object never change', () => {
  const argon = modelOf('gemini-4-argon');
  const req = { provider: 'gemini', params: { config: {} } };
  const before = at('2026-11-30T20:00:00Z', () => fitCall(argon, req, { leftUSD: Infinity, inputTokens: 100_000, maxTokens: 10_000 }));
  const after = at('2026-12-02T20:00:00Z', () => fitCall(argon, req, { leftUSD: Infinity, inputTokens: 100_000, maxTokens: 10_000 }));
  assert.ok(before && after);
  close(after.worstUSD, before.worstUSD * 2, 1e-6);
  assert.deepEqual(at('2026-12-02T20:00:00Z', () => ratesOf(argon)), [2, 10], 'what picks a model sees the registry as it is');
  assert.equal(argon.pricing.inputPer1M, 2, 'the shared registry object is never changed');
  assert.notEqual(at('2026-12-02T20:00:00Z', () => datedModel(argon)), argon);
  assert.equal(at('2026-11-02T20:00:00Z', () => datedModel(argon)), argon, 'the same object while nothing changed');
});

test('the Claude stand-in’s price (accounts/proxy.js priceOf) and the Travel planner’s table are dated too', () => {
  assert.deepEqual(at('2026-11-30T20:00:00Z', () => priceOf('gemini-4-argon')), [2, 10, 0.1]);
  assert.deepEqual(at('2026-12-02T20:00:00Z', () => priceOf('gemini-4-argon')), [4, 20, 0.1]);
  assert.deepEqual(at('2027-01-02T20:00:00Z', () => priceOf('gemini-3.8-flash')), [1.5, 7.5, 0.1]);
  assert.deepEqual(at('2027-01-02T20:00:00Z', () => priceOf('claude-opus-5-5')), [4, 20, 0.05], 'Claude: its own table, unchanged');
  assert.deepEqual(datedPair('gemini-4-argon', [2, 10], ms('2026-12-02T20:00:00Z')), [4, 20]);
  assert.deepEqual(datedPair('gpt-6.1-sol', [2, 10], ms('2026-12-02T20:00:00Z')), [2, 10]);
});

test('never scaled twice: the counter takes a dated charge as it is; DATED_PRICES=off goes back to one price (and the counter scales)', () => {
  assert.equal(datedCharging(), true);
  assert.equal(chargePriceOn('gemini-4-argon', ms('2026-12-02T20:00:00Z')), 4);
  const argon = modelOf('gemini-4-argon');
  const u = { inputTokens: 100_000, outputTokens: 10_000 };
  const charged = at('2026-12-02T20:00:00Z', () => usageUSD(argon, u)); // what the account paid
  close(googleCostUSD({ model: 'gemini-4-argon', usd: charged, at: ms('2026-12-02T20:00:00Z') }), charged);
  configureDatedPrices({ DATED_PRICES: 'off' });
  assert.equal(datedCharging(), false);
  const plain = at('2026-12-02T20:00:00Z', () => usageUSD(argon, u));
  close(plain, charged / 2);
  close(googleCostUSD({ model: 'gemini-4-argon', usd: plain, at: ms('2026-12-02T20:00:00Z') }), charged, 1e-6);
  assert.deepEqual(at('2026-12-02T20:00:00Z', () => priceOf('gemini-4-argon')), [2, 10, 0.1]);
  configureDatedPrices({ DATED_PRICES: 'on' });
  assert.equal(datedCharging(), true);
});

test('Help’s budget (help.js): the vendored worst case is scaled to the call day’s Flash price, once', async () => {
  const { datedScale } = await import('../src/eden/dated-prices.js');
  const { worstCaseUSD } = await import('../src/eden/vendor/help.js');
  const tableOut = worstCaseUSD({ model: 'gemini-3.8-flash', maxTokens: 1e6 }); // the vendored table's own output price
  assert.equal(tableOut, 3.75);
  const q = { model: 'gemini-3.8-flash', system: 'x'.repeat(3000), question: 'How do I share a chat?', history: [], images: 0, maxTokens: 700 };
  const worst = (iso) => worstCaseUSD(q) * datedScale('gemini-3.8-flash', worstCaseUSD({ model: 'gemini-3.8-flash', maxTokens: 1e6 }), ms(iso));
  close(worst('2026-12-31T20:00:00Z'), worstCaseUSD(q)); // 2026-12-31 Pacific: as before
  close(worst('2027-01-02T20:00:00Z'), 2 * worstCaseUSD(q)); // $1.50 / $7.50: twice
  assert.equal(datedScale('claude-haiku-4-5', 5, ms('2027-01-02T20:00:00Z')), 1, 'no dated price: as it is');
  assert.equal(datedScale('gemini-3.8-flash', 7.5, ms('2027-01-02T20:00:00Z')), 1, 'a table already at the new price is never scaled twice');
  assert.equal(datedScale('gemini-3.8-flash', 0, ms('2027-01-02T20:00:00Z')), 1);
  configureDatedPrices({ DATED_PRICES: 'off' });
  assert.equal(datedScale('gemini-3.8-flash', 3.75, ms('2027-01-02T20:00:00Z')), 1, 'DATED_PRICES=off: the one price');
});

// 2026-11-10: the vendored cost code (askeden src/dated-prices.ts) re-dated a price on UTC "now"; on 30 Nov after 4 pm
// Pacific (1 Dec in UTC) it would charge Argon's December price hours early. A model priced here carries `pricedOn`.
test('the evening of 30 Nov (Pacific) is still charged November’s price, whatever UTC day the vendored code sees', () => {
  const argon = modelOf('gemini-4-argon');
  const u = { inputTokens: 1_000_000, outputTokens: 0, reasoningTokens: 0 };
  const was = process.env.MODEL_ROUTER_AS_OF;
  process.env.MODEL_ROUTER_AS_OF = '2026-12-01'; // the vendored code's own clock: already 1 Dec in UTC
  try {
    close(at('2026-12-01T05:00:00Z', () => usageUSD(argon, u)), 2); // 30 Nov, 9 pm Pacific: $2 a million, not $4
    close(at('2026-12-01T09:00:00Z', () => usageUSD(argon, u)), 4); // 1 Dec, 1 am Pacific: the new price
  } finally {
    if (was === undefined) delete process.env.MODEL_ROUTER_AS_OF;
    else process.env.MODEL_ROUTER_AS_OF = was;
  }
});
