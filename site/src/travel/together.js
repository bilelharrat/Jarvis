// Planning together, the live part: who else has the trip open right now and on which day and view ("Sam · Day 2"),
// who on the trip looks after a stop (trips.js `owner`, set with the edit op { op: 'owner', stop, owner }), and a copy
// of a trip, the organiser's own or one shared with you, as a new trip of your own.
//
// Where it lives (the organiser's object): tpres:<trip>:<account> → { id, day, view, at }, a beat from the page every
// ~20 s while it's on screen; a beat older than PRESENCE.ms is dropped when the list is read (no alarm). Someone taken
// off the trip disappears at once (only the trip's people are listed).
//
//   organiser (trip ops, signed in): trip-presence-beat { id, day, view } → { present, people, me, beat_s }
//                                    trip-copy { id, start? } → { trip, checks, removed, note }
//   member (Worker, signed in):      shared-presence-beat { owner, trip, day, view } · shared-copy { owner, trip, start? }
//   organiser's object, from the Worker: tmember-presence-beat { trip, member, day, view } · tmember-copy { trip, member, start? }
//
// A copy keeps the days and stops; it leaves out what belongs to the first trip's bookings: each booked stop comes over
// unbooked, without its cost (what was paid) and without its note (where the reference and the email it came from are),
// and nobody is in charge of a stop (the new trip has its own people). Expenses, chat, documents and photos stay put.

import { ApiError } from '../accounts/util.js';
import { ask } from './track.js';
import { peopleOf } from './money.js';

export const PRESENCE = { ms: 60_000, beat_s: 20 };
const TRIP_ID = /^[0-9a-f]{16}$/;
const ACCOUNT = /^[0-9a-f-]{36}$/;
const VIEW = /^[a-z-]{1,20}$/;

/** The ids of everyone on the trip, for applyOps' owner op (trips.js). */
export async function tripPeople(account, id) {
  return new Set((await peopleOf(account, id)).map((p) => p.id));
}

async function beat(account, id, who, body) {
  const trip = await account.storage.get(`trip:${id}`);
  if (!trip) throw new ApiError(404, 'not_found', 'There is no such trip.');
  const now = account.now();
  const d = Number(body.day);
  const day = Number.isInteger(d) && d >= 0 && d < trip.days.length ? d : null;
  const view = VIEW.test(String(body.view || '')) ? String(body.view) : null;
  await account.storage.put(`tpres:${id}:${who}`, { id: who, day, view, at: now });
  const people = await peopleOf(account, id);
  const byId = new Map(people.map((p) => [p.id, p]));
  const present = [], stale = [];
  for (const [k, x] of await account.storage.list({ prefix: `tpres:${id}:` })) {
    if (now - x.at > PRESENCE.ms || !byId.has(x.id)) { stale.push(k); continue; }
    present.push({ id: x.id, name: byId.get(x.id).name, day: x.day, view: x.view, at: x.at, me: x.id === who });
  }
  if (stale.length) await account.storage.delete(stale);
  present.sort((a, b) => Number(b.me) - Number(a.me) || a.name.localeCompare(b.name));
  // `people`: names for the stops' owners (a member's page has no other way to them); `me`: for the "Mine" filter
  return { present, people: people.map((p) => ({ id: p.id, name: p.name, kind: p.kind })), me: who, beat_s: PRESENCE.beat_s };
}

/** The trip as a new one: same days and stops, without the bookings' state, costs and notes (see the top). */
export function copyOf(trip, { start } = {}) {
  const removed = { bookings: 0, costs: 0, notes: 0 };
  const days = trip.days.map((d) => ({
    title: d.title,
    stops: d.stops.map((s) => {
      const c = { ...s, place: { ...s.place }, owner: null };
      if (s.booked) {
        removed.bookings++;
        if (s.cost) { removed.costs++; c.cost = null; }
        if (s.note) { removed.notes++; c.note = ''; }
        c.booked = null;
      }
      return c;
    }),
  }));
  const parts = [removed.costs ? `${removed.costs} cost${removed.costs === 1 ? '' : 's'} paid` : null, removed.notes ? `${removed.notes} note${removed.notes === 1 ? '' : 's'}` : null].filter(Boolean);
  const note = removed.bookings
    ? `Copied without its ${removed.bookings} booking${removed.bookings === 1 ? '' : 's'}${parts.length ? ` (and their ${parts.join(' and ')})` : ''}: those stops are in the copy, not booked. Expenses, chat and documents stay with the first trip.`
    : 'Copied. Expenses, chat and documents stay with the first trip.';
  const copy = { title: `${trip.title} (copy)`.slice(0, 120), destination: trip.destination, start: start ? String(start) : trip.start, travelers: trip.travelers, budget: trip.budget, access: trip.access, days };
  return { trip: copy, removed, note };
}

/** The organiser's own ops (ops.js): trip-presence-beat, trip-copy. */
export async function togetherOp(account, op, body, { tripOp }) {
  const id = String(body.id || '');
  if (!TRIP_ID.test(id)) throw new ApiError(400, 'bad_request', 'id must be a trip id.');
  if (op === 'trip-presence-beat') return beat(account, id, ((await account.storage.get('account')) || {}).id, body);
  if (op === 'trip-copy') {
    const trip = await account.storage.get(`trip:${id}`);
    if (!trip) throw new ApiError(404, 'not_found', 'There is no such trip.');
    const { trip: copy, removed, note } = copyOf(trip, { start: body.start });
    return { ...(await tripOp(account, 'trip-create', { trip: copy })), removed, note };
  }
  throw new ApiError(404, 'not_found', 'Not found');
}

/** The organiser's object, asked by the Worker for a member (account.js tmember-*). */
export async function togetherMemberOp(account, op, body) {
  const trip = String(body.trip || ''), member = String(body.member || '');
  if (!TRIP_ID.test(trip) || !ACCOUNT.test(member) || !(await account.storage.get(`tmem:${trip}:${member}`))) throw new ApiError(404, 'not_found', 'You’re not on this trip any more.');
  if (op === 'tmember-presence-beat') return beat(account, trip, member, body);
  if (op === 'tmember-copy') {
    const t = await account.storage.get(`trip:${trip}`);
    if (!t) throw new ApiError(404, 'not_found', 'This trip was deleted.');
    return copyOf(t, { start: body.start });
  }
  throw new ApiError(404, 'not_found', 'Not found');
}

/** The member's actions (travel/api.js): `ask` reaches the organiser's object, `call` the member's own. */
export async function togetherApi(env, who, action, args, { call, ask: askFn = ask }) {
  const owner = String(args.owner || '');
  if (action === 'shared-presence-beat') return askFn(env, owner, 'tmember-presence-beat', { trip: args.trip, member: who.account, day: args.day, view: args.view });
  if (action === 'shared-copy') {
    // read through the organiser's object (only while they're on it), made in the member's own account (their Plus, their limits)
    const { trip, removed, note } = await askFn(env, owner, 'tmember-copy', { trip: args.trip, member: who.account, start: args.start });
    return { ...(await call(env, who.account, 'trip-create', { trip }, who.token)), removed, note };
  }
  throw new ApiError(400, 'bad_request', 'Unknown shared-trip action.');
}
