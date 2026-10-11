// Ask Eden for Mac: the decisions main.js makes, without Electron, so they can be tested
// (tests/web/ask-eden-mac.test.mjs). Bug sweep 2026-10-10 (AJ7–AJ10, AJ13, AJ15, F2, F3, F5, F9, F12).
'use strict';

const os = require('os');
const path = require('path');

// Permissions, the navigation guard, outside links and the offline page: shared with Ask Eden for
// Windows (window-policy.js, the same file in both apps).
const shared = require('./window-policy');

const { HOME_URL, isEdenSite } = shared;

// ── deep links (AJ7) ──

/** askeden://chat/abc?x=1 -> https://askeden.com/chat/abc?x=1; anything off askeden.com is home (F1). */
function deepLinkTarget(link) {
  let target = HOME_URL;
  try { const u = new URL(link); target = new URL(`${u.hostname ? `/${u.hostname}` : ''}${u.pathname === '/' ? '' : u.pathname}${u.search}${u.hash}`, HOME_URL).toString(); } catch { /* home */ }
  return isEdenSite(target) ? target : HOME_URL; // askeden:////evil.com/x resolves to another host
}
/**
 * What a link does now: 'wait' before the app is ready (macOS sends a cold launch's link before
 * `ready`, when no window can be made: it opens once ready), 'open' with no window, else 'load'.
 */
function deepLinkAction({ ready, hasWindow }) {
  if (!ready) return 'wait';
  return hasWindow ? 'load' : 'open';
}

// ── where things are (AJ10) ──

/** The askeden repo next to this one (…/JARVIS V1/app/eden → …/askeden); ASKEDEN_HOME wins. Never ~/askeden, an old copy. */
function askedenHome({ env = process.env, edenDir = __dirname } = {}) {
  return env.ASKEDEN_HOME || path.resolve(edenDir, '..', '..', '..', 'askeden');
}

/** Eden's server to start on this Mac: the app's own copy, ASKEDEN_HOME, then the repo next to this one. */
function edenServerCandidates({ resourcesPath = '', env = process.env, edenDir = __dirname } = {}) {
  return [
    resourcesPath && path.join(resourcesPath, 'eden-server', 'dist', 'ui', 'server.js'),
    path.join(askedenHome({ env, edenDir }), 'dist', 'ui', 'server.js'),
  ].filter(Boolean);
}

/**
 * The J.A.R.V.I.S. repo for `uv run` (when the app has no engine of its own): JARVIS_HOME, a baked
 * jarvis-home.json whose folder still exists, the repo this app runs from, else ~/JARVIS V1.
 * A baked folder that's gone (the project moved) is skipped: it crash-looped the engine (AJ10).
 */
function jarvisHome({ env = process.env, files = [], read, exists, edenDir = __dirname, home = os.homedir() }) {
  if (env.JARVIS_HOME) return env.JARVIS_HOME;
  for (const file of files) {
    let p = '';
    try { p = JSON.parse(read(file)).path; } catch { /* next */ }
    if (typeof p === 'string' && p && exists(p)) return p;
  }
  const repo = path.resolve(edenDir, '..', '..');
  if (exists(path.join(repo, 'pyproject.toml'))) return repo;
  return path.join(home, 'JARVIS V1');
}

// ── restarts with backoff (F3, AJ10, AJ17) ──

/**
 * The wait before starting something again after it stopped: 3 s, 6 s, 12 s… up to 5 minutes;
 * back to 3 s once a run lasted a minute. started() when it starts; next() when it stops.
 */
function createBackoff({ min = 3000, max = 300_000, healthyMs = 60_000, now = Date.now } = {}) {
  let fails = 0;
  let since = 0;
  return {
    started() { since = now(); },
    next() {
      if (since && now() - since >= healthyMs) fails = 0;
      const wait = Math.min(max, min * 2 ** fails);
      fails += 1;
      return wait;
    },
    reset() { fails = 0; },
  };
}

// ── linking this Mac to the signed-in account, automatically (AJ9, AJ13/F5, F12) ──

const LINK_FIRST_MS = 4000;
const LINK_FAST_MS = 15_000; // while this Mac isn't linked
const LINK_SLOW_MS = 15 * 60_000; // once it is: about 100 looks a day instead of 11,500 (F5)
const LINK_ASK_GAP_MS = 60_000; // a new code at most once a minute
const RELINK_GAP_MS = 10_000; // the page's "Try again" (F12)
// AJ2-5: signed out in the window, or signed in too long ago once the sign-in page has been shown,
// a look can't link anything: 15 s, then 1 min, 5 min, 15 min (back to 15 s on a wake, a sign-in,
// "Try again", and a focus at most every 30 minutes: AJ3-11). About 100 askeden.com requests a day
// instead of 5,760–11,660.
const LINK_IDLE_MS = [LINK_FAST_MS, 60_000, 5 * 60_000, 15 * 60_000];
const LINK_REQUEST_MS = 15_000; // AJ2-4: one askeden.com request or engine command at most this long
const LINK_LOOK_REUSE_MS = 10_000; // the look's answer serves the code that follows it (one request, not two)
const LINK_FOCUS_GAP_MS = 30 * 60_000; // AJ3-11: a focus starts the looks over at most this often
const LINK_LOOKING_MS = 60_000; // AJ3-1: the sign-in page or "Try again" this recently, in a window in front: someone is looking

/**
 * The engine's "account_link" command makes a code (as Settings › Account › Link this Mac does);
 * the window's askeden.com session approves it at /api/web/mac-link (as askeden.com/link does),
 * which the server allows only within 10 minutes of the sign-in. When the sign-in is older, the
 * window goes to the sign-in page once per app run, never again on each new code (AJ9), and no new
 * codes are made until a sign-in (AJ2-5). A request that never answers ends at 15 s: the looks go
 * on and the next code is approved (AJ2-4).
 * AJ3-1: once the sign-in page has been shown, or after a code of ours ended (expired, denied), a new
 * code is made only for a sign-in that a look has just found fresh, or while someone is looking (the
 * window in front, and the sign-in page or "Try again" in the last minute). Codes are asked for with
 * {visible: false}: the engine polls askeden.com for them a minute only, and again for a minute once
 * this app has approved one ("account_link_watch").
 *   sendEngine(obj) → bool, webApi(path, method) → { status, body } | null,
 *   openSignIn(code): show the sign-in that returns to /link#code, canRun(): a window and the engine,
 *   isLooking(): the window is visible and focused, onLinked(): this Mac has just been linked.
 */
function createAutoLink({ sendEngine, webApi, openSignIn, canRun = () => true, isLooking = () => false, onLinked = () => {}, now = Date.now, log = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let busy = false;
  let lastAsk = -Infinity;
  let pageOpened = false;
  let linked = false;
  let running = false;
  let timer = null;
  let lastRelink = -Infinity;
  let lastNudge = -Infinity;
  let lastFocus = -Infinity;
  let lastSignInPage = -Infinity;
  let idle = 0; // looks in a row that couldn't link anything
  let lastLook = null; // { at, ready }: the last answer from /api/web/mac-link

  // AJ2-4: a stalled request (sleep, a Wi-Fi change, a captive portal) ends as "no answer"
  const bounded = (p) => new Promise((resolve) => {
    const t = setTimer(() => resolve(null), LINK_REQUEST_MS);
    Promise.resolve(p).then((v) => { clearTimer(t); resolve(v); }, () => { clearTimer(t); resolve(null); });
  });
  const web = (p, method) => bounded(webApi(p, method));
  const engine = (obj) => bounded(sendEngine(obj));
  const nextWait = () => (linked ? LINK_SLOW_MS : LINK_IDLE_MS[Math.min(Math.max(0, idle - 1), LINK_IDLE_MS.length - 1)]);
  const schedule = (ms) => {
    clearTimer(timer);
    timer = running ? setTimer(tick, ms) : null;
  };
  const freshNow = () => (lastLook && now() - lastLook.at < LINK_LOOK_REUSE_MS && lastLook.ready && lastLook.ready.status === 200
    ? Boolean(lastLook.ready.body && lastLook.ready.body.fresh) : null);
  // AJ3-1: the window in front, with the sign-in page or "Try again" just now
  const looking = () => now() - Math.max(lastSignInPage, lastRelink) < LINK_LOOKING_MS && Boolean(isLooking());
  async function look() {
    if (!canRun()) return;
    const ready = await web('/api/web/mac-link');
    lastLook = { at: now(), ready };
    if (!ready || ready.status !== 200) { idle += 1; return; } // signed out here, or no answer
    if (ready.body && ready.body.fresh) idle = 0;
    else if (pageOpened) idle += 1; // the sign-in page was shown: nothing to do until a sign-in
    await engine({ type: 'account' }); // answered with an "account" event (onAccount)
  }
  async function tick() {
    schedule(nextWait()); // set before this look waits on the network (AJ2-4)
    try { await look(); } catch { /* the next look */ }
    if (running) schedule(nextWait());
  }
  async function onAccount(acct) {
    const was = linked;
    linked = Boolean(acct && acct.linked);
    if (linked) idle = 0;
    if (linked && !was) { try { onLinked(); } catch { /* the page looks again by itself */ } } // AJ3-14
    if (was && !linked && running) { idle = 0; schedule(LINK_FAST_MS); } // unlinked: look again soon
    if (linked || busy) return;
    const state = acct.link && acct.link.state;
    const waiting = state === 'waiting' && acct.link.code;
    if (state !== 'waiting' && now() - lastAsk > LINK_ASK_GAP_MS) {
      // AJ2-5 / AJ3-1: no code nobody can approve. After the sign-in page, or once a code of ours has
      // ended (the engine's expiry event asks again), only for a fresh sign-in or someone looking.
      const ended = Boolean(state) && lastAsk > -Infinity;
      if (!(lastLook && lastLook.ready && lastLook.ready.status === 200)) return; // signed out here (or not looked yet): nobody to approve it
      if ((pageOpened || ended) && freshNow() !== true && !looking()) return;
      lastAsk = now();
      await engine({ type: 'account_link', visible: false }); // the engine answers with an "account" event holding the code
      return;
    }
    if (!waiting) return;
    busy = true;
    try {
      const ready = freshNow() !== null ? lastLook.ready : await web('/api/web/mac-link');
      if (!ready || ready.status !== 200) return; // not signed in here yet: tried again later
      if (ready.body && ready.body.fresh) {
        const done = await web(`/api/web/mac-link/${encodeURIComponent(acct.link.code)}/approve`, 'POST');
        log(`mac link: approve -> ${done && done.status}`);
        if (done) await engine({ type: 'account_link_watch' }); // the engine fetches the link now (AJ3-1)
      } else if (!pageOpened) { // signed in too long ago: one click on the page after signing in again
        pageOpened = true;
        lastSignInPage = now();
        openSignIn(acct.link.code);
      }
    } finally { busy = false; }
  }
  const soon = () => {
    if (now() - lastNudge < LINK_FAST_MS) return;
    lastNudge = now();
    schedule(LINK_FIRST_MS);
  };
  return {
    start() { if (running) return; running = true; schedule(LINK_FIRST_MS); },
    stop() { running = false; schedule(0); },
    /** The Mac woke up: look soon. */
    wake() { idle = 0; if (running) schedule(LINK_FIRST_MS); },
    /** The window loaded askeden.com after a sign-in: back to looking every 15 s, and soon. */
    nudge() {
      if (!running || linked) return;
      idle = 0;
      soon();
    },
    /** The window was focused, or loaded askeden.com otherwise: the same, at most every 30 minutes (AJ3-11). */
    focused() {
      if (!running || linked || now() - lastFocus < LINK_FOCUS_GAP_MS) return;
      lastFocus = now();
      idle = 0;
      soon();
    },
    /** The window shows askeden.com's sign-in page (AJ3-1: someone may be about to sign in). */
    signInShown() { lastSignInPage = now(); },
    /** The page's "Try again": a fresh code now, at most once every 10 s (F12). */
    relink() {
      if (now() - lastRelink < RELINK_GAP_MS) return false;
      lastRelink = now();
      lastAsk = -Infinity;
      idle = 0;
      look().catch(() => {});
      return true;
    },
    onAccount,
    state: () => ({ linked, running, pageOpened, idle, scheduled: timer !== null }),
  };
}

/**
 * What a main-window navigation to `url` (from `prev`) says to auto-link: 'signed-in' when it lands on
 * askeden.com from a sign-in (another host, askeden.com's /signin, or on /link), 'focus' for any other
 * askeden.com page, null off askeden.com (AJ3-11: only a sign-in starts the looks over every time).
 */
function linkNudgeFor(prev, url) {
  if (!isEdenSite(url)) return null;
  const pathOf = (u) => { try { return new URL(u).pathname; } catch { return ''; } };
  if (!isEdenSite(prev) || /^\/signin(\/|$)/.test(pathOf(prev)) || /^\/link(\/|$)/.test(pathOf(url))) return 'signed-in';
  return 'focus';
}

// ── quick ask (AJ15, F11) ──

/** Sends at least `gapMs` apart. */
function createGate({ gapMs = 1000, now = Date.now } = {}) {
  let last = -Infinity;
  return () => {
    if (now() - last < gapMs) return false;
    last = now();
    return true;
  };
}

/**
 * The page's own composer: the text in, then the form submitted, as typing it would. AJ2-9: only the
 * page's own submit handler may take it (it prevents the default). Before app.js has set it up, a
 * submit would reload the page to "/?" and lose the text, so that submit is stopped here and the
 * answer is 'not-ready' (the text is kept and sent again shortly).
 */
function quickAskScript(text, homeUrl = HOME_URL) {
  return `new Promise((resolve) => {
  const i = document.getElementById('deck-input'); const f = document.getElementById('deck-composer');
  if (!i || !f || !${JSON.stringify(homeUrl)}.startsWith(location.origin)) { resolve(false); return; }
  i.value = ${JSON.stringify(String(text))};
  i.dispatchEvent(new Event('input', { bubbles: true }));
  setTimeout(() => {
    let taken = false;
    const after = (e) => { if (e.target !== f) return; taken = e.defaultPrevented; if (!taken) e.preventDefault(); };
    window.addEventListener('submit', after); // bubbles here after the page's own handler on the form
    try { f.requestSubmit(); } catch { /* not ready */ }
    window.removeEventListener('submit', after);
    resolve(taken ? true : 'not-ready');
  }, 60);
})`;
}

module.exports = {
  ...shared,
  deepLinkTarget, deepLinkAction, askedenHome, edenServerCandidates,
  jarvisHome, createBackoff, createAutoLink, linkNudgeFor, createGate, quickAskScript,
  LINK_FIRST_MS, LINK_FAST_MS, LINK_SLOW_MS, LINK_ASK_GAP_MS, RELINK_GAP_MS, LINK_IDLE_MS, LINK_REQUEST_MS, LINK_FOCUS_GAP_MS, LINK_LOOKING_MS,
};
