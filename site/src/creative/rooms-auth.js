// Who a Creative Suite app's request to the rooms is from (docs/creative-rooms.md "Auth"): its `creative` token
// (docs/creative-api.md §2, `Authorization: Bearer es1.<account>.<id>.<secret>`), checked as creative/api.js checks
// its own routes: parsed (accounts/scoped.js), the account allowed on Eden (webAllowed), then verified in the
// account's own object with `creative-me` (creative/ops.js; it needs no Plus). Resolves to { account, name, email },
// or null when there is no token or it is malformed, revoked or expired (the app's "link again": 401
// not_connected). Throws 403 `forbidden` for an account that may not use Eden yet, or a token of another app.
//
// One extra door, for `wrangler dev` only: with CREATIVE_ROOMS_DEV = "1" AND a request to localhost or 127.0.0.1,
// the fake people of wrangler.creative-rooms-dev.toml (CREATIVE_ROOMS_DEV_TOKENS, a JSON object token →
// { account, name, email }) are taken too, so two apps can try rooms locally without real accounts. wrangler.toml
// never sets it, and askeden.com is never localhost, so production never takes it.
//
// The one caller is rooms.js roomsApi; tests pass their own as `deps.verify`.

import { call } from '../accounts/index.js';
import { parseScopedToken } from '../accounts/scoped.js';
import { ApiError, webAllowed } from '../accounts/util.js';

const LOCAL = new Set(['localhost', '127.0.0.1']);

export async function verifyCreativeToken(request, env) {
  const auth = /^Bearer\s+(\S{1,400})$/i.exec(request.headers.get('authorization') || '');
  if (!auth) return null;
  const dev = devPerson(request, env, auth[1]);
  if (dev) return dev;
  const token = parseScopedToken(auth[1]);
  if (!token) return null;
  if (!webAllowed(env, token.account)) throw new ApiError(403, 'forbidden', 'This Eden account can’t use Eden yet.');
  if (!env.ACCOUNTS) throw new ApiError(503, 'not_set_up', 'Eden accounts are not set up here yet.');
  let me;
  try {
    me = await call(env, token.account, 'creative-me', { id: token.id, secret: token.secret });
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null; // revoked, expired, or never was
    throw error;
  }
  const account = me && me.account;
  if (!account || account.id !== token.account) return null;
  const email = typeof account.email === 'string' ? account.email : '';
  return { account: account.id, name: (typeof account.name === 'string' && account.name) || email, email };
}

function devPerson(request, env, token) {
  if (!env || env.CREATIVE_ROOMS_DEV !== '1') return null;
  let host;
  try {
    host = new URL(request.url).hostname;
  } catch {
    return null;
  }
  if (!LOCAL.has(host)) return null;
  let people = env.CREATIVE_ROOMS_DEV_TOKENS;
  if (typeof people === 'string') {
    try {
      people = JSON.parse(people);
    } catch {
      return null;
    }
  }
  if (!people || typeof people !== 'object' || !Object.hasOwn(people, token)) return null;
  const who = people[token];
  if (!who || typeof who !== 'object' || typeof who.account !== 'string') return null;
  return { account: who.account, name: typeof who.name === 'string' ? who.name : '', email: typeof who.email === 'string' ? who.email : '' };
}
