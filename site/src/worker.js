// askeden.com: J.A.R.V.I.S.'s site and the download itself, on Cloudflare (the whole domain;
// the old Eden site on Vercel is no longer shown there).
//
//   /, /jarvis              the page (./public/jarvis/index.html)
//   /jarvis/…               its images
//   /download, /jarvis/download   the latest disk image, from R2 (resumable: Range requests)
//   /latest.json, /jarvis/latest.json   its version, size and file name, for the page
//   anything else           back to the page
//
// What "latest" is lives in R2 itself: latest.json, written by the release script after the
// disk image is up, so a half-uploaded release is never offered.

const LATEST = 'latest.json';
// Before the R2 bucket is bound (a deploy without it), the download is the same notarized
// file from the GitHub release.
const FALLBACK = {
  version: '0.1.0',
  size: 310650543,
  file: 'J.A.R.V.I.S.-0.1.0.dmg',
  url: 'https://github.com/bilelharrat/Jarvis/releases/latest/download/J.A.R.V.I.S.-0.1.0.dmg',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
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

async function latestInfo(env) {
  const latest = env.DOWNLOADS ? await readLatest(env) : FALLBACK;
  if (!latest) return json({ error: 'No release yet.' }, 404);
  const { version = '', size = 0, file, published = '' } = latest;
  return json({ version, size, file, published }, 200, { 'cache-control': 'public, max-age=60' });
}

async function download(request, env) {
  if (!env.DOWNLOADS) return Response.redirect(FALLBACK.url, 302);
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
