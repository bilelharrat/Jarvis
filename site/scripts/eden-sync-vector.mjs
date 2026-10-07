// The test vector the apps share with the browser for Eden sync's crypto (docs/accounts.md
// "Eden sync", "The J.A.R.V.I.S. apps"). Made here with the browser's own eden-crypto.js (the
// copy in public/eden that sync-eden.mjs makes of ~/askeden/web/chat), and checked by
// companion/Tests/EdenSyncTests.swift (CryptoKit), tests/test_eden_trust.py (`cryptography`)
// and test/eden-sync-vector.test.js (eden-crypto.js again, so a change there is noticed).
//
//   node scripts/eden-sync-vector.mjs      writes companion/Tests/Fixtures/eden-sync-vector.json
//
// Fixed keys and bytes, so the apps' own sealing can be compared byte for byte; what
// eden-crypto.js makes with fresh randomness (sealTo, the passphrase wrap) is kept as it came,
// for the apps to open.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from '../public/eden/eden-crypto.js';

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(SITE, '..', 'companion', 'Tests', 'Fixtures', 'eden-sync-vector.json');
const subtle = globalThis.crypto.subtle;
const run = (from, n) => Uint8Array.from({ length: n }, (_, i) => from + i);
const enc = new TextEncoder();

const SECRET = run(128, 32); // Eden's key
const PASSPHRASE = 'Crème brûlée, ﬁve spoons'; // NFKC folds the ligature: the apps must too

/** An X25519 key pair from 32 private bytes: { privateKey (Web Crypto), public (raw) }. */
async function x25519(bytes) {
  const der = Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(bytes)]);
  const privateKey = await subtle.importKey('pkcs8', der, { name: 'X25519' }, true, ['deriveBits']);
  const jwk = await subtle.exportKey('jwk', privateKey);
  return { privateKey, public: new Uint8Array(Buffer.from(jwk.x, 'base64url')) };
}

/** A P-256 key pair from its 32-byte scalar: { privateKey, public (65 bytes, uncompressed) }. */
async function p256(bytes) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(bytes));
  const pub = new Uint8Array(ecdh.getPublicKey());
  const b = (u) => Buffer.from(u).toString('base64url');
  const jwk = { kty: 'EC', crv: 'P-256', d: b(bytes), x: b(pub.subarray(1, 33)), y: b(pub.subarray(33)) };
  const privateKey = await subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { privateKey, public: pub };
}

const ALG = { x25519: { name: 'X25519' }, p256: { name: 'ECDH', namedCurve: 'P-256' } };

/** What an app seals with a fixed sender key and nonce: eden-crypto.js's sealTo, step by step. */
async function sealFixed(alg, recipientPublic, sender, nonce, secret, label = E.SEAL_LABEL) {
  const recipient = await subtle.importKey('raw', recipientPublic, ALG[alg], true, []);
  const shared = await subtle.deriveBits({ name: ALG[alg].name, public: recipient }, sender.privateKey, 256);
  const base = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: enc.encode(label) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: enc.encode(label) }, key, secret));
  return { sealed_key: E.b64(Buffer.concat([nonce, ct])), sender_key: E.b64(sender.public) };
}

const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));

export async function makeVector() {
  const recipients = { x25519: await x25519(run(1, 32)), p256: await p256(run(1, 32)) };
  const senders = { x25519: await x25519(run(33, 32)), p256: await p256(run(33, 32)) };
  const nonce = run(65, 12);
  const out = {
    about: 'Eden sync (docs/accounts.md): made by site/scripts/eden-sync-vector.mjs with eden-crypto.js. Base64 is standard and padded, the proof base64url.',
    labels: { seal: E.SEAL_LABEL, sync: E.SYNC_LABEL, wrap: E.WRAP_LABEL },
    secret: E.b64(SECRET),
    proof: await E.proofOf(SECRET),
  };
  for (const alg of ['x25519', 'p256']) {
    const r = recipients[alg];
    const pub = E.b64(r.public);
    // The browser's sealTo (a fresh sender key and nonce): the apps must open it.
    const browser = await E.sealTo(pub, alg, SECRET);
    // An app's seal with fixed sender and nonce: the apps must make exactly these bytes.
    const app = await sealFixed(alg, r.public, senders[alg], nonce, SECRET);
    for (const s of [browser, app]) {
      if (!same(await E.openSealed(r.privateKey, alg, s.sealed_key, s.sender_key), SECRET)) throw new Error(`${alg}: eden-crypto.js doesn't open it`);
    }
    out[alg] = {
      private: E.b64(run(1, 32)), // X25519's raw private key; P-256's scalar
      public: pub,
      code: await E.verifyCode(pub),
      browser_sealed: { sealed_key: browser.sealed_key, sender_key: browser.sender_key },
      app_sealed: { sender_private: E.b64(run(33, 32)), nonce: E.b64(nonce), ...app },
    };
  }
  const wrap = await E.wrapWithPassphrase(PASSPHRASE, SECRET, 310_000);
  if (!same(await E.unwrapWithPassphrase(PASSPHRASE, wrap), SECRET)) throw new Error('the wrap doesn’t open');
  out.passphrase = { passphrase: PASSPHRASE, wrap };
  // A key change (a device removed): the members' macs under the old key, and the old key kept
  // under the new one (the chain link) that an app opens to check the new key follows from its own.
  const next = run(160, 32);
  const gen = 'gen-abcdef12';
  const link = await E.chainLink(next, SECRET, gen, 2);
  if (!same(await E.openChainLink(next, link, gen, 2), SECRET)) throw new Error('the chain link doesn’t open');
  out.rotation = {
    gen,
    epoch: 2,
    next: E.b64(next),
    chain: [{ epoch: 2, prev: link }],
    mac: { x25519: await E.memberMac(SECRET, 'x25519', out.x25519.public), p256: await E.memberMac(SECRET, 'p256', out.p256.public) },
    next_mac: { x25519: await E.memberMac(next, 'x25519', out.x25519.public) },
  };
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const vector = await makeVector();
  fs.writeFileSync(OUT, `${JSON.stringify(vector, null, 2)}\n`);
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
}
