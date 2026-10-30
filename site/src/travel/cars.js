// Eden Travel's car hire: CarTrawler, once we have its partner spec. CarTrawler publishes no API
// docs, so there are no endpoints here on purpose: nothing is guessed.
//
// search() answers GroundError('not_set_up') unless EDEN_CARS === "1". With EDEN_CARS on and
// EDEN_CARS_STANDIN === "1" it answers a stand-in instead, for building the page: every result is
// `standin: true` with source 'Stand-in (not real prices)', and no booking link, so a badge can
// never show it as a real quote. Without the stand-in switch it is still not_set_up.

import { GroundError, journeyOption, text } from './ground.js';

export const STANDIN_SOURCE = 'Stand-in (not real prices)';
const NOT_SET_UP = 'Car hire needs CarTrawler’s partner spec.';
const WHEN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:\d{2})?)?$/;

// Sample classes and day rates: round numbers, labelled as samples.
const STANDIN_CARS = [
  { id: 'standin:car-economy', class: 'Economy', example: 'Fiat 500 or similar', day: 30 },
  { id: 'standin:car-compact', class: 'Compact', example: 'VW Golf or similar', day: 42 },
  { id: 'standin:car-suv', class: 'SUV', example: 'Nissan Qashqai or similar', day: 65 },
];

function check({ pickup, dropoff, from, to, driver_age }) {
  if (!text(pickup) || String(pickup).length > 120) throw new GroundError('bad_request', 'pickup is a place name or airport code.');
  if (dropoff !== undefined && dropoff !== null && (!text(dropoff) || String(dropoff).length > 120)) throw new GroundError('bad_request', 'dropoff is a place name or airport code.');
  if (!WHEN.test(String(from || '')) || !WHEN.test(String(to || '')) || Date.parse(to) <= Date.parse(from)) throw new GroundError('bad_request', 'from and to are dates or times, to after from.');
  const age = Number(driver_age);
  if (!Number.isInteger(age) || age < 18 || age > 99) throw new GroundError('bad_request', 'driver_age is 18 to 99.');
  return age;
}

/** Car hire: always an object, so the page gets a clear not_set_up rather than a missing provider. */
export function carsFor(env = {}, { now = () => Date.now() } = {}) {
  const on = env.EDEN_CARS === '1';
  const standin = on && env.EDEN_CARS_STANDIN === '1';
  return {
    mode: 'car',
    standin,
    async search(q = {}) {
      if (!standin) throw new GroundError('not_set_up', NOT_SET_UP);
      const age = check(q);
      const days = Math.max(1, Math.ceil((Date.parse(q.to) - Date.parse(q.from)) / 86400_000));
      const young = age < 25 ? 1.25 : 1; // the usual young-driver surcharge shape, sample only
      const at = new Date(now()).toISOString();
      return STANDIN_CARS.map((c) => journeyOption({
        mode: 'car',
        provider: 'standin',
        id: c.id,
        from: { name: text(q.pickup) },
        to: { name: text(q.dropoff) || text(q.pickup) },
        depart: q.from,
        arrive: q.to,
        duration_min: null,
        operator: null,
        price: { amount: c.day * days * young, currency: 'EUR' },
        price_kind: 'indicative',
        book_url: null,
        car_class: c.class,
        car_example: c.example,
        standin: true,
        source: STANDIN_SOURCE,
        checked_at: at,
      }));
    },
  };
}
