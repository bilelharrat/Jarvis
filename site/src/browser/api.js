// GET /api/chat/browser (a WebSocket): Eden's browser panel connects to this account's cloud
// browser (browser/session.js). Signed-in browsers only, from askeden.com's own page (the
// Origin must be this site's: a WebSocket has no CORS), a few connects a minute per account.
// The account's plan (Plus or not) sets its monthly browser minutes.

import { call, limited } from '../accounts/index.js';
import { ApiError } from '../accounts/util.js';
import { currentSession } from '../eden/session.js';
import { crossSite, problem, sameOrigin } from '../eden/web.js';

export const BROWSER_PATH = '/api/chat/browser';

export async function browserApi(request, env) {
  try {
    if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket' || request.method !== 'GET') throw new ApiError(426, 'bad_request', 'Connect with a WebSocket.');
    if (!sameOrigin(request) || crossSite(request)) throw new ApiError(403, 'forbidden', 'Only askeden.com’s own page may do that.');
    if (!env.BROWSER_SESSIONS || !env.BROWSER) throw new ApiError(503, 'not_set_up', 'The cloud browser isn’t set up here yet.');
    const { session } = await currentSession(request, env);
    if (!session) throw new ApiError(401, 'signed_out', 'This browser is signed out of Eden. Reload the page to sign in.');
    await limited(env, 'BROWSER_RATE', session.account);
    let plus = false;
    try { plus = Boolean((await call(env, session.account, 'get', {}, session.token)).plan?.active); } catch { /* the free allowance */ }
    const stub = env.BROWSER_SESSIONS.get(env.BROWSER_SESSIONS.idFromName(session.account));
    return await stub.fetch('https://browser/ws', { headers: { upgrade: 'websocket', 'x-eden-plus': plus ? '1' : '0' } });
  } catch (error) {
    if (error instanceof ApiError) return problem(error.status, error.message, error.code, error.headers);
    console.error('cloud browser connect failed', error && error.message);
    return problem(500, 'Something went wrong on the server. Try again.', 'server');
  }
}
