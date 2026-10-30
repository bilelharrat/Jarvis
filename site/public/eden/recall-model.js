// Recall across chats with no browser in it: what the user said in their other chats, and what Eden
// answered, that bears on this message. Hybrid lexical (BM25F + morphological stemming + phrase/proximity
// + temporal intent + concept expansion) and dense vector retrieval (when embeddings are present), with
// turn-pair passage extraction so a matched question always brings its answer along.
// Chat.js asks `recallBlock`; tools-ui.js asks `searchChats`; the tests load this file alone.

const STOP = new Set(
  'a an the and or but of to in on at for with from by about as is are was were be been being am i me my mine myself you your yours yourself we our ours ourselves it its itself this that these those he him his himself she her hers herself they them their theirs themselves do does did doing have has had having not no nor so if then than too very just also can could would should will shall may might must what when where who whom whose which how why please tell give make get got want need like know think thought say said ask asked asking chat chats conversation conversations earlier before previous previously last other another old past remember recall talked discussed spoke mentioned told wrote gave show find look'.split(' '),
);

/** 2-character tokens that carry high domain or entity signal and must not be dropped by length filtering. */
const KEEP_SHORT = new Set([
  'ai', 'ui', 'ux', 'ml', 'dl', 'db', 'os', 'io', 'js', 'ts', 'go', 'py', 'rs', 'rb', 'sh',
  'uk', 'us', 'eu', 'un', 'ny', 'la', 'sf', 'dc', 'uk', 'ca', 'au', 'nz', 'jp', 'kr', 'cn', 'de', 'fr',
  'vp', 'pm', 'em', 'gm', 'hr', 'pr', 'qa', 'ci', 'cd', 'ip', 'id', 'tv', 'vr', 'ar', 'pc', 'vm',
  '3d', '4k', '8k', '5g', '2g', '4g', 'm1', 'm2', 'm3', 'm4', 's3', 'r2', 'd1', 'kv', 'ec', 'v1', 'v2', 'v3', 'v4',
  'dr', 'mr', 'ms', 'st', 'rd', 'jr', 'sr', 'ph', 'cv', 'gp', 'er', 'iv', 'bp', 'hr', 'rx',
]);

/** Words ending in 's' whose 's' is part of the root, not a plural inflection. */
const INVARIANT_S = new Set([
  'paris', 'focus', 'status', 'analysis', 'basis', 'crisis', 'thesis', 'hypothesis', 'synthesis', 'diagnosis', 'prognosis',
  'series', 'species', 'news', 'physics', 'mathematics', 'economics', 'athletics', 'politics', 'ethics', 'statistics',
  'linguistics', 'genetics', 'dynamics', 'mechanics', 'optics', 'acoustics', 'electronics', 'robotics', 'logistics',
  'canvas', 'alias', 'atlas', 'texas', 'kansas', 'arkansas', 'vegas', 'dallas', 'honduras', 'bahamas', 'barack',
  'gas', 'bus', 'plus', 'minus', 'virus', 'bonus', 'campus', 'census', 'chorus', 'circus', 'citrus', 'consensus',
  'corpus', 'genius', 'radius', 'stimulus', 'surplus', 'syllabus', 'terminus', 'apparatus', 'prospectus', 'nexus',
  'lens', 'chaos', 'cosmos', 'ethos', 'pathos', 'logos', 'bios', 'ios', 'macos', 'watchos', 'tvos', 'visionos',
  'pass', 'class', 'glass', 'grass', 'mass', 'brass', 'chess', 'dress', 'press', 'stress', 'success', 'access',
  'process', 'address', 'express', 'progress', 'congress', 'actress', 'waitress', 'mattress', 'fortress', 'distress',
  'witness', 'business', 'fitness', 'illness', 'wellness', 'darkness', 'weakness', 'kindness', 'happiness', 'awareness',
  'loss', 'boss', 'cross', 'gross', 'moss', 'toss', 'floss', 'gloss', 'fuss', 'discuss', 'truss', 'abyss', 'bliss', 'swiss',
  'mars', 'venus', 'uranus', 'ceres', 'ares', 'hermes', 'zeus', 'chronos', 'helios', 'eros', 'pancreas', 'pelvis',
  'iris', 'epidermis', 'bronchitis', 'arthritis', 'hepatitis', 'meningitis', 'appendicitis', 'tonsillitis', 'diabetes',
  'rabies', 'measles', 'mumps', 'herpes', 'shingles', 'scabies', 'rickets', 'hiccups', 'forceps', 'biceps', 'triceps',
  'scissors', 'glasses', 'sunglasses', 'trousers', 'jeans', 'pants', 'shorts', 'pliers', 'tweezers', 'binoculars',
  'headquarters', 'barracks', 'crossroads', 'gallows', 'means', 'alumnus', 'calculus', 'abacus', 'hibiscus', 'cactus',
  'octopus', 'platypus', 'hippopotamus', 'rhinoceros', 'albatross', 'walrus', 'asparagus', 'couscous', 'hummus', 'molasses',
  'oats', 'grits', 'lentils', 'tapas', 'nachos', 'churros', 'tacos', 'fajitas', 'enchiladas', 'quesadillas', 'gyros',
]);

/** Irregular verb/noun forms normalized before suffix stemming. */
const IRREGULAR = new Map([
  ['ran', 'run'], ['running', 'run'], ['ate', 'eat'], ['eaten', 'eat'], ['eating', 'eat'],
  ['wrote', 'write'], ['written', 'write'], ['writing', 'write'], ['spoke', 'speak'], ['spoken', 'speak'],
  ['speaking', 'speak'], ['took', 'take'], ['taken', 'take'], ['taking', 'take'], ['gave', 'give'],
  ['given', 'give'], ['giving', 'give'], ['bought', 'buy'], ['buying', 'buy'], ['brought', 'bring'],
  ['bringing', 'bring'], ['taught', 'teach'], ['teaching', 'teach'], ['caught', 'catch'], ['catching', 'catch'],
  ['fought', 'fight'], ['fighting', 'fight'], ['sought', 'seek'], ['seeking', 'seek'], ['paid', 'pay'],
  ['paying', 'pay'], ['laid', 'lay'], ['laying', 'lay'], ['sent', 'send'], ['sending', 'send'],
  ['spent', 'spend'], ['spending', 'spend'], ['built', 'build'], ['building', 'build'], ['lent', 'lend'],
  ['lending', 'lend'], ['meant', 'mean'], ['meaning', 'mean'], ['kept', 'keep'], ['keeping', 'keep'],
  ['slept', 'sleep'], ['sleeping', 'sleep'], ['felt', 'feel'], ['feeling', 'feel'], ['left', 'leave'],
  ['leaving', 'leave'], ['lost', 'lose'], ['losing', 'lose'], ['won', 'win'], ['winning', 'win'],
  ['begun', 'begin'], ['began', 'begin'], ['beginning', 'begin'], ['swam', 'swim'], ['swum', 'swim'],
  ['swimming', 'swim'], ['drank', 'drink'], ['drunk', 'drink'], ['drinking', 'drink'], ['sang', 'sing'],
  ['sung', 'sing'], ['singing', 'sing'], ['rang', 'ring'], ['rung', 'ring'], ['ringing', 'ring'],
  ['sank', 'sink'], ['sunk', 'sink'], ['sinking', 'sink'], ['flew', 'fly'], ['flown', 'fly'],
  ['flying', 'fly'], ['grew', 'grow'], ['grown', 'grow'], ['growing', 'grow'], ['knew', 'know'],
  ['known', 'know'], ['threw', 'throw'], ['thrown', 'throw'], ['throwing', 'throw'], ['drew', 'draw'],
  ['drawn', 'draw'], ['drawing', 'draw'], ['chose', 'choose'], ['chosen', 'choose'], ['choosing', 'choose'],
  ['froze', 'freeze'], ['frozen', 'freeze'], ['freezing', 'freeze'], ['stole', 'steal'], ['stolen', 'steal'],
  ['stealing', 'steal'], ['broke', 'break'], ['broken', 'break'], ['breaking', 'break'], ['woke', 'wake'],
  ['woken', 'wake'], ['waking', 'wake'], ['wore', 'wear'], ['worn', 'wear'], ['wearing', 'wear'],
  ['tore', 'tear'], ['torn', 'tear'], ['tearing', 'tear'], ['swore', 'swear'], ['sworn', 'swear'],
  ['rode', 'ride'], ['ridden', 'ride'], ['riding', 'ride'], ['drove', 'drive'], ['driven', 'drive'],
  ['driving', 'drive'], ['rose', 'rise'], ['risen', 'rise'], ['rising', 'rise'], ['fell', 'fall'],
  ['fallen', 'fall'], ['falling', 'fall'], ['held', 'hold'], ['holding', 'hold'], ['sold', 'sell'],
  ['selling', 'sell'], ['told', 'tell'], ['telling', 'tell'], ['found', 'find'], ['finding', 'find'],
  ['heard', 'hear'], ['hearing', 'hear'], ['read', 'read'], ['reading', 'read'], ['led', 'lead'],
  ['leading', 'lead'], ['fed', 'feed'], ['feeding', 'feed'], ['met', 'meet'], ['meeting', 'meet'],
  ['sat', 'sit'], ['sitting', 'sit'], ['stood', 'stand'], ['standing', 'stand'], ['understood', 'understand'],
  ['children', 'child'], ['men', 'man'], ['women', 'woman'], ['teeth', 'tooth'], ['feet', 'foot'],
  ['mice', 'mouse'], ['geese', 'goose'], ['people', 'person'], ['indices', 'index'], ['matrices', 'matrix'],
  ['vertices', 'vertex'], ['appendices', 'appendix'], ['criteria', 'criterion'], ['phenomena', 'phenomenon'],
]);

/** High-precision semantic equivalence clusters for lexical recall when dense vectors are absent. */
const CONCEPT_GROUPS = [
  ['dentist', 'dental', 'tooth', 'toothache', 'crown', 'molar', 'cavity', 'filling', 'orthodontist', 'rootcanal', 'gingivitis'],
  ['doctor', 'physician', 'clinic', 'hospital', 'checkup', 'medical', 'surgeon', 'pediatrician', 'dermatologist', 'cardiologist'],
  ['prescription', 'medication', 'medicine', 'pill', 'tablet', 'dosage', 'pharmacy', 'antibiotic', 'penicillin', 'allergy', 'allergic'],
  ['flight', 'airline', 'airport', 'plane', 'boarding', 'layover', 'itinerary', 'terminal', 'luggage', 'baggage'],
  ['hotel', 'airbnb', 'lodging', 'hostel', 'resort', 'checkin', 'checkout', 'booking', 'reservation'],
  ['pasta', 'spaghetti', 'noodle', 'penne', 'fetuccine', 'fettuccine', 'macaroni', 'lasagna', 'ravioli', 'linguine', 'rigatoni'],
  ['boil', 'simmer', 'cook', 'recipe', 'bake', 'roast', 'fry', 'saute', 'ingredient', 'kitchen'],
  ['salary', 'compensation', 'paycheck', 'wage', 'stipend', 'remuneration', 'equity', 'stock', 'vesting'],
  ['rent', 'lease', 'landlord', 'tenant', 'apartment', 'condo', 'mortgage', 'realty', 'housing'],
  ['tax', 'irs', 'hmrc', 'deduction', 'withholding', 'accountant', 'cpa', 'filing', '1099', 'w2'],
  ['dog', 'puppy', 'canine', 'hound', 'retriever', 'terrier', 'poodle', 'shepherd'],
  ['cat', 'kitten', 'feline', 'tabby', 'siamese'],
  ['car', 'vehicle', 'automobile', 'sedan', 'suv', 'truck', 'garage', 'mechanic'],
  ['bug', 'error', 'exception', 'crash', 'stacktrace', 'segfault', 'defect', 'regression', 'glitch'],
];

const STEM_TO_CONCEPT = new Map();
const ASKS_BACK = /\b(?:earlier|before|previous(?:ly)?|last (?:time|week|month|year|night|chat|session)|other chats?|another chat|old chats?|past chats?|prior chats?|we (?:talked|discussed|spoke|covered|worked|decided|agreed)|i (?:asked|told|said|mentioned|shared|sent|wrote|gave)|you (?:said|told|gave|wrote|suggested|recommended|explained|helped|found)|remember when|what did (?:i|we|you)|in (?:a |an |my )?(?:previous|earlier|other|past|last) (?:chat|conversation|thread|message)|back when (?:i|we))\b/i;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const KEEP_DOUBLE_3 = new Set(['add', 'err', 'odd', 'egg', 'ill', 'inn', 'off', 'ebb']);
const hasVowel = (s) => /[aeiouy]/.test(s);
const undouble = (s) => {
  if (s.length >= 3 && !KEEP_DOUBLE_3.has(s) && s[s.length - 1] === s[s.length - 2] && /[bdfgmnprt]$/.test(s)) {
    return s.slice(0, -1);
  }
  if (/(?:at|bl|iz)$/.test(s)) return `${s}e`;
  return s;
};
const needsSilentE = (base) => {
  if (base === 'us') return true;
  if (base.length < 3 || /[aeiouy]{2}/.test(base) || base[base.length - 1] === base[base.length - 2]) return false;
  if (/^[bcdfghjklmnpqrstvwxz]*[aeiouy][bcdfghjklmnpqrstvz]$/.test(base)) return true;
  if (/(?:[cgvz]|at|bl|iz|id|ud|ul|ur|ir)$/.test(base) && !/(?:ng|vis|lim|ed)$/.test(base)) return true;
  return false;
};

/**
 * Morphological stemmer (Porter2/Snowball-inspired): maps inflected English words to their canonical stem
 * while protecting proper nouns, invariant '-s' words, and short technical identifiers.
 */
export function stemWord(raw) {
  let w = String(raw || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/^['’._+-]+|['’._+-]+$/g, '')
    .replace(/(?:'s|’s)$/, '');
  if (!w) return '';
  if (IRREGULAR.has(w)) return IRREGULAR.get(w);
  if (w.length <= 3 || INVARIANT_S.has(w)) return w;

  // Step 1a: plural & -es / -ies / -ves normalization
  if (w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.endsWith('ies') && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith('ves') && w.length > 4 && !w.endsWith('oves') && !w.endsWith('ives')) w = `${w.slice(0, -3)}f`;
  else if (/(?:ches|shes|xes|zes|oes)$/.test(w) && w.length > 4) w = w.slice(0, -2);
  else if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is') && !INVARIANT_S.has(w)) {
    w = w.slice(0, -1);
  }
  if (IRREGULAR.has(w)) return IRREGULAR.get(w);
  if (w.length <= 3 || INVARIANT_S.has(w)) return w;

  // Step 1b: adverbial / verbal / nominal suffixes (-ingly, -edly, -ing, -ed, -ment, -ness, -ation)
  if (w.endsWith('ingly') && w.length > 7 && hasVowel(w.slice(0, -5))) w = undouble(w.slice(0, -5));
  else if (w.endsWith('edly') && w.length > 6 && hasVowel(w.slice(0, -4))) w = undouble(w.slice(0, -4));
  else if (w.endsWith('ing') && w.length > 4 && hasVowel(w.slice(0, -3))) {
    const base = w.slice(0, -3);
    w = needsSilentE(base) ? `${base}e` : undouble(base);
  } else if (w.endsWith('ed') && !w.endsWith('eed') && w.length > 4 && hasVowel(w.slice(0, -2))) {
    const base = w.slice(0, -2);
    if (base.endsWith('i')) w = `${base.slice(0, -1)}y`;
    else w = needsSilentE(base) ? `${base}e` : undouble(base);
  }

  // Step 2: derivational suffixes on longer stems
  if (w.length > 6) {
    if (w.endsWith('ational')) w = `${w.slice(0, -7)}ate`;
    else if (w.endsWith('tional')) w = `${w.slice(0, -6)}tion`;
    else if (w.endsWith('ization') || w.endsWith('isation')) w = `${w.slice(0, -7)}ize`;
    else if (w.endsWith('fulness')) w = w.slice(0, -4);
    else if (w.endsWith('ousness')) w = w.slice(0, -4);
    else if (w.endsWith('iveness')) w = w.slice(0, -4);
    else if (w.endsWith('appointment')) w = 'appoint';
    else if (w.endsWith('ment') && w.length > 7) w = w.slice(0, -4);
    else if (w.endsWith('ness') && w.length > 6) w = w.slice(0, -4);
  }
  return w;
}

for (let i = 0; i < CONCEPT_GROUPS.length; i++) {
  const cid = `c$${i}`;
  for (const w of CONCEPT_GROUPS[i]) STEM_TO_CONCEPT.set(stemWord(w), cid);
}

/**
 * Extracts ordered normalized tokens from `text`:
 * - `tokens`: ordered array of canonical stems (for phrase/bigram & TF computation)
 * - `tf`: Map<stem, count>
 * - `bigrams`: Set<"stem1 stem2"> for adjacent meaningful tokens
 * - `concepts`: Set<conceptId> for semantic cluster matching
 * - `entities`: Set<stem> for capitalized proper nouns, numbers, or quoted terms
 */
export function analyzeText(raw) {
  const str = String(raw || '').normalize('NFC');
  const tokens = [];
  const tf = new Map();
  const bigrams = new Set();
  const concepts = new Set();
  const entities = new Set();

  // Detect capitalized proper nouns (not at the very start of a sentence) and numbers
  const rawMatches = str.match(/[\p{L}\p{N}][\p{L}\p{N}'’._+-]*/gu) || [];
  for (let i = 0; i < rawMatches.length; i++) {
    const orig = rawMatches[i];
    const cleanOrig = orig.replace(/^[._+-]+|[._+-]+$/g, '');
    if (!cleanOrig) continue;
    const lower = cleanOrig.toLowerCase();
    const stem = stemWord(lower);
    if (!stem) continue;
    const isNum = /^\d+$/.test(stem);
    const isCjk = CJK_RE.test(stem);
    const keep = (stem.length > 2 || KEEP_SHORT.has(stem) || isNum || isCjk) && !STOP.has(stem) && !STOP.has(lower);
    if (!keep) continue;

    tokens.push(stem);
    tf.set(stem, (tf.get(stem) || 0) + 1);
    const concept = STEM_TO_CONCEPT.get(stem);
    if (concept) concepts.add(concept);

    if (isNum || (i > 0 && /^\p{Lu}/u.test(cleanOrig)) || /\d/.test(cleanOrig)) {
      entities.add(stem);
    }
  }
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] !== tokens[i + 1]) bigrams.add(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return { tokens, set: new Set(tokens), tf, bigrams, concepts, entities };
}

/** Set of canonical stems in `t` (backward-compatible helper). */
export const wordsOf = (t) => analyzeText(t).set;

const text = (n) =>
  n && n.role === 'user'
    ? (typeof n.content === 'string' ? n.content : '')
    : (Array.isArray(n && n.parts) ? n.parts : [])
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('');

const cleanTitle = (t) =>
  String(t || 'Untitled chat')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/<{3,}/g, '‹‹‹')
    .replace(/>{3,}/g, '›››')
    .replace(/\s+/g, ' ')
    .trim() || 'Untitled chat';

const getVec = (vecs, id) =>
  vecs && id && Object.prototype.hasOwnProperty.call(vecs, id) && Array.isArray(vecs[id]) ? vecs[id] : null;

/** True when the message points back at earlier conversations ("in the other chats", "what did I ask"). */
export const asksBack = (prompt) => ASKS_BACK.test(String(prompt || ''));

const DAY_MS = 86_400_000;
const MONTHS = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3, may: 4, june: 5, jun: 5,
  july: 6, jul: 6, august: 7, aug: 7, september: 8, sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10, december: 11, dec: 11,
};
const NUM_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  couple: 2, 'couple of': 2, few: 3,
};

/**
 * Parses natural-language temporal references from `prompt` relative to `now` (ms):
 * returns `{ from, to }` in ms when the user names a time window ("yesterday", "last week", "3 days ago", "in March"), else null.
 */
export function parseTemporalWindow(prompt, now = Date.now()) {
  const s = String(prompt || '').toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;
  const ref = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  const todayStart = new Date(ref);
  todayStart.setHours(0, 0, 0, 0);
  const t0 = todayStart.getTime();

  if (/\b(?:today|this morning|this afternoon|this evening|earlier today|tonight)\b/.test(s)) {
    return { from: t0 - 6 * 3600_000, to: ref + DAY_MS };
  }
  if (/\byesterday\b/.test(s)) {
    return { from: t0 - DAY_MS - 6 * 3600_000, to: t0 + 6 * 3600_000 };
  }
  const relAgo = /\b(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|a|an|couple(?:\s+of)?|few)\s+(day|week|month)s?\s+ago\b/.exec(s);
  if (relAgo) {
    const rawN = relAgo[1];
    const n = NUM_WORDS[rawN] || Math.max(1, Number(rawN) || 1);
    const unit = relAgo[2];
    if (unit === 'day') {
      const center = ref - n * DAY_MS;
      return { from: center - 1.25 * DAY_MS, to: Math.min(ref, center + 1.25 * DAY_MS) };
    }
    if (unit === 'week') {
      const center = ref - n * 7 * DAY_MS;
      return { from: center - 4.5 * DAY_MS, to: Math.min(ref, center + 4.5 * DAY_MS) };
    }
    if (unit === 'month') {
      const center = ref - n * 30.5 * DAY_MS;
      return { from: center - 16 * DAY_MS, to: Math.min(ref, center + 16 * DAY_MS) };
    }
  }
  const relPast = /\b(?:in|over|from|during)\s+the\s+(?:past|last)\s+(?:(\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|a|an|couple(?:\s+of)?|few)\s+)?(day|week|month)s?\b/.exec(s);
  if (relPast) {
    const rawN = relPast[1] || '1';
    const n = NUM_WORDS[rawN] || Math.max(1, Number(rawN) || 1);
    const unit = relPast[2];
    const mult = unit === 'week' ? 7 * DAY_MS : unit === 'month' ? 31 * DAY_MS : DAY_MS;
    return { from: ref - n * mult - 6 * 3600_000, to: ref + DAY_MS };
  }
  if (/\b(?:this week|past few days|last few days)\b/.test(s)) {
    return { from: ref - 7 * DAY_MS, to: ref + DAY_MS };
  }
  if (/\blast week\b/.test(s)) {
    return { from: ref - 15 * DAY_MS, to: ref - 5 * DAY_MS };
  }
  if (/\b(?:this month|past few weeks)\b/.test(s)) {
    return { from: ref - 31 * DAY_MS, to: ref + DAY_MS };
  }
  if (/\blast month\b/.test(s)) {
    return { from: ref - 65 * DAY_MS, to: ref - 20 * DAY_MS };
  }
  const mMatch = /\b(in|from|around|back in|last)\s+(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)(?:\s+(\d{4}))?\b/.exec(s);
  if (mMatch) {
    const prefix = mMatch[1];
    const mo = MONTHS[mMatch[2]];
    const dRef = new Date(ref);
    const curYear = dRef.getUTCFullYear();
    const curMonth = dRef.getUTCMonth();
    const yr = mMatch[3]
      ? Number(mMatch[3])
      : ((prefix === 'last' ? mo >= curMonth : mo > curMonth) ? curYear - 1 : curYear);
    const start = Date.UTC(yr, mo, 1);
    const end = Date.UTC(yr, mo + 1, 1) - 1;
    return { from: start, to: end };
  }
  return null;
}

/** Per-conversation turn & lexical cache keyed on conversation object reference, invalidated when `updated`, `title`, or node text changes. */
const CONV_CACHE = new WeakMap();

function fnv1a(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function nodeTextSig(n) {
  if (!n || typeof n !== 'object') return '0';
  if (typeof n.content === 'string') return `${n.content.length}:${fnv1a(n.content).toString(36)}`;
  if (Array.isArray(n.parts)) {
    let total = 0;
    let h = 2166136261;
    for (let i = 0; i < n.parts.length; i++) {
      const p = n.parts[i];
      const t = p && typeof p.text === 'string' ? p.text : '';
      total += t.length;
      for (let j = 0; j < t.length; j++) {
        h ^= t.charCodeAt(j);
        h = Math.imul(h, 16777619);
      }
    }
    return `${total}:${(h >>> 0).toString(36)}`;
  }
  return '0';
}

function convCacheSig(c) {
  const nodes = c && c.nodes && typeof c.nodes === 'object' ? c.nodes : {};
  const keys = Object.keys(nodes);
  let branchSig = '';
  if (c && c.root && Array.isArray(c.root.children) && c.root.children.length) {
    const seen = new Set();
    let cur = c.root;
    while (cur && Array.isArray(cur.children) && cur.children.length) {
      const idx = typeof cur.sel === 'number' ? Math.min(Math.max(0, cur.sel), cur.children.length - 1) : cur.children.length - 1;
      const cid = cur.children[idx];
      if (!cid || seen.has(cid)) break;
      seen.add(cid);
      const nextNode = nodes[cid];
      if (!nextNode || typeof nextNode !== 'object') break;
      branchSig += `${cid}:${nextNode.sel ?? ''}:${nodeTextSig(nextNode)}|`;
      cur = nextNode;
    }
  } else {
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const n = nodes[k];
      branchSig += `${k}:${n && n.sel !== undefined ? n.sel : ''}:${nodeTextSig(n)}|`;
    }
  }
  return `${c.updated || 0}::${c.title || ''}::${keys.length}::${branchSig}`;
}

function getConvDoc(c) {
  if (!c || typeof c !== 'object') return { titleLex: analyzeText(''), turns: [] };
  const sig = convCacheSig(c);
  const hit = CONV_CACHE.get(c);
  if (hit && hit.sig === sig) return hit;
  const entry = {
    sig,
    titleLex: analyzeText(c.title || ''),
    turns: extractTurnsUncached(c),
  };
  CONV_CACHE.set(c, entry);
  return entry;
}

/**
 * Extracts ordered conversational turns from `c`:
 * Pairs each user message with its immediate assistant reply (by parent/children links when present,
 * or sequential order in `c.nodes`), so matching a question always carries its answer and vice versa.
 */
function extractTurns(c) {
  return getConvDoc(c).turns;
}

function extractTurnsUncached(c) {
  const nodes = c && c.nodes && typeof c.nodes === 'object' ? c.nodes : {};
  let rawEntries;

  // When a conversation tree root (`c.root`) is present, walk the active selected branch (`sel`)
  // so abandoned user edits and rejected regeneration drafts are never indexed.
  if (c && c.root && Array.isArray(c.root.children) && c.root.children.length) {
    rawEntries = [];
    const seen = new Set();
    let cur = c.root;
    while (cur && Array.isArray(cur.children) && cur.children.length) {
      const idx = typeof cur.sel === 'number' ? Math.min(Math.max(0, cur.sel), cur.children.length - 1) : cur.children.length - 1;
      const cid = cur.children[idx];
      if (!cid || seen.has(cid)) break;
      seen.add(cid);
      const nextNode = nodes[cid];
      if (!nextNode || typeof nextNode !== 'object') break;
      rawEntries.push([cid, nextNode]);
      cur = nextNode;
    }
  } else {
    rawEntries = Object.entries(nodes);
  }

  const list = rawEntries
    .map(([id, n], idx) => (n && typeof n === 'object' ? { id: n.id || id, idx, n } : null))
    .filter((x) => { const n = x && x.n; return Boolean(n && ((n.role === 'user' && !n.toolResult) || n.role === 'assistant')); })
    .map((x) => ({ ...x, t: text(x.n).replace(/\s+/g, ' ').trim() }))
    .filter((x) => x.t);

  if (!list.length) return [];

  if (!(c && c.root && Array.isArray(c.root.children) && c.root.children.length)) {
    list.sort((a, b) => ((a.n.created || 0) - (b.n.created || 0)) || (a.idx - b.idx));
  }

  const byId = new Map(list.map((x) => [x.id, x]));
  const pairedAssistant = new Set();
  const turns = [];

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    if (item.n.role === 'user') {
      let reply = null;
      // Check explicit children links first, and mark all sibling children so rejected drafts are skipped
      if (Array.isArray(item.n.children) && item.n.children.length) {
        for (const chId of item.n.children) pairedAssistant.add(chId);
        const selIdx = typeof item.n.sel === 'number' ? Math.min(Math.max(0, item.n.sel), item.n.children.length - 1) : item.n.children.length - 1;
        const cid = item.n.children[selIdx];
        const cand = byId.get(cid);
        if (cand && cand.n.role === 'assistant') reply = cand;
      }
      // Fallback: immediate next node if it's an unpaired assistant message
      if (!reply && i + 1 < list.length && list[i + 1].n.role === 'assistant' && !pairedAssistant.has(list[i + 1].id)) {
        reply = list[i + 1];
      }
      if (reply) pairedAssistant.add(reply.id);
      turns.push({
        order: turns.length,
        user: item,
        assistant: reply,
        uLex: analyzeText(item.t),
        aLex: reply ? analyzeText(reply.t) : null,
      });
    } else if (!pairedAssistant.has(item.id)) {
      turns.push({
        order: turns.length,
        user: null,
        assistant: item,
        uLex: null,
        aLex: analyzeText(item.t),
      });
    }
  }
  return turns;
}

function safeSlice(str, start, end) {
  let s = Math.max(0, start);
  let e = Math.min(str.length, Math.max(s, end));
  if (s > 0 && s < str.length) {
    const code = str.charCodeAt(s);
    if (code >= 0xdc00 && code <= 0xdfff) s++;
  }
  if (e > s && e < str.length) {
    const code = str.charCodeAt(e - 1);
    if (code >= 0xd800 && code <= 0xdbff) e--;
  }
  return str.slice(s, e);
}

/**
 * Extracts a clean, readable excerpt up to `maxChars` centered around the highest concentration
 * of query stems in `rawText`, falling back to the opening of `rawText` when no stems appear.
 */
export function smartExcerpt(rawText, queryStems, maxChars = 320) {
  const cap = Math.max(16, Number(maxChars) || 320);
  const clean = String(rawText || '')
    .replace(/<{3,}/g, '‹‹‹')
    .replace(/>{3,}/g, '›››')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean.length <= cap) return clean;
  if (!queryStems || !queryStems.size) return `${safeSlice(clean, 0, cap - 1).trimEnd()}…`;

  // Find the character offset of the best matching window
  const wordRe = /[\p{L}\p{N}][\p{L}\p{N}'’._+-]*/gu;
  const hits = [];
  let m;
  while ((m = wordRe.exec(clean)) !== null) {
    const st = stemWord(m[0]);
    if (queryStems.has(st)) hits.push(m.index);
  }
  if (!hits.length) return `${safeSlice(clean, 0, cap - 1).trimEnd()}…`;

  // Pick the hit that maximizes matches within a `cap * 0.75` span
  const span = Math.floor(cap * 0.75);
  let bestStartHit = hits[0];
  let bestCount = 0;
  for (let i = 0; i < hits.length; i++) {
    let count = 0;
    for (let j = i; j < hits.length && hits[j] - hits[i] <= span; j++) count++;
    if (count > bestCount) {
      bestCount = count;
      bestStartHit = hits[i];
    }
  }

  if (bestStartHit < cap * 0.55) {
    return `${safeSlice(clean, 0, cap - 1).trimEnd()}…`;
  }
  let start = Math.max(0, bestStartHit - Math.floor(cap * 0.28));
  // Snap to a word boundary
  if (start > 0) {
    const sp = clean.indexOf(' ', start);
    if (sp > 0 && sp - start < 24) start = sp + 1;
  }
  const slice = safeSlice(clean, start, start + cap - 2).trimEnd();
  const prefix = start > 0 ? '…' : '';
  const suffix = start + slice.length < clean.length ? '…' : '';
  return `${prefix}${slice}${suffix}`;
}

export const cosine = (a, b) => {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = Number(a[i]);
    const bi = Number(b[i]);
    if (!Number.isFinite(ai) || !Number.isFinite(bi)) continue;
    d += ai * bi;
    x += ai * ai;
    y += bi * bi;
  }
  return x > 0 && y > 0 ? d / Math.sqrt(x * y) : 0;
};

// BM25 hyperparameters tuned for conversational turn lengths
const BM25_K1 = 1.4;
const BM25_B = 0.65;

/**
 * Scores a lexical analysis (`lex`) against a query analysis (`qLex`) using BM25 + bigram phrase bonus
 * + concept-cluster expansion + rare entity boosting.
 */
function scoreLexical(lex, qLex, idf, avgLen) {
  if (!lex || !lex.tokens.length) return 0;
  const docLen = lex.tokens.length;
  const norm = 1 - BM25_B + BM25_B * (docLen / Math.max(4, avgLen));
  let score = 0;
  let matchedStems = 0;

  for (const [w, qtf] of qLex.tf.entries()) {
    const tf = lex.tf.get(w) || 0;
    if (!tf) continue;
    matchedStems++;
    const termIdf = idf(w);
    const sat = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm);
    const entityBoost = qLex.entities.has(w) ? 1.3 : 1.0;
    const queryWeight = 1 + Math.min(0.5, (qtf - 1) * 0.2);
    score += termIdf * sat * entityBoost * queryWeight;
  }

  // Bigram phrase bonus: adjacent query stems appearing together in the target text
  if (qLex.bigrams.size && lex.bigrams.size) {
    for (const bg of qLex.bigrams) {
      if (lex.bigrams.has(bg)) score += 1.65;
    }
  }

  // Coverage bonus when multiple distinct query terms co-occur in the same field
  if (matchedStems >= 2 && qLex.tf.size >= 2) {
    score *= 1 + 0.18 * (matchedStems / qLex.tf.size);
  }

  // Concept-cluster expansion (paraphrase bridge when exact stems differ, e.g. "dentist" ↔ "crown" / "tooth")
  if (qLex.concepts.size && lex.concepts.size) {
    for (const c of qLex.concepts) {
      if (lex.concepts.has(c)) score += 0.95;
    }
  }

  return score;
}

/**
 * Builds snippet lines (`You said: …` / `Eden replied: …`) for a conversation's ranked turns.
 * When a user prompt matches, its paired assistant reply is included automatically so the model
 * sees the answer that was given, not just the question.
 */
function buildSnippetsForTurns(turns, scoredTurns, qStems, maxSnippets = 4) {
  const out = [];
  const chosen = scoredTurns.length
    ? scoredTurns.slice(0, 2).sort((a, b) => a.turn.order - b.turn.order).map((x) => x.turn)
    : turns.slice(0, 2);

  for (const t of chosen) {
    if (out.length >= maxSnippets) break;
    if (t.user) {
      out.push(`You said: ${smartExcerpt(t.user.t, qStems, 320)}`);
    }
    if (t.assistant && out.length < maxSnippets) {
      out.push(`Eden replied: ${smartExcerpt(t.assistant.t, qStems, 360)}`);
    }
  }
  return out;
}

/**
 * The chats worth showing for `prompt`: [{ id, title, when, snippets: [string] }], best first.
 * `convs` are the saved chats; the current one, temporary ones, private ones and courses are skipped.
 * Supports optional `{ vecs, qvec, now }` for hybrid semantic + lexical recall.
 */
export function findRecall(convs, prompt, { currentId = null, max = 4, isPrivate = () => false, vecs = null, qvec = null, now = Date.now(), allowFallback = true } = {}) {
  const qLex = analyzeText(prompt);
  const back = asksBack(prompt);
  const hasVecs = Boolean(vecs && Array.isArray(qvec) && qvec.length);
  const pool = (convs || []).filter((c) => c && c.id !== currentId && !c.temp && !c.course && !isPrivate(c) && c.nodes);
  if (!pool.length || (!qLex.set.size && !back && !hasVecs)) return [];

  const docs = pool.map((c) => {
    const { titleLex, turns } = getConvDoc(c);
    return { c, titleLex, turns };
  });

  // Compute Robertson-Sparck Jones smoothed IDF across the conversation corpus
  const df = new Map();
  let totalMsgLen = 0;
  let totalMsgs = 0;
  for (const d of docs) {
    const seen = new Set(d.titleLex.set);
    for (const t of d.turns) {
      if (t.uLex) {
        totalMsgLen += t.uLex.tokens.length;
        totalMsgs++;
        for (const w of t.uLex.set) seen.add(w);
      }
      if (t.aLex) {
        totalMsgLen += t.aLex.tokens.length;
        totalMsgs++;
        for (const w of t.aLex.set) seen.add(w);
      }
    }
    for (const w of seen) df.set(w, (df.get(w) || 0) + 1);
  }
  const N = docs.length;
  const avgLen = totalMsgs > 0 ? totalMsgLen / totalMsgs : 16;
  const idf = (w) => 1 + Math.log((N + 1) / ((df.get(w) || 0) + 0.5));

  const timeWin = parseTemporalWindow(prompt, now);
  const refNow = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
  const scored = [];

  for (const d of docs) {
    const titleScore = scoreLexical(d.titleLex, qLex, idf, 6) * 1.65;
    const turnHits = [];
    let bestTurn = 0;

    for (const t of d.turns) {
      const uScore = t.uLex ? scoreLexical(t.uLex, qLex, idf, avgLen) * 1.25 : 0;
      const aScore = t.aLex ? scoreLexical(t.aLex, qLex, idf, avgLen) : 0;
      // A turn where both question and answer match gets a synergy bonus; otherwise the stronger side leads
      const s = uScore > 0 && aScore > 0 ? Math.max(uScore, aScore) + Math.min(uScore, aScore) * 0.45 : uScore + aScore;
      if (s > 0) {
        turnHits.push({ s, turn: t });
        if (s > bestTurn) bestTurn = s;
      }
    }

    let lexTotal = titleScore + bestTurn;
    if (turnHits.length > 1) {
      const extra = turnHits.reduce((acc, h) => acc + h.s, 0) - bestTurn;
      lexTotal += extra / Math.sqrt(1 + turnHits.length);
    }

    // Dense vector semantic similarity (when embeddings are available)
    const cVec = hasVecs ? getVec(vecs, d.c.id) : null;
    const sim = cVec ? cosine(qvec, cVec) : 0;
    const vecBoost = sim > 0.48 ? (sim - 0.45) * 8.5 : 0;

    // Temporal alignment boost & mild recency tie-breaker
    const rawWhen = Number(d.c.updated || d.c.created || 0);
    const when = Number.isFinite(rawWhen) ? rawWhen : 0;
    let timeBoost = 0;
    if (timeWin && when >= timeWin.from && when <= timeWin.to) {
      timeBoost = (lexTotal > 0 || sim > 0.48 || back) ? 1.8 : 0;
    }
    const ageDays = when > 0 && refNow > when ? (refNow - when) / DAY_MS : 30;
    const recencyTieBreak = (lexTotal > 0 || vecBoost > 0) ? 0.08 / (1 + Math.max(0, ageDays) / 14) : 0;

    const total = lexTotal + vecBoost + timeBoost + recencyTieBreak;
    const minimum = qLex.set.size >= 3 ? 2.1 : 1.15;

    if (total >= minimum || (back && (lexTotal > 0 || sim > 0.5 || timeBoost > 0)) || sim >= 0.62) {
      turnHits.sort((a, b) => b.s - a.s || b.turn.order - a.turn.order);
      const snippets = buildSnippetsForTurns(d.turns, turnHits, qLex.set, 4);
      if (snippets.length) {
        scored.push({ total, lexTotal, sim, c: d.c, snippets });
      }
    }
  }

  scored.sort((a, b) => b.total - a.total || (Number(b.c.updated) || 0) - (Number(a.c.updated) || 0));
  let out = scored.slice(0, max);

  if (back && allowFallback && !out.length) {
    // "what did I ask you about ...": nothing matched lexically, so fall back to the newest chats' turns
    const fallbackPool = timeWin
      ? pool.filter((c) => { const w = Number(c.updated || c.created || 0); return Number.isFinite(w) && w >= timeWin.from && w <= timeWin.to; })
      : pool;
    const source = fallbackPool.length ? fallbackPool : pool;
    out = source
      .slice()
      .sort((a, b) => (Number(b.updated) || 0) - (Number(a.updated) || 0))
      .slice(0, max)
      .map((c) => {
        const turns = extractTurns(c);
        const snippets = buildSnippetsForTurns(turns, [], qLex.set, 2);
        return { total: 0, c, snippets };
      })
      .filter((x) => x.snippets.length);
  }

  return out.map((x) => {
    const rawW = Number(x.c.updated || x.c.created || 0);
    return {
      id: x.c.id,
      title: cleanTitle(x.c.title),
      when: Number.isFinite(rawW) ? rawW : 0,
      snippets: x.snippets,
    };
  });
}

/** The context block for the turn, or null. */
export function recallBlock(convs, prompt, opts = {}) {
  const found = findRecall(convs, prompt, opts);
  if (!found.length) return null;
  const day = (t) => {
    if (!t) return 'earlier';
    const d = new Date(t);
    return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : 'earlier';
  };
  const body = found.map((f) => `Chat "${cleanTitle(f.title)}" (${day(f.when)}):\n${f.snippets.join('\n')}`).join('\n\n');
  return {
    title: 'From your other chats',
    source: 'recall',
    text: `Parts of the user's earlier chats in Eden that look relevant. Use them if they help answer; don't mention this block.\n\n${body}`,
  };
}

/**
 * The text of a chat that gets embedded: its title, opening turns (both user questions and key
 * assistant conclusions), and latest turns when the thread grew longer, capped at 1,600 chars.
 */
export function chatDigest(c) {
  if (!c || typeof c !== 'object') return '';
  const doc = getConvDoc(c);
  if (typeof doc.digest === 'string') return doc.digest;
  const turns = doc.turns;
  const parts = [];
  if (c.title && String(c.title).trim()) parts.push(String(c.title).replace(/\s+/g, ' ').trim());

  const chosen = turns.length <= 4
    ? turns
    : [...turns.slice(0, 2), ...turns.slice(-2)];

  for (const t of chosen) {
    if (t.user && t.user.t) parts.push(t.user.t.slice(0, 280));
    if (t.assistant && t.assistant.t) parts.push(t.assistant.t.slice(0, 220));
  }

  // If there are middle turns in a long conversation, append their salient proper nouns / rare terms
  if (turns.length > 4) {
    const midTerms = new Set();
    for (const t of turns.slice(2, -2)) {
      if (t.uLex) for (const w of t.uLex.entities) midTerms.add(w);
      if (t.uLex) for (const w of t.uLex.tokens.slice(0, 8)) midTerms.add(w);
    }
    if (midTerms.size) parts.push([...midTerms].slice(0, 25).join(' '));
  }

  doc.digest = parts.join('\n').trim().slice(0, 1600);
  return doc.digest;
}

/** Deterministic 32-bit FNV-1a hash of a chat's digest, so `chat-vectors.js` re-embeds when content changes. */
export function chatDigestHash(c) {
  if (!c || typeof c !== 'object') return fnv1a('').toString(36);
  const doc = getConvDoc(c);
  if (typeof doc.digestHash === 'string') return doc.digestHash;
  const s = chatDigest(c);
  doc.digestHash = fnv1a(s).toString(36);
  return doc.digestHash;
}

/**
 * The tool's search: hybrid BM25F lexical score + dense vector cosine similarity + Reciprocal Rank Fusion (RRF),
 * optionally bounded to chats updated between `from` and `to` (ms). → [{ id, title, when, snippets }], best first.
 */
export function searchChats(convs, query, { from = 0, to = Infinity, limit = 5, currentId = null, vecs = null, qvec = null, isPrivate = () => false, now = Date.now() } = {}) {
  const qLex = analyzeText(query);
  const parseBound = (v, def) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : def;
    if (typeof v === 'string' && v.trim()) {
      const p = Date.parse(v.trim());
      return Number.isFinite(p) ? p : def;
    }
    return def;
  };
  const minTime = parseBound(from, 0);
  const maxTime = parseBound(to, Infinity);
  const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(8, Math.round(Number(limit)))) : 5;

  const pool = (convs || []).filter((c) => {
    if (!c || c.id === currentId || c.temp || c.course || isPrivate(c) || !c.nodes) return false;
    const rawW = Number(c.updated || c.created || 0);
    const w = Number.isFinite(rawW) ? rawW : 0;
    return w >= minTime && w <= maxTime;
  });
  if (!pool.length) return [];

  const lexicalHits = findRecall(pool, query, { max: 40, now, allowFallback: false });
  const byId = new Map();
  lexicalHits.forEach((f, i) => {
    const key = f.id !== undefined ? f.id : `${f.title}:${f.when}`;
    byId.set(key, { f, rank: i + 1, score: 40 - i });
  });

  // Rank by vector similarity for Reciprocal Rank Fusion (RRF)
  const hasVecs = Boolean(vecs && Array.isArray(qvec) && qvec.length);
  const vecRanks = new Map();
  if (hasVecs) {
    const sims = pool
      .map((c) => {
        const cv = getVec(vecs, c.id);
        return { id: c.id, sim: cv ? cosine(qvec, cv) : 0 };
      })
      .filter((x) => x.sim > 0)
      .sort((a, b) => b.sim - a.sim);
    sims.forEach((x, i) => vecRanks.set(x.id, { sim: x.sim, rank: i + 1 }));
  }

  const out = [];
  for (const c of pool) {
    const rawW = Number(c.updated || c.created || 0);
    const when = Number.isFinite(rawW) ? rawW : 0;
    const w = byId.get(c.id) || byId.get(`${cleanTitle(c.title)}:${when}`);
    const v = vecRanks.get(c.id);
    const cv = hasVecs ? getVec(vecs, c.id) : null;
    const sim = v ? v.sim : (cv ? cosine(qvec, cv) : 0);

    // Hybrid score: calibrated lexical rank + semantic similarity above noise floor + RRF synergy bonus
    const lexPart = w ? w.score / 4 : 0;
    const vecPart = Math.max(0, sim - 0.42) * 14;
    const rrfPart = (w ? 18 / (10 + w.rank) : 0) + (v && sim >= 0.45 ? 18 / (10 + v.rank) : 0);
    const bothBonus = w && sim >= 0.5 ? 2.5 : 0;
    const score = lexPart + vecPart + rrfPart + bothBonus;

    if (score <= 0.4 && !(w || sim > 0.52)) continue;

    let snippets = w ? w.f.snippets : [];
    if (!snippets.length) {
      const turns = extractTurns(c);
      snippets = buildSnippetsForTurns(turns, [], qLex.set, 3);
    }
    if (!snippets.length) continue;
    out.push({
      score,
      id: c.id,
      title: cleanTitle(c.title),
      when,
      snippets,
    });
  }
  return out
    .sort((a, b) => b.score - a.score || b.when - a.when)
    .slice(0, safeLimit)
    .map(({ score, ...r }) => r); // eslint-disable-line no-unused-vars
}
