// Who pays for students' AI in a course (askeden ROADMAP L9; owner decision 2026-10-09).
//
// A student's course turn (study chat, quiz, flashcard set, J.A.R.V.I.S. tutor) is paid, in order:
//   1. the course budget, when the professor funded one, it isn't paused or used up, and this
//      student is still under its per-student daily cap;
//   2. the student's free Edu allowance (EDU_FREE: a day's worth across all their courses, on cheap
//      routing: the router's "Efficient" level, no model picks, no rating call, no research mode);
//   3. nothing: a 402 `edu_allowance_used` with a plain message. The student's own Eden allowance is
//      used only when they say so (the page's clear prompt sends `eduOwn: true`).
// The professor's and TAs' own turns, OCR and figure descriptions stay on their own allowance.
//
// Where the money lives (all in the ACCOUNTS Durable Objects, `edu-` ops, Worker only, no device):
//   - the professor's account: `edu:crs:<course>` { cap, student_daily, paused, month, spent, by,
//     days, today, alerts } — the budget, out of the professor's Plus allowance or credits (the
//     account's own spend(), so the usual "held and charged" rules apply). A turn holds its worst
//     case in the account's `holds` (flagged `edu`, so it never counts against the professor's own
//     two-turns limit, but does count against what the professor's own turns may spend).
//   - the student's account: `edu_free` { day, spent, turns, voice, joins } and its holds.
//   - a per-network object `eduip:<SHA-256 of the IP>`: today's accounts drawing the free allowance
//     and today's joins there (abuse limits; the IP itself is never stored).
// The budget never goes negative: a hold is capped by what's left, and a spend is clamped to it.
// A stopped stream is still charged what it used (chat.js charges in flight, F9.4) and its holds are
// released in the turn's `finally`; a hold left behind lapses after 15 minutes anyway.

import { call as accountCall } from '../accounts/index.js';
import { ApiError, json, sha256Hex, validAccountId } from '../accounts/util.js';
import { balanceOf, creditsOf, markupFor } from '../accounts/credits.js';

/** The free daily allowance, per student account, across all their courses (provider cost, UTC days). */
export const EDU_FREE = {
  dailyUSD: 0.1, // about 50 study questions on an efficient model
  turnUSD: 0.03, // the most one free turn may hold (its worst case): a long answer on a cheap model
  minTurnUSD: 0.002, // less than this left: no free turn starts
  // A turn is sized before it's sent (its input estimated from characters, its reply capped in tokens), so it is
  // fitted to what's left divided by this: even a quarter more input than estimated stays within the day's
  // allowance (QA 2026-10-09: one turn took a student past the $0.10 they had). The course budget does the same.
  estimateMargin: 1.25,
  turnsPerDay: 60, // free course turns a day, whatever they cost
  voiceChars: 8000, // J.A.R.V.I.S.'s tutor voice on the free allowance (about 9 minutes)
  level: 2, // the Model Router's "Efficient" level
  typicalTurnUSD: 0.002, // for "about N questions" in plain words
};

/** A professor's course budget. */
export const EDU_BUDGET = {
  maxMonthlyUSD: 500,
  defaultStudentDailyUSD: 0.5,
  maxStudentDailyUSD: 5,
  turnUSD: 0.25, // the most one funded turn may hold
  voiceChars: 30000, // the tutor voice a day for a student while the course is funded (about 33 minutes)
  concurrent: 20, // funded turns in flight per course
  perStudent: 2, // funded or free turns in flight per student
  days: 62, // days of spend kept for the chart
  top: 10,
};

/** Farming free allowances: joins and new free accounts per account and per network a day. */
export const EDU_ABUSE = {
  joinsPerAccountDay: 5, // new courses an account may join a day (COURSES.perAccount caps the total at 30)
  joinsPerIpDay: 150, // joins from one network a day (a lecture hall on one campus address fits)
  freeAccountsPerIpDay: 150, // accounts drawing the free allowance from one network a day
};

const HOLD_MS = 15 * 60_000;
const ID = /^[A-Za-z0-9_-]{22}$/;
const BY = /^[0-9a-f]{16}$/;
const round = (usd) => Math.round(usd * 1e6) / 1e6;
const day = (now) => new Date(now).toISOString().slice(0, 10);
const month = (now) => new Date(now).toISOString().slice(0, 7);
const num = (x, lo, hi) => Math.min(hi, Math.max(lo, Number(x)));
const VOICE_CHARS_A_MINUTE = 900;

export const USED_UP = 'You’ve used today’s free study AI. It refills at midnight UTC. You can keep going on your own Eden allowance if you choose.';
const SHARE_SHORT = 'Not enough of your share of the course budget is left today for this question. It refills at midnight UTC. You can keep going on your own Eden allowance if you choose.';
const NETWORK_FULL = 'Free study AI is limited on this network today: too many accounts used it here. Your professor’s course budget, or your own Eden allowance if you choose, still work.';

/** The anonymous id of a student in a course: the same one the class list uses (course.js members). */
export const studentId = async (course, account) => (await sha256Hex(`${course}:${account}`)).slice(0, 16);

// ── the account's side: `edu-` ops (account.js dispatches them, before any device check) ──

export async function eduAccountOp(account, op, request) {
  try {
    const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
    const run = {
      'edu-free-allow': () => freeAllow(account),
      'edu-free-hold': () => freeHold(account, body),
      'edu-free-spend': () => freeSpend(account, body),
      'edu-free-voice': () => freeVoice(account, body),
      'edu-join': () => joinCount(account),
      'edu-release': () => { account.holds.delete(String(body.hold || '')); return {}; },
      'edu-crs-allow': () => crsAllow(account, body),
      'edu-crs-hold': () => crsHold(account, body),
      'edu-crs-spend': () => crsSpend(account, body),
      'edu-crs-set': () => crsSet(account, body),
      'edu-crs-view': () => crsView(account, body),
      'edu-ip-free': () => ipTake(account, 'accounts', body, EDU_ABUSE.freeAccountsPerIpDay),
      'edu-ip-join': () => ipTake(account, 'joins', body, EDU_ABUSE.joinsPerIpDay),
    }[op];
    if (!run) throw new ApiError(404, 'not_found', 'No such thing.');
    return json(await run());
  } catch (error) {
    if (error instanceof ApiError) return error.response();
    throw error;
  }
}

async function freeState(account) {
  const now = account.now();
  const s = (await account.storage.get('edu_free')) || {};
  if (s.day !== day(now)) return { day: day(now), spent: 0, turns: 0, voice: 0, joins: 0 };
  return s;
}

function heldBy(account, test) {
  account.held(''); // drop expired holds
  let usd = 0;
  let n = 0;
  for (const h of account.holds.values()) if (h.edu && test(h)) { usd += h.usd; n += 1; }
  return { usd, n };
}

async function freeAllow(account) {
  const s = await freeState(account);
  const held = heldBy(account, (h) => h.bucket === 'edu-free');
  const left = round(Math.max(0, EDU_FREE.dailyUSD - s.spent - held.usd));
  const turnsLeft = Math.max(0, EDU_FREE.turnsPerDay - s.turns);
  const voiceLeft = Math.max(0, EDU_FREE.voiceChars - s.voice);
  const view = { day: s.day, spent: round(s.spent), daily: EDU_FREE.dailyUSD, turns_left: turnsLeft, voice_left: voiceLeft, voice_used: s.voice };
  if (left < EDU_FREE.minTurnUSD || !turnsLeft) return { ok: false, why: USED_UP, left: 0, ...view };
  return { ok: true, left: Math.min(left, EDU_FREE.turnUSD), today_left: left, ...view };
}

async function freeHold(account, { usd }) {
  const want = Number(usd);
  if (!(want >= 0)) throw new ApiError(400, 'bad_request', 'usd must be a number');
  if (heldBy(account, (h) => h.bucket === 'edu-free').n >= EDU_BUDGET.perStudent) throw slowDown();
  const allow = await freeAllow(account);
  if (!allow.ok) return allow;
  if (want > allow.left) return { ok: false, why: USED_UP };
  const s = await freeState(account);
  s.turns += 1; // a turn started: counted whatever it costs
  await account.storage.put('edu_free', s);
  const id = `free:${crypto.randomUUID()}`;
  account.holds.set(id, { usd: want, bucket: 'edu-free', until: account.now() + HOLD_MS, pool: null, edu: true });
  return { ok: true, hold: id, bucket: 'edu-free', left: allow.left };
}

async function freeSpend(account, { usd }) {
  const cost = Number(usd);
  if (!(cost > 0)) return { charged_usd: 0 };
  const s = await freeState(account);
  const charged = round(Math.min(cost, Math.max(0, EDU_FREE.dailyUSD - s.spent))); // never past the day's allowance
  s.spent = round(s.spent + charged);
  await account.storage.put('edu_free', s);
  return { charged_usd: charged };
}

async function freeVoice(account, { chars, cap }) {
  const n = Math.max(0, Math.floor(Number(chars) || 0));
  const limit = num(cap || EDU_FREE.voiceChars, 0, EDU_BUDGET.voiceChars);
  const s = await freeState(account);
  if (s.voice + n > limit) return { ok: false, why: 'Today’s Eden voice for studying is used up; your browser’s voice reads instead. It refills at midnight UTC.', left: Math.max(0, limit - s.voice) };
  s.voice += n;
  await account.storage.put('edu_free', s);
  return { ok: true, left: limit - s.voice };
}

async function joinCount(account) {
  const s = await freeState(account);
  if (s.joins >= EDU_ABUSE.joinsPerAccountDay) return { ok: false, why: `You can join at most ${EDU_ABUSE.joinsPerAccountDay} new courses a day. Try again tomorrow.` };
  s.joins += 1;
  await account.storage.put('edu_free', s);
  return { ok: true };
}

/** A network's day: who drew the free allowance there, and how many joins came from it. */
async function ipTake(account, kind, { who }, cap) {
  const now = account.now();
  let s = (await account.storage.get('eduip')) || {};
  if (s.day !== day(now)) s = { day: day(now), accounts: [], joins: 0 };
  if (kind === 'joins') {
    if (s.joins >= cap) return { ok: false, why: 'Too many people joined courses from this network today. Try again tomorrow, or from another connection.' };
    s.joins += 1;
  } else {
    const w = String(who || '').slice(0, 64);
    if (!s.accounts.includes(w)) {
      if (s.accounts.length >= cap) return { ok: false, why: NETWORK_FULL };
      s.accounts.push(w);
    }
  }
  await account.storage.put('eduip', s);
  return { ok: true };
}

// The professor's budget for one course.
const poolKey = (course) => `edu:crs:${course}`;

async function crsPool(account, course) {
  if (!ID.test(String(course))) throw new ApiError(400, 'bad_request', 'No such course.');
  const now = account.now();
  const p = (await account.storage.get(poolKey(course))) || { cap: 0, student_daily: EDU_BUDGET.defaultStudentDailyUSD, paused: false, month: month(now), spent: 0, by: {}, days: {}, today: { day: day(now), by: {} }, alerts: {} };
  if (p.month !== month(now)) Object.assign(p, { month: month(now), spent: 0, by: {}, alerts: {} });
  if (!p.today || p.today.day !== day(now)) p.today = { day: day(now), by: {} };
  return p;
}

/** The professor's own allowance under the budget: Plus or credits (never the one-off trial). */
async function funding(account) {
  const base = await account.allowAi(null);
  if (!base.ok) return { ok: false, why: 'The course budget is paused: your own AI allowance is used up. Add credits or wait for it to renew.' };
  if (base.bucket !== 'trial') return base;
  // on the trial (no Plus): the credits alone fund a course, never the one-off trial
  const credit = balanceOf(await creditsOf(account), account.now()) / markupFor(await account.planNow()) - account.held('credits');
  if (credit > 0) return { ok: true, bucket: 'credits', left: round(credit) };
  return { ok: false, why: 'A course budget needs Eden Plus or credits on your account.' };
}

async function crsAllow(account, { course, by }) {
  const p = await crsPool(account, course);
  if (!(p.cap > 0)) return { ok: false, why: 'This course has no budget.', funded: false };
  if (p.paused) return { ok: false, why: 'The professor paused the course budget.', funded: true };
  const base = await funding(account);
  if (!base.ok) return { ...base, funded: true };
  const key = poolKey(course);
  const held = heldBy(account, (h) => h.pool === key);
  const mine = BY.test(String(by)) ? heldBy(account, (h) => h.pool === key && h.by === by).usd : 0;
  const studentLeft = BY.test(String(by)) ? p.student_daily - (p.today.by[by] || 0) - mine : Infinity;
  const courseLeft = p.cap - p.spent - held.usd;
  const left = round(Math.max(0, Math.min(base.left, courseLeft, studentLeft)));
  if (courseLeft <= 0) return { ok: false, why: 'This course’s budget for the month is used up.', funded: true };
  if (left < EDU_FREE.minTurnUSD) return { ok: false, why: 'Your share of the course budget for today is used up.', funded: true, today_left: 0 };
  return { ok: true, funded: true, bucket: base.bucket, left: Math.min(left, EDU_BUDGET.turnUSD), today_left: round(Math.max(0, Math.min(studentLeft, courseLeft))), held: held.n };
}

async function crsHold(account, { course, by, usd }) {
  const want = Number(usd);
  if (!(want >= 0)) throw new ApiError(400, 'bad_request', 'usd must be a number');
  if (!BY.test(String(by))) throw new ApiError(400, 'bad_request', 'No such student.');
  const key = poolKey(course);
  if (heldBy(account, (h) => h.pool === key).n >= EDU_BUDGET.concurrent) throw slowDown();
  if (heldBy(account, (h) => h.pool === key && h.by === by).n >= EDU_BUDGET.perStudent) throw slowDown();
  const allow = await crsAllow(account, { course, by });
  if (!allow.ok) return allow;
  if (want > allow.left) return { ok: false, why: 'Not enough of the course budget is left for this.' };
  const id = `crs:${crypto.randomUUID()}`;
  account.holds.set(id, { usd: want, bucket: allow.bucket, until: account.now() + HOLD_MS, pool: key, by, edu: true });
  return { ok: true, hold: id, bucket: allow.bucket, left: allow.left };
}

async function crsSpend(account, { course, by, usd, hold }) {
  const cost = Number(usd);
  if (!(cost > 0)) return { charged_usd: 0 };
  const p = await crsPool(account, course);
  const charge = round(Math.min(cost, Math.max(0, p.cap - p.spent))); // the budget never goes negative
  if (!(charge > 0)) return { charged_usd: 0 };
  const h = account.holds.get(String(hold || ''));
  const base = h ? h.bucket : (await account.allowAi(null)).bucket || 'plus';
  await account.spend({ usd: charge, bucket: base }); // the professor's own allowance, then credits, as any turn of theirs
  const now = account.now();
  const who = BY.test(String(by)) ? by : 'unknown';
  p.spent = round(p.spent + charge);
  p.by[who] = round((p.by[who] || 0) + charge);
  p.today.by[who] = round((p.today.by[who] || 0) + charge);
  p.days[day(now)] = round((p.days[day(now)] || 0) + charge);
  const keep = Object.keys(p.days).sort().slice(-EDU_BUDGET.days);
  p.days = Object.fromEntries(keep.map((d) => [d, p.days[d]]));
  for (const at of [80, 100]) if (p.cap > 0 && p.spent >= (p.cap * at) / 100 && !p.alerts[at]) p.alerts[at] = now;
  await account.storage.put(poolKey(course), p);
  return { charged_usd: charge };
}

async function crsSet(account, { course, monthly_usd, student_daily_usd, paused }) {
  const p = await crsPool(account, course);
  if (monthly_usd !== undefined) {
    const cap = Number(monthly_usd);
    if (!(cap >= 0 && cap <= EDU_BUDGET.maxMonthlyUSD)) throw new ApiError(400, 'bad_request', `A course budget is $0 to $${EDU_BUDGET.maxMonthlyUSD} a month.`);
    if (cap > 0) {
      const plan = await account.planNow();
      if (!plan.active && !(balanceOf(await creditsOf(account), account.now()) > 0)) throw new ApiError(402, 'needs_plus', 'A course budget comes out of your Eden Plus allowance or your credits. Get Plus or add credits first.');
    }
    p.cap = round(cap);
    if (p.spent < (p.cap * 80) / 100) delete p.alerts[80];
    if (p.spent < p.cap) delete p.alerts[100];
  }
  if (student_daily_usd !== undefined) {
    const d = Number(student_daily_usd);
    if (!(d > 0 && d <= EDU_BUDGET.maxStudentDailyUSD)) throw new ApiError(400, 'bad_request', `Each student’s daily cap is more than $0 and at most $${EDU_BUDGET.maxStudentDailyUSD}.`);
    p.student_daily = round(d);
  }
  if (paused !== undefined) p.paused = paused === true;
  await account.storage.put(poolKey(course), p);
  return crsView(account, { course });
}

async function crsView(account, { course }) {
  const p = await crsPool(account, course);
  const key = poolKey(course);
  const held = heldBy(account, (h) => h.pool === key);
  const base = p.cap > 0 ? await funding(account) : { ok: true };
  const pct = p.cap > 0 ? Math.round((p.spent / p.cap) * 100) : 0;
  const days = Object.entries(p.days).sort(([a], [b]) => (a < b ? -1 : 1)).filter(([d]) => d.slice(0, 7) === p.month || d >= day(account.now() - 31 * 864e5)).map(([d, usd]) => ({ day: d, usd }));
  const top = Object.entries(p.by).sort(([, a], [, b]) => b - a).slice(0, EDU_BUDGET.top).map(([student, usd]) => ({ student, usd }));
  return {
    monthly_usd: p.cap, student_daily_usd: p.student_daily, paused: p.paused, month: p.month,
    spent_usd: round(p.spent), left_usd: round(Math.max(0, p.cap - p.spent)), held_usd: round(held.usd), pct,
    alert: p.cap > 0 && p.spent >= p.cap ? 100 : p.cap > 0 && p.spent >= p.cap * 0.8 ? 80 : null,
    alerts: p.alerts, funded: p.cap > 0, funding_ok: Boolean(base.ok), why: base.ok ? null : base.why,
    students_today: Object.keys(p.today.by).length, days, top,
    limits: { max_monthly_usd: EDU_BUDGET.maxMonthlyUSD, max_student_daily_usd: EDU_BUDGET.maxStudentDailyUSD },
    free: { daily_usd: EDU_FREE.dailyUSD, turns_per_day: EDU_FREE.turnsPerDay, voice_chars: EDU_FREE.voiceChars },
  };
}

const slowDown = () => new ApiError(429, 'slow_down', 'Eden is already answering two questions for you; wait for one to finish.', { 'retry-after': '10' });

// ── the Worker's side ──

const courseStub = (env, id) => env.COURSES.get(env.COURSES.idFromName(id));
async function payInfo(env, courseId, account) {
  const res = await courseStub(env, courseId).fetch('https://course/pay-info', { method: 'POST', body: JSON.stringify({ account }) });
  const out = await res.json().catch(() => ({}));
  if (res.status >= 400) throw new ApiError(res.status, out.code || 'error', out.error || 'Something went wrong.');
  return out;
}
const ipName = async (ip) => `eduip:${await sha256Hex(`edu-ip:${ip || 'unknown'}`)}`;
const ipOf = (request) => (request && request.headers.get('cf-connecting-ip')) || 'unknown';

/**
 * The payer of a course turn (chat.js send), shaped like accounts' `call` for the four money ops
 * (allow-ai, hold-ai, spend, release-ai); everything else goes to the account as before. null:
 * the asker pays as usual (the professor or a TA, or a student who chose their own allowance).
 */
export async function coursePayer(env, who, courseId, { request = null, own = false, call = accountCall } = {}) {
  if (!env.COURSES || !ID.test(String(courseId)) || who.grant) return null; // courseForTurn refuses these
  const info = await payInfo(env, courseId, who.account);
  if (info.role !== 'student' || own) return null;
  const by = await studentId(courseId, who.account);
  const owner = validAccountId(info.owner) ? info.owner : null;
  const ip = ipOf(request);
  let source = null;

  const fromCourse = async () => (owner ? call(env, owner, 'edu-crs-allow', { course: courseId, by }).catch(() => ({ ok: false })) : { ok: false });
  const fromFree = async () => {
    const a = await call(env, who.account, 'edu-free-allow', {});
    if (!a.ok) return a;
    const net = await call(env, await ipName(ip), 'edu-ip-free', { who: (await sha256Hex(`edu-who:${who.account}`)).slice(0, 32) });
    return net.ok ? a : { ok: false, why: net.why };
  };
  const usedUp = (why) => new ApiError(402, 'edu_allowance_used', why || USED_UP, {}, { edu: true });
  // what the turn may be sized to: the most it may hold (what's left today, at most the per-turn cap), with room
  // for the estimate being short; chat.js fits the reply's max tokens and the hold to this
  const sized = (usd) => round(Math.max(0, Number(usd) || 0) / EDU_FREE.estimateMargin);

  const pay = async (_env, account, op, body = {}, auth = null) => {
    if (op === 'allow-ai') {
      const c = await fromCourse();
      if (c.ok) { source = 'course'; return { ok: true, bucket: 'edu-crs', left: sized(c.left), allowance_left: sized(c.left), budget: c.left, markup: 1, credits_usd: 0, source }; }
      const f = await fromFree();
      if (f.ok) { source = 'free'; return { ok: true, bucket: 'edu-free', left: sized(f.left), allowance_left: sized(f.left), budget: EDU_FREE.dailyUSD, markup: 1, credits_usd: 0, source }; }
      throw usedUp(f.why);
    }
    if (op === 'hold-ai') {
      if (source !== 'free') {
        const h = owner ? await call(env, owner, 'edu-crs-hold', { course: courseId, by, usd: body.usd }) : { ok: false };
        if (h.ok) return { ok: true, hold: h.hold, bucket: `edu-crs|${h.hold}`, left: h.left, markup: 1 };
        if (source === 'course' && !(await fromFree()).ok) return { ok: false, why: h.why || USED_UP };
      }
      const h = await call(env, who.account, 'edu-free-hold', { usd: body.usd });
      return h.ok ? { ok: true, hold: h.hold, bucket: 'edu-free', left: h.left, markup: 1 } : { ok: false, why: h.why || USED_UP };
    }
    if (op === 'spend') {
      const bucket = String(body.bucket || '');
      if (bucket.startsWith('edu-crs')) return owner ? call(env, owner, 'edu-crs-spend', { course: courseId, by, usd: body.usd, hold: bucket.split('|')[1] || null }) : { charged_usd: 0 };
      if (bucket === 'edu-free') return call(env, who.account, 'edu-free-spend', { usd: body.usd });
      return { charged_usd: 0 }; // never the student's own allowance from a paid-for turn
    }
    if (op === 'release-ai') {
      const hold = String(body.hold || '');
      if (hold.startsWith('crs:') && owner) return call(env, owner, 'edu-release', { hold });
      if (hold.startsWith('free:')) return call(env, who.account, 'edu-release', { hold });
      return {};
    }
    return call(env, account, op, body, auth);
  };
  /** What's left can't pay even a short reply (chat.js fit): a clean stop, the same one the page offers a choice on. */
  const tooLittle = () => usedUp(source === 'course' ? SHARE_SHORT : USED_UP);
  return { call: pay, by, owner, source: () => source, tooLittle };
}

/**
 * A free turn's shape (chat.js send, once the allowance is known): the router's Efficient level,
 * no model pick of the student's (an automatic pick like the tutor's quick model stays), no rating
 * call, no research mode, no autopilot. A funded turn keeps the student's settings.
 */
export function shapeFreeTurn(body, raw, allow, { autoPick = null } = {}) {
  raw.autopilot = false;
  if (!allow || allow.source !== 'free') return [];
  const notes = [];
  body.settings = { ...body.settings, level: EDU_FREE.level, classifier: 'off' };
  delete body.settings.efficiency;
  delete body.settings.performance;
  if (body.override && !autoPick) { body.override = null; notes.push('free study turns use an efficient model'); }
  if (body.mode === 'research') body.mode = 'search';
  return notes;
}

/** The tutor's voice in a course (worker.js /api/chat/voice with `course`): null = the account's own voice allowance. */
export async function courseVoice(env, token, courseId, chars, { own = false, call = accountCall } = {}) {
  if (!env.COURSES || !ID.test(String(courseId)) || own) return null;
  let info;
  try { info = await payInfo(env, courseId, token.account); } catch { return null; }
  if (info.role !== 'student') return null;
  const by = await studentId(courseId, token.account);
  const funded = validAccountId(info.owner) ? await call(env, info.owner, 'edu-crs-allow', { course: courseId, by }).catch(() => ({ ok: false })) : { ok: false };
  return call(env, token.account, 'edu-free-voice', { chars, cap: funded.ok ? EDU_BUDGET.voiceChars : EDU_FREE.voiceChars });
}

/** Before joining a course (course.js join route): the per-account and per-network caps. Already a member: no count. */
export async function joinGuard(env, account, request, courseId, { call = accountCall } = {}) {
  if (!env.ACCOUNTS) return;
  try { await payInfo(env, courseId, account); return; } catch { /* not a member yet */ }
  const net = await call(env, await ipName(ipOf(request)), 'edu-ip-join', {});
  if (!net.ok) throw new ApiError(429, 'slow_down', net.why);
  const mine = await call(env, account, 'edu-join', {});
  if (!mine.ok) throw new ApiError(429, 'slow_down', mine.why);
}

const questions = (usd) => Math.max(0, Math.floor(usd / EDU_FREE.typicalTurnUSD));

/** What a student has left today, in plain words (GET …/allowance). */
export function allowanceWords({ course, free }) {
  const q = (n) => `about ${n} more question${n === 1 ? '' : 's'}`;
  const voiceMin = Math.round((free.voice_left || 0) / VOICE_CHARS_A_MINUTE);
  const freeText = free.ok
    ? `Free today: ${q(Math.min(questions(free.today_left ?? free.left), free.turns_left))}${voiceMin ? ` and about ${voiceMin} minute${voiceMin === 1 ? '' : 's'} of Eden’s voice` : ''}. It refills at midnight UTC.`
    : free.why || USED_UP;
  if (course && course.ok) return `Your professor’s course budget covers your studying today (${q(questions(course.today_left))}). ${freeText}`;
  return freeText;
}

/** The budget routes: GET/POST …/courses/<id>/budget (the professor), GET …/courses/<id>/allowance (anyone in it). */
export async function budgetApi(request, env, who, courseId, rest, { readBody, call = accountCall }) {
  const info = await payInfo(env, courseId, who.account);
  const method = request.method;
  if (rest[1] === 'allowance' && rest.length === 2 && method === 'GET') {
    if (info.role !== 'student') return { role: info.role, text: 'Your own turns here use your own Eden allowance.' };
    const by = await studentId(courseId, who.account);
    const course = validAccountId(info.owner) ? await call(env, info.owner, 'edu-crs-allow', { course: courseId, by }).catch(() => ({ ok: false })) : { ok: false };
    const free = await call(env, who.account, 'edu-free-allow', {});
    return {
      role: 'student',
      course: { funded: Boolean(course.funded), ok: Boolean(course.ok), today_left_usd: course.ok ? course.today_left : 0 },
      free: { ok: free.ok, left_usd: free.today_left || 0, daily_usd: EDU_FREE.dailyUSD, turns_left: free.turns_left, voice_left: free.voice_left },
      text: allowanceWords({ course, free }),
    };
  }
  if (rest[1] === 'budget' && rest.length === 2) {
    if (info.role !== 'owner') throw new ApiError(403, 'forbidden', 'Only the professor can see or change the course budget.');
    if (method === 'GET') return call(env, who.account, 'edu-crs-view', { course: courseId });
    if (method === 'POST') {
      const b = await readBody(request, 1024);
      return call(env, who.account, 'edu-crs-set', { course: courseId, monthly_usd: b.monthly_usd, student_daily_usd: b.student_daily_usd, paused: b.paused });
    }
  }
  throw new ApiError(404, 'not_found', 'No such thing.');
}
