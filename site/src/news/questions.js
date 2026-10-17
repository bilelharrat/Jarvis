// Eden News: the topics Eden knows, and the questions a signed-in reader answers the first time they open News.
//
// Why these questions (cold start for a news recommender; each answer maps to one ranking signal in rank.js, and
// nothing is asked that the ranking doesn't use):
//   1. topics     — subtopics, not just broad sections: "AI" or "Football" predicts what someone opens far better
//                   than "Tech" or "Sports". At least 3, so the first edition isn't one note.  → topic weights
//   2. follows    — the highest-precision signal there is: named teams, companies, people, places, shows. A story
//                   that names one jumps the queue.                                           → follow matches
//   3. local      — a city or region the reader TYPES (Eden asks for no location permission). → local matches
//   4. less       — what to see less of, and how to treat distressing stories. News avoidance is common; letting
//                   people turn it down keeps them reading rather than leaving.                → penalties, filters
//   5. style      — how deep (headlines / short summary / background) and how much per edition. → presentation
// Five short steps, each skippable, about a minute. After that Eden learns from what the reader opens and from
// "Show less of this" (profile.js), so the questions only have to get the first editions right.

/** Sections and their subtopics. `words` classify a story (rank.js): lower-case, matched as whole words. */
export const TOPICS = [
  { id: 'world', name: 'World', words: ['world', 'international', 'foreign', 'diplomat', 'embassy', 'united nations', 'summit', 'ceasefire', 'treaty'], subtopics: [
    { id: 'world-conflict', name: 'Conflict and security', words: ['war', 'conflict', 'troops', 'military', 'ceasefire', 'missile', 'invasion', 'defense'] },
    { id: 'world-diplomacy', name: 'Diplomacy', words: ['diplomat', 'diplomacy', 'summit', 'treaty', 'sanctions', 'embassy', 'talks'] },
    { id: 'world-elections', name: 'Elections abroad', words: ['election', 'vote', 'ballot', 'polls', 'parliament', 'coalition'] },
  ] },
  { id: 'politics', name: 'Politics', words: ['politics', 'political', 'government', 'congress', 'senate', 'parliament', 'minister', 'president', 'policy', 'lawmakers'], subtopics: [
    { id: 'politics-elections', name: 'Elections', words: ['election', 'campaign', 'candidate', 'primary', 'ballot', 'polls', 'vote'] },
    { id: 'politics-policy', name: 'Policy and laws', words: ['bill', 'law', 'legislation', 'regulation', 'policy', 'supreme court', 'ruling'] },
  ] },
  { id: 'business', name: 'Business', words: ['business', 'company', 'companies', 'earnings', 'revenue', 'profit', 'shares', 'investors', 'merger', 'acquisition', 'ceo'], subtopics: [
    { id: 'business-markets', name: 'Markets', words: ['stocks', 'markets', 'shares', 'index', 'bonds', 'trading', 'wall street', 'nasdaq'] },
    { id: 'business-economy', name: 'Economy', words: ['economy', 'inflation', 'interest rates', 'central bank', 'jobs', 'unemployment', 'gdp', 'recession', 'rates'] },
    { id: 'business-startups', name: 'Startups and funding', words: ['startup', 'funding', 'venture', 'raised', 'valuation', 'founder', 'ipo'] },
    { id: 'business-personal', name: 'Your money', words: ['mortgage', 'savings', 'taxes', 'retirement', 'credit card', 'rent', 'prices'] },
  ] },
  { id: 'tech', name: 'Tech', words: ['tech', 'technology', 'software', 'app', 'apps', 'internet', 'computer', 'digital', 'chip', 'chips'], subtopics: [
    { id: 'tech-ai', name: 'AI', words: ['ai', 'artificial intelligence', 'model', 'models', 'chatbot', 'machine learning', 'llm', 'gemini', 'claude', 'gpt', 'openai', 'anthropic'] },
    { id: 'tech-gadgets', name: 'Phones and gadgets', words: ['iphone', 'android', 'phone', 'laptop', 'gadget', 'headphones', 'smartwatch', 'tablet'] },
    { id: 'tech-security', name: 'Cybersecurity', words: ['hack', 'hackers', 'breach', 'cyberattack', 'ransomware', 'vulnerability', 'malware', 'privacy'] },
    { id: 'tech-space', name: 'Space', words: ['space', 'rocket', 'nasa', 'satellite', 'orbit', 'launch', 'astronaut', 'moon', 'mars'] },
  ] },
  { id: 'science', name: 'Science', words: ['science', 'scientists', 'researchers', 'study', 'research', 'discovery'], subtopics: [
    { id: 'science-climate', name: 'Climate and energy', words: ['climate', 'emissions', 'renewable', 'solar', 'wind power', 'battery', 'batteries', 'energy', 'carbon'] },
    { id: 'science-health', name: 'Health and medicine', words: ['health', 'medicine', 'medical', 'disease', 'vaccine', 'drug', 'hospital', 'patients', 'cancer'] },
    { id: 'science-nature', name: 'Nature', words: ['wildlife', 'species', 'ocean', 'coral', 'forest', 'animals', 'biodiversity'] },
  ] },
  { id: 'sports', name: 'Sports', words: ['sports', 'match', 'game', 'season', 'league', 'championship', 'playoff', 'coach', 'player', 'tournament'], subtopics: [
    { id: 'sports-football', name: 'Football (soccer)', words: ['soccer', 'football', 'premier league', 'champions league', 'la liga', 'world cup', 'goal'] },
    { id: 'sports-us', name: 'NFL, NBA, MLB', words: ['nfl', 'nba', 'mlb', 'touchdown', 'quarterback', 'basketball', 'baseball'] },
    { id: 'sports-tennis', name: 'Tennis', words: ['tennis', 'wimbledon', 'grand slam', 'atp', 'wta'] },
    { id: 'sports-f1', name: 'Formula 1', words: ['formula 1', 'f1', 'grand prix', 'driver'] },
  ] },
  { id: 'culture', name: 'Culture', words: ['film', 'movie', 'music', 'album', 'book', 'art', 'museum', 'festival', 'series', 'show'], subtopics: [
    { id: 'culture-film', name: 'Film and TV', words: ['film', 'movie', 'box office', 'series', 'streaming', 'netflix', 'oscar'] },
    { id: 'culture-music', name: 'Music', words: ['music', 'album', 'tour', 'concert', 'singer', 'band'] },
    { id: 'culture-books', name: 'Books', words: ['book', 'novel', 'author', 'bestseller'] },
    { id: 'culture-gaming', name: 'Gaming', words: ['game', 'gaming', 'playstation', 'xbox', 'nintendo', 'esports'] },
  ] },
  { id: 'lifestyle', name: 'Life', words: ['food', 'travel', 'recipe', 'restaurant', 'fashion', 'wellness'], subtopics: [
    { id: 'life-food', name: 'Food', words: ['food', 'recipe', 'restaurant', 'chef', 'cooking'] },
    { id: 'life-travel', name: 'Travel', words: ['travel', 'airline', 'flights', 'airport', 'tourism', 'hotel'] },
  ] },
];

/** What a reader can ask to see less of (step 4). `topic` turns down a whole topic; the rest match by words. */
export const LESS = [
  { id: 'politics', name: 'Politics', topic: 'politics' },
  { id: 'celebrity', name: 'Celebrity news', words: ['celebrity', 'celebrities', 'red carpet', 'gossip', 'royal'] },
  { id: 'crime', name: 'Crime', words: ['crime', 'murder', 'shooting', 'police', 'arrested', 'trial'] },
  { id: 'sports', name: 'Sports', topic: 'sports' },
  { id: 'markets', name: 'Stock market moves', topic: 'business-markets' },
];

/** Words that mark a story as distressing, for the "distressing stories" choice. */
export const DISTRESSING = ['killed', 'dead', 'death', 'deaths', 'murder', 'shooting', 'massacre', 'attack', 'war', 'disaster', 'abuse', 'suicide'];

export const SENSITIVE = ['show', 'warn', 'hide']; // show normally / a heads-up before it / keep out of my feed
export const DEPTHS = ['headlines', 'summary', 'background'];
export const AMOUNTS = [5, 10, 20];

/** The first-open questions, as the page shows them (one per step). */
export const QUESTIONS = [
  { id: 'topics', kind: 'topics', title: 'What would you actually read?', help: 'Pick at least 3. Open a topic to be more specific: that helps the most.', min: 3 },
  { id: 'follows', kind: 'follows', title: 'Anything you never want to miss?', help: 'Teams, companies, people, places, shows. Stories that name one come first.', placeholder: 'e.g. Arsenal, Apple, SpaceX, Taylor Swift', max: 30 },
  { id: 'local', kind: 'local', title: 'Want local news?', help: 'Type a city or region. Eden never asks for your location.', placeholder: 'e.g. Austin, Texas' },
  { id: 'less', kind: 'less', title: 'Anything you’d rather see less of?', help: 'You can change this any time.' },
  { id: 'style', kind: 'style', title: 'How do you like your news?', help: 'Eden keeps every summary short and links to the full story.' },
];

const SUB = new Map(TOPICS.flatMap((t) => [[t.id, { ...t, parent: null }], ...t.subtopics.map((s) => [s.id, { ...s, parent: t.id }])]));

/** A topic or subtopic by id ({ id, name, words, parent }), or undefined. */
export const topicById = (id) => SUB.get(id);

/** Every topic and subtopic id. */
export const TOPIC_IDS = [...SUB.keys()];

/** The questions and the choices behind them, for the page (GET /api/news/questions). */
export function questionnaire() {
  return {
    questions: QUESTIONS,
    topics: TOPICS.map((t) => ({ id: t.id, name: t.name, subtopics: t.subtopics.map((s) => ({ id: s.id, name: s.name })) })),
    less: LESS.map(({ id, name }) => ({ id, name })),
    sensitive: SENSITIVE,
    depths: DEPTHS,
    amounts: AMOUNTS,
  };
}
