// Refusals (hosted Eden): after a reply finishes, a cheap check for "I can't help with that"
// (a short reply that opens with a refusal, in English and a few common languages), sorted by
// rules into three kinds, with no extra model call:
//
//   benign     an over-cautious "no" to an ordinary request (kill a process, a medical or
//              legal question, how an attack works): retried once on a capable model from
//              another provider (the page streams it as the reply's next draft), or, when the
//              user picked the model, a "Try another model" offer instead
//   copyright  song lyrics, whole chapters or articles, paywalled text: never retried
//   safety     harm, weapons, illegal acts, sexual content involving minors…: never retried
//
// The copyright and tone rules every model gets are in EDEN_IDENTITY (chat.js), so a different
// model is never a way around them.

const MAX_CHARS = 900; // a refusal is short; a long answer that declines one part isn't one
const HEAD_CHARS = 300; // and it says so up front

const REFUSAL = [
  /\bI(?:'m| am)?\s*(?:sorry|afraid)?,?\s*(?:but\s+)?I\s+(?:can(?:'|’)?t|cannot|can not|won(?:'|’)?t|will not|am not able to|(?:'|’)m not able to|am unable to|(?:'|’)m unable to)\s+(?:help|assist|provide|continue|do (?:that|this)|comply|share|give|write|create|generate|fulfil|fulfill|support|reproduce|answer|offer|engage|discuss|explain)/i,
  /\bI\s+(?:can(?:'|’)?t|cannot|won(?:'|’)?t)\s+(?:help|assist)\b/i,
  /\bI(?:'|’)?m\s+unable to\b|\bI am unable to\b/i,
  /\bsorry,?\s+(?:but\s+)?I\s+(?:can(?:'|’)?t|cannot|won(?:'|’)?t)\b/i,
  /\bI\s+(?:must|have to)\s+decline\b/i,
  /\bI(?:'|’)?m not (?:able|comfortable|allowed|permitted) to\b/i,
  /\bje ne (?:peux|suis pas en mesure de|vais pas)\b|\bd[ée]sol[ée],? (?:mais )?je ne peux\b/i, // fr
  /\bno puedo (?:ayudar|proporcionar|continuar|hacer|ofrecer|dar|compartir|cumplir)|\blo siento,? (?:pero )?no puedo\b/i, // es
  /\bich kann (?:dir |ihnen |dabei |das |hier |leider )*(?:nicht|keine)\b|\bes tut mir leid,? (?:aber )?ich kann\b/i, // de
  /\bnon posso (?:aiutar|fornir|continuar|far|condivider|dar)|\bmi dispiace,? (?:ma )?non posso\b/i, // it
  /\bn[ãa]o posso (?:ajudar|fornecer|continuar|fazer|compartilhar|dar)|\bdesculpe,? (?:mas )?n[ãa]o posso\b/i, // pt
  /لا (?:أستطيع|يمكنني)|عذرًا،? (?:لكن )?لا/, // ar
];

/** True for a short reply that opens with a refusal. */
export function isRefusal(text) {
  const t = String(text || '').trim();
  if (!t || t.length > MAX_CHARS) return false;
  const head = t.slice(0, HEAD_CHARS);
  return REFUSAL.some((re) => re.test(head));
}

// Asked for: harm to people, weapons, serious crime, sexual content involving minors, self-harm…
const SAFETY = [
  /\b(?:child|children|kid|kids|minor|minors|underage|under-age|preteen|teen(?:ager)?s?|\d{1,2}[- ]?(?:yo|year[- ]old))\b[^.?!]{0,60}\b(?:sex|sexual|nude|naked|explicit|porn|erotic)/i,
  /\b(?:sex|sexual|nude|naked|explicit|porn|erotic)\w*\b[^.?!]{0,60}\b(?:child|children|kid|kids|minor|minors|underage|preteen|\d{1,2}[- ]?(?:yo|year[- ]old))\b/i,
  /\b(?:kill|murder|hurt|poison|stab|shoot|kidnap|torture)\s+(?:someone|somebody|a (?:person|man|woman|child|kid)|people|my (?:wife|husband|boss|neighbou?r|partner|mother|father|mom|dad|ex)|him|her|them|myself)\b/i,
  /\b(?:suicide|kill myself|self[- ]harm|end my life|cut myself)\b/i,
  /\b(?:bomb|explosive|ied|pipe bomb|nerve agent|sarin|anthrax|ricin|bioweapon|chemical weapon|dirty bomb|napalm)\b/i,
  /\b(?:make|build|3d[- ]print|buy)\b[^.?!]{0,40}\b(?:gun|firearm|silencer|suppressor|ghost gun)\b/i,
  /\b(?:synthesi[sz]e|make|cook|produce)\b[^.?!]{0,40}\b(?:meth|methamphetamine|fentanyl|heroin|cocaine|lsd|mdma)\b/i,
  /\b(?:ransomware|keylogger|botnet|credential stuffing)\b|\bwrite (?:a |some )?(?:malware|virus|worm|trojan)\b/i,
  /\b(?:hack into|break into|steal|stalk|dox|doxx|blackmail|extort|launder|counterfeit|fake (?:id|passport))\b/i,
  /\b(?:terror|terrorist|mass shooting|genocide)\b/i,
];

// Asked for, or named in the refusal: lyrics, whole texts, paywalled articles.
const COPYRIGHT = [
  /\blyrics?\b|\bsong words\b|\bparoles?\b|\bletra\b|\bsongtext\b|\btesto della canzone\b/i,
  /\bcopyright(?:ed)?\b|\bpaywall(?:ed)?\b|\bverbatim\b/i,
  /\b(?:full|entire|whole|complete)\s+(?:text|chapter|book|article|script|transcript|poem|novel)\b/i,
  /\bchapter\s+\d+\b[^.?!]{0,40}\b(?:of|from)\b/i,
];

/** "safety" | "copyright" | "benign": why a model refused, by rules (the stricter reading wins). */
export function refusalKind(prompt, reply = '') {
  const p = String(prompt || '');
  if (SAFETY.some((re) => re.test(p))) return 'safety';
  if (COPYRIGHT.some((re) => re.test(p)) || COPYRIGHT.slice(0, 2).some((re) => re.test(String(reply || '')))) return 'copyright';
  return 'benign';
}

/**
 * What to do about a finished reply: null when it isn't a refusal; else { kind, action, model? }:
 * action "retry" (once, automatically), "offer" (the user picked the model: a button), or "none"
 * (copyright, safety, already a retry, or no other provider). `candidate()` gives the model to
 * try ({ model, effort, name, provider }, from another provider) or null.
 */
export function refusalPlan({ prompt, text, retried = false, pinned = false, candidate = () => null }) {
  if (!isRefusal(text)) return null;
  const kind = refusalKind(prompt, text);
  if (kind !== 'benign' || retried) return { kind, action: 'none' };
  const m = candidate();
  if (!m) return { kind, action: 'none' };
  return { kind, action: pinned ? 'offer' : 'retry', model: m.model, ...(m.effort ? { effort: m.effort } : {}), name: m.name, provider: m.provider };
}
