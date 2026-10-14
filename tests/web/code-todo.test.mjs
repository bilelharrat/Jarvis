// The board's to-do column in the window (web/features/code-todo.js): a project's cards in
// the owner's order, a move as todo_move makes it, what each card says of where it stands
// and of a queue's tries, the queue's line, an issue's address, a card's link to its
// session, and which project the lane shows. node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const todo = require('../../src/jarvis/web/features/code-todo.js');

test('the to-do column: a project’s cards in order, and a move as the backend makes it', () => {
  const cards = [{ id: 'a', folder: '/p/web' }, { id: 'b', folder: '/p/api' }, { id: 'c', folder: '/p/web' }];
  assert.deepEqual(todo.cardsFor(cards, '/p/web').map((c) => c.id), ['a', 'c']);
  assert.deepEqual(todo.cardsFor(null, '/p/web'), []);
  assert.deepEqual(todo.moved(['a', 'b', 'c'], 'c', 0), ['c', 'a', 'b']);
  assert.deepEqual(todo.moved(['a', 'b', 'c'], 'a', 9), ['b', 'c', 'a']);
  assert.deepEqual(todo.moved(['a', 'b'], 'zz', 0), ['a', 'b']);  // (not one of them)
});

test('the to-do column: where a card stands, and how a queued card’s tries went', () => {
  assert.equal(todo.stateLabel({ state: 'todo' }), 'To do');
  assert.equal(todo.stateLabel({ state: 'nonsense' }), 'To do');
  assert.equal(todo.stateLabel({ state: 'failed' }), 'Checks failed');
  assert.equal(todo.stateLabel({ state: 'done', verified: true }), 'Done · checks passed');
  assert.equal(todo.stateLabel({ state: 'done', verified: null, attempts: [{ model: 'haiku' }] }), 'Done · nothing to check');
  assert.equal(todo.stateLabel({ state: 'done' }), 'Done');
  const names = { haiku: 'Haiku 4.5', sonnet: 'Sonnet 5.5' };
  assert.equal(
    todo.attemptsLine({ attempts: [{ model: 'haiku', outcome: false }, { model: 'sonnet', outcome: true }] }, (r) => names[r]),
    'Haiku 4.5 ✗ → Sonnet 5.5 ✓',
  );
  assert.equal(todo.attemptsLine({ attempts: [{ model: 'haiku' }] }), 'haiku');
  assert.equal(todo.attemptsLine({}), '');
});

test('the to-do column: the queue’s line says how it runs, what it spent and why it waits', () => {
  assert.equal(todo.queueLine(null), '');
  assert.equal(todo.queueLine({ on: true, parallel: 1, spent: 1.2, ceiling: 5 }), 'Queue running, one at a time: $1.20 of $5.00');
  assert.equal(
    todo.queueLine({ on: true, parallel: 2, spent: 0, ceiling: 5, note: 'Waiting: today’s limit is used up.' }),
    'Queue running, 2 at a time: $0.00 of $5.00. Waiting: today’s limit is used up.',
  );
  assert.equal(todo.queueLine({ on: false, note: 'All the cards have run.' }), 'All the cards have run.');
  // The line matches its Chinese pattern (web/i18n/code-todo.json).
  const zh = JSON.parse(readFileSync(new URL('../../src/jarvis/web/i18n/code-todo.json', import.meta.url), 'utf8'));
  const line = todo.queueLine({ on: true, parallel: 3, spent: 2, ceiling: 10 });
  assert.ok(zh.patterns.some(([p]) => new RegExp(p).test(line)), line);
  for (const words of ['Run my queue…', 'New card', 'Open session', 'Done · checks passed']) assert.ok(zh.strings[words], words);
});

test('the to-do column: an issue’s address, a card’s link to its session, the project shown', () => {
  assert.ok(todo.issueAddress('https://github.com/acme/web/issues/12'));
  assert.ok(todo.issueAddress(' https://github.com/acme/web/pull/7 '));
  assert.ok(!todo.issueAddress('https://github.com.evil.example/acme/web/issues/12'));
  assert.ok(!todo.issueAddress('github.com/acme/web/issues/12'));
  const tasks = [{ id: 4 }];
  assert.deepEqual(todo.sessionLink({ task: 4, session: 's1' }, tasks), { open: 4 });
  assert.deepEqual(todo.sessionLink({ task: 9, session: 's1' }, tasks), { resume: 's1' });  // (closed: reopened)
  assert.equal(todo.sessionLink({ state: 'todo' }, tasks), null);
  const projects = [{ name: 'web', path: '/p/web' }, { name: 'api', path: '/p/api' }];
  const cards = [{ folder: '/p/api' }];
  assert.equal(todo.projectFor(projects, cards, '/p/web', ''), '/p/web');  // the one chosen
  assert.equal(todo.projectFor(projects, cards, '', '/p/web'), '/p/web');  // the open session's
  assert.equal(todo.projectFor(projects, cards, '', ''), '/p/api');  // the first with cards
  assert.equal(todo.projectFor(projects, [], '/gone', ''), '/p/web');
  assert.equal(todo.projectFor([], [{ folder: '/x' }], '', ''), '/x');
  assert.deepEqual(todo.OUTSIDE_MODES, ['plan', 'ask', 'edits']);
});

test('the to-do column is a lane of the board’s, and the board keeps it through a redraw', () => {
  const board = readFileSync(new URL('../../src/jarvis/web/features/code-board.js', import.meta.url), 'utf8');
  assert.match(board, /addLane\(lane\)/);
  assert.match(board, /lanes\.append\(lane\.element\(\)\)/);
  const source = readFileSync(new URL('../../src/jarvis/web/features/code-todo.js', import.meta.url), 'utf8');
  assert.match(source, /F\.codeBoard\.addLane\(\{ shows: \(\) => 'todo', element: \(\) => lane \}\)/);
  // Its dialogs are inside Eden Code (its look's colors) and announced as dialogs, so the
  // board's Esc leaves them to close themselves first.
  assert.match(source, /setAttribute\('role', 'dialog'\)/);
  assert.match(source, /F\.\$\('cc'\) \|\| document\.body/);
});
