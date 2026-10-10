// Promo codes: free Plus for a while (the owner hands them out). A third source of Plus beside the
// App Store's and Stripe's (stripe-plan.js combinePlans); the included AI doesn't care which paid.
//
// A code is one Durable Object (`Promo`, binding PROMOS), named by the SHA-256 hex of the code
// normalized (promoName), so the code itself is never stored. It holds
//   { days, max_uses, expires (ms) | null, note, created, used: [account id, …] }
// Every check-and-set happens inside the object: two people redeeming the last use can't both win,
// and one account can't use one code twice.
//
//   create  { days, max_uses, expires, note, message } → the code's terms (admin only; the Worker checks)
//   message { message }                        → sets (or clears, with "") the message shown on redeeming
//   redeem  { account_id }                     → { days, message }; 404 bad_code, 410 expired, 409 used_up / already_used
//   release { account_id }                     → gives the use back (the account couldn't take it)
//   view                                       → the terms and how many are used
//
// Minting (mintCodes) and the admin endpoint (promoAdmin, POST /api/admin/promo) live here too:
// the endpoint is closed until the Worker has the secret PROMO_ADMIN_TOKEN.
//
//   POST /api/admin/promo   Authorization: Bearer <PROMO_ADMIN_TOKEN>
//     { count?: 1–500 (1), code?: "your-very-pretty" (a name of your own: count 1; 4–32 letters and digits), days: 1–366, max_uses?: 1–100000 (1), expires_days?: 1–730, note? }
//     → { codes: ["EDEN-XXXX-XXXX", …], days, max_uses, expires }
//   GET  /api/admin/promo?code=EDEN-…   → one code's terms and use count

import { ApiError, json, randomBytes, sha256Hex, validAccountId } from './util.js';

// No 0/O/1/I/L/U: what a person types from a message.
const ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const PROMO = { maxMessage: 600, maxDays: 366, maxCount: 500, maxUses: 100_000, maxExpiryDays: 730, groups: 2, groupSize: 4, customMin: 4, customMax: 32 };
const SHAPE = new RegExp(`^EDEN-[${ALPHABET}]{4}-[${ALPHABET}]{4}$`);

/**
 * A code as people type it (any case, spaces, dashes or not) → its one form, or null: a made code
 * is "EDEN-XXXX-XXXX"; a custom one the owner chose (admin `code`) is its letters and digits,
 * upper case, no dashes ("your-very-pretty" → "YOURVERYPRETTY"), 4–32 of them.
 */
export function cleanPromo(input) {
  const s = String(input || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const made = s.startsWith('EDEN') && s.length === 4 + PROMO.groups * PROMO.groupSize ? s.slice(4) : s; // "EDEN" is optional
  if (made.length === PROMO.groups * PROMO.groupSize) {
    const code = `EDEN-${made.slice(0, 4)}-${made.slice(4)}`;
    if (SHAPE.test(code)) return code;
  }
  return s.length >= PROMO.customMin && s.length <= PROMO.customMax ? s : null;
}

export const promoName = (code) => sha256Hex(`promo-v1:${code}`);
const promoStub = async (env, code) => env.PROMOS.get(env.PROMOS.idFromName(await promoName(code)));

function newCode() {
  const bytes = randomBytes(PROMO.groups * PROMO.groupSize);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join(''); // 30 symbols: the bias is under 1%, and a code is 40 bits either way
  return `EDEN-${chars.slice(0, 4)}-${chars.slice(4)}`;
}

async function callPromo(env, code, op, body = {}) {
  const response = await (await promoStub(env, code)).fetch(`https://promo/${op}`, { method: 'POST', body: JSON.stringify(body) });
  const out = await response.json().catch(() => ({}));
  if (response.status >= 400) throw new ApiError(response.status, out.code || 'error', out.error || 'Something went wrong.', {}, {});
  return out;
}

/** A message shown to whoever redeems a code: text only, trimmed, at most PROMO.maxMessage characters; null for none. */
const cleanMessage = (m) => (typeof m === 'string' && m.trim() ? m.trim().slice(0, PROMO.maxMessage) : null);

export class Promo {
  constructor(ctx) {
    this.storage = ctx.storage;
    this.now = () => Date.now();
  }

  async fetch(request) {
    const op = new URL(request.url).pathname.slice(1);
    const body = await request.json().catch(() => ({}));
    try {
      const record = (await this.storage.get('promo')) || null;
      if (op === 'create') {
        if (record) throw new ApiError(409, 'exists', 'That code already exists.');
        const terms = {
          days: body.days,
          max_uses: body.max_uses,
          expires: body.expires || null,
          note: String(body.note || '').slice(0, 120),
          message: cleanMessage(body.message),
          created: this.now(),
          used: [],
        };
        await this.storage.put('promo', terms);
        return json(this.view(terms));
      }
      if (!record) throw new ApiError(404, 'bad_code', 'That code isn’t valid. Check it and try again.');
      if (op === 'view') return json(this.view(record));
      if (op === 'message') {
        await this.storage.put('promo', { ...record, message: cleanMessage(body.message) });
        return json({ has_message: Boolean(cleanMessage(body.message)) });
      }
      if (op === 'redeem') {
        if (!validAccountId(body.account_id)) throw new ApiError(400, 'bad_request', 'account_id must be an account id');
        if (record.expires && record.expires <= this.now()) throw new ApiError(410, 'code_expired', 'That code has expired.');
        if (record.used.includes(body.account_id)) throw new ApiError(409, 'already_used', 'You’ve already used that code.');
        if (record.used.length >= record.max_uses) throw new ApiError(409, 'used_up', 'That code has been used up.');
        record.used.push(body.account_id);
        await this.storage.put('promo', record);
        return json({ days: record.days, message: record.message || null });
      }
      if (op === 'release') {
        const used = record.used.filter((a) => a !== body.account_id);
        if (used.length !== record.used.length) await this.storage.put('promo', { ...record, used });
        return json({});
      }
      throw new ApiError(404, 'not_found', 'No such thing.');
    } catch (error) {
      if (error instanceof ApiError) return error.response();
      throw error;
    }
  }

  view(r) {
    return { has_message: Boolean(r.message), days: r.days, max_uses: r.max_uses, used: r.used.length, expires: r.expires, note: r.note, created: r.created };
  }
}

/** Mint `count` new codes with the same terms. Returns the codes (the only time they're seen whole). */
export async function mintCodes(env, { count, days, max_uses, expires, note, message }) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    for (let tries = 0; ; tries++) {
      const code = newCode();
      try {
        await callPromo(env, code, 'create', { days, max_uses, expires, note, message });
        codes.push(code);
        break;
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== 'exists' || tries > 5) throw error;
      }
    }
  }
  return codes;
}

/** Take one use of a code for an account: its days. The caller gives it back (releasePromo) if the account can't take it. */
export const takePromo = (env, code, accountId) => callPromo(env, code, 'redeem', { account_id: accountId });
export const releasePromo = (env, code, accountId) => callPromo(env, code, 'release', { account_id: accountId }).catch(() => {});

const MAX_KEPT = 50;

/**
 * The account's side (account.js op `promo-grant`): add a code's days to the free Plus, once per
 * code. Days stack: they start when the current promo Plus ends, or now. `id` is the code's
 * name (a hash), so redeeming again changes nothing.
 */
export async function grantPromo(account, { id, days }) {
  if (!/^[0-9a-f]{64}$/.test(String(id || ''))) throw new ApiError(400, 'bad_request', 'No code id.');
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > PROMO.maxDays) throw new ApiError(400, 'bad_request', 'Bad days.');
  const now = account.now();
  const have = (await account.storage.get('promo_plan')) || { until: 0, codes: [] };
  if (have.codes.some((c) => c.id === id)) return { already: true, until: have.until };
  const until = Math.max(now, have.until || 0) + n * 86400_000;
  const next = { until, codes: [...have.codes, { id, days: n, at: now }].slice(-MAX_KEPT) };
  await account.storage.put('promo_plan', next);
  return { already: false, until };
}

/**
 * Redeem `input` for the signed-in account `who` ({ account, token }): one use is taken from the
 * code, then the account gets the days; if the account can't take them the use is given back.
 * → { days, until }.
 */
export async function redeemPromo(env, who, input, call) {
  const code = cleanPromo(input);
  if (!code) throw new ApiError(400, 'bad_code', 'That doesn’t look like a code. They look like EDEN-ABCD-2345.');
  if (!env.PROMOS) throw new ApiError(503, 'not_set_up', 'Promo codes aren’t set up here yet.');
  const { days, message } = await takePromo(env, code, who.account);
  try {
    const { until } = await call(env, who.account, 'promo-grant', { id: await promoName(code), days }, who.token);
    return { days, until, message: message || null };
  } catch (error) {
    await releasePromo(env, code, who.account);
    throw error;
  }
}

// Constant-time string compare, for the admin token.
function same(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

const whole = (v, min, max, fallback) => {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : NaN;
};

/** POST/GET /api/admin/promo (worker.js routes it before any Origin or session rule: it's a server's call). */
export async function promoAdmin(request, env) {
  try {
    const secret = String(env.PROMO_ADMIN_TOKEN || '');
    if (secret.length < 24 || !env.PROMOS) throw new ApiError(503, 'not_set_up', 'Promo codes aren’t set up here yet.');
    if (request.headers.get('origin')) throw new ApiError(403, 'forbidden', 'Not from a web page.');
    const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
    if (!bearer || !same(bearer[1], secret)) throw new ApiError(401, 'unauthorized', 'No.');
    if (request.method === 'GET') {
      const code = cleanPromo(new URL(request.url).searchParams.get('code'));
      if (!code) throw new ApiError(400, 'bad_request', 'code is EDEN-XXXX-XXXX.');
      return json(await callPromo(env, code, 'view'));
    }
    if (request.method !== 'POST') throw new ApiError(405, 'method', 'GET or POST.');
    const body = await request.json().catch(() => ({}));
    if (body.update === true) { // change an existing code's message: { update: true, code, message }
      const existing = cleanPromo(body.code);
      if (!existing) throw new ApiError(400, 'bad_request', 'code is the code to change.');
      return json(await callPromo(env, existing, 'message', { message: body.message }));
    }
    const count = whole(body.count, 1, PROMO.maxCount, 1);
    const days = whole(body.days, 1, PROMO.maxDays, NaN);
    let custom = null;
    if (body.code !== undefined && body.code !== null && body.code !== '') {
      custom = cleanPromo(body.code);
      // A name that reads as a made code ("EDEN-ABCD-2345") would be confused with one.
      if (!custom || SHAPE.test(custom) || count !== 1 || /^(EDEN)?[A-Z2-9]{8}$/.test(custom)) throw new ApiError(400, 'bad_request', `code is ${PROMO.customMin}–${PROMO.customMax} letters and digits, one at a time, and not EDEN-XXXX-XXXX.`);
    }
    const maxUses = whole(body.max_uses, 1, PROMO.maxUses, 1);
    const expiresDays = whole(body.expires_days, 1, PROMO.maxExpiryDays, null);
    if ([count, days, maxUses, expiresDays].some(Number.isNaN)) {
      throw new ApiError(400, 'bad_request', `days is 1–${PROMO.maxDays}; count 1–${PROMO.maxCount}; max_uses 1–${PROMO.maxUses}; expires_days 1–${PROMO.maxExpiryDays}.`);
    }
    const expires = expiresDays ? Date.now() + expiresDays * 86400_000 : null;
    if (custom) {
      await callPromo(env, custom, 'create', { days, max_uses: maxUses, expires, note: body.note, message: body.message }); // 409 exists
      return json({ codes: [custom], days, max_uses: maxUses, expires }, 201);
    }
    const codes = await mintCodes(env, { count, days, max_uses: maxUses, expires, note: body.note, message: body.message });
    return json({ codes, days, max_uses: maxUses, expires }, 201);
  } catch (error) {
    if (error instanceof ApiError) return error.response();
    throw error;
  }
}
