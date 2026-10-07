// The pure part of the spending autopilot (ROADMAP H3): the month's forecast, the autopilot's
// stage, how routing steps down at each stage, and what the routes saved against always using
// the top model. The same rules as src/chat/budget.ts (src/__tests__/budget.test.ts keeps the
// two equal); askeden.com's Worker (site/src/eden/chat.js) imports this file, where the
// account's allowance is the budget. No DOM and no imports; autopilot.js draws with it.
//
// Stages (the D16 budget guard's 80% threshold, stepping the level instead of the sliders):
//   0  under 80% of the budget forecast for the month: routing as you set it;
//   1  forecast ≥ 80%: one level cheaper;
//   2  forecast ≥ 95%: two levels cheaper, and no top-tier model billed in API dollars;
//   3  spent ≥ the budget: Level 1 and only the cheapest (fast-tier) models billed in dollars.
// Claude through the subscription is quota, not dollars (D8/D9): it never counts toward the
// budget and is never left out. A pick of your own, or "Use my level this time", skips it.

export const AUTOPILOT = { lean: 0.8, save: 0.95, minDays: 3, historyDays: 56, weekdayMinDays: 14, weekdayPrior: 2 };
export const STAGES = [
  { stage: 0, key: 'off', label: '', what: 'routing as you set it' },
  { stage: 1, key: 'lean', label: 'Autopilot: saving for the month', what: 'one level cheaper' },
  { stage: 2, key: 'save', label: 'Autopilot: saving for the month', what: 'two levels cheaper, and no top-tier models on API dollars' },
  { stage: 3, key: 'cap', label: 'Autopilot: budget reached', what: 'Level 1 and only the cheapest models' },
];
/** What "always the top model" means for the savings tally. */
export const TOP_MODEL = 'claude-opus-5-5';
const DAY_MS = 86_400_000;
const LEVELS = [
  { level: 1, efficiency: 80, performance: 30 },
  { level: 2, efficiency: 60, performance: 40 },
  { level: 3, efficiency: 50, performance: 50 },
  { level: 4, efficiency: 40, performance: 70 },
  { level: 5, efficiency: 35, performance: 90 },
];

const pad = (n) => String(n).padStart(2, '0');
/** The calendar day of `ms`, YYYY-MM-DD (local time, or UTC on askeden.com). */
export function dayKey(ms, { utc = false } = {}) {
  const d = new Date(ms);
  return utc ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
const keyMs = (key, utc) => { const [y, m, d] = key.split('-').map(Number); return utc ? Date.UTC(y, m - 1, d) : new Date(y, m - 1, d).getTime(); };
const weekday = (key, utc) => { const t = keyMs(key, utc); return utc ? new Date(t).getUTCDay() : new Date(t).getDay(); };

/** This month: { start, end } in epoch ms (local calendar month, or UTC). */
export function monthBounds(now, { utc = false } = {}) {
  const d = new Date(now);
  if (utc) return { start: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), end: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) };
  return { start: new Date(d.getFullYear(), d.getMonth(), 1).getTime(), end: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime() };
}

/**
 * How each weekday's spend compares with the average day (Sunday = 0), from the last
 * historyDays of daily spend (`daily`: [{ day: 'YYYY-MM-DD', usd }]); null with less than
 * weekdayMinDays of history. Each weekday's mean is shrunk toward the overall mean by
 * weekdayPrior days, and the seven factors average 1.
 */
export function weekdayFactors(daily, { now, utc = false } = {}) {
  const today = dayKey(now, { utc });
  const from = dayKey(now - AUTOPILOT.historyDays * DAY_MS, { utc });
  const by = new Map();
  for (const r of daily || []) if (r && typeof r.day === 'string' && r.day >= from && r.day < today && Number.isFinite(r.usd)) by.set(r.day, (by.get(r.day) || 0) + Math.max(0, r.usd));
  if (!by.size) return null;
  const first = [...by.keys()].sort()[0];
  const days = [];
  for (let k = first; k < today; k = dayKey(nextDay(k, utc), { utc })) days.push(k);
  if (days.length < AUTOPILOT.weekdayMinDays) return null;
  const total = days.reduce((n, k) => n + (by.get(k) || 0), 0);
  const mean = total / days.length;
  if (!(mean > 0)) return null;
  const sum = Array(7).fill(0);
  const n = Array(7).fill(0);
  for (const k of days) { const w = weekday(k, utc); sum[w] += by.get(k) || 0; n[w]++; }
  const raw = sum.map((s, w) => (s + AUTOPILOT.weekdayPrior * mean) / (n[w] + AUTOPILOT.weekdayPrior));
  const avg = raw.reduce((a, b) => a + b, 0) / 7;
  return raw.map((x) => x / avg);
}

/**
 * The month's spend forecast: what's spent plus the daily rate so far (counted over at least
 * minDays, so the first hours don't extrapolate wildly) for the days left; each day left
 * weighted by its weekday's pattern when there's the history for it.
 * → { usd, method: 'linear' | 'weekday', rate, daysLeft }
 */
export function forecast({ spent = 0, start, end, now, daily = null, utc = false }) {
  const elapsed = Math.max(0, (now - start) / DAY_MS);
  const left = Math.max(0, (end - now) / DAY_MS);
  const rate = Math.max(0, spent) / Math.max(elapsed, AUTOPILOT.minDays);
  const f = daily ? weekdayFactors(daily, { now, utc }) : null;
  let units = left;
  if (f) {
    units = 0;
    for (let t = now; t < end; ) {
      const k = dayKey(t, { utc });
      const next = Math.min(end, nextDay(k, utc));
      units += ((next - t) / DAY_MS) * f[weekday(k, utc)];
      t = next;
    }
  }
  const usd = Math.max(0, spent) + rate * units;
  return { usd: Math.round(usd * 1e4) / 1e4, method: f ? 'weekday' : 'linear', rate: Math.round(rate * 1e4) / 1e4, daysLeft: Math.round(left * 10) / 10 };
}
function nextDay(key, utc) {
  const [y, m, d] = key.split('-').map(Number);
  return utc ? Date.UTC(y, m - 1, d + 1) : new Date(y, m - 1, d + 1).getTime();
}

/** 0-3 (see the header). No budget: 0. */
export function autopilotStage({ spent = 0, budget = 0, forecastUSD = 0 }) {
  if (!(budget > 0)) return 0;
  if (spent >= budget) return 3;
  const f = forecastUSD / budget;
  return f >= AUTOPILOT.save ? 2 : f >= AUTOPILOT.lean ? 1 : 0;
}

/** The autopilot for a month: the stage, its words, and the numbers behind it. */
export function autopilotState({ spent = 0, budget = 0, now, start, end, daily = null, utc = false }) {
  const b = Number(budget) > 0 ? Number(budget) : 0;
  const fc = forecast({ spent, start, end, now, daily, utc });
  const stage = autopilotStage({ spent, budget: b, forecastUSD: fc.usd });
  const s = STAGES[stage];
  return {
    stage,
    key: s.key,
    label: s.label,
    what: s.what,
    budgetUSD: b,
    spentUSD: Math.round(spent * 1e4) / 1e4,
    forecastUSD: fc.usd,
    method: fc.method,
    fraction: b ? Math.round((spent / b) * 1e4) / 1e4 : 0,
    forecastFraction: b ? Math.round((fc.usd / b) * 1e4) / 1e4 : 0,
    periodStart: new Date(start).toISOString(),
    periodEnd: new Date(end).toISOString(),
  };
}

/** The level to route at for a stage, from the level you set (1-5): { level, efficiency, performance }. */
export function steppedLevel(level, stage) {
  const from = Math.max(1, Math.min(5, Math.round(Number(level) || 3)));
  const to = stage >= 3 ? 1 : Math.max(1, from - Math.max(0, stage | 0));
  return { ...LEVELS[to - 1] };
}

/**
 * Models a stage leaves out: at 2 the frontier tier, at 3 everything but the fast tier, of the
 * models billed in API dollars (a provider in `subscription` is quota: never left out). If it
 * would leave nothing, it leaves out nothing (the level still steps down).
 * `models`: [{ id, provider, tier }].
 */
export function stageExclusions(models, stage, subscription = []) {
  if (stage < 2) return [];
  const billed = (m) => !subscription.includes(m.provider);
  const out = (models || []).filter((m) => billed(m) && (stage >= 3 ? m.tier !== 'fast' : m.tier === 'frontier')).map((m) => m.id);
  return out.length >= (models || []).length ? [] : out;
}

/** USD as the page writes it: $0.004, $1.24, $38. */
export function usd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '';
  const a = Math.abs(n);
  const s = a === 0 ? '0' : a < 0.001 ? '<0.001' : a < 0.1 ? a.toFixed(3) : a < 100 ? a.toFixed(2) : String(Math.round(a));
  return `${n < 0 ? '−' : ''}$${s}`;
}

/** The stage in a sentence, for the estimate line's title and the console. */
export function autopilotWhy(st, { when = '' } = {}) {
  if (!st || !(st.budgetUSD > 0)) return 'No monthly budget set: the autopilot is off.';
  const head = `${usd(st.spentUSD)} of your ${usd(st.budgetUSD)} this month`;
  if (st.stage >= 3) return `${head}: the budget is reached, so Eden uses only the cheapest models until it renews${when ? ` (${when})` : ''}. Pick a model for one message to go past it.`;
  const pace = `at this pace about ${usd(st.forecastUSD)} by the end of the month${st.method === 'weekday' ? ' (your weekday pattern counted)' : ''}`;
  if (st.stage === 0) return `${head}; ${pace}.`;
  return `${head}; ${pace}, so routing is ${st.what} to stay within it.`;
}

/**
 * What the routes saved against always using the top model at the same tokens, over replies
 * billed in dollars (subscription replies are quota on both sides): Σ (topUSD − costUSD).
 * `turns`: [{ costUSD, topUSD, notional }] → { usd, turns }
 */
export function savedVsTop(turns) {
  let s = 0;
  let n = 0;
  for (const t of turns || []) {
    if (!t || t.notional || typeof t.topUSD !== 'number' || typeof t.costUSD !== 'number' || !Number.isFinite(t.topUSD) || !Number.isFinite(t.costUSD)) continue;
    s += t.topUSD - t.costUSD;
    n++;
  }
  return { usd: Math.round(s * 1e6) / 1e6, turns: n };
}
