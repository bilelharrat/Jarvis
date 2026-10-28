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
// trip-flight { ident, date }                → { flight }                 (live status from FlightAware, cached 2 minutes)
// trip-flight-live { ident, date }           → { flight, from, to, position, refresh_s }  (for the in-flight map; position at most every 5 minutes)
// trip-mail-scan { id }                      → { candidates, scanned }    (bookings found in Eden Mail; nothing changes)
// trip-mail-preview { id, message, index }    → { candidate }              (one email again, for the card)
// trip-mail-import { id, message, index, stop?, confirm: true } → { trip, checks, stop }  (read again here, then added or marked booked)
// trip-share-create { ident, date, first_name, trip?, stop? } → { code, url, expires }  (a guest tracking link: track.js)
// trip-shares {} → { shares }   trip-share-revoke { code } → { revoked }
// trip-hero { q }                             → { hero }                   (the destination's licensed Commons photo or null: hero.js, kept 30 days)
// trip-get also returns `rewards` (cards.js tripRewards) once cards are saved.

import { checkTrip, compareChecks } from './checks.js';
import { CARDS, cleanCardNames, matchCard, tripRewards } from './cards.js';
import { AIRPORT_MS, CACHE_MS as FLIGHT_CACHE_MS, FlightError, POSITION_MS, cleanIdent, flightAwareFor } from './flightaware.js';
import { MAIL_QUERY, SCAN_LIMIT, bookingsIn, matchBooking, messageParts } from './confirmations.js';
import { distanceKm, mapsFor } from './maps.js';
import { shareCreate, shareList, shareRevoke } from './track.js';
import { linkCreate, linkList, linkRevoke } from './triplink.js';
import { priceDrops, stayOp } from './stayops.js';
import { extraOp } from './extraops.js';
import { HERO, HeroError, heroFor } from './hero.js';
import { inviteCreate, inviteRevoke, joinedOp, memberRemove, membersOf } from './members.js';
import { TRIP, TripError, applyOps, cleanBooking, cleanStop, cleanTrip, money } from './trips.js';

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
  const create = async (t, { find = false } = {}) => {
    const all = await storage.list({ prefix: 'trip:' });
    if (all.size >= TRIP.max) throw new TripError(`An account keeps at most ${TRIP.max} trips. Delete one first.`, 409, 'too_many');
    const id = hex(8);
    if (find) await locate(t, maps);
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
      return { trip: { id, ...trip }, checks: await check(trip), proposal: live ? prop : null, rewards: tripRewards(trip, (await storage.get('tcards')) || [], now()), price_drops: await priceDrops(account, id) };
    }
    case 'trip-read': { // the trip alone, no checks run (each check can be a paid lookup): for the calendar files
      const { id, trip } = await load();
      return { trip: { id, ...trip } };
    }
    case 'trip-create':
      return await create(body.trip, { find: true });
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
      await storage.delete([`trip:${id}`, `thist:${id}`, `tprop:${id}`, `tz:${id}`]); // its time zone, kept for Google Calendar (calsync.js)
      // its members, and anyone taken off it (members.js): the trip is gone for them too
      const theirs = [...(await storage.list({ prefix: `tmem:${id}:` })).keys(), ...(await storage.list({ prefix: `tban:${id}:` })).keys()];
      if (theirs.length) await storage.delete(theirs);
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
      // one proposal waits at a time: a suggestion from someone on the trip never replaces Eden's or the organiser's own
      if (body.by === 'member') {
        const waiting = await storage.get(`tprop:${id}`);
        if (waiting && waiting.by !== 'member' && waiting.base_rev === trip.rev && now() - waiting.created < PROPOSAL_MS) throw new TripError('The organiser has another change waiting. Suggest yours once they’ve decided on it.', 409, 'busy');
      }
      const { trip: after, changed } = applyOps(trip, body.ops, { newId });
      const [before, checks] = await Promise.all([check(trip), check(after)]);
      const proposal = {
        id: hex(6),
        title: String(body.title || 'Proposed change').replace(/\s+/g, ' ').trim().slice(0, 120),
        reason: String(body.reason || '').replace(/\s+/g, ' ').trim().slice(0, 600),
        by: body.by === 'eden' ? 'eden' : body.by === 'member' ? 'member' : 'person',
        ...(body.by === 'member' ? { by_name: String(body.by_name || '').slice(0, 40) } : {}), // a suggestion from someone on the trip (members.js)
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
    case 'trip-flight':
    case 'trip-flight-live': {
      const fa = deps.flightaware !== undefined ? deps.flightaware : flightAwareFor(account.env, { fetch: deps.fetch, now });
      if (!fa) throw new TripError('Live flight status isn’t switched on yet (FlightAware).', 404, 'not_set_up');
      const cached = async (key, ms, get) => {
        const hit = await cache.get(key);
        if (hit !== undefined) return hit;
        const v = await get();
        await cache.put(key, v, ms);
        return v;
      };
      try {
        const flight = await cached(`f:${cleanIdent(body.ident)}:${body.date}`, FLIGHT_CACHE_MS, () => fa.track(body.ident, body.date));
        if (op === 'trip-flight') return { flight };
        const point = (a) => (a && a.code ? cached(`ap2:${a.code}`, AIRPORT_MS, () => fa.airport(a.code)).catch(() => null) : null);
        const [from, to] = await Promise.all([point(flight.origin), point(flight.destination)]);
        const flying = flight.state === 'in_air' || flight.state === 'delayed' || flight.state === 'diverted';
        const position = flying && flight.fa_flight_id ? await cached(`fp:${flight.fa_flight_id}`, POSITION_MS, () => fa.position(flight.fa_flight_id)).catch(() => null) : null;
        return { flight, from, to, position, refresh_s: flight.state === 'landed' || flight.state === 'cancelled' ? null : POSITION_MS / 1000 };
      } catch (e) {
        if (e instanceof FlightError) throw new TripError(e.message, e.code === 'not_found' ? 404 : e.code.startsWith('bad') ? 400 : 503, e.code);
        throw e;
      }
    }
    case 'trip-mail-scan':
    case 'trip-mail-preview':
    case 'trip-mail-import': {
      const { id, trip } = await load();
      const mail = deps.mail || (await mailIn(account, body.local === true, body.demo_mail === true, trip));
      const candidate = async (messageId, index = null) => {
        const parts = messageParts(await mail.full(messageId));
        return bookingsIn(parts).map((b, i) => ({ message: messageId, index: i, subject: parts.subject, from: parts.from, received: parts.date, booking: b, match: matchBooking(trip, b) })).filter((c) => index === null || c.index === index);
      };
      if (op === 'trip-mail-scan') {
        const ids = (await mail.search(MAIL_QUERY, SCAN_LIMIT)).slice(0, SCAN_LIMIT);
        const all = [];
        for (const m of ids) { try { all.push(...(await candidate(m))); } catch { /* one unreadable email doesn't stop the scan */ } }
        const inTrip = all.filter((c) => c.match.action !== 'none' || !c.booking.date);
        return { candidates: inTrip.slice(0, 20), scanned: ids.length };
      }
      const msg = String(body.message || '');
      const [c] = await candidate(msg, Number(body.index) || 0);
      if (!c) throw new TripError('That email has no booking Eden can read.', 404, 'not_found');
      if (op === 'trip-mail-preview') return { candidate: c };
      if (body.confirm !== true) throw new TripError('mail-import needs confirm: true (the person pressed the button).');
      const b = c.booking;
      if (!b.ref) throw new TripError('That email has no booking reference, so it can’t mark anything booked.');
      const after = structuredClone(trip);
      const booked = cleanBooking({ kind: b.kind, ref: b.ref, provider: b.provider, via: 'mail', at: now() }, b.kind);
      const match = body.stop ? { action: 'mark', stop: String(body.stop) } : c.match;
      let stopId;
      if (match.action === 'mark') {
        const stop = after.days.flatMap((d) => d.stops).find((x) => x.id === match.stop);
        if (!stop) throw new TripError('There is no such stop in this trip.', 404, 'not_found');
        stop.booked = { ...booked, kind: stop.kind || booked.kind };
        if (b.cost) stop.cost = money(b.cost, 'cost');
        stopId = stop.id;
      } else if (match.action === 'add') {
        if (after.days[match.day].stops.length >= TRIP.stops) throw new TripError(`Day ${match.day + 1} already has ${TRIP.stops} stops.`);
        const minutes = b.start && b.end && b.kind !== 'stay' ? Math.min(1440, Math.max(0, Math.round((Date.parse(b.end) - Date.parse(b.start)) / 60_000))) : 60;
        const stop = cleanStop({ kind: b.kind || 'activity', place: { name: (b.place && b.place.name) || b.title || 'Booking', ...(b.place && Number.isFinite(b.place.lat) ? { lat: b.place.lat, lng: b.place.lng } : {}) }, at: match.at, minutes: Number.isFinite(minutes) ? minutes : 60, mode: 'taxi', cost: b.cost, nights: b.kind === 'stay' ? b.nights : null, note: `From Eden Mail: ${c.subject}`.slice(0, 300), booked }, newId);
        after.days[match.day].stops.push(stop);
        after.days[match.day].stops.sort((x, y) => x.at.localeCompare(y.at));
        stopId = stop.id;
      } else throw new TripError(match.why || 'Say which stop this booking is for.', 409, 'no_match');
      const saved = await save(id, trip, after);
      return { trip: { id, ...saved }, checks: await check(saved), stop: stopId };
    }
    case 'trip-share-create': return await shareCreate(account, body, { tripOp: (a, o, b) => tripOp(a, o, b, deps) });
    case 'trip-shares': return await shareList(account);
    case 'trip-share-revoke': return await shareRevoke(account, body);
    // the trip shared with the people on it (triplink.js): a read-only page, always the trip as it is now
    case 'trip-link-create': return await linkCreate(account, body);
    case 'trip-links': return await linkList(account, body);
    case 'trip-link-revoke': return await linkRevoke(account, body);
    // hotels through Duffel Stays, and the price watch on what was booked (stayops.js)
    case 'trip-stays-search': case 'trip-stays-rates': case 'trip-stays-quote': case 'trip-stays-book': case 'trip-stays-cancel':
      return await stayOp(account, op, body, { ...deps, tripOp: (a, o, b) => tripOp(a, o, b, deps) });
    // ferries, trains and buses, car hire; each day's weather; the official entry advice (extraops.js)
    // planning together (members.js): the organiser's invites and members, and a member's own list of shared trips
    case 'trip-invite-create': return await inviteCreate(account, body);
    case 'trip-members': return await membersOf(account, body);
    case 'trip-member-remove': return await memberRemove(account, body);
    case 'trip-invite-revoke': return await inviteRevoke(account, body);
    case 'trip-joined': case 'trip-joined-list': case 'trip-joined-drop': return await joinedOp(account, op, body);
    case 'trip-ground-search': case 'trip-ground-stations': case 'trip-weather': case 'trip-entry': case 'trip-rail-check': case 'trip-rail-book':
      return await extraOp(account, op, body, { cache, fetch: deps.fetch, tripOp: (a, o, b) => tripOp(a, o, b, deps) });
    case 'trip-hero': {
      const q = String(body.q || '').replace(/\s+/g, ' ').trim().slice(0, 100);
      if (q.length < 2) throw new TripError('q: the destination.');
      const key = `hero2:${q.toLowerCase()}`; // hero2: thumb.wikimedia.org links (2026) read right
      const hit = await cache.get(key);
      if (hit) return hit;
      let hero;
      try { hero = await heroFor(account.env, q, { fetch: deps.fetch, now }); } catch (e) { if (e instanceof HeroError) throw new TripError(e.message, 503, e.code); throw e; }
      const out = { hero };
      // a found photo kept 30 days; "none" a day (Wikipedia's lead image may change); a failed lookup isn't kept
      await cache.put(key, out, hero ? HERO.cacheMs : 86400_000);
      return out;
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
// A new trip's stops that are named but not on the map (Ask Eden plans a whole trip in one card, naming real places):
// each looked up near the trip's destination, so its hours and travel times are checked like any other. A stop whose
// name finds nothing near there stays as it was (and its badge says it isn't on the map). Getting-there stops (a
// flight, a train) are not places to look up.
export const LOCATE = { max: 30, km: 80 };
export async function locate(t, maps) {
  if (!isObj(t) || !Array.isArray(t.days)) return t;
  const dest = String(t.destination || '').trim().slice(0, 80);
  const first = dest ? (await maps.search(dest).catch(() => []))[0] : null;
  const center = first && Number.isFinite(first.lat) ? { lat: first.lat, lng: first.lng } : null;
  const todo = [];
  for (const day of t.days) for (const s of isObj(day) && Array.isArray(day.stops) ? day.stops : []) {
    const p = isObj(s) ? s.place : null;
    if (!isObj(p) || p.id || (Number.isFinite(Number(p.lat)) && p.lat !== null && Number.isFinite(Number(p.lng)) && p.lng !== null)) continue;
    const name = String(p.name || '').trim();
    if (!name || s.kind === 'transport' || todo.length >= LOCATE.max) continue;
    todo.push({ s, q: dest && !name.toLowerCase().includes(dest.toLowerCase()) ? `${name}, ${dest}` : name });
  }
  await Promise.all(todo.map(async ({ s, q }) => {
    const hit = (await maps.search(q, center || {}).catch(() => [])).find((h) => Number.isFinite(h.lat) && (!center || distanceKm(h, center) < LOCATE.km));
    if (hit) s.place = { id: hit.id, name: hit.name, lat: hit.lat, lng: hit.lng };
  }));
  return t;
}

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

// Eden Mail as the trip ops read it: search ids, and one message in full.
async function mailIn(account, local, demoMail = false, trip = null) {
  const { googleInAccount, gmailScopesOk } = await import('../accounts/schedule.js');
  let google;
  try { google = await googleInAccount(account, { local }); } catch {
    if (local && demoMail && trip) return sampleMailBox(trip);
    throw new TripError('Connect Gmail in Eden Mail first, so Eden can read your confirmations.', 409, 'not_connected');
  }
  if (!gmailScopesOk(google.scopes)) {
    if (local && demoMail && trip) return sampleMailBox(trip);
    throw new TripError('Eden Mail can’t read your mail yet: connect Gmail in Mail.', 409, 'not_connected');
  }
  const api = google.gmail();
  return {
    async search(query, limit) { const r = await api.search({ query, limit }); return (r.messages || r || []).map((m) => m.id).filter(Boolean); },
    full: (id) => google.gmailMessage(id),
  };
}

function sampleMailBox(trip) {
  const d0 = trip.start || '2026-10-16';
  const d1 = new Date(Date.parse(`${d0}T00:00:00Z`) + 86400_000).toISOString().slice(0, 10);
  const b64 = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const msg = (id, subject, from, date, jsonLd, plain) => ({
    id,
    payload: {
      headers: [{ name: 'Subject', value: subject }, { name: 'From', value: from }, { name: 'Date', value: date }],
      parts: [
        { mimeType: 'text/plain', body: { data: b64(plain) } },
        { mimeType: 'text/html', body: { data: b64(`<html><body><script type="application/ld+json">${JSON.stringify(jsonLd)}</script><p>${plain}</p></body></html>`) } },
      ],
    },
  });
  const box = {
    'msg-hotel-baixa': msg(
      'msg-hotel-baixa',
      'Booking confirmed: Hotel da Baixa Lisbon (Ref HB-48210)',
      'reservations@hoteldabaixa.com',
      'Mon, 12 Oct 2026 09:14:00 +0000',
      { '@context': 'https://schema.org', '@type': 'LodgingReservation', reservationNumber: 'HB-48210', reservationStatus: 'https://schema.org/ReservationConfirmed', checkinTime: `${d0}T15:00:00`, checkoutTime: `${d1}T11:00:00`, totalPrice: '660', priceCurrency: 'EUR', reservationFor: { '@type': 'LodgingBusiness', name: 'Your hotel in Baixa', address: { streetAddress: 'Rua da Prata 231, Lisbon' } } },
      `Your stay at Hotel da Baixa is confirmed. Booking reference: HB-48210. Check-in ${d0}. Total EUR 660.`
    ),
    'msg-ba-502': msg(
      'msg-ba-502',
      'British Airways e-ticket receipt BA 502 LHR to LIS (Ref 6Y4K9L)',
      'ba.e-ticket@email.ba.com',
      'Mon, 12 Oct 2026 08:40:00 +0000',
      { '@context': 'https://schema.org', '@type': 'FlightReservation', reservationNumber: '6Y4K9L', reservationStatus: 'https://schema.org/ReservationConfirmed', totalPrice: '368', priceCurrency: 'EUR', reservationFor: { '@type': 'Flight', flightNumber: 'BA 502', seller: { name: 'British Airways' }, departureAirport: { iataCode: 'LHR', name: 'London Heathrow' }, arrivalAirport: { iataCode: 'LIS', name: 'Arrive in Lisbon' }, departureTime: `${d0}T08:15:00`, arrivalTime: `${d0}T10:30:00` } },
      `British Airways booking confirmation 6Y4K9L. Flight BA 502 LHR to LIS on ${d0} at 10:30.`
    ),
    'msg-ramiro': msg(
      'msg-ramiro',
      'Table reservation confirmed: Dinner in Chiado / Cervejaria Ramiro (Ref RM-9921)',
      'bookings@cervejariaramiro.pt',
      'Tue, 13 Oct 2026 14:20:00 +0000',
      { '@context': 'https://schema.org', '@type': 'FoodEstablishmentReservation', reservationNumber: 'RM-9921', reservationStatus: 'https://schema.org/ReservationConfirmed', startTime: `${d0}T19:30:00`, partySize: 2, reservationFor: { '@type': 'FoodEstablishment', name: 'Dinner in Chiado', address: { streetAddress: 'Chiado, Lisbon' } } },
      `Reservation confirmed for 2 guests on ${d0} at 19:30. Reference: RM-9921.`
    ),
  };
  return {
    async search() { return Object.keys(box); },
    async full(id) { return box[id] || box['msg-hotel-baixa']; },
  };
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
