// Subagent lanes, their window helpers (web/features/code-lanes.js). node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const cl = require('../../src/jarvis/web/features/code-lanes.js');

test('tokens, time and cost read as Claude Code says them', () => {
  assert.deepEqual([800, 45200, 1234567].map(cl.fmtTokens), ['800', '45.2k', '1.2M']);
  assert.deepEqual([12, 63, 3720].map(cl.fmtSeconds), ['12s', '1m 3s', '1h 2m']);
  assert.equal(cl.fmtCost(null), '');
  assert.equal(cl.fmtCost(0.004), '< $0.01');
  assert.equal(cl.fmtCost(0.083), '≈ $0.08');
  assert.equal(cl.fmtCost(0), '≈ $0.00');
});

test('lanes make a tree: each under the one that started it, in the order they started', () => {
  const lanes = [
    { id: 'a', parent: '' }, { id: 'b', parent: 'a' }, { id: 'c', parent: '' },
    { id: 'd', parent: 'b' }, { id: 'e', parent: 'ghost' }, { id: 'f', parent: 'a' },
  ];
  assert.deepEqual(cl.tree(lanes).map(([l, depth]) => `${l.id}${depth}`), ['a0', 'b1', 'd2', 'f1', 'c0', 'e0']);
  assert.deepEqual(cl.tree([]), []);
  // A loop in the parents (never from the backend) doesn't go round forever.
  assert.deepEqual(cl.tree([{ id: 'x', parent: 'y' }, { id: 'y', parent: 'x' }]).length, 0);
  assert.equal(cl.running([{ status: 'running' }, { status: 'stopping' }, { status: 'done' }]), 2);
});

test('every string the Subagents pane shows has its Chinese', () => {
  const zh = JSON.parse(readFileSync(new URL('../../src/jarvis/web/i18n/code-lanes.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL('../../src/jarvis/web/features/code-lanes.js', import.meta.url), 'utf8');
  const shown = [...source.matchAll(/el\('[a-z0-9]+', '[^']*', '([^']+)'\)/g)].map((m) => m[1]);
  assert.deepEqual(shown.filter((s) => !(s in zh.strings)), []);
});
