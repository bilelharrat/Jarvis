// Eden Code's "Match a design", in the app itself (features/code_design.py asks for it
// through the window): render the dev server's page at the design's size, picture it, and
// shrink both pictures to one small size for the comparison (done in the backend, numpy).
//
// - Where: a hidden preview of its own (offscreen, sandboxed, a session of its own that keeps
//   nothing, no permissions, no downloads, no popups), sized to the design, closed after each
//   comparison. Never the owner's screen, never a tab of theirs.
// - Only addresses on this Mac are opened, and the preview never leaves the page's origin.
// - A design wider than 1920 pixels is taken as a Retina screenshot: rendered at half size.
'use strict';

const { BrowserWindow, nativeImage, session } = require('electron');
const { isLocal } = require('./code-verify');

const PARTITION = 'jarvis-code-design';  // not persist: nothing kept between runs
const LOAD_MS = 20000;
const SETTLE_MS = 1200;
const COMPARE_SIDE = 256;  // design_diff.COMPARE_SIDE: the comparison's longest side
const SHOT_WIDTH = 1280;
const THUMB_WIDTH = 360;
const THUMB_BYTES = 44000;  // as base64, under previewcheck.THUMB_BYTES
const DESIGN_BYTES = 8000000;

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

// The page's size for a design of w × h pixels: CSS pixels, a Retina shot halved.
function viewportFor(w, h) {
  const scale = w > 1920 ? 2 : 1;
  const width = Math.max(320, Math.min(1920, Math.round(w / scale)));
  const height = Math.max(240, Math.min(3000, Math.round((h / w) * width)));
  return { width, height, scale };
}

// The comparison's size: the longest side COMPARE_SIDE, the design's proportions.
function compareSize(width, height) {
  const f = COMPARE_SIDE / Math.max(width, height);
  return { cw: Math.max(8, Math.round(width * f)), ch: Math.max(8, Math.round(height * f)) };
}

// BGRA (or RGBA) bitmap bytes to RGB, base64.
function rgbOf(image, bgra = process.platform === 'darwin' || process.platform === 'win32') {
  const raw = image.toBitmap();
  const out = Buffer.alloc((raw.length / 4) * 3);
  for (let i = 0, j = 0; i < raw.length; i += 4, j += 3) {
    out[j] = bgra ? raw[i + 2] : raw[i];
    out[j + 1] = raw[i + 1];
    out[j + 2] = bgra ? raw[i] : raw[i + 2];
  }
  return out.toString('base64');
}

function thumbOf(image) {
  let width = THUMB_WIDTH;
  const size = image.getSize();
  if (size.height / size.width * width > 900) width = Math.max(80, Math.round(900 * size.width / size.height));
  const small = image.resize({ width, quality: 'good' });
  for (const q of [70, 55, 40, 28]) {
    const b64 = small.toJPEG(q).toString('base64');
    if (b64.length <= THUMB_BYTES) return b64;
  }
  return '';
}

function shotOf(image) {
  const size = image.getSize();
  const full = size.width > SHOT_WIDTH ? image.resize({ width: SHOT_WIDTH, quality: 'good' }) : image;
  return full.toJPEG(80).toString('base64');
}

function loaded(wc, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; clearTimeout(timer); resolve(ok); } };
    const timer = setTimeout(() => finish(false), ms);
    wc.once('did-stop-loading', () => finish(true));
  });
}

async function render(url, width, height, settle = SETTLE_MS) {
  const origin = new URL(url).origin;
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    webPreferences: {
      offscreen: true,
      session: ensureSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  try {
    const wc = win.webContents;
    wc.setAudioMuted(true);
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const stay = (event, to) => { try { if (new URL(to).origin !== origin) event.preventDefault(); } catch { event.preventDefault(); } };
    wc.on('will-navigate', stay);
    wc.on('will-redirect', stay);
    win.setContentSize(width, height);
    const done = loaded(wc, LOAD_MS);
    wc.loadURL(url).catch(() => {});
    if (!(await done)) return { error: 'The page didn’t finish loading in time.' };
    await new Promise((r) => setTimeout(r, settle));
    const image = await wc.capturePage();
    if (!image || image.isEmpty()) return { error: 'The page couldn’t be pictured.' };
    return { image: image.resize({ width, height, quality: 'best' }) };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

// One comparison's pictures: the design's bytes and the page's address in, both pictures out.
async function compare({ url, design, settle } = {}) {
  if (!isLocal(url)) return { error: 'Only a dev server on this Mac is compared.' };
  const bytes = design instanceof Uint8Array ? Buffer.from(design) : null;
  if (!bytes || !bytes.length || bytes.length > DESIGN_BYTES) return { error: 'The design picture is missing.' };
  const picture = nativeImage.createFromBuffer(bytes);
  if (picture.isEmpty()) return { error: 'The design picture can’t be read.' };
  const natural = picture.getSize();
  const { width, height } = viewportFor(natural.width, natural.height);
  try {
    const page = await render(url, width, height, settle);
    if (page.error) return page;
    const designed = picture.resize({ width, height, quality: 'best' });
    const { cw, ch } = compareSize(width, height);
    const small = (img) => img.resize({ width: cw, height: ch, quality: 'best' });
    return {
      ok: true,
      size: [width, height],
      natural: [natural.width, natural.height],
      cw,
      ch,
      a: rgbOf(small(designed)),
      b: rgbOf(small(page.image)),
      shot: shotOf(page.image),
      thumb: thumbOf(page.image),
      design_shot: shotOf(designed),
      design_thumb: thumbOf(designed),
    };
  } catch (err) {
    return { error: `The comparison didn’t work: ${err && err.message ? err.message : err}` };
  }
}

module.exports = {
  install(ctx) {
    ctx.ipcMain.handle('feature:design-match:compare', (event, args) => {
      if (!ctx.fromWindow(event)) return { error: 'not allowed' };
      return compare(args || {});
    });
  },
  // For the tests (tests/web/design-match.e2e.cjs).
  viewportFor,
  compareSize,
  compare,
};
