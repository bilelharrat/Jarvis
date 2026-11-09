// What the bundled backend runs from JARVIS_HELPERS_DIR (src/jarvis/swift_helper.py prebuilt),
// which the launcher points at the app's Resources/helpers (backend-launch.js bundledEnv): the
// Swift helpers, prebuilt (helpers.js), each beside `<name>.sha256`, the SHA-256 of the source it
// was built from, and helpers.json, by which the doctor knows they're built in
// (features/ops/doctor.py). prebuilt() takes a helper only while that is the hash of the source
// the backend itself carries (site-packages/jarvis/…/<name>.swift) and the file is a program.
// Otherwise the backend compiles it with swiftc on first use, which a Mac without developer
// tools can't: text recognition (jarvis-ocr), call audio (jarvis-callaudio), embeddings
// (jarvis-embed), the Accessibility reader (jarvis-axread), the hands guard's probe
// (jarvis-axprobe) and the rest are unavailable there, and /usr/bin/swiftc may offer to install
// the tools.
// J.A.R.V.I.S.'s release builds its backend and the helpers from the repo in one go (dist.js).
// Ask Eden's build reuses an engine built earlier (eden/build.js), so the helpers are built from
// the sources that engine carries: the ones its Python hashes and talks to.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { bundledEnv } = require('../../backend-launch');
const { buildHelpers, findSources } = require('./helpers');
const { entitlementKeys } = require('./sign');
const { display, entitlementsOf } = require('./verify');
const { BuildError } = require('./util');

// JARVIS_HELPERS_DIR for an app whose Resources folder is `resources`, as the launcher sets it.
function helpersDirIn(resources) {
  return bundledEnv({}, { resourcesPath: resources, token: '', extraPath: [] }).JARVIS_HELPERS_DIR;
}

// The jarvis package in a bundled Python (Resources/backend/python, or the engine cache's):
// lib/python3.x/site-packages/jarvis, or null without one.
function packageIn(python) {
  let versions;
  try {
    versions = fs.readdirSync(path.join(python, 'lib')).filter((n) => /^python3\.\d+$/.test(n)).sort();
  } catch {
    return null;
  }
  const found = versions.map((v) => path.join(python, 'lib', v, 'site-packages', 'jarvis')).find((p) => fs.existsSync(p));
  return found || null;
}

// The helpers the backend in `python` may run: their sources there, what prebuilt() hashes.
function helperSources(python) {
  const pkg = packageIn(python);
  return pkg ? findSources(pkg) : [];
}

// Builds them into `dir` for macOS `minimum` from the sources the backend in `python` carries;
// helpers.json names each as it is in site-packages. Returns the manifest. (`options.swiftc`:
// the compiler, for the tests.)
function fillHelpers(python, dir, minimum, options = {}) {
  const sources = helperSources(python);
  if (!sources.length) throw new BuildError(`the engine (${python}) carries no jarvis-*.swift helper sources`);
  return buildHelpers({ ...options, out: dir, minimum, sources, base: path.dirname(packageIn(python)) });
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// What prebuilt() would refuse in `dir` (JARVIS_HELPERS_DIR) for the backend in `python`, one
// line each ([] when nothing): a helper whose source the backend carries without its program
// (a file it may run) or without `<name>.sha256` naming that source's SHA-256, read as
// prebuilt() reads it (ASCII text, its first word); helpers.json.
function helperProblems(dir, python) {
  const sources = helperSources(python);
  if (!sources.length) return [`the backend (${python}) carries no jarvis-*.swift helper sources`];
  const site = path.dirname(packageIn(python));
  const problems = [];
  for (const source of sources) {
    const name = path.basename(source, '.swift');
    const binary = path.join(dir, name);
    let program = false;
    try { program = fs.statSync(binary).isFile(); } catch { /* not there */ }
    if (!program) { problems.push(`${name}: missing (${binary})`); continue; }
    try { fs.accessSync(binary, fs.constants.X_OK); } catch { problems.push(`${name}: not executable`); }
    let raw;
    try { raw = fs.readFileSync(`${binary}.sha256`); } catch { problems.push(`${name}: no ${name}.sha256`); continue; }
    if (raw.some((byte) => byte > 0x7f)) { problems.push(`${name}: ${name}.sha256 isn't ASCII text`); continue; }
    const recorded = raw.toString('ascii').split(/\s+/).find(Boolean);
    const digest = sha256(source);
    if (recorded !== digest) {
      problems.push(`${name}: built from another source (${name}.sha256 says ${recorded || 'nothing'}; the backend's ${path.relative(site, source)} is ${digest})`);
    }
  }
  let manifest = false;
  try { manifest = fs.statSync(path.join(dir, 'helpers.json')).isFile(); } catch { /* not there */ }
  if (!manifest) problems.push('helpers.json: missing (the doctor then says the built-in helpers are missing)');
  return problems;
}

// Stops the build unless `dir` holds every helper the backend in `python` would take.
function checkHelpers(dir, python, what) {
  const problems = helperProblems(dir, python);
  if (problems.length) {
    throw new BuildError(`${what} lacks Swift helpers its backend takes from JARVIS_HELPERS_DIR (${dir}); it would compile them with swiftc, which Macs without developer tools don't have:\n  ${problems.join('\n  ')}`);
  }
}

// Once signed with the team's certificate: each helper in helpers.json signed by that team,
// with the hardened runtime and exactly the entitlements it asks for there (helpers.js
// entitlementsFor: the microphone for the one that opens it), never the app's own.
function signatureProblems(dir, team) {
  const { helpers = {} } = JSON.parse(fs.readFileSync(path.join(dir, 'helpers.json'), 'utf8'));
  const problems = [];
  for (const [name, { entitlements }] of Object.entries(helpers)) {
    const file = path.join(dir, name);
    const shown = display(file);
    const by = shown.team === 'not set' ? '' : shown.team; // codesign's word for ad hoc
    if (!shown.signed || by !== team) problems.push(`${name}: not signed by team ${team} (${by || 'no team'})`);
    if (!shown.flags.includes('runtime')) problems.push(`${name}: no hardened runtime`);
    const want = entitlementKeys(entitlements, false).sort();
    const got = entitlementsOf(file);
    if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${name}: entitlements ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  }
  return problems;
}

module.exports = { helpersDirIn, packageIn, helperSources, fillHelpers, helperProblems, checkHelpers, signatureProblems };
