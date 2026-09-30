// Signs the app inside-out: every Mach-O in it (dylibs, .so files, the Python executable,
// the Swift helpers, Electron's frameworks and helper apps), each with the hardened runtime,
// a secure timestamp and its own entitlements from app/build/entitlements, then the bundles
// that hold them, deepest first, and the app last. Never --deep: that would give every file
// the app's entitlements. Anthropic's Claude engine (claude_agent_sdk/_bundled/claude) is
// already signed by Anthropic's Developer ID with the hardened runtime and a timestamp; it
// keeps that signature.
//
// identity "-" signs ad hoc (npm run dist -- --adhoc): the same flags and entitlements, no
// timestamp. An ad hoc signature has no Team ID, and library validation lets a hardened
// program load only libraries of its own team, so ad hoc the app, its Electron helpers and
// Python also get com.apple.security.cs.disable-library-validation; without it none of them
// could load their own frameworks and extension modules. The Developer ID build doesn't
// need it: every library in the app then carries the same team.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const macho = require('./macho');
const { BuildError, run, say } = require('./util');

const ENTITLEMENTS = path.resolve(__dirname, '..', '..', 'build', 'entitlements');
const DLV = 'com.apple.security.cs.disable-library-validation';
const CLAUDE = /\/claude_agent_sdk\/_bundled\/claude$/;
const BUNDLE = /\.(app|framework|xpc|appex|bundle|plugin)$/;
const ID_PREFIX = 'com.bshventures.jarvis';

// Which entitlements a signed item gets, by where it is in the app (null: none).
function entitlementsFor(rel, helperEntitlements = {}) {
  if (rel === '') return 'app';
  const helperApp = /^Contents\/Frameworks\/[^/]+ Helper(?: \((Renderer|GPU|Plugin)\))?\.app$/.exec(rel);
  if (helperApp) return helperApp[1] ? helperApp[1].toLowerCase() : 'helper';
  if (/^Contents\/Resources\/backend\/python\/bin\/python3\.\d+$/.test(rel)) return 'python';
  const helper = /^Contents\/Resources\/helpers\/(jarvis-[\w-]+)$/.exec(rel);
  if (helper) return helperEntitlements[helper[1]] || null;
  return null;
}

// Only programs started on their own are given an identifier of the app's own: the
// Keychain and privacy settings remember them by it (the Python the Keychain trusts to read
// an API key, say). Libraries keep their file name.
function identifierFor(rel) {
  if (/^Contents\/Resources\/backend\/python\/bin\/python3\.\d+$/.test(rel)) return `${ID_PREFIX}.python`;
  const helper = /^Contents\/Resources\/helpers\/(jarvis-[\w-]+)$/.exec(rel);
  if (helper) return `${ID_PREFIX}.${helper[1]}`;
  return null;
}

function plistKeys(file) {
  const xml = fs.readFileSync(file, 'utf8');
  return [...xml.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((m) => m[1]);
}

function writePlist(file, keys) {
  const body = keys.map((k) => `\t<key>${k}</key>\n\t<true/>\n`).join('');
  fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n${body}</dict>\n</plist>\n`);
}

// The entitlement keys each kind gets; ad hoc adds library validation's exception to the
// programs that load libraries of the app's own.
function entitlementKeys(kind, adhoc) {
  if (!kind) return [];
  const keys = plistKeys(path.join(ENTITLEMENTS, `${kind}.plist`));
  const loadsOwnLibraries = ['app', 'helper', 'renderer', 'gpu', 'plugin', 'python'].includes(kind);
  return adhoc && loadsOwnLibraries && !keys.includes(DLV) ? [...keys, DLV] : keys;
}

// The main executable of a bundle is signed with the bundle, not on its own.
function mainExecutableOf(bundle) {
  const plist = fs.existsSync(path.join(bundle, 'Contents', 'Info.plist'))
    ? path.join(bundle, 'Contents', 'Info.plist')
    : path.join(bundle, 'Resources', 'Info.plist'); // a framework: Versions/Current/Resources
  if (!fs.existsSync(plist)) return null;
  const name = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist], { allowFail: true, quiet: true }).stdout.trim();
  if (!name) return null;
  const inside = fs.existsSync(path.join(bundle, 'Contents')) ? path.join(bundle, 'Contents', 'MacOS', name) : path.join(bundle, name);
  try { return fs.realpathSync(inside); } catch { return null; }
}

// Everything to sign, deepest first: loose Mach-O files, then the bundles around them.
function plan(app, { helperEntitlements = {} } = {}) {
  const bundles = [];
  const walkDirs = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue; // symlinks (Versions/Current) aren't followed
      const full = path.join(dir, entry.name);
      if (BUNDLE.test(entry.name)) bundles.push(full);
      walkDirs(full);
    }
  };
  walkDirs(app);
  const mains = new Set(bundles.map(mainExecutableOf).filter(Boolean));
  mains.add(fs.realpathSync(mainExecutableOf(app) || path.join(app, 'missing')));
  const items = [];
  const kept = [];
  for (const { file } of macho.scan(app)) {
    const real = fs.realpathSync(file);
    if (mains.has(real)) continue;
    const rel = path.relative(app, file);
    if (CLAUDE.test(`/${rel}`)) { kept.push(rel); continue; }
    items.push({ path: file, rel, kind: entitlementsFor(rel, helperEntitlements), identifier: identifierFor(rel), bundle: false });
  }
  for (const bundle of bundles) {
    const rel = path.relative(app, bundle);
    items.push({ path: bundle, rel, kind: entitlementsFor(rel, helperEntitlements), identifier: null, bundle: true });
  }
  const depth = (p) => p.split(path.sep).length;
  items.sort((a, b) => depth(b.path) - depth(a.path) || a.path.localeCompare(b.path));
  items.push({ path: app, rel: '', kind: 'app', identifier: null, bundle: true });
  return { items, kept };
}

function signOne(item, { identity, adhoc, work }) {
  const args = ['--force', '--sign', identity, '--options', 'runtime'];
  args.push(adhoc ? '--timestamp=none' : '--timestamp');
  const keys = entitlementKeys(item.kind, adhoc);
  if (keys.length) {
    const file = path.join(work, `${item.kind}${adhoc ? '-adhoc' : ''}.plist`);
    if (!fs.existsSync(file)) writePlist(file, keys);
    args.push('--entitlements', file);
  }
  if (item.identifier) args.push('--identifier', item.identifier);
  args.push(item.path);
  run('/usr/bin/codesign', args);
  return keys;
}

// Signs everything; returns what each item was signed with (for verify.js).
function signApp(app, { identity, helperEntitlements = {} }) {
  if (!identity) throw new BuildError('no signing identity');
  const adhoc = identity === '-';
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-sign-'));
  try {
    const { items, kept } = plan(app, { helperEntitlements });
    const signed = [];
    for (const item of items) {
      const keys = signOne(item, { identity, adhoc, work });
      signed.push({ rel: item.rel, bundle: item.bundle, entitlements: keys, identifier: item.identifier });
    }
    say(`  signed ${signed.length} items${adhoc ? ' ad hoc' : ''}; kept Anthropic's signature on ${kept.join(', ') || 'nothing'}`);
    return { adhoc, signed, kept };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { signApp, plan, entitlementsFor, entitlementKeys, identifierFor, plistKeys, ENTITLEMENTS, DLV };
