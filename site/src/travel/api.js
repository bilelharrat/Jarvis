// Eden Travel's routes, signed in (eden/chat.js hands /api/chat/travel… here). Off unless the
// Worker has EDEN_TRAVEL = "1", so nothing shows on askeden.com, or in the iPhone app that
// shows it, until the owner switches it on (the web page also keeps it behind !IN_APP).
//
//   GET  /api/chat/travel            → trip-list
//   GET  /api/chat/travel?id=<id>    → trip-get
//   POST /api/chat/travel { action, args }
//     action: create, sample, update, delete, edit, propose, apply, discard, undo, places, mark-booked, unbook, cards, cards-match, cards-save, flight
// Each action is the account object's `trip-<action>` (travel/ops.js).

import { ApiError, json } from '../accounts/util.js';

const ACTIONS = new Set(['create', 'sample', 'update', 'delete', 'edit', 'propose', 'apply', 'discard', 'undo', 'places', 'mark-booked', 'unbook', 'cards', 'cards-match', 'cards-save', 'flight']);

export const travelOn = (env) => String(env?.EDEN_TRAVEL || '') === '1';

export async function travelApi(request, env, who, path, { call, limited, readBody }) {
  if (!travelOn(env) || path !== '/api/chat/travel') throw new ApiError(404, 'not_found', 'Not found');
  await limited(env, 'API_RATE', who.account);
  if (request.method === 'GET') {
    const id = new URL(request.url).searchParams.get('id');
    return json(await call(env, who.account, id ? 'trip-get' : 'trip-list', id ? { id } : {}, who.token));
  }
  if (request.method !== 'POST') throw new ApiError(405, 'bad_request', 'GET or POST');
  const body = await readBody(request, 256 * 1024);
  if (!ACTIONS.has(body.action)) throw new ApiError(400, 'bad_request', `action must be one of ${[...ACTIONS].join(', ')}.`);
  const args = body.args !== null && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
  // A Google or FlightAware lookup (each billed): held to the turn rate, like a chat message.
  if (body.action === 'places' || body.action === 'flight') await limited(env, 'EDEN_RATE', `turn:${who.account}`);
  return json(await call(env, who.account, `trip-${body.action}`, args, who.token));
}
