// The spreadsheet canvas's way in (ROADMAP Q15), kept tiny so the page doesn't load the grid,
// the formula engine or ExcelJS until a spreadsheet is opened: the command palette's entries,
// plain-chat Excel auto-detection, and "back from Google's consent for Sheets".

import { el, ico } from './util.js';
import { addSendExtra } from './api.js';
import { state, nodeText } from './state.js';
import { wantsSpreadsheet, SHEET_CREATE_SYSTEM, SHEET_SYSTEM, changeSetIn, proseOf } from './sheet-model.mjs';

let loadedMod = null;
const load = () => import('./sheet.js').then((m) => (loadedMod = m));

// Auto-detect spreadsheet / Excel generation requests in plain Chat so Eden builds a real interactive
// Excel workbook instead of dumping Python scripts or static text, OR edits the workbook currently open in the canvas.
addSendExtra((body) => {
  const c = state.convs.find((x) => x.id === body.chatId) || state.current;
  if (!c || c.kind === 'code' || c.mode === 'slides' || body.privacy || body.deck) return null;
  const last = (body.messages || []).at(-1) || {};
  const openCtx = loadedMod && typeof loadedMod.activeSheetTurnContext === 'function'
    ? loadedMod.activeSheetTurnContext(last.content || '')
    : null;
  const hasAttachedSheet = [
    ...(Array.isArray(last.attachments) ? last.attachments : []),
    ...(Array.isArray(body.context) ? body.context : []),
  ].some((a) => /\.(xlsx|xlsm|xls|csv|tsv)$/i.test(String((a && (a.name || a.title)) || '')) || /^Workbook “/m.test(String((a && a.text) || '')));
  if (openCtx || hasAttachedSheet) {
    const context = openCtx ? [...(body.context || []), openCtx] : body.context;
    return {
      system: [body.system, SHEET_SYSTEM, SHEET_CREATE_SYSTEM].filter(Boolean).join('\n\n'),
      ...(context ? { context } : {}),
    };
  }
  if (!wantsSpreadsheet(last.content)) return null;
  return {
    system: [body.system, SHEET_CREATE_SYSTEM].filter(Boolean).join('\n\n'),
  };
});

// When a chat reply finishes with a ```eden-sheet block, automatically open it in the spreadsheet canvas
addEventListener('eden:turn-done', (e) => {
  const { c, node } = e.detail || {};
  if (!c || !node || node.role !== 'assistant') return;
  const text = nodeText(node);
  if (!/```[ \t]*eden-sheet\b/.test(text)) return;
  const cs = changeSetIn(text);
  if (!cs || cs.invalid) return;
  if (c === state.current) {
    load().then((m) => m.openGeneratedSheet(cs)).catch(() => {});
  }
});

/** Render an inline Excel workbook card in the chat bubble when a reply contains a ```eden-sheet block. */
export function sheetPart(c, node, text) {
  const s = String(text || '');
  if (!/```[ \t]*eden-sheet\b/.test(s)) return { text: s, card: null };
  const cleanText = proseOf(s);
  const cs = changeSetIn(s);
  const streaming = Boolean(node && node.streaming && !/```[ \t]*eden-sheet[\s\S]*?```/.test(s));
  const title = (cs && typeof cs.title === 'string' && cs.title.trim()) || 'Excel Workbook';
  const sub = streaming
    ? 'Building Excel workbook & formulas…'
    : cs && cs.invalid
      ? 'The spreadsheet JSON was incomplete.'
      : (cs && cs.summary) || `${(cs && Array.isArray(cs.changes) ? cs.changes.length : 0)} operations · live formulas & .xlsx export`;
  const ready = !streaming && cs && !cs.invalid;
  const card = el('div', { class: `artlink sheet-link${cs && cs.invalid && !streaming ? ' bad' : ''}` },
    ico('chart'),
    el('div', 'grow', el('b', ready ? { 'data-no-i18n': '' } : {}, streaming ? 'Writing spreadsheet…' : title), el('span', '', sub)),
    ready ? el('button', { type: 'button', class: 'cap', onclick: () => load().then((m) => m.openGeneratedSheet(cs, { download: true })) }, ico('down', 13), '.xlsx') : null,
    ready ? el('button', { type: 'button', class: 'cap primary', onclick: () => load().then((m) => m.openGeneratedSheet(cs)) }, 'Open') : null,
  );
  return { text: cleanText, card };
}

export function sheetCommands() {
  return [
    { t: 'New spreadsheet', s: 'Canvas · formulas, charts, Eden edits', i: 'chart', run: () => load().then((m) => m.newSheetCanvas()) },
    { t: 'Open a spreadsheet…', s: 'Excel (.xlsx, .xls) or CSV from this computer', i: 'chart', run: () => load().then((m) => m.openUpload()) },
    { t: 'Open from Google Sheets…', s: 'Google Picker · only the file you pick', i: 'chart', run: () => load().then((m) => m.openGoogle()) },
    { t: 'Open a spreadsheet from your Mac…', s: 'Your Mac · Excel or CSV', i: 'chart', run: () => load().then((m) => m.openMacSearch()) },
  ];
}

/** Whether the Google sign-in that just came back was the one Sheets asked for (sheet-google.js RETURN_KEY). */
export function sheetReturnPending() {
  try { return !!sessionStorage.getItem('eden:sheet-return'); } catch { return false; }
}
export const resumeSheet = (ok) => load().then((m) => m.resumeAfterConnect(ok));
