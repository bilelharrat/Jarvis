// Import chats (ROADMAP Q1): the three places chats come from, and which one a dropped file is.
// Pure (no DOM): import-chatgpt.js asks it after reading the zip's directory or the first item
// of a bare .json, so the person can drop any export on any tab and it still lands right.

import { looksLikeClaudeZip, isClaudeChat } from './import-claude-model.js';
import { geminiActivityEntries, looksLikeActivity } from './import-gemini-model.js';

export const SOURCES = {
  chatgpt: { label: 'ChatGPT', file: 'the .zip from ChatGPT', steps: [['In ChatGPT, open ', 'Settings › Data controls › Export data', '.'], ['ChatGPT emails you a link. Download the .zip.'], ['Drop it below. (A bare conversations.json works too.)']] },
  claude: { label: 'Claude', file: 'the .zip from Claude', steps: [['In Claude, open ', 'Settings › Privacy › Export data', '.'], ['Claude emails you a link. Download the .zip.'], ['Drop it below. (A bare conversations.json works too.) Projects become folders; memories you can review.']] },
  gemini: { label: 'Gemini', file: 'the Takeout .zip, or MyActivity.json', steps: [['Open ', 'takeout.google.com', ', choose ', 'Deselect all', ', then tick ', 'My Activity', '.'], ['Under “All activity data included”, keep only ', 'Gemini Apps', ' (JSON is best; HTML works). Export, then download the .zip.'], ['Drop the .zip or its MyActivity.json below. Google doesn’t keep which prompts were one chat: prompts less than 30 minutes apart become one.']] },
};

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

/** Which source an imported conversation came from ('' for Eden's own). */
export const importSource = (c) => (c && (c.source === 'chatgpt' || c.source === 'claude' || c.source === 'gemini') ? c.source : '');
export const importLabel = (c) => { const s = importSource(c); return s ? SOURCES[s].label : ''; };
