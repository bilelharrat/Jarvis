// The name the browser's cookie and storage encryption key is kept under (REL-11), pinned so it
// never follows the app's display name.
//
// Electron 44 names that key after the app's name as it is when the browser starts: on macOS the
// Keychain item "<name> Safe Storage" (account "<name> Key"), read in
// ElectronBrowserMainParts::PostCreateMainMessageLoop; on Linux the secret store's "<name> Safe
// Storage" (BrowserProcessImpl, as the threads are made). Both happen after main.js's first,
// synchronous run and before the app is ready; Windows keeps its key in the profile's Local State,
// whatever the name. So an edition whose display name differs from the profile's owner (Eden
// Daredevil shares Eden Secretary's profile) couldn't read the cookies the other wrote, and any
// rename of the app would sign the owner out of every site. The flavor's keyName (flavor.js) is
// set as the app's name for that moment only; the display name comes back at
// will-finish-launching, which on macOS comes with the main loop's first run and on Linux once
// the threads are made, after the key's name has been read, and before anything is shown.
'use strict';

/** The name the encryption key goes by for this flavor: its keyName, else its display name. */
function keychainName(flavor) {
  return (flavor && (flavor.keyName || flavor.name)) || '';
}

/** Electron's names for the key, as it makes them on this platform ('' where it doesn't). */
function keychainItem(flavor, platform = process.platform) {
  const name = keychainName(flavor);
  if (platform === 'darwin') return { service: `${name} Safe Storage`, account: `${name} Key` };
  if (platform === 'linux') return { service: `${name} Safe Storage`, account: name };
  return { service: '', account: '' };
}

/** Pin the key's name: the app goes by flavor.keyName until will-finish-launching, then by its
 * display name again. Called once main.js has resolved its profile folder (the single-instance
 * lock), so no default path is ever worked out from the key's name. Returns the restore. */
function pinKeychainName(app, flavor, platform = process.platform) {
  const key = keychainName(flavor);
  const shown = app.getName();
  if (!key || key === shown || (platform !== 'darwin' && platform !== 'linux')) return () => {};
  app.setName(key);
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    app.setName(shown);
  };
  app.once('will-finish-launching', restore);
  app.once('ready', restore); // (in case a platform says it's ready without the first)
  return restore;
}

module.exports = { keychainName, keychainItem, pinKeychainName };
