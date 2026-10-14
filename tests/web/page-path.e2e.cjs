// The app's own pages on eden-app:// (app/page-path.js, S3-4) in a real Electron: the pages are
// packed into an app.asar of their own (as a build has them, nothing unpacked beside it), the
// main process serves them from inside it, and the loading page loads with its stylesheet and
// script on the first try (no ERR_FILE_NOT_FOUND), while the app's code is never served.
// A hidden window only; nothing leaves the machine.
//
//   app/node_modules/.bin/electron tests/web/page-path.e2e.cjs      (a few seconds; exit 1 on a failure)
'use strict';

const { app, BrowserWindow, net, protocol } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = path.join(__dirname, '..', '..', 'app');
const pages = require(path.join(APP, 'page-path.js'));
const asar = require(require.resolve('@electron/asar', { paths: [APP] })); // (the builds' own packer)

const TEMP = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'jarvis-pages-test-'));
app.setPath('userData', path.join(TEMP, 'profile'));
app.on('window-all-closed', () => {});
protocol.registerSchemesAsPrivileged(pages.PRIVILEGES);

const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok' : 'FAIL'} - ${what}`); if (!ok) failures.push(what); };

async function main() {
  // An app folder with the pages and a stand-in for the app's code, packed into app.asar.
  const src = path.join(TEMP, 'src');
  fs.mkdirSync(src);
  for (const name of pages.PAGES) fs.copyFileSync(path.join(APP, name), path.join(src, name));
  fs.writeFileSync(path.join(src, 'main.js'), '// the app\'s code: never served\n');
  const packed = path.join(TEMP, 'Resources', 'app.asar');
  fs.mkdirSync(path.dirname(packed));
  await asar.createPackage(src, packed);
  check(!fs.existsSync(`${packed}.unpacked`), 'nothing of the pages is unpacked beside the asar');

  pages.serve(protocol, packed);
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  const failed = [];
  win.webContents.on('did-fail-load', (_e, code, description, url) => failed.push(`${description} (${code}) ${url}`));
  await win.loadURL(pages.pageUrl('loading.html', { app: 'eden-code' }));
  check(failed.length === 0, `the loading page loads on the first try${failed.length ? `: ${failed.join('; ')}` : ''}`);
  const seen = await win.webContents.executeJavaScript(`({
    title: document.title,
    message: document.getElementById('message').textContent,
    eden: document.body.classList.contains('eden-code'),
    styled: [...document.styleSheets].some((s) => s.href && s.href.endsWith('/loading.css') && s.cssRules.length > 0),
    origin: location.origin,
  })`);
  check(seen.title === 'Eden Code' && seen.eden, `its script ran (${seen.title})`);
  check(seen.styled, 'its stylesheet came');
  check(seen.origin === pages.ORIGIN, `it is on the app's own origin (${seen.origin})`);
  const status = await Promise.all(['main.js', 'loading.js', 'daredevil-open.wav']
    .map((f) => net.fetch(`${pages.ORIGIN}/${f}`).then((r) => r.status, () => 'refused')));
  check(status[0] === 404, `the app's code isn't served (${status[0]})`);
  check(status[1] === 200 && status[2] === 200, `the page's own files are (${status.slice(1)})`);
  win.destroy();
}

app.whenReady()
  .then(main)
  .catch((err) => { console.error(err); failures.push(String(err)); })
  .finally(() => {
    try { fs.rmSync(TEMP, { recursive: true, force: true }); } catch (_) { /* Chromium still has its profile */ }
    console.log(failures.length ? `\n${failures.length} failed` : '\nall passed');
    app.exit(failures.length ? 1 : 0);
  });
