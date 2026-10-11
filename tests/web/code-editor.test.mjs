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

// Round 1 bug sweep (askeden/docs/bug-sweep/r1-eden-code-workspace.md).

test('Replace All finds every match, past the count’s 10,000 (CF14)', () => {
  const text = 'a '.repeat(25000);
  assert.equal(E.findAll(text, 'a').ranges.length, 10000);
  assert.equal(E.findAll(text, 'a', { max: Infinity }).ranges.length, 25000);
});

test('line numbers worked out without rebuilding them all (CF11)', () => {
  assert.equal(E.lineCount(''), 1);
  assert.equal(E.lineCount('a\nb\n'), 3);
  assert.equal(E.numbersText(9, 11), '9\n10\n11\n');
  for (const n of [1, 9, 10, 99, 100, 999, 1000, 20001]) assert.equal(E.numbersLength(n), E.numbersText(1, n).length, String(n));
});

test('a big project’s list says it’s partial (CF5)', () => {
  assert.equal(E.listedNote(6000, 100000), '6,000 of 100,000 files listed: what you type is looked for in all of them.');
});

test('an edit of very many lines skips the box’s typing, whose time grows with their square (CF14)', () => {
  assert.equal(E.undoable('x\n'.repeat(800)), true);
  assert.equal(E.undoable('x\n'.repeat(801)), false);
  assert.equal(E.undoable('one line'), true);
});

// Round-1 optimization (askeden/docs/bug-sweep/r1-optimize-client-compute.md): big files open in a
// read-only view that draws only the rows in sight; "Edit anyway" gives the text box.
test('which files open in the fast view, and its rows (a long line is several rows)', () => {
  assert.equal(E.bigView('x'.repeat(E.BIG_VIEW_CHARS)), false);
  assert.equal(E.bigView('x'.repeat(E.BIG_VIEW_CHARS + 1)), true);
  assert.equal(E.bigView('a\n'.repeat(E.BIG_VIEW_LINES - 1)), false);  // 20,000 lines
  assert.equal(E.bigView('a\n'.repeat(E.BIG_VIEW_LINES)), true);  // 20,001
  const text = 'ab\ncdefg\n\nh';
  const rows = E.viewRows(text, 2);
  assert.deepEqual(rows.line, [1, 2, 0, 0, 3, 4]);
  assert.deepEqual(rows.start.map((s, i) => text.slice(s, rows.end[i])), ['ab', 'cd', 'ef', 'g', '', 'h']);
  assert.equal(E.rowOf(rows, 0), 0);
  assert.equal(E.rowOf(rows, 6), 2);  // the "f" of "cdefg"
  assert.equal(E.rowOf(rows, text.length), 5);
  // a 1 MB one-line file: 500 rows of 2,000 characters, nothing lost
  const line = 'v'.repeat(1_000_000);
  const r = E.viewRows(line);
  assert.equal(r.count, 500);
  assert.equal(r.start.map((s, i) => line.slice(s, r.end[i])).join(''), line);
  assert.equal(E.viewRows('').count, 1);
  assert.equal(E.viewRows('a\n').count, 2);  // the empty last line is a row too
});
