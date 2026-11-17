// What the Gemma claim judge (gemma-judge.js, gemma-text.js; Modal A100) may cost, and when a turn may wake it
// (askeden docs/spend-guard.md: the biggest possible recurring leak was shadow turns waking a cold GPU for no verdict).
//
//   GEMMA_SHADOW_WAKE   off (default) | on
//       off   a shadow turn (logging only: its verdict is never used) runs only on a judge that is already warm: it
//             never sends a warm-up ping and never wakes a cold judge, so it never starts a GPU on its own
//       on    as before 2026-11-10: a shadow turn on a cold judge sends the warm-up ping
// Owner turns (GEMMA_JUDGE_MODE / GEMMA_TEXT_MODE = owner, an owner account) are unchanged: they ping as before.
// Nothing here touches EVES's answer: shadow verdicts are only logged, and owner turns behave as they did.
//
// Modal's GPU time also goes on the company spend counter (spend-counter.js, CREDIT_PACER warn/on), as an estimate:
// a call's time, and a ping that found the judge cold counted as a whole warm window. SPEND_CAP_MODAL_USD (with
// CREDIT_PACER=on) stops shadow turns for the rest of the (Pacific) day once that much is spent; owner turns go on.

import { meterProvider, modalCostUSD, providerFull } from './spend-counter.js';

/** May a shadow (logging-only) turn wake a cold judge? Only with GEMMA_SHADOW_WAKE=on. */
export const shadowMayWake = (env) => String((env && env.GEMMA_SHADOW_WAKE) ?? '').trim().toLowerCase() === 'on';

/** May this turn ping (and so wake) the judge? Owner turns always; shadow turns only with GEMMA_SHADOW_WAKE=on. */
export const mayWake = (env, live) => Boolean(live) || shadowMayWake(env);

/** A ping that took this long found the judge cold and started it (a warm /health answers in well under a second). */
export const COLD_PING_MS = 10_000;

/** Counts one judge call's GPU time (estimate). Never throws. */
export function meterJudge(env, ctx, { ms = 0, woke = false, paid = false, feature = 'gemma' } = {}) {
  try {
    const usd = modalCostUSD({ ms, woke });
    if (usd > 0) meterProvider(env, ctx, { provider: 'modal', usd, paid, feature });
  } catch {
    // counting never breaks a turn
  }
}

/** Is today's unpaid Modal spend at SPEND_CAP_MODAL_USD (CREDIT_PACER=on only)? Shadow turns stop then. Never throws. */
export async function shadowCapped(env) {
  try {
    return (await providerFull(env, 'modal')).full;
  } catch {
    return false;
  }
}
