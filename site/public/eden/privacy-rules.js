// Privacy mode's pure parts (no DOM, no imports; tested by src/__tests__/privacy.test.ts):
// the rules-only "sensitive" check that suggests privacy mode, and where a reply was computed.
//
// The check runs in this browser on the text being typed. It never sends the text anywhere to
// decide: it's a handful of patterns (passwords, secret keys, ID numbers, card and bank
// numbers with their checksums, first-person health details) and only ever suggests.

const PASSWORD = [
  /\b(?:pass(?:word|code|phrase)|passwd|pwd)\s*(?:is|was|=|:)\s*\S{3,}/i,
  /\bpin(?:\s+(?:code|number))?\s*(?:is|=|:)\s*\d{4,8}\b/i,
];
const SECRET = [
  /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|glpat-[A-Za-z0-9_-]{20,})/,
  /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/,
];
const ID = [
  /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/, // US social security number
  /\b[A-Z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/, // UK National Insurance number
  /\bpassport\b[^\n]{0,30}?\b(?=[A-Z0-9]*\d)[A-Z0-9]{6,9}\b/i,
  /\bdriv(?:er'?s|er’s|ing)\s+licen[cs]e\b[^\n]{0,30}?\b(?=[A-Z0-9]*\d)[A-Z0-9]{5,}\b/i,
];
const BANK = [
  /\bsort[- ]?code\b[^\n]{0,12}?\b\d{2}[- ]?\d{2}[- ]?\d{2}\b/i,
  /\b(?:account|acct)\s*(?:no\.?|number|#)\s*[:#]?\s*\d{6,12}\b/i,
  /\brouting\s*(?:no\.?|number|#)?\s*[:#]?\s*\d{9}\b/i,
];
const HEALTH =
  /\b(?:i|i'm|i’m|i've|i’ve|my)\b[^.!?\n]{0,60}?\b(?:diagnos\w*|prescri\w*|medications?|meds|symptoms?|therap(?:y|ist)|depress\w*|anxiety|panic attacks?|hiv|cancer|tumou?r|pregnan\w*|miscarr\w*|std|sti|blood (?:test|work)|biopsy|mri|surgery|disorder|dosage|mental health|chemo\w*|insulin|diabetes)\b/i;

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

function hasCard(text) {
  for (const m of text.matchAll(/\b(?:\d[ -]?){12,18}\d\b/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && !/^(\d)\1+$/.test(digits) && luhn(digits)) return true;
  }
  return false;
}

function ibanOk(raw) {
  const s = raw.replace(/\s+/g, '');
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rest = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}

function hasIban(text) {
  for (const m of text.matchAll(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g)) if (ibanOk(m[0])) return true;
  return false;
}

/** What in `text` looks sensitive: [{ kind, label }], in a fixed order, each kind once. */
export function detectSensitive(text) {
  const t = String(text || '');
  if (t.trim().length < 6) return [];
  const out = [];
  const add = (kind, label) => out.push({ kind, label });
  if (PASSWORD.some((r) => r.test(t))) add('password', 'a password');
  if (SECRET.some((r) => r.test(t))) add('secret key', 'a secret key');
  if (ID.some((r) => r.test(t))) add('ID number', 'an ID number');
  if (hasCard(t)) add('card number', 'a card number');
  if (hasIban(t) || BANK.some((r) => r.test(t))) add('bank details', 'bank details');
  if (HEALTH.test(t)) add('health details', 'health details');
  return out;
}

/** "a password and a card number" */
export function sensitiveSummary(hits) {
  const labels = (hits || []).map((h) => h.label);
  if (labels.length <= 1) return labels[0] || '';
  return `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

const CLOUDS = { anthropic: 'Anthropic cloud', openai: 'OpenAI cloud', gemini: 'Google cloud', kimi: 'Moonshot cloud' };

/**
 * Where a reply was computed, from its route: the server's `where` when it sent one (Eden on
 * the Mac does), else from the provider (askeden.com and older replies). null without a route.
 */
export function whereOf(route) {
  if (!route) return null;
  const w = route.where;
  // 'phone': the Eden iPhone app's on-device model (native.js), private like the Mac
  if (w && typeof w.label === 'string' && w.label) return { place: w.place === 'mac' || w.place === 'phone' ? w.place : 'cloud', label: w.label, detail: w.detail || null };
  if (route.provider === 'local') return { place: 'mac', label: 'On your Mac', detail: null };
  return { place: 'cloud', label: CLOUDS[route.provider] || 'Cloud', detail: null };
}
