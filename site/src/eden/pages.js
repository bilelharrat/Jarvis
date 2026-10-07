// askeden.com/ itself: Eden for a signed-in browser, the J.A.R.V.I.S. and Eden Messenger landing
// page (with "Sign in to Eden") for everyone else, and Eden's sign-in page.
//
//   /, /index.html     Eden (public/eden/index.html), or signed out the landing page (public/jarvis/)
//   /signin            the sign-in page (public/signin/): Apple, Google, or a code the iPhone
//                      approves; signed in, back to / (or to `?return=`, public/signin/return.js)
//   /<Eden file>       public/eden/<file> (the files src/eden/manifest.js lists), signed in only
//   /signin/<file>     the sign-in page's stylesheet and script
//   /artifact/<id>     an Eden artifact (chat.js), signed in only
//   /p/<id>            a published page (accounts/published.js): signed in as its owner, or anyone with the link
//   /help, /help/<file>  the Help page and FAQ (help.js): everyone, signed in or not
//   /link, /link/<file>  linking a Mac from this browser (public/link/), signed in only
//
// Each answer at / and /signin depends on the cookie (vary: cookie, never cached), and a
// session cookie that no longer works is cleared on the way.
//
// public/eden is a copy of the Model Router's web/chat made by scripts/sync-eden.mjs.

import { artifactPage } from './chat.js';
import { helpPage } from './help.js';
import { publishedPage } from '../accounts/published.js';
import { EDEN_FILES } from './manifest.js';
import { currentSession } from './session.js';
import { EDEN_CSP, EDEN_PERMISSIONS, LANDING_CSP, SESSION_COOKIE, SIGNIN_CSP, clearCookie, page, withHeaders } from './web.js';
import { safeReturn } from '../../public/signin/return.js';

const SIGNIN_FILES = new Set(['signin.css', 'signin.js', 'return.js']);
const LINK_FILES = new Set(['link.css', 'link.js']);
const EDEN = new Set(EDEN_FILES);

const asset = (env, request, path) => env.ASSETS.fetch(new Request(new URL(path, request.url), request));

/** A page (or redirect) that depends on who's signed in; a stale session cookie goes. */
function byCookie(response, stale) {
  response.headers.set('vary', 'cookie');
  response.headers.set('cache-control', 'no-store');
  if (stale) response.headers.append('set-cookie', clearCookie(SESSION_COOKIE));
  return response;
}

const redirect = (to) => new Response(null, { status: 302, headers: { location: to } });

/** The response for this path, or null when it isn't one of Eden's. */
export async function edenPage(request, env, path) {
  if (path === '/help' || path.startsWith('/help/')) return helpPage(request, env, path);
  const signinFile = /^\/signin\/([\w.-]+)$/.exec(path);
  if (signinFile) {
    if (!SIGNIN_FILES.has(signinFile[1])) return null;
    return withHeaders(await asset(env, request, path), { 'cache-control': 'public, no-cache', 'x-content-type-options': 'nosniff' });
  }
  const artifact = /^\/artifact\/([0-9a-f]{24})$/.exec(path);
  if (artifact) return artifactPage(request, env, artifact[1]);
  const published = /^\/p\/([^/]+)$/.exec(path); // a published page (G10): its owner, or anyone with the link
  if (published) return publishedPage(request, env, published[1], () => currentSession(request, env));
  // Linking a Mac from the browser (public/link/; session.js linkMac): signed in only.
  const linkFile = /^\/link\/([\w.-]+)$/.exec(path);
  if (linkFile) {
    if (!LINK_FILES.has(linkFile[1])) return null;
    return withHeaders(await asset(env, request, path), { 'cache-control': 'public, no-cache', 'x-content-type-options': 'nosniff' });
  }
  if (path === '/link') {
    const { session, stale } = await currentSession(request, env);
    if (!session) return byCookie(redirect('/signin?return=%2Flink'), stale);
    return byCookie(page(await asset(env, request, '/link/'), SIGNIN_CSP), false);
  }
  if (path === '/signin') {
    const { session, stale } = await currentSession(request, env);
    if (session) return byCookie(redirect(safeReturn(new URL(request.url).searchParams.get('return'))), false);
    return byCookie(page(await asset(env, request, '/signin/'), SIGNIN_CSP), stale);
  }
  const name = path === '/' ? 'index.html' : path.slice(1);
  if (!EDEN.has(name)) return null;

  const { session, stale } = await currentSession(request, env);
  if (name === 'index.html') {
    if (!session) {
      // A sign-in that came back here with ?error=…: the sign-in page says what happened.
      const { search, searchParams } = new URL(request.url);
      if (searchParams.has('error')) return byCookie(redirect(`/signin${search}`), stale);
      return byCookie(page(await asset(env, request, '/jarvis/'), LANDING_CSP), stale);
    }
    return byCookie(page(await asset(env, request, '/eden/'), EDEN_CSP, { permissions: EDEN_PERMISSIONS }), false);
  }
  // Eden's scripts and styles are for its signed-in page only.
  if (!session) return new Response('Sign in at askeden.com first.', { status: 401, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  return withHeaders(await asset(env, request, `/eden/${name}`), {
    'cache-control': 'private, no-cache',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
  });
}
