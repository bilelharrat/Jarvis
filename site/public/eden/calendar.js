// The calendar: one large glass surface over the chat with day, week, month and agenda
// views, a mini month, per-calendar colours and show/hide, event popovers, and two sources —
// the Mac's calendars through the Jarvis app (POST /api/chat/jarvis: calendar, and
// calendar_create/update/delete, each also confirmed on the Mac), and Google Calendar
// directly (/api/chat/gcal). Every change goes through a review step here first; nothing a
// model writes ever changes the calendar. Everything shown is data, set as text only.

import { el as baseEl, ico, toast, store, isMobile, placePopup, setSeg } from './util.js';
import { api, getJSON, postJSON, jarvisApprovalWaiting } from './api.js';
import * as M from './calendar-model.js';

const LOCALE = (navigator.languages && navigator.languages[0]) || navigator.language || 'en-US';
const FIRST_DAY = M.firstDayOfWeek(LOCALE);
const HOUR_PX = 48;
const LANE_PX = 21;
const ALLDAY_LANES = 3;
const DATA_NOTE = /^\(From the owner's Jarvis:[^)]*\)\s*/;
const VIEW_LABEL = { day: 'Day', week: 'Week', month: 'Month', agenda: 'Agenda' };
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

async function load(force = false) {
  const r = range();
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
  const seg = el('div', { class: 'seg cal-seg', style: { '--n': 4 }, role: 'tablist', 'aria-label': 'View' }, el('div', 'seg-thumb'),
    ...M.VIEWS.map((v) => el('button', { type: 'button', role: 'tab', 'data-view': v, title: `${VIEW_LABEL[v]} (${v[0].toUpperCase()})` }, VIEW_LABEL[v])));
  seg.addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) setView(b.dataset.view); });
  R.title = el('h2', { class: 'cal-title', id: 'calTitle' });
  R.busy = el('span', { class: 'cal-busy', 'aria-hidden': 'true' });
  R.seg = seg;
  R.prev = el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Previous', title: 'Previous (←)', onclick: () => step(-1) }, ico('chevl'));
  R.next = el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Next', title: 'Next (→)', onclick: () => step(1) }, ico('chevr'));
  R.today = el('button', { type: 'button', class: 'btn cal-today', title: 'Today (T)', onclick: goToday }, 'Today');
  R.sideBtn = el('button', { type: 'button', class: 'iconbtn cal-side-btn', 'aria-label': 'Calendars', title: 'Calendars', 'aria-expanded': 'false', onclick: () => { S.sideOpen = !S.sideOpen; renderSideState(); } }, ico('side'));
  const head = el('header', 'cal-head',
    R.sideBtn,
    el('div', 'cal-titlewrap', ico('cal', 18, 'cal-ico'), R.title, R.busy),
    el('span', 'cal-sp'),
    seg,
    el('div', 'cal-nav', R.prev, R.today, R.next),
    el('div', 'cal-acts',
      el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Refresh', title: 'Refresh', onclick: () => load(true) }, ico('retry', 15)),
      el('button', { type: 'button', class: 'cap cal-use', title: 'Add what this view shows to your next message', onclick: useRange }, ico('chat', 12), el('span', '', 'Use in chat')),
      el('button', { type: 'button', class: 'cap primary cal-newbtn', title: 'New event (N)', onclick: () => newEvent() }, ico('plus', 12), el('span', '', 'New event')),
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
  else if (k === 'a') setView('agenda');
  else if (k === 'n') newEvent();
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
    if (S.view !== 'month' && S.view !== 'agenda' && d >= r.start && d < r.end) cls.push('inrange');
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
  if (S.view === 'month') body = isMobile() ? monthMobile(r, events, cals) : monthView(r, events, cals);
  else if (S.view === 'agenda') body = agendaView(r, events, cals);
  else body = timeGrid(r.days, events, cals);
  R.view.className = `cal-view v-${S.view}`;
  R.view.replaceChildren(body);
  const anyHere = events.some((e) => M.overlaps(e, r.start, r.end));
  if (!busy() && !anyHere && (usable(S.mac) || usable(S.google)) && S.view !== 'agenda') {
    R.view.append(el('div', 'cal-empty', S.view === 'day' ? 'Nothing on your calendar this day.' : S.view === 'week' ? 'Nothing on your calendar this week.' : 'Nothing on your calendar this month.'));
  }
  // while Jarvis waits on its card the banner says "Approve Eden on your Mac" instead of a spinner
  if (busy() && !anyHere && !(S.approval && S.mac.state === 'loading')) R.view.append(el('div', 'cal-loading', el('span', 'cal-spin'), 'Loading your calendars…'));
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
    type: 'button', class: `cal-chip${e.allDay || M.isLong(e) ? ' bar' : ''}${extra.cls ? ` ${extra.cls}` : ''}${moved ? ' moved' : ''}${can ? ' can-drag' : ''}`,
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
  const grid = el('div', { class: 'cal-tg-grid', style: { gridTemplateColumns: cols, height: `${24 * HOUR_PX}px`, '--hour': `${HOUR_PX}px` } }, gutter);
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
        type: 'button', class: `cal-tev${h < 30 ? ' short' : ''}${s.before ? ' cont-t' : ''}${s.after ? ' cont-b' : ''}${new Date(v.end) < today ? ' past' : ''}${v !== e ? ' moved' : ''}${can ? ' can-drag' : ''}`,
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
    col.addEventListener('click', (ev) => {
      if (ev.target !== col) return;
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
  reviewWrite({ mode: 'update', original: e, cal, draft: M.dragDraft(e, p.start, p.end), future: false });
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
  const row = el('button', { type: 'button', class: 'cal-arow', style: { '--c': colorOf(e, cals) }, 'aria-label': evLabel(e, cals), 'data-key': M.eventKey(e) },
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
  const rows = [
    el('div', 'cev-row', ico('clock', 14), el('span', '', M.timeText(e, LOCALE), e.timeZone && zone && e.timeZone !== zone && !e.allDay ? el('small', '', ` · ${e.timeZone}`) : null)),
    e.recurrence && e.recurrence.recurring ? el('div', 'cev-row', ico('retry', 14), el('span', '', e.recurrence.seriesId || e.source === 'mac' ? 'Repeats (this is one occurrence)' : 'Repeats')) : null,
    e.location ? el('div', 'cev-row', ico('globe', 14), el('span', 'wrap', e.location)) : null,
    el('div', 'cev-row', el('i', { class: 'cev-dot', style: { background: color } }), el('span', '', c ? c.title : 'Calendar', el('small', '', ` · ${sourceLabel(e, c)}`))),
    e.attendees && e.attendees.length ? el('div', 'cev-row people', ico('chat', 14), el('div', 'cev-people',
      ...e.attendees.slice(0, 8).map((a) => el('span', 'cev-person', a.self ? 'You' : a.name || a.email, a.organizer ? el('small', '', ' · organizer') : statusWord(a.status) ? el('small', '', ` · ${statusWord(a.status)}`) : null)),
      e.attendees.length > 8 ? el('span', 'cev-person', `+${e.attendees.length - 8} more`) : null)) : null,
    e.alerts && e.alerts.length ? el('div', 'cev-row', ico('bell', 14), el('span', '', `Alerts: ${alertWords(e.alerts)}`)) : null,
    e.notes ? el('div', { class: 'cev-notes', tabindex: '0', 'aria-label': 'Notes' }, e.notes) : null,
  ];
  const links = [];
  const safe = (u) => { try { const x = new URL(u); return x.protocol === 'https:' ? x.href : null; } catch { return null; } };
  // Jarvis's url is the event's own link field when it has one (eventUrl), else a call link from its notes or place
  if (e.url && safe(e.url)) links.push(el('a', { class: 'cap', href: safe(e.url), target: '_blank', rel: 'noopener noreferrer' }, ico('ext', 11), e.eventUrl && e.url === e.eventUrl ? 'Open link' : 'Join call'));
  if (e.link && safe(e.link)) links.push(el('a', { class: 'cap', href: safe(e.link), target: '_blank', rel: 'noopener noreferrer' }, ico('ext', 11), 'Open in Google'));
  R.pop.replaceChildren(...[
    el('div', 'cev-head', el('span', { class: 'cev-bar', style: { background: color } }), el('h3', '', e.title),
      el('button', { type: 'button', class: 'iconbtn', 'aria-label': 'Close', onclick: closePop }, ico('x', 14))),
    ...rows.filter(Boolean),
    links.length ? el('div', 'cev-links', ...links) : null,
    w.why && (!w.edit || !w.del) ? el('div', 'cev-why', w.why) : null,
    el('div', 'cev-acts',
      el('button', { type: 'button', class: 'cap', onclick: () => useEvent(e) }, ico('chat', 11), 'Use in chat'),
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
  const cal = cals.find((c) => calKey(c.source, c.id) === last) || cals.find((c) => c.primary) || cals[0];
  editor({ mode: 'create', draft: { title: at.title || '', allDay: false, start: s, end: e, location: at.location || '', notes: at.notes || '' }, cal });
}

function editEvent(e) {
  const c = calendarsById().get(evCalKey(e));
  const b = M.bounds(e);
  editor({ mode: 'update', original: e, cal: c, draft: { title: e.title, allDay: e.allDay, start: b.s, end: b.e, location: e.location, notes: e.notes } });
}

function editor(ctx) {
  const { mode, original } = ctx;
  const d = ctx.draft;
  const mac = (ctx.cal && ctx.cal.source === 'mac');
  const fTitle = el('input', { type: 'text', maxlength: 200, placeholder: 'New event', 'aria-label': 'Title' });
  fTitle.value = d.title;
  const cals = writableCalendars();
  const fCal = el('select', { 'aria-label': 'Calendar' }, ...cals.map((c) => el('option', { value: calKey(c.source, c.id) }, `${c.title} — ${c.source === 'google' ? 'Google' : 'Mac'}`)));
  if (ctx.cal && !cals.includes(ctx.cal)) fCal.append(el('option', { value: calKey(ctx.cal.source, ctx.cal.id) }, `${ctx.cal.title} — ${ctx.cal.source === 'google' ? 'Google' : 'Mac'}`));
  fCal.value = ctx.cal ? calKey(ctx.cal.source, ctx.cal.id) : '';
  fCal.disabled = mode === 'update';
  const fAll = el('input', { type: 'checkbox', 'aria-label': 'All-day' });
  fAll.checked = d.allDay;
  const lastDay = d.allDay ? M.addDays(d.end, -1) : d.end;
  const fSd = el('input', { type: 'date', 'aria-label': 'Start date' }); fSd.value = M.ymd(d.start);
  const fSt = el('input', { type: 'time', step: 300, 'aria-label': 'Start time' }); fSt.value = `${M.pad(d.start.getHours())}:${M.pad(d.start.getMinutes())}`;
  const fEd = el('input', { type: 'date', 'aria-label': 'End date' }); fEd.value = M.ymd(lastDay);
  const fEt = el('input', { type: 'time', step: 300, 'aria-label': 'End time' }); fEt.value = `${M.pad(d.end.getHours())}:${M.pad(d.end.getMinutes())}`;
  const fLoc = el('input', { type: 'text', maxlength: 300, placeholder: 'Add a place', 'aria-label': 'Location' }); fLoc.value = d.location || '';
  const fNotes = el('textarea', { rows: 3, maxlength: 2000, placeholder: 'Notes', 'aria-label': 'Notes' }); fNotes.value = d.notes || '';
  // notes longer than the editor takes stay as they are (never cut to fit)
  const longNotes = (d.notes || '').length > 2000;
  if (longNotes) fNotes.disabled = true;
  // On your Mac (Jarvis): the event's link and its alerts too
  const fUrl = el('input', { type: 'url', maxlength: 1000, placeholder: 'https://…', 'aria-label': 'Link', inputmode: 'url', autocomplete: 'off' }); fUrl.value = (original ? original.eventUrl : d.url) || '';
  const known = original ? (Array.isArray(original.alerts) ? original.alerts : null) : [];
  const alertSel = (label, v) => {
    const sel = el('select', { 'aria-label': label }, ...ALERTS.map(([m, t]) => el('option', { value: m === null ? '' : String(m) }, t)));
    if (v !== undefined && v !== null && !ALERTS.some(([m]) => m === v)) sel.append(el('option', { value: String(v) }, alertText(v)));
    sel.value = v === undefined || v === null ? '' : String(v);
    sel.addEventListener('change', () => { alertsTouched = true; });
    return sel;
  };
  let alertsTouched = false;
  const fAlerts = [alertSel('Alert', known ? known[0] : null), alertSel('Second alert', known ? known[1] : null)];
  const extraAlerts = known ? known.slice(2) : []; // a third alert (set elsewhere) is kept
  const fFuture = el('input', { type: 'checkbox', 'aria-label': 'Also change later occurrences' });
  const err = el('div', { class: 'cal-err', role: 'alert' });
  const macEdit = mode === 'update' && mac;
  if (macEdit) { fAll.disabled = true; fEd.disabled = true; }
  const syncAll = () => { fSt.hidden = fAll.checked; fEt.hidden = fAll.checked; };
  syncAll();
  fAll.addEventListener('change', syncAll);
  // moving the start keeps the length, as calendars do
  let len = d.end - d.start;
  const readStart = () => { const [y, m, dd] = fSd.value.split('-').map(Number); const [h, mi] = (fSt.value || '00:00').split(':').map(Number); return new Date(y, m - 1, dd, h, mi); };
  const readEnd = () => { const [y, m, dd] = fEd.value.split('-').map(Number); const [h, mi] = (fEt.value || '00:00').split(':').map(Number); return new Date(y, m - 1, dd, h, mi); };
  const onStart = () => {
    if (!fSd.value) return;
    const s = readStart();
    if (fAll.checked) { const days = Math.max(0, M.daysBetween(M.parseYmd(M.ymd(d.start)), M.parseYmd(fEd.value || fSd.value))); fEd.value = M.ymd(M.addDays(s, days)); d.start = s; return; }
    const en = new Date(s.getTime() + len);
    fEd.value = M.ymd(en); fEt.value = `${M.pad(en.getHours())}:${M.pad(en.getMinutes())}`;
    d.start = s;
  };
  fSd.addEventListener('change', onStart); fSt.addEventListener('change', onStart);
  const onEnd = () => { if (fSd.value && fEd.value && !fAll.checked) { const l = readEnd() - readStart(); if (l > 0) len = l; } };
  fEd.addEventListener('change', onEnd); fEt.addEventListener('change', onEnd);
  const rec = original && original.recurrence && original.recurrence.recurring;
  const review = () => {
    const out = M.draftFromForm({ title: fTitle.value, allDay: fAll.checked, startDate: fSd.value, startTime: fSt.value, endDate: fEd.value, endTime: fEt.value, location: fLoc.value, notes: fNotes.value });
    if (out.error) { err.textContent = out.error; return; }
    if (longNotes) out.draft.notes = d.notes;
    const cal = cals.find((c) => calKey(c.source, c.id) === fCal.value) || ctx.cal;
    if (!cal) { err.textContent = 'Pick a calendar.'; return; }
    if (cal.source === 'mac') {
      const url = fUrl.value.trim();
      if (url && !/^https:\/\/[^\s/]+/i.test(url)) { err.textContent = 'The link must start with https://.'; fUrl.focus(); return; }
      out.draft.url = url;
      // alerts go only when known or set here (an older Jarvis doesn't say what they are)
      if (known || alertsTouched) out.draft.alerts = [...new Set([...fAlerts.map((f) => f.value).filter((v) => v !== '').map(Number), ...extraAlerts])].sort((a, b) => a - b).slice(0, 3);
    }
    const next = { ...ctx, cal, draft: out.draft, future: fFuture.checked };
    if (mode === 'update') {
      const changed = cal.source === 'google' ? Object.keys(M.googleChanges(original, out.draft)).length > 0 : !!M.macUpdateArgs(original, out.draft);
      if (!changed) { err.textContent = 'Nothing has changed.'; return; }
    }
    reviewWrite(next);
  };
  [fTitle, fLoc, fUrl].forEach((f) => f.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); review(); } }));
  // the link and alerts: Mac calendars only (Google's events here have neither)
  const macFields = el('div', 'cal-macf', el('label', 'field', 'Link', fUrl), el('div', 'field cal-alerts', el('span', '', 'Alerts'), el('div', 'cal-frow', ...fAlerts)));
  const syncCal = () => { const c = cals.find((x) => calKey(x.source, x.id) === fCal.value) || ctx.cal; macFields.hidden = !(c && c.source === 'mac'); };
  syncCal();
  fCal.addEventListener('change', syncCal);
  openSheet(mode === 'create' ? 'New event' : 'Edit event',
    el('label', 'field', 'Title', fTitle),
    el('label', 'field', 'Calendar', fCal),
    el('div', 'cal-fallday', el('label', 'switch', fAll, el('span', 'tr')), el('span', '', 'All-day')),
    el('div', 'cal-ftimes',
      el('span', 'k', 'Starts'), el('div', 'cal-frow', fSd, fSt),
      el('span', 'k', 'Ends'), el('div', 'cal-frow', fEd, fEt)),
    el('label', 'field', 'Location', fLoc),
    el('label', 'field', 'Notes', fNotes),
    longNotes ? el('p', 'sp-note', 'These notes are longer than Eden edits; they stay as they are.') : null,
    macFields,
    macEdit ? el('p', 'sp-note', 'On your Mac, Jarvis does the change; an all-day event’s days and the calendar stay as they are.') : null,
    rec && mac ? el('label', 'cal-fcheck', fFuture, el('span', '', 'Also change the later occurrences')) : null,
    rec && !mac ? el('p', 'sp-note', 'This repeats: the change applies to this occurrence only.') : null,
    err,
    el('div', 'dlg-acts cal-sheet-acts',
      el('button', { type: 'button', class: 'btn', onclick: closeSheet }, 'Cancel'),
      el('button', { type: 'button', class: 'btn primary', onclick: review }, 'Review…')));
  if (ctx.focusTitle !== false) requestAnimationFrame(() => fTitle.focus());
}

function summaryRows(e, cal) {
  const color = calColor(cal);
  return el('div', 'cal-review',
    el('div', 'rv-title', el('span', { class: 'cev-bar', style: { background: color } }), el('b', '', e.title)),
    el('div', 'rv-row', ico('clock', 13), M.timeText(e, LOCALE)),
    el('div', 'rv-row', el('i', { class: 'cev-dot', style: { background: color } }), `${cal ? cal.title : ''} · ${cal && cal.source === 'google' ? `Google${S.google.email ? ` (${S.google.email})` : ''}` : 'your Mac'}`),
    e.location ? el('div', 'rv-row', ico('globe', 13), e.location) : null,
    e.eventUrl ? el('div', 'rv-row', ico('ext', 13), e.eventUrl) : null,
    e.alerts && e.alerts.length ? el('div', 'rv-row', ico('bell', 13), `Alerts: ${alertWords(e.alerts)}`) : null,
    e.notes ? el('div', 'rv-notes', e.notes.length > 400 ? `${e.notes.slice(0, 400)}…` : e.notes) : null);
}
const alertWords = (list) => (list.length ? list.map((m) => alertText(m).replace(/ before$/, '')).join(', ') + (list.some((m) => m > 0) ? ' before' : '') : 'none');
const asEvent = (d, cal) => ({ title: d.title, allDay: d.allDay, start: d.allDay ? M.ymd(d.start) : d.start.toISOString(), end: d.allDay ? M.ymd(d.end) : d.end.toISOString(), location: d.location, notes: d.notes, eventUrl: d.url || '', alerts: d.alerts || [], source: cal.source, calendarId: cal.id });

function reviewWrite(ctx) {
  const { mode, cal, draft, original } = ctx;
  const after = asEvent(draft, cal);
  const parts = [];
  if (mode === 'create') parts.push(summaryRows(after, cal));
  else {
    const changes = [];
    if (draft.title !== original.title) changes.push(['Title', original.title, draft.title]);
    if (M.timeText(after, LOCALE) !== M.timeText(original, LOCALE)) changes.push(['When', M.timeText(original, LOCALE), M.timeText(after, LOCALE)]);
    if ((draft.location || '') !== (original.location || '')) changes.push(['Place', original.location || '—', draft.location || '—']);
    if ((draft.notes || '') !== (original.notes || '')) changes.push(['Notes', original.notes ? 'old notes' : '—', draft.notes ? 'new notes' : '—']);
    if ('url' in draft && (draft.url || '') !== (original.eventUrl || '')) changes.push(['Link', original.eventUrl || '—', draft.url || '—']);
    if (Array.isArray(draft.alerts) && JSON.stringify(draft.alerts) !== JSON.stringify(original.alerts || [])) changes.push(['Alerts', Array.isArray(original.alerts) ? alertWords(original.alerts) : 'as they are', alertWords(draft.alerts)]);
    parts.push(summaryRows(original, cal), el('div', 'cal-changes', ...changes.map(([k, a, b]) => el('div', 'chg', el('span', 'k', k), el('span', 'a', a), el('span', 'arr', '→'), el('b', '', b)))));
    if (original.recurrence && original.recurrence.recurring) parts.push(el('p', 'sp-note', cal.source === 'mac' && ctx.future ? 'It repeats: this one and every later one change.' : 'It repeats: only this occurrence changes.'));
  }
  const verb = mode === 'create' ? 'Add event' : 'Save changes';
  commitSheet(mode === 'create' ? 'Add this event?' : 'Save these changes?', parts, cal, verb, () => (mode === 'create' ? doCreate(cal, draft) : doUpdate(original, cal, draft, ctx.future)), () => editor({ ...ctx, focusTitle: false }), original && original.attendees && original.attendees.length);
}

function reviewDelete(e) {
  const cal = calendarsById().get(evCalKey(e));
  if (!cal) return;
  let which = 'this';
  const rec = e.recurrence && e.recurrence.recurring;
  const parts = [summaryRows(e, cal)];
  if (rec && (cal.source === 'mac' || e.recurrence.seriesId)) {
    const opt = (v, label, on) => {
      const r = el('input', { type: 'radio', name: 'calwhich', value: v });
      r.checked = on;
      r.addEventListener('change', () => { which = v; });
      return el('label', 'cal-fcheck', r, el('span', '', label));
    };
    parts.push(el('div', { class: 'cal-which', role: 'radiogroup', 'aria-label': 'Which occurrences' },
      opt('this', 'Only this event', true),
      opt('all', cal.source === 'mac' ? 'This and all later events' : 'All events in the series', false)));
  }
  commitSheet('Delete this event?', parts, cal, 'Delete event', () => doDelete(e, cal, which === 'all'), null, e.attendees && e.attendees.length, true);
}

function commitSheet(title, parts, cal, verb, run, back, hasGuests, danger) {
  const err = el('div', { class: 'cal-err', role: 'alert' });
  const note = cal.source === 'google'
    ? el('div', 'sp-warn', el('b', '', `Google Calendar changes when you press ${verb}`), hasGuests ? 'Guests aren’t emailed about it.' : 'No one is emailed.')
    : el('div', 'sp-warn', el('b', '', 'Jarvis will ask you on your Mac too'), 'After you press ' + verb + ', the Jarvis app shows its own card on your Mac; the calendar changes only when you approve it there.');
  const go = el('button', { type: 'button', class: `btn ${danger ? 'danger solid' : 'primary'} cal-commit` }, verb);
  go.addEventListener('click', async () => {
    go.disabled = true;
    go.textContent = cal.source === 'mac' ? macWaitText() : danger ? 'Deleting…' : 'Saving…';
    if (cal.source === 'mac') go.dataset.mac = '';
    err.textContent = '';
    try {
      const msg = await run();
      closeSheet({ keepPreview: true }); // the moved event stays put until the calendar reloads
      closePop();
      toast(msg);
      load(true).finally(() => { if (S.preview) { S.preview = null; renderView(); } });
    } catch (e) {
      err.textContent = e.message;
      go.disabled = false;
      delete go.dataset.mac;
      go.textContent = verb;
    }
  });
  openSheet(title, ...parts, note, err,
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

async function doCreate(cal, d) {
  store.set('eden:cal:lastcal', calKey(cal.source, cal.id));
  if (cal.source === 'google') {
    await postJSON('/api/chat/gcal', { action: 'create', args: { calendarId: cal.id, event: M.googleInput(d), confirm: true } });
    return `Added “${d.title}” to ${cal.title}`;
  }
  return macWrite('calendar_create', M.macCreateArgs(d, cal.title), `Added “${d.title}” to ${cal.title} on your Mac`);
}
async function doUpdate(e, cal, d, future) {
  if (cal.source === 'google') {
    await postJSON('/api/chat/gcal', { action: 'update', args: { calendarId: cal.id, id: e.id, event: M.googleChanges(e, d), confirm: true } });
    return `Saved “${d.title}”`;
  }
  const args = M.macUpdateArgs(e, d, future);
  if (!args) throw new Error('Nothing that Jarvis can change has changed.');
  return macWrite('calendar_update', args, `Saved “${d.title}” on your Mac`);
}
async function doDelete(e, cal, all) {
  if (cal.source === 'google') {
    const id = all && e.recurrence && e.recurrence.seriesId ? e.recurrence.seriesId : e.id;
    await postJSON('/api/chat/gcal', { action: 'delete', args: { calendarId: cal.id, id, confirm: true } });
    return `Deleted “${e.title}”`;
  }
  return macWrite('calendar_delete', M.macDeleteArgs(e, all), `Deleted “${e.title}” on your Mac`);
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
