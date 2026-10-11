// Essay turns (askeden ROADMAP T18): the page marks a turn made beside the open essay writer with
// `essay: { kind: 'write' | 'feedback' | 'rubric', words }` (words: the visible words the reply is
// expected to have). The message alone ("continue", "write the introduction", "make this more
// formal") reads as simple work, so the router picked the cheapest model and sized the reply for a
// line or two. On an essay turn, unless the person picked a model:
//
//   - the floor: only models with tier !== 'fast' and writing ≥ ESSAY_MIN_WRITING (no GPT-6 Luna,
//     Gemini 3.5 Flash-Lite, Claude Haiku or Kimi K2.7 Code); with none of those left, the pool as it was
//     and a note. Students' turns too (owner, 2026-10-10: "same floor for students"): their level
//     applies within it, and the autopilot's stages intersect it (cheapest floor model when nothing is left).
//   - task hints for the router: complexity complex (a full draft of 600+ words at level ≥ 4: expert),
//     the reply's tokens from its words, writing emphasized (feedback and rubric checks: analysis too).
//     The router bundle takes `hints` from the Model Router's browser.ts after the next sync-eden.
//   - no Gemini rating (it would only see "continue"), and room for the reply like a deck's.
//   - no after-reply fact checks: the reply is the student's essay, not claims to check.
//
// The same rules are Eden's on the Mac (askeden src/chat/essay-route.ts).

/** Writing score a model needs to write an essay turn (the registry's capabilities.writing, 0–100). */
export const ESSAY_MIN_WRITING = 90;
export const ESSAY_KINDS = ['write', 'feedback', 'rubric'];
const MIN_WORDS = 30;
const MAX_WORDS = 6000;
/** Expected words when the page doesn't say: a few paragraphs of a draft, a page of comments. */
const DEFAULT_WORDS = { write: 600, feedback: 500, rubric: 500 };
/** Reply room (output tokens, thinking included): a draft, by its words; comments, a fixed size. */
export const ESSAY_ROOM = { min: 4000, max: 16000, perWord: 1.6, thinking: 3000, review: 6000 };
/** Less room than this left on the allowance: the essay turn is refused, not cut off half-way. */
export const ESSAY_MIN_REPLY_TOKENS = 2500;
/** A full draft from this many words is expert work at level 4 and up. */
const EXPERT_WORDS = 600;
const EXPERT_LEVEL = 4;

export const ESSAY_NOTE = 'essay: routed as careful writing (fast models left out)';
export const ESSAY_NO_FLOOR_NOTE = 'essay: none of the models you can use here is a strong enough writer, so the usual ones were used';

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * The page's `essay`, checked: { kind, words } or null (not an essay turn). Lenient, so a newer page never breaks a
 * turn: `true` or an object with another kind is a 'write'; words outside 30–6000 are clamped, missing ones defaulted.
 */
export function essayOf(raw) {
  const e = raw && raw.essay;
  if (e === true) return { kind: 'write', words: DEFAULT_WORDS.write };
  if (!isObj(e)) return null;
  const kind = ESSAY_KINDS.includes(e.kind) ? e.kind : 'write';
  const n = Number(e.words);
  const words = Number.isFinite(n) && n > 0 ? Math.max(MIN_WORDS, Math.min(MAX_WORDS, Math.round(n))) : DEFAULT_WORDS[kind];
  return { kind, words };
}

/** The models strong enough to write an essay turn. */
export function essayFloor(models) {
  return (models || []).filter((m) => m && m.tier !== 'fast' && ((m.capabilities && m.capabilities.writing) || 0) >= ESSAY_MIN_WRITING);
}

/** The pool for an essay turn: the floor, or (none of it here) the pool as it was, with the route note either way. */
export function essayPool(cfg, essay) {
  if (!essay) return { cfg, note: null, floored: false };
  const floor = essayFloor(cfg.models);
  if (!floor.length) return { cfg, note: ESSAY_NO_FLOOR_NOTE, floored: false };
  return { cfg: floor.length === cfg.models.length ? cfg : { ...cfg, models: floor }, note: ESSAY_NOTE, floored: true };
}

/** The reply's visible tokens, from its words. */
export const essayOutputTokens = (essay) => Math.ceil(essay.words * 1.4) + 80;

/** The Model Router's task hints for an essay turn at this optimization level (1–5). */
export function essayHints(essay, level = 3) {
  if (!essay) return undefined;
  const write = essay.kind === 'write';
  return {
    complexity: write && essay.words >= EXPERT_WORDS && Number(level) >= EXPERT_LEVEL ? 'expert' : 'complex',
    outputTokens: essayOutputTokens(essay),
    emphasize: write ? { writing: 2 } : { writing: 1.5, analysis: 1.5 },
  };
}

/** Output room for an essay turn (thinking included), within `cap` (the server's maxTokens, the model's max output). */
export function essayRoom(essay, cap = Infinity) {
  const room = essay.kind === 'write'
    ? Math.min(ESSAY_ROOM.max, Math.max(ESSAY_ROOM.min, Math.ceil(essay.words * ESSAY_ROOM.perWord) + ESSAY_ROOM.thinking))
    : ESSAY_ROOM.review;
  return Math.max(1, Math.min(room, cap));
}

/** The model the autopilot's last stage leaves on an essay turn: the floor's cheapest to write with (output, then input price). */
export function cheapestWriter(models, rates) {
  return [...(models || [])].sort((a, b) => rates(a)[1] - rates(b)[1] || rates(a)[0] - rates(b)[0])[0] || null;
}

// Eden's changes to the essay, and its action cards, come in the reply as tool blocks: <eden-tool>{…}</eden-tool>
// (JSON) and <eden-essay where="…">…</eden-essay>, <eden-essay-edit>, <eden-essay-title>, <eden-essay-source>. Any
// check that reads a reply as prose leaves them out (and an unfinished one at the end).
export const TOOL_BLOCK_TAG = /<eden-(?:tool|essay(?:-[a-z]+)?)\b/;
const TOOL_BLOCKS = /<eden-(?:tool|essay(?:-[a-z]+)?)\b[\s\S]*?<\/eden-(?:tool|essay(?:-[a-z]+)?)\s*>/g;
const UNFINISHED_BLOCK = /<eden-(?:tool|essay(?:-[a-z]+)?)\b[\s\S]*$/;

/** The reply without its tool and essay blocks (prose only). */
export function withoutToolBlocks(text) {
  return String(text || '').replace(TOOL_BLOCKS, '').replace(UNFINISHED_BLOCK, '');
}
