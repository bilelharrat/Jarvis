// Eden Travel on the ground: ferries, trains and buses, car hire. One shape for every provider's
// answer (a journey option), one error, and the switch that says which providers this Worker has.
//
// A journey option:
//   { mode: 'ferry'|'train'|'bus'|'car', provider, id, from {name, code?}, to {name, code?},
//     depart ISO|null, arrive ISO|null, duration_min|null, operator|null,
//     price {amount, currency}|null, price_kind: 'indicative'|'bookable', book_url|null,
//     source, checked_at }
// 'indicative' is a price seen in a search, to be checked on the seller's site; 'bookable' is an
// offer Eden itself can reserve through the provider's API. Providers may add fields (rail adds
// `offers`, the car stand-in adds `standin`).
//
// ground.js and the provider files import each other; that's safe because nothing runs at load.

import { carsFor } from './cars.js';
import { ferriesFor } from './ferries.js';
import { railFor } from './rail.js';

export const MODES = ['ferry', 'train', 'bus', 'car'];
export const PRICE_KINDS = ['indicative', 'bookable'];
export const GROUND_CODES = ['not_set_up', 'bad_request', 'not_found', 'rate_limited', 'unavailable'];

export class GroundError extends Error {
  constructor(code, message) {
    super(message);
    this.code = GROUND_CODES.includes(code) ? code : 'unavailable';
  }
}

export const DATE = /^\d{4}-\d{2}-\d{2}$/;

// A provider's words are data: plain short strings only, no control characters, so nothing a
// provider sends can pass for markup or for an instruction to Eden's model downstream.
export function text(v, max = 200) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
}

const iso = (v) => (typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v)) ? v : null);
const place = (p) => ({ name: text(p && p.name) || 'Unknown', ...(p && text(p.code, 40) ? { code: text(p.code, 40) } : {}) });

/** A journey option in the shared shape (throws on a mode or price kind outside the lists). */
export function journeyOption(o) {
  if (!MODES.includes(o.mode)) throw new Error(`unknown mode ${o.mode}`);
  if (!PRICE_KINDS.includes(o.price_kind)) throw new Error(`unknown price_kind ${o.price_kind}`);
  const depart = iso(o.depart);
  const arrive = iso(o.arrive);
  let duration = Number.isFinite(o.duration_min) ? Math.round(o.duration_min) : null;
  // only work a duration out from times that carry their own offset; a bare local time can't be subtracted safely
  const offset = (s) => /(Z|[+-]\d{2}:\d{2})$/.test(s);
  if (duration === null && depart && arrive && offset(depart) && offset(arrive)) duration = Math.round((Date.parse(arrive) - Date.parse(depart)) / 60_000);
  const price = o.price && Number.isFinite(o.price.amount) && /^[A-Z]{3}$/.test(String(o.price.currency || '')) ? { amount: Math.round(o.price.amount * 100) / 100, currency: o.price.currency } : null;
  return {
    ...o,
    mode: o.mode,
    provider: o.provider,
    id: text(o.id, 300),
    from: place(o.from),
    to: place(o.to),
    depart,
    arrive,
    duration_min: duration !== null && duration >= 0 ? duration : null,
    operator: text(o.operator) || null,
    price,
    price_kind: o.price_kind,
    book_url: o.book_url || null,
    source: o.source,
    checked_at: o.checked_at,
  };
}

/** The ground providers this Worker has switched on: { ferries?, rail?, cars? }. */
export function groundFor(env = {}, deps = {}) {
  const out = {};
  const ferries = ferriesFor(env, deps);
  if (ferries) out.ferries = ferries;
  const rail = railFor(env, deps);
  if (rail) out.rail = rail;
  if (env.EDEN_CARS === '1') out.cars = carsFor(env, deps);
  return out;
}
