// Firebase Cloud Messaging (HTTP v1), for the apps around askeden's pages on Android (Ask Eden Travel for Android,
// askeden/android/travel TravelMessaging.kt), as apns.js is for the iPhone's. Data messages only: every value a string,
// the app draws the notification itself (its channel, its icon, its tap).
//
// Configuration (the owner sets them):
//   FCM_SERVICE_ACCOUNT  (secret) the Firebase project's service account JSON key, with the
//                        "Firebase Cloud Messaging API Admin" role (or Firebase Admin SDK Administrator)
//   FCM_PROJECT_ID       the Firebase project id (default: the key's project_id)
// The access token (OAuth 2.0 JWT bearer, RS256, as google-play.js) is made once and used until five minutes before
// Google says it ends.

import { b64ToBytes, b64url, b64urlText } from './util.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const API = 'https://fcm.googleapis.com/v1/projects';
export const FCM_TOKEN = /^[A-Za-z0-9_:.-]{20,512}$/;
// FCM's error codes that mean the registration token is no good any more (the app was removed, or it's another project's)
export const FCM_GONE = new Set(['UNREGISTERED', 'SENDER_ID_MISMATCH']);
const MAX_DATA = 4096; // FCM refuses a message whose data is bigger

let cached = null; // { email, token, until (ms) }

export function forgetFcmToken() {
  cached = null;
}

function serviceAccount(env) {
  try {
    const sa = JSON.parse(String(env.FCM_SERVICE_ACCOUNT || ''));
    if (sa && typeof sa.client_email === 'string' && typeof sa.private_key === 'string') return sa;
  } catch {
    // not set, or not the JSON key
  }
  return null;
}

const projectOf = (env, sa) => String(env.FCM_PROJECT_ID || (sa && sa.project_id) || '');

export const fcmReady = (env = {}) => {
  const sa = serviceAccount(env);
  return Boolean(sa && projectOf(env, sa));
};

async function accessToken(env, sa, fetcher, now) {
  if (cached && cached.email === sa.client_email && cached.until > now + 5 * 60_000) return cached.token;
  const iat = Math.floor(now / 1000);
  const head = b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT', ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) }));
  const claims = b64urlText(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri || TOKEN_URL, iat, exp: iat + 3600 }));
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', b64ToBytes(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${claims}`)));
  const r = await fetcher(sa.token_uri || TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${b64url(sig)}` }).toString(),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || typeof body.access_token !== 'string') throw new Error(`FCM sign-in failed (${r.status} ${body && body.error ? body.error : ''})`.trim());
  cached = { email: sa.client_email, token: body.access_token, until: now + (Number(body.expires_in) || 3600) * 1000 };
  return cached.token;
}

/** Every value a string (FCM's data map); empty ones left out. */
export function fcmData(data) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (v === null || v === undefined || v === '') continue;
    out[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }
  return out;
}

/**
 * One data message to one registration token: { token, data, collapse?, ttl? (seconds), priority? ('high'|'normal') }.
 * Returns { status, name? } or { status, reason } (FCM's errorCode, e.g. UNREGISTERED; 'too_big'; 'not_set_up').
 */
export async function sendFcm(env, msg, fetcher = fetch, now = Date.now()) {
  const sa = serviceAccount(env);
  const project = projectOf(env, sa);
  if (!sa || !project) return { status: 503, reason: 'not_set_up' };
  if (!FCM_TOKEN.test(String(msg.token || ''))) return { status: 400, reason: 'UNREGISTERED' };
  const android = { priority: msg.priority === 'normal' ? 'NORMAL' : 'HIGH' };
  if (typeof msg.collapse === 'string' && msg.collapse) android.collapse_key = msg.collapse.slice(0, 64);
  if (Number.isFinite(msg.ttl)) android.ttl = `${Math.max(0, Math.floor(msg.ttl))}s`;
  const data = fcmData(msg.data);
  if (new TextEncoder().encode(JSON.stringify(data)).length > MAX_DATA) return { status: 413, reason: 'too_big' };
  const body = JSON.stringify({ message: { token: msg.token, data, android } });
  const attempt = async () => fetcher(`${API}/${encodeURIComponent(project)}/messages:send`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await accessToken(env, sa, fetcher, now)}`, 'content-type': 'application/json' },
    body,
  });
  let r = await attempt();
  if (r.status === 401) {
    forgetFcmToken(); // revoked or expired early: a fresh one, once
    r = await attempt();
  }
  const answer = await r.json().catch(() => ({}));
  if (r.ok) return { status: 200, name: String(answer.name || '') };
  return { status: r.status, reason: reasonOf(answer) };
}

// google.firebase.fcm.v1.FcmError's errorCode when there is one, else Google's status (INVALID_ARGUMENT, …)
function reasonOf(answer) {
  const e = (answer && answer.error) || {};
  for (const d of e.details || []) if (d && typeof d.errorCode === 'string') return d.errorCode;
  return String(e.status || '');
}
