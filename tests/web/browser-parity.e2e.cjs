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
const { createParity, PARTITION, PRIVATE_PARTITION, AGENT_PARTITION } = require('../../app/browser-parity');

// An exception in the app's code fails the run (Electron would otherwise stop on its error box).
let uncaught = 0;
process.on('uncaughtException', (err) => { uncaught += 1; console.log(`UNCAUGHT ${err && err.stack}`); });
app.on('window-all-closed', () => {}); // the run ends with its own exit code, not when the last window goes

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
  // A sound playing in the page and in a frame of it.
  '/music': '<!doctype html><title>Music</title><body><audio id="a" src="/tone.wav" loop></audio><iframe id="f" src="/music-frame"></iframe></body>',
  '/music-frame': '<!doctype html><title>Frame</title><body><audio id="a" src="/tone.wav" loop></audio></body>',
};

// A small real PDF: a page per text.
function tinyPdf(pages) {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', null, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const kids = [];
  for (const text of pages) {
    const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${objs.length} 0 R >>`);
    kids.push(objs.length);
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = objs.map((obj, i) => { const at = out.length; out += `${i + 1} 0 obj\n${obj}\nendobj\n`; return at; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const PDF = tinyPdf(['Quarterly statement', 'Balance due']);

// A second of silence, as a WAV file (nothing is heard: the test runs muted too).
function silence() {
  const rate = 8000;
  const data = Buffer.alloc(rate);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8); head.write('fmt ', 12);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate, 28); head.writeUInt16LE(1, 32); head.writeUInt16LE(8, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  data.fill(128);
  return Buffer.concat([head, data]);
}
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
      if (where === '/statement.pdf') { // behind a sign-in: only with the session's cookie
        if (!/(^|;\s*)signed=in/.test(req.headers.cookie || '')) { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('sign in first'); return; }
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': PDF.length });
        res.end(PDF);
        return;
      }
      if (where === '/huge.pdf') { // a PDF bigger than any read, its size unsaid (chunked)
        res.writeHead(200, { 'content-type': 'application/pdf' });
        const chunk = Buffer.alloc(1024 * 1024, 48);
        let sent = 0;
        const more = () => { while (sent < 26) { sent += 1; if (!res.write(chunk)) { res.once('drain', more); return; } } res.end(); };
        res.on('error', () => {});
        more();
        return;
      }
      if (where === '/signin') {
        res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'signed=in; Path=/' });
        res.end('<title>Signed in</title>ok');
        return;
      }
      if (where === '/tone.wav') {
        res.writeHead(200, { 'content-type': 'audio/wav' });
        res.end(silence());
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
const browserData = { bookmarks: [], history: [] }; // main.js's browser.json
let saves = 0; // its saves
let savePick = { canceled: true }; // where the Save box says to save
const openedOutside = []; // pages opened in the Mac's default browser
let parity;

function newTab(opts = {}) {
  // As main.js's createTab makes them.
  const view = new WebContentsView({ webPreferences: { partition: opts.partition || PARTITION, sandbox: true, contextIsolation: true, disableBlinkFeatures: 'WebBluetooth', plugins: true } });
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

test('Tabs: pinned ones go first, a dragged one keeps to its group, a muted one stays muted', async () => {
  for (const view of tabs.splice(0)) view.webContents.close();
  const [a, b, c] = [newTab(), newTab(), newTab()];
  await Promise.all([a, b, c].map((v, i) => v.webContents.loadURL(`${base}/other?${i}`)));
  const order = () => tabs.map((v) => [a, b, c].indexOf(v)).join('');
  assert(parity.tabAction({ action: 'pin', id: c.webContents.id }) && order() === '201', `pinned: ${order()}`);
  assert(parity.tabInfo(c).pinned === true && parity.tabInfo(a).pinned === false, 'the tab list does not say which is pinned');
  parity.tabAction({ action: 'move', id: a.webContents.id, to: 0 });
  assert(order() === '201', `a tab moved among the pinned: ${order()}`);
  parity.tabAction({ action: 'move', id: a.webContents.id, to: 2 });
  assert(order() === '210', `moved: ${order()}`);
  assert(parity.tabAction({ action: 'mute', id: b.webContents.id }) && b.webContents.isAudioMuted() && parity.tabInfo(b).muted, 'not muted');
  parity.tabAction({ action: 'unmute', id: b.webContents.id });
  assert(!b.webContents.isAudioMuted(), 'still muted');
  assert(!parity.tabAction({ action: 'pin', id: 99999 }) && !parity.tabAction({ action: 'explode', id: a.webContents.id }), 'a bad action did something');
  assert(sent.some(([c2]) => c2 === 'changed'), 'the tab strip was not told');
});

test('Closing the dock stops every video and sound in the tabs, in frames too', async () => {
  const view = newTab();
  await view.webContents.loadURL(`${base}/music`);
  const playing = `Promise.all([document.getElementById('a').play(), document.getElementById('f').contentDocument.getElementById('a').play()]).then(() => true, (e) => e.name)`;
  assert((await page(view, playing)) === true, 'the test page could not play');
  const paused = () => page(view, `[document.getElementById('a').paused, document.getElementById('f').contentDocument.getElementById('a').paused].join()`);
  assert((await paused()) === 'false,false', await paused());
  parity.dock({ open: true });
  await sleep(200);
  assert((await paused()) === 'false,false', 'opening the dock stopped the sound');
  parity.dock({ open: false });
  await until(async () => (await paused()) === 'true,true');
  assert((await paused()) === 'true,true', `still playing: ${await paused()}`);
});

test('Each site keeps its zoom, and a private tab’s is never kept', async () => {
  const view = newTab();
  await view.webContents.loadURL(`${base}/other`);
  parity.zoomed(view.webContents, 1.5);
  assert(parity.zoomFor(view.webContents) === 1.5, 'the site forgot its zoom');
  const other = newTab();
  await other.webContents.loadURL(`${base2}/`);
  assert(parity.zoomFor(other.webContents) === 1, 'another site took the zoom');
  parity.zoomed(view.webContents, 1);
  assert(!(new URL(base).host in parity.state().zoom), 'back to 100 % is kept as nothing');
  other.private = true;
  parity.zoomed(other.webContents, 2);
  assert(!(new URL(base2).host in parity.state().zoom), 'a private tab’s zoom was kept');
});

test('The address bar’s list: open tabs to switch to, bookmarks and history, and what Return does', async () => {
  const view = newTab();
  active = view;
  await view.webContents.loadURL(`${base}/other`);
  const behind = newTab();
  await behind.webContents.loadURL(`${base}/opener`);
  browserData.history = [{ url: `${base}/leave`, title: 'Shop drafts', at: Date.now() }];
  browserData.bookmarks = [{ url: 'https://shop.example/', title: 'The shop', folder: 'Errands' }];
  const r = parity.suggest({ text: 'shop' });
  assert(r.typed && r.typed.search === true && r.typed.engine === 'Google' && r.typed.url.startsWith('https://www.google.com/search?q=shop'), JSON.stringify(r.typed));
  const kinds = r.rows.map((x) => x.kind);
  const tab = r.rows.find((x) => x.kind === 'tab');
  assert(tab && tab.tab === behind.webContents.id && tab.url === `${base}/opener`, `no tab to switch to: ${JSON.stringify(r.rows)}`);
  assert(!r.rows.some((x) => x.kind === 'tab' && x.tab === view.webContents.id), 'the tab on show was offered');
  assert(r.rows.some((x) => x.kind === 'bookmark' && x.folder === 'Errands') && kinds.indexOf('tab') < kinds.indexOf('history'), JSON.stringify(r.rows));
  assert(parity.suggest({ text: 'example.com' }).typed.search === false, 'an address read as words');
  assert(parity.suggest({ text: '   ' }).typed === null, 'nothing typed, something suggested');
});

test('The page steps aside while a panel of the window’s is over it', async () => {
  const view = newTab();
  active = view;
  parity.selected(view);
  parity.setCover({ on: true });
  assert(view.getVisible() === false, 'the page stayed over the panel');
  const other = newTab();
  active = other;
  parity.selected(other);
  assert(view.getVisible() === true && other.getVisible() === false, 'the cover did not follow the tab on show');
  parity.setCover({ on: false });
  assert(other.getVisible() === true, 'the page stayed hidden');
});

test('The tabs come back next time: pinned first, back lists and all; tabs behind load when first shown', async () => {
  for (const view of tabs.splice(0)) view.webContents.close();
  parity.restored = false;
  assert(parity.restore() === false, 'restored with nothing kept'); // (and from now on changes are kept)
  const a = newTab();
  await a.webContents.loadURL(`${base}/other?1`);
  await a.webContents.loadURL(`${base}/other?2`);
  const b = newTab();
  await b.webContents.loadURL(`${base}/opener`);
  const s = newTab();
  await s.webContents.loadURL(`${base}/secret`).catch(() => {}); // an address never kept
  const p = newTab();
  p.private = true;
  await p.webContents.loadURL(`${base}/other?private`);
  parity.tabAction({ action: 'pin', id: b.webContents.id });
  active = a;
  parity.sessionNow();
  const kept = parity.state().session;
  assert(JSON.stringify(kept.tabs.map((t) => [t.url, t.pinned])) === JSON.stringify([[`${base}/opener`, true], [`${base}/other?2`, false]]), JSON.stringify(kept.tabs));
  assert(kept.active === 1 && kept.tabs[1].index === 1 && kept.tabs[1].entries.length === 2, JSON.stringify(kept));
  parity.store.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'browser-state.json'), 'utf8'));
  assert(saved.session.tabs.length === 2 && !JSON.stringify(saved).includes('private') && !JSON.stringify(saved).includes('secret'), 'kept what it shouldn’t');
  // Next time: the tab on show and the pinned one load; the other waits to be shown.
  for (const view of tabs.splice(0)) view.webContents.close();
  parity.restored = false;
  parity.state().session = { tabs: [kept.tabs[1], { url: `${base}/other?3`, title: 'Three', pinned: false, entries: [], index: -1 }, kept.tabs[0]], active: 0 };
  assert(parity.restore() === true, 'nothing restored');
  assert(tabs.length === 3 && tabs[0].pinned && active === tabs[1], `order or tab on show: ${tabs.map((v) => parity.tabInfo(v).url)}`);
  await until(() => tabs[1].webContents.getURL() === `${base}/other?2`, 10000);
  assert(tabs[1].webContents.navigationHistory.canGoBack(), 'its back list did not come back');
  await until(() => tabs[0].webContents.getURL() === `${base}/opener`, 10000);
  assert(tabs[0].webContents.getURL() === `${base}/opener`, 'the pinned tab did not load');
  assert(tabs[2].webContents.getURL() === '' && parity.tabInfo(tabs[2]).url === `${base}/other?3` && parity.tabInfo(tabs[2]).title === 'Three', 'a tab behind loaded, or shows nothing');
  active = tabs[2];
  parity.selected(tabs[2]);
  await until(() => tabs[2].webContents.getURL() === `${base}/other?3`, 10000);
  assert(tabs[2].webContents.getURL() === `${base}/other?3`, 'shown, it did not load');
  assert(parity.restore() === false, 'restored twice');
});

test('Bookmarks renamed and filed; a folder renamed; another browser’s brought in, each written down', async () => {
  browserData.bookmarks = [{ url: 'https://a.example/', title: 'A' }, { url: 'https://b.example/', title: 'B', folder: 'Work/Old' }];
  browserData.history = [];
  saves = 0;
  const r = parity.bookmarkEdit({ url: 'https://a.example/', title: 'Alpha', folder: 'Work' });
  assert(r.ok && JSON.stringify(r.folders) === '["Work","Work/Old"]' && saves === 1, JSON.stringify(r));
  assert(!parity.bookmarkEdit({ url: 'https://none.example/', title: 'x' }).ok && saves === 1, 'a missing bookmark was saved');
  const moved = parity.folderRename({ from: 'Work', to: 'Jobs' });
  assert(moved.moved === 2 && JSON.stringify(browserData.bookmarks.map((b) => b.folder)) === '["Jobs","Jobs/Old"]' && saves === 2, JSON.stringify(browserData.bookmarks));
  assert(parity.folderRename({ from: 1, to: 'x' }) === null, 'a bad rename went through');
  const added = parity.importData({ label: 'Imported from Arc', bookmarks: [{ url: 'https://c.example/', title: 'C', folder: 'Bookmarks bar' }], history: [{ url: 'https://c.example/', title: 'C', at: 1000, visits: 3 }] });
  assert(JSON.stringify(added) === '{"bookmarks":1,"history":1}' && saves === 3, JSON.stringify(added));
  assert(browserData.bookmarks.at(-1).folder === 'Imported from Arc/Bookmarks bar' && browserData.history[0].n === 3, JSON.stringify(browserData));
  assert(parity.importData({ label: '', bookmarks: [] }) === null && parity.importData({ label: 'x'.repeat(200) }) === null, 'an import without its folder’s name went through');
});

test('A PDF shows in Chromium’s viewer; JARVIS reads it through the tab’s own sign-in, and only its own reads carry the file', async () => {
  const view = newTab();
  active = view;
  await view.webContents.loadURL(`${base}/signin`);
  await view.webContents.loadURL(`${base}/statement.pdf`);
  assert((await page(view, 'document.contentType')) === 'application/pdf', 'no PDF viewer');
  assert((await parity.pdfRead(view, {})) === null, 'a gate’s read (no pdfKnown) carried the file');
  const r = await parity.pdfRead(view, { offset: 20, pdfKnown: [] });
  const sha1 = require('crypto').createHash('sha1').update(PDF).digest('hex');
  assert(r && r.ok && r.offset === 20 && r.tab === view.webContents.id && r.url === `${base}/statement.pdf`, JSON.stringify({ ...r, pdf: undefined }));
  assert(r.pdf.sha1 === sha1 && Buffer.from(r.pdf.data, 'base64').equals(PDF), 'the file was not the tab’s (its sign-in cookie?)');
  const again = await parity.pdfRead(view, { pdfKnown: [sha1] });
  assert(again.ok && again.pdf.sha1 === sha1 && !('data' in again.pdf), 'a PDF the backend has was sent again');
  const html = newTab();
  await html.webContents.loadURL(`${base}/other`);
  assert((await parity.pdfRead(html, { pdfKnown: [] })) === null, 'a web page read as a PDF');
  const huge = newTab();
  await huge.webContents.loadURL(`${base}/huge.pdf`).catch(() => {});
  await until(async () => (await page(huge, 'document.contentType').catch(() => '')) === 'application/pdf', 10000);
  const big = await parity.pdfRead(huge, { pdfKnown: [] });
  assert(big && big.ok === false && big.message === 'This PDF is over 25 MB; I read PDFs up to 25 MB.', JSON.stringify(big && { ...big, pdf: undefined }));
});

test('A PDF on this Mac reads from its file; one too big says so', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jarvis-parity-pdf-'));
  fs.writeFileSync(path.join(dir, 'notes.pdf'), PDF);
  fs.closeSync(fs.openSync(path.join(dir, 'huge.pdf'), 'w'));
  fs.truncateSync(path.join(dir, 'huge.pdf'), 26 * 1024 * 1024); // nothing written: a hole
  const view = newTab();
  await view.webContents.loadURL(`file://${dir}/notes.pdf`);
  const r = await parity.pdfRead(view, { pdfKnown: [] });
  assert(r && r.ok && Buffer.from(r.pdf.data, 'base64').equals(PDF), 'the local PDF was not read');
  await view.webContents.loadURL(`file://${dir}/huge.pdf`).catch(() => {});
  const big = await parity.pdfRead(view, { pdfKnown: [] });
  assert(big && big.ok === false && big.message === 'This PDF is 26 MB; I read PDFs up to 25 MB.', JSON.stringify(big));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Save as PDF: a page printed where the owner says; a PDF saved as the very file; nothing when the box is cancelled', async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jarvis-parity-save-'));
  const view = newTab();
  await view.webContents.loadURL(`${base}/other`);
  savePick = { canceled: true };
  assert((await parity.savePage(view.webContents)) === false, 'saved with the box cancelled');
  savePick = { canceled: false, filePath: path.join(dir, 'page.pdf') };
  assert((await parity.savePage(view.webContents)) === true, 'the page was not saved');
  assert(fs.readFileSync(path.join(dir, 'page.pdf')).subarray(0, 5).toString() === '%PDF-', 'not a PDF');
  await view.webContents.loadURL(`${base}/signin`);
  await view.webContents.loadURL(`${base}/statement.pdf`);
  savePick = { canceled: false, filePath: path.join(dir, 'statement.pdf') };
  assert((await parity.savePage(view.webContents)) === true && fs.readFileSync(path.join(dir, 'statement.pdf')).equals(PDF), 'the PDF was not saved as it is');
  const items = parity.moreItems(view.webContents);
  const save = items.find((i) => i.label === 'Save as PDF…');
  const elsewhere = (i) => /^Open in /.test(i.label || '') && i.label !== 'Open in a window';
  const outside = items.find(elsewhere);
  assert(save && save.enabled && outside && outside.enabled && items[0].label === 'New private tab', JSON.stringify(items.map((i) => [i.label, i.enabled])));
  outside.click();
  assert(openedOutside.at(-1) === `${base}/statement.pdf`, 'not opened in the default browser');
  const blank = newTab();
  const none = parity.moreItems(blank.webContents).filter((i) => i.label === 'Save as PDF…' || elsewhere(i));
  assert(none.length === 2 && none.every((i) => i.enabled === false), 'an empty tab offered to save or open');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Clearing one site’s data leaves the others’; clearing all takes everything, after a yes', async () => {
  const ses = session.fromPartition(PARTITION);
  const a = newTab();
  await a.webContents.loadURL(`${base}/other`);
  const b = newTab();
  await b.webContents.loadURL(`${base2}/other`);
  for (const [view, v] of [[a, 'a'], [b, 'b']]) await page(view, `document.cookie = 'kept=${v}; path=/'; localStorage.setItem('kept', '${v}'); 1`);
  const cookies = async (url) => (await ses.cookies.get({ url })).map((c) => c.name).join();
  assert((await cookies(base)).includes('kept') && (await cookies(base2)).includes('kept'), 'the test cookies were not set');
  boxAnswer = 1; // Cancel
  assert((await parity.clearSite(a.webContents, base)) === false && (await cookies(base)).includes('kept'), 'cleared without a yes');
  boxAnswer = 0; // Clear
  boxes.length = 0;
  assert((await parity.clearSite(a.webContents, base)) === true, 'Clear was not taken');
  assert(boxes[0].options.message === `Clear the data ${new URL(base).host} keeps?`, JSON.stringify(boxes[0].options));
  await until(async () => !(await cookies(base)).includes('kept'));
  assert(!(await cookies(base)).includes('kept') && (await cookies(base2)).includes('kept'), `one site’s: ${await cookies(base)} / ${await cookies(base2)}`);
  await until(async () => (await page(a, 'localStorage.getItem("kept")')) === null);
  assert((await page(a, 'localStorage.getItem("kept")')) === null && (await page(b, 'localStorage.getItem("kept")')) === 'b', 'storage');
  boxAnswer = 1;
  assert(JSON.stringify(await parity.clearAll({})) === '{"cleared":false}' && (await cookies(base2)).includes('kept'), 'cleared all without a yes');
  boxAnswer = 0;
  assert(JSON.stringify(await parity.clearAll({})) === '{"cleared":true}', 'Clear all was not taken');
  assert(!(await cookies(base2)).includes('kept'), 'a cookie outlived clearing all');
});

test('A private tab keeps nothing: its own cookies, no visits, no session, no zoom; all gone when the last one closes', async () => {
  opened.length = 0;
  assert(parity.newPrivate() === true, 'no private tab');
  const priv = active;
  assert(priv.private === true && parity.tabInfo(priv).private === true && parity.isPrivate(priv.webContents), 'not marked private');
  assert(priv.webContents.session === session.fromPartition(PRIVATE_PARTITION) && !priv.webContents.session.isPersistent(), 'a private tab in a profile that’s kept');
  const normal = newTab();
  await normal.webContents.loadURL(`${base}/other`);
  await priv.webContents.loadURL(`${base}/other?private-only`);
  await page(priv, `document.cookie = 'secret=private; path=/'; 1`);
  const inProfile = async (ses) => (await ses.cookies.get({ url: base })).map((c) => c.name);
  assert((await inProfile(session.fromPartition(PRIVATE_PARTITION))).includes('secret'), 'the private cookie wasn’t set');
  assert(!(await inProfile(session.fromPartition(PARTITION))).includes('secret'), 'a private cookie reached the owner’s profile');
  parity.zoomed(priv.webContents, 1.8);
  assert(!(new URL(base).host in parity.state().zoom), 'a private tab’s zoom was kept');
  parity.sessionNow();
  const kept = JSON.stringify(parity.state().session);
  assert(!kept.includes('private-only') && kept.includes(`${base}/other`), `the private tab was kept for next time: ${kept}`);
  // Its new tabs stay private: a link for a new window, or one from a popup it opened.
  assert(parity.profileOf(priv.webContents).partition === PRIVATE_PARTITION && parity.profileOf(normal.webContents) === undefined, 'a private tab’s links would leave it');
  const privPopup = new BrowserWindow({ show: false, webPreferences: { partition: PRIVATE_PARTITION, sandbox: true } });
  parity.toTab({ url: `${base}/other?from-private-popup` }, privPopup.webContents);
  assert(active.private === true && active !== priv, 'a private popup’s link opened outside the private profile');
  tabs.splice(tabs.indexOf(active), 1);
  active.webContents.close();
  privPopup.destroy();
  active = priv;
  assert(JSON.stringify(parity.partitions()) === JSON.stringify([PARTITION, PRIVATE_PARTITION, AGENT_PARTITION]), 'every profile’s downloads wait for Save');
  // Its permission answers are asked afresh and kept nowhere.
  const privPerms = parity.permissionsFor(priv.webContents.session);
  assert(privPerms.remember === false && privPerms !== parity.permissionsFor(session.fromPartition(PARTITION)), 'a private tab shares the owner’s permissions');
  // The last private tab closes: what it kept goes.
  tabs.splice(tabs.indexOf(priv), 1);
  priv.webContents.close();
  await until(async () => !(await inProfile(session.fromPartition(PRIVATE_PARTITION))).includes('secret'), 6000);
  assert(!(await inProfile(session.fromPartition(PRIVATE_PARTITION))).includes('secret'), 'the private cookie outlived the last private tab');
});

test('JARVIS browses signed out when the owner says: its own tabs in a profile of their own', async () => {
  assert(JSON.stringify(parity.agentTab('jarvis')) === '{}', 'signed out without the owner choosing it');
  parity.settings({ agentProfile: true });
  assert(parity.hello().agentProfile === true, 'the setting did not stick');
  assert(parity.agentTab('jarvis').partition === AGENT_PARTITION && JSON.stringify(parity.agentTab('code:7')) === '{}' && JSON.stringify(parity.agentTab('')) === '{}', 'the wrong tabs go signed out');
  const own = newTab();
  await own.webContents.loadURL(`${base}/other`);
  await page(own, `document.cookie = 'owner=signed-in; path=/'; 1`);
  const agent = newTab(parity.agentTab('jarvis'));
  agent.agentOwner = 'jarvis';
  assert(agent.agentProfile === true && parity.tabInfo(agent).agentProfile === true, 'not marked as JARVIS’s profile');
  await agent.webContents.loadURL(`${base}/other`);
  const owners = await session.fromPartition(PARTITION).cookies.get({ url: base });
  const mine = await session.fromPartition(AGENT_PARTITION).cookies.get({ url: base });
  assert(owners.some((c) => c.name === 'owner') && mine.length === 0, `the owner’s cookies reached JARVIS’s profile: ${mine.map((c) => c.name)} (owner’s: ${owners.map((c) => c.name)})`);
  assert((await page(agent, 'navigator.userAgent')).includes('Chrome/') && !(await page(agent, 'navigator.userAgent')).includes('Electron'), 'its user agent');
  parity.sessionNow();
  assert(!parity.state().session.tabs.some((t) => t === agent), 'kept');
  parity.settings({ agentProfile: false });
});

test('Split view: a second tab beside the one on show, following the dock; picking it swaps sides; closing it ends the split', async () => {
  for (const view of tabs.splice(0)) view.webContents.close();
  const left = newTab();
  await left.webContents.loadURL(`${base}/other?left`);
  const right = newTab();
  await right.webContents.loadURL(`${base}/other?right`);
  active = left;
  parity.selected(left);
  parity.dock({ open: true });
  parity.setSplitBounds({ x: 600, y: 100, width: 400, height: 500 });
  assert(parity.splitWith(left) === false, 'split with itself');
  assert(parity.splitWith(right) === true && parity.split === right, 'no split');
  const placed = (view) => view.inSplit === true && JSON.stringify(view.getBounds()) === '{"x":600,"y":100,"width":400,"height":500}';
  assert(placed(right), `the right tab isn’t in the right pane: ${JSON.stringify(right.getBounds())}`);
  const said = lastSent('feature:browser:split')[1];
  assert(said.on && said.tab === right.webContents.id && said.url === `${base}/other?right` && said.title === 'Other', JSON.stringify(said));
  assert(parity.tabInfo(left).split === 'left' && parity.tabInfo(right).split === 'right', 'the strip isn’t told the sides');
  parity.dock({ open: false });
  assert(right.inSplit === false, 'the right pane stayed with the dock closed');
  parity.dock({ open: true });
  assert(placed(right), 'the right pane didn’t come back with the dock');
  parity.setSplitBounds(null);
  assert(right.inSplit === false, 'no place, still shown');
  parity.setSplitBounds({ x: 600, y: 100, width: 400, height: 500 });
  // The right tab picked (main.js puts it on the left): the two change sides.
  active = right;
  parity.selected(right);
  assert(parity.split === left && placed(left) && right.inSplit === false, 'the sides didn’t swap');
  parity.splitAction({ action: 'swap' }); // the pane's ⇄
  assert(parity.split === right && active === right === false && placed(right), 'swap back');
  // The tab on the right closes: the split ends.
  tabs.splice(tabs.indexOf(right), 1);
  right.webContents.close();
  await until(() => parity.split === null);
  assert(parity.split === null && lastSent('feature:browser:split')[1].on === false, 'the split outlived its tab');
  parity.splitWith(newTab());
  parity.splitAction({ action: 'close' });
  assert(parity.split === null, 'Close split view didn’t');
});

test('A tab popped out into a window of its own: the dock shows another, its bar drives it, closing the window puts it back', async () => {
  const a = newTab();
  await a.webContents.loadURL(`${base}/other?a`);
  const b = newTab();
  await b.webContents.loadURL(`${base}/other?b`);
  active = b;
  parity.selected(b);
  assert(parity.popOut(b) === true && parity.popOut(b) === false, 'popped out, or twice');
  const popWin = b.popout;
  assert(popWin && popWin.contentView.children.includes(b), 'the page did not move into its window');
  assert(active !== b && tabs.includes(b), 'the dock kept it on show, or lost it');
  assert(parity.tabInfo(b).popout === true && parity.poppedOut(b) && parity.windowOf(b) === popWin && parity.windowOf(a) === win, 'not marked as popped out');
  const bounds = b.getBounds();
  assert(bounds.y === 44 && bounds.width === popWin.getContentSize()[0], JSON.stringify(bounds));
  const bar = (code) => popWin.webContents.executeJavaScript(code, true);
  await until(async () => popWin.webContents.getURL().endsWith('popout.html') && (await bar('document.getElementById("address").value').catch(() => '')) === `${base}/other?b`, 10000);
  assert((await bar('document.getElementById("address").value')) === `${base}/other?b` && popWin.getTitle() === 'Other', 'the bar doesn’t show the page');
  // The bar goes somewhere typed, then back (through its preload, for its own tab only).
  await bar(`document.getElementById("address").value = "${base}/other?c"; document.getElementById("bar").requestSubmit(); 1`);
  await until(() => b.webContents.getURL() === `${base}/other?c`, 10000);
  assert(b.webContents.getURL() === `${base}/other?c`, 'the bar’s address went nowhere');
  await until(async () => !(await bar('document.getElementById("back").disabled')), 10000);
  await bar('document.getElementById("back").click(); 1');
  await until(() => b.webContents.getURL() === `${base}/other?b`, 10000);
  assert(b.webContents.getURL() === `${base}/other?b`, 'the bar’s back didn’t');
  // Its Back to the dock: the page comes back, the window goes.
  await bar('document.getElementById("dock").click(); 1');
  await until(() => popWin.isDestroyed());
  assert(popWin.isDestroyed() && !b.popout && active === b, 'not back in the dock');
  // Popped again, and its window closed: back in the dock too.
  parity.popOut(b);
  const again = b.popout;
  again.close();
  await until(() => again.isDestroyed());
  assert(!b.popout && active === b, 'closing the window lost the page');
  // Popped out, its prompts come in its own window's box (the dock's strip never shows it).
  parity.popOut(b);
  const own = b.popout;
  own.isVisible = () => true; // as a window on screen is (the test shows none)
  boxes.length = 0;
  boxAnswer = 0; // Allow
  parity.setSite({ origin: base, kind: 'camera', value: 'ask' });
  const camera = await page(b, 'navigator.mediaDevices.getUserMedia({ video: true }).then(() => "ok", (e) => e.name)');
  assert(camera === 'ok' && boxes.length === 1 && boxes[0].owner === own, `the prompt didn’t ask in its window: ${camera} ${boxes.map((x) => x.owner === own)}`);
  assert(parity.ownerOf(b.webContents) === own && !parity.inDock(b.webContents), 'its window isn’t its owner');
  parity.popIn(b);
  // Popped, and ⌘W in its page: back. Popped, and its tab closed: the window goes.
  parity.popOut(b);
  const third = b.popout;
  assert(parity.popoutKey(b, { type: 'keyDown', key: 'w', meta: true }) === true && third.isDestroyed() && active === b, '⌘W didn’t put it back');
  parity.popOut(b);
  const fourth = b.popout;
  tabs.splice(tabs.indexOf(b), 1);
  b.webContents.close();
  await until(() => fourth.isDestroyed());
  assert(fourth.isDestroyed(), 'the window outlived its tab');
});

test('Quitting with a split on and a tab popped out: nothing calls back into the dock as the windows close', async () => {
  const a = newTab();
  await a.webContents.loadURL(`${base}/other?qa`);
  const b = newTab();
  await b.webContents.loadURL(`${base}/other?qb`);
  const c = newTab();
  await c.webContents.loadURL(`${base}/other?qc`);
  active = a;
  parity.selected(a);
  parity.dock({ open: true });
  assert(parity.splitWith(b) && parity.popOut(c), 'no split, or no popped-out tab');
  const calls = [];
  const was = { select: parity.hooks.select, changed: parity.hooks.changed };
  parity.hooks.select = () => calls.push('select');
  parity.hooks.changed = () => calls.push('changed');
  parity.quitting = true; // as app's before-quit sets it
  try {
    const own = c.popout;
    own.close(); // the window closing as the app quits
    tabs.splice(tabs.indexOf(b), 1);
    b.webContents.close(); // the split's tab going
    await until(() => parity.split === null && own.isDestroyed());
    assert(parity.split === null && !c.popout, 'the split or the popped-out tab outlived the quit');
    assert(!calls.length, `the dock was called back while quitting: ${calls}`);
  } finally {
    parity.quitting = false;
    Object.assign(parity.hooks, was);
  }
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
    openTab: (url, opts) => { opened.push(url); if (opts) { const view = newTab(opts); active = view; } },
    restoreTab: () => newTab(),
    select: (view) => { active = view; parity.selected(view); },
    closeTab: (view) => { tabs.splice(tabs.indexOf(view), 1); view.webContents.close(); },
    changed: () => sent.push(['changed']),
    keep: (url) => !url.includes('/secret'),
    browserData: () => browserData,
    saveBrowserData: () => { saves += 1; },
    saveDialog: () => Promise.resolve(savePick),
    openExternal: (url) => { openedOutside.push(url); },
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
