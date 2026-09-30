// The live call panel's helpers (src/jarvis/web/features/calls.js). node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const calls = require('../../src/jarvis/web/features/calls.js');

test('a call says where it is, and a taken-over call says it is being put through', () => {
  assert.equal(calls.statusLabel({ status: 'asking' }), 'Needs you');
  assert.equal(calls.statusLabel({ status: 'ringing' }), 'Ringing');
  assert.equal(calls.statusLabel({ status: 'talking', yours: true }), 'Putting you through');
  assert.equal(calls.statusLabel({ status: 'something new' }), 'On the call');
});

test('how long a call has run reads as minutes and seconds', () => {
  const at = '2026-10-02T10:00:00Z';
  assert.equal(calls.elapsed(at, Date.parse('2026-10-02T10:01:05Z')), '1:05');
  assert.equal(calls.elapsed(at, Date.parse('2026-10-02T09:59:00Z')), '0:00');
  assert.equal(calls.elapsed('', Date.now()), '');
});

test('an answer is sent only with something in it', () => {
  assert.deepEqual(calls.answerFor('answer', '  Tuesday   at 3 '), ['answer', 'Tuesday at 3']);
  assert.equal(calls.answerFor('answer', '   '), null);
  assert.deepEqual(calls.answerFor('later', 'ignored'), ['later', '']);
  assert.equal(calls.answerFor('drop the table', ''), null);
  assert.equal(calls.answerFor('answer', 'x'.repeat(900))[1].length, 500);
});

test('every word the panel shows has its Chinese', () => {
  const zh = JSON.parse(require('node:fs').readFileSync(new URL('../../src/jarvis/web/i18n/calls.json', import.meta.url), 'utf8')).strings;
  for (const words of [...Object.values(calls.STATUS), ...Object.values(calls.WHO)]) assert.ok(zh[words], words);
  const source = require('node:fs').readFileSync(new URL('../../src/jarvis/web/features/calls.js', import.meta.url), 'utf8');
  const shown = [...source.matchAll(/\bel\('[^']*',\s*'[^']*',\s*'([^']+)'\)|\bbutton\('([^']+)'/g)].map((m) => m[1] || m[2]);
  assert.ok(shown.includes('Take over') && shown.includes('Waiting for them to pick up…'));
  for (const words of shown) assert.ok(zh[words], words);
  for (const [, words] of source.matchAll(/\bt\('([^']+)'\)/g)) assert.ok(zh[words], words);
});
