// The fake Duffel server, from askeden 17200a1 src/__tests__/duffel-fake.ts (bundled with askeden's esbuild). Generated: edit it there.
// src/__tests__/duffel-fake.ts
import { createServer } from "node:http";
var place = (iata, country, city, tz) => ({ type: "airport", iata_code: iata, iata_country_code: country, name: `${city} Airport`, city_name: city, time_zone: tz });
var AIRPORTS = {
  JFK: place("JFK", "US", "New York", "America/New_York"),
  LGA: place("LGA", "US", "New York", "America/New_York"),
  BOS: place("BOS", "US", "Boston", "America/New_York"),
  LHR: place("LHR", "GB", "London", "Europe/London"),
  DUB: place("DUB", "IE", "Dublin", "Europe/Dublin"),
  KEF: place("KEF", "IS", "Reykjavik", "Atlantic/Reykjavik"),
  SFO: place("SFO", "US", "San Francisco", "America/Los_Angeles"),
  LAX: place("LAX", "US", "Los Angeles", "America/Los_Angeles")
};
var airport = (c) => AIRPORTS[c] ?? place(c, "US", c, "America/New_York");
var carrier = (name, iata) => ({ name, iata_code: iata, logo_symbol_url: null });
var iso = (date, hours) => {
  const d = /* @__PURE__ */ new Date(`${date}T00:00:00Z`);
  d.setUTCMinutes(Math.round(hours * 60));
  return d.toISOString().slice(0, 19);
};
var dur = (min) => `PT${Math.floor(min / 60)}H${min % 60}M`;
function templates(o, d) {
  const BA = ["British Airways", "BA"];
  const AA = ["American Airlines", "AA"];
  const B6 = ["JetBlue", "B6"];
  const FI = ["Icelandair", "FI"];
  return [
    // nonstop, a bag included, refundable for a fee
    { key: "direct", perPerson: 540, legs: [{ from: o, to: d, dep: 8.5, arr: 15.5, carrier: BA, flight: "178" }], bags: 1, refund: { allowed: true, penalty_amount: "150.00", penalty_currency: "USD" }, change: { allowed: true, penalty_amount: "0.00", penalty_currency: "USD" }, hold: true, docs: true },
    // cheapest fare: one stop, tight 50-minute layover, no bags, no refund
    { key: "cheap", perPerson: 420, legs: [{ from: o, to: "BOS", dep: 9, arr: 10.25, carrier: B6, flight: "417" }, { from: "BOS", to: d, dep: 11.083, arr: 19, carrier: AA, flight: "108" }], bags: 0, refund: { allowed: false, penalty_amount: null, penalty_currency: null }, change: { allowed: true, penalty_amount: "75.00", penalty_currency: "USD" }, hold: false, docs: true },
    // nonstop but leaves at 05:00
    { key: "dawn", perPerson: 470, legs: [{ from: o, to: d, dep: 5, arr: 12, carrier: AA, flight: "100" }], bags: 0, refund: null, change: null, hold: false, docs: true },
    // long overnight layover in Reykjavik
    { key: "overnight", perPerson: 400, legs: [{ from: o, to: "KEF", dep: 20, arr: 25.5, carrier: FI, flight: "614" }, { from: "KEF", to: d, dep: 40, arr: 43, carrier: FI, flight: "450" }], bags: 1, refund: { allowed: false }, change: { allowed: false }, hold: false, docs: true },
    // two stops: dropped when at most one stop is wanted
    { key: "twostop", perPerson: 360, legs: [{ from: o, to: "BOS", dep: 6.5, arr: 7.75, carrier: B6, flight: "1" }, { from: "BOS", to: "DUB", dep: 9, arr: 16, carrier: AA, flight: "2" }, { from: "DUB", to: d, dep: 18, arr: 19.5, carrier: AA, flight: "3" }], bags: 0, refund: null, change: null, hold: false, docs: true }
  ];
}
function startFakeDuffel() {
  const requests = [];
  const faults = [];
  const offers = /* @__PURE__ */ new Map();
  const orders = /* @__PURE__ */ new Map();
  const cancellations = /* @__PURE__ */ new Map();
  const changes = /* @__PURE__ */ new Map();
  const repriced = /* @__PURE__ */ new Map();
  let n = 0;
  const id = (p) => `${p}_${String(++n).padStart(4, "0")}FAKE${Math.random().toString(36).slice(2, 10)}`;
  const nowIso = () => (/* @__PURE__ */ new Date()).toISOString();
  const err = (status, type, code, message, source) => ({ status, body: { errors: [{ type, code, title: code.replace(/_/g, " "), message, documentation_url: "https://duffel.com/docs/api/overview/errors", ...source ? { source } : {} }], meta: { status, request_id: `req_${n}` } } });
  function makeOffer(t, slicesReq, pax) {
    const passengers = pax.map((p) => ({ id: id("pas"), ...p.type ? { type: p.type } : { age: p.age } }));
    const slices = slicesReq.map((s, si) => {
      const rev = [...t.legs].reverse();
      const legs = si === 0 ? t.legs : t.legs.map((l, i) => ({ ...l, from: rev[i].to, to: rev[i].from }));
      const segments = legs.map((l) => ({
        id: id("seg"),
        origin: airport(l.from),
        destination: airport(l.to),
        departing_at: iso(s.departure_date, l.dep),
        arriving_at: iso(s.departure_date, l.arr),
        duration: dur(Math.round((l.arr - l.dep) * 60)),
        marketing_carrier: carrier(...l.carrier),
        operating_carrier: carrier(...l.carrier),
        marketing_carrier_flight_number: l.flight,
        passengers: passengers.map((p) => ({ passenger_id: p.id, cabin_class: "economy", baggages: [{ type: "checked", quantity: t.bags }, { type: "carry_on", quantity: 1 }] }))
      }));
      const first = legs[0], last = legs[legs.length - 1];
      return { id: id("sli"), origin: airport(first.from), destination: airport(last.to), duration: dur(Math.round((last.arr - first.dep) * 60)), fare_brand_name: "Basic", segments };
    });
    const total = (t.perPerson * passengers.length * slicesReq.length).toFixed(2);
    const offer = {
      id: id("off"),
      live_mode: false,
      total_amount: total,
      total_currency: "USD",
      base_amount: (Number(total) * 0.8).toFixed(2),
      tax_amount: (Number(total) * 0.2).toFixed(2),
      expires_at: new Date(Date.now() + 30 * 6e4).toISOString(),
      owner: carrier(...t.legs[0].carrier),
      slices,
      passengers,
      conditions: { refund_before_departure: t.refund, change_before_departure: t.change },
      payment_requirements: { requires_instant_payment: !t.hold, price_guarantee_expires_at: t.hold ? new Date(Date.now() + 864e5).toISOString() : null, payment_required_by: t.hold ? new Date(Date.now() + 3 * 864e5).toISOString() : null },
      passenger_identity_documents_required: false,
      _key: t.key,
      _services: slices.flatMap((s) => passengers.map((p) => ({ id: id("ase"), type: "baggage", total_amount: "60.00", total_currency: "USD", maximum_quantity: 2, passenger_ids: [p.id], segment_ids: s.segments.map((g) => g.id), metadata: { type: "checked", maximum_weight_kg: 23 } })))
    };
    offers.set(offer.id, offer);
    return offer;
  }
  const publicOffer = (o, services) => {
    const { _key, _services, ...rest } = o;
    void _key;
    return services ? { ...rest, available_services: _services } : rest;
  };
  function route(method, path, q, body) {
    const data = body?.data;
    let m;
    if (method === "POST" && path === "/air/offer_requests") {
      if (!data?.slices?.length || !data?.passengers?.length) return err(422, "validation_error", "validation_required", "slices and passengers are required", { field: "slices", pointer: "/data/slices" });
      const s0 = data.slices[0];
      const list = templates(s0.origin, s0.destination).map((t) => makeOffer(t, data.slices, data.passengers));
      return { status: 201, body: { data: { id: id("orq"), live_mode: false, cabin_class: data.cabin_class ?? null, slices: data.slices, passengers: list[0]?.passengers ?? [], offers: list.map((o) => publicOffer(o, false)) } } };
    }
    if (method === "GET" && (m = /^\/air\/offers\/([\w]+)$/.exec(path))) {
      const o = offers.get(m[1]);
      if (!o) return err(404, "invalid_request_error", "not_found", "The resource you are trying to access does not exist.");
      if (repriced.has(o.id)) {
        o.total_amount = repriced.get(o.id);
        repriced.delete(o.id);
      }
      return { status: 200, body: { data: publicOffer(o, q.return_available_services === "true") } };
    }
    if (method === "GET" && path === "/air/seat_maps") {
      const o = offers.get(q.offer_id);
      if (!o) return err(404, "invalid_request_error", "not_found", "not found");
      return { status: 200, body: { data: o.slices.flatMap((s) => s.segments.map((g) => ({ id: id("sea"), slice_id: s.id, segment_id: g.id, cabins: [{ deck: 0, aisles: 1, wings: null, rows: [{ sections: [{ elements: [{ type: "seat", designator: "12A", name: "", disclosures: [], available_services: o.passengers.map((p) => ({ id: id("ase"), passenger_id: p.id, total_amount: "25.00", total_currency: "USD" })) }, { type: "seat", designator: "12B", disclosures: [], available_services: [] }] }] }] }] }))) } };
    }
    if (method === "POST" && path === "/air/orders") {
      const o = offers.get(data?.selected_offers?.[0]);
      if (!o) return err(422, "airline_error", "offer_no_longer_available", "The offer is no longer available");
      if (!Array.isArray(data.passengers) || data.passengers.length !== o.passengers.length) return err(422, "validation_error", "validation_required", "passengers must match the offer", { field: "passengers", pointer: "/data/passengers" });
      for (const [i, p] of data.passengers.entries()) {
        if (!o.passengers.some((x) => x.id === p.id)) return err(422, "validation_error", "invalid_passenger", `passenger ${p.id} isn't on the offer`, { field: "id", pointer: `/data/passengers/${i}/id` });
        if (p.email === "reject@example.com") return err(422, "validation_error", "validation_format", `Email ${p.email} is invalid for ${p.given_name} ${p.family_name}`, { field: "email", pointer: `/data/passengers/${i}/email` });
      }
      const services = data.services ?? [];
      const svcTotal = services.reduce((t, s) => t + Number(o._services.find((x) => x.id === s.id)?.total_amount ?? NaN) * s.quantity, 0);
      const due = (Number(o.total_amount) + svcTotal).toFixed(2);
      if (data.type === "hold") {
        if (o.payment_requirements.requires_instant_payment) return err(422, "validation_error", "unsupported_order_type", "This offer requires instant payment");
        if (data.payments) return err(422, "validation_error", "validation_not_allowed", "payments not allowed on a hold order");
      } else {
        const pay = data.payments?.[0];
        if (!pay || pay.type !== "balance") return err(422, "validation_error", "validation_required", "payments required", { field: "payments", pointer: "/data/payments" });
        if (pay.amount !== due || pay.currency !== o.total_currency) return err(422, "airline_error", "price_changed", "The price of this offer has changed");
      }
      const order = {
        id: id("ord"),
        live_mode: false,
        booking_reference: `RZ${String(n).padStart(4, "0")}`,
        total_amount: due,
        total_currency: o.total_currency,
        owner: o.owner,
        slices: o.slices,
        passengers: data.passengers.map((p) => ({ id: p.id, given_name: p.given_name, family_name: p.family_name, title: p.title, born_on: p.born_on })),
        conditions: o.conditions,
        services: services.map((s) => ({ id: s.id, quantity: s.quantity, type: "baggage" })),
        payment_status: data.type === "hold" ? { awaiting_payment: true, payment_required_by: o.payment_requirements.payment_required_by, price_guarantee_expires_at: o.payment_requirements.price_guarantee_expires_at, paid_at: null } : { awaiting_payment: false, payment_required_by: null, price_guarantee_expires_at: null, paid_at: nowIso() },
        documents: data.type === "hold" ? [] : [{ type: "electronic_ticket", unique_identifier: `125${n}000000` }],
        cancelled_at: null,
        created_at: nowIso()
      };
      orders.set(order.id, order);
      offers.delete(o.id);
      return { status: 201, body: { data: order } };
    }
    if (method === "GET" && (m = /^\/air\/orders\/([\w]+)$/.exec(path))) {
      const o = orders.get(m[1]);
      return o ? { status: 200, body: { data: o } } : err(404, "invalid_request_error", "not_found", "not found");
    }
    if (method === "POST" && path === "/air/payments") {
      const o = orders.get(data?.order_id);
      if (!o) return err(404, "invalid_request_error", "not_found", "not found");
      if (!o.payment_status.awaiting_payment) return err(422, "invalid_state_error", "already_paid", "already paid");
      if (data.payment?.amount !== o.total_amount || data.payment?.currency !== o.total_currency) return err(422, "airline_error", "price_changed", "price changed");
      o.payment_status = { awaiting_payment: false, payment_required_by: null, price_guarantee_expires_at: null, paid_at: nowIso() };
      o.documents = [{ type: "electronic_ticket", unique_identifier: `125${n}111111` }];
      return { status: 201, body: { data: { id: id("pay"), amount: data.payment.amount, currency: data.payment.currency, type: "balance", created_at: nowIso() } } };
    }
    if (method === "POST" && path === "/air/order_cancellations") {
      const o = orders.get(data?.order_id);
      if (!o) return err(404, "invalid_request_error", "not_found", "not found");
      if (o.cancelled_at) return err(422, "invalid_state_error", "already_cancelled", "already cancelled");
      const refundable = o.conditions?.refund_before_departure?.allowed;
      const c = { id: id("ore"), order_id: o.id, live_mode: false, refund_amount: refundable ? (Number(o.total_amount) - Number(o.conditions.refund_before_departure.penalty_amount ?? 0)).toFixed(2) : "0.00", refund_currency: o.total_currency, refund_to: "balance", expires_at: new Date(Date.now() + 15 * 6e4).toISOString(), confirmed_at: null, airline_credits: [], created_at: nowIso() };
      cancellations.set(c.id, c);
      return { status: 201, body: { data: c } };
    }
    if (method === "POST" && (m = /^\/air\/order_cancellations\/([\w]+)\/actions\/confirm$/.exec(path))) {
      const c = cancellations.get(m[1]);
      if (!c) return err(404, "invalid_request_error", "not_found", "not found");
      c.confirmed_at = nowIso();
      orders.get(c.order_id).cancelled_at = c.confirmed_at;
      return { status: 200, body: { data: c } };
    }
    if (method === "POST" && path === "/air/order_change_requests") {
      const o = orders.get(data?.order_id);
      if (!o) return err(404, "invalid_request_error", "not_found", "not found");
      return { status: 201, body: { data: { id: id("ocr"), order_id: o.id, live_mode: false, slices: data.slices, order_change_offers: [{ id: id("oco"), change_total_amount: "80.00", change_total_currency: "USD", new_total_amount: (Number(o.total_amount) + 80).toFixed(2), new_total_currency: "USD", penalty_total_amount: "75.00", expires_at: new Date(Date.now() + 15 * 6e4).toISOString() }] } } };
    }
    if (method === "POST" && path === "/air/order_changes") {
      const c = { id: id("oce"), order_id: "ord_unknown", selected_order_change_offer: data?.selected_order_change_offer, change_total_amount: "80.00", change_total_currency: "USD", confirmed_at: null };
      changes.set(c.id, c);
      return { status: 201, body: { data: c } };
    }
    if (method === "POST" && (m = /^\/air\/order_changes\/([\w]+)\/actions\/confirm$/.exec(path))) {
      const c = changes.get(m[1]);
      if (!c) return err(404, "invalid_request_error", "not_found", "not found");
      if (data?.payment?.amount !== c.change_total_amount) return err(422, "validation_error", "validation_format", "payment amount must match");
      c.confirmed_at = nowIso();
      return { status: 200, body: { data: c } };
    }
    return err(404, "invalid_request_error", "not_found", "The resource you are trying to access does not exist.");
  }
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const text = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      const rec = { method: req.method ?? "GET", path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body };
      requests.push(rec);
      const reply = (status, b, headers = {}) => {
        res.writeHead(status, { "content-type": "application/json", "x-request-id": `req_${requests.length}`, ...headers });
        res.end(b === null ? "" : typeof b === "string" ? b : JSON.stringify(b));
      };
      const fi = faults.findIndex((f) => !f.match || `${rec.method} ${rec.path}`.startsWith(f.match));
      if (fi >= 0) {
        const f = faults.splice(fi, 1)[0];
        if (f.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
        if (!res.destroyed) reply(f.status, f.body ?? null, f.headers);
        return;
      }
      const auth = String(req.headers.authorization ?? "");
      if (!/^Bearer duffel_(test|live)_\w+/.test(auth)) {
        const e = err(401, "authentication_error", "missing_authorization_header", "The Authorization header is missing or invalid");
        reply(e.status, e.body);
        return;
      }
      if (req.headers["duffel-version"] !== "v2") {
        const e = err(400, "invalid_request_error", "missing_version_header", "Duffel-Version header is required");
        reply(e.status, e.body);
        return;
      }
      const out = route(rec.method, rec.path, rec.query, body);
      reply(out.status, out.body);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, requests, faults, offers, orders, repriced, close: () => new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }) });
    });
  });
}
export {
  startFakeDuffel
};
