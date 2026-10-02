// Jarvis Code in the cloud (web/features/code-cloud.js). node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { tip } = require('../../src/jarvis/web/features/code-cloud.js');

test('the switch says where sessions go, or why it cannot', () => {
  assert.match(tip(null), /Add a cloud machine/);
  assert.match(tip({ machine: 'jarvis-cloud', ready: false, problem: 'claude is not signed in' }), /isn't ready: claude is not signed in/);
  assert.equal(tip({ machine: 'jarvis-cloud', ready: true }), 'Runs on jarvis-cloud: it keeps working while your Mac sleeps or is shut.');
});
