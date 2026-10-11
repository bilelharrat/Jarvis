// Mail, Compose and Calendar load when first used, not at startup (askeden opt1-ae-web): mail.js,
// compose.js, calendar.js and mailkit.js with their helpers are about 480 KB of the page, and most
// visits never open them. This small module stands in for them from boot, under the same names:
//
// - it keeps the handlers app.js gives them (initMail, initCalendar) and hands them over on the load;
// - opening one (the palette, a deep link like /#open=mail or /#gmail=connected, Eden's tools, a
//   meeting's action item, a notification, ⌘K, the Mail panel) loads all four at once, then opens it;
// - an email being written when the page closed loads them at boot, so its window comes back as before;
// - after the page knows where it runs (mailMetaReady, was initSignatures + initMailkit): on the Mac,
//   signatures and Mail's settings are fetched when Mail loads (Eden's server keeps them); on askeden.com
//   their end-to-end synced items join the sync at once, as before (a sync pass skips an item no module
//   has joined, so a late join would miss another device's change): the signatures' from the small
//   mail-signatures.js, Mail's settings by loading mailkit.js alone, after startup.
import { el, store, toast } from './util.js';
import { state } from './state.js';
import { syncItem } from './sync.js';
import { signaturesSyncItem } from './mail-signatures.js';

// The storage keys the real modules use (the tests read them from compose.js and calendar.js).
export const KEYS = {
  composeOpen: 'eden:compose:open', // compose.js K.open: emails being written when the page closed
  calendarReturn: 'eden:cal:return', // calendar.js RETURN_KEY (sessionStorage)
};

const H = { mail: null, calendar: null };
let mods = null; // { mail, compose, calendar, mailkit } once loaded
let loading = null;
let metaReady = false;
let sigsJoined = false, kitJoined = false; // initSignatures / initMailkit done
let teamPending = null;

/**
 * Mail, Compose, Calendar and Mail's settings, loaded once, through mail-bundle.js. A failed load (e.g. offline) is tried
 * again next time, under a new address: the browser keeps a failed module import, so asking for the same one again
 * failed at once, for the page's life (AC2-7). A second failure while online offers a reload.
 */
let attempt = 0;
let bundle = null; // the import of mail-bundle.js (the modules fetched and run, nothing started yet)
const bundleAt = (n) => (n ? `${new URL('./mail-bundle.js', import.meta.url).href}?retry=${n}` : './mail-bundle.js');
function fetchBundle() {
  return (bundle ??= import(bundleAt(attempt)).catch((e) => { bundle = null; attempt++; throw e; }));
}
export function loadMail() {
  return (loading ??= fetchBundle().then(({ mail, compose, calendar, mailkit }) => {
    mods = { mail, compose, calendar, mailkit };
    if (H.calendar) calendar.initCalendar(H.calendar);
    if (H.mail) mail.initMail(H.mail); // and Compose's (initCompose: its sources, the emails being written)
    if (metaReady) mailData();
    if (teamPending) { mail.queueTeamOpen(teamPending); teamPending = null; }
    composeReady(mods);
    return mods;
  }).catch((e) => {
    loading = null;
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (offline) {
      updated = null;
      toast('You seem to be offline, so Mail and Calendar couldn’t load. Eden tries again when you open them.');
    } else {
      // a deploy since this page loaded (new modules next to this page's old ones: "does not provide an export named …")
      // fails this way too, every time: page-update compares the build now, and reloads when nothing would be lost; or
      // else the toast and Mail's panel offer the reload, not a Try again that fails the same way (AM2-2, AI2-1)
      const second = attempt > 1;
      updated = Promise.race([
        import('./page-update.js').then((m) => m.checkForUpdate()).then((v) => v === true, () => false),
        new Promise((r) => setTimeout(() => r(false), 4000)), // (no answer: as if not updated)
      ]);
      updated.then((newer) => {
        if (newer) toast(UPDATED, { label: 'Reload', run: reloadPage });
        else if (second) toast(`Mail and Calendar still couldn’t load (${e.message}). Reload the page to try again.`, { label: 'Reload', run: () => location.reload() });
        else toast(`Couldn’t load that part of Eden (${e.message}). Eden tries again when you open it.`);
      });
    }
    throw e;
  }));
}
/** After a failed load while online: whether this page is older than the server's build (AI2-1). */
let updated = null;
const UPDATED = 'Eden was updated since this page opened. Reload it to open Mail and Calendar.';
const reloadPage = () => import('./page-update.js').then((m) => m.reloadPage(), () => location.reload());
const later = (fn) => loadMail().then(fn, () => {});

/**
 * The four modules fetched while the page is idle after startup (AM2-2): startup stays as small as before, and the first
 * Mail, Compose or Calendar open no longer waits for the download. Only fetched: nothing starts (no Gmail status, no
 * mail kit) until one is used. Not on a connection that asks to save data; a failure here is silent (the open says it).
 */
const idle = (fn) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 10_000 }) : setTimeout(fn, 2000));
let preloadAsked = false;
export function preloadMail() {
  if (preloadAsked || mods) return;
  preloadAsked = true;
  if (typeof navigator !== 'undefined' && navigator.connection && navigator.connection.saveData) return;
  idle(() => { if (!mods && !loading) fetchBundle().catch(() => {}); });
}

/** "Opening …" when a first open takes a moment (AM2-5): the modules are still loading. */
function opening(what) {
  const t = setTimeout(() => toast(`Opening ${what}…`), 300);
  return () => clearTimeout(t);
}
/** Compose's sources and signatures known (at most 1.5 s): the first window picks Gmail and its signature (AM2-3). */
let composeSettled = false, composeWait = null;
function composeReady(m) {
  const ready = Promise.all([m.compose.composeReady ? m.compose.composeReady() : null, sigsLoad]).catch(() => {});
  return (composeWait ??= Promise.race([ready, new Promise((r) => setTimeout(r, 1500))]).then(() => { composeSettled = true; }));
}

/* ---------- boot ---------- */

export function initMail(handlers) {
  H.mail = handlers;
  if (mods) { mods.mail.initMail(handlers); return; }
  const open = store.get(KEYS.composeOpen, []);
  if (Array.isArray(open) && open.length) loadMail().catch(() => {}); // the emails being written come back, minimised
}
export function initCalendar(handlers) {
  H.calendar = handlers;
  if (mods) { mods.calendar.initCalendar(handlers); return; }
  // a Google sign-in that didn't finish: don't reopen the calendar on the next one (from Mail)
  if (/#gmail=error/.test(location.hash)) { try { sessionStorage.removeItem(KEYS.calendarReturn); } catch { /* private mode */ } }
}

/** Signatures and Mail's settings, each once, from the loaded modules. */
let sigsLoad = null; // the Mac's signatures (initSignatures), for the first Compose window
function mailData() {
  if (!sigsJoined) { sigsJoined = true; sigsLoad = Promise.resolve(mods.compose.initSignatures()).catch(() => {}); }
  if (!kitJoined) { kitJoined = true; mods.mailkit.initMailkit(); }
}
/** After the page knows where it runs (state.meta): the Mac's server is asked when Mail loads; askeden.com's synced items join now. */
export function mailMetaReady() {
  if (metaReady) return;
  metaReady = true;
  if (mods) { mailData(); return; }
  preloadMail();
  if (!(state.meta && state.meta.hosted)) return;
  sigsJoined = true;
  syncItem(signaturesSyncItem); // what compose.js initSignatures does here
  import('./mailkit.js').then((mk) => { if (!kitJoined) { kitJoined = true; mk.initMailkit(); } }, () => { /* offline: when Mail loads */ });
}

/* ---------- Compose ---------- */

export function openCompose(opts = {}) {
  if (mods && composeSettled) { mods.compose.openCompose(opts); return; }
  const done = mods ? () => {} : opening('a new email');
  later((m) => composeReady(m).then(() => m.compose.openCompose(opts))).finally(done);
}

/* ---------- Calendar ---------- */

// An open asked for before the calendar loaded: closing it (Esc, closeCalendar) meanwhile cancels it, so the calendar
// doesn't pop open seconds later and take focus (AM2-5).
let calWanted = 0, calTokens = 0, calOpening = () => {};
const calCancel = () => { calWanted = 0; calOpening(); listenEsc(false); };
const calEsc = (e) => { if (e.key === 'Escape' && calWanted) calCancel(); };
const listenEsc = (on) => { if (typeof addEventListener === 'function') (on ? addEventListener : removeEventListener)('keydown', calEsc, true); };
export function openCalendar(opts = {}) {
  if (mods) { mods.calendar.openCalendar(opts); return; }
  const token = (calWanted = ++calTokens);
  listenEsc(true);
  calOpening();
  const done = (calOpening = opening('the calendar'));
  later((m) => { if (calWanted === token) { calWanted = 0; m.calendar.openCalendar(opts); } }).finally(() => {
    done();
    if (calWanted === token) calWanted = 0; // failed: nothing pending
    if (!calWanted) listenEsc(false);
  });
}
export function closeCalendar() {
  if (mods) return mods.calendar.closeCalendar();
  if (!calWanted) return false;
  calCancel();
  return true;
}
export const calendarOpen = () => (mods ? mods.calendar.calendarOpen() : !!calWanted);
/** True once after coming back from a Google sign-in started in the calendar (then it reopens, not Mail). */
export function calendarReturnPending() {
  try { const v = sessionStorage.getItem(KEYS.calendarReturn); sessionStorage.removeItem(KEYS.calendarReturn); return v === '1'; } catch { return false; }
}

/* ---------- Mail ---------- */

export function connectGmail() { return loadMail().then((m) => m.mail.connectGmail(), () => {}); }
/** Only called back from Mail itself (summarize, Ask Eden, write a reply), so it's loaded. */
export const emailText = (m) => mods.mail.emailText(m);
/** Opens Mail on the Team folder and that thread (a team space's "Open in Mail"). */
export function queueTeamOpen(detail) { if (mods) mods.mail.queueTeamOpen(detail); else teamPending = detail; }
/** The Mail panel (panels.js): drawn in `body` once Mail has loaded, unless another panel took it meanwhile. */
export async function mailPanel(body) {
  if (mods) return mods.mail.mailPanel(body);
  // mail.js's own loading rows meanwhile (mail.css)
  body.replaceChildren(el('div', { class: 'mx-skel', role: 'status', 'aria-label': 'Loading mail' },
    ...Array.from({ length: 6 }, (_, i) => el('div', 'sk-row', el('span', 'sk av'), el('span', 'sk-lines', el('span', { class: 'sk l1', style: { width: `${40 + ((i * 17) % 35)}%` } }), el('span', { class: 'sk l2', style: { width: `${62 + ((i * 23) % 30)}%` } }))))));
  let m;
  try { m = await loadMail(); } catch (e) {
    // "Couldn't load Mail" with a Try again button in the panel (AM2-2); the toast says why (loadMail). Once a load
    // under a new address failed too, the button reloads the page: the browser keeps a module that failed inside the
    // bundle (mail.js, say) failed for the page's life, so only a reload fetches it again (offline: tried again here).
    // A newer build on the server (AI2-1): a reload is the only way, so it says that rather than the module error.
    const newer = updated ? await updated : false;
    if (!document.contains(body) || !body.classList.contains('mailx')) return undefined;
    const reload = newer || (attempt > 1 && !(typeof navigator !== 'undefined' && navigator.onLine === false));
    const again = el('button', { type: 'button', class: 'btn', onclick: () => { if (newer) reloadPage(); else if (reload) location.reload(); else mailPanel(body); } }, reload ? 'Reload' : 'Try again');
    body.replaceChildren(newer
      ? el('div', { class: 'sp-warn', role: 'alert' }, el('b', '', 'Eden was updated.'), ' Reload the page to open Mail.', el('div', 'dlg-acts', again))
      : el('div', { class: 'sp-warn', role: 'alert' }, el('b', '', 'Couldn’t load Mail.'), ` ${e.message}`, el('div', 'dlg-acts', again)));
    if (typeof again.focus === 'function') again.focus();
    return undefined;
  }
  if (!document.contains(body) || !body.classList.contains('mailx')) return undefined; // closed, or another panel opened
  const drawn = m.mail.mailPanel(body);
  // focus moves into the panel as it does when Mail was already loaded (unless the person went elsewhere meanwhile)
  const a = document.activeElement;
  if (!a || a === document.body || body.contains(a) || a.id === 'btnSpClose') m.mail.focusMail(body);
  return drawn;
}
export const focusMail = (body) => (mods ? mods.mail.focusMail(body) : false);
