// A destination's hero photo, real and licensed (planner v2, research_notes/travel/planner-v2-design.md §9): the lead
// image of the destination's English Wikipedia article, used only when it is a Wikimedia Commons file whose licence
// lets Eden show it with a credit: CC0, public domain, CC BY or CC BY-SA (never NC or ND, never an unknown licence).
// Its author and licence travel with it, shown on the photo. The picture itself comes through the Worker
// (/api/chat/travel/hero-image), and only from Commons' thumbnail server.
//
//   1. Wikipedia REST page/summary/<title> → originalimage.source (an upload.wikimedia.org URL)
//   2. Commons Action API prop=imageinfo&iiprop=extmetadata|url&iiurlwidth=1600 → the 1600 px thumbnail and
//      extmetadata LicenseShortName, LicenseUrl, Artist, Credit, UsageTerms
//
// Every answer carries `source` and `checked_at`; no licensed photo → null (the page falls back to its own picture).

const SUMMARY = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
// Commons files are served from upload.wikimedia.org and, since 2026, thumb.wikimedia.org (links now carry ?utm_… too)
const HOSTS = new Set(['upload.wikimedia.org', 'thumb.wikimedia.org']);
const COMMONS_FILE = /^https:\/\/(?:upload|thumb)\.wikimedia\.org\/wikipedia\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/?#]+)/;
const THUMB = /^\/wikipedia\/commons\/thumb\/[0-9a-f]\/[0-9a-f]{2}\/[^/?#]+\/[^/?#]+$/;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
export const HERO = { width: 1600, cacheMs: 30 * 86400_000 };
const TIMEOUT = 8000;
export const SOURCE = 'Wikimedia Commons';
// Wikimedia asks every API client to say who it is (its User-Agent policy)
const UA = 'EdenTravel/1.0 (https://askeden.com)';

export class HeroError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// HTML (Commons' Artist and Credit are HTML) → plain text
export function plainText(html) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : named[e.toLowerCase()] ?? m))
    .replace(/\s+/g, ' ')
    .trim();
}

/** A Commons licence Eden may show (with its credit): its short name, or null. */
export function allowedLicence(shortName) {
  const s = String(shortName || '').trim();
  if (!s || /\b(NC|ND)\b|non-?commercial|no-?deriv/i.test(s)) return null;
  if (/^(CC0|CC-?Zero)(\s+1\.0)?$/i.test(s)) return s;
  if (/^public domain$/i.test(s)) return s;
  if (/^CC BY(-SA)? \d\.\d(\s+[a-z]{2,3})?$/i.test(s)) return s; // CC BY 4.0, CC BY-SA 3.0, CC BY-SA 2.0 de
  return null;
}

const attributionFree = (licence) => /^(CC0|CC-?Zero|public domain)/i.test(licence);

async function getJson(fetcher, url) {
  let res;
  try {
    res = await fetcher(url, { headers: { 'Api-User-Agent': UA, 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) });
  } catch {
    throw new HeroError('unavailable', 'Wikipedia did not answer in time.');
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new HeroError('unavailable', `Wikipedia answered ${res.status}.`);
  return await res.json().catch(() => null);
}

/** heroFor(env, query, { fetch, now }) → { url, width, height, author, licence, licence_url, file_page, title, source, checked_at } | null */
export async function heroFor(env, query, { fetch: fetcher = globalThis.fetch, now = () => Date.now() } = {}) {
  const q = String(query || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  if (q.length < 2) return null;
  // "Lisbon, Portugal" → "Lisbon, Portugal" first, then "Lisbon"
  const titles = [...new Set([q, q.split(',')[0].trim()])].filter((t) => t.length >= 2);
  let page = null;
  for (const t of titles) {
    page = await getJson(fetcher, `${SUMMARY}${encodeURIComponent(t.replace(/ /g, '_'))}`);
    if (page && page.type !== 'disambiguation' && page.originalimage) break;
    page = null;
  }
  // a lead image kept on English Wikipedia itself (often non-free) isn't a Commons file: not used
  const file = COMMONS_FILE.exec(String(page?.originalimage?.source || ''));
  if (!file) return null;
  const name = decodeURIComponent(file[1]);
  const p = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', titles: `File:${name}`, prop: 'imageinfo', iiprop: 'extmetadata|url', iiurlwidth: String(HERO.width) });
  const info = await getJson(fetcher, `${COMMONS_API}?${p}`);
  const ii = info?.query?.pages?.[0]?.imageinfo?.[0];
  if (!ii) return null;
  const meta = ii.extmetadata || {};
  const value = (k) => (meta[k] && typeof meta[k].value === 'string' ? meta[k].value : '');
  const licence = allowedLicence(value('LicenseShortName'));
  if (!licence) return null;
  const author = plainText(value('Artist')) || plainText(value('Credit')) || null;
  if (!author && !attributionFree(licence)) return null; // CC BY needs a name to credit: without one, not shown
  // only Commons' thumbnail server (what the image route proxies); an original smaller than 1600 px has no thumbnail
  let thumb;
  try { thumb = new URL(String(ii.thumburl || '')); } catch { return null; }
  thumb.search = ''; // Wikimedia's tracking query, not part of the file
  if (thumb.protocol !== 'https:' || !HOSTS.has(thumb.hostname) || !THUMB.test(thumb.pathname)) return null;
  const licenceUrl = /^https?:\/\//.test(value('LicenseUrl')) ? value('LicenseUrl').replace(/^http:/, 'https:') : null;
  return {
    url: thumb.href,
    width: Number(ii.thumbwidth) || null,
    height: Number(ii.thumbheight) || null,
    author: author ? author.slice(0, 200) : null,
    licence,
    licence_url: licenceUrl,
    usage_terms: plainText(value('UsageTerms')).slice(0, 200) || null,
    file_page: /^https:\/\/commons\.wikimedia\.org\//.test(String(ii.descriptionurl || '')) ? ii.descriptionurl : `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(name.replace(/ /g, '_'))}`,
    title: page.title || null,
    source: SOURCE,
    checked_at: new Date(now()).toISOString(),
  };
}

/** Whether a URL is one the image route may fetch: Commons' thumbnail server, nothing else. */
export function heroImageAllowed(u) {
  let url;
  try { url = new URL(String(u || '')); } catch { return false; }
  return url.protocol === 'https:' && HOSTS.has(url.hostname) && !url.port && !url.username && !url.password && !url.search && THUMB.test(url.pathname) && !url.pathname.includes('..');
}

/** GET /api/chat/travel/hero-image?u=<thumb url> → the picture (images only), cached a day. */
export async function heroImage(url, { fetch: fetcher = globalThis.fetch } = {}) {
  const u = url.searchParams.get('u') || '';
  if (!heroImageAllowed(u)) throw new HeroError('bad_request', 'u must be a Wikimedia Commons thumbnail (upload. or thumb.wikimedia.org/wikipedia/commons/thumb/…).');
  let res;
  // 'manual': a redirect is refused, not followed (Workers' fetch has no redirect: 'error'; it throws on it)
  try { res = await fetcher(u, { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT) }); } catch { throw new HeroError('unavailable', 'Wikimedia did not answer in time.'); }
  if (res.status >= 300 && res.status < 400) throw new HeroError('unavailable', 'Wikimedia sent the picture elsewhere: not followed.');
  if (res.status === 404) throw new HeroError('not_found', 'Wikimedia has no such picture now.');
  const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!res.ok || !IMAGE_TYPES.includes(type)) throw new HeroError('unavailable', `Wikimedia answered ${res.status}${res.ok ? ' with something that isn’t a picture' : ''}.`);
  return new Response(res.body, { headers: { 'content-type': type, 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' } });
}
