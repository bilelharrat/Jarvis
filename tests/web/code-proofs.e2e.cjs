// The app's side of Eden Code's design match and video proof (app/features/design-match.js,
// app/features/video-proof.js), in a real Chromium: a page served on 127.0.0.1 is rendered at
// a design's size and its pictures shrunk for the comparison, and recorded to a WebM video
// from the DevTools screencast. Hidden windows only; nothing leaves 127.0.0.1.
//
//   app/node_modules/.bin/electron tests/web/code-proofs.e2e.cjs      (about 25 s; exit 1 on a failure)
'use strict';

const { app, nativeImage } = require('electron');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jarvis-proofs-test-')));
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
app.on('window-all-closed', () => {});  // the hidden windows come and go: the test decides when to quit

const design = require('../../app/features/design-match');
const video = require('../../app/features/video-proof');

const PAGE = `<!doctype html><meta charset=utf-8><title>Shop</title>
<style>body{margin:0;font:16px sans-serif;background:#f4f4f4}header{height:120px;background:#1d4ed8}
main{height:1800px;background:linear-gradient(#fff,#ddd)}</style><header></header><main><p id=n>0</p></main>
<script>let n=0;setInterval(()=>{document.getElementById('n').textContent=++n},100)</script>`;

function serve() {
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); return; }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// A design picture of w × h: the top `band` pixels one colour, the rest another.
function picture(w, h, band, top, rest) {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const [r, g, b] = y < band ? top : rest;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = 255;  // BGRA
    }
  }
  return nativeImage.createFromBitmap(buf, { width: w, height: h }).toPNG();
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
function assert(cond, message) { if (!cond) throw new Error(message); }
let base;

test('A design’s size decides the page’s, a Retina shot at half', async () => {
  const a = design.viewportFor(1440, 900);
  assert(a.width === 1440 && a.height === 900 && a.scale === 1, JSON.stringify(a));
  const b = design.viewportFor(2880, 1800);
  assert(b.width === 1440 && b.height === 900 && b.scale === 2, JSON.stringify(b));
  const c = design.compareSize(1440, 900);
  assert(c.cw === 256 && c.ch === 160, JSON.stringify(c));
});

test('The page is rendered at the design’s size and both pictures come back the same size', async () => {
  const png = picture(800, 600, 120, [29, 78, 216], [250, 250, 250]);
  const r = await design.compare({ url: `${base}/`, design: new Uint8Array(png), settle: 300 });
  assert(r.ok, JSON.stringify(r).slice(0, 300));
  assert(r.size[0] === 800 && r.size[1] === 600 && r.cw === 256 && r.ch === 192, JSON.stringify({ size: r.size, cw: r.cw, ch: r.ch }));
  const bytes = 256 * 192 * 3;
  assert(Buffer.from(r.a, 'base64').length === bytes && Buffer.from(r.b, 'base64').length === bytes, 'the shrunk pictures are the wrong size');
  // The page's blue header is in the page's picture: its top rows are blue, like the design's.
  const b = Buffer.from(r.b, 'base64');
  assert(b[2] > 150 && b[0] < 80, `the header isn't blue: ${[b[0], b[1], b[2]]}`);
  for (const k of ['shot', 'design_shot', 'thumb', 'design_thumb']) {
    assert(typeof r[k] === 'string' && Buffer.from(r[k], 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), `${k} isn't a JPEG`);
  }
  assert(r.thumb.length <= 44000 && r.design_thumb.length <= 44000, 'a thumbnail is too big for the transcript');
});

test('Only a page on this Mac is rendered or recorded, and a design must be a picture', async () => {
  const png = new Uint8Array(picture(40, 40, 10, [0, 0, 0], [255, 255, 255]));
  assert(/this Mac/.test((await design.compare({ url: 'https://example.com/', design: png })).error), 'an outside page was rendered');
  assert(/missing/.test((await design.compare({ url: `${base}/`, design: null })).error), 'no design was taken');
  assert(/read/.test((await design.compare({ url: `${base}/`, design: new Uint8Array([1, 2, 3]) })).error), 'a non-picture was taken');
  assert(/this Mac/.test((await video.record({ url: 'https://example.com/' })).error), 'an outside page was recorded');
});

test('The page is recorded to a WebM video from its own frames, with a poster', async () => {
  const r = await video.record({ url: `${base}/`, seconds: 3, width: 640, height: 400 });
  assert(r.ok, JSON.stringify(r).slice(0, 300));
  const webm = Buffer.from(r.webm, 'base64');
  assert(webm.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])), 'not a WebM (EBML) file');
  assert(webm.length > 2000 && r.frames >= 2, `${webm.length} bytes, ${r.frames} frames`);
  assert(r.seconds >= 1 && r.seconds <= 10, `seconds: ${r.seconds}`);
  assert(Buffer.from(r.poster, 'base64').subarray(0, 2).equals(Buffer.from([0xff, 0xd8])), 'the poster isn’t a JPEG');
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
  server.close();
  app.exit(failed ? 1 : 0);
});
