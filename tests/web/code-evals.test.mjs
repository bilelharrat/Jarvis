// Eden Code's evals pane (web/features/code-evals.js), its pure helpers: what a suite sends
// (the Model Router's pick for each case when a configuration is the router), the newest
// cases, the side-by-side rows, a result's mark and calibration's words. node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const E = require('../../src/jarvis/web/features/code-evals.js');

test('a suite sends its configurations, and the router’s pick for every case', () => {
  const configs = [
    { model: 'opus', label: 'Opus 5.5', effort: 'high', prompt: 'lean', rules: 'off' },
    { model: E.ROUTER, prompt: 'full', rules: 'on' },
  ];
  const cases = [{ id: 'e1', prompt: 'fix a' }, { id: 'e2', prompt: 'fix b' }];
  const pick = (text) => ({ ref: text === 'fix a' ? 'haiku' : 'sonnet', effort: 'low' });
  const [ok, suite] = E.suiteToSend(configs, cases, pick);
  assert.ok(ok);
  assert.deepEqual(suite.configs[0], { model: 'opus', label: 'Opus 5.5', effort: 'high', prompt: 'lean', rules: 'off', engine: '', engine_version: '' });
  assert.equal(suite.configs[1].router, true);
  assert.equal(suite.configs[1].model, undefined);
  assert.deepEqual(suite.routes, { e1: { ref: 'haiku', effort: 'low' }, e2: { ref: 'sonnet', effort: 'low' } });
  // the router not ready: nothing is sent
  const [no, why] = E.suiteToSend(configs, cases, () => null);
  assert.equal(no, false);
  assert.match(why, /Model Router isn’t ready/);
  // no router configuration: no routes asked for
  const [plain, s] = E.suiteToSend(configs.slice(0, 1), cases, null);
  assert.ok(plain);
  assert.deepEqual(s.routes, {});
});

test('the newest cases, and the comparison best first', () => {
  assert.deepEqual(E.lastN([{ id: 'a' }, { id: 'b' }, { id: 'c' }], 2), ['a', 'b']);
  assert.deepEqual(E.lastN(null, 2), []);
  const record = {
    configs: [{ id: 'c1', label: 'Sonnet' }, { id: 'c2', label: 'Opus' }, { id: 'c3', label: 'Haiku' }],
    summary: {
      c1: { passed: 3, total: 4, cost_usd: 1.2 },
      c2: { passed: 3, total: 4, cost_usd: 2.5 },
      c3: { passed: 1, total: 4, cost_usd: 0.3 },
    },
  };
  assert.deepEqual(E.compareRows(record).map((r) => r.label), ['Sonnet', 'Opus', 'Haiku']);
  assert.deepEqual(E.compareRows({ configs: [{ id: 'c1', label: 'x' }] })[0], { id: 'c1', label: 'x', total: 0, passed: 0 });
});

test('marks, money, times and calibration’s words', () => {
  assert.deepEqual(E.mark({ status: 'passed' }), ['✓', 'ok']);
  assert.deepEqual(E.mark({ status: 'failed' }), ['✗', 'bad']);
  assert.deepEqual(E.mark({ status: 'skipped' }), ['–', 'dim']);
  assert.deepEqual(E.mark(undefined), ['…', 'busy']);
  assert.equal(E.money(1.234), '$1.23');
  assert.equal(E.money(null), '$0.00');
  assert.equal(E.duration(45), '45s');
  assert.equal(E.duration(600), '10 min');
  assert.equal(E.duration(null), '—');
  assert.match(E.verdictWords('passes_at_start'), /can’t tell/);
  assert.equal(E.verdictWords(''), '');
});

test('every fixed sentence the pane shows has its Chinese', () => {
  const src = readFileSync(new URL('../../src/jarvis/web/features/code-evals.js', import.meta.url), 'utf8');
  const zh = JSON.parse(readFileSync(new URL('../../src/jarvis/web/i18n/code-evals.json', import.meta.url), 'utf8')).strings;
  for (const s of ['Run a suite', 'Results', 'Case by case', 'Add from a commit', 'Collect landed work for evals', 'Lean prompt', 'Rules off']) {
    assert.ok(src.includes(`'${s}'`), s);
    assert.ok(zh[s], s);
  }
});

test('the pane keeps to light and dark tokens and leaves the composer alone', () => {
  const css = readFileSync(new URL('../../src/jarvis/web/features/code-evals.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /jc-composer|jc-dock/);
  assert.doesNotMatch(css, /color:\s*#(?!fff\b)[0-9a-f]+/i);  // (colours from the theme's tokens)
  assert.match(css, /--ecg-fill-soft/);
});
