// Eden Code's Preview check, in the app itself (features/code_verify.py asks for it through
// the window): reload the dev server's page, wait for it to settle, collect what went wrong
// on it, and take its picture.
//
// - Where: the built-in browser's tab that already shows the dev server (its reload is the
//   one the owner sees), else a hidden preview of the app's own (offscreen, sandboxed, a
//   session of its own that keeps nothing), reused between checks and closed when idle.
// - What went wrong: the page's console errors (uncaught exceptions included), a main page
//   that failed or answered with an error status, a renderer that crashed, and in the
//   hidden preview (whose session is ours) the requests that failed or answered 4xx/5xx.
//   A browser tab's network is the browser's own: its console and load errors only here.
// - When: one check of a page at a time (two sessions' turns ending together reload it in
//   turn, each collecting its own load's errors). After the load, the hidden preview waits
//   until its requests have been quiet a moment (QUIET_MS), and at least MIN_SETTLE_MS (a
//   timer's or a debounced fetch's error a second after the load is still this page's), at
//   most SETTLE_MS; a tab waits SETTLE_MS. A plain page settles in about a second, not 1.5:
//   what a page says later than that, on a page whose requests are quiet, isn't waited for.
// - Whose: each request of the hidden preview counts for the load it began in. A request
//   of the load before (an EventSource the reload closes: net::ERR_FAILED) isn't this
//   check's error.
// - Only addresses on this Mac are ever opened (localhost, 127.x, ::1, *.localhost), and the
//   hidden preview never leaves the page's own origin.
'use strict';

const { BrowserWindow, session, webContents } = require('electron');

const LOAD_MS = 20000;  // the most a check waits for the page to load
const SETTLE_MS = 1500;  // after it loads, for errors that come a moment later (the most)
const QUIET_MS = 600;  // the hidden preview: settled once nothing has loaded or failed this long
const MIN_SETTLE_MS = 1000;  // ...and no sooner than this after the load (errors 0.8-0.9 s in)
const IDLE_CLOSE_MS = 10 * 60 * 1000;  // a hidden preview nobody checked this long closes
const MAX_ERRORS = 40;
const TEXT_MAX = 500;
const SHOT_WIDTH = 1280;
const THUMB_WIDTH = 360;
const PARTITION = 'jarvis-code-preview';  // not persist: nothing kept between runs
const BROWSER_PARTITION = 'persist:jarvis-browser';

function isLocal(url) {
  try {
    const u = new URL(String(url));
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    const h = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
  } catch { return false; }
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

const cut = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
const noise = (text, url = '') => /\/favicon\.ico(\?|$)/.test(url) || /\/favicon\.ico\b.*404|DevTools|Download the React DevTools/.test(text);

// What went wrong on one page during one check.
class Collector {
  constructor() { this.errors = []; this.seen = new Set(); this.status = 0; }
  add(kind, text, where = '') {
    const line = cut(text);
    if (!line || noise(line, where) || this.errors.length >= MAX_ERRORS) return;
    const key = `${kind}:${line}:${where}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.errors.push({ kind, text: line, where: cut(where) });
  }
}

// Every page's current collector (a page's listeners are added once, and report to it).
const listening = new WeakMap();  // webContents -> { collector }

function listen(wc) {
  let slot = listening.get(wc);
  if (slot) return slot;
  // active: when it last loaded or said something; load: which load of the page it's on
  // (each request is counted for the load it began in: started, request id -> load).
  slot = { collector: null, inflight: new Set(), active: 0, load: 0, started: new Map() };
  listening.set(wc, slot);
  wc.on('console-message', (details) => {
    slot.active = Date.now();
    const c = slot.collector;
    if (!c || !details || details.level !== 'error') return;
    const source = details.sourceId ? `${details.sourceId}${details.lineNumber ? `:${details.lineNumber}` : ''}` : '';
    if (/^Failed to load resource/.test(details.message || '') && c.network) return;  // said by the network's own
    c.add('console', details.message, source);
  });
  wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (slot.collector && isMainFrame && code !== -3) slot.collector.add('load', `The page didn't load: ${description} (${code})`, url);
  });
  wc.on('did-navigate', (_e, url, status) => {
    if (!slot.collector) return;
    slot.collector.status = status || 0;
    if (status >= 400) slot.collector.add('load', `The page answered ${status}`, url);
  });
  wc.on('render-process-gone', (_e, info) => {
    if (slot.collector) slot.collector.add('crash', `The page crashed (${(info && info.reason) || 'gone'})`);
  });
  return slot;
}

// ── the hidden previews ──

const previews = new Map();  // origin -> { win, timer }
let previewSession = null;

function ensureSession() {
  if (previewSession) return previewSession;
  const ses = session.fromPartition(PARTITION);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (event) => event.preventDefault());
  // Its requests are ours to watch: the ones that failed or answered with an error, and
  // the ones still going (for when the page has settled).
  ses.webRequest.onBeforeRequest((details, callback) => {
    const slot = slotFor(details.webContentsId);
    if (slot) { slot.inflight.add(details.id); slot.started.set(details.id, slot.load); slot.active = Date.now(); }
    callback({});
  });
  ses.webRequest.onCompleted((details) => {
    const c = requestOver(details);
    if (c && details.statusCode >= 400) c.add('network', `${details.method} ${details.url} → ${details.statusCode}`, details.url);
  });
  ses.webRequest.onErrorOccurred((details) => {
    const c = requestOver(details);
    if (c && details.error !== 'net::ERR_ABORTED') c.add('network', `${details.method} ${details.url} → ${details.error}`, details.url);
  });
  previewSession = ses;
  return ses;
}

function slotFor(id) {
  if (!id) return null;
  const wc = webContents.fromId(id);
  return wc ? listening.get(wc) || null : null;
}

// A request of the hidden preview is over: its page's collector, if a check is on and the
// request is of this check's load (not one the reload ended).
function requestOver(details) {
  const slot = slotFor(details.webContentsId);
  if (!slot) return null;
  const load = slot.started.get(details.id);
  slot.started.delete(details.id);
  if (load !== slot.load) return null;
  slot.inflight.delete(details.id);
  slot.active = Date.now();
  return slot.collector;
}

// A new load of the page: what's still going from the one before isn't waited for, and
// how it ends isn't this check's.
function newLoad(slot) {
  slot.load += 1;
  slot.inflight = new Set();
}

// After the load: until no request has been going for QUIET_MS (the preview, whose
// requests are seen), at most `most` ms.
async function settled(slot, most, watched) {
  if (!watched) { await new Promise((r) => setTimeout(r, most)); return; }
  const start = Date.now();
  const end = start + most;
  const least = start + Math.min(MIN_SETTLE_MS, most);
  slot.active = Math.max(slot.active, Date.now());
  while (Date.now() < end) {
    if (!slot.inflight.size && Date.now() - slot.active >= QUIET_MS && Date.now() >= least) return;
    await new Promise((r) => setTimeout(r, Math.min(50, Math.max(1, end - Date.now()))));
  }
}

function preview(origin, width, height) {
  let entry = previews.get(origin);
  if (entry && !entry.win.isDestroyed()) {
    entry.win.setContentSize(width, height);
    entry.checks += 1;
    if (!entry.win.webContents.isPainting()) entry.win.webContents.startPainting();
    return entry;
  }
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    webPreferences: {
      offscreen: true,
      session: ensureSession(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  const wc = win.webContents;
  wc.setAudioMuted(true);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  const stay = (event, url) => { if (originOf(url) !== origin) event.preventDefault(); };
  wc.on('will-navigate', stay);
  wc.on('will-redirect', stay);
  entry = { win, timer: null, checks: 1 };  // checks: the ones using it now
  previews.set(origin, entry);
  win.on('closed', () => { if (previews.get(origin) === entry) previews.delete(origin); });
  return entry;
}

// A check is done with the preview: it waits for the next one undrawn. Its page runs on as
// before, but an offscreen window otherwise copies out every frame its animations change,
// for nobody, until it closes (pictures still come fresh: preview() draws it again).
function keepAlive(origin) {
  const entry = previews.get(origin);
  if (!entry) return;
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => { if (!entry.win.isDestroyed()) entry.win.destroy(); }, IDLE_CLOSE_MS);
  if (entry.timer.unref) entry.timer.unref();
  entry.checks = Math.max(0, entry.checks - 1);
  if (!entry.checks && !entry.win.isDestroyed()) entry.win.webContents.stopPainting();
}

function closeAll() {
  for (const entry of previews.values()) {
    clearTimeout(entry.timer);
    if (!entry.win.isDestroyed()) entry.win.destroy();
  }
  previews.clear();
}

// ── one check ──

function browserTab(origin) {
  const ses = session.fromPartition(BROWSER_PARTITION);
  return webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.session === ses
    && originOf(wc.getURL()) === origin) || null;
}

function loaded(wc, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; clearTimeout(timer); resolve(ok); } };
    const timer = setTimeout(() => finish(false), ms);
    wc.once('did-stop-loading', () => finish(true));
  });
}

async function picture(wc) {
  const image = await wc.capturePage();
  if (!image || image.isEmpty()) return null;
  const size = image.getSize();
  const full = size.width > SHOT_WIDTH ? image.resize({ width: SHOT_WIDTH, quality: 'good' }) : image;
  const thumb = image.resize({ width: THUMB_WIDTH, quality: 'good' });
  return { shot: full.toJPEG(78).toString('base64'), thumb: thumb.toJPEG(70).toString('base64'), size: [full.getSize().width, full.getSize().height] };
}

// One check of a page at a time: a second waits for the first (each reloads the page and
// collects what its own load said; at once, one's reload cut the other's short).
const queues = new Map();  // origin -> the latest check of it
function check(args = {}) {
  if (!isLocal(args.url)) return Promise.resolve({ error: 'Only a dev server on this Mac is checked.' });
  const origin = originOf(args.url);
  const before = queues.get(origin) || Promise.resolve();
  const mine = before.then(() => checkOne(args));
  const after = mine.catch(() => {});
  queues.set(origin, after);
  after.then(() => { if (queues.get(origin) === after) queues.delete(origin); });
  return mine;
}

async function checkOne({ url, reload = true, width = 1280, height = 800, settle = SETTLE_MS } = {}) {
  const origin = originOf(url);
  width = Math.max(320, Math.min(1920, Number(width) || 1280));
  height = Math.max(320, Math.min(1400, Number(height) || 800));
  settle = Math.max(0, Math.min(10000, Number(settle) || SETTLE_MS));
  let wc = browserTab(origin);
  let source = 'tab';
  if (!wc) {
    source = 'preview';
    wc = preview(origin, width, height).win.webContents;
  }
  const slot = listen(wc);
  const collector = new Collector();
  collector.network = source === 'preview';
  slot.collector = collector;
  try {
    const done = loaded(wc, LOAD_MS);
    let loading = true;
    if (source === 'tab' && reload) wc.reloadIgnoringCache();
    else if (source === 'preview' && (reload || wc.getURL() !== url)) { newLoad(slot); wc.loadURL(url).catch(() => {}); }
    else loading = false;  // already showing it, and not to be reloaded: nothing to wait for
    if (loading && !(await done)) collector.add('load', 'The page didn’t finish loading in time.');
    await settled(slot, settle, source === 'preview');
    let shot = await picture(wc);
    if (!shot && source === 'tab') {
      // A tab that isn't on show can't be pictured: the hidden preview takes it.
      const pwc = preview(origin, width, height).win.webContents;
      try {
        const pdone = loaded(pwc, LOAD_MS);
        pwc.loadURL(url).catch(() => {});
        await pdone;
        await new Promise((r) => setTimeout(r, Math.min(settle, 1000)));
        shot = await picture(pwc);
      } finally {
        keepAlive(origin); // its picture failing too: it still stops drawing and closes when idle
      }
    }
    return { ok: true, url: wc.getURL(), title: wc.getTitle(), status: collector.status, source, errors: collector.errors, ...(shot || {}) };
  } catch (err) {
    return { error: `The check didn’t work: ${err && err.message ? err.message : err}` };
  } finally {
    slot.collector = null;
    if (source === 'preview') keepAlive(origin);
  }
}

module.exports = {
  install(ctx) {
    ctx.ipcMain.handle('feature:code-verify:check', (event, args) => {
      if (!ctx.fromWindow(event)) return { error: 'not allowed' };
      return check(args || {});
    });
    ctx.ipcMain.handle('feature:code-verify:close', (event) => {
      if (!ctx.fromWindow(event)) return false;
      closeAll();
      return true;
    });
    ctx.app.on('before-quit', (event) => { if (!(event && event.defaultPrevented)) closeAll(); }); // (not a quit put off: main.js asks first)
  },
  // For the tests (tests/web/code-verify.e2e.cjs).
  isLocal,
  check,
  closeAll,
};
