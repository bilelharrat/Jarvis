// Where Eden News gets its articles, chosen by NEWS_PROVIDER:
//
//   'live'             the same way BSH Research Center's News Desk does it (bsh-research-center server/live_quotes.py
//                      fetch_news): Yahoo Finance's search endpoint (markets and companies, with thumbnails), plus
//                      Google News' RSS (top stories, each section, and search for a reader's follows and city) and
//                      publisher RSS (BBC, The Guardian, NPR: summaries and pictures). Headlines, the feed's own short
//                      description and a link to the publisher; never the article's full text.
//   (unset) 'sample'   built-in sample articles, marked as samples on the page (tests, local work).
//
// An article: { id, title, summary, url, source, publishedAt (ms), image?, imageRights?, region?, category?,
//               related?: [{ name, url, title }] }  (related: other outlets' coverage Google News groups with it)

export const SAMPLE = 'sample';
export const LIVE = 'live';
const UA = 'Mozilla/5.0 (compatible; EdenNews/1.0; +https://askedennews.com)';
const TIMEOUT_MS = 8000;
const GN = (path) => `https://news.google.com/rss${path}${path.includes('?') ? '&' : '?'}hl=en-US&gl=US&ceid=US:en`;
const YAHOO = (q, n = 10) => `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&newsCount=${n}&quotesCount=0`;

/** The feeds every edition is built from. `category` helps rank.js classify (a topic id). */
export const FEEDS = [
  { url: GN(''), kind: 'google' },
  { url: GN('/headlines/section/topic/WORLD'), kind: 'google', category: 'world' },
  { url: GN('/headlines/section/topic/NATION'), kind: 'google', category: 'politics' },
  { url: GN('/headlines/section/topic/BUSINESS'), kind: 'google', category: 'business' },
  { url: GN('/headlines/section/topic/TECHNOLOGY'), kind: 'google', category: 'tech' },
  { url: GN('/headlines/section/topic/SCIENCE'), kind: 'google', category: 'science' },
  { url: GN('/headlines/section/topic/HEALTH'), kind: 'google', category: 'science' },
  { url: GN('/headlines/section/topic/SPORTS'), kind: 'google', category: 'sports' },
  { url: GN('/headlines/section/topic/ENTERTAINMENT'), kind: 'google', category: 'culture' },
  { url: 'https://feeds.bbci.co.uk/news/rss.xml', kind: 'rss', source: 'BBC News' },
  { url: 'https://www.theguardian.com/world/rss', kind: 'rss', source: 'The Guardian', category: 'world' },
  { url: 'https://feeds.npr.org/1001/rss.xml', kind: 'rss', source: 'NPR' },
  // publisher feeds that carry a picture on (nearly) every story: they give Google's stories their photos too (rank.js
  // cluster merges the same story from both), checked 2026-10-14 (CBS, ESPN, Al Jazeera, TechCrunch send none)
  ...[['HomePage', ''], ['World', 'world'], ['Politics', 'politics'], ['Business', 'business'], ['Technology', 'tech'], ['Science', 'science'], ['Arts', 'culture']]
    .map(([s, category]) => ({ url: `https://rss.nytimes.com/services/xml/rss/nyt/${s}.xml`, kind: 'rss', source: 'The New York Times', category })),
  ...[['technology', 'tech'], ['business', 'business'], ['science_and_environment', 'science']]
    .map(([s, category]) => ({ url: `https://feeds.bbci.co.uk/news/${s}/rss.xml`, kind: 'rss', source: 'BBC News', category })),
  { url: 'https://feeds.bbci.co.uk/sport/rss.xml', kind: 'rss', source: 'BBC Sport', category: 'sports' },
  ...[['us-news', 'politics'], ['technology', 'tech'], ['business', 'business'], ['science', 'science'], ['sport', 'sports'], ['culture', 'culture']]
    .map(([s, category]) => ({ url: `https://www.theguardian.com/${s}/rss`, kind: 'rss', source: 'The Guardian', category })),
  { url: 'https://abcnews.go.com/abcnews/topstories', kind: 'rss', source: 'ABC News' },
  { url: 'https://feeds.skynews.com/feeds/rss/home.xml', kind: 'rss', source: 'Sky News' },
  // BSH's market tape: the index ETFs it always adds (live_quotes.py)
  ...['SPY', 'QQQ', 'DIA'].map((q) => ({ url: YAHOO(q), kind: 'yahoo', category: 'business' })),
];

/** The provider's articles, newest first, and whether they are samples. */
export async function fetchArticles(env = {}, now = Date.now()) {
  const provider = String(env.NEWS_PROVIDER || SAMPLE).trim();
  if (provider === SAMPLE) return { provider, sample: true, articles: sampleArticles(now) };
  if (provider !== LIVE) throw new Error(`News provider "${provider}" isn't built.`);
  const results = await Promise.allSettled(FEEDS.map((f) => readFeed(f)));
  const articles = dedupe(results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])));
  if (!articles.length) throw new Error('No news source answered.');
  return { provider, sample: false, articles };
}

/** Search results for one query (a reader's follow or city): Google News search, and Yahoo's for companies. */
export async function searchArticles(env = {}, query) {
  const q = String(query || '').trim().slice(0, 80);
  if (!q || String(env.NEWS_PROVIDER || SAMPLE).trim() !== LIVE) return [];
  const results = await Promise.allSettled([
    readFeed({ url: GN(`/search?q=${encodeURIComponent(`"${q}" when:3d`)}`), kind: 'google' }),
    readFeed({ url: YAHOO(q, 6), kind: 'yahoo' }),
  ]);
  return dedupe(results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])));
}

async function readFeed(feed) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(feed.url, { headers: { 'user-agent': UA, accept: feed.kind === 'yahoo' ? 'application/json' : 'application/rss+xml, application/xml, text/xml' }, signal: controller.signal, redirect: 'follow' });
    if (!r.ok) return [];
    if (feed.kind === 'yahoo') return parseYahoo(await r.json(), feed);
    return parseRss(await r.text(), feed);
  } catch {
    return []; // one source down doesn't stop the edition
  } finally {
    clearTimeout(timer);
  }
}

function dedupe(articles) {
  const seen = new Set();
  const out = [];
  for (const a of articles.sort((x, y) => y.publishedAt - x.publishedAt)) {
    const key = a.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key || seen.has(key) || seen.has(a.url)) continue;
    seen.add(key);
    seen.add(a.url);
    out.push(a);
  }
  return out;
}

// ── parsing ──

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function unescape(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
      }
      return ENT[e.toLowerCase()] ?? m;
    });
}
const stripTags = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (xml, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? m[1] : '';
};
const attr = (s, name) => {
  const m = new RegExp(`\\b${name}="([^"]*)"`, 'i').exec(s);
  return m ? unescape(m[1]) : '';
};
const httpUrl = (u) => (/^https:\/\//i.test(u) ? u : /^http:\/\//i.test(u) ? u.replace(/^http:/i, 'https:') : '');

/** A short, plain summary: the feed's description, first paragraph, at most ~280 characters on a sentence end. */
export function shortSummary(html) {
  const first = unescape(html).split(/<\/p>/i)[0];
  const text = stripTags(unescape(first)).replace(/\s*Continue reading\.*$/i, '');
  if (text.length <= 280) return text;
  const cut = text.slice(0, 280);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return end > 120 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, '')}…`;
}

/** A short stable id for a URL (FNV-1a). */
export function idOf(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `n${(h >>> 0).toString(36)}`;
}

/** RSS 2.0 (Google News, BBC, The Guardian, NPR) → articles. */
export function parseRss(xml, feed = {}) {
  const out = [];
  for (const m of String(xml).matchAll(/<item\b[\s\S]*?<\/item>/gi)) {
    const item = m[0];
    let title = stripTags(unescape(tag(item, 'title')));
    const url = httpUrl(unescape(tag(item, 'link')).trim());
    const published = Date.parse(unescape(tag(item, 'pubDate')).trim());
    if (!title || !url || !Number.isFinite(published)) continue;
    let source = feed.source || '';
    let summary = '';
    let related = [];
    if (feed.kind === 'google') {
      source = stripTags(unescape(tag(item, 'source'))) || source;
      // Google ends each headline with " - <outlet>" (sometimes a sub-brand of the source, e.g. The Athletic): drop it
      const dash = title.lastIndexOf(' - ');
      if (dash > 20 && title.length - dash <= 45) title = title.slice(0, dash).trim();
      // Google's description lists the other outlets covering the same story
      related = [...unescape(tag(item, 'description')).matchAll(/<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>(?:&nbsp;|\s| )*<font[^>]*>([\s\S]*?)<\/font>/gi)]
        .map(([, href, t, name]) => ({ url: httpUrl(unescape(href)), title: stripTags(t), name: stripTags(name) }))
        .filter((r) => r.url && r.name && r.name !== source).slice(0, 6);
    } else {
      summary = shortSummary(tag(item, 'description'));
    }
    // the largest picture the feed offers (media:content, media:thumbnail, enclosure)
    let image = '';
    let width = 0;
    for (const p of item.matchAll(/<(media:content|media:thumbnail|enclosure)\b[^>]*>/gi)) {
      const u = httpUrl(attr(p[0], 'url'));
      const w = Number(attr(p[0], 'width')) || 1;
      if (u && /\.(jpe?g|png|webp)|\/img\/|ichef|guim|npr\.org|image/i.test(u) && w >= width) { image = u; width = w; }
    }
    if (image.includes('ichef.bbci.co.uk')) image = image.replace(/\/standard\/\d+\//, '/standard/800/');
    out.push({ id: idOf(url), title, summary, url, source: source || hostOf(url), publishedAt: published, image: image || null, imageRights: Boolean(image), category: feed.category || '', related });
  }
  return out;
}

/** Yahoo Finance search (the same endpoint and fields as BSH's fetch_news) → articles. */
export function parseYahoo(body, feed = {}) {
  return ((body && body.news) || []).map((n) => {
    const url = httpUrl(String(n.link || ''));
    const pics = ((n.thumbnail && n.thumbnail.resolutions) || []).filter((r) => r && r.url).sort((a, b) => (b.width || 0) - (a.width || 0));
    return url && n.title ? {
      id: idOf(url), title: String(n.title).trim(), summary: String(n.summary || '').trim().slice(0, 280), url,
      source: String(n.publisher || hostOf(url)), publishedAt: Number(n.providerPublishTime) * 1000,
      image: pics[0] ? httpUrl(pics[0].url) || null : null, imageRights: Boolean(pics[0]), category: feed.category || 'business', related: [],
    } : null;
  }).filter((a) => a && Number.isFinite(a.publishedAt));
}

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// ── samples: invented outlets and events, so nothing here reads as real reporting ──

const H = 3600e3;
const SAMPLES = [
  // one event, three outlets → one story with 3 sources
  ['s-transit-1', 'City council approves late-night transit pilot for six months', 'Three bus lines will run until 2 a.m. on weekends starting next month, the council decided.', 'Sample Daily', 1, 'Austin'],
  ['s-transit-2', 'Council approves late-night transit pilot on three lines', 'The six-month pilot extends weekend service on three routes.', 'Sample Wire', 1.5, 'Austin'],
  ['s-transit-3', 'Late-night transit pilot approved by city council', 'Supporters said night-shift workers need the service most.', 'Example Times', 2, 'Austin'],
  ['s-battery-1', 'Researchers report faster-charging sodium battery cell', 'A lab cell reached 80% charge in under fifteen minutes; it is not in products yet.', 'Sample Science', 2],
  ['s-battery-2', 'Sodium battery cell charges faster, researchers report', 'The study says the cell kept most of its capacity after 1,000 cycles.', 'Example Tech', 3],
  ['s-rates-1', 'Central bank holds interest rates and signals a slower path ahead', 'Officials pointed to cooling prices but warned about uneven wage growth.', 'Sample Business', 3],
  ['s-rates-2', 'Central bank holds interest rates, signals slower path', 'Markets rose slightly after the decision.', 'Sample Wire', 3.5],
  ['s-ai-1', 'New AI model tops a public chatbot leaderboard', 'The model leads on writing and reasoning tests; its developer cut prices for the first months.', 'Example Tech', 1],
  ['s-ai-2', 'AI model tops public chatbot leaderboard after launch', 'Independent testers say it is among the best at long documents.', 'Sample Daily', 1.2],
  ['s-phone-1', 'Phone maker previews a foldable with a bigger battery', 'The phone goes on sale next month in three colours.', 'Example Tech', 5],
  ['s-breach-1', 'Retailer says hackers accessed customer emails in data breach', 'No payment details were taken, the company said; customers should watch for phishing.', 'Sample Wire', 4],
  ['s-space-1', 'Rocket launch puts weather satellite into orbit', 'The satellite will improve storm forecasts over the ocean.', 'Sample Science', 6],
  ['s-storm-1', 'Storm system moves inland; flight delays expected Wednesday', 'Forecasters expect the heaviest rain overnight; airlines allow free rebooking.', 'Sample Daily', 0.6, 'Texas'],
  ['s-football-1', 'Riverside FC win late to stay top of the football league', 'A goal in stoppage time kept them two points clear.', 'Example Sport', 7],
  ['s-football-2', 'Riverside FC stay top of football league with late winner', 'The manager praised the substitutes.', 'Sample Wire', 7.5],
  ['s-nba-1', 'NBA season opens with record crowds', 'Opening night drew the most fans in a decade.', 'Example Sport', 9],
  ['s-tennis-1', 'Grand slam champion withdraws from tennis tour finals', 'An injury ends the season early.', 'Example Sport', 10],
  ['s-election-1', 'Election campaign enters final week with polls tied', 'Candidates focus on the economy and housing.', 'Sample Daily', 4],
  ['s-bill-1', 'Lawmakers pass bill to cap credit card late fees', 'The law takes effect next year.', 'Sample Business', 8],
  ['s-crime-1', 'Police arrest suspect after jewelry store robbery', 'Nobody was hurt, police said.', 'Sample Daily', 5],
  ['s-celeb-1', 'Celebrity couple announce engagement on red carpet', 'The pair met on a film set.', 'Example Times', 6],
  ['s-film-1', 'Animated film leads weekend box office', 'It earned more than expected in its first three days.', 'Example Times', 20],
  ['s-coral-1', 'Coral nursery study finds heat-tolerant strains', 'Some fragments survived temperatures that bleached others.', 'Sample Science', 22],
  ['s-health-1', 'Hospital trial finds new drug cuts migraine days', 'Patients reported four fewer migraine days a month.', 'Sample Science', 12],
  ['s-travel-1', 'Airline adds direct flights to three cities', 'Flights start in the spring.', 'Example Times', 14],
  ['s-war-1', 'Ceasefire talks resume as fighting continues', 'Diplomats meet again this week; dozens were killed in new attacks.', 'Sample Wire', 2.5],
];

export function sampleArticles(now = Date.now()) {
  return SAMPLES.map(([id, title, summary, source, hoursAgo, region]) => ({
    id, title, summary, source, region: region || null,
    url: `https://example.com/news/${id}`,
    publishedAt: now - hoursAgo * H,
    image: null, imageRights: false,
  }));
}
