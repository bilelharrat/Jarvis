// Mobile data for a trip: travel eSIM plans for the trip's countries and dates, each with its data, how many days it
// lasts, its price as the partner gives it, the countries it covers and whether that is all of the trip's. Buying one
// goes through the traveller's own card first (pay.js kind 'esim'); the eSIM's installation details (the LPA code, the
// SM-DP+ address and activation code, Apple's install link) are kept on the trip so they open without a connection.
//
//   trip-esim        { id, countries?: ['PT', 'ES'], currency? }
//     → { countries: [{ code, name }], countries_from: 'asked'|'destination', start, end, days, currency,
//         partners: [{ id, name, on, mode?, results, note?, error?, code?, source, checked_at }], checked_at }
//   trip-esim-check  { id, package_id }  → the package's price read again now (kept ESIM.checkMs for pay-start)
//     → { check_id, title, price, validity_days, data_text, install_within_days, pay_kind: 'esim', source, checked_at }
//   trip-esim-order  { check_id, held: { amount, currency }, confirm: true }  → only from pay.js once the card is held:
//     the order at Airalo, its installation details kept on the trip → { order_id, code, esim }
//   trip-esims       { id }  → the trip's bought eSIMs with their installation details (the page keeps a copy offline)
//
// Partners, each off until the Worker has EDEN_ESIM = "1" and that partner's keys:
//
//   Airalo Partner API v2. Docs read 2026-10-28 (index https://developers.partners.airalo.com/llms.txt):
//     auth   https://developers.partners.airalo.com/request-access-token-11883021e0
//            POST https://partners-api.airalo.com/v2/token, form fields client_id, client_secret,
//            grant_type=client_credentials → data.{ token_type: 'Bearer', expires_in, access_token }. 3 calls a minute;
//            "cache and reuse" it; the text says it lasts 24 hours (the example's expires_in is a year), so kept ≤ 23 h.
//     list   https://developers.partners.airalo.com/get-packages-11883036e0
//            GET /v2/packages?filter[type]=local|global&filter[country]=PT&limit=1000 (Bearer) → data[] of
//            { slug, country_code ('' for regional/global), title, operators[{ title, type: local|global, is_roaming,
//            rechargeability, activation_policy, is_kyc_verify, install_window_days, other_info, coverages[{ name,
//            networks }], countries[{ country_code, title }], packages[{ id, type: 'sim'|'topup', price, amount (MB),
//            day, is_unlimited, title, data, voice, text, short_info, is_fair_usage_policy, fair_usage_policy,
//            prices.recommended_retail_price.{USD,EUR,…} }] }] }. From page 2 `data` is an object, so values are read.
//            Field meanings: https://developers.partners.airalo.com/attribute-descriptions-752392m0 ("price":
//            recommended retail price, the minimum to sell at; "amount": MB; "day": days valid; eKYC packages are not
//            offered through the API). Prices are USD with daily conversions at 00:00 UTC
//            (https://developers.partners.airalo.com/how-to-convert-prices-into-your-local-currency-752526m0).
//            Docs advise an hourly sync: results are kept ESIM.resultsMs.
//     order  https://developers.partners.airalo.com/submit-order-11883024e0
//            POST /v2/orders multipart/form-data quantity=1, package_id, type=sim, description (ours: "eden <check_id>")
//            → data.{ id, code, package_id, validity, data, price, currency, manual_installation (HTML),
//            installation_guides, sims[{ iccid, lpa, matching_id, qrcode ('LPA:1$…'), qrcode_url, confirmation_code,
//            direct_apple_installation_url, apn_type, apn_value, is_roaming, msisdn }] }.
//     find   https://developers.partners.airalo.com/get-order-list-11883022e0
//            GET /v2/orders?filter[description]=…&include=sims (pay.js's sweep asks whether an order was made).
//     errors https://developers.partners.airalo.com/error-handling-780831m0 (422 with codes: 11 credit, 13 maintenance,
//            33 stock, 34 package gone, 53 unexpected, 83 identical order just placed: look before retrying; 403: 88
//            ordering disabled, 89 IP not allowed). Rate limits https://developers.partners.airalo.com/rate-limits-752590m0.
//     sandbox https://developers.partners.airalo.com/sandbox-mode-2114305m0: same base URL and keys; Sandbox or
//            Production is set on Airalo's side. AIRALO_SANDBOX = "1" only tells Eden which it is, so results and
//            eSIMs say "test" (a sandbox ICCID can't be installed). It never decides whether money moves.
//     install https://developers.partners.airalo.com/esim-installation-methods-for-api-partners-824105m0 (QR, or the
//            SM-DP+ address and activation code by hand; roaming/APN when asked).
//   Env: AIRALO_CLIENT_ID, AIRALO_CLIENT_SECRET, AIRALO_SANDBOX = "1".
//
//   eSIM Go API v2.5 (listed only, to compare; nothing is bought through it). Docs read 2026-10-28:
//     https://docs.esim-go.com/quick_start/ (base https://api.esim-go.com/v2.5, header X-API-Key),
//     https://docs.esim-go.com/api/v2_5/operations/catalogue/get (GET /catalogue?countries=GB,US&perPage → bundles
//     { name, description, countries[{ name, iso }], roamingEnabled[{ iso }], dataAmount (MB), duration, unlimited,
//     price ("Bundle price in the organisation currency") }), https://docs.esim-go.com/api/v2_5/operations/organisation/get
//     (currency). GAP: the docs don't give `duration`'s unit; Eden says days only when the bundle's own name says so
//     ("…_7D_…"). eSIM Go sells to businesses: its price is Eden's cost, not a price the traveller can buy at, so it
//     is shown as `cost`, never `price`. Ordering (POST /orders, /esims/assignments) isn't built.
//   Env: ESIMGO_API_KEY.
//
// Holafly and Nomad publish no public partner API docs (2026-10-28), so they are not here.
// Every result carries source and checked_at. A partner's words are plain short strings (ground.js text()).

import { text } from './ground.js';
import { TripError, dayDate } from './trips.js';
import { inboxOp } from './inbox.js';

const TIMEOUT = 12000;
const CUR = /^[A-Z]{3}$/;
const CC = /^[A-Z]{2}$/;
const TRIP_ID = /^[0-9a-f]{16}$/;
const CHECK_ID = /^[0-9a-f]{16}$/;
export const ESIM = { resultsMs: 3600_000, tokenMs: 23 * 3600_000, checkMs: 20 * 60_000, orderMs: 70 * 60_000, max: 12, countries: 12 };
export const PARTNERS = [
  { id: 'airalo', name: 'Airalo' },
  { id: 'esimgo', name: 'eSIM Go' },
];
const AIRALO = 'https://partners-api.airalo.com';
const ESIMGO = 'https://api.esim-go.com/v2.5';

export class EsimError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // not_set_up | bad_request | not_found | sold_out | rate_limited | unavailable | timeout | check_status
    this.name = 'EsimError';
  }
}

export const esimOn = (env) => String(env?.EDEN_ESIM || '') === '1';
const secret = (v) => (typeof v === 'string' && /^[A-Za-z0-9_\-.:~+/=]{8,300}$/.test(v.trim()) ? v.trim() : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+(\.\d+)?$/.test(v) ? Number(v) : null);
const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const plain = (html, cap) => text(String(html || '').replace(/<\/(p|li|ol|ul|div)>|<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<'), cap);
const https = (u, cap = 1000) => (typeof u === 'string' && u.length <= cap && /^https:\/\/[^\s"'<>]+$/.test(u) ? u : null);

/** One fetch with a timeout; a partner's error mapped by HTTP status and Airalo's code (its message isn't passed on). */
async function request(fetcher, url, init, who, timeoutMs) {
  let res;
  try {
    res = await fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new EsimError('timeout', `${who} took too long to answer.`);
    throw new EsimError('unavailable', `Eden couldn’t reach ${who}.`);
  }
  const out = await res.json().catch(() => null);
  const code = out && typeof out === 'object' ? Number(out.code ?? (out.data && out.data.code) ?? (out.meta && out.meta.code)) : NaN;
  if (res.status === 401) throw Object.assign(new EsimError('not_set_up', `${who} refused Eden’s key (it may be wrong or expired).`), { status: 401 });
  if (res.status === 403) throw new EsimError('not_set_up', code === 89 ? `${who} doesn’t allow Eden’s server address yet.` : `${who} has turned off ordering for Eden’s account.`);
  if (res.status === 404) throw new EsimError('not_found', `${who} found nothing for that.`);
  if (res.status === 429) throw new EsimError('rate_limited', `${who} is busy. Try again in a minute.`);
  if (res.status === 422 || res.status === 400) {
    if (code === 83) throw new EsimError('check_status', `${who} already has this order from a moment ago.`);
    if (code === 34 || code === 33) throw new EsimError('sold_out', `${who} has run out of this plan. Pick another.`);
    if (code === 11 || code === 13 || code === 53) throw new EsimError('unavailable', `${who} can’t sell this just now. Try again later.`);
    throw new EsimError('bad_request', `${who} said some details aren’t valid.`);
  }
  if (!res.ok) throw new EsimError('unavailable', `${who} answered ${res.status}.`);
  if (!out || typeof out !== 'object') throw new EsimError('unavailable', `${who} sent an answer Eden couldn’t read.`);
  return out;
}

/* ---------- countries ---------- */

let NAMES = null;
/** English country name → ISO code, from the runtime's own region names (Intl), plus a few everyday names. */
function names() {
  if (NAMES) return NAMES;
  NAMES = new Map();
  let dn = null;
  try { dn = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { /* no Intl names: only the list below */ }
  if (dn) {
    for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
      const cc = String.fromCharCode(a, b);
      let n = null;
      try { n = dn.of(cc); } catch { /* not a region */ }
      if (n && n !== cc && !/unknown/i.test(n)) NAMES.set(n.toLowerCase(), cc);
    }
  }
  for (const [n, cc] of [['uk', 'GB'], ['england', 'GB'], ['scotland', 'GB'], ['wales', 'GB'], ['northern ireland', 'GB'], ['great britain', 'GB'], ['usa', 'US'], ['us', 'US'], ['united states of america', 'US'], ['holland', 'NL'], ['czech republic', 'CZ'], ['türkiye', 'TR'], ['turkey', 'TR'], ['uae', 'AE']]) NAMES.set(n, cc);
  return NAMES;
}
export const countryName = (cc) => { try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(cc); } catch { return cc; } };

/** The countries a trip's destination names ("Lisbon, Portugal", "Spain and Portugal"); only exact country names. */
export function countriesIn(s) {
  const m = names();
  const out = [];
  for (const part of String(s || '').split(/,|\/|&|\+|;|\band\b|\bthen\b|→|-{1,2}>/i)) {
    const cc = m.get(part.trim().toLowerCase());
    if (cc && !out.includes(cc)) out.push(cc);
  }
  return out;
}

/* ---------- Airalo ---------- */

/** One Airalo package (of an operator in a country or region) in Eden's shape. */
export function airaloResult(pk, op, entry, { want, currency, days, checkedAt, mode }) {
  if (!pk || typeof pk !== 'object' || pk.type === 'topup' || !op || op.is_kyc_verify === true) return null;
  const id = text(pk.id, 120);
  if (!id) return null;
  const local = op.type !== 'global' && CC.test(String(entry.country_code || ''));
  const covers = local ? [entry.country_code] : (Array.isArray(op.countries) ? op.countries : []).map((c) => String((c && c.country_code) || '').toUpperCase()).filter((c) => CC.test(c));
  const hits = want.filter((c) => covers.includes(c));
  if (!hits.length) return null;
  const rrp = pk.prices && pk.prices.recommended_retail_price && typeof pk.prices.recommended_retail_price === 'object' ? pk.prices.recommended_retail_price : {};
  const inCur = num(rrp[currency]);
  const usd = num(rrp.USD) ?? num(pk.price);
  const price = inCur !== null ? { amount: inCur, currency } : usd !== null ? { amount: usd, currency: 'USD' } : null;
  const validity = Number.isInteger(num(pk.day)) ? num(pk.day) : null;
  const unlimited = pk.is_unlimited === true;
  const nets = (Array.isArray(op.coverages) ? op.coverages : []).flatMap((c) => (Array.isArray(c && c.networks) ? c.networks : []).map((n) => text(n && n.name, 40))).filter(Boolean);
  return {
    partner: 'airalo',
    id,
    title: text(pk.title, 80) || text(pk.data, 40),
    operator: text(op.title, 60),
    area: local ? 'country' : /^(world|global)/i.test(String(entry.slug || '')) ? 'world' : 'region',
    area_name: text(entry.title, 60),
    data_mb: unlimited ? null : num(pk.amount),
    data_text: text(pk.data, 40),
    unlimited,
    fair_use: pk.is_fair_usage_policy === true ? text(pk.fair_usage_policy, 200) || 'Slower after a daily amount' : null,
    voice: num(pk.voice), sms: num(pk.text),
    validity_days: validity,
    price: price ? { ...price, kind: 'retail' } : null, // Airalo's recommended retail price (what the traveller pays; no markup)
    covers,
    covers_trip: hits,
    covers_all: hits.length === want.length,
    lasts_trip: validity !== null && days ? validity >= days : null,
    networks: [...new Set(nets)].slice(0, 6),
    roaming: op.is_roaming === true,
    activation: text(op.activation_policy, 80) || null,
    install_within_days: Number.isInteger(num(op.install_window_days)) ? num(op.install_window_days) : null,
    top_up: op.rechargeability === true,
    about: text(pk.short_info, 240) || text(op.other_info, 240) || null,
    orderable: true,
    source: mode === 'sandbox' ? 'Airalo (sandbox: test eSIMs)' : 'Airalo',
    checked_at: checkedAt,
  };
}

/** The Airalo client, or null when eSIMs are off or there are no keys. `cache`: where its token is kept. */
export function airaloFor(env = {}, { fetch: fetcher = globalThis.fetch, now = () => Date.now(), cache = null, timeoutMs = TIMEOUT } = {}) {
  if (!esimOn(env)) return null;
  const id = secret(env.AIRALO_CLIENT_ID), sec = secret(env.AIRALO_CLIENT_SECRET);
  if (!id || !sec) return null;
  const mode = env.AIRALO_SANDBOX === '1' ? 'sandbox' : 'live';
  const tk = `airtok1:${id.slice(0, 12)}`;
  let held = null, renew = null;
  const token = async (fresh) => {
    if (!fresh) {
      if (held) return held;
      const c = cache ? await cache.get(tk) : undefined;
      if (c) return (held = c);
    }
    const out = await request(fetcher, `${AIRALO}/v2/token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: id, client_secret: sec, grant_type: 'client_credentials' }).toString(),
    }, 'Airalo', timeoutMs);
    const t = out.data && typeof out.data.access_token === 'string' ? out.data.access_token : '';
    if (!t) throw new EsimError('unavailable', 'Airalo sent no access token.');
    const life = Math.min(ESIM.tokenMs, Math.max(60_000, (num(out.data.expires_in) || 0) * 1000 - 3600_000));
    if (cache) await cache.put(tk, t, life);
    return (held = t);
  };
  // a token Airalo no longer takes is asked for again, once
  const call = async (path, init = {}) => {
    const go = async (t) => request(fetcher, `${AIRALO}${path}`, { ...init, headers: { Accept: 'application/json', 'Accept-Language': 'en', ...(init.headers || {}), Authorization: `Bearer ${t}` } }, 'Airalo', timeoutMs);
    const used = await token(false);
    try { return await go(used); } catch (e) {
      if (!(e instanceof EsimError) || e.status !== 401) throw e;
      // calls made side by side share one new token (Airalo allows 3 token calls a minute)
      if (held === used || held === null) { held = null; renew ??= token(true).finally(() => { renew = null; }); }
      return go(await (renew || token(false)));
    }
  };
  return {
    id: 'airalo',
    mode,
    /** Packages for the trip's countries: each country's own, then regional and global ones covering any of them. */
    async packages({ countries, currency, days }) {
      const checkedAt = new Date(now()).toISOString();
      const lists = await Promise.all([
        ...countries.map((cc) => call(`/v2/packages?filter[type]=local&filter[country]=${cc}&limit=1000`)),
        call('/v2/packages?filter[type]=global&limit=1000'),
      ]);
      const out = [];
      for (const l of lists) {
        const data = Array.isArray(l.data) ? l.data : l.data && typeof l.data === 'object' ? Object.values(l.data) : [];
        for (const entry of data) for (const op of (entry && Array.isArray(entry.operators) ? entry.operators : [])) {
          for (const pk of (Array.isArray(op.packages) ? op.packages : [])) {
            const r = airaloResult(pk, op, entry, { want: countries, currency, days, checkedAt, mode });
            if (r && !out.some((x) => x.id === r.id)) out.push(r);
          }
        }
      }
      return out;
    },
    /** Buys one eSIM of a package; `description` lets the sweep find it again. */
    async order({ packageId, description }) {
      const form = new FormData();
      form.set('quantity', '1');
      form.set('package_id', packageId);
      form.set('type', 'sim');
      form.set('description', description);
      const out = await call('/v2/orders', { method: 'POST', body: form });
      if (!out.data || typeof out.data !== 'object' || out.data.id == null) throw new EsimError('unavailable', 'Airalo’s answer had no order.');
      return out.data;
    },
    /** The order made with this description, or null. */
    async findOrder(description) {
      const out = await call(`/v2/orders?filter[description]=${encodeURIComponent(description)}&include=sims&limit=5`);
      const list = Array.isArray(out.data) ? out.data : [];
      return list.find((o) => o && o.description === description) || null;
    },
  };
}

/** What an Airalo order says about installing its eSIM, kept on the trip. */
export function installOf(order, { trip, packageInfo, checkedAt, mode }) {
  const sims = Array.isArray(order.sims) ? order.sims : [];
  return {
    partner: 'airalo',
    order_id: String(order.id),
    code: text(order.code, 40),
    trip,
    title: text(order.package, 120) || (packageInfo && packageInfo.title) || 'eSIM',
    data_text: text(order.data, 40),
    validity_days: num(order.validity),
    test: mode === 'sandbox', // a sandbox ICCID can't be installed
    sims: sims.slice(0, 1).map((s) => ({
      iccid: text(s.iccid, 30),
      lpa: text(s.qrcode, 300), // "LPA:1$<SM-DP+>$<activation code>": what the QR code holds
      smdp: text(s.lpa, 120),
      activation_code: text(s.matching_id, 120),
      confirmation_code: text(s.confirmation_code, 60) || null,
      apple_url: https(s.direct_apple_installation_url),
      qr_url: https(s.qrcode_url),
      apn: s.apn_type === 'manual' ? text(s.apn_value, 60) || null : null,
      roaming: s.is_roaming === true,
      phone: text(s.msisdn, 20) || null,
    })),
    steps: plain(order.manual_installation, 1500),
    guide_url: order.installation_guides && https(order.installation_guides.en),
    install_by: packageInfo && packageInfo.install_within_days ? new Date(Date.parse(checkedAt) + packageInfo.install_within_days * 86400_000).toISOString().slice(0, 10) : null,
    source: mode === 'sandbox' ? 'Airalo (sandbox)' : 'Airalo',
    checked_at: checkedAt,
  };
}

/* ---------- eSIM Go (listed only) ---------- */

/** One eSIM Go bundle in Eden's shape; its price is Eden's cost (`cost`), never shown as a price to buy at. */
export function esimgoResult(b, { want, currency, days, checkedAt }) {
  if (!b || typeof b !== 'object') return null;
  const name = text(b.name, 120);
  if (!name) return null;
  const covers = [...new Set([...(Array.isArray(b.countries) ? b.countries : []), ...(Array.isArray(b.roamingEnabled) ? b.roamingEnabled : [])].map((c) => String((c && c.iso) || '').toUpperCase()).filter((c) => CC.test(c)))];
  const hits = want.filter((c) => covers.includes(c));
  if (!hits.length) return null;
  const dur = num(b.duration);
  const named = /_(\d+)D(_|$)/.exec(name); // the docs give no unit for duration: days only when the name agrees
  const validity = dur !== null && named && Number(named[1]) === dur ? dur : null;
  const cost = num(b.price);
  const unlimited = b.unlimited === true;
  return {
    partner: 'esimgo',
    id: name,
    title: text(b.description, 80) || name,
    operator: null,
    area: covers.length > 1 ? 'region' : 'country',
    area_name: null,
    data_mb: unlimited ? null : num(b.dataAmount),
    data_text: unlimited ? 'Unlimited' : num(b.dataAmount) !== null ? (b.dataAmount >= 1000 ? `${Math.round(b.dataAmount / 100) / 10} GB` : `${b.dataAmount} MB`) : null,
    unlimited,
    fair_use: null,
    voice: null, sms: null,
    validity_days: validity,
    duration_text: validity === null && dur !== null ? `${dur} (eSIM Go doesn’t say days or hours)` : null,
    price: null,
    cost: cost !== null && currency ? { amount: cost, currency, kind: 'cost' } : null,
    covers,
    covers_trip: hits,
    covers_all: hits.length === want.length,
    lasts_trip: validity !== null && days ? validity >= days : null,
    networks: [],
    roaming: null,
    activation: b.autostart === true ? 'Starts by itself' : null,
    install_within_days: null,
    top_up: null,
    about: null,
    orderable: false,
    source: 'eSIM Go',
    checked_at: checkedAt,
  };
}

/** The eSIM Go client (list only), or null when eSIMs are off or there's no key. */
export function esimgoFor(env = {}, { fetch: fetcher = globalThis.fetch, now = () => Date.now(), timeoutMs = TIMEOUT } = {}) {
  if (!esimOn(env)) return null;
  const k = secret(env.ESIMGO_API_KEY);
  if (!k) return null;
  const get = (path) => request(fetcher, `${ESIMGO}${path}`, { method: 'GET', headers: { 'X-API-Key': k, Accept: 'application/json' } }, 'eSIM Go', timeoutMs);
  return {
    id: 'esimgo',
    mode: 'live',
    async packages({ countries, days }) {
      const checkedAt = new Date(now()).toISOString();
      const [org, cat] = await Promise.all([get('/organisation'), get(`/catalogue?countries=${countries.join(',')}&perPage=200`)]);
      const o = org && (org.organisations ? org.organisations[0] : org);
      const currency = o && CUR.test(String(o.currency || '')) ? o.currency : null;
      const list = Array.isArray(cat) ? cat : Array.isArray(cat.bundles) ? cat.bundles : [];
      return list.map((b) => esimgoResult(b, { want: countries, currency, days, checkedAt })).filter(Boolean);
    },
  };
}

/* ---------- the account's ops ---------- */

const NOTE_OFF = {
  airalo: 'Airalo isn’t switched on yet (it needs Eden’s Airalo partner keys).',
  esimgo: 'eSIM Go isn’t switched on yet (it needs Eden’s eSIM Go key). It would be listed to compare only.',
};

/** Covers every country first, then lasts the whole trip, then cheaper, then more data. */
export function rank(a, b) {
  return (b.covers_all - a.covers_all) || ((b.lasts_trip === true) - (a.lasts_trip === true))
    || ((a.price ? a.price.amount : Infinity) - (b.price ? b.price.amount : Infinity))
    || ((b.unlimited ? Infinity : b.data_mb || 0) - (a.unlimited ? Infinity : a.data_mb || 0));
}

async function tripOf(account, id) {
  if (!TRIP_ID.test(String(id || ''))) throw new TripError('id must be a trip id.');
  const trip = await account.storage.get(`trip:${String(id)}`);
  if (!trip) throw new TripError('There is no such trip.', 404, 'not_found');
  return trip;
}

function where(trip, body) {
  let countries, from;
  if (body.countries != null) {
    if (!Array.isArray(body.countries) || !body.countries.length || body.countries.length > ESIM.countries) throw new TripError(`countries: 1 to ${ESIM.countries} ISO codes, like ["PT", "ES"].`);
    countries = [...new Set(body.countries.map((c) => String(c).trim().toUpperCase()))];
    const known = new Set(names().values());
    if (!countries.every((c) => CC.test(c) && known.has(c))) throw new TripError('countries: ISO codes of two letters, like PT.');
    from = 'asked';
  } else {
    countries = countriesIn(trip.destination).concat(countriesIn(trip.title)).filter((c, i, a) => a.indexOf(c) === i).slice(0, ESIM.countries);
    if (!countries.length) throw new TripError('Which countries? Eden couldn’t read a country in this trip’s destination.', 400, 'countries_needed');
    from = 'destination';
  }
  return { countries, from };
}

/** trip-esim, trip-esim-check, trip-esim-order, trip-esims. `deps.partners` lets tests hand in clients. */
export async function esimOp(account, op, body = {}, deps = {}) {
  const now = () => account.now();
  const storage = account.storage;
  const cache = deps.cache || { get: async () => undefined, put: async () => {} };
  const clientDeps = { fetch: deps.fetch, now, cache };
  const clients = deps.partners || { airalo: airaloFor(account.env, clientDeps), esimgo: esimgoFor(account.env, clientDeps) };
  const checkedAt = new Date(now()).toISOString();

  if (op === 'trip-esim') {
    const trip = await tripOf(account, body.id);
    const { countries, from } = where(trip, body);
    const days = Array.isArray(trip.days) && trip.days.length ? trip.days.length : null;
    const currency = CUR.test(String(body.currency || '')) ? String(body.currency) : trip.budget && CUR.test(String(trip.budget.currency || '')) ? trip.budget.currency : 'USD';
    const run = async (meta) => {
      const c = clients[meta.id];
      if (!c) return { ...meta, on: false, results: [], note: NOTE_OFF[meta.id], source: meta.name, checked_at: checkedAt };
      const ck = `esim1:${meta.id}:${c.mode}:${countries.join(',')}:${currency}:${days}`;
      try {
        let results = await cache.get(ck);
        if (results === undefined) {
          results = (await c.packages({ countries, currency, days })).sort(rank).slice(0, ESIM.max);
          await cache.put(ck, results, ESIM.resultsMs);
        }
        return { ...meta, on: true, mode: c.mode, results, source: meta.name, checked_at: results[0] ? results[0].checked_at : checkedAt };
      } catch (e) {
        if (!(e instanceof EsimError)) throw e;
        return { ...meta, on: true, mode: c.mode, results: [], error: e.message, code: e.code, source: meta.name, checked_at: checkedAt };
      }
    };
    const partners = await Promise.all(PARTNERS.map(run));
    // what the traveller may check and pay for next (trip-esim-check): only packages this account was shown
    const shown = partners.filter((p) => p.id === 'airalo').flatMap((p) => p.results.filter((r) => r.orderable).map((r) => r.id));
    if (shown.length) await storage.put(`esimls:${String(body.id)}`, { at: now(), countries, currency, days, ids: shown });
    return {
      countries: countries.map((code) => ({ code, name: countryName(code) })),
      countries_from: from,
      start: trip.start || null,
      end: trip.start && days ? dayDate(trip, days - 1) : null,
      days,
      currency,
      partners,
      checked_at: checkedAt,
    };
  }

  if (op === 'trip-esim-check') {
    await tripOf(account, body.id);
    const pid = text(body.package_id, 120);
    const shown = await storage.get(`esimls:${String(body.id)}`);
    if (!pid || !shown || !shown.ids.includes(pid)) throw new TripError('Look at the mobile data plans again first.', 409, 'check_expired');
    const c = clients.airalo;
    if (!c) throw new TripError(NOTE_OFF.airalo, 503, 'not_set_up');
    let list;
    try { list = await c.packages({ countries: shown.countries, currency: shown.currency, days: shown.days }); } catch (e) {
      if (e instanceof EsimError) throw new TripError(e.message, e.code === 'rate_limited' ? 429 : 503, e.code);
      throw e;
    }
    const p = list.find((x) => x.id === pid);
    if (!p || !p.price) throw new TripError('Airalo no longer sells that plan. Pick another.', 409, 'sold_out');
    const check = hex(8);
    await storage.put(`esq:${check}`, { at: now(), trip: String(body.id), package_id: pid, total: { amount: p.price.amount, currency: p.price.currency }, title: `eSIM: ${p.title}${p.area_name ? `, ${p.area_name}` : ''}`.slice(0, 120), info: { title: p.title, install_within_days: p.install_within_days }, mode: c.mode });
    return { check_id: check, title: p.title, area_name: p.area_name, price: p.price, validity_days: p.validity_days, data_text: p.data_text, install_within_days: p.install_within_days, covers_all: p.covers_all, pay_kind: 'esim', trip: String(body.id), source: p.source, checked_at: p.checked_at };
  }

  if (op === 'trip-esim-order') {
    if (body.confirm !== true) throw new TripError('trip-esim-order needs confirm: true.');
    const check = String(body.check_id || '');
    if (!CHECK_ID.test(check)) throw new TripError('check_id must be a price check.');
    const done = await storage.get(`esqdone:${check}`);
    if (done) return done; // ordered already (pay.js asked twice): the same answer, never a second eSIM
    const q = await storage.get(`esq:${check}`);
    if (!q || now() - q.at > ESIM.orderMs) throw new TripError('Check the plan’s price again first.', 409, 'check_expired');
    // only with the traveller's card held for at least the checked price, in its currency (pay.js passes `held`)
    const held = body.held && typeof body.held === 'object' ? body.held : null;
    if (!held || String(held.currency || '').toUpperCase() !== q.total.currency || !(Number(held.amount) >= q.total.amount - 1e-9)) throw new TripError('An eSIM is bought only once your card is held for it.', 402, 'pay_first');
    const c = clients.airalo;
    if (!c) throw new TripError(NOTE_OFF.airalo, 503, 'not_set_up');
    let order;
    try { order = await c.order({ packageId: q.package_id, description: `eden ${check}` }); } catch (e) {
      if (!(e instanceof EsimError)) throw e;
      if (e.code === 'check_status') { // Airalo: an identical order a moment ago; look for it rather than buy again
        const found = await c.findOrder(`eden ${check}`).catch(() => null);
        if (!found) throw new TripError(e.message, 409, 'check_status');
        order = found;
      } else throw new TripError(e.message, e.code === 'sold_out' ? 409 : 503, e.code);
    }
    return keepOrder(account, q, check, order, c.mode, deps);
  }

  if (op === 'trip-esims') {
    await tripOf(account, body.id);
    const list = [...(await storage.list({ prefix: `tesim:${String(body.id)}:` })).values()].sort((a, b) => (a.checked_at < b.checked_at ? -1 : 1));
    return { esims: list, trip: String(body.id) };
  }
  throw new TripError('Unknown eSIM op.', 404, 'not_found');
}

/** The order's installation details on the trip; the QR picture as a trip document when Airalo's is a picture. */
async function keepOrder(account, q, check, order, mode, deps) {
  const at = new Date(account.now()).toISOString();
  const rec = installOf(order, { trip: q.trip, packageInfo: q.info, checkedAt: at, mode });
  const qr = rec.sims[0] && rec.sims[0].qr_url;
  if (qr && !rec.test) {
    // best effort: the QR code also among the trip's documents (inbox.js checks it is really a PNG or JPEG)
    try {
      const f = deps.fetch || globalThis.fetch;
      const res = await f(qr, { signal: AbortSignal.timeout(TIMEOUT) });
      const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (res.ok && (type === 'image/png' || type === 'image/jpeg')) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        let bin = '';
        for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
        const d = await inboxOp(account, 'trip-doc-add', { id: q.trip, type, data: btoa(bin), name: `eSIM QR code: ${rec.title}`.slice(0, 120) });
        rec.doc = d.doc.id;
      }
    } catch (e) { console.error('esim qr doc', e && e.message); }
  }
  const out = { order_id: rec.order_id, code: rec.code, esim: rec };
  await account.storage.put({ [`tesim:${q.trip}:${rec.order_id}`]: rec, [`esqdone:${check}`]: out });
  await account.storage.delete(`esq:${check}`);
  return out;
}

/** pay.js's sweep (findBooking, kind 'esim'): was the eSIM for this check bought? → pay.js's { state, booking?, result? } */
export async function esimFound(account, args = {}, deps = {}) {
  const check = String(args.check_id || '');
  const done = CHECK_ID.test(check) ? await account.storage.get(`esqdone:${check}`) : null;
  if (done) return { state: 'made', booking: done.order_id, result: done };
  const q = CHECK_ID.test(check) ? await account.storage.get(`esq:${check}`) : null;
  const c = (deps.partners && deps.partners.airalo) || airaloFor(account.env, { fetch: deps.fetch, now: () => account.now(), cache: deps.cache });
  if (!q || !c) return { state: 'unknown' };
  const found = await c.findOrder(`eden ${check}`); // errors go to pay.js (state 'error')
  if (!found) return { state: 'none' };
  const out = await keepOrder(account, q, check, found, c.mode, deps);
  return { state: 'made', booking: out.order_id, result: out };
}

/** pay.js priceOf (kind 'esim'): the checked price, never the page's. */
export async function esimPrice(account, args = {}) {
  const q = await account.storage.get(`esq:${String(args.check_id || '')}`);
  if (!q || !q.total || account.now() - q.at > ESIM.checkMs) return null;
  return { cents: Math.round(Number(q.total.amount) * 100), currency: q.total.currency, title: q.title };
}

/** A trip's eSIM records gone with it (ops.js trip-delete, beside dropTripDocs). */
export async function dropTripEsims(storage, id) {
  const keys = [...(await storage.list({ prefix: `tesim:${id}:` })).keys()];
  for (let i = 0; i < keys.length; i += 128) await storage.delete(keys.slice(i, i + 128));
}
