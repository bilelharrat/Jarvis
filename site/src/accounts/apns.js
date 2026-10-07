// Apple's push service, with askeden.com's push key (Worker secrets APNS_KEY, APNS_KEY_ID),
// for Macs whose owner has no key of their own. Like the Mac's push.py: an ES256 provider
// token made once and used for 50 minutes, HTTP/2 to api.push.apple.com (Workers speak it),
// and Apple's answer passed back as it is.

import { BUNDLE_ID, TEAM_ID, b64ToBytes, b64url, b64urlText } from './util.js';

const HOSTS = { production: 'https://api.push.apple.com', sandbox: 'https://api.sandbox.push.apple.com' };
const TOKEN_MS = 50 * 60 * 1000;
export const MAX_PAYLOAD = 4096;
// Apple's reasons that mean the device token is no good any more.
export const GONE = new Set(['Unregistered', 'BadDeviceToken', 'DeviceTokenNotForTopic', 'ExpiredToken']);

let cached = null; // { keyId, at, token }

export const pushReady = (env) => Boolean(env.APNS_KEY && env.APNS_KEY_ID);

async function providerToken(env, now = Date.now()) {
  if (cached && cached.keyId === env.APNS_KEY_ID && now - cached.at < TOKEN_MS) return cached.token;
  const pem = String(env.APNS_KEY).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', b64ToBytes(pem), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64urlText(JSON.stringify({ alg: 'ES256', kid: env.APNS_KEY_ID }));
  const body = b64urlText(JSON.stringify({ iss: env.APPLE_TEAM_ID || TEAM_ID, iat: Math.floor(now / 1000) }));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(`${head}.${body}`)));
  cached = { keyId: env.APNS_KEY_ID, at: now, token: `${head}.${body}.${b64url(sig)}` };
  return cached.token;
}

export function forgetProviderToken() {
  cached = null;
}

// One push. Returns { status, apns_id?, reason? }.
export async function sendPush(env, push, fetcher = fetch) {
  const kind = ['alert', 'background', 'liveactivity'].includes(push.push_type) ? push.push_type : 'alert';
  const topic = kind === 'liveactivity' ? `${BUNDLE_ID}.push-type.liveactivity` : BUNDLE_ID;
  const headers = {
    authorization: `bearer ${await providerToken(env)}`,
    'apns-topic': topic,
    'apns-push-type': kind,
    'apns-priority': String(push.priority === 5 || kind === 'background' ? 5 : 10),
    'content-type': 'application/json',
  };
  if (typeof push.collapse_id === 'string' && push.collapse_id) headers['apns-collapse-id'] = push.collapse_id.slice(0, 64);
  if (Number.isFinite(push.expiration)) headers['apns-expiration'] = String(Math.floor(push.expiration));
  const host = HOSTS[push.apns_env === 'sandbox' ? 'sandbox' : 'production'];
  const attempt = async () => fetcher(`${host}/3/device/${push.apns_token}`, { method: 'POST', headers, body: push.body });
  let response = await attempt();
  if (response.status === 403) {
    const reason = await reasonOf(response.clone());
    if (reason === 'ExpiredProviderToken') {
      forgetProviderToken();
      headers.authorization = `bearer ${await providerToken(env)}`;
      response = await attempt();
    }
  }
  if (response.status === 200) return { status: 200, apns_id: response.headers.get('apns-id') || '' };
  return { status: response.status, reason: (await reasonOf(response)) || '' };
}

async function reasonOf(response) {
  try {
    return (await response.json()).reason || '';
  } catch {
    return '';
  }
}
