// Eden Travel's trips in the account's own object (accounts/account.js hands `trip-*` ops here,
// signed in; a delegate's grant can't reach them). Ask Eden proposes, the person applies.
//
// Stored: trip:<id> → the trip · tprop:<id> → its pending proposal (one at a time; a new one
// replaces it) · thist:<id> → earlier versions for Undo (TRIP_HISTORY) · tcache:<key> → a maps
// answer until it expires (checks.js CACHE).
//
// trip-list {}                                → { trips: [summary], maps }
// trip-get { id }                             → { trip, checks, proposal }
// trip-create { trip }                        → { trip, checks }
// trip-sample {}                              → { trip, checks }  (three days in Lisbon on stand-in places)
// trip-update { id, title?, travelers?, budget? } → { trip, checks }
// trip-delete { id }                          → { deleted: true }
// trip-edit { id, ops, rev }                  → { trip, checks, changed }  (the person's own change: at once, undoable)
// trip-propose { id, ops, title, reason, by } → { proposal, preview }      (nothing changes)
// trip-apply { id, proposal, confirm: true }  → { trip, checks, changed }
// trip-discard { id, proposal }               → { discarded: true }
// trip-undo { id }                            → { trip, checks }
// trip-places { text, near? }                 → { places, maps }          (to add a stop)
// trip-mark-booked { id, stop, ref, provider, via, cost?, confirm: true } → { trip, checks }  (the person says it's booked)
// trip-unbook { id, stop, confirm: true }     → { trip, checks }          (a booking the person cancelled)
// trip-cards {}                               → { cards: [{ name, known, card? }], known: [the cards Eden has checked rates for] }
// trip-cards-match { names }                  → { cards }                  (nothing saved: for the card that asks)
// trip-cards-save { names, confirm: true }    → { cards }                  (the person's card names: names only)
// trip-get also returns `rewards` (cards.js tripRewards) once cards are saved.

import { checkTrip, compareChecks } from './checks.js';
import { CARDS, cleanCardNames, matchCard, tripRewards } from './cards.js';
import { mapsFor } from './maps.js';
import { TRIP, TripError, applyOps, cleanBooking, cleanTrip, money } from './trips.js';

export const TRIP_HISTORY = 20;
export const PROPOSAL_MS = 24 * 3600_000;
const TRIP_ID = /^[0-9a-f]{16}$/;
const PROP_ID = /^[0-9a-f]{12}$/;
const hex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function cacheIn(storage, now) {
  return {
    async get(key) {
      const hit = await storage.get(`tcache:${key}`);
      if (!hit) return undefined;
      if (hit.until > now()) return hit.v;
      await storage.delete(`tcache:${key}`);
      return undefined;
    },
    async put(key, v, ms) {
      await storage.put(`tcache:${key}`, { v, until: now() + ms });
    },
  };
}

const summary = (id, t) => ({ id, title: t.title, destination: t.destination, start: t.start, days: t.days.length, travelers: t.travelers, rev: t.rev, updated: t.updated });

// The account object's side. `deps` lets tests hand in a fake fetch for Google.
export async function tripOp(account, op, body = {}, deps = {}) {
  const now = () => account.now();
  const storage = account.storage;
  const maps = deps.maps || mapsFor(account.env, { fetch: deps.fetch, now });
  const cache = cacheIn(storage, now);
  const check = (trip) => checkTrip(trip, maps, { cache, now });
  const newId = () => `s-${hex(4)}`;

  const load = async () => {
    const id = String(body.id || '');
    if (!TRIP_ID.test(id)) throw new TripError('id must be a trip id.');
    const trip = await storage.get(`trip:${id}`);
    if (!trip) throw new TripError('There is no such trip.', 404, 'not_found');
    return { id, trip };
  };
  const save = async (id, before, after) => {
    const hist = (await storage.get(`thist:${id}`)) || [];
    hist.push(before);
    after.rev = before.rev + 1;
    after.updated = now();
    await storage.put({ [`trip:${id}`]: after, [`thist:${id}`]: hist.slice(-TRIP_HISTORY) });
    await storage.delete(`tprop:${id}`); // a proposal made against the old trip no longer fits
    return after;
  };
  const create = async (t) => {
    const all = await storage.list({ prefix: 'trip:' });
    if (all.size >= TRIP.max) throw new TripError(`An account keeps at most ${TRIP.max} trips. Delete one first.`, 409, 'too_many');
    const id = hex(8);
    const trip = cleanTrip(t, { newId, now: now() });
    await storage.put(`trip:${id}`, trip);
    return { trip: { id, ...trip }, checks: await check(trip) };
  };

  switch (op) {
    case 'trip-list': {
      const trips = [...(await storage.list({ prefix: 'trip:' }))].map(([k, t]) => summary(k.slice(5), t));
      trips.sort((a, b) => b.updated - a.updated);
      return { trips, maps: maps.mode, limits: { trips: TRIP.max, days: TRIP.days, stops: TRIP.stops } };
    }
    case 'trip-get': {
      const { id, trip } = await load();
      const prop = await storage.get(`tprop:${id}`);
      const live = prop && prop.base_rev === trip.rev && now() - prop.created < PROPOSAL_MS;
      return { trip: { id, ...trip }, checks: await check(trip), proposal: live ? prop : null, rewards: tripRewards(trip, (await storage.get('tcards')) || [], now()) };
    }
    case 'trip-create':
      return await create(body.trip);
    case 'trip-sample':
      return await create(sampleTrip(now()));
    case 'trip-update': {
      const { id, trip } = await load();
      const merged = cleanTrip({ ...trip, title: body.title ?? trip.title, travelers: body.travelers ?? trip.travelers, budget: body.budget === undefined ? trip.budget : body.budget }, { newId, now: trip.created });
      merged.days = trip.days; // stops keep their ids
      const after = await save(id, trip, { ...merged, created: trip.created });
      return { trip: { id, ...after }, checks: await check(after) };
    }
    case 'trip-delete': {
      const { id } = await load();
      await storage.delete([`trip:${id}`, `thist:${id}`, `tprop:${id}`]);
      return { deleted: true };
    }
    case 'trip-edit': {
      const { id, trip } = await load();
      if (body.rev !== undefined && body.rev !== trip.rev) throw new TripError('This trip changed on another device. Reload it and try again.', 409, 'stale');
      const { trip: after, changed } = applyOps(trip, body.ops, { newId });
      const saved = await save(id, trip, after);
      return { trip: { id, ...saved }, checks: await check(saved), changed };
    }
    case 'trip-propose': {
      const { id, trip } = await load();
      const { trip: after, changed } = applyOps(trip, body.ops, { newId });
      const [before, checks] = await Promise.all([check(trip), check(after)]);
      const proposal = {
        id: hex(6),
        title: String(body.title || 'Proposed change').replace(/\s+/g, ' ').trim().slice(0, 120),
        reason: String(body.reason || '').replace(/\s+/g, ' ').trim().slice(0, 600),
        by: body.by === 'eden' ? 'eden' : 'person',
        base_rev: trip.rev,
        ops: body.ops,
        created: now(),
      };
      // The preview is kept with it, so Apply writes exactly what was shown (new stops keep their ids).
      await storage.put(`tprop:${id}`, { ...proposal, after });
      return { proposal, preview: { trip: { id, ...after }, changed, changes: changeList(trip, after, changed), checks, diff: compareChecks(before, checks), maps: maps.mode } };
    }
    case 'trip-apply': {
      if (body.confirm !== true) throw new TripError('apply needs confirm: true (the person tapped Apply).');
      const { id, trip } = await load();
      const prop = await storage.get(`tprop:${id}`);
      if (!prop || !PROP_ID.test(String(body.proposal)) || prop.id !== body.proposal) throw new TripError('That proposal is gone. Ask Eden again.', 409, 'gone');
      if (prop.base_rev !== trip.rev) throw new TripError('The trip changed after Eden proposed this. Ask Eden again.', 409, 'stale');
      if (now() - prop.created > PROPOSAL_MS) throw new TripError('That proposal is more than a day old. Ask Eden again.', 409, 'gone');
      const { changed } = applyOps(trip, prop.ops, { newId }); // the rules again, on today's trip (a booking may have locked a stop)
      const saved = await save(id, trip, prop.after);
      return { trip: { id, ...saved }, checks: await check(saved), changed };
    }
    case 'trip-discard': {
      const { id } = await load();
      const prop = await storage.get(`tprop:${id}`);
      if (prop && prop.id === body.proposal) await storage.delete(`tprop:${id}`);
      return { discarded: true };
    }
    case 'trip-undo': {
      const { id, trip } = await load();
      const hist = (await storage.get(`thist:${id}`)) || [];
      const prev = hist.pop();
      if (!prev) throw new TripError('Nothing to undo.', 409, 'nothing');
      // Undo never unbooks: a stop booked since stays in the trip.
      const booked = trip.days.flatMap((d, i) => d.stops.filter((s) => s.booked).map((s) => ({ s, i })));
      for (const { s, i } of booked) {
        const where = prev.days.flatMap((d) => d.stops).find((x) => x.id === s.id);
        if (where) Object.assign(where, s);
        else prev.days[Math.min(i, prev.days.length - 1)].stops.push(s);
      }
      prev.rev = trip.rev + 1;
      prev.updated = now();
      await storage.put({ [`trip:${id}`]: prev, [`thist:${id}`]: hist });
      await storage.delete(`tprop:${id}`);
      return { trip: { id, ...prev }, checks: await check(prev) };
    }
    case 'trip-mark-booked':
    case 'trip-unbook': {
      if (body.confirm !== true) throw new TripError(`${op === 'trip-unbook' ? 'unbook' : 'mark-booked'} needs confirm: true (the person confirmed it).`);
      const { id, trip } = await load();
      const after = structuredClone(trip);
      const stop = after.days.flatMap((d) => d.stops).find((s) => s.id === String(body.stop || ''));
      if (!stop) throw new TripError('There is no such stop in this trip.', 404, 'not_found');
      if (op === 'trip-unbook') stop.booked = null;
      else {
        if (!String(body.ref || '').trim()) throw new TripError('ref: the booking reference from the confirmation.');
        stop.booked = cleanBooking({ kind: stop.kind, ref: body.ref, provider: body.provider, via: body.via, at: now() }, stop.kind);
        if (body.cost !== undefined) stop.cost = money(body.cost, 'cost');
      }
      const saved = await save(id, trip, after);
      return { trip: { id, ...saved }, checks: await check(saved) };
    }
    case 'trip-cards':
    case 'trip-cards-match':
    case 'trip-cards-save': {
      const named = (list) => list.map((name) => { const c = matchCard(name); return c ? { name, known: true, card: c.id, matched: c.name, checked: c.checked, source: c.source } : { name, known: false }; });
      if (op === 'trip-cards') return { cards: named((await storage.get('tcards')) || []), known: CARDS.map((c) => ({ name: c.name, issuer: c.issuer, checked: c.checked })) };
      const names = cleanCardNames(body.names);
      if (op === 'trip-cards-save') {
        if (body.confirm !== true) throw new TripError('cards-save needs confirm: true (the person confirmed the list).');
        await storage.put('tcards', names);
      }
      return { cards: named(names) };
    }
    case 'trip-places': {
      const q = String(body.text || '').trim();
      if (q.length < 2) throw new TripError('text: what to look for.');
      const near = isObj(body.near) ? { lat: Number(body.near.lat), lng: Number(body.near.lng) } : {};
      return { places: await maps.search(q, near), maps: maps.mode };
    }
    default:
      throw new TripError('Unknown trip op.', 404, 'not_found');
  }
}

// Each changed stop by name, where it was and where it goes (a removed stop is only in `before`),
// in day order, so a card can say "Moved: National Tile Museum, Day 3 11:00 → Day 2 17:30".
export function changeList(before, after, changed) {
  const where = (trip) => {
    const m = new Map();
    trip.days.forEach((d, day) => d.stops.forEach((s) => m.set(s.id, { day, at: s.at, name: s.place.name })));
    return m;
  };
  const was = where(before), now = where(after);
  return Object.entries(changed)
    .map(([stop, how]) => {
      const a = was.get(stop), b = now.get(stop);
      return { stop, how, name: (b || a).name, ...(b ? { day: b.day, at: b.at } : {}), ...(a && how !== 'new' ? { was: { day: a.day, at: a.at } } : {}) };
    })
    .sort((x, y) => (x.day ?? x.was.day) - (y.day ?? y.was.day) || String(x.at ?? x.was.at).localeCompare(String(y.at ?? y.was.at)));
}

// Three days in Lisbon on stand-in places: the mockup's trip, for the beta's first look.
export function sampleTrip(now) {
  const d = new Date(now + 30 * 86400_000);
  while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() + 1); // a Saturday, so Day 3 is a Monday
  const s = (id, name, at, minutes, mode, cost, lat, lng, more = {}) => ({ place: { id, name, lat, lng }, at, minutes, mode, cost: cost == null ? null : { amount: cost, currency: 'EUR' }, ...more });
  return {
    title: 'Three days in Lisbon',
    destination: 'Lisbon, Portugal',
    start: d.toISOString().slice(0, 10),
    travelers: 2,
    budget: { amount: 900, currency: 'EUR' },
    days: [
      { title: 'Arrival and old town', stops: [
        s('standin:lis-airport', 'Arrive in Lisbon', '10:30', 30, 'taxi', null, 38.7742, -9.1342, { kind: 'transport' }),
        s('standin:baixa-hotel', 'Your hotel in Baixa', '11:30', 60, 'taxi', null, 38.7118, -9.1384, { kind: 'stay', nights: 2 }),
        s('standin:alfama', 'Lunch in Alfama', '13:00', 90, 'walk', 24, 38.711, -9.13, { kind: 'meal' }),
        s('standin:graca', 'Miradouro da Graça', '16:00', 60, 'walk', null, 38.7163, -9.1309),
        s('standin:chiado', 'Dinner in Chiado', '19:30', 120, 'transit', 50, 38.7107, -9.1422, { kind: 'meal' }),
      ] },
      { title: 'Belém and the river', stops: [
        s('standin:principe-real', 'Coffee in Príncipe Real', '09:00', 45, 'walk', 8, 38.7167, -9.1484),
        s('standin:jeronimos', 'Jerónimos Monastery', '10:30', 90, 'transit', null, 38.6979, -9.2068),
        s('standin:pasteis-belem', 'Lunch in Belém', '13:00', 60, 'walk', 24, 38.6975, -9.2032, { kind: 'meal' }),
        s('standin:lx-factory', 'LX Factory', '15:30', 120, 'transit', 20, 38.7034, -9.1785),
        s('standin:time-out-market', 'Dinner at Time Out Market', '19:30', 90, 'transit', 40, 38.7071, -9.1458, { kind: 'meal' }),
      ] },
      { title: 'Tiles and goodbye', stops: [
        s('standin:chiado-cafe', 'Coffee and a pastel de nata', '09:30', 30, 'walk', 6, 38.7105, -9.141),
        s('standin:tiles', 'National Tile Museum', '11:00', 90, 'taxi', null, 38.7247, -9.1135),
        s('standin:chiado', 'Lunch in Chiado', '13:30', 60, 'taxi', 30, 38.7107, -9.1422, { kind: 'meal' }),
        s('standin:lis-airport', 'Head to the airport', '15:30', 0, 'taxi', null, 38.7742, -9.1342, { kind: 'transport' }),
      ] },
    ],
  };
}
