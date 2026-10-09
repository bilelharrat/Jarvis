// Eden Code's editor (web/features/code-editor.js), its pure helpers: where a line is,
// find and replace, which files a filter lists, how a file indents. node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const E = require('../../src/jarvis/web/features/code-editor.js');

test('line and column of a position, and where lines are', () => {
  const text = 'one\ntwo\n\nfour';
  assert.deepEqual(E.lineCol(text, 0), { line: 1, col: 1 });
  assert.deepEqual(E.lineCol(text, 5), { line: 2, col: 2 });
  assert.deepEqual(E.lineCol(text, 9), { line: 4, col: 1 });
  assert.deepEqual(E.lineSpan(text, 2), [4, 7]);
  assert.equal(text.slice(...E.lineSpan(text, 2, 4)), 'two\n\nfour');
  assert.deepEqual(E.lineSpan(text, 9), [text.length, text.length]);  // past the end
  assert.deepEqual(E.lineSpan('', 1), [0, 0]);
});

test('find: text or a regular expression, match case, whole words, and a bad expression', () => {
  const text = 'Retry retry RETRY retrying';
  assert.equal(E.findAll(text, 'retry').ranges.length, 4);
  assert.deepEqual(E.findAll(text, 'retry', { caseSensitive: true }).ranges, [[6, 11], [18, 23]]);
  assert.equal(E.findAll(text, 'retry', { word: true }).ranges.length, 3);
  assert.deepEqual(E.findAll('a.b axb', 'a.b').ranges, [[0, 3]]);  // text: the dot is a dot
  assert.equal(E.findAll('a.b axb', 'a.b', { regex: true }).ranges.length, 2);
  assert.match(E.findAll(text, 'retr(', { regex: true }).error, /./);
  assert.deepEqual(E.findAll(text, '').ranges, []);
  // An expression that matches nothing-long never loops.
  assert.deepEqual(E.findAll('abc', 'x*', { regex: true }).ranges, []);
  // At most 10,000.
  assert.equal(E.findAll('a'.repeat(20000), 'a').ranges.length, 10000);
});

test('replace: the text as typed, or with the expression’s groups', () => {
  assert.equal(E.replacement('retry(3)', 'retry', 'again'), 'again');
  assert.equal(E.replacement('retry(3)', 'retry\\((\\d)\\)', 'again($1, 1)', { regex: true }), 'again(3, 1)');
  assert.equal(E.replacement('RETRY', 'retry', '[$&]', { regex: true }), '[RETRY]');
  assert.equal(E.replacement('x', '(', 'y', { regex: true }), 'y');  // a bad one: as typed
});

test('replace: an expression runs again where its match is, in the whole text, with find’s flags', () => {
  const first = (text, query, replace, opts = {}) => {
    const o = { regex: true, ...opts };
    const [[s, e]] = E.findAll(text, query, o).ranges;
    return E.replacement(text.slice(s, e), query, replace, o, text, s);
  };
  assert.equal(first('foobar', 'foo(?=bar)', 'X'), 'X');
  assert.equal(first('a.retry', '(?<=\\.)retry', 'again'), 'again');
  assert.equal(first('xfoo', '\\Bfoo', 'bar'), 'bar');
  assert.equal(first('one\ntwo', '^two', 'TWO'), 'TWO');
  assert.equal(first('RETRY(3)', 'retry\\((\\d)\\)', 'again($1, $$, $&)'), 'again(3, $, RETRY(3))');
  assert.equal(first('k=v', '(?<key>\\w)=(?<val>\\w)', '$<val>=$<key>'), 'v=k');
  assert.equal(first('Cat cat', 'cat', '[$&]', { caseSensitive: true }), '[cat]');
});

test('the file list: name matches first, shorter first; with no filter, the ones opened lately', () => {
  const files = ['src/jarvis/hub.py', 'tests/test_hub.py', 'src/jarvis/web/hubble.js', 'docs/github.md', 'README.md'];
  // hub.py and hubble.js start with it; github.md and test_hub.py only have it (shorter first).
  assert.deepEqual(E.rankFiles(files, 'hub'), ['src/jarvis/hub.py', 'src/jarvis/web/hubble.js', 'docs/github.md', 'tests/test_hub.py']);
  assert.deepEqual(E.rankFiles(files, 'HUB.PY'), ['src/jarvis/hub.py', 'tests/test_hub.py']);
  assert.deepEqual(E.rankFiles(files, '', ['README.md', 'gone.py']).slice(0, 2), ['README.md', 'src/jarvis/hub.py']);
  assert.equal(E.rankFiles(Array.from({ length: 500 }, (_, i) => `f${i}.py`), 'f').length, 200);
});

test('how a file indents, and outdenting by that much', () => {
  assert.equal(E.indentUnit('def f():\n    return 1\n'), '    ');
  assert.equal(E.indentUnit('{\n  "a": 1\n}'), '  ');
  assert.equal(E.indentUnit('func f() {\n\treturn\n}'), '\t');
  assert.equal(E.indentUnit('no indent at all'), '    ');
  const [out, cut] = E.outdent(['    a', '  b', 'c', '\td'], '    ');
  assert.deepEqual(out, ['a', 'b', 'c', 'd']);
  assert.deepEqual(cut, [4, 2, 0, 1]);
});

test('which files preview as what they are', () => {
  assert.equal(E.previewKind('README.md'), 'markdown');
  assert.equal(E.previewKind('data/x.TSV'), 'csv');
  assert.equal(E.previewKind('hub.py'), '');
});
