// One account object, one alarm. A Durable Object has a single alarm; this keeps a short queue of
// what's due in the account (expired artifacts, scheduled Gmail sends, background tasks' checks)
// and sets that alarm to the earliest of them. account.js's alarm() hands each due job to its
// kind's handler.
//
//   alarmq → [{ key, kind, at, tries, gen }], soonest first, one storage value. `key` is unique:
//            'artifacts', 'mail:<job id>', 'task:<task id>', 'uploads' (mail-uploads.js).
//
// - scheduleJob(account, key, kind, at) adds or moves one job; unscheduleJob(account, key) drops it.
// - runAlarms(account, handlers), from alarm(): the due jobs (at most RUN_MAX, soonest first) are
//   leased first (moved LEASE ahead, `tries` + 1), so a run cut off half-way (the object evicted)
//   comes round again instead of being lost. Then each runs in turn. Its handler returns
//   nothing (done: the job goes), a time (run again then), or throws: tried again after a
//   backoff (30 s, 1, 2, 4, 8, 16 min), at most RETRIES runs, then dropped and logged. A handler
//   that schedules its own key again (scheduleJob) wins over what it returns.
//
// Scheduled Gmail sends on askeden.com (eden/google-data.js's `schedule`, `scheduled` and
// `cancelScheduled`) live here too: the email is a Gmail draft (Gmail's API has no scheduled
// send), and a job says which draft to send when, as Eden's server on the Mac does
// (askeden src/chat/gmail-schedule.ts), with the same rules:
//   - more than 12 h late → "missed": never sent without the owner (it stays in Drafts);
//   - 429/5xx → tried again (Google's retry-after, else 2 min × attempts), at most 3 times;
//   - cut off mid-send → "unknown" (it may have gone: never sent again blindly);
//   - Gmail now connected to another address → "failed", not sent from that one.
//   smail:<id> → the job (ScheduledJob in gmail.ts, plus `local`). No message text is kept here:
//   the draft id, the recipients' addresses and the subject only.
// The object reads the account's sealed Google tokens itself (accounts/tokens.js) to send.

import { ApiError } from './util.js';
import { TOKEN_RECORD, openTokens, sealTokens } from './tokens.js';
import { GoogleError, createCalendarApi, createGmailApi, refreshAccessToken } from '../eden/vendor/google.js';

export const ALARMS = { key: 'alarmq', max: 400, runMax: 10, leaseMs: 10 * 60_000, retries: 6, backoffMs: 30_000, backoffMaxMs: 3600_000 };

const sortQueue = (q) => q.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
const newGen = () => crypto.randomUUID().slice(0, 8);
export const backoff = (tries) => Math.min(ALARMS.backoffMaxMs, ALARMS.backoffMs * 2 ** Math.max(0, tries - 1));

async function loadQueue(account) {
  const q = await account.storage.get(ALARMS.key);
  return Array.isArray(q) ? q : [];
}

/** The account's alarm, set to its soonest job (cleared when there's none). */
async function arm(account, q) {
  const storage = account.storage;
  if (!q.length) {
    if (storage.deleteAlarm) await storage.deleteAlarm();
    return;
  }
  if (storage.setAlarm) await storage.setAlarm(q[0].at);
}

async function saveQueue(account, q) {
  sortQueue(q);
  if (q.length) await account.storage.put(ALARMS.key, q);
  else await account.storage.delete(ALARMS.key);
  await arm(account, q);
}

/** What's queued, soonest first (tests and the tasks' view). */
export const queued = (account) => loadQueue(account).then(sortQueue);

export async function scheduleJob(account, key, kind, at) {
  const q = (await loadQueue(account)).filter((j) => j.key !== key);
  if (q.length >= ALARMS.max) throw new ApiError(429, 'slow_down', 'Too much is scheduled in this account right now.');
  q.push({ key, kind, at: Math.max(0, Math.round(Number(at) || 0)), tries: 0, gen: newGen() });
  await saveQueue(account, q);
}

export async function unscheduleJob(account, key) {
  const q = await loadQueue(account);
  const left = q.filter((j) => j.key !== key);
  if (left.length !== q.length) await saveQueue(account, left);
}

/**
 * The alarm went off: the due jobs run (see the top of this file). `handlers` maps a kind to
 * `async (job) => undefined | nextTimeMs`. Returns what ran: [{ key, kind, ok }].
 */
export async function runAlarms(account, handlers) {
  const now = account.now();
  const q = sortQueue(await loadQueue(account));
  const due = q.filter((j) => j.at <= now).slice(0, ALARMS.runMax);
  if (!due.length) {
    await arm(account, q); // woke early (or the queue changed meanwhile): sleep again
    return [];
  }
  for (const j of due) {
    j.at = now + ALARMS.leaseMs;
    j.tries += 1;
  }
  await saveQueue(account, q);
  const ran = [];
  for (const job of due) {
    const handler = Object.hasOwn(handlers, job.kind) ? handlers[job.kind] : null;
    let result;
    let error = null;
    try {
      result = handler ? await handler(job) : undefined;
    } catch (e) {
      error = e;
    }
    const fresh = await loadQueue(account);
    const entry = fresh.find((j) => j.key === job.key);
    if (entry && entry.gen === job.gen) {
      let left = fresh;
      if (error) {
        if (job.tries >= ALARMS.retries) {
          left = fresh.filter((j) => j !== entry);
          console.error('scheduled job given up', job.key, error && (error.stack || error.message));
        } else {
          entry.at = account.now() + backoff(job.tries);
        }
      } else if (Number.isFinite(result)) {
        entry.at = Math.round(result);
        entry.tries = 0;
      } else {
        left = fresh.filter((j) => j !== entry);
      }
      await saveQueue(account, left);
    }
    ran.push({ key: job.key, kind: job.kind, ok: !error });
  }
  await arm(account, sortQueue(await loadQueue(account)));
  return ran;
}

// ── Google from inside the account object (scheduled sends, background tasks) ──

const local = (h) => h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '[::1]';
const FAKE_HOSTS = /^https:\/\/(accounts\.google\.com|oauth2\.googleapis\.com|gmail\.googleapis\.com|www\.googleapis\.com|api\.anthropic\.com|api\.push\.apple\.com|api\.sandbox\.push\.apple\.com)\//;

/**
 * The fetch background work uses. A job or task made from a page served by `wrangler dev` on
 * localhost carries `local: true`; only then, and only when GOOGLE_FAKE_BASE is a local http
 * address, do its Google, Anthropic and push calls go to that fake (as google-data.js's
 * fakeBase does for requests). On askeden.com nothing is ever local.
 */
export function backgroundFetch(env, isLocal) {
  let base = null;
  if (isLocal) {
    try {
      const u = new URL(String(env.GOOGLE_FAKE_BASE || ''));
      if (u.protocol === 'http:' && local(u.hostname)) base = u.origin;
    } catch {
      base = null;
    }
  }
  if (!base) return (url, init) => fetch(url, init);
  return (url, init) => fetch(String(url).replace(FAKE_HOSTS, (_, h) => `${base}/${h}/`), init);
}

const GMAIL_READ = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';
export function gmailScopesOk(scopes) {
  const s = new Set(scopes || []);
  return s.has('https://mail.google.com/') || s.has('https://www.googleapis.com/auth/gmail.modify') || (s.has(GMAIL_READ) && s.has(GMAIL_COMPOSE));
}
export const calendarScopesOk = (scopes) => (scopes || []).includes('https://www.googleapis.com/auth/calendar.events');

/**
 * The account's Google grant, opened here: { email, scopes, gmail(), calendar() }. Access
 * tokens refresh as the Worker's do (google-data.js tokenSource) and are saved back onto the
 * same grant; a refresh token Google refuses removes the grant. Throws GoogleError
 * `not_connected` when there's none.
 */
export async function googleInAccount(account, { local: isLocal = false } = {}) {
  const env = account.env;
  const id = ((await account.storage.get('account')) || {}).id;
  const record = id ? await account.storage.get(TOKEN_RECORD) : null;
  const tokens = record ? await openTokens(env, id, record) : null;
  if (!tokens || !tokens.refresh) throw new GoogleError('Google isn’t connected to Eden any more: connect it again in Mail.', 'not_connected', 409);
  const f = backgroundFetch(env, isLocal);
  const client = { clientId: String(env.GOOGLE_CLIENT_ID || ''), clientSecret: String(env.GOOGLE_CLIENT_SECRET || '') };
  let refreshing = null;
  const token = async (fresh) => {
    if (!fresh && tokens.access && tokens.access_exp - 60_000 > Date.now()) return tokens.access;
    refreshing ??= (async () => {
      try {
        const r = await refreshAccessToken(client, tokens.refresh, f);
        Object.assign(tokens, { access: r.accessToken, access_exp: r.expiresAt, refresh: r.refreshToken || tokens.refresh });
        const current = await account.storage.get(TOKEN_RECORD);
        if (current && current.gen === record.gen) await account.storage.put(TOKEN_RECORD, { ...current, ...(await sealTokens(env, id, tokens)), at: account.now() });
        return r.accessToken;
      } catch (e) {
        if (e instanceof GoogleError && e.code === 'reconnect') {
          const current = await account.storage.get(TOKEN_RECORD);
          if (current && current.gen === record.gen) await account.storage.delete(TOKEN_RECORD);
        }
        throw e;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  };
  return {
    email: tokens.email || null,
    scopes: tokens.scopes || [],
    gmail: () => createGmailApi({ token, fetch: f }),
    calendar: () => createCalendarApi({ token, fetch: f }),
  };
}

// ── scheduled Gmail sends ──

export const MAIL = { graceMs: 12 * 3600_000, attempts: 3, keepMs: 30 * 86400_000, staleMs: 10 * 60_000, waiting: 100, aheadMs: 367 * 86400_000 };
const JOB_ID = /^[0-9a-f]{24}$/;
const GMAIL_ID = /^[0-9A-Za-z_-]{1,128}$/;
const iso = (ms) => new Date(ms).toISOString();
const mailKey = (id) => `smail:${id}`;

/** A job as the page sees it (gmail.ts ScheduledJob). */
const jobView = ({ local: _local, sendingAt: _s, ...job }) => job;

/** Cut off mid-send long enough ago: it may or may not have gone. */
function settle(job, now) {
  if (job.status === 'sending' && now - (job.sendingAt || 0) > MAIL.staleMs) {
    return { ...job, status: 'unknown', error: 'Eden was interrupted while sending this, so it may or may not have gone. Check Sent in Gmail before sending it again.' };
  }
  return job;
}

async function allMailJobs(account) {
  const now = account.now();
  const out = [];
  for (const [key, raw] of await account.storage.list({ prefix: 'smail:' })) {
    const job = settle(raw, now);
    if (job !== raw) await account.storage.put(key, job);
    const end = Date.parse(job.sentAt || job.sendAt);
    if (!['scheduled', 'sending'].includes(job.status) && Number.isFinite(end) && now - end > MAIL.keepMs) {
      await account.storage.delete(key);
      continue;
    }
    out.push(job);
  }
  return out.sort((a, b) => a.sendAt.localeCompare(b.sendAt));
}

const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const nullableText = (v, max) => (typeof v === 'string' && v ? v.slice(0, max) : null);

async function mailSchedule(account, input, isLocal) {
  const now = account.now();
  const id = String(input.id || '');
  const draftId = String(input.draftId || '');
  const sendAt = Date.parse(input.sendAt);
  if (!JOB_ID.test(id) || !GMAIL_ID.test(draftId)) throw new ApiError(400, 'bad_request', 'A scheduled send needs its id and the draft’s id.');
  if (!Number.isFinite(sendAt) || sendAt < now - 60_000) throw new ApiError(400, 'bad_request', 'Pick a time in the future.');
  if (sendAt > now + MAIL.aheadMs) throw new ApiError(400, 'bad_request', 'Pick a time within a year.');
  const existing = await account.storage.get(mailKey(id));
  if (existing && existing.status !== 'scheduled') {
    throw new ApiError(409, 'conflict', existing.status === 'sending' ? 'It is being sent right now.' : 'That scheduled send has already finished.');
  }
  const jobs = await allMailJobs(account);
  if (!existing && jobs.filter((j) => j.status === 'scheduled' || j.status === 'sending').length >= MAIL.waiting) {
    throw new ApiError(429, 'slow_down', `At most ${MAIL.waiting} emails can wait to be sent at once.`);
  }
  const job = {
    id,
    draftId,
    threadId: nullableText(input.threadId, 128),
    account: nullableText(input.account, 320),
    to: Array.isArray(input.to) ? input.to.filter((x) => typeof x === 'string').slice(0, 100).map((x) => x.slice(0, 320)) : [],
    subject: text(input.subject, 300),
    sendAt: iso(sendAt),
    createdAt: (existing && existing.createdAt) || iso(now),
    status: 'scheduled',
    attempts: 0,
    nextTryAt: null,
    sentAt: null,
    messageId: null,
    error: null,
    local: Boolean(isLocal),
  };
  await account.storage.put(mailKey(id), job);
  await scheduleJob(account, `mail:${id}`, 'mail', sendAt);
  return job;
}

async function mailRelease(account, draftId, why) {
  for (const job of await allMailJobs(account)) {
    if (job.draftId === draftId && job.status === 'scheduled') {
      await account.storage.put(mailKey(job.id), { ...job, status: 'cancelled', error: text(why, 200) || null, nextTryAt: null });
      await unscheduleJob(account, `mail:${job.id}`);
    }
  }
}

async function mailCancel(account, id) {
  const raw = JOB_ID.test(String(id)) ? await account.storage.get(mailKey(id)) : null;
  if (!raw) throw new ApiError(404, 'not_found', 'No scheduled send with that id.');
  const job = settle(raw, account.now());
  if (job.status === 'sending') throw new ApiError(409, 'conflict', 'It is being sent right now.');
  if (job.status === 'sent') throw new ApiError(409, 'conflict', 'It was already sent.');
  const out = { ...job, status: 'cancelled', error: null, nextTryAt: null };
  await account.storage.put(mailKey(id), out);
  await unscheduleJob(account, `mail:${id}`);
  return out;
}

/**
 * account.js: `if (op.startsWith('mail-')) return json(await mailOp(this, op, body));` (after
 * the device is checked). The Worker side is eden/google-data.js.
 *   mail-jobs                          → { jobs }   soonest first
 *   mail-apply { ops: [{ op: 'schedule', job } | { op: 'release', draftId, why }], local } → { jobs: [the scheduled ones] }
 *   mail-cancel { id }                 → { job }
 */
export async function mailOp(account, op, body) {
  switch (op) {
    case 'mail-jobs':
      return { jobs: (await allMailJobs(account)).map(jobView) };
    case 'mail-apply': {
      const ops = Array.isArray(body.ops) ? body.ops.slice(0, 20) : [];
      const done = [];
      for (const o of ops) {
        if (o && o.op === 'schedule' && o.job) done.push(jobView(await mailSchedule(account, o.job, body.local === true)));
        else if (o && o.op === 'release' && GMAIL_ID.test(String(o.draftId || ''))) await mailRelease(account, String(o.draftId), o.why);
      }
      return { jobs: done };
    }
    case 'mail-cancel':
      return { job: jobView(await mailCancel(account, body.id)) };
    default:
      throw new ApiError(404, 'not_found', 'No such thing.');
  }
}

/** The alarm's `mail` handler: sends one scheduled draft (or says why not). */
export async function mailDue(account, entry) {
  const id = entry.key.slice('mail:'.length);
  const raw = await account.storage.get(mailKey(id));
  if (!raw) return undefined;
  const now = account.now();
  const job = settle(raw, now);
  const save = (patch) => account.storage.put(mailKey(id), { ...job, ...patch });
  if (job !== raw) {
    await save({});
    return undefined;
  }
  if (job.status !== 'scheduled') return undefined;
  if (job.nextTryAt && Date.parse(job.nextTryAt) > now) return Date.parse(job.nextTryAt);
  if (Date.parse(job.sendAt) > now) return Date.parse(job.sendAt);
  if (now - Date.parse(job.sendAt) > MAIL.graceMs) {
    await save({ status: 'missed', error: 'It couldn’t be sent at the scheduled time, so it wasn’t sent. It is still in Drafts: send it now or pick a new time.' });
    return undefined;
  }
  let google;
  try {
    google = await googleInAccount(account, { local: job.local });
  } catch (e) {
    if (e instanceof GoogleError) {
      await save({ status: 'failed', error: `${e.message} It wasn’t sent; it is still in Drafts.` });
      return undefined;
    }
    throw e;
  }
  if (job.account && google.email && job.account.toLowerCase() !== google.email.toLowerCase()) {
    await save({ status: 'failed', error: 'Gmail is now connected to a different account, so Eden didn’t send it.' });
    return undefined;
  }
  const attempts = job.attempts + 1;
  await save({ status: 'sending', attempts, sendingAt: now });
  try {
    const sent = await google.gmail().sendDraft(job.draftId);
    await save({ status: 'sent', attempts, sentAt: iso(account.now()), messageId: (sent && sent.id) || null, error: null, nextTryAt: null, sendingAt: null });
    return undefined;
  } catch (e) {
    const g = e instanceof GoogleError ? e : null;
    if (g && (g.code === 'rate_limited' || g.code === 'upstream') && attempts < MAIL.attempts) {
      const wait = g.retryAfter !== undefined ? g.retryAfter * 1000 : 2 * 60_000 * attempts;
      const next = account.now() + wait;
      await save({ status: 'scheduled', attempts, nextTryAt: iso(next), error: g.message, sendingAt: null });
      return next;
    }
    if (g && g.code === 'not_found') {
      await save({ status: 'failed', attempts, error: 'The draft is no longer in Gmail (sent or deleted there), so there was nothing to send.', sendingAt: null });
    } else {
      await save({ status: 'failed', attempts, error: g ? g.message : 'Sending failed.', sendingAt: null });
      if (!g) console.error('scheduled send failed', e && (e.stack || e.message));
    }
    return undefined;
  }
}
