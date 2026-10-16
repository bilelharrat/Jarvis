// The Model Router pane in Eden Code's workbench (features/code-router.js routes; this shows
// it): what askeden.com's chat shows of the router in the page (its inspector's Route tab,
// web/chat/router.js in the askeden repo), drawn here in Eden Code's own glass, on this
// window's own router and settings. Before it, "Open Model Router" started the Model Router
// folder's own dev server (5174) and opened it in a separate browser tab; the owner wanted it
// in the app, as the website has it.
// - Opened from the composer popover's "Open Model Router" (with the draft), the More menu
//   and /router. A small "developer page" link at the foot still opens the Model Router
//   repo's own page in the browser (model_router_open), for working on the router itself.
// - Try a prompt: the pick for what's typed (model, effort, cost a turn, quality, why), live
//   as it changes, from the rules (instant, free; askeden.com's preview is the same). "Rate
//   with Gemini" asks for the rating a message would get (one small Gemini call on the
//   owner's key, as the composer's chip makes).
// - The candidates, quality against cost (log), the pick ringed, the frontier dashed.
// - Optimize for: the five levels, the Token Efficiency and Performance sliders (with what
//   each does), linked or not, and "Just this project" (code_router_projects through the
//   adapter: a session's project keeps its own levels).
// - Providers: each of the router's providers with the models it has from Settings › Models,
//   switchable (code_router_providers_off: left out of every route, the composer's too).
// - Model: Model Router picks (routing live), or a model pinned (the composer menu's own
//   pick: Model Router goes off, Shadow mode then says what it would have picked).
// - Pricing: Claude on the owner's plan (subscriptionClaude) and the month's budget lean.
// - Rating: Gemini on every prompt, when the rules are unsure, or the rules only.
// - Recent routed messages from the router's event log (model_router_call "recent": numbers
//   and model ids only, never a prompt's words): live picks, and Shadow picks with what they
//   would have saved.
// Cost policy: the pane calls no model by itself. The preview is the router's rules, in this
// window. Only "Rate with Gemini" (a click) asks Gemini, once, on the owner's key, under the
// router's daily cap (code_router.RATINGS_PER_DAY); a trivial prompt is never rated.
// Pure helpers are exported for node --test (tests/web/code-router-pane.test.mjs).
(function (root) {
  'use strict';

  const PANE = 'router';
  const PROVIDERS = ['anthropic', 'openai', 'gemini', 'kimi'];  // = code_router.PROVIDERS
  const PROVIDER_NAMES = { anthropic: 'Anthropic Claude', openai: 'OpenAI GPT', gemini: 'Google Gemini', kimi: 'Moonshot Kimi' };
  // askeden.com's provider colours, each with a shape too (colour alone isn't colour-blind safe).
  const PROVIDER_COLORS = { anthropic: '#d08159', openai: '#4d9f8a', gemini: '#5b7fd0', kimi: '#8b6fc0' };
  const PROVIDER_SHAPES = { anthropic: 'circle', openai: 'square', gemini: 'diamond', kimi: 'triangle' };
  const LEVELS_FALLBACK = [
    { level: 1, label: 'Max efficiency', efficiency: 80, performance: 30, description: 'Fewest tokens and lowest cost; good-enough answers are fine.' },
    { level: 2, label: 'Efficient', efficiency: 60, performance: 40, description: 'Leans on cheaper models; pays more only for a clear quality gain.' },
    { level: 3, label: 'Balanced', efficiency: 50, performance: 50, description: 'The default: a 2× cost increase has to buy about 8 quality points.' },
    { level: 4, label: 'Performance', efficiency: 40, performance: 70, description: 'Strong answers first; cost matters mostly between similar models.' },
    { level: 5, label: 'Max performance', efficiency: 35, performance: 90, description: 'Best expected answer; cost only breaks near-ties.' },
  ];
  const CLASSIFIERS = [
    ['always', 'Gemini rates every prompt'],
    ['auto', 'Gemini rates when the rules are unsure'],
    ['off', 'Rules only'],
  ];
  const EFFORT_WORDS = { none: 'no extra thinking', minimal: 'minimal effort', low: 'low effort', medium: 'medium effort', high: 'high effort', xhigh: 'extra-high effort', max: 'max effort' };
  const MAX_POINTS = 8;
  const PREVIEW_MS = 250;  // the rules are instant: this only spares redrawing on every key

  // ── pure helpers ──

  const levelsOf = (meta) => (meta && Array.isArray(meta.levels) && meta.levels.length ? meta.levels : LEVELS_FALLBACK);
  // Linked sliders follow the five levels' curve (efficiency down as performance goes up).
  function along(levels, value, from, to) {
    const L = [...levels].sort((a, b) => a[from] - b[from]);
    if (value <= L[0][from]) return L[0][to];
    if (value >= L[L.length - 1][from]) return L[L.length - 1][to];
    for (let i = 0; i < L.length - 1; i++) {
      const a = L[i], b = L[i + 1];
      if (value >= a[from] && value <= b[from]) return Math.round(a[to] + ((value - a[from]) / (b[from] - a[from] || 1)) * (b[to] - a[to]));
    }
    return 50;
  }
  const interpPerf = (levels, eff) => along(levels, eff, 'efficiency', 'performance');
  const interpEff = (levels, perf) => along(levels, perf, 'performance', 'efficiency');
  function nearestLevel(levels, eff, perf) {
    let best = 3, bd = Infinity;
    for (const L of levels) { const d = Math.abs(L.efficiency - eff) + Math.abs(L.performance - perf); if (d < bd) { bd = d; best = L.level; } }
    return best;
  }
  // {level, exact, entry}: the level the sliders are at (or nearest to).
  function levelAt(levels, eff, perf) {
    const n = nearestLevel(levels, eff, perf);
    const entry = levels.find((x) => x.level === n) || levels[Math.floor(levels.length / 2)];
    return { level: n, exact: entry.efficiency === eff && entry.performance === perf, entry };
  }
  function levelName(at) {
    return at.exact ? `Level ${at.level} · ${at.entry.label}` : `Custom · nearest Level ${at.level} (${at.entry.label})`;
  }

  function fmtCost(usd) {
    if (!Number.isFinite(usd)) return '—';
    const a = Math.abs(usd);
    if (a >= 1) return `$${usd.toFixed(2)}`;
    if (a >= 0.01) return `$${usd.toFixed(3)}`;
    if (a >= 0.0001) return `$${usd.toFixed(5)}`;
    if (a === 0) return '$0';
    return `$${usd.toPrecision(2)}`;
  }
  // A model's name short enough to label a point: no "(preview)", no "Claude", "Gem." for Gemini.
  const shortName = (name) => String(name || '').replace(/\s*\((?:preview|beta)\)\s*$/i, '').replace(/^Claude /, '').replace(/^Gemini /, 'Gem. ').replace(/ Preview$/i, '');
  const effortWords = (e) => EFFORT_WORDS[e] || (e ? `${e} effort` : '');

  // The scatter's points: the pick first (chosen), then the best of the rest by quality, at
  // most max; only the rows the router would take (eligible), the pick always.
  function candidates(rows, pick, max = MAX_POINTS) {
    const list = (rows || []).filter((r) => r && r.eligible !== false && Number.isFinite(r.quality) && Number.isFinite(r.costUSD)).sort((a, b) => b.quality - a.quality);
    if (!pick) return list.slice(0, max).map((r) => ({ ...r, chosen: false }));
    const same = (r) => r.model === pick.model && (r.effort || '') === (pick.effort || '');
    const own = list.find(same) || pick;
    const out = [{ ...own, chosen: true }];
    for (const r of list) { if (out.length >= max) break; if (!same(r)) out.push({ ...r, chosen: false }); }
    return out;
  }
  // Where each point goes in a width × height plot: cost on a log axis, quality up; the
  // frontier (points that buy quality with cost); a label for each, nudged off its
  // neighbours. Plain numbers, drawn by svgScatter (and checked by the tests).
  function scatterLayout(points, { width = 440, height = 210 } = {}) {
    const pts = (points || []).filter((p) => Number.isFinite(p.quality) && Number.isFinite(p.costUSD)).slice(0, MAX_POINTS);
    if (!pts.length) return null;
    const W = width, H = height, L = 34, R = 14, T = 16, B = 28;
    const costs = pts.map((p) => Math.max(p.costUSD, 1e-6));
    let lo = Math.log10(Math.min(...costs)), hi = Math.log10(Math.max(...costs));
    if (hi - lo < 0.3) { lo -= 0.3; hi += 0.3; }
    const qs = pts.map((p) => p.quality);
    let qlo = Math.min(...qs), qhi = Math.max(...qs);
    if (qhi - qlo < 6) { qlo -= 3; qhi += 3; }
    const pad = (qhi - qlo) * 0.12;
    const x = (c) => L + ((Math.log10(Math.max(c, 1e-6)) - lo) / (hi - lo)) * (W - L - R);
    const y = (q) => T + (1 - (q - (qlo - pad)) / ((qhi + pad) - (qlo - pad))) * (H - T - B);
    const sorted = [...pts].sort((a, b) => a.costUSD - b.costUSD);
    const front = [];
    for (const p of sorted) if (!front.length || p.quality > front[front.length - 1].quality) front.push(p);
    const placed = [];
    const dots = [...pts].sort((a, b) => Number(!!a.chosen) - Number(!!b.chosen)).map((p) => {
      const cx = x(p.costUSD), cy = y(p.quality);
      let ly = cy + 15;
      if (ly > H - B - 1) ly = cy - 10;
      for (const q of placed) if (Math.abs(q.x - cx) < 64 && Math.abs(q.y - ly) < 10) ly = ly > cy ? ly + 10 : ly - 10;
      placed.push({ x: cx, y: ly });
      const anchor = cx < L + 28 ? 'start' : cx > W - R - 28 ? 'end' : 'middle';
      return { ...p, cx, cy, ly, anchor };
    });
    return {
      width: W, height: H, left: L, right: R, top: T, bottom: B,
      costLo: 10 ** lo, costHi: 10 ** hi, qualityLo: Math.round(qlo), qualityHi: Math.round(qhi),
      yLo: y(qlo), yHi: y(qhi),
      frontier: front.length > 1 ? front.map((p, i) => `${i ? 'L' : 'M'}${x(p.costUSD).toFixed(1)} ${y(p.quality).toFixed(1)}`).join(' ') : '',
      dots,
    };
  }

  // What the readout says of a route result: the pick's line, its numbers, why, and whether
  // Gemini rated it. null with no pick.
  function readout(result, nameOf = (id) => id) {
    const pick = result && result.pick;
    if (!pick || !pick.model) return null;
    const c = result.classification || {};
    const level = result.optimization && result.optimization.level;
    const notes = [...(pick.warnings || []), ...(Array.isArray(result.notes) ? result.notes : [])].filter((n) => typeof n === 'string' && n);
    return {
      model: pick.model,
      name: pick.name || nameOf(pick.model),
      effort: pick.effort || '',
      provider: pick.provider || '',
      costUSD: pick.costUSD,
      quality: Number.isFinite(pick.quality) ? Math.round(pick.quality) : null,
      complexity: (c.used ? c.finalComplexity : '') || (result.task && result.task.complexity) || '',
      rated: c.used === true,
      ratedBy: c.used === true ? (c.name || c.model || 'Gemini') : '',
      level: level && level.level ? `Level ${level.level} · ${level.label}` : '',
      why: pick.rationale || '',
      notes,
    };
  }

  // The providers as the pane lists them: each of the router's, with the models it has in
  // Settings › Models, whether it's routed to, and whether it's the last one on (it can't
  // be switched off then).
  function providerRows(models, providerOf, off) {
    const skip = new Set(off || []);
    const rows = PROVIDERS.map((id) => {
      const list = (models || []).filter((m) => providerOf(m.model) === id);
      return { id, name: PROVIDER_NAMES[id], models: list.map((m) => m.label || m.model), available: list.length > 0, on: list.length > 0 && !skip.has(id) };
    });
    const onCount = rows.filter((r) => r.on).length;
    for (const r of rows) r.last = r.on && onCount === 1;
    return rows;
  }
  // The off list after switching one provider (null: not allowed, it's the last one on).
  function toggledOff(rows, id, on) {
    const row = rows.find((r) => r.id === id);
    if (!row || !row.available) return null;
    if (!on && row.last) return null;
    const off = rows.filter((r) => r.available && !r.on).map((r) => r.id).filter((x) => x !== id);
    if (!on) off.push(id);
    return PROVIDERS.filter((p) => off.includes(p));
  }

  function ago(iso, now = Date.now()) {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return '';
    const s = Math.max(0, Math.round((now - t) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
  }
  // One recent routed message ("recent" from the event log) as the list says it.
  function recentLine(row, nameOf = (id) => id, now = Date.now()) {
    const pick = row.pick || {};
    const name = pick.model ? nameOf(pick.model) : 'No pick';
    const head = `${name}${pick.effort && pick.effort !== 'none' ? ` · ${pick.effort}` : ''}`;
    const bits = [];
    if (row.shadow) {
      const ran = row.applied && row.applied.model ? nameOf(row.applied.model) : '';
      if (ran && ran !== name) bits.push(`stayed on ${ran}`);
      const save = row.wouldSaveUSD;
      if (Number.isFinite(save) && Math.abs(save) >= 0.0005) bits.push(save > 0 ? `would have saved ${fmtCost(save)}` : `would have cost ${fmtCost(-save)} more`);
    } else if (row.skipped) {
      bits.push('not moved');
    }
    if (Number.isFinite(row.costUSD)) bits.push(`ran ${fmtCost(row.costUSD)}`);
    if (row.complexity) bits.push(row.complexity);
    return {
      head,
      kind: row.shadow ? 'Shadow' : 'Routed',
      rated: row.rated ? 'rated by Gemini' : 'rules',
      detail: bits.join(' · '),
      when: ago(row.ts, now),
      signals: (row.signals || []).map((s) => ({ wrongPick: 'marked wrong', override: 'model changed after', retry: 'retried', reverted: 'undone', 'thumbs-up': '👍', 'thumbs-down': '👎' }[s] || s)),
    };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      levelsOf, shortName, interpPerf, interpEff, nearestLevel, levelAt, levelName, fmtCost, effortWords, candidates,
      scatterLayout, readout, providerRows, toggledOff, ago, recentLine,
      LEVELS_FALLBACK, PROVIDERS, PROVIDER_COLORS, PANE, MAX_POINTS,
    };
    return;
  }

  // ── the window ──

  const F = root.jarvisFeatures;
  if (!F || typeof F.registerPane !== 'function') return;
  const el = (tag, cls, text) => F.el(tag, cls, text);
  const view = () => (F.codeRouter && F.codeRouter.view) || null;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = (tag, attrs = {}) => {
    const n = typeof document.createElementNS === 'function' ? document.createElementNS(NS, tag) : document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  };

  let rootEl = null;  // the pane's content, built once and kept (a redraw never takes the prompt box's focus)
  const parts = {};
  let draft = null;  // the sliders while being dragged: {efficiency, performance}
  let linked = true;
  try { linked = root.localStorage.getItem('cr-pane-linked') !== 'false'; } catch { /* (a private window: linked) */ }
  let result = null;  // the latest route for the prompt box
  let rating = null;  // {text, settings, promise} while Gemini rates
  let recent = null;  // the event log's newest, or {error}
  let recentAsked = 0;
  let previewTimer = 0;
  let unwatch = null;
  let pinned = '';  // the model pinned here with no session open (the new sessions' default)

  const shown = () => !!(rootEl && rootEl.isConnected);
  const nameOf = (id) => {
    const v = view();
    const lib = v && v.lib();
    const m = lib && Array.isArray(lib.MODELS) ? lib.MODELS.find((x) => x.id === id) : null;
    if (m && m.name) return m.name;
    const entry = v ? v.allModels().find((x) => x.model === id) : null;
    return (entry && entry.label) || id;
  };
  const settingsNow = () => {
    const v = view();
    const s = v ? v.settings() : { efficiency: 50, performance: 50, classifier: 'always', subscriptionClaude: true };
    return draft ? { ...s, ...draft } : s;
  };
  const levelsNow = () => { const v = view(); let meta = null; try { meta = v && v.meta(); } catch { meta = null; } return levelsOf(meta); };

  function section(title, ...kids) {
    const s = el('section', 'crp-section');
    s.append(el('p', 'jc-label crp-label', title), ...kids);
    return s;
  }
  function switchButton(label, onToggle) {
    const sw = el('button', 'jcs-switch crp-switch');
    sw.type = 'button';
    sw.setAttribute('role', 'switch');
    sw.setAttribute('aria-label', F.t(label));
    sw.addEventListener('click', () => { if (!sw.disabled) onToggle(sw.getAttribute('aria-checked') !== 'true'); });
    return sw;
  }
  const setSwitch = (sw, on, disabled = false) => { sw.setAttribute('aria-checked', String(!!on)); sw.disabled = !!disabled; sw.setAttribute('aria-disabled', String(!!disabled)); };

  function build() {
    rootEl = el('div', 'crp');

    // Try a prompt
    const prompt = el('textarea', 'crp-prompt');
    prompt.rows = 3;
    prompt.placeholder = F.t('Type a message to see which model Model Router picks for it…');
    prompt.setAttribute('aria-label', F.t('A prompt to route'));
    prompt.addEventListener('input', () => { rating = null; schedule(); });
    parts.prompt = prompt;
    parts.pick = el('div', 'jc-card crp-pick');
    parts.pick.setAttribute('aria-live', 'polite');
    const rate = el('button', 'jc-btn small crp-rate', 'Rate with Gemini');
    rate.type = 'button';
    rate.title = F.t('The rating a message would get: one small Gemini call on your key');
    rate.addEventListener('click', rateNow);
    parts.rate = rate;
    const useDraft = el('button', 'jc-btn small crp-draft', 'Use the composer’s draft');
    useDraft.type = 'button';
    useDraft.addEventListener('click', () => { const d = F.$('deck-input'); prompt.value = d ? d.value : ''; rating = null; preview(); });
    const row = el('div', 'crp-actions');
    row.append(rate, useDraft);
    parts.status = el('p', 'jc-dim crp-status');

    // The candidates
    parts.scatter = el('div', 'jc-card crp-scatter');
    parts.legend = el('div', 'crp-legend');
    for (const p of PROVIDERS) {
      const item = el('span', 'crp-legend-item');
      const dot = el('span', `crp-dot ${p}`);
      dot.setAttribute('aria-hidden', 'true');
      item.append(dot, el('span', '', PROVIDER_NAMES[p]));
      parts.legend.append(item);
    }

    // Optimize for
    const seg = el('div', 'crp-seg');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', F.t('Optimization level'));
    parts.levelButtons = [1, 2, 3, 4, 5].map((n) => {
      const b = el('button', 'crp-seg-btn', String(n));
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.dataset.level = String(n);
      b.addEventListener('click', () => setLevel(n));
      b.addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        const now = levelAt(levelsNow(), settingsNow().efficiency, settingsNow().performance).level;
        const next = Math.max(1, Math.min(5, now + (e.key === 'ArrowRight' ? 1 : -1)));
        setLevel(next);
        parts.levelButtons[next - 1].focus();
      });
      seg.append(b);
      return b;
    });
    const caps = el('div', 'crp-caps');
    caps.append(el('span', '', '1 · Max efficiency'), el('span', '', '5 · Max performance'));
    parts.levelName = el('p', 'crp-level-name');
    parts.levelDesc = el('p', 'jc-dim crp-level-desc');
    const slider = (key, label, note) => {
      const wrap = el('div', 'crp-slider');
      const head = el('label', 'crp-slider-head');
      const value = el('b', 'crp-slider-val');
      head.append(el('span', '', label), value);
      const input = el('input', 'crp-range');
      input.type = 'range';
      input.min = '0';
      input.max = '100';
      input.step = '1';
      input.id = `crp-${key}`;
      head.htmlFor = input.id;
      input.addEventListener('input', () => slide(key, Number(input.value)));
      input.addEventListener('change', commit);
      wrap.append(head, input, el('p', 'jc-dim crp-slider-note', note));
      parts[key] = { input, value };
      return wrap;
    };
    const effSlider = slider('efficiency', 'Token efficiency', 'How much cost counts. Higher picks cheaper models and lower efforts whenever they’re good enough for the task.');
    const perfSlider = slider('performance', 'Performance', 'How much quality counts. Higher raises the quality floor, so it pays for stronger models when the task needs them.');
    const linkRow = el('div', 'crp-row');
    const linkText = el('span', 'crp-text');
    linkText.append(document.createTextNode(F.t('Link the sliders')), el('small', '', 'Moving one moves the other along the five levels.'));
    parts.link = switchButton('Link the sliders', (on) => {
      linked = on;
      try { root.localStorage.setItem('cr-pane-linked', String(on)); } catch { /* (kept for this pane only) */ }
      draw();
    });
    linkRow.append(linkText, parts.link);
    const projRow = el('div', 'crp-row');
    const projText = el('span', 'crp-text');
    parts.projectNote = el('small', '', '');
    projText.append(document.createTextNode(F.t('Just this project')), parts.projectNote);
    parts.project = switchButton('Just this project', (on) => {
      const v = view();
      if (!v) return;
      const s = settingsNow();
      v.setProjectDefaults(on ? { efficiency: s.efficiency, performance: s.performance } : null);
      draw();
      preview();
    });
    projRow.append(projText, parts.project);
    parts.projectRow = projRow;
    const levelCard = el('div', 'jc-card crp-card');
    levelCard.append(seg, caps, parts.levelName, parts.levelDesc, effSlider, perfSlider, linkRow, projRow);

    // Providers
    parts.providers = el('div', 'jc-card crp-card crp-providers');

    // Model
    const pin = el('select', 'jcs-select crp-select');
    pin.setAttribute('aria-label', F.t('Model'));
    pin.addEventListener('change', () => {
      const v = view();
      if (!v) return;
      if (pin.value === '') v.setOn(true);
      else if (!pin.value.startsWith('__')) { pinned = pin.value; v.pin(pin.value); }
      setTimeout(draw);
    });
    parts.pin = pin;
    parts.pinNote = el('p', 'jc-dim crp-note');
    const modelCard = el('div', 'jc-card crp-card');
    modelCard.append(pin, parts.pinNote);

    // Pricing
    const subRow = el('div', 'crp-row');
    const subText = el('span', 'crp-text');
    subText.append(document.createTextNode(F.t('Claude on your plan')), el('small', '', 'Claude through your Claude sign-in is weighed as plan quota, not API dollars, and as your plan’s limits fill up it counts for more.'));
    parts.sub = switchButton('Claude on your plan', (on) => { const v = view(); if (v) v.save({ subscriptionClaude: on }); setTimeout(() => { draw(); preview(); }); });
    subRow.append(subText, parts.sub);
    parts.budget = el('p', 'jc-dim crp-note');
    const priceCard = el('div', 'jc-card crp-card');
    priceCard.append(subRow, parts.budget);

    // Rating
    const cls = el('select', 'jcs-select crp-select');
    cls.setAttribute('aria-label', F.t('Rating'));
    for (const [value, label] of CLASSIFIERS) { const o = el('option', '', label); o.value = value; cls.append(o); }
    cls.addEventListener('change', () => { const v = view(); if (v) v.save({ classifier: cls.value }); rating = null; setTimeout(() => { draw(); preview(); }); });
    parts.classifier = cls;
    parts.classifierNote = el('p', 'jc-dim crp-note');
    const rateCard = el('div', 'jc-card crp-card');
    rateCard.append(cls, parts.classifierNote);

    // Recent
    parts.recent = el('ul', 'jc-list crp-recent');
    const refresh = el('button', 'jc-btn small crp-refresh', 'Refresh');
    refresh.type = 'button';
    refresh.addEventListener('click', () => askRecent(true));
    const recentHead = el('div', 'crp-recent-head');
    recentHead.append(el('p', 'jc-label crp-label', 'Recent routed messages'), refresh);
    const recentSection = el('section', 'crp-section');
    recentSection.append(recentHead, parts.recent);

    // The foot: the Model Router repo's own page, for working on the router.
    const foot = el('p', 'jc-dim crp-foot');
    const dev = el('button', 'crp-link', 'Open the developer page in the browser');
    dev.type = 'button';
    dev.addEventListener('click', () => { const v = view(); if (v) v.openDeveloperPage(); });
    foot.append(dev);

    parts.problem = el('p', 'crp-problem');
    parts.problem.hidden = true;
    rootEl.append(
      parts.problem,
      section('Try a prompt', prompt, parts.pick, row, parts.status),
      section('Candidates · quality vs cost', parts.scatter, parts.legend),
      section('Optimize for', levelCard),
      section('Providers', parts.providers),
      section('Model', modelCard),
      section('Pricing', priceCard),
      section('Rating', rateCard),
      recentSection,
      foot,
    );
  }

  // ── the settings ──

  function setLevel(n) {
    const L = levelsNow().find((x) => x.level === n);
    if (!L) return;
    draft = { efficiency: L.efficiency, performance: L.performance };
    commit();
  }
  function slide(key, value) {
    const s = settingsNow();
    const levels = levelsNow();
    const next = { efficiency: s.efficiency, performance: s.performance, [key]: value };
    if (linked) {
      if (key === 'efficiency') next.performance = interpPerf(levels, value);
      else next.efficiency = interpEff(levels, value);
    }
    draft = next;
    drawLevels();
    schedule();
  }
  function commit() {
    const v = view();
    if (v && draft) v.save({ ...v.settings(), ...draft });
    draft = null;
    rating = null;
    draw();
    preview();
  }

  // ── the preview ──

  function schedule() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(preview, PREVIEW_MS);
  }
  function preview() {
    clearTimeout(previewTimer);
    const v = view();
    if (!v || !shown()) return;
    const text = parts.prompt.value;
    if (!v.lib()) { v.ready().then(() => { draw(); preview(); }, () => draw()); return; }
    try {
      result = String(text || '').trim() ? v.preview(text, settingsNow()) : null;
    } catch (err) {
      result = { error: (err && err.message) || 'The router couldn’t route this.' };
    }
    drawPick();
  }
  function rateNow() {
    const v = view();
    const text = parts.prompt.value;
    if (!v || !String(text || '').trim()) return;
    const s = settingsNow();
    const mine = { text, promise: v.rated(text, s) };
    rating = mine;
    drawPick();
    mine.promise.then((r) => { if (rating === mine) { rating = null; result = r; drawPick(); } },
      (err) => { if (rating === mine) { rating = null; parts.status.textContent = F.t((err && err.message) || 'Gemini didn’t answer.'); drawPick(); } });
  }

  // ── drawing ──

  // The pane head's pill: whether messages are routed now.
  function drawState(v) {
    const extra = F.$('jc-pane-extra');
    if (!extra || !v) return;
    const on = v.isOn();
    if (!parts.state || !extra.contains(parts.state)) { parts.state = el('span', 'crp-state'); extra.replaceChildren(parts.state); }
    parts.state.className = `crp-state${on ? ' live' : ''}`;
    parts.state.textContent = F.t(on ? 'Routing live' : v.shadowOn() ? 'Shadow mode' : 'Off');
  }

  function draw() {
    if (!shown()) return;
    const v = view();
    drawState(v);
    const problem = v ? v.problem() : 'Model Router isn’t loaded in this window';
    parts.problem.hidden = !problem;
    parts.problem.textContent = problem ? F.t(`Model Router can’t route right now: ${problem}.`) : '';
    drawLevels();
    drawProviders();
    drawModel();
    drawPricing();
    drawRating();
    drawRecent();
    drawPick();
  }

  function drawLevels() {
    const s = settingsNow();
    const levels = levelsNow();
    const at = levelAt(levels, s.efficiency, s.performance);
    parts.levelButtons.forEach((b, i) => {
      const on = i + 1 === at.level;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('on', on);
      b.classList.toggle('near', on && !at.exact);
      b.tabIndex = on ? 0 : -1;
    });
    parts.levelName.textContent = levelName(at);
    parts.levelDesc.textContent = at.entry.description || '';
    for (const key of ['efficiency', 'performance']) {
      const { input, value } = parts[key];
      if (document.activeElement !== input || !draft) input.value = String(s[key]);
      if (typeof input.style.setProperty === 'function') input.style.setProperty('--v', `${s[key]}%`);  // (the track's fill)
      value.textContent = String(s[key]);
    }
    setSwitch(parts.link, linked);
    const v = view();
    const project = v ? v.projectDefaults() : null;
    parts.projectRow.hidden = !project;
    if (project) {
      const own = Number.isFinite(project.efficiency);
      setSwitch(parts.project, own);
      parts.projectNote.textContent = F.t(own
        ? 'This project keeps its own levels; other projects use the levels for everyone.'
        : 'Off: this project uses the levels for everyone. On: it keeps the levels set here.');
    }
  }

  function drawProviders() {
    const v = view();
    const box = parts.providers;
    if (!v || !v.lib()) { box.replaceChildren(el('p', 'jc-dim', 'Loading the router…')); return; }
    const rows = providerRows(v.allModels(), v.providerOf, v.providersOff());
    box.replaceChildren(...rows.map((r) => {
      const row = el('div', `crp-row crp-provider${r.on ? '' : ' off'}${r.available ? '' : ' na'}`);
      const dot = el('span', `crp-dot ${r.id}`);
      dot.setAttribute('aria-hidden', 'true');
      const text = el('span', 'crp-text');
      text.append(document.createTextNode(F.t(r.name)), el('small', '', r.available
        ? `${r.models.length} model${r.models.length === 1 ? '' : 's'}: ${r.models.join(', ')}`
        : F.t('No models from it in Settings › Models yet')));
      const sw = switchButton(`Route to ${r.name}`, (on) => {
        const off = toggledOff(providerRows(v.allModels(), v.providerOf, v.providersOff()), r.id, on);
        if (!off) { parts.status.textContent = F.t('Keep at least one provider on.'); return; }
        v.setProvidersOff(off);
        setTimeout(() => { draw(); preview(); });
      });
      setSwitch(sw, r.on, !r.available || r.last);
      if (r.last) sw.title = F.t('The last provider on: routing needs at least one.');
      row.append(dot, text, sw);
      return row;
    }));
  }

  function drawModel() {
    const v = view();
    if (!v) return;
    const on = v.isOn();
    const t = v.task();
    const list = v.allModels();  // (any of them can be pinned, a provider left out of routing too)
    const pin = parts.pin;
    const auto = el('option', '', 'Model Router picks (routing live)');
    auto.value = '';
    const opts = [auto];
    let current = '';
    if (!on && t) {
      const entry = v.allModels().find((m) => m.ref === t.model_ref || m.model === t.model);
      current = entry ? entry.ref : '';
      if (!entry && t.model) { const o = el('option', '', `${nameOf(t.model)} (this session)`); o.value = '__session'; opts.push(o); current = '__session'; }
    }
    if (!on && !t && pinned && v.allModels().some((m) => m.ref === pinned)) current = pinned;
    if (!on && !current) { const o = el('option', '', 'Your own pick (Model Router is off)'); o.value = '__own'; opts.push(o); current = '__own'; }
    for (const m of list) { const o = el('option', '', `Pin ${m.label || nameOf(m.model)}`); o.value = m.ref; opts.push(o); }
    if (document.activeElement !== pin) { pin.replaceChildren(...opts); pin.value = on ? '' : current; }
    parts.pinNote.textContent = F.t(on
      ? 'Each message goes to the model and effort Model Router picks for it, among the models in Settings › Models.'
      : v.shadowOn()
        ? 'You pick the model. Shadow mode notes what Model Router would have picked for each message and what it would have saved; nothing switches.'
        : 'You pick the model; Model Router is off.');
  }

  function drawPricing() {
    const v = view();
    if (!v) return;
    setSwitch(parts.sub, settingsNow().subscriptionClaude !== false);
    const note = v.budgetNote();
    parts.budget.hidden = !note;
    parts.budget.textContent = note;
  }

  function drawRating() {
    const v = view();
    if (!v) return;
    const s = settingsNow();
    if (document.activeElement !== parts.classifier) parts.classifier.value = s.classifier;
    parts.classifierNote.textContent = F.t(s.classifier === 'off'
      ? 'The router’s rules rate each prompt: instant and free.'
      : v.geminiPaused()
        ? 'Gemini isn’t answering for now (no key, today’s cap, or Google unreachable), so the rules rate meanwhile.'
        : 'The rules give the instant pick while you type; Gemini’s rating decides where a message goes. Its key is the Gemini one in Settings › Models.');
    parts.rate.hidden = s.classifier === 'off';
  }

  function drawPick() {
    if (!shown()) return;
    const box = parts.pick;
    const text = parts.prompt.value;
    parts.rate.disabled = !!rating || !String(text || '').trim();
    parts.rate.textContent = F.t(rating ? 'Gemini is rating…' : 'Rate with Gemini');
    if (result && result.error) {
      box.replaceChildren(el('p', 'crp-problem', F.t(`Preview unavailable: ${result.error}`)));
      drawScatter(null);
      return;
    }
    const r = readout(result, nameOf);
    if (!r) {
      box.replaceChildren(el('p', 'jc-dim', String(text || '').trim() ? 'Routing…' : 'Type a message above to preview the pick.'));
      drawScatter(null);
      return;
    }
    const head = el('div', 'crp-pick-head');
    const dot = el('span', `crp-dot ${r.provider}`);
    dot.setAttribute('aria-hidden', 'true');
    const name = el('strong', '', r.name);
    name.setAttribute('data-no-i18n', '');
    const badge = el('span', `crp-badge${r.rated ? ' rated' : ''}`, r.rated ? `rated by ${r.ratedBy}` : 'rules');
    head.append(dot, name, el('span', 'jc-dim', effortWords(r.effort)), badge);
    const nums = el('div', 'crp-nums');
    const num = (label, value) => { const n = el('div', 'crp-num'); n.append(el('small', '', label), el('b', '', value)); return n; };
    nums.append(num('Est. cost a turn', fmtCost(r.costUSD)), num('Expected quality', r.quality === null ? '—' : String(r.quality)), num('Task', r.complexity || '—'));
    const kids = [head, nums];
    if (r.why) kids.push(el('p', 'crp-why', r.why));
    if (r.notes.length) { const ul = el('ul', 'crp-notes'); ul.append(...r.notes.slice(0, 4).map((n) => el('li', '', n))); kids.push(ul); }
    box.replaceChildren(...kids);
    parts.status.textContent = '';
    drawScatter(result);
  }

  function shape(kind, cx, cy, r, attrs) {
    if (kind === 'square') return svg('rect', { x: cx - r * 0.88, y: cy - r * 0.88, width: r * 1.76, height: r * 1.76, rx: 1.5, ...attrs });
    if (kind === 'diamond') return svg('path', { d: `M${cx} ${cy - r * 1.2}L${cx + r * 1.2} ${cy}L${cx} ${cy + r * 1.2}L${cx - r * 1.2} ${cy}Z`, ...attrs });
    if (kind === 'triangle') return svg('path', { d: `M${cx} ${cy - r * 1.15}L${cx + r * 1.1} ${cy + r * 0.85}L${cx - r * 1.1} ${cy + r * 0.85}Z`, ...attrs });
    return svg('circle', { cx, cy, r, ...attrs });
  }
  function drawScatter(res) {
    const box = parts.scatter;
    const pts = res && res.pick ? candidates(res.rows, res.pick) : [];
    const lay = scatterLayout(pts);
    if (!lay) { box.replaceChildren(el('p', 'jc-dim crp-empty', 'The models Model Router weighs for the prompt show here: quality against cost.')); return; }
    const W = lay.width, H = lay.height;
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'crp-plot', role: 'img', 'aria-label': `${F.t('Quality versus cost')}: ${lay.dots.length} ${F.t('models')}` });
    const line = (x1, y1, x2, y2, cls) => svg('line', { x1, y1, x2, y2, class: cls });
    s.append(line(lay.left, lay.top - 6, lay.left, H - lay.bottom, 'crp-axis'), line(lay.left, H - lay.bottom, W - lay.right + 4, H - lay.bottom, 'crp-axis'));
    const txt = (x, y, words, cls, anchor = 'start') => { const n = svg('text', { x, y, class: cls, 'text-anchor': anchor }); n.textContent = words; return n; };
    s.append(txt(W - lay.right + 4, H - 5, F.t('cost (log) →'), 'crp-tick', 'end'), txt(2, 10, F.t('quality ↑'), 'crp-tick'));
    s.append(txt(lay.left, H - lay.bottom + 11, fmtCost(lay.costLo), 'crp-tick faint'), txt(W - lay.right, H - lay.bottom + 11, fmtCost(lay.costHi), 'crp-tick faint', 'end'));
    s.append(txt(lay.left - 4, lay.yHi + 3, String(lay.qualityHi), 'crp-tick faint', 'end'), txt(lay.left - 4, lay.yLo + 3, String(lay.qualityLo), 'crp-tick faint', 'end'));
    if (lay.frontier) s.append(svg('path', { d: lay.frontier, class: 'crp-frontier' }));
    for (const p of lay.dots) {
      const g = svg('g', { class: `crp-pt${p.chosen ? ' chosen' : ''}` });
      const title = svg('title');
      title.textContent = `${p.name || nameOf(p.model)}${p.effort ? ` · ${effortWords(p.effort)}` : ''}: quality ${Math.round(p.quality)}, ${fmtCost(p.costUSD)}${p.chosen ? ' (the pick)' : ''}`;
      g.append(title);
      if (p.chosen) g.append(svg('circle', { cx: p.cx, cy: p.cy, r: 9, class: 'crp-ring' }));
      g.append(shape(PROVIDER_SHAPES[p.provider] || 'circle', p.cx, p.cy, p.chosen ? 5 : 4.6, { fill: PROVIDER_COLORS[p.provider] || '#8e8e93', class: 'crp-mark' }));
      const label = svg('text', { x: p.cx, y: p.ly, 'text-anchor': p.anchor, class: `crp-pt-label${p.chosen ? ' chosen' : ''}` });
      label.textContent = `${shortName(p.name || nameOf(p.model))}${p.chosen ? ' ✓' : ''}`;
      g.append(label);
      s.append(g);
    }
    box.replaceChildren(s);
  }

  // ── the event log's newest ──

  function askRecent(force = false) {
    const v = view();
    if (!v || (!force && Date.now() - recentAsked < 5000)) return;
    recentAsked = Date.now();
    v.call('recent', { limit: 20 }).then((rows) => { recent = Array.isArray(rows) ? rows : []; drawRecent(); },
      (err) => { recent = { error: (err && err.message) || 'The router’s log couldn’t be read.' }; drawRecent(); });
  }
  function drawRecent() {
    if (!shown()) return;
    const list = parts.recent;
    if (!recent) { list.replaceChildren(el('li', 'crp-empty-row', 'Reading the router’s log…')); return; }
    if (recent.error) { list.replaceChildren(el('li', 'crp-empty-row', F.t(recent.error))); return; }
    if (!recent.length) { list.replaceChildren(el('li', 'crp-empty-row', 'No routed messages yet. With Model Router chosen (or Shadow mode on), each message’s pick shows here.')); return; }
    const now = Date.now();
    list.replaceChildren(...recent.map((row) => {
      const line = recentLine(row, nameOf, now);
      const li = el('li', `crp-recent-row${row.shadow ? ' shadow' : ''}`);
      const top = el('div', 'crp-recent-top');
      const head = el('strong', '', line.head);
      head.setAttribute('data-no-i18n', '');
      top.append(el('span', `crp-kind${row.shadow ? ' shadow' : ''}`, line.kind), head, el('small', 'crp-when', line.when));
      const foot = el('div', 'crp-recent-foot');
      foot.append(el('span', `crp-badge${row.rated ? ' rated' : ''}`, line.rated));
      if (line.detail) foot.append(el('small', '', line.detail));
      for (const sig of line.signals) foot.append(el('small', 'crp-signal', sig));
      li.append(top, foot);
      return li;
    }));
  }

  // ── the pane ──

  function render(body) {
    if (!rootEl) build();
    if (!(body.childNodes.length === 1 && body.firstChild === rootEl)) body.replaceChildren(rootEl);
    const v = view();
    const handed = F.codeRouter && typeof F.codeRouter.draft === 'string' ? F.codeRouter.draft : null;
    if (handed !== null) {
      F.codeRouter.draft = null;
      if (handed.trim() && handed !== parts.prompt.value) { parts.prompt.value = handed; rating = null; }
    }
    if (!unwatch && v) unwatch = v.watch((why) => { if (!shown()) return; draw(); if (why !== 'state') preview(); else askRecent(); });
    draw();
    preview();
    askRecent();
  }

  F.registerPane(PANE, { title: 'Model Router', render });
  const open = () => (F.codeRouter && F.codeRouter.open ? F.codeRouter.open() : F.openPane(PANE));
  F.registerMoreItem({ label: 'Model Router', note: 'Which model each message goes to, and why', run: open });
  F.registerSlash({ name: 'router', help: 'Model Router: levels, providers, and why it picks each model', withoutSession: true, run() { open(); return true; } });
})(typeof window !== 'undefined' ? window : globalThis);
