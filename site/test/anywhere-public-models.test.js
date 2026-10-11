// R3X2 + "Claude for everyone" (2026-10-10; askeden/docs/bug-sweep/anywhere/claude-for-everyone.md): the Ask Eden
// apps' routes (/api/eden/ask, /text, /sheet) answer on hosted Eden's models on askeden.com's own keys: Anthropic
// Claude (when the service has its key, providers.js serviceClaude, as /api/chat/send), OpenAI, Gemini and Moonshot
// Kimi. An edit (Chrome's rewrite…, the sheets' formula/fill/clean) gets Claude Sonnet when it is there; the rest the
// cheapest capable model. Each provider's own words for a cut-off and a refusal map to the apps' cut / cut_off and
// refused. The harness is anywhere-r3.test.js's, with raw provider streams (no translation).
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import worker from '../src/worker.js';
import { forgetAppleKeys } from '../src/accounts/apple.js';
import { challengeOf } from '../src/accounts/scoped.js';
import { ASK, CUT_NOTE, QUALITY_MODEL, TRAILER, appModel, appModels, endWatch, forgetBearers } from '../src/eden/ask.js';
import { forgetSessions } from '../src/eden/session.js';
import { modelOf, testOnlyServiceClaude, usageUSD } from '../src/eden/providers.js';
import { Account, Link, appleJwk, claudeAnswer, identityToken, namespace, sseBody } from './fakes.js';

// The real rule here: Claude on Eden's key only through serviceClaude (an ANTHROPIC_API_KEY, not switched off),
// never through the older suites' test switch (fakes.js turns it on).
testOnlyServiceClaude(false);

const ORIGIN = 'https://askeden.com';
const EXT_ID = 'cgincgeifceekdgpbboafpjdiapafggm';
const EXT = `chrome-extension://${EXT_ID}`;
const SCRIPT = 'AKfycbx_TestScriptId_0123456789abcdef';
const MSG = 'https://messenger.askeden.com';
const BACK = {
  chrome: `https://${EXT_ID}.chromiumapp.org/`,
  excel: `${ORIGIN}/addins/excel/connected`,
  sheets: `https://script.google.com/macros/d/${SCRIPT}/usercallback`,
  messenger: `${MSG}/eden/connected`,
};
const FROM = { chrome: EXT, excel: ORIGIN, sheets: null, messenger: MSG };
const ROUTE = { chrome: '/api/eden/text', excel: '/api/eden/sheet', sheets: '/api/eden/sheet', messenger: '/api/eden/ask' };
const BODY = {
  chrome: { action: 'explain', text: 'photosynthesis' },
  excel: { action: 'ask', app: 'excel', instruction: 'total?', sheet: { range: 'A1:A2', values: [['1'], ['2']] } },
  sheets: { action: 'ask', app: 'sheets', instruction: 'total?', sheet: { range: 'A1:A2', values: [['1'], ['2']] } },
  messenger: { question: 'Where?', messages: [{ author: 'Ben', text: 'Lyon.' }] },
};
const FORMULA = { action: 'formula', app: 'sheets', instruction: 'sum them', sheet: { range: 'A1:A2', values: [['1'], ['2']] }, active: { address: 'A3', value: '' } };
const VERIFIER = 'v'.repeat(20) + '-._~' + 'x'.repeat(30);
const KEYS = { anthropic: { ANTHROPIC_API_KEY: 'sk-ant-service' }, gemini: { GEMINI_API_KEY: 'g-test' }, openai: { OPENAI_API_KEY: 'o-test' }, kimi: { MOONSHOT_API_KEY: 'k-test' } };
/** Edit actions, one per app: they get the quality model (Claude Sonnet) when askeden.com runs it. */
const EDITS = {
  chrome: { action: 'rewrite', text: 'make this better' },
  excel: { action: 'clean', app: 'excel', sheet: { range: 'A1:A2', values: [['a '], ['B']] } },
  sheets: FORMULA,
};
const URLS = {
  anthropic: 'https://api.anthropic.com/',
  gemini: 'https://generativelanguage.googleapis.com/',
  openai: 'https://api.openai.com/',
  kimi: 'https://api.moonshot.ai/',
};

let env;
let waits;
let calls; // every provider request: { provider, url, body, headers }
let reply; // (provider) → Response
const ctx = { waitUntil: (p) => waits.push(p) };
const realFetch = globalThis.fetch;

// ── raw provider streams ──

const sse = (events) => new Response(events.map((e) => (e === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(e)}\n\n`)).join(''), { headers: { 'content-type': 'text/event-stream' } });
/** OpenAI's or Kimi's Chat Completions stream: text pieces, then how it ended, then the usage chunk. */
const chat = ({ text = ['Lyon', '.'], finish = 'stop', refusal = null, input = 1000, output = 200 } = {}) =>
  sse([
    ...text.map((t) => ({ choices: [{ index: 0, delta: { content: t } }] })),
    ...(refusal ? [{ choices: [{ index: 0, delta: { refusal } }] }] : []),
    ...(finish ? [{ choices: [{ index: 0, delta: {}, finish_reason: finish }] }] : []),
    { choices: [], usage: { prompt_tokens: input, completion_tokens: output } },
    '[DONE]',
  ]);
/** Gemini's streamGenerateContent?alt=sse: text pieces, the last with its finishReason and usage. */
const gemini = ({ text = ['Lyon', '.'], finish = 'STOP', blocked = null, input = 1000, output = 200 } = {}) =>
  blocked
    ? sse([{ promptFeedback: { blockReason: blocked }, usageMetadata: { promptTokenCount: input } }])
    : sse([
        ...text.map((t) => ({ candidates: [{ content: { role: 'model', parts: [{ text: t }] } }], usageMetadata: { promptTokenCount: input, candidatesTokenCount: 1 } })),
        { candidates: [{ content: { role: 'model', parts: [] }, finishReason: finish }], usageMetadata: { promptTokenCount: input, candidatesTokenCount: output } },
      ]);
/** Anthropic's Messages stream (event: lines and data), how it ended in stop_reason. */
const claude = ({ text = ['Lyon', '.'], stop = 'end_turn', input = 1000, output = 200, final = true } = {}) =>
  new Response(sseBody(claudeAnswer({ text, stop, input, output, final })), { headers: { 'content-type': 'text/event-stream' } });
const OK = { anthropic: () => claude(), gemini: () => gemini(), openai: () => chat(), kimi: () => chat() };

beforeEach(() => {
  waits = [];
  calls = [];
  forgetBearers();
  forgetAppleKeys();
  forgetSessions();
  reply = (provider) => OK[provider]();
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://appleid.apple.com/auth/keys') return Response.json({ keys: [appleJwk] });
    const provider = Object.keys(URLS).find((p) => url.startsWith(URLS[p]));
    if (provider) {
      calls.push({ provider, url, body: JSON.parse(init.body), headers: init.headers });
      return reply(provider);
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  setEnv({ ...KEYS.gemini });
});

/** Eden's env with these provider keys (KEYS.anthropic: the service's Anthropic key). */
function setEnv(keys) {
  env = { ...keys, TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '20', EDEN_SHEETS_SCRIPT_IDS: SCRIPT };
  env.ACCOUNTS = namespace(Account, env);
  env.LINKS = namespace(Link, env);
  env.ASSETS = { fetch: async (req) => new Response(`asset ${new URL(req.url).pathname}`, { headers: { 'content-type': 'text/html' } }) };
}

after(() => {
  globalThis.fetch = realFetch;
  testOnlyServiceClaude(true);
});

async function settle() {
  while (waits.length) await Promise.all(waits.splice(0));
}

async function hit(p, { method = 'GET', body, headers = {}, origin, session, bearer, form } = {}) {
  const h = { ...headers };
  if (origin != null) h.origin = origin;
  if (session) h.cookie = `__Host-eden=${session}`;
  if (bearer) h.authorization = `Bearer ${bearer}`;
  const init = { method, headers: h };
  if (form) {
    init.body = new URLSearchParams(form).toString();
    h['content-type'] = 'application/x-www-form-urlencoded';
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    h['content-type'] ??= 'application/json';
  }
  const response = await worker.fetch(new Request(`${ORIGIN}${p}`, init), env, ctx);
  await settle();
  return response;
}

const cookieValue = (response, name) => {
  const found = (response.headers.getSetCookie?.() || []).find((c) => c.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1).split(';')[0] : undefined;
};

async function signedIn(sub) {
  const made = await hit('/api/account/apple', { method: 'POST', body: { identity_token: await identityToken({ sub }), nonce: 'raw-nonce', device: { name: 'iPhone', kind: 'iphone' } } });
  assert.equal(made.status, 200, await made.clone().text());
  const owner = await made.json();
  const start = await hit('/api/web/link', { method: 'POST', origin: ORIGIN, body: {} });
  const link = await start.json();
  const linkCookie = `__Host-eden-link=${cookieValue(start, '__Host-eden-link')}`;
  assert.equal((await hit(`/api/link/${link.code}/approve`, { method: 'POST', bearer: owner.token, body: {} })).status, 200);
  const done = await hit('/api/web/link/poll', { method: 'POST', origin: ORIGIN, body: {}, headers: { cookie: linkCookie } });
  return { owner, session: cookieValue(done, '__Host-eden') };
}

const params = async (client) => ({ client_id: client, redirect_uri: BACK[client], state: 'state-r3x2-public-123456', code_challenge: await challengeOf(VERIFIER), code_challenge_method: 'S256' });

/** A connected account: its tokens for the clients asked for. */
async function connected(sub, clients) {
  const { owner, session } = await signedIn(sub);
  const tokens = {};
  for (const client of clients) {
    const approve = await hit('/api/eden/connect', { method: 'POST', origin: ORIGIN, session, form: { ...(await params(client)), decision: 'allow' } });
    const code = new URL(approve.headers.get('location')).searchParams.get('code');
    const response = await hit('/api/eden/token', { method: 'POST', origin: FROM[client], body: { grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: client, redirect_uri: BACK[client] } });
    assert.equal(response.status, 200, await response.clone().text());
    tokens[client] = (await response.json()).access_token;
  }
  return { owner, tokens, account: env.ACCOUNTS.objects.get(owner.account.id) };
}

const askAs = (client, bearer, body = BODY[client], headers = {}) => hit(ROUTE[client], { method: 'POST', origin: FROM[client], bearer, body, headers });
const TRAILED = { 'x-eden-trailer': '1' };
async function trailed(response) {
  const all = await response.text();
  const at = all.lastIndexOf(TRAILER);
  return at < 0 ? { text: all, end: null } : { text: all.slice(0, at), end: JSON.parse(all.slice(at + 1)) };
}

// ── Claude for everyone: on Eden's key when the service has one ──

test('Claude for everyone: with all four keys, edits answer on Claude Sonnet (Eden’s Anthropic key), the rest on Gemini Flash', async () => {
  setEnv({ ...KEYS.anthropic, ...KEYS.gemini, ...KEYS.openai, ...KEYS.kimi });
  const cfg = await appModels(env);
  assert.ok(cfg.models.some((m) => m.provider === 'anthropic'), 'Claude is in the apps’ pool');
  assert.equal(cfg.keys.anthropic.source, 'service');
  assert.equal(appModel(cfg, true), QUALITY_MODEL);
  assert.equal(appModel(cfg, false), 'gemini-3.8-flash');
  const { tokens, account } = await connected('cfe-all', ['chrome', 'excel', 'sheets', 'messenger']);
  // Explain, ask, analyze, a Messenger question: the cheapest capable model.
  for (const client of ['chrome', 'excel', 'sheets', 'messenger']) {
    const response = await askAs(client, tokens[client]);
    assert.equal(response.status, 200, client);
    assert.equal(await response.text(), 'Lyon.', client);
  }
  assert.deepEqual(calls.map((c) => c.provider), ['gemini', 'gemini', 'gemini', 'gemini']);
  assert.ok(calls.every((c) => /\/models\/gemini-3\.8-flash:streamGenerateContent\?alt=sse$/.test(c.url)));
  assert.ok(calls.every((c) => c.headers['x-goog-api-key'] === 'g-test' && !c.headers['x-api-key']));
  const messenger = calls.at(-1).body;
  assert.equal(messenger.generationConfig.maxOutputTokens, ASK.answerTokens);
  assert.equal(messenger.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
  // Rewrite, Clean, a formula: Claude Sonnet on Eden's own Anthropic key, capped at the action's budget.
  calls = [];
  for (const client of ['chrome', 'excel', 'sheets']) {
    const response = await askAs(client, tokens[client], EDITS[client]);
    assert.equal(response.status, 200, `${client} ${await response.clone().text()}`);
    assert.equal(await response.text(), 'Lyon.', client);
  }
  assert.deepEqual(calls.map((c) => c.provider), ['anthropic', 'anthropic', 'anthropic']);
  for (const c of calls) {
    assert.equal(c.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(c.headers['x-api-key'], 'sk-ant-service', 'askeden.com’s own Anthropic key');
    assert.equal(c.body.model, QUALITY_MODEL);
    assert.equal(c.body.stream, true);
    assert.ok(!c.body.tools, 'no tools: an app ask only reads what it was sent');
    assert.ok(!c.body.thinking || c.body.thinking.type !== 'enabled', 'no thinking budget eating the answer’s');
    assert.ok(c.body.max_tokens > 0);
  }
  assert.equal(calls[2].body.max_tokens, 600, 'the formula’s budget, exactly (sheets.js answerTokens)');
  assert.match(calls[2].body.system, /formula/i);
  // Billed at Claude's price from its usage (1,000 in, 200 out each), every hold let go.
  const usage = await account.storage.get('usage');
  const gem = usageUSD(modelOf('gemini-3.8-flash'), { inputTokens: 1000, outputTokens: 200, reasoningTokens: 0 });
  const son = usageUSD(modelOf(QUALITY_MODEL), { inputTokens: 1000, outputTokens: 200, reasoningTokens: 0 });
  assert.equal(Math.round(usage.trial_spent * 1e6), Math.round((4 * gem + 3 * son) * 1e6));
  assert.equal(account.holds.size, 0);
});

test('Claude for everyone: with only an Anthropic key, every app route answers on Claude (Sonnet for edits, the cheapest Claude for the rest)', async () => {
  setEnv({ ...KEYS.anthropic });
  const cfg = await appModels(env);
  assert.ok(cfg.models.length > 0 && cfg.models.every((m) => m.provider === 'anthropic'));
  const cheapest = appModel(cfg, false);
  assert.equal(modelOf(cheapest).provider, 'anthropic');
  assert.ok(cfg.models.every((m) => modelOf(m.id).pricing.outputPer1M >= modelOf(cheapest).pricing.outputPer1M), 'the cheapest Claude');
  const { tokens, account } = await connected('cfe-claude-only', ['chrome', 'sheets', 'messenger']);
  for (const client of ['chrome', 'sheets', 'messenger']) {
    const response = await askAs(client, tokens[client]);
    assert.equal(response.status, 200, client);
    assert.equal(await response.text(), 'Lyon.', client);
  }
  const edit = await askAs('chrome', tokens.chrome, EDITS.chrome);
  assert.equal(edit.status, 200);
  assert.deepEqual(calls.map((c) => c.body.model), [cheapest, cheapest, cheapest, QUALITY_MODEL]);
  assert.ok(calls.every((c) => c.provider === 'anthropic' && c.headers['x-api-key'] === 'sk-ant-service'));
  assert.equal(calls[2].body.max_tokens, ASK.answerTokens);
  assert.equal(account.holds.size, 0);
});

test('Claude for everyone: no service Anthropic key (or Anthropic switched off): no Claude, edits on Gemini Flash; no key at all: 503', async () => {
  for (const extra of [{}, { ...KEYS.anthropic, EDEN_ANTHROPIC: 'off' }]) {
    setEnv({ ...KEYS.gemini, ...KEYS.openai, ...extra });
    calls = [];
    const cfg = await appModels(env);
    assert.ok(cfg.models.length > 0);
    assert.ok(cfg.models.every((m) => m.provider !== 'anthropic'), cfg.models.map((m) => m.id).join());
    assert.equal(appModel(cfg, true), 'gemini-3.8-flash', 'an edit without Sonnet: the cheapest capable');
    const { tokens } = await connected(`cfe-no-claude-${Object.keys(extra).length}`, ['chrome', 'sheets', 'messenger']);
    for (const client of ['chrome', 'sheets']) assert.equal((await askAs(client, tokens[client], EDITS[client])).status, 200, client);
    assert.equal((await askAs('messenger', tokens.messenger)).status, 200);
    assert.deepEqual(calls.map((c) => c.provider), ['gemini', 'gemini', 'gemini'], 'nothing reaches Anthropic');
  }
  // No provider key at all: 503 not_set_up, nobody asked.
  setEnv({});
  calls = [];
  const { tokens } = await connected('cfe-none', ['chrome', 'sheets', 'messenger']);
  for (const client of ['chrome', 'sheets', 'messenger']) {
    const response = await askAs(client, tokens[client]);
    assert.equal(response.status, 503, client);
    assert.equal((await response.json()).code, 'not_set_up');
  }
  assert.equal(calls.length, 0, 'no provider asked');
});

test('R3X2: OpenAI only: GPT answers at no effort, capped at the budget, billed from its usage chunk', async () => {
  setEnv({ ...KEYS.openai });
  const { tokens, account } = await connected('r3x2-openai', ['messenger']);
  const response = await askAs('messenger', tokens.messenger);
  assert.equal(await response.text(), 'Lyon.');
  assert.equal(calls.length, 1);
  const { url, body, headers } = calls[0];
  assert.equal(url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(headers.authorization, 'Bearer o-test');
  assert.equal(body.model, 'gpt-6-luna');
  assert.equal(body.reasoning_effort, 'none');
  assert.equal(body.max_completion_tokens, ASK.answerTokens);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /Eden Messenger/);
  const usage = await account.storage.get('usage');
  assert.equal(usage.trial_spent, usageUSD(modelOf('gpt-6-luna'), { inputTokens: 1000, outputTokens: 200, reasoningTokens: 0 }));
  assert.equal(account.holds.size, 0);
});

// ── cut-offs and refusals, per provider ──

const CASES = {
  anthropic: { cut: () => claude({ stop: 'max_tokens' }), refused: [() => claude({ text: ['I can'], stop: 'refusal' }), () => claude({ text: [], stop: 'refusal' })] },
  gemini: { cut: () => gemini({ finish: 'MAX_TOKENS' }), refused: [() => gemini({ text: ['I can'], finish: 'SAFETY' }), () => gemini({ blocked: 'PROHIBITED_CONTENT' }), () => gemini({ text: [], finish: 'RECITATION' })] },
  openai: { cut: () => chat({ finish: 'length' }), refused: [() => chat({ text: [], finish: 'content_filter' }), () => chat({ text: [], refusal: 'I can’t help with that.' })] },
  kimi: { cut: () => chat({ finish: 'length' }), refused: [() => chat({ finish: 'content_filter' })] },
};

for (const provider of Object.keys(CASES)) {
  test(`R3X2: ${provider}: a cut-off is "cut" for prose and cut_off for cells; a refusal is "refused"; a whole answer is complete`, async () => {
    setEnv({ ...KEYS[provider] });
    const { tokens, account } = await connected(`r3x2-ends-${provider}`, ['messenger', 'sheets', 'chrome']);
    // Whole.
    assert.deepEqual(await trailed(await askAs('messenger', tokens.messenger, BODY.messenger, TRAILED)), { text: 'Lyon.', end: { answer: 'complete' } });
    const whole = await askAs('sheets', tokens.sheets);
    assert.equal(whole.headers.get('x-eden-answer'), 'complete');
    // Cut off at the output cap: prose ends with the note (streamed: trailer "cut"; buffered: x-eden-answer: cut) …
    reply = CASES[provider].cut;
    assert.deepEqual(await trailed(await askAs('messenger', tokens.messenger, BODY.messenger, TRAILED)), { text: `Lyon.${CUT_NOTE}`, end: { answer: 'cut' } });
    const cutProse = await askAs('sheets', tokens.sheets);
    assert.equal(cutProse.status, 200);
    assert.equal(cutProse.headers.get('x-eden-answer'), 'cut');
    assert.equal(await cutProse.text(), `Lyon.${CUT_NOTE}`);
    // … and a structured answer (a formula for a cell) is never used cut: 413 cut_off, buffered or streamed.
    const cutFormula = await askAs('sheets', tokens.sheets, FORMULA);
    assert.equal(cutFormula.status, 413);
    assert.equal((await cutFormula.json()).code, 'cut_off');
    const cutEdit = await trailed(await askAs('chrome', tokens.chrome, { action: 'rewrite', text: 'make this better' }, TRAILED));
    assert.equal(cutEdit.end.code, 'cut_off');
    assert.equal(cutEdit.end.status, 413);
    // Refused, in each of the provider's ways.
    for (const [i, make] of CASES[provider].refused.entries()) {
      reply = make;
      const streamed = await trailed(await askAs('messenger', tokens.messenger, BODY.messenger, TRAILED));
      assert.deepEqual([streamed.end.status, streamed.end.code], [422, 'refused'], `${provider} refusal ${i} (streamed)`);
      const buffered = await askAs('sheets', tokens.sheets);
      assert.equal(buffered.status, 422, `${provider} refusal ${i} (buffered)`);
      assert.equal((await buffered.json()).code, 'refused');
    }
    assert.equal(account.holds.size, 0, 'every hold let go');
    assert.ok(calls.every((c) => c.provider === provider), 'only that provider asked');
  });
}

test('R3X2: a stream that ends without its provider saying how is broken off (upstream), not complete', async () => {
  const { tokens } = await connected('r3x2-early', ['messenger', 'sheets']);
  reply = () => sse([{ candidates: [{ content: { role: 'model', parts: [{ text: 'Half' }] } }] }]);
  const streamed = await trailed(await askAs('messenger', tokens.messenger, BODY.messenger, TRAILED));
  assert.equal(streamed.text, 'Half');
  assert.deepEqual([streamed.end.status, streamed.end.code], [502, 'upstream']);
  assert.equal((await askAs('sheets', tokens.sheets)).status, 502);
  // Gemini's other endings (not a cut-off, not a safety stop): upstream, with its reason.
  reply = () => gemini({ finish: 'MALFORMED_FUNCTION_CALL' });
  const other = await askAs('sheets', tokens.sheets);
  assert.equal(other.status, 502);
  assert.match((await other.json()).error, /MALFORMED_FUNCTION_CALL/);
});

test('R3X2: endWatch maps each provider’s stop words', () => {
  const watch = (provider, events) => {
    const w = endWatch(provider);
    for (const [j, event] of events) w.see(j, event);
    return w.end();
  };
  assert.equal(watch('openai', [[{ choices: [{ delta: {}, finish_reason: 'length' }] }]]), 'cut');
  assert.equal(watch('openai', [[{ choices: [{ delta: {}, finish_reason: 'stop' }] }]]), 'complete');
  assert.equal(watch('openai', [[{ choices: [{ delta: { refusal: 'No.' } }] }], [{ choices: [{ delta: {}, finish_reason: 'stop' }] }]]), 'refused');
  assert.equal(watch('kimi', [[{ choices: [{ delta: {}, finish_reason: 'content_filter' }] }]]), 'refused');
  assert.equal(watch('gemini', [[{ candidates: [{ finishReason: 'MAX_TOKENS' }] }]]), 'cut');
  assert.equal(watch('gemini', [[{ candidates: [{ finishReason: 'STOP' }] }]]), 'complete');
  for (const r of ['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION', 'IMAGE_SAFETY']) assert.equal(watch('gemini', [[{ candidates: [{ finishReason: r }] }]]), 'refused', r);
  assert.equal(watch('gemini', [[{ promptFeedback: { blockReason: 'OTHER' } }]]), 'refused');
  assert.match(watch('gemini', [[{ candidates: [{ finishReason: 'OTHER' }] }]]).why, /OTHER/);
  assert.equal(watch('anthropic', [[{ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }]]), 'cut');
  assert.equal(watch('anthropic', [[{ type: 'message_delta', delta: { stop_reason: 'refusal' } }]]), 'refused');
  assert.equal(watch('gemini', []), null, 'no ending said: null (broken off)');
});
