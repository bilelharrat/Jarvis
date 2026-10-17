// Eden News (src/news/*): off unless EDEN_NEWS = "on"; the shared front page signed out; the first-open questions
// for a signed-in reader; the personal edition (topics, follows, local, see-less, distressing stories, depth and
// amount); learning from opens and "Show less of this"; and the write rules (own page, header, JSON, signed in).
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetSessions } from '../src/eden/session.js';
import { NEWS_CSP } from '../src/news/api.js';
import { CHOSEN_SUB, LESS_STEP, emptyProfile, fromAnswers, learn } from '../src/news/profile.js';
import { QUESTIONS, TOPIC_IDS, questionnaire } from '../src/news/questions.js';
import { classify, cluster, diversify, edition, mentions, score } from '../src/news/rank.js';
import { sampleArticles } from '../src/news/sources.js';
import { NewsDesk, STORIES_TTL_MS } from '../src/news/store.js';
import { Account, Link, appleJwk, identityToken, namespace, rateLimiter } from './fakes.js';

const ORIGIN = 'https://askeden.com';
const realFetch = globalThis.fetch;
const ctx = { waitUntil: () => {} };
let env;

function makeEnv(extra = {}) {
  const e = { EDEN_NEWS: 'on', EDEN_RATE: rateLimiter(), ...extra };
  e.ACCOUNTS = namespace(Account, e);
  e.LINKS = namespace(Link, e);
  e.NEWS = namespace(NewsDesk, e);
  e.ASSETS = { fetch: async (req) => new Response(`asset ${new URL(req.url).pathname}`, { headers: { 'content-type': 'text/html' } }) };
  return e;
}

beforeEach(() => {
  forgetSessions();
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    throw new Error(`unexpected fetch ${url}`); // News itself fetches nothing (sample source)
  };
  env = makeEnv();
});
after(() => { globalThis.fetch = realFetch; });

async function hit(p, { method = 'GET', body, headers = {}, session, origin = ORIGIN, e = env } = {}) {
  const h = { 'user-agent': 'Safari', ...headers };
  if (method !== 'GET' && origin) h.origin = origin;
  if (session) h.cookie = `__Host-eden=${session}`;
  const init = { method, headers: h };
  if (body !== undefined) { init.body = JSON.stringify(body); h['content-type'] ??= 'application/json'; }
  return worker.fetch(new Request(`${ORIGIN}${p}`, init), e, ctx);
}
const cookieValue = (r, name) => (r.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) || '').slice(name.length + 1).split(';')[0];
async function signedIn(sub = 'apple-user-1') {
  const app = await hit('/api/account/apple', { method: 'POST', origin: null, body: { identity_token: await identityToken({ sub }), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } } });
  const owner = await app.json();
  const started = await hit('/api/web/link', { method: 'POST', body: {} });
  const link = await started.json();
  const linkCookie = `__Host-eden-link=${cookieValue(started, '__Host-eden-link')}`;
  await hit(`/api/link/${link.code}/approve`, { method: 'POST', origin: null, headers: { authorization: `Bearer ${owner.token}` }, body: { sealed_key: null, sender_key: null } });
  const done = await hit('/api/web/link/poll', { method: 'POST', body: {}, headers: { cookie: linkCookie } });
  return cookieValue(done, '__Host-eden');
}
const write = (p, session, body, headers = { 'x-eden-news': '1' }) => hit(p, { method: 'POST', session, body, headers });
const answer = (session, body) => write('/api/news/profile', session, body);
const feed = async (session) => (await hit('/api/news/feed', { session })).json();
const allStories = (f) => [f.lead, ...f.forYou, ...f.top, ...f.sections.flatMap((s) => s.stories), ...f.local].filter(Boolean);

// ── switched off ──

test('off unless EDEN_NEWS is "on": /news goes home, /api/news is an unknown API path', async () => {
  const off = makeEnv({ EDEN_NEWS: undefined });
  const page = await hit('/news', { e: off });
  assert.equal(page.status, 302);
  assert.equal(new URL(page.headers.get('location')).pathname, '/');
  const r = await hit('/api/news/feed', { e: off });
  assert.notEqual(r.status, 200);
  const on = await hit('/news');
  assert.equal(on.status, 200);
  assert.equal(on.headers.get('content-security-policy'), NEWS_CSP);
  assert.equal((await hit('/news/news.js')).status, 200);
  assert.equal((await hit('/news/secret.txt')).status, 302); // only the page's own files
});

// ── signed out ──

test('signed out: the shared front page from the sample source, clustered, not personal, no questions', async () => {
  const f = await feed();
  assert.equal(f.signedIn, false);
  assert.equal(f.personalized, false);
  assert.equal(f.ask, false);
  assert.equal(f.sample, true);
  assert.ok(f.lead && f.top.length && f.sections.length);
  const transit = allStories(f).find((s) => /transit pilot/i.test(s.title));
  assert.equal(transit.outlets, 3, 'three outlets, one story');
  assert.deepEqual(transit.sources.map((s) => s.name).sort(), ['Example Times', 'Sample Daily', 'Sample Wire']);
  assert.equal(f.forYou.length, 0);
  const q = await (await hit('/api/news/questions')).json();
  assert.equal(q.questions.length, 5);
  assert.deepEqual(q.questions.map((x) => x.id), ['topics', 'follows', 'local', 'less', 'style']);
});

test('signed out: writes are refused', async () => {
  const r = await answer(undefined, { topics: ['tech'] });
  assert.equal(r.status, 401);
});

// ── first open ──

test('a signed-in reader opening News for the first time is asked; answering makes it theirs and stops the asking', async () => {
  const s = await signedIn();
  let me = await (await hit('/api/news/profile', { session: s })).json();
  assert.equal(me.signedIn, true);
  assert.equal(me.ask, true);
  assert.equal((await feed(s)).ask, true);

  const r = await answer(s, { topics: ['tech-ai', 'sports-football', 'business-economy'], follows: ['Riverside FC', '  riverside fc '], local: 'Austin', less: ['celebrity'], sensitive: 'hide', depth: 'headlines', amount: 5, done: true });
  assert.equal(r.status, 200, await r.clone().text());
  const { profile } = await r.json();
  assert.equal(profile.onboarded, true);
  assert.deepEqual(profile.follows, ['Riverside FC'], 'trimmed, one per name whatever the case');
  assert.equal(profile.topics['tech-ai'], CHOSEN_SUB);
  assert.equal(profile.topics.tech, 0.5, 'a subtopic implies some interest in its section');

  me = await (await hit('/api/news/profile', { session: s })).json();
  assert.equal(me.ask, false);
  const f = await feed(s);
  assert.equal(f.personalized, true);
  assert.equal(f.ask, false);
  assert.match(f.lead.title, /Riverside FC/, 'a story naming something they follow leads');
  assert.equal(f.lead.why[0].kind, 'follow');
  assert.ok(f.local.some((x) => /transit pilot/i.test(x.title)), 'Austin stories in Local');
  assert.ok(!allStories(f).some((x) => /ceasefire/i.test(x.title)), 'distressing stories kept out when asked');
  assert.equal(f.forYou.length + 1, 5, 'their amount');
  assert.ok(allStories(f).every((x) => x.summary === ''), 'headlines only');
});

test('skipping every question still ends the asking and gives the front page', async () => {
  const s = await signedIn();
  const r = await answer(s, { done: true });
  assert.equal(r.status, 200);
  const f = await feed(s);
  assert.equal(f.ask, false);
  assert.ok(f.lead);
});

test('bad answers are refused, not dropped', async () => {
  const s = await signedIn();
  for (const body of [{ topics: ['nonsense'] }, { topics: 'tech' }, { less: ['everything'] }, { sensitive: 'maybe' }, { depth: 'long' }, { amount: 7 }, []]) {
    const r = await answer(s, body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

// ── the write rules ──

test('writes: only this site’s page (origin, the X-Eden-News header, JSON), rate limited', async () => {
  const s = await signedIn();
  assert.equal((await write('/api/news/profile', s, { done: true }, {})).status, 403, 'no header');
  assert.equal((await hit('/api/news/profile', { method: 'POST', session: s, body: { done: true }, headers: { 'x-eden-news': '1' }, origin: 'https://evil.example' })).status, 403);
  assert.equal((await hit('/api/news/profile', { method: 'POST', session: s, body: { done: true }, headers: { 'x-eden-news': '1', 'sec-fetch-site': 'cross-site' } })).status, 403);
  const text = await hit('/api/news/profile', { method: 'POST', session: s, headers: { 'x-eden-news': '1', 'content-type': 'text/plain' }, body: {} });
  assert.equal(text.status, 415);
  const limitedEnv = makeEnv({ EDEN_RATE: rateLimiter(1) });
  env = limitedEnv;
  const s2 = await signedIn('apple-user-2');
  assert.equal((await answer(s2, { done: true })).status, 200);
  assert.equal((await answer(s2, { done: true })).status, 429);
});

// ── learning ──

test('feedback teaches: "Show less of this" turns a topic down, "Not interested" removes the story; topics come from the server', async () => {
  const s = await signedIn();
  await answer(s, { topics: ['tech-ai', 'science-climate', 'business-economy'], done: true });
  const before = await feed(s);
  const battery = allStories(before).find((x) => /sodium battery/i.test(x.title));
  const less = await (await write('/api/news/feedback', s, { story: battery.id, action: 'less', topics: ['politics'] })).json();
  assert.equal(less.profile.topics['science-climate'], CHOSEN_SUB - LESS_STEP, 'the story’s own main topic, not what the page claimed');
  assert.equal(less.profile.topics.politics, undefined);
  await write('/api/news/feedback', s, { story: battery.id, action: 'hide' });
  const afterHide = await feed(s);
  assert.ok(!allStories(afterHide).some((x) => x.id === battery.id));
  const opened = await (await write('/api/news/feedback', s, { story: before.lead.id, action: 'open' })).json();
  assert.equal(opened.profile.opened, 1);
  assert.equal((await write('/api/news/feedback', s, { story: battery.id, action: 'delete' })).status, 400);
});

test('reset forgets the reader: asked again', async () => {
  const s = await signedIn();
  await answer(s, { topics: ['tech', 'science', 'world'], done: true });
  assert.equal((await write('/api/news/reset', s, {})).status, 200);
  assert.equal((await (await hit('/api/news/profile', { session: s })).json()).ask, true);
});

test('the clustered stories are kept for everyone for a while, not rebuilt per reader', async () => {
  await feed();
  const cached = await env.NEWS.get('stories').fetch('https://news/stories-get', { method: 'POST', body: JSON.stringify({ now: Date.now() }) }).then((r) => r.json());
  assert.ok(Array.isArray(cached.stories) && cached.stories.length > 10);
  const stale = await env.NEWS.get('stories').fetch('https://news/stories-get', { method: 'POST', body: JSON.stringify({ now: Date.now() + STORIES_TTL_MS + 1 }) }).then((r) => r.json());
  assert.equal(stale.stale, true);
});

// ── the parts ──

test('mentions: whole words, any case and accents', () => {
  assert.ok(mentions('Arsenal win late', 'arsenal'));
  assert.ok(!mentions('Arsenals of the future', 'arsenal'));
  assert.ok(mentions('São Paulo floods', 'Sao Paulo'));
  assert.ok(mentions('New AI model', 'ai'));
  assert.ok(!mentions('A fair trial', 'ai'));
});

test('classify: the most specific topic first, its section after', () => {
  assert.deepEqual(classify({ title: 'Central bank holds interest rates', summary: 'inflation cooling' }).slice(0, 2), ['business-economy', 'business']);
  assert.equal(classify({ title: 'New AI model tops chatbot leaderboard' })[0], 'tech-ai');
  assert.ok(classify({ title: 'Something unrelated entirely' }).length === 0);
  for (const id of classify({ title: 'Rocket launch puts weather satellite into orbit' })) assert.ok(TOPIC_IDS.includes(id));
});

test('cluster: same event from different outlets within a day and a half; different events apart', () => {
  const now = Date.now();
  const stories = cluster(sampleArticles(now));
  const rates = stories.filter((s) => /interest rates/i.test(s.title));
  assert.equal(rates.length, 1);
  assert.equal(rates[0].outlets, 2);
  const far = cluster([
    { id: 'a', title: 'Council approves transit pilot', url: 'https://x/a', source: 'A', publishedAt: now },
    { id: 'b', title: 'Council approves transit pilot', url: 'https://x/b', source: 'B', publishedAt: now - 72 * 3600e3 },
  ]);
  assert.equal(far.length, 2, 'three days apart is another story');
  const noRights = cluster([{ id: 'c', title: 'A photo story', url: 'https://x/c', source: 'C', publishedAt: now, image: 'https://img/x.jpg', imageRights: false }]);
  assert.equal(noRights[0].image, null, 'no picture without the right to show it');
});

test('score: follows beat topics, see-less pushes down, hidden and distressing (hide) are left out, fresher wins', () => {
  const now = Date.now();
  const story = (over) => ({ id: 'x', title: 'Plain story', summary: '', outlets: 1, topics: [], updatedAt: now, distressing: false, ...over });
  const p = fromAnswers({ topics: ['tech-ai'], follows: ['Riverside FC'], less: ['politics'], sensitive: 'hide' }, emptyProfile(now), now);
  const ai = score(story({ topics: ['tech-ai', 'tech'] }), p, now).score;
  const follow = score(story({ title: 'Riverside FC win' }), p, now).score;
  const plain = score(story({}), p, now).score;
  const politics = score(story({ topics: ['politics'] }), p, now).score;
  assert.ok(follow > ai && ai > plain && plain > politics, JSON.stringify({ follow, ai, plain, politics }));
  assert.equal(score(story({ distressing: true }), p, now), null);
  assert.equal(score(story({ id: 'gone' }), { ...p, hidden: ['gone'] }, now), null);
  assert.ok(score(story({}), null, now).score > score(story({ updatedAt: now - 24 * 3600e3 }), null, now).score);
});

test('diversify: no run of three from one section, at most a third from one', () => {
  const s = (id, t) => ({ id, topics: [t] });
  const ranked = [s(1, 'tech-ai'), s(2, 'tech-ai'), s(3, 'tech'), s(4, 'tech-ai'), s(5, 'sports'), s(6, 'science'), s(7, 'tech'), s(8, 'world'), s(9, 'business')];
  const out = diversify(ranked, 6);
  const sections = out.map((x) => x.topics[0].split('-')[0]);
  for (let i = 2; i < sections.length; i++) assert.ok(!(sections[i] === sections[i - 1] && sections[i] === sections[i - 2]), sections.join(','));
  assert.ok(sections.filter((x) => x === 'tech').length <= 2);
});

test('learn: opens nudge up (less as history grows), less/more by a step, bounded', () => {
  let p = fromAnswers({ topics: ['tech'] }, null);
  const first = learn(p, { action: 'open', story: 'a', topics: ['tech'] }).topics.tech - p.topics.tech;
  p = { ...p, opened: 500 };
  const later = learn(p, { action: 'open', story: 'a', topics: ['tech'] }).topics.tech - p.topics.tech;
  assert.ok(first > later && later > 0);
  let q = fromAnswers({ topics: ['tech'] }, null);
  for (let i = 0; i < 20; i++) q = learn(q, { action: 'more', topics: ['tech'] });
  assert.equal(q.topics.tech, 2);
  for (let i = 0; i < 20; i++) q = learn(q, { action: 'less', topics: ['tech'] });
  assert.equal(q.topics.tech, -1);
  assert.throws(() => learn(q, { action: 'nope' }), /action/);
});

test('re-answering keeps what was learned about topics not re-chosen, drops chosen ones no longer picked', () => {
  let p = fromAnswers({ topics: ['tech', 'science'] }, null);
  p = learn(p, { action: 'less', topics: ['world'] });
  p = fromAnswers({ topics: ['tech'] }, p);
  assert.equal(p.topics.science, undefined);
  assert.equal(p.topics.world, -LESS_STEP);
});

test('the questionnaire matches what the server accepts', () => {
  const q = questionnaire();
  assert.equal(q.questions.length, QUESTIONS.length);
  const ids = q.topics.flatMap((t) => [t.id, ...t.subtopics.map((s) => s.id)]);
  assert.deepEqual([...ids].sort(), [...TOPIC_IDS].sort());
  assert.doesNotThrow(() => fromAnswers({ topics: ids.slice(0, 5), less: q.less.map((l) => l.id), sensitive: q.sensitive[0], depth: q.depths[0], amount: q.amounts[0] }));
});

test('edition: signed out has no For you; a personal one shows what everyone’s reading too', () => {
  const now = Date.now();
  const stories = cluster(sampleArticles(now));
  const shared = edition(stories, null, now);
  assert.equal(shared.personalized, false);
  assert.equal(shared.forYou.length, 0);
  const mine = edition(stories, fromAnswers({ topics: ['sports-tennis', 'culture-film', 'life-travel'], done: true }, null, now), now);
  assert.ok(mine.top.length > 0);
  const ids = new Set([mine.lead.id, ...mine.forYou.map((s) => s.id)]);
  assert.ok(mine.top.every((s) => !ids.has(s.id)), 'no story twice');
});

test('following: each followed name, then each chosen topic, with how many stories mention it now', async () => {
  const s = await signedIn();
  await answer(s, { topics: ['tech-ai', 'science-climate', 'sports-tennis'], follows: ['Riverside FC', 'Nobody Here'], done: true });
  const f = await feed(s);
  assert.deepEqual(f.following.map((x) => x.name), ['Riverside FC', 'Nobody Here', 'AI', 'Climate and energy', 'Tennis']);
  const club = f.following[0];
  assert.equal(club.kind, 'follow');
  assert.equal(club.count, 1, 'two outlets, one story');
  assert.match(club.stories[0].title, /Riverside FC/);
  assert.equal(f.following[1].count, 0);
  assert.ok(f.following.find((x) => x.name === 'AI').count >= 1);
  assert.deepEqual((await feed()).following, [], 'signed out: nothing followed');
});

// ── the live sources (the same way BSH Research Center's News Desk gets news) ──

const GOOGLE_RSS = `<rss><channel><item><title>Council approves late-night transit pilot - Example Times</title><link>https://news.google.com/rss/articles/abc?oc=5</link><pubDate>Wed, 14 Oct 2026 16:09:00 GMT</pubDate><description>&lt;ol&gt;&lt;li&gt;&lt;a href="https://news.google.com/rss/articles/abc?oc=5" target="_blank"&gt;Council approves late-night transit pilot&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;Example Times&lt;/font&gt;&lt;/li&gt;&lt;li&gt;&lt;a href="https://news.google.com/rss/articles/def?oc=5" target="_blank"&gt;Transit pilot passes&lt;/a&gt;&amp;nbsp;&amp;nbsp;&lt;font color="#6f6f6f"&gt;Sample Wire&lt;/font&gt;&lt;/li&gt;&lt;/ol&gt;</description><source url="https://example.com">Example Times</source></item></channel></rss>`;
const PUBLISHER_RSS = `<rss xmlns:media="http://search.yahoo.com/mrss/"><channel><item><title><![CDATA[Researchers report faster-charging sodium battery cell]]></title><description><![CDATA[<p>A lab cell reached 80% charge in under fifteen minutes &amp; kept its capacity.</p><p>Second paragraph that should not appear.</p> <a href="https://x">Continue reading...</a>]]></description><link>http://example.org/battery?at_medium=RSS&amp;x=1</link><pubDate>Wed, 14 Oct 2026 15:00:00 GMT</pubDate><media:content width="140" url="https://i.guim.co.uk/img/small.jpg"/><media:content width="460" url="https://i.guim.co.uk/img/big.jpg"/></item><item><title>No date</title><link>https://example.org/x</link></item></channel></rss>`;

test('parseRss: Google News (outlet from the title, related coverage) and a publisher feed (first paragraph, biggest picture, https)', async () => {
  const { parseRss } = await import('../src/news/sources.js');
  const [g] = parseRss(GOOGLE_RSS, { kind: 'google', category: 'politics' });
  assert.equal(g.title, 'Council approves late-night transit pilot');
  assert.equal(g.source, 'Example Times');
  assert.deepEqual(g.related.map((r) => r.name), ['Sample Wire']);
  assert.equal(g.category, 'politics');
  const items = parseRss(PUBLISHER_RSS, { kind: 'rss', source: 'The Guardian' });
  assert.equal(items.length, 1, 'an item without a date is skipped');
  assert.equal(items[0].summary, 'A lab cell reached 80% charge in under fifteen minutes & kept its capacity.');
  assert.equal(items[0].image, 'https://i.guim.co.uk/img/big.jpg');
  assert.equal(items[0].imageRights, true);
  assert.match(items[0].url, /^https:\/\/example\.org\/battery/);
  const stories = cluster([g]);
  assert.equal(stories[0].outlets, 2, 'Google’s related coverage counts as outlets');
});

test('live provider: every feed at once, one failing source doesn’t stop the edition; search for a follow', async () => {
  const { fetchArticles, searchArticles, FEEDS } = await import('../src/news/sources.js');
  const asked = [];
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    asked.push(url);
    if (url.includes('feeds.bbci.co.uk')) throw new Error('down');
    if (url.includes('query1.finance.yahoo.com')) return Response.json({ news: [{ title: 'Index funds rise', publisher: 'Example Markets', link: 'https://finance.example.com/a', providerPublishTime: Math.floor(Date.now() / 1000), thumbnail: { resolutions: [{ url: 'https://img.example.com/s.jpg', width: 140 }, { url: 'https://img.example.com/l.jpg', width: 1200 }] } }] });
    if (url.includes('news.google.com')) return new Response(GOOGLE_RSS);
    return new Response(PUBLISHER_RSS);
  };
  const live = await fetchArticles({ NEWS_PROVIDER: 'live' });
  assert.equal(live.sample, false);
  assert.equal(asked.length, FEEDS.length);
  const titles = live.articles.map((a) => a.title);
  assert.ok(titles.includes('Council approves late-night transit pilot') && titles.includes('Index funds rise') && titles.includes('Researchers report faster-charging sodium battery cell'));
  assert.equal(new Set(titles).size, titles.length, 'the same headline from several feeds once');
  assert.equal(live.articles.find((a) => a.title === 'Index funds rise').image, 'https://img.example.com/l.jpg');
  asked.length = 0;
  const found = await searchArticles({ NEWS_PROVIDER: 'live' }, 'Riverside FC');
  assert.ok(found.length >= 1);
  assert.ok(asked.some((u) => u.includes('/rss/search?q=') && u.includes(encodeURIComponent('"Riverside FC"'))));
  assert.deepEqual(await searchArticles({}, 'Riverside FC'), [], 'samples: no searching');
});

test('askedennews.com: News at the front with NEWS_HOST; www and askeden.com/news forward there; a doorway when unset', async () => {
  env = makeEnv({ NEWS_HOST: 'askedennews.com' });
  const front = await worker.fetch(new Request('https://askedennews.com/'), env, ctx);
  assert.equal(front.status, 200);
  assert.equal(front.headers.get('content-security-policy'), NEWS_CSP);
  const www = await worker.fetch(new Request('https://www.askedennews.com/?x=1'), env, ctx);
  assert.equal(www.headers.get('location'), 'https://askedennews.com/?x=1');
  const old = await worker.fetch(new Request('https://askeden.com/news'), env, ctx);
  assert.equal(old.headers.get('location'), 'https://askedennews.com/');
  const api = await worker.fetch(new Request('https://askedennews.com/api/news/questions'), env, ctx);
  assert.equal(api.status, 200);
  const unset = makeEnv({ NEWS_HOST: undefined });
  const door = await worker.fetch(new Request('https://askedennews.com/anything'), unset, ctx);
  assert.equal(door.headers.get('location'), 'https://askeden.com/news');
});

test('the Eden News logo: the page names its icons, and the icon files are served', async () => {
  const fs = await import('node:fs');
  const html = fs.readFileSync(new URL('../public/news/index.html', import.meta.url), 'utf8');
  for (const f of ['news-logo.svg', 'favicon-64.png', 'apple-touch-icon.png']) {
    assert.ok(html.includes(`/news/${f}`), f);
    assert.ok(fs.existsSync(new URL(`../public/news/${f}`, import.meta.url)), f);
    assert.equal((await hit(`/news/${f}`)).status, 200, f);
  }
});

test('story pictures through askeden.com (the chat app\'s News panel): only a picture of a story in today\'s edition', async () => {
  const PIC = 'https://images.publisher.example/story.jpg';
  const { putStories } = await import('../src/news/store.js');
  await putStories(env, { stories: [{ id: 'n1', title: 'A story', summary: 'S', url: 'https://publisher.example/a', source: 'Publisher', publishedAt: Date.now(), sources: [], outlets: 1, topics: [], image: PIC }], provider: 'test', sample: true, fetchedAt: Date.now() });
  const withPic = { image: PIC };
  const get = (u) => worker.fetch(new Request(`${ORIGIN}/api/news/image?u=${encodeURIComponent(u)}`), env, ctx);
  assert.equal((await get('https://evil.example/tracker.png')).status, 404, 'never an open proxy');
  assert.equal((await get('http://insecure.example/a.jpg')).status, 400);
  {
    const seen = [];
    globalThis.fetch = async (input) => { seen.push(typeof input === 'string' ? input : input.url); return new Response(new Uint8Array([255, 216, 255]), { headers: { 'content-type': 'image/jpeg' } }); };
    const r = await get(withPic.image);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(seen, [withPic.image]);
    globalThis.fetch = async () => new Response('<html>', { headers: { 'content-type': 'text/html' } });
    assert.equal((await get(withPic.image)).status, 502, 'only images');
  }
});

test('the app’s edition: a profile kept on the device ranks it (cleaned, nothing stored), with the page’s write rules', async () => {
  const app = (body, headers = { 'x-eden-news': '1' }) => hit('/api/news/edition', { method: 'POST', origin: null, body, headers });
  const r = await app({ profile: { topics: { 'tech-ai': 1.3, nonsense: 5 }, follows: ['Riverside FC', '  riverside fc '], depth: 'headlines', amount: 5, hidden: ['s-battery-1'] } });
  assert.equal(r.status, 200, await r.clone().text());
  const f = await r.json();
  assert.equal(f.personalized, true);
  const club = [f.lead, ...f.forYou].find((x) => /Riverside FC/.test(x.title));
  assert.ok(club && club.why[0].kind === 'follow', 'the followed club’s story is in the edition, marked as followed');
  assert.equal(f.forYou.length + 1, 5);
  assert.deepEqual(f.following.map((x) => x.name).slice(0, 2), ['Riverside FC', 'AI']);
  assert.ok(!allStories(f).some((x) => x.id === 's-battery-1'));
  assert.equal((await app({ profile: {} }, {})).status, 403);
  assert.equal((await hit('/api/news/edition', { method: 'POST', origin: 'https://evil.example', body: {}, headers: { 'x-eden-news': '1' } })).status, 403);
  env = makeEnv({ EDEN_RATE: rateLimiter(1) });
  assert.equal((await app({ profile: {} })).status, 200);
  assert.equal((await app({ profile: {} })).status, 429);
});
