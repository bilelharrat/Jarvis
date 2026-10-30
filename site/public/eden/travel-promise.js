// The Eden Price Promise on the Eden Travel page (site travel/promise.js, ops trip-promise*): every price Eden watches
// for the person across all trips (booked hotels, flights with "Watch the price" on), what was paid or seen, the lowest
// like-for-like price found with its source and time, the deadline, the money saved by rebooks done through Eden, the
// "Watch every flight I add" setting, and the guided hotel rebook: Check the price → Book the new rate → Cancel the old
// booking, one press per step, in that order only (the server refuses any other). The old booking stays until the new
// one is confirmed. With traveller payments on, Book goes to Stripe's page and back (#trip-paid), like any booking.
//
// travel.js hands it its state and helpers through init, like travel-activities.js: { S, paint, money2 }.

import { el, ico, toast } from './util.js';
import { tripPost } from './trip-ui.js';

let C = null;
export function init(ctx) { C = ctx; }

const P = () => C.S.promise || (C.S.promise = { data: null, loading: false, error: null, open: null, busy: false, form: {} });
const money = (amount, cur) => (C.money2 ? C.money2(Number(amount), cur) : `${amount} ${cur}`);
const when = (iso) => (iso ? `${String(iso).slice(0, 16).replace('T', ' ')} UTC` : '');
const STEP_NAMES = [['check', 'Check the price'], ['book', 'Book the new rate'], ['cancel', 'Cancel the old booking']];

/** The whole view again from the server (after a step, a setting, or coming back from Stripe). */
export async function refresh() {
  const p = P();
  p.loading = true;
  try { p.data = await tripPost('promise', {}); p.error = null; }
  catch (e) { p.error = String((e && e.message) || e); }
  p.loading = false;
  C.paint();
}

/** Open the rebook for one booking (Eden noticed's "Rebook with Eden" can call this instead of asking the chat). */
export function openRebook(bookingId) {
  const p = P();
  p.open = bookingId;
  if (!p.data) refresh(); else C.paint();
  requestAnimationFrame(() => { const n = document.querySelector(`[data-k="promise:${bookingId}"]`); if (n) n.scrollIntoView({ block: 'center', behavior: 'smooth' }); });
}

/** Back from Stripe (#trip-paid): the open rebook's payment settled on the server, then shown. */
export async function afterPayment() {
  const p = P();
  const open = p.open || (p.data && [...(p.data.hotels || []).map((h) => h.rebook), ...(p.data.rebooks || [])].find((r) => r && r.state === 'paying')?.booking_id);
  if (open) await tripPost('promise-rebook-status', { booking_id: open }).catch(() => {});
  await refresh();
}

/* ---------- the panel ---------- */

/** "Price Promise": each watch, the savings total, the setting and the rebook in progress. Null for a trip's guests. */
export function promisePanel() {
  const S = C.S;
  if (S.member) return null;
  const p = P();
  if (!p.data && !p.loading && !p.error) refresh();
  const d = p.data;
  const head = el('div', 'tv-card-head', el('span', 'tv-kicker accent', ico('spark', 12), 'The Eden Price Promise · Plus'));
  if (!d) return el('section', { class: 'glass-card tv-promise', 'aria-label': 'Price Promise' }, head, el('p', 'tv-fine', p.error || 'Loading your watched prices…'));
  const totals = d.saved.totals || [];
  const saved = totals.length ? totals.map((t) => money(t.amount, t.currency)).join(' + ') : null;
  const rows = [...d.hotels.map(hotelRow), ...d.flights.map(flightRow)];
  return el('section', { class: 'glass-card tv-promise', 'aria-label': 'Price Promise' },
    head,
    el('h2', '', saved ? `Saved so far: ${saved}` : 'Nothing rebooked yet'),
    el('p', 'tv-fine', saved ? `From ${d.saved.entries.length} ${d.saved.entries.length === 1 ? 'rebook' : 'rebooks'} you finished through Eden.` : d.promise.what),
    el('label', { class: 'tv-fine tv-promise-set' },
      el('input', { type: 'checkbox', 'data-k': 'promise:flights', ...(d.settings.watch_flights ? { checked: '' } : {}), onchange: (e) => setFlights(e.target) }),
      ` Watch every flight I add (up to ${d.settings.cap} at a time, once its airports are in the stop, like “LHR → LIS”)`),
    rows.length ? el('ul', { class: 'tv-disc-list tv-promise-list' }, ...rows) : el('p', 'tv-empty', 'No watched prices yet. A hotel you book through Eden is watched while it cancels for free; a flight once you turn on Watch the price.'),
    ...(d.rebooks || []).map((r) => el('div', 'tv-promise-orphan', rebookBlock(r, null))),
    el('p', 'tv-fine', `Prices from Duffel Stays and Duffel, as of each line’s time. Like for like: the same hotel, room, dates and guests, at a rate that also cancels for free. Shown ${when(d.at)}.`));
}

async function setFlights(input) {
  input.disabled = true;
  try { await tripPost('promise-settings', { watch_flights: input.checked }); toast(input.checked ? 'Eden will watch the price of each flight you add' : 'New flights won’t be watched automatically'); }
  catch (e) { input.checked = !input.checked; toast(String(e.message || e)); }
  input.disabled = false;
  refresh();
}

function hotelRow(h) {
  const p = P();
  const lines = [
    h.paid ? `Paid ${money(h.paid.total, h.paid.currency)}` : null,
    h.lowest ? `lowest like-for-like ${money(h.lowest.total, h.lowest.currency)} (${h.lowest.source}, ${when(h.lowest.at)})` : h.watching ? 'not checked yet' : null,
  ].filter(Boolean).join(' · ');
  const open = p.open === h.booking_id || (h.rebook && h.rebook.state !== 'done' && h.rebook.state !== 'check');
  return el('li', { class: 'tv-promise-item', 'data-k': `promise:${h.booking_id}` },
    el('div', 'tv-row',
      el('b', '', h.name), el('span', 'tv-fine', ` ${h.trip_title || ''}${h.room ? ` · ${h.room}` : ''} · ${h.check_in} → ${h.check_out}`)),
    el('div', 'tv-fine', lines),
    el('div', 'tv-fine', h.watching ? `${h.deadline.label} ${when(h.deadline.at)}` : h.why_not),
    h.cheaper ? el('div', 'tv-promise-drop', ico('spark', 12), ` ${money(h.cheaper.by, h.cheaper.currency)} cheaper now`) : null,
    h.cheaper && !open ? el('div', 'tv-acts', el('button', { type: 'button', class: 'tv-btn primary', 'data-k': `promise:open:${h.booking_id}`, onclick: () => openRebook(h.booking_id) }, 'Rebook for less')) : null,
    open && (h.cheaper || h.rebook) ? rebookBlock(h.rebook, h) : null);
}

function flightRow(f) {
  return el('li', { class: 'tv-promise-item' },
    el('div', 'tv-row', el('b', '', f.route), el('span', 'tv-fine', ` ${f.trip_title || ''} · ${f.date} · ${f.cabin.replace('_', ' ')}${f.auto ? ' · watched automatically' : ''}`)),
    el('div', 'tv-fine', `Seen at ${money(f.seen.total, f.seen.currency)} (${f.seen.source}, ${when(f.seen.at)})${f.lowest ? ` · lowest now ${money(f.lowest.total, f.lowest.currency)} (${f.lowest.source}, ${when(f.lowest.at)})` : ''}`),
    el('div', 'tv-fine', `${f.deadline.label}. Not booked: booking stays yours.`),
    f.cheaper ? el('div', 'tv-promise-drop', ico('spark', 12), ` ${money(f.cheaper.by, f.cheaper.currency)} cheaper than when you started watching`) : null);
}

/* ---------- the rebook ---------- */

function rebookBlock(r, h) {
  const p = P();
  const state = r ? r.state : 'check';
  const next = r ? r.next : 'check';
  const idx = { check: 0, book: 1, paying: 1, cancel: 2, cancel_failed: 2, done: 3 }[state] ?? 3;
  const bookingId = r ? r.booking_id : h.booking_id;
  const steps = el('ol', { class: 'tv-promise-steps', 'aria-label': 'Rebook steps' }, ...STEP_NAMES.map(([, label], i) =>
    el('li', { class: i < idx ? 'done' : i === idx ? 'now' : '', ...(i === idx ? { 'aria-current': 'step' } : {}) }, i < idx ? ico('check', 12) : null, ` ${i + 1}. ${label}`)));
  const box = el('div', { class: 'tv-promise-rebook', role: 'group', 'aria-label': `Rebook ${r ? r.hotel : h.name}` }, steps);
  if (r && r.quote && idx >= 1) box.append(el('p', 'tv-fine', `New rate: ${money(r.quote.total, r.quote.currency)}${r.quote.room ? `, ${r.quote.room}` : ''}, free cancellation until ${when(r.quote.free_until)} (${r.quote.source}, ${when(r.quote.checked_at)}).${r.saving ? ` Saves ${money(r.saving.amount, r.saving.currency)}.` : ''}`));
  if (r && r.new && idx >= 2) box.append(el('p', 'tv-fine', `New booking made: reference ${r.new.reference || r.new.booking_id}.`));
  if (r && r.error) box.append(el('div', { class: 'errbox', role: 'alert' }, ico('x'), el('span', '', r.error)));
  if (state === 'done') { box.append(el('p', 'tv-fine', ico('check', 12), ` Done. ${(r.steps[r.steps.length - 1] || {}).text || ''}`)); return box; }
  if (!next) { box.append(el('p', 'tv-fine', 'Ask Eden is looking at this one. Nothing more to press.')); return box; }
  const acts = el('div', 'tv-acts');
  const run = async (step, extra = {}) => {
    if (p.busy) return;
    p.busy = true; C.paint();
    try {
      const out = await tripPost('promise-rebook', { booking_id: bookingId, step, confirm: true, ...extra });
      if (out && out.pay && out.pay.url) { location.assign(out.pay.url); return; } // Stripe's page; back at #trip-paid
      if (step === 'book') p.form = {};
      if (out && out.rebook === null) p.open = null;
    } catch (e) { toast(String(e.message || e)); }
    p.busy = false;
    refresh();
  };
  if (next === 'check') {
    box.append(el('p', 'tv-fine', 'Eden asks Duffel Stays for the cheaper rate’s live price first. Nothing is booked or cancelled yet.'));
    acts.append(el('button', { type: 'button', class: 'tv-btn primary', disabled: p.busy ? '' : null, 'data-k': 'promise:check', onclick: () => run('check') }, 'Check the price'));
  } else if (next === 'book' && state === 'paying') {
    box.append(el('p', 'tv-fine', 'The payment is open on Stripe. Your old booking stays until the new one is confirmed.'));
    acts.append(el('button', { type: 'button', class: 'tv-btn primary', 'data-k': 'promise:pay', onclick: () => run('book') }, 'Finish paying'));
  } else if (next === 'book') {
    const form = guestForm();
    box.append(el('p', 'tv-fine', 'Step 2 books the new rate. Your old booking is not touched until the new one is confirmed.'), form);
    acts.append(el('button', { type: 'button', class: 'tv-btn primary', 'data-k': 'promise:book', onclick: () => {
      if (!form.reportValidity()) return;
      const f = p.form;
      run('book', { guests: [{ given_name: f.g || '', family_name: f.f || '' }], email: f.email || '', phone_number: String(f.phone || '').replace(/[\s()-]/g, ''), origin: location.origin });
    } }, r && r.quote ? `Book the new rate for ${money(r.quote.total, r.quote.currency)}` : 'Book the new rate'));
  } else if (next === 'cancel') {
    box.append(el('p', 'tv-fine', `Step 3 cancels the old booking (reference ${r.old.reference || r.booking_id}) while it is free to, until ${when(r.old.free_until)}. Until you do, you have both bookings.`));
    acts.append(el('button', { type: 'button', class: 'tv-btn primary', 'data-k': 'promise:cancel', onclick: () => run('cancel') }, state === 'cancel_failed' ? 'Try cancelling again' : 'Cancel the old booking'));
  }
  if (state === 'check' || state === 'book') acts.append(el('button', { type: 'button', class: 'tv-btn quiet', 'data-k': 'promise:forget', onclick: () => (r ? run('forget') : (p.open = null, C.paint())) }, 'Not now'));
  box.append(acts);
  return box;
}

/** The lead guest's name, email and phone for the new booking (kept only in this page's memory until it is booked). */
function guestForm() {
  const f = P().form;
  const input = (k, attrs) => { const i = el('input', { ...attrs, required: '' }); i.value = f[k] || ''; i.addEventListener('input', () => { f[k] = i.value; }); return i; };
  return el('form', { class: 'tc-form', onsubmit: (e) => e.preventDefault() },
    el('div', 'tc-row2', input('g', { type: 'text', autocomplete: 'given-name', placeholder: 'Lead guest first name', 'aria-label': 'Lead guest first name' }), input('f', { type: 'text', autocomplete: 'family-name', placeholder: 'Last name', 'aria-label': 'Lead guest last name' })),
    input('email', { type: 'email', autocomplete: 'email', placeholder: 'Email for the booking', 'aria-label': 'Email' }),
    input('phone', { type: 'tel', autocomplete: 'tel', placeholder: 'Phone, like +15555550100', 'aria-label': 'Phone' }));
}
