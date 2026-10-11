// Import chats (ROADMAP Q1): the three places chats come from, and which one a dropped file is.
// Pure (no DOM): import-chatgpt.js asks it after reading the zip's directory or the first item
// of a bare .json, so the person can drop any export on any tab and it still lands right.

import { looksLikeClaudeZip, isClaudeChat } from './import-claude-model.js';
import { geminiActivityEntries, looksLikeActivity } from './import-gemini-model.js';

export { SOURCES, importSource, importLabel } from './import-label.js'; // names and steps: their own small module (app.js's sidebar)

/** The source a zip's file list is from, or '' when it isn't an export Eden knows. */
export function sourceOfZip(entries) {
  if (looksLikeClaudeZip(entries)) return 'claude';
  if (entries.some((e) => /(^|\/)conversations(-\d+)?\.json$/i.test(e.name))) return 'chatgpt'; // or Claude without its side files: sniffed from the first chat
  if (geminiActivityEntries(entries).length) return 'gemini';
  return '';
}

/** The source of a conversations.json or MyActivity.json from its first item (or the HTML page's text). */
export function sourceOfItem(first) {
  if (typeof first === 'string') return /<div class="outer-cell\b/.test(first) ? 'gemini' : '';
  if (isClaudeChat(first)) return 'claude';
  if (first && typeof first === 'object' && first.mapping) return 'chatgpt';
  if (looksLikeActivity(first)) return 'gemini';
  return '';
}
