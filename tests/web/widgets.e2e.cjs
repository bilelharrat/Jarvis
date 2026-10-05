// The dashboard's pinned widgets (web/features/widgets.js) in a real Chromium: a list of them
// that comes again puts only what changed in the page. A widget already there stays where it
// is and isn't loaded again (taken out and put back, a frame loads its widget afresh: the
// backend's document fetched, its scripts run again). No backend: Node serves the window's
// files and the widgets' documents on 127.0.0.1, and counts what each widget fetched.
//
//   app/node_modules/.bin/electron tests/web/widgets.e2e.cjs      (a few seconds; exit 1 on a failure)
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const WEB = path.join(__dirname, '..', '..', 'src', 'jarvis', 'web');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

const USER_DATA = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jarvis-widgets-test-'));
app.setPath('userData', USER_DATA);
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');

const fetched = new Map();  // widget id -> times its document was asked for

function serve() {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
    const widget = /^\/f\/widgets\/([A-Za-z0-9_-]+)$/.exec(pathname);
    if (widget) {
      fetched.set(widget[1], (fetched.get(widget[1]) || 0) + 1);
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><p>${widget[1]}</p>`);
      return;
    }
    const feature = pathname.startsWith('/static/features/') ? `features/${path.basename(pathname)}` : '';
    const name = pathname === '/' ? 'index.html' : feature || (pathname.startsWith('/static/') ? path.basename(pathname) : '');
    fs.readFile(path.join(WEB, name || '-'), (err, data) => {
      if (err || !name) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(name)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let win;
let base;
const js = (code) => win.webContents.executeJavaScript(code, true);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(cond, message) { if (!cond) throw new Error(message); }

const id = (name) => `${name}-Abcdefghijklmnopqrs`;
const pinned = (name, height = 220) => ({ id: id(name), title: `Widget ${name}`, url: `/f/widgets/${id(name)}`, scripts: false, height, made: '', pinned: true });
const counts = () => Object.fromEntries([...fetched].map(([k, n]) => [k.split('-')[0], n]).sort());

// A fresh window with widgets.js put in as features.js would (its stylesheet first).
async function fresh() {
  await win.loadURL(`${base}/?token=test`);
  await js(`
    window.__sent = [];
    send = (m) => { __sent.push(m); return true; };
    heard({ type: 'hello', hub_id: 'hub-a', seq: 1, state: 'idle', muted: true, status: {}, activity: [], tasks: [],
      prefs: { look: 'glass', language: 'en', models: [], personas: [], humor: 50, features: {} }, brain: {}, approvals: [], history: [] });
    new Promise((resolve) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/static/features/widgets.css';
      link.onload = resolve;
      document.head.append(link);
    });
  `);
  await js(`${fs.readFileSync(path.join(WEB, 'features', 'widgets.js'), 'utf8')}\n;true`);
  await js(`heard({ type: 'hello', hub_id: 'hub-a', seq: 2, state: 'idle', muted: true, status: {}, activity: [], tasks: [],
    prefs: { look: 'glass', language: 'en', models: [], personas: [], humor: 50, features: {} }, brain: {}, approvals: [], history: [], replay: true }); true`);
  fetched.clear();
}

// The list as the page has it: each item's widget, and its frame (tagged, to tell a frame kept
// from one made again).
const board = () => js(`[...$('wg-list').children].map((n) => [n.dataset.widget.split('-')[0], n.querySelector('iframe').__tag || (n.querySelector('iframe').__tag = Math.random().toString(36).slice(2))])`);
async function show(list) {
  await js(`heard(${JSON.stringify({ type: 'widgets', pinned: list, error: '' })}); true`);
  // (each new frame's document asked for, and nothing more)
  for (let i = 0; i < 100; i++) {
    await sleep(30);
    const want = await js(`$('wg-list').querySelectorAll('iframe').length`);
    if ([...fetched.values()].reduce((a, b) => a + b, 0) >= want && i > 9) break;  // (and a moment for a reload to show)
  }
}

test('A widget on the dashboard is loaded once, however often the list comes again', async () => {
  await show([pinned('a'), pinned('b')]);
  const first = await board();
  assert(JSON.stringify(first.map(([w]) => w)) === '["a","b"]', JSON.stringify(first));
  assert(JSON.stringify(counts()) === '{"a":1,"b":1}', `first drawn: ${JSON.stringify(counts())}`);
  // The same list again (a reconnect's hello asks for it): nothing loads again, nothing moves.
  await show([pinned('a'), pinned('b')]);
  assert(JSON.stringify(await board()) === JSON.stringify(first), JSON.stringify(await board()));
  assert(JSON.stringify(counts()) === '{"a":1,"b":1}', `the same list again: ${JSON.stringify(counts())}`);
  // One more pinned: only it loads.
  await show([pinned('a'), pinned('b'), pinned('c')]);
  const three = await board();
  assert(JSON.stringify(three.slice(0, 2)) === JSON.stringify(first) && three[2][0] === 'c', JSON.stringify(three));
  assert(JSON.stringify(counts()) === '{"a":1,"b":1,"c":1}', `one more: ${JSON.stringify(counts())}`);
  // The first taken off: the others stay as they are.
  await show([pinned('b'), pinned('c')]);
  assert(JSON.stringify(await board()) === JSON.stringify(three.slice(1)), JSON.stringify(await board()));
  assert(JSON.stringify(counts()) === '{"a":1,"b":1,"c":1}', `one taken off: ${JSON.stringify(counts())}`);
  // Its height changed: it's drawn (and loaded) again; the other stays.
  await show([pinned('b', 400), pinned('c')]);
  const taller = await board();
  assert(taller[0][0] === 'b' && taller[0][1] !== three[1][1] && JSON.stringify(taller[1]) === JSON.stringify(three[2]), JSON.stringify(taller));
  assert(await js(`$('wg-list').querySelector('iframe').height`) === '400', 'the new height');
  assert(JSON.stringify(counts()) === '{"a":1,"b":2,"c":1}', `taller: ${JSON.stringify(counts())}`);
  // In another order: as listed.
  await show([pinned('c'), pinned('b', 400)]);
  const swapped = await board();
  assert(JSON.stringify(swapped) === JSON.stringify([taller[1], taller[0]]), JSON.stringify(swapped));
  // None left: the dashboard goes.
  await show([]);
  assert(await js(`$('wg-list').children.length === 0 && $('p-widgets').hidden`), 'the dashboard is still there');
});

test('A widget listed twice is on the dashboard once, where it’s listed last', async () => {
  await show([pinned('a'), pinned('b')]);
  const first = await board();
  await show([pinned('a'), pinned('b'), pinned('a')]);
  const now = await board();
  assert(JSON.stringify(now) === JSON.stringify([first[1], first[0]]), JSON.stringify(now));
});

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const server = await serve();
  base = `http://127.0.0.1:${server.address().port}`;
  win = new BrowserWindow({ show: false, width: 1280, height: 840, webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true } });
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error' && !/Failed to load resource|WebSocket|ERR_NAME_NOT_RESOLVED|fonts\./.test(e.message)) errors.push(e.message); });
  let failed = 0;
  for (const t of tests) {
    errors.length = 0;
    try {
      await win.loadURL('about:blank');
      await fresh();
      await t.fn();
      if (errors.length) throw new Error(`page errors: ${errors.join(' | ')}`);
      console.log(`ok     ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`FAILED ${t.name}\n       ${err.message}`);
    }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  server.close();
  win.destroy();
  try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch (_) { /* best effort: the run's own profile */ }
  app.exit(failed ? 1 : 0);
});
