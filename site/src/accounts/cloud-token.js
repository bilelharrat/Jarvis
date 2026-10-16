// Eden Cloud tokens (docs/accounts.md, "Eden Cloud"): what a linked Mac trades its device token
// for, to start hosted Eden Code runs on the Eden Cloud service (JARVIS V1/cloud/). The device
// token is the whole account and only ever comes here; Eden Cloud gets a token for itself
// alone, good for ten minutes, that it checks with askeden.com's public key (no call back).
//
// A compact JWS, EdDSA (Ed25519), signed with EDEN_CLOUD_SIGNING_KEY (a Worker secret: the
// private key, PKCS#8, base64). Claims: iss askeden.com, aud eden-cloud, sub the account, dev
// the device, kind "mac" (only a Mac gets one: Eden Code runs start there), plan "plus" or
// "free" (Eden Cloud decides what each may do), iat, exp, jti. Nothing else of the account.

import { ApiError, b64ToBytes, b64url, b64urlText, hex, randomBytes } from './util.js';

export const CLOUD_TOKEN_SECONDS = 600;
export const CLOUD_AUDIENCE = 'eden-cloud';

let cached = null; // { text, key }: the imported signing key, kept while the secret is the same

async function signingKey(env) {
  const text = String(env.EDEN_CLOUD_SIGNING_KEY || '').trim();
  if (!text) throw new ApiError(503, 'not_set_up', 'Eden Cloud isn’t set up on askeden.com yet.');
  if (cached && cached.text === text) return cached.key;
  let key;
  try {
    key = await crypto.subtle.importKey('pkcs8', b64ToBytes(text), { name: 'Ed25519' }, false, ['sign']);
  } catch {
    throw new ApiError(503, 'not_set_up', 'Eden Cloud’s signing key on askeden.com can’t be read.');
  }
  cached = { text, key };
  return key;
}

/** The token for this account's calling device ({ token, expires_in, plan }), or why not. */
export async function mintCloudToken(env, account, now = Date.now()) {
  const device = (account.devices || []).find((d) => d.this);
  if (!device || device.kind !== 'mac') {
    throw new ApiError(403, 'forbidden', 'Eden Cloud runs start from Eden Code on a Mac linked to this account.');
  }
  const key = await signingKey(env);
  const plan = account.plan && account.plan.active && account.plan.name === 'plus' ? 'plus' : 'free';
  const iat = Math.floor(now / 1000);
  const claims = {
    iss: String(env.EDEN_CLOUD_ISSUER || 'askeden.com'),
    aud: CLOUD_AUDIENCE,
    sub: account.id,
    dev: device.id,
    kind: 'mac',
    plan,
    iat,
    exp: iat + CLOUD_TOKEN_SECONDS,
    jti: hex(randomBytes(8)),
  };
  const head = b64urlText(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));
  const body = b64urlText(JSON.stringify(claims));
  const signature = await crypto.subtle.sign({ name: 'Ed25519' }, key, new TextEncoder().encode(`${head}.${body}`));
  return { token: `${head}.${body}.${b64url(new Uint8Array(signature))}`, expires_in: CLOUD_TOKEN_SECONDS, plan };
}
