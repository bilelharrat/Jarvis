// Updates for the app people download: the feed (app/update-feed.js: parsing, version order,
// what dist publishes), the app's side (app/features/updates.js, with a stand-in Squirrel:
// it checks the feed, downloads only something newer and never restarts unasked) and the
// window's (web/features/updates.js: every sentence has its Chinese). node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const feed = require('../../app/update-feed.js');
const updates = require('../../app/features/updates.js');
const windowSide = require('../../src/jarvis/web/features/updates.js');
const winUpdate = require('../../app/win-update.js');

const WEB = process.env.JARVIS_WEB_DIR || fileURLToPath(new URL('../../src/jarvis/web/', import.meta.url));
const FEED = 'https://downloads.example.com/jarvis/release.json';

function releaseJson(version, url = `J.A.R.V.I.S.-${version}-mac.zip`) {
  return JSON.stringify(feed.releaseFeed({ version, zipName: url, feedUrl: FEED, notes: 'Faster.', date: new Date('2026-10-01T12:00:00Z') }));
}

// ── the feed ──

test('versions order as semver does', () => {
  assert.equal(feed.compareVersions('0.2.0', '0.1.9'), 1);
  assert.equal(feed.compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(feed.compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(feed.compareVersions('1.0.0-beta.2', '1.0.0'), -1);
  assert.equal(feed.compareVersions('1.0.0-beta.10', '1.0.0-beta.2'), 1);
  assert.equal(feed.compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
  assert.throws(() => feed.compareVersions('1.0', '1.0.0'), /not a version/);
});

test('dist writes the feed Squirrel reads, the zip beside it', () => {
  const data = JSON.parse(releaseJson('0.2.0'));
  assert.equal(data.currentRelease, '0.2.0');
  assert.deepEqual(data.releases[0].updateTo, {
    version: '0.2.0', name: 'Eden 0.2.0', pub_date: '2026-10-01T12:00:00.000Z', notes: 'Faster.',
    url: 'https://downloads.example.com/jarvis/J.A.R.V.I.S.-0.2.0-mac.zip',
  });
  assert.throws(() => feed.releaseFeed({ version: '0.2', zipName: 'x.zip', feedUrl: FEED }), /isn't x\.y\.z/);
  assert.throws(() => feed.releaseFeed({ version: '0.2.0', zipName: 'x.zip', feedUrl: 'http://plain.example.com/r.json' }), /must be https/);
});

test('the feed is read strictly: https, its current release, a size a feed has', () => {
  const release = feed.parseFeed(releaseJson('0.2.0'), FEED);
  assert.equal(release.version, '0.2.0');
  assert.equal(release.url, 'https://downloads.example.com/jarvis/J.A.R.V.I.S.-0.2.0-mac.zip');
  const relative = JSON.parse(releaseJson('0.2.0'));
  relative.releases[0].updateTo.url = 'J.A.R.V.I.S.-0.2.0-mac.zip'; // relative to the feed
  assert.equal(feed.parseFeed(JSON.stringify(relative), FEED).url, 'https://downloads.example.com/jarvis/J.A.R.V.I.S.-0.2.0-mac.zip');
  const plain = JSON.parse(releaseJson('0.2.0'));
  plain.releases[0].updateTo.url = 'http://downloads.example.com/J.zip';
  assert.throws(() => feed.parseFeed(JSON.stringify(plain), FEED), /isn't https/);
  const lost = JSON.parse(releaseJson('0.2.0'));
  lost.currentRelease = '0.3.0';
  assert.throws(() => feed.parseFeed(JSON.stringify(lost), FEED), /current release is missing/);
  assert.throws(() => feed.parseFeed('<html>', FEED), /valid JSON/);
  assert.throws(() => feed.parseFeed('{}', FEED), /no releases/);
  assert.throws(() => feed.parseFeed('x'.repeat(feed.MAX_FEED + 1), FEED), /isn't a feed/);
});

test('only something newer than the running app is offered', () => {
  const release = feed.parseFeed(releaseJson('0.2.0'), FEED);
  assert.equal(feed.newerRelease(release, '0.1.0'), release);
  assert.equal(feed.newerRelease(release, '0.2.0'), null);
  assert.equal(feed.newerRelease(release, '0.3.0'), null); // never a downgrade
  assert.equal(feed.newerRelease(release, 'dev'), null);
});

test("the feed's address must be https, without a password in it", () => {
  assert.equal(feed.cleanFeedUrl(FEED), FEED);
  assert.equal(feed.cleanFeedUrl('http://downloads.example.com/r.json'), '');
  assert.equal(feed.cleanFeedUrl('https://me:secret@downloads.example.com/r.json'), '');
  assert.equal(feed.cleanFeedUrl(''), '');
  assert.equal(feed.cleanFeedUrl('not a url'), '');
});

// ── the app's side ──

test('the feed is baked into the downloadable app only', () => {
  const read = (file) => {
    assert.equal(file, '/App/Contents/Resources/update.json');
    return JSON.stringify({ feed: FEED });
  };
  assert.equal(updates.feedFrom('/App/Contents/Resources', true, read), FEED);
  assert.equal(updates.feedFrom('/App/Contents/Resources', false, read), ''); // npm start
  assert.equal(updates.feedFrom('/App/Contents/Resources', true, () => { throw new Error('ENOENT'); }), ''); // install-app
  assert.equal(updates.feedFrom('/App/Contents/Resources', true, () => '{"feed": "http://x.example.com/r.json"}'), '');
});

function squirrel() {
  const s = new EventEmitter();
  s.calls = [];
  s.setFeedURL = (options) => s.calls.push(['feed', options]);
  s.checkForUpdates = () => s.calls.push(['check']);
  s.quitAndInstall = () => s.calls.push(['install']);
  return s;
}

function updater({ text = releaseJson('0.2.0'), version = '0.1.0', inApplications = true, url = FEED, quiet = false, ...more } = {}) {
  const auto = squirrel();
  const seen = [];
  const prepared = [];
  const u = updates.createUpdater({
    ...more,
    version,
    feed: url,
    autoUpdater: auto,
    fetchText: async (asked) => { assert.equal(asked, FEED); if (text instanceof Error) throw text; return text; },
    inApplications: () => inApplications,
    onChange: (s) => seen.push(s),
    isQuiet: async () => (typeof quiet === 'function' ? quiet() : quiet),
    beforeInstall: () => prepared.push('as it was'),
  });
  return { u, auto, seen, prepared };
}

test('a downloaded update installs itself, but only at a quiet moment', async () => {
  let calm = false;
  const { u, auto, prepared } = updater({ quiet: () => calm });
  assert.equal(await u.quiet(), false); // nothing ready yet
  await u.check();
  assert.equal(await u.quiet(), false); // still downloading
  auto.emit('update-downloaded');
  assert.equal(await u.quiet(), false); // ready, but the owner is around
  assert.deepEqual(auto.calls.slice(2), []);
  calm = true;
  assert.equal(await u.quiet(), true);
  assert.deepEqual(auto.calls.at(-1), ['install']);
  assert.deepEqual(prepared, ['as it was']); // reopens hidden if it was hidden
});

test('a quiet moment: the Mac untouched ten minutes, the window not in front, JARVIS idle', async () => {
  const moment = (over) => updates.quietMoment({ idleSeconds: () => 700, windowInFront: () => false, backendBusy: async () => false, ...over });
  assert.equal(await moment({}), true);
  assert.equal(await moment({ idleSeconds: () => 120 }), false);
  assert.equal(await moment({ windowInFront: () => true }), false);
  assert.equal(await moment({ backendBusy: async () => true }), false); // meeting notes, a task, a turn
  assert.equal(updates.QUIET_IDLE, 600);
  assert.equal(updates.CHECK_EVERY, 60 * 60 * 1000);
});

test('a newer release is downloaded by Squirrel, then offered; Restart installs it at once', async () => {
  const { u, auto, seen } = updater();
  assert.equal(u.state().state, 'idle');
  assert.equal(await u.restart(), false); // nothing ready: no restart
  const state = await u.check();
  assert.equal(state.state, 'downloading');
  assert.equal(state.available, '0.2.0');
  assert.deepEqual(auto.calls, [['feed', { url: FEED, serverType: 'json' }], ['check']]);
  assert.equal((await u.check()).state, 'downloading'); // no second check while it downloads
  assert.equal(auto.calls.length, 2);
  auto.emit('update-downloaded');
  assert.deepEqual({ ...u.state(), notes: undefined }, { version: '0.1.0', enabled: true, state: 'ready', available: '0.2.0', name: 'Eden 0.2.0', notes: undefined });
  assert.deepEqual(auto.calls.slice(2), []); // downloaded, and still running: not while the owner is around
  assert.equal(await u.restart(), true);
  assert.deepEqual(auto.calls.at(-1), ['install']);
  assert.deepEqual(seen.map((s) => s.state), ['checking', 'downloading', 'ready']);
});

test('the same or an older release is up to date; Squirrel is never asked', async () => {
  for (const version of ['0.2.0', '0.3.0']) {
    const { u, auto } = updater({ version });
    const state = await u.check();
    assert.equal(state.state, 'current');
    assert.ok(state.checked > 0);
    assert.deepEqual(auto.calls, []);
  }
});

test('a feed that fails or makes no sense is said plainly, and the next check tries again', async () => {
  const offline = updater({ text: new Error('ENOTFOUND') });
  assert.deepEqual([(await offline.u.check()).state, offline.u.state().error], ['error', updates.WORDS.offline]);
  const junk = updater({ text: '<html>not a feed</html>' });
  assert.deepEqual([(await junk.u.check()).state, junk.u.state().error], ['error', updates.WORDS.feed]);
  assert.deepEqual(junk.auto.calls, []);
});

test("Squirrel's own failure is said, and a translocated app is asked to move first", async () => {
  const { u, auto } = updater();
  await u.check();
  auto.emit('error', new Error('Code signature at URL … did not pass validation'));
  assert.deepEqual([u.state().state, u.state().error], ['error', updates.WORDS.install]);
  const moved = updater({ inApplications: false });
  const state = await moved.u.check();
  assert.deepEqual([state.state, state.available, state.error], ['move', '0.2.0', updates.WORDS.move]);
  assert.deepEqual(moved.auto.calls, []);
});

test('without a feed, updates are off and nothing is fetched', async () => {
  const auto = squirrel();
  const u = updates.createUpdater({ version: '0.1.0', feed: '', autoUpdater: auto, fetchText: async () => { throw new Error('fetched'); }, inApplications: () => true });
  assert.deepEqual(await u.check(), { version: '0.1.0', enabled: false, state: 'off' });
  assert.deepEqual(auto.calls, []);
});

test('the owner’s own install, which follows the repo, says so instead of “doesn’t check”', async () => {
  const u = updates.createUpdater({ version: '0.1.5', feed: '', autoUpdater: squirrel(), fetchText: async () => { throw new Error('fetched'); }, inApplications: () => true, follows: true });
  const s = await u.check();
  assert.deepEqual(s, { version: '0.1.5', enabled: false, follows: true, state: 'off' });
  assert.equal(windowSide.lineFor(s), 'Updates itself from its source folder whenever main changes.');
  assert.equal(windowSide.lineFor({ version: '0.1.5', enabled: false, state: 'off' }), 'This copy doesn’t check for updates.');
  // A feed wins: a downloaded copy never says it follows a folder.
  const fed = updates.createUpdater({ version: '0.1.5', feed: 'https://example.invalid/release.json', autoUpdater: squirrel(), fetchText: async () => '{}', inApplications: () => true, follows: true });
  assert.equal(fed.state().follows, undefined);
});

test('only the window may ask, and the dev window has updates off', () => {
  const handlers = new Map();
  const win = {};
  const ctx = {
    app: { getVersion: () => '0.1.0', isPackaged: true, isInApplicationsFolder: () => true, whenReady: () => Promise.resolve() },
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    fromWindow: (event) => event.sender === win,
    send: () => {},
    dev: true,
  };
  updates.install(ctx);
  assert.deepEqual([...handlers.keys()].sort(), ['feature:updates:check', 'feature:updates:restart', 'feature:updates:state']);
  assert.equal(handlers.get('feature:updates:state')({ sender: {} }), null);
  assert.deepEqual(handlers.get('feature:updates:state')({ sender: win }), { version: '0.1.0', enabled: false, state: 'off' });
  assert.equal(handlers.get('feature:updates:restart')({ sender: {} }), false);
});

test('on Windows a copy that was never installed answers the window too (updates off), not left without a handler', () => {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const handlers = new Map();
    const win = {};
    updates.install({
      app: { getVersion: () => '0.1.8', isPackaged: false },
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      fromWindow: (event) => event.sender === win,
      dev: false,
    });
    assert.deepEqual([...handlers.keys()].sort(), ['feature:updates:check', 'feature:updates:install', 'feature:updates:restart', 'feature:updates:state']);
    assert.deepEqual(handlers.get('feature:updates:state')({ sender: win }), { version: '0.1.8', enabled: false, state: 'off' });
    assert.deepEqual(handlers.get('feature:updates:check')({ sender: win }), { version: '0.1.8', enabled: false, state: 'off' });
    assert.equal(handlers.get('feature:updates:state')({ sender: {} }), null);
    assert.equal(handlers.get('feature:updates:restart')({ sender: win }), false);
    assert.equal(handlers.get('feature:updates:install')({ sender: win }), false);
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
});

// ── the window's side ──

const base = JSON.parse(readFileSync(`${WEB}/i18n-zh.json`, 'utf8'));
const ours = JSON.parse(readFileSync(`${WEB}/i18n/updates.json`, 'utf8'));
const strings = { ...base.strings, ...ours.strings };
const patterns = [...base.patterns, ...ours.patterns].map(([p, r]) => [new RegExp(p), r]);
function chinese(text) {
  if (strings[text] !== undefined) return strings[text];
  for (const [re, rep] of patterns) if (re.test(text)) return text.replace(re, rep);
  return null;
}

test('every line the window shows has its Chinese', () => {
  const lines = [
    windowSide.lineFor(null),
    windowSide.lineFor({ enabled: false }),
    ...['idle', 'checking', 'current'].map((state) => windowSide.lineFor({ enabled: true, state })),
    windowSide.lineFor({ enabled: true, state: 'downloading', available: '0.2.0' }),
    windowSide.lineFor({ enabled: true, state: 'ready', available: '0.2.0' }),
    windowSide.lineFor({ enabled: true, state: 'error' }),
    ...Object.values(updates.WORDS),
    ...Object.values(winUpdate.WORDS),
    'About', 'Check for updates', 'Restart to update', 'Restart now', 'Later', 'Install now',
    'J.A.R.V.I.S. 0.2.0 is ready. Restart to install it.',
    // Windows: an installer offered, downloading, starting
    windowSide.lineFor({ enabled: true, platform: 'win32', state: 'idle' }),
    windowSide.lineFor({ enabled: true, platform: 'win32', state: 'available', available: '0.1.15', size: 327754786 }),
    windowSide.lineFor({ enabled: true, platform: 'win32', state: 'downloading', available: '0.1.15', size: 1000, received: 420 }),
    windowSide.lineFor({ enabled: true, platform: 'win32', state: 'installing', available: '0.1.15' }),
    windowSide.cardFor({ name: 'J.A.R.V.I.S. Daredevil', state: 'available', available: '0.1.15', size: 327754786 }),
    windowSide.cardFor({ name: 'Eden', state: 'available', available: '0.1.15', size: 303723280 }),
  ];
  assert.deepEqual(lines.filter((line) => chinese(line) === null), []);
  assert.equal(chinese('Downloading 1.2.3…'), '正在下载 1.2.3…');
  assert.equal(chinese('Eden 1.0.0-beta.2 is ready. Restart to install it.'), 'Eden 1.0.0-beta.2 已准备好，重新启动即可安装。');
});

test('the fragment never changes a Chinese string the window already had', () => {
  for (const [key, value] of Object.entries(ours.strings)) if (key in base.strings) assert.equal(value, base.strings[key], key);
});

test('Eden Code\'s updater says Eden Code, and the window says how often it really checks (CH16)', async () => {
  assert.equal(updates.appNameFor({ id: 'eden-code', name: 'Eden Code' }), 'Eden Code');
  assert.equal(updates.appNameFor({ id: 'jarvis', name: 'Eden' }), 'Eden');
  assert.equal(updates.appNameFor(undefined), 'Eden');
  const words = updates.wordsFor('Eden Code');
  assert.equal(words.move, 'Move Eden Code to your Applications folder to get updates.');
  assert.equal(words.feed, 'The update feed isn’t one Eden Code can read.');
  assert.deepEqual(updates.wordsFor('Eden'), updates.WORDS);
  // the feed's own name for it, and the fallback when a feed names none
  const json = feed.releaseFeed({ version: '0.2.0', zipName: 'Eden Code-0.2.0-mac.zip', feedUrl: FEED, appName: 'Eden Code' });
  assert.equal(json.releases[0].updateTo.name, 'Eden Code 0.2.0');
  delete json.releases[0].updateTo.name;
  assert.equal(feed.parseFeed(JSON.stringify(json), FEED, 'Eden Code').name, 'Eden Code 0.2.0');
  // an updater made with the name reports it (the About row) and words its problems with it
  const u = updates.createUpdater({ version: '0.1.0', feed: FEED, name: 'Eden Code', autoUpdater: { on() {}, setFeedURL() {} },
    fetchText: async () => { throw new Error('offline'); }, inApplications: () => true });
  assert.equal(u.state().app, 'Eden Code');
  assert.equal(updates.CHECK_EVERY, 60 * 60 * 1000);
  const page = readFileSync(new URL('../../src/jarvis/web/features/updates.js', import.meta.url), 'utf8');
  assert.match(page, /'Checks for updates every hour\.'/);
  assert.doesNotMatch(page, /every 6 hours/);
  const dist = readFileSync(new URL('../../app/scripts/release/dist.js', import.meta.url), 'utf8');
  assert.match(dist, /appName: spec\.display/);
});

// CH3-1: the install itself fails (Squirrel's error after quitAndInstall). Before, the state stayed "ready" for good,
// check() refused to run while ready, and nothing was said but a log line.
test('an install that fails is said, and the next check downloads it again', async () => {
  for (const how of ['asked', 'quiet']) {
    const failed = [];
    let fetched = 0;
    const { u, auto } = updater({ quiet: true, onInstallFailed: (h) => failed.push(h) });
    await u.check();
    fetched += 1;
    auto.emit('update-downloaded');
    assert.equal(u.state().state, 'ready');
    assert.equal(how === 'asked' ? await u.restart() : await u.quiet(), true);
    assert.deepEqual(auto.calls.at(-1), ['install']);
    auto.emit('error', new Error('ShipIt: code signature did not match'));
    assert.deepEqual([u.state().state, u.state().error], ['error', updates.WORDS.install]);
    assert.deepEqual(failed, [how]); // (main's dialog only for the owner's own Restart: install())
    const again = await u.check(); // retryable: the feed is read and Squirrel asked again
    fetched += 1;
    assert.equal(again.state, 'downloading');
    assert.equal(auto.calls.filter(([c]) => c === 'check').length, fetched);
    auto.emit('update-downloaded');
    assert.equal(u.state().state, 'ready');
  }
});

test('an error with nothing installing leaves a ready update ready (as before)', async () => {
  const failed = [];
  const { u, auto } = updater({ onInstallFailed: (h) => failed.push(h) });
  await u.check();
  auto.emit('update-downloaded');
  auto.emit('error', new Error('a stray one'));
  assert.equal(u.state().state, 'ready');
  assert.deepEqual(failed, []);
});

// CH3-5: Restart to update stops this app's backend as a quit does, so it asks the quit's question first (main.js
// mayQuit: the other app busy on it). Cancel: nothing installs, and the update stays ready.
test('Restart to update asks first when the other app is busy, and Cancel keeps it ready', async () => {
  let answer = false;
  const asked = [];
  const { u, auto } = updater({ askFirst: async () => { asked.push(true); return answer; } });
  await u.check();
  auto.emit('update-downloaded');
  assert.equal(await u.restart(), false);
  assert.equal(asked.length, 1);
  assert.equal(auto.calls.some(([c]) => c === 'install'), false);
  assert.equal(u.state().state, 'ready');
  answer = true;
  assert.equal(await u.restart(), true);
  assert.deepEqual(auto.calls.at(-1), ['install']);
  // a question that throws is a no
  const broken = updater({ askFirst: async () => { throw new Error('no window'); } });
  await broken.u.check();
  broken.auto.emit('update-downloaded');
  assert.equal(await broken.u.restart(), false);
  // the quiet install never asks (it waits for nothing going: /health's busy)
  const quiet = updater({ quiet: true, askFirst: async () => { throw new Error('asked'); } });
  await quiet.u.check();
  quiet.auto.emit('update-downloaded');
  assert.equal(await quiet.u.quiet(), true);
  // main.js hands it the quit's own question
  const main = readFileSync(new URL('../../app/main.js', import.meta.url), 'utf8');
  assert.match(main, /async function mayQuit\(\) \{\n\s+if \(DEV_URL \|\| !backend\) return true;/);
  assert.match(main, /async function askBeforeQuitting\(\) \{\n\s+if \(await mayQuit\(\)\) app\.quit\(\);\n\s+else quitAsked = false;\n\}/);
  assert.match(main, /\n\s+mayQuit, \/\/ before Restart to update/);
  const app = readFileSync(new URL('../../app/features/updates.js', import.meta.url), 'utf8');
  assert.match(app, /askFirst: \(\) => \(ctx\.mayQuit \? ctx\.mayQuit\(\) : true\),/);
});
