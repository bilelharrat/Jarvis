// The Google Picker popup (ROADMAP Q15), opened by sheet-google.js pickGoogleFile(). It asks Eden's
// server for a short-lived access token limited to drive.file (never the refresh token), shows
// Google's Picker, and posts the picked file's id back to the Eden page that opened it (same origin
// only), then closes. Picking a file is what gives Eden access to it under drive.file.
// This page's CSP (sheet-routes.ts / site web.js SHEET_PICKER_CSP) allows apis.google.com; Eden's main page doesn't.

const msg = document.getElementById('msg');
// French when the page is in French (i18n.js translates this page; the Picker's own title goes through t)
const i18n = import('./i18n.js').catch(() => null);
const kind = new URLSearchParams(location.search).get('kind') === 'slides' ? 'slides' : 'sheets';
const opener = window.opener;
const tell = (data) => { if (opener && !opener.closed) opener.postMessage({ type: 'eden-picker', ...data }, location.origin); };
document.getElementById('close').addEventListener('click', () => { tell({}); window.close(); });
const fail = (text, code) => { msg.textContent = text; tell({ error: text, code }); };

async function token() {
  const root = location.pathname.replace(/[^/]*$/, '');
  const res = await fetch(`${root}api/chat/sheets`, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Jarvis-Chat': '1' }, body: JSON.stringify({ action: 'picker', args: {} }), credentials: 'same-origin' });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.error || `HTTP ${res.status}`), { code: j.code });
  return j;
}

function loadGapi() {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://apis.google.com/js/api.js';
    s.onload = () => window.gapi.load('picker', { callback: resolve, onerror: () => reject(new Error('The Google Picker didn’t load.')) });
    s.onerror = () => reject(new Error('The Google Picker didn’t load (no connection to apis.google.com?).'));
    document.head.append(s);
  });
}

(async () => {
  if (!opener) { msg.textContent = 'Open this from Eden.'; return; }
  let t;
  try { t = await token(); } catch (e) { fail(e.message, e.code); return; }
  try { await loadGapi(); } catch (e) { fail(e.message); return; }
  const g = window.google.picker;
  const T = ((await i18n) || {}).t || ((s) => s);
  const view = new g.DocsView(kind === 'slides' ? g.ViewId.PRESENTATIONS : g.ViewId.SPREADSHEETS).setIncludeFolders(true).setSelectFolderEnabled(false);
  const picker = new g.PickerBuilder()
    .addView(view)
    .setOAuthToken(t.token)
    .setDeveloperKey(t.apiKey)
    .setAppId(t.appId)
    .setOrigin(location.origin)
    .setTitle(T(kind === 'slides' ? 'Choose a presentation for Eden' : 'Choose a spreadsheet for Eden'))
    .setCallback((data) => {
      const action = data[g.Response.ACTION];
      if (action === g.Action.PICKED) {
        const doc = (data[g.Response.DOCUMENTS] || [])[0] || {};
        tell({ id: doc[g.Document.ID], name: doc[g.Document.NAME], url: doc[g.Document.URL] });
        window.close();
      } else if (action === g.Action.CANCEL) { tell({}); window.close(); }
    })
    .build();
  msg.textContent = 'Choose a file in the Google Picker.';
  picker.setVisible(true);
})();
