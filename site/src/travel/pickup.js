// The airport pickup planner (the guest tracker, track.js): three real places to meet near the arrival terminal, each
// with the drive from where the driver is (Google Routes, in today's traffic), the walk from the terminal, when the
// traveller should be out (the gate time plus a stated allowance for getting off, passport control and bags) and so
// when the driver should leave. Every time says where it came from and when it was checked; the allowance is labelled
// an estimate, and kerb rules and fees are never guessed ("follow the airport's signs").

import { distanceKm } from './maps.js';

export const EXIT_MIN = { international: 40, domestic: 20 }; // getting off, passport control and bags: an estimate, shown as one
export const OPTIONS_MS = 10 * 60_000; // the same driver asking again within 10 minutes: the same answer, not another Google bill
const NEAR_KM = 5; // a pickup place counts only this close to the terminal
const APART_KM = 0.12; // and at least this far from the others

const KINDS = [
  // `is`: what a place's name must say to count as that kind (Google matched "phone lot" to a SIM shop once)
  { kind: 'kerb', label: (t) => `Arrivals kerb${t ? `, Terminal ${t}` : ''}`, query: (a, t) => `${a} Airport ${t ? `Terminal ${t} ` : ''}arrivals pick up`, is: /\b(arrivals?|pick[\s-]?up|kerb|curb|forecourt)\b/i, not: /\b(car\s?park|parking|garage|shop|store)\b/i, note: 'Quickest for the traveller; most airports allow only a short stop here.' },
  { kind: 'parking', label: (t) => `Short-stay parking${t ? `, Terminal ${t}` : ''}`, query: (a, t) => `${a} Airport ${t ? `Terminal ${t} ` : ''}short stay car park`, is: /\b(car\s?park|parking|garage|short[\s-]?stay)\b/i, not: /\b(shop|store|hotel)\b/i, note: 'Park and meet inside: no rush at the kerb, usually a fee.' },
  { kind: 'waiting', label: () => 'Waiting area', query: (a) => `${a} Airport cell phone lot waiting area`, is: /\b(waiting|wait|cell[\s-]?phone\s+lot|holding|lay[\s-]?by)\b/i, not: /\b(shop|store|sim|mobile\s+repair)\b/i, note: 'Wait here for a call, then drive to the kerb.' },
];

const at = (ms) => new Date(ms).toISOString();

/**
 * { options: [{ kind, label, place, drive, walk, out_at, leave_by, late_min, best, note }], ready_at, exit_min, exit_basis,
 *   terminal, checked_at, sources } — `flight` is FlightAware's summary; `airport` its { code, name, lat, lng, country };
 *   `origin` the departure airport (for international or not); `from` the driver's { lat, lng }.
 */
export async function pickupOptions({ maps, flight, airport, origin, from, now = Date.now() }) {
  const name = (airport.name || airport.code || '').replace(/\s+(International\s+)?Airport$/i, '').replace(/\s+Intl$/i, '');
  const t = flight.arrival && flight.arrival.terminal ? String(flight.arrival.terminal).slice(0, 8) : '';
  const near = { lat: airport.lat, lng: airport.lng };
  // the terminal itself, so walks start there
  let terminal = { ...near, name: airport.name || airport.code };
  if (t) {
    const hit = (await maps.search(`${name} Airport Terminal ${t}`, near).catch(() => [])).find((p) => Number.isFinite(p.lat) && distanceKm(p, near) < NEAR_KM);
    if (hit) terminal = { lat: hit.lat, lng: hit.lng, name: hit.name };
  }
  const chosen = [];
  for (const k of KINDS) {
    const found = await maps.search(k.query(name, t), terminal).catch(() => []);
    const p = found.find((x) => Number.isFinite(x.lat) && k.is.test(x.name || '') && !k.not.test(x.name || '') && distanceKm(x, terminal) < NEAR_KM && chosen.every((c) => distanceKm(c.place, x) > APART_KM));
    if (p) chosen.push({ k, place: { id: p.id, name: p.name, address: p.address || '', lat: p.lat, lng: p.lng } });
    else if (k.kind === 'kerb') chosen.push({ k, place: { id: null, name: terminal.name, address: '', lat: terminal.lat, lng: terminal.lng } }); // the kerb is at the terminal anyway
  }

  const gate = Date.parse(flight.arrival.actual || flight.arrival.estimated || flight.arrival.scheduled || '');
  // not known which: the longer allowance (better early than the traveller waiting)
  const known = Boolean(origin && origin.country && airport.country);
  const international = !known || origin.country !== airport.country;
  const exit = EXIT_MIN[international ? 'international' : 'domestic'];
  const ready = Number.isFinite(gate) ? gate + exit * 60_000 : null;

  const kerb = (chosen.find((c) => c.k.kind === 'kerb') || { place: terminal }).place;
  const none = Promise.resolve({ minutes: 0, meters: 0, source: null, checked_at: null });
  const options = [];
  for (const { k, place } of chosen) {
    // a waiting area: the traveller waits at the kerb and calls; the driver comes round (that drive is the traveller's wait)
    const waiting = k.kind === 'waiting';
    const [drive, walk, call] = await Promise.all([
      maps.travel(from, place, 'drive').catch((e) => ({ error: e.message })),
      waiting || distanceKm(terminal, place) < 0.05 ? none : maps.travel(terminal, place, 'walk').catch((e) => ({ error: e.message })),
      waiting ? maps.travel(place, kerb, 'drive').catch((e) => ({ error: e.message })) : none,
    ]);
    const out = ready !== null && Number.isFinite(walk.minutes) ? ready + walk.minutes * 60_000 : null;
    const leave = out !== null && Number.isFinite(drive.minutes) ? out - drive.minutes * 60_000 : null;
    const late = leave !== null ? Math.max(0, Math.round((now - leave) / 60_000)) : null;
    options.push({
      kind: k.kind, label: k.label(t), place, note: k.note,
      drive: drive.error ? { error: drive.error } : { minutes: drive.minutes, km: Math.round(drive.meters / 100) / 10, source: drive.source, checked_at: drive.checked_at },
      walk: walk.error ? { error: walk.error } : { minutes: walk.minutes, source: walk.source, checked_at: walk.checked_at },
      ...(waiting ? { call_wait: call.error ? { error: call.error } : { minutes: call.minutes, source: call.source, checked_at: call.checked_at } } : {}),
      out_at: out !== null ? at(out) : null, leave_by: leave !== null ? at(leave) : null, late_min: late,
    });
  }
  // best: the traveller waits least (a walk, or the driver coming round from a waiting area), then the shortest drive;
  // one leaving too late can't be best unless all are
  const wait = (o) => (o.walk.minutes ?? 99) + (o.call_wait ? (o.call_wait.minutes ?? 99) : 0);
  const score = (o) => (o.late_min ?? 999) * 10 + wait(o) + (o.drive.minutes ?? 999) / 10;
  const best = options.filter((o) => !o.drive.error).sort((a, b) => score(a) - score(b))[0];
  for (const o of options) o.best = o === best;
  return {
    options,
    terminal: t || null,
    ready_at: ready !== null ? at(ready) : null,
    exit_min: exit,
    exit_basis: !known ? 'an arrival that may have passport control (not known): an estimate' : international ? 'an international arrival (passport control, bags): an estimate' : 'a domestic arrival (bags): an estimate',
    checked_at: at(now),
    sources: ['Google Maps (Places, Routes in current traffic)', 'FlightAware AeroAPI (arrival time and terminal)'],
    rules: 'Kerb rules and fees differ by airport: follow the airport’s signs.',
  };
}
