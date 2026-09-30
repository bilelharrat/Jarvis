// What a page in the built-in browser may have without asking (app/page-permissions.js):
// node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { pagePermission } = require('../../app/page-permissions.js');

test('a page may go full screen and write to the clipboard without asking, and nothing else', () => {
  assert.equal(pagePermission('fullscreen'), true);
  assert.equal(pagePermission('clipboard-sanitized-write'), true);
  for (const p of ['media', 'geolocation', 'notifications', 'clipboard-read', 'midi', 'midiSysex', 'hid', 'serial', 'usb', 'pointerLock', 'keyboardLock', 'openExternal', 'display-capture', 'mediaKeySystem', 'storage-access', 'window-management', 'unknown', '', undefined]) {
    assert.equal(pagePermission(p), false, String(p));
  }
});

test('every browser session asks the per-site policy, and no handler grants outright', () => {
  const read = (f) => readFileSync(fileURLToPath(new URL(`../../app/${f}`, import.meta.url)), 'utf8');
  const parity = read('browser-parity.js');
  assert.match(parity, /ses\.setPermissionRequestHandler\(\(wc, permission, callback, details = \{\}\) => \{\n\s+this\.request\(perms, wc, permission, details\)/);
  assert.match(parity, /ses\.setPermissionCheckHandler\(/);
  assert.match(parity, /ses\.setDevicePermissionHandler\(\(\) => false\)/);
  assert.match(read('site-permissions.js'), /if \(pagePermission\(permission\)\) return Promise\.resolve\(true\);/);
  for (const f of ['main.js', 'browser-parity.js', 'site-permissions.js']) assert.doesNotMatch(read(f), /callback\(true\)/, f);
  assert.match(read('main.js'), /parity\.wireTab\(view\)/);
});
