// EVES on the page (Eden Verification & Evaluation System, ROADMAP N13, docs/verify/ui.md).
// The owner turns it Off / On / Auto (Settings › Routing, and the "EVES" chip in the composer's row).
// A message that goes to EVES is POST /api/chat/eves (the contract in docs/verify/README.md): Eden
// asks up to three models, checks the facts they disagree on and gives one answer. On the page:
//   - the chip shows the estimated price (POST /api/chat/eves/estimate, debounced; a failure just
//     means no price, it never blocks sending) and says so when the models are too alike to check each other;
//   - while it runs, a progress line above the reply (Asking 3 models… → … → Writing the answer), a dot
//     per model, Stop, and "Show the work": the three models' own answers, collapsed;
//   - the final answer streams into the normal reply bubble (chat.js appends its text like any reply),
//     with a badge under it: "Checked by 3 models · 2 agreed · 1 corrected · 1 claim unverified", which
//     opens to the agreement, each claim and its evidence, what was changed, the checks and the cost.
// The run's state is node.eves (eves-model.js reduces the events into it; it is kept with the reply, so a
// reload still shows the badge). chat.js runs the turn (runEves); this file is the DOM and the stream's
// wiring. Everything from the server is data: it goes in as text, links are http(s) only.

import { $, el, ico, toast, debounce, setSeg } from './util.js';
import { state, ui, saveSettings, path } from './state.js';
import { streamSSE, postJSON } from './api.js';
import { routeSettings } from './router.js';
import { privacyOn } from './privacy.js';
import { macBody } from './files.js';
import { browserBody } from './browser-agent.js';
import { needsCurrentInfo } from './autosearch-rules.js';
import { renderMarkdown } from './markdown.js';
import { isTainted } from './guard.js';
import {
  EVES_HELP, EVES_MODES, MODE_INFO, normalizeMode, evesOffered, evesApplies, personalMaterial, wantsEves, chipView, estimateView, evesBody, newState, applyEvent, finish, markStopped, markError,
  reviveState, STAGES, stageSteps, liveText, laneView, badgeView, detailView, usageOf, independenceNote, safeLink,
} from './eves-model.js';
import { findingsView, findingsSummary } from './verify-model.js';
import { initVerify, linkEl } from './verify.js';
import { glassPill, toneOfLabel, phraseOfLabel } from './glass.js';

let H = { openMenu: () => {}, closeMenu: () => {} }; // from composer.js

/* ---------- the setting ---------- */

/** The server runs EVES (GET /api/chat/meta `eves: true`). Without it there is no switch, no setting, and no message goes to /api/chat/eves. */
export const evesAvailable = () => evesOffered(state.meta);
/** Off when the server doesn't offer EVES, whatever an earlier session saved. */
export const evesMode = () => (evesAvailable() ? normalizeMode(state.settings.eves) : 'off');
export function setEvesMode(mode, { quiet = false } = {}) {
  const m = normalizeMode(mode);
  if (m === evesMode()) { renderEvesChip(); return; }
  if (m === 'off') delete state.settings.eves; else state.settings.eves = m;
  saveSettings();
  est = null;
  scheduleEstimate();
  ui.renderComposer();
  if (!quiet) toast(m === 'off' ? 'EVES is off: replies are answered as usual' : m === 'on' ? 'EVES is on: several models answer and Eden checks the facts they disagree on' : 'EVES is on Auto: Eden checks questions where a wrong fact would matter');
}
/** What a normal chat send carries when EVES is not Off, so the server sees the setting; nothing when Off. */
export function withEvesSetting(settings) { const m = evesMode(); return m === 'off' ? settings : { ...settings, eves: m }; }

const factual = (t) => needsCurrentInfo(t);

/**
 * The person's own material this message would carry (personalMaterial): attachments and context blocks on it and on
 * every earlier message of the chat (they all go with it), or, while typing, the chat so far plus the draft's own.
 */
function materialNow(c, user) {
  const attachments = [];
  const context = [];
  if (c) {
    for (const n of path(c)) {
      if (n.role !== 'user') continue;
      attachments.push(...(n.attachments || []));
      context.push(...(n.context || []));
      if (user && n.id === user.id) break;
    }
  }
  if (!user) {
    context.push(...(state.draftContext || []));
    // the composer's own attachment chips (files and images; not context, the persona or the Mac's chips)
    const box = document.getElementById('jc-attach');
    if (box) for (const n of box.querySelectorAll('.jc-thumb-img, .jc-file-chip:not(.ctx):not(.persona):not(.mac-chip)')) attachments.push({ kind: n.classList.contains('jc-thumb-img') ? 'image' : 'file' });
  }
  return personalMaterial({ attachments, context });
}

function appliesNow(user = null) {
  const c = state.current;
  const hasMac = !!c && Object.keys(macBody(c)).length > 0;
  const browser = !!browserBody(user || {}).browser;
  return evesApplies({
    kind: c ? c.kind : 'chat', chatMode: c ? c.mode || 'chat' : state.pendingMode || 'chat', mac: hasMac, browser, course: !!(c && c.course),
    material: materialNow(c, user), privacy: privacyOn(c),
  });
}

/** The server's risk class for this exact text, from the estimate (POST /api/chat/eves/estimate), or null. */
const serverRisk = (text) => (est && est.data && !est.loading && est.text === String(text || '').trim() && est.data.risk && typeof est.data.risk === 'object' ? est.data.risk : null);

const told = new Set();
/**
 * Does this message go to EVES? → { mode: 'on' | 'auto', models } or null (answered as usual).
 * Called when a reply is started (chat.js), so the estimate the chip showed is read now: `models` are
 * the lanes it priced, which is what runs. Auto sends only a question the page's own rule calls risky
 * (eves-model.js riskReasons, autosearch-rules.js needsCurrentInfo); the server's risk class has the final say.
 */
export function evesWanted(c, user, text) {
  const mode = evesMode();
  if (mode === 'off') return null;
  const applies = appliesNow(user);
  if (!applies.ok) {
    if (c && c.kind !== 'code' && !told.has(applies.why)) { told.add(applies.why); toast(`EVES is on, but not for this message. ${applies.why}`); }
    return null;
  }
  const m = wantsEves({ mode, applies, text, factual, risk: serverRisk(text) });
  if (!m) return null;
  const t = String(text || '').trim();
  const ev = est && est.data && !est.loading && est.text === t ? estimateView(est.data, { privacy: privacyOn(c) }) : null;
  return { mode: m, models: ev && !privacyOn(c) ? ev.pins : undefined };
}

/* ---------- the estimate (POST /api/chat/eves/estimate, debounced like Compare's) ---------- */

let draft = '';
let est = null; // { text, mode, loading, data | error }
let estAbort = null;

/**
 * A draft is priced when it would go to EVES; on Auto every draft that EVES could take is asked about, because the
 * estimate also brings the server's risk class (the page's own rule is narrower), and that decides Auto too.
 * The estimate is rules only: no model is called and nothing is charged.
 */
const estimateWanted = () => {
  const text = draft.trim();
  const mode = evesMode();
  const applies = appliesNow();
  if (!text || !applies.ok) return false;
  return mode === 'auto' || wantsEves({ mode, applies, text, factual }) !== null;
};
const runEstimate = debounce(async () => {
  if (estAbort) estAbort.abort();
  if (!estimateWanted()) { estAbort = null; est = null; renderEvesChip(); return; }
  const text = draft.trim();
  const mode = evesMode();
  const mine = new AbortController();
  estAbort = mine;
  est = { text, mode, loading: true, data: est && est.text === text ? est.data : null };
  renderEvesChip();
  try {
    const data = await postJSON('/api/chat/eves/estimate', { prompt: text, settings: routeSettings(), mode, ...(privacyOn(state.current) ? { privacy: true } : {}) }, { signal: mine.signal });
    if (mine !== estAbort) return;
    est = { text, mode, loading: false, data };
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    if (mine !== estAbort) return;
    est = { text, mode, loading: false, error: e && e.message ? e.message : 'no estimate' }; // no price; sending is never blocked
  }
  renderEvesChip();
}, 600);
function scheduleEstimate() {
  if (!estimateWanted()) { if (estAbort) estAbort.abort(); estAbort = null; est = null; renderEvesChip(); return; }
  if (est && est.text === draft.trim() && est.mode === evesMode() && !est.error && !est.loading) { renderEvesChip(); return; }
  runEstimate();
  renderEvesChip();
}
/** The composer's text changed (composer.js): price the new draft once typing pauses. */
export function setEvesDraft(text) {
  draft = String(text || '');
  if (!draft.trim()) { if (estAbort) estAbort.abort(); estAbort = null; est = null; renderEvesChip(); return; }
  scheduleEstimate();
}
addEventListener('eden:reroute', () => { est = null; scheduleEstimate(); }); // the settings that shape the lanes changed

/* ---------- the chip in the composer's row, and its menu ---------- */

/** Redraw the chip (composer.js calls this with every composer render). */
export function renderEvesChip() {
  const b = $('jc-eves');
  if (!b) return;
  if (!evesAvailable()) { b.hidden = true; document.body.classList.remove('eves-draft'); return; } // a server without EVES: the switch isn't drawn at all
  const c = state.current;
  const mode = evesMode();
  const text = draft.trim();
  const applies = appliesNow();
  const wouldRun = wantsEves({ mode, applies, text, factual, risk: serverRisk(text) }) !== null;
  const v = chipView({ mode, applies, wouldRun, est: est && est.data ? est.data : est && est.error ? { error: true } : null, loading: !!(est && est.loading), hasText: !!text });
  b.hidden = !!(c && c.kind === 'code');
  // this draft goes to EVES: the router's own pick and price above the input (compare.js) would be about a reply that won't be written
  document.body.classList.toggle('eves-draft', !!text && applies.ok && wouldRun && !state.turnOverride);
  b.dataset.mode = v.tone;
  b.classList.toggle('weak', v.weak);
  const sub = $('jc-eves-sub');
  if (sub.textContent !== v.sub) sub.textContent = v.sub;
  b.title = v.title;
  b.setAttribute('aria-label', v.ariaLabel);
}

function openChipMenu(anchor) {
  const mode = evesMode();
  const applies = appliesNow();
  const ev = est && est.data ? estimateView(est.data, { privacy: privacyOn(state.current) }) : null;
  const items = [{ heading: 'EVES · check the facts' }];
  for (const m of EVES_MODES) {
    const price = m === 'on' && ev && ev.price && estimateWanted() ? ` · ${ev.price} for this message` : '';
    items.push({ label: MODE_INFO[m].label, note: `${MODE_INFO[m].note}${price}`, checked: mode === m, run: () => setEvesMode(m) });
  }
  items.push('-', { foot: EVES_HELP });
  if (mode !== 'off' && !applies.ok) items.push({ foot: applies.why });
  if (ev && ev.weak && ev.note) items.push({ foot: ev.note }, { icon: 'key', label: 'Add another provider’s key…', run: () => dispatchEvent(new CustomEvent('eden:open-settings', { detail: { tab: 0 } })) });
  H.openMenu(anchor, items);
}

/* ---------- Settings › Routing ---------- */

/** The EVES section of Settings › Routing. */
export function evesSettings() {
  if (!evesAvailable()) return null; // no EVES on this server: no section in Settings
  const mode = evesMode();
  const note = el('div', { class: 'p-c eves-set-note', 'aria-live': 'polite' }, MODE_INFO[mode].note);
  const seg = el('div', { class: 'seg', style: { '--n': 3 }, role: 'radiogroup', 'aria-label': 'EVES' }, el('div', 'seg-thumb'),
    ...EVES_MODES.map((m, i) => el('button', { type: 'button', role: 'radio', 'aria-checked': String(m === mode), class: m === mode ? 'on' : '', onclick: () => { setEvesMode(m); setSeg(seg, i); note.textContent = MODE_INFO[m].note; } }, MODE_INFO[m].label)));
  const sec = el('div', 'set-sec eves-set', el('h3', '', 'EVES · check the facts'),
    el('div', 'icard', el('div', 'prov', el('div', 'grow', el('div', 'p-n', 'Have several models check each other'), el('div', 'p-c', EVES_HELP)), seg), el('div', 'prov', el('div', 'grow', note))),
    el('p', 'sp-note', 'Each reply shows a badge saying what was checked, and “Show the work” opens what each model said. EVES works in plain Chat; Code, Search, Research and Compare keep their own ways. The checks are stronger with keys from more than one provider (API keys).'));
  setSeg(seg, EVES_MODES.indexOf(mode));
  return sec;
}

/* ---------- the run ---------- */

export const evesApi = {
  stop: (id, lane) => postJSON('/api/chat/eves/stop', { id, lane }),
};

function appendText(node, text) {
  const parts = node.parts || (node.parts = []);
  const last = parts.at(-1);
  if (last && last.type === 'text') last.text += text;
  else parts.push({ type: 'text', text });
}

let live = null; // the status region for screen readers: the step now, announced when it changes
function announce(text) { if (live && text && live.textContent !== text) live.textContent = text; }

/**
 * The run of one EVES reply. chat.js (runEves) makes it, sends the body with turn.send(), and the events
 * go into node.eves (the state) and, for the final answer, into the reply itself. `onChange` repaints.
 */
export function beginEves(node, plan, ctrl, onChange) {
  const s = (node.eves = newState(plan.mode));
  let lastStage = '';
  const sync = () => {
    const u = usageOf(s);
    if (u) node.usage = u;
    if (s.error && !node.error) node.error = s.error;
    const say = liveText(s, true);
    if (say !== lastStage) { lastStage = say; announce(say); }
  };
  const turn = {
    state: s,
    /** The body for POST /api/chat/eves from the body a normal reply would send; resolves when the stream ends. */
    send: (base) => streamSSE('/api/chat/eves', evesBody(base, plan), { signal: ctrl.signal, onEvent: turn.onEvent }),
    onEvent(type, d) {
      const data = d && typeof d === 'object' ? d : {};
      if (type === 'provenance') node.provenance = data;
      else if (data.lane === 'final') {
        if (type === 'text') appendText(node, String(data.text || ''));
        else if (type === 'citations') {
          const seen = new Set((node.citations || []).map((x) => x.url));
          for (const x of Array.isArray(data.sources) ? data.sources : []) { const k = x && safeLink(x.url); if (k && !seen.has(k.href)) { (node.citations || (node.citations = [])).push({ title: String(x.title || ''), url: k.href }); seen.add(k.href); } }
        } else if (type === 'done') node.finish = data.finish || 'stop';
      }
      applyEvent(s, type, data);
      sync();
      onChange(); // chat.js's paint: one repaint per frame at most
    },
    /** Stop everything: ask the server to stop each running model and the judge, then close the stream. */
    stop() {
      if (s.id) {
        for (const l of s.lanes) if (l.status === 'waiting' || l.status === 'thinking' || l.status === 'writing') evesApi.stop(s.id, l.i).catch(() => {});
        evesApi.stop(s.id, 'judge').catch(() => {});
      }
      ctrl.abort();
    },
    /** Stop one model (its words stay; the check goes on with the others). */
    async stopLane(i) {
      const l = s.lanes[i];
      if (!l || !(l.status === 'waiting' || l.status === 'thinking' || l.status === 'writing')) return;
      try { if (!s.id) throw new Error('not started'); await evesApi.stop(s.id, i); } catch { applyEvent(s, 'done', { lane: i, finish: 'aborted' }); onChange(); }
    },
    stopped() { markStopped(s); sync(); },
    failed(message) { markError(s, message); sync(); },
    end() { finish(s); sync(); const b = badgeView(s, false); announce(b.show ? b.text : liveText(s, false)); },
  };
  return turn;
}

/* ---------- drawing ---------- */

/** Panels the person opened, by reply: `${node.id}:${what}` (a reply is drawn again while it streams and after). */
const opened = new Set();
const isOpen = (id, what) => opened.has(`${id}:${what}`);
const domId = (what, nodeId) => `eves-${String(what).replace(/[^\w-]/g, '-')}-${nodeId}`;
const setText = (n, t) => { if (n.textContent !== t) n.textContent = t; };

function toggleBtn(node, what, act, cls, kids, extra = {}) {
  const open = isOpen(node.id, what);
  return el('button', { type: 'button', class: cls, 'data-act': act, 'data-what': what, 'aria-expanded': String(open), 'aria-controls': domId(what, node.id), ...extra }, ...kids);
}
/** "Show the work · 3 answers": the label is its own span so it can change in place. */
function workToggle(node, s) {
  const open = isOpen(node.id, 'work');
  const n = s.lanes.filter((l) => l.text.trim()).length;
  return toggleBtn(node, 'work', 'eves-work', 'eves-toggle', [el('span', 'eves-toggle-l', open ? 'Hide the work' : 'Show the work'), el('span', 'eves-toggle-n', n ? `${n} answer${n === 1 ? '' : 's'}` : ''), ico('chevr', 11, 'eves-chev')]);
}

function noteEl(s) {
  const p = s.plan;
  if (!p) return null;
  const note = independenceNote(p.independence, { privacy: p.privacy });
  const kids = [];
  if (note) kids.push(el('span', '', note));
  if (note && !p.privacy) kids.push(' ', el('button', { type: 'button', class: 'eves-link', 'data-act': 'eves-keys' }, 'Open Settings'));
  if (p.privacy) kids.push(el('span', '', ' Privacy mode: only models on this Mac answer, and nothing is looked up on the web.'));
  return kids.length ? kids : null;
}

function sourceLinks(list) {
  return el('ul', 'eves-lane-src', ...list.slice(0, 8).map((c) => el('li', '', linkEl(c.url, c.title || c.url))));
}
function laneBody(node, l, v) {
  if (l.text.trim()) { const md = el('div', 'md'); md.append(renderMarkdown(l.text, { untrusted: isTainted(node) })); return md; }
  return el('p', 'eves-lane-empty', v.running ? 'Waiting for the first words…' : l.error || 'No answer.');
}

/** One model's own answer, as the work panel shows it once the run is over. */
function laneCard(node, l) {
  const v = laneView(l);
  const head = el('header', 'eves-lane-h', el('i', { class: `pdot ${v.provider}`, 'aria-hidden': 'true' }), el('b', 'eves-lane-nm', v.name), el('span', 'eves-lane-meta', v.meta), el('span', 'eves-lane-st', v.statusText));
  const body = el('div', { class: 'eves-lane-body', tabindex: '0', role: 'region', 'aria-label': `${v.name}’s answer`, 'data-lane': String(l.i) }, laneBody(node, l, v));
  const card = el('article', { class: 'eves-lane', 'data-state': l.status, 'aria-label': `${v.name}: ${v.statusText}` }, head, body);
  if (l.truncated) card.append(el('p', 'eves-lane-note', 'Only the first part of this answer is kept here.'));
  if (l.citations.length) card.append(sourceLinks(l.citations));
  return card;
}
function workPanel(node, s) {
  const open = isOpen(node.id, 'work');
  const box = el('div', { class: 'eves-work', id: domId('work', node.id), hidden: !open, role: 'group', 'aria-label': 'What each model said' });
  if (open) fillWork(box, node, s);
  return box;
}
function fillWork(box, node, s) {
  box.replaceChildren(el('div', 'eves-lanes', ...s.lanes.map((l) => laneCard(node, l))));
}

/* ---- while it runs: one view per reply, kept and updated in place ----
 * A running reply is drawn again with every burst of words (chat.js paint), and a button that is replaced
 * between the mouse going down and coming up never gets its click. So the progress line, its buttons and
 * the models' boxes are made once and moved into each new drawing of the reply, changing only what changed. */

const runViews = new Map(); // node.id → view

function buildRunView(node) {
  const ol = el('ol', { class: 'eves-steps', 'aria-label': 'EVES progress' });
  const stepLis = STAGES.map((id, i) => {
    const li = el('li', { class: 'eves-step pending' }, el('i', { class: 'eves-pip', 'aria-hidden': 'true' }), el('span', 'eves-step-t'), el('span', 'sr-only'));
    if (i) ol.append(el('li', { class: 'eves-arrow', 'aria-hidden': 'true' }, '→'));
    ol.append(li);
    return li;
  });
  const count = el('span', { class: 'eves-count', 'aria-hidden': 'true' });
  const stop = el('button', { type: 'button', class: 'cap eves-stop', 'data-act': 'eves-stop', title: 'Stop (Esc)' }, 'Stop');
  const dots = el('ul', { class: 'eves-dots', 'aria-label': 'The models' });
  const note = el('p', { class: 'eves-note', hidden: true });
  const lanesBox = el('div', 'eves-lanes');
  const work = el('div', { class: 'eves-work', id: domId('work', node.id), hidden: true, role: 'group', 'aria-label': 'What each model said' }, lanesBox);
  const toggle = workToggle(node, { lanes: [] });
  const root = el('section', { class: 'eves-run', 'data-act': 'eves-chrome', 'aria-label': 'EVES is checking this answer' },
    el('div', 'eves-run-top', el('div', 'eves-steps-wrap', ol, count), stop),
    el('div', 'eves-run-sub', toggle, dots), note, work);
  return { root, stepLis, count, toggle, dots, dotLis: [], note, noteFor: null, work, lanesBox, cards: [] };
}

function liveCard(i) {
  const dot = el('i', { class: 'pdot', 'aria-hidden': 'true' });
  const nm = el('b', 'eves-lane-nm');
  const meta = el('span', 'eves-lane-meta');
  const st = el('span', 'eves-lane-st');
  const stop = el('button', { type: 'button', class: 'cap', 'data-act': 'eves-lane-stop', 'data-lane': String(i) }, 'Stop');
  const body = el('div', { class: 'eves-lane-body', tabindex: '0', role: 'region', 'data-lane': String(i) });
  const src = el('div', 'eves-lane-srcbox');
  const card = el('article', { class: 'eves-lane' }, el('header', 'eves-lane-h', dot, nm, meta, st, stop), body, src);
  return { card, dot, nm, meta, st, stop, body, src, text: -1, status: '', cites: -1, at: 0 };
}

function updateCard(c, node, l, now) {
  const v = laneView(l, now);
  if (c.card.dataset.state !== l.status) c.card.dataset.state = l.status;
  c.card.setAttribute('aria-label', `${v.name}: ${v.statusText}`);
  const dc = `pdot ${v.provider}`;
  if (c.dot.className !== dc) c.dot.className = dc;
  setText(c.nm, v.name);
  setText(c.meta, v.meta);
  setText(c.st, v.statusText);
  c.stop.hidden = !v.running;
  c.stop.setAttribute('aria-label', `Stop ${v.name}`);
  c.body.setAttribute('aria-label', `${v.name}’s answer`);
  // the words: drawn again when they changed, at most four times a second while they stream
  if ((c.text !== l.text.length || c.status !== l.status) && (now - c.at > 250 || !v.running || c.text < 0)) {
    const stick = c.text < 0 || c.body.scrollHeight - c.body.scrollTop - c.body.clientHeight < 24;
    c.body.replaceChildren(laneBody(node, l, v));
    if (stick) c.body.scrollTop = c.body.scrollHeight;
    c.text = l.text.length;
    c.status = l.status;
    c.at = now;
  }
  if (c.cites !== l.citations.length) { c.src.replaceChildren(...(l.citations.length ? [sourceLinks(l.citations)] : [])); c.cites = l.citations.length; }
}

function updateRunView(v, node, s) {
  const now = Date.now();
  const steps = stageSteps(s, true);
  const at = Math.max(0, steps.findIndex((x) => x.status === 'active'));
  steps.forEach((st, i) => {
    const li = v.stepLis[i];
    const cls = `eves-step ${st.status}`;
    if (li.className !== cls) li.className = cls;
    if (st.status === 'active') li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    setText(li.children[1], st.text);
    setText(li.children[2], st.status === 'done' ? ' (done)' : st.status === 'skipped' ? ' (not needed)' : '');
  });
  setText(v.count, `${at + 1}/${steps.length}`);
  // a dot per model
  if (v.dotLis.length !== s.lanes.length) {
    v.dotLis = s.lanes.map(() => el('li', { class: 'eves-ldot' }, el('i', { class: 'pdot', 'aria-hidden': 'true' }), el('span', 'nm'), el('span', 'st')));
    v.dots.replaceChildren(...v.dotLis);
  }
  s.lanes.forEach((l, i) => {
    const lv = laneView(l, now);
    const li = v.dotLis[i];
    const cls = `eves-ldot ${l.status}`;
    if (li.className !== cls) li.className = cls;
    li.title = lv.short;
    const pd = `pdot ${lv.provider}`;
    if (li.firstChild.className !== pd) li.firstChild.className = pd;
    setText(li.children[1], lv.name);
    setText(li.children[2], lv.word);
  });
  // the independence note, once the plan is known
  if (s.plan && v.noteFor !== s.plan) {
    v.noteFor = s.plan;
    const kids = noteEl(s);
    v.note.hidden = !kids;
    v.note.replaceChildren(...(kids || []));
  }
  // the work
  const open = isOpen(node.id, 'work');
  const n = s.lanes.filter((l) => l.text.trim()).length;
  setText(v.toggle.querySelector('.eves-toggle-l'), open ? 'Hide the work' : 'Show the work');
  setText(v.toggle.querySelector('.eves-toggle-n'), n ? `${n} answer${n === 1 ? '' : 's'}` : '');
  v.toggle.setAttribute('aria-expanded', String(open));
  v.work.hidden = !open;
  if (open) {
    while (v.cards.length < s.lanes.length) { const c = liveCard(v.cards.length); v.cards.push(c); v.lanesBox.append(c.card); }
    s.lanes.forEach((l, i) => updateCard(v.cards[i], node, l, now));
  }
}

/** The progress line above the reply while it runs (the same element every time, moved into the new drawing). */
function runPanel(node, s) {
  let v = runViews.get(node.id);
  if (!v) { v = buildRunView(node); runViews.set(node.id, v); }
  updateRunView(v, node, s);
  return v;
}

/* ---- the badge and its detail ---- */

function tonePip(tone) { return el('i', { class: `eves-pip tone-${tone}`, 'aria-hidden': 'true' }); }

function sourcesEl(list) {
  return el('ul', 'eves-src', ...list.map((x) => el('li', '', x.href ? linkEl(x.href, x.title) : el('span', '', x.title), x.host && x.href ? el('span', 'eves-src-h', ` ${x.host}`) : null)));
}

function claimRow(node, c) {
  const what = `claim:${c.id}`;
  const open = isOpen(node.id, what);
  const sum = [c.statusText, c.verdict !== 'unverifiable' || c.status !== 'agreed' ? c.verdictText : ''].filter(Boolean);
  const more = el('div', { class: 'eves-claim-more', id: domId(what, node.id), hidden: !open });
  if (c.by.length) more.append(el('p', '', el('b', '', 'Said by: '), c.by.join(', ')));
  if (c.against.length) more.append(el('p', '', el('b', '', 'Disagreed: '), c.against.join(', ')));
  if (c.evidence && c.evidence.summary) more.append(el('p', '', el('b', '', 'Evidence: '), el('span', { 'data-no-i18n': '' }, c.evidence.summary)));
  if (c.evidence && c.evidence.sources.length) more.append(sourcesEl(c.evidence.sources));
  if (c.correction) more.append(el('p', '', el('b', '', c.outcome === 'added' ? 'Added: ' : c.correction.action === 'fix' ? 'Corrected: ' : c.correction.action === 'strike' ? 'Removed: ' : 'Marked unverified: '), el('span', { 'data-no-i18n': '' }, c.correction.reason || '')));
  if (c.correction && c.correction.replacement) more.append(el('p', '', el('b', '', c.outcome === 'added' ? 'Added to the answer: ' : 'Now says: '), el('span', { 'data-no-i18n': '' }, c.correction.replacement)));
  const hasMore = more.childElementCount > 0;
  return el('li', { class: 'eves-claim', 'data-tone': c.tone },
    hasMore
      ? toggleBtn(node, what, 'eves-claim', 'eves-claim-h', [tonePip(c.tone), el('span', { class: 'eves-claim-t', 'data-no-i18n': '' }, c.text), el('span', 'eves-claim-s', sum.join(' · ')), ico('chevr', 10, 'eves-chev')])
      : el('div', 'eves-claim-h static', tonePip(c.tone), el('span', { class: 'eves-claim-t', 'data-no-i18n': '' }, c.text), el('span', 'eves-claim-s', sum.join(' · '))),
    hasMore ? more : null);
}

function correctionRow(node, c) {
  const what = `corr:${c.claimId}`;
  const open = isOpen(node.id, what);
  const shown = c.original.length > 110 ? `${c.original.slice(0, 109).trimEnd()}…` : c.original;
  const more = el('div', { class: 'eves-claim-more', id: domId(what, node.id), hidden: !open });
  if (c.original) more.append(el('p', '', el('b', '', c.added ? 'The claim: ' : 'The original sentence: '), el('q', { 'data-no-i18n': '' }, c.original)));
  if (c.replacement) more.append(el('p', '', el('b', '', c.added ? 'Added to the answer: ' : 'Now says: '), el('span', { 'data-no-i18n': '' }, c.replacement)));
  if (c.reason) more.append(el('p', '', el('b', '', 'Why: '), el('span', { 'data-no-i18n': '' }, c.reason)));
  return el('li', { class: 'eves-corr' },
    toggleBtn(node, what, 'eves-corr', 'eves-claim-h eves-corr-h', [el('b', 'eves-verb', `${c.verb}:`), shown || c.reason ? el('span', { class: 'eves-claim-t', 'data-no-i18n': '' }, shown || c.reason) : el('span', 'eves-claim-t', 'a claim'), ico('chevr', 10, 'eves-chev')]), more);
}

function detailEl(node, s, d) {
  const id = domId('badge', node.id);
  const box = el('div', { class: 'eves-detail', id, hidden: !isOpen(node.id, 'badge'), role: 'group', 'aria-label': 'What EVES checked' });
  if (d.notVerified) box.append(el('p', 'eves-callout', d.notVerified));
  if (d.agreement) box.append(el('p', 'eves-line', el('b', '', 'Agreement: '), d.agreement.text));
  if (d.summary) box.append(el('p', { class: 'eves-line', 'data-no-i18n': '' }, d.summary)); // the judge's own words
  if (d.winner) box.append(el('p', 'eves-line', d.winner));
  if (d.note) box.append(el('p', 'eves-line', d.note));
  if (d.claims.length) box.append(el('p', 'eves-sub', `Claims (${d.claims.length})`), el('ul', 'eves-claims', ...d.claims.map((c) => claimRow(node, c))));
  if (d.corrections.length) box.append(el('p', 'eves-sub', 'Changes made to the answer'), el('ul', 'eves-claims', ...d.corrections.map((c) => correctionRow(node, c))));
  if (d.struck.length) box.append(el('p', 'eves-sub', 'Taken out of the answer'), el('ul', 'eves-struck', ...d.struck.map((t) => el('li', '', el('q', { 'data-no-i18n': '' }, t)))));
  const checks = findingsView(d.checks);
  if (checks.length) {
    const what = 'more';
    const open = isOpen(node.id, what);
    const sum = findingsSummary(checks);
    box.append(el('p', 'eves-sub', 'Checks Eden ran', sum ? el('span', 'eves-sub-n', ` · ${sum}`) : null),
      el('ul', 'eves-checks', ...checks.slice(0, open ? checks.length : 5).map((f) => el('li', { class: 'eves-check', 'data-tone': f.tone },
        el('span', 'eves-check-st', f.statusText), el('span', 'eves-check-t', el('b', '', f.checkName), f.subject ? ' ' : '', f.subject ? el('span', { 'data-no-i18n': '' }, f.subject) : '', f.detail ? ' — ' : '', f.detail ? el('span', { 'data-no-i18n': '' }, f.detail) : ''), f.sentence ? el('q', { class: 'eves-check-q', 'data-no-i18n': '' }, f.sentence) : null))));
    if (checks.length > 5) box.append(el('button', { type: 'button', class: 'eves-link', 'data-act': 'eves-more', 'data-what': what, 'aria-expanded': String(open) }, open ? 'Show fewer' : `Show all ${checks.length}`));
  }
  const foot = [d.judge, d.total, d.added].filter(Boolean);
  if (d.models.length) box.append(el('p', 'eves-sub', 'The models'), el('ul', 'eves-models', ...d.models.map((m) => el('li', '', el('i', { class: `pdot ${m.provider}`, 'aria-hidden': 'true' }), el('b', '', m.name), ` ${m.statusText}${m.meta ? ` · ${m.meta}` : ''}`))));
  if (foot.length) box.append(el('p', 'eves-foot-line', ...foot.flatMap((x, i) => (i ? [' ', x] : [x])))); // one text node per sentence, so each can be translated
  for (const n of d.notes) box.append(el('p', 'eves-foot-line', n));
  return box;
}

function badgeEl(node, s, b) {
  const d = detailView(s, false);
  const box = el('div', { class: 'eves-badge vf-sev', 'data-sev': b.severity, 'data-kind': b.kind });
  const pill = glassPill({ tag: 'button', tone: toneOfLabel(b.kind, b.severity), sub: phraseOfLabel(b.kind, b.text), full: b.text, prefix: b.srPrefix, className: 'eves-badge-btn', attrs: { type: 'button', 'data-act': 'eves-badge', 'data-what': 'badge', 'aria-expanded': String(isOpen(node.id, 'badge')), 'aria-controls': domId('badge', node.id) } }); // the glass pill (glass.js)
  const panel = detailEl(node, s, d);
  panel.prepend(el('p', 'eves-line', b.text)); // the whole sentence the pill shortens
  box.append(pill, panel);
  return box;
}

/** Under the answer once the run is over: the badge, and "Show the work". */
function foot(node, s) {
  const b = badgeView(s, false);
  const hasWork = s.lanes.some((l) => l.text.trim());
  if (!b.show && !hasWork) return null;
  return el('div', { class: 'eves-foot', 'data-act': 'eves-chrome' },
    b.show ? badgeEl(node, s, b) : null,
    hasWork ? el('div', 'eves-work-row', workToggle(node, s)) : null,
    hasWork ? workPanel(node, s) : null);
}

/**
 * Adds EVES's parts to a reply's message element (app.js calls this for every message it draws): the
 * progress line above the bubble while it runs, the badge and the work under it. A reply the server
 * didn't run EVES for (Auto decided it wasn't needed) looks like any other.
 */
export function decorateEves(m, c, node) {
  if (!node || node.role !== 'assistant' || !node.eves) return m;
  const s = node.streaming ? node.eves : reviveOnce(node);
  if (!s || s.skipped) return m;
  const bubble = m.querySelector(':scope > .bubble');
  if (!bubble) return m;
  m.classList.add('eves');
  if (node.streaming) {
    m.classList.add('eves-live');
    if (!(node.parts || []).some((p) => p.type === 'text' && p.text) && !node.error) m.classList.add('eves-empty');
    const v = runPanel(node, s);
    const keep = v.cards.map((c) => ({ top: c.body.scrollTop, stick: c.body.scrollHeight - c.body.scrollTop - c.body.clientHeight < 24 })); // read while it is still in the old drawing
    bubble.before(v.root);
    queueMicrotask(() => v.cards.forEach((c, i) => { c.body.scrollTop = keep[i].stick ? c.body.scrollHeight : keep[i].top; })); // moving an element resets its scroll
  } else {
    runViews.delete(node.id);
    const f = foot(node, s);
    if (f) bubble.after(f);
  }
  return m;
}

/** A reply read back from storage: its state cleaned once (it may come from another device). */
function reviveOnce(node) {
  const e = node.eves;
  if (e && e._ok) return e;
  const s = reviveState(e);
  if (!s) { node.eves = null; return null; }
  Object.defineProperty(s, '_ok', { value: true, enumerable: false });
  node.eves = s;
  return s;
}

/* ---------- clicks ---------- */

function onClick(e) {
  const b = e.target.closest('[data-act]');
  if (!b || !b.dataset.act.startsWith('eves-')) return;
  const c = state.current;
  const msg = b.closest('.msg');
  const node = c && msg ? c.nodes[msg.dataset.id] : null;
  if (!node) return;
  switch (b.dataset.act) {
    case 'eves-badge': case 'eves-work': case 'eves-claim': case 'eves-corr': {
      const what = b.dataset.what;
      const on = b.getAttribute('aria-expanded') !== 'true';
      b.setAttribute('aria-expanded', String(on));
      if (on) opened.add(`${node.id}:${what}`); else opened.delete(`${node.id}:${what}`);
      const panel = document.getElementById(b.getAttribute('aria-controls'));
      if (panel) {
        panel.hidden = !on;
        if (what === 'work' && node.eves) {
          const lbl = b.querySelector('.eves-toggle-l');
          if (lbl) lbl.textContent = on ? 'Hide the work' : 'Show the work';
          const v = runViews.get(node.id);
          if (v) updateRunView(v, node, node.eves); // running: its boxes are kept, this builds them now
          else if (on) fillWork(panel, node, node.eves);
        }
      }
      break;
    }
    case 'eves-more': {
      const what = b.dataset.what;
      if (opened.has(`${node.id}:${what}`)) opened.delete(`${node.id}:${what}`); else opened.add(`${node.id}:${what}`);
      ui.updateMessage(c, node);
      const again = $('transcript').querySelector(`.msg[data-id="${node.id}"] [data-act="eves-more"]`);
      if (again) again.focus();
      break;
    }
    case 'eves-stop': { const st = state.streams.get(c.id); if (st) st.abort(); break; }
    case 'eves-lane-stop': { const st = state.streams.get(c.id); if (st && st.stopLane) st.stopLane(Number(b.dataset.lane)); break; }
    case 'eves-keys': dispatchEvent(new CustomEvent('eden:open-settings', { detail: { tab: 0 } })); break;
    default: return;
  }
  e.stopPropagation();
}

let started = false;
/** From composer.js (once): the menus, the status region, the clicks. */
export function initEves(handlers) {
  H = { ...H, ...handlers };
  initVerify();
  if (started) return;
  started = true;
  live = el('div', { id: 'eves-live', class: 'sr-only', role: 'status', 'aria-live': 'polite' });
  document.body.append(live);
  const tr = $('transcript');
  tr.addEventListener('click', onClick);
  const chip = $('jc-eves');
  if (chip) chip.addEventListener('click', () => { if (chip.getAttribute('aria-expanded') === 'true') H.closeMenu(true); else openChipMenu(chip); });
  renderEvesChip();
}
