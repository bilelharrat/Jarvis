// The owner's dashboard: askeden.com/admin (public/admin/) and its numbers, GET /api/admin/stats.
// Only a browser signed in to an account with one of ADMIN_EMAILS among its sign-ins (Settings ›
// Account) gets either; anyone else gets the ordinary "not found".
//
// The numbers: stats.js's events (D1, from the day it was deployed), Stripe's balance
// transactions and subscriptions (all of history), GitHub's release download counts (all of
// history, the installers only), and Eden Messenger's own counts when MESSENGER_STATS_URL is set.

import { call } from '../accounts/index.js';
import { currentSession } from '../eden/session.js';
import { json } from '../accounts/util.js';
import { schema } from './stats.js';

const emails = (v) => String(v || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
const adminCache = new Map(); // account → { until, ok }

/** Whether this browser's account is the owner's. → the session, or null. */
export async function adminSession(request, env) {
  const allowed = emails(env.ADMIN_EMAILS);
  if (!allowed.length) return null;
  const { session } = await currentSession(request, env);
  if (!session) return null;
  const hit = adminCache.get(session.account);
  if (hit && hit.until > Date.now()) return hit.ok ? session : null;
  let ok = false;
  try {
    const view = await call(env, session.account, 'get', {}, session.token);
    ok = (view.identities || []).some((i) => i.email && allowed.includes(String(i.email).toLowerCase()));
  } catch {
    ok = false;
  }
  adminCache.set(session.account, { until: Date.now() + 300_000, ok });
  return ok ? session : null;
}

const notFound = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });

const ADMIN_FILES = new Set(['admin.js', 'admin.css']);
export const ADMIN_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** /admin and its two files. null: not an admin path. */
export async function adminPage(request, env, path) {
  if (path !== '/admin' && !path.startsWith('/admin/')) return null;
  if (!(await adminSession(request, env))) {
    if (path === '/admin') {
      const { session } = await currentSession(request, env);
      if (!session) return new Response(null, { status: 302, headers: { location: '/signin?return=%2Fadmin', 'cache-control': 'no-store' } });
    }
    return notFound();
  }
  const file = path === '/admin' ? '/admin/' : path;
  if (path !== '/admin' && !ADMIN_FILES.has(path.slice(7))) return notFound();
  const asset = await env.ASSETS.fetch(new Request(new URL(file, request.url)));
  const headers = new Headers(asset.headers);
  headers.set('cache-control', 'no-store');
  headers.set('vary', 'cookie');
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('x-robots-tag', 'noindex, nofollow');
  if (path === '/admin') headers.set('content-security-policy', ADMIN_CSP);
  return new Response(asset.body, { status: asset.status, headers });
}

// ── the numbers ──

const PERIODS = ['today', 'week', 'month', 'year'];

/** The client's period starts (its own time zone), checked; missing ones fall back to UTC. */
function bounds(url) {
  const now = Date.now();
  const d = new Date(now);
  const utc = {
    today: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    week: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)),
    month: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
    year: Date.UTC(d.getUTCFullYear(), 0, 1),
  };
  const out = {};
  for (const p of PERIODS) {
    const v = Number(url.searchParams.get(p));
    out[p] = Number.isInteger(v) && v > now - 400 * 86400_000 && v <= now ? v : utc[p];
  }
  const offset = Number(url.searchParams.get('offset')); // minutes east of UTC, for hours of the day
  out.offset = Number.isInteger(offset) && Math.abs(offset) <= 14 * 60 ? offset : 0;
  return out;
}

const sumsByPeriod = (b) => PERIODS.map((p) => `SUM(CASE WHEN ts >= ${Number(b[p])} THEN 1 ELSE 0 END) AS ${p}`).join(', ');

async function eventNumbers(env, b) {
  if (!env.STATS) return { ready: false };
  await schema(env);
  const db = env.STATS;
  const q = (sql, ...args) => db.prepare(sql).bind(...args);
  const monthAgo = Date.now() - 30 * 86400_000;
  const periodSums = (col) => PERIODS.map((p) => `SUM(CASE WHEN ts >= ${Number(b[p])} THEN ${col} ELSE 0 END) AS ${p}`).join(', ');
  const distinctBy = (col, kind) => PERIODS.map((p) => `(SELECT COUNT(DISTINCT ${col}) FROM events WHERE kind ${kind} AND ts >= ${Number(b[p])}) AS ${p}`).join(', ');
  const [counts, byProduct, ai, aiByModel, aiByProduct, aiByFeature, uniques, actives, actions, countries, cities, devices, refs, errors, hours, days, first, returning] = await db.batch([
    q(`SELECT kind, ${sumsByPeriod(b)}, COUNT(*) AS total FROM events GROUP BY kind`),
    q(`SELECT kind, COALESCE(product, 'eden') AS product, ${sumsByPeriod(b)}, COUNT(*) AS total FROM events WHERE kind IN ('visit','download','signup','action','error','client') GROUP BY kind, COALESCE(product, 'eden')`),
    q(`SELECT ${periodSums('usd')}, SUM(usd) AS total,
         ${PERIODS.map((p) => `SUM(CASE WHEN ts >= ${Number(b[p])} THEN COALESCE(tin,0) + COALESCE(tout,0) ELSE 0 END) AS tok_${p}`).join(', ')},
         SUM(COALESCE(tin,0) + COALESCE(tout,0)) AS tok_total, SUM(COALESCE(tin,0)) AS tin, SUM(COALESCE(tout,0)) AS tout, COUNT(*) AS calls
       FROM events WHERE kind = 'ai'`),
    q(`SELECT COALESCE(model, '(not recorded)') AS name, SUM(usd) AS usd, SUM(COALESCE(tin,0)+COALESCE(tout,0)) AS tokens, COUNT(*) AS n FROM events WHERE kind = 'ai' AND ts >= ? GROUP BY COALESCE(model, '(not recorded)') ORDER BY usd DESC LIMIT 15`, monthAgo),
    q(`SELECT COALESCE(product, 'eden') AS name, SUM(usd) AS usd, SUM(COALESCE(tin,0)+COALESCE(tout,0)) AS tokens, COUNT(*) AS n FROM events WHERE kind = 'ai' AND ts >= ? GROUP BY COALESCE(product, 'eden') ORDER BY usd DESC`, monthAgo),
    q(`SELECT COALESCE(name, '(other)') AS name, SUM(usd) AS usd, COUNT(*) AS n, COUNT(DISTINCT user) AS users FROM events WHERE kind = 'ai' AND ts >= ? GROUP BY COALESCE(name, '(other)') ORDER BY n DESC LIMIT 15`, monthAgo),
    q(`SELECT ${distinctBy('visitor', "= 'visit'")}`),
    q(`SELECT ${distinctBy('user', "= 'ai'")}`),
    q(`SELECT name, COALESCE(product, 'eden') AS product, COUNT(*) AS n FROM events WHERE kind = 'action' AND ts >= ? GROUP BY name, COALESCE(product, 'eden') ORDER BY n DESC LIMIT 30`, monthAgo),
    q(`SELECT COALESCE(country, '??') AS name, SUM(kind = 'visit') AS visits, SUM(kind = 'download') AS downloads, SUM(kind = 'signup') AS signups, SUM(kind = 'ai') AS ai FROM events WHERE ts >= ? GROUP BY COALESCE(country, '??') ORDER BY visits + downloads * 5 + signups * 10 DESC LIMIT 40`, monthAgo),
    q(`SELECT COALESCE(city, '?') AS city, COALESCE(region, '') AS region, COALESCE(country, '??') AS country, COUNT(*) AS n, SUM(kind = 'download') AS downloads, SUM(kind = 'signup') AS signups FROM events WHERE ts >= ? AND kind IN ('visit','download','signup') GROUP BY city, region, country ORDER BY n DESC LIMIT 25`, monthAgo),
    q(`SELECT COALESCE(device, 'other') AS name, SUM(kind = 'visit') AS visits, SUM(kind = 'download') AS downloads, SUM(kind = 'signup') AS signups FROM events WHERE ts >= ? GROUP BY COALESCE(device, 'other') ORDER BY visits DESC`, monthAgo),
    q(`SELECT ref AS name, COUNT(*) AS n FROM events WHERE kind IN ('visit','download') AND ref IS NOT NULL AND ts >= ? GROUP BY ref ORDER BY n DESC LIMIT 15`, monthAgo),
    q(`SELECT kind, name, COALESCE(product, 'eden') AS product, detail, COUNT(*) AS n, MAX(ts) AS last FROM events WHERE kind IN ('error','client') AND ts >= ? GROUP BY kind, name, substr(detail, 1, 80) ORDER BY last DESC LIMIT 40`, monthAgo),
    q(`SELECT CAST((CAST(ts / 60000 AS INTEGER) + ?) / 60 AS INTEGER) % 24 AS hour, SUM(kind = 'visit') AS visits, SUM(kind = 'ai') AS ai FROM events WHERE ts >= ? GROUP BY hour`, b.offset, monthAgo),
    q(`SELECT CAST((CAST(ts / 60000 AS INTEGER) + ?) / 1440 AS INTEGER) AS day, SUM(kind = 'visit') AS visits, COUNT(DISTINCT CASE WHEN kind = 'visit' THEN visitor END) AS visitors, SUM(kind = 'signup') AS signups, SUM(kind = 'download') AS downloads, SUM(CASE WHEN kind = 'ai' THEN usd ELSE 0 END) AS usd, COUNT(DISTINCT CASE WHEN kind = 'ai' THEN user END) AS users FROM events WHERE ts >= ? GROUP BY day ORDER BY day`, b.offset, monthAgo),
    q('SELECT MIN(ts) AS since FROM events'),
    q(`SELECT SUM(days > 1) AS came_back, SUM(days = 1) AS once FROM (SELECT user, COUNT(DISTINCT CAST(ts / 86400000 AS INTEGER)) AS days FROM events WHERE kind = 'ai' AND user IS NOT NULL AND ts >= ? GROUP BY user)`, monthAgo),
  ]);
  const rows = (r) => r.results || [];
  return {
    ready: true,
    since: rows(first)[0]?.since || null,
    counts: rows(counts),
    by_product: rows(byProduct),
    ai: { ...(rows(ai)[0] || {}), by_model: rows(aiByModel), by_product: rows(aiByProduct), by_feature: rows(aiByFeature) },
    unique_visitors: rows(uniques)[0] || {},
    active_users: rows(actives)[0] || {},
    actions: rows(actions),
    countries: rows(countries),
    cities: rows(cities),
    devices: rows(devices),
    referrers: rows(refs),
    errors: rows(errors),
    hours: rows(hours),
    days: rows(days).map((d) => ({ ...d, day: d.day * 86400_000 - b.offset * 60_000 })),
    returning: rows(returning)[0] || {},
  };
}

// Outside sources change slowly: kept for ten minutes per isolate.
const outside = new Map();
async function cached(key, fn) {
  const hit = outside.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  let value;
  try {
    value = await fn();
  } catch (error) {
    value = { error: String((error && error.message) || error).slice(0, 200) };
  }
  outside.set(key, { until: Date.now() + 600_000, value });
  return value;
}

/** Stripe: money in (charges and payments, less refunds), by period, and the subscriptions running now. */
async function stripeNumbers(env, b) {
  const key = String(env.STRIPE_SECRET_KEY || '').trim();
  if (!key) return { error: 'STRIPE_SECRET_KEY is not set.' };
  const get = async (path) => {
    const r = await fetch(`https://api.stripe.com/v1${path}`, { headers: { authorization: `Bearer ${key}` } });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Stripe ${r.status}: ${(out.error && out.error.message) || ''}`);
    return out;
  };
  const sums = { gross: {}, net: {}, fees: {}, refunds: {} };
  for (const k of Object.keys(sums)) for (const p of [...PERIODS, 'total']) sums[k][p] = 0;
  let currency = null;
  let other = 0;
  let after = null;
  let pages = 0;
  let count = 0;
  for (;;) {
    const page = await get(`/balance_transactions?limit=100${after ? `&starting_after=${after}` : ''}`);
    for (const t of page.data || []) {
      if (!['charge', 'payment', 'refund', 'payment_refund'].includes(t.type)) continue;
      if (currency && t.currency !== currency) { other++; continue; }
      currency ||= t.currency;
      count++;
      const at = t.created * 1000;
      const refund = t.type === 'refund' || t.type === 'payment_refund';
      for (const p of [...PERIODS, 'total']) {
        if (p !== 'total' && at < b[p]) continue;
        if (refund) sums.refunds[p] += -t.amount / 100;
        else sums.gross[p] += t.amount / 100;
        sums.fees[p] += t.fee / 100;
        sums.net[p] += t.net / 100;
      }
    }
    if (!page.has_more || !page.data.length || ++pages >= 40) break;
    after = page.data[page.data.length - 1].id;
  }
  let subs = 0;
  let mrr = 0;
  after = null;
  for (let i = 0; i < 20; i++) {
    const page = await get(`/subscriptions?status=active&limit=100${after ? `&starting_after=${after}` : ''}`);
    for (const s of page.data || []) {
      subs++;
      for (const item of (s.items && s.items.data) || []) {
        const price = item.price || {};
        const per = price.recurring || {};
        const monthly = (price.unit_amount || 0) / 100 * (item.quantity || 1) * (per.interval === 'year' ? 1 / 12 : per.interval === 'week' ? 52 / 12 : per.interval === 'day' ? 30 : 1) / (per.interval_count || 1);
        mrr += monthly;
      }
    }
    if (!page.has_more || !page.data.length) break;
    after = page.data[page.data.length - 1].id;
  }
  return { currency: currency || 'usd', ...sums, transactions: count, other_currency: other, active_subscriptions: subs, mrr: Math.round(mrr * 100) / 100, partial: pages >= 40, live: key.startsWith('sk_live') || key.startsWith('rk_live') };
}

const RELEASE_REPOS = ['bilelharrat/Jarvis'];
// A release's tag → its product; the file's extension → the platform.
const tagProduct = (tag) => (/^daredevil/.test(tag) ? 'daredevil' : /^eden-code/.test(tag) ? 'code' : /^ask-eden/.test(tag) ? 'ask-eden' : /^(jarvis|v\d)/.test(tag) ? 'secretary' : 'other');
const filePlatform = (name) => (/\.exe$/i.test(name) ? 'windows' : /\.(dmg|zip)$/i.test(name) ? 'mac' : /\.(apk|aab)$/i.test(name) ? 'android' : null);

/** GitHub: every installer ever downloaded from the releases, by product and platform; update checks (release.json) apart. */
async function githubNumbers(env) {
  const headers = { 'user-agent': 'askeden-admin', accept: 'application/vnd.github+json' };
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const out = { installers: {}, update_checks: 0, total: 0 };
  for (const repo of RELEASE_REPOS) {
    for (let page = 1; page <= 5; page++) {
      const r = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, { headers });
      if (!r.ok) throw new Error(`GitHub ${r.status}`);
      const list = await r.json();
      for (const rel of list) {
        for (const a of rel.assets || []) {
          if (a.name === 'release.json') { out.update_checks += a.download_count; continue; }
          const platform = filePlatform(a.name);
          if (!platform) continue;
          const k = `${tagProduct(rel.tag_name)}:${platform}`;
          out.installers[k] = (out.installers[k] || 0) + a.download_count;
          out.total += a.download_count;
        }
      }
      if (list.length < 100) break;
    }
  }
  return out;
}

/** Eden Messenger runs on its own server: its counts, when it offers them (MESSENGER_STATS_URL + MESSENGER_STATS_TOKEN). */
async function messengerNumbers(env, b) {
  const url = String(env.MESSENGER_STATS_URL || '').trim();
  if (!/^https:\/\//.test(url)) return { error: 'not connected' };
  const q = new URLSearchParams(PERIODS.map((p) => [p, String(b[p])]));
  const r = await fetch(`${url}?${q}`, { headers: { authorization: `Bearer ${env.MESSENGER_STATS_TOKEN || ''}` } });
  if (!r.ok) throw new Error(`Messenger ${r.status}`);
  return r.json();
}

/** GET /api/admin/stats: everything the dashboard shows. 404 for anyone but the owner. */
export async function adminStats(request, env) {
  if (request.method !== 'GET') return notFound();
  if (!(await adminSession(request, env))) return notFound();
  const res = json(await collect(env, new URL(request.url)));
  res.headers.set('cache-control', 'no-store');
  return res;
}

/** Everything the dashboard shows, for the periods `url` names. */
export async function collect(env, url) {
  const b = bounds(url);
  const fresh = url.searchParams.get('fresh') === '1';
  if (fresh) outside.clear();
  const [events, stripe, github, messenger] = await Promise.all([
    eventNumbers(env, b).catch((error) => ({ ready: false, error: String(error && error.message).slice(0, 200) })),
    cached(`stripe:${PERIODS.map((p) => b[p]).join(':')}`, () => stripeNumbers(env, b)),
    cached('github', () => githubNumbers(env)),
    cached(`messenger:${b.today}`, () => messengerNumbers(env, b)),
  ]);
  return { at: Date.now(), bounds: b, users_before: Number(env.USERS_BEFORE_STATS) || null, unlimited: emails(env.UNLIMITED_EMAILS).length, events, stripe, github, messenger };
}
