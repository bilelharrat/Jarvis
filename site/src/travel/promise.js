// The Eden Price Promise (a Plus perk): one view of every price Eden watches for the person, across all trips, and a
// guided rebook when a booked hotel is cheaper. The watching itself is stayops.js (booked hotels, like for like, while
// they cancel for free) and fpwatch.js (unbooked flights the person turned on); this module only shows and acts on it.
//
//   trip-promise {} → { promise, settings, hotels, flights, saved, rebooks }
//       hotels: every Duffel Stays booking made through Eden (stbk:*), what was paid, the lowest like-for-like price the
//       last look found (with its source and time), the deadline (free cancellation until) and the rebook in progress.
//       flights: every flight price watch (fpw:*), the fare it started from, the lowest now, until the flight's day.
//       saved: the rebooks the person finished through Eden (tpsave:*), summed per currency. Nothing else counts.
//   trip-promise-settings { watch_flights: boolean } → { settings }
//       on: every flight stop added from now on (not booked, its airports in its own words, like "LHR → LIS") gets
//       fpwatch turned on (promiseAutoWatch, called after trip writes), within fpwatch's cap (FPWATCH.max).
//   trip-promise-rebook { booking_id, step, confirm: true, ... } → { rebook } (and { pay: { url } } while paying)
//       one press per step, in this order only, `step` naming the press so a double press can't run the next one:
//         check  → a live quote for the cheaper rate (stays.quote); still cheaper, still free to cancel, or it stops here
//         book   { guests, email, phone_number, origin } → the new rate booked first: with traveller payments on
//                  (pay.js), a Stripe hold the person finishes on Stripe's page, else straight away. The old booking is
//                  untouched. Needs REBOOK.marginMs left in the old booking's free cancellation.
//         cancel → only once the new booking is confirmed and in this account's records, and only inside the old one's
//                  free cancellation: the old booking cancelled, the card refunded (pay.js payRefund), the saving kept.
//                  A cancel that fails (or a deadline missed) tells the person and flags it for the owner (pay.js flags).
//         forget → drops a rebook that hasn't booked anything (check or book)
//       Never cancel first: there is no path from check or book to cancel.
//   trip-promise-rebook-status { booking_id } → { rebook } (settles a payment that finished on Stripe's page)
//   promiseDue (the 'pwatch' alarm, account.js): a rebook waiting on its cancel is pushed once the day before its free
//   cancellation ends, and flagged once it has ended.
//
// tprb:<old booking> → the rebook; tpsave:<old booking> → a finished one; tpset → settings; tpaw:<trip>:<stop> → a
// flight stop the auto-watch has seen ('existing' when the setting came on, 'auto' when it turned the watch on).

import { FLAGS, flagOf, payOn, payOp, payRefund } from './pay.js';
import { refundNow } from './stayops.js';
import { priceDrop } from './stays.js';
import { FPWATCH, fpwatchOp, routeFromStop } from './fpwatch.js';
import { TripError, dayDate } from './trips.js';

export const PROMISE = { name: 'The Eden Price Promise' };
// time left in the old booking's free cancellation before Eden starts a rebook (Stripe's Checkout alone lasts 30 minutes);
// a quote older than quoteMs is checked again before booking; dueMs: the push before the deadline
export const REBOOK = { marginMs: 2 * 3600_000, quoteMs: 20 * 60_000, dueMs: 24 * 3600_000 };
const STEPS = { check: 'check', book: 'book', paying: 'book', cancel: 'cancel', cancel_failed: 'cancel' }; // state → the press it waits for

const cents = (a) => Math.round(Number(a ?? 0) * 100);
const amt = (c) => (c / 100).toFixed(2);
const iso = (ms) => new Date(ms).toISOString();
const utc = (s) => `${String(s).slice(0, 16).replace('T', ' ')} UTC`;
const dayStart = (date) => Date.parse(`${date}T00:00:00Z`);

async function notifyFor(deps) {
  if (deps.notify !== undefined) return deps.notify;
  try { return (await import('../accounts/tasks.js')).notifyOwner; } catch { return null; }
}

/* ---------- the view ---------- */

async function titles(storage, ids) {
  const out = {};
  for (const id of new Set(ids)) { const t = id ? await storage.get(`trip:${id}`) : null; out[id] = t ? t.title : null; }
  return out;
}

function hotelView(b, rb, title, now) {
  const free = b.free_until && Date.parse(b.free_until) > now;
  const lowest = b.drop
    ? { total: b.drop.total, currency: b.currency, at: b.drop.checked_at, source: 'Duffel Stays' }
    : b.checked && b.checked.total ? { total: b.checked.total, currency: b.checked.currency, at: b.checked.at, source: 'Duffel Stays' } : null;
  return {
    kind: 'hotel', booking_id: b.booking_id, reference: b.reference || null, trip: b.trip, trip_title: title, stop: b.stop,
    name: (b.accommodation && b.accommodation.name) || 'Your hotel', room: b.room || null, check_in: b.check_in, check_out: b.check_out,
    paid: b.total ? { total: b.total, currency: b.currency, source: 'Your booking through Eden (Duffel Stays)' } : null,
    lowest, like_for_like: 'The same hotel, room, dates and guests, at a rate that also cancels for free',
    checked_at: (b.checked && b.checked.at) || (b.drop && b.drop.checked_at) || null,
    cheaper: b.drop && free ? { total: b.drop.total, by: b.drop.by, currency: b.currency, checked_at: b.drop.checked_at } : null,
    deadline: b.free_until ? { label: 'Free cancellation until', at: b.free_until } : null,
    watching: Boolean(free),
    why_not: free ? null : b.free_until ? 'Free cancellation has ended, so a cheaper rate can’t be swapped in.' : 'This rate can’t be cancelled for free, so there is nothing to watch.',
    rebook: rb ? rebookView(rb) : null,
  };
}

function flightView(w, title, how) {
  return {
    kind: 'flight', trip: w.trip, trip_title: title, stop: w.stop, route: `${w.route.origin} → ${w.route.destination}`, date: w.route.date,
    cabin: w.route.cabin, adults: w.route.adults,
    seen: { total: w.base.total, currency: w.base.currency, at: w.base.at, source: w.base.source },
    lowest: w.best ? { total: w.best.total, currency: w.best.currency, at: w.best.at, source: 'Duffel' } : null,
    cheaper: w.drop ? { total: w.drop.total, by: w.drop.by, pct: w.drop.pct, currency: w.base.currency, checked_at: w.drop.checked_at } : null,
    checked_at: iso(w.checked_at),
    deadline: { label: 'Watched until the flight’s day', at: `${w.route.date}T00:00:00Z` },
    auto: how === 'auto',
  };
}

export function rebookView(r) {
  return {
    booking_id: r.booking_id, hotel: r.hotel, state: r.state, next: STEPS[r.state] || null,
    old: r.old, quote: r.quote || null, saving: r.saving || null, new: r.new || null,
    pay: r.pay ? { pay_id: r.pay.pay_id, url: r.state === 'paying' ? r.pay.url : null } : null,
    error: r.error || null, owner_flagged: Boolean(r.owner_flag), steps: (r.history || []).slice(-10),
  };
}

/** Sums of finished rebooks, per currency (never converted). */
export function savedTotals(entries) {
  const by = {};
  for (const e of entries) by[e.currency] = (by[e.currency] || 0) + cents(e.saved);
  return Object.entries(by).map(([currency, c]) => ({ currency, amount: amt(c) }));
}

async function promiseView(account) {
  const { storage } = account;
  const now = account.now();
  const stays = [...(await storage.list({ prefix: 'stbk:' })).values()];
  const fws = [...(await storage.list({ prefix: 'fpw:' })).values()];
  const rbs = new Map([...(await storage.list({ prefix: 'tprb:' }))].map(([k, v]) => [k.slice(5), v]));
  const entries = [...(await storage.list({ prefix: 'tpsave:' })).values()].sort((a, b) => b.at - a.at);
  const names = await titles(storage, [...stays.map((b) => b.trip), ...fws.map((w) => w.trip)]);
  const hotels = [];
  for (const b of stays) { hotels.push(hotelView(b, rbs.get(b.booking_id), names[b.trip] ?? null, now)); rbs.delete(b.booking_id); }
  const flights = [];
  for (const w of fws) { const m = await storage.get(`tpaw:${w.trip}:${w.stop}`); flights.push(flightView(w, names[w.trip] ?? null, m && m.how)); }
  hotels.sort((a, b) => String(a.deadline?.at || '9').localeCompare(String(b.deadline?.at || '9')));
  flights.sort((a, b) => a.date.localeCompare(b.date));
  return {
    promise: { name: PROMISE.name, what: 'Eden watches what you booked or picked through Eden for a lower like-for-like price, and helps you switch while it still costs nothing to.' },
    settings: await settingsOf(storage),
    hotels, flights,
    rebooks: [...rbs.values()].filter((r) => r.state !== 'done').map(rebookView), // rebooks whose old booking is gone already
    saved: { totals: savedTotals(entries), entries: entries.slice(0, 50) },
    at: iso(now),
  };
}

/* ---------- settings and the automatic flight watch ---------- */

async function settingsOf(storage) {
  const s = (await storage.get('tpset')) || {};
  return { watch_flights: Boolean(s.watch_flights), since: s.since ? iso(s.since) : null, cap: FPWATCH.max };
}

/** Flight stops a trip has now (to mark them seen when the setting comes on: only new ones are watched automatically). */
const flightStops = (trip) => trip.days.flatMap((d, di) => d.stops.filter((s) => s.kind === 'transport').map((s) => ({ s, di })));

async function setSettings(account, body) {
  if (typeof body.watch_flights !== 'boolean') throw new TripError('watch_flights must be true or false.');
  const { storage } = account;
  const was = (await storage.get('tpset')) || {};
  const now = account.now();
  if (body.watch_flights && !was.watch_flights) {
    // the flights already in the trips stay as the person set them; only flights added from now on are watched
    for (const [k, trip] of await storage.list({ prefix: 'trip:' })) {
      for (const { s } of flightStops(trip)) {
        const mk = `tpaw:${k.slice(5)}:${s.id}`;
        if (!(await storage.get(mk))) await storage.put(mk, { how: 'existing', at: now });
      }
    }
  }
  await storage.put('tpset', { watch_flights: body.watch_flights, since: body.watch_flights ? (was.watch_flights ? was.since : now) : null, at: now });
  return { settings: await settingsOf(storage) };
}

/**
 * After a trip write (account.js): with "Watch every flight I add" on, each new flight stop of the trip (or every trip)
 * that isn't booked, has its airports in its own words and a day still to come gets fpwatch turned on. A stop is tried
 * once it qualifies; one without airports yet is tried again on the next write. Never past fpwatch's cap.
 * → { watched: [stop ids], skipped: [{ stop, why }] }
 */
export async function promiseAutoWatch(account, out, deps = {}) {
  const { storage } = account;
  const res = { watched: [], skipped: [] };
  const s = await storage.get('tpset');
  if (!s || !s.watch_flights) return res;
  const now = account.now();
  const on = deps.fpwatchOp || fpwatchOp;
  const trips = out && out.trip && out.trip.id ? [[out.trip.id, await storage.get(`trip:${out.trip.id}`)]] : [...(await storage.list({ prefix: 'trip:' }))].map(([k, v]) => [k.slice(5), v]);
  let count = (await storage.list({ prefix: 'fpw:' })).size;
  for (const [id, trip] of trips) {
    if (!trip) continue;
    for (const { s: stop, di } of flightStops(trip)) {
      const mk = `tpaw:${id}:${stop.id}`;
      if (await storage.get(mk)) continue;
      if (stop.booked || await storage.get(`fpw:${id}:${stop.id}`)) { await storage.put(mk, { how: 'existing', at: now }); continue; }
      if (now >= dayStart(dayDate(trip, di))) { await storage.put(mk, { how: 'past', at: now }); continue; }
      if (!routeFromStop(stop)) { res.skipped.push({ stop: stop.id, why: 'no_airports' }); continue; } // tried again once it has them
      if (count >= FPWATCH.max) { res.skipped.push({ stop: stop.id, why: 'cap' }); continue; } // tried again once a watch ends
      try {
        await on(account, 'trip-fwatch-on', { id, stop: stop.id }, { fetch: deps.fetch });
        await storage.put(mk, { how: 'auto', at: now });
        res.watched.push(stop.id);
        count += 1;
      } catch (e) {
        const code = e && e.code;
        // Duffel off or down, or the cap reached meanwhile: tried again later; anything else (no fares on that route) is final
        if (code === 'not_set_up' || code === 'too_many' || code === 'unavailable' || code === 'timeout' || code === 'rate_limited') res.skipped.push({ stop: stop.id, why: code });
        else { await storage.put(mk, { how: 'failed', at: now, why: String((e && e.message) || e).slice(0, 200) }); res.skipped.push({ stop: stop.id, why: 'failed' }); }
      }
    }
  }
  return res;
}

/* ---------- the guided rebook ---------- */

const ID = /^[A-Za-z0-9_-]{1,80}$/;

function note(r, step, ok, text, now) {
  r.history = [...(r.history || []), { step, ok, text, at: iso(now) }].slice(-20);
  r.updated = now;
}

/** The owner's flag (pay.js flags pattern): on the new booking's payment when there is one, so the owner's dashboard
 *  lists it under Travel refunds and Mark resolved clears it; always kept on the rebook and logged. Never throws. */
async function flagOwner(account, r, text, deps) {
  const now = account.now();
  r.owner_flag = { text, at: now };
  console.error('travel price promise: owner flag', r.booking_id, text);
  try {
    if (deps.flag) return await deps.flag(account, r, text);
    const payId = r.new && r.new.booking_id ? await account.storage.get(`tpayby:${r.new.booking_id}`) : (r.pay && r.pay.pay_id);
    const rec = payId ? await account.storage.get(`tpay:${payId}`) : null;
    if (!rec) return; // payments off: no payment to hang it on (the rebook keeps it; see the report)
    rec.sweep_review = { why: text, booking: r.booking_id, since: now, tries: 0 };
    await account.storage.put(`tpay:${payId}`, rec);
    const env = account.env || {};
    const accountId = ((await account.storage.get('account')) || {}).id;
    const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName(FLAGS));
    await stub.fetch('https://account/tpayflag-set', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ account: accountId, pay_id: payId, flag: { ...flagOf(rec), title: rec.title, kind: rec.kind, status: rec.status } }) });
  } catch (e) { console.error('travel price promise: flag not indexed', r.booking_id, e && e.message); }
}

async function tell(account, r, title, body, deps) {
  const notify = await notifyFor(deps);
  if (notify) await notify(account, { title, body, data: { kind: 'price-promise', trip: r.trip, stop: r.stop, booking: r.booking_id } }).catch(() => {});
}

/** A payment that finished (or failed) on Stripe's page moves the rebook on. */
async function settlePaying(account, r) {
  if (r.state !== 'paying' || !r.pay) return false;
  const rec = await account.storage.get(`tpay:${r.pay.pay_id}`);
  const now = account.now();
  if (!rec) return false; // pay.js writes it before the page goes to Stripe; none: nothing has moved
  if (rec.status === 'failed') {
    r.state = 'check';
    r.quote = null;
    r.error = `${rec.error || 'The payment didn’t go through.'} Your booking is as it was.`;
    note(r, 'book', false, r.error, now);
    return true;
  }
  if ((rec.status === 'paid' || rec.status === 'booked') && rec.result && rec.result.booking_id) {
    const b = rec.result;
    r.new = { booking_id: b.booking_id, reference: b.reference || null, total: r.quote.total, currency: r.quote.currency, free_until: r.quote.free_until, status: b.status || null };
    r.state = 'cancel';
    r.error = null;
    note(r, 'book', true, `Booked the new rate, reference ${b.reference || b.booking_id}${rec.status === 'booked' ? ' (the card charge is still being sorted out)' : ''}.`, now);
    return true;
  }
  return false; // still on Stripe's page, or booking
}

async function rebookOp(account, body, deps) {
  const { storage } = account;
  const now = account.now();
  const id = String(body.booking_id || '');
  if (!ID.test(id)) throw new TripError('booking_id: the hotel booking to rebook.');
  const key = `tprb:${id}`;
  const old = await storage.get(`stbk:${id}`);
  let r = await storage.get(key);
  if (r && await settlePaying(account, r)) await storage.put(key, r);

  if (body.status) {
    if (!r) throw new TripError('There is no rebook for this booking.', 404, 'not_found');
    return { rebook: rebookView(r) };
  }
  if (body.confirm !== true) throw new TripError('promise-rebook needs confirm: true (the person pressed the step’s button).');
  const step = String(body.step || '');
  if (step === 'forget') {
    if (r && !['check', 'book'].includes(r.state)) throw new TripError('This rebook has booked a new room already, so it can’t be dropped here.', 409, 'locked');
    await storage.delete(key);
    return { rebook: null };
  }
  if (!r) {
    if (!old) throw new TripError('There is no such hotel booking in your Eden Travel.', 404, 'not_found');
    r = { booking_id: id, trip: old.trip, stop: old.stop, hotel: (old.accommodation && old.accommodation.name) || 'Your hotel', old: { reference: old.reference || null, total: old.total, currency: old.currency, free_until: old.free_until, room: old.room || null }, state: 'check', created: now, history: [] };
  }
  const want = STEPS[r.state];
  if (!want) throw new TripError(r.state === 'done' ? 'This rebook is finished.' : 'Ask Eden is looking at this rebook; there is nothing to press now.', 409, r.state === 'done' ? 'done' : 'locked');
  if (step !== want) throw new TripError(`The next step is “${want}”${r.state === 'paying' ? ' (the payment is still open)' : ''}.`, 409, 'wrong_step');
  account.rebooking ??= new Set();
  if (account.rebooking.has(id)) throw new TripError('That step is already running.', 409, 'busy');
  account.rebooking.add(id);
  const save = () => storage.put(key, r);
  const tripOp = deps.tripOp;
  try {
    /* 1. check: a live quote for the cheaper rate */
    if (step === 'check') {
      if (!old) throw new TripError('That booking is no longer in your Eden Travel.', 404, 'not_found');
      if (!old.free_until || Date.parse(old.free_until) - REBOOK.marginMs <= now) throw new TripError(`There isn’t enough time left in the free cancellation (until ${utc(old.free_until || '—')}) to switch safely.`, 409, 'too_late');
      if (!old.drop || !old.drop.rate_id) throw new TripError('Eden hasn’t found a lower like-for-like price for this booking.', 409, 'no_drop');
      let q;
      try { q = await tripOp(account, 'trip-stays-quote', { rate_id: old.drop.rate_id }); }
      catch (e) { r.error = `Duffel Stays couldn’t price the cheaper rate now: ${String((e && e.message) || e)} Your booking is as it was.`; note(r, 'check', false, r.error, now); await save(); return { rebook: rebookView(r) }; }
      const freeUntil = q.cancellation && q.cancellation.free_until;
      const d = priceDrop({ total: old.total, currency: old.currency, free_until: old.free_until }, { total: q.total, currency: q.currency }, now);
      if (!d.cheaper || !freeUntil || Date.parse(freeUntil) <= now) {
        r.quote = null;
        r.error = !freeUntil || Date.parse(freeUntil) <= now ? 'The lower rate no longer cancels for free, so it isn’t like for like. Your booking is as it was.' : `The lower price has gone: Duffel Stays asks ${q.total} ${q.currency} now, against your ${old.total} ${old.currency}. Your booking is as it was.`;
        note(r, 'check', false, r.error, now);
        await save();
        return { rebook: rebookView(r) };
      }
      r.quote = { quote_id: q.quote_id, total: q.total, currency: q.currency, room: q.room || null, free_until: freeUntil, at: now, checked_at: iso(now), source: 'Duffel Stays quote' };
      r.saving = { amount: d.by, currency: old.currency };
      r.state = 'book';
      r.error = null;
      note(r, 'check', true, `${q.total} ${q.currency} now (you paid ${old.total} ${old.currency}), free cancellation until ${utc(freeUntil)}.`, now);
      await save();
      return { rebook: rebookView(r) };
    }

    /* 2. book: the new rate first; the old booking is untouched */
    if (step === 'book') {
      if (r.state === 'paying') return { rebook: rebookView(r), pay: { url: r.pay.url } }; // the same payment, not a new one
      if (!old) throw new TripError('That booking is no longer in your Eden Travel.', 404, 'not_found');
      if (Date.parse(old.free_until) - REBOOK.marginMs <= now) throw new TripError(`There isn’t enough time left in the free cancellation (until ${utc(old.free_until)}) to switch safely.`, 409, 'too_late');
      if (!r.quote || now - r.quote.at > REBOOK.quoteMs) {
        r.state = 'check'; r.quote = null; r.error = 'The price is more than 20 minutes old. Check it again.';
        note(r, 'book', false, r.error, now); await save();
        return { rebook: rebookView(r) };
      }
      const guests = Array.isArray(body.guests) ? body.guests : [];
      if (!guests.length || guests.some((g) => !g || !String(g.given_name || '').trim() || !String(g.family_name || '').trim())) throw new TripError('The guests’ names, as on the booking.');
      if (!String(body.email || '').includes('@')) throw new TripError('An email for the booking.');
      if (!/^\+\d{6,15}$/.test(String(body.phone_number || ''))) throw new TripError('A phone number like +15555550100.');
      const args = { quote_id: r.quote.quote_id, guests, email: String(body.email), phone_number: String(body.phone_number), ...(r.trip && r.stop ? { id: r.trip, stop: r.stop } : {}) };
      const paying = deps.payOn !== undefined ? deps.payOn : payOn(account.env || {});
      if (paying) {
        // the traveller's card held first (pay.js); Eden books once it is, from pay-complete; never booked here
        const start = deps.payStart || ((a, b) => payOp(a, 'trip-pay-start', b, { tripOp }));
        const p = await start(account, { kind: 'stay', args, origin: body.origin });
        if (p && p.required) {
          r.state = 'paying';
          r.pay = { pay_id: p.pay_id, url: p.url };
          note(r, 'book', true, `Payment started on Stripe (${p.total_text || `${r.quote.total} ${r.quote.currency}`}). Your old booking stays until the new one is confirmed.`, now);
          await save();
          return { rebook: rebookView(r), pay: { url: p.url } };
        }
      }
      let b;
      try { b = await tripOp(account, 'trip-stays-book', { ...args, confirm: true }); }
      catch (e) {
        r.state = 'check'; r.quote = null;
        r.error = `The new rate couldn’t be booked: ${String((e && e.message) || e)} Your booking is as it was.`;
        note(r, 'book', false, r.error, now); await save();
        return { rebook: rebookView(r) };
      }
      if (b.status && b.status !== 'confirmed') {
        // made but not confirmed: never cancel the old one on it; the owner looks
        r.new = { booking_id: b.booking_id, reference: b.reference || null, total: r.quote.total, currency: r.quote.currency, free_until: r.quote.free_until, status: b.status };
        r.state = 'unconfirmed';
        r.error = `Duffel Stays answered “${b.status}” for the new booking, not confirmed. Eden won’t cancel your old booking; Ask Eden will look at it.`;
        note(r, 'book', false, r.error, now);
        await flagOwner(account, r, `Price Promise rebook: new booking ${b.booking_id} came back ${b.status}; old booking ${id} kept.`, deps);
        await save();
        return { rebook: rebookView(r) };
      }
      r.new = { booking_id: b.booking_id, reference: b.reference || null, total: r.quote.total, currency: r.quote.currency, free_until: r.quote.free_until, status: b.status || 'confirmed' };
      r.state = 'cancel';
      r.error = null;
      note(r, 'book', true, `Booked the new rate, reference ${b.reference || b.booking_id}.`, now);
      await save();
      return { rebook: rebookView(r) };
    }

    /* 3. cancel: the old booking, only now that the new one is confirmed and inside the free window */
    if (!r.new || !r.new.booking_id || !(await storage.get(`stbk:${r.new.booking_id}`))) {
      throw new TripError('Eden can’t find the new booking in your Eden Travel, so it won’t cancel the old one.', 409, 'no_new_booking');
    }
    if (!old) {
      // already cancelled through Eden (only Eden's own cancel removes it): the rebook is done
      return { rebook: rebookView(await finish(account, r, null)) };
    }
    if (!old.free_until || Date.parse(old.free_until) <= now) {
      r.state = 'cancel_late';
      r.error = `The free cancellation ended at ${utc(old.free_until || '—')} before the old booking was cancelled, so Eden didn’t cancel it (it would cost money). You have both bookings; Ask Eden will help sort it out.`;
      note(r, 'cancel', false, r.error, now);
      await flagOwner(account, r, `Price Promise rebook: free cancellation of ${id} ended before it was cancelled; new booking ${r.new.booking_id} also stands.`, deps);
      await save();
      return { rebook: rebookView(r) };
    }
    try { await tripOp(account, 'trip-stays-cancel', { booking_id: id, confirm: true }); }
    catch (e) {
      const first = r.state !== 'cancel_failed';
      r.state = 'cancel_failed';
      r.error = `The old booking couldn’t be cancelled: ${String((e && e.message) || e)} You have both bookings until it is. Try again before ${utc(old.free_until)}; Ask Eden has been told.`;
      note(r, 'cancel', false, r.error, now);
      if (first) {
        await flagOwner(account, r, `Price Promise rebook: cancelling old booking ${id} failed after new booking ${r.new.booking_id} was made. Free until ${old.free_until}.`, deps);
        await tell(account, r, `${r.hotel}: the old booking isn’t cancelled yet`, `Your new booking is made, but cancelling the old one failed. Open Eden Travel to try again before ${utc(old.free_until)}.`, deps);
      }
      await save();
      return { rebook: rebookView(r) };
    }
    // the card gets the old booking's price back (whole, inside the free window), as account.js does for trip-stays-cancel
    const refund = deps.payRefund || payRefund;
    const words = await refund(account, id, refundNow(old, now)).catch((e) => { console.error('price promise refund', id, e && e.message); return null; });
    return { rebook: rebookView(await finish(account, r, { card_refund_text: words || null })) };
  } finally {
    account.rebooking.delete(id);
  }
}

/** The rebook finished: the saving goes into the ledger (once). */
async function finish(account, r, extra) {
  const now = account.now();
  const saved = Math.max(0, cents(r.old.total) - cents(r.new.total));
  const k = `tpsave:${r.booking_id}`;
  if (!(await account.storage.get(k))) {
    await account.storage.put(k, { at: now, trip: r.trip, stop: r.stop, hotel: r.hotel, currency: r.old.currency, saved: amt(saved), old: { booking_id: r.booking_id, reference: r.old.reference, total: r.old.total }, new: { booking_id: r.new.booking_id, reference: r.new.reference, total: r.new.total }, source: 'Duffel Stays' });
  }
  const hadFlag = Boolean(r.owner_flag);
  r.state = 'done';
  r.error = null;
  if (extra && extra.card_refund_text) r.card_refund_text = extra.card_refund_text;
  note(r, 'cancel', true, `Old booking cancelled. Saved ${amt(saved)} ${r.old.currency}.`, now);
  if (hadFlag) r.owner_flag = { ...r.owner_flag, settled: now }; // the owner still clears it on the dashboard
  await account.storage.put(`tprb:${r.booking_id}`, r);
  return r;
}

/** The 'pwatch' alarm (account.js, after stayWatchDue): a rebook waiting on its cancel. */
export async function promiseDue(account, deps = {}) {
  const now = account.now();
  for (const [k, r] of await account.storage.list({ prefix: 'tprb:' })) {
    if (r.state !== 'cancel' && r.state !== 'cancel_failed') continue;
    const until = Date.parse(r.old.free_until || '');
    if (!Number.isFinite(until)) continue;
    if (now >= until) {
      r.state = 'cancel_late';
      r.error = `The free cancellation ended at ${utc(r.old.free_until)} before the old booking was cancelled. You have both bookings; Ask Eden will help sort it out.`;
      note(r, 'cancel', false, r.error, now);
      await flagOwner(account, r, `Price Promise rebook: free cancellation of ${r.booking_id} ended uncancelled; new booking ${r.new && r.new.booking_id} also stands.`, deps);
      await tell(account, r, `${r.hotel}: you have two bookings`, 'The old booking’s free cancellation ended before it was cancelled. Ask Eden will help.', deps);
      await account.storage.put(k, r);
    } else if (until - now <= REBOOK.dueMs && !r.told_due) {
      r.told_due = now;
      await tell(account, r, `${r.hotel}: cancel the old booking`, `Your new booking is made. Cancel the old one in Eden Travel before ${utc(r.old.free_until)} to keep the saving.`, deps);
      await account.storage.put(k, r);
    }
  }
}

/* ---------- the ops ---------- */

export async function promiseOp(account, op, body = {}, deps = {}) {
  switch (op) {
    case 'trip-promise': return promiseView(account);
    case 'trip-promise-settings': return setSettings(account, body);
    case 'trip-promise-rebook': return rebookOp(account, { ...body, status: false }, deps);
    case 'trip-promise-rebook-status': return rebookOp(account, { booking_id: body.booking_id, status: true }, deps);
    default: throw new TripError('Unknown Price Promise op.', 404, 'not_found');
  }
}
