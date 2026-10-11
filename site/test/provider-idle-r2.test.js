// A provider that goes silent (askeden bug sweep round 2, AC2-1): askeden.com's own `: ping` kept the page's idle limit
// happy while a hung provider held the turn open forever. streamCall now fails a call that sends nothing for
// PROVIDER_IDLE.ms (headers or body), so the turn ends with an error or falls back. Fake fetch; nothing is called.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { PROVIDER_IDLE, modelOf, streamCall } from '../src/eden/providers.js';

const realFetch = globalThis.fetch;
const saved = PROVIDER_IDLE.ms;
afterEach(() => { globalThis.fetch = realFetch; PROVIDER_IDLE.ms = saved; });

const LUNA = 'gpt-6-luna';
const request = { provider: 'openai', params: { model: LUNA, max_completion_tokens: 4000, reasoning_effort: 'medium' } };
const call = (signal = new AbortController().signal, events = []) => streamCall({ model: modelOf(LUNA), request, messages: [{ role: 'user', content: 'hi' }], key: 'sk-test' }, { signal, emit: (t, d) => events.push([t, d]) });
/** A response that sends `first` and then nothing, until the request is aborted. */
const stalling = (first) => async (_url, init) => {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(c) {
      if (first) c.enqueue(enc.encode(first));
      init.signal.addEventListener('abort', () => { try { c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })); } catch { /* closed */ } }, { once: true });
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

test('AC2-1: a provider that stops mid-stream fails after the idle limit, keeping what it wrote', async () => {
  PROVIDER_IDLE.ms = 150;
  globalThis.fetch = stalling(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] })}\n\n`);
  const events = [];
  const t0 = Date.now();
  const r = await call(undefined, events);
  assert.ok(Date.now() - t0 < 3000);
  assert.match(r.failure, /stopped answering/);
  assert.equal(r.stopped, false);
  assert.equal(r.text, 'Hel');
  assert.deepEqual(events, [['text', { text: 'Hel' }]]);
});

test('AC2-1: a provider that never answers the request fails too; Stop is still a stop, not a failure', async () => {
  PROVIDER_IDLE.ms = 150;
  globalThis.fetch = (_url, init) => new Promise((_r, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }));
  const r = await call();
  assert.match(r.failure, /stopped answering/);
  PROVIDER_IDLE.ms = 5000;
  globalThis.fetch = stalling('');
  const ctrl = new AbortController();
  const p = call(ctrl.signal);
  setTimeout(() => ctrl.abort(), 30);
  const s = await p;
  assert.equal(s.stopped, true);
  assert.equal(s.failure, null);
});

test('AC2-1: a slow but steady stream is never cut off', async () => {
  PROVIDER_IDLE.ms = 150;
  globalThis.fetch = async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream({
      async start(c) {
        for (const w of ['a', 'b', 'c', 'd', 'e']) { await new Promise((r) => setTimeout(r, 80)); c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: w } }] })}\n\n`)); }
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    return new Response(body, { status: 200 });
  };
  const r = await call();
  assert.equal(r.failure, null);
  assert.equal(r.text, 'abcde');
});
