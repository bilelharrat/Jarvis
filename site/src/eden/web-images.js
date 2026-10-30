// Pictures with a search answer, ChatGPT-style (askeden docs/search-images.md; the shared module is askeden's
// web/chat/search-images.js, synced to public/eden). On a search turn from a page that sends `images: true`, the prompt
// lets the model start its reply with one `[images: …]` line; it is taken out of the stream, looked up on Wikipedia,
// and the pictures go to the page as a `webimages` event before `done`. GET /api/chat/webimage?u= loads one Wikimedia
// picture for the page (its 'self'-only image policy stays; the person's address never reaches Wikimedia).

import { IMAGES_PROMPT, WIKI_HEADERS, findImages, markerFilter, proxyAllowed } from '../../public/eden/search-images.js';
import { ApiError } from '../accounts/util.js';

const LOOKUP_MS = 5_000;
const PICTURES_WAIT_MS = 3_000;
const PICTURE_MAX_BYTES = 6 * 1024 * 1024;
const PICTURE_TYPES = /^image\/(jpeg|png|webp)$/;
const MARKER_LINE = /^\s*\[\s*images?\s*:[^\]\n]{1,120}\]\s*/i;

/** GET /api/chat/webimage?u= or ?q=: Wikimedia's picture hosts only, jpeg/png/webp, at most 6 MB, cached a day. */
export async function webImageApi(request, { fetcher = fetch } = {}) {
  if (request.method !== 'GET') throw new ApiError(405, 'bad_request', 'GET only');
  const reqUrl = new URL(request.url);
  const q = (reqUrl.searchParams.get('q') || '').trim();
  if (q) {
    const lang = reqUrl.searchParams.get('lang') === 'fr' ? 'fr' : 'en';
    const wikiBase = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*`;
    const commonsBase = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*';
    const searchWiki = async (queryStr) => {
      const sUrl = `${wikiBase}&generator=search&gsrsearch=${encodeURIComponent(queryStr.slice(0, 80))}&gsrlimit=8&gsrqiprofile=classic_noboostlinks&prop=pageimages%7Cinfo&inprop=url&piprop=thumbnail%7Cname&pithumbsize=1280`;
      const sRes = await fetcher(sUrl, { headers: WIKI_HEADERS, signal: AbortSignal.timeout(LOOKUP_MS) }).catch(() => null);
      return sRes && sRes.ok ? await sRes.json().catch(() => null) : null;
    };
    const searchCommons = async (queryStr) => {
      const cUrl = `${commonsBase}&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(`${queryStr.slice(0, 80)} filetype:bitmap`)}&gsrlimit=20&prop=imageinfo&iiprop=url%7Csize%7Cmime&iiurlwidth=1280`;
      const cRes = await fetcher(cUrl, { headers: WIKI_HEADERS, signal: AbortSignal.timeout(LOOKUP_MS) }).catch(() => null);
      return cRes && cRes.ok ? await cRes.json().catch(() => null) : null;
    };
    let [sJson, cJson] = await Promise.all([searchWiki(q), searchCommons(q)]);
    let pages = ((sJson && sJson.query && sJson.query.pages) || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0));
    const stopWords = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'how', 'why', 'what', 'when', 'where', 'diagram', 'play', 'plays', 'system', 'offensive', 'defensive', 'strategy', 'overview', 'analysis', 'history', 'career', 'favorite', 'favourite', 'slide', 'photo', 'picture', 'image', 'portrait', 'dna', 'way', 'blueprint', 'philosophy', 'anatomy', 'architecture', 'mastery', 'mechanics', 'machine', 'option', 'routes', 'seam', 'dictation', 'personnel', 'execution', 'situational']);
    if (pages.filter((pg) => pg && pg.thumbnail && pg.thumbnail.source).length < 2 && q.split(/\s+/).length > 1) {
      const keyWords = q.replace(/[^A-Za-z0-9\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !stopWords.has(w.toLowerCase())).slice(0, 3).join(' ');
      if (keyWords && keyWords.toLowerCase() !== q.toLowerCase()) {
        const [s2, c2] = await Promise.all([searchWiki(keyWords), searchCommons(keyWords)]);
        const p2 = ((s2 && s2.query && s2.query.pages) || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0));
        if (p2.length) {
          const seenIds = new Set(pages.map((x) => x.pageid || x.title));
          for (const pg of p2) if (!seenIds.has(pg.pageid || pg.title)) pages.push(pg);
          sJson = { query: { pages } };
        }
        if (c2 && c2.query && c2.query.pages && c2.query.pages.length) {
          const cPages = [...((cJson && cJson.query && cJson.query.pages) || []), ...((c2 && c2.query && c2.query.pages) || [])];
          cJson = { query: { pages: cPages } };
        }
      }
    }
    const topTitles = pages.slice(0, 2).map((pg) => pg && pg.title).filter(Boolean).join('|');
    let aJson = null;
    if (topTitles) {
      const aUrl = `${wikiBase}&generator=images&titles=${encodeURIComponent(topTitles)}&gimlimit=40&prop=imageinfo&iiprop=url%7Csize%7Cmime&iiurlwidth=1280`;
      const aRes = await fetcher(aUrl, { headers: WIKI_HEADERS, signal: AbortSignal.timeout(LOOKUP_MS) }).catch(() => null);
      aJson = aRes && aRes.ok ? await aRes.json().catch(() => null) : null;
    }
    const aPages = [...((aJson && aJson.query && aJson.query.pages) || []), ...((cJson && cJson.query && cJson.query.pages) || [])];
    const mergedImages = aPages.length ? { query: { pages: aPages } } : aJson;
    if (!pages.length && aPages.length) {
      sJson = { query: { pages: [{ title: q, index: 1 }] } };
    }
    return new Response(JSON.stringify({ search: sJson, images: mergedImages }), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, max-age=3600' },
    });
  }
  const u = reqUrl.searchParams.get('u') || '';
  if (!proxyAllowed(u)) throw new ApiError(400, 'bad_request', 'Only Wikimedia pictures load here.');
  const r = await fetcher(u, { headers: { 'user-agent': WIKI_HEADERS['user-agent'], accept: 'image/webp,image/jpeg,image/png' }, redirect: 'error', cf: { cacheTtl: 86400, cacheEverything: true } }).catch(() => null);
  const type = ((r && r.headers.get('content-type')) || '').split(';')[0].trim().toLowerCase();
  if (!r || !r.ok || !PICTURE_TYPES.test(type)) throw new ApiError(502, 'upstream', 'The picture couldn’t be loaded.');
  if (Number(r.headers.get('content-length') || 0) > PICTURE_MAX_BYTES) throw new ApiError(502, 'upstream', 'The picture is too large.');
  const bytes = await r.arrayBuffer();
  if (bytes.byteLength > PICTURE_MAX_BYTES) throw new ApiError(502, 'upstream', 'The picture is too large.');
  return new Response(bytes, {
    headers: { 'content-type': type, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox" },
  });
}

/** The turn's side, or null when this turn shows no pictures: a search turn (after any risk rule made it one), from a
 *  page that asked, not a course. `prompt` joins the system prompt; `attempt(emit, write, signal)` wraps one attempt's
 *  emit; `settle()` waits (capped) for the pictures before `done`. */
export function picturesFor(raw, body, { grounding = null, fetcher = fetch } = {}) {
  if (!raw || raw.images !== true || body.mode !== 'search' || grounding) return null;
  let found = null;
  let closed = false;
  const get = async (url) => {
    const r = await fetcher(url, { headers: WIKI_HEADERS, signal: AbortSignal.timeout(LOOKUP_MS) });
    if (!r.ok) throw new Error(`Wikipedia answered ${r.status}`);
    return r.json();
  };
  return {
    prompt: IMAGES_PROMPT,
    attempt(emit, write, signal) {
      const marker = markerFilter();
      const release = () => { const rest = marker.flush(); if (rest) emit('text', { text: rest }); };
      return {
        emit(type, data) {
          if (type !== 'text') { release(); emit(type, data); return; }
          const text = marker.push(String((data && data.text) || ''));
          if (marker.query && !found) {
            const query = marker.query;
            found = findImages(query, { get }).then((images) => { if (images.length && !closed && !signal.aborted) write('webimages', { query, images }); }, () => {});
          }
          if (text) emit('text', { ...data, text });
        },
        /** The attempt ended: whatever the filter still holds goes out. */
        end: release,
        /** The reply's full text without the line (what the checks after the reply read). */
        strip: (text) => (marker.query || MARKER_LINE.test(String(text || '')) ? String(text || '').replace(MARKER_LINE, '') : text),
      };
    },
    async settle() {
      if (found) await Promise.race([found, new Promise((r) => setTimeout(r, PICTURES_WAIT_MS))]);
      closed = true;
    },
  };
}
