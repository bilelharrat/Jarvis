// The try-it tour (tour.js and its steps, tour-steps.js: about 70 KB) loads when it's used, not with the page
// (askeden opt2-ae-web). This small module stands in for it under the same names (initTour, startTour) and makes the
// page-load decisions tour.js's initTour made, reading the same progress (tour-model.js):
//
// - practice mode (?practice=1, the tour's sandbox), a first visit's welcome (shouldAutoStart) and the one offer to
//   pick up a tour left part-way: tour.js loads at once and its initTour runs them, as before;
// - otherwise only what initTour did on every load runs here (practice left for good: its leftovers go), and tour.js
//   loads on "Take the tour" (⌘K, Settings, Help, the first answer's card) or the iPhone app's hand-off
//   (eden:from-app, listened for here from page load, so one sent while tour.js loads isn't missed).
// Its "What's this?" buttons (WHATS_THIS_ON) are off; turning them on means loading tour.js at page load again.

import * as M from './tour-model.js';
import { PRACTICE, realStorage, resetPractice } from './practice.js';
import { IN_APP } from './native.js';
import { lazyModule } from './lazy-load.js';

let deferred = true; // tour.js loaded on first use (its initTour then skips the page-load decisions)
const tourMod = lazyModule('./tour.js', (m) => { m.initTour({ deferred, appEvents: false }); return m; }, { what: 'the tour' });
/** tour.js, loaded once and started (the tests wait on it). */
export const loadTour = () => tourMod();

/** Whether page load needs the tour now (the same rules tour.js's initTour follows). */
export function tourAtLoad(progress, { params = new URLSearchParams(location.search), inApp = IN_APP, webdriver = !!(typeof navigator !== 'undefined' && navigator.webdriver), practice = PRACTICE } = {}) {
  if (practice) return true;
  if (M.shouldAutoStart({ progress, params, inApp, webdriver })) return true;
  return Boolean(progress.active && !progress.resumeAsked && !inApp);
}

let inited = false;
export function initTour() {
  if (inited) return;
  inited = true;
  addEventListener('eden:from-app', (e) => {
    let m = e.detail;
    if (typeof m === 'string') { try { m = JSON.parse(m); } catch { return; } }
    if (!m || m.kind !== 'tour' || m.op !== 'start') return;
    tourMod().then((t) => t.enterPractice(t.appTourStart(m)), () => {});
  });
  const p = M.loadProgress(realStorage());
  if (tourAtLoad(p)) { deferred = false; tourMod().catch(() => {}); return; }
  if (!p.active) resetPractice(); // practice left for good: anything its page wrote while unloading goes too (tour.js did this at every load)
}

/** The tour's welcome (its chapters), loading the tour first. */
export function startTour(opts = {}) { return tourMod().then((m) => m.startTour(opts), () => {}); }
