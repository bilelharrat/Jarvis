// Frequent-flyer numbers: the traveller saves each programme number (the airline's two-letter IATA code and the number,
// for one passenger by name) in Eden Travel. When that passenger books a flight with Duffel on an airline whose
// programme the fare takes, Eden sends the number with the booking. The page only ever sees a number's last 4.
//
// How Duffel takes them (its docs, read 2026-10-28: duffel.com/docs/guides/adding-loyalty-programme-accounts and the
// API reference): not in the order's passengers (Create order's "Order Request Passenger" has no such field) but on the
// offer's passenger, PATCH /air/offers/{offer}/passengers/{passenger} { given_name, family_name (1–20 characters),
// loyalty_programme_accounts: [{ airline_iata_code, account_number }] }, before the order; "you do not need to provide
// them again when creating an order". The offer's `supported_loyalty_programmes` (IATA codes) says which airlines it
// takes; others are ignored. The price can change after the update, so Eden reads the offer again and books only at the
// price the person confirmed: a different price stops the booking and asks for a fresh check.
//
//   trip-loyalty        {}                                                         → { accounts }  (masked)
//   trip-loyalty-save   { given_name, family_name, airline, number, confirm: true } → { accounts }  (same person + airline: replaced)
//   trip-loyalty-delete { id }                                                     → { accounts }
//
// tloyal → [{ id, given_name, family_name, airline, number, added }]

import { ApiError } from '../accounts/util.js';
import { TripError } from './trips.js';

export const LOYALTY = { max: 20 };
const AIRLINE = /^(?=.*[A-Z])[A-Z0-9]{2}$/; // an IATA airline code: two letters, or a letter and a digit
const NUMBER = /^[A-Z0-9]{4,20}$/;
const ID = /^l-[0-9a-f]{10}$/;

/** A name compared as the passport has it: case, accents, spaces and hyphens set aside. */
export const nameKey = (given, family) => `${given || ''}|${family || ''}`.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s'’.-]+/g, '');
export const mask = (n) => `•••• ${String(n).slice(-4)}`;
const view = (a) => ({ id: a.id, given_name: a.given_name, family_name: a.family_name, airline: a.airline, number: mask(a.number), added: new Date(a.added).toISOString() });
const newId = () => `l-${[...crypto.getRandomValues(new Uint8Array(5))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
const nameOf = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 60);

export async function loyaltyOp(account, op, body = {}) {
  const storage = account.storage;
  const list = (await storage.get('tloyal')) || [];
  if (op === 'trip-loyalty') return { accounts: list.map(view) };
  if (op === 'trip-loyalty-delete') {
    const id = String(body.id || '');
    if (!ID.test(id) || !list.some((a) => a.id === id)) throw new TripError('There is no such loyalty number.', 404, 'not_found');
    const left = list.filter((a) => a.id !== id);
    await storage.put('tloyal', left);
    return { accounts: left.map(view) };
  }
  if (op !== 'trip-loyalty-save') throw new TripError('Unknown trip op.', 404, 'not_found');
  if (body.confirm !== true) throw new TripError('loyalty-save needs confirm: true (the person pressed Save).');
  const given_name = nameOf(body.given_name), family_name = nameOf(body.family_name);
  const airline = String(body.airline || '').trim().toUpperCase();
  const number = String(body.number || '').replace(/[\s-]/g, '').toUpperCase();
  if (!given_name || !family_name) throw new TripError('Give the passenger’s first and last name as on their passport.');
  if (!AIRLINE.test(airline)) throw new TripError('The airline is its two-character code, like BA or TP.');
  if (!NUMBER.test(number)) throw new TripError('The number is 4 to 20 letters or digits, as on the card.');
  const key = nameKey(given_name, family_name);
  const left = list.filter((a) => !(a.airline === airline && nameKey(a.given_name, a.family_name) === key));
  if (left.length >= LOYALTY.max) throw new TripError(`Eden keeps at most ${LOYALTY.max} loyalty numbers. Remove one first.`, 409, 'too_many');
  const next = [...left, { id: newId(), given_name, family_name, airline, number, added: account.now() }];
  await storage.put('tloyal', next);
  return { accounts: next.map(view) };
}

/**
 * The numbers for one booking's passengers on airlines this offer takes: [{ index, accounts: [{ airline_iata_code,
 * account_number }] }]. `passengers` are the names given to book ({ given_name, family_name }), in the offer's order.
 */
export function loyaltyFor(saved, passengers, supported) {
  const ok = new Set(Array.isArray(supported) ? supported.map((c) => String(c).toUpperCase()) : []);
  const out = [];
  (passengers || []).forEach((p, index) => {
    const key = nameKey(nameOf(p && p.given_name), nameOf(p && p.family_name));
    const accounts = saved.filter((a) => ok.has(a.airline) && nameKey(a.given_name, a.family_name) === key).map((a) => ({ airline_iata_code: a.airline, account_number: a.number }));
    if (accounts.length) out.push({ index, accounts });
  });
  return out;
}

const cents = (a) => Math.round(Number(a ?? 0) * 100);

/**
 * Before a Duffel booking (flights.js, action book): the passengers' saved numbers sent on the offer's passengers, and
 * the offer read again. `check` is the price check being booked ({ offer_id, passenger_ids, fare, currency }), `client`
 * the Duffel client. Returns [{ passenger, airline, number (masked) }] sent; nothing saved or nothing the fare takes:
 * [] and no call. A price that moved throws, before anything is booked.
 */
export async function applyLoyalty(account, client, check, passengers) {
  const saved = (await account.storage.get('tloyal')) || [];
  if (!saved.length || !Array.isArray(passengers)) return [];
  const offer = await client.getOffer(check.offer_id);
  const sends = loyaltyFor(saved, passengers, offer.supported_loyalty_programmes);
  const sent = [];
  for (const { index, accounts } of sends) {
    const p = passengers[index], pid = check.passenger_ids[index];
    const given_name = nameOf(p.given_name), family_name = nameOf(p.family_name);
    if (!pid || given_name.length > 20 || family_name.length > 20) continue; // Duffel takes names of 1–20 characters here
    await client.updateOfferPassenger(check.offer_id, pid, { given_name, family_name, loyalty_programme_accounts: accounts });
    for (const a of accounts) sent.push({ passenger: `${given_name} ${family_name}`, airline: a.airline_iata_code, number: mask(a.account_number) });
  }
  if (!sent.length) return [];
  const again = await client.getOffer(check.offer_id);
  if (cents(again.total_amount) !== check.fare || again.total_currency !== check.currency) {
    throw new ApiError(409, 'price_changed', `With your loyalty number the airline’s price is now ${again.total_amount} ${again.total_currency} (it was ${(check.fare / 100).toFixed(2)} ${check.currency}). Nothing was booked: check the flight again to see the new price.`);
  }
  return sent;
}
