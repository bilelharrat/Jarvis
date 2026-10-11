// The main window's close button hides it: the app keeps running (⌥Space, the Dock). Only a
// quit closes it for real: ⌘Q (before-quit) or an update installing. An update's
// autoUpdater.quitAndInstall() closes every window *before* before-quit comes, so it says
// so first (before-quit-for-update): without that the close was turned into a hide, the
// windows never all closed and the update never installed (CH2-3).
'use strict';

function hideOnClose(win, isQuitting) {
  win.on('close', (event) => {
    if (!isQuitting()) {
      event.preventDefault();
      win.hide();
    }
  });
}

// What an update's quit sets before the windows close: quitting, as before-quit would. When the install then fails
// (Squirrel's error after before-quit-for-update, and no quit follows), the app was left running with every window
// closed and quitting stuck: onFailed undoes it (main.js: quitting off, a window again, CH3-1).
function quitForUpdate(autoUpdater, markQuitting, onFailed = () => {}) {
  let installing = false;
  autoUpdater.on('before-quit-for-update', () => {
    installing = true;
    markQuitting();
  });
  autoUpdater.on('error', (err) => {
    if (!installing) return; // (a check or download that failed: nothing was quitting)
    installing = false;
    onFailed(err);
  });
}

module.exports = { hideOnClose, quitForUpdate };
