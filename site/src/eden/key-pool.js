// The key pool (docs/load-balancing.md): spreads a provider's calls over its keys (or a backend's URLs) and moves off
// a key that is rate-limited or failing. Health lives in memory in this Worker copy; no shared object.
//
//   order(provider, tiers, { env })  → the keys to try, in order
//   withPool(provider, list, fn, { signal, env, ordered }) → fn(key)'s Response, failing over to the next key
//   acquire / report / classify      → for loops that call fetch themselves (providers.js streamCall)
//   snapshot(env)                    → fingerprints and health for GET /api/admin/lb; never a key
//
// Tiers keep the cost order (Vertex credits, then primary keys, then fallback keys): a lower tier comes first only
// when every key above it is out of credit or quota for its account (402, quota words on 400-403, account words on
// a 429). A rate limit (429), an overload (529) or an open circuit (5xx/network) is mostly one model's or the
// provider's, so it only moves the key behind the healthy keys of its own tier; each call still fails over.
// Within a tier, the first key is picked by power-of-two-choices on in-flight calls plus recent errors. A sick key is
// still tried, last; it is never dropped. Only keys for the same provider and model go in one list: the pool never
// changes which model answers. A vertex:// key is never moved behind a lower tier (the GCP credits stay first).
// KEY_POOL=off: the input order, unchanged (today's fixed failover order).

const COOL_BASE_MS = 15_000; // a 429/529/402/quota without Retry-After: 15 s, doubling
const COOL_MAX_MS = 300_000; // to 5 min (Retry-After is capped here too)
const CIRCUIT_AFTER = 3; // 5xx/network failures in a row before the circuit opens
const CIRCUIT_MS = 30_000;
const RECENT_MS = 60_000; // errors this recent count against a key in the pick
const MAX_ENTRIES = 500;

/**
 * Error text that means "this key is out of quota or credit". providers.js QUOTA_FAILOVER_RE without the bare
 * "exceeded": a request's own error (OpenAI "context_length_exceeded") must not park a healthy key for everyone.
 */
export const QUOTA_RE = /usage limit|rate_limit|rate limit|credit balance|out of credit|quota|billing|regain access/i;
/** 429 text that means the account (not one model) is out: OpenAI insufficient_quota, Anthropic credit words. */
const ACCOUNT_RE = /insufficient_quota|credit balance|out of credit|regain access/i;

const state = new Map(); // `${provider}\n${sha256}` → entry
let clock = () => Date.now();
let random = () => Math.random();
let lastOn = true; // the kill switch as last read from env (env is fixed per deployment)

/** Tests only: forget all health; optional fake clock and random. */
export function resetPool({ now = null, rand = null } = {}) {
  state.clear();
  fpCache.clear();
  clock = now || (() => Date.now());
  random = rand || (() => Math.random());
  lastOn = true;
}

/** Whether the pool is on for this env: anything but KEY_POOL=off/0/false/no. */
export function poolOn(env) {
  const on = !/^(off|0|false|no)$/i.test(String((env && env.KEY_POOL) ?? '').trim());
  if (env) lastOn = on;
  return on;
}
/** The kill switch as last seen by order()/poolOn(env) in this Worker copy (for code that has no env, like streamCall). */
export const poolEnabled = () => lastOn;

// ── fingerprints: SHA-256, first 8 hex chars shown ──

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of a string (UTF-8), as hex. Synchronous, so the pool needs no await. */
export function sha256Hex(text) {
  const msg = new TextEncoder().encode(String(text));
  const len = msg.length;
  const total = (((len + 9 + 63) >> 6) << 6);
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, Math.floor(len / 0x20000000));
  view.setUint32(total - 4, (len << 3) >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}

const fpCache = new Map();
function hashOf(key) {
  let fp = fpCache.get(key);
  if (!fp) {
    if (fpCache.size >= MAX_ENTRIES) fpCache.clear();
    fp = sha256Hex(key);
    fpCache.set(key, fp);
  }
  return fp;
}
/** The 8-char fingerprint a key or URL is shown by (logs, the health route). */
export const fingerprint = (key) => hashOf(String(key)).slice(0, 8);

const kindOf = (key) => (key.startsWith('vertex://') ? 'vertex' : /^https?:\/\//i.test(key) ? 'url' : 'key');

// `width`: how many tiers the registering call had. The shown tier comes from the widest view, so callers that
// leave Vertex out (service-ai.js envKeyTiers) or pass a flat list don't flip it (order() itself uses its own index).
function entryOf(provider, key, create = false, tier = 0, width = 1) {
  const id = `${provider}\n${hashOf(key)}`;
  let e = state.get(id);
  if (!e && create) {
    if (state.size >= MAX_ENTRIES) {
      // forget the longest-unused one
      let oldest = null;
      for (const [k, v] of state) if (!oldest || v.seen < oldest[1].seen) oldest = [k, v];
      if (oldest) state.delete(oldest[0]);
    }
    e = { provider, fp: hashOf(key).slice(0, 8), kind: kindOf(key), tier, width, inFlight: 0, ok: 0, errors: 0, fails: 0, cools: 0, until: 0, wideUntil: 0, why: null, lastStatus: null, recent: [], seen: clock() };
    state.set(id, e);
  }
  if (e && create) {
    if (width >= e.width) {
      e.tier = tier;
      e.width = width;
    }
    e.seen = clock();
  }
  return e || null;
}

const tiersOf = (list) => {
  const raw = Array.isArray(list) ? list : list ? [list] : [];
  const tiers = raw.some((t) => Array.isArray(t)) ? raw.map((t) => (Array.isArray(t) ? t : [t])) : [raw];
  const seen = new Set();
  return tiers.map((t) => t.filter((k) => typeof k === 'string' && k && !seen.has(k) && seen.add(k))).filter((t) => t.length);
};

const score = (e, now) => e.inFlight + e.recent.filter((t) => now - t < RECENT_MS).length;

/**
 * The keys to try, in order. `tiers`: an array of arrays (best tier first), or a flat array (one tier).
 * Healthy keys of each tier come first (tier by tier; the first of a tier picked by power-of-two-choices,
 * the rest by load, ties in the given order), then the sick ones (cooling or circuit open), soonest-back first.
 * With KEY_POOL=off: the keys flattened in the given order.
 */
export function order(provider, tiers, { env = null } = {}) {
  const list = tiersOf(tiers);
  const flat = list.flat();
  if (env ? !poolOn(env) : !lastOn) return flat;
  const now = clock();
  const out = [];
  const sick = [];
  list.forEach((tier, t) => {
    const healthy = [];
    const cooling = [];
    for (const key of tier) {
      const e = entryOf(provider, key, true, t, list.length);
      // out of credit for the account: behind the lower tiers. A Vertex credential keeps its tier (moving it would
      // bill every Gemini model to the paid keys); each call still fails over (as before the pool)
      if (e.wideUntil > now && e.kind !== 'vertex') sick.push({ key, t, until: e.wideUntil });
      else if (e.until > now) cooling.push({ key, until: e.until }); // busy or failing: behind this tier's healthy keys
      else healthy.push({ key, s: score(e, now) });
    }
    if (healthy.length > 1) {
      const i = Math.floor(random() * healthy.length);
      let j = Math.floor(random() * (healthy.length - 1));
      if (j >= i) j++;
      const pick = healthy[j].s < healthy[i].s ? j : i; // a tie goes to the first draw, so idle keys share evenly
      out.push(healthy[pick].key);
      healthy.splice(pick, 1);
      healthy.sort((x, y) => x.s - y.s); // stable: ties keep the given order
    }
    for (const h of healthy) out.push(h.key);
    cooling.sort((x, y) => x.until - y.until);
    for (const c of cooling) out.push(c.key);
  });
  sick.sort((x, y) => x.t - y.t || x.until - y.until);
  for (const s of sick) out.push(s.key);
  return out;
}

/** Counts one call in flight on a key the pool knows; → release(), safe to call more than once. */
export function acquire(provider, key) {
  const e = typeof key === 'string' && key ? entryOf(provider, key) : null;
  if (!e) return () => {};
  e.inFlight++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    e.inFlight = Math.max(0, e.inFlight - 1);
  };
}

/**
 * What an answer means for the key: 'ok' (2xx/3xx), 'cooldown' (402, 429, 529, or 400-403 with quota words in
 * `body`), 'failure' (other 5xx; status 0 = network error), 'neutral' (other 4xx: the request's fault, not the key's).
 */
export function classify(status, body = '') {
  const s = Number(status) || 0;
  if (s === 0) return 'failure';
  if (s < 400) return 'ok';
  if (s === 402 || s === 429 || s === 529) return 'cooldown';
  if (s >= 400 && s <= 403 && QUOTA_RE.test(String(body || ''))) return 'cooldown';
  if (s >= 500) return 'failure';
  return 'neutral';
}
/** Whether a classified answer should move the call to the next key. */
export const shouldFailover = (kind) => kind === 'cooldown' || kind === 'failure';

/** A Retry-After header (seconds or an HTTP date) in ms; null: none or unreadable. */
export function retryAfterMs(headers) {
  const v = headers && typeof headers.get === 'function' ? headers.get('retry-after') : null;
  if (!v) return null;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return n * 1000;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/**
 * Records how a call on a key went: { kind (classify's), status?, retryAfter? (ms), body? (error text) }. Unknown keys
 * are ignored. A cooldown moves the key behind lower tiers only for 402, 400-403 or a 429 whose body has account words.
 */
export function report(provider, key, { kind, status = null, retryAfter = null, body = '' } = {}) {
  const e = typeof key === 'string' && key ? entryOf(provider, key) : null;
  if (!e) return;
  const now = clock();
  e.lastStatus = status;
  if (kind === 'ok') {
    e.ok++;
    e.fails = 0;
    e.cools = 0;
    e.until = 0;
    e.wideUntil = 0;
    e.why = null;
    return;
  }
  if (kind !== 'cooldown' && kind !== 'failure') return;
  e.errors++;
  e.recent = [...e.recent.filter((t) => now - t < RECENT_MS), now].slice(-20);
  if (kind === 'cooldown') {
    e.cools++;
    const wait = retryAfter != null && retryAfter >= 0 ? retryAfter : COOL_BASE_MS * 2 ** Math.min(e.cools - 1, 10);
    e.until = now + Math.min(wait, COOL_MAX_MS);
    const s = Number(status) || 0;
    if (s === 402 || (s >= 400 && s <= 403) || (s === 429 && ACCOUNT_RE.test(String(body || '')))) e.wideUntil = e.until;
    e.why = 'cooldown';
  } else {
    e.fails++;
    if (e.fails >= CIRCUIT_AFTER) {
      e.until = now + CIRCUIT_MS;
      e.why = 'circuit';
    }
  }
}

/**
 * Calls fn(key, index) → Response (or null: skip this key) on each key in pool order until one shouldn't fail over;
 * reports every outcome. Fails over on 402/429/529, 5xx, a thrown error (network) and 400-403 with quota words.
 * → the last Response (its body unread); throws the last error if every key threw; null if every key was skipped.
 * `list`: tiers or a flat list (see order()); `ordered: true` keeps the list's order as given (a providerKey entry
 * is already in pool order). In-flight counts until fn's Response arrives. An aborted `signal` stops the walk.
 * `retryThrown: false`: a thrown error is reported and thrown at once, no next key (paid, non-idempotent starts).
 */
export async function withPool(provider, list, fn, { signal = null, env = null, ordered = false, retryThrown = true } = {}) {
  const keys = ordered ? tiersOf(list).flat() : order(provider, list, { env });
  let last = null;
  let lastError = null;
  for (let i = 0; i < keys.length; i++) {
    if (signal && signal.aborted) break;
    const key = keys[i];
    const hasNext = i + 1 < keys.length;
    const release = acquire(provider, key);
    let res;
    try {
      res = await fn(key, i);
    } catch (error) {
      release();
      if (signal && signal.aborted) {
        if (last) cancelBody(last);
        throw error;
      }
      report(provider, key, { kind: 'failure', status: 0 });
      lastError = error;
      if (!retryThrown) {
        if (last) cancelBody(last);
        throw error;
      }
      if (hasNext) continue;
      if (last) return last;
      throw error;
    }
    release();
    if (!res) continue;
    const status = Number(res.status) || 0;
    let body = '';
    if ((status >= 400 && status <= 403) || status === 429) body = await res.clone().text().catch(() => '');
    const kind = classify(status, body);
    report(provider, key, { kind, status, body, retryAfter: kind === 'cooldown' ? retryAfterMs(res.headers) : null });
    if (!hasNext || !shouldFailover(kind)) {
      if (last && last !== res) cancelBody(last);
      return res;
    }
    if (last) cancelBody(last);
    last = res;
  }
  if (last) return last;
  if (lastError) throw lastError;
  return null;
}

function cancelBody(res) {
  try {
    if (res.body && !res.bodyUsed) res.body.cancel().catch(() => {});
  } catch {
    // already locked or gone
  }
}

/**
 * This Worker copy's pool, for the owner's health route: per provider, each key's fingerprint, kind, tier,
 * in-flight count, totals and state ('ok' | 'cooldown' | 'circuit') with ms until it is back. Never a key.
 */
export function snapshot(env = null) {
  const now = clock();
  const providers = {};
  for (const e of state.values()) {
    const back = e.until > now ? e.until - now : 0;
    (providers[e.provider] ||= []).push({
      fp: e.fp,
      kind: e.kind,
      tier: e.tier,
      inFlight: e.inFlight,
      ok: e.ok,
      errors: e.errors,
      failsInRow: e.fails,
      state: back ? e.why || 'cooldown' : 'ok',
      backInMs: back,
      lastStatus: e.lastStatus,
    });
  }
  for (const list of Object.values(providers)) list.sort((a, b) => a.tier - b.tier || a.fp.localeCompare(b.fp));
  return { on: env ? poolOn(env) : lastOn, at: new Date(now).toISOString(), providers };
}
