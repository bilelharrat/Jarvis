// The app's own pages in a packaged build (app/page-path.js). With Electron's
// GrantFileProtocolExtraPrivileges fuse off (fuses.js), Chromium's own file handler can't read
// inside app.asar (the first load of app.asar/loading.html failed with ERR_FILE_NOT_FOUND).
// Round 3 kept the pages beside the asar instead, outside its integrity check, where a rewritten
// loading.js ran with the window's preload (S3-4). Now they stay inside the asar and the main
// process serves them on eden-app://, and the window's privileged IPC asks for the app's own
// page. node --test tests/web/page-path.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const APP = fileURLToPath(new URL('../../app/', import.meta.url));
const pages = require(path.join(APP, 'page-path.js'));
const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');

test('the pages are served from the app folder itself (inside app.asar in a build), nothing else', () => {
  const asar = '/Applications/Eden Code.app/Contents/Resources/app.asar';
  const asked = [];
  const readFile = (p) => { asked.push(p); return Buffer.from(`<${path.basename(p)}>`); };
  const got = pages.respond(asar, 'eden-app://app/loading.html?app=eden-code', { read: readFile });
  assert.equal(got.status, 200);
  assert.equal(got.type, 'text/html; charset=utf-8');
  assert.equal(String(got.body), '<loading.html>');
  assert.deepEqual(asked, [`${asar}/loading.html`], 'read inside the asar, never app.asar.unpacked');
  assert.equal(pages.respond(asar, 'eden-app://app/loading.js', { read: readFile }).type, 'text/javascript; charset=utf-8');
  assert.equal(pages.respond(asar, 'eden-app://app/daredevil-open.wav', { read: readFile }).type, 'audio/wav');
  // Anything that isn't one of the pages: the app's code, a climb out, another host or scheme.
  asked.length = 0;
  for (const url of ['eden-app://app/main.js', 'eden-app://app/preload.js', 'eden-app://app/../package.json',
    'eden-app://app/%2e%2e/package.json', 'eden-app://app/features/shell.js', 'eden-app://other/loading.html',
    'file:///Applications/x/loading.html', 'nonsense']) {
    assert.equal(pages.respond(asar, url, { read: readFile }).status, 404, url);
  }
  assert.deepEqual(asked, []);
  assert.equal(pages.respond(asar, 'eden-app://app/popout.html', { read: () => { throw new Error('gone'); } }).status, 404);
});

test('a page address carries its query, and only the app’s own pages count as its own', () => {
  const url = pages.pageUrl('loading.html', { app: 'eden-code', error: 'It broke & stopped' });
  assert.equal(`${new URL(url).protocol}//${new URL(url).host}`, pages.ORIGIN);
  assert.equal(new URL(url).searchParams.get('error'), 'It broke & stopped');
  assert.ok(pages.isOwnPage(url, 'loading.html'));
  assert.ok(!pages.isOwnPage(url, 'popout.html'));
  assert.ok(!pages.isOwnPage('file:///Applications/x/app.asar.unpacked/loading.html'));
  assert.ok(!pages.isOwnPage('http://127.0.0.1:5174/loading.html'));
  assert.deepEqual(pages.PRIVILEGES, [{ scheme: 'eden-app', privileges: { standard: true, secure: true, stream: true } }]);
});

test('every page the app loads is served on its scheme, and what it loads too; no build unpacks them', () => {
  for (const page of ['loading.html', 'hand-hud.html', 'popout.html']) {
    assert.ok(pages.PAGES.includes(page), page);
    for (const [, ref] of read(page).matchAll(/(?:src|href)="([^":]+)"/g)) assert.ok(pages.PAGES.includes(ref), `${page} loads ${ref}`);
  }
  for (const [, ref] of read('loading.js').matchAll(/new Audio\('([^']+)'\)/g)) assert.ok(pages.PAGES.includes(ref), `loading.js plays ${ref}`);
  const main = read('main.js');
  assert.doesNotMatch(main, /loadFile\(/, 'no page of the app is loaded by file:// any more');
  assert.match(main, /protocol\.registerSchemesAsPrivileged\(pages\.PRIVILEGES\)/);
  assert.match(main, /pages\.serve\(protocol, __dirname\);[^\n]*\n {2}createWindow\(\);/, 'served before the first window');
  assert.match(main, /win\.loadURL\(pages\.pageUrl\('loading\.html', \{ app: FLAVOR\.id/);
  assert.match(main, /win\.loadURL\(pages\.pageUrl\('loading\.html', \{ error: message/);
  assert.match(main, /hud\.loadURL\(pages\.pageUrl\('hand-hud\.html'\)\)/);
  assert.match(read('browser-parity.js'), /popWin\.loadURL\(require\('\.\/page-path'\)\.pageUrl\('popout\.html'\)\)/);
  assert.match(read('features/shell.js'), /pageUrl\('loading\.html', \{ error: /);
  assert.doesNotMatch(read('features/shell.js'), /loadFile\(/);
  // The builds keep them inside the asar (its integrity check covers them), and the Mac build says so.
  const dist = read('scripts/release/dist.js');
  assert.match(dist, /const UNPACK = '\*\*\/node_modules\/\{@xterm,@mediapipe\}\/\*\*';/);
  assert.match(dist, /the app's own pages must stay inside app\.asar/);
  assert.match(read('scripts/release/windows.js'), /asarUnpack: \['node_modules\/@xterm\/\*\*', 'node_modules\/@mediapipe\/\*\*'\],/);
});

// S3-4: the window's privileged IPC (browser:command and the rest) comes only from the window's
// own page on the app's origin, never its loading page or a page it was sent to.
test('the window’s IPC is only for a frame on the app’s own origin', () => {
  const main = read('main.js');
  const src = main.slice(main.indexOf('function appOrigin()'), main.indexOf('// The window on the backend'));
  // Run main.js's own two functions against stand-ins.
  const make = new Function('guards', 'DEV_URL', 'state', `
    let win = state.win; let port = state.port;
    ${src}
    return { fromAppPage, appOrigin, set(p) { port = p; } };`);
  const guards = require(path.join(APP, 'window-guards.js'));
  const contents = {};
  const win = { webContents: contents, isDestroyed: () => false };
  const f = make(guards, '', { win, port: 50123 });
  const ev = (url, sender = contents) => ({ sender, senderFrame: url == null ? null : { url } });
  assert.equal(f.fromAppPage(ev('http://127.0.0.1:50123/?token=abc&app=code')), true);
  assert.equal(f.fromAppPage(ev(pages.pageUrl('loading.html', { app: 'eden-code' }))), false, 'the loading page gets none');
  assert.equal(f.fromAppPage(ev('file:///Applications/x/app.asar.unpacked/loading.html')), false);
  assert.equal(f.fromAppPage(ev('http://127.0.0.1:50124/')), false, 'another port is another origin');
  assert.equal(f.fromAppPage(ev('https://example.com/')), false);
  assert.equal(f.fromAppPage(ev(null)), false, 'a frame that is gone');
  assert.equal(f.fromAppPage(ev('http://127.0.0.1:50123/', {})), false, 'another window');
  f.set(0);
  assert.equal(f.fromAppPage(ev('http://127.0.0.1:0/')), false, 'no backend yet: nothing');
  const dev = make(guards, 'http://localhost:5199/', { win, port: 5199 });
  assert.equal(dev.fromAppPage(ev('http://localhost:5199/?token=x')), true);
  assert.match(main, /const fromWindow = fromAppPage;/);
  assert.match(main, /fromWindow: fromAppPage,/);
});
