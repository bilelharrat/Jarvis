// Hand gestures with synthetic MediaPipe hands: node --test tests/web/
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APP_BOX, DESKTOP_BOX, classify, createDesktopGestures, createGestures, createPageGestures, desktopMessages, handSize, oneEuro,
  pageBox, palmCenter, pinchGap, toDesktop, toPage, wellFormed,
} from '../../src/jarvis/web/gestures.js';

// A right hand around (cx, cy): wrist at the bottom, fingers pointing up. `up` lists the
// extended fingers; `pinch` closes the thumb onto the index tip. `size` scales the whole
// hand (1: wrist to middle knuckle is 0.2 of the frame; 0.5 is a hand twice as far away).
function hand({ cx = 0.5, cy = 0.5, up = [], pinch = false, gap = null, size = 1 } = {}) {
  const at = (dx, dy) => ({ x: cx + dx * size, y: cy + dy * size });
  const lm = Array.from({ length: 21 }, () => at(0, 0));
  lm[0] = at(0, 0.2); // wrist
  lm[9] = at(0, 0); // middle knuckle: hand size 0.2
  const cols = { index: -0.06, middle: -0.02, ring: 0.02, pinky: 0.06 };
  const joints = { index: [6, 8], middle: [10, 12], ring: [14, 16], pinky: [18, 20] };
  for (const [f, dx] of Object.entries(cols)) {
    const [pip, tip] = joints[f];
    lm[pip] = at(dx, -0.05);
    lm[tip] = up.includes(f) ? at(dx, -0.15) : at(dx, 0.05);
  }
  lm[4] = at(-0.12, 0); // thumb, well away from the index tip
  if (pinch || gap !== null) lm[4] = { x: lm[8].x + (gap ?? 0.01) * size, y: lm[8].y };
  return lm;
}

const PALM = ['index', 'middle', 'ring', 'pinky'];
const FRAME = 33; // ms: a 30 fps camera

// Feed `make(t, i)` from t = from for `n` frames; returns the time of the next frame.
function play(step, from, n, make, dt = FRAME) {
  let t = from;
  for (let i = 0; i < n; i += 1, t += dt) step(make(t, i), t);
  return t;
}

// A small repeatable wobble, like tracking noise.
function noise(seed) {
  let s = seed;
  return () => { s = (s * 16807) % 2147483647; return (s / 2147483647 - 0.5) * 2; };
}
function jittered(lm, amp, rnd) { return lm.map((p) => ({ x: p.x + amp * rnd(), y: p.y + amp * rnd() })); }

// ── classification ──

test('classifies the five hand shapes', () => {
  assert.equal(classify(hand({ up: PALM })), 'palm');
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

test('a pinch reads the same near the camera and far from it', () => {
  for (const size of [0.4, 0.7, 1, 1.4]) {
    assert.equal(classify(hand({ up: ['index'], pinch: true, size })), 'pinch', `size ${size}`);
    assert.notEqual(classify(hand({ up: ['index'], size })), 'pinch', `open at size ${size}`);
    assert.ok(Math.abs(pinchGap(hand({ up: ['index'], gap: 0.05, size })) - 0.25) < 1e-9);
  }
});

test('a fist with the thumb over the curled index is a fist, not a pinch', () => {
  const fist = hand();
  fist[8] = { x: 0.47, y: 0.56 }; // index tip curled back into the palm
  fist[4] = { x: 0.49, y: 0.53 }; // thumb resting over it
  assert.equal(classify(fist), 'fist');
});

test('a hand tipped toward the camera keeps its size', () => {
  const flat = hand({ up: PALM });
  const tipped = flat.map((p) => ({ x: p.x, y: 0.5 + (p.y - 0.5) * 0.4 })); // foreshortened top to bottom
  tipped[5] = { x: 0.44, y: 0.5 }; // the knuckles still span the palm's width
  tipped[17] = { x: 0.56, y: 0.5 };
  assert.ok(handSize(tipped) > handSize(flat) * 0.8, `${handSize(tipped)} vs ${handSize(flat)}`);
});

test('sideways gaps count in real proportions on a 4:3 camera', () => {
  // The same 0.3-hand-size gap, once up-down and once sideways.
  const upright = hand({ up: ['index'] });
  upright[4] = { x: upright[8].x, y: upright[8].y + 0.06 };
  const sideways = hand({ up: ['index'] });
  sideways[4] = { x: sideways[8].x + 0.06 / (4 / 3), y: sideways[8].y };
  assert.ok(Math.abs(pinchGap(upright, 4 / 3) - pinchGap(sideways, 4 / 3)) < 1e-9);
  assert.ok(pinchGap(sideways, 1) < pinchGap(sideways, 4 / 3), 'without the aspect it would read short');
});

// ── the app and the galaxy ──

function rig({ labels, swipe = false, drag = false, aspect } = {}) {
  const calls = [];
  const galaxy = {
    pickAtClient: (x, y) => { calls.push(['pick', x, y]); return 'note-1'; },
    hoverAtClient: (x) => { calls.push(['hover', x]); return x === null ? null : 'note-1'; },
    zoomBy: (f) => calls.push(['zoom', f]),
    reset: () => calls.push(['reset']),
    select: (id) => calls.push(['select', id]),
    labels,
  };
  if (drag) galaxy.drag = (dx, dy) => calls.push(['scroll', dx, dy]);
  else galaxy.rotateBy = (dx, dy) => calls.push(['rotate', dx, dy]);
  if (swipe) galaxy.swipe = (dir) => calls.push(['swipe', dir]);
  const statuses = [];
  let closed = 0;
  const step = createGestures({
    galaxy,
    toScreen: (p, kind, pinch) => { calls.push(['cursor', p.x * 1000, p.y * 1000, kind, pinch]); return { x: p.x * 1000, y: p.y * 1000 }; },
    hideCursor: () => calls.push(['hideCursor']),
    status: (s) => statuses.push(s),
    close: () => { closed += 1; },
    aspect,
  });
  return {
    step, calls, statuses, closed: () => closed,
    named: (n) => calls.filter((c) => c[0] === n), last: (n) => calls.filter((c) => c[0] === n).at(-1),
  };
}

const appRig = () => rig({ swipe: true, drag: true, labels: { hover: 'Pinch to press', reset: 'Listening' } });
const point = (o = {}) => hand({ up: ['index'], ...o });
const pinched = (o = {}) => hand({ up: ['index'], pinch: true, ...o });

test('a quick pinch on a star opens it, once', () => {
  const r = rig();
  let t = play(r.step, 0, 10, () => [point()]);
  t = play(r.step, t, 5, () => [pinched()]);
  play(r.step, t, 5, () => [point()]);
  assert.deepEqual(r.named('select'), [['select', 'note-1']]);
  assert.equal(r.named('pick').length, 1);
});

test('one bad frame that looks like a pinch opens nothing', () => {
  const r = rig();
  let t = play(r.step, 0, 10, () => [point()]);
  t = play(r.step, t, 1, () => [pinched()]);
  play(r.step, t, 10, () => [point()]);
  assert.equal(r.named('pick').length, 0);
  assert.equal(r.named('select').length, 0);
});

test('one bad frame that looks open mid-pinch does not let go and re-grab', () => {
  const r = rig();
  let t = play(r.step, 0, 5, () => [point()]);
  t = play(r.step, t, 4, () => [pinched()]);
  t = play(r.step, t, 1, () => [point()]);
  t = play(r.step, t, 4, () => [pinched()]);
  play(r.step, t, 3, () => [point()]);
  assert.equal(r.named('pick').length, 1);
  assert.equal(r.named('select').length, 1, 'one pinch, one open');
});

test('the galaxy cursor holds still while the fingers close, and picks where it aimed', () => {
  const r = rig();
  let t = play(r.step, 0, 15, () => [point()]);
  const [, ax, ay] = r.last('cursor');
  // Closing a pinch drags the index tip down to the thumb and nudges the hand.
  const closing = (k) => {
    const lm = point({ cy: 0.5 + 0.004 * k });
    lm[8] = { x: lm[8].x, y: lm[8].y + 0.03 * k };
    lm[4] = { x: lm[8].x + 0.01, y: lm[8].y };
    return lm;
  };
  t = play(r.step, t, 4, (_, i) => [closing(i + 1)]);
  const cursors = r.named('cursor').slice(-4);
  assert.ok(cursors.every(([, x, y]) => Math.hypot(x - ax, y - ay) < 3), JSON.stringify(cursors.map((c) => [c[1] - ax, c[2] - ay])));
  const [, px, py] = r.last('pick');
  assert.ok(Math.hypot(px - ax, py - ay) < 3, `picked ${px - ax}, ${py - ay} from the aim`);
  play(r.step, t, 3, () => [point()]);
  assert.equal(r.named('select').length, 1);
});

test('the cursor shows a pinch closing before it clicks', () => {
  const r = rig();
  play(r.step, 0, 3, () => [point()]);
  const open = r.last('cursor')[4];
  r.step([hand({ up: ['index'], gap: 0.1 })], 200); // half closed
  const half = r.last('cursor')[4];
  assert.equal(open, 0);
  assert.ok(half > 0.2 && half < 1, `half-closed pinch shows ${half}`);
});

test('pinch and drag spins the galaxy and does not open anything', () => {
  const r = rig();
  let t = play(r.step, 0, 5, () => [point({ cx: 0.4 })]);
  t = play(r.step, t, 12, (_, i) => [pinched({ cx: 0.4 + i * 0.01 })]);
  play(r.step, t, 3, () => [point({ cx: 0.52 })]);
  assert.ok(r.named('rotate').length >= 5);
  // Camera x rising is the hand going to the user's left; toScreen here isn't mirrored.
  assert.ok(r.named('rotate').every(([, dx]) => dx > 0));
  assert.equal(r.named('select').length, 0);
});

test('a small wobble during a pinch is still a click', () => {
  const r = rig();
  let t = play(r.step, 0, 5, () => [point()]);
  t = play(r.step, t, 8, (_, i) => [pinched({ cx: 0.5 + (i % 2 ? 0.006 : -0.006) })]);
  play(r.step, t, 3, () => [point()]);
  assert.equal(r.named('rotate').length, 0);
  assert.equal(r.named('select').length, 1);
});

test('a long pinch without moving is not a tap', () => {
  const r = rig();
  let t = play(r.step, 0, 3, () => [point()]);
  t = play(r.step, t, 40, () => [pinched()]);
  play(r.step, t, 3, () => [point()]);
  assert.equal(r.named('select').length, 0);
});

test('a pinch closed while the hand sweeps past grabs instead of clicking', () => {
  const r = rig();
  // 0.02 of the frame a frame: 3 hand sizes a second.
  play(r.step, 0, 20, (_, i) => [i >= 10 && i < 14 ? pinched({ cx: 0.3 + i * 0.02 }) : point({ cx: 0.3 + i * 0.02 })]);
  assert.equal(r.named('select').length, 0);
});

test('two hands pinching zoom in as they pull apart and out as they push together', () => {
  const r = rig();
  const two = (spread) => [pinched({ cx: 0.5 - spread }), pinched({ cx: 0.5 + spread })];
  let t = play(r.step, 0, 3, () => two(0.1));
  t = play(r.step, t, 5, (_, i) => two(0.1 + (i + 1) * 0.02));
  const apart = r.named('zoom').length;
  assert.ok(apart > 0 && r.named('zoom').every(([, f]) => f < 1), 'pulling apart moves the camera closer');
  t = play(r.step, t, 5, (_, i) => two(0.2 - (i + 1) * 0.02));
  assert.ok(r.named('zoom').slice(apart).every(([, f]) => f > 1));
  play(r.step, t, 5, () => [point()]);
  assert.equal(r.named('select').length, 0, 'letting go of a zoom never opens a star');
});

test('two hands held still do not creep the zoom', () => {
  const r = rig();
  const rnd = noise(7);
  play(r.step, 0, 60, () => [jittered(pinched({ cx: 0.3 }), 0.002, rnd), jittered(pinched({ cx: 0.7 }), 0.002, rnd)]);
  assert.equal(r.named('zoom').length, 0);
});

test('after a zoom, the hand still pinching opens nothing when it lets go', () => {
  const r = rig();
  const two = (spread) => [pinched({ cx: 0.5 - spread }), pinched({ cx: 0.5 + spread })];
  let t = play(r.step, 0, 6, (_, i) => two(0.15 + i * 0.02));
  t = play(r.step, t, 3, () => [pinched({ cx: 0.3 })]); // the other hand let go first
  play(r.step, t, 5, () => [point({ cx: 0.3 })]);
  assert.equal(r.named('select').length, 0);
  assert.equal(r.named('pick').length, 0);
});

test('an open palm held a second resets the view once', () => {
  const r = rig();
  const palm = hand({ up: PALM });
  for (let t = 0; t <= 3000; t += 100) r.step([palm], t);
  assert.equal(r.named('reset').length, 1);
  assert.equal(r.statuses.at(-1), 'View reset');
  r.step([hand()], 3100);
  for (let t = 3200; t <= 4400; t += 100) r.step([palm], t);
  assert.equal(r.named('reset').length, 2, 'a fresh palm resets again');
});

test('a held palm rides out a misread frame, and holds take as long at any frame rate', () => {
  for (const dt of [16, 33, 66]) {
    const r = rig();
    const t = play(r.step, 0, Math.round(600 / dt), () => [hand({ up: PALM })], dt);
    r.step([hand({ up: ['index', 'middle'] })], t); // one misread
    play(r.step, t + dt, Math.round(350 / dt), () => [hand({ up: PALM })], dt);
    assert.equal(r.named('reset').length, 0, `not yet at ${dt} ms frames`);
    play(r.step, t + dt + Math.round(350 / dt) * dt, Math.round(200 / dt), () => [hand({ up: PALM })], dt);
    assert.equal(r.named('reset').length, 1, `one reset at ${dt} ms frames`);
  }
});

test('a fist held closes the galaxy; a brief one does not', () => {
  const r = rig();
  r.step([hand()], 0);
  r.step([hand()], 500);
  r.step([point()], 600);
  assert.equal(r.closed(), 0);
  for (let t = 700; t <= 2000; t += 100) r.step([hand()], t);
  assert.equal(r.closed(), 1);
});

test('a fist held on fires once until the hand opens', () => {
  const r = rig();
  for (let t = 0; t <= 5000; t += 100) r.step([hand()], t);
  assert.equal(r.closed(), 1);
  r.step([hand({ up: PALM })], 5100);
  for (let t = 5200; t <= 6500; t += 100) r.step([hand()], t);
  assert.equal(r.closed(), 2);
});

test('fingers pointed at the camera are not a fist', () => {
  const r = rig();
  // Seen end-on, the fingers look curled and the palm looks short.
  const endOn = hand().map((p) => ({ x: p.x, y: 0.5 + (p.y - 0.5) * 0.35 }));
  endOn[5] = { x: 0.44, y: 0.5 };
  endOn[17] = { x: 0.56, y: 0.5 };
  assert.equal(classify(endOn), 'fist');
  play(r.step, 0, 80, () => [endOn]);
  assert.equal(r.closed(), 0);
});

test('a fist moving around (a hand on its way somewhere) does not close', () => {
  const r = rig();
  play(r.step, 0, 60, (_, i) => [hand({ cx: 0.3 + (i % 20) * 0.015 })]);
  assert.equal(r.closed(), 0);
});

test('losing the hand mid-pinch opens nothing and clears the hover', () => {
  const r = rig();
  let t = play(r.step, 0, 5, () => [point()]);
  t = play(r.step, t, 4, () => [pinched()]);
  t = play(r.step, t, 12, () => []); // gone for 400 ms
  play(r.step, t, 3, () => [point()]);
  assert.equal(r.named('select').length, 0);
  assert.ok(r.statuses.includes('Show me your hand'));
  assert.ok(r.calls.some((c) => c[0] === 'hover' && c[1] === null));
});

test('a tracking blink holds the cursor and the pinch', () => {
  const r = rig();
  let t = play(r.step, 0, 10, () => [point()]);
  t = play(r.step, t, 4, () => [pinched()]);
  const cursorsBefore = r.named('cursor').length;
  t = play(r.step, t, 3, () => []); // 100 ms blink
  assert.equal(r.named('hideCursor').length, 0);
  assert.equal(r.named('cursor').length, cursorsBefore, 'nothing moved during the blink');
  t = play(r.step, t, 3, () => [pinched()]);
  play(r.step, t, 3, () => [point()]);
  assert.equal(r.named('pick').length, 1, 'still the same pinch');
  assert.equal(r.named('select').length, 1);
});

test('a pinch whose letting go the camera missed opens nothing', () => {
  const r = rig();
  let t = play(r.step, 0, 5, () => [point()]);
  t = play(r.step, t, 4, () => [pinched()]);
  t = play(r.step, t, 4, () => []);
  play(r.step, t, 4, () => [point()]);
  assert.equal(r.named('select').length, 0);
});

test('the app cursor reaches the screen edges without the hand leaving the camera', () => {
  const r = rig();
  // The index tip at the box's edge; the hand is still well inside the frame.
  const left = APP_BOX.cx - APP_BOX.width / 2;
  const edge = point({ cx: left + 0.06 }); // index tip is 0.06 left of the hand's center
  play(r.step, 0, 10, () => [edge]);
  assert.ok(r.last('cursor')[1] < 5, `cursor x ${r.last('cursor')[1]}`);
  assert.ok(edge.every((p) => p.x > 0.05));
});

test('app: an open palm swept sideways switches looks, and is not a held palm', () => {
  const r = appRig();
  // 0.6 of the frame (3 hand sizes) in 300 ms: camera x falls, the hand moved to the user's right
  let t = play(r.step, 0, 10, (_, i) => [hand({ up: PALM, cx: 0.8 - i * 0.066 })]);
  assert.deepEqual(r.named('swipe'), [['swipe', 1]]);
  t = play(r.step, t, 40, () => [hand({ up: PALM, cx: 0.2 })]);
  assert.equal(r.named('talk').length, 0, 'the swipe did not also start listening');
  assert.notEqual(r.statuses.at(-1), 'Listening');
  t = play(r.step, t, 10, () => [hand()]);
  play(r.step, t, 10, (_, i) => [hand({ up: PALM, cx: 0.2 + i * 0.066 })]);
  assert.deepEqual(r.named('swipe').at(-1), ['swipe', -1]);
});

test('app: a slow drift is not a swipe; a still palm held talks', () => {
  const r = rig({ swipe: true, drag: true, labels: { reset: 'Listening' } });
  for (let i = 0; i <= 12; i++) r.step([hand({ up: PALM, cx: 0.5 + i * 0.01 })], i * 100);
  assert.equal(r.named('swipe').length, 0);
  assert.equal(r.named('reset').length, 1);
  assert.equal(r.statuses.at(-1), 'Listening');
});

test('app: pinch and drag scrolls; a quick pinch presses', () => {
  const r = appRig();
  let t = play(r.step, 0, 3, () => [point({ cy: 0.3 })]);
  t = play(r.step, t, 10, (_, i) => [pinched({ cy: 0.3 + i * 0.012 })]);
  assert.ok(r.named('scroll').length >= 3);
  assert.ok(r.named('scroll').every(([, , dy]) => dy > 0));
  t = play(r.step, t, 3, () => [point({ cy: 0.42 })]);
  assert.equal(r.named('select').length, 0);
  t = play(r.step, t + 1000, 3, () => [pinched({ cy: 0.42 })]);
  t = play(r.step, t, 3, () => [point({ cy: 0.42 })]);
  assert.deepEqual(r.named('select'), [['select', 'note-1']]);
  play(r.step, t, 2, () => [point({ cy: 0.42 })]);
  assert.equal(r.statuses.at(-1), 'Pinch to press');
});

test('the galaxy cursor holds still on a still hand and keeps up with a fast one', () => {
  const r = rig();
  const rnd = noise(11);
  play(r.step, 0, 60, () => [jittered(point(), 0.003, rnd)]);
  const xs = r.named('cursor').slice(-30).map((c) => c[1]);
  assert.ok(Math.max(...xs) - Math.min(...xs) < 6, `jitter spread ${Math.max(...xs) - Math.min(...xs)} px of 1000`);
  let t = play(r.step, 2000, 8, (_, i) => [point({ cx: 0.5 - (i + 1) * 0.025 })]); // 0.2 in 260 ms
  t = play(r.step, t, 3, () => [point({ cx: 0.3 })]);
  const want = (0.5 + (0.3 - APP_BOX.cx) / APP_BOX.width) * 1000 + (-0.06 / APP_BOX.width) * 1000;
  assert.ok(Math.abs(r.last('cursor')[1] - want) < 15, `cursor ${r.last('cursor')[1]} wants ${want}`);
});

test('the galaxy gestures take a bad frame as no hand', () => {
  const galaxy = { hoverAtClient() {}, select() {}, spin() {}, zoom() {}, resetView() {}, starAtClient: () => null };
  const step = createGestures({ galaxy, toScreen: (p) => p, hideCursor() {}, status() {}, close() {} });
  for (const bad of [[[{ x: NaN, y: 0 }]], [undefined], 'junk', undefined, null]) {
    assert.doesNotThrow(() => step(bad, 0));
  }
});

// ── two hands in view ──

test('two hands: the steering hand stays put when the tracker swaps their order', () => {
  const r = rig();
  const a = point({ cx: 0.3, size: 1.1 }), b = point({ cx: 0.7 });
  const views = [];
  play(r.step, 0, 30, (t, i) => (i % 2 ? [a, b] : [b, a]));
  for (let i = 0; i < 6; i += 1) views.push(r.step(i % 2 ? [a, b] : [b, a], 1000 + i * FRAME).hand);
  const xs = r.named('cursor').slice(-20).map((c) => c[1]);
  assert.ok(Math.max(...xs) - Math.min(...xs) < 1, 'the cursor never jumped to the other hand');
  assert.deepEqual(views, [1, 0, 1, 0, 1, 0], 'step reports where the steering hand is in this frame');
});

test('two hands: the nearer hand steers, and a hand coming into view does not take over', () => {
  const r = rig();
  play(r.step, 0, 10, () => [point({ cx: 0.35 }), point({ cx: 0.7, size: 1.3 })]);
  const near = r.last('cursor')[1];
  const r2 = rig();
  play(r2.step, 0, 10, () => [point({ cx: 0.7, size: 1.3 })]);
  assert.ok(Math.abs(near - r2.last('cursor')[1]) < 1, 'the bigger (nearer) hand steers');
  const r3 = rig();
  let t = play(r3.step, 0, 10, () => [point({ cx: 0.35 })]);
  const before = r3.last('cursor')[1];
  play(r3.step, t, 10, () => [point({ cx: 0.35 }), point({ cx: 0.7, size: 1.3 })]);
  assert.ok(Math.abs(r3.last('cursor')[1] - before) < 1, 'the first hand keeps steering');
});

test('two hands: when the steering hand leaves, the other takes over after a moment', () => {
  const r = rig();
  let t = play(r.step, 0, 10, () => [point({ cx: 0.35 }), point({ cx: 0.7 })]);
  const first = r.last('cursor')[1];
  t = play(r.step, t, 3, () => [point({ cx: 0.7 })]); // within the blink grace: holds
  assert.ok(Math.abs(r.last('cursor')[1] - first) < 1);
  play(r.step, t, 12, () => [point({ cx: 0.7 })]);
  assert.ok(Math.abs(r.last('cursor')[1] - first) > 100, 'the other hand steers now');
});

// ── page control (the Research Center) ──

function pageRig({ aspect } = {}) {
  const calls = [];
  let hover = null, risky = false;
  const page = {
    move: (x, y, mode) => calls.push(['move', x, y, mode]),
    hide: () => calls.push(['hide']),
    press: (x, y) => calls.push(['press', x, y]),
    drag: (dx, dy) => calls.push(['drag', dx, dy]),
    release: (r) => calls.push(['release', r]),
    swipe: (dir) => calls.push(['swipe', dir]),
    zoomBy: (f) => calls.push(['zoom', f]),
    hoverLabel: () => hover,
    hoverRisky: () => risky,
  };
  const statuses = [];
  let closed = 0;
  const step = createPageGestures({ page, status: (s) => statuses.push(s), close: () => { closed += 1; }, aspect });
  return {
    step, calls, statuses, closed: () => closed, setHover: (h, r = false) => { hover = h; risky = r; },
    named: (n) => calls.filter((c) => c[0] === n), last: (n) => calls.filter((c) => c[0] === n).at(-1),
  };
}

const open = (o = {}) => hand({ up: PALM, ...o });

test('page: wherever the hand comes up is the middle of the page, and right is right', () => {
  const r = pageRig();
  r.step([open({ cx: 0.3, cy: 0.6 })], 0);
  const [, x0, y0] = r.last('move');
  assert.ok(Math.abs(x0 - 0.5) < 1e-9 && Math.abs(y0 - 0.5) < 1e-9);
  // Camera x is mirrored: the hand moving to the user's right lowers x.
  for (let t = 33; t <= 1000; t += 33) r.step([open({ cx: 0.2, cy: 0.6 })], t);
  assert.ok(r.last('move')[1] > 0.7, `cursor x ${r.last('move')[1]}`);
});

test('page: a quick pinch clicks where the hand was aiming before the fingers closed', () => {
  const r = pageRig();
  let t = play(r.step, 0, 15, () => [open()]);
  const [, ax, ay] = r.last('move');
  t = play(r.step, t, 3, () => [pinched()]);
  play(r.step, t, 3, () => [open()]);
  const [, px, py] = r.last('press');
  assert.ok(Math.abs(px - ax) < 0.01 && Math.abs(py - ay) < 0.01);
  assert.deepEqual(r.last('release')[1], { tap: true, vx: 0, vy: 0 });
  assert.equal(r.named('release').length, 1);
  assert.equal(r.named('drag').length, 0);
});

test('page: the click lands where you aimed even though pinching nudges the hand', () => {
  const r = pageRig();
  let t = play(r.step, 0, 20, () => [open()]);
  const [, ax, ay] = r.last('move');
  // The fingers start closing (the palm dips a little each frame), then pinch.
  t = play(r.step, t, 3, (_, i) => [hand({ up: ['index'], gap: 0.1 - i * 0.03, cy: 0.5 + i * 0.004 })]);
  t = play(r.step, t, 5, (_, i) => [pinched({ cy: 0.512 + i * 0.004 })]); // 0.16 of a hand size in all
  const during = r.named('move').slice(-5);
  assert.ok(during.every(([, x, y]) => Math.hypot(x - ax, y - ay) < 0.005), 'the cursor held still through the pinch');
  play(r.step, t, 3, () => [open({ cy: 0.53 })]);
  const [, px, py] = r.last('press');
  assert.ok(Math.hypot(px - ax, py - ay) < 0.005, `press ${px - ax}, ${py - ay} from the aim`);
  assert.equal(r.last('release')[1].tap, true);
  assert.equal(r.named('drag').length, 0);
});

test('page: a pinch registers exactly once near the camera, far from it, and on a 4:3 camera', () => {
  for (const [size, aspect] of [[0.5, 1], [1, 1], [1.4, 1], [0.6, 4 / 3], [1, 4 / 3]]) {
    const r = pageRig({ aspect: () => aspect });
    let t = play(r.step, 0, 10, () => [open({ size })]);
    t = play(r.step, t, 6, () => [pinched({ size })]);
    play(r.step, t, 6, () => [open({ size })]);
    assert.equal(r.named('press').length, 1, `press at size ${size}, aspect ${aspect}`);
    assert.deepEqual(r.named('release').map((c) => c[1].tap), [true], `one click at size ${size}, aspect ${aspect}`);
  }
});

test('page: one bad frame that looks like a pinch clicks nothing', () => {
  const r = pageRig();
  let t = play(r.step, 0, 10, () => [open()]);
  t = play(r.step, t, 1, () => [pinched()]);
  play(r.step, t, 10, () => [open()]);
  assert.equal(r.named('press').length, 0);
  assert.equal(r.named('release').length, 0);
});

test('page: a pinch closed while the hand is moving fast scrolls, never clicks', () => {
  const r = pageRig();
  // 0.02 of the frame a frame at 30 fps: 3 hand sizes a second.
  play(r.step, 0, 24, (_, i) => [i >= 12 && i < 18 ? pinched({ cy: 0.4 + i * 0.02 }) : open({ cy: 0.4 + i * 0.02 })]);
  assert.ok(r.named('release').length === 1);
  assert.equal(r.last('release')[1].tap, false);
});

test('page: pinch and move grabs the page and scrolls it, and never clicks', () => {
  const r = pageRig();
  let t = play(r.step, 0, 10, () => [open()]);
  t = play(r.step, t, 14, (_, i) => [pinched({ cy: 0.5 - i * 0.012 })]);
  play(r.step, t, 3, () => [open({ cy: 0.34 })]);
  assert.ok(r.named('drag').length > 3);
  assert.ok(r.named('drag').every(([, , dy]) => dy <= 0), 'the hand went up, so the page is pulled up');
  const { tap, vy } = r.last('release')[1];
  assert.equal(tap, false);
  assert.ok(vy < 0, 'let go mid-move: it coasts the same way');
  assert.equal(r.last('move')[3], 'aim');
});

test('page: a mostly-vertical pull scrolls only vertically', () => {
  const r = pageRig();
  let t = play(r.step, 0, 10, () => [open()]);
  t = play(r.step, t, 14, (_, i) => [pinched({ cy: 0.5 - i * 0.012, cx: 0.5 + i * 0.003 })]);
  play(r.step, t, 3, () => [open()]);
  assert.ok(r.named('drag').length > 3);
  assert.ok(r.named('drag').every(([, dx]) => dx === 0));
});

test('page: a hard flick coasts, but not off the end of the world', () => {
  const r = pageRig();
  let t = play(r.step, 0, 10, () => [open()]);
  t = play(r.step, t, 8, (_, i) => [pinched({ cy: 0.3 + i * 0.05 })]);
  play(r.step, t, 3, () => [open({ cy: 0.7 })]);
  const { vx, vy } = r.last('release')[1];
  assert.ok(vy > 0 && Math.hypot(vx, vy) <= 3 + 1e-9, `coast ${vy}`);
});

test('page: a blink of the tracker mid-scroll keeps scrolling without a jump', () => {
  const r = pageRig();
  let t = play(r.step, 0, 10, () => [open()]);
  t = play(r.step, t, 8, (_, i) => [pinched({ cy: 0.5 - i * 0.01 })]);
  const before = r.last('move');
  t = play(r.step, t, 2, () => []); // two dropped frames
  assert.equal(r.named('hide').length, 0);
  assert.equal(r.last('move'), before, 'the cursor held where it was');
  t = play(r.step, t, 6, (_, i) => [pinched({ cy: 0.42 - i * 0.01 })]);
  assert.equal(r.named('press').length, 1, 'the same grab, not a new one');
  assert.equal(r.named('release').length, 0);
  const after = r.named('move').at(-6);
  assert.ok(Math.abs(after[2] - before[2]) < 0.06, `jumped ${after[2] - before[2]}`);
  play(r.step, t, 3, () => [open({ cy: 0.36 })]);
  assert.equal(r.last('release')[1].tap, false);
});

test('page: losing the hand mid-pinch clicks nothing', () => {
  const r = pageRig();
  let t = play(r.step, 0, 5, () => [open()]);
  t = play(r.step, t, 3, () => [pinched()]);
  play(r.step, t, 10, () => []);
  assert.equal(r.last('release')[1].tap, false);
  assert.equal(r.named('hide').length, 1);
  assert.equal(r.statuses.at(-1), 'Raise a hand to steer');
});

test('page: an open hand swept right goes back, left goes forward; a slow drift does neither', () => {
  const r = pageRig();
  let t = play(r.step, 0, 10, (_, i) => [open({ cx: 0.8 - i * 0.066 })]);
  assert.deepEqual(r.named('swipe'), [['swipe', 1]]);
  assert.equal(r.statuses.at(-1), '← Back');
  t = play(r.step, t + 1000, 10, (_, i) => [open({ cx: 0.2 + i * 0.066 })]);
  assert.deepEqual(r.named('swipe'), [['swipe', 1], ['swipe', -1]]);
  const slow = pageRig();
  play(slow.step, 0, 40, (_, i) => [open({ cx: 0.7 - i * 0.008 })]);
  assert.equal(slow.named('swipe').length, 0);
});

test('page: aiming quickly across the page is not a swipe', () => {
  // A real hand (0.15 of the frame) moves the cursor 80% of the way across in 400 ms.
  const size = 0.75;
  const r = pageRig({ aspect: () => 4 / 3 });
  play(r.step, 0, 13, (_, i) => [open({ size, cx: 0.62 - i * 0.021 })]);
  assert.equal(r.named('swipe').length, 0);
  const side = pageRig({ aspect: () => 4 / 3 });
  // The same distance fast, but a wave back and forth rather than one sweep.
  play(side.step, 0, 12, (_, i) => [open({ size, cx: 0.5 + (i % 4 < 2 ? 0.1 : -0.1) })]);
  assert.equal(side.named('swipe').length, 0);
  const pointing = pageRig();
  play(pointing.step, 0, 10, (_, i) => [point({ cx: 0.8 - i * 0.066 })]);
  assert.equal(pointing.named('swipe').length, 0, 'only an open hand swipes');
});

test('page: a swipe fires at any frame rate', () => {
  for (const dt of [16, 33, 50]) {
    const r = pageRig();
    const n = Math.round(300 / dt);
    play(r.step, 0, n + 1, (_, i) => [open({ cx: 0.8 - (0.6 * i) / n })], dt);
    assert.deepEqual(r.named('swipe'), [['swipe', 1]], `at ${dt} ms frames`);
  }
});

test('page: a fist held closes once; a brief fist does not', () => {
  const r = pageRig();
  let t = play(r.step, 0, 15, () => [hand()]); // 500 ms
  t = play(r.step, t, 3, () => [open()]);
  assert.equal(r.closed(), 0);
  t = play(r.step, t, 30, () => [hand()]); // 1 s: not yet
  assert.equal(r.closed(), 0);
  assert.equal(r.statuses.at(-1), 'Keep the fist to close…');
  play(r.step, t, 60, () => [hand()]);
  assert.equal(r.closed(), 1);
});

test('page: a fist held through a misread frame still closes on time', () => {
  const r = pageRig();
  let t = play(r.step, 0, 20, () => [hand()]);
  t = play(r.step, t, 1, () => [hand({ up: ['index', 'middle'] })]);
  play(r.step, t, 16, () => [hand()]); // 1.2 s in all
  assert.equal(r.closed(), 1);
});

test('page: two hands pinching zoom in as they pull apart', () => {
  const r = pageRig();
  const two = (spread) => [pinched({ cx: 0.5 - spread }), pinched({ cx: 0.5 + spread })];
  let t = play(r.step, 0, 3, () => two(0.1));
  t = play(r.step, t, 5, (_, i) => two(0.1 + (i + 1) * 0.02));
  const f = r.named('zoom').reduce((acc, [, k]) => acc * k, 1);
  assert.ok(f > 1.5, `zoomed ${f}`);
  assert.equal(r.named('press').length, 0);
  // The second hand lets go first; the first then lets go too. Nothing is clicked.
  t = play(r.step, t, 4, () => [pinched({ cx: 0.3 })]);
  play(r.step, t, 4, () => [open({ cx: 0.3 })]);
  assert.equal(r.named('press').length, 0);
  assert.ok(!r.named('release').some((c) => c[1].tap));
});

test('page: two hands swapping places in the list do not flip the cursor', () => {
  const r = pageRig();
  const a = open({ cx: 0.3, size: 1.1 }), b = open({ cx: 0.7 });
  play(r.step, 0, 30, (_, i) => (i % 2 ? [a, b] : [b, a]));
  const xs = r.named('move').slice(-20).map((c) => c[1]);
  assert.ok(Math.max(...xs) - Math.min(...xs) < 0.001);
});

test('page: the status line says what a pinch will open, and when it needs two', () => {
  const r = pageRig();
  r.setHover('NVDA');
  r.step([open()], 0);
  assert.equal(r.statuses.at(-1), 'Pinch to open “NVDA”');
  r.setHover('Delete memo', true);
  r.step([open()], 33);
  assert.equal(r.statuses.at(-1), '“Delete memo” needs a second pinch');
  r.setHover(null);
  r.step([open()], 66);
  assert.equal(r.statuses.at(-1), 'Aim with your hand · pinch to open');
});

test('page: a hand the camera keeps losing gets a hint about the light', () => {
  const r = pageRig();
  let t = 0;
  for (let k = 0; k < 4; k += 1) {
    t = play(r.step, t, 6, () => [open()]);
    t = play(r.step, t, 2, () => []);
  }
  play(r.step, t, 2, () => [open()]);
  assert.equal(r.statuses.at(-1), 'Hard to see your hand · more light helps');
  play(r.step, t + 4000, 3, () => [open()]);
  assert.equal(r.statuses.at(-1), 'Aim with your hand · pinch to open', 'and it goes once tracking is steady');
});

test('page: the cursor holds still on a still hand and keeps up with a fast one', () => {
  const r = pageRig();
  const rnd = noise(3);
  let t = play(r.step, 0, 60, () => [jittered(open(), 0.002, rnd)]);
  const xs = r.named('move').slice(-30).map((c) => c[1]);
  assert.ok(Math.max(...xs) - Math.min(...xs) < 0.006, `jitter spread ${Math.max(...xs) - Math.min(...xs)} of the page`);
  t = play(r.step, t, 8, (_, i) => [open({ cx: 0.5 - (i + 1) * 0.015 })]); // 0.12 of the frame in 260 ms
  play(r.step, t, 3, () => [open({ cx: 0.38 })]);
  const want = 0.5 + 0.12 / 0.42;
  assert.ok(Math.abs(r.last('move')[1] - want) < 0.03, `cursor ${r.last('move')[1]} wants ${want}`);
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

test('a bad frame (NaN, a short list, no hand at all) never freezes the page cursor', () => {
  const moves = [];
  const page = { move: (x, y, m) => moves.push([x, y, m]), hide() {}, press() {}, drag() {}, release() {}, swipe() {}, zoomBy() {}, hoverLabel() {} };
  const step = createPageGestures({ page, status() {}, close() {} });
  const hand = (x, y) => Array.from({ length: 21 }, (_, i) => ({ x: x + (i % 5) * 0.01, y: y + Math.floor(i / 5) * 0.01, z: 0 }));
  step([hand(0.5, 0.5)], 0);
  const nan = hand(0.5, 0.5); nan[0] = { x: NaN, y: 0.5, z: 0 };
  for (const bad of [[nan], [hand(0.5, 0.5).slice(0, 1)], [undefined], [null], 'junk', undefined]) {
    assert.doesNotThrow(() => step(bad, 16));
  }
  moves.length = 0;
  for (let i = 1; i <= 30; i += 1) step([hand(0.5 + i * 0.002, 0.5)], 100 + i * 16);
  assert.equal(moves.length, 30);
  assert.ok(moves.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)));
  assert.ok(!wellFormed(nan) && wellFormed(hand(0.1, 0.1)));
  const f = oneEuro();
  assert.equal(f(0.4, 0), 0.4);
  assert.equal(f(NaN, 16), 0.4); // held, not kept
  assert.ok(Number.isFinite(f(0.41, 32)));
});

// ── desktop control (the whole Mac) ──

function deskRig({ aspect } = {}) {
  const calls = [];
  const desktop = {
    move: (x, y) => calls.push(['move', x, y]),
    press: (x, y, b) => calls.push(['press', x, y, b]),
    release: (x, y, b) => calls.push(['release', x, y, b]),
    click: (x, y, o) => calls.push(['click', x, y, o.button, o.count]),
    scroll: (dx, dy) => calls.push(['scroll', dx, dy]),
    cancel: () => calls.push(['cancel']),
  };
  const statuses = [];
  const pauses = [];
  const g = createDesktopGestures({ desktop, status: (s) => statuses.push(s), paused: (on) => pauses.push(on), aspect });
  const named = (n) => calls.filter((c) => c[0] === n);
  // Anything that presses a button: what must never happen by accident.
  const buttons = () => calls.filter((c) => c[0] === 'click' || c[0] === 'press');
  return { g, step: g.step, calls, statuses, pauses, named, buttons, last: (n) => named(n).at(-1) };
}

const twoUp = (o = {}) => hand({ up: ['index', 'middle'], ...o });
// Thumb to the middle fingertip, the index still up: a right click.
function rightPinched(o = {}) {
  const lm = hand({ up: ['index'], ...o });
  lm[4] = { x: lm[12].x + 0.01 * (o.size || 1), y: lm[12].y };
  return lm;
}

test('desktop: the box covers the screen, mirrored, with the hand inside the frame', () => {
  const b = DESKTOP_BOX;
  assert.deepEqual(toDesktop({ x: b.cx, y: b.cy }), { x: 0.5, y: 0.5 });
  const left = toDesktop({ x: b.cx + b.width / 2, y: b.cy - b.height / 2 }); // camera right = screen left
  assert.ok(Math.abs(left.x) < 1e-9 && Math.abs(left.y) < 1e-9);
  assert.deepEqual(toDesktop({ x: 0, y: 1 }), { x: 1, y: 1 }, 'clamped to the screen');
  // The palm at the box's edge: a real-sized hand is still wholly in view.
  const edge = open({ cx: b.cx + b.width / 2, cy: b.cy, size: 0.75 });
  assert.ok(edge.every((p) => p.x > 0 && p.x < 1 && p.y > 0 && p.y < 1));
});

test('desktop: a hand passing through the frame moves nothing; one that stays steers', () => {
  const r = deskRig();
  play(r.step, 0, 6, (_, i) => [open({ cx: 0.3 + i * 0.05 })]); // 200 ms
  play(r.step, 1000, 3, () => []);
  assert.equal(r.named('move').length, 0);
  play(r.step, 2000, 15, () => [open({ cx: 0.4 })]);
  assert.ok(r.named('move').length > 0);
  const [, x] = r.last('move');
  assert.ok(Math.abs(x - toDesktop(palmCenter(open({ cx: 0.4 }))).x) < 0.01, `cursor x ${x}`);
});

test('desktop: moving right moves the cursor right; a still hand holds it within a point or two', () => {
  const r = deskRig();
  let t = play(r.step, 0, 15, () => [open({ cx: 0.55 })]);
  const x0 = r.last('move')[1];
  t = play(r.step, t, 15, (_, i) => [open({ cx: 0.55 - (i + 1) * 0.01 })]);
  assert.ok(r.last('move')[1] > x0 + 0.2, 'camera x falling is the hand going to the user’s right');
  const rnd = noise(5);
  play(r.step, t + 2000, 60, () => [jittered(open({ cx: 0.45 }), 0.002, rnd)]);
  const xs = r.named('move').slice(-30).map((c) => c[1] * 1728);
  assert.ok(Math.max(...xs) - Math.min(...xs) < 3, `jitter spread ${Math.max(...xs) - Math.min(...xs)} pt`);
});

test('desktop: moving about without pinching never clicks or presses', () => {
  const r = deskRig();
  const rnd = noise(17);
  // A long wander: open, pointing, relaxed, fingers drifting toward a pinch but never
  // closing, one misread pinch frame, tracking noise.
  play(r.step, 0, 400, (_, i) => {
    const cx = 0.5 + 0.2 * Math.sin(i / 17), cy = 0.45 + 0.15 * Math.cos(i / 23);
    const shape = i % 97 === 50 ? pinched({ cx, cy })
      : i % 40 < 10 ? hand({ up: ['index'], gap: 0.12 + 0.05 * Math.abs(Math.sin(i)), cx, cy })
        : i % 40 < 25 ? open({ cx, cy }) : point({ cx, cy });
    return [jittered(shape, 0.002, rnd)];
  });
  assert.equal(r.buttons().length, 0, JSON.stringify(r.buttons().slice(0, 3)));
  assert.equal(r.named('scroll').length, 0);
  assert.ok(r.named('move').length > 300);
});

test('desktop: a quick pinch clicks once, where the hand aimed before the fingers closed', () => {
  const r = deskRig();
  let t = play(r.step, 0, 20, () => [open()]);
  const [, ax, ay] = r.last('move');
  // The fingers close (the palm dips a little each frame), then let go.
  t = play(r.step, t, 3, (_, i) => [hand({ up: ['index'], gap: 0.1 - i * 0.03, cy: 0.5 + i * 0.004 })]);
  t = play(r.step, t, 5, (_, i) => [pinched({ cy: 0.512 + i * 0.004 })]);
  const during = r.named('move').slice(-5);
  assert.ok(during.every(([, x, y]) => Math.hypot(x - ax, y - ay) < 0.004), 'the cursor held through the pinch');
  play(r.step, t, 4, () => [open({ cy: 0.53 })]);
  assert.equal(r.named('click').length, 1);
  const [, cx, cy, button, count] = r.last('click');
  assert.ok(Math.hypot(cx - ax, cy - ay) < 0.004, `clicked ${cx - ax}, ${cy - ay} from the aim`);
  assert.deepEqual([button, count], ['left', 1]);
  assert.equal(r.named('press').length, 0);
  assert.equal(r.named('release').length, 0);
});

test('desktop: one bad frame that looks like a pinch clicks nothing', () => {
  const r = deskRig();
  let t = play(r.step, 0, 15, () => [open()]);
  t = play(r.step, t, 1, () => [pinched()]);
  play(r.step, t, 10, () => [open()]);
  assert.equal(r.buttons().length, 0);
});

test('desktop: a pinch closed while the hand sweeps past does nothing at all', () => {
  const r = deskRig();
  play(r.step, 0, 30, (_, i) => [i >= 12 && i < 20 ? pinched({ cx: 0.3 + i * 0.02 }) : open({ cx: 0.3 + i * 0.02 })]);
  assert.equal(r.buttons().length, 0);
  assert.equal(r.named('release').length, 0);
});

test('desktop: pinch and move drags from where it aimed and drops where the hand goes', () => {
  const r = deskRig();
  let t = play(r.step, 0, 15, () => [open({ cx: 0.55 })]);
  const [, ax, ay] = r.last('move');
  t = play(r.step, t, 3, () => [pinched({ cx: 0.55 })]);
  t = play(r.step, t, 20, (_, i) => [pinched({ cx: 0.55 - (i + 1) * 0.006 })]);
  play(r.step, t, 4, () => [open({ cx: 0.43 })]);
  assert.equal(r.named('press').length, 1);
  const [, px, py, b] = r.last('press');
  assert.ok(Math.hypot(px - ax, py - ay) < 0.004 && b === 'left');
  const moves = r.calls.slice(r.calls.indexOf(r.last('press')), r.calls.indexOf(r.last('release'))).filter((c) => c[0] === 'move');
  assert.ok(moves.length > 5 && moves.at(-1)[1] > ax + 0.15, 'the cursor followed the hand while held');
  assert.equal(r.named('release').length, 1);
  assert.ok(r.last('release')[1] > ax + 0.15);
  assert.equal(r.named('click').length, 0, 'a drag is never also a click');
});

test('desktop: a pinch held still presses, so a slow drag can start exactly on its mark', () => {
  const r = deskRig();
  let t = play(r.step, 0, 15, () => [open()]);
  const [, ax] = r.last('move');
  t = play(r.step, t, 20, () => [pinched()]); // 660 ms
  assert.equal(r.named('press').length, 1);
  assert.ok(Math.abs(r.last('press')[1] - ax) < 0.004);
  t = play(r.step, t, 20, (_, i) => [pinched({ cx: 0.5 - i * 0.002 })]); // slowly
  play(r.step, t, 3, () => [open({ cx: 0.46 })]);
  assert.equal(r.named('release').length, 1);
  assert.ok(r.last('release')[1] > ax + 0.03);
  assert.equal(r.named('click').length, 0);
});

test('desktop: two quick pinches double click on the first one’s spot; slow ones are two clicks', () => {
  const r = deskRig();
  let t = play(r.step, 0, 15, () => [open()]);
  t = play(r.step, t, 4, () => [pinched()]);
  t = play(r.step, t, 4, () => [open({ cx: 0.501 })]);
  t = play(r.step, t, 4, () => [pinched({ cx: 0.501 })]);
  t = play(r.step, t, 4, () => [open({ cx: 0.501 })]);
  const clicks = r.named('click');
  assert.deepEqual(clicks.map((c) => c[4]), [1, 2]);
  assert.deepEqual(clicks[1].slice(1, 3), clicks[0].slice(1, 3));
  t = play(r.step, t + 1000, 4, () => [pinched()]);
  play(r.step, t, 4, () => [open()]);
  assert.equal(r.last('click')[4], 1, 'a second later is a new single click');
});

test('desktop: thumb to middle finger right clicks, once; a bad frame does not', () => {
  const r = deskRig();
  let t = play(r.step, 0, 15, () => [point()]);
  const [, ax, ay] = r.last('move');
  t = play(r.step, t, 1, () => [rightPinched()]);
  t = play(r.step, t, 8, () => [point()]);
  assert.equal(r.buttons().length, 0);
  t = play(r.step, t, 6, () => [rightPinched()]);
  play(r.step, t, 5, () => [point()]);
  assert.equal(r.named('click').length, 1);
  const [, x, y, button, count] = r.last('click');
  assert.deepEqual([button, count], ['right', 1]);
  assert.ok(Math.hypot(x - ax, y - ay) < 0.004);
  assert.equal(r.named('press').length, 0);
});

test('desktop: two fingers up and moving scroll the content with the hand, and never click', () => {
  const r = deskRig();
  let t = play(r.step, 0, 15, () => [point()]);
  const held = r.last('move');
  t = play(r.step, t, 5, () => [twoUp()]);
  t = play(r.step, t, 15, (_, i) => [twoUp({ cy: 0.5 - (i + 1) * 0.01, cx: 0.5 + i * 0.001 })]);
  const scrolls = r.named('scroll');
  assert.ok(scrolls.length > 5);
  assert.ok(scrolls.every(([, dx, dy]) => dx === 0 && dy < 0), 'hand up, content up, and only up');
  const total = scrolls.reduce((s, c) => s + c[2], 0);
  assert.ok(total < -0.3, `scrolled ${total} of the screen`);
  const moves = r.named('move').slice(-15);
  assert.ok(moves.every(([, x, y]) => Math.hypot(x - held[1], y - held[2]) < 0.02), 'the cursor held still');
  play(r.step, t, 10, () => [point({ cy: 0.35 })]);
  assert.equal(r.buttons().length, 0);
});

test('desktop: two fingers held still scroll nothing', () => {
  const r = deskRig();
  const rnd = noise(9);
  play(r.step, 0, 60, () => [jittered(twoUp(), 0.002, rnd)]);
  assert.equal(r.named('scroll').length, 0);
});

test('desktop: a held fist pauses at once and holds the cursor; an open palm held resumes', () => {
  const r = deskRig();
  let t = play(r.step, 0, 15, () => [open()]);
  t = play(r.step, t, 10, () => [hand()]); // 330 ms: not yet
  assert.deepEqual(r.pauses, []);
  assert.equal(r.statuses.at(-1), 'Keep the fist to pause…');
  t = play(r.step, t, 15, () => [hand()]);
  assert.deepEqual(r.pauses, [true]);
  assert.equal(r.named('cancel').length, 1);
  const moves = r.named('move').length;
  t = play(r.step, t, 20, (_, i) => [pinched({ cx: 0.4 + i * 0.01 })]); // nothing works while paused
  t = play(r.step, t, 10, () => [point()]);
  assert.equal(r.named('move').length, moves);
  assert.equal(r.buttons().length, 0);
  assert.equal(r.g.paused, true);
  t = play(r.step, t, 35, () => [open()]);
  assert.deepEqual(r.pauses, [true, false]);
  play(r.step, t, 3, () => [open()]);
  assert.ok(r.named('move').length > moves, 'steering again');
});

// A fist closed the rest of the way from a pinch: the index curled into the palm.
function tightFist(o = {}) {
  const lm = hand(o);
  const size = o.size || 1;
  lm[8] = { x: lm[0].x - 0.03 * size, y: lm[0].y - 0.14 * size };
  return lm;
}

test('desktop: a fist mid-drag drops at once; a fist closing a pinch never clicks', () => {
  const r = deskRig();
  let t = play(r.step, 0, 15, () => [open()]);
  t = play(r.step, t, 12, (_, i) => [pinched({ cx: 0.5 - i * 0.008 })]);
  assert.equal(r.named('press').length, 1);
  play(r.step, t, 2, () => [tightFist({ cx: 0.41 })]); // the pinch settles open, then it's a fist
  assert.equal(r.named('release').length, 1, 'let go as soon as the fist shows');
  assert.equal(r.named('click').length, 0);
  const r2 = deskRig();
  t = play(r2.step, 0, 15, () => [open()]);
  t = play(r2.step, t, 4, () => [pinched()]);
  play(r2.step, t, 5, () => [tightFist()]);
  assert.equal(r2.buttons().length, 0);
  assert.equal(r2.named('release').length, 0);
});

test('desktop: losing the hand drops a drag and clicks nothing; a blink holds on', () => {
  const r = deskRig();
  let t = play(r.step, 0, 15, () => [open()]);
  t = play(r.step, t, 12, (_, i) => [pinched({ cx: 0.5 - i * 0.008 })]);
  t = play(r.step, t, 3, () => []); // 100 ms blink
  assert.equal(r.named('release').length, 0);
  t = play(r.step, t, 4, (_, i) => [pinched({ cx: 0.41 - i * 0.008 })]);
  assert.equal(r.named('press').length, 1, 'the same drag');
  play(r.step, t, 12, () => []); // gone
  assert.equal(r.named('release').length, 1);
  const r2 = deskRig();
  t = play(r2.step, 0, 15, () => [open()]);
  t = play(r2.step, t, 4, () => [pinched()]);
  t = play(r2.step, t, 12, () => []);
  play(r2.step, t, 20, () => [open()]);
  assert.equal(r2.buttons().length, 0);
  assert.ok(r2.statuses.includes('Raise a hand to steer the Mac'));
});

test('desktop: stop() lets go of a held button', () => {
  const r = deskRig();
  let t = play(r.step, 0, 15, () => [open()]);
  play(r.step, t, 20, () => [pinched()]);
  assert.equal(r.named('press').length, 1);
  r.g.stop();
  assert.equal(r.named('release').length, 1);
  assert.equal(r.last('cancel')[0], 'cancel');
});

test('desktop: bad frames are no hand', () => {
  const r = deskRig();
  for (const bad of [[[{ x: NaN, y: 0 }]], [undefined], 'junk', undefined, null]) {
    assert.doesNotThrow(() => r.step(bad, 0));
  }
  assert.equal(r.calls.length, 0);
});

test('desktop: messages for the backend', () => {
  const sent = [];
  const m = desktopMessages((msg) => sent.push(msg));
  m.move(0.123456, 0.5);
  m.click(0.1, 0.2, { button: 'right', count: 1 });
  m.scroll(0, -0.02);
  m.cancel();
  assert.deepEqual(sent, [
    { type: 'desktop_hand', op: 'move', x: 0.1235, y: 0.5 },
    { type: 'desktop_hand', op: 'click', x: 0.1, y: 0.2, button: 'right', count: 1 },
    { type: 'desktop_hand', op: 'scroll', dx: 0, dy: -0.02 },
    { type: 'desktop_hand', op: 'cancel' },
  ]);
  assert.equal(m.kind, 'desktop');
});
