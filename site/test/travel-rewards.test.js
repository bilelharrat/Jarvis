// Eden Rewards (src/travel/rewards.js): the append-only ledger (one event pays once), expiry oldest first, status math,
// redemption guards and undo, and a Plus month that never runs beside a paid plan. Fakes only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { REWARDS, TERMS, aiExtraUsd, earn, earnBooking, earnReferral, earnShare, expiryOf, hasEarlyAccess, ledgerState, photoCaps, plusBonusNow, referrerOf, rewardsOp, rewardsRecheckTimes, settleTrips, tierOf, tripTaken } from '../src/travel/rewards.js';
import { PHOTOS } from '../src/travel/memories.js';

// most tests here count any ended trip with a stop; the default asks for a booked one (tripEvidence), tested on its own
const EVIDENCE = REWARDS.tripEvidence;
REWARDS.tripEvidence = null;

const DAY = 86400_000;
const T0 = Date.parse('2026-12-10T12:00:00Z');
const MEMBER = '22222222-2222-4222-8222-222222222222';

function account({ now = T0, plan = { active: true } } = {}) {
  const m = new Map();
  const storage = {
    get: async (k) => m.get(k),
    put: async (k, v) => { if (typeof k === 'object') for (const [a, b] of Object.entries(k)) m.set(a, structuredClone(b)); else m.set(k, structuredClone(v)); },
    delete: async (k) => { for (const x of [].concat(k)) m.delete(x); return true; },
    list: async ({ prefix }) => new Map([...m].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  const a = { m, storage, env: {}, t: now, now: () => a.t, paid: plan.active };
  // planNow as account.js would have it with the hook: other Plus first, then the bonus fills the gaps
  a.planNow = async () => { const b = await plusBonusNow(storage, a.paid, a.t); return { active: a.paid || b.running, bonus: b }; };
  return a;
}
const trip = (start, n, o = {}) => ({ title: 'Lisbon', start, created: Date.parse(start) - 30 * DAY, days: Array.from({ length: n }, () => ({ stops: [{ id: 's-1', kind: 'visit', booked: null }] })), ...o });
const balance = async (a) => (await rewardsOp(a, 'trip-rewards', {})).balance;
const give = (a, points, ref = `test:${points}-${a.m.size}`) => earn(a, 'share', ref, points); // an unrated reason

test('a trip pays once, after it ends, by its days; a booking pays once per booking', async () => {
  const a = account();
  a.m.set('trip:aaaaaaaaaaaaaaaa', trip('2026-12-01', 4)); // ended
  a.m.set('trip:bbbbbbbbbbbbbbbb', trip('2026-12-09', 3)); // still on
  a.m.set('trip:cccccccccccccccc', trip('2026-11-01', 2, { days: [{ stops: [] }, { stops: [] }] })); // no stops
  a.m.set('trip:dddddddddddddddd', trip('2026-11-01', 2, { created: T0 - DAY })); // typed in after it happened
  assert.equal(await balance(a), 4 * REWARDS.earn.tripDay);
  assert.equal(await balance(a), 200); // again: no second payment
  assert.equal((await settleTrips(a)).length, 0);
  assert.equal((await earnBooking(a, 'flight', 'ord_123')).already, false);
  assert.equal((await earnBooking(a, 'flight', 'ord_123')).already, true);
  assert.equal(await earnBooking(a, 'spaceship', 'x'), null);
  await earnShare(a, 'aaaaaaaaaaaaaaaa');
  await earnShare(a, 'aaaaaaaaaaaaaaaa');
  assert.equal(await balance(a), 200 + 100 + 10);
  a.t = Date.parse('2026-12-13T12:00:00Z'); // the second trip has now ended
  assert.equal(await balance(a), 460);
});

test('tripTaken: the end has a grace for time zones; tripEvidence can ask for a real booking', () => {
  const t = trip('2026-12-01', 2); // last day 12-02: ends 12-03 00:00Z + 12 h
  assert.equal(tripTaken(t, Date.parse('2026-12-03T11:00:00Z')), null);
  assert.deepEqual(tripTaken(t, Date.parse('2026-12-03T12:00:00Z')), { days: 2, end: '2026-12-02', end_at: Date.parse('2026-12-03T12:00:00Z') });
  REWARDS.tripEvidence = ['api', 'mail', 'forward'];
  try {
    assert.equal(tripTaken(t, T0), null);
    t.days[0].stops[0].booked = { via: 'person' };
    assert.equal(tripTaken(t, T0), null);
    t.days[0].stops[0].booked = { via: 'api' };
    assert.equal(tripTaken(t, T0).days, 2);
  } finally { REWARDS.tripEvidence = null; }
  assert.equal(EVIDENCE, 'paid', 'the default: a trip earns only with a stop under a paid Eden booking (travel-rewards-paid.test.js)');
  assert.equal(tripTaken(trip('2026-01-01', 40), T0).days, REWARDS.earn.tripMaxDays);
});

test('expiry: 24 months after earning, spent oldest first, shown before it goes', async () => {
  const a = account();
  await give(a, 100, 'test:old');
  a.t = T0 + 400 * DAY;
  await give(a, 300, 'test:new');
  REWARDS.catalogue.ai_extra.points = 150;
  try {
    await rewardsOp(a, 'trip-rewards-redeem', { item: 'ai_extra', confirm: true }); // takes 100 old + 50 new
  } finally { REWARDS.catalogue.ai_extra.points = 500; }
  assert.equal(expiryOf(T0), Date.parse('2028-12-10T12:00:00Z'));
  a.t = expiryOf(T0) + 1; // the old lot is gone, but it was spent already: nothing lost
  let r = await rewardsOp(a, 'trip-rewards', {});
  assert.equal(r.balance, 250);
  assert.equal(r.expired, 0);
  a.t = expiryOf(T0 + 400 * DAY) - 30 * DAY;
  r = await rewardsOp(a, 'trip-rewards', {});
  assert.deepEqual(r.expiring, [{ points: 250, on: new Date(expiryOf(T0 + 400 * DAY)).toISOString().slice(0, 10) }]);
  a.t = expiryOf(T0 + 400 * DAY);
  r = await rewardsOp(a, 'trip-rewards', {});
  assert.equal(r.balance, 0);
  assert.equal(r.expired, 250);
});

test('ledgerState: an undo gives back the very lots it took, with their own expiry', () => {
  const e = [
    { n: 1, kind: 'earn', amount: 100, at: 0, expires: 1000 },
    { n: 2, kind: 'earn', amount: 100, at: 10, expires: 2000 },
    { n: 3, kind: 'redeem', amount: -150, at: 20, ref: 'red:0000000001' },
    { n: 4, kind: 'undo', amount: 150, at: 30, ref: 'undo:0000000001', meta: { redemption: 'red:0000000001' } },
    { n: 5, kind: 'undo', amount: 150, at: 31, ref: 'undo:x', meta: { redemption: 'red:0000000001' } }, // a second undo does nothing
  ];
  assert.equal(ledgerState(e, 500).balance, 200);
  assert.deepEqual([ledgerState(e, 1500).balance, ledgerState(e, 1500).expired], [100, 100]);
  assert.equal(ledgerState(e.slice(0, 3), 500).balance, 50);
  assert.equal(ledgerState(e.slice(0, 3), 1500).balance, 50); // the old lot went first
});

test('status: trips that earned in the last 12 months; progress to the next; the rate multiplies trips and bookings', async () => {
  const at = (n, days, end) => ({ n, kind: 'earn', reason: 'trip', amount: 1, meta: { days, end_at: end } });
  assert.equal(tierOf([], T0).tier.id, 'explorer');
  assert.equal(tierOf([], T0).progress.text, '3 more trips or 15 more travel days in 12 months to reach Voyager.');
  assert.equal(tierOf([at(1, 2, T0 - DAY), at(2, 2, T0 - DAY), at(3, 2, T0 - DAY)], T0).tier.id, 'voyager');
  assert.equal(tierOf([at(1, 15, T0 - DAY)], T0).tier.id, 'voyager');
  assert.equal(tierOf([at(1, 45, T0 - DAY)], T0).tier.id, 'navigator');
  assert.equal(tierOf([at(1, 45, T0 - 366 * DAY)], T0).tier.id, 'explorer'); // older than 12 months
  assert.equal(tierOf([at(1, 45, T0 - DAY)], T0).progress.next, null);
  const v = tierOf([at(1, 5, T0 - DAY)], T0).progress;
  assert.deepEqual([v.trips, v.days], [{ have: 1, need: 3 }, { have: 5, need: 15 }]);
  // a Voyager earns 25% more on a booking, not on a share
  const a = account();
  a.m.set('trip:aaaaaaaaaaaaaaaa', trip('2026-11-01', 16));
  await settleTrips(a);
  assert.equal((await earnBooking(a, 'stay', 'bk_1')).entry.amount, 125);
  assert.equal((await earnShare(a, 'aaaaaaaaaaaaaaaa')).entry.amount, 10);
  assert.equal((await photoCaps(a)).perTrip, 400);
  assert.deepEqual(REWARDS.tiers[0].photos, { perTrip: PHOTOS.perTrip, accountBytes: PHOTOS.accountBytes });
});

test('redeem: confirm, enough points, a real item; extra AI needs Plus and ends with the month', async () => {
  const a = account();
  await assert.rejects(rewardsOp(a, 'trip-rewards-redeem', { item: 'ai_extra' }), /confirm/);
  await assert.rejects(rewardsOp(a, 'trip-rewards-redeem', { item: 'cash', confirm: true }), /no such reward/);
  await assert.rejects(rewardsOp(a, 'trip-rewards-redeem', { item: 'ai_extra', confirm: true }), /500 more points/);
  await give(a, 1000);
  const r = await rewardsOp(a, 'trip-rewards-redeem', { item: 'ai_extra', confirm: true });
  assert.equal(r.balance, 500);
  assert.equal(aiExtraUsd(a.m.get('rwd:ai'), T0), 2);
  assert.equal(aiExtraUsd(a.m.get('rwd:ai'), Date.parse('2027-01-01T00:00:00Z')), 0);
  const free = account({ plan: { active: false } });
  await give(free, 1000);
  await assert.rejects(rewardsOp(free, 'trip-rewards-redeem', { item: 'ai_extra', confirm: true }), /needs Plus/);
  await assert.rejects(rewardsOp(a, 'trip-rewards-redeem', { item: 'early_access', confirm: true, flag: 'nope' }), /no such feature/);
  REWARDS.early.beta_film = 'The new film maker';
  try {
    await rewardsOp(a, 'trip-rewards-redeem', { item: 'early_access', confirm: false, flag: 'beta_film' }).catch(() => {});
    assert.equal(await hasEarlyAccess(a.storage, 'beta_film'), false);
  } finally { delete REWARDS.early.beta_film; }
});

test('undo: within 24 hours and only while unused', async () => {
  const a = account();
  await give(a, 2000);
  const ai = await rewardsOp(a, 'trip-rewards-redeem', { item: 'ai_extra', confirm: true });
  const ref = ai.redemption.ref;
  await assert.rejects(rewardsOp(a, 'trip-rewards-undo', { redemption: ref }, { ai: async () => ({ spent: 9, cap: 10 }) }), /been used/); // 9 > 10 − 2
  const u = await rewardsOp(a, 'trip-rewards-undo', { redemption: ref }, { ai: async () => ({ spent: 7, cap: 10 }) });
  assert.equal(u.balance, 2000);
  assert.equal(aiExtraUsd(a.m.get('rwd:ai'), T0), 0);
  await assert.rejects(rewardsOp(a, 'trip-rewards-undo', { redemption: ref }), /already undone/);
  const again = await rewardsOp(a, 'trip-rewards-redeem', { item: 'ai_extra', confirm: true });
  a.t = T0 + DAY + 1;
  await assert.rejects(rewardsOp(a, 'trip-rewards-undo', { redemption: again.redemption.ref }, { ai: async () => ({ spent: 0, cap: 10 }) }), /within 24 hours/);
  await assert.rejects(rewardsOp(a, 'trip-rewards-undo', { redemption: 'red:zzz' }), /redemption’s ref/);
});

test('a Plus month never runs beside a paid plan: banked while paid, starts when it ends, pauses if paid comes back', async () => {
  const a = account(); // paid Plus on
  await give(a, 6000);
  const r = await rewardsOp(a, 'trip-rewards-redeem', { item: 'plus_month', confirm: true });
  assert.equal(r.active.plus_bonus.running_until, null);
  assert.equal(r.active.plus_bonus.banked_days, 30);
  // unused (still banked): undo works
  await rewardsOp(a, 'trip-rewards-undo', { redemption: r.redemption.ref });
  assert.equal(a.m.get('plus_bonus_until').banked_ms, 0);
  await rewardsOp(a, 'trip-rewards-redeem', { item: 'plus_month', confirm: true });
  // the paid plan ends 10 days later: the month starts then
  a.t = T0 + 10 * DAY; a.paid = false;
  let plan = await a.planNow();
  assert.equal(plan.active, true);
  assert.equal(plan.bonus.until, T0 + 40 * DAY);
  // 5 days in, they subscribe again: the bonus stops, 25 days go back in the bank (never paid and free at once)
  a.t = T0 + 15 * DAY; a.paid = true;
  plan = await a.planNow();
  assert.equal(plan.bonus.running, false);
  assert.equal(plan.bonus.banked_ms, 25 * DAY);
  // no paid plan at all: it starts at once, and then it's used (no undo)
  const b = account({ plan: { active: false } });
  await give(b, 3000);
  const s = await rewardsOp(b, 'trip-rewards-redeem', { item: 'plus_month', confirm: true });
  assert.equal(s.active.plus_bonus.running_until, new Date(T0 + 30 * DAY).toISOString());
  assert.equal((await b.planNow()).active, true);
  await assert.rejects(rewardsOp(b, 'trip-rewards-undo', { redemption: s.redemption.ref }), /been used/);
});

test('priority re-checks: hourly for one trip, from the day before, capped; the status adds its own', async () => {
  const a = account();
  await give(a, 1000);
  const id = 'aaaaaaaaaaaaaaaa';
  a.m.set(`trip:${id}`, trip('2026-12-20', 3));
  await assert.rejects(rewardsOp(a, 'trip-rewards-redeem', { item: 'priority_recheck', confirm: true, trip: 'bbbbbbbbbbbbbbbb' }), /no such trip/);
  const r = await rewardsOp(a, 'trip-rewards-redeem', { item: 'priority_recheck', confirm: true, trip: id });
  await assert.rejects(rewardsOp(a, 'trip-rewards-redeem', { item: 'priority_recheck', confirm: true, trip: id }), /already has/);
  const times = await rewardsRecheckTimes(a, id, a.m.get(`trip:${id}`));
  assert.equal(times[0], Date.parse('2026-12-19T00:00:00Z'));
  assert.equal(times.length, 4 * 24); // the day before + 3 days, every hour
  // a re-check before the window doesn't count as use; one inside it does
  a.m.set(`tchk:${id}`, { ran: T0 + 1 });
  await rewardsOp(a, 'trip-rewards-undo', { redemption: r.redemption.ref });
  assert.equal((await rewardsRecheckTimes(a, id, a.m.get(`trip:${id}`))).length, 0);
  a.m.set('trip:cccccccccccccccc', trip('2026-11-01', 2, { created: 0 }));
  await assert.rejects(rewardsOp(a, 'trip-rewards-redeem', { item: 'priority_recheck', confirm: true, trip: 'cccccccccccccccc' }), /ended/);
  // Navigator: 3 days before, and every 6 hours during the trip
  a.m.set('rwd:tier', { id: 'navigator', at: T0 });
  const nav = await rewardsRecheckTimes(a, id, a.m.get(`trip:${id}`));
  assert.equal(nav[0], Date.parse('2026-12-17T07:00:00Z'));
  assert.equal(nav.length, 1 + 11); // 07:00 day 1, then every 6 hours to the end of day 3
});

test('referrals: once per member, only someone on one of your trips; another account’s id never shows', async () => {
  const a = account();
  assert.equal(await earnReferral(a, MEMBER), null); // not on any of this account's trips
  a.m.set(`tmem:aaaaaaaaaaaaaaaa:${MEMBER}`, { member: MEMBER });
  assert.equal((await earnReferral(a, MEMBER)).entry.amount, REWARDS.earn.referral);
  assert.equal((await earnReferral(a, MEMBER)).already, true);
  const r = await rewardsOp(a, 'trip-rewards', {});
  assert.equal(r.balance, REWARDS.earn.referral);
  assert.ok(!JSON.stringify(r).includes(MEMBER));
  const m = account();
  m.m.set('tjoin:33333333-3333-4333-8333-333333333333:aaaaaaaaaaaaaaaa', { owner: '33333333-3333-4333-8333-333333333333', joined: 5 });
  m.m.set(`tjoin:${MEMBER}:bbbbbbbbbbbbbbbb`, { owner: MEMBER, joined: 2 });
  assert.equal(await referrerOf(m.storage), MEMBER);
});

test('the panel: catalogue says why not, terms say no cash value, the ledger pages', async () => {
  const a = account();
  for (let i = 0; i < 60; i++) await give(a, 10, `test:p${i}`);
  const r = await rewardsOp(a, 'trip-rewards', {});
  assert.equal(r.ledger.entries.length, 50);
  assert.equal(r.ledger.more, true);
  assert.equal((await rewardsOp(a, 'trip-rewards', { page: 1 })).ledger.entries.length, 10);
  const plus = r.catalogue.find((c) => c.item === 'plus_month');
  assert.equal(plus.can, false);
  assert.equal(plus.why, 'You need 2400 more points.');
  assert.equal(r.catalogue.find((c) => c.item === 'early_access').why, 'Nothing to unlock early right now.');
  assert.match(TERMS.points[0], /no cash value/);
  assert.equal(r.tier.id, 'explorer');
});
