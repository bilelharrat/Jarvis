// A page that stays open (the iPhone app keeps its web view for days; a browser tab, the Mac app)
// keeps running the code it loaded. Coming back to it, at most every 5 minutes, it asks the server
// whether index.html or a script or stylesheet it names changed since this page loaded; if so it reloads by itself
// when nothing would be lost (no reply streaming, an empty composer, not talking), and otherwise
// offers "Eden was updated · Reload" (iOS sweep 2026-10-09, A3 / C5).
//
// Also, in the iPhone and iPad app only: the page's text follows the system text size (A7).

import { el } from './util.js';
import { state } from './state.js';
import { isMock, apiUrl } from './api.js';
import { textHash, stampOf, stampChanged, updateAction, buildStampOf, UPDATE_CHECK_MS } from './resilience.js';

// The page itself and every script and stylesheet index.html names on this server (a module that
// only app.js imports isn't looked at: a deploy changes app.js or app.css nearly always).
function FILES() {
  const out = { page: location.href.split('#')[0] };
  for (const tag of document.querySelectorAll('script[src], link[rel="stylesheet"][href]')) {
    try {
      const u = new URL(tag.getAttribute(tag.tagName === 'LINK' ? 'href' : 'src'), document.baseURI);
      if (u.origin === location.origin) out[u.pathname] = u.href;
    } catch { /* not a URL */ }
  }
  return out;
}

/** One file's stamp: its ETag or Last-Modified (a HEAD), else a hash of its text. Null when it can't be read. */
async function stampFile(url) {
  if (!url) return null;
  try {
    const head = await fetch(url, { method: 'HEAD', cache: 'no-store', credentials: 'same-origin' });
    if (head.ok) { const s = stampOf(head.headers); if (s) return s; }
    const res = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return null;
    return stampOf(res.headers) || `h:${textHash(await res.text())}`;
  } catch { return null; }
}
// One request for the whole deploy where the server has a build stamp (GET /api/chat/build: Eden's
// server on the Mac; askeden.com once its Worker answers it): iOS sweep AI9 (33 HEADs a look) and
// C6 (a module only app.js imports). A server without the route (404, or an answer with no stamp: an
// older server): the per-file look, for this page's life. No answer, or a passing error (5xx, 429): nothing
// to compare this time, and the next look waits longer (AW2-11: a blip no longer means 33 HEADs a look).
let perFile = false, fails = 0, retryAt = 0;
const BACKOFF_MAX_MS = 60 * 60_000;
function failed() {
  fails += 1;
  retryAt = Date.now() + Math.min(BACKOFF_MAX_MS, UPDATE_CHECK_MS * 2 ** fails);
  return null;
}
async function buildStamp() {
  try {
    const res = await fetch(apiUrl('/api/chat/build'), { cache: 'no-store', credentials: 'same-origin', headers: { 'x-jarvis-chat': '1' } });
    if (res.status === 429 || res.status >= 500) return failed();
    const stamp = res.ok ? buildStampOf(await res.json().catch(() => null)) : null;
    if (!stamp) { perFile = true; return null; }
    fails = 0;
    return stamp;
  } catch { return failed(); }
}
async function stampAll() {
  if (!perFile) {
    const b = await buildStamp();
    if (b) return { build: b };
    if (!perFile) return {};
  }
  const f = FILES();
  const out = {};
  await Promise.all(Object.keys(f).map(async (k) => { out[k] = await stampFile(f[k]); }));
  return out;
}

let boot = null, lastLook = 0, looking = null, offered = false;
let newer = false; // the server has a newer build than this page (and a reload would fetch it)

// The build this page was made from, when the server wrote it in (askeden.com: <meta name="eden-build">, by the
// site's sync-eden.mjs; the Worker's GET /api/chat/build answers the same stamp). Compared from the first look,
// so a deploy between this page's load and that look is caught too (AW2-1). Without it (the Mac's server):
// the stamp of the first look.
function pageBuild() {
  const m = document.querySelector('meta[name="eden-build"]');
  return m ? buildStampOf({ build: m.getAttribute('content') }) : null;
}
// A reload for a build that still came back as the old page (a cache in the way): not reloaded again for it.
const RELOADED_KEY = 'eden:reloaded-for';
function reloadedFor(build) {
  try { return sessionStorage.getItem(RELOADED_KEY) === build; } catch { return false; }
}
function reloadFor(now) {
  try { if (now.build) sessionStorage.setItem(RELOADED_KEY, now.build); } catch { /* no storage: reload anyway */ }
  reloadPage();
}
/**
 * The page again, as a navigation (AI2-3): WebKit's location.reload() revalidates every script and stylesheet (117
 * requests answered 304 in the iPhone app after a deploy, on files askeden.com caches for a year as immutable); a
 * navigation takes the unchanged ones from the cache and fetches the page and the changed ones. A page with a #…
 * reloads as before (going to the same address with it would only scroll).
 */
export function reloadPage() {
  if (location.hash) location.reload();
  else location.replace(location.href.split('#')[0]);
}

// What counts as "something would be lost": the chat page's own look below, or the page's (initPageUpdate({ busy }): Edu, AW3-4).
let busyOf = null;
function busy() {
  if (busyOf) return busyOf();
  const inp = document.getElementById('deck-input');
  const chips = document.getElementById('jc-attach');
  return {
    streaming: state.streams && state.streams.size > 0,
    // AC2-18: also a sent message being edited, a message queued behind a reply, a native dialog that is open
    draft: !!((inp && inp.value.trim()) || (chips && chips.childElementCount)
      || [...document.querySelectorAll('textarea[data-edit]')].some((t) => String(t.value || '').trim())
      || (state.convs || []).some((c) => (c.queue || []).some((q) => q.state === 'queued'))
      || document.querySelector('dialog[open]')),
    talking: document.documentElement.classList.contains('talking') || !!document.querySelector('#talk:not([hidden])'),
  };
}

function offer() {
  if (offered) return;
  offered = true;
  const bar = el('div', { class: 'eden-updated', role: 'status' },
    el('span', '', 'Eden was updated'),
    el('button', { type: 'button', class: 'cap primary', onclick: reloadPage }, 'Reload'),
    el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Not now', title: 'Not now', onclick: () => bar.remove() }, '×'));
  document.body.append(bar);
}

function look(force = false) {
  if (looking) return looking; // (one look at a time: a second asker waits for the same answer)
  if (!boot || document.hidden || offered) return Promise.resolve();
  if (!force && (Date.now() - lastLook < UPDATE_CHECK_MS || Date.now() < retryAt)) return Promise.resolve();
  lastLook = Date.now();
  looking = (async () => {
    const now = await stampAll();
    if (!Object.values(now).some(Boolean)) return; // nothing learned this time (offline, a passing error)
    // nothing known at boot (offline), or a different kind of stamp from now on (the per-file look): from now on
    if (!Object.keys(now).some((k) => boot[k] && now[k])) { boot = now; return; }
    if (!stampChanged(boot, now)) return;
    if (now.build && reloadedFor(now.build)) { boot = now; return; } // reloaded for this build once already
    newer = true;
    if (updateAction(busy()) === 'reload') reloadFor(now);
    else offer();
  })().finally(() => { looking = null; });
  return looking;
}

/**
 * Looks now (mail-lazy.js, when Mail's modules failed to load: a deploy since this page loaded is one reason; AM2-2).
 * True when the server has a newer build than this page: it reloads by itself when nothing would be lost, and
 * otherwise the caller offers the reload (a module of the new build next to this page's old ones fails to link,
 * "does not provide an export named …", every time until the page reloads: AI2-1).
 */
export async function checkForUpdate() {
  await look(true).catch(() => {});
  return newer;
}

/* ---------- the system text size, in the app ---------- */

// WebKit's `-apple-system-body` font follows the iOS text size (17px at the default size). The page
// is laid out in px, so its text is scaled with text-size-adjust by that ratio (0.85–1.6: past that
// the phone layout would no longer fit; VoiceOver users zoom further with the system zoom).
function followTextSize() {
  const root = document.documentElement;
  if (!root.classList.contains('eden-app')) return;
  const probe = el('span', { style: { font: '-apple-system-body', position: 'absolute', visibility: 'hidden' } }, 'x');
  document.body.append(probe);
  const px = parseFloat(getComputedStyle(probe).fontSize) || 17;
  probe.remove();
  const scale = Math.max(0.85, Math.min(1.6, px / 17));
  root.style.setProperty('--eden-text-scale', scale.toFixed(3));
  root.style.webkitTextSizeAdjust = root.style.textSizeAdjust = `${Math.round(scale * 100)}%`;
  root.classList.toggle('eden-big-text', scale > 1.15);
}

/**
 * Starts the look (app.js; edu-app.js, AW3-4). `busy`, for a page that isn't the chat page: () => ({ streaming, draft,
 * talking }), when true the page offers the reload instead of reloading by itself.
 */
export function initPageUpdate({ busy: pageBusy = null } = {}) {
  if (typeof pageBusy === 'function') busyOf = pageBusy;
  // the app adds .eden-app after the first scripts run (app.js lockZoom): look once it's there too
  followTextSize();
  if (!document.documentElement.classList.contains('eden-app')) {
    const mo = new MutationObserver(() => { if (document.documentElement.classList.contains('eden-app')) { mo.disconnect(); followTextSize(); } });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  }
  if (isMock) return; // the sample page has no deploys
  const built = pageBuild();
  if (built) {
    // the build the page was made from: the first look (a little after boot, off the first paint's path)
    // compares with it, so a deploy that landed meanwhile reloads the page (AW2-1)
    boot = { build: built };
    setTimeout(() => look(true), 4000);
  } else {
    // the stamp as loaded (a little after boot, off the first paint's path)
    setTimeout(() => { stampAll().then((s) => { boot = s; lastLook = Date.now(); }); }, 4000);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { followTextSize(); look(); } });
  addEventListener('pageshow', (e) => { if (e.persisted) { followTextSize(); look(true); } });
}
