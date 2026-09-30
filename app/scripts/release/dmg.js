// The disk image people download: the app beside a link to Applications, to drag it onto,
// compressed with LZMA (ULMO; macOS 10.15 and later open it, and the app needs 14).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, say, sha256File, megabytes } = require('./util');

function makeDmg(app, dmg, volume) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-dmg-'));
  try {
    run('/usr/bin/ditto', [app, path.join(stage, path.basename(app))]);
    fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
    fs.rmSync(dmg, { force: true });
    run('/usr/bin/hdiutil', ['create', '-volname', volume, '-srcfolder', stage, '-format', 'ULMO', '-ov', dmg]);
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
  say(`  ${path.basename(dmg)}: ${megabytes(fs.statSync(dmg).size)}`);
  return dmg;
}

// A disk image is signed without the hardened runtime (that's for code).
function signDmg(dmg, identity) {
  run('/usr/bin/codesign', ['--force', '--sign', identity, '--timestamp', dmg]);
  run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', dmg]);
}

// `shasum -a 256 -c SHA256SUMS.txt` checks each file against it.
function writeChecksums(files, out) {
  const lines = files.map((file) => `${sha256File(file)}  ${path.basename(file)}`);
  fs.writeFileSync(out, `${lines.join('\n')}\n`);
  return lines;
}

module.exports = { makeDmg, signDmg, writeChecksums };
