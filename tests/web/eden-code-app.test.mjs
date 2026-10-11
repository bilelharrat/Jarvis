// Eden Code, the coding app split out of J.A.R.V.I.S.: which app a launch is (app/flavor.js),
// the one backend both share (app/backend-share.js), and Jarvis opening Eden Code as an app of
// its own (app/features/eden-code.js). node --test tests/web/
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { FLAVORS, resolveFlavor } = require('../../app/flavor.js');
const share = require('../../app/backend-share.js');
const opener = require('../../app/features/eden-code.js');

const temp = (prefix) => mkdtempSync(path.join(tmpdir(), prefix));
const TOKEN = 'ab'.repeat(24);

test('a launch is J.A.R.V.I.S. unless something says Eden Code', () => {
  const empty = temp('flavor-');
  assert.equal(resolveFlavor({ env: {}, argv: [], dir: empty }).id, 'jarvis');
  assert.equal(resolveFlavor({ env: { EDEN_CODE: '1' }, argv: [], dir: empty }).id, 'eden-code');
  assert.equal(resolveFlavor({ env: {}, argv: ['electron', '.', '--eden-code'], dir: empty }).id, 'eden-code');
  // the Eden Code build bakes flavor.json in
  const baked = temp('flavor-');
  writeFileSync(path.join(baked, 'flavor.json'), JSON.stringify({ flavor: 'eden-code' }));
  assert.equal(resolveFlavor({ env: {}, argv: [], dir: baked }).id, 'eden-code');
  // a damaged or unknown one is J.A.R.V.I.S.
  writeFileSync(path.join(baked, 'flavor.json'), '{nope');
  assert.equal(resolveFlavor({ env: {}, argv: [], dir: baked }).id, 'jarvis');
  writeFileSync(path.join(baked, 'flavor.json'), JSON.stringify({ flavor: 'other' }));
  assert.equal(resolveFlavor({ env: {}, argv: [], dir: baked }).id, 'jarvis');
});

test('Eden Code never listens: a code backend, its own page, only its own app features', () => {
  const eden = FLAVORS['eden-code'];
  assert.equal(eden.profile, 'code');
  assert.equal(eden.query, 'app=code');
  assert.equal(eden.socketApp, 'eden-code');
  for (const f of ['code-sessions.js', 'code-verify.js', 'touchid.js', 'video-proof.js', 'design-match.js']) assert.ok(eden.features.has(f), f);
  for (const f of ['shell.js', 'eden-window.js', 'eden-code.js', 'follow-repo.js', 'browser-ai.js']) assert.ok(!eden.features.has(f), f);
  assert.equal(FLAVORS.jarvis.profile, 'full');
  assert.equal(FLAVORS.jarvis.features, undefined); // J.A.R.V.I.S. loads them all
});

test('Eden Code has a Windows ID of its own; J.A.R.V.I.S. Daredevil has J.A.R.V.I.S.\'s (one program, so one replaces the other)', () => {
  assert.equal(FLAVORS.jarvis.appUserModelId, 'com.askeden.jarvis.win');
  assert.equal(FLAVORS['eden-code'].appUserModelId, 'com.askeden.edencode.win');
  assert.equal(FLAVORS.daredevil.appUserModelId, FLAVORS.jarvis.appUserModelId);
  const release = readFileSync(new URL('../../app/scripts/release/windows.js', import.meta.url), 'utf8');
  assert.match(release, /appId: require\('\.\.\/\.\.\/flavor'\)\.FLAVORS\[flavor\]\.appUserModelId/);
});

test('a launch is J.A.R.V.I.S. Daredevil when something says so: DAREDEVIL=1, --daredevil, or the flavor the build bakes in', () => {
  const empty = temp('flavor-');
  assert.equal(resolveFlavor({ env: { DAREDEVIL: '1' }, argv: [], dir: empty }).id, 'daredevil');
  assert.equal(resolveFlavor({ env: {}, argv: ['electron', '.', '--daredevil'], dir: empty }).id, 'daredevil');
  const baked = temp('flavor-');
  writeFileSync(path.join(baked, 'flavor.json'), JSON.stringify({ flavor: 'daredevil' }));
  assert.equal(resolveFlavor({ env: {}, argv: [], dir: baked }).id, 'daredevil');
  // Eden Code, asked for by hand, still wins; nothing else means J.A.R.V.I.S.
  assert.equal(resolveFlavor({ env: { EDEN_CODE: '1' }, argv: [], dir: baked }).id, 'eden-code');
  assert.equal(resolveFlavor({ env: { DAREDEVIL: '0' }, argv: [], dir: empty }).id, 'jarvis');
});

test('J.A.R.V.I.S. Daredevil is J.A.R.V.I.S. under its own name: same logs, data, profile and engine, opened in screen-reader mode', () => {
  const d = FLAVORS.daredevil;
  const j = FLAVORS.jarvis;
  assert.equal(d.name, 'J.A.R.V.I.S. Daredevil');
  assert.equal(d.title, d.name);
  assert.equal(d.logName, j.logName); // the same folder of logs, so one place to look
  assert.equal(d.profile, 'full'); // it listens, like J.A.R.V.I.S.
  assert.equal(d.socketApp, 'jarvis');
  assert.equal(d.features, undefined); // every app feature, like J.A.R.V.I.S.
  assert.equal(d.userDataName, 'J.A.R.V.I.S.'); // its Electron profile and one-at-a-time lock are J.A.R.V.I.S.'s
  assert.equal(d.edition, 'daredevil');
  assert.equal(d.query, 'edition=daredevil'); // what server.index turns into the Daredevil page
  assert.deepEqual([j.edition, FLAVORS['eden-code'].edition], ['', '']);
  // black either way: the window never flashes white at someone with low vision
  assert.deepEqual(d.background, { dark: '#000000', light: '#000000' });
});

test('backend.json says where a backend is, readable by this user only', () => {
  const dir = temp('share-');
  assert.equal(share.read(dir), null);
  assert.ok(share.advertise(dir, { port: 51234, token: TOKEN, pid: 4242, app: 'eden-code', launcher: 4241 }));
  const file = path.join(dir, share.FILE);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(share.read(dir), { port: 51234, pid: 4242, token: TOKEN, app: 'eden-code', launcher: 4241 });
  // only the app that wrote it takes it away
  share.withdraw(dir, 9999);
  assert.ok(share.read(dir));
  share.withdraw(dir, 4241);
  assert.equal(share.read(dir), null);
});

test('a damaged or odd backend.json names no backend', () => {
  const dir = temp('share-');
  const file = path.join(dir, share.FILE);
  for (const body of ['{', '[]', JSON.stringify({ port: 0, token: TOKEN }), JSON.stringify({ port: 70000, token: TOKEN }),
    JSON.stringify({ port: 5000, token: 'short' }), JSON.stringify({ port: 5000, token: 'zz'.repeat(20) }), JSON.stringify({ port: 5000 })]) {
    writeFileSync(file, body);
    assert.equal(share.read(dir), null, body);
  }
});

test('the other app\'s backend is shared only while it and its app are alive and it answers', async () => {
  const dir = temp('share-');
  share.advertise(dir, { port: 51234, token: TOKEN, pid: 4242, app: 'jarvis', launcher: 4241 });
  const alive = new Set([4241, 4242]);
  const isAlive = (pid) => alive.has(pid);
  let answers = true;
  const isHealthy = async (port) => { assert.equal(port, 51234); return answers; };
  assert.equal((await share.discover(dir, { isAlive, isHealthy })).token, TOKEN);
  answers = false;
  assert.equal(await share.discover(dir, { isAlive, isHealthy }), null);
  answers = true;
  alive.delete(4241); // its app quit (the backend goes after it: launcher_watch.py)
  assert.equal(await share.discover(dir, { isAlive, isHealthy }), null);
  assert.equal(await share.discover(temp('share-'), { isAlive, isHealthy }), null);
});

test('this process is alive; pid 1 and nonsense never count', () => {
  assert.equal(share.alive(process.pid), true);
  assert.equal(share.alive(1), false);
  assert.equal(share.alive(NaN), false);
  assert.equal(share.alive(-5), false);
});

test('a shared backend that stops answering twice in a row is gone, once', async () => {
  const replies = [true, false, true, false, false, false];
  let gone = 0;
  const isHealthy = async () => replies.shift() ?? false;
  await new Promise((resolve) => {
    share.watch(1, () => { gone += 1; resolve(); }, { every: 1, isHealthy });
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(gone, 1);
  assert.deepEqual(replies, [false]); // stopped asking once it was gone
  // stopped by its app first: never called
  let called = false;
  const stop = share.watch(1, () => { called = true; }, { every: 1, isHealthy: async () => false });
  stop();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(called, false);
});

test('Jarvis finds an installed Eden Code.app beside it, in /Applications or ~/Applications', () => {
  const have = new Set();
  const exists = (p) => have.has(p);
  const bundle = '/Volumes/Apps/J.A.R.V.I.S.app';
  assert.equal(opener.findInstalled({ bundle, home: '/Users/x', exists }), '');
  have.add('/Users/x/Applications/Eden Code.app/Contents/Info.plist');
  assert.equal(opener.findInstalled({ bundle, home: '/Users/x', exists }), '/Users/x/Applications/Eden Code.app');
  have.add('/Applications/Eden Code.app/Contents/Info.plist');
  assert.equal(opener.findInstalled({ bundle, home: '/Users/x', exists }), '/Applications/Eden Code.app');
  have.add('/Volumes/Apps/Eden Code.app/Contents/Info.plist');
  assert.equal(opener.findInstalled({ bundle, home: '/Users/x', exists }), '/Volumes/Apps/Eden Code.app');
});

test('without Eden Code.app, Jarvis runs its own code as Eden Code', () => {
  assert.deepEqual(opener.launchCommand({ installed: '/Applications/Eden Code.app', packaged: true, execPath: '/x', appPath: '/y' }),
    { command: '/usr/bin/open', args: ['-a', '/Applications/Eden Code.app'] });
  assert.deepEqual(opener.launchCommand({ installed: '', packaged: true, execPath: '/J.app/Contents/MacOS/J', appPath: '/y' }),
    { command: '/J.app/Contents/MacOS/J', args: ['--eden-code'] });
  assert.deepEqual(opener.launchCommand({ installed: '', packaged: false, execPath: '/electron', appPath: '/repo/app' }),
    { command: '/electron', args: ['/repo/app', '--eden-code'] });
});

test('only J.A.R.V.I.S.\'s own window opens Eden Code; Eden Code and the test window don\'t install it', async () => {
  const handlers = new Map();
  const ipcMain = { handle: (ch, fn) => handlers.set(ch, fn) };
  const app = { isPackaged: false, getAppPath: () => '/repo/app' };
  opener.install({ app, ipcMain, flavor: FLAVORS['eden-code'], fromWindow: () => true });
  opener.install({ app, ipcMain, flavor: FLAVORS.jarvis, dev: true, fromWindow: () => true });
  assert.equal(handlers.size, 0);
  opener.install({ app, ipcMain, flavor: FLAVORS.jarvis, fromWindow: (e) => e === 'main' });
  assert.deepEqual([...handlers.keys()].sort(), ['feature:eden-code:open', 'feature:eden-code:status']);
  assert.deepEqual(await handlers.get('feature:eden-code:open')('a page'), { ok: false });
  assert.equal(await handlers.get('feature:eden-code:status')('a page'), null);
});

test('main.js gives Eden Code its own profile, no shortcuts or microphone, and shares the backend', () => {
  const main = readFileSync(new URL('../../app/main.js', import.meta.url), 'utf8');
  assert.match(main, /if \(EDEN_CODE\) app\.setPath\('userData', path\.join\(app\.getPath\('appData'\), 'Eden Code'\)\)/);
  assert.match(main, /DEV_URL \|\| EDEN_CODE\) return; \/\/ Eden Code never listens/);
  assert.match(main, /if \(EDEN_CODE\) return; \/\/ Eden Code takes no global shortcuts/);
  assert.match(main, /how\.env\.JARVIS_PROFILE = FLAVOR\.profile/);
  assert.match(main, /share\.advertise\(DATA_DIR/);
  assert.match(main, /share\.withdraw\(DATA_DIR, process\.pid\)/);
  // the profile is chosen before the single-instance lock, so the two apps don't take each other's
  assert.ok(main.indexOf("app.setPath('userData', path.join(app.getPath('appData'), 'Eden Code'))") < main.indexOf('requestSingleInstanceLock'));
});

test('from source, a stray flavor.json (a build stopped half way) never makes `npm start` Eden Code (CH2)', () => {
  const baked = temp('flavor-');
  writeFileSync(path.join(baked, 'flavor.json'), JSON.stringify({ flavor: 'eden-code' }));
  assert.equal(resolveFlavor({ env: {}, argv: ['electron', '.'], dir: baked, packaged: false }).id, 'jarvis');
  assert.equal(resolveFlavor({ env: {}, argv: ['electron', '.'], dir: baked, packaged: true }).id, 'eden-code');
  assert.equal(resolveFlavor({ env: { EDEN_CODE: '1' }, argv: [], dir: baked, packaged: false }).id, 'eden-code');
  const main = readFileSync(new URL('../../app/main.js', import.meta.url), 'utf8');
  assert.match(main, /resolveFlavor\(\{ packaged: app\.isPackaged \}\)/);
});

test('Eden Code alone never says "Listening" when nothing listens (CH5)', () => {
  const page = readFileSync(new URL('../../src/jarvis/web/app.js', import.meta.url), 'utf8');
  const fn = page.slice(page.indexOf('function onVoiceCode('), page.indexOf("$('cc-voice-head').addEventListener"));
  assert.match(fn, /const hears = !inEdenCode \|\| jarvisWindows > 0;/);
  assert.match(fn, /hears \? 'Listening: just talk/);
  assert.match(fn, /Eden hears you while Eden is open/);
  const zh = JSON.parse(readFileSync(new URL('../../src/jarvis/web/i18n-zh.json', import.meta.url), 'utf8'));
  assert.ok(zh.strings['Voice is on for this session: Eden hears you while Eden is open. Or type…']);
});

test('the app that started the shared backend asks before its quit stops the other app\'s work (CH9), and an app on the other one\'s backend can update quietly (CH8)', () => {
  const main = readFileSync(new URL('../../app/main.js', import.meta.url), 'utf8');
  assert.match(main, /app\.prependListener\('before-quit'/);
  const guard = main.slice(main.indexOf("app.prependListener('before-quit'"));
  assert.match(guard, /if \(quitAsked \|\| quitting \|\| DEV_URL \|\| !backend\) return;/);
  assert.match(main, /health && health\.busy && others\.length/);
  assert.match(main, /app\.on\('before-quit', \(event\) => \{\n\s+if \(event\.defaultPrevented\) return;/);
  // every other before-quit handler leaves a quit that was put off alone
  const shell = readFileSync(new URL('../../app/features/shell.js', import.meta.url), 'utf8');
  assert.match(shell, /app\.on\('before-quit', \(event\) => \{\n\s+if \(event && event\.defaultPrevented\) return;/);
  const verify = readFileSync(new URL('../../app/features/code-verify.js', import.meta.url), 'utf8');
  assert.match(verify, /before-quit', \(event\) => \{ if \(!\(event && event\.defaultPrevented\)\) closeAll\(\); \}/);
  // CH8: sharing, busy is asked of the shared backend instead of being "busy" for good
  assert.match(main, /if \(\(!backend && !sharedFrom\) \|\| !port\) return resolve\(true\);/);
});

const web = (name) => readFileSync(new URL(`../../src/jarvis/web/${name}`, import.meta.url), 'utf8');

test('Eden Code\'s gear and ⌘, open one Settings, without the assistant\'s own groups (CH10)', () => {
  const page = web('app.js');
  // ⌘, in the deck leaves Eden Code's to its own handler (the gear's Settings), and settings-nav doesn't toggle it back
  assert.match(page, /if \(key === ',' && !e\.shiftKey\) \{\n\s+e\.preventDefault\(\);\n\s+\/\/[^\n]*\n\s+if \(inEdenCode\) return;\n\s+openJcSettings\('general'\);/);
  assert.match(page, /key: inEdenCode \? '' : '⌘,'/);
  const nav = web('features/settings-nav.js');
  assert.match(nav, /document\.addEventListener\('keydown', \(e\) => \{\n\s+if \(EDEN\) return;/);
  for (const id of ['mail-group', 'calendars-group', 'convo-group', 'pictures-group', 'wa-group', 'sms-line-group']) assert.ok(nav.includes(`'${id}'`), id);
  assert.match(nav, /JARVIS_ONLY_INSIDE = \['persona-group', 'reset-btn'\]/);
  assert.match(nav, /g\.classList\.toggle\('sn-out', edenOff\(g\) \|\|/);
  assert.match(web('eden-code.css'), /body\.eden-code #look-group, body\.eden-code #tone-row/);
});

test('Settings is a proper tablist and modal; the intro keeps Tab inside; the sidebar is not a nested landmark (CH11-CH13)', () => {
  const nav = web('features/settings-nav.js');
  assert.match(nav, /gap\.setAttribute\('role', 'none'\)/);
  assert.match(nav, /li\.setAttribute\('role', 'none'\)/);
  assert.match(nav, /for \(const n of madeInert\) n\.inert = true;/);
  assert.match(nav, /modal\(open\);/);
  const intro = web('features/intro.js');
  assert.match(intro, /\.filter\(reachable\)/);
  assert.match(intro, /visibilityProperty: true/);
  assert.match(intro, /queueMicrotask\(\(\) => \{ if \(isOpen\(\) && !madeInert\.length\) inertBehind\(root\); \}\)/);
  assert.match(intro, /inertOff\(\);/);
  const html = web('index.html');
  assert.match(html, /<nav class="jc-side glass-panel" id="jc-side" aria-label="Projects and sessions">/);
  assert.doesNotMatch(html, /<aside class="jc-side/);
});

test('Eden Code\'s window opens where it was left, per set of displays (CH15)', () => {
  const place = require('../../app/features/window-place.js');
  assert.ok(FLAVORS['eden-code'].features.has('window-place.js'));
  const file = path.join(temp('place-'), 'window.json');
  const displays = [{ bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 38, width: 1512, height: 900 }, scaleFactor: 2 }];
  const screen = { getAllDisplays: () => displays };
  const timers = [];
  const later = (fn) => { timers.push(fn); return timers.length; };
  const makeWin = (bounds) => {
    const on = {};
    return { bounds, set: [], on: (ev, fn) => { on[ev] = fn; }, fire: (ev) => on[ev](), setBounds(b) { this.set.push(b); this.bounds = b; },
      getNormalBounds() { return this.bounds; }, isDestroyed: () => false, isMinimized: () => false, isFullScreen: () => false };
  };
  const first = makeWin({ x: 100, y: 100, width: 1240, height: 820 });
  place.keep(first, { screen, file, min: { width: 720, height: 560 }, later, cancel() {} });
  assert.deepEqual(first.set, []); // nothing kept yet: it opens as it would have
  first.bounds = { x: 200, y: 80, width: 900, height: 700 };
  first.fire('move');
  timers.pop()();
  const next = makeWin({ x: 100, y: 100, width: 1240, height: 820 });
  place.keep(next, { screen, file, min: { width: 720, height: 560 }, later, cancel() {} });
  assert.deepEqual(next.set, [{ x: 200, y: 80, width: 900, height: 700 }]);
  // J.A.R.V.I.S. (shell.js keeps its place) and the test window install nothing
  let asked = 0;
  const ctx = (flavor, dev = false) => ({ flavor, dev, getWindow: () => { asked += 1; return null; }, app: { getPath: () => '/nowhere', on() {} } });
  place.install(ctx(FLAVORS.jarvis));
  place.install(ctx(FLAVORS['eden-code'], true));
  assert.equal(asked, 0);
});

test('Eden Code registers no link scheme it can\'t open, and its page asks the app no shell hello (CH14)', () => {
  const win = readFileSync(new URL('../../app/scripts/release/windows.js', import.meta.url), 'utf8');
  assert.match(win, /\.\.\.\(edenCode \? \{\} : \{ protocols: \[\{ name: display, schemes: \['jarvis'\] \}\] \}\)/);
  assert.doesNotMatch(win, /'edencode'/);
  const shell = web('features/shell.js');
  assert.match(shell, /if \(bridge && document\.body\.dataset\.app !== 'eden-code'\) \{\n\s+bridge\.on\(`\$\{CH\}command`, run\);/);
});

test('a terminal component that failed to load is asked for again next time, not kept failed (CH18)', async () => {
  const page = web('app.js');
  const fn = page.slice(page.indexOf('async function ensureXterm()'), page.indexOf('async function renderTerminal('));
  assert.match(fn, /\.catch\(\(err\) => \{ term\.loading = null; throw err; \}\)/);
  // the same chain, run: a failed load clears itself, the next succeeds
  const term = {};
  let fail = true;
  const loadScript = async () => { if (fail) throw new Error('404'); };
  const window = {};
  const document = { getElementById: () => ({}), createElement: () => ({}), head: { append() {} } };
  const ensureXterm = new Function('term', 'loadScript', 'window', 'document', `${fn.replace('async function ensureXterm()', 'return async function ensureXterm()')}`)(term, loadScript, window, document);
  await assert.rejects(ensureXterm());
  assert.equal(term.loading, null);
  fail = false;
  await ensureXterm();
});
