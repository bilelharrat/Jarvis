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
