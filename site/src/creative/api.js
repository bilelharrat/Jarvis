// askeden.com's door for the Eden Creative Suite's Mac apps (Scorsese first): docs/creative-api.md is the contract.
//
//   GET  /creative/link              the approval page, for a browser signed in to Eden (else "sign in first")
//   POST /api/creative/link          its form (same origin, the session cookie): Link → 303 to
//                                    edenstudio-<app>://link?ticket=…, the scheme of the app that asked only
//   POST /api/creative/token         { ticket, verifier } → the app's token for the `creative` service
//   POST /api/creative/revoke        the token stops at once (also from askeden.com › Account › Connected apps)
//   GET  /api/creative/me            name, plan (and whether it's paid for), usage as askeden.com shows it, and more
//   POST /api/creative/eden          one model turn, streamed; the app's tools passed to the model, never run here
//   POST /api/creative/eves          EVES as askeden.com has it: today not on its servers, for any plan (503)
//   POST /api/creative/quote         a price for generated media, before anything runs
//   POST /api/creative/jobs          the quoted job; GET /api/creative/jobs/:id its progress; …/result the file
//
// The link is the site's scoped-token machinery (accounts/scoped.js, client `creative`), as Eden Messenger's @Eden is
// (eden/ask.js): a two-minute ticket bound to a PKCE challenge, sent only to the suite's own scheme, redeemed once for a
// token kept hashed in the account's object and good for nothing but the `creative-*` ops (ops.js). Every app route
// checks the token there first, and where it costs, that the account's allowance can pay: any askeden.com account,
// on the same allowance and meter as askeden.com's chat (ops.js). A token is one suite app's: a request naming another
// app is refused. The rate limits are the site's own (API_RATE, AUTH_RATE): the network first, and the account only
// once its token is checked (never an account named in a token nobody has verified), under `creative:` keys.
// The app routes take no browser: a request with an Origin is refused (no CORS). Nothing asked is stored or logged.

import { call, clientIp, limited } from '../accounts/index.js';
import { SCOPED, makeScopedToken, parseConnectCode, parseScopedToken, retiredBy } from '../accounts/scoped.js';
import { ApiError, webAllowed } from '../accounts/util.js';
import { currentSession } from '../eden/session.js';
import { json, page, problem, sameOrigin } from '../eden/web.js';
import { MEDIA, parseMedia, priceFor, specHash } from './media.js';
import { EVES } from './ops.js';
import { APPS, edenTurn } from './turn.js';

// Each suite app's own scheme: macOS hands a URL scheme to one app only, and the PKCE verifier is in the app that
// started the link, so the ticket goes back to that app's scheme. `app` is from APPS (a fixed list), never raw.
export const callbackFor = (app) => (Object.hasOwn(APPS, app) ? `edenstudio-${app}://link` : null);
const CLIENT = 'creative';
const LIMITS = { turnBytes: 8 * 1024 * 1024, mediaBytes: 6 * 1024 * 1024, smallBytes: 16 * 1024, deviceChars: 60 };
const STATE = /^[A-Za-z0-9._~-]{8,200}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

// ── the approval page ──

const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cleanDevice = (raw) => {
  let d = String(raw || '').replace(/[\u0000-\u001f\u007f<>"'`\\]/g, '').trim().slice(0, LIMITS.deviceChars);
  if (/[\uD800-\uDBFF]$/.test(d)) d = d.slice(0, -1);
  return d;
};

/** A link request's parameters checked; { error } with words for a person otherwise. */
export function linkRequest(params) {
  const get = (name) => (typeof params.get === 'function' ? params.get(name) : params[name]) ?? '';
  const app = String(get('app'));
  const state = String(get('state'));
  const challenge = String(get('code_challenge'));
  if (!Object.hasOwn(APPS, app)) return { error: 'This link names an app Eden doesn’t know.' };
  if (!STATE.test(state)) return { error: 'This link is missing its state.' };
  if (!CHALLENGE.test(challenge) || String(get('code_challenge_method')) !== 'S256') return { error: 'This link is missing its PKCE challenge.' };
  return { app, name: APPS[app], state, challenge, device: cleanDevice(get('device')) };
}

const linkQuery = (req) => new URLSearchParams({ app: req.app, state: req.state, code_challenge: req.challenge, code_challenge_method: 'S256', ...(req.device ? { device: req.device } : {}) });
// the form may post here and go on to this app's scheme only (none on a page without a form)
const linkCsp = (app) => `default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'${callbackFor(app) ? ` edenstudio-${app}:` : ''}; base-uri 'none'; frame-ancestors 'none'`;

function shell(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)}</title>
<link rel="icon" type="image/svg+xml" href="/jarvis/eden-logo.svg">
<link rel="stylesheet" href="/signin/signin.css">
</head>
<body>
<a class="home" href="/">‹ askeden.com</a>
<main class="card" aria-labelledby="title">
  <div class="orb" aria-hidden="true"></div>
${body}
</main>
</body>
</html>`;
}

const day = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** What Link would unlink (this app's oldest, past its cap), said before the person agrees. */
function replacingHtml(name, replacing) {
  if (!replacing.length) return '';
  const which = replacing.map((c) => `<b>${esc(c.label || name)}</b>, linked ${esc(day(c.created))}`).join('; ');
  return `  <p class="alert">${name} can be linked on ${SCOPED.max} Macs at most. Linking this one unlinks the oldest: ${which}.</p>\n`;
}

/** The page's HTML (exported for the tests). */
export function linkHtml({ request: req, signedIn = false, email = '', error = '', replacing = [] }) {
  if (error) {
    return shell('Can’t link', `  <h1 id="title">Can’t link</h1>
  <p class="lead">${esc(error)}</p>
  <p class="fine">Start again from the app: Settings › Eden › Link to Eden.</p>`);
  }
  const name = esc(req.name);
  if (!signedIn) {
    const again = `/creative/link?${linkQuery(req)}`;
    return shell('Sign in to Eden', `  <h1 id="title">Sign in to Eden first</h1>
  <p class="lead">${name} wants to link to your Eden account.</p>
  <p><a class="button" href="/signin?return=${esc(encodeURIComponent(again))}">Sign in to Eden</a></p>
  <p class="fine">You’ll come back here to link once you’re signed in.</p>`);
  }
  const hidden = { app: req.app, state: req.state, code_challenge: req.challenge, code_challenge_method: 'S256', ...(req.device ? { device: req.device } : {}) };
  const inputs = Object.entries(hidden).map(([k, v]) => `    <input type="hidden" name="${k}" value="${esc(v)}">`).join('\n');
  return shell(`Link ${req.name}`, `  <h1 id="title">Link ${name} to Eden?</h1>
  <p class="lead">${name}${req.device ? ` on ${esc(req.device)}` : ''} will use Eden with your account${email ? `, <b>${esc(email)}</b>` : ''}.</p>
  <p class="alert">Eden sees only what ${name} sends it from your project, and uses your Eden account’s included AI, the same allowance as Eden here. It shows a price before it makes any clip or voice-over. It can’t read your Eden chats, mail, calendar, notes or account.</p>
${replacingHtml(name, replacing)}  <form method="post" action="/api/creative/link">
${inputs}
    <p><button class="button ghost" type="submit" name="decision" value="deny">Cancel</button> <button class="button" type="submit" name="decision" value="allow">Link</button></p>
  </form>
  <p class="fine">Unlink any time in ${name}, or here in Account › Connected apps. The link lasts a year.</p>`);
}

function htmlPage(html, status = 200, app = null) {
  const response = page(new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } }), linkCsp(app));
  response.headers.set('vary', 'cookie');
  return response;
}

/** GET /creative/link. */
export async function creativeLinkPage(request, env, url) {
  const req = linkRequest(url.searchParams);
  if (req.error) return htmlPage(linkHtml({ error: req.error }), 400);
  const { session } = env.ACCOUNTS ? await currentSession(request, env) : { session: null };
  let email = '';
  let replacing = [];
  if (session) {
    const view = await call(env, session.account, 'get', {}, session.token).catch(() => null);
    email = (view?.identities || []).map((i) => i.email).find(Boolean) || '';
    const listed = await call(env, session.account, 'scoped-list', {}, session.token).catch(() => null);
    replacing = retiredBy(listed?.connections || [], CLIENT, req.app);
  }
  return htmlPage(linkHtml({ request: req, signedIn: Boolean(session), email, replacing }), 200, req.app);
}

const seeOther = (location) => new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
const backTo = (req, fields) => `${callbackFor(req.app)}?${new URLSearchParams({ ...fields, state: req.state })}`;

/** POST /api/creative/link: the approval page's own form. */
async function approve(request, env) {
  if (request.method !== 'POST') throw new ApiError(405, 'bad_request', 'POST only.');
  if (!sameOrigin(request)) throw new ApiError(403, 'forbidden', 'Not from another site.');
  const form = new URLSearchParams(await request.text());
  const req = linkRequest(form);
  if (req.error) return htmlPage(linkHtml({ error: req.error }), 400);
  if (form.get('decision') !== 'allow') return seeOther(backTo(req, { error: 'access_denied' }));
  const { session } = await currentSession(request, env, { fresh: true });
  if (!session) return seeOther(`/creative/link?${linkQuery(req)}`);
  if (!webAllowed(env, session.account)) throw new ApiError(403, 'forbidden', 'This Eden account can’t use Eden yet.');
  await limited(env, 'AUTH_RATE', `creative-link:${clientIp(request)}`);
  const label = req.device ? `${req.name} on ${req.device}` : req.name;
  const { code } = await call(env, session.account, 'scoped-code', { client: CLIENT, scope: CLIENT, redirect_uri: callbackFor(req.app), challenge: req.challenge, app: req.app, label }, session.token);
  return seeOther(backTo(req, { ticket: `${session.account}.${code}` }));
}

// ── the app's routes ──

async function readJsonBody(request, cap) {
  if (!/^application\/json\b/i.test(request.headers.get('content-type') || '')) throw new ApiError(415, 'bad_request', 'Send JSON (content-type: application/json).');
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) throw new ApiError(413, 'too_big', 'That request is too big.');
  const text = await request.text();
  if (text.length > cap) throw new ApiError(413, 'too_big', 'That request is too big.');
  try {
    const value = JSON.parse(text || '{}');
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    // below
  }
  throw new ApiError(400, 'bad_request', 'Send a JSON object.');
}

/** The scoped token on this request: { account, id, secret }, or the 401 the app understands ("link again"). */
function bearer(request, env) {
  const auth = /^Bearer\s+(\S+)$/i.exec(request.headers.get('authorization') || '');
  const token = auth ? parseScopedToken(auth[1]) : null;
  if (!token) throw new ApiError(401, 'not_connected', 'Link this app to Eden first.');
  if (!webAllowed(env, token.account)) throw new ApiError(403, 'forbidden', 'This Eden account can’t use Eden yet.');
  return token;
}

const scoped = (who, extra = {}) => ({ id: who.id, secret: who.secret, ...extra });

async function token(request, env) {
  await limited(env, 'AUTH_RATE', `creative-token:${clientIp(request)}`);
  const body = await readJsonBody(request, LIMITS.smallBytes);
  const code = parseConnectCode(body.ticket);
  const redirect = callbackFor(body.app); // the ticket was made for this app's scheme, or it isn't redeemed
  if (!redirect) throw new ApiError(400, 'bad_request', `app is one of ${Object.keys(APPS).join(', ')}`);
  if (!code) throw new ApiError(400, 'invalid_grant', 'That link ticket isn’t right. Link again.');
  if (!webAllowed(env, code.account)) throw new ApiError(403, 'forbidden', 'This Eden account can’t use Eden yet.');
  const minted = await call(env, code.account, 'scoped-redeem', { code: code.secret, client: CLIENT, redirect_uri: redirect, verifier: String(body.verifier || '') });
  return json({
    token: makeScopedToken(code.account, minted.id, minted.secret),
    token_type: 'Bearer',
    scope: minted.scope,
    connection: { id: minted.id, app: minted.app || null, created: minted.created ?? null, expires_at: minted.expires },
    // this app's oldest links, retired to make room (at most SCOPED.max per app): the app says which Macs were unlinked
    unlinked: (minted.unlinked || []).map((c) => ({ id: c.id, app: c.app || null, label: c.label || null, created: c.created ?? null, last_used: c.last_used ?? null })),
  });
}

async function revoke(request, env) {
  const who = bearer(request, env);
  await call(env, who.account, 'scoped-revoke', scoped(who)).catch((error) => {
    if (!(error instanceof ApiError && error.status === 401)) throw error; // already gone: fine
  });
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

// ── EVES ──
// askeden.com's own rule (ops.js EVES): no EVES on its servers today, for any plan. Said plainly, before the body is
// read; the app keeps its EVES button off (GET /api/creative/me `eves`).

const evesOff = () => new ApiError(503, 'not_set_up', EVES.why);

// ── generated media ──

async function quote(request, env, who) {
  const spec = parseMedia(sameApp(await readJsonBody(request, LIMITS.mediaBytes), who), [], env);
  const { models, ...price } = priceFor(env, spec);
  const out = await call(env, who.account, 'creative-quote', scoped(who, { quote: { ...price, hash: await specHash(spec) } }));
  return json(models ? { ...out, models } : out);
}

async function startJob(request, env, who) {
  const raw = sameApp(await readJsonBody(request, LIMITS.mediaBytes), who);
  const spec = parseMedia(raw, ['quote_id'], env); // still made here (a key switched off since the quote: 503)
  const job = await call(env, who.account, 'creative-job', scoped(who, { quote_id: raw.quote_id, hash: await specHash(spec), spec }));
  return json(job, 202);
}

const JOB_PATH = /^\/api\/creative\/jobs\/([0-9a-f]{24})(\/result)?$/;

/**
 * A finished item, streamed: the account object sends its pieces as it reads them (ops.js result) and this passes the
 * stream on, so a long 1080p clip is never whole in the Worker's memory. Its length is known, so it's sent with one.
 */
async function jobResult(env, who, id, url) {
  const item = url.searchParams.has('item') ? Number(url.searchParams.get('item')) : 0;
  if (!Number.isInteger(item) || item < 0 || item >= MEDIA.speechLines) throw new ApiError(404, 'not_found', 'No such item.');
  const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName(who.account));
  const res = await stub.fetch('https://account/creative-job-result', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(scoped(who, { job: id, item })) });
  if (res.status >= 400 || !res.body) {
    const out = await res.json().catch(() => ({}));
    throw new ApiError(res.status >= 400 ? res.status : 502, out.code || 'error', out.error || 'Something went wrong.');
  }
  const mime = res.headers.get('content-type') || 'application/octet-stream';
  const bytes = Number(res.headers.get('x-eden-bytes'));
  let body = res.body;
  if (Number.isSafeInteger(bytes) && bytes > 0 && typeof FixedLengthStream === 'function') {
    const fixed = new FixedLengthStream(bytes); // Workers: streamed, with a content-length
    res.body.pipeTo(fixed.writable).catch(() => {});
    body = fixed.readable;
  }
  const ext = mime === 'video/mp4' ? 'mp4' : mime === 'audio/mpeg' ? 'mp3' : 'bin';
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': mime,
      'content-disposition': `attachment; filename="eden-generated-${id}-${item}.${ext}"`,
      'x-eden-generated': 'true',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/** A token is one suite app's: a request that names another of the suite's apps is refused, never served as that app. */
function sameApp(body, who) {
  if (body.app !== undefined && body.app !== who.app && Object.hasOwn(APPS, body.app)) {
    throw new ApiError(403, 'wrong_app', `This link is ${APPS[who.app]}’s, not ${APPS[body.app]}’s. Link ${APPS[body.app]} to Eden on its own.`);
  }
  return body;
}

// ── /api/creative/* ──

/** Every /api/creative/* request (worker.js sends them here before its own Origin rule). */
export async function creativeApi(request, env, ctx, path) {
  try {
    if (!env.ACCOUNTS) throw new ApiError(503, 'not_set_up', 'Eden accounts are not set up here yet.');
    if (path === '/api/creative/link') return await approve(request, env);
    // the apps send no Origin; a browser always does on these methods: no page may call them (no CORS)
    if (request.headers.get('origin') !== null || request.method === 'OPTIONS') throw new ApiError(403, 'forbidden', 'Not from a browser: these are for the Creative Suite’s apps.');
    const method = request.method;
    if (path === '/api/creative/token') {
      if (method !== 'POST') throw new ApiError(405, 'bad_request', 'POST only.');
      return await token(request, env);
    }
    const route = path === '/api/creative/me' ? 'me' : path === '/api/creative/revoke' ? 'revoke' : path === '/api/creative/eden' ? 'eden' : path === '/api/creative/eves' ? 'eves' : path === '/api/creative/quote' ? 'quote' : path === '/api/creative/jobs' ? 'jobs' : JOB_PATH.test(path) ? 'job' : null;
    if (!route) throw new ApiError(404, 'not_found', 'No such thing here.');
    const wants = route === 'me' || route === 'job' ? 'GET' : 'POST';
    if (method !== wants) throw new ApiError(405, 'bad_request', `${wants} only.`);
    // this network first: the account a token names isn't counted until the token is checked, so a forged token
    // naming someone else's account costs only the sender (no one can rate-limit another person out of askeden.com)
    await limited(env, 'API_RATE', `creative-ip:${clientIp(request)}`);
    const who = bearer(request, env);
    if (route === 'revoke') return await revoke(request, env); // checked there, and nothing to count it against
    const costly = route === 'eden' || route === 'quote' || route === 'jobs';
    // the token (and, where it costs, that the allowance can pay) before anything is counted or read for it; it says
    // which app it's for
    who.app = (await call(env, who.account, 'creative-check', scoped(who, { costly }))).app;
    await limited(env, 'API_RATE', `creative:${who.account}`);
    if (route === 'me') return json(await call(env, who.account, 'creative-me', scoped(who)));
    if (route === 'job') {
      const [, id, isResult] = JOB_PATH.exec(path);
      if (isResult) return await jobResult(env, who, id, new URL(request.url));
      return json(await call(env, who.account, 'creative-job-get', scoped(who, { job: id })));
    }
    if (route === 'eves') throw evesOff();
    if (route === 'eden') return await edenTurn(request, env, ctx, who, sameApp(await readJsonBody(request, LIMITS.turnBytes), who));
    if (route === 'quote') return await quote(request, env, who);
    return await startJob(request, env, who);
  } catch (error) {
    if (error instanceof ApiError) return problem(error.status, error.message, error.code, error.headers);
    console.error('creative api failed', path, error && error.message); // never the request, never a token
    return problem(500, 'Something went wrong on askeden.com. Try again.', 'server');
  }
}
