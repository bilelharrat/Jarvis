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
const REPO = process.env.JARVIS_RELEASE_REPO || 'bilelharrat/Jarvis';
const PKG = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
const DISPLAY = 'J.A.R.V.I.S.';

function flag(name) {
  const at = process.argv.indexOf(name);
  return at < 0 ? null : process.argv[at + 1] || '';
}

const PREVIEW_NOTES = (version) => [
  `A preview of J.A.R.V.I.S. ${version} for Apple-silicon Macs (M1 or later) on macOS 14 or later.`,
  '',
  "It isn't notarized by Apple yet, so macOS asks you to allow it once:",
  '1. Open the disk image and drag J.A.R.V.I.S. onto Applications.',
  '2. Open J.A.R.V.I.S. from Applications. macOS says it can\'t check it: click Done.',
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
  run('gh', ['release', 'create', tag, dmg, sums, '--repo', REPO, '--prerelease', '--title', `J.A.R.V.I.S. ${version} preview (not notarized)`, '--notes', flag('--notes') || PREVIEW_NOTES(version)]);
  say(`  published: https://github.com/${REPO}/releases/tag/${tag}`);
  say(`  download:  https://github.com/${REPO}/releases/download/${tag}/${encodeURIComponent(path.basename(dmg))}`);
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
  const notes = flag('--notes') || process.env.JARVIS_RELEASE_NOTES || `J.A.R.V.I.S. ${version} for Apple-silicon Macs (macOS 14 or later). Open the disk image and drag J.A.R.V.I.S. onto Applications.`;
  say(`publishing ${tag} to ${REPO}`);
  const create = ['release', 'create', tag, dmg, zip, sums, '--repo', REPO, '--draft', '--title', `J.A.R.V.I.S. ${version}`, '--notes', notes];
  if (process.argv.includes('--prerelease')) create.push('--prerelease');
  run('gh', create);
  run('gh', ['release', 'upload', tag, feed, '--repo', REPO]);
  run('gh', ['release', 'edit', tag, '--repo', REPO, '--draft=false', ...(process.argv.includes('--prerelease') ? [] : ['--latest'])]);
  say(`  published: https://github.com/${REPO}/releases/tag/${tag}`);
  say(`  download:  https://github.com/${REPO}/releases/latest/download/${encodeURIComponent(path.basename(dmg))}`);
}

try {
  main();
} catch (err) {
  console.error(err instanceof BuildError ? `\n${err.message}` : err);
  process.exit(1);
}
