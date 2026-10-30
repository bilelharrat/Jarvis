// The page side of Eden's flights (flight-tools.js; docs/flights-duffel.md): whether the server has them on, the
// reads going to POST /api/chat/flights, and the booking / cancel / pay cards. Never in the iPhone/Android app
// (tools-ui.js only calls this when !IN_APP). The card's button is the only thing that sends confirm: true.

import { el, ico } from './util.js';
import { getJSON, postJSON } from './api.js';
import { saveConversation, ui } from './state.js';
import * as F from './flight-tools.js';
import { payFirst } from './trip-ui.js';

let st = { enabled: false, ready: false, mode: null, at: 0 };
/** Is the flights feature on (server EDEN_FLIGHTS=1)? Cached for a minute; a server without it says no. */
export async function flightStatus() {
  if (Date.now() - st.at < 60_000) return st;
  try {
    const j = await getJSON('/api/chat/flights/status', { timeout: 5000 });
    st = { enabled: Boolean(j && j.enabled), ready: Boolean(j && j.ready), mode: (j && j.mode) || null, at: Date.now() };
  } catch { st = { enabled: false, ready: false, mode: null, at: Date.now() }; }
  return st;
}
export const flightsPost = (action, args) => postJSON('/api/chat/flights', { action, args }, { timeout: 150_000 });

const LOADING = new WeakSet(); // cards fetching their check (not saved with the chat)

/** The card for a flight_book / flight_cancel / flight_pay call. `t` is the saved tool state on the reply. */
export function flightCard(c, node, t, call) {
  const redraw = () => { saveConversation(c); ui.updateMessage(c, node); };
  const step = t.quote ? 'quoted' : 'start';
  const spec = F.flightCardSpec(call, step, { mode: st.mode || 'test' });
  const root = el('div', { class: `toolcard ${t.state}${spec.danger ? ' danger' : ''}`, role: 'group', 'aria-label': spec.title, 'data-tool': call.name });
  root.append(el('div', 'tc-title', ico('globe', 15), spec.title));
  const rows = (list) => root.append(el('dl', 'tc-rows', ...list.flatMap(([k, v]) => [el('dt', '', k), el('dd', { 'data-no-i18n': '' }, String(v))])));

  if (call.name === 'flight_book') {
    // the price and facts come from the server's own check, never from the model's text
    if (!t.summary && t.state === 'pending' && !LOADING.has(t)) {
      LOADING.add(t);
      flightsPost('review', { check_id: call.args.check_id })
        .then((s) => { t.summary = s; })
        .catch((e) => { t.state = 'error'; t.error = String(e.message || e); t.stale = true; })
        .finally(() => { LOADING.delete(t); redraw(); });
    }
    if (t.summary) rows(F.bookRows(t.summary, call.args));
    else if (t.state === 'pending') root.append(el('div', 'tc-done muted', 'Loading the checked price…'));
  } else if (t.quote) {
    rows(call.name === 'flight_cancel' ? [['Booking', t.quote.booking_reference], ['Refund', t.quote.refund_text]] : [['Booking', t.quote.booking_reference], ['Price now', t.quote.total_text], ...(t.quote.pay_by ? [['Pay by', `${t.quote.pay_by.slice(0, 16).replace('T', ' ')} UTC`]] : [])]);
  } else rows([['Booking', call.args.order_id]]);

  if (t.state === 'done') {
    root.append(el('div', 'tc-done', ico('check', 14), t.result || 'Done.'));
    return root;
  }
  if (t.state === 'cancelled') { root.append(el('div', 'tc-done muted', 'Cancelled. Nothing was changed.')); return root; }
  if (t.state === 'running') { root.append(el('div', 'tc-done muted', 'Working…')); return root; }
  if (spec.notice) root.append(el('div', 'tc-notice', spec.notice));
  if (t.state === 'error') root.append(el('div', { class: 'errbox', role: 'alert' }, ico('x'), el('span', '', t.stale ? `${t.error} Ask Eden to check the flight again.` : t.error)));
  const acts = el('div', 'tc-acts');
  const ready = call.name !== 'flight_book' || (t.summary && !t.stale);
  if (ready) acts.append(el('button', { type: 'button', class: `cap ${spec.danger ? 'danger' : 'primary'}`, onclick: () => press(t, call, redraw) }, call.name === 'flight_book' && t.summary && !call.args.hold ? `${spec.button} ${t.summary.total_text}` : spec.button));
  acts.append(el('button', { type: 'button', class: 'cap', onclick: () => { t.state = 'cancelled'; redraw(); } }, 'Cancel'));
  root.append(acts);
  return root;
}

/** The button: one step of the card, run once (the card shows Working… meanwhile). */
async function press(t, call, redraw) {
  t.state = 'running'; delete t.error; redraw();
  try {
    if (call.name === 'flight_book') {
      const args = { check_id: call.args.check_id, offer_id: t.summary.offer_id, amount: (t.summary.total / 100).toFixed(2), currency: t.summary.currency, passengers: call.args.passengers, hold: call.args.hold, confirm: true };
      // paying now: the traveller's card is held at Stripe first, when payments are on (a hold is paid later, not now)
      const r = call.args.hold ? await flightsPost('book', args) : await payFirst('flight', args, () => flightsPost('book', args));
      t.state = 'done';
      t.result = `${r.status === 'on_hold' ? 'Held' : 'Booked'}: booking reference ${r.booking_reference} (${r.total_text}). ${r.status_text}.${r.test_mode ? ' Test booking.' : ''}`;
    } else if (!t.quote) {
      t.quote = await flightsPost(call.name === 'flight_cancel' ? 'cancel_quote' : 'pay_quote', { order_id: call.args.order_id });
      t.state = 'pending';
    } else if (call.name === 'flight_cancel') {
      const r = await flightsPost('cancel_confirm', { cancellation_id: t.quote.cancellation_id, confirm: true });
      t.state = 'done';
      t.result = r.cancelled ? `Cancelled ${t.quote.booking_reference}. ${r.refund_text}.${r.card_refund_text ? ` ${r.card_refund_text}` : ''}` : 'The airline hasn’t confirmed the cancellation yet.';
    } else {
      const args = { order_id: call.args.order_id, amount: t.quote.amount, currency: t.quote.currency, confirm: true };
      const r = await payFirst('flight_pay', args, () => flightsPost('pay', args));
      t.state = 'done';
      t.result = `Paid: ${r.booking_reference} is ${r.status_text.toLowerCase()} (${r.total_text}).`;
    }
  } catch (e) {
    t.state = 'error';
    t.error = String(e.message || e);
    // a changed price or an expired check can't be retried from this card: the model checks again
    t.stale = /price|expired|check (it|the flight) again|already used/i.test(t.error);
    if (call.name === 'flight_pay' && /price/i.test(t.error)) { delete t.quote; t.stale = false; }
  }
  redraw();
}
