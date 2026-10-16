// The provenance overlay's window side (web/features/code-provenance.js): which span a line
// is in, who wrote it, the short label and the full line a tooltip and a screen reader get,
// and where the editor's margin bars go.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const cpv = require('../../src/jarvis/web/features/code-provenance.js');

const who = (extra = {}) => ({ commit: 'abc1234567', task: 3, title: 'fix the login', model: 'Sonnet 5.5', turn: 2, summary: 'make it check the token', digest: 'sha256:0123456789abcdef', at: '2026-10-16T09:30:00', receipt: 41, ...extra });
const event = { spans: [[3, 4, 0], [10, 10, 1], [20, 25, 0]], who: [who(), who({ turn: 0, summary: '' })] };

test('a line is found in its span, and lines between spans in none', () => {
  assert.equal(cpv.spanAt(event.spans, 3), 0);
  assert.equal(cpv.spanAt(event.spans, 4), 0);
  assert.equal(cpv.spanAt(event.spans, 10), 1);
  assert.equal(cpv.spanAt(event.spans, 22), 2);
  assert.equal(cpv.spanAt(event.spans, 5), -1);
  assert.equal(cpv.spanAt(event.spans, 99), -1);
  assert.equal(cpv.spanAt([], 1), -1);
  assert.equal(cpv.spanAt(undefined, 1), -1);
});

test('who wrote a line comes from the span’s entry', () => {
  assert.equal(cpv.whoAt(event, 4).turn, 2);
  assert.equal(cpv.whoAt(event, 10).turn, 0);
  assert.equal(cpv.whoAt(event, 6), null);
  assert.equal(cpv.whoAt(null, 1), null);
});

test('the label names the turn and its prompt, else the session', () => {
  assert.equal(cpv.label(who()), 'Turn 2: “make it check the token”');
  assert.equal(cpv.label(who({ summary: '' })), 'Turn 2');
  assert.equal(cpv.label(who({ turn: 0 })), 'Session “fix the login”');
  assert.equal(cpv.label(who({ turn: 0, title: '' })), 'Session 3');
  assert.equal(cpv.label(null), '');
});

test('the full line says session, model, turn, prompt digest, commit and when', () => {
  assert.equal(cpv.detail(who()), 'Written by Eden Code session “fix the login” · Sonnet 5.5 · Turn 2: “make it check the token” · prompt sha256:0123456789abcdef · commit abc1234567 · 2026-10-16 09:30:00');
  assert.equal(cpv.detail(who({ title: '', model: '', turn: 0, digest: '', at: '' })), 'Written by Eden Code session 3 · commit abc1234567');
});

test('margin bars sit at their lines in the text’s own pixels', () => {
  assert.deepEqual(cpv.bars([[3, 4, 0], [10, 10, 1]], 20, 10), [{ top: 50, height: 40, who: 0 }, { top: 190, height: 20, who: 1 }]);
  assert.deepEqual(cpv.bars(null, 20, 0), []);
});
