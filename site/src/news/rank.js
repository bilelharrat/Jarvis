// Eden News ranking: articles from the news source (sources.js) → stories (one event, several outlets) → each
// reader's edition. Pure and cheap: no model call here, so a feed costs nothing per reader.
//
// An article: { id, title, summary, url, source, publishedAt (ms), image?, imageRights?, region?, category? }
// A story:    { id, title, summary, url, source, publishedAt, updatedAt, sources: [{ name, url, title }], outlets,
//               topics: [topic id, most specific first], region, image, distressing }
//
// Score of a story for a reader (higher first):
//   interest   Σ over its topics of the reader's weight (a subtopic counts fully, its section half)
//   + follows  +2.5 if it names something the reader follows (whole words, any case)
//   + local    +1.5 if it mentions the reader's city or region
//   + weight   +0.35 × ln(outlets): more outlets reporting it, more likely it matters (and is right); × 1.15 with a picture
//   × fresh    half-life 8 hours
//   less       −1.5 for each "see less" it matches; distressing + 'hide' → left out
// Signed out (no profile): weight and freshness only, the same front page for everyone.
// Then variety: at most 2 stories in a row from one section, and at most a third of the edition from one topic.

import { DISTRESSING, LESS, TOPICS, topicById } from './questions.js';

export const HALF_LIFE_H = 8;
export const FOLLOW_BOOST = 2.5;
export const LOCAL_BOOST = 1.5;
export const LESS_PENALTY = 1.5;
export const OUTLET_WEIGHT = 0.35;
export const PHOTO_BOOST = 1.15; // a story with a picture ranks a little higher (Apple News leads with pictures)
const SAME_STORY = 0.5; // title-word overlap (Jaccard) from which two articles are the same story
const STOP = new Set('a an the of to in on for and or but with at by from as is are was were be been it its this that after over into new says say said will could would than more about up out amid against'.split(' '));

const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Whether `text` contains `phrase` as whole words, any case. */
export function mentions(text, phrase) {
  const p = words(phrase).join(' ');
  if (!p) return false;
  return new RegExp(`(^| )${escape(p)}( |$)`).test(words(text).join(' '));
}

/** The topics of an article or story, most specific first (subtopics, then their sections, then other sections). */
export function classify({ title = '', summary = '', category = '' }) {
  const t = `${title} ${title} ${summary}`; // the title counts twice
  const hits = [];
  for (const top of TOPICS) {
    for (const sub of top.subtopics) {
      const n = sub.words.filter((w) => mentions(t, w)).length;
      if (n) hits.push({ id: sub.id, n: n + 0.5 });
    }
    const n = top.words.filter((w) => mentions(t, w)).length + (category && words(category).includes(top.id) ? 2 : 0);
    if (n) hits.push({ id: top.id, n });
  }
  hits.sort((a, b) => b.n - a.n);
  const ids = [];
  for (const h of hits) {
    // a section that also has a subtopic hit: the subtopic goes first (the most specific is the main topic)
    const sub = topicById(h.id).parent ? null : hits.find((x) => topicById(x.id).parent === h.id);
    if (sub && !ids.includes(sub.id)) ids.push(sub.id);
    if (!ids.includes(h.id)) ids.push(h.id);
    const parent = topicById(h.id).parent;
    if (parent && !ids.includes(parent)) ids.push(parent);
  }
  return ids.slice(0, 4);
}

const keyWords = (title) => new Set(words(title).filter((w) => w.length > 2 && !STOP.has(w)));
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / (a.size + b.size - n);
}

/** Articles → stories: articles about the same event (similar titles, within 36 hours) become one story. */
export function cluster(articles) {
  const sorted = [...articles].filter((a) => a && a.title && a.url).sort((a, b) => b.publishedAt - a.publishedAt);
  const stories = [];
  for (const a of sorted) {
    const k = keyWords(a.title);
    const home = stories.find((s) => Math.abs(s.publishedAt - a.publishedAt) < 36 * 3600e3 && s._keys.some((sk) => overlap(sk, k) >= SAME_STORY));
    if (home) {
      home._keys.push(k);
      for (const src of [{ name: a.source, url: a.url, title: a.title }, ...(a.related || [])]) {
        if (src.name && !home.sources.some((x) => x.name === src.name)) home.sources.push(src);
      }
      home.updatedAt = Math.max(home.updatedAt, a.publishedAt);
      if (!home.image && a.image && a.imageRights) home.image = a.image;
      if (!home.region && a.region) home.region = a.region;
      home._text += ` ${a.title} ${a.summary || ''}`;
      continue;
    }
    stories.push({
      id: a.id, title: a.title, summary: a.summary || '', url: a.url, source: a.source, publishedAt: a.publishedAt, updatedAt: a.publishedAt,
      // the outlets reporting it: this article's, and the others Google News groups with it
      sources: [{ name: a.source, url: a.url, title: a.title }, ...(a.related || []).filter((r, i, all) => r.name && r.name !== a.source && all.findIndex((x) => x.name === r.name) === i)],
      region: a.region || null, image: a.image && a.imageRights ? a.image : null, category: a.category || '',
      _keys: [k, ...(a.related || []).map((r) => keyWords(r.title)).filter((x) => x.size)], _text: `${a.title} ${a.summary || ''}`,
    });
  }
  return stories.map(({ _keys, _text, category, ...s }) => ({
    ...s,
    outlets: s.sources.length,
    topics: classify({ title: s.title, summary: _text, category }),
    distressing: DISTRESSING.some((w) => mentions(`${s.title} ${s.summary}`, w)),
  }));
}

const fresh = (story, now) => Math.pow(0.5, Math.max(0, now - story.updatedAt) / (HALF_LIFE_H * 3600e3));

/** Which of the reader's follows a story names. */
export const followsIn = (story, profile) => (profile?.follows || []).filter((f) => mentions(`${story.title} ${story.summary}`, f));

/** A story's score for a reader (null profile: the shared front page), with the reasons, or null if left out. */
export function score(story, profile, now = Date.now()) {
  const base = (1 + OUTLET_WEIGHT * Math.log(story.outlets || 1)) * (story.image ? PHOTO_BOOST : 1);
  if (!profile) return { score: base * fresh(story, now), why: [] };
  if ((profile.hidden || []).includes(story.id)) return null;
  if (story.distressing && profile.sensitive === 'hide') return null;
  const why = [];
  let interest = 0;
  story.topics.forEach((id, i) => {
    const w = profile.topics?.[id] ?? 0;
    const isSection = !topicById(id).parent;
    interest += w * (isSection && i > 0 ? 0.5 : 1);
    if (w >= 1 && !why.length) why.push({ kind: 'topic', id, name: topicById(id).name });
  });
  const named = followsIn(story, profile);
  if (named.length) { interest += FOLLOW_BOOST; why.unshift({ kind: 'follow', name: named[0] }); }
  if (profile.local && (mentions(`${story.title} ${story.summary}`, profile.local) || (story.region && mentions(story.region, profile.local)))) {
    interest += LOCAL_BOOST;
    why.push({ kind: 'local', name: profile.local });
  }
  for (const id of profile.less || []) {
    const l = LESS.find((x) => x.id === id);
    if (!l) continue;
    if ((l.topic && story.topics.includes(l.topic)) || (l.words && l.words.some((w) => mentions(`${story.title} ${story.summary}`, w)))) interest -= LESS_PENALTY;
  }
  return { score: (base + interest) * fresh(story, now), why };
}

const sectionOf = (story) => {
  const first = story.topics[0];
  if (!first) return 'other';
  return topicById(first).parent || first;
};

/** Ranked stories → the same, re-ordered for variety (no runs of 3 from one section, ≤ ⅓ from one topic). */
export function diversify(ranked, limit) {
  const out = [];
  const perSection = new Map();
  const cap = Math.max(2, Math.ceil(limit / 3));
  const pool = [...ranked];
  while (out.length < limit && pool.length) {
    const lastTwo = out.slice(-2).map(sectionOf);
    let i = pool.findIndex((s) => (perSection.get(sectionOf(s)) || 0) < cap && !(lastTwo.length === 2 && lastTwo.every((x) => x === sectionOf(s))));
    if (i < 0) i = pool.findIndex((s) => (perSection.get(sectionOf(s)) || 0) < cap);
    if (i < 0) break;
    const [s] = pool.splice(i, 1);
    perSection.set(sectionOf(s), (perSection.get(sectionOf(s)) || 0) + 1);
    out.push(s);
  }
  return out;
}

/** What a story looks like on the page, cut to the reader's chosen depth. */
function present(story, depth, why) {
  const summary = depth === 'headlines' ? '' : story.summary;
  return {
    id: story.id, title: story.title, summary, url: story.url, source: story.source, publishedAt: story.publishedAt, updatedAt: story.updatedAt,
    sources: story.sources, outlets: story.outlets, topics: story.topics.map((id) => ({ id, name: topicById(id).name })),
    image: story.image, region: story.region || null, distressing: story.distressing, why,
  };
}

/**
 * A reader's edition. profile null = the signed-out front page.
 *   { personalized, featured: [2 stories under the lead], following: [{ kind: follow | topic, id, name, count, stories }], lead, top: [story],
 *     forYou: [story], sections: [{ id, name, stories }], local: [story] }
 */
export function edition(stories, profile, now = Date.now()) {
  const scored = stories.map((s) => ({ s, r: score(s, profile, now) })).filter((x) => x.r).sort((a, b) => b.r.score - a.r.score);
  const whyOf = new Map(scored.map((x) => [x.s.id, x.r.why]));
  const depth = profile?.depth || 'summary';
  const amount = profile?.amount || 10;
  const show = (s) => present(s, depth, whyOf.get(s.id) || []);
  const mixed = diversify(scored.map((x) => x.s), amount);
  // the lead carries a picture when one of the next few stories has one (Apple News leads with a photo)
  if (mixed[0] && !mixed[0].image) {
    const i = mixed.slice(1, 4).findIndex((s) => s.image);
    if (i >= 0) mixed.unshift(...mixed.splice(i + 1, 1));
  }
  const [lead, ...rest] = mixed;
  const used = new Set(mixed.map((s) => s.id));
  // the shared top stories (by weight and freshness alone), so a personal edition still shows what everyone's reading
  const general = stories.map((s) => ({ s, r: score(s, null, now) })).sort((a, b) => b.r.score - a.r.score).map((x) => x.s)
    .filter((s) => !used.has(s.id) && score(s, profile, now) !== null).slice(0, 5);
  const sectionIds = profile
    ? TOPICS.map((t) => t.id).filter((id) => (profile.topics[id] ?? 0) > 0 || TOPICS.find((t) => t.id === id).subtopics.some((x) => (profile.topics[x.id] ?? 0) >= 1))
    : TOPICS.map((t) => t.id);
  const sections = sectionIds.map((id) => ({
    id, name: topicById(id).name,
    stories: scored.map((x) => x.s).filter((s) => sectionOf(s) === id && s.id !== lead?.id).slice(0, 3).map(show),
  })).filter((sec) => sec.stories.length);
  const local = profile?.local ? scored.filter((x) => x.r.why.some((w) => w.kind === 'local')).map((x) => x.s).slice(0, 4).map(show) : [];
  // Following: each name they follow, then each topic they chose (strongest first), with the stories about it now
  const ranked = scored.map((x) => x.s);
  const following = profile ? [
    ...(profile.follows || []).map((name) => ({ kind: 'follow', id: `f:${name.toLowerCase()}`, name, list: ranked.filter((s) => mentions(`${s.title} ${s.summary}`, name)) })),
    ...Object.entries(profile.topics || {}).filter(([, w]) => w >= 1).sort((a, b) => b[1] - a[1])
      .map(([id]) => ({ kind: 'topic', id: `t:${id}`, name: topicById(id).name, list: ranked.filter((s) => s.topics.includes(id)) })),
  ].map(({ list, ...f }) => ({ ...f, count: list.length, stories: list.slice(0, 12).map(show) })) : [];
  // two picture stories under the lead (Apple News' lead block): next in rank, not shown above, with a photo if possible
  const shownAbove = new Set([lead?.id, ...(profile ? [...rest, ...general] : rest.slice(0, 5)).map((s) => s.id)]);
  const candidates = scored.map((x) => x.s).filter((s) => !shownAbove.has(s.id));
  const featured = [...candidates.filter((s) => s.image), ...candidates.filter((s) => !s.image)].slice(0, 2);
  return {
    personalized: Boolean(profile),
    featured: featured.map(show),
    following,
    lead: lead ? show(lead) : null,
    forYou: profile ? rest.map(show) : [],
    top: (profile ? general : rest.slice(0, 5)).map(show),
    sections,
    local,
  };
}
