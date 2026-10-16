// The board's merge queue lane (web/features/code-merge-queue.js): where an item stands,
// what's ready to join a queue (copies with work, open pull requests, none already in it),
// an item in one line for a screen reader, and the buttons each item offers.
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const mq = require('../../src/jarvis/web/features/code-merge-queue.js');

test('the merge queue: what each state says, an unknown one as waiting', () => {
  assert.equal(mq.stateLabel({ state: 'owner' }), 'Needs you');
  assert.equal(mq.stateLabel({ state: 'checks' }), 'Waiting for its checks');
  assert.equal(mq.stateLabel({ state: 'nonsense' }), 'Waiting its turn');
});

test('the merge queue: ready to queue are copies with work and open pull requests not in it', () => {
  const copies = [
    { slug: 'a', title: 'A', branch: 'jarvis/a', into: 'main', project: 'app', state: { ahead: 1, dirty: 0 } },
    { slug: 'b', title: 'B', branch: 'jarvis/b', into: 'main', project: 'app', state: { ahead: 0, dirty: 0 } },  // nothing in it
    { slug: 'c', title: 'C', branch: 'jarvis/c', into: 'main', project: 'app', state: { dirty: 2 }, busy: true },  // still working
    { slug: 'd', title: 'D', branch: 'jarvis/d', into: 'main', project: 'app', state: { dirty: 1 } },
  ];
  const prs = [
    { key: 'acme/app#7', number: 7, title: 'Fix', state: 'open', branch: 'fix', base: 'main', project: 'app' },
    { key: 'acme/app#8', number: 8, title: 'Old', state: 'merged', branch: 'old', base: 'main', project: 'app' },
    { key: 'acme/app#9', number: 9, title: 'Draft', state: 'open', draft: true, branch: 'd', base: 'main', project: 'app' },
  ];
  const queues = [{ items: [{ kind: 'copy', ref: 'd' }] }];
  const ready = mq.candidates(copies, prs, queues);
  assert.deepEqual(ready.map((r) => `${r.kind}:${r.ref}`), ['copy:a', 'pr:acme/app#7']);
  assert.equal(ready[1].title, '#7 Fix');
  assert.equal(ready[0].where, 'jarvis/a → main');
  assert.deepEqual(mq.candidates(null, null, null), []);
});

test('the merge queue: an item in one line, and its buttons', () => {
  const item = { kind: 'copy', title: 'small fix', state: 'owner', note: 'Conflicts with main in a.py; over to you.' };
  assert.equal(mq.itemSpeech(item, 1, 3), '2/3, small fix, isolated copy, needs you: Conflicts with main in a.py; over to you.');
  assert.deepEqual(mq.actionsFor(item, 1, 3).map(([a]) => a), ['up', 'down', 'retry', 'pause', 'remove']);
  assert.deepEqual(mq.actionsFor({ state: 'working' }, 0, 2), []);  // (being landed: hands off)
  assert.deepEqual(mq.actionsFor({ state: 'paused' }, 0, 1).map(([a]) => a), ['resume', 'remove']);
});

test('the merge queue is a lane of the board’s, placed after the to-do column', () => {
  const board = readFileSync(new URL('../../src/jarvis/web/features/code-board.js', import.meta.url), 'utf8');
  assert.match(board, /extraLanes\.sort\(\(a, b\) => \(a\.order \|\| 0\) - \(b\.order \|\| 0\)\)/);
  const source = readFileSync(new URL('../../src/jarvis/web/features/code-merge-queue.js', import.meta.url), 'utf8');
  assert.match(source, /F\.codeBoard\.addLane\(\{ order: 1,/);
  assert.match(source, /setAttribute\('role', 'list'\)/);
  const zh = JSON.parse(readFileSync(new URL('../../src/jarvis/web/i18n/code-merge-queue.json', import.meta.url), 'utf8'));
  for (const label of Object.values(mq.STATES)) assert.ok(zh.strings[label], label);
});

test('the merge queue: an item the semantic conflict guard holds lists what collides', () => {
  const item = {
    kind: 'copy', title: 'tax in totals', state: 'held', note: 'Held: it collides with session 4 in 1 place(s) git doesn’t see; both sessions were told.',
    guard: [
      { kind: 'contract', text: 'this one changed the signature of total in calc.py (…), and session 4 adds calls to it that don’t fit (first at shop.py:3).' },
      { kind: 'body', text: 'set aside by the owner', overridden: true },
      null,
    ],
  };
  assert.equal(mq.stateLabel(item), 'Held: overlapping changes');
  assert.deepEqual(mq.collisions(item), [item.guard[0].text]);
  assert.deepEqual(mq.collisions({}), []);
  assert.deepEqual(mq.actionsFor(item, 0, 1).map(([a]) => a), ['override', 'retry', 'pause', 'remove']);
  assert.equal(mq.actionsFor(item, 0, 1)[0][1], 'Land anyway');
  const zh = JSON.parse(readFileSync(new URL('../../src/jarvis/web/i18n/code-merge-queue.json', import.meta.url), 'utf8'));
  for (const [, label] of [...mq.GUARD_MODES, ...mq.CONFLICT_MODES]) assert.ok(zh.strings[label], label);
  for (const label of ['Land anyway', 'Check again', 'Overlapping changes']) assert.ok(zh.strings[label], label);
});
