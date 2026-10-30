/* Eden Travel: the travel day on the iPhone's Lock Screen and in the Dynamic Island (a Live Activity).
 *
 * Only inside the Ask Eden Travel iPhone app (IN_TRAVEL_APP): the page's Today view hands over today's plan as it has
 * it (the next stop, its time, "leave by" from the checked travel time, the flight's gate when FlightAware has it), and
 * the app starts, updates and ends the activity on the phone (ios/EdenTravel/TravelLive.swift). Nothing shows until
 * the person taps "Show on Lock Screen" once; the app keeps that choice and follows Settings › Eden Travel › Live
 * Activities. Everywhere else (askedentravel.com in a browser, the Eden app) every export here does nothing.
 *
 * Messages (JSON text in document 'eden:to-app', through the app's bridge; answers in window 'eden:from-app'):
 *   to the app:   travel.live.state | travel.live.update { plan } | travel.live.optin | travel.live.end
 *                 | travel.live.optout | travel.live.settings
 *   from the app: travel.live.state { supported, enabled, opted, running, endedToday }
 *                 | travel.live.token { token?, pushToStart?, trip?, date?, env }: the activity's push token (and, iOS
 *                   17.2+, the app's push-to-start token), passed to the site (trip-live-token) so the Lock Screen keeps
 *                   up with the app closed (the Worker's travel/liveact.js)
 *                 | travel.live.ended { trip?, date?, never? }: the person ended it (or said never): trip-live-end
 *
 * Hooks: liveToday(S.data) wherever travel.js companion() paints; liveFlight(f) where a FlightAware status arrives
 * (trip-ui.js flightMapCard, the tracker travel.js shows on a flight's day); liveButton() in the companion's actions.
 */
import { IN_TRAVEL_APP } from './native.js';

const FLIGHT_NO = /\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{1,4})\b/; // as travel.js
const MODES = new Set(['walk', 'transit', 'drive', 'taxi']);

let state = { supported: false, enabled: false, opted: false, running: false, endedToday: false };
const views = new Set(); // the buttons on show, repainted when the app says something changed
let lastData = null; // the trip data last given (a flight's news re-sends it)
let flight = null; // { ident, gate, terminal } from FlightAware, for today's flight
let sent = ''; // the last plan sent, so a repaint doesn't send it again
let bridge = false; // the app's bridge is on the page (it arrives at document end, after module scripts)
const queue = [];
const posted = new Set(); // tokens already given to the site this page load

// the app's tokens and ends, to the site (travel/liveact.js), with this page's own session
const post = (action, args) => import('./api.js').then(({ postJSON }) => postJSON('/api/chat/travel', { action, args }, { timeout: 15_000 }));
function toSite(m) {
  if (m.kind === 'travel.live.token') {
    const args = { env: m.env === 'sandbox' ? 'sandbox' : 'production' };
    if (m.token && m.trip && m.date) Object.assign(args, { token: String(m.token), trip: String(m.trip), day: String(m.date) });
    if (m.pushToStart) args.push_to_start = String(m.pushToStart);
    if (!args.token && !args.push_to_start) return;
    const key = JSON.stringify(args);
    if (posted.has(key)) return;
    posted.add(key);
    post('live-token', args).catch(() => posted.delete(key)); // the app sends it again next time
  } else if (m.kind === 'travel.live.ended') {
    const args = m.never ? { never: true } : {};
    if (m.trip && m.date) Object.assign(args, { trip: String(m.trip), day: String(m.date) });
    post('live-end', args).catch(() => {});
  }
}

function toApp(msg) {
  if (!IN_TRAVEL_APP) return;
  if (!bridge) { queue.push(msg); return; }
  document.dispatchEvent(new CustomEvent('eden:to-app', { detail: JSON.stringify(msg) }));
}

if (IN_TRAVEL_APP && typeof document !== 'undefined') {
  addEventListener('eden:from-app', (e) => {
    const m = e.detail;
    if (m && (m.kind === 'travel.live.token' || m.kind === 'travel.live.ended')) return toSite(m);
    // a home-screen widget tapped: travel.js opens the trip's Today view
    if (m && m.kind === 'travel.live.open') return dispatchEvent(new CustomEvent('eden:travel-open-view', { detail: { view: m.view === 'today' ? 'companion' : null, trip: /^[0-9a-f]{16}$/.test(String(m.trip || '')) ? m.trip : null } }));
    if (!m || m.kind !== 'travel.live.state') return;
    state = { supported: !!m.supported, enabled: !!m.enabled, opted: !!m.opted, running: !!m.running, endedToday: !!m.endedToday };
    for (const v of views) if (v.isConnected) paintButton(v); else views.delete(v);
  });
  const ready = () => {
    if (bridge) return;
    bridge = true;
    queue.splice(0).forEach(toApp);
  };
  document.addEventListener('eden:bridge-ready', ready, { once: true });
  // the bridge may already be there (this module loaded late); its first message then goes straight through
  if (document.readyState !== 'loading') ready(); else document.addEventListener('DOMContentLoaded', () => setTimeout(ready, 0), { once: true });
  toApp({ kind: 'travel.live.state' });
}

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Today's plan for the Live Activity, from the trip data the Today view paints (S.data: { trip, checks }), or null when
 * no day of the trip is today. Mirrors travel.js companion() and leaveBy(): times are the traveller's own clock, a stop
 * earlier than the one before it is after midnight, and "leave by" only from a checked travel time (never a guess).
 * Pure apart from `now`; exported for tests.
 */
export function livePlan(data, { now = new Date(), flightInfo = flight } = {}) {
  const trip = data && data.trip, checks = data && data.checks;
  if (!trip || !checks || !Array.isArray(trip.days) || !Array.isArray(checks.days)) return null;
  const today = dayOf(now);
  const di = checks.days.findIndex((x) => x && x.date === today);
  if (di < 0 || !trip.days[di]) return null;
  const d = trip.days[di], c = checks.days[di] || { stops: [] };
  const stops = d.stops || [];
  let prev = -1;
  const mins = stops.map((s) => { const [h, m] = String(s.at || '').split(':').map(Number); let v = h * 60 + m; if (!Number.isFinite(v)) return NaN; if (v < prev) v += 1440; prev = v; return v; });
  const [y, mo, da] = today.split('-').map(Number);
  const at = (v) => new Date(y, mo - 1, da, 0, v).getTime(); // past midnight rolls into tomorrow
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const k = mins.findIndex((v) => v >= nowMin);
  const lastK = mins.reduce((acc, v, i) => (Number.isFinite(v) ? i : acc), -1);
  const dayEnds = lastK >= 0 ? at(mins[lastK] + (Number(stops[lastK].minutes) || 0)) : null;
  const plan = { trip: String(trip.title || trip.name || trip.destination || 'Your trip').slice(0, 60), id: /^[0-9a-f]{16}$/.test(String(trip.id || '')) ? trip.id : null, day: di + 1, date: today, next: null, stopsAfter: 0, dayEnds };
  if (k < 0) return plan; // today's last stop is behind you: the app ends the activity
  const s = stops[k];
  const t = ((c.stops || [])[k] || {}).badges && c.stops[k].badges.travel;
  const start = at(mins[k]);
  const checked = t && Number.isFinite(t.minutes) && t.minutes >= 0;
  const mode = (checked && t.mode) || s.mode;
  plan.next = {
    name: String((s.place && s.place.name) || 'Next stop').slice(0, 60),
    start,
    leave: checked ? start - t.minutes * 60_000 : null,
    mode: MODES.has(mode) ? mode : null,
    minutes: checked ? t.minutes : null,
    source: checked ? String(t.source || 'checked').slice(0, 30) : null,
  };
  plan.stopsAfter = stops.length - k - 1;
  // the rest of today, for the medium home-screen widget (the same rules as `next`)
  plan.stops = stops.slice(k, k + 6).map((x, j) => {
    const i = k + j;
    if (!Number.isFinite(mins[i])) return null;
    const tt = ((c.stops || [])[i] || {}).badges && c.stops[i].badges.travel;
    const ok = tt && Number.isFinite(tt.minutes) && tt.minutes >= 0;
    const st = at(mins[i]), md = (ok && tt.mode) || x.mode;
    return { name: String((x.place && x.place.name) || 'Stop').slice(0, 60), start: st, leave: ok ? st - tt.minutes * 60_000 : null, mode: MODES.has(md) ? md : null, minutes: ok ? tt.minutes : null, source: ok ? String(tt.source || 'checked').slice(0, 30) : null };
  }).filter(Boolean);
  // the day's flight: its number from the stop (as companion() finds it), its gate and terminal from FlightAware
  const fs = stops.find((x) => x.kind === 'transport' && FLIGHT_NO.test(`${x.place && x.place.name} ${x.note || ''}`));
  const fm = fs && FLIGHT_NO.exec(`${fs.place && fs.place.name} ${fs.note || ''}`);
  if (fm) {
    const ident = `${fm[1]}${fm[2]}`;
    const f = flightInfo && flightInfo.ident === ident ? flightInfo : null;
    plan.flight = { ident, gate: (f && f.gate) || null, terminal: (f && f.terminal) || null };
  }
  return plan;
}

/** The Today view painted (travel.js companion()): today's plan goes to the app, when it changed. */
export function liveToday(data) {
  if (!IN_TRAVEL_APP) return;
  lastData = data;
  const plan = livePlan(data);
  // before the trip: the home-screen widget's countdown ("Lisbon in 12 days"); a running Live Activity isn't touched
  const first = data && data.checks && data.checks.days && data.checks.days[0] && data.checks.days[0].date;
  const upcoming = !plan && data && data.trip && /^\d{4}-\d{2}-\d{2}$/.test(first || '') && first > dayOf(new Date())
    ? { trip: String(data.trip.title || data.trip.name || data.trip.destination || 'Your trip').slice(0, 60), id: /^[0-9a-f]{16}$/.test(String(data.trip.id || '')) ? data.trip.id : null, place: String(data.trip.destination || data.trip.title || '').split(',')[0].trim().slice(0, 40) || null, start: first }
    : null;
  if (!plan && !upcoming) return;
  const key = JSON.stringify({ plan, upcoming });
  if (key === sent) return;
  sent = key;
  toApp({ kind: 'travel.live.update', plan, upcoming });
}

/**
 * A flight's status arrived (FlightAware: trip-ui.js flightMapCard's trip-flight-live answer's `flight`: { ident, departure: { gate, terminal } }): its
 * departure gate and terminal go on the Lock Screen.
 */
export function liveFlight(f) {
  if (!IN_TRAVEL_APP || !f) return;
  const ident = String(f.ident || f.ident_iata || '').replace(/\s+/g, '').toUpperCase();
  const dep = f.departure || f.origin || {};
  const next = { ident, gate: dep.gate ? String(dep.gate).slice(0, 8) : null, terminal: dep.terminal ? String(dep.terminal).slice(0, 8) : null };
  if (!ident || (flight && flight.ident === next.ident && flight.gate === next.gate && flight.terminal === next.terminal)) return;
  flight = next;
  if (lastData) liveToday(lastData);
}

function button(label, onclick, cls = 'tv-btn') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.addEventListener('click', onclick);
  return b;
}

function paintButton(box) {
  box.replaceChildren();
  if (!state.supported) return; // the app hasn't answered (an older build without Live Activities)
  if (!state.enabled) {
    const p = document.createElement('span');
    p.className = 'tv-note';
    p.textContent = 'Live Activities are off for Eden Travel. ';
    box.append(p, button('Open Settings', () => toApp({ kind: 'travel.live.settings' }), 'tv-btn quiet'));
  } else if (state.running) {
    box.append(button('Remove from Lock Screen', () => toApp({ kind: 'travel.live.end' }), 'tv-btn quiet'));
  } else if (!state.opted || state.endedToday) {
    box.append(button('Show on Lock Screen', () => { toApp({ kind: 'travel.live.optin' }); if (lastData) { sent = ''; liveToday(lastData); } }));
  }
}

/** "Show on Lock Screen" (or "Remove from Lock Screen"), for the companion's actions; null outside the Travel app. */
export function liveButton() {
  if (!IN_TRAVEL_APP) return null;
  const box = document.createElement('span');
  box.className = 'tv-live';
  views.add(box);
  paintButton(box);
  return box;
}
