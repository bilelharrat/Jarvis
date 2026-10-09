// Eden Code's video proof, in the app itself (features/code_video.py asks for it through
// the window): a short recording of the dev server's page doing its thing after a turn that
// changed its UI, kept with the turn like the Preview check's picture.
//
// - What's recorded: only a page of the app's own, in a hidden preview (offscreen, sandboxed,
//   a session of its own that keeps nothing, no permissions, downloads or popups, locked to
//   the page's origin), opened fresh, left to load, then scrolled gently down and back up.
//   Never the owner's screen, never a tab or window of theirs: there is no screen capture here.
// - How: the DevTools protocol's screencast (Page.startScreencast) sends the page's frames as
//   it paints them; a second hidden page plays them onto a canvas at their own timing while
//   the browser's own MediaRecorder turns the canvas into a WebM video. No new dependency.
// - Only addresses on this Mac are opened.
'use strict';

const { BrowserWindow, nativeImage, session } = require('electron');
const { isLocal } = require('./code-verify');

const PARTITION = 'jarvis-code-video';  // not persist: nothing kept between runs
const LOAD_MS = 20000;
const MAX_SECONDS = 10;
const MAX_FRAMES = 240;
const FRAME_QUALITY = 70;
const VIDEO_BITS = 2500000;
const VIDEO_BYTES = 15000000;  // code_video.VIDEO_BYTES
const POSTER_BYTES = 44000;

let previewSession = null;
function ensureSession() {
  if (previewSession) return previewSession;
  const ses = session.fromPartition(PARTITION);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (event) => event.preventDefault());
  previewSession = ses;
  return ses;
}

function hidden(width, height, ses) {
  return new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    webPreferences: {
      offscreen: true,
      ...(ses ? { session: ses } : {}),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
}

function loaded(wc, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; clearTimeout(timer); resolve(ok); } };
    const timer = setTimeout(() => finish(false), ms);
    wc.once('did-stop-loading', () => finish(true));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The page's gentle tour: down to the bottom over most of the time, then back to the top.
const TOUR = (ms) => `(() => {
  const end = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  if (!end) return true;
  const down = ${Math.round(ms * 0.6)}, up = ${Math.round(ms * 0.3)}, t0 = performance.now();
  const step = () => {
    const t = performance.now() - t0;
    const y = t < down ? end * (t / down) : t < down + up ? end * (1 - (t - down) / up) : 0;
    scrollTo(0, y);
    if (t < down + up) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
  return true;
})()`;

// The page's frames, as it paints them, for `seconds` from its first paint after loading.
async function capture(url, { seconds, width, height }) {
  const origin = new URL(url).origin;
  const win = hidden(width, height, ensureSession());
  const frames = [];
  try {
    const wc = win.webContents;
    wc.setAudioMuted(true);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const stay = (event, to) => { try { if (new URL(to).origin !== origin) event.preventDefault(); } catch { event.preventDefault(); } };
    wc.on('will-navigate', stay);
    wc.on('will-redirect', stay);
    win.setContentSize(width, height);
    // Opened first, then recorded as it loads again: the debugger is attached to the page's
    // own process (the first load moves it to another), and the reload is what's seen.
    const first = loaded(wc, LOAD_MS);
    wc.loadURL(url).catch(() => {});
    if (!(await first)) return { error: 'The page didn’t finish loading in time.' };
    const dbg = wc.debugger;
    dbg.attach('1.3');
    dbg.on('message', (_e, method, params) => {
      if (method !== 'Page.screencastFrame') return;
      dbg.sendCommand('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
      if (frames.length >= MAX_FRAMES) return;
      const at = params.metadata && params.metadata.timestamp ? params.metadata.timestamp * 1000 : Date.now();
      frames.push({ at, data: params.data });
    });
    const started = Date.now();
    await dbg.sendCommand('Page.startScreencast', { format: 'jpeg', quality: FRAME_QUALITY, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
    const again = loaded(wc, LOAD_MS);
    await dbg.sendCommand('Page.reload', { ignoreCache: true });
    await again;
    const ms = seconds * 1000;
    const settle = Math.min(1500, ms / 4);  // it settles on screen first
    const left = () => ms - (Date.now() - started);
    await sleep(Math.max(0, Math.min(settle, left())));
    await wc.executeJavaScript(TOUR(Math.max(300, left() - 300)), true).catch(() => {});
    await sleep(Math.max(0, left()));
    await dbg.sendCommand('Page.stopScreencast').catch(() => {});
    return { frames, started };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

// Frames to a WebM video: played onto a canvas at their own timing, recorded by the page's
// MediaRecorder. The frames are only drawn; nothing in them runs.
const ENCODE = `async (frames, width, height, bits, total) => {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  document.body.append(canvas);
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, width, height);
  const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  if (!type) return { error: 'This app can’t make videos.' };
  const images = await Promise.all(frames.map((f) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = 'data:image/jpeg;base64,' + f.data;
  })));
  const rec = new MediaRecorder(canvas.captureStream(30), { mimeType: type, videoBitsPerSecond: bits });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.start(500);
  const t0 = performance.now(), first = frames[0].at;
  for (let i = 0; i < frames.length; i++) {
    const wait = frames[i].at - first - (performance.now() - t0);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (images[i]) g.drawImage(images[i], 0, 0, width, height);
  }
  // The last frame stays on until the recording's whole length (a page that stopped painting).
  await new Promise((r) => setTimeout(r, Math.max(400, total - (performance.now() - t0))));
  await new Promise((r) => { rec.onstop = r; rec.stop(); });
  const blob = new Blob(chunks, { type: 'video/webm' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return { webm: btoa(bin), type };
}`;

async function encode(frames, width, height, totalMs) {
  const win = hidden(width, height, null);
  try {
    await win.loadURL('about:blank');
    return await win.webContents.executeJavaScript(`(${ENCODE})(${JSON.stringify(frames)}, ${width}, ${height}, ${VIDEO_BITS}, ${Math.round(totalMs)})`, true);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

function posterOf(frame) {
  const image = nativeImage.createFromBuffer(Buffer.from(frame.data, 'base64'));
  if (image.isEmpty()) return '';
  const small = image.resize({ width: 360, quality: 'good' });
  for (const q of [70, 55, 40]) {
    const b64 = small.toJPEG(q).toString('base64');
    if (b64.length <= POSTER_BYTES) return b64;
  }
  return '';
}

async function record({ url, seconds = 8, width = 1280, height = 800 } = {}) {
  if (!isLocal(url)) return { error: 'Only a dev server on this Mac is recorded.' };
  seconds = Math.max(2, Math.min(MAX_SECONDS, Number(seconds) || 8));
  width = Math.max(320, Math.min(1600, Math.round(Number(width) || 1280)));
  height = Math.max(240, Math.min(1000, Math.round(Number(height) || 800)));
  try {
    const got = await capture(url, { seconds, width, height });
    if (got.error) return got;
    if (got.frames.length < 2) return { error: 'The page didn’t paint anything to record.' };
    const out = await encode(got.frames, width, height, Math.min(seconds * 1000, (Date.now() - got.started)));
    if (!out || out.error) return { error: (out && out.error) || 'The video couldn’t be made.' };
    if (out.webm.length > VIDEO_BYTES * 4 / 3) return { error: 'The video came out too large to keep.' };
    const span = Math.max((got.frames[got.frames.length - 1].at - got.frames[0].at) / 1000, Math.min(seconds, (Date.now() - got.started) / 1000));
    return { ok: true, webm: out.webm, poster: posterOf(got.frames[Math.min(got.frames.length - 1, 3)]), seconds: Math.round(span * 10) / 10, frames: got.frames.length, size: [width, height] };
  } catch (err) {
    return { error: `The recording didn’t work: ${err && err.message ? err.message : err}` };
  }
}

module.exports = {
  install(ctx) {
    ctx.ipcMain.handle('feature:video-proof:record', (event, args) => {
      if (!ctx.fromWindow(event)) return { error: 'not allowed' };
      return record(args || {});
    });
  },
  // For the tests (tests/web/video-proof.e2e.cjs).
  record,
};
