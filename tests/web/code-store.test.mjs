// Jarvis Code's one session store (web/code-store.js): sessions, sidebar facts and
// transcripts from the window's events, a replay never doubled, a new backend starting clean,
// and what a pane frame is caught up with. node --test tests/web/
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createStore } = require('../../src/jarvis/web/code-store.js');

test('the store follows the sessions, their facts and their transcripts', () => {
  const s = createStore();
  s.take({ type: 'hello', hub_id: 'h1', seq: 10, tasks: [{ id: 1, title: 'A' }, { id: 2, title: 'B' }] });
  s.take({ type: 'code_meta', full: true, items: { 1: { pinned: true } } });
  s.take({ type: 'task_transcript', id: 1, entries: [{ n: 1, role: 'user', text: 'hi' }] });
  s.take({ type: 'task_log', id: 1, seq: 11, entry: { n: 2, role: 'tool', tool_id: 't', text: 'ls' } });
  s.take({ type: 'task_log', id: 1, seq: 11, entry: { n: 2, role: 'tool', tool_id: 't', text: 'ls' } });  // replayed
  s.take({ type: 'task_log_update', id: 1, seq: 12, tool_id: 't', status: 'done', output: 'a b' });
  assert.equal(s.seq, 12);
  assert.deepEqual(s.transcript(1).map((e) => e.n), [1, 2]);
  assert.equal(s.transcript(1)[1].output, 'a b');
  assert.equal(s.meta(1).pinned, true);
  s.take({ type: 'tasks', items: [{ id: 1, title: 'A' }] });  // session 2 left the list
  assert.equal(s.task(2), null);
  assert.equal(s.tasks().length, 1);
});

test('a new backend starts clean, and a frame catches up snapshot first', () => {
  const s = createStore();
  s.take({ type: 'hello', hub_id: 'h1', seq: 5, tasks: [{ id: 1 }] });
  s.take({ type: 'task_transcript', id: 1, entries: [{ n: 1 }] });
  s.take({ type: 'tasks', items: [{ id: 1 }, { id: 3 }] });
  s.take({ type: 'error', text: 'once' });  // a one-off: never replayed to a frame
  assert.deepEqual(s.catchUp().map((e) => e.type), ['hello', 'tasks']);
  let heard = 0;
  const off = s.subscribe(() => { heard += 1; });
  s.take({ type: 'hello', hub_id: 'h2', seq: 1, tasks: [] });
  off();
  s.take({ type: 'tasks', items: [] });
  assert.equal(heard, 1);
  assert.deepEqual(s.transcript(1), []);
  assert.equal(s.hub, 'h2');
  assert.equal(s.seq, 1);
});
