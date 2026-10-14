// Bug Fix Mode's window helpers (web/features/code_bugfix.js): its steps and progress, the
// findings worst first, when Stop, Resume and Land show, which run a session is; and the
// Touch ID its landing card asks for (code-touchid.js). node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const bf = require('../../src/jarvis/web/features/code_bugfix.js');
const ct = require('../../src/jarvis/web/features/code-touchid.js');

test('three rounds of sweep, break and fix, efficiency only between them, then ship and land', () => {
  const keys = bf.stepsOf(3).map((s) => s.key);
  assert.deepEqual(keys, [
    'r1-sweep', 'r1-break', 'r1-fix', 'r1-efficiency',
    'r2-sweep', 'r2-break', 'r2-fix', 'r2-efficiency',
    'r3-sweep', 'r3-break', 'r3-fix', 'ship', 'land',
  ]);
});

test('progress: done, the step it is on, and what is still to do', () => {
  const states = (run) => bf.progress(run).map((s) => s.state);
  const running = states({ rounds: 3, round: 2, step: 'break', state: 'running' });
  assert.deepEqual(running.slice(0, 6), ['done', 'done', 'done', 'done', 'done', 'current']);
  assert.equal(running[6], 'todo');
  const paused = states({ rounds: 3, round: 1, step: 'fix', state: 'paused' });
  assert.deepEqual(paused.slice(0, 4), ['done', 'done', 'halted', 'todo']);
  const done = states({ rounds: 3, round: 3, step: 'ship', state: 'done', landed: '' });
  assert.deepEqual(done.slice(-2), ['done', 'halted']);  // (landing still the owner's)
  assert.ok(states({ rounds: 3, round: 3, step: 'land', state: 'done', landed: 'Landed x' }).every((s) => s === 'done'));
});

test('findings worst first, and counted by severity', () => {
  const list = [
    { id: 'R1-3', severity: 'low' }, { id: 'R1-10', severity: 'high' },
    { id: 'R1-2', severity: 'high' }, { id: 'R2-1', severity: 'blocker' },
  ];
  assert.deepEqual(bf.sorted(list).map((f) => f.id), ['R2-1', 'R1-2', 'R1-10', 'R1-3']);
  assert.deepEqual(bf.severityCounts(list), { blocker: 1, high: 2, medium: 0, low: 1 });
});

test('Stop while it runs; Resume a paused or stopped run with its copy; Land once there is a fix', () => {
  const fixed = [{ status: 'verified' }];
  assert.ok(bf.canStop({ state: 'running' }) && !bf.canStop({ state: 'paused' }));
  assert.ok(bf.canResume({ state: 'paused', folder: '/c' }) && bf.canResume({ state: 'stopped', folder: '/c' }));
  assert.ok(!bf.canResume({ state: 'done', folder: '/c' }) && !bf.canResume({ state: 'paused', folder: '' }));
  assert.ok(bf.canLand({ state: 'done', slug: 's', findings: fixed }));
  assert.ok(!bf.canLand({ state: 'running', slug: 's', findings: fixed }));
  assert.ok(!bf.canLand({ state: 'done', slug: 's', findings: fixed, landed: 'Landed' }));
  assert.ok(!bf.canLand({ state: 'done', slug: 's', findings: [{ status: 'open' }] }));
});

test('the run a session is, else the one running in the project', () => {
  const runs = [{ id: 'a', project: 'alpha', state: 'running' }, { id: 'b', project: 'beta', state: 'done' }];
  assert.equal(bf.runFor(runs, { 7: 'b' }, 7, 'alpha').id, 'b');
  assert.equal(bf.runFor(runs, {}, null, 'alpha').id, 'a');
  assert.equal(bf.runFor(runs, {}, null, 'beta'), null);  // (done: not on)
});

test('the landing card asks for Touch ID, a no never does', () => {
  const card = { tool: 'code_bugfix_land', touchid: true, tap_only: true, question: 'Land Bug Fix Mode’s fixes in main?' };
  assert.ok(ct.risky(card, 'allow'));
  assert.ok(!ct.risky(card, 'deny'));
  assert.ok(!ct.risky({ ...card, touchid: 'yes' }, 'allow'));  // (only the backend's own flag)
});
