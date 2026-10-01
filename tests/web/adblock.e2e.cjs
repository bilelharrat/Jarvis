// The browser's ad blocker inside the page (app/adblock.js, app/adblock-preload.js) in a
// real Chromium, offline: pages are served on 127.0.0.1 under made-up names (site.test,
// frame.test, allowed.test), and the engine is built from a few filters and scriptlets
// here, so nothing is fetched. Nothing is shown and nothing plays out loud.
//
//   app/node_modules/.bin/electron tests/web/adblock.e2e.cjs      (a few seconds; exit 1 on a failure)
'use strict';

const path = require('path');
const APP = path.join(__dirname, '..', '..', 'app');
module.paths.unshift(path.join(APP, 'node_modules'));
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');

app.setPath('userData', fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jarvis-adblock-test-')));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP *.test 127.0.0.1, MAP * ~NOTFOUND');
app.on('window-all-closed', () => {});
app.on('browser-window-created', (_event, win) => win.webContents.setAudioMuted(true));

// Two scriptlets that share a helper declared as a class, as uBlock's json-prune and its
// kin share JSONPath: both must run, in the page's world, before the page's own scripts.
const RESOURCES = {
  redirects: [],
  scriptlets: [
    { name: 'jarvis-helper.fn', aliases: [], dependencies: [],
      body: 'class JarvisHelper { static mark(key, value) { Object.defineProperty(window, key, { value, configurable: true }); } }' },
    { name: 'jarvis-flag.js', aliases: ['jarvis-flag'], dependencies: ['jarvis-helper.fn'],
      body: 'function jarvisFlag(key, value) { JarvisHelper.mark(key, value); }' },
  ],
};
const FILTERS = [
  'site.test##+js(jarvis-flag, jarvisFirst, yes)',
  'site.test##+js(jarvis-flag, jarvisSecond, yes)',
  'site.test##.site-ad',
  '##.generic-ad',
  'site.test##div.post:has-text(Sponsored)',
  'site.test##.gone:remove()',
  'frame.test##+js(jarvis-flag, jarvisFrame, yes)',
  'allowed.test##+js(jarvis-flag, jarvisFirst, yes)',
  'allowed.test##.site-ad',
].join('\n');

const PAGE = `<!doctype html><html><head><script>
  document.documentElement.dataset.first = String(window.jarvisFirst);
  document.documentElement.dataset.second = String(window.jarvisSecond);
</script></head><body>
<div class="site-ad">ad</div>
<script>document.documentElement.dataset.paint = getComputedStyle(document.querySelector('.site-ad')).display;</script>
<div class="post" id="sponsored">Sponsored · Buy now</div><div class="post" id="normal">A friend's post</div>
<div class="gone">remove me</div>
<iframe src="http://frame.test:PORT/frame.html"></iframe>
<script>setTimeout(() => {
  const ad = document.createElement('div'); ad.className = 'generic-ad'; ad.id = 'late'; document.body.append(ad);
  const post = document.createElement('div'); post.className = 'post'; post.id = 'late-post'; post.textContent = 'Sponsored, later'; document.body.append(post);
}, 300);</script></body></html>`;
const FRAME = `<!doctype html><html><head><script>document.documentElement.dataset.flag = String(window.jarvisFrame);</script></head>
<body><div class="generic-ad">frame ad</div></body></html>`;

let port = 0;
function serve() {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    const body = pathname === '/frame.html' ? FRAME : pathname === '/' ? PAGE : null;
    if (!body) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(body.replace('PORT', String(port)));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ses;
async function open(host, wait = 900) {
  const win = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: {
    partition: 'persist:adblock-test', preload: path.join(APP, 'page-preload.js'),
    sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true } });
  await win.loadURL(`http://${host}:${port}/`);
  await sleep(wait);
  return win;
}
const inPage = (win, code) => win.webContents.executeJavaScript(code);
const inFrame = (win, code) => win.webContents.mainFrame.frames[0].executeJavaScript(code);
const display = (sel) => `getComputedStyle(document.querySelector(${JSON.stringify(sel)})).display`;

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(cond, message) { if (!cond) throw new Error(message); }

test('Scriptlets run before the page’s own scripts, each with its own helpers', async () => {
  const win = await open('site.test');
  const r = await inPage(win, '({ ...document.documentElement.dataset })');
  assert(r.first === 'yes', `the first scriptlet ran after the page (it saw ${r.first})`);
  assert(r.second === 'yes', `the second scriptlet, sharing the first's helper, didn't run (${r.second})`);
  win.destroy();
});

test('A site’s ads are hidden before the first paint', async () => {
  const win = await open('site.test');
  assert(await inPage(win, 'document.documentElement.dataset.paint') === 'none', 'the ad showed before it was hidden');
  win.destroy();
});

test('Ads that appear later are hidden as they come', async () => {
  const win = await open('site.test');
  assert(await inPage(win, display('#late')) === 'none', 'a late ad stayed visible');
  win.destroy();
});

test('Procedural rules hide what they match, keep the rest, and catch late arrivals', async () => {
  const win = await open('site.test');
  const r = await inPage(win, `({ sponsored: ${display('#sponsored')}, normal: ${display('#normal')}, late: ${display('#late-post')}, gone: !!document.querySelector('.gone') })`);
  assert(r.sponsored === 'none', 'a sponsored post stayed');
  assert(r.normal !== 'none', 'an ordinary post was hidden');
  assert(r.late === 'none', 'a sponsored post added later stayed');
  assert(!r.gone, ':remove() left its element');
  win.destroy();
});

test('Frames get their scriptlets and hiding too; the hand stays in the page', async () => {
  const win = await open('site.test');
  const r = await inFrame(win, `({ flag: document.documentElement.dataset.flag, ad: ${display('.generic-ad')}, hand: !!document.querySelector('jarvis-hand') })`);
  assert(r.flag === 'yes', `the frame's scriptlet ran late or not at all (${r.flag})`);
  assert(r.ad === 'none', 'an ad in a frame stayed visible');
  assert(!r.hand, 'the hand cursor was drawn inside a frame');
  assert(await inPage(win, '!!document.querySelector("jarvis-hand")'), 'the hand cursor is missing from the page');
  win.destroy();
});

test('Nothing is changed on a page that isn’t shielded (an allowed site)', async () => {
  const win = await open('allowed.test');
  const r = await inPage(win, `({ first: document.documentElement.dataset.first, ad: ${display('.site-ad')} })`);
  assert(r.first === 'undefined', 'a scriptlet ran on an allowed site');
  assert(r.ad !== 'none', 'an ad was hidden on an allowed site');
  win.destroy();
});

app.whenReady().then(async () => {
  const { ElectronBlocker } = require('@ghostery/adblocker-electron');
  const engine = ElectronBlocker.parse(FILTERS, { loadCosmeticFilters: true, loadExtendedSelectors: true, enableMutationObserver: true });
  engine.updateResources(JSON.stringify(RESOURCES), 'test');
  ses = session.fromPartition('persist:adblock-test');
  require(path.join(APP, 'adblock.js')).attach(ses, {
    engine: () => engine,
    shielded: (page) => !/^https?:\/\/allowed\.test[:/]/.test(page),
  });
  await serve();
  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); console.log(`ok     ${name}`); } catch (err) { failed += 1; console.log(`FAIL   ${name}\n       ${err.message}`); }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  app.exit(failed ? 1 : 0);
});
