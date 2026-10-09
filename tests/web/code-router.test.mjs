// Model Router in Eden Code's composer (web/features/code-router.js), its pure helpers:
// which of the picker's models it routes among, at which efforts (the relays' models too),
// and a pick as a session takes it; when a message waits for Gemini's rating (route_wait,
// never for a trivial one) and the route it then gets; how long Gemini's problems pause the
// asking; what Jarvis knows of the session for the route; what the log keeps; and the
// feature in a stand-in window (Shadow mode, learned overrides, the adapter's calls,
// per-project levels, the budget). node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const R = require('../../src/jarvis/web/features/code-router.js');

const MODELS = [
  { ref: 'opus', model: 'claude-opus-5-5', builtin: true },
  { ref: 'haiku', model: 'claude-haiku-4-5', builtin: true },
  { ref: 'custom:a1', model: 'gpt-6-luna', builtin: false },
  { ref: 'custom:a2', model: 'gpt-6-luna', builtin: false },  // (the same model twice: the first)
  { ref: 'custom:b1', model: 'gemini-3.6-flash', builtin: false },
  { ref: '', model: 'nothing' },
];

test('the picker’s models, each once, with a ref', () => {
  assert.deepEqual(R.routable(MODELS).map((m) => m.ref), ['opus', 'haiku', 'custom:a1', 'custom:b1']);
  assert.deepEqual(R.routable(null), []);
});

test('Claude at the efforts a session takes; the rest at their own default', () => {
  const efforts = R.effortsFor(MODELS);
  assert.deepEqual(efforts({ id: 'claude-opus-5-5', defaultEffort: 'medium' }), R.CLAUDE_EFFORTS);
  assert.deepEqual(efforts({ id: 'gpt-6-luna', defaultEffort: 'medium' }), ['medium']);
  assert.deepEqual(efforts({ id: 'gemini-3.6-flash', defaultEffort: 'high' }), ['high']);
});

test('a pick as a session takes it: the ref, and an effort only for Claude', () => {
  assert.deepEqual(R.routeFor(MODELS, { model: 'claude-opus-5-5', effort: 'high' }), { ref: 'opus', model: 'claude-opus-5-5', effort: 'high' });
  assert.deepEqual(R.routeFor(MODELS, { model: 'claude-haiku-4-5', effort: 'none' }), { ref: 'haiku', model: 'claude-haiku-4-5' });
  assert.deepEqual(R.routeFor(MODELS, { model: 'gpt-6-luna', effort: 'medium' }), { ref: 'custom:a1', model: 'gpt-6-luna' });
  assert.equal(R.routeFor(MODELS, { model: 'kimi-k3', effort: 'max' }), null);
  assert.equal(R.routeFor(MODELS, null), null);
});

const SWITCHES = { subscriptionClaude: true, shadow: false, learn: true, learnFromPrompts: false };

test('settings: in range, a known classifier mode, defaults for the rest (Gemini rates: always)', () => {
  assert.deepEqual(R.cleanSettings({ efficiency: 140.4, performance: -3, classifier: 'auto' }), { efficiency: 100, performance: 0, classifier: 'auto', ...SWITCHES });
  assert.deepEqual(R.cleanSettings({ classifier: 'sometimes', efficiency: 'x' }), { efficiency: 50, performance: 50, classifier: 'always', ...SWITCHES });
  assert.deepEqual(R.cleanSettings(null), { efficiency: 50, performance: 50, classifier: 'always', ...SWITCHES });
  assert.deepEqual(R.cleanSettings({ classifier: 'off' }).classifier, 'off');  // (still a choice)
  assert.ok(R.sameSettings(R.cleanSettings({}), { efficiency: 50, performance: 50, classifier: 'always' }));
  assert.equal(R.DEFAULT_SETTINGS.classifier, 'always');
});

test('the switches: booleans only; Claude as plan quota and learning on by default, prompts never kept', () => {
  const s = R.cleanSettings({ subscriptionClaude: false, shadow: true, learn: 'no', learnFromPrompts: 1 });
  assert.equal(s.subscriptionClaude, false);
  assert.equal(s.shadow, true);
  assert.equal(s.learn, true);  // (not a boolean: the default)
  assert.equal(s.learnFromPrompts, false);
  assert.ok(R.sameSettings(s, R.cleanSettings({})));  // the same routing…
  assert.ok(!R.sameAll(s, R.cleanSettings({})));  // …not the same settings
});

// Results as the router gives them (only what the helpers read).
const rules = (model, effort = 'medium') => ({ pick: { model, effort }, classification: { mode: 'off', used: false } });
const rated = (model, effort = 'medium', mode = 'always') => ({ pick: { model, effort }, classification: { mode, used: true } });
const failed = (model, mode = 'always') => ({ pick: { model, effort: 'medium' }, classification: { mode, used: false, error: 'HTTP 401', skipped: 'classifier failed; used the rules' } });

test('the same prompt: the composer’s text and what goes (trimmed)', () => {
  assert.ok(R.sameText('  fix the bug\n', 'fix the bug'));
  assert.ok(!R.sameText('fix the bug', 'fix the bugs'));
  assert.ok(R.sameText(undefined, ''));
});

test('a result is rated when no rating is still to come for it', () => {
  assert.ok(R.isRated(null, 'off'));  // Gemini off: nothing to come
  assert.ok(!R.isRated(null, 'always'));
  assert.ok(R.isRated({ result: rules('gpt-6-luna'), rated: true }, 'always'));  // (the chip says so)
  assert.ok(!R.isRated({ result: rules('gpt-6-luna') }, 'always'));  // the rules' preview
  assert.ok(R.isRated({ result: rated('claude-opus-5-5') }, 'always'));
  assert.ok(R.isRated({ result: failed('gpt-6-luna') }, 'always'));  // failed: the rules stand
  assert.ok(!R.isRated({ result: failed('gpt-6-luna', 'auto') }, 'always'));  // (another mode's)
  const skipped = { pick: { model: 'x' }, classification: { mode: 'auto', used: false, skipped: 'not needed' } };
  assert.ok(R.isRated({ result: skipped }, 'auto'));
});

test('a message waits for Gemini only while Gemini is on, working, and its pick unrated', () => {
  const preview = { result: rules('gpt-6-luna') };
  assert.ok(R.needsRating('always', preview, false));
  assert.ok(R.needsRating('auto', null, false));
  assert.ok(!R.needsRating('off', preview, false));
  assert.ok(!R.needsRating('always', preview, true));  // no key, today's cap, Google down: no wait
  assert.ok(!R.needsRating('always', { result: rated('claude-opus-5-5') }, false));
});

test('a rating moves a waiting message only when it’s used and picks something else', () => {
  const sent = R.routeFor(MODELS, { model: 'gpt-6-luna', effort: 'medium' });
  assert.deepEqual(R.ratedRoute(MODELS, sent, rated('claude-opus-5-5', 'high')), { ref: 'opus', model: 'claude-opus-5-5', effort: 'high' });
  assert.equal(R.ratedRoute(MODELS, sent, rated('gpt-6-luna')), null);  // the same pick
  assert.equal(R.ratedRoute(MODELS, sent, failed('claude-opus-5-5')), null);  // failed: its own
  assert.equal(R.ratedRoute(MODELS, sent, rules('claude-opus-5-5')), null);
  assert.equal(R.ratedRoute(MODELS, sent, rated('kimi-k3')), null);  // a model it can't run
  assert.equal(R.ratedRoute(MODELS, sent, null), null);
  const opus = R.routeFor(MODELS, { model: 'claude-opus-5-5', effort: 'low' });
  assert.deepEqual(R.ratedRoute(MODELS, opus, rated('claude-opus-5-5', 'max')).effort, 'max');  // another effort
});

test('Gemini’s problems pause the asking: no key until the keys change, the cap for a while', () => {
  assert.equal(R.pauseAfter(200), 0);
  assert.equal(R.pauseAfter(401), Infinity);
  assert.equal(R.pauseAfter(403), Infinity);
  assert.equal(R.pauseAfter(400, 'API key not valid. Please pass a valid API key.'), Infinity);
  assert.equal(R.pauseAfter(400, 'Invalid JSON payload'), 0);  // (that one request)
  assert.equal(R.pauseAfter(429), 15 * 60_000);
  for (const s of [500, 502, 503, 504]) assert.equal(R.pauseAfter(s), 30_000);
});

test('route_wait tokens: the shape code_router takes, never the same twice', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    const t = R.newToken();
    assert.match(t, /^[A-Za-z0-9_-]{8,64}$/);
    seen.add(t);
  }
  assert.equal(seen.size, 200);
  assert.match(R.newToken(null), /^rw[0-9a-f]{24}$/);  // (no crypto: still one)
});

test('the message in a backend error body', () => {
  assert.equal(R.errorText(JSON.stringify({ error: { message: 'no key' } })), 'no key');
  assert.equal(R.errorText('<html>'), '');
  assert.equal(R.errorText(''), '');
});

test('within: the value, or the fallback once the time is up or it failed', async () => {
  assert.equal(await R.within(Promise.resolve(3), 50), 3);
  assert.equal(await R.within(new Promise(() => {}), 10, 'late'), 'late');
  assert.equal(await R.within(Promise.reject(new Error('x')), 50, 'failed'), 'failed');
  assert.equal(await R.within(null, 50, 'x'), null);  // (nothing to wait for)
  assert.equal(R.ROUTE_WAIT_MS, 4000);  // = code_router.ROUTE_WAIT_SECONDS (4 s worst case)
});

// ── D11: efforts for other providers' models, where their relay passes one on ──

const KINDS = [
  { ref: 'opus', model: 'claude-opus-5-5', builtin: true, kind: 'builtin' },
  { ref: 'custom:o1', model: 'gpt-6-luna', builtin: false, kind: 'openai' },
  { ref: 'custom:g1', model: 'gemini-3.8-flash', builtin: false, kind: 'gemini' },
  { ref: 'custom:g2', model: 'gemini-3.1-pro-preview', builtin: false, kind: 'gemini' },
  { ref: 'custom:a1', model: 'claude-sonnet-5-5', builtin: false, kind: 'anthropic' },
  { ref: 'custom:r1', model: 'kimi-k3', builtin: false, kind: 'openrouter' },
];
const profile = (id, levels, defaultEffort) => ({ id, defaultEffort, efforts: levels.map((level) => ({ level })) });

test('the relays’ models take low, medium or high; Gemini Pro and the rest their default', () => {
  const efforts = R.effortsFor(KINDS);
  assert.deepEqual(efforts(profile('claude-opus-5-5', ['low', 'max'], 'medium')), R.CLAUDE_EFFORTS);
  assert.deepEqual(efforts(profile('gpt-6-luna', ['none', 'low', 'medium', 'high', 'xhigh', 'max'], 'medium')), ['low', 'medium', 'high']);
  assert.deepEqual(efforts(profile('gemini-3.8-flash', ['low', 'medium', 'high'], 'medium')), ['low', 'medium', 'high']);
  assert.deepEqual(efforts(profile('gemini-3.1-pro-preview', ['low', 'medium', 'high'], 'high')), ['high']);
  assert.deepEqual(efforts(profile('claude-sonnet-5-5', ['none', 'low'], 'high')), R.CLAUDE_EFFORTS);  // an Anthropic key
  assert.deepEqual(efforts(profile('kimi-k3', ['low', 'high', 'max'], 'max')), ['max']);  // OpenRouter: its own
  assert.deepEqual(efforts(profile('gpt-4.1', ['none'], 'none')), ['none']);  // nothing the relay passes on
});

test('a pick carries its effort to the relays’ models too', () => {
  assert.deepEqual(R.routeFor(KINDS, { model: 'gpt-6-luna', effort: 'low' }), { ref: 'custom:o1', model: 'gpt-6-luna', effort: 'low' });
  assert.deepEqual(R.routeFor(KINDS, { model: 'gemini-3.8-flash', effort: 'medium' }), { ref: 'custom:g1', model: 'gemini-3.8-flash', effort: 'medium' });
  assert.deepEqual(R.routeFor(KINDS, { model: 'gemini-3.1-pro-preview', effort: 'high' }), { ref: 'custom:g2', model: 'gemini-3.1-pro-preview' });
  assert.deepEqual(R.routeFor(KINDS, { model: 'kimi-k3', effort: 'max' }), { ref: 'custom:r1', model: 'kimi-k3' });
  assert.deepEqual(R.routeFor(KINDS, { model: 'gpt-6-luna', effort: 'none' }), { ref: 'custom:o1', model: 'gpt-6-luna' });  // (no such session effort)
  assert.ok(R.geminiFlash('gemini-flash-latest') && R.geminiFlash('gemini-3.6-flash') && !R.geminiFlash('gemini-2.5-flash') && !R.geminiFlash('gemini-pro-latest'));
});

test('a route’s next picks, as sessions take them, for the fallback', () => {
  const result = { fallbacks: [{ model: 'gpt-6-luna', effort: 'high' }, { model: 'claude-opus-5-5', effort: 'max' }, { model: 'nope' }, { model: 'gpt-6-luna', effort: 'low' }, { model: 'gemini-3.8-flash', effort: 'low' }] };
  const route = R.routeFor(KINDS, { model: 'claude-opus-5-5', effort: 'high' });
  assert.deepEqual(R.fallbacksFor(KINDS, result, route), [
    { ref: 'custom:o1', model: 'gpt-6-luna', effort: 'high' },
    { ref: 'custom:g1', model: 'gemini-3.8-flash', effort: 'low' },
  ]);  // (not the route itself, each once, a model it can run)
  assert.deepEqual(R.fallbacksFor(KINDS, null, route), []);
});

// ── D6: trivial messages are never rated ──

test('a trivial message: under 4 words, or a confirmation, in English or Chinese', () => {
  for (const t of ['yes', 'ok', 'Go ahead.', 'run it', 'continue', 'thanks!', 'do it', 'fix the tests', '继续', '好的', 'yes, go ahead', 'Sounds good!', '']) {
    assert.ok(R.isTrivial(t), t);
  }
  for (const t of ['refactor the scheduler to use a heap', 'yes but also update the docs and the changelog', '请把这个函数重构成异步的版本', 'x'.repeat(200)]) {
    assert.ok(!R.isTrivial(t), t);
  }
  const preview = { result: rules('gpt-6-luna') };
  assert.ok(!R.needsRating('always', preview, false, 'go ahead'));  // never waits for Gemini
  assert.ok(R.needsRating('always', preview, false, 'refactor the scheduler to use a heap'));
  const trivial = { pick: { model: 'x' }, classification: { mode: 'off', used: false, skipped: 'trivial' } };
  assert.ok(R.isRated({ result: trivial }, 'always'));  // (the router's own D6 says so too)
});

// ── what Jarvis knows of the session, for the route ──

test('the session’s extras: context, agentic calls, stickiness, Claude as quota, latency', () => {
  const state = {
    sessions: { 7: { project: 'abcdefabcdef', contextTokens: 42000, voice: true } },
    agenticCallsPerTurn: 6,
    quota: { used: 0.62, five_hour: 0.62, seven_day: 0.4 },
  };
  const t = { id: 7, model: 'claude-opus-5-5', effort: 'high' };
  const s = R.cleanSettings({});
  assert.deepEqual(R.extrasFor(t, s, state), {
    latency: { interactive: true, voice: true },
    context: { sessionTokens: 42000 },
    agenticCallsPerTurn: 6,
    sticky: { current: { model: 'claude-opus-5-5', effort: 'high' } },
    pricing: { subscription: { providers: ['anthropic'] } },
    quota: { used: 0.62 },
  });
  // Shadow mode with the router off: the session's model is the owner's, nothing sticks to it.
  assert.equal(R.extrasFor(t, s, state, { sticky: false }).sticky, undefined);
  // A new session: none of the session's own; Claude priced in dollars when the owner says so.
  const fresh = R.extrasFor(null, R.cleanSettings({ subscriptionClaude: false }), null);
  assert.deepEqual(fresh, { latency: { interactive: true }, agenticCallsPerTurn: R.AGENTIC_DEFAULT });
});

test('the budget leans the router cheaper; learned overrides only with learning on', () => {
  assert.equal(R.budgetBoost({ budget: { usd: 50, spentUSD: 45, boost: 20 } }), 20);
  assert.equal(R.budgetBoost({ budget: { usd: 0, spentUSD: 3 } }), 0);
  assert.equal(R.budgetBoost(null), 0);
  assert.match(R.budgetNote({ budget: { usd: 50, spentUSD: 45, fraction: 0.9, boost: 20 } }), /90% spent \(\$45\.00 of \$50\.00\): leaning cheaper/);
  assert.equal(R.budgetNote({ budget: { usd: 50, spentUSD: 10, fraction: 0.2, boost: 0 } }), '');
  const on = { learned: { on: true, updated: '2026-10-06T03:40:00Z', overrides: { 'gpt-6.1-sol': { capabilities: { coding: 90 } } } } };
  assert.deepEqual(R.learnedOverrides(on), on.learned.overrides);
  assert.equal(R.learnedOverrides({ learned: { ...on.learned, on: false } }), null);
  assert.equal(R.learnedOverrides({ learned: { on: true, overrides: {} } }), null);
  assert.notEqual(R.learnedStamp(on), R.learnedStamp({ learned: { ...on.learned, updated: 'later' } }));
});

test('per-project levels over the settings', () => {
  const s = R.cleanSettings({ efficiency: 50, performance: 50 });
  assert.deepEqual(R.effectiveSettings(s, null), s);
  const p = R.effectiveSettings(s, { efficiency: 80, performance: 20 });
  assert.equal(p.efficiency, 80);
  assert.equal(p.performance, 20);
  assert.equal(p.project, true);
  assert.equal(p.classifier, 'always');
});

test('what the log keeps of a route: numbers, ids and enums, never the prompt’s words', () => {
  const result = {
    task: { complexity: 'complex', complexityScore: 0.71, weights: { coding: 0.6, reasoning: 0.4 }, inputTokens: 900, outputTokens: 1200, signals: ['mentions "secret project"'] },
    classification: { mode: 'always', used: true, model: 'gemini-3.6-flash', finalComplexity: 'complex', rulesComplexity: 'moderate', rating: { reason: 'the prompt says secret things' } },
    optimization: { level: 3 },
    pick: { model: 'claude-opus-5-5', effort: 'high', quality: 82.1, costUSD: 0.012, rationale: 'because "secret project"' },
    fallbacks: [{ model: 'gpt-6-luna', effort: 'medium', quality: 80, costUSD: 0.004 }],
    rows: [{ model: 'claude-opus-5-5', quality: 82.1, costUSD: 0.012, eligible: true }, { model: 'claude-fable-5-1', effort: 'max', quality: 88, costUSD: 0.2, eligible: true }, { model: 'x', quality: 99, eligible: false }],
  };
  const info = R.infoOf(result, R.cleanSettings({}), R.extrasFor({ id: 1, model: 'claude-opus-5-5' }, R.cleanSettings({}), null), 0);
  const said = JSON.stringify(info);
  assert.ok(!said.includes('secret'));
  assert.equal(info.best.model, 'claude-fable-5-1');  // (the best eligible one)
  assert.equal(info.rating.by, 'gemini-3.6-flash');
  assert.equal(info.profile.score, 0.71);
  assert.deepEqual(info.alternatives, [{ model: 'gpt-6-luna', effort: 'medium', quality: 80, costUSD: 0.004 }]);
  assert.equal(info.extras.sticky, true);
  assert.equal(R.infoOf(null, R.cleanSettings({})), undefined);
});

test('prices for the models it routes among (USD per 1M tokens)', () => {
  const lib = { MODELS: [{ id: 'gpt-6-luna', pricing: { inputPer1M: 0.4, outputPer1M: 1.6 } }, { id: 'other', pricing: { inputPer1M: 1, outputPer1M: 2 } }, { id: 'kimi-k3' }] };
  assert.deepEqual(R.pricesOf(lib, ['gpt-6-luna', 'kimi-k3']), { 'gpt-6-luna': { in: 0.4, out: 1.6 } });
  assert.deepEqual(R.pricesOf(null, ['x']), {});
});

// ── the window: the feature wired to a stand-in Jarvis window and router ──


const SOURCE = readFileSync(new URL('../../src/jarvis/web/features/code-router.js', import.meta.url), 'utf8');

function rowOf(model, effort, quality, costUSD) {
  return { model, effort, quality, costUSD, eligible: true };
}
function resultFor(body, rated) {
  const trivial = R.isTrivial(body.prompt);
  return {
    task: { complexity: trivial ? 'simple' : 'complex', complexityScore: trivial ? 0.1 : 0.7, weights: { coding: 1 }, inputTokens: 10, outputTokens: 20, signals: ['words of the prompt'] },
    classification: rated ? { mode: body.classifier, used: true, model: 'gemini-3.6-flash', finalComplexity: 'complex' } : { mode: 'off', used: false },
    optimization: { level: 3 },
    pick: rated ? rowOf('claude-opus-5-5', 'high', 90, 0.05) : rowOf('gpt-6-luna', 'low', 80, 0.001),
    fallbacks: [rowOf('gemini-3.8-flash', 'medium', 79, 0.002), rowOf('claude-opus-5-5', 'max', 92, 0.1)],
    rows: [rowOf('claude-opus-5-5', 'max', 92, 0.1), rowOf('gpt-6-luna', 'low', 80, 0.001)],
  };
}

function windowWith({ features = {}, task = { id: 7, model: 'claude-opus-5-5', effort: 'high', folder: 'proj', busy: false } } = {}) {
  const sent = [];
  const handlers = {};
  const reg = {};
  const bodies = [];
  const created = [];
  const lib = {
    MODELS: [{ id: 'gpt-6-luna', pricing: { inputPer1M: 0.1, outputPer1M: 0.5 } }],
    createLocalRouter(opts) {
      created.push(opts);
      return {
        ids: opts.models,
        meta: () => ({}),
        routeSync: (body) => { bodies.push(body); return resultFor(body, false); },
        route: async (body) => { bodies.push(body); return resultFor(body, body.classifier && body.classifier !== 'off'); },
      };
    },
  };
  const chip = { hidden: true, applied: [], setAttribute() {}, addEventListener() {}, refresh() {}, applySettings(s) { this.applied.push(s); }, pending: () => null };
  const F = {
    $: (id) => ({ id, after() {}, hidden: false, textContent: '', title: '' }),
    send: (m) => { sent.push(m); return true; },
    on: (type, fn) => { (handlers[type] ||= []).push(fn); },
    t: (x) => x,
    currentTask: () => task,
    registerSessionOption: (fn) => { reg.session = fn; },
    registerSendOption: (fn) => { reg.send = fn; },
    registerModelChoice: (c) => { reg.choice = c; },
    registerComposerRender: (fn) => { reg.render = fn; },
  };
  const window = { jarvisFeatures: F, crypto: globalThis.crypto };
  const document = {
    head: { append: (s) => { window.ModelRouterLib = lib; queueMicrotask(() => s.onload()); } },
    createElement: (tag) => (tag === 'script' ? {} : chip),
  };
  const customElements = { get: () => class { static adapter = null; } };
  const modelList = [
    { ref: 'opus', model: 'claude-opus-5-5', builtin: true, kind: 'builtin' },
    { ref: 'custom:o1', model: 'gpt-6-luna', builtin: false, kind: 'openai' },
    { ref: 'custom:g1', model: 'gemini-3.8-flash', builtin: false, kind: 'gemini' },
  ];
  const prefs = { features: { code_router_on: true, ...features } };
  const fire = (type, ev) => { for (const fn of handlers[type] || []) fn(ev); };
  let Chip = null;
  customElements.get = () => (Chip ||= class { static adapter = null; });
  new Function('window', 'document', 'customElements', 'modelList', 'prefs', 'jcNote', 'renderComposer', 'ICON_PATHS', SOURCE)(
    window, document, customElements, modelList, prefs, () => {}, () => reg.render && reg.render({ t: task }), {},
  );
  const ready = async () => { reg.render({ t: task }); for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); };
  return { sent, fire, reg, bodies, created, chip, ready, adapter: () => Chip.adapter, task };
}

test('a message carries its route, what the log keeps of it, and its next picks; it waits for Gemini', async () => {
  const w = windowWith();
  await w.ready();
  w.fire('model_router_state', { sessions: { 7: { project: 'abcdefabcdef', contextTokens: 30000 } }, agenticCallsPerTurn: 8, quota: { used: 0.3 } });
  const out = w.reg.send(w.task, 'refactor the scheduler to use a heap');
  assert.deepEqual({ ...out.route, info: undefined, fallbacks: undefined }, { ref: 'custom:o1', model: 'gpt-6-luna', effort: 'low', info: undefined, fallbacks: undefined });
  assert.deepEqual(out.route.fallbacks, [{ ref: 'custom:g1', model: 'gemini-3.8-flash', effort: 'medium' }, { ref: 'opus', model: 'claude-opus-5-5', effort: 'max' }]);
  assert.ok(!JSON.stringify(out.route.info).includes('words of the prompt'));
  assert.match(out.route_wait, /^rw[0-9a-f]{24}$/);
  const body = w.bodies.at(-1);
  assert.deepEqual(body.context, { sessionTokens: 30000 });
  assert.deepEqual(body.sticky, { current: { model: 'claude-opus-5-5', effort: 'high' } });
  assert.deepEqual(body.pricing, { subscription: { providers: ['anthropic'] } });
  assert.deepEqual(body.quota, { used: 0.3 });
  assert.equal(body.agenticCallsPerTurn, 8);
  await new Promise((r) => setTimeout(r, 10));
  const rated = w.sent.find((m) => m.type === 'model_router_route');
  assert.equal(rated.token, out.route_wait);
  assert.deepEqual({ ref: rated.route.ref, effort: rated.route.effort }, { ref: 'opus', effort: 'high' });
  assert.equal(rated.route.info.rating.by, 'gemini-3.6-flash');
  // The prices went to the backend once, with the router.
  assert.deepEqual(w.sent.filter((m) => m.type === 'model_router_prices').map((m) => m.prices), [{ 'gpt-6-luna': { in: 0.1, out: 0.5 } }]);
});

test('a trivial message never waits; Shadow mode logs and moves nothing; learned overrides go to the router', async () => {
  const w = windowWith();
  await w.ready();
  assert.equal(w.reg.send(w.task, 'go ahead').route_wait, undefined);
  assert.deepEqual(w.reg.send({ ...w.task, busy: true }, 'something long enough to rate'), {});  // (never mid-step)
  w.fire('prefs', { features: { code_router_on: false, code_router_settings: { shadow: true } } });
  const shadow = w.reg.send(w.task, 'refactor the scheduler to use a heap');
  assert.equal(shadow.route.shadow, true);
  assert.equal(shadow.route_wait, undefined);
  assert.equal(w.bodies.at(-1).sticky, undefined);  // (the owner's model, not the router's)
  w.fire('prefs', { features: { code_router_on: false } });
  assert.deepEqual(w.reg.send(w.task, 'refactor the scheduler to use a heap'), {});  // off, no shadow
  w.fire('prefs', { features: { code_router_on: true } });
  w.fire('model_router_state', { learned: { on: true, updated: 'u1', overrides: { 'gpt-6-luna': { capabilities: { coding: 70 } } } } });
  w.reg.send(w.task, 'refactor the scheduler to use a heap');
  assert.deepEqual(w.created.at(-1).overrides, { 'gpt-6-luna': { capabilities: { coding: 70 } } });
  w.fire('prefs', { features: { code_router_on: true, code_router_settings: { learn: false } } });
  w.reg.send(w.task, 'refactor the scheduler to use a heap');
  assert.equal(w.created.at(-1).overrides, undefined);
});

test('the adapter: feedback, spend and learning through the backend; per-project levels; the budget’s note', async () => {
  const w = windowWith();
  await w.ready();
  const adapter = w.adapter();
  adapter.feedback('wrong-pick', { prompt: 'p', pick: { model: 'gpt-6-luna', effort: 'low', extra: 1 }, chosen: 'claude-opus-5-5' });
  assert.deepEqual(w.sent.at(-1), { type: 'model_router_feedback', kind: 'wrong-pick', id: 7, prompt: 'p', pick: { model: 'gpt-6-luna', effort: 'low' }, chosen: 'claude-opus-5-5' });
  const spend = adapter.spend();
  const ask = w.sent.at(-1);
  assert.equal(ask.type, 'model_router_call');
  assert.equal(ask.op, 'spend');
  w.fire('model_router_reply', { rid: ask.rid, ok: true, data: { totalUSD: 1.5, byModel: [] } });
  assert.equal((await spend).totalUSD, 1.5);
  const learned = adapter.learned();
  w.fire('model_router_reply', { rid: w.sent.at(-1).rid, ok: true, data: { frozen: true, changes: [{ model: 'm' }] } });
  assert.deepEqual(await learned, { frozen: true, updated: undefined, changes: [{ model: 'm' }] });
  const reset = adapter.resetLearning();
  w.fire('model_router_reply', { rid: w.sent.at(-1).rid, ok: false, error: 'no' });
  await assert.rejects(reset, /no/);
  // Per-project levels: none until the backend names the session's project.
  assert.equal(adapter.projectDefaults(), null);
  w.fire('model_router_state', { sessions: { 7: { project: 'abcdefabcdef' } }, budget: { usd: 10, spentUSD: 9, fraction: 0.9, boost: 20 } });
  assert.deepEqual(adapter.projectDefaults(), { project: 'proj' });
  adapter.setProjectDefaults({ efficiency: 80, performance: 20 });
  assert.deepEqual(w.sent.at(-1), { type: 'feature_prefs', changes: { code_router_projects: { abcdefabcdef: { efficiency: 80, performance: 20 } } } });
  assert.deepEqual(adapter.projectDefaults(), { project: 'proj', efficiency: 80, performance: 20 });
  assert.equal(adapter.loadSettings().efficiency, 80);
  // The sliders, while the project has its own: the project's levels; the rest everyone's.
  adapter.saveSettings({ efficiency: 60, performance: 30, classifier: 'auto' });
  const saved = w.sent.at(-1).changes;
  assert.deepEqual(saved.code_router_projects.abcdefabcdef, { efficiency: 60, performance: 30 });
  assert.equal(saved.code_router_settings.classifier, 'auto');
  assert.equal(saved.code_router_settings.efficiency, 50);
  // The budget leans it cheaper, and says so.
  const result = await adapter.route({ prompt: 'refactor the scheduler to use a heap', efficiency: 60, performance: 30, classifier: 'off' });
  assert.equal(w.bodies.at(-1).efficiency, 80);
  assert.match(result.notes.at(-1), /90% spent/);
  adapter.setProjectDefaults(null);
  assert.deepEqual(w.sent.at(-1).changes.code_router_projects, {});
});
