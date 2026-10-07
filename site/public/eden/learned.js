// A router that learns from you (ROADMAP H2), in the page: your choices become a small personal
// routing profile (the math: learned-model.js and src/learn/profile.ts).
//  - Choices: "Keep this" in Compare or beside a stronger model (compare.js), a model picked for
//    one message (chat.js), "Try again with another model" (app.js), thumbs up / down on a reply
//    (the buttons here), and Stop while it writes (chat.js, a weak signal). Those files say so
//    with an `eden:choice` event; this module turns it into a record: kind, task class, models,
//    costs, a conversation id. Numbers only, never the text.
//  - Where it's kept: on the Mac, in Eden's log there (POST /api/chat/feedback; the server
//    applies the profile). On askeden.com, in this browser and the account's end-to-end
//    encrypted sync (sync.js): askeden.com never sees it; a turn carries only the derived
//    per-class adjustments (`learned`), which the Worker applies within the same caps.
//  - The Route console's "Learned from you" card: each change with its evidence, a reset, the
//    "Learn from my choices" switch (off: nothing applies, and the shadow report says what would
//    have changed), and that report from your recent routed replies.

import { $, el, svgEl, toast, store, shortModel } from './util.js';
import { state, ui, saveConversation } from './state.js';
import { getJSON, postJSON } from './api.js';
import { buildProfile, cleanFeedback, CLASS_WORDS, shadowReport } from './learned-model.js';
import { syncItem } from './sync.js';

const KEY = 'jchat:learn';
const hosted = () => !!(state.meta && state.meta.hosted);
const modelName = (id) => { const m = ((state.meta && state.meta.models) || []).find((x) => x.id === id); return m ? shortModel(m.name) : id; };

let view = null; // { learn, resetAt, profile } (the Mac's server, or this browser's)
let loading = null;
let syncHook = null; // sync.js's item for the profile, when this browser syncs

/* ---------- this browser's copy (askeden.com) ---------- */

function local() {
  const s = store.get(KEY, null);
  return s && Array.isArray(s.events) ? s : { v: 1, events: [], learn: true, resetAt: null };
}
function saveLocal(s) {
  store.set(KEY, s);
  if (syncHook) syncHook.changed();
}
function localView() {
  const s = local();
  return { learn: s.learn !== false, ...(s.resetAt ? { resetAt: s.resetAt } : {}), profile: buildProfile(s.events, { resetAt: s.resetAt ? Date.parse(s.resetAt) : undefined }) };
}

/**
 * For sync.js: the sealed item's value, and merging what another device synced (a union of
 * the events by id and time; the later reset and switch win).
 */
export const learnSyncItem = {
  key: 'eden/learn',
  value: () => { const s = local(); return { v: 1, events: s.events, learn: s.learn !== false, resetAt: s.resetAt || null, at: s.at || 0 }; },
  merge: (theirs) => {
    if (!theirs || !Array.isArray(theirs.events)) return false;
    const mine = local();
    const seen = new Set(mine.events.map((e) => `${e.id || ''}|${e.ts}|${e.kind}|${e.model}`));
    const add = theirs.events.map((e) => cleanFeedback(e)).filter((e) => e && !seen.has(`${e.id || ''}|${e.ts}|${e.kind}|${e.model}`));
    const events = [...mine.events, ...add].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).slice(-2000);
    const newer = (theirs.at || 0) > (mine.at || 0);
    const next = { ...mine, events, ...(newer ? { learn: theirs.learn !== false, at: theirs.at } : {}) };
    const r = [mine.resetAt, theirs.resetAt].filter(Boolean).sort().pop();
    if (r) next.resetAt = r;
    const changed = add.length > 0 || next.learn !== mine.learn || next.resetAt !== mine.resetAt;
    if (changed) { store.set(KEY, next); view = localView(); renderCard(); }
    return changed;
  },
  bind(hook) { syncHook = hook; },
};

/* ---------- the profile ---------- */

export async function refreshLearned() {
  if (hosted()) { view = localView(); renderCard(); return view; }
  if (loading) return loading;
  loading = getJSON('/api/chat/learned').then((v) => { view = v; renderCard(); return v; }).catch(() => view).finally(() => { loading = null; });
  return loading;
}

/** What a send or preview carries on askeden.com: the derived per-class adjustments (small numbers, no text). */
export function learnedBody() {
  if (!hosted()) return {};
  const v = view || localView();
  const adj = v.profile && v.profile.adjustments;
  if (!adj || !Object.keys(adj).length) return {};
  return { learned: { adj, on: v.learn !== false } };
}

async function setLearn(on) {
  if (hosted()) { const s = local(); s.learn = on; s.at = Date.now(); saveLocal(s); view = localView(); }
  else view = await postJSON('/api/chat/learned', { learn: on });
  renderCard();
  toast(on ? 'Learning from your choices' : 'Not learning: your choices are only watched (shadow report)');
  dispatchEvent(new CustomEvent('eden:reroute'));
}
async function reset() {
  if (hosted()) { const s = local(); s.resetAt = new Date().toISOString(); s.at = Date.now(); saveLocal(s); view = localView(); }
  else view = await postJSON('/api/chat/learned', { reset: true });
  renderCard();
  toast('Forgot what the router learned from you');
  dispatchEvent(new CustomEvent('eden:reroute'));
}

/** Records one choice (kept on the Mac or in this browser). */
async function record(rec) {
  const f = cleanFeedback({ ts: Date.now(), ...rec });
  if (!f) return;
  if (hosted()) {
    const s = local();
    s.events = [...s.events, f].slice(-2000);
    saveLocal(s);
    view = localView();
    renderCard();
    return;
  }
  try { view = await postJSON('/api/chat/feedback', { ...f, ...(rec.turnId ? { turnId: rec.turnId } : {}) }); renderCard(); }
  catch { /* a choice that didn't reach the server is only a lost hint */ }
}

/* ---------- choices → records ---------- */

const classOf = (c, node) => (node && node.route && node.route.taskClass) || (node && node.parent && c.nodes[node.parent] && c.nodes[node.parent].taskClass) || null;
const costOf = (n) => (n && n.usage && typeof n.usage.costUSD === 'number' && !n.usage.notional ? n.usage.costUSD : undefined);

function onChoice(d) {
  const c = d && d.c;
  if (!c || c.kind === 'code' || c.privacy) return; // private chats (G9) teach nothing
  switch (d.kind) {
    case 'keep': {
      const user = d.user;
      const kept = c.nodes[d.keptId];
      const g = user && user.compare;
      if (!kept || !kept.route || !g) return;
      const others = g.ids.filter((id) => id !== d.keptId).map((id) => c.nodes[id]).filter((n) => n && n.route && n.route.model !== kept.route.model && !n.error);
      if (!others.length) return;
      const oc = others.map(costOf).filter((x) => x !== undefined);
      const cls = classOf(c, kept) || others.map((n) => n.route.taskClass).find(Boolean);
      if (!cls) return;
      record({ id: `keep-${user.id}`, kind: 'keep', cls, model: kept.route.model, other: others.map((n) => n.route.model), session: c.id,
        ...(costOf(kept) !== undefined ? { costUSD: costOf(kept) } : {}), ...(oc.length ? { otherCostUSD: oc.reduce((a, b) => a + b, 0) / oc.length } : {}), turnId: kept.turnId });
      return;
    }
    case 'override': {
      // a model you picked for this message, against what the router would have sent it to
      const p = state.preview;
      const pick = p && p.pick;
      if (!pick || !d.model || pick.model === d.model || !p.taskClass) return;
      record({ id: `ov-${d.node ? d.node.id : Date.now()}`, kind: 'override', cls: p.taskClass, model: d.model, other: [pick.model], session: c.id });
      return;
    }
    case 'regenerate': {
      const n = d.node;
      if (!n || !n.route || !d.to || n.route.model === d.to) return;
      record({ id: `re-${n.id}-${d.to}`, kind: 'regenerate', cls: classOf(c, n), model: n.route.model, other: [d.to], session: c.id, turnId: n.turnId });
      return;
    }
    case 'stop': {
      const n = d.node;
      // Stop after it had started writing (a stop before any text is "wrong question", not "wrong model")
      if (!n || !n.route || !n.route.model || n.route.lane || !(n.parts || []).some((x) => x.type === 'text' && x.text.trim()) || Date.now() - (n.startedAt || 0) < 1500) return;
      record({ id: `stop-${n.id}`, kind: 'stop', cls: classOf(c, n), model: n.route.model, session: c.id, turnId: n.turnId });
      return;
    }
    default:
  }
}

/* ---------- thumbs on a reply ---------- */

function thumb(down) {
  const s = svgEl('svg', { class: 'ic', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  const g = svgEl('g', down ? { transform: 'rotate(180 12 12)' } : {});
  g.append(svgEl('path', { d: 'M7.5 10.5v9h-3v-9z' }), svgEl('path', { d: 'M7.5 10.5l3.6-6.4a1.7 1.7 0 0 1 3.1 1.1l-.6 3.8h5.1a2 2 0 0 1 2 2.4l-1.3 6.5a2 2 0 0 1-2 1.6H7.5' }));
  s.append(g);
  return s;
}

/** The reply's 👍 / 👎 (render.js), or null where there's nothing to rate. */
export function feedbackButtons(c, node) {
  if (!c || c.kind === 'code' || c.privacy || !node || !node.route || !node.route.model || node.streaming || node.error || node.route.via === 'claude-code') return null;
  const f = node.feedback;
  return [
    el('button', { type: 'button', class: `iconbtn fb${f === 'up' ? ' on' : ''}`, 'data-act': 'fb-up', 'aria-pressed': String(f === 'up'), title: 'Good answer: the router learns from it', 'aria-label': 'Good answer' }, thumb(false)),
    el('button', { type: 'button', class: `iconbtn fb${f === 'down' ? ' on' : ''}`, 'data-act': 'fb-down', 'aria-pressed': String(f === 'down'), title: 'Not good: the router learns from it', 'aria-label': 'Not a good answer' }, thumb(true)),
  ];
}

function onThumb(e) {
  const b = e.target.closest('[data-act="fb-up"], [data-act="fb-down"]');
  const c = state.current;
  if (!b || !c) return;
  const msg = b.closest('.msg');
  const node = msg && c.nodes[msg.dataset.id];
  if (!node || !node.route) return;
  e.stopPropagation();
  const want = b.dataset.act === 'fb-up' ? 'up' : 'down';
  const cls = classOf(c, node);
  node.feedback = node.feedback === want ? null : want;
  saveConversation(c);
  ui.updateMessage(c, node, { final: true });
  const fb = $('transcript').querySelector(`.msg[data-id="${node.id}"] [data-act="${b.dataset.act}"]`);
  if (fb) fb.focus();
  if (!cls) return;
  if (node.feedback) record({ id: `th-${node.id}`, kind: 'thumbs', cls, model: node.route.model, up: node.feedback === 'up', session: c.id, turnId: node.turnId });
  else record({ id: `th-${node.id}`, kind: 'thumbs', cls, model: node.route.model, clear: true, session: c.id });
  toast(node.feedback ? `Noted${node.feedback === 'up' ? '' : ': the router will lean away from it'} for ${CLASS_WORDS[cls] || 'this kind of task'}` : 'Rating removed');
}

/* ---------- the Route console's card ---------- */

function ensureCard() {
  let card = $('learnedCard');
  if (card) return card;
  const tab = $('tab-Route');
  if (!tab) return null;
  card = el('div', { class: 'icard lp-card', id: 'learnedCard' });
  tab.insertBefore(el('div', { class: 'igrp', id: 'learnedGrp' }, el('div', 'g-t', 'Learned from you'), card), $('scopeNote'));
  return card;
}

function recentRoutes() {
  const out = [];
  for (const c of state.convs) for (const n of Object.values(c.nodes || {})) if (n.role === 'assistant' && n.route && !n.route.lane && n.route.via !== 'claude-code') out.push({ at: n.created || 0, ...n.route });
  return out.sort((a, b) => b.at - a.at);
}

const signed = (x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(1)}`;

function switchRow(on) {
  const input = el('input', { type: 'checkbox', 'aria-label': 'Learn from my choices' });
  input.checked = on;
  input.addEventListener('change', () => setLearn(input.checked).catch((e) => { input.checked = !input.checked; toast(`Couldn’t change it: ${e.message}`); }));
  return el('div', 'prov', el('div', 'grow', el('div', 'p-n', 'Learn from my choices'),
    el('div', 'p-c', on ? 'Your choices nudge each model’s score a little for that kind of task.' : 'Off: your choices are still noted, nothing changes; the report below says what would.')),
  el('label', 'switch', input, el('span', 'tr')));
}

export function renderCard() {
  const card = ensureCard();
  if (!card) return;
  if (!view) { card.replaceChildren(el('div', 'muted', 'Loading…')); return; }
  const on = view.learn !== false;
  const p = view.profile || { cells: [], events: 0 };
  const applied = p.cells.filter((x) => x.applied);
  const watching = p.cells.filter((x) => !x.applied && x.events > 0);
  const kids = [switchRow(on)];
  if (applied.length) {
    kids.push(el('ul', 'lp-rows', ...applied.slice(0, 6).map((x) => el('li', { class: `lp-row ${x.adj > 0 ? 'up' : 'down'}` },
      el('span', 'lp-what', el('b', '', modelName(x.model)), el('span', '', ` for ${CLASS_WORDS[x.cls] || x.cls}`)),
      el('span', { class: 'lp-adj', title: `${signed(x.adj)} capability points for ${CLASS_WORDS[x.cls] || x.cls}${x.capped ? ' (held at the cap)' : ''}` }, signed(x.adj)),
      el('span', 'lp-n', `${x.events} choice${x.events === 1 ? '' : 's'}${x.cheaper ? ` · kept the cheaper ${x.cheaper}×` : ''}${x.capped ? ' · capped' : ''}`)))));
    if (applied.length > 6) kids.push(el('div', 'lp-more', `and ${applied.length - 6} more`));
  } else {
    kids.push(el('p', 'lp-empty', p.events
      ? 'Not enough yet to change anything: a few more choices of the same kind, and it starts to lean.'
      : 'Nothing yet. Keep an answer in Compare, pick a model for a message, try again with another model, or rate a reply with 👍 / 👎.'));
  }
  if (watching.length) kids.push(el('div', 'lp-more', `Watching ${watching.length} more (too few choices to count yet).`));
  const since = view.resetAt ? Date.parse(view.resetAt) : 0;
  const r = shadowReport(recentRoutes().filter((x) => x.at >= since && (!x.learned || x.learned.on === on))); // what it did (on), or would have done (off), since a reset
  if (r.tuned) {
    const verb = on ? 'changed' : 'would have changed';
    const ex = r.examples[0];
    kids.push(el('div', 'lp-shadow', el('b', '', on ? 'What it did' : 'Shadow report'),
      el('span', '', r.changed ? ` It ${verb} ${r.changed} of your last ${r.seen} routed replies${ex && ex.with && ex.without ? `: ${modelName(ex.with.model)} instead of ${modelName(ex.without.model)} for ${CLASS_WORDS[ex.cls] || ex.cls}` : ''}.` : ` It ${on ? 'didn’t change' : 'wouldn’t have changed'} any of your last ${r.seen} routed replies.`)));
  }
  kids.push(el('div', 'lp-foot',
    el('span', 'lp-where', hosted() ? 'Kept in this browser (and your encrypted sync); askeden.com gets only the adjustments.' : 'Kept on this Mac only.'),
    p.events ? el('button', { type: 'button', class: 'cap rev', onclick: (e) => confirmReset(e.currentTarget) }, 'Reset') : null));
  card.classList.toggle('off', !on);
  card.replaceChildren(...kids);
}

function confirmReset(b) {
  if (b.dataset.sure === '1') { reset().catch((e) => toast(`Couldn’t reset: ${e.message}`)); return; }
  b.dataset.sure = '1';
  b.textContent = 'Forget all of it?';
  setTimeout(() => { if (document.contains(b)) { b.dataset.sure = ''; b.textContent = 'Reset'; } }, 4000);
}

/** Settings › Routing: the switch. */
export function learnedSettings() {
  const v = view || (hosted() ? localView() : { learn: true, profile: { cells: [], events: 0 } });
  const n = (v.profile && v.profile.cells.filter((x) => x.applied).length) || 0;
  return el('div', 'set-sec', el('h3', '', 'Learned from you'),
    el('div', 'icard', switchRow(v.learn !== false)),
    el('p', 'sp-note', `${n ? `${n} change${n === 1 ? '' : 's'} so far. ` : ''}Keeping an answer, picking a model, trying again with another, 👍 / 👎 and Stop teach the router what you prefer for each kind of task. ${hosted() ? 'It stays in this browser and your encrypted sync.' : 'It stays on this Mac.'} The Route console shows each change and can reset it.`));
}

export function initLearned() {
  if (hosted()) syncItem(learnSyncItem); // askeden.com: in the account's end-to-end encrypted sync, when it's on
  addEventListener('eden:choice', (e) => onChoice(e.detail));
  $('transcript').addEventListener('click', onThumb, true);
  // fresh whenever the inspector shows (another tab, or a synced device, may have added choices)
  let last = 0;
  const fresh = () => { if (Date.now() - last > 2000) { last = Date.now(); refreshLearned(); } };
  for (const id of ['btnInspector', 'inspSeg']) { const b = $(id); if (b) b.addEventListener('click', fresh); }
  const base = ui.renderInspector;
  ui.renderInspector = (...a) => { base(...a); fresh(); };
  renderCard();
  refreshLearned();
}
