// Signing in to Eden Notes (its own Worker, "eden-notes", at NOTES_ORIGIN: Eden Notes/cloud in the project folder) with the
// askeden.com sign-in, and Eden Notes asking what plan an account has. Modelled on Eden Calendar's handoff
// (calendar-handoff.js, askeden calendar-worker/src/hand.ts), but keyed by the Eden account id, never an email.
//
//   1. <notes>/auth/start: a random state in that browser's cookie there, and on to
//      askeden.com/hand/notes?state_hash=<its SHA-256>&return=<notes>/auth/finish.
//   2. askeden.com/hand/notes (here): from another site the page first moves on to itself (a load that started on another
//      site carries no Strict cookie). Signed out: /signin, and back. Signed in: a ticket
//        base64url(JSON {aud:'eden-notes-hand', sub:<account id>, plus, unlimited, state_hash, iat, exp:iat+120, jti})
//        + '.' + base64url(HMAC-SHA256 with NOTES_LINK_SECRET)
//      sent on to <return>?ticket=<ticket>. `return` is only ever NOTES_ORIGIN + '/auth/finish' (from the config, never the
//      request). Never a custom scheme: another app could claim edennotes://, and the state binding means nothing to
//      an app that picks its own state. The iPhone app signs in through <notes>/auth/start?client=ios like a browser.
//   3. <notes>/auth/finish: the ticket's signature, audience, age and jti (once) checked, its state_hash against that
//      browser's cookie (a ticket made for another browser signs no one in), then Eden Notes' own session.
//
//   POST /api/hand/notes/plan: Eden Notes' Worker re-checking an account's Plus (daily, and at each sign-in). The body is
//   exactly the JSON {sub, ts} (ts in Unix seconds, within 60 s of now), header x-notes-sig = HMAC-SHA256 of the raw body
//   with NOTES_LINK_SECRET (base64url, or hex) → {plus, unlimited}; an account that doesn't exist → 404
//   {code:'no_account', gone:true} (Eden Notes then signs its devices out and deletes it). A server call: no session, no
//   Origin; the signature is the guard. Rate limits: per account after the signature; per IP only for bad signatures
//   (Eden Notes' many accounts share Cloudflare's addresses, so a per-IP limit on good calls would fail real checks).
//   Nothing happens anywhere here until NOTES_LINK_SECRET (≥ 32 characters) is set.

import { call, clientIp, limited } from '../accounts/index.js';
import { ApiError, b64url, b64urlText, hex, randomBytes, sameText, validAccountId, webAllowed } from '../accounts/util.js';
import { SIGNIN_CSP, json, page } from './web.js';
import { currentSession } from './session.js';

export const NOTES_HAND_AUDIENCE = 'eden-notes-hand';
const NOTES_TICKET_SECONDS = 120;
const NOTES_PLAN_WINDOW_S = 60;
const NOTES_PLAN_BODY_MAX = 256;
const NOTES_STATE_HASH = /^[0-9a-f]{64}$|^[A-Za-z0-9_-]{43}$/; // SHA-256, hex or base64url
const notesEnc = new TextEncoder();
const notesEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const notesGo = (location) => new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });

// https only, except a local dev origin (http://localhost, http://*.localhost), as in calendar-handoff.js
export const notesOrigin = (env) => {
  const o = String(env.NOTES_ORIGIN || 'https://notes.askeden.com');
  return /^https:\/\/[a-z0-9.-]+$|^http:\/\/([a-z0-9-]+\.)?localhost(:\d+)?$/.test(o) ? o : 'https://notes.askeden.com';
};
const notesSecretOf = (env) => {
  const s = String(env.NOTES_LINK_SECRET || '');
  return s.length >= 32 ? s : '';
};
/** The only place a ticket goes: Eden Notes' /auth/finish. Anything else is null. */
const notesReturnOf = (env, raw) => {
  const finish = `${notesOrigin(env)}/auth/finish`;
  return raw === null || raw === '' || raw === finish ? finish : null;
};

function notesNote(title, text, link, label, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${link && !label ? `<meta http-equiv="refresh" content="0; url=${notesEsc(link)}">` : ''}<title>Eden Notes</title><link rel="stylesheet" href="/signin/signin.css"></head>
<body><main class="card"><h1>${title}</h1>${text ? `<p>${text}</p>` : ''}${link ? `<p><a class="button" href="${notesEsc(link)}">${label || 'Continue'}</a></p>` : ''}</main></body></html>`;
  return page(new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer' } }), SIGNIN_CSP);
}

async function notesHmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', notesEnc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, notesEnc.encode(text)));
}

/** The ticket: base64url(JSON) + '.' + base64url(HMAC-SHA256), the same form as Eden Calendar's. */
export async function notesTicket(secret, { sub, plus, unlimited, state_hash }, nowS = Math.floor(Date.now() / 1000)) {
  const claims = { aud: NOTES_HAND_AUDIENCE, sub, plus: Boolean(plus), unlimited: Boolean(unlimited), state_hash, iat: nowS, exp: nowS + NOTES_TICKET_SECONDS, jti: b64url(randomBytes(16)) };
  const body = b64urlText(JSON.stringify(claims));
  return `${body}.${b64url(await notesHmac(secret, body))}`;
}

/** The account's plan as Eden Notes sees it (account.js notesPlan): {plus, unlimited}. */
const notesPlanOf = (env, accountId) => call(env, accountId, 'notes-plan');

/** 2. askeden.com/hand/notes: the signed-in account's ticket, sent to Eden Notes. */
export async function notesHandPage(request, env) {
  const url = new URL(request.url);
  const stateHash = url.searchParams.get('state_hash') || '';
  const back = notesReturnOf(env, url.searchParams.get('return'));
  if (!NOTES_STATE_HASH.test(stateHash) || !back) return notesGo('/');
  const secret = notesSecretOf(env);
  if (!secret) return notesNote('Eden Notes isn’t connected yet', 'Signing in to Eden Notes with your Eden account isn’t switched on yet.', '/', 'Go to Eden');
  const self = `/hand/notes?state_hash=${stateHash}&return=${encodeURIComponent(back)}&on=1`;
  // from another site: no Strict cookie on this load; the same page again, from here, has it
  if ((request.headers.get('sec-fetch-site') || '') === 'cross-site' && url.searchParams.get('on') !== '1') return notesNote('Opening Eden Notes…', '', self);
  const { session } = await currentSession(request, env);
  if (!session) return notesGo(`/signin?return=${encodeURIComponent(self)}`);
  if (!webAllowed(env, session.account)) return notesGo('/');
  let plan;
  try {
    await limited(env, 'AUTH_RATE', `hand-notes:${session.account}`);
    plan = await notesPlanOf(env, session.account);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return notesNote('Eden Notes couldn’t sign you in', notesEsc(error.message), self, 'Try again', error.status);
  }
  const { plus, unlimited } = plan;
  return notesGo(`${back}?ticket=${await notesTicket(secret, { sub: session.account, plus, unlimited, state_hash: stateHash })}`);
}

/** POST /api/hand/notes/plan: Eden Notes' Worker asking an account's plan, its body signed with NOTES_LINK_SECRET. */
export async function notesPlanApi(request, env) {
  try {
    if (request.method !== 'POST') throw new ApiError(405, 'method', 'Use POST.', { allow: 'POST' });
    const secret = notesSecretOf(env);
    if (!secret || !env.ACCOUNTS) throw new ApiError(503, 'not_set_up', 'Eden Notes isn’t connected here yet.');
    if (Number(request.headers.get('content-length') || 0) > NOTES_PLAN_BODY_MAX) throw new ApiError(413, 'too_large', 'That request is too large.');
    const raw = await request.text();
    if (raw.length > NOTES_PLAN_BODY_MAX) throw new ApiError(413, 'too_large', 'That request is too large.');
    const sig = String(request.headers.get('x-notes-sig') || '').trim();
    const mac = await notesHmac(secret, raw);
    // both forms compared every time, each without leaking where it differs
    const good = [sameText(sig, b64url(mac)), sameText(sig.toLowerCase(), hex(mac))].some(Boolean);
    if (!sig || !good) {
      await limited(env, 'API_RATE', `notes-plan-ip:${clientIp(request)}`); // only guessers pay per IP
      throw new ApiError(401, 'signature', 'That signature doesn’t match.');
    }
    let body;
    try { body = JSON.parse(raw); } catch { throw new ApiError(400, 'bad_request', 'The body isn’t JSON.'); }
    const sub = body && typeof body.sub === 'string' ? body.sub.toLowerCase() : '';
    const ts = Number(body && body.ts);
    if (!validAccountId(sub)) throw new ApiError(400, 'bad_request', 'No such account id.');
    if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > NOTES_PLAN_WINDOW_S) throw new ApiError(401, 'stale', 'That request is too old.');
    await limited(env, 'AUTH_RATE', `notes-plan:${sub}`);
    let plan;
    try {
      plan = await notesPlanOf(env, sub);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) throw new ApiError(404, 'no_account', 'No such account.', {}, { gone: true });
      throw error;
    }
    return json({ plus: Boolean(plan.plus), unlimited: Boolean(plan.unlimited) });
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return error.response();
  }
}
