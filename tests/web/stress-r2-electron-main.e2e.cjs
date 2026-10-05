// Round 2's stress pass on the Electron main process: app/main.js itself, as it ships, with a
// fake backend in place of `uv run jarvis serve`, and hostile pages in its built-in browser.
// Nothing of the Mac is touched: HOME, userData and Downloads are a temp folder; the global
// shortcuts, the menu bar icon, the Dock, notifications, the Mac's boxes, the microphone
// prompt and login items are stubs; no window is ever shown; spawn runs only the fake
// backend; nothing leaves 127.0.0.1 (the host resolver maps every other name to nothing, and
// Node's own fetch and http refuse any other host).
//
//   app/node_modules/.bin/electron tests/web/stress-r2-electron-main.e2e.cjs     (about 60 s; exit 1 on a failure)
//
// STRESS_ONLY=<regex> runs only the tests whose names match (the backend's last: the crash loop
// leaves none running). Each test is named after the behaviour that should hold; a failing one
// is a defect found by the stress pass, not a flaky check. The numbers each one measured are
// printed at the end. The Keychain is never used (a mock one, and an app name of its own).
'use strict';

const Module = require('module');
const electron = require('electron');
const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

const { app, BrowserWindow, webContents: allContents } = electron;
const APP_DIR = path.join(__dirname, '..', '..', 'app');
const ROOT = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jarvis-stress-main-'));
const HOME = path.join(ROOT, 'home');
fs.mkdirSync(HOME, { recursive: true });
process.env.HOME = HOME; // main.js's ~/Library/Logs/Jarvis and the data folder land here
process.env.JARVIS_HOME = ROOT;
delete process.env.JARVIS_BACKEND_URL; // the app as it ships: it starts (and restarts) its backend
app.setPath('userData', path.join(ROOT, 'userData'));
app.setPath('downloads', path.join(ROOT, 'downloads'));
fs.mkdirSync(app.getPath('downloads'), { recursive: true });
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
app.commandLine.appendSwitch('renderer-process-limit', '6'); // a popup storm can't take the Mac's memory
// Never the Keychain: cookies and the like are encrypted with a stand-in key, and the app keeps
// a name of its own (main.js's 'J.A.R.V.I.S.' would name the installed app's Keychain item).
app.commandLine.appendSwitch('use-mock-keychain');
app.setName('jarvis-stress-r2');
app.setName = () => {};
if (os.homedir() !== HOME) throw new Error(`HOME is not the temp folder: ${os.homedir()}`);
const LOG_DIR = path.join(HOME, 'Library', 'Logs', 'Jarvis');
const STAGING = path.join(app.getPath('userData'), 'download-staging');

// ── nothing leaves 127.0.0.1 ──

const local = (host) => ['127.0.0.1', 'localhost', ''].includes(String(host || '').replace(/:\d+$/, ''));
const hostOfArgs = (a) => {
  try {
    if (typeof a === 'string' || a instanceof URL) return new URL(String(a)).hostname;
    return (a && (a.hostname || a.host)) || '';
  } catch { return '?'; }
};
for (const mod of [http, https]) {
  for (const name of ['request', 'get']) {
    const real = mod[name];
    mod[name] = function (...args) {
      if (!local(hostOfArgs(args[0]))) throw new Error(`the stress harness refuses ${hostOfArgs(args[0])}`);
      return real.apply(this, args);
    };
  }
}
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  let host = '?';
  try { host = new URL(typeof input === 'string' ? input : input.url || String(input)).hostname; } catch {}
  return local(host) ? realFetch(input, init) : Promise.reject(new Error(`offline: ${host}`));
};

// ── the Mac's side, stubbed ──

const record = { boxes: [], external: [], spawns: [], exits: [] };
const FAKES = {
  globalShortcut: { register: () => true, registerAll() {}, unregister() {}, unregisterAll() {}, isRegistered: () => false },
  Tray: class FakeTray {
    destroy() {} isDestroyed() { return false; } setImage() {} setPressedImage() {} setToolTip() {} setTitle() {}
    setContextMenu() {} popUpContextMenu() {} closeContextMenu() {} on() { return this; } once() { return this; }
    removeListener() { return this; } getBounds() { return { x: 0, y: 0, width: 0, height: 0 }; }
  },
  Notification: class FakeNotification { static isSupported() { return false; } show() {} close() {} on() { return this; } once() { return this; } },
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showOpenDialogSync: () => undefined,
    showSaveDialog: async () => ({ canceled: true }), showSaveDialogSync: () => undefined,
    showMessageBox: async (...a) => { record.boxes.push(a[a.length - 1]); return { response: 1, checkboxChecked: false }; },
    showMessageBoxSync: (...a) => { record.boxes.push(a[a.length - 1]); return 1; },
    showErrorBox: (title, content) => { record.boxes.push({ title, content }); },
    showCertificateTrustDialog: async () => {},
  },
  shell: { openExternal: async (url) => { record.external.push(url); }, openPath: async () => '', showItemInFolder() {}, beep() {}, trashItem: async () => {} },
  systemPreferences: new Proxy(electron.systemPreferences, {
    get(target, key) {
      if (key === 'askForMediaAccess') return async () => false;
      if (key === 'getMediaAccessStatus') return () => 'granted';
      if (key === 'canPromptTouchID') return () => false;
      if (key === 'promptTouchID') return async () => { throw new Error('no Touch ID in a test'); };
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }),
  powerSaveBlocker: { start: () => 1, stop() {}, isStarted: () => false },
  autoUpdater: { on() { return this; }, once() { return this; }, setFeedURL() {}, checkForUpdates() {}, quitAndInstall() {}, getFeedURL: () => '' },
};
const stubbed = new Proxy(electron, { get: (target, key) => (Object.hasOwn(FAKES, key) ? FAKES[key] : target[key]) });
const realLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (request === 'electron' && parent && String(parent.filename || '').startsWith(APP_DIR)) return stubbed;
  return realLoad.call(this, request, parent, ...rest);
};
Object.defineProperty(app, 'dock', {
  configurable: true,
  value: { setBadge() {}, getBadge: () => '', bounce: () => 0, cancelBounce() {}, setMenu() {}, getMenu: () => null, setIcon() {}, show: async () => {}, hide() {}, isVisible: () => true },
});
app.setLoginItemSettings = () => {};
app.setAsDefaultProtocolClient = () => true;
app.focus = () => {};
app.relaunch = () => {};
for (const name of ['show', 'showInactive', 'focus', 'moveTop']) BrowserWindow.prototype[name] = function () {};

// ── the fake backend: what `jarvis serve --port N` is to main.js ──

const FAKE_BACKEND = path.join(ROOT, 'fake-backend.cjs');
fs.writeFileSync(FAKE_BACKEND, `'use strict';
const http = require('http');
const port = Number(process.argv[2]);
const mode = process.env.STRESS_MODE || 'serve';
if (mode === 'crash') { process.stderr.write('Traceback (most recent call last):\\n  RuntimeError: boom\\n'); process.exit(1); }
if (mode === 'taken') process.exit(75);
// The window's page: what main.js loads once /health answers. It records what the main
// process tells it (the test reads window.__log).
const PAGE = \`<!doctype html><meta charset="utf-8"><title>stub window</title><script>
window.__log = { asks: 0, states: 0, stateBytes: 0, biggest: 0, maxTabs: 0, downloads: 0, downloadIds: new Set(), notes: 0, last: null };
const b = window.jarvisApp.browser;
b.onState((s) => { const n = JSON.stringify(s).length; __log.states++; __log.stateBytes += n; __log.biggest = Math.max(__log.biggest, n); __log.maxTabs = Math.max(__log.maxTabs, s.tabs.length); __log.last = s; });
b.onDownload((d) => { __log.downloads++; __log.downloadIds.add(d.id); });
b.onNote(() => { __log.notes++; });\nwindow.jarvisApp.feature.on('feature:browser:ask', () => { __log.asks++; });
</script><body>stub</body>\`;
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true,"busy":false}'); return; }
  if (url.pathname === '/exit') { res.end('bye'); setTimeout(() => process.exit(Number(url.searchParams.get('code')) || 0), 20); return; }
  if (url.pathname === '/noise') {
    // A chatty backend: INFO lines on stderr, as logging.basicConfig writes them.
    let left = Number(url.searchParams.get('bytes')) || 0;
    const line = '12:00:00 INFO uvicorn.access 127.0.0.1 - "GET /f/health HTTP/1.1" 200 ' + 'x'.repeat(940) + '\\n';
    const chunk = line.repeat(64);
    const more = () => { if (left <= 0) { res.end('done'); return; } left -= chunk.length; process.stderr.write(chunk, more); };
    more();
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
}).listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`);

let backendMode = 'serve';
const children = new Set();
const realSpawn = childProcess.spawn;
childProcess.spawn = function (command, args = [], opts = {}) {
  if (!Array.isArray(args) || !args.includes('serve')) throw new Error(`the stress harness refuses to spawn ${command}`);
  const port = args[args.indexOf('--port') + 1];
  const child = realSpawn(process.execPath, [FAKE_BACKEND, String(port)], {
    ...opts, env: { ...opts.env, ELECTRON_RUN_AS_NODE: '1', STRESS_MODE: backendMode },
  });
  record.spawns.push({ at: Date.now(), mode: backendMode, port: Number(port) });
  children.add(child);
  child.once('exit', (code) => { children.delete(child); record.exits.push({ at: Date.now(), code }); });
  return child;
};
childProcess.execFile = function (...args) {
  const done = args.find((a) => typeof a === 'function');
  if (done) setImmediate(() => done(new Error('the stress harness runs no commands'), '', ''));
  return { on() { return this; }, once() { return this; }, kill() {}, stdout: null, stderr: null };
};

// An ad blocker with one rule, cached as main.js caches the engine it builds from the lists,
// so it never fetches them.
{
  const { ElectronBlocker } = require(path.join(APP_DIR, 'node_modules', '@ghostery', 'adblocker-electron'));
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(path.join(app.getPath('userData'), 'adblock-engine.bin'), ElectronBlocker.parse('||ads.example^').serialize());
}

// ── hostile pages, on a server of the test's own ──

let bytesServed = new Map(); // path -> bytes written for it
let chainOn = true; // /chain opens another window as it loads
const count = (p, n) => bytesServed.set(p, (bytesServed.get(p) || 0) + n);
const html = (body, title = 'page') => `<!doctype html><meta charset="utf-8"><title>${title}</title><body>${body}</body>`;
const PAGES = {
  '/plain': () => html('<h1>A plain page</h1>', 'Plain'),
  // window.open in a loop, with no click: a popup storm.
  '/storm': (q) => html(`<script>for (let i = 0; i < ${Number(q.get('n')) || 40}; i++) window.open('/plain?storm=' + i);</script>`, 'Storm'),
  // Each page opens one more window as it loads, with no click: a chain of popups.
  '/chain': (q) => html(chainOn ? `<script>window.open('/chain?n=${(Number(q.get('n')) || 0) + 1}');</script>` : 'the chain stopped', 'Chain'),
  // Downloads the page starts by itself, with no click: a few every 300 ms, for a while.
  '/dlstorm': (q) => html(`<script>let wave = 0; const t = setInterval(() => {
    for (let i = 0; i < ${Number(q.get('n')) || 5}; i++) {
      const a = document.createElement('a'); a.href = '/file?i=' + wave + '-' + i; a.download = 'f.bin'; document.body.append(a); a.click(); a.remove(); }
    if (++wave >= ${Number(q.get('waves')) || 1}) clearInterval(t); }, 300);</script>`, 'Downloads'),
  // A favicon the page swaps for another, again and again (every other one sent without a
  // Content-Length).
  '/icons': (q) => html(`<script>
    let n = 0; const link = document.createElement('link'); link.rel = 'icon'; link.href = '/icon?n=0'; document.head.append(link);
    const t = setInterval(() => { link.href = '/icon?n=' + (++n) + (n % 2 ? '&chunked' : ''); if (n >= ${Number(q.get('n')) || 1}) clearInterval(t); }, 300);</script>`, 'Icons'),
  // A page with a 90 KB picture for its icon (a data: address, which main.js keeps as it is).
  '/bigicon': (q) => `<!doctype html><meta charset="utf-8"><title>Icon ${Number(q.get('i')) || 0}</title>`
    + `<link rel="icon" href="data:image/png;base64,${Buffer.alloc(67000, Number(q.get('i')) || 0).toString('base64')}"><body>icon</body>`,
  // A page asking for a permission again and again while its prompt is up.
  '/asks': (q) => html(`<script>let n = 0; const end = ${Number(q.get('n')) || 1000};
    (function more() { for (let i = 0; i < 500 && n < end; i++, n++) Notification.requestPermission(); if (n < end) setTimeout(more, 0); else document.title = 'asked ' + n; })();</script>`, 'Asks'),
  // A page that renames itself as fast as it can.
  '/titles': () => html(`<script>let n = 0; const end = Date.now() + 1500;
    (function loop() { for (let i = 0; i < 20; i++) document.title = 'T' + (n++); if (Date.now() < end) setTimeout(loop, 0); })();</script>`, 'T'),
  // A page that sends itself somewhere new as soon as it loads.
  '/hop': (q) => html(`<script>const n = ${Number(q.get('n')) || 0}; if (n < ${Number(q.get('max')) || 400}) location.replace('/hop?max=${Number(q.get('max')) || 400}&n=' + (n + 1));</script>`, 'Hop'),
};
function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/file') {
      const body = Buffer.alloc(64 * 1024, 7);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="f${url.searchParams.get('i')}.bin"`, 'content-length': body.length });
      res.end(body);
      count('/file', body.length);
      return;
    }
    if (url.pathname === '/icon') {
      // A "favicon" of 48 MB, sent as fast as the socket takes it (counted per icon, and with
      // no Content-Length for ?chunked, so the app finds out its size only as it reads).
      const chunk = Buffer.alloc(256 * 1024, 1);
      let left = 192;
      const key = `/icon?n=${url.searchParams.get('n')}`;
      res.writeHead(200, { 'content-type': 'image/png', ...(url.searchParams.has('chunked') ? {} : { 'content-length': chunk.length * left }) });
      const pump = () => {
        while (left > 0) {
          left -= 1;
          count(key, chunk.length);
          if (!res.write(chunk)) { res.once('drain', pump); return; }
        }
        res.end();
      };
      res.on('close', () => { left = 0; });
      pump();
      return;
    }
    const page = PAGES[url.pathname];
    if (!page) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page(url.searchParams));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ── helpers ──

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000, every = 50) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(every); }
  return fn();
}
let win = null; // main.js's window
let base = '';
const js = (code) => win.webContents.executeJavaScript(code, true);
const log = () => js('({ ...__log, downloadIds: __log.downloadIds.size, last: undefined, tabs: __log.last ? __log.last.tabs.length : 0 })');
const browserTabs = () => allContents.getAllWebContents().filter((wc) => !wc.isDestroyed() && wc.session === electron.session.fromPartition('persist:jarvis-browser') && wc.getType() !== 'remote');
const resetLog = () => js('__log.states = 0; __log.stateBytes = 0; __log.biggest = 0; __log.maxTabs = 0; __log.downloads = 0; __log.downloadIds.clear(); __log.notes = 0; true');
const go = (url) => js(`jarvisApp.browser.nav('go', ${JSON.stringify(url)})`);
// Back to one tab on a plain page (each test starts from there).
async function oneTab() {
  await go(`${base}/plain`);
  const ids = await js('(__log.last ? __log.last.tabs : []).filter((t) => !t.active).map((t) => t.id)');
  for (const id of ids) await js(`jarvisApp.browser.tab('close', ${id})`);
  await until(async () => (await js('__log.last ? __log.last.tabs.length : 0')) <= 1, 8000);
  await sleep(200);
  await resetLog();
}
const dirBytes = (dir) => { try { return fs.readdirSync(dir).reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0); } catch { return 0; } };
const dirFiles = (dir) => { try { return fs.readdirSync(dir).length; } catch { return 0; } };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(cond, message) { if (!cond) throw new Error(message); }
const numbers = []; // what held, and at what size (printed at the end)
const note = (line) => { numbers.push(line); };

// ── the built-in browser under hostile pages ──

test('A page opening windows by itself in a loop, with no click, can’t bury the browser in tabs', async () => {
  await oneTab();
  const rss0 = process.memoryUsage().rss;
  await go(`${base}/storm?n=40`);
  await until(async () => (await js('__log.maxTabs')) >= 41, 6000);
  await sleep(800);
  const r = await log();
  note(`popup storm of 40 window.open calls without a click: ${r.maxTabs} tabs, ${browserTabs().length} tab pages alive, main RSS +${Math.round((process.memoryUsage().rss - rss0) / 1e6)} MB`);
  // browser-agent.js caps the tabs pages open behind the one on show at TABS_MAX (30); Chrome
  // opens none without a click.
  assert(r.maxTabs <= 31, `40 window.open calls with no click opened ${r.maxTabs - 1} tabs`);
});

test('A chain of pages each opening one window as it loads, with no click, can’t bury the browser in tabs', async () => {
  await oneTab();
  chainOn = true;
  const rss0 = process.memoryUsage().rss;
  await go(`${base}/chain?n=0`);
  await sleep(4000);
  chainOn = false;
  const r = await log();
  const alive = browserTabs().length;
  note(`a chain of pages each opening one window with no click, for 4 s: ${r.maxTabs} tabs (${alive} tab pages alive), main RSS +${Math.round((process.memoryUsage().rss - rss0) / 1e6)} MB`);
  await sleep(500);
  assert(r.maxTabs <= 31, `the chain opened ${r.maxTabs - 1} tabs in 4 s, each the tab on show (past browser-agent.js's TABS_MAX of 30)`);
});

test('Downloads a page starts by itself, with no click, don’t all land on disk unasked', async () => {
  await oneTab();
  const before = dirFiles(STAGING);
  await go(`${base}/dlstorm?n=5&waves=10`);
  await sleep(4500);
  const r = await log();
  const staged = dirFiles(STAGING) - before;
  note(`a page starting 5 downloads every 300 ms, 10 times, with no click: ${staged} files staged on disk (${Math.round(dirBytes(STAGING) / 1024)} KB), ${r.downloadIds} download cards, ${r.downloads} download messages`);
  // Chrome lets a page start one download by itself and asks before more ("download multiple files").
  assert(staged <= 3 && r.downloadIds <= 3, `${staged} downloads were written to disk and ${r.downloadIds} shown, none of them asked for`);
});

test('A page swapping its favicon never makes the app download more than a favicon’s worth', async () => {
  await oneTab();
  bytesServed = new Map();
  // What the app itself reads of each icon: the tabs' session's fetch, counted as its body is
  // read (main.js reads icons through it).
  const ses = electron.session.fromPartition('persist:jarvis-browser');
  const ownFetch = ses.fetch;
  const read = new Map(); // icon address -> bytes the app read of it
  ses.fetch = async function (input, init) {
    const res = await ownFetch.call(this, input, init);
    const url = typeof input === 'string' ? input : String((input && input.url) || input);
    if (!res.body || !url.includes('/icon?')) return res;
    read.set(url, 0);
    const counted = res.body.pipeThrough(new TransformStream({ transform(chunk, out) { read.set(url, read.get(url) + chunk.byteLength); out.enqueue(chunk); } }));
    return new Response(counted, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  const rss0 = process.memoryUsage().rss;
  let peak = rss0;
  const watch = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
  try {
    await go(`${base}/icons?n=4`);
    await sleep(4000);
  } finally {
    clearInterval(watch);
    ses.fetch = ownFetch;
  }
  const icons = [...bytesServed].filter(([p]) => p.startsWith('/icon'));
  const served = icons.reduce((n, [, bytes]) => n + bytes, 0);
  const most = Math.max(0, ...icons.map(([, bytes]) => bytes));
  const readAll = [...read.values()].reduce((n, bytes) => n + bytes, 0);
  const readMost = Math.max(0, ...read.values());
  note(`a page swapping its favicon 4 times (48 MB each): ${icons.length} icons asked for, the app read ${Math.round(readAll / 1024)} KB of them (at most ${Math.round(readMost / 1024)} KB of one); ${Math.round(served / 1e6)} MB sent (at most ${Math.round(most / 1e5) / 10} MB for one), main RSS peak +${Math.round((peak - rss0) / 1e6)} MB`);
  // faviconData keeps an icon only up to 64 KB: what the app reads of each stops about there
  // (a chunk or two past it). The server counts what it wrote, which the sockets' buffers and
  // Chromium's reading ahead also take, a few MB of each response at most before the app's
  // refusal closes it: an icon well short of its 48 MB is one the network gave up too.
  assert(read.size >= 2, `the app read the page's icon ${read.size} times through its tabs' session`);
  assert(readMost < 512 * 1024, `the app read ${Math.round(readMost / 1e6)} MB of one favicon, ${Math.round(readAll / 1e6)} MB of ${read.size}, to keep none of them (main RSS peaked ${Math.round((peak - rss0) / 1e6)} MB higher)`);
  assert(most < 12 * 1024 * 1024, `the server sent ${Math.round(most / 1e6)} MB of one favicon, ${Math.round(served / 1e6)} MB of ${icons.length}, after the app had stopped reading`);
});

test('A page renaming itself in a tight loop sends the window a bounded stream of tab-strip updates', async () => {
  await oneTab();
  await go(`${base}/titles`);
  await sleep(2200);
  const r = await log();
  note(`a page setting document.title in a loop for 1.5 s: ${r.states} browser:state messages to the window (${Math.round(r.stateBytes / 1024)} KB)`);
  assert(r.states <= 200, `${r.states} tab-strip updates in 2 s`);
});

test('A page renaming itself in a tight loop beside a dozen tabs with pictures for icons leaves the main process and the window responsive', async () => {
  await oneTab();
  for (let i = 1; i <= 12; i++) await js(`jarvisApp.browser.tab('new', 0, ${JSON.stringify(`${base}/bigicon?i=${i}`)})`);
  await until(async () => (await js('__log.last ? __log.last.tabs.filter((t) => (t.favicon || "").length > 80000).length : 0')) >= 12, 10000);
  await js(`jarvisApp.browser.tab('new', 0, ${JSON.stringify(`${base}/titles`)})`);
  await resetLog();
  await js(`window.__lag = { worst: 0 }; { let last = performance.now(); window.__tick = setInterval(() => { const now = performance.now(); __lag.worst = Math.max(__lag.worst, now - last - 50); last = now; }, 50); } true`);
  let mainWorst = 0;
  let mainLast = performance.now();
  const mainTick = setInterval(() => { const now = performance.now(); mainWorst = Math.max(mainWorst, now - mainLast - 10); mainLast = now; }, 10);
  const cpu0 = process.cpuUsage();
  await sleep(2200);
  clearInterval(mainTick);
  const cpu = process.cpuUsage(cpu0);
  const r = await log();
  const worst = await js('clearInterval(__tick); Math.round(__lag.worst)');
  note(`a title loop beside 12 tabs with 90 KB icons: ${r.states} browser:state messages, ${Math.round(r.stateBytes / 1e6)} MB to the window (largest ${Math.round(r.biggest / 1024)} KB, every tab's icon in each); window event loop late by up to ${worst} ms, main's by ${Math.round(mainWorst)} ms, main CPU ${Math.round((cpu.user + cpu.system) / 1000)} ms in 2.2 s`);
  assert(worst < 100 && mainWorst < 100, `the window's event loop was ${worst} ms late, the main process's ${Math.round(mainWorst)} ms`);
});

test('A page asking for the same permission over and over while its prompt is up holds a bounded number of answers', async () => {
  await oneTab();
  const gc = (() => { require('v8').setFlagsFromString('--expose_gc'); return require('vm').runInNewContext('gc'); })();
  gc();
  const heap0 = process.memoryUsage().heapUsed;
  const t0 = Date.now();
  let mainWorst = 0;
  let mainLast = performance.now();
  const mainTick = setInterval(() => { const now = performance.now(); mainWorst = Math.max(mainWorst, now - mainLast - 10); mainLast = now; }, 10);
  await go(`${base}/asks?n=6000`);
  await until(async () => /^asked/.test(String(await js('__log.last && __log.last.title'))), 60000, 100);
  const took = Date.now() - t0;
  clearInterval(mainTick);
  await sleep(300);
  gc();
  const grew = process.memoryUsage().heapUsed - heap0;
  const asks = await js('__log.asks');
  note(`a page calling Notification.requestPermission() 6,000 times with its prompt up: ${took} ms, main heap +${Math.round(grew / 1e6)} MB after GC, main event loop late by up to ${Math.round(mainWorst)} ms, ${asks} prompts sent to the window`);
  assert(grew < 1.5e6, `the main process holds ${Math.round(grew / 1e6)} MB more after the page asked 6,000 times (one waiting answer per ask)`);
});

test('A page that keeps sending itself to a new address can’t push the owner’s history out', async () => {
  await oneTab();
  const file = path.join(app.getPath('userData'), 'browser.json');
  const t0 = Date.now();
  await go(`${base}/hop?max=700&n=0`);
  await until(async () => String(await js('__log.last && __log.last.url')).includes('n=700'), 30000, 100);
  const took = Date.now() - t0;
  await until(() => { try { return fs.readFileSync(file, 'utf8').includes('n=700'); } catch { return false; } }, 5000);
  const history = JSON.parse(fs.readFileSync(file, 'utf8')).history;
  const owner = history.filter((h) => h.url.startsWith('https://owner.example/')).length;
  const hops = history.filter((h) => h.url.includes('/hop?')).length;
  note(`a page replacing itself 700 times (${took} ms, no click): browser.json keeps ${owner} of the owner's 1,500 visits and ${hops} of its hops`);
  assert(owner === 1500, `the page's redirects pushed ${1500 - owner} of the owner's 1,500 visits out of the history (it holds ${hops} hops)`);
});

// ── the backend: a chatty one, then one that keeps crashing ──

test('A chatty backend never grows backend.log past its 5 MB (as main.js promises)', async () => {
  const port = record.spawns[record.spawns.length - 1].port;
  const file = path.join(LOG_DIR, 'backend.log');
  const size0 = fs.statSync(file).size;
  await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: `/noise?bytes=${12 * 1024 * 1024}` }, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject);
  });
  await sleep(500);
  const size = fs.statSync(file).size;
  const rotated = fs.existsSync(path.join(LOG_DIR, 'backend.1.log'));
  note(`12 MB of INFO lines from a running backend: backend.log ${Math.round(size0 / 1024)} KB -> ${Math.round(size / 1e6 * 10) / 10} MB, rotated: ${rotated}`);
  assert(size <= 6 * 1024 * 1024, `backend.log grew to ${Math.round(size / 1e6)} MB while the backend ran (BACKEND_LOG_MAX is 5 MB, checked only at a start)`);
});

let restartsUsed = 0; // restarts main.js counted (three in five minutes, then it stops)
test('A backend killed by a signal is said so in words, then comes back', async () => {
  const spawned = record.spawns.length;
  const victim = [...children][0];
  victim.kill('SIGKILL'); // as macOS's memory pressure or Activity Monitor's Force Quit ends it
  restartsUsed += 1;
  const said = await until(() => /error=/.test(win.webContents.getURL()) && decodeURIComponent(win.webContents.getURL().split('error=')[1].replace(/\+/g, ' ')), 3000, 20);
  await until(() => record.spawns.length > spawned && /\?token=/.test(win.webContents.getURL()), 10000);
  const back = /\?token=/.test(win.webContents.getURL());
  note(`a backend ended by SIGKILL: the window said "${said}", and ${back ? 'came back' : 'did not come back'} with backend #${record.spawns.length}`);
  assert(back, 'the backend never came back');
  assert(said && !/\bnull\b|undefined/.test(said), `the window said "${said}"`);
  await until(() => js('typeof window.__log === "object"').catch(() => false), 10000);
});

test('A backend that keeps crashing is restarted three times, then the window says so and nothing more starts', async () => {
  const port = record.spawns[record.spawns.length - 1].port;
  const spawned = record.spawns.length;
  backendMode = 'crash';
  await new Promise((resolve) => { http.get({ host: '127.0.0.1', port, path: '/exit?code=1' }, (res) => { res.resume(); res.on('end', resolve); }).on('error', resolve); });
  const t0 = Date.now();
  await until(() => win.webContents.getURL().includes('three%20times') || win.webContents.getURL().includes('three+times'), 15000, 100);
  const took = Date.now() - t0;
  await sleep(5000); // nothing else starts
  const restarts = record.spawns.length - spawned;
  const url = decodeURIComponent(win.webContents.getURL().replace(/\+/g, ' '));
  note(`a backend crashing at every start: ${restarts} restarts in ${took} ms (after ${restartsUsed} earlier), then "${url.split('error=')[1] || url}"`);
  assert(restarts === 3 - restartsUsed, `${restarts} restarts after ${restartsUsed} earlier ones`);
  assert(/three times in five minutes/.test(url), `the window shows ${url}`);
  assert(children.size === 0, `${children.size} backends still running`);
});

// ── run ──

const errors = [];
process.on('uncaughtException', (err) => { errors.push(`uncaught: ${err && err.stack}`); });
process.on('unhandledRejection', (err) => { errors.push(`unhandled rejection: ${err && err.stack}`); });

function finish(code) {
  for (const child of children) { try { child.kill('SIGKILL'); } catch {} }
  app.exit(code);
}
setTimeout(() => { console.error('the stress run took too long'); finish(1); }, 240000).unref();
process.on('exit', () => {
  for (const child of children) { try { child.kill('SIGKILL'); } catch { /* gone */ } }
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* gone already */ }
});

(async () => {
  const server = await serve();
  base = `http://127.0.0.1:${server.address().port}`;
  // The owner's history before any page: 1,500 visits.
  fs.writeFileSync(path.join(app.getPath('userData'), 'browser.json'), JSON.stringify({
    history: Array.from({ length: 1500 }, (_, i) => ({ url: `https://owner.example/page/${i}`, title: `Owner page ${i}`, at: Date.now() - (1500 - i) * 60000 })),
    bookmarks: [], adblock: true, researchLock: false, allow: [],
  }));
  require(path.join(APP_DIR, 'main.js'));
  await app.whenReady();
  win = await until(() => BrowserWindow.getAllWindows()[0], 10000);
  if (!win) throw new Error('main.js made no window');
  await until(() => /^http:\/\/127\.0\.0\.1:\d+\/\?token=/.test(win.webContents.getURL()) && !win.webContents.isLoading(), 30000);
  await until(() => js('typeof window.__log === "object"').catch(() => false), 10000);
  await js(`jarvisApp.browser.nav('go', ${JSON.stringify(`${base}/plain`)})`);
  await js('jarvisApp.browser.show({ x: 0, y: 0, width: 1000, height: 700 })');
  await until(async () => (await js('__log.last && __log.last.url')) === `${base}/plain`, 10000);

  let passed = 0;
  let failed = 0;
  // STRESS_ONLY=<regex>: only the tests whose names match (the rest are skipped).
  const only = process.env.STRESS_ONLY ? new RegExp(process.env.STRESS_ONLY, 'i') : null;
  for (const t of tests.filter((x) => !only || only.test(x.name))) {
    const before = errors.length;
    try {
      await t.fn();
      if (errors.length > before) throw new Error(errors.slice(before).join('\n'));
      passed += 1;
      console.log(`ok   ${t.name}`);
    } catch (err) {
      failed += 1;
      console.log(`FAIL ${t.name}\n     ${String(err && err.message ? err.message : err).split('\n').join('\n     ')}`);
    }
  }
  console.log('\nnumbers:');
  for (const line of numbers) console.log(`  ${line}`);
  console.log(`\n${passed} passed, ${failed} failed`);
  server.close();
  finish(failed ? 1 : 0);
})().catch((err) => { console.error(err && err.stack); finish(1); });
