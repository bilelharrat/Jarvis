// A photo's own place and time, read from its EXIF on the device (Memories, travel-memories.js). Pure, no imports, so
// the server's tests can load it too (site test/travel-memories.test.js). Reads: JPEG (APP1 Exif), PNG (eXIf), WebP
// (EXIF chunk) and HEIC (the Exif item found through meta → iinf/iloc). Only GPS latitude/longitude, the time the photo
// was taken (DateTimeOriginal, with OffsetTimeOriginal when the camera wrote it) and the orientation. Anything odd or out
// of bounds is read as "not there": a photo without a GPS fix is never given a place, one without a date never a time.
//
//   readExif(bytes: Uint8Array | ArrayBuffer) → { lat, lng, taken_at, orientation, format, found }
//     lat/lng: numbers or null · taken_at: 'YYYY-MM-DDTHH:MM:SS' (+ '+HH:MM' when known) or null · found: an EXIF block was read

const NONE = (format) => ({ lat: null, lng: null, taken_at: null, orientation: null, format, found: false });
const MAX_IFD_ENTRIES = 512;

export function readExif(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input || []);
  try {
    if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return fromTiff(b, jpegExif(b), 'jpeg');
    if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return fromTiff(b, pngExif(b), 'png');
    if (b.length > 12 && str(b, 0, 4) === 'RIFF' && str(b, 8, 4) === 'WEBP') return fromTiff(b, webpExif(b), 'webp');
    if (b.length > 12 && str(b, 4, 4) === 'ftyp') return fromTiff(b, heicExif(b), 'heic');
  } catch { /* a damaged file: nothing read */ }
  return NONE(null);
}

function str(b, at, n) {
  let s = '';
  for (let i = 0; i < n && at + i < b.length; i++) s += String.fromCharCode(b[at + i]);
  return s;
}
const u16be = (b, at) => (b[at] << 8) | b[at + 1];
const u32be = (b, at) => ((b[at] << 24) >>> 0) + ((b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]);
const u32le = (b, at) => ((b[at + 3] << 24) >>> 0) + ((b[at + 2] << 16) | (b[at + 1] << 8) | b[at]);

/* ---------- where the TIFF block starts, per format: { start, end } or null ---------- */

function jpegExif(b) {
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    if (marker === 0xff) { at++; continue; } // fill bytes
    if (marker === 0xd9 || marker === 0xda) return null; // end, or the image data: no EXIF before it
    if (marker >= 0xd0 && marker <= 0xd7) { at += 2; continue; }
    const len = u16be(b, at + 2);
    if (len < 2 || at + 2 + len > b.length) return null;
    if (marker === 0xe1 && len >= 8 && str(b, at + 4, 6) === 'Exif\0\0') return { start: at + 10, end: at + 2 + len };
    at += 2 + len;
  }
  return null;
}

function pngExif(b) {
  let at = 8;
  while (at + 12 <= b.length) {
    const len = u32be(b, at), type = str(b, at + 4, 4);
    if (at + 12 + len > b.length) return null;
    if (type === 'eXIf') return { start: at + 8, end: at + 8 + len };
    if (type === 'IDAT' || type === 'IEND') return null;
    at += 12 + len;
  }
  return null;
}

function webpExif(b) {
  let at = 12;
  while (at + 8 <= b.length) {
    const type = str(b, at, 4), len = u32le(b, at + 4);
    if (at + 8 + len > b.length) return null;
    if (type === 'EXIF') {
      const s = str(b, at + 8, 6) === 'Exif\0\0' ? at + 14 : at + 8;
      return { start: s, end: at + 8 + len };
    }
    at += 8 + len + (len & 1);
  }
  return null;
}

// ISO base media boxes: [size, type] (size 1 → a 64-bit size follows; 0 → to the end)
function boxes(b, start, end) {
  const out = [];
  let at = start;
  while (at + 8 <= end && out.length < 1024) {
    let size = u32be(b, at), head = 8;
    const type = str(b, at + 4, 4);
    if (size === 1) { if (at + 16 > end || u32be(b, at + 8) !== 0) break; size = u32be(b, at + 12); head = 16; }
    else if (size === 0) size = end - at;
    if (size < head || at + size > end) break;
    out.push({ type, start: at + head, end: at + size });
    at += size;
  }
  return out;
}
function uintN(b, at, n) {
  if (n === 0) return 0;
  if (n === 4) return u32be(b, at);
  if (n === 8) return u32be(b, at) === 0 ? u32be(b, at + 4) : NaN; // beyond 4 GB: not a phone photo
  if (n === 2) return u16be(b, at);
  return NaN;
}

function heicExif(b) {
  const meta = boxes(b, 0, b.length).find((x) => x.type === 'meta');
  if (!meta) return null;
  const inner = boxes(b, meta.start + 4, meta.end); // meta is a full box: version and flags first
  const iinf = inner.find((x) => x.type === 'iinf'), iloc = inner.find((x) => x.type === 'iloc');
  if (!iinf || !iloc) return null;
  // the Exif item's id, from its infe (version 2 or 3)
  const v = b[iinf.start];
  const count = v === 0 ? u16be(b, iinf.start + 4) : u32be(b, iinf.start + 4);
  let exifId = null;
  for (const e of boxes(b, iinf.start + 4 + (v === 0 ? 2 : 4), iinf.end).slice(0, count)) {
    if (e.type !== 'infe') continue;
    const ev = b[e.start];
    if (ev < 2) continue;
    const id = ev === 2 ? u16be(b, e.start + 4) : u32be(b, e.start + 4);
    const typeAt = e.start + 4 + (ev === 2 ? 2 : 4) + 2;
    if (str(b, typeAt, 4) === 'Exif') { exifId = id; break; }
  }
  if (exifId === null) return null;
  // its place in the file, from iloc
  const lv = b[iloc.start];
  let at = iloc.start + 4;
  const offSize = b[at] >> 4, lenSize = b[at] & 15, baseSize = b[at + 1] >> 4, idxSize = lv === 1 || lv === 2 ? b[at + 1] & 15 : 0;
  at += 2;
  const items = lv < 2 ? u16be(b, at) : u32be(b, at);
  at += lv < 2 ? 2 : 4;
  for (let i = 0; i < items && at < iloc.end; i++) {
    const id = lv < 2 ? u16be(b, at) : u32be(b, at);
    at += lv < 2 ? 2 : 4;
    let method = 0;
    if (lv === 1 || lv === 2) { method = u16be(b, at) & 15; at += 2; }
    at += 2; // data_reference_index
    const base = uintN(b, at, baseSize); at += baseSize;
    const extents = u16be(b, at); at += 2;
    let first = null;
    for (let k = 0; k < extents; k++) {
      at += idxSize;
      const off = uintN(b, at, offSize); at += offSize;
      const len = uintN(b, at, lenSize); at += lenSize;
      if (k === 0) first = { off, len };
    }
    if (id !== exifId) continue;
    if (method !== 0 || !first || !Number.isFinite(base + first.off) || !Number.isFinite(first.len)) return null; // only plain file offsets
    const s = base + first.off, e = s + (first.len || b.length - s);
    if (s + 4 > b.length || e > b.length) return null;
    // the Exif item: a 4-byte offset to the TIFF header (past an optional "Exif\0\0"), then TIFF
    const skip = u32be(b, s);
    const start = s + 4 + skip;
    return start < e ? { start, end: e } : null;
  }
  return null;
}

/* ---------- TIFF: IFD0 → the Exif IFD (time) and the GPS IFD (place) ---------- */

function fromTiff(b, where, format) {
  if (!where) return NONE(format);
  const { start, end } = where;
  if (end - start < 8 || end > b.length) return NONE(format);
  const order = str(b, start, 2);
  if (order !== 'II' && order !== 'MM') return NONE(format);
  const le = order === 'II';
  const u16 = (o) => { const at = start + o; if (o < 0 || at + 2 > end) throw new RangeError('exif'); return le ? b[at] | (b[at + 1] << 8) : u16be(b, at); };
  const u32 = (o) => { const at = start + o; if (o < 0 || at + 4 > end) throw new RangeError('exif'); return le ? u32le(b, at) : u32be(b, at); };
  if (u16(2) !== 42) return NONE(format);
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

  // one IFD → Map(tag → { type, count, at }) where at is the value's offset from the TIFF start
  const ifd = (o) => {
    const tags = new Map();
    if (!o || o < 8) return tags;
    const n = u16(o);
    if (n > MAX_IFD_ENTRIES) return tags;
    for (let i = 0; i < n; i++) {
      const e = o + 2 + i * 12;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      if (!SIZE[type] || count > 1_000_000) continue;
      const bytes = SIZE[type] * count;
      tags.set(tag, { type, count, at: bytes <= 4 ? e + 8 : u32(e + 8) });
    }
    return tags;
  };
  const ascii = (t) => {
    if (!t || t.type !== 2) return null;
    let s = '';
    for (let i = 0; i < t.count; i++) { const at = start + t.at + i; if (at >= end) return null; const c = b[at]; if (c === 0) break; s += String.fromCharCode(c); }
    return s.trim();
  };
  const rationals = (t, n) => {
    if (!t || (t.type !== 5 && t.type !== 10) || t.count < n) return null;
    const out = [];
    for (let i = 0; i < n; i++) {
      let num = u32(t.at + i * 8), den = u32(t.at + i * 8 + 4);
      if (t.type === 10) { num |= 0; den |= 0; }
      if (!den) return null;
      out.push(num / den);
    }
    return out;
  };
  const short = (t) => (t && t.type === 3 ? u16(t.at) : t && t.type === 4 ? u32(t.at) : null);

  const out = { ...NONE(format), found: true };
  const ifd0 = ifd(u32(4));
  const o = short(ifd0.get(0x0112));
  out.orientation = o >= 1 && o <= 8 ? o : null;

  // when: DateTimeOriginal (the shutter), its offset when written; DateTime (last edited) is not the photo's time
  const exifPtr = ifd0.get(0x8769);
  if (exifPtr && (exifPtr.type === 4 || exifPtr.type === 13 || exifPtr.type === 3)) {
    const ex = ifd(u32(exifPtr.at));
    const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(ascii(ex.get(0x9003)) || '');
    if (m && m[1] !== '0000') {
      const [, y, mo, d, h, mi, s] = m;
      if (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31 && +h <= 23 && +mi <= 59 && +s <= 59) {
        const off = ascii(ex.get(0x9011));
        out.taken_at = `${y}-${mo}-${d}T${h}:${mi}:${s}${/^[+-]\d{2}:\d{2}$/.test(off || '') ? off : ''}`;
      }
    }
  }

  // where: GPS, only a real fix (no "V" void status, refs N/S and E/W, in range, not 0,0)
  const gpsPtr = ifd0.get(0x8825);
  if (gpsPtr) {
    const g = ifd(u32(gpsPtr.at));
    const status = ascii(g.get(0x0009));
    const latRef = ascii(g.get(0x0001)), lngRef = ascii(g.get(0x0003));
    const lat = rationals(g.get(0x0002), 3), lng = rationals(g.get(0x0004), 3);
    if (status !== 'V' && lat && lng && /^[NS]$/i.test(latRef || '') && /^[EW]$/i.test(lngRef || '')) {
      const dms = (x) => x[0] + x[1] / 60 + x[2] / 3600;
      const a = dms(lat) * (/^s$/i.test(latRef) ? -1 : 1), c = dms(lng) * (/^w$/i.test(lngRef) ? -1 : 1);
      if (Number.isFinite(a) && Number.isFinite(c) && Math.abs(a) <= 90 && Math.abs(c) <= 180 && lat.every((x) => x >= 0) && lng.every((x) => x >= 0) && !(a === 0 && c === 0)) {
        out.lat = Math.round(a * 1e6) / 1e6;
        out.lng = Math.round(c * 1e6) / 1e6;
      }
    }
  }
  return out;
}
