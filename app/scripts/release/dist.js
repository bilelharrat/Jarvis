// npm run dist: the J.A.R.V.I.S. people download.
//   1. package the app with @electron/packager (the flags `npm run package` uses, but no
//      repo path baked in: no jarvis-home.json);
//   2. add the bundled backend (backend.js) and the prebuilt Swift helpers (helpers.js);
//   3. sign it inside-out (sign.js) with the Developer ID named in JARVIS_SIGN_IDENTITY;
//   4. verify it (verify.js);
//   5. zip it, have Apple notarize it (JARVIS_NOTARY_PROFILE) and staple the ticket to it;
//   6. build the disk image with an Applications link (dmg.js);
//   7. sign, notarize and staple the disk image;
//   8. write their SHA-256s (SHA256SUMS.txt), and check both with Gatekeeper (spctl).
// `npm run dist -- --adhoc` does 1-4 and 6 (and the checksum) signed ad hoc, with no
// credentials: for checking the build on this Mac, never for giving to anyone; its disk image
// says so in its name. Logs go to app/dist/logs, everything else to app/dist/release.
'use strict';

const fs = require('fs');
const path = require('path');
const { BuildError, run, say, setLog, sizeOf, megabytes } = require('./util');
const macho = require('./macho');
const { buildBackend } = require('./backend');
const { buildHelpers } = require('./helpers');
const { signApp } = require('./sign');
const { verifyApp, buildMacStrings } = require('./verify');
const { notarize, staple, zipApp } = require('./notarize');
const { makeDmg, signDmg, writeChecksums } = require('./dmg');

const APP_DIR = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(APP_DIR, '..');
const DIST = path.join(APP_DIR, 'dist');
const OUT = path.join(DIST, 'release');
const STAGE = path.join(DIST, 'stage');
const PKG = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
const NAME = 'J.A.R.V.I.S';
const DISPLAY = 'J.A.R.V.I.S.';
const BUNDLE_ID = 'com.bshventures.jarvis';

function parseArgs(argv) {
  const args = { adhoc: false };
  for (const a of argv) {
    if (a === '--adhoc') args.adhoc = true;
    else throw new BuildError(`unknown option ${a} (only --adhoc)`);
  }
  return args;
}

// What signing needs, from the environment; fails before any work when it's missing.
function credentials(env, { adhoc }) {
  if (adhoc) return { identity: '-', profile: '' };
  const identity = (env.JARVIS_SIGN_IDENTITY || '').trim();
  const profile = (env.JARVIS_NOTARY_PROFILE || '').trim();
  const missing = [];
  if (!identity) missing.push('JARVIS_SIGN_IDENTITY: your "Developer ID Application: … (9ZSY5R8A5C)" certificate, by name or SHA-1 hash (security find-identity -v -p codesigning lists them)');
  if (!profile) missing.push('JARVIS_NOTARY_PROFILE: the name you gave `xcrun notarytool store-credentials`');
  if (missing.length) throw new BuildError(`Can't sign for other Macs without:\n  ${missing.join('\n  ')}\nOr run npm run dist -- --adhoc to check the build on this Mac only.`);
  return { identity, profile };
}

// The identity must be a Developer ID Application certificate in this Mac's keychain (an
// Apple Development one can't be notarized).
function checkIdentity(identity) {
  const listed = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { quiet: true }).stdout;
  const line = listed.split('\n').find((l) => l.includes(`"${identity}"`) || l.includes(` ${identity.toUpperCase()} `));
  if (!line) throw new BuildError(`No signing identity "${identity}" in the keychain (security find-identity -v -p codesigning)`);
  if (!/"Developer ID Application: /.test(line)) throw new BuildError(`"${identity}" isn't a Developer ID Application certificate: ${line.trim()}`);
}

// What the build writes, by name (the ad hoc one can't be mistaken for a release).
function dmgName(version, adhoc) {
  return `${DISPLAY}-${version}${adhoc ? '-adhoc' : ''}.dmg`;
}

// Gatekeeper's verdict on the notarized app and disk image, as a Mac that downloads them sees it.
function gatekeeper(app, dmg) {
  const problems = [];
  const onApp = run('/usr/sbin/spctl', ['-a', '-vvv', '-t', 'install', app], { allowFail: true });
  const saidApp = `${onApp.stderr}${onApp.stdout}`.trim();
  if (onApp.status !== 0 || !/Notarized Developer ID/.test(saidApp)) problems.push(`the app: ${saidApp}`);
  const onDmg = run('/usr/sbin/spctl', ['-a', '-vvv', '-t', 'open', '--context', 'context:primary-signature', dmg], { allowFail: true });
  const saidDmg = `${onDmg.stderr}${onDmg.stdout}`.trim();
  if (onDmg.status !== 0 || !/Notarized Developer ID/.test(saidDmg)) problems.push(`the disk image: ${saidDmg}`);
  if (problems.length) throw new BuildError(`Gatekeeper doesn't accept:\n  ${problems.join('\n  ')}`);
  say(`  Gatekeeper: ${saidApp.split('\n').find((l) => /source=/.test(l)) || 'accepted'}`);
}

// The Electron release zip packager unpacks: the one @electron/get cached when npm installed
// Electron, else one made from node_modules/electron/dist. Never downloaded.
function electronZipDir(version) {
  const zipName = `electron-v${version}-darwin-arm64.zip`;
  const cache = path.join(require('os').homedir(), 'Library', 'Caches', 'electron');
  if (fs.existsSync(cache)) {
    for (const dir of fs.readdirSync(cache)) {
      if (fs.existsSync(path.join(cache, dir, zipName))) return path.join(cache, dir);
    }
  }
  const dist = path.join(APP_DIR, 'node_modules', 'electron', 'dist');
  const made = path.join(STAGE, 'electron-zip');
  fs.rmSync(made, { recursive: true, force: true });
  fs.mkdirSync(made, { recursive: true });
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', dist, path.join(made, zipName)]);
  return made;
}

async function packageApp() {
  const electron = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  const { packager } = await import('@electron/packager');
  const [folder] = await packager({
    dir: APP_DIR,
    name: NAME,
    platform: 'darwin',
    arch: 'arm64',
    out: OUT,
    overwrite: true,
    icon: path.join(APP_DIR, 'build', 'icon.icns'),
    extendInfo: path.join(APP_DIR, 'build', 'extend-info.plist'),
    appBundleId: BUNDLE_ID,
    appVersion: PKG.version,
    buildVersion: PKG.version,
    electronVersion: electron,
    electronZipDir: electronZipDir(electron),
    // As npm run package: the build's own folders stay out, and so does the repo path
    // bake-home.js writes for the owner's own build.
    ignore: [/^\/dist(\/|$)/, /^\/scripts(\/|$)/, /^\/build(\/|$)/, /^\/jarvis-home\.json$/],
    // The app is one app.asar, as npm run package makes it, but the backend serves the
    // terminal's and hand tracking's scripts to the window and can't read inside an asar:
    // those two stay real files (app.asar.unpacked), where JARVIS_APP_DIR points.
    asar: { unpack: '**/node_modules/{@xterm,@mediapipe}/**' },
    quiet: true,
  });
  return path.join(folder, `${NAME}.app`);
}

function plist(app, command) {
  run('/usr/libexec/PlistBuddy', ['-c', command, path.join(app, 'Contents', 'Info.plist')]);
}

// The app's minimum macOS: what its Electron and its backend need, whichever is higher.
function minimumFor(backendReport) {
  const electron = macho.scan(path.join(APP_DIR, 'node_modules', 'electron', 'dist', 'Electron.app'));
  return macho.maxVersion([backendReport.minos, ...electron.map((m) => m.minos)]);
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  setLog(path.join(DIST, 'logs', `dist-${stamp}.log`));
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new BuildError('The app is built on an Apple-silicon Mac');
  const { identity, profile } = credentials(env, args);
  if (!args.adhoc) checkIdentity(identity);
  say(`J.A.R.V.I.S. ${PKG.version}${args.adhoc ? ' (ad hoc: this Mac only)' : ''}`);

  say('1. packaging the app');
  const app = await packageApp();
  plist(app, `Set :CFBundleDisplayName ${DISPLAY}`); // CFBundleName stays: Electron finds its helpers by it

  say('2. the backend and the Swift helpers');
  const backend = buildBackend({ out: path.join(STAGE, 'backend') });
  const minimum = minimumFor(backend);
  const helpers = buildHelpers({ out: path.join(STAGE, 'helpers'), minimum });
  const resources = path.join(app, 'Contents', 'Resources');
  run('/usr/bin/ditto', [path.join(STAGE, 'backend', 'python'), path.join(resources, 'backend', 'python')]);
  fs.copyFileSync(path.join(STAGE, 'backend', 'build.json'), path.join(resources, 'backend', 'build.json'));
  run('/usr/bin/ditto', [path.join(STAGE, 'helpers'), path.join(resources, 'helpers')]);
  const unpacked = path.join(resources, 'app.asar.unpacked'); // JARVIS_APP_DIR: laid out like app/
  if (!fs.existsSync(path.join(unpacked, 'node_modules', '@xterm'))) throw new BuildError('the terminal\'s scripts (@xterm) aren\'t outside app.asar');
  fs.mkdirSync(path.join(unpacked, 'build'), { recursive: true });
  fs.copyFileSync(path.join(APP_DIR, 'build', 'icon-1024.png'), path.join(unpacked, 'build', 'icon-1024.png')); // the companion's icon
  plist(app, `Set :LSMinimumSystemVersion ${minimum}`);
  say(`  minimum macOS ${minimum}; the app is ${megabytes(sizeOf(app))}`);

  say(`3. signing ${args.adhoc ? 'ad hoc' : `as ${identity}`}`);
  const helperEntitlements = Object.fromEntries(Object.entries(helpers.helpers).map(([n, h]) => [n, h.entitlements]));
  signApp(app, { identity, helperEntitlements });

  say('4. verifying');
  const checked = verifyApp(app, { adhoc: args.adhoc, helpers: helpers.helpers, forbidden: buildMacStrings(REPO) });
  if (checked.problems.length) throw new BuildError(`The signed app didn't verify:\n  ${checked.problems.join('\n  ')}`);
  say(`  ${checked.machos} Mach-O files signed and verified; needs macOS ${checked.needed}, declares ${checked.declared}`);

  if (!args.adhoc) {
    say('5. notarizing the app');
    const zip = zipApp(app, path.join(STAGE, `${NAME}.zip`));
    notarize(zip, profile);
    fs.rmSync(zip, { force: true });
    staple(app);
  }

  say('6. the disk image');
  const dmg = makeDmg(app, path.join(OUT, dmgName(PKG.version, args.adhoc)), DISPLAY);

  if (!args.adhoc) {
    say('7. signing and notarizing the disk image');
    signDmg(dmg, identity);
    notarize(dmg, profile);
    staple(dmg);
  }

  say('8. checksums');
  const sums = writeChecksums([dmg], path.join(OUT, 'SHA256SUMS.txt'));
  for (const line of sums) say(`  ${line}`);
  if (!args.adhoc) gatekeeper(app, dmg);
  return { app, dmg, minimum, helpers, backend };
}

module.exports = { main, credentials, parseArgs, electronZipDir, minimumFor, dmgName };

if (require.main === module) {
  main().then(({ app, dmg }) => {
    say(`Done: ${dmg}\n      ${app}`);
  }).catch((err) => {
    console.error(`\n${err instanceof BuildError ? err.message : err.stack}`);
    process.exit(1);
  });
}
