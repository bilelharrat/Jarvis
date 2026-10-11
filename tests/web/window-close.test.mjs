// The main window's close (app/window-close.js): the close button hides it, a quit closes
// it, and an update's quitAndInstall really closes it (CH2-3: Electron closes the windows
// before before-quit, so without before-quit-for-update the close became a hide and the
// update never installed). node --test tests/web/
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { hideOnClose, quitForUpdate } = require('../../app/window-close.js');

function fakeWindow() {
  const w = new EventEmitter();
  w.hidden = false;
  w.closed = false;
  w.hide = () => { w.hidden = true; };
  w.close = () => {
    let prevented = false;
    w.emit('close', { preventDefault: () => { prevented = true; } });
    if (!prevented) w.closed = true;
  };
  return w;
}

// Squirrel.Mac as Electron drives it: before-quit-for-update, then every window is closed,
// and only once they all have does it install (and before-quit comes after that).
function fakeSquirrel(windows) {
  const s = new EventEmitter();
  s.installed = false;
  s.quitAndInstall = () => {
    s.emit('before-quit-for-update');
    windows.forEach((w) => w.close());
    if (windows.every((w) => w.closed)) s.installed = true;
  };
  return s;
}

function app() {
  let quitting = false;
  const win = fakeWindow();
  hideOnClose(win, () => quitting);
  const auto = fakeSquirrel([win]);
  return { win, auto, quit: () => { quitting = true; }, wire: () => quitForUpdate(auto, () => { quitting = true; }) };
}

test('the close button hides the window; the app keeps running', () => {
  const { win } = app();
  win.close();
  assert.equal(win.hidden, true);
  assert.equal(win.closed, false);
});

test('a quit (before-quit) closes it', () => {
  const { win, quit } = app();
  quit();
  win.close();
  assert.equal(win.closed, true);
  assert.equal(win.hidden, false);
});

test('an update installing closes the window, so the update installs', () => {
  const { win, auto, wire } = app();
  wire();
  auto.quitAndInstall();
  assert.equal(win.closed, true);
  assert.equal(auto.installed, true);
});

test('without before-quit-for-update, quitAndInstall only hid the window (the bug)', () => {
  const { win, auto } = app();
  auto.quitAndInstall();
  assert.equal(win.hidden, true);
  assert.equal(auto.installed, false);
});

test('main.js uses both: the close handler and the update quit', () => {
  const main = readFileSync(new URL('../../app/main.js', import.meta.url), 'utf8');
  assert.match(main, /hideOnClose\(win, \(\) => quitting\)/);
  assert.match(main, /quitForUpdate\(require\('electron'\)\.autoUpdater, \(\) => \{[^}]*quitting = true;/);
  assert.doesNotMatch(main, /win\.on\('close', \(event\) => \{\s*if \(!quitting\)/); // the old one, which ignored updates
});

// CH3-1: an install that fails after the windows closed. Squirrel says so with an error after before-quit-for-update,
// and no quit follows: before, the app ran on with no window, quitting stuck (a backend that stopped was never started
// again), a Dock click threw "Object has been destroyed" and a second launch did nothing.
function failingSquirrel(windows) {
  const s = fakeSquirrel(windows);
  s.quitAndInstall = () => {
    s.emit('before-quit-for-update');
    windows.forEach((w) => w.close());
    if (windows.every((w) => w.closed)) s.emit('error', new Error('ShipIt: code signature did not match'));
  };
  return s;
}

test('an update whose install fails undoes the quit, so the app carries on (CH3-1)', () => {
  let quitting = false;
  const win = fakeWindow();
  hideOnClose(win, () => quitting);
  const auto = failingSquirrel([win]);
  const failed = [];
  quitForUpdate(auto, () => { quitting = true; }, (err) => { failed.push(err.message); quitting = false; });
  auto.quitAndInstall();
  assert.equal(win.closed, true); // the windows did close for it…
  assert.deepEqual(failed, ['ShipIt: code signature did not match']); // …and main.js is told it didn't install
  assert.equal(quitting, false);
  // a failed check or download (no quit under way) is the updater's alone: nothing to undo
  auto.emit('error', new Error('offline'));
  assert.equal(failed.length, 1);
  // a second try that fails again is undone again
  const again = fakeWindow();
  hideOnClose(again, () => quitting);
  const auto2 = failingSquirrel([again]);
  quitForUpdate(auto2, () => { quitting = true; }, () => { failed.push('again'); quitting = false; });
  auto2.quitAndInstall();
  auto2.quitAndInstall();
  assert.deepEqual(failed.slice(1), ['again', 'again']);
});

test('main.js puts a window back after a failed install, and the Dock and a second launch make one when it was closed (CH3-1)', () => {
  const main = readFileSync(new URL('../../app/main.js', import.meta.url), 'utf8');
  const undo = main.slice(main.indexOf("quitForUpdate(require('electron').autoUpdater"), main.indexOf('} catch { /* no updater on this platform */ }'));
  assert.match(undo, /\(err\) => \{[\s\S]*quitting = false;[\s\S]*quitAsked = false;[\s\S]*if \(win && win\.isDestroyed\(\)\) reopenWindow\(\);[\s\S]*fs\.rmSync\(HIDDEN_MARK\(\), \{ force: true \}\)/);
  // Electron tries the install again at every later quit (seen live, Electron 44): a failure then belongs to that quit,
  // which goes on: no window back, quitting left set
  assert.match(undo, /if \(quitStarted\) \{[^\n]*return; \}\n[^\n]*\n\s+quitting = false;/);
  assert.match(main, /quitting = true;\n\s+quitStarted = true;/);
  // the Dock: a destroyed window is never shown (that threw), a new one is made
  assert.doesNotMatch(main, /app\.on\('activate', \(\) => win && win\.show\(\)\);/);
  assert.match(main, /app\.on\('activate', \(\) => \{\n\s+if \(win && win\.isDestroyed\(\)\) \{ if \(!quitting\) reopenWindow\(\); return; \}/);
  // a second launch the same
  const second = main.slice(main.indexOf("app.on('second-instance'"), main.indexOf('// jarvis:// links'));
  assert.match(second, /if \(win && win\.isDestroyed\(\) && !quitting\) \{ reopenWindow\(\); return; \}/);
  // the new window opens on the backend still running, else starts one
  const reopen = main.slice(main.indexOf('function reopenWindow()'), main.indexOf('function summon()'));
  assert.match(reopen, /createWindow\(\);[\s\S]*if \(backend \|\| sharedFrom\) loadApp\(\);\n\s+else openOnBackend\(\)/);
});
