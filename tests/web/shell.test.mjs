// The app shell (app/features/shell*.js): its pure logic, and install() wired to a stand-in
// Electron, with no window, menu bar or file outside a temp folder. node --test tests/web/
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const lib = require('../../app/features/shell-lib.js');
const icon = require('../../app/features/shell-icon.js');
const shell = require('../../app/features/shell.js');
const links = require('../../app/features/shell-links.js');
const windowSide = require('../../src/jarvis/web/features/shell.js');

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
// Waits for what a timer does (the machine may be busy): up to ten seconds, then fails.
async function until(done, what = 'the condition', ms = 10_000) {
  const started = Date.now();
  while (!done()) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await tick(5);
  }
}

// ── a stand-in Electron and main.js context ──

function fakeElectron() {
  const made = { trays: [], images: [], notes: [], appMenus: [] };
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor(options) { super(); this.options = options; this.shown = false; this.closed = false; made.notes.push(this); }
    show() { this.shown = true; }
    close() { this.closed = true; }
  }
  class Tray {
    constructor(image) { this.image = image; this.destroyed = false; made.trays.push(this); }
    setImage(image) { this.image = image; }
    setToolTip(tip) { this.tip = tip; }
    setContextMenu(menu) { this.menu = menu; }
    destroy() { this.destroyed = true; }
  }
  const nativeImage = {
    createFromBuffer(buffer, options) {
      const image = {
        reps: [{ buffer, ...options }],
        template: false,
        addRepresentation(rep) { this.reps.push(rep); },
        setTemplateImage(on) { this.template = on; },
      };
      made.images.push(image);
      return image;
    },
  };
  const Menu = { buildFromTemplate: (template) => ({ template }), setApplicationMenu(menu) { made.appMenus.push(menu); } };
  // Global shortcuts: another app holds those in `taken`; what's ours is in `mine`.
  const globalShortcut = {
    taken: new Set(),
    mine: new Map(),
    register(accelerator, fn) {
      if (this.taken.has(accelerator) || this.mine.has(accelerator)) return false;
      this.mine.set(accelerator, fn);
      return true;
    },
    unregister(accelerator) { this.mine.delete(accelerator); },
    press(accelerator) { const fn = this.mine.get(accelerator); if (fn) fn(); return Boolean(fn); },
  };
  const screen = new EventEmitter();
  screen.displays = [LAPTOP];
  screen.getAllDisplays = () => screen.displays;
  screen.getPrimaryDisplay = () => screen.displays[0];
  return { Tray, Menu, Notification, globalShortcut, nativeImage, screen, made };
}

// A laptop's screen (the menu bar and Dock take some of it), and a big one above-right.
const LAPTOP = { bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 38, width: 1512, height: 870 }, scaleFactor: 2 };
const BIG = { bounds: { x: 1512, y: -400, width: 2560, height: 1440 }, workArea: { x: 1512, y: -375, width: 2560, height: 1415 }, scaleFactor: 1 };

function fakeContext({ dev = false, packaged = false, userData = mkdtempSync(path.join(tmpdir(), 'shell-test-')) } = {}) {
  const ipcMain = new EventEmitter();
  ipcMain.handlers = new Map();
  ipcMain.handle = (channel, fn) => ipcMain.handlers.set(channel, fn);
  const app = new EventEmitter();
  app.quits = 0;
  app.getPath = () => userData;
  app.quit = () => { app.quits += 1; };
  app.focus = () => {};
  app.dock = { badge: '', menu: null, setBadge(text) { this.badge = text; }, setMenu(menu) { this.menu = menu; } };
  app.isPackaged = packaged;
  app.login = { openAtLogin: false, status: 'not-registered' };
  app.getLoginItemSettings = () => ({ ...app.login });
  app.setLoginItemSettings = ({ openAtLogin }) => {
    if (app.loginFails) throw new Error('SMAppService said no');
    app.login = { openAtLogin, status: openAtLogin ? 'enabled' : 'not-registered' };
  };
  app.protocols = [];
  app.isDefaultProtocolClient = (scheme) => app.protocols.includes(scheme);
  app.setAsDefaultProtocolClient = (scheme) => { app.protocols.push(scheme); return true; };
  const wc = new EventEmitter();
  wc.sent = [];
  const win = new EventEmitter();
  Object.assign(win, {
    webContents: wc,
    shown: 0,
    isDestroyed: () => false,
    isMinimized: () => false,
    restore() {},
    show() { this.shown += 1; },
    showInactive() { this.shown += 1; },
    focus() {},
    front: false, // visible and focused
    isVisible() { return this.front; },
    isFocused() { return this.front; },
    bounds: { x: 116, y: 53, width: 1280, height: 840 },
    placed: [],
    setBounds(b) { this.bounds = { ...b }; this.placed.push({ ...b }); this.emit('move'); },
    getNormalBounds() { return { ...this.bounds }; },
    isFullScreen: () => false,
    loaded: [],
    loadFile(file, options) { this.loaded.push([file, options]); },
    hidden: 0,
    hide() { this.hidden += 1; },
  });
  wc.reloads = 0;
  wc.reload = () => { wc.reloads += 1; };
  const electron = fakeElectron();
  const ctx = {
    app,
    ipcMain,
    electron,
    dev,
    logDir: userData,
    getWindow: () => win,
    delays: { save: 5, displays: 5, reload: 5, quit: 200 },
    servicesDir: path.join(userData, 'Services'),
    ran: [],
    send: (channel, ...args) => wc.sent.push([channel, ...args]),
    fromWindow: (event) => Boolean(event && event.sender === wc),
    summons: 0,
  };
  ctx.summon = () => { ctx.summons += 1; };
  ctx.run = (file, args) => ctx.ran.push([file, ...args]);
  // main.js's hand-off of jarvis:// links (the ones from before the features loaded first).
  ctx.early = [];
  ctx.onOpenUrl = (fn) => { ctx.openLink = fn; ctx.early.splice(0).forEach((url) => fn(url)); };
  const fromWin = { sender: wc };
  const hello = () => ipcMain.handlers.get('feature:shell:hello')(fromWin);
  const report = (state) => ipcMain.emit('feature:shell:state', fromWin, state);
  const commands = () => wc.sent.filter(([channel]) => channel === 'feature:shell:command').map(([, c]) => c);
  const tell = (channel, msg) => ipcMain.emit(`feature:shell:${channel}`, fromWin, msg);
  return { ctx, app, win, wc, electron, userData, hello, report, commands, tell };
}

// ── the menu bar icon ──

function decodePng(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let at = 8;
  let width = 0;
  const idat = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString('ascii', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    assert.equal(png.readUInt32BE(at + 8 + length), icon.crc32(png.subarray(at + 4, at + 8 + length)), `${type} CRC`);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      assert.equal(data.readUInt32BE(4), width);
      assert.equal(data[8], 8);
      assert.equal(data[9], 6); // RGBA
    }
    if (type === 'IDAT') idat.push(data);
    at += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const alpha = (x, y) => raw[y * (1 + width * 4) + 1 + x * 4 + 3];
  const rgb = (x, y) => [0, 1, 2].map((c) => raw[y * (1 + width * 4) + 1 + x * 4 + c]);
  return { width, alpha, rgb };
}

test('the menu bar icon is a crisp black template image at 1× and 2×', () => {
  for (const scale of [1, 2]) {
    const img = decodePng(icon.iconPng('idle', scale));
    assert.equal(img.width, 18 * scale);
    const px = (pt) => Math.floor(pt * scale);
    assert.equal(img.alpha(px(8.5), px(8.5)), 255, 'the core is solid');
    assert.equal(img.alpha(px(4.5), px(8.5)), 0, 'clear between the core and the ring');
    assert.equal(img.alpha(px(1.5), px(8.5)), 255, 'the ring, on whole pixels at both scales');
    assert.equal(img.alpha(0, 0), 0, 'the corners are clear');
    assert.deepEqual(img.rgb(px(8.5), px(8.5)), [0, 0, 0], 'black: macOS tints a template image');
  }
});

test('each state has its own glyph; transcribing looks like thinking', () => {
  const pngs = icon.STATES.map((s) => icon.iconPng(s, 2).toString('base64'));
  assert.equal(new Set(pngs).size, 4);
  assert.equal(icon.iconPng('transcribing', 2).toString('base64'), icon.iconPng('thinking', 2).toString('base64'));
  assert.equal(icon.iconPng('???', 1).toString('base64'), icon.iconPng('idle', 1).toString('base64'));
  const listening = decodePng(icon.iconPng('listening', 2));
  assert.equal(listening.alpha(12, 17), 255, 'the lit core is bigger than the resting one');
  const idle = decodePng(icon.iconPng('idle', 2));
  assert.equal(idle.alpha(12, 17), 0);
});

// ── its menu ──

test('the menu follows the state: status line, Mute or Unmute, hands-free ticked, paused until', () => {
  const L = lib.mergeLabels({ pausedUntil: 'Heads-ups paused until 3:40 PM' });
  const acted = [];
  const act = (name) => acted.push(name);
  const on = lib.normalizeState({ state: 'speaking', online: true, muted: true, handsFree: true, pausedUntil: 10_000 });
  const menu = lib.trayTemplate(on, L, act, { now: 5_000, ask: 'Alt+Space' });
  const labels = menu.map((m) => m.label || '—');
  assert.deepEqual(labels, ['Speaking…', '—', 'Ask…', '—', 'Unmute', 'Hands-free', 'Heads-ups paused until 3:40 PM', 'Resume heads-ups', '—', 'Open J.A.R.V.I.S.', 'Eden Code', '—', 'Quit J.A.R.V.I.S.']);
  assert.equal(menu[0].enabled, false);
  assert.equal(menu[2].accelerator, 'Alt+Space');
  assert.equal(menu[2].registerAccelerator, false, 'shown, never a second registration');
  assert.equal(menu[5].type, 'checkbox');
  assert.equal(menu[5].checked, true);
  for (const item of menu) if (item.click) item.click();
  assert.deepEqual(acted, ['ask', 'unmute', 'hands-free', 'resume', 'open', 'code', 'quit']);

  // The pause over, and the connection down: Pause again, and the controls wait for it.
  const off = lib.normalizeState({ state: 'thinking', online: false, pausedUntil: 10_000 });
  const later = lib.trayTemplate(off, L, act, { now: 20_000 });
  assert.equal(later[0].label, 'Reconnecting…');
  assert.equal(later[4].label, 'Mute');
  assert.equal(later[6].label, 'Pause heads-ups for an hour');
  assert.deepEqual([later[4], later[5], later[6]].map((m) => m.enabled), [false, false, false]);
  assert.equal(later[2].accelerator, undefined);
  assert.equal(lib.statusLine(lib.normalizeState({ state: 'transcribing', online: true }), L), 'Thinking…');
});

test('the window’s labels and reports are taken only in their expected shapes', () => {
  const L = lib.mergeLabels({ mute: '静音', quit: 'x'.repeat(500), nope: 'ignored', ask: 'A\nB', open: 5 });
  assert.equal(L.mute, '静音');
  assert.equal(L.quit, 'Quit J.A.R.V.I.S.');
  assert.equal(L.ask, 'A B');
  assert.equal(L.open, 'Open J.A.R.V.I.S.');
  assert.equal('nope' in L, false);
  assert.deepEqual(lib.normalizeState({ state: 'dancing', online: 'yes', pausedUntil: 'soon', menuBar: 0 }),
    { state: 'idle', online: false, muted: false, handsFree: false, pausedUntil: 0, menuBar: true });
  assert.deepEqual(lib.normalizeState(null).state, 'idle');
  const blank = { version: 1, menuBar: true, shortcuts: { ask: 'Alt+Space', whatsThis: 'Alt+Shift+Space', stop: lib.DEFAULT_SHORTCUTS.stop }, places: {} };
  assert.deepEqual(lib.readStore('{broken'), blank);
  assert.deepEqual(lib.readStore('[1,2]'), blank);
  assert.equal(lib.readStore('{"menuBar": false}').menuBar, false);
});

// ── install(): the menu bar icon wired to the window ──

test('the icon shows the state the window reports, as a template image at both scales', async () => {
  const t = fakeContext();
  shell.install(t.ctx);
  const [tray] = t.electron.made.trays;
  assert.ok(tray, 'an icon in the menu bar');
  assert.equal(tray.image.template, true);
  assert.deepEqual(tray.image.reps.map((r) => r.scaleFactor), [1, 2]);
  assert.equal(tray.menu.template[0].label, 'Reconnecting…');
  const idleImage = tray.image;
  await t.hello();
  t.report({ state: 'listening', online: true, labels: { listening: '正在聆听…' } });
  assert.notEqual(tray.image, idleImage);
  assert.equal(tray.menu.template[0].label, '正在聆听…');
  assert.match(tray.tip, /J\.A\.R\.V\.I\.S\. · 正在聆听…/);
  // Something other than the window can't report.
  t.ctx.ipcMain.emit('feature:shell:state', { sender: {} }, { state: 'speaking', online: true });
  assert.equal(tray.menu.template[0].label, '正在聆听…');
});

test('menu commands reach the window only once its page is there; Ask and Quit need no page', async () => {
  const t = fakeContext();
  const s = shell.install(t.ctx);
  s.act('mute'); // no page yet: dropped, never replayed later
  s.act('code'); // kept for the page
  assert.deepEqual(t.commands(), []);
  assert.equal(t.win.shown, 1);
  await t.hello();
  await until(() => t.commands().length === 1, 'the kept command');
  assert.deepEqual(t.commands(), [{ action: 'open', panel: 'code' }]);
  s.act('mute');
  s.act('pause');
  assert.deepEqual(t.commands().slice(1), [{ action: 'mute' }, { action: 'pause' }]);
  s.act('ask');
  s.act('quit');
  assert.equal(t.ctx.summons, 1);
  assert.equal(t.app.quits, 1);
  // A new page (a reload): offline until it says hello again.
  t.wc.emit('did-navigate');
  assert.equal(s.state().online, false);
  s.act('unmute');
  assert.deepEqual(t.commands().slice(3), []);
});

test('turning the menu bar icon off takes it away now and at the next launch', async () => {
  const t = fakeContext();
  shell.install(t.ctx);
  await t.hello();
  t.report({ state: 'idle', online: true, menuBar: false });
  assert.equal(t.electron.made.trays[0].destroyed, true);
  assert.equal(JSON.parse(readFileSync(path.join(t.userData, 'shell.json'), 'utf8')).menuBar, false);
  const again = fakeContext({ userData: t.userData });
  shell.install(again.ctx);
  assert.equal(again.electron.made.trays.length, 0);
  // A damaged file: the icon, as by default.
  writeFileSync(path.join(t.userData, 'shell.json'), '{nope');
  const third = fakeContext({ userData: t.userData });
  shell.install(third.ctx);
  assert.equal(third.electron.made.trays.length, 1);
});

test('the test window (JARVIS_BACKEND_URL) never puts an icon in the menu bar', () => {
  const t = fakeContext({ dev: true });
  shell.install(t.ctx);
  assert.equal(t.electron.made.trays.length, 0);
});

// ── notifications and the Dock ──

const card = (id, extra = {}) => ({ id, question: 'Send this email to Ann?', detail: 'Hi Ann,\n\nThe deck is attached.', choices: [{ id: 'allow', label: 'Send' }, { id: 'deny', label: 'Don’t send' }], askKind: '', task: null, ...extra });

test('a yes-or-no card gets its own two buttons; a purchase, a plan or a question gets none', () => {
  const L = lib.mergeLabels();
  const plain = lib.approvalNotice(lib.normalizeApproval(card('a1')), L);
  assert.deepEqual(plain, { title: 'Needs your OK', body: 'Send this email to Ann?\nHi Ann, The deck is attached.', actions: ['Send', 'Don’t send'], answers: ['allow', 'deny'] });
  const unlabelled = lib.approvalNotice(lib.normalizeApproval(card('a2', { choices: [{ id: 'allow' }, { id: 'deny' }] })), L);
  assert.deepEqual(unlabelled.actions, ['Allow', 'Not now']);
  const purchase = lib.approvalNotice(lib.normalizeApproval(card('a3', { askKind: 'purchase', question: 'Buy the headphones for $99?', detail: '', choices: [{ id: 'allow', label: 'Confirm purchase' }, { id: 'deny', label: 'Cancel' }] })), L);
  assert.deepEqual(purchase.actions, []);
  assert.equal(purchase.body, 'Buy the headphones for $99?\nSay “confirm purchase”, or confirm it in J.A.R.V.I.S.');
  const plan = lib.approvalNotice(lib.normalizeApproval(card('a4', { choices: [{ id: 'plan_edits', label: 'Go' }, { id: 'plan_keep', label: 'Keep planning' }] })), L);
  assert.deepEqual(plan.actions, []);
  const shortcut = lib.approvalNotice(lib.normalizeApproval(card('a5', { choices: [{ id: 'allow', label: 'Run' }, { id: 'always', label: 'Always' }, { id: 'deny', label: 'Not now' }] })), L);
  assert.deepEqual([shortcut.actions, shortcut.answers], [['Run', 'Not now'], ['allow', 'deny']]);
  assert.equal(lib.excerpt('a  b\n c', 10), 'a b c');
  assert.equal(lib.excerpt('x'.repeat(50), 10), `${'x'.repeat(9)}…`);
  // Odd shapes from the window are refused.
  for (const bad of [null, {}, { id: 5 }, { id: 'a b' }, { id: 'x'.repeat(65) }]) assert.equal(lib.normalizeApproval(bad), null);
  assert.equal(lib.normalizeApproval({ id: 'a6', choices: 'no', task: '7' }).task, null);
  assert.deepEqual(lib.normalizeApproval({ id: 'a6', choices: [{ id: 'allow', label: 5 }, 'x'] }).choices, [{ id: 'allow', label: '' }]);
});

test('a card that goes up while the window is away: a notification whose buttons answer it', async () => {
  const t = fakeContext();
  const s = shell.install(t.ctx);
  const hi = await t.hello();
  assert.deepEqual([hi.dev, hi.notify, hi.recovered, hi.shortcuts.live], [false, true, false, true]);
  t.tell('approval', card('a1'));
  const [note] = t.electron.made.notes;
  assert.ok(note.shown);
  assert.equal(note.options.title, 'Needs your OK');
  assert.deepEqual(note.options.actions, [{ type: 'button', text: 'Send' }, { type: 'button', text: 'Don’t send' }]);
  assert.equal(note.options.silent, true);
  assert.equal(t.app.dock.badge, '1');
  note.emit('action', { actionIndex: 1 }, 1);
  assert.deepEqual(t.commands(), [{ action: 'approve', id: 'a1', choice: 'deny' }]);
  // The hub takes the card down: the badge goes.
  t.tell('approval-done', { id: 'a1' });
  assert.equal(t.app.dock.badge, '');
  assert.equal(s.approvals().size, 0);

  // A second one, answered in the window instead: its notification goes with it.
  t.tell('approval', card('a2'));
  const second = t.electron.made.notes[1];
  t.tell('approval-done', { id: 'a2' });
  assert.equal(second.closed, true);
  second.emit('action', { actionIndex: 0 }); // too late: nothing is sent
  assert.equal(t.commands().length, 1);
});

test('a click on a card’s notification opens JARVIS on it; a purchase has no buttons', async () => {
  const t = fakeContext();
  shell.install(t.ctx);
  await t.hello();
  t.tell('approval', card('p1', { askKind: 'purchase', choices: [{ id: 'allow', label: 'Confirm purchase' }, { id: 'deny', label: 'Cancel' }] }));
  const [note] = t.electron.made.notes;
  assert.deepEqual(note.options.actions, []);
  note.emit('click');
  assert.equal(t.win.shown, 1);
  assert.deepEqual(t.commands(), [{ action: 'reveal', what: 'approval', id: 'p1', task: null }]);
  t.tell('approval', card('c1', { task: 7 }));
  t.electron.made.notes[1].emit('click');
  assert.deepEqual(t.commands()[1], { action: 'reveal', what: 'approval', id: 'c1', task: 7 });
});

test('no notification while the window is in front, for a card seen before, or from elsewhere', async () => {
  const t = fakeContext();
  shell.install(t.ctx);
  await t.hello();
  t.win.front = true;
  t.tell('approval', card('a1'));
  assert.equal(t.electron.made.notes.length, 0);
  assert.equal(t.app.dock.badge, '1'); // still counted
  t.win.front = false;
  t.tell('approval', card('a2'));
  t.tell('approval', card('a2'));
  assert.equal(t.electron.made.notes.length, 1);
  t.ctx.ipcMain.emit('feature:shell:approval', { sender: {} }, card('a3'));
  t.tell('approval', { id: 'bad id' });
  assert.equal(t.app.dock.badge, '2');
  // The window reconnects: what the hub says is waiting replaces the list.
  t.tell('approvals', { items: [card('a9')] });
  assert.equal(t.app.dock.badge, '1');
  assert.equal(t.electron.made.notes[0].closed, true, 'a2 is gone, and its notification');
});

test('a heads-up raised for the window opens JARVIS on its card when clicked', async () => {
  const t = fakeContext();
  shell.install(t.ctx);
  await t.hello();
  t.tell('heads-up', { key: 'rain:1', kind: 'rain', title: 'Rain', text: 'Rain in an hour.' });
  t.tell('heads-up', { key: 'x', kind: 'x', title: '', text: '' }); // nothing to say: nothing raised
  const [note] = t.electron.made.notes;
  assert.equal(t.electron.made.notes.length, 1);
  assert.deepEqual([note.options.title, note.options.body, note.options.silent], ['Rain', 'Rain in an hour.', true]);
  note.emit('click');
  assert.equal(t.win.shown, 1);
  assert.deepEqual(t.commands(), [{ action: 'reveal', what: 'alert', key: 'rain:1', kind: 'rain', title: 'Rain', text: 'Rain in an hour.' }]);
});

test('the test window raises no notifications and leaves the Dock alone', async () => {
  const t = fakeContext({ dev: true });
  shell.install(t.ctx);
  const hi = await t.hello();
  assert.deepEqual([hi.dev, hi.notify, hi.recovered, hi.shortcuts.live], [true, false, false, false]);
  t.tell('approval', card('a1'));
  t.tell('heads-up', { key: 'rain:1', kind: 'rain', title: 'Rain', text: 'Soon.' });
  assert.equal(t.electron.made.notes.length, 0);
  assert.equal(t.app.dock.menu, null);
  assert.equal(t.app.dock.badge, '');
});

test('the Dock’s menu: Ask, Mute or Unmute, Eden Code and the browser', async () => {
  const t = fakeContext();
  shell.install(t.ctx);
  await t.hello();
  t.report({ state: 'idle', online: true, muted: true, labels: { browser: '浏览器' } });
  const items = t.app.dock.menu.template;
  assert.deepEqual(items.map((i) => i.label || '—'), ['Ask…', 'Unmute', '—', 'Eden Code', '浏览器']);
  items[4].click();
  items[1].click();
  await until(() => t.commands().length === 2, 'both commands');
  assert.deepEqual(t.commands(), [{ action: 'open', panel: 'browser' }, { action: 'unmute' }]);
  items[0].click();
  assert.equal(t.ctx.summons, 1);
});

// ── global shortcuts ──

test('a shortcut needs ⌃ or ⌥ (or ⌘ with another), is spelled one way, and never macOS’s own', () => {
  const ok = (a) => lib.checkAccelerator(a);
  assert.deepEqual(ok('Alt+Space'), { ok: true, accelerator: 'Alt+Space' });
  assert.deepEqual(ok('Shift+Alt+Space'), { ok: true, accelerator: 'Alt+Shift+Space' });
  assert.deepEqual(ok('Shift+Command+J'), { ok: true, accelerator: 'Command+Shift+J' });
  assert.deepEqual(ok('F13'), { ok: true, accelerator: 'F13' }, 'a function key alone is fine');
  assert.deepEqual(ok('Command+J'), { ok: false, error: 'modifier' }, '⌘J would take the key from every app');
  assert.deepEqual(ok('Shift+K'), { ok: false, error: 'modifier' });
  assert.deepEqual(ok('K'), { ok: false, error: 'modifier' });
  assert.deepEqual(ok('Control+Space'), { ok: false, error: 'reserved' });
  assert.deepEqual(ok('Command+Shift+4'), { ok: false, error: 'reserved' });
  for (const bad of ['', 'Alt+', 'Alt+Alt+J', 'Hyper+J', 'Alt+Escape', 'Alt+Enter', 5, null, `Alt+${'J'.repeat(70)}`]) {
    assert.equal(ok(bad).ok, false, String(bad));
  }
  assert.equal(lib.shortcutLabel('Alt+Space', 'darwin'), '⌥ Space');
  assert.equal(lib.shortcutLabel('Alt+Shift+Space', 'darwin'), '⌥⇧ Space');
  assert.equal(lib.shortcutLabel('Command+Control+Alt+Shift+J', 'darwin'), '⌃⌥⇧⌘J');
  assert.equal(lib.shortcutLabel('Control+Alt+Return', 'darwin'), '⌃⌥↩');
  assert.equal(lib.shortcutLabel('Command+Shift+F5', 'darwin'), '⇧⌘ F5');
  assert.equal(lib.shortcutLabel('', 'darwin'), '');
  // On a PC the same keys are written as the keyboard has them, which is what a screen reader says.
  assert.equal(lib.shortcutLabel('Control+Alt+J', 'win32'), 'Ctrl+Alt+J');
  assert.equal(lib.shortcutLabel('Alt+Shift+Space', 'win32'), 'Alt+Shift+Space');
  assert.equal(lib.shortcutLabel('Control+Alt+Return', 'win32'), 'Ctrl+Alt+Enter');
  assert.equal(lib.shortcutLabel('Command+Shift+F5', 'win32'), 'Shift+Win+F5');
  assert.equal(lib.shortcutLabel('Control+Alt+PageDown', 'win32'), 'Ctrl+Alt+Page Down');
  assert.equal(lib.shortcutLabel('', 'win32'), '');
  const stop = lib.DEFAULT_SHORTCUTS.stop;
  assert.deepEqual(lib.normalizeShortcuts({ ask: 'Command+J', whatsThis: 'Control+Alt+W' }), { ask: 'Alt+Space', whatsThis: 'Control+Alt+W', stop });
  assert.deepEqual(lib.normalizeShortcuts({ ask: 'Alt+Shift+Space' }), { ask: 'Alt+Shift+Space', whatsThis: 'Alt+Space', stop }, 'never one combination for both');
  // Stop talking never shares a key either: one that would is the default, or the next free one.
  assert.deepEqual(lib.normalizeShortcuts({ stop: 'Alt+Space' }), { ask: 'Alt+Space', whatsThis: 'Alt+Shift+Space', stop });
  assert.equal(lib.normalizeShortcuts({ ask: stop, stop }).stop, 'Control+Alt+F12');
  assert.deepEqual(lib.normalizeShortcuts(null), lib.DEFAULT_SHORTCUTS);
});

test('Settings reads a shortcut by where the keys are, whatever ⌥ makes them type', () => {
  const press = (code, mods = {}) => windowSide.acceleratorFromKey({ code, ...mods });
  assert.equal(press('KeyJ', { altKey: true, metaKey: true }), 'Command+Alt+J');
  assert.equal(press('Space', { altKey: true, shiftKey: true }), 'Alt+Shift+Space');
  assert.equal(press('Digit5', { ctrlKey: true, altKey: true }), 'Control+Alt+5');
  assert.equal(press('F13'), 'F13');
  assert.equal(press('Enter', { altKey: true }), 'Alt+Return');
  assert.equal(press('BracketLeft', { ctrlKey: true, altKey: true }), 'Control+Alt+[');
  assert.equal(press('AltLeft', { altKey: true }), '', 'only a modifier so far');
  assert.equal(press('Escape', { altKey: true }), '');
  assert.equal(press('MediaPlayPause'), '');
  assert.equal(windowSide.heldLabel({ metaKey: true, shiftKey: true, ctrlKey: true, altKey: true }), '⌃⌥⇧⌘');
  assert.equal(windowSide.heldLabel({ metaKey: false, shiftKey: true, ctrlKey: true, altKey: true }, true), 'Ctrl+Alt+Shift+');
  // What Settings reads is what the app checks.
  assert.deepEqual(lib.checkAccelerator(press('KeyJ', { altKey: true, metaKey: true })), { ok: true, accelerator: 'Command+Alt+J' });
});

test('the shortcuts are the app’s from launch; main.js leaves its own to them', () => {
  const t = fakeContext();
  shell.install(t.ctx);
  const keys = t.electron.globalShortcut;
  assert.equal(t.ctx.ownsShortcuts, true);
  assert.deepEqual([...keys.mine.keys()], ['Alt+Space', 'Alt+Shift+Space', lib.DEFAULT_SHORTCUTS.stop]);
  keys.press('Alt+Space');
  assert.equal(t.ctx.summons, 1);
  keys.press('Alt+Shift+Space');
  assert.deepEqual(t.wc.sent.at(-1), ['jarvis:whats-this']);
  // The test window takes none (and main.js, seeing it didn't, takes none either there).
  const dev = fakeContext({ dev: true });
  shell.install(dev.ctx);
  assert.equal(dev.ctx.ownsShortcuts, undefined);
  assert.equal(dev.electron.globalShortcut.mine.size, 0);
});

test('a new shortcut from Settings is tried at once; a taken one leaves the old one working', async () => {
  const t = fakeContext();
  const s = shell.install(t.ctx);
  const keys = t.electron.globalShortcut;
  await t.hello();
  const tryIt = (which, accelerator) => t.ctx.ipcMain.handlers.get('feature:shell:shortcut')({ sender: t.wc }, { which, accelerator });
  keys.taken.add('Command+Alt+J');
  assert.deepEqual(tryIt('ask', 'Command+Alt+J'), { ok: false, error: 'taken', label: '⌥⌘J' });
  assert.ok(keys.mine.has('Alt+Space'), 'the old one still works');
  assert.deepEqual(tryIt('ask', 'Command+J'), { ok: false, error: 'modifier', label: '⌘J' });
  assert.deepEqual(tryIt('ask', 'Alt+Shift+Space'), { ok: false, error: 'same', label: '⌥⇧ Space' });
  assert.deepEqual(tryIt('nope', 'Control+Alt+K'), { ok: false, error: 'invalid' });
  assert.deepEqual(tryIt('ask', 'Control+Alt+K'), { ok: true, accelerator: 'Control+Alt+K', label: '⌃⌥K' });
  assert.deepEqual([...keys.mine.keys()].sort(), ['Alt+Shift+Space', 'Control+Alt+K', lib.DEFAULT_SHORTCUTS.stop].sort());
  assert.deepEqual(tryIt('stop', 'Control+Alt+K'), { ok: false, error: 'same', label: '⌃⌥K' }, 'Stop talking needs a key of its own');
  const pushed = t.wc.sent.filter(([c]) => c === 'feature:shell:shortcuts').at(-1)[1];
  assert.equal(pushed.ask.label, '⌃⌥K');
  assert.equal(JSON.parse(readFileSync(path.join(t.userData, 'shell.json'), 'utf8')).shortcuts.ask, 'Control+Alt+K');
  assert.equal(t.electron.made.trays[0].menu.template[2].accelerator, 'Control+Alt+K', 'the menu bar’s Ask… shows it');
  // A report still carrying the old setting (the new one's on its way to the backend)
  // doesn't undo it: only a change in the settings does.
  t.report({ state: 'idle', online: true, shortcuts: { ask: 'Alt+Space', whatsThis: 'Alt+Shift+Space' } });
  t.report({ state: 'thinking', online: true, shortcuts: { ask: 'Alt+Space', whatsThis: 'Alt+Shift+Space' } });
  assert.ok(keys.mine.has('Alt+Space') && !keys.mine.has('Control+Alt+K'), 'the first report is the settings’ word');
  t.report({ state: 'idle', online: true, shortcuts: { ask: 'Control+Alt+K', whatsThis: 'Alt+Shift+Space' } });
  assert.ok(keys.mine.has('Control+Alt+K') && !keys.mine.has('Alt+Space'));
  t.report({ state: 'speaking', online: true, shortcuts: { ask: 'Control+Alt+K', whatsThis: 'Alt+Shift+Space' } });
  assert.ok(keys.mine.has('Control+Alt+K'));
  assert.equal(s.state().state, 'speaking');
});

test('one another app holds at launch is said in Settings; recording steps ours aside', async () => {
  const t = fakeContext();
  t.electron.globalShortcut.taken.add('Alt+Space');
  shell.install(t.ctx);
  const keys = t.electron.globalShortcut;
  const hi = await t.hello();
  assert.deepEqual(hi.shortcuts.ask, { accelerator: 'Alt+Space', label: '⌥ Space', error: 'taken', wanted: '' });
  assert.equal(hi.shortcuts.whatsThis.error, '');
  t.tell('recording', true);
  assert.equal(keys.mine.size, 0, 'the keys reach the window while it records');
  t.tell('recording', false);
  assert.ok(keys.mine.has('Alt+Shift+Space'));
  // A page that goes away mid-recording gives them back.
  t.tell('recording', true);
  t.wc.emit('did-navigate');
  assert.ok(keys.mine.has('Alt+Shift+Space'));
  t.ctx.ipcMain.emit('feature:shell:recording', { sender: {} }, true); // only the window can
  assert.ok(keys.mine.has('Alt+Shift+Space'));
});

test('on a PC, when the Talk key’s default is in use the next free one stands in, and is the one said', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'shell-test-'));
  writeFileSync(path.join(userData, 'shell.json'), JSON.stringify({ shortcuts: { ask: 'Control+Alt+J', whatsThis: 'Alt+Shift+Space' } }));
  const t = fakeContext({ userData });
  t.ctx.platform = 'win32';
  t.electron.globalShortcut.taken.add('Control+Alt+J');
  shell.install(t.ctx);
  const keys = t.electron.globalShortcut;
  assert.deepEqual([...keys.mine.keys()].sort(), ['Alt+Shift+Space', 'Control+Alt+K', lib.DEFAULT_SHORTCUTS.stop].sort());
  const hi = await t.hello();
  assert.deepEqual(hi.shortcuts.ask, { accelerator: 'Control+Alt+K', label: 'Ctrl+Alt+K', error: '', wanted: 'Ctrl+Alt+J' });
  keys.press('Control+Alt+K');
  assert.equal(t.ctx.summons, 1, 'the stand-in does what the key would');
  // Taking the stand-in back out (recording) lets go of the stand-in, not the key that is in use.
  t.tell('recording', true);
  assert.equal(keys.mine.size, 0);
  t.tell('recording', false);
  assert.ok(keys.mine.has('Control+Alt+K'));
  // What the others have is never taken: the first free one after the default is used.
  const busy = fakeContext({ userData });
  busy.ctx.platform = 'win32';
  busy.electron.globalShortcut.taken.add('Control+Alt+J');
  busy.electron.globalShortcut.taken.add('Control+Alt+K');
  shell.install(busy.ctx);
  assert.ok(busy.electron.globalShortcut.mine.has('Control+Alt+H'));
});

test('on a PC a key the person chose is never swapped for another: it is said to be taken', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'shell-test-'));
  writeFileSync(path.join(userData, 'shell.json'), JSON.stringify({ shortcuts: { ask: 'Control+Alt+L', whatsThis: 'Alt+Shift+Space' } }));
  const t = fakeContext({ userData });
  t.ctx.platform = 'win32';
  t.electron.globalShortcut.taken.add('Control+Alt+L');
  shell.install(t.ctx);
  const hi = await t.hello();
  assert.deepEqual(hi.shortcuts.ask, { accelerator: 'Control+Alt+L', label: 'Ctrl+Alt+L', error: 'taken', wanted: '' });
  assert.deepEqual([...t.electron.globalShortcut.mine.keys()], ['Alt+Shift+Space', lib.DEFAULT_SHORTCUTS.stop]);
});

// ── the window's place, for each set of displays ──

test('a set of displays is known by each one’s size, place and scale, in any order', () => {
  assert.equal(lib.displaySetKey([BIG, LAPTOP]), lib.displaySetKey([LAPTOP, BIG]));
  assert.notEqual(lib.displaySetKey([LAPTOP]), lib.displaySetKey([LAPTOP, BIG]));
  assert.notEqual(lib.displaySetKey([LAPTOP]), lib.displaySetKey([{ ...LAPTOP, scaleFactor: 1 }]));
  assert.equal(lib.displaySetKey([LAPTOP, { bounds: null }, null]), lib.displaySetKey([LAPTOP]));
  assert.equal(lib.displaySetKey('nope'), '');
});

test('a remembered place is put back on its screen, fitted to what that screen shows', () => {
  const both = [LAPTOP, BIG];
  // Where it was: as it was.
  assert.deepEqual(lib.placeWindow({ x: 2000, y: -300, width: 1600, height: 1000 }, both), { x: 2000, y: -300, width: 1600, height: 1000 });
  // Too big for the screen now, and partly off it: fitted and moved onto it.
  assert.deepEqual(lib.placeWindow({ x: 100, y: 800, width: 1800, height: 1200 }, [LAPTOP]), { x: 0, y: 38, width: 1512, height: 870 });
  assert.deepEqual(lib.placeWindow({ x: 1300, y: 500, width: 900, height: 700 }, [LAPTOP]), { x: 612, y: 208, width: 900, height: 700 });
  // Never smaller than the window's minimum (unless the screen is).
  assert.deepEqual(lib.placeWindow({ x: 10, y: 60, width: 300, height: 200 }, [LAPTOP]), { x: 10, y: 60, width: 760, height: 620 });
  // Its title bar is on no screen (the big one is gone), or barely: nowhere to put it back.
  assert.equal(lib.placeWindow({ x: 2000, y: -300, width: 1600, height: 1000 }, [LAPTOP]), null);
  assert.equal(lib.placeWindow({ x: 1500, y: 100, width: 800, height: 600 }, [LAPTOP]), null);
  assert.equal(lib.placeWindow({ x: 'a', y: 0, width: 800, height: 600 }, [LAPTOP]), null);
  assert.equal(lib.placeWindow({ x: 0, y: 0, width: 800, height: 600 }, []), null);
  assert.deepEqual(lib.centerOn(LAPTOP.workArea, { width: 1280, height: 840 }), { x: 116, y: 53, width: 1280, height: 840 });
  assert.deepEqual(lib.centerOn(LAPTOP.workArea, { width: 3000, height: 2000 }), LAPTOP.workArea);
});

test('the places kept: the most recent sets of displays, read back safely', () => {
  let store = lib.readStore('');
  assert.deepEqual(store.places, {});
  for (let i = 0; i < 15; i++) store = lib.rememberPlace(store, `set${i}`, { x: i + 0.4, y: 50, width: 900, height: 700 }, 1000 + i);
  assert.equal(Object.keys(store.places).length, 12);
  assert.ok(!('set0' in store.places) && 'set14' in store.places);
  assert.deepEqual(store.places.set14, { x: 14, y: 50, width: 900, height: 700, at: 1014 });
  assert.equal(lib.rememberPlace(store, '', { x: 0, y: 0, width: 1, height: 1 }, 1), store);
  const back = lib.readStore(JSON.stringify({ ...store, places: { ...store.places, bad: { x: 'no' }, worse: 7 } }));
  assert.deepEqual(Object.keys(back.places).sort(), Object.keys(store.places).sort());
  assert.deepEqual(lib.readStore('{"places": [1, 2]}').places, {});
});

test('the window opens where it was on these displays, and keeps where the user puts it', async () => {
  const t = fakeContext();
  const key = lib.displaySetKey([LAPTOP]);
  writeFileSync(path.join(t.userData, 'shell.json'), JSON.stringify({ places: { [key]: { x: 40, y: 60, width: 1000, height: 700, at: 1 } } }));
  shell.install(t.ctx);
  assert.deepEqual(t.win.bounds, { x: 40, y: 60, width: 1000, height: 700 });
  t.win.bounds = { x: 300, y: 90, width: 1100, height: 760 };
  t.win.emit('move');
  t.win.emit('resize');
  const kept = () => { try { return JSON.parse(readFileSync(path.join(t.userData, 'shell.json'), 'utf8')).places[key]; } catch { return {}; } };
  await until(() => kept().x === 300, 'the new place kept');
  const saved = kept();
  assert.deepEqual([saved.x, saved.y, saved.width, saved.height], [300, 90, 1100, 760]);
});

test('displays coming and going: each set gets its own place back, never macOS’s shuffle', async () => {
  const t = fakeContext();
  shell.install(t.ctx);
  const places = () => { try { return JSON.parse(readFileSync(path.join(t.userData, 'shell.json'), 'utf8')).places; } catch { return {}; } };
  const desk = lib.displaySetKey([LAPTOP, BIG]);
  // At the desk: the big screen arrives, and the user moves the window onto it.
  t.electron.screen.displays = [LAPTOP, BIG];
  t.electron.screen.emit('display-added');
  await until(() => t.win.placed.length === 1, 'the window placed for the new displays');
  t.win.bounds = { x: 2000, y: -300, width: 1600, height: 1000 };
  t.win.emit('move');
  await until(() => (places()[desk] || {}).x === 2000, 'the desk’s place kept');
  // Unplugged: macOS moves the window to the laptop by itself (not kept), and it goes back
  // to the laptop's own place (none yet: where macOS left it, fitted on the screen).
  t.electron.screen.displays = [LAPTOP];
  t.win.bounds = { x: 400, y: 200, width: 1600, height: 1000 };
  t.win.emit('move');
  t.electron.screen.emit('display-removed');
  await until(() => t.win.bounds.x === 0, 'the window fitted on the laptop');
  assert.deepEqual(t.win.bounds, { x: 0, y: 38, width: 1512, height: 870 });
  assert.deepEqual(places()[desk].x, 2000, 'the desk’s place survived the unplugging');
  // Back at the desk: back on the big screen.
  t.electron.screen.displays = [LAPTOP, BIG];
  t.electron.screen.emit('display-added');
  await until(() => t.win.bounds.x === 2000, 'the window back on the big screen');
  assert.deepEqual(t.win.bounds, { x: 2000, y: -300, width: 1600, height: 1000 });
  // Only the visible area changed (the Dock): nothing moves.
  const placed = t.win.placed.length;
  t.electron.screen.emit('display-metrics-changed');
  await tick(60);
  assert.equal(t.win.placed.length, placed);
});

test('a window left off every screen comes back to the middle of the main one', async () => {
  const t = fakeContext();
  shell.install(t.ctx);
  t.win.bounds = { x: 5000, y: 3000, width: 1280, height: 840 };
  t.electron.screen.displays = [{ ...LAPTOP, scaleFactor: 1 }];
  t.electron.screen.emit('display-metrics-changed');
  await until(() => t.win.bounds.x === 116, 'the window back in the middle');
  assert.deepEqual(t.win.bounds, { x: 116, y: 53, width: 1280, height: 840 });
});

test('the test window isn’t moved or remembered', async () => {
  const t = fakeContext({ dev: true });
  writeFileSync(path.join(t.userData, 'shell.json'), JSON.stringify({ places: { [lib.displaySetKey([LAPTOP])]: { x: 40, y: 60, width: 1000, height: 700, at: 1 } } }));
  shell.install(t.ctx);
  assert.equal(t.win.placed.length, 0);
});

// ── a crashed page ──

test('a crashed page is reloaded, says so once, and at most three times in five minutes', async () => {
  let clock = 1_000_000;
  const t = fakeContext();
  t.ctx.now = () => clock;
  shell.install(t.ctx);
  assert.equal((await t.hello()).recovered, false);
  t.wc.emit('render-process-gone', {}, { reason: 'crashed' });
  await until(() => t.wc.reloads === 1, 'the reload');
  assert.equal((await t.hello()).recovered, true);
  assert.equal((await t.hello()).recovered, false, 'said once');
  for (const reason of ['oom', 'killed']) { clock += 1000; t.wc.emit('render-process-gone', {}, { reason }); }
  await until(() => t.wc.reloads === 3, 'three reloads');
  clock += 1000;
  t.wc.emit('render-process-gone', {}, { reason: 'crashed' });
  await tick(60);
  assert.equal(t.wc.reloads, 3, 'a crash loop is not reloaded again');
  assert.equal(t.win.loaded.length, 1);
  assert.match(t.win.loaded[0][0], /loading\.html$/);
  assert.match(t.win.loaded[0][1].query.error, /stopped several times/);
  // Five minutes on, it may reload again.
  clock += 5 * 60_000;
  t.wc.emit('render-process-gone', {}, { reason: 'crashed' });
  await until(() => t.wc.reloads === 4, 'a reload five minutes on');
});

test('a page that ends cleanly, or while quitting, is left alone', async () => {
  const t = fakeContext();
  shell.install(t.ctx);
  t.wc.emit('render-process-gone', {}, { reason: 'clean-exit' });
  t.app.emit('before-quit');
  t.wc.emit('render-process-gone', {}, { reason: 'crashed' });
  await tick(60);
  assert.equal(t.wc.reloads, 0);
  assert.deepEqual(lib.allowAgain([1, 2, 3], 4), { ok: false, times: [1, 2, 3] });
  assert.deepEqual(lib.allowAgain([1, 2, 3], 4 + 5 * 60_000), { ok: true, times: [4 + 5 * 60_000] });
});

// ── jarvis:// links ──

test('a link shows JARVIS and fills in the request box, opens a panel or a project; never more', async () => {
  const t = fakeContext();
  t.ctx.early.push('jarvis://ask?text=Summarize%20this%20page'); // it launched the app
  shell.install(t.ctx);
  assert.equal(t.win.shown, 1);
  assert.deepEqual(t.commands(), [], 'kept until the page is there');
  await t.hello();
  await until(() => t.commands().length === 1, 'the early link');
  assert.deepEqual(t.commands(), [{ action: 'prefill', text: 'Summarize this page' }]);
  t.ctx.openLink('jarvis://open?panel=settings');
  t.ctx.openLink('jarvis://code?project=alpha');
  t.ctx.openLink('jarvis://open'); // just JARVIS
  t.ctx.openLink('jarvis://send?to=someone'); // not one JARVIS opens: nothing at all
  assert.deepEqual(t.commands().slice(1), [{ action: 'open', panel: 'settings' }, { action: 'project', name: 'alpha' }]);
  assert.equal(t.win.shown, 4);
});

test('"Ask JARVIS" from the Services menu (this Mac’s key) is marked to send; any other link only fills in', async () => {
  const t = fakeContext({ packaged: true });
  shell.install(t.ctx);
  await t.hello();
  t.ctx.ipcMain.handlers.get('feature:shell:service')({ sender: t.wc }, { action: 'add' });
  const key = readFileSync(path.join(t.userData, 'service-key'), 'utf8');
  t.ctx.openLink(`jarvis://ask?key=${key}&text=What%20is%20this`);
  t.ctx.openLink('jarvis://ask?key=0123456789abcdef0123456789abcdef&text=forged'); // a web page guessing
  t.ctx.openLink('jarvis://ask?text=from%20a%20page');
  assert.deepEqual(t.commands(), [
    { action: 'prefill', text: 'What is this', service: true },
    { action: 'prefill', text: 'forged' },
    { action: 'prefill', text: 'from a page' },
  ]);
});

test('a Quick Action written before it had a key is rewritten with this Mac’s, once', () => {
  const t = fakeContext({ packaged: true });
  const bundle = path.join(t.ctx.servicesDir, 'Ask JARVIS.workflow');
  for (const [rel, text] of Object.entries(links.serviceFiles())) {
    mkdirSync(path.dirname(path.join(bundle, rel)), { recursive: true });
    writeFileSync(path.join(bundle, rel), text);
  }
  shell.install(t.ctx);
  const key = readFileSync(path.join(t.userData, 'service-key'), 'utf8');
  assert.ok(readFileSync(path.join(bundle, 'Contents/document.wflow'), 'utf8').includes(`key=${key}`));
  assert.equal(t.ctx.ran.length, 1);
  const again = fakeContext({ packaged: true, userData: t.userData });
  again.ctx.servicesDir = t.ctx.servicesDir;
  shell.install(again.ctx);
  assert.equal(again.ctx.ran.length, 0, 'already current: left alone');
});

test('links coming too fast are dropped, five every ten seconds at most', async () => {
  let clock = 5_000_000;
  const t = fakeContext();
  t.ctx.now = () => clock;
  shell.install(t.ctx);
  await t.hello();
  for (let i = 0; i < 8; i++) t.ctx.openLink(`jarvis://ask?text=${i}`);
  assert.deepEqual(t.commands().map((c) => c.text), ['0', '1', '2', '3', '4']);
  clock += 10_001;
  t.ctx.openLink('jarvis://ask?text=later');
  assert.equal(t.commands().at(-1).text, 'later');
});

test('only the installed app becomes the jarvis:// app', () => {
  const dev = fakeContext({ dev: true, packaged: true });
  shell.install(dev.ctx);
  const fromSource = fakeContext();
  shell.install(fromSource.ctx);
  assert.deepEqual([dev.app.protocols, fromSource.app.protocols], [[], []]);
  const installed = fakeContext({ packaged: true });
  shell.install(installed.ctx);
  assert.deepEqual(installed.app.protocols, ['jarvis']);
});

// ── the Services menu's "Ask JARVIS" ──

test('Add writes the Quick Action (its golden copy) and refreshes the Services menu; Remove takes it away', async () => {
  const t = fakeContext({ packaged: true });
  shell.install(t.ctx);
  const service = (action) => t.ctx.ipcMain.handlers.get('feature:shell:service')({ sender: t.wc }, { action });
  assert.deepEqual(service('status'), { available: true, installed: false, taken: false, error: '' });
  assert.deepEqual(service('add'), { available: true, installed: true, taken: false, error: '' });
  const bundle = path.join(t.ctx.servicesDir, 'Ask JARVIS.workflow');
  const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
  assert.equal(readFileSync(path.join(bundle, 'Contents/Info.plist'), 'utf8'), readFileSync(path.join(fixtures, 'ask-jarvis.Info.plist'), 'utf8'));
  const key = readFileSync(path.join(t.userData, 'service-key'), 'utf8');
  assert.match(key, /^[0-9a-f]{32}$/, 'this Mac’s own key');
  assert.equal((statSync(path.join(t.userData, 'service-key')).mode & 0o777), 0o600);
  const written = readFileSync(path.join(bundle, 'Contents/document.wflow'), 'utf8');
  assert.ok(written.includes(`jarvis://ask?key=${key}&amp;text=`), 'the Quick Action carries it');
  assert.equal(written.replace(`key=${key}&amp;`, ''), readFileSync(path.join(fixtures, 'ask-jarvis.document.wflow'), 'utf8'));
  assert.deepEqual(t.ctx.ran, [['/System/Library/CoreServices/pbs', '-update']]);
  assert.deepEqual(service('add').installed, true, 'again: rewritten, still one');
  assert.deepEqual(service('remove'), { available: true, installed: false, taken: false, error: '' });
  assert.equal(existsSync(bundle), false);
  assert.equal(t.ctx.ipcMain.handlers.get('feature:shell:service')({ sender: {} }, { action: 'add' }), null, 'only the window can');
});

test('a Quick Action of the owner’s own with the same name is never touched', () => {
  const t = fakeContext({ packaged: true });
  const theirs = path.join(t.ctx.servicesDir, 'Ask JARVIS.workflow', 'Contents');
  mkdirSync(theirs, { recursive: true });
  writeFileSync(path.join(theirs, 'Info.plist'), '<plist><dict><key>CFBundleIdentifier</key><string>com.them</string></dict></plist>');
  shell.install(t.ctx);
  const service = (action) => t.ctx.ipcMain.handlers.get('feature:shell:service')({ sender: t.wc }, { action });
  assert.deepEqual(service('add'), { available: true, installed: false, taken: true, error: 'taken' });
  service('remove');
  assert.match(readFileSync(path.join(theirs, 'Info.plist'), 'utf8'), /com\.them/);
  assert.deepEqual(t.ctx.ran, []);
});

test('the test window and a build from source never write a Quick Action', () => {
  for (const t of [fakeContext({ dev: true, packaged: true }), fakeContext()]) {
    shell.install(t.ctx);
    const got = t.ctx.ipcMain.handlers.get('feature:shell:service')({ sender: t.wc }, { action: 'add' });
    assert.deepEqual(got, { available: false, installed: false, taken: false, error: '' });
    assert.equal(existsSync(t.ctx.servicesDir), false);
  }
});

// ── the app's menu bar ──

test('the app’s first menu has JARVIS’s places; Edit is the standard one', () => {
  const acted = [];
  const menu = lib.appMenuTemplate(lib.mergeLabels(), (name) => acted.push(name), 'darwin');
  assert.deepEqual(menu.map((m) => m.label), ['J.A.R.V.I.S.', 'Edit', 'View', 'Window']);
  const first = menu[0].submenu.filter((i) => i.type !== 'separator');
  assert.deepEqual(first.map((i) => i.label), ['About J.A.R.V.I.S.', 'Settings…', 'Eden Code', 'Browser', 'History', 'Bookmarks', 'Services', 'Hide J.A.R.V.I.S.', 'Hide Others', 'Show All', 'Quit J.A.R.V.I.S.']);
  assert.deepEqual(first.filter((i) => i.accelerator).map((i) => [i.label, i.accelerator]), [
    ['Settings…', 'Command+,'], ['Eden Code', 'Shift+Command+J'], ['Browser', 'Shift+Command+B'], ['History', 'Command+Y'], ['Bookmarks', 'Alt+Command+B'],
  ]);
  for (const item of first) if (item.click) item.click();
  assert.deepEqual(acted, ['settings', 'code', 'browser', 'history', 'bookmarks']);
  assert.deepEqual(first.filter((i) => i.role).map((i) => i.role), ['about', 'services', 'hide', 'hideOthers', 'unhide', 'quit']);
  const edit = menu[1].submenu.filter((i) => i.role).map((i) => i.role);
  for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll']) assert.ok(edit.includes(role), role);
  assert.equal(menu[3].role, 'window');
  // Nothing on it says what the app is built with.
  assert.doesNotMatch(JSON.stringify(menu), /electron/i);
});

test('the menu bar is set at launch, again in the window’s language, and its items reach the window', async () => {
  const t = fakeContext();
  shell.install(t.ctx);
  assert.equal(t.electron.made.appMenus.length, 1);
  await t.hello();
  t.report({ state: 'idle', online: true, labels: { edit: '编辑', history: '历史记录' } });
  t.report({ state: 'thinking', online: true, labels: { edit: '编辑', history: '历史记录' } });
  assert.equal(t.electron.made.appMenus.length, 2, 'rebuilt once for the new words, not for every state');
  const [first, edit] = t.electron.made.appMenus[1].template;
  assert.equal(edit.label, '编辑');
  first.submenu.find((i) => i.label === '历史记录').click();
  first.submenu.find((i) => i.label === 'Settings…').click();
  first.submenu.find((i) => i.label === 'Bookmarks').click();
  assert.deepEqual(t.commands(), [{ action: 'library', kind: 'history' }, { action: 'open', panel: 'settings' }, { action: 'library', kind: 'bookmarks' }]);
  assert.equal(t.win.shown, 3);
});

// ── opening at login ──

test('open at login: the installed app’s setting in macOS’s Login Items; elsewhere not offered', () => {
  const login = (t, req) => t.ctx.ipcMain.handlers.get('feature:shell:login')({ sender: t.wc }, req);
  const fromSource = fakeContext();
  shell.install(fromSource.ctx);
  assert.deepEqual(login(fromSource, { on: true }), { available: false, on: false, status: '', error: '' });
  assert.equal(fromSource.app.login.openAtLogin, false);
  const t = fakeContext({ packaged: true });
  shell.install(t.ctx);
  assert.deepEqual(login(t, {}), { available: true, on: false, status: 'not-registered', error: '' });
  assert.deepEqual(login(t, { on: true }), { available: true, on: true, status: 'enabled', error: '' });
  assert.deepEqual(login(t, { on: 'yes' }), { available: true, on: true, status: 'enabled', error: '' }, 'only a true or false changes it');
  t.app.loginFails = true;
  assert.equal(login(t, { on: false }).error, 'failed');
  assert.equal(t.ctx.ipcMain.handlers.get('feature:shell:login')({ sender: {} }, { on: false }), null);
});

// ── quitting ──

function fakeBackend() {
  const proc = new EventEmitter();
  Object.assign(proc, { exitCode: null, signalCode: null, killed: false, signals: [] });
  proc.kill = (signal) => { proc.killed = true; proc.signals.push(signal); return true; };
  return proc;
}
const quitEvent = () => ({ prevented: false, preventDefault() { this.prevented = true; } });

test('quitting waits for the backend to stop, out of sight, so opening again finds its data free', async () => {
  const t = fakeContext();
  const proc = fakeBackend();
  proc.kill('SIGTERM'); // main.js's own before-quit asked first
  t.ctx.backend = () => proc;
  shell.install(t.ctx);
  const first = quitEvent();
  t.app.emit('before-quit', first);
  assert.equal(first.prevented, true);
  assert.equal(t.win.hidden, 1);
  assert.equal(t.electron.made.trays[0].destroyed, true);
  assert.deepEqual(proc.signals, ['SIGTERM'], 'asked once, not twice');
  const again = quitEvent(); // ⌘Q pressed again meanwhile
  t.app.emit('before-quit', again);
  assert.equal(again.prevented, true);
  assert.equal(t.app.quits, 0);
  // The page, still up behind the scenes, reports once more: the icon stays gone.
  t.report({ state: 'idle', online: false });
  assert.equal(t.electron.made.trays.length, 1);
  proc.exitCode = 0;
  proc.emit('exit', 0);
  assert.equal(t.app.quits, 1);
  const last = quitEvent();
  t.app.emit('before-quit', last);
  assert.equal(last.prevented, false, 'the quit that follows goes through');
  await tick(250);
  assert.equal(t.app.quits, 1, 'and the timer is off');
});

test('a backend that takes too long is left to finish; nothing to wait for quits at once', async () => {
  const slow = fakeContext();
  const proc = fakeBackend();
  slow.ctx.backend = () => proc;
  shell.install(slow.ctx);
  slow.app.emit('before-quit', quitEvent());
  assert.deepEqual(proc.signals, ['SIGTERM']);
  await until(() => slow.app.quits === 1, 'the quit after the wait');
  const cases = [
    ['no backend', () => null, {}],
    ['already gone', () => Object.assign(fakeBackend(), { exitCode: 1 }), {}],
    ['stopped by a signal', () => Object.assign(fakeBackend(), { signalCode: 'SIGKILL' }), {}],
    ['the test window', () => fakeBackend(), { dev: true }],
  ];
  for (const [what, backend, options] of cases) {
    const t = fakeContext(options);
    t.ctx.backend = backend;
    shell.install(t.ctx);
    const event = quitEvent();
    t.app.emit('before-quit', event);
    assert.equal(event.prevented, false, what);
  }
});

// ── the window's words have their Chinese ──

test('every string the window side shows has a Chinese entry', () => {
  const source = readFileSync(path.join(ROOT, 'src/jarvis/web/features/shell.js'), 'utf8');
  const zh = JSON.parse(readFileSync(path.join(ROOT, 'src/jarvis/web/i18n-zh.json'), 'utf8'));
  const mine = JSON.parse(readFileSync(path.join(ROOT, 'src/jarvis/web/i18n/shell.json'), 'utf8'));
  const strings = { ...zh.strings, ...mine.strings };
  const patterns = [...zh.patterns, ...mine.patterns].map(([re]) => new RegExp(re));
  const found = new Set();
  // t('…') and F.t('…'), F.el(tag, cls, '…'), and the rows' titles and notes.
  for (const m of source.matchAll(/\bt\('((?:[^'\\]|\\.)+)'\)/g)) found.add(m[1]);
  for (const m of source.matchAll(/\bt\(`((?:[^`\\]|\\.)+)`\)/g)) found.add(m[1].replace(/\$\{[^}]+\}/g, '3:40 PM'));
  for (const m of source.matchAll(/F\.el\('[\w-]+', '[^']*', '((?:[^'\\]|\\.)+)'\)/g)) found.add(m[1]);
  for (const m of source.matchAll(/notice\('[^']*', '[^']*', '((?:[^'\\]|\\.)+)'/g)) found.add(m[1]);
  for (const m of source.matchAll(/\ben\('((?:[^'\\]|\\.)+)'\)/g)) found.add(m[1]);
  for (const m of source.matchAll(/\ben\(`((?:[^`\\]|\\.)+)`\)/g)) found.add(m[1].replace(/\$\{[^}]+\}/g, '⌥ Space'));
  for (const m of source.matchAll(/\w+Row\('[\w-]+', '((?:[^'\\]|\\.)+)', '((?:[^'\\]|\\.)+)'/g)) { found.add(m[1]); found.add(m[2]); }
  assert.ok(found.size > 10, `found ${found.size}`);
  const missing = [...found].map((s) => s.replace(/\\'/g, "'")).filter((s) => !(s in strings) && !patterns.some((re) => re.test(s)));
  assert.deepEqual(missing, []);
});

test('on Windows the menu has no reload or developer-tools key, and a Help item for the screen-reader keys', () => {
  const acted = [];
  const menu = lib.appMenuTemplate(lib.mergeLabels(), (name) => acted.push(name), 'win32');
  const walk = (items) => items.flatMap((i) => [i, ...(i.submenu ? walk(i.submenu) : [])]);
  const all = walk(menu);
  assert.deepEqual(all.filter((i) => ['reload', 'forceReload', 'toggleDevTools'].includes(i.role)), []);
  assert.deepEqual(all.filter((i) => ['services', 'hide', 'hideOthers', 'front', 'startSpeaking'].includes(i.role)), []);
  assert.ok(all.some((i) => i.role === 'zoomIn') && all.some((i) => i.role === 'zoomOut') && all.some((i) => i.role === 'resetZoom'));
  const help = all.find((i) => /screen-reader/i.test(i.label || ''));
  help.click();
  assert.deepEqual(acted, ['a11y-help']);
  all.find((i) => i.accelerator === 'Ctrl+,').click();
  assert.deepEqual(acted, ['a11y-help', 'settings']);
});

test('a PC talks on Ctrl+Alt+J (J: the key a finger finds by touch) and keeps Windows’ own keys', () => {
  // Stop talking: Ctrl+Alt+Backspace, which Windows, NVDA, JAWS and Narrator leave alone; ⌘⌥. on a Mac (VoiceOver has ⌃⌥).
  assert.deepEqual(lib.defaultsFor('win32'), { ask: 'Control+Alt+J', whatsThis: 'Alt+Shift+Space', stop: 'Control+Alt+Backspace' });
  assert.deepEqual(lib.defaultsFor('darwin'), { ask: 'Alt+Space', whatsThis: 'Alt+Shift+Space', stop: 'Command+Alt+.' });
  assert.ok(!lib.WINDOWS_RESERVED.includes('Control+Alt+Backspace'));
  assert.deepEqual(lib.checkAccelerator('Control+Alt+Backspace'), { ok: true, accelerator: 'Control+Alt+Backspace' });
  assert.equal(lib.shortcutLabel('Control+Alt+Backspace', 'win32'), 'Ctrl+Alt+Backspace');
  for (const keys of ['Alt+Space', 'Alt+Tab', 'Alt+F4', 'Control+Shift+Escape', 'Control+Alt+Delete']) assert.ok(lib.WINDOWS_RESERVED.includes(keys), keys);
  assert.ok(!lib.WINDOWS_RESERVED.includes('Control+Alt+J'));
  assert.equal(lib.shortcutLabel('Control+Alt+J', 'darwin'), '⌃⌥J');
  assert.deepEqual(lib.checkAccelerator('Control+Alt+J'), { ok: true, accelerator: 'Control+Alt+J' });
});

test('on a PC the first run puts it in the sign-in list, hidden, once; Settings keeps what is chosen after', () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'shell-login-'));
  const calls = [];
  const made = () => {
    const t = fakeContext({ packaged: true, userData });
    t.ctx.platform = 'win32';
    const set = t.app.setLoginItemSettings;
    t.app.setLoginItemSettings = (options) => { calls.push(options); set(options); };
    return t;
  };
  const login = (t, req) => t.ctx.ipcMain.handlers.get('feature:shell:login')({ sender: t.wc }, req);
  let t = made();
  shell.install(t.ctx);
  assert.deepEqual(calls, [{ openAtLogin: true, args: ['--hidden'] }]);
  assert.ok(existsSync(path.join(userData, 'login-item-set')));
  assert.equal(login(t, {}).on, true);
  login(t, { on: false });
  assert.deepEqual(calls[1], { openAtLogin: false, args: ['--hidden'] }, 'the sign-in start is always the hidden one');
  t = made();
  shell.install(t.ctx);  // the next start: it was asked once, and what Settings says stays
  assert.equal(calls.length, 2);
  // a Mac keeps its own way: no first-run entry, no arguments
  const mac = fakeContext({ packaged: true });
  mac.ctx.platform = 'darwin';
  const macCalls = [];
  const original = mac.app.setLoginItemSettings;
  mac.app.setLoginItemSettings = (options) => { macCalls.push(options); original(options); };
  shell.install(mac.ctx);
  assert.deepEqual(macCalls, []);
  mac.ctx.ipcMain.handlers.get('feature:shell:login')({ sender: mac.wc }, { on: true });
  assert.deepEqual(macCalls, [{ openAtLogin: true }]);
  // the unpackaged app and a test window never touch it
  const dev = fakeContext({ packaged: false });
  dev.ctx.platform = 'win32';
  const devCalls = [];
  dev.app.setLoginItemSettings = (options) => devCalls.push(options);
  shell.install(dev.ctx);
  assert.deepEqual(devCalls, []);
});

test('the arguments of a sign-in start and the first-run rule belong to Windows only', () => {
  assert.deepEqual(lib.loginArgs('win32'), ['--hidden']);
  assert.deepEqual(lib.loginArgs('darwin'), []);
  assert.equal(lib.loginOnFirstRun('win32'), true);
  assert.equal(lib.loginOnFirstRun('darwin'), false);
});

test('the Stop talking key works from any program: the window is told to stop, and never brought forward', async () => {
  const t = fakeContext();
  shell.install(t.ctx);
  const keys = t.electron.globalShortcut;
  const stop = lib.DEFAULT_SHORTCUTS.stop;
  keys.press(stop); // (no window yet: nothing to stop, and nothing kept for later)
  await t.hello();
  await new Promise((r) => setTimeout(r, 5));
  const before = t.wc.sent.length;
  keys.press(stop);
  assert.deepEqual(t.wc.sent.slice(before), [['feature:shell:command', { action: 'stop' }]]);
  assert.equal(t.ctx.summons || 0, 0, 'it did not bring the window forward');
  const hi = await t.hello();
  assert.equal(hi.shortcuts.stop.accelerator, stop);
});

test('with JAWS installed, Talk steps aside from Ctrl+Alt+J (JAWS starts itself with it)', () => {
  const lib = require('../../app/features/shell-lib.js');
  const env = { ProgramFiles: 'C:\\Program Files' };
  assert.equal(lib.jawsInstalled(env, (p) => p === 'C:\\Program Files\\Freedom Scientific\\JAWS'), true);
  assert.equal(lib.jawsInstalled(env, () => false), false);
  assert.equal(lib.jawsInstalled({}, () => true), false);
});
