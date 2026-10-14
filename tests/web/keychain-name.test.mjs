// The cookies' encryption key's name (app/keychain-name.js, REL-11): fixed per profile, never the
// app's display name, so Eden Daredevil reads Eden Secretary's cookies and a rename signs nobody
// out. node --test tests/web/
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { FLAVORS } = require('../../app/flavor.js');
const { keychainName, keychainItem, pinKeychainName } = require('../../app/keychain-name.js');

function fakeApp(name) {
  const app = new EventEmitter();
  app.names = [name];
  app.getName = () => app.names.at(-1);
  app.setName = (n) => app.names.push(n);
  return app;
}

test('editions that share a profile share a key name, whatever they are called', () => {
  assert.equal(keychainName(FLAVORS.jarvis), keychainName(FLAVORS.daredevil));
  assert.notEqual(FLAVORS.jarvis.name, FLAVORS.daredevil.name);
  assert.equal(keychainName(FLAVORS['eden-code']), 'Eden Code');
  // a rename of the app's display name leaves the key where it was
  assert.equal(keychainName({ ...FLAVORS.jarvis, name: 'Eden Assistant' }), 'J.A.R.V.I.S.');
  assert.deepEqual(keychainItem(FLAVORS.daredevil, 'darwin'), {
    service: 'J.A.R.V.I.S. Safe Storage',
    account: 'J.A.R.V.I.S. Key',
  });
  assert.deepEqual(keychainItem(FLAVORS.daredevil, 'win32'), { service: '', account: '' });
});

test('Daredevil goes by the key name while the browser starts, then by its own again', () => {
  const app = fakeApp(FLAVORS.daredevil.name);
  pinKeychainName(app, FLAVORS.daredevil, 'darwin');
  assert.equal(app.getName(), 'J.A.R.V.I.S.'); // what Electron reads for the Keychain item
  app.emit('will-finish-launching');
  assert.equal(app.getName(), 'Eden Daredevil');
  app.emit('ready');
  assert.deepEqual(app.names, ['Eden Daredevil', 'J.A.R.V.I.S.', 'Eden Daredevil']);
});

test('nothing changes where the names agree, or on Windows (its key is in the profile)', () => {
  const same = fakeApp('Eden Code');
  pinKeychainName(same, FLAVORS['eden-code'], 'darwin');
  assert.deepEqual(same.names, ['Eden Code']);
  const win = fakeApp('Eden Daredevil');
  pinKeychainName(win, FLAVORS.daredevil, 'win32');
  assert.deepEqual(win.names, ['Eden Daredevil']);
  const linux = fakeApp('Eden Daredevil');
  pinKeychainName(linux, FLAVORS.daredevil, 'linux');
  assert.equal(linux.getName(), 'J.A.R.V.I.S.');
});

// What the last shipped builds (0.1.8, read from the installed J.A.R.V.I.S.app's app.asar:
// productName "J.A.R.V.I.S.", flavors named "J.A.R.V.I.S." / "J.A.R.V.I.S. Daredevil" with no
// keyName, Daredevil on J.A.R.V.I.S.'s profile; Eden Code "Eden Code" on its own) kept their
// cookies under. An upgrade must find both the same profile folder and the same key, or it
// signs the owner out of every site (REL3-15).
const SHIPPED = {
  jarvis: { profile: 'J.A.R.V.I.S.', key: 'J.A.R.V.I.S.' },
  daredevil: { profile: 'J.A.R.V.I.S.', key: 'J.A.R.V.I.S.' },
  'eden-code': { profile: 'Eden Code', key: 'Eden Code' },
};

test('every edition keeps the profile folder and cookie key the last shipped build used', () => {
  const main = readFileSync(new URL('../../app/main.js', import.meta.url), 'utf8');
  // the profile main.js gives a flavor: Eden Code's own, else userDataName, else Electron's
  // default, which follows app.setName(FLAVOR.name)
  const profile = (f) => (f.id === 'eden-code' ? 'Eden Code' : f.userDataName || f.name);
  assert.ok(main.includes("if (EDEN_CODE) app.setPath('userData', path.join(app.getPath('appData'), 'Eden Code'))"));
  assert.ok(main.includes("if (FLAVOR.userDataName) app.setPath('userData', path.join(app.getPath('appData'), FLAVOR.userDataName))"));
  for (const [id, was] of Object.entries(SHIPPED)) {
    assert.equal(profile(FLAVORS[id]), was.profile, `${id}'s profile folder`);
    assert.equal(keychainName(FLAVORS[id]), was.key, `${id}'s cookie key`);
  }
  assert.deepEqual(keychainItem(FLAVORS.jarvis, 'darwin'), { service: 'J.A.R.V.I.S. Safe Storage', account: 'J.A.R.V.I.S. Key' });
});

test('main.js pins it once the profile folder is resolved, before the app is ready', () => {
  const main = readFileSync(new URL('../../app/main.js', import.meta.url), 'utf8');
  const lock = main.indexOf('app.requestSingleInstanceLock()');
  const pin = main.indexOf("require('./keychain-name').pinKeychainName(app, FLAVOR)");
  const setName = main.indexOf('app.setName(FLAVOR.name)');
  assert.ok(lock > 0 && pin > lock && setName > 0 && setName < lock);
  assert.ok(pin < main.indexOf('app.whenReady()') || main.indexOf('app.whenReady()') < 0);
});
