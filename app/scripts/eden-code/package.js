// npm run package:eden-code: Eden Code, the coding app split out of J.A.R.V.I.S., as an app of
// its own (dist/Eden Code-darwin-arm64/Eden Code.app), for this Mac. The same folder as
// J.A.R.V.I.S. (the backend runs from the repo bake-home.js records), packaged under Eden
// Code's name, bundle id, icon and Info.plist, with flavor.json saying which app it is
// (flavor.js). For other Macs, npm run dist:eden-code builds the signed, self-contained one.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const APP_DIR = path.resolve(__dirname, '..', '..');
const NAME = 'Eden Code';
const BUNDLE_ID = 'com.bshventures.edencode';
const { FLAVOR_IGNORE, bakeFlavor, EDEN_CODE_IGNORE } = require('../release/util');

async function main() {
  const { packager } = await import('@electron/packager');
  const electron = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  fs.rmSync(path.join(APP_DIR, 'flavor.json'), { force: true }); // (one an older build left behind)
  const [folder] = await packager({
    dir: APP_DIR,
    name: NAME,
    platform: 'darwin',
    arch: 'arm64',
    out: path.join(APP_DIR, 'dist'),
    overwrite: true,
    icon: path.join(APP_DIR, 'build', 'eden-code', 'icon.icns'),
    extendInfo: path.join(APP_DIR, 'build', 'eden-code', 'extend-info.plist'),
    appBundleId: BUNDLE_ID,
    electronVersion: electron,
    ignore: [/^\/dist(\/|$)/, /^\/scripts(\/|$)/, /^\/build\/(?!eden-code(\/icon-1024\.png)?$)/, FLAVOR_IGNORE, ...EDEN_CODE_IGNORE],
    // Which app it is (flavor.js), in the copy only: J.A.R.V.I.S. built from this folder stays J.A.R.V.I.S.
    afterCopy: [bakeFlavor('eden-code')],
    quiet: true,
  });
  const app = path.join(folder, `${NAME}.app`);
  execFileSync('sh', [path.join(APP_DIR, 'scripts', 'finish-app.sh')], {
    cwd: APP_DIR, stdio: 'inherit', env: { ...process.env, APP: app, DISPLAY_NAME: NAME },
  });
  return app;
}

module.exports = { main, NAME, BUNDLE_ID };

if (require.main === module) {
  main().then((app) => console.log(`Built ${app}`)).catch((err) => { console.error(err); process.exit(1); });
}
