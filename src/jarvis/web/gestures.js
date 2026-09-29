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

// MediaPipe's 21 landmarks, each a finite point. A hand that isn't (a NaN from a bad
// frame, a short list) counts as no hand: one such frame used to poison the smoothing
// filters and freeze the page cursor until the hand was gone for a second.
export function wellFormed(lm) {
  return Array.isArray(lm) && lm.length >= 21
    && lm.every((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
}

function usable(hands) {
  return Array.isArray(hands) ? hands.filter(wellFormed) : [];
}

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

  return function step(seen, now) {
    const hands = usable(seen);
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

// ── Page control: the Research Center ──
//
// Built to be easy rather than clever:
// - The cursor follows the middle of your hand, not a fingertip, so closing a pinch
//   doesn't knock it off what you're aiming at, and any hand shape can aim.
// - Wherever you first raise your hand becomes the middle of the page, and a small
//   box around it covers the whole page: no reaching for the edges of the camera.
// - A One Euro filter holds the cursor still while your hand is still (small links are
//   easy to hold) and keeps up when it moves fast.
// - Pinch and let go: click what was lit just before your fingers closed. Pinch and
//   move: grab the page and scroll it; let go mid-move and it coasts.
// - Swipe an open hand right: back; left: forward. Two hands pinching: zoom. Hold a
//   fist: close.

export const PAGE_BOX = { width: 0.42, height: 0.36 }; // of the camera frame
const PAGE_TAP_MOVE = 0.035; // of the page: how far a pinch may drift and still click
const PAGE_TAP_MS = 800;
const PAGE_LOOKBACK_MS = 120; // aim from just before the fingers closed
const PAGE_REANCHOR_MS = 1200; // a hand gone this long starts again in the middle
const PAGE_SWIPE_SPAN = 0.2; // of the camera frame
const PAGE_SWIPE_MS = 420;

const PAGE_LABELS = {
  idle: 'Raise a hand to steer', aim: 'Aim with your hand · pinch to open',
  hover: (label) => `Pinch to open “${label}”`, press: 'Let go to open · move to scroll',
  drag: 'Scrolling · let go to stop', opened: 'Opened', back: '← Back', forward: 'Forward →',
  zoom: 'Zooming', closeHold: 'Keep the fist to close…',
};

export function palmCenter(lm) {
  const ids = [0, 5, 9, 13, 17];
  let x = 0, y = 0;
  for (const i of ids) { x += lm[i].x; y += lm[i].y; }
  return { x: x / ids.length, y: y / ids.length };
}

// One Euro filter (Casiez et al.): smooths hard when the signal is still, lightly when
// it moves fast. t in ms.
export function oneEuro({ minCutoff = 0.9, beta = 4, dCutoff = 1 } = {}) {
  let prev = null, dPrev = 0, tPrev = 0;
  const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
  const filter = (value, t) => {
    if (!Number.isFinite(value) || !Number.isFinite(t)) return prev === null ? value : prev; // never kept
    if (prev === null) { prev = value; tPrev = t; return value; }
    const dt = Math.max(0.001, (t - tPrev) / 1000);
    tPrev = t;
    dPrev += alpha(dCutoff, dt) * ((value - prev) / dt - dPrev);
    prev += alpha(minCutoff + beta * Math.abs(dPrev), dt) * (value - prev);
    return prev;
  };
  filter.reset = () => { prev = null; dPrev = 0; };
  return filter;
}

// The box of camera space that covers the page, centered where the hand came up and
// kept inside the frame. Camera x is mirrored, so the page's left is the camera's right.
export function pageBox(center, box = PAGE_BOX) {
  const clamp = (v, half) => Math.min(1 - half - 0.02, Math.max(half + 0.02, v));
  return { cx: clamp(center.x, box.width / 2), cy: clamp(center.y, box.height / 2), ...box };
}

export function toPage(p, b) {
  const x = 0.5 - (p.x - b.cx) / b.width;
  const y = 0.5 + (p.y - b.cy) / b.height;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

// page: { move(x, y, mode), hide(), press(x, y), drag(dx, dy), release({ tap, vx, vy }),
// swipe(dir) (1 = the hand went right = back), zoomBy(f), hoverLabel() } with x, y in
// 0..1 of the page. status(text) and close() drive the rest of the UI.
export function createPageGestures({ page, status, close, box = PAGE_BOX }) {
  const fx = oneEuro(), fy = oneEuro();
  let frame = null;
  let lastSeen = -1e9;
  let trail = []; // filtered cursor points, for aiming from just before a pinch
  let pinch = null; // { t, start, last, lastT, moved, dragging, v }
  let pinching = [false, false];
  let span = null;
  let fistSince = 0;
  let fistDone = false;
  let sweep = [];
  let swipedAt = -1e9;
  const say = PAGE_LABELS;

  function letGo(tap) {
    if (!pinch) return;
    const v = pinch.dragging ? pinch.v : { x: 0, y: 0 };
    page.release({ tap, vx: v.x, vy: v.y });
    pinch = null;
  }

  return function step(seen, now) {
    const hands = usable(seen);
    if (!hands.length) {
      letGo(false); // losing the hand never clicks
      span = null;
      fistSince = 0;
      fistDone = false;
      pinching = [false, false];
      sweep = [];
      trail = [];
      page.hide();
      status(say.idle);
      return;
    }
    if (now - lastSeen > PAGE_REANCHOR_MS) {
      frame = pageBox(palmCenter(hands[0]), box);
      fx.reset();
      fy.reset();
    }
    lastSeen = now;
    const kinds = hands.map((lm, i) => classify(lm, pinching[i]));
    pinching = kinds.map((k) => k === 'pinch');

    // Two hands pinching: zoom by the change in distance between them.
    if (hands.length >= 2 && kinds[0] === 'pinch' && kinds[1] === 'pinch') {
      const d = dist(palmCenter(hands[0]), palmCenter(hands[1]));
      if (span && page.zoomBy) page.zoomBy(d / span);
      span = d;
      letGo(false);
      status(say.zoom);
      return;
    }
    span = null;

    const lm = hands[0];
    const kind = kinds[0];
    const raw = toPage(palmCenter(lm), frame);
    const x = fx(raw.x, now), y = fy(raw.y, now);
    trail = trail.filter((p) => now - p.t <= 400);
    trail.push({ x, y, t: now });
    const mode = kind === 'pinch' ? (pinch && pinch.dragging ? 'drag' : 'pinch') : kind === 'fist' ? 'fist' : 'aim';
    page.move(x, y, mode);

    // A quick sideways sweep of the open hand: back or forward.
    if (kind === 'palm' && page.swipe) {
      sweep = sweep.filter((p) => now - p.t <= PAGE_SWIPE_MS);
      sweep.push({ x: lm[0].x, y: lm[0].y, t: now });
      const dx = sweep[0].x - lm[0].x, dy = sweep[0].y - lm[0].y;
      if (Math.abs(dx) >= PAGE_SWIPE_SPAN && Math.abs(dy) < Math.abs(dx) * 0.6 && now - swipedAt > 900) {
        swipedAt = now;
        sweep = [];
        page.swipe(dx > 0 ? 1 : -1);
        status(dx > 0 ? say.back : say.forward);
        return;
      }
    } else sweep = [];

    if (kind === 'fist') {
      letGo(false);
      fistSince = fistSince || now;
      if (!fistDone && now - fistSince >= FIST_MS) {
        fistDone = true;
        close();
        return;
      }
      if (!fistDone) status(say.closeHold);
      return;
    }
    if (kind !== 'other') {
      fistSince = 0;
      fistDone = false;
    } else fistSince = 0;

    if (kind === 'pinch') {
      if (!pinch) {
        const before = trail.find((p) => p.t >= now - PAGE_LOOKBACK_MS) || { x, y };
        pinch = { t: now, start: { x, y }, last: { x, y }, lastT: now, moved: 0, dragging: false, v: { x: 0, y: 0 } };
        page.press(before.x, before.y);
      } else {
        const dx = x - pinch.last.x, dy = y - pinch.last.y;
        pinch.moved = Math.max(pinch.moved, Math.hypot(x - pinch.start.x, y - pinch.start.y));
        if (!pinch.dragging && pinch.moved > PAGE_TAP_MOVE) pinch.dragging = true;
        if (pinch.dragging) {
          page.drag(dx, dy);
          const dt = Math.max(1, now - pinch.lastT) / 1000;
          pinch.v = { x: 0.6 * pinch.v.x + 0.4 * (dx / dt), y: 0.6 * pinch.v.y + 0.4 * (dy / dt) };
        }
        pinch.last = { x, y };
        pinch.lastT = now;
      }
      status(pinch.dragging ? say.drag : say.press);
      return;
    }
    if (pinch) {
      const tap = !pinch.dragging && now - pinch.t < PAGE_TAP_MS;
      letGo(tap);
      if (tap) { status(say.opened); return; }
    }
    if (now - swipedAt < 700) return; // leave "← Back" up for a moment
    const label = page.hoverLabel && page.hoverLabel();
    status(label ? say.hover(label) : say.aim);
  };
}
