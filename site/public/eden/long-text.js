// Long text in the chat (bug sweep r1 AC4): what a collapsed long message lays out, and when a paste is
// big enough to go as a text attachment instead of into the composer. No DOM, no imports
// (src/__tests__/chat-long.test.ts loads it as the page serves it).

/** The most a collapsed message lays out: the clamp shows about a dozen lines, so the rest is never built until "Show all". */
export const CLAMP_CHARS = 3000;
export const CLAMP_LINES = 30;
/** A paste longer than this (characters) goes as "Pasted text.txt" rather than into the composer. */
export const BIG_PASTE = 100_000;

/** The start of `text` a collapsed bubble shows: at most CLAMP_LINES lines and CLAMP_CHARS characters, "…" when cut. */
export function clampedText(text) {
  const s = String(text || '');
  let end = Math.min(s.length, CLAMP_CHARS);
  let nl = -1;
  for (let k = 0; k < CLAMP_LINES; k++) { nl = s.indexOf('\n', nl + 1); if (nl < 0 || nl >= end) { nl = -1; break; } }
  if (nl >= 0) end = nl;
  return end >= s.length ? s : `${s.slice(0, end).replace(/[\uD800-\uDBFF]$/, '')}…`;
}

/**
 * A paste as an attachment: null when it fits the composer, else { text, cut } with at most `max` characters
 * (`cut`: the rest didn't fit and a note says so, as a long document's does).
 */
export function pasteAttachment(text, max) {
  const s = String(text || '');
  if (s.length <= BIG_PASTE) return null;
  if (s.length <= max) return { text: s, cut: false };
  const note = '\n\n[The rest of the pasted text wasn’t attached: it is longer than one message can carry. Paste a part of it, or attach that part on its own.]';
  return { text: s.slice(0, Math.max(0, max - note.length)).replace(/[\uD800-\uDBFF]$/, '') + note, cut: true };
}
