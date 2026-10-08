// Eden at the controls of the cloud browser: a chat turn that needs the web ("open nytimes and
// summarize the top story", "find flights…", "fill this form") runs here as an agent loop. A
// model with tool calling plans and calls the browser tools (browser/agent-tools.js), each run on
// the account's own BrowserSession (the tabs the viewer watches in the panel), at most MAX_STEPS
// tool calls a turn; each step shows in the reply as it happens (`step` events), the final words
// as text.
//
//   SSE (beside chat.js's route, text, usage, provenance, error, done):
//     browser { open: true }                      the panel opens and shows "Eden is controlling"
//     step    { n, text, ok }                     "Opened nytimes.com", "Clicked “Sign in”"
//     browser { kind: 'approval', id, action, summary }   an approval card; the page answers
//                                                 with a new turn: { browser: { approve | deny: id } }
//     browser { kind: 'takeover', text }          a password or payment page: the owner types it
//     browser { kind: 'paused' }                  the owner took over in the panel
//
// Tool calling: each provider's own (OpenAI and Kimi function tools, Gemini function
// declarations, Anthropic tools), non-streamed, one call a step. The model is the page's pick when
// it has one, else the hosted default (providers.js defaultModel), else the cheapest keyed model.
//
// Metering: the browser's minutes count in the BrowserSession as always; each step's tokens count
// on the allowance (or the asker's own key) as it ends, under one hold for the turn's cap
// (EDEN_BROWSER_TURN_USD, $0.25 by default; 4x that on the asker's own key). Page content is
// untrusted: every snapshot reaches the model inside this turn's provenance blocks.

import { ApiError } from '../accounts/util.js';
import { BROWSER_SYSTEM, MAX_STEPS, TOOLS, stepText, validateCall } from '../browser/agent-tools.js';

export const TURN_USD = 0.25;
export const STEP_MAX_TOKENS = 2048;
const KEEP_SNAPSHOTS = 2; // older page snapshots are dropped from the transcript (tokens)

// ── when a turn needs the browser ──

const SITES = 'nytimes|new york times|google|youtube|amazon|wikipedia|reddit|twitter|github|bbc|cnn|gmail|linkedin|ebay|booking\\.com|expedia|kayak|airbnb|google maps|hacker news|espn|imdb|craigslist|zillow|etsy|walmart|target|instagram|facebook|tripadvisor|skyscanner|yelp|weather\\.com';
const OPEN = new RegExp(`\\b(open|go to|goto|visit|navigate to|browse( to)?|pull up|load|head to)\\s+(up\\s+)?(the\\s+)?(https?://\\S+|(www\\.)?[a-z0-9-]+(\\.[a-z0-9-]+)*\\.(com|org|net|io|ai|co|gov|edu|uk|de|fr|news|app|dev|tv|me|ca|au)\\b|(${SITES})\\b)`, 'i');
const TASK = /\b(in|on|with|using|use) (the|my|your|a) (cloud )?browser\b|\bfill (in |out )?(this|the|a|that) (form|application)\b|\b(find|search for|look up|book|compare|check)\b.{0,40}\b(flights?|hotels?|train tickets?|reservations?|prices? on)\b|\badd .{1,40} to (my|the) (cart|basket)\b|\bon (the|their|this|that) (website|site|web ?page)\b/i;
const PANEL = /\b(click|scroll|type|fill|tap|press|go back|next page|sign up|log ?in|this page|the page|that page|the tab|new tab)\b/i;

/** Whether a message asks for the browser (the composer's toggle or /browse say so outright). */
export function wantsBrowser(text, { panel = false } = {}) {
  const t = String(text || '');
  if (/^\s*\/browse\b/i.test(t)) return true;
  if (OPEN.test(t) || TASK.test(t)) return true;
  return Boolean(panel && PANEL.test(t));
}

/** The model that drives: the page's pick, else the hosted default, else the cheapest keyed model. */
export function pickBrowserModel(models, { override = null, preferred = null, rates = () => [0, 0] } = {}) {
  if (!models.length) return null;
  if (override) { const m = models.find((x) => x.id === override); if (m) return m; }
  if (preferred) { const m = models.find((x) => x.id === preferred); if (m) return m; }
  const order = { gemini: 0, openai: 1, anthropic: 2, kimi: 3 };
  return [...models].sort((a, b) => (order[a.provider] ?? 9) - (order[b.provider] ?? 9) || rates(a)[1] - rates(b)[1])[0];
}

// ── the provider calls ──

const schemaOf = (t) => (Object.keys(t.parameters.properties).length ? t.parameters : undefined);
const jpeg = (b64) => `data:image/jpeg;base64,${b64}`;

/** Older page snapshots and pictures replaced by a note (the newest KEEP_SNAPSHOTS stay). */
export function trimTranscript(transcript, keep = KEEP_SNAPSHOTS) {
  let pages = 0;
  let images = 0;
  for (let i = transcript.length - 1; i >= 0; i--) {
    const e = transcript[i];
    if (e.role !== 'tool') continue;
    if (e.image && ++images > 1) delete e.image;
    if (e.untrusted && e.text.length > 600 && ++pages > keep) { e.text = '(an older page snapshot, omitted: read_page again if needed)'; e.untrusted = false; }
  }
  return transcript;
}

/** One request in the provider's own shape. */
export function buildToolRequest(model, key, { system, transcript, final = false, maxTokens = STEP_MAX_TOKENS }) {
  const id = model.apiId || model.id;
  const p = model.provider;
  if (p === 'openai' || p === 'kimi') {
    const messages = [{ role: 'system', content: system }];
    const pics = [];
    const flush = () => { if (pics.length) { messages.push({ role: 'user', content: [{ type: 'text', text: 'The picture(s) the screenshot tool took:' }, ...pics.splice(0).map((d) => ({ type: 'image_url', image_url: { url: jpeg(d) } }))] }); } };
    for (const e of transcript) {
      if (e.role !== 'tool') flush();
      if (e.role === 'user') messages.push({ role: 'user', content: e.text });
      else if (e.role === 'assistant') messages.push(e.raw && e.raw.provider === p ? e.raw.message : { role: 'assistant', content: e.text || null, ...(e.calls.length ? { tool_calls: e.calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } })) } : {}) });
      else { messages.push({ role: 'tool', tool_call_id: e.id, content: e.text }); if (e.image) pics.push(e.image); }
    }
    flush();
    const url = p === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'https://api.moonshot.ai/v1/chat/completions';
    const body = { model: id, messages, tools: TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })), tool_choice: final ? 'none' : 'auto', ...(p === 'openai' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens }) };
    return { url, headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body };
  }
  if (p === 'gemini') {
    const contents = [];
    let results = null;
    for (const e of transcript) {
      if (e.role === 'tool') {
        if (!results) { results = { role: 'user', parts: [] }; contents.push(results); }
        results.parts.push({ functionResponse: { name: e.name, ...(e.callId ? { id: e.callId } : {}), response: { result: e.text } } });
        if (e.image) results.parts.push({ inlineData: { mimeType: 'image/jpeg', data: e.image } });
        continue;
      }
      results = null;
      if (e.role === 'user') contents.push({ role: 'user', parts: [{ text: e.text }] });
      else contents.push(e.raw && e.raw.provider === 'gemini' ? e.raw.content : { role: 'model', parts: [...(e.text ? [{ text: e.text }] : []), ...e.calls.map((c) => ({ functionCall: { name: c.name, args: c.args || {} } }))] });
    }
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents,
      tools: [{ functionDeclarations: TOOLS.map((t) => ({ name: t.name, description: t.description, ...(schemaOf(t) ? { parameters: schemaOf(t) } : {}) })) }],
      toolConfig: { functionCallingConfig: { mode: final ? 'NONE' : 'AUTO' } },
      generationConfig: { maxOutputTokens: maxTokens, ...(/^gemini-3/.test(id) ? { thinkingConfig: { thinkingLevel: 'low' } } : {}) },
    };
    return { url: `https://generativelanguage.googleapis.com/v1beta/models/${id}:generateContent`, headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body };
  }
  if (p === 'anthropic') {
    const messages = [];
    let results = null;
    for (const e of transcript) {
      if (e.role === 'tool') {
        if (!results) { results = { role: 'user', content: [] }; messages.push(results); }
        results.content.push({ type: 'tool_result', tool_use_id: e.id, content: [{ type: 'text', text: e.text || '(done)' }, ...(e.image ? [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: e.image } }] : [])] });
        continue;
      }
      results = null;
      if (e.role === 'user') messages.push({ role: 'user', content: [{ type: 'text', text: e.text }] });
      else messages.push({ role: 'assistant', content: e.raw && e.raw.provider === 'anthropic' ? e.raw.content : [...(e.text ? [{ type: 'text', text: e.text }] : []), ...e.calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args || {} }))] });
    }
    const body = { model: id, system, messages, max_tokens: maxTokens, tools: TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })), tool_choice: final ? { type: 'none' } : { type: 'auto' } };
    return { url: 'https://api.anthropic.com/v1/messages', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body };
  }
  throw new Error(`No tool calling for ${p}.`);
}

/** The provider's answer as { text, calls: [{ id, name, args }], usage, raw }. */
export function parseToolResponse(provider, j) {
  if (provider === 'openai' || provider === 'kimi') {
    const m = (j.choices && j.choices[0] && j.choices[0].message) || {};
    const u = j.usage || {};
    const reasoning = (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0;
    const calls = (m.tool_calls || []).map((c) => ({ id: c.id, name: c.function && c.function.name, args: c.function && c.function.arguments }));
    return { text: typeof m.content === 'string' ? m.content : '', calls, usage: { inputTokens: u.prompt_tokens || 0, outputTokens: Math.max(0, (u.completion_tokens || 0) - reasoning), reasoningTokens: reasoning }, raw: { provider, message: { role: 'assistant', content: m.content ?? null, ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}), ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}) } } };
  }
  if (provider === 'gemini') {
    const content = (j.candidates && j.candidates[0] && j.candidates[0].content) || { role: 'model', parts: [] };
    const parts = content.parts || [];
    const u = j.usageMetadata || {};
    let n = 0;
    const calls = parts.filter((x) => x.functionCall).map((x) => ({ id: x.functionCall.id || `g${++n}`, callId: x.functionCall.id || '', name: x.functionCall.name, args: x.functionCall.args || {} }));
    return { text: parts.filter((x) => typeof x.text === 'string' && !x.thought).map((x) => x.text).join(''), calls, usage: { inputTokens: u.promptTokenCount || 0, outputTokens: u.candidatesTokenCount || 0, reasoningTokens: u.thoughtsTokenCount || 0 }, raw: { provider, content: { role: 'model', parts } } };
  }
  if (provider === 'anthropic') {
    const content = j.content || [];
    const u = j.usage || {};
    return { text: content.filter((b) => b.type === 'text').map((b) => b.text).join(''), calls: content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} })), usage: { inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0), outputTokens: u.output_tokens || 0, reasoningTokens: 0 }, raw: { provider, content } };
  }
  return { text: '', calls: [], usage: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 }, raw: null };
}

// ── the loop ──

/**
 * The agent loop, with the model call and the browser injected (the tests give fakes):
 *   call(transcript, { final }) → { text, calls, usage, costUSD }
 *   act(name, args) → { text, step, error?, image?, untrusted?, needs?, blocked?, paused? }
 *   wrap(text, title) → the text inside this turn's untrusted block
 *   afford(lastStepUSD) → false once the turn's cap would be passed
 * → { end: 'done' | 'stopped' | 'approval' | 'takeover' | 'paused' | 'cap' | 'failed', text, log, steps, needs? }
 */
export async function runAgent({ call, act, emit = () => {}, signal = { aborted: false }, transcript, wrap = (t) => t, afford = () => true, maxSteps = MAX_STEPS, steer = null }) {
  const log = [];
  let steps = 0;
  let lastUSD = 0;
  const stopped = () => ({ end: 'stopped', text: '', log, steps });
  for (let round = 0; round <= maxSteps + 1; round++) {
    if (signal.aborted) return stopped();
    if (!afford(lastUSD)) return { end: 'cap', text: '', log, steps };
    // Steering: what the user sent while this run went on, as a note before the next step. It is the user's own words (not page content) and the run is not stopped.
    if (steer) for (const note of await steer()) { transcript.push({ role: 'user', text: steerText(note), calls: [] }); emit('steered', { text: note }); }
    const final = steps >= maxSteps;
    let r;
    try { r = await call(transcript, { final }); } catch (err) {
      if (signal.aborted) return stopped();
      return { end: 'failed', text: String((err && err.message) || err), log, steps };
    }
    lastUSD = r.costUSD || 0;
    if (signal.aborted) return stopped();
    const calls = final ? [] : (r.calls || []);
    transcript.push({ role: 'assistant', text: r.text || '', calls, raw: final ? null : r.raw });
    if (!calls.length) return { end: 'done', text: r.text || '', log, steps };
    let held = null;
    let takeover = null;
    for (const c of calls) {
      const answer = (text, extra = {}) => transcript.push({ role: 'tool', id: c.id, callId: c.callId || '', name: c.name, text, ...extra });
      if (held || takeover || signal.aborted) { answer('Not run (stopped first).'); continue; }
      if (steps >= maxSteps) { answer(`The ${maxSteps}-step limit for this turn is reached: answer the user now, without tools.`); continue; }
      const v = validateCall(c.name, c.args);
      if (!v.ok) { answer(`Error: ${v.error}`); continue; }
      steps += 1;
      let res;
      try { res = await act(c.name, v.args); } catch (err) { res = { error: 'That didn’t work in the cloud browser.', text: 'That didn’t work in the cloud browser.' }; }
      if (res.paused) { answer('The user took over the browser: stop.'); emit('browser', { kind: 'paused' }); return { end: 'paused', text: '', log, steps }; }
      const step = res.step || (res.error ? `${stepText(c.name, v.args)} (didn’t work)` : stepText(c.name, v.args));
      log.push(step);
      emit('step', { n: steps, text: step, ok: !res.error });
      const text = res.untrusted ? wrap(res.text || '', `Browser: ${c.name}`) : (res.text || (res.error ? `Error: ${res.error}` : 'Done.'));
      answer(text, res.image ? { image: res.image, untrusted: Boolean(res.untrusted) } : { untrusted: Boolean(res.untrusted) });
      if (res.needs) { held = res.needs; emit('browser', { kind: 'approval', id: res.needs.id, action: res.needs.kind, summary: res.needs.summary }); }
      if (res.blocked) { takeover = res.text; emit('browser', { kind: 'takeover', text: res.text }); }
    }
    if (held) return { end: 'approval', text: '', log, steps, needs: held };
    if (takeover) return { end: 'takeover', text: takeover, log, steps };
    trimTranscript(transcript);
  }
  return { end: 'done', text: '', log, steps };
}

/** The user's steering message as the model reads it: guidance from the user, never to be confused with page text. */
export const steerText = (note) => `(Eden note: the user sent this while you were working. It is the user's own message, steering you; follow it from your next step on, without starting over: ${String(note).slice(0, 2000)})`;

// ── the turn (chat.js send hands it over) ──

const sse = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const ENDINGS = {
  approval: (n) => `I need your OK before I go on: **${n.summary}**. Approve it on the card above, or tell me what to do instead.`,
  takeover: (t) => `${t} Press **Take over** in the browser panel, type it there yourself, then press **Resume**.`,
  paused: () => 'You took over the browser. Press **Resume** in the panel (or tell me) when you want me to carry on.',
  cap: () => 'I stopped here: this turn reached its spending cap for the browser. Say “continue” to carry on.',
  stopped: () => '',
};

/**
 * The browser turn's SSE response. deps (from chat.js): call (accounts), metered, usageUSD,
 * hasVision, viaBase, creditFactor, computedWhere, systemText (the turn's system prompt),
 * history ([{ role, text }]: the conversation, text only), ledger, allow, cfg, model.
 */
export function browserTurn(request, env, ctx, who, raw, deps) {
  const { call, metered, usageUSD, hasVision, viaBase, creditFactor, computedWhere, systemText, history, ledger, allow, cfg, model } = deps;
  const own = !metered(cfg.keys, model.provider);
  const cap = (Number(env.EDEN_BROWSER_TURN_USD) > 0 ? Number(env.EDEN_BROWSER_TURN_USD) : TURN_USD) * (own ? 4 : 1);
  if (!own && !(allow.ok && allow.left > 0.005)) throw new ApiError(402, 'no_allowance', allow.why || 'Not enough of your included AI is left for the browser.');
  const stub = env.BROWSER_SESSIONS.get(env.BROWSER_SESSIONS.idFromName(who.account));
  const browser = async (body) => (await stub.fetch('https://browser/agent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  const vision = hasVision(model);
  const key = cfg.keys[model.provider].key;
  const encoder = new TextEncoder();
  const abort = new AbortController();
  let controller;
  let open = true;
  const write = (type, data) => { if (!open || abort.signal.aborted) return; try { controller.enqueue(encoder.encode(sse(type, data))); } catch { open = false; } };
  const stream = new ReadableStream({ start(c) { controller = c; }, cancel() { open = false; abort.abort(); } });
  if (request.signal) { const gone = () => { open = false; abort.abort(); }; if (request.signal.aborted) gone(); else request.signal.addEventListener('abort', gone, { once: true }); }

  const run = crypto.randomUUID(); // this run's id: the page steers it with POST /api/chat/browser/steer
  const go = async () => {
    const ping = setInterval(() => { if (open) { try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { open = false; } } }, 15000);
    let hold = null;
    let charged = 0;
    const charges = [];
    const usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    let log = [];
    try {
      if (!own) {
        hold = await call(env, who.account, 'hold-ai', { eden: true, usd: Math.min(cap, allow.left) }, who.token);
        if (!hold.ok) { write('error', { message: hold.why || 'Not enough of your included AI is left.' }); return; }
      }
      const limit = own ? cap : Math.min(cap, allow.left);
      write('route', { model: model.id, modelName: model.name, provider: model.provider, effort: null, effortLabel: '', via: 'api', costUSD: null, quality: null, confidence: null, rationale: `Browser: ${model.name} drives your cloud browser with tool calls (at most ${MAX_STEPS} steps).`, rated: false, ratedBy: 'rules', ratedLabel: '', complexity: null, candidates: [], fallbacks: [], warnings: [], notes: [`browser turn: at most $${limit.toFixed(2)} of model use`, own ? 'on askeden.com: your own API key (not counted on your included AI)' : 'on askeden.com: your Jarvis account’s included AI'], where: computedWhere(model.provider), ...(own ? { ownKey: true } : {}) });
      write('browser', { open: true, runId: run });
      let plus;
      try { plus = Boolean((await call(env, who.account, 'get', {}, who.token)).plan?.active); } catch { plus = undefined; }
      const b = await browser({ op: 'begin', plus, resume: Boolean(raw.browser && raw.browser.resume), run });
      if (b.paused) { write('text', { text: ENDINGS.paused() }); write('done', { finish: 'stop' }); return; }
      if (b.error) { write('error', { message: b.error }); return; }
      const where = b.url ? `The browser now shows ${b.url}${b.title ? ` (${b.title})` : ''}; ${b.tabs} tab${b.tabs === 1 ? '' : 's'} open.` : 'The browser is on a new tab.';
      const earlier = b.log && b.log.length ? `\nSteps you took in earlier turns: ${b.log.slice(-12).join('; ')}.` : '';
      const system = `${systemText}\n\n${BROWSER_SYSTEM}\n${where}${earlier}${vision ? '' : '\nThis model can’t see pictures: use read_page, not screenshot.'}`;
      const transcript = history.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', text: m.text, calls: [] })).filter((m) => m.text);
      while (transcript.length && transcript[0].role !== 'user') transcript.shift();
      // An approval card's answer: the held action runs first (or is dropped), then the model goes on.
      const answer = raw.browser && (raw.browser.approve || raw.browser.deny);
      if (answer) {
        if (raw.browser.approve) {
          const r = await browser({ op: 'approve', id: String(raw.browser.approve), vision });
          const step = r.step || (r.error ? 'The approved action didn’t run' : 'Did the approved action');
          log.push(step);
          write('step', { n: 0, text: step, ok: !r.error });
          transcript.push({ role: 'user', text: `(Eden note: the user approved the held action. Result: ${r.error || r.text || 'done'}) Carry on with the task.`, calls: [] });
        } else {
          await browser({ op: 'deny', id: String(raw.browser.deny) });
          transcript.push({ role: 'user', text: '(Eden note: the user declined the held action: don’t do it. Ask what they want instead, or finish without it.)', calls: [] });
        }
      }
      if (!transcript.length || transcript[transcript.length - 1].role !== 'user') transcript.push({ role: 'user', text: 'Carry on.', calls: [] });
      const callModel = async (t, { final }) => {
        const http = buildToolRequest(model, key, { system, transcript: t, final });
        const res = await fetch(viaBase(cfg.base, http.url), { method: 'POST', headers: http.headers, body: JSON.stringify(http.body), signal: abort.signal });
        const j = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(`${model.name}: ${String((j.error && j.error.message) || j.message || `HTTP ${res.status}`).slice(0, 200)}`);
        const r = parseToolResponse(model.provider, j);
        const usd = usageUSD(model, { ...r.usage, webSearches: 0 });
        usage.inputTokens += r.usage.inputTokens; usage.outputTokens += r.usage.outputTokens; usage.reasoningTokens += r.usage.reasoningTokens;
        charged += usd;
        if (!own && usd > 0) charges.push(call(env, who.account, 'spend', { usd, bucket: hold ? hold.bucket : allow.bucket }).catch((e) => console.error('spend failed', e && e.message)));
        return { ...r, costUSD: usd };
      };
      ledger.mark('web', 'Pages read in the cloud browser');
      const out = await runAgent({
        call: callModel,
        act: (name, args) => browser({ op: 'act', name, args, vision }),
        emit: write,
        signal: abort.signal,
        transcript,
        wrap: (text, title) => ledger.untrusted('web', text, { title }),
        afford: (last) => charged + Math.max(last, 0.002) * 1.5 <= limit,
        steer: async () => { try { return (await browser({ op: 'steers', run })).texts || []; } catch { return []; } },
      });
      // A steering note that arrived after the last step: the page sends it as the next message.
      try { const left = (await browser({ op: 'steers', run })).texts || []; if (left.length) write('steerleft', { texts: left }); } catch { /* the browser is gone */ }
      log = [...log, ...out.log];
      if (ledger.tainted) write('provenance', ledger.summary());
      if (out.end === 'failed') { write('error', { message: out.text }); return; }
      if (out.end === 'stopped') return;
      const tail = out.end === 'done' ? out.text : ENDINGS[out.end](out.end === 'approval' ? out.needs : out.text);
      if (tail) write('text', { text: tail });
      const f = own ? 1 : creditFactor(hold || allow);
      write('usage', { ...usage, costUSD: round6(charged * f), notional: false, ...(own ? { ownKey: true } : {}), browserSteps: out.steps });
      write('done', { finish: 'stop' });
    } catch (error) {
      write('error', { message: error instanceof ApiError ? error.message : 'Something went wrong with the browser.' });
      if (!(error instanceof ApiError)) console.error('browser turn failed', error && error.stack);
    } finally {
      clearInterval(ping);
      await browser({ op: 'end', log }).catch(() => {});
      if (open) { open = false; try { controller.close(); } catch { /* gone */ } }
      await Promise.all(charges);
      if (hold) await call(env, who.account, 'release-ai', { hold: hold.hold }).catch(() => {});
    }
  };
  ctx.waitUntil(go());
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-accel-buffering': 'no' } });
}
