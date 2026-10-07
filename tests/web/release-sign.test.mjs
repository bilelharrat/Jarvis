// Signing the downloadable app (app/scripts/release/sign.js, verify.js, dist.js): which
// entitlements each piece gets and why, the inside-out order, what verify refuses, and the
// credentials the Developer ID build insists on. codesign itself runs only in
// `npm run dist -- --adhoc`; these use made-up bundles. node --test tests/web/
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const sign = require('../../app/scripts/release/sign.js');
const verify = require('../../app/scripts/release/verify.js');
const dist = require('../../app/scripts/release/dist.js');

const temp = () => mkdtempSync(path.join(tmpdir(), 'jarvis-sign-'));
const touch = (file, data = '') => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, data); };
const keys = (kind, adhoc = false) => sign.entitlementKeys(kind, adhoc).sort();
const JIT = 'com.apple.security.cs.allow-jit';
const MIC = 'com.apple.security.device.audio-input';
const CAMERA = 'com.apple.security.device.camera';
const EVENTS = 'com.apple.security.automation.apple-events';
const LOCATION = 'com.apple.security.personal-information.location';
const CALENDARS = 'com.apple.security.personal-information.calendars';
const CONTACTS = 'com.apple.security.personal-information.addressbook';

test('each piece of the app gets the entitlements it uses, found by where it is', () => {
  assert.equal(sign.entitlementsFor(''), 'app');
  assert.equal(sign.entitlementsFor('Contents/Frameworks/J.A.R.V.I.S Helper.app'), 'helper');
  assert.equal(sign.entitlementsFor('Contents/Frameworks/J.A.R.V.I.S Helper (Renderer).app'), 'renderer');
  assert.equal(sign.entitlementsFor('Contents/Frameworks/J.A.R.V.I.S Helper (GPU).app'), 'gpu');
  assert.equal(sign.entitlementsFor('Contents/Frameworks/J.A.R.V.I.S Helper (Plugin).app'), 'plugin');
  assert.equal(sign.entitlementsFor('Contents/Resources/backend/python/bin/python3.12'), 'python');
  const helpers = { 'jarvis-duplex': 'microphone', 'jarvis-player': null };
  assert.equal(sign.entitlementsFor('Contents/Resources/helpers/jarvis-duplex', helpers), 'microphone');
  assert.equal(sign.entitlementsFor('Contents/Resources/helpers/jarvis-player', helpers), null);
  assert.equal(sign.entitlementsFor('Contents/Resources/helpers/jarvis-unknown', helpers), null);
  for (const rel of ['Contents/Frameworks/Electron Framework.framework', 'Contents/Resources/backend/python/lib/python3.12/site-packages/numpy/_core/_umath.so',
    'Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt']) assert.equal(sign.entitlementsFor(rel), null, rel);
});

test('what each entitlement file grants, and nothing more', () => {
  assert.deepEqual(keys('app'), [EVENTS, JIT, MIC, CAMERA, CALENDARS, CONTACTS, LOCATION].sort());
  assert.deepEqual(keys('python'), [EVENTS, MIC, CALENDARS, CONTACTS, LOCATION].sort()); // no JIT: Python needs none
  assert.deepEqual(keys('helper'), [JIT, MIC, CAMERA].sort()); // Chromium's capture services run there
  for (const kind of ['renderer', 'gpu', 'plugin']) assert.deepEqual(keys(kind), [JIT], kind);
  assert.deepEqual(keys('microphone'), [MIC]);
  assert.deepEqual(keys(null), []);
  for (const kind of ['app', 'helper', 'renderer', 'gpu', 'plugin', 'python', 'microphone']) {
    assert.equal(keys(kind).includes(sign.DLV), false, `${kind}: library validation stays on when signed with the Developer ID`);
  }
});

test('ad hoc, only what loads its own libraries turns library validation off', () => {
  for (const kind of ['app', 'helper', 'renderer', 'gpu', 'plugin', 'python']) {
    assert.ok(keys(kind, true).includes(sign.DLV), kind);
    assert.deepEqual(keys(kind, true).filter((k) => k !== sign.DLV), keys(kind), kind);
  }
  assert.deepEqual(keys('microphone', true), [MIC]); // a Swift helper loads only macOS's own libraries
  assert.deepEqual(keys(null, true), []);
});

test('programs of the app keep an identifier of its own; libraries their file name', () => {
  assert.equal(sign.identifierFor('Contents/Resources/backend/python/bin/python3.12'), 'com.bshventures.jarvis.python');
  assert.equal(sign.identifierFor('Contents/Resources/helpers/jarvis-hear'), 'com.bshventures.jarvis.jarvis-hear');
  assert.equal(sign.identifierFor('Contents/Resources/backend/python/lib/python3.12/lib-dynload/_crypt.cpython-312-darwin.so'), null);
});

// A made-up app: its main executable, a framework, a helper app, Python, a helper and the
// Claude engine, each a (tiny) Mach-O.
const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0x00, 0x00, 0x01, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
function infoPlist(executable) {
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>${executable}</string></dict></plist>`;
}
function fakeApp() {
  const app = path.join(temp(), 'J.A.R.V.I.S.app');
  touch(path.join(app, 'Contents', 'Info.plist'), infoPlist('J.A.R.V.I.S'));
  touch(path.join(app, 'Contents', 'MacOS', 'J.A.R.V.I.S'), MACHO);
  const fw = path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework');
  touch(path.join(fw, 'Versions', 'A', 'Resources', 'Info.plist'), infoPlist('Electron Framework'));
  touch(path.join(fw, 'Versions', 'A', 'Electron Framework'), MACHO);
  touch(path.join(fw, 'Versions', 'A', 'Libraries', 'libffmpeg.dylib'), MACHO);
  touch(path.join(fw, 'Versions', 'A', 'Helpers', 'chrome_crashpad_handler'), MACHO);
  symlinkSync('A', path.join(fw, 'Versions', 'Current'));
  symlinkSync('Versions/Current/Electron Framework', path.join(fw, 'Electron Framework'));
  symlinkSync('Versions/Current/Resources', path.join(fw, 'Resources'));
  const helper = path.join(app, 'Contents', 'Frameworks', 'J.A.R.V.I.S Helper (Renderer).app');
  touch(path.join(helper, 'Contents', 'Info.plist'), infoPlist('J.A.R.V.I.S Helper (Renderer)'));
  touch(path.join(helper, 'Contents', 'MacOS', 'J.A.R.V.I.S Helper (Renderer)'), MACHO);
  const py = path.join(app, 'Contents', 'Resources', 'backend', 'python');
  touch(path.join(py, 'bin', 'python3.12'), MACHO);
  symlinkSync('python3.12', path.join(py, 'bin', 'python3'));
  touch(path.join(py, 'lib', 'python3.12', 'site-packages', 'numpy', '_core', '_umath.so'), MACHO);
  touch(path.join(py, 'lib', 'python3.12', 'site-packages', 'claude_agent_sdk', '_bundled', 'claude'), MACHO);
  touch(path.join(py, 'lib', 'python3.12', 'site-packages', 'jarvis', 'web', 'app.js'), 'not code');
  touch(path.join(app, 'Contents', 'Resources', 'helpers', 'jarvis-duplex'), MACHO);
  touch(path.join(app, 'Contents', 'Resources', 'helpers', 'jarvis-duplex.sha256'), 'abc\n');
  return app;
}

test('signing goes inside out: files, then the bundles holding them, the app last', () => {
  const app = fakeApp();
  const { items, kept } = sign.plan(app, { helperEntitlements: { 'jarvis-duplex': 'microphone' } });
  const order = items.map((i) => i.rel);
  assert.equal(order.at(-1), '');
  const at = (rel) => order.indexOf(rel);
  const fw = 'Contents/Frameworks/Electron Framework.framework';
  for (const inner of [`${fw}/Versions/A/Libraries/libffmpeg.dylib`, `${fw}/Versions/A/Helpers/chrome_crashpad_handler`]) {
    assert.ok(at(inner) >= 0 && at(inner) < at(fw), inner);
  }
  // A bundle's main executable is signed with its bundle, never on its own.
  for (const main of ['Contents/MacOS/J.A.R.V.I.S', `${fw}/Versions/A/Electron Framework`, 'Contents/Frameworks/J.A.R.V.I.S Helper (Renderer).app/Contents/MacOS/J.A.R.V.I.S Helper (Renderer)']) {
    assert.equal(at(main), -1, main);
  }
  assert.deepEqual(kept, ['Contents/Resources/backend/python/lib/python3.12/site-packages/claude_agent_sdk/_bundled/claude']);
  const byRel = Object.fromEntries(items.map((i) => [i.rel, i]));
  assert.equal(byRel['Contents/Resources/backend/python/bin/python3.12'].kind, 'python');
  assert.equal(byRel['Contents/Resources/helpers/jarvis-duplex'].kind, 'microphone');
  assert.equal(byRel['Contents/Frameworks/J.A.R.V.I.S Helper (Renderer).app'].kind, 'renderer');
  assert.equal(byRel[fw].bundle, true);
  assert.equal(byRel['Contents/Resources/backend/python/lib/python3.12/site-packages/numpy/_core/_umath.so'].kind, null);
  assert.equal(order.some((rel) => rel.endsWith('app.js') || rel.endsWith('.sha256') || rel.endsWith('bin/python3')), false);
});

test('a link that leads out of the app is caught', () => {
  const app = fakeApp();
  assert.deepEqual(verify.strayLinks(app), []);
  symlinkSync('/Users/someone/jarvis/app/node_modules', path.join(app, 'Contents', 'Resources', 'node_modules'));
  symlinkSync('../../../../outside', path.join(app, 'Contents', 'Resources', 'helpers', 'escape'));
  assert.deepEqual(verify.strayLinks(app).sort(), [
    'Contents/Resources/helpers/escape -> ../../../../outside',
    'Contents/Resources/node_modules -> /Users/someone/jarvis/app/node_modules',
  ]);
});

test("the build Mac's paths are found anywhere in the app, text or binary", () => {
  const app = fakeApp();
  assert.deepEqual(verify.findStrings(app, ['/Users/owner-home', '/Users/owner-home/jarvis']), []);
  touch(path.join(app, 'Contents', 'Resources', 'app', 'jarvis-home.json'), '{"path": "/Users/owner-home/jarvis"}');
  touch(path.join(app, 'Contents', 'Resources', 'helpers', 'jarvis-look'), Buffer.concat([MACHO, Buffer.from('\0/Users/owner-home/x\0')]));
  assert.deepEqual(verify.findStrings(app, ['/Users/owner-home']).sort(), [
    'Contents/Resources/app/jarvis-home.json: /Users/owner-home',
    'Contents/Resources/helpers/jarvis-look: /Users/owner-home',
  ]);
});

test('the Developer ID build names what it needs before doing anything; --adhoc needs nothing', () => {
  assert.throws(() => dist.credentials({}, { adhoc: false }), /JARVIS_SIGN_IDENTITY[\s\S]*JARVIS_NOTARY_PROFILE[\s\S]*--adhoc/);
  assert.throws(() => dist.credentials({ JARVIS_SIGN_IDENTITY: 'Developer ID Application: X (8CV4X23Y2T)' }, { adhoc: false }), (err) => /JARVIS_NOTARY_PROFILE/.test(err.message) && !/JARVIS_SIGN_IDENTITY:/.test(err.message));
  assert.deepEqual(dist.credentials({ JARVIS_SIGN_IDENTITY: ' ABC ', JARVIS_NOTARY_PROFILE: 'jarvis' }, { adhoc: false }), { identity: 'ABC', profile: 'jarvis' });
  assert.deepEqual(dist.credentials({}, { adhoc: true }), { identity: '-', profile: '' });
  assert.deepEqual(dist.parseArgs(['--adhoc']), { adhoc: true });
  assert.throws(() => dist.parseArgs(['--deep']), /unknown option --deep/);
});
