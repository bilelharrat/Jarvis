// Claude Code's questions in Eden Code, the sheet's helpers (web/features/code-ask.js).
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const cq = require('../../src/jarvis/web/features/code-ask.js');

test('one option, several, or the owner’s own words: what the sheet sends', () => {
  assert.deepEqual(cq.answerFor(false, [1], ''), ['opt1', '']);
  assert.deepEqual(cq.answerFor(false, [], '  just   lint '), ['other', 'just lint']);
  assert.equal(cq.answerFor(false, [], '   '), null);
  assert.deepEqual(cq.answerFor(true, [2, 0, 2], ''), ['pick', '{"picked":[0,2]}']);
  assert.deepEqual(cq.answerFor(true, [1], 'and a smoke test'), ['pick', '{"picked":[1],"other":"and a smoke test"}']);
  assert.deepEqual(cq.answerFor(true, [], 'only this'), ['other', 'only this']);
  assert.equal(cq.answerFor(true, [], ''), null);
  assert.equal(cq.answerFor(true, [-1, 1.5, 'x'], ''), null);
  // Several options and long words of the owner's own still fit what the hub keeps.
  for (const words of ['a'.repeat(3000), '"'.repeat(1990), '\u0001'.repeat(700)]) {
    const [choice, body] = cq.answerFor(true, [0, 2], words);
    assert.equal(choice, 'pick');
    assert.ok(body.length <= 2000, String(body.length));
    assert.deepEqual(JSON.parse(body).picked, [0, 2]);
  }
});

test('only tasks.py’s questions with their options are drawn here', () => {
  const q = { ask_kind: 'question', options: [{ label: 'A' }], free_choices: ['pick', 'other'] };
  assert.ok(cq.isQuestion(q));
  assert.ok(!cq.isQuestion({ ...q, options: [] }));
  assert.ok(!cq.isQuestion({ ...q, free_choices: ['pick'] }));
  assert.ok(!cq.isQuestion({ ...q, ask_kind: 'plan' }));
  assert.ok(!cq.isQuestion({ ask_kind: 'question', choices: [] }));  // an older card: the usual buttons
  assert.ok(!cq.isQuestion(null));
});

test('every string the question sheet shows has its Chinese', () => {
  const zh = JSON.parse(readFileSync(new URL('../../src/jarvis/web/i18n/code-ask.json', import.meta.url), 'utf8'));
  const source = readFileSync(new URL('../../src/jarvis/web/features/code-ask.js', import.meta.url), 'utf8');
  const shown = [...source.matchAll(/el\('[a-z0-9]+', '[^']*', '([^']+)'\)/g)].map((m) => m[1]).filter((s) => !/^[?\d]$/.test(s));
  const extra = ['Answer', 'Something else too (optional)', 'Or answer in your own words', 'Your own answer',
    'Tick with a number key, then press Answer. Or write your own answer.', 'Press a number, say “option two”, or write your own answer.'];
  assert.deepEqual([...shown, ...extra].filter((s) => !(s in zh.strings)), []);
});
