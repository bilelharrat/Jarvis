// Shared flight tracking and the airport pickup planner (src/travel/track.js, pickup.js), with a fake FlightAware,
// a fake Google and a fake push. Nothing here reaches Google, FlightAware or Apple.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickupOptions, EXIT_MIN } from '../src/travel/pickup.js';
import { tripOp } from '../src/travel/ops.js';
import { sharePublicOp, CODE } from '../src/travel/track.js';
import { Account, Storage, namespace } from './fakes.js';

const T0 = Date.parse('2026-10-27T09:00:00Z');
const LHR = { code: 'LHR', name: 'London Heathrow', lat: 51.47, lng: -0.4543, country: 'GB' };
const DXB = { code: 'DXB', name: 'Dubai Intl', lat: 25.2528, lng: 55.3644, country: 'AE' };
const flight = (extra = {}) => ({ ident: 'EK1', fa_flight_id: 'UAE1-test', state: 'in_air', status: 'En Route / On Time', origin: { code: 'DXB' }, destination: { code: 'LHR', name: 'Heathrow' }, departure: { actual: '2026-10-27T04:02:00Z' }, arrival: { scheduled: '2026-10-27T11:40:00Z', estimated: '2026-10-27T11:08:00Z', terminal: '3' }, delay_minutes: {}, source: 'FlightAware AeroAPI', checked_at: 'now', ...extra });

// Google, by query: the terminal, then a kerb, a car park and a waiting area near it
function fakeMaps({ none = [] } = {}) {
  const calls = [];
  const P = {
    terminal: { id: 'g-t3', name: 'Heathrow Terminal 3', lat: 51.4713, lng: -0.4546 },
    kerb: { id: 'g-kerb', name: 'Terminal 3 Arrivals Pick-up', lat: 51.4709, lng: -0.4552 },
    parking: { id: 'g-park', name: 'Terminal 3 Short Stay Car Park', lat: 51.4721, lng: -0.4521 },
    sim: { id: 'g-sim', name: 'Sim Local', lat: 51.4712, lng: -0.4549 },
    waiting: { id: 'g-wait', name: 'Heathrow Waiting Area', lat: 51.4801, lng: -0.4402 },
    far: { id: 'g-far', name: 'Somewhere far', lat: 51.6, lng: -0.1 },
  };
  return {
    mode: 'google', calls,
    async search(q) {
      calls.push(['search', q]);
      if (/Terminal 3$/.test(q)) return [P.terminal];
      if (/arrivals pick up/.test(q)) return none.includes('kerb') ? [] : [P.kerb];
      if (/short stay/.test(q)) return none.includes('parking') ? [] : [P.far, P.parking];
      if (/waiting area/.test(q)) return none.includes('waiting') ? [] : [P.sim, P.waiting];
      return [{ id: 'g-home', name: 'Kensington', lat: 51.499, lng: -0.1938 }];
    },
    async travel(a, b, mode) {
      calls.push(['travel', mode, b.name]);
      if (mode === 'drive' && a.name && a.name.includes('Waiting')) return { minutes: 6, meters: 2400, source: 'Google Maps (Routes API)', checked_at: 'now' }; // round to the kerb
      if (mode === 'walk') return { minutes: b.name.includes('Short Stay') ? 6 : 3, meters: 300, source: 'Google Maps (Routes API)', checked_at: 'now' };
      return { minutes: b.name.includes('Waiting') ? 28 : 38, meters: 24000, source: 'Google Maps (Routes API)', checked_at: 'now' };
    },
  };
}

test('pickup: three real places near the terminal, the drive in traffic, when to leave, and the best one', async () => {
  const maps = fakeMaps();
  const r = await pickupOptions({ maps, flight: flight(), airport: LHR, origin: DXB, from: { lat: 51.499, lng: -0.1938 }, now: T0 });
  assert.deepEqual(r.options.map((o) => o.kind), ['kerb', 'parking', 'waiting']);
  assert.equal(r.options[1].place.name, 'Terminal 3 Short Stay Car Park', 'a place more than 5 km from the terminal is skipped');
  assert.equal(r.options[2].place.name, 'Heathrow Waiting Area', 'a SIM shop is not a waiting area');
  assert.equal(r.exit_min, EXIT_MIN.international, 'Dubai → London: passport control and bags');
  assert.match(r.exit_basis, /an estimate/);
  assert.equal(r.ready_at, '2026-10-27T11:48:00.000Z', 'gate 11:08 + 40 min');
  const kerb = r.options[0];
  assert.equal(kerb.out_at, '2026-10-27T11:51:00.000Z', '+ 3 min walk');
  assert.equal(kerb.leave_by, '2026-10-27T11:13:00.000Z', '− 38 min drive');
  assert.equal(kerb.late_min, 0);
  assert.equal(r.options.filter((o) => o.best).length, 1);
  assert.equal(kerb.best, true, 'kerb: 3 min walk beats the waiting area’s 6 min drive round');
  const wait = r.options[2];
  assert.deepEqual([wait.walk.minutes, wait.call_wait.minutes, wait.out_at], [0, 6, '2026-10-27T11:48:00.000Z'], 'the traveller waits at the kerb; the driver comes round');
  assert.match(r.rules, /follow the airport’s signs/);
  assert.ok(r.sources.some((s) => /Google Maps/.test(s)) && r.sources.some((s) => /FlightAware/.test(s)));
  // leaving too late is said plainly
  const late = await pickupOptions({ maps, flight: flight(), airport: LHR, origin: DXB, from: { lat: 51.499, lng: -0.1938 }, now: Date.parse('2026-10-27T11:30:00Z') });
  assert.equal(late.options[0].late_min, 17);
  // a domestic flight, and no kerb place found: the terminal itself is the kerb
  const dom = await pickupOptions({ maps: fakeMaps({ none: ['kerb'] }), flight: flight(), airport: LHR, origin: { ...LHR, code: 'EDI', country: 'GB' }, from: { lat: 51.5, lng: -0.19 }, now: T0 });
  assert.equal(dom.exit_min, EXIT_MIN.domestic);
  assert.equal(dom.options[0].place.name, 'Heathrow Terminal 3');
  assert.equal(dom.options[0].walk.minutes, 0);
  const unknown = await pickupOptions({ maps, flight: flight(), airport: { ...LHR, country: null }, origin: DXB, from: { lat: 51.5, lng: -0.19 }, now: T0 });
  assert.equal(unknown.exit_min, EXIT_MIN.international, 'not known: the longer allowance');
});

function world() {
  const env = { EDEN_TRAVEL: '1' };
  env.ACCOUNTS = namespace(Account, env);
  const owner = { storage: new Storage(), env, t: T0, now() { return this.t; } };
  owner.storage.put('account', { id: 'owner-1' });
  let live = flight();
  const flightaware = { async track() { return live; }, async airport(c) { return c === 'LHR' ? LHR : DXB; }, async position() { return { lat: 45, lng: 30, heading: 300, altitude_ft: 38000, speed_kts: 460, at: new Date(owner.t).toISOString() }; } };
  const pushes = [];
  const deps = { tripOp: (a, o, b) => tripOp(a, o, b, { flightaware }), maps: fakeMaps(), notify: async (acct, p) => { pushes.push(p); return 1; } };
  return { env, owner, deps, pushes, flightaware, setLive: (f) => { live = f; } };
}

test('a guest link: the owner makes it; anyone with it sees the first name and the flight, nothing else', async () => {
  const w = world();
  await assert.rejects(tripOp(w.owner, 'trip-share-create', { ident: 'EK1', date: '2026-10-27' }, { flightaware: w.flightaware }), /first_name/);
  const made = await tripOp(w.owner, 'trip-share-create', { ident: 'ek 1', date: '2026-10-27', first_name: 'Bilel Harrat', trip: '0123456789abcdef' }, { flightaware: w.flightaware });
  assert.match(made.code, CODE);
  assert.equal(made.url, `/f/${made.code}`);
  // the index object knows the account, and only that
  const idx = await (await w.env.ACCOUNTS.get(w.env.ACCOUNTS.idFromName(`trk:${made.code}`)).fetch('https://account/tshare-index-get', { method: 'POST', body: '{}' })).json();
  assert.deepEqual(idx, { account: 'owner-1' });
  const view = await sharePublicOp(w.owner, 'tshare-view', { code: made.code }, w.deps);
  assert.equal(view.first_name, 'Bilel', 'first name only');
  assert.equal(view.live.flight.ident, 'EK1');
  assert.equal(view.live.position.altitude_ft, 38000);
  assert.deepEqual(Object.keys(view).sort(), ['date', 'expires', 'first_name', 'ident', 'live', 'pickup']);
  await assert.rejects(sharePublicOp(w.owner, 'tshare-view', { code: 'aaaaaaaaaaaa' }, w.deps), (e) => e.status === 404);
});

test('the driver picks a spot: saved on the share, pushed to the traveller, seen once they open Eden', async () => {
  const w = world();
  const { code } = await tripOp(w.owner, 'trip-share-create', { ident: 'EK1', date: '2026-10-27', first_name: 'Bilel' }, { flightaware: w.flightaware });
  await assert.rejects(sharePublicOp(w.owner, 'tshare-pick', { code, index: 0 }, w.deps), (e) => e.code === 'stale', 'options first');
  await assert.rejects(sharePublicOp(w.owner, 'tshare-options', { code, from: {} }, w.deps), /Where are you coming from/);
  const opts = await sharePublicOp(w.owner, 'tshare-options', { code, from: { text: 'Kensington' } }, w.deps);
  assert.equal(opts.options.length, 3);
  assert.equal(opts.from.name, 'Kensington');
  const before = w.deps.maps.calls.length;
  await sharePublicOp(w.owner, 'tshare-options', { code, from: { text: 'Kensington' } }, w.deps);
  assert.equal(w.deps.maps.calls.length, before + 1, 'asked again within 10 minutes: one place lookup for the address, nothing else');
  const picked = await sharePublicOp(w.owner, 'tshare-pick', { code, index: 1, name: 'Sam', note: 'Blue Golf, level 2' }, w.deps);
  assert.deepEqual(picked, { saved: true, notified: 1 });
  assert.equal(w.pushes.length, 1);
  assert.match(w.pushes[0].title, /^Sam picked where to meet$/);
  assert.match(w.pushes[0].body, /Short-stay parking, Terminal 3 \(Terminal 3 Short Stay Car Park\) · “Blue Golf, level 2”/);
  assert.deepEqual(w.pushes[0].data, { kind: 'pickup', code });
  const v = await sharePublicOp(w.owner, 'tshare-view', { code }, w.deps);
  assert.equal(v.pickup.name, 'Sam');
  assert.equal(v.pickup.notified, true, 'the page promises a push only when one went out');
  const list = await tripOp(w.owner, 'trip-shares', {});
  assert.equal(list.shares[0].pickup.label, 'Short-stay parking, Terminal 3');
  assert.ok((await w.owner.storage.get(`tsh:${code}`)).pickup.seen_at, 'seen once the traveller’s Eden lists it');
});

test('a link ends 2 hours after landing, or when revoked; at most 10 at once', async () => {
  const w = world();
  const { code } = await tripOp(w.owner, 'trip-share-create', { ident: 'EK1', date: '2026-10-27', first_name: 'Bilel' }, { flightaware: w.flightaware });
  w.setLive(flight({ state: 'landed', arrival: { actual: '2026-10-27T11:05:00Z', terminal: '3' } }));
  w.owner.t = Date.parse('2026-10-27T13:00:00Z');
  assert.equal((await sharePublicOp(w.owner, 'tshare-view', { code }, w.deps)).live.flight.state, 'landed');
  w.owner.t = Date.parse('2026-10-27T13:10:00Z');
  await assert.rejects(sharePublicOp(w.owner, 'tshare-view', { code }, w.deps), (e) => e.status === 404 && /ended/.test(e.message));
  const w2 = world();
  const { code: c2 } = await tripOp(w2.owner, 'trip-share-create', { ident: 'EK1', date: '2026-10-27', first_name: 'Bilel' }, { flightaware: w2.flightaware });
  await tripOp(w2.owner, 'trip-share-revoke', { code: c2 });
  await assert.rejects(sharePublicOp(w2.owner, 'tshare-view', { code: c2 }, w2.deps), (e) => e.status === 404);
  for (let i = 0; i < 9; i++) await tripOp(w2.owner, 'trip-share-create', { ident: 'EK1', date: '2026-10-27', first_name: 'Bilel' }, { flightaware: w2.flightaware });
  await tripOp(w2.owner, 'trip-share-create', { ident: 'EK1', date: '2026-10-27', first_name: 'Bilel' }, { flightaware: w2.flightaware });
  await assert.rejects(tripOp(w2.owner, 'trip-share-create', { ident: 'EK1', date: '2026-10-27', first_name: 'Bilel' }, { flightaware: w2.flightaware }), (e) => e.code === 'too_many');
});
