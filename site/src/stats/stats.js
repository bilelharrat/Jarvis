// askeden.com's own numbers, for the owner's dashboard (/admin, stats/admin.js): one D1 table of
// events (binding STATS, database askeden-stats). Nothing here ever fails a request: a write that
// can't happen is dropped.
//
//   visit     a page someone opened (name: the path; ref: the site they came from)
//   download  an app download button (name: what)
//   signup    a new Eden account (name: how they signed in)
//   ai        AI the included allowance paid for (name: the feature; model, tokens, usd)
//   action    a POST/PUT/DELETE to /api (name: the route, ids taken out): what people use
//   error     a server error (name: the route; detail: what went wrong)
//   client    an error in someone's browser (name: the page; detail: the message)
//
// Every event names its product (productOf): eden (askeden.com's chat), edu, secretary (the Mac and
// iPhone assistant, once J.A.R.V.I.S.), code (Eden Code), daredevil, ask-eden (the Mac beta),
// messenger, router, news, help, site (the front and marketing pages).
//
// Never stored: names, emails, IP addresses, message text. `user` is a scrambled account id (the
// same person, never who), `visitor` a scrambled network + browser that changes every day (so
// unique visitors can be counted for a day and no longer). Where: Cloudflare's country, region
// and city for the request.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events (
    ts INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT, user TEXT, visitor TEXT,
    country TEXT, region TEXT, city TEXT, device TEXT, ref TEXT, product TEXT,
    usd REAL, tin INTEGER, tout INTEGER, model TEXT, detail TEXT)`,
  'CREATE INDEX IF NOT EXISTS events_kind_ts ON events (kind, ts)',
  'CREATE INDEX IF NOT EXISTS events_ts ON events (ts)',
];

const ready = new WeakMap(); // database → its table, made once per isolate
/** The table, made once per isolate. */
export function schema(env) {
  if (!env.STATS) return Promise.resolve(false);
  if (!ready.has(env.STATS)) {
    ready.set(env.STATS, env.STATS.batch(SCHEMA.map((s) => env.STATS.prepare(s))).then(() => true, (error) => {
      ready.delete(env.STATS);
      throw error;
    }));
  }
  return ready.get(env.STATS);
}

const COLS = ['ts', 'kind', 'name', 'user', 'visitor', 'country', 'region', 'city', 'device', 'ref', 'product', 'usd', 'tin', 'tout', 'model', 'detail'];
const cut = (v, n) => (v === undefined || v === null || v === '' ? null : String(v).slice(0, n));
const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);

/** Writes one event. → a promise that never rejects (give it to ctx.waitUntil). */
export async function record(env, event) {
  try {
    if (!env || !env.STATS) return;
    await schema(env);
    const row = {
      ts: Math.round(Date.now()), kind: cut(event.kind, 16), name: cut(event.name, 120), user: cut(event.user, 32), visitor: cut(event.visitor, 32),
      country: cut(event.country, 2), region: cut(event.region, 60), city: cut(event.city, 60), device: cut(event.device, 16), ref: cut(event.ref, 80), product: cut(event.product, 24),
      usd: num(event.usd), tin: num(event.tin), tout: num(event.tout), model: cut(event.model, 60), detail: cut(event.detail, 300),
    };
    await env.STATS.prepare(`INSERT INTO events (${COLS.join(',')}) VALUES (${COLS.map(() => '?').join(',')})`).bind(...COLS.map((c) => row[c])).run();
  } catch (error) {
    console.error('stats: not recorded', error && error.message);
  }
}

/** Where a request came from, as Cloudflare says (never the address itself), and what kind of device. */
export function where(request) {
  const cf = (request && request.cf) || {};
  return { country: cf.country || null, region: cf.region || null, city: cf.city || null, device: deviceOf(request && request.headers.get('user-agent')) };
}

export function deviceOf(ua = '') {
  const s = String(ua || '');
  if (/Eden|JARVIS|Electron/i.test(s) && /Macintosh|Mac OS/i.test(s)) return 'mac-app';
  if (/iPhone|iPod/.test(s)) return 'iphone';
  if (/iPad/.test(s)) return 'ipad';
  if (/Android/.test(s)) return 'android';
  if (/Windows/.test(s)) return 'windows';
  if (/Macintosh|Mac OS/.test(s)) return 'mac';
  if (/Linux|CrOS/.test(s)) return 'linux';
  return 'other';
}

export const isBot = (ua) => !ua || /bot|crawl|spider|slurp|preview|monitor|curl|wget|python|go-http|headless|lighthouse|facebookexternalhit|embedly|vercel|uptime/i.test(ua);

const enc = new TextEncoder();
async function hash(text) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
  return [...d.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const salt = (env) => `askeden-stats:${env.STATS_SALT || env.EDEN_TOKEN_KEY || 'eden'}`;

/** An account id, scrambled: the same person counts once, and the id can't be read back. */
export const userTag = (env, accountId) => (accountId ? hash(`${salt(env)}:user:${accountId}`) : null);

/** A network + browser, scrambled with today's date: one visitor for a day, then a new one. */
export function visitorTag(env, request) {
  const ip = request.headers.get('cf-connecting-ip') || '';
  const ua = request.headers.get('user-agent') || '';
  return hash(`${salt(env)}:visit:${new Date().toISOString().slice(0, 10)}:${ip}:${ua}`);
}

/** Which Eden product a request is for: by its host first (each product's own domain), then its path. */
export function productOf(host = '', path = '/') {
  const h = String(host).toLowerCase().replace(/^www\./, '');
  if (/askedenedu\.com$|^edu\.askeden\.com$/.test(h)) return 'edu';
  if (/(askedencode|edencode|codewitheden)\./.test(h)) return 'code';
  if (/(edensecretary|askedensecretary)\./.test(h)) return 'secretary';
  if (/edendaredevil\./.test(h)) return 'daredevil';
  if (/askedenmail\./.test(h)) return 'mail';
  if (/(edenrouter|askedenrouter)\./.test(h)) return 'router';
  if (/edenforbusiness\./.test(h)) return 'business';
  if (/^messenger\./.test(h)) return 'messenger';
  const p = String(path);
  if (/^\/(edu|edu-home)(\/|$)|^\/api\/edu|^\/lti\//.test(p)) return 'edu';
  if (/^\/(eden-code)(\/|$)|^\/api\/chat\/run/.test(p)) return 'code';
  if (/daredevil/.test(p)) return 'daredevil';
  if (/^\/(mail|mail-home)(\/|$)/.test(p)) return 'mail';
  if (/^\/(jarvis|eden-secretary)(\/|$)|^\/api\/(chat\/)?voice$/.test(p)) return 'secretary';
  if (/^\/(business|business-home)(\/|$)/.test(p)) return 'business';
  if (/^\/download\/mac$|^\/download\/windows$|^\/downloads\/ask-eden\//.test(p)) return 'ask-eden';
  if (/^\/(messenger)(\/|$)|^\/api\/eden\//.test(p)) return 'messenger';
  if (/^\/router(\/|$)/.test(p)) return 'router';
  if (/^\/(api\/)?news(\/|$)/.test(p)) return 'news';
  if (/^\/(api\/)?help(\/|$)/.test(p)) return 'help';
  if (/^\/(home|privacy|terms|accuracy|eves|eves-home|guides|signin|link|download|apps)(\/|$)/.test(p)) return 'site';
  return 'eden';
}

const refHost = (request, self) => {
  try {
    const host = new URL(request.headers.get('referer') || '').hostname.replace(/^www\./, '');
    return host && host !== self ? host : null;
  } catch {
    return null;
  }
};

/** Extract UTM parameters from a URL when present, for campaign attribution in /admin. */
export function utmFrom(url) {
  try {
    const u = typeof url === 'string' ? new URL(url, 'https://askeden.com') : url;
    const src = cut(u.searchParams.get('utm_source'), 60);
    const med = cut(u.searchParams.get('utm_medium'), 60);
    const cmp = cut(u.searchParams.get('utm_campaign'), 80);
    const trm = cut(u.searchParams.get('utm_term'), 60);
    if (!src && !med && !cmp && !trm) return null;
    return {
      source: src,
      medium: med,
      campaign: cmp,
      term: trm,
      summary: [src && `src=${src}`, med && `med=${med}`, cmp && `cmp=${cmp}`, trm && `term=${trm}`].filter(Boolean).join(' '),
    };
  } catch {
    return null;
  }
}

/** Optional server-side Google Analytics 4 Measurement Protocol forwarder (no browser JS required). */
async function sendGa4Event(env, clientId, name, params = {}) {
  const measurementId = env?.GA_MEASUREMENT_ID ? String(env.GA_MEASUREMENT_ID).trim() : '';
  const apiSecret = env?.GA_API_SECRET ? String(env.GA_API_SECRET).trim() : '';
  if (!measurementId || !apiSecret) return;
  try {
    await fetch(
      `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_id: clientId || 'anon.eden',
          events: [{ name: String(name).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40), params }],
        }),
      },
    );
  } catch {
    // never fail a request
  }
}

/** A route with its ids taken out: /api/web/devices/0123abcd…/signout → /api/web/devices/:id/signout */
export const routeName = (path) => path.split('/').map((s) => (/^[0-9a-f-]{8,}$/i.test(s) || /^\d+$/.test(s) || s.length > 40 ? ':id' : s)).join('/');

/**
 * What the Worker saw (worker.js, once per request, after it answered): a page visit, a download,
 * an action, a server error. `download` is the download's name, when it was one.
 */
export function observe(env, ctx, request, response, { path, download = null, error = null } = {}) {
  if (!env.STATS || !ctx) return;
  const ua = request.headers.get('user-agent') || '';
  const method = request.method;
  const status = response ? response.status : 500;
  const reqUrl = new URL(request.url);
  const host = reqUrl.hostname;
  const loc = { ...where(request), product: productOf(host, path) };
  const self = host.replace(/^www\./, '');
  const utm = utmFrom(reqUrl);
  const ref = refHost(request, self) || (utm && utm.source) || null;
  const tasks = [];
  if (error || status >= 500) {
    tasks.push({ kind: 'error', name: routeName(path), detail: error ? String(error.stack || error.message || error).slice(0, 300) : `HTTP ${status}`, ...loc });
  }
  if (download && method === 'GET' && status < 400 && !isBot(ua)) {
    const range = request.headers.get('range');
    if (!range || /^bytes=0-/.test(range)) tasks.push({ kind: 'download', name: download, ref, detail: utm ? utm.summary : null, ...loc, visitorFrom: request });
  } else if (path.startsWith('/api/')) {
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && status < 500) tasks.push({ kind: 'action', name: routeName(path), ...loc });
  } else if (method === 'GET' && status === 200 && !isBot(ua) && /text\/html/.test((response && response.headers.get('content-type')) || '')) {
    tasks.push({ kind: 'visit', name: routeName(path), ref, detail: utm ? utm.summary : null, ...loc, visitorFrom: request });
  }
  if (!tasks.length) return;
  ctx.waitUntil((async () => {
    for (const { visitorFrom, ...event } of tasks) {
      if (visitorFrom) event.visitor = await visitorTag(env, visitorFrom).catch(() => null);
      await record(env, event);
      if (event.kind === 'visit' || event.kind === 'download') {
        await sendGa4Event(env, event.visitor, event.kind === 'download' ? 'app_download' : 'page_view', {
          page_path: event.name,
          eden_product: event.product,
          ...(event.ref ? { traffic_source: event.ref } : {}),
        });
      }
    }
  })());
}

/** A browser's error report (POST /api/stats/error; web/hosted.js). Same site only (worker.js checks the Origin). */
export async function clientError(request, env, ctx) {
  const body = await request.json().catch(() => ({}));
  const loc = { ...where(request), product: productOf(new URL(request.url).hostname, String(body.page || '/')) };
  const message = String(body.message || '').slice(0, 300);
  if (message) ctx.waitUntil(record(env, { kind: 'client', name: routeName(String(body.page || '').slice(0, 120)), detail: message, ...loc }));
  return new Response(null, { status: 204 });
}

const ALLOWED_EVENTS = new Set([
  'cta_signin',
  'cta_get_started',
  'cta_download_mac',
  'cta_download_windows',
  'cta_edu_pilot',
  'cta_case_study',
  'cta_router_api',
  'lead_view',
  'lead_submit',
  'exit_intent_shown',
  'exit_intent_dismissed',
  'guide_read',
]);

/** A marketing funnel / conversion event from a browser (POST /api/stats/event). Same site only. */
export async function clientEvent(request, env, ctx) {
  const body = await request.json().catch(() => ({}));
  const rawName = String(body.event || body.name || '').trim().toLowerCase();
  if (!ALLOWED_EVENTS.has(rawName)) return new Response(null, { status: 204 });
  const pagePath = cut(body.page, 120) || '/';
  const detail = cut(body.detail || body.label, 200);
  const loc = { ...where(request), product: productOf(new URL(request.url).hostname, pagePath) };
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil((async () => {
      const visitor = await visitorTag(env, request).catch(() => null);
      await record(env, { kind: 'funnel', name: rawName, visitor, detail: [pagePath, detail].filter(Boolean).join(' · '), ...loc });
      await sendGa4Event(env, visitor, rawName, { page_path: pagePath, eden_product: loc.product, ...(detail ? { event_label: detail } : {}) });
    })());
  }
  return new Response(null, { status: 204 });
}

/** A new account (accounts/index.js accountForIdentity). */
export function signup(env, { accountId, provider, geo }) {
  return (async () => record(env, { kind: 'signup', name: provider || null, user: await userTag(env, accountId), ...(geo || {}), product: (geo && geo.product) || 'eden' }))();
}

/** AI the included allowance paid for (accounts/account.js spend). */
export function aiSpend(env, { accountId, usd, bucket, meta = {} }) {
  return (async () => record(env, {
    kind: 'ai', name: meta.feature || null, user: await userTag(env, accountId), usd, tin: meta.tin, tout: meta.tout, model: meta.model,
    detail: bucket ? String(bucket).split('|')[0] : null, country: meta.country, device: meta.device, product: meta.product || 'eden',
  }))();
}
