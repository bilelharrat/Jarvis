// A fake Duffel Stays server, in the style of duffel-fake.js: the five calls stays.js makes, with the fields Duffel's
// docs show (2026-10-27), the same auth and Duffel-Version checks, the same error shape, and `faults` to force a
// status or a slow answer. Nothing here reaches Duffel.
import { createServer } from 'node:http';

const DAY = 86400_000;
// Lisbon hotels: [name, stars, review score, price a night per room, lat, lng]
const HOTELS = [
  ['Hotel Baixa Fake', 4, 8.7, 140, 38.7118, -9.1384],
  ['Alfama Rooms Fake', 3, 8.1, 95, 38.7110, -9.1300],
  ['Chiado Grand Fake', 5, 9.2, 310, 38.7107, -9.1422],
];

export function startFakeStays() {
  const requests = [];
  const faults = [];
  const results = new Map(); // srr id → { hotel, check_in, check_out, nights, rooms }
  const rates = new Map(); // rat id → { result, total, currency }
  const quotes = new Map();
  const bookings = new Map();
  let n = 0;
  const id = (p) => `${p}_${String(++n).padStart(4, '0')}FAKE${Math.random().toString(36).slice(2, 10)}`;
  const nowIso = () => new Date().toISOString();
  const err = (status, type, code, message) => ({ status, body: { errors: [{ type, code, title: code.replace(/_/g, ' '), message, documentation_url: 'https://duffel.com/docs/api/overview/errors' }], meta: { status, request_id: `req_${n}` } } });
  const notFound = () => err(404, 'invalid_request_error', 'not_found', 'The resource you are trying to access does not exist.');

  const accommodation = (h, hid, extra = {}) => ({
    id: hid,
    name: h[0],
    rating: h[1],
    review_score: h[2],
    review_count: 120,
    photos: [{ url: `https://example.com/${hid}.jpg` }],
    location: { geographic_coordinates: { latitude: h[4], longitude: h[5] }, address: { line_one: '1 Rua Fake', city_name: 'Lisbon', region: 'Lisboa', postal_code: '1100-001', country_code: 'PT' } },
    ...extra,
  });

  function route(method, path, body) {
    const data = body?.data;
    let m;
    if (method === 'POST' && path === '/stays/search') {
      if (!data?.rooms || !data?.guests?.length || !data?.check_in_date || !data?.check_out_date || !data?.location?.geographic_coordinates) return err(422, 'validation_error', 'validation_required', 'rooms, guests, dates and location are required');
      const nights = Math.round((Date.parse(data.check_out_date) - Date.parse(data.check_in_date)) / DAY);
      const list = HOTELS.map((h, i) => {
        const rid = id('srr');
        const hid = `acc_000${i}FAKEhotel${i}`;
        results.set(rid, { hotel: h, hid, check_in: data.check_in_date, check_out: data.check_out_date, nights, rooms: data.rooms });
        return {
          id: rid,
          rooms: data.rooms,
          guests: data.guests,
          check_in_date: data.check_in_date,
          check_out_date: data.check_out_date,
          expires_at: new Date(Date.now() + 30 * 6e4).toISOString(),
          cheapest_rate_total_amount: (h[3] * nights * data.rooms).toFixed(2),
          cheapest_rate_currency: 'EUR',
          accommodation: accommodation(h, hid),
        };
      });
      return { status: 200, body: { data: { results: list, created_at: nowIso() } } };
    }
    if (method === 'POST' && (m = /^\/stays\/search_results\/(\w+)\/actions\/fetch_all_rates$/.exec(path))) {
      const r = results.get(m[1]);
      if (!r) return notFound();
      const base = r.hotel[3] * r.nights * r.rooms;
      const checkIn = Date.parse(`${r.check_in}T14:00:00Z`);
      const rate = (total, timeline, board) => {
        const rid = id('rat');
        rates.set(rid, { result: r, total: total.toFixed(2), currency: 'EUR' });
        return { id: rid, total_amount: total.toFixed(2), total_currency: 'EUR', public_amount: total.toFixed(2), board_type: board, payment_type: 'pay_now', conditions: [{ title: 'Pets', description: 'No pets allowed.' }], cancellation_timeline: timeline, expires_at: new Date(Date.now() + 30 * 6e4).toISOString() };
      };
      // the flexible rate: full refund until 3 days before, half until the day before (given out of order on purpose)
      const flexible = rate(base * 1.15, [
        { refund_amount: (base * 1.15 / 2).toFixed(2), currency: 'EUR', before: new Date(checkIn - DAY).toISOString() },
        { refund_amount: (base * 1.15).toFixed(2), currency: 'EUR', before: new Date(checkIn - 3 * DAY).toISOString() },
      ], 'breakfast');
      const saver = rate(base, [], 'room_only'); // empty timeline: not refundable
      return { status: 200, body: { data: { id: m[1], expires_at: new Date(Date.now() + 30 * 6e4).toISOString(), accommodation: accommodation(r.hotel, r.hid, { rooms: [{ name: 'Double Room', beds: [{ type: 'double', count: 1 }], photos: [{ url: 'https://example.com/room.jpg' }], rates: [saver, flexible] }] }) } } };
    }
    if (method === 'POST' && path === '/stays/quotes') {
      const rt = rates.get(data?.rate_id);
      if (!rt) return notFound();
      const q = { id: id('quo'), total_amount: rt.total, total_currency: rt.currency, base_amount: (Number(rt.total) * 0.9).toFixed(2), base_currency: 'EUR', tax_amount: (Number(rt.total) * 0.1).toFixed(2), tax_currency: 'EUR', fee_amount: '0.00', fee_currency: 'EUR', due_at_accommodation_amount: '4.00', due_at_accommodation_currency: 'EUR', check_in_date: rt.result.check_in, check_out_date: rt.result.check_out, accommodation: accommodation(rt.result.hotel, rt.result.hid), _rate: rt };
      quotes.set(q.id, q);
      const { _rate, ...pub } = q;
      void _rate;
      return { status: 201, body: { data: pub } };
    }
    if (method === 'POST' && path === '/stays/bookings') {
      const q = quotes.get(data?.quote_id);
      if (!q) return notFound();
      if (data.payment) return err(422, 'validation_error', 'validation_not_allowed', 'payment must be omitted to pay from the balance');
      if (!Array.isArray(data.guests) || !data.guests.length || !data.guests.every((g) => g.given_name && g.family_name)) return err(422, 'validation_error', 'validation_required', 'guests are required');
      if (!data.email || !/^\+\d+$/.test(data.phone_number || '')) return err(422, 'validation_error', 'validation_format', 'email and an E.164 phone_number are required');
      const b = { id: id('bok'), reference: `FAKE${String(n).padStart(5, '0')}`, status: 'confirmed', confirmed_at: nowIso(), cancelled_at: null, check_in_date: q.check_in_date, check_out_date: q.check_out_date, accommodation: q.accommodation, guests: data.guests, email: data.email, phone_number: data.phone_number, metadata: null };
      bookings.set(b.id, b);
      quotes.delete(q.id); // a quote books once
      return { status: 201, body: { data: b } };
    }
    if (method === 'GET' && (m = /^\/stays\/bookings\/(\w+)$/.exec(path))) {
      const b = bookings.get(m[1]);
      return b ? { status: 200, body: { data: b } } : notFound();
    }
    return notFound();
  }

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const text = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      const rec = { method: req.method ?? 'GET', path: url.pathname, headers: req.headers, body };
      requests.push(rec);
      const reply = (status, b, headers = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': `req_${requests.length}`, ...headers });
        res.end(b === null ? '' : typeof b === 'string' ? b : JSON.stringify(b));
      };
      const fi = faults.findIndex((f) => !f.match || `${rec.method} ${rec.path}`.startsWith(f.match));
      if (fi >= 0) {
        const f = faults.splice(fi, 1)[0];
        if (f.delayMs) await new Promise((r) => setTimeout(r, f.delayMs));
        if (!res.destroyed) reply(f.status, f.body ?? null, f.headers);
        return;
      }
      if (!/^Bearer duffel_(test|live)_\w+/.test(String(req.headers.authorization ?? ''))) {
        const e = err(401, 'authentication_error', 'missing_authorization_header', 'The Authorization header is missing or invalid');
        return reply(e.status, e.body);
      }
      if (req.headers['duffel-version'] !== 'v2') {
        const e = err(400, 'invalid_request_error', 'missing_version_header', 'Duffel-Version header is required');
        return reply(e.status, e.body);
      }
      const out = route(rec.method, rec.path, body);
      reply(out.status, out.body);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, requests, faults, results, rates, quotes, bookings, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) });
    });
  });
}
