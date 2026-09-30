// The browser-ai feature in the app itself (the backend is jarvis.features.browser_ai; the
// window's side is web/features/browser_ai.js):
// - page-ai-preload.js in every tab of the built-in browser, which reads a page the way a
//   reader view does and says what the owner has selected;
// - the window's calls ('feature:browser-ai:call'), answered from the tabs: what's in front
//   (front), a page's address, title, selection and text (context), its article (extract),
//   and a look at the page on show (look: its context and a picture of it); and Chrome's
//   shortcuts for the dock (shortcut: find, bookmark, close), sent to the window's own handler
//   as main.js sends the page's.
// Only the window's own page may call; only the browser's tabs may answer.
'use strict';

const path = require('path');
const crypto = require('crypto');
const { session } = require('electron');

const PRELOAD = path.join(__dirname, '..', 'page-ai-preload.js');
const SHORTCUTS = new Set(['find', 'bookmark', 'close']); // the dock's ⌘F, ⌘D and ⌘W
const SHOT_WIDTH = 1280; // the widest picture Claude gets

function install(ctx) {
  const browser = ctx.browser;
  if (!browser) return; // an app without the browser hooks: nothing to add
  const { ipcMain } = ctx;
  session.fromPartition(browser.partition).registerPreloadScript({ type: 'frame', filePath: PRELOAD });

  const waiting = new Map(); // command id -> resolve
  const fromTab = (event) => browser.tabs().some((view) => !view.webContents.isDestroyed() && event.sender === view.webContents);

  ipcMain.on('page-ai:result', (event, message) => {
    if (!fromTab(event) || !message) return;
    const done = waiting.get(message.id);
    if (done) { waiting.delete(message.id); done(message.result); }
  });
  // What happens in a page that the window needs to know: how much is selected there.
  ipcMain.on('page-ai:event', (event, message) => {
    if (!fromTab(event) || !message || message.kind !== 'selection') return;
    const length = Math.max(0, Math.min(1000000, Number(message.length) || 0));
    ctx.send('feature:browser-ai:event', { kind: 'selection', tab: event.sender.id, length });
  });

  // A command to a tab's page-ai-preload.js, and its answer.
  function pageAi(view, action, args = {}, ms = 5000) {
    return new Promise((resolve) => {
      if (!view || view.webContents.isDestroyed()) { resolve({ ok: false, message: 'The tab is closed.' }); return; }
      const id = crypto.randomBytes(6).toString('hex');
      const timer = setTimeout(() => { waiting.delete(id); resolve({ ok: false, message: 'The page did not answer.' }); }, ms);
      waiting.set(id, (result) => { clearTimeout(timer); resolve(result || {}); });
      view.webContents.send('page-ai:command', { id, action, args });
    });
  }

  // The tab a call is for: the one it names, else the one on show.
  function target(args = {}) {
    if (args.tab !== undefined && args.tab !== null && args.tab !== '') return browser.byId(args.tab);
    return browser.shown();
  }

  const where = (view) => ({ tab: view.webContents.id, url: view.webContents.getURL(), title: view.webContents.getTitle() });

  async function picture(view) {
    try {
      const image = await view.webContents.capturePage();
      if (image.isEmpty()) return '';
      const { width } = image.getSize();
      return (width > SHOT_WIDTH ? image.resize({ width: SHOT_WIDTH }) : image).toPNG().toString('base64');
    } catch {
      return '';
    }
  }

  async function run(action, args = {}) {
    if (action === 'front') {
      const shown = browser.shown();
      return { ok: true, focused: browser.focused(), shown: Boolean(shown), tab: shown ? shown.webContents.id : null };
    }
    if (action === 'shortcut') {
      const name = String(args.name || '');
      if (!SHORTCUTS.has(name)) return { ok: false, message: `Unknown shortcut ${name}` };
      if (!browser.shown()) return { ok: false, message: 'The browser is closed.' };
      ctx.send('browser:shortcut', name);
      return { ok: true };
    }
    const view = target(args);
    if (!view) return { ok: false, message: args.tab ? `Tab ${args.tab} is closed.` : 'The browser is closed.' };
    if (!/^https?:/.test(view.webContents.getURL())) return { ok: false, message: 'There is no web page in that tab.', ...where(view) };
    switch (action) {
      case 'context': {
        const r = await pageAi(view, 'context', { text: Boolean(args.text), limit: Number(args.limit) || 0 });
        return { ...r, ...where(view) };
      }
      case 'extract': return { ...(await pageAi(view, 'extract', { limit: Number(args.limit) || 0 }, 8000)), ...where(view) };
      case 'look': { // ⌥⇧Space with the page in front: what it says, and a picture of it
        const r = await pageAi(view, 'context', { text: true, limit: Number(args.limit) || 0 });
        return { ...r, ...where(view), png: await picture(view) };
      }
      default: return { ok: false, message: `Unknown browser-ai call ${action}` };
    }
  }

  ipcMain.handle('feature:browser-ai:call', async (event, message) => {
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
