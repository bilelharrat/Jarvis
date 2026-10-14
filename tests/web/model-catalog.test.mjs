// Eden Code's router bundle (src/jarvis/web/features/vendor/model-router.js) in step with Eden
// chat's (askeden.com: site/src/eden/vendor/model-router.js): the same registry (names, list
// prices, efforts, capabilities) for every model, Eden chat's models as pinned in
// tests/fixtures/eden_chat_models.json, and the router askeden.com ships (built 2026-10-14 or
// later, with Gemini's thinking-level output floor). tests/test_model_catalog.py checks the
// Python catalog (providers.CATALOG) against the same fixture.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const R = require('../../src/jarvis/web/features/code-router.js');
const BUNDLE = new URL('../../src/jarvis/web/features/vendor/model-router.js', import.meta.url);
const SITE = new URL('../../site/src/eden/vendor/model-router.js', import.meta.url);
const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/eden_chat_models.json', import.meta.url), 'utf8'));
const source = readFileSync(BUNDLE, 'utf8');

// The bundle as the window runs it (a global ModelRouterLib); its <model-router-chip> part
// returns at once when the element is already defined, so no DOM is needed.
function load() {
  const ctx = { console, customElements: { get: () => true } };
  ctx.window = ctx;
  vm.runInNewContext(source, ctx);
  return ctx.ModelRouterLib;
}
const lib = load();
const byId = new Map(lib.MODELS.map((m) => [m.id, m]));
const registry = (m) => JSON.stringify({ name: m.name, provider: m.provider, pricing: m.pricing, efforts: m.efforts, capabilities: m.capabilities, maxOutputTokens: m.maxOutputTokens, contextWindow: m.contextWindow });

test('the bundle is the 2026-10-14 build or later', () => {
  const stamp = /^\/\* model-router (\d+\.\d+\.\d+) \((\d{4}-\d{2}-\d{2})\)/.exec(source);
  assert.ok(stamp, 'the generated header');
  assert.ok(stamp[2] >= '2026-10-14', `built ${stamp[2]}`);
});

test("every Eden chat model is in the bundle by the same id, name, provider and list price", () => {
  for (const chat of FIXTURE.models) {
    const m = byId.get(chat.id);
    assert.ok(m, `${chat.id} is missing from the router bundle`);
    assert.equal(m.name, chat.name, chat.id);
    assert.equal(m.provider, chat.provider, chat.id);
    assert.equal(m.pricing.inputPer1M, chat.inputPer1M, `${chat.id} input price`);
    assert.equal(m.pricing.outputPer1M, chat.outputPer1M, `${chat.id} output price`);
  }
});

test("the registry is Eden chat's, model for model", { skip: !existsSync(SITE) && 'no site/ in this checkout' }, async () => {
  const site = await import(SITE.href);
  assert.deepEqual([...byId.keys()].sort(), site.MODELS.map((m) => m.id).sort());
  for (const m of site.MODELS) assert.equal(registry(byId.get(m.id)), registry(m), m.id);
  assert.equal(lib.DEFAULT_CLASSIFIER_MODEL, site.DEFAULT_CLASSIFIER_MODEL);
});

test("Gemini's thinking levels get askeden.com's output floor (a high-effort essay isn't cut off)", async () => {
  const router = lib.createLocalRouter({ models: ['gemini-3.8-flash'], efforts: () => ['high'] });
  const result = await router.route({ prompt: 'Write a short essay about rivers.' });
  assert.equal(result.pick.model, 'gemini-3.8-flash');
  assert.equal(result.pick.effort, 'high');
  assert.ok(result.pick.request.params.config.maxOutputTokens >= 16_384, String(result.pick.request.params.config.maxOutputTokens));
});

test("the window routes onto Eden chat's models the way Eden Code runs them", () => {
  const how = { openai: 'openai', kimi: 'openai', gemini: 'gemini' };
  const models = FIXTURE.models.filter((m) => m.provider !== 'anthropic').map((m, i) => ({ ref: `custom:m${i}`, model: m.id, kind: how[m.provider] }));
  for (const entry of models) {
    const route = R.routeFor(models, { model: entry.model, effort: 'medium' });
    assert.equal(route.ref, entry.ref, entry.model);
    // OpenAI-compatible (GPT-6, Kimi): the relay passes reasoning effort; Gemini Flash its thinking level; Pro and Argon run at their own.
    const effort = entry.kind === 'openai' || /flash/.test(entry.model);
    assert.equal(route.effort, effort ? 'medium' : undefined, entry.model);
  }
});
