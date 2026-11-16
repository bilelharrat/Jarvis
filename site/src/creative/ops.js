// The account object's side of the Creative Suite (docs/creative-api.md): every `creative-*` op takes the app's scoped
// token ({ id, secret }, accounts/scoped.js tokenCaller: its secret's SHA-256 compared in constant time, an expired one
// gone) and only a `creative` one. account.js sends them here before its device check; the Worker (api.js) never
// decides who may do what.
//
//   creative-me          the account's name, plan, allowance, voice and this connection (works without Plus)
//   creative-check       the token and Plus, nothing else (the costly routes ask it first)
//   creative-allow       what the AI allowance may spend now (Plus only): account.allowAi
//   creative-hold        a hold on it for one turn's worst case (Plus only): account.holdAi, EDEN_TURNS at once
//   creative-quote       a priced spec kept 10 minutes, once (Plus only)
//   creative-job         a quote turned into a job (Plus only): video started on Veo, speech counted on the voice
//   creative-job-get     a job, as the app sees it
//   creative-job-result  a finished item's bytes (base64)
//
// Jobs run on the account's one alarm (schedule.js, kind `creative`): `cjob:<id>` is a job's next step (a Veo poll, a
// few lines read aloud), `cjobx:<id>` its expiry. A result is kept in pieces (`cres:<id>:<item>:<n>`) for MEDIA.keepMs.

import { ApiError, randomBytes } from '../accounts/util.js';
import { tokenCaller } from '../accounts/scoped.js';
import { allowances } from '../accounts/account.js';
import { scheduleJob, unscheduleJob } from '../accounts/schedule.js';
import { LABEL, MEDIA, fishSpeech, generationStatus, veoPoll, veoStart, videoUSD, voiceCeiling } from './media.js';

export const PLUS_WORDS = 'Eden in the Creative Suite is part of Eden Plus. Editing works without it.';
const NOT_CREATIVE = () => new ApiError(403, 'forbidden', 'This connection isn’t for the Creative Suite.');
const hex = (n) => [...randomBytes(n)].map((b) => b.toString(16).padStart(2, '0')).join('');
const JOB_ID = /^[0-9a-f]{24}$/;
const round6 = (x) => Math.round(x * 1e6) / 1e6;

async function creativeCaller(account, body) {
  const token = await tokenCaller(account, body || {});
  if (token.client !== 'creative' || token.scope !== 'creative') throw NOT_CREATIVE();
  return token;
}

async function plusOnly(account) {
  const plan = await account.planNow();
  if (!plan.active) throw new ApiError(402, 'plus_required', PLUS_WORDS);
  return plan;
}

const connectionView = (t) => ({ id: t.id, app: t.app || null, created: t.created, expires_at: t.expires, last_used: t.last_used || null });

/** account.js: `if (op.startsWith('creative-')) return json(await creativeOp(this, op, body));` */
export async function creativeOp(account, op, body) {
  const token = await creativeCaller(account, body);
  switch (op) {
    case 'creative-me':
      return me(account, token);
    case 'creative-check': // the token and Plus, before a costly route reads its body
      await plusOnly(account);
      return { ok: true };
    case 'creative-allow':
      await plusOnly(account);
      return account.allowAi();
    case 'creative-hold':
      await plusOnly(account);
      return account.holdAi({ usd: body.usd });
    case 'creative-quote':
      await plusOnly(account);
      return quote(account, token, body.quote);
    case 'creative-job':
      await plusOnly(account);
      return startJob(account, token, body);
    case 'creative-job-get':
      return jobView(await ownJob(account, token, body.job));
    case 'creative-job-result':
      return result(account, await ownJob(account, token, body.job), body.item);
    default:
      throw new ApiError(404, 'not_found', 'No such thing.');
  }
}

async function me(account, token) {
  const acct = await account.storage.get('account');
  const plan = await account.planNow();
  const usage = await account.usageNow();
  const budget = plan.active ? await account.plusCap(plan) : 0;
  const allow = await account.allowAi();
  const email = (await account.identities()).map((i) => i.email).find(Boolean) || null;
  const caps = allowances(account.env);
  const voice = (await account.storage.get('voice')) || {};
  const today = new Date(account.now()).toISOString().slice(0, 10);
  return {
    account: { id: acct.id, name: email, email },
    plus: Boolean(plan.active),
    plan: { name: plan.active ? 'plus' : 'free', unlimited: Boolean(plan.unlimited), renews: plan.renews ?? null, expires: plan.expires || null },
    allowance: {
      period_start: Date.parse(`${usage.month}-01T00:00:00Z`),
      period_end: nextMonth(usage.month),
      budget_usd: budget,
      used_usd: round6(usage.spent),
      left_usd: round6(Math.max(0, budget - usage.spent)),
      credits_usd: round6(Number(allow.credits_usd) || 0),
    },
    voice: { today_chars: voice.day === today ? voice.chars : 0, daily_chars: plan.active ? caps.voicePlus : caps.voiceFree },
    connection: connectionView(token),
    generation: generationStatus(account.env),
  };
}

const nextMonth = (key) => {
  const [y, m] = key.split('-').map(Number);
  return Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1);
};

// ── quotes ──

async function quote(account, token, q) {
  if (!q || typeof q !== 'object' || !['video', 'speech'].includes(q.kind) || !/^[0-9a-f]{64}$/.test(String(q.hash || ''))) throw new ApiError(400, 'bad_request', 'No quote to keep.');
  const now = account.now();
  let allowanceLeft = null;
  let voiceLeft = null;
  if (q.kind === 'video') {
    const allow = await account.allowAi();
    if (!allow.ok) throw new ApiError(402, 'no_allowance', allow.why);
    if (!(allow.left >= q.usd)) throw new ApiError(402, 'no_allowance', 'Not enough of this month’s Plus AI allowance is left for this clip. It starts again on the 1st, or add credits in Settings › Account.');
    allowanceLeft = round6(allow.left);
  } else {
    voiceLeft = await voiceLeftToday(account);
    if (q.chars > voiceLeft) throw new ApiError(402, 'no_allowance', 'Not enough of today’s voice allowance is left for these lines; it resets at midnight UTC.');
  }
  // expired quotes go; at most 20 waiting
  const waiting = [...(await account.storage.list({ prefix: 'cquote:' })).entries()];
  for (const [key, old] of waiting) if (old.expires <= now) await account.storage.delete(key);
  if (waiting.filter(([, old]) => old.expires > now).length >= 20) throw new ApiError(429, 'slow_down', 'Too many prices asked for at once; wait a few minutes.', { 'retry-after': '60' });
  const id = hex(12);
  const kept = { id, token: token.id, kind: q.kind, hash: q.hash, usd: q.usd, chars: q.chars || 0, model: q.model, model_name: q.model_name, seconds: q.seconds ?? null, fallbacks: q.fallbacks || [], expires: now + MEDIA.quoteMs };
  await account.storage.put(`cquote:${id}`, kept);
  return {
    quote_id: id,
    kind: q.kind,
    model: q.model,
    model_name: q.model_name,
    seconds: q.seconds ?? null,
    usd: q.usd,
    allowance_left_usd: allowanceLeft,
    chars: q.chars || 0,
    voice_left_chars: voiceLeft,
    expires_at: kept.expires,
    label: LABEL,
  };
}

async function voiceLeftToday(account) {
  const plan = await account.planNow();
  const caps = allowances(account.env);
  const voice = (await account.storage.get('voice')) || {};
  const today = new Date(account.now()).toISOString().slice(0, 10);
  return Math.max(0, (plan.active ? caps.voicePlus : caps.voiceFree) - (voice.day === today ? voice.chars : 0));
}

// ── jobs ──

async function liveJobs(account) {
  return [...(await account.storage.list({ prefix: 'cjob:' })).values()].sort((a, b) => a.created - b.created);
}

async function ownJob(account, token, id) {
  if (!JOB_ID.test(String(id || ''))) throw new ApiError(404, 'not_found', 'No such job.');
  const job = await account.storage.get(`cjob:${id}`);
  if (!job || job.token !== token.id || job.expires <= account.now()) throw new ApiError(404, 'not_found', 'No such job (jobs are kept for a day).');
  return job;
}

function jobView(job) {
  const done = job.status === 'succeeded';
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    progress: done ? 1 : job.kind === 'speech' ? Math.round((job.done / job.lines.length) * 100) / 100 : Math.min(0.95, Math.round(((job.updated - job.created) / MEDIA.videoExpectMs) * 100) / 100),
    created_at: job.created,
    updated_at: job.updated,
    expires_at: job.expires,
    model: job.model,
    model_name: job.model_name,
    usd: job.usd,
    label: LABEL,
    result: done ? { items: job.items.map((it) => ({ index: it.index, url: `/api/creative/jobs/${job.id}/result?item=${it.index}`, mime: it.mime, bytes: it.bytes })) } : null,
    error: job.error || null,
  };
}

/** A job from its quote (the Worker checked the spec and sends its hash; a video's spec comes along to start it). */
async function startJob(account, token, { quote_id: quoteId, hash, spec }) {
  const now = account.now();
  if (!/^[0-9a-f]{24}$/.test(String(quoteId || ''))) throw new ApiError(400, 'bad_request', 'quote_id is the id from the quote.');
  const q = await account.storage.get(`cquote:${quoteId}`);
  if (!q || q.token !== token.id) throw new ApiError(409, 'quote_used', 'That price was used already, or isn’t this app’s. Ask for a new one.');
  if (q.expires <= now) {
    await account.storage.delete(`cquote:${quoteId}`);
    throw new ApiError(409, 'quote_expired', 'That price ran out (prices hold 10 minutes). Ask for a new one.');
  }
  if (q.hash !== hash || !spec || spec.kind !== q.kind) throw new ApiError(400, 'bad_request', 'The job isn’t what was priced. Send exactly what was priced, or ask for a new price.');
  const jobs = await liveJobs(account);
  if (jobs.filter((j) => j.status === 'running').length >= MEDIA.running) throw new ApiError(429, 'slow_down', `${MEDIA.running} generations are running already; wait for one to finish.`, { 'retry-after': '30' });
  await account.storage.delete(`cquote:${quoteId}`); // used: once
  // the oldest finished (then expired) go past the limit
  for (const old of jobs.filter((j) => j.status !== 'running' || j.expires <= now).slice(0, Math.max(0, jobs.length - (MEDIA.jobs - 1)))) await dropJob(account, old);

  const job = { id: hex(12), token: token.id, kind: q.kind, status: 'running', created: now, updated: now, expires: now + MEDIA.keepMs, model: q.model, model_name: q.model_name, usd: q.usd, items: [], error: null };
  if (q.kind === 'speech') {
    // counted first, as the site's voice is (worker.js voice): this account's day, then everyone's
    const took = await account.voice({ chars: q.chars });
    if (!took.ok) throw new ApiError(402, 'no_allowance', took.why);
    const everyone = await takeCeiling(account, q.chars);
    if (!everyone.ok) throw new ApiError(429, 'slow_down', everyone.why, { 'retry-after': String(everyone.retryAfter || 3600) });
    Object.assign(job, { lines: spec.lines.map((l) => l.text), done: 0, tries: 0 });
    await account.storage.put(`cjob:${job.id}`, job);
    await scheduleJob(account, `cjob:${job.id}`, 'creative', now);
    return jobView(job);
  }
  const hold = await account.holdAi({ usd: q.usd });
  if (!hold.ok) throw new ApiError(402, 'no_allowance', hold.why);
  Object.assign(job, { hold: hold.hold, bucket: hold.bucket, seconds: q.seconds, quoted: q.usd, deadline: now + MEDIA.videoDeadlineMs });
  let started = null;
  for (const model of [q.model, ...q.fallbacks]) {
    started = await veoStart(account.env, model, spec);
    if (started.ok) {
      if (model !== q.model) Object.assign(job, { model, model_name: modelName(model), usd: Math.min(q.usd, videoUSD(model, q.seconds)) });
      break;
    }
    if (!started.retryable) break;
  }
  if (!started.ok) {
    account.release({ hold: hold.hold });
    Object.assign(job, { status: 'failed', error: { code: 'upstream', message: started.message }, usd: 0 });
    await account.storage.put(`cjob:${job.id}`, job);
    await scheduleJob(account, `cjobx:${job.id}`, 'creative', job.expires);
    return jobView(job);
  }
  job.op = started.op;
  await account.storage.put(`cjob:${job.id}`, job);
  await scheduleJob(account, `cjob:${job.id}`, 'creative', now + pollMs(account.env));
  return jobView(job);
}

const MODEL_NAMES = { 'veo-3.0-fast-generate-001': 'Veo 3 Fast', 'veo-3.0-generate-001': 'Veo 3', 'veo-2.0-generate-001': 'Veo 2' };
const modelName = (id) => MODEL_NAMES[id] || 'Veo';
const pollMs = (env) => (Number(env.EDEN_VIDEO_POLL_MS) >= 0 && env.EDEN_VIDEO_POLL_MS !== undefined && env.EDEN_VIDEO_POLL_MS !== '' ? Number(env.EDEN_VIDEO_POLL_MS) : 3000);

/** The site's daily voice ceiling for everyone (worker.js VoiceQuota): one object, so the check-and-add is atomic. */
async function takeCeiling(account, chars) {
  const quota = account.env.VOICE_QUOTA;
  if (!quota) return { ok: false, why: 'The Eden voice isn’t set up here yet.' };
  const me = await account.storage.get('account');
  const res = await quota.get(quota.idFromName('daily')).fetch('https://quota/take', {
    method: 'POST',
    body: JSON.stringify({ install: `a:${me.id}`, network: 'creative', chars, limits: { install: 1e12, network: 1e12, everyone: voiceCeiling(account.env) } }),
  });
  return res.json();
}

async function result(account, job, item) {
  const index = Number(item ?? 0);
  const it = job.status === 'succeeded' && Number.isInteger(index) ? job.items.find((x) => x.index === index) : null;
  if (!it) throw new ApiError(404, 'not_found', job.status === 'succeeded' ? 'No such item.' : 'It isn’t ready yet.');
  const keys = Array.from({ length: it.parts }, (_, n) => `cres:${job.id}:${index}:${n}`);
  let data = '';
  for (let i = 0; i < keys.length; i += 100) {
    const got = await account.storage.get(keys.slice(i, i + 100));
    for (const key of keys.slice(i, i + 100)) data += got.get(key) ?? '';
  }
  return { mime: it.mime, data };
}

async function storeItem(account, job, index, mime, data) {
  const parts = Math.max(1, Math.ceil(data.length / MEDIA.chunk));
  const entries = {};
  for (let n = 0; n < parts; n++) entries[`cres:${job.id}:${index}:${n}`] = data.slice(n * MEDIA.chunk, (n + 1) * MEDIA.chunk);
  const keys = Object.keys(entries);
  for (let i = 0; i < keys.length; i += 100) await account.storage.put(Object.fromEntries(keys.slice(i, i + 100).map((k) => [k, entries[k]])));
  job.items.push({ index, mime, bytes: Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0), parts });
}

async function dropJob(account, job) {
  const keys = [`cjob:${job.id}`];
  for (const it of job.items || []) for (let n = 0; n < it.parts; n++) keys.push(`cres:${job.id}:${it.index}:${n}`);
  for (let i = 0; i < keys.length; i += 128) await account.storage.delete(keys.slice(i, i + 128));
  await unscheduleJob(account, `cjob:${job.id}`);
  await unscheduleJob(account, `cjobx:${job.id}`);
  if (job.hold) account.release({ hold: job.hold });
}

// ── the alarm ──

/** schedule.js handler for kind `creative`: → the next time this job wants to run, or undefined. */
export async function creativeDue(account, entry) {
  const [kind, id] = String(entry.key).split(':');
  const job = JOB_ID.test(String(id || '')) ? await account.storage.get(`cjob:${id}`) : null;
  if (!job) return undefined;
  if (kind === 'cjobx') {
    await dropJob(account, job);
    return undefined;
  }
  if (job.status !== 'running') return undefined;
  return job.kind === 'video' ? videoStep(account, job) : speechStep(account, job);
}

async function finish(account, job, fields) {
  Object.assign(job, fields, { updated: account.now() });
  if (job.hold) {
    account.release({ hold: job.hold });
    delete job.hold;
  }
  await account.storage.put(`cjob:${job.id}`, job);
  await scheduleJob(account, `cjobx:${job.id}`, 'creative', job.expires);
  return undefined;
}

async function videoStep(account, job) {
  const now = account.now();
  if (now > job.deadline) return finish(account, job, { status: 'failed', usd: 0, error: { code: 'upstream', message: 'Google Veo took too long to make the clip. Nothing was charged. Try again.' } });
  const look = await veoPoll(account.env, job.op);
  if (!look.ok && !look.retryable) return finish(account, job, { status: 'failed', usd: 0, error: { code: 'upstream', message: `${look.message} Nothing was charged.` } });
  if (!look.ok || !look.done) {
    job.updated = now;
    await account.storage.put(`cjob:${job.id}`, job);
    return now + pollMs(account.env);
  }
  await storeItem(account, job, 0, look.clip.mime, look.clip.data);
  // what it cost, never more than the quote: the Plus allowance's provider dollars (account.js spend)
  if (job.usd > 0) await account.spend({ usd: job.usd, bucket: job.bucket, meta: { feature: 'creative-video', product: 'creative', model: job.model, seconds: job.seconds } });
  return finish(account, job, { status: 'succeeded' });
}

async function speechStep(account, job) {
  const started = Date.now();
  while (job.done < job.lines.length && Date.now() - started < MEDIA.speechTickMs) {
    const said = await fishSpeech(account.env, job.lines[job.done]);
    if (!said.ok) {
      job.tries = (job.tries || 0) + 1;
      if (!said.retryable || job.tries >= 3) return finish(account, job, { status: 'failed', error: { code: 'upstream', message: `Line ${job.done + 1}: ${said.message}` } });
      job.updated = account.now();
      await account.storage.put(`cjob:${job.id}`, job);
      return account.now() + 5000;
    }
    await storeItem(account, job, job.done, said.mime, said.data);
    job.done += 1;
    job.tries = 0;
    job.updated = account.now();
    await account.storage.put(`cjob:${job.id}`, job);
  }
  if (job.done >= job.lines.length) return finish(account, job, { status: 'succeeded' });
  return account.now(); // more lines: straight on
}

