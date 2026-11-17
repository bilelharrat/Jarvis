// stats/provider-spend.js: each provider's own bill, read with a stubbed fetch.
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { providerSpend, keyApps } from '../src/stats/provider-spend.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const NOW = Date.UTC(2026, 10, 14, 15); // 14 Nov 2026
const ts = (d) => Math.floor(Date.UTC(2026, 10, d) / 1000);
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** fetch answered by `routes` (first matching substring); every call is logged with its headers. */
function stub(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, headers: init.headers || {}, body: init.body });
    for (const [part, fn] of routes) if (u.includes(part)) return typeof fn === 'function' ? fn(u, init) : fn;
    return reply({ error: 'no route' }, 404);
  };
  return calls;
}
const byId = (out) => Object.fromEntries(out.providers.map((p) => [p.id, p]));

test('no keys: every provider says what to set up (Perplexity: console only); nothing is fetched; no money is made up', async () => {
  const calls = stub([]);
  const out = await providerSpend({}, NOW);
  const p = byId(out);
  assert.deepEqual(Object.keys(p), ['openai', 'anthropic', 'google', 'kimi', 'deepinfra', 'fish', 'perplexity']);
  for (const id of ['openai', 'anthropic', 'google', 'kimi', 'deepinfra', 'fish']) assert.equal(p[id].status, 'setup', id);
  assert.equal(p.perplexity.status, 'console');
  assert.equal(calls.length, 0);
  assert.equal(out.month_usd, 0);
  assert.deepEqual(out.counted, []);
  for (const x of out.providers) assert.equal(x.month_usd, null, `${x.id}: no number without a source`);
});

test('OpenAI: costs by day and line item, tokens by model and key (named by PROVIDER_KEY_APPS), pages followed; admin key sent as Bearer', async () => {
  const calls = stub([
    ['/organization/costs', (u) => (u.includes('page=p2')
      ? reply({ data: [{ start_time: ts(14), results: [{ amount: { value: 1.5, currency: 'usd' }, line_item: 'gpt-6.1, input' }] }], has_more: false })
      : reply({ data: [{ start_time: ts(13), results: [{ amount: { value: 2.25 }, line_item: 'gpt-6.1, input' }, { amount: { value: 0.75 }, line_item: 'image' }] }], has_more: true, next_page: 'p2' }))],
    ['/organization/usage/completions', reply({ data: [{ start_time: ts(13), results: [{ model: 'gpt-6.1', api_key_id: 'key_A', input_tokens: 1000, output_tokens: 200 }, { model: 'gpt-6.1-mini', api_key_id: 'key_B', input_tokens: 50, output_tokens: 5, input_audio_tokens: 10 }] }], has_more: false })],
  ]);
  const env = { OPENAI_ADMIN_KEY: 'sk-admin-xyz', PROVIDER_KEY_APPS: JSON.stringify({ openai: { key_A: 'askeden.com' } }) };
  const o = byId(await providerSpend(env, NOW)).openai;
  assert.equal(o.status, 'ok');
  assert.equal(o.month_usd, 4.5);
  assert.equal(o.today_usd, 1.5);
  assert.equal(o.yesterday_usd, 3);
  assert.deepEqual(o.by_item.map((x) => [x.name, x.usd]), [['gpt-6.1, input', 3.75], ['image', 0.75]]);
  assert.deepEqual(o.tokens, { in: 1060, out: 205 });
  assert.deepEqual(o.by_key.map((k) => [k.name, k.tokens, k.app]), [['key_A', 1200, 'askeden.com'], ['key_B', 65, null]]);
  assert.equal(calls.filter((c) => c.url.includes('/costs')).length, 2, 'the second page read');
  assert.ok(calls.every((c) => c.headers.authorization === 'Bearer sk-admin-xyz'));
  const first = new URL(calls[0].url);
  assert.equal(first.searchParams.get('start_time'), String(ts(1)), 'from the 1st of the month (UTC)');
  assert.equal(first.searchParams.get('bucket_width'), '1d');
});

test('Anthropic: amounts are cents; tokens include cache reads and writes; x-api-key and anthropic-version sent', async () => {
  const calls = stub([
    ['/cost_report', reply({ data: [{ starting_at: '2026-11-13T00:00:00Z', results: [{ amount: '250.5', model: 'claude-opus-5-5' }, { amount: '49.5', description: 'web search' }] }], has_more: false })],
    ['/usage_report/messages', reply({ data: [{ starting_at: '2026-11-13T00:00:00Z', results: [{ api_key_id: 'apikey_1', model: 'claude-opus-5-5', uncached_input_tokens: 100, cache_read_input_tokens: 400, cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 0 }, output_tokens: 70 }] }], has_more: false })],
  ]);
  const a = byId(await providerSpend({ ANTHROPIC_ADMIN_KEY: 'sk-ant-admin01-k', PROVIDER_KEY_APPS: '{"anthropic":{"apikey_1":"Eden Secretary"}}' }, NOW)).anthropic;
  assert.equal(a.status, 'ok');
  assert.equal(a.month_usd, 3);
  assert.equal(a.yesterday_usd, 3);
  assert.deepEqual(a.tokens, { in: 550, out: 70 });
  assert.deepEqual(a.by_key.map((k) => [k.name, k.tokens, k.app]), [['apikey_1', 620, 'Eden Secretary']]);
  assert.ok(calls.every((c) => c.headers['x-api-key'] === 'sk-ant-admin01-k' && c.headers['anthropic-version']));
  assert.equal(new URL(calls[0].url).searchParams.get('starting_at'), '2026-11-01T00:00:00.000Z');
});

test('a refused key: that provider says so (no key text leaks); the others still read; the alert lists it', async () => {
  stub([
    ['/organization/costs', reply({ error: { message: 'Incorrect API key provided: sk-proj-abcdefghijklmnop' } }, 401)],
    ['/users/me/balance', reply({ data: { available_balance: 12.5, cash_balance: 10, voucher_balance: 2.5 } })],
  ]);
  const out = await providerSpend({ OPENAI_ADMIN_KEY: 'sk-proj-abcdefghijklmnop', MOONSHOT_API_KEY: 'mk' }, NOW);
  const p = byId(out);
  assert.equal(p.openai.status, 'error');
  assert.match(p.openai.note, /refused the key/);
  assert.doesNotMatch(JSON.stringify(out), /abcdefghijklmnop/, 'the key never comes back');
  assert.deepEqual(p.kimi.balance, { usd: 12.5, cash_usd: 10, voucher_usd: 2.5 });
  assert.ok(out.alerts.some((x) => x.provider === 'openai' && x.level === 'warn'));
  assert.ok(out.alerts.some((x) => x.provider === 'kimi' && x.level === 'red'), 'under the default $20 floor');
});

test('alerts: the floor and the day limit come from the env; a timeout is an error, not a zero', async () => {
  stub([
    ['/users/me/balance', reply({ data: { available_balance: 30 } })],
    ['/wallet/self/api-credit', reply({ credit: '4.20' })],
    ['/organization/costs', reply({ data: [{ start_time: ts(13), results: [{ amount: { value: 42 } }] }], has_more: false })],
    ['/organization/usage', () => { const e = new Error('slow'); e.name = 'TimeoutError'; throw e; }],
  ]);
  const out = await providerSpend({ MOONSHOT_API_KEY: 'm', FISH_API_KEY: 'f', OPENAI_ADMIN_KEY: 'a', SPEND_ALERT_FLOOR_USD: '5', SPEND_ALERT_DAY_USD: '{"openai":40}' }, NOW);
  const p = byId(out);
  assert.deepEqual(out.alerts.filter((a) => a.level === 'red').map((a) => a.provider), ['fish'], 'Kimi $30 is over the $5 floor; Fish $4.20 is under');
  assert.equal(p.openai.status, 'error', 'the usage call timed out');
  assert.match(p.openai.note, /timed out/);
  const out2 = await providerSpend({ OPENAI_ADMIN_KEY: 'a', SPEND_ALERT_DAY_USD: '40' }, NOW);
  assert.equal(byId(out2).openai.status, 'error');
});

test('DeepInfra: the month by model in cents; a negative Stripe balance is money there to spend', async () => {
  const calls = stub([
    ['/payment/usage', reply({ months: [{ period: '2026.11', total_cost: 1234, items: [{ model: { model_name: 'deepseek' }, cost: 1000 }, { model: { model_name: 'llama' }, cost: 234 }] }] })],
    ['/payment/checklist', reply({ stripe_balance: -5000 })],
  ]);
  const d = byId(await providerSpend({ DEEPINFRA_API_KEY: 'di' }, NOW)).deepinfra;
  assert.equal(d.month_usd, 12.34);
  assert.deepEqual(d.by_model.map((m) => [m.name, m.usd]), [['deepseek', 10], ['llama', 2.34]]);
  assert.deepEqual(d.balance, { usd: 50 });
  assert.equal(d.today_usd, null, 'no daily numbers: none made up');
  assert.match(calls[0].url, /from=2026\.11&to=2026\.11/);
});

test('Google: needs the export table and a service account; with them, BigQuery is asked with the date as a parameter and credits are netted', async () => {
  stub([]);
  assert.equal(byId(await providerSpend({ GCP_BILLING_TABLE: 'bad table; drop' }, NOW)).google.status, 'setup');
  const { privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', privateKey)).toString('base64');
  const sa = { type: 'service_account', client_email: 'billing@proj.iam.gserviceaccount.com', private_key: `-----BEGIN PRIVATE KEY-----\n${der}\n-----END PRIVATE KEY-----\n` };
  const calls = stub([
    ['oauth2.googleapis.com/token', reply({ access_token: 'ya29.tok', expires_in: 3600 })],
    ['bigquery.googleapis.com', reply({ jobComplete: true, rows: [{ f: [{ v: '2026-11-13' }, { v: 'Vertex AI' }, { v: '100' }, { v: '-90' }, { v: 'USD' }] }, { f: [{ v: '2026-11-14' }, { v: 'Maps' }, { v: '5' }, { v: '0' }, { v: 'USD' }] }] })],
  ]);
  const g = byId(await providerSpend({ GCP_BILLING_TABLE: 'my-proj.billing.gcp_billing_export_v1_0141', VERTEX_CREDENTIALS: JSON.stringify(sa) }, NOW)).google;
  assert.equal(g.status, 'ok');
  assert.equal(g.month_usd, 15, 'after credits');
  assert.equal(g.credits_applied_usd, 90);
  assert.equal(g.today_usd, 5);
  const q = JSON.parse(calls.find((c) => c.url.includes('bigquery')).body);
  assert.match(q.query, /`my-proj\.billing\.gcp_billing_export_v1_0141`/);
  assert.deepEqual(q.queryParameters[0].parameterValue, { value: '2026-11-01' });
  assert.equal(calls.find((c) => c.url.includes('bigquery')).headers.authorization, 'Bearer ya29.tok');
});

test('PROVIDER_KEY_APPS: bad JSON or wrong shapes are ignored', () => {
  assert.deepEqual(keyApps({ PROVIDER_KEY_APPS: 'nope' }), {});
  assert.deepEqual(keyApps({ PROVIDER_KEY_APPS: JSON.stringify({ openai: { a: 'Eden', b: 3, c: ' ' }, anthropic: ['x'] }) }), { openai: { a: 'Eden' } });
});

test('deadline: a provider whose fetch never answers is an error ("timed out") by PROVIDER_DEADLINE_MS; the others still read', async () => {
  stub([
    ['api.moonshot.ai', () => new Promise(() => {})], // never resolves
    ['api.fish.audio', reply({ credit: 42 })],
  ]);
  const started = Date.now();
  const p = byId(await providerSpend({ MOONSHOT_API_KEY: 'mk', FISH_API_KEY: 'fk', PROVIDER_DEADLINE_MS: '150' }, NOW));
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  assert.deepEqual([p.kimi.status, p.kimi.note], ['error', 'timed out']);
  assert.equal(p.fish.status, 'ok');
  assert.equal(p.fish.balance.usd, 42);
});
