// "Ask Eden" from anywhere on the Mac (askeden ROADMAP H10): a global shortcut that opens a
// small floating Eden window with its message box ready, Eden on this Mac
// (http://localhost:5174, model-router-ui) or askeden.com when that server isn't running.
// Off until it's switched on in Settings › This Mac › Ask Eden (web/features/eden-hotkey.js,
// prefs eden_hotkey and eden_hotkey_keys); ⌃⌥Space by default, since ⌥Space is Talk.
//
// The window reports the setting ('feature:eden:hotkey'); new keys are tried here first
// ('feature:eden:try': macOS's own and JARVIS's other shortcuts are refused), and the last
// setting is kept in eden-window.json so the shortcut works before the backend answers.
// While Settings records any shortcut ('feature:shell:recording') this one steps aside too.
// Electron comes from ctx.electron in the tests, else the real one.
'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const lib = require('./shell-lib.js');

const CH = 'feature:eden:';
const LOCAL = 'http://localhost:5174/';
const HOSTED = 'https://askeden.com/';
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
    // JARVIS's own (Talk, What's this?) are registered already: never take one of them.
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

  function sameSite(url, base) {
    try { const u = new URL(url), b = new URL(base); return u.origin === b.origin || (b.hostname === 'askeden.com' && u.protocol === 'https:' && u.hostname.endsWith('.askeden.com')); } catch { return false; }
  }
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
      webPreferences: { partition: 'persist:eden', contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
    });
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    const wc = win.webContents;
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
    win.on('closed', () => { win = null; loadedFrom = ''; });
  }

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
  register();
  return { toggle, status, use, tryKeys, window: () => win };
}

module.exports = { install, normalize, localUp, DEFAULT_KEYS, LOCAL, HOSTED };
