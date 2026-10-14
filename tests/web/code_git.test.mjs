// Eden Code's Git pane (web/features/code_git.js): what it says while it waits, when the
// folder isn't a repository, and when the backend couldn't look at all (it says why, with
// Try again, instead of "Loading…" for good). node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { paneMessage } = require('../../src/jarvis/web/features/code_git.js');

test('the Git pane waits, says it isn’t a repository, or says why it couldn’t look', () => {
  assert.deepEqual(paneMessage(undefined), { text: 'Loading…', retry: false });
  assert.deepEqual(paneMessage({ repo: false }), { text: 'This folder isn’t a git repository.', retry: false });
  assert.deepEqual(paneMessage({ repo: null, error: 'That session isn’t open anymore.' }), { text: 'That session isn’t open anymore.', retry: true });
  assert.equal(paneMessage({ repo: true, staged: [], unstaged: [] }), null);
});
