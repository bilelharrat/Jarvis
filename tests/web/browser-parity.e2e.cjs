// The built-in browser's everyday behaviour (app/browser-parity.js) in a real Chromium, with
// the tabs main.js would make, against pages served on 127.0.0.1: per-site permission prompts
// (Chromium's fake camera and microphone, never the Mac's; location and the clipboard are only
// ever refused here, so nothing real is read), devices refused, the user agent, sign-in
// popups, the leave-page question, HTTP sign-in and certificate warnings (a certificate made
// for the test with the Mac's openssl). No window is shown, nothing leaves 127.0.0.1, no sound
// plays.
//
//   app/node_modules/.bin/electron tests/web/browser-parity.e2e.cjs      (exit 1 on a failure)
'use strict';

const { app, BrowserWindow, WebContentsView, session } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jarvis-parity-test-')));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost');
app.commandLine.appendSwitch('use-fake-device-for-media-stream'); // Chromium's own test camera and microphone
app.commandLine.appendSwitch('mute-audio');
const { createParity, PARTITION } = require('../../app/browser-parity');

// An exception in the app's code fails the run (Electron would otherwise stop on its error box).
let uncaught = 0;
process.on('uncaughtException', (err) => { uncaught += 1; console.log(`UNCAUGHT ${err && err.stack}`); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGES = {
  '/': '<!doctype html><title>Home</title><body><h1>Home</h1></body>',
  '/other': '<!doctype html><title>Other</title><body>other</body>',
  // A sign-in button that opens a popup, a link for a new tab, and what the popup says back.
  '/opener': `<!doctype html><title>Shop</title><body>
    <button id="pay" onclick="window.pop = window.open('/popup', 'pay', 'width=460,height=560')">Pay with PayPal</button>
    <a id="blank" href="/other" target="_blank">Terms</a>
    <script>addEventListener('message', (e) => { if (e.origin === location.origin) document.title = 'Paid: ' + e.data; });</script></body>`,
  '/popup': `<!doctype html><title>Log in to your account</title><body>
    <a id="help" href="/other" target="_blank">Help</a>
    <script>setTimeout(() => window.opener && window.opener.postMessage('ok', location.origin), 50);</script></body>`,
  '/leave': `<!doctype html><title>Draft</title><body><textarea>half a letter</textarea>
    <script>addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; });</script></body>`,
};
const USER = 'owner';
const PASS = 'correct horse'; // a test's own, for a server that lives for this run

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const where = new URL(req.url, 'http://x').pathname;
      if (where === '/auth' || where === '/auth.png') {
        const ok = req.headers.authorization === `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
        if (!ok) { res.writeHead(401, { 'www-authenticate': 'Basic realm="Staff only"', 'content-type': 'text/html' }); res.end('<title>Unauthorized</title>no'); return; }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<title>Welcome</title>in');
        return;
      }
      if (where === '/picture') { // a page with another site's picture that asks for a sign-in
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<title>Picture</title><img src="${base2}/auth.png">`);
        return;
      }
      const page = PAGES[where];
      if (!page) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(page);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// An https server whose certificate no one trusts: made for this run, gone after it.
function serveTls() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jarvis-parity-cert-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  const options = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
  fs.rmSync(dir, { recursive: true, force: true });
  return new Promise((resolve) => {
    const server = https.createServer(options, (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>Self-signed</title>the page');
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

let win;
let base; // http://127.0.0.1:port
let base2; // http://localhost:port: another site
let secure; // https://127.0.0.1:port, with a certificate no one trusts
const tabs = [];
let active = null;
const sent = [];
const boxes = []; // the Mac's boxes the test answered
let boxAnswer = 1;
const syncBoxes = []; // the leave-page questions
let syncAnswer = 1;
const opened = []; // new tabs main.js would have opened
let parity;

function newTab() {
  // As main.js's createTab makes them.
  const view = new WebContentsView({ webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, disableBlinkFeatures: 'WebBluetooth' } });
  view.setBounds({ x: 0, y: 0, width: 900, height: 700 });
  win.contentView.addChildView(view);
  tabs.push(view);
  const wc = view.webContents;
  wc.setWindowOpenHandler((details) => parity.windowOpen(wc, details) || (opened.push(details.url), { action: 'deny' }));
  parity.wireTab(view);
  return view;
}
// The user's own click on a page (a hidden window's page gets no real input: the click is
// the page's own, with the gesture a click gives, after the event main.js sees for a click).
async function click(wc, selector) {
  wc.emit('before-mouse-event', { preventDefault() {} }, { type: 'mouseDown', x: 5, y: 5, button: 'left' });
  await wc.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`, true);
}
const popupsOpen = () => BrowserWindow.getAllWindows().filter((w) => w !== win && !w.isDestroyed());
const page = (view, code) => view.webContents.executeJavaScript(code, true);
const lastSent = (channel) => [...sent].reverse().find(([c]) => c === channel);
const asking = () => { const m = lastSent('feature:browser:ask'); return m ? m[1] : null; }; // the prompt on show
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(40); }
  return fn();
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(cond, message) { if (!cond) throw new Error(message); }

test('The user agent is Chromium’s own, without Electron or the app’s name', async () => {
  const view = newTab();
  await view.webContents.loadURL(`${base}/`);
  const ua = await page(view, 'navigator.userAgent');
  assert(/Chrome\/\d+/.test(ua) && /Safari\/537\.36$/.test(ua), ua);
  assert(!/Electron|J\.A\.R\.V\.I\.S/.test(ua), ua);
  assert(!/Electron/.test(session.fromPartition(PARTITION).getUserAgent()), 'requests still say Electron');
});

test('A camera and microphone request waits for the prompt; Allow is kept for the site', async () => {
  const view = newTab();
  active = view;
  await view.webContents.loadURL(`${base}/`);
  assert((await page(view, 'navigator.permissions.query({ name: "camera" }).then((s) => s.state)')) === 'granted', 'Meet could not ask');
  const got = page(view, 'navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then((s) => s.getTracks().map((t) => t.kind).sort().join(","), (e) => "error " + e.name)');
  const shown = await until(() => { const m = lastSent('feature:browser:ask'); return m && m[1] && m[1].type === 'permission' ? m[1] : null; });
  assert(shown, `no prompt: ${JSON.stringify(sent)}`);
  assert(JSON.stringify(shown.kinds) === '["camera","microphone"]' && shown.host === new URL(base).host, JSON.stringify(shown));
  assert(parity.answer({ id: shown.id, choice: 'allow' }), 'the answer was refused');
  assert((await got) === 'audio,video', `getUserMedia: ${await got}`);
  const again = await page(view, 'navigator.mediaDevices.getUserMedia({ video: true }).then(() => "ok", (e) => e.name)');
  assert(again === 'ok', again);
  parity.store.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'browser-state.json'), 'utf8'));
  assert(JSON.stringify(saved.sites[base]) === '{"camera":"allow","microphone":"allow"}', JSON.stringify(saved.sites));
  // Another tab of the same site: no prompt.
  const other = newTab();
  await other.webContents.loadURL(`${base}/other`);
  const quiet = await page(other, 'navigator.mediaDevices.getUserMedia({ audio: true }).then(() => "ok", (e) => e.name)');
  assert(quiet === 'ok', quiet);
  assert(parity.sitesList().some((s) => s.origin === base && s.kinds.camera === 'allow'), JSON.stringify(parity.sitesList()));
});

test('Don’t allow is kept: the site is refused without a prompt; a tab behind waits for its turn', async () => {
  const view = newTab();
  active = tabs[0];
  await view.webContents.loadURL(`${base2}/`);
  sent.length = 0;
  const got = page(view, 'navigator.mediaDevices.getUserMedia({ audio: true }).then(() => "ok", (e) => e.name)');
  await sleep(300);
  assert(!sent.some(([c, m]) => c === 'feature:browser:ask' && m), 'a tab behind showed its prompt');
  active = view;
  parity.selected(view);
  const shown = lastSent('feature:browser:ask')[1];
  assert(shown && shown.host === new URL(base2).host, JSON.stringify(shown));
  assert(!parity.answer({ id: shown.id + 'x', choice: 'allow' }), 'an unknown prompt was answered');
  parity.answer({ id: shown.id, choice: 'block' });
  assert((await got) === 'NotAllowedError', await got);
  sent.length = 0;
  const again = await page(view, 'navigator.mediaDevices.getUserMedia({ audio: true }).then(() => "ok", (e) => e.name)');
  assert(again === 'NotAllowedError' && !sent.some(([c, m]) => c === 'feature:browser:ask' && m), 'asked again');
});

test('Allow this time ends when the tab leaves the site; a page that moves on drops its prompt', async () => {
  const view = newTab();
  active = view;
  await view.webContents.loadURL(`${base2}/`);
  const camera = () => page(view, 'navigator.mediaDevices.getUserMedia({ video: true }).then(() => "ok", (e) => e.name)');
  let got = camera();
  let shown = await until(asking);
  parity.answer({ id: shown.id, choice: 'once' });
  assert((await got) === 'ok', await got);
  assert(!parity.sitesList().some((s) => s.origin === base2 && s.kinds.camera), 'Allow this time was kept');
  await view.webContents.loadURL(`${base2}/other`); // the same site: still allowed
  sent.length = 0;
  assert((await camera()) === 'ok' && !asking(), 'asked again on the same site');
  await view.webContents.loadURL(`${base}/`); // another site, then back
  await view.webContents.loadURL(`${base2}/`);
  got = camera();
  shown = await until(asking);
  assert(shown && shown.host === new URL(base2).host, 'the grant outlived leaving the site');
  // The page moves on while its prompt waits: the prompt goes.
  view.webContents.loadURL(`${base2}/other`);
  const cleared = await until(() => { const m = lastSent('feature:browser:ask'); return m && m[1] === null; });
  assert(cleared, 'the prompt stayed after the page moved on');
  assert(!parity.permissionsFor(view.webContents.session).pending.length, 'the old page still waits');
});

test('Notifications: denied until allowed, so a page can’t show them without asking', async () => {
  const view = newTab();
  active = view;
  await view.webContents.loadURL(`${base}/other`);
  assert((await page(view, 'Notification.permission')) === 'denied', 'a page could notify without asking');
  const asked = page(view, 'Notification.requestPermission()');
  const shown = await until(() => { const m = lastSent('feature:browser:ask'); return m && m[1] && m[1].kinds[0] === 'notifications' ? m[1] : null; });
  assert(shown, 'requestPermission showed no prompt');
  parity.answer({ id: shown.id, choice: 'dismiss' });
  assert((await asked) === 'denied', await asked);
  parity.setSite({ origin: base, kind: 'notifications', value: 'allow' });
  assert((await page(view, 'Notification.permission')) === 'granted', 'allowed in Settings, still denied');
  parity.setSite({ origin: base, forget: true });
  assert((await page(view, 'Notification.permission')) === 'denied', 'forgetting the site kept its permission');
});

test('Location and the clipboard are asked for (and refused here: nothing real is read)', async () => {
  const view = newTab();
  active = view;
  await view.webContents.loadURL(`${base2}/other`);
  const where = page(view, 'new Promise((r) => navigator.geolocation.getCurrentPosition(() => r("position"), (e) => r("error " + e.code)))');
  let shown = await until(() => { const m = lastSent('feature:browser:ask'); return m && m[1] && m[1].kinds[0] === 'location' ? m[1] : null; });
  assert(shown, 'no location prompt');
  parity.answer({ id: shown.id, choice: 'dismiss' });
  assert((await where) === 'error 1', await where);
  view.webContents.focus();
  const focused = await page(view, 'document.hasFocus()');
  const clip = page(view, 'navigator.clipboard.readText().then(() => "read", (e) => e.name + ": " + e.message)');
  shown = await until(() => { const m = lastSent('feature:browser:ask'); return m && m[1] && m[1].kinds[0] === 'clipboard' ? m[1] : null; }, focused ? 4000 : 500);
  if (shown) parity.answer({ id: shown.id, choice: 'dismiss' });
  const read = await clip;
  assert(/^NotAllowedError/.test(read), read);
  assert(shown || !focused, `a focused page's clipboard read asked nothing (${read})`);
  console.log(`       (clipboard: ${focused ? 'asked' : 'the page had no focus here, refused before asking'})`);
});

test('USB, HID, serial, MIDI and Bluetooth stay out of reach', async () => {
  const view = newTab();
  await view.webContents.loadURL(`${base}/`);
  const r = await page(view, `Promise.all([
    navigator.usb.requestDevice({ filters: [] }).then(() => 'usb', (e) => e.name),
    navigator.hid.requestDevice({ filters: [] }).then((d) => d.length ? 'hid' : 'none', (e) => e.name),
    navigator.serial.requestPort().then(() => 'serial', (e) => e.name),
    navigator.requestMIDIAccess().then(() => 'midi', (e) => e.name),
    typeof navigator.bluetooth,
  ])`);
  // Bluetooth isn't there at all: asking for a device would have macOS ask about Bluetooth.
  assert(JSON.stringify(r) === '["NotFoundError","none","NotFoundError","NotAllowedError","undefined"]', JSON.stringify(r));
});

test('A page in a window of its own (a sign-in popup) asks in the Mac’s box on that window; a hidden one is refused', async () => {
  const popup = new BrowserWindow({ show: false, webPreferences: { partition: PARTITION, sandbox: true } });
  await popup.webContents.loadURL(`${base}/other`);
  parity.setSite({ origin: base, kind: 'camera', value: 'ask' });
  boxAnswer = 0; // Allow
  const camera = () => popup.webContents.executeJavaScript('navigator.mediaDevices.getUserMedia({ video: true }).then(() => "ok", (e) => e.name)', true);
  assert((await camera()) === 'NotAllowedError' && !boxes.length, 'a window nobody sees asked');
  popup.isVisible = () => true; // as a popup on screen is (the test shows no window)
  assert((await camera()) === 'ok', 'the box’s Allow was not taken');
  assert(boxes.length === 1 && boxes[0].owner === popup && /wants to use your camera/.test(boxes[0].options.message), JSON.stringify(boxes.map((b) => b.options)));
  popup.destroy();
});

test('A payment or sign-in popup opened by a click is a real window with its opener, titled with its real site', async () => {
  const view = newTab();
  active = view;
  await view.webContents.loadURL(`${base}/opener`);
  opened.length = 0;
  await click(view.webContents, '#pay');
  const popup = await until(() => popupsOpen().find((w) => w.webContents.getURL() === `${base}/popup`), 10000);
  assert(popup, `no popup window (tabs asked for: ${JSON.stringify(opened)})`);
  assert(!opened.length, 'it opened a tab as well');
  await until(() => view.webContents.getTitle() === 'Paid: ok', 10000);
  assert(view.webContents.getTitle() === 'Paid: ok', `the popup could not reach its opener: ${view.webContents.getTitle()}`);
  const title = await until(() => popup.getTitle() === `${new URL(base).host} — Log in to your account` && popup.getTitle(), 10000);
  assert(title, `the title bar: ${popup.getTitle()}`);
  const b = popup.getBounds();
  assert(b.width === 460 && b.height === 560, `the size asked for: ${JSON.stringify(b)}`);
  assert((await popup.webContents.executeJavaScript('typeof navigator.bluetooth')) === 'undefined', 'Bluetooth in a popup');
  // A link in the popup for a new window: a tab in the dock.
  await click(popup.webContents, '#help');
  await until(() => opened.length);
  assert(JSON.stringify(opened) === JSON.stringify([`${base}/other`]), JSON.stringify(opened));
  // The page closes its popup when it's done.
  await popup.webContents.executeJavaScript('setTimeout(() => window.close(), 0); 1', true);
  await until(() => popup.isDestroyed(), 10000);
  assert(popup.isDestroyed(), 'window.close() left the popup open');
});

test('A link for a new window, or a popup a page opens by itself, is a tab as before; a page can’t bury the screen in popups', async () => {
  const view = newTab();
  active = view;
  await view.webContents.loadURL(`${base}/opener`);
  opened.length = 0;
  const before = popupsOpen().length;
  await click(view.webContents, '#blank');
  await until(() => opened.length);
  assert(opened[0] === `${base}/other` && popupsOpen().length === before, `target=_blank: ${JSON.stringify(opened)}`);
  const quiet = newTab();
  await quiet.webContents.loadURL(`${base}/opener`);
  await quiet.webContents.executeJavaScript(`window.open('/popup?unasked', 'x', 'width=400,height=400'); 1`, true);
  await until(() => opened.length > 1);
  assert(opened[1] === `${base}/popup?unasked` && popupsOpen().length === before, `no click behind it: ${JSON.stringify(opened)}`);
  // One click, six popups: three open, the rest are refused (no tabs either).
  quiet.webContents.emit('before-mouse-event', { preventDefault() {} }, { type: 'mouseDown', x: 5, y: 5, button: 'left' });
  await quiet.webContents.executeJavaScript(`for (let i = 0; i < 6; i++) window.open('/other?' + i, 'w' + i, 'width=400,height=400'); 1`, true);
  await until(() => popupsOpen().length - before >= 3, 10000);
  await sleep(500);
  assert(popupsOpen().length - before === 3 && opened.length === 2, `${popupsOpen().length - before} popups, tabs ${JSON.stringify(opened)}`);
  for (const w of popupsOpen()) w.destroy();
});

test('A page with unsaved work asks before it goes: Stay keeps it, Leave goes; with nobody to ask it stays', async () => {
  const view = newTab();
  active = view;
  let unloads = 0; // the page's beforeunload kept it
  view.webContents.on('will-prevent-unload', () => { unloads += 1; });
  // A way off the page, tried until the page's beforeunload has run for it (Chromium refuses a
  // navigation right after the page was kept, without running it again).
  const leaving = async () => {
    const before = unloads;
    for (let i = 0; i < 40 && unloads === before; i++) {
      await view.webContents.loadURL(`${base}/other`).catch(() => {});
      if (unloads === before) await sleep(100);
    }
    assert(unloads === before + 1, 'the page never asked');
  };
  await view.webContents.loadURL(`${base}/leave`);
  await page(view, '1'); // the user's touch: a page may only ask after one
  const shown = () => true;
  win.isVisible = shown;
  syncBoxes.length = 0;
  syncAnswer = 1; // Stay
  await leaving();
  assert(view.webContents.getURL() === `${base}/leave`, 'Stay left the page');
  assert(syncBoxes.length === 1 && syncBoxes[0].owner === win, `asked ${syncBoxes.length} times`);
  const o = syncBoxes[0].options;
  assert(o.message === `Leave ${new URL(base).host}?` && o.detail === 'Changes you made may not be saved.' && JSON.stringify(o.buttons) === '["Leave","Stay"]', JSON.stringify(o));
  win.isVisible = () => false; // the window hidden: nobody could answer
  await leaving();
  assert(view.webContents.getURL() === `${base}/leave` && syncBoxes.length === 1, 'left, or asked with nobody to see it');
  win.isVisible = shown;
  syncAnswer = 0; // Leave
  await leaving();
  await until(() => view.webContents.getURL() === `${base}/other`);
  assert(view.webContents.getURL() === `${base}/other` && syncBoxes.length === 2, `Leave stayed: ${view.webContents.getURL()}`);
  delete win.isVisible;
});

test('A site’s sign-in asks in the window: the answer signs in; Cancel shows the site’s refusal', async () => {
  const view = newTab();
  active = view;
  parity.selected(view);
  const loading = view.webContents.loadURL(`${base}/auth`).catch(() => {});
  const shown = await until(() => { const a = asking(); return a && a.type === 'auth' ? a : null; }, 10000);
  assert(shown && shown.host === new URL(base).host && shown.realm === 'Staff only' && shown.proxy === false && shown.insecure === false, JSON.stringify(shown));
  assert(!parity.authAnswer({ id: 'a0', username: 'x', password: 'y' }), 'an unknown prompt was answered');
  assert(parity.authAnswer({ id: shown.id, username: USER, password: PASS }), 'the answer was refused');
  await loading;
  await until(() => view.webContents.getTitle() === 'Welcome', 10000);
  assert(view.webContents.getTitle() === 'Welcome', `signed in: ${view.webContents.getTitle()}`);
  assert(asking() === null, 'the prompt stayed');
  const other = newTab();
  active = other;
  parity.selected(other);
  const again = other.webContents.loadURL(`${base2}/auth`).catch(() => {});
  const second = await until(() => { const a = asking(); return a && a.type === 'auth' ? a : null; }, 10000);
  assert(second && second.host === new URL(base2).host, JSON.stringify(second));
  parity.authAnswer({ id: second.id, cancel: true });
  await again;
  await until(() => other.webContents.getTitle() === 'Unauthorized', 10000);
  assert(other.webContents.getTitle() === 'Unauthorized', `cancelled: ${other.webContents.getTitle()}`);
});

test('Another site’s picture inside a page can’t ask for a password', async () => {
  const view = newTab();
  active = view;
  parity.selected(view);
  sent.length = 0;
  await view.webContents.loadURL(`${base}/picture`);
  await sleep(700);
  assert(!sent.some(([c, m]) => c === 'feature:browser:ask' && m && m.type === 'auth'), 'another site asked for a password');
});

test('A certificate no one trusts: a warning in the page’s place; Continue anyway lets that site through; Back to safety goes back', async () => {
  const view = newTab();
  active = view;
  parity.selected(view);
  await view.webContents.loadURL(`${secure}/`).catch(() => {});
  const shown = await until(() => { const a = asking(); return a && a.type === 'cert' ? a : null; }, 10000);
  assert(shown && shown.host === new URL(secure).host && shown.problem === 'authority' && shown.url === `${secure}/`, JSON.stringify(shown));
  assert(view.getVisible() === false, 'the page stayed over the warning');
  assert(!parity.certAnswer({ id: 'c0', choice: 'proceed' }), 'an unknown warning was answered');
  assert(parity.certAnswer({ id: shown.id, choice: 'proceed' }), 'Continue anyway was refused');
  await until(() => view.webContents.getTitle() === 'Self-signed', 10000);
  assert(view.webContents.getTitle() === 'Self-signed' && view.getVisible(), `continued: ${view.webContents.getTitle()}`);
  assert(asking() === null, 'the warning stayed');
  const site = lastSent('feature:browser:site-state');
  assert(site && site[1].unsafe === true, 'the site button does not warn');
  // Another site with the same certificate (made for 127.0.0.1) is asked about afresh.
  const other = newTab();
  active = other;
  parity.selected(other);
  await other.webContents.loadURL(`${base}/`);
  const port = new URL(secure).port;
  await other.webContents.loadURL(`https://localhost:${port}/`).catch(() => {});
  const warning = await until(() => { const a = asking(); return a && a.type === 'cert' ? a : null; }, 10000);
  assert(warning && warning.host === `localhost:${port}`, JSON.stringify(warning));
  assert(parity.certAnswer({ id: warning.id, choice: 'back' }), 'Back to safety was refused');
  await until(() => other.webContents.getURL() === `${base}/`, 10000);
  assert(other.webContents.getURL() === `${base}/` && other.getVisible(), `back: ${other.webContents.getURL()}`);
});

test('A popup’s certificate warning asks in the Mac’s box on that popup', async () => {
  const popup = new BrowserWindow({ show: false, webPreferences: { partition: PARTITION, sandbox: true } });
  parity.wire(popup.webContents); // as a popup's page is wired
  boxes.length = 0;
  boxAnswer = 1; // Continue anyway
  const port = new URL(secure).port;
  await popup.webContents.loadURL(`https://localhost:${port}/`).catch(() => {});
  await until(() => popup.webContents.getTitle() === 'Self-signed', 10000);
  assert(popup.webContents.getTitle() === 'Self-signed', `continued: ${popup.webContents.getTitle()}`);
  assert(boxes.length === 1 && boxes[0].owner === popup && boxes[0].options.message === `Your connection to localhost:${port} isn’t private`, JSON.stringify(boxes.map((b) => b.options)));
  assert(/isn’t from an authority this Mac trusts|is for another site/.test(boxes[0].options.detail), boxes[0].options.detail);
  popup.destroy();
});

let failed = 0;
app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const server = await serve();
  base = `http://127.0.0.1:${server.address().port}`;
  base2 = `http://localhost:${server.address().port}`;
  const tls = await serveTls();
  secure = `https://127.0.0.1:${tls.address().port}`;
  win = new BrowserWindow({ show: false, width: 900, height: 700 });
  parity = createParity({
    window: () => win,
    tabs: () => tabs,
    active: () => active,
    send: (channel, payload) => sent.push([channel, payload]),
    fromWindow: () => true,
    box: (owner, options) => { boxes.push({ owner, options }); return Promise.resolve({ response: boxAnswer }); },
    boxSync: (owner, options) => { syncBoxes.push({ owner, options }); return syncAnswer; },
    showPopup: () => {}, // no window is shown here
    openTab: (url) => opened.push(url),
  });
  await sleep(50);
  for (const t of tests) {
    sent.length = 0;
    try {
      await t.fn();
      console.log(`ok     ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`FAILED ${t.name}\n       ${err.message}`);
    }
  }
  // Everything closes, as when the app quits: nothing may throw on the way out.
  for (const w of BrowserWindow.getAllWindows()) w.destroy();
  await sleep(300);
  if (uncaught) console.log(`FAILED ${uncaught} uncaught exception(s)`);
  console.log(`\n${tests.length - failed} passed, ${failed + uncaught} failed`);
  server.close();
  tls.close();
  app.exit(failed || uncaught ? 1 : 0);
});
