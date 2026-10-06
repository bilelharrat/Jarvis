// askeden.com/ itself: Eden for a signed-in browser, Eden's sign-in page for everyone else.
//
//   /, /index.html     Eden (public/eden/index.html) or the sign-in page (public/signin/)
//   /<Eden file>       public/eden/<file> (the files src/eden/manifest.js lists), signed in only
//   /signin/<file>     the sign-in page's stylesheet and script
//   /artifact/<id>     an Eden artifact (chat.js), signed in only
//
// public/eden is a copy of the Model Router's web/chat made by scripts/sync-eden.mjs.

import { artifactPage } from './chat.js';
import { EDEN_FILES } from './manifest.js';
import { currentSession } from './session.js';
import { EDEN_CSP, SESSION_COOKIE, SIGNIN_CSP, clearCookie, page, withHeaders } from './web.js';

const SIGNIN_FILES = new Set(['signin.css', 'signin.js']);
const EDEN = new Set(EDEN_FILES);

const asset = (env, request, path) => env.ASSETS.fetch(new Request(new URL(path, request.url), request));

/** The response for this path, or null when it isn't one of Eden's. */
export async function edenPage(request, env, path) {
  const signinFile = /^\/signin\/([\w.-]+)$/.exec(path);
  if (signinFile) {
    if (!SIGNIN_FILES.has(signinFile[1])) return null;
    return withHeaders(await asset(env, request, path), { 'cache-control': 'public, no-cache', 'x-content-type-options': 'nosniff' });
  }
  const artifact = /^\/artifact\/([0-9a-f]{24})$/.exec(path);
  if (artifact) return artifactPage(request, env, artifact[1]);
  const name = path === '/' ? 'index.html' : path.slice(1);
  if (!EDEN.has(name)) return null;

  const { session, stale } = await currentSession(request, env);
  if (name === 'index.html') {
    if (!session) {
      const signin = page(await asset(env, request, '/signin/'), SIGNIN_CSP);
      signin.headers.set('vary', 'cookie');
      if (stale) signin.headers.append('set-cookie', clearCookie(SESSION_COOKIE));
      return signin;
    }
    const eden = page(await asset(env, request, '/eden/'), EDEN_CSP);
    eden.headers.set('vary', 'cookie');
    return eden;
  }
  // Eden's scripts and styles are for its signed-in page only.
  if (!session) return new Response('Sign in at askeden.com first.', { status: 401, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  return withHeaders(await asset(env, request, `/eden/${name}`), {
    'cache-control': 'private, no-cache',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
  });
}
