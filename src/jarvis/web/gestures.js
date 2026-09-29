// The gesture state machine behind hand control, kept free of the camera and the DOM so
// it can be tested with synthetic hands (tests/web/gestures.test.mjs).
//
// Landmarks are MediaPipe's 21 points per hand, normalized to the camera frame.

export const TIP = { thumb: 4, index: 8, middle: 12, ring: 16, pinky: 20 };
const PIP = { index: 6, middle: 10, ring: 14, pinky: 18 };

// A pinch starts below PINCH_ON and holds until PINCH_OFF, so a pinch that wobbles at
// the threshold doesn't release and re-grab (which would open whatever is underneath).
const PINCH_ON = 0.35;
const PINCH_OFF = 0.5;
const TAP_MOVE = 25; // px a pinch may drift and still count as a tap
const TAP_MS = 600;
const PALM_MS = 1000;
const FIST_MS = 1100;
const SWIPE_SPAN = 0.22; // of the camera frame
const SWIPE_MS = 450;

// What the status line says for each gesture; a target can override any of them.
const GALAXY_LABELS = {
  idle: 'Show me your hand', resetHold: 'Hold open palm to reset…', reset: 'View reset',
  closeHold: 'Hold fist to close…', drag: 'Spinning', pinch: 'Pinch', hover: 'Pinch to open',
  point: 'Pointing', opened: 'Opened', zoom: 'Zoom',
};

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function handSize(lm) { return dist(lm[0], lm[9]) || 0.1; }

function extended(lm, finger) { return dist(lm[TIP[finger]], lm[0]) > dist(lm[PIP[finger]], lm[0]) * 1.12; }

export function classify(lm, wasPinching = false) {
  const gap = dist(lm[TIP.thumb], lm[TIP.index]) / handSize(lm);
  if (gap < (wasPinching ? PINCH_OFF : PINCH_ON)) return 'pinch';
  const up = ['index', 'middle', 'ring', 'pinky'].map((f) => extended(lm, f));
  if (up.every(Boolean)) return 'palm';
  if (up[0] && !up[1] && !up[2] && !up[3]) return 'point';
  if (!up.some(Boolean)) return 'fist';
  return 'other';
}

// galaxy (any target): { pickAtClient, hoverAtClient, select, reset } plus optional
// rotateBy / drag (pinch and move), zoomBy (two-hand pinch), swipe(dir) (open palm swept
// sideways, dir 1 = right) and labels (status text overrides).
// toScreen(p, kind) maps a normalized point to a (smoothed) screen point and shows the
// cursor there; hideCursor(), status(text) and close() drive the rest of the UI.
export function createGestures({ galaxy, toScreen, hideCursor, status, close }) {
  let pinch = null; // { t, target, moved, last }
  let span = null; // two-hand pinch distance
  let palmSince = 0;
  let palmDone = false;
  let fistSince = 0;
  let fistDone = false; // one fist, one action: open the hand to do it again
  let pinching = [false, false];
  let trail = []; // open-palm positions for swipes
  let swipedAt = -1e9;
  const say = { ...GALAXY_LABELS, ...(galaxy.labels || {}) };

  function release(now) {
    if (pinch && pinch.moved < TAP_MOVE && now - pinch.t < TAP_MS && pinch.target) {
      galaxy.select(pinch.target);
      status(say.opened);
    }
    pinch = null;
  }

  return function step(hands, now) {
    if (!hands.length) {
      hideCursor();
      pinch = null;
      span = null;
      palmSince = fistSince = 0;
      fistDone = false;
      palmDone = false;
      pinching = [false, false];
      trail = [];
      galaxy.hoverAtClient(null, null);
      status(say.idle);
      return;
    }
    const kinds = hands.map((lm, i) => classify(lm, pinching[i]));
    pinching = kinds.map((k) => k === 'pinch');

    // Two hands pinching: zoom by the change in distance between them.
    if (hands.length >= 2 && kinds[0] === 'pinch' && kinds[1] === 'pinch') {
      const now2 = dist(hands[0][TIP.index], hands[1][TIP.index]);
      if (span && galaxy.zoomBy) galaxy.zoomBy(Math.pow(span / now2, 1.6));
      span = now2;
      pinch = null; // a zoom never ends in a tap
      status(say.zoom);
      return;
    }
    span = null;

    const lm = hands[0];
    const kind = kinds[0];
    const tip = kind === 'pinch'
      ? { x: (lm[TIP.thumb].x + lm[TIP.index].x) / 2, y: (lm[TIP.thumb].y + lm[TIP.index].y) / 2 }
      : lm[TIP.index];
    const pt = toScreen(tip, kind);

    if (kind === 'palm' && galaxy.swipe) {
      // A quick sideways sweep of the open hand. Camera x is mirrored: x falling means
      // the hand moved to the user's right.
      trail = trail.filter((p) => now - p.t <= SWIPE_MS);
      trail.push({ x: lm[0].x, t: now });
      const dx = trail[0].x - lm[0].x;
      if (Math.abs(dx) >= SWIPE_SPAN && now - swipedAt > 900) {
        swipedAt = now;
        trail = [];
        palmDone = true; // a swipe is not a held palm
        galaxy.swipe(dx > 0 ? 1 : -1);
      }
    } else trail = [];

    if (kind === 'palm') {
      palmSince = palmSince || now;
      if (!palmDone && now - palmSince >= PALM_MS && now - swipedAt > PALM_MS) {
        galaxy.reset();
        palmDone = true;
      }
      if (now - swipedAt > 400) status(palmDone ? say.reset : say.resetHold);
    } else {
      palmSince = 0;
      palmDone = false;
    }

    if (kind === 'fist') {
      fistSince = fistSince || now;
      if (!fistDone && now - fistSince >= FIST_MS) {
        fistDone = true;
        close();
        return;
      }
      if (!fistDone) status(say.closeHold);
    } else if (kind !== 'other') {
      // A relaxed, half-curled hand reads as "other" and flickers; only a clearly open
      // or pointing hand re-arms the fist.
      fistSince = 0;
      fistDone = false;
    } else fistSince = 0;

    if (kind === 'pinch') {
      if (!pinch) {
        pinch = { t: now, target: galaxy.pickAtClient(pt.x, pt.y), moved: 0, last: pt, start: pt };
      } else {
        const dx = pt.x - pinch.last.x, dy = pt.y - pinch.last.y;
        // How far from where the pinch began (not the path length: the smoothed cursor
        // keeps settling for a moment after a pinch starts).
        pinch.moved = Math.max(pinch.moved, Math.hypot(pt.x - pinch.start.x, pt.y - pinch.start.y));
        if (galaxy.drag) galaxy.drag(dx, dy);
        else if (galaxy.rotateBy) galaxy.rotateBy(dx * 0.006, dy * 0.006);
        pinch.last = pt;
      }
      status(pinch.moved > TAP_MOVE ? say.drag : say.pinch);
    } else release(now);

    if (kind === 'point') status(galaxy.hoverAtClient(pt.x, pt.y) ? say.hover : say.point);
  };
}
