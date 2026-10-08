// npm-free build of Ask Eden for Mac (dist/Ask Eden-darwin-arm64/Ask Eden.app):
//   node eden/build.js            unsigned local build (ad hoc, or signed when a team 8CV4X23Y2T
//                                 Developer ID Application certificate is in the keychain)
// Signing: ONLY team 8CV4X23Y2T (Bilel Harrat, bilel.harrat@icloud.com). Never Robert Parker's
// team (9ZSY5R8A5C) or the jarvis-notary profile. Without that team's certificate the app is
// ad hoc signed, which is for local testing only: a release needs the certificate (Xcode >
// Settings > Accounts > Manage Certificates > Developer ID Application) and notarization with a
// notary profile of that team.
// The update feed (Squirrel.Mac JSON, update-feed.js) is baked into Resources/update.json:
// ASK_EDEN_UPDATE_URL, else the default below. Its own name, so J.A.R.V.I.S.'s feed is untouched.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const APP_DIR = path.resolve(__dirname, '..');
const NAME = 'Ask Eden';
const BUNDLE_ID = 'com.askeden.eden.mac';
const TEAM = '8CV4X23Y2T';
const { buildBackend } = require('../scripts/release/backend');
const EDEN_SRC = process.env.ASKEDEN_HOME || path.join(os.homedir(), 'askeden');
const ENGINE_CACHE = process.env.ASK_EDEN_BACKEND || path.join(APP_DIR, 'dist', '.engine-cache');
const DEFAULT_FEED = 'https://askeden.com/downloads/ask-eden/release.json';

function teamIdentity() {
  if (process.env.ASK_EDEN_SIGN_IDENTITY) return process.env.ASK_EDEN_SIGN_IDENTITY;
  const out = execSync('security find-identity -v -p codesigning', { encoding: 'utf8' });
  for (const m of out.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"/gm)) {
    if (m[2].startsWith('Developer ID Application') && m[2].includes(`(${TEAM})`)) return m[1];
  }
  return '';
}

// The engine inside the app, the way J.A.R.V.I.S.'s release carries its backend: uv's CPython,
// the locked dependencies and the jarvis package (scripts/release/backend.js), built once and
// cached (ASK_EDEN_REBUILD_ENGINE=1 builds it afresh), plus Eden's own server (no dependencies).
function addEngine(resources) {
  if (process.env.ASK_EDEN_REBUILD_ENGINE === '1' || !fs.existsSync(path.join(ENGINE_CACHE, 'python', 'bin', 'python3'))) {
    buildBackend({ out: ENGINE_CACHE });
  }
  const backend = path.join(resources, 'backend');
  fs.mkdirSync(backend, { recursive: true });
  execFileSync('/usr/bin/ditto', [path.join(ENGINE_CACHE, 'python'), path.join(backend, 'python')]);
  const server = path.join(resources, 'eden-server');
  fs.mkdirSync(server, { recursive: true });
  for (const f of ['dist', 'web', 'package.json', 'model-router.config.json']) {
    if (fs.existsSync(path.join(EDEN_SRC, f))) fs.cpSync(path.join(EDEN_SRC, f), path.join(server, f), { recursive: true });
  }
  fs.rmSync(path.join(server, 'dist', '__tests__'), { recursive: true, force: true });
}

// Developer ID signing for notarization: hardened runtime + secure timestamp on every Mach-O,
// signed inside-out (no --deep): loose binaries/libraries first, then nested bundles deepest
// first (frameworks, helper apps), then the app itself.
const ENTITLEMENTS = path.join(__dirname, 'build', 'entitlements.plist');
function isMachO(file) {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(4);
  const n = fs.readSync(fd, b, 0, 4, 0);
  fs.closeSync(fd);
  if (n < 4) return false;
  const m = b.readUInt32BE(0);
  if (m === 0xcafebabe) return /Mach-O/.test(execFileSync('/usr/bin/file', ['-b', file], { encoding: 'utf8' }));
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabf].includes(m);
}
function walk(dir, files, bundles) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (/\.(app|framework|xpc)$/.test(e.name)) bundles.push(p);
      walk(p, files, bundles);
    } else if (e.isFile() && isMachO(p)) files.push(p);
  }
}
function signApp(app, identity) {
  const sign = (target, ents) => execFileSync('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity,
    ...(ents ? ['--entitlements', ENTITLEMENTS] : []), target], { stdio: 'inherit' });
  const files = []; const bundles = [];
  walk(path.join(app, 'Contents'), files, bundles);
  for (const f of files) sign(f, !/\.(dylib|so)$/.test(f));
  bundles.sort((a, b) => b.split('/').length - a.split('/').length);
  for (const b of bundles) sign(b, true);
  sign(app, true);
}

async function main() {
  const { packager } = await import('@electron/packager');
  const electron = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-eden-'));
  const put = (from, to = from) => { fs.mkdirSync(path.dirname(path.join(stage, to)), { recursive: true }); fs.cpSync(path.join(APP_DIR, from), path.join(stage, to), { recursive: true }); };
  for (const f of ['backend-launch.js', 'backend-share.js', 'update-feed.js', 'features/updates.js']) put(f);
  for (const f of ['main.js', 'preload.js', 'quick.html', 'quick-preload.js']) put(`eden/${f}`);
  put('eden/build/icon-1024.png');
  for (const f of fs.readdirSync(path.join(APP_DIR, 'eden', 'build')).filter((n) => /Template(@2x)?\.png$/.test(n))) put(`eden/build/${f}`);
  fs.copyFileSync(path.join(APP_DIR, 'eden', 'package.json'), path.join(stage, 'package.json'));
  try { put('jarvis-home.json', 'eden/jarvis-home.json'); } catch { /* JARVIS_HOME or ~/JARVIS V1 */ }
  const [folder] = await packager({
    dir: stage, name: NAME, platform: 'darwin', arch: 'arm64', out: path.join(APP_DIR, 'dist'), overwrite: true,
    icon: path.join(APP_DIR, 'eden', 'build', 'icon.icns'), extendInfo: path.join(APP_DIR, 'eden', 'extend-info.plist'),
    appBundleId: BUNDLE_ID, electronVersion: electron, quiet: true,
  });
  fs.rmSync(stage, { recursive: true, force: true });
  const app = path.join(folder, `${NAME}.app`);
  if (process.env.ASK_EDEN_NO_ENGINE_BUNDLE !== '1') addEngine(path.join(app, 'Contents', 'Resources'));
  fs.writeFileSync(path.join(app, 'Contents', 'Resources', 'update.json'), `${JSON.stringify({ feed: process.env.ASK_EDEN_UPDATE_URL || DEFAULT_FEED })}\n`);
  const identity = teamIdentity();
  if (identity) signApp(app, identity);
  else execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  if (identity) {
    const info = execSync(`codesign -dvv "${app}" 2>&1`, { encoding: 'utf8' });
    if (!info.includes(`TeamIdentifier=${TEAM}`)) throw new Error(`signed by a team other than ${TEAM}: refused`);
    console.log(`Signed with team ${TEAM}`);
  } else {
    console.log(`No team ${TEAM} Developer ID certificate in the keychain: signed ad hoc (local testing only; not notarized)`);
  }
  return app;
}

module.exports = { main, NAME, BUNDLE_ID, TEAM, DEFAULT_FEED };
if (require.main === module) main().then((a) => console.log(`Built ${a}`)).catch((e) => { console.error(e); process.exit(1); });
