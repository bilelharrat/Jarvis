// Dated list prices for the models whose price changes on a known day (askeden docs/spend-guard.md, gcp-credit-plan-b.md).
//
// The billing registry (vendor/model-router.js, generated from the askeden repo) has one price per model. Google raises
// two of them: Gemini 4 Argon to $4 / $20 per million tokens from 2026-12-01 (Pacific), Gemini 3.8 Flash to $1.50 /
// $7.50 from 2027-01-01. This table is the one place those dates live on askeden.com:
//   - charging (providers.js usageUSD and fitCall, accounts/proxy.js priceOf, travel/planner.js): a call is priced on
//     its own (Pacific) day, so Account.spend takes what that day's call cost; until a date comes, nothing changes
//   - the company counter (credit-pacer.js): priced from the tokens on the call's day; a path's dollars-only cost is
//     scaled only if it was priced at another price than the call's day's (see chargePriceOn)
// Model choice never reads this (ratesOf, the router and EVES see the registry as it is), so no pick changes.
//
//   DATED_PRICES   on (default) | off   off: charging uses the registry's one price, as before 2026-11-10
//
// `cached`: a cached input token's share of the input price as Google bills it (the counter's real cost). Charging keeps
// the registry's own share (vendor/providers.js usageCost: 10% for every provider but OpenAI), so only the input and
// output prices change there.

import { MODELS } from './vendor/model-router.js';

export const DATED_PRICES = Object.freeze({
  'gemini-4-argon': Object.freeze([
    Object.freeze({ from: '2000-01-01', input: 2, output: 10, cached: 0.05 }),
    Object.freeze({ from: '2026-12-01', input: 4, output: 20, cached: 0.05 }),
  ]),
  'gemini-3.8-flash': Object.freeze([
    Object.freeze({ from: '2000-01-01', input: 0.75, output: 3.75, cached: 0.1 }),
    Object.freeze({ from: '2027-01-01', input: 1.5, output: 7.5, cached: 0.1 }),
  ]),
});

const DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
/** YYYY-MM-DD on the Pacific clock (Google's billing day). */
export const pricingDay = (at = Date.now()) => DAY.format(new Date(at));

const idOf = (model) => String((model && typeof model === 'object' ? model.id : model) || '').replace(/^models\//, '');

/** The dated price row for a model on a Pacific day (YYYY-MM-DD), or null for a model without dated prices. */
export function priceOn(model, day) {
  const rows = DATED_PRICES[idOf(model)];
  if (!rows) return null;
  let row = rows[0];
  for (const r of rows) if (day >= r.from) row = r;
  return row;
}

// Charging by date: on unless DATED_PRICES = "off" (worker.js sets it from env on each request; tests may too)
let dated = true;
/** Reads DATED_PRICES from the Worker's env (anything but "off": on). */
export function configureDatedPrices(env) {
  dated = String((env && env.DATED_PRICES) ?? '').trim().toLowerCase() !== 'off';
  return dated;
}
export const datedCharging = () => dated;

/**
 * The model as charging prices it at `at`: the same object when it has no dated price (or DATED_PRICES is off), else a
 * copy whose pricing has that day's input and output (long-context rates, if any, untouched).
 */
export function datedModel(model, at = Date.now()) {
  if (!model || !model.pricing || !priceOn(model, '2000-01-01')) return model;
  // `pricedOn` tells the vendored cost code (askeden src/dated-prices.ts pricingOn) this price is already the day's (or the
  // registry's, with DATED_PRICES=off): never dated again there, on UTC "now" (2026-11-10)
  if (!dated) return { ...model, pricedOn: 'off' };
  const day = pricingDay(at);
  const row = priceOn(model, day);
  if (row.input === model.pricing.inputPer1M && row.output === model.pricing.outputPer1M) {
    // the same object while the vendored code would reach the same price (its UTC day is Google's Pacific day)
    return new Date(at).toISOString().slice(0, 10) === day ? model : { ...model, pricedOn: day };
  }
  return { ...model, pricedOn: day, pricing: { ...model.pricing, inputPer1M: row.input, outputPer1M: row.output } };
}

/** [input, output] per million for a model id at `at`: the dated price when there is one (and charging is dated), else `fallback`. */
export function datedPair(id, fallback, at = Date.now()) {
  const row = dated ? priceOn(id, pricingDay(at)) : null;
  return row ? [row.input, row.output] : fallback;
}

/**
 * How much more a cost priced at `pricedOutput` (a path's own output price per million, e.g. a vendored table's) costs on
 * `at`'s day: that day's output price over it, or 1 (no dated price, charging not dated, or nothing to compare). Both
 * dated rises are the same factor on input and output, so one ratio scales a whole estimate.
 */
export function datedScale(id, pricedOutput, at = Date.now()) {
  const row = dated ? priceOn(id, pricingDay(at)) : null;
  const p = Number(pricedOutput);
  return row && p > 0 ? row.output / p : 1;
}

/** The registry's own (undated) input price for a model, or null. */
export function registryInput(id) {
  try {
    const m = MODELS.find((x) => x.id === idOf(id));
    const p = Number(m && m.pricing && m.pricing.inputPer1M);
    return p > 0 ? p : null;
  } catch {
    return null;
  }
}

/** The input price a charging path priced a call of `id` at on `at`'s day: the dated one when charging is dated, else the registry's. */
export function chargePriceOn(id, at = Date.now()) {
  const row = dated ? priceOn(id, pricingDay(at)) : null;
  return row ? row.input : registryInput(id);
}
