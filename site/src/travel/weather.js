// A trip's weather: the daily forecast for a place from Open-Meteo (no key; CC BY 4.0, so the
// answer names Open-Meteo). Only days inside its forecast range get numbers. A later day gets
// { forecast: null, why }: never a guess, never a climate average.
//
// Every answer carries `source` and `checked_at`. Times are the place's own (timezone=auto), so
// a "date" is the day where the stop is, which is what a trip's dates mean.

const API = 'https://api.open-meteo.com/v1/forecast';
const DAILY = 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset';
// each hour too (the Today view's strip): its own temperature, chance of rain and weather, in the place's local time
const HOURLY = 'temperature_2m,precipitation_probability,weather_code';
export const FORECAST_DAYS = 16; // the API's limit: forecast_days 0 to 16
const TIMEOUT = 8000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DATES = 60;
export const SOURCE = 'Open-Meteo';

export const TOO_FAR = 'Too far ahead for a forecast';
const PASSED = 'That day has passed';
const NO_DATA = 'No forecast for this day yet';

// WMO weather interpretation codes, as listed in Open-Meteo's docs (open-meteo.com/en/docs,
// "WMO Weather interpretation codes (WW)", read 2026-10-27). 96 and 99 come only from models
// with a hail forecast. A code not in this table gets summary null, not a guess.
export const WMO = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Light freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Heavy freezing rain',
  71: 'Slight snowfall',
  73: 'Moderate snowfall',
  75: 'Heavy snowfall',
  77: 'Snow grains',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  97: 'Heavy thunderstorm',
  99: 'Thunderstorm with heavy hail',
};

export const summaryOf = (code) => (Number.isInteger(code) && WMO[code]) || null;

const dayNumber = (date) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400_000);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// A sunrise or sunset as the place's clock shows it, "HH:MM". Open-Meteo sends local ISO times ("2026-10-27T18:02") in the
// one UTC offset that holds when asked (its docs: daylight saving changes inside the range are ignored), so the time is
// turned back to UTC with that offset and read in the place's own time zone. Anything else → null, never a guess.
export function localClock(value, offsetSeconds, timeZone) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String(value || ''));
  if (!m) return null;
  if (!Number.isFinite(offsetSeconds) || !timeZone) return m[2];
  const utc = Date.parse(`${m[1]}T${m[2]}:00Z`) - offsetSeconds * 1000;
  try {
    return new Date(utc).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone });
  } catch {
    return m[2];
  }
}

/** forecast({ lat, lng, dates }, { fetch, now }) → [{ date, high_c, low_c, rain_chance_pct, summary, sunrise, sunset, source, checked_at }
 *  | { date, forecast: null, why, source, checked_at }] in the order asked, or { error, source, checked_at }. */
export async function forecast({ lat, lng, dates } = {}, { fetch: fetcher = globalThis.fetch, now = () => Date.now() } = {}) {
  const checked_at = new Date(now()).toISOString();
  const fail = (error) => ({ error, source: SOURCE, checked_at });
  if (!(Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) return fail('A forecast needs a map point (lat, lng).');
  if (!Array.isArray(dates) || dates.length < 1 || dates.length > MAX_DATES) return fail(`dates must be a list of 1 to ${MAX_DATES} days.`);
  if (!dates.every((d) => DATE.test(String(d)) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)))) return fail('Each date must be YYYY-MM-DD.');

  // The cut-off before asking: the place's today is at most a day off UTC's, so a day more than
  // FORECAST_DAYS after UTC's today can't be in the range anywhere. Days nearer are settled by
  // what Open-Meteo sends back, in the place's own dates.
  const today = Math.floor(now() / 86400_000);
  const far = (d) => dayNumber(d) - today > FORECAST_DAYS;
  const noForecast = (date, why) => ({ date, forecast: null, why, source: SOURCE, checked_at });
  if (dates.every(far)) return dates.map((d) => noForecast(d, TOO_FAR));

  const q = new URLSearchParams({ latitude: String(lat), longitude: String(lng), daily: DAILY, hourly: HOURLY, timezone: 'auto', forecast_days: String(FORECAST_DAYS) });
  let body;
  try {
    const res = await fetcher(`${API}?${q}`, { signal: AbortSignal.timeout(TIMEOUT) });
    body = await res.json().catch(() => null);
    if (!res.ok || !body || body.error) return fail(body?.reason ? `Open-Meteo: ${body.reason}` : `Open-Meteo answered ${res.status}.`);
  } catch {
    return fail('Open-Meteo did not answer in time.');
  }
  const daily = body.daily;
  const times = Array.isArray(daily?.time) ? daily.time : null;
  if (!times || !times.length) return fail('Open-Meteo sent no daily forecast.');

  const first = times[0], last = times[times.length - 1];
  const col = (name, i) => (Array.isArray(daily[name]) ? num(daily[name][i]) : null);
  // the day's hours, 06:00 to 23:00 local: [{ at: 'HH:MM', temp_c, rain_chance_pct, summary }] (an hour with no numbers is left out)
  const hourly = body.hourly, hTimes = Array.isArray(hourly?.time) ? hourly.time : [];
  const hoursOf = (date) => hTimes.map((t, j) => [t, j]).filter(([t]) => typeof t === 'string' && t.startsWith(`${date}T`) && t.slice(11, 13) >= '06')
    .map(([t, j]) => ({ at: t.slice(11, 16), temp_c: num(hourly.temperature_2m?.[j]), rain_chance_pct: num(hourly.precipitation_probability?.[j]), summary: summaryOf(num(hourly.weather_code?.[j])) }))
    .filter((h) => h.temp_c !== null);
  const sun = (name, i) => (Array.isArray(daily[name]) ? localClock(daily[name][i], body.utc_offset_seconds, typeof body.timezone === 'string' ? body.timezone : null) : null);
  return dates.map((date) => {
    if (far(date) || date > last) return noForecast(date, TOO_FAR);
    if (date < first) return noForecast(date, PASSED);
    const i = times.indexOf(date);
    const high = col('temperature_2m_max', i), low = col('temperature_2m_min', i), code = col('weather_code', i);
    // the range's last day is often sent with empty values: no numbers means no forecast
    const sunrise = i < 0 ? null : sun('sunrise', i), sunset = i < 0 ? null : sun('sunset', i);
    if (i < 0 || high === null || low === null || code === null) return { ...noForecast(date, NO_DATA), sunrise, sunset };
    const hours = hoursOf(date);
    return { date, high_c: high, low_c: low, rain_chance_pct: col('precipitation_probability_max', i), summary: summaryOf(code), sunrise, sunset, ...(hours.length ? { hours } : {}), source: SOURCE, checked_at };
  });
}
