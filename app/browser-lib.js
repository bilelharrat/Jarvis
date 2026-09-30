// The built-in browser's everyday logic that needs no Electron (browser-parity.js wires it
// up): the user agent Google sign-in accepts; which window.open is a real popup, where it
// goes and what its title bar says; which sign-in request may ask; and which failed load is a
// certificate's. node --test tests/web/ covers it.
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

// ── popups: window.open with window features (a size, popup=1) is a real window with its
// opener, as sign-in and payment pages expect; a link with target=_blank, or window.open
// without features, is a new tab ──
function isPopup(details = {}) {
  const url = String(details.url || '');
  return details.disposition === 'new-window' && /\S/.test(String(details.features || ''))
    && (/^https?:\/\//i.test(url) || url === 'about:blank' || url === '');
}

function hostOf(url) {
  try { return new URL(url).host; } catch { return ''; }
}

function originOfUrl(url) {
  try {
    const u = new URL(String(url || ''));
    return /^https?:$/.test(u.protocol) ? u.origin : '';
  } catch {
    return '';
  }
}

// A popup's title bar names the site it's really on: a page can't pass itself off as another.
function popupTitle(url, title) {
  const host = hostOf(url);
  const own = String(title || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!host) return own;
  return own && own !== host && !own.startsWith(`${host}/`) ? `${host} — ${own}` : host;
}

// Where a popup opens: the size the page asked for (window features), at least big enough to
// use and never past the screen's edge; where the page asked, else centred on the window it
// came from. area and near are { x, y, width, height }.
const POPUP_MIN = { width: 320, height: 240 };
const POPUP_DEFAULT = { width: 500, height: 600 };

function popupBounds(features, area, near = null) {
  const f = {};
  for (const part of String(features || '').split(',')) {
    const at = part.indexOf('=');
    const key = (at < 0 ? part : part.slice(0, at)).trim().toLowerCase();
    if (key) f[key] = at < 0 ? '' : part.slice(at + 1).trim();
  }
  const num = (...keys) => {
    for (const k of keys) {
      const n = Number.parseInt(f[k], 10);
      if (Number.isFinite(n)) return n;
    }
    return null;
  };
  const width = Math.min(area.width, Math.max(POPUP_MIN.width, num('width', 'innerwidth') ?? POPUP_DEFAULT.width));
  const height = Math.min(area.height, Math.max(POPUP_MIN.height, num('height', 'innerheight') ?? POPUP_DEFAULT.height));
  let x = num('left', 'screenx');
  let y = num('top', 'screeny');
  if (x === null || y === null) {
    const c = near || area;
    x = Math.round(c.x + (c.width - width) / 2);
    y = Math.round(c.y + (c.height - height) / 2);
  }
  return {
    x: Math.min(area.x + area.width - width, Math.max(area.x, x)),
    y: Math.min(area.y + area.height - height, Math.max(area.y, y)),
    width,
    height,
  };
}

// ── a site asking for a user name and password (HTTP sign-in): the page's own site, or the
// page a tab is going to, may ask; another site's picture or script inside the page may not
// (Chrome's rule: a sign-in box from a site you didn't open is how passwords get phished).
// A proxy always asks. ──
function authAllowed({ url, page, going, proxy = false } = {}) {
  if (proxy) return true;
  const origin = originOfUrl(url);
  return Boolean(origin) && (origin === originOfUrl(going) || origin === originOfUrl(page));
}

// A sign-in over plain http sends the password as it is (a proxy's too). This Mac and the
// local network aside.
function authInsecure(url) {
  try {
    const u = new URL(String(url || ''));
    if (u.protocol === 'https:') return false;
    return !/^(localhost|127(?:\.\d+){3}|\[::1\]|.*\.localhost)$/i.test(u.hostname);
  } catch {
    return true;
  }
}

// ── certificate errors: net error codes -200 to -299 ──
const isCertError = (code) => Number(code) <= -200 && Number(code) > -300;

// What's wrong with a site's certificate (Chromium's net error names), as a key the window and
// the Mac's box both put in words.
function certProblem(error) {
  const e = String(error || '');
  if (/AUTHORITY_INVALID/.test(e)) return 'authority';
  if (/DATE_INVALID/.test(e)) return 'date';
  if (/COMMON_NAME_INVALID/.test(e)) return 'name';
  if (/REVOKED/.test(e)) return 'revoked';
  if (/WEAK/.test(e)) return 'weak';
  return 'other';
}

module.exports = {
  cleanUserAgent, isPopup, hostOf, originOfUrl, popupTitle, popupBounds, POPUP_MIN,
  authAllowed, authInsecure, isCertError, certProblem,
};
