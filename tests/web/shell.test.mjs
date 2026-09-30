// The app shell (app/features/shell*.js): its pure logic, and install() wired to a stand-in
// Electron, with no window, menu bar or file outside a temp folder. node --test tests/web/
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

// ── a stand-in Electron and main.js context ──

function fakeElectron() {
  const made = { trays: [], images: [], notes: [] };
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
  const Menu = { buildFromTemplate: (template) => ({ template }) };
  const screen = new EventEmitter();
  screen.displays = [LAPTOP];
  screen.getAllDisplays = () => screen.displays;
  screen.getPrimaryDisplay = () => screen.displays[0];
  return { Tray, Menu, Notification, nativeImage, screen, made };
}

// A laptop's screen (the menu bar and Dock take some of it), and a big one above-right.
const LAPTOP = { bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 38, width: 1512, height: 870 }, scaleFactor: 2 };
const BIG = { bounds: { x: 1512, y: -400, width: 2560, height: 1440 }, workArea: { x: 1512, y: -375, width: 2560, height: 1415 }, scaleFactor: 1 };

function fakeContext({ dev = false, userData = mkdtempSync(path.join(tmpdir(), 'shell-test-')) } = {}) {
  const ipcMain = new EventEmitter();
  ipcMain.handlers = new Map();
  ipcMain.handle = (channel, fn) => ipcMain.handlers.set(channel, fn);
  const app = new EventEmitter();
  app.quits = 0;
  app.getPath = () => userData;
  app.quit = () => { app.quits += 1; };
  app.focus = () => {};
  app.dock = { badge: '', menu: null, setBadge(text) { this.badge = text; }, setMenu(menu) { this.menu = menu; } };
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
    delays: { save: 5, displays: 5, reload: 5 },
    send: (channel, ...args) => wc.sent.push([channel, ...args]),
    fromWindow: (event) => Boolean(event && event.sender === wc),
    summons: 0,
  };
  ctx.summon = () => { ctx.summons += 1; };
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
  assert.deepEqual(labels, ['Speaking…', '—', 'Ask…', '—', 'Unmute', 'Hands-free', 'Heads-ups paused until 3:40 PM', 'Resume heads-ups', '—', 'Open J.A.R.V.I.S.', 'Jarvis Code', '—', 'Quit J.A.R.V.I.S.']);
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
  assert.deepEqual(lib.readStore('{broken'), { version: 1, menuBar: true, places: {} });
  assert.deepEqual(lib.readStore('[1,2]'), { version: 1, menuBar: true, places: {} });
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
  await tick();
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
  assert.deepEqual(await t.hello(), { dev: false, notify: true, recovered: false });
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
  assert.deepEqual(await t.hello(), { dev: true, notify: false, recovered: false });
  t.tell('approval', card('a1'));
  t.tell('heads-up', { key: 'rain:1', kind: 'rain', title: 'Rain', text: 'Soon.' });
  assert.equal(t.electron.made.notes.length, 0);
  assert.equal(t.app.dock.menu, null);
  assert.equal(t.app.dock.badge, '');
});

test('the Dock’s menu: Ask, Mute or Unmute, Jarvis Code and the browser', async () => {
  const t = fakeContext();
  shell.install(t.ctx);
  await t.hello();
  t.report({ state: 'idle', online: true, muted: true, labels: { browser: '浏览器' } });
  const items = t.app.dock.menu.template;
  assert.deepEqual(items.map((i) => i.label || '—'), ['Ask…', 'Unmute', '—', 'Jarvis Code', '浏览器']);
  items[4].click();
  items[1].click();
  await tick();
  assert.deepEqual(t.commands(), [{ action: 'open', panel: 'browser' }, { action: 'unmute' }]);
  items[0].click();
  assert.equal(t.ctx.summons, 1);
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
  assert.deepEqual(store, { version: 1, menuBar: true, places: {} });
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
  await tick(30);
  const saved = JSON.parse(readFileSync(path.join(t.userData, 'shell.json'), 'utf8')).places[key];
  assert.deepEqual([saved.x, saved.y, saved.width, saved.height], [300, 90, 1100, 760]);
});

test('displays coming and going: each set gets its own place back, never macOS’s shuffle', async () => {
  const t = fakeContext();
  shell.install(t.ctx);
  // At the desk: the big screen arrives, and the user moves the window onto it.
  t.electron.screen.displays = [LAPTOP, BIG];
  t.electron.screen.emit('display-added');
  await tick(30);
  t.win.bounds = { x: 2000, y: -300, width: 1600, height: 1000 };
  t.win.emit('move');
  await tick(30);
  // Unplugged: macOS moves the window to the laptop by itself (not kept), and it goes back
  // to the laptop's own place (none yet: where macOS left it, fitted on the screen).
  t.electron.screen.displays = [LAPTOP];
  t.win.bounds = { x: 400, y: 200, width: 1600, height: 1000 };
  t.win.emit('move');
  t.electron.screen.emit('display-removed');
  await tick(30);
  assert.deepEqual(t.win.bounds, { x: 0, y: 38, width: 1512, height: 870 });
  const places = JSON.parse(readFileSync(path.join(t.userData, 'shell.json'), 'utf8')).places;
  assert.deepEqual(places[lib.displaySetKey([LAPTOP, BIG])].x, 2000, 'the desk’s place survived the unplugging');
  // Back at the desk: back on the big screen.
  t.electron.screen.displays = [LAPTOP, BIG];
  t.electron.screen.emit('display-added');
  await tick(30);
  assert.deepEqual(t.win.bounds, { x: 2000, y: -300, width: 1600, height: 1000 });
  // Only the visible area changed (the Dock): nothing moves.
  const placed = t.win.placed.length;
  t.electron.screen.emit('display-metrics-changed');
  await tick(30);
  assert.equal(t.win.placed.length, placed);
});

test('a window left off every screen comes back to the middle of the main one', async () => {
  const t = fakeContext();
  shell.install(t.ctx);
  t.win.bounds = { x: 5000, y: 3000, width: 1280, height: 840 };
  t.electron.screen.displays = [{ ...LAPTOP, scaleFactor: 1 }];
  t.electron.screen.emit('display-metrics-changed');
  await tick(30);
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
  await tick(30);
  assert.equal(t.wc.reloads, 1);
  assert.equal((await t.hello()).recovered, true);
  assert.equal((await t.hello()).recovered, false, 'said once');
  for (const reason of ['oom', 'killed']) { clock += 1000; t.wc.emit('render-process-gone', {}, { reason }); }
  await tick(30);
  assert.equal(t.wc.reloads, 3);
  clock += 1000;
  t.wc.emit('render-process-gone', {}, { reason: 'crashed' });
  await tick(30);
  assert.equal(t.wc.reloads, 3, 'a crash loop is not reloaded again');
  assert.equal(t.win.loaded.length, 1);
  assert.match(t.win.loaded[0][0], /loading\.html$/);
  assert.match(t.win.loaded[0][1].query.error, /stopped several times/);
  // Five minutes on, it may reload again.
  clock += 5 * 60_000;
  t.wc.emit('render-process-gone', {}, { reason: 'crashed' });
  await tick(30);
  assert.equal(t.wc.reloads, 4);
});

test('a page that ends cleanly, or while quitting, is left alone', async () => {
  const t = fakeContext();
  shell.install(t.ctx);
  t.wc.emit('render-process-gone', {}, { reason: 'clean-exit' });
  t.app.emit('before-quit');
  t.wc.emit('render-process-gone', {}, { reason: 'crashed' });
  await tick(30);
  assert.equal(t.wc.reloads, 0);
  assert.deepEqual(lib.allowReload([1, 2, 3], 4), { ok: false, times: [1, 2, 3] });
  assert.deepEqual(lib.allowReload([1, 2, 3], 4 + 5 * 60_000), { ok: true, times: [4 + 5 * 60_000] });
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
  for (const m of source.matchAll(/(?:switchRow|buttonRow|infoRow)\('[\w-]+', '((?:[^'\\]|\\.)+)', '((?:[^'\\]|\\.)+)'/g)) { found.add(m[1]); found.add(m[2]); }
  assert.ok(found.size > 10, `found ${found.size}`);
  const missing = [...found].map((s) => s.replace(/\\'/g, "'")).filter((s) => !(s in strings) && !patterns.some((re) => re.test(s)));
  assert.deepEqual(missing, []);
});
