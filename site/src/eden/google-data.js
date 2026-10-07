// Hosted Eden's Gmail and Google Calendar: the same /api/chat/google/*, /api/chat/gmail and
// /api/chat/gcal* routes Eden's server on the Mac answers (docs/chat-api.md "Gmail",
// "Calendar"), run here in the Worker, so mail and calendar work with the Mac off. The Gmail
// and Calendar core is Eden's own (src/chat/gmail.ts, gcal.ts in the askeden repo, bundled by
// scripts/sync-eden.mjs as vendor/google.js); this file adds the web's sign-in and storage.
//
// Consent (incremental, the same OAuth web client as "Sign in with Google"):
//   POST /api/chat/google/connect { scope: gmail|calendar }  → { url } (the page goes there)
//   GET  /api/chat/google/connect?scope=…                    → 302 to Google, with the attempt's
//        state, PKCE verifier, capability, account and browser device sealed (AES-GCM) in the
//        cookie __Host-eden-gdata (HttpOnly, SameSite=Lax, 10 minutes)
//   GET  /api/chat/google/callback                           → /#gmail=connected|error (via a meta refresh)
//   "Connect Gmail" asks gmail.readonly + gmail.compose (read; drafts and send: compose covers
//   send); "Connect Google Calendar" asks calendar.readonly (the calendar list) + calendar.events.
//   Each with include_granted_scopes=true and access_type=offline; prompt=consent only while
//   there's no refresh token yet (otherwise login_hint picks the Google account already used).
//   The callback can't see the session (its cookie is SameSite=Strict and Google's redirect is
//   cross-site), so it trusts the sealed cookie, and the account object checks that its browser
//   device is still signed in.
// Which Google account: whichever the owner picks. It needn't be the one they sign in to Eden
//   with (mail on another address is common); its email and sub are recorded and shown. One
//   Google account per Eden account for data: connecting a different one replaces (and revokes)
//   the first. Unlinking "Sign in with Google" doesn't touch it.
// Tokens: sealed per account (accounts/tokens.js, key from EDEN_TOKEN_KEY) in the Account
//   object; access tokens refreshed on demand; never sent to the browser. Disconnect
//   (POST /api/chat/google/disconnect) and account deletion revoke the grant at Google.
// Limits: Gmail and Calendar calls cost no included AI; each counts against API_RATE per account.
// Scheduled send: the email waits in Gmail's Drafts and the account object sends it at the time
//   from its alarm (accounts/schedule.js: Mac off, page closed; more than 12 h late it waits for
//   the owner, as on the Mac). `schedule`, `scheduled` and `cancelScheduled` work as on the Mac.
// "Contacts" reads ~100 messages' headers: here in Gmail batch requests (4 subrequests in all;
//   the Workers Free plan allows 50), at most CONTACTS_CAP one by one if batching fails.
// Attachments uploaded ahead (`upload*`, then { uploadId } in draft/send/schedule) work as on the
//   Mac: held in the account object a few hours, a big message streamed to Gmail's resumable
//   upload (eden/gmail-uploads.js, accounts/mail-uploads.js).
// Until GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and EDEN_TOKEN_KEY are set, these routes keep
// answering 503 "needs your Mac" (chat.js), as before.

import { call, limited } from '../accounts/index.js';
import { openTokens, openWith, sealTokens, sealWith } from '../accounts/tokens.js';
import { ApiError, b64ToBytes, b64url, randomBytes } from '../accounts/util.js';
import { buildAuthUrl, exchangeCode, googleReady, pkcePair } from './google.js';
import { SIGNIN_CSP, cookie, cookies, json, page, problem } from './web.js';
import { UPLOAD_ACTIONS, outgoingUploads, uploadAction } from './gmail-uploads.js';
import {
  CALENDAR_SCOPES,
  GoogleError,
  createCalendarApi,
  createGmailApi,
  hasCalendarScopes,
  refreshAccessToken,
  revokeToken,
  runCalendarAction,
  runGmailAction,
} from './vendor/google.js';

export const GDATA_COOKIE = '__Host-eden-gdata';
export const GDATA_CALLBACK = '/api/chat/google/callback';
const STATE_SECONDS = 600;
const EXPIRY_MARGIN_MS = 60_000;
const GMAIL_READ = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';
const GMAIL_SCOPES = [GMAIL_READ, GMAIL_COMPOSE];
const CAPABILITIES = { gmail: GMAIL_SCOPES, calendar: [...CALENDAR_SCOPES], all: [...GMAIL_SCOPES, ...CALENDAR_SCOPES] };

export const GOOGLE_DATA_ROUTES = new Set([
  'GET /api/chat/google/status',
  'POST /api/chat/google/config',
  'POST /api/chat/google/connect',
  'GET /api/chat/google/connect',
  `GET ${GDATA_CALLBACK}`,
  'POST /api/chat/google/disconnect',
  'POST /api/chat/gmail',
  'GET /api/chat/gcal/status',
  'POST /api/chat/gcal',
]);

/** Gmail is usable: read, and drafts + send (compose covers send; modify or full mail cover both). */
export function hasGmailScopes(scopes) {
  const s = new Set(scopes || []);
  const full = s.has('https://mail.google.com/') || s.has('https://www.googleapis.com/auth/gmail.modify');
  return full || (s.has(GMAIL_READ) && s.has(GMAIL_COMPOSE));
}

/** Google data is set up here: the OAuth web client and the token key. */
export function googleDataReady(env = {}) {
  return googleReady(env) && Boolean(String(env.EDEN_TOKEN_KEY || '').trim());
}

const client = (env) => ({ clientId: String(env.GOOGLE_CLIENT_ID), clientSecret: String(env.GOOGLE_CLIENT_SECRET) });

// ── a fake Google for local QA ──
//
// GOOGLE_FAKE_BASE (http://localhost:<port> or http://127.0.0.1:<port>) sends every Google call
// to <base>/<google host>/<path> — honored only while the request itself is to localhost
// (wrangler dev), never on askeden.com.

const GOOGLE_HOSTS = /^https:\/\/(accounts\.google\.com|oauth2\.googleapis\.com|gmail\.googleapis\.com|www\.googleapis\.com)\//;

export function fakeBase(env, request) {
  const base = String(env.GOOGLE_FAKE_BASE || '').replace(/\/+$/, '');
  if (!base) return null;
  const host = new URL(request.url).hostname;
  const local = (h) => h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '[::1]';
  let target;
  try {
    target = new URL(base);
  } catch {
    return null;
  }
  return local(host) && local(target.hostname) && target.protocol === 'http:' ? base : null;
}

const viaFake = (base, url) => (base ? url.replace(GOOGLE_HOSTS, (_, h) => `${base}/${h}/`) : url);

/** The fetch Eden's Google core uses (Workers' own, called plainly; a fake Google in dev). */
function googleFetch(env, request) {
  const base = fakeBase(env, request);
  return (url, init) => fetch(viaFake(base, url), init);
}

const googleProblem = (e) =>
  problem(e.status, e.message, e.code, e.retryAfter !== undefined ? { 'retry-after': String(e.retryAfter) } : {});

// ── the sealed record ──

/** What's stored for the account, opened: { gen, tokens } or null (none, or sealed under an old key). */
async function load(env, who) {
  const { record } = await call(env, who.account, 'google-get', {}, who.token);
  if (!record) return null;
  const tokens = await openTokens(env, who.account, record);
  return tokens && tokens.refresh ? { gen: record.gen, tokens } : null;
}

function statusOf(found) {
  const t = found && found.tokens;
  return {
    configured: true,
    connected: Boolean(t && hasGmailScopes(t.scopes)),
    email: (t && t.email) || null,
    gmail: Boolean(t && hasGmailScopes(t.scopes)),
    calendar: Boolean(t && hasCalendarScopes(t.scopes)),
    hosted: true,
  };
}

/**
 * Access tokens for one request: the stored one while it's good, else one refresh (shared by
 * the request's parallel calls) saved back for the next request. A refused refresh token
 * removes the grant here (the page then shows Connect again).
 */
function tokenSource(env, ctx, who, found, f) {
  let refreshing = null;
  const t = found.tokens;
  return async (fresh) => {
    if (!fresh && t.access && t.access_exp - EXPIRY_MARGIN_MS > Date.now()) return t.access;
    refreshing ??= (async () => {
      try {
        const r = await refreshAccessToken(client(env), t.refresh, f);
        Object.assign(t, { access: r.accessToken, access_exp: r.expiresAt, refresh: r.refreshToken || t.refresh });
        const record = await sealTokens(env, who.account, t);
        const save = call(env, who.account, 'google-touch', { gen: found.gen, record }, who.token).catch(() => undefined);
        if (ctx && ctx.waitUntil) ctx.waitUntil(save);
        else await save;
        return r.accessToken;
      } catch (e) {
        if (e instanceof GoogleError && e.code === 'reconnect') await call(env, who.account, 'google-delete', {}, who.token).catch(() => undefined);
        throw e;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  };
}

// Scheduled send: Eden's Gmail core asks its scheduler synchronously, so this one starts from the
// account's jobs (one call) and hands what changed to the account object once the action ran.
// The object checks it all again; listing and cancelling go straight to it (no Gmail call).
const SCHEDULER_ACTIONS = new Set(['schedule', 'send', 'drafts', 'getDraft', 'deleteDraft']);
const JOB_ID = /^[0-9a-f]{24}$/;
const hexId = () => [...randomBytes(12)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function webScheduler(env, who, request) {
  const { jobs } = await call(env, who.account, 'mail-jobs', {}, who.token);
  const ops = [];
  const scheduler = {
    schedule(input) {
      const active = jobs.find((j) => j.draftId === input.draftId && j.status === 'scheduled');
      const job = {
        ...(active || { id: hexId(), createdAt: new Date().toISOString() }),
        draftId: input.draftId,
        threadId: input.threadId,
        account: input.account,
        to: input.to.slice(0, 100),
        subject: input.subject.slice(0, 300),
        sendAt: new Date(input.sendAt).toISOString(),
        status: 'scheduled',
        attempts: 0,
        nextTryAt: null,
        sentAt: null,
        messageId: null,
        error: null,
      };
      ops.push({ op: 'schedule', job });
      return job;
    },
    list: () => jobs,
    cancel() {
      throw new GoogleError('Cancel it from the Scheduled list.', 'bad_request', 400); // cancelScheduled goes to the account object
    },
    forDraft: (draftId) => jobs.find((j) => j.draftId === draftId && (j.status === 'scheduled' || j.status === 'sending')),
    release(draftId, why) {
      ops.push({ op: 'release', draftId, why });
    },
  };
  const flush = async () => (ops.length ? (await call(env, who.account, 'mail-apply', { ops, local: Boolean(fakeBase(env, request)) }, who.token)).jobs : []);
  return { scheduler, flush };
}

// ── "Contacts" in Gmail batch requests ──

const GMAIL_BATCH = 'https://gmail.googleapis.com/batch/gmail/v1';
export const CONTACTS_CAP = 30;
const METADATA_HEADERS = ['From', 'To', 'Cc', 'Reply-To', 'Date'];

/** The parts of a multipart/mixed batch answer: [{ id (Content-ID), status, body }]. */
export function parseBatch(text, type) {
  const boundary = (/boundary="?([^";]+)"?/i.exec(type || '') || [])[1];
  if (!boundary) return [];
  const out = [];
  for (const part of String(text).split(`--${boundary}`)) {
    const status = /HTTP\/1\.[01] (\d{3})/.exec(part);
    if (!status) continue;
    const rest = part.slice(status.index);
    const at = rest.search(/\r?\n\r?\n/);
    out.push({ id: (/Content-ID:\s*<([^>]*)>/i.exec(part) || [])[1] || '', status: Number(status[1]), body: at < 0 ? '' : rest.slice(at).trim() });
  }
  return out;
}

async function batchMetadata(f, auth, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const boundary = `eden_${hexId()}`;
    const query = `format=metadata${METADATA_HEADERS.map((h) => `&metadataHeaders=${h}`).join('')}`;
    const body = `${chunk.map((id, n) => `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <m${n}>\r\n\r\nGET /gmail/v1/users/me/messages/${id}?${query}\r\n\r\n`).join('')}--${boundary}--\r\n`;
    const res = await f(GMAIL_BATCH, { method: 'POST', headers: { authorization: auth, 'content-type': `multipart/mixed; boundary=${boundary}` }, body });
    if (!res.ok) throw new Error(`Gmail batch HTTP ${res.status}`);
    for (const p of parseBatch(await res.text(), res.headers.get('content-type'))) {
      const n = Number((/m(\d+)$/.exec(p.id) || [])[1]);
      if (Number.isInteger(n) && chunk[n]) out.set(chunk[n], p.status === 200 ? p.body : null);
    }
  }
  return out;
}

/**
 * The fetch Eden's core uses for `contacts`: its two lists go to Gmail as they are; its ~100
 * per-message header reads are answered from batch requests made at the first of them.
 * Without batches, at most CONTACTS_CAP go to Gmail one by one; the rest count as empty.
 */
export function contactsFetch(f) {
  const lists = new Map();
  let batch = null;
  let direct = 0;
  const empty = (id) => Response.json({ id, payload: { headers: [] } });
  return async (url, init = {}) => {
    const u = new URL(url);
    const rel = u.host === 'gmail.googleapis.com' ? u.pathname.replace('/gmail/v1/users/me', '') : null;
    if (rel === '/messages' && u.searchParams.get('labelIds')) {
      const res = await f(url, init);
      const text = await res.text();
      try {
        if (res.ok) lists.set(u.searchParams.get('labelIds'), (JSON.parse(text).messages || []).map((m) => m.id).filter((id) => /^[0-9A-Za-z_-]{1,128}$/.test(id)));
      } catch {
        // not a list: Eden's core reports it
      }
      return new Response(text, { status: res.status, headers: res.headers });
    }
    const one = rel && u.searchParams.get('format') === 'metadata' ? /^\/messages\/([0-9A-Za-z_-]{1,128})$/.exec(rel) : null;
    if (!one) return f(url, init);
    const h = init.headers || {};
    const auth = typeof h.get === 'function' ? h.get('authorization') : h.authorization || h.Authorization;
    batch ??= batchMetadata(f, auth, [...new Set([...lists.values()].flat())]).catch(() => null);
    const got = await batch;
    if (got && got.has(one[1])) return got.get(one[1]) === null ? empty(one[1]) : new Response(got.get(one[1]), { status: 200, headers: { 'content-type': 'application/json' } });
    if (direct >= CONTACTS_CAP) return empty(one[1]);
    direct += 1;
    return f(url, init);
  };
}

// The core's upload store when nothing uploaded is named: uploads live in the account object
// (gmail-uploads.js answers the upload actions before the core runs), never in this isolate.
const noUploads = () => {
  throw new GoogleError('That attachment is no longer on Eden’s server: it will be uploaded again.', 'upload_missing', 410);
};
const webUploads ={ start: noUploads, chunk: noUploads, put: noUploads, get: noUploads, info: noUploads, remove: noUploads, held: () => 0 };

// Recent correspondents (contacts) per account and address, 10 minutes, this isolate.
const contactsCache = new Map();

// ── the routes ──

/**
 * One of GOOGLE_DATA_ROUTES (chat.js sends them here once googleDataReady). `gate` and
 * `readBody` are chat.js's own checks (signed in, header, same-origin JSON).
 */
export async function googleData(request, env, ctx, path, { gate, readBody, maxBody }) {
  const route = `${request.method} ${path}`;
  try {
    if (route === `GET ${GDATA_CALLBACK}`) return await callback(request, env, ctx);
    if (route === 'GET /api/chat/google/connect') return await connectStart(request, env, await gate(request, env, { header: false }));
    const who = await gate(request, env);
    await limited(env, 'API_RATE', who.account);
    const f = googleFetch(env, request);
    switch (route) {
      case 'GET /api/chat/google/status':
        return json(statusOf(await load(env, who)));
      case 'GET /api/chat/gcal/status': {
        const s = statusOf(await load(env, who));
        return json({ configured: true, connected: s.calendar, email: s.email, calendar: s.calendar, hosted: true });
      }
      case 'POST /api/chat/google/config':
        throw new ApiError(400, 'bad_request', 'On askeden.com, Google is already set up: press Connect Gmail or Connect Google Calendar.');
      case 'POST /api/chat/google/connect': {
        const body = await readBody(request, 4096);
        const scope = body.scope === undefined ? 'all' : body.scope;
        if (!Object.hasOwn(CAPABILITIES, scope)) throw new ApiError(400, 'bad_request', 'scope must be gmail or calendar.');
        return json({ url: `/api/chat/google/connect?scope=${scope}` });
      }
      case 'POST /api/chat/google/disconnect': {
        await readBody(request, 4096);
        const { record } = await call(env, who.account, 'google-delete', {}, who.token);
        const tokens = record ? await openTokens(env, who.account, record) : null;
        if (tokens && (tokens.refresh || tokens.access)) await revokeToken(tokens.refresh || tokens.access, f);
        return json(statusOf(null));
      }
      case 'POST /api/chat/gmail': {
        const { action, args } = actionBody(await readBody(request, maxBody));
        // Scheduled sends (accounts/schedule.js): the list and cancelling need no Gmail call.
        if (action === 'scheduled') return json(await call(env, who.account, 'mail-jobs', {}, who.token));
        if (action === 'cancelScheduled') {
          if (typeof args.id !== 'string' || !JOB_ID.test(args.id)) throw new GoogleError('id must be a scheduled send’s id.', 'bad_request', 400);
          return json(await call(env, who.account, 'mail-cancel', { id: args.id }, who.token));
        }
        const found = await load(env, who);
        if (!found || !hasGmailScopes(found.tokens.scopes)) throw new GoogleError('Gmail is not connected.', 'not_connected', 409);
        const token = tokenSource(env, ctx, who, found, f);
        // Attachments uploaded ahead (gmail-uploads.js): kept in the account object; drafts and sends name them.
        if (UPLOAD_ACTIONS.has(action)) return json(await uploadAction(env, who, action, args, { token, fetch: f }));
        const up = await outgoingUploads(env, who, action, args);
        const api = createGmailApi({ token, fetch: up ? up.fetch(f, token) : action === 'contacts' ? contactsFetch(f) : f });
        const from = found.tokens.email || undefined;
        const key = `${who.account}:${from || ''}`;
        const hit = contactsCache.get(key);
        if (action === 'contacts' && hit && Date.now() - hit.at < 10 * 60_000 && args.fresh !== true) return json(hit.value);
        const sched = SCHEDULER_ACTIONS.has(action) ? await webScheduler(env, who, request) : null;
        const out = await runGmailAction(api, action, args, { from, scheduler: sched ? sched.scheduler : undefined, uploads: up ? up.store : webUploads }).catch((e) => {
          throw (up && up.error) || e; // e.g. 410: an upload went meanwhile
        });
        if (sched) {
          const saved = await sched.flush();
          if (action === 'schedule' && saved[0]) out.job = saved[0];
        }
        if (up && action !== 'draft') await up.free(); // sent, or in Gmail's Drafts for its time: no longer needed here
        if (action === 'contacts') {
          contactsCache.set(key, { at: Date.now(), value: out });
          if (contactsCache.size > 200) contactsCache.delete(contactsCache.keys().next().value);
        }
        return json(out);
      }
      case 'POST /api/chat/gcal': {
        const { action, args } = actionBody(await readBody(request, 1 << 20));
        const found = await load(env, who);
        if (!found) throw new GoogleError('Google Calendar isn’t connected.', 'not_connected', 409);
        if (!hasCalendarScopes(found.tokens.scopes)) throw new GoogleError('Connect Google Calendar to see your calendar.', 'scope', 403);
        return json(await runCalendarAction(createCalendarApi({ token: tokenSource(env, ctx, who, found, f), fetch: f }), action, args));
      }
      default:
        throw new ApiError(404, 'not_found', 'Not found');
    }
  } catch (error) {
    if (error instanceof GoogleError) return googleProblem(error);
    throw error;
  }
}

function actionBody(body) {
  if (typeof body.action !== 'string') throw new ApiError(400, 'bad_request', 'action must be a string');
  const args = body.args === undefined ? {} : body.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ApiError(400, 'bad_request', 'args must be an object');
  return { action: body.action, args };
}

// ── consent ──

const redirectUri = (request) => `${new URL(request.url).origin}${GDATA_CALLBACK}`;
const sealState = (env, value) => sealWith(env, 'gdata-cookie', 'gdata-state', value);
const openState = (env, value) => openWith(env, 'gdata-cookie', 'gdata-state', value);

async function connectStart(request, env, who) {
  await limited(env, 'API_RATE', who.account);
  const scope = new URL(request.url).searchParams.get('scope') || 'all';
  if (!Object.hasOwn(CAPABILITIES, scope)) throw new ApiError(400, 'bad_request', 'scope must be gmail or calendar.');
  const found = await load(env, who);
  const state = b64url(randomBytes(32));
  const { verifier, challenge } = await pkcePair();
  const sealed = await sealState(env, { a: who.account, d: who.token.device, s: state, v: verifier, c: scope, x: Date.now() + STATE_SECONDS * 1000 });
  // No refresh token yet: prompt=consent makes Google issue one; else login_hint picks the same Google account.
  const url = buildAuthUrl(env, {
    redirectUri: redirectUri(request),
    state,
    nonce: b64url(randomBytes(16)),
    challenge,
    scopes: ['openid', 'email', ...CAPABILITIES[scope]],
    prompt: found ? '' : 'consent',
    includeGrantedScopes: true,
    accessType: 'offline',
    loginHint: (found && found.tokens.email) || '',
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: viaFake(fakeBase(env, request), url),
      'set-cookie': cookie(GDATA_COOKIE, `${sealed.iv}.${sealed.ct}`, { maxAge: STATE_SECONDS, sameSite: 'Lax' }),
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  });
}

/** The claims of the id_token Google's token endpoint just sent (over TLS: no signature check needed). */
function idClaims(idToken, env) {
  try {
    const claims = JSON.parse(new TextDecoder().decode(b64ToBytes(String(idToken).split('.')[1] || '')));
    const issuer = claims.iss === 'https://accounts.google.com' || claims.iss === 'accounts.google.com';
    const aud = Array.isArray(claims.aud) ? claims.aud.includes(client(env).clientId) : claims.aud === client(env).clientId;
    if (!issuer || !aud || typeof claims.sub !== 'string' || !claims.sub) return null;
    return { sub: claims.sub, email: typeof claims.email === 'string' && claims.email.includes('@') ? claims.email : null };
  } catch {
    return null;
  }
}

async function exchange(env, f, request, code, verifier) {
  try {
    const got = await exchangeCode(env, { code, verifier, redirectUri: redirectUri(request) }, f);
    return typeof got.access_token === 'string' ? got : null;
  } catch {
    return null; // refused or unreachable: the page says "didn't finish"
  }
}

async function callback(request, env, ctx) {
  const url = new URL(request.url);
  // Back to Eden through a small page of ours (a meta refresh): a redirect from Google's
  // navigation would load Eden without its SameSite=Strict session cookie (as session.js does).
  const done = (ok) => {
    const href = `/#gmail=${ok ? 'connected' : 'error'}`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="0; url=${href}"><title>Eden</title><link rel="stylesheet" href="/signin/signin.css"></head>
<body><main class="card"><h1>Opening Eden…</h1><p><a class="button" href="${href}">Continue to Eden</a></p></main></body></html>`;
    const response = page(new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }), SIGNIN_CSP);
    response.headers.set('set-cookie', cookie(GDATA_COOKIE, '', { maxAge: 0, sameSite: 'Lax' }));
    response.headers.set('referrer-policy', 'no-referrer'); // this URL held the code
    return response;
  };
  const [iv = '', ct = ''] = String(cookies(request)[GDATA_COOKIE] || '').split('.');
  const pending = iv && ct ? await openState(env, { iv, ct }) : null;
  const state = url.searchParams.get('state') || '';
  const code = url.searchParams.get('code') || '';
  if (!pending || pending.s !== state || !(pending.x > Date.now()) || url.searchParams.get('error') || !code) return done(false);
  await limited(env, 'API_RATE', pending.a);
  const f = googleFetch(env, request);
  const got = await exchange(env, f, request, code, pending.v);
  const who = got && idClaims(got.id_token, env);
  if (!who) return done(false);
  const scopes = typeof got.scope === 'string' ? got.scope.split(/\s+/).filter(Boolean) : [];
  const asDevice = { device: pending.d };
  let old = null;
  try {
    const { record } = await call(env, pending.a, 'google-get', asDevice);
    old = record ? await openTokens(env, pending.a, record) : null;
  } catch {
    return done(false); // that browser was signed out meanwhile
  }
  const same = old && old.sub === who.sub;
  const refresh = got.refresh_token || (same ? old.refresh : null);
  if (!refresh) return done(false); // a different Google account that granted before: Connect again gives one (prompt=consent)
  const tokens = {
    refresh,
    access: got.access_token,
    access_exp: Date.now() + (Number(got.expires_in) > 0 ? Number(got.expires_in) : 3600) * 1000,
    scopes,
    email: who.email || (same ? old.email : null),
    sub: who.sub,
    connected: same ? old.connected : new Date().toISOString(),
  };
  await call(env, pending.a, 'google-save', { ...asDevice, record: await sealTokens(env, pending.a, tokens) });
  if (old && !same && old.refresh) ctx.waitUntil(revokeToken(old.refresh, f)); // replaced by another Google account
  return done(CAPABILITIES[pending.c].every((s) => scopes.includes(s)) || (pending.c === 'gmail' ? hasGmailScopes(scopes) : pending.c === 'calendar' ? hasCalendarScopes(scopes) : false));
}
