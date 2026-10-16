// The assumption ledger's window side (web/features/code-assumptions.js): which guesses are
// drawn and in what order, the section's heading, when Undo shows, and the screen reader's
// line; and the Needs attention inbox's Keep and Undo for a high-risk one (code-attention.js).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const asm = require('../../src/jarvis/web/features/code-assumptions.js');
const attention = require('../../src/jarvis/web/features/code-attention.js');

const row = (id, risk, extra = {}) => ({ id, risk, question: `q${id}?`, answer: `a${id}`, source: 'agent', state: 'open', ...extra });

test('rows: only whole entries, high risk first, otherwise in the order made', () => {
  const rows = asm.rowsOf([row('1', 'low'), row('2', 'high'), null, { id: '3', risk: 'odd', question: 'q', answer: 'a' }, row('4', 'medium'), row('5', 'high')]);
  assert.deepEqual(rows.map((r) => r.id), ['2', '5', '4', '1']);
  assert.deepEqual(asm.rowsOf('nope'), []);
});

test('the heading counts them, and the high-risk ones', () => {
  assert.equal(asm.heading([row('1', 'low')]), 'Assumptions (1)');
  assert.equal(asm.heading([row('1', 'low'), row('2', 'high')]), 'Assumptions (2, 1 high risk)');
});

test('Undo shows while a guess is open or kept, never once undone or refused', () => {
  assert.equal(asm.canUndo('open'), true);
  assert.equal(asm.canUndo('kept'), true);
  assert.equal(asm.canUndo(undefined), true);
  assert.equal(asm.canUndo('undone'), false);
  assert.equal(asm.canUndo('refused'), false);
});

test('a screen reader hears where it came from, the guess, its risk and its evidence', () => {
  const said = asm.spoken(row('1', 'medium', { source: 'auto_answer', why: "it's a guess", evidence: '' }));
  assert.equal(said, "Eden answered: q1? → a1. Medium risk: it's a guess. No evidence given.");
  assert.match(asm.spoken(row('2', 'low', { evidence: 'README' })), /^The session assumed: .* Evidence: README\.$/);
});

test('the inbox offers Keep and Undo for a high-risk guess, then Open', () => {
  assert.equal(attention.KINDS.assumption, 'Assumption');
  const acts = attention.actionsOf({ kind: 'assumption', assumption: 'abc' });
  assert.deepEqual(acts.map((a) => a.label), ['Keep', 'Undo', 'Open']);
  assert.deepEqual(acts[0].command, { type: 'code_assume_keep', id: 'abc' });
  assert.deepEqual(acts[1].command, { type: 'code_assume_undo', id: 'abc' });
});
