// Passkeys (WebAuthn) for signing in to Eden on the web (docs/web-auth.md "Passkeys"): the
// verification half, with no library. What the browser sends is checked here against what
// the server issued (session.js keeps each challenge server-side, single use, five minutes).
//
//   verifyRegistration({ credential, challenge, origin, rpId }) → { id, alg, jwk, count }
//   verifyAssertion({ credential, challenge, origin, rpId, stored: { alg, jwk, count } }) → { count }
//
// Both throw ApiError(400, 'passkey', …) on anything wrong. Checked: clientDataJSON's type,
// challenge and origin (no cross-origin frames); authenticatorData's rpIdHash (SHA-256 of the
// RP ID, the request's own host), User Present and User Verified flags; registration's
// attestation format "none" (we ask for none, so the browser strips any other) and its
// credential id; the public key's algorithm (ES256 on P-256, or RS256); an assertion's
// signature over authenticatorData ‖ SHA-256(clientDataJSON); and signCount, which must go up
// whenever the authenticator counts at all (a cloned key shows as a count that didn't).
//
// The CBOR here is the subset WebAuthn uses (unsigned and negative integers, byte and text
// strings, arrays, maps, true/false/null), definite lengths only.

import { ApiError, b64ToBytes, b64url, derToRaw, sha256 } from './util.js';

export const ES256 = -7;
export const RS256 = -257;
export const ALGS = [ES256, RS256];
const UP = 0x01;
const UV = 0x04;
const AT = 0x40;
const ED = 0x80;

const refuse = (words) => new ApiError(400, 'passkey', words);

// ── CBOR ──

/** One CBOR item at `at`: { value, end }. Maps become Map (their keys may be numbers). */
export function decodeCbor(bytes, at = 0, depth = 0) {
  if (depth > 16) throw refuse('That passkey answer is nested too deeply.');
  const need = (n) => {
    if (at + n > bytes.length) throw refuse('That passkey answer is cut short.');
  };
  need(1);
  const head = bytes[at++];
  const major = head >> 5;
  const info = head & 0x1f;
  let n;
  if (info < 24) n = info;
  else if (info === 24) (need(1), (n = bytes[at]), (at += 1));
  else if (info === 25) (need(2), (n = (bytes[at] << 8) | bytes[at + 1]), (at += 2));
  else if (info === 26) (need(4), (n = ((bytes[at] << 24) >>> 0) + (bytes[at + 1] << 16) + (bytes[at + 2] << 8) + bytes[at + 3]), (at += 4));
  else throw refuse('That passkey answer uses CBOR this server doesn’t read.');
  if (major === 0) return { value: n, end: at };
  if (major === 1) return { value: -1 - n, end: at };
  if (major === 2 || major === 3) {
    need(n);
    const slice = bytes.subarray(at, at + n);
    return { value: major === 2 ? slice : new TextDecoder('utf-8', { fatal: true }).decode(slice), end: at + n };
  }
  if (major === 4) {
    const list = [];
    for (let i = 0; i < n; i++) {
      const item = decodeCbor(bytes, at, depth + 1);
      list.push(item.value);
      at = item.end;
    }
    return { value: list, end: at };
  }
  if (major === 5) {
    const map = new Map();
    for (let i = 0; i < n; i++) {
      const k = decodeCbor(bytes, at, depth + 1);
      const v = decodeCbor(bytes, k.end, depth + 1);
      map.set(k.value, v.value);
      at = v.end;
    }
    return { value: map, end: at };
  }
  if (major === 7 && info === 20) return { value: false, end: at };
  if (major === 7 && info === 21) return { value: true, end: at };
  if (major === 7 && info === 22) return { value: null, end: at };
  throw refuse('That passkey answer uses CBOR this server doesn’t read.');
}

// ── COSE keys → JWK (what WebCrypto imports) ──

/** A COSE_Key (Map) as { alg, jwk }: ES256 (EC2, P-256) or RS256 (RSA). */
export function coseToJwk(cose) {
  if (!(cose instanceof Map)) throw refuse('That passkey has no public key.');
  const kty = cose.get(1);
  const alg = cose.get(3);
  const bytes = (v) => v instanceof Uint8Array;
  if (alg === ES256 && kty === 2 && cose.get(-1) === 1 && bytes(cose.get(-2)) && bytes(cose.get(-3)) && cose.get(-2).length === 32 && cose.get(-3).length === 32) {
    return { alg, jwk: { kty: 'EC', crv: 'P-256', x: b64url(cose.get(-2)), y: b64url(cose.get(-3)) } };
  }
  if (alg === RS256 && kty === 3 && bytes(cose.get(-1)) && bytes(cose.get(-2)) && cose.get(-1).length >= 256) {
    return { alg, jwk: { kty: 'RSA', n: b64url(cose.get(-1)), e: b64url(cose.get(-2)) } };
  }
  throw refuse('That passkey uses a key type Eden doesn’t take (ES256 or RS256 only).');
}

// ── authenticatorData ──

/** { rpIdHash, flags, count, credentialId?, cose? } from authenticatorData's bytes. */
export function parseAuthData(data) {
  if (!(data instanceof Uint8Array) || data.length < 37) throw refuse('That passkey answer is cut short.');
  const flags = data[32];
  const out = { rpIdHash: data.subarray(0, 32), flags, count: ((data[33] << 24) >>> 0) + (data[34] << 16) + (data[35] << 8) + data[36] };
  let at = 37;
  if (flags & AT) {
    if (data.length < at + 18) throw refuse('That passkey answer is cut short.');
    const len = (data[at + 16] << 8) | data[at + 17];
    at += 18;
    if (len < 16 || len > 1023 || data.length < at + len) throw refuse('That passkey’s id is the wrong size.');
    out.credentialId = data.subarray(at, at + len);
    at += len;
    const key = decodeCbor(data, at);
    out.cose = key.value;
    at = key.end;
  }
  if (flags & ED) at = decodeCbor(data, at).end; // extensions: read past, not used
  if (at !== data.length) throw refuse('That passkey answer has bytes left over.');
  return out;
}

// ── the checks both ceremonies share ──

const bytesOf = (v, what) => {
  try {
    if (typeof v !== 'string' || !v || v.length > 16_384) throw new Error();
    return b64ToBytes(v);
  } catch {
    throw refuse(`That passkey answer has no ${what}.`);
  }
};

const same = (a, b) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
};

function checkClient(raw, { type, challenge, origin }) {
  let client;
  try {
    client = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    throw refuse('That passkey answer can’t be read.');
  }
  if (!client || client.type !== type) throw refuse('That passkey answer is for something else.');
  if (typeof client.challenge !== 'string' || client.challenge !== challenge) throw refuse('That passkey answer is for another sign-in. Try again.');
  if (client.origin !== origin) throw refuse('That passkey answer came from another site.');
  if (client.crossOrigin === true) throw refuse('Passkeys can’t be used from inside another site’s frame.');
  return client;
}

async function checkAuth(auth, rpId) {
  if (!same(auth.rpIdHash, await sha256(rpId))) throw refuse('That passkey belongs to another site.');
  if (!(auth.flags & UP)) throw refuse('The passkey didn’t confirm you were there.');
  if (!(auth.flags & UV)) throw refuse('The passkey didn’t verify you (Face ID, Touch ID or your device’s PIN). Try again.');
}

const response = (credential) => {
  if (!credential || typeof credential !== 'object' || credential.type !== 'public-key' || !credential.response || typeof credential.response !== 'object') {
    throw refuse('That isn’t a passkey answer.');
  }
  return credential.response;
};

/** A new passkey (navigator.credentials.create), checked: { id (base64url), alg, jwk, count }. */
export async function verifyRegistration({ credential, challenge, origin, rpId }) {
  const r = response(credential);
  checkClient(bytesOf(r.clientDataJSON, 'client data'), { type: 'webauthn.create', challenge, origin });
  const att = decodeCbor(bytesOf(r.attestationObject, 'attestation'));
  if (att.end !== bytesOf(r.attestationObject, 'attestation').length || !(att.value instanceof Map)) throw refuse('That passkey answer can’t be read.');
  const fmt = att.value.get('fmt');
  const stmt = att.value.get('attStmt');
  if (fmt !== 'none' || !(stmt instanceof Map) || stmt.size !== 0) throw refuse('Eden asks passkeys for no attestation; this one sent some.');
  const auth = parseAuthData(att.value.get('authData'));
  await checkAuth(auth, rpId);
  if (!auth.credentialId || !auth.cose) throw refuse('That passkey answer has no key in it.');
  const id = b64url(auth.credentialId);
  if (id !== String(credential.rawId || credential.id || '').replace(/=+$/, '')) throw refuse('That passkey’s id doesn’t match its key.');
  const { alg, jwk } = coseToJwk(auth.cose);
  await importKey(alg, jwk); // a key WebCrypto won't take is refused now, not at the first sign-in
  return { id, alg, jwk, count: auth.count };
}

async function importKey(alg, jwk) {
  try {
    if (alg === ES256) return await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    if (alg === RS256) return await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  } catch {
    // below
  }
  throw refuse('That passkey’s public key can’t be used.');
}

/** A sign-in with a stored passkey (navigator.credentials.get), checked: { count } to keep. */
export async function verifyAssertion({ credential, challenge, origin, rpId, stored }) {
  const r = response(credential);
  const clientRaw = bytesOf(r.clientDataJSON, 'client data');
  checkClient(clientRaw, { type: 'webauthn.get', challenge, origin });
  const authRaw = bytesOf(r.authenticatorData, 'authenticator data');
  const auth = parseAuthData(authRaw);
  await checkAuth(auth, rpId);
  const signed = new Uint8Array(authRaw.length + 32);
  signed.set(authRaw, 0);
  signed.set(await sha256(clientRaw), authRaw.length);
  let sig = bytesOf(r.signature, 'signature');
  const key = await importKey(stored.alg, stored.jwk);
  let ok = false;
  try {
    if (stored.alg === ES256) {
      sig = derToRaw(sig, 32);
      ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, sig, signed);
    } else ok = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, sig, signed);
  } catch {
    ok = false;
  }
  if (!ok) throw refuse('That passkey’s signature doesn’t check out.');
  // A counter that didn't go up (when either side counts) is a copied authenticator.
  const before = Number(stored.count) || 0;
  if ((auth.count !== 0 || before !== 0) && auth.count <= before) throw refuse('This passkey looks copied (its counter went backwards). Sign in another way.');
  return { count: auth.count };
}
