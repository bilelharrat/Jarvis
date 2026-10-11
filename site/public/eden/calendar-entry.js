// The calendar's way in (efficiency pass 2), kept tiny so the page doesn't load calendar.js (and with
// it compose.js for its event emails, about 300 KB together) until the calendar opens: the sidebar,
// the palette, #calendar, Mail's "Add to calendar", the Brief, Eden's tools and Meetings call
// openCalendar here. calendar.js gets app.js's handlers when it first loads.

import { lazy, addStylesheet } from './util.js';

/** Set (sessionStorage) when a Google sign-in starts from the calendar: then it reopens, not Mail (calendar.js). */
export const RETURN_KEY = 'eden:cal:return';

let H = {};
// calendar.css too (it stood just before memory.css in index.html: put back there), loaded before the calendar shows
const mod = lazy(() => Promise.all([import('./calendar.js'), addStylesheet(new URL('./calendar.css', import.meta.url).href, 'calendar', 'link[href="memory.css"]')])
  .then(([m]) => { m.initCalendar(H); return m; }), [new URL('./calendar.js', import.meta.url).href]);
let loaded = null;

/** handlers: { addContext, openSettings } (app.js, at startup). */
export function initCalendar(handlers) {
  H = { ...H, ...handlers };
  // a Google sign-in that didn't finish: don't reopen the calendar on the next one (from Mail)
  if (/#gmail=error/.test(location.hash)) { try { sessionStorage.removeItem(RETURN_KEY); } catch { /* private mode */ } }
}

/** Opens the calendar (calendar.js openCalendar's options: { date, newEvent }). */
export function openCalendar(opts = {}) {
  return mod().then((m) => { loaded = m; m.openCalendar(opts); }, () => {});
}
/** Closes it when it's open (nothing to close before it ever loaded). */
export const closeCalendar = () => (loaded ? loaded.closeCalendar() : false);
export const calendarOpen = () => (loaded ? loaded.calendarOpen() : false);

/** True once after coming back from a Google sign-in started here (then the calendar reopens, not Mail). */
export function calendarReturnPending() {
  try { const v = sessionStorage.getItem(RETURN_KEY); sessionStorage.removeItem(RETURN_KEY); return v === '1'; } catch { return false; }
}
