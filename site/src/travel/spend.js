// What Eden Travel spends on Google Maps, and where it stops. Every paid call (maps.js googleMaps) asks the account's
// meter first; the meter counts it by Google's SKU and refuses once a cap is reached, and the checks then show the last
// answer with when it was checked (checks.js), never a stale answer as a fresh one.
//
// Prices: Google Maps Platform list prices, USD per 1000 billable events, the 0–100k monthly tier, before Google's
// monthly free calls (so the meter's dollars are an upper bound). Read 2026-10-28 from
//   https://developers.google.com/maps/billing-and-pricing/pricing
// Which fields put a Places request in which SKU (the most expensive field in the mask decides):
//   https://developers.google.com/maps/documentation/places/web-service/data-fields
// Routes: one SKU per computeRoutes request, Pro with routingPreference TRAFFIC_AWARE; computeRouteMatrix billed per
// element (origins × destinations), Essentials without traffic:
//   https://developers.google.com/maps/billing-and-pricing/sku-details
//   https://developers.google.com/maps/documentation/routes/usage-and-billing
// Google's pages don't list TRANSIT or WALK as a Pro feature; those count as Essentials here.
//
// Caps (dollars at those prices; env overrides, '0' turns one off):
//   per open   TRAVEL_GOOGLE_OPEN_USD    (1.00)  one request (a trip opened, an edit, a re-check): a long trip is
//                                                checked over a few opens instead of in one burst
//   per account TRAVEL_GOOGLE_ACCOUNT_USD (3.00) a day (UTC)
//   global     TRAVEL_GOOGLE_DAILY_USD   (20)    a day (UTC), across every account: the object tspend:global
//
// Stored: in the account's object tspend:<YYYY-MM-DD> → { counts: { sku: n }, usd } (kept SPEND.keepDays);
// in tspend:global the same per day, counts only (no account, no place).
//   tspend-take { day, sku, n, cap } → { ok, usd }     tspend-read {} → { days: [{ day, counts, usd }] }

import { ApiError } from '../accounts/util.js';

// the shared object's op (as track.js ask; not imported from there: maps.js imports this module, and track.js maps.js)
async function ask(env, name, op, body) {
  const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName(name));
  const res = await stub.fetch(`https://account/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (res.status >= 400) throw new Error(out.error || `spend counter answered ${res.status}`);
  return out;
}

export const PRICE = {
  details_ids: 0, details_ess: 5, details_pro: 17, details_ent: 20, details_atmo: 25,
  text_ids: 0, text_pro: 32, text_ent: 35, text_atmo: 40,
  nearby_pro: 32, nearby_ent: 35, nearby_atmo: 40,
  photo: 7, // Place Details Photos
  routes_ess: 5, routes_pro: 10, routes_ent: 15,
  matrix_ess: 5, matrix_pro: 10, matrix_ent: 15, // per element
  static_map: 2,
};
export const SKUS = Object.keys(PRICE);
export const SPEND = { openUsd: 1, accountUsd: 3, globalUsd: 20, keepDays: 40, global: 'tspend:global' };

// The SKU tier each field puts a request in: 0 IDs only, 1 Essentials, 2 Pro, 3 Enterprise, 4 Enterprise + Atmosphere.
// Place Details; Text Search and Nearby Search bill formattedAddress, location and photos as Pro, and Nearby bills id as Pro.
const TIER = {
  id: 0, photos: 0, formattedAddress: 1, location: 1,
  displayName: 2, businessStatus: 2, utcOffsetMinutes: 2, googleMapsUri: 2, accessibilityOptions: 2, primaryTypeDisplayName: 2,
  regularOpeningHours: 3, currentOpeningHours: 3, priceLevel: 3, websiteUri: 3, rating: 3, userRatingCount: 3,
  editorialSummary: 4,
};
const SEARCH_PRO = new Set(['formattedAddress', 'location', 'photos']);
const NAMES = ['ids', 'ess', 'pro', 'ent', 'atmo'];

/** The SKU a Places request is billed at. api: details | text | nearby; mask: the X-Goog-FieldMask. */
export function placesSku(api, mask) {
  let tier = api === 'details' ? 0 : api === 'nearby' ? 2 : 0;
  for (const raw of String(mask || '').split(',')) {
    const f = raw.trim().replace(/^places\./, '').split('.')[0];
    if (!f) continue;
    let t = TIER[f] ?? 3; // a field not listed here: counted as Enterprise rather than guessed cheap
    if (api !== 'details' && SEARCH_PRO.has(f)) t = Math.max(t, 2);
    tier = Math.max(tier, t);
  }
  if (api !== 'details' && tier === 1) tier = 2; // searches have no Essentials tier
  return `${api}_${NAMES[tier]}`;
}

export const usdOf = (sku, n = 1) => ((PRICE[sku] ?? 0) * n) / 1000;
export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const round = (n) => Math.round(n * 1e6) / 1e6;

export function capsFor(env = {}) {
  const usd = (v, d) => { const n = Number(v); return v === undefined || v === '' || !Number.isFinite(n) || n < 0 ? d : n; };
  return { openUsd: usd(env.TRAVEL_GOOGLE_OPEN_USD, SPEND.openUsd), accountUsd: usd(env.TRAVEL_GOOGLE_ACCOUNT_USD, SPEND.accountUsd), globalUsd: usd(env.TRAVEL_GOOGLE_DAILY_USD, SPEND.globalUsd) };
}

// What the page says when answers are held back (the badges keep their own checked_at).
export const HELD = {
  open: 'Part of this trip was checked just now; the rest shows its last check, with when. Open it again to check more.',
  account: 'Today’s map checks for your account are used up: answers show when they were last checked. New checks start again tomorrow.',
  global: 'Eden’s map checks are paused for today: answers show when they were last checked, and anything never checked says so.',
};

/**
 * The meter for one request on an account: take(sku, n) before each paid call → null (go ahead, counted) or
 * { reason: open|account|global, note } (don't call). `global(day, sku, n, cap)` → { ok } is the shared object's
 * take (injectable for tests); without env.ACCOUNTS there is none and only the account caps apply.
 */
export function spendMeter(account, { caps = capsFor(account.env), global } = {}) {
  const env = account.env || {};
  const takeGlobal = global || (env.ACCOUNTS ? (day, sku, n, cap) => ask(env, SPEND.global, 'tspend-take', { day, sku, n, cap }) : null);
  const meter = {
    usd: 0, // this request's
    calls: 0,
    held: null, // the first reason a call was refused
    // one at a time (a day's places are looked up together): each sees the counts the one before wrote
    take(sku, n = 1) {
      const turn = chain.then(() => takeOne(sku, n));
      chain = turn.catch(() => {});
      return turn;
    },
  };
  let chain = Promise.resolve();
  async function takeOne(sku, n) {
    if (!(sku in PRICE)) sku = 'details_atmo';
    const cost = usdOf(sku, n);
    const refuse = (reason) => { meter.held ||= reason; return { reason, note: HELD[reason] }; };
    if (caps.openUsd > 0 && meter.usd + cost > caps.openUsd) return refuse('open');
    const day = dayOf(account.now());
    const key = `tspend:${day}`;
    // the account's count read and written with no other I/O between (another request on the object can't slip in)
    const rec = (await account.storage.get(key)) || { counts: {}, usd: 0 };
    if (caps.accountUsd > 0 && rec.usd + cost > caps.accountUsd) return refuse('account');
    rec.counts[sku] = (rec.counts[sku] || 0) + n;
    rec.usd = round(rec.usd + cost);
    await account.storage.put(key, rec);
    if (takeGlobal && caps.globalUsd > 0) {
      let g = null;
      try {
        g = await takeGlobal(day, sku, n, caps.globalUsd);
      } catch (e) {
        // the counter unreachable: the call goes ahead (Google's own quotas and the budget alert still stand), logged
        console.error('travel spend global', e && e.message);
      }
      if (g && g.ok === false) {
        const back = (await account.storage.get(key)) || rec; // not made: taken off the account's count again
        back.counts[sku] = Math.max(0, (back.counts[sku] || 0) - n);
        if (!back.counts[sku]) delete back.counts[sku];
        back.usd = Math.max(0, round(back.usd - cost));
        await account.storage.put(key, back);
        return refuse('global');
      }
    }
    if (!(await account.storage.get('tspend:pruned'))?.startsWith?.(day)) await prune(account.storage, day);
    meter.usd = round(meter.usd + cost);
    meter.calls += n;
    return null;
  }
  return meter;
}

// once a day: the account's counts older than SPEND.keepDays deleted
async function prune(storage, day) {
  const oldest = dayOf(Date.parse(`${day}T00:00:00Z`) - SPEND.keepDays * 86400_000);
  const old = [...(await storage.list({ prefix: 'tspend:2' })).keys()].filter((k) => k.slice(7) < oldest);
  if (old.length) await storage.delete(old.slice(0, 128));
  await storage.put('tspend:pruned', day);
}

/** The account's spend by day, newest first: for the owner's view and tests. */
export async function spendRead(account) {
  return [...(await account.storage.list({ prefix: 'tspend:2' }))].map(([k, v]) => ({ day: k.slice(7), counts: v.counts, usd: v.usd })).sort((a, b) => (a.day < b.day ? 1 : -1));
}

/* ---------- the global counter (the object tspend:global; no device: the accounts' own calls only) ---------- */

export async function spendIndexOp(account, op, body = {}) {
  if (await account.storage.get('account')) throw new ApiError(404, 'not_found', 'Not found'); // never a person's object
  if (op === 'tspend-read') return { days: await spendRead(account) };
  if (op !== 'tspend-take') throw new ApiError(404, 'not_found', 'Not found');
  const day = String(body.day || '');
  const n = Number(body.n);
  const cap = Number(body.cap);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !(body.sku in PRICE) || !Number.isInteger(n) || n < 1 || n > 1000 || !(cap > 0)) throw new ApiError(400, 'bad_request', 'tspend-take { day, sku, n, cap }.');
  const key = `tspend:${day}`;
  const rec = (await account.storage.get(key)) || { counts: {}, usd: 0 };
  const cost = usdOf(body.sku, n);
  if (rec.usd + cost > cap) return { ok: false, usd: rec.usd };
  rec.counts[body.sku] = (rec.counts[body.sku] || 0) + n;
  rec.usd = round(rec.usd + cost);
  await account.storage.put(key, rec);
  if (!(await account.storage.get('tspend:pruned'))?.startsWith?.(day)) await prune(account.storage, day);
  return { ok: true, usd: rec.usd };
}

/** For the Worker's own Google calls with no account at hand (a stop's photo, the map picture: maps.js placePhoto,
 *  flightMapImage): the global daily cap only. Unreachable counter: the call goes ahead, logged. */
export function globalMeter(env = {}, { caps = capsFor(env) } = {}) {
  return {
    async take(sku, n = 1) {
      if (!env.ACCOUNTS || !(caps.globalUsd > 0)) return null;
      try {
        const g = await ask(env, SPEND.global, 'tspend-take', { day: dayOf(Date.now()), sku: sku in PRICE ? sku : 'details_atmo', n, cap: caps.globalUsd });
        return g && g.ok === false ? { reason: 'global', note: HELD.global } : null;
      } catch (e) {
        console.error('travel spend global', e && e.message);
        return null;
      }
    },
  };
}
