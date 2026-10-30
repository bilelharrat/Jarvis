// Eden Travel (askeden.com/travel, or #open=travel): the owner's design (the Travel mockup, v9, and their travel-app
// page) on real data. Four views: Workspace (the photo header, what Eden noticed with before and after, the day with
// its map and timeline), Journey board (every day side by side), Map explorer (the whole trip on one map) and Travel
// companion (today: what's next, the flight, the pickup). The chat sits beside it as the Ask Eden panel (glass,
// resizable from its left edge). Never in the iPhone/Android app, and only when the Worker has Travel on.
//
// Everything shown comes from the server (site/src/travel/*): the trip, what was checked for each stop (hours, travel
// time, price, each with its source and time; samples always say so), alerts, pace, cost against the budget, the
// person's cards with the issuers' published rates, a proposal waiting from Eden. Nothing is written into the page as a
// fact. It changes the trip only through the person's own buttons (Apply, Undo, Mark booked); anything Eden does goes
// through its cards in the chat (trip-tools.js). Booking goes to Ask Eden: flights through Duffel, anything else in
// Eden's browser (it stops before payment; the person pays).

import { el, ico, toast } from './util.js';
import { IN_APP, IN_TRAVEL_APP } from './native.js';
import { apiUrl, getJSON } from './api.js';
import * as TT from './trip-tools.js';
import { travelStatus, tripGet, tripPost, flightMapView, setViewing, watchPayment } from './trip-ui.js';
import * as M from './travel-more.js';
import * as P from './travel-plan.js';
import * as A from './travel-activities.js';
import * as T from './travel-together.js';
import * as AC from './travel-accuracy.js';
import * as ACC from './travel-account.js';
import * as PTO from './travel-pto.js';
import * as BETA from './travel-beta.js';
import * as RW from './travel-rewards.js';
import * as PR from './travel-promise.js';
import * as CL from './travel-claims.js';
import * as ES from './travel-esim.js';
import * as EN from './travel-entry.js';
import * as PK from './travel-perks.js';
import * as VO from './travel-voice.js';
import * as MEM from './travel-memories.js';
import * as H from './travel-home.js';
import { liveToday, liveButton } from './travel-live.js';
import { forgetTravelDevice } from './travel-privacy.js';

// Eden Travel's own address (askedentravel.com; travel.localhost in local dev) is all Travel, at its front
export const TRAVEL_HOST = typeof location !== 'undefined' && /(^|\.)askedentravel\.com$|^travel\.localhost$/.test(location.hostname);
// there it is its own app: no Eden sidebar or chat controls, its own bar and account menu (travel.css .travel-standalone)
export const STANDALONE = TRAVEL_HOST;
export const TRAVEL_ONLY = typeof location !== 'undefined' && (location.pathname === '/travel' || (TRAVEL_HOST && location.pathname === '/'));
// a trip invite opened (/join/<code> sends here with ?join=<code>, site travel/members.js): Eden Travel offers to join it
const JOIN = typeof location !== 'undefined' ? (/^[a-z0-9]{12}$/.exec(new URLSearchParams(location.search).get('join') || '') || [])[0] || null : null;
const S = { trips: [], id: null, data: null, day: 0, view: 'workspace', maps: null, flights: false, pane: null, imgs: new Map(), marking: null, sharing: null, open: null, shares: [], cardsOpen: false };
// [view, name, short name (a phone's tab), icon (index.html i-tv-*)]
const VIEWS = [['workspace', 'Workspace', 'Day', 'tv-day'], ['board', 'Journey board', 'Journey', 'tv-journey'], ['map', 'Map explorer', 'Map', 'tv-map'], ['companion', 'Travel companion', 'Today', 'tv-now'], ['discover', 'Discover', 'Explore', 'search'], ['group', 'Group', 'Group', 'user']];
const KIND = { stay: 'Stay', transport: 'Getting there', rental: 'Rental', activity: 'Activity', meal: 'Meal', visit: '' };
const FLIGHT_NO = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{1,4})\b/;
const WORD = { ok: 'Checked', look: 'Worth a look', warn: 'Problem', sample: 'Sample data', unknown: 'Not checked' };
const RANK = { warn: 4, unknown: 3, look: 2, sample: 1, ok: 0 };

export const travelOpen = () => document.body.classList.contains('travel-open');

/** Opens Eden Travel (on a trip, when given). */
export async function openTravel(id) {
  if (IN_APP) return;
  if (S.pane && travelOpen() && id) return loadTrip(id); // already open: just that trip
  // the private beta (travel-beta.js): someone not invited goes to its page, not to "isn't switched on yet"
  const b = await BETA.betaStatus().catch(() => ({}));
  if (b.on && !b.member) { location.assign('/travel/beta'); return; }
  BETA.count('open');
  let st = await travelStatus();
  // no signal but trips saved on this device: open them (the status check couldn't reach the server either)
  if (!st.enabled && typeof navigator !== 'undefined' && navigator.onLine === false && saved().trips.length) st = { enabled: true, plus: true, maps: null };
  if (!st.enabled) { toast('Eden Travel isn’t switched on yet'); return; }
  S.maps = st.maps;
  S.plus = st.plus !== false;
  document.body.classList.toggle('travel-noplus', !S.plus); // Ask Eden's empty state and system text follow it (render.js, tools-ui.js)
  watchPayment((m) => toast(m)).then(() => PR.afterPayment()).catch(() => {}); // back from Stripe: the booking's outcome (trip-ui.js payFirst); a Price Promise rebook goes on to its cancel step
  import('./flight-ui.js').then((m) => m.flightStatus()).then((f) => { S.flights = Boolean(f && f.enabled); }).catch(() => {});
  build();
  document.body.classList.add('travel-open');
  let chatOpen = false;
  try { chatOpen = localStorage.getItem('tv-chat-open') === '1'; } catch { /* private window */ }
  if (!chatOpen && !matchMedia('(max-width: 900px)').matches) document.body.classList.add('travel-chat-hidden');
  if (STANDALONE) { document.body.classList.add('travel-standalone'); document.title = 'Ask Eden Travel'; }
  // the app itself offline on its own address (travel-sw.js): never on askeden.com, where Eden has no service worker
  if (STANDALONE && 'serviceWorker' in navigator) navigator.serviceWorker.register('/travel-sw.js', { scope: '/' }).catch(() => {});
  await loadList(id);
}
export function closeTravel() {
  if (!travelOpen() || STANDALONE) return; // on its own address Travel is the whole app
  document.body.classList.remove('travel-open', 'travel-chat-hidden');
  setViewing(null);
  if (TRAVEL_ONLY) history.replaceState(null, '', '/');
}

// the person's own changes, and Eden's cards in the chat, both say so: the view follows
// a home-screen widget tapped in the Travel iPhone app (travel-live.js): that trip's Today
addEventListener('eden:travel-open-view', async (e) => {
  const { view, trip } = e.detail || {};
  if (trip && trip !== S.id && S.trips.some((t) => t.id === trip)) await loadTrip(trip);
  if (view && S.data) move('next', () => { S.view = view; });
});
addEventListener('online', () => { if (travelOpen() && S.offline) { if (S.member) loadShared(S.member.owner, S.member.trip, { keepDay: true }); else loadList(S.id); } }); // back online: the live trip again
addEventListener('eden:trip-changed', (e) => {
  if (!travelOpen()) return;
  const id = e.detail && e.detail.id;
  if (id) (S.edited || (S.edited = new Set())).add(id); // the bar's Undo shows once something changed here
  if (id && !S.trips.some((t) => t.id === id) && S.form) delete S.form.quick; // a trip just made: the sentence is done with
  if (S.member && (!id || id === S.member.trip)) loadShared(S.member.owner, S.member.trip, { keepDay: true });
  else if (S.member) loadList(id); // a member made a trip of their own: show it
  else if (!id || id === S.id) loadTrip(S.id, { keepDay: true, morph: true });
  else if (!S.trips.some((t) => t.id === id)) loadList(id); // a trip just made (Ask Eden's Create card): show it
});

// Today keeps time: its next stop and "leave by" are drawn again each minute while it's on screen
setInterval(() => { if (travelOpen() && S.data && S.view === 'companion' && !document.hidden && !(S.pane && S.pane.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))) paint(); }, 60_000);

/* ---------- motion (Apple-style; motion.css has the tokens; off under reduced motion and in the Eden iPhone app) ---------- */

const RM = typeof matchMedia !== 'undefined' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: true };
const VIEW_ORDER = ['companion', 'workspace', 'board', 'map', 'discover', 'group'];
// the bar's four views (the new design, 2026-10-29): Plan holds Day and All days (the Journey board); Group is its own
// button in the bar, Memories opens from its card
const TABS = [['companion', 'Today', 'tv-now'], ['workspace', 'Plan', 'tv-day'], ['map', 'Map', 'tv-map'], ['discover', 'Discover', 'search']];
const tabOf = (v) => (v === 'board' ? 'workspace' : v);
/** A deliberate move (another view, another day, Eden's change applied): the page morphs into the new state (View
 *  Transitions: stops that stay keep their place, moved ones glide). Anything else just paints. */
let moves = 0;
function move(kind, fn) {
  if (!document.startViewTransition || RM.matches || document.hidden || IN_APP) { fn(); paint(); return; }
  const token = String(++moves);
  document.documentElement.dataset.move = kind;
  document.documentElement.dataset.moveId = token;
  // Eden's change applied: each stop is its own piece, so moved stops glide to their new place (named before and after);
  // a view or day change moves the pane as one
  const name = () => { if (kind === 'apply') for (const n of S.pane.querySelectorAll('[data-vt]')) n.style.viewTransitionName = n.dataset.vt; };
  name();
  const t = document.startViewTransition(() => { fn(); paint(); name(); });
  // a skipped transition (another one started, the tab hidden, a duplicate name) rejects these promises with an
  // AbortError: the change itself is already on screen, so they're caught here, never left unhandled
  const quiet = () => {};
  t.ready.catch(quiet);
  t.updateCallbackDone.catch(quiet);
  // a newer move may have started meanwhile: its direction stays
  t.finished.catch(quiet).then(() => {
    if (document.documentElement.dataset.moveId === token) { delete document.documentElement.dataset.move; delete document.documentElement.dataset.moveId; } // a newer move keeps its own
    if (kind === 'apply') for (const n of S.pane.querySelectorAll('[data-vt]')) n.style.viewTransitionName = '';
  });
}

/* ---------- a stop's picture ---------- */

// Google's photo of the place (from the server's check, with who took it: Google asks for that), or, with no photo
// (a sample place, a stop not on the map), a plain icon for what the stop is. Nothing drawn stands in for a real place.
const LINE = {
  plane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z"/>',
  train: '<rect x="4" y="3" width="16" height="15" rx="4"/><path d="M4 11h16M12 3v8M8 22l2-4M16 22l-2-4"/><circle cx="8.5" cy="14.5" r=".6"/><circle cx="15.5" cy="14.5" r=".6"/>',
  car: '<path d="M5 17H3v-5l2-5h14l2 5v5h-2M9 17h6M3 12h18"/><circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/>',
  boat: '<path d="M2 21c2 1.3 4 1.3 6 0 2 1.3 4 1.3 6 0 2 1.3 4 1.3 6 0M4 18l-1-6h18l-1 6M12 12V4M8 12l4-8 4 8"/>',
  bed: '<path d="M2 5v15M2 9h17a3 3 0 0 1 3 3v8M2 16h20"/><circle cx="7" cy="12.5" r="1.8"/>',
  meal: '<path d="M4 2v7a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V2M7 2v20M20 15V2a4 4 0 0 0-4 4v7a2 2 0 0 0 2 2h2zm0 0v7"/>',
  peak: '<path d="m8 4 4 7 3-3 7 13H2L8 4z"/>',
  sight: '<path d="M3 21h18M5 21V10M9.5 21V10M14.5 21V10M19 21V10M2 10h20L12 3 2 10z"/>',
};
const TINT = { plane: '#0a84ff', train: '#0a84ff', car: '#0a84ff', boat: '#0a84ff', bed: '#bf5af2', meal: '#ff9f0a', peak: '#30d158', sight: '#30d158' };
function lineFor(s) {
  const n = `${s.place.name} ${s.note || ''}`.toLowerCase();
  if (s.kind === 'transport') return /train|rail|tram|metro|station|eurostar/.test(n) ? 'train' : /ferry|boat|cruise/.test(n) ? 'boat' : /car|taxi|uber|drive|transfer/.test(n) && !/flight|fly/.test(n) ? 'car' : 'plane';
  return { stay: 'bed', meal: 'meal', rental: /car|hire/.test(n) ? 'car' : 'peak' }[s.kind] || 'sight';
}
// each stop's check, by stop id (built once per answer from the server)
const CHECK_BY = new WeakMap();
function checkOf(s) {
  const checks = S.data && S.data.checks;
  if (!checks) return null;
  let m = CHECK_BY.get(checks);
  if (!m) { m = new Map(); for (const d of checks.days || []) for (const c of d.stops || []) m.set(c.stop, c); CHECK_BY.set(checks, m); }
  return m.get(s.id) || null;
}
function thumb(s, cls = 'tv-thumb') {
  const icon = () => {
    const k = lineFor(s);
    const box = el('span', { class: `${cls} tv-icon`, style: `--k:${TINT[k]}`, 'aria-hidden': 'true' });
    box.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${LINE[k]}</svg>`; // static markup from LINE only
    return box;
  };
  const ph = (checkOf(s) || {}).photo;
  if (!ph) return icon();
  const img = el('img', { class: cls, src: apiUrl(`/api/chat/travel/photo?n=${encodeURIComponent(ph.name)}&w=${cls === 'tv-next-art' ? 480 : 160}`), alt: '', loading: 'lazy', decoding: 'async', title: `Photo: ${ph.by || 'Google'} · Google Maps` });
  img.onerror = () => img.replaceWith(icon());
  return img;
}

/* ---------- the frame ---------- */

// an open menu (or the proof drawer) closes on a click outside it or Escape: one listener for the page (the menus are
// redrawn on each paint); Escape gives the focus back to the button that opened it
function closeMenus(e) {
  if (S.proof && (e.type === 'keydown' ? e.key === 'Escape' : !e.target.closest('.tv-proof-wrap'))) { const k = S.proof, inPane = S.pane.contains(document.activeElement); S.proof = null; paint(); if (e.type === 'keydown' && inPane) { const b = S.pane.querySelector(`[data-k="proof:${CSS.escape(k)}"]`); if (b) b.focus(); } }
  if (!S.menu) return;
  if (e.type === 'keydown' ? e.key !== 'Escape' : e.target.closest('.tv-menuwrap')) return;
  const k = S.menu;
  S.menu = null;
  paint();
  if (e.type === 'keydown') S.pane.querySelector(`[data-k="menu:${CSS.escape(k)}"]`)?.focus();
}

/** A button with its menu (Trip tools, Add, the account): one open at a time, kept open across repaints (S.menu).
 *  Arrow keys, Home and End move between its items; Escape or Tab closes it; an item's own focus target (a panel it
 *  opened) takes the focus, else the button gets it back. Items: { k, label, icon, run, sub, checked, cls, head } or null. */
function menu(key, { label, cls = 'tv-pill', icon, text, items, extra = null, align = 'right' }) {
  const open = S.menu === key;
  const btn = el('button', { type: 'button', class: `${cls} tv-menubtn`, 'data-k': `menu:${key}`, 'aria-haspopup': 'menu', 'aria-expanded': String(open), 'aria-label': text ? null : label, title: label,
    onclick: (e) => { e.stopPropagation(); S.menu = open ? null : key; S.menuFocus = !open; S.menuFresh = open ? null : key; paint(); } },
    icon ? ico(icon, 14) : null, text ? el('span', 'tv-menubtn-label', text) : null, text ? ico('chevd', 11, 'tv-menubtn-chev') : null);
  if (!open) return el('span', 'tv-menuwrap', btn);
  const rows = items.filter(Boolean).map((it) => {
    if (it.head) return el('span', { class: `tv-menu-head ${it.cls || ''}`.trim(), role: 'presentation' }, it.head);
    const check = it.checked !== undefined;
    return el('button', { type: 'button', class: `tv-menu-row ${it.cls || ''}`.trim(), role: check ? 'menuitemcheckbox' : 'menuitem', ...(check ? { 'aria-checked': String(Boolean(it.checked)) } : {}), tabindex: '-1', 'data-k': it.k,
      onclick: (e) => { e.stopPropagation(); S.menu = null; S.returnTo = `menu:${key}`; S.focusNext = it.focus || null; it.run(); paint(); } },
      it.icon ? ico(it.icon, 15) : null, el('span', 'tv-menu-text', el('span', '', it.label), it.sub ? el('small', '', it.sub) : null), check ? el('span', 'tv-menu-tick', it.checked ? ico('check', 13) : null) : null);
  });
  const list = el('div', { class: `tv-menu glass-card${S.menuFresh === key ? ' tv-menu-in' : ''} ${align}`, role: 'menu', 'aria-label': label, onkeydown: (e) => {
    const all = [...list.querySelectorAll('[role^="menuitem"]')].filter((n) => n.offsetParent !== null);
    const i = all.indexOf(document.activeElement);
    const to = { ArrowDown: (i + 1) % all.length, ArrowUp: (i - 1 + all.length) % all.length, Home: 0, End: all.length - 1 }[e.key];
    if (to !== undefined) { e.preventDefault(); all[to]?.focus(); }
    else if (e.key === 'Tab') { e.preventDefault(); S.menu = null; paint(); S.pane.querySelector(`[data-k="menu:${CSS.escape(key)}"]`)?.focus(); }
  } }, ...rows, extra);
  S.menuFresh = null;
  return el('span', 'tv-menuwrap', btn, list);
}

function build() {
  if (S.pane) return;
  M.init({ S, paint, ask, tripRef, money, money2, hm, dayLong, kicker, chip, loadTrip, wrongButton: (...a) => AC.wrongButton(...a) });
  P.init({ S, paint, ask, tripRef, money, hm, dayLong, kicker, chip, loadTrip, keep });
  A.init({ S, paint, money2, hm, kicker, loadTrip });
  T.init({ S, paint });
  AC.init({ S, paint, kicker, dayLong });
  ACC.init({ S, paint, loadTrip });
  RW.init({ S, paint });
  PR.init({ S, paint, money2 });
  CL.init({ S, paint });
  ES.init({ S, paint, money2 });
  EN.init({ S, paint, openProfile: () => ACC.openProfile() });
  PK.init({ S, paint, money });
  VO.init({ S, paint, ask, tripRef });
  MEM.init({ S, paint, mapImage, money });
  PTO.init({ S, paint });
  H.init({ S, paint, ask, city, heroPhoto, sample, photoSrc: (u) => apiUrl(`/api/chat/travel/hero-image?u=${encodeURIComponent(u)}`),
    openTrip, openShared: (o, t) => { S.home = false; return loadShared(o, t); }, planNew: () => { S.newTrip = {}; paint(); },
    openPto: () => { S.ptoOpen = true; paint(); } });
  BETA.init({ S });
  addEventListener('click', closeMenus);
  addEventListener('keydown', closeMenus);
  if (!document.querySelector('link[href*="travel.css"]')) document.head.append(el('link', { rel: 'stylesheet', href: 'travel.css?v=20261029c' }));
  S.pane = el('section', { id: 'travelPane', 'aria-label': 'Eden Travel' });
  const center = document.getElementById('center');
  (center || document.body).before(S.pane);
  chatEdge(center);
  // narrow windows: the chat shows in place of the trip; this takes the person back to it
  if (center && !center.querySelector('.tv-back')) center.prepend(el('button', { type: 'button', class: 'tv-back tv-pill', onclick: () => { document.body.classList.remove('travel-chat'); paint(); } }, ico('chevl', 14), 'Back to the trip'));
}

/** The chat's left edge in Travel: drag to widen the Ask Eden panel (320px up to 60% of the window); double-click resets. */
/** Ask Eden on or off: wide, the panel beside the trip; narrow, the chat in place of the trip (and back). */
function toggleChat() {
  const b = document.body.classList;
  if (matchMedia('(max-width: 900px)').matches) { b.remove('travel-chat-hidden'); b.toggle('travel-chat'); }
  else { b.toggle('travel-chat-hidden'); try { localStorage.setItem('tv-chat-open', b.contains('travel-chat-hidden') ? '0' : '1'); } catch { /* private window */ } }
  paint();
}

function chatEdge(center) {
  if (!center || center.querySelector('.tv-resize')) return;
  const KEY = 'eden:travelChatW';
  const root = document.documentElement;
  const set = (px) => { const w = Math.round(Math.min(innerWidth * 0.6, Math.max(320, px))); root.style.setProperty('--tv-chat-w', `${w}px`); return w; };
  try { const saved = Number(localStorage.getItem(KEY)); if (saved > 0) set(saved); } catch { /* blocked */ }
  const h = el('div', { class: 'tv-resize', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize Ask Eden', title: 'Drag to resize · double-click to reset', tabindex: '0' });
  center.prepend(h);
  const save = (w) => { try { localStorage.setItem(KEY, String(w)); } catch { /* blocked */ } };
  h.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    h.setPointerCapture(e.pointerId);
    h.classList.add('drag');
    document.body.classList.add('tv-resizing');
    const right = center.getBoundingClientRect().right;
    let w = center.offsetWidth;
    const move = (ev) => { w = set(right - ev.clientX); };
    const up = () => { h.removeEventListener('pointermove', move); h.classList.remove('drag'); document.body.classList.remove('tv-resizing'); save(w); };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up, { once: true });
    h.addEventListener('pointercancel', up, { once: true });
  });
  h.addEventListener('dblclick', () => { root.style.removeProperty('--tv-chat-w'); try { localStorage.removeItem(KEY); } catch { /* blocked */ } });
  h.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    save(set(center.offsetWidth + (e.key === 'ArrowLeft' ? 24 : -24)));
  });
}

/* ---------- data ---------- */

/* ---------- the trip offline (travel-sw.js keeps the app itself) ---------- */

// The last trip list and each trip opened, kept on this device so Eden Travel still shows them with no signal (abroad,
// in the air). Shown with when they were saved; nothing on them is checked again until the device is back online.
const SAVED = 'eden:travel:saved';
function saved() { try { return JSON.parse(localStorage.getItem(SAVED) || 'null') || { trips: [], byId: {} }; } catch { return { trips: [], byId: {} }; } }
function save(fn) {
  try {
    const v = saved(); fn(v);
    const ids = Object.keys(v.byId).sort((a, b) => v.byId[b].at - v.byId[a].at);
    for (const old of ids.slice(8)) delete v.byId[old]; // the 8 trips opened last
    localStorage.setItem(SAVED, JSON.stringify(v));
  } catch { /* storage full or blocked: online only */ }
}
// no signal: the browser says so, or the request never reached the server (api.js: an ApiError with status 0)
const offlineNow = (e) => (typeof navigator !== 'undefined' && navigator.onLine === false) || (e && e.status === 0) || /failed to fetch|network|offline|load failed|reach the server/i.test(String((e && e.message) || e));

async function loadList(id) {
  try {
    const r = await tripGet();
    S.trips = r.trips || [];
    S.plus = r.plus !== false;
    document.body.classList.toggle('travel-noplus', !S.plus);
    S.maps = r.maps || S.maps;
    S.offline = null;
    // trips others shared with this person, and the flight tracking links (account-wide: fetched once here)
    [S.shared] = await Promise.all([tripPost('shared-list', {}).then((x) => x.shared || []).catch(() => []), loadShares()]);
    save((v) => { v.trips = S.trips; v.shared = S.shared; v.listAt = Date.now(); });
  } catch (e) {
    const v = saved();
    S.loaded = true;
    if (!offlineNow(e) || !v.trips.length) return paintError(e);
    S.trips = v.trips; S.shared = v.shared || []; S.offline = v.listAt; // no signal: the trips as saved on this device
  }
  S.loaded = true;
  if (JOIN && !S.joinDone) { S.joining = JOIN; return paint(); }
  if (!S.trips.length && (S.shared || []).length && !id && !S.member) return loadShared(S.shared[0].owner, S.shared[0].trip);
  // the home first (travel-home.js), not the newest trip or a bare planning box; offline, the trip kept on this device
  if (!id && !S.offline && (S.home || !S.id)) return goHome();
  const kept = S.offline ? saved().byId : null;
  const pick = id || S.id || (kept ? (S.trips.find((t) => kept[t.id]) || {}).id : null) || (S.trips[0] && S.trips[0].id);
  if (pick) await loadTrip(pick); else paint();
}

// how Ask Eden is told which trip: a member's is the organiser's shared trip
const tripRef = (trip) => (S.member ? `the shared trip “${trip.title}”` : `my trip “${trip.title}”`);
// a day from the board, map or Today: the day view, and Ask Eden told which day it is
function showDay(i) {
  S.day = i; S.view = 'workspace';
  if (S.data) setViewing({ id: S.id, title: S.data.trip.title, day: i, ...(S.member ? { shared: { owner: S.member.owner, trip: S.member.trip } } : {}) });
  paint();
}

// another trip on screen: what belonged to the one before (its panels, links, members, calendar, forecast) goes
function leaving(id) {
  if (S.id === id) return;
  S.linkOpen = S.calOpen = S.cardsOpen = false; S.links = S.members = S.cal = null;
  S.weather = null; S.weatherFor = null; S.afterDark = null; S.marking = null; S.sharing = null; S.open = null; S.flightViews = new Map();
  S.editStop = S.stopErr = S.adding = S.leg = S.packWeather = S.packWeatherFor = null; // planning by hand (travel-plan.js)
}

/** Back to the home (the brand, or Trips in the bar): the trips, the next one's checks, Eden noticed. */
function goHome() {
  leaving(null);
  S.home = true; S.id = null; S.data = null; S.view = 'workspace'; S.newTrip = null; S.member = null;
  document.body.classList.remove('travel-member');
  setViewing(null);
  paint();
  H.loadNext();
}
/** A trip from the home: its day (or Today), and a fix asked of Eden when one was pressed. */
async function openTrip(id, { view, day, fix } = {}) {
  await loadTrip(id);
  if (!S.data || S.id !== id) return;
  if (Number.isInteger(day)) S.day = Math.min(day, S.data.trip.days.length - 1);
  if (view) S.view = view;
  paint();
  if (fix) ask(fixText(S.data.trip, fix, true));
}

async function loadTrip(id, { keepDay = false, morph = false } = {}) {
  if (!id) return paint();
  S.home = false;
  leaving(id);
  const seq = (S.seq = (S.seq || 0) + 1); // only the newest pick shows (a slow answer for an earlier one is dropped)
  S.opening = !S.data; // the first trip on its way: the page waits for it (paintPane)
  try {
    const r = await tripGet(id);
    if (seq !== S.seq) return;
    S.opening = false;
    S.member = null;
    document.body.classList.remove('travel-member');
    if (S.id !== id || !keepDay) S.day = 0;
    if (S.id !== id) { S.group = null; S.windows = null; S.addBooking = null; S.docs = []; S.copyOpen = false; }
    S.id = id;
    S.data = r;
    if (r.maps) S.maps = r.maps;
    M.loadDocs().then(() => paint());
    liveToday(r); // the Travel app's widgets and Live Activity follow the trip on show (travel-live.js; nothing elsewhere)
    if (S.group && S.view === 'group') M.loadGroup(); // the bookings in Money follow the trip
    S.day = Math.min(S.day, r.trip.days.length - 1);
    setViewing({ id, title: r.trip.title, day: S.day });
    // the forecast (and what falls after dark) follows the trip's dates, places and times: asked again when they change
    const wkey = `${id}:${r.trip.start}:${r.trip.days.map((d) => d.stops.map((x) => `${x.place.id || ''}@${x.at || ''}`).join(';')).join(',')}`;
    if (!S.weather || S.weatherFor !== wkey) { S.weather = null; S.weatherFor = wkey; loadWeather(id); }
    S.offline = null;
    save((v) => { v.byId[id] = { at: Date.now(), data: r, weather: S.weather }; });
  } catch (e) {
    if (seq === S.seq) S.opening = false;
    const kept = saved().byId[id];
    if (!offlineNow(e) || !kept) return paintError(e);
    if (S.id !== id || !keepDay) S.day = 0;
    S.id = id; S.data = kept.data; S.weather = kept.weather || null; S.offline = kept.at;
    S.member = null; document.body.classList.remove('travel-member');
    S.day = Math.max(0, Math.min(S.day, kept.data.trip.days.length - 1));
    setViewing({ id, title: kept.data.trip.title, day: S.day });
  }
  if (morph) move('apply', () => {}); else paint(); // a change landing: stops glide to their new places
}

/* ---------- planning together (site travel/members.js) ---------- */

// a trip someone shared with this person: shown as it is now; they suggest changes (Ask Eden), the organiser applies
async function loadShared(owner, trip, { keepDay = false } = {}) {
  leaving(trip);
  S.offline = null;
  const seq = (S.seq = (S.seq || 0) + 1);
  const key = `s:${owner}:${trip}`;
  try {
    let r;
    try { r = await tripPost('shared-get', { owner, trip }); }
    catch (e) {
      // no signal: the shared trip as saved on this device
      const kept = saved().byId[key];
      if (!offlineNow(e) || !kept) throw e;
      r = kept.data; r.offlineAt = kept.at;
    }
    if (seq !== S.seq) return; // a newer pick: this answer (and its offline state) isn't shown
    if (r.offlineAt) { S.offline = r.offlineAt; delete r.offlineAt; }
    if (!S.offline) save((v) => { v.byId[key] = { at: Date.now(), data: r }; });
    if (S.id !== trip || !keepDay) S.day = 0;
    if (S.id !== trip) { S.group = null; S.windows = null; S.addBooking = null; S.docs = []; S.copyOpen = false; }
    S.id = trip; S.member = { owner, trip, title: r.trip.title };
    document.body.classList.add('travel-member'); // Ask Eden's suggestions follow it (render.js)
    S.data = { trip: r.trip, checks: r.checks, proposal: null, waiting: r.proposal, price_drops: [], rewards: [] };
    S.day = Math.min(S.day, r.trip.days.length - 1);
    setViewing({ id: trip, title: r.trip.title, day: S.day, shared: { owner, trip } });
  } catch (e) { return paintError(e); }
  paint();
}

function joinCard() {
  const name = el('input', { type: 'text', autocomplete: 'given-name', placeholder: 'Your first name', 'aria-label': 'Your first name', maxlength: '40' });
  keep(name, 'join-name'); // kept across repaints, focused once
  return el('section', { class: 'tv-empty glass-card' },
    el('h2', '', 'You’re invited to plan a trip'),
    el('p', '', 'Join to see the whole trip as it is now, and suggest changes with Ask Eden. The person who invited you decides what changes.'),
    name,
    el('div', 'tv-acts',
      el('button', { type: 'button', class: 'tv-btn primary', onclick: async (e) => {
        e.target.disabled = true;
        try {
          const r = await tripPost('join', { code: S.joining, name: name.value });
          S.joining = null; S.joinDone = true; history.replaceState(null, '', location.pathname);
          toast(`You joined “${r.title}”`);
          S.shared = await tripPost('shared-list', {}).then((x) => x.shared || []).catch(() => []);
          await loadShared(r.owner, r.trip);
        } catch (err) { toast(String(err.message || err)); e.target.disabled = false; }
      } }, 'Join the trip'),
      el('button', { type: 'button', class: 'tv-btn quiet', onclick: () => { S.joining = null; S.joinDone = true; history.replaceState(null, '', location.pathname); loadList(); } }, 'Not now')));
}

// the organiser's side: invite people to plan together, see who joined, take someone off
async function loadMembers(again = true) {
  try { S.members = await tripPost('members', { id: S.id }); } catch { S.members = { members: [], invites: [] }; }
  if (again) paint();
}
// the Share panel: its links and people fetched together, then one paint
async function openShare() {
  paint();
  await Promise.all([loadLinks(false), loadMembers(false)]);
  paint();
}
function membersPanel() {
  const m = S.members || { members: [], invites: [] };
  const full = (u) => `${location.origin}${u}`;
  const copy = async (u) => { try { await navigator.clipboard.writeText(full(u)); toast('Invite link copied'); } catch { toast(full(u)); } };
  return el('div', 'tv-members tv-share-part',
    el('h3', '', 'Plan together'),
    el('p', '', 'Invite the people on the trip: with their own Eden account they see the whole trip, bookings included, and suggest changes. Only you apply them. An invite works for 14 days.'),
    ...m.members.map((x) => el('div', 'tv-acts', el('b', { 'data-no-i18n': '' }, x.name), el('button', { type: 'button', class: 'tv-btn quiet', onclick: async () => { await tripPost('member-remove', { id: S.id, member: x.member }).catch((e) => toast(String(e.message || e))); loadMembers(); } }, 'Remove'))),
    ...m.invites.map((x) => el('div', 'tv-acts', el('code', { 'data-no-i18n': '' }, full(x.url)), el('button', { type: 'button', class: 'tv-btn', onclick: () => copy(x.url) }, 'Copy'),
      el('button', { type: 'button', class: 'tv-btn quiet', onclick: async () => { await tripPost('invite-revoke', { code: x.code }).catch(() => {}); loadMembers(); } }, 'Cancel invite'))),
    m.invites.length ? null : el('div', 'tv-acts', el('button', { type: 'button', class: 'tv-btn primary', onclick: async (e) => {
      e.target.disabled = true;
      try { const r = await tripPost('invite-create', { id: S.id }); await loadMembers(); copy(r.url); } catch (err) { toast(String(err.message || err)); e.target.disabled = false; }
    } }, 'Invite someone')));
}

// each day's forecast (site travel/weather.js, Open-Meteo): fetched after the trip shows, never guessed past 16 days
async function loadWeather(id) {
  try { const w = await tripPost('weather', { id }); if (S.id === id) { S.weather = w.days || []; S.afterDark = w.after_dark || []; save((v) => { if (v.byId[id]) v.byId[id].weather = S.weather; }); paint(); } } catch { S.weather = null; }
}
function weatherChip(i) {
  const w = S.weather && S.weather[i];
  if (!w) return null;
  const sun = w.sunset ? chip(`Sunset ${String(w.sunset).slice(11, 16)}`, '') : null; // Open-Meteo, the day's own spot
  if (w.forecast === null || w.why) return [chip(w.why === 'Too far ahead for a forecast' ? 'Forecast nearer the day' : 'No forecast', 'note'), sun];
  const x = el('span', { class: 'tv-chip', title: `${w.place}: ${w.source}, checked ${String(w.checked_at).slice(0, 16).replace('T', ' ')} UTC` }, `${w.summary || 'Weather'} · ${Math.round(w.high_c)}° / ${Math.round(w.low_c)}°${w.rain_chance_pct != null ? ` · ${w.rain_chance_pct}% rain` : ''}`);
  return [x, sun];
}

async function loadShares() {
  try { S.shares = (await tripPost('shares', {})).shares || []; } catch { S.shares = []; }
}

const ask = async (text) => {
  const { sendMessage } = await import('./chat.js');
  document.body.classList.remove('travel-chat-hidden');
  if (matchMedia('(max-width: 900px)').matches) document.body.classList.add('travel-chat'); // narrow: show the chat with the answer
  sendMessage(text);
};

/* ---------- small pieces ---------- */

const money2 = (n, cur) => { try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur }).format(n); } catch { return `${cur} ${n.toFixed(2)}`; } };
const money = (n, cur) => { try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n); } catch { return `${cur} ${Math.round(n)}`; } };
const dayLong = (date) => (date ? new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');
const hm = (m) => (m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, '0')} min` : ''}` : `${m} min`);
const city = (trip) => String(trip.destination || trip.title || '').split(',')[0].trim() || 'your trip';
const kicker = (...parts) => el('span', 'tv-kicker', parts.filter(Boolean).join(' · '));
const chip = (text, cls = '') => el('span', `tv-chip ${cls}`.trim(), text);

/** The worst of a stop's checks, as one pill (a sample is a sample, never "checked"). */
function overall(badges) {
  const all = ['hours', 'travel', 'price'].map((k) => badges && badges[k]).filter(Boolean);
  if (!all.length) return null;
  const eff = (k, b) => {
    if (k === 'price' && b.status === 'look' && (badges.hours || badges.travel)) return { ...b, status: 'ok' };
    if (k === 'travel' && b.status === 'look' && (b.estimate || /no train times in Japan/i.test(`${b.source || ''} ${b.text || ''}`)) && !/to spare/i.test(b.text || '')) return { ...b, status: 'ok' };
    return b;
  };
  const list = ['hours', 'travel', 'price'].map((k) => badges && badges[k] && eff(k, badges[k])).filter(Boolean);
  const worst = list.reduce((a, b) => (RANK[b.status] > RANK[a.status] ? b : a));
  const sample = list.some((b) => b.status === 'sample') && worst.status !== 'warn';
  const status = sample && RANK[worst.status] < RANK.look ? 'sample' : worst.status;
  return { status, title: all.map((b) => `${b.text}${b.source ? ` (${b.source}${b.checked_at ? `, checked ${String(b.checked_at).slice(0, 16).replace('T', ' ')} UTC` : ''})` : ''}`).join('\n') };
}
const NAMES = { hours: 'Hours', travel: 'Getting there', price: 'Price' };
function evesPill(badges, key) {
  const o = overall(badges);
  if (!o) return null;
  // newly checked since the last look: the check draws in once (the signature moment), never again
  if (!S.seenOk) S.seenOk = new Set();
  const fresh = key && o.status === 'ok' && !S.seenOk.has(key);
  if (key && o.status === 'ok') S.seenOk.add(key);
  if (!key) return el('span', { class: `tv-eves ${o.status}`, title: o.title }, el('i', ''), WORD[o.status] || o.status);
  const open = S.proof === key;
  const pill = el('button', { type: 'button', class: `tv-eves ${o.status}${fresh ? ' tv-checkin' : ''}`, 'data-k': `proof:${key}`, 'aria-expanded': String(open), 'aria-label': `${WORD[o.status] || o.status}: show what was checked`, onclick: (e) => { e.stopPropagation(); S.proof = open ? null : key; paint(); } }, el('i', ''), WORD[o.status] || o.status);
  if (!open) return pill;
  // the proof drawer: each fact, its source and when it was checked; a sample says so; nothing hidden
  const rows = ['hours', 'travel', 'price'].map((k) => badges[k] && [k, badges[k]]).filter(Boolean);
  const did = `proof-${String(key).replace(/[^a-z0-9-]/gi, '')}`;
  pill.setAttribute('aria-controls', did);
  return el('span', 'tv-proof-wrap', pill, el('div', { class: 'tv-proof glass-card', id: did, role: 'group', 'aria-label': 'What Eden checked' },
    el('span', 'tv-kicker', 'What Eden checked'),
    ...rows.map(([k, b]) => el('div', `tv-proof-row ${b.status}`, AC.wrongButton(key, k, b), el('b', '', `${NAMES[k]} · ${WORD[b.status] || b.status}`), el('span', '', b.text),
      el('small', '', b.status === 'sample' ? 'Sample data: not checked against a live source' : b.source ? `${b.source}${b.checked_at ? ` · checked ${new Date(b.checked_at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}` : 'No source: not checked')))));
}

/** The map picture from the server (a Google static map, the server's key) with an overlay drawn on top. */
function mapImage(points, { w = 640, h = 640, style, cls = 'tv-mapimg', draw }) {
  const frame = el('div', { class: cls });
  frame.style.minHeight = cls.includes('wide') ? '300px' : '360px';
  frame.style.width = '100%';
  if (!points.length) { frame.append(el('div', 'tv-map-empty', 'No map points yet.')); return frame; }
  const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  const q = new URLSearchParams({ p: points.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|'), w: String(w), h: String(h), style: style || (dark ? 'day-dark' : 'day') });
  const key = q.toString();
  const pic = el('img', { alt: '' });
  const over = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  over.setAttribute('viewBox', `0 0 ${w} ${h}`);
  over.setAttribute('preserveAspectRatio', 'xMidYMid slice'); // the picture is object-fit: cover; the pins crop the same way
  over.setAttribute('aria-hidden', 'true');
  frame.append(pic, over);
  const show = (m) => { pic.src = m.url; draw(over, (p) => TT.project(p, m.center, m.zoom, w, h)); };
  const toDataUrl = (blob) => new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result || '')); r.onerror = bad; r.readAsDataURL(blob); });
  // one fetch per map, shared by every paint that asks while it loads; the last 24 kept (older pictures let go)
  let got = S.imgs.get(key);
  if (!got) {
    got = fetch(apiUrl(`/api/chat/travel/map?${key}`), { headers: { 'X-Jarvis-Chat': '1' }, credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) {
          const j = await res.json().catch(() => null);
          throw new Error((j && j.error) || 'The map needs Google Maps on Eden’s server.');
        }
        const [lat, lng] = String(res.headers.get('x-map-center') || '').split(',').map(Number);
        const url = await toDataUrl(await res.blob());
        got.m = { url, center: { lat, lng }, zoom: Number(res.headers.get('x-map-zoom')) };
        return got.m;
      });
    got.catch(() => { S.imgs.delete(key); });
    S.imgs.set(key, got);
    for (const [k] of S.imgs) { if (S.imgs.size <= 24) break; S.imgs.delete(k); }
  }
  else { S.imgs.delete(key); S.imgs.set(key, got); } // in use: the newest, last to be let go
  if (got.m) show(got.m);
  else got.then(show, (err) => { frame.replaceChildren(el('div', 'tv-map-empty', String((err && err.message) || 'The map needs Google Maps on Eden’s server.'))); });
  return frame;
}
const ns = (tag, a) => { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(a)) n.setAttribute(k, String(v)); return n; };
function pins(over, P, stops, { colorOf = () => '#0a84ff', labelOf = (s, i) => String(i + 1), line = true } = {}) {
  const pts = stops.map((s) => P(s.place));
  if (line && pts.length > 1) over.append(ns('path', { d: pts.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' '), fill: 'none', stroke: '#0a84ff', 'stroke-width': 3, 'stroke-linecap': 'round', 'stroke-dasharray': '1 7', opacity: 0.9 }));
  pts.forEach((q, i) => {
    // each pin is a button: a tap opens its stop's card on the map (pinCard)
    const g = ns('g', { class: 'tv-pin', role: 'button', tabindex: '0', 'aria-label': `${labelOf(stops[i], i)}: ${stops[i].place.name}` });
    g.append(ns('circle', { cx: q.x, cy: q.y, r: 13, fill: colorOf(stops[i], i), stroke: '#fff', 'stroke-width': 2.5 }));
    const t = ns('text', { x: q.x, y: q.y + 4.5, 'text-anchor': 'middle', fill: '#fff', 'font-size': 12, 'font-weight': 700, 'font-family': 'system-ui, -apple-system, sans-serif' });
    t.textContent = labelOf(stops[i], i);
    g.append(t);
    const open = (e) => { e.preventDefault(); e.stopPropagation(); pinCard(over.parentElement, g, stops[i]); };
    g.addEventListener('click', open);
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') open(e); });
    over.append(g);
  });
}

// A pin tapped: its stop in a small card at the pin (owner, 2026-10-29): photo, name, when, what Eden checked (hours,
// getting there), then Details (the stop opened in the day) and Directions (Google Maps). One card at a time; a tap
// elsewhere, Escape or the close button closes it.
function pinCard(frame, pin, stop) {
  frame.querySelector('.tv-pincard')?.remove();
  const { trip, checks } = S.data;
  const d = trip.days.findIndex((x) => x.stops.some((y) => y.id === stop.id));
  if (d < 0) return;
  const k = trip.days[d].stops.findIndex((y) => y.id === stop.id), s = trip.days[d].stops[k];
  const b = ((checks.days[d] || {}).stops || [])[k]?.badges || {};
  const p = s.place;
  const dir = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${p.lat},${p.lng}`)}${p.id && /^ChIJ/.test(p.id) ? `&query_place_id=${encodeURIComponent(p.id)}` : ''}`;
  const line = (x) => (x && x.text ? el('p', `tv-pincard-line ${x.status || ''}`, el('i', ''), x.text) : null);
  const close = () => { card.remove(); document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', esc); };
  const away = (e) => { if (!card.contains(e.target) && !pin.contains(e.target)) close(); };
  const esc = (e) => { if (e.key === 'Escape') { close(); pin.focus(); } };
  const card = el('div', { class: 'tv-pincard', role: 'dialog', 'aria-label': p.name },
    el('button', { type: 'button', class: 'tv-x tv-pincard-x', 'aria-label': 'Close', onclick: close }, ico('x', 13)),
    el('div', 'tv-pincard-head', thumb(s, 'tv-pincard-art'), el('div', '', el('b', '', p.name),
      el('small', '', [`Day ${d + 1}`, s.at, hm(s.minutes), KIND[s.kind] || null].filter(Boolean).join(' · ')))),
    b.replace ? line({ status: 'look', text: b.replace.text }) : null,
    line(b.hours), k > 0 ? line(b.travel) : null,
    s.booked ? el('p', 'tv-pincard-line ok', el('i', ''), `Booked${s.booked.ref ? ` · ${s.booked.ref}` : ''}`) : null,
    el('div', 'tv-acts',
      el('button', { type: 'button', class: 'tv-btn primary', onclick: () => { close(); S.view = 'workspace'; S.day = d; S.open = s.id; paint(); setTimeout(() => S.pane?.querySelector(`[data-k="stop:${CSS.escape(s.id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 60); } }, 'Details'),
      Number.isFinite(p.lat) ? el('a', { class: 'tv-btn', href: dir, target: '_blank', rel: 'noopener' }, ico('route', 13), 'Directions') : null));
  frame.append(card);
  // at the pin: above it when there's room, else below; kept inside the map
  const f = frame.getBoundingClientRect(), r = pin.getBoundingClientRect();
  const cx = r.left + r.width / 2 - f.left, top = r.top - f.top, bottom = r.bottom - f.top;
  const w = card.offsetWidth, h = card.offsetHeight;
  card.style.left = `${Math.max(8, Math.min(f.width - w - 8, cx - w / 2))}px`;
  card.style.top = `${top - h - 10 >= 8 ? top - h - 10 : Math.min(f.height - h - 8, bottom + 10)}px`;
  setTimeout(() => { document.addEventListener('pointerdown', away, true); document.addEventListener('keydown', esc); }, 0);
  card.querySelector('.tv-btn')?.focus({ preventScroll: true });
}
// a Lisbon sample stop left in another trip (made before Google Maps was on) stays off the map: it once stretched a Tokyo
// day's map to Lisbon and Africa (site travel/maps.js strayStandin; the checks say to replace it)
const strayStandin = (s) => String(s.place.id || '').startsWith('standin:') && S.data && !/lisbo[an]/i.test(`${S.data.trip.destination || ''} ${S.data.trip.title || ''}`);
const syncCoords = () => {
  if (!S.data || !S.data.trip || !S.data.checks || !Array.isArray(S.data.trip.days) || !Array.isArray(S.data.checks.days)) return;
  for (let d = 0; d < S.data.trip.days.length; d++) {
    const stops = S.data.trip.days[d]?.stops || [];
    const cStops = S.data.checks.days[d]?.stops || [];
    for (let k = 0; k < stops.length; k++) {
      const s = stops[k], cs = cStops[k];
      if (s && s.place && cs && Number.isFinite(cs.lat) && Number.isFinite(cs.lng)) {
        if ((!s.place.id || String(s.place.id).startsWith('standin:')) && cs.place_id) s.place.id = cs.place_id;
        if (!Number.isFinite(s.place.lat) || !Number.isFinite(s.place.lng) || String(s.place.id || '').startsWith('standin:')) { s.place.lat = cs.lat; s.place.lng = cs.lng; }
      }
    }
  }
};
const located = (stops) => { syncCoords(); return stops.filter((s) => Number.isFinite(s.place.lat) && Number.isFinite(s.place.lng) && !(s.place.lat === 0 && s.place.lng === 0) && !strayStandin(s)); };
// the day's time on the move: only what was checked; none checked says so, never "0 min"
const moveText = (c, word = 'on the move') => (!c.move_minutes && c.move_unchecked ? 'travel not checked' : `${hm(c.move_minutes || 0)}${c.move_unchecked ? '+' : ''} ${word}`);

/* ---------- painting ---------- */

// A form's field keeps what was typed across paints (weather, links and members arriving repaint the pane), and takes
// the focus only the first time it shows.
function keep(input, key) {
  if (!S.form) S.form = {};
  if (!S.focused) S.focused = new Set();
  if (S.form[key] !== undefined) input.value = S.form[key];
  input.addEventListener('input', () => { S.form[key] = input.value; });
  input.dataset.k = `f:${key}`;
  if (!S.focused.has(key)) { S.focused.add(key); setTimeout(() => input.focus(), 0); }
}

function paintError(e) {
  BETA.noteError(e);
  S.pane.replaceChildren(topbar(), el('div', { class: 'errbox', role: 'alert' }, ico('x'), el('span', '', String(e.message || e))));
}

function topbar() {
  const pick = tripPicker('tv-trip');
  return topbarWith(pick);
}

// your trips, then the ones others shared with you (value "s|owner|trip"): in the bar, and in the menu on a phone
function tripPicker(cls) {
  const shared = S.shared || [];
  return S.trips.length || shared.length ? el('select', { class: cls, 'data-k': `pick:${cls}`, 'aria-label': 'Trip', onchange: (e) => { S.menu = null; const v = e.target.value; if (v.startsWith('s|')) { const [, o, t] = v.split('|'); loadShared(o, t); } else loadTrip(v); } },
    ...S.trips.map((t) => el('option', { value: t.id, ...(!S.member && t.id === S.id ? { selected: '' } : {}) }, t.title)),
    ...shared.map((x) => el('option', { value: `s|${x.owner}|${x.trip}`, ...(S.member && S.member.trip === x.trip ? { selected: '' } : {}) }, `${x.title} (shared with you)`))) : null;
}

function topbarWith(pick) {
  return el('header', 'tv-bar',
    STANDALONE ? el('a', { class: 'tv-brand', href: '/', 'aria-label': 'Ask Eden Travel: your trips', onclick: (e) => { e.preventDefault(); goHome(); } }, el('img', { class: 'tv-logo', src: '/travel-home/eden-logo.svg', alt: '' }), el('b', '', 'Ask Eden'), el('span', 'tv-brand-sub', 'Travel'))
      : el('div', 'tv-brand', el('span', 'tv-mark', ico('globe', 15)), el('b', '', 'Eden'), el('span', 'tv-brand-sub', 'Travel')),
    S.data ? el('nav', { class: 'tv-tabs', 'aria-label': 'Views' }, ...TABS.map(([k, label, icon]) => el('button', { type: 'button', class: 'tv-tab', 'data-k': `tab:${k}`, 'aria-pressed': String(tabOf(S.view) === k), title: label, onclick: () => move(VIEW_ORDER.indexOf(k) >= VIEW_ORDER.indexOf(S.view) ? 'next' : 'prev', () => { S.view = k; }) }, ico(icon, 15), el('span', 'tv-tab-long', label)))) : el('span', ''),
    el('div', 'tv-bar-acts', S.data ? T.presenceBar() : null,
      !STANDALONE && (S.data || S.newTrip || S.ptoOpen) ? el('button', { type: 'button', class: 'tv-pill', 'data-k': 'home', onclick: goHome }, ico('list', 14), 'Trips') : null,
      S.data ? pick : null, S.trips.length || S.data ? P.newTripButton('tv-pill') : null, // always one tap away (owner, 2026-10-29: "why is it so hard to create a new trip")
      S.data ? el('button', { type: 'button', class: `tv-pill tv-groupbtn${S.view === 'group' ? ' on' : ''}`, 'data-k': 'tab:group', 'aria-pressed': String(S.view === 'group'), title: 'Group: who’s on this trip', onclick: () => move('next', () => { S.view = S.view === 'group' ? 'workspace' : 'group'; }) }, ico('chat', 14), el('span', 'tv-tab-long', 'Group')) : null,
      S.data && !S.member && S.edited && S.edited.has(S.id) ? el('button', { type: 'button', class: 'tv-pill', 'data-k': 'undo', title: 'Undo the last change', onclick: () => undo() }, 'Undo') : null,
      S.data ? tripTools() : null,
      !STANDALONE && (S.trips.length || S.data) ? BETA.wrongButton('tv-pill') : null,
      el('button', { type: 'button', class: 'tv-pill tv-askbtn', 'data-k': 'ask', 'aria-pressed': String(matchMedia('(max-width: 900px)').matches ? document.body.classList.contains('travel-chat') : !document.body.classList.contains('travel-chat-hidden')), onclick: () => toggleChat() }, ico('spark', 14), 'Ask Eden'),
      STANDALONE ? accountMenu() : el('button', { type: 'button', class: 'tv-x', 'aria-label': 'Close Eden Travel', onclick: closeTravel }, ico('x', 16))));
}
// Ask Eden while its panel is closed: a button floating at the pane's corner (outside the bar, whose blur would hold it)
const askFab = () => el('button', { type: 'button', class: 'tv-askfab', 'data-k': 'ask:fab', 'aria-label': 'Open Ask Eden', onclick: toggleChat }, ico('spark', 14), 'Ask Eden');

// the travel address's account menu: Eden itself (the same account), the trip picker on a phone, a new chat, signing out
// (the trip's own tools are in Trip tools)
function accountMenu() {
  return menu('account', { label: 'Account', cls: 'tv-x', icon: 'user', items: [
    { k: 'mi:eden', icon: 'ext', label: 'Open Eden', sub: 'The same account', run: () => { window.open('https://askeden.com/', '_blank', 'noopener'); } },
    { k: 'mi:wrong', icon: 'info', label: 'Something’s wrong? Tell us', run: () => BETA.openWrong() },
    { k: 'mi:newchat', icon: 'plus', label: 'New Ask Eden chat', run: () => { document.dispatchEvent(new CustomEvent('eden:new-chat')); document.body.classList.remove('travel-chat-hidden'); } },
    { k: 'mi:signout', icon: 'user', label: 'Sign out', run: async () => { await forgetTravelDevice(); try { await fetch('/api/web/signout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', credentials: 'same-origin' }); } finally { location.replace('/'); } } },
  ], extra: (S.trips.length + (S.shared || []).length) > 1 ? el('label', { class: 'tv-menu-row tv-menu-phone' }, ico('list', 14), tripPicker('tv-menu-pick')) : null });
}

// one panel from Trip tools at a time: opening one closes the others (what was typed in a form is kept: keep())
function closeTools() {
  S.linkOpen = S.calOpen = S.cardsOpen = S.accOpen = S.packOpen = S.ptoOpen = S.copyOpen = S.promiseOpen = S.esimOpen = S.entryOpen = S.yearOpen = S.coversOpen = false;
  RW.close?.();
  S.leg = null; S.newTrip = null;
  if (S.profile) S.profile.open = false;
}
const tool = (on, open) => () => { const was = on(); closeTools(); if (!was) { S.view = 'workspace'; open(); } paint(); }; // its panel is in the day view

/** Trip tools: everything about the whole trip that isn't the day, in one menu (each opens its panel under the photo). */
function tripTools() {
  const { trip } = S.data;
  const own = !S.member && !S.offline;
  const stepFree = Boolean(trip.access && trip.access.step_free);
  return menu('trip', { label: 'Trip tools', text: 'Trip tools', icon: 'sliders', items: [
    { head: 'This trip' },
    !S.member ? { k: 'share', icon: 'ext', label: 'Share with the people on it', sub: 'A link to the plan, and invites to plan together', focus: '.tv-share-sheet', run: tool(() => S.linkOpen, () => { S.linkOpen = true; openShare(); }) } : null,
    !S.offline ? { k: 'copy', icon: 'copy', label: 'Copy as a new trip', focus: '.tvt-copy', run: tool(() => S.copyOpen, () => { S.copyOpen = true; }) } : null,
    !S.member ? { k: 'cal', icon: 'cal', label: 'Add to your calendar', focus: '.tv-cal', run: tool(() => S.calOpen, () => openCal(true)) } : null,
    { k: 'plan:print', icon: 'doc', label: 'Print or save as PDF', run: () => P.print(trip) },
    own && !(S.edited && S.edited.has(S.id)) ? { k: 'undo:menu', icon: 'retry', label: 'Undo the last change', run: () => undo() } : null, // in the bar once something changed here
    { head: 'Planning' },
    own ? { k: 'plan:leg', icon: 'route', label: 'Travel to another city', sub: 'A flight, train, bus or drive you enter', focus: '.tv-legform', run: tool(() => Boolean(S.leg), () => P.toggleLeg()) } : null,
    { k: 'plan:pack', icon: 'check', label: 'Packing list', focus: '.tv-pack', run: tool(() => S.packOpen, () => P.togglePack()) },
    { k: 'pto', icon: 'cal', label: 'Best time to go', sub: 'Your days off, around public holidays', focus: '.tv-pto-sheet', run: tool(() => S.ptoOpen, () => { S.ptoOpen = true; }) },
    !S.member ? { k: 'entry', icon: 'globe', label: 'Passports and entry', sub: 'From the official rules, with deadlines', focus: '.tv-entry', run: tool(() => S.entryOpen, () => { S.entryOpen = true; EN.loadEntry(S.id); }) } : null,
    !S.member ? { k: 'esim', icon: 'globe', label: 'Mobile data (eSIM)', focus: '.tv-esim-sheet', run: tool(() => S.esimOpen, () => { S.esimOpen = true; }) } : null,
    own ? { k: 'stepfree', icon: 'route', label: 'Step-free checks', sub: 'Every entrance checked; less walking', checked: stepFree, run: () => M.toggleStepFree(trip) } : null,
    !S.member ? { k: 'cards', icon: 'lock', label: 'Which card to pay with', sub: 'From the issuers’ published rates', focus: '.tv-cards', run: tool(() => S.cardsOpen, () => { S.cardsOpen = true; }) } : null,
    { head: 'Plus perks' },
    !S.member ? { k: 'promise', icon: 'spark', label: 'The Eden Price Promise', sub: 'Every price watched; rebook when it drops', focus: '.tv-promise-sheet', run: tool(() => S.promiseOpen, () => { S.promiseOpen = true; }) } : null,
    !S.member ? { k: 'rewards', icon: 'star', label: 'Eden Rewards', sub: 'Points and your travel status', focus: '.tv-rewards', run: () => { closeTools(); S.view = 'workspace'; RW.openRewards(); } } : null,
    { k: 'covers', icon: 'shield', label: 'What Plus covers on this trip', focus: '.tv-covers-sheet', run: tool(() => S.coversOpen, () => { S.coversOpen = true; }) },
    !S.member ? { k: 'year', icon: 'chart', label: 'Your year in travel', focus: '.tv-year-sheet', run: tool(() => S.yearOpen, () => { S.yearOpen = true; }) } : null,
    { head: 'You', cls: S.member ? 'tv-menu-phone' : '' },
    !S.member ? { k: 'profile', icon: 'user', label: 'Travel profile', sub: 'Loyalty numbers, bookings from your email', focus: '.tv-profile', run: tool(() => Boolean(S.profile && S.profile.open), () => ACC.openProfile()) } : null,
    !S.member ? { k: 'mi:acc', icon: 'shield', label: 'How accurate Eden’s checks are', focus: '.tv-disc.tv-sheet', run: tool(() => S.accOpen, () => { S.accOpen = true; }) } : null,
    { k: 'plan:new:menu', icon: 'plus', label: 'New trip', focus: '.tv-newform', run: tool(() => Boolean(S.newTrip), () => P.toggleNewTrip()) },
  ] });
}

function paint() {
  if (!S.pane) return;
  // the focused control comes back after the pane is redrawn (a keyboard or screen-reader user keeps their place)
  const wasIn = S.pane.contains(document.activeElement);
  const had = wasIn && document.activeElement.dataset ? document.activeElement.dataset.k : null;
  // a panel that has the focus itself (opened from a menu) keeps it: found again by its name
  const panelHad = wasIn && !had && document.activeElement.matches('section[aria-label][tabindex="-1"]') ? document.activeElement.getAttribute('aria-label') : null;
  paintPane();
  S.pane.append(askFab());
  // a form that closed takes focus again when it next opens
  if (S.focused) for (const k of S.focused) if (!S.pane.querySelector(`[data-k="f:${CSS.escape(k)}"]`)) S.focused.delete(k);
  // offline (the trip as saved on this device): actions that need the server wait for the connection; reading stays
  if (S.offline) for (const b of S.pane.querySelectorAll('.tv-noticed button, .tv-stop .tv-acts button, .tv-day-head .tv-pill')) { b.disabled = true; b.title = 'Back online to do this'; }
  if (had) { const again = S.pane.querySelector(`[data-k="${CSS.escape(had)}"]`); if (again) again.focus(); }
  if (panelHad) { const again = S.pane.querySelector(`section[aria-label="${CSS.escape(panelHad)}"]`); if (again) { again.setAttribute('tabindex', '-1'); again.focus({ preventScroll: true }); } }
  // a menu just opened: its first item; a menu item's panel: the panel (a form in it may take the focus after);
  // a panel just closed (its control gone): back to the menu that opened it, never lost to the page
  if (S.menuFocus) { S.menuFocus = false; S.pane.querySelector('.tv-menu [role^="menuitem"]')?.focus(); }
  else if (S.focusNext) {
    const n = S.pane.querySelector(S.focusNext); S.focusNext = null;
    if (n) { if (!n.hasAttribute('tabindex')) n.setAttribute('tabindex', '-1'); n.focus(); }
  } else if (wasIn && !S.pane.contains(document.activeElement) && S.returnTo) S.pane.querySelector(`[data-k="${CSS.escape(S.returnTo)}"]`)?.focus();
}

function paintPane() {
  // entrances play only when the trip, the view or the day changes, never on a repaint (a forecast arriving, a keystroke)
  const enter = `${S.id}|${S.view}|${S.day}|${S.home ? 'home' : ''}`; // (the home after the loading screen counts as a change)
  if (enter !== S.enterKey) S.enterAt = Date.now();
  S.pane.classList.toggle('tv-enter', Date.now() - (S.enterAt || 0) < 900); // a repaint mid-entrance (the next trip's checks arriving) lets it finish
  S.enterKey = enter;
  // the chat asks about the trip on show (composer.js: its placeholder and + menu; render.js: its suggestions)
  const shown = S.data ? city(S.data.trip) : '';
  if (document.body.dataset.tripCity !== shown) { document.body.dataset.tripCity = shown; document.dispatchEvent(new CustomEvent('eden:trip-shown')); }
  if (S.plus === false && !S.member && !S.joining) {
    // Eden Travel is part of Eden Plus (the server refuses trip actions without it). In the travel iPhone app, no web
    // purchase link (App Store rules): Plus is bought in the Eden app.
    S.pane.replaceChildren(topbar(), el('div', 'tv-scroll', hero(null), el('div', 'tv-empty glass-card',
      el('h2', '', 'Eden Travel is part of Eden Plus'),
      el('p', '', 'Plan whole trips with every hour, price and travel time checked against its source, book flights and stays, track flights live and share the trip with the people on it. One membership for all of Eden.'),
      IN_TRAVEL_APP ? el('p', 'tv-note', 'Get Plus in the Eden iPhone app, then sign in here with the same account.')
        : el('div', 'tv-acts', el('button', { type: 'button', class: 'tv-btn primary', onclick: () => location.assign(STANDALONE ? 'https://askeden.com/?plus=1#plus' : '/?plus=1#plus') }, 'Get Eden Plus')))));
    return;
  }
  if (S.joining) { S.pane.replaceChildren(topbar(), el('div', 'tv-scroll', hero(null), joinCard())); return; }
  // the trips still on their way: the photo alone (never a flash of "plan your first trip" to someone who has trips)
  if (!S.data && (!S.loaded || S.opening)) {
    S.pane.replaceChildren(topbar(), el('div', { class: 'tv-scroll', 'aria-busy': 'true' }, hero(null), el('p', { class: 'tv-loading', role: 'status' }, S.trips.length ? 'Opening your trip…' : 'Opening Eden Travel…')));
    return;
  }
  // the home (travel-home.js); New trip from it opens the planning panels below
  if (!S.data && !S.newTrip && !S.ptoOpen) { S.pane.replaceChildren(topbar(), el('div', 'tv-scroll tvh-scroll', ...H.home())); return; }
  // a new trip from the home: one sentence, Eden's checked plan in place, then Create (the form, a list or the sample stay one press away)
  if (!S.data) {
    S.pane.replaceChildren(topbar(), el('div', 'tv-scroll', hero(null), ...(!S.newTrip ? [] : quickShown() ? [quickStart({ first: true })] : [P.newTripPanel()]), S.ptoOpen ? sheet('tv-pto-sheet', 'Best time to go', () => { S.ptoOpen = false; }, PTO.ptoPanel()) : null));
    return;
  }
  const view = { workspace, board, map: () => [hero(S.data.trip), ...explorer()], companion, discover: () => [hero(S.data.trip), ...M.discover(), A.toursSection()], group: M.group, memories: MEM.memories }[S.view] || workspace;
  S.pane.replaceChildren(topbar(), el('div', 'tv-scroll', ...view().flat().filter(Boolean)));
}

/* ---------- planning a trip from one sentence (the first thing a new person sees; New trip opens it too) ---------- */

// The planner is the New trip form's "Let Eden plan it" (trip-ui.js tripPlan; site travel/planner.js): drafted with web
// search, each place checked on Google Maps. Its answer shows in place as that form's plan card (travel-plan.js), whose
// Create makes the trip; nothing is saved before. The form itself, a list or screenshot, and the sample stay one press away.
const EXAMPLES = ['4 days in Lisbon in May', 'A long weekend in Kyoto', 'Paris with kids, Easter'];
// New trip (or nothing yet) shows this prompt; the plan it made, or the form when asked for, shows travel-plan.js's panel
const quickShown = () => Boolean(S.newTrip && !S.newTrip.plan && !S.newTrip.form);
function planPanels(trip) {
  if (!quickShown()) { S.quickFocused = false; return P.tripPanels(trip); }
  const nt = S.newTrip; S.newTrip = null; // the prompt stands in for the form's panel; the leg and packing panels stay
  try { return [quickStart({ first: false }), ...P.tripPanels(trip)]; } finally { S.newTrip = nt; }
}
function quickStart({ first }) {
  const q = S.quick || (S.quick = {});
  if (!S.form) S.form = {};
  const busy = Boolean(q.planning);
  const input = el('input', { type: 'text', class: 'tv-quick-input', 'data-k': 'f:quick', maxlength: '300', autocomplete: 'off', enterkeyhint: 'go', placeholder: '4 days in Lisbon in May', 'aria-label': 'Where to, and when?', 'aria-describedby': 'tv-quick-lede', ...(q.err ? { 'aria-invalid': 'true' } : {}), ...(busy ? { disabled: '' } : {}) });
  input.value = S.form.quick || '';
  input.addEventListener('input', () => { S.form.quick = input.value; if (q.err) { q.err = null; input.removeAttribute('aria-invalid'); } });
  if (!first && !S.quickFocused) { S.quickFocused = true; setTimeout(() => input.focus(), 0); } // opened from New trip: straight in
  const go = async (e) => {
    e.preventDefault();
    const request = String(S.form.quick || '').trim();
    if (request.length < 3) { q.err = 'Say where, and when or for how long: “4 days in Lisbon in May”.'; paint(); S.pane.querySelector('[data-k="f:quick"]')?.focus(); return; }
    q.planning = true; q.err = null; S.focusNext = '.tv-quick-busy'; paint(); // the field is disabled meanwhile: the focus waits on the status
    try {
      // the planner as a job (travel-plan.js planWithEden): the sketch, the draft and each check tick in, then Create
      await P.planWithEden({ request }, { quick: true });
      S.quick = {};
      S.focusNext = '.tv-newform';
    } catch (x) { q.planning = false; q.err = String((x && x.message) || x); }
    paint();
  };
  const example = (t) => el('button', { type: 'button', class: 'tv-quick-ex', disabled: busy ? '' : null, onclick: (e) => {
    S.form.quick = e.currentTarget.textContent; q.err = null; paint(); // the words as shown (French when the page is)
    const n = S.pane.querySelector('[data-k="f:quick"]'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
  } }, t);
  const quiet = (label, icon, run) => el('button', { type: 'button', class: 'tv-btn quiet', disabled: busy ? '' : null, onclick: run }, ico(icon, 14), label);
  return el('section', { class: `glass-card tv-quick tv-newform${first ? ' first' : ''}`, 'aria-label': first ? 'Plan a trip' : 'Plan another trip', 'aria-busy': busy ? 'true' : null },
    first ? null : el('div', 'tv-card-head', el('span', 'tv-kicker accent', 'Plan another trip'), el('button', { type: 'button', class: 'tv-x', 'aria-label': 'Close plan another trip', 'data-k': 'close:quick', onclick: () => { S.newTrip = null; S.quickFocused = false; paint(); } }, ico('x', 14))),
    el('h2', '', 'Where to, and when?'),
    el('p', { class: 'tv-quick-lede', id: 'tv-quick-lede' }, 'Say it in one sentence. Eden plans the days, then checks every opening hour, travel time and price against its source, and shows when. Nothing is saved until you press Create.'),
    el('form', { class: 'tv-quick-form', onsubmit: go, novalidate: '' }, input,
      el('button', { type: 'submit', class: 'tv-btn primary', 'data-k': 'quick:go', disabled: busy ? '' : null }, ico('spark', 14), busy ? 'Planning…' : 'Plan it')),
    q.err ? el('p', { class: 'tv-note warn', role: 'alert' }, q.err) : null,
    busy ? el('div', { class: 'tv-quick-busy', role: 'status' },
      el('div', { class: 'tv-quick-bar', 'aria-hidden': 'true' }, el('span', '')),
      el('p', '', 'A minute or two. Eden drafts the days with web search, then checks each place on Google Maps: open that day and at that time, not closed for good, and the travel time between.'))
      : el('div', { class: 'tv-quick-exs', role: 'group', 'aria-label': 'Examples' }, ...EXAMPLES.map(example)),
    el('div', 'tv-quick-more',
      quiet('Fill in the details', 'edit', () => { S.newTrip = { form: true }; S.view = 'workspace'; S.focusNext = '.tv-newform'; paint(); }),
      quiet('From a list or screenshot', 'clip', () => ask('Make a trip from what I have (I’ll paste a list, a link or attach a screenshot or PDF): ')),
      quiet('Best time to go', 'cal', () => { S.ptoOpen = true; paint(); }),
      first ? quiet('See a sample trip', 'globe', sample) : null));
}

/* the photo header */
// the destination's photo: a licensed Wikimedia Commons picture (author and licence shown on it), fetched once per place;
// with none, the plane photo stays. The slow zoom plays once per photo, never again on a repaint.
function heroPhoto(place) {
  if (!place) return null;
  if (!S.heroes) S.heroes = new Map();
  if (!S.heroes.has(place)) {
    S.heroes.set(place, undefined);
    getJSON(`/api/chat/travel/hero?q=${encodeURIComponent(place)}`, { timeout: 10_000 })
      .then((r) => { const h = r && r.hero !== undefined ? r.hero : r; S.heroes.set(place, h && h.url ? h : null); if (h && h.url) paint(); }) // { hero } from the server
      .catch(() => S.heroes.set(place, null));
  }
  return S.heroes.get(place) || null;
}

function hero(trip) {
  const ch = S.data && S.data.checks;
  const photo = trip ? heroPhoto(city(trip)) : null;
  // the zoom runs its 18 s once per photo; a repaint meanwhile (the forecast arriving) picks it up where it was
  if (!S.kbSeen) S.kbSeen = new Map();
  if (photo && !S.kbSeen.has(photo.url)) S.kbSeen.set(photo.url, Date.now());
  const kbAt = photo ? Date.now() - S.kbSeen.get(photo.url) : Infinity;
  const kb = kbAt < 18_000;
  const https = (u) => (typeof u === 'string' && /^https:\/\//.test(u) ? u : null);
  const first = ch && ch.days[0] && ch.days[0].date, last = ch && ch.days.at(-1) && ch.days.at(-1).date;
  const sources = [S.maps === 'google' ? 'Google Maps' : 'Sample map data', S.data && S.flights ? 'Duffel' : null, 'FlightAware'].filter(Boolean);
  return el('section', { class: `tv-hero${photo ? ' has-photo' : ''}`, role: 'banner' },
    photo ? el('img', { class: `tv-hero-img${kb ? ' tv-kb' : ''}`, src: apiUrl(`/api/chat/travel/hero-image?u=${encodeURIComponent(photo.url)}`), alt: '', decoding: 'async', ...(kb && kbAt > 50 ? { style: { animationDelay: `-${kbAt}ms` } } : {}) }) : null,
    photo ? el('span', { class: 'tv-hero-credit', 'data-no-i18n': '' }, 'Photo: ',
      https(photo.file_page) ? el('a', { href: photo.file_page, target: '_blank', rel: 'noopener' }, photo.author || 'Wikimedia Commons') : (photo.author || 'Wikimedia Commons'),
      photo.licence ? ' · ' : '', photo.licence ? (https(photo.licence_url) ? el('a', { href: photo.licence_url, target: '_blank', rel: 'noopener license' }, photo.licence) : photo.licence) : '',
      ' · Wikimedia Commons') : null,
    el('div', 'tv-hero-text',
      el('h1', '', trip ? trip.title : 'Your trip'),
      trip ? el('p', 'tv-hero-sub', [`${dayLong(first)}${last && last !== first ? ` – ${dayLong(last)}` : ''}`, `${trip.days.length} day${trip.days.length === 1 ? '' : 's'}`, trip.travelers === 1 ? 'You' : trip.travelers === 2 ? 'You + 1' : `You + ${trip.travelers - 1}`].join(' · ')) : null,
      trip ? el('div', 'tv-hero-chips',
        chip({ unhurried: 'Unhurried', full: 'Full days', rushed: 'Rushed' }[ch.pace] || ch.pace, `pace-${ch.pace}`),
        ch.cost.amount || ch.cost.budget ? chip(`${money(ch.cost.amount, ch.cost.currency)}${ch.cost.budget ? ` of ${money(ch.cost.budget.amount, ch.cost.budget.currency)}` : ''}`, ch.cost.over ? 'warn' : '') : null, // no prices yet: no "€0"
        chip(sources.join(' · '), S.maps === 'google' ? 'live' : 'sample')) : null));
}

/* Workspace: what Eden noticed (with before and after), the pay-with plan, the day */
function memberNote() {
  const w = S.data.waiting;
  return el('div', { class: 'tv-offline glass-card', role: 'status' }, ico('user', 14),
    el('span', '', `Shared with you. Ask Eden to suggest a change: the organiser decides.${w ? ` Waiting for them: “${w.title}”.` : ''}`),
    el('button', { type: 'button', class: 'tv-btn quiet', onclick: async () => { if (!confirm('Leave this trip? You won’t see it any more.')) return; await tripPost('shared-leave', { owner: S.member.owner, trip: S.member.trip }).catch(() => {}); S.member = null; S.data = null; S.id = null; document.body.classList.remove('travel-member'); setViewing(null); loadList(); } }, 'Leave'));
}

function offlineNote() {
  if (!S.offline) return null;
  return el('div', { class: 'tv-offline glass-card', role: 'status' }, ico('info', 14),
    el('span', '', `Offline: your trip as saved on this device ${new Date(S.offline).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}. Hours, travel times and flights are checked again when you’re back online.`));
}

// The day view, first view: the photo header, then (only when opened from Trip tools) one trip-wide panel, what needs
// the person (Eden noticed, with the rest folded under it), and the day. Everything else is one press away.
function toolPanels(trip) {
  const covers = S.coversOpen ? sheet('tv-covers-sheet', 'What Plus covers', () => { S.coversOpen = false; }, PK.coversPanel()) : null;
  const pto = S.ptoOpen ? sheet('tv-pto-sheet', 'Best time to go', () => { S.ptoOpen = false; }, PTO.ptoPanel()) : null;
  if (S.member) return [...planPanels(trip), T.copyPanel(trip), covers, pto];
  return [S.calOpen ? calendarPanel() : null, S.linkOpen ? linkPanel(trip) : null, S.cardsOpen ? el('div', 'tv-stack', cardsPanel(), PK.cardPerkPanel()) : null, ACC.profilePanel(), RW.rewardsPanel(),
    S.promiseOpen ? sheet('tv-promise-sheet', 'The Eden Price Promise', () => { S.promiseOpen = false; }, PR.promisePanel()) : null,
    S.esimOpen ? sheet('tv-esim-sheet', 'Mobile data', () => { S.esimOpen = false; }, ES.mobileDataSection()) : null,
    S.entryOpen ? sheet('tv-entry-sheet', 'Passports and entry', () => { S.entryOpen = false; }, EN.entryChecklist() || el('p', 'tv-note', 'Checking the official rules…')) : null,
    S.yearOpen ? sheet('tv-year-sheet', 'Your year in travel', () => { S.yearOpen = false; }, PK.yearPanel()) : null, covers, pto,
    S.accOpen ? AC.accuracySection({ onClose: () => { S.accOpen = false; paint(); } }) : null, ...planPanels(trip), T.copyPanel(trip)];
}

function planSwitch() {
  const on = S.view === 'board' ? 'board' : 'workspace';
  return el('div', { class: 'tv-seg2', role: 'group', 'aria-label': 'Show' }, ...[['workspace', 'Day'], ['board', 'All days']].map(([k, label]) =>
    el('button', { type: 'button', 'data-k': `plan:${k}`, 'aria-pressed': String(on === k), onclick: () => { if (on !== k) move(k === 'board' ? 'next' : 'prev', () => { S.view = k; }); } }, label)));
}

function workspace() {
  const { trip, checks } = S.data;
  // the notes sit under the photo header: above it they'd be under the floating bar
  if (S.member) return [hero(trip), memberNote(), offlineNote(), ...toolPanels(trip), attention(trip, checks), planSwitch(), daySection(trip, checks)];
  return [hero(trip), offlineNote(), ...toolPanels(trip), MEM.memoriesCard(trip, { onOpen: () => move('next', () => { S.view = 'memories'; }) }), CL.claimsCard(), attention(trip, checks), planSwitch(), daySection(trip, checks)];
}

/** A trip-wide panel opened from Trip tools: its name and a close button that gives the focus back to the menu. */
function sheet(cls, title, onClose, ...body) {
  return el('section', { class: `glass-card tv-sheet ${cls}`, 'aria-label': title },
    el('div', 'tv-card-head', el('span', 'tv-kicker accent', title),
      el('button', { type: 'button', class: 'tv-x', 'aria-label': `Close ${title.toLowerCase()}`, 'data-k': `close:${cls}`, onclick: () => { onClose(); paint(); } }, ico('x', 14))),
    ...body);
}

function noticed(trip, checks) {
  const p = S.data.proposal;
  // price protection (site travel/stayops.js): a booked hotel cheaper now, while it still cancels for free
  const drop = (S.data.price_drops || [])[0];
  if (drop && !(p && p.after)) {
    return el('section', { class: 'tv-noticed glass-card', 'aria-label': 'A lower price on your hotel' },
      el('div', 'tv-noticed-text',
        el('span', 'tv-kicker accent', ico('spark', 12), 'Eden noticed · price drop'),
        el('h2', '', `${drop.hotel} is ${drop.by} ${drop.currency} cheaper now`),
        el('p', '', `You paid ${drop.was} ${drop.currency}; the same dates are ${drop.now} ${drop.currency} now on ${drop.source} (checked ${String(drop.checked_at).slice(0, 16).replace('T', ' ')} UTC). Free cancellation until ${String(drop.rebook_before).slice(0, 16).replace('T', ' ')} UTC.`),
        el('div', 'tv-acts', el('button', { type: 'button', class: 'tv-btn primary', onclick: () => { S.promiseOpen = true; PR.openRebook(drop.booking_id); } }, 'Rebook with Eden'))));
  }
  if (p && p.after) {
    // the before and after of the day it changes most (both from the server: the trip now, and the proposal's own result)
    const changedDay = p.after.days.findIndex((d, i) => JSON.stringify(d.stops.map((s) => [s.id, s.at])) !== JSON.stringify((trip.days[i] || { stops: [] }).stops.map((s) => [s.id, s.at])));
    const di = changedDay >= 0 ? changedDay : S.day;
    const col = (label, stops, after) => el('div', { class: `tv-ba-col${after ? ' after' : ''}` }, el('span', 'tv-kicker', label),
      el('ol', '', ...stops.map((s) => el('li', '', thumb(s, 'tv-ba-art'), el('b', '', s.at), el('span', '', s.place.name)))));
    return el('section', { class: 'tv-noticed glass-card', 'aria-label': `Eden proposes: ${p.title}` },
      el('div', 'tv-noticed-text',
        el('span', 'tv-kicker accent', ico('spark', 12), `${p.by === 'member' ? `${p.by_name || 'Someone on the trip'} suggests` : 'Eden proposes'} · Day ${di + 1}`),
        el('h2', '', p.title),
        p.reason ? el('p', '', p.reason) : null,
        el('div', 'tv-acts',
          el('button', { type: 'button', class: 'tv-btn primary', onclick: async (e) => { e.target.disabled = true; try { await tripPost('apply', { id: S.id, proposal: p.id, confirm: true }); toast('Applied'); } catch (err) { toast(String(err.message || err)); e.target.disabled = false; } } }, 'Apply'),
          el('button', { type: 'button', class: 'tv-btn quiet', onclick: async () => { await tripPost('discard', { id: S.id, proposal: p.id }).catch(() => {}); } }, 'Not now'))),
      el('div', 'tv-ba', col('Before', (trip.days[di] || { stops: [] }).stops, false), col('After', (p.after.days[di] || { stops: [] }).stops, true)));
  }
  if (!checks.alerts.length) return null;
  const a = checks.alerts[0];
  return el('section', { class: 'tv-noticed glass-card one', 'aria-label': 'Eden noticed' },
    el('div', 'tv-noticed-text',
      el('span', 'tv-kicker accent', ico('spark', 12), `Eden noticed · Day ${a.day + 1}`),
      el('h2', '', a.text),
      el('div', 'tv-acts', a.kind === 'replace' && !S.member ? leadReplace(trip, checks, a)
        : el('button', { type: 'button', class: 'tv-btn primary', onclick: () => ask(fixText(trip, a, true)) }, S.member ? 'Suggest a fix' : 'Fix with Eden'))));
}
function leadReplace(trip, checks, a) {
  const d = trip.days[a.day] || { stops: [] }, k = d.stops.findIndex((x) => x.id === a.stop);
  const r = ((checks.days[a.day] || {}).stops || [])[k]?.badges?.replace, s = d.stops[k];
  if (!s) return null;
  return el('button', { type: 'button', class: 'tv-btn primary', onclick: () => { S.day = a.day; replaceStop(trip, s, r && r.suggestion); } }, r && r.suggestion ? `Use ${r.suggestion.name}` : 'Find one');
}
const stopName = (trip, id) => (trip.days.flatMap((d) => d.stops).find((s) => s.id === id) || { place: { name: '' } }).place.name;
const fixText = (trip, a, named) => (S.member ? `On the shared trip “${trip.title}”, suggest a fix to the organiser for this: ${a.text} (${stopName(trip, a.stop)}).` : `On ${tripRef(trip)}, fix this: ${a.text}${named ? ` (${stopName(trip, a.stop)})` : ''}. Propose a change.`);

/** What needs the person: Eden noticed's one lead (a price drop, a proposal or the first alert, with its primary
 *  button), and under it the rest folded into one line that opens to the list. */
function attention(trip, checks) {
  const lead = noticed(trip, checks);
  const todo = todoList(trip, checks, Boolean(lead));
  if (!lead) return todo ? el('section', { class: 'tv-noticed glass-card one tv-todo-only', 'aria-label': 'Still to decide' }, todo) : null;
  if (todo) lead.append(todo);
  return lead;
}

/* the card optimizer: which saved card to pay each item with (the issuers' published rates, from the server) */
function cardsPanel() {
  const rewards = (S.data && S.data.rewards) || [];
  const box = sheet('tv-cards', 'Which card to pay with', () => { S.cardsOpen = false; S.cardsEdit = false; });
  // the names form: open until cards are saved, then behind "Change your cards"
  const editing = S.cardsEdit || (!rewards.length && !(S.cardsNames || '').trim());
  if (editing) box.append(cardsForm());
  else box.append(el('div', 'tv-acts', el('button', { type: 'button', class: 'tv-pill', 'data-k': 'cards-edit', onclick: () => { S.cardsEdit = true; paint(); } }, ico('edit', 12), 'Change your cards')));
  if (!rewards.length) { box.append(el('p', 'tv-note', 'Add your cards (names only) to see which one earns most on each booking.')); return box; }
  const { plan, none } = TT.cardPlan(rewards);
  for (const g of plan) {
    box.append(el('div', 'tv-cardrow',
      el('div', '', el('b', '', g.card), el('div', 'tv-note', `${g.items.join(', ')} · ${money(g.spend, g.currency)}`), el('div', 'tv-note', g.rates.join(' · '))),
      el('div', { class: 'tv-cardval', title: `Rates from ${g.source}, checked ${g.checked}${g.stale ? ' (more than 90 days ago: may have changed)' : ''}` },
        g.value != null ? el('b', '', `≈ ${money(g.value, g.currency)} back`) : el('span', 'tv-note', 'value not stated by the issuer'),
        el('small', '', `checked ${g.checked}${g.stale ? ' · old' : ''}`))));
  }
  if (none.length) box.append(el('p', 'tv-note', `No checked rates for your cards on: ${none.join(', ')}.`));
  box.append(el('p', 'tv-fine', 'From each issuer’s published earn rates; a comparison, not financial advice. Charges in other currencies are converted by your card.'));
  return box;
}
function cardsForm() {
  const input = el('input', { type: 'text', placeholder: 'Card names, comma-separated: Sapphire Reserve, Amex Gold', 'aria-label': 'Your card names', maxlength: '400' });
  const save = async (e) => {
    e.preventDefault();
    const names = input.value.split(',').map((x) => x.trim()).filter(Boolean);
    if (!names.length) return input.focus();
    try { await tripPost('cards-save', { names, confirm: true }); S.cardsEdit = false; S.cardsNames = names.join(', '); delete S.form.cards; toast('Cards saved'); paint(); } catch (err) { toast(String(err.message || err)); }
  };
  keep(input, 'cards');
  if (S.cardsNames == null) { S.cardsNames = ''; tripPost('cards', {}).then((r) => { S.cardsNames = (r.cards || []).map((c) => c.name).join(', '); if (!input.value) input.value = S.cardsNames; }).catch(() => {}); } // asked once
  else if (!input.value) input.value = S.cardsNames;
  return el('form', { class: 'tv-form', onsubmit: save }, input, el('button', { type: 'submit', class: 'tv-btn primary' }, 'Save'), el('p', 'tv-note', 'Names only: Eden never asks for or keeps card numbers.'));
}

/* the day: tabs, its numbers, the timeline beside the map */

/** The day's Add menu: a stop by hand (a Google place search) or a booking from its confirmation email; someone the
 *  trip is shared with asks Eden to suggest one instead. */
function addMenu(trip) {
  if (S.offline) return null;
  if (S.member) return el('button', { type: 'button', class: 'tv-pill', 'data-k': 'suggest-stop', onclick: () => ask(`Add something to Day ${S.day + 1} of ${tripRef(trip)}: find a good place near my other stops, with real hours, and propose it.`) }, ico('plus', 13), 'Suggest a stop');
  const only = (k) => { S.adding = k === 'stop' ? S.adding : null; S.addBooking = k === 'booking' ? S.addBooking : null; };
  return menu('add', { label: 'Add to this day', text: 'Add', icon: 'plus', cls: 'tv-pill tv-addbtn', items: [
    { k: 'plan:add', icon: 'search', label: 'A stop', sub: 'Search for a place and set its time', focus: '.tv-addform', run: () => { only('stop'); if (!S.adding) P.toggleAdd(); } },
    { k: 'addbooking', icon: 'mail', label: 'A booking', sub: 'Paste or forward its confirmation email', focus: '.tv-bookin', run: () => { only('booking'); if (!S.addBooking) S.addBooking = { tab: 'paste' }; } },
    { k: 'ask-stop', icon: 'spark', label: 'Ask Eden for ideas', sub: 'A good place near your other stops', run: () => ask(`Add something to Day ${S.day + 1} of ${tripRef(trip)}: find a good place near my other stops, with real hours, and propose it.`) },
  ] });
}
// Shorter order shows when it can help: 3+ sights or activities that aren't booked, two of them in a row (the server
// reorders runs of free stops between fixed ones: site travel/plan.js freeRuns)
function reorderable(stops) {
  const free = stops.map((s) => (s.kind === 'visit' || s.kind === 'activity') && !s.booked && Number.isFinite(s.place && s.place.lat));
  return free.filter(Boolean).length >= 3 && free.some((f, i) => f && free[i + 1]);
}
function daySection(trip, checks) {
  if (!trip.days.length) return el('section', 'tv-day glass-card', el('p', 'tv-note', 'This trip has no days yet. Ask Eden to plan them.'));
  S.day = Math.max(0, Math.min(S.day, trip.days.length - 1));
  const d = trip.days[S.day], c = checks.days[S.day] || { stops: [], move_minutes: 0, cost: { amount: 0, currency: 'EUR' } };
  const paceWord = { unhurried: 'A day with room to wander', full: 'A full day', rushed: 'A rushed day' }[c.pace] || 'The day';
  const stops = d.stops;
  return el('section', { class: 'tv-day glass-card', 'aria-label': `Day ${S.day + 1}` },
    el('div', 'tv-day-head',
      el('div', '', kicker(paceWord, `Day ${S.day + 1}`, dayLong(c.date)), el('h2', '', d.title)),
      el('div', 'tv-day-acts',
        T.mineToggle(trip), // only on a trip shared with people in charge of stops
        reorderable(d.stops) || S.optimizing ? M.shorterButton(trip) : null,
        addMenu(trip))),
    el('div', { class: 'tv-daytabs', role: 'tablist', 'aria-label': 'Days', onkeydown: (e) => { // arrows move between days (one tab stop)
        const to = { ArrowRight: S.day + 1, ArrowLeft: S.day - 1, Home: 0, End: trip.days.length - 1 }[e.key];
        if (to === undefined || to < 0 || to >= trip.days.length || to === S.day) return;
        e.preventDefault(); const b = e.currentTarget.querySelector(`[data-k="day:${to}"]`); b.focus(); b.click(); // focused first: the repaint keeps it there
      } },
      ...trip.days.map((x, i) => el('button', { type: 'button', role: 'tab', 'data-k': `day:${i}`, 'aria-selected': String(i === S.day), tabindex: i === S.day ? '0' : '-1', class: 'tv-daytab', onclick: () => move(i >= S.day ? 'next' : 'prev', () => { S.day = i; setViewing({ id: S.id, title: trip.title, day: i, ...(S.member ? { shared: { owner: S.member.owner, trip: S.member.trip } } : {}) }); }) },
        el('b', '', `Day ${i + 1}`), el('small', '', dayLong(checks.days[i] && checks.days[i].date))))),
    el('div', 'tv-stats',
      chip(`${stops.length} stop${stops.length === 1 ? '' : 's'}`), chip(moveText(c)),
      c.cost.amount ? chip(`~${money(c.cost.amount, c.cost.currency)} for ${trip.travelers === 1 ? 'you' : trip.travelers === 2 ? 'two' : trip.travelers}`) : null, S.maps === 'google' ? null : chip('Sample times', 'note'),
      weatherChip(S.day), M.stepFreeChip(trip)),
    // what the Add menu opened: a stop by hand, or a booking from its email (in the day, where it lands)
    ...P.dayPanels(trip), S.member ? null : M.bookingPanel(trip),
    el('div', 'tv-daygrid',
      timeline(trip, d, c),
      el('div', 'tv-daymap', mapImage(located(stops).map((s) => s.place), { w: 520, h: 600, draw: (over, P) => pins(over, P, located(stops), {
        colorOf: (s) => ((c.stops[stops.indexOf(s)] || {}).alerts || []).length ? '#ff9f0a' : '#0a84ff',
        labelOf: (s) => String(stops.indexOf(s) + 1) }) }),
        el('div', 'tv-mapcap', `Day ${S.day + 1} · ${stops.length} stops · ${moveText(c)}`))),
    el('p', 'tv-fine', 'The pill on each stop shows what was checked: hours, travel time and price, each against its source and time (hover for them). “Sample data” means it was not checked.'));
}

// a leg between two stops, from its check: how, how long, which line (Google's transit details), checked when
const HOWW = { walk: 'walk', transit: 'public transport', drive: 'drive', taxi: 'taxi' };
const MODE_ICON = { walk: 'route', transit: 'route', drive: 'route', taxi: 'route' };
function legRow(trip, s, b) {
  const lines = (b.lines || []).map((l) => [l.vehicle, l.name, l.headsign ? `→ ${l.headsign}` : null].filter(Boolean).join(' ')).filter(Boolean); // Google's own words (no times: the route was asked for now, not the trip's hour)
  const when = b.checked_at ? new Date(b.checked_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;
  const est = Boolean(b.estimate || /estimate/i.test(b.text || '') || /no train times in Japan/i.test(b.source || ''));
  const main = Number.isFinite(b.minutes) ? `${est ? '~' : ''}${b.minutes} min ${HOWW[b.mode || s.mode] || ''}`.trim() : b.text;
  const tight = (b.status === 'look' && (!est || /to spare/i.test(b.text || ''))) || b.status === 'warn';
  const cls = b.status === 'look' && !tight ? 'ok' : b.status;
  return el('li', { class: `tv-leg ${cls}`, 'aria-label': `Getting to ${s.place.name}: ${b.text}` },
    el('span', 'tv-leg-line', ico(MODE_ICON[b.mode || s.mode] || 'route', 12)),
    el('span', 'tv-leg-text', main, lines.length ? el('span', 'tv-leg-lines', ...lines.slice(0, 3).map((l) => el('span', 'tv-line', l))) : null,
      el('small', '', b.status === 'sample' ? 'sample time' : when ? `${b.source || 'checked'} · ${when}` : '')),
    tight && !S.member ? el('button', { type: 'button', class: 'tv-pill', onclick: () => ask(`On ${tripRef(trip)}, the way to ${s.place.name} is tight: ${b.text} Propose a fix.`) }, 'Fix') : null);
}

// a Lisbon sample stop swapped for a real place: the same time, length and kind; Undo puts the sample back
function replaceButton(trip, s, r) {
  const sug = r.suggestion;
  return el('button', { type: 'button', class: 'tv-pill tv-replace', 'data-k': `replace:${s.id}`, onclick: (e) => { e.stopPropagation(); replaceStop(trip, s, sug); } }, sug ? 'Replace' : 'Find one');
}
async function replaceStop(trip, s, sug) {
  const what = s.kind === 'stay' ? 'a hotel' : s.kind === 'meal' ? 'a place to eat' : 'a place';
  if (!sug) return ask(`On ${tripRef(trip)}, Day ${S.day + 1}: "${s.place.name}" is Eden's Lisbon sample data. Find ${what} near that day's other stops to replace it.`);
  const id = S.id;
  try {
    await tripPost('edit', { id, ops: [
      { op: 'add', day: S.day, stop: { kind: s.kind, place: { id: sug.id, name: sug.name, lat: sug.lat, lng: sug.lng }, at: s.at, minutes: s.minutes, mode: s.mode, nights: s.nights || null, note: s.note || '' } },
      { op: 'remove', stop: s.id },
    ] });
    toast(`${sug.name} in place of the sample`, { label: 'Undo', run: () => tripPost('undo', { id }).catch((e) => toast(String(e.message || e))) });
  } catch (e) { toast(String(e.message || e)); }
}

// drag a stop onto another: they swap times; the trip re-checks at once; Undo puts it back
async function swapStops(trip, a, b) {
  if (a.booked || b.booked) { toast('A booked stop keeps its time'); return; }
  const id = S.id; // Undo is for this trip, even if another is on screen by then
  try {
    await tripPost('edit', { id, ops: [{ op: 'time', stop: a.id, at: b.at }, { op: 'time', stop: b.id, at: a.at }] });
    toast(`${a.place.name} now at ${b.at}`, { label: 'Undo', run: () => tripPost('undo', { id }).catch((e) => toast(String(e.message || e))) });
  } catch (e) { toast(String(e.message || e)); }
}

function timeline(trip, d, c) {
  const rewards = new Map(((S.data && S.data.rewards) || []).map((r) => [r.stop, r]));
  const list = el('ol', 'tv-stops');
  d.stops.forEach((s, k) => {
    if (T.hiddenByMine(s)) return; // "Mine": only the stops the person is in charge of (k stays the stop's index for its checks)
    const v = c.stops[k] || { badges: {}, alerts: [] };
    const r = rewards.get(s.id);
    const best = r && r.cards.find((x) => x.known);
    const flight = s.kind === 'transport' && FLIGHT_NO.exec(`${s.place.name} ${s.note || ''}`);
    const open = S.open === s.id || Boolean(flight) || S.marking === s.id;
    const meta = [s.place.address || null, hm(s.minutes), s.cost ? money(s.cost.amount, s.cost.currency) : null].filter(Boolean).join(' · ');
    // the leg from the stop before: how, how long, which line, checked when (a tight one glows, with Eden's fix)
    if (k > 0 && v.badges && v.badges.travel) list.append(legRow(trip, s, v.badges.travel));
    const canDrag = !S.member && !S.offline && !s.booked;
    const row = el('li', { class: `tv-stop${v.alerts && v.alerts.length ? ' alert' : ''}${s.booked ? ' booked' : ''}`, 'data-vt': `stop-${s.id.replace(/[^a-z0-9-]/gi, '')}`, style: { '--i': Math.min(k, 7) },
      ...(canDrag ? { draggable: 'true', ondragstart: (e) => { S.drag = s.id; e.dataTransfer.effectAllowed = 'move'; e.currentTarget.classList.add('dragging'); }, ondragend: (e) => { e.currentTarget.classList.remove('dragging'); S.drag = null; },
        ondragover: (e) => { if (S.drag && S.drag !== s.id) { e.preventDefault(); e.currentTarget.classList.add('drop'); } }, ondragleave: (e) => e.currentTarget.classList.remove('drop'),
        ondrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove('drop'); const a = d.stops.find((x) => x.id === S.drag); if (a) swapStops(trip, a, s); } } : {}) },
      // the whole row opens the stop (the name is the button, stretched over the row); the proof pill sits on top of it
      el('div', { class: 'tv-stop-head' },
        el('span', 'tv-time', s.at),
        el('span', 'tv-thumbwrap', thumb(s), el('span', 'tv-num', String(k + 1)), v.alerts && v.alerts.length ? el('span', 'sr-only', 'Alert: ') : null),
        el('span', 'tv-stop-main',
          el('button', { type: 'button', class: 'tv-stop-toggle', 'data-k': `stop:${s.id}`, 'aria-expanded': String(open), onclick: () => { S.open = S.open === s.id ? null : s.id; paint(); } }, el('b', '', s.place.name)),
          el('span', 'tv-meta', [KIND[s.kind], meta].filter(Boolean).join(' · ')),
          v.badges && v.badges.replace ? el('span', 'tv-meta tv-replace-why', v.badges.replace.suggestion ? `Lisbon sample data, not a real place here. Eden suggests ${v.badges.replace.suggestion.name}.` : 'Lisbon sample data, not a real place here.') : null,
          best ? el('span', 'tv-best', `${best.name} · ${best.rate}x ${r.category}${best.back_pct != null ? ` (≈${best.back_pct}% back)` : ''}`) : null),
        s.booked ? el('span', 'tv-lock', ico('lock', 12), 'Booked') : v.badges && v.badges.replace && !S.member ? replaceButton(trip, s, v.badges.replace) : evesPill(v.badges, s.id),
        T.ownerChip(s),
        ico('chevr', 14, 'tv-chev')),
      open ? stopDetail(trip, s, v, c, flight) : null);
    list.append(row);
  });
  // the day from where you sleep (the server's anchor): out in the morning, back at night
  const none = T.mineEmpty(d);
  if (none) list.append(none);
  const out = M.anchorRow(c, 'out'), back = M.anchorRow(c, 'back');
  if (out) list.prepend(out);
  if (back) list.append(back);
  if (!d.stops.length) list.append(el('li', 'tv-stop empty', 'Nothing planned yet. Ask Eden to add something.'));
  return list;
}

// A stop opened: its note and (a flight) the live tracker, its one primary action (Book) and Ask Eden, then three
// sections as tabs: Checks (each fact, its source and time, "This was wrong"), Bookings & documents (mark booked,
// tickets, when bookings open, the documents) and Plan (who's on it, earlier or later, edit, move, remove).
const STOP_TABS = [['checks', 'Checks'], ['book', 'Bookings & documents'], ['plan', 'Plan']];
function stopDetail(trip, s, v, c, flight) {
  const b = v.badges || {};
  const line = (name, x, kind) => (x ? el('div', `tv-check ${x.status}`, el('i', ''), el('span', '', `${name}: ${x.text}`), x.source ? el('small', '', `${x.source}${x.checked_at ? ` · ${String(x.checked_at).slice(0, 16).replace('T', ' ')} UTC` : ''}`) : null, AC.wrongButton(s.id, kind, x)) : null);
  const own = !S.member && !S.offline && !s.booked;
  const day = trip.days[S.day].stops, i = day.indexOf(s);
  const parts = {
    checks: [line('Hours', b.hours, 'hours'), line('Travel', b.travel, 'travel'), line('Price', b.price, 'price'), line('Access', b.access, 'access')].filter(Boolean),
    book: [
      s.booked ? el('div', 'tv-note', `Booked${s.booked.ref ? ` · ${s.booked.ref}` : ''}${s.booked.provider ? ` with ${s.booked.provider}` : ''}`) : null,
      S.marking === s.id ? markForm(s) : null,
      el('div', 'tv-acts',
        !S.member && !s.booked && S.marking !== s.id ? el('button', { type: 'button', class: 'tv-btn', 'data-k': `mark:${s.id}`, onclick: () => { S.marking = s.id; paint(); } }, ico('check', 13), 'Mark booked') : null,
        A.findTicketsButton(trip, s)),
      A.ticketsBlock(trip, s),
      M.windowsBlock(trip, s),
      M.docsBlock(s),
    ].filter(Boolean),
    plan: [
      T.ownerBlock(trip, s),
      // the keyboard's way to reorder (dragging is the pointer's): swap with the stop before or after
      own && day.length > 1 ? el('div', 'tv-acts', el('span', 'tv-note', 'Order'),
        i > 0 ? el('button', { type: 'button', class: 'tv-btn quiet', 'data-k': `earlier:${s.id}`, onclick: () => swapStops(trip, s, day[i - 1]) }, 'Earlier') : null,
        i < day.length - 1 ? el('button', { type: 'button', class: 'tv-btn quiet', 'data-k': `later:${s.id}`, onclick: () => swapStops(trip, s, day[i + 1]) }, 'Later') : null) : null,
      P.stopTools(trip, s),
    ].filter(Boolean),
  };
  // the Bookings tab holds only an empty actions row for someone the trip is shared with: no tab then
  if (parts.book.length === 1 && !parts.book[0].childElementCount) parts.book = [];
  if (!parts.checks.length) parts.checks = [el('p', 'tv-note', S.maps === 'google' ? 'Nothing checked for this stop yet.' : 'Sample data: nothing checked against a live source.')];
  const tabs = STOP_TABS.filter(([k]) => parts[k].length);
  // a form at work keeps its tab (marking booked, tickets, editing); otherwise the person's pick, Checks first
  const acts = S.acts && S.acts.open === s.id;
  let tab = S.marking === s.id || acts ? 'book' : S.editStop === s.id ? 'plan' : (S.stopTab && S.stopTab.stop === s.id ? S.stopTab.tab : 'checks');
  if (!parts[tab].length) tab = 'checks';
  const sid = s.id.replace(/[^a-z0-9-]/gi, '');
  const pick = (k) => { S.stopTab = { stop: s.id, tab: k }; if (k !== 'book') { S.marking = null; if (S.acts) S.acts.open = null; } if (k !== 'plan') S.editStop = null; paint(); };
  return el('div', 'tv-detail',
    s.note ? el('div', 'tv-note tv-stopnote', s.note) : null,
    flight ? flightBlock(`${flight[1]}${flight[2]}`, c.date) : null,
    // the sections on the left, the stop's one primary action (Book) and Ask Eden on the right
    el('div', 'tv-stopbar',
    tabs.length > 1 ? el('div', { class: 'tv-segs tv-stoptabs', role: 'tablist', 'aria-label': `${s.place.name}: sections`, onkeydown: (e) => {
      const ks = tabs.map(([k]) => k), at = ks.indexOf(tab);
      const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: ks.length - 1 }[e.key];
      if (to === undefined || to < 0 || to >= ks.length || to === at) return;
      e.preventDefault(); e.currentTarget.querySelector(`[data-k="stab:${CSS.escape(s.id)}:${ks[to]}"]`)?.focus(); pick(ks[to]); // focused first: the repaint keeps it there
    } }, ...tabs.map(([k, label]) => el('button', { type: 'button', role: 'tab', class: 'tv-seg', id: `tvst-${sid}-${k}`, 'data-k': `stab:${s.id}:${k}`, 'aria-selected': String(k === tab), 'aria-controls': `tvsp-${sid}`, tabindex: k === tab ? '0' : '-1', onclick: () => pick(k) },
      label, k === 'checks' && parts.checks.some((n) => /\b(warn|look)\b/.test(n.className)) ? el('i', { class: 'tv-seg-dot', 'aria-hidden': 'true' }) : null))) : null,
      el('div', 'tv-acts tv-stopacts',
        !S.member && !s.booked && s.kind !== 'visit' ? el('button', { type: 'button', class: 'tv-btn primary', 'data-k': `book:${s.id}`, onclick: () => book(trip, s, c.date) }, 'Book') : null,
        el('button', { type: 'button', class: 'tv-btn quiet', 'data-k': `ask:${s.id}`, onclick: () => ask(`About “${s.place.name}” on Day ${S.day + 1} of ${tripRef(trip)}: `) }, ico('spark', 13), 'Ask Eden'))),
    el('div', { class: 'tv-stoppanel', id: `tvsp-${sid}`, ...(tabs.length > 1 ? { role: 'tabpanel', 'aria-labelledby': `tvst-${sid}-${tab}` } : {}) }, ...parts[tab]));
}

/* a flight: the live tracker on the day (a day either side), the guest link, and where the driver will meet you */
function flightBlock(ident, date) {
  const days = Math.abs(Date.parse(`${date}T12:00:00Z`) - Date.now()) / 86400_000;
  const share = (S.shares || []).find((x) => x.ident === ident && x.date === date);
  const box = el('div', 'tv-flight');
  // one live view per flight, kept across paints (a new one per paint fired a FlightAware look and new timers each time)
  if (!S.flightViews) S.flightViews = new Map();
  const fk = `${ident}:${date}`;
  const had = S.flightViews.get(fk);
  if (days <= 1.5 && (!had || had.dataset.stopped)) S.flightViews.set(fk, flightMapView(ident, date)); // a tracker that stopped (off screen at a tick) starts again
  box.append(days <= 1.5 ? S.flightViews.get(fk) : el('div', 'tv-note', `Flight ${ident}: live tracking shows here on the day.`));
  if (share && share.pickup) box.append(el('div', 'tv-pickup', el('b', '', `${share.pickup.name} will meet you: ${share.pickup.label}`),
    share.pickup.place && share.pickup.place.name && !share.pickup.label.includes(share.pickup.place.name) ? el('span', 'tv-note', ` · ${share.pickup.place.name}`) : null,
    share.pickup.note ? el('div', 'tv-note', `“${share.pickup.note}”`) : null));
  if (share) {
    const url = new URL(share.url, location.origin).toString();
    box.append(el('div', 'tv-share', el('span', 'tv-note', 'Tracking link for whoever picks you up:'), el('code', '', url),
      el('button', { type: 'button', class: 'tv-pill', onclick: () => navigator.clipboard.writeText(url).then(() => toast('Link copied'), () => toast('Couldn’t copy')) }, 'Copy'),
      el('button', { type: 'button', class: 'tv-pill', onclick: async () => { await tripPost('share-revoke', { code: share.code }).catch(() => {}); await loadShares(); paint(); } }, 'Stop sharing')));
  } else if (S.sharing === `${ident}:${date}`) {
    const name = el('input', { type: 'text', placeholder: 'Your first name (what they’ll see)', 'aria-label': 'Your first name', maxlength: '40' });
    box.append(el('form', { class: 'tv-form', onsubmit: async (e) => {
      e.preventDefault();
      if (!name.value.trim()) return name.focus();
      try { await tripPost('share-create', { id: S.id, ident, date, first_name: name.value.trim(), trip: S.id }); S.sharing = null; await loadShares(); paint(); toast('Tracking link ready'); } catch (err) { toast(String(err.message || err)); }
    } }, name, el('button', { type: 'submit', class: 'tv-btn primary' }, 'Make link'), el('button', { type: 'button', class: 'tv-btn quiet', onclick: () => { S.sharing = null; paint(); } }, 'Cancel'),
      el('p', 'tv-note', 'Anyone with the link sees your first name, this flight and the live map, and can pick where to meet you. It ends 2 hours after you land.')));
    keep(name, `share:${ident}:${date}`);
  } else if (!S.member) box.append(el('div', 'tv-acts', el('button', { type: 'button', class: 'tv-btn', onclick: () => { S.sharing = `${ident}:${date}`; paint(); } }, 'Share tracker')));
  return box;
}

function markForm(s) {
  const ref = el('input', { type: 'text', placeholder: 'Booking reference', 'aria-label': 'Booking reference', maxlength: '80' });
  const who = el('input', { type: 'text', placeholder: 'Booked with (optional)', 'aria-label': 'Booked with', maxlength: '80' });
  const save = async (e) => {
    e.preventDefault();
    if (!ref.value.trim()) return ref.focus();
    try { await tripPost('mark-booked', { id: S.id, stop: s.id, ref: ref.value.trim(), provider: who.value.trim(), via: 'person', confirm: true }); S.marking = null; toast('Marked booked'); } catch (err) { toast(String(err.message || err)); }
  };
  keep(who, `mark-who:${s.id}`); keep(ref, `mark-ref:${s.id}`); // the reference is focused (the last keep's focus wins)
  return el('form', { class: 'tv-form', onsubmit: save }, ref, who, el('button', { type: 'submit', class: 'tv-btn primary' }, 'Save'), el('button', { type: 'button', class: 'tv-btn quiet', onclick: () => { S.marking = null; paint(); } }, 'Cancel'));
}

/* the trip shared with the people on it (site travel/triplink.js): a read-only page that always shows the trip as it
   is now, with no prices, booking references or cards on it */
async function loadLinks(again = true) {
  try { S.links = (await tripPost('links', { id: S.id })).links || []; } catch { S.links = []; }
  if (again) paint();
}
function linkPanel(trip) {
  const links = S.links || [];
  const full = (l) => `${location.origin}${l.url}`;
  const copy = async (l) => { try { await navigator.clipboard.writeText(full(l)); toast('Trip link copied'); } catch { toast(full(l)); } };
  return sheet('tv-share-sheet', 'Share this trip', () => { S.linkOpen = false; },
    el('div', 'tv-share-part',
      el('h3', '', 'A link to the plan'),
      el('p', '', 'Anyone with the link sees the plan as it is now: each day, the times and places, what was checked, the map, and a calendar file. Never prices, booking references or your cards. It ends 2 days after the trip.'),
      ...links.map((l) => el('div', 'tv-acts', el('code', { 'data-no-i18n': '' }, full(l)),
        el('button', { type: 'button', class: 'tv-btn', onclick: () => copy(l) }, 'Copy'),
        el('button', { type: 'button', class: 'tv-btn quiet', onclick: async () => { await tripPost('link-revoke', { code: l.code }).catch((e) => toast(String(e.message || e))); loadLinks(); } }, 'Stop sharing'))),
      el('div', 'tv-acts', el('a', { class: 'tv-btn', href: apiUrl(`/api/chat/travel/calendar?id=${encodeURIComponent(S.id)}`), download: '' }, 'Download a calendar file')),
      links.length ? null : el('div', 'tv-acts', el('button', { type: 'button', class: 'tv-btn primary', onclick: async (e) => {
        e.target.disabled = true;
        try { const r = await tripPost('link-create', { id: S.id }); await loadLinks(); copy({ url: r.url }); } catch (err) { toast(String(err.message || err)); e.target.disabled = false; }
      } }, 'Make a trip link'))),
    membersPanel());
}

/* the trips in the traveller's own calendar (site travel/calsync.js): a private link any calendar app subscribes to
   (it updates itself as plans change), or this trip written into a Google calendar the person picks, only when they
   press the button. Both carry the plan only: places and times, never notes, costs or booking references */
async function loadCal() {
  const [feed, gcal] = await Promise.all([tripPost('calfeed', {}).catch(() => ({ url: null })), tripPost('gcal-status', { id: S.id }).catch(() => ({ on: false }))]);
  S.cal = { ...(S.cal || {}), feed, gcal };
  paint();
}
function openCal(on) {
  S.calOpen = on;
  if (on) loadCal();
  paint();
}
async function loadGoogleCalendars() {
  try { S.cal = { ...(S.cal || {}), calendars: (await tripPost('gcal-calendars', {})).calendars || [], calendarsError: null }; }
  catch (e) { S.cal = { ...(S.cal || {}), calendars: [], calendarsError: String(e.message || e) }; }
  paint();
}
function calendarPanel() {
  const { feed = { url: null }, gcal = { on: false }, calendars, calendarsError } = S.cal || {};
  const run = (fn) => async (e) => { const b = e.currentTarget; b.disabled = true; try { await fn(); } catch (err) { toast(String(err.message || err)); } finally { b.disabled = false; } await loadCal(); };
  const copy = async () => { try { await navigator.clipboard.writeText(feed.url); toast('Calendar link copied'); } catch { toast(feed.url); } };
  const when = (ms) => new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  let google;
  if (gcal.on) {
    google = el('div', 'tv-cal-google',
      el('p', '', `This trip is in ${gcal.calendar || 'your Google calendar'}${gcal.synced ? `, last sent ${when(gcal.synced)}` : ''}.`),
      gcal.pending ? el('p', 'tv-cal-pending', `${gcal.pending} change${gcal.pending === 1 ? '' : 's'} on the trip since then. Google Calendar is updated only when you press Update.`) : null,
      el('div', 'tv-acts', el('button', { type: 'button', class: `tv-btn${gcal.pending ? ' primary' : ''}`, onclick: run(() => tripPost('gcal-sync', { id: S.id, confirm: true })) }, 'Update Google Calendar'),
        el('button', { type: 'button', class: 'tv-btn quiet', onclick: run(() => tripPost('gcal-off', { id: S.id, confirm: true })) }, 'Stop syncing and remove the events')));
  } else if (!calendars) {
    google = el('div', 'tv-cal-google',
      el('p', '', 'Adds each stop of this trip to a Google calendar you choose, in the trip’s own time zone. Uses the Google account you connected to Eden; nothing is written until you press Add.'),
      el('div', 'tv-acts', el('button', { type: 'button', class: 'tv-btn', onclick: () => loadGoogleCalendars() }, 'Choose a Google calendar')));
  } else if (calendarsError || !calendars.length) {
    google = el('div', 'tv-cal-google', el('p', 'tv-cal-error', calendarsError || 'Eden can’t write to any of your Google calendars.'));
  } else {
    const pick = el('select', { class: 'tv-cal-pick', 'aria-label': 'Google calendar' }, ...calendars.map((c) => el('option', { value: c.id, ...(c.primary ? { selected: '' } : {}) }, c.title + (c.primary ? ' (main)' : ''))));
    google = el('div', 'tv-cal-google',
      el('p', '', 'Which Google calendar should this trip go in?'),
      el('div', 'tv-acts', pick, el('button', { type: 'button', class: 'tv-btn primary', onclick: run(async () => { const r = await tripPost('gcal-sync', { id: S.id, calendarId: pick.value, confirm: true }); toast(`Added ${r.events} event${r.events === 1 ? '' : 's'} to ${r.calendar}`); }) }, 'Add this trip')));
  }
  return sheet('tv-cal', 'In your calendar', () => { S.calOpen = false; },
    el('div', 'tv-cal-body',
      el('h3', '', 'Every trip, kept up to date'),
      el('p', '', 'Subscribe once and your calendar app keeps your trips current as plans change: Apple Calendar, Google Calendar or Outlook. It shows places and times only, never notes, prices or booking references. The link is private: anyone who has it can see your plans, so stop syncing if it gets out.'),
      feed.url
        ? el('div', 'tv-acts tv-cal-apps',
          el('a', { class: 'tv-btn primary', href: feed.webcal }, ico('cal', 14), 'Apple Calendar'),
          el('a', { class: 'tv-btn', href: feed.google, target: '_blank', rel: 'noopener' }, 'Google Calendar'),
          el('a', { class: 'tv-btn', href: feed.outlook, target: '_blank', rel: 'noopener' }, 'Outlook'),
          el('button', { type: 'button', class: 'tv-btn quiet', onclick: copy }, 'Copy link'),
          el('button', { type: 'button', class: 'tv-btn quiet', onclick: run(() => tripPost('calfeed-revoke', {})) }, 'Stop syncing'))
        : el('div', 'tv-acts', el('button', { type: 'button', class: 'tv-btn primary', onclick: run(() => tripPost('calfeed-create', {})) }, ico('cal', 14), 'Get my calendar link')),
      el('h3', '', 'Or add this trip to Google Calendar'),
      google));
}

/* Still to decide: what needs the person besides the lead (unbooked stays and journeys, empty days, the other alerts,
   what falls after dark), each with its own action; folded under Eden noticed until opened */
function todoList(trip, checks, hasLead) {
  const out = [];
  trip.days.forEach((d, i) => {
    if (!d.stops.length) out.push([`Day ${i + 1} has nothing planned`, 'Plan it', () => ask(`Plan Day ${i + 1} of ${tripRef(trip)} with me.`)]);
    d.stops.forEach((s, k) => {
      const r = ((checks.days[i] || {}).stops || [])[k]?.badges?.replace;
      const lead = !S.data.proposal && !(S.data.price_drops || []).length && checks.alerts[0] && checks.alerts[0].kind === 'replace' && checks.alerts[0].stop === s.id;
      if (r && lead) return;
      if (r && !S.member) out.unshift([r.suggestion ? `Day ${i + 1}: ${s.place.name} is Lisbon sample data. Eden suggests ${r.suggestion.name}` : `Day ${i + 1}: ${s.place.name} is Lisbon sample data`, r.suggestion ? 'Replace' : 'Find one', () => { S.day = i; replaceStop(trip, s, r.suggestion); }]);
      else if (!S.member && (s.kind === 'stay' || s.kind === 'transport') && !s.booked) out.push([`${s.place.name} isn’t booked`, 'Book', () => book(trip, s, checks.days[i] && checks.days[i].date)]);
    });
  });
  // the first alert is Eden noticed's lead, unless a proposal or a price drop leads
  const from = S.data.proposal || (S.data.price_drops || []).length ? 0 : 1;
  const rest = checks.alerts.slice(from).filter((a) => a.kind !== 'replace');
  for (const a of rest) out.push([`Day ${a.day + 1}: ${a.text}`, S.member ? 'Suggest a fix' : 'Review', () => ask(fixText(trip, a, Boolean(S.member)))]);
  for (const a of S.afterDark || []) out.push([a.text, 'Ask Eden', () => ask(`On ${tripRef(trip)}: ${a.text} Propose a better time.`)]);
  out.push(...EN.entryDecisions(trip)); // passports and travel approvals (travel-entry.js)
  if (!out.length) return null;
  const open = S.todoOpen !== undefined ? S.todoOpen : !hasLead;
  const shown = out.slice(0, 8);
  return el('div', 'tv-todo',
    el('button', { type: 'button', class: 'tv-todo-toggle', 'data-k': 'todo', 'aria-expanded': String(open), 'aria-controls': 'tvTodo', onclick: () => { S.todoOpen = !open; paint(); } },
      el('span', 'tv-todo-count', String(out.length)), el('span', '', `${out.length === 1 ? 'thing' : 'things'} still to decide`), ico('chevr', 13, 'tv-chev')),
    open ? el('ul', { class: 'tv-dec-list', id: 'tvTodo' }, ...shown.map(([text, label, run], i) => el('li', { style: { '--i': i } }, el('span', '', text), el('button', { type: 'button', class: 'tv-pill', 'data-k': `dec:${text.slice(0, 40)}`, onclick: run }, label)))) : null,
    open && out.length > shown.length ? el('p', 'tv-fine', `And ${out.length - shown.length} more.`) : null,
    open && rest.length > 1 && !S.member ? el('div', 'tv-acts', el('button', { type: 'button', class: 'tv-btn quiet', 'data-k': 'fix-all', onclick: () => ask(`On ${tripRef(trip)}, fix everything Eden noticed: ${rest.map((a) => a.text).join(' · ')}`) }, ico('spark', 13), 'Fix all with Eden')) : null);
}

/* Journey board: every day side by side */
function board() {
  const { trip, checks } = S.data;
  return [hero(trip), planSwitch(), el('section', { class: 'tv-board', 'aria-label': 'Journey board' },
    ...trip.days.map((d, i) => {
      const c = checks.days[i] || { stops: [], move_minutes: 0, cost: { amount: 0, currency: 'EUR' } };
      return el('article', { class: 'tv-col glass-card' },
        el('button', { type: 'button', class: 'tv-col-head', onclick: () => { showDay(i); } }, kicker(`Day ${i + 1}`, dayLong(c.date)), el('h3', '', d.title)),
        el('div', 'tv-stats', chip(`${d.stops.length} stops`), chip(moveText(c, 'moving')), c.cost.amount ? chip(money(c.cost.amount, c.cost.currency)) : null), // no prices yet: no "€0"
        el('ol', 'tv-col-stops', ...d.stops.map((s, k) => el('li', { class: ((c.stops[k] || {}).alerts || []).length ? 'alert' : '' },
          thumb(s, 'tv-ba-art'), el('b', '', s.at), el('span', '', s.place.name), s.booked ? ico('lock', 12) : evesPill((c.stops[k] || {}).badges)))));
    }))];
}

/* Map explorer: the whole trip on one map, each day in its colour */
const DAY_COLORS = ['#0a84ff', '#ff9f0a', '#30d158', '#bf5af2', '#ff375f', '#64d2ff', '#ffd60a'];
function explorer() {
  const { trip } = S.data;
  const all = trip.days.flatMap((d, di) => located(d.stops).map((s) => ({ ...s, _day: di })));
  return [el('section', { class: 'tv-explorer glass-card', 'aria-label': 'Map explorer' },
    mapImage(all.map((s) => s.place), { w: 640, h: 420, cls: 'tv-mapimg wide', draw: (over, P) => pins(over, P, all, { line: false, colorOf: (s) => DAY_COLORS[s._day % DAY_COLORS.length], labelOf: (s) => String(s._day + 1) }) }),
    el('div', 'tv-legend', ...trip.days.map((d, i) => el('button', { type: 'button', class: 'tv-legend-row', onclick: () => { showDay(i); } },
      el('i', { style: `background:${DAY_COLORS[i % DAY_COLORS.length]}` }), el('b', '', `Day ${i + 1}`), el('span', '', `${d.title} · ${d.stops.length} stops`)))))];
}

// when to leave for the next stop: its time less the checked travel time to it (never a guess: no check, no time)
// `atMin`: the stop's time in minutes from the day's midnight (past midnight counted on: 00:30 after 23:00 is 1470)
function leaveBy(atMin, badges, nowMin) {
  const t = badges && badges.travel;
  if (!t || !Number.isFinite(t.minutes) || !Number.isFinite(atMin)) return null;
  const leave = atMin - t.minutes;
  const left = leave - nowMin;
  const at = `${String(Math.floor((leave % 1440 + 1440) % 1440 / 60)).padStart(2, '0')}:${String((leave % 60 + 60) % 60).padStart(2, '0')}`;
  const span = (n) => (n >= 60 ? `${Math.floor(n / 60)} h${n % 60 ? ` ${n % 60} min` : ''}` : `${n} min`);
  return el('p', { class: `tv-leave${left <= 10 ? ' soon' : ''}` }, el('b', '', `Leave by ${at}`),
    el('span', '', left > 0 ? ` · in ${span(left)}` : left === 0 ? ' · now' : ` · ${span(-left)} ago`),
    el('small', '', ` ${t.minutes} min ${HOWW[t.mode] || ''}, ${t.source || 'checked'}`));
}

/* Travel companion: today on the trip (or the first day, before it starts) */
function companion() {
  const { trip, checks } = S.data;
  liveToday(S.data); // the Travel iPhone app's Live Activity (travel-live.js; nothing elsewhere)
  const n0 = new Date();
  const today = `${n0.getFullYear()}-${String(n0.getMonth() + 1).padStart(2, '0')}-${String(n0.getDate()).padStart(2, '0')}`; // the traveller's own day, like the clock below
  let di = checks.days.findIndex((x) => x.date === today);
  const before = di < 0 && today < (checks.days[0] && checks.days[0].date);
  if (di < 0) di = before ? 0 : trip.days.length - 1;
  const d = trip.days[di], c = checks.days[di] || { stops: [] };
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  // each stop's time in the day's minutes; one earlier than the stop before it is after midnight
  let prev = -1;
  const mins = d.stops.map((s) => { const [h, m] = String(s.at || '').split(':').map(Number); let v = h * 60 + m; if (!Number.isFinite(v)) return NaN; if (v < prev) v += 1440; prev = v; return v; });
  const nextK = c.date === today ? mins.findIndex((v) => v >= nowMin) : 0;
  const done = c.date === today && d.stops.length && nextK < 0; // today's last stop is behind you
  const next = done ? null : d.stops[nextK >= 0 ? nextK : 0];
  const flightStop = d.stops.find((s) => s.kind === 'transport' && FLIGHT_NO.test(`${s.place.name} ${s.note || ''}`));
  const fm = flightStop && FLIGHT_NO.exec(`${flightStop.place.name} ${flightStop.note || ''}`);
  const nk = next ? d.stops.indexOf(next) : d.stops.length;
  const left = [
    el('section', { class: 'tv-companion glass-card', 'aria-label': 'Travel companion' },
      kicker(c.date === today ? 'Today' : before ? 'Your first day' : 'Your last day', `Day ${di + 1}`, dayLong(c.date)),
      done ? el('p', 'tv-note', 'Done for today. Tomorrow’s plan is in the day view.') : next ? el('div', 'tv-next', thumb(next, 'tv-next-art'), el('div', '',
        el('span', 'tv-kicker', 'Next'), el('h2', '', next.place.name), el('p', 'tv-meta', `${next.at} · ${hm(next.minutes)}${next.cost ? ` · ${money(next.cost.amount, next.cost.currency)}` : ''}`),
        (c.stops[d.stops.indexOf(next)] || {}).badges && (c.stops[d.stops.indexOf(next)] || {}).badges.travel ? el('p', 'tv-note', c.stops[d.stops.indexOf(next)].badges.travel.text) : null,
        c.date === today ? leaveBy(mins[d.stops.indexOf(next)], (c.stops[d.stops.indexOf(next)] || {}).badges, nowMin) : null,
        evesPill((c.stops[d.stops.indexOf(next)] || {}).badges))) : el('p', 'tv-note', 'Nothing planned for this day.'),
      el('div', 'tv-acts', el('button', { type: 'button', class: 'tv-btn primary', onclick: () => ask(`I'm on Day ${di + 1} of ${tripRef(trip)}. What should I do next, and is anything running late?`) }, 'Ask Eden about today'),
        el('button', { type: 'button', class: 'tv-btn', 'data-k': 'see-day', onclick: () => { showDay(di); } }, 'See the whole day'), liveButton(), VO.voiceButton()),
      VO.voiceAnswer()),
    fm ? el('section', { class: 'tv-companion glass-card' }, kicker('Your flight'), flightBlock(`${fm[1]}${fm[2]}`, c.date)) : null,
    todayMap(d, c)];
  // beside it: the rest of the day, what still needs the person, and the day's weather hour by hour
  const right = [laterToday(trip, d, c, nk), attention(trip, checks), weatherCard(di)];
  return [hero(trip), el('div', 'tv-today', el('div', 'tv-today-main', ...left.filter(Boolean)), el('div', 'tv-today-side', ...right.filter(Boolean)))];
}
function todayMap(d, c) {
  const pts = located(d.stops);
  if (!pts.length) return null;
  return el('div', 'tv-daymap tv-today-map', mapImage(pts.map((s) => s.place), { w: 640, h: 400, cls: 'tv-mapimg wide', draw: (over, P) => pins(over, P, pts, {
    colorOf: (s) => ((c.stops[d.stops.indexOf(s)] || {}).alerts || []).length ? '#ff9f0a' : '#0a84ff', labelOf: (s) => String(d.stops.indexOf(s) + 1) }) }));
}
// the stops after the next one: time, name, and how you get there when it was checked
function laterToday(trip, d, c, nk) {
  const rest = d.stops.slice(nk + 1);
  if (!rest.length) return null;
  return el('section', { class: 'tv-later glass-card', 'aria-label': 'Later' }, el('h3', '', 'Later'),
    el('ol', '', ...rest.map((s) => {
      const v = c.stops[d.stops.indexOf(s)] || { badges: {} }, t = v.badges && v.badges.travel;
      const how = t && Number.isFinite(t.minutes) ? `${t.estimate ? '~' : ''}${t.minutes} min ${HOWW[t.mode || s.mode] || ''}`.trim() : null;
      return el('li', { class: (v.alerts || []).length ? 'alert' : '' }, el('b', '', s.at), el('span', '', s.place.name, how ? el('small', '', ` · ${how}`) : null),
        v.badges && v.badges.replace ? el('small', 'tv-replace-why', 'sample: replace it') : null);
    })));
}
// the day's weather: high and low, then each hour from 08:00 (Open-Meteo through the server; nothing shown when it has none)
function weatherCard(i) {
  const w = S.weather && S.weather[i];
  if (!w || w.forecast === null || w.why || !Number.isFinite(w.high_c)) return null;
  const hours = (w.hours || []).filter((h) => h.at >= '08:00' && h.at <= '22:00').filter((_, k) => k % 2 === 0).slice(0, 8);
  return el('section', { class: 'tv-wx glass-card', 'aria-label': 'Weather' },
    el('h3', '', `Weather in ${city(S.data.trip)}`, el('small', '', ` · ${w.source}, ${String(w.checked_at).slice(5, 10)}`)),
    el('p', 'tv-wx-day', el('b', '', `${Math.round(w.low_c)}–${Math.round(w.high_c)}°`), ` ${w.summary || ''}${Number.isFinite(w.rain_chance_pct) ? ` · ${w.rain_chance_pct}% rain` : ''}`),
    hours.length ? el('ol', 'tv-wx-hours', ...hours.map((h) => el('li', { title: h.summary || '' }, el('span', '', h.at), el('b', '', `${Math.round(h.temp_c)}°`), el('small', '', Number.isFinite(h.rain_chance_pct) ? `${h.rain_chance_pct}%` : '')))) : null);
}

/* ---------- actions ---------- */

/* Book: Ask Eden does it with the right tools (flights through Duffel when on; anything else in Eden's browser, or the link). */
function book(trip, s, date) {
  const what = `${s.place.name}${s.nights ? `, ${s.nights} nights from ${date}` : ` on ${date} at ${s.at}`}, for ${trip.travelers} ${trip.travelers === 1 ? 'person' : 'people'}`;
  if (s.kind === 'transport' && /\b(fly|flight|flights|airport|plane)\b|\([A-Z]{3}\)/i.test(`${s.place.name} ${s.note || ''}`)) return ask(`Find flights for ${tripRef(trip)} [id=${trip.id || S.id}] (stop ${s.id}): ${what}. Show me the options to book. Once I book one, mark this stop booked with its reference and price, and propose putting the flight number and route in the stop’s note (like “TP1351 London Heathrow → Lisbon”) so it’s tracked live.`);
  if (s.link) return ask(`Book this for ${tripRef(trip)} (stop ${s.id}): ${what}. It’s at ${s.link}. Use trip_book.`);
  return ask(`Book this for ${tripRef(trip)} (stop ${s.id}): ${what}. Find where to book it, then use trip_book.`);
}

async function undo() {
  try { await tripPost('undo', { id: S.id }); toast('Undone'); } catch (e) { toast(String(e.message || e)); }
}

async function sample() {
  try { await tripPost('sample', {}); } catch (e) { toast(String(e.message || e)); } // the trip-changed event shows it
}
