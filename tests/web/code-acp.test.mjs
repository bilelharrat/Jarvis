// Other coding agents over ACP, the Other agents pane's helpers (web/features/code-acp.js).
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ca = require('../../src/jarvis/web/features/code-acp.js');

test('the add form sends a name and a command, or says what’s missing', () => {
  assert.deepEqual(ca.formFor('  Codex  ', ' codex-acp '), [true, 'Codex', 'codex-acp']);
  assert.deepEqual(ca.formFor('', 'x'), [false, 'Give the agent a name, like Codex.']);
  assert.deepEqual(ca.formFor('Codex', '  '), [false, 'Type the command that starts it, like codex-acp.']);
  assert.equal(ca.formFor('x'.repeat(80), 'y')[1].length, 40);
  assert.ok(ca.EXAMPLES.every(([n, c]) => n && c));
});

test('every string the Other agents pane shows has its Chinese', () => {
  const zh = JSON.parse(readFileSync(new URL('../../src/jarvis/web/i18n/code-acp.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL('../../src/jarvis/web/features/code-acp.js', import.meta.url), 'utf8');
  const shown = [...source.matchAll(/(?<!mine\()el\('[a-z0-9]+', '[^']*', '([^']+)'\)/g)].map((m) => m[1]);
  const extra = ['Other agents', 'Codex, Gemini and others, over ACP', 'Other coding agents, over ACP', 'In the project on show',
    'Press again to remove', 'Name, like Codex', 'Its name', 'The command that starts it, like codex-acp', 'The command that starts it',
    'Give the agent a name, like Codex.', 'Type the command that starts it, like codex-acp.'];
  assert.deepEqual([...shown, ...extra].filter((s) => !(s in zh.strings)), []);
  for (const [re] of zh.patterns) assert.doesNotThrow(() => new RegExp(re));
});
