// Eden Code's project search (web/features/code-search.js), its pure helpers: a line cut
// by where it matched, what a result says, and the composer's @-mentions. node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const S = require('../../src/jarvis/web/features/code-search.js');

test('a line in pieces, the matched ones marked', () => {
  assert.deepEqual(S.pieces('return retry(n)', [[7, 12]]), [['return ', false], ['retry', true], ['(n)', false]]);
  assert.deepEqual(S.pieces('aXbX', [[3, 4], [1, 2]]), [['a', false], ['X', true], ['b', false], ['X', true]]);
  // Spans that overlap, are empty or run past the end are cut to what's there.
  assert.deepEqual(S.pieces('abc', [[0, 2], [1, 3], [2, 2], [2, 99]]), [['ab', true], ['c', true]]);
  assert.deepEqual(S.pieces('plain', []), [['plain', false]]);
  assert.deepEqual(S.pieces('', [[0, 1]]), []);
});

test('what a result says', () => {
  assert.equal(S.summary({ total: 1, files: [{}] }), '1 match in 1 file');
  assert.equal(S.summary({ total: 12, files: [{}, {}, {}] }), '12 matches in 3 files');
  assert.equal(S.summary({ total: 2000, files: [{}, {}], truncated: true }), '2000 matches in 2 files (the first ones only)');
  assert.equal(S.summary({ total: 0, files: [] }), 'No matches.');
  assert.equal(S.summary({ total: 0, files: [], stopped: true }), 'Stopped before anything matched.');
  assert.equal(S.summary({ error: 'That’s too long to search for.' }), 'That’s too long to search for.');
  assert.equal(S.summary(null), '');
});

test('files mentioned in the composer, spaced from what’s there', () => {
  assert.equal(S.mentionText(['src/a.py'], ''), '@src/a.py ');
  assert.equal(S.mentionText(['a.py', 'b.py'], 'look at'), ' @a.py @b.py ');
  assert.equal(S.mentionText(['a.py'], 'look at '), '@a.py ');
});

test('the code index’s answer, drawn as places by meaning in rank order', () => {
  const r = S.meaningResult({
    ref: 'm1',
    results: [
      { path: 'src/app.py', line: 17, snippet_line: 15, snippet: 'class X:\n\n    async def wait(self):\n        pass', symbol: 'Uploader.wait', kind: 'method', why: 'meaning 0.81; words: retry' },
      { path: 'web/cart.ts', line: 5, snippet_line: 5, snippet: 'export function renderTotal(cart) {', symbol: '', kind: '', why: 'words: total' },
      { path: 'src/app.py', line: 6, snippet_line: 6, snippet: '', symbol: 'parse_config', kind: 'function', why: 'named parse_config' },
    ],
    note: '',
  });
  assert.equal(r.meaning, true);
  assert.deepEqual(r.files.map((f) => [f.path, f.symbol, f.matches[0].line, f.matches[0].text]), [
    ['src/app.py', 'method Uploader.wait', 17, '    async def wait(self):'],
    ['web/cart.ts', '', 5, 'export function renderTotal(cart) {'],
    ['src/app.py', 'function parse_config', 6, ''],
  ]);
  assert.equal(r.files[0].why, 'meaning 0.81; words: retry');
  assert.equal(S.summary(r), '3 places by meaning, best first');
  assert.deepEqual(S.uniquePaths(r.files), ['src/app.py', 'web/cart.ts']);
  assert.equal(S.summary(S.meaningResult({ results: [], note: 'By words and names only this time.' })), 'Nothing found by meaning. By words and names only this time.');
  assert.equal(S.summary(S.meaningResult({ results: [] })), 'Nothing found by meaning.');
  assert.equal(S.summary(S.meaningResult({ error: 'Search by meaning is off.' })), 'Search by meaning is off.');
});
