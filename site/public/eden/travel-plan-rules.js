// Eden Travel, planning by hand: the pure rules behind travel-plan.js (no DOM, no imports, so the tests load it as is).
// A new trip from the plain form, a stop's edits as the server's edit ops (only what changed), a city leg (a transport
// stop at the person's own time, and the days after named for the new city), and the packing list: each item from a
// rule with its reason (the checked forecast with its source and day, the stop's own words, nights, travellers).
// Nothing here guesses: no forecast means "no forecast yet", a beach item needs "beach" in the stop's own name or note.

export const LIMITS = { days: 30, travelers: 20, title: 120, note: 500, minutes: 1440, money: 1e6 };
export const KINDS = ['visit', 'meal', 'activity', 'stay', 'transport', 'rental'];
export const MODES = ['walk', 'transit', 'drive', 'taxi'];
export const LEG_MODES = { flight: 'Flight', train: 'Train', bus: 'Bus', ferry: 'Ferry', car: 'Drive' };
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CUR = /^[A-Z]{3}$/;
const clean = (s, cap) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, cap);
const whole = (v) => (String(v ?? '').trim() === '' ? NaN : Number(v));

/** A day's date from the trip's start (UTC, as the server counts it). */
export function dayDate(start, i) {
  const d = new Date(`${start}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + i);
  return d.toISOString().slice(0, 10);
}
export const dayShort = (date) => (date ? new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');

/** An amount and currency typed in, or null when the amount is empty. { error } when it can't be a price. */
export function moneyOf(amount, currency) {
  if (String(amount ?? '').trim() === '') return { value: null };
  const n = Number(String(amount).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > LIMITS.money) return { error: 'The amount must be a number from 0 to 1,000,000.' };
  const cur = String(currency || '').trim().toUpperCase();
  if (!CUR.test(cur)) return { error: 'The currency must be a 3-letter code, like EUR or USD.' };
  return { value: { amount: Math.round(n * 100) / 100, currency: cur } };
}

/** The plain "New trip" form → { trip } for the server's create, or { error, field }. */
export function newTrip(f = {}) {
  const title = clean(f.title, LIMITS.title);
  if (!title) return { error: 'Give the trip a name.', field: 'title' };
  const destination = clean(f.destination, 120);
  const start = String(f.start || '');
  if (!DATE.test(start) || Number.isNaN(Date.parse(`${start}T00:00:00Z`))) return { error: 'Choose the first day.', field: 'start' };
  const days = whole(f.days);
  if (!Number.isInteger(days) || days < 1 || days > LIMITS.days) return { error: `A trip has 1 to ${LIMITS.days} days.`, field: 'days' };
  const travelers = String(f.travelers ?? '').trim() === '' ? 1 : whole(f.travelers);
  if (!Number.isInteger(travelers) || travelers < 1 || travelers > LIMITS.travelers) return { error: `Travellers: 1 to ${LIMITS.travelers}.`, field: 'travelers' };
  const budget = moneyOf(f.budget, f.currency || 'EUR');
  if (budget.error) return { error: `Budget: ${budget.error}`, field: 'budget' };
  return { trip: { title, destination, start, travelers, budget: budget.value, days: Array.from({ length: days }, () => ({ stops: [] })) } };
}

/** A stop's edit form → the server's ops for what changed only ({ ops: [] } when nothing did), or { error, field }.
 *  The server refuses time, length, mode and cost on a booked stop (its message is shown); the note can always change. */
export function stopEditOps(stop, f = {}) {
  const ops = [];
  const at = String(f.at ?? stop.at);
  if (!TIME.test(at)) return { error: 'The time must be HH:MM, 24-hour.', field: 'at' };
  if (at !== stop.at) ops.push({ op: 'time', stop: stop.id, at });
  const edit = {};
  const minutes = f.minutes === undefined ? stop.minutes : whole(f.minutes);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > LIMITS.minutes) return { error: 'Length: whole minutes from 0 to 1440.', field: 'minutes' };
  if (minutes !== stop.minutes) edit.minutes = minutes;
  const mode = f.mode === undefined ? stop.mode : String(f.mode);
  if (!MODES.includes(mode)) return { error: 'Choose how you get there.', field: 'mode' };
  if (mode !== (stop.mode || 'walk')) edit.mode = mode;
  if (f.amount !== undefined || f.currency !== undefined) {
    const cost = moneyOf(f.amount, f.currency || (stop.cost && stop.cost.currency) || 'EUR');
    if (cost.error) return { error: `Cost: ${cost.error}`, field: 'cost' };
    const was = stop.cost || null, now = cost.value;
    if (JSON.stringify(was && { amount: was.amount, currency: was.currency }) !== JSON.stringify(now)) edit.cost = now;
  }
  if (f.note !== undefined) {
    const note = clean(f.note, LIMITS.note);
    if (note !== (stop.note || '')) edit.note = note;
  }
  if (Object.keys(edit).length) ops.push({ op: 'edit', stop: stop.id, ...edit });
  return { ops };
}

/** A stop picked from the place search, with the person's day, time, length and kind → the server's add op. */
export function addStopOp(place, f = {}, dayCount = 1) {
  if (!place || !clean(place.name, 120)) return { error: 'Choose a place first.' };
  const day = whole(f.day);
  if (!Number.isInteger(day) || day < 0 || day >= dayCount) return { error: 'Choose a day.', field: 'day' };
  const at = String(f.at || '');
  if (!TIME.test(at)) return { error: 'Enter the time, HH:MM.', field: 'at' };
  const minutes = whole(f.minutes ?? 60);
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > LIMITS.minutes) return { error: 'Length: whole minutes from 0 to 1440.', field: 'minutes' };
  const kind = KINDS.includes(f.kind) ? f.kind : 'visit';
  const stop = { place: { id: place.id || null, name: clean(place.name, 120), lat: Number.isFinite(place.lat) ? place.lat : null, lng: Number.isFinite(place.lng) ? place.lng : null }, at, minutes, kind };
  if (kind === 'stay') {
    const nights = whole(f.nights ?? 1);
    if (!Number.isInteger(nights) || nights < 1 || nights > 60) return { error: 'Nights: 1 to 60.', field: 'nights' };
    stop.nights = nights;
  }
  return { op: { op: 'add', day, stop } };
}

/** "Travel to another city": a getting-there stop at the time the person enters (never one Eden makes up), and the
 *  days after it named for the new city (a day's own title is kept after the city). → { ops } or { error, field }. */
export function legOps(trip, f = {}) {
  const from = clean(f.from, 50), to = clean(f.to, 50);
  if (!from) return { error: 'Where from?', field: 'from' };
  if (!to) return { error: 'Where to?', field: 'to' };
  if (from.toLowerCase() === to.toLowerCase()) return { error: 'Choose two different cities.', field: 'to' };
  const n = trip.days.length;
  const day = whole(f.day);
  if (!Number.isInteger(day) || day < 0 || day >= n) return { error: 'Choose the day you travel.', field: 'day' };
  const at = String(f.at || '');
  if (!TIME.test(at)) return { error: 'Enter the time you leave, HH:MM (from your ticket or the timetable).', field: 'at' };
  const minutes = whole(f.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > LIMITS.minutes) return { error: 'Enter how long the journey takes, in minutes.', field: 'minutes' };
  const how = LEG_MODES[f.mode] ? f.mode : 'train';
  const until = f.until === undefined || f.until === '' ? n - 1 : whole(f.until);
  if (!Number.isInteger(until) || until < day || until >= n) return { error: 'The last day in the new city must be on or after the travel day.', field: 'until' };
  const ops = [{ op: 'add', day, stop: { kind: 'transport', place: { name: `${LEG_MODES[how]} ${from} → ${to}` }, at, minutes, note: `${from} to ${to}. Time entered by you.` } }];
  if (f.rename !== false) {
    for (let i = day + 1; i <= until; i++) ops.push({ op: 'title', day: i, title: cityTitle(trip.days[i].title, i, to) });
    if (/^Day \d+$/.test(trip.days[day].title || '')) ops.push({ op: 'title', day, title: `${from} → ${to}` });
  }
  return { ops };
}
// "Day 4" becomes "Porto"; "Ribeira at night" becomes "Porto: Ribeira at night"; a title naming the city stays
export function cityTitle(old, i, city) {
  const t = clean(old, LIMITS.title);
  if (!t || /^Day \d+$/.test(t)) return city;
  if (t.toLowerCase().startsWith(city.toLowerCase())) return t;
  return clean(`${city}: ${t}`, LIMITS.title);
}

/* ---------- the packing list ---------- */

const BEACH = /\b(beach|beaches|praia|plage|playa|spiaggia|strand|swim|swimming|pool|lido|snorkel\w*|surf\w*)\b/i;
const HIKE = /\b(hike|hikes|hiking|trail|trek|trekking|summit|climb|climbing|mountain|levada|ridge)\b/i;
const FLIGHT = /\b(fly|flight|flights|airport|plane)\b|\([A-Z]{3}\)|\b([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?\d{1,4}\b/;
const CAR = /\b(car|hire|rental car|drive)\b/i;

/** The packing list for a trip: [{ id, item, why }] and notes ([text]) for what couldn't be checked. `weather` is the
 *  server's trip-weather days ({ date, forecast: null, why } for a day with none). Every item says why it is there. */
export function packingList(trip, weather) {
  const items = [];
  const add = (id, item, why) => { const had = items.find((x) => x.id === id); if (had) { had.more = (had.more || 0) + 1; return; } items.push({ id, item, why }); };
  const n = trip.days.length, nights = Math.max(0, n - 1), people = trip.travelers || 1;
  const per = people > 1 ? ` (for ${people} people)` : '';
  add('docs', 'Passport or ID, and your booking references', 'every trip');
  add('clothes', `Clothes for ${n} day${n === 1 ? '' : 's'}${per}`, `${n} day${n === 1 ? '' : 's'}, ${nights} night${nights === 1 ? '' : 's'}`);
  if (nights > 0) add('wash', `Toiletries for ${nights} night${nights === 1 ? '' : 's'}${per}`, `${nights} night${nights === 1 ? '' : 's'}`);
  add('charge', 'Phone charger', 'every trip');
  if (people > 1) add('split', 'Decide who carries the shared things (chargers, first aid)', `${people} travellers`);
  if (nights >= 5) add('laundry', 'Laundry bag', `${nights} nights`);

  // the forecast, day by day: only what Open-Meteo forecast; a day without one says so
  const none = [];
  const hit = (id, item, w, why) => {
    const say = `${why} ${dayShort(w.date)} · ${w.source || 'Open-Meteo'}`;
    const had = items.find((x) => x.id === id);
    if (had) { had.more = (had.more || 0) + 1; return; }
    items.push({ id, item, why: say, unit: 'day' });
  };
  (weather || []).forEach((w, i) => {
    if (!w || w.forecast === null || w.why || !Number.isFinite(w.high_c)) { none.push([i, (w && w.why) || 'No forecast']); return; }
    if (Number.isFinite(w.rain_chance_pct) && w.rain_chance_pct >= 50) hit('rain', 'Umbrella or rain jacket', w, `${w.rain_chance_pct}% rain forecast`);
    if (w.high_c >= 25) hit('sun', 'Sun cream and a hat', w, `high of ${Math.round(w.high_c)}° forecast`);
    if (Number.isFinite(w.low_c) && w.low_c <= 8) hit('warm', 'A warm layer', w, `low of ${Math.round(w.low_c)}° forecast`);
    if (Number.isFinite(w.low_c) && w.low_c <= 0) hit('cold', 'Gloves and a warm hat', w, `low of ${Math.round(w.low_c)}° forecast`);
  });
  if (!weather) for (let i = 0; i < n; i++) none.push([i, 'Too far ahead for a forecast']);

  // what's planned: only the stop's own name and note
  trip.days.forEach((d, i) => {
    for (const s of d.stops || []) {
      const words = `${s.place && s.place.name} ${s.note || ''}`;
      const where = `“${s.place && s.place.name}”, Day ${i + 1}`;
      if (s.kind === 'transport' && FLIGHT.test(words)) add('board', 'Boarding passes (on your phone or printed)', `flight: ${where}`);
      if (BEACH.test(words)) add('swim', `Swimwear and a towel${per}`, where);
      if (HIKE.test(words)) add('hike', 'Walking shoes and a water bottle', where);
      if (s.kind === 'rental' && CAR.test(words)) add('licence', 'Driving licence', `car hire: ${where}`);
    }
  });
  const notes = [];
  // grouped by the server's own reason: too far ahead waits for the day; a day with no place on the map needs one
  const why = new Map();
  for (const [i, w] of none) why.set(w, [...(why.get(w) || []), i]);
  for (const [w, days] of why) {
    notes.push(/too far ahead/i.test(w) ? `No forecast yet for ${spanOf(days)}: check again nearer the day.`
      : /no stop on the map/i.test(w) ? `No forecast for ${spanOf(days)}: no place on the map that day to forecast for.`
        : `No forecast for ${spanOf(days)} (${w}).`);
  }
  for (const x of items) {
    if (x.more) x.why = `${x.why} (and ${x.more} more ${x.unit || 'stop'}${x.more === 1 ? '' : 's'})`;
    delete x.more; delete x.unit;
  }
  return { items, notes };
}
// [0,1,2,5] → "Days 1–3 and 6"
function spanOf(list) {
  const runs = [];
  for (const i of list) { const r = runs.at(-1); if (r && r[1] === i - 1) r[1] = i; else runs.push([i, i]); }
  const words = runs.map(([a, b]) => (a === b ? `${a + 1}` : `${a + 1}–${b + 1}`));
  const lone = list.length === 1;
  return `${lone ? 'Day' : 'Days'} ${words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words.at(-1)}` : words[0]}`;
}
