// Google's OAuth 2.0 / OpenID Connect, for Sign in with Google at askeden.com (eden/session.js)
// and, later, Gmail and Calendar consent with the same client (src/eden/google-data.js).
//
// Stable exports (other modules build on these; keep their shapes):
//
//   googleReady(env)                 true when GOOGLE_CLIENT_ID (var) and GOOGLE_CLIENT_SECRET (secret) are set
//   SIGN_IN_SCOPES                   ['openid', 'email', 'profile']: all sign-in ever asks for
//   pkcePair()                       → { verifier, challenge }  (S256; the verifier stays on the server side)
//   buildAuthUrl(env, { redirectUri, state, nonce, challenge, scopes?, prompt?, includeGrantedScopes?,
//                       accessType?, loginHint? })  → the https://accounts.google.com/o/oauth2/v2/auth URL
//   exchangeCode(env, { code, verifier, redirectUri }, fetcher?)
//                                    → Google's token answer { id_token, access_token, expires_in, scope,
//                                       refresh_token? }; throws ApiError 401 google_refused
//   verifyIdToken(idToken, { audience, nonce, now?, fetcher? })
//                                    → the verified claims { sub, email, email_verified, name?, ... }
//   forgetGoogleKeys()               (tests)
//
// Asking for Gmail or Calendar later: buildAuthUrl with scopes [...those], includeGrantedScopes
// true (the default), accessType 'offline' and prompt 'consent' for a refresh token, a fresh
// state, nonce and PKCE pair of its own, and its own redirect URI registered on the same client.

import { ApiError, b64ToBytes, b64url, randomBytes, sameText, sha256 } from '../accounts/util.js';

export const SIGN_IN_SCOPES = ['openid', 'email', 'profile'];
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const KEYS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const SKEW = 300; // seconds of clock difference forgiven
const KEYS_MAX_MS = 3600_000; // keys kept at most an hour (less when Google says so)
const REFETCH_MS = 60_000; // an unknown kid refetches the keys at most once a minute

export const googleReady = (env) =>
  /^[\w.-]+\.apps\.googleusercontent\.com$/.test(String(env.GOOGLE_CLIENT_ID || '')) && Boolean(env.GOOGLE_CLIENT_SECRET);

export async function pkcePair() {
  const verifier = b64url(randomBytes(32)); // 43 characters of [A-Za-z0-9_-]
  return { verifier, challenge: b64url(await sha256(verifier)) };
}

export function buildAuthUrl(env, { redirectUri, state, nonce, challenge, scopes = SIGN_IN_SCOPES, prompt = 'select_account', includeGrantedScopes = true, accessType = 'online', loginHint = '' }) {
  const params = {
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    access_type: accessType,
  };
  if (prompt) params.prompt = prompt;
  if (includeGrantedScopes) params.include_granted_scopes = 'true';
  if (loginHint) params.login_hint = loginHint;
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

const refused = (why) => new ApiError(401, 'google_refused', `Google's sign-in didn't check out (${why}). Try again.`);

export async function exchangeCode(env, { code, verifier, redirectUri }, fetcher = fetch) {
  if (!code || typeof code !== 'string' || code.length > 2048) throw refused('no code');
  let response;
  try {
    response = await fetcher(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
        code_verifier: verifier,
      }).toString(),
    });
  } catch {
    throw new ApiError(503, 'google_unreachable', "Google can't be reached right now. Try again in a minute.");
  }
  const answer = await response.json().catch(() => ({}));
  if (!response.ok || typeof answer.id_token !== 'string') throw refused(answer.error ? String(answer.error).slice(0, 40) : `token ${response.status}`);
  return answer;
}

// ── Google's signing keys ──

let cachedKeys = null; // { until, keys }
let lastForced = 0; // when an unknown kid last made the keys be read again

export function forgetGoogleKeys() {
  cachedKeys = null;
  lastForced = 0;
}

async function googleKeys(fetcher, { force = false } = {}) {
  const now = Date.now();
  if (cachedKeys && !force && now < cachedKeys.until) return cachedKeys.keys;
  if (force && cachedKeys && now - lastForced < REFETCH_MS) return cachedKeys.keys;
  if (force) lastForced = now;
  const response = await fetcher(KEYS_URL, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!response.ok) throw new ApiError(503, 'google_unreachable', "Google's sign-in keys can't be read right now. Try again in a minute.");
  const { keys } = await response.json();
  const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') || '')?.[1]) * 1000;
  cachedKeys = { until: now + Math.min(KEYS_MAX_MS, maxAge > 0 ? maxAge : KEYS_MAX_MS), keys: Array.isArray(keys) ? keys : [] };
  return cachedKeys.keys;
}

const decodePart = (part) => JSON.parse(new TextDecoder().decode(b64ToBytes(part)));

export async function verifyIdToken(idToken, { audience, nonce, now = Date.now() / 1000, fetcher = fetch } = {}) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw refused('not a token');
  let header, claims;
  try {
    header = decodePart(parts[0]);
    claims = decodePart(parts[1]);
  } catch {
    throw refused('unreadable');
  }
  if (header.alg !== 'RS256') throw refused('algorithm');
  let jwk = (await googleKeys(fetcher)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await googleKeys(fetcher, { force: true })).find((k) => k.kid === header.kid); // Google rotated its keys
  if (!jwk) throw refused('unknown key');
  const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64ToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw refused('signature');
  if (!ISSUERS.includes(claims.iss)) throw refused('issuer');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience || !audiences.includes(audience)) throw refused('audience');
  if (audiences.length > 1 && claims.azp !== audience) throw refused('audience');
  if (!(Number(claims.exp) + SKEW > now)) throw refused('expired');
  if (Number(claims.iat) - SKEW > now) throw refused('issued in the future');
  if (typeof claims.sub !== 'string' || !/^[\w-]{1,255}$/.test(claims.sub)) throw refused('no user');
  if (!nonce || typeof claims.nonce !== 'string' || !sameText(claims.nonce, nonce)) throw refused('nonce');
  if (claims.email_verified !== true && claims.email_verified !== 'true') throw new ApiError(401, 'google_email', "Google didn't share a verified email address for that account.");
  return claims;
}
