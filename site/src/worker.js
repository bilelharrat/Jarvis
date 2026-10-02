// askeden.com: J.A.R.V.I.S.'s site and the download itself, on Cloudflare (the whole domain;
// the old Eden site on Vercel is no longer shown there).
//
//   /, /jarvis              the page (./public/jarvis/index.html)
//   /jarvis/…               its images
//   /download, /jarvis/download   the latest disk image, from R2 (resumable: Range requests)
//   /latest.json, /jarvis/latest.json   its version, size and file name, for the page
//   POST /api/voice         the JARVIS voice for copies without a Fish Audio key of their own
//   /api/…                  Jarvis accounts (accounts/index.js, docs/accounts.md)
//   anything else           back to the page
//
// What "latest" is lives in R2 itself: latest.json, written by the release script after the
// disk image is up, so a half-uploaded release is never offered.

import { api } from './accounts/index.js';
import { tokenFrom } from './accounts/util.js';

export { Account, Link } from './accounts/index.js';

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
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/api/voice') return voice(request, env);
    if (path.startsWith('/api/')) return api(request, env, ctx);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    if (path === '/download' || path === '/jarvis/download') return download(request, env);
    if (path === '/latest.json' || path === '/jarvis/latest.json') return latestInfo(env);
    if (path === '/' || path === '/jarvis') {
      // The page itself, at the domain's root and at /jarvis, without a redirect.
      return env.ASSETS.fetch(new Request(new URL('/jarvis/', url), request));
    }
    if (path.startsWith('/jarvis/')) {
      const asset = await env.ASSETS.fetch(request);
      if (asset.status !== 404) return asset;
    }
    // An old Eden address, a typo: the page, not a dead end.
    return Response.redirect(new URL('/', url).toString(), 302);
  },
};

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

export const JARVIS_VOICE_ID = '612b878b113047d9a770c069c8b4fdfe';
export const LIMITS = { text: 600, install: 20000, network: 40000, everyone: 400000 };

function limits(env) {
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
  return {
    text: n(env.VOICE_MAX_TEXT, LIMITS.text),
    install: n(env.VOICE_DAILY_PER_INSTALL, LIMITS.install),
    network: n(env.VOICE_DAILY_PER_NETWORK, LIMITS.network),
    everyone: n(env.VOICE_DAILY_TOTAL, LIMITS.everyone),
  };
}

async function voice(request, env) {
  if (request.method !== 'POST') return json({ error: 'POST only.' }, 405, { allow: 'POST' });
  if (!env.FISH_API_KEY || !env.VOICE_QUOTA) return json({ error: 'The JARVIS voice is not set up here yet.' }, 503);
  const install = String(request.headers.get('x-jarvis-install') || '');
  const account = tokenFrom(request);
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
      body: JSON.stringify({ chars: text.length }),
    });
    const verdict = await answer.json().catch(() => ({}));
    if (answer.status === 401) return json({ error: verdict.error || 'Signed out.', code: 'signed_out' }, 401);
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
