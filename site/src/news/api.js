// Eden News on askeden.com: the /news page and /api/news/*. Off unless EDEN_NEWS = "on" (the route falls through
// to the rest of the site, as if News didn't exist), so a deploy of the shared tree can't switch it on by accident.
//
//   GET  /api/news/questions        the first-open questions and their choices (questions.js), signed out too
//   GET  /api/news/feed             the edition: personal when signed in and onboarded, else the shared front page
//   GET  /api/news/profile          { signedIn, profile | null, ask } — ask: show the first-open questions
//   POST /api/news/profile          answers (profile.js fromAnswers) → { profile }
//   POST /api/news/edition          { profile } → the edition ranked for a profile the Eden News app keeps on the phone
//                                   (no account, nothing stored; rate limited by address)
//   POST /api/news/feedback         { story, action: open | less | more | hide } → { profile }
//   POST /api/news/reset            forget this reader's News profile → { ok }
// Writes: signed in, this site's own page only (same origin, not cross-site, the X-Eden-News header), JSON, rate
// limited per account. The story's topics for feedback come from the server's copy of the story, never the page.

import { clientIp, limited } from '../accounts/index.js';
import { ApiError } from '../accounts/util.js';
import { currentSession } from '../eden/session.js';
import { crossSite, foreignOrigin, json, page, problem, sameOrigin, withHeaders } from '../eden/web.js';
import { ProfileError, cleanProfile, emptyProfile, fromAnswers, learn, publicProfile } from './profile.js';
import { questionnaire } from './questions.js';
import { cluster, edition } from './rank.js';
import { fetchArticles, searchArticles } from './sources.js';
import { eraseReader, getProfile, getSearch, getStories, putProfile, putSearch, putStories } from './store.js';

/** The News page: its own script and stylesheet; the publishers' pictures from their feeds (https). */
export const NEWS_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const NEWS_FILES = new Set(['index.html', 'news.js', 'news.css', 'news-logo.svg', 'favicon-64.png', 'apple-touch-icon.png']);
const MAX_BODY = 32 * 1024;

export const newsOn = (env) => String(env.EDEN_NEWS || '').trim().toLowerCase() === 'on';

/** /news and its files, or null (News off, or not a News path). */
export async function newsPage(request, env, path) {
  if (!newsOn(env) || (path !== '/news' && !path.startsWith('/news/'))) return null;
  const name = path === '/news' ? 'index.html' : path.slice('/news/'.length);
  if (!NEWS_FILES.has(name)) return null;
  const asset = await env.ASSETS.fetch(new Request(new URL(name === 'index.html' ? '/news/' : `/news/${name}`, request.url), request));
  if (name === 'index.html') return page(asset, NEWS_CSP, { cache: 'public, max-age=0, must-revalidate' });
  return withHeaders(asset, { 'cache-control': 'public, no-cache', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' });
}

/** /api/news/*, or null when News is off (worker.js then answers as for any unknown API path). */
export async function newsApi(request, env, ctx, path) {
  if (!newsOn(env)) return null;
  try {
    const route = `${request.method} ${path}`;
    if (route === 'GET /api/news/questions') return json(questionnaire(), 200, { 'cache-control': 'public, max-age=300' });
    if (route === 'GET /api/news/feed') return json(await feed(request, env, ctx));
    if (route === 'GET /api/news/image') return await storyImage(request, env, ctx);
    if (route === 'GET /api/news/profile') return json(await profileView(request, env));
    if (route === 'POST /api/news/profile') return json(await saveAnswers(request, env));
    if (route === 'POST /api/news/edition') return json(await appEdition(request, env, ctx));
    if (route === 'POST /api/news/feedback') return json(await feedback(request, env, ctx));
    if (route === 'POST /api/news/reset') return json(await reset(request, env));
    throw new ApiError(404, 'not_found', 'No such thing here.');
  } catch (error) {
    if (error instanceof ApiError) return problem(error.status, error.message, error.code, error.headers);
    if (error instanceof ProfileError) return problem(error.status, error.message, error.code);
    console.error('news failed', error && error.stack);
    return problem(500, 'News had a problem on the server. Try again in a minute.', 'server');
  }
}

/** The clustered stories: the shared cache, or fetched and clustered now (and cached for everyone). */
export async function loadStories(env, ctx, now = Date.now()) {
  if (env.NEWS) {
    const cached = await getStories(env, now).catch(() => ({ stale: true }));
    if (!cached.stale) return cached;
  }
  const { provider, sample, articles } = await fetchArticles(env, now);
  const value = { stories: cluster(articles), provider, sample, fetchedAt: now };
  if (env.NEWS) {
    const saving = putStories(env, value).catch((e) => console.error('news cache failed', e && e.message));
    if (ctx && ctx.waitUntil) ctx.waitUntil(saving);
    else await saving;
  }
  return value;
}

const IMAGE_MAX = 8 * 1024 * 1024;
/**
 * A story's picture through askeden.com (the chat app's News panel, web/chat/news-panel.js: its page allows images
 * from askeden.com only). Only a picture of a story in the current edition: never an open proxy.
 */
async function storyImage(request, env, ctx) {
  const u = new URL(request.url).searchParams.get('u') || '';
  if (!/^https:\/\//.test(u) || u.length > 2000) throw new ApiError(400, 'bad_request', 'Not a story picture.');
  const { stories } = await loadStories(env, ctx);
  if (!stories.some((st) => st && st.image === u)) throw new ApiError(404, 'not_found', 'Not a picture of a story in today\u2019s News.');
  const res = await fetch(u, { headers: { accept: 'image/*' }, redirect: 'follow', cf: { cacheTtl: 86400, cacheEverything: true } });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !/^image\/(?:jpeg|png|webp|gif|avif)\b/i.test(type)) throw new ApiError(502, 'bad_image', 'That picture couldn\u2019t be loaded.');
  const size = Number(res.headers.get('content-length') || 0);
  if (size > IMAGE_MAX) throw new ApiError(413, 'too_big', 'That picture is too big.');
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > IMAGE_MAX) throw new ApiError(413, 'too_big', 'That picture is too big.');
  return new Response(bytes, { headers: { 'content-type': type.split(';')[0], 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' } });
}

async function reader(request, env) {
  const { session } = await currentSession(request, env).catch(() => ({ session: null }));
  return session || null;
}

async function feed(request, env, ctx) {
  const now = Date.now();
  const [stories, session] = await Promise.all([loadStories(env, ctx, now), reader(request, env)]);
  const profile = session && env.NEWS ? await getProfile(env, session.account) : null;
  const personal = profile && (profile.onboarded || (profile.answered || []).length) ? profile : null;
  const all = personal ? [...stories.stories, ...(await searched(env, ctx, personal, stories.stories, now))] : stories.stories;
  return {
    ...edition(all, personal, now),
    signedIn: Boolean(session),
    ask: Boolean(session && env.NEWS && !(profile && profile.onboarded)),
    sample: stories.sample,
    updatedAt: stories.fetchedAt,
  };
}

const MAX_SEARCHES = 6; // a reader's follows and city searched per edition (each cached for everyone a while)

/** Stories about the reader's follows and city, from search (sources.js), that the shared edition doesn't have. */
async function searched(env, ctx, profile, have, now) {
  const queries = [...(profile.follows || []), ...(profile.local ? [profile.local] : [])].slice(0, MAX_SEARCHES);
  if (!queries.length) return [];
  const lists = await Promise.all(queries.map(async (q) => {
    if (env.NEWS) {
      const hit = await getSearch(env, q, now).catch(() => ({ stale: true }));
      if (!hit.stale) return hit.articles;
    }
    const articles = await searchArticles(env, q).catch(() => []);
    if (env.NEWS && articles.length) {
      const saving = putSearch(env, q, articles).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(saving);
    }
    return articles;
  }));
  const known = new Set(have.flatMap((s) => (s.sources || []).map((x) => x.url)));
  return cluster(lists.flat().filter((a) => a && !known.has(a.url))).filter((s) => !have.some((h) => h.title === s.title));
}

/** The edition for a profile the app keeps on the device: cleaned, ranked, never stored (the follows are searched, cached for everyone). */
async function appEdition(request, env, ctx) {
  if (foreignOrigin(request) || crossSite(request)) throw new ApiError(403, 'forbidden', 'Not from another site.');
  if (request.headers.get('x-eden-news') !== '1') throw new ApiError(403, 'forbidden', 'Missing X-Eden-News header.');
  if (!/^application\/json\b/i.test(request.headers.get('content-type') || '')) throw new ApiError(415, 'bad_request', 'Send JSON (content-type: application/json).');
  await limited(env, 'EDEN_RATE', `newsapp:${clientIp(request)}`);
  const now = Date.now();
  const { profile } = await body(request);
  const personal = cleanProfile(profile, now);
  const stories = await loadStories(env, ctx, now);
  const all = [...stories.stories, ...(await searched(env, ctx, personal, stories.stories, now))];
  return { ...edition(all, personal, now), signedIn: false, ask: false, sample: stories.sample, updatedAt: stories.fetchedAt };
}

async function profileView(request, env) {
  const session = await reader(request, env);
  if (!session || !env.NEWS) return { signedIn: Boolean(session), profile: null, ask: false };
  const profile = await getProfile(env, session.account);
  return { signedIn: true, profile: profile ? publicProfile(profile) : null, ask: !(profile && profile.onboarded) };
}

/** A write from this site's own News page, signed in: the session, or throws. */
async function writer(request, env) {
  if (crossSite(request) || !sameOrigin(request)) throw new ApiError(403, 'forbidden', 'Only askeden.com’s own pages may do that.');
  if (request.headers.get('x-eden-news') !== '1') throw new ApiError(403, 'forbidden', 'Missing X-Eden-News header.');
  if (!/^application\/json\b/i.test(request.headers.get('content-type') || '')) throw new ApiError(415, 'bad_request', 'Send JSON (content-type: application/json).');
  if (!env.NEWS) throw new ApiError(503, 'not_set_up', 'Personal news isn’t set up here yet.');
  const session = await reader(request, env);
  if (!session) throw new ApiError(401, 'signed_out', 'Sign in to make News yours.');
  await limited(env, 'USER_RATE', `news:${session.account}`);
  return session;
}

async function body(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) throw new ApiError(413, 'too_big', 'That’s too much to send.');
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new ApiError(400, 'bad_request', 'Send a JSON object.');
  }
}

async function saveAnswers(request, env) {
  const session = await writer(request, env);
  const answers = await body(request);
  const previous = (await getProfile(env, session.account)) || emptyProfile();
  const profile = fromAnswers(answers, previous);
  await putProfile(env, session.account, profile);
  return { profile: publicProfile(profile) };
}

const ACTIONS = new Set(['open', 'less', 'more', 'hide']);

async function feedback(request, env, ctx) {
  const session = await writer(request, env);
  const { story, action } = await body(request);
  if (!ACTIONS.has(action)) throw new ApiError(400, 'bad_request', 'action is open, less, more or hide.');
  if (typeof story !== 'string' || !story || story.length > 200) throw new ApiError(400, 'bad_request', 'story is a story id.');
  const { stories } = await loadStories(env, ctx);
  const known = stories.find((s) => s.id === story);
  const profile = learn((await getProfile(env, session.account)) || emptyProfile(), { action, story, topics: known ? known.topics : [] });
  await putProfile(env, session.account, profile);
  return { profile: publicProfile(profile) };
}

async function reset(request, env) {
  const session = await writer(request, env);
  await eraseReader(env, session.account);
  return { ok: true };
}
