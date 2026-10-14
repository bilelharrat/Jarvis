// Electron's fuses, flipped in every app this folder builds, before it's signed (audit S7). Left
// as Electron ships them, anything on the Mac could run the signed app as plain Node
// (ELECTRON_RUN_AS_NODE), load code into it (NODE_OPTIONS, --inspect) and so act with every
// permission macOS gave Eden (the microphone, the screen, Full Disk Access), or edit app.asar
// and still have it run under Eden's signature. So:
//   RunAsNode, EnableNodeOptionsEnvironmentVariable, EnableNodeCliInspectArguments: off;
//   GrantFileProtocolExtraPrivileges: off (the app's own file: pages need nothing extra);
//   EnableEmbeddedAsarIntegrityValidation and OnlyLoadAppFromAsar: on, when the app is an
//   app.asar (npm run dist and the Windows builds are; npm run package's own install isn't, so
//   it keeps loading its app folder);
//   EnableCookieEncryption: on (round 1 A6), so the browser's cookies (the owner's sign-ins) are
//   encrypted on disk with a key in the Keychain, not kept as plain text. One way only: the
//   first start of a build with it encrypts the cookies there; a build without it (an older
//   one, put back) can't read them, and those sites ask to sign in again.
// The Ask Eden app (eden/build.js) flips them too.
// The fuses live in the Electron binary, so they're set after packaging and before signing:
// dist.js (the Mac release) and finish-app.sh (npm run package, package:eden-code) call it; on
// Windows electron-builder flips them itself from windowsFuses() (its electronFuses option),
// right before it signs.
//   node scripts/release/fuses.js <the .app>   flips them in a packaged Mac app
'use strict';

const fs = require('fs');
const path = require('path');

// What every build gets (by @electron/fuses' option names, or electron-builder's).
const OFF = ['RunAsNode', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments', 'GrantFileProtocolExtraPrivileges'];
const ON_WITH_ASAR = ['EnableEmbeddedAsarIntegrityValidation', 'OnlyLoadAppFromAsar'];
const ON = ['EnableCookieEncryption'];

// The fuse config for @electron/fuses' flipFuses.
function fuseConfig({ asar, darwin = false, fuses = require('@electron/fuses') }) {
  const { FuseV1Options, FuseVersion } = fuses;
  const config = { version: FuseVersion.V1, resetAdHocDarwinSignature: Boolean(darwin) };
  for (const name of OFF) config[FuseV1Options[name]] = false;
  for (const name of ON) config[FuseV1Options[name]] = true;
  if (asar) for (const name of ON_WITH_ASAR) config[FuseV1Options[name]] = true;
  return config;
}

// electron-builder's electronFuses for the Windows builds (always an app.asar).
function windowsFuses() {
  const camel = (name) => name[0].toLowerCase() + name.slice(1);
  return Object.fromEntries([...OFF.map((n) => [camel(n), false]), ...[...ON, ...ON_WITH_ASAR].map((n) => [camel(n), true])]);
}

// Whether a packaged Mac app is an app.asar.
const macAsar = (app, exists = fs.existsSync) => exists(path.join(app, 'Contents', 'Resources', 'app.asar'));

// Flips them in a packaged Mac app (before it's signed: the old signature is gone after).
async function flipMacApp(app, { flipFuses = require('@electron/fuses').flipFuses, exists = fs.existsSync, fuses } = {}) {
  if (!exists(app)) throw new Error(`no app at ${app}`);
  const asar = macAsar(app, exists);
  await flipFuses(app, fuseConfig({ asar, darwin: true, ...(fuses ? { fuses } : {}) }));
  return { asar };
}

module.exports = { fuseConfig, windowsFuses, flipMacApp, macAsar, OFF, ON, ON_WITH_ASAR };

if (require.main === module) {
  const app = process.argv[2];
  flipMacApp(path.resolve(app || '')).then(({ asar }) => {
    console.log(`Fuses flipped in ${app}: no run-as-Node, NODE_OPTIONS or --inspect${asar ? '; app.asar integrity checked, and only it loaded' : ' (not an app.asar: its folder still loads)'}`);
  }).catch((err) => { console.error(`fuses: ${err.message}`); process.exit(1); });
}
