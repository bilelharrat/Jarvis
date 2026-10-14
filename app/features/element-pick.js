// Click an element to send it (Eden Code's Pick mode: features/code_pick.py, the window's
// web/features/code-pick.js), the app's side:
// - element-pick-preload.js in every tab of the built-in browser, which outlines and takes
//   an element when asked, and reads the page's tree for the spoken way;
// - the window's calls: start (Pick mode in the tab, answered when an element is clicked or
//   Escape gives up), stop, tree, and capture {index} (an element of the last tree). What's
//   taken comes back with its picture, cut out of the tab here (capturePage).
// Trust (audit S29): only a tab showing a page on this Mac (localhost, 127.x, ::1,
// *.localhost: the session's own dev server) or a file the owner opened themselves (the tab's
// userFile, as browser-agent.js has it) is ever asked, and the tab's address is checked again
// once it answers. Only the window's own page may call; only the browser's tabs may answer.
'use strict';

const path = require('path');
const crypto = require('crypto');
const { session } = require('electron');
const { pickable, cropRect, NOT_HERE } = require('../element-pick-lib');

const PRELOAD = path.join(__dirname, '..', 'element-pick-preload.js');
const PICK_MS = 5 * 60 * 1000; // Pick mode gives up after this long
const CALL_MS = 6000;
const SHOT_WIDTH = 800;

function install(ctx) {
  const browser = ctx.browser;
  if (!browser) return; // an app without the browser hooks: nothing to add
  const { ipcMain } = ctx;
  for (const partition of browser.partitions ? browser.partitions() : [browser.partition]) {
    session.fromPartition(partition).registerPreloadScript({ type: 'frame', filePath: PRELOAD });
  }
  const fromTab = (event) => browser.tabs().some((view) => !view.webContents.isDestroyed() && event.sender === view.webContents);
  const allowed = (view) => Boolean(view && !view.webContents.isDestroyed() && pickable(view.webContents.getURL(), view.userFile));

  const waiting = new Map(); // command id -> resolve
  ipcMain.on('element-pick:result', (event, message) => {
    if (!fromTab(event) || !message) return;
    const done = waiting.get(message.id);
    if (done) { waiting.delete(message.id); done(message.result); }
  });

  function pageCall(view, action, args = {}, ms = CALL_MS) {
    return new Promise((resolve) => {
      if (!view || view.webContents.isDestroyed()) { resolve({ ok: false, message: 'The tab is closed.' }); return; }
      const id = crypto.randomBytes(6).toString('hex');
      const timer = setTimeout(() => { waiting.delete(id); resolve({ ok: false, message: 'The page did not answer.' }); }, ms);
      waiting.set(id, (result) => { clearTimeout(timer); resolve(result || {}); });
      view.webContents.send('element-pick:command', { id, action, args });
    });
  }

  // The tab a call is for: the one it names, else the one on show, else the newest tab with
  // a page on this Mac.
  function target(args = {}) {
    if (args.tab !== undefined && args.tab !== null && args.tab !== '') return browser.byId(args.tab);
    const shownView = browser.shown();
    if (allowed(shownView)) return shownView;
    return browser.tabs().slice().reverse().find(allowed) || shownView || null;
  }

  async function withPicture(view, result) {
    if (!result || !result.ok || !result.pick) return result || { ok: false };
    const wc = view.webContents;
    // The page may have gone elsewhere while it was asked: what it says is used only if
    // it is still where it was allowed to be.
    if (!allowed(view) || String(result.pick.url || '') !== wc.getURL()) return { ok: false, message: NOT_HERE };
    let png = '';
    try {
      const rect = cropRect(result.pick.box, wc.getZoomFactor(), view.getBounds());
      const image = await wc.capturePage(rect);
      if (image && !image.isEmpty()) png = (image.getSize().width > SHOT_WIDTH ? image.resize({ width: SHOT_WIDTH }) : image).toPNG().toString('base64');
    } catch (_) { png = ''; } // a tab not on show can't be pictured: the rest still goes
    return { ok: true, pick: { ...result.pick, url: wc.getURL(), title: wc.getTitle(), png } };
  }

  let picking = null; // the tab in Pick mode
  async function run(action, args = {}) {
    if (action === 'stop') return picking ? pageCall(picking, 'stop') : { ok: true };
    const view = target(args);
    if (!view) return { ok: false, message: 'No page is open in the browser.' };
    if (!allowed(view)) return { ok: false, message: NOT_HERE, url: view.webContents.getURL() };
    switch (action) {
      case 'start': {
        if (picking && picking !== view) await pageCall(picking, 'stop');
        picking = view;
        try {
          return await withPicture(view, await pageCall(view, 'start', {}, PICK_MS));
        } finally {
          if (picking === view) picking = null;
        }
      }
      case 'tree': {
        const result = await pageCall(view, 'tree');
        if (!result.ok || !allowed(view) || result.url !== view.webContents.getURL()) return result.ok ? { ok: false, message: NOT_HERE } : result;
        return { ...result, tab: view.webContents.id };
      }
      case 'capture': return withPicture(view, await pageCall(view, 'capture', { index: Number(args.index) }));
      default: return { ok: false, message: `Unknown element-pick call ${action}` };
    }
  }

  for (const action of ['start', 'stop', 'tree', 'capture']) {
    ipcMain.handle(`feature:element-pick:${action}`, async (event, args) => {
      if (!ctx.fromWindow(event)) return { ok: false, message: 'not allowed' };
      try {
        return await run(action, args && typeof args === 'object' ? args : {});
      } catch (err) {
        return { ok: false, message: String(err && err.message ? err.message : err) };
      }
    });
  }
}

module.exports = { install, pickable, cropRect, NOT_HERE };
