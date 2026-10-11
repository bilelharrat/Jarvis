// Ask Eden's desktop windows, Mac (JARVIS V1/app/eden) and Windows (Eden Windows/ask-eden): what a page
// may use, where a window may go, which links open outside, what a window shows when askeden.com can't
// be reached. No Electron in here, so it can be tested (JARVIS V1 tests/web/ask-eden-mac.test.mjs,
// Eden Windows ask-eden/test/). The two copies are the same file, and a test checks it: change both.
// Bug sweeps 2026-10-10: AJ8/F9, AJ2-3 (permissions), AJ2-8, AJ3-2…AJ3-5, AJ3-12 (navigation),
// AJ3-3 (downloads), AJ3-10 (links), AJ3-6/AJ3-9 (offline).
'use strict';

const HOME_URL = 'https://askeden.com/';

const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };
const isHttps = (url) => /^https:\/\//i.test(String(url || ''));

const isEdenSite = (url) => {
  try { const u = new URL(url); return u.protocol === 'https:' && (u.hostname === 'askeden.com' || u.hostname.endsWith('.askeden.com')); } catch { return false; }
};

// ── links that open outside the app (AJ3-10) ──

// The user's browser for web pages (http too: never loaded in the app), Mail, the phone, Messages,
// FaceTime, Calendar and the meeting apps for their links. Nothing else (file:, smb:, javascript:, an
// unknown app's scheme).
const OUTSIDE_SCHEMES = new Set(['https:', 'http:', 'mailto:', 'tel:', 'sms:', 'facetime:', 'facetime-audio:', 'webcal:', 'zoommtg:', 'zoomus:', 'msteams:']);
function outsideAllowed(url) {
  try { return OUTSIDE_SCHEMES.has(new URL(String(url)).protocol); } catch { return false; }
}

// ── permissions (AJ8, was F9): Electron grants every permission unless told otherwise ──

// What askeden.com's page uses: the microphone (Dictate, Talk, the tutor: audio only),
// notifications, copy and paste buttons, full screen (slides, the browser panel) and the
// browser panel's keyboard lock; mailto:, tel: and the like open their apps. Nothing for any other page.
const EDEN_PERMISSIONS = new Set(['media', 'notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'keyboardLock', 'openExternal']);

/** Is this serialized origin askeden.com's own ("null" for a sandboxed frame or page: never)? */
const isEdenOrigin = (origin) => typeof origin === 'string' && origin !== 'null' && isEdenSite(origin) && new URL(origin).origin === origin;

/**
 * May the page at `url` have `permission`? `details`: Electron's (mediaTypes on a request,
 * mediaType on a check, externalURL for openExternal), plus `origin`, the requesting frame's own
 * origin (frameOrigin). askeden.com only, and the microphone only. AJ2-3: decided by the frame's
 * origin, not its URL: an artifact, a code runner, a deck or a published page runs in a sandboxed
 * frame or under a CSP sandbox, an opaque origin whose URL is still https://askeden.com/… (Chrome
 * refuses those frames notifications too).
 */
function permissionAllowed(permission, url, details = {}) {
  if (!isEdenSite(url) || !EDEN_PERMISSIONS.has(permission)) return false;
  if (!isEdenOrigin(details.origin)) return false;
  if (permission === 'media') {
    const kinds = Array.isArray(details.mediaTypes) ? details.mediaTypes : details.mediaType ? [details.mediaType] : [];
    return kinds.length > 0 && kinds.every((k) => k === 'audio');
  }
  if (permission === 'openExternal') { // an app's own link (web pages never come this way)
    const ext = String(details.externalURL || '');
    return outsideAllowed(ext) && !/^https?:/i.test(ext);
  }
  return true;
}

/**
 * The origin of the frame asking (AJ2-3): the main frame's own origin, or for a subframe the origin
 * of the frame(s) at that URL ("null" when unknown, or when any of them is opaque). `fallback`: the
 * origin Electron passes to a check made with no page (a service worker).
 */
function frameOrigin(wc, details = {}, fallback = '') {
  try {
    const main = wc && wc.mainFrame;
    if (!main) return fallback || 'null';
    if (details.isMainFrame !== false) return String(main.origin);
    const frames = (main.framesInSubtree || []).filter((f) => f !== main && f.url === details.requestingUrl);
    return frames.length && frames.every((f) => isEdenOrigin(f.origin)) ? String(frames[0].origin) : 'null';
  } catch {
    return 'null';
  }
}

/** Both handlers on a session (Mac and Windows alike): askeden.com's page only, by the asking frame's origin. */
function setPermissions(session) {
  session.setPermissionRequestHandler((wc, permission, callback, details = {}) => {
    callback(permissionAllowed(permission, details.requestingUrl || (wc && wc.getURL()) || '', { ...details, origin: frameOrigin(wc, details) }));
  });
  session.setPermissionCheckHandler((wc, permission, origin, details = {}) => (
    permissionAllowed(permission, details.requestingUrl || origin || (wc && wc.getURL()) || '', { ...details, origin: frameOrigin(wc, details, origin) })));
}

// ── where a window may go (AJ2-8, AJ3-2, AJ3-3, AJ3-5, AJ3-12) ──

// Where Google's and Apple's sign-ins start. A window may always go there.
const SIGN_IN_STARTS = new Set(['accounts.google.com', 'appleid.apple.com']);
// Once a sign-in has started from askeden.com, in that window or pop-up, any https host may follow until
// the window is back on askeden.com, for this long at most: Google's own hops (accounts.youtube.com's
// cookie hop, accounts.google.fr…, www.google.com/accounts/ServiceLogin), Apple's (idmsa.apple.com) and a
// company's own sign-in (Okta, Entra, ADFS… a Workspace or Apple Business account's SSO).
const SIGN_IN_FLOW_MS = 15 * 60_000;
const isSignInStart = (url) => isHttps(url) && SIGN_IN_STARTS.has(hostOf(url));

// askeden.com's download links (/download/mac, /download/windows, /jarvis/download, /eden-code/windows…)
// redirect to a GitHub release, which redirects to GitHub's file servers. Those download in the app.
const isEdenDownloadLink = (url) => {
  if (!isEdenSite(url)) return false;
  return /^\/(downloads?(\/|$)|jarvis\/download\/?$|(eden-code|jarvis|daredevil)\/(windows|download|daredevil)\/?$)/.test(new URL(url).pathname);
};
const isReleaseFile = (url) => {
  if (!isHttps(url)) return false;
  const u = new URL(url);
  if (u.hostname === 'github.com') return /^\/[^/]+\/[^/]+\/releases\/(latest\/)?download\//.test(u.pathname);
  return u.hostname === 'objects.githubusercontent.com' || u.hostname === 'release-assets.githubusercontent.com';
};

/**
 * Where a navigation in an app window goes: 'allow' (stays in the window), 'download' (a release file
 * from askeden.com's download links: downloaded by the app, the window stays put) or 'outside' (the
 * user's browser, or the link's own app). `redirect`: a server redirect, `from` the URL its navigation
 * began at; `inFlow`: a sign-in started from askeden.com is going on in this window.
 */
function navigationAction(url, { inFlow = false, redirect = false, from = '', isHome = isEdenSite } = {}) {
  if (isHome(url) || isSignInStart(url)) return 'allow';
  if (inFlow && isHttps(url)) return 'allow';
  if (redirect && isReleaseFile(url) && isEdenDownloadLink(from)) return 'download';
  return 'outside';
}

// Electron passes an event object with the details (newer) or positional arguments (older): both.
const navDetails = (e, url, isSameDocument, isMainFrame) => ({
  url: String((e && e.url) || url || ''),
  isMainFrame: e && typeof e.isMainFrame === 'boolean' ? e.isMainFrame : isMainFrame !== false,
  isSameDocument: e && typeof e.isSameDocument === 'boolean' ? e.isSameDocument : isSameDocument === true,
});

/**
 * The navigation guard for an app's windows: guard(webContents) on the main window; the pop-ups it
 * opens get their own. openOutside(url) hands a URL to the system; isHome(url): the app's own site.
 * The windows have no URL bar and no Back, so they stay on askeden.com, except for a sign-in started
 * there (above), which ends when the window is back on askeden.com or after SIGN_IN_FLOW_MS.
 */
function createGuard({ openOutside, isHome = isEdenSite, now = Date.now, flowMs = SIGN_IN_FLOW_MS }) {
  const guarded = new WeakSet();
  function guard(wc, { popup = false, opener = '' } = {}) {
    if (!wc || guarded.has(wc)) return; // never two will-navigate handlers on one page
    guarded.add(wc);
    let committed = ''; // the main frame's URL, as last committed
    let navStart = ''; // where the navigation now going on began (a redirect's chain)
    let flowSince = -Infinity;
    const inFlow = () => now() - flowSince < flowMs;
    // a sign-in starts when askeden.com (this window's page, or the page that opened this pop-up) sends it to Google or Apple
    const consider = (url, from) => {
      if (isSignInStart(url) && (isHome(from) || (popup && !committed && isHome(opener)))) flowSince = now();
    };
    const outside = (e, url) => { e.preventDefault(); openOutside(url); };
    wc.on('did-create-window', (child) => guard(child.webContents, { popup: true, opener: wc.getURL() }));
    wc.on('did-start-navigation', (e, url, inPlace, isMain) => {
      const d = navDetails(e, url, inPlace, isMain);
      if (!d.isMainFrame || d.isSameDocument) return;
      consider(d.url, committed);
      navStart = d.url;
    });
    wc.on('will-navigate', (e, url) => {
      const d = navDetails(e, url);
      consider(d.url, committed);
      if (navigationAction(d.url, { inFlow: inFlow(), isHome }) !== 'allow') outside(e, d.url);
    });
    wc.on('will-redirect', (e, url, inPlace, isMain) => {
      const d = navDetails(e, url, inPlace, isMain);
      if (!d.isMainFrame) return;
      consider(d.url, navStart || committed);
      const act = navigationAction(d.url, { inFlow: inFlow(), redirect: true, from: navStart, isHome });
      if (act === 'allow') return;
      e.preventDefault();
      if (act === 'download') wc.downloadURL(d.url); // AJ3-3: Electron's save dialog, as before AJ2-8
      else openOutside(d.url);
    });
    wc.on('did-navigate', (_e, url) => {
      committed = String(url || '');
      if (isHome(committed)) flowSince = -Infinity; // back: the off-site allowance ends (AJ3-12)
    });
    wc.setWindowOpenHandler(({ url }) => {
      if (isHome(url) || isSignInStart(url)) return { action: 'allow' }; // a sign-in pop-up
      openOutside(url);
      return { action: 'deny' };
    });
  }
  return guard;
}

// ── askeden.com can't be reached (AJ3-6, AJ3-9) ──

const OFFLINE_DELAYS_MS = [5000, 10_000, 20_000, 40_000, 60_000];

/**
 * A window whose page didn't load: show(url, ms) puts up the offline page, retry(url) loads the page
 * again after 5 s, 10 s, 20 s, 40 s, then every minute; retryNow() (Reload, a wake) at once.
 * loaded() once the page is there.
 */
function createOfflineRetry({ show, retry, setTimer = setTimeout, clearTimer = clearTimeout, delays = OFFLINE_DELAYS_MS }) {
  let failedUrl = '';
  let fails = 0;
  let timer = null;
  const stop = () => { if (timer !== null) clearTimer(timer); timer = null; };
  return {
    failed(url) {
      failedUrl = url;
      stop();
      const ms = delays[Math.min(fails, delays.length - 1)];
      fails += 1;
      show(url, ms);
      timer = setTimer(() => { timer = null; retry(failedUrl); }, ms);
    },
    loaded() { failedUrl = ''; fails = 0; stop(); },
    /** Load the page that failed now: false when nothing failed. */
    retryNow() {
      if (!failedUrl) return false;
      stop();
      retry(failedUrl);
      return true;
    },
    failedUrl: () => failedUrl,
  };
}

/** Which page to try again after a main-frame load failed (null: not one to handle). */
function offlineTarget(url, { code, isMainFrame = true, isHome = isEdenSite } = {}) {
  if (!isMainFrame || code === -3 || !/^https?:\/\//i.test(String(url || ''))) return null; // -3: aborted (a download, a redirect stopped)
  return isHome(url) ? String(url) : HOME_URL;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The offline page, as a data: URL: what happened, when it tries again, and a Try again button. */
function offlinePageUrl({ name = 'Ask Eden', url = HOME_URL, seconds = 5, site = hostOf(url) || 'askeden.com' } = {}) {
  const target = JSON.stringify(String(url)).replace(/</g, '\\u003c');
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escapeHtml(name)}</title>
<style>:root{color-scheme:light dark;--bg:#f5f5f7;--fg:#1d1d1f;--mute:#6e6e73;--btn:#0e2747;--btnfg:#fff}
@media (prefers-color-scheme:dark){:root{--bg:#161618;--fg:#f5f5f7;--mute:#a1a1a6;--btn:#f5f5f7;--btnfg:#161618}}
body{font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:var(--bg);color:var(--fg);display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:460px;padding:24px}h1{font-size:20px;margin:0 0 8px}p{color:var(--mute);line-height:1.5}
button{font:inherit;font-weight:600;border:0;border-radius:8px;padding:8px 16px;background:var(--btn);color:var(--btnfg);cursor:pointer}</style>
<main role="alert"><h1>${escapeHtml(name)} can’t reach ${escapeHtml(site)}</h1>
<p>Check your internet connection. <span id="when">Trying again in ${Math.max(1, Math.round(seconds))} s.</span></p>
<button id="again" type="button" autofocus>Try again</button></main>
<script>(function(){var u=${target},s=${Math.max(1, Math.round(seconds))},w=document.getElementById('when');
function go(){w.textContent='Trying again…';location.replace(u);}
document.getElementById('again').onclick=go;addEventListener('online',go);
setInterval(function(){if(s>1){s-=1;w.textContent='Trying again in '+s+' s.';}},1000);})();</script></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

module.exports = {
  HOME_URL, isEdenSite, isEdenOrigin, EDEN_PERMISSIONS, permissionAllowed, frameOrigin, setPermissions,
  OUTSIDE_SCHEMES, outsideAllowed,
  SIGN_IN_STARTS, SIGN_IN_FLOW_MS, isSignInStart, isEdenDownloadLink, isReleaseFile, navigationAction, createGuard,
  OFFLINE_DELAYS_MS, createOfflineRetry, offlineTarget, offlinePageUrl,
};
