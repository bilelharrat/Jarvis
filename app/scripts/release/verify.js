// Checks a signed app before it goes anywhere:
// - `codesign --verify --strict` on the app (and everything nested in it) and on every
//   Mach-O file one by one; none is left unsigned;
// - each has the hardened runtime, a secure timestamp (unless ad hoc) and exactly the
//   entitlements sign.js meant for it;
// - Anthropic's Claude engine still carries Anthropic's own Developer ID signature;
// - Info.plist's LSMinimumSystemVersion is at least what every Mach-O needs (the optional
//   helpers built for a newer macOS aside);
// - nothing in it names the Mac it was built on (the repo, the home folder), and there is no
//   jarvis-home.json (the owner's install-app build records the repo there);
// - once notarized, Gatekeeper's own check: spctl -a -vvv -t install.
//
//   node scripts/release/verify.js <J.A.R.V.I.S.app> [--adhoc] [--notarized]
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const macho = require('./macho');
const { plan, entitlementKeys } = require('./sign');
const { run, say } = require('./util');

const ANTHROPIC = { authority: 'Developer ID Application: Anthropic PBC (Q6L2SF6YDW)', team: 'Q6L2SF6YDW' };

function display(target) {
  const done = run('/usr/bin/codesign', ['-dvvv', target], { allowFail: true, quiet: true });
  const text = `${done.stdout}${done.stderr}`;
  const flags = /CodeDirectory v=\S+ size=\d+ flags=0x[0-9a-f]+\(([^)]*)\)/.exec(text);
  return {
    signed: !/not signed at all/.test(text) && Boolean(flags),
    flags: flags ? flags[1].split(',') : [],
    adhoc: /Signature=adhoc/.test(text),
    timestamp: /^Timestamp=/m.test(text),
    authorities: [...text.matchAll(/^Authority=(.+)$/gm)].map((m) => m[1]),
    team: (/^TeamIdentifier=(.+)$/m.exec(text) || [])[1] || '',
    identifier: (/^Identifier=(.+)$/m.exec(text) || [])[1] || '',
  };
}

function entitlementsOf(target) {
  const done = run('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', target], { allowFail: true, quiet: true });
  return [...done.stdout.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((m) => m[1]).sort();
}

function verifies(target, deep = false) {
  const args = ['--verify', '--strict', '--verbose=2'];
  if (deep) args.push('--deep');
  const done = run('/usr/bin/codesign', [...args, target], { allowFail: true, quiet: true });
  return done.status === 0 ? '' : `${done.stderr}${done.stdout}`.trim().split('\n').slice(-3).join(' / ');
}

// Byte strings that must not be anywhere in the app, and where they were found.
function findStrings(root, needles) {
  const found = [];
  const wanted = needles.filter((n) => n && n.length > 8).map((n) => Buffer.from(n));
  if (!wanted.length) return found;
  for (const file of macho.walkFiles(root)) {
    let data;
    try { data = fs.readFileSync(file); } catch { continue; }
    for (const needle of wanted) {
      if (data.indexOf(needle) !== -1) { found.push(`${path.relative(root, file)}: ${needle.toString()}`); break; }
    }
  }
  return found;
}

// Symlinks that lead out of the app (an absolute one, or ../ past its root): what they point
// at isn't on anyone else's Mac.
function strayLinks(root) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(full);
        const lands = path.resolve(dir, target);
        if (path.isAbsolute(target) || !(lands === root || lands.startsWith(`${root}${path.sep}`))) {
          found.push(`${path.relative(root, full)} -> ${target}`);
        }
      } else if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return found;
}

function plistValue(app, key) {
  return run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, path.join(app, 'Contents', 'Info.plist')], { allowFail: true, quiet: true }).stdout.trim();
}

function verifyApp(app, { adhoc = false, notarized = false, helpers = {}, forbidden = [] } = {}) {
  const problems = [];
  const helperEntitlements = Object.fromEntries(Object.entries(helpers).map(([name, h]) => [name, h.entitlements || null]));

  const whole = verifies(app, true);
  if (whole) problems.push(`the app doesn't verify: ${whole}`);

  // Every Mach-O, one by one.
  const { items, kept } = plan(app, { helperEntitlements });
  const expected = new Map(items.map((item) => [item.rel, entitlementKeys(item.kind, adhoc).sort()]));
  const machos = macho.scan(app);
  for (const { file } of machos) {
    const rel = path.relative(app, file);
    const shown = display(file);
    if (!shown.signed) { problems.push(`${rel}: not signed`); continue; }
    const bad = verifies(file);
    if (bad) problems.push(`${rel}: ${bad}`);
    if (!shown.flags.includes('runtime')) problems.push(`${rel}: no hardened runtime`);
    if (kept.includes(rel)) {
      if (!shown.authorities.includes(ANTHROPIC.authority) || shown.team !== ANTHROPIC.team || !shown.timestamp) {
        problems.push(`${rel}: isn't Anthropic's own signature any more (${shown.authorities[0] || 'none'})`);
      }
      continue;
    }
    if (adhoc ? !shown.adhoc : shown.adhoc || !shown.timestamp) problems.push(`${rel}: ${adhoc ? 'not ad hoc' : 'no secure timestamp'}`);
  }
  // What each signed item was given.
  for (const item of items) {
    const want = expected.get(item.rel);
    const got = entitlementsOf(item.path);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      problems.push(`${item.rel || 'the app'}: entitlements ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    }
    if (item.bundle && item.rel) {
      const bad = verifies(item.path);
      if (bad) problems.push(`${item.rel}: ${bad}`);
    }
  }

  // The macOS it says it needs covers what it carries.
  const optional = new Set(Object.entries(helpers).filter(([, h]) => h.optional).map(([name]) => `Contents/Resources/helpers/${name}`));
  const needed = macho.maxVersion(machos.filter((m) => !optional.has(path.relative(app, m.file))).map((m) => m.minos));
  const declared = plistValue(app, 'LSMinimumSystemVersion');
  if (!declared || macho.compareVersions(declared, needed) < 0) problems.push(`LSMinimumSystemVersion is ${declared || 'missing'}, but its code needs macOS ${needed}`);

  // Nothing of the Mac it was built on.
  const asar = path.join(app, 'Contents', 'Resources', 'app.asar');
  const packed = fs.existsSync(asar) ? fs.readFileSync(asar) : Buffer.alloc(0);
  if (packed.indexOf('"jarvis-home.json":{') !== -1 || fs.existsSync(path.join(app, 'Contents', 'Resources', 'app', 'jarvis-home.json'))) {
    problems.push('jarvis-home.json is in the app (the owner\'s repo path)');
  }
  for (const hit of findStrings(app, forbidden).slice(0, 10)) problems.push(`names the build Mac: ${hit}`);
  for (const link of strayLinks(app).slice(0, 10)) problems.push(`a link out of the app: ${link}`);

  let gatekeeper = '';
  if (notarized) {
    const done = run('/usr/sbin/spctl', ['-a', '-vvv', '-t', 'install', app], { allowFail: true });
    gatekeeper = `${done.stderr}${done.stdout}`.trim();
    if (done.status !== 0 || !/accepted/.test(gatekeeper) || !/Notarized Developer ID/.test(gatekeeper)) problems.push(`Gatekeeper refuses it: ${gatekeeper}`);
  }
  return { problems, machos: machos.length, needed, declared, gatekeeper };
}

// What must never appear in the app: the repo's path and this Mac's home folder.
function buildMacStrings(repo) {
  return [path.resolve(repo), os.homedir()];
}

module.exports = { verifyApp, findStrings, strayLinks, display, entitlementsOf, buildMacStrings };

if (require.main === module) {
  const args = process.argv.slice(2);
  const app = args.find((a) => !a.startsWith('--'));
  if (!app) {
    console.error('usage: node scripts/release/verify.js <J.A.R.V.I.S.app> [--adhoc] [--notarized]');
    process.exit(2);
  }
  let helpers = {};
  try { helpers = JSON.parse(fs.readFileSync(path.join(app, 'Contents', 'Resources', 'helpers', 'helpers.json'), 'utf8')).helpers; } catch { /* none */ }
  const result = verifyApp(path.resolve(app), {
    adhoc: args.includes('--adhoc'), notarized: args.includes('--notarized'), helpers,
    forbidden: buildMacStrings(path.resolve(__dirname, '..', '..', '..')),
  });
  for (const p of result.problems) console.error(`✗ ${p}`);
  say(`${result.problems.length ? 'FAILED' : 'verified'}: ${result.machos} Mach-O files, needs macOS ${result.needed}, declares ${result.declared}`);
  process.exit(result.problems.length ? 1 : 0);
}
