// Hand control, Stark-style: MediaPipe's hand tracker runs locally in the window (the
// camera never leaves this Mac) and gestures.js turns hands into actions on a target:
// the knowledge galaxy while it's open, the Research Center while it's open (a "page"
// target, which draws its own cursor), the rest of the app otherwise, or, in desktop mode,
// the whole Mac (a "desktop" target: gestures become real cursor events, posted by
// desktop_hands.py on the backend).
//
// Desktop mode has to keep working while JARVIS's window is behind other apps or hidden.
// requestVideoFrameCallback only fires for a window that is being drawn, so there frames
// come straight off the camera track (MediaStreamTrackProcessor), or failing that from a
// timer; either needs the window's background throttling off (main.js).

import { FilesetResolver, HandLandmarker } from '/vision/vision_bundle.mjs';
import { createDesktopGestures, createGestures, createPageGestures, desktopMessages, wellFormed } from './gestures.js';

export { desktopMessages };

let landmarker = null;
let video = null;
let stream = null;
let running = false;
let galaxyRef = null;
let overlay = null;
let status = null;
let cursor = null;
let step = null;
let closeFn = null;
let lastStamp = 0;
let desk = null; // the desktop gestures while the target is the whole Mac
let pumping = false; // desktop mode: frames come from pump(), not the video callback
let pumpStop = null;
let busy = false;
let lastFeedback = null;

function setStatus(text) { if (status) status.textContent = text; }

// The camera's shape, so gestures.js measures a sideways gap like an upright one.
function cameraAspect() {
  return video && video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 4 / 3;
}

// Camera x is mirrored so moving your hand right moves the cursor right. gestures.js
// has already smoothed the point (on real frame times); the ring shrinks as a pinch
// closes, so you can see a click coming before it lands.
function toScreen(p, mode, pinch = 0) {
  const x = (1 - p.x) * window.innerWidth, y = p.y * window.innerHeight;
  cursor.style.transform = `translate(${x - 18}px, ${y - 18}px) scale(${1 - 0.35 * pinch})`;
  cursor.dataset.mode = mode;
  cursor.hidden = false;
  return { x, y };
}

function hideCursor() {
  if (cursor) cursor.hidden = true;
}

function letGoOf(target) {
  if (!target) return;
  if (target.kind === 'desktop') {
    if (desk) desk.stop(); // lets go of a held button before anything else
    desk = null;
    if (target.stop) target.stop();
    stopPump();
  } else if (target.kind === 'page') target.hide();
  else target.hoverAtClient(null, null);
}

function onFrame(result, stamp) {
  // Whole hands only: a malformed one would throw in drawOverlay and lose the good hand's frame.
  const hands = (result.landmarks || []).filter(wellFormed);
  const view = step(hands, stamp) || { hand: 0, pinch: 0 };
  if (overlay && !document.hidden) drawOverlay(hands, view); // nobody sees it behind other apps
  if (galaxyRef && galaxyRef.kind === 'desktop' && galaxyRef.feedback) {
    // Only when it changes (the pinch by a visible step): it crosses to another window.
    const fb = { hand: view.hand >= 0, pinch: Math.round(view.pinch * 10) / 10, paused: !!(desk && desk.paused) };
    if (!lastFeedback || fb.hand !== lastFeedback.hand || fb.pinch !== lastFeedback.pinch || fb.paused !== lastFeedback.paused) {
      lastFeedback = fb;
      galaxyRef.feedback(fb);
    }
  }
}

// The camera view: the steering hand bright, any other dimmed, and the thumb-to-index
// line brightening as a pinch closes.
function drawOverlay(hands, view) {
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
  hands.forEach((lm, i) => {
    const steering = i === view.hand;
    ctx.strokeStyle = steering ? '#4fd3ff' : 'rgba(151, 166, 186, 0.45)';
    ctx.fillStyle = steering ? '#e6f8ff' : 'rgba(151, 166, 186, 0.45)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [a, b] of bones) {
      ctx.moveTo((1 - lm[a].x) * w, lm[a].y * h);
      ctx.lineTo((1 - lm[b].x) * w, lm[b].y * h);
    }
    ctx.stroke();
    for (const p of lm) { ctx.beginPath(); ctx.arc((1 - p.x) * w, p.y * h, 2.5, 0, Math.PI * 2); ctx.fill(); }
    if (steering && view.pinch > 0) {
      ctx.strokeStyle = `rgba(230, 248, 255, ${0.25 + 0.75 * view.pinch})`;
      ctx.lineWidth = 2 + 3 * view.pinch;
      ctx.beginPath();
      ctx.moveTo((1 - lm[4].x) * w, lm[4].y * h);
      ctx.lineTo((1 - lm[8].x) * w, lm[8].y * h);
      ctx.stroke();
    }
  });
}

// When the camera took the frame (not when we got round to it), so speeds and holds
// don't stretch while the GPU is busy; always increasing, as the tracker requires.
function frameStamp(meta) {
  const now = performance.now();
  const shot = meta && meta.captureTime;
  // Trusted only while it's plausibly on the same clock: a bad one would stall every hold.
  const t = Number.isFinite(shot) && Math.abs(now - shot) < 500 ? shot : now;
  lastStamp = Math.max(lastStamp + 1, t);
  return lastStamp;
}

function loop(_now, meta) {
  if (!running) return;
  if (!pumping && video.readyState >= 2) {
    const stamp = frameStamp(meta);
    try { onFrame(landmarker.detectForVideo(video, stamp), stamp); } catch (err) { console.warn(err); }
  }
  video.requestVideoFrameCallback(loop);
}

// Desktop mode's frames: straight off the camera track, so they keep coming while the
// window isn't drawn. A frame that arrives while the last is still being read is dropped
// (closed at once), never queued: the cursor follows the newest hand, not a backlog.
function startPump() {
  if (pumping || !stream) return;
  pumping = true;
  const track = stream.getVideoTracks()[0];
  let stopped = false;
  if (typeof MediaStreamTrackProcessor === 'function' && track) {
    const reader = new MediaStreamTrackProcessor({ track, maxBufferSize: 1 }).readable.getReader();
    pumpStop = () => { stopped = true; reader.cancel().catch(() => {}); };
    (async () => {
      while (!stopped && running) {
        let frame;
        try {
          ({ value: frame } = await reader.read());
        } catch { break; }
        if (!frame) break;
        try {
          if (!busy && !stopped) {
            busy = true;
            const stamp = frameStamp(null);
            onFrame(landmarker.detectForVideo(frame, stamp), stamp);
          }
        } catch (err) {
          console.warn(err);
        } finally {
          busy = false;
          frame.close();
        }
      }
    })();
  } else {
    // No track reader: a timer on the video element (works while hidden only with the
    // window's background throttling off).
    const tick = () => {
      if (stopped || !running) return;
      if (video.readyState >= 2) {
        const stamp = frameStamp(null);
        try { onFrame(landmarker.detectForVideo(video, stamp), stamp); } catch (err) { console.warn(err); }
      }
      timer = setTimeout(tick, 33);
    };
    let timer = setTimeout(tick, 33);
    pumpStop = () => { stopped = true; clearTimeout(timer); };
  }
}

function stopPump() {
  if (pumpStop) pumpStop();
  pumpStop = null;
  pumping = false;
}

// Point the same hands at something else (the galaxy or the Research Center opening or
// closing).
export function setTarget(target, close) {
  if (galaxyRef && galaxyRef !== target) letGoOf(galaxyRef);
  galaxyRef = target;
  closeFn = close;
  const closeIt = () => closeFn && closeFn();
  if (target.kind === 'desktop') {
    // target: desktopMessages(send) plus optional status(text), paused(on) and
    // feedback({ hand, pinch, paused }) for the always-on-top indicator.
    if (desk) return; // already steering the Mac
    hideCursor();
    lastFeedback = null;
    desk = createDesktopGestures({
      desktop: target,
      status: (text) => { setStatus(text); if (target.status) target.status(text); },
      paused: (on) => { if (target.paused) target.paused(on); },
      aspect: cameraAspect,
    });
    step = desk.step;
    if (target.start) target.start();
    if (running) startPump();
  } else if (target.kind === 'page') {
    hideCursor(); // the page draws its own
    step = createPageGestures({ page: target, status: setStatus, close: closeIt, aspect: cameraAspect });
  } else {
    step = createGestures({ galaxy: target, toScreen, hideCursor, status: setStatus, close: closeIt, aspect: cameraAspect });
  }
}

export async function startHands(target, { overlayCanvas, statusEl, cursorEl, close }) {
  setTarget(target, close);
  if (running) return;
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
      // A hand the tracker is unsure is there comes back as noise; gestures.js rides out
      // the brief gaps this leaves.
      minHandPresenceConfidence: 0.6,
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
  if (desk) startPump();
}

export function stopHands() {
  letGoOf(galaxyRef); // desktop mode first: its held button is let go before the camera stops
  galaxyRef = null;
  running = false;
  stopPump();
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  if (cursor) cursor.hidden = true;
}

export function handsRunning() { return running; }

// Desktop mode: whether it's steering the Mac, and pausing it from elsewhere (a spoken
// "stop", the indicator's button). Pausing lets go of anything held at once.
export function desktopMode() { return !!desk; }
export function pauseDesktop(on = true) { if (desk) desk.pause(on); }

// A window closing mid-drag: the backend's watchdog would let go within a second anyway.
addEventListener('pagehide', () => { if (desk) desk.stop(); });
