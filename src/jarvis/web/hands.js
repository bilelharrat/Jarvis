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
import { createGestures } from './gestures.js';

let landmarker = null;
let video = null;
let stream = null;
let running = false;
let galaxyRef = null;
let overlay = null;
let status = null;
let cursor = null;
let step = null;
const smooth = { x: null, y: null };

function setStatus(text) { if (status) status.textContent = text; }

// Camera x is mirrored so moving your hand right moves the cursor right.
function toScreen(p, mode) {
  const x = (1 - p.x) * window.innerWidth, y = p.y * window.innerHeight;
  if (smooth.x === null) { smooth.x = x; smooth.y = y; }
  smooth.x += (x - smooth.x) * 0.45;
  smooth.y += (y - smooth.y) * 0.45;
  cursor.style.transform = `translate(${smooth.x - 18}px, ${smooth.y - 18}px)`;
  cursor.dataset.mode = mode;
  cursor.hidden = false;
  return { x: smooth.x, y: smooth.y };
}

function hideCursor() {
  cursor.hidden = true;
  smooth.x = smooth.y = null;
}

function onFrame(result) {
  const hands = result.landmarks || [];
  drawOverlay(hands);
  step(hands, performance.now());
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
  step = createGestures({ galaxy, toScreen, hideCursor, status: setStatus, close: () => close && close() });
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
