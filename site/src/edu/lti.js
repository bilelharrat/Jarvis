// Eden for Education as an LTI 1.3 tool (askeden ROADMAP Q12): Canvas, Moodle, Blackboard and other
// LTI Advantage platforms open Eden from a course, a professor links the LMS course to an Eden
// course (deep linking, or on first launch), and Names and Roles maps the LMS class list to course
// roles. Registration guide for the owner: JARVIS V1/docs/lti-registration.md. In the independent
// security review list (askeden ROADMAP Q12, launch gate).
//
// Routes (worker.js sends them here before its Origin and GET-only rules: the platform posts cross-site):
//   GET|POST /lti/login     OIDC third-party login initiation → state + nonce → the platform's auth endpoint
//   POST     /lti/launch    the platform's form_post: id_token (JWT) + state, checked in full below
//   GET|POST /lti/continue  after the launch, on askeden.com itself, signed in to Eden: join, link, sync, deep link
//   GET      /lti/jwks      the tool's public key (Worker secret LTI_PRIVATE_KEY; kid = its RFC 7638 thumbprint)
//   GET|POST /api/admin/lti the owner's server call (Bearer LTI_ADMIN_TOKEN): list, add, remove registrations
//
// Security, in order of the launch:
//   - login: the issuer and client id must be registered (by the owner), the deployment too when
//     given, and target_link_uri must be this site's /lti/launch. In an iframe (Sec-Fetch-Dest) the
//     page only offers "Open in a new tab": cookies in third-party frames are unreliable, and the
//     state cookie is what binds the launch to this browser.
//   - state: 32 random bytes, kept server-side under its SHA-256 for 10 minutes and taken once, and
//     also in a __Host- cookie (SameSite=None: the launch is a cross-site POST) that must match.
//   - nonce: 32 random bytes bound to that state; the id_token must carry it (so a token is used once).
//   - id_token: RS256 only (no "none", no HMAC), the key from the platform's registered JWKS by kid;
//     iss = the registration's issuer, aud contains the client id (azp = it when several), exp/iat
//     within a minute's skew and iat at most 10 minutes old, nbf, LTI version 1.3.0, a known message
//     type, the deployment id registered, sub present, target_link_uri this site.
//   - after: a ticket (server-side, 15 minutes, SHA-256 kept) in a SameSite=Lax __Host- cookie, never
//     in a URL. /lti/continue needs it, the Eden session (SameSite=Strict, so the page moves on with
//     a same-site navigation) and, to act, a same-origin POST carrying the ticket's CSRF value.
//   - roles come only from the signed token (context membership roles); the LMS course maps to an Eden
//     course only when that course's owner links it; an LMS user maps to one Eden account, first link wins.

import { ApiError, b64ToBytes, b64url, b64urlText, json, randomBytes, sha256Hex, validAccountId } from '../accounts/util.js';
import { cookie, cookies, clearCookie, sameOrigin } from '../eden/web.js';
import { limited } from '../accounts/index.js';

export const LTI = {
  version: '1.3.0',
  skewMs: 60_000,
  maxAgeMs: 10 * 60_000,
  jwksTtlMs: 10 * 60_000,
  rosterPages: 10,
  rosterMembers: 2000,
};
export const STATE_COOKIE = '__Host-eden-lti';
export const TICKET_COOKIE = '__Host-eden-lti-go';
const REGISTRY = 'lti:registry';
const C = 'https://purl.imsglobal.org/spec/lti/claim/';
const CLAIM = {
  messageType: `${C}message_type`, version: `${C}version`, deployment: `${C}deployment_id`, target: `${C}target_link_uri`,
  roles: `${C}roles`, context: `${C}context`, resourceLink: `${C}resource_link`, custom: `${C}custom`,
  dl: 'https://purl.imsglobal.org/spec/lti-dl/claim/deep_linking_settings',
  dlItems: 'https://purl.imsglobal.org/spec/lti-dl/claim/content_items', dlData: 'https://purl.imsglobal.org/spec/lti-dl/claim/data',
  nrps: 'https://purl.imsglobal.org/spec/lti-nrps/claim/namesroleservice',
};
export const NRPS_SCOPE = 'https://purl.imsglobal.org/spec/lti-nrps/scope/contextmembership.readonly';
const MESSAGES = new Set(['LtiResourceLinkRequest', 'LtiDeepLinkingRequest']);
const MEMBERSHIP = 'http://purl.imsglobal.org/vocab/lis/v2/membership';

const bad = (m) => new ApiError(400, 'bad_request', m);
const enc = new TextEncoder();

// ── small helpers ──

const isHttps = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' && !x.username && !x.password; } catch { return false; } };
const httpsOr = (u, what) => { if (!isHttps(u) || String(u).length > 1000) throw bad(`${what} must be an https address.`); return String(u); };
const cleanText = (t, max) => String(t ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
export const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function sameText(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}
const b64urlToBytes = (s) => b64ToBytes(String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(s).length / 4) * 4, '='));
const b64urlJson = (s) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b64urlToBytes(s)));

async function store(env, what, body = {}) {
  if (!env.COURSES) throw new ApiError(503, 'not_set_up', 'Eden for Education isn’t set up here.');
  const r = await env.COURSES.get(env.COURSES.idFromName(REGISTRY)).fetch(`https://course/${what}`, { method: 'POST', body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if (r.status >= 400) throw new ApiError(r.status, out.code || 'error', out.error || 'Something went wrong.');
  return out;
}
async function courseOp(env, name, what, body = {}) {
  if (body.account !== undefined && !validAccountId(body.account)) throw new ApiError(404, 'not_found', 'That course isn’t one you’re in.');
  const r = await env.COURSES.get(env.COURSES.idFromName(name)).fetch(`https://course/${what}`, { method: 'POST', body: JSON.stringify(body) });
  const out = await r.json().catch(() => ({}));
  if (r.status >= 400) throw new ApiError(r.status, out.code || 'error', out.error || 'Something went wrong.');
  return out;
}
const ctxKey = (t) => `${t.reg}|${t.deployment}|${t.context.id}`;
const userKey = (reg, sub) => `${reg}|${sub}`;

// ── keys: the tool's (a Worker secret), the platforms' (their JWKS) ──

let toolCache = null; // { pem, privateKey, jwk, kid }

/** The tool's signing key from LTI_PRIVATE_KEY (PKCS#8 PEM, RSA 2048+), its public JWK and kid; null when not set. */
export async function toolKey(env) {
  const pem = String(env.LTI_PRIVATE_KEY || '');
  if (!pem) return null;
  if (toolCache && toolCache.pem === pem) return toolCache;
  const der = b64ToBytes(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
  const alg = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
  const full = await crypto.subtle.importKey('pkcs8', der, alg, true, ['sign']);
  const priv = await crypto.subtle.exportKey('jwk', full);
  const privateKey = await crypto.subtle.importKey('pkcs8', der, alg, false, ['sign']);
  const kid = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`{"e":"${priv.e}","kty":"RSA","n":"${priv.n}"}`))));
  toolCache = { pem, privateKey, kid, jwk: { kty: 'RSA', n: priv.n, e: priv.e, alg: 'RS256', use: 'sig', kid } };
  return toolCache;
}

/** A JWT signed with the tool's key (RS256). */
export async function signJwt(env, payload) {
  const key = await toolKey(env);
  if (!key) throw new ApiError(503, 'not_set_up', 'The LTI key isn’t set up on askeden.com yet.');
  const head = b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: key.kid }));
  const body = b64urlText(JSON.stringify(payload));
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, enc.encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(sig)}`;
}

const jwksCache = new Map(); // url → { at, keys }
export const forgetPlatformKeys = () => jwksCache.clear();

async function platformKeys(url, f, now, force = false) {
  const hit = jwksCache.get(url);
  if (hit && !force && now - hit.at < LTI.jwksTtlMs) return hit.keys;
  if (hit && force && now - hit.at < 60_000) return hit.keys; // a missing kid refetches at most once a minute
  const r = await f(url, { headers: { accept: 'application/json' }, redirect: 'manual' });
  if (!r.ok) throw new ApiError(502, 'platform', 'Couldn’t read the school platform’s keys.');
  const body = await r.json().catch(() => null);
  const keys = body && Array.isArray(body.keys) ? body.keys.filter((k) => k && k.kty === 'RSA' && typeof k.n === 'string' && typeof k.e === 'string' && (!k.use || k.use === 'sig') && (!k.alg || k.alg === 'RS256')) : [];
  jwksCache.set(url, { at: now, keys });
  if (jwksCache.size > 200) jwksCache.delete(jwksCache.keys().next().value);
  return keys;
}

/** The platform's id_token, verified against its JWKS: its claims, or an ApiError. Signature and alg only; claims are checked by checkClaims. */
export async function verifyJwt(token, jwksUrl, { fetch: f = fetch, now = Date.now() } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]*$/.test(p)) || !parts[2]) throw bad('That launch isn’t a signed LTI token.');
  let head, claims;
  try { head = b64urlJson(parts[0]); claims = b64urlJson(parts[1]); } catch { throw bad('That launch isn’t a signed LTI token.'); }
  if (!head || head.alg !== 'RS256') throw bad('The launch token must be signed with RS256.');
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw bad('That launch isn’t a signed LTI token.');
  const pick = (keys) => (head.kid ? keys.find((k) => k.kid === head.kid) : keys.length === 1 ? keys[0] : null);
  let jwk = pick(await platformKeys(jwksUrl, f, now));
  if (!jwk && head.kid) jwk = pick(await platformKeys(jwksUrl, f, now, true));
  if (!jwk) throw new ApiError(401, 'bad_token', 'The launch was signed with a key the school platform doesn’t list.');
  const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new ApiError(401, 'bad_token', 'The launch token’s signature doesn’t check out.');
  return claims;
}

/** The LTI checks on a verified token's claims; returns the launch as Eden keeps it. */
export function checkClaims(claims, { reg, nonce, origin, now = Date.now() }) {
  const fail = (m) => { throw new ApiError(401, 'bad_token', m); };
  if (claims.iss !== reg.issuer) fail('The launch came from a different school platform than it started at.');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(reg.client_id)) fail('The launch wasn’t meant for Eden.');
  if ((aud.length > 1 || claims.azp !== undefined) && claims.azp !== reg.client_id) fail('The launch wasn’t meant for Eden.');
  const exp = Number(claims.exp) * 1000, iat = Number(claims.iat) * 1000;
  if (!Number.isFinite(exp) || exp <= now - LTI.skewMs) fail('The launch has expired. Open Eden from your course again.');
  if (!Number.isFinite(iat) || iat > now + LTI.skewMs || iat < now - LTI.maxAgeMs) fail('The launch has expired. Open Eden from your course again.');
  if (claims.nbf !== undefined && Number(claims.nbf) * 1000 > now + LTI.skewMs) fail('The launch isn’t valid yet.');
  if (typeof claims.nonce !== 'string' || !sameText(claims.nonce, nonce)) fail('The launch doesn’t match the sign-in it started with.');
  if (claims[CLAIM.version] !== LTI.version) fail('Eden speaks LTI 1.3.0.');
  const type = claims[CLAIM.messageType];
  if (!MESSAGES.has(type)) fail('Eden doesn’t handle that kind of launch.');
  const deployment = claims[CLAIM.deployment];
  if (typeof deployment !== 'string' || !reg.deployments.includes(deployment)) fail('This deployment of Eden isn’t registered. Ask your school to register it with Eden.');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255) fail('The launch has no user.');
  const target = claims[CLAIM.target];
  if (type === 'LtiResourceLinkRequest' && (typeof target !== 'string' || !target.startsWith(`${origin}/lti/`))) fail('The launch was meant for another tool.');
  if (type === 'LtiResourceLinkRequest' && !(claims[CLAIM.resourceLink] && typeof claims[CLAIM.resourceLink].id === 'string')) fail('The launch has no resource link.');
  const ctx = claims[CLAIM.context];
  if (!ctx || typeof ctx.id !== 'string' || !ctx.id || ctx.id.length > 255) fail('Open Eden from inside a course.');
  let dl = null;
  if (type === 'LtiDeepLinkingRequest') {
    const s = claims[CLAIM.dl];
    if (!s || !isHttps(s.deep_link_return_url)) fail('The platform didn’t say where to return.');
    if (Array.isArray(s.accept_types) && !s.accept_types.includes('ltiResourceLink')) fail('This placement doesn’t accept a link to Eden.');
    dl = { returnUrl: s.deep_link_return_url, ...(typeof s.data === 'string' ? { data: s.data.slice(0, 4096) } : {}) };
  }
  const nrps = claims[CLAIM.nrps] && isHttps(claims[CLAIM.nrps].context_memberships_url) ? claims[CLAIM.nrps].context_memberships_url : null;
  return {
    reg: reg.id, iss: reg.issuer, sub: claims.sub, deployment, kind: type === 'LtiDeepLinkingRequest' ? 'deeplink' : 'resource',
    role: roleOf(claims[CLAIM.roles]), name: cleanText(claims.name || [claims.given_name, claims.family_name].filter(Boolean).join(' '), 60),
    context: { id: ctx.id, title: cleanText(ctx.title || ctx.label || 'Your course', 120) }, nrps, dl, platform: cleanText(reg.name || 'your school’s platform', 60),
  };
}

/** The context role from LTI roles: 'instructor', 'ta' or 'learner' (only membership roles count; anything else is a learner). */
export function roleOf(roles) {
  const list = Array.isArray(roles) ? roles.map(String) : [];
  if (list.some((r) => r === `${MEMBERSHIP}/Instructor#TeachingAssistant` || r === `${MEMBERSHIP}#TeachingAssistant`)) return 'ta';
  if (list.some((r) => r === `${MEMBERSHIP}#Instructor` || r === `${MEMBERSHIP}#Administrator` || r === `${MEMBERSHIP}#ContentDeveloper`)) return 'instructor';
  return 'learner';
}

// ── registrations (the owner's) ──

export function cleanRegistration(body, id) {
  const b = body && typeof body === 'object' ? body : {};
  const issuer = httpsOr(cleanText(b.issuer, 1000), 'issuer');
  const client_id = cleanText(b.client_id, 255);
  if (!client_id) throw bad('client_id is the id the platform gave Eden.');
  const deployments = (Array.isArray(b.deployments) ? b.deployments : [b.deployments]).map((d) => cleanText(d, 255)).filter(Boolean).slice(0, 50);
  if (!deployments.length) throw bad('deployments lists the deployment ids (at least one).');
  return {
    id, name: cleanText(b.name, 80) || new URL(issuer).hostname, issuer, client_id, deployments,
    auth_url: httpsOr(b.auth_url, 'auth_url'), token_url: httpsOr(b.token_url, 'token_url'), jwks_url: httpsOr(b.jwks_url, 'jwks_url'),
    ...(b.token_aud ? { token_aud: cleanText(b.token_aud, 1000) } : {}),
    added: Date.now(),
  };
}

const toolUrls = (origin) => ({ login: `${origin}/lti/login`, redirect: `${origin}/lti/launch`, launch: `${origin}/lti/launch`, deep_link: `${origin}/lti/launch`, jwks: `${origin}/lti/jwks` });

/** GET/POST /api/admin/lti: the owner's server call (Bearer LTI_ADMIN_TOKEN, no browser). */
export async function ltiAdmin(request, env) {
  try {
    const secret = String(env.LTI_ADMIN_TOKEN || '');
    if (secret.length < 24 || !env.COURSES) throw new ApiError(503, 'not_set_up', 'LTI isn’t set up here yet.');
    if (request.headers.get('origin')) throw new ApiError(403, 'forbidden', 'Not from a web page.');
    const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
    if (!bearer || !sameText(bearer[1], secret)) throw new ApiError(401, 'unauthorized', 'No.');
    const origin = new URL(request.url).origin;
    if (request.method === 'GET') return json({ tool: { ...toolUrls(origin), key: Boolean(await toolKey(env)) }, ...(await store(env, 'lti-reg-list')) });
    if (request.method !== 'POST') throw new ApiError(405, 'method', 'GET or POST.');
    const body = await request.json().catch(() => ({}));
    if (body.action === 'delete') return json(await store(env, 'lti-reg-delete', { id: String(body.id || '') }));
    if (body.action !== 'put') throw bad('action is "put" or "delete".');
    const id = body.id ? String(body.id) : b64url(randomBytes(12));
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(id)) throw bad('id is 8–40 letters, digits, - or _.');
    return json(await store(env, 'lti-reg-put', { reg: cleanRegistration(body, id) }));
  } catch (error) {
    if (error instanceof ApiError) return error.response();
    throw error;
  }
}

// ── pages ──

const PAGE_CSP = (formTo = "'self'", frame = "'none'") => `default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action ${formTo}; frame-ancestors ${frame}`;
const STYLE = 'body{font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;background:#f6f5f2;color:#1d1d1f}main{max-width:520px;margin:48px auto;padding:28px;background:#fff;border-radius:16px;box-shadow:0 2px 12px #0001}h1{font-size:22px;margin:0 0 8px}p{margin:8px 0}.muted{color:#6e6e73;font-size:14px}button,a.btn{display:inline-block;font:inherit;padding:10px 18px;border-radius:10px;border:0;background:#1f6f5c;color:#fff;text-decoration:none;cursor:pointer;margin:6px 6px 0 0}button.alt,a.alt{background:#e8e8ed;color:#1d1d1f}label{display:block;margin:10px 0}.row{display:flex;gap:8px;align-items:center;padding:8px 0;border-top:1px solid #eee}.err{color:#b3261e}@media(prefers-color-scheme:dark){body{background:#111;color:#f2f2f7}main{background:#1c1c1e;box-shadow:none}.muted{color:#a1a1a6}.row{border-color:#333}button.alt,a.alt{background:#333;color:#f2f2f7}}';

export function htmlPage(title, inner, { status = 200, csp = PAGE_CSP(), headers = {}, frame = false } = {}) {
  const h = new Headers({ 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', ...(frame ? {} : { 'x-frame-options': 'DENY' }) });
  for (const [k, v] of Object.entries(headers)) for (const one of [].concat(v)) h.append(k, one);
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Eden for Education</title><style>${STYLE}</style></head><body><main>${inner}</main></body></html>`, { status, headers: h });
}
const problemPage = (message, status = 400) => htmlPage('Couldn’t open Eden', `<h1>Couldn’t open Eden</h1><p class="err">${esc(message)}</p><p class="muted">Go back to your course and open Eden again. If it keeps happening, tell your professor or school.</p>`, { status });

async function formParams(request) {
  if (request.method === 'GET') return new URL(request.url).searchParams;
  const type = request.headers.get('content-type') || '';
  if (!/^application\/x-www-form-urlencoded\b/i.test(type)) throw bad('Send a form.');
  const text = await request.text();
  if (text.length > 64 * 1024) throw bad('That form is too big.');
  return new URLSearchParams(text);
}

// ── the routes ──

/** /lti/*: login initiation, launch, continue, JWKS. `deps`: { session(request, env) → { session }, fetch, now } for tests. */
export async function ltiRoute(request, env, ctx, path, deps = {}) {
  const f = deps.fetch || fetch;
  const now = deps.now ? deps.now() : Date.now();
  const origin = new URL(request.url).origin;
  try {
    if (path === '/lti/jwks' && request.method === 'GET') {
      const key = await toolKey(env);
      return json(key ? { keys: [key.jwk] } : { keys: [] }, key ? 200 : 503, { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' });
    }
    const ip = request.headers.get('cf-connecting-ip') || 'unknown';
    // logins write a state: limited per network (120 a minute; a class behind one school address fits); a launch needs a state already
    if (path === '/lti/login' && (request.method === 'GET' || request.method === 'POST')) { await limited(env, 'API_RATE', `lti-login:${ip}`); return await login(request, env, origin); }
    if (path === '/lti/launch' && request.method === 'POST') return await launch(request, env, origin, { fetch: f, now });
    if (path === '/lti/continue' && (request.method === 'GET' || request.method === 'POST')) return await carryOn(request, env, origin, { ...deps, fetch: f, now });
    return htmlPage('Not found', '<h1>Not found</h1>', { status: 404 });
  } catch (error) {
    if (error instanceof ApiError) return problemPage(error.message, error.status);
    console.error('lti failed', error && error.stack);
    return problemPage('Something went wrong on askeden.com.', 500);
  }
}

async function findReg(env, issuer, clientId) {
  const { regs } = await store(env, 'lti-reg-list');
  const hits = regs.filter((r) => r.issuer === issuer && (!clientId || r.client_id === clientId));
  return hits.length === 1 ? hits[0] : null;
}

async function login(request, env, origin) {
  const p = await formParams(request);
  const iss = cleanText(p.get('iss'), 1000);
  const loginHint = String(p.get('login_hint') || '');
  const target = String(p.get('target_link_uri') || '');
  const clientId = p.get('client_id') ? cleanText(p.get('client_id'), 255) : null;
  const deployment = p.get('lti_deployment_id') ? cleanText(p.get('lti_deployment_id'), 255) : null;
  const messageHint = p.get('lti_message_hint');
  if (!isHttps(iss) || !loginHint || loginHint.length > 2048 || (messageHint && messageHint.length > 4096)) throw bad('That isn’t an LTI login.');
  if (!target.startsWith(`${origin}/lti/`)) throw bad('That launch was meant for another tool.');
  const reg = await findReg(env, iss, clientId);
  if (!reg) throw new ApiError(403, 'not_registered', 'Your school’s platform isn’t registered with Eden yet. Ask your school to register Eden for Education.');
  if (deployment && !reg.deployments.includes(deployment)) throw new ApiError(403, 'not_registered', 'This deployment of Eden isn’t registered. Ask your school to register it with Eden.');
  // in a frame: open a new tab, where the state cookie works (third-party cookies in frames often don't)
  if (['iframe', 'frame'].includes(request.headers.get('sec-fetch-dest'))) {
    const again = new URL(`${origin}/lti/login`);
    for (const [k, v] of [['iss', iss], ['login_hint', loginHint], ['target_link_uri', target], ['client_id', clientId], ['lti_deployment_id', deployment], ['lti_message_hint', messageHint]]) if (v) again.searchParams.set(k, v);
    return htmlPage('Open Eden', `<h1>Eden for Education</h1><p>Eden opens in its own tab, so it can keep you signed in.</p><a class="btn" href="${esc(again.toString())}" target="_blank" rel="noopener">Open Eden in a new tab</a>`, { csp: PAGE_CSP("'none'", 'https:'), frame: true });
  }
  const state = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(32));
  await store(env, 'lti-state-put', { hash: await sha256Hex(`lti-state:${state}`), data: { reg: reg.id, nonce } });
  const auth = new URL(reg.auth_url);
  const q = { scope: 'openid', response_type: 'id_token', response_mode: 'form_post', prompt: 'none', client_id: reg.client_id, redirect_uri: `${origin}/lti/launch`, login_hint: loginHint, state, nonce, ...(messageHint ? { lti_message_hint: messageHint } : {}) };
  for (const [k, v] of Object.entries(q)) auth.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { location: auth.toString(), 'cache-control': 'no-store', 'set-cookie': cookie(STATE_COOKIE, state, { maxAge: 600, sameSite: 'None' }) } });
}

async function launch(request, env, origin, { fetch: f, now }) {
  const p = await formParams(request);
  if (p.get('error')) throw new ApiError(400, 'platform', `Your school’s platform said: ${cleanText(p.get('error_description') || p.get('error'), 200)}`);
  const state = String(p.get('state') || '');
  const idToken = String(p.get('id_token') || '');
  if (!state || state.length > 200 || !idToken || idToken.length > 32 * 1024) throw bad('That isn’t an LTI launch.');
  const held = cookies(request)[STATE_COOKIE];
  if (!held || !sameText(held, state)) throw new ApiError(401, 'bad_state', 'This browser didn’t start that launch. Open Eden from your course again (in a new tab if your browser blocks cookies).');
  const { data } = await store(env, 'lti-state-take', { hash: await sha256Hex(`lti-state:${state}`) });
  if (!data) throw new ApiError(401, 'bad_state', 'That launch has expired or was used already. Open Eden from your course again.');
  const { reg } = await store(env, 'lti-reg-get', { id: data.reg });
  if (!reg) throw new ApiError(403, 'not_registered', 'Your school’s platform isn’t registered with Eden any more.');
  const claims = await verifyJwt(idToken, reg.jwks_url, { fetch: f, now });
  const t = checkClaims(claims, { reg, nonce: data.nonce, origin, now });
  const ticket = b64url(randomBytes(32));
  await store(env, 'lti-ticket-put', { hash: await sha256Hex(`lti-ticket:${ticket}`), data: { ...t, csrf: b64url(randomBytes(18)) } });
  // on to this site's own page: a same-site navigation, so the Eden session cookie (SameSite=Strict) goes with it
  return htmlPage('Opening Eden', `<h1>Opening Eden…</h1><p><a class="btn" href="/lti/continue">Continue</a></p>`, {
    headers: { refresh: '0; url=/lti/continue', 'set-cookie': [clearCookie(STATE_COOKIE, 'None'), cookie(TICKET_COOKIE, ticket, { maxAge: 900, sameSite: 'Lax' })] },
  });
}

/** The roles an Eden course gives an LMS role: instructors and TAs → 'ta' (the Eden owner stays owner), learners → 'student'. */
export const edenRoleFor = (ltiRole) => (ltiRole === 'learner' ? 'student' : 'ta');

async function carryOn(request, env, origin, deps) {
  const ticket = cookies(request)[TICKET_COOKIE];
  if (!ticket) throw new ApiError(401, 'no_launch', 'Open Eden from your course first.');
  const hash = await sha256Hex(`lti-ticket:${ticket}`);
  const { data: t } = await store(env, 'lti-ticket-get', { hash });
  if (!t) throw new ApiError(401, 'no_launch', 'That launch has expired. Open Eden from your course again.');
  const sessionOf = deps.session || (async (req, e) => (await import('../eden/session.js')).currentSession(req, e));
  const { session } = await sessionOf(request, env);
  if (!session || !validAccountId(session.account)) {
    if (request.method === 'POST') throw new ApiError(401, 'signed_out', 'Sign in to Eden first.');
    return new Response(null, { status: 302, headers: { location: '/signin?return=%2Flti%2Fcontinue', 'cache-control': 'no-store' } });
  }
  const account = session.account;
  const linked = (await store(env, 'lti-user-get', { key: userKey(t.reg, t.sub) })).user;
  if (linked && linked.account !== account) throw new ApiError(409, 'linked_elsewhere', `Your ${t.platform} account is already connected to a different Eden account. Sign out of Eden and sign in with that one.`);
  const link = (await store(env, 'lti-ctx-get', { key: ctxKey(t) })).link;
  if (request.method === 'POST') {
    if (!sameOrigin(request)) throw new ApiError(403, 'forbidden', 'Only askeden.com’s own page may do that.');
    const p = await formParams(request);
    if (!sameText(p.get('csrf') || '', t.csrf)) throw new ApiError(403, 'forbidden', 'That form is out of date. Open Eden from your course again.');
    return await act(env, origin, { t, hash, account, link, p, deps });
  }
  return htmlPage('Eden for Education', await screen(env, { t, account, link }));
}

async function ownedCourses(env, account) {
  const { ids } = await courseOp(env, `acct:${account}`, 'index-acct-list');
  const out = [];
  for (const id of ids) {
    const v = await courseOp(env, id, 'view', { account }).catch(() => null);
    if (v && v.role === 'owner') out.push({ id: v.id, name: v.name, term: v.term });
  }
  return out;
}
const roleIn = (env, course, account) => courseOp(env, course, 'ping', { account }).then((r) => r.role, () => null);

async function screen(env, { t, account, link }) {
  const csrf = `<input type="hidden" name="csrf" value="${esc(t.csrf)}">`;
  const head = `<h1>${esc(t.context.title)}</h1><p class="muted">Opened from ${esc(t.platform)}.</p>`;
  const choose = (action, label) => async () => {
    const mine = await ownedCourses(env, account);
    if (!mine.length) return `<p>You don’t have an Eden course yet. <a href="/edu">Make one in Eden for Education</a>, then open Eden from ${esc(t.platform)} again.</p>`;
    return `<form method="post" action="/lti/continue">${csrf}<input type="hidden" name="action" value="${action}"><p>${esc(label)}</p>${mine.map((c, i) => `<label class="row"><input type="radio" name="course" value="${esc(c.id)}"${i === 0 ? ' checked' : ''}> ${esc(c.name)}${c.term ? ` <span class="muted">${esc(c.term)}</span>` : ''}</label>`).join('')}<button type="submit">${action === 'deeplink' ? `Add to ${esc(t.platform)}` : 'Connect'}</button></form>`;
  };
  if (t.kind === 'deeplink') {
    if (t.role === 'learner') return `${head}<p>Only the course’s instructors can add Eden here.</p>`;
    return `${head}${await choose('deeplink', `Which Eden course should “${t.context.title}” open?`)()}`;
  }
  if (!link) {
    if (t.role === 'learner') return `${head}<p>Your professor hasn’t connected this course to Eden yet. Check back after they have.</p>`;
    return `${head}${await choose('link', `Connect “${t.context.title}” to one of your Eden courses. Students who open Eden here will join it.`)()}`;
  }
  const role = await roleIn(env, link.course, account);
  const open = `<a class="btn" href="/edu#/course/${esc(link.course)}">Open the course in Eden</a>`;
  if (role === 'owner') {
    const sync = t.nrps ? `<form method="post" action="/lti/continue">${csrf}<input type="hidden" name="action" value="sync"><p class="muted">Students and TAs who have opened Eden from ${esc(t.platform)} get their roles from the class list.</p><button class="alt" type="submit">Sync the class list from ${esc(t.platform)}</button></form>` : '';
    return `${head}<p>This course opens your Eden course.</p>${open}${sync}`;
  }
  if (role) return `${head}${open}`;
  const age = t.role === 'learner' ? '<label><input type="checkbox" name="age13" value="yes" required> I’m 13 or older, and I’ve read the <a href="/edu/privacy" target="_blank" rel="noopener">student privacy notice</a>.</label>' : '';
  return `${head}<form method="post" action="/lti/continue">${csrf}<input type="hidden" name="action" value="join"><p>Join the Eden course for “${esc(t.context.title)}”${t.role === 'learner' ? '' : ' as a TA'}. Your professor sees the name ${esc(t.name || 'you give')}, never your questions.</p>${age}<button type="submit">Join</button></form>`;
}

async function act(env, origin, { t, hash, account, link, p, deps }) {
  const action = p.get('action');
  const done = (inner) => htmlPage('Eden for Education', inner);
  if (action === 'link' || action === 'deeplink') {
    if (t.role === 'learner') throw new ApiError(403, 'forbidden', 'Only the course’s instructors can do that.');
    if (action !== (t.kind === 'deeplink' ? 'deeplink' : 'link')) throw bad('That isn’t what this launch was for.');
    const course = String(p.get('course') || '');
    if (!/^[A-Za-z0-9_-]{22}$/.test(course) || (await roleIn(env, course, account)) !== 'owner') throw new ApiError(403, 'forbidden', 'Only the Eden course’s professor can connect it.');
    if (link && link.course !== course && (await roleIn(env, link.course, account)) !== 'owner') throw new ApiError(409, 'taken', 'This course is connected to another professor’s Eden course.');
    await store(env, 'lti-user-put', { key: userKey(t.reg, t.sub), account });
    await store(env, 'lti-ctx-put', { key: ctxKey(t), course, by: account });
    if (action === 'link') {
      await store(env, 'lti-ticket-delete', { hash });
      return done(`<h1>Connected</h1><p>Students who open Eden from “${esc(t.context.title)}” now join your Eden course.</p><a class="btn" href="/edu#/course/${esc(course)}">Open the course in Eden</a>`);
    }
    const view = await courseOp(env, course, 'view', { account });
    const { reg } = await store(env, 'lti-reg-get', { id: t.reg });
    const jwt = await signJwt(env, {
      iss: reg.client_id, aud: [reg.issuer], iat: Math.floor(deps.now / 1000), exp: Math.floor(deps.now / 1000) + 300, nonce: b64url(randomBytes(16)),
      [CLAIM.deployment]: t.deployment, [CLAIM.messageType]: 'LtiDeepLinkingResponse', [CLAIM.version]: LTI.version,
      [CLAIM.dlItems]: [{ type: 'ltiResourceLink', title: `Eden: ${view.name}`, text: 'Study this course with Eden: answers from your professor’s materials, with sources.', url: `${origin}/lti/launch` }],
      ...(t.dl.data !== undefined ? { [CLAIM.dlData]: t.dl.data } : {}),
    });
    await store(env, 'lti-ticket-delete', { hash });
    const back = new URL(t.dl.returnUrl);
    return htmlPage('Eden for Education', `<h1>Ready</h1><p>“${esc(view.name)}” will open from ${esc(t.platform)}.</p><form method="post" action="${esc(t.dl.returnUrl)}"><input type="hidden" name="JWT" value="${esc(jwt)}"><button type="submit">Finish in ${esc(t.platform)}</button></form>`, { csp: PAGE_CSP(`'self' ${back.origin}`) });
  }
  if (!link) throw new ApiError(409, 'not_linked', 'This course isn’t connected to Eden yet.');
  if (action === 'join') {
    if (t.role === 'learner' && p.get('age13') !== 'yes') throw bad('Eden for Education is for people 13 and older. Confirm your age to join.');
    await store(env, 'lti-user-put', { key: userKey(t.reg, t.sub), account });
    if (!(await roleIn(env, link.course, account))) {
      await courseOp(env, `acct:${account}`, 'index-acct-add', { course: link.course });
      await courseOp(env, link.course, 'join', { account, label: t.name || undefined });
      if (edenRoleFor(t.role) === 'ta') await courseOp(env, link.course, 'member-role', { account: link.by, id: (await sha256Hex(`${link.course}:${account}`)).slice(0, 16), role: 'ta' }).catch(() => {}); // the linking professor promotes; if they no longer own it, a student
    }
    await store(env, 'lti-ticket-delete', { hash });
    return new Response(null, { status: 303, headers: { location: `/edu#/course/${link.course}`, 'cache-control': 'no-store', 'set-cookie': clearCookie(TICKET_COOKIE, 'Lax') } });
  }
  if (action === 'sync') {
    if (t.role === 'learner' || !t.nrps) throw new ApiError(403, 'forbidden', 'Only the course’s instructors can do that.');
    if ((await roleIn(env, link.course, account)) !== 'owner') throw new ApiError(403, 'forbidden', 'Only the Eden course’s professor can sync its class list.');
    const { reg } = await store(env, 'lti-reg-get', { id: t.reg });
    const out = await syncRoster(env, { reg, t, course: link.course, owner: account, fetch: deps.fetch, now: deps.now });
    return done(`<h1>Class list synced</h1><p>${out.members} people in ${esc(t.platform)}; ${out.linked} have opened Eden. ${out.added} joined the Eden course and ${out.promoted} became TAs.</p><p class="muted">People who haven’t opened Eden yet join when they first open it from ${esc(t.platform)}. Nobody is removed automatically.</p><a class="btn" href="/edu#/course/${esc(link.course)}/class">Open the class list</a>`);
  }
  throw bad('That isn’t something Eden can do here.');
}

// ── Names and Roles (NRPS 2.0) ──

/** An access token from the platform: client credentials with a JWT signed by the tool's key. */
export async function platformToken(env, reg, scope, { fetch: f = fetch, now = Date.now() } = {}) {
  const assertion = await signJwt(env, { iss: reg.client_id, sub: reg.client_id, aud: reg.token_aud || reg.token_url, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 300, jti: b64url(randomBytes(16)) });
  const r = await f(reg.token_url, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion, scope }).toString(),
  });
  const out = await r.json().catch(() => null);
  if (!r.ok || !out || typeof out.access_token !== 'string') throw new ApiError(502, 'platform', 'The school platform didn’t give Eden access to the class list. Check that Names and Roles is on for Eden.');
  return out.access_token;
}

/** The class list (active members: { user_id, roles, name }), following "next" links. */
export async function memberships(url, token, { fetch: f = fetch } = {}) {
  const out = [];
  let next = url;
  for (let page = 0; next && page < LTI.rosterPages && out.length < LTI.rosterMembers; page++) {
    if (!isHttps(next)) break;
    const r = await f(next, { headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.ims.lti-nrps.v2.membershipcontainer+json' }, redirect: 'manual' });
    if (!r.ok) throw new ApiError(502, 'platform', 'Couldn’t read the class list from the school platform.');
    const body = await r.json().catch(() => null);
    for (const m of (body && Array.isArray(body.members) ? body.members : [])) {
      if (!m || typeof m.user_id !== 'string' || !m.user_id || m.user_id.length > 255) continue;
      if (m.status && m.status !== 'Active') continue;
      out.push({ user_id: m.user_id, roles: Array.isArray(m.roles) ? m.roles : [], name: cleanText(m.name || [m.given_name, m.family_name].filter(Boolean).join(' '), 60) });
    }
    const linkHeader = r.headers.get('link') || '';
    const m = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(linkHeader);
    next = m ? m[1] : null;
  }
  return out.slice(0, LTI.rosterMembers);
}

/** Sync an Eden course's roles from the LMS class list: linked LMS users join; instructors and TAs become TAs. Nobody is removed. */
export async function syncRoster(env, { reg, t, course, owner, fetch: f = fetch, now = Date.now() }) {
  const token = await platformToken(env, reg, NRPS_SCOPE, { fetch: f, now });
  const members = await memberships(t.nrps, token, { fetch: f });
  const accounts = {};
  for (let i = 0; i < members.length; i += 128) {
    const keys = members.slice(i, i + 128).map((m) => userKey(reg.id, m.user_id));
    Object.assign(accounts, (await store(env, 'lti-users-get', { keys })).users);
  }
  let linked = 0, added = 0, promoted = 0;
  for (const m of members) {
    const account = accounts[userKey(reg.id, m.user_id)];
    if (!account || account === owner) { if (account) linked++; continue; }
    linked++;
    let role = await roleIn(env, course, account);
    if (!role) {
      try {
        await courseOp(env, `acct:${account}`, 'index-acct-add', { course });
        await courseOp(env, course, 'join', { account, label: m.name || undefined });
        role = 'student';
        added++;
      } catch { continue; } // their course list is full: they can still join from the LMS
    }
    if (edenRoleFor(roleOf(m.roles)) === 'ta' && role === 'student') {
      await courseOp(env, course, 'member-role', { account: owner, id: (await sha256Hex(`${course}:${account}`)).slice(0, 16), role: 'ta' });
      promoted++;
    }
  }
  const counts = { members: members.length, linked, added, promoted };
  await store(env, 'lti-roster-put', { key: ctxKey(t), counts });
  return counts;
}
