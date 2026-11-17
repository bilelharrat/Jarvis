// Units of src/eden/deepinfra-meter.js (switches, cost, max_tokens, the gate, settling) and src/eden/voice-cache.js
// (fixed phrases only, default off, a failing cache never loses the audio).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEEPINFRA_FALLBACK_USD,
  deepInfraCapped,
  deepInfraCharged,
  deepInfraCostUSD,
  deepInfraGate,
  deepInfraMetered,
  deepInfraSettle,
  inputEstimate,
  maxTokensFor,
  pricesOn,
  worstUSD,
} from '../src/eden/deepinfra-meter.js';
import { FIXED_VOICE_PHRASES, phraseCacheOn, phraseKey, voiceCached, voiceToCache } from '../src/eden/voice-cache.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const GEMMA = 'google/gemma-4-31B-it';

test('DeepInfra switches: metered on by default, charging and max_tokens off by default', () => {
  assert.equal(deepInfraMetered({}), true);
  assert.equal(deepInfraMetered({ DEEPINFRA_METERED: 'off' }), false);
  assert.equal(deepInfraCharged({}), false);
  assert.equal(deepInfraCharged({ DEEPINFRA_CHARGE: 'on' }), true);
  assert.equal(deepInfraCapped({}), false);
  assert.equal(deepInfraCapped({ DEEPINFRA_MAX_TOKENS: 'on' }), true);
  assert.equal(deepInfraCapped({ DEEPINFRA_CHARGE: 'on' }), true);
});

test('DeepInfra cost: its own estimated_cost, else tokens at the dated table, else the text seen', () => {
  assert.equal(deepInfraCostUSD(GEMMA, { prompt_tokens: 10, completion_tokens: 10, estimated_cost: 0.0123 }), 0.0123);
  const [pin, pout] = pricesOn(GEMMA);
  close(deepInfraCostUSD(GEMMA, { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 }), pin + pout);
  close(deepInfraCostUSD(GEMMA, null, { inputTokens: 1000, outputChars: 300 }), (1000 * pin + 100 * pout) / 1e6);
  assert.equal(deepInfraCostUSD(GEMMA, null), 0);
  assert.ok(pricesOn('unknown/model')[1] > 0, 'an unknown model is priced on the high side');
});

test('max_tokens: the model’s output limit, its context less the input, EDEN_MAX_TOKENS, and the money', () => {
  assert.equal(maxTokensFor(GEMMA, 1000), 16_384);
  assert.equal(maxTokensFor(GEMMA, 1000, { maxTokens: 4000 }), 4000);
  assert.equal(maxTokensFor('Qwen/Qwen2.5-Coder-32B-Instruct', 30_000), 32_768 - 30_000 - 256);
  assert.equal(maxTokensFor('Qwen/Qwen2.5-Coder-32B-Instruct', 32_500), null, 'no room for a reply');
  const [pin, pout] = pricesOn(GEMMA);
  const left = (1000 * pin + 2000 * pout) / 1e6;
  assert.equal(maxTokensFor(GEMMA, 1000, { leftUSD: left }), 2000);
  assert.equal(maxTokensFor(GEMMA, 1000, { leftUSD: 0 }), null);
  close(worstUSD(GEMMA, 1000, 2000), left);
  assert.equal(inputEstimate([{ content: 'abcdef' }, { content: '' }]), 2 + 8 + 8);
});

function fakeCall(answers) {
  const seen = [];
  const fn = async (env, account, op, body) => {
    seen.push({ op, body });
    const a = answers[op];
    return typeof a === 'function' ? a(body) : a;
  };
  fn.seen = seen;
  return fn;
}
const who = { account: 'acct', token: 'tok' };
const msgs = [{ role: 'user', content: 'x'.repeat(300) }];

test('the gate: allow-ai first, then a hold of the worst case; refusals the page shows', async () => {
  const ok = fakeCall({ 'allow-ai': { ok: true, bucket: 'trial', left: 0.5 }, 'hold-ai': (b) => ({ ok: true, bucket: 'trial', hold: 'h1', usd: b.usd }) });
  const g = await deepInfraGate({}, who, { call: ok, model: GEMMA, messages: msgs, maxTokens: 131072 });
  assert.equal(g.maxTokens, 16_384);
  assert.equal(g.hold.hold, 'h1');
  assert.equal(g.paid, false);
  assert.deepEqual(ok.seen.map((s) => s.op), ['allow-ai', 'hold-ai']);
  close(ok.seen[1].body.usd, worstUSD(GEMMA, g.input, 16_384));
  const none = fakeCall({ 'allow-ai': { ok: false, why: 'The free trial of Eden’s AI is used up.' } });
  await assert.rejects(deepInfraGate({}, who, { call: none, model: GEMMA, messages: msgs }), (e) => e.status === 402 && e.message === 'The free trial of Eden’s AI is used up.');
  const poor = fakeCall({ 'allow-ai': { ok: true, bucket: 'trial', left: 0 } });
  await assert.rejects(deepInfraGate({}, who, { call: poor, model: GEMMA, messages: msgs }), (e) => e.status === 402 && /private chat/.test(e.message));
  const huge = fakeCall({ 'allow-ai': { ok: true, bucket: 'trial', left: 5 } });
  await assert.rejects(deepInfraGate({}, who, { call: huge, model: 'Qwen/Qwen2.5-Coder-32B-Instruct', messages: [{ content: 'x'.repeat(120_000) }] }), (e) => e.status === 413);
  const plus = fakeCall({ 'allow-ai': { ok: true, bucket: 'plus', left: 5, plan_active: true }, 'hold-ai': { ok: true, bucket: 'plus', hold: 'h2' } });
  assert.equal((await deepInfraGate({}, who, { call: plus, model: GEMMA, messages: msgs })).paid, true);
});

test('settling: charged and released with a gate; logged only without; never throws', async () => {
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const c = fakeCall({ spend: { charged_usd: 0.001 }, 'release-ai': {} });
  const gate = { allow: { bucket: 'trial' }, hold: { bucket: 'trial', hold: 'h1' }, paid: false, input: 100 };
  assert.equal(deepInfraSettle({}, ctx, who, { call: c, model: GEMMA, usage: { estimated_cost: 0.001 }, gate }), 0.001);
  await Promise.all(waits);
  assert.deepEqual(c.seen.map((s) => s.op), ['spend', 'release-ai']);
  assert.equal(c.seen[0].body.usd, 0.001);
  assert.equal(c.seen[0].body.meta.feature, 'privacy');
  // a gated turn that answered but never said its size: the small fallback, never free
  const c2 = fakeCall({ spend: {}, 'release-ai': {} });
  assert.equal(deepInfraSettle({}, null, who, { call: c2, model: 'unknown/x', usage: null, inputTokens: 0, outputChars: 0, gate }), 0);
  assert.ok(DEEPINFRA_FALLBACK_USD > 0);
  // metering off and no gate: nothing
  const c3 = fakeCall({});
  assert.equal(deepInfraSettle({ DEEPINFRA_METERED: 'off' }, null, who, { call: c3, model: GEMMA, usage: { estimated_cost: 1 } }), 0);
  assert.equal(c3.seen.length, 0);
  // a call that throws: never out of here
  const bad = async () => { throw new Error('down'); };
  assert.equal(deepInfraSettle({}, null, who, { call: bad, model: GEMMA, usage: { estimated_cost: 0.002 }, gate }), 0.002);
});

test('voice cache: only Eden’s own fixed phrases, at the default speed, only with VOICE_PHRASE_CACHE=on', async () => {
  const phrase = [...FIXED_VOICE_PHRASES][0];
  assert.equal(phraseCacheOn({}), false);
  assert.equal(await phraseKey({}, { text: phrase, format: 'wav' }), null, 'off by default');
  const on = { VOICE_PHRASE_CACHE: 'on' };
  const k = await phraseKey(on, { text: phrase, format: 'wav', voiceId: 'v' });
  assert.match(k, /^https:\/\/voice-cache\.askeden\.invalid\/v1\/[0-9a-f]{64}$/);
  assert.ok(!k.includes('Sorry'), 'the key is a hash');
  assert.notEqual(await phraseKey(on, { text: phrase, format: 'pcm', voiceId: 'v' }), k, 'each format its own');
  assert.notEqual(await phraseKey({ ...on, FISH_MODEL: 'other' }, { text: phrase, format: 'wav', voiceId: 'v' }), k, 'a new voice model: new audio');
  assert.equal(await phraseKey(on, { text: 'Anything a person typed', format: 'wav' }), null);
  assert.equal(await phraseKey(on, { text: phrase, format: 'wav', speed: 1.3 }), null, 'another speed: not cached');
  assert.notEqual(await phraseKey(on, { text: phrase, format: 'wav', speed: '1', voiceId: 'v' }), null);
});

test('voice cache: put then match gives the same bytes; a cache that throws never loses the audio', async () => {
  const phrase = [...FIXED_VOICE_PHRASES][1];
  const on = { VOICE_PHRASE_CACHE: 'on' };
  const store = new Map();
  const cache = { match: async (k) => store.get(k)?.clone(), put: async (k, r) => { store.set(k, r); } };
  const fish = new Response(new Uint8Array([1, 2, 3]));
  const first = await voiceToCache(on, fish, { text: phrase, format: 'pcm', cache });
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), new Uint8Array([1, 2, 3]));
  const hit = await voiceCached(on, { text: phrase, format: 'pcm', cache });
  assert.deepEqual(new Uint8Array(await hit.arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.equal(hit.headers.get('content-type'), 'application/octet-stream');
  assert.equal(await voiceCached(on, { text: 'not fixed', format: 'pcm', cache }), null);
  assert.equal(await voiceToCache(on, new Response('x'), { text: 'not fixed', format: 'pcm', cache }), null, 'not fixed: the caller streams as before');
  const broken = { match: async () => { throw new Error('down'); }, put: async () => { throw new Error('down'); } };
  assert.equal(await voiceCached(on, { text: phrase, format: 'pcm', cache: broken }), null);
  const kept = await voiceToCache(on, new Response(new Uint8Array([9])), { text: phrase, format: 'wav', cache: broken });
  assert.deepEqual(new Uint8Array(await kept.arrayBuffer()), new Uint8Array([9]));
  assert.equal(kept.headers.get('content-type'), 'audio/wav');
  assert.equal(await voiceCached(on, { text: phrase, format: 'pcm', cache: null }), null, 'no cache here (tests, local): nothing');
});
