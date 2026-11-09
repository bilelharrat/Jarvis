// Ask Eden for Mac (app/eden/build.js) carries the backend the Eden apps share, which serves the
// window hand tracking and the terminal from JARVIS_APP_DIR, outside app.asar
// (app/scripts/release/backend-app-dir.js): the build copies them there and stops when any is
// missing or isn't the version package-lock.json pins. Ask Eden 0.1.0 shipped without them, and
// hand control couldn't start. Made-up app folders, then the repo's own. node --test tests/web/
// The backend's Swift helpers (JARVIS_HELPERS_DIR, app/scripts/release/backend-helpers.js): 0.1.0
// shipped none, so its backend compiled each with swiftc, which Macs without developer tools lack.
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

// ── the Swift helpers (JARVIS_HELPERS_DIR) ──
// The backend takes each helper from JARVIS_HELPERS_DIR while swift_helper.prebuilt() accepts it
// (the program, and `<name>.sha256` naming the hash of the source the backend carries), else
// compiles it with swiftc. Ask Eden's build makes them from the engine's own sources.

const helperDirs = require('../../app/scripts/release/backend-helpers.js');
const { BuildError } = require('../../app/scripts/release/util.js');
const launcherHelpersDir = (resources) => bundledEnv({}, { resourcesPath: resources, token: 't', extraPath: [] }).JARVIS_HELPERS_DIR;
const sha256 = (data) => require('node:crypto').createHash('sha256').update(data).digest('hex');
const VENV_PYTHON = path.join(REPO, '.venv', 'bin', 'python');

// A made-up engine: Python with the jarvis package and its helper sources where the backend
// keeps them (jarvis/<folder>/<name>.swift); a stray one in __pycache__ is no helper.
const ENGINE_SOURCES = {
  'native/jarvis-ocr.swift': 'import Vision // text recognition',
  'audio/jarvis-duplex.swift': '@main struct Duplex { func start() { _ = engine.inputNode } }',
  'player/jarvis-player.swift': 'print("play")',
};
function fakeEngine(sources = ENGINE_SOURCES) {
  const python = path.join(temp(), 'python');
  touch(path.join(python, 'bin', 'python3'), '#!/bin/sh\n');
  const pkg = path.join(python, 'lib', 'python3.12', 'site-packages', 'jarvis');
  touch(path.join(pkg, 'swift_helper.py'), '# prebuilt()\n');
  for (const [rel, text] of Object.entries(sources)) touch(path.join(pkg, ...rel.split('/')), text);
  touch(path.join(pkg, '__pycache__', 'jarvis-stale.swift'), 'stale');
  return python;
}
const sourceOf = (python, rel) => path.join(python, 'lib', 'python3.12', 'site-packages', 'jarvis', ...rel.split('/'));

// swiftc stand-in: the "program" says which target it was built for.
function fakeSwiftc() {
  const script = path.join(temp(), 'swiftc');
  fs.writeFileSync(script, `#!/bin/sh
out=""; target=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -target) target="$2"; shift ;;
  esac
  shift
done
echo "binary built for $target" > "$out"
`);
  fs.chmodSync(script, 0o755);
  return [script];
}

// A helpers folder built from `python`'s sources, as the build makes it.
function builtHelpers(python = fakeEngine()) {
  const dir = path.join(temp(), 'helpers');
  const manifest = helperDirs.fillHelpers(python, dir, '14.0', { swiftc: fakeSwiftc() });
  return { python, dir, manifest };
}

// Each way of spoiling a built folder, with the helpers prebuilt() then refuses.
const SPOILED = {
  'nothing wrong': { refused: [] },
  'a program missing': { refused: ['jarvis-ocr'], spoil: (dir) => fs.rmSync(path.join(dir, 'jarvis-ocr')) },
  'a folder where the program goes': { refused: ['jarvis-ocr'], spoil: (dir) => { fs.rmSync(path.join(dir, 'jarvis-ocr')); fs.mkdirSync(path.join(dir, 'jarvis-ocr')); } },
  'a program that may not run': { refused: ['jarvis-player'], spoil: (dir) => fs.chmodSync(path.join(dir, 'jarvis-player'), 0o644) },
  'built from another source': { refused: ['jarvis-duplex'], spoil: (dir) => fs.writeFileSync(path.join(dir, 'jarvis-duplex.sha256'), `${sha256('older source')}\n`) },
  'no hash beside it': { refused: ['jarvis-ocr'], spoil: (dir) => fs.rmSync(path.join(dir, 'jarvis-ocr.sha256')) },
  'an empty hash file': { refused: ['jarvis-player'], spoil: (dir) => fs.writeFileSync(path.join(dir, 'jarvis-player.sha256'), '') },
  'a hash file that is not ASCII': { refused: ['jarvis-ocr'], spoil: (dir) => fs.writeFileSync(path.join(dir, 'jarvis-ocr.sha256'), `é ${fs.readFileSync(path.join(dir, 'jarvis-ocr.sha256'), 'ascii')}`) },
  'the hash, then more words': { refused: [], spoil: (dir) => fs.appendFileSync(path.join(dir, 'jarvis-ocr.sha256'), '  jarvis-ocr.swift\n') },
  'a link to the program': { refused: [], spoil: (dir) => { const real = path.join(temp(), 'jarvis-ocr'); fs.renameSync(path.join(dir, 'jarvis-ocr'), real); fs.symlinkSync(real, path.join(dir, 'jarvis-ocr')); } },
};
const refusedBy = (problems) => [...new Set(problems.filter((p) => p.startsWith('jarvis-')).map((p) => p.split(':')[0]))].sort();

test('the helpers folder built and checked is the one the launcher points the backend at (JARVIS_HELPERS_DIR)', () => {
  const resources = '/Applications/Ask Eden.app/Contents/Resources';
  assert.equal(helperDirs.helpersDirIn(resources), launcherHelpersDir(resources));
  assert.equal(helperDirs.helpersDirIn(resources), `${resources}/helpers`);
});

test("built from the sources the engine carries: each program beside its source's hash, helpers.json, nothing missing", () => {
  const { python, dir, manifest } = builtHelpers();
  assert.deepEqual(Object.keys(manifest.helpers).sort(), ['jarvis-duplex', 'jarvis-ocr', 'jarvis-player']);
  for (const [rel, text] of Object.entries(ENGINE_SOURCES)) {
    const name = path.basename(rel, '.swift');
    assert.equal(fs.readFileSync(path.join(dir, `${name}.sha256`), 'utf8'), `${sha256(text)}\n`, name);
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), 'binary built for arm64-apple-macos14.0\n', name);
    assert.ok(fs.statSync(path.join(dir, name)).mode & 0o111, `${name} may run`);
    // Named where prebuilt() finds it in the app, not by a path of the Mac it was built on.
    assert.equal(manifest.helpers[name].source, `jarvis/${rel}`);
  }
  assert.equal(manifest.helpers['jarvis-duplex'].entitlements, 'microphone'); // talk-over opens the microphone
  assert.equal(manifest.helpers['jarvis-ocr'].entitlements, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'helpers.json'), 'utf8')), manifest);
  assert.deepEqual(helperDirs.helperProblems(dir, python), []);
  assert.doesNotThrow(() => helperDirs.checkHelpers(dir, python, 'Ask Eden.app'));
});

test('an app without them, as Ask Eden 0.1.0 shipped, stops the build and names each', () => {
  const python = fakeEngine();
  const dir = path.join(temp(), 'helpers'); // never made
  assert.deepEqual(helperDirs.helperProblems(dir, python), [
    `jarvis-duplex: missing (${path.join(dir, 'jarvis-duplex')})`,
    `jarvis-ocr: missing (${path.join(dir, 'jarvis-ocr')})`,
    `jarvis-player: missing (${path.join(dir, 'jarvis-player')})`,
    'helpers.json: missing (the doctor then says the built-in helpers are missing)',
  ]);
  assert.throws(() => helperDirs.checkHelpers(dir, python, 'Ask Eden.app'), (err) => {
    assert.ok(err instanceof BuildError);
    assert.match(err.message, /^Ask Eden\.app lacks Swift helpers its backend takes from JARVIS_HELPERS_DIR \(.+\); it would compile them with swiftc/);
    assert.match(err.message, /jarvis-ocr: missing/);
    return true;
  });
});

test('a helper prebuilt() would refuse stops the build, each way named', () => {
  for (const [what, { refused, spoil }] of Object.entries(SPOILED)) {
    const { python, dir } = builtHelpers();
    if (spoil) spoil(dir);
    const problems = helperDirs.helperProblems(dir, python);
    assert.deepEqual(refusedBy(problems), refused, what);
    assert.equal(problems.length, refused.length, `${what}: ${problems.join(' / ')}`);
  }
  const { python, dir } = builtHelpers();
  fs.writeFileSync(path.join(dir, 'jarvis-duplex.sha256'), `${sha256('older source')}\n`);
  fs.chmodSync(path.join(dir, 'jarvis-player'), 0o644);
  fs.rmSync(path.join(dir, 'helpers.json'));
  assert.deepEqual(helperDirs.helperProblems(dir, python), [
    `jarvis-duplex: built from another source (jarvis-duplex.sha256 says ${sha256('older source')}; the backend's jarvis/audio/jarvis-duplex.swift is ${sha256(ENGINE_SOURCES['audio/jarvis-duplex.swift'])})`,
    'jarvis-player: not executable',
    'helpers.json: missing (the doctor then says the built-in helpers are missing)',
  ]);
});

test('they follow the engine: one built from another source (the repo, newer) is refused; one it has no source for is not asked for', () => {
  const python = fakeEngine();
  const { dir } = builtHelpers(fakeEngine({ ...ENGINE_SOURCES, 'native/jarvis-ocr.swift': 'import Vision // newer, in the repo' }));
  assert.deepEqual(refusedBy(helperDirs.helperProblems(dir, python)), ['jarvis-ocr']);
  const ocrOnly = fakeEngine({ 'native/jarvis-ocr.swift': ENGINE_SOURCES['native/jarvis-ocr.swift'] });
  const few = builtHelpers(ocrOnly).dir;
  assert.deepEqual(helperDirs.helperProblems(few, ocrOnly), []);
  assert.deepEqual(refusedBy(helperDirs.helperProblems(few, python)), ['jarvis-duplex', 'jarvis-player']);
});

test('an engine without the jarvis package or its helper sources is refused, never passed as having none to ship', () => {
  const empty = path.join(temp(), 'python');
  fs.mkdirSync(path.join(empty, 'lib', 'python3.12', 'site-packages'), { recursive: true });
  const dir = path.join(temp(), 'helpers');
  assert.deepEqual(helperDirs.helperProblems(dir, empty), [`the backend (${empty}) carries no jarvis-*.swift helper sources`]);
  assert.throws(() => helperDirs.fillHelpers(empty, dir, '14.0', { swiftc: fakeSwiftc() }), /carries no jarvis-\*\.swift helper sources/);
  assert.equal(fs.existsSync(dir), false);
});

test("the check refuses exactly the helpers swift_helper.prebuilt() refuses", { skip: !fs.existsSync(VENV_PYTHON) && 'no .venv (uv sync)' }, () => {
  const code = [
    'import json, sys',
    'from pathlib import Path',
    'sys.path.insert(0, sys.argv[1])',
    'from jarvis.swift_helper import prebuilt',
    'print(json.dumps(sorted(Path(s).stem for s in sys.argv[2:] if prebuilt(Path(s).stem, Path(s)) is None)))',
  ].join('\n');
  for (const [what, { refused, spoil }] of Object.entries(SPOILED)) {
    const { python, dir } = builtHelpers();
    if (spoil) spoil(dir);
    const sources = Object.keys(ENGINE_SOURCES).map((rel) => sourceOf(python, rel));
    const done = spawnSync(VENV_PYTHON, ['-I', '-c', code, path.join(REPO, 'src'), ...sources], {
      env: { PATH: '/usr/bin:/bin', HOME: temp(), JARVIS_HELPERS_DIR: dir }, encoding: 'utf8',
    });
    assert.equal(done.status, 0, done.stderr);
    assert.deepEqual(JSON.parse(done.stdout), refused, `prebuilt(), ${what}`);
    assert.deepEqual(refusedBy(helperDirs.helperProblems(dir, python)), refused, `the check, ${what}`);
  }
});

// A file the signing walk takes for a program (a 64-bit Mach-O header).
const machO = (file) => touch(file, Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.alloc(28)]));

test('each helper is signed with its own entitlements (the microphone for talk-over, nothing for the rest), never the app\'s', { skip: INSTALLED }, () => {
  const build = require('../../app/eden/build.js');
  const sign = require('../../app/scripts/release/sign.js');
  const app = path.join(temp(), 'Ask Eden.app');
  const res = path.join(app, 'Contents', 'Resources');
  machO(path.join(app, 'Contents', 'MacOS', 'Ask Eden'));
  machO(path.join(app, 'Contents', 'Frameworks', 'Ask Eden Helper.app', 'Contents', 'MacOS', 'Ask Eden Helper'));
  machO(path.join(res, 'backend', 'python', 'bin', 'python3.12'));
  machO(path.join(res, 'backend', 'python', 'lib', 'libpython3.12.dylib'));
  for (const name of ['jarvis-duplex', 'jarvis-ocr', 'jarvis-new']) machO(path.join(res, 'helpers', name));
  touch(path.join(res, 'helpers', 'helpers.json'), JSON.stringify({ minimum: '14.0', helpers: { 'jarvis-duplex': { entitlements: 'microphone' }, 'jarvis-ocr': { entitlements: null } } }));
  const APP_ENTITLEMENTS = path.join(APP, 'eden', 'build', 'entitlements.plist');
  const planned = Object.fromEntries(build.signPlan(app).map(([target, ents]) => [path.relative(app, target) || '(the app)', ents]));
  assert.deepEqual(planned, {
    'Contents/MacOS/Ask Eden': APP_ENTITLEMENTS,
    'Contents/Frameworks/Ask Eden Helper.app/Contents/MacOS/Ask Eden Helper': APP_ENTITLEMENTS,
    'Contents/Resources/backend/python/bin/python3.12': APP_ENTITLEMENTS,
    'Contents/Resources/backend/python/lib/libpython3.12.dylib': null,
    'Contents/Resources/helpers/jarvis-duplex': path.join(APP, 'build', 'entitlements', 'microphone.plist'),
    'Contents/Resources/helpers/jarvis-ocr': null,
    'Contents/Resources/helpers/jarvis-new': null, // not in helpers.json: asks for nothing
    'Contents/Frameworks/Ask Eden Helper.app': APP_ENTITLEMENTS,
    '(the app)': APP_ENTITLEMENTS,
  });
  assert.deepEqual(sign.plistKeys(path.join(APP, 'build', 'entitlements', 'microphone.plist')), ['com.apple.security.device.audio-input']);
  const order = build.signPlan(app).map(([target]) => path.relative(app, target));
  assert.equal(order.at(-1), '', 'the app last');
  assert.ok(order.indexOf('Contents/Frameworks/Ask Eden Helper.app') > order.indexOf('Contents/Resources/helpers/jarvis-duplex'), 'bundles after the files');
});

test('signed, a helper with the wrong entitlements or not by the team is named', { skip: process.platform !== 'darwin' && 'macOS only (codesign)' }, () => {
  const dir = path.join(temp(), 'helpers');
  fs.mkdirSync(dir);
  const mic = path.join(APP, 'build', 'entitlements', 'microphone.plist');
  const signed = (name, entitlements) => {
    fs.copyFileSync('/usr/bin/true', path.join(dir, name));
    const done = spawnSync('/usr/bin/codesign', ['--force', '--options', 'runtime', '--sign', '-', ...(entitlements ? ['--entitlements', entitlements] : []), path.join(dir, name)], { encoding: 'utf8' });
    assert.equal(done.status, 0, done.stderr);
  };
  signed('jarvis-duplex', mic);
  signed('jarvis-ocr', mic); // asks for nothing, given the microphone
  touch(path.join(dir, 'helpers.json'), JSON.stringify({ helpers: { 'jarvis-duplex': { entitlements: 'microphone' }, 'jarvis-ocr': { entitlements: null } } }));
  assert.deepEqual(helperDirs.signatureProblems(dir, '8CV4X23Y2T'), [
    'jarvis-duplex: not signed by team 8CV4X23Y2T (no team)', // ad hoc here; the build signs with the team's certificate
    'jarvis-ocr: not signed by team 8CV4X23Y2T (no team)',
    'jarvis-ocr: entitlements ["com.apple.security.device.audio-input"], expected []',
  ]);
});

// Info.plist with LSMinimumSystemVersion `declared` (none: left out).
function plistWith(app, declared) {
  const entry = declared ? `<key>LSMinimumSystemVersion</key><string>${declared}</string>` : '';
  touch(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleName</key><string>Ask Eden</string>${entry}</dict></plist>\n`);
}
const declaredIn = (app) => spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :LSMinimumSystemVersion', path.join(app, 'Contents', 'Info.plist')], { encoding: 'utf8' }).stdout.trim();

test("Ask Eden's build puts them where its launcher points the engine, for the app's minimum macOS; a finished app without them stops it", { skip: (INSTALLED || (process.platform !== 'darwin' && 'macOS only')) }, () => {
  const build = require('../../app/eden/build.js');
  const app = path.join(temp(), 'Ask Eden.app');
  const resources = path.join(app, 'Contents', 'Resources');
  fs.cpSync(fakeEngine(), path.join(resources, 'backend', 'python'), { recursive: true });
  plistWith(app, '14.0');
  assert.throws(() => build.checkHelpersIn(app), /Ask Eden\.app lacks Swift helpers [\s\S]*jarvis-ocr: missing/);
  const manifest = build.addHelpers(app, { swiftc: fakeSwiftc() });
  assert.equal(manifest.minimum, '14.0');
  assert.doesNotThrow(() => build.checkHelpersIn(app));
  const dir = launcherHelpersDir(resources);
  assert.equal(fs.readFileSync(path.join(dir, 'jarvis-ocr'), 'utf8'), 'binary built for arm64-apple-macos14.0\n');
  assert.equal(declaredIn(app), '14.0', 'left as declared');
});

test("the helpers' macOS is the app's minimum: what Electron and the engine need, never below what Info.plist declares", { skip: (INSTALLED || (process.platform !== 'darwin' && 'macOS only')) }, () => {
  const build = require('../../app/eden/build.js');
  const { minimumFor } = require('../../app/scripts/release/dist.js');
  const electron = minimumFor({ minos: null }); // a made-up engine has no Mach-O files
  const app = path.join(temp(), 'Ask Eden.app');
  fs.mkdirSync(path.join(app, 'Contents', 'Resources', 'backend', 'python'), { recursive: true });
  plistWith(app, '99.0');
  assert.equal(build.minimumMacos(app), '99.0');
  assert.equal(declaredIn(app), '99.0', 'never lowered');
  plistWith(app, '10.15');
  assert.equal(build.minimumMacos(app), electron);
  assert.equal(declaredIn(app), electron, 'raised to what its code needs');
  plistWith(app, null);
  assert.equal(build.minimumMacos(app), electron);
  assert.equal(declaredIn(app), electron, 'added');
});
