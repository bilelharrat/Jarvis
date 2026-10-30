// Memories (Eden Travel, after a trip): the route on the map in each day's colour with the photos where their own GPS
// put them, a day-by-day reel with the photos of each day, the trip's numbers (each saying what it is: stops "planned"
// unless booked, distance in straight lines), and "Share with the people on the trip", off until the organiser turns
// it on (only the trip's members, never a public link). Prints as a book (@media print in travel-memories.css).
// Photos: each read for its place and time on this device (travel-exif.js), shrunk where the browser can (the stored
// copy then carries no GPS of its own) and sent with its lat/lng/taken_at; no GPS → "not placed", no date → the person
// picks the day. Nothing moves under reduced motion; nothing plays by itself. Server: site src/travel/memories.js.
// While the organiser shares them, the people on the trip add their own photos too (shared-photo-add), each photo says
// who added it, and a member deletes only their own (the organiser deletes any).
//
// travel.js hands it, through init: { S, paint, mapImage, money?, dayLong? }. Views: memories() → [elements] (a view,
// like Group), memoriesCard() → a card for a trip that has ended (or null), loadMemories().
// "Make a film" (both views) opens travel-film.js's sheet: made and saved on this device, nothing uploaded.

import { el, ico, toast } from './util.js';
import { apiUrl, postJSON } from './api.js';
import { tripPost } from './trip-ui.js';
import { readExif } from './travel-exif.js';
import { openFilm } from './travel-film.js';

export { readExif };

let C = null;
export function init(ctx) {
  C = ctx;
  if (typeof document !== 'undefined' && !document.querySelector('link[href$="travel-memories.css"]')) document.head.append(el('link', { rel: 'stylesheet', href: 'travel-memories.css' }));
}

const DAY_COLORS = ['#0a84ff', '#ff9f0a', '#30d158', '#bf5af2', '#ff375f', '#64d2ff', '#ffd60a']; // as travel.js's journey map
const colorOf = (d) => DAY_COLORS[d % DAY_COLORS.length];
const TYPES = { 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1, 'image/heic': 1, 'image/heif': 1 };
const MAX_ORIGINAL = 10 * 1024 * 1024; // what the server keeps when the browser can't shrink the photo (site memories.js PHOTOS)
const MAX_PICK = 60 * 1024 * 1024; // a photo larger than this isn't read at all
const LONG_EDGE = 2048, THUMB_EDGE = 480;
const err = (e) => toast(String((e && e.message) || e));
const M = () => C.S.mem || (C.S.mem = { data: null, loading: false, error: null, up: null, open: null, for: null });
const fmtMoney = (n, cur) => (C.money ? C.money(n, cur) : `${cur} ${Math.round(n)}`);
const dayName = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
// who added a photo, as this person reads it (site memories.js: added_by, by_name; `mine` in a member's view)
const addedBy = (p) => (C.S.member ? (p.mine ? 'you' : p.added_by === 'member' ? p.by_name : 'the organiser') : p.added_by === 'member' ? p.by_name : 'you');
const km = (x) => (x >= 100 ? Math.round(x).toLocaleString() : x.toLocaleString(undefined, { maximumFractionDigits: 1 }));

// a member sees the organiser's memories (only while shared): site members.js / memories.js tmember-memories
function call(action, args = {}) {
  const S = C.S;
  return S.member ? tripPost(`shared-${action}`, { owner: S.member.owner, trip: S.member.trip, ...args }) : tripPost(action, { id: S.id, ...args });
}
const tripKey = () => (C.S.member ? `${C.S.member.owner}|${C.S.member.trip}` : C.S.id);
function photoUrl(p, size) {
  const S = C.S;
  const q = new URLSearchParams({ id: S.member ? S.member.trip : S.id, p: p.id });
  if (size === 'thumb' && p.thumb) q.set('size', 'thumb');
  if (S.member) q.set('owner', S.member.owner);
  return apiUrl(`/api/chat/travel/memory-photo?${q}`);
}

export async function loadMemories() {
  const m = M();
  m.for = tripKey();
  m.loading = true;
  try { m.data = await call('memories'); m.error = null; } catch (e) { m.error = String(e.message || e); m.data = null; }
  m.loading = false;
  C.paint();
}

/* ---------- the card after a trip ends ---------- */

/** A card for the trip's own pane once its last day has passed (travel.js decides where; null before that). */
export function memoriesCard(trip, { onOpen } = {}) {
  if (!trip || !trip.start || !trip.days) return null;
  const end = new Date(`${trip.start}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + trip.days.length - 1);
  if (Date.parse(`${end.toISOString().slice(0, 10)}T23:59:59Z`) >= Date.now()) return null;
  return el('section', { class: 'glass-card tvm-card', 'aria-label': 'Memories' },
    el('div', '', el('span', 'tv-kicker', 'Memories'), el('b', 'tvm-card-title', `${trip.title}, looked back on`),
      el('p', 'tv-note', 'The route, each day and your photos, just for you unless you share it with the people on the trip.')),
    el('button', { type: 'button', class: 'tv-btn primary', onclick: () => (onOpen ? onOpen() : null) }, 'Open Memories'));
}

/* ---------- the view ---------- */

export function memories() {
  const m = M();
  if (m.for !== tripKey()) { m.data = null; m.error = null; m.open = null; }
  if (!m.data && !m.error && !m.loading) loadMemories();
  if (m.error) return [el('p', 'tv-note warn glass-card tv-first', m.error)];
  if (!m.data) return [el('p', 'tv-note glass-card tv-first', 'Gathering the trip…')];
  const r = m.data;
  return [el('div', { class: 'tvm-root', 'aria-label': `Memories of ${r.title}` },
    head(r), statsCard(r), toolsCard(r), routeMap(r), ...r.days.map((d) => dayReel(r, d)), undatedCard(r), lightbox(r))]; // its actions (add photos, the film, the book) up top, under the numbers
}

function head(r) {
  const S = C.S;
  return el('header', 'tvm-head tv-first',
    // Memories isn't a tab: the way back to the trip's days
    el('button', { type: 'button', class: 'tv-pill tvm-back', 'data-k': 'mem-back', onclick: () => { S.view = 'workspace'; C.paint(); } }, ico('chevl', 13), 'Back to the trip'),
    el('span', 'tv-kicker', S.member ? 'Memories · shared with you by the organiser' : 'Memories · private'),
    el('h2', 'tvm-title', r.title),
    el('p', 'tvm-dates', `${dayName(r.start)} – ${dayName(r.end)}${r.destination ? ` · ${r.destination}` : ''}`),
    r.ended ? null : el('p', 'tv-note', 'This trip hasn’t ended yet: this is how it looks so far.'));
}

function stat(label, value, note) {
  return el('div', 'tvm-stat', el('b', '', value), el('span', '', label), note ? el('small', '', note) : null);
}
function statsCard(r) {
  const s = r.stats;
  return el('section', { class: 'glass-card tvm-stats', 'aria-label': 'The trip in numbers' },
    stat(s.days === 1 ? 'day' : 'days', String(s.days)),
    stat(s.nights === 1 ? 'night' : 'nights', String(s.nights), s.nights_from === 'stays' ? 'from the stays' : 'from the days'),
    stat('stops', String(s.stops), `${s.booked} booked · ${s.planned} planned`),
    s.located_stops > 1 ? stat('km', km(s.km), 'straight lines between stops') : null,
    s.places.length ? stat(s.places.length === 1 ? 'place' : 'places', s.places.join(', '), s.areas > 1 ? `${s.areas} areas over 50 km apart` : null) : null,
    stat(s.photos === 1 ? 'photo' : 'photos', String(s.photos), s.photos ? `${s.photos_on_map} on the map` : null),
    r.money && r.money.total > 0 ? stat('spent', fmtMoney(r.money.total, r.money.currency), r.money.rates ? `rates ${r.money.rates.date}` : r.money.rates_missing ? 'some currencies not counted' : null) : null,
    el('p', 'tv-fine tvm-span', `${s.km_note} Stops say “planned” unless booked: Eden doesn’t know which you visited.`));
}

function routeMap(r) {
  if (!C.mapImage) return null;
  const stops = r.days.flatMap((d) => d.stops.filter((s) => s.lat != null).map((s) => ({ ...s, day: d.day })));
  const photos = r.photos.filter((p) => p.on_map);
  const pts = [...stops, ...photos].map((p) => ({ lat: p.lat, lng: p.lng }));
  if (!pts.length) return el('section', 'glass-card tvm-map', el('p', 'tv-note', 'No stops or photos with a place on the map.'));
  const ns = (tag, a) => { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(a)) n.setAttribute(k, String(v)); return n; };
  const draw = (over, P) => {
    // the route, each leg in the colour of the day it arrives on
    for (let i = 1; i < stops.length; i++) {
      const a = P(stops[i - 1]), b = P(stops[i]);
      over.append(ns('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: colorOf(stops[i].day), 'stroke-width': 3, 'stroke-linecap': 'round', opacity: 0.85 }));
    }
    for (const s of stops) { const q = P(s); over.append(ns('circle', { cx: q.x, cy: q.y, r: 7, fill: colorOf(s.day), stroke: '#fff', 'stroke-width': 2 })); }
    for (const p of photos) {
      const q = P(p);
      over.append(ns('rect', { x: q.x - 7, y: q.y - 7, width: 14, height: 14, rx: 4, fill: '#fff', stroke: p.day != null ? colorOf(p.day) : '#8e8e93', 'stroke-width': 2.5 }));
    }
  };
  const legend = el('ul', 'tvm-legend', ...r.days.filter((d) => d.stops.some((s) => s.lat != null) || d.photos.length).map((d) => el('li', '', el('i', { style: { background: colorOf(d.day) } }), `Day ${d.day + 1}`)),
    photos.length ? el('li', '', el('i', 'tvm-sq'), 'a photo, where its GPS put it') : null);
  return el('section', { class: 'glass-card tvm-map', 'aria-label': `Route map: ${stops.length} stops and ${photos.length} photos with a place` },
    C.mapImage(pts, { w: 640, h: 420, cls: 'tv-mapimg wide', draw }), legend);
}

function photoTile(p, i, { cover = false } = {}) {
  const m = M();
  return el('button', { type: 'button', class: `tvm-ph${cover ? ' cover' : ''}`, style: { '--i': Math.min(i, 8) }, 'aria-label': `${p.caption || p.name}, added by ${addedBy(p)}${p.on_map ? '' : ', not placed on the map'}: open`, onclick: () => { m.open = p.id; C.paint(); } },
    el('img', { src: photoUrl(p, cover ? null : 'thumb'), alt: p.caption || '', loading: 'lazy', decoding: 'async', ...(p.w && p.h ? { width: p.w, height: p.h } : {}) }),
    p.on_map ? null : el('span', 'tvm-unplaced', 'not placed'));
}

function dayReel(r, d) {
  const photos = d.photos.map((id) => r.photos.find((p) => p.id === id)).filter(Boolean);
  return el('section', { class: 'tvm-day', style: { '--day': colorOf(d.day) }, 'aria-label': `Day ${d.day + 1}, ${dayName(d.date)}` },
    el('div', 'tvm-day-head', el('span', 'tvm-dot', ''), el('span', 'tv-kicker', `Day ${d.day + 1} · ${dayName(d.date)}`), el('h3', '', d.title),
      d.km ? el('small', 'tv-fine', `${km(d.km)} km in straight lines`) : null),
    photos.length ? el('div', 'tvm-reel', photoTile(photos[0], 0, { cover: true }), ...photos.slice(1).map((p, i) => photoTile(p, i + 1))) : null,
    d.stops.length ? el('ol', 'tvm-stops', ...d.stops.map((s) => el('li', '',
      el('span', 'tvm-at', s.at), el('span', 'tvm-name', s.name),
      el('span', `tvm-status ${s.status}`, s.status === 'booked' ? 'booked' : 'planned'),
      s.nights ? el('small', 'tv-fine', `${s.nights} night${s.nights === 1 ? '' : 's'}`) : null))) : el('p', 'tv-note', 'Nothing planned this day.'));
}

function dayPicker(r, p, onPick) {
  return el('select', { class: 'tv-input small', 'aria-label': 'Which day', onchange: (e) => onPick(e.target.value === '' ? null : Number(e.target.value)) },
    el('option', { value: '' }, 'Choose the day…'), ...r.days.map((d) => el('option', { value: String(d.day), ...(p.day === d.day && p.day_by === 'person' ? { selected: '' } : {}) }, `Day ${d.day + 1} · ${dayName(d.date)}`)));
}

function undatedCard(r) {
  if (!r.undated.length) return null;
  const owner = !C.S.member;
  return el('section', { class: 'glass-card tvm-undated', 'aria-label': 'Photos with no date' },
    el('span', 'tv-kicker', 'No date in these photos'),
    el('p', 'tv-note', owner ? 'Their files don’t say when they were taken. Pick the day, and they join it.' : 'Their files don’t say when they were taken.'),
    el('ul', 'tvm-undated-list', ...r.undated.map((p, i) => el('li', '', photoTile(p, i), owner ? dayPicker(r, p, (day) => edit(p, { day })) : null))));
}

async function edit(p, patch) {
  try { await tripPost('photo-edit', { id: C.S.id, photo: p.id, ...patch }); await loadMemories(); } catch (e) { err(e); }
}

function toolsCard(r) {
  const S = C.S, m = M();
  const input = el('input', { type: 'file', multiple: '', accept: 'image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif', class: 'sr-only', id: 'tvmAdd', onchange: (e) => { addPhotos([...e.target.files]); e.target.value = ''; } });
  const sw = el('input', { type: 'checkbox', role: 'switch', id: 'tvmShare', ...(r.share ? { checked: '' } : {}), onchange: async (e) => {
    const on = e.target.checked;
    try { const out = await tripPost('memories-share', { id: S.id, share: on }); m.data.share = out.share; toast(out.share ? 'Shared with the people on the trip' : 'Memories are private again'); } catch (x) { e.target.checked = !on; err(x); }
    C.paint();
  } });
  const up = m.up;
  if (S.member) return el('section', { class: 'glass-card tvm-tools', 'aria-label': 'Photos' },
    el('div', 'tv-acts',
      el('label', { class: `tv-btn primary${up ? ' busy' : ''}`, for: 'tvmAdd', 'aria-disabled': up ? 'true' : null }, ico('plus', 13), up ? `Adding ${up.done + 1} of ${up.total}…` : 'Add your photos'), input,
      el('button', { type: 'button', class: 'tv-btn quiet', onclick: () => film(r) }, ico('play', 13), 'Make a film'),
      el('button', { type: 'button', class: 'tv-btn quiet', onclick: printBook }, ico('doc', 13), 'Print as a book')),
    el('p', 'tv-fine', 'The organiser shared these memories with the people on the trip. Photos you add show your name, and everyone on the trip sees them. You can delete your own; the organiser can delete any. Each photo’s place and time are read on this device; Eden never guesses where it was.'));
  return el('section', { class: 'glass-card tvm-tools', 'aria-label': 'Photos and sharing' },
    el('div', 'tv-acts',
      el('label', { class: `tv-btn primary${up ? ' busy' : ''}`, for: 'tvmAdd', 'aria-disabled': up ? 'true' : null }, ico('plus', 13), up ? `Adding ${up.done + 1} of ${up.total}…` : 'Add photos'), input,
      el('button', { type: 'button', class: 'tv-btn quiet', onclick: () => film(r) }, ico('play', 13), 'Make a film'),
      el('button', { type: 'button', class: 'tv-btn quiet', onclick: printBook }, ico('doc', 13), 'Print as a book')),
    el('p', 'tv-fine', 'Each photo’s place and time are read on this device from the photo itself. A photo without GPS stays off the map (“not placed”); Eden never guesses where it was. Up to 200 photos a trip.'),
    el('label', { class: 'tvm-share', for: 'tvmShare' }, sw,
      el('span', '', el('b', '', 'Share with the people on the trip'), el('small', '', 'Only the people you invited to plan this trip see it, in their own Eden Travel. There’s no public link.'))));
}

function lightbox(r) {
  const m = M();
  const all = [...r.photos, ...r.undated];
  const i = all.findIndex((p) => p.id === m.open);
  if (i < 0) return null;
  const p = all[i];
  const owner = !C.S.member;
  const canDelete = owner || p.mine;
  const go = (k) => { m.open = all[(i + k + all.length) % all.length].id; C.paint(); };
  const close = () => { m.open = null; C.paint(); };
  const where = p.on_map ? `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)} (from the photo’s GPS)` : 'Not placed: no GPS in the photo';
  const when = p.taken_at ? `Taken ${p.taken_at.replace('T', ' ').slice(0, 16)}${/[+-]\d{2}:\d{2}$/.test(p.taken_at) ? '' : ' (camera time)'}` : 'No date in the photo';
  const caption = el('input', { class: 'tv-input', maxlength: '200', placeholder: 'Add a caption', 'aria-label': 'Caption', value: p.caption || '' });
  const box = el('div', { class: 'tvm-light', role: 'dialog', 'aria-modal': 'true', 'aria-label': p.caption || p.name, tabindex: '-1',
    onkeydown: (e) => { if (e.key === 'Escape') close(); else if (e.key === 'ArrowRight' && e.target === box) go(1); else if (e.key === 'ArrowLeft' && e.target === box) go(-1); },
    onclick: (e) => { if (e.target === box) close(); } },
    el('figure', '',
      el('img', { src: photoUrl(p), alt: p.caption || '' }),
      el('figcaption', '',
        p.caption && !owner ? el('b', '', p.caption) : null,
        el('span', 'tv-fine', `Added by ${addedBy(p)}`), el('span', 'tv-fine', when), el('span', 'tv-fine', where),
        p.outside ? el('span', 'tv-fine', 'Taken outside the trip’s dates; shown on the nearest day.') : null,
        canDelete ? el('div', 'tv-acts', owner ? caption : null,
          owner ? el('button', { type: 'button', class: 'tv-btn', onclick: () => edit(p, { caption: caption.value }) }, 'Save caption') : null,
          el('button', { type: 'button', class: 'tv-btn quiet', onclick: async () => { if (!confirm(owner && p.added_by === 'member' ? `Delete ${p.by_name}’s photo from the trip?` : 'Delete this photo from the trip?')) return; try { await call('photo-delete', { photo: p.id }); m.open = null; await loadMemories(); } catch (e) { err(e); } } }, ico('trash', 13), 'Delete')) : null)),
    all.length > 1 ? el('button', { type: 'button', class: 'tvm-nav prev', 'aria-label': 'Previous photo', onclick: () => go(-1) }, '‹') : null,
    all.length > 1 ? el('button', { type: 'button', class: 'tvm-nav next', 'aria-label': 'Next photo', onclick: () => go(1) }, '›') : null,
    el('button', { type: 'button', class: 'tv-x tvm-close', 'aria-label': 'Close', onclick: close }, ico('x', 16)));
  setTimeout(() => { if (box.isConnected && !box.contains(document.activeElement)) box.focus(); }, 0);
  return box;
}

const film = (r) => openFilm(r, { el, ico, toast, photoUrl, mapImage: C.mapImage, money: C.money ? fmtMoney : null, dayName });

function printBook() {
  const html = document.documentElement;
  html.classList.add('tvm-printing');
  const done = () => { html.classList.remove('tvm-printing'); removeEventListener('afterprint', done); };
  addEventListener('afterprint', done);
  window.print();
}

/* ---------- adding photos ---------- */

function typeOf(f) {
  const t = String(f.type || '').toLowerCase();
  if (TYPES[t]) return t === 'image/heif' ? 'image/heic' : t;
  if (/\.(heic|heif)$/i.test(f.name)) return 'image/heic';
  if (/\.jpe?g$/i.test(f.name)) return 'image/jpeg';
  return null;
}
const b64 = (buf) => { let bin = ''; for (let i = 0; i < buf.length; i += 8192) bin += String.fromCharCode(...buf.subarray(i, i + 8192)); return btoa(bin); };

// the photo drawn smaller (its orientation applied by the browser): the stored copy has no EXIF, so no GPS of its own
async function shrink(blob, edge, quality) {
  if (typeof createImageBitmap !== 'function') return null;
  let bmp;
  try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch { return null; } // HEIC outside Safari
  const k = Math.min(1, edge / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close && bmp.close();
  const out = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
  return out ? { bytes: new Uint8Array(await out.arrayBuffer()), w, h } : null;
}

/** Read, shrink and send the photos one at a time (a trip's photos can be many; one failing doesn't stop the rest). */
export async function addPhotos(files) {
  const S = C.S, m = M();
  if (!files.length || m.up) return;
  m.up = { done: 0, total: files.length };
  C.paint();
  let added = 0, unplaced = 0, failed = 0;
  for (const f of files) {
    try {
      const type = typeOf(f);
      if (!type) throw new Error(`${f.name}: JPEG, HEIC, PNG or WebP`);
      if (f.size > MAX_PICK) throw new Error(`${f.name} is too large`);
      const raw = new Uint8Array(await f.arrayBuffer());
      const exif = readExif(raw);
      const big = await shrink(f, LONG_EDGE, 0.86);
      const small = big ? await shrink(f, THUMB_EDGE, 0.75) : null;
      if (!big && raw.length > MAX_ORIGINAL) throw new Error(`${f.name} is over 10 MB and this browser can’t shrink it`);
      const args = {
        ...(S.member ? { owner: S.member.owner, trip: S.member.trip } : { id: S.id }), name: f.name, type: big ? 'image/jpeg' : type, data: b64(big ? big.bytes : raw),
        ...(small && small.bytes.length <= 400 * 1024 ? { thumb: b64(small.bytes) } : {}),
        ...(big ? { w: big.w, h: big.h } : {}),
        lat: exif.lat, lng: exif.lng, taken_at: exif.taken_at,
      };
      // a member's photo goes to the organiser's trip (site members.js shared-photo-add), the same 15 MB route
      await postJSON('/api/chat/travel?doc=1', { action: S.member ? 'shared-photo-add' : 'photo-add', args }, { timeout: 120_000 });
      added++;
      if (exif.lat == null) unplaced++;
    } catch (e) { failed++; err(e); }
    m.up.done++;
    if (m.up.done < m.up.total) C.paint();
  }
  m.up = null;
  if (added) toast(`${added} photo${added === 1 ? '' : 's'} added${unplaced ? ` · ${unplaced} without GPS, not placed on the map` : ''}${failed ? ` · ${failed} not added` : ''}`);
  await loadMemories();
}
