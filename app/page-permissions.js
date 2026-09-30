// What a page in the built-in browser may have without asking: going full screen (a video's
// full-screen button), nothing else. The camera, the microphone, location, notifications,
// the clipboard, MIDI, USB and the rest stay refused until per-site prompts exist.
'use strict';

const ALLOWED = new Set(['fullscreen']);

function pagePermission(permission) {
  return ALLOWED.has(String(permission));
}

module.exports = { pagePermission };
