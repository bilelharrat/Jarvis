// Lead capture & Klaviyo welcome-flow integration for askeden.com, askedenedu.com,
// edenrouter.com and evesverification.com:
//   POST /api/leads          validates email + optional SMS phone, audience segment
//                            ('power-user' | 'educator' | 'api' | 'general'), organization/course,
//                            and UTM attribution; stores in D1 (`leads` table on env.STATS) and
//                            pushes to Klaviyo (List subscription + 'Eden Lead Captured' event
//                            that triggers the 5-email welcome flow).
//   GET  /api/admin/leads    owner-only (adminSession) lead list and CSV export (?format=csv).

import { json } from '../accounts/util.js';
import { adminSession } from '../stats/admin.js';
import { productOf, record, where } from '../stats/stats.js';
import { problem } from '../eden/web.js';

const LEADS_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    email TEXT NOT NULL UNIQUE,
    phone TEXT,
    consent_sms INTEGER NOT NULL DEFAULT 0,
    audience TEXT NOT NULL DEFAULT 'general',
    product TEXT NOT NULL DEFAULT 'eden',
    name TEXT,
    organization TEXT,
    source_page TEXT,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    country TEXT,
    klaviyo_synced INTEGER NOT NULL DEFAULT 0
  )`,
  'CREATE INDEX IF NOT EXISTS leads_created_at ON leads (created_at DESC)',
  'CREATE INDEX IF NOT EXISTS leads_audience ON leads (audience, created_at DESC)',
];

const schemaReady = new WeakMap();

export function ensureLeadsSchema(env) {
  if (!env || !env.STATS) return Promise.resolve(false);
  if (!schemaReady.has(env.STATS)) {
    schemaReady.set(
      env.STATS,
      env.STATS.batch(LEADS_SCHEMA.map((sql) => env.STATS.prepare(sql))).then(
        () => true,
        (err) => {
          schemaReady.delete(env.STATS);
          throw err;
        },
      ),
    );
  }
  return schemaReady.get(env.STATS);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const AUDIENCES = new Set(['power-user', 'educator', 'api', 'general']);
const cut = (v, n) => (v === undefined || v === null ? null : String(v).trim().slice(0, n) || null);

export function normalizeEmail(raw) {
  const email = String(raw || '').trim().toLowerCase().slice(0, 254);
  if (!EMAIL_RE.test(email) || email.includes('..')) return null;
  return email;
}

/** Normalize a phone number to E.164 (+14155552671) for Klaviyo SMS, or null if empty/invalid. */
export function normalizePhone(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const hasPlus = s.startsWith('+');
  const digits = s.replace(/\D+/g, '');
  if (!digits) return null;
  if (hasPlus && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return null;
}

export function normalizeAudience(raw, product = 'eden') {
  const a = String(raw || '').trim().toLowerCase();
  if (AUDIENCES.has(a)) return a;
  if (product === 'edu') return 'educator';
  if (product === 'router') return 'api';
  return 'power-user';
}

/** Pick the Klaviyo list ID for this audience (falls back to KLAVIYO_LIST_ID). */
function klaviyoListIdFor(env, audience) {
  if (!env) return null;
  if (audience === 'educator' && env.KLAVIYO_EDU_LIST_ID) return String(env.KLAVIYO_EDU_LIST_ID).trim();
  if (audience === 'api' && env.KLAVIYO_API_LIST_ID) return String(env.KLAVIYO_API_LIST_ID).trim();
  return env.KLAVIYO_LIST_ID ? String(env.KLAVIYO_LIST_ID).trim() : null;
}

/**
 * Push a captured lead to Klaviyo (v2024-10-15 API):
 *   1. Upserts the profile + custom attributes (eden_audience, eden_product, organization, UTM tags)
 *      via POST /api/profile-import/
 *   2. Subscribes email (and SMS when phone + consent_sms are present) to the configured Klaviyo List
 *      via POST /api/profile-subscription-bulk-create-jobs/
 *   3. Emits the "Eden Lead Captured" metric event via POST /api/events/ so a Klaviyo welcome flow
 *      can trigger immediately on either the metric or the list.
 * Also supports public client-side company ID (`KLAVIYO_COMPANY_ID`) if `KLAVIYO_PRIVATE_KEY` isn't set yet.
 */
export async function syncLeadToKlaviyo(env, lead) {
  const apiKey = env?.KLAVIYO_PRIVATE_KEY ? String(env.KLAVIYO_PRIVATE_KEY).trim() : '';
  const companyId = env?.KLAVIYO_COMPANY_ID ? String(env.KLAVIYO_COMPANY_ID).trim() : '';
  const listId = klaviyoListIdFor(env, lead.audience);
  if (!apiKey && (!companyId || !listId)) return false;

  const properties = {
    eden_audience: lead.audience,
    eden_product: lead.product,
    source_page: lead.source_page || '/',
    ...(lead.organization ? { organization: lead.organization } : {}),
    ...(lead.utm_source ? { utm_source: lead.utm_source } : {}),
    ...(lead.utm_medium ? { utm_medium: lead.utm_medium } : {}),
    ...(lead.utm_campaign ? { utm_campaign: lead.utm_campaign } : {}),
    ...(lead.country ? { country: lead.country } : {}),
  };

  const headers = {
    accept: 'application/vnd.api+json',
    'content-type': 'application/vnd.api+json',
    revision: '2024-10-15',
    ...(apiKey ? { authorization: `Klaviyo-API-Key ${apiKey}` } : {}),
  };

  try {
    if (apiKey) {
      // 1. Upsert profile with custom properties
      await fetch('https://a.klaviyo.com/api/profile-import/', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          data: {
            type: 'profile',
            attributes: {
              email: lead.email,
              ...(lead.phone && lead.consent_sms ? { phone_number: lead.phone } : {}),
              ...(lead.name ? { first_name: lead.name } : {}),
              properties,
            },
          },
        }),
      });

      // 2. Subscribe to list if a Klaviyo list ID is configured
      if (listId) {
        const subscriptions = {
          email: { marketing: { consent: 'SUBSCRIBED' } },
          ...(lead.phone && lead.consent_sms ? { sms: { marketing: { consent: 'SUBSCRIBED' } } } : {}),
        };
        await fetch('https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/', {
          method: 'POST',
          headers,
          body: JSON.stringify({
            data: {
              type: 'profile-subscription-bulk-create-job',
              attributes: {
                custom_source: `Eden (${lead.product}:${lead.audience})`,
                profiles: {
                  data: [
                    {
                      type: 'profile',
                      attributes: {
                        email: lead.email,
                        ...(lead.phone && lead.consent_sms ? { phone_number: lead.phone } : {}),
                        subscriptions,
                      },
                    },
                  ],
                },
              },
              relationships: {
                list: { data: { type: 'list', id: listId } },
              },
            },
          }),
        });
      }

      // 3. Emit 'Eden Lead Captured' event so welcome flows can branch by audience
      const res = await fetch('https://a.klaviyo.com/api/events/', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          data: {
            type: 'event',
            attributes: {
              properties,
              metric: {
                data: {
                  type: 'metric',
                  attributes: { name: 'Eden Lead Captured' },
                },
              },
              profile: {
                data: {
                  type: 'profile',
                  attributes: {
                    email: lead.email,
                    ...(lead.phone && lead.consent_sms ? { phone_number: lead.phone } : {}),
                    properties,
                  },
                },
              },
            },
          },
        }),
      });
      return res.ok;
    }

    // Public client subscription fallback when only KLAVIYO_COMPANY_ID + KLAVIYO_LIST_ID are set
    const res = await fetch(`https://a.klaviyo.com/client/subscriptions/?company_id=${encodeURIComponent(companyId)}`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.api+json',
        'content-type': 'application/vnd.api+json',
        revision: '2024-10-15',
      },
      body: JSON.stringify({
        data: {
          type: 'subscription',
          attributes: {
            custom_source: `Eden (${lead.product}:${lead.audience})`,
            profile: {
              data: {
                type: 'profile',
                attributes: {
                  email: lead.email,
                  ...(lead.phone && lead.consent_sms ? { phone_number: lead.phone } : {}),
                  properties,
                },
              },
            },
          },
          relationships: {
            list: { data: { type: 'list', id: listId } },
          },
        },
      }),
    });
    return res.ok;
  } catch (err) {
    console.error('leads: klaviyo sync failed', err && err.message);
    return false;
  }
}

async function parseLeadBody(request) {
  const ct = (request.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
    const fd = await request.formData().catch(() => null);
    if (!fd) return { isForm: true, data: {} };
    const data = {};
    for (const [k, v] of fd.entries()) if (typeof v === 'string') data[k] = v;
    return { isForm: true, data };
  }
  const data = await request.json().catch(() => ({}));
  return { isForm: false, data: data && typeof data === 'object' ? data : {} };
}

/** POST /api/leads */
export async function submitLead(request, env, ctx) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } });
  }
  if (env?.API_RATE) {
    const ip = request.headers.get('cf-connecting-ip') || 'anon';
    const { success } = await env.API_RATE.limit({ key: `lead:${ip}` });
    if (!success) return problem(429, 'Too many requests. Please try again in a minute.', 'rate_limited');
  }

  const { isForm, data } = await parseLeadBody(request);
  // Honeypot field: silently succeed for bots filling hidden `website_url`
  if (data.website_url) {
    if (isForm) return Response.redirect(new URL('/?subscribed=1#newsletter', request.url).toString(), 303);
    return json({ ok: true, subscribed: true });
  }

  const email = normalizeEmail(data.email);
  if (!email) {
    return problem(400, 'Please enter a valid email address.', 'invalid_email');
  }

  const rawPhone = cut(data.phone, 32);
  const phone = normalizePhone(rawPhone);
  if (rawPhone && !phone) {
    return problem(400, 'Please enter a valid phone number (with area code) or leave SMS blank.', 'invalid_phone');
  }

  const url = new URL(request.url);
  const sourcePage = cut(data.source_page || data.page, 120) || '/';
  const product = cut(data.product, 24) || productOf(url.hostname, sourcePage);
  const audience = normalizeAudience(data.audience, product);
  const consentSms = Boolean(phone && (data.consent_sms === true || data.consent_sms === '1' || data.consent_sms === 'on' || data.phone));
  const loc = where(request);
  const now = Math.round(Date.now());

  const lead = {
    created_at: now,
    updated_at: now,
    email,
    phone,
    consent_sms: consentSms ? 1 : 0,
    audience,
    product,
    name: cut(data.name, 80),
    organization: cut(data.organization || data.course, 120),
    source_page: sourcePage,
    utm_source: cut(data.utm_source, 64),
    utm_medium: cut(data.utm_medium, 64),
    utm_campaign: cut(data.utm_campaign, 80),
    country: loc.country,
  };

  const work = (async () => {
    let synced = false;
    try {
      synced = await syncLeadToKlaviyo(env, lead);
    } catch {
      synced = false;
    }
    try {
      if (env && env.STATS) {
        await ensureLeadsSchema(env);
        await env.STATS.prepare(
          `INSERT INTO leads (
            created_at, updated_at, email, phone, consent_sms, audience, product,
            name, organization, source_page, utm_source, utm_medium, utm_campaign, country, klaviyo_synced
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(email) DO UPDATE SET
            updated_at = excluded.updated_at,
            phone = COALESCE(excluded.phone, leads.phone),
            consent_sms = CASE WHEN excluded.phone IS NOT NULL THEN excluded.consent_sms ELSE leads.consent_sms END,
            audience = excluded.audience,
            product = excluded.product,
            name = COALESCE(excluded.name, leads.name),
            organization = COALESCE(excluded.organization, leads.organization),
            source_page = excluded.source_page,
            utm_source = COALESCE(excluded.utm_source, leads.utm_source),
            utm_medium = COALESCE(excluded.utm_medium, leads.utm_medium),
            utm_campaign = COALESCE(excluded.utm_campaign, leads.utm_campaign),
            klaviyo_synced = MAX(leads.klaviyo_synced, excluded.klaviyo_synced)`,
        )
          .bind(
            lead.created_at,
            lead.updated_at,
            lead.email,
            lead.phone,
            lead.consent_sms,
            lead.audience,
            lead.product,
            lead.name,
            lead.organization,
            lead.source_page,
            lead.utm_source,
            lead.utm_medium,
            lead.utm_campaign,
            lead.country,
            synced ? 1 : 0,
          )
          .run();
      }
    } catch (err) {
      console.error('leads: db write failed', err && err.message);
    }
    await record(env, {
      kind: 'lead',
      name: audience,
      product,
      country: loc.country,
      region: loc.region,
      city: loc.city,
      device: loc.device,
      ref: lead.utm_source || null,
      detail: [lead.source_page, phone ? 'sms' : 'email', lead.utm_campaign].filter(Boolean).join(' · '),
    });
  })();

  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(work);
  else await work;

  if (isForm) {
    const back = sourcePage.startsWith('/') && !sourcePage.startsWith('//') ? sourcePage : '/';
    const sep = back.includes('?') ? '&' : '?';
    return Response.redirect(new URL(`${back}${sep}subscribed=1#newsletter`, request.url).toString(), 303);
  }
  return json({
    ok: true,
    subscribed: true,
    audience,
    sms: Boolean(phone && consentSms),
  });
}

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** GET /api/admin/leads — owner-only JSON or CSV export of captured leads. */
export async function adminLeads(request, env) {
  if (!(await adminSession(request, env))) {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  }
  if (!env || !env.STATS) return json({ ready: false, leads: [] });
  await ensureLeadsSchema(env);
  const url = new URL(request.url);
  const audience = url.searchParams.get('audience');
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 250, 1), 2000);
  const stmt =
    audience && AUDIENCES.has(audience)
      ? env.STATS.prepare('SELECT * FROM leads WHERE audience = ? ORDER BY updated_at DESC LIMIT ?').bind(audience, limit)
      : env.STATS.prepare('SELECT * FROM leads ORDER BY updated_at DESC LIMIT ?').bind(limit);
  const { results = [] } = await stmt.all();

  if (url.searchParams.get('format') === 'csv') {
    const cols = ['email', 'phone', 'consent_sms', 'audience', 'product', 'name', 'organization', 'source_page', 'utm_source', 'utm_medium', 'utm_campaign', 'country', 'klaviyo_synced', 'created_at'];
    const lines = [cols.join(','), ...results.map((r) => cols.map((c) => csvCell(r[c])).join(','))];
    return new Response(`${lines.join('\r\n')}\r\n`, {
      status: 200,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="eden-leads.csv"',
        'cache-control': 'no-store',
      },
    });
  }
  return json({ ready: true, total: results.length, leads: results });
}

/** Summary of captured leads for GET /api/admin/stats (/admin dashboard). */
export async function leadSummary(env) {
  if (!env || !env.STATS) return { ready: false, total: 0, sms: 0, klaviyo: 0, by_audience: [], recent: [] };
  await ensureLeadsSchema(env);
  const { results = [] } = await env.STATS.prepare('SELECT * FROM leads ORDER BY updated_at DESC LIMIT ?').bind(200).all();
  const byAudience = new Map();
  let sms = 0;
  let klaviyo = 0;
  for (const r of results) {
    const a = r.audience || 'general';
    byAudience.set(a, (byAudience.get(a) || 0) + 1);
    if (r.consent_sms) sms++;
    if (r.klaviyo_synced) klaviyo++;
  }
  return {
    ready: true,
    total: results.length,
    sms,
    klaviyo,
    by_audience: [...byAudience.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n),
    recent: results.slice(0, 25),
  };
}
