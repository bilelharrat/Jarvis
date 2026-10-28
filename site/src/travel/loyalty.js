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
// Hotel programmes (Duffel Stays, stays.js / stayops.js; its API reference read 2026-10-28):
//   duffel.com/docs/api/v2/bookings/create-booking: Create booking takes one `loyalty_programme_account_number`
//     (string, e.g. "201154908"), with no programme field: "Use this only when the quote has a
//     supported_loyalty_programme indicated. Otherwise, this will result in an error." The number is "relayed to the
//     hotel on a best-effort basis"; honouring it is "at the hotel's discretion".
//   duffel.com/docs/api/v2/quotes/create-quote: the quote's `supported_loyalty_programme` (nullable) is "The loyalty
//     programme that this quote supports." The rate and the accommodation carry the same field in the samples.
//   duffel.com/docs/api/v2/accommodation/schema: the hotel may take a programme "not all rates will"; its values are
//     HOTEL_PROGRAMMES below (only these can be saved).
// So a stay booking sends a number only when the quote names a programme and a guest has one saved for it.
//
//   trip-loyalty        {}                                                            → { accounts, hotel_accounts, hotel_programmes }  (masked)
//   trip-loyalty-save   { given_name, family_name, airline, number, confirm: true }    → the same  (same person + airline: replaced)
//                       { given_name, family_name, programme, number, confirm: true }  → the same  (a hotel programme; same person + programme: replaced)
//   trip-loyalty-delete { id }                                                        → the same  (a flight or hotel number)
//
// tloyal → [{ id, given_name, family_name, airline, number, added }]
// tloyalh → [{ id, given_name, family_name, programme, number, added }]

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

/** Duffel Stays' `supported_loyalty_programme` values (accommodation schema, read 2026-10-28) and their names. */
export const HOTEL_PROGRAMMES = Object.freeze({
  accor_live_limitless: 'ALL - Accor Live Limitless',
  best_western_rewards: 'Best Western Rewards',
  choice_privileges: 'Choice Privileges',
  global_hotel_alliance_discovery: 'GHA Discovery',
  hilton_honors: 'Hilton Honors',
  i_prefer: 'I Prefer',
  ihg_one_rewards: 'IHG One Rewards',
  jumeirah_one: 'Jumeirah One',
  leaders_club: 'Leaders Club',
  marriott_bonvoy: 'Marriott Bonvoy',
  my_6: 'My6',
  omni_select_guest: 'Omni Select Guest',
  stash_rewards: 'Stash Rewards',
  world_of_hyatt: 'World of Hyatt',
  wyndham_rewards: 'Wyndham Rewards',
  duffel_hotel_group_rewards: 'Duffel Hotel Group Rewards (test hotels)', // Duffel's own sample programme
});
export const programmeName = (code) => (Object.hasOwn(HOTEL_PROGRAMMES, code) ? HOTEL_PROGRAMMES[code] : null);
const hview = (a) => ({ id: a.id, given_name: a.given_name, family_name: a.family_name, programme: a.programme, programme_name: programmeName(a.programme), number: mask(a.number), added: new Date(a.added).toISOString() });
const programmes = () => Object.entries(HOTEL_PROGRAMMES).map(([code, name]) => ({ code, name }));

export async function loyaltyOp(account, op, body = {}) {
  const storage = account.storage;
  let list = (await storage.get('tloyal')) || [], hotel = (await storage.get('tloyalh')) || [];
  const out = () => ({ accounts: list.map(view), hotel_accounts: hotel.map(hview), hotel_programmes: programmes() });
  if (op === 'trip-loyalty') return out();
  if (op === 'trip-loyalty-delete') {
    const id = String(body.id || '');
    if (ID.test(id) && list.some((a) => a.id === id)) { list = list.filter((a) => a.id !== id); await storage.put('tloyal', list); return out(); }
    if (ID.test(id) && hotel.some((a) => a.id === id)) { hotel = hotel.filter((a) => a.id !== id); await storage.put('tloyalh', hotel); return out(); }
    throw new TripError('There is no such loyalty number.', 404, 'not_found');
  }
  if (op !== 'trip-loyalty-save') throw new TripError('Unknown trip op.', 404, 'not_found');
  if (body.confirm !== true) throw new TripError('loyalty-save needs confirm: true (the person pressed Save).');
  const given_name = nameOf(body.given_name), family_name = nameOf(body.family_name);
  const number = String(body.number || '').replace(/[\s-]/g, '').toUpperCase();
  const isHotel = body.programme != null && body.programme !== '';
  if (!given_name || !family_name) throw new TripError(isHotel ? 'Give the guest’s first and last name as on the booking.' : 'Give the passenger’s first and last name as on their passport.');
  const key = nameKey(given_name, family_name);
  if (isHotel) {
    const programme = String(body.programme).trim().toLowerCase();
    if (!programmeName(programme)) throw new TripError('Eden can only save a hotel programme Duffel Stays lists (like marriott_bonvoy or hilton_honors).');
    if (!NUMBER.test(number)) throw new TripError('The number is 4 to 20 letters or digits, as on the card.');
    const left = hotel.filter((a) => !(a.programme === programme && nameKey(a.given_name, a.family_name) === key));
    if (left.length >= LOYALTY.max) throw new TripError(`Eden keeps at most ${LOYALTY.max} hotel loyalty numbers. Remove one first.`, 409, 'too_many');
    hotel = [...left, { id: newId(), given_name, family_name, programme, number, added: account.now() }];
    await storage.put('tloyalh', hotel);
    return out();
  }
  const airline = String(body.airline || '').trim().toUpperCase();
  if (!AIRLINE.test(airline)) throw new TripError('The airline is its two-character code, like BA or TP.');
  if (!NUMBER.test(number)) throw new TripError('The number is 4 to 20 letters or digits, as on the card.');
  const left = list.filter((a) => !(a.airline === airline && nameKey(a.given_name, a.family_name) === key));
  if (left.length >= LOYALTY.max) throw new TripError(`Eden keeps at most ${LOYALTY.max} loyalty numbers. Remove one first.`, 409, 'too_many');
  list = [...left, { id: newId(), given_name, family_name, airline, number, added: account.now() }];
  await storage.put('tloyal', list);
  return out();
}

/**
 * What a stay quote earns with: { programme, name, saved: [{ guest, number (masked) }] } for the quote's
 * `supported_loyalty_programme` (null when it names none or one Eden doesn't know: nothing is assumed).
 */
export async function hotelLoyaltyView(account, programme) {
  const name = programmeName(programme);
  if (!name) return null;
  const saved = ((await account.storage.get('tloyalh')) || []).filter((a) => a.programme === programme);
  return { programme, name, saved: saved.map((a) => ({ guest: `${a.given_name} ${a.family_name}`, number: mask(a.number) })) };
}

/**
 * The one number a stay booking sends (Duffel takes one per booking): the first guest, in the order given, with a
 * number saved for the quote's programme. Null when the quote names no known programme or no guest has one.
 * → { number, programme, name, guest, masked }
 */
export function hotelLoyaltyFor(saved, guests, programme) {
  if (!programmeName(programme)) return null;
  for (const g of guests || []) {
    const key = nameKey(nameOf(g && g.given_name), nameOf(g && g.family_name));
    const a = (saved || []).find((x) => x.programme === programme && nameKey(x.given_name, x.family_name) === key);
    if (a) return { number: a.number, programme, name: programmeName(programme), guest: `${a.given_name} ${a.family_name}`, masked: mask(a.number) };
  }
  return null;
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
