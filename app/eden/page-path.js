// Ask Eden's own pages (the "Opening Ask Eden…" window and the quick ask), served from inside
// app.asar on a scheme of the app's own: ask-eden-app://app/<page>. The release turns off
// Electron's GrantFileProtocolExtraPrivileges fuse (scripts/release/fuses.js), and with it off a
// file:// address can't read inside an asar (ERR_FILE_NOT_FOUND). The main process reads them
// instead, so they stay covered by the asar's integrity check; only the names in PAGES are served.
'use strict';

const fs = require('fs');
const path = require('path');

const SCHEME = 'ask-eden-app';
const HOST = 'app';
const PAGES = ['loading.html', 'loading.css', 'quick.html'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// For protocol.registerSchemesAsPrivileged, before the app is ready: standard (relative links and
// CSP 'self' work) and secure.
const PRIVILEGES = [{ scheme: SCHEME, privileges: { standard: true, secure: true } }];

const pageUrl = (name) => `${SCHEME}://${HOST}/${name}`;

function isOwnPage(url) {
  try {
    const u = new URL(String(url || ''));
    return u.protocol === `${SCHEME}:` && u.host === HOST;
  } catch {
    return false;
  }
}

// What a request for url gets: only the files in PAGES, read from dir (inside app.asar in a build).
function respond(dir, url, { read = fs.readFileSync } = {}) {
  const missing = { status: 404, type: 'text/plain; charset=utf-8', body: 'Not found' };
  if (!isOwnPage(url)) return missing;
  let name;
  try { name = decodeURIComponent(new URL(url).pathname).replace(/^\//, ''); } catch { return missing; }
  if (!PAGES.includes(name)) return missing;
  try {
    return { status: 200, type: TYPES[path.extname(name)], body: read(path.join(dir, name)) };
  } catch {
    return missing;
  }
}

function serve(protocol, dir) {
  protocol.handle(SCHEME, (request) => {
    const { status, type, body } = respond(dir, request.url);
    return new Response(body, { status, headers: { 'content-type': type } });
  });
}

module.exports = { SCHEME, PAGES, PRIVILEGES, pageUrl, isOwnPage, respond, serve };
