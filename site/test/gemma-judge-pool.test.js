// Several Gemma judge URLs (GEMMA_JUDGE_URL comma-separated): calls spread over the warm copies through the key pool,
// move to the next copy on 429/5xx/network, never wait on a cold copy, and one URL behaves exactly as before.
// A fake judge; nothing is called.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { judge, judgeCreds, judgeIsWarm, judgeUrls, gemmaMode, ping, resetGemmaJudge } from '../src/eden/gemma-judge.js';
import { resetPool, snapshot } from '../src/eden/key-pool.js';

const A = 'https://bilel--claim-judge-judge-web.modal.run';
const B = 'https://claim-judge-abc123-uc.a.run.app';
const realFetch = globalThis.fetch;

let calls; // { url, body, headers }
let mode; // per base URL: 'ok' | 503 | 429 | 400 | 'network' | 'hang' | 'cold' | 'slow'
let waits;
let release; // resolves 'slow' calls
const ctx = { waitUntil: (p) => waits.push(p) };
const CLAIMS = [{ id: '0', claim: 'Water boils at 100 C at sea level.', type: 'fact', evidence: ['It boils at 100 C at 1 atm.'] }];
const envOf = (url, more = {}) => ({ GEMMA_JUDGE_URL: url, GEMMA_JUDGE_KEY: 'wk-test', GEMMA_JUDGE_SECRET: 'ws-test', ...more });

beforeEach(() => {
  calls = [];
  waits = [];
  mode = {};
  let gate;
  const slow = new Promise((r) => (gate = r));
  release = gate;
  resetGemmaJudge();
  resetPool();
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const base = [A, B].find((b) => url.startsWith(b));
    if (!base) throw new Error(`unexpected fetch ${url}`);
    const path = new URL(url).pathname;
    calls.push({ url, base, path, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
    const m = mode[base] ?? 'ok';
    if (path === '/health') return Response.json(m === 'cold' ? { ok: true, loaded: false } : { ok: true, loaded: true });
    if (m === 'network') throw new TypeError('fetch failed');
    if (m === 'hang') return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'TimeoutError')), { once: true }));
    if (typeof m === 'number') return new Response('busy', { status: m });
    if (m === 'slow') await slow;
    const claims = JSON.parse(init.body).claims;
    return Response.json({ results: claims.map((c) => ({ id: c.id, verdict: 'supported', S: 0.99, C: 0.01 })), config: 'cfgsha' });
  };
});
after(() => {
  globalThis.fetch = realFetch;
});

const warmUp = async (env) => {
  ping(env, ctx);
  await Promise.all(waits.splice(0));
};
const judgeCalls = () => calls.filter((c) => c.path === '/judge');

test('one URL: exactly one POST to <url>/judge, as before; a 503 is returned, not retried', async () => {
  const env = envOf(`${A}/judge/`);
  assert.deepEqual(judgeUrls(env), [A]);
  const r = await judge(env, CLAIMS);
  assert.equal(r.ok, true);
  assert.equal(r.config, 'cfgsha');
  assert.deepEqual(judgeCalls().map((c) => c.url), [`${A}/judge`]);
  assert.deepEqual(judgeCalls()[0].body, { claims: CLAIMS, lazy_second: true });
  assert.equal(judgeCalls()[0].headers['Modal-Key'], 'wk-test');
  assert.equal(judgeIsWarm(env), true);
  mode[A] = 503;
  const bad = await judge(env, CLAIMS);
  assert.equal(bad.error, 'http_503');
  assert.equal(judgeCalls().length, 2);
  assert.equal(judgeIsWarm(env), false, 'a failing judge is cold again, as before');
});

test('several URLs: parsed from the comma list; blank entries ignored; no URL = judge off', () => {
  assert.deepEqual(judgeUrls(envOf(` ${A}/ , ${B}/judge ,, ${A}`)), [A, B]);
  assert.equal(judgeCreds(envOf(' , ')), false);
  assert.equal(gemmaMode(envOf(' , ', { GEMMA_JUDGE_MODE: 'owner' })), 'off');
  assert.equal(gemmaMode(envOf(`${A},${B}`, { GEMMA_JUDGE_MODE: 'owner' })), 'owner');
});

test('several warm URLs: calls are spread over both', async () => {
  const env = envOf(`${A},${B}`);
  await warmUp(env);
  assert.equal(calls.filter((c) => c.path === '/health').length, 2, 'each cold copy gets its own ping');
  let n = 0;
  resetPool({ rand: () => (n++ % 4 < 2 ? 0.1 : 0.9) }); // the first draw alternates A, B
  for (let i = 0; i < 10; i++) assert.equal((await judge(env, CLAIMS)).ok, true);
  const by = (b) => judgeCalls().filter((c) => c.base === b).length;
  assert.equal(by(A), 5);
  assert.equal(by(B), 5);
});

test('several warm URLs: a busy copy (call in flight) sends the next call to the other', async () => {
  const env = envOf(`${A},${B}`);
  await warmUp(env);
  resetPool({ rand: () => 0 }); // the first draw is always A
  mode[A] = 'slow';
  mode[B] = 'slow';
  const p1 = judge(env, CLAIMS);
  await new Promise((r) => setTimeout(r, 5));
  const p2 = judge(env, CLAIMS);
  await new Promise((r) => setTimeout(r, 5));
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.ok && r2.ok, true);
  assert.deepEqual(judgeCalls().map((c) => c.base), [A, B]);
});

test('failover: a 503, a 429 or a network error on one copy moves the call to the next; the bad copy goes cold', async () => {
  for (const bad of [503, 429, 'network']) {
    resetGemmaJudge();
    resetPool({ rand: () => 0 });
    calls = [];
    mode = { [A]: bad };
    const env = envOf(`${A},${B}`);
    await warmUp(env);
    const r = await judge(env, CLAIMS);
    assert.equal(r.ok, true, `answered after ${bad}`);
    assert.deepEqual(judgeCalls().map((c) => c.base), [A, B]);
    // A is cold now: the next call goes straight to B (the session's ping warms A again later)
    const r2 = await judge(env, CLAIMS);
    assert.equal(r2.ok, true);
    assert.deepEqual(judgeCalls().map((c) => c.base), [A, B, B]);
  }
});

test('every copy failing: the last answer is returned (EVES keeps its own verdict)', async () => {
  const env = envOf(`${A},${B}`);
  await warmUp(env);
  mode = { [A]: 503, [B]: 'network' };
  resetPool({ rand: () => 0 });
  const r = await judge(env, CLAIMS);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'http_503');
  assert.equal(judgeIsWarm(env), false);
});

test('a 400 is the request’s fault: no failover', async () => {
  const env = envOf(`${A},${B}`);
  await warmUp(env);
  resetPool({ rand: () => 0 });
  mode[A] = 400;
  const r = await judge(env, CLAIMS);
  assert.equal(r.error, 'http_400');
  assert.equal(judgeCalls().length, 1);
});

test('a cold copy never takes a call while another is warm; ping warms only the cold one', async () => {
  const env = envOf(`${A},${B}`);
  mode[B] = 'cold';
  await warmUp(env);
  assert.equal(judgeIsWarm(env), true);
  for (let i = 0; i < 6; i++) await judge(env, CLAIMS);
  assert.deepEqual([...new Set(judgeCalls().map((c) => c.base))], [A]);
  calls = [];
  ping(env, ctx); // B was pinged under a minute ago
  assert.equal(calls.length, 0);
});

test('the timeout covers the whole walk: a hanging copy is not followed by another', async () => {
  const env = envOf(`${A},${B}`);
  await warmUp(env);
  resetPool({ rand: () => 0 });
  mode[A] = 'hang';
  const t0 = Date.now();
  const keep = setTimeout(() => {}, 2_000); // AbortSignal.timeout's timer doesn't hold Node's event loop open
  const r = await judge(env, CLAIMS, undefined, 150, { coolOnTimeout: false });
  clearTimeout(keep);
  assert.equal(r.error, 'timeout');
  assert.ok(Date.now() - t0 < 1_000);
  assert.deepEqual(judgeCalls().map((c) => c.base), [A]);
  assert.equal(judgeIsWarm(env), true, 'a short caller budget does not cool the judge');
});

test('one URL, signal already aborted: "stopped" and cooled, as before (no call made)', async () => {
  const env = envOf(A);
  await warmUp(env);
  assert.equal(judgeIsWarm(env), true);
  const ctrl = new AbortController();
  ctrl.abort();
  const r = await judge(env, CLAIMS, ctrl.signal);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'stopped');
  assert.equal(judgeCalls().length, 0);
  assert.equal(judgeIsWarm(env), false);
});

test('KEY_POOL=off: the first URL first, the next only on failure', async () => {
  const env = envOf(`${A},${B}`, { KEY_POOL: 'off' });
  await warmUp(env);
  resetPool({ rand: () => 0.99 });
  for (let i = 0; i < 4; i++) await judge(env, CLAIMS);
  assert.deepEqual([...new Set(judgeCalls().map((c) => c.base))], [A]);
  mode[A] = 503;
  assert.equal((await judge(env, CLAIMS)).ok, true);
  assert.equal(judgeCalls().at(-1).base, B);
});

test('the pool view shows fingerprints of the judge URLs, never the URLs', async () => {
  const env = envOf(`${A},${B}`);
  await warmUp(env);
  await judge(env, CLAIMS);
  const snap = snapshot(env);
  const rows = snap.providers['gemma-judge'];
  assert.equal(rows.length, 2);
  assert.ok(rows.every((x) => x.kind === 'url' && /^[0-9a-f]{8}$/.test(x.fp)));
  const text = JSON.stringify(snap);
  assert.ok(!text.includes('modal.run') && !text.includes('run.app'));
});
