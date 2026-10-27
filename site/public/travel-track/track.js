// The guest flight tracker (askeden.com/f/<code>, travel/track.js on the server): for whoever picks the traveller up,
// no sign-in. The live map (the same maths as Eden's own tracker, trip-tools.js), the flight's times, and the pickup
// planner: three places to meet near the terminal with the drive in current traffic, and "Pick this spot", which
// goes to the traveller (saved, and pushed to their phone as soon as it's online). What the server sends is shown as
// text only: nothing from it is run or put into the page as HTML.

import { greatCircle, planeAt, project, flightStrip } from '/f/trip-tools.js';

const code = location.pathname.split('/')[2];
const root = document.getElementById('track');
const W = 640, H = 320;
const S = { data: null, map: null, opts: null, picked: null, err: '' };

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'class') n.className = v;
    else n.setAttribute(k, String(v));
  }
  for (const k of kids.flat()) if (k != null && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
};
const svg = (tag, attrs = {}) => { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); return n; };
const local = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
const api = async (part, body) => {
  const res = await fetch(`/f/${code}/${part}`, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(out.error || `Something went wrong (${res.status}).`), { status: res.status });
  return out;
};

async function load({ live = false } = {}) {
  try {
    S.data = await api('data');
    S.err = '';
    const l = S.data.live;
    if (!S.map && l.from && l.to) {
      const q = new URLSearchParams({ a: `${l.from.lat},${l.from.lng}`, b: `${l.to.lat},${l.to.lng}` });
      const res = await fetch(`/f/${code}/map?${q}`);
      if (res.ok) {
        const [lat, lng] = String(res.headers.get('x-map-center') || '').split(',').map(Number);
        S.map = { url: URL.createObjectURL(await res.blob()), center: { lat, lng }, zoom: Number(res.headers.get('x-map-zoom')) };
      }
    }
  } catch (e) { S.err = e.status === 404 ? 'This tracking link has ended.' : String(e.message || e); }
  if (live) paintLive(); else paint();
}

function mapView() {
  const l = S.data.live;
  const frame = el('div', { class: 'tk-map' });
  if (!S.map || !l.from || !l.to) { frame.append(el('div', { class: 'tk-map-empty' }, 'Map loading…')); return frame; }
  const pic = el('img', { alt: '', src: S.map.url });
  const over = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const P = (p) => project(p, S.map.center, S.map.zoom, W, H);
  const line = greatCircle(l.from, l.to, 80).map(P);
  const d = (pts) => pts.map((q, i) => `${i ? 'L' : 'M'}${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(' ');
  over.append(svg('path', { d: d(line), fill: 'none', stroke: '#7cc4ff', 'stroke-width': 2, 'stroke-dasharray': '6 6', opacity: 0.55 }));
  const plane = planeAt(l);
  if (plane) {
    const at = P(plane);
    let k = 0, best = Infinity;
    line.forEach((q, i) => { const dd = (q.x - at.x) ** 2 + (q.y - at.y) ** 2; if (dd < best) { best = dd; k = i; } });
    over.append(svg('path', { d: d([...line.slice(0, k + 1), at]), fill: 'none', stroke: '#7cc4ff', 'stroke-width': 3 }));
  }
  for (const [p, c] of [[l.from, l.flight.origin && l.flight.origin.code], [l.to, l.flight.destination && l.flight.destination.code]]) {
    const q = P(p);
    over.append(svg('circle', { cx: q.x, cy: q.y, r: 5, fill: '#fff', stroke: '#0b1a2e', 'stroke-width': 2 }));
    const t = svg('text', { x: q.x + 9, y: q.y + 4, fill: '#fff', 'font-size': 13, 'font-weight': 600, 'font-family': 'system-ui, -apple-system, sans-serif' });
    t.textContent = c || '';
    over.append(t);
  }
  if (plane) {
    const q = P(plane);
    over.append(svg('path', { d: 'M0,-11 L2,-3 L10,1 L10,3 L2,1.5 L1.5,7 L4,9 L4,10.5 L0,9.5 L-4,10.5 L-4,9 L-1.5,7 L-2,1.5 L-10,3 L-10,1 L-2,-3 Z', fill: plane.how === 'live' ? '#ffd166' : '#fff', stroke: '#0b1a2e', 'stroke-width': 1, transform: `translate(${q.x.toFixed(1)},${q.y.toFixed(1)}) rotate(${plane.heading.toFixed(0)}) scale(1.3)` }));
  }
  frame.append(pic, over);
  return frame;
}

function pickupView() {
  const box = el('section', { class: 'tk-card', 'aria-labelledby': 'tk-pick-h' }, el('h2', { id: 'tk-pick-h' }, `Where to meet ${S.data.first_name}`));
  const chosen = S.data.pickup;
  if (chosen) box.append(el('div', { class: 'tk-chosen' }, el('b', {}, chosen.label), chosen.place && chosen.place.name && !chosen.label.includes(chosen.place.name) ? el('span', {}, ` · ${chosen.place.name}`) : null,
    el('p', {}, `Picked by ${chosen.name}${chosen.note ? `: “${chosen.note}”` : ''}. ${chosen.notified ? `Sent to ${S.data.first_name}’s phone: if they’re in the air without wifi, it shows the moment the phone is back online.` : `Saved: ${S.data.first_name} sees it in Eden.`}`)));
  if (!S.opts) {
    const where = el('input', { type: 'text', placeholder: 'Or type where you’re leaving from', 'aria-label': 'Where you’re leaving from', maxlength: '200' });
    const go = async (from) => {
      box.querySelector('.tk-status')?.remove();
      box.append(el('p', { class: 'tk-status' }, 'Finding the best places to meet…'));
      try { S.opts = await api('options', { from }); } catch (e) { S.opts = null; box.querySelector('.tk-status').textContent = String(e.message || e); return; }
      paint();
    };
    box.append(el('p', { class: 'tk-note' }, 'Eden finds three places near the arrival terminal and works out the drive from you in current traffic.'),
      el('div', { class: 'tk-row' },
        el('button', { type: 'button', class: 'tk-btn primary', onclick: () => navigator.geolocation ? navigator.geolocation.getCurrentPosition((p) => go({ lat: p.coords.latitude, lng: p.coords.longitude }), () => where.focus(), { timeout: 10000, maximumAge: 300000 }) : where.focus() }, 'Use my location'),
        el('form', { class: 'tk-form', onsubmit: (e) => { e.preventDefault(); if (where.value.trim().length >= 3) go({ text: where.value.trim() }); } }, where, el('button', { type: 'submit', class: 'tk-btn' }, 'Show places'))));
    return box;
  }
  const o = S.opts;
  box.append(el('p', { class: 'tk-note' }, `${S.data.first_name} should be out about ${local(o.ready_at)}: the gate time plus ${o.exit_min} min for ${o.exit_basis}.`));
  o.options.forEach((p, i) => {
    const late = p.late_min > 0;
    const name = el('input', { type: 'text', placeholder: 'Your name', 'aria-label': 'Your name', maxlength: '40' });
    const note = el('input', { type: 'text', placeholder: 'A note (car, colour…)', 'aria-label': 'A note for the traveller', maxlength: '300' });
    box.append(el('article', { class: `tk-opt${p.best ? ' best' : ''}` },
      el('div', { class: 'tk-opt-head' }, el('b', {}, p.label), p.best ? el('span', { class: 'tk-tag' }, 'Best') : null),
      el('div', { class: 'tk-note' }, (p.label.includes(p.place.name) ? '' : p.place.name) + (p.place.address ? `${p.label.includes(p.place.name) ? '' : ' · '}${p.place.address}` : '')),
      el('div', { class: 'tk-facts' },
        p.drive.error ? el('span', {}, 'Drive time not available') : el('span', {}, `${p.drive.minutes} min drive (${p.drive.km} km, current traffic)`),
        p.call_wait ? el('span', {}, p.call_wait.error ? 'They wait at the kerb and call you' : `They wait at the kerb and call; you drive round in ${p.call_wait.minutes} min`) : p.walk.error ? null : el('span', {}, p.walk.minutes ? `${p.walk.minutes} min walk from the terminal` : 'At the terminal'),
        p.leave_by ? el('span', { class: late ? 'late' : '' }, late ? `Leave now: you’d be ${p.late_min} min after ${S.data.first_name}` : `Leave by ${local(p.leave_by)} to be there at ${local(p.out_at)}`) : null),
      el('p', { class: 'tk-note' }, p.note),
      el('form', { class: 'tk-form', onsubmit: async (e) => {
        e.preventDefault();
        const btn = e.target.querySelector('button');
        btn.disabled = true;
        try { await api('pick', { index: i, note: note.value, name: name.value }); S.opts = null; await load(); } catch (err) { btn.disabled = false; alert(String(err.message || err)); }
      } }, name, note, el('button', { type: 'submit', class: `tk-btn${p.best ? ' primary' : ''}` }, 'Pick this spot'))));
  });
  const missing = ['kerb', 'parking', 'waiting'].filter((k) => !o.options.some((x) => x.kind === k)).map((k) => ({ parking: 'short-stay parking', waiting: 'waiting area' })[k]).filter(Boolean);
  if (missing.length) box.append(el('p', { class: 'tk-note' }, `Google Maps lists no ${missing.join(' or ')} near this terminal, so ${missing.length > 1 ? 'they’re' : 'it’s'} left out rather than guessed.`));
  box.append(el('p', { class: 'tk-fine' }, `${o.rules} Times from ${o.sources.join(' and ')}, checked ${local(o.checked_at)}.`),
    el('button', { type: 'button', class: 'tk-btn', onclick: () => { S.opts = null; paint(); } }, 'Change where I’m leaving from'));
  return box;
}

function strip(l) {
  return el('dl', { class: 'tk-strip' }, ...flightStrip(l).map(([k, v]) => {
    // the driver's own time zone, not UTC
    const arr = l.flight.arrival.actual || l.flight.arrival.estimated || l.flight.arrival.scheduled;
    if (k === 'Arrives') return [k, `${local(arr)}${l.flight.arrival.estimated && !l.flight.arrival.actual ? ' (estimated)' : ''}`];
    if (k === 'Landed') return [k, local(l.flight.arrival.actual)];
    return [k, v];
  }).flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
}

/** The plane moves on between looks: only the map and the strip are drawn again (the driver may be typing below). */
function paintLive() {
  const m = root.querySelector('.tk-map'), st = root.querySelector('.tk-strip');
  if (!m || !st || !S.data) return paint();
  m.replaceWith(mapView());
  st.replaceWith(strip(S.data.live));
}

function paint() {
  if (S.err && !S.data) { root.replaceChildren(el('section', { class: 'tk-card' }, el('h1', {}, 'Flight tracker'), el('p', {}, S.err))); return; }
  if (!S.data) return;
  const l = S.data.live;
  root.replaceChildren(...[
    el('header', { class: 'tk-head' }, el('span', { class: 'tk-kicker' }, 'Eden Travel'), el('h1', {}, `${S.data.first_name}’s flight ${S.data.ident}`)),
    mapView(),
    strip(l),
    el('p', { class: 'tk-fine' }, `Live from FlightAware, checked ${local(l.flight.checked_at)}. Times in your time zone.`),
    l.flight.state === 'cancelled' ? null : pickupView(),
    S.err ? el('p', { class: 'tk-fine' }, S.err) : null].filter(Boolean));
}

load();
setInterval(() => { if (!document.hidden) load({ live: true }); }, 5 * 60_000);
setInterval(() => { if (!document.hidden && S.data) paintLive(); }, 15_000); // the plane moves on between looks
