// What the bundled backend reads from JARVIS_APP_DIR (src/jarvis/packaged.py app_dir), which
// the launcher points at the app's Resources/app.asar.unpacked (backend-launch.js bundledEnv):
// real files laid out like the repo's app/, since Python can't read inside app.asar.
// - node_modules/@mediapipe/tasks-vision: hand tracking. server.py serves it at /vision;
//   web/hands.js imports /vision/vision_bundle.mjs and loads its wasm from /vision/wasm.
// - node_modules/@xterm (xterm, addon-fit): the terminal, served at /xterm (web/app.js).
// - build/icon-1024.png: the phone companion's icon (remote.py).
// J.A.R.V.I.S.'s release unpacks them from its app.asar (dist.js). Ask Eden's build packs only
// its own few files, so it copies them in (eden/build.js) and stops if any is missing: without
// them hand control can't start, in Ask Eden or in any Eden app sharing the backend it started.
// Both read app/node_modules, so the versions are the ones package-lock.json pins.
'use strict';

const fs = require('fs');
const path = require('path');
const { bundledEnv } = require('../../backend-launch');
const { BuildError } = require('./util');

// The packages, each with the files the window loads from it.
const PACKAGES = [
  {
    name: '@mediapipe/tasks-vision',
    files: [
      'vision_bundle.mjs',
      'wasm/vision_wasm_internal.js', 'wasm/vision_wasm_internal.wasm',
      'wasm/vision_wasm_nosimd_internal.js', 'wasm/vision_wasm_nosimd_internal.wasm',
    ],
  },
  { name: '@xterm/xterm', files: ['lib/xterm.js', 'css/xterm.css'] },
  { name: '@xterm/addon-fit', files: ['lib/addon-fit.js'] },
];
const ICON = 'build/icon-1024.png';

const under = (dir, rel) => path.join(dir, ...rel.split('/'));
const packageDir = (dir, name) => under(dir, `node_modules/${name}`);
const isFile = (file) => { try { const s = fs.statSync(file); return s.isFile() && s.size > 0; } catch { return false; } };

// JARVIS_APP_DIR for an app whose Resources folder is `resources`, as the launcher sets it.
function appDirIn(resources) {
  return bundledEnv({}, { resourcesPath: resources, token: '', extraPath: [] }).JARVIS_APP_DIR;
}

// Each package's version in `appDir`/package-lock.json (undefined: not in it).
function lockedVersions(appDir) {
  const lock = JSON.parse(fs.readFileSync(path.join(appDir, 'package-lock.json'), 'utf8'));
  return Object.fromEntries(PACKAGES.map(({ name }) => [name, lock.packages?.[`node_modules/${name}`]?.version]));
}

// What `dir` lacks as JARVIS_APP_DIR, one line each ([] when nothing): a package missing, not the
// version package-lock.json pins, or without a file the window loads; the icon.
function appDirProblems(dir, versions) {
  const problems = [];
  for (const { name, files } of PACKAGES) {
    const root = packageDir(dir, name);
    let version;
    try {
      ({ version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')));
    } catch {
      problems.push(`${name}: missing (${root})`);
      continue;
    }
    if (!versions[name]) problems.push(`${name}: not in package-lock.json`);
    else if (version !== versions[name]) problems.push(`${name}: ${version}, but package-lock.json pins ${versions[name]}`);
    for (const file of files) if (!isFile(under(root, file))) problems.push(`${name}: no ${file}`);
  }
  if (!isFile(under(dir, ICON))) problems.push(`${ICON}: missing`);
  return problems;
}

// Stops the build unless `dir` has all of it, at the versions `appDir`'s package-lock.json pins.
function checkAppDir(dir, appDir, what) {
  const problems = appDirProblems(dir, lockedVersions(appDir));
  if (problems.length) {
    throw new BuildError(`${what} lacks what the backend serves the window from JARVIS_APP_DIR (${dir}):\n  ${problems.join('\n  ')}`);
  }
}

// Copies them from the repo's app/ (`appDir`) into `dir`: real files, no links.
function fillAppDir(appDir, dir) {
  for (const { name } of PACKAGES) {
    const to = packageDir(dir, name);
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(packageDir(appDir, name), to, { recursive: true, dereference: true });
  }
  fs.mkdirSync(path.dirname(under(dir, ICON)), { recursive: true });
  fs.copyFileSync(under(appDir, ICON), under(dir, ICON));
}

module.exports = { PACKAGES, ICON, appDirIn, lockedVersions, appDirProblems, checkAppDir, fillAppDir };
