// Eden Rewards: points for travelling with Eden, with NO cash value, redeemable only for Eden things (the owner's
// decision, 2026-10-28: Plus is the membership, Rewards and status are its perks). Nothing here is money: points can't
// be bought, sold, transferred or paid out, and every number below is a config the owner can change (REWARDS).
//
// The ledger, in the account's own object, append-only: rwd:e:<n> → { n, kind: 'earn'|'redeem'|'undo', reason, amount,
// at, ref, expires?, meta } and rwd:ref:<ref> → n, so one event (a trip, a booking, a redemption) is written once
// however often it arrives. The balance is never stored: it's derived from the entries (ledgerState), each earn a lot
// that expires REWARDS.expiryMonths after it was earned, spent oldest first (FIFO), an undo giving back the same lots.
//
// Earned on:  a trip taken (once it has ended, once per trip, by its days: settleTrips) · a booking made through Eden
// (earnBooking: flight, stay, rail, activity; per booking, not per price) · a recap shared with the people on the trip
// (earnShare, once per trip) · hooks only for now: an accuracy report confirmed useful (earnAccuracy) and a person you
// invited who joins Plus (earnReferral, on the inviter's object; referrerOf on the member's).
// Status (tierOf): Explorer, Voyager, Navigator, from the trips that earned points in the last 12 months.
// Spent on (the catalogue): a Plus month (plus_bonus_until: runs only while no other Plus is on, else banked: never
// beside a paid plan, so nobody pays for a month they also redeemed), extra AI this month (rwd:ai, read by account.js
// plusCap through aiExtraUsd), hourly re-checks for one trip (rwd:prio:<trip>, read by recheck.js through
// rewardsRecheckTimes), early access to a feature (rwd:early, hasEarlyAccess). Redeeming needs confirm: true; a
// redemption can be undone within 24 hours while it's unused.
//
//   trip-rewards        { page? }                               → { balance, expiring, expired, ledger, tier, progress, catalogue, active, terms }
//   trip-rewards-redeem { item, confirm: true, trip?, flag? }   → { redemption, balance, active }
//   trip-rewards-undo   { redemption }                          → { undone, balance, active }

import { ApiError } from '../accounts/util.js';
import { dayDate } from './trips.js';

const DAY = 86400_000;
export const REWARDS = {
  expiryMonths: 24,
  undoMs: DAY,
  soonMs: 90 * DAY, // "expiring soon" in the panel
  pageSize: 50,
  earn: {
    tripDay: 50, // per day of a trip taken
    tripMaxDays: 30, // a trip's days counted at most (TRIP.days)
    booking: { flight: 100, stay: 100, rail: 50, activity: 25 }, // per booking made through Eden, whatever its price
    accuracy: 50, // an accuracy report confirmed useful (hook only)
    referral: 1000, // a person you invited joins Plus (hook only)
    share: 10, // a Memories recap or film shared, once per trip
  },
  rated: ['trip', 'booking'], // the reasons a tier's bonus rate multiplies
  // A trip counts when it ended, has at least one stop, and was made before it started (no points for typing in a past
  // trip). tripEvidence: null = any stop; a list of booking `via`s (trips.js cleanBooking) = only a trip with a stop
  // booked one of those ways counts. OWNER DECISION: ['api', 'mail', 'forward'] would stop made-up trips.
  tripEvidence: ['api', 'mail', 'forward'], // owner's call (2026-10-28 lead default): a trip earns only with a stop booked by Eden or read from a confirmation email; null = any stop
  endGraceMs: 12 * 3600_000, // a trip has ended 12 hours after its last day's end in UTC (covers time zones west of UTC)
  tierWindowMs: 365 * DAY,
  tiers: [
    { id: 'explorer', name: 'Explorer', trips: 0, days: 0, rate: 1, photos: { perTrip: 200, accountBytes: 500 * 1024 * 1024 } /* = memories.js PHOTOS (no import: memories.js imports this) */, recheck: { daysBefore: [], tripEveryMs: null } },
    { id: 'voyager', name: 'Voyager', trips: 3, days: 15, rate: 1.25, photos: { perTrip: 400, accountBytes: 1024 * 1024 * 1024 }, recheck: { daysBefore: [3], tripEveryMs: null } },
    { id: 'navigator', name: 'Navigator', trips: 8, days: 45, rate: 1.5, photos: { perTrip: 800, accountBytes: 2 * 1024 * 1024 * 1024 }, recheck: { daysBefore: [3], tripEveryMs: 6 * 3600_000 } },
  ],
  catalogue: {
    plus_month: { name: 'A month of Eden Plus', points: 3000, days: 30 },
    ai_extra: { name: 'Extra AI this month', points: 500, usd: 2 },
    priority_recheck: { name: 'Hourly re-checks for one trip', points: 400, everyMs: 3600_000, maxDays: 14 },
    early_access: { name: 'Early access to a new feature', points: 1000 },
  },
  // features a person can unlock early: { flag: 'what it is' }. None yet: the owner adds them.
  early: {},
};

export const TERMS = {
  title: 'Eden Rewards terms',
  status: 'Draft of 28 October 2026, not yet reviewed by a lawyer.',
  points: [
    'Eden Rewards points have no cash value. They can’t be bought, sold, exchanged for money or refunded.',
    'Points can be used only for the Eden things listed in Rewards, such as a month of Eden Plus.',
    'Points belong to your Eden account and can’t be transferred to another person or account.',
    'Points expire 24 months after you earn them. The oldest points are used first.',
    'Eden can change how points are earned and used, or end Rewards, with at least 30 days’ notice in the app. Points you already have stay usable until the notice ends.',
    'Points earned by mistake, or by misuse (such as made-up trips or bookings), can be removed.',
    'A redemption can be undone within 24 hours if it hasn’t been used. A month of Plus counts as used once it starts.',
    'A Plus month from points runs only while you have no other Plus. While you pay for Plus, it waits and starts when your paid Plus ends. Eden never charges you for a month you redeemed.',
    'Deleting your Eden account deletes your points.',
  ],
};

const REF = /^[a-z]+:[A-Za-z0-9_.:-]{1,200}$/;
const RED = /^red:[0-9a-f]{10}$/;
const TRIP_ID = /^[0-9a-f]{16}$/;
const ACCOUNT = /^[0-9a-f-]{36}$/;
const pad = (n) => String(n).padStart(10, '0');
const hex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
const bad = (message, status = 400, code = 'bad_request') => new ApiError(status, code, message);

/** An earn's expiry: REWARDS.expiryMonths calendar months later (UTC), as credits.js expiryOf. */
export function expiryOf(at) {
  const d = new Date(at);
  d.setUTCMonth(d.getUTCMonth() + REWARDS.expiryMonths);
  return d.getTime();
}

/* ---------- the ledger: pure ---------- */

/**
 * The ledger replayed at `now`: lots (one per earn) spent FIFO by redemptions, given back by undos.
 * → { balance, expired, lots: [{ n, left, expires, at }], redemptions: Map(ref → { entry, undone, alloc }) }
 */
export function ledgerState(entries, now) {
  const lots = [];
  const redemptions = new Map();
  for (const e of [...entries].sort((a, b) => a.n - b.n)) {
    if (e.kind === 'earn') lots.push({ n: e.n, left: e.amount, expires: e.expires, at: e.at });
    else if (e.kind === 'redeem') {
      let need = -e.amount;
      const alloc = [];
      for (const lot of lots) {
        if (need <= 0) break;
        if (lot.left <= 0 || lot.expires <= e.at) continue;
        const take = Math.min(lot.left, need);
        lot.left -= take;
        need -= take;
        alloc.push([lot, take]);
      }
      redemptions.set(e.ref, { entry: e, undone: null, alloc });
    } else if (e.kind === 'undo') {
      const r = redemptions.get(e.meta && e.meta.redemption);
      if (!r || r.undone) continue;
      r.undone = e;
      for (const [lot, take] of r.alloc) lot.left += take; // back to the same lots, with their own expiry
    }
  }
  let balance = 0, expired = 0;
  for (const lot of lots) if (lot.expires > now) balance += lot.left; else expired += lot.left;
  return { balance, expired, lots, redemptions };
}

/** The lots expiring within REWARDS.soonMs: [{ points, on }] by date. */
export function expiringSoon(state, now) {
  const by = new Map();
  for (const lot of state.lots) {
    if (lot.left <= 0 || lot.expires <= now || lot.expires > now + REWARDS.soonMs) continue;
    const on = new Date(lot.expires).toISOString().slice(0, 10);
    by.set(on, (by.get(on) || 0) + lot.left);
  }
  return [...by].sort(([a], [b]) => (a < b ? -1 : 1)).map(([on, points]) => ({ points, on }));
}

/** Status from the trips that earned points with an end in the last 12 months. → { tier, trips, days, progress } */
export function tierOf(entries, now) {
  let trips = 0, days = 0;
  for (const e of entries) {
    if (e.kind !== 'earn' || e.reason !== 'trip' || !e.meta) continue;
    if (!(e.meta.end_at > now - REWARDS.tierWindowMs && e.meta.end_at <= now)) continue;
    trips += 1;
    days += e.meta.days || 0;
  }
  let i = 0;
  REWARDS.tiers.forEach((t, k) => { if (trips >= t.trips || days >= t.days) i = k; });
  const tier = REWARDS.tiers[i];
  const next = REWARDS.tiers[i + 1] || null;
  const progress = next
    ? { next: next.id, next_name: next.name, trips: { have: trips, need: next.trips }, days: { have: days, need: next.days },
      text: `${Math.max(0, next.trips - trips)} more ${next.trips - trips === 1 ? 'trip' : 'trips'} or ${Math.max(0, next.days - days)} more travel days in 12 months to reach ${next.name}.` }
    : { next: null, trips: { have: trips, need: null }, days: { have: days, need: null }, text: `${tier.name} is the top status.` };
  return { tier, trips, days, progress };
}

/** Whether a trip counts as taken at `now`: ended, a stop, made before it began, and (REWARDS.tripEvidence) booked. */
export function tripTaken(trip, now) {
  if (!trip || !trip.start || !Array.isArray(trip.days) || !trip.days.length) return null;
  const stops = trip.days.flatMap((d) => d.stops || []);
  if (!stops.length) return null;
  const startAt = Date.parse(`${trip.start}T00:00:00Z`);
  const end = dayDate(trip, trip.days.length - 1);
  const endAt = Date.parse(`${end}T00:00:00Z`) + DAY + REWARDS.endGraceMs;
  if (!Number.isFinite(startAt) || now < endAt) return null;
  if (!(Number.isFinite(trip.created) && trip.created < startAt)) return null;
  if (REWARDS.tripEvidence && !stops.some((s) => s.booked && REWARDS.tripEvidence.includes(s.booked.via))) return null;
  return { days: Math.min(trip.days.length, REWARDS.earn.tripMaxDays), end, end_at: endAt };
}

/* ---------- the ledger in the account object ---------- */

async function entriesOf(storage) {
  return [...(await storage.list({ prefix: 'rwd:e:' })).values()];
}

/**
 * Write one entry, once per ref. → { entry, already }. Earns of a rated reason are multiplied by the tier's rate then.
 * Durable Objects run one request at a time across awaits on storage (input gates), so the ref check and the write hold.
 */
async function append(account, { kind, reason, amount, ref, meta = null }) {
  if (!REF.test(String(ref))) throw bad('A rewards entry needs a ref.');
  const storage = account.storage;
  const had = await storage.get(`rwd:ref:${ref}`);
  if (had !== undefined && had !== null) return { entry: await storage.get(`rwd:e:${pad(had)}`), already: true };
  const at = account.now();
  const n = ((await storage.get('rwd:seq')) || 0) + 1;
  const entry = { n, kind, reason, amount: Math.round(amount), at, ref, ...(kind === 'earn' ? { expires: expiryOf(at) } : {}), meta };
  await storage.put({ 'rwd:seq': n, [`rwd:e:${pad(n)}`]: entry, [`rwd:ref:${ref}`]: n });
  if (kind === 'earn' && reason === 'trip') await storage.delete('rwd:tier'); // status may have changed
  return { entry, already: false };
}

/** Points earned for `reason` (earn table above), once per `ref`. → { entry, already } (no points: null). */
export async function earn(account, reason, ref, points, meta = null) {
  if (!(points > 0)) return null;
  const rate = REWARDS.rated.includes(reason) ? (await tierNow(account)).rate : 1;
  return append(account, { kind: 'earn', reason, amount: points * rate, ref, meta });
}

/** A booking made through Eden (flights.js, stayops.js, extraops.js; activities when a partner confirms one). */
export function earnBooking(account, kind, providerRef) {
  const points = REWARDS.earn.booking[kind];
  if (!points || !String(providerRef || '').trim()) return Promise.resolve(null);
  return earn(account, 'booking', `book:${kind}:${String(providerRef).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 120)}`, points, { kind });
}

/** A trip's recap (or film) shared with the people on it: once per trip. */
export function earnShare(account, tripId, what = 'recap') {
  if (!TRIP_ID.test(String(tripId))) return Promise.resolve(null);
  return earn(account, 'share', `share:${tripId}`, REWARDS.earn.share, { trip: tripId, what: String(what).slice(0, 20) });
}

/** HOOK ONLY: an accuracy report (accuracy.js tacr:<id>) the owner's review confirmed useful. */
export function earnAccuracy(account, reportId) {
  return earn(account, 'accuracy', `acc:${String(reportId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60)}`, REWARDS.earn.accuracy, { report: String(reportId).slice(0, 60) });
}

/**
 * HOOK ONLY, on the INVITER's object: `member` (an account id) joined Plus with a paid plan. Pays once per member, and
 * only when `member` is on one of this account's trips (members.js tmem:<trip>:<member>), so nobody can name a stranger.
 */
export async function earnReferral(account, member) {
  if (!ACCOUNT.test(String(member))) throw bad('member must be an account id.');
  const mine = [...(await account.storage.list({ prefix: 'tmem:' })).keys()].some((k) => k.endsWith(`:${member}`));
  if (!mine) return null;
  return earn(account, 'referral', `refer:${member}`, REWARDS.earn.referral, { member });
}

/** HOOK ONLY, on the MEMBER's object: who invited this account first (members.js tjoin:<owner>:<trip>), or null. */
export async function referrerOf(storage) {
  const joins = [...(await storage.list({ prefix: 'tjoin:' })).values()].filter((j) => j && ACCOUNT.test(String(j.owner)));
  joins.sort((a, b) => (a.joined || 0) - (b.joined || 0));
  return joins.length ? joins[0].owner : null;
}

/** Each trip that has ended earns its points once (ref trip:<id>). → the entries added. */
export async function settleTrips(account) {
  const now = account.now();
  const added = [];
  for (const [key, trip] of await account.storage.list({ prefix: 'trip:' })) {
    const id = key.slice(5);
    if (!TRIP_ID.test(id)) continue;
    const taken = tripTaken(trip, now);
    if (!taken) continue;
    const out = await earn(account, 'trip', `trip:${id}`, taken.days * REWARDS.earn.tripDay, { trip: id, title: String(trip.title || '').slice(0, 120), days: taken.days, end: taken.end, end_at: taken.end_at });
    if (out && !out.already) added.push(out.entry);
  }
  return added;
}

/** The account's status now, cached a day in rwd:tier (the hooks in recheck.js and memories.js read it often). */
export async function tierNow(account) {
  const now = account.now();
  const cached = await account.storage.get('rwd:tier');
  if (cached && now - cached.at < DAY) return REWARDS.tiers.find((t) => t.id === cached.id) || REWARDS.tiers[0];
  const { tier } = tierOf(await entriesOf(account.storage), now);
  await account.storage.put('rwd:tier', { id: tier.id, at: now });
  return tier;
}

/* ---------- what redemptions do: read by the hooks ---------- */

/**
 * The Plus month(s) from points, at `now`. `covered`: whether any other Plus (App Store, Stripe, Google Play, a promo
 * code) is on now, without this. Covered: a running bonus stops and what's left goes back in the bank; not covered: the
 * bank starts running. So a bonus month never overlaps a paid one (account.js planNow calls this).
 * plus_bonus_until → { until, banked_ms } → { running, until, banked_ms }
 */
export async function plusBonusNow(storage, covered, now) {
  const b = (await storage.get('plus_bonus_until')) || { until: 0, banked_ms: 0 };
  let { until = 0, banked_ms = 0 } = b;
  if (covered && until > now) { banked_ms += until - now; until = now; }
  else if (!covered && until <= now && banked_ms > 0) { until = now + banked_ms; banked_ms = 0; }
  if (until !== b.until || banked_ms !== b.banked_ms) await storage.put('plus_bonus_until', { until, banked_ms });
  return { running: until > now, until, banked_ms };
}

/** Extra AI this month, in dollars of provider cost (account.js plusCap adds it). rwd:ai → [{ red, usd, until }] */
export function aiExtraUsd(list, now) {
  return (Array.isArray(list) ? list : []).filter((x) => x.until > now).reduce((s, x) => s + x.usd, 0);
}
const monthEnd = (now) => { const d = new Date(now); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };

/** Whether this account unlocked `flag` early (rwd:early → { [flag]: redemption }). */
export async function hasEarlyAccess(storage, flag) {
  const e = (await storage.get('rwd:early')) || {};
  return Boolean(e[flag]);
}

/** Memories' caps for this account's status (memories.js reads them in place of PHOTOS.perTrip / accountBytes). */
export async function photoCaps(account) {
  return (await tierNow(account)).photos;
}

/**
 * Extra re-check times for one trip (recheck.js adds them to recheckTimes): the status's (days before at 07:00 UTC,
 * every few hours during the trip) and a priority redemption's (every hour in its window). → [ms], sorted.
 */
export async function rewardsRecheckTimes(account, id, trip) {
  if (!trip || !trip.start || !Array.isArray(trip.days) || !trip.days.length) return [];
  const tier = await tierNow(account);
  const start = Date.parse(`${trip.start}T00:00:00Z`);
  const end = Date.parse(`${dayDate(trip, trip.days.length - 1)}T00:00:00Z`) + DAY;
  const times = tier.recheck.daysBefore.map((d) => start - d * DAY + 7 * 3600_000);
  if (tier.recheck.tripEveryMs) for (let t = start + 7 * 3600_000; t < end; t += tier.recheck.tripEveryMs) times.push(t);
  const prio = await account.storage.get(`rwd:prio:${id}`);
  if (prio && !prio.undone) for (let t = prio.from; t < prio.until; t += REWARDS.catalogue.priority_recheck.everyMs) times.push(t);
  return [...new Set(times)].filter(Number.isFinite).sort((a, b) => a - b);
}

/* ---------- the ops ---------- */

async function activeOf(account) {
  const storage = account.storage, now = account.now();
  const bonus = (await storage.get('plus_bonus_until')) || { until: 0, banked_ms: 0 };
  const ai = ((await storage.get('rwd:ai')) || []).filter((x) => x.until > now);
  const prio = [...(await storage.list({ prefix: 'rwd:prio:' }))].filter(([, p]) => !p.undone && p.until > now).map(([k, p]) => ({ trip: k.slice(9), from: new Date(p.from).toISOString(), until: new Date(p.until).toISOString() }));
  return {
    plus_bonus: { running_until: bonus.until > now ? new Date(bonus.until).toISOString() : null, banked_days: Math.round((bonus.banked_ms || 0) / DAY * 10) / 10 },
    ai_extra_usd: aiExtraUsd(ai, now), ai_extra_until: ai.length ? new Date(Math.max(...ai.map((x) => x.until))).toISOString() : null,
    priority: prio,
    early: Object.keys((await storage.get('rwd:early')) || {}),
  };
}

function catalogueView(balance, plan) {
  const C = REWARDS.catalogue;
  const item = (id, about, why = null) => ({ item: id, name: C[id].name, points: C[id].points, about, can: !why && balance >= C[id].points, why: why || (balance < C[id].points ? `You need ${C[id].points - balance} more points.` : null) });
  const flags = Object.entries(REWARDS.early);
  return [
    item('plus_month', `${C.plus_month.days} days of Eden Plus. If you already have Plus, they wait and start when it ends: you’re never charged for them.`),
    item('ai_extra', `$${C.ai_extra.usd} more of Eden’s included AI, until the end of this month.`, plan && !plan.active ? 'Extra AI adds to Plus’s monthly allowance: it needs Plus.' : null),
    item('priority_recheck', `Eden re-checks one upcoming trip every hour, from the day before it starts, for up to ${C.priority_recheck.maxDays} days (instead of a week before, the day before and each morning).`),
    { ...item('early_access', 'Try a new Eden feature before everyone else.', flags.length ? null : 'Nothing to unlock early right now.'), flags: flags.map(([flag, about]) => ({ flag, about })) },
  ];
}

// another account's id (a referral's member) never leaves this object
const view = (e) => { const { member: _m, ...meta } = e.meta || {}; return { n: e.n, kind: e.kind, reason: e.reason, amount: e.amount, at: new Date(e.at).toISOString(), ref: e.reason === 'referral' ? 'refer' : e.ref, expires: e.expires ? new Date(e.expires).toISOString() : null, meta: e.meta ? meta : null }; };

async function summary(account, body = {}) {
  const now = account.now();
  const entries = await entriesOf(account.storage);
  const state = ledgerState(entries, now);
  const { tier, trips, days, progress } = tierOf(entries, now);
  const plan = typeof account.planNow === 'function' ? await account.planNow().catch(() => null) : null;
  const page = Math.max(0, Math.floor(Number(body.page) || 0));
  const newest = [...entries].sort((a, b) => b.n - a.n);
  const slice = newest.slice(page * REWARDS.pageSize, (page + 1) * REWARDS.pageSize).map((e) => {
    const r = e.kind === 'redeem' ? state.redemptions.get(e.ref) : null;
    return { ...view(e), ...(r ? { undone: Boolean(r.undone), undo_until: r.undone ? null : new Date(e.at + REWARDS.undoMs).toISOString() } : {}) };
  });
  return {
    balance: state.balance,
    expiring: expiringSoon(state, now),
    expired: state.expired,
    ledger: { entries: slice, page, more: newest.length > (page + 1) * REWARDS.pageSize },
    tier: { id: tier.id, name: tier.name, rate: tier.rate, trips, days, benefits: benefitsOf(tier) },
    progress,
    tiers: REWARDS.tiers.map((t) => ({ id: t.id, name: t.name, trips: t.trips, days: t.days, benefits: benefitsOf(t) })),
    earn: REWARDS.earn,
    catalogue: catalogueView(state.balance, plan),
    active: await activeOf(account),
    terms: TERMS,
    checked_at: new Date(now).toISOString(),
  };
}

function benefitsOf(t) {
  const gb = (b) => (b >= 1024 ** 3 ? `${b / 1024 ** 3} GB` : `${Math.round(b / 1024 ** 2)} MB`);
  const out = [`${t.photos.perTrip} photos a trip in Memories, ${gb(t.photos.accountBytes)} in all`];
  if (t.rate > 1) out.push(`${Math.round((t.rate - 1) * 100)}% more points on trips and bookings`);
  if (t.recheck.daysBefore.length) out.push(`An extra re-check ${t.recheck.daysBefore.join(' and ')} days before each trip`);
  if (t.recheck.tripEveryMs) out.push(`Re-checks every ${t.recheck.tripEveryMs / 3600_000} hours during each trip`);
  return out;
}

/** Whether a redemption has been used (then it can't be undone). */
async function usedYet(account, red, deps) {
  const storage = account.storage, now = account.now();
  const m = red.meta || {};
  if (m.item === 'plus_month') { // unused only while its days are all still in the bank
    const b = (await storage.get('plus_bonus_until')) || { banked_ms: 0 };
    return (b.banked_ms || 0) < m.days * DAY;
  }
  if (m.item === 'ai_extra') { // used once this month's spending went past what Plus gives without it
    const ai = deps.ai ? await deps.ai() : typeof account.usageNow === 'function' ? { spent: (await account.usageNow()).spent, cap: await account.plusCap(await account.planNow()) } : null;
    return !ai || ai.spent > ai.cap - m.usd;
  }
  if (m.item === 'priority_recheck') { // used once a re-check of the trip ran after it
    const chk = await storage.get(`tchk:${m.trip}`);
    return Boolean(chk && chk.ran >= red.at && now >= m.from);
  }
  return false; // early access: Eden can't tell, so undoable within the 24 hours
}

export async function rewardsOp(account, op, body = {}, deps = {}) {
  const storage = account.storage;
  const now = account.now();
  if (op === 'trip-rewards') {
    await settleTrips(account);
    return summary(account, body);
  }
  if (op === 'trip-rewards-redeem') {
    if (body.confirm !== true) throw bad('rewards-redeem needs confirm: true (the person confirmed it).');
    const id = String(body.item || '');
    const item = Object.hasOwn(REWARDS.catalogue, id) ? REWARDS.catalogue[id] : null;
    if (!item) throw bad('There is no such reward.', 404, 'not_found');
    await settleTrips(account);
    const meta = { item: id };
    if (id === 'ai_extra') {
      const plan = typeof account.planNow === 'function' ? await account.planNow() : deps.plan || null;
      if (!plan || !plan.active) throw bad('Extra AI adds to Plus’s monthly allowance: it needs Plus.', 402, 'plus_required');
      Object.assign(meta, { usd: item.usd, until: monthEnd(now) });
    } else if (id === 'priority_recheck') {
      const trip = String(body.trip || '');
      const t = TRIP_ID.test(trip) ? await storage.get(`trip:${trip}`) : null;
      if (!t) throw bad('There is no such trip.', 404, 'not_found');
      const start = Date.parse(`${t.start}T00:00:00Z`);
      const end = Date.parse(`${dayDate(t, t.days.length - 1)}T00:00:00Z`) + DAY;
      if (end <= now) throw bad('This trip has ended.', 409, 'ended');
      const was = await storage.get(`rwd:prio:${trip}`);
      if (was && !was.undone && was.until > now) throw bad('This trip already has hourly re-checks.', 409, 'already');
      const from = Math.max(now, start - DAY);
      Object.assign(meta, { trip, from, until: Math.min(end, from + item.maxDays * DAY) });
    } else if (id === 'early_access') {
      const flag = String(body.flag || '');
      if (!Object.hasOwn(REWARDS.early, flag)) throw bad('There is no such feature to unlock.', 404, 'not_found');
      if (await hasEarlyAccess(storage, flag)) throw bad('You already have this.', 409, 'already');
      meta.flag = flag;
    } else if (id === 'plus_month') meta.days = item.days;
    const state = ledgerState(await entriesOf(storage), now);
    if (state.balance < item.points) throw bad(`You need ${item.points - state.balance} more points for this.`, 409, 'not_enough');
    const ref = `red:${hex(5)}`;
    const { entry } = await append(account, { kind: 'redeem', reason: id, amount: -item.points, ref, meta });
    // what it does
    if (id === 'plus_month') {
      const b = (await storage.get('plus_bonus_until')) || { until: 0, banked_ms: 0 };
      await storage.put('plus_bonus_until', { until: b.until || 0, banked_ms: (b.banked_ms || 0) + item.days * DAY });
      if (typeof account.planNow === 'function') await account.planNow(); // starts it now if no other Plus is on (plusBonusNow)
    } else if (id === 'ai_extra') await storage.put('rwd:ai', [...((await storage.get('rwd:ai')) || []).filter((x) => x.until > now), { red: ref, usd: meta.usd, until: meta.until }]);
    else if (id === 'priority_recheck') await storage.put(`rwd:prio:${meta.trip}`, { red: ref, from: meta.from, until: meta.until, at: now });
    else if (id === 'early_access') await storage.put('rwd:early', { ...((await storage.get('rwd:early')) || {}), [meta.flag]: ref });
    if (deps.rearm && id === 'priority_recheck') await deps.rearm().catch(() => {}); // recheck.js armRecheck
    return { redemption: view(entry), balance: ledgerState(await entriesOf(storage), now).balance, active: await activeOf(account) };
  }
  if (op === 'trip-rewards-undo') {
    const ref = String(body.redemption || '');
    if (!RED.test(ref)) throw bad('redemption must be a redemption’s ref.');
    const state = ledgerState(await entriesOf(storage), now);
    const r = state.redemptions.get(ref);
    if (!r) throw bad('There is no such redemption.', 404, 'not_found');
    if (r.undone) throw bad('This was already undone.', 409, 'already');
    if (now - r.entry.at > REWARDS.undoMs) throw bad('A redemption can be undone only within 24 hours.', 409, 'too_late');
    if (await usedYet(account, r.entry, deps)) throw bad('This has been used, so it can’t be undone.', 409, 'used');
    const m = r.entry.meta || {};
    if (m.item === 'plus_month') {
      const b = (await storage.get('plus_bonus_until')) || { until: 0, banked_ms: 0 };
      await storage.put('plus_bonus_until', { until: b.until || 0, banked_ms: b.banked_ms - m.days * DAY });
    } else if (m.item === 'ai_extra') await storage.put('rwd:ai', ((await storage.get('rwd:ai')) || []).filter((x) => x.red !== ref));
    else if (m.item === 'priority_recheck') { const p = await storage.get(`rwd:prio:${m.trip}`); if (p && p.red === ref) await storage.put(`rwd:prio:${m.trip}`, { ...p, undone: now }); }
    else if (m.item === 'early_access') { const e = (await storage.get('rwd:early')) || {}; delete e[m.flag]; await storage.put('rwd:early', e); }
    await append(account, { kind: 'undo', reason: m.item, amount: -r.entry.amount, ref: `undo:${ref.slice(4)}`, meta: { redemption: ref } });
    if (deps.rearm && m.item === 'priority_recheck') await deps.rearm().catch(() => {});
    return { undone: true, balance: ledgerState(await entriesOf(storage), now).balance, active: await activeOf(account) };
  }
  throw bad('Not found', 404, 'not_found');
}
