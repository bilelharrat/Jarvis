// Multi-repo tasks (web/features/code-multirepo.js). node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { startProblem, repoLine } = require('../../src/jarvis/web/features/code-multirepo.js');

test('a task needs two to the most projects and something to do', () => {
  assert.equal(startProblem(['api'], 'x', 8), 'Pick at least two projects.');
  assert.equal(startProblem(['a', 'b', 'c'], 'x', 2), 'Pick at most 2 projects.');
  assert.equal(startProblem(['a', 'b'], '  ', 8), 'Say what the task should do.');
  assert.equal(startProblem(['a', 'b'], 'add the field', 8), '');
});

test('each repository says its branch, its changes and its conflicts', () => {
  assert.equal(repoLine({ branch: 'jarvis/x', into: 'main', state: {} }), 'jarvis/x → main · no changes yet');
  assert.equal(
    repoLine({ branch: 'jarvis/x', into: 'main', state: { files: 2, added: 5, removed: 1 }, conflicts: ['a.py'] }),
    'jarvis/x → main · 2 files +5 −1 · conflicts in a.py',
  );
});
