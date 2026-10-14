// Stacked pull requests, the Stack pane's helpers (web/features/code-stack.js).
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const cs = require('../../src/jarvis/web/features/code-stack.js');

const parts = () => [
  { title: 'One', hunks: [{ id: 'a', path: 'src/a.py', line: 3, added: 2, removed: 1 }, { id: 'b', path: 'src/b.py' }] },
  { title: 'Two', hunks: [{ id: 'c', path: 'tests/t.py', line: 1, added: 1, removed: 0, where: 'test_a' }] },
];

test('a change moves to another part, or to a new one', () => {
  const moved = cs.moveHunk(parts(), 'a', 1);
  assert.deepEqual(moved.map((p) => p.hunks.map((h) => h.id)), [['b'], ['c', 'a']]);
  const fresh = cs.moveHunk(parts(), 'c', 2);
  assert.deepEqual(fresh.map((p) => p.hunks.map((h) => h.id)), [['a', 'b'], [], ['c']]);
  assert.equal(fresh[2].title, '');
  assert.deepEqual(cs.moveHunk(parts(), 'nope', 0), parts());
});

test('parts reorder, and go back to the backend as titles and ids', () => {
  assert.deepEqual(cs.movePart(parts(), 1, -1).map((p) => p.title), ['Two', 'One']);
  assert.deepEqual(cs.movePart(parts(), 0, -1).map((p) => p.title), ['One', 'Two']);
  assert.deepEqual(cs.toMessage([{ title: ' One ', hunks: [{ id: 'a' }] }]), [{ title: 'One', hunks: ['a'] }]);
  assert.equal(cs.hunkLabel(parts()[0].hunks[0]), 'src/a.py:3 (+2 −1)');
  assert.equal(cs.hunkLabel(parts()[1].hunks[0]), 'tests/t.py:1 (+1 −0) test_a');
});

test('every string the Stack pane shows has its Chinese', () => {
  const zh = JSON.parse(readFileSync(new URL('../../src/jarvis/web/i18n/code-stack.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL('../../src/jarvis/web/features/code-stack.js', import.meta.url), 'utf8');
  const shown = [
    ...[...source.matchAll(/(?<!mine\()el\('[a-z0-9]+', '[^']*', '([^']+)'\)/g)].map((m) => m[1]),
    ...[...source.matchAll(/button\('([^']{2,})'/g)].map((m) => m[1]),
    ...[...source.matchAll(/t\('([^']+)'\)/g)].map((m) => m[1]),
    ...Object.values(cs.WHY), 'Merged', 'Closed', 'Open', 'Stacked pull requests',
  ];
  assert.deepEqual(shown.filter((s) => !(s in zh.strings)), []);
});
