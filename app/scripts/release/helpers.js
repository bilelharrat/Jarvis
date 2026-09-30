// The Swift helpers, prebuilt for the app people download (it has no swiftc): every
// jarvis-*.swift under src/jarvis (globbed, so a helper added later comes along), compiled
// for the app's minimum macOS, each beside `<name>.sha256`, the SHA-256 of its source, which
// swift_helper.prebuilt() compares before using it. A helper whose APIs need a newer macOS
// (jarvis-hear: SpeechAnalyzer, macOS 26) gets that as its own target, recorded in
// helpers.json; on an older Mac it doesn't start and the backend treats it as unavailable.
//
//   node scripts/release/helpers.js <out folder> <minimum macOS>
'use strict';

const fs = require('fs');
const path = require('path');
const { BuildError, run, say, sha256File } = require('./util');
const { compareVersions, maxVersion } = require('./macho');

const SRC = path.resolve(__dirname, '..', '..', '..', 'src', 'jarvis');

function findSources(root = SRC) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== '__pycache__' && entry.name !== 'node_modules') walk(full);
      else if (entry.isFile() && /^jarvis-[\w-]+\.swift$/.test(entry.name)) found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

// swiftc treats a lone file as top-level code unless told otherwise; one with @main is a
// library with an entry point (audio.build compiles those with -parse-as-library too).
function flagsFor(source) {
  return /^\s*@main\b/m.test(source) ? ['-parse-as-library'] : [];
}

// The macOS that swiftc's availability errors ask for ("… is only available in macOS 26 or
// newer"), or null when the errors are something else.
function neededMacos(stderr) {
  const wanted = [...String(stderr).matchAll(/only available in macOS (\d+(?:\.\d+)*) or newer/g)].map((m) => m[1]);
  const found = maxVersion(wanted);
  return found && !found.includes('.') ? `${found}.0` : found;
}

// What a helper needs of the hardened runtime, from what its source uses: the microphone
// (an audio engine's input, a capture device, a recorder) is the only one so far. The
// entitlements file of that name (app/build/entitlements/) is signed into it.
function entitlementsFor(source) {
  return /\binputNode\b|AVAudioRecorder|AVCaptureDevice|AVCaptureSession/.test(source) ? 'microphone' : null;
}

function targetFor(version) {
  return `arm64-apple-macos${/\./.test(version) ? version : `${version}.0`}`;
}

function compile(source, output, version, flags, swiftc) {
  const [command, ...pre] = swiftc;
  return run(command, [...pre, '-O', '-target', targetFor(version), ...flags, '-o', output, source], { allowFail: true });
}

// Builds every helper into `out`; returns the manifest written to out/helpers.json.
function buildHelpers({ out, minimum, sources = findSources(), swiftc = ['xcrun', 'swiftc'] }) {
  if (!sources.length) throw new BuildError(`no jarvis-*.swift helpers under ${SRC}`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const manifest = { minimum, helpers: {} };
  for (const source of sources) {
    const name = path.basename(source, '.swift');
    const output = path.join(out, name);
    const text = fs.readFileSync(source, 'utf8');
    const flags = flagsFor(text);
    let target = minimum;
    let done = compile(source, output, target, flags, swiftc);
    if (done.status !== 0) {
      const needed = neededMacos(done.stderr);
      if (needed && compareVersions(needed, minimum) > 0) {
        target = needed;
        done = compile(source, output, target, flags, swiftc);
      }
    }
    if (done.status !== 0) {
      const why = (done.stderr || done.stdout).split('\n').filter((l) => /error:/.test(l)).slice(0, 6).join('\n');
      throw new BuildError(`the ${name} helper didn't build:\n${why || done.stderr.slice(-800)}`);
    }
    fs.chmodSync(output, 0o755);
    const digest = sha256File(source);
    fs.writeFileSync(`${output}.sha256`, `${digest}\n`);
    manifest.helpers[name] = {
      source: path.relative(path.resolve(SRC, '..', '..'), source),
      sha256: digest,
      target,
      flags,
      entitlements: entitlementsFor(text),
      optional: compareVersions(target, minimum) > 0, // runs only on that macOS or later
    };
    say(`  helper ${name}: macOS ${target}${manifest.helpers[name].optional ? ' (newer than the app: unavailable before it)' : ''}`);
  }
  fs.writeFileSync(path.join(out, 'helpers.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

module.exports = { findSources, flagsFor, entitlementsFor, neededMacos, targetFor, buildHelpers, SRC };

if (require.main === module) {
  const [out, minimum] = process.argv.slice(2);
  if (!out || !/^\d+(\.\d+)*$/.test(minimum || '')) {
    console.error('usage: node scripts/release/helpers.js <out folder> <minimum macOS, e.g. 14.0>');
    process.exit(2);
  }
  try {
    buildHelpers({ out: path.resolve(out), minimum });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
