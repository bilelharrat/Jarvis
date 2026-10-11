// Trusting a project folder (web/features/code-trust.js, features/code_trust.py): the card's
// settled words, and the Chinese for everything it and the backend say. node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const trust = require('../../src/jarvis/web/features/code-trust.js');
const mcp = require('../../src/jarvis/web/features/code-mcp.js');

test('a trusted card says so; an untrusted folder\'s MCP server says it doesn\'t run', () => {
  assert.equal(trust.stateText(true), 'Trusted: its sessions load this folder’s settings.');
  assert.equal(trust.stateText(false), '');
  assert.deepEqual(mcp.statusOf({ scope: 'project', approved: null, untrusted: true }), ['Off until you trust this folder', 'idle']);
  assert.deepEqual(mcp.statusOf({ scope: 'project', approved: null }), ['Waiting for your OK', 'idle']);
});

test('every string of the trust card has its Chinese', () => {
  const zh = JSON.parse(readFileSync(new URL('../../src/jarvis/web/i18n/code-trust.json', import.meta.url), 'utf8')).strings;
  const js = readFileSync(new URL('../../src/jarvis/web/features/code-trust.js', import.meta.url), 'utf8');
  const py = readFileSync(new URL('../../src/jarvis/features/code_trust.py', import.meta.url), 'utf8');
  const shown = [...js.matchAll(/el\('[a-z]+', '[^']*', (?:e\.again \? )?'([^']+)'(?: : '([^']+)')?\)/g)].flatMap((m) => [m[1], m[2]]).filter(Boolean);
  const said = [...py.matchAll(/^(?:CARD|TRUSTED|FORGOTTEN) = "([^"]+)"$/gm)].map((m) => m[1]);
  assert.equal(said.length, 3);
  for (const text of [...shown, ...said, trust.stateText(true)]) assert.ok(text in zh, text);
});
