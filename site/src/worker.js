// askeden.com: Eden (the routed chat), Eden's site (J.A.R.V.I.S. and Eden Messenger) and the
// J.A.R.V.I.S. download, on Cloudflare (the whole domain; the old Eden site on Vercel is no
// longer shown there).
//
//   /                        Eden for a signed-in browser, else the landing page below, with
//                            "Sign in to Eden" (eden/pages.js)
//   /signin                  Eden's sign-in page (Apple, Google, a passkey, a code the iPhone approves)
//   /privacy, /terms         the Privacy Policy and Terms of Service (eden/pages.js)
//   /help, /help/…           Help: the FAQ, signed out too (eden/help.js, via eden/pages.js)
//   POST /api/help/ask       Ask Help, grounded in the FAQ (eden/help.js)
//   /<Eden's files>, /signin/…, /artifact/<id>   the same (eden/pages.js)
//   /p/<id>                  a published Eden page (accounts/published.js, via eden/pages.js)
//   /download, /jarvis       the J.A.R.V.I.S. and Eden Messenger landing page (./public/jarvis/index.html)
//   /jarvis/…               its images
//   /jarvis/download         the latest disk image, from R2 (resumable: Range requests)
//   /latest.json, /jarvis/latest.json   its version, size and file name, for the page
//   /jarvis/iphone, /messenger/download, /messenger/iphone   the other apps (SOON, below)
//   /messenger, /messenger/…   Eden Messenger itself, at messenger.askeden.com (MESSENGER)
//   POST /api/voice         the JARVIS voice for copies without a Fish Audio key of their own
//   POST /api/chat/voice    the same for Eden's Read aloud and talk mode, on the signed-in browser's account
//   /api/web/…              signing a browser in to Eden (eden/session.js)
//   /api/chat/…, /api/route hosted Eden (eden/chat.js)
//   /eden/connect, /api/eden/…   @Eden for Eden Messenger: connect, then ask (eden/ask.js)
//   POST /api/stripe/webhook   Stripe's events for Plus bought on the web (eden/billing.js); nothing else under /api/stripe
//   /api/…                  Jarvis accounts (accounts/index.js, docs/accounts.md)
//   anything else           back to /
//
// Every /api request that changes something, and the relay's WebSocket upgrade, is refused
// when a browser sends it from another origin (the apps send no Origin at all).
//
// What "latest" is lives in R2 itself: latest.json, written by the release script after the
// disk image is up, so a half-uploaded release is never offered.

import { api } from './accounts/index.js';
import { tokenFrom } from './accounts/util.js';
import { chatApi } from './eden/chat.js';
import { connectPage, edenApi } from './eden/ask.js';
import { stripeApi } from './eden/billing.js';
import { edenPage } from './eden/pages.js';
import { helpApi } from './eden/help.js';
import { APPLE_CALLBACK, currentSession, web } from './eden/session.js';
import { LANDING_CSP, baseline, foreignOrigin, page, problem, sameOrigin } from './eden/web.js';

export { Account, Identity, Link, Space } from './accounts/index.js';
import { JARVIS_VOICE_ID, LIMITS } from './voice-config.js';

const LATEST = 'latest.json';
// Before the R2 bucket is bound (a deploy without it), the download is the notarized disk
// image of the latest GitHub release, found from its update feed (the zip it names, beside
// the .dmg of the same version); FALLBACK if the feed can't be read.
const FEED = 'https://github.com/bilelharrat/Jarvis/releases/latest/download/release.json';
const FALLBACK = {
  version: '0.1.0',
  size: 310650543,
  file: 'J.A.R.V.I.S.-0.1.0.dmg',
  url: 'https://github.com/bilelharrat/Jarvis/releases/latest/download/J.A.R.V.I.S.-0.1.0.dmg',
};

export default {
  async fetch(request, env, ctx) {
    return baseline(await route(request, env, ctx));
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/api' || path.startsWith('/api/')) {
    // @Eden for Eden Messenger: its own Origin rules (CORS for Messenger only; eden/ask.js).
    if (path.startsWith('/api/eden/')) return edenApi(request, env, ctx, path);
    // Stripe's webhook: a server, so no Origin and no session; its signature is the guard (eden/billing.js).
    if (path === '/api/stripe' || path.startsWith('/api/stripe/')) return stripeApi(request, env, ctx, path);
    const refused = fromElsewhere(request, path);
    if (refused) return refused;
    if (path === '/api/voice' || path === '/api/chat/voice') return voice(request, env, path);
    if (path === '/api/route' || path === '/api/chat' || path.startsWith('/api/chat/')) return chatApi(request, env, ctx, path);
    if (path === '/api/help' || path.startsWith('/api/help/')) return helpApi(request, env, ctx, path);
    if (path.startsWith('/api/web/')) return web(request, env, ctx, path);
    return api(request, env, ctx);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  if (path === '/.well-known/apple-app-site-association') return appSiteAssociation(env);
  if (path === '/jarvis/download') return download(request, env);
  if (path === '/download' || path === '/jarvis') return landing(request, env, url);
  if (Object.hasOwn(SOON, path)) return elsewhere(path, env);
  if (path === '/messenger' || path.startsWith('/messenger/')) return toMessenger(url);
  if (path === '/latest.json' || path === '/jarvis/latest.json') return latestInfo(env);
  if (path === '/eden/connect') return connectPage(request, env, url); // "Connect Eden Messenger?" (eden/ask.js)
  const eden = await edenPage(request, env, path);
  if (eden) return eden;
  if (path.startsWith('/jarvis/')) {
    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;
  }
  // An old Eden address, a typo: home, not a dead end.
  return Response.redirect(new URL('/', url).toString(), 302);
}

// The landing page (J.A.R.V.I.S. and Eden Messenger), at /download and /jarvis, without a redirect.
async function landing(request, env, url) {
  const asset = await env.ASSETS.fetch(new Request(new URL('/jarvis/', url), request));
  return page(asset, LANDING_CSP, { cache: asset.headers.get('cache-control') || 'public, max-age=0, must-revalidate' });
}

// No other site may make a browser change anything here: an /api request that isn't a plain
// read, or a WebSocket upgrade, with a foreign Origin is refused. (Apple's sign-in posts back
// from appleid.apple.com, to that one address, where its state cookie and nonce guard it; a
// browser may send that Origin as "null".)
function fromElsewhere(request, path) {
  const upgrade = (request.headers.get('upgrade') || '').toLowerCase() === 'websocket';
  if ((request.method === 'GET' || request.method === 'HEAD') && !upgrade) return null;
  if (!foreignOrigin(request)) return null;
  if (path === APPLE_CALLBACK && request.method === 'POST' && ['https://appleid.apple.com', 'null'].includes(request.headers.get('origin'))) return null;
  return problem(403, 'Not from another site.', 'forbidden');
}

// Eden Messenger lives at its own host (deploy/gcp in its repo): a redirect, not a proxy, since
// its session cookie, live events and calls belong to that host. The rest of the path and the
// query come along (an invite link, a conversation).
const MESSENGER = 'https://messenger.askeden.com';

function toMessenger(url) {
  const rest = url.pathname.replace(/^\/messenger\/?/, '');
  return Response.redirect(`${MESSENGER}/${rest}${url.search}`, 302);
}

// The page's other buttons: each goes wherever its variable in wrangler.toml says (a TestFlight
// invite, the Messenger's disk image), and until that is set, to a page saying it's on its way.
const SOON = {
  '/jarvis/iphone': { variable: 'JARVIS_IPHONE_URL', app: 'J.A.R.V.I.S. for iPhone' },
  '/messenger/download': { variable: 'MESSENGER_MAC_URL', app: 'Eden Messenger for Mac' },
  '/messenger/mac': { variable: 'MESSENGER_MAC_URL', app: 'Eden Messenger for Mac' },
  '/messenger/iphone': { variable: 'MESSENGER_IPHONE_URL', app: 'Eden Messenger for iPhone' },
};

function elsewhere(path, env) {
  const { variable, app } = SOON[path];
  const target = String(env[variable] || '').trim();
  if (/^https:\/\//.test(target)) return Response.redirect(target, 302);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${app}: almost ready</title>
<link rel="icon" type="image/png" href="/jarvis/eden-favicon.png">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300&family=Instrument+Sans:wght@400;600&display=swap">
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0e13;color:#f4f5f7;font:400 17px/1.55 'Instrument Sans',-apple-system,sans-serif;-webkit-font-smoothing:antialiased;text-align:center;padding:24px;box-sizing:border-box}
h1{margin:0 0 12px;font:300 clamp(34px,6vw,52px)/1.1 Fraunces,Georgia,serif}p{margin:0 auto 28px;max-width:440px;color:rgba(244,245,247,.72)}
a{display:inline-block;padding:13px 24px;border-radius:999px;border:1px solid rgba(255,255,255,.22);color:#f4f5f7;text-decoration:none;font-weight:600}a:hover{background:rgba(255,255,255,.06)}</style>
</head><body><main><h1>${app} is almost ready.</h1><p>It isn't out yet. Check back soon: this button will download it.</p><a href="/">Back to askeden.com</a></main></body></html>`;
  return page(new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }), LANDING_CSP);
}

async function readLatest(env) {
  if (!env.DOWNLOADS) return null;
  const object = await env.DOWNLOADS.get(LATEST);
  if (!object) return null;
  try {
    const latest = JSON.parse(await object.text());
    return latest && typeof latest.file === 'string' && latest.file ? latest : null;
  } catch {
    return null;
  }
}

async function fromGitHub() {
  try {
    const feed = await (await fetch(FEED, { cf: { cacheTtl: 300, cacheEverything: true } })).json();
    const version = String(feed.currentRelease || '');
    const zip = ((feed.releases || []).find((r) => r.version === version) || {}).updateTo?.url || '';
    if (!/^\d+\.\d+\.\d+$/.test(version) || !zip.endsWith('-mac.zip')) return FALLBACK;
    const file = `J.A.R.V.I.S.-${version}.dmg`;
    return { version, size: 0, file, url: zip.replace(/[^/]*$/, file) };
  } catch {
    return FALLBACK;
  }
}

async function latestInfo(env) {
  const latest = env.DOWNLOADS ? await readLatest(env) : await fromGitHub();
  if (!latest) return json({ error: 'No release yet.' }, 404);
  const { version = '', size = 0, file, published = '' } = latest;
  return json({ version, size, file, published }, 200, { 'cache-control': 'public, max-age=60' });
}

async function download(request, env) {
  if (!env.DOWNLOADS) return Response.redirect((await fromGitHub()).url, 302);
  const latest = await readLatest(env);
  if (!latest) return new Response('No release yet.', { status: 404 });
  const range = parseRange(request.headers.get('range'));
  const options = range ? { range } : {};
  const object = request.method === 'HEAD'
    ? await env.DOWNLOADS.head(latest.file)
    : await env.DOWNLOADS.get(latest.file, options);
  if (!object) return new Response('The release file is missing.', { status: 404 });
  const headers = new Headers({
    'content-type': 'application/x-apple-diskimage',
    'content-disposition': `attachment; filename="${latest.file.replace(/"/g, '')}"`,
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=300',
    etag: object.httpEtag,
  });
  const size = object.size;
  if (range && request.method !== 'HEAD') {
    const start = range.offset ?? Math.max(0, size - range.suffix);
    const length = range.length ?? size - start;
    if (start >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    headers.set('content-range', `bytes ${start}-${start + length - 1}/${size}`);
    headers.set('content-length', String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set('content-length', String(size));
  return new Response(request.method === 'HEAD' ? null : object.body, { status: 200, headers });
}

// "bytes=100-199", "bytes=100-" and "bytes=-500", as R2's range option; null for anything
// else (several ranges, nonsense): then the whole file.
export function parseRange(header) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') return { suffix: Number(m[2]) };
  const offset = Number(m[1]);
  if (m[2] === '') return { offset };
  const end = Number(m[2]);
  return end >= offset ? { offset, length: end - offset + 1 } : null;
}

// Universal links: askeden.com links tapped elsewhere (a task's push, Mail, Messages) open the
// Eden iOS app when it's installed. The API and the sign-in pages stay in the browser (Apple's and
// Google's callbacks must land where their cookies are). Apple fetches this file itself.
export function appSiteAssociation(env) {
  const team = String(env.APPLE_TEAM_ID || '8CV4X23Y2T');
  const body = {
    applinks: {
      details: [{
        appIDs: [`${team}.com.askeden.eden`],
        components: [
          { '/': '/api/*', exclude: true },
          { '/': '/signin*', exclude: true },
          { '/': '/download*', exclude: true },
          { '/': '/jarvis/*', exclude: true },
          { '/': '/p/*', exclude: true },
          { '/': '/*' },
        ],
      }],
    },
    webcredentials: { apps: [`${team}.com.askeden.eden`] },
  };
  return json(body, 200, { 'cache-control': 'public, max-age=3600' });
}

function json(body, status, extra = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extra } });
}


// ── the JARVIS voice, for copies of the app without a Fish Audio key of their own ──
//
// The app (speech.CloudVoice "hosted") posts {text, format: "wav" | "pcm", speed?} with its
// install id in X-Jarvis-Install. The text goes to Fish Audio with the owner's key (the
// Worker secret FISH_API_KEY: never in the app or the repo) and the public JARVIS voice, and
// the audio streams back. Each install, each network and everyone together have a daily
// allowance in characters (VoiceQuota), so the owner's bill has a ceiling; past it the app
// hears 429 and speaks with the Mac's voice.
//
// Eden at askeden.com posts {text} to /api/chat/voice (its X-Jarvis-Chat header, same origin,
// the session cookie): the browser's account pays from its own daily voice allowance (the
// Account's `voice` op, which a `web` device may use only this way, with eden: true).


function limits(env) {
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    text: n(env.VOICE_MAX_TEXT, LIMITS.text),
    install: n(env.VOICE_DAILY_PER_INSTALL, LIMITS.install),
    network: n(env.VOICE_DAILY_PER_NETWORK, LIMITS.network),
    everyone: n(env.VOICE_DAILY_TOTAL, LIMITS.everyone),
  };
}

async function voice(request, env, path = '/api/voice') {
  if (request.method !== 'POST') return json({ error: 'POST only.' }, 405, { allow: 'POST' });
  const eden = path === '/api/chat/voice';
  if (eden && (request.headers.get('x-jarvis-chat') !== '1' || !sameOrigin(request))) return json({ error: 'Only askeden.com’s own page may do that.' }, 403);
  if (!env.FISH_API_KEY || !env.VOICE_QUOTA) return json({ error: 'The JARVIS voice is not set up here yet.' }, 503);
  const install = eden ? '' : String(request.headers.get('x-jarvis-install') || '');
  let account = eden ? null : tokenFrom(request);
  if (eden) {
    const { session } = await currentSession(request, env);
    if (!session) return json({ error: 'Signed out. Sign in at askeden.com again.', code: 'signed_out' }, 401);
    account = session.token;
  }
  if (!account && !/^[0-9a-f]{32}$/.test(install)) return json({ error: 'Unknown install.' }, 400);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Send JSON.' }, 400);
  }
  const cap = limits(env);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return json({ error: 'Nothing to say.' }, 400);
  if (text.length > cap.text) return json({ error: `At most ${cap.text} characters at a time.` }, 413);
  const format = body.format === 'pcm' ? 'pcm' : 'wav';
  const network = request.headers.get('cf-connecting-ip') || 'unknown';
  if (env.VOICE_RATE) {
    const { success } = await env.VOICE_RATE.limit({ key: network });
    if (!success) return json({ error: 'Too many requests; slow down.' }, 429, { 'retry-after': '60' });
  }
  // Signed in: the account's own daily allowance (more with Jarvis Plus). The everyone-
  // together ceiling still counts, so the owner's bill keeps its limit.
  if (account && env.ACCOUNTS) {
    const answer = await env.ACCOUNTS.get(env.ACCOUNTS.idFromName(account.account)).fetch('https://account/voice', {
      method: 'POST',
      headers: { 'x-jarvis-device': account.device, 'x-jarvis-secret': account.secret },
      body: JSON.stringify({ chars: text.length, ...(eden ? { eden: true } : {}) }),
    });
    const verdict = await answer.json().catch(() => ({}));
    if (answer.status === 401) return json({ error: verdict.error || 'Signed out.', code: 'signed_out' }, 401);
    if (answer.status === 403) return json({ error: verdict.error || 'Not allowed.', code: 'forbidden' }, 403);
    if (!verdict.ok) return json({ error: verdict.why || 'No voice allowance left today.', allowance: 'account' }, 429, { 'retry-after': '3600' });
  }
  const quota = env.VOICE_QUOTA.get(env.VOICE_QUOTA.idFromName('daily'));
  const verdict = await (await quota.fetch('https://quota/take', {
    method: 'POST',
    body: JSON.stringify({ install: account ? `a:${account.account}` : install, network, chars: text.length, limits: account ? { ...cap, install: 1e12, network: 1e12 } : cap }),
  })).json();
  if (!verdict.ok) return json({ error: verdict.why, allowance: verdict.which }, 429, { 'retry-after': String(verdict.retryAfter || 3600) });
  const speed = Number(body.speed);
  const fish = await fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.FISH_API_KEY}`,
      model: env.FISH_MODEL || 's2.1-pro',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      text,
      reference_id: JARVIS_VOICE_ID,
      format,
      sample_rate: 24000,
      latency: 'low',
      ...(Number.isFinite(speed) && Math.abs(speed - 1) >= 0.01 ? { prosody: { speed: Math.min(2, Math.max(0.5, speed)) } } : {}),
    }),
  });
  if (!fish.ok) return json({ error: `The voice service said ${fish.status}.` }, 502);
  return new Response(fish.body, {
    status: 200,
    headers: { 'content-type': format === 'wav' ? 'audio/wav' : 'application/octet-stream', 'cache-control': 'no-store' },
  });
}

// The day's characters, per install, per network and in all: one object for everyone, so
// every check-and-add is atomic. A new day (UTC) starts from nothing.
export class VoiceQuota {
  constructor(state) {
    this.storage = state.storage;
  }

  async fetch(request) {
    const { install, network, chars, limits: cap } = await request.json();
    const day = new Date().toISOString().slice(0, 10);
    if ((await this.storage.get('day')) !== day) {
      await this.storage.deleteAll();
      await this.storage.put('day', day);
    }
    const keys = { install: `i:${install}`, network: `n:${network}`, everyone: 'all' };
    const used = await this.storage.get(Object.values(keys));
    const nextMidnight = Math.ceil((Date.parse(`${day}T00:00:00Z`) + 86400000 - Date.now()) / 1000);
    for (const [which, key] of Object.entries(keys)) {
      if ((used.get(key) || 0) + chars > cap[which]) {
        const why = which === 'everyone'
          ? "Today's JARVIS voice allowance is used up for everyone; it resets at midnight UTC."
          : "This Mac's JARVIS voice allowance for today is used up; it resets at midnight UTC. Add your own Fish Audio key in Settings › Speaking for unlimited use.";
        return Response.json({ ok: false, which, why, retryAfter: nextMidnight });
      }
    }
    const next = {};
    for (const key of Object.values(keys)) next[key] = (used.get(key) || 0) + chars;
    await this.storage.put(next);
    return Response.json({ ok: true, left: cap.install - next[keys.install] });
  }
}
