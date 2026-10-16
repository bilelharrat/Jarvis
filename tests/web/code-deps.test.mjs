// Eden Code settings › Dependency upgrades (web/features/code-deps.js): the plan's rows (batches
// first), the "checked" line, the scheduled check in words, and its message (or why not).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const deps = require('../../src/jarvis/web/features/code-deps.js');

const pkg = (name, current, latest, kind) => ({ name, current, latest, kind });

test('rows: batches first, each with its packages and kinds; broken groups left out', () => {
  const rows = deps.rowsOf([
    { id: 'npm:react@19', kind: 'major', title: 'react 18 → 19', packages: [pkg('react', '18', '19', 'major')] },
    { id: 'npm:batch', kind: 'batch', title: 'npm: 2', packages: [pkg('a', '1.0.0', '1.0.1', 'patch'), pkg('b', '1.0.0', '1.2.0', 'minor')] },
    null, { id: 'x' }, { packages: [] },
  ]);
  assert.deepEqual(rows.map((r) => r.id), ['npm:batch', 'npm:react@19']);
  assert.deepEqual(rows[0].lines, ['a 1.0.0 → 1.0.1', 'b 1.0.0 → 1.2.0']);
  assert.deepEqual(rows[0].kinds, ['Patch', 'Minor']);
  assert.equal(rows[1].kind, 'major');
  assert.deepEqual(deps.rowsOf('nope'), []);
});

test('the checked line', () => {
  assert.equal(deps.checkedLine(0), 'Not checked yet.');
  assert.equal(deps.checkedLine(1000, 1010), 'Checked just now.');
  assert.equal(deps.checkedLine(1000, 1000 + 60), 'Checked 1 minute ago.');
  assert.equal(deps.checkedLine(1000, 1000 + 7200), 'Checked 2 hours ago.');
  assert.equal(deps.checkedLine(0.5, 3 * 86400), 'Checked 3 days ago.');
});

test('the schedule in words, and off says nothing', () => {
  assert.equal(deps.scheduleLine({}), '');
  assert.equal(deps.scheduleLine({ projects: ['app'], every: 'daily', time: '09:00', upgrade: 'tell' }), 'app: every day at 09:00; tells you what’s out of date.');
  assert.equal(deps.scheduleLine({ projects: ['app', 'web'], every: 'weekly', day: 4, time: '07:30', upgrade: 'batch' }),
    'app, web: every Friday at 07:30; tells you and upgrades the patch and minor ones.');
});

test('the schedule message, or why it cannot be sent', () => {
  assert.deepEqual(deps.scheduleMsg({ time: '09:00' }), { error: 'Pick a project first.' });
  assert.deepEqual(deps.scheduleMsg({ project: 'app', time: '9:00' }), { error: 'The time is HH:MM, like 09:00.' });
  assert.deepEqual(deps.scheduleMsg({ project: 'app', time: '09:00', every: 'weekly', day: '9', upgrade: 'batch' }).msg,
    { type: 'code_deps_schedule_set', projects: ['app'], every: 'weekly', day: 6, time: '09:00', upgrade: 'batch' });
  assert.equal(deps.scheduleMsg({ project: 'app', time: '23:59', upgrade: 'all' }).msg.upgrade, 'tell');
});
