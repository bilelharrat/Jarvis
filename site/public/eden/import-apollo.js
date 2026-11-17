// A conversation handed over from Eden Apollo (the browser app): its Ask Eden panel's "Open in Eden" opens
// askeden.com/#import-chat=<payload> (and its start page's Eden button, #prompt=<payload>: see below), payload = base64url (no padding) of UTF-8 JSON
//   { "v": 1, "source": "apollo", "title": string, "turns": [{ "role": "user" | "eden", "text": string }] }
// The #fragment never reaches the server (nothing is stored there). app.js calls openImportChat() on load and on
// hashchange: the payload is checked strictly, saved as a new chat like any other (state.js addConversation, so it
// is sealed and synced like any chat), and the fragment is cleared at once. Nothing is sent to a model; the texts
// are untrusted and go through the normal message renderer (markdown.js, sanitized).

import { newConversation, addNode, addConversation } from './state.js';

export const IMPORT_PREFIX = '#import-chat=';
export const MAX_TURNS = 200;
export const MAX_TEXT = 400_000; // all turns' text together, in characters
export const MAX_TITLE = 200;
const MAX_PAYLOAD = 3_000_000; // encoded: 400,000 characters at up to 3 UTF-8 bytes each, JSON-escaped, base64
export const FAILED = 'This conversation couldn’t be opened.';
export const OPENED = 'Opened from Eden Apollo';

/** The UTF-8 text of a base64url string (no padding), or null when it isn't one. */
function fromBase64url(s) {
  if (typeof s !== 'string' || !s || s.length > MAX_PAYLOAD || !/^[A-Za-z0-9_-]+$/.test(s) || s.length % 4 === 1) return null;
  try {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { return null; }
}

/** The JSON object after `prefix` in `hash`, if it is one with v 1 and source "apollo"; else null. */
function readPayload(hash, prefix) {
  if (typeof hash !== 'string' || !hash.startsWith(prefix)) return null;
  const json = fromBase64url(hash.slice(prefix.length));
  if (json == null) return null;
  let d;
  try { d = JSON.parse(json); } catch { return null; }
  return d && typeof d === 'object' && !Array.isArray(d) && d.v === 1 && d.source === 'apollo' ? d : null;
}

/**
 * The handed-over chat in `hash` ("#import-chat=<payload>"), checked: { title, turns: [{ role, text }] },
 * or null when anything is off (wrong v or source, 0 or over 200 turns, a role other than user/eden, an
 * empty text, over 400,000 characters in all). A title over 200 characters, or none, is the first user line.
 */
export function decodeImportChat(hash) {
  const d = readPayload(hash, IMPORT_PREFIX);
  if (!d) return null;
  const raw = d.turns;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_TURNS) return null;
  let total = 0;
  const turns = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object' || (t.role !== 'user' && t.role !== 'eden') || typeof t.text !== 'string' || !t.text.trim()) return null;
    total += t.text.length;
    if (total > MAX_TEXT) return null;
    turns.push({ role: t.role, text: t.text });
  }
  let title = typeof d.title === 'string' ? d.title.replace(/\s+/g, ' ').trim() : '';
  if (!title || title.length > MAX_TITLE) {
    const first = turns.find((t) => t.role === 'user');
    title = first ? first.text.trim().split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) : 'Chat from Eden Apollo';
  }
  return { title, turns };
}

/** A new Eden conversation (not yet saved) holding `data`'s turns: user turns as user messages, eden turns as replies. */
export function apolloConversation(data) {
  const c = newConversation();
  c.title = data.title;
  c.titleSet = true;
  c.source = 'apollo';
  let parent = null;
  for (const t of data.turns) {
    const node = t.role === 'user'
      ? { role: 'user', content: t.text, imported: true }
      : { role: 'assistant', parts: [{ type: 'text', text: t.text }], mode: 'chat', finish: 'stop', imported: true };
    parent = addNode(c, parent && parent.id, node);
  }
  return c;
}

/**
 * The page's address has a handed-over chat: clear the fragment at once, then save it as a new chat and
 * `open` it with a quiet `note`, or `note` that it couldn't be opened. → the new conversation, or null.
 * Does nothing (null) when the address isn't one.
 */
export function openImportChat({ open = () => {}, note = () => {} } = {}) {
  const hash = typeof location !== 'undefined' ? location.hash || '' : '';
  if (!hash.startsWith(IMPORT_PREFIX)) return null;
  try { history.replaceState(null, '', location.pathname + location.search); } catch { /* no history: nothing to clear */ }
  const data = decodeImportChat(hash);
  if (!data) { note(FAILED); return null; }
  const c = apolloConversation(data);
  addConversation(c);
  open(c);
  note(OPENED);
  return c;
}

/* ---------- #prompt=: a question typed on Apollo's start page, waiting in a new chat's composer ---------- */
// { "v": 1, "source": "apollo", "text": string, "temp"?: true }. `temp: true` (Apollo's Eclipse, private mode) opens it
// in the page's own temporary chat (app.js newTemp: never saved or synced). Never sent by itself: any page can link here, and an
// automatic send would spend the person's AI without them asking. They press Enter.

export const PROMPT_PREFIX = '#prompt=';
export const MAX_PROMPT = 2000;
// Apollo's own start page presses Enter for the person (Eden Apollo/ios/Sources/Ask/WebAsk.swift), so the note doesn't tell
// them to; from any other link the question waits in the composer, focused.
export const PROMPT_READY = 'Question from Eden Apollo';
export const PROMPT_READY_TEMP = 'Question from Eden Apollo (temporary chat, not saved)';
export const PROMPT_FAILED = 'This question couldn’t be opened.';

/** The prompt in `hash` ("#prompt=<payload>"): { text (trimmed, 1–2,000 characters), temp (only a boolean true) }; or null. */
export function decodePrompt(hash) {
  const d = readPayload(hash, PROMPT_PREFIX);
  if (!d || typeof d.text !== 'string') return null;
  const text = d.text.trim();
  return text && text.length <= MAX_PROMPT ? { text, temp: d.temp === true } : null;
}

/**
 * The address has a handed-over prompt: clear the fragment at once, then `start(temp)` a new empty chat (a
 * temporary one when `temp`) and `fill` its composer with the text (focused, caret at the end) and `note` how
 * to ask; or `note` it couldn't be opened. → { text, temp }, or null. Does nothing (null) when the address isn't one.
 */
export function openPrompt({ start = () => {}, fill = () => {}, note = () => {} } = {}) {
  const hash = typeof location !== 'undefined' ? location.hash || '' : '';
  if (!hash.startsWith(PROMPT_PREFIX)) return null;
  try { history.replaceState(null, '', location.pathname + location.search); } catch { /* no history: nothing to clear */ }
  const p = decodePrompt(hash);
  if (!p) { note(PROMPT_FAILED); return null; }
  start(p.temp);
  fill(p.text);
  note(p.temp ? PROMPT_READY_TEMP : PROMPT_READY);
  return p;
}
