// How accurate Eden Travel's checks are (site travel/accuracy.js): a "This was wrong" button on each check Eden made
// against a live source (in the proof drawer and a stop's detail), with what was actually true and an optional note;
// and the section "How accurate Eden's checks are": everyone's rates with their sample sizes, in the server's own plain
// sentences ("2 of 1,240 opening-hours checks reported wrong in October 2026"), and the person's own reports, which
// they can take back. Samples, the person's own figures (their booking, their estimate) and unanswered checks have no
// button: they aren't Eden's checks.
//
// travel.js hands it its state and helpers through init, like travel-more.js: { S, paint, kicker, dayLong }.

import { el, ico, toast } from './util.js';
import { tripPost } from './trip-ui.js';

let C = null;
export function init(ctx) { C = ctx; }

const err = (e) => toast(String((e && e.message) || e));
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');
const NAMES = { hours: 'Hours', travel: 'Getting there', price: 'Price', access: 'Step-free entrance', window: 'Booking window' };
// the sources whose checks are Eden's (accuracy.js SOURCES)
const LIVE = new Set(['Google Maps (Places API)', 'Google Maps (Routes API)', 'The venue’s own website']);
export const reportable = (b) => Boolean(b && ['ok', 'look', 'warn'].includes(b.status) && LIVE.has(b.source));
const st = () => C.S.acc || (C.S.acc = { open: null, sending: false, done: new Set(), data: null, loading: false });

/** "This was wrong" for one check of a stop (kind: hours, travel, price, access, window), or its form while open. */
export function wrongButton(stopId, kind, badge) {
  const S = C.S;
  if (S.member || S.offline || !reportable(badge)) return null;
  const A = st();
  const key = `${stopId}:${kind}`;
  if (A.done.has(key)) return el('small', 'tv-fine', 'Reported. Thank you.');
  if (A.open !== key) {
    return el('button', { type: 'button', class: 'tv-btn quiet', 'data-k': `wrong:${key}`, 'aria-label': `${NAMES[kind]}: this was wrong`,
      onclick: (e) => { e.stopPropagation(); A.open = key; C.paint(); } }, 'This was wrong');
  }
  const actual = el('input', { class: 'tv-input', name: 'actual', maxlength: '200', placeholder: 'What was actually true? For example: closed when we got there', 'aria-label': 'What was actually true' });
  const note = el('input', { class: 'tv-input', name: 'note', maxlength: '300', placeholder: 'Anything else (optional)', 'aria-label': 'A note (optional)' });
  const send = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (A.sending) return;
    A.sending = true;
    try {
      await tripPost('check-report', { id: S.id, stop: stopId, check: kind, actual: actual.value, note: note.value });
      A.done.add(key);
      A.open = null;
      A.data = null; // the section loads again with this report in it
      toast('Reported. It counts toward Eden’s accuracy numbers.');
    } catch (x) { err(x); }
    A.sending = false;
    C.paint();
  };
  return el('form', { class: 'tv-wrong', style: { display: 'grid', gap: '6px', margin: '6px 0' }, 'data-k': `wrongform:${key}`, onsubmit: send, onclick: (e) => e.stopPropagation() },
    el('b', '', `${NAMES[kind]}: what Eden showed was wrong`),
    el('small', 'tv-fine', `Eden said: ${badge.text} (${badge.source}${badge.checked_at ? `, checked ${when(badge.checked_at)}` : ''})`),
    actual, note,
    el('small', 'tv-fine', 'Kept in your account with the check as Eden showed it. Only a count (no place, no name) goes into Eden’s accuracy numbers.'),
    el('div', 'tv-acts',
      el('button', { type: 'submit', class: 'tv-btn primary' }, 'Send'),
      el('button', { type: 'button', class: 'tv-btn quiet', onclick: (e) => { e.stopPropagation(); A.open = null; C.paint(); } }, 'Cancel')));
}

/** The section "How accurate Eden's checks are": everyone's rates and the person's own reports. Opened from
 *  travel.js's Trip tools menu, with a close button (onClose). */
export function accuracySection({ onClose } = {}) {
  const S = C.S;
  if (S.member) return null;
  const A = st();
  if (!A.data && !A.loading) {
    A.loading = true;
    tripPost('check-reports', {}).then((r) => { A.data = r; }, (e) => { A.data = { error: String((e && e.message) || e) }; }).then(() => { A.loading = false; C.paint(); });
  }
  const r = A.data;
  const head = [el('div', 'tv-card-head', el('span', 'tv-kicker accent', 'How accurate Eden’s checks are'),
      onClose ? el('button', { type: 'button', class: 'tv-x', 'aria-label': 'Close how accurate Eden’s checks are', 'data-k': 'close:acc', onclick: onClose }, ico('x', 14)) : null),
    el('p', 'tv-note', 'Every check Eden shows has its source and when it was checked. When one turns out wrong, tap “This was wrong” on it. These numbers count what people reported: not everyone reports, so the real rate can be higher. “Changed after Eden checked” means a later check found something different, such as new opening hours.')];
  if (!r) return el('section', { class: 'tv-disc glass-card tv-sheet', 'aria-label': 'How accurate Eden’s checks are' }, ...head, el('p', 'tv-note', 'Loading…'));
  if (r.error) return el('section', { class: 'tv-disc glass-card tv-sheet', 'aria-label': 'How accurate Eden’s checks are' }, ...head, el('p', 'tv-note', r.error));
  const rows = (r.global && r.global.rows) || [];
  const everyone = !r.global ? el('p', 'tv-note', 'The shared numbers didn’t load just now.')
    : !rows.length ? el('p', 'tv-note', 'No checks counted yet this month or last.')
    : el('ul', { class: 'tv-acc-rates', style: { listStyle: 'none', padding: '0', margin: '4px 0 10px', display: 'grid', gap: '4px' } }, ...rows.map((x) => el('li', x.source ? 'tv-fine' : '', x.text)));
  const mine = (r.reports || []).length
    ? el('ul', { class: 'tv-acc-mine', style: { listStyle: 'none', padding: '0', margin: '4px 0', display: 'grid', gap: '8px' } }, ...r.reports.map((x) => el('li', 'tv-check warn',
      el('i', ''),
      el('span', '', el('b', '', `${x.place.name} · ${NAMES[x.check] || x.check}`), ` · ${C.dayLong ? C.dayLong(x.date) : x.date}${x.trip_title ? ` · ${x.trip_title}` : ''}`),
      el('small', '', `Eden said: ${x.shown.text} (${x.shown.source}${x.shown.checked_at ? `, checked ${when(x.shown.checked_at)}` : ''})`),
      x.actual ? el('small', '', `What was true: ${x.actual}`) : null,
      x.note ? el('small', '', `“${x.note}”`) : null,
      el('small', '', `Reported ${when(new Date(x.at).toISOString())}`),
      el('button', { type: 'button', class: 'tv-btn quiet', style: { gridColumn: '2', justifySelf: 'start' }, 'data-k': `unreport:${x.id}`, onclick: async () => {
        try { await tripPost('check-unreport', { report: x.id }); A.done.delete(`${x.stop}:${x.check}`); A.data = null; } catch (e) { err(e); }
        C.paint();
      } }, 'Take back'))))
    : el('p', 'tv-note', 'You haven’t reported any checks as wrong.');
  return el('section', { class: 'tv-disc glass-card tv-sheet', 'aria-label': 'How accurate Eden’s checks are' }, ...head,
    el('b', '', 'Everyone using Eden Travel'), everyone,
    // the public page (site travel/accuracy-page.js): the last 12 months by kind and source, and how they're counted
    el('a', { class: 'tv-fine', href: '/travel/accuracy', target: '_blank', rel: 'noopener' }, 'The last 12 months, and how they’re counted'),
    el('b', '', 'Your reports'), mine);
}
