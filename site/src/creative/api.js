// askeden.com's door for the Eden Creative Suite's Mac apps (Scorsese first): docs/creative-api.md is the contract.
//
//   GET  /creative/link              the approval page, for a browser signed in to Eden (else "sign in first")
//   POST /api/creative/link          its form (same origin, the session cookie): Link → 303 to edenstudio://link?ticket=…
//   POST /api/creative/token         { ticket, verifier } → the app's token for the `creative` service
//   POST /api/creative/revoke        the token stops at once (also from askeden.com › Account › Connected apps)
//   GET  /api/creative/me            name, Plus, this month's allowance and what's used
//   POST /api/creative/eden          one model turn, streamed; the app's tools passed to the model, never run here
//   POST /api/creative/eves          EVES checks a caption or transcript text, unchanged (eden/eves.js)
//   POST /api/creative/quote         a price for generated media, before anything runs
//   POST /api/creative/jobs          the quoted job; GET /api/creative/jobs/:id its progress; …/result the file
//
// The link is the site's scoped-token machinery (accounts/scoped.js, client `creative`), as Eden Messenger's @Eden is
// (eden/ask.js): a two-minute ticket bound to a PKCE challenge, sent only to the suite's own scheme, redeemed once for a
// token kept hashed in the account's object and good for nothing but the `creative-*` ops (ops.js). Every app route
// checks the token there, and Plus where it costs; the rate limits are the site's own (API_RATE, USER_RATE, AUTH_RATE).
// The app routes take no browser: a request with an Origin is refused (no CORS). Nothing asked is stored or logged.

import { call, clientIp, limited } from '../accounts/index.js';
import { makeScopedToken, parseConnectCode, parseScopedToken } from '../accounts/scoped.js';
import { ApiError, webAllowed } from '../accounts/util.js';
import { MAX_BODY, compareLanes, compareModels, creditFactor, hostedConfig, inputEstimate, messageText, parseSend, readBody as chatReadBody, routeSettings, routed, systemPrompt } from '../eden/chat.js';
import { hostedEves } from '../eden/eves.js';
import { hostedFor, narrowFor } from '../eden/providers.js';
import { currentSession } from '../eden/session.js';
import { json, page, problem, sameOrigin } from '../eden/web.js';
import { MEDIA, parseMedia, priceFor, specHash } from './media.js';
import { APPS, edenTurn } from './turn.js';

export const CALLBACK = 'edenstudio://link';
const CLIENT = 'creative';
const LIMITS = { turnBytes: 8 * 1024 * 1024, evesBytes: 256 * 1024, mediaBytes: 6 * 1024 * 1024, smallBytes: 16 * 1024, evesChars: 20_000, deviceChars: 60 };
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
const LINK_CSP = "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self' edenstudio:; base-uri 'none'; frame-ancestors 'none'";

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

/** The page's HTML (exported for the tests). */
export function linkHtml({ request: req, signedIn = false, email = '', plus = true, error = '' }) {
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
  <p class="alert">Eden sees only what ${name} sends it from your project, and answers on your Plus AI allowance. It shows a price before it makes any clip or voice-over. It can’t read your Eden chats, mail, calendar, notes or account.</p>
${plus ? '' : `  <p class="fine">Eden in ${name} is part of Eden Plus. You can link now and get Plus later; editing works without it.</p>\n`}  <form method="post" action="/api/creative/link">
${inputs}
    <p><button class="button ghost" type="submit" name="decision" value="deny">Cancel</button> <button class="button" type="submit" name="decision" value="allow">Link</button></p>
  </form>
  <p class="fine">Unlink any time in ${name}, or here in Account › Connected apps. The link lasts a year.</p>`);
}

function htmlPage(html, status = 200) {
  const response = page(new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8' } }), LINK_CSP);
  response.headers.set('vary', 'cookie');
  return response;
}

/** GET /creative/link. */
export async function creativeLinkPage(request, env, url) {
  const req = linkRequest(url.searchParams);
  if (req.error) return htmlPage(linkHtml({ error: req.error }), 400);
  const { session } = env.ACCOUNTS ? await currentSession(request, env) : { session: null };
  let email = '';
  let plus = true;
  if (session) {
    const view = await call(env, session.account, 'get', {}, session.token).catch(() => null);
    email = (view?.identities || []).map((i) => i.email).find(Boolean) || '';
    plus = Boolean(view?.plan?.active);
  }
  return htmlPage(linkHtml({ request: req, signedIn: Boolean(session), email, plus }));
}

const seeOther = (location) => new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
const backTo = (req, fields) => `${CALLBACK}?${new URLSearchParams({ ...fields, state: req.state, app: req.app })}`;

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
  const { code } = await call(env, session.account, 'scoped-code', { client: CLIENT, scope: CLIENT, redirect_uri: CALLBACK, challenge: req.challenge, app: req.app, label }, session.token);
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
  if (!code) throw new ApiError(400, 'invalid_grant', 'That link ticket isn’t right. Link again.');
  if (!webAllowed(env, code.account)) throw new ApiError(403, 'forbidden', 'This Eden account can’t use Eden yet.');
  const minted = await call(env, code.account, 'scoped-redeem', { code: code.secret, client: CLIENT, redirect_uri: CALLBACK, verifier: String(body.verifier || '') });
  return json({
    token: makeScopedToken(code.account, minted.id, minted.secret),
    token_type: 'Bearer',
    scope: minted.scope,
    connection: { id: minted.id, app: minted.app || null, created: minted.created ?? null, expires_at: minted.expires },
  });
}

async function revoke(request, env) {
  const who = bearer(request, env);
  await call(env, who.account, 'scoped-revoke', scoped(who)).catch((error) => {
    if (!(error instanceof ApiError && error.status === 401)) throw error; // already gone: fine
  });
  return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

// ── EVES, unchanged ──

const EVES_DEVICE = 'creative-scoped'; // never a real device: evesAccounts answers every op it marks
const EVES_KINDS = { captions: 'captions', transcript: 'transcript' };

/** The request checked: { app, kind, text, language }. */
export function parseEves(body) {
  for (const key of Object.keys(body)) if (!['app', 'kind', 'text', 'language'].includes(key)) throw new ApiError(400, 'bad_request', `eves: unknown key ${JSON.stringify(key.slice(0, 40))}`);
  if (!Object.hasOwn(APPS, body.app)) throw new ApiError(400, 'bad_request', `app is one of ${Object.keys(APPS).join(', ')}`);
  if (!Object.hasOwn(EVES_KINDS, body.kind)) throw new ApiError(400, 'bad_request', 'kind is captions or transcript');
  if (typeof body.text !== 'string' || !body.text.trim()) throw new ApiError(400, 'bad_request', 'text is needed');
  if (body.text.length > LIMITS.evesChars) throw new ApiError(413, 'too_long', `At most ${LIMITS.evesChars.toLocaleString('en-US')} characters at a time: check it in parts.`);
  if (body.language !== undefined && (typeof body.language !== 'string' || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(body.language))) throw new ApiError(400, 'bad_request', 'language is a BCP 47 tag, like en or es');
  return { app: body.app, kind: body.kind, text: body.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim(), language: body.language || '' };
}

/** What EVES is asked: check the text, don't rewrite it. */
export function evesPrompt({ app, kind, text, language }) {
  return [
    `Check the names, places, dates, numbers and facts in these ${EVES_KINDS[kind]} from a ${APPS[app] === 'Scorsese' ? 'video' : 'project'} in ${APPS[app]}.`,
    'List each one that is wrong or doubtful: quote it, give the correct version, and say why in a few words. If they all check out, say so. Don’t rewrite the text, and don’t comment on style or spelling that isn’t a name.',
    language ? `The text is in ${language}; answer in the same language.` : '',
    `"""\n${text.replace(/"""/g, '"‘"')}\n"""`,
  ].filter(Boolean).join('\n\n');
}

/**
 * The site's env for EVES on the app's token: EVES asks the account object for `allow-ai`, `hold-ai` and `get` with a
 * device token (eves.js), which a scoped token isn't. Those three become the token's own creative ops (Plus checked
 * there); `get` says no owner (EVES's owner-only modes stay off); anything else EVES might ask with it is refused.
 * Calls without a device (`spend`, `release-ai`) go through as they are.
 */
function evesEnv(env, who) {
  const ns = env.ACCOUNTS;
  const forward = (stub, op, body) => stub.fetch(`https://account/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return {
    ...env,
    ACCOUNTS: {
      idFromName: (name) => ns.idFromName(name),
      get(id) {
        const stub = ns.get(id);
        return {
          async fetch(input, init) {
            const req = input instanceof Request ? input : new Request(input, init);
            if (req.headers.get('x-jarvis-device') !== EVES_DEVICE) return stub.fetch(req);
            const op = new URL(req.url).pathname.slice(1);
            const body = await req.json().catch(() => ({}));
            if (op === 'allow-ai') return forward(stub, 'creative-allow', scoped(who));
            if (op === 'hold-ai') return forward(stub, 'creative-hold', scoped(who, { usd: body.usd }));
            if (op === 'get') return Response.json({ identities: [] });
            return Response.json({ error: 'Not for the Creative Suite.', code: 'forbidden' }, { status: 403 });
          },
        };
      },
    },
  };
}

async function eves(request, env, ctx, who) {
  const body = parseEves(await readJsonBody(request, LIMITS.evesBytes));
  // Plus and some allowance, said plainly before EVES starts (it checks again for its own worst case)
  const allow = await call(env, who.account, 'creative-allow', scoped(who));
  if (!allow.ok) throw new ApiError(402, 'no_allowance', allow.why);
  const cfg = await hostedFor(env, null, hostedConfig(env), request); // the service's keys only: no one's own keys here
  const inner = new Request('https://askeden.com/api/chat/eves', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': request.headers.get('user-agent') || 'EdenCreative' },
    body: JSON.stringify({ messages: [{ role: 'user', content: evesPrompt(body) }], mode: 'on', settings: {} }),
    signal: request.signal,
  });
  const helpers = { readBody: chatReadBody, MAX_BODY, compareModels, parseSend, narrowFor, systemPrompt, inputEstimate, messageText, routeSettings, compareLanes, creditFactor, routed };
  return hostedEves(inner, evesEnv(env, who), ctx, { account: who.account, token: { device: EVES_DEVICE, secret: 'scoped' } }, cfg, helpers);
}

// ── generated media ──

async function quote(request, env, who) {
  const spec = parseMedia(await readJsonBody(request, LIMITS.mediaBytes));
  const price = priceFor(env, spec);
  const out = await call(env, who.account, 'creative-quote', scoped(who, { quote: { ...price, hash: await specHash(spec) } }));
  return json(out);
}

async function startJob(request, env, who) {
  const raw = await readJsonBody(request, LIMITS.mediaBytes);
  const spec = parseMedia(raw, ['quote_id']);
  priceFor(env, spec); // still made here (a key switched off since the quote: 503)
  const job = await call(env, who.account, 'creative-job', scoped(who, { quote_id: raw.quote_id, hash: await specHash(spec), spec }));
  return json(job, 202);
}

const JOB_PATH = /^\/api\/creative\/jobs\/([0-9a-f]{24})(\/result)?$/;

async function jobResult(env, who, id, url) {
  const item = url.searchParams.has('item') ? Number(url.searchParams.get('item')) : 0;
  if (!Number.isInteger(item) || item < 0 || item >= MEDIA.speechLines) throw new ApiError(404, 'not_found', 'No such item.');
  const { mime, data } = await call(env, who.account, 'creative-job-result', scoped(who, { job: id, item }));
  const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
  const ext = mime === 'video/mp4' ? 'mp4' : mime === 'audio/mpeg' ? 'mp3' : 'bin';
  return new Response(bytes, {
    status: 200,
    headers: {
      'content-type': mime,
      'content-length': String(bytes.length),
      'content-disposition': `attachment; filename="eden-generated-${id}-${item}.${ext}"`,
      'x-eden-generated': 'true',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
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
    const who = bearer(request, env);
    await limited(env, 'API_RATE', who.account);
    if (route === 'revoke') return await revoke(request, env);
    if (route === 'me') return json(await call(env, who.account, 'creative-me', scoped(who)));
    if (route === 'job') {
      const [, id, isResult] = JOB_PATH.exec(path);
      if (isResult) return await jobResult(env, who, id, new URL(request.url));
      return json(await call(env, who.account, 'creative-job-get', scoped(who, { job: id })));
    }
    await limited(env, 'USER_RATE', `creative:${who.account}`);
    await call(env, who.account, 'creative-check', scoped(who)); // the token and Plus first: nothing is read for a stranger
    if (route === 'eden') return await edenTurn(request, env, ctx, who, await readJsonBody(request, LIMITS.turnBytes));
    if (route === 'eves') return await eves(request, env, ctx, who);
    if (route === 'quote') return await quote(request, env, who);
    return await startJob(request, env, who);
  } catch (error) {
    if (error instanceof ApiError) return problem(error.status, error.message, error.code, error.headers);
    console.error('creative api failed', path, error && error.message); // never the request, never a token
    return problem(500, 'Something went wrong on askeden.com. Try again.', 'server');
  }
}
