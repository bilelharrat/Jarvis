// Cloudflare Turnstile on sign-up (docs/web-auth.md "Turnstile"): a new Eden account made on the
// web (a first Apple or Google sign-in, a passkey sign-up) needs a passed check from /signin.
//
//   TURNSTILE_SITE_KEY   [vars]: the widget's site key (public; /api/web/config hands it to the page)
//   TURNSTILE_SECRET     secret (npx wrangler secret put TURNSTILE_SECRET): siteverify's key
//
// Either missing: no check at all (preview and local dev keep working), said once per isolate in
// the log. The token is checked once, server-side, with siteverify and the visitor's IP.

import { ApiError } from './util.js';

export const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const HUMAN_SECONDS = 600; // a passed check stays good for this sign-in attempt's ten minutes

let warned = false;

/** Whether sign-ups are checked here. */
export const turnstileOn = (env) => Boolean(String(env.TURNSTILE_SITE_KEY || '').trim() && String(env.TURNSTILE_SECRET || '').trim());

/** The site key for the page, or null when the check is off. */
export const turnstileSiteKey = (env) => (turnstileOn(env) ? String(env.TURNSTILE_SITE_KEY).trim() : null);

/** Forgets the "off" note (tests). */
export const forgetTurnstileNote = () => {
  warned = false;
};

const refuse = () => new ApiError(403, 'turnstile', 'Finish the check on the sign-in page (it confirms you’re a person), then try again.');

/**
 * Checks a Turnstile token with siteverify; throws 403 `turnstile` unless it passed. With the
 * check off, passes (logged once). `f`: fetch (tests).
 */
export async function checkHuman(env, token, ip, { fetch: f = (u, i) => fetch(u, i) } = {}) {
  if (!turnstileOn(env)) {
    if (!warned) {
      warned = true;
      console.log('Turnstile is off (TURNSTILE_SITE_KEY or TURNSTILE_SECRET not set): sign-ups are not checked for a person.');
    }
    return true;
  }
  if (typeof token !== 'string' || !token || token.length > 2048) throw refuse();
  const form = new URLSearchParams({ secret: String(env.TURNSTILE_SECRET).trim(), response: token });
  if (ip && ip !== 'unknown') form.set('remoteip', ip);
  let body = null;
  try {
    const res = await f(SITEVERIFY, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    body = await res.json().catch(() => null);
  } catch {
    throw new ApiError(503, 'turnstile_down', 'The person check couldn’t be reached. Try again in a moment.');
  }
  if (!body || body.success !== true) throw refuse();
  return true;
}
