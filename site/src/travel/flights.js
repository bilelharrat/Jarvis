// Flights on askeden.com: Eden's Duffel core (vendor-flights.js, bundled from the askeden repo's src/chat/duffel.ts and
// flights.ts) run in each person's account object, so their searches and 20-minute price checks are kept between
// requests and a check is used once. The same API the page already speaks to Eden on the Mac (askeden
// docs/flights-duffel.md, web/chat/flight-ui.js):
//
//   GET  /api/chat/flights/status       → { enabled, ready, mode: 'test'|'live'|null, problem? }
//   POST /api/chat/flights { action, args }
//     search | check | review | order | cancel_quote | pay_quote     (no side effects)
//     book | cancel_confirm | pay                                    (need args.confirm: true: only the card's button sends it)
//
// Off unless the Worker has EDEN_FLIGHTS = "1". DUFFEL_TOKEN is a secret; a duffel_live_ token is refused unless
// DUFFEL_LIVE = "1" (duffel.ts tokenInfo). The token and passengers' details are never logged or kept: the state kept
// is offers seen (price, bags) and checks (fare, passenger ids and types), each pruned by the core.

import { ApiError, json } from '../accounts/util.js';
import { createDuffelClient, createFlightService, DuffelError, FlightInputError, httpStatusFor, tokenInfo } from './vendor-flights.js';
import { applyLoyalty } from './loyalty.js';

export const FLIGHT_ACTIONS = ['search', 'check', 'review', 'book', 'order', 'cancel_quote', 'cancel_confirm', 'pay_quote', 'pay'];
export const flightsOn = (env) => String(env?.EDEN_FLIGHTS || '') === '1';
const STATE = 'fl:state';

/** What the page asks first: on, with a usable token, and in which mode. */
export function flightStatus(env) {
  if (!flightsOn(env)) return { enabled: false, ready: false, mode: null };
  const t = tokenInfo(env);
  return { enabled: true, ready: t.ok, mode: t.ok ? t.mode : null, ...(t.error ? { problem: t.error.message, code: t.error.code } : {}) };
}

/** The Worker's side (eden/chat.js hands /api/chat/flights… here, signed in). */
export async function flightsApi(request, env, who, path, { call, limited, readBody }) {
  if (path === '/api/chat/flights/status' && request.method === 'GET') return json(flightStatus(env));
  if (path !== '/api/chat/flights' || request.method !== 'POST' || !flightsOn(env)) throw new ApiError(404, 'not_found', 'Not found');
  await limited(env, 'API_RATE', who.account);
  const body = await readBody(request, 64 * 1024);
  if (!FLIGHT_ACTIONS.includes(body.action)) throw new ApiError(400, 'bad_request', `action must be one of ${FLIGHT_ACTIONS.join(', ')}`);
  const args = body.args === undefined ? {} : body.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ApiError(400, 'bad_request', 'args must be an object');
  if (body.action === 'search') await limited(env, 'EDEN_RATE', `turn:${who.account}`); // each search is a billable look at the airlines
  return json(await call(env, who.account, `flight-${body.action}`, args, who.token));
}

/** The account object's side: one action on the core, with this account's offers and checks. `deps` lets tests point at a fake Duffel. */
export async function flightOp(account, op, body = {}, deps = {}) {
  const env = account.env || {};
  if (!flightsOn(env)) throw new ApiError(404, 'not_found', 'Not found');
  const action = op.slice('flight-'.length);
  if (!FLIGHT_ACTIONS.includes(action)) throw new ApiError(404, 'not_found', 'Unknown flight action.');
  const storage = account.storage;
  const saved = (await storage.get(STATE)) || { seen: [], checks: [] };
  const seen = new Map(saved.seen), checks = new Map(saved.checks);
  const before = { seen: new Map([...seen].map(([k, v]) => [k, JSON.stringify(v)])), checks: new Map([...checks].map(([k, v]) => [k, JSON.stringify(v)])) };
  let client;
  const duffel = () => (client ??= createDuffelClient({ env, fetch: deps.fetch, baseUrl: deps.baseUrl, sleep: deps.sleep, log: deps.log || ((line) => console.log(JSON.stringify(line))) }));
  const svc = createFlightService({ now: () => account.now(), state: { seen, checks }, client: duffel });
  const run = { search: 'search', check: 'check', review: 'review', book: 'book', order: 'order', cancel_quote: 'cancelQuote', cancel_confirm: 'cancelConfirm', pay_quote: 'payQuote', pay: 'pay' }[action];
  try {
    // Eden books every flight on one Duffel account: an order is reachable only from the account that booked it
    // (ford:<order>, or tpayby:<order> for one paid through Eden before ford: existed), a cancellation only from the
    // account that asked its quote (tcq:<cancellation>, account.js)
    if (['order', 'cancel_quote', 'pay_quote', 'pay'].includes(action) && !(await storage.get(`ford:${String(body.order_id ?? '')}`)) && !(await storage.get(`tpayby:${String(body.order_id ?? '')}`))) throw new ApiError(404, 'not_found', 'There is no such flight booking in your Eden.');
    if (action === 'cancel_confirm' && !(await storage.get(`tcq:${String(body.cancellation_id ?? '')}`))) throw new ApiError(404, 'not_found', 'Ask for the cancellation quote again, then confirm.');
    // the passengers' saved frequent-flyer numbers, on airlines this fare takes, sent before the order (travel/loyalty.js);
    // `loyalty: false` books without them. An unusable check is left for the core to refuse.
    const c = action === 'book' && body.confirm === true && body.loyalty !== false ? checks.get(String(body.check_id ?? '')) : null;
    const loyalty = c && !c.used && account.now() <= c.expires && Array.isArray(body.passengers) && body.passengers.length === c.passenger_ids.length ? await applyLoyalty(account, duffel(), c, body.passengers) : [];
    const out = await svc[run](body);
    if (loyalty.length && out) out.loyalty = loyalty;
    if (action === 'book' && out && out.order_id) await storage.put(`ford:${out.order_id}`, { at: account.now() });
    return out;
  } catch (e) {
    if (e instanceof DuffelError) throw new ApiError(httpStatusFor(e), e.code, e.message, {}, e.requestId ? { requestId: e.requestId } : {});
    if (e instanceof FlightInputError) throw new ApiError(400, 'input', e.message);
    throw e;
  } finally {
    // Two requests at once (a search while a check runs): only what this one changed is written over what is stored now.
    const fresh = (await storage.get(STATE)) || { seen: [], checks: [] };
    const merge = (list, mine, was) => {
      const out = new Map(list);
      for (const [k, v] of mine) if (was.get(k) !== JSON.stringify(v)) out.set(k, v);
      for (const k of was.keys()) if (!mine.has(k)) out.delete(k);
      return [...out];
    };
    await storage.put(STATE, { seen: merge(fresh.seen, seen, before.seen), checks: merge(fresh.checks, checks, before.checks) });
  }
}
