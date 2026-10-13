// What the app's own windows let a page have (audit S6). Left alone, Electron grants every
// permission a page asks for, silently: the microphone, the camera, the location, opening
// another app's link scheme, and the first client certificate in the keychain to any site that
// asks for one. The built-in browser's tabs have Chrome's own prompt (browser-parity.js); the
// two windows that show Eden itself had nothing, so whatever page got into them (a sign-in page,
// an iframe, whatever answered on localhost:5174) had it all.
//
// Here each of those windows' sessions is deny-by-default: a request or a check is answered by
// the window's own policy, a function of the asking page's exact origin, the permission and its
// details, saying 'yes', 'ask' (the owner is asked once, in a box on that window, and a yes holds
// until the app quits) or 'no'. Nothing a policy doesn't name is ever given; opening another
// app's scheme (Electron's 'openExternal', asked when a frame goes to zoommtg:, ms-word: and
// the like) never is, and a sub-frame can't even start going to one (will-frame-navigate). USB,
// HID, serial and Bluetooth pickers never open, and no client certificate is ever sent (the
// app-wide select-client-certificate, which covers every page the app has).
//
// Pure apart from what it's handed (the session, the window's contents, the app): the tests
// give stand-ins.
'use strict';

// Where a sub-frame of one of the app's own windows may go: web pages and the page-made kinds.
const FRAME_SCHEMES = /^(https?|about|data|blob):/i;

// A page's origin as the policies compare it: scheme, host and port exactly (no subdomains),
// 'file://' for the app's own loading page, '' for anything that isn't an address.
function originOf(url) {
  try {
    const u = new URL(String(url || ''));
    if (u.protocol === 'file:') return 'file://';
    return u.origin === 'null' ? '' : u.origin;
  } catch {
    return '';
  }
}

// What a media request wants: 'audio', 'video' or both. Electron gives mediaTypes on a request
// and mediaType on a check; anything it doesn't say counts as both (never the narrower one).
function mediaKinds(details = {}) {
  const kinds = new Set();
  for (const t of Array.isArray(details.mediaTypes) ? details.mediaTypes : []) kinds.add(String(t));
  if (details.mediaType === 'audio' || details.mediaType === 'video') kinds.add(details.mediaType);
  if (!kinds.size) { kinds.add('audio'); kinds.add('video'); }
  return kinds;
}

// Deny-by-default handlers on one session. policy(origin, permission, details) says 'yes',
// 'ask' or 'no'; ask(wc, origin, permission) is the box (a Promise of true or false). Gives
// { granted } (what the owner said yes to this run), for the tests.
function guardSession(ses, { policy, ask = async () => false, log = () => {} }) {
  const granted = new Set(); // `${origin} ${permission}`: yes, for as long as the app runs
  const asking = new Map(); // one box at a time per origin and permission
  const decide = (origin, permission, details) => {
    if (!origin || permission === 'openExternal') return 'no';
    try { return policy(origin, permission, details || {}) || 'no'; } catch { return 'no'; }
  };
  ses.setPermissionRequestHandler((wc, permission, callback, details = {}) => {
    // The asking frame's own address (an iframe asks as itself, not as the page around it).
    const origin = originOf(details.requestingUrl || (wc && !wc.isDestroyed() ? wc.getURL() : ''));
    const answer = decide(origin, permission, details);
    const key = `${origin} ${permission}`;
    if (answer === 'yes' || (answer === 'ask' && granted.has(key))) { callback(true); return; }
    if (answer !== 'ask') {
      log(`window guard: refused ${permission} to ${origin || 'a page with no address'}`);
      callback(false);
      return;
    }
    let pending = asking.get(key);
    if (!pending) {
      pending = Promise.resolve().then(() => ask(wc, origin, permission, details)).then((ok) => ok === true, () => false);
      asking.set(key, pending);
      pending.finally(() => asking.delete(key));
    }
    pending.then((ok) => {
      if (ok) granted.add(key);
      callback(ok);
    });
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details = {}) => {
    const origin = originOf(requestingOrigin || (details && details.requestingUrl) || (wc && !wc.isDestroyed() ? wc.getURL() : ''));
    const answer = decide(origin, permission, details);
    return answer === 'yes' || (answer === 'ask' && granted.has(`${origin} ${permission}`));
  });
  if (ses.setDevicePermissionHandler) ses.setDevicePermissionHandler(() => false);
  if (ses.on) {
    ses.on('select-hid-device', (event, _details, callback) => { event.preventDefault(); callback(); });
    ses.on('select-serial-port', (event, _ports, _wc, callback) => { event.preventDefault(); callback(''); });
    ses.on('select-usb-device', (event, _details, callback) => { event.preventDefault(); callback(); });
  }
  return { granted };
}

// A window's own page: its sub-frames never go to another app's scheme, and it picks no
// Bluetooth device.
function guardContents(wc) {
  wc.on('will-frame-navigate', (event) => {
    if (!event || event.isMainFrame) return; // the window's own will-navigate decides those
    if (!FRAME_SCHEMES.test(String(event.url || ''))) event.preventDefault();
  });
  wc.on('select-bluetooth-device', (event, _devices, callback) => { event.preventDefault(); callback(''); });
}

// The whole app: no client certificate to anyone (Electron sends the first one it finds).
// The built-in browser's tabs also say no to it themselves (browser-parity.js).
function guardApp(app) {
  app.on('select-client-certificate', (event, _wc, _url, _list, callback) => {
    event.preventDefault();
    callback();
  });
}

// What Eden Secretary's (or Eden Code's) window gives its own page, on the app's backend: the
// camera and microphone (hand tracking, Look), notifications, the clipboard, full screen and
// the location the page already asks for. Its loading page and anything else: nothing.
const OWN_PAGE = new Set(['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'geolocation', 'speaker-selection']);
function mainPolicy(appOrigin) {
  return (origin, permission) => (origin && origin === appOrigin() && OWN_PAGE.has(permission) ? 'yes' : 'no');
}

// The Ask Eden window (features/eden-window.js): Eden's page there is trusted(origin) (exactly
// https://askeden.com, or Eden on this Mac once it has proved itself). It may write to the
// clipboard and go full screen; the microphone (Eden's voice input) only after the owner's yes;
// never the camera, the location or anything else, and nothing at all for any other page.
function edenPolicy(trusted) {
  return (origin, permission, details) => {
    if (!trusted(origin)) return 'no';
    if (permission === 'clipboard-sanitized-write' || permission === 'fullscreen') return 'yes';
    if (permission === 'media') {
      const kinds = mediaKinds(details);
      return kinds.size === 1 && kinds.has('audio') ? 'ask' : 'no';
    }
    return 'no';
  };
}

module.exports = { guardSession, guardContents, guardApp, mainPolicy, edenPolicy, originOf, mediaKinds, FRAME_SCHEMES, OWN_PAGE };
