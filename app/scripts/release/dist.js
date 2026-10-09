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
// With JARVIS_UPDATE_URL (the https address release.json will have), the app looks for
// updates there (Contents/Resources/update.json), and the build also writes the update's zip
// and release.json beside the disk image (app/update-feed.js; app/features/updates.js).
// `npm run dist -- --adhoc` does 1-4 and 6 (and the checksum) signed ad hoc, with no
// credentials: for checking the build on this Mac, never for giving to anyone; its disk image
// says so in its name. Logs go to app/dist/logs, everything else to app/dist/release.
//
// Eden Code, the coding app split out of J.A.R.V.I.S. (flavor.js), comes with it: the build
// makes Eden Code.app too (the same app folder and backend, under Eden Code's name, bundle id,
// icon and Info.plist, with flavor.json baked in) and the disk image carries both, each with
// the Applications link to drag it onto (--no-eden-code leaves it out). `npm run dist:eden-code`
// (--eden-code) builds Eden Code alone, for the people who want only it: its own disk image
// in app/dist/release-eden-code, its own update feed (EDEN_CODE_UPDATE_URL).
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
const { cleanFeedUrl, releaseFeed } = require('../../update-feed');

const APP_DIR = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(APP_DIR, '..');
const DIST = path.join(APP_DIR, 'dist');
const STAGE = path.join(DIST, 'stage');
const PKG = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
// The apps this folder builds: what each is called, its id, its look in Finder and where its
// updates come from.
const APPS = {
  jarvis: {
    flavor: 'jarvis',
    name: 'J.A.R.V.I.S',
    display: 'J.A.R.V.I.S.',
    // The Mac app's own id, from before the move to team 8CV4X23Y2T. Developer ID needs no App
    // ID for it, so it stays (renaming it would also move the wake agent's label, the Quick
    // Action's and the helpers' identifiers).
    bundleId: 'com.bshventures.jarvis',
    icon: path.join(APP_DIR, 'build', 'icon.icns'),
    extendInfo: path.join(APP_DIR, 'build', 'extend-info.plist'),
    feedEnv: 'JARVIS_UPDATE_URL',
    out: path.join(DIST, 'release'),
  },
  'eden-code': {
    flavor: 'eden-code',
    name: 'Eden Code',
    display: 'Eden Code',
    bundleId: 'com.bshventures.edencode',
    icon: path.join(APP_DIR, 'build', 'eden-code', 'icon.icns'),
    extendInfo: path.join(APP_DIR, 'build', 'eden-code', 'extend-info.plist'),
    feedEnv: 'EDEN_CODE_UPDATE_URL',
    out: path.join(DIST, 'release-eden-code'),
  },
};
const DISPLAY = APPS.jarvis.display;

function parseArgs(argv) {
  const args = { adhoc: false, edenCode: false, withEdenCode: true };
  for (const a of argv) {
    if (a === '--adhoc') args.adhoc = true;
    else if (a === '--eden-code') args.edenCode = true;
    else if (a === '--no-eden-code') args.withEdenCode = false;
    else throw new BuildError(`unknown option ${a} (only --adhoc, --eden-code, --no-eden-code)`);
  }
  return args;
}

// What signing needs, from the environment; fails before any work when it's missing.
function credentials(env, { adhoc }) {
  if (adhoc) return { identity: '-', profile: '' };
  const identity = (env.JARVIS_SIGN_IDENTITY || '').trim();
  const profile = (env.JARVIS_NOTARY_PROFILE || '').trim();
  const missing = [];
  if (!identity) missing.push('JARVIS_SIGN_IDENTITY: your "Developer ID Application: Bilel Harrat (8CV4X23Y2T)" certificate, by name or SHA-1 hash (security find-identity -v -p codesigning lists them)');
  if (!profile) missing.push('JARVIS_NOTARY_PROFILE: the name you gave `xcrun notarytool store-credentials`');
  if (missing.length) throw new BuildError(`Can't sign for other Macs without:\n  ${missing.join('\n  ')}\nOr run npm run dist -- --adhoc to check the build on this Mac only.`);
  return { identity, profile };
}

// The identity must be a Developer ID Application certificate in this Mac's keychain (an
// Apple Development one can't be notarized).
const TEAM = '8CV4X23Y2T';
function checkIdentity(identity) {
  const listed = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], { quiet: true }).stdout;
  const line = listed.split('\n').find((l) => l.includes(`"${identity}"`) || l.includes(` ${identity.toUpperCase()} `));
  if (!line) throw new BuildError(`No signing identity "${identity}" in the keychain (security find-identity -v -p codesigning)`);
  if (!/"Developer ID Application: /.test(line)) throw new BuildError(`"${identity}" isn't a Developer ID Application certificate: ${line.trim()}`);
  // Only the owner's own team signs what people download: never another team's certificate.
  if (!line.includes(`(${TEAM})"`)) throw new BuildError(`"${identity}" isn't team ${TEAM}'s certificate (${line.trim()}). Releases are signed by Bilel Harrat (${TEAM}) only.`);
}

// What the build writes, by name (the ad hoc one can't be mistaken for a release).
function dmgName(version, adhoc, display = DISPLAY) {
  return `${display}-${version}${adhoc ? '-adhoc' : ''}.dmg`;
}

function updateZipName(version, display = DISPLAY) {
  return `${display}-${version}-mac.zip`;
}

// The update feed's address from JARVIS_UPDATE_URL (or the app's own variable: Eden Code's is
// EDEN_CODE_UPDATE_URL, so it never takes J.A.R.V.I.S.'s update for its own): '' when unset
// (updates off), refused when set but not https.
function updateFeed(env, name = 'JARVIS_UPDATE_URL') {
  const given = String(env[name] || '').trim();
  if (!given) return '';
  const feed = cleanFeedUrl(given);
  if (!feed) throw new BuildError(`${name} must be an https address (the release.json the app will read), not ${given}`);
  return feed;
}

// Gatekeeper's verdict on the notarized app and disk image, as a Mac that downloads them sees it.
function gatekeeper(app, dmg) {
  const problems = [];
  if (!dmg) { // a second app in the image: the image itself was checked with the first
    const onApp = run('/usr/sbin/spctl', ['-a', '-vvv', '-t', 'install', app], { allowFail: true });
    const said = `${onApp.stderr}${onApp.stdout}`.trim();
    if (onApp.status !== 0 || !/Notarized Developer ID/.test(said)) throw new BuildError(`Gatekeeper doesn't accept ${path.basename(app)}: ${said}`);
    return;
  }
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

async function packageApp(spec = APPS.jarvis, out = spec.out) {
  const electron = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  const { packager } = await import('@electron/packager');
  // Which app it is (flavor.js), in the app folder only while it's copied.
  const flavorFile = path.join(APP_DIR, 'flavor.json');
  if (spec.flavor !== 'jarvis') fs.writeFileSync(flavorFile, `${JSON.stringify({ flavor: spec.flavor })}\n`);
  try {
    return await packageWith(packager, electron, spec, out);
  } finally {
    fs.rmSync(flavorFile, { force: true });
  }
}

async function packageWith(packager, electron, spec, out) {
  const [folder] = await packager({
    dir: APP_DIR,
    name: spec.name,
    platform: 'darwin',
    arch: 'arm64',
    out,
    overwrite: true,
    icon: spec.icon,
    extendInfo: spec.extendInfo,
    appBundleId: spec.bundleId,
    appVersion: PKG.version,
    buildVersion: PKG.version,
    electronVersion: electron,
    electronZipDir: electronZipDir(electron),
    // As npm run package: the build's own folders stay out (but Eden Code's Dock icon, which
    // J.A.R.V.I.S. shows when it runs Eden Code itself), and so does the repo path
    // bake-home.js writes for the owner's own build.
    ignore: [/^\/dist(\/|$)/, /^\/scripts(\/|$)/, /^\/build\/(?!eden-code(\/icon-1024\.png)?$)/, /^\/jarvis-home\.json$/],
    // The app is one app.asar, as npm run package makes it, but the backend serves the
    // terminal's and hand tracking's scripts to the window and can't read inside an asar:
    // those two stay real files (app.asar.unpacked), where JARVIS_APP_DIR points.
    asar: { unpack: '**/node_modules/{@xterm,@mediapipe}/**' },
    quiet: true,
  });
  return path.join(folder, `${spec.name}.app`);
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
  const primary = args.edenCode ? APPS['eden-code'] : APPS.jarvis;
  const specs = args.edenCode || !args.withEdenCode ? [primary] : [APPS.jarvis, APPS['eden-code']];
  const feeds = new Map(specs.map((spec) => [spec, updateFeed(env, spec.feedEnv)]));
  if (!args.adhoc) checkIdentity(identity);
  const OUT_DIR = primary.out;
  say(`${specs.map((spec) => spec.display).join(' + ')} ${PKG.version}${args.adhoc ? ' (ad hoc: this Mac only)' : ''}`);
  // What an earlier build left that this one might not make again (a feed without its zip).
  if (fs.existsSync(OUT_DIR)) {
    for (const name of fs.readdirSync(OUT_DIR).filter((n) => /(^|-)release\.json$/.test(n) || n === 'SHA256SUMS.txt' || n.endsWith('-mac.zip'))) {
      fs.rmSync(path.join(OUT_DIR, name), { force: true });
    }
  }

  say('the backend and the Swift helpers');
  const backend = buildBackend({ out: path.join(STAGE, 'backend') });
  const minimum = minimumFor(backend);
  const helpers = buildHelpers({ out: path.join(STAGE, 'helpers'), minimum });

  const apps = [];
  for (const spec of specs) apps.push(await buildApp(spec, { args, identity, profile, backend, minimum, helpers, feed: feeds.get(spec), out: OUT_DIR }));

  say('6. the disk image');
  const dmg = makeDmg(apps, path.join(OUT_DIR, dmgName(PKG.version, args.adhoc, primary.display)), primary.display);

  if (!args.adhoc) {
    say('7. signing and notarizing the disk image');
    signDmg(dmg, identity);
    notarize(dmg, profile);
    staple(dmg);
  }

  const published = [dmg];
  if (!args.adhoc) {
    specs.forEach((spec, i) => {
      const feed = feeds.get(spec);
      if (!feed) return;
      // The update Squirrel downloads: the notarized, stapled app, and the feed pointing at it.
      const zipName = updateZipName(PKG.version, spec.display);
      published.push(zipApp(apps[i], path.join(OUT_DIR, zipName)));
      const release = releaseFeed({ version: PKG.version, zipName, feedUrl: feed, notes: env.JARVIS_RELEASE_NOTES || '' });
      const feedFile = spec === primary ? 'release.json' : `${spec.flavor}-release.json`;
      fs.writeFileSync(path.join(OUT_DIR, feedFile), `${JSON.stringify(release, null, 2)}\n`);
      say(`  ${spec.display}'s update: ${zipName} and ${feedFile}, for ${feed}`);
    });
  }

  say('8. checksums');
  const sums = writeChecksums(published, path.join(OUT_DIR, 'SHA256SUMS.txt'));
  for (const line of sums) say(`  ${line}`);
  if (!args.adhoc) apps.forEach((app, i) => gatekeeper(app, i === 0 ? dmg : null));
  return { app: apps[0], apps, dmg, minimum, helpers, backend };
}

// Steps 1-5 for one app: package it, put the backend and the helpers in, sign, verify and
// notarize it. The backend and helpers are built once and go into each app.
async function buildApp(spec, { args, identity, profile, backend, minimum, helpers, feed, out }) {
  say(`1. packaging ${spec.display}`);
  const app = await packageApp(spec, out);
  plist(app, `Set :CFBundleDisplayName ${spec.display}`); // CFBundleName stays: Electron finds its helpers by it

  say(`2. ${spec.display}: the backend and the Swift helpers`);
  const resources = path.join(app, 'Contents', 'Resources');
  run('/usr/bin/ditto', [path.join(STAGE, 'backend', 'python'), path.join(resources, 'backend', 'python')]);
  fs.copyFileSync(path.join(STAGE, 'backend', 'build.json'), path.join(resources, 'backend', 'build.json'));
  run('/usr/bin/ditto', [path.join(STAGE, 'helpers'), path.join(resources, 'helpers')]);
  const unpacked = path.join(resources, 'app.asar.unpacked'); // JARVIS_APP_DIR: laid out like app/
  if (!fs.existsSync(path.join(unpacked, 'node_modules', '@xterm'))) throw new BuildError('the terminal\'s scripts (@xterm) aren\'t outside app.asar');
  fs.mkdirSync(path.join(unpacked, 'build'), { recursive: true });
  fs.copyFileSync(path.join(APP_DIR, 'build', 'icon-1024.png'), path.join(unpacked, 'build', 'icon-1024.png')); // the companion's icon
  plist(app, `Set :LSMinimumSystemVersion ${minimum}`);
  if (feed) fs.writeFileSync(path.join(resources, 'update.json'), `${JSON.stringify({ feed }, null, 2)}\n`);
  say(`  minimum macOS ${minimum}; ${spec.display} is ${megabytes(sizeOf(app))}; ${feed ? `updates from ${feed}` : `no updates (${spec.feedEnv} isn't set)`}`);

  say(`3. signing ${spec.display} ${args.adhoc ? 'ad hoc' : `as ${identity}`}`);
  const helperEntitlements = Object.fromEntries(Object.entries(helpers.helpers).map(([n, h]) => [n, h.entitlements]));
  signApp(app, { identity, helperEntitlements });

  say(`4. verifying ${spec.display}`);
  const checked = verifyApp(app, { adhoc: args.adhoc, helpers: helpers.helpers, forbidden: buildMacStrings(REPO) });
  if (checked.problems.length) throw new BuildError(`The signed app didn't verify:\n  ${checked.problems.join('\n  ')}`);
  say(`  ${checked.machos} Mach-O files signed and verified; needs macOS ${checked.needed}, declares ${checked.declared}`);

  if (!args.adhoc) {
    say(`5. notarizing ${spec.display}`);
    const zip = zipApp(app, path.join(STAGE, `${spec.name}.zip`));
    notarize(zip, profile);
    fs.rmSync(zip, { force: true });
    staple(app);
  }
  return app;
}

module.exports = { main, APPS, credentials, parseArgs, electronZipDir, minimumFor, dmgName, updateZipName, updateFeed };

if (require.main === module) {
  main().then(({ app, dmg }) => {
    say(`Done: ${dmg}\n      ${app}`);
  }).catch((err) => {
    console.error(`\n${err instanceof BuildError ? err.message : err.stack}`);
    process.exit(1);
  });
}
