// Updates on Windows (app/win-update.js, and its wiring in app/features/updates.js): latest.json
// read strictly, only this flavor's newer installer offered, nothing downloaded or run before the
// owner's Install now, the download checked against the size said, then the installer started
// silently and the app quit. The network, the disk and the process are stand-ins: nothing leaves
// this machine. node --test tests/web/
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const win = require('../../app/win-update.js');
const updates = require('../../app/features/updates.js');

const LATEST = JSON.stringify({
  'ask-eden': { version: '0.1.0', size: 110809211, file: 'Ask-Eden-Setup-0.1.0-x64.exe' },
  jarvis: { version: '0.1.13', size: 303723280, file: 'J-A-R-V-I-S--Setup-0.1.13-x64.exe' },
  daredevil: { version: '0.1.14', size: 4096, file: 'J-A-R-V-I-S-Daredevil-Setup-0.1.14-x64.exe' },
});

function rig({ version = '0.1.12', flavor = 'daredevil', latest = LATEST, got = 4096, failDownload = false, failRun = false } = {}) {
  const seen = { fetched: [], downloads: [], runs: [], told: [], states: [], quit: 0 };
  const u = win.createWinUpdater({
    version,
    flavor,
    name: flavor === 'daredevil' ? 'J.A.R.V.I.S. Daredevil' : 'J.A.R.V.I.S.',
    fetchText: async (url) => { seen.fetched.push(url); if (latest instanceof Error) throw latest; return latest; },
    download: async (url, target, opts) => {
      seen.downloads.push({ url, target, size: opts.size, allowed: opts.allowed });
      if (failDownload) throw new Error('reset');
      opts.progress(got / 2);
      opts.progress(got);
      return got;
    },
    runInstaller: async (file, args) => { seen.runs.push([file, args]); if (failRun) throw new Error('blocked'); },
    downloadsDir: () => 'C:\\Users\\prof\\Downloads',
    onChange: (s) => seen.states.push(s.state),
    tell: (text) => seen.told.push(text),
    quit: () => { seen.quit += 1; },
  });
  return { u, seen };
}

// ── latest.json ──

test('latest.json is read strictly: this flavor, a version, an installer’s name and a size', () => {
  assert.deepEqual(win.entryFor(LATEST, 'daredevil'), { version: '0.1.14', size: 4096, file: 'J-A-R-V-I-S-Daredevil-Setup-0.1.14-x64.exe' });
  const bad = (entry) => JSON.stringify({ jarvis: entry });
  assert.throws(() => win.entryFor('<html>', 'jarvis'), /isn't JSON/);
  assert.throws(() => win.entryFor('{}', 'jarvis'), /has no jarvis/);
  assert.throws(() => win.entryFor(bad({ version: 'latest', size: 1, file: 'a-x64.exe' }), 'jarvis'), /version/);
  assert.throws(() => win.entryFor(bad({ version: '0.2.0', size: 1, file: '../evil-x64.exe' }), 'jarvis'), /file/);
  assert.throws(() => win.entryFor(bad({ version: '0.2.0', size: 1, file: 'run.bat' }), 'jarvis'), /file/);
  assert.throws(() => win.entryFor(bad({ version: '0.2.0', size: -5, file: 'J-x64.exe' }), 'jarvis'), /size/);
});

test('the download may come only from askeden.com and GitHub, over https', () => {
  assert.ok(win.allowedUrl('https://askeden.com/daredevil/windows'));
  assert.ok(win.allowedUrl('https://objects.githubusercontent.com/github-production-release-asset/x'));
  assert.ok(win.allowedUrl('https://release-assets.githubusercontent.com/x'));
  assert.ok(!win.allowedUrl('http://askeden.com/daredevil/windows'));
  assert.ok(!win.allowedUrl('https://evil.example/J-x64.exe'));
  assert.ok(!win.allowedUrl('https://user:pw@github.com/x'));
});

// ── the owner's yes, and nothing before it ──

test('a newer installer of this flavor is offered and the owner told once, and nothing is downloaded', async () => {
  const { u, seen } = rig();
  const s = await u.check();
  assert.deepEqual(seen.fetched, ['https://askeden.com/windows/latest.json']);
  assert.deepEqual(
    { state: s.state, available: s.available, size: s.size, platform: s.platform, name: s.name },
    { state: 'available', available: '0.1.14', size: 4096, platform: 'win32', name: 'J.A.R.V.I.S. Daredevil' },
  );
  assert.deepEqual(seen.told, ['J.A.R.V.I.S. Daredevil 0.1.14 is available. Open J.A.R.V.I.S. Daredevil and choose Install now to update.']);
  await u.check();
  assert.equal(seen.told.length, 1, 'told once a version, not every day');
  assert.deepEqual(seen.downloads, []);
  assert.deepEqual(seen.runs, []);
});

test('J.A.R.V.I.S. looks at its own entry, not Daredevil’s, and the same version is up to date', async () => {
  const { u, seen } = rig({ flavor: 'jarvis', version: '0.1.13' });
  const s = await u.check();
  assert.equal(s.state, 'current');
  assert.deepEqual(seen.told, []);
  assert.equal((await rig({ flavor: 'jarvis', version: '0.2.0' }).u.check()).state, 'current', 'an older one is never offered');
});

test('Install now downloads to Downloads, checks the size, runs it silently and quits', async () => {
  const { u, seen } = rig();
  assert.equal(await u.install(), false, 'nothing offered yet: nothing to install');
  await u.check();
  assert.equal(await u.install(), true);
  const [d] = seen.downloads;
  assert.equal(d.url, 'https://askeden.com/daredevil/windows');
  assert.equal(path.win32.basename(d.target), 'J-A-R-V-I-S-Daredevil-Setup-0.1.14-x64.exe');
  assert.ok(d.target.startsWith('C:\\Users\\prof\\Downloads'));
  assert.equal(d.size, 4096);
  assert.equal(d.allowed, win.allowedUrl);
  assert.deepEqual(seen.runs, [[d.target, ['/S', '--force-run']]]);
  assert.equal(seen.quit, 1);
  assert.deepEqual(seen.states.slice(-3), ['downloading', 'downloading', 'installing']);
  assert.equal(u.state().state, 'installing');
  assert.equal((await u.check()).state, 'installing', 'no check while it installs');
});

test('a download of the wrong size is never run, and a failure can be tried again', async () => {
  const short = rig({ got: 100 });
  await short.u.check();
  assert.equal(await short.u.install(), false);
  assert.deepEqual([short.u.state().state, short.u.state().error], ['error', win.WORDS.size]);
  assert.deepEqual(short.seen.runs, []);
  assert.equal(short.seen.quit, 0);
  const failed = rig({ failDownload: true });
  await failed.u.check();
  assert.equal(await failed.u.install(), false);
  assert.equal(failed.u.state().error, win.WORDS.download);
  const blocked = rig({ failRun: true });
  await blocked.u.check();
  assert.equal(await blocked.u.install(), false);
  assert.equal(blocked.u.state().error, win.WORDS.run);
  assert.equal(blocked.seen.quit, 0, 'the app stays when the installer did not start');
});

test('askeden.com not answering, or a list that makes no sense, is said plainly', async () => {
  const offline = rig({ latest: new Error('ENOTFOUND') });
  assert.deepEqual([(await offline.u.check()).state, offline.u.state().error], ['error', win.WORDS.offline]);
  const junk = rig({ latest: '{"jarvis": 3}' });
  assert.equal((await junk.u.check()).error, win.WORDS.latest);
});

// ── the download itself ──

function response(chunks, { url = 'https://objects.githubusercontent.com/x', status = 200 } = {}) {
  let i = 0;
  return {
    ok: status === 200,
    status,
    url,
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }) }) },
  };
}

test('the installer is written whole beside its final name, then put in place', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-update-'));
  const target = path.join(dir, 'J-A-R-V-I-S-Setup-0.1.14-x64.exe');
  const asked = [];
  const net = { fetch: async (url, opts) => { asked.push([url, opts.redirect]); return response([Buffer.from('MZ12'), Buffer.from('3456')]); } };
  const seen = [];
  const got = await win.downloadTo(net, fs, 'https://askeden.com/jarvis/windows', target, { size: 8, allowed: win.allowedUrl, progress: (n) => seen.push(n) });
  assert.equal(got, 8);
  assert.equal(fs.readFileSync(target, 'utf8'), 'MZ123456');
  assert.ok(!fs.existsSync(`${target}.part`));
  assert.deepEqual(seen, [4, 8]);
  assert.deepEqual(asked, [['https://askeden.com/jarvis/windows', 'follow']]);
});

test('a download from elsewhere, bigger than said, or short is never left as the installer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-update-'));
  const target = path.join(dir, 'J-x64.exe');
  const from = (r) => ({ fetch: async () => r });
  await assert.rejects(win.downloadTo(from(response([Buffer.from('x')], { url: 'https://evil.example/x' })), fs, 'https://askeden.com/jarvis/windows', target, { size: 1, allowed: win.allowedUrl }), /came from/);
  await assert.rejects(win.downloadTo(from(response([Buffer.from('toolong')])), fs, 'https://askeden.com/jarvis/windows', target, { size: 3, allowed: win.allowedUrl }), /bigger/);
  await assert.rejects(win.downloadTo(from(response([], { status: 404 })), fs, 'https://askeden.com/jarvis/windows', target, { size: 3, allowed: win.allowedUrl }), /HTTP 404/);
  assert.equal(await win.downloadTo(from(response([Buffer.from('ab')])), fs, 'https://askeden.com/jarvis/windows', target, { size: 3, allowed: win.allowedUrl }), 2);
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing half-downloaded stays, and nothing short is put in place');
});

test('the installer is started on its own, so it outlives the app it replaces', async () => {
  const calls = [];
  const spawn = (file, args, opts) => {
    calls.push([file, args, opts]);
    const child = new EventEmitter();
    child.unref = () => calls.push('unref');
    setImmediate(() => child.emit('spawn'));
    return child;
  };
  await win.startInstaller(spawn, 'C:\\Downloads\\J-x64.exe', ['/S', '--force-run']);
  assert.deepEqual(calls[0].slice(0, 2), ['C:\\Downloads\\J-x64.exe', ['/S', '--force-run']]);
  assert.equal(calls[0][2].detached, true);
  assert.equal(calls[1], 'unref');
  const failing = () => { const c = new EventEmitter(); setImmediate(() => c.emit('error', new Error('ENOENT'))); return c; };
  await assert.rejects(win.startInstaller(failing, 'x.exe', []), /ENOENT/);
});

// ── wired into the app ──

test('in the installed app the window can check, and only the window can say Install now', async () => {
  const handlers = new Map();
  const window = { isDestroyed: () => false, show() {}, focus() {} };
  const sent = [];
  const timers = [];
  const realTimeout = global.setTimeout;
  const realInterval = global.setInterval;
  global.setTimeout = (fn, ms) => { timers.push(['timeout', ms]); return { unref() {} }; };
  global.setInterval = (fn, ms) => { timers.push(['interval', ms]); return { unref() {} }; };
  const fakeWin = {
    ...win,
    createWinUpdater: (opts) => {
      const u = win.createWinUpdater({ ...opts, fetchText: async () => LATEST, download: async () => 4096, runInstaller: async () => {} });
      return u;
    },
  };
  try {
    const ctx = {
      app: { getVersion: () => '0.1.12', isPackaged: true, whenReady: () => Promise.resolve(), getPath: () => 'C:\\Users\\prof\\Downloads', quit() {} },
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      fromWindow: (event) => event.sender === window,
      send: (channel, state) => sent.push([channel, state.state]),
      getWindow: () => window,
      flavor: { id: 'daredevil', name: 'J.A.R.V.I.S. Daredevil' },
      dev: false,
    };
    const updater = updates.installWindows(ctx, { electron: { net: {}, Notification: null }, fs, winUpdate: fakeWin, spawn: () => {} });
    await Promise.resolve();
    assert.ok(updater);
    assert.deepEqual([...handlers.keys()].sort(), ['feature:updates:check', 'feature:updates:install', 'feature:updates:restart', 'feature:updates:state']);
    assert.deepEqual(timers, [['timeout', win.FIRST_CHECK], ['interval', 24 * 60 * 60 * 1000]], 'two minutes after launch, then daily');
    assert.equal(handlers.get('feature:updates:check')({ sender: {} }), null);
    const s = await handlers.get('feature:updates:check')({ sender: window });
    assert.equal(s.state, 'available');
    assert.equal(handlers.get('feature:updates:install')({ sender: {} }), false, 'a page that isn’t the window can’t start it');
    assert.equal(await handlers.get('feature:updates:install')({ sender: window }), true);
    assert.ok(sent.some(([channel, state]) => channel === 'feature:updates:state' && state === 'installing'));
  } finally {
    global.setTimeout = realTimeout;
    global.setInterval = realInterval;
  }
});

test('Eden Code on Windows has no update path yet, and says updates are off', () => {
  const handlers = new Map();
  const updater = updates.installWindows({
    app: { getVersion: () => '0.1.8', isPackaged: true },
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    fromWindow: () => true,
    flavor: { id: 'eden-code' },
    dev: false,
  });
  assert.equal(updater, null);
  assert.deepEqual(handlers.get('feature:updates:state')({}), { version: '0.1.8', enabled: false, state: 'off' });
});
