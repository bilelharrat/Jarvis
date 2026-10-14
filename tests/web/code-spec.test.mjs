// Eden Code's Spec mode (web/features/code-spec.js). node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { summary, spoken, tip, words } = require('../../src/jarvis/web/features/code-spec.js');

test('a receipt counts the requirements met', () => {
  assert.deepEqual(summary([{ status: 'met' }, { status: 'unmet' }, { status: 'met' }]), { met: 2, total: 3 });
  assert.deepEqual(summary(null), { met: 0, total: 0 });
});

test('a requirement reads aloud with its evidence', () => {
  assert.equal(
    spoken({ id: 'R1', title: 'Sign in', status: 'met', evidence: ['R1.1: test_r1_1 passed'] }),
    'R1 Sign in: met. R1.1: test_r1_1 passed',
  );
  assert.equal(spoken({ id: 'R2', status: 'unchecked', evidence: [] }), 'R2: not checked');
  assert.equal(words.partly, 'Partly met');
});

test('the switch says what Spec mode does', () => {
  assert.match(tip(true), /asks you after each/);
  assert.match(tip(false), /checked against them/);
});
