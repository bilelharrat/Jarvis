// Jarvis Code sessions in the window (web/features/code-sessions.js): which rows the sidebar
// shows, /goal's words, snippets as commands, and a project's own defaults in the composer.
// node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const sessions = require('../../src/jarvis/web/features/code-sessions.js');

test('the sidebar filter: archived rows only under Archived, a group only its own, the open one always', () => {
  const { rowShown } = sessions;
  const plain = {}, archived = { archived: true }, api = { group: 'API' }, apiArchived = { group: 'API', archived: true };
  assert.deepEqual([plain, archived, api].map((m) => rowShown(m, 'all', false)), [true, false, true]);
  assert.deepEqual([plain, archived, apiArchived].map((m) => rowShown(m, 'archived', false)), [false, true, true]);
  assert.deepEqual([plain, api, apiArchived].map((m) => rowShown(m, 'g:API', false)), [false, true, false]);
  assert.equal(rowShown(archived, 'all', true), true);  // the session open now never disappears
  assert.equal(rowShown(undefined, 'all', false), true);  // a session the hub hasn't described yet
});

test('/goal: a command word, or the goal itself (a new one, or a change to the one there)', () => {
  const { goalAction } = sessions;
  assert.deepEqual(goalAction('', false), { action: '' });
  assert.deepEqual(goalAction('all tests pass', false), { action: 'set', text: 'all tests pass' });
  assert.deepEqual(goalAction('  ship the fix  ', true), { action: 'edit', text: 'ship the fix' });
  for (const [word, action] of [['clear', 'clear'], ['OFF', 'clear'], ['pause', 'pause'], ['resume', 'resume'], ['done', 'complete']]) {
    assert.equal(goalAction(word, true).action, action, word);
  }
});

test('snippets become / commands that insert their words, never over a built-in or twice', () => {
  const { snippetCommands } = sessions;
  const long = 'Review the diff for bugs. '.repeat(10);
  const out = snippetCommands([
    { name: 'review', text: long },
    { name: 'review', text: 'again' },
    { name: 'plan', text: 'shadowed' },
    { name: 'tests', text: 'Run the tests\nand fix them' },
    null, { name: 5, text: 'x' },
  ], ['plan', 'btw', 'goal']);
  assert.deepEqual(out.map((c) => c.name), ['review', 'tests']);
  assert.equal(out[0].insert, long);  // as saved, to edit before it's sent
  assert.ok(out[0].help.startsWith('Snippet · Review the diff') && out[0].help.endsWith('…') && out[0].help.length < 80);
  assert.equal(out[1].help, 'Snippet · Run the tests and fix them');
  assert.deepEqual(snippetCommands('nope', []), []);
});

test('a project’s own defaults show in the composer, and a composer change there becomes its own', () => {
  const { effectiveDefaults, movedDefaults } = sessions;
  const global = { mode: 'ask', model: '', effort: '', ultracode: false };
  assert.deepEqual(effectiveDefaults(global, { mode: 'plan', effort: 'max' }), { mode: 'plan', model: '', effort: 'max', ultracode: false });
  assert.deepEqual(effectiveDefaults(global, null), global);
  const before = { code_mode: 'ask', code_model: '', code_effort: '', code_ultracode: false };
  const after = { ...before, code_mode: 'edits', code_model: 'sonnet' };
  // Only what the project sets for itself moves; the rest stays Jarvis Code's default.
  assert.deepEqual(movedDefaults(before, after, { mode: 'plan' }), { mode: 'edits' });
  assert.deepEqual(movedDefaults(before, after, null), {});
  assert.deepEqual(movedDefaults(null, after, { mode: 'plan' }), {});
});
