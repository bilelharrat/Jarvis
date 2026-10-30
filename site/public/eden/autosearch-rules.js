// Auto-search's rules (no DOM, no imports; tested by src/__tests__/autosearch.test.ts): does this
// message need information the model can't have from training? A small deterministic check in
// this browser, no model call and nothing sent anywhere to decide. English plus a few common
// Spanish, French and German words. It only ever turns a plain Chat message into a Search one.

const L = '\\p{L}\\p{N}';
const word = (src) => new RegExp(`(?<![${L}])(?:${src})(?![${L}])`, 'iu');
const any = (list) => word(list.join('|'));

// "look this up" and friends: an explicit ask to use the web
const EXPLICIT = any([
  'look(?:\\s|-)?(?:it|this|that|these|those|him|her|them)?\\s?up', 'search(?:\\s+(?:for|the\\s+web|online|the\\s+internet|up))', 'google(?:\\s+(?:it|this|that|for))?', 'find\\s+out',
  'web\\s+search', 'check\\s+online', 'busca(?:r)?\\s+en\\s+(?:internet|la\\s+web)', 'cherche(?:r)?\\s+(?:sur|en\\s+ligne)', 'recherche\\s+sur\\s+internet', 'im\\s+internet\\s+suchen', 'such\\s+(?:im\\s+)?(?:netz|web|internet)',
]);
const URL_RE = /\bhttps?:\/\/[^\s<>"')]+|\bwww\.[a-z0-9-]+\.[a-z]{2,}[^\s<>"')]*/i;

const TIME = any([
  'news', 'latest', 'breaking', 'headlines?', 'recent(?:ly)?', 'right\\s+now', 'as\\s+of\\s+now', 'at\\s+the\\s+moment', 'currently', 'these\\s+days', 'lately', 'this\\s+(?:week|weekend|month|season)', 'tonight', 'tomorrow', 'yesterday', 'up\\s+to\\s+date',
  'noticias', 'últimas?', 'ultimas?', 'ahora\\s+mismo', 'actualmente', 'esta\\s+semana', 'esta\\s+noche', 'mañana', 'ayer',
  'actualités', 'dernières?\\s+(?:nouvelles|infos)', 'en\\s+ce\\s+moment', 'cette\\s+semaine', 'ce\\s+soir', 'demain', 'hier',
  'nachrichten', 'aktuell(?:e|er|es|en)?', 'neueste[nrs]?', 'gerade\\s+jetzt', 'diese\\s+woche', 'heute\\s+abend', 'morgen', 'gestern',
]);
const TODAY = any(['today', 'hoy', "aujourd'hui", 'aujourd’hui', 'heute']);
const YEAR = /(?<![\d.,])(?:2026|2027|2028)(?![\d])/;
const WEATHER = any(['weather', 'forecast', 'will\\s+it\\s+(?:rain|snow)', 'is\\s+it\\s+(?:raining|snowing)', 'el\\s+tiempo', 'clima', 'pronóstico', 'météo', 'previsions?\\s+météo', 'wetter', 'wettervorhersage']);
const SPORTS = any(['who\\s+won', 'who\\s+is\\s+winning', "who'?s\\s+winning", 'final\\s+score', 'scores?', 'standings', 'fixtures?', 'qui\\s+a\\s+gagné', 'quién\\s+ganó', 'quien\\s+gano', 'wer\\s+hat\\s+gewonnen', 'resultado\\s+del\\s+partido', 'résultat\\s+du\\s+match', 'ergebnis']);
const MARKET = any([
  '(?:stock|share)\\s+price', 'stock\\s+market', 'exchange\\s+rate', 'market\\s+cap', 'price\\s+of\\s+(?:bitcoin|btc|ethereum|eth|solana|gold|silver|oil|crude|gas|a\\s+barrel)', '(?:bitcoin|btc|ethereum|eth|solana|dogecoin|xrp)\\s+(?:price|now|today|trading|worth)',
  'how\\s+much\\s+is\\s+(?:bitcoin|btc|ethereum|eth|solana|gold|a\\s+share)', '(?:usd|eur|gbp|jpy|chf|cad|aud)\\s*(?:to|in|\\/)\\s*(?:usd|eur|gbp|jpy|chf|cad|aud)',
  'precio\\s+de(?:l)?\\s+(?:bitcoin|oro|petróleo|dólar|euro)', 'cotización', 'cours\\s+(?:du|de\\s+l’?|de\\s+l\'?|de)\\s*(?:bitcoin|l’or|or|pétrole|dollar|euro|action)', 'prix\\s+du\\s+(?:bitcoin|pétrole|baril|or)', 'aktienkurs', 'wechselkurs', 'bitcoin-?kurs',
]);
const OPEN = word("(?:is|are)\\s+[\\p{L}\\p{N}'’&.\\- ]{1,40}?\\s+(?:open|closed|available|in\\s+stock|sold\\s+out|down|up)(?:\\s+(?:now|today|tonight|right\\s+now|on\\s+\\p{L}+day|this\\s+\\p{L}+))?|(?:opening|business|store)\\s+hours|what\\s+time\\s+does\\s+[\\p{L}\\p{N}'’ ]{1,30}\\s+(?:open|close)|open\\s+now|horaires?\\s+d['’]ouverture|horario\\s+de\\s+apertura|öffnungszeiten");
const NEAR = any(['near\\s+me', 'nearby', 'nearest', 'closest', 'cerca\\s+de\\s+mí', 'cerca\\s+de\\s+mi', 'près\\s+de\\s+moi', 'in\\s+der\\s+nähe']);
const RELEASE = any(['(?:release|launch|premiere|air)\\s+date', 'when\\s+(?:does|is|did|will|do)\\s+[\\p{L}\\p{N}\'’:&.\\- ]{1,50}?\\s+(?:come\\s+out|release[ds]?|launch(?:ed|es)?|premiere[ds]?|drop|start|air)', 'fecha\\s+de\\s+(?:lanzamiento|estreno)', 'date\\s+de\\s+sortie', 'erscheinungsdatum']);
const CHANGED = any([
  'who\\s+(?:is|are|was)\\s+(?:the\\s+)?(?:current|new|latest|present|reigning)\\b', 'who\\s+(?:is|runs|leads)\\s+(?:the\\s+)?(?:ceo|president|prime\\s+minister|mayor|chancellor|governor)\\b', '(?:ceo|president|prime\\s+minister|mayor)\\s+of\\b.*\\b(?:now|currently|today)',
  'what(?:’s|\'s|\\s+is|\\s+was)?\\s+(?:happening|going\\s+on)\\s+(?:with|in|at|to)', 'what\\s+happened\\s+(?:with|to|in|at|on|after)', 'any\\s+(?:news|updates?)\\s+(?:on|about|from)', 'has\\s+[\\p{L}\\p{N}\'’:&.\\- ]{1,40}?\\s+(?:been\\s+)?(?:released|announced|launched|updated|changed|shut\\s+down)', 'is\\s+[\\p{L}\\p{N}\'’:&.\\- ]{1,40}?\\s+still\\s+(?:a\\s+thing|alive|around|available|supported|working)',
  'qué\\s+pasó\\s+con', 'que\\s+pasó\\s+con', 'que\\s+s’?est-il\\s+passé', 'was\\s+ist\\s+(?:mit|bei)\\s+[\\p{L}]+\\s+passiert',
]);

// Products and models that change every year: "New MacBooks", "the new iPhone", "upcoming GPUs", "newest Pixel". A short
// message that opens with new/newest/upcoming, or a new + product pair anywhere, is a request for what's out now.
const NEWNESS = word("(?:the\\s+)?(?:new(?:est)?|upcoming|just\\s+(?:released|announced|launched)|next[\\s-]gen(?:eration)?)\\b");
const GADGET = any(['macbooks?', 'mac\\s+(?:mini|studio|pro)', 'imacs?', 'iphones?', 'ipads?', 'apple\\s+watch', 'airpods', 'vision\\s+pro', 'galaxy(?:\\s+[a-z]\\d+)?', 'pixel(?:\\s+\\d+)?', 'playstation|ps\\d', 'xbox', 'switch\\s*\\d?', 'rtx|radeon|geforce|gpus?|cpus?|chips?|processors?', 'laptops?', 'phones?|smartphones?', 'tablets?', 'tvs?', 'cars?|evs?', 'models?', 'versions?', 'releases?', 'lineup', 'games?|movies?|shows?|episodes?|albums?|songs?', 'iOS|macOS|android|windows|chatgpt|claude|gemini|gpt[\\w.-]*']);

// Facts about named people, works and teams ("What episodes did Tom Selleck narrate of 30 for 30", "Did Eisenhower ...",
// "Who directed Heat"): a model answers these from fuzzy memory and will deny a true premise, so they go to the web.
// A fact question that names something: a full name or title (two capitalised words), or a capitalised name after
// did/was/has/who/what... The first word of a sentence doesn't count.
const FACT_OPEN = /^\s*(?:what|which|who|whom|whose|when|where|how\s+(?:many|much|old|tall|long|far)|did|does|do|was|were|is|are|has|have|had|can\s+you\s+(?:name|list|tell\s+me))\b/i;
const NAMED_TWO = /(?<![.!?]\s)(?<!^)\b[A-Z][\p{L}'’.-]{1,}(?:\s+(?:of|the|de|van|von|for|and|&)\s+|\s+)[A-Z0-9][\p{L}0-9'’.-]*/u;
const NAMED_ONE = /\b(?:[Dd]id|[Dd]oes|[Ww]as|[Ww]ere|[Hh]as|[Hh]ad|about|of|by|with|from|in|at|on|starring|directed|wrote|written|played|plays|narrated|sang|composed|invented|founded|created|produced|starred\s+in|stars\s+in|born|died)\s+(?:the\s+)?[A-Z][\p{L}'’.-]{2,}/u;

// Getting somewhere: trains, buses, flights, ferries, timetables, "be in Palo Alto by noon". Live schedules a model can't
// know (2026-10-13: Eden made up a Caltrain departure window instead of looking at the timetable).
const TRIP = any([
  'trains?', 'caltrain', 'bart', 'amtrak', 'subway', 'metro', 'tube', 'tram', 'light\\s+rail', 'muni', 'buse?s?', 'shuttle', 'ferry', 'ferries', 'flights?',
  'timetable', 'schedules?', 'departures?', 'arrivals?', 'next\\s+(?:train|bus|ferry|flight|departure)', 'last\\s+(?:train|bus|ferry)',
  'traffic', 'commute', 'directions?\\s+to', 'how\\s+(?:do|can|should)\\s+i\\s+get\\s+to', 'get\\s+(?:me\\s+)?to\\s+[\\p{L} ]{2,30}\\s+by',
]);
const TRIP_ASK = any([
  'find', 'which', 'what\\s+time', 'when', 'next', 'should\\s+i', 'can\\s+i', 'need\\s+to\\s+(?:be|get)', 'by\\s+(?:noon|midnight|\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)?)', 'leave', 'catch', 'take', 'how\\s+long', 'running', 'delayed?', 'on\\s+time',
]);

// Anything else that changes by the minute or the hour (2026-10-13, owner: "make sure this never happens again in any
// similar scenario"): traffic and ETAs, everyday weather questions, events, wait times, outages, local prices, tracking.
const LIVE = any([
  // traffic, roads, ETA
  'traffic', 'my\\s+eta', 'eta\\s+(?:to|for|if|from|at)', 'how\\s+long\\s+(?:will\\s+it|does\\s+it|would\\s+it|to)\\s+(?:take\\s+(?:me\\s+)?)?(?:to\\s+)?(?:drive|get|walk|bike|ride)', 'drive\\s+time', 'travel\\s+time', 'commute\\s+time',
  'road\\s+(?:closures?|closed|conditions?)', 'accidents?\\s+on', 'is\\s+(?:the\\s+)?(?:\\d{1,3}|i-?\\d{1,3}|highway\\s+\\d{1,3}|bridge|freeway|highway)\\s+(?:closed|backed\\s+up|jammed|busy|open)', 'fastest\\s+(?:way|route)', 'best\\s+route', 'when\\s+should\\s+i\\s+leave',
  // weather in everyday words
  'umbrella', 'jacket', 'coat\\s+today', 'rain(?:ing)?\\s+(?:today|tonight|tomorrow|later|this)', 'will\\s+it\\s+be\\s+(?:hot|cold|sunny|windy|nice)', 'temperature\\s+(?:today|now|outside|in)', 'how\\s+(?:hot|cold|warm)\\s+is\\s+it',
  'air\\s+quality', 'aqi', 'smoke\\s+(?:today|in)', 'uv\\s+index', 'pollen', 'sunrise', 'sunset', 'tides?', 'surf\\s+(?:report|conditions?)', 'snow\\s+report', 'heat\\s+wave', 'storm\\s+(?:warning|watch|coming)', 'hurricane', 'wildfire', 'earthquake',
  // what's on, waits, outages, local prices, tracking
  "what(?:'s|’s|\\s+is)\\s+(?:happening|going\\s+on|on)\\s+(?:tonight|today|this\\s+weekend|near)", 'events?\\s+(?:tonight|today|this\\s+weekend|near)', 'concerts?\\s+(?:tonight|this)', 'tickets?\\s+(?:for|to)',
  'wait\\s+times?', 'how\\s+busy\\s+is', 'is\\s+[\\p{L}\\p{N}\\s\\-]{2,30}\\s+(?:down|crowded|busy)', 'outages?', 'power\\s+out',
  'gas\\s+prices?', 'price\\s+of\\s+gas', 'cheapest\\s+gas', 'flight\\s+(?:status|delayed|on\\s+time)', '(?:track|tracking)\\s+(?:my\\s+)?(?:package|order|shipment)', 'where\\s+is\\s+my\\s+(?:package|order|flight)',
]);

// Places typed in lowercase ("do deathrow inmates in texas have tv", 2026-10-13: answered from memory, wrong) and
// rules that differ by place and change over time: laws, what's allowed or banned, prisons, policies.
const PLACES = any([
  'alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois',
  'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri',
  'montana', 'nebraska', 'nevada', 'new\\s+hampshire', 'new\\s+jersey', 'new\\s+mexico', 'new\\s+york', 'north\\s+carolina', 'north\\s+dakota', 'ohio',
  'oklahoma', 'oregon', 'pennsylvania', 'rhode\\s+island', 'south\\s+carolina', 'south\\s+dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia',
  'washington', 'west\\s+virginia', 'wisconsin', 'wyoming', 'puerto\\s+rico', 'the\\s+us', 'the\\s+usa', 'america', 'canada', 'mexico', 'uk', 'england',
  'britain', 'ireland', 'france', 'germany', 'spain', 'italy', 'portugal', 'netherlands', 'belgium', 'switzerland', 'sweden', 'norway', 'denmark', 'poland',
  'russia', 'ukraine', 'turkey', 'israel', 'iran', 'saudi\\s+arabia', 'uae', 'dubai', 'egypt', 'nigeria', 'kenya', 'south\\s+africa', 'india', 'pakistan',
  'china', 'japan', 'korea', 'south\\s+korea', 'north\\s+korea', 'taiwan', 'singapore', 'australia', 'new\\s+zealand', 'brazil', 'argentina', 'colombia',
  'chile', 'peru', 'cuba', 'tunisia', 'morocco', 'algeria', 'lebanon', 'qatar',
]);
const RULES = any([
  'laws?', 'legal(?:ly)?', 'illegal', 'allowed', 'banned', 'permitted', 'prohibited', 'regulations?', 'inmates?',
  'death\\s*row', 'prisons?', 'jails?', 'prisoners?', 'tax(?:es)?', 'minimum\\s+wage', 'drinking\\s+age', 'voting', 'visa', 'citizenship',
]);
const YES_NO = /^\s*(?:do|does|did|is|are|can|could|may|will|would|should|has|have)\b/i;
const QUESTION = /\?\s*$|^\s*(?:do|does|did|is|are|was|were|can|could|may|will|would|should|has|have|what|which|who|when|where|why|how)\b/i;

// Products by name, typed any way ("does nothing phone 4a pro have esim", 2026-10-15: Eden said the phone doesn't exist,
// it does): a brand, or a model number with a suffix, in a question. Specs and features change with every release.
const BRANDS = any([
  'nothing\\s+phone', 'cmf\\s+phone', 'iphone', 'ipad', 'macbook', 'imac', 'mac\\s+(?:mini|studio|pro)', 'apple\\s+watch', 'airpods', 'vision\\s+pro', 'pixel',
  'galaxy', 'samsung', 'oneplus', 'xiaomi', 'redmi', 'poco', 'oppo', 'vivo', 'huawei', 'honor', 'motorola', 'moto\\s+g', 'sony\\s+xperia', 'asus', 'rog\\s+phone',
  'surface\\s+(?:pro|laptop)', 'thinkpad', 'dell\\s+xps', 'playstation', 'ps[56]', 'xbox', 'nintendo', 'steam\\s+deck', 'meta\\s+quest', 'kindle',
  'garmin', 'fitbit', 'tesla\\s+model', 'rivian', 'gopro', 'dji', 'rtx\\s*\\d{4}', 'radeon', 'snapdragon', 'tensor\\s+g\\d',
]);
const MODEL_NUMBER = /(?<!\d)\d{1,4}[a-z]?\s*(?:pro|max|ultra|plus|mini|lite|fold|flip|fe|neo|s|e|a)\b|\(\d{1,2}[a-z]?\)/i;
// A named person's record ("Jim Everett starts every year"): stats, seasons and careers, from a source, not from memory.
const STATS = any([
  'starts', 'stats', 'statistics', 'career', 'seasons?', 'games\\s+played', 'record', 'points\\s+per', 'yards', 'touchdowns?', 'interceptions?', 'goals',
  'assists', 'rebounds', 'batting', 'home\\s+runs?', 'era', 'rushing', 'passing', 'wins', 'losses', 'titles', 'championships?', 'net\\s+worth', 'salary',
  'contract', 'filmography', 'discography', 'albums', 'height', 'age',
]);
const NAME_ANYWHERE = /\b[A-Z][\p{L}'’.-]+\s+[A-Z][\p{L}'’.-]+/u;

// The default, 2026-10-15 (owner: "way too many hallucinations, more than the models we use"): the Gemini and ChatGPT
// apps ground factual questions in a search; Eden answered them from a cheap model's memory unless a keyword list
// caught them, and no list catches everything ("does nothing phone 4a pro have esim", "jim everett starts every year").
// Now any question for information searches, unless it is plainly one that doesn't need the web: writing or editing,
// code, math, a general concept with nothing specific in it, small talk, or the person's own how-to. With search on, the
// model can still answer without searching where the web adds nothing.
const ASKS = /\?\s*$|^\s*(?:do|does|did|is|are|was|were|can|could|will|would|should|has|have|had|what|what's|whats|which|who|whom|whose|when|where|why|how|tell\s+me|give\s+me|show\s+me|list|find|any\s+idea)\b/i;
const CODEY = any(['code', 'coding', 'bug', 'css', 'html', 'python', 'javascript', 'typescript', 'java', 'c\\+\\+', 'sql', 'regex', 'loop', 'function', 'recursion', 'algorithm', 'binary\\s+search', 'array', 'tuple', 'div', 'compile', 'git', 'terminal', 'excel\\s+formula', 'variable', 'class', 'api', 'json']);
const MATH = /\d\s*(?:[-+*/x×÷^]|times|plus|minus|divided\s+by|to\s+the\s+power)\s*\d|^\s*(?:solve|calculate|compute|simplify|integrate|differentiate)\b/i;
const SMALL_TALK = /^\s*(?:hi|hello|hey|yo|thanks|thank\s+you|good\s+(?:morning|night)|how\s+are\s+you|what'?s\s+up|tell\s+me\s+a\s+joke|who\s+are\s+you|what\s+can\s+you\s+do)\b/i;
const OWN = /^\s*(?:my|i|i'm|im|i've)\b/i;
const CONCEPT = /^\s*(?:what\s+(?:is|are)\s+(?:a|an)\s+|what\s+is\s+[a-z-]+\s*\??\s*$|how\s+(?:does|do)\s+(?:a|an|the)?\s*[a-z\s-]+\s+work|explain\s+(?:how|what|why|the\s+concept)|what(?:'s|\s+is)\s+the\s+difference\s+between|define\b|meaning\s+of|what\s+are\s+the\s+rules\s+of\s+[a-z]+\s*\??$)/i;
const SPECIFIC = /\d|\b[A-Z][\p{L}'’.-]*\b/u;
function infoQuestion(t) {
  if (!ASKS.test(t) || MAKES.test(t) || SMALL_TALK.test(t) || CODEY.test(t) || MATH.test(t)) return false;
  const rest = t.replace(/^\s*\S+/, ''); // the first word's capital doesn't make it specific
  if (CONCEPT.test(t) && !SPECIFIC.test(rest) && !BRANDS.test(t)) return false;
  if (OWN.test(t) && !SPECIFIC.test(rest)) return false;
  return true;
}

// Asks to make or change text, pictures or videos: "the latest version of my essay" or "draw me a lighthouse at sunset" is not news.
const MAKES = /^\s*(?:(?:hey\s+)?eden[,:]?\s+)?(?:please\s+|can\s+you\s+|could\s+you\s+|would\s+you\s+|will\s+you\s+|pls\s+|i\s+(?:want|need|would\s+like)\s+(?:you\s+to\s+)?)?(?:write|draft|compose|rewrite|rephrase|translate|proofread|edit|fix|refactor|debug|summari[sz]e|paraphrase|generate|create|make|draw|paint|design|render|produce|sketch|illustrate|animate|shoot|film|imagine|code|implement|explain\s+how|redacta|escribe|traduce|écris|écrire|traduis|schreib|übersetze)\b/i;

/** Does this message need the web: explicit, or about now/news/prices/scores/weather/places/changed facts? */
export function needsCurrentInfo(text) {
  const raw = String(text || '');
  const t = raw.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ').trim();
  if (t.length < 4) return false;
  if (URL_RE.test(t)) return true; // read this page
  if (EXPLICIT.test(t)) return true;
  if (t.length > 600) return false; // pasted material, not a question
  if (MAKES.test(t)) return false;
  if (WEATHER.test(t) || SPORTS.test(t) || MARKET.test(t) || NEAR.test(t) || OPEN.test(t) || RELEASE.test(t) || CHANGED.test(t)) return true;
  if (YEAR.test(t) && /\?/.test(t)) return true;
  if (FACT_OPEN.test(t) && t.length <= 200 && (NAMED_TWO.test(t.replace(/^\s*\S+\s*/, '')) || NAMED_ONE.test(t)) && !/^\s*(?:what|how)\s+(?:is|are|does|do)\s+(?:the\s+)?(?:difference|meaning|definition|syntax)\b/i.test(t)) return true;
  // "Where is Rains", "what's Rains Hall", "who is Kai Trump": a short question about something named. A model can't know
  // every dorm, shop or person, and guessing (or searching the person's own chats) is worse than looking it up.
  if (t.length <= 120 && /^\s*(?:[Ww]here|[Ww]hat|[Ww]ho|[Ww]hich)(?:'s|’s|\s+(?:is|are|was|were))\s+(?:the\s+|a\s+|an\s+)?[A-Z][\p{L}\p{N}'’.&-]*/u.test(t)) return true;
  // place-bound rules in any question; a place alone only in a yes/no question about how things are there
  if (t.length <= 300 && ((QUESTION.test(t) && RULES.test(t)) || (YES_NO.test(t) && PLACES.test(t)))) return true;
  if (t.length <= 300 && BRANDS.test(t) && (QUESTION.test(t) || MODEL_NUMBER.test(t))) return true; // a product, by name
  if (t.length <= 300 && NAME_ANYWHERE.test(t) && STATS.test(t)) return true; // a named person's record
  if (TRIP.test(t) && TRIP_ASK.test(t) && t.length <= 400) return true;
  if (LIVE.test(t) && t.length <= 400) return true;
  if (t.length <= 300 && infoQuestion(t)) return true; // a question for information: grounded by default
  if (NEWNESS.test(t) && GADGET.test(t) && (t.length <= 90 || /\?/.test(t))) return true;
  const timed = TIME.test(t) || TODAY.test(t);
  // "today" or "latest" alone also appears in ordinary requests; with a question it is a request for fresh facts.
  return timed && (/\?\s*$/.test(t) || /^(?:what|who|when|where|which|how\s+(?:much|many)|is|are|did|does|do|has|have|any|tell\s+me|give\s+me|show\s+me|qué|quién|cuándo|dónde|qui|quand|où|quel|was|wer|wann|wo)\b/i.test(t) || /\b(?:news|headlines?|noticias|actualités|nachrichten)\b/i.test(t));
}

/**
 * The mode a message goes in: 'search' when plain Chat would answer from memory a question that
 * needs the web, else the mode as it is. Never in a temporary or privacy chat (the text would
 * leave this Mac/browser), when the person turned it off or picked Chat themselves, when the
 * message has images, or when no search is available.
 */
export function autoSearchMode({ text, mode = 'chat', enabled = true, temp = false, privacy = false, pinnedChat = false, hasImages = false, searchAvailable = true, override = false }) {
  if (mode !== 'chat' || enabled === false || temp || privacy || pinnedChat || hasImages || !searchAvailable || override) return mode;
  return needsCurrentInfo(text) ? 'search' : mode;
}

/**
 * The fact-check switches in Settings › Routing (ROADMAP N19) as the send body's settings: both are on by default on the
 * server, so only a switch the person turned off is sent (`premiseCheck: false`: no check of the question's assumptions;
 * `answerCheck: false`: no web double-check of answers that didn't use the web). Anything but `false` means on.
 */
export function factCheckSettings(settings) {
  const s = settings && typeof settings === 'object' ? settings : {};
  return { ...(s.premiseCheck === false ? { premiseCheck: false } : {}), ...(s.answerCheck === false ? { answerCheck: false } : {}) };
}

/**
 * The links an earlier reply cited, as a short note appended to that reply when it goes back to the model as history
 * (chat.js history): without them the model reads its own cited figures as unverified and takes them back (2026-10-25
 * replay). '' when there are none. At most `max` links, http(s) only, titles and URLs clipped.
 */
export function citedSourcesNote(citations, max = 6) {
  const seen = new Set();
  const lines = [];
  for (const c of Array.isArray(citations) ? citations : []) {
    const url = c && typeof c.url === 'string' ? c.url.trim() : '';
    if (!/^https?:\/\//i.test(url) || seen.has(url) || lines.length >= max) continue;
    seen.add(url);
    const title = String((c && c.title) || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    lines.push(`- ${title ? `${title}: ` : ''}${url.slice(0, 300)}`);
  }
  return lines.length ? `\n\n[Sources this reply cited from its web search:\n${lines.join('\n')}]` : '';
}
