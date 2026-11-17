// Eden Enterprise's contact form (leads/enterprise.js): behind ENTERPRISE_CONTACT, Turnstile like
// sign-in, stored first and emailed to the owner once, rate-limited, the owner's list behind adminSession.
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { call } from '../src/accounts/index.js';
import { forgetSessions } from '../src/eden/session.js';
import { EnterpriseDesk, LIMITS, mailer, ownerMessage } from '../src/leads/enterprise.js';
import { Account, Identity, Link, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const realFetch = globalThis.fetch;
let env;
let sent;
let siteverify;
let pending;
const ctx = { waitUntil: (p) => pending.push(p) };

class FakeEmailMessage {
  constructor(from, to, raw) {
    Object.assign(this, { from, to, raw });
  }
}

beforeEach(() => {
  forgetSessions();
  sent = [];
  pending = [];
  siteverify = { success: true, hostname: 'askeden.com' };
  mailer.EmailMessage = FakeEmailMessage;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://challenges.cloudflare.com/')) {
      if (siteverify === 'down') throw new Error('unreachable');
      return Response.json(siteverify);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  env = {
    ENTERPRISE_CONTACT: 'on',
    TURNSTILE_SITE_KEY: '0x4AAAAAAAsite',
    TURNSTILE_SECRET: '0x4AAAAAAAsecret',
    ENTERPRISE_MAIL_FROM: 'enterprise@askedentravel.com',
    OWNER_MAIL: { send: async (m) => { if (env.mailDown) throw new Error('mail down'); sent.push(m); } },
    API_RATE: rateLimiter(),
    LINK_RATE: rateLimiter(),
    EDEN_RATE: rateLimiter(),
    AUTH_RATE: rateLimiter(),
    ADMIN_EMAILS: 'owner@example.com',
    EDEN_TOKEN_KEY: 'k'.repeat(64),
  };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.IDENTITIES = namespace(Identity, env);
  env.ENTERPRISE = namespace(EnterpriseDesk, env);
  env.ASSETS = { fetch: async (req) => new Response(`asset ${new URL(req.url).pathname}`, { headers: { 'content-type': 'text/html; charset=utf-8' } }) };
});

after(() => {
  globalThis.fetch = realFetch;
  mailer.EmailMessage = null;
});

const good = (extra = {}) => ({ name: 'Ada Lovelace', email: 'ada@analytical.example', company: 'Analytical Engines', team_size: '50-249', message: 'We want Eden for 120 people.\nInvoicing, please.', turnstile: 'tok', ...extra });
async function send(body, { ip = '203.0.113.7', origin = ORIGIN, method = 'POST' } = {}) {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...(origin ? { origin } : {}) };
  const res = await worker.fetch(new Request(`${ORIGIN}/api/enterprise`, { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined }), env, ctx);
  await Promise.all(pending.splice(0));
  return res;
}
const desk = () => env.ENTERPRISE.objects.get('requests');
const rows = async () => (desk() ? [...(await desk().storage.list({ prefix: 'r:' })).values()] : []);
const decodeBody = (raw) => Buffer.from(raw.split('\r\n\r\n').slice(1).join('').replace(/\s+/g, ''), 'base64').toString('utf8');
const subjectOf = (raw) => Buffer.from(/^Subject: =\?UTF-8\?B\?([^?]+)\?=$/m.exec(raw)[1], 'base64').toString('utf8');

test('flag off: POST /api/enterprise and GET /enterprise are 404, and the config has no key', async () => {
  for (const v of [undefined, 'off', 'yes']) {
    env.ENTERPRISE_CONTACT = v;
    assert.equal((await send(good())).status, 404, String(v));
    const page = await worker.fetch(new Request(`${ORIGIN}/enterprise`), env, ctx);
    assert.equal(page.status, 404);
    const config = await (await worker.fetch(new Request(`${ORIGIN}/api/web/config`), env, ctx)).json();
    assert.equal('enterprise_contact' in config, false);
  }
  assert.equal((await rows()).length, 0);
  assert.equal(sent.length, 0);
  env.ENTERPRISE_CONTACT = 'on';
  const config = await (await worker.fetch(new Request(`${ORIGIN}/api/web/config`), env, ctx)).json();
  assert.equal(config.enterprise_contact, true);
  const page = await worker.fetch(new Request(`${ORIGIN}/enterprise`), env, ctx);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), 'asset /enterprise/');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self' https:\/\/challenges\.cloudflare\.com;/);
});

test('a good request: stored, emailed once to the owner with Reply-To and Subject; CR/LF in fields never reach a header', async () => {
  const res = await send(good({ name: 'Ada\r\nBcc: evil@example.com', company: 'Analytical\nEngines' }));
  assert.equal(res.status, 200, await res.clone().text());
  const { ok, id } = await res.json();
  assert.equal(ok, true);
  const [row] = await rows();
  assert.equal(row.id, id);
  assert.deepEqual([row.name, row.company, row.team_size], ['Ada Bcc: evil@example.com', 'Analytical Engines', '50-249']);
  assert.ok(row.emailed_at > 0);
  assert.equal(sent.length, 1);
  const m = sent[0];
  assert.equal(m.to, 'bilel@askeden.com');
  assert.equal(m.from, 'enterprise@askedentravel.com');
  const headers = m.raw.split('\r\n\r\n')[0];
  assert.doesNotMatch(headers, /^Bcc:/m);
  assert.match(headers, /^Reply-To: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <ada@analytical\.example>$/m);
  assert.equal(subjectOf(m.raw), 'Eden Enterprise request: Analytical Engines (50-249)');
  assert.match(headers, /^Content-Type: text\/plain; charset=UTF-8$/m);
  assert.match(decodeBody(m.raw), /Message:\r\nWe want Eden for 120 people\.\nInvoicing, please\./);
  // sent never again
  await desk().alarm();
  assert.equal(sent.length, 1);
  // the message's builder strips CR/LF from every header value
  const raw = ownerMessage({ ...row, email: 'a@b.example\r\nX-Evil: 1' }, { from: 'f@x.example\nX: 2' });
  assert.doesNotMatch(raw.split('\r\n\r\n')[0], /^X-Evil|^X: 2/m);
});

test('Turnstile: missing or refused → 403; another hostname → 403; siteverify down → 503; Turnstile off → 503 not_set_up unless TURNSTILE_OPTIONAL=1', async () => {
  let r = await send(good({ turnstile: '' }));
  assert.deepEqual([r.status, (await r.json()).code], [403, 'turnstile']);
  siteverify = { success: false, 'error-codes': ['invalid-input-response'] };
  r = await send(good());
  assert.deepEqual([r.status, (await r.json()).code], [403, 'turnstile']);
  siteverify = { success: true, hostname: 'evil.example' };
  r = await send(good());
  assert.equal(r.status, 403);
  siteverify = 'down';
  r = await send(good());
  assert.deepEqual([r.status, (await r.json()).code], [503, 'turnstile_down']);
  delete env.TURNSTILE_SECRET;
  r = await send(good());
  assert.deepEqual([r.status, (await r.json()).code], [503, 'not_set_up']);
  assert.equal((await rows()).length, 0);
  env.TURNSTILE_OPTIONAL = '1';
  r = await send(good());
  assert.equal(r.status, 200);
});

test('validation: each field, the team size list and the email → 400 { field }; the honeypot → 200 with nothing stored', async () => {
  const cases = [
    [{ name: '' }, 'name'], [{ name: 'x'.repeat(101) }, 'name'], [{ name: 5 }, 'name'],
    [{ email: 'nope' }, 'email'], [{ email: 'a@b' }, 'email'], [{ email: `${'a'.repeat(250)}@b.example` }, 'email'], [{ email: 'a..b@c.example' }, 'email'],
    [{ email: 'x>,<y@evil.example' }, 'email'], [{ email: '"a b"@c.example' }, 'email'], [{ email: 'a;b@c.example' }, 'email'], [{ email: 'a(b)@c.example' }, 'email'],
    [{ company: ' ' }, 'company'], [{ company: 'x'.repeat(121) }, 'company'],
    [{ team_size: '11' }, 'team_size'], [{ team_size: undefined }, 'team_size'],
    [{ message: 'x'.repeat(2001) }, 'message'], [{ message: { a: 1 } }, 'message'],
  ];
  for (const [extra, field] of cases) {
    const r = await send(good(extra));
    assert.equal(r.status, 400, JSON.stringify(extra).slice(0, 60));
    const body = await r.json();
    assert.deepEqual([body.code, body.field], ['bad_request', field]);
  }
  for (const team_size of ['1-9', '10-49', '50-249', '250-999', '1000+']) assert.equal((await send(good({ team_size, email: `p${team_size.length}${team_size[0]}@x.example` }), { ip: `198.51.100.${team_size.length}${team_size[0] === '1' ? 1 : 2}` })).status, 200, team_size);
  const before = (await rows()).length;
  const bot = await send(good({ website_url: 'http://spam.example' }));
  assert.equal(bot.status, 200);
  assert.deepEqual(await bot.json(), { ok: true });
  assert.equal((await rows()).length, before);
  const noMessage = await send(good({ message: undefined, email: 'quiet@x.example' }), { ip: '192.0.2.99' });
  assert.equal(noMessage.status, 200);
});

test('limits: EDEN_RATE; 3 a day per IP and per email → 429; past 100 a day, held and not emailed; a foreign Origin → 403', async () => {
  env.EDEN_RATE = rateLimiter(2);
  assert.equal((await send(good(), { ip: '192.0.2.1' })).status, 200);
  assert.equal((await send(good({ email: 'b@x.example' }), { ip: '192.0.2.1' })).status, 200);
  let r = await send(good({ email: 'c@x.example' }), { ip: '192.0.2.1' });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '60');
  assert.ok(env.EDEN_RATE.keys.every((k) => k.startsWith('ent:')));
  env.EDEN_RATE = rateLimiter();
  // per IP inside the object: a third from the same IP is fine, the fourth is not
  assert.equal((await send(good({ email: 'd@x.example' }), { ip: '192.0.2.1' })).status, 200);
  r = await send(good({ email: 'e@x.example' }), { ip: '192.0.2.1' });
  assert.deepEqual([r.status, (await r.json()).code], [429, 'slow_down']);
  // per email, from other IPs
  for (let i = 0; i < 2; i++) assert.equal((await send(good({ email: 'same@x.example' }), { ip: `192.0.2.${50 + i}` })).status, 200);
  assert.equal((await send(good({ email: 'Same@X.example' }), { ip: '192.0.2.60' })).status, 200);
  assert.equal((await send(good({ email: 'same@x.example' }), { ip: '192.0.2.61' })).status, 429);
  // the day's cap: requests past it are stored held, not emailed
  const day = `day:${new Date().toISOString().slice(0, 10)}`;
  await desk().storage.put(day, LIMITS.perDay);
  const mails = sent.length;
  r = await send(good({ email: 'late@x.example' }), { ip: '192.0.2.200' });
  assert.equal(r.status, 200);
  const { id } = await r.json();
  const held = (await rows()).find((x) => x.id === id);
  assert.equal(held.held, 1);
  assert.equal(held.emailed_at, null);
  assert.equal(sent.length, mails);
  // past 500 stored in a day: not even stored
  await desk().storage.put(day, LIMITS.storeDay);
  const count = (await rows()).length;
  r = await send(good({ email: 'flood@x.example' }), { ip: '192.0.2.202' });
  assert.deepEqual([r.status, (await r.json()).code], [429, 'slow_down']);
  assert.equal((await rows()).length, count);
  await desk().storage.put(day, 0);
  // rows older than a year go (with their pointer) on the next request
  const oldId = '00000000-0000-4000-8000-0000000000aa';
  const oldKey = `r:${String(1).padStart(15, '0')}:${oldId}`;
  await desk().storage.put({ [oldKey]: { id: oldId, created_at: 1, name: 'Old', email: 'old@x.example', company: 'Old', team_size: '1-9', message: '', emailed_at: 1, email_error: null, held: 0 }, [`id:${oldId}`]: oldKey });
  assert.equal((await send(good({ email: 'fresh@x.example' }), { ip: '192.0.2.203' })).status, 200);
  assert.equal(await desk().storage.get(oldKey), undefined);
  assert.equal(await desk().storage.get(`id:${oldId}`), undefined);
  const foreign = await send(good({ email: 'f@x.example' }), { origin: 'https://evil.example', ip: '192.0.2.201' });
  assert.equal(foreign.status, 403);
  assert.equal((await send(good(), { method: 'GET' })).status, 405);
});

test('a failed send: kept with its error, the alarm retries and sends exactly once; 5 tries at most', async () => {
  env.mailDown = true;
  const r = await send(good());
  assert.equal(r.status, 200, 'stored even when the email fails');
  let [row] = await rows();
  assert.match(row.email_error, /mail down/);
  assert.equal(row.emailed_at, null);
  assert.ok(desk().storage.alarm > Date.now());
  const realNow = desk().now;
  desk().now = () => Date.now() + 16 * 60_000;
  env.mailDown = false;
  await Promise.all([desk().alarm(), desk().alarm()]);
  [row] = await rows();
  assert.ok(row.emailed_at > 0);
  assert.equal(row.email_error, null);
  assert.equal(sent.length, 1, 'once, though the alarm ran twice');
  await desk().alarm();
  assert.equal(sent.length, 1);
  // never more than 5 tries
  env.mailDown = true;
  desk().now = realNow;
  await send(good({ email: 'z@x.example' }), { ip: '192.0.2.77' });
  for (let i = 1; i <= 6; i++) {
    desk().now = () => Date.now() + i * 16 * 60_000;
    await desk().alarm();
  }
  const failed = (await rows()).find((x) => x.email === 'z@x.example');
  assert.equal(failed.tries, 5);
  assert.equal((await desk().storage.list({ prefix: 'q:' })).size, 0);
});

test('the owner’s list and CSV: an admin session only; anyone else gets 404', async () => {
  await send(good({ company: '=HYPERLINK("x")' }));
  const get = (p, session) => worker.fetch(new Request(`${ORIGIN}${p}`, { headers: session ? { cookie: `__Host-eden=${session}` } : {} }), env, ctx);
  assert.equal((await get('/api/admin/enterprise')).status, 404);
  const signin = async (account, email) => (await call(env, account, 'web-signin', { account_id: account, create: true, identity: { provider: 'google', sub_hash: 'h'.repeat(64), email }, device: { name: 'Eden on the web' } })).token;
  const stranger = await signin('44444444-4444-4444-8444-444444444444', 'someone@example.com');
  assert.equal((await get('/api/admin/enterprise', stranger)).status, 404);
  assert.equal((await get('/api/admin/bonus-pool', stranger)).status, 404);
  const owner = await signin('33333333-3333-4333-8333-333333333333', 'owner@example.com');
  const list = await (await get('/api/admin/enterprise', owner)).json();
  assert.equal(list.requests.length, 1);
  assert.deepEqual(Object.keys(list.requests[0]), ['id', 'created_at', 'name', 'email', 'company', 'team_size', 'message', 'emailed_at', 'email_error', 'held']);
  const csv = await get('/api/admin/enterprise?format=csv', owner);
  assert.match(csv.headers.get('content-type'), /^text\/csv/);
  const text = await csv.text();
  assert.match(text, /^id,created_at,name,email,company,team_size,message,emailed_at,email_error,held\r\n/);
  assert.match(text, /"'=HYPERLINK\(""x""\)"/, 'a formula is made inert');
  assert.deepEqual(await (await get('/api/admin/bonus-pool', owner)).json(), { ready: false, months: [] });
});
