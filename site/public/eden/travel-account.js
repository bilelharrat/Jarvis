// Eden Travel's "Travel profile" (travel.js hands it its state and helpers through init): the traveller's
// frequent-flyer numbers (sent with a Duffel booking for the passenger of that name, on airlines the fare takes; the
// page only ever sees the last 4, site travel/loyalty.js), hotel loyalty numbers (programmes Duffel Stays lists, sent
// with a stay booking for the guest of that name when the quote earns with that programme), and "Watch my email for bookings" with what the watch found
// (site travel/mailwatch.js). A found booking is added only when the person presses Add; Eden reads the email again then.

import { el, ico, toast } from './util.js';
import { tripPost } from './trip-ui.js';

let C = null; // { S, paint, loadTrip }
export function init(ctx) { C = ctx; }

const err = (e) => toast(String((e && e.message) || e));
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

/** Loads what the panel shows (numbers, the watch, what it found); paints when done. */
export async function loadProfile() {
  const P = (C.S.profile ||= { open: false });
  P.busy = true;
  try {
    const [l, w, f] = await Promise.all([tripPost('loyalty', {}), tripPost('mailwatch-status', {}), tripPost('mail-found', {})]);
    Object.assign(P, { accounts: l.accounts || [], hotel: l.hotel_accounts || [], programmes: l.hotel_programmes || [], watch: w, found: f.candidates || [] });
  } catch (e) { err(e); }
  P.busy = false;
  C.paint();
}

/** The panel, or null while closed. */
export function profilePanel() {
  const S = C.S, P = S.profile;
  if (!P || !P.open || S.member) return null;
  return el('section', { class: 'glass-card tv-sheet tv-profile', 'aria-label': 'Travel profile' },
    el('div', 'tv-card-head', el('span', 'tv-kicker accent', ico('user', 12), 'Travel profile'),
      el('button', { type: 'button', class: 'tv-x', 'aria-label': 'Close the travel profile', 'data-k': 'close:profile', onclick: () => { P.open = false; C.paint(); } }, ico('x', 14))),
    P.busy && !P.watch ? el('p', 'tv-note', 'Loading…') : null,
    loyaltyBlock(P), hotelBlock(P), watchBlock(P));
}

/** Opens (and loads) the panel; travel.js calls it from its menu. */
export function openProfile() {
  const P = (C.S.profile ||= { open: false });
  P.open = true;
  C.paint();
  loadProfile();
}

/* ---------- frequent-flyer numbers ---------- */

function loyaltyBlock(P) {
  const list = P.accounts || [];
  const given = el('input', { type: 'text', placeholder: 'First name', 'aria-label': 'Passenger’s first name, as on the passport', autocomplete: 'given-name', maxlength: '60' });
  const family = el('input', { type: 'text', placeholder: 'Last name', 'aria-label': 'Passenger’s last name, as on the passport', autocomplete: 'family-name', maxlength: '60' });
  const airline = el('input', { type: 'text', placeholder: 'Airline code (BA)', 'aria-label': 'Airline’s two-character code', maxlength: '2', autocapitalize: 'characters', style: { flex: '0 1 130px' } });
  const number = el('input', { type: 'text', placeholder: 'Membership number', 'aria-label': 'Membership number', autocomplete: 'off', maxlength: '24' });
  const save = async (e) => {
    e.preventDefault();
    if (!given.value.trim() || !family.value.trim() || !airline.value.trim() || !number.value.trim()) return toast('Fill in the name, airline and number');
    try {
      keep(P, await tripPost('loyalty-save', { given_name: given.value, family_name: family.value, airline: airline.value, number: number.value, confirm: true }));
      toast('Saved'); C.paint();
    } catch (x) { err(x); }
  };
  return el('div', 'tv-prof-block',
    el('h3', '', 'Frequent-flyer numbers'),
    list.length ? el('ul', 'tv-cands', ...list.map((a) => el('li', 'tv-cand',
      el('div', '', el('b', '', `${a.airline} · ${a.number}`), el('span', 'tv-meta', `${a.given_name} ${a.family_name}`)),
      el('div', 'tv-acts', el('button', { type: 'button', class: 'tv-btn quiet', 'aria-label': `Remove ${a.airline} number for ${a.given_name} ${a.family_name}`, onclick: async () => {
        if (!confirm(`Remove the ${a.airline} number for ${a.given_name} ${a.family_name}?`)) return;
        try { keep(P, await tripPost('loyalty-delete', { id: a.id })); C.paint(); } catch (x) { err(x); }
      } }, 'Remove'))))) : el('p', 'tv-note', 'None saved yet.'),
    el('form', { class: 'tv-form', onsubmit: save }, given, family, airline, number, el('button', { type: 'submit', class: 'tv-btn primary' }, 'Save')),
    el('p', 'tv-fine', 'Use the name as on the passport. When that passenger books a flight here, Eden sends the number to the airline if the fare takes that programme. Only the last 4 digits show.'));
}

/* ---------- hotel loyalty numbers ---------- */

const keep = (P, r) => { P.accounts = r.accounts || []; P.hotel = r.hotel_accounts || []; P.programmes = r.hotel_programmes || P.programmes; };

function hotelBlock(P) {
  const list = P.hotel || [], progs = P.programmes || [];
  if (!progs.length && !list.length) return null; // the server's list of programmes Duffel takes isn't here yet
  const given = el('input', { type: 'text', placeholder: 'First name', 'aria-label': 'Guest’s first name', autocomplete: 'given-name', maxlength: '60' });
  const family = el('input', { type: 'text', placeholder: 'Last name', 'aria-label': 'Guest’s last name', autocomplete: 'family-name', maxlength: '60' });
  const prog = el('select', { 'aria-label': 'Hotel programme', style: { flex: '0 1 200px' } }, el('option', { value: '' }, 'Programme'), ...progs.map((p) => el('option', { value: p.code }, p.name)));
  const number = el('input', { type: 'text', placeholder: 'Membership number', 'aria-label': 'Hotel membership number', autocomplete: 'off', maxlength: '24' });
  const save = async (e) => {
    e.preventDefault();
    if (!given.value.trim() || !family.value.trim() || !prog.value || !number.value.trim()) return toast('Fill in the name, programme and number');
    try { keep(P, await tripPost('loyalty-save', { given_name: given.value, family_name: family.value, programme: prog.value, number: number.value, confirm: true })); toast('Saved'); C.paint(); } catch (x) { err(x); }
  };
  return el('div', 'tv-prof-block',
    el('h3', '', 'Hotel loyalty numbers'),
    list.length ? el('ul', 'tv-cands', ...list.map((a) => el('li', 'tv-cand',
      el('div', '', el('b', '', `${a.programme_name || a.programme} · ${a.number}`), el('span', 'tv-meta', `${a.given_name} ${a.family_name}`)),
      el('div', 'tv-acts', el('button', { type: 'button', class: 'tv-btn quiet', 'aria-label': `Remove ${a.programme_name || a.programme} number for ${a.given_name} ${a.family_name}`, onclick: async () => {
        if (!confirm(`Remove the ${a.programme_name || a.programme} number for ${a.given_name} ${a.family_name}?`)) return;
        try { keep(P, await tripPost('loyalty-delete', { id: a.id })); C.paint(); } catch (x) { err(x); }
      } }, 'Remove'))))) : el('p', 'tv-note', 'None saved yet.'),
    el('form', { class: 'tv-form', onsubmit: save }, given, family, prog, number, el('button', { type: 'submit', class: 'tv-btn primary' }, 'Save')),
    el('p', 'tv-fine', 'Only programmes Duffel Stays lists. When that guest books a hotel here and the rate earns with the programme, Eden sends the number to the hotel; the hotel decides whether to honour it. Only the last 4 digits show.'));
}

/* ---------- watching Eden Mail ---------- */

function watchBlock(P) {
  const w = P.watch;
  if (!w) return null;
  const sw = el('input', { type: 'checkbox', role: 'switch', id: 'tvMailWatch', checked: w.on ? '' : null, onchange: async (e) => {
    sw.disabled = true;
    try {
      P.watch = e.target.checked ? await tripPost('mailwatch-on', { confirm: true }) : { ...(await tripPost('mailwatch-off', {})), found: P.watch.found };
      if (P.watch.on) toast(P.watch.gmail && !P.watch.gmail.ok ? 'On. Gmail isn’t readable yet' : 'Eden will look every few hours');
    } catch (x) { err(x); }
    C.paint();
  } });
  const status = !w.on ? 'Off. Turn it on and Eden looks at new email every few hours.'
    : w.gmail && !w.gmail.ok ? w.gmail.problem
      : w.last ? `Last looked ${when(w.last.at)} (${w.last.scanned} email${w.last.scanned === 1 ? '' : 's'}).` : 'On. The first look is under way.';
  return el('div', 'tv-prof-block',
    el('h3', '', 'Bookings from your email'),
    el('label', { class: 'tv-row', for: 'tvMailWatch' }, sw, el('span', '', 'Watch my email for bookings')),
    el('p', { class: `tv-note${w.on && w.gmail && !w.gmail.ok ? ' warn' : ''}` }, status),
    foundList(P),
    el('p', 'tv-fine', 'Eden reads the booking details airlines and hotels put in their emails (Eden Mail, your Gmail) and keeps those that fall in one of your trips. Nothing is added until you press Add.'));
}

function foundList(P) {
  const list = P.found || [];
  if (!list.length) return null;
  return el('ul', 'tv-cands', ...list.map((c) => {
    const b = c.booking;
    const what = c.match.action === 'mark' ? 'Marks the matching stop booked' : `Adds it to Day ${c.match.day + 1} at ${c.match.at}`;
    return el('li', 'tv-cand',
      el('div', '', el('b', '', b.title || (b.place && b.place.name) || c.subject || 'Booking'),
        el('span', 'tv-meta', [c.trip_title, b.ref ? `Ref ${b.ref}` : null, b.date, b.at, b.provider].filter(Boolean).join(' · ')),
        el('small', '', `${c.from || ''} · “${c.subject || ''}” · found ${when(c.found_at)}`),
        el('span', 'tv-note', what)),
      el('div', 'tv-acts',
        el('button', { type: 'button', class: 'tv-btn primary', disabled: b.ref ? null : '', onclick: async () => {
          try {
            await tripPost('mail-import', { id: c.trip, source: 'mail', message: c.message, index: c.index, confirm: true });
            toast(`Added to ${c.trip_title}`);
            await tripPost('mailwatch-drop', { message: c.message, index: c.index }).catch(() => {});
            if (C.S.id === c.trip) C.loadTrip(c.trip, { keepDay: true });
            loadProfile();
          } catch (x) { err(x); }
        } }, 'Add'),
        el('button', { type: 'button', class: 'tv-btn quiet', onclick: async () => {
          try { await tripPost('mailwatch-drop', { message: c.message, index: c.index }); P.found = P.found.filter((x) => x !== c); C.paint(); } catch (x) { err(x); }
        } }, 'Dismiss')));
  }));
}
