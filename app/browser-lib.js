// The built-in browser's everyday logic that needs no Electron (browser-parity.js wires it
// up): the user agent Google sign-in accepts. node --test tests/web/ covers it.
'use strict';

// ── the user agent: Chromium's own, without the app's name and Electron's tokens (Google's
// sign-in refuses a browser that says it's Electron). Nothing else is changed or claimed. ──
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanUserAgent(ua, appName = '') {
  let out = String(ua || '').replace(/\s*\bElectron\/\S+/g, '');
  if (appName) out = out.replace(new RegExp(`\\s*${escapeRe(appName)}/\\S+`, 'g'), '');
  return out.replace(/\s{2,}/g, ' ').trim();
}

module.exports = { cleanUserAgent };
