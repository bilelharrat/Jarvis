// React (JSX/TSX) in the canvas as a live UI, and TypeScript compiled for the runner
// (canvas-model.js: what's React, the imports, "Fix it"). Code is compiled in this page with
// Sucrase (sucrase.min.mjs, MIT, loaded on first use), then drawn in app-frame.html: an
// opaque-origin sandbox with its own policy (no cookies, no storage, no way to Eden's page) whose
// only network is esm.sh for packages and cdn.jsdelivr.net for Tailwind. Each draw is a fresh
// frame (one loaded ahead, that has run nothing), so nothing from the last draw lingers.

import { el } from './util.js';
import { apiUrl } from './api.js';
import { appSource, fileName, rewriteImports, selfMounts, usesTailwind, watchLeave, LEFT_PAGE } from './canvas-model.js';

let sucrase = null;
const compiler = () => (sucrase ||= import('./sucrase.min.mjs').catch((e) => { sucrase = null; throw e; }));

/** JSX and/or TypeScript as plain module JavaScript; a syntax error throws with its line and column. */
export async function compile(code, { jsx = false, ts = false } = {}) {
  const { transform } = await compiler();
  const transforms = [...(jsx ? ['jsx'] : []), ...(ts ? ['typescript'] : [])];
  return transform(String(code), { transforms, jsxRuntime: 'automatic', production: true, disableESTransforms: true }).code;
}

let cur = null; // the frame on screen: { frame, on, msg, file }
// A spare frame loads behind the one on screen, ready for the next draw: these frames are opaque origins,
// which share no HTTP cache, so each fresh frame fetched React from esm.sh again (~0.3–0.75 s a draw).
// The spare has run no code (app-frame.html fetches React while it waits); a draw takes it as it is.
let spare = null; // { frame, box, ready }
const frameFor = (title) => el('iframe', { sandbox: 'allow-scripts allow-forms', src: apiUrl('/app-frame.html'), title: `Preview: ${title || 'app'}`, referrerpolicy: 'no-referrer' });
function addSpare(box) {
  const s = { frame: frameFor(''), box, ready: false };
  s.frame.setAttribute('aria-hidden', 'true');
  s.frame.tabIndex = -1;
  s.frame.style.cssText = 'position:absolute;inset:0;visibility:hidden;pointer-events:none';
  watchLeave(s.frame, () => { if (cur && cur.frame === s.frame) cur.on.log('warn', LEFT_PAGE); }); // its first load is now, so a leave is the second
  spare = s;
  box.append(s.frame);
}

/** A stack as the person reads it: their file's name for the compiled module (Sucrase keeps line numbers), React's own frames left out. */
const tidy = (text, file) => String(text).replace(/blob:null\/[\w-]+/g, file).split('\n').filter((l) => !/^\s+at .*https:\/\/esm\.sh\//.test(l)).join('\n');

window.addEventListener('message', (e) => {
  if (spare && e.source === spare.frame.contentWindow) { if (e.data && e.data.type === 'ready') spare.ready = true; return; }
  if (!cur || !cur.frame || e.source !== cur.frame.contentWindow) return;
  const d = e.data || {};
  if (d.type === 'ready' && cur.msg) { cur.frame.contentWindow.postMessage(cur.msg, '*'); cur.msg = null; }
  else if (d.type === 'log') cur.on.log(String(d.level || 'log'), tidy(d.text || '', cur.file));
  else if (d.type === 'error') cur.on.error(tidy(d.text || 'Error', cur.file));
  else if (d.type === 'rendered') cur.on.rendered();
});

/**
 * Draw React code in `box`: on = { log(level, text), error(text), rendered() }. A compile error is
 * reported through on.error and shown in the box, with no frame.
 */
export async function drawApp(box, { code, lang, title, theme }, on) {
  const mine = {};
  cur = mine; // a newer draw replaces this one, even mid-compile
  let js;
  try {
    const src = appSource(code);
    js = rewriteImports(await compile(src, { jsx: true, ts: lang === 'tsx' }));
    if (cur !== mine) return;
    Object.assign(mine, { on, file: fileName(title, lang), msg: { type: 'render', js, theme, tailwind: usesTailwind(code), mount: !selfMounts(src) } });
  } catch (e) {
    if (cur !== mine) return;
    cur = null;
    const text = `Couldn’t compile: ${e.message}`;
    box.replaceChildren(el('pre', 'pv-fail', text));
    on.error(text);
    return;
  }
  const s = spare;
  spare = null;
  if (s && s.box === box && s.frame.parentNode === box) { // take the spare where it is (moving a frame reloads it)
    mine.frame = s.frame;
    mine.frame.removeAttribute('style');
    mine.frame.removeAttribute('aria-hidden');
    mine.frame.removeAttribute('tabindex');
    mine.frame.title = `Preview: ${title || 'app'}`;
    for (const c of [...box.childNodes]) if (c !== mine.frame) c.remove();
    if (s.ready) { mine.frame.contentWindow.postMessage(mine.msg, '*'); mine.msg = null; } // it said ready already
  } else {
    if (s) s.frame.remove();
    mine.frame = frameFor(title);
    watchLeave(mine.frame, () => { if (cur === mine) on.log('warn', LEFT_PAGE); }); // a form without preventDefault, a link: blocked, blank
    box.replaceChildren(mine.frame);
  }
  setTimeout(() => { if (cur === mine && !spare && mine.frame.parentNode === box) addSpare(box); }, 1000); // after this draw's own fetches
}

/** Switch the preview's light/dark without drawing it again. */
export function setAppTheme(theme) {
  if (cur && cur.frame && cur.frame.contentWindow) cur.frame.contentWindow.postMessage({ type: 'theme', theme }, '*');
}

/** Forget the frame (the canvas closed or shows something else), and the spare with it. */
export function dropApp() { cur = null; if (spare) { spare.frame.remove(); spare = null; } }
