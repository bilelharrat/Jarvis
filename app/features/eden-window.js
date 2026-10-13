// "Ask Eden" from anywhere on the Mac (askeden ROADMAP H10): a global shortcut that opens a
// small floating Eden window with its message box ready, Eden on this Mac
// (http://localhost:5174, model-router-ui) or askeden.com when that server isn't running.
// Off until it's switched on in Settings › This Mac › Ask Eden (web/features/eden-hotkey.js,
// prefs eden_hotkey and eden_hotkey_keys); ⌃⌥Space by default, since ⌥Space is Talk.
//
// The window reports the setting ('feature:eden:hotkey'); new keys are tried here first
// ('feature:eden:try': macOS's own and Eden Secretary's other shortcuts are refused), and the last
// setting is kept in eden-window.json so the shortcut works before the backend answers.
// While Settings records any shortcut ('feature:shell:recording') this one steps aside too.
// Eden's browser panel in this window (askeden web/chat/browser-pane.js) is Eden Secretary's own built-in
// browser: eden-preload.js gives the page window.jarvisBrowser, and the tab on show is drawn
// in the panel's slot (ctx.browserDock in main.js: the same tabs, adblock and gates). Only
// Eden's own page in this window may ask ('feature:eden:browser:…'); the window widens while
// the panel is open and goes back to its size after.
// Electron comes from ctx.electron in the tests, else the real one.
//
// Who counts as Eden here (audit S13, S28): exactly https://askeden.com (no other *.askeden.com
// page, which could be anyone's), or Eden on this Mac once it has proved itself. Anything else
// can answer on localhost:5174 (a dev server, another app), so the window asks it for a proof
// first: GET /api/eden/handshake?nonce=<32 hex> must answer { proof } = HMAC-SHA256 of
// "eden-window:<nonce>" under the key in the data folder's eden-handshake.key (made here, 32
// random bytes as hex, this user only; Eden's server on this Mac reads the same file). A page
// that can't is still shown, but gets nothing: no browser panel, no microphone. Only Eden's
// page gets the browser's state, and of the tabs only the one on show has its address and
// title: the others are just there.
// The window's session is deny-by-default (app/window-guards.js, S6): the clipboard and full
// screen for Eden's page, the microphone only for it and only after the owner's yes.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const lib = require('./shell-lib.js');
const guards = require('../window-guards.js');

const CH = 'feature:eden:';
const LOCAL = 'http://localhost:5174/';
const HOSTED = 'https://askeden.com/';
const LOCAL_ORIGIN = 'http://localhost:5174';
const HOSTED_ORIGIN = 'https://askeden.com';
const KEY_FILE = 'eden-handshake.key';
const DEFAULT_KEYS = 'Control+Alt+Space';
const SIZE = { width: 440, height: 660 };
// Pages that may open inside the window besides Eden's own: the sign-in providers askeden.com sends you to.
const SIGN_IN_HOSTS = new Set(['appleid.apple.com', 'accounts.google.com']);

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}

/** The setting as kept or reported: { on, accelerator } with the keys checked. */
function normalize(raw) {
  const given = raw && typeof raw === 'object' ? raw : {};
  const checked = lib.checkAccelerator(given.accelerator);
  return { on: given.on === true, accelerator: checked.ok ? checked.accelerator : DEFAULT_KEYS };
}

/** Is Eden's server on this Mac answering? (a quick look: it listens on loopback only) */
function localUp(timeoutMs = 600) {
  return new Promise((resolve) => {
    const req = http.get(LOCAL, { timeout: timeoutMs }, (res) => { res.resume(); resolve(res.statusCode > 0 && res.statusCode < 500); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

// The handshake's key, in the data folder: made the first time (this user only), else read.
function handshakeKey(dataDir) {
  const file = path.join(dataDir, KEY_FILE);
  try {
    const kept = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(kept)) return kept;
  } catch { /* not made yet */ }
  const key = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(`${file}.${process.pid}.tmp`, key, { mode: 0o600 });
    fs.renameSync(`${file}.${process.pid}.tmp`, file);
  } catch { return ''; }
  return key;
}

const proofFor = (key, nonce) => crypto.createHmac('sha256', key).update(`eden-window:${nonce}`).digest('hex');

// Whether what answers on localhost:5174 knows the key: true only for a proof that matches.
function localProves(key, { get = http.get, timeoutMs = 800 } = {}) {
  return new Promise((resolve) => {
    if (!/^[0-9a-f]{64}$/.test(String(key || ''))) { resolve(false); return; }
    const nonce = crypto.randomBytes(16).toString('hex');
    const want = Buffer.from(proofFor(key, nonce), 'hex');
    const req = get(`${LOCAL}api/eden/handshake?nonce=${nonce}`, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { if (body.length < 4096) body += chunk; });
      res.on('end', () => {
        try {
          const proof = String(JSON.parse(body).proof || '');
          const got = /^[0-9a-f]{64}$/.test(proof) ? Buffer.from(proof, 'hex') : Buffer.alloc(0);
          resolve(res.statusCode === 200 && got.length === want.length && crypto.timingSafeEqual(got, want));
        } catch { resolve(false); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

// The state of the built-in browser as Eden's page hears it: the tab on show in full, the
// others only as tabs (no address, no title, no icon: which sites the owner has open is
// nobody else's business).
function forEden(payload, docked) {
  const tabs = Array.isArray(payload && payload.tabs) ? payload.tabs : [];
  return {
    ...payload,
    tabs: tabs.map((t) => (t && t.active ? t : { id: t && t.id, active: false, loading: Boolean(t && t.loading), title: '', url: '' })),
    docked: Boolean(docked),
  };
}

function install(ctx) {
  const electron = ctx.electron || require('electron');
  const { app, ipcMain } = ctx;
  const { BrowserWindow, globalShortcut, nativeTheme, screen, shell } = electron;
  const takesShortcuts = !ctx.dev && Boolean(globalShortcut);
  const file = path.join(app.getPath('userData'), 'eden-window.json');
  const probe = ctx.edenProbe || localUp;
  let setting = normalize(readJSON(file));
  let registered = '';
  let error = '';
  let stepAside = false;
  let win = null;
  let loadedFrom = '';
  let localProved = false; // Eden on this Mac answered the handshake (the last time it was loaded)
  const proves = ctx.edenHandshake || (() => localProves(handshakeKey(ctx.dataDir || app.getPath('userData'))));

  const save = () => {
    try { fs.writeFileSync(`${file}.tmp`, JSON.stringify(setting)); fs.renameSync(`${file}.tmp`, file); } catch { /* the next report saves it */ }
  };
  const status = () => ({ live: takesShortcuts, on: setting.on, accelerator: setting.accelerator, label: lib.shortcutLabel(setting.accelerator), error });
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
    // Eden Secretary's own (Talk, What's this?) are registered already: never take one of them.
    if (!globalShortcut.isRegistered(setting.accelerator)) {
      try { ok = globalShortcut.register(setting.accelerator, () => { toggle(); }); } catch { ok = false; }
    }
    if (ok) registered = setting.accelerator;
    else {
      error = 'taken';
      console.warn(`eden-window: ${setting.accelerator} is taken`);
    }
  }

  function use(next) {
    const n = normalize(next);
    if (n.on === setting.on && n.accelerator === setting.accelerator && (registered || !n.on || error)) return;
    setting = n;
    save();
    register();
    tell();
  }

  // New keys from Settings: tried at once; the old ones stay when they're refused.
  function tryKeys(accelerator) {
    const checked = lib.checkAccelerator(accelerator);
    const label = lib.shortcutLabel(checked.ok ? checked.accelerator : String(accelerator || ''));
    if (!checked.ok) return { ok: false, error: checked.error, label };
    if (checked.accelerator === registered) return { ok: true, accelerator: checked.accelerator, label };
    if (takesShortcuts && globalShortcut.isRegistered(checked.accelerator)) return { ok: false, error: 'same', label };
    if (takesShortcuts && setting.on && !stepAside) {
      let ok = false;
      try { ok = globalShortcut.register(checked.accelerator, () => { toggle(); }); } catch { ok = false; }
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

  // ── the window ──

  // The same page's origin exactly: no subdomains.
  function sameSite(url, base) {
    try { const u = new URL(url), b = new URL(base); return u.origin === b.origin; } catch { return false; }
  }
  // Eden itself: askeden.com, or Eden on this Mac after its proof.
  const trusted = (origin) => origin === HOSTED_ORIGIN || (origin === LOCAL_ORIGIN && localProved && loadedFrom === LOCAL);
  function staysIn(url) {
    if (sameSite(url, loadedFrom)) return true;
    try { const u = new URL(url); return u.protocol === 'https:' && SIGN_IN_HOSTS.has(u.hostname); } catch { return false; }
  }
  function openOutside(url) {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url).catch(() => {});
  }

  function create() {
    win = new BrowserWindow({
      ...SIZE, minWidth: 360, minHeight: 440, show: false, title: 'Eden',
      alwaysOnTop: true, fullscreenable: false, skipTaskbar: true,
      backgroundColor: nativeTheme && nativeTheme.shouldUseDarkColors ? '#161618' : '#f5f5f7',
      webPreferences: { partition: 'persist:eden', preload: path.join(__dirname, '..', 'eden-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
    });
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    const wc = win.webContents;
    guard(wc);
    wc.setWindowOpenHandler(({ url }) => {
      if (sameSite(url, loadedFrom)) return { action: 'allow' }; // an artifact, a sign-in popup
      openOutside(url);
      return { action: 'deny' };
    });
    wc.on('will-navigate', (event, url) => {
      if (staysIn(url)) return;
      event.preventDefault();
      openOutside(url);
    });
    wc.on('did-finish-load', focusComposer);
    win.on('hide', () => dock().hide(win));
    win.on('closed', () => { dock().hide(win); win = null; loadedFrom = ''; narrow = null; });
  }

  // Deny-by-default (window-guards.js): once for the window's session, and for each window's page.
  let guarded = null;
  function guard(wc) {
    if (wc.session && guarded !== wc.session) {
      guarded = wc.session;
      guards.guardSession(wc.session, { policy: guards.edenPolicy(trusted), ask: askMic, log: (line) => console.warn(line) });
    }
    if (typeof wc.on === 'function') guards.guardContents(wc);
  }
  // The owner's yes to Eden's microphone: a box on the window, in the app's own words.
  async function askMic(_wc, origin) {
    const { dialog } = electron;
    if (!dialog || !win || win.isDestroyed()) return false;
    const where = origin === HOSTED_ORIGIN ? 'askeden.com' : 'Eden on this Mac';
    const { response } = await dialog.showMessageBox(win, {
      type: 'question', buttons: ['Allow', 'Don’t Allow'], defaultId: 1, cancelId: 1,
      message: 'Let Eden use the microphone?', detail: `${where} asks to hear you, for voice input. It can until Eden Secretary quits.`,
    });
    return response === 0;
  }
  // Whether the window shows Eden's own page just now (what may hear the browser's state).
  const edenShown = () => {
    if (!win || win.isDestroyed()) return false;
    const url = win.webContents.getURL();
    return sameSite(url, loadedFrom) && trusted(guards.originOf(url));
  };

  // ── Eden's browser panel: Eden Secretary's browser, docked in this window ──

  const dock = () => ctx.browserDock || { show() {}, hide() {}, bounds() {}, nav() {}, tab() {}, shields() {}, state() {} };
  let narrow = null; // the window's size before the panel widened it
  const fromEden = (event) => Boolean(win && !win.isDestroyed() && event && event.sender === win.webContents
    && (!event.senderFrame || event.senderFrame === win.webContents.mainFrame) && edenShown());
  const rect = (b) => {
    const n = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
    return b && typeof b === 'object' ? { x: n(b.x), y: n(b.y), width: n(b.width), height: n(b.height) } : null;
  };
  function widen() {
    if (!win || narrow || win.isFullScreen()) return;
    const [w, h] = win.getSize();
    if (w >= 980) return;
    narrow = { width: w, height: h };
    const area = screen ? screen.getDisplayMatching(win.getBounds()).workArea : null;
    const width = Math.min(1180, area ? area.width - 40 : 1180);
    const height = Math.max(h, Math.min(780, area ? area.height - 40 : 780));
    win.setSize(width, height, true);
    if (area) { const [x, y] = win.getPosition(); win.setPosition(Math.max(area.x, Math.min(x, area.x + area.width - width)), Math.max(area.y, Math.min(y, area.y + area.height - height)), true); }
  }
  function unwiden() {
    if (!win || !narrow) return;
    win.setSize(narrow.width, narrow.height, true);
    narrow = null;
  }
  ipcMain.handle(`${CH}browser:open`, (event, want) => {
    if (!fromEden(event)) return false;
    if (want === false) { dock().hide(win); unwiden(); return true; }
    widen();
    return true;
  });
  ipcMain.handle(`${CH}browser:show`, (event, bounds) => { if (fromEden(event) && rect(bounds)) dock().show(win, rect(bounds)); });
  ipcMain.handle(`${CH}browser:hide`, (event) => { if (fromEden(event)) dock().hide(win); });
  ipcMain.handle(`${CH}browser:bounds`, (event, bounds) => { if (fromEden(event) && rect(bounds)) dock().bounds(win, rect(bounds)); });
  ipcMain.handle(`${CH}browser:nav`, (event, action, url) => {
    if (fromEden(event) && ['go', 'back', 'forward', 'reload', 'stop'].includes(action)) dock().nav(action, typeof url === 'string' ? url : '');
  });
  ipcMain.handle(`${CH}browser:tab`, (event, action, id) => {
    if (fromEden(event) && ['new', 'select', 'close'].includes(action)) dock().tab(action, Number(id) || 0);
  });
  ipcMain.handle(`${CH}browser:shields`, (event) => { if (fromEden(event)) dock().shields(); });
  ipcMain.handle(`${CH}browser:state`, (event) => { if (fromEden(event)) dock().state(); });

  // Centred on the display with the pointer, in its upper part (where Spotlight opens).
  function place() {
    if (!screen) return;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const area = display.workArea;
    const [w, h] = win.getSize();
    win.setPosition(Math.round(area.x + (area.width - w) / 2), Math.round(area.y + Math.max(24, (area.height - h) / 4)));
  }

  function focusComposer() {
    if (!win || win.isDestroyed()) return;
    win.webContents.executeJavaScript("(() => { const i = document.getElementById('deck-input'); if (i) i.focus(); })()").catch(() => {});
  }

  // The shortcut: shows the window (Eden on this Mac when its server answers, else
  // askeden.com), or hides it when it's already in front.
  async function toggle() {
    if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) { win.hide(); return 'hidden'; }
    if (!win || win.isDestroyed()) create();
    const want = (await probe()) ? LOCAL : HOSTED;
    // Eden on this Mac proves itself each time it's opened (another server may have the port now).
    localProved = want === LOCAL ? (await proves().catch(() => false)) === true : false;
    if (loadedFrom !== want) {
      loadedFrom = want;
      win.loadURL(want).catch(() => {});
    }
    if (!win.isVisible()) place();
    win.show();
    win.focus();
    if (app.focus) app.focus({ steal: true });
    focusComposer();
    return want;
  }

  // ── the window's side (Settings) ──

  ipcMain.on(`${CH}hotkey`, (event, raw) => {
    if (ctx.fromWindow(event)) use(raw);
  });
  ipcMain.handle(`${CH}try`, (event, accelerator) => (ctx.fromWindow(event) ? tryKeys(accelerator) : { ok: false, error: 'invalid' }));
  ipcMain.handle(`${CH}status`, (event) => (ctx.fromWindow(event) ? status() : null));
  // Settings is recording a shortcut (this one or Talk's): its keys must reach the window. For
  // half a minute at most, as shell.js does (a recording that ends in a new shortcut isn't
  // always followed by an "off").
  let asideTimer = null;
  ipcMain.on('feature:shell:recording', (event, on) => {
    if (!ctx.fromWindow(event)) return;
    clearTimeout(asideTimer);
    stepAside = Boolean(on) && takesShortcuts;
    if (stepAside) {
      unregister();
      asideTimer = setTimeout(() => { stepAside = false; register(); tell(); }, ctx.edenAsideMs || 30_000);
      if (asideTimer.unref) asideTimer.unref();
    } else {
      register();
      tell();
    }
  });

  ctx.openEden = toggle;
  ctx.edenShown = edenShown; // main.js: only Eden's own page hears the browser's state (forEden)
  register();
  return { toggle, status, use, tryKeys, window: () => win };
}

module.exports = { install, normalize, localUp, localProves, handshakeKey, proofFor, forEden, DEFAULT_KEYS, LOCAL, HOSTED, KEY_FILE };
