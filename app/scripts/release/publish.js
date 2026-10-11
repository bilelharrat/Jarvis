// Publishes what `npm run dist` built (app/dist/release) as a GitHub release of
// bilelharrat/Jarvis, where people download J.A.R.V.I.S. and where the app looks for updates:
//
//   JARVIS_UPDATE_URL=https://github.com/bilelharrat/Jarvis/releases/latest/download/release.json
//
// (release.json's zip sits beside it, so "latest/download/" serves both from the newest
// release.) Needs the GitHub CLI signed in (gh auth login). The release is made as a draft
// with the disk image, the update's zip and the checksums, and release.json goes up last,
// then it's published: the feed never points at a zip that isn't there yet. It refuses an
// ad hoc build, a missing notarization ticket and a version that's already released.
//
//   node scripts/release/publish.js [--notes "What's new"] [--prerelease]
//   node scripts/release/publish.js --preview
//
// --preview publishes the ad hoc build (npm run dist -- --adhoc) as a pre-release,
// "v<version>-preview", for trying J.A.R.V.I.S. before it's notarized: macOS won't open it
// until the person allows it once in System Settings › Privacy & Security, the notes say
// how, and it never updates itself (the notarized release replaces it).
'use strict';

const fs = require('fs');
const path = require('path');
const { run, say, BuildError } = require('./util');

const APP = path.resolve(__dirname, '..', '..');
const OUT = path.join(APP, 'dist', 'release');
const OUT_EDEN_CODE = path.join(APP, 'dist', 'release-eden-code'); // npm run dist:eden-code's
const REPO = process.env.JARVIS_RELEASE_REPO || 'bilelharrat/Jarvis';
const PKG = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
const DISPLAY = 'J.A.R.V.I.S.';

function flag(name) {
  const at = process.argv.indexOf(name);
  return at < 0 ? null : process.argv[at + 1] || '';
}

const PREVIEW_NOTES = (version) => [
  `A preview of Eden ${version} for Apple-silicon Macs (M1 or later) on macOS 14 or later.`,
  '',
  "It isn't notarized by Apple yet, so macOS asks you to allow it once:",
  '1. Open the disk image and drag Eden onto Applications.',
  '2. Open Eden from Applications. macOS says it can\'t check it: click Done.',
  '3. Open System Settings › Privacy & Security, scroll to Security and click Open Anyway, then Open.',
  '',
  "You'll need your own Anthropic API key (console.anthropic.com › API keys) for Setup's Claude step.",
  "This preview doesn't update itself: download the notarized release when it's out.",
].join('\n');

function preview() {
  const version = PKG.version;
  const tag = `v${version}-preview`;
  const dmg = path.join(OUT, `${DISPLAY}-${version}-adhoc.dmg`);
  const sums = path.join(OUT, 'SHA256SUMS.txt');
  for (const file of [dmg, sums]) {
    if (!fs.existsSync(file)) throw new BuildError(`Missing ${path.relative(APP, file)}: run npm run dist -- --adhoc first.`);
  }
  if (!fs.readFileSync(sums, 'utf8').includes(path.basename(dmg))) throw new BuildError('SHA256SUMS.txt is for another build.');
  if (run('gh', ['auth', 'status'], { allowFail: true, quiet: true }).status !== 0) {
    throw new BuildError('The GitHub CLI isn\'t signed in: run gh auth login first.');
  }
  if (run('gh', ['release', 'view', tag, '--repo', REPO], { allowFail: true, quiet: true }).status === 0) {
    throw new BuildError(`${tag} is already released.`);
  }
  say(`publishing the preview ${tag} to ${REPO}`);
  run('gh', ['release', 'create', tag, dmg, sums, '--repo', REPO, '--prerelease', '--title', `Eden ${version} preview (not notarized)`, '--notes', flag('--notes') || PREVIEW_NOTES(version)]);
  say(`  published: https://github.com/${REPO}/releases/tag/${tag}`);
  say(`  download:  https://github.com/${REPO}/releases/download/${tag}/${encodeURIComponent(path.basename(dmg))}`);
}

// Eden Code's update (CH17): its zip and feed, built beside J.A.R.V.I.S.'s (dist.js: Eden Code-<v>-mac.zip and
// eden-code-release.json) or on their own (dist:eden-code: release.json in release-eden-code), go up with the release,
// so an Eden Code built with EDEN_CODE_UPDATE_URL=…/latest/download/eden-code-release.json finds them. GitHub turns
// the space in an asset's name into a dot, so the zip goes up as Eden.Code-<v>-mac.zip and the feed is rewritten to
// point there. null when no Eden Code update was built; throws on a feed without its zip, or one that names another.
function edenCodeUpdate({ version, out = OUT, outEdenCode = OUT_EDEN_CODE, exists = fs.existsSync, read = (f) => fs.readFileSync(f, 'utf8') }) {
  const zipName = `Eden Code-${version}-mac.zip`;
  const where = [[out, 'eden-code-release.json'], [outEdenCode, 'release.json']].find(([dir, feed]) => exists(path.join(dir, feed)) || exists(path.join(dir, zipName)));
  if (!where) return null;
  const [dir, feedName] = where;
  const zip = path.join(dir, zipName);
  const feed = path.join(dir, feedName);
  if (!exists(zip) || !exists(feed)) throw new BuildError(`Eden Code's update is half there (${path.relative(APP, zip)} and ${path.relative(APP, feed)} go together): build it again with EDEN_CODE_UPDATE_URL set.`);
  const listed = JSON.parse(read(feed));
  const to = listed && listed.releases && listed.releases[0] && listed.releases[0].updateTo;
  const named = to && String(to.url || '');
  if (String(listed.currentRelease) !== version || !named || !(named.endsWith(`/${encodeURIComponent(zipName)}`) || named.endsWith(`/${zipName}`))) {
    throw new BuildError(`${path.relative(APP, feed)} isn't Eden Code ${version}'s feed for ${zipName}`);
  }
  const safeName = zipName.replace(/ /g, '.');
  to.url = `${named.slice(0, named.lastIndexOf('/') + 1)}${encodeURIComponent(safeName)}`;
  return { zip, safeName, feedText: `${JSON.stringify(listed, null, 2)}\n` };
}

// The Eden Code files, put where gh uploads them from under the names they go up as.
function stageEdenCode(update) {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'eden-code-release-'));
  const zip = path.join(dir, update.safeName);
  const feed = path.join(dir, 'eden-code-release.json');
  fs.copyFileSync(update.zip, zip);
  fs.writeFileSync(feed, update.feedText);
  return { zip, feed };
}

function main() {
  if (process.argv.includes('--preview')) return preview();
  const version = PKG.version;
  const tag = `v${version}`;
  const dmg = path.join(OUT, `${DISPLAY}-${version}.dmg`);
  const zip = path.join(OUT, `${DISPLAY}-${version}-mac.zip`);
  const feed = path.join(OUT, 'release.json');
  const sums = path.join(OUT, 'SHA256SUMS.txt');
  if (fs.existsSync(path.join(OUT, `${DISPLAY}-${version}-adhoc.dmg`)) && !fs.existsSync(dmg)) {
    throw new BuildError('Only an ad hoc build is here: build the signed, notarized one (npm run dist) first.');
  }
  for (const file of [dmg, zip, feed, sums]) {
    if (!fs.existsSync(file)) throw new BuildError(`Missing ${path.relative(APP, file)}: run npm run dist with JARVIS_UPDATE_URL set.`);
  }
  const stapled = run('/usr/bin/xcrun', ['stapler', 'validate', dmg], { allowFail: true });
  if (stapled.status !== 0) throw new BuildError(`The disk image has no notarization ticket: ${stapled.stdout}${stapled.stderr}`);
  const listed = JSON.parse(fs.readFileSync(feed, 'utf8'));
  if (!JSON.stringify(listed).includes(path.basename(zip).replace(/ /g, '%20')) && !JSON.stringify(listed).includes(path.basename(zip))) {
    throw new BuildError(`release.json doesn't point at ${path.basename(zip)}`);
  }
  if (run('gh', ['auth', 'status'], { allowFail: true, quiet: true }).status !== 0) {
    throw new BuildError('The GitHub CLI isn\'t signed in: run gh auth login first.');
  }
  if (run('gh', ['release', 'view', tag, '--repo', REPO], { allowFail: true, quiet: true }).status === 0) {
    throw new BuildError(`${tag} is already released: bump "version" in app/package.json and build again.`);
  }
  const edenCode = edenCodeUpdate({ version });
  const notes = flag('--notes') || process.env.JARVIS_RELEASE_NOTES || `Eden ${version} for Apple-silicon Macs (macOS 14 or later). Open the disk image and drag Eden onto Applications.`;
  say(`publishing ${tag} to ${REPO}`);
  const create = ['release', 'create', tag, dmg, zip, sums, '--repo', REPO, '--draft', '--title', `Eden ${version}`, '--notes', notes];
  if (process.argv.includes('--prerelease')) create.push('--prerelease');
  run('gh', create);
  if (edenCode) {
    const staged = stageEdenCode(edenCode);
    say(`  with Eden Code's update: ${edenCode.safeName} and eden-code-release.json`);
    run('gh', ['release', 'upload', tag, staged.zip, '--repo', REPO]); // its zip first, then its feed: never a feed without its zip
    run('gh', ['release', 'upload', tag, staged.feed, '--repo', REPO]);
  }
  run('gh', ['release', 'upload', tag, feed, '--repo', REPO]);
  run('gh', ['release', 'edit', tag, '--repo', REPO, '--draft=false', ...(process.argv.includes('--prerelease') ? [] : ['--latest'])]);
  say(`  published: https://github.com/${REPO}/releases/tag/${tag}`);
  say(`  download:  https://github.com/${REPO}/releases/latest/download/${encodeURIComponent(path.basename(dmg))}`);
}

module.exports = { edenCodeUpdate };

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof BuildError ? `\n${err.message}` : err);
    process.exit(1);
  }
}
