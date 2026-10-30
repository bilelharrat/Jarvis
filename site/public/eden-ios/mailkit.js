// Eden Mail's own state for the Superhuman-style features, and the Mail settings dialog.
// One object: the owner's learned writing style (voice), snippets, snoozes, Done marks kept in
// Eden (when Gmail can't archive: no gmail.modify grant, or Mail on your Mac), follow-up
// reminders, VIPs and settings. Kept in this browser, and by Eden's server on the Mac
// (src/chat/mailkit.ts) or, on askeden.com, in the account's end-to-end encrypted sync
// (`eden/mailkit`), like signatures. The later `at` wins.
//
// Your writing style: Eden reads up to 120 of the owner's sent emails, keeps only what they
// wrote (mail-voice.js ownText), measures how they write (styleStats) and asks a cheap model
// for a short description of their voice (no facts from the emails). Drafts then get that
// description plus the 3–4 past emails most like the one being written (same person first)
// as examples. Relearned in the background once a week while Mail is used.

import { el, ico, toast, store, uid } from './util.js';
import { api, getJSON, postJSON, isMock } from './api.js';
import { state } from './state.js';
import { syncItem } from './sync.js';
import { timings, SPEED_TARGETS, clearMailCache } from './mail-cache.js';
import { RULE_SYSTEM, parseRule, describeRule, matchRule } from './mail-rules.js';
import { routeSettings, modelInfo } from './router.js';
import { locale } from './i18n.js';
import {
  ownText, stripCommonTail, styleStats, describeStyle, pickExamples, voiceInstructions, exampleContext, editContext,
  STYLE_GUIDE_SYSTEM, guideContext, languageOf, intentOf, situationOf, expectedFrame, embedText, packVec, unpackVec,
  editRatio, changeSummary, RULES_SYSTEM, rulesContext, parseRules, mergeRules, INTENT_LABEL, LANG_NAME,
} from './mail-voice.js';

// Mock mode (?mock=1) keeps its own copy: a real page on the same origin must never pick up test data and sync it to the server.
const KEY = isMock ? 'eden:mail:kit:mock' : 'eden:mail:kit';
export const DEFAULT_PREFS = { voice: true, instant: true, split: true, undoSend: 10, autoLearn: true, receipts: false, autoDrafts: true, autoDraftsPerDay: 10, checkDrafts: true, privateMail: false, dailyBrief: true };
const MAX_EXAMPLES = 100;
const MAX_EDITS = 40; // drafts next to what was sent, and notes (kept small: the whole object syncs)
const RULES_EVERY = 3; // corrections or notes between two passes that learn rules from them
const RELEARN_MS = 7 * 86_400_000;

let H = {};
let syncHook = null;
let kit = load();
const listeners = new Set();

function load() {
  const v = store.get(KEY, null);
  return v && typeof v === 'object' ? v : { at: 0 };
}
const hosted = () => !!(state.meta && state.meta.hosted);

/** The current object (read-only: change it with update()). */
export const getKit = () => kit;
export const prefs = () => ({ ...DEFAULT_PREFS, ...(kit.prefs || {}) });
export const onKit = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

/** Changes it (fn gets a copy to edit), keeps it here and on the server / in sync. */
export function update(fn) {
  const next = JSON.parse(JSON.stringify(kit));
  fn(next);
  next.at = Date.now();
  // Done marks older than 30 days go (the message is long out of the inbox's first page)
  if (next.done) for (const [id, t] of Object.entries(next.done)) if (Date.now() - t > 30 * 86_400_000) delete next.done[id];
  set(next);
  if (hosted()) { if (syncHook) syncHook.changed(); return; }
  postJSON('/api/chat/mailkit', next).then((kept) => { if (kept && kept.at > next.at) set(kept); }, () => { /* pushed again at the next load */ });
}
function set(v) {
  kit = v;
  if (!store.set(KEY, v) && v.voice) { // a full quota: the style's examples are the big part
    store.set(KEY, { ...v, voice: { ...v.voice, examples: (v.voice.examples || []).slice(0, 20) } });
  }
  for (const fn of listeners) { try { fn(kit); } catch { /* a listener's own problem */ } }
}

/** After the page knows where it runs (state.meta): the server's copy, or the synced one. */
export function setMailkitHandlers(handlers) { H = { ...H, ...handlers }; }
export async function initMailkit() {
  if (hosted()) {
    syncItem({
      key: 'eden/mailkit',
      value: () => kit,
      merge: (theirs) => { if (!theirs || typeof theirs !== 'object' || !((theirs.at || 0) > (kit.at || 0))) return false; set(theirs); return true; },
      bind(hook) { syncHook = hook; },
    });
    return;
  }
  try {
    const kept = await getJSON('/api/chat/mailkit');
    if (kept && (kept.at || 0) > (kit.at || 0)) set(kept);
    else if ((kit.at || 0) > (kept.at || 0)) { const stored = await postJSON('/api/chat/mailkit', kit); if (stored) set(stored); }
  } catch { /* no server (or an older one): this browser's copy */ }
}

/* ---------------- private mode (ROADMAP P4): Mail's AI on this Mac only ---------------- */

/** Private mode is on: every Mail AI turn runs on a local model (Ollama / LM Studio) on this Mac; the Mac only. */
export const privateMail = () => Boolean(prefs().privateMail) && !hosted();
/** What a Mail AI request adds in private mode: the server answers with a local model, or refuses (never the cloud). */
export const mailAI = () => (privateMail() ? { privacy: true, ...(state.settings && state.settings.localModel ? { localModel: state.settings.localModel } : {}) } : {});

/* ---------------- a cheap model, for the style guide and instant replies ---------------- */

const CHEAP = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.8-flash'];
function cheapModel() {
  for (const id of CHEAP) {
    const m = modelInfo(id);
    if (!m || !m.available) continue;
    const efforts = (m.efforts || []).map((e) => (typeof e === 'string' ? e : e && e.id)).filter(Boolean);
    const effort = ['minimal', 'none', 'low'].find((e) => efforts.includes(e));
    return { model: id, ...(effort ? { effort } : {}) };
  }
  return null;
}
/** One cheap, fast answer with `context` as untrusted blocks (the server wraps them, H8). */
export async function askCheap(system, ask, context, { signal } = {}) {
  const settings = { ...routeSettings(), level: 1, efficiency: 80, performance: 30 };
  if (!privateMail() && (!settings.providers || !settings.providers.length)) throw new Error('no model is available. Add a key in Settings.');
  const override = privateMail() ? null : cheapModel();
  let out = '', model = '';
  await api.send({ messages: [{ role: 'user', content: ask }], context: context.map((c) => ({ source: 'mail', ...c })), system, settings, mode: 'chat', ...(override ? { override } : {}), ...mailAI() }, {
    signal,
    onEvent: (t, d) => {
      if (t === 'route') model = d.modelName || d.model || '';
      else if (t === 'text') out += d.text || '';
      else if (t === 'error') throw new Error(d.message || 'Eden couldn’t do that.');
    },
  });
  return { out: out.trim(), model };
}

/* ---------------- your writing style ---------------- */

let learning = null;
export const isLearning = () => !!learning;

/**
 * Learns how the owner writes from their sent mail. `fetchSamples(onCount)` gives
 * [{ id, to, subject, date, text, reply }] (mail.js: Gmail's voiceSamples, or Mail on your Mac).
 */
export function learnVoice(fetchSamples, { source = 'gmail', quiet = false, onStep } = {}) {
  if (learning) return learning;
  learning = (async () => {
    const step = (t) => { if (onStep) onStep(t); };
    step('Reading your sent mail…');
    const raw = await fetchSamples((n) => step(`Reading your sent mail… ${n}`));
    let samples = (raw || []).map((s) => ({ ...s, text: ownText(s.text) })).filter((s) => s.text.replace(/\s+/g, ' ').length >= 15);
    const cut = stripCommonTail(samples.map((s) => s.text));
    samples = samples.map((s, i) => ({ ...s, text: cut[i] })).filter((s) => s.text.length >= 15);
    if (samples.length < 5) throw new Error(`only ${samples.length} sent email${samples.length === 1 ? '' : 's'} with your own writing in ${source === 'gmail' ? 'Gmail' : 'Mail on your Mac'}: Eden needs at least 5.`);
    step(`Measuring your style in ${samples.length} emails…`);
    const stats = styleStats(samples);
    let guide = '', model = '';
    try {
      step('Describing your voice…');
      const r = await askCheap(STYLE_GUIDE_SYSTEM, 'Describe how this person writes, as the bullet points asked for.', [{ title: 'The owner’s sent emails', text: guideContext(samples) }]);
      guide = r.out.replace(/```[a-z]*|```/gi, '').trim().slice(0, 2500);
      model = r.model;
    } catch { /* the measured style alone still works */ }
    const examples = samples.slice(0, MAX_EXAMPLES).map((s) => ({ to: s.to || [], subject: String(s.subject || '').slice(0, 120), text: s.text.slice(0, 1500), reply: !!s.reply, date: s.date || null, lang: languageOf(s.text), intent: intentOf(s.text) }));
    // vectors, so examples match the email being written by meaning (a Gemini or OpenAI key; else words)
    let embedded = '';
    if (!privateMail()) try {
      step('Indexing your emails by meaning…');
      const r = await postJSON('/api/chat/embed', { texts: examples.map(embedText) });
      if (r && Array.isArray(r.vectors) && r.vectors.length === examples.length) { r.vectors.forEach((v, i) => { examples[i].vec = packVec(v); }); embedded = r.provider || 'yes'; }
    } catch { /* no key, or an older server: matched by words */ }
    update((k) => {
      const old = k.voice || {};
      k.voice = { learnedAt: new Date().toISOString(), source, count: samples.length, stats, guide, model, examples, embedded, rules: old.rules || [], ruleBlock: old.ruleBlock || [], rulesAt: old.rulesAt || 0 };
    });
    if (!quiet) toast(`Eden learned your writing style from ${samples.length} sent emails`);
    if (hosted()) serverDrafts.get().then((st) => { if (st && st.on) serverDrafts.set({ style: styleForServer() }); }).catch(() => {});
    return kit.voice;
  })().finally(() => { learning = null; });
  return learning;
}

/** Learns in the background when there's no style yet (or it's a week old), once per page. */
let triedAuto = false;
export function maybeAutoLearn(fetchSamples, source) {
  if (triedAuto || !prefs().autoLearn || learning) return;
  const v = kit.voice;
  if (v && v.source === source && Date.now() - Date.parse(v.learnedAt) < RELEARN_MS) return;
  if (v && v.source !== source) return; // learned from the other source: the owner relearns by hand
  triedAuto = true;
  learnVoice(fetchSamples, { source, quiet: !!v }).catch(() => { /* tried again on the next page load */ });
}

/** Whether drafts are written in the owner's style right now. */
export const voiceOn = () => Boolean(kit.voice && kit.voice.stats && prefs().voice);

// This email's vector, by its text (the last few, so a rewrite doesn't ask again)
const queryVecs = new Map();
async function queryVec(text) {
  const k = String(text || '').slice(0, 2000);
  if (!k.trim()) return null;
  if (queryVecs.has(k)) return queryVecs.get(k);
  if (privateMail()) return null; // embeddings go to a cloud provider: off in private mode
  let v = null;
  try { const r = await postJSON('/api/chat/embed', { texts: [k] }); v = r && r.vectors && r.vectors[0] ? unpackVec(packVec(r.vectors[0])) : null; } catch { /* matched by words */ }
  queryVecs.set(k, v);
  if (queryVecs.size > 20) queryVecs.delete(queryVecs.keys().next().value);
  return v;
}

/**
 * What a draft gets to sound like the owner: { system, context, frame, situation, lang } (empty
 * when the style is off or not learned). `to`: the recipients' addresses; `about`: the email being
 * answered (or the subject and the ask); `ask`: what the owner asked Eden for; `lang`: the
 * language to write in (else the email's own).
 */
export async function voiceFor({ to = [], about = '', reply = false, ask = '', lang = '', withFrame = true } = {}) {
  const v = kit.voice;
  if (!v || !v.stats || !prefs().voice) return { system: '', context: [], on: false };
  const addrs = to.map((a) => String(a).toLowerCase());
  const situation = situationOf({ text: reply ? '' : about, to: addrs, reply, ask });
  const language = lang || languageOf(ask) || languageOf(about) || '';
  const query = (v.examples || []).some((x) => x.vec) ? await queryVec(`${ask}\n${about}`.trim()) : null;
  const ex = pickExamples(v.examples || [], { to: addrs, about: `${ask} ${about}`, reply, situation, lang: language, query }, 4);
  // the owner's corrections: to this person first, then the most recent ones that changed something
  const edits = (kit.edits || []).filter((e) => !e.note && e.change > 0.05);
  const corr = [...edits.filter((e) => e.to && addrs.includes(e.to)), ...edits.slice().reverse()].filter((e, i, a) => a.indexOf(e) === i).slice(0, 2);
  const frame = withFrame ? expectedFrame(v.stats, { to: addrs, situation, lang: language }) : null; // instant replies have no greeting or sign-off
  return {
    system: voiceInstructions(v, addrs, { situation, lang: language, rules: v.rules || [], frame }),
    context: [...exampleContext(ex), ...editContext(corr)],
    on: true, count: v.count, frame, situation, lang: language, byMeaning: Boolean(query),
  };
}

/* ---------------- learning from the owner's edits ---------------- */

/** A draft Eden wrote and what the owner sent: kept (the last MAX_EDITS), and rules learned now and then. */
export function recordEdit({ ai, sent, kind = '', to = '', situation = null }) {
  const a = String(ai || '').trim(), b = String(sent || '').trim();
  if (!a || !b) return null;
  const change = editRatio(a, b);
  update((k) => { k.edits = [...(k.edits || []), { at: Date.now(), kind, to: String(to || '').toLowerCase(), intent: situation ? situation.intent : '', ai: a.slice(0, 1500), sent: b.slice(0, 1500), change, voice: voiceOn() }].slice(-MAX_EDITS); });
  maybeLearnRules();
  return change;
}
/** "Doesn't sound like me": the owner's own words about a draft, learned from like an edit. */
export function addNote(note, ai = '') {
  const t = String(note || '').trim().slice(0, 300);
  if (!t) return;
  update((k) => { k.edits = [...(k.edits || []), { at: Date.now(), note: t, ai: String(ai || '').slice(0, 1500), sent: '', change: null }].slice(-MAX_EDITS); });
  maybeLearnRules(true);
}
let rulesBusy = false;
/** Every few corrections or notes (or at once, `now`): a cheap model turns them into rules for the next drafts. */
export async function maybeLearnRules(now = false) {
  const v = kit.voice;
  if (!v || rulesBusy) return;
  const fresh = (kit.edits || []).filter((e) => e.at > (v.rulesAt || 0) && (e.note || e.change > 0.05));
  if (!fresh.length || (!now && fresh.length < RULES_EVERY)) return;
  const usable = (kit.edits || []).filter((e) => e.note || e.change > 0.05);
  rulesBusy = true;
  try {
    const r = await askCheap(RULES_SYSTEM, 'Write the rules as the JSON object asked for.', [{ title: 'Drafts next to what the owner sent, and their notes', text: rulesContext(usable) }]);
    const rules = parseRules(r.out);
    if (rules.length) update((k) => { if (!k.voice) return; k.voice.rules = mergeRules(k.voice.rules, rules, k.voice.ruleBlock); k.voice.rulesAt = Date.now(); });
  } catch { /* tried again after the next correction */ }
  finally { rulesBusy = false; }
}
export function addRule(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!t || !kit.voice) return;
  update((k) => { k.voice.rules = [...(k.voice.rules || []), { id: uid('rule'), text: t, by: 'you', at: Date.now() }].slice(-20); });
}
export function deleteRule(id) {
  update((k) => {
    if (!k.voice) return;
    const r = (k.voice.rules || []).find((x) => x.id === id);
    k.voice.rules = (k.voice.rules || []).filter((x) => x.id !== id);
    if (r && r.by === 'eden') k.voice.ruleBlock = [...(k.voice.ruleBlock || []), r.text].slice(-60);
  });
}

/* ---------------- Auto Drafts in the background (askeden.com: accounts/autodrafts.js) ---------------- */

/** The style the server needs to draft in the owner's voice (no vectors; their 30 newest emails as examples). */
export function styleForServer() {
  const v = kit.voice;
  if (!v || !v.stats) return null;
  return { stats: v.stats, guide: v.guide || '', rules: v.rules || [], examples: (v.examples || []).slice(0, 30).map(({ vec: _v, ...x }) => x) };
}
export const serverDrafts = { get: () => getJSON('/api/chat/autodrafts'), set: (body) => postJSON('/api/chat/autodrafts', { action: 'set', ...body }), drop: (msgId) => postJSON('/api/chat/autodrafts', { action: 'drop', msgId }), run: () => postJSON('/api/chat/autodrafts', { action: 'run' }) };

/* ---------------- snoozes, Done, follow-ups ---------------- */

export function snooze(id, info) { update((k) => { (k.snoozed ||= {})[id] = info; }); }
export function unsnooze(id) { update((k) => { if (k.snoozed) delete k.snoozed[id]; }); }
export function markDone(ids, on = true) { update((k) => { k.done ||= {}; for (const id of ids) { if (on) k.done[id] = Date.now(); else delete k.done[id]; } }); }
export const isDone = (id) => !!(kit.done && kit.done[id]);
export const snoozedOf = (id) => (kit.snoozed && kit.snoozed[id]) || null;
export function addFollowUp(f) { update((k) => { k.followups = [...(k.followups || []).filter((x) => x.threadId !== f.threadId), { id: uid('fu'), ...f }].slice(-200); }); }
export function dropFollowUp(id) { update((k) => { k.followups = (k.followups || []).filter((x) => x.id !== id); }); }
export const vips = () => new Set((kit.vips || []).map((a) => String(a).toLowerCase()));
/** Inbox rules in plain English (mail-rules.js): [{ id, text, rule, on, at }], and what they did. */
export const rules = () => (kit.rules || []).filter((r) => r && r.rule);
export function logRule(entries) { update((k) => { k.ruleLog = [...(k.ruleLog || []), ...entries].slice(-100); }); }
/** Times offered in a sent email: kept so the reply that picks one can be booked (the last 50). */
export function addOffer(o) { update((k) => { k.offers = [...(k.offers || []).filter((x) => x.threadId !== o.threadId), { ...o, at: Date.now() }].slice(-50); }); }
export const offerFor = (threadId) => (kit.offers || []).find((x) => x.threadId === threadId) || null;
export function dropOffer(threadId) { update((k) => { k.offers = (k.offers || []).filter((x) => x.threadId !== threadId); }); }

/* ---------------- the settings dialog ---------------- */

const SHORTCUTS = [
  ['j / ↓', 'Next email'], ['k / ↑', 'Previous email'], ['Enter / o', 'Open'], ['u / Esc', 'Back to the list'],
  ['e', 'Done (archive)'], ['h', 'Remind me (snooze)'], ['s', 'Star'], ['⇧U / ⇧I', 'Mark unread / read'],
  ['r', 'Reply'], ['a', 'Reply all'], ['f', 'Forward'], ['c', 'New email'], ['/', 'Search'],
  ['1–4', 'Important, Other, News, Calendar'], ['z', 'Undo'], ['?', 'These shortcuts'],
];
export function shortcutsNode() {
  return el('div', 'mk-keys', ...SHORTCUTS.map(([k, t]) => el('div', 'mk-key', el('kbd', '', k), el('span', '', t))));
}

/**
 * The Rules tab: a rule in plain words → Eden turns it into a rule (a cheap model), says it back
 * and shows what it would do to the emails in the inbox now; the owner turns it on. Each rule can
 * be paused or deleted; the last things rules did are listed.
 */
function rulesNode(previewRows) {
  const box = el('div', 'mk-rulesbox');
  const input = el('textarea', { rows: '2', maxlength: '300', placeholder: 'e.g. Archive receipts once I’ve seen them · Snooze newsletters for 3 days · Draft a polite no to sales pitches · Star emails from my accountant', 'aria-label': 'A rule in your own words' });
  const out = el('div', { class: 'mk-rule-new', 'aria-live': 'polite' });
  const check = el('button', { type: 'button', class: 'btn', onclick: async () => {
    const text = input.value.trim();
    if (!text) { input.focus(); return; }
    check.disabled = true; out.replaceChildren(el('div', 'mk-busy', el('span', 'mk-spin'), 'Eden is reading your rule…'));
    try {
      const r = await askCheap(RULE_SYSTEM, text, []);
      const p = parseRule(r.out);
      if (p.error) { out.replaceChildren(el('p', 'dg-err', p.error)); return; }
      const rows = previewRows ? previewRows() : [];
      const hits = rows.filter((m) => matchRule(p.rule, m, { split: m.split || '' }));
      out.replaceChildren(el('div', 'mk-rule-card',
        el('b', '', describeRule(p.rule)),
        el('p', 'muted', rows.length ? (hits.length ? `Of the ${rows.length} newest emails in your inbox, it would act on ${hits.length}:` : `None of the ${rows.length} newest emails in your inbox match it right now.`) : 'Open Mail to see what it would do.'),
        hits.length ? el('ul', { 'data-no-i18n': '' }, ...hits.slice(0, 6).map((m) => el('li', '', `${m.fromName || m.from}: ${m.subject}`))) : null,
        el('div', 'dlg-acts', el('span', 'grow'), el('button', { type: 'button', class: 'btn primary', onclick: () => {
          update((k) => { k.rules = [...(k.rules || []), { id: uid('rule'), text, rule: p.rule, on: true, at: Date.now() }].slice(-30); });
          input.value = ''; out.replaceChildren(); paint(); toast('Rule on: it runs when Mail loads your inbox');
        } }, 'Turn it on'))));
    } catch (e) { out.replaceChildren(el('p', 'dg-err', `Couldn’t read the rule: ${e.message}`)); }
    finally { check.disabled = false; }
  } }, 'Check it');
  const paint = () => {
    const rs = kit.rules || [];
    const log = (kit.ruleLog || []).slice(-12).reverse();
    box.replaceChildren(...[
      el('p', 'mk-lead', 'Tell Eden what to do with some of your email, in your own words. Rules only archive, mark read, star, snooze, draft a reply for you to review, or tell you: they never send, reply, forward or delete. Suspicious emails are never drafted to.'),
      rs.length ? el('ul', 'mk-rule-list', ...rs.map((r) => el('li', '',
        el('label', 'mk-rule-on', el('input', { type: 'checkbox', checked: r.on ? '' : null, 'aria-label': `Rule on: ${r.text}`, onchange: (e) => { const on = e.target.checked; update((k) => { const x = (k.rules || []).find((y) => y.id === r.id); if (x) x.on = on; }); } })),
        el('span', 'grow', el('b', '', describeRule(r.rule)), el('small', { 'data-no-i18n': '' }, `“${r.text}”`)),
        el('button', { type: 'button', class: 'mx-ib', 'aria-label': `Delete the rule: ${r.text}`, title: 'Delete', onclick: () => { update((k) => { k.rules = (k.rules || []).filter((y) => y.id !== r.id); }); paint(); } }, ico('trash', 13))))) : el('p', 'muted', 'No rules yet.'),
      el('label', 'field', 'A new rule', input), el('div', 'dlg-acts', el('span', 'grow'), check), out,
      log.length ? el('details', 'mk-details', el('summary', '', 'What rules did lately'), el('ul', 'mk-lines', ...log.map((x) => el('li', '', `${new Date(x.at).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${x.what}: `, el('span', { 'data-no-i18n': '' }, x.subject))))) : null,
    ].filter(Boolean));
  };
  paint();
  return box;
}

/** The Speed tab: how long things took this session (median and slowest 5%), against the targets. */
function speedNode() {
  const rows = timings().filter((t) => t.n);
  return el('div', '',
    el('p', 'mk-lead', 'Eden keeps your inbox and the emails you open in this browser, shows them at once, and asks Gmail only what changed. It also reads the next few emails ahead. These are this session’s real timings.'),
    rows.length ? el('table', 'mk-speed', el('thead', '', el('tr', '', el('th', '', ''), el('th', '', 'Typical'), el('th', '', 'Slowest 5%'), el('th', '', 'Target'), el('th', '', 'Times'))),
      el('tbody', '', ...rows.map((t) => { const target = SPEED_TARGETS[t.kind]; const ok = t.p95 !== null && target && t.p95 <= target;
        return el('tr', '', el('td', '', t.label), el('td', '', `${t.p50} ms`), el('td', ok ? 'ok' : 'slow', `${t.p95} ms`), el('td', 'muted', target ? `${target} ms` : ''), el('td', 'muted', String(t.n))); })))
      : el('p', 'muted', 'Nothing measured yet: open Mail and a few emails, then come back.'),
    el('div', 'dlg-acts', el('span', 'grow'), el('button', { type: 'button', class: 'btn', onclick: async (e) => { await clearMailCache(); e.currentTarget.textContent = 'Cleared'; toast('Mail kept in this browser cleared'); } }, 'Clear cached mail')));
}

/**
 * Settings › Eden Mail: writing style, instant replies, split inbox, undo send, snippets, VIPs
 * and the shortcuts. `fetchSamples` / `source`: how to learn the style from the open Mail source.
 */
export function openMailSettings({ fetchSamples, source = 'gmail', tab = 'voice', previewRows = null } = {}) {
  const p = prefs();
  const draft = { prefs: { ...p }, snippets: JSON.parse(JSON.stringify(kit.snippets || [])), vips: (kit.vips || []).join('\n') };
  const voiceBox = el('div', 'mk-voice');
  const paintVoice = (busyText) => {
    const v = kit.voice;
    const learnBtn = el('button', { type: 'button', class: 'btn primary', disabled: !!busyText || !fetchSamples, onclick: async () => {
      try { await learnVoice(fetchSamples, { source, onStep: (t) => paintVoice(t) }); paintVoice(); } catch (e) { paintVoice(); toast(`Couldn’t learn your style: ${e.message}`); }
    } }, v ? 'Learn again' : 'Learn my writing style');
    const forget = v ? el('button', { type: 'button', class: 'btn danger', disabled: !!busyText, onclick: () => { update((k) => { delete k.voice; delete k.edits; }); paintVoice(); toast('Eden forgot your writing style and your corrections'); } }, 'Forget it') : null;
    const lines = v ? describeStyle(v.stats) : [];
    const score = changeSummary(kit.edits);
    const autoScore = changeSummary((kit.edits || []).filter((e) => e.kind === 'auto'));
    const ruleIn = el('input', { type: 'text', maxlength: '200', placeholder: 'Add your own rule, e.g. “Never use “circle back””', 'aria-label': 'Add a rule' });
    const addOwn = () => { if (ruleIn.value.trim()) { addRule(ruleIn.value); ruleIn.value = ''; paintVoice(); } };
    ruleIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addOwn(); } });
    const sits = v ? Object.entries(v.stats.situations || {}).filter(([k]) => k.startsWith('intent:') && k !== 'intent:other') : [];
    const langs = v ? Object.entries(v.stats.languages || {}) : [];
    voiceBox.replaceChildren(...[
      el('p', 'mk-lead', 'Eden reads up to 300 emails you’ve sent (newer ones count more) and learns how you write: how you open and close, how long and how formal you are, the phrases you use, and how you write to each person, in each situation and each language. It also learns from what you change in its drafts. Drafts and instant replies then sound like you.'),
      v ? el('div', 'mk-stat', ico('check', 14), el('span', '', `Learned from ${v.count} sent emails in ${v.source === 'mac' ? 'Mail on your Mac' : 'Gmail'}, ${new Date(v.learnedAt).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' })}.`))
        : el('div', 'mk-stat none', ico('spark', 14), el('span', '', 'Not learned yet.')),
      busyText ? el('div', { class: 'mk-busy', role: 'status' }, el('span', 'mk-spin'), busyText) : null,
      v ? el('div', 'mk-score',
        el('b', '', 'How much you change Eden’s drafts'),
        score.count
          ? el('div', 'mk-score-n', el('span', 'big', score.recent === null ? '—' : `${score.recent}%`), el('span', '', score.before === null
            ? `on average over your last ${Math.min(score.count, 10)} draft${score.count === 1 ? '' : 's'} · ${score.asIs} sent as Eden wrote ${score.asIs === 1 ? 'it' : 'them'}`
            : `last 10 drafts, ${score.recent < score.before ? 'down' : score.recent > score.before ? 'up' : 'same as'} from ${score.before}% the 10 before · ${score.asIs} of ${score.count} sent as written`))
          : el('p', 'muted', 'Send a draft Eden wrote and this shows how much you changed it: lower means Eden sounds more like you.'),
        autoScore.count ? el('p', 'mk-score-auto', `Auto Drafts: you changed ${autoScore.recent}% on average over ${Math.min(autoScore.count, 10)}, and sent ${autoScore.asIs} of ${autoScore.count} as Eden wrote them.`) : null,
        score.series.length > 1 ? el('div', { class: 'mk-bars', 'aria-hidden': 'true' }, ...score.series.map((n) => el('span', { style: { height: `${Math.max(4, n)}%` }, title: `${n}% changed` }))) : null) : null,
      v ? el('div', 'mk-rules', el('b', '', 'Rules from your corrections'),
        (v.rules || []).length ? el('ul', '', ...(v.rules || []).map((r) => el('li', '', el('span', { 'data-no-i18n': '' }, r.text), r.by === 'you' ? el('span', 'mk-you', 'yours') : null,
          el('button', { type: 'button', class: 'mx-ib', 'aria-label': `Delete the rule: ${r.text}`, title: 'Delete (Eden won’t learn it again)', onclick: () => { deleteRule(r.id); paintVoice(); } }, ico('x', 12)))))
          : el('p', 'muted', 'None yet. Eden writes some after you’ve changed a few of its drafts, or told it a draft didn’t sound like you.'),
        el('div', 'mk-rule-add', ruleIn, el('button', { type: 'button', class: 'btn', onclick: addOwn }, 'Add'))) : null,
      el('label', 'mk-check', check('voice'), el('span', '', el('b', '', 'Write drafts in my style'), el('small', '', 'Eden’s replies, rewrites and instant replies follow it, with a few of your own emails like the one being written, and your corrections, as examples.'))),
      v ? el('details', 'mk-details', el('summary', '', 'What Eden learned'),
        el('ul', 'mk-lines', ...lines.map((l) => el('li', '', l))),
        v.guide ? el('div', 'mk-guide', el('b', '', 'Your voice, in Eden’s words'), el('pre', '', v.guide)) : null,
        sits.length ? el('div', 'mk-people', el('b', '', 'By situation'),
          el('ul', '', ...sits.map(([k, x]) => el('li', '', el('span', 'mk-addr', INTENT_LABEL[k.slice(7)] || k), ` — ${x.greeting ? `“${x.greeting}”` : 'no greeting'}, ${x.signoff ? `“${x.signoff}”` : 'no sign-off'}, ~${x.words} words (${x.count} emails)`)))) : null,
        langs.length ? el('div', 'mk-people', el('b', '', 'By language'),
          el('ul', '', ...langs.map(([l, x]) => el('li', '', el('span', 'mk-addr', LANG_NAME[l] || l), ` — ${x.greeting ? `“${x.greeting}”` : 'no greeting'}, ${x.signoff ? `“${x.signoff}”` : 'no sign-off'}, ~${x.words} words (${x.count} emails)`)))) : null,
        el('p', 'muted', v.embedded ? `Examples are matched to each email by meaning (${v.embedded === 'openai' ? 'OpenAI' : 'Gemini'} embeddings), then by person, situation and language.` : 'Examples are matched by person, situation, language and shared words. Add a Gemini or OpenAI key, then Learn again, to match them by meaning too.'),
        Object.keys(v.stats.perPerson || {}).length ? el('div', 'mk-people', el('b', '', 'With the people you write to most'),
          el('ul', '', ...Object.entries(v.stats.perPerson).slice(0, 8).map(([a, x]) => el('li', '', el('span', { class: 'mk-addr', 'data-no-i18n': '' }, a), ` — ${x.greeting ? `“${x.greeting}”` : 'no greeting'}, ${x.signoff ? `“${x.signoff}”` : 'no sign-off'}, ~${x.words} words`)))) : null) : null,
      el('p', 'sp-note', hosted()
        ? 'What Eden learned, with up to 100 of your own emails as examples and your last 40 corrections, stays in this browser and, with Sync on, reaches your other browsers end-to-end encrypted. Describing your voice uses one short AI request; facts from your emails aren’t kept in the description.'
        : 'What Eden learned, with up to 100 of your own emails as examples and your last 40 corrections, stays on this Mac (in Eden’s settings folder, readable only by you). Describing your voice uses one short AI request; facts from your emails aren’t kept in the description.'),
      el('label', 'mk-check', check('autoLearn'), el('span', '', el('b', '', 'Keep it up to date'), el('small', '', 'Eden learns again from your newest sent mail about once a week while you use Mail.'))),
      el('div', 'dlg-acts', forget, el('span', 'grow'), learnBtn)].filter(Boolean));
  };
  function check(k) {
    const c = el('input', { type: 'checkbox' });
    c.checked = !!draft.prefs[k];
    c.addEventListener('change', () => { draft.prefs[k] = c.checked; });
    return c;
  }

  const snipList = el('div', 'mk-snips');
  const paintSnips = () => {
    snipList.replaceChildren(...draft.snippets.map((s) => {
      const name = el('input', { type: 'text', value: s.name, maxlength: '40', 'aria-label': 'Snippet name', placeholder: 'Name (type ;name in an email)' });
      const text = el('textarea', { rows: '3', maxlength: '5000', 'aria-label': 'Snippet text', placeholder: 'Hi {first_name}, …' });
      text.value = s.text;
      name.addEventListener('input', () => { s.name = name.value.trim(); });
      text.addEventListener('input', () => { s.text = text.value; });
      return el('div', 'mk-snip', el('div', 'mk-snip-h', name, el('button', { type: 'button', class: 'mx-ib', 'aria-label': 'Delete the snippet', title: 'Delete', onclick: () => { draft.snippets = draft.snippets.filter((x) => x !== s); paintSnips(); } }, ico('trash', 14))), text);
    }), draft.snippets.length ? null : el('p', 'muted', 'No snippets yet.'));
  };
  paintSnips();
  const vipBox = el('textarea', { rows: '4', 'aria-label': 'VIP addresses, one per line', placeholder: 'priya@example.org' });
  vipBox.value = draft.vips;

  const autoSel = el('select', { 'aria-label': 'Auto Drafts a day, at most' }, ...[3, 10, 25, 50].map((n) => el('option', { value: String(n) }, String(n))));
  autoSel.value = String(draft.prefs.autoDraftsPerDay);
  autoSel.addEventListener('change', () => { draft.prefs.autoDraftsPerDay = Number(autoSel.value); });
  // Auto Drafts while Mail is closed (askeden.com): its own switch, saved at once (it sends the style to the server)
  const bgBox = el('div', 'mk-bg', el('p', 'muted', 'Checking…'));
  if (hosted()) (async () => {
    let st;
    try { st = await serverDrafts.get(); } catch (e) { bgBox.replaceChildren(el('p', 'sp-note', `Background drafts aren’t available: ${e.message}`)); return; }
    const paintBg = () => {
      const c = el('input', { type: 'checkbox' });
      c.checked = !!st.on;
      c.addEventListener('change', async () => {
        c.disabled = true;
        try {
          st = await serverDrafts.set(c.checked ? { on: true, perDay: Number(autoSel.value) || 10, style: styleForServer() } : { on: false });
          toast(st.on ? 'Eden drafts replies while Mail is closed' : 'Background drafts off: askeden.com deleted its copy of your style');
        } catch (e) { toast(`Couldn’t change it: ${e.message}`); }
        paintBg();
      });
      bgBox.replaceChildren(
        el('label', 'mk-check', c, el('span', '', el('b', '', 'Also while Mail is closed'), el('small', '', `Your askeden.com account checks your new mail every ${st.everyMin || 20} minutes, even with your computer off, and saves replies as Gmail drafts in the thread (never sent). Your iPhone gets a note. To write in your style it keeps a copy of your writing style on askeden.com, encrypted on the server but not end-to-end; turning this off deletes it. Untouched drafts are removed after 7 days.${st.on ? ` Today: ${st.today} drafted.` : ''}${st.on && !st.hasStyle ? ' (No style yet: learn it first for drafts in your voice.)' : ''}`))),
        st.on ? el('button', { type: 'button', class: 'btn', onclick: async (e) => { const b = e.currentTarget; b.disabled = true; b.textContent = 'Checking your mail…'; try { st = await serverDrafts.run(); toast(st.last && st.last.drafted ? `Drafted ${st.last.drafted} repl${st.last.drafted === 1 ? 'y' : 'ies'}` : `Nothing to draft right now${st.last && st.last.skipped ? ` (${st.last.skipped})` : ''}`); } catch (err) { toast(err.message); } paintBg(); } }, 'Check now') : null);
    };
    paintBg();
  })();
  const undoSel = el('select', { 'aria-label': 'Undo send' }, ...[0, 5, 10, 20, 30].map((n) => el('option', { value: String(n) }, n ? `${n} seconds` : 'Off')));
  undoSel.value = String(draft.prefs.undoSend);
  undoSel.addEventListener('change', () => { draft.prefs.undoSend = Number(undoSel.value); });

  const sections = {
    voice: ['Your writing style', voiceBox],
    inbox: ['Inbox', el('div', '',
      el('label', 'mk-check', check('split'), el('span', '', el('b', '', 'Split inbox'), el('small', '', 'Important (people you write to, VIPs), Other, News (newsletters and notices) and Calendar, each with its own count.'))),
      hosted()
        ? el('p', 'sp-note', 'Private mode (Mail’s AI on your own computer) is in Eden on your Mac.')
        : el('label', 'mk-check', check('privateMail'), el('span', '', el('b', '', 'Private mode'), el('small', '', 'Every Mail AI feature (drafts, Auto Drafts, summaries, checks, Ask your mail, rules) runs on a local model on this Mac (Ollama or LM Studio), so your emails are never sent to an AI company. Matching examples by meaning is off. Slower, and only as good as your local model; when none is running, Mail’s AI says so instead of using the cloud.'))),
      el('label', 'mk-check', check('checkDrafts'), el('span', '', el('b', '', 'Check emails before they go'), el('small', '', 'In the send review, Eden checks dates and weekdays, times against the invitation and your calendar, amounts against the thread, names and unanswered questions; then a quick AI read for anything else. It never stops you sending.'))),
      el('label', 'mk-check', check('dailyBrief'), el('span', '', el('b', '', 'Daily brief each morning'), el('small', '', 'The first time you open Mail each day, Eden reads your unread and recent email in full and writes your brief: every email ranked by importance, with what it’s about, what they’re asking, the key details and your next step. One AI request a day; also from the Daily brief button.'))),
      el('label', 'mk-check', check('autoDrafts'), el('span', '', el('b', '', 'Auto Drafts'), el('small', '', 'Eden writes replies ahead, in your style, for emails from people that need an answer. “✦ Draft ready” marks them; nothing is saved or sent until you open one and press Send. Each draft is one AI request.'))),
      el('label', 'field', 'Auto Drafts a day, at most', autoSel),
      hosted() ? bgBox : el('p', 'sp-note', 'Auto Drafts while Mail is closed run on askeden.com (your account drafts every 20 minutes, with your computer off).'),
      el('label', 'mk-check', check('instant'), el('span', '', el('b', '', 'Instant replies'), el('small', '', 'Three short replies in your style under an email from a person; one click opens it to send.'))),
      hosted()
        ? el('label', 'mk-check', check('receipts'), el('span', '', el('b', '', 'Read receipts on new emails'), el('small', '', 'A 1×1 image from askeden.com goes in the email; when the recipient’s mail app loads it, Mail shows “Opened”. Apple Mail can load images on its own (marked “may be automatic”), some apps block images, and opening the email yourself in Gmail’s Sent can count. You can turn it off per email in the send review. Recipients aren’t told.')))
        : el('p', 'sp-note', 'Read receipts work on askeden.com (the recipient’s mail app has to reach a server on the internet, not your Mac).'),
      el('label', 'field', 'Undo send', undoSel),
      el('label', 'field', 'VIPs (always in Important)', vipBox))],
    snippets: ['Snippets', el('div', '',
      el('p', 'mk-lead', 'Text you send often. In an email, type ; and the name (or press the Snippets button). {first_name}, {name}, {email}, {my_name}, {date} and {day} are filled in.'),
      snipList,
      el('button', { type: 'button', class: 'btn', onclick: () => { draft.snippets.push({ id: uid('sn'), name: '', text: '' }); paintSnips(); requestAnimationFrame(() => { const i = snipList.querySelectorAll('input'); if (i.length) i[i.length - 1].focus(); }); } }, '+ New snippet'))],
    rules: ['Rules', rulesNode(previewRows)],
    speed: ['Speed', speedNode()],
    keys: ['Shortcuts', shortcutsNode()],
  };
  const tabs = el('div', { class: 'mk-tabs', role: 'tablist' });
  const body = el('div', 'mk-body');
  const show = (id) => {
    tabs.querySelectorAll('[data-t]').forEach((b) => { const on = b.dataset.t === id; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); });
    body.replaceChildren(sections[id][1]);
  };
  tabs.append(...Object.entries(sections).map(([id, [label]]) => el('button', { type: 'button', role: 'tab', 'data-t': id, onclick: () => show(id) }, label)));
  paintVoice();
  show(sections[tab] ? tab : 'voice');
  const save = () => {
    update((k) => {
      k.prefs = draft.prefs;
      k.snippets = draft.snippets.filter((s) => s.name && s.text).map((s) => ({ id: s.id, name: s.name.replace(/\s+/g, '-').toLowerCase().slice(0, 40), text: s.text.slice(0, 5000) }));
      k.vips = vipBox.value.split(/[\s,;]+/).map((a) => a.trim().toLowerCase()).filter((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a)).slice(0, 200);
    });
    H.closeDialog();
    toast('Mail settings saved');
  };
  H.openDialog('Eden Mail', el('div', 'mk-dlg', tabs, body,
    el('div', 'dlg-acts', el('span', 'grow'), el('button', { type: 'button', class: 'btn', onclick: () => H.closeDialog() }, 'Cancel'), el('button', { type: 'button', class: 'btn primary', onclick: save }, 'Save'))));
}
