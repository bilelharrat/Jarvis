// A trip, as Eden Travel keeps it: plain data, days of stops, changed only by a short list of
// operations. Ask Eden's proposals and the person's own edits both go through applyOps, so the
// same rules hold for both: a booked stop is locked (no moving, retiming or removing it; a note
// only), times are HH:MM, a day holds at most TRIP.stops stops.
//
// trip  { id, title, destination, start: 'YYYY-MM-DD', travelers, budget: { amount, currency } | null,
//         days: [{ title, stops }], rev, created, updated }
// stop  { id, kind, place: { id, name, lat, lng }, at: 'HH:MM', minutes, mode, cost: { amount, currency } | null,
//         nights, link, booked: null | { kind, ref, provider, via, at }, note }
//   kind: visit, stay, transport (a flight, train, bus, ferry, car hire), rental (skis, golf clubs, a bike), activity, meal.
//   mode: how you get to this stop from the one before (maps.js MODES). nights: a stay's nights. link: the provider's
//   https page to book it on (Eden's browser or the person's own). booked: set only by the person's "Mark as booked".
//
// ops   { op: 'add', day, stop, index? } · { op: 'remove', stop } · { op: 'move', stop, day, index? }
//       { op: 'time', stop, at } · { op: 'edit', stop, minutes?, mode?, note?, cost? } · { op: 'title', day, title }

import { ApiError } from '../accounts/util.js';
import { MODES } from './maps.js';

export const KINDS = ['visit', 'stay', 'transport', 'rental', 'activity', 'meal'];
export const TRIP = { max: 50, days: 30, stops: 24, ops: 40, title: 120, note: 500, travelers: 20 };

export class TripError extends ApiError {
  constructor(message, status = 400, code = 'bad_request') {
    super(status, code, message);
  }
}
const bad = (m) => new TripError(m);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = (s, cap) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, cap);
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STOP_ID = /^[a-z0-9-]{1,40}$/;

export const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const hhmm = (mins) => `${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
export function dayDate(trip, i) {
  const d = new Date(`${trip.start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
}
export const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();

export function money(c, what) {
  if (c == null) return null;
  if (!isObj(c) || !Number.isFinite(c.amount) || c.amount < 0 || c.amount > 1e6) throw bad(`${what} needs { amount, currency } with an amount from 0 to 1,000,000.`);
  const currency = String(c.currency || 'EUR').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw bad(`${what}: currency must be a 3-letter code.`);
  return { amount: Math.round(c.amount * 100) / 100, currency };
}

function cleanPlace(p) {
  if (!isObj(p)) throw bad('A stop needs a place: { id, name, lat, lng }.');
  const name = text(p.name, 120);
  if (!name) throw bad('A stop’s place needs a name.');
  const lat = Number(p.lat), lng = Number(p.lng);
  const hasPoint = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  return { id: p.id ? text(p.id, 300) : null, name, lat: hasPoint ? lat : null, lng: hasPoint ? lng : null };
}

export function cleanStop(s, newId) {
  if (!isObj(s)) throw bad('A stop must be an object.');
  if (!TIME.test(String(s.at))) throw bad('A stop’s time (at) must be HH:MM, 24-hour.');
  const minutes = s.minutes == null ? 60 : Number(s.minutes);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) throw bad('A stop’s minutes must be a whole number from 0 to 1440.');
  const mode = s.mode == null ? 'walk' : String(s.mode);
  if (!MODES.includes(mode)) throw bad(`mode must be one of ${MODES.join(', ')}.`);
  const id = s.id != null && STOP_ID.test(String(s.id)) ? String(s.id) : newId();
  const kind = s.kind == null ? 'visit' : String(s.kind);
  if (!KINDS.includes(kind)) throw bad(`kind must be one of ${KINDS.join(', ')}.`);
  const nights = s.nights == null ? null : Number(s.nights);
  if (nights !== null && (!Number.isInteger(nights) || nights < 1 || nights > 60)) throw bad('nights must be 1 to 60.');
  const booked = isObj(s.booked) ? cleanBooking(s.booked, kind) : null;
  return { id, kind, place: cleanPlace(s.place), at: s.at, minutes, mode, cost: money(s.cost, 'A stop’s cost'), nights: kind === 'stay' ? nights : null, link: cleanLink(s.link), booked, note: text(s.note, TRIP.note) };
}

// A provider's booking page: https only, no credentials in it.
export function cleanLink(v) {
  if (v == null || v === '') return null;
  let u;
  try { u = new URL(String(v)); } catch { throw bad('link must be a full https:// address.'); }
  if (u.protocol !== 'https:' || u.username || u.password || String(v).length > 500) throw bad('link must be an https:// address (no sign-in details in it), under 500 characters.');
  return u.toString();
}
export function cleanBooking(b, kind) {
  return { kind: text(b.kind, 20) || kind || 'booking', ref: text(b.ref, 80), provider: text(b.provider, 80), via: ['api', 'browser', 'link', 'person'].includes(b.via) ? b.via : 'person', at: Number.isFinite(b.at) ? b.at : null };
}

const sortDay = (day) => { day.stops.sort((a, b) => minutesOf(a.at) - minutesOf(b.at)); return day; };

export function cleanTrip(t, { newId, now }) {
  if (!isObj(t)) throw bad('trip must be an object.');
  const title = text(t.title, TRIP.title);
  if (!title) throw bad('A trip needs a title.');
  if (!DATE.test(String(t.start)) || Number.isNaN(Date.parse(`${t.start}T00:00:00Z`))) throw bad('start must be a date, YYYY-MM-DD.');
  const days = Array.isArray(t.days) ? t.days : [];
  if (days.length < 1 || days.length > TRIP.days) throw bad(`A trip has 1 to ${TRIP.days} days.`);
  const travelers = t.travelers == null ? 1 : Number(t.travelers);
  if (!Number.isInteger(travelers) || travelers < 1 || travelers > TRIP.travelers) throw bad(`travelers must be 1 to ${TRIP.travelers}.`);
  const seen = new Set();
  const trip = {
    title,
    destination: text(t.destination, 120),
    start: t.start,
    travelers,
    budget: money(t.budget, 'budget'),
    days: days.map((d, i) => {
      const stops = Array.isArray(d?.stops) ? d.stops : [];
      if (stops.length > TRIP.stops) throw bad(`Day ${i + 1} has more than ${TRIP.stops} stops.`);
      const day = { title: text(d?.title, TRIP.title) || `Day ${i + 1}`, stops: stops.map((s) => cleanStop(s, newId)) };
      for (const s of day.stops) {
        if (seen.has(s.id)) s.id = newId();
        seen.add(s.id);
      }
      return sortDay(day);
    }),
    rev: 1,
    created: now,
    updated: now,
  };
  return trip;
}

function find(trip, stopId) {
  for (let d = 0; d < trip.days.length; d++) {
    const i = trip.days[d].stops.findIndex((s) => s.id === stopId);
    if (i >= 0) return { d, i, stop: trip.days[d].stops[i] };
  }
  throw bad(`There is no stop ${stopId} in this trip.`);
}
const dayIndex = (trip, day) => {
  const d = Number(day);
  if (!Number.isInteger(d) || d < 0 || d >= trip.days.length) throw bad(`day must be 0 to ${trip.days.length - 1} (the first day is 0).`);
  return d;
};
const locked = (stop, what) => new TripError(`${stop.place.name} is booked, so Eden can’t ${what} it. Change the booking first.`, 409, 'locked');

// The trip after these ops, or a TripError; the trip passed in is never changed. Returns
// { trip, changed: { stopId: 'new' | 'moved' | 'removed' | 'edited' } } so a preview can mark them.
export function applyOps(trip, ops, { newId }) {
  if (!Array.isArray(ops) || ops.length < 1 || ops.length > TRIP.ops) throw bad(`ops must be a list of 1 to ${TRIP.ops} operations.`);
  const next = structuredClone(trip);
  const changed = {};
  const mark = (id, how) => { if (changed[id] !== 'new') changed[id] = how; };
  for (const o of ops) {
    if (!isObj(o)) throw bad('Each op must be an object.');
    switch (o.op) {
      case 'add': {
        const d = dayIndex(next, o.day);
        if (next.days[d].stops.length >= TRIP.stops) throw bad(`Day ${d + 1} already has ${TRIP.stops} stops.`);
        const stop = cleanStop({ ...o.stop, id: undefined, booked: undefined }, newId);
        next.days[d].stops.push(stop);
        changed[stop.id] = 'new';
        break;
      }
      case 'remove': {
        const { d, i, stop } = find(next, String(o.stop));
        if (stop.booked) throw locked(stop, 'remove');
        next.days[d].stops.splice(i, 1);
        changed[stop.id] = changed[stop.id] === 'new' ? undefined : 'removed';
        if (!changed[stop.id]) delete changed[stop.id];
        break;
      }
      case 'move': {
        const { d, i, stop } = find(next, String(o.stop));
        if (stop.booked) throw locked(stop, 'move');
        const to = dayIndex(next, o.day);
        if (to !== d && next.days[to].stops.length >= TRIP.stops) throw bad(`Day ${to + 1} already has ${TRIP.stops} stops.`);
        next.days[d].stops.splice(i, 1);
        if (o.at != null) {
          if (!TIME.test(String(o.at))) throw bad('at must be HH:MM, 24-hour.');
          stop.at = o.at;
        }
        next.days[to].stops.push(stop);
        mark(stop.id, 'moved');
        break;
      }
      case 'time': {
        const { stop } = find(next, String(o.stop));
        if (stop.booked) throw locked(stop, 'retime');
        if (!TIME.test(String(o.at))) throw bad('at must be HH:MM, 24-hour.');
        stop.at = o.at;
        mark(stop.id, 'moved');
        break;
      }
      case 'edit': {
        const { stop } = find(next, String(o.stop));
        const fields = ['minutes', 'mode', 'cost', 'kind', 'nights', 'link'].filter((f) => o[f] !== undefined);
        if (stop.booked && fields.length) throw locked(stop, 'change');
        const merged = cleanStop({ ...stop, ...Object.fromEntries(fields.map((f) => [f, o[f]])), note: o.note ?? stop.note }, newId);
        Object.assign(stop, { kind: merged.kind, minutes: merged.minutes, mode: merged.mode, cost: merged.cost, nights: merged.nights, link: merged.link, note: merged.note });
        mark(stop.id, 'edited');
        break;
      }
      case 'title': {
        const d = dayIndex(next, o.day);
        next.days[d].title = text(o.title, TRIP.title) || next.days[d].title;
        break;
      }
      default:
        throw bad('op must be add, remove, move, time, edit or title.');
    }
  }
  next.days.forEach(sortDay);
  return { trip: next, changed };
}
