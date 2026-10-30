// A trip as a calendar file (RFC 5545), for Apple Calendar, Google Calendar and Outlook: one
// event per stop. A trip has no time zone, so times are floating ("10:00 wherever you are"),
// which is how the trip means them. A stay with nights is an all-day event over its nights.
//
// The file says only what the trip says: the place, the time, the person's note. Nothing is
// added to it.

import { dayDate, minutesOf } from './trips.js';

const CRLF = '\r\n';
const MAX_OCTETS = 75; // per line, CRLF not counted (RFC 5545 3.1)
const enc = new TextEncoder();

// TEXT values (RFC 5545 3.3.11): backslash, semicolon and comma escaped, newlines as \n.
export function escapeText(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// Lines over 75 octets go on as CRLF + one space. Splits fall between characters, never inside
// a UTF-8 sequence, so a place name like "São Jorge" never breaks mid-letter.
export function foldLine(line) {
  if (enc.encode(line).length <= MAX_OCTETS) return line;
  const parts = [];
  let cur = '', size = 0, limit = MAX_OCTETS;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (size + n > limit) {
      parts.push(cur);
      cur = '';
      size = 0;
      limit = MAX_OCTETS - 1; // the leading space counts
    }
    cur += ch;
    size += n;
  }
  parts.push(cur);
  return parts.join(`${CRLF} `);
}

const two = (n) => String(n).padStart(2, '0');
const ymd = (date) => date.replace(/-/g, '');
// a wall-clock time on a date, as a Date in UTC used only for arithmetic (it is not an instant)
const wall = (date, mins) => new Date(Date.parse(`${date}T00:00:00Z`) + mins * 60_000);
const floating = (d) => `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}T${two(d.getUTCHours())}${two(d.getUTCMinutes())}00`;
const dateOnly = (d) => `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}`;
const utcStamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const uidPart = (s) => String(s ?? '').replace(/[^A-Za-z0-9._-]/g, '-') || 'x';

/** tripToIcs(trip, { id, now }) → the trip as RFC 5545 text (CRLF lines, folded at 75 octets). */
export function tripToIcs(trip, { id = trip?.id, now = Date.now() } = {}) {
  const stamp = utcStamp(typeof now === 'function' ? now() : now);
  const tripId = uidPart(id);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Ask Eden//Eden Travel//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(trip.title)}`,
  ];
  trip.days.forEach((day, d) => {
    const date = dayDate(trip, d);
    for (const s of day.stops) {
      const ev = ['BEGIN:VEVENT', `UID:${tripId}-${uidPart(s.id)}@askeden.com`, `DTSTAMP:${stamp}`];
      if (s.kind === 'stay' && Number.isInteger(s.nights) && s.nights > 0) {
        // all-day from the first night to check-out morning; DTEND is the day after the last night
        ev.push(`DTSTART;VALUE=DATE:${ymd(date)}`, `DTEND;VALUE=DATE:${dateOnly(wall(date, s.nights * 1440))}`, 'TRANSP:TRANSPARENT');
      } else {
        const start = minutesOf(s.at);
        ev.push(`DTSTART:${floating(wall(date, start))}`);
        // a 0-minute stop has no DTEND: the event ends when it starts (RFC 5545 3.6.1)
        if (s.minutes > 0) ev.push(`DTEND:${floating(wall(date, start + s.minutes))}`);
      }
      ev.push(`SUMMARY:${escapeText(s.place?.name)}`);
      if (s.place?.name) ev.push(`LOCATION:${escapeText(s.place.name)}`);
      if (Number.isFinite(s.place?.lat) && Number.isFinite(s.place?.lng)) ev.push(`GEO:${s.place.lat};${s.place.lng}`);
      if (s.note) ev.push(`DESCRIPTION:${escapeText(s.note)}`);
      ev.push('END:VEVENT');
      lines.push(...ev);
    }
  });
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join(CRLF) + CRLF;
}
