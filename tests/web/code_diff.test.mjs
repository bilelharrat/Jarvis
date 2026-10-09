// Eden Code's diff view, its pure parts (web/features/code_diff.js): the highlighter,
// the words that changed inside a line, rows with their numbers and pairs, side by side,
// and the unchanged lines between hunks. node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const D = require('../../src/jarvis/web/features/code_diff.js');

const cls = (segs) => segs.filter(([c]) => c).map(([c, t]) => `${c}:${t}`);

test('files are highlighted by their language, and odd ones not at all', () => {
  assert.equal(D.langFor('src/app.py'), 'python');
  assert.equal(D.langFor('web/app.tsx'), 'js');
  assert.equal(D.langFor('Makefile'), 'shell');
  assert.equal(D.langFor('notes.weird'), '');
  const py = D.highlight('def run(x=1):  # go', 'python').segs;
  assert.deepEqual(cls(py), ['k:def', 'n:1', 'c:# go']);
  const js = D.highlight('const s = "a // not a comment"; // yes', 'js').segs;
  assert.deepEqual(cls(js), ['k:const', 's:"a // not a comment"', 'c:// yes']);
  assert.deepEqual(D.highlight('plain text', '').segs, [['', 'plain text']]);
  // Escaped quotes stay inside the string.
  assert.deepEqual(cls(D.highlight('x = "say \\"hi\\"" + y', 'js').segs), ['s:"say \\"hi\\""']);
  // SQL keywords in any case; JSON keys told from values.
  assert.deepEqual(cls(D.highlight('SELECT id FROM t', 'sql').segs), ['k:SELECT', 'k:FROM']);
  assert.deepEqual(cls(D.highlight('  "name": "jarvis", "on": true', 'json').segs), ['t:"name"', 's:"jarvis"', 't:"on"', 'k:true']);
});

test('comments and strings that run over lines carry on to the next one', () => {
  const first = D.highlight('/* a comment', 'js');
  assert.deepEqual(first.state, { open: { cls: 'c', end: '*/' } });
  const second = D.highlight('still */ let x', 'js', first.state);
  assert.deepEqual(cls(second.segs), ['c:still */', 'k:let']);
  const doc = D.highlight('text = """begin', 'python');
  assert.deepEqual(cls(D.highlight('end""" + x', 'python', doc.state).segs), ['s:end"""']);
  const tpl = D.highlight('const t = `line one', 'js');
  assert.equal(tpl.state.open.end, '`');
  // A shell's # inside a word isn't a comment.
  assert.deepEqual(cls(D.highlight('echo a#b # real', 'shell').segs), ['k:echo', 'c:# real']);
  // A very long line isn't highlighted at all (it would cost more than it shows).
  assert.equal(D.highlight('x'.repeat(3000), 'js').segs.length, 1);
});

test('only the words that changed are marked, and nothing when the whole line did', () => {
  const w = D.wordDiff('const total = price * count;', 'const total = price * quantity;');
  assert.deepEqual(w.a.map(([x, y]) => 'const total = price * count;'.slice(x, y)), ['count']);
  assert.deepEqual(w.b.map(([x, y]) => 'const total = price * quantity;'.slice(x, y)), ['quantity']);
  const two = D.wordDiff('a(b, c, d)', 'a(x, c, y)');
  assert.deepEqual(two.b.map(([x, y]) => 'a(x, c, y)'.slice(x, y)), ['x', 'y']);
  assert.deepEqual(D.wordDiff('completely different', 'nothing alike here'), { a: [], b: [] });
  // Long lines: just the stretch between what's the same at both ends.
  const long = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ');
  const changed = long.replace('w150', 'CHANGED');
  const lw = D.wordDiff(long, changed);
  assert.equal(changed.slice(...lw.b[0]), 'CHANGED');
});

test('marks cut through highlighted pieces without losing a character', () => {
  const segs = [['k', 'const'], ['', ' total = '], ['n', '42'], ['', ';']];
  const out = D.marked(segs, [[8, 16]]);  // from inside ' total = ' to the end of '42'
  assert.equal(out.map(([, t]) => t).join(''), 'const total = 42;');
  assert.deepEqual(out.filter(([, , m]) => m).map(([c, t]) => `${c}:${t}`), [':tal = ', 'n:42']);
  assert.deepEqual(D.marked([['', 'abc']], []), [['', 'abc', false]]);
});

test('rows carry their line numbers, pair removed with added, and know a missing newline', () => {
  const hunk = { old_start: 10, new_start: 10, lines: [[' ', 'a'], ['-', 'b'], ['-', 'c'], ['+', 'B'], [' ', 'd'], ['+', 'e'], ['\\', ' No newline at end of file']] };
  const r = D.rows(hunk);
  assert.deepEqual(r.map((x) => [x.tag, x.o, x.n]), [[' ', 10, 10], ['-', 11, null], ['-', 12, null], ['+', null, 11], [' ', 13, 12], ['+', null, 13]]);
  assert.equal(r[1].pair, 3);
  assert.equal(r[3].pair, 1);
  assert.equal(r[2].pair, undefined);
  assert.equal(r[5].noEol, true);
  const split = D.splitRows(r);
  assert.deepEqual(split.map(([a, b]) => [a && a.text, b && b.text]), [['a', 'a'], ['b', 'B'], ['c', null], ['d', 'd'], [null, 'e']]);
});

test('the unchanged lines between hunks are counted', () => {
  assert.equal(D.gap(null, { new_start: 40 }), 39);
  assert.equal(D.gap({ new_start: 40, new_count: 7 }, { new_start: 60 }), 13);
  assert.equal(D.gap({ new_start: 40, new_count: 7 }, { new_start: 47 }), 0);
  assert.equal(D.gap({ new_start: 40, new_count: 7 }, null), 0);
});
