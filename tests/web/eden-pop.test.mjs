// Eden's pop-up in any app (app/features/eden-pop.js) with a stand-in Electron and a stand-in
// backend: on by default with ⌃⌥E, the selection grabbed before the pop-up shows, the answer
// streamed to the pop-up only, Replace through the backend into the original app, Services text
// as the selection, and Talk's quick look before Eden's window comes forward. The page's light
// Markdown (app/eden-pop-page.js) is data here, never HTML. node --test tests/web/
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const pop = require('../../app/features/eden-pop.js');
const page = require('../../app/eden-pop-page.js');

const NOTES = { app: 'Notes', bundle: 'com.apple.Notes', pid: 412, title: 'Groceries', text: 'Buy oat milk', source: 'ax', ax: true, secure: false, own: false, a11y_mode: 'auto', zh: null };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
// Waits for what's expected (a loaded machine runs timers late), up to two seconds.
async function until(ok, what) {
  for (let i = 0; i < 400; i += 1) { if (ok()) return; await tick(5); }
  assert.fail(`timed out waiting for ${what}`);
}

function fake({ userData = mkdtempSync(path.join(tmpdir(), 'eden-pop-')), flavor = { id: 'jarvis' }, grab = NOTES } = {}) {
  const log = []; // what happened, in order
  const globalShortcut = {
    taken: new Set(),
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
      this.size = [options.width, options.height];
      this.at = [0, 0];
      this.sent = [];
      this.webContents = new EventEmitter();
      this.webContents.send = (channel, payload) => this.sent.push([channel, payload]);
      this.webContents.setWindowOpenHandler = (fn) => { this.openHandler = fn; };
      windows.push(this);
    }
    loadFile(file) { this.file = file; setTimeout(() => this.webContents.emit('did-finish-load'), 0); return Promise.resolve(); }
    setAlwaysOnTop(on, level) { this.level = level; }
    setVisibleOnAllWorkspaces() {}
    isDestroyed() { return false; }
    isVisible() { return this.visible; }
    isFocused() { return this.focused; }
    getSize() { return this.size; }
    setSize(w, h) { this.size = [w, h]; }
    getPosition() { return this.at; }
    setPosition(x, y) { this.at = [x, y]; }
    show() { this.visible = true; log.push('show'); }
    focus() { this.focused = true; }
    hide() { this.visible = false; this.focused = false; log.push('hide'); }
  }
  const clip = [];
  const electron = {
    BrowserWindow, globalShortcut, windows,
    clipboard: { writeText: (text) => clip.push(text) },
    nativeTheme: { shouldUseDarkColors: false },
    screen: {
      getCursorScreenPoint: () => ({ x: 1400, y: 850 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 38, width: 1512, height: 870 } }),
    },
  };
  const calls = [];
  const backend = {
    grab,
    put: { ok: true, pasted: true },
    peekMs: 0,
    chunks: ['Buy ', 'oat milk, please.'],
    async post(pathName, body) {
      calls.push([pathName, body]);
      log.push(pathName);
      if (pathName.endsWith('/grab')) return { status: 200, ...this.grab };
      if (pathName.endsWith('/put')) return { status: 200, ...this.put };
      if (pathName.endsWith('/peek')) { await tick(this.peekMs); return { status: 200, ok: true }; }
      return { status: 200, ok: true };
    },
    stream(pathName, body, onLine) {
      calls.push([pathName, body]);
      let stopped = false;
      const done = (async () => {
        for (const t of this.chunks) { await tick(1); if (stopped) return; onLine({ t }); }
        onLine({ done: true });
      })();
      return { done, abort: () => { stopped = true; } };
    },
  };
  const ipcMain = new EventEmitter();
  ipcMain.handlers = new Map();
  ipcMain.handle = (channel, fn) => ipcMain.handlers.set(channel, fn);
  const sent = [];
  const fromWindow = { sender: 'window' };
  const main = { shown: 0, isDestroyed: () => false, show() { this.shown += 1; }, focus() {} };
  const ctx = {
    electron, ipcMain, dev: false, flavor,
    app: { getPath: () => userData, focus() {}, isAccessibilitySupportEnabled: () => false },
    send: (channel, payload) => sent.push([channel, payload]),
    fromWindow: (event) => event === fromWindow,
    getWindow: () => main,
    summon: () => log.push('summon'),
    popBackend: backend,
    popAsideMs: 40,
  };
  const feature = pop.install(ctx);
  const win = () => windows[0];
  const fromPop = () => ({ sender: win().webContents });
  return { ctx, electron, ipcMain, sent, fromWindow, userData, feature, backend, calls, log, clip, main, win, fromPop };
}

test('on by default with ⌃⌥E: the selection is grabbed first, then the pop-up shows by the pointer', async () => {
  const t = fake();
  const keys = t.electron.globalShortcut;
  assert.deepEqual([...keys.mine.keys()], ['Control+Alt+E']);
  assert.deepEqual(pop.normalize({}), { on: true, accelerator: 'Control+Alt+E', copy: true });
  keys.press('Control+Alt+E');
  await until(() => t.log.includes('show'), 'the pop-up');
  assert.deepEqual(t.log, ['/f/eden_pop/grab', 'show'], 'grab before the window shows');
  assert.deepEqual(t.calls[0], ['/f/eden_pop/grab', { clipboard: true }]);
  const win = t.win();
  assert.equal(win.options.type, 'panel');
  assert.equal(win.options.frame, false);
  assert.equal(win.options.alwaysOnTop, true);
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.match(win.options.webPreferences.preload, /eden-pop-preload\.js$/);
  assert.match(win.file, /eden-pop\.html$/);
  assert.ok(win.visible && win.focused);
  const [channel, state] = win.sent.find(([c]) => c === 'eden-pop:open');
  assert.equal(channel, 'eden-pop:open');
  assert.equal(state.text, 'Buy oat milk');
  assert.equal(state.canPut, true);
  assert.equal(state.keys, '⌃⌥E');
  // kept on screen: the pointer is near the bottom right, so it goes above and to the left
  const [x, y] = win.at;
  assert.ok(x + 420 <= 1512 && y + 300 <= 38 + 870 && y < 850);
  assert.deepEqual(win.openHandler({ url: 'https://example.com' }), { action: 'deny' });
  let stopped = false;
  win.webContents.emit('will-navigate', { preventDefault: () => { stopped = true; } }, 'https://example.com');
  assert.ok(stopped, 'the pop-up never navigates');
  // pressed again while it's in front: it closes; clicking away closes it too
  keys.press('Control+Alt+E');
  assert.equal(win.visible, false);
  keys.press('Control+Alt+E');
  await until(() => win.visible, 'the pop-up again');
  win.emit('blur');
  assert.equal(win.visible, false);
});

test('the answer streams to the pop-up only; Replace pastes through the backend into the original app', async () => {
  const t = fake();
  await t.feature.press();
  const win = t.win();
  t.ipcMain.emit('eden-pop:ask', { sender: 'someone else' }, { id: 'x', action: 'fix' });
  t.ipcMain.emit('eden-pop:ask', t.fromPop(), { id: 'a1', action: 'fix', text: 'Buy oat milk', app: 'Notes', history: [] });
  await until(() => win.sent.some(([c]) => c === 'eden-pop:end'), 'the answer');
  const said = win.sent.filter(([c]) => c === 'eden-pop:chunk' || c === 'eden-pop:end').map(([, p]) => p);
  assert.deepEqual(said, [{ id: 'a1', t: 'Buy ' }, { id: 'a1', t: 'oat milk, please.' }, { id: 'a1' }]);
  assert.equal(t.calls.filter(([p]) => p === '/f/eden_pop/answer').length, 1, 'only the pop-up may ask');
  const put = t.ipcMain.handlers.get('eden-pop:put');
  assert.deepEqual(await put({ sender: 'someone else' }, 'x'), { ok: false });
  assert.deepEqual(await put(t.fromPop(), 'Buy oat milk, please.'), { ok: true, pasted: true });
  assert.deepEqual(t.calls.at(-1), ['/f/eden_pop/put', { text: 'Buy oat milk, please.', pid: 412, bundle: 'com.apple.Notes' }]);
  assert.equal(t.log.lastIndexOf('hide') < t.log.lastIndexOf('/f/eden_pop/put'), true, 'the pop-up goes before the paste');
  assert.equal(win.visible, false);
  // without Accessibility the backend copies instead: the pop-up comes back to say so
  t.backend.put = { ok: false, pasted: false, copied: true, reason: 'accessibility' };
  const done = await put(t.fromPop(), 'Hello');
  assert.deepEqual(done, { ok: false, copied: true, reason: 'accessibility' });
  assert.equal(win.visible, true);
  // Copy, Read aloud and Continue in Eden
  assert.equal(await t.ipcMain.handlers.get('eden-pop:copy')(t.fromPop(), 'copied'), true);
  assert.deepEqual(t.clip, ['copied']);
  assert.equal(await t.ipcMain.handlers.get('eden-pop:speak')(t.fromPop(), 'Hi'), true);
  assert.equal(await t.ipcMain.handlers.get('eden-pop:continue')(t.fromPop(), { action: 'fix', text: 'x', answer: 'y' }), true);
  assert.equal(t.main.shown, 1);
  assert.equal(win.visible, false);
});

test('nothing to put back into: Eden itself in front, or no app; the text is copied', async () => {
  const t = fake({ grab: { ...NOTES, text: '', own: true, app: 'Eden', pid: 99 } });
  await t.feature.press();
  const [, state] = t.win().sent.find(([c]) => c === 'eden-pop:open');
  assert.equal(state.canPut, false);
  assert.deepEqual(await t.ipcMain.handlers.get('eden-pop:put')(t.fromPop(), 'Dear Sam'), { ok: false, copied: true, reason: 'no_app' });
  assert.deepEqual(t.clip, ['Dear Sam']);
  assert.ok(!t.calls.some(([p]) => p === '/f/eden_pop/put'));
});

test('Services: its text is the selection, read without the copy trick', async () => {
  const t = fake();
  assert.equal(await t.ctx.edenPopService('What is this'), true);
  assert.deepEqual(t.calls[0], ['/f/eden_pop/grab', { clipboard: false }]);
  const [, state] = t.win().sent.find(([c]) => c === 'eden-pop:open');
  assert.equal(state.text, 'What is this');
  assert.equal(state.service, true);
  t.ipcMain.emit('feature:pop:setting', t.fromWindow, { on: false });
  assert.equal(await t.ctx.edenPopService('again'), false, 'off: the window takes it, as before');
});

test('Talk looks at the selection before Eden’s window comes forward, and never waits long', async () => {
  const t = fake();
  t.ctx.summon();
  await until(() => t.log.includes('summon'), 'Talk');
  assert.deepEqual(t.log, ['/f/eden_pop/peek', 'summon']);
  t.log.length = 0;
  t.backend.peekMs = 900; // a slow backend: Talk opens anyway
  t.ctx.summon();
  await until(() => t.log.includes('summon'), 'Talk without its look');
  assert.deepEqual(t.log, ['/f/eden_pop/peek', 'summon']);
  await tick(1000);
  assert.equal(t.log.filter((x) => x === 'summon').length, 1, 'once');
  t.log.length = 0;
  t.ipcMain.emit('feature:pop:setting', t.fromWindow, { on: false });
  t.ctx.summon();
  assert.deepEqual(t.log, ['summon'], 'switched off: no look at all');
});

test('keys: never Eden’s own or macOS’s, kept for next time, off for Eden Code and while Settings records', async () => {
  const t = fake();
  const keys = t.electron.globalShortcut;
  keys.register('Alt+Space', () => {}); // Talk (shell.js)
  const tryKeys = (acc) => t.ipcMain.handlers.get('feature:pop:try')(t.fromWindow, acc);
  assert.deepEqual(tryKeys('Alt+Space'), { ok: false, error: 'same', label: '⌥ Space' });
  assert.equal(tryKeys('Command+Control+Space').error, 'reserved');
  keys.taken.add('Control+Alt+R');
  assert.equal(tryKeys('Control+Alt+R').error, 'taken');
  assert.deepEqual(tryKeys('Control+Alt+W'), { ok: true, accelerator: 'Control+Alt+W', label: '⌃⌥W' });
  assert.ok(keys.mine.has('Control+Alt+W') && !keys.mine.has('Control+Alt+E'));
  assert.deepEqual(JSON.parse(readFileSync(path.join(t.userData, 'eden-pop.json'), 'utf8')), { on: true, accelerator: 'Control+Alt+W', copy: true });
  assert.deepEqual(t.ipcMain.handlers.get('feature:pop:try')({ sender: 'a page' }, 'Alt+Shift+K'), { ok: false, error: 'invalid' });
  t.ipcMain.emit('feature:shell:recording', t.fromWindow, true);
  assert.ok(!keys.mine.has('Control+Alt+W'));
  t.ipcMain.emit('feature:shell:recording', t.fromWindow, false);
  assert.ok(keys.mine.has('Control+Alt+W'));
  const again = fake({ userData: t.userData });
  assert.ok(again.electron.globalShortcut.mine.has('Control+Alt+W'), 'registered before the backend answers');
  // the copy-trick switch reaches the grab
  again.ipcMain.emit('feature:pop:setting', again.fromWindow, { on: true, accelerator: 'Control+Alt+W', copy: false });
  await again.feature.press();
  assert.deepEqual(again.calls[0], ['/f/eden_pop/grab', { clipboard: false }]);
  // a key taken by another app: said in Settings
  const busy = fake({ userData: mkdtempSync(path.join(tmpdir(), 'eden-pop-')) });
  busy.electron.globalShortcut.mine.clear();
  busy.electron.globalShortcut.taken.add('Control+Alt+E');
  busy.ipcMain.emit('feature:pop:setting', busy.fromWindow, { on: false });
  busy.ipcMain.emit('feature:pop:setting', busy.fromWindow, { on: true });
  assert.equal(busy.sent.at(-1)[1].error, 'taken');
  const code = fake({ flavor: { id: 'eden-code' } });
  assert.equal(code.electron.globalShortcut.mine.size, 0, 'Eden Code takes no global shortcuts');
});

test('placement and screen-reader mode', () => {
  const area = { x: 0, y: 38, width: 1512, height: 870 };
  assert.deepEqual(pop.placeNear({ x: 200, y: 200 }, { width: 420, height: 300 }, area), { x: 176, y: 218 });
  assert.deepEqual(pop.placeNear({ x: 5, y: 880 }, { width: 420, height: 300 }, area), { x: 8, y: 568 });
  assert.equal(pop.readerMode('on', false, 'jarvis'), true);
  assert.equal(pop.readerMode('off', true, 'daredevil'), false);
  assert.equal(pop.readerMode('auto', true, 'jarvis'), true);
  assert.equal(pop.readerMode('auto', false, 'daredevil'), true);
  assert.equal(pop.readerMode('auto', false, 'jarvis'), false);
});

test('the page’s light Markdown is data: paragraphs, lists, code, bold; never HTML', () => {
  const md = 'Hello **world** and `x<y`\n\n- one\n- *two*\n\n1. first\n2. second\n\n```\n<script>alert(1)</script>\n```\n<img src=x onerror=alert(1)>';
  const b = page.blocks(md);
  assert.deepEqual(b.map((x) => x.type), ['p', 'ul', 'ol', 'pre', 'p']);
  assert.deepEqual(page.inline(b[0].text), [{ t: 'text', s: 'Hello ' }, { t: 'b', s: 'world' }, { t: 'text', s: ' and ' }, { t: 'code', s: 'x<y' }]);
  assert.deepEqual(b[1].items, ['one', '*two*']);
  assert.equal(b[3].code, '<script>alert(1)</script>');
  assert.equal(b[4].text, '<img src=x onerror=alert(1)>', 'kept as text, for textContent');
  assert.equal(page.plain('**Bold** and `code`\n## Head'), 'Bold and code\nHead');
  const source = readFileSync(new URL('../../app/eden-pop-page.js', import.meta.url), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML/.test(source), 'no HTML from strings anywhere in the page');
});
