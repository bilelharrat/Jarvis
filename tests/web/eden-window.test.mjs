// "Ask Eden" on a global shortcut (app/features/eden-window.js) with a stand-in Electron: off
// until switched on, ⌃⌥Space by default, never one of JARVIS's own or macOS's keys, the small
// window on Eden on this Mac or askeden.com. node --test tests/web/
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const eden = require('../../app/features/eden-window.js');

function fake({ userData = mkdtempSync(path.join(tmpdir(), 'eden-window-')), up = true } = {}) {
  const globalShortcut = {
    taken: new Set(), // another app's
    mine: new Map(),
    register(acc, fn) { if (this.taken.has(acc) || this.mine.has(acc)) return false; this.mine.set(acc, fn); return true; },
    unregister(acc) { this.mine.delete(acc); },
    isRegistered(acc) { return this.mine.has(acc); },
    press(acc) { const fn = this.mine.get(acc); if (fn) fn(); return Boolean(fn); },
  };
  const windows = [];
  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.visible = false;
      this.focused = false;
      this.loaded = [];
      this.js = [];
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = (fn) => { this.openHandler = fn; };
      this.webContents.executeJavaScript = (code) => { this.js.push(code); return Promise.resolve(); };
      windows.push(this);
    }
    setVisibleOnAllWorkspaces() {}
    loadURL(url) { this.loaded.push(url); return Promise.resolve(); }
    isDestroyed() { return false; }
    isVisible() { return this.visible; }
    isFocused() { return this.focused; }
    getSize() { return [this.options.width, this.options.height]; }
    setPosition(x, y) { this.at = [x, y]; }
    show() { this.visible = true; }
    focus() { this.focused = true; }
    hide() { this.visible = false; this.focused = false; }
  }
  const opened = [];
  const electron = {
    BrowserWindow, globalShortcut, windows, opened,
    nativeTheme: { shouldUseDarkColors: false },
    screen: {
      getCursorScreenPoint: () => ({ x: 10, y: 10 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 38, width: 1512, height: 870 } }),
    },
    shell: { openExternal: (url) => { opened.push(url); return Promise.resolve(); } },
  };
  const ipcMain = new EventEmitter();
  ipcMain.handlers = new Map();
  ipcMain.handle = (channel, fn) => ipcMain.handlers.set(channel, fn);
  const sent = [];
  const fromWindow = { sender: 'window' };
  const ctx = {
    electron, ipcMain, dev: false,
    app: { getPath: () => userData, focus() {} },
    send: (channel, payload) => sent.push([channel, payload]),
    fromWindow: (event) => event === fromWindow,
    edenProbe: async () => ctx.up,
    edenAsideMs: 40,
    up,
  };
  return { ctx, electron, ipcMain, sent, fromWindow, userData, feature: eden.install(ctx) };
}

test('off until switched on; then ⌃⌥Space opens Eden on this Mac, and again hides it', async () => {
  const t = fake();
  const keys = t.electron.globalShortcut;
  assert.equal(keys.mine.size, 0, 'nothing registered while off');
  assert.equal(t.feature.status().on, false);
  t.ipcMain.emit('feature:eden:hotkey', t.fromWindow, { on: true });
  assert.deepEqual([...keys.mine.keys()], ['Control+Alt+Space']);
  assert.equal(t.sent.at(-1)[1].label, '⌃⌥ Space');
  keys.press('Control+Alt+Space');
  await new Promise((r) => setTimeout(r, 5));
  const win = t.electron.windows[0];
  assert.deepEqual(win.loaded, [eden.LOCAL]);
  assert.ok(win.visible && win.focused);
  assert.equal(win.options.alwaysOnTop, true);
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.match(win.js.at(-1), /deck-input/, 'the message box gets the focus');
  assert.deepEqual(win.at, [536, 38 + Math.round((870 - 660) / 4)]);
  assert.equal(await t.feature.toggle(), 'hidden');
  assert.equal(win.visible, false);
  // switched off: the keys go back
  t.ipcMain.emit('feature:eden:hotkey', t.fromWindow, { on: false, accelerator: 'Control+Alt+Space' });
  assert.equal(keys.mine.size, 0);
});

test('askeden.com when Eden isn’t running on this Mac; other sites open in the browser', async () => {
  const t = fake({ up: false });
  assert.equal(await t.feature.toggle(), eden.HOSTED);
  const win = t.electron.windows[0];
  const nav = (url) => { let stopped = false; win.webContents.emit('will-navigate', { preventDefault: () => { stopped = true; } }, url); return stopped; };
  assert.equal(nav('https://askeden.com/signin'), false);
  assert.equal(nav('https://appleid.apple.com/auth/authorize'), false, 'Sign in with Apple stays in the window');
  assert.equal(nav('https://example.com/'), true);
  assert.deepEqual(t.electron.opened, ['https://example.com/']);
  assert.deepEqual(win.openHandler({ url: 'https://askeden.com/artifact/x' }), { action: 'allow' });
  assert.deepEqual(win.openHandler({ url: 'https://news.example/' }), { action: 'deny' });
  // the server on this Mac is back: the next time, Eden on this Mac
  t.ctx.up = true;
  win.focused = false;
  assert.equal(await t.feature.toggle(), eden.LOCAL);
  assert.deepEqual(win.loaded, [eden.HOSTED, eden.LOCAL]);
});

test('new keys: never JARVIS’s own, macOS’s or a bare letter; another app’s keeps the old ones', () => {
  const t = fake();
  const keys = t.electron.globalShortcut;
  keys.register('Alt+Space', () => {}); // Talk (shell.js)
  t.ipcMain.emit('feature:eden:hotkey', t.fromWindow, { on: true });
  const tryKeys = (acc) => t.ipcMain.handlers.get('feature:eden:try')(t.fromWindow, acc);
  assert.deepEqual(tryKeys('Alt+Space'), { ok: false, error: 'same', label: '⌥ Space' });
  assert.equal(tryKeys('Command+Control+Space').error, 'reserved');
  assert.equal(tryKeys('J').error, 'modifier');
  keys.taken.add('Control+Alt+J');
  assert.equal(tryKeys('Control+Alt+J').error, 'taken');
  assert.ok(keys.mine.has('Control+Alt+Space'), 'the old keys stay');
  assert.deepEqual(tryKeys('Alt+Shift+E'), { ok: true, accelerator: 'Alt+Shift+E', label: '⌥⇧E' });
  assert.ok(keys.mine.has('Alt+Shift+E') && !keys.mine.has('Control+Alt+Space'));
  assert.deepEqual(JSON.parse(readFileSync(path.join(t.userData, 'eden-window.json'), 'utf8')), { on: true, accelerator: 'Alt+Shift+E' });
  // only the window may change it
  assert.deepEqual(t.ipcMain.handlers.get('feature:eden:try')({ sender: 'a page' }, 'Alt+Shift+K'), { ok: false, error: 'invalid' });
  t.ipcMain.emit('feature:eden:hotkey', { sender: 'a page' }, { on: false });
  assert.ok(keys.mine.has('Alt+Shift+E'));
});

test('kept for the next launch, and out of the way while Settings records a shortcut', async () => {
  const first = fake();
  first.ipcMain.emit('feature:eden:hotkey', first.fromWindow, { on: true, accelerator: 'Control+Alt+E' });
  const again = fake({ userData: first.userData });
  const keys = again.electron.globalShortcut;
  assert.ok(keys.mine.has('Control+Alt+E'), 'registered before the backend answers');
  again.ipcMain.emit('feature:shell:recording', again.fromWindow, true);
  assert.equal(keys.mine.size, 0);
  again.ipcMain.emit('feature:shell:recording', again.fromWindow, false);
  assert.ok(keys.mine.has('Control+Alt+E'));
  again.ipcMain.emit('feature:shell:recording', again.fromWindow, true);
  await new Promise((r) => setTimeout(r, 80)); // a recording that never said it ended
  assert.ok(keys.mine.has('Control+Alt+E'));
  assert.deepEqual(eden.normalize({ on: 'yes', accelerator: 'Command+Tab' }), { on: false, accelerator: eden.DEFAULT_KEYS });
});
