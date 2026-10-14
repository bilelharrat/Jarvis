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

test('the hook’s address is the tunnel’s, the hook’s path and its token, never the window’s', () => {
  assert.equal(trg.hookAddress('http://127.0.0.1:5199/', '/hooks/eden-slack?token=abc'), 'http://127.0.0.1:5199/hooks/eden-slack?token=abc');
  assert.equal(trg.hookAddress('http://127.0.0.1:5199', ''), '');
  assert.equal(trg.hookShape('linear', '/hooks/eden-linear?token=abc'), 'https://<tunnel address>/hooks/eden-linear?token=abc');
  assert.equal(trg.hookShape('slack', ''), 'https://<tunnel address>/hooks/eden-slack?token=<token>');
  const source = readFileSync(new URL('../../src/jarvis/web/features/code-triggers.js', import.meta.url), 'utf8');
  assert.ok(!source.includes('location.origin'));  // (the window's server is no tunnel's target)
});

test('the tunnel’s command points at the hooks’ own listener and its port', () => {
  assert.equal(trg.tunnelCommand(8766), 'cloudflared tunnel --url http://127.0.0.1:8766');
  assert.equal(trg.tunnelCommand(9123), 'cloudflared tunnel --url http://127.0.0.1:9123');
  assert.equal(trg.tunnelCommand(undefined), 'cloudflared tunnel --url http://127.0.0.1:8766');
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
    'Paste this, with the address the tunnel printed in place of <tunnel address>.', 'The tunnel',
  ];
  assert.deepEqual(shown.filter((s) => !(s in zh.strings)), []);
});

// Audit G9: a port out of range is said beside Save, instead of a Save that does nothing.
test('the tunnel’s port: from 1024 to 65535, whole, or it says why', () => {
  const { portProblem } = require('../../src/jarvis/web/features/code-triggers.js');
  for (const ok of ['8766', '1024', '65535', ' 9000 ']) assert.equal(portProblem(ok), '', ok);
  for (const bad of ['', '80', '70000', '8766.5', 'abc']) assert.match(portProblem(bad), /1024 to 65535/, bad);
});
