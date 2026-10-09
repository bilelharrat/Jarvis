// Eden Code's Preview check in the app itself (app/features/code-verify.js), in a real
// Chromium: a dev server's page on 127.0.0.1 checked in the hidden preview (its console
// errors, its failed requests, its picture), the preview kept for the next check and not
// drawn while it waits, a fresh picture each time, and only pages on this Mac. Hidden windows
// only; nothing leaves 127.0.0.1.
//
//   app/node_modules/.bin/electron tests/web/code-verify.e2e.cjs      (about 15 s; exit 1 on a failure)
'use strict';

const { app, BrowserWindow, WebContentsView, nativeImage } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jarvis-verify-test-')));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
app.on('window-all-closed', () => {});  // the hidden preview comes and goes: the test decides when to quit

const verify = require('../../app/features/code-verify');

// Each load of the page has the next colour, so a picture shows which load it's of.
const COLOURS = [[220, 30, 30], [30, 60, 220], [240, 200, 20], [140, 40, 200]];
let loads = 0;
function serve() {
  const server = http.createServer((req, res) => {
    if (req.url === '/') {
      const [r, g, b] = COLOURS[loads++ % COLOURS.length];
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><meta charset=utf-8><title>Dev app</title>
<style>html,body{margin:0;height:100%;background:rgb(${r},${g},${b})}@keyframes s{to{transform:rotate(360deg)}}
.spin{width:40px;height:40px;border:4px solid #fff;border-top-color:transparent;border-radius:50%;animation:s 1s linear infinite}</style>
<div class=spin></div><script>console.error('boom on load'); fetch('/missing.json').catch(() => {});
window.frames_ = 0; const tick = () => { window.frames_++; requestAnimationFrame(tick); }; requestAnimationFrame(tick);</script>`);
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(cond, message) { if (!cond) throw new Error(message); }
let base;

// The hidden previews open now (offscreen windows).
const previews = () => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.webContents.isOffscreen());

// The colour in the middle of a check's picture (a JPEG), as [r, g, b].
function middle(shot) {
  const image = nativeImage.createFromBuffer(Buffer.from(shot, 'base64'));
  const { width, height } = image.getSize();
  const px = image.toBitmap();
  const i = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4;
  return [px[i + 2], px[i + 1], px[i]]; // BGRA
}
const near = (got, want) => got.every((v, i) => Math.abs(v - want[i]) < 40);

test('A check runs in a hidden preview: its errors, its picture, then it waits undrawn', async () => {
  const r = await verify.check({ url: `${base}/`, width: 800, height: 600, settle: 300 });
  assert(r.ok && r.source === 'preview' && r.status === 200 && r.title === 'Dev app', JSON.stringify({ ...r, shot: undefined, thumb: undefined }).slice(0, 400));
  assert(r.errors.some((e) => e.kind === 'console' && /boom on load/.test(e.text)), `no console error: ${JSON.stringify(r.errors)}`);
  assert(r.errors.some((e) => e.kind === 'network' && /missing\.json → 404/.test(e.text)), `no failed request: ${JSON.stringify(r.errors)}`);
  assert(!r.errors.some((e) => /favicon/.test(e.text)), 'the favicon’s 404 was counted');
  assert(r.size[0] === 800 && typeof r.thumb === 'string' && r.thumb.length > 100, JSON.stringify(r.size));
  assert(near(middle(r.shot), COLOURS[0]), `the picture isn't the page: ${middle(r.shot)}`);
  const open = previews();
  assert(open.length === 1, `${open.length} previews open`);
  assert(open[0].webContents.isPainting() === false, 'the preview keeps drawing while it waits');
});

test('The next check draws it again, with a fresh picture, and stops after', async () => {
  const [before] = previews();
  const r = await verify.check({ url: `${base}/`, width: 800, height: 600, settle: 300 });
  assert(r.ok && r.source === 'preview', JSON.stringify(r.errors || r.error));
  assert(previews().length === 1 && previews()[0] === before, 'the preview wasn’t kept for the next check');
  assert(near(middle(r.shot), COLOURS[1]), `an old picture: ${middle(r.shot)}`);
  assert(before.webContents.isPainting() === false, 'the preview keeps drawing while it waits');
  // Undrawn, the page itself still runs as before (its animation frames keep coming); without
  // a reload, what changed in it meanwhile is what's pictured.
  const served = loads;
  const frames = () => before.webContents.executeJavaScript('window.frames_');
  const idle = await frames();
  await new Promise((r) => setTimeout(r, 400));
  assert((await frames()) - idle >= 5, `the page stood still while it waited: ${(await frames()) - idle} frames`);
  await before.webContents.executeJavaScript("document.body.style.background = 'rgb(30, 160, 40)'; true");
  const still = await verify.check({ url: `${base}/`, reload: false, settle: 300 });
  assert(still.ok && loads === served, `reloaded: ${loads - served} loads`);
  assert(near(middle(still.shot), [30, 160, 40]), `the picture is from before the change: ${middle(still.shot)}`);
  assert(before.webContents.isPainting() === false, 'the preview keeps drawing while it waits');
});

test('Two checks at once share the preview, and it stops drawing once both are done', async () => {
  const [a, b] = await Promise.all([
    verify.check({ url: `${base}/`, settle: 300 }),
    verify.check({ url: `${base}/`, settle: 600 }),
  ]);
  assert(a.ok && b.ok && a.shot && b.shot, JSON.stringify([a.error, b.error]));
  const open = previews();
  assert(open.length === 1 && open[0].webContents.isPainting() === false, `${open.length} previews, drawing: ${open.map((w) => w.webContents.isPainting())}`);
});

test('A tab that can’t be pictured goes to the preview, which waits undrawn even when its picture fails', async () => {
  verify.closeAll();
  // A browser tab on the dev server that isn't on show (no window: it can't be pictured).
  const tab = new WebContentsView({ webPreferences: { partition: 'persist:jarvis-browser', sandbox: true, contextIsolation: true } });
  await tab.webContents.loadURL(`${base}/`);
  const proto = Object.getPrototypeOf(tab.webContents);
  const capture = proto.capturePage;
  try {
    const r = await verify.check({ url: `${base}/`, settle: 300 });
    assert(r.ok && r.source === 'tab' && r.shot, JSON.stringify(r.error || r.errors));
    assert(previews().length === 1 && previews()[0].webContents.isPainting() === false, 'the preview that took the picture keeps drawing');
    // The preview's picture failing (its page gone): it still waits undrawn, and closes when idle.
    proto.capturePage = function (...args) { return this.isOffscreen() ? Promise.reject(new Error('the page is gone')) : capture.apply(this, args); };
    const failed = await verify.check({ url: `${base}/`, settle: 300 });
    assert(/the page is gone/.test(failed.error || ''), JSON.stringify(failed));
    const open = previews();
    assert(open.length === 1 && open[0].webContents.isPainting() === false, `${open.length} previews, drawing: ${open.map((w) => w.webContents.isPainting())}`);
  } finally {
    proto.capturePage = capture;
    tab.webContents.close();
  }
});

test('Only a dev server on this Mac is checked, and closing ends the previews', async () => {
  for (const url of ['https://example.com/', 'http://10.0.0.8:3000/', 'file:///etc/hosts', 'nonsense']) {
    const r = await verify.check({ url });
    assert(/on this Mac/.test(r.error || ''), `${url} was checked`);
  }
  assert(verify.isLocal('http://localhost:5173/') && verify.isLocal('http://app.localhost/') && verify.isLocal('http://[::1]:8000/'), 'a local address was refused');
  verify.closeAll();
  assert(previews().length === 0, 'a preview stayed open');
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
  verify.closeAll();
  server.close();
  app.exit(failed ? 1 : 0);
});
