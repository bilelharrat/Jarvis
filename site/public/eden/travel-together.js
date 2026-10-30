// Planning together on the Eden Travel page (site travel/together.js): who else has the trip open right now and where
// ("Sam · Day 2 · Map"), who on the trip is looking after a stop ("Sam is on it", the organiser sets it, a member
// suggests it to the organiser), a "Mine" filter for the stops you look after, and a copy of the trip as a new trip
// of your own (bookings, what was paid for them and their notes left out; the page says so).
//
// travel.js hands it its state and helpers through init, like travel-more.js: { S, paint }. Presence beats every
// PRESENCE_S seconds, and at once when the day or view changes, only while the page is on screen and online.

import { el, toast } from './util.js';
import { tripPost } from './trip-ui.js';

let C = null;
const PRESENCE_S = 20;
const VIEW_NAME = { workspace: 'Day', board: 'Journey', map: 'Map', companion: 'Today', discover: 'Explore', group: 'Group', memories: 'Memories' };
const err = (e) => toast(String((e && e.message) || e));

export function init(ctx) {
  C = ctx;
  style();
  if (!timer) {
    // a cheap local check every 2 s; a beat only when 20 s have passed or the day or view changed
    timer = setInterval(tick, 2000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(true); });
  }
}

/* ---------- presence ---------- */

let timer = null, last = { key: null, at: 0 }, busy = false;
const tripKey = () => { const S = C.S; return S.member ? `s:${S.member.owner}:${S.member.trip}` : S.id ? `t:${S.id}` : null; };

async function tick(now = false) {
  const S = C && C.S;
  if (!S || !S.data || !S.id || S.offline || document.hidden || !document.body.classList.contains('travel-open') || busy) return;
  const trip = tripKey();
  if (S.together && S.together.trip !== trip) S.together = null; // another trip: its people aren't this one's
  const key = `${trip}|${S.day}|${S.view}`;
  if (!now && key === last.key && Date.now() - last.at < PRESENCE_S * 1000) return;
  last = { key, at: Date.now() };
  busy = true;
  try {
    const args = { day: S.day, view: S.view };
    const r = S.member ? await tripPost('shared-presence-beat', { owner: S.member.owner, trip: S.member.trip, ...args }) : await tripPost('presence-beat', { id: S.id, ...args });
    if (tripKey() !== trip) return; // moved to another trip meanwhile
    const sig = (x) => JSON.stringify(x && [x.present.map((p) => [p.id, p.day, p.view]), x.people.map((p) => [p.id, p.name])]);
    const changed = sig(S.together) !== sig(r);
    S.together = { ...r, trip };
    // a repaint only when someone came, went or moved (never mid-typing: it would take the field away)
    const typing = S.pane && S.pane.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (changed && !typing) C.paint();
  } catch { /* a missed beat: the next one tries again */ } finally { busy = false; }
}

const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
const HUES = [211, 280, 28, 145, 340, 190, 48, 255];
const hue = (id) => HUES[[...String(id)].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7) % HUES.length];
function avatar(p, cls = '') {
  return el('span', { class: `tvt-av ${cls}`.trim(), style: { '--h': hue(p.id) }, 'aria-hidden': 'true' }, initials(p.name));
}
const where = (p) => [p.day != null ? `Day ${p.day + 1}` : null, VIEW_NAME[p.view] || null].filter(Boolean).join(' · ');

/** Everyone else looking at this trip now, as small initials (for the top bar or the day head); null when it's just you. */
export function presenceBar() {
  const T = C.S.together;
  if (!T || T.trip !== tripKey()) return null;
  const others = T.present.filter((p) => !p.me);
  if (!others.length) return null;
  const said = others.map((p) => `${p.name}${where(p) ? ` · ${where(p)}` : ''}`).join(', ');
  return el('span', { class: 'tvt-here', role: 'status', 'aria-label': `Here now: ${said}`, title: `Here now: ${said}` },
    ...others.slice(0, 4).map((p) => el('span', { class: 'tvt-here-one' }, avatar(p), el('span', 'tvt-here-where', `${p.name.split(' ')[0]}${p.day != null ? ` · Day ${p.day + 1}` : ''}`))),
    others.length > 4 ? el('span', 'tvt-av tvt-more', `+${others.length - 4}`) : null);
}

/* ---------- who's on a stop ---------- */

const people = () => (C.S.together && C.S.together.trip === tripKey() ? C.S.together.people : []);
const me = () => (C.S.together && C.S.together.trip === tripKey() ? C.S.together.me : null);
const personOf = (id) => people().find((p) => p.id === id) || null;

/** A small avatar for a stop's head, when someone is on it. */
export function ownerChip(s) {
  if (!s.owner) return null;
  const p = personOf(s.owner) || { id: s.owner, name: 'Someone on the trip' };
  return el('span', { class: 'tvt-owner-chip', title: s.owner === me() ? 'You’re on it' : `${p.name} is on it` }, avatar(p, 'small'), el('span', 'sr-only', s.owner === me() ? 'You’re on it' : `${p.name} is on it`));
}

/** The stop's detail: who's on it, and (organiser) set it or (member) suggest it to the organiser. */
export function ownerBlock(trip, s) {
  const S = C.S;
  const p = s.owner ? personOf(s.owner) : null;
  const said = !s.owner ? null : s.owner === me() ? 'You’re on it' : `${p ? p.name : 'Someone no longer on the trip'} is on it`;
  const list = people();
  const pick = list.length && !S.offline ? el('select', { class: 'tvt-pick', 'data-k': `owner:${s.id}`, 'aria-label': S.member ? 'Suggest who looks after this' : 'Who looks after this',
    onchange: (e) => setOwner(trip, s, e.target.value || null, e.target) },
    el('option', { value: '', ...(!s.owner ? { selected: '' } : {}) }, S.member ? 'Suggest who’s on it…' : 'Nobody on it yet'),
    ...list.map((x) => el('option', { value: x.id, ...(x.id === s.owner && !S.member ? { selected: '' } : {}) }, x.id === me() ? `${x.name} (you)` : x.name))) : null;
  if (!said && !pick) return null;
  return el('div', 'tvt-owner', said ? el('span', 'tvt-owner-who', avatar(p || { id: s.owner, name: '?' }, 'small'), said) : null, pick);
}

async function setOwner(trip, s, owner, select) {
  const S = C.S;
  const name = owner ? (personOf(owner) || {}).name || 'Someone' : null;
  const ops = [{ op: 'owner', stop: s.id, owner }];
  select.disabled = true;
  try {
    if (S.member) {
      // the organiser decides: it lands in their Eden noticed, with who suggested it
      await tripPost('shared-propose', { owner: S.member.owner, trip: S.member.trip, title: owner ? `${name} looks after ${s.place.name}` : `Nobody on ${s.place.name}`, reason: 'Suggested on the stop.', ops });
      toast('Sent to the organiser');
    } else {
      await tripPost('edit', { id: S.id, ops, rev: trip.rev });
      toast(owner ? `${name} is on ${s.place.name}` : `Nobody on ${s.place.name} now`);
    }
  } catch (e) { err(e); select.disabled = false; }
}

/* ---------- "Mine" ---------- */

/** The day head's switch: only the stops you look after. Shown once anyone is on a stop. */
export function mineToggle(trip) {
  const S = C.S;
  if (!me() || !trip.days.some((d) => d.stops.some((s) => s.owner))) return null;
  return el('button', { type: 'button', class: 'tv-pill', 'data-k': 'mine', 'aria-pressed': String(Boolean(S.mine)), title: 'Only the stops you look after', onclick: () => { S.mine = !S.mine; C.paint(); } }, 'Mine');
}
/** True when "Mine" is on and this stop isn't yours (the timeline skips its row and the leg to it). */
export const hiddenByMine = (s) => Boolean(C.S.mine && me() && s.owner !== me());
/** The day's empty line while "Mine" hides every stop. */
export const mineEmpty = (d) => (C.S.mine && me() && d.stops.length && d.stops.every(hiddenByMine) ? el('li', 'tv-stop empty', 'Nothing on you this day. Turn off Mine to see every stop.') : null);

/* ---------- copy a trip ---------- */

/** The copy panel opens or closes (travel.js's Trip tools menu, for the organiser and members). */
export function toggleCopy() {
  const S = C.S;
  if (!S.data || S.offline) return;
  S.copyOpen = !S.copyOpen; C.paint();
}

/** The copy panel: a start date (the same one by default), and what isn't copied, said before. */
export function copyPanel(trip) {
  const S = C.S;
  if (!S.copyOpen) return null;
  const booked = trip.days.reduce((n, d) => n + d.stops.filter((s) => s.booked).length, 0);
  const date = el('input', { type: 'date', value: trip.start, 'aria-label': 'Start date of the copy' });
  const go = el('button', { type: 'button', class: 'tv-btn primary', 'data-k': 'copy-go', onclick: async () => {
    go.disabled = true;
    try {
      const start = /^\d{4}-\d{2}-\d{2}$/.test(date.value) ? date.value : undefined;
      const r = S.member ? await tripPost('shared-copy', { owner: S.member.owner, trip: S.member.trip, start }) : await tripPost('copy', { id: S.id, start });
      S.copyOpen = false;
      toast(r.note || 'Copied');
      dispatchEvent(new CustomEvent('eden:trip-changed', { detail: { id: r.trip.id } })); // travel.js shows the new trip
    } catch (e) { err(e); go.disabled = false; }
  } }, 'Make a copy');
  return el('section', { class: 'glass-card tv-sheet tvt-copy', 'aria-label': 'Copy this trip' },
    el('div', '', el('span', 'tv-kicker accent', 'Copy this trip'), el('b', '', `Copy “${trip.title}”`),
      el('p', 'tv-fine', `${S.member ? 'A new trip in your own Eden Travel, ' : 'A new trip, '}with the same days and stops.${booked ? ` Its ${booked} booking${booked === 1 ? ' isn’t' : 's aren’t'} copied: those stops come over not booked, without what was paid and without their notes.` : ''} Expenses, chat and documents stay here.`)),
    el('label', 'tvt-copy-date', 'Starts ', date), go,
    el('button', { type: 'button', class: 'tv-btn quiet', onclick: () => { S.copyOpen = false; C.paint(); } }, 'Cancel'));
}

/* ---------- looks (Eden Glass: DESIGN.md) ---------- */

function style() {
  if (typeof document === 'undefined' || document.getElementById('tvt-style')) return;
  document.head.append(el('style', { id: 'tvt-style' }, `
.tvt-here{display:inline-flex;align-items:center;gap:4px}
.tvt-here-one{display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 10px 0 3px;border-radius:999px;background:rgba(120,120,128,.14);font-size:12px;font-weight:600;white-space:nowrap}
.tv-bar .tvt-here-one{background:rgba(255,255,255,.12);color:#fff}
.tvt-av{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;flex:none;font:700 10.5px/1 -apple-system,system-ui,sans-serif;letter-spacing:.02em;color:#fff;background:hsl(var(--h,211) 70% 48%);box-shadow:0 0 0 1.5px var(--glass,#fff)}
.tvt-av.small{width:18px;height:18px;font-size:8.5px}
.tvt-av.tvt-more{background:rgba(120,120,128,.5)}
.tvt-owner{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:6px 0}
.tvt-owner-who{display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:600}
.tvt-pick{height:30px;border-radius:999px;border:1px solid var(--hairline);padding:0 10px;font:inherit;font-size:12.5px;background:transparent;color:var(--text)}
.tvt-owner-chip{display:inline-flex;margin-left:4px}
.tvt-copy{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
.tvt-copy>div{flex:1 1 260px}
.tvt-copy>div>b{display:block;margin-top:6px}
.tvt-copy-date{display:inline-flex;align-items:center;gap:6px;font-size:13px}
.tvt-copy-date input{height:34px;border-radius:10px;border:1px solid var(--hairline);padding:0 8px;font:inherit;background:transparent;color:var(--text)}
@media (max-width:640px){.tvt-here-where{display:none}.tvt-here-one{padding:0 3px}}
@media (prefers-reduced-motion:no-preference){.tvt-here-one{animation:tv-fade .3s cubic-bezier(.32,.72,0,1) both}}
`));
}
