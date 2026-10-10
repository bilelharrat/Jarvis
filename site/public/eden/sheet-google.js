// Where a spreadsheet comes from and goes back to (ROADMAP Q15), for the canvas (sheet.js):
// Google Sheets with the non-sensitive drive.file scope (asked the first time Sheets is used; the
// Google Picker in its own popup picks the file), and the Mac's own files through Eden's server.
// Writes are calls the person's click makes after a review (confirm: true; askeden.com also mints
// an approval token for that exact call, api.js GUARDED).
//
// For other features (the slides work, Q14): driveUpload(file, { convertTo: 'slides' }) uploads a
// file to the person's Drive and converts it (a .pptx becomes Google Slides). Ask the person first:
// it writes to their Drive. It asks for drive.file when it isn't granted yet (a redirect to Google).

import { api, apiUrl, getJSON, postJSON } from './api.js';

const RETURN_KEY = 'eden:sheet-return';

export const sheetsCall = (action, args = {}) => postJSON('/api/chat/sheets', { action, args });
export const macFile = (body) => postJSON('/api/chat/sheets/file', body);

/** { connected, sheets, email, configured } from the Google status (sheets: drive.file granted). */
export async function sheetsStatus() {
  try { const s = await api.googleStatus(); return { configured: s.configured !== false, connected: !!s.connected || !!s.sheets, sheets: !!s.sheets, email: s.email || null }; }
  catch (e) { return { configured: false, connected: false, sheets: false, email: null, error: e.message }; }
}

/** Asks Google for drive.file (incremental: what was granted before stays). Leaves the page; `then` is what to reopen on return. */
export async function connectSheets(then = { open: 'picker' }) {
  try { sessionStorage.setItem(RETURN_KEY, JSON.stringify({ ...then, at: Date.now() })); } catch { /* private mode: no reopen */ }
  const r = await api.googleConnect('sheets');
  if (r && r.url) location.assign(r.url);
}

/** Back from Google: what to reopen, once (null when this sign-in wasn't for Sheets, or is over 15 minutes old). */
export function takeSheetReturn() {
  try {
    const raw = sessionStorage.getItem(RETURN_KEY);
    sessionStorage.removeItem(RETURN_KEY);
    const j = raw ? JSON.parse(raw) : null;
    return j && Date.now() - j.at < 15 * 60_000 ? j : null;
  } catch { return null; }
}
export function sheetReturnPending() { try { return !!sessionStorage.getItem(RETURN_KEY); } catch { return false; } }

/**
 * The Google Picker, in a popup of Eden's own (sheet-picker.html: its own CSP allows Google's Picker
 * script; this page's doesn't). Resolves { id, name, url } or null when the person closed it.
 */
export function pickGoogleFile(kind = 'sheets') {
  return new Promise((resolve, reject) => {
    const w = window.open(apiUrl(`/sheet-picker.html?kind=${encodeURIComponent(kind)}`), 'eden-google-picker', 'popup,width=820,height=620');
    if (!w) { reject(new Error('The browser blocked the Google Picker window. Allow pop-ups for Eden, then try again.')); return; }
    let done = false;
    const finish = (v, err) => { if (done) return; done = true; removeEventListener('message', on); clearInterval(poll); if (err) reject(err); else resolve(v); };
    const on = (e) => {
      if (e.source !== w || e.origin !== location.origin) return;
      const d = e.data || {};
      if (d.type !== 'eden-picker') return;
      if (d.error) finish(null, Object.assign(new Error(String(d.error)), { code: d.code }));
      else finish(d.id ? { id: String(d.id), name: String(d.name || ''), url: String(d.url || '') } : null);
    };
    addEventListener('message', on);
    const poll = setInterval(() => { if (w.closed) finish(null); }, 500);
  });
}

/** A Google Sheets link (or bare id) → its id; '' when it isn't one. */
export function sheetIdFrom(text) {
  const s = String(text || '').trim();
  const m = /\/spreadsheets\/d\/([A-Za-z0-9_-]{10,200})/.exec(s) || /^([A-Za-z0-9_-]{25,200})$/.exec(s);
  return m ? m[1] : '';
}

const toBase64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
export const bytesToBase64 = toBase64;
export function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const MIMES = { xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', pdf: 'application/pdf', xls: 'application/vnd.ms-excel' };

/**
 * Upload a file to the person's Google Drive, optionally converted to a Google format.
 * file: a File/Blob (with .name) or { name, bytes: Uint8Array, mime? }. opts.convertTo: 'sheets' | 'slides' | 'docs'.
 * → { id, name, mimeType, url }. Throws with .code 'scope'/'not_connected' when drive.file isn't
 * granted: call connectSheets({ open: … }) then. Only call it from the person's click after they
 * agreed (it writes to their Drive); the Activity timeline on the Mac lists it with Undo (trash).
 */
export async function driveUpload(file, { convertTo } = {}) {
  const name = String(file.name || 'file');
  const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(await file.arrayBuffer());
  const ext = name.toLowerCase().split('.').pop();
  const mime = file.mime || file.type || MIMES[ext] || '';
  try {
    return await sheetsCall('upload', { name, mime, data: toBase64(bytes), ...(convertTo ? { convertTo } : {}), confirm: true });
  } catch (e) {
    if (e.status === 403 || e.status === 409) e.code = e.status === 403 ? 'scope' : 'not_connected';
    throw e;
  }
}

export { getJSON };
