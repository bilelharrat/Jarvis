// Eden Slides' stock media library on askeden.com (the page is askeden's web/chat/deck-media.js, synced to
// public/eden; on the Mac the same routes are askeden src/chat/stock-media.ts, which this follows). Free-to-reuse
// photos, video and audio from Openverse and Wikimedia Commons, no key. The page's policy allows only its own
// origin, so the search and the files come through here, signed in (chat.js gate, no X-Jarvis-Chat so <img>,
// <audio> and <video> can load files):
//
//   GET /api/chat/media/search?kind=photo|video|audio&q=…&page=1 → { items, notices }   429 when every source is limited
//   GET /api/chat/media/file?u=<https url>  the file, streamed (Range passes through), only from FILE_HOSTS
//
// Openverse is asked only for licences that allow commercial use and changes (no NC, no ND); Commons is free by
// policy. Each item carries its licence and attribution; the page puts the credit on the deck's sources slide.
// Searches are cached in this isolate for CACHE_MS (Openverse allows an anonymous caller 20 a minute, 200 a day).

import { ApiError } from '../accounts/util.js';

export const MEDIA_SEARCH = '/api/chat/media/search';
export const MEDIA_FILE = '/api/chat/media/file';
export const MEDIA_KINDS = ['photo', 'video', 'audio'];
export const CACHE_MS = 10 * 60_000;
const CACHE_MAX = 200;
const PAGE_SIZE = 20;
const LOOKUP_MS = 8_000;
const UA = 'EdenChat/1.0 (https://askeden.com; hello@askeden.com)';
const BUSY = 'Openverse is busy (it allows a limited number of searches a minute and a day).';
export const FILE_LIMITS = { photo: 8 * 1024 * 1024, audio: 30 * 1024 * 1024, video: 80 * 1024 * 1024 };
export const FILE_HOSTS = ['upload.wikimedia.org', 'thumb.wikimedia.org', 'api.openverse.org', 'cdn.freesound.org', 'prod-1.storage.jamendo.com', 'mp3d.jamendo.com', 'ccmixter.org'];
const FILE_TYPE = {
  photo: /^image\/(jpeg|png|webp|gif)$/,
  audio: /^audio\/(mpeg|mp3|ogg|wav|x-wav|wave|webm|mp4|aac|flac|x-flac)$|^application\/ogg$/,
  video: /^video\/(webm|ogg|mp4)$|^application\/ogg$/,
};

class RateLimited extends Error {}

const proxied = (u) => (u ? `${MEDIA_FILE}?u=${encodeURIComponent(u)}` : '');
const plain = (html) => String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const clip = (s, n) => { const t = plain(s); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
/** Only https links are kept; Commons sends protocol-relative ones, and adds tracking parameters. */
export function cleanUrl(u) {
  let s = String(u ?? '').trim();
  if (s.startsWith('//')) s = `https:${s}`;
  if (s.startsWith('http://')) s = `https://${s.slice(7)}`;
  try {
    const p = new URL(s);
    if (p.protocol !== 'https:' || p.username || p.password) return '';
    for (const k of [...p.searchParams.keys()]) if (k.startsWith('utm_')) p.searchParams.delete(k);
    return p.href;
  } catch {
    return '';
  }
}
const CC_NAMES = { by: 'CC BY', 'by-sa': 'CC BY-SA', 'by-nc': 'CC BY-NC', 'by-nd': 'CC BY-ND', 'by-nc-sa': 'CC BY-NC-SA', 'by-nc-nd': 'CC BY-NC-ND', cc0: 'CC0', pdm: 'Public domain' };
const ovLicence = (code, version) => {
  const c = String(code ?? '').toLowerCase();
  const name = CC_NAMES[c] || c.toUpperCase();
  return c === 'cc0' || c === 'pdm' || !version ? name : `${name} ${version}`;
};

export function fromOpenverse(r, kind) {
  const original = cleanUrl(r.url);
  const page = cleanUrl(r.foreign_landing_url);
  if (!r.id || !original || /nc|nd/.test(String(r.license ?? '').toLowerCase())) return null;
  const file = kind === 'photo' ? `https://api.openverse.org/v1/images/${encodeURIComponent(String(r.id))}/thumb/?full_size=true&compressed=true` : original;
  const type = String(r.filetype || '').toLowerCase();
  const mime = kind === 'audio' && type ? `audio/${type === 'mp3' ? 'mpeg' : type}` : undefined;
  return {
    id: `ov:${r.id}`, kind, url: proxied(file), thumb: proxied(cleanUrl(r.thumbnail)), original, page: page || original,
    title: clip(r.title, 160) || 'Untitled', author: clip(r.creator, 120) || 'Unknown', authorUrl: cleanUrl(r.creator_url),
    licence: ovLicence(r.license, r.license_version), licenceUrl: cleanUrl(r.license_url), source: 'Openverse', provider: clip(r.provider || r.source, 60),
    ...(Number(r.width) > 0 ? { width: Number(r.width) } : {}),
    ...(Number(r.height) > 0 ? { height: Number(r.height) } : {}),
    ...(Number(r.duration) > 0 ? { duration: Math.round(Number(r.duration) / 100) / 10 } : {}), // Openverse gives ms
    ...(mime ? { mime } : {}),
  };
}

export function fromCommons(pg, kind) {
  const info = Array.isArray(pg.videoinfo) ? pg.videoinfo : pg.imageinfo; // video and audio come with videoinfo (it lists derivatives)
  const ii = Array.isArray(info) ? info[0] : null;
  if (!ii) return null;
  let mime = String(ii.mime ?? '').toLowerCase();
  const okMime = kind === 'photo' ? /^image\/(jpeg|png|webp|gif|tiff)$/.test(mime) : kind === 'video' ? /^(video\/(webm|ogg|mp4)|application\/ogg)$/.test(mime) : /^(audio\/|application\/ogg)/.test(mime);
  if (!okMime) return null;
  const meta = ii.extmetadata || {};
  const v = (k) => (meta[k] && meta[k].value) || '';
  const original = cleanUrl(ii.url);
  const big = cleanUrl(ii.thumburl);
  if (!original || (kind !== 'audio' && !big)) return null;
  if (kind === 'photo' && (Number(ii.width) < 320 || Number(ii.height) < 200)) return null;
  // The copy to play: Chrome dropped Theora (.ogv) and Safari has no Vorbis, so a video is a VP9 WebM near 720p and a
  // sound the MP3 copy, when Commons has made them.
  const derivs = (Array.isArray(ii.derivatives) ? ii.derivatives : []).map((d) => ({ src: cleanUrl(d.src), type: String(d.type ?? '').toLowerCase(), w: Number(d.width) || 0 })).filter((d) => d.src);
  let file = kind === 'photo' ? big : original;
  if (kind === 'video') {
    const webm = derivs.filter((d) => d.type.startsWith('video/webm') && d.w && d.w <= 1280).sort((a, b) => Math.abs(a.w - 854) - Math.abs(b.w - 854))[0];
    if (webm) { file = webm.src; mime = 'video/webm'; } else if (!/^video\/(webm|mp4)$/.test(mime)) return null;
  }
  if (kind === 'audio' && !/mpeg|mp3/.test(mime)) {
    const mp3 = derivs.find((d) => d.type.startsWith('audio/mpeg'));
    if (mp3) { file = mp3.src; mime = 'audio/mpeg'; }
  }
  // A small preview: Commons thumbnails take their width from the path; only standard widths are served (330, not 320).
  const small = kind === 'photo' ? big.replace(/\/(\d+)px-([^/]+)$/, (m, w, rest) => (Number(w) > 330 ? `/330px-${rest}` : m)) : big;
  const title = clip(v('ObjectName'), 160) || clip(String(pg.title ?? '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' '), 160);
  return {
    id: `wc:${pg.pageid ?? pg.title}`, kind, url: proxied(file), thumb: proxied(small), original, page: cleanUrl(ii.descriptionurl) || original,
    title: title || 'Untitled', author: clip(v('Artist'), 120) || 'Unknown', authorUrl: '', licence: clip(v('LicenseShortName'), 60) || 'See source page',
    licenceUrl: cleanUrl(v('LicenseUrl')), source: 'Wikimedia Commons', provider: 'Wikimedia Commons',
    ...(Number(ii.width) > 0 ? { width: Number(ii.width) } : {}),
    ...(Number(ii.height) > 0 ? { height: Number(ii.height) } : {}),
    ...(Number(ii.duration) > 0 ? { duration: Math.round(Number(ii.duration) * 10) / 10 } : {}),
    mime: kind === 'photo' ? 'image/jpeg' : mime,
  };
}

const interleave = (a, b) => {
  const out = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) { if (a[i]) out.push(a[i]); if (b[i]) out.push(b[i]); }
  return out;
};

/** The host and path a file may come from, or null. Openverse is only its picture proxy. */
export function allowedFile(u) {
  try {
    const p = new URL(u);
    if (p.protocol !== 'https:' || p.username || p.password || p.port || !FILE_HOSTS.includes(p.hostname)) return null;
    if (p.hostname === 'api.openverse.org' && !/^\/v1\/(images|audio)\/[0-9a-f-]{36}\/thumb\/$/.test(p.pathname)) return null;
    return p;
  } catch {
    return null;
  }
}

/** One per isolate (tests make their own): the search cache and Openverse's back-off. */
export function createStockMedia({ fetcher = (u, init) => fetch(u, init), now = Date.now } = {}) {
  const cache = new Map();
  let busyUntil = 0;
  const getJson = async (u) => {
    const r = await fetcher(u, { headers: { 'user-agent': UA, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(LOOKUP_MS) });
    if (r.status === 429) throw new RateLimited(BUSY);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  async function openverse(kind, q, page) {
    if (kind === 'video') return [];
    if (now() < busyUntil) throw new RateLimited(BUSY);
    const u = `https://api.openverse.org/v1/${kind === 'audio' ? 'audio' : 'images'}/?q=${encodeURIComponent(q)}&page=${page}&page_size=${PAGE_SIZE}&license_type=commercial,modification&mature=false`;
    try {
      const j = await getJson(u);
      return (j.results || []).map((r) => fromOpenverse(r, kind)).filter((x) => x && (kind !== 'audio' || allowedFile(x.original)));
    } catch (e) {
      if (e instanceof RateLimited) busyUntil = now() + 60_000;
      throw e;
    }
  }
  async function commons(kind, q, page) {
    const u = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*'
      + `&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(`${q} filetype:${kind === 'photo' ? 'bitmap' : kind}`)}&gsrlimit=${PAGE_SIZE}&gsroffset=${(page - 1) * PAGE_SIZE}`
      + (kind === 'photo'
        ? '&prop=imageinfo&iiprop=url%7Csize%7Cmime%7Cextmetadata&iiextmetadatafilter=LicenseShortName%7CLicenseUrl%7CArtist%7CObjectName&iiurlwidth=1280'
        : '&prop=videoinfo&viprop=url%7Csize%7Cmime%7Cextmetadata%7Cderivatives&viextmetadatafilter=LicenseShortName%7CLicenseUrl%7CArtist%7CObjectName&viurlwidth=480');
    const j = await getJson(u);
    return ((j.query && j.query.pages) || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0)).map((pg) => fromCommons(pg, kind)).filter(Boolean);
  }
  async function search(kind, rawQ, page = 1) {
    const q = String(rawQ ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
    if (!MEDIA_KINDS.includes(kind)) throw new ApiError(400, 'bad_request', 'kind must be photo, video or audio.');
    if (!q) throw new ApiError(400, 'bad_request', 'Type what to search for.');
    const pg = Math.min(20, Math.max(1, Math.floor(page) || 1));
    const key = `${kind}|${pg}|${q.toLowerCase()}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.value;
    const [ov, wc] = await Promise.allSettled([openverse(kind, q, pg), commons(kind, q, pg)]);
    const notices = [];
    const failed = (r, name) => {
      if (r.status === 'fulfilled') return false;
      notices.push(r.reason instanceof RateLimited ? `${BUSY} Showing ${name === 'Openverse' ? 'Wikimedia Commons' : 'Openverse'} results only; try again in a minute.` : `${name} didn’t answer, so its results are missing.`);
      return true;
    };
    const ovFailed = kind !== 'video' && failed(ov, 'Openverse');
    const wcFailed = failed(wc, 'Wikimedia Commons');
    if (wcFailed && (ovFailed || kind === 'video')) {
      if ((ov.status === 'rejected' && ov.reason instanceof RateLimited) || wc.reason instanceof RateLimited) throw new ApiError(429, 'busy', `${BUSY} Wait a minute and search again.`);
      throw new ApiError(502, 'upstream', 'The stock media libraries didn’t answer. Check the connection and try again.');
    }
    const value = { items: interleave(ov.status === 'fulfilled' ? ov.value : [], wc.status === 'fulfilled' ? wc.value : []), notices };
    if (!notices.length) { // a partial answer isn't kept, so the next search asks again
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
      cache.set(key, { at: now(), value });
    }
    return value;
  }
  async function file(request, raw) {
    let target = allowedFile(raw);
    if (!target) throw new ApiError(400, 'bad_request', 'That file isn’t from a stock media library Eden uses.');
    const range = /^bytes=\d*-\d*$/.test(request.headers.get('range') || '') ? request.headers.get('range') : '';
    let r = null;
    for (let hop = 0; hop < 4; hop++) { // redirects are followed only to allowed hosts
      r = await fetcher(target.href, { headers: { 'user-agent': UA, accept: 'image/*,audio/*,video/*,application/ogg', ...(range ? { range } : {}) }, redirect: 'manual' }).catch(() => null);
      if (!r || r.status < 300 || r.status >= 400) break;
      const next = allowedFile(new URL(r.headers.get('location') || '', target).href);
      if (!next) throw new ApiError(502, 'upstream', 'The file moved somewhere Eden doesn’t load from.');
      target = next;
      r = null;
    }
    if (!r) throw new ApiError(502, 'upstream', 'The file couldn’t be loaded.');
    if (r.status === 429) throw new ApiError(429, 'busy', 'The library is busy right now. Wait a minute and try again.');
    if (!r.ok) throw new ApiError(502, 'upstream', `The file couldn’t be loaded (HTTP ${r.status}).`);
    const ctype = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const kind = Object.keys(FILE_TYPE).find((k) => FILE_TYPE[k].test(ctype));
    if (!kind) throw new ApiError(502, 'upstream', 'That file isn’t a picture, sound or video Eden can use.');
    const limit = FILE_LIMITS[kind];
    const total = Number((r.headers.get('content-range') || '').split('/')[1]) || Number(r.headers.get('content-length')) || 0;
    if (total > limit) throw new ApiError(413, 'too_large', `That file is too large (over ${limit / 1024 / 1024} MB).`);
    const headers = new Headers({ 'content-type': ctype, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'cross-origin-resource-policy': 'same-origin' });
    for (const h of ['content-length', 'content-range', 'accept-ranges']) { const v = r.headers.get(h); if (v) headers.set(h, v); }
    let seen = 0;
    const body = r.body && request.method !== 'HEAD' ? r.body.pipeThrough(new TransformStream({ transform(chunk, c) { seen += chunk.byteLength; if (seen > limit) c.error(new Error('too large')); else c.enqueue(chunk); } })) : null;
    return new Response(body, { status: r.status === 206 ? 206 : 200, headers });
  }
  /** GET /api/chat/media/search or /file; `who` is the signed-in session (chat.js gate); `limit` rate-limits a search. */
  async function api(request, path, { limit = async () => {} } = {}) {
    if (request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError(405, 'bad_request', 'GET only');
    const url = new URL(request.url);
    if (path === MEDIA_SEARCH) {
      await limit();
      const out = await search(url.searchParams.get('kind') || 'photo', url.searchParams.get('q') || '', Number(url.searchParams.get('page')) || 1);
      return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    }
    if (path === MEDIA_FILE) return file(request, url.searchParams.get('u') || '');
    throw new ApiError(404, 'not_found', 'Not found');
  }
  return { search, file, api };
}

let shared = null;
/** chat.js: one cache per isolate. */
export function stockMediaApi(request, path, opts) {
  shared = shared || createStockMedia();
  return shared.api(request, path, opts);
}
