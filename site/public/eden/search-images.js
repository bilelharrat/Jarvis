// Pictures with a search answer, the way ChatGPT shows them (no DOM; shared by the Mac server, src/chat/search-images.ts,
// and askeden.com's Worker, which imports it from public/eden; tested by src/__tests__/search-images.test.ts).
//
// How ChatGPT does it: on a search turn the model itself decides whether pictures would help (a person, an animal, a
// place, a travel destination, a historical event…), makes at most one image query, and the pictures show as a strip at
// the top of the reply that the text doesn't repeat. Eden does the same: the client says it can show pictures
// (`images: true` on POST /api/chat/send, never in the iPhone app for now), a search turn's system prompt gets
// IMAGES_PROMPT, and a model that wants pictures starts its reply with one `[images: …]` line. The server takes that line
// out of the stream (markerFilter), looks the query up on Wikipedia (an article's own pictures are chosen by its editors:
// no ads, no stock watermarks, much safer than open image search, and free), and sends a `webimages` event before `done`.
// The pictures load through the server (`/api/chat/webimage?u=`, Wikimedia hosts only), so the page's 'self'-only image
// policy stays and the person's address never reaches Wikimedia.

export const IMAGES_PROMPT =
  'Pictures: if pictures would genuinely help with this answer (the person asks about a person, an animal, a plant, a place or travel destination, a landmark, a building, a historical event, an artwork, a vehicle, or anything whose look matters), make the very first line of your reply exactly `[images: <a short query for the pictures, 1 to 5 words, in English>]`, then a blank line, then your answer. Eden removes that line and shows the pictures above your answer, so don’t describe or mention them. Use it at most once, and never for news, prices, scores, weather, how-to, code, maths, definitions, opinions or anything sexual, violent or graphic.';

/** The line itself: `[images: Eiffel Tower]` (also `[image: …]`, any case, spaces around). */
const MARKER = /^\s*\[\s*images?\s*:\s*([^\]\n]{1,120})\]\s*\n?/i;
/** Text that could still turn out to be the marker: whitespace, then a prefix of `[images: …` with no `]` or newline yet. */
const MAYBE = /^\s*(?:\[(?:\s*(?:i(?:m(?:a(?:g(?:e(?:s)?)?)?)?)?)?\s*(?::[^\]\n]*)?)?)?$/i;
const HOLD_MAX = 160;

/** A filter for a reply's text deltas: holds the start until it is clearly the marker or not, then lets text through.
 *  push(text) → the text to show now (maybe ''); flush() → whatever is still held (call at the end). `query` is set once a
 *  marker was taken out. */
export function markerFilter() {
  let held = '';
  let open = true;
  let trimming = false; // after the marker: the blank lines before the answer, whichever deltas they come in
  const f = {
    query: '',
    push(text) {
      if (trimming) {
        const rest = text.replace(/^\s+/, '');
        if (rest) trimming = false;
        return rest;
      }
      if (!open) return text;
      held += text;
      const m = MARKER.exec(held);
      if (m) {
        open = false;
        f.query = cleanQuery(m[1]);
        const rest = held.slice(m[0].length).replace(/^\s+/, '');
        held = '';
        trimming = !rest;
        return rest;
      }
      if (held.length <= HOLD_MAX && MAYBE.test(held)) return '';
      open = false;
      const out = held;
      held = '';
      return out;
    },
    flush() {
      open = false;
      const out = held;
      held = '';
      return out;
    },
  };
  return f;
}

// Never looked up, whatever the model asked (the prompt already says so; this is the backstop).
const UNSAFE = /\b(?:nude|nudity|naked|nsfw|porn\w*|sex\w*|erotic\w*|topless|lingerie|xxx|hentai|fetish|gore|corpse|dead\s+bod(?:y|ies)|decapitat\w*|beheading|execution|massacre\s+victims|autopsy|self[-\s]?harm|suicide)\b/i;

/** The model's query, tidied; '' when it's empty or not something to show pictures of. */
export function cleanQuery(q) {
  const s = String(q || '').replace(/[`"“”<>{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!s || UNSAFE.test(s)) return '';
  return s;
}

/** Wikipedia's languages Eden's pages come in. */
const wiki = (lang) => `https://${lang === 'fr' ? 'fr' : 'en'}.wikipedia.org/w/api.php`;
const COMMON = 'action=query&format=json&formatversion=2&origin=*';

/** First call: the best articles for the query, with each one's lead picture. */
export function searchUrl(q, lang = 'en') {
  return `${wiki(lang)}?${COMMON}&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=4&gsrqiprofile=classic_noboostlinks&prop=pageimages%7Cinfo&inprop=url&piprop=thumbnail%7Cname&pithumbsize=640`;
}

/** Second call: the pictures in the best article. */
export function articleImagesUrl(title, lang = 'en') {
  return `${wiki(lang)}?${COMMON}&generator=images&titles=${encodeURIComponent(title)}&gimlimit=40&prop=imageinfo&iiprop=url%7Csize%7Cmime&iiurlwidth=640`;
}

/** Wikipedia asks API clients to say who they are. */
export const WIKI_HEADERS = { 'user-agent': 'EdenChat/1.0 (https://askeden.com; hello@askeden.com)', accept: 'application/json' };

// File names that are rarely a picture of the thing: logos, icons, maps, charts, flags, seals, signatures, diagrams, wordmarks, scans.
const NOT_A_PHOTO = /logo|wordmark|typeface|font|icon|flag|symbol|seal|coat[_ ]of[_ ]arms|emblem|crest|insignia|signature|autograph|\bmap\b|_map|map_|locator|location|diagram|playbook|formation|route_tree|scheme|chart|graph|plans?\b|blueprint|schematic|vector|clipart|cartoon|caricature|silhouette|wikidata|commons-|ambox|question_book|edit-clear|padlock|portal|stub|disambig|crystal_clear|nuvola|text-x|folder|wiktionary|wikiquote|wikisource|wikinews|wikivoyage|speaker|audio|sound|banner|button|arrow|placeholder|blank|ribbon|medal|trophy_icon|jersey_number|uniform_template|kit_body|kit_left|kit_right|kit_shorts|kit_socks|\.svg$|\.gif$|\.tiff?$|\.pdf$|\.djvu$|\.webm$|\.ogg$|\.ogv$/i;
const MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Only Wikimedia's picture hosts, over https: the server's picture proxy loads nothing else. */
export function proxyAllowed(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === 'https:' && (url.hostname === 'upload.wikimedia.org' || url.hostname === 'thumb.wikimedia.org') && !url.username && !url.password && (url.port === '' || url.port === '443');
  } catch {
    return false;
  }
}

/** Wikimedia's tracking parameters off a picture's address. */
const bare = (u) => {
  try {
    const url = new URL(String(u));
    for (const k of [...url.searchParams.keys()]) if (k.startsWith('utm_')) url.searchParams.delete(k);
    return url.href;
  } catch {
    return '';
  }
};

/** A file name as words: "File:Tour_Eiffel_(cropped).jpg" → "Tour Eiffel (cropped)". */
const caption = (name) => decodeURIComponent(String(name || '').replace(/^File:/i, '')).replace(/_/g, ' ').replace(/\.[a-z0-9]{2,5}$/i, '').trim().slice(0, 140);

/** The pictures to show (at most `max`), from the two answers: the best article's lead picture first, then its own
 *  pictures, then the next articles' lead pictures. Each is { thumb, width, height, title, page, article, articleUrl }
 *  with `thumb` a Wikimedia address (the caller turns it into a proxied one). */
export function pickImages(search, images, { max = 10 } = {}) {
  const pages = ((search && search.query && search.query.pages) || []).slice().sort((a, b) => (a.index || 0) - (b.index || 0));
  const top = pages[0] || { title: '', fullurl: '' };
  const out = [];
  const seen = new Set();
  const add = (p) => {
    if (!p.thumb || !proxyAllowed(p.thumb) || out.length >= max) return;
    const key = String(p.name || p.thumb).toLowerCase().replace(/^file:/, '').replace(/_/g, ' ');
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ thumb: bare(p.thumb), width: p.width, height: p.height, title: caption(p.name || 'Picture'), page: p.page || (p.name ? `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(p.name.replace(/^File:/i, '').replace(/ /g, '_'))}` : ''), article: p.article || '', articleUrl: p.articleUrl || '' });
  };
  const ok = (w, h) => w >= 280 && h >= 180 && w / h <= 2.6 && h / w <= 2.2;
  const lead = (pg) => {
    const t = pg && pg.thumbnail;
    if (!t || !pg.pageimage || NOT_A_PHOTO.test(pg.pageimage) || !ok(t.width, t.height)) return null;
    return { thumb: t.source, width: t.width, height: t.height, name: pg.pageimage, article: pg.title, articleUrl: pg.fullurl || '' };
  };
  const first = pages.length ? lead(top) : null;
  if (first) add(first);
  for (const pg of pages.slice(1, 5)) { const l = lead(pg); if (l) add(l); }
  const files = ((images && images.query && images.query.pages) || [])
    .map((f) => ({ f, ii: f.imageinfo && f.imageinfo[0] }))
    .filter(({ f, ii }) => ii && MIMES.has(ii.mime) && !NOT_A_PHOTO.test(f.title || '') && !NOT_A_PHOTO.test(ii.url || '') && ok(ii.thumbwidth || ii.width, ii.thumbheight || ii.height) && (ii.width || 0) >= 400)
    // Prefer genuine JPEGs (real camera photographs) and larger originals over small PNG graphics
    .sort((a, b) => {
      const aJpg = a.ii.mime === 'image/jpeg' ? 1 : 0;
      const bJpg = b.ii.mime === 'image/jpeg' ? 1 : 0;
      if (aJpg !== bJpg) return bJpg - aJpg;
      return (b.ii.width * b.ii.height) - (a.ii.width * a.ii.height);
    });
  for (const { f, ii } of files) add({ thumb: ii.thumburl || ii.url, width: ii.thumbwidth || ii.width, height: ii.thumbheight || ii.height, name: f.title, page: ii.descriptionurl || '', article: top.title || '', articleUrl: top.fullurl || '' });
  for (const pg of pages.slice(5)) { const l = lead(pg); if (l) add(l); }
  return out;
}

/** Look the query up: `get(url)` fetches JSON (the caller's fetch, with WIKI_HEADERS and a timeout). Never throws: [] on
 *  any failure. `proxy(thumb)` makes each picture's address the page will load. */
export async function findImages(q, { get, lang = 'en', proxy = (u) => `/api/chat/webimage?u=${encodeURIComponent(u)}`, max = 5 }) {
  const query = cleanQuery(q);
  if (!query) return [];
  try {
    const search = await get(searchUrl(query, lang));
    const pages = (search && search.query && search.query.pages) || [];
    const top = pages.slice().sort((a, b) => (a.index || 0) - (b.index || 0))[0];
    if (!top) return [];
    const images = await get(articleImagesUrl(top.title, lang)).catch(() => null);
    return pickImages(search, images, { max }).map((p) => ({ ...p, src: proxy(p.thumb) }));
  } catch {
    return [];
  }
}

/** What a `webimages` event carries, checked on the page before anything is shown (render.js). */
export function cleanEventImages(list) {
  const out = [];
  for (const p of Array.isArray(list) ? list.slice(0, 8) : []) {
    if (!p || typeof p.src !== 'string' || !p.src.startsWith('/api/chat/webimage?u=')) continue;
    const link = (u) => { try { const x = new URL(String(u)); return x.protocol === 'https:' && /(^|\.)(wikipedia|wikimedia)\.org$/.test(x.hostname) ? x.href : ''; } catch { return ''; } };
    out.push({
      src: p.src,
      width: Number(p.width) > 0 ? Math.round(Number(p.width)) : 0,
      height: Number(p.height) > 0 ? Math.round(Number(p.height)) : 0,
      title: String(p.title || '').slice(0, 140),
      page: link(p.page),
      article: String(p.article || '').slice(0, 140),
      articleUrl: link(p.articleUrl),
    });
  }
  return out;
}
