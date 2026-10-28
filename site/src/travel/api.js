// Eden Travel's routes, signed in (eden/chat.js hands /api/chat/travel… here). Off unless the
// Worker has EDEN_TRAVEL = "1", so nothing shows on askeden.com, or in the iPhone app that
// shows it, until the owner switches it on (the web page also keeps it behind !IN_APP).
//
//   GET  /api/chat/travel            → trip-list
//   GET  /api/chat/travel?id=<id>    → trip-get
//   GET  /api/chat/travel/map?a=lat,lng&b=lat,lng → the in-flight map's picture (maps.js flightMapImage)
//   GET  /api/chat/travel/photo?n=places/…/photos/…&w=240 → a stop's Google photo (maps.js placePhoto)
//   GET  /api/chat/travel/hero?q=<destination> → trip-hero: the destination's licensed Wikimedia Commons photo (hero.js)
//   GET  /api/chat/travel/hero-image?u=<upload.wikimedia.org/wikipedia/commons/thumb/… url> → that picture (hero.js heroImage)
//   POST /api/chat/travel { action, args }
//     pay-start, pay-complete, pay-status, pay-latest: a booking paid with the traveller's card first (pay.js)
//     calfeed, calfeed-create, calfeed-revoke, gcal-calendars, gcal-status, gcal-sync, gcal-off: the trips in the traveller's calendar (calsync.js)
//     action: create, sample, update, delete, edit, propose, apply, discard, undo, places, mark-booked, unbook, cards, cards-match, cards-save, flight, flight-live, mail-scan, mail-preview, mail-import, share-create, shares, share-revoke, link-create, links, link-revoke, stays-search, stays-rates, stays-quote, stays-book, stays-cancel, ground-search, ground-stations, weather, entry, rail-check, rail-book
//   GET  /api/chat/travel/calendar?id=<id>  → the trip as a calendar file (ics.js)
//   GET  /api/chat/travel/doc?id=<trip>&doc=<doc> → a stop's document (inbox.js); POST ?doc=1 { action: 'doc-add' } takes up to 15 MB
//     and: paste, inbox-address, inbox-reset, inbox-drop, docs, doc-delete (inbox.js) · discover, nearby (discover.js)
//     · money, expense-add, expense-delete, people, chat, chat-post, decisions (money.js) · optimize, windows (plan.js)
// Each action is the account object's `trip-<action>` (travel/ops.js).

import { ApiError, json } from '../accounts/util.js';
import { MapsError, flightMapImage, placePhoto } from './maps.js';
import { tripToIcs } from './ics.js';
import { HeroError, heroImage } from './hero.js';
import { memberApi } from './members.js';
import { memoryPhotoRoute } from './memories.js';
import { togetherApi } from './together.js';
import { ask } from './track.js';
import { globalMeter } from './spend.js';
import { companionsApi } from './companions.js';

const ACTIONS = new Set(['create', 'sample', 'update', 'delete', 'edit', 'propose', 'apply', 'discard', 'undo', 'places', 'mark-booked', 'unbook', 'cards', 'cards-match', 'cards-save', 'flight', 'flight-live', 'mail-scan', 'mail-preview', 'mail-import', 'share-create', 'shares', 'share-revoke', 'link-create', 'links', 'link-revoke', 'stays-search', 'stays-rates', 'stays-quote', 'stays-book', 'stays-cancel', 'ground-search', 'ground-stations', 'weather', 'entry', 'rail-check', 'rail-book', 'pay-start', 'pay-complete', 'pay-status', 'pay-latest', 'calfeed', 'calfeed-create', 'calfeed-revoke', 'gcal-calendars', 'gcal-status', 'gcal-sync', 'gcal-off', 'invite-create', 'members', 'member-remove', 'invite-revoke', 'paste', 'inbox-address', 'inbox-reset', 'inbox-drop', 'doc-add', 'docs', 'doc-delete', 'discover', 'nearby', 'money', 'expense-add', 'expense-delete', 'people', 'chat', 'chat-post', 'decisions', 'optimize', 'windows', 'activities', 'photo-add', 'photos', 'photo-get', 'photo-edit', 'photo-delete', 'memories', 'memories-share', 'fwatch-on', 'fwatch-off', 'presence-beat', 'copy', 'check-report', 'check-reports', 'check-unreport', 'mailwatch-on', 'mailwatch-off', 'mailwatch-status', 'mailwatch-drop', 'mail-found', 'loyalty', 'loyalty-save', 'loyalty-delete', 'live-token', 'live-end', 'promise', 'promise-settings', 'promise-rebook', 'promise-rebook-status', 'rewards', 'rewards-redeem', 'rewards-undo', 'esim', 'esim-check', 'esims', 'card-perk', 'year', 'plus-covers', 'joined-alerts', 'claims', 'claim-letter']);
// a member's actions on a trip shared with them (members.js memberApi): the organiser's object is asked, not theirs
const MEMBER_ACTIONS = new Set(['join', 'shared-list', 'shared-get', 'shared-propose', 'shared-leave', 'shared-money', 'shared-expense-add', 'shared-expense-delete', 'shared-chat', 'shared-chat-post', 'shared-decisions', 'shared-memories', 'shared-photo-add', 'shared-photo-delete', 'shared-discover', 'shared-nearby']);

export const travelOn = (env) => String(env?.EDEN_TRAVEL || '') === '1';

export async function travelApi(request, env, who, path, { call, limited, readBody, local = false, ...deps }) {
  if (!travelOn(env) || !['/api/chat/travel', '/api/chat/travel/map', '/api/chat/travel/photo', '/api/chat/travel/hero', '/api/chat/travel/hero-image', '/api/chat/travel/calendar', '/api/chat/travel/doc', '/api/chat/travel/memory-photo'].includes(path)) throw new ApiError(404, 'not_found', 'Not found');
  await limited(env, 'API_RATE', who.account);
  // the in-flight map's picture (maps.js): a Google Static Map fetched with the server's key
  if (path === '/api/chat/travel/map' || path === '/api/chat/travel/photo') {
    if (request.method !== 'GET') throw new ApiError(405, 'bad_request', 'GET');
    // pictures on Eden's Google key: for Eden Travel's members only (the list answers plus: false without Plus)
    if ((await call(env, who.account, 'trip-list', {}, who.token)).plus === false) throw new ApiError(402, 'plus_required', 'Eden Travel is part of Eden Plus.');
    try { return await (path === '/api/chat/travel/map' ? flightMapImage : placePhoto)(env, new URL(request.url), { fetch: deps.fetch, meter: globalMeter(env) }); } catch (e) { if (e instanceof MapsError) throw new ApiError(e.code === 'bad_request' ? 400 : e.code === 'not_set_up' ? 404 : e.code === 'capped' ? 503 : 502, e.code, e.message); throw e; }
  }
  // the destination's hero photo (hero.js): Plus-gated as the photos are (trip-hero is a trip op, so the account refuses it
  // without Plus); the picture only from Commons' thumbnail server
  if (path === '/api/chat/travel/hero' || path === '/api/chat/travel/hero-image') {
    if (request.method !== 'GET') throw new ApiError(405, 'bad_request', 'GET');
    const url = new URL(request.url);
    if (path === '/api/chat/travel/hero') return json(await call(env, who.account, 'trip-hero', { q: url.searchParams.get('q') || '' }, who.token));
    if ((await call(env, who.account, 'trip-list', {}, who.token)).plus === false) throw new ApiError(402, 'plus_required', 'Eden Travel is part of Eden Plus.');
    try { return await heroImage(url, { fetch: deps.fetch }); } catch (e) { if (e instanceof HeroError) throw new ApiError(e.code === 'bad_request' ? 400 : e.code === 'not_found' ? 404 : 502, e.code, e.message); throw e; }
  }
  if (path === '/api/chat/travel/calendar') {
    const id = new URL(request.url).searchParams.get('id') || '';
    const got = await call(env, who.account, 'trip-read', { id }, who.token);
    return new Response(tripToIcs(got.trip, { id, now: Date.now() }), { headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': `attachment; filename="${String(got.trip.title || 'trip').replace(/[^A-Za-z0-9 _-]+/g, '').trim().slice(0, 60) || 'trip'}.ics"`, 'cache-control': 'private, no-cache' } });
  }
  // a memory's photo (memories.js): the organiser's, or a member's while the organiser shares them
  if (path === '/api/chat/travel/memory-photo') return memoryPhotoRoute(request, env, who, { call });
  // a stop's document (inbox.js), its own bytes: only the types inbox.js checked by their first bytes, nosniff (a CSP sandbox
  // would stop the browser's PDF viewer)
  if (path === '/api/chat/travel/doc') {
    const url = new URL(request.url);
    const got = await call(env, who.account, 'trip-doc-get', { id: url.searchParams.get('id') || '', doc: url.searchParams.get('doc') || '' }, who.token);
    const bytes = Uint8Array.from(atob(got.data), (c) => c.charCodeAt(0));
    const name = String(got.doc.name || 'document').replace(/[^A-Za-z0-9 ._-]+/g, '').trim().slice(0, 80) || 'document';
    return new Response(bytes, { headers: { 'content-type': got.doc.type, 'content-disposition': `${got.doc.type === 'application/vnd.apple.pkpass' ? 'attachment' : 'inline'}; filename="${name}"`, 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=31536000, immutable' } });
  }
  if (request.method === 'GET') {
    const id = new URL(request.url).searchParams.get('id');
    return json(await call(env, who.account, id ? 'trip-get' : 'trip-list', id ? { id } : {}, who.token));
  }
  if (request.method !== 'POST') throw new ApiError(405, 'bad_request', 'GET or POST');
  // a document comes as base64 (inbox.js DOCS: up to 10 MB a file)
  const body = await readBody(request, new URL(request.url).searchParams.get('doc') === '1' ? 15 * 1024 * 1024 : 256 * 1024);
  // what Plus covers on a shared trip, and its flight alerts on the member's own phone (companions.js)
  if (body.action === 'shared-plus-covers' || body.action === 'shared-alerts') {
    const a1 = body.args !== null && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
    return json(await companionsApi(env, who, body.action, a1, { call, ask }));
  }
  // who's looking at a shared trip, and a member's copy of it (together.js)
  if (body.action === 'shared-presence-beat' || body.action === 'shared-copy') {
    const a0 = body.args !== null && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
    if (body.action === 'shared-copy') await limited(env, 'EDEN_RATE', `turn:${who.account}`);
    return json(await togetherApi(env, who, body.action, a0, { call, ask }));
  }
  if (MEMBER_ACTIONS.has(body.action)) {
    const args0 = body.args !== null && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
    if (['join', 'shared-get', 'shared-propose', 'shared-decisions', 'shared-chat-post', 'shared-expense-add', 'shared-photo-add', 'shared-discover', 'shared-nearby'].includes(body.action)) await limited(env, 'EDEN_RATE', `turn:${who.account}`);
    return json(await memberApi(env, who, body.action, args0, { call }));
  }
  if (!ACTIONS.has(body.action)) throw new ApiError(400, 'bad_request', `action must be one of ${[...ACTIONS].join(', ')}.`);
  const args = body.args !== null && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
  // A Google or FlightAware lookup (each billed): held to the turn rate, like a chat message.
  if (body.action === 'places' || body.action === 'create' || body.action === 'stays-search' || body.action === 'stays-rates' || body.action === 'stays-quote' || body.action === 'rail-check' || body.action === 'ground-search' || body.action.startsWith('flight') || ['discover', 'nearby', 'decisions', 'optimize', 'windows', 'paste', 'doc-add', 'chat-post', 'activities', 'fwatch-on', 'photo-add', 'copy', 'check-report', 'promise-rebook', 'esim', 'esim-check', 'year', 'card-perk', 'claims'].includes(body.action)) await limited(env, 'EDEN_RATE', `turn:${who.account}`); // create: its named places are looked up (ops.js locate)
  // Eden Mail reads: held to the turn rate; `local` only from wrangler dev with a fake Google (as tasks.js)
  if (body.action === 'mailwatch-on') args.local = local; // the email watch's first look (a fake Google only under wrangler dev)
  if (body.action.startsWith('mail-')) { await limited(env, 'EDEN_RATE', `turn:${who.account}`); args.local = local; }
  // where Stripe sends the traveller back: this very address (askedentravel.com or askeden.com), never one the page names
  if (body.action === 'pay-start' || body.action === 'calfeed-create') args.origin = new URL(request.url).origin;
  return json(await call(env, who.account, `trip-${body.action}`, args, who.token));
}
