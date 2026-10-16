// "Check it yourself" in the app itself (app/features/self-check.js), in a real Chromium: a
// session's own dev server page on 127.0.0.1 opened in its hidden preview, read as an
// accessibility tree with refs, clicked and typed into by those refs, its console errors and
// failed requests read, its picture taken; and the trust rules: only the origins the check
// was given, a link or form leaving them refused (S31), a password form asked about, a page
// that tries to leave stopped, files only inside the project (S29). Hidden windows only;
// nothing leaves 127.0.0.1.
//
//   app/node_modules/.bin/electron tests/web/self-check.e2e.cjs      (about 10 s; exit 1 on a failure)
'use strict';

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

app.setPath('userData', fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jarvis-selfcheck-test-')));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
app.on('window-all-closed', () => {});

const check = require('../../app/features/self-check');

const PAGE = `<!doctype html><meta charset=utf-8><title>Counter</title>
<main><h1 id=h>Count: 0</h1>
<button id=b onclick="document.getElementById('h').textContent = 'Count: ' + (++window.n)">Add one</button>
<label>Name <input id=name></label>
<a href="https://example.com/">Away</a>
<form action="https://evil.test/collect"><button>Send it</button></form>
<form action="/login" method=post><input type=password name=pw><button>Log in</button></form>
<button id=leave onclick="location.href='https://example.com/'">Leave by script</button>
</main>
<script>window.n = 0; console.error('boom on load'); fetch('/missing.json').catch(() => {});</script>`;

function serve() {
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return; }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(cond, message) { if (!cond) throw new Error(message); }
let base;
const S = 'code-7';
const rules = () => ({ origins: [base], root: '' });
const refOf = (text, words) => {
  const line = text.split('\n').find((l) => l.includes(words));
  const m = line && line.match(/\[(e\d+)\]/);
  return m ? m[1] : '';
};
const hidden = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.webContents.isOffscreen());

test('The session opens its own page hidden, reads it by refs, clicks and types', async () => {
  const opened = await check.call({ session: S, action: 'open', args: { url: `${base}/`, rules: rules() } });
  assert(opened.ok && opened.title === 'Counter', `not opened: ${JSON.stringify(opened)}`);
  assert(hidden().length === 1 && !hidden()[0].isVisible(), 'the preview is not one hidden window');
  const snap = await check.call({ session: S, action: 'snapshot', args: {} });
  assert(snap.ok && /Count: 0/.test(snap.text), `no tree: ${snap.message}`);
  const add = refOf(snap.text, 'Add one');
  assert(add, `no ref for the button:\n${snap.text}`);
  const clicked = await check.call({ session: S, action: 'act', args: { kind: 'click', ref: add } });
  assert(clicked.ok, `the click failed: ${clicked.message}`);
  const after = await check.call({ session: S, action: 'snapshot', args: {} });
  assert(/Count: 1/.test(after.text), 'the click did nothing');
  const name = refOf(after.text, 'textbox "Name"');
  const typed = await check.call({ session: S, action: 'act', args: { kind: 'type', ref: name, text: 'Ada' } });
  assert(typed.ok, `typing failed: ${typed.message}`);
  const scrolled = await check.call({ session: S, action: 'scroll', args: { amount: 1 } });
  assert(scrolled.ok, 'no scroll');
});

test('Its console errors, its failed requests and its picture', async () => {
  const errors = await check.call({ session: S, action: 'console', args: { level: 'error' } });
  assert(errors.ok && errors.entries.some((e) => /boom on load/.test(e.text)), `no console error: ${JSON.stringify(errors.entries)}`);
  const failed = await check.call({ session: S, action: 'network', args: { failed: true } });
  assert(failed.ok && failed.entries.some((r) => /missing\.json/.test(r.url)), 'no failed request');
  const shot = await check.call({ session: S, action: 'screenshot', args: {} });
  assert(shot.ok && shot.jpeg && shot.thumb && shot.size[0] > 300, `no picture: ${shot.message}`);
  assert(Buffer.from(shot.jpeg, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), 'not a JPEG');
});

test('A link or form leaving the app is refused; a password form asks (S31)', async () => {
  const snap = await check.call({ session: S, action: 'snapshot', args: {} });
  const away = await check.call({ session: S, action: 'act', args: { kind: 'click', ref: refOf(snap.text, 'Away') } });
  assert(away.refused && /leaves/.test(away.message), `the link went: ${JSON.stringify(away)}`);
  const send = await check.call({ session: S, action: 'act', args: { kind: 'click', ref: refOf(snap.text, 'Send it') } });
  assert(send.refused && /outside/.test(send.message), `the form went: ${JSON.stringify(send)}`);
  const login = await check.call({ session: S, action: 'act', args: { kind: 'click', ref: refOf(snap.text, 'Log in') } });
  assert(login.needsConfirm && /password/.test(login.label), `the password form didn't ask: ${JSON.stringify(login)}`);
});

test('A page going elsewhere by itself is stopped, and said', async () => {
  const snap = await check.call({ session: S, action: 'snapshot', args: {} });
  const r = await check.call({ session: S, action: 'act', args: { kind: 'click', ref: refOf(snap.text, 'Leave by script') } });
  assert(r.ok, `the click failed: ${r.message}`);
  await new Promise((res) => setTimeout(res, 300));
  const after = await check.call({ session: S, action: 'snapshot', args: {} });
  assert(after.url.startsWith(base), `the page left: ${after.url}`);
  assert(after.blocked.some((u) => u.startsWith('https://example.com')), `not said: ${JSON.stringify(after.blocked)}`);
});

test('Only the given origins, and files only inside the project (S29)', async () => {
  for (const url of ['https://example.com/', 'http://10.0.0.8:3000/', 'http://127.0.0.1:1/', 'file:///etc/hosts', 'nonsense']) {
    const r = await check.call({ session: 'code-8', action: 'open', args: { url, rules: rules() } });
    assert(!r.ok && /own app/.test(r.message), `${url} was opened`);
  }
  // Eden's own window's page (the backend, on this Mac too) is never a check's.
  const own = new BrowserWindow({ show: false });
  await own.loadURL(`${base}/`);
  const mine = await check.call({ session: 'code-8', action: 'open', args: { url: `${base}/`, rules: rules() } });
  assert(!mine.ok && /Eden’s own/.test(mine.message), `Eden's own page opened: ${JSON.stringify(mine)}`);
  own.destroy();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'selfcheck-project-'));
  fs.writeFileSync(path.join(project, 'index.html'), '<title>Static</title><h1>Hello file</h1>');
  const inside = await check.call({ session: 'code-8', action: 'open', args: { url: pathToFileURL(path.join(project, 'index.html')).href, rules: { origins: [], root: project } } });
  assert(inside.ok && inside.title === 'Static', `the project's file didn't open: ${JSON.stringify(inside)}`);
  const outside = await check.call({ session: 'code-8', action: 'open', args: { url: 'file:///etc/hosts', rules: { origins: [], root: project } } });
  assert(!outside.ok, 'a file outside the project opened');
  assert((await check.call({ session: 'code-8', action: 'close' })).ok, 'not closed');
  check.closeAll();
  assert(hidden().length === 0, 'a preview stayed open');
  const gone = await check.call({ session: S, action: 'snapshot' });
  assert(!gone.ok && /isn’t open/.test(gone.message), 'a closed check still answered');
});

app.whenReady().then(async () => {
  if (app.dock) app.dock.hide();
  const server = await serve();
  base = `http://127.0.0.1:${server.address().port}`;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok     ${t.name}`);
    } catch (err) {
      failed++;
      console.log(`FAILED ${t.name}\n       ${err.message}`);
    }
  }
  console.log(`\n${tests.length - failed} passed, ${failed} failed`);
  check.closeAll();
  server.close();
  app.exit(failed ? 1 : 0);
});
