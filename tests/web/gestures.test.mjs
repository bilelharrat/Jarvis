// Hand gestures with synthetic MediaPipe hands: node --test tests/web/
import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, createGestures } from '../../src/jarvis/web/gestures.js';

// A right hand around (cx, cy): wrist at the bottom, fingers pointing up. `up` lists the
// extended fingers; `pinch` closes the thumb onto the index tip.
function hand({ cx = 0.5, cy = 0.5, up = [], pinch = false, gap = null } = {}) {
  const lm = Array.from({ length: 21 }, () => ({ x: cx, y: cy }));
  lm[0] = { x: cx, y: cy + 0.2 }; // wrist
  lm[9] = { x: cx, y: cy }; // middle knuckle: hand size 0.2
  const cols = { index: -0.06, middle: -0.02, ring: 0.02, pinky: 0.06 };
  const joints = { index: [6, 8], middle: [10, 12], ring: [14, 16], pinky: [18, 20] };
  for (const [f, dx] of Object.entries(cols)) {
    const [pip, tip] = joints[f];
    lm[pip] = { x: cx + dx, y: cy - 0.05 };
    lm[tip] = up.includes(f) ? { x: cx + dx, y: cy - 0.15 } : { x: cx + dx, y: cy + 0.05 };
  }
  lm[4] = { x: cx - 0.12, y: cy }; // thumb, well away from the index tip
  if (pinch || gap !== null) lm[4] = { x: lm[8].x + (gap ?? 0.01), y: lm[8].y };
  return lm;
}

test('classifies the five hand shapes', () => {
  assert.equal(classify(hand({ up: ['index', 'middle', 'ring', 'pinky'] })), 'palm');
  assert.equal(classify(hand({ up: ['index'] })), 'point');
  assert.equal(classify(hand()), 'fist');
  assert.equal(classify(hand({ up: ['index'], pinch: true })), 'pinch');
  assert.equal(classify(hand({ up: ['index', 'middle'] })), 'other');
});

test('a pinch that wobbles at the threshold holds instead of re-grabbing', () => {
  const wobble = hand({ up: ['index'], gap: 0.08 }); // 0.4 of hand size: between on and off
  assert.notEqual(classify(wobble, false), 'pinch');
  assert.equal(classify(wobble, true), 'pinch');
});

function rig() {
  const calls = [];
  const galaxy = {
    pickAtClient: (x, y) => { calls.push(['pick', x, y]); return 'note-1'; },
    hoverAtClient: (x) => { calls.push(['hover', x]); return x === null ? null : 'note-1'; },
    rotateBy: (dx, dy) => calls.push(['rotate', dx, dy]),
    zoomBy: (f) => calls.push(['zoom', f]),
    reset: () => calls.push(['reset']),
    select: (id) => calls.push(['select', id]),
  };
  const statuses = [];
  let closed = 0;
  const step = createGestures({
    galaxy,
    toScreen: (p) => ({ x: p.x * 1000, y: p.y * 1000 }),
    hideCursor: () => {},
    status: (s) => statuses.push(s),
    close: () => { closed += 1; },
  });
  return { step, calls, statuses, closed: () => closed, named: (n) => calls.filter((c) => c[0] === n) };
}

test('a quick pinch on a star opens it', () => {
  const r = rig();
  r.step([hand({ up: ['index'] })], 0);
  r.step([hand({ up: ['index'], pinch: true })], 100);
  r.step([hand({ up: ['index'], pinch: true })], 200);
  r.step([hand({ up: ['index'] })], 300);
  assert.deepEqual(r.named('select'), [['select', 'note-1']]);
});

test('pinch and drag spins the galaxy and does not open anything', () => {
  const r = rig();
  r.step([hand({ up: ['index'], pinch: true, cx: 0.4 })], 0);
  for (let i = 1; i <= 5; i++) r.step([hand({ up: ['index'], pinch: true, cx: 0.4 + i * 0.02 })], i * 50);
  r.step([hand({ up: ['index'], cx: 0.5 })], 400);
  assert.equal(r.named('rotate').length, 5);
  assert.ok(r.named('rotate').every(([, dx]) => dx > 0));
  assert.equal(r.named('select').length, 0);
});

test('a long pinch without moving is not a tap', () => {
  const r = rig();
  r.step([hand({ up: ['index'], pinch: true })], 0);
  r.step([hand({ up: ['index'], pinch: true })], 900);
  r.step([hand({ up: ['index'] })], 1000);
  assert.equal(r.named('select').length, 0);
});

test('two hands pinching zoom in as they pull apart and out as they push together', () => {
  const r = rig();
  const two = (spread) => [hand({ up: ['index'], pinch: true, cx: 0.5 - spread }), hand({ up: ['index'], pinch: true, cx: 0.5 + spread })];
  r.step(two(0.1), 0);
  r.step(two(0.2), 50);
  r.step(two(0.1), 100);
  const [[, apart], [, together]] = r.named('zoom');
  assert.ok(apart < 1, 'pulling apart moves the camera closer');
  assert.ok(together > 1);
  r.step([hand({ up: ['index'] })], 150);
  assert.equal(r.named('select').length, 0, 'letting go of a zoom never opens a star');
});

test('an open palm held a second resets the view once', () => {
  const r = rig();
  const palm = hand({ up: ['index', 'middle', 'ring', 'pinky'] });
  for (let t = 0; t <= 3000; t += 100) r.step([palm], t);
  assert.equal(r.named('reset').length, 1);
  assert.equal(r.statuses.at(-1), 'View reset');
  r.step([hand()], 3100);
  for (let t = 3200; t <= 4400; t += 100) r.step([palm], t);
  assert.equal(r.named('reset').length, 2, 'a fresh palm resets again');
});

test('a fist held closes the galaxy; a brief one does not', () => {
  const r = rig();
  r.step([hand()], 0);
  r.step([hand()], 500);
  r.step([hand({ up: ['index'] })], 600);
  assert.equal(r.closed(), 0);
  for (let t = 700; t <= 2000; t += 100) r.step([hand()], t);
  assert.equal(r.closed(), 1);
});

test('losing the hand mid-pinch opens nothing and clears the hover', () => {
  const r = rig();
  r.step([hand({ up: ['index'], pinch: true })], 0);
  r.step([], 100);
  r.step([hand({ up: ['index'] })], 200);
  assert.equal(r.named('select').length, 0);
  assert.equal(r.statuses[1], 'Show me your hand');
});
