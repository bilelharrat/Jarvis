// Model Router's pick for a message that didn't come from an Eden Code window (the phones,
// the local API and its CLI, the editor extension), worked out in the backend
// (features/code_router_backend.py keeps this running in Node while it's used).
//
// It runs the very router the window runs (web/features/vendor/model-router.js, the bundle
// built from the Model Router repo) through the very helpers the window routes with
// (web/features/code-router.js's pure part: modeOf, routingModels, settingsFor, routeBody,
// routeFor, addInfo), so the pick for the same message, models, prefs and state is the
// window's pick. The backend sends everything the window would know: the model picker's
// list, the router's prefs, model_router_state (learned overrides, plan quota, budget,
// sessions' projects and context) and whether Claude can answer.
//
// One JSON object a line, both ways:
//   in:  {id, op: "route", input: {text, task?: {id, model, effort}, picker, features,
//          state, claude: {down, until}, rate, waitMs}}
//   out: {id, ok: true, route?, rated}   (no route: off, nothing typed, or no model it knows)
//        {id, ok: false, error}
//   out: {op: "classify", rid, model, body}   Gemini's rating request: the backend sends it
//   in:  {op: "classified", rid, status, body}  on with the owner's key and its daily cap
//                                               (code_router.Router.classify), as it does
//                                               the window's; the key never comes here.
// Cost policy: no model is called here. A rating (only for a live route with rate on, as
// the window rates a message) goes through the backend, which counts it against the same
// RATINGS_PER_DAY as the window's.
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const vm = require('vm');

const WEB = process.env.EDEN_ROUTER_WEB || path.join(__dirname, '..', 'web', 'features');
const H = require(path.join(WEB, 'code-router.js'));

// The bundle is a browser script: its router, then the <model-router-chip> element, which
// does nothing when customElements says it's defined already (there are no elements here).
function loadLib(file = path.join(WEB, 'vendor', 'model-router.js')) {
  if (!globalThis.customElements) globalThis.customElements = { get: () => true, define() {} };
  return vm.runInThisContext(`${fs.readFileSync(file, 'utf8')}\n;ModelRouterLib`, { filename: file });
}

function makeWorker({ lib = loadLib(), write = (obj) => process.stdout.write(JSON.stringify(obj) + '\n'), now = () => Date.now() } = {}) {
  let router = null;
  let routerKey = '';
  let seq = 0;
  let geminiPause = 0;
  const classifying = new Map();  // rid -> resolve
  const providerOf = (id) => {
    const m = Array.isArray(lib.MODELS) ? lib.MODELS.find((x) => x.id === id) : null;
    return m ? m.provider : '';
  };

  // Gemini's answer: a problem stops the asking for a while (the window's geminiAnswered).
  function answered(status, body) {
    const ms = H.pauseAfter(status, H.errorText(body));
    if (ms) geminiPause = Math.max(geminiPause, now() + ms);
    else if (status >= 200 && status < 300) geminiPause = 0;
  }
  const paused = () => now() < geminiPause;

  // The router's fetch: its rating request goes to the backend (the window's viaJarvis).
  function viaBackend(url, init = {}) {
    return new Promise((resolve, reject) => {
      const m = /\/models\/([\w.-]+):generateContent$/.exec(String(url));
      if (!m) { reject(new Error('unexpected classifier address')); return; }
      const rid = `w${++seq}`;
      const abort = () => {
        if (classifying.delete(rid)) answered(504, '');
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      };
      if (init.signal) {
        if (init.signal.aborted) { abort(); return; }
        init.signal.addEventListener('abort', abort, { once: true });
      }
      classifying.set(rid, (ev) => {
        answered(ev.status || 502, ev.body);
        resolve(new Response(String(ev.body || ''), { status: ev.status || 502, headers: { 'content-type': 'application/json' } }));
      });
      let body;
      try { body = JSON.parse(init.body); } catch { body = null; }
      write({ op: 'classify', rid, model: m[1], body });
    });
  }

  function routerFor(list, state, s) {
    const overrides = s.learn === false ? null : H.learnedOverrides(state);
    const key = H.routerKeyOf(list, overrides ? H.learnedStamp(state) : '');
    if (!router || key !== routerKey) {
      const opts = { ...H.routerOptions(list), fetch: viaBackend, apiKey: 'jarvis', timeoutMs: 12000 };
      try {
        router = lib.createLocalRouter(overrides ? { ...opts, overrides } : opts);
      } catch (err) {
        if (!overrides) throw err;
        router = lib.createLocalRouter(opts);
      }
      routerKey = key;
    }
    return router;
  }

  // The window's routeField, for a message from elsewhere: the rules' pick, and while Model
  // Router is the model (live) and rate is on, Gemini's when it comes within waitMs.
  async function route(input) {
    const f = input.features || {};
    const mode = H.modeOf(f);
    const text = String(input.text || '');
    if (!mode || !text.trim()) return { route: null, rated: false };
    const state = input.state || null;
    const claude = input.claude || {};
    const list = H.routingModels(input.picker || [], {
      claudeDownUntil: claude.down ? Number(claude.until) || 0 : 0,
      providerOf,
      off: Array.isArray(f[H.PROVIDERS_OFF]) ? f[H.PROVIDERS_OFF] : [],
      now: now(),
    });
    const e = input.task;
    const t = e && e.id != null ? { id: e.id, model: e.model || '', effort: e.effort || '' } : null;
    const s = H.settingsFor(f, state, t);
    const sticky = f[H.ON] === true;
    const r = routerFor(list, state, s);
    const result = r.routeSync(H.routeBody(text, s, t, state, sticky).body);
    const picked = H.routeFor(list, result && result.pick);
    if (!picked) return { route: null, rated: false };
    H.addInfo(list, picked, result, s, t, state, sticky);
    if (mode !== 'live') return { route: { ...picked, shadow: true }, rated: false };
    if (input.rate !== true || !H.needsRating(s.classifier, null, paused(), text)) return { route: picked, rated: false };
    const wait = Math.max(0, Math.min(H.ROUTE_WAIT_MS, Number(input.waitMs) || H.ROUTE_WAIT_MS));
    const rated = await H.within(r.route(H.routeBody(text, s, t, state, sticky, { classifier: s.classifier }).body), wait, null);
    const better = H.ratedRoute(list, picked, rated);
    if (better) return { route: H.addInfo(list, better, rated, s, t, state, sticky), rated: true };
    const used = Boolean(rated && rated.classification && rated.classification.used === true);
    return { route: picked, rated: used };
  }

  async function handle(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.op === 'classified') {
      const done = classifying.get(msg.rid);
      if (done) { classifying.delete(msg.rid); done(msg); }
      return;
    }
    if (msg.op !== 'route') return;
    try {
      write({ id: msg.id, ok: true, ...(await route(msg.input || {})) });
    } catch (err) {
      write({ id: msg.id, ok: false, error: String((err && err.message) || err).slice(0, 300) });
    }
  }
  return { handle, route, providerOf };
}

if (require.main === module) {
  let worker;
  try {
    worker = makeWorker();
  } catch (err) {
    process.stdout.write(JSON.stringify({ op: 'fatal', error: String((err && err.message) || err).slice(0, 300) }) + '\n');
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({ op: 'ready' }) + '\n');
  const lines = readline.createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    worker.handle(msg);
  });
  lines.on('close', () => process.exit(0));
}

module.exports = { makeWorker, loadLib };
