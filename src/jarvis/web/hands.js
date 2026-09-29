// Hand control for the knowledge galaxy, Stark-style. Runs MediaPipe's hand tracker
// locally in the window (the camera never leaves this Mac).
//
//   Point (index finger up)          move the cursor; hovering a star shows its name
//   Pinch and move (one hand)        spin the galaxy
//   Quick pinch on a star            open it
//   Two hands pinching, pull apart   zoom in; push together to zoom out
//   Open palm, held for a second     reset the view
//   Fist, held for a second          close the galaxy

import { FilesetResolver, HandLandmarker } from '/vision/vision_bundle.mjs';

const TIP = { thumb: 4, index: 8, middle: 12, ring: 16, pinky: 20 };
const PIP = { index: 6, middle: 10, ring: 14, pinky: 18 };

let landmarker = null;
let video = null;
let stream = null;
let running = false;
let galaxyRef = null;
let onClose = null;
let overlay = null;
let status = null;
let cursor = null;

// gesture state
let pinchStart = null;
let lastPinch = null;
let twoHandStart = null;
let palmSince = 0;
let fistSince = 0;
const smooth = { x: null, y: null };

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

function handSize(lm) { return dist(lm[0], lm[9]) || 0.1; }

function extended(lm, finger) { return dist(lm[TIP[finger]], lm[0]) > dist(lm[PIP[finger]], lm[0]) * 1.12; }

function classify(lm) {
  const size = handSize(lm);
  const pinch = dist(lm[TIP.thumb], lm[TIP.index]) / size < 0.35;
  const up = ['index', 'middle', 'ring', 'pinky'].map((f) => extended(lm, f));
  if (pinch) return 'pinch';
  if (up.every(Boolean)) return 'palm';
  if (up[0] && !up[1] && !up[2] && !up[3]) return 'point';
  if (!up.some(Boolean)) return 'fist';
  return 'other';
}

// Camera x is mirrored so moving your hand right moves the cursor right.
function toScreen(p) {
  return { x: (1 - p.x) * window.innerWidth, y: p.y * window.innerHeight };
}

function setStatus(text) { if (status) status.textContent = text; }

function moveCursor(pt, mode) {
  if (smooth.x === null) { smooth.x = pt.x; smooth.y = pt.y; }
  smooth.x += (pt.x - smooth.x) * 0.45;
  smooth.y += (pt.y - smooth.y) * 0.45;
  cursor.style.transform = `translate(${smooth.x - 18}px, ${smooth.y - 18}px)`;
  cursor.dataset.mode = mode;
  cursor.hidden = false;
  return { x: smooth.x, y: smooth.y };
}

function onFrame(result) {
  const hands = result.landmarks || [];
  drawOverlay(hands);
  const now = performance.now();
  if (!hands.length) {
    cursor.hidden = true;
    pinchStart = null;
    twoHandStart = null;
    palmSince = fistSince = 0;
    galaxyRef.hoverAtClient(null, null);
    setStatus('Show me your hand');
    return;
  }
  const kinds = hands.map(classify);

  // Two hands pinching: zoom by the change in distance between them.
  if (hands.length >= 2 && kinds[0] === 'pinch' && kinds[1] === 'pinch') {
    const a = hands[0][TIP.index], b = hands[1][TIP.index];
    const span = dist(a, b);
    if (!twoHandStart) twoHandStart = span;
    else {
      galaxyRef.zoomBy(Math.pow(twoHandStart / span, 1.6));
      twoHandStart = span;
    }
    pinchStart = null;
    setStatus('Zoom');
    return;
  }
  twoHandStart = null;

  const lm = hands[0];
  const kind = kinds[0];
  const tip = kind === 'pinch'
    ? { x: (lm[TIP.thumb].x + lm[TIP.index].x) / 2, y: (lm[TIP.thumb].y + lm[TIP.index].y) / 2 }
    : lm[TIP.index];
  const pt = moveCursor(toScreen(tip), kind);

  if (kind === 'palm') {
    palmSince = palmSince || now;
    setStatus(now - palmSince > 1000 ? 'View reset' : 'Hold open palm to reset…');
    if (now - palmSince > 1000) { galaxyRef.reset(); palmSince = now + 1e9; }
  } else palmSince = 0;

  if (kind === 'fist') {
    fistSince = fistSince || now;
    setStatus('Hold fist to close…');
    if (now - fistSince > 1100) { fistSince = 0; if (onClose) onClose(); return; }
  } else fistSince = 0;

  if (kind === 'pinch') {
    if (!pinchStart) {
      pinchStart = { t: now, x: pt.x, y: pt.y, target: galaxyRef.pickAtClient(pt.x, pt.y), moved: 0 };
      lastPinch = { x: pt.x, y: pt.y };
    } else {
      const dx = pt.x - lastPinch.x, dy = pt.y - lastPinch.y;
      pinchStart.moved += Math.abs(dx) + Math.abs(dy);
      galaxyRef.rotateBy(dx * 0.006, dy * 0.006);
      lastPinch = { x: pt.x, y: pt.y };
    }
    setStatus(pinchStart.moved > 25 ? 'Spinning' : 'Pinch');
  } else {
    if (pinchStart && pinchStart.moved < 25 && now - pinchStart.t < 600 && pinchStart.target) {
      galaxyRef.select(pinchStart.target);
      setStatus('Opened');
    }
    pinchStart = null;
  }

  if (kind === 'point') {
    const id = galaxyRef.hoverAtClient(pt.x, pt.y);
    setStatus(id ? 'Pinch to open' : 'Pointing');
  }
}

function drawOverlay(hands) {
  const ctx = overlay.getContext('2d');
  const w = overlay.width, h = overlay.height;
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(w, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, w, h);
  ctx.restore();
  ctx.fillStyle = 'rgba(2, 10, 18, 0.35)';
  ctx.fillRect(0, 0, w, h);
  const bones = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];
  ctx.strokeStyle = '#4fd3ff';
  ctx.fillStyle = '#e6f8ff';
  ctx.lineWidth = 2;
  for (const lm of hands) {
    ctx.beginPath();
    for (const [a, b] of bones) {
      ctx.moveTo((1 - lm[a].x) * w, lm[a].y * h);
      ctx.lineTo((1 - lm[b].x) * w, lm[b].y * h);
    }
    ctx.stroke();
    for (const p of lm) { ctx.beginPath(); ctx.arc((1 - p.x) * w, p.y * h, 2.5, 0, Math.PI * 2); ctx.fill(); }
  }
}

async function loop() {
  if (!running) return;
  if (video.readyState >= 2) {
    try { onFrame(landmarker.detectForVideo(video, performance.now())); } catch (err) { console.warn(err); }
  }
  video.requestVideoFrameCallback(loop);
}

export async function startHands(galaxy, { overlayCanvas, statusEl, cursorEl, close }) {
  if (running) return;
  galaxyRef = galaxy;
  onClose = close;
  overlay = overlayCanvas;
  status = statusEl;
  cursor = cursorEl;
  setStatus('Starting hand tracking…');
  if (!landmarker) {
    const files = await FilesetResolver.forVisionTasks('/vision/wasm');
    landmarker = await HandLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: '/models/hand_landmarker.task', delegate: 'GPU' },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minTrackingConfidence: 0.5,
    });
  }
  stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, frameRate: 30 }, audio: false });
  video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  running = true;
  setStatus('Show me your hand');
  video.requestVideoFrameCallback(loop);
}

export function stopHands() {
  running = false;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  if (cursor) cursor.hidden = true;
  if (galaxyRef) galaxyRef.hoverAtClient(null, null);
}

export function handsRunning() { return running; }
