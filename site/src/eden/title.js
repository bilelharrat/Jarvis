// Chat titles on askeden.com (askeden src/chat/title.ts is the Mac's, same logic): a cheap model names a chat
// from its first exchange, the way ChatGPT does. Gemma 4 31B on the Gemini API first (8.20/10 against Gemini
// 3.5 Flash-Lite's 8.33 in the 2026-11-16 bake-off, at $0.14/$0.40 per million tokens), Gemini 3.1 Flash-Lite
// when it fails, is empty or runs past 12 s. The owner's own Gemini key first; on the service's key it counts
// on the included AI, at cost.
//
//   POST /api/chat/title  { user: string, reply?: string }  → { title, model }

import { ApiError } from '../accounts/util.js';

export const TITLE_MODELS = ['gemma-4-31b-it', 'gemini-3.1-flash-lite'];
/** US dollars per million tokens (input, output), for metering on askeden.com. */
export const TITLE_USD_PER_MTOK = { 'gemma-4-31b-it': [0.14, 0.4], 'gemini-3.1-flash-lite': [0.25, 1.5] };
export const TITLE_TIMEOUT_MS = 12_000;
const MAX_USER = 2000;
const MAX_REPLY = 1200;

export const TITLE_SYSTEM =
  'You name chats in a chat app, the way ChatGPT does. Read the start of the chat and reply with only its title: ' +
  '2 to 6 words that say what the chat is about, specific enough to find it again in a list (the topic, not the request: ' +
  '"Fixing a useEffect loop", not "Help with code"). Sentence case, no quotes, no emoji, no full stop at the end. ' +
  'Write it in the language the person wrote in. If the message is only a greeting, use a short friendly title like "Greeting".';


/** The chat start a request may title: the first message (required) and the start of the reply. */
export function checkTitleInput(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  const user = typeof b.user === 'string' ? b.user.trim().slice(0, MAX_USER) : '';
  if (!user) throw new ApiError(400, 'bad_request', 'user must be the chat’s first message.');
  const reply = typeof b.reply === 'string' ? b.reply.trim().slice(0, MAX_REPLY) : '';
  return { user, reply };
}

/** A model's answer as a title: one line, no quotes or label, no full stop, at most 8 words / 60 characters. */
export function cleanTitle(raw) {
  let t = String(raw || '').replace(/<[^>]*>/g, ' ').split('\n').map((l) => l.trim()).find(Boolean) || '';
  t = t.replace(/^(title|titre|titel|título)\s*:\s*/i, '').replace(/^[#*\s"'“”‘’«»`]+|[*\s"'“”‘’«»`]+$/g, '').replace(/[.。]+$/, '').replace(/\s+/g, ' ').trim();
  const words = t.split(' ');
  if (words.length > 8) t = words.slice(0, 8).join(' ');
  if (t.length > 60) t = t.slice(0, 60).replace(/\s+\S*$/, '');
  return t;
}

function chatText(user, reply) {
  return reply ? `User: ${user}\n\nAssistant: ${reply}` : `User: ${user}`;
}

/** Asks one model; null when it fails, is empty or runs out of time. */
async function askModel(model, key, text, f) {
  const generationConfig = { maxOutputTokens: 400, temperature: 0.3 };
  if (model.startsWith('gemini-3')) generationConfig.thinkingConfig = { thinkingLevel: 'minimal' };
  const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(TITLE_TIMEOUT_MS) : undefined;
  try {
    const res = await f(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: TITLE_SYSTEM }] }, contents: [{ role: 'user', parts: [{ text }] }], generationConfig }),
      signal,
    });
    if (res.status < 200 || res.status >= 300) return null;
    const j = JSON.parse(await res.text());
    const parts = (j.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought);
    const title = cleanTitle(parts.map((p) => p.text || '').join(''));
    if (!title) return null;
    const u = j.usageMetadata || {};
    return { title, model, inTokens: Number(u.promptTokenCount) || 0, outTokens: (Number(u.candidatesTokenCount) || 0) + (Number(u.thoughtsTokenCount) || 0) };
  } catch {
    return null;
  }
}

/** The chat's title from its first exchange: Gemma 4 31B, else Gemini 3.1 Flash-Lite. */
export async function writeTitle(key, input, f = (u, i) => fetch(u, i)) {
  const text = chatText(input.user, input.reply);
  for (const model of TITLE_MODELS) {
    const r = await askModel(model, key, text, f);
    if (r) return r;
  }
  throw new ApiError(502, 'title_failed', 'No model could title this chat.');
}

/** What a title cost, in US dollars. */
export function titleUSD(r) {
  const [i, o] = TITLE_USD_PER_MTOK[r.model] || [0.25, 1.5];
  return (r.inTokens * i + r.outTokens * o) / 1e6;
}
