// Pages made usable with a screen reader, the app's side (the backend is
// jarvis.features.page_a11y; the window's side is web/features/page_a11y.js):
// - page-a11y-preload.js in every tab of the built-in browser, which mends each page while
//   screen-reader mode is on (labels, headings and landmarks, cookie banners and overlays)
//   and says what's on it when asked;
// - the window says whether the fixes are wanted ('feature:page-a11y:mode': screen-reader
//   mode is on and Settings › Accessibility hasn't turned them off), and every tab hears it at
//   once; a page that loads asks (page-a11y:start). J.A.R.V.I.S. Daredevil starts with them on,
//   before the window has said, so its first page is mended too;
// - the window's calls ('feature:page-a11y:call'): summary (what's on the page: the
//   page_summary tool) and stats (what was fixed), for the tab named or the one on show.
// Only the window's own page may call or set the mode; only the browser's tabs may answer.
'use strict';

const path = require('path');
const crypto = require('crypto');
const { session } = require('electron');

const PRELOAD = path.join(__dirname, '..', 'page-a11y-preload.js');

function install(ctx) {
  const browser = ctx.browser;
  if (!browser) return; // an app without the browser hooks: nothing to add
  const { ipcMain } = ctx;
  for (const partition of browser.partitions ? browser.partitions() : [browser.partition]) {
    session.fromPartition(partition).registerPreloadScript({ type: 'frame', filePath: PRELOAD });
  }

  let on = Boolean(ctx.flavor && ctx.flavor.edition === 'daredevil');
  const fromTab = (event) => browser.tabs().some((view) => !view.webContents.isDestroyed() && event.sender === view.webContents);

  // A page loading asks whether to mend it (every page of a tab is a new document). Anything
  // else (a page of the app's own, a popup window) is answered no.
  ipcMain.on('page-a11y:start', (event) => { event.returnValue = fromTab(event) ? on : false; });

  ipcMain.on('feature:page-a11y:mode', (event, want) => {
    if (!ctx.fromWindow(event)) return;
    const next = Boolean(want);
    if (next === on) return;
    on = next;
    for (const view of browser.tabs()) {
      if (!view.webContents.isDestroyed()) view.webContents.send('page-a11y:mode', on);
    }
  });

  const waiting = new Map(); // command id -> resolve
  ipcMain.on('page-a11y:result', (event, message) => {
    if (!fromTab(event) || !message) return;
    const done = waiting.get(message.id);
    if (done) { waiting.delete(message.id); done(message.result); }
  });

  function pageCall(view, action, args = {}, ms = 5000) {
    return new Promise((resolve) => {
      if (!view || view.webContents.isDestroyed()) { resolve({ ok: false, message: 'The tab is closed.' }); return; }
      const id = crypto.randomBytes(6).toString('hex');
      const timer = setTimeout(() => { waiting.delete(id); resolve({ ok: false, message: 'The page did not answer.' }); }, ms);
      waiting.set(id, (result) => { clearTimeout(timer); resolve(result || {}); });
      view.webContents.send('page-a11y:command', { id, action, args });
    });
  }

  // The tab a call is for: the one it names, else the one on show, else the first with a page.
  function target(args = {}) {
    if (args.tab !== undefined && args.tab !== null && args.tab !== '') return browser.byId(args.tab);
    return browser.shown() || browser.tabs().find((view) => !view.webContents.isDestroyed() && /^https?:/.test(view.webContents.getURL())) || null;
  }

  async function run(action, args = {}) {
    if (action === 'mode') return { ok: true, on };
    const view = target(args);
    if (!view) return { ok: false, message: args.tab ? `Tab ${args.tab} is closed.` : 'No page is open in the browser.' };
    const wc = view.webContents;
    const where = { tab: wc.id, url: wc.getURL(), title: wc.getTitle() };
    if (!/^https?:/.test(wc.getURL())) return { ok: false, message: 'There is no web page in that tab.', ...where };
    switch (action) {
      case 'summary': return { ...where, ...(await pageCall(view, 'summary', { limit: Number(args.limit) || 0 })) };
      case 'stats': return { ...where, ...(await pageCall(view, 'stats', {}, 3000)) };
      default: return { ok: false, message: `Unknown page-a11y call ${action}` };
    }
  }

  ipcMain.handle('feature:page-a11y:call', async (event, message) => {
    if (!ctx.fromWindow(event)) return { ok: false, message: 'not allowed' };
    const { action, args } = message || {};
    try {
      return await run(String(action || ''), args && typeof args === 'object' ? args : {});
    } catch (err) {
      return { ok: false, message: String(err && err.message ? err.message : err) };
    }
  });
}

module.exports = { install };
