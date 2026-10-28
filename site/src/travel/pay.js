// Paying for a booking with the traveller's own card (Stripe), before Eden books it with Duffel from Ask Eden's balance.
// Hold, book, then charge, so nobody is charged for a booking that didn't happen and Ask Eden never pays for one nobody paid:
//
//   1. trip-pay-start { kind, args }: the booking's price, read again here (a flight's price check, a hotel's quote; never
//      the page's number), and a Stripe Checkout that only holds the card for it (capture_method manual). The booking's
//      details (the names on the tickets) wait in this account's object until it is made, then go.
//   2. Back from Stripe (trip-pay-complete from the page, or Stripe's checkout.session.completed through the webhook):
//      the hold is confirmed with Stripe (the amount and currency too), the booking is made with the same op the card
//      used to call, and the hold is captured. A booking that fails releases the hold: nothing is charged.
//   3. trip-pay-status { pay_id } / trip-pay-latest: pending | booking | paid | failed (booked: made, but Stripe didn't
//      take the charge; the owner sees it in Stripe), with the booking or the reason.
//
//   4. A paid booking cancelled (account.js): payRefund gives the card back what the provider gives back: a hotel's whole
//      price within its free cancellation, a flight's refund as the airline quoted it (Duffel refunds Ask Eden's balance).
//   5. Stuck in the middle (the Worker restarted between the hold and the booking's answer): paySweep, alarm 'tpaysweep'
//      every 15 minutes while a payment is pending or booking. It never books again: it finds what was made (Stripe, the
//      provider, this account's own booking records), then charges for it, or releases the hold and tells the traveller.
//   6. What the owner must sort out by hand (a card refund that keeps failing, a refund in another currency, a payment the
//      sweep couldn't settle) is listed in the global object `tpayflags:global` (as accuracy.js's tacc:global), shown on
//      the owner's dashboard (stats/admin.js "Travel refunds"), and cleared there with Mark resolved (tpayadmin-resolve).
// kind: flight (an instant booking: flights.js book), flight_pay (paying a held one: flights.js pay), stay (stayops.js),
// rail (a train or bus through Distribusion: extraops.js).
// On only with TRAVEL_PAY = "1" and Stripe's key and webhook secret set (eden/billing.js); then the account refuses those
// bookings without a payment (account.js, 402 pay_first). TRAVEL_FEE_CENTS: a fee per booking; unset, as the owner decided
// (2026-10-28: Eden Travel is part of Plus, no booking fee or markup), so the hold is the fare or stay total only.

import { esimFound, esimPrice } from './esim.js';
import { ApiError } from '../accounts/util.js';
import { stripeRequest } from '../eden/billing.js';
import { scheduleJob, unscheduleJob } from '../accounts/schedule.js';

export const payOn = (env) => String(env?.TRAVEL_PAY || '') === '1' && Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
export const PAY_KINDS = ['flight', 'flight_pay', 'stay', 'rail', 'esim'];
const KEY = (id) => `tpay:${id}`;
const LAST = 'tpay:last';
const CHECKOUT_MINUTES = 30; // Stripe's shortest Checkout; a flight's price check lasts 20, so a late payment is released
const ID = /^[0-9a-f]{24}$/;
// Stripe's currencies without minor units (Duffel's amounts arrive here in hundredths either way)
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);
export const FLAGS = 'tpayflags:global';
const SWEEP = 'tpaysweep', SWEEP_MS = 15 * 60_000;
// pending: Stripe's Checkout lasts CHECKOUT_MINUTES (+1), so not stuck before it ends; booking: a provider answers in well
// under a minute; a hold left longer than holdMaxMs is released rather than booked late; `tries`: sweeps before the owner is asked
export const STUCK = { pendingMs: (CHECKOUT_MINUTES + 5) * 60_000, bookingMs: 10 * 60_000, holdMaxMs: 60 * 60_000, tries: 4 };

const hex = (n) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join('');
const money = (cents, cur) => { try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur }).format(cents / 100); } catch { return `${cur} ${(cents / 100).toFixed(2)}`; } };

/** Hundredths of `currency` → Stripe's unit for it. */
export function stripeAmount(cents, currency) {
  const cur = String(currency || '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(cur) || THREE_DECIMAL.has(cur)) throw new ApiError(400, 'currency', `Eden can't take payment in ${cur || 'that currency'} yet.`);
  if (!Number.isInteger(cents) || cents <= 0) throw new ApiError(400, 'bad_request', 'Nothing to pay.');
  return ZERO_DECIMAL.has(cur) ? Math.round(cents / 100) : cents;
}

/** What the booking costs, read from what this account checked (never the page's own number), with its title. */
async function priceOf(account, kind, args, { flightOp }) {
  if (kind === 'flight') {
    if (args.hold === true) throw new ApiError(400, 'bad_request', 'A held flight is paid when it is paid for (flight_pay), not now.');
    const c = await flightOp(account, 'flight-review', { check_id: args.check_id });
    return { cents: c.total, currency: c.currency, title: `Flight: ${c.airline}, ${c.passengers} ${c.passengers === 1 ? 'passenger' : 'passengers'}` };
  }
  if (kind === 'flight_pay') {
    const q = await flightOp(account, 'flight-pay_quote', { order_id: args.order_id });
    return { cents: Math.round(Number(q.amount) * 100), currency: q.currency, title: `Flight booking ${q.booking_reference}` };
  }
  if (kind === 'esim') { // a checked eSIM plan (esim.js trip-esim-check)
    const p = await esimPrice(account, args);
    if (!p) throw new ApiError(409, 'check_expired', 'Check the plan’s price again first.');
    return p;
  }
  if (kind === 'rail') {
    const r = await account.storage.get(`rlq:${String(args.offer_id || '')}`);
    if (!r || !r.total || account.now() - r.at > 20 * 60_000) throw new ApiError(409, 'check_expired', 'Check the seats and price again first.');
    return { cents: Math.round(Number(r.total.amount) * 100), currency: r.total.currency, title: r.title || 'Train' };
  }
  const q = await account.storage.get(`stq:${String(args.quote_id || '')}`);
  if (!q || !q.total) throw new ApiError(409, 'quote_expired', 'Eden has no recent price for this room. Get the price again.');
  return { cents: Math.round(Number(q.total) * 100), currency: q.currency, title: `Hotel: ${(q.accommodation && q.accommodation.name) || 'your stay'}${q.room ? `, ${q.room}` : ''}` };
}

/** The booking itself, once the card is held: the op the card would have called. */
async function book(account, rec, { flightOp, tripOp }) {
  if (rec.kind === 'flight') return flightOp(account, 'flight-book', { ...rec.args, confirm: true });
  if (rec.kind === 'flight_pay') return flightOp(account, 'flight-pay', { ...rec.args, confirm: true });
  if (rec.kind === 'esim') return tripOp(account, 'trip-esim-order', { check_id: rec.args.check_id, held: { amount: rec.cents / 100, currency: rec.currency }, confirm: true }); // never above what the card holds
  if (rec.kind === 'rail') return tripOp(account, 'trip-rail-book', { ...rec.args, held: { amount: rec.cents / 100, currency: rec.currency }, confirm: true }); // never above what the card holds
  return tripOp(account, 'trip-stays-book', { ...rec.args, confirm: true });
}

const view = (rec) => ({
  pay_id: rec.id, kind: rec.kind, status: rec.status, title: rec.title, total_text: money(rec.cents + rec.fee, rec.currency),
  ...(rec.fee ? { fee_text: money(rec.fee, rec.currency) } : {}),
  ...(rec.result ? { result: rec.result } : {}), ...(rec.error ? { error: rec.error } : {}),
});

/** The account object's side (account.js: trip-pay-*, and pay-webhook for Stripe's event). `deps`: { flightOp, tripOp, stripe? } */
export async function payOp(account, op, body = {}, deps = {}) {
  const env = account.env || {};
  const stripe = deps.stripe || ((method, path, params, opts) => stripeRequest(env, method, path, params, opts));
  if (op === 'trip-pay-start') {
    // payments off: the page books as before (the account doesn't ask for a payment then either)
    if (!payOn(env)) return { required: false };
    const kind = String(body.kind || '');
    if (!PAY_KINDS.includes(kind)) throw new ApiError(400, 'bad_request', `kind must be one of ${PAY_KINDS.join(', ')}`);
    const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
    const origin = String(body.origin || '');
    if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(origin)) throw new ApiError(400, 'bad_request', 'No address to come back to.');
    const p = await priceOf(account, kind, args, deps);
    const fee = Math.max(0, Math.round(Number(env.TRAVEL_FEE_CENTS) || 0));
    const currency = String(p.currency || '').toUpperCase();
    const amount = stripeAmount(p.cents + fee, currency);
    const id = hex(12);
    const accountId = (await account.storage.get('account')).id;
    const metadata = { account_id: accountId, kind: 'travel', pay_id: id, booking: kind };
    const line = (cents, name) => ({ quantity: 1, price_data: { currency: currency.toLowerCase(), unit_amount: stripeAmount(cents, currency), product_data: { name } } });
    const back = (to) => `${origin}/api/web/billing/return?to=${to}`;
    const session = await stripe('POST', '/checkout/sessions', {
      mode: 'payment',
      client_reference_id: accountId,
      line_items: fee ? [line(p.cents, p.title), line(fee, 'Ask Eden booking fee')] : [line(p.cents, p.title)],
      // only a hold: the card is charged once the booking is made (pay-complete), released if it isn't
      payment_intent_data: { capture_method: 'manual', metadata, description: p.title },
      metadata,
      success_url: back('trip'),
      cancel_url: back('trip-cancelled'),
      expires_at: Math.floor(account.now() / 1000) + CHECKOUT_MINUTES * 60 + 60,
    }, { idempotency: `tpay-${id}` });
    const rec = { id, kind, args, title: p.title, cents: p.cents, fee, currency, amount, session: String(session.id), status: 'pending', created: account.now() };
    await account.storage.put({ [KEY(id)]: rec, [LAST]: id });
    await armPaySweep(account); // a payment left in the middle is settled (paySweep)
    return { required: true, pay_id: id, url: session.url, total_text: money(p.cents + fee, currency) };
  }
  if (op === 'trip-pay-status' || op === 'trip-pay-latest') {
    const id = op === 'trip-pay-latest' ? await account.storage.get(LAST) : String(body.pay_id || '');
    const rec = id && ID.test(id) ? await account.storage.get(KEY(id)) : null;
    if (!rec) { if (op === 'trip-pay-latest') return { status: 'none' }; throw new ApiError(404, 'not_found', 'No such payment.'); }
    return view(rec);
  }
  if (op === 'trip-pay-complete' || op === 'pay-webhook') return complete(account, op, body, { ...deps, stripe });
  throw new ApiError(404, 'not_found', 'Unknown payment action.');
}

/** Back from Stripe (the page or the webhook, whichever is first; the other finds it done): book, then charge or release. */
async function complete(account, op, body, deps) {
  const id = String(body.pay_id || '');
  const rec = ID.test(id) ? await account.storage.get(KEY(id)) : null;
  if (!rec) throw new ApiError(404, 'not_found', 'No such payment.');
  // Stripe's event names its session; it must be this payment's
  if (op === 'pay-webhook' && String(body.session || '') !== rec.session) throw new ApiError(400, 'bad_request', 'That session is not this payment’s.');
  account.paying ??= new Set();
  if (rec.status !== 'pending' || account.paying.has(id)) return view(rec);
  account.paying.add(id);
  const save = (patch) => { Object.assign(rec, patch); return account.storage.put(KEY(id), rec); };
  try {
    const session = await deps.stripe('GET', `/checkout/sessions/${encodeURIComponent(rec.session)}?expand[]=payment_intent`);
    const pi = session.payment_intent && typeof session.payment_intent === 'object' ? session.payment_intent : null;
    if (!pi || pi.status !== 'requires_capture') {
      if (session.status === 'expired' || (pi && pi.status === 'canceled')) {
        await save({ status: 'failed', error: 'The payment wasn’t finished in time. Nothing was charged or booked.', args: null });
      }
      return view(rec); // not paid yet (still on Stripe's page): the same answer until it is
    }
    if (pi.amount !== rec.amount || String(pi.currency || '').toUpperCase() !== rec.currency) {
      await deps.stripe('POST', `/payment_intents/${encodeURIComponent(pi.id)}/cancel`, {}).catch(() => {});
      await save({ status: 'failed', error: 'The amount held wasn’t the booking’s. Nothing was charged or booked.', args: null });
      return view(rec);
    }
    await save({ status: 'booking', intent: pi.id, booking_at: account.now() }); // from here the sweep looks for what was made
    let result;
    try {
      result = await book(account, rec, deps);
    } catch (e) {
      // not booked: the hold goes, nothing is charged
      await deps.stripe('POST', `/payment_intents/${encodeURIComponent(pi.id)}/cancel`, { cancellation_reason: 'abandoned' }).catch((err) => console.error('travel hold not released', err && err.message));
      await save({ status: 'failed', error: `${String((e && e.message) || 'The booking failed.')} Nothing was charged.`, args: null });
      return view(rec);
    }
    try {
      await deps.stripe('POST', `/payment_intents/${encodeURIComponent(pi.id)}/capture`, {}, { idempotency: `tpay-capture-${id}` });
      await save({ status: 'paid', result, args: null, paid: account.now() });
      const booking = result && (result.order_id || result.booking_id);
      if (booking) await account.storage.put(`tpayby:${booking}`, id); // a cancellation finds the payment (payRefund)
    } catch (e) {
      // booked, but the charge didn't go through: kept for the owner to see (never booked twice)
      console.error('travel capture failed', id, e && e.message);
      await save({ status: 'booked', result, args: null, capture_failed: true });
    }
    return view(rec);
  } finally {
    account.paying.delete(id);
  }
}

/**
 * A paid booking was cancelled (account.js, after flight-cancel_confirm or trip-stays-cancel): the card gets `cents` back
 * (in the booking's currency, never more than was charged), once per cancellation. No payment of Eden's: nothing to do.
 * Returns words for the page, or null.
 */
const RETRY = 'tpayretry', RETRY_MS = 3600_000, RETRY_TRIES = 24;

/** Alarm 'tpayretry' (account.js): card refunds that failed, tried again hourly. Stripe keeps a key's first answer (an
 *  error too) for a day, so each try has its own key, after a look at whether a refund was made after all. After a day
 *  of failures it stays flagged (refund_failed.gave_up) for the owner. */
export async function payRefundRetry(account, deps = {}) {
  const stripe = deps.stripe || ((method, path, params, opts) => stripeRequest(account.env || {}, method, path, params, opts));
  let more = false;
  for (const [key, rec] of await account.storage.list({ prefix: 'tpay:' })) {
    const f = rec && rec.refund_failed;
    if (!f || typeof f !== 'object' || f.gave_up || rec.refunded) continue;
    const id = key.slice(5);
    try {
      const made = await stripe('GET', `/refunds?payment_intent=${encodeURIComponent(rec.intent)}&limit=10`).catch(() => null);
      const done = made && Array.isArray(made.data) && made.data.some((r) => r && r.status !== 'failed' && r.status !== 'canceled' && r.metadata && r.metadata.pay_id === key.slice(5));
      if (!done) await stripe('POST', '/refunds', { payment_intent: rec.intent, amount: stripeAmount(f.cents, rec.currency), metadata: { pay_id: key.slice(5), booking: f.booking } }, { idempotency: `tpay-refund-${key.slice(5)}-r${f.tries || 1}` });
      Object.assign(rec, { refund_failed: null, refunded: f.cents, status: f.cents >= rec.cents + rec.fee ? 'refunded' : 'paid' });
    } catch (e) {
      console.error('travel refund retry failed', key, e && e.message);
      f.tries = (f.tries || 1) + 1;
      if (f.tries >= RETRY_TRIES) f.gave_up = true; else more = true;
    }
    await account.storage.put(key, rec);
    await syncFlag(account, id, rec, deps); // cleared once refunded; the tries (and gave_up) for the owner otherwise
  }
  if (more) await scheduleJob(account, RETRY, RETRY, account.now() + RETRY_MS);
  else await unscheduleJob(account, RETRY);
}

export async function payRefund(account, booking, cents, deps = {}) {
  const id = booking ? await account.storage.get(`tpayby:${booking}`) : null;
  const rec = id ? await account.storage.get(KEY(id)) : null;
  if (!rec || !rec.intent || rec.status !== 'paid' || rec.refunded) return null;
  const want = Math.min(Math.max(0, Math.round(Number(cents) || 0)), rec.cents + rec.fee);
  if (!want) return 'The booking had no refund, so nothing goes back to your card.';
  if (deps.currency && deps.currency !== rec.currency) { // refunded in another currency: the owner sorts it, never a guess at a rate
    Object.assign(rec, { refund_review: { cents: want, currency: deps.currency, booking: String(booking), since: account.now() } });
    await account.storage.put(KEY(id), rec);
    await syncFlag(account, id, rec, deps);
    return 'The booking is cancelled; its refund came back in another currency, so Eden will refund your card by hand.';
  }
  const stripe = deps.stripe || ((method, path, params, opts) => stripeRequest(account.env || {}, method, path, params, opts));
  try {
    await stripe('POST', '/refunds', { payment_intent: rec.intent, amount: stripeAmount(want, rec.currency), metadata: { pay_id: id, booking: String(booking) } }, { idempotency: `tpay-refund-${id}` });
  } catch (e) {
    console.error('travel refund failed', id, e && e.message);
    Object.assign(rec, { refund_failed: { cents: want, booking: String(booking), tries: 1, since: account.now() } });
    await account.storage.put(KEY(id), rec);
    await syncFlag(account, id, rec, deps);
    await scheduleJob(account, RETRY, RETRY, account.now() + RETRY_MS).catch(() => {}); // tried again (payRefundRetry)
    return 'The booking is cancelled; the refund to your card didn’t go through yet. Eden will sort it out.';
  }
  Object.assign(rec, { refunded: want, status: want >= rec.cents + rec.fee ? 'refunded' : 'paid' });
  await account.storage.put(KEY(id), rec);
  return `${money(want, rec.currency)} goes back to your card.`;
}

/* ---------- a payment stuck in the middle (alarm 'tpaysweep') ---------- */

/** The sweep armed (pay-start, and again by the sweep itself while a payment is in the middle). Never throws. */
export async function armPaySweep(account, at = account.now() + SWEEP_MS) {
  await scheduleJob(account, SWEEP, SWEEP, at).catch((e) => console.error('travel pay sweep not armed', e && e.message));
}

/**
 * Alarm 'tpaysweep' (account.js): each payment pending or booking for longer than STUCK allows, settled without booking
 * again. `deps`: { flightOp, tripOp, stripe?, notify?, index? }. → [{ pay_id, action, status }]
 */
export async function paySweep(account, deps = {}) {
  const stripe = deps.stripe || ((method, path, params, opts) => stripeRequest(account.env || {}, method, path, params, opts));
  const d = { ...deps, stripe };
  const now = account.now();
  const out = [];
  let middle = false;
  for (const [key, rec] of await account.storage.list({ prefix: 'tpay:' })) {
    const id = key.slice(5);
    if (!ID.test(id) || !rec || typeof rec !== 'object' || (rec.status !== 'pending' && rec.status !== 'booking')) continue;
    if (rec.sweep_review || rec.swept) continue; // the owner's to settle (flagged), or settled by them
    if (account.paying && account.paying.has(id)) { middle = true; continue; } // being completed right now
    try {
      const r = await settle(account, id, rec, d, now);
      if (r) out.push({ pay_id: id, ...r });
    } catch (e) {
      console.error('travel pay sweep', id, e && e.message);
    }
    const after = await account.storage.get(key);
    if (after && (after.status === 'pending' || after.status === 'booking') && !after.sweep_review) middle = true;
  }
  if (middle) await scheduleJob(account, SWEEP, SWEEP, now + SWEEP_MS);
  else await unscheduleJob(account, SWEEP);
  return out;
}

const tell = (account, deps, title, body, id) => (deps.notify ? deps.notify(account, { title, body, data: { kind: 'tpay', pay_id: id } }).catch(() => 0) : 0);

async function settle(account, id, rec, deps, now) {
  const save = (patch) => { Object.assign(rec, patch); return account.storage.put(KEY(id), rec); };
  if (rec.status === 'pending') {
    if (now - rec.created < STUCK.pendingMs) return null; // still on Stripe's page
    // the page and Stripe's webhook both missed: the same step they would have taken (it checks Stripe, then books once)
    if (now - rec.created <= STUCK.holdMaxMs) { const v = await complete(account, 'trip-pay-complete', { pay_id: id }, deps); return { action: 'completed', status: v.status }; }
    // over an hour with nothing done: never booked this late; a hold on the card is released
    const session = await deps.stripe('GET', `/checkout/sessions/${encodeURIComponent(rec.session)}?expand[]=payment_intent`);
    const pi = session.payment_intent && typeof session.payment_intent === 'object' ? session.payment_intent : null;
    if (pi && pi.status === 'requires_capture') {
      await deps.stripe('POST', `/payment_intents/${encodeURIComponent(pi.id)}/cancel`, { cancellation_reason: 'abandoned' });
      await save({ status: 'failed', intent: pi.id, error: 'The booking wasn’t made in time, so the hold on your card was released. Nothing was charged.', args: null });
      await tell(account, deps, 'Your booking didn’t go through', `${rec.title}: it wasn’t booked in time, so the hold on your card is released. Nothing was charged.`, id);
      return { action: 'released', status: 'failed' };
    }
    if (session.status === 'expired' || (pi && pi.status === 'canceled')) {
      await save({ status: 'failed', error: 'The payment wasn’t finished in time. Nothing was charged or booked.', args: null });
      return { action: 'expired', status: 'failed' };
    }
    return review(account, id, rec, deps, now, `Stripe says the checkout is ${session.status || 'unknown'}${pi ? `, its payment ${pi.status}` : ''}; Eden can’t settle it.`);
  }

  // booking: the card was held and the booking asked for; its answer never came back
  const since = rec.booking_at || rec.created;
  if (now - since < STUCK.bookingMs) return null;
  const pi = await deps.stripe('GET', `/payment_intents/${encodeURIComponent(rec.intent)}`);
  if (pi.status === 'canceled') { // released already (the booking failed); only the record was left behind
    await save({ status: 'failed', error: 'The booking didn’t go through. Nothing was charged.', args: null });
    await tell(account, deps, 'Your booking didn’t go through', `${rec.title}: it wasn’t booked, and nothing was charged.`, id);
    return { action: 'released', status: 'failed' };
  }
  const found = await findBooking(account, rec, since, deps);
  if (pi.status === 'succeeded') { // charged: the hold is captured only after the booking is made, so it was
    await save({ status: 'paid', result: found.result || null, args: null, paid: now });
    if (found.booking) await account.storage.put(`tpayby:${found.booking}`, id);
    else return review(account, id, rec, deps, now, `Charged and booked, but the booking’s number was lost (${PROVIDER[rec.kind]}).`, 'paid');
    return { action: 'finished', status: 'paid' };
  }
  if (pi.status !== 'requires_capture' || found.state === 'error') {
    rec.sweep_tries = (rec.sweep_tries || 0) + 1;
    if (rec.sweep_tries < STUCK.tries) { await save({}); return { action: 'later', status: rec.status }; }
    if (pi.status !== 'requires_capture') return review(account, id, rec, deps, now, `Stripe says the hold is ${pi.status}; Eden can’t settle it.`);
  }
  if (found.state === 'made') {
    await deps.stripe('POST', `/payment_intents/${encodeURIComponent(pi.id)}/capture`, {}, { idempotency: `tpay-capture-${id}` });
    await save({ status: 'paid', result: found.result || null, args: null, paid: now });
    if (found.booking) await account.storage.put(`tpayby:${found.booking}`, id);
    await tell(account, deps, 'Your booking is confirmed', `${rec.title}: booked, and ${money(rec.cents + rec.fee, rec.currency)} was charged to your card.`, id);
    if (!found.booking) return review(account, id, rec, deps, now, `Charged and booked, but the booking’s number was lost (${PROVIDER[rec.kind]}).`, 'paid');
    return { action: 'finished', status: 'paid' };
  }
  // not made (the provider says so), or no sign of it: the hold goes; never booked a second time
  await deps.stripe('POST', `/payment_intents/${encodeURIComponent(pi.id)}/cancel`, { cancellation_reason: 'abandoned' });
  if (found.state === 'none') {
    await save({ status: 'failed', error: 'The booking didn’t go through, so the hold on your card was released. Nothing was charged.', args: null });
    await tell(account, deps, 'Your booking didn’t go through', `${rec.title}: it wasn’t booked, so the hold on your card is released. Nothing was charged.`, id);
    return { action: 'released', status: 'failed' };
  }
  await save({ status: 'failed', error: 'Eden couldn’t confirm the booking was made, so the hold on your card was released. Nothing was charged.', args: null });
  await tell(account, deps, 'Eden couldn’t confirm your booking', `${rec.title}: Eden couldn’t confirm it was booked, so the hold on your card is released and nothing was charged. If a confirmation still reaches you, Eden will be in touch.`, id);
  return review(account, id, rec, deps, now, `Hold released, but the booking may exist at ${PROVIDER[rec.kind]} (asked ${new Date(since).toISOString().slice(0, 16).replace('T', ' ')} UTC, no answer kept).`, 'failed');
}

const PROVIDER = { flight: 'Duffel', flight_pay: 'Duffel', stay: 'Duffel Stays', rail: 'Distribusion', esim: 'Airalo' };

/** The owner asked to look (sweep_review): the record kept as it is, flagged in the global index. */
async function review(account, id, rec, deps, now, why, status = rec.status) {
  rec.sweep_review = { why, since: now, tries: rec.sweep_tries || 0, booking: (rec.result && (rec.result.order_id || rec.result.booking_id || rec.result.reservation_id)) || null };
  await account.storage.put(KEY(id), rec);
  await syncFlag(account, id, rec, deps);
  return { action: 'review', status };
}

/**
 * Whether the booking asked for at `since` was made. No provider call carries an idempotency key or Eden's reference, so
 * what is asked: a held flight's order (Duffel: paid or not), else this account's own records of bookings made since.
 * → { state: 'made', booking?, result? } | { state: 'none' } (the provider says not) | { state: 'unknown' } | { state: 'error' }
 */
async function findBooking(account, rec, since, deps) {
  const storage = account.storage;
  const args = rec.args || {};
  const linked = async (b) => Boolean(await storage.get(`tpayby:${b}`));
  try {
    if (rec.kind === 'esim') return await esimFound(account, args, deps); // Airalo's own order list (esim.js)
    if (rec.kind === 'flight_pay') {
      const o = await deps.flightOp(account, 'flight-order', { order_id: args.order_id });
      if (o.status === 'confirmed') return { state: 'made', booking: o.order_id, result: o };
      return { state: 'none' }; // still on hold (not paid), or cancelled
    }
    if (rec.kind === 'flight') { // flights.js keeps ford:<order> { at } for each order this account books
      const made = [];
      for (const [k, v] of await storage.list({ prefix: 'ford:' })) {
        if (!v || !(v.at >= since) || (await linked(k.slice(5)))) continue;
        const o = await deps.flightOp(account, 'flight-order', { order_id: k.slice(5) });
        if (o.status === 'confirmed') made.push(o); // a held booking of its own is on_hold
      }
      return made.length === 1 ? { state: 'made', booking: made[0].order_id, result: made[0] } : { state: 'unknown' };
    }
    if (rec.kind === 'stay') { // stayops.js keeps stbk:<booking> with the quote's hotel and total
      const q = (await storage.get(`stq:${String(args.quote_id || '')}`)) || {};
      const made = [];
      for (const [, b] of await storage.list({ prefix: 'stbk:' })) {
        if (!b || !(b.created >= since) || (await linked(b.booking_id))) continue;
        if (q.accommodation && b.accommodation && q.accommodation.id && b.accommodation.id !== q.accommodation.id) continue;
        if (q.total && (Number(b.total) !== Number(q.total) || b.currency !== q.currency)) continue;
        made.push(b);
      }
      return made.length === 1 ? { state: 'made', booking: made[0].booking_id, result: { booking_id: made[0].booking_id, reference: made[0].reference, check_in: made[0].check_in, check_out: made[0].check_out } } : { state: 'unknown' };
    }
    if (rec.kind === 'rail') { // extraops.js deletes the price check rlq:<offer> only once Distribusion confirmed the booking
      return (await storage.get(`rlq:${String(args.offer_id || '')}`)) ? { state: 'unknown' } : { state: 'made' };
    }
  } catch (e) {
    console.error('travel pay sweep lookup', rec.id, e && e.message);
    return { state: 'error' };
  }
  return { state: 'unknown' };
}

/* ---------- the owner's flags (the global index, stats/admin.js) ---------- */

/** What the owner must sort out on this payment, or null. */
export function flagOf(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const f = rec.refund_failed;
  if (f && typeof f === 'object') return { why: 'refund_failed', text: f.gave_up ? 'The card refund failed for a day; Eden stopped trying.' : 'The card refund failed; Eden tries again hourly.', booking: f.booking || null, cents: f.cents, currency: rec.currency, since: f.since || null, tries: f.tries || 1, gave_up: Boolean(f.gave_up) };
  const r = rec.refund_review;
  if (r && typeof r === 'object') return { why: 'refund_currency', text: `The provider refunded in ${r.currency}; the card was charged in ${rec.currency}. Refund the card by hand.`, booking: r.booking || null, cents: r.cents, currency: r.currency, since: r.since || null, tries: 0, gave_up: false };
  const s = rec.sweep_review;
  if (s && typeof s === 'object') return { why: 'stuck', text: s.why, booking: s.booking || null, cents: rec.cents + rec.fee, currency: rec.currency, since: s.since || null, tries: s.tries || 0, gave_up: false };
  return null;
}

/** The global index, by the account namespace's object FLAGS (no device: the Worker's and accounts' own calls only). */
async function askIndex(env, op, body) {
  const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName(FLAGS));
  const response = await stub.fetch(`https://account/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const out = await response.json().catch(() => ({}));
  if (response.status >= 400) throw new ApiError(response.status, out.code || 'error', out.error || 'Something went wrong.');
  return out;
}

/** This payment's flag in the global index: set while it has one, cleared when it hasn't. Never throws (logged). */
async function syncFlag(account, id, rec, deps = {}) {
  try {
    const index = deps.index || ((op, body) => askIndex(account.env || {}, op, body));
    const accountId = ((await account.storage.get('account')) || {}).id;
    const flag = flagOf(rec);
    await index(flag ? 'tpayflag-set' : 'tpayflag-clear', { account: accountId, pay_id: id, ...(flag ? { flag: { ...flag, title: rec.title, kind: rec.kind, status: rec.status } } : {}) });
  } catch (e) {
    console.error('travel pay flag not indexed', id, e && e.message);
  }
}

const ACCOUNT_ID = /^[0-9a-f-]{8,64}$/i;
const str = (v, n) => (v === null || v === undefined ? null : String(v).slice(0, n));
const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

/** The index's ops (account.js, op tpayflag-*): set, clear, list. Refused in a person's own object. */
export async function payFlagIndexOp(account, op, body = {}) {
  if (await account.storage.get('account')) throw new ApiError(404, 'not_found', 'Not found');
  if (op === 'tpayflag-list') {
    const flags = [...(await account.storage.list({ prefix: 'tpf:', limit: 500 })).values()].sort((a, b) => (a.since || 0) - (b.since || 0));
    return { flags };
  }
  const acc = String(body.account || ''), pid = String(body.pay_id || '');
  if (!ACCOUNT_ID.test(acc) || !ID.test(pid)) throw new ApiError(400, 'bad_request', 'account and pay_id.');
  const key = `tpf:${acc}:${pid}`;
  if (op === 'tpayflag-clear') { await account.storage.delete(key); return { cleared: true }; }
  if (op !== 'tpayflag-set') throw new ApiError(404, 'not_found', 'Not found');
  const f = body.flag && typeof body.flag === 'object' ? body.flag : {};
  if (!['refund_failed', 'refund_currency', 'stuck'].includes(f.why)) throw new ApiError(400, 'bad_request', 'flag.why');
  await account.storage.put(key, {
    account: acc, pay_id: pid, why: f.why, text: str(f.text, 300), booking: str(f.booking, 80), cents: int(f.cents), currency: str(f.currency, 3),
    since: int(f.since), tries: int(f.tries) || 0, gave_up: Boolean(f.gave_up), title: str(f.title, 160), kind: str(f.kind, 12), status: str(f.status, 12), at: account.now(),
  });
  return { ok: true };
}

/**
 * The owner's Mark resolved (stats/admin.js, through the Worker: op tpayadmin-resolve { pay_id, by?, note? }): the flag
 * kept in the payment's history (resolved), then cleared here and in the index. Nothing is charged or refunded by it.
 */
export async function payResolve(account, body = {}, deps = {}) {
  if (!(await account.storage.get('account'))) throw new ApiError(404, 'not_found', 'Not found');
  const id = String(body.pay_id || '');
  const rec = ID.test(id) ? await account.storage.get(KEY(id)) : null;
  if (!rec) throw new ApiError(404, 'not_found', 'No such payment.');
  const flag = flagOf(rec);
  if (flag) {
    rec.resolved = [...(Array.isArray(rec.resolved) ? rec.resolved : []), { ...flag, at: account.now(), by: String(body.by || 'owner').slice(0, 120), note: String(body.note || '').slice(0, 300) }].slice(-10);
    // a payment left in the middle stays as the owner left it: the sweep doesn't take it up again
    Object.assign(rec, { refund_failed: null, refund_review: null, sweep_review: null }, flag.why === 'stuck' && (rec.status === 'pending' || rec.status === 'booking') ? { swept: true } : {});
    await account.storage.put(KEY(id), rec);
  }
  await syncFlag(account, id, rec, deps); // cleared in the index either way (a stale entry too)
  return { resolved: Boolean(flag), pay_id: id, why: flag ? flag.why : null };
}
