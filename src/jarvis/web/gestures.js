// The gesture state machine behind hand control, kept free of the camera and the DOM so
// it can be tested with synthetic hands (tests/web/gestures.test.mjs).
//
// Landmarks are MediaPipe's 21 points per hand, normalized to the camera frame: x to its
// width, y to its height. Distances are measured with x scaled back by the frame's aspect
// (on a 4:3 camera a sideways gap otherwise reads 25% short of an upright one) and in hand
// sizes, so every threshold means the same near the camera and far from it.
//
// Timing is in ms of real frame timestamps, never frame counts: a slow camera or a busy
// GPU doesn't change how long a hold takes or how fast a swipe has to be.

export const TIP = { thumb: 4, index: 8, middle: 12, ring: 16, pinky: 20 };
const PIP = { index: 6, middle: 10, ring: 14, pinky: 18 };

// A pinch closes below PINCH_ON and holds until PINCH_OFF (thumb tip to index tip, in hand
// sizes), so a pinch that wobbles at the threshold doesn't release and re-grab.
const PINCH_ON = 0.35;
const PINCH_OFF = 0.5;
const PINCH_SHOWN = 0.8; // the cursor starts showing a pinch closing from this gap
// A fist's thumb rests near the curled index tip too; in a pinch the index still reaches
// out at least this far from the wrist (of its knuckle's distance).
const PINCH_REACH = 0.75;
const SETTLE_MS = 25; // a pinch must stay closed (or open) this long: one bad frame is not a click
const DROP_MS = 250; // tracking may blink this long without the hand counting as gone
const LOOKBACK_MS = 100; // a pinch aims from just before the fingers began to close
const DRAG_START = 0.2; // hand sizes a pinch must travel before it grabs
const TAP_SPEED = 3; // hand sizes/s: a pinch closed while moving this fast grabs, never clicks
const TAP_MS = 1000;
const HOLD_GRACE_MS = 180; // a held palm or fist survives a misread frame or two
const HOLD_STILL = 0.75; // hand sizes a held palm or fist may wander and still count
const PALM_MS = 1000;
const FIST_MS = 1100;
const SWIPE_SPAN = 2.5; // hand sizes the open hand must sweep...
const SWIPE_MS = 350; // ...within this long: faster and longer than aiming across the screen
const SWIPE_GAP_MS = 900;
// Two hands' distance is smoothed, then must change this much before a zoom moves: hands
// held still never creep the view.
const ZOOM_STEP = 0.01;
const ZOOM_FILTER = { minCutoff: 1, beta: 5 };
const UNSTEADY_BLINKS = 3; // tracking blinks within UNSTEADY_MS that mean it can barely see
const UNSTEADY_MS = 3000;

// The app and the galaxy aim with the index fingertip over this box of the camera, not the
// whole frame: reaching for the screen's edges shouldn't take the hand out of view.
export const APP_BOX = { cx: 0.5, cy: 0.42, width: 0.7, height: 0.6 };

// What the status line says for each gesture; a target can override any of them.
const GALAXY_LABELS = {
  idle: 'Show me your hand', resetHold: 'Hold open palm to reset…', reset: 'View reset',
  closeHold: 'Hold fist to close…', drag: 'Spinning', pinch: 'Pinch', hover: 'Pinch to open',
  point: 'Pointing', opened: 'Opened', zoom: 'Zoom', unsteady: 'Hard to see your hand · more light helps',
};

function dist(a, b, aspect = 1) { return Math.hypot((a.x - b.x) * aspect, a.y - b.y); }

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// Wrist to middle knuckle, unless the hand tips toward the camera and foreshortens that:
// then the palm's width or index side stands in. A size that collapses would make every
// gap look wide (missed pinches) and every move look big.
export function handSize(lm, aspect = 1) {
  return Math.max(dist(lm[0], lm[9], aspect), dist(lm[0], lm[5], aspect), dist(lm[5], lm[17], aspect) * 1.4) || 0.1;
}

function extended(lm, finger, aspect) {
  return dist(lm[TIP[finger]], lm[0], aspect) > dist(lm[PIP[finger]], lm[0], aspect) * 1.12;
}

// Thumb tip to index tip in hand sizes. Depth counts at half weight (MediaPipe's z is
// noisier than x and y): a hand turned side-on lines the tips up without touching them.
export function pinchGap(lm, aspect = 1) {
  const a = lm[TIP.thumb], b = lm[TIP.index];
  const dz = Number.isFinite(a.z) && Number.isFinite(b.z) ? (a.z - b.z) * aspect * 0.5 : 0;
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y, dz) / handSize(lm, aspect);
}

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

export function classify(lm, wasPinching = false, aspect = 1) {
  const reach = dist(lm[TIP.index], lm[0], aspect) >= dist(lm[5], lm[0], aspect) * PINCH_REACH;
  if (reach && pinchGap(lm, aspect) < (wasPinching ? PINCH_OFF : PINCH_ON)) return 'pinch';
  const up = ['index', 'middle', 'ring', 'pinky'].map((f) => extended(lm, f, aspect));
  if (up.every(Boolean)) return 'palm';
  if (up[0] && !up[1] && !up[2] && !up[3]) return 'point';
  if (!up.some(Boolean)) return 'fist';
  return 'other';
}

// A fingers-toward-the-camera hand reads as curled too; a real fist still shows the full
// length of the palm.
function upright(lm, size, aspect) { return dist(lm[0], lm[9], aspect) >= size * 0.65; }

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

// A boolean that only flips once the new value has held for `ms`; `at` is when the
// change began (the first frame of it), `pending` when an unconfirmed one did.
function settle(ms) {
  const s = { value: false, at: -1e9, pending: null };
  s.feed = (raw, now) => {
    if (raw === s.value) s.pending = null;
    else if (s.pending === null) s.pending = now;
    if (s.pending !== null && now - s.pending >= ms) {
      s.value = raw;
      s.at = s.pending;
      s.pending = null;
    }
    return s.value;
  };
  return s;
}

// Follows each hand from frame to frame by where it is, not by MediaPipe's list order
// (which swaps when two hands are in view), and keeps one of them steering: the one that
// was, else the biggest (nearest the camera). The steering hand may blink out for DROP_MS
// without another taking over.
function createTracker(aspectOf) {
  let tracks = [];
  let primaryId = 0;
  let nextId = 1;
  return function track(hands, now) {
    const aspect = aspectOf() || 1;
    const live = tracks.filter((t) => now - t.t <= DROP_MS);
    const seen = hands.map((lm) => ({ lm, palm: palmCenter(lm), size: handSize(lm, aspect) }));
    const pairs = [];
    seen.forEach((h, i) => live.forEach((t) => {
      const d = dist(h.palm, t.palm, aspect) / Math.max(h.size, t.size);
      if (d <= 2 + (30 * (now - t.t)) / 1000) pairs.push({ i, t, d }); // no hand moves 30 sizes a second
    }));
    pairs.sort((a, b) => a.d - b.d);
    const matched = new Map();
    const used = new Set();
    for (const { i, t } of pairs) {
      if (!matched.has(i) && !used.has(t)) { matched.set(i, t); used.add(t); }
    }
    const current = seen.map((h, i) => {
      const t = matched.get(i) || { id: nextId++, pinch: settle(SETTLE_MS) };
      Object.assign(t, h, { t: now, index: i });
      const raw = classify(h.lm, t.pinch.value, aspect);
      t.pinch.feed(raw === 'pinch', now);
      t.gap = pinchGap(h.lm, aspect);
      t.kind = t.pinch.value ? 'pinch' : raw === 'pinch' ? 'other' : raw;
      t.closing = !t.pinch.value && raw === 'pinch'; // not a pinch yet, but aim is already frozen
      t.opening = t.pinch.value && raw !== 'pinch'; // letting go, not confirmed yet
      t.pinchSince = t.pinch.value ? t.pinch.at : t.pinch.pending;
      t.upright = upright(h.lm, h.size, aspect);
      return t;
    });
    tracks = [...current, ...live.filter((t) => !used.has(t))];
    let primary = current.find((t) => t.id === primaryId) || null;
    const waiting = !primary && live.some((t) => t.id === primaryId);
    let fresh = false;
    if (!primary && !waiting && current.length) {
      primary = current.reduce((a, b) => (b.size > a.size ? b : a));
      primaryId = primary.id;
      fresh = true;
    }
    return { primary, others: current.filter((t) => t !== primary), waiting, fresh, aspect };
  };
}

// An open hand swept sideways: at least SWIPE_SPAN hand sizes within SWIPE_MS, mostly
// sideways, one way (not a wobble), by a mostly open hand. Returns 1 when the hand went to
// the user's right (camera x is mirrored: x falls), -1 left, else 0.
function createSwipe() {
  let trail = [];
  let lastAt = -1e9;
  return {
    reset() { trail = []; },
    feed(p, now, aspect) {
      if (p.kind === 'pinch' || p.kind === 'fist' || p.kind === 'point' || p.closing) { trail = []; return 0; }
      trail = trail.filter((s) => now - s.t <= SWIPE_MS);
      trail.push({ x: p.palm.x * aspect, y: p.palm.y, t: now, size: p.size, open: p.kind === 'palm' });
      if (now - lastAt < SWIPE_GAP_MS || trail.length < 3) return 0;
      const first = trail[0], last = trail[trail.length - 1];
      const dx = first.x - last.x, dy = first.y - last.y;
      let path = 0, size = 0, open = 0;
      trail.forEach((s, i) => {
        if (i) path += Math.abs(s.x - trail[i - 1].x);
        size += s.size / trail.length;
        open += s.open ? 1 / trail.length : 0;
      });
      if (Math.abs(dx) < SWIPE_SPAN * size || Math.abs(dy) > Math.abs(dx) * 0.6) return 0;
      if (Math.abs(dx) < path * 0.8 || open < 0.5) return 0;
      lastAt = now;
      trail = [];
      return dx > 0 ? 1 : -1;
    },
  };
}

// A pose held still for `ms`: a misread frame or two doesn't restart it, wandering off
// does. feed() is true once, on the frame it completes; `done` stays up until the hand
// shows something else (rearm) for longer than a misread.
function createHold(ms) {
  let since = 0, lastYes = -1e9, origin = null, rearming = false;
  const h = { done: false };
  h.feed = (yes, p, now, aspect) => {
    if (!yes) return false;
    const gap = now - lastYes > HOLD_GRACE_MS;
    if (gap && rearming) h.done = false;
    rearming = false; // back within a misread: the same hold, still done
    if (!since || gap || dist(p.palm, origin, aspect) > HOLD_STILL * p.size) {
      since = now;
      origin = p.palm;
    }
    lastYes = now;
    if (!h.done && now - since >= ms) { h.done = true; return true; }
    return false;
  };
  h.rearm = (now) => {
    if (now - lastYes > HOLD_GRACE_MS) h.done = false;
    else rearming = true;
  };
  // A clearly different pose (not a misread): the hold is over, and armed again.
  h.clear = () => { since = 0; lastYes = -1e9; rearming = false; h.done = false; };
  return h;
}

// Where the cursor was at time t (the first trail point at or after it).
function lookback(trail, t) {
  return trail.find((s) => s.t >= t) || trail[trail.length - 1];
}

// How fast the hand was moving (hand sizes/s) in the moment before t.
function speedBefore(trail, t) {
  const win = trail.filter((s) => s.t <= t && s.t >= t - 120);
  if (win.length < 2) return 0;
  const a = win[0], b = win[win.length - 1];
  return Math.hypot(b.rx - a.rx, b.ry - a.ry) / b.size / Math.max(0.001, (b.t - a.t) / 1000);
}

// How closed the pinch looks, 0 (open) .. 1 (pinched), for the cursor and the camera view.
function pinchProgress(p) {
  if (p.kind === 'pinch') return 1;
  return clamp01((PINCH_SHOWN - p.gap) / (PINCH_SHOWN - PINCH_ON));
}

// Counts tracking blinks (the hand lost and found again within DROP_MS): several in a few
// seconds means bad light or a hand at the frame's edge.
function createBlinks() {
  let at = [];
  return {
    blink(now) { at = [...at.filter((t) => now - t <= UNSTEADY_MS), now]; },
    unsteady(now) { return at.filter((t) => now - t <= UNSTEADY_MS).length >= UNSTEADY_BLINKS; },
    clear() { at = []; },
  };
}

// galaxy (any target): { pickAtClient, hoverAtClient, select, reset } plus optional
// rotateBy / drag (pinch and move), zoomBy (two-hand pinch), swipe(dir) (open palm swept
// sideways, dir 1 = right) and labels (status text overrides).
// toScreen(p, kind, pinch) maps a normalized point to a screen point and shows the cursor
// there (pinch: how closed the fingers are, 0..1); hideCursor(), status(text) and close()
// drive the rest of the UI. aspect() is the camera's width / height.
// step(hands, now) returns { hand, pinch }: which of `hands` is steering (-1: none) and
// how closed its pinch is.
export function createGestures({ galaxy, toScreen, hideCursor, status, close, aspect = () => 1 }) {
  const track = createTracker(aspect);
  const box = APP_BOX;
  // The palm drives the cursor (it barely moves as fingers close) and the fingertip's
  // offset from it aims; the offset is held still through a pinch.
  const fpx = oneEuro(), fpy = oneEuro();
  const fox = oneEuro({ minCutoff: 1.2, beta: 1 }), foy = oneEuro({ minCutoff: 1.2, beta: 1 });
  let offset = { x: 0, y: 0 };
  let trail = []; // { t, x, y (cursor), px, py (filtered palm), rx, ry (raw palm), size }
  let aim = null; // the cursor, frozen from just before a pinch began to close
  let pinch = null; // { t, target, start, last, dragging, blinked }
  let span = null; // two-hand distance at the last zoom step
  const fz = oneEuro(ZOOM_FILTER);
  let zoomed = false; // a zoom's leftover pinch is not a tap or a spin
  let seenLast = false;
  let swiped = false;
  const palmHold = createHold(PALM_MS);
  const fistHold = createHold(FIST_MS);
  const swipe = createSwipe();
  const blinks = createBlinks();
  const say = { ...GALAXY_LABELS, ...(galaxy.labels || {}) };

  function release(now, observed) {
    if (pinch && observed && !pinch.dragging && !pinch.blinked && now - pinch.t < TAP_MS && pinch.target) {
      galaxy.select(pinch.target);
      status(say.opened);
    }
    pinch = null;
  }

  function goneAll() {
    hideCursor();
    pinch = null;
    aim = null;
    span = null;
    zoomed = false;
    trail = [];
    palmHold.clear();
    fistHold.clear();
    swipe.reset();
    swiped = false;
    [fpx, fpy, fox, foy].forEach((f) => f.reset());
    galaxy.hoverAtClient(null, null);
    status(say.idle);
  }

  return function step(seen, now) {
    const view = track(usable(seen), now);
    const p = view.primary;
    if (!p) {
      if (view.waiting) { // a blink: hold everything where it is
        if (pinch) pinch.blinked = true;
        seenLast = false;
        return { hand: -1, pinch: 0 };
      }
      seenLast = false;
      goneAll();
      return { hand: -1, pinch: 0 };
    }
    if (!seenLast && !view.fresh) blinks.blink(now);
    seenLast = true;
    const a = view.aspect;
    const kind = p.kind;
    const progress = pinchProgress(p);
    const out = { hand: p.index, pinch: progress };

    // Two hands pinching: zoom by the change in distance between them.
    const partner = view.others.find((t) => t.kind === 'pinch');
    if (kind === 'pinch' && partner) {
      const d = fz(dist(p.palm, partner.palm, a), now);
      if (span === null) span = d;
      else if (Math.abs(d / span - 1) > ZOOM_STEP) {
        if (galaxy.zoomBy) galaxy.zoomBy(Math.pow(span / d, 1.6));
        span = d;
      }
      pinch = null; // a zoom never ends in a tap
      aim = null;
      zoomed = true;
      status(say.zoom);
      return out;
    }
    if (span !== null) fz.reset();
    span = null;
    if (zoomed && kind !== 'pinch' && !p.closing) zoomed = false;

    const px = fpx(0.5 + (p.palm.x - box.cx) / box.width, now);
    const py = fpy(0.5 + (p.palm.y - box.cy) / box.height, now);
    const pinchy = kind === 'pinch' || p.closing;
    if (!pinchy) {
      const tip = p.lm[TIP.index];
      offset = { x: fox((tip.x - p.palm.x) / box.width, now), y: foy((tip.y - p.palm.y) / box.height, now) };
    }
    trail = trail.filter((s) => now - s.t <= 500);
    trail.push({ t: now, x: px + offset.x, y: py + offset.y, px, py, rx: p.palm.x * a, ry: p.palm.y, size: p.size });

    if (pinchy && !aim && !zoomed) {
      const since = p.pinchSince ?? now;
      const at = lookback(trail, since - LOOKBACK_MS);
      aim = { x: at.x, y: at.y, px: at.px, py: at.py, start: lookback(trail, since), speed: speedBefore(trail, since) };
    }
    if (!pinchy && !pinch) aim = null;

    if (pinch && pinch.blinked && !p.opening && kind === 'pinch') pinch.blinked = false; // came back still pinching
    let grabbed = false;
    if (pinch && aim && kind === 'pinch' && !p.opening && !pinch.dragging
        && Math.hypot(p.palm.x * a - aim.start.rx, p.palm.y - aim.start.ry) / p.size > DRAG_START) {
      pinch.dragging = true;
      grabbed = true;
    }
    const shown = aim && !(pinch && pinch.dragging) ? aim
      : aim ? { x: aim.x + px - aim.px, y: aim.y + py - aim.py } : { x: px + offset.x, y: py + offset.y };
    const pt = toScreen({ x: clamp01(shown.x), y: clamp01(shown.y) }, kind, progress);

    const dir = galaxy.swipe ? swipe.feed(p, now, a) : 0;
    if (dir) {
      palmHold.done = true; // a swipe is not a held palm
      swiped = true; // (and the status shouldn't say it reset anything)
      galaxy.swipe(dir);
    }

    if (palmHold.feed(kind === 'palm', p, now, a)) galaxy.reset();
    if (kind !== 'palm') palmHold.rearm(now);
    if (!palmHold.done) swiped = false;
    if (kind === 'palm' && !swiped) status(palmHold.done ? say.reset : say.resetHold);

    const fisted = kind === 'fist' && p.upright;
    if (fistHold.feed(fisted, p, now, a)) {
      close();
      return out;
    }
    if (fisted && !fistHold.done) status(say.closeHold);
    // A relaxed, half-curled hand reads as "other" and flickers; only a clearly open or
    // pointing hand ends a fist (and re-arms it).
    if (kind === 'palm' || kind === 'point') fistHold.clear();

    if (kind === 'pinch' && !zoomed) {
      if (!pinch) {
        pinch = { t: p.pinchSince ?? now, target: galaxy.pickAtClient(pt.x, pt.y), last: pt, dragging: false, blinked: false };
        // A pinch closed on the move is a grab, never a click.
        if (aim && aim.speed > TAP_SPEED) pinch.dragging = true;
      } else if (!p.opening) {
        if (pinch.dragging && !grabbed) {
          const dx = pt.x - pinch.last.x, dy = pt.y - pinch.last.y;
          if (galaxy.drag) galaxy.drag(dx, dy);
          else if (galaxy.rotateBy) galaxy.rotateBy(dx * 0.006, dy * 0.006);
        }
        pinch.last = pt;
      }
      status(pinch.dragging ? say.drag : say.pinch);
    } else if (kind === 'pinch') status(say.zoom);
    else if (pinch) {
      release(now, kind !== 'fist'); // closing the hand the rest of the way is not a click
      aim = null;
    }

    if (kind === 'point') {
      const hovering = galaxy.hoverAtClient(pt.x, pt.y);
      status(hovering ? say.hover : blinks.unsteady(now) ? say.unsteady : say.point);
    }
    return out;
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
// - Pinch and let go: click what was lit just before your fingers closed (the cursor
//   holds there while you pinch). Pinch and move: grab the page and scroll it; let go
//   mid-move and it coasts.
// - Swipe an open hand right: back; left: forward. Two hands pinching: zoom. Hold a
//   fist: close.

export const PAGE_BOX = { width: 0.42, height: 0.36 }; // of the camera frame
const PAGE_TAP_MS = 1200;
const PAGE_REANCHOR_MS = 1200; // a hand gone this long starts again in the middle
const PAGE_COAST_MAX = 3; // pages/s: a flick coasts, it doesn't fling the page away

const PAGE_LABELS = {
  idle: 'Raise a hand to steer', aim: 'Aim with your hand · pinch to open',
  hover: (label) => `Pinch to open “${label}”`, hoverRisky: (label) => `“${label}” needs a second pinch`,
  press: 'Let go to open · move to scroll', drag: 'Scrolling · let go to stop', opened: 'Opened',
  back: '← Back', forward: 'Forward →', zoom: 'Zooming', closeHold: 'Keep the fist to close…',
  unsteady: 'Hard to see your hand · more light helps',
};

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
// swipe(dir) (1 = the hand went right = back), zoomBy(f), hoverLabel() } and optionally
// hoverRisky() (the lit thing needs a second pinch), with x, y in 0..1 of the page.
// status(text) and close() drive the rest of the UI; aspect() is the camera's width /
// height. step(hands, now) returns { hand, pinch } like createGestures'.
export function createPageGestures({ page, status, close, box = PAGE_BOX, aspect = () => 1 }) {
  const track = createTracker(aspect);
  const fx = oneEuro(), fy = oneEuro();
  let frame = null;
  let lastSeen = -1e9;
  let seenLast = false;
  let gone = true;
  let trail = []; // { t, x, y (cursor), rx, ry (raw palm), size }
  let aim = null; // the cursor, frozen from just before a pinch began to close
  let pinch = null; // { t, last, lastT, dragging, axis, v, blinked }
  let span = null;
  const fz = oneEuro(ZOOM_FILTER);
  let zoomed = false;
  const fistHold = createHold(FIST_MS);
  const swipe = createSwipe();
  const blinks = createBlinks();
  let swipedAt = -1e9;
  const say = PAGE_LABELS;

  function letGo(tap) {
    if (!pinch) return;
    const v = pinch.dragging ? pinch.v : { x: 0, y: 0 };
    const speed = Math.hypot(v.x, v.y);
    const k = speed > PAGE_COAST_MAX ? PAGE_COAST_MAX / speed : 1;
    page.release({ tap, vx: v.x * k, vy: v.y * k });
    pinch = null;
  }

  return function step(seen, now) {
    const view = track(usable(seen), now);
    const p = view.primary;
    if (!p) {
      if (view.waiting) { // a blink: the cursor holds, a pinch stays held
        if (pinch) pinch.blinked = true;
        seenLast = false;
        return { hand: -1, pinch: 0 };
      }
      seenLast = false;
      letGo(false); // losing the hand never clicks
      aim = null;
      span = null;
      zoomed = false;
      fistHold.clear();
      swipe.reset();
      trail = [];
      if (!gone) page.hide();
      gone = true;
      status(say.idle);
      return { hand: -1, pinch: 0 };
    }
    if (!seenLast && !view.fresh) blinks.blink(now);
    seenLast = true;
    gone = false;
    if (now - lastSeen > PAGE_REANCHOR_MS || !frame) {
      frame = pageBox(p.palm, box);
      fx.reset();
      fy.reset();
    }
    lastSeen = now;
    const a = view.aspect;
    const kind = p.kind;
    const out = { hand: p.index, pinch: pinchProgress(p) };

    // Two hands pinching: zoom by the change in distance between them.
    const partner = view.others.find((t) => t.kind === 'pinch');
    if (kind === 'pinch' && partner) {
      const d = fz(dist(p.palm, partner.palm, a), now);
      if (span === null) span = d;
      else if (Math.abs(d / span - 1) > ZOOM_STEP) {
        if (page.zoomBy) page.zoomBy(d / span);
        span = d;
      }
      letGo(false);
      aim = null;
      zoomed = true;
      status(say.zoom);
      return out;
    }
    if (span !== null) fz.reset();
    span = null;
    if (zoomed && kind !== 'pinch' && !p.closing) zoomed = false;

    const raw = toPage(p.palm, frame);
    const x = fx(raw.x, now), y = fy(raw.y, now);
    trail = trail.filter((s) => now - s.t <= 500);
    trail.push({ t: now, x, y, rx: p.palm.x * a, ry: p.palm.y, size: p.size });
    const pinchy = (kind === 'pinch' || p.closing) && !zoomed;
    if (pinchy && !aim) {
      const since = p.pinchSince ?? now;
      const at = lookback(trail, since - LOOKBACK_MS);
      aim = { x: at.x, y: at.y, start: lookback(trail, since), speed: speedBefore(trail, since) };
    }
    if (!pinchy && !pinch) aim = null;

    if (pinch && pinch.blinked && !p.opening && kind === 'pinch') pinch.blinked = false;
    if (pinch && aim && kind === 'pinch' && !p.opening && !pinch.dragging) {
      const mx = p.palm.x * a - aim.start.rx, my = p.palm.y - aim.start.ry;
      if (Math.hypot(mx, my) / p.size > DRAG_START) {
        pinch.dragging = true;
        // A mostly-vertical grab scrolls only vertically (and the other way round), so a
        // slightly slanted pull doesn't slide a wide table sideways.
        pinch.axis = Math.abs(my) > Math.abs(mx) * 1.5 ? 'y' : Math.abs(mx) > Math.abs(my) * 1.5 ? 'x' : '';
        pinch.last = { x, y };
        pinch.lastT = now;
      }
    }
    const shown = aim && !(pinch && pinch.dragging) ? aim : { x, y };
    const mode = pinchy ? (pinch && pinch.dragging ? 'drag' : 'pinch') : kind === 'fist' ? 'fist' : 'aim';
    page.move(shown.x, shown.y, mode);

    // A quick sideways sweep of the open hand: back or forward.
    const dir = page.swipe ? swipe.feed(p, now, a) : 0;
    if (dir) {
      swipedAt = now;
      page.swipe(dir);
      status(dir > 0 ? say.back : say.forward);
      return out;
    }

    if (kind === 'fist') {
      letGo(false);
      if (fistHold.feed(p.upright, p, now, a)) {
        close();
        return out;
      }
      if (p.upright && !fistHold.done) status(say.closeHold);
      return out;
    }
    if (kind === 'palm' || kind === 'point') fistHold.clear();
    else if (kind !== 'other') fistHold.rearm(now);

    if (kind === 'pinch' && !zoomed) {
      if (!pinch) {
        pinch = { t: p.pinchSince ?? now, last: { x, y }, lastT: now, dragging: false, axis: '', v: { x: 0, y: 0 }, blinked: false };
        page.press(aim.x, aim.y);
        if (aim.speed > TAP_SPEED) pinch.dragging = true; // closed on the move: a grab, never a click
      } else if (!p.opening) {
        if (pinch.dragging) {
          const dx = pinch.axis === 'y' ? 0 : x - pinch.last.x;
          const dy = pinch.axis === 'x' ? 0 : y - pinch.last.y;
          page.drag(dx, dy);
          const dt = Math.max(1, now - pinch.lastT);
          const k = 1 - Math.exp(-dt / 80); // velocity smoothed over ~80 ms, whatever the frame rate
          pinch.v = { x: pinch.v.x + k * ((dx * 1000) / dt - pinch.v.x), y: pinch.v.y + k * ((dy * 1000) / dt - pinch.v.y) };
        }
        pinch.last = { x, y };
        pinch.lastT = now;
      }
      status(pinch.dragging ? say.drag : say.press);
      return out;
    }
    if (kind === 'pinch') { status(say.zoom); return out; } // a zoom's leftover pinch
    if (pinch) {
      // A release the camera didn't see (the hand came back open) is not a click.
      const tap = !pinch.dragging && !pinch.blinked && now - pinch.t < PAGE_TAP_MS;
      letGo(tap);
      aim = null;
      if (tap) { status(say.opened); return out; }
    }
    if (now - swipedAt < 700) return out; // leave "← Back" up for a moment
    const label = page.hoverLabel && page.hoverLabel();
    if (label) status(page.hoverRisky && page.hoverRisky() ? say.hoverRisky(label) : say.hover(label));
    else status(blinks.unsteady(now) ? say.unsteady : say.aim);
    return out;
  };
}

// ── Desktop control: the whole Mac ──
//
// The hands drive the real macOS cursor (desktop_hands.py posts the events), so every
// gesture here errs toward doing nothing: a missed click costs a second try, a stray one
// can drop a file in the wrong folder.
// - The middle of your hand aims, over a fixed box of the camera (DESKTOP_BOX) that
//   covers the whole screen: the same spot of the camera is always the same spot of the
//   screen, and the screen's edges are reached with the hand still well inside the frame.
//   Stronger smoothing than the app's and a small dead zone hold the cursor on a still
//   hand; a hand passing through the frame moves nothing until it has stayed a moment.
// - Pinch (thumb to index) and let go: click where you aimed just before the fingers
//   closed. Twice quickly: double click. Pinch and move, or pinch and hold still: the
//   button goes down there, the cursor follows the hand, letting go drops.
// - Thumb to middle finger (index still up): right click.
// - Two fingers up (index and middle, like a trackpad's two-finger scroll) and move:
//   the content under the cursor follows the hand. The cursor holds still meanwhile.
// - Hold a fist: pause at once (a held button is let go); hold an open palm to resume.
// Losing the hand lets go of a held button where the cursor is and clicks nothing.

export const DESKTOP_BOX = { cx: 0.5, cy: 0.45, width: 0.5, height: 0.42 }; // of the camera frame
const DESKTOP_FILTER = { minCutoff: 0.45, beta: 8 }; // steadier than the app's at rest, as quick moving
const DESKTOP_DEAD = 0.0012; // of the screen (~2 pt on a laptop): a still hand's tremor moves nothing
const DESKTOP_ENGAGE_MS = 250; // a hand must stay this long before it moves the cursor
const DESKTOP_PRESS_MS = 450; // a pinch held still this long presses (then move to drag slowly)
const DESKTOP_DOUBLE_MS = 500; // a second click this soon after the first...
const DESKTOP_DOUBLE_NEAR = 0.015; // ...and this close (of the screen) is a double click
const RIGHT_ON = 0.35; // thumb to middle tip, in hand sizes, like PINCH_ON / PINCH_OFF
const RIGHT_OFF = 0.5;
const RIGHT_APART = 0.6; // the index must be clearly away from the thumb meanwhile
const RIGHT_SETTLE_MS = 50; // twice a pinch's: a right click is rarer and costlier to misfire
const SCROLL_SETTLE_MS = 90;
const SCROLL_START = 0.12; // hand sizes the two fingers must travel before the page moves
const SCROLL_GAIN = 1.4; // of the screen scrolled per screen's worth of hand movement
const DESKTOP_STOP_MS = 600; // a fist held this long pauses
const DESKTOP_RESUME_MS = 900; // an open palm held this long resumes

const DESKTOP_LABELS = {
  idle: 'Raise a hand to steer the Mac', found: 'Found your hand…',
  aim: 'Pinch to click · two fingers to scroll · hold a fist to pause',
  press: 'Let go to click · keep pinching to drag', drag: 'Dragging · let go to drop',
  clicked: 'Click', doubled: 'Double click', right: 'Right click', scroll: 'Scrolling',
  stopHold: 'Keep the fist to pause…', paused: 'Paused · hold an open palm to resume',
  resumeHold: 'Keep the palm open to resume…', resumed: 'Steering the Mac',
  unsteady: 'Hard to see your hand · more light helps',
};

// The box's point under the hand as a point of the screen, 0..1 from its top left. Camera
// x is mirrored: the hand moving to the user's right lowers it.
export function toDesktop(p, b = DESKTOP_BOX) {
  return { x: clamp01(0.5 - (p.x - b.cx) / b.width), y: clamp01(0.5 + (p.y - b.cy) / b.height) };
}

// Back to off at once (the hand is gone), with nothing pending.
function unsettle(s) { s.value = false; s.pending = null; }

// Index and middle up, ring and pinky curled: the two-finger scroll pose.
function twoFingers(lm, aspect) {
  return extended(lm, 'index', aspect) && extended(lm, 'middle', aspect)
    && !extended(lm, 'ring', aspect) && !extended(lm, 'pinky', aspect);
}

// Thumb to middle fingertip in hand sizes.
function middleGap(lm, aspect) {
  return dist(lm[TIP.thumb], lm[TIP.middle], aspect) / handSize(lm, aspect);
}

// desktop: { move(x, y), press(x, y, button), release(x, y, button),
// click(x, y, { button, count }), scroll(dx, dy), cancel() } with x, y in 0..1 of the
// screen from its top left and scroll's dx, dy how far (of the screen) the content should
// follow the hand (dy > 0: it moves down). cancel() lets go of anything held at once.
// status(text) and paused(on) drive the UI; aspect() is the camera's width / height.
// step(hands, now) returns { hand, pinch } like createGestures'.
export function createDesktopGestures({ desktop, status, paused: onPause = () => {}, box = DESKTOP_BOX, aspect = () => 1 }) {
  const track = createTracker(aspect);
  const fx = oneEuro(DESKTOP_FILTER), fy = oneEuro(DESKTOP_FILTER);
  const say = DESKTOP_LABELS;
  let cur = null; // the cursor after the dead zone
  let trail = []; // { t, x, y (cursor), rx, ry (raw palm), size }
  let engagedAt = null;
  let seenLast = false;
  let aim = null; // left pinch: { x, y (where it lands), sx, sy (cursor as it closed), start (raw palm), speed }
  let pinch = null; // { t, pressed, ignored, blinked }
  let shown = null; // where the cursor was last put
  let lastClick = null; // { t, x, y, count }
  const rightPinch = settle(RIGHT_SETTLE_MS);
  let raim = null; // right pinch's aim, like aim
  let right = null; // { t, moved }
  const scrollPose = settle(SCROLL_SETTLE_MS);
  let scroll = null; // { anchor: { x, y, rx, ry }, active, axis, last }
  let isPaused = false;
  const stopHold = createHold(DESKTOP_STOP_MS);
  const resumeHold = createHold(DESKTOP_RESUME_MS);
  const blinks = createBlinks();
  let lastStatus = null;
  const tell = (text) => { if (text !== lastStatus) { lastStatus = text; status(text); } };

  // Let go of whatever is held, where the cursor is: a drop, never a click.
  function letGoAll() {
    if (pinch && pinch.pressed && shown) desktop.release(shown.x, shown.y, 'left');
    pinch = null;
    aim = null;
    right = null;
    raim = null;
    scroll = null;
  }

  function pause(on) {
    if (isPaused === on) return;
    isPaused = on;
    letGoAll();
    if (on) desktop.cancel();
    onPause(on);
  }

  function aimFrom(since) {
    const at = lookback(trail, since - LOOKBACK_MS);
    const start = lookback(trail, since);
    return { x: at.x, y: at.y, sx: start.x, sy: start.y, start, speed: speedBefore(trail, since) };
  }

  function click(x, y, now) {
    let count = 1;
    if (lastClick && now - lastClick.t < DESKTOP_DOUBLE_MS
        && Math.hypot(x - lastClick.x, y - lastClick.y) < DESKTOP_DOUBLE_NEAR) {
      count = Math.min(3, lastClick.count + 1);
      ({ x, y } = lastClick); // a double click lands on the first one's spot, as macOS wants
    }
    desktop.click(x, y, { button: 'left', count });
    lastClick = { t: now, x, y, count };
    tell(count > 1 ? say.doubled : say.clicked);
  }

  return {
    step(seen, now) {
      const view = track(usable(seen), now);
      const p = view.primary;
      if (!p) {
        seenLast = false;
        if (view.waiting) { // a blink: the cursor holds, a held button stays held
          if (pinch) pinch.blinked = true;
          return { hand: -1, pinch: 0 };
        }
        letGoAll();
        engagedAt = null;
        trail = [];
        cur = null;
        unsettle(rightPinch);
        unsettle(scrollPose);
        stopHold.clear();
        resumeHold.clear();
        tell(isPaused ? say.paused : say.idle);
        return { hand: -1, pinch: 0 };
      }
      if (!seenLast && !view.fresh) blinks.blink(now);
      seenLast = true;
      if (engagedAt === null) {
        engagedAt = now;
        fx.reset();
        fy.reset();
      }
      const a = view.aspect;
      const kind = p.kind;
      const out = { hand: p.index, pinch: isPaused ? 0 : pinchProgress(p) };

      const raw = toDesktop(p.palm, box);
      const x = fx(raw.x, now), y = fy(raw.y, now);
      if (!cur || Math.hypot(x - cur.x, y - cur.y) > DESKTOP_DEAD) cur = { x, y };
      trail = trail.filter((s) => now - s.t <= 500);
      trail.push({ t: now, x: cur.x, y: cur.y, rx: p.palm.x * a, ry: p.palm.y, size: p.size });

      if (isPaused) {
        if (resumeHold.feed(kind === 'palm', p, now, a)) {
          pause(false);
          engagedAt = now - DESKTOP_ENGAGE_MS; // the hand is plainly there: steer from now
          tell(say.resumed);
          return out;
        }
        if (kind !== 'palm') resumeHold.rearm(now);
        tell(kind === 'palm' && !resumeHold.done ? say.resumeHold : say.paused);
        return out;
      }
      if (now - engagedAt < DESKTOP_ENGAGE_MS) {
        tell(say.found);
        return out;
      }

      // A fist: the cursor stops where it is, anything held is let go; held on, a pause.
      if (kind === 'fist' && p.upright) {
        letGoAll();
        if (stopHold.feed(true, p, now, a)) {
          pause(true);
          resumeHold.clear();
          tell(say.paused);
          return out;
        }
        if (!stopHold.done) tell(say.stopHold);
        return out;
      }
      if (kind === 'palm' || kind === 'point') stopHold.clear();
      else stopHold.rearm(now);

      // Left pinch: aim from just before the fingers began to close.
      const pinchy = kind === 'pinch' || p.closing;
      if (pinchy && !aim) aim = aimFrom(p.pinchSince ?? now);
      if (!pinchy && !pinch) aim = null;

      // Right pinch (thumb to middle, index up), only while no left pinch is going.
      const lm = p.lm;
      const rightRaw = !pinchy && !pinch && extended(lm, 'index', a) && pinchGap(lm, a) > RIGHT_APART
        && middleGap(lm, a) < (rightPinch.value ? RIGHT_OFF : RIGHT_ON);
      rightPinch.feed(rightRaw, now);
      const righty = rightPinch.value || rightPinch.pending !== null;
      if (righty && !raim) raim = aimFrom(rightPinch.value ? rightPinch.at : rightPinch.pending);
      if (!righty && !right) raim = null;

      // Two fingers up: scroll.
      const scrolly = scrollPose.feed(!pinchy && !pinch && !righty && !right && twoFingers(lm, a)
        && middleGap(lm, a) > RIGHT_OFF, now);

      // Where the cursor goes: held on the aim through a pinch, following the hand
      // (from the aim) through a drag, held still through a scroll.
      let target;
      if (pinch && pinch.pressed) target = { x: aim.x + cur.x - aim.sx, y: aim.y + cur.y - aim.sy };
      else if (aim) target = aim;
      else if (raim) target = raim;
      else if ((scroll || scrolly) && shown) target = shown;
      else target = cur;
      shown = { x: clamp01(target.x), y: clamp01(target.y) };
      desktop.move(shown.x, shown.y);

      if (kind === 'pinch') {
        if (!pinch) {
          // A pinch closed while the hand sweeps past does nothing at all: on the desktop
          // a stray grab is as bad as a stray click.
          pinch = { t: p.pinchSince ?? now, pressed: false, ignored: aim.speed > TAP_SPEED, blinked: false };
        } else if (!p.opening && !pinch.ignored) {
          if (pinch.blinked) pinch.blinked = false; // came back still pinching
          const moved = Math.hypot(p.palm.x * a - aim.start.rx, p.palm.y - aim.start.ry) / p.size;
          if (!pinch.pressed && (moved > DRAG_START || now - pinch.t >= DESKTOP_PRESS_MS)) {
            pinch.pressed = true;
            desktop.press(aim.x, aim.y, 'left');
          }
        }
        tell(pinch.ignored ? say.aim : pinch.pressed ? say.drag : say.press);
        return out;
      }
      if (pinch) {
        if (pinch.pressed) desktop.release(shown.x, shown.y, 'left');
        else if (!pinch.ignored && !pinch.blinked && now - pinch.t < TAP_MS) click(aim.x, aim.y, now);
        pinch = null;
        aim = null;
        return out;
      }

      if (rightPinch.value) {
        if (!right) right = { t: rightPinch.at, moved: false };
        const start = raim.start;
        if (Math.hypot(p.palm.x * a - start.rx, p.palm.y - start.ry) / p.size > DRAG_START) right.moved = true;
        tell(say.right);
        return out;
      }
      if (right) {
        if (!right.moved && now - right.t < TAP_MS && raim.speed <= TAP_SPEED) {
          desktop.click(raim.x, raim.y, { button: 'right', count: 1 });
        }
        right = null;
        raim = null;
        return out;
      }

      if (scrolly) {
        if (!scroll) scroll = { anchor: { x: cur.x, y: cur.y, rx: p.palm.x * a, ry: p.palm.y }, active: false, axis: '', last: null };
        if (!scroll.active) {
          const mx = p.palm.x * a - scroll.anchor.rx, my = p.palm.y - scroll.anchor.ry;
          if (Math.hypot(mx, my) / p.size > SCROLL_START) {
            scroll.active = true;
            scroll.axis = Math.abs(my) > Math.abs(mx) * 1.5 ? 'y' : Math.abs(mx) > Math.abs(my) * 1.5 ? 'x' : '';
            scroll.last = { x: cur.x, y: cur.y };
          }
        } else {
          const dx = scroll.axis === 'y' ? 0 : cur.x - scroll.last.x;
          const dy = scroll.axis === 'x' ? 0 : cur.y - scroll.last.y;
          if (dx || dy) desktop.scroll(dx * SCROLL_GAIN, dy * SCROLL_GAIN);
          scroll.last = { x: cur.x, y: cur.y };
        }
        tell(say.scroll);
        return out;
      }
      scroll = null;
      tell(blinks.unsteady(now) ? say.unsteady : say.aim);
      return out;
    },
    // Stop driving the Mac at once (the Settings switch, a spoken "stop"): lets go of
    // anything held.
    stop() {
      letGoAll();
      desktop.cancel();
    },
    get paused() { return isPaused; },
    pause,
  };
}

// The desktop sink as WebSocket messages for desktop_hands.py: { type: 'desktop_hand',
// op, ... }. Positions are rounded to 1/10000 of the screen, well under a point.
export function desktopMessages(send) {
  const r = (v) => Math.round(v * 10000) / 10000;
  const msg = (op, fields = {}) => send({ type: 'desktop_hand', op, ...fields });
  return {
    kind: 'desktop',
    move: (x, y) => msg('move', { x: r(x), y: r(y) }),
    press: (x, y, button) => msg('press', { x: r(x), y: r(y), button }),
    release: (x, y, button) => msg('release', { x: r(x), y: r(y), button }),
    click: (x, y, { button = 'left', count = 1 } = {}) => msg('click', { x: r(x), y: r(y), button, count }),
    scroll: (dx, dy) => msg('scroll', { dx: r(dx), dy: r(dy) }),
    cancel: () => msg('cancel'),
    start: () => msg('start'),
    stop: () => msg('stop'),
  };
}

// Hand control that two claps started. A pair of loud clicks (a key or a cup set down
// reached 0.3 here, over the detector's 0.2 floor) can still pass for two claps, so a
// clap-started session with no hand in sight within NO_HAND_MS switches the camera off
// again. A hand seen before the session began doesn't count: only one the camera saw
// after startedAt keeps it on.
export const NO_HAND_MS = 12000;

export function noHandSeen({ startedAt, seenAt, now }) {
  return now - startedAt >= NO_HAND_MS && !(seenAt > startedAt);
}
