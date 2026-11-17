// Eden Enterprise's contact form (owner's decision F, 2026-11-13), behind ENTERPRISE_CONTACT = "on".
// Off: POST /api/enterprise and GET /enterprise are 404 and /api/web/config has no key.
//
//   POST /api/enterprise        { name, email, company, team_size, message, turnstile, website_url? }
//                               → 200 { ok, id } | 400 bad_request { field } | 403 turnstile | 403 forbidden
//                               (a foreign Origin: worker.js fromElsewhere) | 429 slow_down | 503 turnstile_down
//                               | 503 not_set_up (no ENTERPRISE binding, or Turnstile off without TURNSTILE_OPTIONAL=1)
//   GET  /api/admin/enterprise  the owner's session only (adminSession): { requests } or ?format=csv
//
// Each request is stored first in the EnterpriseDesk Durable Object (binding ENTERPRISE, one object
// 'requests', SQLite-backed), then emailed to the owner through Cloudflare Email Workers' send_email
// binding OWNER_MAIL (wrangler.toml [[send_email]] destination_address = "bilel@askeden.com"), from
// ENTERPRISE_MAIL_FROM (an address on a zone with Email Routing on). A failed send is kept with its
// error and retried by the object's alarm every 15 minutes, 5 tries at most; a sent one never again.
// Limits: EDEN_RATE per IP (the Worker's rate limiter), then 3 a day per IP and 3 per email (429),
// and 100 a day in all: past that, requests are stored held and not emailed (the admin list shows them).
// The honeypot field website_url (as leads.js): 200 with nothing stored.

import { limited, clientIp } from '../accounts/index.js';
import { checkHuman, turnstileOn } from '../accounts/turnstile.js';
import { ApiError, json, readJson, sha256Hex } from '../accounts/util.js';
import { enterpriseOn } from '../accounts/plans.js';
import { problem } from '../eden/web.js';

export const OWNER_ADDRESS = 'bilel@askeden.com';
export const TEAM_SIZES = Object.freeze(['1-9', '10-49', '50-249', '250-999', '1000+']);
// The local part: RFC 5321 atext and dots only (no < > , ; : " ( ) [ ] \ that could add a second Reply-To address).
const EMAIL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const DAY_MS = 86400_000;
// perDay: emailed a day (past it, stored held); storeDay: stored a day at all (past it, 429); keepMs: rows kept a year.
export const LIMITS = Object.freeze({ perIp: 3, perEmail: 3, perDay: 100, storeDay: 500, keepMs: 365 * 86400_000, tries: 5, retryMs: 15 * 60_000, listMax: 500 });

/** The EmailMessage class (cloudflare:email); tests set mailer.EmailMessage. */
export const mailer = { EmailMessage: null };
async function emailMessageClass() {
  if (mailer.EmailMessage) return mailer.EmailMessage;
  const mod = await import('cloudflare:email');
  return mod.EmailMessage;
}

// ── the form's fields ──

const oneLine = (v) => String(v ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
const text = (v) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();

/** The request's fields, cleaned: { ok: true, fields } or { ok: false, field }. */
export function validate(body) {
  const b = body && typeof body === 'object' ? body : {};
  const name = oneLine(b.name);
  if (typeof b.name !== 'string' || name.length < 1 || name.length > 100) return { ok: false, field: 'name' };
  const email = oneLine(b.email).toLowerCase();
  if (typeof b.email !== 'string' || email.length > 254 || !EMAIL_RE.test(email) || email.includes('..')) return { ok: false, field: 'email' };
  const company = oneLine(b.company);
  if (typeof b.company !== 'string' || company.length < 1 || company.length > 120) return { ok: false, field: 'company' };
  if (!TEAM_SIZES.includes(b.team_size)) return { ok: false, field: 'team_size' };
  if (b.message !== undefined && b.message !== null && typeof b.message !== 'string') return { ok: false, field: 'message' };
  const message = text(b.message);
  if (message.length > 2000) return { ok: false, field: 'message' };
  return { ok: true, fields: { name, email, company, team_size: b.team_size, message } };
}

const desk = (env) => env.ENTERPRISE.get(env.ENTERPRISE.idFromName('requests'));
const deskCall = async (env, op, body) => desk(env).fetch(`https://enterprise/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

/** POST /api/enterprise (worker.js, after fromElsewhere). */
export async function submitEnterprise(request, env, ctx) {
  try {
    if (!enterpriseOn(env)) throw new ApiError(404, 'not_found', 'No such thing here.');
    if (request.method !== 'POST') throw new ApiError(405, 'bad_request', 'POST it.');
    if (!env.ENTERPRISE || (!turnstileOn(env) && String(env.TURNSTILE_OPTIONAL || '') !== '1')) {
      throw new ApiError(503, 'not_set_up', 'The Enterprise form isn’t set up here yet. Write to bilel@askeden.com.');
    }
    const ip = clientIp(request);
    await limited(env, 'EDEN_RATE', `ent:${ip}`);
    const body = await readJson(request, 16 * 1024);
    if (typeof body.website_url === 'string' && body.website_url.trim()) return json({ ok: true }); // the honeypot: nothing stored
    const v = validate(body);
    if (!v.ok) return json({ error: 'Check that field and send again.', code: 'bad_request', field: v.field }, 400);
    await checkHuman(env, body.turnstile, ip, { host: new URL(request.url).hostname }); // 403 turnstile, 503 turnstile_down
    const ip_hash = (await sha256Hex(`enterprise:${ip}`)).slice(0, 32);
    const country = (request.cf && request.cf.country) || null;
    const res = await deskCall(env, 'submit', { ...v.fields, ip_hash, country });
    const out = await res.json();
    if (res.status === 429) throw new ApiError(429, 'slow_down', 'You’ve sent a few already today. We’ll be in touch; try again tomorrow if you need to.', { 'retry-after': '60' });
    if (!res.ok) throw new ApiError(502, 'server', 'That didn’t go through. Try again in a moment.');
    if (!out.held) {
      const sent = deskCall(env, 'send', { id: out.id }).catch((error) => console.error('enterprise: send failed', error && error.message));
      if (ctx && ctx.waitUntil) ctx.waitUntil(sent);
      else await sent;
    }
    return json({ ok: true, id: out.id });
  } catch (error) {
    if (error instanceof ApiError) return problem(error.status, error.message, error.code, error.headers);
    console.error('enterprise request failed', error && error.message);
    return problem(500, 'Something went wrong on the server. Try again.', 'server');
  }
}

// ── the email ──

const headerSafe = (v) => String(v ?? '').replace(/[\r\n\u0000-\u001f\u007f]+/g, ' ').trim();
const b64 = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
/** RFC 2047: a header value in UTF-8, base64 words. */
const encodedWord = (s) => `=?UTF-8?B?${b64(headerSafe(s))}?=`;

/** The owner's email for a request: RFC 5322, text/plain UTF-8, base64 body; every header value without CR or LF. */
export function ownerMessage(row, { from, to = OWNER_ADDRESS }) {
  const lines = [
    'Eden Enterprise request',
    '',
    `Name: ${row.name}`,
    `Work email: ${row.email}`,
    `Company: ${row.company}`,
    `Team size: ${row.team_size}`,
    `Country: ${row.country || 'unknown'}`,
    `Received: ${new Date(row.created_at).toISOString()}`,
    `Request id: ${row.id}`,
    '',
    'Message:',
    row.message || '(none)',
  ];
  const body = b64(lines.join('\r\n')).replace(/.{1,76}/g, '$&\r\n');
  const domain = headerSafe(from).split('@')[1] || 'askeden.com';
  return [
    `From: Eden Enterprise <${headerSafe(from)}>`,
    `To: <${headerSafe(to)}>`,
    `Reply-To: ${encodedWord(row.name)} <${headerSafe(row.email)}>`,
    `Subject: ${encodedWord(`Eden Enterprise request: ${row.company} (${row.team_size})`)}`,
    `Date: ${new Date(row.created_at).toUTCString()}`,
    `Message-ID: <${headerSafe(row.id)}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

async function sendOwnerMail(env, row) {
  const from = headerSafe(env.ENTERPRISE_MAIL_FROM);
  if (!env.OWNER_MAIL || !EMAIL_RE.test(from)) throw new Error('not_set_up: OWNER_MAIL or ENTERPRISE_MAIL_FROM');
  const EmailMessage = await emailMessageClass();
  await env.OWNER_MAIL.send(new EmailMessage(from, OWNER_ADDRESS, ownerMessage(row, { from })));
}

// ── the Durable Object ──

const ROW_FIELDS = ['id', 'created_at', 'name', 'email', 'company', 'team_size', 'message', 'emailed_at', 'email_error', 'held'];
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);

export class EnterpriseDesk {
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
    if (request.method !== 'POST' || !['submit', 'send', 'list'].includes(op)) return json({ error: 'No such thing here.', code: 'not_found' }, 404);
    const body = (await request.json().catch(() => null)) || {};
    if (op === 'send') return json(await this.send(String(body.id || '')));
    const run = this.queue.then(() => (op === 'submit' ? this.submit(body) : this.list()));
    this.queue = run.catch(() => {});
    return run;
  }

  async submit(body) {
    const v = validate(body);
    if (!v.ok) return json({ error: 'bad field', code: 'bad_request', field: v.field }, 400);
    const now = this.now();
    const ipHash = String(body.ip_hash || '').slice(0, 64);
    const emKey = `em:${(await sha256Hex(v.fields.email)).slice(0, 32)}`;
    const ipKey = `ip:${ipHash}`;
    const recent = (list) => (Array.isArray(list) ? list : []).filter((t) => t > now - DAY_MS);
    const byIp = recent(await this.storage.get(ipKey));
    const byEmail = recent(await this.storage.get(emKey));
    if ((ipHash && byIp.length >= LIMITS.perIp) || byEmail.length >= LIMITS.perEmail) return json({ error: 'slow down', code: 'slow_down' }, 429);
    const dayKey = `day:${dayOf(now)}`;
    const today = Number(await this.storage.get(dayKey)) || 0;
    if (today >= LIMITS.storeDay) return json({ error: 'slow down', code: 'slow_down' }, 429);
    await this.prune(now);
    const id = crypto.randomUUID();
    const row = { id, created_at: now, ...v.fields, ip_hash: ipHash || null, country: body.country ? String(body.country).slice(0, 8) : null, emailed_at: null, email_error: null, tries: 0, held: today >= LIMITS.perDay ? 1 : 0 };
    const rowKey = `r:${String(now).padStart(15, '0')}:${id}`;
    await this.storage.put({ [rowKey]: row, [`id:${id}`]: rowKey, [dayKey]: today + 1, ...(ipHash ? { [ipKey]: [...byIp, now] } : {}), [emKey]: [...byEmail, now] });
    return json({ id, held: Boolean(row.held) });
  }

  /** Emails one stored request once; a failure is kept and retried by the alarm. → { ok, sent?, error? }. */
  async send(id) {
    const rowKey = await this.storage.get(`id:${id}`);
    const row = rowKey ? await this.storage.get(rowKey) : null;
    if (!row) return { ok: false, error: 'not_found' };
    if (row.emailed_at || row.held) return { ok: true, sent: false };
    if (this.sending && this.sending.has(id)) return { ok: true, sent: false }; // already on its way (the alarm and waitUntil at once)
    (this.sending ||= new Set()).add(id);
    try {
      await sendOwnerMail(this.env, row);
      await this.storage.put(rowKey, { ...row, emailed_at: this.now(), email_error: null, tries: row.tries + 1 });
      await this.storage.delete(`q:${id}`);
      return { ok: true, sent: true };
    } catch (error) {
      const tries = row.tries + 1;
      const why = String((error && error.message) || 'send failed').slice(0, 200);
      await this.storage.put(rowKey, { ...row, email_error: why, tries });
      if (tries < LIMITS.tries) {
        await this.storage.put(`q:${id}`, this.now() + LIMITS.retryMs);
        await this.storage.setAlarm(this.now() + LIMITS.retryMs);
      } else await this.storage.delete(`q:${id}`);
      console.error('enterprise: emailing a request failed', why);
      return { ok: false, error: why };
    } finally {
      this.sending.delete(id);
    }
  }

  /** Drops requests older than LIMITS.keepMs (oldest first, a batch per call), with their id pointers and any queued send. */
  async prune(now) {
    const old = [...(await this.storage.list({ prefix: 'r:', limit: 64 })).entries()].filter(([, r]) => r && r.created_at < now - LIMITS.keepMs);
    if (!old.length) return;
    await this.storage.delete(old.flatMap(([k, r]) => [k, `id:${r.id}`, `q:${r.id}`]));
  }

  async alarm() {
    const now = this.now();
    let next = null;
    for (const [k, at] of await this.storage.list({ prefix: 'q:' })) {
      if (at <= now) await this.send(k.slice(2));
      else next = next === null ? at : Math.min(next, at);
    }
    const left = await this.storage.list({ prefix: 'q:' });
    for (const at of left.values()) next = next === null ? at : Math.min(next, at);
    if (next !== null) await this.storage.setAlarm(Math.max(next, now + 1000));
    // a day's counters and old rate-limit lists go after two days
    const cut = now - 2 * DAY_MS;
    const drop = [];
    for (const [k] of await this.storage.list({ prefix: 'day:' })) if (k.slice(4) < dayOf(cut)) drop.push(k);
    for (const prefix of ['ip:', 'em:']) for (const [k, v] of await this.storage.list({ prefix })) if (!Array.isArray(v) || v.every((t) => t < cut)) drop.push(k);
    for (let i = 0; i < drop.length; i += 128) await this.storage.delete(drop.slice(i, i + 128));
  }

  async list() {
    const rows = await this.storage.list({ prefix: 'r:', reverse: true, limit: LIMITS.listMax });
    return json({ requests: [...rows.values()].map((r) => Object.fromEntries(ROW_FIELDS.map((f) => [f, r[f] ?? null]))) });
  }
}

// ── the owner's list ──

/** A CSV cell: quoted, quotes doubled, and a leading = + - @ made inert for spreadsheets. */
const cell = (v) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

/** GET /api/admin/enterprise[?format=csv]: the owner's session only (adminSession, as /api/admin/leads); 404 for anyone else. */
export async function adminEnterprise(request, env, adminSession) {
  const notFound = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  if (request.method !== 'GET' || !(await adminSession(request, env))) return notFound();
  if (!env.ENTERPRISE) return json({ ready: false, requests: [] });
  const { requests } = await (await deskCall(env, 'list', {})).json();
  if (new URL(request.url).searchParams.get('format') === 'csv') {
    const lines = [ROW_FIELDS.join(','), ...requests.map((r) => ROW_FIELDS.map((f) => cell(f === 'created_at' || f === 'emailed_at' ? (r[f] ? new Date(r[f]).toISOString() : '') : r[f])).join(','))];
    return new Response(`${lines.join('\r\n')}\r\n`, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="eden-enterprise-requests.csv"', 'cache-control': 'no-store' } });
  }
  return json({ ready: true, requests });
}
