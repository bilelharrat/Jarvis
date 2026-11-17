// EVES for the Creative Suite (docs/creative-api.md §6), as askeden.com has it. This is main's: askeden.com's main branch
// runs no EVES on its own servers, for any plan (eden/chat.js meta `eves: false`; the page hides its switch), so the
// suite says so plainly. The live site runs hosted EVES (eden/eves.js): there scripts/creative-overlay/eves-live.js
// takes this file's place (scripts/deploy-creative-overlay.sh), with the same exports.
//
//   EVES_HERE              whether askeden.com runs EVES here
//   evesStatus(env, req)   GET /api/creative/me's `eves`: { available, why? }
//   creativeEves(…)        POST /api/creative/eves once the token is checked (api.js)

import { ApiError } from '../accounts/util.js';

export const EVES_HERE = false;
export const EVES_OFF = 'EVES isn’t on askeden.com yet, on any plan. Eden still answers; check names and facts yourself for now.';

export async function evesStatus() {
  return { available: false, why: EVES_OFF };
}

/** Said plainly before the body is read: 503 not_set_up, the app keeps EVES off (as /me's `eves` already said). */
export async function creativeEves() {
  throw new ApiError(503, 'not_set_up', EVES_OFF);
}
