// Eden Code's Browser pane, the app side beyond placing the page (main.js placeView): what
// the pane's toolbar and ⋯ menu ask of the tab on show, as the Claude desktop app's browser
// does it. main.js owns the tabs and the window and hands this module what it needs as hooks
// (createPane); the pure parts are browser-pane-lib.js's (tests/web/code-browser.test.mjs).
// - Back's and Forward's long press: the tab's history as a native menu, a pick goes there.
// - The ⋯ menu: the window sends its rows (translated there), this shows them natively and
//   answers with the one picked ('' when none), so the window acts on it.
// - Developer tools docked in the pane (a view of their own under the page, at the rect the
//   pane gives: setDevToolsWebContents) or in a window of their own. Docked ones follow the
//   tab on show: another tab's open in their place.
// - Light and dark for testing: the page's prefers-color-scheme set over the DevTools
//   protocol (the agent's own connection to the tab, browser-agent.js emulateScheme), kept as
//   tabs change and pages load, and let go when set back to the system's.
// - A screenshot of the page: saved to Downloads, copied, or handed back for the composer.
// - The page's source in a tab of its own (web pages only); save as PDF; print; a private tab.
// - The page's console and requests for the pane's drawer: the same the agent reads with
//   browser_console and browser_network (browser-agent.js), so the owner sees what it sees.
// Cost policy: nothing here calls a model.
'use strict';

const fs = require('fs');
const path = require('path');
const { Menu, WebContentsView, clipboard } = require('electron');
const lib = require('./browser-pane-lib');

function createPane(hooks) {
  const state = {
    devtools: '', // '' | 'docked' | 'detach'
    dt: null, // the docked DevTools' own view
    dtFor: null, // the tab they're for
    dtRect: null, // where the pane wants them (window content pixels), null: off
    dtShown: false,
    scheme: '', // '' (the system's) | 'light' | 'dark'
  };

  const wcOf = (view) => (view && view.webContents && !view.webContents.isDestroyed() ? view.webContents : null);

  // ── developer tools ──

  function closeDocked() {
    const { dt, dtFor } = state;
    state.dt = null;
    state.dtFor = null;
    if (dt) {
      const w = hooks.win();
      if (state.dtShown && w) { try { w.contentView.removeChildView(dt); } catch { /* gone */ } }
      state.dtShown = false;
      const wc = wcOf(dtFor);
      if (wc && wc.isDevToolsOpened()) wc.closeDevTools();
      try { if (!dt.webContents.isDestroyed()) dt.webContents.close(); } catch { /* gone */ }
    }
  }

  function openDocked(view) {
    const wc = wcOf(view);
    if (!wc) return false;
    if (wc.isDevToolsOpened()) wc.closeDevTools(); // (a detached window of its own: docked instead)
    const dt = new WebContentsView();
    wc.setDevToolsWebContents(dt.webContents);
    wc.openDevTools({ mode: 'detach', activate: false });
    state.dt = dt;
    state.dtFor = view;
    // Closed from inside (DevTools' own ×, or the page gone): the pane hears it.
    wc.once('devtools-closed', () => {
      if (state.dtFor !== view) return;
      closeDocked();
      if (state.devtools === 'docked') { state.devtools = ''; hooks.changed(); }
    });
    placeDocked(state.dtRect);
    return true;
  }

  // Where the pane wants the docked DevTools (null: off, while the pane is parked or closed).
  function placeDocked(rect) {
    state.dtRect = rect || null;
    const { dt } = state;
    const w = hooks.win();
    if (!dt || !w) return;
    if (rect && rect.width >= lib.MIN_SIDE && rect.height >= lib.MIN_SIDE) {
      if (!state.dtShown) { w.contentView.addChildView(dt); state.dtShown = true; }
      dt.setBounds(rect);
    } else if (state.dtShown) {
      w.contentView.removeChildView(dt);
      state.dtShown = false;
    }
  }

  function setDevtools(mode) {
    const view = hooks.active();
    const wc = wcOf(view);
    closeDocked();
    if (wc && wc.isDevToolsOpened()) wc.closeDevTools();
    state.devtools = '';
    if (!wc) return '';
    if (mode === 'docked') { if (openDocked(view)) state.devtools = 'docked'; } else if (mode === 'detach') {
      wc.openDevTools({ mode: 'detach' });
      state.devtools = 'detach';
      wc.once('devtools-closed', () => { if (state.devtools === 'detach') { state.devtools = ''; hooks.changed(); } });
    }
    return state.devtools;
  }

  // ── light and dark ──

  async function applyScheme(view, scheme = state.scheme) {
    const wc = wcOf(view);
    if (!wc || !hooks.agent || typeof hooks.agent.emulateScheme !== 'function') return { ok: false };
    try {
      await hooks.agent.emulateScheme(view, scheme);
      return { ok: true };
    } catch (err) {
      return { ok: false, message: String((err && err.message) || err) };
    }
  }

  // ── what the tab on show does next ──

  function selected(view) {
    if (state.devtools === 'docked' && state.dtFor !== view) { closeDocked(); openDocked(view); }
    if (state.devtools === 'detach') { state.devtools = ''; hooks.changed(); } // (that window is the other tab's)
    if (state.scheme) applyScheme(view);
  }

  function loaded(view) {
    if (state.scheme && view === hooks.active()) applyScheme(view);
  }

  // The pane closed: docked DevTools go with it (the tab's own stay theirs to close).
  function hidden() {
    placeDocked(null);
    closeMenu();
  }

  // ── a screenshot of the page ──

  async function screenshot(to) {
    const wc = wcOf(hooks.active());
    if (!wc || !wc.getURL()) return { ok: false, message: 'The browser is empty.' };
    let image;
    try { image = await wc.capturePage(); } catch { image = null; }
    if (!image || image.isEmpty()) return { ok: false, message: 'The page couldn’t be pictured just now. Try again once it’s on show.' };
    if (to === 'clipboard') { clipboard.writeImage(image); return { ok: true, to }; }
    if (to === 'attach') {
      const fit = image.getSize().width > 1600 ? image.resize({ width: 1600 }) : image;
      return { ok: true, to, png: fit.toPNG().toString('base64'), name: lib.shotName(wc.getURL()) };
    }
    const dir = hooks.downloads();
    const name = lib.shotName(wc.getURL());
    const ext = path.extname(name);
    let file = path.join(dir, name);
    for (let n = 1; fs.existsSync(file) && n < 1000; n += 1) file = path.join(dir, `${path.basename(name, ext)} (${n})${ext}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      await fs.promises.writeFile(file, image.toPNG());
    } catch (err) {
      return { ok: false, message: `The screenshot couldn’t be saved (${err.message}).` };
    }
    return { ok: true, to: 'file', path: file, name: path.basename(file) };
  }

  // ── the window's asks ──

  // One of the pane's menus at a time; the pane closing (or another menu) closes it.
  let openMenu = null;
  function closeMenu() {
    const m = openMenu;
    openMenu = null;
    const w = hooks.win();
    if (m && w) { try { m.closePopup(w); } catch { /* closed already */ } }
  }
  function show(template, x, y, done) {
    const w = hooks.win();
    if (!template.length || !w) { if (done) done(); return; }
    closeMenu();
    const m = Menu.buildFromTemplate(template);
    openMenu = m;
    m.popup({ window: w, x: Math.round(Number(x) || 0), y: Math.round(Number(y) || 0), callback: () => { if (openMenu === m) openMenu = null; if (done) done(); } });
  }
  function popup(template, x, y) { show(template, x, y); }

  function menu({ x, y, items } = {}) {
    return new Promise((resolve) => {
      let picked = '';
      const template = lib.menuTemplate(items, (id) => { picked = id; });
      // (a click's handler runs before the menu's close callback)
      show(template, x, y, () => setTimeout(() => resolve(picked), 0));
    });
  }

  async function act(msg = {}) {
    const view = hooks.active();
    const wc = wcOf(view);
    switch (msg.action) {
      case 'history': {
        if (!wc) return false;
        const nav = wc.navigationHistory;
        const items = lib.historyItems(nav.getAllEntries(), nav.getActiveIndex(), msg.dir === 'forward' ? 'forward' : 'back');
        popup(items.map((it) => ({ label: it.label, click: () => { if (!wc.isDestroyed()) nav.goToIndex(it.index); } })), msg.x, msg.y);
        return items.length > 0;
      }
      case 'menu': return menu(msg);
      case 'focus': if (wc) wc.focus(); return Boolean(wc);
      case 'close-menu': closeMenu(); return true;
      case 'source': {
        const url = wc ? lib.sourceUrl(wc.getURL()) : '';
        if (url) hooks.openRaw(url);
        return Boolean(url);
      }
      case 'pdf': if (wc && hooks.parity) await hooks.parity.savePage(wc); return Boolean(wc);
      case 'print': if (wc) wc.print(); return Boolean(wc);
      case 'private': if (hooks.parity) hooks.parity.newPrivate(); return true;
      case 'screenshot': return screenshot(String(msg.to || 'file'));
      case 'devtools': {
        const mode = msg.mode === 'docked' || msg.mode === 'detach' ? msg.mode : '';
        return setDevtools(msg.toggle && state.devtools ? '' : mode); // (the button: open docked, or close whichever is open)
      }
      case 'scheme': {
        const scheme = msg.value === 'light' || msg.value === 'dark' ? msg.value : '';
        state.scheme = scheme;
        // every tab told to go back to the system's; the one on show told what's wanted
        if (!scheme) for (const v of hooks.tabs()) if (hooks.agent && hooks.agent.schemeOf && hooks.agent.schemeOf(v)) applyScheme(v, '');
        return view ? applyScheme(view) : { ok: true };
      }
      case 'logs': {
        if (!view || !hooks.agent) return { ok: false, message: 'The browser is empty.' };
        try {
          return msg.kind === 'network' ? await hooks.agent.networkLog(view, { limit: 200 }) : await hooks.agent.consoleLog(view, { limit: 200 });
        } catch (err) {
          return { ok: false, message: String((err && err.message) || err) };
        }
      }
      default: return false;
    }
  }

  return {
    act, placeDocked, selected, loaded, hidden, setDevtools,
    info: () => ({ devtools: state.devtools, scheme: state.scheme }),
  };
}

module.exports = { createPane };
