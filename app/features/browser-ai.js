// The browser-ai feature in the app itself (the backend is jarvis.features.browser_ai; the
// window's side is web/features/browser_ai.js):
// - page-ai-preload.js in every tab of the built-in browser, which reads a page the way a
//   reader view does and says what the owner has selected;
// - the window's calls ('feature:browser-ai:call'), answered from the tabs: what's in front
//   (front), a page's address, title, selection and text (context), its article (extract),
//   whether it needs the owner (handback: a captcha, a password, a code, a sign-in wall),
//   its own price (price: a page watcher's), the owner's clicks and typing recorded as steps
//   (record: on or off for a tab, and on again as each new page in it loads), whether what a
//   recorded step presses or types into is still on the page (probe: replay's check),
//   and a look at the page on show (look: its context and a picture of it); and Chrome's
//   shortcuts for the dock (shortcut: find, bookmark, close), sent to the window's own handler
//   as main.js sends the page's;
// - Ask Jarvis in the page's own menu, for a selection, a link or a picture: what the owner
//   picked goes to the window ('feature:browser-ai:ask'; the hub's menuask.py asks or saves),
//   the selection as it shows (read in the page, hidden text left out) and a picture of the
//   picture. The window gives the menu its words in the owner's language
//   ('feature:browser-ai:labels').
// Only the window's own page may call; only the browser's tabs may answer.
'use strict';

const path = require('path');
const crypto = require('crypto');
const { nativeImage, session } = require('electron');

const PRELOAD = path.join(__dirname, '..', 'page-ai-preload.js');
const SHORTCUTS = new Set(['find', 'bookmark', 'close']); // the dock's ⌘F, ⌘D and ⌘W
const SHOT_WIDTH = 1280; // the widest picture Claude gets

function install(ctx) {
  const browser = ctx.browser;
  if (!browser) return; // an app without the browser hooks: nothing to add
  const { ipcMain } = ctx;
  // Every profile a tab can be in (the owner's, private tabs', JARVIS's signed-out one): the
  // hand back, recording and the reader need it wherever JARVIS or the owner is.
  for (const partition of browser.partitions ? browser.partitions() : [browser.partition]) {
    session.fromPartition(partition).registerPreloadScript({ type: 'frame', filePath: PRELOAD });
  }

  const waiting = new Map(); // command id -> resolve
  const fromTab = (event) => browser.tabs().some((view) => !view.webContents.isDestroyed() && event.sender === view.webContents);

  ipcMain.on('page-ai:result', (event, message) => {
    if (!fromTab(event) || !message) return;
    const done = waiting.get(message.id);
    if (done) { waiting.delete(message.id); done(message.result); }
  });
  // What happens in a page that the window needs to know: how much is selected there, and
  // (only from the tab being recorded) the owner's steps.
  let recorded = null; // { view, ready } while a tab records (record and replay)
  ipcMain.on('page-ai:event', (event, message) => {
    if (!fromTab(event) || !message) return;
    if (message.kind === 'selection') {
      const length = Math.max(0, Math.min(1000000, Number(message.length) || 0));
      ctx.send('feature:browser-ai:event', { kind: 'selection', tab: event.sender.id, length });
    } else if (message.kind === 'step' && recorded && event.sender === recorded.view.webContents && message.step && typeof message.step === 'object') {
      ctx.send('feature:browser-ai:event', { kind: 'step', tab: event.sender.id, step: message.step });
    }
  });
  // Recording follows the tab from page to page: each new page is told to record too.
  function stopRecording() {
    if (!recorded) return;
    const { view, ready } = recorded;
    recorded = null;
    if (!view.webContents.isDestroyed()) {
      view.webContents.off('dom-ready', ready);
      pageAi(view, 'record', { on: false }, 2000);
    }
  }
  async function startRecording(view) {
    stopRecording();
    const ready = () => { if (recorded && recorded.view === view) pageAi(view, 'record', { on: true }, 2000); };
    recorded = { view, ready };
    view.webContents.on('dom-ready', ready);
    return pageAi(view, 'record', { on: true }, 3000);
  }

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
    if (action === 'record' && !args.on) { stopRecording(); return { ok: true }; } // wherever the tab is now
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
      case 'extract': return { ...where(view), ...(await pageAi(view, 'extract', { limit: Number(args.limit) || 0 }, 8000)) }; // the article's own title
      case 'handback': return { ...(await pageAi(view, 'handback', { codes: Boolean(args.codes) }, 3000)), ...where(view) };
      case 'price': return { ...where(view), ...(await pageAi(view, 'mainPrice', {}, 3000)) };
      case 'record': return { ...where(view), ...(await startRecording(view)) }; // (off: above)
      case 'probe': { // replay's check before a step: is what it presses or types into still here?
        const clip = (v, n) => String(v || '').slice(0, n);
        const step = { kind: clip(args.kind, 10), selector: clip(args.selector, 300), text: clip(args.text, 200), field: clip(args.field, 80) };
        return { ...where(view), ...(await pageAi(view, 'probe', step, 3000)) };
      }
      case 'look': { // ⌥⇧Space with the page in front: what it says, and a picture of it
        const r = await pageAi(view, 'context', { text: true, limit: Number(args.limit) || 0 });
        return { ...r, ...where(view), png: await picture(view) };
      }
      default: return { ok: false, message: `Unknown browser-ai call ${action}` };
    }
  }

  // ── Ask Jarvis in the page's own menu ──
  const labels = {
    ask: 'Ask Jarvis', explain: 'Explain', summarize: 'Summarize', translate: 'Translate', reply: 'Draft a Reply',
    save: 'Save to Second Brain', link: 'Summarize the Linked Page', image: 'Explain This Picture',
  };
  ipcMain.on('feature:browser-ai:labels', (event, words) => {
    if (!ctx.fromWindow(event) || !words || typeof words !== 'object') return;
    for (const key of Object.keys(labels)) {
      if (typeof words[key] === 'string' && words[key].trim()) labels[key] = words[key].trim().slice(0, 80);
    }
  });

  // A picture of part of a page: as it's drawn on screen, or (a window that isn't drawn) as
  // the DevTools protocol draws it, on the debugger the agent may already have attached.
  // rect: the view's pixels; clip: the page's CSS pixels, from the top of the document.
  async function shot(view, rect, clip) {
    const wc = view.webContents;
    try {
      const image = await wc.capturePage(rect);
      if (!image.isEmpty()) return image;
    } catch { /* not drawn: see below */ }
    const dbg = wc.debugger;
    const mine = !dbg.isAttached();
    try {
      if (mine) dbg.attach('1.3');
      const r = await dbg.sendCommand('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 } });
      return nativeImage.createFromBuffer(Buffer.from(r.data, 'base64'));
    } catch {
      return null;
    } finally {
      if (mine && dbg.isAttached()) { try { dbg.detach(); } catch { /* gone */ } }
    }
  }

  // A picture on the page, as it shows there: the element under the pointer, its words, and
  // (capture) a picture of what of it is in view.
  async function pictureAt(view, p, capture) {
    const wc = view.webContents;
    const z = wc.getZoomFactor() || 1;
    const found = await pageAi(view, 'imageAt', { x: p.x / z, y: p.y / z }, 3000);
    if (!found || !found.ok || !found.box) return { png: '', alt: '' };
    const alt = found.alt || '';
    if (!capture) return { png: '', alt };
    const shown = view.getBounds();
    const left = Math.max(0, found.box.x);
    const top = Math.max(0, found.box.y);
    const right = Math.min(shown.width / z, found.box.x + found.box.width);
    const bottom = Math.min(shown.height / z, found.box.y + found.box.height);
    if (right - left < 4 || bottom - top < 4) return { png: '', alt };
    const rect = { x: Math.floor(left * z), y: Math.floor(top * z), width: Math.ceil((right - left) * z), height: Math.ceil((bottom - top) * z) };
    const scroll = found.scroll || { x: 0, y: 0 };
    const image = await shot(view, rect, { x: left + scroll.x, y: top + scroll.y, width: right - left, height: bottom - top });
    if (!image || image.isEmpty()) return { png: '', alt };
    const small = image.getSize().width > SHOT_WIDTH ? image.resize({ width: SHOT_WIDTH }) : image;
    return { png: small.toPNG().toString('base64'), alt };
  }

  async function askFromMenu(view, action, p, save = '') {
    const wc = view.webContents;
    if (wc.isDestroyed() || !/^https?:/.test(wc.getURL())) return;
    const msg = { action, save, url: wc.getURL(), title: wc.getTitle().slice(0, 300), tab: wc.id };
    if (action === 'link' || save === 'link') {
      msg.link = p.linkURL;
      msg.link_text = String(p.linkText || '').slice(0, 300);
    } else if (action === 'image' || save === 'image') {
      const picture = await pictureAt(view, p, action === 'image');
      msg.image = { src: p.srcURL, alt: String(picture.alt || '').slice(0, 300) };
      if (action === 'image') {
        if (!picture.png) return;
        msg.png = picture.png;
      }
    } else {
      const seen = await pageAi(view, 'context', {}); // the selection as it shows
      msg.selection = String((seen && seen.selection) || '').slice(0, 8000);
      if (!msg.selection) return;
    }
    ctx.send('feature:browser-ai:ask', msg);
  }

  if (browser.menu) {
    browser.menu((items, view, p) => {
      if (!browser.tabs().includes(view) || !/^https?:/.test(view.webContents.getURL())) return;
      const selected = !p.isEditable && String(p.selectionText || '').trim();
      const link = /^https?:/.test(p.linkURL || '') ? p.linkURL : '';
      const image = p.mediaType === 'image' && /^https?:/.test(p.srcURL || '') ? p.srcURL : '';
      const go = (action, save = '') => () => { askFromMenu(view, action, p, save).catch(() => {}); };
      let submenu = [];
      if (selected) {
        submenu = [
          { label: labels.explain, click: go('explain') }, { label: labels.summarize, click: go('summarize') },
          { label: labels.translate, click: go('translate') }, { label: labels.reply, click: go('reply') },
          { type: 'separator' }, { label: labels.save, click: go('save', 'selection') },
        ];
      } else if (image) {
        submenu = [{ label: labels.image, click: go('image') }, { type: 'separator' }, { label: labels.save, click: go('save', 'image') }];
      } else if (link) {
        submenu = [{ label: labels.link, click: go('link') }, { type: 'separator' }, { label: labels.save, click: go('save', 'link') }];
      }
      if (!submenu.length) return;
      if (items.length && items[items.length - 1].type !== 'separator') items.push({ type: 'separator' });
      items.push({ label: labels.ask, submenu });
    });
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
