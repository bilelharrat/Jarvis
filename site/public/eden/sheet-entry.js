// The spreadsheet canvas's way in (ROADMAP Q15), kept tiny so the page doesn't load the grid,
// the formula engine or ExcelJS until a spreadsheet is opened: the command palette's entries,
// and "back from Google's consent for Sheets" (app.js asks sheetReturnPending()).

const load = () => import('./sheet.js');

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
