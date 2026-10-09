// Pages made usable with a screen reader, the window's side (src/jarvis/web/features/
// page_a11y.js) in a real Chromium, with no backend: Node serves the window's files on
// 127.0.0.1, the hub's events go to heard(), and the app's bridge (window.jarvisApp) is a
// recorder. It tells the app to mend pages while screen-reader mode is on and the setting
// isn't off, puts that setting in Settings › Accessibility, and passes the hub's calls on.
// No window is shown, nothing leaves 127.0.0.1.
//
//   app/node_modules/.bin/electron tests/web/page-a11y-window.e2e.cjs      (about 5 s; exit 1 on a failure)
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const WEB = process.env.JARVIS_WEB_DIR || path.join(__dirname, '..', '..', 'src', 'jarvis', 'web');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
app.setPath('userData', fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jarvis-page-a11y-window-test-')));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');

function serve() {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://127.0.0.1');
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
const script = (name) => js(`new Promise((resolve, reject) => {
  const s = document.createElement('script');
  s.src = '/static/features/${name}';
  s.onload = () => resolve(true);
  s.onerror = () => reject(new Error('no ${name}'));
  document.body.append(s);
})`);

// A fresh window: the hub's hello, send() and the app's bridge recorded, both features loaded.
async function fresh(features = {}) {
  await win.loadURL(`${base}/?token=test`);
  await js(`
    window.__sent = [];
    window.__app = [];
    send = (m) => __sent.push(m);
    window.jarvisApp = { feature: {
      send: (channel, value) => __app.push([channel, value]),
      invoke: async (channel, message) => ({ ok: true, channel, title: 'Soup', asked: message }),
    } };
    heard({ type: 'hello', hub_id: 'hub-a', state: 'idle', muted: true, status: {}, activity: [], tasks: [],
      prefs: { look: 'orb', language: 'en', models: [], personas: [], humor: 50 }, brain: {}, approvals: [], history: [] });
    true;`);
  await script('accessibility.js');
  await script('page_a11y.js');
  await js(`heard({ type: 'prefs', features: ${JSON.stringify({ a11y_mode: 'on', ...features })} }); true`);
  await sleep(50);
}
const told = () => js('__app.filter(([c]) => c === "feature:page-a11y:mode").map(([, v]) => v)');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(cond, message) { if (!cond) throw new Error(message); }

test('With screen-reader mode on, the app is told to mend pages; off, it is told to stop', async () => {
  await fresh();
  await js(`heard({ type: 'a11y', effective: true, reader_speaks: true, detected: true }); true`);
  assert(JSON.stringify(await told()) === '[true]', `told ${JSON.stringify(await told())}`);
  await js(`heard({ type: 'a11y', effective: true, reader_speaks: true, detected: true }); true`);
  assert(JSON.stringify(await told()) === '[true]', 'told twice');
  await js(`heard({ type: 'a11y', effective: false, reader_speaks: false, detected: false }); true`);
  assert(JSON.stringify(await told()) === '[true,false]', `told ${JSON.stringify(await told())}`);
});

test('Settings › Accessibility has the switch, and turning it off tells the hub and the app', async () => {
  await fresh();
  await js(`heard({ type: 'a11y', effective: true, reader_speaks: true, detected: true }); true`);
  const row = await js(`(() => { const r = document.getElementById('page-a11y-row'); const sw = r && r.querySelector('[role="switch"]');
    return r && { inGroup: r.parentElement.id, checked: sw.getAttribute('aria-checked'), label: sw.getAttribute('aria-label') }; })()`);
  assert(row && row.inGroup === 'a11y-group' && row.checked === 'true' && row.label === 'Make web pages easier to read', JSON.stringify(row));
  await js(`document.querySelector('#page-a11y-row [role="switch"]').click(); true`);
  const prefs = await js('__sent.filter((m) => m.type === "feature_prefs").map((m) => m.changes)');
  assert(JSON.stringify(prefs) === '[{"a11y_page_fixes":false}]', JSON.stringify(prefs));
  assert(JSON.stringify(await told()) === '[true,false]', `told ${JSON.stringify(await told())}`);
  assert(await js(`document.querySelector('#page-a11y-row [role="switch"]').getAttribute('aria-checked')`) === 'false', 'switch still on');
});

test('With the setting off, screen-reader mode alone doesn\'t mend pages', async () => {
  await fresh({ a11y_page_fixes: false });
  await js(`heard({ type: 'a11y', effective: true, reader_speaks: true, detected: true }); true`);
  assert(!(await told()).includes(true), `told ${JSON.stringify(await told())}`);
});

test('The hub\'s calls are passed to the app and answered', async () => {
  await fresh();
  await js(`heard({ type: 'page_a11y_cmd', id: 'c1', action: 'summary', args: { tab: 3 } }); true`);
  await sleep(50);
  const answers = await js('__sent.filter((m) => m.type === "page_a11y_result")');
  assert(answers.length === 1 && answers[0].id === 'c1' && answers[0].result.channel === 'feature:page-a11y:call'
    && answers[0].result.asked.action === 'summary' && answers[0].result.asked.args.tab === 3, JSON.stringify(answers));
});

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const server = await serve();
  base = `http://127.0.0.1:${server.address().port}`;
  win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { sandbox: true, contextIsolation: true } });
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok     ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`FAILED ${t.name}\n       ${String(err.message).split('\n').join('\n       ')}`);
    }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  server.close();
  app.exit(failed ? 1 : 0);
});
