// Small pieces every part of the accounts API uses: JSON answers and errors in the
// contract's shape (docs/accounts.md), base64 and hex, hashes, and device tokens.

export const BUNDLE_ID = 'com.askeden.jarvis';
export const PLUS_PRODUCTS = ['com.askeden.jarvis.plus.monthly', 'com.askeden.jarvis.plus.yearly'];
// The Apple Developer team the apps are signed by (wrangler.toml's APPLE_TEAM_ID overrides it).
export const TEAM_ID = '8CV4X23Y2T';

const encoder = new TextEncoder();

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

// What every refusal looks like: words for a person, and a code for the app.
export function fail(status, code, error, headers = {}) {
  return json({ error, code }, status, headers);
}

export class ApiError extends Error {
  constructor(status, code, message, headers = {}, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
    this.extra = extra;
  }

  response() {
    return json({ error: this.message, code: this.code, ...this.extra }, this.status, this.headers);
  }
}

export const signedOut = () => new ApiError(401, 'signed_out', 'This device is signed out of its Jarvis account.');

export async function readJson(request, cap = 1 << 20) {
  const text = await request.text();
  if (text.length > cap) throw new ApiError(413, 'too_big', 'That request is too big.');
  try {
    const value = JSON.parse(text || '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // below
  }
  throw new ApiError(400, 'bad_request', 'Send JSON.');
}

export function bytesToB64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

export function b64ToBytes(text) {
  const clean = String(text).replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  const raw = atob(clean + '='.repeat((4 - (clean.length % 4)) % 4));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export const b64url = (bytes) => bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const b64urlText = (text) => b64url(encoder.encode(text));

export function hex(bytes) {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? encoder.encode(data) : data));
}

export const sha256Hex = async (data) => hex(await sha256(data));

export function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

// The same bytes, compared without leaking where they differ first.
export function sameText(a, b) {
  a = String(a);
  b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// The account id for an Apple user: a UUID made from the SHA-256 of their Apple id, with
// the version nibble 8 and the RFC 4122 variant. It is also StoreKit's appAccountToken.
export async function accountIdFor(sub) {
  const bytes = (await sha256(`jarvis-account-v1:${sub}`)).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = hex(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DEVICE = /^[0-9a-f]{16}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

export const validAccountId = (id) => UUID.test(String(id));
export const validDeviceId = (id) => DEVICE.test(String(id));

// "jv1.<account>.<device>.<secret>", from Authorization: Bearer or x-api-key; null if absent
// or malformed.
export function parseToken(text) {
  const parts = String(text || '').trim().split('.');
  if (parts.length !== 4 || parts[0] !== 'jv1') return null;
  const [, account, device, secret] = parts;
  if (!UUID.test(account) || !DEVICE.test(device) || !SECRET.test(secret)) return null;
  return { account, device, secret };
}

export function tokenFrom(request, { apiKey = false } = {}) {
  const auth = request.headers.get('authorization') || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(auth);
  if (bearer) return parseToken(bearer[1]);
  if (apiKey) return parseToken(request.headers.get('x-api-key'));
  return null;
}

export function newDevice() {
  return { id: hex(randomBytes(8)), secret: b64url(randomBytes(32)) };
}

export const makeToken = (account, device, secret) => `jv1.${account}.${device}.${secret}`;

// `web` is a browser signed in at askeden.com (Eden): made only by the web sign-in, and
// restricted (account.js WEB_FORBIDDEN). Anything unknown is an iPhone, as before.
const DEVICE_KINDS = new Set(['iphone', 'ipad', 'watch', 'mac', 'web']);
export const deviceKind = (kind) => (DEVICE_KINDS.has(kind) ? kind : 'iphone');
// The apps' own devices: the ones that may approve a Mac's link.
export const isPhone = (kind) => kind !== 'mac' && kind !== 'web';

// Which accounts may sign in to Eden on the web: the Worker var EDEN_ACCOUNTS (account ids,
// separated by commas or spaces), or every account when it's empty.
export function webAllowed(env, accountId) {
  const list = String(env.EDEN_ACCOUNTS || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
  return !list.length || list.includes(String(accountId).toLowerCase());
}

export function cleanName(name, fallback) {
  const text = typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) : '';
  return text || fallback;
}

export function cleanVersion(version) {
  return typeof version === 'string' ? version.replace(/[^\w .()+-]/g, '').slice(0, 40) : '';
}

// DER ECDSA signature (SEQUENCE { r INTEGER, s INTEGER }) as WebCrypto's raw r‖s, and back.
export function derToRaw(der, size) {
  let i = 2;
  if (der[1] & 0x80) i += der[1] & 0x7f;
  const read = () => {
    if (der[i] !== 0x02) throw new Error('not a DER signature');
    const len = der[i + 1];
    let value = der.subarray(i + 2, i + 2 + len);
    i += 2 + len;
    while (value.length > size && value[0] === 0) value = value.subarray(1);
    const out = new Uint8Array(size);
    out.set(value, size - value.length);
    return out;
  };
  const r = read();
  const s = read();
  const raw = new Uint8Array(size * 2);
  raw.set(r, 0);
  raw.set(s, size);
  return raw;
}
