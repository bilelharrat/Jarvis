// Planning together, the live part (travel/together.js): who has the trip open now, who looks after a stop (trips.js
// owner op), and copying a trip (the organiser's own, or one shared with you). Fake storage, stand-in maps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESENCE, copyOf, togetherApi, togetherMemberOp, togetherOp, tripPeople } from '../src/travel/together.js';
import { applyOps, cleanStop } from '../src/travel/trips.js';
import { tripOp } from '../src/travel/ops.js';
import { standinMaps } from '../src/travel/maps.js';

const T0 = Date.parse('2026-10-28T12:00:00Z');
const OWNER = '11111111-1111-4111-8111-111111111111';
const SAM = '22222222-2222-4222-8222-222222222222';
const LEE = '33333333-3333-4333-8333-333333333333';
const TID = 'a1b2c3d4e5f60718';

function account(id = OWNER, { trip = true } = {}) {
  const m = new Map();
  const clock = { t: T0 };
  const storage = {
    get: async (k) => m.get(k),
    put: async (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) m.set(a, b); else m.set(k, v); },
    delete: async (k) => { for (const x of [].concat(k)) m.delete(x); return true; },
    list: async ({ prefix }) => new Map([...m].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))),
    setAlarm: async () => {},
  };
  m.set('account', { id });
  if (trip) {
    m.set(`trip:${TID}`, lisbon());
    m.set(`tppl:${TID}`, { owner_name: 'Bilel', guests: [{ id: 'g-0a0b0c0d', name: 'Grandma' }] });
    m.set(`tmem:${TID}:${SAM}`, { member: SAM, name: 'Sam', joined: T0 });
  }
  return { m, storage, env: {}, now: () => clock.t, clock };
}
const stop = (id, name, at, more = {}) => ({ id, kind: 'visit', place: { id: `standin:${id}`, name, lat: 38.71, lng: -9.14 }, at, minutes: 60, mode: 'walk', cost: null, nights: null, link: null, booked: null, note: '', owner: null, ...more });
function lisbon() {
  return {
    title: 'Lisbon', destination: 'Lisbon', start: '2026-11-28', travelers: 3, budget: { amount: 900, currency: 'EUR' }, access: null, rev: 1, created: T0, updated: T0,
    days: [
      { title: 'Arrive', stops: [
        stop('s-hotel', 'A hotel in Baixa', '11:00', { kind: 'stay', nights: 2, cost: { amount: 300, currency: 'EUR' }, booked: { kind: 'stay', ref: 'H1', provider: 'Hotel', via: 'forward', at: T0 }, note: 'From your forwarded email: Booking H1' }),
        stop('s-lunch', 'Lunch in Alfama', '13:00', { kind: 'meal', cost: { amount: 24, currency: 'EUR' }, note: 'Ask for the terrace' }),
      ] },
      { title: 'Belém', stops: [stop('s-jer', 'Jerónimos Monastery', '10:00', { owner: SAM })] },
    ],
  };
}
const newId = (() => { let n = 0; return () => `s-new${++n}`; })();

// ── who looks after a stop ──

test('owner op: one of the trip’s people, or nobody; a booked stop too; anyone else refused', async () => {
  const a = account();
  const people = await tripPeople(a, TID);
  assert.deepEqual([...people].sort(), [OWNER, SAM, 'g-0a0b0c0d'].sort());
  const trip = lisbon();
  const { trip: t1, changed } = applyOps(trip, [{ op: 'owner', stop: 's-lunch', owner: SAM }, { op: 'owner', stop: 's-hotel', owner: 'g-0a0b0c0d' }], { newId, people });
  assert.equal(t1.days[0].stops.find((s) => s.id === 's-lunch').owner, SAM);
  assert.equal(t1.days[0].stops.find((s) => s.id === 's-hotel').owner, 'g-0a0b0c0d'); // booked: still fine
  assert.deepEqual(changed, { 's-lunch': 'edited', 's-hotel': 'edited' });
  assert.equal(trip.days[0].stops[1].owner, null, 'the trip passed in is untouched');
  const { trip: t2 } = applyOps(t1, [{ op: 'owner', stop: 's-lunch', owner: null }], { newId, people });
  assert.equal(t2.days[0].stops[1].owner, null);
  assert.throws(() => applyOps(trip, [{ op: 'owner', stop: 's-lunch', owner: LEE }], { newId, people }), /one of the people/);
  assert.throws(() => applyOps(trip, [{ op: 'owner', stop: 's-lunch', owner: SAM }], { newId }), /one of the people/, 'no people handed in: refused');
  assert.throws(() => applyOps(trip, [{ op: 'owner', stop: 's-nope', owner: SAM }], { newId, people }), /no stop/);
});

test('owner survives edits; an added stop keeps an owner only if they’re on the trip', async () => {
  const people = new Set([OWNER, SAM]);
  const { trip } = applyOps(lisbon(), [{ op: 'edit', stop: 's-jer', minutes: 90 }, { op: 'move', stop: 's-jer', day: 0 }], { newId, people });
  assert.equal(trip.days[0].stops.find((s) => s.id === 's-jer').owner, SAM);
  const add = (owner) => applyOps(lisbon(), [{ op: 'add', day: 1, stop: { place: { name: 'MAAT' }, at: '15:00', owner } }], { newId, people }).trip.days[1].stops.find((s) => s.place.name === 'MAAT');
  assert.equal(add(SAM).owner, SAM);
  assert.equal(add(LEE).owner, null);
  assert.equal(cleanStop({ place: { name: 'X' }, at: '09:00', owner: 'not an id' }, newId).owner, null);
});

// ── presence ──

test('presence: the organiser and a member see each other, with day and view; a beat older than a minute drops out', async () => {
  const a = account();
  const first = await togetherOp(a, 'trip-presence-beat', { id: TID, day: 0, view: 'workspace' }, {});
  assert.deepEqual(first.present.map((p) => [p.name, p.day, p.view, p.me]), [['Bilel', 0, 'workspace', true]]);
  assert.equal(first.me, OWNER);
  assert.equal(first.beat_s, PRESENCE.beat_s);
  assert.ok(first.people.some((p) => p.id === 'g-0a0b0c0d' && p.name === 'Grandma'), 'names for stop owners');
  a.clock.t += 20_000;
  const sam = await togetherMemberOp(a, 'tmember-presence-beat', { trip: TID, member: SAM, day: 1, view: 'map' });
  assert.deepEqual(sam.present.map((p) => [p.name, p.day, p.view, p.me]), [['Sam', 1, 'map', true], ['Bilel', 0, 'workspace', false]]);
  assert.equal(sam.me, SAM);
  a.clock.t += PRESENCE.ms; // the organiser stopped beating (page hidden)
  const later = await togetherMemberOp(a, 'tmember-presence-beat', { trip: TID, member: SAM, day: 99, view: 'Not A View!' });
  assert.deepEqual(later.present.map((p) => [p.name, p.day, p.view]), [['Sam', null, null]]);
  assert.equal(a.m.has(`tpres:${TID}:${OWNER}`), false, 'pruned on read');
});

test('presence: someone taken off the trip disappears at once and can’t beat; a stranger can’t either', async () => {
  const a = account();
  await togetherMemberOp(a, 'tmember-presence-beat', { trip: TID, member: SAM, day: 0 });
  a.m.delete(`tmem:${TID}:${SAM}`);
  const out = await togetherOp(a, 'trip-presence-beat', { id: TID, day: 0 }, {});
  assert.deepEqual(out.present.map((p) => p.id), [OWNER]);
  await assert.rejects(togetherMemberOp(a, 'tmember-presence-beat', { trip: TID, member: SAM }), /not on this trip/);
  await assert.rejects(togetherMemberOp(a, 'tmember-presence-beat', { trip: TID, member: LEE }), /not on this trip/);
  await assert.rejects(togetherOp(a, 'trip-presence-beat', { id: 'ffffffffffffffff' }, {}), /no such trip/);
});

// ── copying a trip ──

test('copyOf: the days and stops, without booked state, what was paid and the booking’s note; says so', () => {
  const { trip, removed, note } = copyOf(lisbon(), { start: '2027-05-01' });
  assert.equal(trip.title, 'Lisbon (copy)');
  assert.equal(trip.start, '2027-05-01');
  const hotel = trip.days[0].stops[0], lunch = trip.days[0].stops[1], jer = trip.days[1].stops[0];
  assert.deepEqual([hotel.booked, hotel.cost, hotel.note], [null, null, '']);
  assert.deepEqual(lunch.cost, { amount: 24, currency: 'EUR' }, 'an unbooked stop’s estimate stays');
  assert.equal(lunch.note, 'Ask for the terrace');
  assert.equal(jer.owner, null, 'nobody in charge in the copy');
  assert.deepEqual(removed, { bookings: 1, costs: 1, notes: 1 });
  assert.match(note, /without its 1 booking \(and their 1 cost paid and 1 note\)/);
  assert.equal(copyOf({ ...lisbon(), days: [{ title: 'x', stops: [] }] }).note, 'Copied. Expenses, chat and documents stay with the first trip.');
});

test('trip-copy makes a new trip of the organiser’s own; the first is unchanged; a bad date is refused', async () => {
  const a = account();
  const maps = standinMaps(a.now);
  const op = (acct, o, b) => tripOp(acct, o, b, { maps });
  const out = await togetherOp(a, 'trip-copy', { id: TID, start: '2027-05-01' }, { tripOp: op });
  assert.notEqual(out.trip.id, TID);
  assert.equal(out.trip.start, '2027-05-01');
  assert.equal(out.removed.bookings, 1);
  assert.ok(out.checks);
  assert.equal(a.m.get(`trip:${out.trip.id}`).days[0].stops[0].booked, null);
  assert.ok(a.m.get(`trip:${TID}`).days[0].stops[0].booked, 'the original keeps its booking');
  await assert.rejects(togetherOp(a, 'trip-copy', { id: TID, start: 'soon' }, { tripOp: op }), /start must be a date/);
});

test('shared-copy: read through the organiser’s object, made in the member’s own account; only while on the trip', async () => {
  const org = account(OWNER), mem = account(SAM, { trip: false });
  const accounts = { [OWNER]: org, [SAM]: mem };
  const ask = async (_env, owner, op, body) => togetherMemberOp(accounts[owner], op, body);
  const call = async (_env, acct, op, body, token) => { assert.equal(token, 'tok'); return tripOp(accounts[acct], op, body, { maps: standinMaps(mem.now) }); };
  const who = { account: SAM, token: 'tok' };
  const out = await togetherApi({}, who, 'shared-copy', { owner: OWNER, trip: TID }, { call, ask });
  assert.ok(mem.m.has(`trip:${out.trip.id}`), 'in the member’s account');
  assert.equal([...org.m.keys()].filter((k) => k.startsWith('trip:')).length, 1, 'nothing new in the organiser’s');
  assert.equal(out.trip.days[0].stops[0].booked, null);
  assert.match(out.note, /1 booking/);
  const here = await togetherApi({}, who, 'shared-presence-beat', { owner: OWNER, trip: TID, day: 1, view: 'board' }, { call, ask });
  assert.deepEqual(here.present.map((p) => [p.name, p.day, p.view]), [['Sam', 1, 'board']]);
  org.m.delete(`tmem:${TID}:${SAM}`);
  await assert.rejects(togetherApi({}, who, 'shared-copy', { owner: OWNER, trip: TID }, { call, ask }), /not on this trip/);
  await assert.rejects(togetherApi({}, who, 'shared-nope', {}, { call, ask }), /Unknown/);
});
