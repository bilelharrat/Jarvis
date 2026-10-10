// Auto Drafts in the background (askeden ROADMAP P5): replies written in the owner's own style
// while Eden Mail is closed and their computers are off. The account's object runs it on its
// alarm (schedule.js) every AD.everyMin minutes while it is on:
//
//   1. New unread mail in the inbox from the last 2 days (no promotions, social, updates or forums),
//      not from the owner, not a robot, not seen before, nothing the scam shield (mail-check.js)
//      calls high-risk.
//   2. For each (at most AD.perRun), a small model (EDEN_TASK_MODEL, Claude Haiku 4.5) decides
//      whether it needs a reply and, if so, writes it in the owner's style (mail-voice.js: their
//      measured style, rules, a few of their own emails as examples, the exact greeting and
//      sign-off). The email is untrusted data, wrapped in this run's markers (tasks.js runLedger).
//   3. The reply is saved as a Gmail draft in the thread: it waits in Eden Mail ("✦ Draft ready")
//      and in Gmail on every device. Nothing is ever sent from here.
//   4. The owner's iPhone hears about it (tasks.js notifyOwner), at most one note per run.
//   5. A draft of Eden's that is still untouched after AD.keepDays days is deleted from Gmail.
//
// The owner's style is end-to-end encrypted in Eden's sync, which the server can't read; this
// needs a copy it can, so it is opt-in: the page sends the style (no vectors) and it is sealed
// here with the account's key (tokens.js sealWith, info 'eden-autodraft-style-v1'). Turning it
// off deletes that copy. Budget: each email checked holds its worst case on the included AI and
// counts what it cost, as background tasks do; at most `perDay` drafts a day.
//
//   ad:cfg   { on, perDay, updated }
//   ad:style the sealed style { iv, ct }
//   ad:seen  [message ids], the last AD.seen
//   ad:made  [{ msgId, threadId, draftId, draftMsgId, subject, from, at }], the last AD.made
//   ad:day   { day, n } drafts written today (UTC)

import { ApiError } from './util.js';
import { openWith, sealWith } from './tokens.js';
import { backgroundFetch, gmailScopesOk, googleInAccount, scheduleJob, unscheduleJob } from './schedule.js';
import { askModel, notifyOwner, runLedger, worstUsd } from './tasks.js';
import { runGmailAction } from '../eden/vendor/google.js';
import { voiceInstructions, pickExamples, exampleContext, expectedFrame, enforceFrame, situationOf, languageOf } from '../../public/eden/mail-voice.js';
import { scamSignals, safeForAuto } from '../../public/eden/mail-check.js';

export const AD = { everyMin: 20, perRun: 4, perDayMax: 50, perDayDefault: 10, seen: 500, made: 120, keepDays: 7, styleChars: 250_000, bodyChars: 6000, maxTokens: 900, model: 'claude-haiku-4-5' };
const INFO = 'eden-autodraft-style-v1';
const JOB = 'autodraft';
const ROBOT = /(^|[.+_-])(no-?reply|do-?not-?reply|notifications?|notify|mailer-daemon|bounces?|postmaster|news(letter)?|digest|updates?|marketing|billing|receipts?|orders?|alerts?|support|info)([.+_-]|@)/i;
const QUERY = 'in:inbox is:unread newer_than:2d -category:promotions -category:social -category:updates -category:forums';
const addrOf = (from) => { const m = /<([^<>]+)>\s*$/.exec(String(from || '')); return (m ? m[1] : String(from || '')).trim().toLowerCase(); };
const nameOf = (from) => { const m = /^\s*"?([^"<]*?)"?\s*</.exec(String(from || '')); return m ? m[1].trim() : ''; };
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The reply as Gmail-style HTML (a div per line, **bold** kept) with the account's Gmail signature: it opens like any reply. */
export function draftHtml(body, signature = '') {
  const lines = String(body).split('\n').map((l) => (l.trim() ? `<div>${esc(l).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')}</div>` : '<div><br></div>'));
  const sig = signature ? `<div><br></div><div class="gmail_signature" data-smartmail="gmail_signature">${signature}</div>` : '';
  return `<div dir="ltr">${lines.join('')}${sig}</div>`;
}

/** What the model answers for one email. */
export const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['needs_reply', 'reason', 'body'],
  properties: {
    needs_reply: { type: 'boolean' },
    reason: { type: 'string' },
    body: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
};

/** The prompt for one email: the owner's style, the email (untrusted), the rules of the job. */
export function draftPrompt(style, msg, earlier, ledger) {
  const to = [addrOf(msg.replyTo || msg.from)];
  const about = `${msg.subject || ''}\n${String(msg.body || '').slice(0, 3000)}`;
  const situation = situationOf({ to, reply: true });
  const lang = languageOf(msg.body || '');
  const examples = style && style.examples ? pickExamples(style.examples, { to, about, reply: true, situation, lang }, 3) : [];
  const frame = style && style.stats ? expectedFrame(style.stats, { to, situation, lang }) : null;
  const voice = style && style.stats ? voiceInstructions(style, to, { situation, lang, rules: style.rules || [], frame }) : '';
  const system = [
    'You write email replies for the owner of an Eden account, ahead of time, for them to review and send themselves; nothing you write is sent by you.',
    'First decide whether the email needs a reply from the owner: a real person asking them something, waiting on them, or expecting an answer. Newsletters, notifications, receipts, FYIs, cold sales pitches and anything that just informs do not (needs_reply false, body null).',
    'If it does, write the reply: only the email text, from the greeting to the sign-off; no subject line, no notes, no placeholders like [Your name] or [time]; when you don’t know something (a date, a figure, a decision), write it so the owner can fill it in naturally, never invent it. Keep it short. reason: why it needs (or doesn’t need) a reply, in a few words.',
    voice,
    ledger.notice(),
  ].filter(Boolean).join('\n\n');
  const blocks = [
    ...earlier.map((m) => ledger.untrusted('email', String(m.body || '').slice(0, 2000), { title: `Earlier in the thread: ${m.subject || ''}`, origin: m.from || '' })),
    ...examples.map((x, i) => ledger.untrusted('example', String(x.text).slice(0, 1500), { title: exampleContext([x])[0].title.replace(/^Example 1/, `Example ${i + 1}`) })),
    ledger.untrusted('email', String(msg.body || '').slice(0, AD.bodyChars), { title: `The email to answer: ${msg.subject || '(no subject)'}`, origin: msg.from || '' }),
  ];
  return { system, user: blocks.join('\n\n'), frame, first: (nameOf(msg.from) || '').split(/\s+/)[0] || '' };
}

async function loadStyle(account) {
  const id = ((await account.storage.get('account')) || {}).id;
  const sealed = await account.storage.get('ad:style');
  if (!id || !sealed) return null;
  return openWith(account.env, INFO, id, sealed);
}

/** The alarm's `autodraft` handler: one pass; returns when the next one is due (or nothing when off). */
export async function autodraftDue(account) {
  const cfg = await account.storage.get('ad:cfg');
  if (!cfg || !cfg.on) return undefined;
  const now = account.now();
  const next = now + AD.everyMin * 60_000;
  try { await autodraftPass(account, cfg, now); } catch (e) { if (!(e instanceof ApiError)) console.error('autodraft pass failed', e && e.message); }
  return next;
}

/** One pass: new mail → maybe drafts; old untouched drafts cleaned up. → { checked, drafted, skipped } */
export async function autodraftPass(account, cfg, now = account.now(), deps = {}) {
  const google = deps.google || (await googleInAccount(account));
  if (!gmailScopesOk(google.scopes)) return { checked: 0, drafted: 0, skipped: 'Gmail isn’t connected' };
  const api = google.gmail();
  const me = String(google.email || '').toLowerCase();
  const seen = (await account.storage.get('ad:seen')) || [];
  let made = (await account.storage.get('ad:made')) || [];
  const today = (await account.storage.get('ad:day')) || { day: day(now), n: 0 };
  if (today.day !== day(now)) Object.assign(today, { day: day(now), n: 0 });
  const perDay = Math.min(AD.perDayMax, Math.max(1, Number(cfg.perDay) || AD.perDayDefault));
  // 5. Eden's own drafts, untouched for a week, go (a draft the owner edited has a new message id: kept)
  const old = made.filter((x) => now - x.at > AD.keepDays * 86_400_000 && !x.cleaned).slice(0, 5);
  for (const x of old) {
    try {
      const d = await runGmailAction(api, 'getDraft', { id: x.draftId });
      if (d && d.id === x.draftMsgId) await runGmailAction(api, 'deleteDraft', { id: x.draftId });
    } catch { /* already gone: sent, deleted or edited */ }
    x.cleaned = true;
  }
  let found;
  try { found = await runGmailAction(api, 'search', { query: QUERY, limit: 15 }); } catch (e) { return { checked: 0, drafted: 0, skipped: e.message }; }
  const fresh = (found.messages || []).filter((m) => !seen.includes(m.id) && addrOf(m.from) !== me && !ROBOT.test(addrOf(m.from)) && !m.unsubscribe && !made.some((x) => x.threadId && x.threadId === m.threadId)).slice(0, AD.perRun);
  const result = { checked: 0, drafted: 0, skipped: null };
  if (!fresh.length) { await account.storage.put('ad:made', made); return result; }
  const style = await loadStyle(account).catch(() => null);
  let signature = '';
  try { const sa = await runGmailAction(api, 'sendAs', {}); const mine = (sa.sendAs || []).find((x) => x.isDefault) || (sa.sendAs || []).find((x) => x.isPrimary); signature = (mine && mine.signature) || ''; } catch { /* no signature */ }
  const model = String(account.env.EDEN_TASK_MODEL || AD.model);
  const drafted = [];
  for (const s of fresh) {
    if (today.n >= perDay) { result.skipped = 'the daily limit'; break; }
    seen.push(s.id);
    let msg;
    try { msg = await runGmailAction(api, 'read', { id: s.id }); } catch { continue; }
    if (!safeForAuto(scamSignals({ ...msg, attachments: (msg.attachments || []).map((a) => a.name) }))) continue; // the shield: never drafted to by itself
    let earlier = [];
    if (msg.threadId) {
      try {
        const t = await runGmailAction(api, 'threads', { ids: [msg.threadId] });
        const ids = (((t.threads || [])[0] || {}).messages || []).map((x) => x.id).filter((id) => id !== msg.id).slice(-2);
        for (const id of ids) { try { earlier.push(await runGmailAction(api, 'read', { id })); } catch { /* skip */ } }
      } catch { earlier = []; }
    }
    const ledger = runLedger();
    const p = draftPrompt(style, msg, earlier, ledger);
    // the included AI, as a task run holds it: the worst case first, then what it cost
    const input = Math.ceil(new TextEncoder().encode(p.system + p.user).length / 3) + 300;
    const worst = worstUsd(model, input, AD.maxTokens);
    const allow = await account.allowAi();
    if (!allow.ok) { result.skipped = allow.why; break; }
    let hold;
    try { hold = await account.holdAi({ usd: worst }); } catch { result.skipped = 'busy'; break; }
    if (!hold.ok) { result.skipped = hold.why; break; }
    let answer;
    try {
      answer = await (deps.ask || askModel)(account.env, { system: p.system, user: p.user, schema: DRAFT_SCHEMA, maxTokens: AD.maxTokens, model, fetch: backgroundFetch(account.env, false) });
    } finally {
      if (answer && answer.costUSD > 0) await account.spend({ usd: answer.costUSD, bucket: hold.bucket });
      account.release({ hold: hold.hold });
    }
    result.checked++;
    const v = answer && answer.ok ? answer.value : null;
    if (!v || v.needs_reply !== true || typeof v.body !== 'string' || !v.body.trim()) continue;
    let body = v.body.replace(/\r/g, '').trim().slice(0, 8000);
    if (p.frame) body = enforceFrame(body, p.frame, p.first);
    const to = [msg.replyTo || msg.from].filter(Boolean);
    const subject = /^re:/i.test(msg.subject || '') ? msg.subject : `Re: ${msg.subject || ''}`.trim();
    const refs = [msg.references, msg.messageId].filter(Boolean).join(' ').trim();
    let saved;
    try {
      saved = await runGmailAction(api, 'draft', { to, subject, body, html: draftHtml(body, signature), ...(msg.threadId ? { threadId: msg.threadId } : {}), ...(msg.messageId ? { inReplyTo: msg.messageId, ...(refs ? { references: refs } : {}) } : {}) }, { from: google.email || undefined });
    } catch { continue; }
    today.n++;
    const entry = { msgId: msg.id, threadId: msg.threadId || null, draftId: saved.id, draftMsgId: saved.messageId, subject: String(msg.subject || '').slice(0, 200), from: String(msg.from || '').slice(0, 200), reason: String(v.reason || '').slice(0, 160), at: now };
    made = [...made.filter((x) => x.msgId !== msg.id), entry].slice(-AD.made);
    drafted.push(entry);
    result.drafted++;
  }
  await account.storage.put({ 'ad:seen': seen.slice(-AD.seen), 'ad:made': made, 'ad:day': today });
  if (drafted.length) {
    const who = drafted.map((x) => nameOf(x.from) || addrOf(x.from)).slice(0, 3).join(', ');
    await (deps.notify || notifyOwner)(account, { title: 'Eden drafted replies', body: drafted.length === 1 ? `A reply to ${who} is ready to review: “${drafted[0].subject}”.` : `${drafted.length} replies are ready to review (${who}).`, data: { kind: 'autodraft' } }).catch(() => 0);
  }
  return result;
}

const view = async (account) => {
  const cfg = (await account.storage.get('ad:cfg')) || { on: false, perDay: AD.perDayDefault };
  const made = ((await account.storage.get('ad:made')) || []).filter((x) => !x.cleaned).map(({ draftMsgId: _m, ...x }) => x);
  const today = (await account.storage.get('ad:day')) || { day: day(account.now()), n: 0 };
  return { on: !!cfg.on, perDay: cfg.perDay || AD.perDayDefault, hasStyle: Boolean(await account.storage.get('ad:style')), made, today: today.day === day(account.now()) ? today.n : 0, everyMin: AD.everyMin };
};

/** The account object's `ad-*` ops (signed in, the owner's own: never a delegate's grant). */
export async function autodraftOp(account, op, body) {
  switch (op) {
    case 'ad-get': return view(account);
    case 'ad-set': {
      const cfg = (await account.storage.get('ad:cfg')) || { on: false, perDay: AD.perDayDefault };
      if (typeof body.on === 'boolean') cfg.on = body.on;
      if (body.perDay !== undefined) cfg.perDay = Math.min(AD.perDayMax, Math.max(1, Math.round(Number(body.perDay) || AD.perDayDefault)));
      cfg.updated = account.now();
      const id = ((await account.storage.get('account')) || {}).id;
      if (body.style !== undefined && body.style !== null) {
        const text = JSON.stringify(body.style);
        if (typeof body.style !== 'object' || text.length > AD.styleChars) throw new ApiError(400, 'bad_request', `style must be an object of at most ${AD.styleChars / 1000} KB.`);
        await account.storage.put('ad:style', await sealWith(account.env, INFO, id, body.style));
      }
      if (!cfg.on) await account.storage.delete('ad:style'); // off: the server's copy of the style goes
      await account.storage.put('ad:cfg', cfg);
      if (cfg.on) await scheduleJob(account, JOB, JOB, account.now() + 5_000);
      else await unscheduleJob(account, JOB);
      return view(account);
    }
    case 'ad-drop': { // the owner discarded one (the page deletes the Gmail draft itself)
      const made = ((await account.storage.get('ad:made')) || []).filter((x) => x.msgId !== String(body.msgId || ''));
      await account.storage.put('ad:made', made);
      return view(account);
    }
    case 'ad-run': { // "Check now"
      const cfg = await account.storage.get('ad:cfg');
      if (!cfg || !cfg.on) throw new ApiError(409, 'off', 'Background Auto Drafts are off.');
      const r = await autodraftPass(account, cfg);
      return { ...(await view(account)), last: r };
    }
    default:
      throw new ApiError(404, 'not_found', 'No such thing.');
  }
}
