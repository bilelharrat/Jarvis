// Hand gestures with synthetic MediaPipe hands: node --test tests/web/
import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, createGestures, createPageGestures, oneEuro, pageBox, palmCenter, toPage } from '../../src/jarvis/web/gestures.js';

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

function appRig() {
  const calls = [];
  const target = {
    pickAtClient: () => 'button',
    hoverAtClient: (x) => (x === null ? null : 'button'),
    select: (t) => calls.push(['press', t]),
    reset: () => calls.push(['talk']),
    drag: (dx, dy) => calls.push(['scroll', dx, dy]),
    swipe: (dir) => calls.push(['swipe', dir]),
    labels: { hover: 'Pinch to press', reset: 'Listening' },
  };
  const statuses = [];
  const step = createGestures({
    galaxy: target,
    toScreen: (p) => ({ x: p.x * 1000, y: p.y * 1000 }),
    hideCursor: () => {},
    status: (s) => statuses.push(s),
    close: () => calls.push(['stop']),
  });
  return { step, calls, statuses, named: (n) => calls.filter((c) => c[0] === n) };
}

const PALM = ['index', 'middle', 'ring', 'pinky'];

test('app: an open palm swept sideways switches looks, and is not a held palm', () => {
  const r = appRig();
  // camera x falls from 0.7 to 0.4 in 300 ms: the hand moved to the user's right
  [0.7, 0.6, 0.5, 0.4].forEach((cx, i) => r.step([hand({ up: PALM, cx })], i * 100));
  assert.deepEqual(r.named('swipe'), [['swipe', 1]]);
  for (let t = 400; t <= 1300; t += 100) r.step([hand({ up: PALM, cx: 0.4 })], t);
  assert.equal(r.named('talk').length, 0, 'the swipe did not also start listening');
  r.step([hand()], 1400);
  [0.3, 0.45, 0.6].forEach((cx, i) => r.step([hand({ up: PALM, cx })], 2500 + i * 100));
  assert.deepEqual(r.named('swipe').at(-1), ['swipe', -1]);
});

test('app: a slow drift is not a swipe; a still palm held talks', () => {
  const r = appRig();
  for (let i = 0; i <= 12; i++) r.step([hand({ up: PALM, cx: 0.5 + i * 0.01 })], i * 100);
  assert.equal(r.named('swipe').length, 0);
  assert.equal(r.named('talk').length, 1);
  assert.equal(r.statuses.at(-1), 'Listening');
});

test('app: pinch and drag scrolls; a quick pinch presses', () => {
  const r = appRig();
  r.step([hand({ up: ['index'], pinch: true, cy: 0.3 })], 0);
  r.step([hand({ up: ['index'], pinch: true, cy: 0.4 })], 50);
  assert.equal(r.named('scroll').length, 1);
  r.step([hand({ up: ['index'] })], 100);
  assert.equal(r.named('press').length, 0);
  r.step([hand({ up: ['index'], pinch: true })], 1000);
  r.step([hand({ up: ['index'] })], 1100);
  assert.deepEqual(r.named('press'), [['press', 'button']]);
  r.step([hand({ up: ['index'] })], 1200);
  assert.equal(r.statuses.at(-1), 'Pinch to press');
});

test('a fist held on fires once until the hand opens', () => {
  const r = rig();
  for (let t = 0; t <= 5000; t += 100) r.step([hand()], t);
  assert.equal(r.closed(), 1);
  r.step([hand({ up: ['index', 'middle', 'ring', 'pinky'] })], 5100);
  for (let t = 5200; t <= 6500; t += 100) r.step([hand()], t);
  assert.equal(r.closed(), 2);
});

// ── page control (the Research Center) ──

function pageRig() {
  const calls = [];
  let hover = null;
  const page = {
    move: (x, y, mode) => calls.push(['move', x, y, mode]),
    hide: () => calls.push(['hide']),
    press: (x, y) => calls.push(['press', x, y]),
    drag: (dx, dy) => calls.push(['drag', dx, dy]),
    release: (r) => calls.push(['release', r]),
    swipe: (dir) => calls.push(['swipe', dir]),
    zoomBy: (f) => calls.push(['zoom', f]),
    hoverLabel: () => hover,
  };
  const statuses = [];
  let closed = 0;
  const step = createPageGestures({ page, status: (s) => statuses.push(s), close: () => { closed += 1; } });
  return {
    step, calls, statuses, closed: () => closed, setHover: (h) => { hover = h; },
    named: (n) => calls.filter((c) => c[0] === n), last: (n) => calls.filter((c) => c[0] === n).at(-1),
  };
}

test('page: wherever the hand comes up is the middle of the page, and right is right', () => {
  const r = pageRig();
  r.step([hand({ cx: 0.3, cy: 0.6, up: PALM })], 0);
  const [, x0, y0] = r.last('move');
  assert.ok(Math.abs(x0 - 0.5) < 1e-9 && Math.abs(y0 - 0.5) < 1e-9);
  // Camera x is mirrored: the hand moving to the user's right lowers x.
  for (let t = 33; t <= 1000; t += 33) r.step([hand({ cx: 0.2, cy: 0.6, up: PALM })], t);
  assert.ok(r.last('move')[1] > 0.7, `cursor x ${r.last('move')[1]}`);
});

test('page: a quick pinch clicks where the hand was aiming before the fingers closed', () => {
  const r = pageRig();
  let t = 0;
  for (; t < 500; t += 33) r.step([hand({ cx: 0.5, up: PALM })], t);
  const [, ax, ay] = r.last('move');
  r.step([hand({ cx: 0.5, up: ['index'], pinch: true })], t += 33);
  r.step([hand({ cx: 0.5, up: ['index'], pinch: true })], t += 33);
  r.step([hand({ cx: 0.5, up: PALM })], t += 33);
  const [, px, py] = r.last('press');
  assert.ok(Math.abs(px - ax) < 0.01 && Math.abs(py - ay) < 0.01);
  assert.deepEqual(r.last('release')[1], { tap: true, vx: 0, vy: 0 });
  assert.equal(r.named('drag').length, 0);
});

test('page: pinch and move grabs the page and scrolls it, and never clicks', () => {
  const r = pageRig();
  let t = 0;
  for (; t < 300; t += 33) r.step([hand({ cy: 0.5, up: PALM })], t);
  for (let i = 0; i < 12; i += 1) r.step([hand({ cy: 0.5 - i * 0.012, up: ['index'], pinch: true })], t += 33);
  r.step([hand({ cy: 0.36, up: PALM })], t += 33);
  assert.ok(r.named('drag').length > 3);
  assert.ok(r.named('drag').every(([, , dy]) => dy <= 0), 'the hand went up, so the page is pulled up');
  const { tap, vy } = r.last('release')[1];
  assert.equal(tap, false);
  assert.ok(vy < 0, 'let go mid-move: it coasts the same way');
});

test('page: losing the hand mid-pinch clicks nothing', () => {
  const r = pageRig();
  r.step([hand({ up: PALM })], 0);
  r.step([hand({ up: ['index'], pinch: true })], 33);
  r.step([], 66);
  assert.equal(r.last('release')[1].tap, false);
  assert.ok(r.named('hide').length === 1);
});

test('page: an open hand swept right goes back, left goes forward; a slow drift does neither', () => {
  const r = pageRig();
  let t = 0;
  for (let i = 0; i <= 8; i += 1) r.step([hand({ cx: 0.7 - i * 0.04, up: PALM })], t += 33);
  assert.deepEqual(r.named('swipe'), [['swipe', 1]]);
  t += 1000; // a second swipe waits out the first
  for (let i = 0; i <= 8; i += 1) r.step([hand({ cx: 0.4 + i * 0.05, up: PALM })], t += 33);
  assert.deepEqual(r.named('swipe'), [['swipe', 1], ['swipe', -1]]);
  const slow = pageRig();
  for (let i = 0; i <= 40; i += 1) slow.step([hand({ cx: 0.7 - i * 0.008, up: PALM })], i * 33);
  assert.equal(slow.named('swipe').length, 0);
});

test('page: a fist held closes once; a brief fist does not', () => {
  const r = pageRig();
  r.step([hand()], 0);
  r.step([hand()], 500);
  r.step([hand({ up: PALM })], 600);
  assert.equal(r.closed(), 0);
  r.step([hand()], 700);
  r.step([hand()], 2000);
  r.step([hand()], 3000);
  assert.equal(r.closed(), 1);
});

test('page: two hands pinching zoom in as they pull apart', () => {
  const r = pageRig();
  r.step([hand({ cx: 0.4, up: ['index'], pinch: true }), hand({ cx: 0.6, up: ['index'], pinch: true })], 0);
  r.step([hand({ cx: 0.3, up: ['index'], pinch: true }), hand({ cx: 0.7, up: ['index'], pinch: true })], 33);
  assert.ok(r.last('zoom')[1] > 1.5);
  assert.equal(r.named('press').length, 0);
});

test('page: the status line says what a pinch will open', () => {
  const r = pageRig();
  r.setHover('NVDA');
  r.step([hand({ up: PALM })], 0);
  assert.equal(r.statuses.at(-1), 'Pinch to open “NVDA”');
  r.setHover(null);
  r.step([hand({ up: PALM })], 33);
  assert.equal(r.statuses.at(-1), 'Aim with your hand · pinch to open');
});

test('one euro: holds still through jitter, keeps up with a real move', () => {
  const f = oneEuro();
  let out = 0;
  for (let i = 0; i < 60; i += 1) out = f(0.5 + (i % 2 ? 0.01 : -0.01), i * 33);
  assert.ok(Math.abs(out - 0.5) < 0.005, `jitter left ${out - 0.5}`);
  for (let i = 60; i < 75; i += 1) out = f(0.9, i * 33);
  assert.ok(out > 0.85, `after a real move ${out}`);
});

test('the page box stays inside the camera frame', () => {
  const b = pageBox({ x: 0.02, y: 0.98 });
  assert.ok(b.cx - b.width / 2 >= 0 && b.cy + b.height / 2 <= 1);
  assert.deepEqual(toPage({ x: b.cx, y: b.cy }, b), { x: 0.5, y: 0.5 });
  assert.deepEqual(palmCenter(hand({ cx: 0.5, cy: 0.5 })), { x: 0.5, y: 0.54 });
});
