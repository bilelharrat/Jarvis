// What each AI provider itself says Eden spent and has left (owner, 2026-11-14): the provider's own billing API,
// read when the owner opens /admin (stats/admin.js, cached ten minutes), never Eden's own estimate. Eden's own
// count per app and model is the events table (stats.js) and the company spend counter (eden/spend-counter.js);
// this is the bill to check them against. Owner-only; no key or secret is ever sent to the page.
//
//   provider    what it reads                                         the key (a Worker secret)
//   openai      Costs API (by day and line item), Usage API (tokens      OPENAI_ADMIN_KEY: an organization ADMIN key
//               by day, model and API key). Credit balance: console.    (platform.openai.com › Admin keys), not a project key
//   anthropic   cost_report (by day and model), usage_report/messages    ANTHROPIC_ADMIN_KEY: sk-ant-admin… (Console ›
//               (tokens by model and API key). Credit balance: console.  Settings › Admin keys; needs an organization)
//   google      Cloud Billing's BigQuery export: this month's cost by     GCP_BILLING_TABLE ("project.dataset.table") and
//               service, and credits applied. Credits LEFT: console only. a service account with BigQuery read (GCP_BILLING_
//                                                                        CREDENTIALS, else VERTEX_CREDENTIALS)
//   kimi        Moonshot's balance (cash + vouchers)                     MOONSHOT_API_KEY (the one Eden already uses)
//   deepinfra   this month's cost by model, and the balance              DEEPINFRA_API_KEY with the billing:read scope
//   fish        Fish Audio's API credit                                  FISH_API_KEY (the one Eden already uses)
//   perplexity  no billing API: a link to its console                    —
//
// Per app: give each app (askeden.com, Eden Code, Eden Secretary, the Mac app…) its own API key or project/workspace
// at the provider, and name them in PROVIDER_KEY_APPS (JSON): { "openai": { "key_abc…": "askeden.com",
// "proj_…": "Eden Code" }, "anthropic": { "apikey_01…": "Eden Secretary", "wrkspc_…": "Mac app" } }. Usage by key
// then shows each app's tokens; anything unnamed shows its id.
//
// Alerts on the page: a balance under SPEND_ALERT_FLOOR_USD (default 20), and a provider whose spend yesterday was
// over SPEND_ALERT_DAY_USD (JSON { "openai": 30, … } or one number for all; unset: no day alert).

const TIMEOUT_MS = 8000;
const DEADLINE_MS = 12_000; // a provider's whole read, all its pages (PROVIDER_DEADLINE_MS overrides it)
const DAY_MS = 86400_000;
const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const cut = (s, n = 160) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);
// a key-looking string never leaves this file, even inside an error message
const scrub = (s) => cut(s, 200).replace(/\b(sk|rk|pk)[-_][A-Za-z0-9_-]{8,}|\bAIza[0-9A-Za-z_-]{20,}|\bya29\.[0-9A-Za-z._-]+|\bBearer\s+\S+/g, '[key]');

export const PROVIDERS = Object.freeze([
  { id: 'openai', name: 'OpenAI', console: 'https://platform.openai.com/settings/organization/billing/overview' },
  { id: 'anthropic', name: 'Anthropic', console: 'https://console.anthropic.com/settings/billing' },
  { id: 'google', name: 'Google Cloud (Gemini, Vertex, Maps)', console: 'https://console.cloud.google.com/billing/credits' },
  { id: 'kimi', name: 'Moonshot (Kimi)', console: 'https://platform.moonshot.ai/console/account' },
  { id: 'deepinfra', name: 'DeepInfra', console: 'https://deepinfra.com/dash/billing' },
  { id: 'fish', name: 'Fish Audio', console: 'https://fish.audio/app/billing/' },
  { id: 'perplexity', name: 'Perplexity (Sonar)', console: 'https://www.perplexity.ai/account/api/billing' },
]);

class Refused extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function getJson(url, headers, init = {}) {
  let res;
  try {
    res = await fetch(url, { ...init, headers: { accept: 'application/json', ...headers, ...(init.headers || {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new Refused(0, error && error.name === 'TimeoutError' ? 'timed out' : 'could not reach it');
  }
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const e = body && (body.error || body.detail || body.message);
    const msg = typeof e === 'string' ? e : e && typeof e.message === 'string' ? e.message : '';
    throw new Refused(res.status, `HTTP ${res.status}${msg ? `: ${msg}` : ''}`);
  }
  return body || {};
}

/** The key-to-app names (PROVIDER_KEY_APPS), checked: strings only. */
export function keyApps(env) {
  let v = {};
  try {
    v = JSON.parse(String((env && env.PROVIDER_KEY_APPS) || '{}'));
  } catch {
    v = {};
  }
  const out = {};
  for (const [p, map] of Object.entries(v && typeof v === 'object' && !Array.isArray(v) ? v : {})) {
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
    out[p] = Object.fromEntries(Object.entries(map).filter(([k, name]) => typeof k === 'string' && typeof name === 'string' && name.trim()).map(([k, name]) => [k, cut(name, 60)]));
  }
  return out;
}

const addTo = (map, key, usd = 0, tokens = 0) => {
  const r = map.get(key) || { usd: 0, tokens: 0 };
  r.usd += usd;
  r.tokens += tokens;
  map.set(key, r);
};
const listOf = (map, extra = () => ({})) => [...map].map(([name, r]) => ({ name, usd: round(r.usd), tokens: Math.round(r.tokens), ...extra(name) })).sort((a, b) => b.usd - a.usd || b.tokens - a.tokens).slice(0, 25);
const daysOf = (map) => [...map].map(([day, r]) => ({ day, usd: round(r.usd), tokens: Math.round(r.tokens) })).sort((a, b) => (a.day < b.day ? -1 : 1));

// ── each provider ──

async function openai(env, t) {
  const key = env.OPENAI_ADMIN_KEY;
  if (!key) return { status: 'setup', note: 'Add OPENAI_ADMIN_KEY (an organization admin key) to read OpenAI’s own spend and tokens.' };
  const h = { authorization: `Bearer ${key}` };
  const start = Math.floor(t.monthStart / 1000);
  const days = new Map();
  const items = new Map();
  let page = null;
  for (let i = 0; i < 5; i++) {
    const q = new URLSearchParams({ start_time: String(start), bucket_width: '1d', limit: '31' });
    q.append('group_by', 'line_item');
    if (page) q.set('page', page);
    const r = await getJson(`https://api.openai.com/v1/organization/costs?${q}`, h);
    for (const b of r.data || []) {
      const day = dayOf(Number(b.start_time) * 1000);
      for (const x of b.results || []) {
        const usd = num(x.amount && x.amount.value) || 0;
        addTo(days, day, usd);
        addTo(items, x.line_item || '(other)', usd);
      }
    }
    if (!r.has_more || !r.next_page) break;
    page = r.next_page;
  }
  // tokens by model and by API key (completions; the costs above include every other kind)
  const models = new Map();
  const keys = new Map();
  let tin = 0;
  let tout = 0;
  page = null;
  for (let i = 0; i < 5; i++) {
    const q = new URLSearchParams({ start_time: String(start), bucket_width: '1d', limit: '31' });
    q.append('group_by', 'model');
    q.append('group_by', 'api_key_id');
    if (page) q.set('page', page);
    const r = await getJson(`https://api.openai.com/v1/organization/usage/completions?${q}`, h);
    for (const b of r.data || []) {
      const day = dayOf(Number(b.start_time) * 1000);
      for (const x of b.results || []) {
        const i1 = (num(x.input_tokens) || 0) + (num(x.input_audio_tokens) || 0);
        const o1 = (num(x.output_tokens) || 0) + (num(x.output_audio_tokens) || 0);
        tin += i1;
        tout += o1;
        addTo(models, x.model || '(not given)', 0, i1 + o1);
        addTo(keys, x.api_key_id || '(no key id)', 0, i1 + o1);
        addTo(days, day, 0, i1 + o1);
      }
    }
    if (!r.has_more || !r.next_page) break;
    page = r.next_page;
  }
  return { status: 'ok', by_day: daysOf(days), by_item: listOf(items), by_model: listOf(models), by_key: listOf(keys), tokens: { in: tin, out: tout }, balance: null, balance_note: 'OpenAI has no API for prepaid credit: see the console.' };
}

async function anthropic(env, t) {
  const key = env.ANTHROPIC_ADMIN_KEY;
  if (!key) return { status: 'setup', note: 'Add ANTHROPIC_ADMIN_KEY (sk-ant-admin…, Console › Settings › Admin keys) to read Anthropic’s own spend and tokens.' };
  const h = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  const startIso = new Date(t.monthStart).toISOString();
  const days = new Map();
  const models = new Map();
  let page = null;
  for (let i = 0; i < 5; i++) {
    const q = new URLSearchParams({ starting_at: startIso, bucket_width: '1d', limit: '31' });
    q.append('group_by[]', 'description');
    if (page) q.set('page', page);
    const r = await getJson(`https://api.anthropic.com/v1/organizations/cost_report?${q}`, h);
    for (const b of r.data || []) {
      const day = String(b.starting_at || '').slice(0, 10);
      for (const x of b.results || []) {
        const usd = (num(x.amount) || 0) / 100; // a decimal string in cents
        addTo(days, day, usd);
        addTo(models, x.model || x.description || x.cost_type || '(other)', usd);
      }
    }
    if (!r.has_more || !r.next_page) break;
    page = r.next_page;
  }
  const keys = new Map();
  let tin = 0;
  let tout = 0;
  page = null;
  for (let i = 0; i < 5; i++) {
    const q = new URLSearchParams({ starting_at: startIso, bucket_width: '1d', limit: '31' });
    q.append('group_by[]', 'api_key_id');
    q.append('group_by[]', 'model');
    if (page) q.set('page', page);
    const r = await getJson(`https://api.anthropic.com/v1/organizations/usage_report/messages?${q}`, h);
    for (const b of r.data || []) {
      const day = String(b.starting_at || '').slice(0, 10);
      for (const x of b.results || []) {
        const cc = x.cache_creation || {};
        const i1 = (num(x.uncached_input_tokens) || 0) + (num(x.cache_read_input_tokens) || 0) + (num(cc.ephemeral_5m_input_tokens) || 0) + (num(cc.ephemeral_1h_input_tokens) || 0);
        const o1 = num(x.output_tokens) || 0;
        tin += i1;
        tout += o1;
        addTo(keys, x.api_key_id || '(Console / no key)', 0, i1 + o1);
        addTo(models, x.model || '(not given)', 0, i1 + o1);
        addTo(days, day, 0, i1 + o1);
      }
    }
    if (!r.has_more || !r.next_page) break;
    page = r.next_page;
  }
  return { status: 'ok', by_day: daysOf(days), by_model: listOf(models), by_key: listOf(keys), tokens: { in: tin, out: tout }, balance: null, balance_note: 'Anthropic has no API for prepaid credit: see the console.' };
}

function b64url(bytes) {
  let bin = '';
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function serviceAccount(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  for (const text of [s, (() => { try { return atob(s); } catch { return ''; } })()]) {
    try {
      const v = JSON.parse(text);
      if (v && v.type === 'service_account' && v.client_email && v.private_key) return v;
    } catch { /* next */ }
  }
  return null;
}
async function googleToken(sa) {
  const der = Uint8Array.from(atob(String(sa.private_key).replace(/-----[^-]+-----|\s+/g, '')), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der.buffer, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const input = `${b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))}.${b64url(enc.encode(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/bigquery.readonly', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })))}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(input));
  const tok = await getJson('https://oauth2.googleapis.com/token', { 'content-type': 'application/x-www-form-urlencoded' }, { method: 'POST', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${input}.${b64url(sig)}` }).toString() });
  if (!tok.access_token) throw new Refused(0, 'Google gave no token');
  return tok.access_token;
}

const TABLE = /^[a-z][a-z0-9-]{4,62}\.[A-Za-z0-9_]{1,1024}\.[A-Za-z0-9_]{1,1024}$/;
async function google(env, t) {
  const table = String(env.GCP_BILLING_TABLE || '').trim();
  const sa = serviceAccount(env.GCP_BILLING_CREDENTIALS || env.VERTEX_CREDENTIALS);
  if (!TABLE.test(table) || !sa) {
    return { status: 'setup', note: 'Turn on Billing › Billing export › Standard usage cost to BigQuery once, then set GCP_BILLING_TABLE (project.dataset.table). Credits left are only in the console.' };
  }
  const token = await googleToken(sa);
  const project = table.split('.')[0];
  const start = dayOf(t.monthStart);
  // the table name is checked above; the date is a parameter
  const query = `SELECT DATE(usage_start_time) AS day, service.description AS service, SUM(cost) AS cost,
      SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS credits, ANY_VALUE(currency) AS currency
    FROM \`${table}\` WHERE DATE(usage_start_time) >= @start GROUP BY day, service`;
  const r = await getJson(`https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries`, { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, {
    method: 'POST',
    body: JSON.stringify({ query, useLegacySql: false, timeoutMs: 7000, parameterMode: 'NAMED', queryParameters: [{ name: 'start', parameterType: { type: 'DATE' }, parameterValue: { value: start } }] }),
  });
  if (r.jobComplete === false) return { status: 'error', note: 'BigQuery is still working on it: refresh in a minute.' };
  const days = new Map();
  const services = new Map();
  let credits = 0;
  let currency = 'USD';
  for (const row of r.rows || []) {
    const [day, service, cost, cr, cur] = (row.f || []).map((c) => c && c.v);
    const gross = num(cost) || 0;
    const applied = num(cr) || 0; // negative
    credits += applied;
    if (cur) currency = cur;
    addTo(days, String(day), gross + applied);
    addTo(services, service || '(other)', gross + applied);
  }
  return {
    status: 'ok',
    currency,
    by_day: daysOf(days),
    by_model: listOf(services),
    credits_applied_usd: round(-credits),
    balance: null,
    balance_note: 'Google gives no API for credits left: the console’s Billing › Credits page has it. The export runs about a day behind.',
  };
}

async function kimi(env) {
  if (!env.MOONSHOT_API_KEY) return { status: 'setup', note: 'No MOONSHOT_API_KEY on the Worker.' };
  const r = await getJson('https://api.moonshot.ai/v1/users/me/balance', { authorization: `Bearer ${env.MOONSHOT_API_KEY}` });
  const d = r.data || {};
  const available = num(d.available_balance);
  if (available === null) return { status: 'error', note: 'Moonshot answered without a balance.' };
  return { status: 'ok', balance: { usd: round(available), cash_usd: num(d.cash_balance), voucher_usd: num(d.voucher_balance) }, note: 'Moonshot gives a balance only, no spend by day.' };
}

async function deepinfra(env, t) {
  if (!env.DEEPINFRA_API_KEY) return { status: 'setup', note: 'No DEEPINFRA_API_KEY on the Worker.' };
  const h = { authorization: `Bearer ${env.DEEPINFRA_API_KEY}` };
  const ym = dayOf(t.monthStart).slice(0, 7).replace('-', '.');
  const [usage, check] = await Promise.all([
    getJson(`https://api.deepinfra.com/payment/usage?from=${ym}&to=${ym}`, h),
    getJson('https://api.deepinfra.com/payment/checklist', h).catch(() => null),
  ]);
  const models = new Map();
  let month = 0;
  for (const m of usage.months || []) {
    month += (num(m.total_cost) || 0) / 100;
    for (const it of m.items || []) addTo(models, (it.model && it.model.model_name) || '(other)', (num(it.cost) || 0) / 100);
  }
  const owed = check ? num(check.stripe_balance) : null; // cents; below 0 is money there to spend
  return {
    status: 'ok',
    month_usd: round(month),
    by_model: listOf(models),
    balance: owed === null ? null : { usd: round(-owed / 100) },
    note: 'DeepInfra reports by month, not by day.',
  };
}

async function fish(env) {
  if (!env.FISH_API_KEY) return { status: 'setup', note: 'No FISH_API_KEY on the Worker.' };
  const r = await getJson('https://api.fish.audio/wallet/self/api-credit', { authorization: `Bearer ${env.FISH_API_KEY}` });
  const credit = num(r.credit);
  if (credit === null) return { status: 'error', note: 'Fish Audio answered without a credit.' };
  return { status: 'ok', balance: { usd: round(credit) }, note: 'Fish Audio gives its API credit only, no spend by day.' };
}

const READERS = { openai, anthropic, google, kimi, deepinfra, fish, perplexity: async () => ({ status: 'console', note: 'Perplexity has no billing API: its console has the spend and credit.' }) };

function dayLimits(env) {
  const raw = String((env && env.SPEND_ALERT_DAY_USD) || '').trim();
  if (!raw) return {};
  if (/^\d+(\.\d+)?$/.test(raw)) return Object.fromEntries(PROVIDERS.map((p) => [p.id, Number(raw)]));
  try {
    const v = JSON.parse(raw);
    return Object.fromEntries(Object.entries(v && typeof v === 'object' ? v : {}).filter(([, n]) => typeof n === 'number' && n > 0));
  } catch {
    return {};
  }
}

/** Every provider's own numbers, side by side, with the alerts. Never throws; a provider that fails says why. */
export async function providerSpend(env, now = Date.now()) {
  const d = new Date(now);
  const t = { now, monthStart: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) };
  const apps = keyApps(env);
  const floor = num(env && env.SPEND_ALERT_FLOOR_USD) ?? 20;
  const limits = dayLimits(env);
  const yesterday = dayOf(now - DAY_MS);
  const today = dayOf(now);
  const deadline = num(env && env.PROVIDER_DEADLINE_MS) || DEADLINE_MS;
  const providers = await Promise.all(PROVIDERS.map(async (p) => {
    let out;
    let timer;
    try {
      // one slow provider (paging, each page up to TIMEOUT_MS) gives up at the deadline instead of holding up the rest
      const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Refused(0, 'timed out')), deadline); });
      out = await Promise.race([READERS[p.id](env || {}, t), late]);
    } catch (error) {
      const why = error instanceof Refused && (error.status === 401 || error.status === 403) ? `${p.name} refused the key (${scrub(error.message)}). It may need an admin or billing key.` : scrub(error && error.message);
      out = { status: 'error', note: why };
    } finally {
      clearTimeout(timer);
    }
    const byDay = out.by_day || [];
    const month = out.month_usd ?? (byDay.length ? round(byDay.reduce((s, x) => s + x.usd, 0)) : null);
    const named = apps[p.id] || {};
    return {
      id: p.id,
      name: p.name,
      console: p.console,
      ...out,
      ...(out.by_key ? { by_key: out.by_key.map((k) => ({ ...k, app: named[k.name] || null })) } : {}),
      month_usd: month,
      today_usd: byDay.length ? round((byDay.find((x) => x.day === today) || {}).usd || 0) : null,
      yesterday_usd: byDay.length ? round((byDay.find((x) => x.day === yesterday) || {}).usd || 0) : null,
    };
  }));
  const alerts = [];
  for (const p of providers) {
    if (p.status === 'error') alerts.push({ provider: p.id, level: 'warn', text: `${p.name}: couldn’t read it (${p.note})` });
    if (p.balance && typeof p.balance.usd === 'number' && p.balance.usd < floor) alerts.push({ provider: p.id, level: 'red', text: `${p.name}: $${p.balance.usd.toFixed(2)} left, under the $${floor} floor` });
    const lim = limits[p.id];
    if (lim && typeof p.yesterday_usd === 'number' && p.yesterday_usd > lim) alerts.push({ provider: p.id, level: 'red', text: `${p.name}: $${p.yesterday_usd.toFixed(2)} spent yesterday, over the $${lim} a day limit` });
  }
  const known = providers.filter((p) => typeof p.month_usd === 'number');
  return {
    at: now,
    month: dayOf(t.monthStart).slice(0, 7),
    month_usd: round(known.reduce((s, p) => s + p.month_usd, 0)),
    counted: known.map((p) => p.id),
    floor_usd: floor,
    providers,
    alerts,
  };
}
