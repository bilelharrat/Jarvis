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
// kind: flight (an instant booking: flights.js book), flight_pay (paying a held one: flights.js pay), stay (stayops.js).
// On only with TRAVEL_PAY = "1" and Stripe's key and webhook secret set (eden/billing.js); then the account refuses those
// bookings without a payment (account.js, 402 pay_first). TRAVEL_FEE_CENTS: a fee per booking; unset, as the owner decided
// (2026-10-28: Eden Travel is part of Plus, no booking fee or markup), so the hold is the fare or stay total only.

import { ApiError } from '../accounts/util.js';
import { stripeRequest } from '../eden/billing.js';

export const payOn = (env) => String(env?.TRAVEL_PAY || '') === '1' && Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET);
export const PAY_KINDS = ['flight', 'flight_pay', 'stay'];
const KEY = (id) => `tpay:${id}`;
const LAST = 'tpay:last';
const CHECKOUT_MINUTES = 30; // Stripe's shortest Checkout; a flight's price check lasts 20, so a late payment is released
const ID = /^[0-9a-f]{24}$/;
// Stripe's currencies without minor units (Duffel's amounts arrive here in hundredths either way)
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
const THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

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
  const q = await account.storage.get(`stq:${String(args.quote_id || '')}`);
  if (!q || !q.total) throw new ApiError(409, 'quote_expired', 'Eden has no recent price for this room. Get the price again.');
  return { cents: Math.round(Number(q.total) * 100), currency: q.currency, title: `Hotel: ${(q.accommodation && q.accommodation.name) || 'your stay'}${q.room ? `, ${q.room}` : ''}` };
}

/** The booking itself, once the card is held: the op the card would have called. */
async function book(account, rec, { flightOp, tripOp }) {
  if (rec.kind === 'flight') return flightOp(account, 'flight-book', { ...rec.args, confirm: true });
  if (rec.kind === 'flight_pay') return flightOp(account, 'flight-pay', { ...rec.args, confirm: true });
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
    await save({ status: 'booking', intent: pi.id });
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
export async function payRefund(account, booking, cents, deps = {}) {
  const id = booking ? await account.storage.get(`tpayby:${booking}`) : null;
  const rec = id ? await account.storage.get(KEY(id)) : null;
  if (!rec || !rec.intent || rec.status !== 'paid' || rec.refunded) return null;
  const want = Math.min(Math.max(0, Math.round(Number(cents) || 0)), rec.cents + rec.fee);
  if (!want) return 'The booking had no refund, so nothing goes back to your card.';
  const stripe = deps.stripe || ((method, path, params, opts) => stripeRequest(account.env || {}, method, path, params, opts));
  try {
    await stripe('POST', '/refunds', { payment_intent: rec.intent, amount: stripeAmount(want, rec.currency), metadata: { pay_id: id, booking: String(booking) } }, { idempotency: `tpay-refund-${id}` });
  } catch (e) {
    console.error('travel refund failed', id, e && e.message);
    Object.assign(rec, { refund_failed: true });
    await account.storage.put(KEY(id), rec);
    return 'The booking is cancelled; the refund to your card didn’t go through yet. Eden will sort it out.';
  }
  Object.assign(rec, { refunded: want, status: want >= rec.cents + rec.fee ? 'refunded' : 'paid' });
  await account.storage.put(KEY(id), rec);
  return `${money(want, rec.currency)} goes back to your card.`;
}
