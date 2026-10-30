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

import { $, el, ico, svgEl, toast, debounce, setSeg } from './util.js';
import { state, ui, saveSettings, saveConversation, path, parentOf, nodeText, isBilelAccount } from './state.js';
import { streamSSE, postJSON } from './api.js';
import { wantsSlides } from './deck-model.js';
import { wantsSpreadsheet } from './sheet-model.mjs';
import { IN_APP } from './native.js';
import { renderMarkdown } from './markdown.js';
import { withoutEssayBlocks } from './eden-tools.js';
import { createActivityThread, updateActivityThread } from './activity-thread.js';
import { routeSettings } from './router.js';
import { privacyOn } from './privacy.js';
import { macBody } from './files.js';
import { browserBody } from './browser-agent.js';
import { needsCurrentInfo } from './autosearch-rules.js';
import { isFlagged, isTainted, sourceStrip } from './guard.js';
import { provenanceSummary } from './progress-model.js';
import {
  EVES_HELP, EVES_MODES, MODE_INFO, DEFAULT_EVES_MODEL, EVES_MODEL_CHOICES, normalizeMode, normalizeEvesModel, evesOffered, evesApplies, personalMaterial, isTrivialEvesTurn, wantsEves, chipView, estimateView, evesBody, newState, applyEvent, finish, markStopped, markError,
  reviveState, STAGES, stageSteps, liveText, laneView, badgeView, detailView, usageOf, independenceNote, safeLink, progressView, draftLaneOf, draftHidden,
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
export const evesModel = () => normalizeEvesModel(state.settings.evesModel);
export function setEvesModel(modelId, { quiet = false } = {}) {
  const next = normalizeEvesModel(modelId);
  state.settings.evesModel = next;
  saveSettings();
  est = null;
  scheduleEstimate();
  ui.renderComposer();
  const choice = EVES_MODEL_CHOICES.find((c) => c.id === next) || ((state.meta && state.meta.models) || []).find((m) => m.id === next);
  if (!quiet) toast(`EVES verifier model: ${choice ? choice.name : next}`);
}
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
export function withEvesSetting(settings) {
  const m = evesMode();
  const mod = evesModel();
  return m === 'off' ? settings : { ...settings, eves: m, ...(mod ? { evesModel: mod } : {}) };
}

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

function hasImageAttachments(c, user) {
  if (c) {
    for (const n of path(c)) {
      if (n.role !== 'user') continue;
      if ((n.attachments || []).some((a) => a && a.kind === 'image')) return true;
      if (user && n.id === user.id) break;
    }
  }
  if (!user) {
    const box = document.getElementById('jc-attach');
    if (box && box.querySelector('.jc-thumb-img')) return true;
  }
  return false;
}

function appliesNow(user = null, text = '') {
  const c = state.current;
  const hasDeck = !!(c && Array.isArray(c.deckVersions) && c.deckVersions.length);
  const promptText = String(text || (user && user.content) || draft || '').trim();
  const autoCanvas = promptText && (wantsSlides(promptText, { hasDeck }) || wantsSpreadsheet(promptText));
  const chatMode = autoCanvas ? 'slides' : (c ? c.mode || 'chat' : state.pendingMode || 'chat');
  const hasMac = !!c && Object.keys(macBody(c)).length > 0;
  const browser = !!browserBody(user || {}).browser;
  return evesApplies({
    kind: c ? c.kind : 'chat', chatMode, mac: hasMac, browser, course: !!(c && c.course),
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
  const applies = appliesNow(user, text);
  if (!applies.ok) {
    if (c && c.kind !== 'code' && !told.has(applies.why)) { told.add(applies.why); toast(`EVES is on, but not for this message. ${applies.why}`); }
    return null;
  }
  const hasImages = hasImageAttachments(c, user);
  const promptText = String(text || '').trim() || (hasImages ? 'Describe the attached image.' : '');
  const m = wantsEves({ mode, applies, text: promptText, factual, risk: serverRisk(promptText) });
  if (!m) return null;
  const ev = est && est.data && !est.loading && est.text === promptText ? estimateView(est.data, { privacy: privacyOn(c) }) : null;
  let pins = ev && !privacyOn(c) ? ev.pins : undefined;
  const wantModel = evesModel();
  if (Array.isArray(pins)) {
    if (wantModel !== 'gemini-4-argon' && pins.some((p) => p && p.model === 'gemini-4-argon')) pins = undefined;
    else if (wantModel === 'gemini-4-argon' && !pins.some((p) => p && p.model === 'gemini-4-argon')) pins = undefined;
  }
  if (hasImages && Array.isArray(pins) && state.meta && Array.isArray(state.meta.models)) {
    const visionIds = new Set(state.meta.models.filter((x) => x.vision !== false).map((x) => x.id));
    if (pins.some((p) => !visionIds.has(p.model))) pins = undefined;
  }
  return { mode: m, models: pins };
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
  const hasImages = hasImageAttachments(state.current, null);
  const text = draft.trim() || (hasImages ? 'Describe the attached image.' : '');
  const mode = evesMode();
  const applies = appliesNow();
  if (!text || !applies.ok || isTrivialEvesTurn(text)) return false;
  return mode === 'auto' || wantsEves({ mode, applies, text, factual }) !== null;
};
const runEstimate = debounce(async () => {
  if (estAbort) estAbort.abort();
  if (!estimateWanted()) { estAbort = null; est = null; renderEvesChip(); return; }
  const hasImages = hasImageAttachments(state.current, null);
  const text = draft.trim() || (hasImages ? 'Describe the attached image.' : '');
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
  const hasImages = hasImageAttachments(state.current, null);
  const text = draft.trim() || (hasImages ? 'Describe the attached image.' : '');
  if (est && est.text === text && est.mode === evesMode() && !est.error && !est.loading) { renderEvesChip(); return; }
  runEstimate();
  renderEvesChip();
}
/** The composer's text changed (composer.js): price the new draft once typing pauses. */
export function setEvesDraft(text) {
  draft = String(text || '');
  if (!draft.trim() && !hasImageAttachments(state.current, null)) { if (estAbort) estAbort.abort(); estAbort = null; est = null; renderEvesChip(); return; }
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
  const hasImages = hasImageAttachments(c, null);
  const text = draft.trim() || (hasImages ? 'Describe the attached image.' : '');
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
  const curModel = evesModel();
  const curChoice = EVES_MODEL_CHOICES.find((c) => c.id === curModel);
  const items = [{ heading: 'EVES · check the facts' }];
  for (const m of EVES_MODES) {
    const price = m === 'on' && ev && ev.price && estimateWanted() ? ` · ${ev.price} for this message` : '';
    items.push({ label: MODE_INFO[m].label, note: `${MODE_INFO[m].note}${price}`, checked: mode === m, run: () => setEvesMode(m) });
  }
  items.push('-', { icon: 'sliders', label: `EVES settings (${curChoice ? curChoice.name : curModel})…`, run: () => dispatchEvent(new CustomEvent('eden:open-settings', { detail: { tab: 6 } })) }, { foot: EVES_HELP });
  if (mode !== 'off' && !applies.ok) items.push({ foot: applies.why });
  if (ev && ev.weak && ev.note) items.push({ foot: ev.note }, { icon: 'key', label: 'Add another provider’s key…', run: () => dispatchEvent(new CustomEvent('eden:open-settings', { detail: { tab: 0 } })) });
  H.openMenu(anchor, items);
}

/* ---------- Settings › Routing & Settings › EVES ---------- */

function buildEvesModelPicker() {
  const curModel = evesModel();
  const metaModels = (state.meta && Array.isArray(state.meta.models)) ? state.meta.models : [];
  const seen = new Set();
  const options = [];
  for (const c of EVES_MODEL_CHOICES) {
    seen.add(c.id);
    options.push(c);
  }
  for (const m of metaModels) {
    if (m && m.id && !seen.has(m.id)) {
      seen.add(m.id);
      options.push({ id: m.id, name: m.name || m.id, note: m.provider || '' });
    }
  }
  const curChoice = options.find((c) => c.id === curModel) || { id: curModel, name: curModel, note: '' };
  const modelNote = el('div', { class: 'p-c eves-model-note', 'aria-live': 'polite' }, curChoice.note || 'Used for EVES claim comparison, consensus checking, and web verification.');
  const sel = el('select', {
    class: 'eves-model-sel',
    'aria-label': 'EVES verifier model',
    style: { width: 'auto', minWidth: '190px', maxWidth: '240px', flex: '0 0 auto' },
  },
    ...options.map((c) => {
      const o = el('option', { value: c.id }, c.id === DEFAULT_EVES_MODEL ? `${c.name} (Default · Fast)` : c.name);
      if (c.id === curModel) o.selected = true;
      return o;
    }));
  sel.addEventListener('change', () => {
    const picked = sel.value;
    setEvesModel(picked);
    const info = options.find((c) => c.id === picked);
    modelNote.textContent = (info && info.note) || 'Used for EVES claim comparison, consensus checking, and web verification.';
  });
  return { sel, modelNote, options };
}

/** The EVES section of Settings › Routing. */
export function evesSettings() {
  if (!evesAvailable()) return null; // no EVES on this server: no section in Settings
  const mode = evesMode();
  const note = el('div', { class: 'p-c eves-set-note', 'aria-live': 'polite' }, MODE_INFO[mode].note);
  const seg = el('div', { class: 'seg', style: { '--n': 3 }, role: 'radiogroup', 'aria-label': 'EVES' }, el('div', 'seg-thumb'),
    ...EVES_MODES.map((m, i) => el('button', { type: 'button', role: 'radio', 'aria-checked': String(m === mode), class: m === mode ? 'on' : '', onclick: () => { setEvesMode(m); setSeg(seg, i); note.textContent = MODE_INFO[m].note; } }, MODE_INFO[m].label)));
  const { sel, modelNote } = buildEvesModelPicker();
  const sec = el('div', 'set-sec eves-set', el('h3', '', 'EVES · check the facts'),
    el('div', 'icard',
      el('div', 'prov', el('div', 'grow', el('div', 'p-n', 'Have several models check each other'), el('div', 'p-c', EVES_HELP)), seg),
      el('div', 'prov', el('div', 'grow', note)),
      el('div', 'prov', el('div', 'grow', el('div', 'p-n', 'EVES verifier model'), modelNote), sel)),
    el('p', 'sp-note', 'Each reply shows a badge saying what was checked, and “Show the work” opens what each model said. EVES works in plain Chat (including image questions); Code, Search, Research and Compare keep their own ways.'));
  setSeg(seg, EVES_MODES.indexOf(mode));
  return sec;
}

/** Dedicated Settings › EVES pane: mode, verifier model selector (default Gemini 3.8 Flash, with option to switch to Argon or any model), and fact-check switches. */
export function drawEvesPane(body) {
  const mode = evesMode();
  const note = el('div', { class: 'p-c eves-set-note', 'aria-live': 'polite' }, MODE_INFO[mode].note);
  const seg = el('div', { class: 'seg', style: { '--n': 3 }, role: 'radiogroup', 'aria-label': 'EVES' }, el('div', 'seg-thumb'),
    ...EVES_MODES.map((m, i) => el('button', { type: 'button', role: 'radio', 'aria-checked': String(m === mode), class: m === mode ? 'on' : '', onclick: () => { setEvesMode(m); setSeg(seg, i); note.textContent = MODE_INFO[m].note; } }, MODE_INFO[m].label)));
  setSeg(seg, EVES_MODES.indexOf(mode));

  const { sel, modelNote } = buildEvesModelPicker();
  const quickCards = el('div', { class: 'theme-tiles', role: 'radiogroup', 'aria-label': 'EVES model presets' },
    ...[
      ['gemini-3.8-flash', 'Gemini 3.8 Flash', 'Default · Fastest (~2.1s)'],
      ['claude-haiku-4-5', 'Claude Haiku 4.5', 'Fast NLI (~1.9s)'],
      ['gemini-4-argon', 'Gemini 4 Argon', 'Deepest (~9.5s)'],
    ].map(([id, label, sub]) => {
      const active = evesModel() === id;
      return el('button', {
        type: 'button',
        role: 'radio',
        'aria-checked': String(active),
        class: `theme-tile${active ? ' on' : ''}`,
        onclick: () => {
          setEvesModel(id);
          drawEvesPane(body);
        },
      }, el('span', 'tt-label', el('span', 'tt-radio'), el('b', '', label), el('span', '', sub)));
    }));

  const checkSw = (key, label, on, off) => {
    const x = el('input', { type: 'checkbox', 'aria-label': label });
    x.checked = state.settings[key] !== false;
    x.addEventListener('change', () => { state.settings[key] = x.checked; saveSettings(); toast(x.checked ? on : off); });
    return x;
  };
  const premiseSw = checkSw('premiseCheck', 'Check the question’s assumptions', 'Eden checks what a question takes for granted', 'Assumption check is off');
  const answerSw = checkSw('answerCheck', 'Double-check answers that didn’t use the web', 'Eden double-checks answers that didn’t use the web', 'Answer double-check is off');

  const hero = el('div', 'set-hero t-eves', el('span', 'set-tile', ico('shield', 18)), el('div', 'grow', el('h3', 'set-h', 'EVES'), el('p', 'set-d', 'Eden Verification & Evaluation System: multi-model consensus, claim checking, and web grounding.')));
  body.replaceChildren(
    hero,
    el('div', 'set-sec eves-set', el('h3', '', 'Verification Mode'),
      el('div', 'icard',
        el('div', 'prov', el('div', 'grow', el('div', 'p-n', 'Have several models check each other'), el('div', 'p-c', EVES_HELP)), seg),
        el('div', 'prov', el('div', 'grow', note))),
      el('p', 'sp-note', 'In Auto mode, Eden runs EVES when a wrong fact would matter (health, law, money, exact statistics, current events). In On mode, every Chat reply is cross-checked.')),
    el('div', 'set-sec eves-set', el('h3', '', 'EVES Verifier & Judge Model'),
      quickCards,
      el('div', { class: 'icard', style: { marginTop: '10px' } },
        el('div', 'prov', el('div', 'grow', el('div', 'p-n', 'Verifier model'), modelNote), sel)),
      el('p', 'sp-note', 'Gemini 3.8 Flash is the default for fast, low-latency verification and web grounding. You can switch to Claude Haiku 4.5, GPT-6.1 Sol, or back to Gemini 4 Argon anytime.')),
    el('div', 'set-sec', el('h3', '', 'Automatic Fact Checks'),
      el('div', 'icard',
        el('div', 'prov', el('div', 'grow', el('div', 'p-n', 'Check the question’s assumptions'), el('div', 'p-c', 'When a question takes a fact for granted (“why did … win …?”), Eden checks that fact on the web first and corrects it if it’s wrong.')), el('label', 'switch', premiseSw, el('span', 'tr'))),
        el('div', 'prov', el('div', 'grow', el('div', 'p-n', 'Double-check answers that didn’t use the web'), el('div', 'p-c', 'After a factual answer from the model’s memory, Eden looks on the web for evidence against it, and answers again with sources when it finds some.')), el('label', 'switch', answerSw, el('span', 'tr'))))),
  );
}

/* ---------- the run ---------- */

export const evesApi = {
  stop: (id, lane) => postJSON('/api/chat/eves/stop', { id, lane }),
  flag: (payload) => postJSON('/api/chat/eves/flag', payload),
};

function appendText(node, text) {
  const parts = node.parts || (node.parts = []);
  const last = parts.at(-1);
  if (last && last.type === 'text') last.text += text;
  else parts.push({ type: 'text', text });
}

/**
 * The draft (2026-10-24, docs/verify/latency-plan-2026-10-24.md A1): while EVES checks, the answer of the first model
 * to start writing shows greyed and labelled "Draft · being checked", until the checked answer replaces it (another
 * model's if that one fails or is stopped). It is the text the page already has for "Show the work" (s.lanes): nothing
 * EVES asks or decides changes, and nothing is added to node.parts, so it is never sent back as history. Only the
 * chosen lane is kept here; it goes for good when the checked answer starts or the run ends, fails or is stopped.
 * Hidden from screen readers (the transcript is a live log: the unchecked words would be read again at every repaint;
 * the status region already says what EVES is doing). Never in the iPhone or Android app (IN_APP).
 */
const drafts = new WeakMap(); // node → the lane index shown as the draft
const draftOver = new WeakSet(); // nodes whose draft is over (checked answer started, or the run ended)
const draftDrawn = new WeakMap(); // node → { key, view }: drawn again only when its text or lane changed
const endDraft = (node) => { draftOver.add(node); drafts.delete(node); draftDrawn.delete(node); };

function draftView(node) {
  if (draftOver.has(node)) return null;
  const lanes = (node.eves && node.eves.lanes) || [];
  const i = draftLaneOf(lanes, drafts.get(node));
  if (i === null) drafts.delete(node);
  else drafts.set(node, i);
  const lane = i === null ? null : lanes[i];
  const text = lane ? withoutEssayBlocks(lane.text) : '';
  if (!text.trim() || draftHidden(text)) return null;
  const key = `${i}:${text.length}`;
  const drawn = draftDrawn.get(node);
  if (drawn && drawn.key === key) return drawn.view;
  const md = el('div', 'md');
  md.append(renderMarkdown(text, { sources: [], untrusted: true, noCanvas: true })); // unchecked: images held, link destinations shown
  const view = el('div', { class: 'eves-provisional', 'aria-hidden': 'true' }, el('div', 'eves-provisional-tag', 'Draft · being checked'), md);
  draftDrawn.set(node, { key, view });
  return view;
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
  let finalStarted = false;
  drafts.delete(node); draftOver.delete(node); draftDrawn.delete(node); // a retry of this reply starts a new draft
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
      else if (type === 'memory') node.memory = data;
      else if (typeof data.lane === 'number' && type === 'text' && !finalStarted && !IN_APP && !drafts.has(node) && String(data.text || '').trim()) {
        drafts.set(node, data.lane); // the first model to write is the draft (draftLaneOf moves it if that model fails)
      } else if (data.lane === 'final') {
        if (type === 'text') {
          if (!finalStarted) {
            finalStarted = true;
            node.parts = [];
            endDraft(node);
          }
          appendText(node, String(data.text || ''));
        } else if (type === 'citations') {
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
    stopped() { endDraft(node); markStopped(s); sync(); },
    failed(message) { endDraft(node); if (!finalStarted) node.parts = []; markError(s, message); sync(); },
    end() { endDraft(node); finish(s); sync(); const b = badgeView(s, false); announce(b.show ? b.text : liveText(s, false)); },
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

const runViews = new WeakMap(); // node → view; retained through completion, released with the conversation

function buildRunView(node, c) {
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
  const view = { root, stepLis, count, toggle, dots, dotLis: [], note, noteFor: null, work, lanesBox, cards: [] };
  if (!IN_APP) {
    // Keep the native tree untouched. Both web paths use the same activity component.
    const thread = createActivityThread({ id: `eves-${node.id}`, onStop: () => {
      const stream = c && state.streams.get(c.id);
      if (node.streaming && stream && (!stream.node || stream.node === node)) stream.abort();
    } });
    thread.root.classList.add('eves-activity');
    const description = el('p', 'eves-progress-description');
    const sources = el('div', 'activity-sources');
    work.id = domId('live-work', node.id);
    toggle.setAttribute('aria-controls', work.id);
    thread.body.append(description, sources, dots, toggle, work);
    thread.footer.before(note);
    Object.assign(view, { root: thread.root, thread, description, sources });
  }
  return view;
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
  const progress = v.thread ? progressView(s, now) : null;
  if (progress) {
    const over = !node.streaming || ['done', 'stopped', 'error'].includes(s.phase);
    const prov = provenanceSummary(node.provenance);
    const rows = progress.vault
      ? [
          ...(prov ? [{ id: 'provenance', text: prov, status: 'done' }] : []),
          { id: 'vault', text: 'Matched in EVES Verified Vault', status: 'done' },
          { id: 'sources', text: 'Verified against primary sources', status: 'done' },
          { id: 'finalizing', text: 'Answer', status: over ? 'done' : 'active' },
        ]
      : [
          ...(prov ? [{ id: 'provenance', text: prov, status: 'done' }] : []),
          ...(s.plan ? [{ id: 'models', text: `${s.lanes.length} models selected`, status: 'done' }] : []),
          ...steps.map((step) => ({ id: step.id, text: step.status === 'active' ? step.text : progress.labels[step.id], status: step.status })),
        ];
    const warning = [progress.warning ? `${progress.warning}. Coverage is reduced.` : '',
      s.phase === 'error' ? s.error || 'Verification could not finish.' : '',
      s.phase === 'stopped' ? 'Verification stopped before completion.' : ''].filter(Boolean).join('\n');
    updateActivityThread(v.thread, { rows, title: progress.title, elapsed: progress.elapsed, meta: progress.meta,
      phase: over ? 'over' : s.stage === 'finalizing' ? 'answer' : 'work', warning, canStop: !over });
    setText(v.description, progress.description);
    v.dots.hidden = Boolean(progress.vault);
    if (v.sources) {
      if (isTainted(node) && !isFlagged(node)) {
        const strip = sourceStrip(node);
        if (strip) {
          v.sources.replaceChildren(strip);
          v.sources.hidden = false;
        } else v.sources.hidden = true;
      } else {
        v.sources.hidden = true;
      }
    }
    // Completed answers keep the existing evidence/work footer, not a second copy of its IDs.
    if (node.streaming) { if (!v.toggle.isConnected) v.thread.body.append(v.toggle, v.work); }
    else { v.toggle.remove(); v.work.remove(); }
  }
  const at = Math.max(0, steps.findIndex((x) => x.status === 'active'));
  steps.forEach((st, i) => {
    const li = v.stepLis[i];
    const cls = `eves-step ${st.status}`;
    if (li.className !== cls) li.className = cls;
    if (st.status === 'active') li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
    setText(li.children[1], progress ? progress.labels[st.id] : st.text);
    if (progress) setText(li.children[0], st.status === 'done' ? '✓' : st.status === 'active' ? '◉' : st.status === 'skipped' ? '–' : '○');
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
function runPanel(node, s, c) {
  let v = runViews.get(node);
  if (!v) { v = buildRunView(node, c); runViews.set(node, v); }
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
  const rate = evesRateControls(node);
  if (!b.show && !hasWork && !rate) return null;
  return el('div', { class: 'eves-foot', 'data-act': 'eves-chrome' },
    b.show ? badgeEl(node, s, b) : null,
    hasWork ? el('div', 'eves-work-row', workToggle(node, s)) : null,
    rate,
    hasWork ? workPanel(node, s) : null);
}

/* ---------- EVES Rating & Autonomous Hallucination Fix (!IN_APP, Bilel & Malik only) ---------- */

const flaggingNodes = new Set();

function evesThumbSvg(down) {
  const s = svgEl('svg', { class: 'ic', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  const g = svgEl('g', down ? { transform: 'rotate(180 12 12)' } : {});
  g.append(
    svgEl('path', { d: 'M7.5 10.5v9h-3v-9z' }),
    svgEl('path', { d: 'M7.5 10.5l3.6-6.4a1.7 1.7 0 0 1 3.1 1.1l-.6 3.8h5.1a2 2 0 0 1 2 2.4l-1.3 6.5a2 2 0 0 1-2 1.6H7.5' }),
  );
  s.append(g);
  return s;
}

/**
 * Web-only (`!IN_APP`) EVES 👍 / 👎 & Hallucination auto-fix controls for Bilel & Malik (`isBilelAccount()`).
 * Rendered in the EVES footer (`foot`) when EVES ran, or in the message action bar (`render.js`) when EVES didn't.
 */
export function evesRateControls(node, { inline = false } = {}) {
  if (IN_APP || !isBilelAccount() || !node || node.role !== 'assistant' || node.streaming || node.error) return null;
  if (inline && node.eves && !node.eves.skipped) return null; // already drawn in .eves-foot
  const rating = node.evesRating || null;
  const busy = flaggingNodes.has(node.id);
  const fixed = node.evesAutoFixed;
  return el(
    'span',
    {
      class: `eves-rate-bar${inline ? ' inline' : ''}`,
      role: 'group',
      'aria-label': 'EVES fact-check rating',
      'data-no-i18n': '',
    },
    el(
      'button',
      {
        type: 'button',
        class: `eves-rate-btn up${rating === 'up' ? ' on' : ''}`,
        'data-act': 'eves-rate-up',
        'aria-pressed': String(rating === 'up'),
        disabled: busy,
        title: 'EVES verified accurately (logs positive EVES signal & caches timeless facts)',
      },
      evesThumbSvg(false),
      el('span', 'eves-rate-lbl', rating === 'up' ? 'EVES Accurate' : 'Accurate'),
    ),
    el(
      'button',
      {
        type: 'button',
        class: `eves-rate-btn down${rating === 'down' ? ' on' : ''}${busy ? ' busy' : ''}${fixed ? ' fixed' : ''}`,
        'data-act': 'eves-rate-down',
        'aria-pressed': String(rating === 'down'),
        disabled: busy,
        title: 'Flag hallucination: logs the error, searches the web with Gemini 4 Argon in the cloud, fixes the answer automatically, and updates the EVES Vault',
      },
      evesThumbSvg(true),
      el(
        'span',
        'eves-rate-lbl',
        busy
          ? 'Fixing hallucination…'
          : fixed
            ? 'Hallucination fixed'
            : rating === 'down'
              ? 'Flagged · Re-fix'
              : 'Flag hallucination',
      ),
    ),
  );
}

async function handleEvesRate(c, node, rating) {
  if (IN_APP || !isBilelAccount() || !c || !node || flaggingNodes.has(node.id)) return;
  const userNode = parentOf(c, node);
  const question = userNode ? nodeText(userNode).trim() : '';
  const answer = nodeText(node).trim();
  if (!answer) return;

  if (rating === 'up') {
    node.evesRating = node.evesRating === 'up' ? null : 'up';
    saveConversation(c);
    ui.updateMessage(c, node, { final: true, keepScroll: true });
    if (node.evesRating === 'up') {
      toast('EVES accuracy confirmed · logged to EVES Vault');
      evesApi.flag({
        rating: 'up',
        question,
        answer,
        model: (node.route && node.route.model) || (node.eves && node.eves.verdict && node.eves.verdict.winnerModel) || 'eves',
        eves: node.eves ? { verdict: node.eves.verdict, lanes: (node.eves.lanes || []).map((l) => ({ model: l.model, name: l.name, status: l.status })) } : null,
      }).catch(() => {});
    } else {
      toast('EVES rating cleared');
    }
    return;
  }

  // Thumbs down: Flag hallucination & trigger autonomous cloud repair + EVES Vault update
  node.evesRating = 'down';
  flaggingNodes.add(node.id);
  saveConversation(c);
  ui.updateMessage(c, node, { final: true, keepScroll: true });
  toast('Hallucination flagged — verifying on the web and fixing automatically…');

  try {
    const res = await evesApi.flag({
      rating: 'down',
      question,
      answer,
      model: (node.route && node.route.model) || 'eves',
      citations: node.citations || [],
      eves: node.eves
        ? {
            verdict: node.eves.verdict,
            lanes: (node.eves.lanes || []).map((l) => ({ model: l.model, name: l.name, text: (l.text || '').slice(0, 2000), status: l.status })),
          }
        : null,
    });
    flaggingNodes.delete(node.id);
    if (res && res.repaired && typeof res.fixedAnswer === 'string' && res.fixedAnswer.trim()) {
      if (!node.repairedFrom) node.repairedFrom = answer;
      node.parts = [{ type: 'text', text: res.fixedAnswer.trim() }];
      if (Array.isArray(res.citations) && res.citations.length) {
        const seen = new Set((node.citations || []).map((x) => x.url));
        for (const x of res.citations) {
          const k = x && safeLink(x.url);
          if (k && !seen.has(k.href)) {
            (node.citations || (node.citations = [])).push({ title: String(x.title || ''), url: k.href });
            seen.add(k.href);
          }
        }
      }
      node.evesAutoFixed = {
        at: Date.now(),
        summary: res.summary || 'Hallucination verified against web sources and repaired automatically.',
        counterClaim: res.counterClaim || '',
        vaultUpdated: Boolean(res.vaultUpdated),
      };
      if (node.eves && node.eves.verdict) {
        node.eves.verdict.corrections = [
          ...(node.eves.verdict.corrections || []),
          {
            claimId: `halluc-${Date.now()}`,
            action: 'fix',
            original: answer.slice(0, 240),
            replacement: res.fixedAnswer.trim().slice(0, 240),
            reason: res.summary || 'Auto-repaired after hallucination flag.',
          },
        ];
      } else {
        node.verification = {
          label: {
            kind: 'eves_verified',
            text: 'Hallucination auto-fixed by EVES',
            detail: res.summary || 'Checked on the web and corrected automatically.',
            severity: 'ok',
          },
          findings: [
            {
              check: 'evidence',
              status: 'pass',
              subject: 'Autonomous hallucination repair',
              detail: res.summary || 'Replaced hallucinated claims with web-grounded facts.',
            },
          ],
          repaired: { struck: [answer.slice(0, 200)], regenerated: true, replaced: true },
        };
      }
      saveConversation(c);
      ui.updateMessage(c, node, { final: true, keepScroll: true });
      toast(res.vaultUpdated ? 'Hallucination fixed & saved to EVES Vault' : 'Hallucination fixed with web sources');
    } else {
      saveConversation(c);
      ui.updateMessage(c, node, { final: true, keepScroll: true });
      toast((res && res.summary) || 'Hallucination logged for EVES review (no higher-confidence web replacement found)');
    }
  } catch (err) {
    flaggingNodes.delete(node.id);
    ui.updateMessage(c, node, { final: true, keepScroll: true });
    toast(`Hallucination logged locally (${(err && err.message) || 'repair call failed'})`);
  }
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
    if (!(node.parts || []).some((p) => p.type === 'text' && p.text) && !node.error) {
      const draft = IN_APP ? null : draftView(node);
      if (draft) bubble.append(draft);
      else m.classList.add('eves-empty');
    }
    const v = runPanel(node, s, c);
    const keep = v.cards.map((c) => ({ top: c.body.scrollTop, stick: c.body.scrollHeight - c.body.scrollTop - c.body.clientHeight < 24 })); // read while it is still in the old drawing
    bubble.before(v.root);
    queueMicrotask(() => v.cards.forEach((c, i) => { c.body.scrollTop = keep[i].stick ? c.body.scrollHeight : keep[i].top; })); // moving an element resets its scroll
  } else {
    if (!IN_APP) bubble.before(runPanel(node, s, c).root);
    else runViews.delete(node);
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
          const v = node.streaming && runViews.get(node);
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
    case 'eves-rate-up': handleEvesRate(c, node, 'up'); break;
    case 'eves-rate-down': handleEvesRate(c, node, 'down'); break;
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
