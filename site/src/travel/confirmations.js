// Booking confirmations read from Eden Mail (the person's Gmail, connected in Mail): the
// structured reservation data airlines, hotels, rail and car-hire firms put in their emails
// (schema.org JSON-LD: FlightReservation, LodgingReservation, TrainReservation, …), never a
// model's guess. An email without it gives only what can be read plainly (a reference after
// "booking reference", "confirmation number"…), marked `structured: false` so the card says
// to check it. Mail is untrusted data: only these fields are read, each capped, nothing in it
// is followed or run.

export const MAIL_QUERY = '(confirmation OR confirmed OR reservation OR booking OR itinerary OR e-ticket) -in:sent newer_than:400d';
export const SCAN_LIMIT = 15;

const TYPES = {
  FlightReservation: 'transport', TrainReservation: 'transport', BusReservation: 'transport', BoatReservation: 'transport',
  RentalCarReservation: 'transport', TaxiReservation: 'transport',
  LodgingReservation: 'stay', FoodEstablishmentReservation: 'meal', EventReservation: 'activity', Reservation: 'activity',
};
const cap = (v, n = 120) => (v == null ? '' : String(typeof v === 'object' ? v.name || '' : v).replace(/\s+/g, ' ').trim().slice(0, n));
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

// ── reading a Gmail message (format=full) ──

const b64url = (s) => {
  const bin = atob(String(s || '').replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};
/** The message's HTML and plain text parts, its subject, sender and date. */
export function messageParts(m) {
  const out = { html: '', text: '', subject: '', from: '', date: null, id: m.id };
  const headers = (m.payload && m.payload.headers) || [];
  const h = (n) => (headers.find((x) => String(x.name).toLowerCase() === n) || {}).value || '';
  out.subject = cap(h('subject'), 200);
  out.from = cap(h('from'), 160);
  out.date = m.internalDate ? new Date(Number(m.internalDate)).toISOString() : null;
  const walk = (p, depth = 0) => {
    if (!p || depth > 8) return;
    const type = String(p.mimeType || '').toLowerCase();
    if (p.body && p.body.data && (type === 'text/html' || type === 'text/plain')) {
      try {
        const s = b64url(p.body.data).slice(0, 2_000_000);
        if (type === 'text/html') out.html += s; else out.text += s;
      } catch { /* a part that isn't base64url: skipped */ }
    }
    for (const c of p.parts || []) walk(c, depth + 1);
  };
  walk(m.payload);
  return out;
}

// ── schema.org reservations ──

/** Every reservation in the HTML's JSON-LD blocks (an @graph or a list too). */
export function jsonLdReservations(html) {
  const found = [];
  const re = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  let blocks = 0;
  while ((m = re.exec(String(html || ''))) && blocks++ < 20) {
    let data;
    try { data = JSON.parse(m[1].replace(/&quot;/g, '"').trim()); } catch { continue; }
    const visit = (x, depth = 0) => {
      if (depth > 4 || x == null) return;
      if (Array.isArray(x)) return x.slice(0, 20).forEach((y) => visit(y, depth + 1));
      if (!isObj(x)) return;
      if (Array.isArray(x['@graph'])) visit(x['@graph'], depth + 1);
      const type = [].concat(x['@type'] || []).map(String).find((t) => TYPES[t]);
      if (type) found.push(reservation(type, x));
    };
    visit(data);
  }
  return found.filter(Boolean);
}

const when = (v) => {
  const t = Date.parse(String(v || ''));
  return Number.isFinite(t) ? String(v).slice(0, 25) : null;
};
const localDate = (v) => (v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
const localTime = (v) => (v && /T\d{2}:\d{2}/.test(v) ? v.slice(11, 16) : null);
function priceOf(x) {
  const amount = Number(x.totalPrice ?? x.price ?? (isObj(x.priceSpecification) ? x.priceSpecification.price : undefined));
  const currency = cap(x.priceCurrency || (isObj(x.priceSpecification) ? x.priceSpecification.priceCurrency : ''), 3).toUpperCase();
  return Number.isFinite(amount) && amount >= 0 && /^[A-Z]{3}$/.test(currency) ? { amount: Math.round(amount * 100) / 100, currency } : null;
}
function placeOf(p) {
  if (!isObj(p)) return null;
  const geo = isObj(p.geo) ? p.geo : {};
  const addr = isObj(p.address) ? [p.address.streetAddress, p.address.addressLocality, p.address.addressCountry && cap(p.address.addressCountry, 40)].filter(Boolean).map((s) => cap(s, 80)).join(', ') : cap(p.address, 160);
  const lat = Number(geo.latitude), lng = Number(geo.longitude);
  return { name: cap(p.name, 120) || cap(p.iataCode, 10), address: addr, ...(Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : {}) };
}

/** One schema.org reservation → { kind, type, ref, provider, title, start, end, date, at, place, cost, status, flight? }. */
export function reservation(type, x) {
  const f = isObj(x.reservationFor) ? x.reservationFor : {};
  const base = {
    kind: TYPES[type], type, ref: cap(x.reservationNumber || x.confirmationNumber, 80),
    provider: cap(x.provider || x.broker || f.provider || f.airline, 80),
    status: cap(String(x.reservationStatus || '').replace(/^https?:\/\/schema\.org\//, ''), 40) || null,
    cost: priceOf(x), structured: true,
  };
  let start = null, end = null, place = null, title = '', flight = null;
  switch (type) {
    case 'FlightReservation': {
      const air = isObj(f.airline) ? f.airline : {};
      const code = cap(air.iataCode, 3).toUpperCase();
      const num = cap(f.flightNumber, 6).replace(/\D/g, '');
      flight = code && num ? `${code}${num}` : null;
      start = when(f.departureTime); end = when(f.arrivalTime);
      const from = placeOf(f.departureAirport), to = placeOf(f.arrivalAirport);
      place = from;
      title = `Flight ${flight || ''} ${from ? from.name : ''} → ${to ? to.name : ''}`.replace(/\s+/g, ' ').trim();
      if (!base.provider) base.provider = cap(air.name, 80);
      break;
    }
    case 'LodgingReservation':
      start = when(x.checkinTime || x.checkinDate); end = when(x.checkoutTime || x.checkoutDate);
      place = placeOf(f); title = place ? place.name : 'Stay';
      break;
    case 'RentalCarReservation':
      start = when(x.pickupTime); end = when(x.dropoffTime);
      place = placeOf(x.pickupLocation); title = `Car hire${base.provider ? ` with ${base.provider}` : ''}`;
      break;
    case 'TaxiReservation':
      start = when(x.pickupTime); place = placeOf(x.pickupLocation); title = 'Taxi';
      break;
    case 'FoodEstablishmentReservation':
      start = when(x.startTime); place = placeOf(f); title = place ? place.name : 'Table booking';
      break;
    default: // trains, buses, boats, events
      start = when(f.departureTime || f.startDate || x.startTime); end = when(f.arrivalTime || f.endDate);
      place = placeOf(f.departureStation || f.departureBusStop || f.departureBoatTerminal || f.location);
      title = cap(f.name, 120) || `${type.replace('Reservation', '')}${place ? ` from ${place.name}` : ''}`;
  }
  return { ...base, title: cap(title, 120), start, end, date: localDate(start), at: localTime(start), place, flight, nights: type === 'LodgingReservation' && localDate(start) && localDate(end) ? Math.max(1, Math.round((Date.parse(localDate(end)) - Date.parse(localDate(start))) / 86400_000)) : null };
}

// ── plain text, when there is no structured data ──

const REF = /\b(?:booking|confirmation|reservation|reference|record locator|pnr)\s*(?:no\.?|number|code|ref(?:erence)?|#)?\s*[:#]?\s*([A-Z0-9]{5,12})\b/i;
/** A reference read from the words, and nothing else: no dates or prices are guessed. */
export function plainBooking(parts) {
  const words = `${parts.subject}\n${parts.text || parts.html.replace(/<[^>]+>/g, ' ')}`.slice(0, 200_000);
  const m = REF.exec(words);
  if (!m || !/\d/.test(m[1])) return null;
  const sender = /^"?([^"<]+?)"?\s*</.exec(parts.from);
  return { kind: null, type: null, ref: m[1].toUpperCase(), provider: cap(sender ? sender[1] : parts.from, 80), title: cap(parts.subject, 120), start: null, end: null, date: null, at: null, place: null, cost: null, status: null, flight: null, nights: null, structured: false };
}

/** What one email holds: [booking], structured ones first. */
export function bookingsIn(parts) {
  const structured = jsonLdReservations(parts.html);
  if (structured.length) return structured;
  const plain = plainBooking(parts);
  return plain ? [plain] : [];
}

// ── matching to a trip ──

const words = (s) => new Set(String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\W+/).filter((w) => w.length > 3));
/**
 * Where a booking goes in the trip: { action: 'mark', stop, day } for a stop it confirms (same day,
 * same kind or a shared name word, not already booked), { action: 'add', day, at } for a dated
 * booking within the trip, or { action: 'none', why }.
 */
export function matchBooking(trip, b) {
  if (!b.date) return { action: 'none', why: 'No date in this email: say which stop it belongs to.' };
  const first = Date.parse(`${trip.start}T00:00:00Z`);
  const day = Math.round((Date.parse(`${b.date}T00:00:00Z`) - first) / 86400_000);
  if (day < 0 || day >= trip.days.length) return { action: 'none', why: `This booking is for ${b.date}, outside this trip.` };
  const w = words(`${b.title} ${b.place ? b.place.name : ''}`);
  const stop = trip.days[day].stops.find((s) => !s.booked && ((b.kind && s.kind === b.kind) || [...words(s.place.name)].some((x) => w.has(x))));
  if (stop) return { action: 'mark', stop: stop.id, day };
  return { action: 'add', day, at: b.at || '12:00' };
}
