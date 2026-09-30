// What a page in the built-in browser may have without asking, as in Chrome: going full
// screen (a video's full-screen button) and writing to the clipboard (a site's Copy button:
// the same a page can already do with document.execCommand('copy')). The camera, the
// microphone, location, notifications and reading the clipboard are asked for per site
// (site-permissions.js); MIDI, USB, HID, serial and everything else stay refused.
'use strict';

const ALLOWED = new Set(['fullscreen', 'clipboard-sanitized-write']);

function pagePermission(permission) {
  return ALLOWED.has(String(permission));
}

module.exports = { pagePermission };
