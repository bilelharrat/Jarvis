// Linear and Slack triggers, the settings' helpers (web/features/code-triggers.js).
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const trg = require('../../src/jarvis/web/features/code-triggers.js');

test('people, commands and channels are read from what the owner types', () => {
  assert.deepEqual(trg.listOf(' boss-id, dev@example.com\nU0X '), ['boss-id', 'dev@example.com', 'U0X']);
  assert.deepEqual(trg.listOf('npm test, uv run pytest', /,/), ['npm test', 'uv run pytest']);
  assert.deepEqual(trg.listOf(''), []);
  assert.deepEqual(trg.channelsOf('c0123abcd app, #C0456EFGH my web\nC0789'), [
    { id: 'C0123ABCD', project: 'app' }, { id: 'C0456EFGH', project: 'my web' },
  ]);
});

test('the hook’s address is the window’s origin and the hook’s path', () => {
  assert.equal(trg.hookAddress('http://127.0.0.1:5199/', '/hooks/eden-slack?token=abc'), 'http://127.0.0.1:5199/hooks/eden-slack?token=abc');
  assert.equal(trg.hookAddress('http://127.0.0.1:5199', ''), '');
});

test('every string the settings show has its Chinese', () => {
  const zh = JSON.parse(readFileSync(new URL('../../src/jarvis/web/i18n/code-triggers.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL('../../src/jarvis/web/features/code-triggers.js', import.meta.url), 'utf8');
  const shown = [
    ...[...source.matchAll(/(?<!mine\()el\('[a-z0-9]+', '[^']*', '([^']+)'\)/g)].map((m) => m[1]),
    ...[...source.matchAll(/row\('([^']+)', '([^']*)'/g)].flatMap((m) => [m[1], m[2]]).filter(Boolean),
    ...[...source.matchAll(/button\('([^']+)'/g)].map((m) => m[1]),
    ...[...source.matchAll(/\['[a-z_]+', '([^']+)'\]/g)].map((m) => m[1]),
    ...trg.STEPS.linear, ...trg.STEPS.slack,
    'On', 'Off', 'New token', 'Make one', 'Set: kept in the Keychain.', 'Not set.', 'The hook’s address',
    'Only through a tunnel: the port changes when the app restarts.',
  ];
  assert.deepEqual(shown.filter((s) => !(s in zh.strings)), []);
});
