// Eden anywhere on the Mac: highlight text in any app, press ⌃⌥E (or pick "Ask Eden" in the
// Services menu), and a small Eden pop-up appears by the pointer with Explain / Summarize /
// Rewrite / Fix / Shorter / Draft a reply / Translate / Change tone, or a typed question. The
// answer streams in; Replace puts it back over the selection in the original app, Copy, Read
// aloud (Eden's voice), Continue in Eden, Try again. With nothing selected it's "write here":
// Insert puts what Eden wrote at the cursor. And Talk (⌥Space) learns the front app and its
// selection before Eden's window takes the focus, so "what does this mean?" works.
//
// The backend does the Mac's part (features/eden_pop.py: the selection, the answer, the paste)
// over the window's own server with the launch token (ctx.backendAddress), never through a web
// page. The order matters: the selection is grabbed first, then the pop-up shows (a window in
// front first would take the selection with it). The pop-up is a non-activating panel, so the
// app the text came from mostly stays in front.
//
// The setting comes from Settings › This Mac (web/features/eden-pop.js, prefs eden_pop,
// eden_pop_keys, eden_pop_copy), reported by the window ('feature:pop:setting'); new keys are
// tried here first ('feature:pop:try'), and the last setting is kept in eden-pop.json so the
// shortcut works before the backend answers. Off for Eden Code (it takes no global shortcuts).
// Electron comes from ctx.electron in the tests, else the real one; the backend from ctx.popBackend.
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const lib = require('./shell-lib.js');

const CH = 'feature:pop:';
const DEFAULT_KEYS = 'Control+Alt+E';
const SIZE = { width: 420, height: 300 };
const MIN_HEIGHT = 150;
const MAX_HEIGHT = 640;
const GRAB_MS = 3000; // the selection: Accessibility, or the copy trick (half a second at most)
const PEEK_MS = 400; // Talk waits this long at most for its look at the selection
const PUT_MS = 6000;

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}

/** The setting as kept or reported: { on, accelerator, copy } with the keys checked. */
function normalize(raw) {
  const given = raw && typeof raw === 'object' ? raw : {};
  const checked = lib.checkAccelerator(given.accelerator);
  return { on: given.on !== false, accelerator: checked.ok ? checked.accelerator : DEFAULT_KEYS, copy: given.copy !== false };
}

/** Where the pop-up goes: by the pointer, below it (above when there's no room), on screen. */
function placeNear(point, size, area) {
  const margin = 8;
  let x = Math.round(point.x - 24);
  let y = Math.round(point.y + 18);
  if (y + size.height > area.y + area.height - margin) y = Math.round(point.y - size.height - 12);
  x = Math.max(area.x + margin, Math.min(x, area.x + area.width - size.width - margin));
  y = Math.max(area.y + margin, Math.min(y, area.y + area.height - size.height - margin));
  return { x, y };
}

/** Is screen-reader mode on? (Settings › Accessibility: Auto follows the screen reader.) */
function readerMode(mode, supported, flavorId) {
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return Boolean(supported) || flavorId === 'daredevil';
}

// ── the backend: JSON over the window's server, with the launch token ──

function httpBackend(address) {
  function open(pathName, body, timeoutMs, onResponse, onError) {
    const where = address();
    if (!where) { onError(new Error('no backend')); return null; }
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = http.request({
      host: '127.0.0.1', port: where.port, path: pathName, method: 'POST', timeout: timeoutMs,
      headers: { 'content-type': 'application/json', 'content-length': data.length, 'x-jarvis-token': where.token },
    }, onResponse);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', onError);
    req.end(data);
    return req;
  }
  return {
    post(pathName, body, timeoutMs = 10_000) {
      return new Promise((resolve, reject) => {
        open(pathName, body, timeoutMs, (res) => {
          const parts = [];
          res.on('data', (c) => parts.push(c));
          res.on('end', () => {
            try { resolve({ status: res.statusCode, ...JSON.parse(Buffer.concat(parts).toString('utf8') || '{}') }); } catch (err) { reject(err); }
          });
          res.on('error', reject);
        }, reject);
      });
    },
    // Lines of JSON as they come: onLine(obj) for each; resolves when the answer ends.
    stream(pathName, body, onLine) {
      let req = null;
      const done = new Promise((resolve, reject) => {
        req = open(pathName, body, 120_000, (res) => {
          let rest = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            rest += chunk;
            let at;
            while ((at = rest.indexOf('\n')) >= 0) {
              const line = rest.slice(0, at).trim();
              rest = rest.slice(at + 1);
              if (line) { try { onLine(JSON.parse(line)); } catch { /* a broken line: skipped */ } }
            }
          });
          res.on('end', () => {
            if (res.statusCode >= 400) {
              try { onLine({ error: JSON.parse(rest).error || 'Eden couldn’t answer just now.' }); } catch { onLine({ error: 'Eden couldn’t answer just now.' }); }
            } else if (rest.trim()) { try { onLine(JSON.parse(rest)); } catch { /* skipped */ } }
            resolve();
          });
          res.on('error', reject);
        }, reject);
      });
      return { done, abort: () => { if (req) req.destroy(); } };
    },
  };
}

function install(ctx) {
  const electron = ctx.electron || require('electron');
  const { app, ipcMain } = ctx;
  const { BrowserWindow, clipboard, globalShortcut, nativeTheme, screen } = electron;
  const flavorId = (ctx.flavor && ctx.flavor.id) || 'jarvis';
  const takesShortcuts = !ctx.dev && Boolean(globalShortcut) && flavorId !== 'eden-code';
  const file = path.join(app.getPath('userData'), 'eden-pop.json');
  const backend = ctx.popBackend || httpBackend(() => (ctx.backendAddress ? ctx.backendAddress() : null));
  let setting = normalize(readJSON(file));
  let registered = '';
  let error = '';
  let stepAside = false;
  let win = null;
  let ready = null; // the page has loaded (a promise)
  let grabbing = false;
  let target = null; // the app the text came from: { pid, bundle, app, title }
  let current = null; // the answer being streamed: { id, abort }
  let keepOpen = false; // a Replace in progress: the blur that comes with it doesn't close

  const save = () => {
    try { fs.writeFileSync(`${file}.tmp`, JSON.stringify(setting)); fs.renameSync(`${file}.tmp`, file); } catch { /* the next report saves it */ }
  };
  const status = () => ({ live: takesShortcuts, on: setting.on, accelerator: setting.accelerator, label: lib.shortcutLabel(setting.accelerator), copy: setting.copy, error });
  const tell = () => ctx.send(`${CH}status`, status());

  // ── the shortcut ──

  function unregister() {
    if (!registered) return;
    try { globalShortcut.unregister(registered); } catch { /* already gone */ }
    registered = '';
  }

  function register() {
    unregister();
    error = '';
    if (!takesShortcuts || !setting.on || stepAside) return;
    let ok = false;
    // Eden's own (Talk, What's this?, Ask Eden, Stop) are registered already: never take one.
    if (!globalShortcut.isRegistered(setting.accelerator)) {
      try { ok = globalShortcut.register(setting.accelerator, () => { press(); }); } catch { ok = false; }
    }
    if (ok) registered = setting.accelerator;
    else {
      error = 'taken';
      console.warn(`eden-pop: ${setting.accelerator} is taken`);
    }
  }

  function use(next) {
    const n = normalize(next);
    const same = n.on === setting.on && n.accelerator === setting.accelerator;
    if (same && n.copy === setting.copy && (registered || !n.on || error)) return;
    setting = n;
    save();
    if (!same || (!registered && n.on)) register();
    if (!setting.on) hide();
    tell();
  }

  function tryKeys(accelerator) {
    const checked = lib.checkAccelerator(accelerator);
    const label = lib.shortcutLabel(checked.ok ? checked.accelerator : String(accelerator || ''));
    if (!checked.ok) return { ok: false, error: checked.error, label };
    if (checked.accelerator === registered) return { ok: true, accelerator: checked.accelerator, label };
    if (takesShortcuts && globalShortcut.isRegistered(checked.accelerator)) return { ok: false, error: 'same', label };
    if (takesShortcuts && setting.on && !stepAside) {
      let ok = false;
      try { ok = globalShortcut.register(checked.accelerator, () => { press(); }); } catch { ok = false; }
      if (!ok) return { ok: false, error: 'taken', label };
      unregister();
      registered = checked.accelerator;
    }
    setting = { ...setting, accelerator: checked.accelerator };
    error = '';
    save();
    tell();
    return { ok: true, accelerator: checked.accelerator, label };
  }

  // ── the pop-up ──

  const alive = () => Boolean(win && !win.isDestroyed());
  const fromPop = (event) => alive() && event && event.sender === win.webContents;
  const toPop = (channel, payload) => { if (alive()) win.webContents.send(channel, payload); };

  function create() {
    win = new BrowserWindow({
      ...SIZE, show: false, frame: false, resizable: false, movable: true, minimizable: false, maximizable: false,
      fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: true, title: 'Eden',
      type: 'panel', // macOS: a non-activating panel, so the app the text came from stays in front
      backgroundColor: nativeTheme && nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f7f7f9',
      webPreferences: { preload: path.join(__dirname, '..', 'eden-pop-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
    });
    if (win.setAlwaysOnTop) win.setAlwaysOnTop(true, 'floating');
    if (win.setVisibleOnAllWorkspaces) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    const wc = win.webContents;
    // Nothing leaves the pop-up: no other page, no new windows.
    if (wc.setWindowOpenHandler) wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (event) => event.preventDefault());
    win.on('blur', () => { if (!keepOpen) hide(); });
    win.on('closed', () => { win = null; ready = null; });
    ready = new Promise((resolve) => {
      wc.once('did-finish-load', resolve);
      win.loadFile(path.join(__dirname, '..', 'eden-pop.html')).catch(() => resolve());
    });
  }

  function hide() {
    stopAnswer();
    if (alive() && win.isVisible()) win.hide();
  }

  function stopAnswer() {
    if (current) { try { current.abort(); } catch { /* gone */ } current = null; }
  }

  function place() {
    if (!screen || !alive()) return;
    const point = screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(point).workArea;
    const [width, height] = win.getSize();
    const at = placeNear(point, { width, height }, area);
    win.setPosition(at.x, at.y);
  }

  async function open(seen) {
    if (!alive()) create();
    await ready;
    if (!alive()) return null;
    const supported = app.isAccessibilitySupportEnabled ? app.isAccessibilitySupportEnabled() : false;
    const state = {
      text: String(seen.text || ''),
      app: String(seen.app || ''),
      title: String(seen.title || ''),
      source: String(seen.source || ''),
      ax: seen.ax === true,
      secure: seen.secure === true,
      canPut: Boolean(target && target.pid),
      service: seen.service === true,
      reader: readerMode(seen.a11y_mode, supported, flavorId),
      zh: seen.zh && typeof seen.zh === 'object' ? seen.zh : null,
      keys: lib.shortcutLabel(setting.accelerator),
    };
    toPop('eden-pop:open', state);
    if (!win.isVisible()) { win.setSize(SIZE.width, SIZE.height); place(); }
    win.show();
    win.focus();
    return state;
  }

  // The shortcut: the selection first (the pop-up isn't up yet, so it can't take it), then the
  // pop-up by the pointer. Pressed again while the pop-up is in front: it closes.
  async function press() {
    if (alive() && win.isVisible() && win.isFocused()) { hide(); return 'hidden'; }
    if (grabbing) return 'busy';
    grabbing = true;
    let seen = {};
    try {
      seen = await backend.post('/f/eden_pop/grab', { clipboard: setting.copy }, GRAB_MS);
    } catch {
      seen = {};
    } finally {
      grabbing = false;
    }
    if (seen && seen.error === 'off') return 'off';
    target = seen && !seen.own && Number.isInteger(seen.pid) && seen.pid > 0 ? { pid: seen.pid, bundle: String(seen.bundle || ''), app: String(seen.app || '') } : null;
    await open(seen || {});
    return 'shown';
  }

  // "Ask Eden" from the Services menu (shell.js hands its text here): that text is the
  // selection. macOS may already have brought Eden forward for the link, so the app in front
  // is the target only when it isn't Eden itself (else Replace becomes Copy).
  async function fromService(text) {
    if (!setting.on || flavorId === 'eden-code') return false;
    let seen = {};
    try { seen = await backend.post('/f/eden_pop/grab', { clipboard: false }, GRAB_MS); } catch { seen = {}; }
    if (seen && seen.error === 'off') return false;
    target = seen && !seen.own && Number.isInteger(seen.pid) && seen.pid > 0 ? { pid: seen.pid, bundle: String(seen.bundle || ''), app: String(seen.app || '') } : null;
    await open({ ...(seen || {}), text, source: 'service', service: true, secure: false, app: target ? target.app : '', title: target ? seen.title : '' });
    return true;
  }

  // ── what the pop-up asks ──

  ipcMain.on('eden-pop:ask', (event, req) => {
    if (!fromPop(event) || !req || typeof req !== 'object') return;
    stopAnswer();
    const id = String(req.id || '');
    const body = {
      action: String(req.action || ''), text: String(req.text || ''), instruction: String(req.instruction || ''),
      tone: String(req.tone || ''), language: String(req.language || ''), app: String(req.app || ''), title: String(req.title || ''),
      history: Array.isArray(req.history) ? req.history.slice(-20) : [],
    };
    let ended = false;
    const end = (payload) => { if (!ended) { ended = true; toPop('eden-pop:end', { id, ...payload }); } };
    const run = backend.stream('/f/eden_pop/answer', body, (line) => {
      if (line && typeof line.t === 'string') toPop('eden-pop:chunk', { id, t: line.t });
      else if (line && line.error) end({ error: String(line.error) });
      else if (line && line.done) end({});
    });
    current = { id, abort: run.abort };
    run.done.then(() => end({}), () => end({ error: 'Eden couldn’t answer just now. Try again.' })).finally(() => {
      if (current && current.id === id) current = null;
    });
  });

  ipcMain.on('eden-pop:stop', (event) => { if (fromPop(event)) stopAnswer(); });
  ipcMain.on('eden-pop:close', (event) => { if (fromPop(event)) hide(); });
  ipcMain.on('eden-pop:size', (event, height) => {
    if (!fromPop(event)) return;
    const h = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(Number(height) || SIZE.height)));
    const [w, now] = win.getSize();
    if (Math.abs(h - now) < 2) return;
    win.setSize(w, h);
    if (screen) {
      const [x, y] = win.getPosition();
      const area = screen.getDisplayNearestPoint({ x, y }).workArea;
      if (y + h > area.y + area.height - 8) win.setPosition(x, Math.max(area.y + 8, area.y + area.height - h - 8));
    }
  });

  ipcMain.handle('eden-pop:copy', (event, text) => {
    if (!fromPop(event) || typeof text !== 'string') return false;
    clipboard.writeText(text);
    return true;
  });

  // Replace / Insert: the pop-up goes, the original app comes back, the text is pasted there.
  ipcMain.handle('eden-pop:put', async (event, text) => {
    if (!fromPop(event) || typeof text !== 'string' || !text.trim()) return { ok: false };
    if (!target) { clipboard.writeText(text); return { ok: false, copied: true, reason: 'no_app' }; }
    keepOpen = true;
    win.hide();
    let done = {};
    try {
      done = await backend.post('/f/eden_pop/put', { text, pid: target.pid, bundle: target.bundle }, PUT_MS);
    } catch {
      done = {};
    } finally {
      keepOpen = false;
    }
    if (done && done.pasted) return { ok: true, pasted: true };
    if (!(done && done.copied)) clipboard.writeText(text);
    // Not pasted: the pop-up comes back to say the text is on the clipboard instead.
    if (alive()) { win.show(); win.focus(); }
    return { ok: false, copied: true, reason: (done && done.reason) || 'failed' };
  });

  ipcMain.handle('eden-pop:speak', async (event, text) => {
    if (!fromPop(event) || typeof text !== 'string') return false;
    try { return (await backend.post('/f/eden_pop/speak', { text }, 5000)).ok === true; } catch { return false; }
  });

  ipcMain.handle('eden-pop:continue', async (event, req) => {
    if (!fromPop(event) || !req || typeof req !== 'object') return false;
    let ok = false;
    try {
      ok = (await backend.post('/f/eden_pop/continue', {
        action: String(req.action || ''), text: String(req.text || ''), instruction: String(req.instruction || ''),
        tone: String(req.tone || ''), language: String(req.language || ''), app: String(req.app || ''), title: String(req.title || ''),
        answer: String(req.answer || ''),
      }, 5000)).ok === true;
    } catch { ok = false; }
    if (!ok) return false;
    hide();
    const main = ctx.getWindow && ctx.getWindow();
    if (main && !main.isDestroyed()) {
      main.show();
      main.focus();
      if (app.focus) app.focus({ steal: true });
    }
    return true;
  });

  // ── Talk (⌥Space) knows the front app and its selection ──
  // Before Eden's window takes the focus: Accessibility only (no clipboard, no keystrokes),
  // a short wait at most, and Talk opens either way.
  const summonAsIs = ctx.summon;
  if (typeof summonAsIs === 'function') {
    ctx.summon = () => {
      if (!setting.on || flavorId === 'eden-code' || (alive() && win.isVisible())) { summonAsIs(); return; }
      let went = false;
      const go = () => { if (!went) { went = true; summonAsIs(); } };
      const timer = setTimeout(go, PEEK_MS);
      backend.post('/f/eden_pop/peek', {}, PEEK_MS + 200).catch(() => null).finally(() => { clearTimeout(timer); go(); });
    };
  }

  // ── the window's side (Settings) ──

  ipcMain.on(`${CH}setting`, (event, raw) => { if (ctx.fromWindow(event)) use(raw); });
  ipcMain.handle(`${CH}try`, (event, accelerator) => (ctx.fromWindow(event) ? tryKeys(accelerator) : { ok: false, error: 'invalid' }));
  ipcMain.handle(`${CH}status`, (event) => (ctx.fromWindow(event) ? status() : null));
  // Settings is recording a shortcut: its keys must reach the window (as eden-window.js does).
  let asideTimer = null;
  ipcMain.on('feature:shell:recording', (event, on) => {
    if (!ctx.fromWindow(event)) return;
    clearTimeout(asideTimer);
    stepAside = Boolean(on) && takesShortcuts;
    if (stepAside) {
      unregister();
      asideTimer = setTimeout(() => { stepAside = false; register(); tell(); }, ctx.popAsideMs || 30_000);
      if (asideTimer.unref) asideTimer.unref();
    } else {
      register();
      tell();
    }
  });

  ctx.edenPopService = fromService;
  register();
  return { press, fromService, status, use, tryKeys, window: () => win, target: () => target };
}

module.exports = { install, normalize, placeNear, readerMode, httpBackend, DEFAULT_KEYS };
