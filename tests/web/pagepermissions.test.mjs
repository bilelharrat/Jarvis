// What a page in the built-in browser may have (app/page-permissions.js): node --test tests/web/
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { pagePermission } = require('../../app/page-permissions.js');

test('a page may go full screen and nothing else', () => {
  assert.equal(pagePermission('fullscreen'), true);
  for (const p of ['media', 'geolocation', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'midi', 'midiSysex', 'hid', 'serial', 'usb', 'pointerLock', 'keyboardLock', 'openExternal', 'display-capture', 'mediaKeySystem', 'storage-access', 'window-management', 'unknown', '', undefined]) {
    assert.equal(pagePermission(p), false, String(p));
  }
});

test('the browser asks it for every tab', () => {
  const main = readFileSync(fileURLToPath(new URL('../../app/main.js', import.meta.url)), 'utf8');
  assert.match(main, /setPermissionRequestHandler\(\(_wc, permission, callback\) => callback\(pagePermission\(permission\)\)\)/);
  assert.doesNotMatch(main, /callback\(true\)/);
});
