// Updates on Windows (app/win-update.js, and its wiring in app/features/updates.js): latest.json
// read strictly and only when its Ed25519 signature verifies, only this flavor's newer installer
// offered, nothing downloaded or run before the owner's Install now (asked again while Eden is
// busy), the download checked against the size and SHA-256 said and its publisher, then the
// installer started silently and the app quit. The network, the disk and the process are
// stand-ins, and the signing key is a throwaway one made here: nothing leaves this machine.
// node --test tests/web/
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const win = require('../../app/win-update.js');
const updates = require('../../app/features/updates.js');
const signer = require('../../app/scripts/release/sign-feed.js');

// A throwaway key, for these tests only (the real one is the owner's, in the Keychain).
const { privateKey: KEY } = crypto.generateKeyPairSync('ed25519');
const PUBLIC = signer.publicKeyOf(KEY);
const SUM = (text) => crypto.createHash('sha256').update(text).digest('hex');
const ENTRIES = {
  'ask-eden': { version: '0.1.0', size: 110809211, file: 'Ask-Eden-Setup-0.1.0-x64.exe', sha256: SUM('ask') },
  jarvis: { version: '0.1.13', size: 303723280, file: 'J-A-R-V-I-S--Setup-0.1.13-x64.exe', sha256: SUM('jarvis') },
  daredevil: { version: '0.1.14', size: 4096, file: 'J-A-R-V-I-S-Daredevil-Setup-0.1.14-x64.exe', sha256: SUM('daredevil') },
};
const LATEST = signer.signFeed(ENTRIES, KEY);

function rig({ version = '0.1.12', flavor = 'daredevil', latest = LATEST, got = 4096, failDownload = false, failRun = false, sum = ENTRIES[flavor].sha256, signer: checkSigner, busy = false, publicKey = PUBLIC } = {}) {
  const seen = { fetched: [], downloads: [], runs: [], told: [], states: [], quit: 0, removed: [] };
  const u = win.createWinUpdater({
    version,
    flavor,
    name: flavor === 'daredevil' ? 'Eden Daredevil' : 'Eden Secretary',
    fetchText: async (url) => { seen.fetched.push(url); if (latest instanceof Error) throw latest; return latest; },
    download: async (url, target, opts) => {
      seen.downloads.push({ url, target, size: opts.size, allowed: opts.allowed });
      if (failDownload) throw new Error('reset');
      opts.progress(got / 2);
      opts.progress(got);
      return got;
    },
    runInstaller: async (file, args) => { seen.runs.push([file, args]); if (failRun) throw new Error('blocked'); },
    saveDir: () => 'C:\\Users\\prof\\AppData\\Roaming\\Eden Daredevil\\updates',
    hashFile: async () => sum,
    ...(checkSigner ? { checkSigner } : {}),
    busy: async () => (typeof busy === 'function' ? busy() : busy),
    removeFile: async (file) => { seen.removed.push(file); },
    publicKey,
    onChange: (s) => seen.states.push(s.state),
    tell: (text) => seen.told.push(text),
    quit: () => { seen.quit += 1; },
  });
  return { u, seen };
}

// ── latest.json ──

test('latest.json is read strictly: this flavor, a version, an installer’s name, a size and a SHA-256', () => {
  const opts = { publicKey: PUBLIC };
  assert.deepEqual(win.entryFor(LATEST, 'daredevil', opts), ENTRIES.daredevil);
  // (signed with sign-feed.js's own signing, which itself refuses what the app would: so these are signed by hand)
  const bad = (entry) => { const signed = JSON.stringify({ jarvis: entry }); return JSON.stringify({ signed, signature: crypto.sign(null, Buffer.from(signed), KEY).toString('base64') }); };
  const sha256 = SUM('x');
  assert.throws(() => win.entryFor('<html>', 'jarvis', opts), /isn't JSON/);
  assert.throws(() => win.entryFor(bad(null).replace('{"jarvis":null}', '{}'), 'jarvis', opts), /signature|has no jarvis/);
  assert.throws(() => win.entryFor(bad({ version: 'latest', size: 1, file: 'a-x64.exe', sha256 }), 'jarvis', opts), /version/);
  assert.throws(() => win.entryFor(bad({ version: '0.2.0', size: 1, file: '../evil-x64.exe', sha256 }), 'jarvis', opts), /file/);
  assert.throws(() => win.entryFor(bad({ version: '0.2.0', size: 1, file: 'run.bat', sha256 }), 'jarvis', opts), /file/);
  assert.throws(() => win.entryFor(bad({ version: '0.2.0', size: -5, file: 'J-x64.exe', sha256 }), 'jarvis', opts), /size/);
  assert.throws(() => win.entryFor(bad({ version: '0.2.0', size: 5, file: 'J-x64.exe' }), 'jarvis', opts), /SHA-256/);
  assert.deepEqual(win.entryFor(bad({ version: '0.2.0', size: 5, file: 'J-x64.exe', sha256 }), 'jarvis', opts).sha256, sha256);
});

test('only a list signed by the feed’s key is read: unsigned, tampered, another key’s, or no key built in are all refused', () => {
  const data = JSON.parse(LATEST);
  assert.equal(data.daredevil.version, '0.1.14', 'the entries are at the top too, for copies older than signing');
  const unsigned = JSON.stringify(ENTRIES);
  assert.throws(() => win.entryFor(unsigned, 'daredevil', { publicKey: PUBLIC }), (err) => err.code === 'signature');
  const tampered = JSON.stringify({ ...data, signed: data.signed.replace(ENTRIES.daredevil.sha256, SUM('evil')) });
  assert.throws(() => win.entryFor(tampered, 'daredevil', { publicKey: PUBLIC }), /doesn't verify/);
  const topOnly = JSON.stringify({ ...data, daredevil: { ...data.daredevil, version: '9.9.9' } });
  assert.equal(win.entryFor(topOnly, 'daredevil', { publicKey: PUBLIC }).version, '0.1.14', 'the unsigned top level is never read');
  const { privateKey: other } = crypto.generateKeyPairSync('ed25519');
  assert.throws(() => win.entryFor(signer.signFeed(ENTRIES, other), 'daredevil', { publicKey: PUBLIC }), /doesn't verify/);
  assert.throws(() => win.entryFor(LATEST, 'daredevil', { publicKey: '' }), /no feed key/);
  assert.equal(win.FEED_PUBLIC_KEY, '', 'no real key is in the code until the owner makes one');
  assert.throws(() => win.entryFor(LATEST, 'daredevil'), /no feed key/, 'so this copy installs nothing yet');
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
    { state: 'available', available: '0.1.14', size: 4096, platform: 'win32', name: 'Eden Daredevil' },
  );
  assert.deepEqual(seen.told, ['Eden Daredevil 0.1.14 is available. Open Eden Daredevil and choose Install now to update.']);
  await u.check();
  assert.equal(seen.told.length, 1, 'told once a version, not every day');
  assert.deepEqual(seen.downloads, []);
  assert.deepEqual(seen.runs, []);
});

test('Eden Secretary looks at its own entry, not Daredevil’s, and the same version is up to date', async () => {
  const { u, seen } = rig({ flavor: 'jarvis', version: '0.1.13' });
  const s = await u.check();
  assert.equal(s.state, 'current');
  assert.deepEqual(seen.told, []);
  assert.equal((await rig({ flavor: 'jarvis', version: '0.2.0' }).u.check()).state, 'current', 'an older one is never offered');
});

test('Install now downloads into the app’s own folder, checks the size and SHA-256, runs it silently and quits', async () => {
  const { u, seen } = rig();
  assert.equal(await u.install(), false, 'nothing offered yet: nothing to install');
  await u.check();
  assert.equal(await u.install(), true);
  const [d] = seen.downloads;
  assert.equal(d.url, 'https://askeden.com/daredevil/windows');
  assert.equal(path.win32.basename(d.target), 'J-A-R-V-I-S-Daredevil-Setup-0.1.14-x64.exe');
  assert.ok(d.target.startsWith('C:\\Users\\prof\\AppData\\Roaming\\Eden Daredevil\\updates'), 'not Downloads');
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

test('a download that isn’t the published file, or isn’t signed by Eden’s publisher, is removed and never run', async () => {
  const swapped = rig({ sum: SUM('something else') });
  await swapped.u.check();
  assert.equal(await swapped.u.install(), false);
  assert.equal(swapped.u.state().error, win.WORDS.checksum);
  assert.deepEqual(swapped.seen.runs, []);
  assert.equal(swapped.seen.removed.length, 1);
  const forged = rig({ signer: async () => ({ ok: false, subject: 'CN=Someone Else' }) });
  await forged.u.check();
  assert.equal(await forged.u.install(), false);
  assert.equal(forged.u.state().error, win.WORDS.publisher);
  assert.deepEqual(forged.seen.runs, []);
  const unsigned = rig({ latest: JSON.stringify(ENTRIES) });
  assert.equal((await unsigned.u.check()).error, win.WORDS.signature);
  assert.equal(await unsigned.u.install(), false, 'nothing offered: nothing installed');
});

test('while Eden is busy, Install now says so first and goes ahead only on a second yes', async () => {
  let busy = true;
  const { u, seen } = rig({ busy: () => busy });
  await u.check();
  assert.equal(await u.install(), 'busy');
  assert.equal(u.state().busy, true);
  assert.equal(u.state().state, 'available', 'still offered');
  assert.deepEqual(seen.downloads, []);
  assert.equal(await u.install({ force: true }), true, 'the owner said yes anyway');
  assert.equal(seen.quit, 1);
  busy = false;
});

test('the Authenticode check asks Windows, with the path out of the command, and wants a valid signature by the publisher', async () => {
  const calls = [];
  const execFile = (answer) => (cmd, args, opts, cb) => { calls.push([cmd, args, opts]); setImmediate(() => cb(null, answer)); };
  assert.deepEqual(await win.authenticode(execFile('x'), 'C:\\a.exe', ''), { ok: true, unchecked: true });
  assert.equal(calls.length, 0, 'no publisher set: not asked');
  const good = await win.authenticode(execFile('Valid|CN=Eden Labs, O=Eden Labs, C=US'), 'C:\\u\\x$(calc).exe', 'Eden Labs');
  assert.equal(good.ok, true);
  assert.equal(calls[0][0], 'powershell.exe');
  assert.ok(!calls[0][1].join(' ').includes('calc'), 'the file name never goes into the command');
  assert.equal(calls[0][2].env.EDEN_UPDATE_FILE, 'C:\\u\\x$(calc).exe');
  assert.equal((await win.authenticode(execFile('NotSigned|'), 'a.exe', 'Eden Labs')).ok, false);
  assert.equal((await win.authenticode(execFile('Valid|CN=Eden Labs Evil, O=x'), 'a.exe', 'Eden Labs')).ok, false);
  assert.equal((await win.authenticode(execFile('HashMismatch|CN=Eden Labs'), 'a.exe', 'Eden Labs')).ok, false);
  const failing = (cmd, args, opts, cb) => setImmediate(() => cb(new Error('no powershell')));
  assert.equal((await win.authenticode(failing, 'a.exe', 'Eden Labs')).ok, false);
});

test('a file’s SHA-256 is read as it is on disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-update-'));
  fs.writeFileSync(path.join(dir, 'a.exe'), 'daredevil');
  assert.equal(await win.sha256Of(fs, path.join(dir, 'a.exe')), SUM('daredevil'));
});

test('askeden.com not answering, or a list that makes no sense, is said plainly', async () => {
  const offline = rig({ latest: new Error('ENOTFOUND') });
  assert.deepEqual([(await offline.u.check()).state, offline.u.state().error], ['error', win.WORDS.offline]);
  const junk = rig({ latest: '<html>' });
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
  const saved = {};
  const fakeWin = {
    ...win,
    createWinUpdater: (opts) => {
      saved.dir = opts.saveDir();
      const u = win.createWinUpdater({ ...opts, publicKey: PUBLIC, fetchText: async () => LATEST, download: async () => 4096, hashFile: async () => ENTRIES.daredevil.sha256, runInstaller: async () => {} });
      return u;
    },
  };
  try {
    const ctx = {
      app: { getVersion: () => '0.1.12', isPackaged: true, whenReady: () => Promise.resolve(), getPath: (which) => (which === 'userData' ? 'C:\\Users\\prof\\AppData\\Roaming\\Eden Daredevil' : 'C:\\Users\\prof\\Downloads'), quit() {} },
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      fromWindow: (event) => event.sender === window,
      send: (channel, state) => sent.push([channel, state.state]),
      getWindow: () => window,
      flavor: { id: 'daredevil', name: 'Eden Daredevil' },
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
    assert.equal(saved.dir, path.join('C:\\Users\\prof\\AppData\\Roaming\\Eden Daredevil', 'updates'), 'into the app’s own folder');
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

// ── a stalled download (W25) and the signing script (S8) ──

test('a download that stops sending is given up, and its .part removed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'win-update-'));
  const target = path.join(dir, 'J-x64.exe');
  let signal = null;
  let cancelled = false;
  const net = {
    fetch: async (_url, opts) => {
      signal = opts.signal;
      let sent = false;
      return {
        ok: true, status: 200, url: 'https://objects.githubusercontent.com/x',
        body: { getReader: () => ({
          read: () => (sent ? new Promise(() => {}) : (sent = true, Promise.resolve({ done: false, value: Buffer.from('MZ') }))), // then nothing, ever
          cancel: async () => { cancelled = true; },
        }) },
      };
    },
  };
  await assert.rejects(win.downloadTo(net, fs, 'https://askeden.com/jarvis/windows', target, { size: 10, allowed: win.allowedUrl, stallMs: 30 }), /stalled/);
  assert.equal(signal.aborted, true, 'the request itself is aborted');
  assert.equal(cancelled, true);
  assert.deepEqual(fs.readdirSync(dir), [], 'no .part left');
  // one whose answer never comes is given up too
  const silent = { fetch: () => new Promise(() => {}) };
  await assert.rejects(win.downloadTo(silent, fs, 'https://askeden.com/jarvis/windows', target, { size: 10, allowed: win.allowedUrl, stallMs: 30 }), /stalled/);
});

test('sign-feed.js signs with the Keychain’s key, fills sizes and SHA-256s from the installers, and refuses what the app would', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-feed-'));
  fs.writeFileSync(path.join(dir, 'J-A-R-V-I-S--Setup-0.2.0-x64.exe'), 'MZ the installer');
  fs.writeFileSync(path.join(dir, 'entries.json'), JSON.stringify({ jarvis: { version: '0.2.0', file: 'J-A-R-V-I-S--Setup-0.2.0-x64.exe' } }));
  // the Keychain's value: the key's PKCS#8 DER as base64 (here a throwaway one; the Keychain is never read)
  const stored = KEY.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const asked = [];
  const readKey = () => signer.keychainKey((cmd, args) => { asked.push([cmd, ...args]); return `${stored}\n`; });
  const written = {};
  const lines = [];
  signer.main([path.join(dir, 'entries.json'), '--installers', dir, '--out', path.join(dir, 'latest.json')], { readKey, write: (f, t) => { written[f] = t; }, print: (l) => lines.push(l) });
  assert.deepEqual(asked[0], ['/usr/bin/security', 'find-generic-password', '-s', signer.SERVICE, '-a', signer.ACCOUNT, '-w']);
  const feed = written[path.join(dir, 'latest.json')];
  assert.deepEqual(win.entryFor(feed, 'jarvis', { publicKey: PUBLIC }), { version: '0.2.0', size: 16, file: 'J-A-R-V-I-S--Setup-0.2.0-x64.exe', sha256: SUM('MZ the installer') });
  signer.main(['--public'], { readKey, print: (l) => lines.push(l) });
  assert.equal(lines.at(-1), PUBLIC, '--public prints what goes into FEED_PUBLIC_KEY');
  assert.throws(() => signer.signFeed({ jarvis: { version: '0.2.0', size: 3, file: 'J.exe' } }, KEY), /file|SHA-256/, 'nothing the app would refuse is signed');
  assert.throws(() => signer.keychainKey(() => { throw new Error('not found'); }), /No "Eden Windows update feed" key/);
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  assert.throws(() => signer.keyFrom(rsa), /not Ed25519/);
});

test('without the feed’s key built in, unsigned lists stay refused and the owner hears what to do', async () => {
  const keyless = rig({ publicKey: '', latest: JSON.stringify(ENTRIES) });
  const state = await keyless.u.check();
  assert.equal(state.state, 'error');
  assert.equal(state.error, win.WORDS.nokey);
  assert.equal(state.nokey, true);
  assert.match(win.WORDS.nokey, /signing key/);
  assert.match(win.WORDS.nokey, /sign-feed\.js/);
  assert.deepEqual(keyless.seen.fetched, [], 'nothing it could trust to fetch');
  assert.equal(await keyless.u.install(), false, 'nothing offered: nothing installed');
  assert.deepEqual(keyless.seen.downloads, []);
  // Even a list signed by some key isn't taken without one built in.
  const signedElsewhere = rig({ publicKey: '' });
  assert.equal((await signedElsewhere.u.check()).error, win.WORDS.nokey);
});
