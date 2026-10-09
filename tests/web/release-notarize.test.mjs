// Notarizing and packing the downloadable app (app/scripts/release/notarize.js, dmg.js,
// dist.js): Apple's verdict read from notarytool, its log printed on a rejection, the disk
// image's name and checksums. Nothing here reaches Apple: notarytool is a stand-in.
// node --test tests/web/
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const notarize = require('../../app/scripts/release/notarize.js');
const dmg = require('../../app/scripts/release/dmg.js');
const dist = require('../../app/scripts/release/dist.js');

test("notarytool's answer is read from its output", () => {
  assert.deepEqual(notarize.parseSubmission('Conducting pre-submission checks…\n{"id":"abc","status":"Accepted","message":"Processing complete"}\n'),
    { id: 'abc', status: 'Accepted', message: 'Processing complete' });
  assert.equal(notarize.parseSubmission('Error: HTTP status code: 401. Unable to authenticate.'), null);
});

function notarytool(answer, log = 'The binary is not signed with a valid Developer ID certificate.') {
  const calls = [];
  const runner = (command, args) => {
    calls.push([command, ...args]);
    if (args[1] === 'submit') return { status: answer.status === 'Accepted' ? 0 : 1, stdout: `${JSON.stringify(answer)}\n`, stderr: '' };
    if (args[1] === 'log') return { status: 0, stdout: log, stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, runner };
}

test('an accepted submission waits for the verdict with the stored profile', () => {
  const { calls, runner } = notarytool({ id: 'abc', status: 'Accepted' });
  assert.equal(notarize.notarize('/out/J.A.R.V.I.S.zip', 'jarvis', { runner }).id, 'abc');
  assert.deepEqual(calls, [['/usr/bin/xcrun', 'notarytool', 'submit', '/out/J.A.R.V.I.S.zip', '--keychain-profile', 'jarvis', '--wait', '--output-format', 'json']]);
});

test("a rejection prints Apple's log of why and stops the build", () => {
  const { calls, runner } = notarytool({ id: 'def', status: 'Invalid', message: 'Processing complete' });
  const printed = [];
  const error = console.error;
  console.error = (text) => printed.push(String(text));
  try {
    assert.throws(() => notarize.notarize('/out/J.A.R.V.I.S.zip', 'jarvis', { runner }), /didn't notarize J\.A\.R\.V\.I\.S\.zip: Invalid[\s\S]*notarytool log def/);
  } finally {
    console.error = error;
  }
  assert.deepEqual(calls[1], ['/usr/bin/xcrun', 'notarytool', 'log', 'def', '--keychain-profile', 'jarvis']);
  assert.match(printed.join('\n'), /not signed with a valid Developer ID/);
});

test("a submission notarytool couldn't make says so", () => {
  const runner = () => ({ status: 1, stdout: '', stderr: 'Error: No Keychain password item found for profile: jarvis' });
  assert.throws(() => notarize.notarize('/out/x.dmg', 'jarvis', { runner }), /couldn't submit x\.dmg:[\s\S]*No Keychain password item/);
});

test('stapling staples, then validates', () => {
  const calls = [];
  notarize.staple('/out/J.A.R.V.I.S.app', { runner: (c, args) => { calls.push(args); return { status: 0 }; } });
  assert.deepEqual(calls, [['stapler', 'staple', '/out/J.A.R.V.I.S.app'], ['stapler', 'validate', '/out/J.A.R.V.I.S.app']]);
});

test("the disk image is named for its version, and an ad hoc one can't pass for a release", () => {
  assert.equal(dist.dmgName('0.2.0', false), 'J.A.R.V.I.S.-0.2.0.dmg');
  assert.equal(dist.dmgName('0.2.0', true), 'J.A.R.V.I.S.-0.2.0-adhoc.dmg');
  assert.equal(dist.dmgName('0.2.0', false, 'Eden Code'), 'Eden Code-0.2.0.dmg');
});

test('the checksums are as shasum -a 256 -c reads them', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-sums-'));
  const file = path.join(dir, 'J.A.R.V.I.S.-0.2.0.dmg');
  writeFileSync(file, 'hello\n');
  const lines = dmg.writeChecksums([file], path.join(dir, 'SHA256SUMS.txt'));
  assert.deepEqual(lines, ['5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03  J.A.R.V.I.S.-0.2.0.dmg']);
  assert.equal(readFileSync(path.join(dir, 'SHA256SUMS.txt'), 'utf8'), `${lines[0]}\n`);
});

test('the update feed is https or nothing; the update zip is named for its version', () => {
  assert.equal(dist.updateFeed({}), '');
  assert.equal(dist.updateFeed({ JARVIS_UPDATE_URL: ' https://downloads.example.com/jarvis/release.json ' }), 'https://downloads.example.com/jarvis/release.json');
  assert.throws(() => dist.updateFeed({ JARVIS_UPDATE_URL: 'http://downloads.example.com/release.json' }), /must be an https address/);
  assert.equal(dist.updateZipName('0.2.0'), 'J.A.R.V.I.S.-0.2.0-mac.zip');
});
