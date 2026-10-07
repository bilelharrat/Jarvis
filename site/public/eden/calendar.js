// The calendar: one large glass surface over the chat with day, week, month and agenda
// views, a mini month, per-calendar colours and show/hide, event popovers, and two sources —
// the Mac's calendars through the Jarvis app (POST /api/chat/jarvis: calendar, and
// calendar_create/update/delete, each also confirmed on the Mac), and Google Calendar
// directly (/api/chat/gcal). Every change goes through a review step here first; nothing a
// model writes ever changes the calendar. Everything shown is data, set as text only.

import { el as baseEl, ico, toast, store, isMobile, placePopup, setSeg } from './util.js';
import { api, getJSON, postJSON, jarvisApprovalWaiting } from './api.js';
import * as M from './calendar-model.js';
import * as RR from './calendar-rules.js';
import { openCompose, sanitizeHtml } from './compose.js';

const LOCALE = (navigator.languages && navigator.languages[0]) || navigator.language || 'en-US';
const FIRST_DAY = M.firstDayOfWeek(LOCALE);
const HOUR_PX = 48;
const LANE_PX = 21;
const ALLDAY_LANES = 3;
const DATA_NOTE = /^\(From the owner's Jarvis:[^)]*\)\s*/;
const VIEW_LABEL = { day: 'Day', week: 'Week', month: 'Month', year: 'Year', agenda: 'Schedule' };
const VIEW_KEY = { day: 'D', week: 'W', month: 'M', year: 'Y', agenda: 'A' };
/** Working hours, shaded outside in the day and week views (kept in this browser). */
const WORK = (() => { const w = store.get('eden:cal:workhours', null); return w && w.start >= 0 && w.end <= 24 && w.start < w.end ? w : { start: 9, end: 17 }; })();
/** Google's event colours (colorId), as Google Calendar names them. */
const G_COLORS = [['1', 'Lavender', '#7986cb'], ['2', 'Sage', '#33b679'], ['3', 'Grape', '#8e24aa'], ['4', 'Flamingo', '#e67c73'], ['5', 'Banana', '#f6bf26'], ['6', 'Tangerine', '#f4511e'], ['7', 'Peacock', '#039be5'], ['8', 'Graphite', '#616161'], ['9', 'Blueberry', '#3f51b5'], ['10', 'Basil', '#0b8043'], ['11', 'Tomato', '#d50000']];
const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const RETURN_KEY = 'eden:cal:return';
/** Calendar colours to choose from: the design tokens (accent, run, wait, warn, danger), then Apple's other system colours. */
const COLOURS = [
  ['Blue', '#0a84ff'], ['Green', '#30d158'], ['Yellow', '#e6b800'], ['Orange', '#ff9f0a'], ['Red', '#ff453a'],
  ['Pink', '#ff375f'], ['Purple', '#bf5af2'], ['Indigo', '#5e5ce6'], ['Teal', '#40c8e0'], ['Brown', '#ac8e68'], ['Graphite', '#8e8e93'],
];
/** A long press before a touch drag starts (a plain swipe still scrolls). */
const LONG_PRESS_MS = 450;
/** The editor's alert menu: none, or minutes before (calendar-model.js). */
const ALERTS = [[null, 'None'], ...M.ALERT_CHOICES.map((m) => [m, M.alertText(m)])];
const alertText = M.alertText;

let H = { addContext: () => {}, openSettings: () => {} };
const S = {
  built: false, open: false,
  view: store.get('eden:cal:view', null),
  anchor: M.startOfDay(new Date()),
  mini: M.startOfMonth(new Date()),
  hidden: new Set(store.get('eden:cal:hidden', [])),
  known: new Set(store.get('eden:cal:known', [])),
  colors: (() => { const c = store.get('eden:cal:colors', {}); return c && typeof c === 'object' && !Array.isArray(c) ? c : {}; })(),
  mac: { state: 'idle', reason: '', calendars: new Map(), events: [], legacy: false, range: null },
  google: { state: 'idle', reason: '', email: '', calendars: [], events: [], errors: [], range: null, loadedIds: null },
  macSeq: 0, gSeq: 0, pop: null, sheet: null, timer: null, ro: null, returnFocus: null,
  scroll: null, alldayOpen: false, selectedDay: null, sideOpen: false,
  approval: jarvisApprovalWaiting(), // a Jarvis call is waiting on the "Let Eden use Jarvis?" card
  drag: null, preview: null, dragDirty: false, justDragged: 0, colorMenu: null,
  query: '', contacts: null, seriesRules: new Map(),
};
let R = {}; // the surface's elements

/* ---------------- helpers ---------------- */

/** util.el, plus CSS custom properties in style ({ '--c': '#f00' }): Object.assign can't set those. */
function el(tag, attrs, ...kids) {
  let vars = null;
  if (attrs && typeof attrs === 'object' && attrs.style && typeof attrs.style === 'object') {
    const style = {};
    for (const [k, v] of Object.entries(attrs.style)) { if (k.startsWith('--')) (vars = vars || {})[k] = v; else style[k] = v; }
    attrs = { ...attrs, style };
  }
  const n = baseEl(tag, attrs, ...kids);
  if (vars) for (const [k, v] of Object.entries(vars)) n.style.setProperty(k, String(v));
  return n;
}

const calKey = (source, id) => `${source}|${id}`;
const evCalKey = (e) => calKey(e.source, e.calendarId);
function allCalendars() { return [...S.mac.calendars.values(), ...S.google.calendars]; }
function calendarsById() { return new Map(allCalendars().map((c) => [calKey(c.source, c.id), c])); }
/** A calendar's colour: the one chosen here (kept in this browser), else its own. */
function calColor(c) { return (c && S.colors[calKey(c.source, c.id)]) || (c && c.color) || '#8e8e93'; }
function colorOf(e, cals = calendarsById()) { const c = cals.get(evCalKey(e)); return e.color || (c ? calColor(c) : M.colorFor(e.calendarId)); }
function visibleEvents() {
  return [...S.mac.events, ...S.google.events].filter((e) => !S.hidden.has(evCalKey(e)));
}
/** Events matching the search (title, place, notes, guests), across what's loaded. */
function searchHits() {
  const q = S.query.trim().toLowerCase();
  if (!q) return [];
  return visibleEvents().filter((e) => `${e.title} ${e.location} ${e.notes} ${(e.attendees || []).map((a) => `${a.name} ${a.email}`).join(' ')}`.toLowerCase().includes(q))
    .sort((a, b) => M.bounds(a).s - M.bounds(b).s);
}
/** The owner's answer to an invitation shown on the event: declined, maybe, or not answered yet. */
function rsvpClass(e) {
  const s = e.selfStatus || ((e.attendees || []).find((a) => a.self) || {}).status;
  const organizer = (e.attendees || []).some((a) => a.self && a.organizer) || (e.organizer && e.organizer.self);
  if (!s || organizer) return '';
  return s === 'declined' ? ' declined' : s === 'tentative' ? ' maybe' : s === 'needsAction' ? ' invited' : '';
}
const covers = (have, want) => have && have.start <= want.start && have.end >= want.end;
const strip = (t) => String(t || '').replace(DATA_NOTE, '').trim();
const fmtTime = (d) => d.toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' });
/** The now-line's label: without AM/PM in a phone's narrow gutter. */
const nowLabel = (d) => (isMobile() ? fmtTime(d).replace(/\s?[AP]\.?M\.?$/i, '') : fmtTime(d));
const hourLabel = (h) => new Date(2026, 0, 1, h).toLocaleTimeString(LOCALE, { hour: 'numeric' });
const busy = () => S.mac.state === 'loading' || S.google.state === 'loading';
const usable = (src) => src.state === 'ready' || src.state === 'loading';
function sourceLabel(e, cal) { return e.source === 'google' ? (S.google.email && (!cal || cal.title !== S.google.email) ? `Google · ${S.google.email}` : 'Google') : 'On your Mac'; }
function parseJSONText(t) { try { return JSON.parse(strip(t)); } catch { return null; } }
function range() { return M.rangeFor(S.view, S.anchor, FIRST_DAY); }

/* ---------------- loading ---------------- */

/** What to read: the view's days; a search reads 30 days back and 60 ahead; the year view reads nothing more (its months show what's loaded). */
function loadRange() {
  if (S.query) { const t = M.startOfDay(new Date()); return { start: M.addDays(t, -30), end: M.addDays(t, 60), days: [] }; }
  if (S.view === 'year') return null;
  return range();
}
async function load(force = false) {
  const r = loadRange();
  if (!r) { render(); return; }
  const work = [loadMac(r, ++S.macSeq, force), loadGoogle(r, ++S.gSeq, force)];
  render();
  await Promise.allSettled(work);
}

async function loadMac(r, seq, force) {
  const m = S.mac;
  if (!force && m.state === 'ready' && covers(m.range, r)) return;
  m.state = 'loading';
  let st;
  try { st = await api.jarvisStatus(); } catch (e) { st = { available: false, reason: e.message }; }
  if (seq !== S.macSeq) return;
  if (!st.available) { Object.assign(m, { state: 'off', reason: st.reason || '', events: [], range: null }); render(); return; }
  try {
    const first = await api.jarvis('calendar', M.macReadArgs(r.start, r.end));
    if (first.is_error) throw new Error(strip(first.text) || 'Jarvis couldn’t read the calendar.');
    let got = M.parseMacCalendar(first.text, r.start, r.end);
    if (got.legacy && M.daysBetween(r.start, r.end) > 14) {
      // An older Jarvis reads 14 days a call and ignores start/end: ask it piece by piece.
      const rest = M.legacyChunks(r.start, r.end).slice(1);
      const parts = await Promise.all(rest.map(([a, b]) => api.jarvis('calendar', { start_offset_days: Math.max(-31, M.daysBetween(M.startOfDay(new Date()), a)), days: M.daysBetween(a, b) })
        .then((more) => (more.is_error ? null : M.parseLegacyText(more.text, a, b)), () => null)));
      for (const part of parts) if (part) got = { ...got, calendars: [...got.calendars, ...part.calendars], events: [...got.events, ...part.events] };
    }
    if (seq !== S.macSeq) return;
    for (const c of got.calendars) if (!m.calendars.has(c.id)) m.calendars.set(c.id, c); else Object.assign(m.calendars.get(c.id), c);
    noteKnown(got.calendars);
    Object.assign(m, { state: 'ready', reason: '', events: got.events.filter((e) => M.overlaps(e, r.start, r.end)), legacy: got.legacy, range: r });
  } catch (e) {
    if (seq !== S.macSeq) return;
    Object.assign(m, { state: 'error', reason: e.message, events: [], range: null });
  }
  render();
}

async function loadGoogle(r, seq, force) {
  const g = S.google;
  if (!force && g.state === 'ready' && covers(g.range, r)) return;
  g.state = 'loading';
  let st;
  try { st = await getJSON('/api/chat/gcal/status'); } catch (e) { if (seq === S.gSeq) { Object.assign(g, { state: 'error', reason: e.message }); render(); } return; }
  if (seq !== S.gSeq) return;
  g.email = st.email || '';
  if (!st.configured || !st.connected || !st.calendar) {
    Object.assign(g, { state: !st.configured ? 'unset' : !st.connected ? 'signin' : 'reconnect', reason: '', events: [], range: null });
    render();
    return;
  }
  const args = { start: M.isoWithOffset(r.start), end: M.isoWithOffset(r.end) };
  if (g.calendars.length) args.calendars = g.calendars.filter((c) => !S.hidden.has(calKey('google', c.id))).map((c) => c.id);
  try {
    const j = await postJSON('/api/chat/gcal', { action: 'events', args });
    if (seq !== S.gSeq) return;
    const cals = Array.isArray(j.calendars) ? j.calendars : [];
    // Calendars hidden in Google Calendar's own list start hidden here too (the first time they're seen).
    for (const c of cals) if (!S.known.has(calKey('google', c.id)) && !c.selected) S.hidden.add(calKey('google', c.id));
    noteKnown(cals);
    saveHidden();
    Object.assign(g, {
      state: 'ready', reason: '', calendars: cals, events: Array.isArray(j.events) ? j.events : [], errors: Array.isArray(j.errors) ? j.errors : [], range: r,
      loadedIds: new Set(args.calendars || cals.filter((c) => c.selected).map((c) => c.id)),
    });
  } catch (e) {
    if (seq !== S.gSeq) return;
    Object.assign(g, { state: e.status === 401 || e.status === 403 ? 'reconnect' : 'error', reason: e.message, events: [], range: null });
  }
  render();
}

function noteKnown(cals) { for (const c of cals) S.known.add(calKey(c.source, c.id)); store.set('eden:cal:known', [...S.known].slice(-400)); }
function saveHidden() { store.set('eden:cal:hidden', [...S.hidden].slice(-400)); }

function toggleCalendar(c) {
  const k = calKey(c.source, c.id);
  if (S.hidden.has(k)) S.hidden.delete(k); else S.hidden.add(k);
  saveHidden();
  if (c.source === 'google' && !S.hidden.has(k) && S.google.loadedIds && !S.google.loadedIds.has(c.id)) loadGoogle(range(), ++S.gSeq, true);
  closePop();
  render();
}

/* ---------------- the surface ---------------- */

function build() {
  if (S.built) return;
  S.built = true;
  const seg = el('div', { class: 'seg cal-seg', style: { '--n': M.VIEWS.length }, role: 'tablist', 'aria-label': 'View' }, el('div', 'seg-thumb'),
    ...M.VIEWS.map((v) => el('button', { type: 'button', role: 'tab', 'data-view': v, title: `${VIEW_LABEL[v]} (${VIEW_KEY[v]})` }, VIEW_LABEL[v])));
  seg.addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) setView(b.dataset.view); });
  R.title = el('h2', { class: 'cal-title', id: 'calTitle' });
  R.busy = el('span', { class: 'cal-busy', 'aria-hidden': 'true' });
  R.seg = seg;
  R.prev = el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Previous', title: 'Previous (←)', onclick: () => step(-1) }, ico('chevl'));
  R.next = el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Next', title: 'Next (→)', onclick: () => step(1) }, ico('chevr'));
  R.today = el('button', { type: 'button', class: 'btn cal-today', title: 'Today (T)', onclick: goToday }, 'Today');
  R.search = el('input', { type: 'search', class: 'cal-search-in', placeholder: 'Search events', 'aria-label': 'Search events (/)', autocomplete: 'off', spellcheck: 'false' });
  let searchT = 0;
  R.search.addEventListener('input', () => {
    clearTimeout(searchT);
    searchT = setTimeout(() => { const was = !!S.query; S.query = R.search.value.trim(); closePop(); if (!!S.query !== was) load(false); else renderView(); }, 160);
  });
  R.search.addEventListener('keydown', (e) => { if (e.key === 'Escape' && R.search.value) { e.preventDefault(); e.stopPropagation(); R.search.value = ''; S.query = ''; load(false); } });
  R.sideBtn = el('button', { type: 'button', class: 'iconbtn cal-side-btn', 'aria-label': 'Calendars', title: 'Calendars', 'aria-expanded': 'false', onclick: () => { S.sideOpen = !S.sideOpen; renderSideState(); } }, ico('side'));
  const head = el('header', 'cal-head',
    R.sideBtn,
    el('div', 'cal-titlewrap', ico('cal', 18, 'cal-ico'), R.title, R.busy),
    el('span', 'cal-sp'),
    el('label', 'cal-search', ico('search', 13), R.search),
    seg,
    el('div', 'cal-nav', R.prev, R.today, R.next),
    el('div', 'cal-acts',
      el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Refresh', title: 'Refresh', onclick: () => load(true) }, ico('retry', 15)),
      el('button', { type: 'button', class: 'cap cal-use', title: 'Add what this view shows to your next message', onclick: useRange }, ico('chat', 12), el('span', '', 'Use in chat')),
      el('button', { type: 'button', class: 'cap primary cal-newbtn', title: 'New event (C)', onclick: () => newEvent() }, ico('plus', 12), el('span', '', 'New event')),
      el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Close calendar', title: 'Close · esc', onclick: closeCalendar }, ico('x'))));
  R.mini = el('div', 'cal-mini');
  R.cals = el('div', 'cal-cals');
  R.side = el('aside', { class: 'cal-side', 'aria-label': 'Calendars' }, R.mini, R.cals);
  R.banner = el('div', { class: 'cal-banners', 'aria-live': 'polite' });
  R.live = el('div', { class: 'sr-only', 'aria-live': 'polite' });
  R.view = el('div', 'cal-view');
  R.main = el('main', 'cal-main', R.banner, R.view);
  R.pop = el('div', { class: 'cal-pop glass', role: 'dialog', 'aria-label': 'Event', hidden: true });
  R.sheet = el('div', { class: 'cal-sheet', hidden: true });
  R.colors = el('div', { class: 'cal-colors glass', role: 'dialog', 'aria-label': 'Calendar colour', hidden: true });
  R.card = el('section', { class: 'cal glass', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'calTitle' },
    head, el('div', 'cal-body', R.side, R.main), R.pop, R.colors, R.sheet, R.live);
  R.root = el('div', { id: 'calSurface', class: 'cal-scrim', hidden: true }, R.card);
  R.root.addEventListener('pointerdown', (e) => {
    if (e.target === R.root) { closeCalendar(); return; }
    if (S.pop && !R.pop.contains(e.target) && !e.target.closest('.cal-tev, .cal-chip, .cal-arow')) closePop();
    if (S.colorMenu && !R.colors.contains(e.target) && !e.target.closest('.cal-swatch')) closeColorMenu();
    if (S.sideOpen && !R.side.contains(e.target) && !R.sideBtn.contains(e.target) && !R.colors.contains(e.target)) { S.sideOpen = false; renderSideState(); }
  });
  R.card.addEventListener('keydown', onKey);
  document.body.append(R.root);
  S.ro = new ResizeObserver(() => { if (S.open && S.view === 'month') { clearTimeout(S.roT); S.roT = setTimeout(renderView, 80); } });
  S.ro.observe(R.view);
}

export function openCalendar(opts = {}) {
  build();
  if (!S.open) {
    S.returnFocus = document.activeElement;
    S.open = true;
    R.root.hidden = false;
    document.body.classList.add('cal-open');
  }
  if (!S.view || !M.VIEWS.includes(S.view)) S.view = isMobile() ? 'day' : 'week';
  else if (isMobile() && S.view === 'week') S.view = 'day'; // seven columns don't fit a phone
  if (opts.date) S.anchor = M.startOfDay(opts.date);
  S.mini = M.startOfMonth(S.anchor);
  const loading = load(false);
  clearInterval(S.timer);
  S.timer = setInterval(tickNow, 60_000);
  requestAnimationFrame(() => R.today.focus());
  // newEvent: true, or a draft to start from ({ title, start, end, notes, location }: a meeting's action item)
  if (opts.newEvent) {
    const at = typeof opts.newEvent === 'object' ? opts.newEvent : {};
    // before the calendars have loaded there's nowhere to add it yet: wait for them
    setTimeout(() => (writableCalendars().length ? newEvent(at) : loading.then(() => { if (S.open) newEvent(at); })), 50);
  }
}

export function closeCalendar() {
  if (!S.open) return false;
  S.open = false;
  closePop();
  closeSheet();
  R.root.hidden = true;
  document.body.classList.remove('cal-open');
  clearInterval(S.timer);
  if (S.returnFocus && document.contains(S.returnFocus)) S.returnFocus.focus();
  return true;
}
export const calendarOpen = () => S.open;

/** True once after coming back from a Google sign-in started here (then the calendar reopens, not Mail). */
export function calendarReturnPending() {
  try { const v = sessionStorage.getItem(RETURN_KEY); sessionStorage.removeItem(RETURN_KEY); return v === '1'; } catch { return false; }
}

function setView(v) {
  if (!M.VIEWS.includes(v) || v === S.view) return;
  S.view = v;
  store.set('eden:cal:view', v);
  S.scroll = null;
  closePop();
  load(false);
}
function step(dir) { S.anchor = M.shiftAnchor(S.view, S.anchor, dir); S.mini = M.startOfMonth(S.anchor); S.scroll = null; closePop(); load(false); }
function goToday() { S.anchor = M.startOfDay(new Date()); S.mini = M.startOfMonth(S.anchor); S.selectedDay = S.anchor; S.scroll = null; closePop(); load(false); }
function goDay(d, view) { S.anchor = M.startOfDay(d); S.selectedDay = S.anchor; S.mini = M.startOfMonth(d); if (view) { S.view = view; store.set('eden:cal:view', view); } S.scroll = null; closePop(); load(false); }

function onKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    if (cancelDrag()) return;
    if (S.colorMenu) closeColorMenu();
    else if (S.sheet) closeSheet(); else if (S.pop) closePop(); else if (S.preview) clearPreview(); else if (S.sideOpen) { S.sideOpen = false; renderSideState(); } else closeCalendar();
    return;
  }
  if (e.key === 'Tab') { trapTab(e); return; }
  const tag = e.target && e.target.tagName;
  if (S.sheet || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 't') goToday();
  else if (e.key === 'ArrowLeft' && !e.target.closest('.seg')) step(-1);
  else if (e.key === 'ArrowRight' && !e.target.closest('.seg')) step(1);
  else if (k === 'd') setView('day');
  else if (k === 'w') setView('week');
  else if (k === 'm') setView('month');
  else if (k === 'y') setView('year');
  else if (k === 'a') setView('agenda');
  else if (k === 'n' || k === 'c') newEvent();
  else if (e.key === '/') { R.search.focus(); R.search.select(); }
  else if (e.key === 'ArrowUp' && S.view !== 'agenda' && !e.target.closest('.seg')) step(-1);
  else if (e.key === 'ArrowDown' && S.view !== 'agenda' && !e.target.closest('.seg')) step(1);
  else return;
  e.preventDefault();
}
function trapTab(e) {
  const scope = S.sheet ? R.sheet : S.pop ? R.card : R.card;
  const f = [...scope.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]')].filter((x) => x.offsetParent !== null);
  if (!f.length) return;
  if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
  else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
}
// Esc reaches the calendar first even when focus is outside it (the page's own Esc order runs after).
addEventListener('keydown', (e) => {
  if (!S.open || e.key !== 'Escape' || R.card.contains(e.target)) return;
  if (e.target && e.target.closest && e.target.closest('#palette, .sheet, .jc-menu')) return; // the palette or a dialog over the calendar closes first
  onKey(e);
}, true);

/* ---------------- render ---------------- */

function render() {
  if (!S.open) return;
  const r = range();
  R.title.textContent = isMobile() && S.view === 'day' ? S.anchor.toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' }) : M.rangeTitle(S.view, S.anchor, r, LOCALE);
  R.busy.classList.toggle('on', busy());
  setSeg(R.seg, M.VIEWS.indexOf(S.view));
  renderSide();
  renderBanners();
  renderView();
  if (S.pop) refreshPop();
}

function renderSideState() {
  R.card.classList.toggle('side-open', S.sideOpen);
  R.sideBtn.setAttribute('aria-expanded', String(S.sideOpen));
}

function renderSide() {
  renderSideState();
  // mini month
  const m = S.mini;
  const r = range();
  const grid = M.rangeFor('month', m, FIRST_DAY);
  const withEvents = new Set();
  for (const e of visibleEvents()) {
    const b = M.bounds(e);
    for (let d = M.startOfDay(b.s), i = 0; d < b.e && i < 62; d = M.addDays(d, 1), i++) withEvents.add(M.ymd(d));
    if (+b.e === +b.s) withEvents.add(M.ymd(b.s));
  }
  const today = new Date();
  const head = el('div', 'cal-mini-head',
    el('b', '', m.toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' })),
    el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Previous month', onclick: () => { S.mini = M.addMonths(S.mini, -1); renderSide(); } }, ico('chevl', 13)),
    el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Next month', onclick: () => { S.mini = M.addMonths(S.mini, 1); renderSide(); } }, ico('chevr', 13)));
  const dows = grid.days.slice(0, 7).map((d) => el('span', { class: 'cal-mini-dow', 'aria-hidden': 'true' }, d.toLocaleDateString(LOCALE, { weekday: 'narrow' })));
  const cells = grid.days.map((d) => {
    const cls = ['cal-mini-day'];
    if (d.getMonth() !== m.getMonth()) cls.push('other');
    if (M.sameDay(d, today)) cls.push('today');
    if (S.view !== 'month' && S.view !== 'agenda' && S.view !== 'year' && d >= r.start && d < r.end) cls.push('inrange');
    if (M.sameDay(d, S.anchor)) cls.push('sel');
    if (withEvents.has(M.ymd(d))) cls.push('dot');
    return el('button', { type: 'button', class: cls.join(' '), 'aria-label': d.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' }), onclick: () => goDay(d, S.view === 'agenda' ? 'agenda' : null) }, String(d.getDate()));
  });
  R.mini.replaceChildren(head, el('div', 'cal-mini-grid', ...dows, ...cells));

  // calendars, by source
  const groups = [];
  groups.push(sourceGroup('mac', 'On your Mac', [...S.mac.calendars.values()], macNote()));
  groups.push(sourceGroup('google', S.google.email ? `Google · ${S.google.email}` : 'Google', S.google.calendars, googleNote()));
  R.cals.replaceChildren(...groups);
}

function sourceGroup(source, title, cals, note) {
  const list = cals.map((c) => {
    const k = calKey(c.source, c.id);
    const input = el('input', { type: 'checkbox', 'aria-label': `Show ${c.title}` });
    input.checked = !S.hidden.has(k);
    input.addEventListener('change', () => toggleCalendar(c));
    const sw = el('button', { type: 'button', class: 'cal-swatch', 'aria-label': `Colour for ${c.title}`, title: 'Colour', 'aria-haspopup': 'dialog', 'aria-expanded': String(!!S.colorMenu && S.colorMenu.key === k), onclick: () => (S.colorMenu && S.colorMenu.key === k ? closeColorMenu() : openColorMenu(c, sw)) });
    return el('div', { class: 'cal-calrow', style: { '--c': calColor(c) } },
      el('label', { class: 'cal-cal', title: `${c.title}${c.readOnly ? ' (read-only)' : ''}${c.account ? ` · ${c.account}` : ''}` },
        input, el('span', { class: 'cal-check', 'aria-hidden': 'true' }, ico('check', 10)), el('span', 'nm', c.title), c.readOnly ? ico('lock', 11, 'ro') : null),
      sw);
  });
  return el('div', 'cal-group', el('div', 'cal-group-h', title), note, ...list);
}

/* ----- a calendar's colour (kept in this browser, per calendar) ----- */

function openColorMenu(c, anchor) {
  const k = calKey(c.source, c.id);
  const cur = (S.colors[k] || '').toLowerCase();
  S.colorMenu = { key: k, anchor };
  anchor.setAttribute('aria-expanded', 'true');
  const pick = (v) => {
    if (v) S.colors[k] = v; else delete S.colors[k];
    store.set('eden:cal:colors', S.colors);
    closeColorMenu();
    render();
    const again = [...R.cals.querySelectorAll('.cal-swatch')].find((b) => b.getAttribute('aria-label') === `Colour for ${c.title}`);
    if (again) again.focus();
  };
  const swatches = COLOURS.map(([name, v]) => el('button', { type: 'button', class: 'cal-sw', role: 'radio', 'aria-checked': String(cur === v), 'aria-label': name, title: name, style: { '--c': v }, onclick: () => pick(v) }, cur === v ? ico('check', 11) : null));
  const own = el('button', { type: 'button', class: 'cal-sw own', role: 'radio', 'aria-checked': String(!cur), 'aria-label': `${c.source === 'google' ? 'Google' : 'Mac'} colour`, title: `The calendar’s own colour (${c.source === 'google' ? 'from Google' : 'from your Mac'})`, style: { '--c': c.color || '#8e8e93' }, onclick: () => pick(null) }, !cur ? ico('check', 11) : null);
  const grid = el('div', { class: 'cal-sw-grid', role: 'radiogroup', 'aria-label': `Colour for ${c.title}` }, own, ...swatches);
  // arrow keys move between the colours
  grid.addEventListener('keydown', (e) => {
    const all = [...grid.querySelectorAll('.cal-sw')];
    const i = all.indexOf(document.activeElement);
    const d = { ArrowRight: 1, ArrowDown: 6, ArrowLeft: -1, ArrowUp: -6 }[e.key];
    if (i < 0 || !d) return;
    e.preventDefault();
    e.stopPropagation(); // not the calendar's ←/→ (previous/next)
    all[(i + d + all.length) % all.length].focus();
  });
  R.colors.replaceChildren(el('div', 'cal-colors-h', el('b', '', c.title), el('span', '', 'Only in Eden, on this device')), grid);
  R.colors.hidden = false;
  placeInCard(R.colors, anchor, isMobile() ? 'below' : 'right');
  requestAnimationFrame(() => { const f = grid.querySelector('[aria-checked="true"]') || grid.firstChild; if (f) f.focus(); });
}
function closeColorMenu() {
  if (!S.colorMenu) return false;
  const { anchor } = S.colorMenu;
  const hadFocus = R.colors.contains(document.activeElement);
  S.colorMenu = null;
  R.colors.hidden = true;
  if (anchor && document.contains(anchor)) { anchor.setAttribute('aria-expanded', 'false'); if (hadFocus) anchor.focus(); }
  return true;
}

function macNote() {
  const m = S.mac;
  if (m.state === 'off') return el('div', 'cal-note warn', el('b', '', 'Your Mac isn’t connected'), el('span', '', `${m.reason ? `${m.reason}. ` : ''}Open the Jarvis app on your Mac.`), el('button', { type: 'button', class: 'cap', onclick: () => load(true) }, 'Try again'));
  if (m.state === 'error') return el('div', 'cal-note warn', el('b', '', 'Couldn’t read the Mac’s calendar'), el('span', '', m.reason), el('button', { type: 'button', class: 'cap', onclick: () => load(true) }, 'Try again'));
  if (m.state === 'ready' && m.legacy) return el('div', 'cal-note', el('span', '', 'Restart Jarvis to change these from Eden and see their colours.'));
  if (m.state === 'ready' && !m.calendars.size) return el('div', 'cal-note', el('span', '', 'Nothing in this range yet.'));
  if (m.state === 'loading' && S.approval) return el('div', 'cal-note warn', el('b', '', 'Approve Eden on your Mac'), el('span', '', 'Jarvis is asking “Let Eden use Jarvis?”. Your calendars show once you allow it.'));
  if (m.state === 'loading' && !m.calendars.size) return el('div', 'cal-note', el('span', '', 'Asking your Mac…'));
  return null;
}

function googleNote() {
  const g = S.google;
  if (g.state === 'unset') return el('div', 'cal-note', el('span', '', 'Connect Google Calendar with your Google sign-in.'), el('button', { type: 'button', class: 'cap primary', onclick: () => { closeCalendar(); H.openSettings('accounts'); } }, 'Set up Google'));
  if (g.state === 'signin') return el('div', 'cal-note', el('span', '', 'Sign in with Google to see your Google calendars.'), el('button', { type: 'button', class: 'cap primary', onclick: connectGoogle }, 'Connect Google Calendar'));
  if (g.state === 'reconnect') return el('div', 'cal-note warn', el('b', '', 'Reconnect Google to see your calendar'), el('span', '', g.reason && !/reconnect google/i.test(g.reason) ? g.reason : 'Eden now asks Google for calendar access too.'), el('button', { type: 'button', class: 'cap primary', onclick: connectGoogle }, 'Reconnect Google'));
  if (g.state === 'error') return el('div', 'cal-note warn', el('b', '', 'Couldn’t read Google Calendar'), el('span', '', g.reason), el('button', { type: 'button', class: 'cap', onclick: () => load(true) }, 'Try again'));
  if (g.state === 'ready' && g.errors.length) return el('div', 'cal-note warn', el('span', '', `${g.errors.length} calendar${g.errors.length === 1 ? '' : 's'} couldn’t be read: ${g.errors[0].message}`));
  if (g.state === 'loading' && !g.calendars.length) return el('div', 'cal-note', el('span', '', 'Asking Google…'));
  return null;
}

async function connectGoogle() {
  try {
    const r = await api.googleConnect('calendar');
    if (!r || !r.url) { toast('Couldn’t start the Google sign-in'); return; }
    try { sessionStorage.setItem(RETURN_KEY, '1'); } catch { /* private mode: Mail opens instead */ }
    location.assign(r.url);
  } catch (e) { toast(`Couldn’t connect Google: ${e.message}`); }
}

function renderBanners() {
  const out = [];
  const macOk = usable(S.mac), gOk = usable(S.google);
  if (!macOk && !gOk && S.mac.state !== 'idle' && S.google.state !== 'idle') {
    out.push(el('div', 'cal-connect',
      el('div', 'cal-connect-ico', ico('cal', 26)),
      el('h3', '', 'Connect a calendar'),
      el('p', '', 'Eden shows your Mac’s calendars through the Jarvis app, and Google Calendar directly.'),
      el('div', 'cal-connect-acts',
        el('button', { type: 'button', class: 'btn', onclick: () => load(true) }, S.mac.state === 'error' ? 'Try the Mac again' : 'I’ve opened Jarvis'),
        S.google.state === 'unset' ? el('button', { type: 'button', class: 'btn primary', onclick: () => { closeCalendar(); H.openSettings('accounts'); } }, 'Set up Google')
          : S.google.state === 'error' ? el('button', { type: 'button', class: 'btn primary', onclick: () => load(true) }, 'Try Google again')
            : el('button', { type: 'button', class: 'btn primary', onclick: connectGoogle }, S.google.state === 'reconnect' ? 'Reconnect Google' : 'Connect Google Calendar')),
      el('p', 'cal-connect-why', [S.mac.state === 'off' || S.mac.state === 'error' ? `Mac: ${S.mac.reason || 'not connected'}.` : '', S.google.state === 'reconnect' ? 'Google: reconnect Google to see your calendar.' : S.google.state === 'error' ? `Google: ${S.google.reason}` : ''].filter(Boolean).join(' '))));
  } else if (S.approval && S.mac.state === 'loading') {
    out.push(el('div', 'cal-banner wait', ico('cal', 15), el('span', '', el('b', '', 'Approve Eden on your Mac. '), 'Jarvis is asking “Let Eden use Jarvis?”; your Mac’s calendars show once you allow it.')));
  } else if (S.google.state === 'reconnect' && macOk) {
    out.push(el('div', 'cal-banner', ico('cal', 15), el('span', '', 'Reconnect Google to see your calendar.'), el('button', { type: 'button', class: 'cap primary', onclick: connectGoogle }, 'Reconnect')));
  }
  R.banner.replaceChildren(...out);
  R.main.classList.toggle('blocked', out.some((x) => x.classList.contains('cal-connect')));
}

function renderView() {
  if (!S.open) return;
  if (S.drag && S.drag.active) { S.dragDirty = true; return; } // after the drop
  const r = range();
  const events = visibleEvents();
  const cals = calendarsById();
  let body;
  if (S.query) body = searchView(cals);
  else if (S.view === 'year') body = yearView(r, events);
  else if (S.view === 'month') body = isMobile() ? monthMobile(r, events, cals) : monthView(r, events, cals);
  else if (S.view === 'agenda') body = agendaView(r, events, cals);
  else body = timeGrid(r.days, events, cals);
  R.view.className = `cal-view v-${S.query ? 'search' : S.view}`;
  R.view.replaceChildren(body);
  const anyHere = events.some((e) => M.overlaps(e, r.start, r.end));
  if (!busy() && !anyHere && (usable(S.mac) || usable(S.google)) && S.view !== 'agenda' && S.view !== 'year' && !S.query) {
    R.view.append(el('div', 'cal-empty', S.view === 'day' ? 'Nothing on your calendar this day.' : S.view === 'week' ? 'Nothing on your calendar this week.' : 'Nothing on your calendar this month.'));
  }
  // while Jarvis waits on its card the banner says "Approve Eden on your Mac" instead of a spinner
  if (busy() && !anyHere && !S.query && S.view !== 'year' && !(S.approval && S.mac.state === 'loading')) R.view.append(el('div', 'cal-loading', el('span', 'cal-spin'), 'Loading your calendars…'));
  const sc = R.view.querySelector('.cal-tg-scroll');
  if (sc) {
    const now = new Date();
    const top = S.scroll !== null ? S.scroll : r.days.some((d) => M.sameDay(d, now)) ? Math.max(0, (M.minutesIntoDay(now) / 60 - 1.5) * HOUR_PX) : 7.5 * HOUR_PX;
    sc.scrollTop = top;
    sc.addEventListener('scroll', () => { S.scroll = sc.scrollTop; }, { passive: true });
  }
}

/* ----- an event's look ----- */

function evLabel(e, cals) {
  const c = cals.get(evCalKey(e));
  return `${e.title}, ${M.timeText(e, LOCALE)}${c ? `, ${c.title} calendar` : ''}`;
}
/** extra.shown: where a move waiting for review puts it (e itself stays the event that changes). */
function chip(e, cals, extra = {}) {
  const c = colorOf(e, cals);
  const v = extra.shown || e, moved = v !== e;
  const can = canDayDrag(e);
  const b = el('button', {
    type: 'button', class: `cal-chip${e.allDay || M.isLong(e) ? ' bar' : ''}${extra.cls ? ` ${extra.cls}` : ''}${moved ? ' moved' : ''}${can ? ' can-drag' : ''}${rsvpClass(e)}`,
    style: { '--c': c, ...(extra.style || {}) }, 'aria-label': `${evLabel(v, cals)}${moved ? ' (moved, press Return to review)' : ''}`, 'data-key': M.eventKey(e),
    ...(can ? { 'aria-keyshortcuts': S.view === 'month' ? 'Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown' : 'Alt+ArrowLeft Alt+ArrowRight', title: `Drag to another day · ⌥←/⌥→ moves a day${S.view === 'month' ? ', ⌥↑/⌥↓ a week' : ''}` } : {}),
  });
  if (e.allDay || M.isLong(e)) b.append(el('span', 't', e.title));
  else b.append(el('span', 'dot', ''), el('span', 't', e.title), el('span', 'tm', fmtTime(new Date(e.start))));
  b.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (Date.now() - S.justDragged < 400) return; // the click that ends a drag
    if (S.preview && S.preview.key === M.eventKey(e)) { reviewMove(e); return; }
    openPop(e, b);
  });
  if (can) {
    b.addEventListener('pointerdown', (ev) => startDayDrag(ev, e, b));
    b.addEventListener('keydown', (ev) => dayNudgeKey(ev, e));
    b.addEventListener('touchmove', (ev) => { if (S.drag && S.drag.active) ev.preventDefault(); }, { passive: false });
    b.addEventListener('contextmenu', (ev) => { if (S.drag) ev.preventDefault(); });
  }
  return b;
}
/** Events with a move waiting for review drawn where they're going (`orig`: the event itself). */
function withPreview(events) {
  return events.map((e) => { const v = previewOf(e); return v === e ? e : { ...v, orig: e }; });
}

/* ----- month ----- */

function monthView(r, events, cals) {
  const weeks = r.days.length / 7;
  const box = el('div', 'cal-month');
  box.append(el('div', 'cal-mhead', ...r.days.slice(0, 7).map((d) => el('span', '', d.toLocaleDateString(LOCALE, { weekday: 'short' })))));
  const avail = Math.max(240, (R.view.clientHeight || 600) - 30);
  const rowH = avail / weeks;
  const lanes = Math.max(1, Math.floor((rowH - 28) / LANE_PX));
  const today = new Date();
  const wrap = el('div', 'cal-weeks');
  for (let w = 0; w < weeks; w++) {
    const days = r.days.slice(w * 7, w * 7 + 7);
    const wk = days[0], wkEnd = M.addDays(days[6], 1);
    const inWeek = withPreview(events).filter((e) => M.overlaps(e, wk, wkEnd));
    const { rows, counts } = M.layoutLanes(inWeek, days, { startDayOnly: true });
    const row = el('div', { class: 'cal-week', style: { gridTemplateRows: `26px repeat(${lanes}, ${LANE_PX}px) 1fr` } });
    days.forEach((d, i) => {
      const cls = ['cal-mday'];
      if (d.getMonth() !== S.anchor.getMonth()) cls.push('other');
      if (M.sameDay(d, today)) cls.push('today');
      if (d.getDay() === 0 || d.getDay() === 6) cls.push('wkend');
      const cell = el('div', { class: cls.join(' '), style: { gridColumn: `${i + 1}`, gridRow: '1 / -1' }, 'data-day': M.ymd(d) },
        el('button', { type: 'button', class: 'cal-mnum', 'aria-label': `${d.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' })}: open the day`, onclick: () => goDay(d, 'day') },
          d.getDate() === 1 ? d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' }) : String(d.getDate())));
      cell.addEventListener('dblclick', (ev) => { if (!ev.target.closest('button')) newEvent({ day: d }); });
      row.append(cell);
    });
    // overflow: a day with more than `lanes` events shows lanes-1 and "+n more"
    const over = counts.map((n) => n > lanes);
    const hiddenOn = new Array(7).fill(0);
    for (const x of rows) {
      const cut = over.slice(x.from, x.to).some(Boolean) ? lanes - 1 : lanes;
      if (x.lane >= cut) { for (let i = x.from; i < x.to; i++) hiddenOn[i]++; continue; }
      const b = M.bounds(x.event);
      const cls = [b.s < wk ? 'cont-l' : '', b.e > wkEnd ? 'cont-r' : ''].filter(Boolean).join(' ');
      row.append(chip(x.event.orig || x.event, cals, { shown: x.event, cls, style: { gridRow: `${x.lane + 2}`, gridColumn: `${x.from + 1} / ${x.to + 1}` } }));
    }
    hiddenOn.forEach((n, i) => {
      if (!n) return;
      row.append(el('button', { type: 'button', class: 'cal-more', style: { gridRow: `${lanes + 1}`, gridColumn: `${i + 1}` }, onclick: () => goDay(days[i], 'day') }, `${n} more`));
    });
    wrap.append(row);
  }
  box.append(wrap);
  return box;
}

function monthMobile(r, events, cals) {
  const sel = S.selectedDay && r.days.some((d) => M.sameDay(d, S.selectedDay)) ? S.selectedDay : (r.days.find((d) => M.sameDay(d, new Date())) || M.startOfMonth(S.anchor));
  const today = new Date();
  const grid = el('div', 'cal-mm-grid', ...r.days.slice(0, 7).map((d) => el('span', 'cal-mm-dow', d.toLocaleDateString(LOCALE, { weekday: 'narrow' }))));
  for (const d of r.days) {
    const next = M.addDays(d, 1);
    const todays = events.filter((e) => M.overlaps(e, d, next));
    const cls = ['cal-mm-day'];
    if (d.getMonth() !== S.anchor.getMonth()) cls.push('other');
    if (M.sameDay(d, today)) cls.push('today');
    if (M.sameDay(d, sel)) cls.push('sel');
    grid.append(el('button', { type: 'button', class: cls.join(' '), 'aria-label': `${d.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' })}, ${todays.length} event${todays.length === 1 ? '' : 's'}`, onclick: () => { S.selectedDay = d; renderView(); } },
      el('span', 'n', String(d.getDate())),
      el('span', 'dots', ...todays.slice(0, 3).map((e) => el('i', { style: { background: colorOf(e, cals) } })))));
  }
  const list = dayList(sel, events, cals);
  return el('div', 'cal-mm', grid, el('div', 'cal-mm-list', el('div', 'cal-ad-h', sel.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' })), list));
}

/* ----- day and week: the time grid ----- */

function timeGrid(days, events, cals) {
  const n = days.length;
  const today = new Date();
  const cols = `var(--cal-gut) repeat(${n}, minmax(0, 1fr))`;
  const head = el('div', { class: 'cal-tg-head', style: { gridTemplateColumns: cols } }, el('span', ''),
    ...days.map((d) => el('button', { type: 'button', class: `cal-tg-day${M.sameDay(d, today) ? ' today' : ''}`, 'data-day': M.ymd(d), onclick: () => goDay(d, 'day'), 'aria-label': `${d.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' })}: open the day` },
      el('span', 'w', d.toLocaleDateString(LOCALE, { weekday: n === 1 ? 'long' : 'short' })), el('span', 'n', String(d.getDate())))));
  // all-day strip
  const start = days[0], end = M.addDays(days[n - 1], 1);
  const long = withPreview(events).filter((e) => M.isLong(e) && M.overlaps(e, start, end));
  const { rows, lanes } = M.layoutLanes(long, days);
  const showLanes = S.alldayOpen ? lanes : Math.min(lanes, ALLDAY_LANES);
  const extra = rows.filter((x) => x.lane >= showLanes).length;
  const strip = el('div', { class: 'cal-tg-allday', style: { gridTemplateColumns: cols, gridTemplateRows: `repeat(${Math.max(1, showLanes)}, ${LANE_PX}px)` } },
    el('span', { class: 'cal-tg-adl', style: { gridRow: `1 / span ${Math.max(1, showLanes)}` } }, 'all-day',
      extra || (S.alldayOpen && lanes > ALLDAY_LANES) ? el('button', { type: 'button', class: 'cal-admore', onclick: () => { S.alldayOpen = !S.alldayOpen; renderView(); } }, S.alldayOpen ? 'less' : `+${extra}`) : null));
  for (const x of rows) {
    if (x.lane >= showLanes) continue;
    const b = M.bounds(x.event);
    strip.append(chip(x.event.orig || x.event, cals, { shown: x.event, cls: [b.s < start ? 'cont-l' : '', b.e > end ? 'cont-r' : ''].join(' ').trim(), style: { gridRow: `${x.lane + 1}`, gridColumn: `${x.from + 2} / ${x.to + 2}` } }));
  }
  // the hours
  const nowMin = days.some((d) => M.sameDay(d, today)) ? M.minutesIntoDay(today) : -999;
  const gutter = el('div', 'cal-tg-gutter', ...Array.from({ length: 23 }, (_, i) => el('span', { class: Math.abs((i + 1) * 60 - nowMin) < 14 ? 'near-now' : null, 'data-min': (i + 1) * 60, style: { top: `${(i + 1) * HOUR_PX}px` } }, hourLabel(i + 1))));
  const grid = el('div', { class: 'cal-tg-grid', style: { gridTemplateColumns: cols, height: `${24 * HOUR_PX}px`, '--hour': `${HOUR_PX}px`, '--ws': `${WORK.start * HOUR_PX}px`, '--we': `${WORK.end * HOUR_PX}px` } }, gutter);
  days.forEach((d) => {
    const col = el('div', { class: `cal-col${M.sameDay(d, today) ? ' today' : ''}${d.getDay() === 0 || d.getDay() === 6 ? ' wkend' : ''}` });
    const segs = [];
    for (const e of events) {
      if (M.isLong(e)) continue;
      const v = previewOf(e); // a moved/resized event awaiting review shows where it's going
      const s = M.daySegment(v, d);
      if (s) segs.push({ ...s, event: e, shown: v });
    }
    for (const s of M.layoutColumns(segs)) {
      const e = s.event, v = s.shown;
      const h = Math.max(18, ((s.endMin - s.startMin) / 60) * HOUR_PX - 2);
      const can = !s.before && canDrag(e, v); // dragged by its first day
      const b = el('button', {
        type: 'button', class: `cal-tev${h < 30 ? ' short' : ''}${s.before ? ' cont-t' : ''}${s.after ? ' cont-b' : ''}${new Date(v.end) < today ? ' past' : ''}${v !== e ? ' moved' : ''}${can ? ' can-drag' : ''}${rsvpClass(e)}`,
        style: { '--c': colorOf(e, cals), top: `${(s.startMin / 60) * HOUR_PX + 1}px`, height: `${h}px`, left: `calc(${(s.col / s.cols) * 100}% + 1px)`, width: `calc(${(s.span / s.cols) * 100}% - 3px)` },
        'aria-label': `${evLabel(v, cals)}${v !== e ? ' (moved, press Return to review)' : ''}`, 'data-key': M.eventKey(e),
        ...(can ? { 'aria-keyshortcuts': 'Alt+ArrowUp Alt+ArrowDown Alt+Shift+ArrowUp Alt+Shift+ArrowDown', title: `Drag to move${!s.before && !s.after ? ', drag the bottom edge to change the length' : ''} · ⌥↑↓ moves, ⌥⇧↑↓ changes the length` } : {}),
      }, el('span', 't', e.title), h >= 30 ? el('span', 'tm', `${fmtTime(new Date(v.start))} – ${fmtTime(new Date(v.end))}`) : null, h >= 52 && e.location ? el('span', 'loc', e.location) : null);
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (Date.now() - S.justDragged < 400) return; // the click that ends a drag
        if (S.preview && S.preview.key === M.eventKey(e)) { reviewMove(e); return; }
        openPop(e, b);
      });
      if (can) {
        b.addEventListener('pointerdown', (ev) => startDrag(ev, e, b, 'move'));
        b.addEventListener('keydown', (ev) => nudgeKey(ev, e));
        b.addEventListener('touchmove', (ev) => { if (S.drag && S.drag.active) ev.preventDefault(); }, { passive: false });
        b.addEventListener('contextmenu', (ev) => { if (S.drag) ev.preventDefault(); });
        if (!s.before && !s.after && h >= 30) {
          const grip = el('span', { class: 'cal-rsz', 'aria-hidden': 'true' });
          grip.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); startDrag(ev, e, b, 'resize'); });
          b.append(grip);
        }
      }
      col.append(b);
    }
    col.addEventListener('pointerdown', (ev) => { if (ev.target === col && ev.button === 0 && ev.pointerType === 'mouse' && !S.sheet && !S.drag) startCreateDrag(ev, col, d); });
    col.addEventListener('click', (ev) => {
      if (ev.target !== col || Date.now() - S.justDragged < 400) return;
      const y = ev.offsetY;
      const min = Math.max(0, Math.min(23 * 60 + 30, Math.floor((y / HOUR_PX) * 2) * 30));
      const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Math.floor(min / 60), min % 60);
      newEvent({ start: s, end: new Date(s.getTime() + 3600e3) });
    });
    grid.append(col);
  });
  if (days.some((d) => M.sameDay(d, today))) grid.append(nowLine(days));
  const scroll = el('div', 'cal-tg-scroll', grid);
  return el('div', `cal-tg n${n}`, head, strip, scroll);
}

/* ----- moving and resizing: drag (mouse, or touch after a long press) and ⌥ + arrows ----- */

/** The event as it will be after the move waiting for review (or itself). */
function previewOf(e) {
  if (!S.preview || S.preview.key !== M.eventKey(e)) return e;
  const at = (d) => (e.allDay ? M.ymd(d) : d.toISOString());
  return { ...e, start: at(S.preview.start), end: at(S.preview.end) };
}
/** Timed, writable, and its first day is here (Mac events: Jarvis can change the start and the length). */
function canDrag(e, v) {
  if (e.allDay || M.isLong(e) || M.isLong(v) || (S.view !== 'week' && S.view !== 'day')) return false;
  const w = writableFor(e);
  return w.edit;
}

function startDrag(ev, e, b, mode) {
  if (ev.button !== 0 || S.sheet || S.drag) return;
  const grid = b.closest('.cal-tg-grid'), scroller = grid && grid.parentElement;
  if (!grid) return;
  const cols = [...grid.querySelectorAll('.cal-col')];
  const st = { e, b, mode, grid, scroller, cols, id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, sc0: scroller.scrollTop,
    col0: cols.indexOf(b.parentElement), touch: ev.pointerType !== 'mouse', active: false, ghost: null, times: null, timer: null };
  S.drag = st;
  const move = (m) => {
    if (m.pointerId !== st.id) return;
    const dx = m.clientX - st.x0, dy = m.clientY - st.y0;
    if (!st.active) {
      if (st.touch) { if (Math.hypot(dx, dy) > 8) end(null); return; } // a swipe: let it scroll
      if (Math.hypot(dx, dy) < 4) return;
      activate();
    }
    m.preventDefault();
    // near the top or bottom edge: scroll the hours along
    const r = scroller.getBoundingClientRect();
    if (m.clientY < r.top + 28) scroller.scrollTop -= 12; else if (m.clientY > r.bottom - 28) scroller.scrollTop += 12;
    track(m.clientX, m.clientY);
  };
  const up = (u) => { if (u.pointerId === st.id) end(u.type === 'pointerup' ? u : null); };
  const activate = () => {
    st.active = true;
    clearTimeout(st.timer);
    closePop();
    b.classList.add('drag-src');
    st.ghost = b.cloneNode(true);
    st.ghost.classList.add('cal-ghost');
    st.ghost.removeAttribute('data-key');
    st.ghost.setAttribute('aria-hidden', 'true');
    Object.assign(st.ghost.style, { left: '1px', width: 'calc(100% - 3px)' });
    b.parentElement.append(st.ghost);
    document.body.classList.add(mode === 'resize' ? 'cal-resizing' : 'cal-dragging');
    if (st.touch && navigator.vibrate) navigator.vibrate(8);
    track(st.x0, st.y0);
  };
  const track = (x, y) => {
    const minutes = ((y - st.y0 + scroller.scrollTop - st.sc0) / HOUR_PX) * 60;
    let ci = st.col0;
    if (mode === 'move' && cols.length > 1) {
      ci = cols.findIndex((c) => { const r = c.getBoundingClientRect(); return x >= r.left && x < r.right; });
      if (ci < 0) ci = x < cols[0].getBoundingClientRect().left ? 0 : cols.length - 1;
    }
    st.times = M.dragTimes(e, mode, minutes, ci - st.col0);
    const v = { ...e, start: st.times.start.toISOString(), end: st.times.end.toISOString() };
    const seg = M.daySegment(v, M.startOfDay(st.times.start)) || { startMin: 0, endMin: 15 };
    const h = Math.max(18, ((seg.endMin - seg.startMin) / 60) * HOUR_PX - 2);
    if (st.ghost.parentElement !== cols[ci]) cols[ci].append(st.ghost);
    Object.assign(st.ghost.style, { top: `${(seg.startMin / 60) * HOUR_PX + 1}px`, height: `${h}px` });
    st.ghost.classList.toggle('short', h < 30);
    let tm = st.ghost.querySelector('.tm');
    if (!tm) { tm = el('span', 'tm'); st.ghost.querySelector('.t').after(tm); }
    tm.textContent = `${fmtTime(st.times.start)} – ${fmtTime(st.times.end)}`;
  };
  const end = (u) => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', up);
    clearTimeout(st.timer);
    S.drag = null;
    document.body.classList.remove('cal-dragging', 'cal-resizing');
    if (!st.active) return;
    S.justDragged = Date.now();
    if (st.ghost) st.ghost.remove();
    b.classList.remove('drag-src');
    const b0 = M.bounds(e);
    const t = u && st.times;
    if (t && (+t.start !== +b0.s || +t.end !== +b0.e)) {
      S.preview = { key: M.eventKey(e), start: t.start, end: t.end };
      S.dragDirty = false;
      renderView();
      reviewMove(e);
    } else if (S.dragDirty) { S.dragDirty = false; renderView(); }
  };
  addEventListener('pointermove', move, { passive: false });
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
  if (st.touch) st.timer = setTimeout(activate, LONG_PRESS_MS);
}
/** Drag down an empty part of a day to make an event of that length (a plain click makes an hour). */
function startCreateDrag(ev, col, day) {
  const top = () => col.getBoundingClientRect().top;
  const minAt = (y) => Math.max(0, Math.min(1440, M.snap(((y - top()) / HOUR_PX) * 60)));
  const m0 = Math.min(1440 - M.SNAP_MIN, Math.floor((((ev.clientY - top()) / HOUR_PX) * 60) / M.SNAP_MIN) * M.SNAP_MIN);
  const st = { id: ev.pointerId, y0: ev.clientY, active: false, ghost: null, a: m0, b: m0 + 60 };
  S.drag = st;
  const at = (min) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, min);
  const paint = () => {
    const a = Math.min(st.a, st.b), b = Math.max(st.a, st.b);
    Object.assign(st.ghost.style, { top: `${(a / 60) * HOUR_PX + 1}px`, height: `${Math.max(18, ((b - a) / 60) * HOUR_PX - 2)}px` });
    st.ghost.querySelector('.tm').textContent = `${fmtTime(at(a))} – ${fmtTime(at(b))}`;
  };
  const move = (m) => {
    if (m.pointerId !== st.id) return;
    if (!st.active) {
      if (Math.abs(m.clientY - st.y0) < 6) return;
      st.active = true;
      st.ghost = el('div', { class: 'cal-tev cal-ghost cal-newghost', 'aria-hidden': 'true', style: { left: '1px', width: 'calc(100% - 3px)' } }, el('span', 't', '(No title)'), el('span', 'tm', ''));
      col.append(st.ghost);
      document.body.classList.add('cal-resizing');
    }
    m.preventDefault();
    const cur = minAt(m.clientY);
    st.b = cur >= m0 ? Math.max(m0 + M.SNAP_MIN, cur) : cur;
    st.a = cur >= m0 ? m0 : Math.min(1440 - M.SNAP_MIN, m0 + M.SNAP_MIN);
    paint();
  };
  const end = (u) => {
    if (u.pointerId !== st.id) return;
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', end);
    removeEventListener('pointercancel', end);
    S.drag = null;
    document.body.classList.remove('cal-resizing');
    if (!st.active) return;
    S.justDragged = Date.now();
    if (st.ghost) st.ghost.remove();
    if (u.type !== 'pointerup') return;
    const a = Math.min(st.a, st.b), b = Math.max(st.a, st.b);
    newEvent({ start: at(a), end: at(b) });
  };
  addEventListener('pointermove', move, { passive: false });
  addEventListener('pointerup', end);
  addEventListener('pointercancel', end);
}
function cancelDrag() {
  if (!S.drag) return false;
  dispatchEvent(new PointerEvent('pointercancel', { pointerId: S.drag.id }));
  return true;
}

/* ----- all-day rows (month, and the week's all-day strip): drag to another day, or ⌥←/⌥→ ----- */

/** In the all-day rows (all-day, or a day or longer), writable, in month or week view. */
function canDayDrag(e) {
  return M.isLong(e) && (S.view === 'month' || S.view === 'week') && writableFor(e).edit;
}

/** The day under the pointer: month cells by x and y, the week's day headers by x alone. */
function dayUnder(targets, x, y) {
  const month = S.view === 'month';
  for (const t of targets) {
    const r = t.getBoundingClientRect();
    if (x >= r.left && x < r.right && (!month || (y >= r.top && y < r.bottom))) return M.parseYmd(t.dataset.day);
  }
  return null;
}

/** The first and last day { first, last } an event at { start, end } covers (an all-day end, or a midnight one, is exclusive). */
function daysCovered(e, t) {
  const first = M.startOfDay(t.start), endDay = M.startOfDay(t.end);
  const last = e.allDay || +t.end === +endDay ? M.addDays(endDay, -1) : endDay;
  return { first, last: last < first ? first : last };
}
/** Days a move would cover, marked on the month's cells or the week's day headers. */
function markDrop(targets, e, t) {
  const { first, last } = daysCovered(e, t);
  for (const c of targets) { const d = M.parseYmd(c.dataset.day); c.classList.toggle('drop', d >= first && d <= last); }
}

function startDayDrag(ev, e, b) {
  if (ev.button !== 0 || S.sheet || S.drag) return;
  const targets = [...R.view.querySelectorAll('[data-day]')];
  const day0 = dayUnder(targets, ev.clientX, ev.clientY);
  if (!day0) return;
  const st = { e, b, id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, touch: ev.pointerType !== 'mouse', active: false, shift: 0, timer: null, ghost: null };
  S.drag = st;
  const strip = b.closest('.cal-tg-allday');
  const move = (m) => {
    if (m.pointerId !== st.id) return;
    if (!st.active) {
      const dist = Math.hypot(m.clientX - st.x0, m.clientY - st.y0);
      if (st.touch) { if (dist > 8) end(null); return; } // a swipe: let it scroll
      if (dist < 4) return;
      activate();
    }
    m.preventDefault();
    track(m.clientX, m.clientY);
  };
  const up = (u) => { if (u.pointerId === st.id) end(u.type === 'pointerup' ? u : null); };
  const activate = () => {
    st.active = true;
    clearTimeout(st.timer);
    closePop();
    b.classList.add('drag-src');
    if (strip) { // the week: a ghost in the strip; the month marks the days it would cover
      st.ghost = b.cloneNode(true);
      st.ghost.classList.add('cal-ghost');
      st.ghost.classList.remove('drag-src', 'cont-l', 'cont-r');
      st.ghost.removeAttribute('data-key');
      st.ghost.setAttribute('aria-hidden', 'true');
      strip.append(st.ghost);
    }
    document.body.classList.add('cal-dragging');
    if (st.touch && navigator.vibrate) navigator.vibrate(8);
    track(st.x0, st.y0);
  };
  const track = (x, y) => {
    const d = dayUnder(targets, x, y);
    if (d) st.shift = M.daysBetween(day0, d);
    const t = M.shiftDays(e, st.shift);
    markDrop(targets, e, t);
    if (st.ghost) { // the strip's columns: the gutter, then one per day header
      const { first, last } = daysCovered(e, t);
      const from = M.daysBetween(M.parseYmd(targets[0].dataset.day), first), to = M.daysBetween(M.parseYmd(targets[0].dataset.day), last) + 1;
      st.ghost.style.gridColumn = `${Math.max(0, from) + 2} / ${Math.min(targets.length, to) + 2}`;
      st.ghost.hidden = to <= 0 || from >= targets.length;
    }
    R.live.textContent = M.timeText({ ...e, start: e.allDay ? M.ymd(t.start) : t.start.toISOString(), end: e.allDay ? M.ymd(t.end) : t.end.toISOString() }, LOCALE);
  };
  const end = (u) => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', up);
    clearTimeout(st.timer);
    S.drag = null;
    document.body.classList.remove('cal-dragging');
    if (!st.active) return;
    S.justDragged = Date.now();
    if (st.ghost) st.ghost.remove();
    b.classList.remove('drag-src');
    targets.forEach((c) => c.classList.remove('drop'));
    if (u && st.shift) {
      S.preview = { key: M.eventKey(e), ...M.shiftDays(e, st.shift) };
      S.dragDirty = false;
      renderView();
      reviewMove(e);
    } else if (S.dragDirty) { S.dragDirty = false; renderView(); }
  };
  addEventListener('pointermove', move, { passive: false });
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
  if (st.touch) st.timer = setTimeout(activate, LONG_PRESS_MS);
}

/** ⌥←/⌥→ move an all-day event a day, ⌥↑/⌥↓ a week (month view); Return reviews, Esc puts it back. */
function dayNudgeKey(ev, e) {
  if (!ev.altKey || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
  const by = { ArrowLeft: -1, ArrowRight: 1, ...(S.view === 'month' ? { ArrowUp: -7, ArrowDown: 7 } : {}) }[ev.key];
  if (!by) return;
  ev.preventDefault();
  ev.stopPropagation();
  const key = M.eventKey(e);
  const b0 = M.bounds(e);
  const now = S.preview && S.preview.key === key ? M.daysBetween(M.startOfDay(b0.s), M.startOfDay(S.preview.start)) : 0;
  const t = M.shiftDays(e, now + by);
  const r = range();
  if (t.start >= r.end || t.end <= r.start) return; // stays on the page shown
  S.preview = now + by === 0 ? null : { key, ...t };
  renderView();
  const again = R.view.querySelector(`.cal-chip[data-key="${CSS.escape(key)}"]`);
  if (again) { again.focus({ preventScroll: true }); again.scrollIntoView({ block: 'nearest' }); }
  R.live.textContent = `${M.timeText(previewOf(e), LOCALE)}${S.preview ? ', press Return to review' : ''}`;
}

/** ⌥↑/⌥↓ move by a quarter hour, ⌥⇧↑/⌥⇧↓ change the length, ⌥←/⌥→ move a day (week view); Return reviews, Esc puts it back. */
function nudgeKey(ev, e) {
  if (!ev.altKey || ev.metaKey || ev.ctrlKey || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(ev.key)) return;
  ev.preventDefault();
  ev.stopPropagation();
  const key = M.eventKey(e);
  const cur = previewOf(e);
  const b = M.bounds(cur);
  let t;
  if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
    if (S.view !== 'week' || ev.shiftKey) return;
    t = M.dragTimes(cur, 'move', 0, ev.key === 'ArrowLeft' ? -1 : 1);
    const r = range();
    if (t.start < r.start || t.start >= r.end) return; // stays in the week shown
  } else {
    const dir = ev.key === 'ArrowUp' ? -1 : 1;
    t = ev.shiftKey ? M.dragTimes(cur, 'resize', M.nudgeMinutes(M.minutesIntoDay(b.e) || 1440, dir))
      : M.dragTimes(cur, 'move', M.nudgeMinutes(M.minutesIntoDay(b.s), dir));
  }
  const b0 = M.bounds(e);
  S.preview = +t.start === +b0.s && +t.end === +b0.e ? null : { key, start: t.start, end: t.end };
  renderView();
  const again = R.view.querySelector(`.cal-tev[data-key="${CSS.escape(key)}"]`);
  if (again) { again.focus({ preventScroll: true }); again.scrollIntoView({ block: 'nearest' }); }
  R.live.textContent = `${fmtTime(t.start)} to ${fmtTime(t.end)}${S.preview ? ', press Return to review' : ''}`;
}

/** A moved or resized event: the same review as an edit; nothing changes until it's confirmed. */
function reviewMove(e) {
  const p = S.preview;
  if (!p || p.key !== M.eventKey(e)) return;
  const cal = calendarsById().get(evCalKey(e));
  if (!cal) { clearPreview(); return; }
  seriesRules(e).catch(() => []).then((rules) => reviewWrite({ mode: 'update', original: e, cal, draft: M.dragDraft(e, p.start, p.end), baseRules: rules }));
}
function clearPreview() {
  if (!S.preview) return false;
  const key = S.preview.key;
  S.preview = null;
  renderView();
  const b = R.view.querySelector(`.cal-tev[data-key="${CSS.escape(key)}"], .cal-chip[data-key="${CSS.escape(key)}"]`);
  if (b && R.card.contains(document.activeElement) === false) b.focus({ preventScroll: true });
  return true;
}

function nowLine(days) {
  const now = new Date();
  const i = days.findIndex((d) => M.sameDay(d, now));
  const top = (M.minutesIntoDay(now) / 60) * HOUR_PX;
  return el('div', { class: 'cal-now', style: { top: `${top}px`, '--i': i, '--n': days.length }, 'aria-hidden': 'true' },
    el('span', 'lbl', nowLabel(now)), el('span', 'line'), el('span', 'today-line'));
}
function tickNow() {
  if (!S.open) return;
  const line = R.view.querySelector('.cal-now');
  if (line) {
    const now = new Date(), min = M.minutesIntoDay(now);
    line.style.top = `${(min / 60) * HOUR_PX}px`;
    line.querySelector('.lbl').textContent = nowLabel(now);
    R.view.querySelectorAll('.cal-tg-gutter span').forEach((s) => s.classList.toggle('near-now', Math.abs(Number(s.dataset.min) - min) < 14));
  }
  if (line && !M.sameDay(new Date(), new Date(Date.now() - 60_000))) renderView(); // midnight
}

/* ----- year (twelve small months: a day opens it; dots for what's loaded) ----- */

function yearView(r, events) {
  const y = S.anchor.getFullYear();
  const today = new Date();
  const withEvents = new Set();
  for (const e of events) {
    const b = M.bounds(e);
    for (let d = M.startOfDay(b.s), i = 0; d < b.e && i < 62; d = M.addDays(d, 1), i++) withEvents.add(M.ymd(d));
    if (+b.e === +b.s) withEvents.add(M.ymd(b.s));
  }
  const months = Array.from({ length: 12 }, (_, mo) => {
    const first = new Date(y, mo, 1);
    const grid = M.rangeFor('month', first, FIRST_DAY);
    const cells = grid.days.map((d) => {
      if (d.getMonth() !== mo) return el('span', 'cal-yr-pad', '');
      const cls = ['cal-yr-day'];
      if (M.sameDay(d, today)) cls.push('today');
      if (withEvents.has(M.ymd(d))) cls.push('dot');
      return el('button', { type: 'button', class: cls.join(' '), 'aria-label': d.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }), onclick: () => goDay(d, 'day') }, String(d.getDate()));
    });
    return el('section', 'cal-yr-m',
      el('button', { type: 'button', class: 'cal-yr-h', onclick: () => goDay(first, 'month') }, first.toLocaleDateString(LOCALE, { month: 'long' })),
      el('div', 'cal-yr-grid', ...grid.days.slice(0, 7).map((d) => el('span', { class: 'cal-yr-dow', 'aria-hidden': 'true' }, d.toLocaleDateString(LOCALE, { weekday: 'narrow' }))), ...cells));
  });
  return el('div', 'cal-year', ...months);
}

/* ----- search results (30 days back to 60 ahead) ----- */

function searchView(cals) {
  const hits = searchHits();
  const head = el('div', 'cal-sr-h', busy() ? 'Searching…' : `${hits.length} event${hits.length === 1 ? '' : 's'} matching “${S.query}”`, el('small', '', ' · from 30 days ago to 60 days ahead'));
  if (!hits.length) return el('div', 'cal-agenda', head, el('div', 'cal-ad-empty', busy() ? '' : 'Nothing matches. Try another word.'));
  const out = [head];
  let day = null;
  for (const e of hits) {
    const d = M.startOfDay(M.bounds(e).s);
    if (!day || !M.sameDay(day, d)) { day = d; out.push(el('div', `cal-ad-h${M.sameDay(d, new Date()) ? ' today' : ''}`, d.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))); }
    out.push(agendaRow(e, d, cals));
  }
  return el('div', 'cal-agenda', ...out);
}

/* ----- agenda ----- */

function dayList(d, events, cals) {
  const next = M.addDays(d, 1);
  const todays = events.filter((e) => M.overlaps(e, d, next)).sort((a, b) => (a.allDay === b.allDay ? M.bounds(a).s - M.bounds(b).s : a.allDay ? -1 : 1));
  if (!todays.length) return el('div', 'cal-ad-none', 'No events');
  return el('div', 'cal-ad-list', ...todays.map((e) => agendaRow(e, d, cals)));
}
function agendaRow(e, d, cals) {
  const c = cals.get(evCalKey(e));
  const b = M.bounds(e);
  let when;
  if (e.allDay || M.isLong(e)) when = el('span', 'when', 'all-day');
  else {
    const s = b.s < d ? null : b.s, en = b.e > M.addDays(d, 1) ? null : b.e;
    when = el('span', 'when', el('b', '', s ? fmtTime(s) : '…'), el('span', '', en ? fmtTime(en) : '…'));
  }
  const row = el('button', { type: 'button', class: `cal-arow${rsvpClass(e)}`, style: { '--c': colorOf(e, cals) }, 'aria-label': evLabel(e, cals), 'data-key': M.eventKey(e) },
    el('span', 'bar'), when,
    el('span', 'what', el('b', '', e.title), e.location || c ? el('span', '', [e.location, c && c.title].filter(Boolean).join(' · ')) : null),
    e.recurrence && e.recurrence.recurring ? ico('retry', 12, 'rep') : null);
  row.addEventListener('click', (ev) => { ev.stopPropagation(); openPop(e, row); });
  return row;
}
function agendaView(r, events, cals) {
  const out = [];
  const today = new Date();
  for (const d of r.days) {
    const next = M.addDays(d, 1);
    if (!events.some((e) => M.overlaps(e, d, next))) continue;
    const label = d.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long' });
    out.push(el('div', `cal-ad-h${M.sameDay(d, today) ? ' today' : ''}`, M.sameDay(d, today) ? `Today · ${label}` : label), dayList(d, events, cals));
  }
  if (!out.length) out.push(el('div', 'cal-ad-empty', busy() ? '' : `Nothing on your calendar in the next ${M.AGENDA_DAYS} days.`));
  return el('div', 'cal-agenda', ...out);
}

/* ---------------- the event popover ---------------- */

function findEvent(key) { return [...S.mac.events, ...S.google.events].find((e) => M.eventKey(e) === key) || null; }

function openPop(e, anchor) {
  S.pop = { key: M.eventKey(e), anchor };
  drawPop(e);
}
function refreshPop() {
  const e = findEvent(S.pop.key);
  if (!e || S.hidden.has(evCalKey(e))) { closePop(); return; }
  const a = R.view.querySelector(`[data-key="${CSS.escape(S.pop.key)}"]`);
  if (a) S.pop.anchor = a;
  drawPop(e);
}
function closePop() {
  if (!S.pop) return false;
  const a = S.pop.anchor;
  const hadFocus = R.pop.contains(document.activeElement);
  S.pop = null;
  R.pop.hidden = true;
  if (hadFocus && a && document.contains(a)) a.focus({ preventScroll: true });
  return true;
}

function writableFor(e) {
  if (e.readOnly) return { edit: false, del: false, why: e.source === 'mac' && S.mac.legacy ? 'Restart Jarvis to change Mac events from Eden.' : 'This calendar is read-only.' };
  if (e.source === 'mac' && S.mac.legacy) return { edit: false, del: false, why: 'Restart Jarvis to change Mac events from Eden.' };
  return { edit: !!e.canEdit, del: true, why: e.canEdit ? '' : 'Only the organizer can change this event.' };
}

function drawPop(e) {
  const cals = calendarsById();
  const c = cals.get(evCalKey(e));
  const color = colorOf(e, cals);
  const zone = M.localZone();
  const w = writableFor(e);
  const me = (e.attendees || []).find((a) => a.self);
  const organizer = e.organizer && !e.organizer.self ? e.organizer : (e.attendees || []).find((a) => a.organizer && !a.self);
  const guests = (e.attendees || []).filter((a) => !a.resource);
  const counts = guests.reduce((n, a) => { n[a.status] = (n[a.status] || 0) + 1; return n; }, {});
  const rec = e.recurrence && e.recurrence.recurring;
  const rules = rec ? (e.recurrence.rules && e.recurrence.rules.length ? e.recurrence.rules : S.seriesRules.get(`${e.calendarId}|${e.recurrence.seriesId}`)) : null;
  const spec = rules ? RR.parseRRule(RR.splitRecurrence(rules).rrule) : null;
  const rows = [
    el('div', 'cev-row', ico('clock', 14), el('span', '', M.timeText(e, LOCALE), e.timeZone && zone && e.timeZone !== zone && !e.allDay ? el('small', '', ` · ${e.timeZone}`) : null)),
    rec ? el('div', 'cev-row', ico('retry', 14), el('span', '', spec ? RR.repeatText(spec, M.bounds(e).s, LOCALE) : e.recurrence.seriesId || e.source === 'mac' ? 'Repeats (this is one occurrence)' : 'Repeats')) : null,
    e.location ? el('div', 'cev-row', ico('globe', 14), el('span', 'wrap', e.location)) : null,
    el('div', 'cev-row', el('i', { class: 'cev-dot', style: { background: color } }), el('span', '', c ? c.title : 'Calendar', el('small', '', ` · ${sourceLabel(e, c)}`)), e.visibility === 'private' ? ico('lock', 12, 'ro') : null),
    organizer ? el('div', 'cev-row', ico('user', 14), el('span', '', `Organized by ${organizer.name || organizer.email}`)) : null,
    guests.length ? el('div', 'cev-row people', ico('user', 14), el('div', 'cev-people',
      el('span', 'cev-gsum', `${guests.length} guest${guests.length === 1 ? '' : 's'}${['accepted', 'declined', 'tentative', 'needsAction'].filter((k) => counts[k]).map((k) => ` · ${counts[k]} ${statusWord(k) === 'going' ? 'yes' : statusWord(k) === 'maybe' ? 'maybe' : statusWord(k) === 'declined' ? 'no' : 'awaiting'}`).join('')}`),
      ...guests.slice(0, 8).map((a) => el('span', `cev-person st-${a.status || 'none'}`, el('i', { class: 'cev-st', 'aria-hidden': 'true' }), a.self ? 'You' : a.name || a.email, a.organizer ? el('small', '', ' · organizer') : a.optional ? el('small', '', ' · optional') : statusWord(a.status) ? el('small', '', ` · ${statusWord(a.status)}`) : null)),
      guests.length > 8 ? el('span', 'cev-person', `+${guests.length - 8} more`) : null)) : null,
    e.alerts && e.alerts.length ? el('div', 'cev-row', ico('bell', 14), el('span', '', `Alerts: ${alertWords(e.alerts)}`)) : null,
    e.source === 'google' && e.reminders && !e.reminders.useDefault && e.reminders.overrides.length ? el('div', 'cev-row', ico('bell', 14), el('span', '', e.reminders.overrides.map((o) => `${M.alertText(o.minutes).replace(/ before$/, '')}${o.method === 'email' ? ' (email)' : ''}`).join(', ') + ' before')) : null,
    e.transparency === 'transparent' ? el('div', 'cev-row', ico('info', 14), el('span', '', 'Shown as free')) : null,
    e.notesHtml ? el('div', { class: 'cev-notes rich', tabindex: '0', 'aria-label': 'Description' }, sanitizeHtml(e.notesHtml, { editor: false }))
      : e.notes ? el('div', { class: 'cev-notes', tabindex: '0', 'aria-label': 'Notes' }, e.notes) : null,
    (e.attachments || []).length ? el('div', 'cev-row', ico('clip', 14), el('div', 'cev-files', ...e.attachments.map((f) => safeHref(f.fileUrl) ? el('a', { href: safeHref(f.fileUrl), target: '_blank', rel: 'noopener noreferrer' }, f.title || 'Attachment') : null))) : null,
  ];
  const links = [];
  // Jarvis's url is the event's own link field when it has one (eventUrl), else a call link from its notes or place
  if (e.url && safeHref(e.url)) links.push(el('a', { class: `cap${/meet\.google\.com/.test(e.url) ? ' meet' : ''}`, href: safeHref(e.url), target: '_blank', rel: 'noopener noreferrer' }, ico('ext', 11), e.eventUrl && e.url === e.eventUrl ? 'Open link' : /meet\.google\.com/.test(e.url) ? 'Join with Google Meet' : 'Join call'));
  if (e.link && safeHref(e.link)) links.push(el('a', { class: 'cap', href: safeHref(e.link), target: '_blank', rel: 'noopener noreferrer' }, ico('ext', 11), 'Open in Google'));
  // Going? Yes / No / Maybe — an invitation in Google Calendar (not the organizer's own event)
  const canRsvp = e.source === 'google' && me && !me.organizer && !(e.organizer && e.organizer.self) && !(c && c.readOnly);
  const rsvp = canRsvp ? el('div', 'cev-rsvp', el('span', 'k', 'Going?'),
    el('div', { class: 'cev-rsvp-btns', role: 'group', 'aria-label': 'Your answer' },
      ...[['accepted', 'Yes'], ['declined', 'No'], ['tentative', 'Maybe']].map(([v, t]) => el('button', { type: 'button', class: `cev-rs${(e.selfStatus || me.status) === v ? ' on' : ''}`, 'aria-pressed': String((e.selfStatus || me.status) === v), 'data-rsvp': v, onclick: (ev) => respondTo(e, v, ev.currentTarget) }, t)))) : null;
  const mailable = guests.filter((a) => !a.self && a.email && EMAIL.test(a.email));
  R.pop.replaceChildren(...[
    el('div', 'cev-head', el('span', { class: 'cev-bar', style: { background: color } }), el('h3', '', e.title),
      el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Close', onclick: closePop }, ico('x', 14))),
    ...rows.filter(Boolean),
    rsvp,
    links.length ? el('div', 'cev-links', ...links) : null,
    w.why && (!w.edit || !w.del) ? el('div', 'cev-why', w.why) : null,
    el('div', 'cev-acts',
      el('button', { type: 'button', class: 'cap', onclick: () => useEvent(e) }, ico('chat', 11), 'Use in chat'),
      mailable.length ? el('button', { type: 'button', class: 'cap', onclick: () => emailGuests(e, mailable) }, ico('mail', 11), 'Email guests') : null,
      el('span', 'grow'),
      w.del ? el('button', { type: 'button', class: 'cap rev', onclick: () => reviewDelete(e) }, ico('trash', 11), 'Delete…') : null,
      w.edit ? el('button', { type: 'button', class: 'cap primary', onclick: () => editEvent(e) }, ico('edit', 11), 'Edit…') : null)].filter(Boolean));
  R.pop.hidden = false;
  if (isMobile()) { R.pop.classList.add('as-sheet'); R.pop.style.left = ''; R.pop.style.top = ''; }
  else {
    R.pop.classList.remove('as-sheet');
    const a = S.pop.anchor && document.contains(S.pop.anchor) ? S.pop.anchor : R.view;
    placeInCard(R.pop, a, a.classList.contains('cal-tev') ? 'right' : 'below');
  }
  requestAnimationFrame(() => { const f = R.pop.querySelector('.cev-acts button'); if (f && S.pop) f.focus({ preventScroll: true }); });
  if (rec && !spec && e.source === 'google' && e.recurrence.seriesId && !S.seriesRules.has(`${e.calendarId}|${e.recurrence.seriesId}`)) seriesRules(e).then(() => { if (S.pop && S.pop.key === M.eventKey(e)) drawPop(e); }, () => {});
}
const safeHref = (u) => { try { const x = new URL(u); return x.protocol === 'https:' ? x.href : null; } catch { return null; } };

/** A repeating Google event's series lines (RRULE…), read once from its first event (an occurrence carries none). */
async function seriesRules(e) {
  if (!e.recurrence) return [];
  if (e.recurrence.rules && e.recurrence.rules.length) return e.recurrence.rules;
  if (e.source !== 'google' || !e.recurrence.seriesId) return [];
  const k = `${e.calendarId}|${e.recurrence.seriesId}`;
  if (S.seriesRules.has(k)) return S.seriesRules.get(k);
  const j = await postJSON('/api/chat/gcal', { action: 'get', args: { calendarId: e.calendarId, id: e.recurrence.seriesId } });
  const rules = (j && j.event && j.event.recurrence && j.event.recurrence.rules) || [];
  S.seriesRules.set(k, rules);
  return rules;
}

/** Yes / No / Maybe on an invitation: Google records it on the event and tells the organizer (a repeating one asks which). */
async function respondTo(e, status, btn) {
  const go = async (scope) => {
    const btns = R.pop.querySelectorAll('.cev-rs');
    btns.forEach((b) => { b.disabled = true; });
    try {
      await postJSON('/api/chat/gcal', { action: 'respond', args: { calendarId: e.calendarId, id: scope === 'all' ? e.recurrence.seriesId : e.id, status, scope, sendUpdates: 'all', confirm: true } });
      toast(`${status === 'accepted' ? 'Going' : status === 'declined' ? 'Declined' : 'Maybe'}: the organizer is told`);
      load(true);
    } catch (err) { toast(`Couldn’t answer: ${err.message}`); btns.forEach((b) => { b.disabled = false; }); }
  };
  const choices = RR.scopeChoices(e, 'rsvp');
  if (choices.length < 2) { go('this'); return; }
  scopeMenu(btn, choices, go);
}

/** A small menu of scopes under a button (RSVP on a repeating event). */
function scopeMenu(anchor, choices, pick) {
  const old = R.pop.querySelector('.cev-scope');
  if (old) old.remove();
  const menu = el('div', { class: 'cev-scope', role: 'menu' }, ...choices.map((c) => el('button', { type: 'button', role: 'menuitem', onclick: () => { menu.remove(); pick(c); } }, RR.SCOPE_LABEL[c])));
  anchor.closest('.cev-rsvp').after(menu);
  menu.querySelector('button').focus();
}

function emailGuests(e, guests) {
  closeCalendar();
  openCompose({ source: 'gmail', to: guests.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)), subject: e.title, body: `\n\n— ${e.title}, ${M.timeText(e, LOCALE)}${e.location ? `, ${e.location}` : ''}` });
}
function statusWord(s) { const w = { accepted: 'going', declined: 'declined', tentative: 'maybe', needsAction: 'invited', pending: 'invited', delegated: 'delegated' }; return w[s] || ''; }

/** placePopup, inside the card: the glass (backdrop-filter) makes the card the popover's containing block. */
function placeInCard(pop, anchor, side) {
  pop.style.left = '0px'; pop.style.top = '0px';
  placePopup(pop, anchor, side);
  const c = R.card.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  const left = Math.min(c.width - w - 8, Math.max(8, parseFloat(pop.style.left) - c.left));
  const top = Math.min(c.height - h - 8, Math.max(8, parseFloat(pop.style.top) - c.top));
  pop.style.left = `${left}px`; pop.style.top = `${top}px`;
}

/* ---------------- Use in chat ---------------- */

function useRange() {
  const r = range();
  const events = visibleEvents().filter((e) => M.overlaps(e, r.start, r.end));
  const text = M.rangeText(events, r, calendarsById(), LOCALE);
  const title = `Calendar: ${S.view === 'day' ? S.anchor.toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' }) : M.formatRange(r.start, M.addDays(r.end, -1), LOCALE, { day: 'numeric', month: 'short' })}`;
  closeCalendar();
  H.addContext({ title: title.slice(0, 80), text });
}
function useEvent(e) {
  const c = calendarsById().get(evCalKey(e));
  closeCalendar();
  H.addContext({ title: `Event: ${e.title}`.slice(0, 80), text: M.eventText(e, c, LOCALE) });
}

/* ---------------- writes: editor → review → commit ---------------- */

function writableCalendars() {
  const out = [];
  if (S.mac.state === 'ready' && !S.mac.legacy) for (const c of S.mac.calendars.values()) if (!c.readOnly) out.push(c);
  if (S.google.state === 'ready') for (const c of S.google.calendars) if (!c.readOnly) out.push(c);
  return out;
}

function openSheet(title, ...kids) {
  S.sheet = true;
  closePopOnly();
  R.sheet.replaceChildren(el('div', { class: 'cal-sheet-card glass', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    el('div', 'cal-sheet-head', el('h3', '', title), el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Close', onclick: closeSheet }, ico('x', 14))),
    el('div', 'cal-sheet-body', ...kids)));
  R.sheet.hidden = false;
  // a review sheet starts on its Back/Cancel button: Return mustn't commit by accident
  requestAnimationFrame(() => { const f = R.sheet.querySelector('[data-autofocus], input:not([disabled]), select:not([disabled]), textarea:not([disabled])'); if (f) f.focus(); });
}
function closePopOnly() { if (S.pop) { S.pop = null; R.pop.hidden = true; } }
function closeSheet(opts = {}) {
  if (!S.sheet) return false;
  S.sheet = null;
  R.sheet.hidden = true;
  R.sheet.replaceChildren();
  if (!opts.keepPreview) clearPreview(); // a move not saved goes back
  return true;
}

function newEvent(at = {}) {
  const cals = writableCalendars();
  if (!cals.length) {
    toast(S.mac.state === 'ready' && S.mac.legacy ? 'Restart Jarvis to add Mac events from Eden, or connect Google.' : 'Connect a calendar you can write to first (your Mac through Jarvis, or Google).');
    return;
  }
  let s = at.start, e = at.end;
  if (!s) {
    const base = at.day || (S.view === 'day' ? S.anchor : new Date());
    const now = new Date();
    const hour = M.sameDay(base, now) ? Math.min(22, now.getHours() + 1) : 9;
    s = new Date(base.getFullYear(), base.getMonth(), base.getDate(), hour, 0);
    e = new Date(s.getTime() + 3600e3);
  }
  const last = store.get('eden:cal:lastcal', null);
  // something with guests, a repeat or a zone (an invitation from Mail) goes to Google when it can
  const wantsGoogle = (at.recurrence && at.recurrence.length) || (at.attendees && at.attendees.length);
  const cal = (wantsGoogle && (cals.find((c) => c.source === 'google' && c.primary) || cals.find((c) => c.source === 'google')))
    || cals.find((c) => calKey(c.source, c.id) === last) || cals.find((c) => c.primary) || cals[0];
  editor({ mode: 'create', draft: { title: at.title || '', allDay: !!at.allDay, start: s, end: e, location: at.location || '', notes: at.notes || '', recurrence: at.recurrence || [], timeZone: at.timeZone || null, attendees: at.attendees || [] }, cal, from: at.from || '' });
}

async function editEvent(e) {
  const c = calendarsById().get(evCalKey(e));
  const b = M.bounds(e);
  let rules = [];
  if (e.source === 'google' && e.recurrence && e.recurrence.recurring) {
    try { rules = await seriesRules(e); } catch (err) { toast(`Couldn’t read how it repeats: ${err.message}`); }
  }
  editor({ mode: 'update', original: e, cal: c, baseRules: rules, draft: { title: e.title, allDay: e.allDay, start: b.s, end: b.e, location: e.location, notes: e.notes, recurrence: rules, timeZone: e.timeZone } });
}

/** Every IANA zone the browser knows (the editor's zone menu), the common ones first. */
function zoneList(cur) {
  let all = [];
  try { all = Intl.supportedValuesOf('timeZone'); } catch { all = ['UTC', 'Europe/London', 'Europe/Paris', 'America/New_York', 'America/Los_Angeles', 'Asia/Tokyo']; }
  const local = M.localZone();
  return [...new Set([cur, local, 'UTC', ...all].filter(Boolean))];
}
const zoneLabel = (z) => { try { const p = new Intl.DateTimeFormat('en-US', { timeZone: z, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName'); return `(${p ? p.value : 'GMT'}) ${z.replace(/_/g, ' ')}`; } catch { return z; } };

const UNITS = [['minutes', 1], ['hours', 60], ['days', 1440], ['weeks', 10080]];
const unitOf = (m) => (m && m % 10080 === 0 ? 'weeks' : m && m % 1440 === 0 ? 'days' : m && m % 60 === 0 ? 'hours' : 'minutes');

/** The contacts Gmail suggests for guests (recent correspondents), read once. */
async function contacts() {
  if (S.contacts) return S.contacts;
  try { const j = await api.gmail('contacts', {}); S.contacts = Array.isArray(j && j.contacts) ? j.contacts.filter((c) => c && EMAIL.test(c.email || '')) : []; } catch { S.contacts = []; }
  return S.contacts;
}

/** Plain text as the description editor's HTML. */
const textHtml = (t) => String(t || '').split('\n').map((l) => l.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])).join('<br>');

function editor(ctx) {
  const { mode, original } = ctx;
  const d = ctx.draft;
  const cals = writableCalendars();
  const calOf = () => cals.find((c) => calKey(c.source, c.id) === fCal.value) || ctx.cal;
  const isGoogle = () => { const c = calOf(); return !!c && c.source === 'google'; };
  const local = M.localZone();

  /* title, calendar */
  const fTitle = el('input', { type: 'text', class: 'cal-ftitle', maxlength: 200, placeholder: 'Add title', 'aria-label': 'Title' });
  fTitle.value = d.title;
  const fCal = el('select', { 'aria-label': 'Calendar' }, ...cals.map((c) => el('option', { value: calKey(c.source, c.id) }, `${c.title} — ${c.source === 'google' ? 'Google' : 'Mac'}`)));
  if (ctx.cal && !cals.includes(ctx.cal)) fCal.append(el('option', { value: calKey(ctx.cal.source, ctx.cal.id) }, `${ctx.cal.title} — ${ctx.cal.source === 'google' ? 'Google' : 'Mac'}`));
  fCal.value = ctx.cal ? calKey(ctx.cal.source, ctx.cal.id) : '';
  fCal.disabled = mode === 'update';
  const calDot = el('i', { class: 'cev-dot cal-fdot' });

  /* when, and the zone it's written in */
  let zone = (d.timeZone && !d.allDay ? d.timeZone : null) || local;
  const fZone = el('select', { 'aria-label': 'Time zone', class: 'cal-fzone' }, ...zoneList(zone).map((z) => el('option', { value: z }, zoneLabel(z))));
  fZone.value = zone;
  const fAll = el('input', { type: 'checkbox', 'aria-label': 'All-day' });
  fAll.checked = d.allDay;
  const fSd = el('input', { type: 'date', 'aria-label': 'Start date' });
  const fSt = el('input', { type: 'time', step: 300, 'aria-label': 'Start time' });
  const fEd = el('input', { type: 'date', 'aria-label': 'End date' });
  const fEt = el('input', { type: 'time', step: 300, 'aria-label': 'End time' });
  const showTimes = () => {
    const ws = RR.instantToWall(d.start, zone), we = RR.instantToWall(d.end, zone);
    const lastDay = d.allDay ? M.addDays(d.end, -1) : null;
    fSd.value = d.allDay ? M.ymd(d.start) : `${ws.y}-${M.pad(ws.m)}-${M.pad(ws.d)}`;
    fSt.value = `${M.pad(ws.h)}:${M.pad(ws.mi)}`;
    fEd.value = d.allDay ? M.ymd(lastDay) : `${we.y}-${M.pad(we.m)}-${M.pad(we.d)}`;
    fEt.value = `${M.pad(we.h)}:${M.pad(we.mi)}`;
  };
  showTimes();
  const wall = (dv, tv) => { const [y, m, dd] = dv.split('-').map(Number); const [h, mi] = (tv || '00:00').split(':').map(Number); return zone === local ? new Date(y, m - 1, dd, h, mi) : RR.wallToInstant(y, m, dd, h, mi, zone); };
  const readStart = () => wall(fSd.value, fSt.value);
  const readEnd = () => wall(fEd.value, fEt.value);
  fZone.addEventListener('change', () => { if (fSd.value && fEd.value) { d.start = readStart(); d.end = readEnd(); } zone = fZone.value; showTimes(); renderRepeat(); });

  /* place, description */
  const fLoc = el('input', { type: 'text', maxlength: 300, placeholder: 'Add location', 'aria-label': 'Location' }); fLoc.value = d.location || '';
  const fNotes = el('textarea', { rows: 3, maxlength: 2000, placeholder: 'Add description', 'aria-label': 'Description' }); fNotes.value = d.notes || '';
  const longNotes = (d.notes || '').length > 2000 && !(original && original.notesHtml);
  if (longNotes) fNotes.disabled = true;
  const fRich = el('div', { class: 'cal-rich', contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Description', 'data-placeholder': 'Add description' });
  fRich.append(sanitizeHtml(d.description !== undefined ? d.description : original && original.notesHtml ? original.notesHtml : textHtml(d.notes || '')));
  const richBtn = (cmd, label, icon, arg) => el('button', { type: 'button', class: 'cal-rb', title: label, 'aria-label': label, onmousedown: (ev) => ev.preventDefault(), onclick: () => {
    fRich.focus();
    if (cmd === 'createLink') { const u = prompt('Link (https://…)', 'https://'); if (!u || !/^https:\/\/\S+$/i.test(u)) return; document.execCommand(cmd, false, u); } else document.execCommand(cmd, false, arg);
  } }, icon);
  const richBar = el('div', { class: 'cal-richbar', role: 'toolbar', 'aria-label': 'Formatting' }, richBtn('bold', 'Bold', el('b', '', 'B')), richBtn('italic', 'Italic', el('i', '', 'I')), richBtn('underline', 'Underline', el('u', '', 'U')), richBtn('insertUnorderedList', 'Bulleted list', '•≡'), richBtn('insertOrderedList', 'Numbered list', '1≡'), richBtn('createLink', 'Link', ico('ext', 12)), richBtn('removeFormat', 'Clear formatting', '⌫'));
  const richHtml = () => { const box = el('div'); box.append(sanitizeHtml(fRich.innerHTML, { editor: false })); return box.innerHTML.trim(); };
  const richHasFormat = () => !!fRich.querySelector('b, strong, i, em, u, a, ul, ol, li, h1, h2, h3');

  /* Mac only: its link and alerts */
  const fUrl = el('input', { type: 'url', maxlength: 1000, placeholder: 'https://…', 'aria-label': 'Link', inputmode: 'url', autocomplete: 'off' }); fUrl.value = (original ? original.eventUrl : d.url) || '';
  const known = original ? (Array.isArray(original.alerts) ? original.alerts : null) : [];
  let alertsTouched = false;
  const alertSel = (label, v) => {
    const sel = el('select', { 'aria-label': label }, ...ALERTS.map(([m, t]) => el('option', { value: m === null ? '' : String(m) }, t)));
    if (v !== undefined && v !== null && !ALERTS.some(([m]) => m === v)) sel.append(el('option', { value: String(v) }, alertText(v)));
    sel.value = v === undefined || v === null ? '' : String(v);
    sel.addEventListener('change', () => { alertsTouched = true; });
    return sel;
  };
  const fAlerts = [alertSel('Alert', known ? known[0] : null), alertSel('Second alert', known ? known[1] : null)];
  const extraAlerts = known ? known.slice(2) : [];

  /* repeat */
  const rr = RR.splitRecurrence(d.recurrence);
  let spec = rr.rrule ? RR.parseRRule(rr.rrule) || RR.noRepeat() : RR.noRepeat();
  const keepRaw = spec.unsupported ? spec : null;
  let forceCustom = false; // "Custom…" stays open while its choices still match a preset
  const fRepeat = el('select', { 'aria-label': 'Repeat' });
  const fEvery = el('input', { type: 'number', min: 1, max: 99, 'aria-label': 'Repeat every', class: 'cal-fnum' });
  const fUnit = el('select', { 'aria-label': 'Unit' }, ...[['DAILY', 'day'], ['WEEKLY', 'week'], ['MONTHLY', 'month'], ['YEARLY', 'year']].map(([v, t]) => el('option', { value: v }, t)));
  const dayBtns = RR.WEEKDAYS.map((w, i) => el('button', { type: 'button', class: 'cal-wd', 'data-wd': w, 'aria-pressed': 'false', 'aria-label': new Date(2026, 0, 4 + i).toLocaleDateString(LOCALE, { weekday: 'long' }) }, new Date(2026, 0, 4 + i).toLocaleDateString(LOCALE, { weekday: 'narrow' })));
  const fMonthly = el('select', { 'aria-label': 'Monthly on' });
  const endName = `calend${Date.now()}`;
  const endRadio = (v) => { const r = el('input', { type: 'radio', name: endName, value: v }); r.addEventListener('change', () => { spec.end = v; syncCustom(); }); return r; };
  const fEndNever = endRadio('never'), fEndOn = endRadio('until'), fEndAfter = endRadio('count');
  const fUntil = el('input', { type: 'date', 'aria-label': 'Ends on' });
  const fCount = el('input', { type: 'number', min: 1, max: 730, 'aria-label': 'Occurrences', class: 'cal-fnum' });
  const custom = el('div', { class: 'cal-custom', hidden: true },
    el('div', 'cal-frow', el('span', 'k', 'Repeat every'), fEvery, fUnit),
    el('div', { class: 'cal-wds', role: 'group', 'aria-label': 'Repeat on' }, ...dayBtns),
    el('div', 'cal-frow cal-mon', fMonthly),
    el('div', 'cal-ends', el('span', 'k', 'Ends'),
      el('label', 'cal-fcheck', fEndNever, el('span', '', 'Never')),
      el('label', 'cal-fcheck', fEndOn, el('span', '', 'On'), fUntil),
      el('label', 'cal-fcheck', fEndAfter, el('span', '', 'After'), fCount, el('span', '', 'occurrences'))));
  const startDate = () => (fSd.value ? M.parseYmd(fSd.value) : d.start);
  function renderRepeat() {
    const st = startDate();
    const key = keepRaw && spec === keepRaw ? 'keep' : forceCustom ? 'custom' : RR.presetOf(spec, st);
    const opts = [['none', 'Does not repeat'], ['daily', 'Daily'], ['weekly', RR.repeatText(RR.presetSpec('weekly', st), st, LOCALE)], ['monthly-weekday', RR.repeatText(RR.presetSpec('monthly-weekday', st), st, LOCALE)],
      ['monthly-date', RR.repeatText(RR.presetSpec('monthly-date', st), st, LOCALE)], ['yearly', RR.repeatText(RR.presetSpec('yearly', st), st, LOCALE)], ['weekdays', 'Every weekday (Monday to Friday)']];
    if (keepRaw) opts.push(['keep', 'Custom repeat (kept as it is)']);
    opts.push(['custom', key === 'custom' ? RR.repeatText(spec, st, LOCALE) : 'Custom…']);
    fRepeat.replaceChildren(...opts.map(([v, t]) => el('option', { value: v }, t)));
    fRepeat.value = key;
    fMonthly.replaceChildren(el('option', { value: 'date' }, `Monthly on day ${st.getDate()}`), el('option', { value: 'weekday' }, RR.repeatText(RR.presetSpec('monthly-weekday', st), st, LOCALE)));
    syncCustom();
  }
  function syncCustom() {
    const on = fRepeat.value === 'custom';
    custom.hidden = !on;
    if (!on) return;
    fEvery.value = String(spec.interval || 1);
    fUnit.value = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(spec.freq) ? spec.freq : 'WEEKLY';
    dayBtns.forEach((b) => { const onDay = (spec.byDay || []).includes(b.dataset.wd); b.setAttribute('aria-pressed', String(onDay)); b.classList.toggle('on', onDay); });
    custom.querySelector('.cal-wds').hidden = fUnit.value !== 'WEEKLY';
    custom.querySelector('.cal-mon').hidden = fUnit.value !== 'MONTHLY';
    fMonthly.value = spec.monthMode || 'date';
    fEndNever.checked = spec.end === 'never'; fEndOn.checked = spec.end === 'until'; fEndAfter.checked = spec.end === 'count';
    fUntil.value = spec.until || M.ymd(M.addMonths(startDate(), 3)); fUntil.disabled = spec.end !== 'until';
    fCount.value = String(spec.count || 10); fCount.disabled = spec.end !== 'count';
    relabel();
  }
  function relabel() { const opt = fRepeat.querySelector('option[value="custom"]'); if (opt && fRepeat.value === 'custom') opt.textContent = RR.repeatText(spec, startDate(), LOCALE); }
  fRepeat.addEventListener('change', () => {
    const v = fRepeat.value, st = startDate();
    forceCustom = v === 'custom';
    if (v === 'keep') spec = keepRaw;
    else if (v === 'custom') { if (spec.freq === 'none' || spec === keepRaw) spec = { ...RR.presetSpec('weekly', st) }; spec = { ...spec, unsupported: false, raw: undefined }; }
    else spec = RR.presetSpec(v, st);
    renderRepeat();
    if (v === 'custom') fEvery.focus();
  });
  fEvery.addEventListener('input', () => { spec.interval = Math.max(1, Math.min(99, Number(fEvery.value) || 1)); relabel(); });
  fUnit.addEventListener('change', () => { spec.freq = fUnit.value; if (spec.freq === 'WEEKLY' && !(spec.byDay || []).length) spec.byDay = [RR.WEEKDAYS[startDate().getDay()]]; syncCustom(); });
  dayBtns.forEach((b) => b.addEventListener('click', () => { const set = new Set(spec.byDay || []); if (set.has(b.dataset.wd)) { if (set.size > 1) set.delete(b.dataset.wd); } else set.add(b.dataset.wd); spec.byDay = RR.WEEKDAYS.filter((x) => set.has(x)); syncCustom(); }));
  fMonthly.addEventListener('change', () => { spec.monthMode = fMonthly.value; spec.nth = undefined; spec.monthDay = undefined; relabel(); });
  fUntil.addEventListener('change', () => { spec.until = fUntil.value; relabel(); });
  fCount.addEventListener('input', () => { spec.count = Math.max(1, Math.min(730, Number(fCount.value) || 1)); relabel(); });
  let repeatTouched = false; // untouched, the series keeps its lines word for word
  custom.addEventListener('input', () => { repeatTouched = true; });
  custom.addEventListener('change', () => { repeatTouched = true; });
  custom.addEventListener('click', () => { repeatTouched = true; });
  fRepeat.addEventListener('change', () => { repeatTouched = true; });
  const repeatLines = () => {
    if (!repeatTouched) return Array.isArray(d.recurrence) ? d.recurrence : [];
    if (spec.end === 'until' && !spec.until) spec.until = fUntil.value;
    const line = RR.buildRRule(spec, startDate(), fAll.checked, fAll.checked ? null : zone);
    return line ? [line, ...rr.others] : [];
  };

  /* guests */
  const was = original ? (original.attendees || []).filter((a) => !a.resource) : [];
  const guests = (d.attendees !== undefined ? d.attendees : was.filter((a) => !(a.self && a.organizer)))
    .map((a) => { const o = was.find((x) => String(x.email).toLowerCase() === String(a.email).toLowerCase()) || a; return { email: String(a.email || '').toLowerCase(), name: o.name || a.name || '', optional: !!a.optional, status: o.status || 'needsAction', self: !!o.self, organizer: !!o.organizer }; });
  const fGuest = el('input', { type: 'email', placeholder: 'Add guests', 'aria-label': 'Add guests', autocomplete: 'off', list: 'calGuestList', multiple: true });
  const guestList = el('datalist', { id: 'calGuestList' });
  const chips = el('div', { class: 'cal-guests', 'aria-live': 'polite' });
  const perm = (label, key, def) => { const i = el('input', { type: 'checkbox' }); i.checked = d[key] !== undefined ? !!d[key] : original && original[key] !== undefined ? !!original[key] : def; return { i, row: el('label', 'cal-fcheck', i, el('span', '', label)), key }; };
  const pModify = perm('Modify event', 'guestsCanModify', false), pInvite = perm('Invite others', 'guestsCanInviteOthers', true), pSee = perm('See guest list', 'guestsCanSeeOtherGuests', true);
  const fbBox = el('div', { class: 'cal-fb', hidden: true, 'aria-live': 'polite' });
  const renderGuests = () => {
    chips.replaceChildren(...guests.map((g, i) => el('div', 'cal-guest',
      el('span', { class: 'cal-gav', style: { '--h': String(([...g.email].reduce((n, ch) => n + ch.charCodeAt(0), 0) * 37) % 360) } }, (g.name || g.email)[0].toUpperCase()),
      el('span', 'cal-gname', g.name ? el('b', '', g.name) : null, el('span', '', g.email), g.self ? el('small', '', ' · you') : g.organizer ? el('small', '', ' · organizer') : statusWord(g.status) && original ? el('small', '', ` · ${statusWord(g.status)}`) : null),
      g.organizer || g.self ? null : el('button', { type: 'button', class: `cal-gopt${g.optional ? ' on' : ''}`, 'aria-pressed': String(g.optional), title: 'Mark optional', onclick: () => { g.optional = !g.optional; renderGuests(); } }, g.optional ? 'Optional' : 'Required'),
      g.organizer || g.self ? null : el('button', { type: 'button', class: 'iconbtn', 'aria-label': `Remove ${g.email}`, onclick: () => { guests.splice(i, 1); renderGuests(); if (!fbBox.hidden) findTime(); } }, ico('x', 12)))));
    permsBox.hidden = !guests.some((g) => !g.self);
    fbBtn.hidden = !guests.some((g) => !g.self);
  };
  const addGuest = (raw) => {
    let added = 0;
    for (const part of String(raw).split(/[,;\s]+/)) {
      const m = /<([^>]+)>/.exec(part); const email = (m ? m[1] : part).trim().toLowerCase();
      if (!email) continue;
      if (!EMAIL.test(email)) { err.textContent = `“${email}” isn’t an email address.`; continue; }
      if (guests.some((g) => g.email === email)) continue;
      const known = (S.contacts || []).find((c) => c.email.toLowerCase() === email);
      guests.push({ email, name: known ? known.name || '' : '', optional: false, status: 'needsAction', self: false, organizer: false });
      added++;
    }
    if (added) { err.textContent = ''; renderGuests(); if (!fbBox.hidden) findTime(); }
  };
  fGuest.addEventListener('focus', async () => { const list = await contacts(); guestList.replaceChildren(...list.slice(0, 200).map((c) => el('option', { value: c.email }, c.name || c.email))); }, { once: true });
  fGuest.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ',' || ev.key === 'Tab' && fGuest.value.trim()) { if (fGuest.value.trim()) { ev.preventDefault(); addGuest(fGuest.value); fGuest.value = ''; } } });
  fGuest.addEventListener('change', () => { if (fGuest.value.trim() && EMAIL.test(fGuest.value.trim())) { addGuest(fGuest.value); fGuest.value = ''; } });
  const permsBox = el('div', 'cal-perms', el('span', 'k', 'Guests can'), pModify.row, pInvite.row, pSee.row);
  const fbBtn = el('button', { type: 'button', class: 'cap', onclick: () => { fbBox.hidden = !fbBox.hidden; if (!fbBox.hidden) findTime(); } }, ico('clock', 11), 'Find a time');

  /* Find a time: everyone's busy times on the start day (Google free/busy) */
  async function findTime() {
    const day = startDate();
    const people = [...new Set([S.google.email, ...guests.map((g) => g.email)].filter(Boolean))].slice(0, 20);
    fbBox.replaceChildren(el('div', 'cal-fb-h', el('b', '', `Find a time · ${day.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'short' })}`), el('span', 'cal-spin')));
    let j;
    try { j = await postJSON('/api/chat/gcal', { action: 'freebusy', args: { start: M.isoWithOffset(day), end: M.isoWithOffset(M.addDays(day, 1)), emails: people, timeZone: local } }); }
    catch (e) { fbBox.replaceChildren(el('div', 'cal-err', `Couldn’t read free/busy: ${e.message}`)); return; }
    if (fbBox.hidden) return;
    const H0 = 7, H1 = 21, span = (H1 - H0) * 60;
    const pct = (t) => `${Math.max(0, Math.min(100, ((M.minutesIntoDay(t) - H0 * 60 + (M.startOfDay(t) > day ? 1440 : 0)) / span) * 100))}%`;
    const s0 = fAll.checked ? null : readStart(), e0 = fAll.checked ? null : readEnd();
    const rowsEl = people.map((p) => {
      const bar = el('div', { class: 'cal-fb-bar', title: 'Click a free time to move the event there' });
      for (const b of (j.busy && j.busy[p]) || []) {
        const bs = new Date(b.start), be = new Date(b.end);
        bar.append(el('i', { class: 'busy', style: { left: pct(bs < day ? day : bs), right: `calc(100% - ${pct(be > M.addDays(day, 1) ? M.addDays(day, 1) : be)})` } }));
      }
      if (s0) bar.append(el('i', { class: 'slot', style: { left: pct(s0), right: `calc(100% - ${pct(e0)})` } }));
      bar.addEventListener('click', (ev) => {
        if (fAll.checked) return;
        const r = bar.getBoundingClientRect();
        const min = M.snap(H0 * 60 + ((ev.clientX - r.left) / r.width) * span, 15);
        const len = readEnd() - readStart();
        const ns = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, min);
        d.start = ns; d.end = new Date(+ns + len);
        showTimes(); findTime();
      });
      const why = j.errors && j.errors[p];
      return el('div', 'cal-fb-row', el('span', 'who', p === S.google.email ? 'You' : (guests.find((g) => g.email === p) || {}).name || p), why ? el('span', 'cal-fb-na', 'Calendar not shared') : bar);
    });
    const ticks = el('div', 'cal-fb-ticks', ...Array.from({ length: (H1 - H0) / 2 + 1 }, (_, i) => el('span', { style: { left: `${((i * 2) / (H1 - H0)) * 100}%` } }, hourLabel(H0 + i * 2))));
    fbBox.replaceChildren(el('div', 'cal-fb-h', el('b', '', `Find a time · ${day.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'short' })}`), el('small', '', 'Busy times; click a free spot to move the event')), ...rowsEl, el('div', 'cal-fb-row', el('span', 'who', ''), ticks));
  }

  /* Google Meet */
  const fMeet = el('input', { type: 'checkbox', 'aria-label': 'Google Meet video conferencing' });
  fMeet.checked = d.conference !== undefined ? !!d.conference : original ? !!(original.conference || /meet\.google\.com/.test(original.url || '')) : false;

  /* notifications (Google: several, popup or email) */
  const rem = d.reminders || (original && original.reminders) || { useDefault: true, overrides: [] };
  const fDefRem = el('input', { type: 'checkbox' });
  fDefRem.checked = !!rem.useDefault;
  const remList = el('div', 'cal-rems');
  const remRows = (rem.useDefault ? [] : rem.overrides || []).map((o) => ({ ...o }));
  const renderRems = () => {
    remList.replaceChildren(...remRows.map((o, i) => {
      const unit = unitOf(o.minutes);
      const mult = UNITS.find((u) => u[0] === unit)[1];
      const fMethod = el('select', { 'aria-label': 'Notification type' }, el('option', { value: 'popup' }, 'Notification'), el('option', { value: 'email' }, 'Email'));
      fMethod.value = o.method;
      const fN = el('input', { type: 'number', min: 0, max: 4 * 7 * 24 * 60, class: 'cal-fnum', 'aria-label': 'How long before' }); fN.value = String(o.minutes / mult);
      const fU = el('select', { 'aria-label': 'Unit' }, ...UNITS.map(([u]) => el('option', { value: u }, u)));
      fU.value = unit;
      const upd = () => { const m = (UNITS.find((u) => u[0] === fU.value) || UNITS[0])[1]; o.method = fMethod.value; o.minutes = Math.max(0, Math.min(40320, Math.round((Number(fN.value) || 0) * m))); };
      [fMethod, fN, fU].forEach((f) => f.addEventListener('change', upd));
      return el('div', 'cal-frow cal-rem', fMethod, fN, fU, el('span', 'k', 'before'), el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Remove notification', onclick: () => { remRows.splice(i, 1); renderRems(); } }, ico('x', 12)));
    }), remRows.length < 5 ? el('button', { type: 'button', class: 'cap', onclick: () => { fDefRem.checked = false; remRows.push({ method: 'popup', minutes: 10 }); renderRems(); } }, ico('plus', 11), 'Add notification') : null);
    remList.classList.toggle('dim', fDefRem.checked);
  };
  fDefRem.addEventListener('change', () => { if (fDefRem.checked) remRows.length = 0; renderRems(); });

  /* colour, visibility, busy/free */
  let colorId = d.colorId !== undefined ? d.colorId || '' : original ? original.colorId || '' : '';
  const colorBox = el('div', { class: 'cal-ecolors', role: 'radiogroup', 'aria-label': 'Event colour' });
  const renderColors = () => {
    const c = calOf();
    colorBox.replaceChildren(...[['', 'Calendar colour', c ? calColor(c) : '#8e8e93'], ...G_COLORS].map(([id, name, hexv]) => el('button', { type: 'button', class: `cal-sw${id === '' ? ' own' : ''}`, role: 'radio', 'aria-checked': String(colorId === id), 'aria-label': name, title: name, style: { '--c': hexv }, onclick: () => { colorId = id; renderColors(); } }, colorId === id ? ico('check', 11) : null)));
  };
  const fVis = el('select', { 'aria-label': 'Visibility' }, el('option', { value: 'default' }, 'Default visibility'), el('option', { value: 'public' }, 'Public'), el('option', { value: 'private' }, 'Private'));
  const vis = d.visibility || (original && original.visibility);
  fVis.value = vis && vis !== 'confidential' ? vis : 'default';
  const fBusy = el('select', { 'aria-label': 'Show as' }, el('option', { value: 'opaque' }, 'Busy'), el('option', { value: 'transparent' }, 'Free'));
  fBusy.value = (d.transparency || (original && original.transparency)) === 'transparent' ? 'transparent' : 'opaque';

  const err = el('div', { class: 'cal-err', role: 'alert' });
  const macEdit = mode === 'update' && original && original.source === 'mac';
  if (macEdit) { fAll.disabled = true; fEd.disabled = true; }
  const syncAll = () => { fSt.hidden = fAll.checked; fEt.hidden = fAll.checked; fZone.hidden = fAll.checked || !isGoogle(); };
  fAll.addEventListener('change', syncAll);
  // moving the start keeps the length, as calendars do
  let len = d.end - d.start;
  const onStart = () => {
    if (!fSd.value) return;
    const s = readStart();
    if (fAll.checked) { const days = Math.max(0, M.daysBetween(M.parseYmd(M.ymd(d.start)), M.parseYmd(fEd.value || fSd.value))); fEd.value = M.ymd(M.addDays(M.parseYmd(fSd.value), days)); d.start = M.parseYmd(fSd.value); renderRepeat(); return; }
    const en = new Date(s.getTime() + len);
    d.start = s; d.end = en;
    showTimes();
    renderRepeat();
  };
  fSd.addEventListener('change', onStart); fSt.addEventListener('change', onStart);
  const onEnd = () => { if (fSd.value && fEd.value && !fAll.checked) { const l = readEnd() - readStart(); if (l > 0) len = l; } };
  fEd.addEventListener('change', onEnd); fEt.addEventListener('change', onEnd);

  const review = () => {
    err.textContent = '';
    if (fGuest.value.trim()) { addGuest(fGuest.value); fGuest.value = ''; if (err.textContent) return; }
    const google = isGoogle();
    const out = M.draftFromForm({ title: fTitle.value, allDay: fAll.checked, startDate: fSd.value, startTime: fSt.value, endDate: fEd.value, endTime: fEt.value, location: fLoc.value, notes: google ? fRich.innerText.replace(/\n{3,}/g, '\n\n').trim() : fNotes.value });
    if (out.error) { err.textContent = out.error; return; }
    if (!out.draft.allDay && zone !== local) { out.draft.start = readStart(); out.draft.end = readEnd(); if (out.draft.end <= out.draft.start) { err.textContent = 'The end must be after the start.'; return; } }
    if (longNotes) out.draft.notes = d.notes;
    const cal = calOf();
    if (!cal) { err.textContent = 'Pick a calendar.'; return; }
    if (cal.source === 'mac') {
      const url = fUrl.value.trim();
      if (url && !/^https:\/\/[^\s/]+/i.test(url)) { err.textContent = 'The link must start with https://.'; fUrl.focus(); return; }
      out.draft.url = url;
      // alerts go only when known or set here (an older Jarvis doesn't say what they are)
      if (known || alertsTouched) out.draft.alerts = [...new Set([...fAlerts.map((f) => f.value).filter((v) => v !== '').map(Number), ...extraAlerts])].sort((a, b) => a - b).slice(0, 3);
    } else {
      const g = out.draft;
      g.timeZone = g.allDay ? null : zone;
      if (spec.end === 'until' && spec.until && spec.until < fSd.value) { err.textContent = 'The repeat can’t end before the event starts.'; return; }
      g.recurrence = repeatLines();
      g.attendees = guests.filter((x) => !x.organizer || !x.self).map((x) => ({ email: x.email, ...(x.optional ? { optional: true } : {}) }));
      if (!guests.some((x) => !x.self) && !(original && (original.attendees || []).length)) delete g.attendees;
      g.guestsCanModify = pModify.i.checked; g.guestsCanInviteOthers = pInvite.i.checked; g.guestsCanSeeOtherGuests = pSee.i.checked;
      g.conference = fMeet.checked;
      g.reminders = fDefRem.checked ? { useDefault: true } : { useDefault: false, overrides: remRows.map((o) => ({ method: o.method, minutes: o.minutes })) };
      g.colorId = colorId;
      g.visibility = fVis.value;
      g.transparency = fBusy.value;
      if (richHasFormat() || (original && original.notesHtml)) g.description = richHtml();
    }
    const next = { ...ctx, cal, draft: out.draft };
    if (mode === 'update') {
      const changed = cal.source === 'google' ? Object.keys(M.googleChanges(original, out.draft, local, ctx.baseRules)).length > 0 : !!M.macUpdateArgs(original, out.draft);
      if (!changed) { err.textContent = 'Nothing has changed.'; return; }
    }
    reviewWrite(next);
  };
  [fTitle, fLoc, fUrl].forEach((f) => f.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); review(); } }));

  // Google's parts, and the Mac's (Jarvis: a link and alerts; no repeats, guests or zones)
  const gOnly = el('div', 'cal-gonly',
    el('div', 'cal-fsec', el('span', 'k', ico('user', 13), 'Guests'), el('div', 'cal-fbody', el('div', 'cal-frow', fGuest, guestList, fbBtn), chips, fbBox, permsBox)),
    el('div', 'cal-fsec', el('span', 'k', ico('cal', 13), 'Meet'), el('label', 'cal-fcheck', fMeet, el('span', '', 'Add Google Meet video conferencing'))),
    el('div', 'cal-fsec', el('span', 'k', ico('bell', 13), 'Notifications'), el('div', 'cal-fbody', el('label', 'cal-fcheck', fDefRem, el('span', '', 'The calendar’s default notifications')), remList)),
    el('div', 'cal-fsec', el('span', 'k', ico('palette', 13), 'Colour'), colorBox),
    el('div', 'cal-fsec', el('span', 'k', ico('lock', 13), 'Visibility'), el('div', 'cal-frow', fVis, el('span', 'k', 'Show as'), fBusy)));
  const repeatRow = el('div', 'cal-fsec cal-repeat', el('span', 'k', ico('retry', 13), 'Repeat'), el('div', 'cal-fbody', fRepeat, custom));
  const macFields = el('div', 'cal-macf', el('label', 'field', 'Link', fUrl), el('div', 'field cal-alerts', el('span', '', 'Alerts'), el('div', 'cal-frow', ...fAlerts)));
  const notesMac = el('label', 'field cal-notes-mac', 'Notes', fNotes);
  const notesG = el('div', 'field cal-notes-g', el('span', '', 'Description'), richBar, fRich);
  const syncCal = () => {
    const c = calOf(), g = !!c && c.source === 'google';
    macFields.hidden = g; notesMac.hidden = g; gOnly.hidden = !g; repeatRow.hidden = !g; notesG.hidden = !g;
    calDot.style.background = c ? calColor(c) : '';
    syncAll(); renderColors();
  };
  fCal.addEventListener('change', syncCal);
  renderRepeat(); renderGuests(); renderRems(); syncCal();
  openSheet(mode === 'create' ? 'New event' : 'Edit event',
    fTitle,
    el('div', 'cal-fsec', el('span', 'k', calDot, 'Calendar'), fCal),
    el('div', 'cal-ftimes',
      el('span', 'k', 'Starts'), el('div', 'cal-frow', fSd, fSt),
      el('span', 'k', 'Ends'), el('div', 'cal-frow', fEd, fEt)),
    el('div', 'cal-fallday', el('label', 'switch', fAll, el('span', 'tr')), el('span', '', 'All-day'), el('span', 'grow'), fZone),
    repeatRow,
    ctx.from ? el('p', 'sp-note', ctx.from) : null,
    el('label', 'field', 'Location', fLoc),
    notesMac, notesG,
    longNotes ? el('p', 'sp-note', 'These notes are longer than Eden edits; they stay as they are.') : null,
    gOnly,
    macFields,
    macEdit ? el('p', 'sp-note', 'On your Mac, Jarvis does the change; an all-day event’s days and the calendar stay as they are.') : null,
    err,
    el('div', 'dlg-acts cal-sheet-acts',
      el('button', { type: 'button', class: 'btn', onclick: closeSheet }, 'Cancel'),
      el('button', { type: 'button', class: 'btn primary', onclick: review }, 'Review…')));
  R.sheet.firstChild.classList.add('cal-editor');
  if (ctx.focusTitle !== false) requestAnimationFrame(() => fTitle.focus());
}

function summaryRows(e, cal) {
  const color = e.colorId ? (G_COLORS.find((c) => c[0] === e.colorId) || [])[2] || calColor(cal) : calColor(cal);
  const rules = e.recurrence && Array.isArray(e.recurrence) ? e.recurrence : null;
  const spec = rules && rules.length ? RR.parseRRule(RR.splitRecurrence(rules).rrule) : null;
  const b = M.bounds(e);
  const guests = (Array.isArray(e.attendees) ? e.attendees : []).filter((a) => !a.self);
  return el('div', 'cal-review',
    el('div', 'rv-title', el('span', { class: 'cev-bar', style: { background: color } }), el('b', '', e.title)),
    el('div', 'rv-row', ico('clock', 13), M.timeText(e, LOCALE), e.timeZone && e.timeZone !== M.localZone() && !e.allDay ? ` (${e.timeZone})` : ''),
    spec ? el('div', 'rv-row', ico('retry', 13), RR.repeatText(spec, b.s, LOCALE)) : null,
    el('div', 'rv-row', el('i', { class: 'cev-dot', style: { background: calColor(cal) } }), `${cal ? cal.title : ''} · ${cal && cal.source === 'google' ? `Google${S.google.email ? ` (${S.google.email})` : ''}` : 'your Mac'}`),
    e.location ? el('div', 'rv-row', ico('globe', 13), e.location) : null,
    guests.length ? el('div', 'rv-row', ico('user', 13), guests.map((g) => `${g.email}${g.optional ? ' (optional)' : ''}`).join(', ')) : null,
    e.conference ? el('div', 'rv-row', ico('cal', 13), 'Google Meet') : null,
    e.eventUrl ? el('div', 'rv-row', ico('ext', 13), e.eventUrl) : null,
    e.alerts && e.alerts.length ? el('div', 'rv-row', ico('bell', 13), `Alerts: ${alertWords(e.alerts)}`) : null,
    e.reminders && !e.reminders.useDefault ? el('div', 'rv-row', ico('bell', 13), e.reminders.overrides.length ? e.reminders.overrides.map((o) => `${M.alertText(o.minutes)}${o.method === 'email' ? ' (email)' : ''}`).join(', ') : 'No notifications') : null,
    e.notes ? el('div', 'rv-notes', e.notes.length > 400 ? `${e.notes.slice(0, 400)}…` : e.notes) : null);
}
const alertWords = (list) => (list.length ? list.map((m) => alertText(m).replace(/ before$/, '')).join(', ') + (list.some((m) => m > 0) ? ' before' : '') : 'none');
const asEvent = (d, cal) => ({ title: d.title, allDay: d.allDay, start: d.allDay ? M.ymd(d.start) : d.start.toISOString(), end: d.allDay ? M.ymd(d.end) : d.end.toISOString(), location: d.location, notes: d.notes, eventUrl: d.url || '', alerts: d.alerts || [], source: cal.source, calendarId: cal.id,
  timeZone: d.timeZone || null, recurrence: d.recurrence || null, attendees: d.attendees || [], conference: !!d.conference, reminders: d.reminders || null, colorId: d.colorId || '' });

/** A radio group of scopes (which occurrences of a repeating event). */
function scopeRadios(choices, on, set) {
  const name = `calscope${Date.now()}`;
  return el('div', { class: 'cal-which', role: 'radiogroup', 'aria-label': 'Which events' }, ...choices.map((v) => {
    const r = el('input', { type: 'radio', name, value: v });
    r.checked = v === on;
    r.addEventListener('change', () => set(v));
    return el('label', 'cal-fcheck', r, el('span', '', RR.SCOPE_LABEL[v]));
  }));
}

function reviewWrite(ctx) {
  const { mode, cal, draft, original } = ctx;
  const after = asEvent(draft, cal);
  const parts = [];
  let changes = {};
  if (mode === 'create') parts.push(summaryRows(after, cal));
  else {
    const rows = [];
    if (cal.source === 'google') changes = M.googleChanges(original, draft, M.localZone(), ctx.baseRules);
    if (draft.title !== original.title) rows.push(['Title', original.title, draft.title]);
    if (M.timeText(after, LOCALE) !== M.timeText(original, LOCALE) || changes.timeZone && changes.start) rows.push(['When', M.timeText(original, LOCALE), `${M.timeText(after, LOCALE)}${draft.timeZone && draft.timeZone !== M.localZone() ? ` (${draft.timeZone})` : ''}`]);
    if ((draft.location || '') !== (original.location || '')) rows.push(['Place', original.location || '—', draft.location || '—']);
    if (changes.description !== undefined || (draft.description === undefined && (draft.notes || '') !== (original.notes || ''))) rows.push(['Description', original.notes ? 'old' : '—', draft.notes ? 'new' : '—']);
    if (changes.recurrence) { const s0 = M.bounds(original).s; const was = RR.parseRRule(RR.splitRecurrence(ctx.baseRules || []).rrule), now = RR.parseRRule(RR.splitRecurrence(changes.recurrence).rrule); rows.push(['Repeat', RR.repeatText(was, s0, LOCALE), RR.repeatText(now, draft.start, LOCALE)]); }
    if (changes.attendees) rows.push(['Guests', `${(original.attendees || []).length}`, changes.attendees.map((a) => a.email).join(', ') || 'none']);
    if (changes.conference !== undefined) rows.push(['Google Meet', changes.conference ? 'off' : 'on', changes.conference ? 'on' : 'off']);
    if (changes.reminders) rows.push(['Notifications', 'as they were', changes.reminders.useDefault ? 'default' : changes.reminders.overrides.map((o) => M.alertText(o.minutes)).join(', ') || 'none']);
    if (changes.colorId !== undefined) rows.push(['Colour', original.colorId ? (G_COLORS.find((c) => c[0] === original.colorId) || [])[1] : 'calendar', changes.colorId ? (G_COLORS.find((c) => c[0] === changes.colorId) || [])[1] : 'calendar']);
    if (changes.visibility) rows.push(['Visibility', original.visibility || 'default', changes.visibility]);
    if (changes.transparency) rows.push(['Show as', original.transparency === 'transparent' ? 'free' : 'busy', changes.transparency === 'transparent' ? 'free' : 'busy']);
    for (const k of ['guestsCanModify', 'guestsCanInviteOthers', 'guestsCanSeeOtherGuests']) if (changes[k] !== undefined) rows.push([{ guestsCanModify: 'Guests modify', guestsCanInviteOthers: 'Guests invite', guestsCanSeeOtherGuests: 'Guests see list' }[k], changes[k] ? 'no' : 'yes', changes[k] ? 'yes' : 'no']);
    if ('url' in draft && (draft.url || '') !== (original.eventUrl || '')) rows.push(['Link', original.eventUrl || '—', draft.url || '—']);
    if (Array.isArray(draft.alerts) && JSON.stringify(draft.alerts) !== JSON.stringify(original.alerts || [])) rows.push(['Alerts', Array.isArray(original.alerts) ? alertWords(original.alerts) : 'as they are', alertWords(draft.alerts)]);
    parts.push(summaryRows(original, cal), el('div', 'cal-changes', ...rows.map(([k, a, b]) => el('div', 'chg', el('span', 'k', k), el('span', 'a', a), el('span', 'arr', '→'), el('b', '', b)))));
  }
  // a repeating event: which occurrences (a new repeat can't go on one occurrence alone)
  const choices = mode === 'update' ? RR.scopeChoices(original, changes.recurrence ? 'repeat' : 'edit') : [];
  let scope = choices[0] || 'this';
  if (choices.length > 1) parts.push(el('div', 'cal-scope-h', 'This event repeats. Change:'), scopeRadios(choices, scope, (v) => { scope = v; }));
  else if (choices.length === 1 && mode === 'update' && original.recurrence) parts.push(el('p', 'sp-note', 'Every event in the series changes.'));
  const guestsNow = cal.source === 'google' && (mode === 'create' ? (draft.attendees || []).length > 0 : M.guestsAffected(original, changes));
  const verb = mode === 'create' ? 'Add event' : 'Save changes';
  commitSheet(mode === 'create' ? 'Add this event?' : 'Save these changes?', parts, cal, verb, (send) => (mode === 'create' ? doCreate(cal, draft, send) : doUpdate(original, cal, draft, scope, send, ctx.baseRules)), () => editor({ ...ctx, draft: { ...draft }, focusTitle: false }), guestsNow, false, mode === 'create' ? 'Send invitations to the guests' : 'Email the guests about the change');
}

function reviewDelete(e) {
  const cal = calendarsById().get(evCalKey(e));
  if (!cal) return;
  const choices = RR.scopeChoices(e, 'edit');
  let scope = choices.length ? choices[0] : 'this';
  const parts = [summaryRows(e, cal)];
  if (choices.length > 1) parts.push(el('div', 'cal-scope-h', 'This event repeats. Delete:'), scopeRadios(choices, scope, (v) => { scope = v; }));
  const guests = cal.source === 'google' && (e.attendees || []).some((a) => !a.self) && (!e.organizer || e.organizer.self);
  commitSheet('Delete this event?', parts, cal, 'Delete event', (send) => doDelete(e, cal, scope, send), null, guests, true, 'Tell the guests it’s cancelled');
}

function commitSheet(title, parts, cal, verb, run, back, hasGuests, danger, sendLabel = 'Email the guests') {
  const err = el('div', { class: 'cal-err', role: 'alert' });
  const fSend = el('input', { type: 'checkbox' });
  fSend.checked = true;
  const sendRow = cal.source === 'google' && hasGuests ? el('label', 'cal-fcheck cal-send', fSend, el('span', '', sendLabel)) : null;
  const note = cal.source === 'google'
    ? el('div', 'sp-warn', el('b', '', `Google Calendar changes when you press ${verb}`), hasGuests ? 'Google emails the guests only if “' + sendLabel + '” is ticked.' : 'No one is emailed.')
    : el('div', 'sp-warn', el('b', '', 'Jarvis will ask you on your Mac too'), 'After you press ' + verb + ', the Jarvis app shows its own card on your Mac; the calendar changes only when you approve it there.');
  const go = el('button', { type: 'button', class: `btn ${danger ? 'danger solid' : 'primary'} cal-commit` }, verb);
  go.addEventListener('click', async () => {
    go.disabled = true;
    go.textContent = cal.source === 'mac' ? macWaitText() : danger ? 'Deleting…' : 'Saving…';
    if (cal.source === 'mac') go.dataset.mac = '';
    err.textContent = '';
    try {
      const msg = await run(sendRow && fSend.checked ? 'all' : 'none');
      closeSheet({ keepPreview: true }); // the moved event stays put until the calendar reloads
      closePop();
      toast(msg);
      S.seriesRules.clear();
      load(true).finally(() => { if (S.preview) { S.preview = null; renderView(); } });
    } catch (e) {
      err.textContent = e.message;
      go.disabled = false;
      delete go.dataset.mac;
      go.textContent = verb;
    }
  });
  openSheet(title, ...parts, sendRow, note, err,
    el('div', 'dlg-acts cal-sheet-acts',
      el('button', { type: 'button', class: 'btn', 'data-autofocus': '', onclick: back || closeSheet }, back ? 'Back to edit' : 'Cancel'),
      el('span', 'grow'), go));
}

const macWaitText = () => (S.approval ? 'Approve Eden on your Mac…' : 'Waiting for your Mac…');

async function macWrite(tool, args, done) {
  const r = await api.jarvis(tool, args);
  const j = parseJSONText(r.text);
  const status = j && j.status;
  if (!r.is_error && (!j || j.done !== false)) return done;
  if (status === 'declined') throw new Error('You said no on your Mac, so nothing changed.');
  if (status === 'timed_out') throw new Error('Nobody answered the card on your Mac in time, so nothing changed.');
  throw new Error((j && j.text) || strip(r.text) || 'Jarvis couldn’t change the calendar.');
}

async function doCreate(cal, d, send = 'none') {
  store.set('eden:cal:lastcal', calKey(cal.source, cal.id));
  if (cal.source === 'google') {
    const event = M.googleInput(d);
    if (!event.recurrence || !event.recurrence.length) delete event.recurrence;
    await postJSON('/api/chat/gcal', { action: 'create', args: { calendarId: cal.id, event, sendUpdates: send, confirm: true } });
    return `Added “${d.title}” to ${cal.title}${send === 'all' ? ' and invited the guests' : ''}`;
  }
  return macWrite('calendar_create', M.macCreateArgs(d, cal.title), `Added “${d.title}” to ${cal.title} on your Mac`);
}
async function doUpdate(e, cal, d, scope = 'this', send = 'none', baseRules = null) {
  if (cal.source === 'google') {
    await postJSON('/api/chat/gcal', { action: 'update', args: { calendarId: cal.id, ...RR.scopeArgs(e, scope), event: M.googleChanges(e, d, M.localZone(), baseRules), sendUpdates: send, confirm: true } });
    return `Saved “${d.title}”${scope === 'following' ? ' (this and following)' : scope === 'all' && e.recurrence ? ' (all events)' : ''}`;
  }
  const args = M.macUpdateArgs(e, d, RR.scopeArgs(e, scope).future);
  if (!args) throw new Error('Nothing that Jarvis can change has changed.');
  return macWrite('calendar_update', args, `Saved “${d.title}” on your Mac`);
}
async function doDelete(e, cal, scope = 'this', send = 'none') {
  if (cal.source === 'google') {
    await postJSON('/api/chat/gcal', { action: 'delete', args: { calendarId: cal.id, ...RR.scopeArgs(e, scope), sendUpdates: send, confirm: true } });
    return `Deleted “${e.title}”${scope === 'following' ? ' and the events after it' : scope === 'all' && e.recurrence ? ' (all events)' : ''}`;
  }
  return macWrite('calendar_delete', M.macDeleteArgs(e, RR.scopeArgs(e, scope).future), `Deleted “${e.title}” on your Mac`);
}

/* ---------------- wiring ---------------- */

export function initCalendar(handlers) {
  H = { ...H, ...handlers };
  // a Google sign-in that didn't finish: don't reopen the calendar on the next one (from Mail)
  if (/#gmail=error/.test(location.hash)) { try { sessionStorage.removeItem(RETURN_KEY); } catch { /* private mode */ } }
  matchMedia('(max-width:640px)').addEventListener('change', () => { if (S.open) { closePop(); render(); } });
  // Jarvis waiting on the owner's "Let Eden use Jarvis?" card (api.js): say so instead of spinning.
  addEventListener('eden:jarvis-approval', (e) => {
    S.approval = !!(e.detail && e.detail.waiting);
    if (!S.open) return;
    R.sheet.querySelectorAll('.cal-commit[data-mac]').forEach((b) => { b.textContent = macWaitText(); });
    render();
  });
  matchMedia('(max-width:1100px)').addEventListener('change', () => { S.sideOpen = false; if (S.open) render(); });
}
