// Google data tokens (Gmail, Google Calendar) for hosted Eden, kept in the account's Durable
// Object (account.js dispatches every `google-*` op here). See src/eden/google-data.js for the
// flow; this file is the storage and the sealing.
//
// - One record per account at `google_data`: { v, gen, iv, ct }. `ct` is AES-256-GCM over the
//   JSON { refresh, access, access_exp, scopes, email, sub, connected } under a key derived
//   (HKDF-SHA-256) from the Worker secret EDEN_TOKEN_KEY and the account id, with the account id
//   as associated data: a record copied to another account, or read without the secret, is
//   useless. The object stores ciphertext only; the Worker seals and opens.
// - `gen` changes on every connect and disconnect, so a refreshed access token saved late
//   (google-touch) never brings back a grant that was just removed or replaced.
// - Tokens never go to a browser: these ops answer the Worker only.
// - Deleting the account revokes the grant at Google first (forgetGoogleOnDelete).

import { ApiError, b64ToBytes, b64url, randomBytes, sameText, sha256Hex, signedOut, validDeviceId } from './util.js';

export const TOKEN_RECORD = 'google_data';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const encoder = new TextEncoder();
const MAX_SEALED = 16 * 1024;

// ── sealing (Worker and Durable Object) ──

const keys = new Map(); // `${account}` → CryptoKey, per isolate (the secret is fixed for its life)

/** EDEN_TOKEN_KEY as bytes: base64 of at least 32 random bytes; null if missing or short. */
export function tokenSecret(env) {
  const raw = String((env && env.EDEN_TOKEN_KEY) || '').trim();
  if (!raw) return null;
  try {
    const bytes = b64ToBytes(raw);
    return bytes.length >= 32 ? bytes : null;
  } catch {
    return null;
  }
}

async function derive(env, info) {
  const secret = tokenSecret(env);
  if (!secret) throw new ApiError(503, 'not_set_up', 'Google on askeden.com is not set up yet.');
  const cacheKey = `${await sha256Hex(secret)}:${info}`;
  if (keys.has(cacheKey)) return keys.get(cacheKey);
  const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('eden-google-data-v1'), info: encoder.encode(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  if (keys.size > 500) keys.delete(keys.keys().next().value);
  keys.set(cacheKey, key);
  return key;
}

/** { iv, ct } (base64url) of `value` as JSON, under `info`'s key with `aad`. */
export async function sealWith(env, info, aad, value) {
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, await derive(env, info), encoder.encode(JSON.stringify(value)));
  return { iv: b64url(iv), ct: b64url(new Uint8Array(ct)) };
}

/** The value sealWith sealed; null when it was tampered with, or sealed under another key. */
export async function openWith(env, info, aad, sealed) {
  if (!sealed || typeof sealed.iv !== 'string' || typeof sealed.ct !== 'string') return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(sealed.iv), additionalData: encoder.encode(aad) }, await derive(env, info), b64ToBytes(sealed.ct));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return null;
  }
}

export const sealTokens = (env, accountId, value) => sealWith(env, `account:${accountId}`, `google:${accountId}`, value);
export const openTokens = (env, accountId, sealed) => openWith(env, `account:${accountId}`, `google:${accountId}`, sealed);

// ── the Account object's ops ──

/**
 * Who may use these ops: a device of this account (its id and secret, as every op), or, for
 * Google's callback (a cross-site redirect: the SameSite=Strict session cookie isn't sent),
 * the browser device the sealed state cookie names, which must still be signed in.
 */
async function caller(account, request, body) {
  if (request.headers.get('x-jarvis-device')) return account.authenticate(request);
  const id = body.device;
  if (!validDeviceId(id)) throw signedOut();
  const device = await account.storage.get(`dev:${id}`);
  if (!device || device.kind !== 'web' || (device.expires && device.expires <= account.now())) throw signedOut();
  return device;
}

function checkSealed(record) {
  if (!record || typeof record.iv !== 'string' || typeof record.ct !== 'string' || record.iv.length > 64 || record.ct.length > MAX_SEALED) {
    throw new ApiError(400, 'bad_request', 'A sealed record is needed.');
  }
  return { iv: record.iv, ct: record.ct };
}

/** account.js: `if (op.startsWith('google-')) return json(await googleOp(this, op, body, request));` */
export async function googleOp(account, op, body, request) {
  await caller(account, request, body);
  const stored = (await account.storage.get(TOKEN_RECORD)) || null;
  switch (op) {
    case 'google-get':
      return { record: stored };
    case 'google-save': {
      // A new grant (connect): a new generation.
      const record = { v: 1, gen: b64url(randomBytes(9)), ...checkSealed(body.record), at: account.now() };
      await account.storage.put(TOKEN_RECORD, record);
      return { gen: record.gen };
    }
    case 'google-touch': {
      // A refreshed access token: only onto the grant it was refreshed from.
      if (!stored || !sameText(stored.gen, String(body.gen || ''))) return { saved: false };
      await account.storage.put(TOKEN_RECORD, { ...stored, ...checkSealed(body.record), at: account.now() });
      return { saved: true };
    }
    case 'google-delete': {
      // Disconnect: gone here at once; the Worker revokes what this returns.
      if (stored) await account.storage.delete(TOKEN_RECORD);
      return { record: stored };
    }
    default:
      throw new ApiError(404, 'not_found', 'No such thing.');
  }
}

/**
 * account.js deleteAll(), before storage.deleteAll(): revokes the account's Google grant, so
 * deleting the Jarvis account also ends Eden's access to the mail and calendar. Never throws.
 */
export async function forgetGoogleOnDelete(account, { fetch: f = (url, init) => fetch(url, init) } = {}) {
  try {
    const stored = await account.storage.get(TOKEN_RECORD);
    if (!stored) return;
    const id = ((await account.storage.get('account')) || {}).id;
    const tokens = id ? await openTokens(account.env, id, stored) : null;
    const token = tokens && (tokens.refresh || tokens.access);
    if (!token) return;
    await f(REVOKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
    });
  } catch {
    // the record goes with the account anyway; the owner can remove Eden at myaccount.google.com
  }
}
