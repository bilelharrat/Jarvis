// The calendar's rules, pure (no DOM, no imports, so src/__tests__/calendar-rules.test.ts loads
// it directly): repeats as RFC 5545 RRULE lines (the editor's choices → a rule, a rule → the
// editor's choices and words), which occurrences an edit of a repeating event touches, wall
// times in any IANA zone, invitations (.ics: text/calendar parts and attachments), and dates
// and times in a plain email (no AI) for "Add to calendar". Everything parsed here is data from
// an email or a calendar: it is shown and put in the editor, never acted on by itself.

export const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const FREQS = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];
const pad = (n) => String(n).padStart(2, '0');
const ymdOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysIn = (y, m) => new Date(y, m + 1, 0).getDate();

/* ---------- repeats ---------- */

/**
 * The editor's repeat: { freq: 'none'|'DAILY'|'WEEKLY'|'MONTHLY'|'YEARLY', interval, byDay: ['MO',…]
 * (weekly), monthMode: 'date'|'weekday' (monthly), end: 'never'|'until'|'count', until:
 * 'YYYY-MM-DD', count }. A rule this editor can't show keeps `raw` (and `unsupported: true`).
 */
export function noRepeat() { return { freq: 'none', interval: 1, byDay: [], monthMode: 'date', end: 'never', until: '', count: 10 }; }

/** Which week of its month a date is in: { n: 1–5, last: it's the month's last such weekday, day: 'TU' }. */
export function nthWeekday(d) {
  const n = Math.ceil(d.getDate() / 7);
  return { n, last: d.getDate() + 7 > daysIn(d.getFullYear(), d.getMonth()), day: WEEKDAYS[d.getDay()] };
}

/** UNTIL for a rule: all-day → the date (YYYYMMDD); timed → the end of that local day as UTC (…T235959Z wall time, converted). */
export function untilValue(until, allDay, zone) {
  const [y, m, d] = String(until).split('-').map(Number);
  if (allDay) return `${y}${pad(m)}${pad(d)}`;
  const t = zone ? wallToInstant(y, m, d, 23, 59, zone, 59) : new Date(y, m - 1, d, 23, 59, 59);
  return basicUtc(t);
}
/** 2026-10-07T08:59:59Z → 20261007T085959Z. */
export function basicUtc(t) { return new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }

/** The editor's repeat → 'RRULE:…', or null for "does not repeat" (start: the event's local start). */
export function buildRRule(spec, start, allDay = false, zone = null) {
  if (!spec || spec.freq === 'none') return null;
  if (spec.unsupported && spec.raw) return spec.raw;
  if (!FREQS.includes(spec.freq)) return null;
  const p = [`FREQ=${spec.freq}`];
  const interval = Math.max(1, Math.min(999, Math.floor(Number(spec.interval) || 1)));
  if (interval > 1) p.push(`INTERVAL=${interval}`);
  if (spec.freq === 'WEEKLY') {
    const days = WEEKDAYS.filter((w) => (spec.byDay || []).includes(w));
    p.push(`BYDAY=${(days.length ? days : [WEEKDAYS[start.getDay()]]).join(',')}`);
  }
  if (spec.freq === 'MONTHLY') {
    if (spec.monthMode === 'weekday') { const w = nthWeekday(start); p.push(`BYDAY=${spec.nth || `${w.n >= 5 ? -1 : w.n}${w.day}`}`); }
    else p.push(`BYMONTHDAY=${spec.monthDay || start.getDate()}`);
  }
  if (spec.end === 'until' && /^\d{4}-\d{2}-\d{2}$/.test(spec.until || '')) p.push(`UNTIL=${untilValue(spec.until, allDay, zone)}`);
  else if (spec.end === 'count') p.push(`COUNT=${Math.max(1, Math.min(730, Math.floor(Number(spec.count) || 1)))}`);
  return `RRULE:${p.join(';')}`;
}

/** UNTIL (20261231, 20261231T235959Z or local 20261231T235959) → the local date YYYY-MM-DD it ends on. */
function untilDate(v) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
  if (!m) return '';
  if (!m[4]) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = m[7] ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return ymdOf(d);
}

/** 'RRULE:FREQ=…' (or without the prefix) → the editor's repeat; parts it can't show → { unsupported, raw }. */
export function parseRRule(line) {
  const raw = String(line || '').trim();
  const body = raw.replace(/^RRULE:/i, '');
  if (!body || /^(EXDATE|RDATE|EXRULE)/i.test(raw)) return null;
  const kv = {};
  for (const part of body.split(';')) { const [k, v] = part.split('='); if (k && v !== undefined) kv[k.toUpperCase()] = v.toUpperCase(); }
  const out = { ...noRepeat(), freq: kv.FREQ, raw: raw.startsWith('RRULE:') ? raw : `RRULE:${body}` };
  if (!FREQS.includes(kv.FREQ)) return { ...out, freq: kv.FREQ || 'none', unsupported: true };
  const known = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'UNTIL', 'COUNT', 'WKST', 'BYMONTH']);
  let unsupported = Object.keys(kv).some((k) => !known.has(k));
  out.interval = Math.max(1, Number(kv.INTERVAL) || 1);
  if (kv.UNTIL) { out.end = 'until'; out.until = untilDate(kv.UNTIL); if (!out.until) unsupported = true; }
  else if (kv.COUNT) { out.end = 'count'; out.count = Number(kv.COUNT) || 1; }
  const byDay = kv.BYDAY ? kv.BYDAY.split(',') : [];
  if (kv.FREQ === 'WEEKLY') {
    if (byDay.some((d) => !WEEKDAYS.includes(d))) unsupported = true;
    out.byDay = byDay.filter((d) => WEEKDAYS.includes(d));
  } else if (kv.FREQ === 'MONTHLY') {
    if (byDay.length === 1 && /^(-1|[1-5])(SU|MO|TU|WE|TH|FR|SA)$/.test(byDay[0]) && !kv.BYMONTHDAY) { out.monthMode = 'weekday'; out.nth = byDay[0]; }
    else if (!byDay.length && (!kv.BYMONTHDAY || /^\d{1,2}$/.test(kv.BYMONTHDAY))) { out.monthMode = 'date'; out.monthDay = kv.BYMONTHDAY ? Number(kv.BYMONTHDAY) : null; }
    else unsupported = true;
  } else if (kv.FREQ === 'DAILY') {
    if (byDay.length) unsupported = true;
  } else if (kv.FREQ === 'YEARLY') {
    if (byDay.length || (kv.BYMONTHDAY && kv.BYMONTHDAY.includes(',')) || (kv.BYMONTH && kv.BYMONTH.includes(','))) unsupported = true;
  }
  if (kv.BYMONTH && kv.FREQ !== 'YEARLY') unsupported = true;
  if (kv.BYMONTHDAY && kv.FREQ !== 'MONTHLY' && kv.FREQ !== 'YEARLY') unsupported = true;
  if (unsupported) out.unsupported = true;
  return out;
}

/** The repeat line among an event's recurrence lines (RRULE), and the others (EXDATE, RDATE) kept as they are. */
export function splitRecurrence(rules) {
  const list = Array.isArray(rules) ? rules.map(String) : [];
  const rrule = list.find((r) => /^RRULE:/i.test(r)) || null;
  return { rrule, others: list.filter((r) => r !== rrule) };
}

const WEEKDAY_SET = ['MO', 'TU', 'WE', 'TH', 'FR'];
/** The editor's preset menu key for a repeat (as Google Calendar's menu has them). */
export function presetOf(spec, start) {
  if (!spec || spec.freq === 'none') return 'none';
  if (spec.unsupported) return 'custom';
  const plain = (spec.interval || 1) === 1 && spec.end === 'never';
  if (!plain) return 'custom';
  if (spec.freq === 'DAILY') return 'daily';
  if (spec.freq === 'WEEKLY') {
    const days = [...(spec.byDay || [])].sort().join(',');
    if (days === [...WEEKDAY_SET].sort().join(',')) return 'weekdays';
    if (!spec.byDay.length || (spec.byDay.length === 1 && spec.byDay[0] === WEEKDAYS[start.getDay()])) return 'weekly';
    return 'custom';
  }
  if (spec.freq === 'MONTHLY') {
    if (spec.monthMode === 'weekday') return spec.nth && spec.nth !== nthCode(start) ? 'custom' : 'monthly-weekday';
    return spec.monthDay && spec.monthDay !== start.getDate() ? 'custom' : 'monthly-date';
  }
  if (spec.freq === 'YEARLY') return 'yearly';
  return 'custom';
}
const nthCode = (start) => { const w = nthWeekday(start); return `${w.n >= 5 ? -1 : w.n}${w.day}`; };

/** A preset's repeat for an event starting on `start`. */
export function presetSpec(key, start) {
  const s = { ...noRepeat() };
  switch (key) {
    case 'daily': return { ...s, freq: 'DAILY' };
    case 'weekly': return { ...s, freq: 'WEEKLY', byDay: [WEEKDAYS[start.getDay()]] };
    case 'weekdays': return { ...s, freq: 'WEEKLY', byDay: [...WEEKDAY_SET] };
    case 'monthly-date': return { ...s, freq: 'MONTHLY', monthMode: 'date' };
    case 'monthly-weekday': return { ...s, freq: 'MONTHLY', monthMode: 'weekday' };
    case 'yearly': return { ...s, freq: 'YEARLY' };
    default: return s;
  }
}

const ORD = ['', 'first', 'second', 'third', 'fourth', 'fifth'];
const dayName = (code, locale) => { const i = WEEKDAYS.indexOf(code); return new Date(2026, 0, 4 + i).toLocaleDateString(locale, { weekday: 'long' }); };
const listWords = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** A repeat in words: "Weekly on Tuesday and Thursday, until 31 Dec 2026" (English; in French for a French locale). */
export function repeatText(spec, start, locale = 'en-US') {
  if (/^fr\b/i.test(String(locale))) return repeatTextFr(spec, start, locale);
  if (!spec || spec.freq === 'none') return 'Does not repeat';
  if (spec.unsupported) return 'Custom repeat (kept as it is)';
  const n = spec.interval || 1;
  const every = (one, many) => (n === 1 ? one : `Every ${n} ${many}`);
  let t;
  if (spec.freq === 'DAILY') t = every('Daily', 'days');
  else if (spec.freq === 'WEEKLY') {
    const days = WEEKDAYS.filter((w) => (spec.byDay || []).includes(w));
    if (n === 1 && days.join() === WEEKDAY_SET.join()) t = 'Every weekday (Monday to Friday)';
    else t = `${every('Weekly', 'weeks')} on ${listWords((days.length ? days : [WEEKDAYS[start.getDay()]]).map((d) => dayName(d, locale)))}`;
  } else if (spec.freq === 'MONTHLY') {
    if (spec.monthMode === 'weekday') {
      const code = spec.nth || nthCode(start);
      const m = /^(-1|\d)(\w\w)$/.exec(code);
      t = `${every('Monthly', 'months')} on the ${m[1] === '-1' ? 'last' : ORD[Number(m[1])]} ${dayName(m[2], locale)}`;
    } else t = `${every('Monthly', 'months')} on day ${spec.monthDay || start.getDate()}`;
  } else t = `${every('Annually', 'years')} on ${start.toLocaleDateString(locale, { month: 'long', day: 'numeric' })}`;
  if (spec.end === 'until' && spec.until) { const [y, m, d] = spec.until.split('-').map(Number); t += `, until ${new Date(y, m - 1, d).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })}`; }
  else if (spec.end === 'count') t += `, ${spec.count} time${spec.count === 1 ? '' : 's'}`;
  return t;
}

const ORD_FR = ['', 'premier', 'deuxième', 'troisième', 'quatrième', 'cinquième'];
const listWordsFr = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} et ${xs.at(-1)}`);
/** repeatText in French: "Toutes les semaines le mardi et le jeudi, jusqu’au 31 déc. 2026". */
function repeatTextFr(spec, start, locale) {
  if (!spec || spec.freq === 'none') return 'Ne se répète pas';
  if (spec.unsupported) return 'Répétition personnalisée (conservée telle quelle)';
  const n = spec.interval || 1;
  const every = (one, unit) => (n === 1 ? one : `Tous les ${n} ${unit}`);
  let t;
  if (spec.freq === 'DAILY') t = every('Tous les jours', 'jours');
  else if (spec.freq === 'WEEKLY') {
    const days = WEEKDAYS.filter((w) => (spec.byDay || []).includes(w));
    if (n === 1 && days.join() === WEEKDAY_SET.join()) t = 'Tous les jours de la semaine (du lundi au vendredi)';
    else t = `${n === 1 ? 'Toutes les semaines' : `Toutes les ${n} semaines`} ${listWordsFr((days.length ? days : [WEEKDAYS[start.getDay()]]).map((d) => `le ${dayName(d, locale)}`))}`;
  } else if (spec.freq === 'MONTHLY') {
    if (spec.monthMode === 'weekday') {
      const code = spec.nth || nthCode(start);
      const m = /^(-1|\d)(\w\w)$/.exec(code);
      t = `${every('Tous les mois', 'mois')} le ${m[1] === '-1' ? 'dernier' : ORD_FR[Number(m[1])]} ${dayName(m[2], locale)}`;
    } else { const day = spec.monthDay || start.getDate(); t = `${every('Tous les mois', 'mois')} le ${day === 1 ? '1er' : day}`; }
  } else t = `${every('Tous les ans', 'ans')} le ${start.toLocaleDateString(locale, { month: 'long', day: 'numeric' })}`;
  if (spec.end === 'until' && spec.until) { const [y, m, d] = spec.until.split('-').map(Number); t += `, jusqu’au ${new Date(y, m - 1, d).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })}`; }
  else if (spec.end === 'count') t += `, ${spec.count} fois`;
  return t;
}

/* ---------- which occurrences an edit touches ---------- */

/** The scopes offered for changing a repeating event: Google: this / following / all; the Mac (Jarvis): this / following. */
export function scopeChoices(e, kind = 'edit') {
  const rec = e && e.recurrence && e.recurrence.recurring;
  if (!rec) return [];
  if (e.source === 'mac') return kind === 'rsvp' ? [] : ['this', 'following'];
  if (kind === 'rsvp') return e.recurrence.seriesId ? ['this', 'all'] : [];
  if (!e.recurrence.seriesId) return ['all']; // the series itself
  if (kind === 'repeat') return ['following', 'all']; // a single occurrence can't take a new repeat
  return ['this', 'following', 'all'];
}
export const SCOPE_LABEL = { this: 'This event', following: 'This and following events', all: 'All events' };

/** What a write sends for a scope: Google { id, scope }; the Mac's `future` flag. */
export function scopeArgs(e, scope) {
  if (e.source === 'mac') return { future: scope === 'following' || scope === 'all' };
  return { id: e.id, scope: scope === 'following' || scope === 'all' ? scope : 'this' };
}

/* ---------- wall time in an IANA zone ---------- */

/** The zone's offset from UTC in minutes at an instant (Europe/London in summer → 60). */
export function zoneOffset(zone, ms) {
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
  } catch { return null; }
}
/** A wall time in `zone` → the instant (a Date). Unknown zone → local time. */
export function wallToInstant(y, m, d, h, mi, zone, s = 0) {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  const o1 = zone ? zoneOffset(zone, guess) : null;
  if (o1 === null) return new Date(y, m - 1, d, h, mi, s);
  let t = guess - o1 * 60000;
  const o2 = zoneOffset(zone, t);
  if (o2 !== null && o2 !== o1) t = guess - o2 * 60000;
  return new Date(t);
}
/** An instant's wall time in `zone`: { y, m, d, h, mi }. */
export function instantToWall(t, zone) {
  const o = zone ? zoneOffset(zone, +t) : null;
  if (o === null) { const x = new Date(t); return { y: x.getFullYear(), m: x.getMonth() + 1, d: x.getDate(), h: x.getHours(), mi: x.getMinutes() }; }
  const x = new Date(+t + o * 60000);
  return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate(), h: x.getUTCHours(), mi: x.getUTCMinutes() };
}
/** An instant as ISO 8601 with the zone's offset at it: 2026-10-07T10:00:00-04:00 (what Google takes, with timeZone). */
export function isoInZone(t, zone) {
  const w = instantToWall(t, zone);
  const o = (zone ? zoneOffset(zone, +t) : null) ?? -new Date(t).getTimezoneOffset();
  const a = Math.abs(o);
  return `${w.y}-${pad(w.m)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}:00${o >= 0 ? '+' : '-'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/* ---------- invitations (.ics) ---------- */

// Outlook writes Windows zone names; the common ones as IANA (others fall back to the local zone).
const WINDOWS_ZONES = {
  'Pacific Standard Time': 'America/Los_Angeles', 'Mountain Standard Time': 'America/Denver', 'Central Standard Time': 'America/Chicago',
  'Eastern Standard Time': 'America/New_York', 'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris', 'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw', 'E. Europe Standard Time': 'Europe/Chisinau', 'GTB Standard Time': 'Europe/Bucharest',
  'India Standard Time': 'Asia/Kolkata', 'China Standard Time': 'Asia/Shanghai', 'Tokyo Standard Time': 'Asia/Tokyo',
  'AUS Eastern Standard Time': 'Australia/Sydney', 'Singapore Standard Time': 'Asia/Singapore', 'Arabian Standard Time': 'Asia/Dubai', UTC: 'UTC',
};
const validZone = (z) => { try { new Intl.DateTimeFormat('en-US', { timeZone: z }); return true; } catch { return false; } };
function ianaOf(tzid) {
  const t = String(tzid || '').replace(/^"|"$/g, '').replace(/^\/[^/]*\/[^/]*\//, '').trim(); // /mozilla.org/20050126_1/Europe/London
  if (!t) return null;
  if (WINDOWS_ZONES[t]) return WINDOWS_ZONES[t];
  return validZone(t) ? t : null;
}

/** Folded lines joined (RFC 5545 §3.1). */
export function unfoldIcs(text) { return String(text || '').replace(/\r\n/g, '\n').replace(/\n[ \t]/g, ''); }
const unescapeText = (v) => v.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));

/** One content line → { name, params, value } (a quoted parameter may hold ':' and ';'). */
export function icsLine(line) {
  let i = 0, q = false;
  for (; i < line.length; i++) { const c = line[i]; if (c === '"') q = !q; else if (c === ':' && !q) break; }
  if (i >= line.length) return null;
  const head = line.slice(0, i), value = line.slice(i + 1);
  const parts = [];
  let cur = '';
  q = false;
  for (const c of head) { if (c === '"') q = !q; if (c === ';' && !q) { parts.push(cur); cur = ''; } else cur += c; }
  parts.push(cur);
  const params = {};
  for (const p of parts.slice(1)) { const at = p.indexOf('='); if (at > 0) params[p.slice(0, at).toUpperCase()] = p.slice(at + 1).replace(/^"|"$/g, ''); }
  return { name: parts[0].toUpperCase(), params, value };
}

/** An ICS date or date-time → { allDay, date: 'YYYY-MM-DD' } or { allDay: false, at: Date, zone }. */
export function icsTime(value, params = {}) {
  const v = String(value || '').trim();
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v);
  if (!m) return null;
  if (!m[4] || params.VALUE === 'DATE') return { allDay: true, date: `${m[1]}-${m[2]}-${m[3]}` };
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] || '0'].map(Number);
  if (m[7]) return { allDay: false, at: new Date(Date.UTC(y, mo - 1, d, h, mi, s)), zone: 'UTC' };
  const zone = ianaOf(params.TZID);
  return { allDay: false, at: zone ? wallToInstant(y, mo, d, h, mi, zone, s) : new Date(y, mo - 1, d, h, mi, s), zone };
}
const PARTSTAT = { ACCEPTED: 'accepted', DECLINED: 'declined', TENTATIVE: 'tentative', 'NEEDS-ACTION': 'needsAction', DELEGATED: 'delegated' };
const mailto = (v) => String(v || '').replace(/^mailto:/i, '').trim().toLowerCase();

/** An invitation's text → { method, events: [{ uid, summary, description, location, start, end, allDay, organizer, attendees, status, sequence, rrule, url }] }. */
export function parseIcs(text) {
  const lines = unfoldIcs(text).split('\n');
  const out = { method: null, events: [] };
  let ev = null, depth = 0;
  for (const raw of lines) {
    const l = icsLine(raw.trimEnd());
    if (!l) continue;
    if (l.name === 'BEGIN') { if (l.value.toUpperCase() === 'VEVENT' && !ev) { ev = { uid: '', summary: '', description: '', location: '', start: null, end: null, duration: '', organizer: null, attendees: [], status: '', sequence: 0, rrule: null, url: '', recurrenceId: null }; depth = 0; } else if (ev) depth++; continue; }
    if (l.name === 'END') { if (ev && depth > 0) { depth--; continue; } if (ev && l.value.toUpperCase() === 'VEVENT') { out.events.push(finishIcsEvent(ev)); ev = null; } continue; }
    if (!ev) { if (l.name === 'METHOD') out.method = l.value.trim().toUpperCase(); continue; }
    if (depth > 0) continue; // VALARM and the like
    switch (l.name) {
      case 'UID': ev.uid = l.value.trim(); break;
      case 'SUMMARY': ev.summary = unescapeText(l.value).trim(); break;
      case 'DESCRIPTION': ev.description = unescapeText(l.value); break;
      case 'LOCATION': ev.location = unescapeText(l.value).trim(); break;
      case 'DTSTART': ev.start = icsTime(l.value, l.params); break;
      case 'DTEND': ev.end = icsTime(l.value, l.params); break;
      case 'DURATION': ev.duration = l.value.trim(); break;
      case 'STATUS': ev.status = l.value.trim().toUpperCase(); break;
      case 'SEQUENCE': ev.sequence = Number(l.value) || 0; break;
      case 'RRULE': ev.rrule = `RRULE:${l.value.trim()}`; break;
      case 'URL': ev.url = /^https:\/\//i.test(l.value.trim()) ? l.value.trim() : ''; break;
      case 'RECURRENCE-ID': ev.recurrenceId = icsTime(l.value, l.params); break;
      case 'ORGANIZER': ev.organizer = { email: mailto(l.value), name: l.params.CN || '' }; break;
      case 'ATTENDEE': ev.attendees.push({ email: mailto(l.value), name: l.params.CN || '', status: PARTSTAT[(l.params.PARTSTAT || 'NEEDS-ACTION').toUpperCase()] || 'needsAction', optional: (l.params.ROLE || '').toUpperCase() === 'OPT-PARTICIPANT' }); break;
      default: break;
    }
  }
  return out;
}

/** ISO 8601 durations as ICS writes them (PT1H30M, P1D, P1W) → ms. */
export function durationMs(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v || ''));
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * ((+m[2] || 0) * 6048e5 + (+m[3] || 0) * 864e5 + (+m[4] || 0) * 36e5 + (+m[5] || 0) * 6e4 + (+m[6] || 0) * 1e3);
}

function finishIcsEvent(ev) {
  const s = ev.start;
  let e = ev.end;
  if (s && !e) {
    const ms = durationMs(ev.duration);
    if (s.allDay) { const [y, m, d] = s.date.split('-').map(Number); e = { allDay: true, date: ymdOf(new Date(y, m - 1, d + Math.max(1, Math.round(ms / 864e5) || 1))) }; }
    else e = { allDay: false, at: new Date(+s.at + (ms || 3600e3)), zone: s.zone };
  }
  return { ...ev, end: e, allDay: !!(s && s.allDay) };
}

/** The invitation as an editor draft (title, local Dates, place, notes, repeat), or null without a start. */
export function icsToDraft(ev) {
  if (!ev || !ev.start) return null;
  let start, end;
  if (ev.allDay) {
    const [y, m, d] = ev.start.date.split('-').map(Number);
    start = new Date(y, m - 1, d);
    const [y2, m2, d2] = (ev.end && ev.end.date ? ev.end.date : ymdOf(new Date(y, m - 1, d + 1))).split('-').map(Number);
    end = new Date(y2, m2 - 1, d2);
    if (end <= start) end = new Date(y, m - 1, d + 1);
  } else {
    start = new Date(ev.start.at);
    end = ev.end && ev.end.at ? new Date(ev.end.at) : new Date(+start + 3600e3);
    if (end <= start) end = new Date(+start + 3600e3);
  }
  return {
    title: (ev.summary || 'Invitation').slice(0, 200), allDay: ev.allDay, start, end,
    location: (ev.location || '').slice(0, 300), notes: (ev.description || '').slice(0, 2000),
    recurrence: ev.rrule ? [ev.rrule] : [], timeZone: !ev.allDay && ev.start.zone && ev.start.zone !== 'UTC' ? ev.start.zone : null,
  };
}

/** The owner's answer recorded in an invitation, by their addresses: accepted | declined | tentative | needsAction | null (not a guest). */
export function icsStatusFor(ev, emails) {
  const mine = new Set((emails || []).map((x) => String(x).toLowerCase()));
  const a = (ev && ev.attendees || []).find((x) => mine.has(x.email));
  return a ? a.status : null;
}

/* ---------- dates and times in a plain email (no AI) ---------- */

const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_RE = '(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)';
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const monthIndex = (w) => MONTHS.indexOf(w.slice(0, 3).toLowerCase());
// French, alongside the English: "le 12 mars", "du 12 au 14 nov.", "demain", "lundi prochain", "à 15 h 30".
const FR_MONTH_RE = '(janv(?:ier)?|f[ée]vr(?:ier)?|mars|avr(?:il)?|mai|juin|juil(?:let)?|ao[uû]t|sept(?:embre)?|oct(?:obre)?|nov(?:embre)?|d[ée]c(?:embre)?)';
const FR_MONTHS = ['jan', 'fév', 'mar', 'avr', 'mai', 'juin', 'juil', 'aoû', 'sep', 'oct', 'nov', 'déc'];
const frMonthIndex = (w) => {
  const x = w.toLowerCase().replace(/^fe/, 'fé').replace(/^de/, 'dé').replace(/^aou/, 'aoû');
  return FR_MONTHS.findIndex((p) => x.startsWith(p));
};
const FR_DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
// 15h, 15 h 30, 15h30, de 14h à 16h, 14h-16h (24-hour clock: no afternoon guess)
const FR_TIME_RE = /\b(\d{1,2})\s?h(?:\s?(\d{2}))?(?![\dA-Za-zÀ-ÿ])(?:\s*(?:[-–—]|à|a|jusqu[’']à)\s*(\d{1,2})\s?h(?:\s?(\d{2}))?(?![\dA-Za-zÀ-ÿ]))?/gi;
const ORDINAL = '(?:st|nd|rd|th)?';
const TIME_RE = /\b(?:at\s+|@\s*|from\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?:\s*(?:[-–—]|to|until|till)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?)?(?![\d/])/gi;

function nextOnOrAfter(now, month, day) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let d = new Date(now.getFullYear(), month, day);
  if (d.getMonth() !== month) return null;
  if (d < new Date(+today - 7 * 864e5)) d = new Date(now.getFullYear() + 1, month, day);
  return d;
}

/** Date mentions: [{ index, length, date (local midnight), endDate? (last day, inclusive), text }]. */
function findDates(text, now) {
  const found = [];
  const add = (m, date, endDate = null) => { if (date && !Number.isNaN(+date)) found.push({ index: m.index, length: m[0].length, date, endDate, text: m[0] }); };
  let m;
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while ((m = iso.exec(text))) { const d = new Date(+m[1], +m[2] - 1, +m[3]); if (d.getMonth() === +m[2] - 1) add(m, d); }
  const md = new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})${ORDINAL}(?:\\s*[-–—]\\s*(\\d{1,2})${ORDINAL})?(?:,?\\s+(\\d{4}))?\\b`, 'gi');
  while ((m = md.exec(text))) {
    const mo = monthIndex(m[1]); const day = +m[2];
    const d = m[4] ? new Date(+m[4], mo, day) : nextOnOrAfter(now, mo, day);
    if (!d || d.getDate() !== day) continue;
    add(m, d, m[3] && +m[3] > day ? new Date(d.getFullYear(), mo, +m[3]) : null);
  }
  const dm = new RegExp(`\\b(\\d{1,2})${ORDINAL}(?:\\s*[-–—]\\s*(\\d{1,2})${ORDINAL})?\\s+(?:of\\s+)?${MONTH_RE}\\.?(?:,?\\s+(\\d{4}))?\\b`, 'gi');
  while ((m = dm.exec(text))) {
    const mo = monthIndex(m[3]); const day = +m[1];
    const d = m[4] ? new Date(+m[4], mo, day) : nextOnOrAfter(now, mo, day);
    if (!d || d.getDate() !== day) continue;
    add(m, d, m[2] && +m[2] > day ? new Date(d.getFullYear(), mo, +m[2]) : null);
  }
  const rel = /\b(today|tonight|tomorrow)\b/gi;
  while ((m = rel.exec(text))) add(m, new Date(now.getFullYear(), now.getMonth(), now.getDate() + (m[1].toLowerCase() === 'tomorrow' ? 1 : 0)));
  // French: "12 mars", "le 1er avril 2027", "du 12 au 14 nov."
  const fdm = new RegExp(`\\b(\\d{1,2})(?:er)?(?:\\s*(?:[-–—]|au)\\s*(\\d{1,2})(?:er)?)?\\s+${FR_MONTH_RE}\\.?(?:\\s+(\\d{4}))?(?![A-Za-zÀ-ÿ])`, 'gi');
  while ((m = fdm.exec(text))) {
    const mo = frMonthIndex(m[3]); const day = +m[1];
    if (mo < 0) continue;
    const d = m[4] ? new Date(+m[4], mo, day) : nextOnOrAfter(now, mo, day);
    if (!d || d.getDate() !== day) continue;
    add(m, d, m[2] && +m[2] > day ? new Date(d.getFullYear(), mo, +m[2]) : null);
  }
  const frel = /(?<![A-Za-zÀ-ÿ-])(après-demain|demain|aujourd[’']hui|ce soir)(?![A-Za-zÀ-ÿ])/gi;
  while ((m = frel.exec(text))) { const w = m[1].toLowerCase(); add(m, new Date(now.getFullYear(), now.getMonth(), now.getDate() + (w === 'demain' ? 1 : w === 'après-demain' ? 2 : 0))); }
  const fwd = /(?<![A-Za-zÀ-ÿ])(ce\s+|le\s+)?(dimanche|lundi|mardi|mercredi|jeudi|vendredi|samedi)(\s+prochain)?(?![A-Za-zÀ-ÿ])/gi;
  while ((m = fwd.exec(text))) {
    const want = FR_DAYS.indexOf(m[2].toLowerCase());
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let n = (want - today.getDay() + 7) % 7;
    if (n === 0) n = 7;
    add(m, new Date(today.getFullYear(), today.getMonth(), today.getDate() + n));
  }
  const wd = new RegExp(`\\b(next\\s+|this\\s+|on\\s+)?${DAY_RE}\\b`, 'gi');
  while ((m = wd.exec(text))) {
    const want = DAYS.indexOf(m[2].slice(0, 3).toLowerCase());
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let n = (want - today.getDay() + 7) % 7;
    if (n === 0) n = 7; // "Friday" said on a Friday: next week's
    // skip a weekday that is part of a full date ("Tuesday, Nov 12"): the date wins
    add(m, new Date(today.getFullYear(), today.getMonth(), today.getDate() + n));
  }
  // dates first by position; a weekday right before a full date is dropped
  found.sort((a, b) => a.index - b.index);
  return found.filter((x, i) => !(i + 1 < found.length && /^(?:next\s+|this\s+|on\s+|ce\s+|le\s+)?[a-z]+(?:\s+prochain)?$/i.test(x.text) && found[i + 1].index - (x.index + x.length) <= 3));
}

/** Time mentions: [{ index, length, h, mi, endH?, endMi? }] (bare numbers count only after "at"/"@"/"from" or with am/pm or h:mm). */
function findTimes(text) {
  const out = [];
  let m;
  TIME_RE.lastIndex = 0;
  while ((m = TIME_RE.exec(text))) {
    const lead = /^(at|@|from)/i.test(m[0].trim());
    const hasMin = m[2] !== undefined, mer = m[3] || m[6];
    if (!lead && !hasMin && !mer) continue;
    let h = +m[1]; const mi = +(m[2] || 0);
    if (h > 23 || mi > 59) continue;
    if (!hasMin && !mer && (h === 0 || h > 12)) continue;
    const pm = (x) => x && /^p/i.test(x), am = (x) => x && /^a/i.test(x);
    const m1 = m[3] || (m[4] !== undefined ? m[6] : undefined);
    if (pm(m1) && h < 12) h += 12; else if (am(m1) && h === 12) h = 0;
    else if (!m1 && !hasMin && h >= 1 && h <= 7) h += 12; // "at 3" means the afternoon
    let endH = null, endMi = null;
    if (m[4] !== undefined) {
      endH = +m[4]; endMi = +(m[5] || 0);
      if (pm(m[6]) && endH < 12) endH += 12; else if (am(m[6]) && endH === 12) endH = 0;
      else if (!m[6] && endH < h) endH += 12;
      if (endH > 23 || endMi > 59) { endH = null; endMi = null; }
    }
    out.push({ index: m.index, length: m[0].length, h, mi, endH, endMi });
  }
  // French times ("15 h 30", "de 14h à 16h"); an English match over the same words gives way
  const fr = [];
  FR_TIME_RE.lastIndex = 0;
  while ((m = FR_TIME_RE.exec(text))) {
    const h = +m[1], mi = +(m[2] || 0);
    if (h > 23 || mi > 59) continue;
    let endH = m[3] !== undefined ? +m[3] : null, endMi = m[3] !== undefined ? +(m[4] || 0) : null;
    if (endH !== null && (endH > 23 || endMi > 59)) { endH = null; endMi = null; }
    fr.push({ index: m.index, length: m[0].length, h, mi, endH, endMi });
  }
  if (!fr.length) return out;
  const over = (a, b) => a.index < b.index + b.length && b.index < a.index + a.length;
  return [...out.filter((x) => !fr.some((y) => over(x, y))), ...fr].sort((a, b) => a.index - b.index);
}

/**
 * The first date (and the time near it) in an email: { start, end, allDay, text } as local Dates
 * (all-day end exclusive), or null. `now` decides the year when none is written.
 */
export function detectWhen(text, now = new Date()) {
  const t = String(text || '').slice(0, 20000);
  const dates = findDates(t, now);
  if (!dates.length) return null;
  const d = dates[0];
  const times = findTimes(t).filter((x) => !(x.index >= d.index && x.index < d.index + d.length));
  const near = times.find((x) => Math.abs(x.index - (d.index + d.length)) <= 40 || Math.abs(d.index - (x.index + x.length)) <= 40);
  if (!near || d.endDate) {
    const last = d.endDate || d.date;
    return { start: d.date, end: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1), allDay: true, text: d.text };
  }
  const start = new Date(d.date.getFullYear(), d.date.getMonth(), d.date.getDate(), near.h, near.mi);
  let end = near.endH !== null ? new Date(d.date.getFullYear(), d.date.getMonth(), d.date.getDate(), near.endH, near.endMi) : new Date(+start + 3600e3);
  if (end <= start) end = new Date(+start + 3600e3);
  return { start, end, allDay: false, text: t.slice(Math.min(d.index, near.index), Math.max(d.index + d.length, near.index + near.length)).trim() };
}

/** "Add to calendar" for any email: a draft from its subject and the first date in it (none: tomorrow at 9). */
export function draftFromEmail(msg, now = new Date()) {
  const subject = String(msg.subject || '').replace(/^((re|fwd?|aw|wg)\s*:\s*)+/i, '').trim() || 'Event';
  const when = detectWhen(`${msg.subject || ''}\n${msg.body || msg.snippet || ''}`, now);
  const fallback = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0);
  const who = String(msg.from || '').replace(/\s*<[^>]*>/, '').trim();
  return {
    title: subject.slice(0, 200),
    allDay: when ? when.allDay : false,
    start: when ? when.start : fallback,
    end: when ? when.end : new Date(+fallback + 3600e3),
    location: '',
    notes: `From the email “${String(msg.subject || '').slice(0, 150)}”${who ? ` from ${who}` : ''}.`,
    found: when ? when.text : '',
  };
}
