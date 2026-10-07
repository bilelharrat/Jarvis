// Model Router in Jarvis Code's composer (features/code_router.py, code_router_events.py).
// The router and its popover come from the Model Router repo, built into
// features/vendor/model-router.js (`npm run jarvis` there).
// - The model menu gets "Model Router": each message then goes to the model the router
//   picks for it, among the models in Settings › Models it knows, at the effort it picks
//   where the model's way of running takes one: Claude (and an Anthropic key) at any of
//   Claude's efforts; OpenAI-compatible models (openai_relay: reasoning effort) and Gemini
//   Flash (gemini_proxy: thinking level) at low, medium or high; the rest at their default.
// - The composer shows a ✦ chip with the pick for what's typed; it opens the Route popover
//   (five levels, the Token Efficiency and Performance sliders, Ask Gemini, and what the
//   adapter below offers: feedback, what the router learned, spend, per-project defaults).
// - Ask Gemini rates the prompt with the Gemini key in Settings › Models, through the
//   backend (the key never comes to the window). It's the standard ("always"): the rules'
//   pick is the instant preview while typing and the fallback when Gemini can't answer.
//   A trivial message (under 4 words, "yes", "go ahead", "继续") is never rated.
// - A message goes with the best pick there is for its text now (route): Gemini's when the
//   chip's last pick was rated for this very text, else the rules'. Then, while Gemini is on
//   and that pick isn't rated, it also carries route_wait (a token): the backend holds it (in
//   order, at most ROUTE_WAIT_SECONDS) for {type: 'model_router_route', token, route?}, sent
//   here once this text's rating is in (no route: keep the message's own). No key, today's
//   cap, Google unreachable: the rules alone for a while, and nothing waits.
// - Every route also says what Jarvis knows of the session (model_router_state from the
//   backend): its context size, agentic calls per message, its current model (stickiness),
//   Claude as plan quota and how much of the plan is used, interactive (voice) latency, the
//   learned overrides, and the month's budget (past 80% the router leans cheaper). A route
//   carries the router's numbers for the event log (info: never the prompt's words) and its
//   next picks (fallbacks: where the session goes if the model fails).
// - Shadow mode (settings.shadow): every message's pick is logged, nothing is moved, and
//   nothing waits, whether or not Model Router is the session's model.
// - On for every session until a model is picked from the menu. Kept in prefs.features.
// Pure helpers are exported for node --test (tests/web/code-router.test.mjs).
(function (root) {
  'use strict';

  const ON = 'code_router_on';
  const SETTINGS = 'code_router_settings';
  const PROJECTS = 'code_router_projects';
  const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];  // what a session takes (tasks.EFFORTS)
  // The efforts the relays pass on (openai_relay: reasoning effort; gemini_proxy: Flash's thinking level).
  const RELAY_EFFORTS = ['low', 'medium', 'high'];
  const BUNDLE = '/static/features/vendor/model-router.js';
  const DEFAULT_SETTINGS = {
    efficiency: 50, performance: 50, classifier: 'always',
    subscriptionClaude: true, shadow: false, learn: true, learnFromPrompts: false,
  };
  const SWITCHES = ['subscriptionClaude', 'shadow', 'learn', 'learnFromPrompts'];
  const AGENTIC_DEFAULT = 8;  // = code_router_events.AGENTIC_DEFAULT
  const SUBSCRIPTION = ['anthropic'];  // Claude on the owner's sign-in: plan quota, not API dollars

  // ── pure helpers ──

  // The router's model ids for the picker's models (builtin: Claude's, with the efforts a
  // session takes; the rest at the efforts their way of running passes on).
  function routable(models) {
    const out = [];
    for (const m of models || []) if (m && m.model && m.ref && !out.some((x) => x.model === m.model)) out.push(m);
    return out;
  }
  // Gemini 3 and later Flash models: gemini_proxy gives them the session's effort as a thinking level.
  const geminiFlash = (model) => /^gemini-(?![12](?:[.-]|$))[a-z0-9.-]*flash/i.test(String(model || ''));
  // Whether a session on this model runs at the effort it's given (the picker's kind).
  function takesEffort(entry) {
    if (!entry) return false;
    if (entry.builtin || entry.kind === 'anthropic') return true;
    return entry.kind === 'openai' || (entry.kind === 'gemini' && geminiFlash(entry.model));
  }
  function effortsFor(models) {
    const byModel = new Map(routable(models).map((m) => [m.model, m]));
    return (profile) => {
      const entry = byModel.get(profile.id);
      if (entry && (entry.builtin || entry.kind === 'anthropic')) return CLAUDE_EFFORTS;
      if (takesEffort(entry)) {
        const own = (profile.efforts || []).map((e) => e && e.level).filter((l) => RELAY_EFFORTS.includes(l));
        if (own.length) return own;
      }
      return [profile.defaultEffort];
    };
  }
  // A pick as a session takes it: the picker's ref, and the effort when its model takes one.
  function routeFor(models, pick) {
    if (!pick) return null;
    const entry = routable(models).find((m) => m.model === pick.model);
    if (!entry) return null;
    const route = { ref: entry.ref, model: pick.model };
    if (takesEffort(entry) && CLAUDE_EFFORTS.includes(pick.effort)) route.effort = pick.effort;
    return route;
  }
  // The route's next picks, as sessions take them (the automatic fallback): at most 3, not
  // the route itself.
  function fallbacksFor(models, result, route) {
    const out = [];
    for (const row of (result && result.fallbacks) || []) {
      const r = routeFor(models, row);
      if (r && (!route || r.ref !== route.ref) && !out.some((x) => x.ref === r.ref)) out.push(r);
      if (out.length >= 3) break;
    }
    return out;
  }
  function cleanSettings(s) {
    const out = { ...DEFAULT_SETTINGS };
    if (s && typeof s === 'object') {
      for (const k of ['efficiency', 'performance']) if (Number.isFinite(s[k])) out[k] = Math.max(0, Math.min(100, Math.round(s[k])));
      if (['off', 'auto', 'always'].includes(s.classifier)) out.classifier = s.classifier;
      for (const k of SWITCHES) if (typeof s[k] === 'boolean') out[k] = s[k];
    }
    return out;
  }
  // The same routing (what a pick depends on), and the same settings in every field.
  const sameSettings = (a, b) => a.efficiency === b.efficiency && a.performance === b.performance && a.classifier === b.classifier;
  const sameAll = (a, b) => sameSettings(a, b) && SWITCHES.every((k) => a[k] === b[k]);
  // The composer's text and what goes (trimmed, as app.js sends it) are the same prompt.
  const sameText = (a, b) => String(a || '').trim() === String(b || '').trim();

  // A message the rules decide alone, never rated (D6): under 4 words, or a confirmation or
  // continuation ("yes", "ok", "go ahead", "run it", "thanks", "继续", "好的").
  const CONFIRM = /^(?:y(?:es|ep|eah|up)?|ok(?:ay)?|k|sure|fine|right|correct|continue|carry on|keep going|go(?: on| ahead)?|proceed|next|run it|do it|ship it|lgtm|sounds good|looks good|perfect|great|thanks?|thank you|thx|yes,? (?:please|go ahead|do it|continue)|please (?:continue|proceed|go ahead)|go for it|好的?|好啊|可以|行|对|是的?|继续|开始吧?|执行吧?|运行吧?|谢谢|没问题)[\s.!?。！？,，~]*$/i;
  const HAN = /[㐀-鿿]/;
  function isTrivial(text) {
    const t = String(text || '').trim();
    if (!t) return true;
    if (CONFIRM.test(t)) return true;
    if (HAN.test(t)) return t.length < 6;  // (no spaces between words: a few characters)
    return t.length <= 60 && t.split(/\s+/).length < 4;
  }

  // A result the chip announced ({ result, rated }), for the classifier mode now: true when
  // no rating is still to come for it: Gemini's is in it, or wasn't needed (When Unsure, a
  // trivial message), or failed (the rules stand), or Gemini is off.
  function isRated(entry, mode) {
    if (mode === 'off') return true;
    if (!entry) return false;
    if (entry.rated === true) return true;
    const c = entry.result && entry.result.classification;
    if (!c) return false;
    if (c.skipped === 'trivial') return true;
    return c.used === true || (c.mode === mode && Boolean(c.skipped || c.error));
  }
  // Whether a message going on this pick should wait for Gemini's rating (route_wait).
  function needsRating(mode, entry, geminiPaused, text) {
    if (text !== undefined && isTrivial(text)) return false;
    return mode !== 'off' && !geminiPaused && !isRated(entry, mode);
  }
  // The route a rating gives a waiting message, or null: the message's own route stands (the
  // rating failed or wasn't used, or it picks the same).
  function ratedRoute(models, sent, result) {
    const c = result && result.classification;
    if (!c || c.used !== true) return null;
    const route = routeFor(models, result.pick);
    if (!route) return null;
    if (sent && route.ref === sent.ref && (route.effort || '') === (sent.effort || '')) return null;
    return route;
  }
  // How long to stop asking Gemini after this answer from the backend (ms; Infinity: until
  // the keys change; 0: keep asking). 401: no key; 403, or a 400 about the key: a key Google
  // won't take; 429: today's cap (or Google's limit); another 400: that one request; else
  // Google or the connection is down for now.
  function pauseAfter(status, message = '') {
    if (status >= 200 && status < 300) return 0;
    if (status === 401 || status === 403 || (status === 400 && /api[ _]?key/i.test(String(message || '')))) return Infinity;
    if (status === 400) return 0;
    if (status === 429) return 15 * 60_000;
    return 30_000;
  }
  // The longest a message waits for its rating in the backend (code_router.ROUTE_WAIT_SECONDS):
  // a rating the chip is still on after that is no use to it.
  const ROUTE_WAIT_MS = 4000;
  // The promise's value, or `fallback` if it hasn't settled within ms (or failed).
  function within(promise, ms, fallback = null) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(fallback), ms);
      Promise.resolve(promise).then(
        (v) => { clearTimeout(timer); resolve(v); },
        () => { clearTimeout(timer); resolve(fallback); },
      );
    });
  }
  // A route_wait token: what code_router._TOKEN takes ([A-Za-z0-9_-]{8,64}).
  function newToken(random = root.crypto) {
    const bytes = new Uint8Array(12);
    if (random && typeof random.getRandomValues === 'function') random.getRandomValues(bytes);
    else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return 'rw' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // The message in a backend error body ({error: {message}}), or ''.
  function errorText(body) {
    try { const m = JSON.parse(String(body || '')).error.message; return typeof m === 'string' ? m : ''; } catch { return ''; }
  }

  // What Jarvis knows of the session, as the router takes it (CONTRACT §1 RouteExtras): its
  // context so far (D3), model calls per message (D4), its current model (D5 stickiness),
  // Claude as plan quota (D8) and the plan's use (D9), interactive and voice latency (D20).
  // state: the backend's model_router_state; task: the session (null: a new one). sticky
  // false: the session's model is the owner's choice, not the router's (Shadow mode with the
  // router off), so no stickiness toward it.
  function extrasFor(task, s, state, { sticky = true } = {}) {
    const st = state || {};
    const session = task && st.sessions ? st.sessions[String(task.id)] : null;
    const out = { latency: { interactive: true } };
    if (session && session.voice) out.latency.voice = true;
    if (session && Number.isFinite(session.contextTokens) && session.contextTokens > 0) out.context = { sessionTokens: session.contextTokens };
    out.agenticCallsPerTurn = Number.isFinite(st.agenticCallsPerTurn) && st.agenticCallsPerTurn >= 1 ? st.agenticCallsPerTurn : AGENTIC_DEFAULT;
    if (sticky && task && task.model) out.sticky = { current: task.effort ? { model: task.model, effort: task.effort } : { model: task.model } };
    if (s && s.subscriptionClaude !== false) {
      out.pricing = { subscription: { providers: SUBSCRIPTION } };
      const used = st.quota && st.quota.used;
      if (Number.isFinite(used)) out.quota = { used: Math.max(0, Math.min(1, used)) };
    }
    return out;
  }
  // Efficiency points the month's budget adds (the backend's boost: 0 below 80% spent).
  function budgetBoost(state) {
    const b = state && state.budget;
    return b && Number.isFinite(b.boost) ? Math.max(0, Math.min(100, b.boost)) : 0;
  }
  // What the popover says while the budget leans the router cheaper.
  function budgetNote(state) {
    const b = state && state.budget;
    if (!b || !(b.boost > 0) || !(b.usd > 0)) return '';
    return `This month’s budget is ${Math.round((b.fraction || 0) * 100)}% spent ($${Number(b.spentUSD || 0).toFixed(2)} of $${Number(b.usd).toFixed(2)}): leaning cheaper.`;
  }
  // The learned overrides to route with (none with learning off), and a stamp for them.
  function learnedOverrides(state) {
    const l = state && state.learned;
    if (!l || l.on === false || !l.overrides || typeof l.overrides !== 'object') return null;
    return Object.keys(l.overrides).length ? l.overrides : null;
  }
  function learnedStamp(state) {
    const o = learnedOverrides(state);
    return o ? `${(state.learned && state.learned.updated) || ''}|${JSON.stringify(o).length}` : '';
  }
  // A session's project defaults ({efficiency, performance}) over the settings, if it has some.
  function effectiveSettings(s, levels) {
    if (!levels) return s;
    return { ...s, efficiency: levels.efficiency, performance: levels.performance, project: true };
  }
  // What the event log keeps of a route (code_router_events.clean_info keeps only these
  // numbers, ids and enums): never the prompt's words (the analyzer's signal labels and
  // Gemini's reasons stay out).
  function infoOf(result, s, extras, boost = 0) {
    if (!result) return undefined;
    const t = result.task || {}, c = result.classification || {};
    const row = (r) => (r && r.model ? { model: r.model, effort: r.effort, quality: r.quality, costUSD: r.costUSD } : undefined);
    let best = null;
    for (const r of Array.isArray(result.rows) ? result.rows : []) {
      if (r && r.eligible !== false && Number.isFinite(r.quality) && (!best || r.quality > best.quality)) best = r;
    }
    const e = extras || {};
    return {
      profile: { complexity: t.complexity, score: t.complexityScore, weights: t.weights, inputTokens: t.inputTokens, outputTokens: t.outputTokens },
      rating: { used: c.used === true, by: c.used === true ? c.model : undefined, mode: c.mode, complexity: c.finalComplexity, rulesComplexity: c.rulesComplexity, skipped: c.skipped, cached: c.cached === true },
      settings: { efficiency: s.efficiency, performance: s.performance, classifier: s.classifier, level: result.optimization && result.optimization.level, subscriptionClaude: s.subscriptionClaude !== false, project: s.project === true },
      pick: row(result.pick),
      best: row(best),
      alternatives: ((result.fallbacks || []).slice(0, 3)).map(row).filter(Boolean),
      extras: {
        sessionTokens: e.context && e.context.sessionTokens,
        agenticCallsPerTurn: e.agenticCallsPerTurn,
        sticky: Boolean(e.sticky),
        subscription: Boolean(e.pricing),
        quota: e.quota && e.quota.used,
        interactive: Boolean(e.latency && e.latency.interactive),
        voice: Boolean(e.latency && e.latency.voice),
        budgetBoost: boost || undefined,
      },
    };
  }
  // The prices of the models it routes among (USD per 1M tokens), for the backend to put a
  // price on other providers' turns (Claude Code can't).
  function pricesOf(lib, ids) {
    const out = {};
    const known = new Set(ids || []);
    for (const m of (lib && lib.MODELS) || []) {
      if (!known.has(m.id) || !m.pricing) continue;
      const p = m.pricing;
      if (Number.isFinite(p.inputPer1M) && Number.isFinite(p.outputPer1M)) out[m.id] = { in: p.inputPer1M, out: p.outputPer1M };
    }
    return out;
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      routable, effortsFor, routeFor, fallbacksFor, takesEffort, geminiFlash, cleanSettings, sameSettings, sameAll,
      sameText, isTrivial, isRated, needsRating, ratedRoute, pauseAfter, newToken, errorText, within, extrasFor,
      budgetBoost, budgetNote, learnedOverrides, learnedStamp, effectiveSettings, infoOf, pricesOf,
      CLAUDE_EFFORTS, RELAY_EFFORTS, DEFAULT_SETTINGS, ROUTE_WAIT_MS, AGENTIC_DEFAULT,
    };
    return;
  }

  // ── the window ──

  const F = root.jarvisFeatures;
  if (!F || !F.$('jc-model')) return;

  let features = (typeof prefs !== 'undefined' && prefs && prefs.features) || {};
  let lib = null;
  let loading = null;
  let libError = null;  // (not retried on every redraw; choosing Model Router again tries again)
  let router = null;
  let routerKey = '';
  let chip = null;
  let last = null;  // the chip's latest result: { prompt, settings, result, rated }
  let shownTask = null;
  let seq = 0;
  const classifying = new Map();  // rid -> resolve
  let geminiPause = 0;  // Date.now() until which Gemini isn't asked (Infinity: until the keys change)
  const noted = new Set();  // Gemini's problems already told this session (no key, today's cap)
  let state = null;  // the backend's model_router_state
  const calls = new Map();  // rid -> answer (model_router_call)
  let pricesSent = '';
  let stamp = '';  // learnedStamp(state), worked out as each state comes

  const isOn = () => features[ON] === true;
  const settings = () => cleanSettings(features[SETTINGS]);
  const shadowOn = () => settings().shadow === true;
  const models = () => (typeof modelList !== 'undefined' ? modelList : []);
  const task = () => { try { return F.currentTask ? F.currentTask() : null; } catch { return null; } };
  const projectOf = (t) => (t && state && state.sessions && state.sessions[String(t.id)] ? state.sessions[String(t.id)].project || null : null);
  function projectLevels(t) {
    const p = projectOf(t);
    const all = features[PROJECTS];
    return p && all && typeof all === 'object' && all[p] ? all[p] : null;
  }
  const routing = (t) => effectiveSettings(settings(), projectLevels(t));

  function savePrefs(changes) {
    features = { ...features, ...changes };
    F.send({ type: 'feature_prefs', changes });
  }

  function loadLib() {
    if (lib) return Promise.resolve(lib);
    if (libError) return Promise.reject(libError);
    if (!loading) {
      loading = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = BUNDLE;
        s.onload = () => (root.ModelRouterLib ? resolve(root.ModelRouterLib) : reject(new Error('Model Router didn’t load.')));
        s.onerror = () => reject(new Error('Model Router isn’t installed: run `npm run jarvis` in the Model Router folder.'));
        document.head.append(s);
      }).then((l) => (lib = l), (err) => { loading = null; libError = err; jcNote(err.message); throw err; });
    }
    return loading;
  }

  // Gemini's answer (through the backend): a problem stops the asking for a while (the rules
  // route meanwhile), and no key or today's cap is said once a session, not on every pause.
  function geminiAnswered(status, body) {
    const text = errorText(body);
    const ms = pauseAfter(status, text);
    if (ms) geminiPause = Math.max(geminiPause, Date.now() + ms);
    else if (status >= 200 && status < 300) geminiPause = 0;
    const kind = ms === Infinity ? 'key' : status === 429 ? 'cap' : '';
    if (kind && !noted.has(kind)) {
      noted.add(kind);
      if (text) jcNote(kind === 'key' && status !== 401 ? `Google didn’t take the Gemini key in Settings › Models: ${text}` : text);
    }
  }
  const geminiPaused = () => Date.now() < geminiPause;

  // Gemini's rating goes through the backend, which adds the key from the Keychain.
  function viaJarvis(url, init = {}) {
    return new Promise((resolve, reject) => {
      const m = /\/models\/([\w.-]+):generateContent$/.exec(String(url));
      if (!m) { reject(new Error('unexpected classifier address')); return; }
      const rid = `mr${++seq}`;
      const abort = () => {  // (the router's timeout: Google, or the backend, is slow to answer)
        if (classifying.delete(rid)) geminiAnswered(504, '');
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      };
      if (init.signal) {
        if (init.signal.aborted) { abort(); return; }
        init.signal.addEventListener('abort', abort, { once: true });
      }
      classifying.set(rid, (ev) => {
        geminiAnswered(ev.status || 502, ev.body);
        resolve(new Response(String(ev.body || ''), { status: ev.status || 502, headers: { 'content-type': 'application/json' } }));
      });
      let body;
      try { body = JSON.parse(init.body); } catch { body = null; }
      if (!F.send({ type: 'model_router_classify', rid, model: m[1], body })) { classifying.delete(rid); reject(new Error('Jarvis isn’t connected.')); }
    });
  }
  F.on('model_router_classified', (ev) => {
    const done = classifying.get(ev.rid);
    if (done) { classifying.delete(ev.rid); done(ev); }
  });

  function currentRouter() {
    const list = routable(models());
    const overrides = settings().learn === false ? null : learnedOverrides(state);
    const key = list.map((m) => `${m.ref}=${m.model}${m.builtin ? '*' : ''}${m.kind || ''}`).join(',') + '|' + (overrides ? stamp : '');
    if (!router || key !== routerKey) {
      const opts = { models: list.map((m) => m.model), efforts: effortsFor(list), fetch: viaJarvis, apiKey: 'jarvis', timeoutMs: 12000 };
      try {
        router = lib.createLocalRouter(overrides ? { ...opts, overrides } : opts);
      } catch (err) {
        if (!overrides) throw err;
        console.warn('model router: the learned overrides were left out', err);  // (a router that can't take them)
        router = lib.createLocalRouter(opts);
      }
      routerKey = key;
      const prices = pricesOf(lib, router.ids);
      const said = JSON.stringify(prices);
      if (said !== pricesSent && said !== '{}' && F.send({ type: 'model_router_prices', prices })) pricesSent = said;
    }
    return router;
  }

  // The route body for a prompt: the settings (the session's project defaults over them, and
  // the budget's lean) and what Jarvis knows of the session.
  function bodyFor(text, s, t, more = {}) {
    const boost = budgetBoost(state);
    const extras = extrasFor(t, s, state, { sticky: isOn() });
    return { body: { prompt: text, efficiency: Math.min(100, s.efficiency + boost), performance: s.performance, ...extras, ...more }, extras, boost };
  }

  // A route with Gemini's rating when the classifier mode asks for it, unless Gemini is
  // paused after a problem or the message is trivial (then the rules', at once).
  function rate(body) {
    const skip = body && body.classifier && body.classifier !== 'off' && (geminiPaused() || isTrivial(body.prompt));
    return currentRouter().route(skip ? { ...body, classifier: 'off' } : body);
  }

  // ── the backend's state and calls ──

  function onState(ev) {
    const before = stamp;
    const t = task();
    const levels = projectLevels(t);
    state = ev || null;
    stamp = learnedStamp(state);
    if (stamp !== before) { router = null; if (chip && !chip.hidden) chip.refresh(); }
    const now = projectLevels(t);
    if (chip && JSON.stringify(levels) !== JSON.stringify(now)) chip.applySettings(routing(t));
  }
  F.on('model_router_state', onState);
  F.on('model_router_reply', (ev) => {
    const done = calls.get(ev.rid);
    if (done) { calls.delete(ev.rid); done(ev); }
  });
  function call(op, args = {}, ms = 15000) {
    return new Promise((resolve, reject) => {
      const rid = `mc${++seq}`;
      const timer = setTimeout(() => { calls.delete(rid); reject(new Error('Jarvis didn’t answer.')); }, ms);
      calls.set(rid, (ev) => { clearTimeout(timer); if (ev.ok) resolve(ev.data); else reject(new Error(ev.error || 'That didn’t work.')); });
      if (!F.send({ type: 'model_router_call', rid, op, ...args })) { clearTimeout(timer); calls.delete(rid); reject(new Error('Jarvis isn’t connected.')); }
    });
  }

  const adapter = {
    meta: () => loadLib().then(() => currentRouter().meta(routing(task()).classifier)),
    route: (body) => loadLib().then(async () => {
      const t = task();
      const s = routing(t);
      const boost = budgetBoost(state);
      const efficiency = Number.isFinite(body && body.efficiency) ? body.efficiency : s.efficiency;
      const result = await rate({ ...body, ...extrasFor(t, s, state), efficiency: Math.min(100, efficiency + boost) });
      const note = budgetNote(state);
      if (note && result && typeof result === 'object') result.notes = [...(Array.isArray(result.notes) ? result.notes : []), note];
      return result;
    }),
    fullUrl: 'http://127.0.0.1:5174/',
    openFull: () => F.send({ type: 'model_router_open' }),
    loadSettings: () => routing(task()),
    // The sliders: the session's project's own while it has some, else everyone's.
    saveSettings: (s) => {
      const t = task();
      const p = projectOf(t);
      const levels = projectLevels(t);
      const mine = settings();
      const next = cleanSettings({ ...mine, ...(s || {}), ...(levels ? { efficiency: mine.efficiency, performance: mine.performance } : {}) });
      const changes = {};
      if (!sameAll(next, mine)) changes[SETTINGS] = next;
      if (levels && s && Number.isFinite(s.efficiency) && Number.isFinite(s.performance)) {
        const own = { efficiency: cleanSettings(s).efficiency, performance: cleanSettings(s).performance };
        if (own.efficiency !== levels.efficiency || own.performance !== levels.performance) changes[PROJECTS] = { ...(features[PROJECTS] || {}), [p]: own };
      }
      if (Object.keys(changes).length) savePrefs(changes);
    },
    feedback: (kind, detail = {}) => {
      const t = task();
      const pick = detail && detail.pick ? { model: detail.pick.model, effort: detail.pick.effort } : undefined;
      F.send({ type: 'model_router_feedback', kind, id: t ? t.id : undefined, prompt: typeof detail.prompt === 'string' ? detail.prompt : undefined, pick, chosen: detail.chosen });
    },
    learned: () => call('learned').then((d) => ({ frozen: Boolean(d && d.frozen), updated: (d && d.updated) || undefined, changes: (d && d.changes) || [] })),
    resetLearning: () => call('reset').then(() => { router = null; }),
    freezeLearning: (frozen) => call('freeze', { frozen: frozen === true }).then(() => undefined),
    spend: () => call('spend'),
    projectDefaults: () => {
      const t = task();
      if (!t || !projectOf(t)) return null;
      const levels = projectLevels(t);
      return { project: t.folder || undefined, ...(levels || {}) };
    },
    setProjectDefaults: (s) => {
      const t = task();
      const p = projectOf(t);
      if (!p) return;
      const all = { ...(features[PROJECTS] || {}) };
      if (s && Number.isFinite(s.efficiency) && Number.isFinite(s.performance)) {
        const c = cleanSettings(s);
        all[p] = { efficiency: c.efficiency, performance: c.performance };
      } else {
        delete all[p];
      }
      savePrefs({ [PROJECTS]: all });
      if (chip) chip.applySettings(routing(t));
    },
  };

  // The chip's latest result when it's for this very text and these settings, else null.
  function lastFor(text, s) {
    return last && last.result && sameText(last.prompt, text) && sameSettings(last.settings, s) ? last : null;
  }

  // Gemini's rating of a message that went on an unrated pick: the chip's, if it's rating
  // this very text now (chip.pending()); else asked here (or from the router's memory).
  async function ratingFor(text, s, t, inFlight) {
    if (inFlight) {
      const timedOut = {};
      const p = await within(inFlight, ROUTE_WAIT_MS, timedOut);  // (null too if it was dropped)
      if (p === timedOut) return null;  // the message went on its own meanwhile: not asked again
      if (p && p.result && sameText(p.prompt, text) && sameSettings(cleanSettings(p.settings), s)) return p.result;
    }
    const known = lastFor(text, s);  // (the chip may have finished meanwhile)
    if (known && isRated(known, s.classifier)) return known.result;
    return rate(bodyFor(text, s, t, { classifier: s.classifier }).body);
  }
  async function rateLater(token, text, s, t, sent, inFlight) {
    let route = null;
    try {
      const result = await ratingFor(text, s, t, inFlight);
      route = ratedRoute(models(), sent, result);
      if (route) withInfo(route, result, s, t);
    } catch (err) {
      console.warn('model router', err);
    }
    F.send(route ? { type: 'model_router_route', token, route } : { type: 'model_router_route', token });
  }
  // A route with what the log keeps of it and where the session goes if its model fails.
  function withInfo(route, result, s, t) {
    const { extras, boost } = bodyFor('', s, t);
    try { route.info = infoOf(result, s, extras, boost); } catch { /* (the route goes without it) */ }
    const fallbacks = fallbacksFor(models(), result, route);
    if (fallbacks.length) route.fallbacks = fallbacks;
    return route;
  }

  // What a message about to go carries: the best route there is for its text now (the
  // chip's, when it's for this very text and these settings; else the rules' at once), and
  // route_wait while Gemini's rating of it is still to come. With Shadow mode the route is
  // only logged (shadow), and nothing waits.
  function routeField(text, t) {
    const shadow = shadowOn();
    if ((!isOn() && !shadow) || !String(text || '').trim()) return {};
    if (!lib) { if (shadow && !libError) loadLib().catch(() => {}); return {}; }
    const s = routing(t);
    const known = isOn() ? lastFor(text, s) : null;
    let result = known && known.result;
    if (!result) {
      try {
        result = currentRouter().routeSync(bodyFor(text, s, t).body);
      } catch (err) {
        console.warn('model router', err);
        return {};
      }
    }
    const route = routeFor(models(), result && result.pick);
    if (!route) return {};
    withInfo(route, result, s, t);
    if (shadow || !isOn()) return { route: { ...route, shadow: true } };
    if (!needsRating(s.classifier, known, geminiPaused(), text)) return { route };
    const token = newToken();
    // (asked now, while the chip still holds this text: the composer is cleared once it goes)
    let inFlight = null;
    try { inFlight = chip && typeof chip.pending === 'function' ? chip.pending() : null; } catch { inFlight = null; }
    rateLater(token, text, s, t, route, inFlight);
    return { route, route_wait: token };
  }

  F.registerSessionOption((prompt) => routeField(prompt, null));
  F.registerSendOption((t, text) => (t && t.busy ? {} : routeField(text, t)));  // (never mid-step)

  function setOn(on) {
    if (on === isOn()) return;
    savePrefs({ [ON]: on });
    if (on) {
      libError = null;
      loadLib().then(() => {
        if (!currentRouter().ids.length) jcNote(F.t('Model Router knows none of your models yet. Add some in Settings › Models.'));
      }).catch(() => {});  // (loadLib said why)
    }
    renderComposer();
  }

  F.registerModelChoice({
    items: () => [
      { icon: 'router', label: 'Model Router', note: 'Picks the model and effort for each message', checked: isOn(), run: () => setOn(true) },
      '-',
    ],
    active: () => isOn(),
    picked: () => setOn(false),
  });

  function ensureChip() {
    if (chip || !lib) return chip;
    const Chip = customElements.get('model-router-chip');
    if (!Chip) return null;
    Chip.adapter = adapter;
    chip = document.createElement('model-router-chip');
    chip.id = 'jc-router';
    chip.setAttribute('target', '#deck-input');
    chip.setAttribute('anchor', '#deck-composer');
    chip.hidden = true;
    // (the rules' pick at once, then Gemini's once it's in: rated)
    chip.addEventListener('model-router-change', (e) => {
      const d = e.detail || {};
      if (!d.result || !d.result.pick) return;
      last = { prompt: d.prompt, settings: cleanSettings(d.settings), result: d.result, rated: d.rated === true };
    });
    F.$('jc-model').after(chip);
    return chip;
  }

  F.registerComposerRender((s) => {
    const on = isOn();
    F.$('jc-effort').hidden = on;
    if (on) {
      F.$('jc-model-label').textContent = 'Model Router';
      F.$('jc-model').title = 'Model: Model Router picks one for each message (⌘⇧I)';
    }
    if (!on) { if (chip) chip.hidden = true; return; }
    if (!lib) { if (!libError) loadLib().then(() => renderComposer()).catch(() => {}); return; }
    if (!ensureChip()) return;
    chip.hidden = false;
    const id = s.t ? s.t.id : null;
    if (id !== shownTask) {  // another session: its draft, and its project's levels
      shownTask = id;
      chip.applySettings(routing(s.t || null));
      chip.refresh();
    }
  });

  function onPrefs(p) {
    if (!p || !p.features) return;
    const t = task();
    const before = routing(t);
    const wasOn = isOn();
    const wasLearn = settings().learn;
    features = p.features;
    if (settings().learn !== wasLearn) router = null;
    if (chip && !sameSettings(before, routing(t))) chip.applySettings(routing(t));
    if (wasOn !== isOn()) renderComposer();
    if (shadowOn() && !lib && !libError) loadLib().catch(() => {});
  }
  F.on('hello', (ev) => { onPrefs(ev.prefs); F.send({ type: 'model_router_state_get' }); }, { replay: true });
  F.on('prefs', onPrefs);
  // (the keys may have changed: Gemini is asked again; its problems are still told once)
  F.on('providers', () => { router = null; geminiPause = 0; if (chip && !chip.hidden) chip.refresh(); });
  F.on('model_router_note', (ev) => { if (ev.text) jcNote(ev.text); });

  ICON_PATHS.router = ['M8 1.8l1.5 4.7 4.7 1.5-4.7 1.5L8 14.2l-1.5-4.7L1.8 8l4.7-1.5z'];
  renderComposer();
})(typeof window !== 'undefined' ? window : globalThis);
