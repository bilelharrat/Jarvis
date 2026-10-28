// Flight changes pushed to the traveller (src/travel/watch.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { WATCH, armFlightWatch, flightNews, flightStops, flightWatchDue } from '../src/travel/watch.js';

function fakeAccount(now, trips) {
  const m = new Map(Object.entries(trips).map(([id, t]) => [`trip:${id}`, t]));
  const storage = {
    get: async (k) => m.get(k),
    put: async (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) m.set(a, b); else m.set(k, v); },
    delete: async (k) => m.delete(k),
    list: async ({ prefix }) => new Map([...m].filter(([k]) => k.startsWith(prefix))),
    setAlarm: async () => {},
  };
  return { m, storage, env: { FLIGHTAWARE_API_KEY: 'k' }, now: () => now.t };
}
const trip = { title: 'London', start: '2026-11-03', days: [{ stops: [
  { id: 's-a', kind: 'transport', place: { name: 'Emirates EK1 to London' } },
  { id: 's-b', kind: 'stay', place: { name: 'The Savoy' } },
  { id: 's-c', kind: 'transport', place: { name: 'Taxi to the hotel' } },
] }] };
const flight = (over = {}) => ({ ident: 'EK1', state: 'scheduled', status: 'Scheduled', origin: { code: 'DXB', city: 'Dubai', tz: 'Asia/Dubai' },
  departure: { scheduled: '2026-11-03T03:30:00Z', estimated: '2026-11-03T03:30:00Z', actual: null, gate: null, terminal: '3' }, delay_minutes: { departure: 0 }, ...over });

test('only flight stops are watched', async () => {
  const a = fakeAccount({ t: 0 }, { t1: trip });
  assert.deepEqual(await flightStops(a.storage), [{ trip: 't1', title: 'London', stop: 's-a', ident: 'EK1', date: '2026-11-03' }]);
});

test('news: a delay of 15 min or more, a gate, a terminal change, a cancellation; nothing twice', () => {
  assert.deepEqual(flightNews({ delay: 0, gate: null, terminal: '3' }, flight()), []);
  const late = flightNews({ delay: 0 }, flight({ delay_minutes: { departure: 40 }, departure: { ...flight().departure, estimated: '2026-11-03T04:10:00Z' } }));
  assert.equal(late[0].title, 'EK1 is delayed 40 min');
  assert.match(late[0].body, /Now leaves 08:10 Dubai time/, 'in the airport’s own time');
  assert.deepEqual(flightNews({ delay: 40 }, flight({ delay_minutes: { departure: 45 } })), [], 'a 5-minute wobble is not news');
  assert.equal(flightNews({ delay: 0, gate: 'A3' }, flight({ departure: { ...flight().departure, gate: 'B12' } }))[0].title, 'EK1: gate changed to B12');
  assert.equal(flightNews({ delay: 0, terminal: '1' }, flight())[0].title, 'EK1: now terminal 3');
  assert.deepEqual(flightNews({ state: 'scheduled' }, flight({ state: 'cancelled' })).map((n) => n.title), ['EK1 is cancelled']);
  assert.deepEqual(flightNews({ state: 'cancelled' }, flight({ state: 'cancelled' })), []);
});

test('the job: waits until a day before, pushes a change once, looks more often near departure, stops after landing', async () => {
  const clock = { t: Date.parse('2026-11-01T12:00:00Z') };
  const a = fakeAccount(clock, { t1: trip });
  assert.equal(await armFlightWatch(a), Date.parse('2026-11-02T00:00:00Z'), 'first look a day before the planned day');
  let f = flight();
  const calls = [];
  const pushes = [];
  const tripOp = async (_a, op, body) => { calls.push([op, body]); return { flight: f }; };
  const notify = async (_a, n) => { pushes.push(n); return 1; };
  clock.t = Date.parse('2026-11-02T10:00:00Z');
  await flightWatchDue(a, { tripOp, notify });
  assert.deepEqual(calls, [['trip-flight', { ident: 'EK1', date: '2026-11-03' }]]);
  assert.equal(pushes.length, 0, 'on time, no gate yet: no push');
  assert.equal(a.m.get('fwsnap:EK1:2026-11-03').next, clock.t + WATCH.farMs);
  await flightWatchDue(a, { tripOp, notify });
  assert.equal(calls.length, 1, 'not before its next look');
  clock.t = Date.parse('2026-11-03T01:00:00Z');
  f = flight({ departure: { ...flight().departure, gate: 'B12' } });
  await flightWatchDue(a, { tripOp, notify });
  assert.equal(pushes[0].title, 'EK1 leaves from gate B12');
  assert.deepEqual(pushes[0].data, { kind: 'flight', trip: 't1', stop: 's-a', ident: 'EK1' });
  assert.equal(a.m.get('fwsnap:EK1:2026-11-03').next, clock.t + WATCH.nearMs, 'within 3 hours: every 10 minutes');
  clock.t += WATCH.nearMs;
  await flightWatchDue(a, { tripOp, notify });
  assert.equal(pushes.length, 1, 'the same gate is not pushed again');
  clock.t += WATCH.nearMs;
  f = flight({ state: 'landed', departure: { ...flight().departure, gate: 'B12', actual: '2026-11-03T03:35:00Z' } });
  await flightWatchDue(a, { tripOp, notify });
  assert.equal(a.m.get('fwsnap:EK1:2026-11-03').done, true);
  assert.equal(await armFlightWatch(a), null, 'landed: nothing left to watch');
});

test('no FlightAware key: nothing is scheduled', async () => {
  const a = fakeAccount({ t: 0 }, { t1: trip });
  a.env = {};
  assert.equal(await armFlightWatch(a), null);
});
