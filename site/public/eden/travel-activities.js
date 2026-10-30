// Tours and tickets on the Eden Travel page (site travel/activities.js, op trip-activities): Viator and GetYourGuide
// results for the destination (in Discover) or near one stop (its "Find tickets"), each with the partner's price as it
// gives it, rating and how many rated it, how long it lasts and whether it can be cancelled for free, a link to book
// on the partner's own site, and "Add to day". OpenTable and TheFork only appear as a meal stop's own link. Eden takes
// no payment here. With no partner keys, the section says which partners would show here and that they're off.
//
// travel.js hands it its state and helpers through init, like travel-more.js: { S, paint, money2, hm, kicker, loadTrip }.

import { el, ico, toast } from './util.js';
import { tripPost } from './trip-ui.js';

let C = null;
export function init(ctx) { C = ctx; }

const err = (e) => toast(String((e && e.message) || e));
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const KINDS = [['', 'All'], ['tours', 'Tours'], ['tickets', 'Tickets'], ['food', 'Food and drink'], ['outdoors', 'Outdoors']];
const hm = (m) => (C.hm ? C.hm(m) : `${m} min`);
const price = (p) => (p ? `From ${C.money2 ? C.money2(p.amount, p.currency) : `${p.currency} ${p.amount}`}${p.per ? ` ${/^per /.test(p.per) ? p.per : `per ${p.per}`}` : ''}` : null);

function load(key, args) {
  const S = C.S;
  const A = S.acts || (S.acts = { data: new Map(), kind: '', free: false, open: null });
  if (A.data.has(key)) return A.data.get(key);
  A.data.set(key, null);
  tripPost('activities', { id: S.id, ...args }).then((r) => { A.data.set(key, r); C.paint(); }, (e) => { A.data.set(key, { error: String(e.message || e) }); C.paint(); });
  return null;
}

/* ---------- Discover: "Tours and tickets" ---------- */

/** The Discover view's section: the destination on the day shown. */
export function toursSection() {
  const S = C.S;
  if (S.member) return null;
  const A = S.acts || (S.acts = { data: new Map(), kind: '', free: false, open: null });
  const trip = S.data.trip;
  const date = dayDate(trip, S.day);
  const key = `${S.id}:dest:${date}:${A.kind}:${A.free ? 1 : 0}`;
  const r = load(key, { date, ...(A.kind ? { kind: A.kind } : {}), ...(A.free ? { free_cancel: true } : {}) });
  return el('section', { class: 'tv-disc glass-card', 'aria-label': 'Tours and tickets' },
    el('div', 'tv-card-head', el('span', 'tv-kicker', `Tours and tickets · Day ${S.day + 1}`),
      el('label', { class: 'tv-fine' }, el('input', { type: 'checkbox', ...(A.free ? { checked: '' } : {}), onchange: (e) => { A.free = e.target.checked; C.paint(); } }), ' Free cancellation only')),
    el('div', { class: 'tv-segs', role: 'group', 'aria-label': 'What' }, ...KINDS.map(([k, label]) => el('button', { type: 'button', class: 'tv-seg', 'aria-pressed': String(A.kind === k), 'data-k': `acts:${k || 'all'}`, onclick: () => { A.kind = k; C.paint(); } }, label))),
    body(r, { day: S.day, place: null }));
}

/* ---------- a stop: "Find tickets" ---------- */

/** The button for a stop's actions row. */
export function findTicketsButton(trip, s) {
  const S = C.S;
  if (S.member || s.kind === 'stay' || s.kind === 'transport' || s.kind === 'rental') return null;
  const A = S.acts || (S.acts = { data: new Map(), kind: '', free: false, open: null });
  const label = s.kind === 'meal' ? 'Book a table' : 'Find tickets';
  return el('button', { type: 'button', class: 'tv-btn', 'aria-expanded': String(A.open === s.id), 'data-k': `tickets:${s.id}`, onclick: () => { A.open = A.open === s.id ? null : s.id; C.paint(); } }, label);
}

/** The results under a stop's detail, while its "Find tickets" is open. */
export function ticketsBlock(trip, s) {
  const S = C.S;
  const A = S.acts;
  if (!A || A.open !== s.id || S.member) return null;
  const di = trip.days.findIndex((d) => d.stops.includes(s));
  const key = `${S.id}:stop:${s.id}:${dayDate(trip, di)}`;
  const r = load(key, { stop: s.id });
  return el('div', { class: 'tv-tickets', 'aria-label': `Tickets for ${s.place.name}` }, body(r, { day: di, place: s.place, after: s }));
}

/* ---------- shared ---------- */

function body(r, where) {
  if (r === null || r === undefined) return el('p', 'tv-note', 'Looking…');
  if (r.error) return el('p', 'tv-note warn', r.error);
  const on = r.partners.filter((p) => p.on);
  const off = r.partners.filter((p) => !p.on && p.kind === 'activities');
  const rest = r.partners.filter((p) => !p.on && p.kind === 'restaurants');
  const out = [];
  if (!on.length) {
    out.push(el('p', 'tv-note', `${off.map((p) => p.name).join(' and ')} tours and tickets will show here, with prices, ratings and free cancellation, to book on their own sites. They aren’t switched on yet.`));
    if (where.after && where.after.kind === 'meal') out.push(el('p', 'tv-fine', 'OpenTable and TheFork have no open booking API: give this stop its OpenTable or TheFork page as its link and the Book button shows here.'));
    return el('div', '', ...out);
  }
  for (const p of on) {
    out.push(el('div', 'tv-card-head', el('span', 'tv-kicker', p.name), el('span', 'tv-fine', `${p.results[0] ? p.results[0].source : p.source} · ${when(p.checked_at)}`)));
    if (p.error) out.push(el('p', 'tv-note warn', p.error));
    else if (!p.results.length) out.push(el('p', 'tv-note', `${p.name} has nothing for that day.`));
    else out.push(el('ul', 'tv-disc-list', ...p.results.map((x, i) => card(x, i, where))));
  }
  if (off.length) out.push(el('p', 'tv-fine', `${off.map((p) => p.name).join(' and ')}: not switched on yet.`));
  if (rest.length && where.after && where.after.kind === 'meal') out.push(el('p', 'tv-fine', `${rest.map((p) => p.name).join(' and ')} have no open booking API: Eden links to the venue’s page there when it is this stop’s link.`));
  out.push(el('p', 'tv-fine', 'Prices are the partner’s “from” price on the day searched; the partner’s page has the price for your group and time. You book and pay on their site.'));
  return el('div', '', ...out);
}

function card(x, i, where) {
  const fc = x.free_cancellation;
  const cancel = fc ? (fc.free === true ? `Free cancellation${fc.until_hours_before ? ` up to ${fc.until_hours_before} h before` : ''}` : fc.free === false ? 'Not free to cancel' : null) : null;
  const sub = [
    price(x.price),
    x.rating !== null && x.rating !== undefined ? `★ ${Number(x.rating).toFixed(1)}${x.reviews ? ` (${x.reviews.toLocaleString()})` : ''}` : null,
    x.duration_min ? (x.duration_max_min ? `${hm(x.duration_min)} to ${hm(x.duration_max_min)}` : hm(x.duration_min)) : x.duration_text,
    cancel,
    x.confirmation === 'instant' ? 'Instant confirmation' : null,
  ].filter(Boolean).join(' · ');
  return el('li', { class: 'tv-place', style: { '--i': Math.min(i, 9) } },
    el('div', 'tv-place-main', el('b', '', x.title), sub ? el('span', 'tv-meta', sub) : null, x.about ? el('p', '', x.about) : null,
      fc && fc.text ? el('small', '', fc.text) : null,
      el('div', 'tv-acts',
        x.book_url ? el('a', { class: 'tv-btn primary', href: x.book_url, target: '_blank', rel: 'noopener' }, ico('ext', 12), x.book_label || 'Book') : el('span', 'tv-fine', 'No booking link from the partner'),
        x.id ? addToDay(x, where) : null)));
}

/** Adds the tour or ticket to a day as an activity stop, linked to the partner's page (the person books it there). */
function addToDay(x, where) {
  const S = C.S;
  const trip = S.data.trip;
  const sel = where.after ? null : el('select', { class: 'tv-input small', 'aria-label': 'Which day' }, ...trip.days.map((d, i) => el('option', { value: String(i), ...(i === where.day ? { selected: '' } : {}) }, `Day ${i + 1}`)));
  return el('span', 'tv-addday', sel, el('button', { type: 'button', class: 'tv-btn', onclick: async (e) => {
    const di = sel ? Number(sel.value) : where.day;
    const btn = e.currentTarget; btn.disabled = true;
    try {
      // at the stop it was found for; otherwise Google's place for the title, so its hours and travel are checked
      let place = where.place ? { id: where.place.id, name: where.place.name, lat: where.place.lat, lng: where.place.lng } : null;
      if (!place) {
        const g = ((await tripPost('places', { text: `${x.title} ${String(trip.destination || '').split(',')[0]}` })).places || [])[0];
        place = g ? { id: g.id, name: g.name, lat: g.lat, lng: g.lng } : { name: x.title.slice(0, 120), lat: null, lng: null };
        if (!g) toast('Google Maps didn’t find it on the map, so travel to it won’t be checked');
      }
      const stops = trip.days[di].stops;
      const prev = where.after || stops[stops.length - 1];
      const start = prev ? Math.min(23 * 60, Number(prev.at.slice(0, 2)) * 60 + Number(prev.at.slice(3)) + (where.after ? 0 : prev.minutes + 30)) : 10 * 60;
      const r5 = Math.ceil(start / 5) * 5;
      const at = `${String(Math.floor(r5 / 60) % 24).padStart(2, '0')}:${String(r5 % 60).padStart(2, '0')}`;
      const note = [x.title !== place.name ? x.title : null, price(x.price) ? `${price(x.price)} on ${x.source} (${when(x.checked_at)})` : `On ${x.source}`, 'not booked yet'].filter(Boolean).join(' · ').slice(0, 500);
      const link = x.book_url && x.book_url.length <= 500 ? x.book_url : null; // the trip keeps links under 500 characters
      await tripPost('edit', { id: S.id, ops: [{ op: 'add', day: di, stop: { kind: 'activity', place, at, minutes: Math.min(1440, x.duration_min || 60), mode: 'transit', link, note } }] });
      toast(`${x.title.slice(0, 60)} added to Day ${di + 1} at ${at}`, { label: 'Undo', run: () => tripPost('undo', { id: S.id }).catch(err) });
      if (C.loadTrip) C.loadTrip(S.id, { keepDay: true });
    } catch (e2) { err(e2); }
    btn.disabled = false;
  } }, ico('plus', 12), 'Add to day'));
}

function dayDate(trip, i) {
  const d = new Date(`${trip.start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Math.max(0, i));
  return d.toISOString().slice(0, 10);
}
