// Claude Code's plugins in Jarvis Code, the Plugins pane's helpers (web/features/code-plugins.js).
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const cx = require('../../src/jarvis/web/features/code-plugins.js');

test('a search keeps the plugins whose name, description or marketplace fit', () => {
  const all = [
    { id: 'lint@tools', name: 'lint', description: 'Lints things', marketplace: 'tools' },
    { id: 'pdf@docs', name: 'pdf', description: 'Reads PDF files', marketplace: 'docs' },
  ];
  assert.deepEqual(cx.filterAvailable(all, '').map((p) => p.id), ['lint@tools', 'pdf@docs']);
  assert.deepEqual(cx.filterAvailable(all, 'PDF').map((p) => p.id), ['pdf@docs']);
  assert.deepEqual(cx.filterAvailable(all, 'tools').map((p) => p.id), ['lint@tools']);
  assert.deepEqual(cx.filterAvailable(null, 'x'), []);
  assert.equal(cx.filterAvailable(Array.from({ length: 80 }, (_, i) => ({ id: `p${i}`, name: `p${i}` })), '').length, 60);
});

test('tokens read short, and a new file’s name is one the backend takes', () => {
  assert.deepEqual([25, 1200, 1000, 45250].map(cx.fmtTokens), ['25', '1.2k', '1k', '45.3k']);
  assert.equal(cx.cleanName('agents', ' reviewer '), 'reviewer');
  assert.equal(cx.cleanName('agents', 'a/b'), '');
  assert.equal(cx.cleanName('commands', 'git/ship'), 'git/ship');
  assert.equal(cx.cleanName('commands', 'a/b/c'), '');
  assert.equal(cx.cleanName('skills', '../x'), '');
  assert.equal(cx.cleanName('skills', ''), '');
});

test('every string the Plugins pane shows has its Chinese', () => {
  const zh = JSON.parse(readFileSync(new URL('../../src/jarvis/web/i18n/code-plugins.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL('../../src/jarvis/web/features/code-plugins.js', import.meta.url), 'utf8');
  const shown = [...source.matchAll(/(?<!mine\()el\('[a-z0-9]+', '[^']*', '([^']+)'\)/g)].map((m) => m[1]);
  const buttons = [...source.matchAll(/button\('([^']+)'/g), ...source.matchAll(/twice\([^,]+, '([^']+)', '([^']+)'/g)].flatMap((m) => m.slice(1));
  const extra = [...Object.values(cx.KINDS), 'Hide what’s in it', 'Check again', 'This project, shared', 'This project, just me',
    'All my projects', 'This project', 'On', 'The file', 'What to make', 'For', 'A name, like reviewer', 'Its name',
    'A name is letters, digits, dots, dashes or underscores.', 'Search the marketplaces’ plugins', 'Search plugins',
    'owner/repo, an address or a folder', 'A marketplace to add', 'Plugins', 'Plugins and skills',
    'Plugins, agents, skills, commands and hooks', 'Plugins, agents, skills and hooks', 'Agents', 'Skills', 'MCP servers', 'Memory files'];
  assert.deepEqual([...shown, ...buttons, ...extra].filter((s) => !(s in zh.strings)), []);
  for (const [re] of zh.patterns) assert.doesNotThrow(() => new RegExp(re));
});
