// Model Router in the backend (src/jarvis/features/_router_worker.cjs, for messages from the
// phones and the local API): parity with the window. The real router bundle runs both in a
// stand-in Eden Code window (web/features/code-router.js, as the composer sends a message)
// and in the worker, with the same models, prefs and model_router_state; for a set of
// prompts, levels, per-project levels, the budget's lean, providers left out, Claude down and
// Shadow mode, the route is the same. Then the window's answer to the backend's ask, and the
// worker's Gemini rating through the backend (a failure: the rules' pick, and a pause).
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { makeWorker, loadLib } = require('../../src/jarvis/features/_router_worker.cjs');
const SOURCE = readFileSync(new URL('../../src/jarvis/web/features/code-router.js', import.meta.url), 'utf8');
const LIB = loadLib();

const PICKER = [
  { ref: 'opus', model: 'claude-opus-5-5', builtin: true, kind: 'builtin', label: 'Opus 5.5' },
  { ref: 'sonnet', model: 'claude-sonnet-5-5', builtin: true, kind: 'builtin', label: 'Sonnet 5.5' },
  { ref: 'haiku', model: 'claude-haiku-4-5', builtin: true, kind: 'builtin', label: 'Haiku 4.5' },
  { ref: 'custom:o1', model: 'gpt-6-luna', builtin: false, kind: 'openai', label: 'GPT-6 Luna' },
  { ref: 'custom:g1', model: 'gemini-3.8-flash', builtin: false, kind: 'gemini', label: 'Gemini 3.8 Flash' },
  { ref: 'eden:kimi-k3', model: 'kimi-k3', builtin: false, kind: 'openai', needs_key: true },
];
const PROMPTS = [
  'rename foo to bar in utils.py',
  'Refactor the whole authentication module to use dependency injection, then add integration tests for every endpoint and fix whatever fails.',
  'Why does this regex not match unicode letters? /^[a-z]+$/i',
  'Write a design doc comparing three caching strategies for our API gateway, with trade-offs, failure modes and a migration plan.',
  'go ahead',
  '把这个函数改成异步的，并且补上单元测试',
];
const TASK = { id: 7, model: 'claude-opus-5-5', effort: 'high' };

// The window as Eden Code runs it, with the real bundle: what its composer sends.
function standIn(features, modelList = PICKER) {
  const handlers = {};
  const sent = [];
  const reg = {};
  const els = {};
  const F = {
    $: (id) => (els[id] ||= { id, after() {}, hidden: false, textContent: '', title: '' }),
    send: (m) => { sent.push(m); return true; },
    on: (type, fn) => { (handlers[type] ||= []).push(fn); },
    t: (x) => x,
    currentTask: () => TASK,
    registerSessionOption: (fn) => { reg.session = fn; },
    registerSendOption: (fn) => { reg.send = fn; },
    registerModelChoice: () => {},
    registerComposerRender: (fn) => { reg.render = fn; },
    openPane() {},
  };
  const window = { jarvisFeatures: F, crypto: globalThis.crypto };
  const chip = { hidden: true, setAttribute() {}, addEventListener() {}, refresh() {}, applySettings() {}, pending: () => null };
  const document = {
    head: { append: (s) => { window.ModelRouterLib = LIB; queueMicrotask(() => s.onload()); } },
    createElement: (tag) => (tag === 'script' ? {} : chip),
  };
  const customElements = { get: () => class { static adapter = null; } };
  const prefs = { features };
  new Function('window', 'document', 'customElements', 'modelList', 'prefs', 'jcNote', 'renderComposer', 'ICON_PATHS', SOURCE)(
    window, document, customElements, modelList, prefs, () => {}, () => reg.render && reg.render({ t: TASK, label: 'Opus 5.5' }), {},
  );
  const fire = (type, ev) => { for (const fn of handlers[type] || []) fn(ev); };
  const ready = async () => {
    reg.render({ t: TASK, label: 'Opus 5.5' });
    reg.send(TASK, 'warm up');  // (in Shadow mode the bundle loads with the first message)
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return { sent, reg, fire, ready };
}

const STATE = {
  sessions: { 7: { project: 'abcdefabcdef', contextTokens: 42000 } },
  agenticCallsPerTurn: 6,
  quota: { used: 0.55 },
  budget: { usd: 20, spentUSD: 18, fraction: 0.9, boost: 20 },
  learned: { on: true, updated: 'u1', overrides: {} },
};
const CASES = [
  { name: 'Model Router chosen, the rules', features: { code_router_on: true, code_router_settings: { classifier: 'off' } } },
  { name: 'cheap and fast', features: { code_router_on: true, code_router_settings: { classifier: 'off', efficiency: 90, performance: 10 } } },
  { name: 'best quality, Claude as API dollars', features: { code_router_on: true, code_router_settings: { classifier: 'off', efficiency: 5, performance: 95, subscriptionClaude: false } } },
  { name: 'a project’s own levels', features: { code_router_on: true, code_router_settings: { classifier: 'off' }, code_router_projects: { abcdefabcdef: { efficiency: 85, performance: 30 } } } },
  { name: 'providers left out', features: { code_router_on: true, code_router_settings: { classifier: 'off' }, code_router_providers_off: ['openai'] } },
  { name: 'Shadow mode by default', features: { code_router_on: false } },
  { name: 'Shadow with Model Router chosen', features: { code_router_on: true, code_router_settings: { shadow: true } } },
  { name: 'Claude can’t answer', features: { code_router_on: true, code_router_settings: { classifier: 'off' } }, claude: { down: true, until: Date.now() + 3_600_000 } },
  { name: 'Gemini on, the message unrated', features: { code_router_on: true } },
];

for (const c of CASES) {
  test(`parity with the window: ${c.name}`, async () => {
    const w = standIn(c.features);
    await w.ready();
    w.fire('model_router_state', STATE);
    if (c.claude) w.fire('model_router_claude', c.claude);
    const worker = makeWorker({ lib: LIB, write: () => assert.fail('no rating here') });
    for (const text of PROMPTS) {
      const fromWindow = w.reg.send(TASK, text).route || null;
      const input = { text, task: TASK, picker: PICKER, features: c.features, state: STATE, claude: c.claude || { down: false, until: 0 }, rate: false };
      const fromWorker = (await worker.route(input)).route;
      assert.deepEqual(fromWorker, fromWindow, `${c.name}: ${text}`);
    }
  });
}

test('off: no route from either', async () => {
  const features = { code_router_on: false, code_router_shadow: false };
  const w = standIn(features);
  await w.ready();
  assert.deepEqual(w.reg.send(TASK, PROMPTS[1]), {});
  const worker = makeWorker({ lib: LIB });
  assert.deepEqual(await worker.route({ text: PROMPTS[1], task: TASK, picker: PICKER, features }), { route: null, rated: false });
  assert.deepEqual(await worker.route({ text: '  ', picker: PICKER, features: { code_router_on: true } }), { route: null, rated: false });
});

test('a new session (no task): the same pick as the window’s to-do cards', async () => {
  const features = { code_router_on: true, code_router_settings: { classifier: 'off' } };
  const w = standIn(features);
  await w.ready();
  w.fire('model_router_state', STATE);
  const worker = makeWorker({ lib: LIB });
  for (const text of PROMPTS) {
    const fromWorker = (await worker.route({ text, task: null, picker: PICKER, features, state: STATE, rate: false })).route;
    const card = w.reg.session(text).route || null;  // (the window's task_new route)
    assert.deepEqual(fromWorker, card, text);
  }
});

test('the window answers the backend’s ask with the pick it would make', async () => {
  const features = { code_router_on: true, code_router_settings: { classifier: 'off' } };
  const w = standIn(features);
  await w.ready();
  w.fire('model_router_state', STATE);
  const worker = makeWorker({ lib: LIB });
  w.fire('model_router_ask', { rid: 'ra1', text: PROMPTS[1], task: TASK, rate: true });
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  const answer = w.sent.find((m) => m.type === 'model_router_answer' && m.rid === 'ra1');
  assert.equal(answer.final, true);
  const expected = (await worker.route({ text: PROMPTS[1], task: TASK, picker: PICKER, features, state: STATE })).route;
  assert.deepEqual(answer.route, expected);
  // Shadow: a Shadow route; nothing typed: no route.
  w.fire('prefs', { features: { code_router_on: false } });
  w.fire('model_router_ask', { rid: 'ra2', text: PROMPTS[1], task: TASK });
  w.fire('model_router_ask', { rid: 'ra3', text: ' ' });
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  assert.equal(w.sent.find((m) => m.rid === 'ra2').route.shadow, true);
  assert.deepEqual(w.sent.find((m) => m.rid === 'ra3'), { type: 'model_router_answer', rid: 'ra3', final: true });
});

test('the worker’s rating goes through the backend; a failure leaves the rules’ pick and pauses Gemini', async () => {
  const out = [];
  let worker;
  const write = (msg) => {
    out.push(msg);
    if (msg.op === 'classify') queueMicrotask(() => worker.handle({ op: 'classified', rid: msg.rid, status: 401, body: '{"error":{"message":"no key"}}' }));
  };
  worker = makeWorker({ lib: LIB, write });
  const features = { code_router_on: true };  // (Gemini rates by default)
  const input = { text: PROMPTS[1], task: TASK, picker: PICKER, features, state: STATE, rate: true };
  const rules = (await makeWorker({ lib: LIB }).route({ ...input, rate: false })).route;
  const first = await worker.route(input);
  const asked = out.filter((m) => m.op === 'classify');
  assert.equal(asked.length, 1);
  assert.match(asked[0].model, /^gemini-/);
  assert.ok(asked[0].body && asked[0].body.contents, 'the router’s own request');
  assert.deepEqual(first, { route: rules, rated: false });
  // No key: not asked again for a while.
  await worker.route(input);
  assert.equal(out.filter((m) => m.op === 'classify').length, 1);
  // Through the line protocol: an answer with the request's id.
  await worker.handle({ id: 9, op: 'route', input: { ...input, rate: false } });
  assert.deepEqual(out.at(-1), { id: 9, ok: true, route: rules, rated: false });
});
