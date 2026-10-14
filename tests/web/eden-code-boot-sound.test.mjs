// Eden Code's boot-up sound: the app's side (app/features/boot-sound.js) plays the owner's sound
// once per launch, in Eden Code only, by the system's own player (stubbed here: nothing is ever
// played), quieter under a screen reader and never when switched off; the window's side
// (web/features/boot-sound.js) is the switch in Settings › General, round-tripping through the
// bridge; and the file is in Eden Code's packages. node --test tests/web/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sound = require('../../app/features/boot-sound.js');
const web = require('../../src/jarvis/web/features/boot-sound.js');
const { FLAVORS } = require('../../app/flavor.js');
const APP = fileURLToPath(new URL('../../app/', import.meta.url));
const WEB = fileURLToPath(new URL('../../src/jarvis/web/', import.meta.url));

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `eden-boot-${name}-`));

// A player that never plays: it writes down what would have run.
function fakeSpawn() {
  const runs = [];
  const spawn = (cmd, args, opts) => {
    runs.push({ cmd, args, opts });
    return { on() { return this; }, unref() {} };
  };
  return { runs, spawn };
}

// The app around the feature: its folders, the IPC it registers, the window check, the hook.
function fakeCtx({ flavor = FLAVORS['eden-code'], a11y = false } = {}) {
  const userData = tmp('user');
  const seen = { handlers: {}, hook: null };
  const ctx = {
    flavor,
    dataDir: tmp('data'),
    app: { getPath: (k) => (k === 'userData' ? userData : tmp('temp')), accessibilitySupportEnabled: a11y },
    ipcMain: { handle: (ch, fn) => { seen.handlers[ch] = fn; } },
    fromWindow: (e) => Boolean(e && e.sender === 'window'),
    playsBootSound: (fn) => { seen.hook = fn; },
  };
  return { ctx, seen, userData };
}

test('Eden Code plays it once per launch through afplay, from a temp copy, detached', () => {
  const { runs, spawn } = fakeSpawn();
  const { ctx, seen } = fakeCtx();
  assert.ok(sound.install(ctx, { spawn }));
  assert.equal(typeof seen.hook, 'function');
  if (process.platform !== 'darwin') return; // the player chosen is the platform's
  assert.equal(seen.hook(), 'afplay');
  assert.equal(seen.hook(), ''); // the window shown again (a reload, the Dock): quiet
  assert.equal(runs.length, 1);
  const [{ cmd, args, opts }] = runs;
  assert.equal(cmd, '/usr/bin/afplay');
  assert.equal(args.length, 1);
  assert.ok(!args[0].includes('.asar') && fs.existsSync(args[0]), 'a real file outside app.asar');
  assert.deepEqual(fs.readFileSync(args[0]), fs.readFileSync(sound.SOUND));
  assert.deepEqual(opts, { stdio: 'ignore', detached: true });
});

test('only in Eden Code: Eden Secretary and Daredevil keep their own (loading.js)', () => {
  for (const id of ['jarvis', 'daredevil']) {
    const { runs, spawn } = fakeSpawn();
    const { ctx, seen } = fakeCtx({ flavor: FLAVORS[id] });
    assert.equal(sound.install(ctx, { spawn }), null, id);
    assert.equal(seen.hook, null, id);
    assert.deepEqual(seen.handlers, {}, id);
    assert.equal(runs.length, 0, id);
  }
  assert.ok(FLAVORS['eden-code'].features.has('boot-sound.js'));
  // main.js hands the window's first show to it, and still plays Eden Secretary's otherwise
  const main = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
  assert.match(main, /if \(bootSoundHook\) \{/);
  assert.match(main, /playsBootSound: \(fn\) => \{ bootSoundHook = fn; \}/);
  assert.match(main, /if \(!hidden\) \{ win\.show\(\); playBootSound\(\); \}/);
});

test('never when switched off, nor when the old boot_sound was off and no choice is made here', () => {
  const user = tmp('user');
  const { runs, spawn } = fakeSpawn();
  const off = sound.createBootSound({ userData: user, fs, spawn, platform: 'darwin', tmpDir: tmp('t') });
  assert.equal(off.set(false), false);
  assert.equal(off.play(), '');
  const data = tmp('data');
  fs.writeFileSync(path.join(data, 'prefs.json'), JSON.stringify({ boot_sound: false }));
  const old = sound.createBootSound({ userData: tmp('user'), dataDir: data, fs, spawn, platform: 'darwin', tmpDir: tmp('t') });
  assert.equal(old.on(), false);
  assert.equal(old.play(), '');
  assert.equal(runs.length, 0);
  // …and its own choice wins over the old one
  assert.equal(old.set(true), true);
  assert.equal(old.play(), 'afplay');
});

test('quieter under a screen reader (afplay -v 0.4); on Windows then not at all', () => {
  const { runs, spawn } = fakeSpawn();
  const { ctx, seen } = fakeCtx({ a11y: true });
  sound.install(ctx, { spawn });
  const mac = sound.createBootSound({ userData: tmp('u'), fs, spawn, platform: 'darwin', tmpDir: tmp('t'), a11y: () => true });
  assert.equal(mac.play(), 'afplay');
  assert.deepEqual(runs.at(-1).args.slice(0, 2), ['-v', '0.4']);
  const before = runs.length;
  const win = sound.createBootSound({ userData: tmp('u'), fs, spawn, platform: 'win32', tmpDir: tmp('t'), a11y: () => true });
  assert.equal(win.play(), '');
  assert.equal(runs.length, before);
  // the feature asks Electron (accessibilitySupportEnabled) as the window shows
  if (process.platform === 'darwin') {
    seen.hook();
    assert.deepEqual(runs.at(-1).args.slice(0, 2), ['-v', '0.4']);
  }
});

test('Windows: PowerShell, hidden, the path in the environment and never in the command; elsewhere nothing', () => {
  const { runs, spawn } = fakeSpawn();
  const tmpDir = tmp("o'brien");
  const win = sound.createBootSound({ userData: tmp('u'), fs, spawn, platform: 'win32', tmpDir });
  assert.equal(win.play(), 'powershell');
  const [{ cmd, args, opts }] = runs;
  assert.equal(cmd, 'powershell.exe');
  assert.ok(!args.join(' ').includes(tmpDir));
  assert.equal(opts.windowsHide, true);
  assert.equal(opts.env.EDEN_BOOT_SOUND, path.join(tmpDir, 'eden-code-boot-sound.wav'));
  const linux = sound.createBootSound({ userData: tmp('u'), fs, spawn, platform: 'linux', tmpDir });
  assert.equal(linux.play(), '');
  assert.equal(runs.length, 1);
  // a player that can't start says nothing
  const broken = sound.createBootSound({ userData: tmp('u'), fs, spawn: () => { throw new Error('ENOENT'); }, platform: 'darwin', tmpDir });
  assert.equal(broken.play(), '');
});

test('the setting round-trips through the window only (S32), kept in Eden Code’s own folder', async () => {
  const { spawn } = fakeSpawn();
  const { ctx, seen, userData } = fakeCtx();
  sound.install(ctx, { spawn });
  const ask = seen.handlers['feature:boot-sound'];
  assert.equal(ask({ sender: 'window' }), true); // on by default
  assert.equal(ask({ sender: 'another page' }, false), null);
  assert.equal(ask({ sender: 'window' }), true, 'a stranger changed nothing');
  assert.equal(ask({ sender: 'window' }, false), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userData, 'boot-sound.json'), 'utf8')), { on: false });
  assert.equal(ask({ sender: 'window' }, 'yes'), false, 'only true/false sets it');
  assert.equal(ask({ sender: 'window' }, true), true);
  // the window's switch, on a page as small as it needs
  const doc = fakeDocument();
  const sw = web.mount(doc, { invoke: (ch, ...args) => Promise.resolve(ask({ sender: 'window' }, ...args)).then((v) => { assert.equal(ch, 'feature:boot-sound'); return v; }) });
  assert.ok(sw);
  assert.equal(sw.attrs.role, 'switch');
  assert.equal(sw.attrs['aria-label'], 'Play the start-up sound');
  assert.equal(doc.sharedRow.hidden, true, 'one switch: Eden Secretary’s row is hidden here');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sw.attrs['aria-checked'], 'true');
  sw.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sw.attrs['aria-checked'], 'false');
  assert.equal(ask({ sender: 'window' }), false);
  sw.click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(ask({ sender: 'window' }), true);
  // not Eden Code's window, or no bridge (a browser tab): nothing changes
  assert.equal(web.mount(fakeDocument('jarvis'), { invoke: () => true }), null);
  assert.equal(web.mount(fakeDocument(), null), null);
});

test('its words have their Chinese', () => {
  const zh = JSON.parse(fs.readFileSync(path.join(WEB, 'i18n', 'boot-sound.json'), 'utf8')).strings;
  for (const text of [web.LABEL, web.NOTE]) assert.ok(zh[text] && /[一-鿿]/.test(zh[text]), text);
});

test('the sound is in Eden Code’s packages: the owner’s file, on the Mac and on Windows', () => {
  assert.deepEqual(fs.readFileSync(sound.SOUND), fs.readFileSync(path.join(APP, 'eden', 'build', 'boot-sound.wav')));
  const rel = `/${path.relative(APP, sound.SOUND)}`;
  assert.equal(rel, '/daredevil-open.wav');
  // npm run package:eden-code, and npm run dist:eden-code (the signed one)
  const pack = fs.readFileSync(path.join(APP, 'scripts', 'eden-code', 'package.js'), 'utf8');
  const dist = fs.readFileSync(path.join(APP, 'scripts', 'release', 'dist.js'), 'utf8');
  for (const src of [pack, dist]) {
    const ignore = src.match(/ignore: \[(.*)\],/)[1];
    const rules = [...ignore.matchAll(/\/(\^[^,]*?)\/(?=,|$)/g)].map((m) => new RegExp(m[1]));
    assert.ok(rules.length >= 3, ignore);
    for (const re of rules) assert.ok(!re.test(rel), `${re} would leave it out`);
    for (const re of rules) assert.ok(!re.test('/features/boot-sound.js'), `${re} would leave the feature out`);
  }
  // the package.json's own --ignore rules
  const scripts = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).scripts;
  for (const [, re] of scripts.package.matchAll(/--ignore='?([^' ]+)'?/g)) assert.ok(!new RegExp(re.replace(/\\\\/g, '\\')).test(rel), re);
  // Windows (electron-builder's files): every *.wav at the top and every feature
  const win = fs.readFileSync(path.join(APP, 'scripts', 'release', 'windows.js'), 'utf8');
  assert.match(win, /files: \[[^\]]*'\*\.wav'[^\]]*'features\/\*\*'/);
});

function fakeDocument(app = 'eden-code') {
  const byId = {};
  const make = (tag) => ({
    tag, attrs: {}, children: [], hidden: false, textContent: '', className: '', listeners: {},
    set id(v) { byId[v] = this; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    append(...kids) { for (const k of kids) { k.parentNode = this; this.children.push(k); } },
    insertBefore(k, ref) { k.parentNode = this; this.children.splice(this.children.indexOf(ref), 0, k); },
    addEventListener(ev, fn) { this.listeners[ev] = fn; },
    click() { if (this.listeners.click) this.listeners.click(); },
    closest(sel) { let n = this; while (n && !(sel === '.row' && n.className === 'row')) n = n.parentNode; return n || null; },
  });
  const general = make('section');
  const sharedRow = make('div');
  sharedRow.className = 'row';
  const shared = make('button');
  shared.id = 'sw-boot-sound';
  sharedRow.append(shared);
  general.append(sharedRow);
  return {
    sharedRow,
    body: { dataset: { app } },
    createElement: make,
    getElementById: (id) => byId[id] || null,
    querySelector: () => general,
  };
}

// Round 2, U8: ⌘, in Eden Code opened both settings sheets (the shared one, app.js's
// inEdenCode handler, and Eden Code's own, its deck's keys), and the start-up sound row was only
// in the shared one. Now ⌘, opens Eden Code's own sheet alone while its deck is up, and the
// row is in that sheet's General, above the shortcuts line.
test('⌘, in Eden Code opens one sheet: the shared one only when Eden Code’s deck is hidden', () => {
  const app = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
  const block = app.match(/\nif \(inEdenCode\) \{\n([\s\S]*?)\n\}\n/)[1];
  const listeners = [];
  const cc = { hidden: false };
  let toggled = 0;
  const run = new Function('document', '$', 'cmd', 'toggleSettings', block);
  run({ addEventListener: (type, fn) => listeners.push([type, fn]) }, (id) => (id === 'cc' ? cc : { hidden: true }), (e) => e.metaKey, () => { toggled += 1; });
  const keydown = listeners.find(([type]) => type === 'keydown')[1];
  const press = () => keydown({ metaKey: true, shiftKey: false, altKey: false, key: ',', preventDefault() {} });
  press();
  assert.equal(toggled, 0, 'the deck is up: its own sheet (openJcSettings), not this one too');
  cc.hidden = true;
  press();
  assert.equal(toggled, 1);
  // …and the deck's own keys open Eden Code's settings on ⌘,
  assert.match(app, /if \(key === ',' && !e\.shiftKey\) \{ e\.preventDefault\(\); openJcSettings\('general'\); return; \}/);
});

test('the start-up sound row is in Eden Code’s settings › General, above the shortcuts', async () => {
  const { makeDocument } = await import('./fixtures/stand-dom.mjs');
  const doc = makeDocument();
  doc.body.dataset.app = 'eden-code';
  const settings = doc.createElement('section');
  const sharedRow = doc.createElement('div');
  sharedRow.className = 'row';
  const shared = doc.createElement('button');
  shared.id = 'sw-boot-sound';
  sharedRow.append(shared);
  settings.append(sharedRow);
  const general = doc.createElement('div');
  general.id = 'jcs-general';
  const foot = doc.createElement('p');
  foot.className = 'jcs-foot';
  general.append(doc.createElement('div'), foot);
  doc.body.append(settings, general);
  const sw = web.mount(doc, { invoke: () => Promise.resolve(true) });
  assert.ok(sw && general.contains(sw), 'in #jcs-general');
  assert.equal(sw.className, 'jcs-switch');
  assert.equal(sw.getAttribute('role'), 'switch');
  assert.equal(sw.closest('.jcs-row').parentNode.className, 'jcs-group');
  const kids = [...general.children];
  assert.equal(kids.at(-1), foot, 'the shortcuts line stays last');
  assert.equal(kids.at(-3).textContent, 'When it opens');
  assert.equal(sharedRow.hidden, true, 'one switch');
  const zh = JSON.parse(fs.readFileSync(path.join(WEB, 'i18n', 'boot-sound.json'), 'utf8')).strings;
  assert.ok(zh['When it opens']);
});
