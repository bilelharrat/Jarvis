// Pairing mode (web/features/code-pairing.js). node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { status, clashNote } = require('../../src/jarvis/web/features/code-pairing.js');

test('the status says whether it pairs, and what waits for the owner', () => {
  assert.match(status(null), /isolated copy/);
  assert.match(status({ copy: true, on: false }), /^Off\./);
  assert.equal(status({ copy: true, on: true, conflicts: [], held: [] }), 'On: changes go both ways.');
  assert.equal(status({ copy: true, on: true, conflicts: ['a'], held: ['b', 'c'] }), 'On: 1 changed on both sides, 2 held for you.');
  assert.equal(status({ copy: true, on: true, error: 'disk full' }), 'The last sync failed: disk full');
});

// Round 3, P3: a file on one side and a folder on the other is a conflict, said as one.
test('a file against a folder says so, with its Chinese', async () => {
  assert.match(clashNote({ clashes: ['x'] }, 'x'), /^A file on one side, a folder on the other/);
  assert.equal(clashNote({ clashes: ['x'] }, 'y'), '');
  assert.equal(clashNote({}, 'x'), '');
  const { readFileSync } = await import('node:fs');
  const zh = JSON.parse(readFileSync(new URL('../../src/jarvis/web/i18n/code-pairing.json', import.meta.url), 'utf8'));
  assert.ok(zh.strings[clashNote({ clashes: ['x'] }, 'x')]);
});
