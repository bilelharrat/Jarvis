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

// Asks to make or change text: "the latest version of my essay" is not news.
const MAKES = /^\s*(?:please\s+|can\s+you\s+|could\s+you\s+|pls\s+)?(?:write|draft|compose|rewrite|rephrase|translate|proofread|edit|fix|refactor|debug|summari[sz]e|paraphrase|generate|create|make|code|implement|explain\s+how|redacta|escribe|traduce|écris|écrire|traduis|schreib|übersetze)\b/i;

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
