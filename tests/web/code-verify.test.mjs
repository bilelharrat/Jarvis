// Jarvis Code checks' window helpers (web/features/code-verify.js). node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const cv = require('../../src/jarvis/web/features/code-verify.js');

test('a dev server’s state reads as the pane says it', () => {
  assert.deepEqual(cv.serverState(null), { text: 'Not running', dot: 'idle', live: false });
  assert.deepEqual(cv.serverState({ status: 'ready' }), { text: 'Running', dot: 'waiting', live: true });
  assert.deepEqual(cv.serverState({ status: 'starting' }), { text: 'Starting…', dot: 'busy', live: true });
  assert.equal(cv.serverState({ status: 'exited' }).dot, 'failed');
  assert.equal(cv.serverState({ status: 'stopped' }).live, false);
});

test('only addresses on this Mac are opened', () => {
  for (const url of ['http://localhost:5173/', 'http://127.0.0.1:8000', 'http://[::1]:3000/', 'https://app.localhost/']) {
    assert.ok(cv.isLocal(url), url);
  }
  for (const url of ['https://example.com', 'javascript:alert(1)', 'file:///etc/passwd', 'http://10.0.0.1:80', 'nonsense']) {
    assert.ok(!cv.isLocal(url), url);
  }
  assert.equal(cv.shortUrl('http://localhost:5173/'), 'localhost:5173');
  assert.equal(cv.shortUrl('http://127.0.0.1:8000/admin/'), '127.0.0.1:8000/admin/');
});

test('new log lines join what’s shown once each, and the oldest go past the limit', () => {
  let shown = cv.mergeLines([], [[1, 'a'], [2, 'b']]);
  shown = cv.mergeLines(shown, [[2, 'b'], [3, 'c']]);
  assert.deepEqual(shown, [[1, 'a'], [2, 'b'], [3, 'c']]);
  assert.deepEqual(cv.mergeLines(shown, [[4, 'd']], 2), [[3, 'c'], [4, 'd']]);
});

test('a problem becomes an @-mention of its file and line', () => {
  assert.equal(cv.mentionFor({ file: 'src/App.tsx', line: 12, col: 5 }), '@src/App.tsx#L12 ');
  assert.equal(cv.mentionFor({ file: 'README.md', line: null }), '@README.md ');
  assert.equal(cv.mentionFor({ file: '' }), '');
});

test('problems are counted and grouped by file in the order they came', () => {
  const list = [
    { file: 'b.ts', severity: 'error' }, { file: 'a.ts', severity: 'warning' }, { file: 'b.ts', severity: 'warning' },
  ];
  assert.deepEqual(cv.countProblems(list), { errors: 1, warnings: 2 });
  assert.deepEqual(cv.byFile(list).map(([f, items]) => [f, items.length]), [['b.ts', 2], ['a.ts', 1]]);
});

test('a test run’s line comes in pieces, each translated on its own', () => {
  assert.deepEqual(cv.runLine({ status: 'running', seconds: 12.2 }), ['Running…', '12 s']);
  assert.deepEqual(cv.runLine({ status: 'failed', seconds: 3.44, summary: '40 passed · 2 failed' }), ['40 passed', '2 failed', '3.4 s']);
  assert.deepEqual(cv.runLine({ status: 'error', seconds: 1, summary: '', message: 'The run exited with code 2 before it reported results.' }),
    ['The run exited with code 2 before it reported results.']);
  assert.deepEqual(cv.runLine(null), []);
});
