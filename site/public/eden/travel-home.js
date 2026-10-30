// Eden Travel's home: what a signed-in person sees first (2026-10-28, owner: "the first time I open the app it's an input box
// that says plan trip, that's confusing"). It follows where they are, never a bare planning box:
//  - no trips yet: welcome, bring the bookings you already have (email, a confirmation), or start another way (plan with
//    Eden, check a plan you have, when can I go, a sample trip);
//  - trips: the next trip's photo card with what's still to decide, Eden noticed (its first alerts), the other trips;
//  - a trip on now or starting within 2 days: "Next up" on top (that day's first stops, Today one press away).
// Mocks: research_notes/travel/landing-mocks/app/ (A, B, C). Opening a trip leaves the home; the brand or Trips comes back.
import { el, ico } from './util.js';
import { tripGet } from './trip-ui.js';

let C = null;
export function init(ctx) { C = ctx; }

const DAY = 86_400_000;
const today = () => { const d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); };
const dateOf = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) ? Date.parse(`${s.slice(0, 10)}T00:00:00Z`) : NaN);
const span = (t) => { const a = dateOf(t.start); return Number.isFinite(a) ? { a, b: a + (Math.max(1, t.days || 1) - 1) * DAY } : null; };
const fmt = (ms, o = { day: 'numeric', month: 'short' }) => new Date(ms).toLocaleDateString(undefined, { ...o, timeZone: 'UTC' });

/** The trips by when: on now or coming (soonest first), undated, then past (latest first). */
export function sortTrips(trips, now = today()) {
  const on = [], undated = [], past = [];
  for (const t of trips) { const s = span(t); if (!s) undated.push(t); else if (s.b < now) past.push(t); else on.push(t); }
  on.sort((x, y) => span(x).a - span(y).a);
  past.sort((x, y) => span(y).a - span(x).a);
  return { upcoming: [...on, ...undated], past };
}

/** "In 12 days", "Tomorrow", "Day 2 of 4", or the dates when undated/past. */
export function whenText(t, now = today()) {
  const s = span(t);
  if (!s) return `${t.days} day${t.days === 1 ? '' : 's'} · no dates yet`;
  if (s.a <= now && now <= s.b) return `Day ${Math.round((now - s.a) / DAY) + 1} of ${t.days}`;
  const n = Math.round((s.a - now) / DAY);
  if (n === 1) return 'Tomorrow';
  if (n > 1) return `In ${n} days`;
  return `${fmt(s.a)} – ${fmt(s.b, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}
const datesText = (t) => { const s = span(t); return s ? (s.a === s.b ? fmt(s.a) : `${fmt(s.a)} – ${fmt(s.b)}`) : null; };
const people = (n) => (n === 1 ? 'Just you' : n === 2 ? 'You + 1' : `You + ${n - 1}`);

/** The next trip's full data (checks included), fetched once per visit to the home; a failure just leaves it out. */
export async function loadNext() {
  const { S } = C;
  const next = sortTrips(S.trips).upcoming[0];
  if (!next) { S.next = null; return; }
  if (S.next && S.next.id === next.id && S.next.data) return;
  S.next = { id: next.id, data: null };
  try { const r = await tripGet(next.id); if (S.next && S.next.id === next.id) { S.next.data = r; C.paint(); } } catch { /* the card shows without its checks */ }
}

export function home() {
  const { S } = C;
  return S.trips.length ? withTrips() : firstVisit();
}

/* ---------- no trips yet ---------- */
function firstVisit() {
  const start = (icon, title, sub, run, k) => el('button', { type: 'button', class: 'tvh-start glass-card', 'data-k': `home:${k}`, onclick: run },
    el('span', 'tvh-ic', ico(icon, 18)), el('b', '', title), el('span', '', sub));
  return [el('section', { class: 'tvh tvh-first', 'aria-label': 'Eden Travel home' },
    el('h1', 'tvh-hi', 'Welcome to Eden Travel'),
    el('p', 'tvh-sub', 'Every opening hour, travel time and price Eden gives you is checked against its source, and nothing in your plans changes until you say so.'),
    el('div', { class: 'glass-card tvh-bring' },
      el('span', 'tv-kicker accent', 'Already booked something?'),
      el('h2', '', 'Start from your bookings'),
      el('p', '', 'Eden finds your flights, stays and tickets, makes them a trip and fills the days around them.'),
      el('div', 'tv-acts',
        el('button', { type: 'button', class: 'tv-btn primary', 'data-k': 'home:mail', onclick: () => C.ask('Find my travel bookings in my email and make a trip from them') }, ico('mail', 14), 'Find them in my email'),
        el('button', { type: 'button', class: 'tv-btn quiet', 'data-k': 'home:paste', onclick: () => C.ask('Make a trip from this booking confirmation (I’ll paste it or attach it): ') }, ico('clip', 14), 'Paste a confirmation'))),
    el('h2', 'tvh-h2', 'Or start another way'),
    el('div', 'tvh-starts',
      start('spark', 'Plan with Eden', '“4 days in Lisbon in May”', () => C.planNew(), 'plan'),
      start('check', 'Check a plan you have', 'From another AI, a friend or a guide', () => C.ask('Check this travel plan: are the hours, travel times and prices right? (I’ll paste it) '), 'check'),
      start('cal', 'When can I go?', 'Your days off, around public holidays', () => C.openPto(), 'pto'),
      start('globe', 'See a sample trip', 'Three days in Lisbon, checked', () => C.sample(), 'sample')))];
}

/* ---------- trips ---------- */
function withTrips() {
  const { S } = C;
  const { upcoming, past } = sortTrips(S.trips);
  const next = upcoming[0];
  const data = S.next && next && S.next.id === next.id ? S.next.data : null;
  const shared = S.shared || [];
  const out = [el('h1', 'tvh-hi', next ? `${greeting()}` : 'Your trips'),
    el('p', 'tvh-sub', next ? nextLine(next, data) : 'No trips coming up. Plan the next one, or look back at where you’ve been.')];
  if (next) {
    const soon = data ? nextUp(next, data) : null;
    if (soon) out.push(soon);
    out.push(tripHero(next, data));
    const al = data && data.checks ? data.checks.alerts.slice(0, 3) : [];
    if (al.length) out.push(noticedList(next, al, data.checks.alerts.length));
  }
  const rest = upcoming.slice(1);
  out.push(el('div', 'tvh-head', el('h2', 'tvh-h2', next ? 'Also coming up' : 'Plan a trip')),
    el('div', 'tvh-grid', ...rest.map((t) => tripTile(t)), ...shared.map((x) => sharedTile(x)), newTile()));
  if (past.length) out.push(el('details', 'tvh-past', el('summary', '', `Past trips (${past.length})`), el('div', 'tvh-grid', ...past.map((t) => tripTile(t)))));
  return [el('section', { class: 'tvh', 'aria-label': 'Eden Travel home' }, ...out)];
}
function greeting() { const h = new Date().getHours(); return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'; }
function nextLine(t, data) {
  const w = whenText(t);
  const name = C.city(t);
  const lead = w.startsWith('Day ') ? `You’re in ${name}: ${w.toLowerCase()}.` : w === 'Tomorrow' ? `${name} tomorrow.` : w.startsWith('In ') ? `${name} ${w.toLowerCase()}.` : `${name}.`;
  const checked = data && data.checks && data.checks.checked_at ? ` Eden checked it ${ago(data.checks.checked_at)}.` : '';
  return lead + checked;
}
function ago(iso) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(m) || m < 0) return 'just now';
  return m < 2 ? 'just now' : m < 60 ? `${m} min ago` : m < 24 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}

/** A trip on now or starting within 2 days: that day's first stops, and Today one press away. */
function nextUp(t, data) {
  const s = span(t); if (!s) return null;
  const now = today();
  if (now < s.a - 2 * DAY || now > s.b) return null;
  const d = now >= s.a ? Math.round((now - s.a) / DAY) : 0;
  const day = data.trip.days[d]; if (!day || !day.stops.length) return null;
  const label = now >= s.a ? 'Today' : now === s.a - DAY ? 'Tomorrow' : `On ${fmt(s.a, { weekday: 'long' })}`;
  return el('section', { class: 'glass-card tvh-nextup', 'aria-label': `${label} on your trip` },
    el('span', 'tv-kicker accent', `Next up · ${label}`),
    el('ol', 'tvh-stops', ...day.stops.slice(0, 4).map((x) => el('li', '', el('b', '', x.at || ''), el('span', '', x.place.name)))),
    el('div', 'tv-acts',
      el('button', { type: 'button', class: 'tv-btn primary', 'data-k': 'home:today', onclick: () => C.openTrip(t.id, now >= s.a ? { view: 'companion', day: d } : { day: d }) }, ico('tv-now', 14), now >= s.a ? 'Open Today' : 'See the day')));
}

// the trip photo's slow zoom (travel.css tv-kb, 18 s, once per photo); a repaint meanwhile picks it up where it was
const kbSeen = new Map();
function photoFor(t, cls) {
  const ph = C.heroPhoto(C.city(t));
  if (ph && cls === 'tvh-hero-img') {
    if (!kbSeen.has(ph.url)) kbSeen.set(ph.url, Date.now());
    const at = Date.now() - kbSeen.get(ph.url);
    if (at < 18_000) return el('img', { class: `${cls} tv-kb`, src: C.photoSrc(ph.url), alt: '', decoding: 'async', ...(at > 50 ? { style: { animationDelay: `-${at}ms` } } : {}) });
  }
  return ph ? el('img', { class: cls, src: C.photoSrc(ph.url), alt: '', title: `Photo: ${ph.author || 'Wikimedia Commons'}${ph.licence ? ` · ${ph.licence}` : ''} · Wikimedia Commons`, decoding: 'async', loading: 'lazy' }) : null;
}
function credit(t) {
  const ph = C.heroPhoto(C.city(t));
  return ph ? el('span', { class: 'tv-hero-credit', 'data-no-i18n': '' }, `Photo: ${ph.author || 'Wikimedia Commons'}${ph.licence ? ` · ${ph.licence}` : ''} · Wikimedia Commons`) : null;
}

function tripHero(t, data) {
  const alerts = data && data.checks ? data.checks.alerts.length : null;
  const chips = [whenText(t), datesText(t), people(t.travelers || 1)].filter(Boolean);
  return el('section', { class: 'tvh-hero', 'aria-label': t.title },
    photoFor(t, 'tvh-hero-img'), credit(t), el('div', 'tvh-shade'),
    el('div', 'tvh-hero-on',
      el('div', 'tvh-chips', ...chips.map((c) => el('span', 'tvh-chip', c))),
      el('h2', '', t.title),
      el('div', 'tvh-hero-row',
        el('span', '', alerts === null ? `${t.days} day${t.days === 1 ? '' : 's'}` : alerts ? `${alerts} thing${alerts === 1 ? '' : 's'} to look at` : 'Everything checked'),
        el('button', { type: 'button', class: 'tv-btn primary', 'data-k': 'home:open', onclick: () => C.openTrip(t.id) }, 'Open trip'))));
}

function noticedList(t, alerts, total) {
  return el('section', { class: 'glass-card tvh-noticed', 'aria-label': 'Eden noticed' },
    el('div', 'tvh-head', el('span', 'tv-kicker accent', ico('spark', 12), 'Eden noticed'), total > alerts.length ? el('button', { type: 'button', class: 'tv-link', onclick: () => C.openTrip(t.id) }, `All ${total}`) : null),
    el('ul', '', ...alerts.map((a, i) => el('li', '',
      el('div', '', el('b', '', a.text), el('span', '', `Day ${a.day + 1}`)),
      el('button', { type: 'button', class: 'tv-btn quiet', 'data-k': `home:fix:${i}`, onclick: () => C.openTrip(t.id, { day: a.day, fix: a }) }, 'Fix with Eden')))));
}

function tripTile(t) {
  return el('button', { type: 'button', class: 'tvh-tile glass-card', 'data-k': `home:trip:${t.id}`, onclick: () => C.openTrip(t.id) },
    el('span', 'tvh-tile-ph', photoFor(t, 'tvh-tile-img')),
    el('b', '', t.title), el('span', '', [whenText(t), people(t.travelers || 1)].join(' · ')));
}
function sharedTile(x) {
  return el('button', { type: 'button', class: 'tvh-tile glass-card', 'data-k': `home:shared:${x.trip}`, onclick: () => C.openShared(x.owner, x.trip) },
    el('span', 'tvh-tile-ph'), el('b', '', x.title), el('span', '', 'Shared with you'));
}
function newTile() {
  return el('button', { type: 'button', class: 'tvh-tile tvh-new', 'data-k': 'home:new', onclick: () => C.planNew() },
    el('span', 'tvh-plus', ico('plus', 22)), el('b', '', 'New trip'), el('span', '', 'Plan with Eden, or bring your bookings'));
}
