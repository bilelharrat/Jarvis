// Eden Code's richer @-mentions (web/features/code-mentions.js), its pure helpers: a
// project's folders, which match what's typed, and what a symbol puts in the message.
// node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const M = require('../../src/jarvis/web/features/code-mentions.js');

test('a project’s folders, each once, from its files', () => {
  assert.deepEqual(M.foldersOf(['src/jarvis/hub.py', 'src/app.js', 'README.md', 'tests/web/a.mjs']), ['src', 'src/jarvis', 'tests', 'tests/web']);
  assert.deepEqual(M.foldersOf([]), []);
  assert.deepEqual(M.foldersOf(null), []);
});

test('folders matching what’s typed: by their own name first, then shorter', () => {
  const folders = M.foldersOf(['src/web/a.js', 'tests/web/b.mjs', 'docs/webhooks/c.md', 'web/index.html', 'lib/cobweb/x.py']);
  assert.deepEqual(M.matchFolders(folders, 'web'), ['web', 'src/web', 'tests/web', 'docs/webhooks']);
  assert.deepEqual(M.matchFolders(folders, 'src/'), ['src', 'src/web']);  // (and what's in it)
  assert.deepEqual(M.matchFolders(folders, ''), []);
});

test('a symbol goes in as its file and where it is, and @ counts as mid-message after words', () => {
  assert.equal(M.symbolValue({ name: 'retry', path: 'src/app.py', line: 12 }), 'src/app.py (retry, line 12)');
  assert.equal(M.midMessage('@ses'), false);
  assert.equal(M.midMessage('  @'), false);
  assert.equal(M.midMessage('ask @ses'), true);
});
