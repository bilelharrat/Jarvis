// Hotels in Eden Travel (Duffel Stays, stays.js) as the account's trip ops, and price protection: after a booking,
// Eden looks once a day at the same hotel, room count and dates; when it is more than 1% cheaper and the booking can
// still be cancelled for free, the traveller is told (a push) and Eden noticed shows it with the deadline. Rebooking is
// the person's: Eden books the cheaper rate and cancels the old one only from cards they press.
//
//   trip-stays-search { id, stop } | { lat, lng, check_in, check_out } (+ adults, rooms, radius_km)   → stays.search
//   trip-stays-rates  { search_result_id }   → stays.rates (each rate's cancellation kept for the booking that follows)
//   trip-stays-quote  { rate_id }            → stays.quote, with that rate's cancellation
//   trip-stays-book   { quote_id, guests, email, phone_number, special_requests?, id?, stop?, confirm: true }
//                       → the booking; with id + stop, that stop marked booked (via api) and watched for a lower price
//   trip-stays-cancel { booking_id, confirm: true }
//   alarm kind 'pwatch' (account.js): stayWatchDue

import { scheduleJob, unscheduleJob } from '../accounts/schedule.js';
import { StaysError, priceDrop, staysFor } from './stays.js';
import { TripError, dayDate } from './trips.js';

export const PRICE_WATCH = { everyMs: 24 * 3600_000 };
const JOB = 'pwatch';

const asTripError = (e) => {
  if (e instanceof StaysError) return new TripError(e.message, e.code === 'not_found' ? 404 : e.code === 'rate_limited' ? 429 : e.code === 'not_set_up' || e.code === 'live_refused' ? 404 : e.code === 'unavailable' || e.code === 'timeout' ? 503 : 400, e.code);
  return e;
};

/** Where and when a stay stop is, from the trip itself. */
function stayOf(trip, stopId) {
  const di = trip.days.findIndex((d) => d.stops.some((s) => s.id === stopId));
  if (di < 0) throw new TripError('There is no such stop in this trip.', 404, 'not_found');
  const s = trip.days[di].stops.find((x) => x.id === stopId);
  const nights = Number.isInteger(s.nights) && s.nights > 0 ? s.nights : Math.max(1, trip.days.length - 1 - di);
  return { stop: s, check_in: dayDate(trip, di), check_out: dayDate(trip, di + nights) };
}

export async function stayOp(account, op, body, deps = {}) {
  const now = () => account.now();
  const stays = deps.stays !== undefined ? deps.stays : (() => { try { return staysFor(account.env, { fetch: deps.fetch, now }); } catch (e) { throw asTripError(e); } })();
  if (!stays) throw new TripError('Hotel booking isn’t switched on yet (Duffel Stays).', 404, 'not_set_up');
  try {
    switch (op) {
      case 'trip-stays-search': {
        let a = { ...body };
        if (body.id && body.stop) {
          const trip = await account.storage.get(`trip:${String(body.id)}`);
          if (!trip) throw new TripError('There is no such trip.', 404, 'not_found');
          const st = stayOf(trip, String(body.stop));
          a = { lat: st.stop.place.lat, lng: st.stop.place.lng, check_in: st.check_in, check_out: st.check_out, adults: body.adults ?? trip.travelers, rooms: body.rooms ?? 1, radius_km: body.radius_km ?? 3 };
          if (!Number.isFinite(a.lat)) throw new TripError('That stop isn’t on the map yet, so there is nowhere to search near.', 400, 'bad_request');
        }
        return await stays.search(a);
      }
      case 'trip-stays-rates': {
        const out = await stays.rates(body.search_result_id);
        // each rate's cancellation and price, for the quote and the price watch that follow (Duffel's quote lacks them)
        const keep = {};
        for (const room of out.rooms) for (const r of room.rates) keep[`strt:${r.rate_id}`] = { at: now(), room: room.name, total: r.total, currency: r.currency, cancellation: r.cancellation, accommodation: out.accommodation };
        if (Object.keys(keep).length) await account.storage.put(keep);
        return out;
      }
      case 'trip-stays-quote': {
        const q = await stays.quote(body.rate_id);
        // the rate's room and cancellation terms (they don't change for a rate; the price is the quote's own, below)
        const fresh = (await account.storage.get(`strt:${String(body.rate_id)}`)) || null;
        // the quote's own price (Duffel's live check), not the rate's earlier one: that is what Duffel takes, and what the card is held for
        // always kept for the payment and booking that follow: the quote's own price; the room and cancellation when known
        await account.storage.put(`stq:${q.quote_id}`, { ...(fresh || { room: null, cancellation: null, accommodation: q.accommodation }), total: q.total, currency: q.currency, rate_id: body.rate_id, at: now() });
        return { ...q, room: fresh ? fresh.room : null, cancellation: fresh ? fresh.cancellation : null };
      }
      case 'trip-stays-book': {
        if (body.confirm !== true) throw new TripError('stays-book needs confirm: true (the person pressed Book).');
        const b = await stays.book({ ...body, confirm: true });
        const q = (await account.storage.get(`stq:${String(body.quote_id)}`)) || {};
        if (body.id && body.stop && deps.tripOp) {
          await deps.tripOp(account, 'trip-mark-booked', { id: body.id, stop: body.stop, ref: b.reference || b.booking_id, provider: (b.accommodation && b.accommodation.name) || 'Duffel Stays', via: 'api', cost: q.total ? { amount: Number(q.total), currency: q.currency } : undefined, confirm: true }).catch(() => {});
        }
        const acc = b.accommodation || q.accommodation || {};
        await account.storage.put(`stbk:${b.booking_id}`, {
          booking_id: b.booking_id, reference: b.reference, trip: body.id || null, stop: body.stop || null,
          accommodation: { id: acc.id || null, name: acc.name || null, lat: acc.lat ?? null, lng: acc.lng ?? null },
          check_in: b.check_in, check_out: b.check_out, adults: Array.isArray(body.guests) ? body.guests.length : 1, rooms: body.rooms || 1,
          total: q.total || null, currency: q.currency || null, free_until: (q.cancellation && q.cancellation.free_until) || null,
          room: q.room || null, refunds: (q.cancellation && Array.isArray(q.cancellation.refunds) ? q.cancellation.refunds : []), // the refund timeline: a later cancel's card refund
          created: now(), drop: null,
        });
        await armStayWatch(account);
        return b;
      }
      case 'trip-stays-cancel': {
        if (body.confirm !== true) throw new TripError('stays-cancel needs confirm: true (the person pressed Cancel booking).');
        // Eden books on one Duffel account for everyone: only a booking this account made can be cancelled from it
        if (!(await account.storage.get(`stbk:${String(body.booking_id)}`))) throw new TripError('There is no such hotel booking in your Eden Travel.', 404, 'not_found');
        const b = await stays.cancel(body.booking_id, { confirm: true });
        await account.storage.delete(`stbk:${String(body.booking_id)}`);
        return b;
      }
      default:
        throw new TripError('Unknown hotel op.', 404, 'not_found');
    }
  } catch (e) { throw asTripError(e); }
}

/** What a cancel of booking `b` gives back now (minor units of its currency): the whole price while free, else the
 *  timeline's step for now (Duffel refunds that much to Eden's balance), else nothing. */
export function refundNow(b, now) {
  if (!b || !b.total) return 0;
  if (b.free_until && now < Date.parse(b.free_until)) return Math.round(Number(b.total) * 100);
  const step = (b.refunds || []).find((r) => now < Date.parse(r.before) && (!r.currency || r.currency === b.currency));
  return step ? Math.round(Number(step.amount) * 100) : 0;
}

/** The price watch's job: once a day while any booking can still be cancelled for free. */
export async function armStayWatch(account) {
  const now = account.now();
  const live = [...(await account.storage.list({ prefix: 'stbk:' })).values()].filter((b) => b.free_until && Date.parse(b.free_until) > now);
  if (live.length) await scheduleJob(account, JOB, JOB, now + PRICE_WATCH.everyMs);
  else await unscheduleJob(account, JOB);
}

/** Bookings whose hotel is cheaper now (for trip-get: Eden noticed shows them). */
export async function priceDrops(account, tripId) {
  const now = account.now();
  return [...(await account.storage.list({ prefix: 'stbk:' })).values()]
    .filter((b) => b.trip === tripId && b.drop && b.free_until && Date.parse(b.free_until) > now)
    .map((b) => ({ booking_id: b.booking_id, stop: b.stop, hotel: b.accommodation.name, was: b.total, now: b.drop.total, by: b.drop.by, currency: b.currency, rate_id: b.drop.rate_id, rebook_before: b.free_until, checked_at: b.drop.checked_at, source: 'Duffel Stays' }));
}

export async function stayWatchDue(account, { notify, stays: given, fetch } = {}) {
  const now = account.now();
  let stays = given;
  if (stays === undefined) { try { stays = staysFor(account.env, { fetch, now: () => account.now() }); } catch { stays = null; } }
  if (!stays) return;
  for (const [key, b] of await account.storage.list({ prefix: 'stbk:' })) {
    if (!b.free_until || Date.parse(b.free_until) <= now || !Number.isFinite(b.accommodation.lat)) continue;
    let fresh = null;
    try {
      const found = await stays.search({ lat: b.accommodation.lat, lng: b.accommodation.lng, radius_km: 1, check_in: b.check_in, check_out: b.check_out, adults: b.adults, rooms: b.rooms });
      const same = found.results.find((r) => r.accommodation && r.accommodation.id === b.accommodation.id);
      // like for like: the same room (when known) at a rate that can still be cancelled for free, never the hotel's
      // cheapest non-refundable or other room
      if (same) {
        const all = await stays.rates(same.search_result_id);
        let best = null;
        for (const room of all.rooms || []) {
          if (b.room && room.name !== b.room) continue;
          for (const r of room.rates || []) {
            if (r.currency !== b.currency || !(r.cancellation && r.cancellation.free_until && Date.parse(r.cancellation.free_until) > now)) continue;
            if (!best || Number(r.total) < Number(best.total)) best = r;
          }
        }
        if (best) {
          fresh = { total: best.total, currency: best.currency, rate_id: best.rate_id, search_result_id: same.search_result_id };
          // its terms kept, as trip-stays-rates keeps them: a rebook from this rate knows its free cancellation
          await account.storage.put(`strt:${best.rate_id}`, { at: now, room: b.room || null, total: best.total, currency: best.currency, cancellation: best.cancellation, accommodation: all.accommodation || b.accommodation });
        }
      }
    } catch { continue; } // Duffel down: tomorrow
    if (!fresh) continue;
    const d = priceDrop({ total: b.total, currency: b.currency, free_until: b.free_until }, fresh, now);
    if (!d.cheaper) { if (b.drop) { b.drop = null; await account.storage.put(key, b); } continue; }
    const told = b.drop && Number(b.drop.total) <= Number(fresh.total);
    b.drop = { total: fresh.total, by: d.by, search_result_id: fresh.search_result_id, rate_id: fresh.rate_id, checked_at: new Date(now).toISOString() };
    await account.storage.put(key, b);
    if (!told && notify) await notify(account, { title: `${b.accommodation.name || 'Your hotel'} is cheaper now`, body: `${d.by} ${b.currency} less for the same dates on Duffel Stays. Free cancellation until ${String(b.free_until).slice(0, 16).replace('T', ' ')} UTC: Eden can rebook it for you in Eden Travel.`, data: { kind: 'price', trip: b.trip, stop: b.stop } });
  }
  await armStayWatch(account);
}
