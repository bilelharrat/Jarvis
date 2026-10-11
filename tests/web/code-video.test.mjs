// Eden Code's video proof in the window (web/features/code-video.js): its pure helpers, and
// the More menu knowing a recording is under way, even after the window reloads during one.
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const FILE = new URL('../../src/jarvis/web/features/code-video.js', import.meta.url);
const vp = require('../../src/jarvis/web/features/code-video.js');

test('a video is played from the window’s own server, by its id only', () => {
  assert.equal(vp.videoSrc('0123456789abcdef01234567'), '/f/code-video/0123456789abcdef01234567');
  assert.equal(vp.videoSrc('../../etc/passwd'), '');
  assert.equal(vp.secondsText(4), '4 s');
  assert.equal(vp.secondsText(0), '');
});

// The window as the feature sees it: its events, what it sends, its More menu.
function load(task) {
  const handlers = new Map();
  const sent = [];
  const items = [];
  const notes = [];
  const F = {
    el: () => ({}), t: (s) => s, $: () => null,
    on: (type, fn) => handlers.set(type, [...(handlers.get(type) || []), fn]),
    send: (msg) => sent.push({ ...msg }),  // (an object of this realm, to compare)
    currentTask: () => task.current,
    registerEntry: () => {},
    registerMoreItem: (item) => items.push(item),
  };
  const context = { jarvisFeatures: F, jcNote: (text) => notes.push(text) };
  context.window = context;
  vm.runInNewContext(readFileSync(FILE, 'utf8'), context);
  const fire = (type, ev) => (handlers.get(type) || []).forEach((fn) => fn(ev));
  return { fire, sent, item: items.find((i) => i.label === 'Record a video proof'), notes };
}

test('a session on show is asked whether it is recording, once', () => {
  const task = { current: { id: 7 } };
  const w = load(task);
  w.fire('task_transcript', { id: 7 });
  w.fire('tasks', { items: [] });
  assert.deepEqual(w.sent, [{ type: 'vp_state', id: 7 }]);
  task.current = { id: 8 };
  w.fire('tasks', { items: [] });
  assert.deepEqual(w.sent.at(-1), { type: 'vp_state', id: 8 });
});

test('while it records, the More menu says so and doesn’t start another', () => {
  const task = { current: { id: 7 } };
  const w = load(task);
  w.fire('vp_state', { id: 7, recording: true });
  assert.equal(w.item.note, 'Recording a video proof…');
  w.item.run();
  assert.ok(!w.sent.some((m) => m.type === 'vp_record'));
  w.fire('vp_state', { id: 7, recording: false });
  assert.notEqual(w.item.note, 'Recording a video proof…');
  w.item.run();
  assert.deepEqual(w.sent.at(-1), { type: 'vp_record', id: 7 });
});
