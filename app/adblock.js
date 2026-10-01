'use strict';
// Cosmetic ad blocking for the built-in browser: what hides ads inside the page, as
// uBlock Origin does it, on Ghostery's engine (main.js does the network side).
//
// Ghostery's own Electron preload asks for a page's rules over async IPC and only in the
// top frame, so its scriptlets ran after the page's scripts (YouTube's player had already
// read its ads), ads showed before they were hidden, frames kept theirs, and procedural
// rules (:has-text, :upward, :xpath…) were never applied. Here, adblock-preload.js asks
// synchronously as each page and frame starts, so every scriptlet runs before the page's
// own scripts and the page's first paint has its hiding rules; procedural rules run in a
// world of their own, and ads added later are caught as they appear.

const fs = require('fs');
const path = require('path');
const { ipcMain } = require('electron');
const { parse } = require('tldts-experimental');

const PRELOAD = path.join(__dirname, 'adblock-preload.js');
// Ghostery's procedural-selector engine as one browser script (MPL-2.0, loaded unchanged).
const EXTENDED_LIB = path.join(
  path.dirname(require.resolve('@ghostery/adblocker-extended-selectors/package.json')),
  'dist', 'adblocker.umd.min.js',
);
let extendedLib = null;
function extendedSource() {
  if (extendedLib === null) {
    try { extendedLib = fs.readFileSync(EXTENDED_LIB, 'utf8'); } catch { extendedLib = ''; }
  }
  return extendedLib;
}

// The page a frame is in: a top frame's own address (the tab's may not have caught up
// with a navigation yet), a subframe's top page.
function pageOf(event, frameUrl) {
  const frame = event.senderFrame;
  if (!frame || frame.parent === null) return frameUrl;
  try { return (frame.top && frame.top.url) || event.sender.getURL(); } catch { return ''; }
}

const strings = (list, max) => (Array.isArray(list) ? list.filter((s) => typeof s === 'string' && s.length < 1000).slice(0, max) : []);

// ses: the browser's session. engine(): the current ElectronBlocker, or null while it's
// loading. shielded(pageUrl): whether blocking is on for that page (off on the Research
// Center, on sites the user allowed, and when switched off).
function attach(ses, { engine, shielded }) {
  ses.registerPreloadScript({ type: 'frame', filePath: PRELOAD });

  const rulesFor = (event, url) => {
    if (event.sender.session !== ses || typeof url !== 'string' || !/^https?:/.test(url)) return null;
    const blocker = engine();
    if (!blocker || !shielded(pageOf(event, url))) return null;
    const { hostname, domain } = parse(url);
    return { blocker, url, hostname: hostname || '', domain: domain || '', callerContext: { frameId: event.frameId, processId: event.processId } };
  };

  // As a page or frame starts: its scriptlets, its stylesheet (generic, the site's own,
  // the procedural rules' hiding attributes), and its procedural rules. (Setting
  // returnValue sends the answer, so it's set once, at the end.)
  const startRules = (event, url) => {
    const at = rulesFor(event, url);
    if (!at) return null;
    const { active, styles, scripts, extended } = at.blocker.getCosmeticsFilters({
      url: at.url, hostname: at.hostname, domain: at.domain, callerContext: at.callerContext,
      getBaseRules: true, getInjectionRules: true, getExtendedRules: true, getRulesFromHostname: true, getRulesFromDOM: false,
    });
    if (active === false) return null; // an exception switches cosmetics off here
    const procedural = extended || [];
    return {
      styles: styles || '',
      scripts: scripts || [],
      extended: procedural,
      lib: procedural.length ? extendedSource() : '',
      observe: at.blocker.config.enableMutationObserver !== false,
    };
  };
  ipcMain.on('jarvis-adblock:start', (event, url) => {
    let answer = null;
    try { answer = startRules(event, url); } catch (err) { console.error('adblock: no cosmetic rules for a page', err && err.message); }
    event.returnValue = answer;
  });

  // Classes, ids and links that appeared in the page: the generic rules that hide them.
  ipcMain.handle('jarvis-adblock:dom', (event, url, features) => {
    try {
      const at = rulesFor(event, url);
      if (!at || !features) return '';
      const { active, styles } = at.blocker.getCosmeticsFilters({
        url: at.url, hostname: at.hostname, domain: at.domain, callerContext: at.callerContext,
        classes: strings(features.classes, 5000), ids: strings(features.ids, 5000), hrefs: strings(features.hrefs, 2000),
        getBaseRules: false, getInjectionRules: false, getExtendedRules: false, getRulesFromHostname: false, getRulesFromDOM: true,
      });
      return active === false ? '' : styles || '';
    } catch (err) {
      console.error('adblock: no rules for new elements', err && err.message);
      return '';
    }
  });
}

module.exports = { attach, pageOf };
