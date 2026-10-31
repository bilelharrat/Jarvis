// Signing in on Eden Calendar's own site (askedencalendar.com: its own Worker, askeden's calendar-worker/) with the
// askeden.com sign-in, so a calendar opens only for the person whose Eden account it is. Until 2026-10-30 that site
// signed anyone in as any email they typed.
//
//   1. <calendar>/auth/start (calendar-worker/src/hand.ts): a random state in that browser's cookie there, and on to
//      askeden.com/hand/calendar?s=<its SHA-256>.
//   2. askeden.com/hand/calendar (here): from another site the page first moves on to itself (a load that started on
//      another site carries no Strict cookie). Signed out: /signin, and back. Signed in: a ticket naming the account's
//      email (account.js calendarEmail) and the state's hash, good for a minute, signed with EDEN_CALENDAR_LINK_SECRET
//      (the calendar Worker's EDEN_LINK_SECRET), sent on to <calendar>/auth/finish?t=<ticket>.
//   3. <calendar>/auth/finish: the ticket's signature, audience and age checked, and its state's hash against that
//      browser's cookie (a ticket made for another browser signs no one in), then the calendar's own session.
//
// The calendar's address is CALENDAR_ORIGIN or https://askedencalendar.com, never one from the request.

import { call, limited } from '../accounts/index.js';
import { b64url, b64urlText, webAllowed } from '../accounts/util.js';
import { SIGNIN_CSP, page } from './web.js';
import { currentSession } from './session.js';

export const CALENDAR_HAND_AUDIENCE = 'eden-calendar-hand';
const TICKET_SECONDS = 60;
const go = (location) => new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
// https only, except a local dev origin (http://localhost, http://*.localhost), as in site-handoff.js
const calendarOrigin = (env) => {
  const o = String(env.CALENDAR_ORIGIN || 'https://askedencalendar.com');
  return /^https:\/\/[a-z0-9.-]+$|^http:\/\/([a-z0-9-]+\.)?localhost(:\d+)?$/.test(o) ? o : 'https://askedencalendar.com';
};
const secretOf = (env) => {
  const s = String(env.EDEN_CALENDAR_LINK_SECRET || '');
  return s.length >= 32 ? s : '';
};

function note(title, text, link, label) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
${link && !label ? `<meta http-equiv="refresh" content="0; url=${link}">` : ''}<title>Eden Calendar</title><link rel="stylesheet" href="/signin/signin.css"></head>
<body><main class="card"><h1>${title}</h1>${text ? `<p>${text}</p>` : ''}${link ? `<p><a class="button" href="${link}">${label || 'Continue'}</a></p>` : ''}</main></body></html>`;
  return page(new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer' } }), SIGNIN_CSP);
}

/** The ticket: base64url(JSON) + '.' + base64url(HMAC-SHA256), the calendar's link-token form (calendar-worker/src/api.ts). */
export async function calendarTicket(secret, { sub, s }, nowS = Math.floor(Date.now() / 1000)) {
  const body = b64urlText(JSON.stringify({ sub, aud: CALENDAR_HAND_AUDIENCE, s, exp: nowS + TICKET_SECONDS }));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return `${body}.${b64url(sig)}`;
}

/** 2. askeden.com/hand/calendar: the signed-in account's ticket, sent to the calendar. */
export async function calendarHandPage(request, env) {
  const url = new URL(request.url);
  const s = url.searchParams.get('s') || '';
  const secret = secretOf(env);
  if (!/^[0-9a-f]{64}$/.test(s)) return go('/');
  if (!secret) return note('Eden Calendar isn’t connected yet', 'Signing in to Eden Calendar with your Eden account isn’t switched on yet.', '/', 'Go to Eden');
  const self = `/hand/calendar?s=${s}&on=1`;
  // from another site: no Strict cookie on this load; the same page again, from here, has it
  if ((request.headers.get('sec-fetch-site') || '') === 'cross-site' && url.searchParams.get('on') !== '1') return note('Opening Eden Calendar…', '', self);
  const { session } = await currentSession(request, env);
  if (!session) return go(`/signin?return=${encodeURIComponent(self)}`);
  if (!webAllowed(env, session.account)) return go('/');
  await limited(env, 'AUTH_RATE', `hand-cal:${session.account}`);
  const { email } = await call(env, session.account, 'calendar-email');
  if (!email) {
    return note('Your Eden account has no email yet', 'Eden Calendar keeps your calendar under your email address. Add Apple or Google as a way to sign in to Eden (Account), then try again.', `${calendarOrigin(env)}/auth/start`, 'Try again');
  }
  return go(`${calendarOrigin(env)}/auth/finish?t=${await calendarTicket(secret, { sub: email, s })}`);
}
