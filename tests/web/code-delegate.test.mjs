// Attention-aware delegation's window side (web/features/code-delegate.js): the Settings
// group's values from the prefs, and the held line; and the to-do card's line saying a card
// came from a meeting (proposed) or was started by Eden without the owner (code-todo.js).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const dlg = require('../../src/jarvis/web/features/code-delegate.js');
const todo = require('../../src/jarvis/web/features/code-todo.js');

test('switches read the prefs, else their defaults (auto-start and the model off)', () => {
  const defaults = Object.fromEntries(dlg.SWITCHES.map(([k, d]) => [k, d]));
  assert.equal(defaults.code_delegate_hold, true);
  assert.equal(defaults.code_delegate_meeting_cards, true);
  assert.equal(defaults.code_delegate_autostart, false);
  assert.equal(defaults.code_delegate_model, false);
  assert.equal(dlg.valueOf({ code_delegate_hold: false }, 'code_delegate_hold', true), false);
  assert.equal(dlg.valueOf({ code_delegate_hold: 'yes' }, 'code_delegate_hold', true), true);
  assert.equal(dlg.valueOf(null, 'code_delegate_autostart', false), false);
});

test('caps show as the nearest offered choice, and the clock falls back to 17:30', () => {
  assert.equal(dlg.nearest(dlg.PER_DAY, 2, 2), 2);
  assert.equal(dlg.nearest(dlg.SPEND, 4.2, 2), 5);
  assert.equal(dlg.nearest(dlg.SPEND, 'x', 2), 2);
  assert.equal(dlg.clock('18:45'), '18:45');
  assert.equal(dlg.clock('25:00'), '17:30');
});

test('the held line', () => {
  assert.equal(dlg.heldLine({ held: 0 }), '');
  assert.equal(dlg.heldLine({}), '');
  assert.equal(dlg.heldLine({ held: 1 }), '1 heads-up is waiting for your next break.');
  assert.equal(dlg.heldLine({ held: 3 }), '3 heads-ups are waiting for your next break.');
});

test('a card says it came from a meeting, or that Eden started it', () => {
  assert.equal(todo.originLine({ state: 'todo' }), null);
  const m = todo.originLine({ state: 'todo', meeting: 'Standup', proposed: true });
  assert.deepEqual(m, { kind: 'meeting', text: 'From the meeting', meeting: 'Standup', proposed: true });
  assert.equal(todo.originLine({ state: 'started', meeting: 'Standup', proposed: true }).proposed, false);
  assert.equal(todo.originLine({ auto: { run: 'r1', moment: 'evening' } }).text, 'Started by Eden as the day ended');
  assert.equal(todo.originLine({ auto: { run: 'r1', moment: 'away' } }).kind, 'auto');
});
