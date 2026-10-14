// Pairing mode (web/features/code-pairing.js). node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { status } = require('../../src/jarvis/web/features/code-pairing.js');

test('the status says whether it pairs, and what waits for the owner', () => {
  assert.match(status(null), /isolated copy/);
  assert.match(status({ copy: true, on: false }), /^Off\./);
  assert.equal(status({ copy: true, on: true, conflicts: [], held: [] }), 'On: changes go both ways.');
  assert.equal(status({ copy: true, on: true, conflicts: ['a'], held: ['b', 'c'] }), 'On: 1 changed on both sides, 2 held for you.');
  assert.equal(status({ copy: true, on: true, error: 'disk full' }), 'The last sync failed: disk full');
});
