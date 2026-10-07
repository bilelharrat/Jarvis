// The calendar's pure parts (no DOM, no imports): local-time date math that is safe across
// daylight-saving changes, the normalized event shape for the Mac's calendar (Jarvis's JSON,
// or the older text format), the layout of overlapping events (side by side, as Apple
// Calendar does) and of all-day bars, and the arguments each write sends. calendar.js draws;
// src/__tests__/calendar.test.ts tests this file directly.

/* ---------- local dates (never add 86,400,000 ms for a day: DST days are 23 or 25 hours) ---------- */

export const DAY_MS = 864e5;
export const pad = (n) => String(n).padStart(2, '0');

export function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
/** The same wall-clock time n days later. */
export function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()); }
/** The same day of the month n months later (clamped: Jan 31 + 1 month → Feb 28/29). */
export function addMonths(d, n) {
  const first = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(d.getDate(), last), d.getHours(), d.getMinutes());
}
export function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
/** The week's first day at or before d (firstDay: 0 Sunday … 6 Saturday). */
export function startOfWeek(d, firstDay = 0) { const s = startOfDay(d); return addDays(s, -((s.getDay() - firstDay + 7) % 7)); }
export function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
/** Local calendar date as YYYY-MM-DD. */
export function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
/** YYYY-MM-DD → local midnight. */
export function parseYmd(s) { const [y, m, d] = String(s).slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); }
/** Calendar days from a to b (local dates; DST-proof). */
export function daysBetween(a, b) {
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / DAY_MS);
}
/** Minutes since local midnight by the wall clock (1:30 PM → 810), so events line up with the hour labels on DST days too. */
export function minutesIntoDay(d) { return d.getHours() * 60 + d.getMinutes(); }
/** Local wall time, as Jarvis takes it: 2026-10-06T10:00. */
export function isoLocal(d) { return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }
/** An instant with the local offset at that instant: 2026-10-06T10:00:00+01:00 (what Google takes). */
export function isoWithOffset(d) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${isoLocal(d)}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
/** The browser's IANA zone (Europe/London), or null. */
export function localZone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } }
/** The locale's first day of the week (0 Sunday, 1 Monday), from Intl when it knows. */
export function firstDayOfWeek(locale) {
  try {
    const l = new Intl.Locale(locale || 'en-US');
    const info = (typeof l.getWeekInfo === 'function' ? l.getWeekInfo() : l.weekInfo);
    if (info && info.firstDay) return info.firstDay % 7;
  } catch { /* old engines */ }
  return /^en-(US|CA|PH)|^(ja|ko|zh-TW|he|pt-BR)/.test(locale || 'en-US') ? 0 : 1;
}

/* ---------- views and ranges ---------- */

export const VIEWS = ['day', 'week', 'month', 'agenda'];
export const AGENDA_DAYS = 30;

/** The days a view shows around `anchor`: { start, end (exclusive), days }. Month grids are whole weeks. */
export function rangeFor(view, anchor, firstDay = 0) {
  let start, n;
  if (view === 'day') { start = startOfDay(anchor); n = 1; }
  else if (view === 'week') { start = startOfWeek(anchor, firstDay); n = 7; }
  else if (view === 'agenda') { start = startOfDay(anchor); n = AGENDA_DAYS; }
  else {
    const first = startOfMonth(anchor);
    start = startOfWeek(first, firstDay);
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
    n = Math.ceil((daysBetween(start, last) + 1) / 7) * 7;
  }
  const days = Array.from({ length: n }, (_, i) => addDays(start, i));
  return { start, end: addDays(start, n), days };
}
/** The anchor one step back or forward in a view. */
export function shiftAnchor(view, anchor, dir) {
  if (view === 'month') return addMonths(anchor, dir);
  if (view === 'week') return addDays(anchor, 7 * dir);
  if (view === 'agenda') return addDays(anchor, 7 * dir);
  return addDays(anchor, dir);
}
/** a – b in the locale's own way ("Oct 6 – Nov 4, 2026"; "October 2026" when the parts shown match). */
export function formatRange(a, b, locale, opts) {
  const f = new Intl.DateTimeFormat(locale, opts);
  if (typeof f.formatRange === 'function') return f.formatRange(a, b);
  const x = f.format(a), y = f.format(b);
  return x === y ? x : `${x} – ${y}`;
}
/** The header's title for a view: the month (as Apple Calendar's week view does), the day, or the agenda's dates. */
export function rangeTitle(view, anchor, range, locale) {
  if (view === 'month') return anchor.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
  if (view === 'day') return anchor.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const a = range.start, b = addDays(range.end, -1);
  if (view === 'week') return formatRange(a, b, locale, a.getFullYear() === b.getFullYear() ? { month: 'long', year: 'numeric' } : { month: 'short', year: 'numeric' });
  return formatRange(a, b, locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

/* ---------- the normalized event ---------- */

/** Apple's calendar colours, for calendars that bring none (picked by name, so they stay put). */
export const PALETTE = ['#1badf8', '#63da38', '#ff2968', '#cc73e1', '#ff9500', '#a2845e', '#ffcc00', '#5856d6'];
export function colorFor(name) {
  let h = 0;
  for (const ch of String(name || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
const hex = (c) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c.trim()) ? c.trim().toLowerCase() : '');

/** An event's span as local Dates: all-day → local midnights; timed → instants. */
export function bounds(e) {
  if (e.allDay) return { s: parseYmd(e.start), e: parseYmd(e.end) };
  return { s: new Date(e.start), e: new Date(e.end) };
}
/** Timed events of a day or more sit with the all-day ones (as in Apple Calendar). */
export function isLong(e) {
  if (e.allDay) return true;
  return new Date(e.end) - new Date(e.start) >= DAY_MS;
}
export function overlaps(e, start, end) { const b = bounds(e); return b.s < end && (b.e > start || (+b.e === +b.s && b.s >= start)); }
export function eventKey(e) { return `${e.source}|${e.calendarId}|${e.id}|${e.start}`; }

/** A date or date-time from Jarvis as the normalized value: all-day → YYYY-MM-DD; timed → UTC ISO. */
function macTime(v, allDay) {
  const s = String(v || '');
  if (allDay) return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
  const t = Date.parse(s.length === 16 ? `${s}:00` : s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Jarvis's structured calendar (`calendar` with format "json") → { calendars, events, timeZone }.
 * Unknown or broken rows are dropped, never guessed.
 */
export function normalizeMacJson(j) {
  if (!j || typeof j !== 'object' || !Array.isArray(j.events)) return null;
  const calendars = new Map();
  for (const c of Array.isArray(j.calendars) ? j.calendars : []) {
    if (!c || typeof c !== 'object') continue;
    const title = String(c.title || c.name || '').trim();
    const id = String(c.id || (title ? `mac:${title}` : '')).trim();
    if (!id) continue;
    calendars.set(id, { id, source: 'mac', title: title || 'Calendar', color: hex(c.color) || colorFor(title), primary: false, readOnly: c.writable === false, timeZone: null, selected: true, account: String(c.source || '') });
  }
  const byTitle = new Map([...calendars.values()].map((c) => [c.title, c]));
  const events = [];
  for (const r of j.events) {
    if (!r || typeof r !== 'object') continue;
    const allDay = r.allDay === true || r.all_day === true;
    const start = macTime(r.start ?? r.begin, allDay);
    let end = macTime(r.end, allDay);
    if (!start) continue;
    if (allDay) {
      if (!end || end <= start) end = ymd(addDays(parseYmd(start), 1));
    } else if (!end || Date.parse(end) < Date.parse(start)) end = start;
    const calTitle = String(r.calendar || '').trim();
    let cal = (r.calendarId && calendars.get(String(r.calendarId))) || byTitle.get(calTitle);
    if (!cal) {
      const id = String(r.calendarId || `mac:${calTitle || 'Calendar'}`);
      cal = { id, source: 'mac', title: calTitle || 'Calendar', color: colorFor(calTitle), primary: false, readOnly: r.writable === false, timeZone: null, selected: true, account: '' };
      calendars.set(id, cal);
      byTitle.set(cal.title, cal);
    }
    const writable = r.writable !== false && !cal.readOnly;
    events.push({
      id: String(r.id || `mac:${start}:${r.title}`),
      source: 'mac',
      calendarId: cal.id,
      title: String(r.title || '').trim() || 'Untitled',
      start, end, allDay,
      timeZone: typeof r.timeZone === 'string' && r.timeZone ? r.timeZone : null,
      location: String(r.location || ''),
      notes: String(r.notes || ''),
      attendees: (Array.isArray(r.attendees) ? r.attendees : []).slice(0, 50).map((a) => (typeof a === 'string' ? { name: a, email: '', status: '', organizer: false, self: false }
        : { name: String(a.name || ''), email: String(a.email || ''), status: String(a.status || ''), organizer: a.organizer === true, self: a.self === true })),
      recurrence: r.recurring === true || r.repeats === true ? { recurring: true, seriesId: null, rules: [] } : null,
      url: /^https:\/\//.test(String(r.url || '')) ? String(r.url) : '',
      // its own link field and its alerts (minutes before), which Eden can change; null: this Jarvis doesn't say
      eventUrl: /^https:\/\//.test(String(r.eventUrl || '')) ? String(r.eventUrl) : '',
      alerts: Array.isArray(r.alerts) ? [...new Set(r.alerts.filter((m) => Number.isInteger(m) && m >= 0 && m <= ALERT_MOST))].sort((a, b) => a - b) : null,
      link: '',
      color: null,
      readOnly: !writable,
      canEdit: writable,
      // How Jarvis finds it again for a change: its title, its start as Jarvis wrote it, its calendar's name.
      mac: { title: String(r.title || ''), start: String(r.start ?? r.begin ?? ''), calendar: cal.title },
    });
  }
  return { calendars: [...calendars.values()], events, timeZone: typeof j.timeZone === 'string' ? j.timeZone : null };
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const LEGACY_LINE = /^\s*-\s*\w{3}\s+(\d{1,2})\s+(\w{3})\s*(?:\(all day\)|(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2}))\s*:\s*(.*?)(?:\s+\[([^\]]*)\])?\s*$/;

/** A day number and month name from the old format, placed in the year that puts it inside the range asked for. */
function legacyDay(day, mon, rangeStart, rangeEnd) {
  const m = MONTHS[String(mon).toLowerCase()];
  if (m === undefined) return null;
  const lo = addDays(rangeStart, -2), hi = addDays(rangeEnd, 2);
  for (const y of [rangeStart.getFullYear(), rangeStart.getFullYear() + 1, rangeStart.getFullYear() - 1]) {
    const d = new Date(y, m, Number(day));
    if (d.getMonth() === m && d >= lo && d < hi) return d;
  }
  return null;
}
let legacySeq = 0;
/**
 * The older Jarvis's text ("- Tue 06 Oct 10:00–10:30: Title [Work]", "- Wed 07 Oct (all day): …")
 * for the range it was asked → normalized events (read-only: that Jarvis can't change events).
 */
export function parseLegacyText(text, rangeStart, rangeEnd) {
  const t = String(text || '').replace(/^\(From the owner's Jarvis:[^)]*\)\s*/, '').trim();
  if (!t || /^Nothing on the calendar/i.test(t)) return { calendars: [], events: [] };
  const calendars = new Map();
  const events = [];
  for (const line of t.split('\n')) {
    const m = LEGACY_LINE.exec(line);
    if (!m) continue;
    const day = legacyDay(m[1], m[2], rangeStart, rangeEnd);
    if (!day) continue;
    const calTitle = (m[8] || '').trim() || 'Calendar';
    const calId = `mac:${calTitle}`;
    if (!calendars.has(calId)) calendars.set(calId, { id: calId, source: 'mac', title: calTitle, color: colorFor(calTitle), primary: false, readOnly: true, timeZone: null, selected: true, account: '' });
    let start, end, allDay;
    if (m[3] === undefined) { allDay = true; start = ymd(day); end = ymd(addDays(day, 1)); }
    else {
      allDay = false;
      const s = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(m[3]), Number(m[4]));
      let e = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(m[5]), Number(m[6]));
      if (e <= s) e = addDays(e, 1); // 23:00–01:00 ends the next day
      start = s.toISOString(); end = e.toISOString();
    }
    const title = m[7].trim() || 'Untitled';
    events.push({ id: `legacy-${++legacySeq}`, source: 'mac', calendarId: calId, title, start, end, allDay, timeZone: null, location: '', notes: '', attendees: [], recurrence: null, url: '', link: '', color: null, readOnly: true, canEdit: false, mac: null });
  }
  return { calendars: [...calendars.values()], events };
}

/** Jarvis's answer to `calendar` → normalized, whichever Jarvis answered: { calendars, events, legacy }. */
export function parseMacCalendar(text, rangeStart, rangeEnd) {
  const raw = String(text || '').trim();
  if (raw.startsWith('{')) {
    try {
      const j = normalizeMacJson(JSON.parse(raw));
      if (j) return { ...j, legacy: false };
    } catch { /* not JSON after all */ }
  }
  return { ...parseLegacyText(raw, rangeStart, rangeEnd), legacy: true, timeZone: null };
}

/** The arguments for Jarvis's calendar read of [start, end): JSON for a new Jarvis, and the old offset/days an older one reads. */
export function macReadArgs(start, end, today = new Date()) {
  const days = Math.max(1, daysBetween(start, end));
  return {
    format: 'json', start: ymd(start), end: ymd(end),
    start_offset_days: Math.max(-31, Math.min(365, daysBetween(startOfDay(today), start))),
    days: Math.min(14, days),
  };
}
/** An older Jarvis reads 14 days at most: the [start, end) pieces to ask it for. */
export function legacyChunks(start, end) {
  const out = [];
  for (let s = startOfDay(start); s < end; s = addDays(s, 14)) out.push([s, addDays(s, 14) < end ? addDays(s, 14) : end]);
  return out;
}

/* ---------- layout ---------- */

/**
 * Timed events of one day, side by side where they overlap (Apple Calendar's layout): each
 * group of events that overlap one another is split into columns; an event then widens into
 * free columns to its right. Input: [{ startMin, endMin, … }]. Output: the same objects with
 * col, cols and span. Short events count as minHeight minutes long, as they're drawn.
 */
export function layoutColumns(items, minMinutes = 20) {
  const list = [...items].sort((a, b) => a.startMin - b.startMin || (b.endMin - b.startMin) - (a.endMin - a.startMin));
  const vEnd = (x) => Math.max(x.endMin, x.startMin + minMinutes);
  let cluster = [], cols = [], clusterEnd = -1;
  const close = () => {
    const n = cols.length;
    for (const x of cluster) {
      x.cols = n;
      let span = 1;
      for (let c = x.col + 1; c < n; c++) {
        if (cluster.some((y) => y.col === c && y.startMin < vEnd(x) && vEnd(y) > x.startMin)) break;
        span++;
      }
      x.span = span;
    }
    cluster = []; cols = []; clusterEnd = -1;
  };
  for (const x of list) {
    if (cluster.length && x.startMin >= clusterEnd) close();
    let c = cols.findIndex((end) => end <= x.startMin);
    if (c < 0) { c = cols.length; cols.push(0); }
    cols[c] = vEnd(x);
    x.col = c;
    cluster.push(x);
    clusterEnd = Math.max(clusterEnd, vEnd(x));
  }
  if (cluster.length) close();
  return list;
}

/** The part of a timed event inside one local day, in wall-clock minutes; null when it isn't in that day. */
export function daySegment(e, day) {
  const d0 = startOfDay(day), d1 = addDays(d0, 1);
  const s = new Date(e.start), en = new Date(e.end);
  if (!(s < d1 && (en > d0 || (+en === +s && s >= d0)))) return null;
  const startMin = s <= d0 ? 0 : minutesIntoDay(s);
  let endMin = en >= d1 ? 1440 : minutesIntoDay(en);
  if (endMin <= startMin) endMin = Math.min(1440, startMin + 15); // zero-length, or a fall-back hour
  return { startMin, endMin, before: s < d0, after: en > d1 };
}

/**
 * Bars across a row of days (a month week, or the week view's all-day strip): each event
 * gets the first lane free on all its days. days: the row's dates. startDayOnly: timed events
 * under a day long take only their start day (the month view). Output: [{ event, lane, from,
 * to (exclusive column) }], plus each day's count.
 */
export function layoutLanes(events, days, { startDayOnly = false } = {}) {
  const first = startOfDay(days[0]);
  const n = days.length;
  const rows = [];
  for (const e of events) {
    const b = bounds(e);
    if (startDayOnly && !isLong(e)) {
      // a timed event under a day long sits on its start day only (as in Apple Calendar's month)
      const from = daysBetween(first, b.s);
      if (from >= 0 && from < n) rows.push({ event: e, from, to: from + 1, lane: 0 });
      continue;
    }
    let from = daysBetween(first, b.s < first ? first : b.s);
    // the last day it touches: an all-day end is exclusive; a timed end at midnight is too
    const lastDay = e.allDay ? addDays(b.e, -1) : (+b.e === +startOfDay(b.e) && b.e > b.s ? addDays(b.e, -1) : b.e);
    let to = daysBetween(first, lastDay) + 1;
    from = Math.max(0, from); to = Math.min(n, to);
    if (to <= from) continue;
    rows.push({ event: e, from, to, lane: 0 });
  }
  rows.sort((a, b) => a.from - b.from || (b.to - b.from) - (a.to - a.from) || (a.event.allDay === b.event.allDay ? 0 : a.event.allDay ? -1 : 1) || String(a.event.start).localeCompare(String(b.event.start)));
  const used = [];
  for (const r of rows) {
    let lane = 0;
    while (used[lane] && used[lane].some((x) => x.from < r.to && r.from < x.to)) lane++;
    (used[lane] = used[lane] || []).push(r);
    r.lane = lane;
  }
  const counts = Array.from({ length: n }, (_, i) => rows.filter((r) => r.from <= i && i < r.to).length);
  return { rows, counts, lanes: used.length };
}

/* ---------- text (Use in chat) ---------- */

export function timeText(e, locale) {
  const t = (d) => d.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  const day = (d) => d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
  const b = bounds(e);
  if (e.allDay) {
    const last = addDays(b.e, -1);
    return sameDay(b.s, last) ? `${day(b.s)}, all day` : `${day(b.s)} – ${day(last)}, all day`;
  }
  return sameDay(b.s, b.e) || +b.e === +b.s ? `${day(b.s)}, ${t(b.s)} – ${t(b.e)}` : `${day(b.s)} ${t(b.s)} – ${day(b.e)} ${t(b.e)}`;
}

/** One event as plain text for the chat's context. */
export function eventText(e, cal, locale) {
  const lines = [`${e.title}`, `When: ${timeText(e, locale)}${e.timeZone ? ` (${e.timeZone})` : ''}`];
  if (cal) lines.push(`Calendar: ${cal.title} (${e.source === 'google' ? 'Google' : 'Mac'})`);
  if (e.location) lines.push(`Where: ${e.location}`);
  if (e.attendees && e.attendees.length) lines.push(`With: ${e.attendees.map((a) => a.name || a.email).filter(Boolean).join(', ')}`);
  if (e.recurrence && e.recurrence.recurring) lines.push('Repeats');
  if (e.url) lines.push(`Call: ${e.url}`);
  if (e.notes) lines.push(`Notes: ${e.notes.slice(0, 1500)}`);
  return lines.join('\n');
}

/** A range of events as plain text, a heading per day. */
export function rangeText(events, range, calendarsById, locale) {
  const out = [];
  for (const d of range.days) {
    const next = addDays(d, 1);
    const todays = events.filter((e) => overlaps(e, d, next)).sort((a, b) => (a.allDay === b.allDay ? bounds(a).s - bounds(b).s : a.allDay ? -1 : 1));
    if (!todays.length) continue;
    out.push(`${d.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' })}`);
    for (const e of todays) {
      const cal = calendarsById.get(`${e.source}|${e.calendarId}`);
      const when = e.allDay ? 'all day' : `${new Date(e.start).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })}–${new Date(e.end).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })}`;
      out.push(`- ${when}: ${e.title}${e.location ? ` @ ${e.location}` : ''}${cal ? ` [${cal.title}]` : ''}`);
    }
  }
  return out.length ? out.join('\n') : 'Nothing on the calendar in this range.';
}

/* ---------- writes (built here so they're tested; sent only after the review step) ---------- */

/**
 * The editor's fields → a draft both sources understand.
 * f: { title, allDay, startDate 'YYYY-MM-DD', startTime 'HH:MM', endDate, endTime, location, notes }.
 * All-day: endDate is the last day (inclusive, as people say it). Returns { draft } or { error }.
 */
export function draftFromForm(f) {
  const title = String(f.title || '').trim();
  if (!title) return { error: 'Give the event a title.' };
  if (title.length > 200) return { error: 'That title is too long (200 characters at most).' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(f.endDate || f.startDate || '')) return { error: 'Pick the dates.' };
  const location = String(f.location || '').trim().slice(0, 300);
  const notes = String(f.notes || '').slice(0, 2000);
  if (f.allDay) {
    const s = parseYmd(f.startDate), last = parseYmd(f.endDate || f.startDate);
    if (last < s) return { error: 'The end date is before the start date.' };
    if (daysBetween(s, last) > 30) return { error: 'An all-day event can span 31 days at most here.' };
    return { draft: { title, allDay: true, start: s, end: addDays(last, 1), location, notes } };
  }
  if (!/^\d{2}:\d{2}$/.test(f.startTime || '') || !/^\d{2}:\d{2}$/.test(f.endTime || '')) return { error: 'Pick the times.' };
  const [sh, sm] = f.startTime.split(':').map(Number), [eh, em] = f.endTime.split(':').map(Number);
  const sd = parseYmd(f.startDate), ed = parseYmd(f.endDate || f.startDate);
  const s = new Date(sd.getFullYear(), sd.getMonth(), sd.getDate(), sh, sm);
  const e = new Date(ed.getFullYear(), ed.getMonth(), ed.getDate(), eh, em);
  if (e <= s) return { error: 'The end must be after the start.' };
  if (e - s > DAY_MS + 3600e3) return { error: 'A timed event can last a day at most here; make it all-day instead.' };
  return { draft: { title, allDay: false, start: s, end: e, location, notes } };
}

/** A Google event body's fields for a draft (gcal.ts EventInput). */
export function googleInput(d, zone = localZone()) {
  return d.allDay
    ? { title: d.title, allDay: true, start: ymd(d.start), end: ymd(d.end), location: d.location, notes: d.notes }
    : { title: d.title, allDay: false, start: isoWithOffset(d.start), end: isoWithOffset(d.end), ...(zone ? { timeZone: zone } : {}), location: d.location, notes: d.notes };
}

/** Only what changed, for an update (Google patches; nothing else is touched). */
export function googleChanges(original, d, zone = localZone()) {
  const next = googleInput(d, zone);
  const out = {};
  if (next.title !== original.title) out.title = next.title;
  if ((next.location || '') !== (original.location || '')) out.location = next.location;
  if ((next.notes || '') !== (original.notes || '')) out.notes = next.notes;
  const ob = bounds(original);
  if (d.allDay !== original.allDay || +d.start !== +ob.s || +d.end !== +ob.e) Object.assign(out, { allDay: next.allDay, start: next.start, end: next.end, ...(next.timeZone ? { timeZone: next.timeZone } : {}) });
  return out;
}

/** Alerts Jarvis takes: minutes before the start, up to four weeks, three at most. */
export const ALERT_MOST = 4 * 7 * 24 * 60;
/** The editor's alert choices (minutes before), as Apple Calendar offers them. */
export const ALERT_CHOICES = [0, 5, 10, 15, 30, 60, 120, 1440, 2880, 10080];
/** An alert in words: "At time of event", "10 minutes before", "1 day before". */
export function alertText(m) {
  if (m === 0) return 'At time of event';
  for (const [size, unit] of [[10080, 'week'], [1440, 'day'], [60, 'hour'], [1, 'minute']]) {
    if (m % size === 0) return `${m / size} ${unit}${m / size === 1 ? '' : 's'} before`;
  }
  return `${m} minutes before`;
}
const sameAlerts = (a, b) => JSON.stringify([...(a || [])].sort((x, y) => x - y)) === JSON.stringify([...(b || [])].sort((x, y) => x - y));

/** Jarvis's calendar_create arguments for a draft. */
export function macCreateArgs(d, calendarTitle) {
  const a = { title: d.title, confirm: true };
  if (d.allDay) Object.assign(a, { start: ymd(d.start), all_day: true, days: Math.max(1, daysBetween(d.start, d.end)) });
  else Object.assign(a, { start: isoWithOffset(d.start), end: isoWithOffset(d.end) });
  if (d.location) a.location = d.location;
  if (d.notes) a.notes = d.notes;
  if (d.url) a.url = d.url;
  if (Array.isArray(d.alerts) && d.alerts.length) a.alerts = d.alerts.slice(0, 3);
  if (calendarTitle) a.calendar = calendarTitle;
  return a;
}

/**
 * How Jarvis finds an event again: its title, its start (the date when all-day; else the
 * instant with its offset, as Jarvis wrote it, so a page in another zone still names the
 * right minute) and its calendar's name.
 */
export function macIdentity(e) {
  const b = bounds(e);
  const written = e.mac && /(Z|[+-]\d{2}:\d{2})$/.test(e.mac.start) ? e.mac.start : '';
  return { title: (e.mac && e.mac.title) || e.title, start: e.allDay ? ymd(b.s) : written || isoWithOffset(b.s), ...(e.mac && e.mac.calendar ? { calendar: e.mac.calendar } : {}) };
}

/**
 * Jarvis's calendar_update arguments: only what it can change (title, time, length, place,
 * notes, link, alerts) and only what changed; a draft without `url` or `alerts` leaves those
 * alone (a drag). null when nothing changed.
 */
export function macUpdateArgs(original, d, future = false) {
  const a = { ...macIdentity(original), confirm: true };
  const b = bounds(original);
  if (d.title !== original.title) a.new_title = d.title;
  if ((d.location || '') !== (original.location || '')) a.new_location = d.location || '';
  if (+d.start !== +b.s) a.new_start = original.allDay ? ymd(d.start) : isoWithOffset(d.start);
  if (!original.allDay && +d.end - +d.start !== +b.e - +b.s) a.new_duration_minutes = Math.round((d.end - d.start) / 60000);
  if ('notes' in d && (d.notes || '') !== (original.notes || '')) a.new_notes = d.notes || '';
  if ('url' in d && (d.url || '') !== (original.eventUrl || '')) a.new_url = d.url || '';
  if (Array.isArray(d.alerts) && !(Array.isArray(original.alerts) && sameAlerts(d.alerts, original.alerts))) a.new_alerts = d.alerts.slice(0, 3);
  if (future) a.future = true;
  return ['new_title', 'new_location', 'new_start', 'new_duration_minutes', 'new_notes', 'new_url', 'new_alerts'].some((k) => k in a) ? a : null;
}

export function macDeleteArgs(original, future = false) {
  return { ...macIdentity(original), ...(future ? { future: true } : {}), confirm: true };
}

/* ----- moving and resizing in the time grid ----- */

/** Drags and keyboard nudges land on quarter hours. */
export const SNAP_MIN = 15;
export const snap = (min, step = SNAP_MIN) => Math.round(min / step) * step;
/** The next quarter hour above (dir -1) or below (dir 1) a wall-clock minute, as a change in minutes. */
export function nudgeMinutes(min, dir) {
  const to = dir > 0 ? Math.floor(min / SNAP_MIN) * SNAP_MIN + SNAP_MIN : Math.ceil(min / SNAP_MIN) * SNAP_MIN - SNAP_MIN;
  return to - min;
}

/**
 * Where a timed event lands after a drag (or a keyboard nudge), by the wall clock, so 10:00
 * stays 10:00 across a DST change. 'move': `days` later and `minutes` later, its start snapped
 * to a quarter hour and kept inside its day, its length kept. 'resize': the end `minutes`
 * later, snapped, at least SNAP_MIN after the start and no later than that day's midnight.
 * Returns { start, end } (Dates).
 */
export function dragTimes(e, mode, minutes, days = 0) {
  const b = bounds(e);
  const d0 = startOfDay(b.s);
  const at = (day, min) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, min);
  const startMin = minutesIntoDay(b.s);
  if (mode === 'resize') {
    const endMin = daysBetween(d0, startOfDay(b.e)) * 1440 + minutesIntoDay(b.e);
    const want = Math.max(startMin + SNAP_MIN, Math.min(1440, snap(endMin + minutes)));
    return { start: b.s, end: at(d0, want) };
  }
  const want = Math.max(0, Math.min(1440 - SNAP_MIN, snap(startMin + minutes)));
  const start = at(addDays(d0, days), want);
  return { start, end: new Date(start.getTime() + (b.e - b.s)) };
}

/** A drag's edit as an editor draft: only the time changes (it goes through the same review). */
export function dragDraft(e, start, end) {
  return { title: e.title, allDay: !!e.allDay, start, end, location: e.location || '', notes: e.notes || '' };
}

/**
 * An event in the all-day rows (all-day, or a day or longer) moved by whole days, as month and
 * week drags and ⌥←/⌥→ move it: same times of day, same number of days. Returns { start, end }.
 */
export function shiftDays(e, days) {
  const b = bounds(e);
  return { start: addDays(b.s, days), end: addDays(b.e, days) };
}
