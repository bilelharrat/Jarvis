// Puts a notarized release's disk image on askeden.com/jarvis/download: uploads it to the
// R2 bucket the download Worker reads, then points latest.json at it (last, so the page
// never offers a file that isn't all there). Needs `npx wrangler login` once.
//
//   node scripts/upload-release.js [path/to/J.A.R.V.I.S.-<version>.dmg]
//
// Without a path it takes app/dist/release's disk image for app/package.json's version.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.resolve(SITE, '..', 'app');
const BUCKET = 'jarvis-downloads';
const MAX = 300 * 1024 * 1024; // wrangler r2 object put's limit for one upload

function run(args, what) {
  const done = spawnSync('npx', ['--yes', 'wrangler', ...args], { cwd: SITE, stdio: 'inherit' });
  if (done.status !== 0) throw new Error(`${what} failed (wrangler ${args.slice(0, 3).join(' ')})`);
}

function stapled(file) {
  return spawnSync('/usr/bin/xcrun', ['stapler', 'validate', file], { encoding: 'utf8' }).status === 0;
}

const version = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8')).version;
const dmg = path.resolve(process.argv[2] || path.join(APP, 'dist', 'release', `J.A.R.V.I.S.-${version}.dmg`));
try {
  if (!fs.existsSync(dmg)) throw new Error(`No disk image at ${dmg}: build it with npm run dist first.`);
  if (/-adhoc\.dmg$/.test(dmg)) throw new Error('That is the ad hoc build: only a notarized release goes on the site.');
  if (!stapled(dmg)) throw new Error(`${path.basename(dmg)} has no notarization ticket.`);
  const size = fs.statSync(dmg).size;
  if (size > MAX) throw new Error(`${path.basename(dmg)} is ${Math.round(size / 1048576)} MiB; wrangler uploads up to 300 MiB. Use an R2 API token and a multipart upload instead.`);
  const file = path.basename(dmg);
  const v = (file.match(/-(\d+\.\d+\.\d+)\.dmg$/) || [])[1] || version;
  console.log(`uploading ${file} (${Math.round(size / 1e6)} MB) to R2 ${BUCKET}`);
  run(['r2', 'object', 'put', `${BUCKET}/${file}`, '--file', dmg, '--content-type', 'application/x-apple-diskimage', '--remote'], 'The upload');
  const latest = path.join(SITE, '.latest.json');
  fs.writeFileSync(latest, JSON.stringify({ version: v, size, file, published: new Date().toISOString() }));
  run(['r2', 'object', 'put', `${BUCKET}/latest.json`, '--file', latest, '--content-type', 'application/json', '--remote'], 'Pointing latest.json at it');
  fs.rmSync(latest, { force: true });
  console.log(`live: https://www.askeden.com/jarvis/download is J.A.R.V.I.S. ${v}`);
} catch (err) {
  console.error(`\n${err.message}`);
  process.exit(1);
}
