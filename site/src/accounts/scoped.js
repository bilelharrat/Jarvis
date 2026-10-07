// Scoped tokens: what another Eden app holds to use one part of an account, never the account
// itself. Today that is Eden Messenger (messenger.askeden.com) asking Eden about a conversation
// (@Eden, src/eden/ask.js has the flow). Kept in the account's Durable Object; account.js
// dispatches every `scoped-*` op here.
//
// - A connect code: made on askeden.com's consent page by a signed-in browser (a `web` device),
//   used once, for two minutes, bound to the app (`client`), its return address and a PKCE
//   challenge (S256). Stored as `sccode:<SHA-256 of its secret>`, never the secret.
// - A scoped token, `es1.<account>.<id>.<secret>`: what a code is redeemed for. Stored as
//   `scoped:<id>` → { id, client, scope, secret_hash, created, expires, last_used, by }. Its
//   prefix isn't jv1, so no other door of askeden.com takes it (util.js parseToken): it can
//   only hold the included AI for one ask (`scoped-hold`) and revoke itself.
// - At most SCOPED.max per account (a new one retires the oldest), each for SCOPED.days.
// - Deleting the account deletes them with everything else (storage.deleteAll).

import { ApiError, b64url, randomBytes, sameText, sha256, sha256Hex, signedOut, validAccountId } from './util.js';

export const SCOPED = { days: 90, max: 10, codeSeconds: 120, codes: 10 };
// The apps that may ask for a scoped token, and what for. `callback` is the only path a code
// is sent back to, on the app's own origin (ask.js decides which origins).
export const CLIENTS = { messenger: { name: 'Eden Messenger', scope: 'ask', callback: '/eden/connected' } };

const ID = /^[0-9a-f]{16}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/; // base64url of a SHA-256
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/; // RFC 7636

/** "es1.<account>.<id>.<secret>" → { account, id, secret }; null if malformed. */
export function parseScopedToken(text) {
  const parts = String(text || '').trim().split('.');
  if (parts.length !== 4 || parts[0] !== 'es1') return null;
  const [, account, id, secret] = parts;
  if (!validAccountId(account) || !ID.test(id) || !SECRET.test(secret)) return null;
  return { account, id, secret };
}

export const makeScopedToken = (account, id, secret) => `es1.${account}.${id}.${secret}`;

/** "<account>.<secret>" (a connect code, as the app sees it) → { account, secret }; null if malformed. */
export function parseConnectCode(text) {
  const m = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(String(text || ''));
  return m && validAccountId(m[1]) ? { account: m[1], secret: m[2] } : null;
}

/** PKCE S256: base64url(SHA-256(verifier)). */
export const challengeOf = async (verifier) => b64url(await sha256(String(verifier)));

const notConnected = () => new ApiError(401, 'not_connected', 'This app isn’t connected to Eden any more. Connect it again.');
const badGrant = () => new ApiError(400, 'invalid_grant', 'That connect code is used, expired or wasn’t made for this. Connect again.');

// ── the Account object's ops ──

/** account.js: `if (op.startsWith('scoped-')) return json(await scopedOp(this, op, body, request));` */
export async function scopedOp(account, op, body, request) {
  switch (op) {
    case 'scoped-code':
      return makeCode(account, await webCaller(account, request), body);
    case 'scoped-redeem':
      return redeem(account, body);
    case 'scoped-hold': {
      const token = await tokenCaller(account, body);
      if (token.scope !== 'ask') throw new ApiError(403, 'forbidden', 'This connection may not ask Eden.');
      return { ...(await account.holdAi({ usd: body.usd })), client: token.client };
    }
    case 'scoped-revoke': {
      // The token itself (an app disconnecting), or a browser of this account by id.
      const id = body.secret ? (await tokenCaller(account, body)).id : (await webCaller(account, request), String(body.id || ''));
      const found = ID.test(id) && (await account.storage.get(`scoped:${id}`));
      if (found) await account.storage.delete(`scoped:${id}`);
      return { revoked: Boolean(found) };
    }
    case 'scoped-list': {
      await webCaller(account, request);
      return { connections: (await live(account)).map(publicConnection) };
    }
    default:
      throw new ApiError(404, 'not_found', 'No such thing.');
  }
}

/** The signed-in browser on askeden.com: only a `web` device approves an app. */
async function webCaller(account, request) {
  const device = await account.authenticate(request);
  if (device.kind !== 'web') throw new ApiError(403, 'forbidden', 'Connect apps from askeden.com in a browser.');
  return device;
}

/** A scoped token, checked: its record (an expired one goes). */
async function tokenCaller(account, { id, secret }) {
  if (!ID.test(String(id || '')) || !SECRET.test(String(secret || ''))) throw notConnected();
  const token = await account.storage.get(`scoped:${id}`);
  if (!token || !sameText(token.secret_hash, await sha256Hex(secret))) throw notConnected();
  const now = account.now();
  if (token.expires <= now) {
    await account.storage.delete(`scoped:${id}`);
    throw notConnected();
  }
  if (now - (token.last_used || 0) > 3600_000) {
    token.last_used = now; // at most hourly, like a device's last_seen
    await account.storage.put(`scoped:${id}`, token);
  }
  return token;
}

async function live(account) {
  const now = account.now();
  const out = [];
  for (const token of (await account.storage.list({ prefix: 'scoped:' })).values()) {
    if (token.expires <= now) await account.storage.delete(`scoped:${token.id}`);
    else out.push(token);
  }
  return out.sort((a, b) => a.created - b.created);
}

function publicConnection({ id, client, scope, created, expires, last_used }) {
  return { id, client, name: CLIENTS[client]?.name || client, scope, created, expires, last_used: last_used || null };
}

async function makeCode(account, device, { client, redirect_uri, challenge, scope }) {
  const app = CLIENTS[client];
  if (!app) throw new ApiError(400, 'bad_request', 'Unknown app.');
  if (scope !== app.scope) throw new ApiError(400, 'bad_request', 'That app may ask only for what it is for.');
  if (!CHALLENGE.test(String(challenge || ''))) throw new ApiError(400, 'bad_request', 'A PKCE challenge (S256) is needed.');
  if (typeof redirect_uri !== 'string' || !redirect_uri || redirect_uri.length > 300) throw new ApiError(400, 'bad_request', 'A return address is needed.');
  const now = account.now();
  const codes = [...(await account.storage.list({ prefix: 'sccode:' })).entries()];
  const waiting = [];
  for (const [key, code] of codes) {
    if (code.expires <= now) await account.storage.delete(key);
    else waiting.push(key);
  }
  if (waiting.length >= SCOPED.codes) throw new ApiError(429, 'slow_down', 'Too many connections started at once; wait a minute.', { 'retry-after': '60' });
  const secret = b64url(randomBytes(32));
  const expires = now + SCOPED.codeSeconds * 1000;
  await account.storage.put(`sccode:${await sha256Hex(secret)}`, { client, scope, redirect_uri, challenge, device: device.id, expires });
  return { code: secret, expires };
}

async function redeem(account, { code, client, redirect_uri, verifier }) {
  if (!SECRET.test(String(code || ''))) throw badGrant();
  const key = `sccode:${await sha256Hex(code)}`;
  const held = await account.storage.get(key);
  if (!held) throw badGrant();
  await account.storage.delete(key); // one try, right or wrong
  const now = account.now();
  if (held.expires <= now || held.client !== client || !sameText(held.redirect_uri, String(redirect_uri || ''))) throw badGrant();
  if (!VERIFIER.test(String(verifier || '')) || !sameText(held.challenge, await challengeOf(verifier))) throw badGrant();
  // The browser that approved it must still be signed in (two minutes is long enough to sign out).
  const approver = await account.storage.get(`dev:${held.device}`);
  if (!approver || (approver.expires && approver.expires <= now)) throw signedOut();
  const tokens = await live(account);
  for (const old of tokens.slice(0, Math.max(0, tokens.length - (SCOPED.max - 1)))) await account.storage.delete(`scoped:${old.id}`);
  const id = [...randomBytes(8)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const secret = b64url(randomBytes(32));
  const token = {
    id,
    client,
    scope: held.scope,
    secret_hash: await sha256Hex(secret),
    created: now,
    expires: now + SCOPED.days * 86400_000,
    last_used: null,
    by: held.device,
  };
  await account.storage.put(`scoped:${id}`, token);
  return { id, secret, scope: token.scope, expires: token.expires };
}
