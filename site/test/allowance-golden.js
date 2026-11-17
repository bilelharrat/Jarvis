// The flag-off golden for ALLOWANCE_V2 (accounts/allowance.js): one scripted run of the included AI
// (allow-ai, hold-ai, hold-proxy, spend, get) across every kind of account, on a fixed clock. Its
// output was captured from the code as it was before v2 (test/allowance-v1-golden.json); with the
// flag off (unset, "off", anything but "on") it must stay exactly that. allowance-v2.test.js runs it.
//
// Refresh only on purpose (an intended v1 change): node test/allowance-golden.js --write
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { call } from '../src/accounts/index.js';
import { parseToken } from '../src/accounts/util.js';
import { TEST_ACCOUNT_ID } from '../src/accounts/test-login.js';
import { Account, namespace } from './fakes.js';

const DAY = 86400_000;
export const T0 = Date.UTC(2026, 10, 12, 10, 0, 0); // Thu 12 Nov 2026 10:00 UTC
export const GOLDEN = fileURLToPath(new URL('./allowance-v1-golden.json', import.meta.url));

const ids = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const stripePlan = (extra = {}) => ({
  customer: 'cus_1', subscription: 'sub_1', status: 'active', price: 'price_1PlusMonthlyTest',
  period_start: Date.UTC(2026, 10, 5, 9, 31), period_end: Date.UTC(2026, 11, 5, 9, 31), renews: true, livemode: false, ...extra,
});
const lot = { id: 'lot_1', usd: 5, left: 5, at: T0 - DAY, expires: T0 + 300 * DAY, source: 'stripe' };

/** Every kind of account the allowance treats differently: its storage, and its env. */
export const SCENARIOS = {
  free_trial: {},
  stripe_plus: { store: { stripe_plan: stripePlan() } },
  stripe_plus_credits: { store: { stripe_plan: stripePlan(), credits: { customer: null, payment_method: null, lots: [lot] } } },
  app_store_legacy: { store: { plan: { product_id: 'com.askeden.jarvis.plus.monthly', transaction_id: '2001', original_transaction_id: '2000', expires: T0 + 25 * DAY, revoked: false, environment: 'Production', signed_date: T0 - DAY } } },
  app_store_sandbox: { store: { plan: { product_id: 'com.askeden.eden.plus.monthly', transaction_id: '3001', original_transaction_id: '3000', expires: T0 + 25 * DAY, revoked: false, environment: 'Sandbox', signed_date: T0 - DAY } } },
  play: { store: { play_plan: { token: 'tok-1', product_id: 'com.askeden.eden.plus.monthly', base_plan: 'monthly', state: 'SUBSCRIPTION_STATE_ACTIVE', expires: T0 + 25 * DAY, renews: true, account: null, linked: null, test: false, order: 'GPA.1', fetched: T0 } } },
  play_test: { store: { play_plan: { token: 'tok-2', product_id: 'com.askeden.eden.plus.monthly', base_plan: 'monthly', state: 'SUBSCRIPTION_STATE_ACTIVE', expires: T0 + 25 * DAY, renews: true, account: null, linked: null, test: true, order: 'GPA.2', fetched: T0 } } },
  promo: { store: { promo_plan: { until: T0 + 40 * DAY, codes: [] } } },
  rewards_month: { store: { plus_bonus_until: { until: T0 + 30 * DAY, banked_ms: 0 }, 'rwd:ai': [{ red: 'r1', usd: 2, until: Date.UTC(2026, 11, 1) }] } },
  daredevil: { store: { daredevil: true } },
  unlimited: { env: { UNLIMITED_EMAILS: 'fam@example.com' }, store: { identities: [{ provider: 'google', sub_hash: 'h1', email: 'fam@example.com', added: T0 }] } },
  delegate: { store: { stripe_plan: stripePlan(), 'dlg:abc': { status: 'active' }, 'pool:dlg:abc': { cap: 2, month: '2026-11', spent: 0, by: {} } }, grant: { type: 'delegate', id: 'abc', label: 'Sam', features: [], account: 'bbbbbbbb' } },
  test_account: { id: TEST_ACCOUNT_ID, env: { TEST_LOGIN: 'on', TEST_LOGIN_PASSWORD: 'pw' }, store: { test_day: '2026-11-12' } },
};

/** A fresh account for one scenario: { env, obj, id, auth, appAuth, clock }. */
export async function setUp(name, flagEnv = {}, n = 1) {
  const sc = SCENARIOS[name];
  const id = sc.id || ids(n);
  const env = { TRIAL_BUDGET_USD: '1', PLUS_BUDGET_USD: '6', ...(sc.env || {}), ...flagEnv };
  env.ACCOUNTS = namespace(Account, env);
  env.ACCOUNTS.get(id);
  const obj = env.ACCOUNTS.objects.get(id);
  const clock = { t: T0 };
  obj.now = () => clock.t;
  await obj.storage.put('account', { id, created: T0 - 30 * DAY, origin: 'apple' });
  for (const [k, v] of Object.entries(sc.store || {})) await obj.storage.put(k, v);
  const web = await obj.makeDevice(id, { name: 'Eden on the web', kind: 'web' });
  const app = await obj.makeDevice(id, { name: 'iPhone', kind: 'iphone' });
  let auth = parseToken(web.token);
  if (sc.grant) {
    const d = await obj.storage.get(`dev:${auth.device}`);
    await obj.storage.put(`dev:${auth.device}`, { ...d, grant: sc.grant });
  }
  return { env, obj, id, auth, appAuth: parseToken(app.token), clock, direct: Boolean(sc.id) };
}

const noHold = ({ hold, ...rest }) => ({ ...rest, ...(hold ? { hold: 'H' } : {}) });
const pick = (v) => ({ plan: v.plan, usage: v.usage, credits: v.credits, ...(v.test ? { test: v.test } : {}), ...(v.grant ? { grant: v.grant } : {}) });

/** One op, through the Worker's call() (or straight on the object for the shared test account). */
async function op(s, name, body = {}, which = 'web') {
  const auth = which === 'app' ? s.appAuth : s.auth;
  try {
    if (s.direct) {
      if (name === 'allow-ai') return await s.obj.allowAi();
      if (name === 'hold-ai') return await s.obj.holdAi(body);
      if (name === 'hold-proxy') return await s.obj.holdProxy(body);
      if (name === 'get') return await s.obj.view({ id: auth.device });
    }
    return await call(s.env, s.id, name, body, ['spend', 'release-ai'].includes(name) ? null : auth);
  } catch (e) {
    return { error: e.status, code: e.code, message: e.message };
  }
}

/** The scripted run: [{ step, out }]. `keys`: whether each step reports the allow2 key's presence. */
export async function runScenario(name, flagEnv = {}, n = 1) {
  const s = await setUp(name, flagEnv, n);
  const out = [];
  let bucket = 'plus';
  let holds = [];
  const step = async (label, fn) => out.push({ step: label, out: await fn() });
  const allow = async () => {
    const a = await op(s, 'allow-ai', { eden: true });
    if (a && a.bucket) bucket = a.bucket;
    return a;
  };
  await step('get', async () => pick(await op(s, 'get')));
  await step('allow', allow);
  await step('hold-ai', async () => { const h = await op(s, 'hold-ai', { eden: true, usd: 0.2 }); if (h.hold) holds.push(h.hold); return noHold(h); });
  await step('hold-proxy', async () => { const h = await op(s, 'hold-proxy', { usd: 0.3 }, 'app'); if (h.hold) holds.push(h.hold); if (h.bucket) bucket = h.bucket; return noHold(h); });
  await step('allow-held', allow);
  await step('release', async () => { for (const h of holds) await op(s, 'release-ai', { hold: h }); holds = []; return {}; });
  for (const [i, usd] of [[1, 1], [2, 4.5], [3, 3]].map(([i, u]) => [i, u])) {
    await step(`spend-${i}`, () => op(s, 'spend', { usd, bucket }));
    await step(`allow-${i}`, allow);
  }
  await step('get-2', async () => pick(await op(s, 'get')));
  s.clock.t = T0 + 20 * DAY; // into December
  await step('allow-dec', allow);
  await step('get-dec', async () => pick(await op(s, 'get')));
  await step('spend-dec', () => op(s, 'spend', { usd: 0.5, bucket }));
  await step('allow-dec-2', allow);
  return { steps: out, allow2: (await s.obj.storage.get('allow2')) !== undefined };
}

export async function runAll(flagEnv = {}) {
  const all = {};
  let n = 1;
  for (const name of Object.keys(SCENARIOS)) all[name] = (await runScenario(name, flagEnv, n++)).steps;
  return all;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--write')) {
  const all = await runAll({});
  writeFileSync(GOLDEN, `${JSON.stringify(all, null, 1)}\n`);
  console.log('wrote', GOLDEN, Object.keys(all).length, 'scenarios');
}
