// Settings › Oura Ring (web/features/oura.js). node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { status } = require('../../src/jarvis/web/features/oura.js');

test('the status line follows the connection', () => {
  assert.equal(status({}), 'Not connected.');
  assert.match(status({ client: true }), /App saved/);
  assert.match(status({ client: true, connecting: true }), /allow access/);
  assert.equal(status({ client: true, connected: true, last: '07:12' }), 'Connected. Last read at 07:12.');
  assert.equal(status({ connected: true, error: 'Oura didn’t answer (500).' }), 'Oura didn’t answer (500).');
  assert.equal(status(null), '');
});
