// Eden Cloud, its window helpers (web/features/code-eden-cloud.js). node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const ec = require('../../src/jarvis/web/features/code-eden-cloud.js');

test('a run says how it is doing, a dropped connection first', () => {
  assert.equal(ec.stateWord({ state: 'running' }), 'Working in Eden Cloud');
  assert.equal(ec.stateWord({ state: 'running', lost: true }), 'Reconnecting…');
  assert.equal(ec.stateWord({ state: 'done', lost: true }), 'Finished in Eden Cloud');
  assert.equal(ec.stateWord({ state: 'brand new' }), 'No longer in Eden Cloud');
  assert.equal(ec.stateWord(null), '');
  assert.ok(ec.isLive({ state: 'queued' }) && !ec.isLive({ state: 'over_budget' }) && !ec.isLive(null));
});

test('what it cost, of its budget, never negative', () => {
  assert.equal(ec.spent({ cost: 0.126, budget: 5 }), '$0.13 of $5.00');
  assert.equal(ec.money(-2), '$0.00');
  assert.equal(ec.money('x'), '$0.00');
});

test('a session finds its live run first, else its latest', () => {
  const runs = [{ id: 'a', task_id: 2, state: 'done' }, { id: 'b', task_id: 2, state: 'running' }, { id: 'c', task_id: 2, state: 'failed' }];
  assert.equal(ec.runFor(runs, 2).id, 'b');
  assert.equal(ec.runFor(runs.filter((r) => r.id !== 'b'), 2).id, 'c');
  assert.equal(ec.runFor(runs, 0), null);
  assert.equal(ec.runFor(undefined, 2), null);
});

test('the address: https, or http on this Mac only', () => {
  assert.equal(ec.cleanUrl('https://cloud.askeden.com/'), 'https://cloud.askeden.com');
  assert.equal(ec.cleanUrl('http://localhost:8790'), 'http://localhost:8790');
  assert.equal(ec.cleanUrl(''), '');
  for (const bad of ['http://cloud.example.com', 'https://u:p@x.com', 'https://x.com/?a=1', 'nonsense']) assert.equal(ec.cleanUrl(bad), null, bad);
});

test('Run in Eden Cloud applies to an idle session in an isolated copy, once set up', () => {
  const task = { id: 3, kind: 'code', busy: false, workspace: { slug: 'c' } };
  const ready = { configured: true, runs: [] };
  assert.equal(ec.canRun(ready, task).ok, true);
  assert.match(ec.canRun({ configured: false }, task).why, /settings/);
  assert.equal(ec.canRun(ready, { ...task, workspace: {} }).why, 'Needs an isolated copy');
  assert.equal(ec.canRun(ready, { ...task, busy: true }).ok, false);
  assert.equal(ec.canRun({ configured: true, runs: [{ task_id: 3, state: 'starting' }] }, task).why, 'Already in Eden Cloud');
  assert.equal(ec.canRun(ready, null).ok, false);
});
