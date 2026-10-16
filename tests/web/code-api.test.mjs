// Eden Code settings › Control from code (web/features/code-api.js; the backend is
// features/code_api.py and code_automate.py): the switches send their commands (the backend
// puts each on its Touch ID card), the token shows only when asked and as data, a watch's
// pattern is checked before it's sent, and a webhook's address and signing example.
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';
import { elFor, load, makeDocument } from './fixtures/stand-dom.mjs';

const require = createRequire(import.meta.url);
const pure = require('../../src/jarvis/web/features/code-api.js');
const source = readFileSync(new URL('../../src/jarvis/web/features/code-api.js', import.meta.url), 'utf8');

test('the addresses, and how to sign a delivery', () => {
  assert.equal(pure.apiAddress(9001), 'http://127.0.0.1:9001');
  assert.equal(pure.apiAddress('x'), 'http://127.0.0.1:8767');
  assert.equal(pure.hookAddress(8768, '/hooks/eden-code-hook?hook=ab'), 'http://127.0.0.1:8768/hooks/eden-code-hook?hook=ab');
  const curl = pure.curlExample(8768, '/hooks/eden-code-hook?hook=ab');
  assert.match(curl, /X-Eden-Timestamp: \$TS/);
  assert.match(curl, /X-Eden-Signature: sha256=\$SIG/);
  assert.match(curl, /openssl dgst -sha256 -hmac "\$EDEN_HOOK_SECRET"/);
  assert.ok(!/whsec_/.test(curl));  // (the secret is the owner's to paste, never in the example)
});

test('a pattern stays inside the project, as the backend checks it', () => {
  assert.equal(pure.patternProblem('src/**/*.py'), '');
  for (const bad of ['', '/etc/*', '~/x', '../x/*', 'a/../../b', 'a\\b']) assert.ok(pure.patternProblem(bad), bad);
  assert.deepEqual(pure.commandsOf('npm test, uv run pytest\n make'), ['npm test', 'uv run pytest', 'make']);
});

function stand() {
  const document = makeDocument();
  const el = elFor(document);
  const general = el('div');
  general.id = 'jcs-general';
  general.append(el('div', 'jcs-foot'));
  document.body.append(general);
  const handlers = {};
  const sent = [];
  const F = { el, t: (x) => x, send: (m) => { sent.push(m); return true; }, on: (type, fn) => { (handlers[type] ||= []).push(fn); } };
  load(source, { window: { jarvisFeatures: F }, document, deckProjects: [{ name: 'app' }], navigator: { clipboard: { writeText() {} } } });
  const fire = (type, ev) => { for (const fn of handlers[type] || []) fn(ev); };
  return { document, fire, sent };
}

const byText = (root, text) => root.querySelectorAll('button').find((b) => b.textContent === text);

test('the switch asks the backend; the token shows only when asked, as data', () => {
  const w = stand();
  w.fire('hello', {});
  assert.deepEqual(w.sent.map((m) => m.type), ['code_api_state', 'code_automate_state']);
  const group = w.document.querySelector('.jcx-api');
  const toggle = group.querySelector('[role="switch"]');
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  toggle.click();
  assert.deepEqual(w.sent.at(-1), { type: 'code_api_turn', on: true });
  w.fire('code_api', { on: true, port: 8767, listening: true, error: '', has_token: true, cli: { installed: false, path: '/u/.local/bin/eden-code' } });
  assert.ok(!group.textContent.includes('edc_'));
  byText(group, 'Show').click();
  assert.deepEqual(w.sent.at(-1), { type: 'code_api_token', action: 'show' });
  w.fire('code_api_token', { token: 'edc_secret' });
  const shown = group.querySelector('.jcx-api-token');
  assert.equal(shown.textContent, 'edc_secret');
  assert.ok(shown.hasAttribute('data-no-i18n'));
  byText(group, 'Hide').click();
  assert.ok(!group.textContent.includes('edc_secret'));
  byText(group, 'Install').click();
  assert.deepEqual(w.sent.at(-1), { type: 'code_api_install_cli' });
  w.fire('code_api', { on: false, port: 8767, listening: false, error: '', has_token: true, cli: {} });
  assert.ok(!group.querySelector('.jcx-api-token'));
});

test('a watch with a pattern outside the project is never sent', () => {
  const w = stand();
  w.fire('code_automate', { on: true, watches: [], hooks: [], listener: { port: 8768, on: false, error: '' } });
  const form = w.document.querySelector('.jcx-api-form');
  const inputs = form.querySelectorAll('input');
  inputs[0].value = '../../etc/*';
  inputs[0].dispatchEvent(w.document.event('input'));
  inputs[1].value = 'Run the tests';
  inputs[1].dispatchEvent(w.document.event('input'));
  form.dispatchEvent(w.document.event('submit'));
  assert.ok(!w.sent.some((m) => m.type === 'code_watch_add'));
  inputs[0].value = 'src/**/*.py';
  inputs[0].dispatchEvent(w.document.event('input'));
  form.dispatchEvent(w.document.event('submit'));
  assert.deepEqual(w.sent.at(-1), { type: 'code_watch_add', project: 'app', glob: 'src/**/*.py', prompt: 'Run the tests', commands: [], spend_cap: 5 });
});
