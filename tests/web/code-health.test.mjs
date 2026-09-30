// Jarvis Code's Health pane (web/features/code-health.js), its pure helper: what a session's
// state reads as. node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const H = require('../../src/jarvis/web/features/code-health.js');

test('a session’s state in words', () => {
  assert.equal(H.sessionWords({ status: 'failed' }), 'It stopped with an error');
  assert.equal(H.sessionWords({ status: 'closed' }), 'Closed: it opens again with your next message');
  assert.equal(H.sessionWords({ status: 'running', busy: true }), 'Working');
  assert.equal(H.sessionWords({ status: 'running', busy: false }), 'Ready');
  assert.equal(H.sessionWords(null), '');
});
