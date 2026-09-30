// The built-in browser's everyday behaviour (app/browser-parity.js) in a real Chromium, with
// the tabs main.js would make, against pages served on 127.0.0.1: per-site permission prompts
// (Chromium's fake camera and microphone, never the Mac's; location and the clipboard are only
// ever refused here, so nothing real is read), devices refused, the user agent. No window is
// shown, nothing leaves 127.0.0.1, no sound plays.
//
//   app/node_modules/.bin/electron tests/web/browser-parity.e2e.cjs      (exit 1 on a failure)
'use strict';

const { app, BrowserWindow, WebContentsView, session } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jarvis-parity-test-')));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost');
app.commandLine.appendSwitch('use-fake-device-for-media-stream'); // Chromium's own test camera and microphone
app.commandLine.appendSwitch('mute-audio');
const { createParity, PARTITION } = require('../../app/browser-parity');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGES = {
  '/': '<!doctype html><title>Home</title><body><h1>Home</h1></body>',
  '/other': '<!doctype html><title>Other</title><body>other</body>',
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const page = PAGES[new URL(req.url, 'http://x').pathname];
      if (!page) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(page);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

let win;
let base; // http://127.0.0.1:port
let base2; // http://localhost:port: another site
const tabs = [];
let active = null;
const sent = [];
const boxes = []; // the Mac's boxes the test answered
let boxAnswer = 1;
let parity;

function newTab() {
  // As main.js's createTab makes them.
  const view = new WebContentsView({ webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, disableBlinkFeatures: 'WebBluetooth' } });
  view.setBounds({ x: 0, y: 0, width: 900, height: 700 });
  win.contentView.addChildView(view);
  tabs.push(view);
  parity.wireTab(view);
  return view;
}
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

let failed = 0;
app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const server = await serve();
  base = `http://127.0.0.1:${server.address().port}`;
  base2 = `http://localhost:${server.address().port}`;
  win = new BrowserWindow({ show: false, width: 900, height: 700 });
  parity = createParity({
    window: () => win,
    tabs: () => tabs,
    active: () => active,
    send: (channel, payload) => sent.push([channel, payload]),
    fromWindow: () => true,
    box: (owner, options) => { boxes.push({ owner, options }); return Promise.resolve({ response: boxAnswer }); },
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
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  server.close();
  app.exit(failed ? 1 : 0);
});
