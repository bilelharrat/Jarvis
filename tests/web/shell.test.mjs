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
  const made = { trays: [], images: [] };
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
  return { Tray, Menu, nativeImage, made };
}

function fakeContext({ dev = false, userData = mkdtempSync(path.join(tmpdir(), 'shell-test-')) } = {}) {
  const ipcMain = new EventEmitter();
  ipcMain.handlers = new Map();
  ipcMain.handle = (channel, fn) => ipcMain.handlers.set(channel, fn);
  const app = new EventEmitter();
  app.quits = 0;
  app.getPath = () => userData;
  app.quit = () => { app.quits += 1; };
  app.focus = () => {};
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
  });
  const electron = fakeElectron();
  const ctx = {
    app,
    ipcMain,
    electron,
    dev,
    logDir: userData,
    getWindow: () => win,
    send: (channel, ...args) => wc.sent.push([channel, ...args]),
    fromWindow: (event) => Boolean(event && event.sender === wc),
    summons: 0,
  };
  ctx.summon = () => { ctx.summons += 1; };
  const fromWin = { sender: wc };
  const hello = () => ipcMain.handlers.get('feature:shell:hello')(fromWin);
  const report = (state) => ipcMain.emit('feature:shell:state', fromWin, state);
  const commands = () => wc.sent.filter(([channel]) => channel === 'feature:shell:command').map(([, c]) => c);
  return { ctx, app, win, wc, electron, userData, hello, report, commands };
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
  assert.deepEqual(lib.readStore('{broken'), { version: 1, menuBar: true });
  assert.deepEqual(lib.readStore('[1,2]'), { version: 1, menuBar: true });
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
  for (const m of source.matchAll(/(?:switchRow|buttonRow|infoRow)\('[\w-]+', '((?:[^'\\]|\\.)+)', '((?:[^'\\]|\\.)+)'/g)) { found.add(m[1]); found.add(m[2]); }
  assert.ok(found.size > 10, `found ${found.size}`);
  const missing = [...found].map((s) => s.replace(/\\'/g, "'")).filter((s) => !(s in strings) && !patterns.some((re) => re.test(s)));
  assert.deepEqual(missing, []);
});
