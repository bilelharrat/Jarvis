// Jarvis Code's agent board in the window (web/features/code-board.js): where each session
// stands, what its card says it's doing, and when it last did something. node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const board = require('../../src/jarvis/web/features/code-board.js');

test('the board: a question waiting beats working, and every status has its lane', () => {
  const { column } = board;
  const task = (extra) => ({ id: 1, busy: false, status: 'waiting', ...extra });
  assert.equal(column(task({ busy: true }), 1), 'needs');
  assert.equal(column(task({ busy: true }), 0), 'working');
  assert.equal(column(task({ status: 'running' }), 0), 'working');  // starting, or a message on its way
  assert.equal(column(task({ status: 'waiting' }), 0), 'done');
  assert.equal(column(task({ status: 'failed' }), 0), 'failed');
  for (const status of ['resting', 'closed', 'stopped']) assert.equal(column(task({ status }), 0), 'resting', status);
});

test('the board: what each card says it is doing, and when it last did something', () => {
  const { doing, ago } = board;
  assert.equal(doing({ busy: true, last_action: 'Editing app.py' }), 'Editing app.py');
  assert.equal(doing({ busy: true, last_action: 'Working' }), 'Working');
  assert.equal(doing({ busy: false, status: 'waiting', result: '\n\nFixed the retry.\nDetails…' }), 'Fixed the retry.');
  assert.equal(doing({ busy: false, status: 'resting', result: '' }), 'Resting: it picks up where it left off');
  assert.equal(doing({ busy: true }, { question: 'Jarvis Code in alpha wants to run a command' }), 'Jarvis Code in alpha wants to run a command');
  assert.ok(doing({ status: 'waiting', result: 'x'.repeat(400) }).length <= 161);
  const now = Date.parse('2026-09-29T12:00:00');
  assert.equal(ago('2026-09-29T11:59:30', now), 'just now');
  assert.equal(ago('2026-09-29T11:45:00', now), '15 min ago');
  assert.equal(ago('2026-09-29T09:00:00', now), '3 h ago');
  assert.equal(ago('2026-09-27T09:00:00', now), '');  // older: the card shows the date
  assert.equal(ago('', now), '');
  assert.equal(ago('not a date', now), '');
});

test('the board: archived sessions only when asked, the newest first in each lane', () => {
  const { arrange } = board;
  const tasks = [
    { id: 1, status: 'waiting', busy: false },
    { id: 2, status: 'waiting', busy: false },
    { id: 3, status: 'waiting', busy: true },
    { id: 4, status: 'resting', busy: false },
  ];
  const meta = { 4: { archived: true } };
  const asks = { 3: 1 };
  const lanes = arrange(tasks, (id) => meta[id] || {}, (id) => asks[id] || 0, false);
  assert.deepEqual(Object.fromEntries(Object.entries(lanes).map(([k, v]) => [k, v.map((x) => x.id)])),
    { needs: [3], working: [], done: [2, 1], failed: [], resting: [] });
  assert.deepEqual(arrange(tasks, (id) => meta[id] || {}, () => 0, true).resting.map((x) => x.id), [4]);
});
