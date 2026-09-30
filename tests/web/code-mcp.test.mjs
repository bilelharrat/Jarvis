// Jarvis Code's MCP manager, the MCP servers pane's helpers (web/features/code-mcp.js).
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const cm = require('../../src/jarvis/web/features/code-mcp.js');

test('how a server is doing, in words', () => {
  assert.deepEqual(cm.statusOf({ status: 'connected', tools: 3 }), ['Connected · 3 tools', 'waiting']);
  assert.deepEqual(cm.statusOf({ status: 'connected', tools: 1 }), ['Connected · 1 tool', 'waiting']);
  assert.deepEqual(cm.statusOf({ status: 'needs-auth' }), ['Needs sign-in', 'failed']);
  assert.deepEqual(cm.statusOf({ status: 'connected', off: true }), ['Off in this session', 'idle']);
  assert.deepEqual(cm.statusOf({ scope: 'project', approved: null, status: 'connected' }), ['Waiting for your OK', 'idle']);
  assert.deepEqual(cm.statusOf({ scope: 'project', approved: false }), ['Refused here', 'idle']);
  assert.deepEqual(cm.statusOf({}), ['', 'idle']);
});

test('what can be done with a server', () => {
  assert.deepEqual(cm.actionsOf({ scope: 'project', approved: null, removable: true }, true, false), ['approve', 'refuse', 'remove']);
  assert.deepEqual(cm.actionsOf({ scope: 'user', status: 'needs-auth', kind: 'http', removable: true }, true, false), ['signin', 'reconnect', 'switch', 'remove']);
  assert.deepEqual(cm.actionsOf({ scope: 'user', status: 'needs-auth', kind: 'http', removable: true }, true, true), ['signing', 'switch', 'remove']);
  assert.deepEqual(cm.actionsOf({ scope: 'local', status: 'connected', kind: 'stdio', removable: true }, true, false), ['switch', 'remove']);
  assert.deepEqual(cm.actionsOf({ scope: 'other', status: 'connected', removable: false }, true, false), ['switch']);
  assert.deepEqual(cm.actionsOf({ scope: 'user', kind: 'stdio', removable: true }, false, false), ['remove']);  // not running
});

test('every string the MCP servers pane shows has its Chinese', () => {
  const zh = JSON.parse(readFileSync(new URL('../../src/jarvis/web/i18n/code-mcp.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL('../../src/jarvis/web/features/code-mcp.js', import.meta.url), 'utf8');
  const shown = [...source.matchAll(/(?<!mine\()el\('[a-z0-9]+', '[^']*', '([^']+)'\)/g)].map((m) => m[1]).filter((s) => !['HTTP', 'SSE'].includes(s));
  const buttons = [...source.matchAll(/button\('([^']+)'/g)].map((m) => m[1]);
  const extra = [...Object.values(cm.SCOPES), 'Waiting for your OK', 'Refused here', 'Off in this session', 'Connected', 'Connected · 1 tool',
    'Needs sign-in', 'Couldn’t start', 'Starting…', 'Turned off', 'Press again to remove', 'On in this session', 'Its address',
    'The command that starts it', 'Share with this session', 'Name, like github', 'It runs as', 'For', 'MCP servers'];
  const patterns = zh.patterns.map(([p]) => new RegExp(p));
  const missing = [...shown, ...buttons, ...extra, 'Connected · 12 tools'].filter((s) => !(s in zh.strings) && !patterns.some((re) => re.test(s)));
  assert.deepEqual(missing, []);
});
