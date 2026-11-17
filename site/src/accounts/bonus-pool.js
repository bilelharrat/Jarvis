// The bonus pool (owner's decision D, 2026-11-13): Ultra, Platinum and Eden Black get up to +20% of
// their plan's AI each period, paid for ONLY by rollover that expired unused (never live rollover,
// never anyone's current allowance). One global Durable Object (binding BONUS_POOL,
// idFromName('global'), SQLite-backed; wrangler.toml migration with new_sqlite_classes ["BonusPool"]).
// Reached only from the Account objects (accounts/allowance.js poolSync) at https://pool/<op>; never
// from the Internet. Its state is the owner's only (GET /api/admin/bonus-pool).
//
//   POST contribute { key, usd, kind: "rollover" | "bonus_return" } → { ok, duplicate }
//        once per key: expired rollover (it funds the pool), or a bonus's unspent part given back
//   POST claim      { key, tier: ultra | platinum | black, weight: 100 | 200 | 400, cap_usd } → { usd, month, duplicate }
//        usd = min(weight × rate, cap_usd, avail − granted), fixed for the key; weight counts even at 0
//   POST state      → { months: [{ month, contrib, weight, avail, rate, granted }], settings }
//   POST settings   → the owner's switches { on, max_pct, tiers } (plans.js cleanBonus)
//   POST set-settings { on?, max_pct?, tiers? } → the switches now (the owner's /admin only, via worker.js)
//        Off, or a plan not ticked: its claims get 0 (their weight still counts, so the rate stays fair).
//        max_pct scales the cap the account sends (worked out at BONUS_MAX_PCT): 10% halves it, 40% doubles it.
//
// Months are the pool's own (UTC). Month M's state: contrib (in), weight (Σ the monthly list price of every
// claimant), avail (what M may grant), rate (dollars per weight dollar), granted. On the first op of a later
// month, M closes: avail(M+1) = contrib(M) + max(0, avail(M) − granted(M)), rate(M+1) = avail(M+1) / weight(M)
// (a skipped month: the last known weight; the first month: no weight yet, so nothing is granted).
// Every op is storage only, one at a time (the object's input gate, and a queue of our own), so two claims
// never see the same room: Σ granted(M) ≤ avail(M) always. Keys are kept 4 months, then a daily alarm drops them.

import { monthKey } from './allowance.js';
import { BONUS_MAX_PCT, BONUS_PCT_LIMIT, cleanBonus, poolOn } from './plans.js';
import { json } from './util.js';

const KEY = /^[\w:.-]{1,200}$/;
const TIERS = { ultra: 100, platinum: 200, black: 400 };
const KINDS = new Set(['rollover', 'bonus_return']);
const KEEP_MONTHS = 4; // contribute and claim keys: at least 100 days
const HISTORY_MONTHS = 24; // month records the owner sees
const DAY_MS = 86400_000;
const micro = (usd) => Math.round(usd * 1e6) / 1e6;
const floorMicro = (usd) => Math.floor(usd * 1e6 + 1e-6) / 1e6;
const bad = (why) => json({ error: why, code: 'bad_request' }, 400);

/** The month key `k` months from `m` ("2026-11", 1 → "2026-12"). */
export function addMonth(m, k) {
  const [y, mo] = m.split('-').map(Number);
  const t = y * 12 + (mo - 1) + k;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

const blank = () => ({ contrib: 0, weight: 0, avail: 0, rate: 0, granted: 0 });

export class BonusPool {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    this.queue = Promise.resolve();
  }

  now() {
    return Date.now();
  }

  async fetch(request) {
    const op = new URL(request.url).pathname.replace(/^\/+/, '');
    if (request.method !== 'POST' || !['contribute', 'claim', 'state', 'settings', 'set-settings'].includes(op)) return json({ error: 'No such thing here.', code: 'not_found' }, 404);
    const body = await request.json().catch(() => null);
    // One op at a time, even across awaits (the object's own input gate does this too).
    const run = this.queue.then(() => this.handle(op, body || {}));
    this.queue = run.catch(() => {});
    return run;
  }

  async handle(op, body) {
    const month = await this.roll();
    if (op === 'state') return json({ months: await this.months(), settings: await this.settings() });
    if (op === 'settings') return json(await this.settings());
    if (op === 'set-settings') {
      const next = cleanBonus({ ...(await this.settings()), ...body });
      await this.storage.put('settings', { ...next, at: this.now() });
      return json(next);
    }
    if (op === 'contribute') return this.contribute(body, month);
    return this.claim(body, month);
  }

  /** Brings the pool to this month, closing every month since the last op. → this month's key. */
  async roll() {
    const now = this.now();
    const M = monthKey(now);
    const cur = await this.storage.get('cur');
    if (!(await this.storage.getAlarm?.())) await this.storage.setAlarm?.(now + DAY_MS);
    if (!cur) {
      await this.storage.put({ cur: M, [`m:${M}`]: blank() });
      return M;
    }
    if (cur >= M) return cur;
    let prevKey = cur;
    let prev = (await this.storage.get(`m:${cur}`)) || blank();
    let lastWeight = Number(await this.storage.get('last_weight')) || 0;
    const puts = {};
    while (prevKey < M) {
      if (prev.weight > 0) lastWeight = prev.weight;
      const next = addMonth(prevKey, 1);
      const avail = micro(prev.contrib + Math.max(0, prev.avail - prev.granted));
      const rec = { ...blank(), avail, rate: lastWeight > 0 ? avail / lastWeight : 0 };
      puts[`m:${next}`] = rec;
      prevKey = next;
      prev = rec;
    }
    await this.storage.put({ ...puts, cur: M, last_weight: lastWeight });
    return M;
  }

  async contribute(body, month) {
    const key = String(body.key || '');
    const usd = Number(body.usd);
    if (!KEY.test(key)) return bad('key');
    if (typeof body.usd !== 'number' || !Number.isFinite(usd) || !(usd > 0) || usd > 1000) return bad('usd');
    if (!KINDS.has(body.kind)) return bad('kind');
    if (await this.storage.get(`c:${key}`)) return json({ ok: true, duplicate: true });
    const m = (await this.storage.get(`m:${month}`)) || blank();
    await this.storage.put({ [`m:${month}`]: { ...m, contrib: micro(m.contrib + usd) }, [`c:${key}`]: { usd: micro(usd), kind: body.kind, month } });
    return json({ ok: true, duplicate: false });
  }

  async claim(body, month) {
    const key = String(body.key || '');
    const weight = Number(body.weight);
    const cap = Number(body.cap_usd);
    if (!KEY.test(key)) return bad('key');
    if (!Object.hasOwn(TIERS, body.tier) || TIERS[body.tier] !== weight) return bad('tier');
    if (typeof body.cap_usd !== 'number' || !Number.isFinite(cap) || cap < 0 || cap > 1000) return bad('cap_usd');
    const seen = await this.storage.get(`k:${key}`);
    if (seen) return json({ usd: seen.usd, month: seen.month, duplicate: true });
    const m = (await this.storage.get(`m:${month}`)) || blank();
    const room = Math.max(0, m.avail - m.granted);
    const set = await this.settings();
    const allowed = set.on && set.tiers.includes(body.tier) ? (cap * set.max_pct) / BONUS_MAX_PCT : 0;
    const usd = Math.max(0, floorMicro(Math.min(weight * m.rate, allowed, room)));
    await this.storage.put({ [`m:${month}`]: { ...m, weight: m.weight + weight, granted: micro(m.granted + usd) }, [`k:${key}`]: { usd, month } });
    return json({ usd, month, duplicate: false });
  }

  /** The owner's switches (the defaults until first set). */
  async settings() {
    return cleanBonus(await this.storage.get('settings'));
  }

  async months() {
    const list = await this.storage.list({ prefix: 'm:' });
    return [...list].map(([k, v]) => ({ month: k.slice(2), contrib: v.contrib, weight: v.weight, avail: v.avail, rate: micro(v.rate), granted: v.granted })).sort((a, b) => (a.month < b.month ? 1 : -1));
  }

  /** Daily: contribute and claim keys older than KEEP_MONTHS go, and months older than HISTORY_MONTHS. */
  async alarm() {
    const run = this.queue.then(async () => {
      const M = monthKey(this.now());
      const keyCut = addMonth(M, -KEEP_MONTHS);
      const monthCut = addMonth(M, -HISTORY_MONTHS);
      const drop = [];
      for (const prefix of ['c:', 'k:']) for (const [k, v] of await this.storage.list({ prefix })) if (!v || !v.month || v.month < keyCut) drop.push(k);
      for (const [k] of await this.storage.list({ prefix: 'm:' })) if (k.slice(2) < monthCut) drop.push(k);
      for (let i = 0; i < drop.length; i += 128) await this.storage.delete(drop.slice(i, i + 128));
      await this.storage.setAlarm?.(this.now() + DAY_MS);
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

const poolStub = (env) => env.BONUS_POOL.get(env.BONUS_POOL.idFromName('global'));

// The switches as this Worker copy last read them: for the plan cards and the account meter (what they promise).
// Claims always read the object itself, so a change holds at once for what is granted; the words follow within a minute.
let seen = null; // { until, value }
/** The owner's bonus switches, read at most once a minute per Worker copy; the defaults when there is no pool or it fails. */
export async function bonusSettings(env) {
  if (!env || !env.BONUS_POOL) return cleanBonus(null);
  if (seen && seen.until > Date.now()) return seen.value;
  let value;
  try {
    const res = await poolStub(env).fetch('https://pool/settings', { method: 'POST', body: '{}' });
    value = res.ok ? cleanBonus(await res.json()) : cleanBonus(null);
  } catch {
    value = cleanBonus(null);
  }
  seen = { until: Date.now() + 60_000, value };
  return value;
}
/** Tests: forget the cached switches. */
export const forgetBonusSettings = () => { seen = null; };

/**
 * /api/admin/bonus-pool (the owner's session only; worker.js). GET: the months, newest first, and the switches.
 * POST { on?, max_pct?, tiers? }: changes the switches → { ready, active, settings }.
 */
export async function adminBonusPool(request, env, adminSession) {
  const notFound = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  if (!['GET', 'POST'].includes(request.method) || !(await adminSession(request, env))) return notFound();
  // active: whether the bonus runs at all (ALLOWANCE_V2 + PLANS_V2 + the binding); saving works either way, kept for later
  if (!env.BONUS_POOL) return json({ ready: false, active: poolOn(env), months: [], settings: cleanBonus(null) });
  if (request.method === 'POST') {
    // JSON only: a page elsewhere can't send it without asking first (and the session cookie is SameSite=Strict)
    if (!/^application\/json\b/i.test(request.headers.get('content-type') || '')) return json({ error: 'JSON only', code: 'bad_request' }, 415);
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('body');
    const pick = {};
    if ('on' in body) {
      if (typeof body.on !== 'boolean') return bad('on');
      pick.on = body.on;
    }
    if ('max_pct' in body) {
      if (typeof body.max_pct !== 'number' || !Number.isFinite(body.max_pct) || body.max_pct < 0 || body.max_pct > BONUS_PCT_LIMIT) return bad('max_pct');
      pick.max_pct = body.max_pct;
    }
    if ('tiers' in body) {
      if (!Array.isArray(body.tiers) || body.tiers.some((t) => !Object.hasOwn(TIERS, t))) return bad('tiers');
      pick.tiers = body.tiers;
    }
    const res = await poolStub(env).fetch('https://pool/set-settings', { method: 'POST', body: JSON.stringify(pick) });
    seen = null;
    return json({ ready: true, active: poolOn(env), settings: await res.json() });
  }
  const res = await poolStub(env).fetch('https://pool/state', { method: 'POST', body: '{}' });
  return json({ ready: true, active: poolOn(env), ...(await res.json()) });
}
