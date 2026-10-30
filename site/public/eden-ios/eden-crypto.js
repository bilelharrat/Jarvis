// Eden's end-to-end encryption (ROADMAP H1, G8; JARVIS V1/docs/accounts.md "Eden sync"): pure
// Web Crypto, no DOM, so the site's tests run the very same code (site/test/eden-sync.test.js).
//
//   - Each browser has its own key pair (X25519 where the browser has it, else ECDH P-256); the
//     private half is made non-extractable and kept in IndexedDB (sync.js).
//   - The account's Eden key (32 random bytes) never reaches askeden.com in the clear: it is
//     sealed to a browser's public key by a device that already has it, or wrapped with the
//     owner's recovery passphrase (PBKDF2-SHA256, 600 000 rounds).
//   - Conversations are sealed with it (AES-256-GCM, a random 12-byte nonce, the item key as
//     associated data), so one item can't be passed off as another. A team space's key works
//     the same way, with its own labels.
//
// Formats (base64 everywhere):
//   item   = nonce(12) ‖ AES-GCM(key, aad = "<label>:<item key>", 0x01 ‖ JSON  |  0x02 ‖ gzip(JSON))
//   sealed = nonce(12) ‖ AES-GCM(HKDF-SHA256(ECDH(sender, recipient), salt = "", info = label), aad = label, secret)
//   wrap   = { v: 1, kdf: "PBKDF2-SHA256", iterations, salt, data: nonce(12) ‖ AES-GCM(KEK, aad = "eden-wrap-v1", secret) }
//   proof  = base64url(HKDF-SHA256(secret, salt = "", info = "<label>-proof", 32 bytes)): what the
//            server keeps a hash of, so only a holder of the key can mark a device as trusted.
//   mac    = base64url(HKDF-SHA256(secret, salt = "", info = "eden-member-v1:<alg>:<public key>", 32 bytes)):
//            a member's public key vouched for by a holder of the key, so a key change seals the
//            new key only to members askeden.com didn't make up.
//   link   = nonce(12) ‖ AES-GCM(HKDF-SHA256(new secret, salt = "", info = "eden-chain-v1"),
//            aad = "eden-chain-v1:<gen>:<new epoch>", old secret): each key change's old key, kept
//            under the new one, so a member with the new key reads what the old one sealed, and a
//            member with the old key checks that the new one was made by a holder of it.

export const SYNC_LABEL = 'eden-sync-v1';
export const MEMBER_LABEL = 'eden-member-v1';
export const CHAIN_LABEL = 'eden-chain-v1';
export const SEAL_LABEL = 'eden-seal-v1';
export const SPACE_LABEL = 'eden-space-v1';
export const SPACE_SEAL_LABEL = 'eden-space-seal-v1';
export const WRAP_LABEL = 'eden-wrap-v1';
export const PBKDF2_ROUNDS = 600_000; // OWASP's figure for PBKDF2-HMAC-SHA256 (Argon2 isn't in Web Crypto)
export const PASSPHRASE_MIN = 12;

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(text) {
  const clean = String(text || '').replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const raw = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
};

/* ---------- device key pairs ---------- */

const ALGS = { x25519: { name: 'X25519' }, p256: { name: 'ECDH', namedCurve: 'P-256' } };
let x25519 = null;

/** Whether this browser's Web Crypto has X25519 (Chrome 133+, Safari 17+, Firefox 130+). */
export async function hasX25519() {
  if (x25519 === null) {
    try { await subtle().generateKey(ALGS.x25519, false, ['deriveBits']); x25519 = true; } catch { x25519 = false; }
  }
  return x25519;
}

/** A new key pair: { alg, privateKey (non-extractable), publicKey, public: base64 raw }. */
export async function deviceKeyPair(alg = null) {
  const use = alg || ((await hasX25519()) ? 'x25519' : 'p256');
  const pair = await subtle().generateKey(ALGS[use], false, ['deriveBits']);
  const raw = new Uint8Array(await subtle().exportKey('raw', pair.publicKey));
  return { alg: use, privateKey: pair.privateKey, publicKey: pair.publicKey, public: b64(raw) };
}

function checkPublic(alg, raw) {
  if (alg === 'x25519' ? raw.length !== 32 : alg === 'p256' ? raw.length !== 65 || raw[0] !== 4 : true) throw new Error('That isn’t a device key.');
}

const importPublic = (alg, raw) => subtle().importKey('raw', raw, ALGS[alg], true, []);

async function hkdfKey(ikm, info, usages) {
  const base = await subtle().importKey('raw', ikm, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(info) }, base, { name: 'AES-GCM', length: 256 }, false, usages);
}

async function shared(alg, privateKey, publicRaw) {
  const bits = await subtle().deriveBits({ name: ALGS[alg].name, public: await importPublic(alg, publicRaw) }, privateKey, 256);
  return new Uint8Array(bits);
}

/** `secret` (bytes) sealed to a device's public key: { sealed_key, sender_key, alg }. */
export async function sealTo(publicB64, alg, secret, label = SEAL_LABEL) {
  const raw = unb64(publicB64);
  checkPublic(alg, raw);
  const sender = await subtle().generateKey(ALGS[alg], false, ['deriveBits']);
  const key = await hkdfKey(await shared(alg, sender.privateKey, raw), label, ['encrypt']);
  const nonce = randomBytes(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce, additionalData: enc.encode(label) }, key, secret));
  return { sealed_key: b64(concat(nonce, ct)), sender_key: b64(new Uint8Array(await subtle().exportKey('raw', sender.publicKey))), alg };
}

/** What sealTo made, opened with this device's private key; throws when it isn't ours. */
export async function openSealed(privateKey, alg, sealedKey, senderKey, label = SEAL_LABEL) {
  const raw = unb64(senderKey);
  checkPublic(alg, raw);
  const box = unb64(sealedKey);
  if (box.length < 12 + 16) throw new Error('The sealed key is unreadable.');
  const key = await hkdfKey(await shared(alg, privateKey, raw), label, ['decrypt']);
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: box.subarray(0, 12), additionalData: enc.encode(label) }, key, box.subarray(12)));
  } catch {
    throw new Error('The sealed key didn’t open with this browser’s key.');
  }
}

/** The six digits both screens show for a device key, so a key swapped in transit is noticed. */
export async function verifyCode(publicB64) {
  const h = new Uint8Array(await subtle().digest('SHA-256', enc.encode(`eden-trust-v1:${publicB64}`)));
  const n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
  const s = String(n % 1_000_000).padStart(6, '0');
  return `${s.slice(0, 3)} ${s.slice(3)}`;
}

/* ---------- the Eden key and items ---------- */

export const newSecret = () => randomBytes(32);

/** 32 secret bytes as a non-extractable AES-GCM key. */
export const itemKey = (secret) => subtle().importKey('raw', secret, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

/** What the server keeps a hash of: only a holder of the key can make it. */
export async function proofOf(secret, label = SYNC_LABEL) {
  const base = await subtle().importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(`${label}-proof`) }, base, 256);
  return b64url(new Uint8Array(bits));
}

/** A member's public key vouched for with the key (what a key change checks before sealing to it). */
export async function memberMac(secret, alg, publicB64) {
  const base = await subtle().importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const bits = await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(`${MEMBER_LABEL}:${alg}:${publicB64}`) }, base, 256);
  return b64url(new Uint8Array(bits));
}

/** The old key kept under the new one, for a key change to `epoch`: base64. */
export async function chainLink(newSecret, oldSecret, gen, epoch) {
  const key = await hkdfKey(newSecret, CHAIN_LABEL, ['encrypt']);
  const nonce = randomBytes(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce, additionalData: enc.encode(`${CHAIN_LABEL}:${gen}:${epoch}`) }, key, oldSecret));
  return b64(concat(nonce, ct));
}

/** The key before `epoch`, from that change's link and the new key; throws when it doesn't open. */
export async function openChainLink(newSecret, link, gen, epoch) {
  const box = unb64(link);
  if (box.length !== 12 + 32 + 16) throw new Error('The key chain is unreadable.');
  const key = await hkdfKey(newSecret, CHAIN_LABEL, ['decrypt']);
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: box.subarray(0, 12), additionalData: enc.encode(`${CHAIN_LABEL}:${gen}:${epoch}`) }, key, box.subarray(12)));
  } catch {
    throw new Error('The key chain doesn’t open with this key.');
  }
}

/**
 * The keys before `epoch` (raw, newest first), each opened from the chain askeden.com keeps
 * ([{ epoch, prev }]: that change's old key under its new one), down to `downTo` (or epoch 1).
 * Stops where a link is missing; throws when one doesn't open.
 */
export async function chainBack(secret, epoch, chain, gen, downTo = 0) {
  const out = [];
  let k = secret;
  for (let e = epoch; e > Math.max(downTo, 1); e--) {
    const link = (chain || []).find((c) => c.epoch === e);
    if (!link) break;
    k = await openChainLink(k, link.prev, gen, e);
    out.push({ epoch: e - 1, secret: k });
  }
  return out;
}

/**
 * A key change sealed to this device (`next`, at `epoch`), checked: the chain from it must lead
 * back to `mine` (the key it has, at `from`), i.e. a holder of `mine` made it, not askeden.com.
 * The keys in between (raw, newest first); throws when it doesn't check out.
 */
export async function followRekey(next, epoch, chain, gen, mine, from) {
  const between = await chainBack(next, epoch, chain, gen, from);
  const last = between[between.length - 1];
  if (!last || last.epoch !== from || !sameBytes(last.secret, mine)) throw new Error('The new key doesn’t follow from this device’s.');
  return between.slice(0, -1);
}

/**
 * A key change, as the device removing `remove` makes it: a new key (`next`), sealed to every
 * other trusted device whose `mac` checks out under `old` (and isn't the removed one under
 * another id), the others dropped; `self` ({ device_id, public, alg }) seals it to itself.
 * `trusted`: GET esync's list. Returns { next, body (POST rotate), mine (this device's envelope), dropped }.
 */
export async function planRotation(old, { gen, epoch, trusted, self, remove }) {
  const next = newSecret();
  const gone = (trusted || []).find((t) => t.device_id === remove);
  const members = [];
  const drop = [];
  const dropped = [];
  let mine = null;
  for (const t of trusted || []) {
    if (t.device_id === remove) continue;
    if (t.device_id === self.device_id) {
      mine = await sealTo(self.public, self.alg, next);
      members.push({ device_id: t.device_id, public_key: self.public, sealed_key: mine.sealed_key, sender_key: mine.sender_key, mac: await memberMac(next, self.alg, self.public) });
      continue;
    }
    let vouched = false;
    try { vouched = Boolean(t.mac) && !(gone && t.public_key === gone.public_key) && t.mac === (await memberMac(old, t.alg, t.public_key)); } catch { /* not a key */ }
    if (!vouched) { drop.push(t.device_id); dropped.push({ device_id: t.device_id, name: t.name || '' }); continue; }
    const s = await sealTo(t.public_key, t.alg, next);
    members.push({ device_id: t.device_id, public_key: t.public_key, sealed_key: s.sealed_key, sender_key: s.sender_key, mac: await memberMac(next, t.alg, t.public_key) });
  }
  if (!mine) throw new Error('This device isn’t listed as syncing.');
  const body = { from_epoch: epoch, proof: await proofOf(old), new_proof: await proofOf(next), prev: await chainLink(next, old, gen, epoch + 1), remove, members, drop };
  return { next, body, mine: { sealed_key: mine.sealed_key, sender_key: mine.sender_key, alg: self.alg }, dropped };
}

/** Same bytes? (Two keys compared without leaving early.) */
export function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function gzip(bytes, how) {
  const stream = new Blob([bytes]).stream().pipeThrough(new globalThis[how]('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const canZip = () => typeof globalThis.CompressionStream === 'function' && typeof globalThis.DecompressionStream === 'function';

/** A JSON value sealed for one item key: base64. */
export async function sealItem(key, name, value, label = SYNC_LABEL) {
  const json = enc.encode(JSON.stringify(value));
  const body = canZip() && json.length > 256 ? concat(Uint8Array.of(2), await gzip(json, 'CompressionStream')) : concat(Uint8Array.of(1), json);
  const nonce = randomBytes(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce, additionalData: enc.encode(`${label}:${name}`) }, key, body));
  return b64(concat(nonce, ct));
}

/**
 * An item opened (its JSON value); throws when the key or the item key is wrong. `key` may be a
 * list (the sync key and those before a key change, newest first): the first that opens it.
 */
export async function openItem(key, name, data, label = SYNC_LABEL) {
  const box = unb64(data);
  if (box.length < 12 + 16 + 1) throw new Error('unreadable');
  let body = null;
  for (const k of Array.isArray(key) ? key : [key]) {
    try {
      body = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: box.subarray(0, 12), additionalData: enc.encode(`${label}:${name}`) }, k, box.subarray(12)));
      break;
    } catch {
      // the next key, if any
    }
  }
  if (!body) throw new Error('wrong key');
  const json = body[0] === 2 ? await gzip(body.subarray(1), 'DecompressionStream') : body[0] === 1 ? body.subarray(1) : null;
  if (!json) throw new Error('unknown format');
  return JSON.parse(dec.decode(json));
}

/* ---------- the recovery passphrase ---------- */

/** Too weak to protect a key askeden.com could try offline? A reason, or '' when it'll do. */
export function passphraseProblem(text) {
  const p = String(text || '');
  if (p.length < PASSPHRASE_MIN) return `Use at least ${PASSPHRASE_MIN} characters (a few unrelated words work well).`;
  if (/^(.)\1+$/.test(p) || new Set(p.toLowerCase()).size < 6) return 'Use more different characters.';
  return '';
}

/** A strong passphrase to suggest: 5 groups of 5 Crockford base32 characters (125 bits). */
export function suggestPassphrase() {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const r = randomBytes(25);
  const chars = [...r].map((b) => ALPHABET[b & 31]).join('');
  return chars.match(/.{5}/g).join('-');
}

async function kek(passphrase, salt, iterations) {
  const base = await subtle().importKey('raw', enc.encode(String(passphrase).normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** `secret` wrapped with a passphrase, for askeden.com to keep. */
export async function wrapWithPassphrase(passphrase, secret, iterations = PBKDF2_ROUNDS) {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = await kek(passphrase, salt, iterations);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce, additionalData: enc.encode(WRAP_LABEL) }, key, secret));
  return { v: 1, kdf: 'PBKDF2-SHA256', iterations, salt: b64(salt), data: b64(concat(nonce, ct)) };
}

/** The secret back from a wrap; throws 'wrong passphrase'. */
export async function unwrapWithPassphrase(passphrase, wrap) {
  if (!wrap || wrap.v !== 1 || wrap.kdf !== 'PBKDF2-SHA256') throw new Error('unknown wrap');
  const iterations = Number(wrap.iterations);
  if (!(iterations >= 100_000 && iterations <= 10_000_000)) throw new Error('unknown wrap');
  const box = unb64(wrap.data);
  const key = await kek(passphrase, unb64(wrap.salt), iterations);
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: box.subarray(0, 12), additionalData: enc.encode(WRAP_LABEL) }, key, box.subarray(12)));
  } catch {
    throw new Error('wrong passphrase');
  }
}

/** SHA-256 hex of a string (what changed since the last sync, without keeping the text twice). */
export async function digest(text) {
  const h = new Uint8Array(await subtle().digest('SHA-256', enc.encode(text)));
  return [...h.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
