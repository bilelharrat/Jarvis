// Eden Code checks' window helpers (web/features/code-verify.js). node --test tests/web/
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

test('a picture from the backend is shown only when it is plain base64', () => {
  assert.equal(cv.jpegSrc('QUJD'), 'data:image/jpeg;base64,QUJD');
  assert.equal(cv.jpegSrc('"><script>alert(1)</script>'), '');
  assert.equal(cv.jpegSrc(''), '');
  assert.equal(cv.jpegSrc(null), '');
});

test('a check’s headline says what was checked and how it went', () => {
  assert.deepEqual(cv.checkHead({ url: 'http://localhost:5173/', status: 'ok', findings: [] }), ['Preview check', 'No problems']);
  assert.deepEqual(cv.checkHead({ url: '', status: 'problems', findings: [{}], more: 2 }), ['Checks', '3 problems']);
  assert.deepEqual(cv.checkHead({ url: '', status: 'problems', findings: [{}] }), ['Checks', '1 problem']);
  assert.deepEqual(cv.checkHead({ status: 'skipped', findings: [] }), ['Checks', 'Nothing to check']);
});

test('a finding reads without the page’s own address', () => {
  assert.equal(cv.withoutOrigin('GET http://127.0.0.1:5173/api/items → 500', 'http://127.0.0.1:5173/'), 'GET /api/items → 500');
  assert.equal(cv.withoutOrigin('http://127.0.0.1:5173/src/App.tsx:12', 'http://127.0.0.1:5173/'), '/src/App.tsx:12');
  assert.equal(cv.withoutOrigin('https://cdn.example.com/x.js:1', 'http://127.0.0.1:5173/'), 'https://cdn.example.com/x.js:1');
  assert.equal(cv.withoutOrigin('TypeError', ''), 'TypeError');
});

test('a check whose page couldn’t be looked at reads as not checked', () => {
  assert.deepEqual(cv.checkHead({ url: 'http://localhost:5173/', status: 'skipped', findings: [] }), ['Preview check', 'Not checked']);
});

test('the logs view adds only the new lines, and takes the oldest off its start', () => {
  const lines = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => [a + i, `line ${a + i}`]);
  assert.equal(cv.logStep(null, lines(1, 3)), null);  // nothing shown yet: drawn whole
  assert.deepEqual(cv.logStep({ first: 1, last: 3 }, lines(1, 5)), { add: lines(4, 5), from: 1 });
  assert.deepEqual(cv.logStep({ first: 1, last: 3 }, lines(3, 6)), { add: lines(4, 6), from: 3 });
  assert.deepEqual(cv.logStep({ first: 1, last: 3 }, lines(1, 3)), { add: [], from: 1 });
  assert.equal(cv.logStep({ first: 1, last: 3 }, lines(5, 6)), null);  // a gap: drawn whole
  assert.equal(cv.logStep({ first: 4, last: 6 }, lines(1, 6)), null);  // older than shown (a new run)
  assert.equal(cv.logStep({ first: 1, last: 3 }, []), null);
});

test('the Tests pane’s output is drawn as the logs view is: the new lines only, the same text as drawn whole', () => {
  const lines = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => [a + i, `line ${a + i}`]);
  // A <pre> stand-in: its text is its nodes' text, as the browser's.
  const pre = { nodes: [], appended: 0, append(n) { n.pre = this; this.nodes.push(n); this.appended += 1; },
    set textContent(v) { this.nodes = v ? [{ data: v }] : []; }, get text() { return this.nodes.map((n) => n.data).join(''); } };
  const node = (data) => ({ data, remove() { this.pre.nodes = this.pre.nodes.filter((x) => x !== this); } });
  const whole = (ls) => ls.map(([, l]) => l).join('\n');
  let shown = cv.paintLines(pre, [], null, 'Nothing yet.', node);
  assert.equal(shown, null);
  assert.equal(pre.text, 'Nothing yet.');
  let out = lines(1, 250);
  shown = cv.paintLines(pre, out, shown, 'Nothing yet.', node);
  assert.equal(pre.text, whole(out));
  const before = pre.appended;
  out = lines(1, 260);  // a batch of ten more: one node added, nothing drawn again
  shown = cv.paintLines(pre, out, shown, 'Nothing yet.', node);
  assert.equal(pre.appended - before, 1);
  assert.equal(pre.text, whole(out));
  out = lines(180, 400);  // kept to the newest: the oldest come off the start
  shown = cv.paintLines(pre, out, shown, 'Nothing yet.', node);
  assert.equal(pre.text, whole(out));
  out = lines(1, 5);  // a new run numbers from 1 again: drawn whole
  shown = cv.paintLines(pre, out, shown, 'Nothing yet.', node);
  assert.equal(pre.text, whole(out));
});

test('a run told without its tree asks for it, unless the whole one came first', () => {
  const running = { started: 1, status: 'running', tree: [] };
  const slim = { started: 1, status: 'failed', slim: true, tree: [], counts: { passed: 3, failed: 1, skipped: 0 } };
  const whole = { started: 1, status: 'failed', tree: [{ file: 'a.py', cases: [] }], counts: slim.counts };
  assert.deepEqual(cv.takeRun(running, slim), { run: slim, fresh: false, ask: true });
  assert.deepEqual(cv.takeRun(slim, whole), { run: whole, fresh: false, ask: false });
  assert.deepEqual(cv.takeRun(whole, slim), { run: whole, fresh: false, ask: false });
  // A run with nothing to show, or one starting: nothing to ask for.
  assert.equal(cv.takeRun(null, { ...slim, counts: { passed: 0, failed: 0, skipped: 0 } }).ask, false);
  assert.deepEqual(cv.takeRun(whole, { started: 2, status: 'running', tree: [] }).fresh, true);
});

test('a failure’s whole message takes the cut one’s place', () => {
  const run = { tree: [{ file: '(no file)', cases: [{ name: 'x', message: 'abc', more: 9000 }] }] };
  assert.equal(cv.fullMessage(run, { file: '', name: 'y', message: 'no' }), false);
  assert.equal(cv.fullMessage(run, { file: '', name: 'x', message: 'abcdef' }), true);
  assert.deepEqual(run.tree[0].cases[0], { name: 'x', message: 'abcdef' });
});
