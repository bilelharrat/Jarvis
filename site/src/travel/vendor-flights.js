// Eden's Duffel flights core (askeden 17200a1: src/chat/duffel.ts, flights.ts), bundled 2026-10-27 with askeden's esbuild
// (format esm, platform neutral). Generated: edit the askeden repo, not this file. Only fetch and Web Crypto.
// src/chat/duffel.ts
var DUFFEL_API = "https://api.duffel.com";
var DUFFEL_VERSION = "v2";
var DUFFEL_MESSAGES = {
  not_configured: "Flight booking isn\u2019t set up on this server yet (no Duffel token).",
  live_token_refused: "Eden refused a live Duffel token: only test bookings are allowed until DUFFEL_LIVE=1 is set.",
  bad_token: "The Duffel token doesn\u2019t look right (it should start with duffel_test_).",
  unauthorized: "Duffel didn\u2019t accept Eden\u2019s token. It may have expired or been revoked.",
  not_found: "Duffel has no such offer or booking.",
  validation: "Duffel said some details aren\u2019t valid.",
  offer_expired: "That fare has expired. Search again for a fresh price.",
  offer_unavailable: "That fare is no longer available. Search again.",
  price_changed: "The price changed since it was checked. Check the flight again to see the new price.",
  schedule_changed: "The airline changed the flight times. Look at the booking again before paying.",
  not_cancellable: "This booking can\u2019t be cancelled online. Contact the airline.",
  already_cancelled: "This booking is already cancelled.",
  insufficient_balance: "The Duffel balance is too low to pay for this.",
  invalid_state: "That can\u2019t be done to this booking right now.",
  rate_limited: "Duffel is busy. Try again in a minute.",
  airline_error: "The airline\u2019s system returned an error. Nothing was booked; try again or pick another flight.",
  unavailable: "Duffel isn\u2019t answering right now. Try again shortly.",
  timeout: "Duffel took too long to answer.",
  network: "Eden couldn\u2019t reach Duffel.",
  upstream: "Duffel returned an error."
};
var DuffelError = class extends Error {
  constructor(code, status, message = DUFFEL_MESSAGES[code], duffelCode, requestId, field) {
    super(message);
    this.code = code;
    this.status = status;
    this.duffelCode = duffelCode;
    this.requestId = requestId;
    this.field = field;
    this.name = "DuffelError";
  }
};
function httpStatusFor(e) {
  switch (e.code) {
    case "not_configured":
    case "live_token_refused":
    case "bad_token":
      return 503;
    case "unauthorized":
      return 502;
    case "not_found":
      return 404;
    case "validation":
      return 400;
    case "rate_limited":
      return 429;
    case "timeout":
      return 504;
    case "offer_expired":
    case "offer_unavailable":
    case "price_changed":
    case "schedule_changed":
    case "not_cancellable":
    case "already_cancelled":
    case "insufficient_balance":
    case "invalid_state":
      return 409;
    default:
      return 502;
  }
}
function tokenInfo(env) {
  const token = (env.DUFFEL_TOKEN ?? "").trim();
  if (!token) return { ok: false, mode: null, error: new DuffelError("not_configured", 503) };
  if (!/^duffel_(test|live)_[A-Za-z0-9_\-=.+/]{8,400}$/.test(token)) return { ok: false, mode: null, error: new DuffelError("bad_token", 503) };
  const live = token.startsWith("duffel_live_");
  if (live && env.DUFFEL_LIVE !== "1") return { ok: false, mode: "live", error: new DuffelError("live_token_refused", 503) };
  return { ok: true, mode: live ? "live" : "test", token };
}
function mapDuffelCode(status, type, code) {
  switch (code) {
    case "offer_expired":
      return "offer_expired";
    case "offer_no_longer_available":
    case "offer_not_available":
      return "offer_unavailable";
    case "price_changed":
      return "price_changed";
    case "schedule_changed":
      return "schedule_changed";
    case "order_not_cancellable":
      return "not_cancellable";
    case "already_cancelled":
      return "already_cancelled";
    case "insufficient_balance":
      return "insufficient_balance";
    case "not_found":
      return "not_found";
    case "rate_limit_exceeded":
      return "rate_limited";
    default:
      break;
  }
  if (status === 401 || status === 403 || type === "authentication_error") return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 429 || type === "rate_limit_error") return "rate_limited";
  if (type === "validation_error" || status === 400) return "validation";
  if (type === "invalid_state_error") return "invalid_state";
  if (type === "airline_error") return "airline_error";
  if (status === 503) return "unavailable";
  if (status === 504) return "timeout";
  return "upstream";
}
function errorFrom(status, text, requestIdHeader) {
  let first;
  let requestId = requestIdHeader ?? void 0;
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j.errors) && j.errors[0] && typeof j.errors[0] === "object") first = j.errors[0];
    if (typeof j.meta?.request_id === "string") requestId = j.meta.request_id;
  } catch {
  }
  const type = typeof first?.type === "string" ? first.type : void 0;
  const code = typeof first?.code === "string" ? first.code : void 0;
  const mapped = mapDuffelCode(status, type, code);
  const src = first?.source;
  const field = typeof src?.pointer === "string" ? src.pointer.slice(0, 120) : typeof src?.field === "string" ? src.field.slice(0, 80) : void 0;
  let message = DUFFEL_MESSAGES[mapped];
  if (mapped === "validation" && field) message = `${message} (${field.replace(/^\/data\//, "").replace(/\//g, ".")})`;
  return new DuffelError(mapped, status, message, code, requestId, field);
}
var ID = /^[a-z]{2,5}_[A-Za-z0-9]{6,60}$/;
function id(v, what) {
  if (typeof v !== "string" || !ID.test(v)) throw new DuffelError("validation", 400, `${what} isn\u2019t a Duffel id.`);
  return encodeURIComponent(v);
}
function createDuffelClient(opts) {
  const info = tokenInfo(opts.env);
  if (!info.ok || !info.token) throw info.error ?? new DuffelError("not_configured", 503);
  const token = info.token;
  const base = (opts.baseUrl ?? DUFFEL_API).replace(/\/+$/, "");
  const doFetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const log = opts.log ?? (() => void 0);
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const timeouts = { read: 2e4, search: 45e3, write: 13e4, ...opts.timeouts };
  const maxRetries = opts.retries ?? 2;
  async function call(method, path, o = {}) {
    const kind = o.kind ?? (method === "GET" ? "read" : "write");
    const idempotent = kind !== "write";
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(o.query ?? {})) if (v !== void 0) qs.set(k, String(v));
    const url = `${base}${path}${qs.toString() ? `?${qs}` : ""}`;
    const headers = {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "Duffel-Version": DUFFEL_VERSION,
      Authorization: `Bearer ${token}`,
      ...o.body !== void 0 ? { "Content-Type": "application/json" } : {}
    };
    const body = o.body !== void 0 ? JSON.stringify({ data: o.body }) : void 0;
    for (let attempt = 1; ; attempt++) {
      const started = now();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeouts[kind]);
      let res;
      let text = "";
      let failure;
      try {
        res = await doFetch(url, { method, headers, body, signal: ctl.signal });
        text = await res.text();
      } catch (e) {
        failure = ctl.signal.aborted ? new DuffelError("timeout", 504) : new DuffelError("network", 502);
        void e;
      } finally {
        clearTimeout(timer);
      }
      const requestId = res?.headers.get("x-request-id") ?? void 0;
      if (res && res.status >= 200 && res.status < 300) {
        log({ kind: "duffel", method, path, status: res.status, ms: now() - started, attempt, ...requestId ? { requestId } : {} });
        if (res.status === 204 || !text) return void 0;
        try {
          return JSON.parse(text).data;
        } catch {
          throw new DuffelError("upstream", 502, "Duffel sent an answer Eden couldn\u2019t read.", void 0, requestId);
        }
      }
      if (res) failure = errorFrom(res.status, text, requestId ?? null);
      const err = failure;
      log({ kind: "duffel", method, path, status: res?.status ?? null, ms: now() - started, attempt, ...err.requestId ? { requestId: err.requestId } : {}, code: err.duffelCode ?? err.code });
      const status = res?.status ?? 0;
      const retryable = status === 429 || idempotent && (status >= 500 || err.code === "timeout" || err.code === "network");
      if (!retryable || attempt > maxRetries) throw err;
      let wait = Math.min(8e3, 500 * 2 ** (attempt - 1));
      const reset = res?.headers.get("ratelimit-reset");
      if (status === 429 && reset) {
        const at = Date.parse(reset);
        if (Number.isFinite(at)) wait = Math.max(0, Math.min(6e4, at - now()));
      }
      await sleep(wait);
    }
  }
  return {
    mode: info.mode,
    searchOffers: async (data, o = {}) => call("POST", "/air/offer_requests", { body: data, kind: "search", query: { return_offers: true, supplier_timeout: o.supplierTimeoutMs ?? 2e4 } }),
    getOffer: async (offerId, o = {}) => call("GET", `/air/offers/${id(offerId, "offer")}`, { query: { return_available_services: o.services ? true : void 0 } }),
    seatMaps: async (offerId) => call("GET", "/air/seat_maps", { query: { offer_id: decodeURIComponent(id(offerId, "offer")) } }),
    // loyalty numbers go on the offer's passenger before the order (Duffel's guide "Adding Loyalty Programme Accounts")
    updateOfferPassenger: async (offerId, passengerId, data) => call("PATCH", `/air/offers/${id(offerId, "offer")}/passengers/${id(passengerId, "passenger")}`, { body: data }),
    createOrder: async (input) => call("POST", "/air/orders", { body: input }),
    getOrder: async (orderId) => call("GET", `/air/orders/${id(orderId, "order")}`),
    createPayment: async (input) => call("POST", "/air/payments", { body: input }),
    quoteCancellation: async (orderId) => call("POST", "/air/order_cancellations", { body: { order_id: decodeURIComponent(id(orderId, "order")) }, kind: "read" }),
    // a quote changes nothing
    confirmCancellation: async (cid) => call("POST", `/air/order_cancellations/${id(cid, "cancellation")}/actions/confirm`),
    changeRequest: async (input) => call("POST", "/air/order_change_requests", { body: input, kind: "search" }),
    createOrderChange: async (offerId) => call("POST", "/air/order_changes", { body: { selected_order_change_offer: decodeURIComponent(id(offerId, "change offer")) }, kind: "read" }),
    confirmOrderChange: async (cid, payment) => call("POST", `/air/order_changes/${id(cid, "order change")}/actions/confirm`, { body: payment ? { payment } : {} })
  };
}

// src/chat/flights.ts
var TOP_N = 3;
var CHECK_TTL_MS = 20 * 6e4;
var CABINS = ["economy", "premium_economy", "business", "first"];
var PREFERENCES = ["balanced", "cheapest", "fastest"];
var WEIGHTS = {
  cheapest: { hour: 5, stop: 15, awkward: 10 },
  balanced: { hour: 25, stop: 40, awkward: 30 },
  fastest: { hour: 90, stop: 80, awkward: 30 }
};
var NO_BAG_PENALTY = 250;
var FlightInputError = class extends Error {
  constructor() {
    super(...arguments);
    this.status = 400;
  }
};
var bad = (m) => new FlightInputError(m);
var isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
var IATA = /^[A-Z]{3}$/;
var DATE = /^\d{4}-\d{2}-\d{2}$/;
var cents = (amount) => Math.round(Number(amount ?? 0) * 100);
var amountOf = (c) => (c / 100).toFixed(2);
function money(c, currency) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(c / 100);
  } catch {
    return `${currency} ${amountOf(c)}`;
  }
}
function isoMinutes(d) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(String(d ?? ""));
  return m ? Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : null;
}
var wall = (s) => Date.parse(`${s.slice(0, 19)}Z`);
var minutesBetween = (a, b) => Math.round((wall(b) - wall(a)) / 6e4);
var hm = (min) => min >= 60 ? `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}` : `${min} min`;
var clock = (s) => s.slice(11, 16);
var day = (s) => s.slice(0, 10);
function ruleWords(c, what) {
  if (!c) return what === "refund" ? "Refunds: the airline didn\u2019t say, so assume none." : "Changes: the airline didn\u2019t say, so assume none.";
  if (!c.allowed) return what === "refund" ? "No refund if you cancel." : "No changes allowed.";
  const fee = c.penalty_amount != null && c.penalty_currency ? cents(c.penalty_amount) : null;
  if (what === "refund") return fee === null ? "Refundable; the airline sets the fee." : fee === 0 ? "Fully refundable, no fee." : `Refundable, minus a ${money(fee, c.penalty_currency)} fee.`;
  return fee === null ? "Changes allowed; the airline sets the fee, plus any difference in fare." : fee === 0 ? "Free changes (you pay any difference in fare)." : `Changes cost ${money(fee, c.penalty_currency)}, plus any difference in fare.`;
}
function parseSearchArgs(a, today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10)) {
  const code = (v, k) => {
    const s = String(v ?? "").trim().toUpperCase();
    if (!IATA.test(s)) throw bad(`${k} must be a 3-letter airport or city code (e.g. JFK, LON)`);
    return s;
  };
  const origin = code(a.origin, "origin");
  const destination = code(a.destination, "destination");
  if (origin === destination) throw bad("origin and destination must differ");
  const date = (v, k) => {
    const s = String(v ?? "").trim();
    if (!DATE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw bad(`${k} must be "YYYY-MM-DD"`);
    if (s < today) throw bad(`${k} is in the past`);
    return s;
  };
  const depart_date = date(a.depart_date, "depart_date");
  const return_date = a.return_date === void 0 || a.return_date === null || a.return_date === "" ? void 0 : date(a.return_date, "return_date");
  if (return_date && return_date < depart_date) throw bad("return_date must be on or after depart_date");
  const adults = a.adults === void 0 ? 1 : Number(a.adults);
  if (!Number.isInteger(adults) || adults < 1 || adults > 9) throw bad("adults must be 1\u20139");
  const children_ages = a.children_ages === void 0 ? [] : a.children_ages;
  if (!Array.isArray(children_ages) || children_ages.some((x) => !Number.isInteger(x) || x < 0 || x > 17)) throw bad("children_ages must be a list of ages 0\u201317");
  if (adults + children_ages.length > 9) throw bad("at most 9 passengers");
  const cabin = a.cabin === void 0 ? "economy" : String(a.cabin).toLowerCase().replace(/[\s-]+/g, "_");
  if (!CABINS.includes(cabin)) throw bad(`cabin must be ${CABINS.join(", ")}`);
  let max_price;
  if (a.max_price !== void 0 && a.max_price !== null && a.max_price !== "") {
    max_price = Number(a.max_price);
    if (!Number.isFinite(max_price) || max_price <= 0) throw bad("max_price must be a positive number");
  }
  const checked_bags = a.checked_bags === void 0 ? 0 : Number(a.checked_bags);
  if (!Number.isInteger(checked_bags) || checked_bags < 0 || checked_bags > 3) throw bad("checked_bags must be 0\u20133 per person");
  const max_stops = a.max_stops === void 0 ? 1 : Number(a.max_stops);
  if (!Number.isInteger(max_stops) || max_stops < 0 || max_stops > 2) throw bad("max_stops must be 0, 1 or 2");
  const prefer = a.prefer === void 0 ? "balanced" : String(a.prefer);
  if (!PREFERENCES.includes(prefer)) throw bad(`prefer must be ${PREFERENCES.join(", ")}`);
  return { origin, destination, depart_date, return_date, adults, children_ages, cabin, max_price, checked_bags, max_stops, prefer };
}
function summarizeSlice(s) {
  const segs = s.segments;
  const first = segs[0];
  const last = segs[segs.length - 1];
  const layovers = segs.slice(1).map((seg, i) => {
    const prev = segs[i];
    const min = minutesBetween(prev.arriving_at, seg.departing_at);
    return { airport: prev.destination.iata_code, minutes: min, change_airport: prev.destination.iata_code !== seg.origin.iata_code, overnight: day(prev.arriving_at) !== day(seg.departing_at) || min >= 6 * 60 };
  });
  const flown = segs.reduce((n, seg) => n + (isoMinutes(seg.duration) ?? 0), 0);
  const minutes = isoMinutes(s.duration) ?? flown + layovers.reduce((n, l) => n + l.minutes, 0);
  return {
    from: first.origin.iata_code,
    to: last.destination.iata_code,
    depart: first.departing_at.slice(0, 16),
    arrive: last.arriving_at.slice(0, 16),
    minutes,
    stops: segs.length - 1,
    via: layovers.map((l) => l.airport),
    layovers,
    carriers: [...new Set(segs.map((seg) => seg.operating_carrier.name))],
    flights: segs.map((seg) => `${seg.marketing_carrier.iata_code ?? ""}${seg.marketing_carrier_flight_number ?? ""}`).filter(Boolean)
  };
}
function includedBags(o) {
  let min = Infinity;
  for (const s of o.slices) for (const seg of s.segments) for (const p of seg.passengers ?? []) {
    const n = (p.baggages ?? []).filter((b) => b.type === "checked").reduce((t, b) => t + b.quantity, 0);
    min = Math.min(min, n);
  }
  return min === Infinity ? 0 : min;
}
function planBags(o, perPerson) {
  const included = includedBags(o);
  const extra = Math.max(0, perPerson - included);
  if (!extra) return { included, extra: 0, cost: 0, services: [] };
  const services = (o.available_services ?? []).filter((s) => s.type === "baggage" && (s.metadata?.type ?? "checked") === "checked");
  if (!o.available_services) return { included, extra, cost: null, services: [] };
  let cost = 0;
  const picked = [];
  for (const p of o.passengers) {
    const mine = services.filter((s) => (s.passenger_ids ?? []).includes(p.id));
    const groups = /* @__PURE__ */ new Map();
    for (const s of mine) groups.set((s.segment_ids ?? []).join(","), [...groups.get((s.segment_ids ?? []).join(",")) ?? [], s]);
    if (!groups.size) return { included, extra, cost: null, services: [] };
    for (const list of groups.values()) {
      let need = extra;
      for (const s of [...list].sort((x, y) => cents(x.total_amount) - cents(y.total_amount))) {
        const q = Math.min(need, s.maximum_quantity ?? 1);
        if (q <= 0) break;
        picked.push({ id: s.id, quantity: q });
        cost += cents(s.total_amount) * q;
        need -= q;
      }
      if (need > 0) return { included, extra, cost: null, services: [] };
    }
  }
  return { included, extra, cost, services: picked };
}
function scoreOffer(o, args, fastest, bags = planBags(o, args.checked_bags)) {
  const slices = o.slices.map(summarizeSlice);
  const minutes = slices.reduce((n, s) => n + s.minutes, 0);
  const stops = slices.reduce((n, s) => n + s.stops, 0);
  const total = cents(o.total_amount);
  const passengers = Math.max(1, o.passengers.length);
  const w = WEIGHTS[args.prefer];
  const awkward = slices.filter((s) => Number(clock(s.depart).slice(0, 2)) < 6 || Number(clock(s.arrive).slice(0, 2)) < 5 && s.arrive.slice(0, 10) !== s.depart.slice(0, 10)).length;
  const bagCost = bags.cost ?? NO_BAG_PENALTY * 100 * bags.extra * passengers;
  const withBags = total + (bags.cost ?? 0);
  const score = (total + bagCost) / passengers / 100 + w.hour * Math.max(0, minutes - fastest) / 60 + w.stop * stops + w.awkward * awkward + (slices.some((s) => s.layovers.some((l) => l.change_airport)) ? 60 : 0);
  return {
    offer_id: o.id,
    airline: [...new Set(slices.flatMap((s) => s.carriers))].join(" + ") || o.owner.name,
    total,
    bag_cost: bags.cost,
    total_with_bags: withBags,
    currency: o.total_currency,
    slices,
    minutes,
    stops,
    refund: ruleWords(o.conditions?.refund_before_departure, "refund"),
    change: ruleWords(o.conditions?.change_before_departure, "change"),
    hold_allowed: o.payment_requirements?.requires_instant_payment === false,
    expires_at: o.expires_at ?? null,
    bags,
    score: Math.round(score * 100) / 100,
    why: []
  };
}
function rankOffers(offers, args, bagsFor) {
  const usable = offers.filter((o) => o.slices.every((s) => s.segments.length - 1 <= args.max_stops));
  if (!usable.length) return [];
  const fastest = Math.min(...usable.map((o) => o.slices.reduce((n, s) => n + summarizeSlice(s).minutes, 0)));
  let ranked = usable.map((o) => scoreOffer(o, args, fastest, bagsFor?.get(o.id)));
  if (args.max_price !== void 0) ranked = ranked.filter((r) => r.total_with_bags <= Math.round(args.max_price * 100));
  ranked.sort((a, b) => a.score - b.score || a.total_with_bags - b.total_with_bags || a.minutes - b.minutes);
  const top = ranked.slice(0, TOP_N);
  if (top.length) {
    const cheapest = Math.min(...ranked.map((r) => r.total_with_bags));
    const quickest = Math.min(...ranked.map((r) => r.minutes));
    for (const r of top) {
      if (r.total_with_bags === cheapest) r.why.push("cheapest with bags");
      if (r.minutes === quickest) r.why.push("fastest");
      if (r.stops === 0) r.why.push("nonstop");
      if (r.bags.cost === null) r.why.push("bags can\u2019t be added online");
    }
    top[0].why.unshift("best overall for you");
  }
  return top;
}
function countries(o) {
  const out = /* @__PURE__ */ new Set();
  for (const s of o.slices) for (const seg of s.segments) for (const p of [seg.origin, seg.destination]) if (p.iata_country_code) out.add(p.iata_country_code);
  return [...out];
}
function passportNote(o) {
  const cs = countries(o);
  const docs = o.passenger_identity_documents_required ? " The airline needs everyone\u2019s passport details to book." : "";
  if (cs.length > 1) return `International trip (${cs.join(", ")}): everyone needs a passport, often valid 6 months past the trip; check visa or entry rules for ${cs.slice(1).join(", ")}.${docs}`;
  if (cs[0] === "US") return `Domestic US trip: a REAL ID or passport for adults.${docs}`;
  return `Domestic trip: bring government photo ID.${docs}`;
}
function factsFor(o, bags, passengers) {
  const src = `Duffel offer ${o.id}`;
  const total = cents(o.total_amount) + (bags.cost ?? 0);
  const facts = [
    { key: "total", label: "Total", value: `${money(total, o.total_currency)} for ${passengers} ${passengers === 1 ? "person" : "people"}${bags.cost ? ` (fare ${money(cents(o.total_amount), o.total_currency)} + bags ${money(bags.cost, o.total_currency)})` : ""}`, source: `${src}: total_amount + baggage services` },
    { key: "bags", label: "Bags", value: `${bags.included} checked bag${bags.included === 1 ? "" : "s"} per person included${bags.extra ? bags.cost === null ? `; ${bags.extra} more per person can\u2019t be added online` : `; ${bags.extra} more per person added to the price` : ""}`, source: `${src}: segments[].passengers[].baggages, available_services` }
  ];
  o.slices.forEach((s, i) => {
    const sum = summarizeSlice(s);
    facts.push({ key: `flight_${i}`, label: o.slices.length > 1 ? i === 0 ? "Outbound" : "Return" : "Flight", value: `${sum.from} ${sum.depart.replace("T", " ")} \u2192 ${sum.to} ${sum.arrive.replace("T", " ")} (local times), ${hm(sum.minutes)}, ${sum.stops ? `${sum.stops} stop${sum.stops > 1 ? "s" : ""}` : "nonstop"}; operated by ${sum.carriers.join(", ")}`, source: `${src}: slices[${i}].segments` });
    for (const l of sum.layovers) {
      const notes = [l.change_airport ? "you change airports" : "", l.minutes < 60 ? "tight" : "", l.overnight ? "overnight or long" : ""].filter(Boolean);
      facts.push({ key: `layover_${i}_${l.airport}`, label: "Layover", value: `${hm(l.minutes)} in ${l.airport}${notes.length ? ` (${notes.join(", ")})` : ""}`, source: `${src}: slices[${i}] arriving_at \u2192 next departing_at` });
    }
  });
  if (o.slices.some((s) => s.segments.length > 1)) facts.push({ key: "protection", label: "Connections", value: "Protected: all flights are on one booking, so if a delay makes you miss a connection the airline rebooks you.", source: `${src}: one offer, one order` });
  facts.push({ key: "refund", label: "Refund", value: ruleWords(o.conditions?.refund_before_departure, "refund"), source: `${src}: conditions.refund_before_departure` });
  facts.push({ key: "change", label: "Changes", value: ruleWords(o.conditions?.change_before_departure, "change"), source: `${src}: conditions.change_before_departure` });
  facts.push({ key: "passport", label: "Passport", value: passportNote(o), source: `${src}: airports' countries, passenger_identity_documents_required` });
  if (o.payment_requirements?.requires_instant_payment === false) facts.push({ key: "hold", label: "Hold", value: `Can be held now and paid later${o.payment_requirements.payment_required_by ? ` (pay by ${o.payment_requirements.payment_required_by.slice(0, 16).replace("T", " ")} UTC)` : ""}.`, source: `${src}: payment_requirements` });
  return facts;
}
function randomHex(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
var PASSENGER_KEYS = ["title", "gender", "given_name", "family_name", "born_on", "email", "phone_number"];
function parsePassenger(p, i, needsDocs) {
  if (!isObj(p)) throw bad(`passenger ${i + 1} must be an object`);
  const s = (k, max) => typeof p[k] === "string" ? p[k].trim().slice(0, max) : "";
  const title = s("title", 5).toLowerCase();
  const gender = s("gender", 1).toLowerCase();
  const given_name = s("given_name", 60);
  const family_name = s("family_name", 60);
  const born_on = s("born_on", 10);
  const email = s("email", 200);
  const phone_number = s("phone_number", 20).replace(/[\s()-]/g, "");
  if (!["mr", "ms", "mrs", "miss", "dr"].includes(title)) throw bad(`passenger ${i + 1}: title must be mr, ms, mrs, miss or dr`);
  if (!["m", "f"].includes(gender)) throw bad(`passenger ${i + 1}: gender must be m or f (as on the passport)`);
  if (!given_name || !family_name) throw bad(`passenger ${i + 1}: given_name and family_name as on the passport`);
  if (!DATE.test(born_on)) throw bad(`passenger ${i + 1}: born_on must be "YYYY-MM-DD"`);
  if (!/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(email)) throw bad(`passenger ${i + 1}: email isn\u2019t an email address`);
  if (!/^\+[1-9]\d{6,14}$/.test(phone_number)) throw bad(`passenger ${i + 1}: phone_number must be international, like +14155550100`);
  const out = { title, gender, given_name, family_name, born_on, email, phone_number };
  if (needsDocs || p.passport !== void 0) {
    const d = isObj(p.passport) ? p.passport : null;
    const num = d && typeof d.number === "string" ? d.number.replace(/\s/g, "").slice(0, 20) : "";
    const country = d && typeof d.country === "string" ? d.country.trim().toUpperCase() : "";
    const expires = d && typeof d.expires_on === "string" ? d.expires_on.trim() : "";
    if (!num || !/^[A-Z]{2}$/.test(country) || !DATE.test(expires)) throw bad(`passenger ${i + 1}: passport { number, country (2 letters), expires_on "YYYY-MM-DD" } is needed for this flight`);
    out.identity_documents = [{ type: "passport", unique_identifier: num, issuing_country_code: country, expires_on: expires }];
  }
  for (const k of PASSENGER_KEYS) if (!out[k]) throw bad(`passenger ${i + 1} needs ${k}`);
  return out;
}
function createFlightService(deps) {
  const now = deps.now ?? Date.now;
  const seen = deps.state?.seen ?? /* @__PURE__ */ new Map();
  const checks = deps.state?.checks ?? /* @__PURE__ */ new Map();
  const prune = () => {
    const t = now();
    for (const [k, v] of seen) if (t - v.at > 2 * 36e5) seen.delete(k);
    for (const [k, v] of checks) if (v.expires < t - 36e5) checks.delete(k);
  };
  async function search(raw) {
    const a = parseSearchArgs(raw, new Date(now()).toISOString().slice(0, 10));
    const duffel = deps.client();
    const slices = [{ origin: a.origin, destination: a.destination, departure_date: a.depart_date }];
    if (a.return_date) slices.push({ origin: a.destination, destination: a.origin, departure_date: a.return_date });
    const passengers = [...Array.from({ length: a.adults }, () => ({ type: "adult" })), ...a.children_ages.map((age) => ({ age }))];
    const req = await duffel.searchOffers({ slices, passengers, cabin_class: a.cabin, max_connections: a.max_stops });
    const offers = req.offers ?? [];
    let bagsFor;
    if (a.checked_bags > 0) {
      const rough = rankAll(offers, a).slice(0, 6);
      bagsFor = /* @__PURE__ */ new Map();
      const loaded = await Promise.all(rough.map((o) => duffel.getOffer(o.id, { services: true }).catch(() => null)));
      for (const o of loaded) if (o) bagsFor.set(o.id, planBags(o, a.checked_bags));
    }
    const top = rankOffers(offers, a, bagsFor);
    prune();
    for (const r of top) seen.set(r.offer_id, { total: r.total_with_bags, currency: r.currency, checked_bags: a.checked_bags, at: now() });
    return { offers: top, searched: offers.length, mode: duffel.mode, ...top.length ? {} : { note: offers.length ? "No flights fit the price and stops asked for." : "No flights found for those dates." } };
  }
  function rankAll(offers, a) {
    const usable = offers.filter((o) => o.slices.every((s) => s.segments.length - 1 <= a.max_stops));
    if (!usable.length) return [];
    const fastest = Math.min(...usable.map((o) => o.slices.reduce((n, s) => n + summarizeSlice(s).minutes, 0)));
    return usable.map((o) => ({ o, s: scoreOffer(o, { ...a, checked_bags: 0 }, fastest).score })).sort((x, y) => x.s - y.s).map((x) => x.o);
  }
  async function check(raw) {
    const offerId = String(raw.offer_id ?? "");
    const was = seen.get(offerId);
    const bagsWanted = raw.checked_bags !== void 0 ? Number(raw.checked_bags) : was?.checked_bags ?? 0;
    if (!Number.isInteger(bagsWanted) || bagsWanted < 0 || bagsWanted > 3) throw bad("checked_bags must be 0\u20133 per person");
    const duffel = deps.client();
    const o = await duffel.getOffer(offerId, { services: true });
    const bags = planBags(o, bagsWanted);
    const total = cents(o.total_amount) + (bags.cost ?? 0);
    const seenTotal = raw.seen_total !== void 0 ? Math.round(Number(raw.seen_total) * 100) : was?.total;
    const priceChanged = seenTotal !== void 0 && Number.isFinite(seenTotal) && seenTotal !== total ? { was: seenTotal, now: total, was_text: money(seenTotal, o.total_currency), now_text: money(total, o.total_currency) } : null;
    const facts = factsFor(o, bags, o.passengers.length);
    if (priceChanged) facts.unshift({ key: "price_changed", label: "Price changed", value: `The price went from ${priceChanged.was_text} to ${priceChanged.now_text} since the search.`, source: `Duffel offer ${o.id}: total_amount now vs at search` });
    const id2 = randomHex(12);
    const expiresAt = o.expires_at ? Date.parse(o.expires_at) : NaN;
    const summary = {
      check_id: id2,
      offer_id: o.id,
      airline: [...new Set(o.slices.flatMap((s) => summarizeSlice(s).carriers))].join(" + ") || o.owner.name,
      total,
      currency: o.total_currency,
      total_text: money(total, o.total_currency),
      facts,
      passengers: o.passengers.length,
      hold_allowed: o.payment_requirements?.requires_instant_payment === false,
      needs_documents: Boolean(o.passenger_identity_documents_required)
    };
    prune();
    checks.set(id2, {
      offer_id: o.id,
      fare: cents(o.total_amount),
      bag_cost: bags.cost ?? 0,
      currency: o.total_currency,
      services: bags.cost === null ? [] : bags.services,
      passenger_ids: o.passengers.map((p) => p.id),
      passenger_types: o.passengers.map((p) => p.type ?? (p.age !== void 0 && p.age < 18 ? "child" : "adult")),
      needs_documents: Boolean(o.passenger_identity_documents_required),
      hold_allowed: summary.hold_allowed,
      expires: Math.min(now() + CHECK_TTL_MS, Number.isFinite(expiresAt) ? expiresAt : Infinity),
      summary,
      used: false
    });
    seen.set(o.id, { total, currency: o.total_currency, checked_bags: bagsWanted, at: now() });
    return { ...summary, price_changed: priceChanged, bags_unavailable: bags.cost === null && bags.extra > 0 };
  }
  function liveCheck(checkId) {
    const c = typeof checkId === "string" ? checks.get(checkId) : void 0;
    if (!c) throw new DuffelError("offer_expired", 409, "Eden has no recent price check for this flight. Check it again first.");
    if (c.used) throw new DuffelError("invalid_state", 409, "This price check was already used for a booking.");
    if (now() > c.expires) throw new DuffelError("offer_expired", 409, "The price check is more than 20 minutes old or the fare expired. Check the flight again.");
    return c;
  }
  function review(raw) {
    return liveCheck(raw.check_id).summary;
  }
  async function book(raw) {
    if (raw.confirm !== true) throw new FlightInputError("Not confirmed: nothing was booked. Booking needs the person to press Book on the card.");
    const c = liveCheck(raw.check_id);
    if (raw.offer_id !== void 0 && raw.offer_id !== c.offer_id) throw bad("offer_id doesn\u2019t match the price check");
    const expect = Math.round(Number(raw.amount) * 100);
    if (!Number.isFinite(expect) || expect !== c.fare + c.bag_cost || raw.currency !== c.currency) throw new DuffelError("price_changed", 409, "The amount confirmed doesn\u2019t match the checked price. Check the flight again.");
    const list = Array.isArray(raw.passengers) ? raw.passengers : [];
    if (list.length !== c.passenger_ids.length) throw bad(`this fare is for ${c.passenger_ids.length} passenger${c.passenger_ids.length === 1 ? "" : "s"}; ${list.length} given`);
    const passengers = list.map((p, i) => ({ id: c.passenger_ids[i], ...parsePassenger(p, i, c.needs_documents) }));
    const hold = raw.hold === true;
    if (hold && !c.hold_allowed) throw bad("this fare can\u2019t be held; it must be paid now");
    if (hold && c.services.length) throw bad("extra bags can\u2019t be added to a held booking here; book and pay now, or hold without bags");
    const input = {
      type: hold ? "hold" : "instant",
      selected_offers: [c.offer_id],
      passengers,
      ...hold ? {} : { payments: [{ type: "balance", amount: amountOf(c.fare + c.bag_cost), currency: c.currency }] },
      ...c.services.length && !hold ? { services: c.services } : {}
    };
    c.used = true;
    const order2 = await deps.client().createOrder(input);
    return orderSummary(order2);
  }
  async function order(raw) {
    return orderSummary(await deps.client().getOrder(String(raw.order_id ?? "")));
  }
  async function cancelQuote(raw) {
    const duffel = deps.client();
    const ord = await duffel.getOrder(String(raw.order_id ?? ""));
    if (ord.cancelled_at) throw new DuffelError("already_cancelled", 409);
    const q = await duffel.quoteCancellation(ord.id);
    return {
      cancellation_id: q.id,
      order_id: ord.id,
      booking_reference: ord.booking_reference,
      refund: q.refund_amount === null ? null : cents(q.refund_amount),
      refund_to: q.refund_to ?? null,
      refund_currency: q.refund_currency ?? ord.total_currency,
      refund_text: q.refund_amount === null ? "The airline hasn\u2019t said how much will be refunded." : `${money(cents(q.refund_amount), q.refund_currency ?? ord.total_currency)} back${q.refund_to ? ` to ${q.refund_to === "balance" ? "the Duffel balance" : q.refund_to.replace(/_/g, " ")}` : ""}`,
      expires_at: q.expires_at
    };
  }
  async function cancelConfirm(raw) {
    if (raw.confirm !== true) throw new FlightInputError("Not confirmed: nothing was cancelled.");
    const q = await deps.client().confirmCancellation(String(raw.cancellation_id ?? ""));
    return { cancelled: Boolean(q.confirmed_at), order_id: q.order_id, refund_text: q.refund_amount === null ? "Refund amount not known yet." : `${money(cents(q.refund_amount), q.refund_currency ?? "USD")} refunded` };
  }
  async function payQuote(raw) {
    const ord = await deps.client().getOrder(String(raw.order_id ?? ""));
    if (!ord.payment_status?.awaiting_payment) throw new DuffelError("invalid_state", 409, "This booking is already paid (or not on hold).");
    return { order_id: ord.id, booking_reference: ord.booking_reference, amount: amountOf(cents(ord.total_amount)), currency: ord.total_currency, total_text: money(cents(ord.total_amount), ord.total_currency), pay_by: ord.payment_status.payment_required_by ?? null };
  }
  async function pay(raw) {
    if (raw.confirm !== true) throw new FlightInputError("Not confirmed: nothing was paid.");
    const duffel = deps.client();
    const ord = await duffel.getOrder(String(raw.order_id ?? ""));
    if (!ord.payment_status?.awaiting_payment) throw new DuffelError("invalid_state", 409, "This booking is already paid (or not on hold).");
    if (cents(raw.amount) !== cents(ord.total_amount) || raw.currency !== ord.total_currency) throw new DuffelError("price_changed", 409, `The price is now ${money(cents(ord.total_amount), ord.total_currency)}. Get the latest price again before paying.`);
    await duffel.createPayment({ order_id: ord.id, payment: { type: "balance", amount: ord.total_amount, currency: ord.total_currency } });
    return orderSummary(await duffel.getOrder(ord.id));
  }
  return { search, check, review, book, order, cancelQuote, cancelConfirm, payQuote, pay, _checks: checks };
}
function orderSummary(o) {
  const ps = o.payment_status;
  const status = o.cancelled_at ? "cancelled" : ps?.awaiting_payment ? "on_hold" : "confirmed";
  return {
    order_id: o.id,
    booking_reference: o.booking_reference,
    status,
    status_text: status === "cancelled" ? "Cancelled" : status === "on_hold" ? `On hold, not paid${ps?.payment_required_by ? `: pay by ${ps.payment_required_by.slice(0, 16).replace("T", " ")} UTC or it\u2019s released` : ""}` : "Booked and paid",
    total_text: money(cents(o.total_amount), o.total_currency),
    slices: o.slices.map(summarizeSlice),
    passengers: o.passengers.map((p) => [p.given_name, p.family_name].filter(Boolean).join(" ")),
    refund: ruleWords(o.conditions?.refund_before_departure, "refund"),
    change: ruleWords(o.conditions?.change_before_departure, "change"),
    tickets: (o.documents ?? []).filter((d) => d.type === "electronic_ticket").map((d) => d.unique_identifier),
    test_mode: o.live_mode === false
  };
}
export {
  CHECK_TTL_MS,
  DuffelError,
  FlightInputError,
  createDuffelClient,
  createFlightService,
  httpStatusFor,
  tokenInfo
};
