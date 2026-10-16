// Eden Code's language servers in the window (web/features/code-lsp.js): their chips, the
// notes for a server that isn't installed, the states kept, the run line's counts; and the
// Problems pane's door for other sources (web/features/code-verify.js). node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const lsp = require('../../src/jarvis/web/features/code-lsp.js');

test('a server’s chip says its language and its program, or only the language when it isn’t there', () => {
  assert.deepEqual(lsp.serverChip({ status: 'ready', label: 'Python', name: 'basedpyright-langserver' }), ['Python · basedpyright-langserver', '']);
  assert.deepEqual(lsp.serverChip({ status: 'starting', label: 'Go', name: 'gopls' }), ['Go · gopls', 'busy']);
  assert.deepEqual(lsp.serverChip({ status: 'installed', label: 'Go', name: 'gopls' }), ['Go · gopls', 'idle']);
  assert.deepEqual(lsp.serverChip({ status: 'missing', label: 'Rust', name: '' }), ['Rust', 'off']);
  assert.deepEqual(lsp.serverChip(null), ['', 'off']);
});

test('only servers not installed or held off get a note', () => {
  const servers = [
    { id: 'python', status: 'ready' },
    { id: 'rust', status: 'missing', install: 'rustup component add rust-analyzer' },
    { id: 'go', status: 'held', why: 'used 5,000 MB' },
    { id: 'c', status: 'installed' },
  ];
  assert.deepEqual(lsp.notes(servers).map((s) => s.id), ['rust', 'go']);
  assert.deepEqual(lsp.notes(undefined), []);
});

test('the latest state of each project is kept, the oldest let go', () => {
  const map = new Map();
  lsp.remember(map, { path: '/a', problems: [1] }, 2);
  lsp.remember(map, { path: '/b', problems: [] }, 2);
  lsp.remember(map, { path: '/a', problems: [2] }, 2);  // the newest, and /a is now the latest
  lsp.remember(map, { path: '/c', problems: [] }, 2);
  assert.deepEqual([...map.keys()], ['/a', '/c']);
  assert.deepEqual(map.get('/a').problems, [2]);
  lsp.remember(map, null);
  lsp.remember(map, { problems: [] });
  assert.equal(map.size, 2);
});

test('the run line counts errors and warnings as the checkers’ does', () => {
  assert.deepEqual(lsp.summary([]), ['No problems']);
  assert.deepEqual(lsp.summary([{ severity: 'error' }, { severity: 'warning' }, { severity: 'info' }]), ['1 error', '2 warnings']);
});

test('the Problems pane asks its other sources and draws their sections under the checkers’', () => {
  const src = readFileSync(new URL('../../src/jarvis/web/features/code-verify.js', import.meta.url), 'utf8');
  assert.match(src, /root\.edenProblemSources = root\.edenProblemSources \|\| \[\]/);
  assert.match(src, /root\.edenProblemsRedraw = \(\) => renderProblems\(\)/);
  assert.match(src, /for \(const source of problemSources\) if \(source\.ask\) source\.ask\(where\(\)\)/);
  // With no checkers at all, the sources still show (a project with only a language server).
  assert.match(src, /are looked for\.'\), \.\.\.extraProblems\(info\)\)/);
  const mine = readFileSync(new URL('../../src/jarvis/web/features/code-lsp.js', import.meta.url), 'utf8');
  assert.match(mine, /type: 'lsp_state'/);
  assert.match(mine, /type: 'lsp_fix'/);
  assert.match(mine, /code_lsp_live/);
});
