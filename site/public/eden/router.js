// The Model Router in the page: settings (levels, sliders, providers, override, classifier),
// the live preview while typing (POST /api/route), the quality-vs-cost scatter, the routing
// chip popover and the inspector's Route tab.

import { $, el, svgEl, ico, toast, fmtCost, effortLabel, shortModel, debounce, setSeg, placePopup, EFFORT_SHORT, confidencePct } from './util.js';
import { state, ui, saveSettings } from './state.js';
import { api } from './api.js';

const PROVIDER_COLORS = { anthropic: '#d08159', openai: '#4d9f8a', gemini: '#5b7fd0', kimi: '#8b6fc0' };
const PROVIDER_NAMES = { anthropic: 'Anthropic Claude', openai: 'OpenAI GPT', gemini: 'Google Gemini', kimi: 'Moonshot Kimi' };
// secondary encoding (the colours alone aren't colour-blind safe): a shape per provider
const PROVIDER_SHAPES = { anthropic: 'circle', openai: 'square', gemini: 'diamond', kimi: 'triangle' };

export const LEVELS_FALLBACK = [
  { level: 1, name: 'max-efficiency', label: 'Max efficiency', efficiency: 80, performance: 30, description: 'Fewest tokens and lowest cost; good-enough answers are fine.' },
  { level: 2, name: 'efficient', label: 'Efficient', efficiency: 60, performance: 40, description: 'Leans on cheaper models; pays more only for a clear quality gain.' },
  { level: 3, name: 'balanced', label: 'Balanced', efficiency: 50, performance: 50, description: 'The default: a 2× cost increase has to buy about 8 quality points.' },
  { level: 4, name: 'performance', label: 'Performance', efficiency: 40, performance: 70, description: 'Strong answers first; cost matters mostly between similar models.' },
  { level: 5, name: 'max-performance', label: 'Max performance', efficiency: 35, performance: 90, description: 'Best expected answer; cost only breaks near-ties.' },
];
export const levels = () => (state.meta && Array.isArray(state.meta.levels) && state.meta.levels.length ? state.meta.levels : LEVELS_FALLBACK);

export function providerColor(p) { return PROVIDER_COLORS[p] || '#8e8e93'; }
export function modelInfo(id) { return ((state.meta && state.meta.models) || []).find((m) => m.id === id) || null; }
export function availableModels() { return ((state.meta && state.meta.models) || []).filter((m) => m.available); }

export function availableProviders() {
  const provs = (state.meta && state.meta.providers) || [];
  return provs.filter((p) => p.available && state.settings.providers[p.id] !== false).map((p) => p.id);
}

/** The settings each route / send carries. */
export function routeSettings() {
  const s = state.settings;
  const provs = availableProviders();
  return {
    level: s.level, efficiency: s.efficiency, performance: s.performance,
    providers: provs,
    classifier: classifierUsable() ? s.classifier : 'off',
    subscriptionClaude: !!s.subscriptionClaude,
  };
}
export function settingsSig() { const r = routeSettings(); return JSON.stringify([r.level, r.efficiency, r.performance, r.providers, r.classifier, r.subscriptionClaude]); }
function classifierUsable() { return !state.meta || !state.meta.classifier || state.meta.classifier.available !== false; }

export function currentOverride() {
  const o = state.settings.override;
  if (!o || !o.model) return null;
  const m = modelInfo(o.model);
  if (state.meta && (!m || !m.available)) return null;
  return { model: o.model, effort: o.effort || (m && m.defaultEffort) || undefined };
}
export function setOverride(model, effort) {
  if (!model) state.settings.override = null;
  else {
    const m = modelInfo(model);
    const e = effort && m && m.efforts && !m.efforts.includes(effort) ? m.defaultEffort : (effort || (m && m.defaultEffort));
    state.settings.override = { model, effort: e };
  }
  saveSettings();
  renderRouteControls();
  ui.renderComposer();
  schedulePreview();
}

/* ---------- levels and sliders ---------- */

function interpPerf(eff) {
  // linked: follow the five levels' curve (efficiency ↓ as performance ↑)
  const L = [...levels()].sort((a, b) => a.efficiency - b.efficiency);
  if (eff <= L[0].efficiency) return L[0].performance;
  if (eff >= L[L.length - 1].efficiency) return L[L.length - 1].performance;
  for (let i = 0; i < L.length - 1; i++) {
    const a = L[i], b = L[i + 1];
    if (eff >= a.efficiency && eff <= b.efficiency) return Math.round(a.performance + ((eff - a.efficiency) / (b.efficiency - a.efficiency || 1)) * (b.performance - a.performance));
  }
  return 50;
}
function interpEff(perf) {
  const L = [...levels()].sort((a, b) => a.performance - b.performance);
  if (perf <= L[0].performance) return L[0].efficiency;
  if (perf >= L[L.length - 1].performance) return L[L.length - 1].efficiency;
  for (let i = 0; i < L.length - 1; i++) {
    const a = L[i], b = L[i + 1];
    if (perf >= a.performance && perf <= b.performance) return Math.round(a.efficiency + ((perf - a.performance) / (b.performance - a.performance || 1)) * (b.efficiency - a.efficiency));
  }
  return 50;
}
function nearestLevel(eff, perf) {
  let best = 3, bd = Infinity;
  for (const L of levels()) { const d = Math.abs(L.efficiency - eff) + Math.abs(L.performance - perf); if (d < bd) { bd = d; best = L.level; } }
  return best;
}
function exactLevel() { const s = state.settings; const L = levels().find((x) => x.level === s.level); return !!L && L.efficiency === s.efficiency && L.performance === s.performance; }

export function setLevel(n) {
  const L = levels().find((x) => x.level === n);
  if (!L) return;
  Object.assign(state.settings, { level: n, efficiency: L.efficiency, performance: L.performance });
  saveSettings();
  renderRouteControls();
  schedulePreview();
}

function setSlider(input, v) { input.value = String(v); input.style.setProperty('--v', `${v}%`); }

export function renderRouteControls() {
  const s = state.settings;
  setSeg($('levelSeg'), s.level - 1);
  const L = levels().find((x) => x.level === s.level) || levels()[2];
  $('lvlName').textContent = exactLevel() ? `Level ${s.level} · ${L.label}` : `Custom · nearest Level ${s.level} (${L.label})`;
  $('lvlDesc').textContent = L.description || '';
  setSlider($('effSlider'), s.efficiency); $('effVal').textContent = s.efficiency;
  setSlider($('perfSlider'), s.performance); $('perfVal').textContent = s.performance;
  $('linkSw').checked = s.linked !== false;
  renderProviders();
  renderOverride();
  renderClassifier();
  renderReadout();
  if (state.meta && state.meta.scope) $('scopeNote').textContent = state.meta.scope;
}

function renderProviders() {
  const box = $('provList');
  const provs = (state.meta && state.meta.providers) || [];
  if (!provs.length) { box.replaceChildren(el('div', 'muted', state.metaError ? `Couldn’t load providers: ${state.metaError}` : 'Loading…')); return; }
  box.replaceChildren(...provs.map((p) => {
    const on = p.available && state.settings.providers[p.id] !== false;
    const input = el('input', { type: 'checkbox', 'aria-label': `Route to ${p.name}` });
    input.checked = on;
    input.disabled = !p.available;
    input.addEventListener('change', () => {
      const enabled = (state.meta.providers || []).filter((x) => x.available && (x.id === p.id ? input.checked : state.settings.providers[x.id] !== false));
      if (!enabled.length) { input.checked = true; toast('Keep at least one provider on'); return; }
      state.settings.providers[p.id] = input.checked;
      saveSettings();
      renderProviders();
      schedulePreview();
    });
    const via = p.available ? (p.via === 'claude-cli' ? 'via Claude Code (subscription)' : p.via ? `via ${p.via}` : 'available') : (p.reason || 'unavailable');
    const n = (state.meta.models || []).filter((m) => m.provider === p.id && m.available).length;
    return el('div', { class: `prov${on ? '' : ' off'}${p.available ? '' : ' na'}` },
      el('span', { class: `pdot ${p.id}`, 'aria-hidden': 'true' }),
      el('div', 'grow', el('div', 'p-n', p.name || PROVIDER_NAMES[p.id] || p.id), el('div', 'p-c', p.available ? `${n} model${n === 1 ? '' : 's'} · ${via}` : via)),
      p.available ? el('span', 'excl', 'excluded from routing') : null,
      el('label', 'switch', input, el('span', 'tr')));
  }));
}

function renderOverride() {
  const sel = $('overrideSel');
  const models = availableModels();
  const o = currentOverride();
  sel.replaceChildren(el('option', { value: '' }, 'Auto — router decides'));
  const groups = {};
  for (const m of models) (groups[m.provider] = groups[m.provider] || []).push(m);
  for (const [p, list] of Object.entries(groups)) {
    const g = el('optgroup', { label: PROVIDER_NAMES[p] || p });
    for (const m of list) g.append(el('option', { value: m.id }, m.name));
    sel.append(g);
  }
  sel.value = o ? o.model : '';
  const effWrap = $('ovEffWrap');
  const m = o && modelInfo(o.model);
  effWrap.hidden = !m || !(m.efforts && m.efforts.length > 1);
  if (m && m.efforts) {
    $('overrideEff').replaceChildren(...m.efforts.map((e) => el('option', { value: e }, `${EFFORT_SHORT[e] || e}${e === m.defaultEffort ? ' (default)' : ''}`)));
    $('overrideEff').value = o.effort || m.defaultEffort;
  }
  $('overrideCard').classList.toggle('pinned', !!o);
  $('pinTxt').textContent = o ? `Pinned to ${m ? m.name : o.model} — routing bypassed` : '';
}

function renderClassifier() {
  const sel = $('classifierSel');
  sel.value = state.settings.classifier;
  const c = state.meta && state.meta.classifier;
  const usable = classifierUsable();
  sel.disabled = !usable;
  $('classifierNote').textContent = !c ? '' : usable
    ? (state.settings.classifier === 'off' ? 'The coded rules rate each prompt (instant, free).' : 'The rules give the instant pick while you type; Gemini’s rating decides the send.')
    : `Rules only: ${c.reason || 'Gemini isn’t available'}.`;
}

function renderReadout() {
  const p = state.preview;
  const o = currentOverride();
  const out = $('lvlReadout');
  if (o) { const m = modelInfo(o.model); out.textContent = `Override · ${m ? m.name : o.model} · ${effortLabel(o.effort)}`; return; }
  if (!p) { out.textContent = `Level ${state.settings.level} · type a message to preview the pick`; return; }
  if (p.error) { out.textContent = `Preview unavailable: ${p.error}`; return; }
  if (p.loading && !p.pick) { out.textContent = 'Routing…'; return; }
  const k = p.pick;
  out.textContent = `Level ${state.settings.level} · ${shortModel(k.name)} · ${effortLabel(k.effort)} · est. ${fmtCost(k.costUSD)}/turn · quality ${k.quality}${p.rated ? ' · rated by Gemini' : ' · rules'}`;
}

export function initRouteControls() {
  $('levelSeg').addEventListener('click', (e) => { const b = e.target.closest('[data-level]'); if (b) setLevel(Number(b.dataset.level)); });
  $('levelSeg').addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); setLevel(Math.max(1, Math.min(5, state.settings.level + (e.key === 'ArrowRight' ? 1 : -1)))); $('levelSeg').querySelector('.on').focus(); }
  });
  const onSlide = (which) => () => {
    const s = state.settings;
    const v = Number($(which === 'eff' ? 'effSlider' : 'perfSlider').value);
    if (which === 'eff') { s.efficiency = v; if (s.linked !== false) s.performance = interpPerf(v); }
    else { s.performance = v; if (s.linked !== false) s.efficiency = interpEff(v); }
    s.level = nearestLevel(s.efficiency, s.performance);
    renderRouteControls();
  };
  const commit = () => { saveSettings(); schedulePreview(); };
  $('effSlider').addEventListener('input', onSlide('eff'));
  $('perfSlider').addEventListener('input', onSlide('perf'));
  $('effSlider').addEventListener('change', commit);
  $('perfSlider').addEventListener('change', commit);
  $('linkSw').addEventListener('change', () => { state.settings.linked = $('linkSw').checked; saveSettings(); });
  $('overrideSel').addEventListener('change', () => setOverride($('overrideSel').value || null));
  $('overrideEff').addEventListener('change', () => { const o = currentOverride(); if (o) setOverride(o.model, $('overrideEff').value); });
  $('classifierSel').addEventListener('change', () => { state.settings.classifier = $('classifierSel').value; saveSettings(); renderClassifier(); schedulePreview(); });
}

/* ---------- live preview (POST /api/route, debounced 600 ms) ---------- */

let previewAbort = null;
let previewText = '';
export function setPreviewText(text) {
  previewText = text;
  schedulePreview();
}
const runPreview = debounce(async () => {
  if (previewAbort) previewAbort.abort();
  const text = previewText.trim();
  const conv = state.current;
  if (!text || currentOverride() || (conv && conv.kind === 'code')) {
    state.preview = null;
    ui.renderComposer(); renderReadout();
    return;
  }
  const r = routeSettings();
  if (!r.providers.length) { state.preview = { error: 'no providers available' }; ui.renderComposer(); renderReadout(); return; }
  previewAbort = new AbortController();
  const mine = previewAbort;
  state.preview = { ...(state.preview || {}), loading: true, text };
  ui.renderComposer();
  try {
    const res = await api.route({ prompt: text, ...r }, mine.signal);
    if (mine !== previewAbort) return;
    const rated = !!(res.classification && res.classification.used);
    state.preview = { text, pick: res.pick, rows: res.rows || [], rated, classification: res.classification, loading: false };
  } catch (e) {
    if (e.name === 'AbortError') return;
    state.preview = { text, error: e.message, loading: false };
  }
  ui.renderComposer();
  renderReadout();
}, 600);
export function schedulePreview() { runPreview(); }

/* ---------- the scatter: quality vs cost (log), from candidates ---------- */

function shape(kind, cx, cy, r, attrs) {
  if (kind === 'square') return svgEl('rect', { x: cx - r * 0.88, y: cy - r * 0.88, width: r * 1.76, height: r * 1.76, rx: 1.5, ...attrs });
  if (kind === 'diamond') return svgEl('path', { d: `M${cx} ${cy - r * 1.2}L${cx + r * 1.2} ${cy}L${cx} ${cy + r * 1.2}L${cx - r * 1.2} ${cy}Z`, ...attrs });
  if (kind === 'triangle') return svgEl('path', { d: `M${cx} ${cy - r * 1.15}L${cx + r * 1.1} ${cy + r * 0.85}L${cx - r * 1.1} ${cy + r * 0.85}Z`, ...attrs });
  return svgEl('circle', { cx, cy, r, ...attrs });
}

/** points: [{ name, provider, effort, quality, costUSD, chosen }] */
export function scatter(points, { width = 236, height = 140 } = {}) {
  const pts = (points || []).filter((p) => typeof p.quality === 'number' && typeof p.costUSD === 'number').slice(0, 6);
  if (!pts.length) return el('div', 'scatter-empty', 'No candidates to compare.');
  const W = width, H = height, L = 30, R = 12, T = 14, B = 26;
  const costs = pts.map((p) => Math.max(p.costUSD, 1e-6));
  let lo = Math.log10(Math.min(...costs)), hi = Math.log10(Math.max(...costs));
  if (hi - lo < 0.3) { lo -= 0.3; hi += 0.3; }
  const qs = pts.map((p) => p.quality);
  let qlo = Math.min(...qs), qhi = Math.max(...qs);
  if (qhi - qlo < 6) { qlo -= 3; qhi += 3; }
  const pad = (qhi - qlo) * 0.12; qlo -= pad; qhi += pad;
  const x = (c) => L + ((Math.log10(Math.max(c, 1e-6)) - lo) / (hi - lo)) * (W - L - R);
  const y = (q) => T + (1 - (q - qlo) / (qhi - qlo)) * (H - T - B);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'scatter', role: 'img', 'aria-label': `Quality versus cost of ${pts.length} candidates; ${pts.filter((p) => p.chosen).map((p) => p.name).join('') || 'none'} chosen` });
  const axis = 'rgba(120,120,128,.35)';
  svg.append(svgEl('line', { x1: L, y1: T - 6, x2: L, y2: H - B, stroke: axis, 'stroke-width': 1 }));
  svg.append(svgEl('line', { x1: L, y1: H - B, x2: W - R + 4, y2: H - B, stroke: axis, 'stroke-width': 1 }));
  const t = (x0, y0, s, a = {}) => { const n = svgEl('text', { x: x0, y: y0, 'font-size': 8, fill: 'currentColor', opacity: 0.55, ...a }); n.textContent = s; return n; };
  svg.append(t(W - R + 4, H - 4, 'cost (log) →', { 'text-anchor': 'end' }));
  svg.append(t(2, 9, 'quality ↑'));
  svg.append(t(L, H - B + 10, fmtCost(10 ** lo), { 'text-anchor': 'start', opacity: 0.45, 'font-size': 7 }));
  svg.append(t(W - R, H - B + 10, fmtCost(10 ** hi), { 'text-anchor': 'end', opacity: 0.45, 'font-size': 7 }));
  svg.append(t(L - 3, y(qhi - pad) + 3, String(Math.round(qhi - pad)), { 'text-anchor': 'end', opacity: 0.45, 'font-size': 7 }));
  svg.append(t(L - 3, y(qlo + pad) + 3, String(Math.round(qlo + pad)), { 'text-anchor': 'end', opacity: 0.45, 'font-size': 7 }));
  // the frontier: points that buy quality with cost
  const sorted = [...pts].sort((a, b) => a.costUSD - b.costUSD);
  const front = [];
  for (const p of sorted) if (!front.length || p.quality > front[front.length - 1].quality) front.push(p);
  if (front.length > 1) svg.append(svgEl('path', { d: front.map((p, i) => `${i ? 'L' : 'M'}${x(p.costUSD).toFixed(1)} ${y(p.quality).toFixed(1)}`).join(' '), fill: 'none', stroke: 'rgba(120,120,128,.4)', 'stroke-width': 1, 'stroke-dasharray': '3 3' }));
  const placed = [];
  for (const p of [...pts].sort((a, b) => Number(!!a.chosen) - Number(!!b.chosen))) {
    const cx = x(p.costUSD), cy = y(p.quality);
    const g = svgEl('g', { class: 'pt' });
    const title = svgEl('title');
    title.textContent = `${p.name}${p.effort ? ` · ${effortLabel(p.effort)}` : ''} — quality ${p.quality}, ${fmtCost(p.costUSD)}${p.chosen ? ' (chosen)' : ''}`;
    g.append(title);
    if (p.chosen) g.append(svgEl('circle', { cx, cy, r: 8, fill: 'none', stroke: '#0a84ff', 'stroke-width': 1.5 }));
    g.append(shape(PROVIDER_SHAPES[p.provider] || 'circle', cx, cy, p.chosen ? 4.4 : 4.2, { fill: providerColor(p.provider), stroke: 'var(--content)', 'stroke-width': 1.2 }));
    // a direct label on every point (≤6), nudged off its neighbours
    let ly = cy + 14;
    if (ly > H - B - 1) ly = cy - 9;
    for (const q of placed) if (Math.abs(q.x - cx) < 34 && Math.abs(q.y - ly) < 8) ly = ly > cy ? ly + 8 : ly - 8;
    placed.push({ x: cx, y: ly });
    const anchor = cx < L + 22 ? 'start' : cx > W - R - 22 ? 'end' : 'middle';
    const lbl = svgEl('text', { x: cx, y: ly, 'text-anchor': anchor, 'font-size': 7.5, fill: p.chosen ? '#0a84ff' : 'currentColor', opacity: p.chosen ? 1 : 0.65, 'font-weight': p.chosen ? 600 : 400 });
    lbl.textContent = `${shortModel(p.name).replace(/^(GPT|Gemini|Kimi) /, (m) => (m === 'Gemini ' ? 'Gem. ' : m))}${p.chosen ? ' ✓' : ''}`;
    g.append(lbl);
    svg.append(g);
  }
  return svg;
}

export function rowsToCandidates(rows, pick) {
  const list = (rows || []).filter((r) => r.eligible !== false).sort((a, b) => b.quality - a.quality);
  const out = [];
  const pickRow = list.find((r) => r.model === pick.model) || pick;
  out.push({ ...pickRow, chosen: true });
  for (const r of list) { if (out.length >= 6) break; if (r.model !== pick.model) out.push({ ...r, chosen: false }); }
  return out;
}

/* ---------- the routing chip popover ---------- */

export function ratedBadge(route) {
  if (!route) return null;
  if (route.override) return el('span', 'badge pinned', 'override');
  if (route.via === 'claude-code') return el('span', 'badge rules', 'Claude Code');
  const label = route.ratedLabel || (route.rated ? `rated by ${route.ratedBy || 'Gemini'}` : 'rules');
  return el('span', route.rated ? 'badge gemini' : 'badge rules', label);
}

let popAnchor = null, popCloseT = 0, popOpenT = 0, popPinned = false;
export function openChipPop(anchor, content, { pinned = true } = {}) {
  const pop = $('chipPop');
  clearTimeout(popCloseT);
  if (popAnchor && popAnchor !== anchor) popAnchor.setAttribute('aria-expanded', 'false');
  popAnchor = anchor;
  popPinned = pinned;
  pop.replaceChildren(...content);
  pop.classList.add('show');
  anchor.setAttribute('aria-expanded', 'true');
  placePopup(pop, anchor, 'below');
}
export function closeChipPop(refocus) {
  const pop = $('chipPop');
  if (!pop.classList.contains('show')) return false;
  pop.classList.remove('show');
  if (popAnchor) { popAnchor.setAttribute('aria-expanded', 'false'); if (refocus) popAnchor.focus(); }
  popAnchor = null;
  return true;
}
export function chipPopOpenFor(anchor) { return popAnchor === anchor && $('chipPop').classList.contains('show'); }
export function chipPopAnchor() { return popAnchor; }
export function initChipPop() {
  const pop = $('chipPop');
  pop.addEventListener('mouseenter', () => clearTimeout(popCloseT));
  pop.addEventListener('mouseleave', () => { if (!popPinned) popCloseT = setTimeout(() => closeChipPop(), 220); });
  document.addEventListener('pointerdown', (e) => {
    if (pop.classList.contains('show') && !pop.contains(e.target) && !(popAnchor && popAnchor.contains(e.target))) closeChipPop();
  });
  addEventListener('resize', () => closeChipPop());
  document.addEventListener('scroll', (e) => { if (pop.classList.contains('show') && !pop.contains(e.target)) closeChipPop(); }, true);
}
/** Hover intent on a chip: opens unpinned after a beat, closes when the pointer leaves both. */
export function hoverIntent(anchor, build) {
  anchor.addEventListener('mouseenter', () => {
    clearTimeout(popCloseT); clearTimeout(popOpenT);
    if (matchMedia('(hover:none)').matches) return;
    popOpenT = setTimeout(() => { if (!chipPopOpenFor(anchor)) openChipPop(anchor, build(), { pinned: false }); }, 350);
  });
  anchor.addEventListener('mouseleave', () => {
    clearTimeout(popOpenT);
    if (chipPopOpenFor(anchor) && !popPinned) popCloseT = setTimeout(() => closeChipPop(), 220);
  });
}

export function routePopContent(route, usage, { onOpenConsole } = {}) {
  const kids = [el('div', 'cp-t', 'Candidates · quality vs cost')];
  const cands = (route.candidates || []).length ? route.candidates : [{ model: route.model, name: route.modelName || route.model, provider: route.provider, effort: route.effort, quality: route.quality, costUSD: route.costUSD, chosen: true }];
  kids.push(scatter(cands));
  kids.push(el('div', 'cp-row', el('span', '', 'Estimated'), el('b', '', fmtCost(route.costUSD))));
  if (usage && typeof usage.costUSD === 'number') kids.push(el('div', 'cp-row', el('span', '', usage.notional ? 'Actual (subscription, not billed)' : 'Actual'), el('b', '', fmtCost(usage.costUSD))));
  if (typeof route.quality === 'number') kids.push(el('div', 'cp-row', el('span', '', 'Expected quality'), el('b', '', String(route.quality))));
  if (route.rationale) kids.push(el('div', 'cp-why', route.rationale));
  if (onOpenConsole) kids.push(el('button', { type: 'button', class: 'cp-link', onclick: onOpenConsole }, 'Open in Route console →'));
  return kids;
}

/* ---------- inspector: the selected turn ---------- */

export function renderTurnCard(node) {
  const card = $('turnCard');
  const r = node && node.route;
  if (!r) { card.replaceChildren(el('div', 'muted', 'Send a message, or click a routing chip, to see why the router picked its model.')); return; }
  const kids = [
    el('div', 'tc-model', el('span', { class: `pdot ${r.provider || ''}`, 'aria-hidden': 'true' }), el('span', '', `${r.modelName || r.model}${r.effort ? ` · ${r.effortLabel || effortLabel(r.effort)}` : ''}`)),
    el('div', 'tc-row', el('span', '', 'Est. cost'), el('b', '', fmtCost(r.costUSD))),
  ];
  if (node.usage && typeof node.usage.costUSD === 'number') kids.push(el('div', 'tc-row', el('span', '', node.usage.notional ? 'Actual (subscription)' : 'Actual cost'), el('b', '', fmtCost(node.usage.costUSD))));
  if (node.usage && (node.usage.inputTokens || node.usage.outputTokens)) kids.push(el('div', 'tc-row', el('span', '', 'Tokens in / out'), el('b', '', `${node.usage.inputTokens || 0} / ${node.usage.outputTokens || 0}${node.usage.reasoningTokens ? ` (+${node.usage.reasoningTokens} thinking)` : ''}`)));
  const conf = confidencePct(r.confidence);
  kids.push(el('div', 'tc-row', el('span', '', 'Expected quality'), el('b', '', `${typeof r.quality === 'number' ? r.quality : '—'}${conf !== null ? ` · conf. ${conf}%` : ''}`)));
  if (r.complexity) kids.push(el('div', 'tc-row', el('span', '', 'Task'), el('b', '', String(r.complexity))));
  kids.push(el('div', 'tc-row', el('span', '', 'Quality signal'), el('span', '', ratedBadge(r))));
  if (r.rationale) kids.push(el('div', 'tc-why', r.rationale));
  const extra = [...(r.warnings || []), ...(r.notes || [])].filter(Boolean);
  if (extra.length) kids.push(el('ul', 'tc-list', ...extra.map((w) => el('li', '', typeof w === 'string' ? w : JSON.stringify(w)))));
  if ((r.candidates || []).length) kids.push(el('div', { style: { marginTop: '10px' } }, scatter(r.candidates, { width: 280, height: 150 })));
  card.replaceChildren(...kids);
  card.classList.remove('hl'); void card.offsetWidth; card.classList.add('hl');
}

export { PROVIDER_NAMES, ico };
