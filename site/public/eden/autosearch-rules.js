// Auto-search's rules (no DOM, no imports; tested by src/__tests__/autosearch.test.ts): does this
// message need information the model can't have from training? A small deterministic check in
// this browser, no model call and nothing sent anywhere to decide. English plus a few common
// Spanish, French and German words. It only ever turns a plain Chat message into a Search one.

const L = '\\p{L}\\p{N}';
const word = (src) => new RegExp(`(?<![${L}])(?:${src})(?![${L}])`, 'iu');
const any = (list) => word(list.join('|'));

// "look it up on the web" and friends: an explicit ask to use the web, whatever else the message says. A bare "Google"
// (Google Sheets, Google's PageRank), "lookup" (a lookup table), "find out" and "search for" (a file) are not (AC2-4).
const EXPLICIT = any([
  'look\\s+(?:it|this|that|these|those|him|her|them)\\s+up', 'look\\s+(?:it\\s+)?up\\s+online', 'search\\s+(?:the\\s+web|online|the\\s+internet|google)', 'google\\s+(?:it|this|that|for\\s+me)',
  'web\\s+search', 'search\\s+the\\s+news', 'check\\s+online', 'find\\s+(?:it\\s+|this\\s+|that\\s+)?online', 'on\\s+the\\s+(?:web|internet)\\s+for', 'use\\s+(?:the\\s+)?(?:web|internet)\\s+(?:to|for)',
  'busca(?:r)?\\s+en\\s+(?:internet|la\\s+web|google)', 'cherche(?:r)?\\s+(?:sur\\s+(?:internet|le\\s+web|google)|en\\s+ligne)', 'recherche\\s+sur\\s+internet', 'im\\s+internet\\s+suchen', 'such\\s+(?:im\\s+)?(?:netz|web|internet)', 'google\\s+(?:mal|das)',
]);
// "look up the rent in Porto", "search for flights to Rome": a web ask, unless the message is about code ("look up a value in a DataFrame")
const LOOKUP = any(['look\\s+up', 'search\\s+(?:for|up)', 'find\\s+out']);
const URL_RE = /\bhttps?:\/\/[^\s<>"')]+|\bwww\.[a-z0-9-]+\.[a-z]{2,}[^\s<>"')]*/i;

// "Morgen"/"mañana" also mean "morning" (Guten Morgen, por la mañana); "hier" stays out (French "yesterday", but mostly
// in personal stories); "up to date" only next to information (AC2-5).
const TIME = any([
  'news', 'latest', 'breaking', 'headlines?', 'recent(?:ly)?', 'right\\s+now', 'as\\s+of\\s+now', 'at\\s+the\\s+moment', 'currently', 'these\\s+days', 'lately', 'this\\s+(?:week|weekend|month|season)', 'tonight', 'tomorrow', 'yesterday',
  '(?:most\\s+)?up[\\s-]to[\\s-]date\\s+(?:news|info|information|figures|numbers|data|status)',
  'noticias', 'últimas?', 'ultimas?', 'ahora\\s+mismo', 'actualmente', 'esta\\s+semana', 'esta\\s+noche', 'anoche', '(?<!(?:la|esta|una|de)\\s)mañana', 'ayer',
  'actualités', 'dernières?\\s+(?:nouvelles|infos)', 'en\\s+ce\\s+moment', 'cette\\s+semaine', 'ce\\s+soir', 'demain', 'hier\\s+soir',
  'nachrichten', 'aktuell(?:e|er|es|en)?', 'neueste[nrs]?', 'gerade\\s+jetzt', 'diese\\s+woche', 'heute\\s+abend', '(?<!(?:guten|heute|am|jeden|einen)\\s)morgen', 'gestern',
]);
const TODAY = any(['today', 'hoy', "aujourd'hui", 'aujourd’hui', 'heute']);
const YEAR = /(?<![\d.,])(?:2026|2027|2028)(?![\d])/;
const WEATHER = any([
  'weather', 'forecast', 'will\\s+it\\s+(?:rain|snow)', 'is\\s+it\\s+(?:going\\s+to\\s+)?(?:raining|snowing|rain|snow)', 'el\\s+tiempo', 'qu[ée]\\s+tiempo\\s+hace', 'clima', 'pronóstico', 'va\\s+a\\s+llover', 'llover[áa]?',
  'météo', 'previsions?\\s+météo', 'quel\\s+temps', 'va-t-il\\s+pleuvoir', 'il\\s+pleut', 'wetter', 'wettervorhersage', 'regnet\\s+es', 'wird\\s+es\\s+regnen',
]);
const SPORTS = any(['who\\s+won(?!\\s+(?:the\\s+)?(?:argument|debate|bet|fight|discussion|war|world\\s+war|battle|civil\\s+war))', 'who\\s+is\\s+winning', "who'?s\\s+winning", 'final\\s+score', "what(?:'s|’s|\\s+is|\\s+was)\\s+the\\s+score(?=\\s*(?:\\?|$|of\\b|in\\b))", 'standings', 'election\\s+results?', 'qui\\s+a\\s+gagné', 'quién\\s+ganó', 'quien\\s+gano', 'wer\\s+hat\\s+(?:\\p{L}+\\s+){0,4}gewonnen', 'resultado\\s+del\\s+partido', 'résultats?\\s+(?:du\\s+match|des\\s+élections)', 'wahlergebnis(?:se)?']);
// "score", "fixtures" and "Ergebnis" are sports only next to a game: a z-score, a credit score, an F1 score, test fixtures are not (AC2)
const SPORTS_WORD = any(['scores?', 'fixtures?', 'ergebnis(?:se)?']);
const SPORTS_CTX = any(['games?', 'match(?:es)?', 'halftime', 'half-time', 'innings?', 'play-?offs?', 'league', 'cup', 'nba', 'nfl', 'mlb', 'nhl', 'mls', 'ufc', 'grand\\s+prix', 'super\\s+bowl', 'world\\s+series', 'tournament', 'vs\\.?', 'versus', 'last\\s+night', 'tonight', 'today', 'yesterday', 'live', 'partido', 'spiel', 'partie', 'liga', 'ligue']);
// "Lakers score", "Real Madrid result", "Champions League results": a short message that is a name and a result (AC2-6)
const SHORT_RESULT = /^(?!(?:what|how|is|are|why|who|when|where|which|my|your|our|the|a|an)\b)(?![\s\S]*\b(?:credit|test|exam|sat|act|gre|z|f1|t|fico|bleu|rouge|similarity|confidence|quality|my|our|your|the|a)\s+(?:score|result)s?\b)[\p{L}\p{N}'’&. -]{2,40}\s(?:score|scores|result|results)\s*\??$/iu;
const CURRENCY = '(?:euros?|dollars?|pounds?(?:\\s+sterling)?|yen|yuan|rupees?|pesos?|francs?|bitcoins?|usd|eur|gbp|jpy|chf|cad|aud|cny|inr|mxn|dólar(?:es)?|dollar)';
const MARKET = any([
  '(?:stock|share)\\s+price', '(?:stock|shares?)\\s+trading\\s+at', 'stock\\s+market\\s+(?:today|now|right\\s+now|this\\s+week|doing)', 'how\\s+is\\s+the\\s+stock\\s+market', 'exchange\\s+rate', 'market\\s+cap\\s+of', '(?<!(?:my|our|your|calculate|calculating)\\s)net\\s+worth',
  'price\\s+of\\s+(?:bitcoin|btc|ethereum|eth|solana|gold|silver|oil|crude|gas|a\\s+barrel)', '(?:bitcoin|btc|ethereum|eth|solana|dogecoin|xrp)\\s+(?:price|now|today|trading|worth)', '(?:gold|silver|oil|crude|gas|petrol|fuel|diesel)\\s+prices?\\s+(?:today|now|right\\s+now|this\\s+week|in\\b)',
  'how\\s+much\\s+is\\s+(?:\\d+\\s+)?(?:bitcoin|btc|ethereum|eth|solana|gold|a\\s+share)', `${CURRENCY}\\s*(?:to|in|into|\\/|vs\\.?|against|en|zum|gegen|contra|contre|face\\s+au)\\s*${CURRENCY}`, `how\\s+many\\s+${CURRENCY}\\s+(?:is|are|for|in)\\s+\\d[\\d,.]*`, `\\d[\\d,.]*\\s*(?:${CURRENCY}|€|\\$|£)\\s+(?:in|to|en)\\s+${CURRENCY}`,
  'price\\s+of\\s+[\\p{L}\\p{N}.&\\- ]{1,30}?\\s+(?:stock|shares?)', '[\\p{L}\\p{N}.&\\-]+\\s+(?:stock|shares?)\\s+(?:price|today|now|doing)', 'how\\s+(?:is|are)\\s+[\\p{L}\\p{N}.&\\- ]{1,30}?\\s+(?:stock|shares?)\\s+doing',
  '(?:what(?:\'s|’s|\\s+is|\\s+are)\\s+the\\s+|current\\s+)(?:\\p{L}+\\s+){0,2}?(?:inflation|unemployment|interest|mortgage|exchange|tax)\\s+rates?(?!\\s+(?:formula|equation|calculation|definition))',
  'precio\\s+de(?:l)?\\s+(?:bitcoin|oro|petróleo|dólar|euro)', 'cotización', 'cu[aá]nto\\s+(?:est[aá]|vale)\\s+el\\s+(?:d[oó]lar|euro)', 'cours\\s+(?:du|de\\s+l’?|de\\s+l\'?|de)\\s*(?:bitcoin|l’or|or|pétrole|dollar|euro|action)', 'prix\\s+du\\s+(?:bitcoin|pétrole|baril|or)', 'combien\\s+vaut\\s+(?:un|l[\'’])\\s*(?:euro|dollar)', 'aktienkurs', 'wechselkurs', 'bitcoin-?kurs',
]);
// "TSLA stock", "Apple shares"
const SHORT_STOCK = /^\$?[\p{L}.&-]{1,20}\s+(?:stock|shares?)\s*\??$/iu;
const OPEN = word("(?:is|are)\\s+[\\p{L}\\p{N}'’&.\\- ]{1,40}?\\s+(?:open|closed|available|in\\s+stock|sold\\s+out|down|up|cancel(?:l)?ed|delayed|postponed|suspended|on\\s+strike)(?!\\s+(?:source|to\\b|for\\b))(?:\\s+(?:now|today|tonight|right\\s+now|on\\s+\\p{L}+day|this\\s+\\p{L}+))?|(?:opening|business|store)\\s+hours|what\\s+time\\s+does\\s+[\\p{L}\\p{N}'’ ]{1,50}\\s+(?:open|close)|open\\s+now|horaires?\\s+d['’]ouverture|horario\\s+de\\s+apertura|öffnungszeiten|est-(?:il|elle)\\s+ouverte?|est[áa]\\s+abiert[oa]|(?:heute\\s+)?geöffnet");
// near me, or the nearest *place* (not the nearest integer, star or neighbour in an algorithm: AC2-5)
const NEAR = any([
  'near\\s+me', 'nearby', 'around\\s+here', 'cerca\\s+de\\s+m[ií]', 'près\\s+de\\s+moi', 'in\\s+der\\s+nähe',
  '(?:nearest|closest)\\s+(?:open\\s+)?(?:\\p{L}+\\s+){0,2}?(?:pharmac(?:y|ies)|hospital|restaurant|cafe|café|coffee|bar|gas|petrol|station|store|shop|supermarket|grocery|atm|bank|hotel|airport|parking|clinic|doctor|dentist|vet|gym|beach|post\\s+office|mall|cinema|theat(?:er|re)|museum|library|charger|subway|metro|train|bus|pizza|sushi|burger|mcdonald\'?s|starbucks|walmart|target|costco|ikea|apple\\s+store|urgent\\s+care|emergency\\s+room)s?',
]);
const RELEASE = any(['(?:release|launch|premiere|air)\\s+date', 'when\\s+(?:does|is|did|will|do)\\s+[\\p{L}\\p{N}\'’:&.\\- ]{1,50}?\\s+(?:come\\s+out|release[ds]?|launch(?:ed|es)?|premiere[ds]?|drop|start|air)', 'fecha\\s+de\\s+(?:lanzamiento|estreno)', 'date\\s+de\\s+sortie', 'erscheinungsdatum']);
const ROLE = '(?:ceo|president|prime\\s+minister|mayor|chancellor|governor|leader|coach|manager|owner|chair(?:man|woman)?|boss|head|king|queen|pope|secretary\\s+general)';
const CHANGED = any([
  'who\\s+(?:is|are|was)\\s+(?:the\\s+)?(?:current|new|latest|present|reigning)\\b', `who(?:\\s+is|'s|’s|\\s+runs|\\s+leads|\\s+heads)\\s+(?:the\\s+)?(?:current\\s+)?${ROLE}\\b`, `(?:ceo|president|prime\\s+minister|mayor)\\s+of\\b.*\\b(?:now|currently|today)`,
  `who(?:\\s+is|'s|’s)\\s+[\\p{L}\\p{N}&.\\- ]{1,30}?['’]s\\s+${ROLE}`, 'who\\s+(?:runs|owns|leads|heads|coaches|manages)\\s+(?!the\\s+(?:show|world)\\b)[\\p{L}\\p{N}&.\\- ]{1,30}?(?:\\s+(?:now|today|currently|these\\s+days))?\\s*\\??$',
  'what(?:’s|\'s|\\s+is|\\s+was)?\\s+(?:happening|going\\s+on)\\s+(?:with|in|at|to)(?!\\s+(?:my|our|me|us|you|your)\\b)', 'what\\s+happened\\s+(?:with|to|in|at|on|after)', 'any\\s+(?:news|updates?)\\s+(?:on|about|from)', 'has\\s+[\\p{L}\\p{N}\'’:&.\\- ]{1,40}?\\s+(?:been\\s+)?(?:released|announced|launched|updated|changed|shut\\s+down|come\\s+out)', 'is\\s+[\\p{L}\\p{N}\'’:&.\\- ]{1,40}?\\s+still\\s+(?:a\\s+thing|alive|around|available|supported|working)',
  'is\\s+[\\p{L}\\p{N}\'’:&.\\- ]{1,40}?\\s+(?:released|out\\s+yet|out\\s+now|available\\s+yet|launched)', 'did\\s+(?!(?:i|we|you|my|our)\\b)[\\p{L}\\p{N}\'’:&.\\- ]{1,40}?\\s+(?:release|announce|launch|unveil|cut|raise|hike|lower|resign|acquire|approve|ban|ship)\\b',
  '(?:when\\s+is|when[\'’]s)\\s+the\\s+next\\b', 'what[\'’]?s\\s+new\\s+(?:in|with|on|at)\\b', 'what\\s+is\\s+new\\s+(?:in|with|on|at)\\b', 'trending', 'going\\s+viral', 'current\\s+(?:events|affairs|interest\\s+rates?|mortgage\\s+rates?|rates|inflation|price|prices|version|release|president|prime\\s+minister|ceo|leader|champion|weather|temperature|polls?|standings|population)',
  '(?:latest|newest|current)\\s+(?:stable\\s+)?(?:version|release)\\s+of', 'what\\s+time\\s+is\\s+it\\s+(?:in|at)\\b', 'how\\s+much\\s+(?:does|do|is|are)\\s+(?:an?\\s+|the\\s+)?[\\p{L} -]{0,20}\\d[\\p{L}\\p{N} ]{0,12}\\s+(?:cost|costs)',
  'qué\\s+pasó\\s+con', 'que\\s+pasó\\s+con', 'que\\s+s’?est-il\\s+passé', 'was\\s+ist\\s+(?:mit|bei)\\s+[\\p{L}]+\\s+passiert',
  'qui\\s+est\\s+(?:le|la|l[\'’])\\s*(?:actuel(?:le)?\\s+)?(?:président(?:e)?|premier\\s+ministre|pdg|maire|chancelier|chancelière)', 'quelle\\s+heure\\s+est-il\\s+(?:à|au|en)',
  'qui[ée]n\\s+es\\s+(?:el|la)\\s+(?:actual\\s+)?(?:presidente?|presidenta|primer\\s+ministro|ceo|director|alcalde(?:sa)?)', 'qué\\s+hora\\s+es\\s+en',
  'wer\\s+ist\\s+(?:der|die|das)\\s+(?:aktuelle\\s+)?(?:präsident(?:in)?|bundeskanzler(?:in)?|kanzler(?:in)?|ceo|chef(?:in)?|bürgermeister(?:in)?|premierminister(?:in)?)', 'wie\\s+spät\\s+ist\\s+es\\s+in',
]);

// About code or the person's own things, not the world: "is the function still working", "who is the current owner of this
// variable", "when does the loop start", "is the server up", "is the door open" (AC2), "the weather forecast API in Python",
// "the nearest integer" (AC2-5). These rules don't fire then: OPEN, CHANGED, RELEASE, WEATHER, MARKET, NEAR, LOOKUP.
const CODE = any([
  'functions?', 'variables?', 'loops?', 'null', 'undefined', 'nil', 'compiler', 'regex', 'arrays?', 'pointers?', 'callbacks?', 'threads?', 'exceptions?', 'stack\\s+trace', 'localhost', 'unit\\s+tests?', 'borrow\\s+checker',
  'apis?', 'sdk', 'json', 'xml', 'csv', 'algorithms?', 'integers?', 'dataframes?', 'pandas', 'numpy', 'hash\\s+maps?', 'linked\\s+lists?', 'k-?nearest', 'kd-?tree', 'class(?:es)?\\s+(?:for|that|with)', 'my\\s+\\p{L}+\\s+(?:class|service|module|component)',
  'in\\s+(?:python|javascript|js|typescript|ts|java|rust|go|golang|swift|kotlin|c\\+\\+|c#|c|ruby|php|sql|bash|react|node(?:\\.js)?|excel|google\\s+sheets)\\b(?!\\s+\\d)',
  '(?:my|this|the|our|your)\\s+(?:\\p{L}+\\s+)?(?:code|script|program|app|server|function|repo|build|branch|pr|query|database|endpoint|container)',
]);
const MINE = word("(?:are|am)\\s+(?:you|we|i)(?=\\s)|(?:is|are)\\s+(?:my|our|your|this|that|these|those|the|it)\\s+(?:door|window|gate|lid|fridge|oven|light|server|port|file|connection|socket|app|site|website|page|program|process|service|loop|function|variable|code|branch|test|build|pr|ticket|issue|tab|modal|dialog|menu|meeting|call|appointment|class|exam|shoes?|shirt|dress|item|product)s?|(?:is|are)\\s+(?:it|this|that|these|those)\\s+(?:open|available|closed|down|up)\\b");
// The person's own life, plans and feelings: a day word there ("what should I cook tonight", "I've been tired lately",
// "Morgen habe ich eine Prüfung") is when, not news (AC2-5). Only the TIME/TODAY signal is muted by it.
const PERSONAL = any([
  '(?:should|can|could|shall|do|did|will|would|must|may)\\s+(?:i|we)', "i(?:'ve|’ve|'m|’m|'ll|’ll|\\s+have|\\s+am|\\s+was|\\s+feel|\\s+felt|\\s+need|\\s+want|\\s+can)", 'my', 'our', 'are\\s+you', 'help\\s+me', 'remind\\s+me', 'we\\s+discussed', 'a\\s+good', 'recipes?', 'ideas?', 'tips?', 'advice', 'suggestions?',
  'je', "j(?=['’])", 'mon', 'ma', 'mes', 'moi', 'nous', 'notre', 'yo', 'mi', 'mis', 'tengo', '(?:hago|debo|puedo|deber[ií]a)', '(?:devrais|dois|puis-je)', 'nosotros', 'nuestro', 'ich', 'mein(?:e[nmrs]?)?', 'mir', 'mich', 'wir', 'unser(?:e[nmrs]?)?',
]);
const HOWTO = /^\s*how\s+(?:do|can|should|would|could)\s+(?:i|you|we)\b|^\s*how\s+to\b/i;
// Words about words ("how to say tomorrow in Spanish", "what rhymes with tomorrow"), a joke about the news, definitions
const ABOUT_WORDS = any(['difference\\s+between', 'meaning\\s+of', 'synonyms?', 'antonyms?', 'rhymes?\\s+with', 'how\\s+(?:do\\s+you|to)\\s+say', 'spell', 'pronounce', 'definition\\s+of', 'what\\s+does\\s+\\S+\\s+mean', 'qu[ée]\\s+significa', 'que\\s+veut\\s+dire', 'was\\s+bedeutet', '(?:a|an)\\s+(?:\\p{L}+\\s+)?(?:joke|poem|haiku|limerick|riddle|song)']);
const DEFINITION = /^(?:what\s+(?:is|are)|what['’]s|define|explain)\s+(?:an?\s+)?(?:exchange\s+rates?|market\s+cap(?:italization)?|stock\s+market|stock\s+prices?|share\s+prices?|net\s+worth|inflation|interest\s+rates?|a\s+stock\s+split)\s*\??$/i;
// The past: "who won World War 2", "what happened in 1066", "what happened to the dinosaurs" (AC2-5); and calendar sums ("is 2027 a leap year")
const HISTORY = any(['world\\s+war(?:\\s+(?:i|ii|1|2|one|two))?', 'civil\\s+war', 'war\\s+of', 'battle\\s+of', 'revolution', 'dynasty', 'empire', 'ancient', 'medieval', 'dinosaurs?', 'century', '\\d{1,4}\\s*(?:bc|bce|ad)', '(?:in|of|since)\\s+(?:1\\d{3}|20[01]\\d|202[0-4])']);
const CALENDAR = any(['leap\\s+year', 'day\\s+of\\s+the\\s+week', 'how\\s+many\\s+days', 'what\\s+day\\s+(?:is|was|will)']);
// Things on the person's own calendar, not the world's: "when does the meeting start", "is the meeting still on"
const OWN_EVENT = any(['meeting', 'semester', 'class', 'lecture', 'exam', 'shift', 'appointment', 'party', 'wedding', 'interview', 'call', 'lesson', 'webinar', 'standup', 'stand-up']);
// About material in the message itself ("who won the argument in this dialogue"), not the world.
const GIVEN = any(['(?:in|from|of)\\s+(?:this|the\\s+following|the\\s+above|the\\s+below)\\s+(?:dialogue|conversation|story|text|passage|poem|essay|article|book|chapter|scene|excerpt|transcript|paragraph|sentence|example)', '(?:pasted|quoted)\\s+(?:below|above)']);
// Quoted words are what the message is about, not when it is: "what does \"morgen\" mean", "is this correct: \"I seen him yesterday\"" (AC2)
const QUOTED = /"[^"\n]{1,200}"|“[^”\n]{1,200}”|«[^»\n]{1,200}»|„[^“”\n]{1,200}[“”]|(?<![\p{L}])'[^'\n]{1,60}'(?![\p{L}])/gu;
const MATH = /\d\s*[-+*/×÷^]\s*\d/;
// news itself (not just "latest"): it outweighs a personal or code-sounding message
const NEWS = any(['news', 'breaking', 'headlines?', 'noticias', 'actualités', 'nachrichten', 'nouvelles']);
const NEWSY = any(['news', 'latest', 'breaking', 'headlines?', 'updates?', 'noticias', 'actualités', 'nachrichten']);

// Asks to make or change text, code or a plan: "the latest version of my essay" is not news, "help me build a weather app" is not the weather.
const MAKES = /^\s*(?:(?:please|pls|hey|ok(?:ay)?)[,!]?\s+)*(?:(?:can|could|would|will)\s+you\s+(?:please\s+)?)?(?:help\s+me\s+(?:to\s+)?|i\s+(?:need|want)\s+(?:you\s+)?to\s+)?(?:write|draft|compose|rewrite|rephrase|translate|proofread|edit|fix|refactor|debug|summari[sz]e|paraphrase|generate|create|make|code|implement|build|design|explain\s+how|reword|shorten|polish|improve|correct|redacta|escribe|traduce|reescribe|resume|corrige|écris|écrire|rédige[rz]?|traduis|résume[rz]?|corrige[rz]?|reformule[rz]?|schreib(?:e)?|übersetze|korrigiere|formuliere|fasse)\b/i;
// Edits text that happens to hold a link: the link is part of the text, not a page to read (AC2-4)
const EDITS = /^\s*(?:(?:please|pls)\s+)?(?:(?:can|could)\s+you\s+)?(?:proofread|rewrite|rephrase|edit|fix|correct|paraphrase|reword|shorten|polish|improve|check\s+(?:the\s+)?(?:grammar|spelling))\b/i;

/** Does this message need the web: explicit, or about now/news/prices/scores/weather/places/changed facts? */
export function needsCurrentInfo(text) {
  const raw = String(text || '');
  const t = raw.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ').trim();
  if (t.length < 4) return false;
  // Pasted material (a long email, an article to summarize): only an explicit ask at its start or end, or a link to read
  // at its start, makes it a search; the words inside it never do (AC2-4).
  if (t.length > 600) {
    const head = t.slice(0, 200), tail = t.slice(-200);
    return EXPLICIT.test(head) || EXPLICIT.test(tail) || (URL_RE.test(head) && !EDITS.test(t));
  }
  if (EXPLICIT.test(t)) return true; // "look it up", "search the web"
  if (URL_RE.test(t)) return !EDITS.test(t); // read this page, unless the message edits text that holds the link
  if (MAKES.test(t) || GIVEN.test(t)) return false; // write / fix / summarize / code: not a question about the world
  const q = t.replace(QUOTED, ' ');
  const code = CODE.test(q);
  // "look up the rent in Porto", not "how do I look up a value" or "find out why my script is slow"
  if (!code && LOOKUP.test(q) && !HOWTO.test(q) && !PERSONAL.test(q)) return true;
  if (ABOUT_WORDS.test(q) || DEFINITION.test(q)) return false;
  const past = HISTORY.test(q);
  // About code, an API, an algorithm (AC2-5): the weather, prices, places, opening hours and changed facts are about the world
  if (!code && (WEATHER.test(q) || MARKET.test(q) || SHORT_STOCK.test(q) || NEAR.test(q))) return true;
  if (!past && (SPORTS.test(q) || (SPORTS_WORD.test(q) && SPORTS_CTX.test(q)) || SHORT_RESULT.test(q))) return true;
  if (!code && !past && !MINE.test(q) && OPEN.test(q)) return true;
  if (!code && !past && !OWN_EVENT.test(q) && (RELEASE.test(q) || CHANGED.test(q))) return true;
  if (!code && YEAR.test(q) && /\?/.test(q) && !CALENDAR.test(q)) return true;
  const newsy = NEWSY.test(q);
  const timed = TIME.test(q) || TODAY.test(q);
  if (!timed || ((PERSONAL.test(q) || code) && !NEWS.test(q))) return false; // a day word in the person's own plans, or in code, is not news
  if (MATH.test(q) && !newsy) return false; // "what is 2+2 today?"
  // "today" or "latest" alone also appears in ordinary requests; with a question it is a request for fresh facts.
  // "give me / show me / tell me" + a day is a plan or ideas ("a workout plan for today"), unless it asks for news (AC2).
  return /\?\s*$/.test(q) || /^(?:what|who|when|where|which|how\s+(?:much|many)|is|are|did|does|do|has|have|any|qué|quién|cuándo|dónde|qui|quand|où|quel|was|wer|wann|wo)\b/i.test(q) || newsy;
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
 * The line over an auto-searched reply (render.js): 'Searching the web…' while it waits, 'Searched the web' once sources
 * came back, '' otherwise: the request failed or was stopped before a search (AC3), or the model answered without
 * searching (AC2-9: a routed search turn with no sources used to say it searched).
 */
export function searchLabel(node) {
  const n = node || {};
  if (!n.autoSearched || n.role !== 'assistant') return '';
  const sources = !!(n.citations && n.citations.length);
  if (n.streaming) return sources ? 'Searched the web' : 'Searching the web…';
  return sources ? 'Searched the web' : '';
}
