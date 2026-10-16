// Production alerts, the settings' helpers (web/features/code-alerts.js, features/code_alerts.py).
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const alr = require('../../src/jarvis/web/features/code-alerts.js');
const source = readFileSync(new URL('../../src/jarvis/web/features/code-alerts.js', import.meta.url), 'utf8');
const zh = JSON.parse(readFileSync(new URL('../../src/jarvis/web/i18n/code-alerts.json', import.meta.url), 'utf8'));

test('links are read from what the owner types, a service: prefix taken off', () => {
  assert.deepEqual(alr.linksOf('Backend app, web-frontend my web\nservice:checkout shop\nlonely'), [
    { name: 'backend', project: 'app' }, { name: 'web-frontend', project: 'my web' }, { name: 'checkout', project: 'shop' },
  ]);
  assert.deepEqual(alr.listOf('npm test, uv run pytest'), ['npm test', 'uv run pytest']);
});

test('the hook’s address is the tunnel’s, and the tunnel goes to the hooks’ own listener', () => {
  assert.equal(alr.hookShape('sentry', '/hooks/eden-sentry?token=abc'), 'https://<tunnel address>/hooks/eden-sentry?token=abc');
  assert.equal(alr.hookShape('datadog', ''), 'https://<tunnel address>/hooks/eden-datadog?token=<token>');
  assert.equal(alr.tunnelCommand(9123), 'cloudflared tunnel --url http://127.0.0.1:9123');
  assert.equal(alr.tunnelCommand(undefined), 'cloudflared tunnel --url http://127.0.0.1:8766');
  assert.ok(!source.includes('location.origin'));
});

test('the Datadog payload carries every field the backend reads, and only Datadog’s own sites are offered', () => {
  const fields = Object.keys(JSON.parse(alr.PAYLOAD));
  for (const f of ['id', 'alert_id', 'title', 'text', 'transition', 'tags', 'date', 'link', 'aggreg_key']) assert.ok(fields.includes(f), f);
  assert.ok(alr.HEADER.includes('X-Eden-Secret'));
  const py = readFileSync(new URL('../../src/jarvis/prod_alerts.py', import.meta.url), 'utf8');
  for (const site of alr.SITES) assert.ok(py.includes(`"${site}"`), site);
});

test('secrets are password fields, never echoed, and each control is labelled', () => {
  assert.match(source, /type: 'password'/);
  assert.match(source, /box\.setAttribute\('aria-label', t\(label\)\)/);
  assert.match(source, /setAttribute\('role', 'switch'\)/);
  assert.match(source, /warn\.setAttribute\('role', 'alert'\)/);
});

test('every string the settings show has its Chinese', () => {
  const shown = [
    ...[...source.matchAll(/(?<!mine\()el\('[a-z0-9]+', '[^']*', '([^']+)'\)/g)].map((m) => m[1]),
    ...[...source.matchAll(/row\('([^']+)', '([^']*)'/g)].flatMap((m) => [m[1], m[2]]).filter(Boolean),
    ...[...source.matchAll(/codeRow\('([^']+)', '([^']*)'/g)].flatMap((m) => [m[1], m[2]]).filter(Boolean),
    ...[...source.matchAll(/button\('([^']+)'/g)].map((m) => m[1]),
    ...[...source.matchAll(/\['[a-z_]+', '([^']+)'\]/g)].map((m) => m[1]),
    ...alr.STEPS.sentry, ...alr.STEPS.datadog,
    'On', 'Off', 'New token', 'Make one', 'Set: kept in the Keychain.', 'Not set.', 'The hook’s address',
    'Paste this, with the address the tunnel printed in place of <tunnel address>.', 'Being fixed', 'Waiting for your OK', 'Done',
  ];
  assert.ok(shown.length > 40);
  assert.deepEqual([...new Set(shown)].filter((s) => !(s in zh.strings)), []);
  const [pattern, out] = zh.patterns[0];
  assert.equal('Today: $3.50 spent.'.replace(new RegExp(pattern), out), '今天：已花费 $3.50。');
});
