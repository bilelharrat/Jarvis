// The calendar subscription feed keeps private trip details out (src/travel/calsync.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('the subscription feed carries no notes, links, costs or booking references', async () => {
  const { feedPublicOp } = await import('../src/travel/calsync.js');
  const m = new Map([['tcf:' + 'a'.repeat(32), { code: 'a'.repeat(32) }]]);
  const account = { now: () => Date.parse('2027-05-01T00:00:00Z'), storage: { get: async (k) => m.get(k) } };
  const trip = { title: 'Lisbon', start: '2027-05-12', days: [{ title: 'Day one', stops: [{ id: 's-1', kind: 'stay', at: '15:00', minutes: 60, nights: 2, place: { name: 'Hotel', lat: 38.7, lng: -9.1 }, note: 'Booking ref SECRET-77', link: 'https://x.example/secret', cost: { amount: 999, currency: 'EUR' }, booked: { ref: 'SECRET-88' } }] }] };
  const tripOp = async (_a, op) => (op === 'trip-list' ? { trips: [{ id: 't1' }] } : { trip });
  let out;
  out = await feedPublicOp(account, 'tcal-feed', { code: 'a'.repeat(32) }, { tripOp });
  for (const secret of ['SECRET-77', 'SECRET-88', 'x.example', '999']) assert.ok(!out.ics.includes(secret), secret);
  assert.match(out.ics, /SUMMARY:Hotel/);
});
