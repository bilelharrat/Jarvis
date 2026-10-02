// StoreKit 2's signed transactions and App Store Server Notifications V2: JWS whose
// header carries a certificate chain (x5c). Checked here without Apple's server: the chain
// must end at Apple Root CA – G3 (pinned by fingerprint), each certificate must be signed by
// the next and be in date, the intermediate and the leaf must carry Apple's marker
// extensions, and the JWS must be signed by the leaf.

import { ApiError, b64ToBytes, derToRaw, sha256Hex } from './util.js';

// SHA-256 of Apple Root CA – G3's DER bytes (as macOS's SystemRootCertificates has it).
export const APPLE_ROOT_G3 = '63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179';
const LEAF_MARKER = '1.2.840.113635.100.6.11.1'; // Mac App Store Receipt Signing
const INTERMEDIATE_MARKER = '1.2.840.113635.100.6.2.1'; // Apple Worldwide Developer Relations

const CURVES = { '1.2.840.10045.3.1.7': { name: 'P-256', size: 32 }, '1.3.132.0.34': { name: 'P-384', size: 48 } };
const HASHES = { '1.2.840.10045.4.3.2': 'SHA-256', '1.2.840.10045.4.3.3': 'SHA-384' };

// ── a little DER: enough to take a certificate apart ──

function readTlv(bytes, at) {
  const tag = bytes[at];
  let len = bytes[at + 1];
  let head = 2;
  if (len & 0x80) {
    const count = len & 0x7f;
    if (count < 1 || count > 4) throw new Error('bad DER length');
    len = 0;
    for (let i = 0; i < count; i++) len = len * 256 + bytes[at + 2 + i];
    head += count;
  }
  const end = at + head + len;
  if (end > bytes.length) throw new Error('DER runs past its end');
  return { tag, start: at, body: at + head, end };
}

function children(bytes, node) {
  const out = [];
  for (let at = node.body; at < node.end;) {
    const child = readTlv(bytes, at);
    out.push(child);
    at = child.end;
  }
  return out;
}

function oid(bytes, node) {
  const body = bytes.subarray(node.body, node.end);
  const parts = [Math.floor(body[0] / 40), body[0] % 40];
  let value = 0;
  for (let i = 1; i < body.length; i++) {
    value = value * 128 + (body[i] & 0x7f);
    if (!(body[i] & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join('.');
}

function time(bytes, node) {
  const text = new TextDecoder().decode(bytes.subarray(node.body, node.end));
  const m = node.tag === 0x17
    ? /^(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(text)
    : /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z$/.exec(text);
  if (!m) throw new Error('bad certificate time');
  let year = Number(m[1]);
  if (node.tag === 0x17) year += year < 50 ? 2000 : 1900;
  return Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}

export function parseCertificate(der) {
  const cert = readTlv(der, 0);
  const [tbs, sigAlg, sigValue] = children(der, cert);
  let fields = children(der, tbs);
  if (fields[0].tag === 0xa0) fields = fields.slice(1); // an explicit version
  const [, , , validity, , spki] = fields;
  const [notBefore, notAfter] = children(der, validity);
  const [keyAlg] = children(der, spki);
  const [, curve] = children(der, keyAlg);
  const extensions = new Set();
  const extWrapper = fields.find((f) => f.tag === 0xa3);
  if (extWrapper) {
    for (const ext of children(der, children(der, extWrapper)[0])) extensions.add(oid(der, children(der, ext)[0]));
  }
  return {
    tbs: der.subarray(tbs.start, tbs.end),
    hash: HASHES[oid(der, children(der, sigAlg)[0])],
    signature: der.subarray(sigValue.body + 1, sigValue.end), // past the BIT STRING's unused-bits byte
    spki: der.subarray(spki.start, spki.end),
    curve: CURVES[oid(der, curve)],
    notBefore: time(der, notBefore),
    notAfter: time(der, notAfter),
    extensions,
  };
}

async function publicKey(cert) {
  if (!cert.curve) throw new Error('not an EC key');
  return crypto.subtle.importKey('spki', cert.spki, { name: 'ECDSA', namedCurve: cert.curve.name }, false, ['verify']);
}

async function signedBy(cert, issuer) {
  if (!cert.hash || !issuer.curve) return false;
  return crypto.subtle.verify({ name: 'ECDSA', hash: cert.hash }, await publicKey(issuer), derToRaw(cert.signature, issuer.curve.size), cert.tbs);
}

const refused = (why) => new ApiError(400, 'bad_transaction', `That purchase didn't check out with Apple (${why}).`);

// The payload of a JWS signed through Apple's chain; throws when anything fails.
export async function verifyAppleJws(jws, { root = APPLE_ROOT_G3, now = Date.now() } = {}) {
  const parts = String(jws || '').split('.');
  if (parts.length !== 3) throw refused('not signed');
  let header, payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64ToBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64ToBytes(parts[1])));
  } catch {
    throw refused('unreadable');
  }
  if (header.alg !== 'ES256' || !Array.isArray(header.x5c) || header.x5c.length !== 3) throw refused('no chain');
  const ders = header.x5c.map((c) => b64ToBytes(c));
  if ((await sha256Hex(ders[2])) !== root) throw refused('not Apple');
  let leaf, middle, top;
  try {
    [leaf, middle, top] = ders.map(parseCertificate);
  } catch {
    throw refused('unreadable chain');
  }
  // In date when it was signed (Apple's own libraries use the signed date, so an old
  // transaction still checks out after its leaf certificate expires).
  const at = Number(payload.signedDate) || now;
  for (const cert of [leaf, middle, top]) {
    if (at < cert.notBefore || at > cert.notAfter) throw refused('out of date');
  }
  if (!leaf.extensions.has(LEAF_MARKER) || !middle.extensions.has(INTERMEDIATE_MARKER)) throw refused('not a store certificate');
  if (!(await signedBy(middle, top)) || !(await signedBy(leaf, middle))) throw refused('broken chain');
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await publicKey(leaf), b64ToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw refused('signature');
  return payload;
}
