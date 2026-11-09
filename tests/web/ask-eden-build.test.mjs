// Ask Eden for Mac (app/eden/build.js) carries the backend the Eden apps share, which serves the
// window hand tracking and the terminal from JARVIS_APP_DIR, outside app.asar
// (app/scripts/release/backend-app-dir.js): the build copies them there and stops when any is
// missing or isn't the version package-lock.json pins. Ask Eden 0.1.0 shipped without them, and
// hand control couldn't start. Made-up app folders, then the repo's own. node --test tests/web/
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const appDirs = require('../../app/scripts/release/backend-app-dir.js');
const { bundledEnv } = require('../../app/backend-launch.js');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP = path.join(REPO, 'app');
const INSTALLED = !fs.existsSync(path.join(APP, 'node_modules')) && 'no app/node_modules (npm ci in app/)';

const made = [];
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-eden-build-')); made.push(dir); return dir; };
const touch = (file, text = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const launcherAppDir = (resources) => bundledEnv({}, { resourcesPath: resources, token: 't', extraPath: [] }).JARVIS_APP_DIR;

const PINNED = { '@mediapipe/tasks-vision': '1.0.1', '@xterm/xterm': '5.5.0', '@xterm/addon-fit': '0.11.0' };

// A made-up app/ as npm ci leaves it: package-lock.json, each package at its version with the
// files the window loads, and the icon. `drop`: packages or package/file paths left out.
function fakeApp({ drop = [], versions = PINNED, lock = PINNED, empty = [] } = {}) {
  const dir = temp();
  const locked = Object.fromEntries(Object.entries(lock).map(([name, version]) => [`node_modules/${name}`, { version }]));
  touch(path.join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...locked } }));
  for (const { name, files } of appDirs.PACKAGES) {
    if (drop.includes(name)) continue;
    touch(path.join(dir, 'node_modules', name, 'package.json'), JSON.stringify({ name, version: versions[name] }));
    for (const file of files) {
      const rel = `${name}/${file}`;
      if (!drop.includes(rel)) touch(path.join(dir, 'node_modules', rel), empty.includes(rel) ? '' : 'x');
    }
  }
  if (!drop.includes(appDirs.ICON)) touch(path.join(dir, appDirs.ICON), 'png');
  return dir;
}

// What fillAppDir makes of `app` in a new app.asar.unpacked, and what's wrong with it.
function filled(app) {
  const out = path.join(temp(), 'app.asar.unpacked');
  appDirs.fillAppDir(app, out);
  return { out, problems: appDirs.appDirProblems(out, appDirs.lockedVersions(app)) };
}

test('the folder filled and checked is the one the launcher points the backend at (JARVIS_APP_DIR)', () => {
  const resources = '/Applications/Ask Eden.app/Contents/Resources';
  assert.equal(appDirs.appDirIn(resources), launcherAppDir(resources));
  assert.equal(appDirs.appDirIn(resources), `${resources}/app.asar.unpacked`);
});

test('copied from app/: hand tracking, the terminal and the icon, real files at the pinned versions', () => {
  const app = fakeApp();
  // A package npm linked in comes as its files, not the link (the app is copied to other Macs).
  const linked = path.join(temp(), 'addon-fit');
  fs.renameSync(path.join(app, 'node_modules', '@xterm', 'addon-fit'), linked);
  fs.symlinkSync(linked, path.join(app, 'node_modules', '@xterm', 'addon-fit'));
  const { out, problems } = filled(app);
  assert.deepEqual(problems, []);
  assert.doesNotThrow(() => appDirs.checkAppDir(out, app, 'Ask Eden.app'));
  for (const name of ['@mediapipe/tasks-vision', '@xterm/xterm', '@xterm/addon-fit']) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'node_modules', name, 'package.json'), 'utf8')).version, PINNED[name]);
  }
  assert.equal(fs.lstatSync(path.join(out, 'node_modules', '@xterm', 'addon-fit')).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(out, 'build', 'icon-1024.png'), 'utf8'), 'png');
});

test('an app without them, as Ask Eden 0.1.0 shipped, stops the build and names each', () => {
  const app = fakeApp();
  const out = path.join(temp(), 'app.asar.unpacked'); // never made
  assert.throws(() => appDirs.checkAppDir(out, app, 'Ask Eden.app'), (err) => {
    assert.ok(err instanceof require('../../app/scripts/release/util.js').BuildError);
    assert.match(err.message, /^Ask Eden\.app lacks what the backend serves the window from JARVIS_APP_DIR/);
    for (const name of ['@mediapipe/tasks-vision', '@xterm/xterm', '@xterm/addon-fit']) assert.ok(err.message.includes(`${name}: missing`), name);
    assert.match(err.message, /build\/icon-1024\.png: missing/);
    return true;
  });
});

test('a file the window loads missing or empty, a package left out, or one not at the pinned version: each stops it', () => {
  assert.deepEqual(filled(fakeApp({ drop: ['@mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.wasm'] })).problems,
    ['@mediapipe/tasks-vision: no wasm/vision_wasm_nosimd_internal.wasm']);
  assert.deepEqual(filled(fakeApp({ empty: ['@xterm/xterm/lib/xterm.js'] })).problems, ['@xterm/xterm: no lib/xterm.js']);
  const out = path.join(temp(), 'app.asar.unpacked');
  appDirs.fillAppDir(fakeApp(), out);
  fs.rmSync(path.join(out, 'node_modules', '@mediapipe'), { recursive: true });
  assert.deepEqual(appDirs.appDirProblems(out, PINNED), [`@mediapipe/tasks-vision: missing (${path.join(out, 'node_modules', '@mediapipe', 'tasks-vision')})`]);
  assert.deepEqual(filled(fakeApp({ versions: { ...PINNED, '@xterm/xterm': '5.4.0' } })).problems,
    ['@xterm/xterm: 5.4.0, but package-lock.json pins 5.5.0']);
  const { '@xterm/addon-fit': _, ...unlocked } = PINNED;
  assert.deepEqual(filled(fakeApp({ lock: unlocked })).problems, ['@xterm/addon-fit: not in package-lock.json']);
});

test('app/ without them (no npm ci) fails before anything is copied, naming the package', () => {
  const app = fakeApp({ drop: ['@mediapipe/tasks-vision'] });
  assert.throws(() => appDirs.checkAppDir(app, app, 'app/'), /@mediapipe\/tasks-vision: missing/);
  assert.throws(() => appDirs.fillAppDir(app, path.join(temp(), 'app.asar.unpacked')), /ENOENT/);
});

test('what is checked is what the window loads: /vision and /xterm, as the backend mounts them', () => {
  const server = fs.readFileSync(path.join(REPO, 'src', 'jarvis', 'server.py'), 'utf8');
  assert.match(server, /^VISION_DIR = packaged\.app_dir\(\) \/ "node_modules" \/ "@mediapipe" \/ "tasks-vision"$/m);
  assert.match(server, /^XTERM_DIR = packaged\.app_dir\(\) \/ "node_modules" \/ "@xterm"$/m);
  assert.match(server, /Mount\("\/vision", StaticFiles\(directory=VISION_DIR\b/);
  assert.match(server, /Mount\("\/xterm", StaticFiles\(directory=XTERM_DIR\b/);
  const checked = appDirs.PACKAGES.flatMap(({ name, files }) => files.map((file) => `node_modules/${name}/${file}`));
  const web = path.join(REPO, 'src', 'jarvis', 'web');
  const urls = [];
  for (const file of fs.readdirSync(web, { recursive: true })) {
    if (!/\.(m?js|html|css)$/.test(file)) continue;
    for (const m of fs.readFileSync(path.join(web, file), 'utf8').matchAll(/['"`](\/(?:vision|xterm)\/[^'"`]+)['"`]/g)) urls.push(m[1]);
  }
  assert.ok(urls.includes('/vision/vision_bundle.mjs') && urls.includes('/xterm/xterm/lib/xterm.js'), urls.join(' '));
  for (const url of urls) {
    const file = url.replace(/^\/vision\//, 'node_modules/@mediapipe/tasks-vision/').replace(/^\/xterm\//, 'node_modules/@xterm/');
    // A folder (FilesetResolver's wasm base): its loader and binary, with SIMD and without.
    const ok = checked.includes(file) || ['_internal', '_nosimd_internal'].every((v) => ['js', 'wasm'].every((ext) => checked.includes(`${file}/vision_wasm${v}.${ext}`)));
    assert.ok(ok, `${url} (${file}) isn't checked`);
  }
});

test("the repo's app/ has them, at the versions package-lock.json pins", { skip: INSTALLED }, () => {
  assert.deepEqual(appDirs.appDirProblems(APP, appDirs.lockedVersions(APP)), []);
  assert.deepEqual(appDirs.lockedVersions(APP), PINNED);
});

test("Ask Eden's build copies them where its launcher points the engine, and a finished app without them stops it", { skip: INSTALLED }, () => {
  const build = require('../../app/eden/build.js');
  const app = path.join(temp(), 'Ask Eden.app');
  const resources = path.join(app, 'Contents', 'Resources');
  fs.mkdirSync(resources, { recursive: true });
  assert.throws(() => build.checkApp(app), /Error: Ask Eden\.app lacks [\s\S]*@mediapipe\/tasks-vision: missing/);
  build.addAppDir(resources);
  assert.doesNotThrow(() => build.checkApp(app));
  const appDir = launcherAppDir(resources);
  for (const file of ['node_modules/@mediapipe/tasks-vision/vision_bundle.mjs', 'node_modules/@xterm/xterm/lib/xterm.js', 'node_modules/@xterm/addon-fit/lib/addon-fit.js']) {
    assert.equal(fs.readFileSync(path.join(appDir, file)).equals(fs.readFileSync(path.join(APP, file))), true, file);
  }
});

// The engine is built once into a cache and reused. An engine build cut short (offline uv
// lacking a package) leaves Python without its packages: never taken for a finished one.
test('an engine cache without build.json (a build cut short) is never shipped, nor built over when ASK_EDEN_BACKEND names it', { skip: INSTALLED }, () => {
  const engine = temp();
  touch(path.join(engine, 'python', 'bin', 'python3'), '#!/bin/sh\n'); // what a cut-short build leaves
  const resources = path.join(temp(), 'Resources');
  const addEngine = () => spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(APP, 'eden', 'build.js'))}).addEngine(${JSON.stringify(resources)})`], {
    env: { ...process.env, ASK_EDEN_BACKEND: engine, ASKEDEN_HOME: temp(), ASK_EDEN_REBUILD_ENGINE: '' }, encoding: 'utf8',
  });
  const cut = addEngine();
  assert.notEqual(cut.status, 0);
  assert.match(cut.stderr, /ASK_EDEN_BACKEND \(.+\) holds no finished engine \(no build\.json\)/);
  assert.equal(fs.existsSync(path.join(engine, 'python', 'bin', 'python3')), true, 'left as it was');
  assert.equal(fs.existsSync(path.join(resources, 'backend')), false, 'nothing put in the app');
  touch(path.join(engine, 'build.json'), '{}');
  const done = addEngine();
  assert.equal(done.status, 0, done.stderr);
  assert.equal(fs.existsSync(path.join(resources, 'backend', 'python', 'bin', 'python3')), true);
  assert.equal(fs.existsSync(path.join(launcherAppDir(resources), 'node_modules', '@mediapipe', 'tasks-vision', 'vision_bundle.mjs')), true);
});
