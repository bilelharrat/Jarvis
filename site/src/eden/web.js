// What every browser-facing part of askeden.com shares: security headers and Content
// Security Policies, cookies, and the same-origin rule for anything that changes something.

// Eden's page (docs/chat-api.md in the Model Router repo), plus: not framed by anyone.
export const EDEN_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// The sign-in page: its own script and stylesheet, nothing else.
export const SIGNIN_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
// /signin itself: that, plus Cloudflare Turnstile's script and challenge frame (accounts/turnstile.js),
// and its forms (Apple and Google with the Turnstile token) posting here and redirecting on to them.
export const SIGNIN_PAGE_CSP =
  "default-src 'none'; script-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self' https://appleid.apple.com https://accounts.google.com; frame-ancestors 'none'";
// An artifact: its own inline scripts run in an opaque origin, with no network, no cookies,
// no storage and no way to the page (docs/chat-api.md), framed only by Eden itself.
export const ARTIFACT_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; frame-ancestors 'self'";
// The code canvas's runner (Eden's runner.html): an opaque-origin sandbox whose runs are Web
// Workers; its only network is cdn.jsdelivr.net for Pyodide (Python in WebAssembly); framing it is harmless (static, no secrets).
export const RUNNER_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: https://cdn.jsdelivr.net; worker-src blob:; connect-src https://cdn.jsdelivr.net; style-src 'unsafe-inline'; img-src data:";
// The J.A.R.V.I.S. landing page (/download, /jarvis): its inline script and styles, and Google Fonts.
export const LANDING_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const BASELINE = {
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

const PAGE = {
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};

/**
 * The response with these headers set (a copy: fetched and redirect responses have fixed
 * headers). A WebSocket upgrade is returned as it is.
 */
export function withHeaders(response, headers) {
  if (response.status === 101 || response.webSocket) return response;
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) out.headers.delete(name);
    else out.headers.set(name, value);
  }
  return out;
}

/** Every answer: HSTS, nosniff, a referrer policy (unless the route chose its own). */
export function baseline(response) {
  if (response.status === 101 || response.webSocket) return response;
  const missing = Object.entries(BASELINE).filter(([name]) => !response.headers.has(name));
  return missing.length ? withHeaders(response, Object.fromEntries(missing)) : response;
}

// Eden's own page may use the microphone (dictation, talk mode), asked for only on a click;
// every other page keeps it off, and no frame gets it.
export const EDEN_PERMISSIONS = 'camera=(), microphone=(self), geolocation=(), payment=(), usb=()';

/** A page's headers: its CSP, no framing, no caching, the browser features it doesn't use off. */
export function page(response, csp, { cache = 'no-store', permissions } = {}) {
  return withHeaders(response, { ...PAGE, ...(permissions ? { 'permissions-policy': permissions } : {}), 'content-security-policy': csp, 'cache-control': cache });
}

// ── cookies ──
//
// __Host- cookies: Secure, Path=/, no Domain, so only this exact host (askeden.com or www.)
// ever gets them. All HttpOnly: no script, Eden's included, can read them.

export const SESSION_COOKIE = '__Host-eden';
export const LINK_COOKIE = '__Host-eden-link';
export const APPLE_COOKIE = '__Host-eden-apple';

export function cookies(request) {
  const out = {};
  for (const part of String(request.headers.get('cookie') || '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    if (name && !(name in out)) out[name] = part.slice(at + 1).trim();
  }
  return out;
}

/** A Set-Cookie value. `sameSite` Strict unless said; `maxAge` 0 clears it. */
export function cookie(name, value, { maxAge, sameSite = 'Strict' } = {}) {
  const parts = [`${name}=${value}`, 'Path=/', 'Secure', 'HttpOnly', `SameSite=${sameSite}`];
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  return parts.join('; ');
}

export const clearCookie = (name, sameSite = 'Strict') => cookie(name, '', { maxAge: 0, sameSite });

// ── who may ask ──

/** Origin header is this very origin (a page of this site sent it). */
export function sameOrigin(request) {
  const origin = request.headers.get('origin');
  return Boolean(origin) && origin === new URL(request.url).origin;
}

/**
 * The rule for every /api request that changes something (POST, PUT, PATCH, DELETE) and for
 * the relay's WebSocket upgrade: an Origin, when a browser sends one, must be this site's.
 * The apps send none; any other page (or a sandboxed frame's "null") is refused.
 */
export function foreignOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin === null) return false;
  return origin !== new URL(request.url).origin;
}

/** Fetch metadata says another site made the browser send this. */
export const crossSite = (request) => (request.headers.get('sec-fetch-site') || '') === 'cross-site';

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

/** Eden's error shape ({ error }, as the page reads it) with a code for machines. */
export const problem = (status, error, code, headers = {}) => json({ error, code }, status, headers);
