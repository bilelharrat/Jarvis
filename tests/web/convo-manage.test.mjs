// Rename, pin and delete in Conversations' list (web/features/convo-manage.js). node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { order } = require('../../src/jarvis/web/features/convo-manage.js');

test('pinned conversations come first, each group in its own order', () => {
  assert.deepEqual(order(['a', 'b', 'c', 'd'], ['c', 'a']), ['a', 'c', 'b', 'd']);
  assert.deepEqual(order(['a', 'b'], []), ['a', 'b']);
  assert.deepEqual(order(['a', 'b'], ['zz']), ['a', 'b']); // a pin for one not listed (another search)
});
