// The account owner's own API keys for hosted Eden (OpenAI, Google Gemini, Moonshot Kimi,
// Anthropic): Settings › Models & API keys on askeden.com, the same contract as the Mac's
// GET/POST /api/chat/keys (docs/chat-api.md). A chat on a provider the owner has a key for runs
// on that key instead of the included AI (userKeyFor, the multi-provider code's providerKey hook).
//
// - Stored in the account's Durable Object at `ukey:<provider>`: { v, iv, ct, last4, added }.
//   `ct` is AES-256-GCM over { key } under tokens.js's HKDF key for the account (EDEN_TOKEN_KEY
//   and the account id), with `ukey:<account>:<provider>` as associated data: a record moved to
//   another account or provider doesn't open. The object stores ciphertext only.
// - A key never goes back to a browser: the page sees `set`, the last 4 characters and when it
//   was added. It leaves the Worker only to its own provider (the check here, and the chats).
// - Only the owner's own devices (web or app) may list, set, use or remove them: a delegate's or
//   a team space's device is refused by the object (grantGuard and below) and by the Worker.
// - Deleting the account deletes them with everything else (storage.deleteAll).
// - Errors and logs never carry a key: scrub() blanks anything key-shaped from a provider's words.

import { call, limited } from './index.js';
import { ApiError } from './util.js';
import { openWith, sealWith, tokenSecret } from './tokens.js';

export const KEY_PROVIDERS = ['anthropic', 'openai', 'gemini', 'kimi'];
const an = (name) => (/^[AEIOU]/.test(name) ? `an ${name}` : `a ${name}`);
const NAMES = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Google Gemini', kimi: 'Moonshot Kimi' };
const SAVES_AN_HOUR = 10; // saves per account per hour (the object counts; the Worker's API_RATE too)
const CHECK_MS = 6000;

// ── shapes ──

const SHAPES = {
  anthropic: /^sk-ant-api\d\d-[A-Za-z0-9_-]{20,200}$/,
  openai: /^sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,300}$/,
  gemini: /^AIza[0-9A-Za-z_-]{35}$/,
  kimi: /^sk-[A-Za-z0-9]{20,200}$/,
};

/** Throws a 400 in plain words when `key` can't be a `provider` key; returns it trimmed. */
export function checkShape(provider, raw) {
  const key = String(raw || '').trim();
  const no = (words) => new ApiError(400, 'bad_key', words);
  const name = NAMES[provider];
  if (/^(?:pk|rk|sk)_(?:live|test)_/.test(key)) return thrown(no('That’s a Stripe key, not a model provider’s API key.'));
  if (/^pk[-_]/i.test(key)) return thrown(no('That looks like a publishable key. Paste the secret API key.'));
  if (/^sk-ant-(?:admin|oat|ort)/.test(key)) return thrown(no('That’s an Anthropic admin or sign-in token. Paste an API key (sk-ant-api…).'));
  if (provider !== 'anthropic' && key.startsWith('sk-ant-')) return thrown(no(`That’s an Anthropic key, not ${an(name)} key.`));
  if (provider !== 'gemini' && key.startsWith('AIza')) return thrown(no(`That’s a Google key, not ${an(name)} key.`));
  if (provider === 'kimi' && /^sk-(?:proj|svcacct|admin)-/.test(key)) return thrown(no('That’s an OpenAI key, not a Moonshot Kimi key.'));
  if (provider === 'openai' && key.startsWith('sk-admin-')) return thrown(no('That’s an OpenAI admin key. Paste a project API key.'));
  if (!SHAPES[provider].test(key)) return thrown(no(`That doesn’t look like ${an(name)} API key.`));
  return key;
}
function thrown(error) {
  throw error;
}

/** `text` with anything key-shaped (and `key` itself) blanked out, at most 200 characters. */
export function scrub(text, key = '') {
  let s = String(text || '');
  if (key && key.length >= 8) s = s.split(key).join('[key]');
  return s
    .replace(/\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{8,}/g, '[key]')
    .replace(/\bAIza[0-9A-Za-z_-]{10,}/g, '[key]')
    .replace(/\*{3,}[A-Za-z0-9]{2,}/g, '[key]')
    .slice(0, 200);
}

// ── the check call (list models: free, no tokens) ──

const CHECKS = {
  openai: (key) => ['https://api.openai.com/v1/models', { authorization: `Bearer ${key}` }],
  kimi: (key) => ['https://api.moonshot.ai/v1/models', { authorization: `Bearer ${key}` }],
  gemini: (key) => ['https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { 'x-goog-api-key': key }], // a header: never the key in a URL
  anthropic: (key) => ['https://api.anthropic.com/v1/models?limit=1', { 'x-api-key': key, 'anthropic-version': '2023-06-01' }],
};

const local = (h) => h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '[::1]';

/** A fake provider base (http on loopback), honoured only when the page itself is on loopback: tests and dev. */
export function fakeProviderBase(env, request) {
  const base = String((env && env.EDEN_FAKE_PROVIDER_BASE) || '').replace(/\/+$/, '');
  if (!base || !request) return null;
  try {
    const target = new URL(base);
    return local(new URL(request.url).hostname) && local(target.hostname) && target.protocol === 'http:' ? base : null;
  } catch {
    return null;
  }
}

/** The provider's URL, or the fake's `<base>/<host>/<path>` in tests and dev. */
export const providerUrl = (base, url) => (base ? url.replace(/^https:\/\/([^/]+)\//, (_, h) => `${base}/${h}/`) : url);

/** { ok, message }: whether the provider takes `key`, in plain words (never the key). */
export async function checkKey(provider, key, { base = null, fetch: f = (u, i) => fetch(u, i) } = {}) {
  const [url, headers] = CHECKS[provider](key);
  let response;
  try {
    response = await f(providerUrl(base, url), { headers, signal: AbortSignal.timeout(CHECK_MS) });
  } catch (error) {
    const late = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return { ok: false, message: late ? `${NAMES[provider]} didn’t answer in time. Try again.` : `Couldn’t reach ${NAMES[provider]}. Try again.` };
  }
  if (response.ok) return { ok: true, message: 'Key works' };
  const body = await response.json().catch(() => null);
  const said = body && (typeof body.error === 'string' ? body.error : body.error && body.error.message) || (body && body.message) || '';
  const lead = response.status === 401 || response.status === 403 ? `${NAMES[provider]} refused this key` : response.status === 429 ? `${NAMES[provider]} says this key is over its limit` : `${NAMES[provider]} answered ${response.status}`;
  const words = scrub(said, key);
  return { ok: false, message: words ? `${lead}: ${words}` : `${lead}.` };
}

// ── the Account object's ops (account.js: `if (op.startsWith('ukeys-')) …`) ──

const recordKey = (provider) => `ukey:${provider}`;
function providerOf(body) {
  if (!KEY_PROVIDERS.includes(body.provider)) throw new ApiError(400, 'bad_request', `provider must be one of ${KEY_PROVIDERS.join(', ')}`);
  return body.provider;
}

export async function userKeysOp(account, op, request) {
  const device = await account.authenticate(request); // grantGuard already refuses a grant's device
  if (device.grant) throw new ApiError(403, 'grant_forbidden', 'API keys stay with the account’s owner.');
  const body = await request.json().catch(() => ({}));
  const json = (v) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });
  switch (op) {
    case 'ukeys-list': {
      const keys = {};
      for (const [k, r] of await account.storage.list({ prefix: 'ukey:' })) keys[k.slice(5)] = { last4: r.last4, added: r.added };
      return json({ keys });
    }
    case 'ukeys-get': {
      const r = await account.storage.get(recordKey(providerOf(body)));
      return json({ record: r ? { iv: r.iv, ct: r.ct } : null });
    }
    case 'ukeys-save': {
      const provider = providerOf(body);
      const now = account.now();
      const saves = ((await account.storage.get('ukeys_saves')) || []).filter((t) => t > now - 3600_000);
      if (saves.length >= SAVES_AN_HOUR) throw new ApiError(429, 'slow_down', 'Too many key changes; wait a while.', { 'retry-after': '600' });
      const r = body.record || {};
      if (typeof r.iv !== 'string' || typeof r.ct !== 'string' || r.ct.length > 4096 || !/^[A-Za-z0-9_-]{4}$/.test(String(body.last4 || ''))) throw new ApiError(400, 'bad_request', 'A sealed record is needed.');
      await account.storage.put('ukeys_saves', [...saves, now]);
      await account.storage.put(recordKey(provider), { v: 1, iv: r.iv, ct: r.ct, last4: body.last4, added: now });
      return json({ saved: true });
    }
    case 'ukeys-delete':
      await account.storage.delete(recordKey(providerOf(body)));
      return json({ deleted: true });
    default:
      throw new ApiError(404, 'not_found', 'No such thing.');
  }
}

// ── the Worker side ──

const aad = (account, provider) => `ukey:${account}:${provider}`;
const own = (who) => who && who.account && who.token && !who.grant;

/**
 * The owner's own key for `provider`, for the multi-provider code's providerKey hook:
 * { key, source: 'user' } or null (none, not the owner's own session, or no secret here).
 */
export async function userKeyFor(env, who, provider) {
  if (!own(who) || !KEY_PROVIDERS.includes(provider) || !tokenSecret(env)) return null;
  try {
    const { record } = await call(env, who.account, 'ukeys-get', { provider }, who.token);
    const opened = record ? await openWith(env, `account:${who.account}`, aad(who.account, provider), record) : null;
    return opened && typeof opened.key === 'string' ? { key: opened.key, source: 'user' } : null;
  } catch {
    return null; // falls back to the service key; never logs (the error could be anything)
  }
}

/** Whether a turn on a key from providerKey() holds and spends the included allowance (only the service's). */
export const billsAllowance = (source) => source !== 'user';

/** GET /api/chat/keys's shape: per provider { set, source: 'account' | null, last4, added }. */
async function status(env, who) {
  const { keys } = await call(env, who.account, 'ukeys-list', {}, who.token);
  const out = {};
  for (const p of KEY_PROVIDERS) {
    const k = keys[p];
    out[p] = k ? { set: true, source: 'account', last4: k.last4, added: k.added } : { set: false, source: null };
  }
  return out;
}

/** GET/POST /api/chat/keys on askeden.com (chat.js, after its gate: signed in, same origin on POST). */
export async function keysApi(request, env, who, { readBody }) {
  if (!own(who)) throw new ApiError(403, 'grant_forbidden', 'API keys stay with the account’s owner.');
  // Without the sealing secret, keys stay where they were: in Eden on the Mac.
  if (!tokenSecret(env)) throw new ApiError(503, 'needs_mac', 'Needs your Mac. API keys stay in Eden on your Mac; on askeden.com, Claude runs on the AI included with your Jarvis account.');
  await limited(env, 'API_RATE', who.account);
  if (request.method === 'GET') return status(env, who);
  const body = await readBody(request, 4096);
  const provider = body.provider;
  if (!KEY_PROVIDERS.includes(provider)) throw new ApiError(400, 'bad_request', `provider must be one of ${KEY_PROVIDERS.join(', ')}`);
  if (typeof body.key !== 'string') throw new ApiError(400, 'bad_request', 'key must be a string ("" removes it)');
  if (!body.key.trim()) {
    await call(env, who.account, 'ukeys-delete', { provider }, who.token);
    return status(env, who);
  }
  const key = checkShape(provider, body.key);
  await limited(env, 'EDEN_RATE', `ukeys:${who.account}`);
  const check = await checkKey(provider, key, { base: fakeProviderBase(env, request) });
  if (!check.ok) throw new ApiError(400, 'key_refused', check.message);
  const record = await sealWith(env, `account:${who.account}`, aad(who.account, provider), { key });
  await call(env, who.account, 'ukeys-save', { provider, record, last4: key.slice(-4) }, who.token);
  return { ...(await status(env, who)), check };
}
