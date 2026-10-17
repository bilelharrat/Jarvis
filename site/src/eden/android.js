// Eden for Android (askeden/android, package com.askeden.eden).
//
//   - /.well-known/assetlinks.json: Digital Asset Links, so Android lets the app use askeden.com's
//     passkeys (Credential Manager, `get_login_creds`) and open askeden.com links (`handle_all_urls`).
//     Its certificates: the upload key's below, plus ANDROID_CERT_SHA256 (comma-separated SHA-256
//     fingerprints, colon hex): the Play App Signing key's, which Play Console shows once the app
//     exists there. Without the Play key's, passkeys fail in the app installed from Google Play.
//   - The origin Android's passkey sheet writes in clientDataJSON for an app is not https://askeden.com
//     but `android:apk-key-hash:<base64url SHA-256 of the signing certificate>`: the native passkey
//     verify (session.js) also accepts these, for the same certificates.

export const ANDROID_PACKAGE = 'com.askeden.eden';

/** The upload key's certificate (~/EdenAndroidKeys/eden-upload.jks), SHA-256. */
export const ANDROID_UPLOAD_CERT = 'CB:A7:FF:5E:29:9B:96:74:5C:37:9D:F7:A1:98:99:26:B3:C0:37:C7:CA:E0:99:EC:33:5C:EC:94:49:9B:60:18';

const FINGERPRINT = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

/** Every signing certificate the app may carry, colon hex, upper case, each once. */
export function androidCerts(env = {}) {
  const extra = String(env.ANDROID_CERT_SHA256 || '').split(/[,\s]+/).map((f) => f.trim().toUpperCase()).filter((f) => FINGERPRINT.test(f));
  return [...new Set([ANDROID_UPLOAD_CERT, ...extra])];
}

/** `android:apk-key-hash:…` for a colon-hex SHA-256 fingerprint. */
export function apkKeyHash(fingerprint) {
  const bytes = fingerprint.split(':').map((h) => parseInt(h, 16));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `android:apk-key-hash:${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/** The passkey origins the Android app's sheet may write. */
export function androidOrigins(env = {}) {
  return androidCerts(env).map(apkKeyHash);
}

/** GET /.well-known/assetlinks.json (Eden for Education's own host has no Android app: an empty list). */
export function assetLinks(env = {}, host = '') {
  const headers = { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' };
  if (env.EDU_HOST && host === String(env.EDU_HOST).toLowerCase()) return new Response('[]', { status: 200, headers });
  const body = [{
    relation: ['delegate_permission/common.handle_all_urls', 'delegate_permission/common.get_login_creds'],
    target: { namespace: 'android_app', package_name: ANDROID_PACKAGE, sha256_cert_fingerprints: androidCerts(env) },
  }];
  return new Response(JSON.stringify(body), { status: 200, headers });
}
