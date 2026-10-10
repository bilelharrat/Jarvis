// askeden.com/ itself: Eden for a signed-in browser, Eden's front page (sign in, download the
// apps) for everyone else, and Eden's sign-in page.
//
//   /, /index.html     Eden (public/eden/index.html), or signed out the front page (public/home/),
//                      which links to the apps page at /download (public/jarvis/, worker.js)
//   /home/home.css     the front page's stylesheet
//   /pricing           → /#pricing, the front page's plans
//   /signin            the sign-in page (public/signin/): Apple, Google, or a code the iPhone
//                      approves; signed in, back to / (or to `?return=`, public/signin/return.js)
//   /<Eden file>       public/eden/<file> (the files src/eden/manifest.js lists), signed in only
//   /signin/<file>     the sign-in page's stylesheet and script
//   /artifact/<id>     an Eden artifact (chat.js), signed in only
//   /p/<id>            a published page (accounts/published.js): signed in as its owner, or anyone with the link
//   /s/<id>            a shared chat, read-only (accounts/shared-chats.js): anyone with the link (the key is in its #)
//   /help, /help/<file>  the Help page and FAQ (help.js): everyone, signed in or not
//   /link, /link/<file>  linking a Mac from this browser (public/link/), signed in only
//   /privacy, /terms   the Privacy Policy and Terms of Service (public/privacy/, public/terms/):
//                      everyone, the sign-in page's stylesheet, only the language script
//   /accuracy          "How often AI makes things up": the hallucination chart and how it was measured
//                      (public/accuracy/), everyone; its own stylesheet, no script
//   /lang/<file>       the site pages' French (public/lang/: site-i18n.js and its fr-<page>.js files),
//                      everyone; the front page, sign-in, Link a Mac, the legal and Education pages load it
//
// Each answer at / and /signin depends on the cookie (vary: cookie, never cached), and a
// session cookie that no longer works is cleared on the way.
//
// public/eden is a copy of the Model Router's web/chat made by scripts/sync-eden.mjs.

import { artifactPage } from './chat.js';
import { helpPage } from './help.js';
import { publishedPage } from '../accounts/published.js';
import { sharedChatPage } from '../accounts/shared-chats.js';
import { EDEN_FILES } from './manifest.js';
import { currentSession } from './session.js';
import { EDEN_CSP, EDEN_PERMISSIONS, RUNNER_CSP, SESSION_COOKIE, SHEET_PICKER_CSP, SIGNIN_CSP, SIGNIN_PAGE_CSP, clearCookie, page, withHeaders } from './web.js';
import { safeReturn } from '../../public/signin/return.js';

// The legal pages: static text and the sign-in page's stylesheet, and the language script (/lang/, French), nothing else.
const LEGAL_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// Eden's signed-out front page: its stylesheet (the mark is a data: image in it), the apps' icons, the films (media-src) and its own script
// and the language script (/lang/; no inline script).
const HOME_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const SIGNIN_FILES = new Set(['signin.css', 'signin.js', 'return.js']);
const LINK_FILES = new Set(['link.css', 'link.js']);
// The site pages' French (public/lang/, site-i18n.js): the script, and one dictionary per page.
const LANG_FILES = new Set(['site-i18n.js', ...['home', 'signin', 'link', 'jarvis', 'daredevil', 'privacy', 'terms', 'edu-home', 'edu-privacy', 'edu-terms'].map((p) => `fr-${p}.js`)]);
const EDEN = new Set(EDEN_FILES);

const asset = (env, request, path) => env.ASSETS.fetch(new Request(new URL(path, request.url), request));

/** Static assets answer a Range request with the whole file and no Accept-Ranges, and Safari (Mac and
 * iPhone) won't play a video from that. This answers the one byte range itself (a 206), for the ad video. */
async function rangedAsset(env, request, path) {
  const res = await asset(env, request, path);
  const common = { 'accept-ranges': 'bytes', 'x-content-type-options': 'nosniff' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') || '');
  if (!m || (m[1] === '' && m[2] === '') || res.status !== 200 || request.method !== 'GET') return withHeaders(res, common);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const size = bytes.length;
  const start = m[1] === '' ? Math.max(0, size - Number(m[2])) : Number(m[1]); // "bytes=-500" is the last 500
  const end = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start >= size || end < start) return new Response(null, { status: 416, headers: { ...common, 'content-range': `bytes */${size}` } });
  return new Response(bytes.subarray(start, end + 1), {
    status: 206,
    headers: {
      ...common,
      'content-type': res.headers.get('content-type') || 'video/mp4',
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': String(end - start + 1),
      'cache-control': res.headers.get('cache-control') || 'public, max-age=0, must-revalidate',
      ...(res.headers.get('etag') ? { etag: res.headers.get('etag') } : {}),
    },
  });
}

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
  if (path === '/privacy' || path === '/terms') return page(await asset(env, request, `${path}/`), LEGAL_CSP, { cache: 'public, max-age=300' });
  if (path === '/accuracy') return page(await asset(env, request, '/accuracy/'), HOME_CSP, { cache: 'public, max-age=300' }); // the hallucination chart (public/accuracy/)
  if (path === '/accuracy/accuracy.css') return withHeaders(await asset(env, request, path), { 'cache-control': 'public, no-cache', 'x-content-type-options': 'nosniff' });
  if (path === '/pricing') return redirect('/#pricing'); // the front page's plans (public/home/)
  // Eden for Education's own app (askeden web/chat/edu.html): signed in, the app; signed out, its landing page
  if (path === '/edu' || path === '/edu.html') {
    const { session, stale } = await currentSession(request, env);
    if (!session) return byCookie(page(await asset(env, request, '/edu-home/'), HOME_CSP), stale);
    return byCookie(page(await asset(env, request, '/eden/edu'), EDEN_CSP, { permissions: EDEN_PERMISSIONS }), false);
  }
  if (path === '/edu/privacy' || path === '/edu/terms') return page(await asset(env, request, `/edu-home/${path.slice(5)}`), HOME_CSP, { cache: 'public, max-age=300' }); // Eden for Education's student privacy notice and materials terms
  if (path === '/edu-home/edu-logo.svg') return withHeaders(await asset(env, request, path), { 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' });
  if (path === '/edu-home/edu-home.css') return withHeaders(await asset(env, request, path), { 'cache-control': 'public, no-cache', 'x-content-type-options': 'nosniff' });
  if (path === '/home/home.css' || path === '/home/features.js') return withHeaders(await asset(env, request, path), { 'cache-control': 'public, no-cache', 'x-content-type-options': 'nosniff' });
  if (/^\/jarvis\/walk-\d\.mp4$/.test(path)) return rangedAsset(env, request, path); // the front page's films (public/jarvis/walk-N.mp4)
  const langFile = /^\/lang\/([\w.-]+)$/.exec(path);
  if (langFile) {
    if (!LANG_FILES.has(langFile[1])) return null;
    return withHeaders(await asset(env, request, path), { 'cache-control': 'public, no-cache', 'x-content-type-options': 'nosniff' });
  }
  const signinFile = /^\/signin\/([\w.-]+)$/.exec(path);
  if (signinFile) {
    if (!SIGNIN_FILES.has(signinFile[1])) return null;
    return withHeaders(await asset(env, request, path), { 'cache-control': 'public, no-cache', 'x-content-type-options': 'nosniff' });
  }
  const artifact = /^\/artifact\/([0-9a-f]{24})$/.exec(path);
  if (artifact) return artifactPage(request, env, artifact[1]);
  const published = /^\/p\/([^/]+)$/.exec(path); // a published page (G10): its owner, or anyone with the link
  if (published) return publishedPage(request, env, published[1], () => currentSession(request, env));
  if (path.startsWith('/s/')) return sharedChatPage(request, env, path); // a shared chat (askeden Q3): anyone with the link, noindex
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
    return byCookie(page(await asset(env, request, '/signin/'), SIGNIN_PAGE_CSP), stale);
  }
  const name = path === '/' ? 'index.html' : path.slice(1);
  if (!EDEN.has(name)) return null;

  // The code canvas's runner: static, no secrets, its own sandbox policy; anyone may frame it (it runs only what its framer sends, in that viewer's browser).
  if (name === 'runner.html') return withHeaders(await asset(env, request, '/eden/runner'), { 'content-security-policy': RUNNER_CSP, 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  const { session, stale } = await currentSession(request, env);
  if (name === 'index.html') {
    if (!session) {
      // A sign-in that came back here with ?error=…: the sign-in page says what happened.
      const { search, searchParams } = new URL(request.url);
      if (searchParams.has('error')) return byCookie(redirect(`/signin${search}`), stale);
      return byCookie(page(await asset(env, request, '/home/'), HOME_CSP), stale);
    }
    return byCookie(page(await asset(env, request, '/eden/'), EDEN_CSP, { permissions: EDEN_PERMISSIONS }), false);
  }
  // The spreadsheet canvas's Google Picker popup (askeden Q15): signed in only, with Google's Picker allowed on it alone.
  if (name === 'sheet-picker.html') return session ? byCookie(page(await asset(env, request, '/eden/sheet-picker'), SHEET_PICKER_CSP), false) : new Response('Sign in at askeden.com first.', { status: 401, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  // Eden's scripts and styles are for its signed-in page only.
  if (!session) return new Response('Sign in at askeden.com first.', { status: 401, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  return withHeaders(await asset(env, request, `/eden/${name}`), {
    'cache-control': 'private, no-cache',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
  });
}
