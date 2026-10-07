// Cost and quality you can see (ROADMAP G1), and several models at once (G6):
//  - the estimate line above the composer: the routed model, its estimated cost ("~$0.004", or
//    "subscription" for Claude through the CLI) and time; one tap opens the alternatives
//    (Upgrade: the next stronger model at the same effort, or another candidate), picked for
//    the next message only (state.turnOverride, which router.js's currentOverride honours);
//  - "Ask a stronger model" after a reply: the same turn again on a stronger pick, as a new
//    draft (chat.js regenerate), shown beside the first;
//  - the side-by-side view both share with Compare mode: columns on a wide screen, swipeable
//    tabs on a phone; each answer with its model, actual cost and time, Stop while it streams,
//    and "Keep this" (the kept draft becomes the conversation's branch; the others stay in the
//    pager, and "Side by side" opens the comparison again). Compare's short synthesis sits under it.
// A comparison lives on the question (user node): compare = { kind: 'stronger'|'compare', ids,
// kept, synthesis }. The pure parts are in compare-model.js; the turns in chat.js.

import { $, el, svgEl, ico, toast, EFFORT_SHORT, shortModel } from './util.js';
import { state, ui, saveConversation, nodeText } from './state.js';
import { availableModels, currentOverride, renderRouteControls } from './router.js';
import { renderMarkdown } from './markdown.js';
import { actualParts, compareTotals, costWords, estimateParts, pickSeconds, secondsWords, strongerPick } from './compare-model.js';
import { autopilotTag, setAutopilotMenus } from './autopilot.js';
import { isTainted } from './guard.js';

let H = { openMenu: () => {}, closeMenu: () => {} }; // from composer.js
let T = { regenerate: () => {}, stop: () => {} }; // from chat.js
let laneRenderer = null; // from render.js: an answer drawn as a lane (no pager, no "Try again")

export function setCompareTurns(turns) { T = { ...T, ...turns }; }
export function setLaneRenderer(fn) { laneRenderer = fn; }

/* ---------- small helpers ---------- */

function upIcon() {
  const s = svgEl('svg', { class: 'ic', viewBox: '0 0 24 24', 'aria-hidden': 'true' });
  s.append(svgEl('path', { d: 'M12 19V6M6.5 11.5L12 6l5.5 5.5' }), svgEl('path', { d: 'M5 3.5h14' }));
  return s;
}
const providerOf = (id) => ((state.meta && state.meta.providers) || []).find((p) => p.id === id) || null;
/** Claude through the Claude Code CLI runs on the subscription: no dollars to show. */
export function isSubscription(provider) { const p = providerOf(provider); return provider === 'anthropic' && !!p && p.via === 'claude-cli'; }
const effortName = (e) => EFFORT_SHORT[e] || e;
const curMode = () => (state.current ? state.current.mode : state.pendingMode || 'chat');

/** A question's comparison and its answers, when `node` is one of them: { user, group } (open: not kept yet). */
export function groupOf(c, node) {
  if (!c || !node || node.role !== 'assistant' || !node.parent) return null;
  const user = c.nodes[node.parent];
  const g = user && user.compare;
  return g && Array.isArray(g.ids) && g.ids.includes(node.id) ? { user, group: g } : null;
}
export function openGroupOf(c, node) { const x = groupOf(c, node); return x && !x.group.kept ? x : null; }

/** Before a new message: an open comparison keeps the answer that's selected (it's the branch the message continues). */
export function resolveOpenGroups(c) {
  for (const n of Object.values((c && c.nodes) || {})) {
    const g = n.compare;
    if (g && !g.kept && g.ids && g.ids.length) g.kept = n.children[Math.min(n.sel, n.children.length - 1)] || g.ids[0];
  }
}

/* ---------- the estimate line (G1) ---------- */

let line = null;
function ensureLine() {
  if (line && document.contains(line)) return line;
  const form = $('deck-composer');
  if (!form || !form.parentElement) return null;
  line = el('div', { class: 'jc-estimate', id: 'jc-estimate', hidden: true });
  line.addEventListener('click', (e) => {
    if (e.target.closest('.jc-est-x')) { clearTurnOverride(); return; }
    const b = e.target.closest('.jc-est-main');
    if (b) { if (b.getAttribute('aria-expanded') === 'true') H.closeMenu(); else openAlternatives(b); }
  });
  form.parentElement.insertBefore(line, form);
  return line;
}

/** The router's row for a model in the live preview. */
const rowOf = (model) => ((state.preview && state.preview.rows) || []).find((r) => r.model === model) || null;

function parts(bits) {
  const out = [];
  for (const b of bits.filter(Boolean)) { if (out.length) out.push(el('span', { class: 'sep', 'aria-hidden': 'true' }, '·')); out.push(b); }
  return out;
}

export function renderEstimate() {
  const box = ensureLine();
  if (!box) return;
  const c = state.current;
  const mode = curMode();
  const p = state.preview;
  const o = currentOverride();
  const busy = c && state.streams.has(c.id);
  const show = !(c && c.kind === 'code') && !busy && (mode === 'chat' || mode === 'compare') && !!(p || state.turnOverride);
  box.hidden = !show;
  if (!show) { box.replaceChildren(); return; }
  const kids = [];
  const main = el('button', { type: 'button', class: 'jc-est-main', 'aria-haspopup': 'menu', 'aria-expanded': 'false' });
  if (mode === 'compare') {
    const est = p && p.compare;
    const t = est && !est.error ? compareTotals(est, (l) => isSubscription(l.provider)) : null;
    main.append(el('span', { class: 'jc-est-ic', 'aria-hidden': 'true' }, '⧉'));
    if (p && p.loading && !t) main.append(el('span', 'jc-est-dim', 'Pricing the comparison…'));
    else if (!t) main.append(el('span', 'jc-est-dim', est && est.error ? `Compare: ${est.error}` : 'Compare: type a question'));
    else main.append(...parts([el('b', '', `${t.models} models`), el('span', 'jc-est-lanes', est.lanes.map((l) => shortModel(l.modelName)).join(', ')), el('span', 'jc-est-cost', t.cost), t.time ? el('span', '', t.time) : null]));
    main.title = 'Each model answers on its own, then a cheap model sums up where they agree and differ. Tap for the details.';
    main.setAttribute('aria-label', t ? `Compare ${t.models} models: ${t.cost}, ${t.time}. Show details` : 'Compare details');
  } else {
    const pick = o ? (() => { const r = rowOf(o.model); const m = (state.meta && state.meta.models || []).find((x) => x.id === o.model); return { ...(r && r.effort === o.effort ? r : {}), model: o.model, name: m ? m.name : o.model, provider: m ? m.provider : r && r.provider, effort: o.effort }; })() : p && p.pick;
    const e = pick && estimateParts(pick, { subscription: isSubscription(pick.provider), effortName });
    main.append(el('span', { class: 'jc-est-ic', 'aria-hidden': 'true' }, state.turnOverride ? '↑' : '✦'));
    if (!pick && p && p.loading) main.append(el('span', 'jc-est-dim', 'Routing…'));
    else if (!pick) main.append(el('span', 'jc-est-dim', p && p.error ? 'Estimate unavailable' : ''));
    else main.append(...parts([el('b', '', `${e.model}${e.effort ? ` · ${e.effort}` : ''}`), e.cost ? el('span', 'jc-est-cost', e.cost) : null, e.time ? el('span', '', e.time) : null]));
    if (p && p.error && !pick) main.title = `The router couldn’t price this: ${p.error}`;
    else main.title = state.turnOverride ? 'Your pick for this message. Tap for the alternatives.' : o ? 'Your pinned model. Tap for the alternatives.' : 'The router’s pick for what you’re typing (rules; Gemini rates it when you send). Tap to upgrade or pick another.';
    main.setAttribute('aria-label', e ? `${state.turnOverride ? 'This message' : o ? 'Pinned' : 'Routed'} to ${e.model}${e.effort ? `, ${e.effort} effort` : ''}${e.cost ? `, ${e.cost}` : ''}${e.time ? `, ${e.time}` : ''}. Show alternatives` : 'Routing estimate');
    if (p && p.loading) main.classList.add('loading');
  }
  main.append(el('span', { class: 'jc-est-chev', 'aria-hidden': 'true' }, '⌃'));
  kids.push(main);
  if (state.turnOverride && mode !== 'compare') kids.push(el('span', 'jc-est-tag', 'this message'), el('button', { type: 'button', class: 'jc-est-x', 'aria-label': 'Back to the router’s pick', title: 'Back to the router’s pick' }, '×'));
  // H3: "Autopilot: saving for the month" while the month's budget steps routing down (autopilot.js)
  const ap = mode !== 'compare' ? autopilotTag() : null;
  if (ap) kids.push(ap);
  box.replaceChildren(...kids);
}

function pickForTurn(model, effort) {
  state.turnOverride = { model, effort };
  renderRouteControls();
  ui.renderComposer();
}
export function clearTurnOverride() {
  if (!state.turnOverride) return;
  state.turnOverride = null;
  renderRouteControls();
  ui.renderComposer();
}
/** After a send: the pick was for that message only. */
export function endTurnOverride() { if (state.turnOverride) clearTurnOverride(); }

function rowNote(r, { quality = true } = {}) {
  const sub = isSubscription(r.provider);
  return [costWords(r.costUSD, { subscription: sub }), secondsWords(pickSeconds(r.latencyS, { cli: sub })), quality && typeof r.quality === 'number' ? `quality ${Math.round(r.quality)}` : ''].filter(Boolean).join(' · ');
}

function openAlternatives(anchor) {
  if (curMode() === 'compare') { openCompareDetails(anchor); return; }
  const p = state.preview;
  const o = currentOverride();
  const rows = ((p && p.rows) || []).filter((r) => r.eligible !== false);
  const models = availableModels();
  const cur = o ? { model: o.model, effort: o.effort, quality: rowOf(o.model) && rowOf(o.model).quality } : p && p.pick ? { model: p.pick.model, effort: p.pick.effort, quality: p.pick.quality } : null;
  const up = cur && strongerPick({ current: cur, rows: (p && p.rows) || [], models });
  const items = [{ heading: 'For this message' }];
  if (up) {
    const r = up.row;
    items.push({ icon: 'up', label: `Upgrade · ${shortModel(up.name)}`, note: [up.sameModel ? `${effortName(up.effort)} effort, same model` : `${effortName(up.effort)}, the same effort`, r ? rowNote(r, { quality: false }) : ''].filter(Boolean).join(' · '), run: () => pickForTurn(up.model, up.effort) });
  } else items.push({ icon: 'up', label: 'Upgrade', note: cur ? 'Already the strongest model you can use' : 'Type a message first', disabled: true });
  if (rows.length) {
    items.push('-', { heading: 'Other candidates' });
    for (const r of rows.slice(0, 6)) {
      items.push({ label: `${shortModel(r.name)} · ${effortName(r.effort)}`, note: rowNote(r), checked: !!cur && r.model === cur.model, run: () => pickForTurn(r.model, r.effort) });
    }
  }
  if (state.turnOverride) items.push('-', { icon: 'router', label: 'Let the router pick', note: p && p.pick ? `${shortModel(p.pick.name)} for this text` : '', run: clearTurnOverride });
  items.push({ foot: 'A pick here is for this message only.' });
  H.openMenu(anchor, items);
}

function openCompareDetails(anchor) {
  const est = state.preview && state.preview.compare;
  const items = [{ heading: 'Each model answers, side by side' }];
  if (!est || est.error || !est.lanes) items.push({ label: est && est.error ? 'Couldn’t price the comparison' : 'Type a question to see the models', note: est && est.error ? est.error : '', disabled: true });
  else {
    for (const l of est.lanes) items.push({ label: `${shortModel(l.modelName)} · ${effortName(l.effort)}`, note: rowNote(l), run: () => {} });
    if (est.synthesis) items.push('-', { heading: 'Then a short summary' }, { icon: 'smart', label: shortModel(est.synthesis.modelName), note: `Where they agree and differ · ${rowNote(est.synthesis, { quality: false })}`, run: () => {} });
    const t = compareTotals(est, (l) => isSubscription(l.provider));
    if (t) items.push({ foot: `In all ${t.cost}${t.time ? `, ${t.time}` : ''}. One model per provider, picked by the router at your level.` });
  }
  H.openMenu(anchor, items);
}

/* ---------- "Ask a stronger model" (G1, after a reply) ---------- */

/** The stronger pick for a reply: from its route's candidates and your models. */
export function strongerFor(c, node) {
  const r = node && node.route;
  if (!r || !r.model || c.kind === 'code') return null;
  const rows = (r.candidates || []).map((x) => ({ model: x.model, quality: x.quality, costUSD: x.costUSD, effort: x.effort, provider: x.provider }));
  return strongerPick({ current: { model: r.model, effort: r.effort, quality: r.quality }, rows, models: availableModels() });
}

/** The reply's "Ask a stronger model" button (render.js), or null. */
export function strongerButton(c, node) {
  if (!node.route || node.streaming || c.kind === 'code' || node.route.via === 'claude-code') return null;
  const up = strongerFor(c, node);
  if (!up) return null;
  const what = up.sameModel ? `${shortModel(up.name)} at ${effortName(up.effort)} effort` : shortModel(up.name);
  return el('button', { type: 'button', class: 'iconbtn', 'data-act': 'stronger', title: `Ask a stronger model (${what}) and compare`, 'aria-label': `Ask a stronger model: ${what}` }, upIcon());
}

/** "Side by side" on a kept answer whose comparison can be opened again (render.js), or null. */
export function reopenButton(c, node) {
  const x = groupOf(c, node);
  if (!x || !x.group.kept || x.group.ids.filter((id) => c.nodes[id]).length < 2) return null;
  return el('button', { type: 'button', class: 'iconbtn', 'data-act': 'cmp-open', title: 'Show the answers side by side again', 'aria-label': 'Show side by side' }, ico('side'));
}

/* ---------- the side-by-side view ---------- */

const tabs = new Map(); // question id → the lane shown on a phone
function tabOf(user) {
  const g = user.compare;
  if (tabs.has(user.id)) return Math.min(tabs.get(user.id), g.ids.length - 1);
  const i = g.ids.indexOf(user.children[user.sel]);
  return i >= 0 ? i : 0;
}

function laneHead(node) {
  const r = node.route || {};
  return el('span', 'cmp-tab-in', el('span', { class: `pdot ${r.provider || ''}`, 'aria-hidden': 'true' }), el('span', 'cmp-tab-nm', shortModel(r.modelName || r.model || 'Choosing…')));
}

function laneFoot(c, node, kind) {
  const a = actualParts(node);
  const live = !!node.streaming;
  const bits = [];
  if (live) bits.push(nodeText(node) ? 'Writing…' : 'Waiting…');
  else if (node.error) bits.push('Failed');
  else if (node.finish === 'aborted') bits.push('Stopped');
  else if (node.finish === 'length') bits.push('Cut off');
  if (a.time) bits.push(a.time);
  if (a.cost) bits.push(a.cost);
  return el('div', 'cmp-foot',
    el('span', { class: 'cmp-meta', title: node.usage && node.usage.notional ? 'Claude through the subscription: counted, not billed' : 'What this answer cost and how long it took' }, bits.join(' · ')),
    live ? el('button', { type: 'button', class: 'cap', 'data-act': 'cmp-stop', 'data-kind': kind }, 'Stop') : null,
    !live && !node.error && nodeText(node).trim() ? el('button', { type: 'button', class: 'cap primary', 'data-act': 'cmp-keep' }, ico('check'), 'Keep this') : null);
}

function laneEl(c, node, on, kind) {
  const m = laneRenderer ? laneRenderer(c, node) : el('div', { class: 'msg assistant', 'data-id': node.id });
  m.classList.add('cmp-lane');
  m.classList.toggle('on', on);
  m.setAttribute('role', 'tabpanel');
  m.setAttribute('aria-label', shortModel((node.route && (node.route.modelName || node.route.model)) || 'Answer'));
  m.append(laneFoot(c, node, kind));
  return m;
}

function synthEl(c, user) {
  const s = user.compare && user.compare.synthesis;
  if (!s) return null;
  const live = !!s.streaming && state.streams.has(c.id);
  const stale = s.streaming && !live;
  const a = actualParts(s);
  const box = el('div', { class: 'cmp-synth', 'data-synth': user.id });
  box.append(el('div', 'cmp-synth-head', ico('spark', 14), el('b', '', 'Summary'),
    el('span', 'cmp-meta', [s.modelName ? shortModel(s.modelName) : '', a.time, a.cost].filter(Boolean).join(' · ')),
    live ? el('button', { type: 'button', class: 'cap', 'data-act': 'cmp-stop', 'data-lane': 'synthesis' }, 'Stop') : null));
  const text = (s.parts || []).filter((p) => p.type === 'text').map((p) => p.text).join('');
  // H8: the summary read the lanes, so when they read content from outside (each lane's strip
  // says what) its links show where they go and its images wait for a click, as a reply's do.
  if (text) { const md = el('div', 'md'); md.append(renderMarkdown(text, { untrusted: isTainted(s) })); box.append(md); }
  if (s.error) box.append(el('div', { class: 'errbox', role: 'alert' }, ico('x'), el('span', '', `The summary failed: ${s.error}`)));
  else if (s.finish === 'skipped') box.append(el('div', 'notice', s.reason || 'No summary.'));
  else if (s.pending && !stale) box.append(el('div', 'notice', 'Written when the answers are in.'));
  else if (live && !text) box.append(el('div', { class: 'typing', 'aria-label': 'Writing the summary' }, el('i'), el('i'), el('i')));
  else if ((stale || s.finish === 'aborted') && !s.error) box.append(el('div', 'stopped', 'Stopped.'));
  return box;
}

/** The comparison on a question: its answers side by side (render.js draws it in place of the selected answer). */
export function compareView(c, user) {
  const g = user.compare;
  const nodes = g.ids.map((id) => c.nodes[id]).filter(Boolean);
  const on = Math.min(tabOf(user), nodes.length - 1);
  const box = el('div', { class: `cmp ${g.kind || 'compare'}`, 'data-cmp': user.id });
  box.style.setProperty('--n', String(Math.max(1, nodes.length)));
  const title = g.kind === 'stronger' ? 'Side by side with a stronger model' : `${nodes.length} models, side by side`;
  box.append(el('div', 'cmp-head', el('span', 'cmp-title', title), el('span', 'cmp-hint', 'Keep one: it becomes this conversation’s branch.')));
  box.append(el('div', { class: 'cmp-tabs', role: 'tablist', 'aria-label': 'Answers' },
    ...nodes.map((n, i) => el('button', { type: 'button', role: 'tab', class: i === on ? 'on' : '', 'aria-selected': String(i === on), 'data-act': 'cmp-tab', 'data-i': String(i) }, laneHead(n)))));
  box.append(el('div', 'cmp-lanes', ...nodes.map((n, i) => laneEl(c, n, i === on, g.kind || 'compare'))));
  const s = g.kind === 'compare' ? synthEl(c, user) : null;
  if (s) box.append(s);
  return box;
}

/* ---------- updates while answers stream (wraps ui.updateMessage) ---------- */

const scrollcol = () => $('scrollcol');
const nearBottom = () => { const s = scrollcol(); return !!s && s.scrollHeight - s.scrollTop - s.clientHeight < 120; };
const toBottom = () => { const s = scrollcol(); if (s) s.scrollTop = s.scrollHeight; };

function replaceKeepingFocus(old, fresh) {
  const act = document.activeElement && old.contains(document.activeElement) ? document.activeElement.dataset.act : null;
  old.replaceWith(fresh);
  if (act) { const f = fresh.querySelector(`[data-act="${act}"]`); if (f) f.focus(); }
}

/** Redraw one lane (or the summary) in place; false when `node` isn't part of a drawn comparison. */
function updateLane(c, node, opts = {}) {
  if (!node || c !== state.current) return false;
  const stick = nearBottom();
  if (node.synthOf) {
    const user = c.nodes[node.synthOf];
    const old = $('transcript').querySelector(`.cmp-synth[data-synth="${node.synthOf}"]`);
    if (!user || !old) return true;
    const fresh = synthEl(c, user);
    if (fresh) replaceKeepingFocus(old, fresh); else old.remove();
  } else {
    const x = openGroupOf(c, node);
    if (!x) return false;
    const old = $('transcript').querySelector(`.cmp-lane[data-id="${node.id}"]`);
    if (!old) return false;
    replaceKeepingFocus(old, laneEl(c, node, old.classList.contains('on'), x.group.kind || 'compare'));
  }
  if (stick) toBottom();
  if (opts.final) { ui.renderComposer(); ui.renderTitle(); }
  return true;
}

/* ---------- actions ---------- */

function keep(c, user, id) {
  const g = user.compare;
  const i = user.children.indexOf(id);
  if (i < 0) return;
  g.kept = id;
  user.sel = i;
  tabs.delete(user.id);
  state.selectedNode = c.nodes[id];
  saveConversation(c);
  ui.render();
  ui.renderInspector();
  dispatchEvent(new CustomEvent('eden:choice', { detail: { kind: 'keep', c, user, keptId: id } })); // H2: the router learns (learned.js)
  const r = c.nodes[id].route;
  toast(`Kept ${r ? shortModel(r.modelName || r.model) : 'that answer'}. The other${g.ids.length > 2 ? 's stay' : ' stays'} in the pager.`);
}

function showTab(box, user, i) {
  tabs.set(user.id, i);
  box.querySelectorAll('.cmp-tabs [role="tab"]').forEach((t, j) => { t.classList.toggle('on', j === i); t.setAttribute('aria-selected', String(j === i)); });
  box.querySelectorAll('.cmp-lane').forEach((l, j) => l.classList.toggle('on', j === i));
  // what you look at on a phone is what the next message continues from
  const k = user.children.indexOf(user.compare.ids[i]);
  if (k >= 0 && user.sel !== k) { user.sel = k; saveConversation(state.current); }
}

function onClick(e) {
  const b = e.target.closest('[data-act]');
  const c = state.current;
  if (!b || !c) return;
  const act = b.dataset.act;
  const msg = b.closest('.msg');
  const node = msg ? c.nodes[msg.dataset.id] : null;
  switch (act) {
    case 'stronger': {
      if (!node) return;
      if (state.streams.has(c.id)) { toast('Wait for the reply, or stop it first'); return; }
      const up = strongerFor(c, node);
      if (!up) { toast('That was already the strongest model you can use.'); return; }
      T.regenerate(c, node, { model: up.model, effort: up.effort }, { compare: true });
      break;
    }
    case 'cmp-keep': { const x = node && groupOf(c, node); if (x) keep(c, x.user, node.id); break; }
    case 'cmp-open': {
      const x = node && groupOf(c, node);
      if (!x) return;
      x.group.kept = null;
      tabs.set(x.user.id, Math.max(0, x.group.ids.indexOf(node.id)));
      saveConversation(c);
      ui.render();
      break;
    }
    case 'cmp-tab': {
      const box = b.closest('.cmp');
      const user = box && c.nodes[box.dataset.cmp];
      if (user && user.compare) showTab(box, user, Number(b.dataset.i));
      break;
    }
    case 'cmp-stop': {
      const st = state.streams.get(c.id);
      if (!st) return;
      if (b.dataset.lane === 'synthesis') { if (st.stopLane) st.stopLane('synthesis'); return; }
      const x = node && groupOf(c, node);
      if (st.kind === 'compare' && st.stopLane && x) st.stopLane(x.group.ids.indexOf(node.id));
      else T.stop(c); // "Ask a stronger model" is one ordinary reply
      break;
    }
    default: return;
  }
  e.stopPropagation();
}

/** Swipe between the answers on a phone (tabs below 640 px). */
function initSwipe() {
  let start = null;
  const tr = $('transcript');
  tr.addEventListener('touchstart', (e) => {
    const lanes = e.target.closest('.cmp-lanes');
    start = lanes && e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, box: lanes.closest('.cmp') } : null;
  }, { passive: true });
  tr.addEventListener('touchend', (e) => {
    if (!start || !matchMedia('(max-width:640px)').matches) { start = null; return; }
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x, dy = t.clientY - start.y;
    const box = start.box;
    start = null;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const c = state.current;
    const user = c && box && c.nodes[box.dataset.cmp];
    if (!user || !user.compare) return;
    const n = user.compare.ids.length;
    const i = Math.max(0, Math.min(n - 1, tabOf(user) + (dx < 0 ? 1 : -1)));
    if (i !== tabOf(user)) showTab(box, user, i);
  }, { passive: true });
}

let inited = false;
/** From composer.js (after the other ui.updateMessage wrappers): the menus, and redrawing lanes in place. */
export function initCompare(handlers) {
  H = { ...H, ...handlers };
  setAutopilotMenus(H); // the autopilot tag's menu (autopilot.js)
  if (inited) return;
  inited = true;
  const base = ui.updateMessage;
  ui.updateMessage = (c, node, opts) => { if (!updateLane(c, node, opts || {})) base(c, node, opts); };
  $('transcript').addEventListener('click', onClick);
  $('transcript').addEventListener('keydown', (e) => {
    // ←/→ between the answer tabs
    const t = e.target.closest('.cmp-tabs [role="tab"]');
    if (!t || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
    const box = t.closest('.cmp');
    const c = state.current;
    const user = c && c.nodes[box.dataset.cmp];
    if (!user || !user.compare) return;
    e.preventDefault();
    const n = user.compare.ids.length;
    const i = (Number(t.dataset.i) + (e.key === 'ArrowRight' ? 1 : -1) + n) % n;
    showTab(box, user, i);
    box.querySelectorAll('.cmp-tabs [role="tab"]')[i].focus();
  });
  initSwipe();
}
