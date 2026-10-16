// Eden Code settings › Git hosts and Jira, and the Issues to pick up pane
// (web/features/code-hosts.js). node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { listOf, tokenHint, tokenState, issueLine, projectFor } = require('../../src/jarvis/web/features/code-hosts.js');

test('lists are split on commas and spaces, and capped', () => {
  assert.deepEqual(listOf('gitlab.a.dev, gitlab.b.dev\nx'), ['gitlab.a.dev', 'gitlab.b.dev', 'x']);
  assert.deepEqual(listOf('In Review, Code Review', /,/), ['In Review', 'Code Review']);
  assert.equal(listOf(Array.from({ length: 40 }, (_, i) => `h${i}`).join(' ')).length, 20);
  assert.deepEqual(listOf(''), []);
});

test('a token is only ever said to be set, never shown; a CLI may lend one', () => {
  assert.equal(tokenState({ kind: 'gitlab', has: true, cli: true }), 'Set: kept in the Keychain.');
  assert.equal(tokenState({ kind: 'gitlab', has: false, cli: true }), 'Not set: glab’s sign-in is used.');
  assert.equal(tokenState({ kind: 'azure', has: false, cli: true }), 'Not set: the Azure CLI’s sign-in is used.');
  assert.equal(tokenState({ kind: 'bitbucket', has: false, cli: false }), 'Not set.');
  for (const kind of ['gitlab', 'bitbucket', 'azure', 'jira']) assert.ok(tokenHint(kind));
});

test('an issue line is its key and title; the pane starts on the session’s own project', () => {
  assert.equal(issueLine({ key: 'SHOP-12', title: 'Checkout does nothing' }), 'SHOP-12 Checkout does nothing');
  assert.equal(projectFor({ folder: 'web' }, ['app', 'web']), 'web');
  assert.equal(projectFor({ folder: 'login-1a2b' }, ['app', 'web']), 'app');
  assert.equal(projectFor(null, []), '');
});

test('every sentence the window shows has its Chinese', () => {
  const zh = JSON.parse(readFileSync(new URL('../../src/jarvis/web/i18n/code-hosts.json', import.meta.url))).strings;
  for (const text of ['Git hosts and Jira', 'Issues to pick up', 'Pick up', 'View on GitLab',
    'Add a GitLab token in Eden Code settings › Git hosts and Jira to open and watch merge requests.']) {
    assert.ok(zh[text], text);
  }
});
