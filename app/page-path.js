// The app's own pages (loading.html, hand-hud.html, popout.html), served from inside app.asar
// on a scheme of the app's own: eden-app://app/<page>.
//
// A packaged build is one app.asar with Electron's GrantFileProtocolExtraPrivileges fuse off
// (fuses.js, audit S7), and with that fuse off a file:// address goes to Chromium's own file
// handler, which can't read inside an asar: every first load of app.asar/loading.html failed
// (ERR_FILE_NOT_FOUND, -6). Round 3 kept the pages as real files beside the asar
// (app.asar.unpacked) instead, which put them outside the asar's integrity check (S3-4): a
// rewritten loading.js there ran in the window, with preload.js and every IPC the window has.
// Now they stay inside the asar, covered by its integrity check, and this module serves them:
// the main process reads them (Electron's fs reads an asar, checked), and only the names in
// PAGES, nothing else of the app's folder. The window's privileged IPC (main.js fromWindow)
// also asks that the sender's page be the app's own (its backend's), so a page that isn't,
// this scheme's included, gets none of it.
'use strict';

const fs = require('fs');
const path = require('path');

const SCHEME = 'eden-app';
const HOST = 'app';
const ORIGIN = `${SCHEME}://${HOST}`;

// The files served: the pages and what they load (and the boot-up sound loading.js plays).
const PAGES = ['loading.html', 'loading.css', 'loading.js', 'hand-hud.html', 'hand-hud.css', 'hand-hud.js',
  'popout.html', 'popout.css', 'popout.js', 'daredevil-open.wav'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.wav': 'audio/wav' };

// For protocol.registerSchemesAsPrivileged, before the app is ready: a standard scheme (its
// pages' relative links and CSP 'self' work), secure, and able to stream the boot-up sound.
const PRIVILEGES = [{ scheme: SCHEME, privileges: { standard: true, secure: true, stream: true } }];

// The address of one of the app's pages, with its query (an object of strings).
function pageUrl(name, query = {}) {
  const url = new URL(`${ORIGIN}/${name}`);
  for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, String(value));
  return url.toString();
}

// Whether an address is one of the app's own pages (name: that one only).
function isOwnPage(url, name = '') {
  try {
    const u = new URL(String(url || ''));
    return u.protocol === `${SCHEME}:` && u.host === HOST && (!name || u.pathname === `/${name}`);
  } catch {
    return false;
  }
}

// What a request for url gets: { status, type, body }. Only the files in PAGES, read from dir
// (the app's folder: inside app.asar in a build), never anything else nor anywhere else.
function respond(dir, url, { read = fs.readFileSync } = {}) {
  const missing = { status: 404, type: 'text/plain; charset=utf-8', body: 'Not found' };
  let name;
  try {
    const u = new URL(String(url || ''));
    if (u.protocol !== `${SCHEME}:` || u.host !== HOST) return missing;
    name = decodeURIComponent(u.pathname).replace(/^\//, '');
  } catch {
    return missing;
  }
  if (!PAGES.includes(name)) return missing;
  try {
    return { status: 200, type: TYPES[path.extname(name)] || 'application/octet-stream', body: read(path.join(dir, name)) };
  } catch {
    return missing;
  }
}

// Serves the scheme on the default session (the app's windows'), from dir. After ready.
function serve(protocol, dir) {
  protocol.handle(SCHEME, (request) => {
    const { status, type, body } = respond(dir, request.url);
    return new Response(body, { status, headers: { 'content-type': type, 'x-content-type-options': 'nosniff' } });
  });
}

module.exports = { SCHEME, HOST, ORIGIN, PAGES, PRIVILEGES, pageUrl, isOwnPage, respond, serve };
