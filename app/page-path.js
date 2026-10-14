// Where the app's own pages are loaded from (loading.html, hand-hud.html, popout.html). A packaged
// build is one app.asar with Electron's GrantFileProtocolExtraPrivileges fuse off (fuses.js, audit
// S7), and with that fuse off a file:// address goes to Chromium's own file handler, which can't
// read inside an asar: every first load of app.asar/loading.html failed (ERR_FILE_NOT_FOUND, -6)
// and the window showed Chromium's error page until the app's page came (round 3: in app.log at
// every launch). So the builds keep those pages as real files beside the asar
// (app.asar.unpacked: PAGES, dist.js and windows.js), and a page inside an asar is loaded from
// there. Anywhere else (npm start, a build that isn't an asar) the path is as it was.
'use strict';

const fs = require('fs');
const path = require('path');

// The pages and what they load, kept outside app.asar in a packaged build.
const PAGES = ['loading.html', 'loading.css', 'loading.js', 'hand-hud.html', 'hand-hud.css', 'hand-hud.js',
  'popout.html', 'popout.css', 'popout.js'];

// The path to load for one of the app's pages, dir being where it is in the app's folder.
function pagePath(dir, name, { exists = fs.existsSync } = {}) {
  const inside = path.join(dir, name);
  const parts = inside.split(path.sep);
  const at = parts.lastIndexOf('app.asar');
  if (at < 0) return inside;
  const outside = [...parts.slice(0, at), 'app.asar.unpacked', ...parts.slice(at + 1)].join(path.sep);
  return exists(outside) ? outside : inside;
}

module.exports = { pagePath, PAGES };
