// Make a film (Eden Travel Memories): a short video of the trip made on this device. The opening (the trip, its dates),
// then each day: the route drawn on the map picture as far as that day, the day's title and date, the day's photos with a
// slow Ken Burns move, and the closing numbers with the same caveats as the page (stops "planned" unless booked, km in
// straight lines). 30 to 90 s; when a trip has more photos than fit, an even share from each day, in time order.
// Drawn on a <canvas> and recorded with MediaRecorder: MP4 (H.264) where the browser records it, else WebM (its
// duration written in afterwards: Chrome leaves it out). Silent, no track. Nothing is uploaded: the person previews it
// and saves the file. Everything it needs (the map picture, the photos) is fetched before recording starts, so the
// recording itself runs offline. Under reduced motion the live drawing isn't shown and the preview never plays by itself
// (nothing plays by itself anyway); the saved file moves as made.
//
// No imports, so the timeline and layout below load in Node for the tests (src/__tests__/travel-film.test.ts).
// travel-memories.js calls openFilm(recap, { el, ico, toast, photoUrl, mapImage, money, dayName }).

/* ---------- the timeline (pure) ---------- */

export const FILM = { w: 1280, h: 720, fps: 30, min: 30, max: 90, open: 4, day: 3, minDay: 1.4, photo: 3.2, stats: 6, end: 3, fade: 0.4 };
export const DAY_COLORS = ['#0a84ff', '#ff9f0a', '#30d158', '#bf5af2', '#ff375f', '#64d2ff', '#ffd60a']; // as travel-memories.js
export const colorOf = (d) => DAY_COLORS[d % DAY_COLORS.length];
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const r3 = (x) => Math.round(x * 1000) / 1000;

/** How many photos each day gets when only `slots` fit: one to every day that still has some, round and round. */
export function shareSlots(counts, slots) {
  const got = counts.map(() => 0);
  let left = Math.max(0, slots);
  while (left > 0) {
    let gave = false;
    for (let i = 0; i < counts.length && left > 0; i++) if (got[i] < counts[i]) { got[i]++; left--; gave = true; }
    if (!gave) break;
  }
  return got;
}

/** `k` of `list`, spread evenly through it (time order kept). */
export function spread(list, k) {
  if (k >= list.length) return list.slice();
  if (k <= 0) return [];
  return Array.from({ length: k }, (_, j) => list[Math.min(list.length - 1, Math.floor(((j + 0.5) * list.length) / k))]);
}

/**
 * The film's scenes from the Memories recap (site memories.js recap()): open, then per day a map scene and its photos,
 * then the numbers and the end card. Days share at most half the room the fixed scenes leave; photos fill the rest up
 * to `max` seconds; a short film is stretched to `min`. Photos with no day (r.undated) aren't in it.
 */
export function planFilm(r, o = {}) {
  const F = { ...FILM, ...o };
  const days = r.days || [];
  const byId = new Map((r.photos || []).map((p) => [p.id, p]));
  const dayPhotos = days.map((d) => (d.photos || []).map((id) => byId.get(id)).filter(Boolean));
  const n = days.length;
  const fixed = F.open + F.stats + F.end;
  const room = Math.max(0, F.max - fixed);
  const dayDur = n ? Math.min(clamp((room * 0.5) / n, F.minDay, F.day), room / n) : 0;
  const slots = Math.max(0, Math.floor((room - n * dayDur + 1e-9) / F.photo));
  const share = shareSlots(dayPhotos.map((l) => l.length), slots);
  const chosen = dayPhotos.map((l, i) => spread(l, share[i]));
  const used = chosen.reduce((t, l) => t + l.length, 0);
  const raw = fixed + n * dayDur + used * F.photo;
  const k = raw < F.min ? F.min / raw : 1;

  const scenes = [];
  let t = 0, idx = 0;
  const push = (s, dur) => { scenes.push({ ...s, t: r3(t), dur: r3(dur * k) }); t += dur * k; };
  push({ kind: 'open' }, F.open);
  days.forEach((d, i) => {
    push({ kind: 'day', day: i }, dayDur);
    for (const p of chosen[i]) push({ kind: 'photo', day: i, photo: p.id, n: idx++ }, F.photo);
  });
  push({ kind: 'stats' }, F.stats);
  push({ kind: 'end' }, F.end);
  const total = r3(t);
  return { w: F.w, h: F.h, fps: F.fps, fade: F.fade, scenes, total, photos: used, left: dayPhotos.reduce((s, l) => s + l.length, 0) - used };
}

/** The scene playing at `t` seconds and how far into it (0..1). Past the end: the last scene, finished. */
export function sceneAt(plan, t) {
  const S = plan.scenes;
  let i = 0;
  while (i < S.length - 1 && t >= S[i + 1].t) i++;
  const s = S[i];
  return { scene: s, i, p: clamp((t - s.t) / s.dur, 0, 1), into: t - s.t, left: s.t + s.dur - t };
}

export const ease = (p) => (p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2);

/**
 * The part of a photo to draw for frame `p` (0..1) of its scene: the frame filled (cover), a slow zoom between 1 and 1.12
 * (in on even photos, out on odd ones) and a drift toward one of four corners, never past the photo's edge.
 */
export function kenBurns(i, iw, ih, W, H, p, zoom = 0.12) {
  const A = W / H;
  let bw = iw, bh = iw / A;
  if (bh > ih) { bh = ih; bw = ih * A; }
  const e = ease(clamp(p, 0, 1));
  const z = i % 2 ? 1 + zoom - zoom * e : 1 + zoom * e;
  const sw = bw / z, sh = bh / z;
  const dir = [[1, 1], [-1, 1], [1, -1], [-1, -1]][i % 4];
  const cx = iw / 2 + dir[0] * (2 * e - 1) * ((iw - sw) / 2) * 0.9;
  const cy = ih / 2 + dir[1] * (2 * e - 1) * ((ih - sh) / 2) * 0.9;
  return { sx: cx - sw / 2, sy: cy - sh / 2, sw, sh };
}

/** The trip's path: legs between consecutive located stops, each in the colour of the day it arrives on (as the page). */
export function routeLegs(r) {
  const stops = (r.days || []).flatMap((d) => d.stops.filter((s) => s.lat != null && s.lng != null).map((s) => ({ lat: s.lat, lng: s.lng, day: d.day, name: s.name })));
  const legs = [];
  for (let i = 1; i < stops.length; i++) legs.push({ a: stops[i - 1], b: stops[i], day: stops[i].day });
  return { stops, legs };
}

/** How much of each leg shows while day `day`'s map scene is at `p`: earlier days whole, this day's legs drawn in turn. */
export function legsAt(legs, day, p) {
  const mine = legs.filter((l) => l.day === day);
  const grow = clamp(p / 0.8, 0, 1) * mine.length; // the last fifth holds the finished day
  let j = 0;
  return legs.filter((l) => l.day <= day).map((l) => {
    if (l.day < day) return { ...l, f: 1 };
    const f = clamp(grow - j++, 0, 1);
    return { ...l, f };
  }).filter((l) => l.f > 0);
}

/** Lines that fit `maxW` by `measure(text)`; the last line ends in "…" when the text runs past `maxLines`. */
export function wrapText(text, measure, maxW, maxLines = 2) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i];
    if (measure(next) <= maxW || !cur) { cur = next; continue; }
    lines.push(cur);
    cur = words[i];
    if (lines.length === maxLines) { cur = ''; break; }
  }
  if (cur) lines.push(cur);
  const out = lines.slice(0, maxLines);
  const short = (l) => { while (l && measure(`${l}…`) > maxW) l = l.slice(0, -1).trimEnd(); return `${l}…`; };
  for (let i = 0; i < out.length; i++) if (measure(out[i]) > maxW) out[i] = short(out[i]); // one word wider than the line
  if (out.length && words.join(' ') !== lines.join(' ') && !out[out.length - 1].endsWith('…')) out[out.length - 1] = short(out[out.length - 1]);
  return out;
}

/** The closing numbers, each saying what it is, as the page's stats card. `money(n, cur)` formats the spend. */
export function statLines(r, money) {
  const s = r.stats || {};
  const out = [
    [String(s.days), s.days === 1 ? 'day' : 'days', null],
    [String(s.nights), s.nights === 1 ? 'night' : 'nights', s.nights_from === 'stays' ? 'from the stays' : 'from the days'],
    [String(s.stops), 'stops', `${s.booked} booked · ${s.planned} planned`],
  ];
  if (s.located_stops > 1) out.push([s.km >= 100 ? Math.round(s.km).toLocaleString('en') : String(s.km), 'km', 'straight lines between stops']);
  out.push([String(s.photos), s.photos === 1 ? 'photo' : 'photos', null]);
  if (r.money && r.money.total > 0 && money) out.push([money(r.money.total, r.money.currency), 'spent', r.money.rates ? `rates ${r.money.rates.date}` : null]);
  return out.slice(0, 6);
}

/** MP4 (H.264) first: Safari records it, and so does recent Chrome; else WebM. */
export function pickType(isSupported) {
  const want = [['video/mp4;codecs=avc1.42E01E', 'mp4'], ['video/mp4;codecs=avc1', 'mp4'], ['video/mp4', 'mp4'], ['video/webm;codecs=vp9', 'webm'], ['video/webm;codecs=vp8', 'webm'], ['video/webm', 'webm']];
  for (const [type, ext] of want) { try { if (isSupported(type)) return { type, ext }; } catch { /* next */ } }
  return null;
}

export const fileName = (title, ext) => `${String(title || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'trip'}-film.${ext}`;

/* ---------- WebM duration (pure) ---------- */
// MediaRecorder's WebM has no Duration in its Segment Info (it was live), so players show no length and can't seek.
// Writes Duration (float64, in TimecodeScale units) into Info; returns the bytes unchanged when it can't find Info or
// Duration is already there.

function vint(b, pos, keepMarker) {
  const first = b[pos];
  if (first === undefined) return null;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || pos + len > b.length) return null;
  let v = keepMarker ? first : first & (0xff >> len);
  let ones = (first & (0xff >> len)) === (0xff >> len);
  for (let i = 1; i < len; i++) { v = v * 256 + b[pos + i]; if (b[pos + i] !== 0xff) ones = false; }
  return { len, v, unknown: !keepMarker && ones };
}
function elementAt(b, pos) {
  const id = vint(b, pos, true);
  if (!id) return null;
  const size = vint(b, pos + id.len, false);
  if (!size) return null;
  const start = pos + id.len + size.len;
  return { id: id.v, start, size: size.unknown ? null : size.v, end: size.unknown ? b.length : start + size.v };
}

export function fixWebmDuration(bytes, ms) {
  const b = bytes;
  let pos = 0, seg = null;
  while (pos < b.length) {
    const e = elementAt(b, pos);
    if (!e) return bytes;
    if (e.id === 0x18538067) { seg = e; break; }
    if (e.size == null) return bytes;
    pos = e.end;
  }
  if (!seg) return bytes;
  let info = null, at = seg.start;
  while (at < seg.end) {
    const e = elementAt(b, at);
    if (!e || e.size == null) return bytes;
    if (e.id === 0x1549a966) { info = { ...e, pos: at }; break; }
    if (e.id === 0x1f43b675) return bytes; // a Cluster before any Info
    at = e.end;
  }
  if (!info) return bytes;
  let scale = 1e6;
  for (let q = info.start; q < info.end;) {
    const e = elementAt(b, q);
    if (!e || e.size == null) return bytes;
    if (e.id === 0x4489) return bytes; // already has one
    if (e.id === 0x2ad7b1) { let v = 0; for (let i = e.start; i < e.end; i++) v = v * 256 + b[i]; if (v > 0) scale = v; }
    q = e.end;
  }
  const dur = new Uint8Array(11);
  dur.set([0x44, 0x89, 0x88]);
  new DataView(dur.buffer).setFloat64(3, (ms * 1e6) / scale);
  const body = info.end - info.start + dur.length;
  const head = new Uint8Array(4 + 8);
  head.set([0x15, 0x49, 0xa9, 0x66, 0x01]); // the Info id, then its size as an 8-byte vint
  for (let i = 0, v = body; i < 7; i++) { head[11 - i] = v % 256; v = Math.floor(v / 256); }
  const out = new Uint8Array(b.length + head.length + dur.length - (info.start - info.pos));
  out.set(b.subarray(0, info.pos), 0);
  out.set(head, info.pos);
  out.set(b.subarray(info.start, info.end), info.pos + head.length);
  out.set(dur, info.pos + head.length + (info.end - info.start));
  out.set(b.subarray(info.end), info.pos + head.length + (info.end - info.start) + dur.length);
  return out;
}

/* ---------- drawing a frame (browser) ---------- */

const SANS = '-apple-system, "SF Pro Display", system-ui, "Helvetica Neue", Arial, sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, monospace';
const CORAL = '#ef7b6c';
const STAGE = '#0b111b';

function font(g, weight, px, fam = SANS) { g.font = `${weight} ${px}px ${fam}`; }
function text(g, s, x, y, { weight = 600, px = 28, color = '#fff', fam = SANS, align = 'left', alpha = 1 } = {}) {
  font(g, weight, px, fam);
  g.globalAlpha = alpha;
  g.fillStyle = color;
  g.textAlign = align;
  g.fillText(s, x, y);
  g.globalAlpha = 1;
}
function lines(g, s, x, y, maxW, o) {
  font(g, o.weight || 600, o.px, o.fam || SANS);
  const ls = wrapText(s, (t) => g.measureText(t).width, maxW, o.max || 2);
  ls.forEach((l, i) => text(g, l, x, y + i * o.px * 1.12, o));
  return ls.length * o.px * 1.12;
}

function mapLayer(g, A, W, H, dim) {
  g.fillStyle = STAGE;
  g.fillRect(0, 0, W, H);
  if (A.map) g.drawImage(A.map.img, 0, 0, W, H);
  g.fillStyle = `rgba(6,10,18,${dim})`;
  g.fillRect(0, 0, W, H);
}

function drawRoute(g, A, legs, upTo) {
  if (!A.map) return;
  const P = A.map.P;
  g.lineCap = 'round';
  for (const l of legs) {
    const a = P(l.a), b = P(l.b);
    g.strokeStyle = colorOf(l.day);
    g.globalAlpha = l.day < upTo ? 0.55 : 0.95;
    g.lineWidth = l.day < upTo ? 5 : 7;
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(a.x + (b.x - a.x) * l.f, a.y + (b.y - a.y) * l.f);
    g.stroke();
  }
  g.globalAlpha = 1;
  const seen = new Set();
  const dot = (s, r) => { const q = P(s); g.beginPath(); g.arc(q.x, q.y, r, 0, Math.PI * 2); g.fillStyle = colorOf(s.day); g.fill(); g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke(); };
  for (const l of legs) {
    if (!seen.has(l.a)) { seen.add(l.a); dot(l.a, 8); }
    if (l.f >= 1 && !seen.has(l.b)) { seen.add(l.b); dot(l.b, l.day === upTo ? 10 : 8); }
  }
  if (!legs.length && A.route.stops.length) { const s = A.route.stops.find((x) => x.day <= upTo); if (s) dot(s, 10); }
}

function kicker(g, s, x, y, color) { text(g, s.toUpperCase(), x, y, { weight: 600, px: 22, fam: MONO, color }); }

/** Draws the film at `t` seconds. A = { r, plan, map: { img, P } | null, photos: Map(id → bitmap), route, dayName, money }. */
export function drawFrame(g, A, t) {
  const { plan, r } = A, W = plan.w, H = plan.h;
  const { scene: s, p, into, left } = sceneAt(plan, t);
  g.save();
  g.textBaseline = 'alphabetic';
  if (s.kind === 'open') {
    mapLayer(g, A, W, H, 0.62);
    drawRoute(g, A, A.route.legs.map((l) => ({ ...l, f: 1 })), -1);
    g.fillStyle = 'rgba(6,10,18,.35)';
    g.fillRect(0, 0, W, H);
    const a = ease(clamp(into / 1.2, 0, 1));
    kicker(g, 'Memories', 96, H / 2 - 96, `rgba(255,255,255,${0.7 * a})`);
    lines(g, r.title, 96, H / 2 - 20 + (1 - a) * 18, W - 192, { weight: 700, px: 76, alpha: a, max: 2 });
    const b = ease(clamp((into - 0.5) / 1.2, 0, 1));
    text(g, `${A.dayName(r.start)} – ${A.dayName(r.end)}${r.destination ? ` · ${r.destination}` : ''}`, 96, H / 2 + 150, { weight: 500, px: 34, color: CORAL, alpha: b });
  } else if (s.kind === 'day') {
    const d = r.days[s.day];
    mapLayer(g, A, W, H, A.map ? 0.28 : 0);
    if (A.map) drawRoute(g, A, legsAt(A.route.legs, s.day, p), s.day);
    else { g.fillStyle = colorOf(s.day); g.fillRect(96, H / 2 + 40, (W - 192) * ease(p), 6); }
    const grad = g.createLinearGradient(0, 0, 0, 300);
    grad.addColorStop(0, 'rgba(6,10,18,.85)');
    grad.addColorStop(1, 'rgba(6,10,18,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, W, 300);
    kicker(g, `Day ${s.day + 1} · ${A.dayName(d.date)}`, 72, 92, colorOf(s.day));
    lines(g, d.title || `Day ${s.day + 1}`, 72, 150, W - 144, { weight: 700, px: 52, max: 1 });
    if (d.km) text(g, `${d.km} km in straight lines`, 72, 196, { weight: 500, px: 24, color: 'rgba(255,255,255,.75)' });
  } else if (s.kind === 'photo') {
    const ph = r.photos.find((x) => x.id === s.photo);
    const bmp = A.photos.get(s.photo);
    g.fillStyle = STAGE;
    g.fillRect(0, 0, W, H);
    if (bmp) {
      const c = kenBurns(s.n, bmp.width, bmp.height, W, H, A.still ? 0.5 : p);
      g.drawImage(bmp, c.sx, c.sy, c.sw, c.sh, 0, 0, W, H);
    }
    const grad = g.createLinearGradient(0, H - 260, 0, H);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,.72)');
    g.fillStyle = grad;
    g.fillRect(0, H - 260, W, 260);
    const d = r.days[s.day];
    kicker(g, `Day ${s.day + 1} · ${A.dayName(d.date)}`, 72, H - (ph && ph.caption ? 112 : 64), colorOf(s.day));
    if (ph && ph.caption) lines(g, ph.caption, 72, H - 60, W - 144, { weight: 600, px: 36, max: 1 });
  } else if (s.kind === 'stats') {
    mapLayer(g, A, W, H, 0.8);
    kicker(g, 'The trip in numbers', 96, 120, CORAL);
    const L = statLines(r, A.money);
    const cols = 3, cw = (W - 192) / cols;
    L.forEach(([v, label, note], i) => {
      const a = ease(clamp((into - 0.25 * i) / 0.8, 0, 1));
      const x = 96 + (i % cols) * cw, y = 250 + Math.floor(i / cols) * 190 + (1 - a) * 12;
      lines(g, v, x, y, cw - 32, { weight: 700, px: 64, alpha: a, max: 1 });
      text(g, label, x, y + 44, { weight: 500, px: 26, color: 'rgba(255,255,255,.85)', alpha: a });
      if (note) text(g, note, x, y + 78, { weight: 400, px: 20, color: 'rgba(255,255,255,.6)', alpha: a });
    });
    text(g, 'Stops say “planned” unless booked: Eden doesn’t know which you visited.', 96, H - 64, { weight: 400, px: 20, color: 'rgba(255,255,255,.6)' });
  } else {
    g.fillStyle = STAGE;
    g.fillRect(0, 0, W, H);
    lines(g, r.title, W / 2, H / 2 - 10, W - 192, { weight: 700, px: 56, align: 'center', max: 1 });
    text(g, 'Made with Ask Eden Travel', W / 2, H / 2 + 52, { weight: 500, px: 28, color: CORAL, align: 'center' });
  }
  // fade through the dark at each cut (none at the very start and end of the film)
  const fin = s === plan.scenes[0] ? 1 : into / plan.fade, fout = s === plan.scenes[plan.scenes.length - 1] ? 1 : left / plan.fade;
  const dark = 1 - clamp(Math.min(fin, fout), 0, 1);
  if (dark > 0) { g.fillStyle = `rgba(0,0,0,${dark})`; g.fillRect(0, 0, W, H); }
  g.restore();
}

/* ---------- loading and recording (browser) ---------- */

export function canRecord() {
  return typeof MediaRecorder === 'function' && typeof HTMLCanvasElement !== 'undefined' && typeof HTMLCanvasElement.prototype.captureStream === 'function' && Boolean(pickType((t) => MediaRecorder.isTypeSupported(t)));
}

// The map picture through travel.js's mapImage (its fetch and cache), at 640×360 (Google's scale 2 = 1280×720), dark.
// Its projection comes back through the draw hook; the frame has to be in the page for a first fetch to show.
function loadMap(mapImage, pts, host) {
  if (!mapImage || !pts.length) return Promise.resolve(null);
  return new Promise((done) => {
    let P = null;
    const frame = mapImage(pts, { w: 640, h: 360, style: 'day-dark', cls: 'tvf-mapsrc', draw: (_over, proj) => { P = proj; } });
    host.append(frame);
    const until = Date.now() + 20000;
    const tick = async () => {
      const img = frame.querySelector('img');
      if (P && img && img.getAttribute('src')) {
        // loaded, not img.decode(): that never settles for a picture that isn't rendered (Chrome)
        if (!img.complete) { img.addEventListener('load', tick, { once: true }); img.addEventListener('error', () => done(null), { once: true }); return; }
        return done(img.naturalWidth ? { img, P: (q) => { const o = P(q); return { x: o.x * 2, y: o.y * 2 }; } } : null);
      }
      if (Date.now() > until || frame.querySelector('.tv-map-empty')) return done(null);
      setTimeout(tick, 120);
    };
    tick();
  });
}

// The photo's bytes only (a few hundred KB each), all fetched before recording so it runs offline; each is decoded
// just before its scene and let go after it (decoded photos are ~10 MB each: a phone can't hold them all).
async function loadPhoto(url) {
  const res = await fetch(url, { credentials: 'same-origin', headers: { 'X-Jarvis-Chat': '1' } });
  if (!res.ok) throw new Error('photo');
  const blob = await res.blob();
  if (!/^image\//.test(blob.type)) throw new Error('photo');
  return blob;
}
async function decode(blob, W, H) {
  let bmp;
  try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch { bmp = await createImageBitmap(blob); }
  const k = Math.max((W * 1.15) / bmp.width, (H * 1.15) / bmp.height); // enough to fill the frame at the deepest zoom
  if (k >= 1) return bmp;
  try { const small = await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * k), resizeHeight: Math.round(bmp.height * k), resizeQuality: 'high' }); bmp.close(); return small; } catch { return bmp; }
}

/** Loads everything, then records the film in real time. Resolves to { blob, type, ext, seconds } (null when cancelled). */
export async function recordFilm(r, { photoUrl, mapImage, host, dayName, money, onStage, signal, still = false }) {
  const route = routeLegs(r);
  const pts = [...route.stops, ...r.photos.filter((p) => p.on_map)].map((p) => ({ lat: p.lat, lng: p.lng }));
  onStage({ stage: 'map' });
  const map = await loadMap(mapImage, pts, host);
  // the photos the film needs; one that won't load is left out and the timeline made again without it
  let rr = r, plan = planFilm(rr);
  const photos = new Map();
  for (let pass = 0; pass < 3; pass++) {
    const want = plan.scenes.filter((s) => s.kind === 'photo' && !photos.has(s.photo));
    if (!want.length) break;
    const bad = new Set();
    let n = 0;
    for (const s of want) {
      if (signal.aborted) return null;
      onStage({ stage: 'photos', done: n++, total: want.length });
      try { const blob = await loadPhoto(photoUrl(rr.photos.find((p) => p.id === s.photo))); (await decode(blob, 64, 36)).close(); photos.set(s.photo, blob); } catch { bad.add(s.photo); }
    }
    if (!bad.size) break;
    rr = { ...rr, photos: rr.photos.filter((p) => !bad.has(p.id)), days: rr.days.map((d) => ({ ...d, photos: d.photos.filter((id) => !bad.has(id)) })) };
    plan = planFilm(rr);
  }
  if (signal.aborted) return null;

  const pick = pickType((t) => MediaRecorder.isTypeSupported(t));
  const canvas = Object.assign(document.createElement('canvas'), { width: plan.w, height: plan.h });
  const g = canvas.getContext('2d');
  const bitmaps = new Map();
  const A = { r: rr, plan, map, photos: bitmaps, route, dayName, money, still };
  const photoScenes = plan.scenes.filter((s) => s.kind === 'photo');
  // decoded: the photo playing and the next one; the rest let go
  const keep = async (t) => {
    const k = photoScenes.findIndex((s) => s.t + s.dur > t);
    const want = k < 0 ? [] : photoScenes.slice(k, k + 2).map((s) => s.photo);
    for (const [id, b] of bitmaps) if (!want.includes(id)) { b.close && b.close(); bitmaps.delete(id); }
    for (const id of want) if (!bitmaps.has(id)) { bitmaps.set(id, null); bitmaps.set(id, await decode(photos.get(id), plan.w, plan.h)); }
  };
  await keep(0);
  drawFrame(g, A, 0);
  onStage({ stage: 'record', canvas, total: plan.total, at: 0, plan });
  const stream = canvas.captureStream(plan.fps);
  const rec = new MediaRecorder(stream, { mimeType: pick.type, videoBitsPerSecond: 4_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const stopped = new Promise((res) => { rec.onstop = res; });
  rec.start(1000);
  const t0 = performance.now();
  await new Promise((res) => {
    let last = -1;
    const frame = () => {
      if (signal.aborted) return res();
      const t = (performance.now() - t0) / 1000;
      drawFrame(g, A, Math.min(t, plan.total));
      keep(t).catch(() => {});
      const whole = Math.floor(t);
      if (whole !== last) { last = whole; onStage({ stage: 'record', canvas, total: plan.total, at: Math.min(t, plan.total), plan }); }
      if (t >= plan.total) return res();
      setTimeout(frame, 1000 / plan.fps); // timers, not animation frames: they keep going while the pane is hidden (slower)
    };
    frame();
  });
  const seconds = (performance.now() - t0) / 1000;
  rec.stop();
  await stopped;
  stream.getTracks().forEach((tr) => tr.stop());
  for (const b of bitmaps.values()) if (b && b.close) b.close();
  if (signal.aborted) return null;
  const type = pick.type.split(';')[0];
  let blob = new Blob(chunks, { type });
  if (pick.ext === 'webm') blob = new Blob([fixWebmDuration(new Uint8Array(await blob.arrayBuffer()), seconds * 1000)], { type });
  return { blob, type, ext: pick.ext, seconds, plan };
}

/* ---------- the sheet (browser) ---------- */

const mb = (n) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;

/** Opens the "Make a film" sheet over the page (outside the view's paints, so a repaint doesn't end a recording). */
export function openFilm(r, ctx) {
  const { el, ico, toast } = ctx;
  if (typeof document === 'undefined') return;
  if (!document.querySelector('link[href$="travel-film.css"]')) document.head.append(el('link', { rel: 'stylesheet', href: 'travel-film.css' }));
  const old = document.querySelector('.tvf-sheet');
  if (old) old.remove();
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const plan = planFilm(r);
  let ctl = null, url = null;
  const back = document.activeElement;
  const close = () => { if (ctl) ctl.abort(); if (url) URL.revokeObjectURL(url); sheet.remove(); if (back && back.focus) back.focus(); };
  const body = el('div', 'tvf-body');
  const hidden = el('div', { class: 'tvf-hidden', 'aria-hidden': 'true' });
  const sheet = el('div', { class: 'tvf-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tvfTitle', tabindex: '-1', onkeydown: (e) => { if (e.key === 'Escape') close(); }, onclick: (e) => { if (e.target === sheet) close(); } },
    el('div', 'tvf-card glass-card',
      el('div', 'tvf-top', el('h2', { id: 'tvfTitle' }, 'Make a film'), el('button', { type: 'button', class: 'tv-x', 'aria-label': 'Close', onclick: close }, ico('x', 16))),
      body, hidden));
  const secs = Math.round(plan.total);
  const show = (...kids) => body.replaceChildren(...kids.filter(Boolean));
  const intro = () => {
    const can = canRecord();
    show(
      el('p', 'tv-note', `About ${secs} seconds: the route drawn day by day, ${plan.photos ? `${plan.photos} of your photos` : 'no photos yet'}, and the trip’s numbers. Silent.`),
      plan.left > 0 ? el('p', 'tv-fine', `${plan.left} photo${plan.left === 1 ? '' : 's'} left out to keep it under ${FILM.max} seconds: an even share from each day.`) : null,
      r.undated && r.undated.length ? el('p', 'tv-fine', `Photos with no date aren’t in it until you pick their day.`) : null,
      el('p', 'tv-fine', 'Made on this device and saved as a file; nothing is uploaded. It records in real time, so keep this page open.'),
      can ? el('div', 'tv-acts', el('button', { type: 'button', class: 'tv-btn primary', onclick: start }, 'Make the film'))
        : el('p', 'tv-note warn', 'This browser can’t record video. Try Safari or Chrome.'));
  };
  const start = async () => {
    ctl = new AbortController();
    const bar = el('progress', { class: 'tvf-bar', max: '1', value: '0' });
    const say = el('p', { class: 'tv-note', role: 'status', 'aria-live': 'polite' }, 'Getting the map…');
    const stage = el('div', 'tvf-stage');
    show(stage, bar, say, el('div', 'tv-acts', el('button', { type: 'button', class: 'tv-btn quiet', onclick: () => { ctl.abort(); intro(); } }, 'Cancel')));
    try {
      const out = await recordFilm(r, { photoUrl: ctx.photoUrl, mapImage: ctx.mapImage, host: hidden, dayName: ctx.dayName, money: ctx.money, signal: ctl.signal, onStage: (st) => {
        if (st.stage === 'photos') { say.textContent = `Loading photo ${st.done + 1} of ${st.total}…`; bar.value = 0; }
        if (st.stage === 'record') {
          if (!reduced && !stage.firstChild) stage.append(st.canvas); // under reduced motion: the progress only
          if (reduced && !stage.firstChild) stage.append(el('p', 'tv-fine', 'Recording. The film isn’t shown while it records because your device asks for reduced motion.'));
          bar.value = st.at / st.total;
          say.textContent = `Recording ${Math.floor(st.at)} of ${Math.round(st.total)} seconds · keep this page open`;
        }
      } });
      if (!out) return;
      ctl = null;
      url = URL.createObjectURL(out.blob);
      const name = fileName(r.title, out.ext);
      const video = el('video', { class: 'tvf-video', src: url, controls: '', playsinline: '', preload: 'metadata', 'aria-label': `The film of ${r.title}, ${Math.round(out.seconds)} seconds, silent` });
      video.muted = true;
      show(video,
        el('p', 'tv-fine', `${out.ext.toUpperCase()} · ${Math.round(out.seconds)} s · ${mb(out.blob.size)} · silent · only on this device until you save it`),
        el('div', 'tv-acts',
          el('a', { class: 'tv-btn primary', href: url, download: name }, ico('down', 13), 'Save the film'),
          el('button', { type: 'button', class: 'tv-btn quiet', onclick: () => { URL.revokeObjectURL(url); url = null; intro(); } }, 'Make it again')));
    } catch (e) {
      ctl = null;
      toast(String((e && e.message) || e));
      intro();
    }
  };
  intro();
  document.body.append(sheet);
  setTimeout(() => sheet.focus(), 0);
}
