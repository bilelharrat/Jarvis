// A turn's proof card (web/features/code-receipts.js): its tests line. A run that exited
// fine but said no counts reads "Tests ran", and no line ever says "(0)". node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { testsLine, modelLines } = require('../../src/jarvis/web/features/code-receipts.js');

test('the tests line: a count when the run said one, never "(0)"', () => {
  assert.deepEqual(testsLine(null), ['rc-none', 'No tests run', 0]);
  assert.deepEqual(testsLine({ passed: true, passed_count: 12, failed_count: 0 }), ['rc-ok', 'Tests passed', 12]);
  assert.deepEqual(testsLine({ passed: false, passed_count: 9, failed_count: 3 }), ['rc-bad', 'Tests failed', 3]);
  // Failed without a count it could read: failed, with no number.
  assert.deepEqual(testsLine({ passed: false, passed_count: 0, failed_count: 0 }), ['rc-bad', 'Tests failed', 0]);
  // Exited fine, no counts: unknown (the backend sends passed: null), not passed.
  assert.deepEqual(testsLine({ passed: null, passed_count: 0, failed_count: 0 }), ['rc-none', 'Tests ran (no result shown)', 0]);
});

test('the model lines: every fallback, and Model Router’s Shadow pick with what it would save', () => {
  assert.deepEqual(modelLines({}), []);
  const r = {
    fallbacks: [{ from: 'Opus 5.5', to: 'Sonnet 5.5', why: 'its usage limit or a rate limit' }],
    router: { label: 'Sonnet 5.5', model: 'claude-sonnet-5-5', saveUSD: 0.0381 },
  };
  assert.deepEqual(modelLines(r), [
    ['rc-warn rc-fallback', 'Fell back from Opus 5.5 to Sonnet 5.5 (its usage limit or a rate limit)'],
    ['rc-none rc-shadow', 'Model Router would pick Sonnet 5.5 (about $0.04 less)'],
  ]);
  assert.equal(modelLines({ router: { model: 'gpt-6', saveUSD: -0.25 } })[0][1], 'Model Router would pick gpt-6 (about $0.25 more)');
  assert.equal(modelLines({ router: { model: 'gpt-6', saveUSD: null } })[0][1], 'Model Router would pick gpt-6');
});
