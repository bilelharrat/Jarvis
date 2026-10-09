// Eden Code's Changes pane (web/features/code_changes.js), what it keeps for each session:
// what was fetched goes when the session leaves the list, and all of it with another backend;
// what the owner made (comments not sent yet, the view, the files opened, the hunks kept)
// stays, since a kept session comes back under its own id. node --test tests/web/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const SOURCE = fs.readFileSync(new URL('../../src/jarvis/web/features/code_changes.js', import.meta.url), 'utf8');

// The pane's file with a window of its own (nothing is drawn: no pane shows), and heard() to
// give it the hub's events as features.js would.
function load() {
  const handlers = new Map();
  const sent = [];
  const F = {
    el: () => { throw new Error('nothing is drawn here'); },
    send: (m) => { sent.push(m); return true; },
    t: (s) => s,
    currentTask: () => null,
    registerPane() {},
    on(type, fn) { handlers.set(type, [...(handlers.get(type) || []), fn]); },
  };
  const window = { jarvisFeatures: F };
  vm.runInNewContext(SOURCE, { window, setTimeout, clearTimeout, console });
  const heard = (ev) => (handlers.get(ev.type) || []).forEach((fn) => fn(ev));
  return { C: window.JarvisChanges, heard, sent };
}

const changes = (id, view, kept = []) => ({
  type: 'code_changes', id, view, git: true, workspace: {}, conflicts: [], totals: { files: 1, added: 2, removed: 1, hunks: 2 },
  files: [{ path: 'src/a.py', old_path: '', status: 'M', binary: false, sensitive: false, added: 2, removed: 1, omitted: false,
    hunks: ['h1', 'h2'].map((h) => ({ id: h, n: 1, line: 12, kept: kept.includes(h), lines: [] })) }],
});
const COMMENT = { path: 'src/a.py', line: 12, side: 'n', text: 'rename this', excerpt: '' };

// What the owner made for session 7: a comment not sent yet, Whole branch, a file closed, a
// hunk kept; and what was fetched for it (its changes, lines opened between hunks).
function made(C, heard) {
  heard(changes(7, 'branch'));
  heard({ type: 'code_lines', id: 7, path: 'src/a.py', start: 5, lines: ['x5', 'x6'] });
  C.store.comments.set(7, [{ ...COMMENT }]);
  C.store.views.set(7, 'branch');
  C.store.opened.set('7:branch', new Map([['src/a.py', false]]));
  heard({ type: 'code_kept', id: 7, kept: ['h1'] });
}
function stillThere(C, when) {
  assert.deepEqual(C.store.comments.get(7), [COMMENT], `${when}: the comment not sent yet`);
  assert.equal(C.store.views.get(7), 'branch', `${when}: the view`);
  assert.deepEqual([...C.store.opened.get('7:branch')], [['src/a.py', false]], `${when}: the files opened`);
  assert.deepEqual([...C.store.kept.get(7)], ['h1'], `${when}: the hunks kept`);
}

test('a restart: what the owner made for a kept session is its own still; what was fetched goes', () => {
  const { C, heard } = load();
  heard({ type: 'hello', hub_id: 'hub-a' });
  heard({ type: 'tasks', items: [{ id: 7, session_id: 'abc', status: 'running' }] });
  made(C, heard);
  // The backend restarts (an update, a crash, exit 75): the kept session rests under its own id.
  heard({ type: 'hello', hub_id: 'hub-b' });
  heard({ type: 'tasks', items: [{ id: 7, session_id: 'abc', status: 'resting' }] });
  stillThere(C, 'after a restart');
  assert.equal(C.store.data.size, 0, 'the old backend’s changes are kept');
  assert.equal(C.store.extra.size, 0, 'the old backend’s lines are kept');
  // The new backend's word on the hunks adds to the owner's (it kept none of them itself).
  heard(changes(7, 'branch', ['h2']));
  assert.deepEqual([...C.store.kept.get(7)].sort(), ['h1', 'h2']);
  assert.deepEqual([...C.store.data.keys()], ['7:branch']);
});

test('a session let go from the list and reopened from the history: its own still', () => {
  const { C, heard } = load();
  heard({ type: 'hello', hub_id: 'hub-a' });
  heard({ type: 'tasks', items: [{ id: 7, session_id: 'abc', status: 'done' }, { id: 8, session_id: 'def', status: 'running' }] });
  made(C, heard);
  heard(changes(8, 'session'));
  // Past the ended ones the list shows: let go. What was fetched for it goes; 8's stays.
  heard({ type: 'tasks', items: [{ id: 8, session_id: 'def', status: 'running' }] });
  assert.deepEqual([...C.store.data.keys()], ['8:session']);
  assert.equal(C.store.extra.size, 0);
  // Reopened from the history: back resting, with its own id.
  heard({ type: 'tasks', items: [{ id: 7, session_id: 'abc', status: 'resting' }, { id: 8, session_id: 'def', status: 'running' }] });
  stillThere(C, 'reopened');
  // The same backend saying hello again (a reconnect) takes nothing.
  heard({ type: 'hello', hub_id: 'hub-a' });
  assert.deepEqual([...C.store.data.keys()], ['8:session']);
  stillThere(C, 'after a reconnect');
});
