// The app's own pages in a packaged build (app/page-path.js). With Electron's
// GrantFileProtocolExtraPrivileges fuse off (fuses.js), Chromium's own file handler can't read
// inside app.asar: the first load of app.asar/loading.html failed (ERR_FILE_NOT_FOUND) at every
// launch and the window showed Chromium's error page. The builds keep the pages beside the asar
// and the app loads them from there. node --test tests/web/page-path.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const APP = fileURLToPath(new URL('../../app/', import.meta.url));
const { pagePath, PAGES } = require(path.join(APP, 'page-path.js'));
const read = (f) => fs.readFileSync(path.join(APP, f), 'utf8');

test('a page inside app.asar is loaded from app.asar.unpacked, anything else as it is', () => {
  const res = '/Applications/Eden Code.app/Contents/Resources';
  const there = new Set([`${res}/app.asar.unpacked/loading.html`]);
  const exists = (p) => there.has(p);
  assert.equal(pagePath(`${res}/app.asar`, 'loading.html', { exists }), `${res}/app.asar.unpacked/loading.html`);
  assert.equal(pagePath(`${res}/app.asar/features`, '../loading.html', { exists }).replace(/\/features\/\.\./, ''), `${res}/app.asar.unpacked/loading.html`);
  assert.equal(pagePath(`${res}/app.asar`, 'quick.html', { exists }), `${res}/app.asar/quick.html`, 'not unpacked: as it was');
  assert.equal(pagePath('/Users/me/JARVIS V1/app', 'loading.html', { exists: () => true }), '/Users/me/JARVIS V1/app/loading.html');
});

test('every page the app loads by file is one the builds keep outside the asar, and what it loads too', () => {
  for (const page of ['loading.html', 'hand-hud.html', 'popout.html']) {
    assert.ok(PAGES.includes(page), page);
    for (const [, ref] of read(page).matchAll(/(?:src|href)="([^":]+)"/g)) assert.ok(PAGES.includes(ref), `${page} loads ${ref}`);
  }
  const main = read('main.js');
  assert.doesNotMatch(main, /loadFile\(path\.join\(__dirname, '(loading|hand-hud)\.html'\)/);
  assert.match(main, /win\.loadFile\(pagePath\(__dirname, 'loading\.html'\), \{ query: \{ app: FLAVOR\.id/);
  assert.match(main, /win\.loadFile\(pagePath\(__dirname, 'loading\.html'\), \{ query: \{ error: message/);
  assert.match(main, /hud\.loadFile\(pagePath\(__dirname, 'hand-hud\.html'\)\)/);
  assert.match(read('browser-parity.js'), /pagePath\(__dirname, 'popout\.html'\)/);
  assert.match(read('features/shell.js'), /pagePath\(path\.join\(__dirname, '\.\.'\), 'loading\.html'\)/);
  // The Mac release's app.asar and the Windows builds keep them unpacked.
  assert.match(read('scripts/release/dist.js'), /asar: \{ unpack: UNPACK \}/);
  assert.match(read('scripts/release/dist.js'), /const UNPACK = `\{\*\*\/node_modules\/\{@xterm,@mediapipe\}\/\*\*,\$\{PAGES\.join\(','\)\}\}`;/);
  assert.match(read('scripts/release/windows.js'), /asarUnpack: \['node_modules\/@xterm\/\*\*', 'node_modules\/@mediapipe\/\*\*', \.\.\.PAGES\]/);
});
