// Tests for Phase 1–4 marketing, SEO, lead capture, Klaviyo sync, case studies, and SEO guides:
//   - GET /robots.txt and GET /sitemap.xml across domains
//   - Expanded SEO metadata, Schema.org Microdata, and CSP compliance across home, edu, eves, router, case studies, and guides
//   - POST /api/leads (validation, honeypot, D1 upsert, Klaviyo v2024-10-15 sync, form fallback) & GET /api/admin/leads (JSON + CSV)
//   - UTM attribution (utmFrom) and POST /api/stats/event funnel telemetry + GA4 Measurement Protocol forwarding

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { CASE_STUDIES, GUIDES } from '../src/eden/seo.js';
import { forgetSessions } from '../src/eden/session.js';
import { leadSummary, normalizeAudience, normalizeEmail, normalizePhone } from '../src/leads/leads.js';
import { utmFrom } from '../src/stats/stats.js';
import { EMAIL_TEMPLATES } from '../scripts/setup-klaviyo.mjs';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://askeden.com';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const read = (p) => fs.readFileSync(path.join(SITE, p), 'utf8');

/** Lightweight in-memory D1 mock for Node 20+ (supports events and leads tables without node:sqlite). */
function memoryD1() {
  const events = [];
  const leads = new Map(); // email -> row
  let autoId = 1;

  const execSql = (sql, args = []) => {
    const s = sql.trim();
    if (/^CREATE\s+(TABLE|INDEX)/i.test(s)) return { results: [] };
    if (/^INSERT INTO events/i.test(s)) {
      const cols = ['ts', 'kind', 'name', 'user', 'visitor', 'country', 'region', 'city', 'device', 'ref', 'product', 'usd', 'tin', 'tout', 'model', 'detail'];
      const row = {};
      cols.forEach((c, i) => { row[c] = args[i] ?? null; });
      events.push(row);
      return { results: [] };
    }
    if (/^INSERT INTO leads/i.test(s)) {
      const [created_at, updated_at, email, phone, consent_sms, audience, product, name, organization, source_page, utm_source, utm_medium, utm_campaign, country, klaviyo_synced] = args;
      const existing = leads.get(email);
      if (existing) {
        existing.updated_at = updated_at;
        existing.phone = phone || existing.phone;
        if (phone) existing.consent_sms = consent_sms;
        existing.audience = audience;
        existing.product = product;
        existing.name = name || existing.name;
        existing.organization = organization || existing.organization;
        existing.source_page = source_page;
        existing.utm_source = utm_source || existing.utm_source;
        existing.utm_medium = utm_medium || existing.utm_medium;
        existing.utm_campaign = utm_campaign || existing.utm_campaign;
        existing.klaviyo_synced = Math.max(existing.klaviyo_synced, klaviyo_synced);
      } else {
        leads.set(email, {
          id: autoId++,
          created_at,
          updated_at,
          email,
          phone,
          consent_sms,
          audience,
          product,
          name,
          organization,
          source_page,
          utm_source,
          utm_medium,
          utm_campaign,
          country,
          klaviyo_synced,
        });
      }
      return { results: [] };
    }
    if (/^SELECT \* FROM leads/i.test(s)) {
      let list = [...leads.values()].sort((a, b) => b.updated_at - a.updated_at);
      if (/WHERE audience = \?/i.test(s)) {
        const aud = args[0];
        const lim = args[1] || 250;
        list = list.filter((r) => r.audience === aud).slice(0, lim);
      } else {
        const lim = args[0] || 250;
        list = list.slice(0, lim);
      }
      return { results: list };
    }
    return { results: [] };
  };

  const statement = (sql, args = []) => ({
    sql,
    args,
    bind: (...a) => statement(sql, a),
    run: async () => { execSql(sql, args); return { success: true }; },
    all: async () => execSql(sql, args),
  });

  return {
    events,
    leads,
    prepare: (sql) => statement(sql),
    batch: async (list) => list.map((st) => execSql(st.sql, st.args)),
  };
}

let env;
let pending;
let externalCalls;
const realFetch = globalThis.fetch;
const ctx = { waitUntil: (p) => pending.push(p) };
const settle = async () => { while (pending.length) await pending.shift(); };

beforeEach(() => {
  forgetSessions();
  pending = [];
  externalCalls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    externalCalls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ data: { id: 'klv_123' } }), { status: 202, headers: { 'content-type': 'application/json' } });
  };
  env = {
    TRIAL_BUDGET_USD: '1',
    PLUS_BUDGET_USD: '20',
    API_RATE: rateLimiter(),
    LINK_RATE: rateLimiter(),
    EDEN_RATE: rateLimiter(),
    AUTH_RATE: rateLimiter(),
    ADMIN_EMAILS: 'owner@example.com',
    EDEN_TOKEN_KEY: 'k'.repeat(64),
    STATS: memoryD1(),
  };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.IDENTITIES = namespace(Identity, env);
  env.ASSETS = {
    fetch: async (req) => {
      const p = new URL(req.url).pathname;
      const diskPath = p.endsWith('/') ? path.join(SITE, 'public', p, 'index.html') : path.join(SITE, 'public', p);
      if (fs.existsSync(diskPath) && fs.statSync(diskPath).isFile()) {
        const ext = path.extname(diskPath);
        const ct = ext === '.css' ? 'text/css; charset=utf-8' : ext === '.js' ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8';
        return new Response(fs.readFileSync(diskPath), { status: 200, headers: { 'content-type': ct } });
      }
      return new Response(`asset ${p}`, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  };
});

after(() => {
  globalThis.fetch = realFetch;
});

const browserSession = async (account, email) => {
  const r = await call(env, account, 'web-signin', {
    account_id: account,
    create: true,
    identity: { provider: 'google', sub_hash: 'h'.repeat(64), email },
    device: { name: 'Eden on the web: Safari on a Mac' },
  });
  return r.token;
};

test('robots.txt and sitemap.xml are served per canonical domain and list case studies and all SEO guides', async () => {
  const rob = await worker.fetch(new Request(`${ORIGIN}/robots.txt`), env, ctx);
  assert.equal(rob.status, 200);
  assert.match(rob.headers.get('content-type'), /^text\/plain/);
  const robText = await rob.text();
  assert.match(robText, /User-agent: \*/);
  assert.match(robText, /Disallow: \/api\//);
  assert.match(robText, /Disallow: \/admin/);
  assert.match(robText, /Sitemap: https:\/\/askeden\.com\/sitemap\.xml/);

  const map = await worker.fetch(new Request(`${ORIGIN}/sitemap.xml`), env, ctx);
  assert.equal(map.status, 200);
  assert.match(map.headers.get('content-type'), /^application\/xml/);
  const xml = await map.text();
  assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/);
  assert.match(xml, /<loc>https:\/\/askeden\.com\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/askeden\.com\/guides<\/loc>/);
  assert.doesNotMatch(xml, /vc-investment-memos/);
  assert.match(xml, /hreflang="fr" href="https:\/\/askeden\.com\/\?lang=fr"/);
  for (const g of GUIDES) {
    assert.ok(xml.includes(`<loc>https://askeden.com${g.path}</loc>`), g.slug);
  }

  // Host-specific sitemaps when EDU_HOST / ROUTER_HOST / EVES_HOST are active
  const eduEnv = { ...env, EDU_HOST: 'askedenedu.com' };
  const eduRob = await (await worker.fetch(new Request('https://askedenedu.com/robots.txt'), eduEnv, ctx)).text();
  assert.match(eduRob, /Sitemap: https:\/\/askedenedu\.com\/sitemap\.xml/);
  const eduXml = await (await worker.fetch(new Request('https://askedenedu.com/sitemap.xml'), eduEnv, ctx)).text();
  assert.match(eduXml, /<loc>https:\/\/askedenedu\.com\/<\/loc>/);
});

test('Case study and all 6 SEO guides are served with strict FRONT_CSP, Schema.org Microdata, and zero inline scripts/styles', async () => {
  const paths = ['/guides', ...CASE_STUDIES.map((c) => c.path), ...GUIDES.map((g) => g.path)];
  for (const p of paths) {
    const res = await worker.fetch(new Request(`${ORIGIN}${p}`), env, ctx);
    assert.equal(res.status, 200, p);
    const csp = res.headers.get('content-security-policy');
    assert.match(csp, /default-src 'none'; script-src 'self';/, p);
    assert.match(csp, /connect-src 'self'/, p);
    assert.match(csp, /form-action 'self'/, p);
    assert.doesNotMatch(csp, /unsafe-inline/, p);
    const html = await res.text();
    assert.match(html, /<link rel="canonical" href="https:\/\/askeden\.com/, p);
    assert.match(html, /<meta name="description" content="[^"]{40,}">/, p);
    assert.match(html, /itemscope itemtype="https:\/\/schema\.org\/(TechArticle|CollectionPage)"/, p);
    assert.match(html, /form class="lead-form" method="post" action="\/api\/leads" data-lead-form/, p);
    assert.doesNotMatch(html, /\sstyle=|<script(?![^>]*src="\/home\/features\.js")/i, p);
  }
  const cssRes = await worker.fetch(new Request(`${ORIGIN}/guides/guides.css`), env, ctx);
  assert.equal(cssRes.status, 200);
  assert.equal(cssRes.headers.get('x-content-type-options'), 'nosniff');
});

test('SEO metadata and lead capture forms on home, edu-home, eves-home, and router pages', () => {
  const home = read('public/home/index.html');
  assert.match(home, /<title>Eden · One AI Chat for Every Model, Verified Against Hallucinations · askeden\.com<\/title>/);
  assert.doesNotMatch(home, /vc-investment-memos/);
  assert.match(home, /id="newsletter"/);
  assert.match(home, /id="exit-lead"/);

  const edu = read('public/edu-home/index.html');
  assert.match(edu, /<title>Eden for Education · AI-Assisted Study Workflows &amp; Course Tutor Based on Your Materials<\/title>/);
  assert.match(edu, /<link rel="canonical" href="https:\/\/askedenedu\.com\/">/);
  assert.match(edu, /data-audience="educator"/);

  const eves = read('public/eves-home/index.html');
  assert.match(eves, /<title>EVES · AI Hallucination Verification &amp; Evaluation System/);
  assert.doesNotMatch(eves, /vc-investment-memos/);
  assert.doesNotMatch(eves, /\$\d/); // preserves pages.test.js invariant

  const router = read('public/router/index.html');
  assert.doesNotMatch(router, /vc-investment-memos/);
  assert.match(router, /data-audience="api"/);

  // Additional product pages (Eden Code, Eden Secretary, Eden Mail, Accuracy) have canonicals & Schema.org Microdata
  for (const [page, canonical, schema] of [
    ['public/eden-code-home/index.html', 'https://askedencode.com/', 'SoftwareApplication'],
    ['public/eden-secretary-home/index.html', 'https://edensecretary.com/', 'SoftwareApplication'],
    ['public/mail-home/index.html', 'https://askedenmail.com/', 'SoftwareApplication'],
    ['public/accuracy/index.html', 'https://askeden.com/accuracy', 'ScholarlyArticle'],
  ]) {
    const html = read(page);
    assert.ok(html.includes(`<link rel="canonical" href="${canonical}">`), `${page} canonical`);
    assert.ok(html.includes(`itemtype="https://schema.org/${schema}"`), `${page} schema`);
  }

  // Klaviyo setup script exports all 5 welcome-series email templates
  assert.equal(EMAIL_TEMPLATES.length, 5);
});

test('POST /api/leads validates email & phone, blocks foreign origins, stores in D1, syncs to Klaviyo, and exports CSV for admin', async () => {
  assert.equal(normalizeEmail('  Bilel@AskEden.com '), 'bilel@askeden.com');
  assert.equal(normalizeEmail('not-an-email'), null);
  assert.equal(normalizePhone('(415) 555-2671'), '+14155552671');
  assert.equal(normalizePhone('+33 6 12 34 56 78'), '+33612345678');
  assert.equal(normalizePhone('123'), null);
  assert.equal(normalizeAudience('educator', 'eden'), 'educator');
  assert.equal(normalizeAudience('', 'edu'), 'educator');
  assert.equal(normalizeAudience('', 'router'), 'api');

  // Foreign origin refused
  const foreign = await worker.fetch(
    new Request(`${ORIGIN}/api/leads`, {
      method: 'POST',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.com' }),
    }),
    env,
    ctx,
  );
  assert.equal(foreign.status, 403);

  // Invalid email -> 400
  const badEmail = await worker.fetch(
    new Request(`${ORIGIN}/api/leads`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'invalid' }),
    }),
    env,
    ctx,
  );
  assert.equal(badEmail.status, 400);

  // Invalid phone -> 400
  const badPhone = await worker.fetch(
    new Request(`${ORIGIN}/api/leads`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'prof@university.edu', phone: '123' }),
    }),
    env,
    ctx,
  );
  assert.equal(badPhone.status, 400);

  // Honeypot silently succeeds without storing
  const bot = await worker.fetch(
    new Request(`${ORIGIN}/api/leads`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'spam@bot.com', website_url: 'http://spam.com' }),
    }),
    env,
    ctx,
  );
  assert.equal(bot.status, 200);
  await settle();
  assert.equal(env.STATS.leads.size, 0);

  // Valid lead with Klaviyo configured
  env.KLAVIYO_PRIVATE_KEY = 'pk_test_klaviyo_secret';
  env.KLAVIYO_EDU_LIST_ID = 'LIST_EDU_1';
  const ok = await worker.fetch(
    new Request(`${ORIGIN}/api/leads`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Macintosh)' },
      body: JSON.stringify({
        email: 'Prof.Smith@University.edu',
        phone: '(415) 555-0199',
        audience: 'educator',
        organization: 'BIO 101 · State University',
        source_page: '/edu',
        utm_source: 'linkedin',
        utm_medium: 'organic',
        utm_campaign: 'edu_pilot',
      }),
    }),
    env,
    ctx,
  );
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.deepEqual(okBody, { ok: true, subscribed: true, audience: 'educator', sms: true });
  await settle();

  // Stored in D1
  const saved = env.STATS.leads.get('prof.smith@university.edu');
  assert.ok(saved);
  assert.equal(saved.phone, '+14155550199');
  assert.equal(saved.consent_sms, 1);
  assert.equal(saved.audience, 'educator');
  assert.equal(saved.organization, 'BIO 101 · State University');
  assert.equal(saved.utm_source, 'linkedin');
  assert.equal(saved.klaviyo_synced, 1);

  // Synced to Klaviyo (profile import + list subscription job + Eden Lead Captured event)
  assert.equal(externalCalls.length, 3);
  assert.equal(externalCalls[0].url, 'https://a.klaviyo.com/api/profile-import/');
  assert.equal(externalCalls[1].url, 'https://a.klaviyo.com/api/profile-subscription-bulk-create-jobs/');
  assert.equal(externalCalls[1].body.data.relationships.list.data.id, 'LIST_EDU_1');
  assert.equal(externalCalls[2].url, 'https://a.klaviyo.com/api/events/');
  assert.equal(externalCalls[2].body.data.attributes.metric.data.attributes.name, 'Eden Lead Captured');

  // HTML form fallback (no-JS) redirects with 303 to ?subscribed=1#newsletter
  const formRes = await worker.fetch(
    new Request(`${ORIGIN}/api/leads`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'dev@vc.com', audience: 'api', source_page: '/guides' }),
    }),
    env,
    ctx,
  );
  assert.equal(formRes.status, 303);
  assert.match(formRes.headers.get('location'), /\/guides\?subscribed=1#newsletter$/);
  await settle();
  assert.equal(env.STATS.leads.size, 2);

  // Admin leads endpoint: 404 for non-owner, JSON & CSV for owner
  const otherToken = await browserSession(OTHER_ID, 'other@example.com');
  const ownerToken = await browserSession(OWNER_ID, 'owner@example.com');
  assert.equal(
    (await worker.fetch(new Request(`${ORIGIN}/api/admin/leads`, { headers: { cookie: `__Host-eden=${otherToken}` } }), env, ctx)).status,
    404,
  );
  const adminJson = await (
    await worker.fetch(new Request(`${ORIGIN}/api/admin/leads`, { headers: { cookie: `__Host-eden=${ownerToken}` } }), env, ctx)
  ).json();
  assert.equal(adminJson.ready, true);
  assert.equal(adminJson.total, 2);

  const adminCsvRes = await worker.fetch(
    new Request(`${ORIGIN}/api/admin/leads?format=csv`, { headers: { cookie: `__Host-eden=${ownerToken}` } }),
    env,
    ctx,
  );
  assert.equal(adminCsvRes.status, 200);
  assert.match(adminCsvRes.headers.get('content-type'), /^text\/csv/);
  const csv = await adminCsvRes.text();
  assert.match(csv, /prof\.smith@university\.edu/);
  assert.match(csv, /dev@vc\.com/);

  // leadSummary aggregates segments, SMS opt-ins, and Klaviyo sync status for /admin dashboard
  const summary = await leadSummary(env);
  assert.equal(summary.ready, true);
  assert.equal(summary.total, 2);
  assert.equal(summary.sms, 1);
  assert.equal(summary.klaviyo, 2);
  assert.equal(summary.by_audience.length, 2);
});

test('UTM campaign attribution and POST /api/stats/event funnel telemetry + GA4 forwarding', async () => {
  const u = utmFrom('https://askeden.com/guides?utm_source=linkedin&utm_medium=organic&utm_campaign=guides_launch');
  assert.equal(u.source, 'linkedin');
  assert.equal(u.summary, 'src=linkedin med=organic cmp=guides_launch');

  env.GA_MEASUREMENT_ID = 'G-TEST12345';
  env.GA_API_SECRET = 'ga_secret_xyz';

  // Visit with UTM parameters
  await worker.fetch(
    new Request(`${ORIGIN}/guides?utm_source=linkedin&utm_medium=organic&utm_campaign=guides_launch`, {
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Safari/605.1.15' },
    }),
    env,
    ctx,
  );
  // Funnel CTA event
  const evRes = await worker.fetch(
    new Request(`${ORIGIN}/api/stats/event`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (Macintosh)' },
      body: JSON.stringify({ event: 'cta_case_study', page: '/', detail: '/guides' }),
    }),
    env,
    ctx,
  );
  assert.equal(evRes.status, 204);
  await settle();

  const visitEvent = env.STATS.events.find((e) => e.kind === 'visit');
  assert.ok(visitEvent);
  assert.equal(visitEvent.ref, 'linkedin');
  assert.equal(visitEvent.detail, 'src=linkedin med=organic cmp=guides_launch');

  const funnelEvent = env.STATS.events.find((e) => e.kind === 'funnel');
  assert.ok(funnelEvent);
  assert.equal(funnelEvent.name, 'cta_case_study');
  assert.match(funnelEvent.detail, /\/guides/);

  // GA4 Measurement Protocol received both page_view and cta_case_study
  const gaCalls = externalCalls.filter((c) => c.url.startsWith('https://www.google-analytics.com/mp/collect'));
  assert.equal(gaCalls.length, 2);
  assert.equal(gaCalls[0].body.events[0].name, 'page_view');
  assert.equal(gaCalls[1].body.events[0].name, 'cta_case_study');
});
