// Sign in with Apple: the identity token the iPhone got from Apple, checked here (Apple's
// signature, issuer, audience, expiry and the nonce), and, when the owner has given the
// Worker a Sign in with Apple key, the grant kept so deleting the account can revoke it.

import { ApiError, BUNDLE_ID, TEAM_ID, b64ToBytes, b64url, b64urlText, sameText, sha256Hex } from './util.js';

const ISSUER = 'https://appleid.apple.com';
const KEYS_URL = 'https://appleid.apple.com/auth/keys';
const SKEW = 300; // seconds of clock difference forgiven
// The Eden iOS app: its identity tokens are accepted only by POST /api/web/native/apple
// (eden/session.js), which passes this as `audience`; everything else keeps BUNDLE_ID.
export const EDEN_APP_ID = 'com.askeden.eden';

let cachedKeys = null; // { at, keys }
let lastForced = 0; // when an unknown kid last made the keys be read again
const REFETCH_MS = 60_000; // at most once a minute, so junk tokens can't make the Worker hammer Apple

async function appleKeys(fetcher = fetch) {
  if (cachedKeys && Date.now() - cachedKeys.at < 3600_000) return cachedKeys.keys;
  const response = await fetcher(KEYS_URL, { cf: { cacheTtl: 3600, cacheEverything: true } });
  if (!response.ok) throw new ApiError(503, 'not_set_up', "Apple's sign-in keys can't be read right now. Try again in a minute.");
  const { keys } = await response.json();
  cachedKeys = { at: Date.now(), keys: Array.isArray(keys) ? keys : [] };
  return cachedKeys.keys;
}

export function forgetAppleKeys() {
  cachedKeys = null;
  lastForced = 0;
}

function decodePart(part) {
  return JSON.parse(new TextDecoder().decode(b64ToBytes(part)));
}

const refused = (why) => new ApiError(401, 'apple_refused', `Apple's sign-in didn't check out (${why}). Try again.`);

// The token's claims once everything checks; throws otherwise.
export async function verifyIdentityToken(token, rawNonce, { audience = BUNDLE_ID, now = Date.now() / 1000, fetcher = fetch } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw refused('not a token');
  let header, claims;
  try {
    header = decodePart(parts[0]);
    claims = decodePart(parts[1]);
  } catch {
    throw refused('unreadable');
  }
  if (header.alg !== 'RS256') throw refused('algorithm');
  let jwk = (await appleKeys(fetcher)).find((k) => k.kid === header.kid);
  if (!jwk && Date.now() - lastForced >= REFETCH_MS) {
    // Apple may have rotated its keys since they were read
    lastForced = Date.now();
    cachedKeys = null;
    jwk = (await appleKeys(fetcher)).find((k) => k.kid === header.kid);
  }
  if (!jwk) throw refused('unknown key');
  const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64ToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw refused('signature');
  if (claims.iss !== ISSUER) throw refused('issuer');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) throw refused('audience');
  if (!(Number(claims.exp) + SKEW > now)) throw refused('expired');
  if (typeof claims.sub !== 'string' || !claims.sub) throw refused('no user');
  if (!rawNonce || typeof claims.nonce !== 'string' || !sameText(claims.nonce, await sha256Hex(String(rawNonce)))) throw refused('nonce');
  return claims;
}

// ── the grant, for revoking it when the account is deleted (only with SIWA_KEY set) ──

async function clientSecret(env, now = Math.floor(Date.now() / 1000)) {
  const pem = String(env.SIWA_KEY).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', b64ToBytes(pem), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64urlText(JSON.stringify({ alg: 'ES256', kid: env.SIWA_KEY_ID }));
  const body = b64urlText(JSON.stringify({ iss: env.APPLE_TEAM_ID || TEAM_ID, iat: now, exp: now + 3000, aud: ISSUER, sub: BUNDLE_ID }));
  // WebCrypto signs ECDSA as raw r‖s, which is what a JWT wants.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

const canRevoke = (env) => Boolean(env.SIWA_KEY && env.SIWA_KEY_ID);

// The refresh token for an authorization code, or null (no key, or Apple said no).
export async function exchangeCode(env, code, fetcher = fetch) {
  if (!canRevoke(env) || !code) return null;
  try {
    const response = await fetcher(`${ISSUER}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: BUNDLE_ID, client_secret: await clientSecret(env), code, grant_type: 'authorization_code' }),
    });
    if (!response.ok) return null;
    return (await response.json()).refresh_token || null;
  } catch {
    return null;
  }
}

export async function revoke(env, refreshToken, fetcher = fetch) {
  if (!canRevoke(env) || !refreshToken) return false;
  try {
    const response = await fetcher(`${ISSUER}/auth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: BUNDLE_ID, client_secret: await clientSecret(env), token: refreshToken, token_type_hint: 'refresh_token' }),
    });
    return response.ok;
  } catch {
    return false;
  }
}
