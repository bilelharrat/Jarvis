// DeepInfra privacy turns (chat.js deepInfraPrivateTurn): metered, and once the owner turns it on, capped and charged to
// the account like every other provider's turn (askeden docs/spend-guard.md: they sent no max_tokens, cost the
// account $0 and any signed-in account could use them).
//
//   DEEPINFRA_METERED   on (default) | off
//       on    the request asks DeepInfra for its usage (stream_options.include_usage: one more SSE chunk, no text); the
//             turn's real cost is logged ("deepinfra_usage": model, tokens, dollars; never any text) and put on the
//             company spend counter (spend-counter.js, CREDIT_PACER warn/on), as unpaid while nobody is charged
//   DEEPINFRA_CHARGE    off (default) | on
//       on    the plan gate the other providers' turns use: allow-ai (through the credit pacer, so an unpaid account is
//             paced as a chat turn is), SPEND_CAP_DEEPINFRA_USD for unpaid use, a hold of the worst case, a max_tokens
//             that fits the allowance, and the real cost charged with Account.spend (released hold), shown on the
//             reply's usage line instead of the old "$0, notional"
//   DEEPINFRA_MAX_TOKENS  off (default) | on: send the max_tokens below even while nothing is charged
// With both off (the default) the turn is the same as before 2026-11-10 but for the usage chunk DeepInfra adds.
//
// max_tokens, like the other lanes (chat.js fitCall): the model's own output limit, never past its context window less
// the conversation (estimated at CHARS_PER_TOKEN, on the high side), never past EDEN_MAX_TOKENS, and when charging,
// never past what the allowance can pay.

import { ApiError } from '../accounts/util.js';
import { allowPaid } from './credit-pacer.js';
import { SPEND_COPY, meterProvider, providerCapCheck } from './spend-counter.js';

const on = (v, fallback) => {
  const s = String(v ?? '').trim().toLowerCase();
  return s ? s === 'on' || s === '1' || s === 'true' : fallback;
};
export const deepInfraMetered = (env) => on(env && env.DEEPINFRA_METERED, true);
export const deepInfraCharged = (env) => on(env && env.DEEPINFRA_CHARGE, false);
export const deepInfraCapped = (env) => deepInfraCharged(env) || on(env && env.DEEPINFRA_MAX_TOKENS, false);

/**
 * DeepInfra list prices per million tokens, dated (a row applies from its day on), and each model's limits. Read
 * 2026-11-10 from deepinfra.com/pricing where listed, else set on the high side: the cost DeepInfra itself reports with
 * the usage (`estimated_cost`) is used whenever it comes, so these are only the fallback and the hold's worst case.
 */
export const DEEPINFRA_MODELS = Object.freeze({
  'google/gemma-4-31B-it': Object.freeze({ context: 131_072, output: 16_384, prices: Object.freeze([{ from: '2026-01-01', input: 0.15, output: 0.4 }]) }),
  'Qwen/Qwen2.5-Coder-32B-Instruct': Object.freeze({ context: 32_768, output: 8_192, prices: Object.freeze([{ from: '2025-01-01', input: 0.07, output: 0.16 }]) }),
  'deepseek-ai/DeepSeek-R1': Object.freeze({ context: 163_840, output: 32_768, prices: Object.freeze([{ from: '2025-01-01', input: 0.7, output: 2.4 }]) }),
  'meta-llama/Meta-Llama-3.1-70B-Instruct': Object.freeze({ context: 131_072, output: 16_384, prices: Object.freeze([{ from: '2025-01-01', input: 0.35, output: 0.4 }]) }),
});
const UNKNOWN = Object.freeze({ context: 32_768, output: 8_192, prices: Object.freeze([{ from: '2000-01-01', input: 1, output: 3 }]) });
export const CHARS_PER_TOKEN = 3; // as providers.js: more tokens than there are, so a hold is never short
const MARGIN = 256; // tokens left free in the context window
const MIN_REPLY = 512; // fewer than this: not a reply worth starting (providers.js fitCall's minReply)
export const DEEPINFRA_FALLBACK_USD = 0.002; // a turn whose size can't be told at all

const round6 = (x) => Math.round(x * 1e6) / 1e6;
const num0 = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : 0);
const dayOf = (at) => new Date(at).toISOString().slice(0, 10);

export const modelInfo = (model) => DEEPINFRA_MODELS[model] || UNKNOWN;
/** [input, output] per million tokens for a model on `at`'s day. */
export function pricesOn(model, at = Date.now()) {
  const rows = modelInfo(model).prices;
  const day = dayOf(at);
  const row = rows.reduce((best, r) => (day >= r.from ? r : best), rows[0]);
  return [row.input, row.output];
}

/** The conversation's input tokens, estimated on the high side (characters ÷ 3, plus a little for each message). */
export const inputEstimate = (messages) => (Array.isArray(messages) ? messages : []).reduce((n, m) => n + Math.ceil(String((m && m.content) || '').length / CHARS_PER_TOKEN) + 8, 0);

/**
 * A turn's cost: DeepInfra's own `estimated_cost` when it reports one, else its token counts at the table's price, else
 * (a stream cut before the usage) the text seen at CHARS_PER_TOKEN. Never negative.
 */
export function deepInfraCostUSD(model, usage, { inputTokens = 0, outputChars = 0, at = Date.now() } = {}) {
  const u = usage && typeof usage === 'object' ? usage : null;
  if (u && Number.isFinite(Number(u.estimated_cost)) && Number(u.estimated_cost) >= 0 && u.estimated_cost !== null) return round6(Number(u.estimated_cost));
  const [pin, pout] = pricesOn(model, at);
  if (u && (num0(u.prompt_tokens) || num0(u.completion_tokens))) return round6((num0(u.prompt_tokens) * pin + num0(u.completion_tokens) * pout) / 1e6);
  if (num0(inputTokens) || num0(outputChars)) return round6((num0(inputTokens) * pin + Math.ceil(num0(outputChars) / CHARS_PER_TOKEN) * pout) / 1e6);
  return 0;
}

/**
 * The max_tokens to send, or null when not even a short reply fits: the model's output limit, its context less the
 * input, `maxTokens` (EDEN_MAX_TOKENS), and with `leftUSD` what that money pays for after the input.
 */
export function maxTokensFor(model, inputTokens, { maxTokens = Infinity, leftUSD = Infinity, at = Date.now() } = {}) {
  const info = modelInfo(model);
  let cap = Math.min(info.output, info.context - num0(inputTokens) - MARGIN, Number(maxTokens) > 0 ? Number(maxTokens) : Infinity);
  if (Number.isFinite(leftUSD)) {
    const [pin, pout] = pricesOn(model, at);
    cap = Math.min(cap, Math.floor(((leftUSD - (num0(inputTokens) * pin) / 1e6) * 1e6) / pout));
  }
  return cap >= MIN_REPLY ? Math.floor(cap) : null;
}

/** The most a turn may cost: the input plus max_tokens of output, at the table's price. */
export function worstUSD(model, inputTokens, maxTokens, at = Date.now()) {
  const [pin, pout] = pricesOn(model, at);
  return round6((num0(inputTokens) * pin + num0(maxTokens) * pout) / 1e6);
}

/**
 * DEEPINFRA_CHARGE=on: the gate before the turn, as the other providers' turns have it. `call`: the accounts call (chat.js
 * pacerCall(env, accountCall), so an unpaid account is paced). → { allow, hold, maxTokens, paid }; throws the ApiError
 * the page shows (402 no_allowance; 413 too_long).
 */
export async function deepInfraGate(env, who, { call, model, messages, maxTokens = Infinity, at = Date.now() }) {
  const allow = await call(env, who.account, 'allow-ai', { eden: true }, who.token);
  if (!allow || !allow.ok) throw new ApiError(402, 'no_allowance', (allow && allow.why) || 'Your included AI is used up for this month.');
  const paid = allowPaid(allow);
  await providerCapCheck(env, 'deepinfra', { paid, copy: SPEND_COPY.privacy });
  const input = inputEstimate(messages);
  if (!maxTokensFor(model, input, { maxTokens, at })) throw new ApiError(413, 'too_long', 'This private chat is longer than the model can read. Start a new chat.');
  const room = maxTokensFor(model, input, { maxTokens, leftUSD: Number(allow.left), at });
  if (!room) throw new ApiError(402, 'no_allowance', 'Not enough of your included AI is left for this private chat. Start a new chat, or wait for the allowance to renew.');
  const hold = await call(env, who.account, 'hold-ai', { eden: true, usd: worstUSD(model, input, room, at) }, who.token);
  if (!hold || !hold.ok) throw new ApiError(402, 'no_allowance', (hold && hold.why) || 'Not enough of your included AI is left for this private chat.');
  return { allow, hold, maxTokens: room, paid: paid || allowPaid(hold), input };
}

/**
 * After the turn (in its `finally`): logs the cost (DEEPINFRA_METERED), counts it on the company counter, and with a
 * gate charges it to the account and releases the hold. Never throws; `ctx.waitUntil` keeps the work alive.
 * → the cost in dollars (0 when not metered).
 */
export function deepInfraSettle(env, ctx, who, { call, model, usage, inputTokens = 0, outputChars = 0, gate = null, at = Date.now() }) {
  try {
    if (!deepInfraMetered(env) && !gate) return 0;
    let usd = deepInfraCostUSD(model, usage, { inputTokens, outputChars, at });
    if (!(usd > 0) && gate && (num0(inputTokens) || num0(outputChars))) usd = DEEPINFRA_FALLBACK_USD;
    try {
      console.log(JSON.stringify({ evt: 'deepinfra_usage', model, input_tokens: num0(usage && usage.prompt_tokens) || null, output_tokens: num0(usage && usage.completion_tokens) || null, usd, reported: Boolean(usage && usage.estimated_cost !== undefined), charged: Boolean(gate) }));
    } catch {
      // never
    }
    if (usd > 0) meterProvider(env, ctx, { provider: 'deepinfra', model, usd, paid: gate ? gate.paid : false, feature: 'privacy' });
    if (gate) {
      const bucket = gate.hold.bucket || gate.allow.bucket;
      const work = (async () => {
        if (usd > 0) await call(env, who.account, 'spend', { usd, bucket, meta: { feature: 'privacy', model } }).catch((error) => console.error('spend failed', error && error.message));
        await call(env, who.account, 'release-ai', { hold: gate.hold.hold }).catch(() => {});
      })();
      if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(work);
    }
    return usd;
  } catch {
    return 0;
  }
}
