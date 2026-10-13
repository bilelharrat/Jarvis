// The app's own windows are deny-by-default (app/window-guards.js, audit S6): a stand-in session
// and page get the handlers, and each is asked what Electron would ask. Also the three IPC
// channels that took anyone's word (S32), read from main.js's source since it runs in Electron.
// node --test tests/web/
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const guards = require('../../app/window-guards.js');
const MAIN = readFileSync(new URL('../../app/main.js', import.meta.url), 'utf8');

function fakeSession() {
  const ses = new EventEmitter();
  ses.setPermissionRequestHandler = (fn) => { ses.request = fn; };
  ses.setPermissionCheckHandler = (fn) => { ses.check = fn; };
  ses.setDevicePermissionHandler = (fn) => { ses.device = fn; };
  return ses;
}
const page = (url) => ({ getURL: () => url, isDestroyed: () => false });
const ask = (ses, wc, permission, details = {}) => new Promise((resolve) => ses.request(wc, permission, resolve, details));

test('the main window: its own page on the backend gets what it uses; the loading page and anything else, nothing', async () => {
  const ses = fakeSession();
  let port = 51234;
  guards.guardSession(ses, { policy: guards.mainPolicy(() => (port ? `http://127.0.0.1:${port}` : '')) }); // as main.js does
  const own = page(`http://127.0.0.1:${port}/?token=abc`);
  assert.equal(await ask(ses, own, 'media', { mediaTypes: ['video'], requestingUrl: own.getURL() }), true, 'the camera, for hand tracking');
  assert.equal(await ask(ses, own, 'notifications'), true);
  assert.equal(await ask(ses, own, 'openExternal', { externalURL: 'zoommtg://x' }), false, 'never another app’s scheme');
  assert.equal(await ask(ses, own, 'midiSysex'), false, 'nothing the page doesn’t use');
  // an iframe inside the app's page asks as itself
  assert.equal(await ask(ses, own, 'media', { requestingUrl: 'https://evil.example/frame' }), false);
  assert.equal(await ask(ses, page('file:///app/loading.html'), 'media'), false);
  assert.equal(await ask(ses, page('http://127.0.0.1:9999/'), 'media'), false, 'another port is another origin');
  assert.equal(ses.check(own, 'media', `http://127.0.0.1:${port}`, { mediaType: 'audio' }), true);
  assert.equal(ses.check(own, 'geolocation', 'https://askeden.com', {}), false);
  port = 0; // no backend yet: nobody is the app's page
  assert.equal(await ask(ses, page('http://127.0.0.1:0/'), 'media'), false);
  assert.equal(ses.device({ deviceType: 'usb' }), false);
  let picked = 'unset';
  ses.emit('select-usb-device', { preventDefault() {} }, {}, (id) => { picked = id; });
  assert.equal(picked, undefined, 'no USB device is ever picked');
});

test('the Ask Eden window: the microphone only for Eden’s exact origin, and only after the owner’s yes', async () => {
  const ses = fakeSession();
  const asked = [];
  let answer = false;
  const trusted = (origin) => origin === 'https://askeden.com';
  const { granted } = guards.guardSession(ses, { policy: guards.edenPolicy(trusted), ask: async (_wc, origin, permission) => { asked.push([origin, permission]); return answer; } });
  const eden = page('https://askeden.com/');
  const mic = { mediaTypes: ['audio'], requestingUrl: 'https://askeden.com/' };
  assert.equal(ses.check(eden, 'media', 'https://askeden.com', { mediaType: 'audio' }), false, 'not before the yes');
  assert.equal(await ask(ses, eden, 'media', mic), false, 'a no is a no');
  answer = true;
  assert.equal(await ask(ses, eden, 'media', mic), true);
  assert.equal(asked.length, 2);
  assert.equal(await ask(ses, eden, 'media', mic), true, 'a yes holds for the run');
  assert.equal(asked.length, 2, 'without asking again');
  assert.ok(granted.has('https://askeden.com media'));
  assert.equal(ses.check(eden, 'media', 'https://askeden.com', { mediaType: 'audio' }), true);
  assert.equal(await ask(ses, eden, 'media', { mediaTypes: ['audio', 'video'], requestingUrl: 'https://askeden.com/' }), false, 'never the camera');
  assert.equal(await ask(ses, eden, 'media', { requestingUrl: 'https://askeden.com/' }), false, 'unsaid kinds count as the camera too');
  assert.equal(await ask(ses, eden, 'geolocation'), false);
  assert.equal(await ask(ses, eden, 'clipboard-sanitized-write'), true);
  for (const url of ['https://chat.askeden.com/', 'https://accounts.google.com/', 'http://localhost:5174/', 'http://askeden.com/']) {
    assert.equal(await ask(ses, page(url), 'media', { mediaTypes: ['audio'], requestingUrl: url }), false, url);
  }
  assert.equal(asked.length, 2, 'nobody else is even asked about');
});

test('a sub-frame never goes to another app’s scheme; no Bluetooth device, no client certificate', () => {
  const wc = new EventEmitter();
  guards.guardContents(wc);
  const go = (url, isMainFrame = false) => { let stopped = false; wc.emit('will-frame-navigate', { url, isMainFrame, preventDefault: () => { stopped = true; } }); return stopped; };
  assert.equal(go('zoommtg://zoom.us/join?x'), true);
  assert.equal(go('ms-word:ofe|u|https://x'), true);
  assert.equal(go('file:///etc/passwd'), true);
  assert.equal(go('https://www.youtube.com/embed/x'), false);
  assert.equal(go('about:blank'), false);
  assert.equal(go('jarvis://anything', true), false, 'the main frame is the window’s own will-navigate’s');
  let device = 'unset';
  wc.emit('select-bluetooth-device', { preventDefault() {} }, [{ deviceId: 'a' }], (id) => { device = id; });
  assert.equal(device, '');
  const app = new EventEmitter();
  guards.guardApp(app);
  let prevented = false;
  let cert = 'unset';
  app.emit('select-client-certificate', { preventDefault: () => { prevented = true; } }, {}, 'https://x', [{ subjectName: 'me' }], (c) => { cert = c; });
  assert.equal(prevented, true);
  assert.equal(cert, undefined, 'no certificate is sent');
});

test('origins are compared exactly', () => {
  assert.equal(guards.originOf('https://askeden.com/x?y'), 'https://askeden.com');
  assert.equal(guards.originOf('file:///Applications/x/loading.html'), 'file://');
  assert.equal(guards.originOf('nonsense'), '');
  assert.equal(guards.originOf('data:text/html,x'), '');
});

test('main.js guards both its windows’ sessions and the app, and its three loose channels check the sender (S32)', () => {
  assert.match(MAIN, /guards\.guardApp\(app\)/);
  assert.match(MAIN, /guards\.guardSession\(win\.webContents\.session, \{\s*policy: guards\.mainPolicy/);
  assert.match(MAIN, /guards\.guardContents\(win\.webContents\)/);
  assert.match(MAIN, /ipcMain\.handle\('a11y:supported', \(event\) => \(fromWindow\(event\)/);
  assert.match(MAIN, /ipcMain\.handle\('jarvis:pick-folder', async \(event\) => \{\s*if \(!fromWindow\(event\)\) return null;/);
  assert.match(MAIN, /ipcMain\.on\('jarvis:attention', \(event\) => \{\s*if \(!fromWindow\(event\)\) return;/);
});
