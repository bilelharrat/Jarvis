// One Eden Secretary account: a Durable Object named by the account id (docs/accounts.md). It keeps
// the account's devices (each with the SHA-256 of its secret, never the secret), its plan,
// what it has spent, its sealed sync items, and, for a moment, the relay's sockets.
//
// The Worker (accounts/index.js) talks to it with internal requests to https://account/<op>;
// every op but sign-in and App Store notifications carries the caller's device id and secret
// (x-jarvis-device, x-jarvis-secret), checked here. Nothing outside the Worker reaches it.

import {
  ApiError,
  EDEN_BUNDLE_ID,
  EDEN_PLUS_PRODUCTS,
  isPlusPurchase,
  cleanName,
  cleanVersion,
  deviceKind,
  isPhone,
  isWebPushApp,
  json,
  makeToken,
  newDevice,
  sameText,
  sha256Hex,
  signedOut,
  validDeviceId,
} from './util.js';
import { forgetGoogleOnDelete, googleOp } from './tokens.js';
import { approvalOp } from './approvals.js';
import { scopedOp } from './scoped.js';
import { userKeysOp } from './user-keys.js';
import { webClosed, webListen, webMessage, webOp } from './webrelay.js';
import { GRANT_CLIENTS } from './apple.js';
import { publishedOp } from './published.js';
import { sharedChatsOp, sharedIds } from './shared-chats.js';
import { edenSyncOp } from './eden-sync.js';
import { chatMergeOp, chatSyncOp } from './chat-sync.js';
import { essaySyncOp } from './essay-sync.js';
import { memoryOp } from '../eden/memory.js';
import { delegateOp, grantAllow, grantGuard, grantView, poolSpend } from './delegates.js';
import { eduAccountOp } from '../edu/budget.js';
import { mailDue, mailOp, runAlarms, scheduleJob, unscheduleJob } from './schedule.js';
import { receiptOp } from './receipts.js';
import { autodraftDue, autodraftOp } from './autodrafts.js';
import { notifyOwner, taskDue, taskOp } from './tasks.js';
import { tripOp } from '../travel/ops.js';
import { armFlightWatch, flightWatchDue } from '../travel/watch.js';
import { stayWatchDue } from '../travel/stayops.js';
import { sharePublicOp } from '../travel/track.js';
import { linkPublicOp } from '../travel/triplink.js';
import { flightOp } from '../travel/flights.js';
import { payOn, payOp, payRefund } from '../travel/pay.js';
import { mailUploadOp, uploadsDue } from './mail-uploads.js';
import { grantPromo } from './promo.js';
import { combinePlans, legacyPrice, planSource, stripeOp, stripeToCancel } from './stripe-plan.js';
import { playCap, playOp, withPlayPlan } from './play-plan.js';
import { balanceOf, creditsOf, creditsView, markupFor, maybeTopUp, spendCredits } from './credits.js';
import { aiSpend } from '../stats/stats.js';

const TRIP_WRITES = new Set(['trip-stays-book', 'trip-create', 'trip-sample', 'trip-update', 'trip-delete', 'trip-edit', 'trip-apply', 'trip-undo', 'trip-mark-booked', 'trip-unbook', 'trip-mail-import']); // re-arm the flight watch (travel/watch.js)
const SEEN_EVERY = 3600_000; // last_seen is saved at most hourly
const MAX_DEVICES = 20;
export const WEB_SESSION_DAYS = 30; // a browser's sign-in at askeden.com ends after this
// A browser may approve linking a Mac only this soon after it signed in (docs/web-auth.md).
export const WEB_LINK_MAC_MS = 10 * 60_000;
export const WEB_LINK_MAC_STALE = 'To link a Mac here, sign in again first: a browser approves a Mac only within 10 minutes of signing in.';
// Browsers signed in at once; the next signs out the one used longest ago. (It was 5, with the
// oldest sign-in signed out: on the sixth the owner's everyday browser went, and its sync stopped.)
const WEB_DEVICES = 10;
// Hosted Eden's turns in flight per account, and how long a hold on the allowance lasts at most.
export const EDEN_TURNS = 2;
// The apps' raw proxy (/api/anthropic, index.js): its requests in flight per account. Each holds
// its worst case too (capped at what's left), so parallel requests can't spend past the allowance.
export const PROXY_TURNS = 8;
const HOLD_MS = 15 * 60_000;
// A browser signed in at askeden.com (a `web` device) uses the included AI and its own
// artifacts, and signs itself out. It can't delete the account, change devices, send
// pushes, buy, read or write sync, use the relay, or approve any link. It may use the Eden Secretary
// voice only through hosted Eden (Read aloud, talk mode: eden: true), on the account's daily
// voice allowance like the apps.
// With traveller payments on (travel/pay.js), a booking that Ask Eden's Duffel balance pays for goes through a card hold first.
const PAY_FIRST = new ApiError(402, 'pay_first', 'Pay for this booking first: Eden holds your card, books, then charges it.');
const WEB_FORBIDDEN = new Set(['delete', 'device-update', 'push-check', 'subscription', 'sync-get', 'sync-put', 'sync-delete', 'sync-wipe']);
// Eden's artifacts (HTML the page previews): kept a few hours, then gone (an alarm).
// Stored in pieces small enough for any Durable Object storage (128 KiB a value).
export const ARTIFACTS = { hours: 6, max: 30, bytes: 2 * 1024 * 1024, chunk: 60_000 };
const SYNC_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const SYNC_DATA_CHARS = Math.ceil((512 * 1024 * 4) / 3) + 4; // 512 KiB, in base64
const SYNC_MAX_ITEMS = 2000;
const SYNC_PAGE = 200;
const PUSHES_A_MINUTE = 60;
const VOICE = { free: 20000, plus: 100000 };
const RELAY = { frame: 64 * 1024, held: 256 * 1024, streams: 16 };

// Dollars: a month of Plus (today's price), a month of Plus at the old $20 price (grandfathered:
// its Stripe price in STRIPE_PRICE_PLUS_LEGACY, and the App Store's), and the trial.
export const LIMITS = { plus: 6, legacy: 20, trial: 1, sandbox: 0.5, daredevil: 6 };
const REVOKED_KEPT = 50; // refunded transaction ids kept per original transaction

function allowances(env = {}) {
  const n = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 && v !== '' && v !== undefined ? Number(v) : d);
  return {
    plus: n(env.PLUS_BUDGET_USD, LIMITS.plus),
    legacy: n(env.PLUS_LEGACY_BUDGET_USD, LIMITS.legacy),
    trial: n(env.TRIAL_BUDGET_USD, LIMITS.trial),
    sandbox: n(env.SANDBOX_BUDGET_USD, LIMITS.sandbox),
    daredevil: n(env.DAREDEVIL_BUDGET_USD, LIMITS.daredevil), // J.A.R.V.I.S. Daredevil's AI is free: a month's allowance for any account that linked it
    voiceFree: n(env.VOICE_DAILY_FREE, VOICE.free),
    voicePlus: n(env.VOICE_DAILY_PLUS, VOICE.plus),
    // UNLIMITED_EMAILS's accounts (the owner's family): no allowance worth the name, only a safety stop a month.
    unlimited: n(env.UNLIMITED_BUDGET_USD, 1000),
  };
}

const month = (now) => new Date(now).toISOString().slice(0, 7);
const monthStart = (key) => Date.parse(`${key}-01T00:00:00Z`);
const nextMonth = (key) => {
  const [y, m] = key.split('-').map(Number);
  return Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1);
};
const today = (now) => new Date(now).toISOString().slice(0, 10);
const round = (usd) => Math.round(usd * 1e6) / 1e6;

export class Account {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.storage = ctx.storage;
    this.env = env || {};
    this.now = () => Date.now();
    this.pending = new Map(); // relay stream id -> { size, chunks }: what a phone sent before its Mac answered
    this.pushTimes = [];
    this.holds = new Map(); // hosted Eden's turns in flight: id → { usd, bucket, until }
    if (ctx.setWebSocketAutoResponse && globalThis.WebSocketRequestResponsePair) {
      ctx.setWebSocketAutoResponse(new globalThis.WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'));
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const op = url.pathname.slice(1);
    try {
      if (op.startsWith('relay/')) return await this.relay(op.slice(6), request, url);
      // Before the `web-` ops below (the Mac relay's): a browser's sign-in, made by the Worker.
      if (op === 'web-signin') return json(await this.webSignIn(await request.json().catch(() => ({}))));
      if (op.startsWith('web-')) return await webOp(this, op, request); // hosted Eden → the Mac (webrelay.js)
      if (op.startsWith('pub-')) return await publishedOp(this, op, request); // published pages, /p/<id> (published.js)
      // Eden Travel's guest tracking links (travel/track.js): the link's code is the key; no device signs these
      if (op.startsWith('tshare-')) return json(await sharePublicOp(this, op, await request.json().catch(() => ({})), { tripOp, notify: notifyOwner }));
      // Stripe's word that a booking's card is held (eden/billing.js webhook; travel/pay.js checks it with Stripe)
      if (op === 'pay-webhook') return json(await payOp(this, op, await request.json().catch(() => ({})), { flightOp, tripOp }));
      if (op.startsWith('tlink-')) {
        // the trip shared with the people on it (travel/triplink.js): shown only while its owner has Plus
        if (String(this.env.TRAVEL_PLUS ?? '1') !== '0' && !(await this.planNow()).active) throw new ApiError(404, 'not_found', 'This trip link has ended.');
        return json(await linkPublicOp(this, op, await request.json().catch(() => ({})), { tripOp }));
      }
      if (op.startsWith('share-')) return await sharedChatsOp(this, op, request); // shared chats, /s/<id> (shared-chats.js, askeden Q3)
      if (op.startsWith('esync-')) return await edenSyncOp(this, op, request); // Eden's end-to-end encrypted history, H1 (eden-sync.js)
      if (op.startsWith('cmerge-')) return await chatMergeOp(this, op, request); // another sign-in's chats copied into the account that proved it (chat-sync.js)
      if (op.startsWith('csync-')) return await chatSyncOp(this, op, request); // chat history on every device, sealed server-side (chat-sync.js)
      if (op.startsWith('essay-')) return await essaySyncOp(this, op, request); // essays on every device, sealed the same way (essay-sync.js, askeden T11)
      if (op.startsWith('deleg-')) return await delegateOp(this, op, request); // delegates and grants, H14/G8 (delegates.js)
      if (op.startsWith('edu-')) return await eduAccountOp(this, op, request); // course budgets and students' free study AI, askeden L9 (edu/budget.js)
      if (op.startsWith('stripe-')) return await stripeOp(this, op, request); // Plus bought on the web, F15 (stripe-plan.js)
      if (op.startsWith('play-')) return await playOp(this, op, request); // Plus bought in Eden for Android, Google Play (play-plan.js)
      if (op.startsWith('mailup-')) return await mailUploadOp(this, op, request); // hosted Gmail's attachments uploaded ahead (mail-uploads.js)
      if (op.startsWith('ukeys-')) return await userKeysOp(this, op, request); // the owner's own API keys, sealed (user-keys.js)
      if (op.startsWith('mem-')) return await memoryOp(this, op, request); // Eden's memory across chats, sealed (eden/memory.js)
      const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
      if (op === 'signin') return json(await this.signIn(body));
      if (op === 'notification') return json(await this.notification(body));
      if (op === 'spend') return json(await this.spend(body));
      if (op === 'release-ai') return json(this.release(body));
      if (op === 'push-gone') return json(await this.pushGone(body));
      if (op === 'exists') return json({ exists: Boolean(await this.storage.get('account')) });
      if (op === 'identity-link') return json(await this.linkIdentity(body));
      if (op.startsWith('google-')) return json(await googleOp(this, op, body, request)); // hosted Gmail/Calendar tokens (tokens.js checks the caller)
      if (op.startsWith('scoped-')) return json(await scopedOp(this, op, body, request)); // other apps' scoped tokens, @Eden (scoped.js checks the caller)
      if (op === 'rcpt-open') return json(await receiptOp(this, op, body)); // a read receipt's pixel loaded (the Worker's /r/ route; receipts.js)
      const device = await this.authenticate(request);
      // A browser may delete the account only when the person typed DELETE (the account page).
      const webDelete = op === 'delete' && body.confirm === 'DELETE' && !device.grant;
      if (device.kind === 'web' && WEB_FORBIDDEN.has(op) && !webDelete) {
        throw new ApiError(403, 'forbidden', "Eden on the web can't do that. Use the Eden Secretary app on your iPhone or Mac.");
      }
      if (op.startsWith('approve-')) return json(await approvalOp(this, op, body, device)); // one-click approvals for Gmail/Calendar writes (approvals.js)
      if (op.startsWith('mail-')) return json(await mailOp(this, op, body)); // scheduled Gmail sends (schedule.js)
      if (op.startsWith('ad-')) { if (device.grant) throw new ApiError(403, 'forbidden', 'Background Auto Drafts are the owner’s.'); return json(await autodraftOp(this, op, body)); } // Auto Drafts in the background (autodrafts.js)
      if (op.startsWith('rcpt-')) { if (device.grant) throw new ApiError(403, 'forbidden', 'Read receipts are the owner’s.'); return json(await receiptOp(this, op, body)); } // read receipts (receipts.js)
      if (op.startsWith('task-')) return json(await taskOp(this, op, body, device)); // background tasks (tasks.js)
      if (op.startsWith('flight-')) { if (device.grant) throw new ApiError(403, 'forbidden', 'Booking flights is the owner’s.'); if (String(this.env.TRAVEL_PLUS ?? '1') !== '0' && !(await this.planNow()).active) throw new ApiError(402, 'plus_required', 'Booking travel is part of Eden Plus.'); if (payOn(this.env) && ((op === 'flight-book' && body.hold !== true) || op === 'flight-pay')) throw PAY_FIRST;
        const out = await flightOp(this, op, body);
        // a paid flight cancelled: the airline's quoted refund goes back to the traveller's card (travel/pay.js payRefund)
        if (op === 'flight-cancel_quote' && out.cancellation_id) await this.storage.put(`tcq:${out.cancellation_id}`, { order_id: out.order_id, refund: out.refund ?? 0 });
        if (op === 'flight-cancel_confirm' && out.cancelled) {
          const q = await this.storage.get(`tcq:${String(body.cancellation_id || '')}`);
          const words = await payRefund(this, out.order_id, q ? q.refund : 0);
          if (words) out.card_refund_text = words;
        }
        return json(out);
      } // flights through Duffel (travel/flights.js)
      if (op.startsWith('trip-')) {
        if (device.grant) throw new ApiError(403, 'forbidden', 'Trips are the owner’s.');
        // Eden Travel is part of Eden Plus (the owner's decision, 2026-10-28): without it the list answers empty with
        // plus: false (the page shows the Plus card), and every other trip action is refused. TRAVEL_PLUS = "0" lifts it (local dev).
        // ending a shared link, listing links and deleting a trip are always the person's, Plus or not
        if (String(this.env.TRAVEL_PLUS ?? '1') !== '0' && !['trip-link-revoke', 'trip-links', 'trip-delete'].includes(op) && !(await this.planNow()).active) {
          if (op === 'trip-list') return json({ trips: [], plus: false });
          throw new ApiError(402, 'plus_required', 'Eden Travel is part of Eden Plus.');
        }
        // paying for a booking with the traveller's card first (travel/pay.js); with payments on, a hotel isn't booked without it
        if (op.startsWith('trip-pay-')) return json(await payOp(this, op, body, { flightOp, tripOp }));
        if (op === 'trip-stays-book' && payOn(this.env)) throw PAY_FIRST;
        // a paid hotel cancelled within its free cancellation: the whole price goes back to the card (travel/pay.js payRefund)
        const stay = op === 'trip-stays-cancel' ? await this.storage.get(`stbk:${String(body.booking_id || '')}`) : null;
        const out = await tripOp(this, op, body); // Eden Travel (travel/ops.js)
        if (stay && stay.total) {
          const free = stay.free_until && this.now() < Date.parse(stay.free_until);
          const words = await payRefund(this, String(body.booking_id), free ? Math.round(Number(stay.total) * 100) : 0);
          if (words) out.card_refund_text = words;
        }
        if (TRIP_WRITES.has(op)) await armFlightWatch(this).catch((e) => console.error('flight watch', e && e.message)); // flight changes pushed (travel/watch.js)
        return json(out);
      }
      switch (op) {
        case 'get': return json(await this.view(device));
        case 'whoami': return json({ account_id: (await this.storage.get('account')).id, device: this.publicDevice(device, device.id) });
        case 'promo-grant': return json(await grantPromo(this, body)); // a promo code's days, once per code (promo.js)
        case 'delete': return json(await this.deleteAll());
        case 'device-update': return json(await this.updateDevice(device, body));
        case 'app-push': return json(await this.webPush(device, body)); // an app around askeden's pages registers for push (Ask Eden Travel)
        case 'device-delete': return json(await this.deleteDevice(device, body.id));
        case 'add-device': return json(await this.addLinkedDevice(device, body));
        case 'browsers-signout': return json(await this.webSignOut(device, body));
        case 'identity-unlink': return json(await this.unlinkIdentity(body));
        case 'allow-ai':
          // A browser spends the included AI only through hosted Eden (its caps), never the raw proxy.
          if (device.kind === 'web' && body.eden !== true) throw new ApiError(403, 'forbidden', "A browser's sign-in is for Eden at askeden.com only.");
          return json(await this.allowAi(device));
        case 'hold-ai':
          if (body.eden !== true) throw new ApiError(400, 'bad_request', 'Holds are for hosted Eden.');
          return json(await this.holdAi(body, device));
        case 'hold-proxy':
          if (device.kind === 'web') throw new ApiError(403, 'forbidden', "A browser's sign-in is for Eden at askeden.com only.");
          return json(await this.holdProxy(body, device));
        case 'push-check': return json(await this.pushCheck(body));
        case 'voice':
          if (device.kind === 'web' && body.eden !== true) throw new ApiError(403, 'forbidden', "A browser's sign-in uses the voice through Eden at askeden.com only.");
          return json(await this.voice(body));
        case 'subscription': return json(await this.subscription(device, body));
        // The Eden iPhone app's App Store Plus, sent with its web view's session (eden/billing.js
        // appleTransaction): a browser's sign-in, so only the Eden app's own purchases, never a grant's.
        case 'subscription-eden':
          if (device.grant) throw new ApiError(403, 'grant_forbidden', 'Only the account’s owner can buy or manage Plus.');
          if (!body.transaction || body.transaction.bundleId !== EDEN_BUNDLE_ID) throw new ApiError(400, 'bad_transaction', 'That purchase isn’t from the Eden app.');
          return json(await this.subscription(device, body));
        case 'sync-get': return json(await this.syncGet(Number(body.since) || 0));
        case 'sync-put': return json(await this.syncPut(body));
        case 'sync-delete': return json(await this.syncDelete(body));
        case 'sync-wipe': return json(await this.syncWipe());
        case 'artifact-put': return json(await this.artifactPut(body));
        case 'artifact-get': return json(await this.artifactGet(body));
        default: throw new ApiError(404, 'not_found', 'No such thing.');
      }
    } catch (error) {
      if (error instanceof ApiError) return error.response();
      throw error;
    }
  }

  // ── devices ──

  async authenticate(request) {
    const id = request.headers.get('x-jarvis-device') || '';
    const secret = request.headers.get('x-jarvis-secret') || '';
    if (!validDeviceId(id) || !secret) throw signedOut();
    const device = await this.storage.get(`dev:${id}`);
    if (!device || !sameText(device.secret_hash, await sha256Hex(secret))) throw signedOut();
    if (device.expires && device.expires <= this.now()) {
      await this.storage.delete(`dev:${id}`); // a browser's sign-in ran out
      throw signedOut();
    }
    // A delegate's or a space member's session here: only what its grant allows (delegates.js).
    if (device.grant) grantGuard(device, new URL(request.url).pathname.slice(1));
    if (this.now() - (device.last_seen || 0) > SEEN_EVERY) {
      device.last_seen = this.now();
      await this.storage.put(`dev:${id}`, device);
    }
    return device;
  }

  async devices() {
    return [...(await this.storage.list({ prefix: 'dev:' })).values()];
  }

  async makeDevice(accountId, { name, kind, app_version }, { grant = false } = {}) {
    // Browsers' sign-ins that ran out go first, then (past WEB_DEVICES of them, or with the account
    // full) the browser used longest ago: `last_seen`, which authenticate saves at most hourly, not
    // when it signed in. Abandoned ones never use up the room the apps need, and the browser the
    // owner uses every day isn't the one signed out. A delegate's or team member's session (`grant`,
    // delegates.js grantSession) never signs out the owner's browsers: on a full account it gets the 409.
    const now0 = this.now();
    let live = [];
    for (const d of await this.devices()) {
      if (d.expires && d.expires <= now0) await this.storage.delete(`dev:${d.id}`);
      else live.push(d);
    }
    const used = (d) => d.last_seen || d.created || 0;
    const browsers = live.filter((d) => d.kind === 'web' && !d.grant).sort((a, b) => used(a) - used(b) || (a.created || 0) - (b.created || 0)); // grants' sessions aren't the owner's browsers
    const over = grant ? 0 : Math.max(deviceKind(kind) === 'web' ? browsers.length - (WEB_DEVICES - 1) : 0, live.length - (MAX_DEVICES - 1));
    for (const d of browsers.slice(0, Math.max(0, over))) {
      await this.storage.delete(`dev:${d.id}`);
      live = live.filter((x) => x !== d);
    }
    if (live.length >= MAX_DEVICES) {
      throw new ApiError(409, 'too_many_devices', `An account has at most ${MAX_DEVICES} devices. Remove one in Settings › Account first.`);
    }
    const { id, secret } = newDevice();
    const now = this.now();
    const device = {
      id,
      kind: deviceKind(kind),
      name: cleanName(name, kind === 'mac' ? 'Mac' : kind === 'web' ? 'Eden on the web' : 'iPhone'),
      app_version: cleanVersion(app_version),
      created: now,
      last_seen: now,
      secret_hash: await sha256Hex(secret),
      apns_token: null,
      apns_env: null,
    };
    if (device.kind === 'web') device.expires = now + WEB_SESSION_DAYS * 86400_000;
    await this.storage.put(`dev:${id}`, device);
    return { device, token: makeToken(accountId, id, secret) };
  }

  async signIn({ account_id, device = {}, refresh_token = null, identity = null }) {
    let account = await this.storage.get('account');
    const fresh = !account;
    if (fresh) {
      account = { id: account_id, created: this.now(), origin: 'apple' };
      await this.storage.put('account', account);
    }
    await this.noteIdentity(identity);
    if (refresh_token) await this.storage.put('apple_grant', refresh_token);
    const made = await this.makeDevice(account.id, { ...device, kind: device.kind === 'mac' ? 'iphone' : device.kind });
    return { token: made.token, device_id: made.device.id, new: fresh, account: await this.view(made.device) };
  }

  // A Mac's link: approved from an iPhone (or iPad, watch), or from the owner's browser just
  // after it signed in (askeden.com/link, docs/web-auth.md "Linking a Mac from the browser"). A
  // browser's sign-in at askeden.com (kind `web`): from an iPhone or a linked Mac.
  async addLinkedDevice(approver, { name, kind, app_version, edition }) {
    const web = kind === 'web';
    if (approver.kind === 'web') {
      // A browser approves a Mac only: as the account's owner (never a delegate's or a space
      // member's session), and only within WEB_LINK_MAC_MS of signing in.
      if (kind !== 'mac' || approver.grant) throw new ApiError(403, 'forbidden', 'Approve it in the Eden Secretary app on your iPhone or Mac.');
      if (!(this.now() - (approver.created || 0) <= WEB_LINK_MAC_MS)) throw new ApiError(403, 'sign_in_again', WEB_LINK_MAC_STALE);
    } else if (!web && !isPhone(approver.kind)) throw new ApiError(403, 'forbidden', 'Approve a Mac from your iPhone.');
    const account = await this.storage.get('account');
    const made = await this.makeDevice(account.id, { name, kind, app_version });
    // Daredevil (screen-reader mode) is free: linking it gives the account a month's AI through the apps' proxy (allowAi, proxy: true).
    if (kind === 'mac' && edition === 'daredevil' && !(await this.storage.get('daredevil'))) await this.storage.put('daredevil', { since: this.now() });
    return { token: made.token, device_id: made.device.id, account_id: account.id, name: made.device.name, kind: made.device.kind };
  }

  // Sign in with Apple, Google or a passkey on the web, or the Eden app's handoff: always as a browser.
  // `create`: a sign-in seen for the first time makes the account (on the trial allowance).
  async webSignIn({ account_id, device = {}, create = false, identity = null, apple_grant = null }) {
    let account = await this.storage.get('account');
    const fresh = !account;
    if (fresh && create) {
      account = { id: account_id, created: this.now(), origin: ['google', 'passkey'].includes(identity?.provider) ? identity.provider : 'apple' };
      await this.storage.put('account', account);
      if (identity?.provider) await this.storage.put('identities', []);
    }
    if (!account || account.id !== account_id) {
      throw new ApiError(404, 'no_account', 'There is no Eden account for this sign-in yet.');
    }
    await this.noteIdentity(identity);
    await this.keepAppleGrant(apple_grant);
    const made = await this.makeDevice(account.id, { ...device, kind: 'web' });
    return { token: made.token, device_id: made.device.id, account_id: account.id, name: made.device.name, new: fresh };
  }

  // An Eden app's Sign in with Apple grant (eden/session.js nativeApple): its refresh token, kept by the
  // client id it was issued to, so deleting the account revokes it with that id (accounts/index.js).
  // The Eden Secretary app's own grant stays in `apple_grant` (signIn).
  async keepAppleGrant(grant) {
    if (!grant || typeof grant.token !== 'string' || !grant.token || !GRANT_CLIENTS.includes(grant.client_id)) return;
    const grants = (await this.storage.get('apple_grants')) || {};
    grants[grant.client_id] = grant.token;
    await this.storage.put('apple_grants', grants);
  }

  // ── sign-in identities (docs/web-auth.md): { provider, sub_hash, email, added }, one per provider ──

  // An account the iPhone app made before identities were kept lists its Apple ID, whose
  // sub_hash is filled in at its next sign-in. (No raw sub is ever stored here.)
  async identities() {
    const stored = await this.storage.get('identities');
    if (stored) return stored;
    const account = await this.storage.get('account');
    if (!account || (account.origin && account.origin !== 'apple')) return [];
    return [{ provider: 'apple', sub_hash: null, email: null, added: account.created }];
  }

  publicIdentities(list) {
    return list.map(({ provider, email, added }) => ({ provider, email: email || null, added }));
  }

  // A sign-in that opened this account: listed (its sub_hash filled in, its email brought up to date).
  async noteIdentity(identity) {
    if (!identity || !identity.provider || !identity.sub_hash) return;
    const list = await this.identities();
    const entry = list.find((i) => i.provider === identity.provider);
    if (entry && entry.sub_hash && entry.sub_hash !== identity.sub_hash) return; // not this one's slot
    if (entry) {
      if (entry.sub_hash === identity.sub_hash && (!identity.email || entry.email === identity.email)) {
        if (!(await this.storage.get('identities'))) await this.storage.put('identities', list);
        return;
      }
      entry.sub_hash = identity.sub_hash;
      if (identity.email) entry.email = identity.email;
    } else {
      list.push({ provider: identity.provider, sub_hash: identity.sub_hash, email: identity.email || null, added: this.now() });
    }
    await this.storage.put('identities', list);
  }

  // Linking (the Worker has checked the provider's proof and claimed the Identity): only for
  // a browser of this account that is still signed in, one identity per provider.
  async linkIdentity({ device_id, identity = {} }) {
    const device = validDeviceId(device_id) ? await this.storage.get(`dev:${device_id}`) : null;
    if (!device || device.kind !== 'web' || (device.expires && device.expires <= this.now())) {
      throw new ApiError(401, 'signed_out', 'This browser was signed out. Sign in again, then link.');
    }
    const { provider, sub_hash: sub } = identity;
    if (!provider || !sub) throw new ApiError(400, 'bad_request', 'No identity to link.');
    const list = await this.identities();
    const entry = list.find((i) => i.provider === provider);
    const name = provider === 'google' ? 'a Google account' : provider === 'passkey' ? 'a passkey' : 'an Apple ID';
    const taken = new ApiError(409, 'already_linked', `This Eden account already has ${name}. Unlink it first.`);
    if (entry && entry.sub_hash && entry.sub_hash !== sub) throw taken;
    // The app's own Apple ID, not known here yet: only that one Apple ID may fill it in.
    if (entry && !entry.sub_hash && provider === 'apple' && identity.derived !== (await this.storage.get('account')).id) throw taken;
    if (entry) {
      entry.sub_hash = sub;
      entry.email = identity.email || entry.email || null;
    } else {
      list.push({ provider, sub_hash: sub, email: identity.email || null, added: this.now() });
    }
    await this.storage.put('identities', list);
    return { identities: this.publicIdentities(list) };
  }

  async unlinkIdentity({ provider }) {
    const list = await this.identities();
    const entry = list.find((i) => i.provider === provider);
    if (!entry) throw new ApiError(404, 'not_linked', 'That sign-in isn’t on this account.');
    if (list.length <= 1) throw new ApiError(409, 'last_method', 'This is the only way to sign in to this account. Link another one first.');
    if (!entry.sub_hash) {
      throw new ApiError(409, 'needs_proof', 'Sign in with Apple once more (here or in the Eden Secretary app), then unlink it.');
    }
    await this.storage.put('identities', list.filter((i) => i !== entry));
    return { provider, sub_hash: entry.sub_hash };
  }

  // A browser signs out browsers: one (`id`) or every one (`all`), itself included. The apps'
  // devices are removed only from the Eden Secretary app.
  async webSignOut(caller, { id, all = false }) {
    const removed = [];
    for (const d of await this.devices()) {
      if (d.kind === 'web' && (all || d.id === id)) {
        await this.storage.delete(`dev:${d.id}`);
        removed.push(d.id);
      }
    }
    if (!all && !removed.length) {
      if (validDeviceId(id) && (await this.storage.get(`dev:${id}`))) {
        throw new ApiError(403, 'forbidden', 'Remove the apps in the Eden Secretary app on your iPhone.');
      }
      throw new ApiError(404, 'not_found', 'That browser is already signed out.');
    }
    return { removed, me: removed.includes(caller.id) };
  }

  async updateDevice(device, body) {
    if (typeof body.name === 'string') device.name = cleanName(body.name, device.name);
    if (typeof body.app_version === 'string') device.app_version = cleanVersion(body.app_version);
    if (body.apns_token === null) {
      device.apns_token = null;
      device.apns_env = null;
    } else if (typeof body.apns_token === 'string') {
      const token = body.apns_token.toLowerCase();
      if (!/^[0-9a-f]{32,200}$/.test(token)) throw new ApiError(400, 'bad_request', "That isn't a push token.");
      device.apns_token = token;
      device.apns_env = body.apns_env === 'sandbox' ? 'sandbox' : 'production';
      // One token belongs to one device: an app reinstalled under another sign-in moves it.
      for (const other of await this.devices()) {
        if (other.id !== device.id && other.apns_token === token) {
          other.apns_token = null;
          await this.storage.put(`dev:${other.id}`, other);
        }
      }
    }
    await this.storage.put(`dev:${device.id}`, device);
    return {};
  }

  // A browser inside an app of its own (Ask Eden Travel for iPhone, util.js WEB_PUSH_APPS) gives its push token and the
  // app's topic; only that app's pushes go to it (tasks.js notifyOwner). Its own device only, never a delegate's.
  async webPush(device, body) {
    if (device.kind !== 'web' || device.grant) throw new ApiError(403, 'forbidden', 'Only a browser in an Eden app registers this way.');
    if (body.apns_token === null) {
      device.apns_topic = null;
      return this.updateDevice(device, { apns_token: null });
    }
    if (!isWebPushApp(body.app)) throw new ApiError(400, 'bad_request', "That app doesn't get pushes this way.");
    if (typeof body.apns_token !== 'string') throw new ApiError(400, 'bad_request', "That isn't a push token.");
    device.apns_topic = body.app;
    return this.updateDevice(device, { apns_token: body.apns_token, apns_env: body.apns_env });
  }

  async deleteDevice(caller, id) {
    const target = id === 'me' || !id ? caller.id : String(id);
    if (caller.kind === 'web' && target !== caller.id) {
      throw new ApiError(403, 'forbidden', 'Remove devices in the Eden Secretary app on your iPhone.');
    }
    if (!(await this.storage.get(`dev:${target}`))) throw new ApiError(404, 'not_found', 'That device is already gone.');
    await this.storage.delete(`dev:${target}`);
    this.closeSockets([`listen:${target}`, `web:${target}`, `dev:${target}`, `from:${target}`, `to:${target}`], 4001, 'signed out');
    return {};
  }

  async deleteAll() {
    const grant = await this.storage.get('apple_grant');
    const grants = (await this.storage.get('apple_grants')) || {};
    const stripe = await stripeToCancel(this); // the Worker cancels it at Stripe (eden/billing.js)
    const identities = (await this.identities()).filter((i) => i.sub_hash).map(({ provider, sub_hash }) => ({ provider, sub_hash }));
    const published = [...(await this.storage.list({ prefix: 'pubh:' })).keys()].map((k) => k.slice(5)); // the Worker drops their /p/ links
    const shared = await sharedIds(this.storage); // and their /s/ links (shared-chats.js)
    const playClaims = (await this.storage.get('play_claims')) || []; // read before deleteAll (play-plan.js)
    this.closeSockets(['listen', 'web', 'phone', 'mac'], 4001, 'account deleted');
    await forgetGoogleOnDelete(this); // revokes hosted Eden's Gmail/Calendar grant at Google
    await this.storage.deleteAll();
    await Promise.resolve(this.storage.deleteAlarm?.()).catch(() => {}); // deleteAll leaves the alarm set
    return { apple_grant: grant || null, apple_grants: grants, identities, stripe_subscription: stripe, published, shared, appstore_claims: (await this.storage.get('appstore_claims')) || [], play_claims: playClaims };
  }

  publicDevice(device, me) {
    return {
      id: device.id,
      name: device.name,
      kind: device.kind,
      created: device.created,
      last_seen: device.last_seen,
      app_version: device.app_version || '',
      push: Boolean(device.apns_token),
      relay: this.socketsTagged(`listen:${device.id}`).length > 0,
      this: device.id === me,
      ...(device.expires ? { expires: device.expires } : {}),
      ...(device.grant ? { grant: device.grant } : {}),
    };
  }

  // ── what the app shows ──

  async view(device) {
    if (device.grant) return grantView(this, device); // a delegate sees its own limit, nothing of the owner's
    const account = await this.storage.get('account');
    const plan = await this.planNow();
    const usage = await this.usageNow();
    const caps = allowances(this.env);
    const voice = (await this.storage.get('voice')) || {};
    const voiceToday = voice.day === today(this.now()) ? voice.chars : 0;
    const budget = plan.active ? await this.plusCap(plan) : 0;
    const devices = (await this.devices()).filter((d) => !d.grant).sort((a, b) => a.created - b.created).map((d) => this.publicDevice(d, device.id));
    return {
      id: account.id,
      created: account.created,
      plan: {
        name: plan.active ? 'plus' : 'free',
        active: plan.active,
        product_id: plan.product_id || null,
        expires: plan.expires || null,
        renews: plan.renews ?? null,
        environment: plan.environment || null,
        ...planSource(plan), // source "app_store" | "stripe" | "both", manage, payment_failed (stripe-plan.js)
      },
      usage: {
        period_start: monthStart(usage.month),
        period_end: nextMonth(usage.month),
        spent_usd: round(usage.spent),
        budget_usd: budget,
        left_usd: round(Math.max(0, budget - usage.spent)),
        trial_left_usd: round(Math.max(0, caps.trial - usage.trial_spent)),
        trial_usd: caps.trial, // the trial's size and a month of Plus, for the meters
        plus_usd: plan.active ? budget : caps.plus,
        voice_today: voiceToday,
        voice_daily: plan.active ? caps.voicePlus : caps.voiceFree,
      },
      credits: await creditsView(this, plan), // pay-as-you-go, after the included AI (credits.js)
      devices,
      identities: this.publicIdentities(await this.identities()),
      sync: { rev: (await this.storage.get('syncrev')) || 0, items: (await this.storage.get('synccount')) || 0 },
    };
  }

  // ── the plan (StoreKit 2) ──

  // The App Store's plan and Stripe's (bought on the web), together: Plus while either is
  // active, until the later one ends (stripe-plan.js combinePlans).
  async planNow() {
    const plan = (await this.storage.get('plan')) || {};
    // Google Play's (Eden for Android) on top (play-plan.js withPlayPlan).
    const combined = withPlayPlan(combinePlans(plan, await this.storage.get('stripe_plan'), this.now(), await this.storage.get('promo_plan')), await this.storage.get('play_plan'), this.now());
    // UNLIMITED_EMAILS: an account with one of them among its sign-ins has Plus for good, and plusCap's unlimited allowance.
    if (await this.unlimitedEmail()) {
      combined.unlimited = true;
      if (!combined.active) Object.assign(combined, { active: true, source: 'unlimited', expires: null, renews: false, environment: null });
    }
    return combined;
  }

  async unlimitedEmail() {
    const allowed = String(this.env.UNLIMITED_EMAILS || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
    if (!allowed.length) return false;
    return (await this.identities()).some((i) => i.email && allowed.includes(String(i.email).toLowerCase()));
  }

  // A transaction already checked against Apple's chain (storekit.js), for this account.
  // `claimed`: a transaction without an appAccountToken (an offer code redeemed in Apple's sheet)
  // that the Worker has tied to this account first (the `appstore` identity of its original
  // transaction id: eden/billing.js appleTransaction), so no other account can take it too.
  async applyTransaction(tx, renewal = null, { claimed = false } = {}) {
    const account = await this.storage.get('account');
    if (!account) throw new ApiError(404, 'not_found', 'No such account.');
    if (!isPlusPurchase(tx)) throw new ApiError(400, 'bad_transaction', "That isn't a Plus purchase.");
    const token = String(tx.appAccountToken || '').toLowerCase();
    if (token ? token !== account.id : !claimed) {
      throw new ApiError(403, 'forbidden', 'That purchase belongs to another Eden Secretary account.');
    }
    const plan = (await this.storage.get('plan')) || {};
    const expires = Number(tx.expiresDate) || 0;
    const revoked = Boolean(tx.revocationDate);
    const id = String(tx.transactionId);
    const original = String(tx.originalTransactionId);
    const signed = Number(tx.signedDate) || 0;
    // Refunded and revoked transaction ids are kept for good, per original transaction (R3C-1): an
    // old copy of a refunded transaction, posted again, never switches Plus back on.
    const gone = plan.revoked_ids && typeof plan.revoked_ids === 'object' ? plan.revoked_ids : {};
    const goneHere = Array.isArray(gone[original]) ? gone[original] : [];
    if (revoked && !goneHere.includes(id)) {
      gone[original] = [...goneHere, id].slice(-REVOKED_KEPT);
      plan.revoked_ids = gone;
    }
    const same = plan.transaction_id && String(plan.transaction_id) === id;
    const sameOriginal = String(plan.original_transaction_id) === original;
    const apply = () => Object.assign(plan, {
      product_id: tx.productId,
      transaction_id: id,
      original_transaction_id: original,
      expires,
      revoked,
      environment: tx.environment || null,
      signed_date: signed,
    });
    if (tx.environment && /^sandbox$/i.test(tx.environment)) console.warn('apple: a Sandbox transaction', tx.productId, 'on account', account.id);
    if (revoked) {
      // A refund ends the period it refunds, not a newer paid one (R3C-8).
      if (same || !plan.expires || (sameOriginal && expires >= plan.expires)) apply();
    } else if (goneHere.includes(id) || (same && plan.revoked && !plan.signed_date)) {
      // Already refunded: an older copy of it changes nothing.
    } else if (same && signed && signed < (Number(plan.signed_date) || 0)) {
      // An older copy of the transaction we hold (a stale notification, a replay): ignored.
    } else if (same || !plan.expires || expires >= plan.expires) {
      apply();
    }
    if (renewal && String(renewal.originalTransactionId) === String(plan.original_transaction_id)) {
      plan.renews = renewal.autoRenewStatus === 1;
    }
    await this.storage.put('plan', plan);
    return plan;
  }

  async subscription(device, { transaction, claimed = false, claim_hash: claimHash = null }) {
    await this.applyTransaction(transaction, null, { claimed: claimed === true });
    // The App Store claim on this subscription's original transaction, released when the account goes.
    if (/^[0-9a-f]{64}$/.test(String(claimHash || ''))) {
      const claims = (await this.storage.get('appstore_claims')) || [];
      if (!claims.includes(claimHash)) await this.storage.put('appstore_claims', [...claims, claimHash].slice(-50));
    }
    return this.view(device);
  }

  async notification({ transaction, renewal, claimed = false }) {
    if (transaction) await this.applyTransaction(transaction, renewal, { claimed: claimed === true });
    return {};
  }

  // ── what the included AI may spend ──

  async usageNow() {
    const now = this.now();
    const usage = (await this.storage.get('usage')) || { month: month(now), spent: 0, trial_spent: 0 };
    if (usage.month !== month(now)) {
      usage.month = month(now);
      usage.spent = 0;
    }
    return usage;
  }

  // Hosted Eden's holds still running (expired ones go), in dollars, for one bucket.
  held(bucket) {
    const now = this.now();
    let usd = 0;
    for (const [id, h] of this.holds) {
      if (h.until <= now) this.holds.delete(id);
      else if (h.bucket.split('|')[0] === bucket) usd += h.usd;
    }
    return usd;
  }

  // Holds still running against one grant's pool (delegates.js), in dollars.
  heldIn(pool) {
    this.held('');
    let usd = 0;
    for (const h of this.holds.values()) if (h.pool === pool) usd += h.usd;
    return usd;
  }

  // A month of Plus in dollars: the plan's price decides (grandfathered $20 subscribers, and the
  // App Store's, keep the old allowance; today's monthly and yearly prices get PLUS_BUDGET_USD).
  async plusCap(plan) {
    const caps = allowances(this.env);
    if (!plan.active) return 0;
    if (plan.play) return playCap(plan, caps, (base) => this.plusCap(base)); // Google Play's Plus beside the others (play-plan.js)
    const stripe = (await this.storage.get('stripe_plan')) || {};
    const apple = plan.source === 'app_store' || plan.source === 'both';
    const web = plan.source === 'stripe' || plan.source === 'both';
    // Eden for iPhone's App Store Plus is sold at today's price: today's allowance (Eden Secretary's, the old one).
    const store = apple ? (await this.storage.get('plan')) || {} : {};
    // A Sandbox purchase (TestFlight, App Review: free, and signed with Apple's own chain) is Plus,
    // with a trial-size allowance only (R3C-3).
    const sandbox = apple && /^sandbox$/i.test(String(store.environment || ''));
    let cap = apple ? (sandbox ? caps.sandbox : EDEN_PLUS_PRODUCTS.includes(store.product_id) ? caps.plus : caps.legacy) : plan.promo ? caps.plus : 0;
    if (web) cap = Math.max(cap, legacyPrice(this.env, stripe.price) ? caps.legacy : caps.plus);
    if (plan.unlimited) cap = Math.max(cap, caps.unlimited);
    return cap;
  }

  // What the AI may spend now, in dollars of provider cost: the month's Plus allowance, then the
  // trial, then the credits (at the user's price: the markup divides them). `bucket` says where a
  // turn starts; spend() moves on to the credits when the allowance runs out under it. `left`
  // counts the credits after the allowance (less hosted Eden's turns in flight: Eden fits a
  // reply's size to it); `allowance_left` the allowance alone. `credits: false` (a grant's pool)
  // never reaches the owner's credits.
  async allowAi(device = null, { credits = true, proxy = false } = {}) {
    const plan = await this.planNow();
    // A grant (a delegate, a space member): the owner's allowance, narrowed to its own pool.
    if (device && device.grant) return grantAllow(this, device, await this.allowAi(null, { credits: false }), plan);
    const usage = await this.usageNow();
    const caps = allowances(this.env);
    const dare = proxy && !plan.active && Boolean(await this.storage.get('daredevil')); // Daredevil's free allowance: the apps' proxy only
    const cap = dare ? caps.daredevil : await this.plusCap(plan);
    const markup = markupFor(plan);
    const creditUSD = credits ? balanceOf(await creditsOf(this), this.now()) : 0;
    const creditLeft = creditUSD / markup - this.held('credits');
    const withCredits = (bucket, raw) => ({
      ok: true,
      bucket,
      left: round(Math.max(0, raw) + Math.max(0, creditLeft + Math.min(0, raw))),
      allowance_left: round(Math.max(0, raw)),
      budget: bucket === 'plus' ? cap : caps.trial,
      markup: 1,
      credits_usd: creditUSD,
    });
    if ((plan.active || dare) && usage.spent < cap) return withCredits('plus', cap - usage.spent - this.held('plus'));
    if (usage.trial_spent < caps.trial) return withCredits('trial', caps.trial - usage.trial_spent - this.held('trial'));
    if (creditLeft > 0) return { ok: true, bucket: 'credits', left: round(creditLeft), allowance_left: 0, budget: 0, markup, credits_usd: creditUSD };
    return {
      ok: false,
      why: dare
        ? "This month's free Daredevil AI is used up. It starts again on the 1st, or add credits in Settings › Account."
        : plan.active
        ? "This month's Plus AI allowance is used up. It starts again on the 1st, or add credits in Settings › Account."
        : 'The free trial of Eden’s AI is used up. Get Plus, or add credits (Settings › Account).',
    };
  }

  // A hosted Eden turn holds its worst case (what it may cost at most) until it's done, so
  // turns at once can't spend past the allowance; at most EDEN_TURNS at once.
  async holdAi({ usd }, device = null) {
    const want = Number(usd);
    if (!(want >= 0)) throw new ApiError(400, 'bad_request', 'usd must be a number');
    this.held(''); // drop expired holds
    if ([...this.holds.values()].filter((h) => !h.proxy && !h.edu).length >= EDEN_TURNS) { // students' course turns (edu/budget.js) don't take the owner's two
      throw new ApiError(429, 'slow_down', `Eden is already writing ${EDEN_TURNS} replies for this account; wait for one to finish.`, { 'retry-after': '10' });
    }
    const allow = await this.allowAi(device);
    if (!allow.ok) return allow;
    if (want > allow.left) {
      return { ok: false, why: 'Not enough of your included AI is left for this reply. Start a new chat, or wait for the allowance to renew.' };
    }
    const id = crypto.randomUUID();
    this.holds.set(id, { usd: want, bucket: allow.bucket, until: this.now() + HOLD_MS, pool: allow.pool || null });
    return { ok: true, bucket: allow.bucket, hold: id, left: allow.left, markup: allow.markup || 1 };
  }

  // One request of the apps' proxy (index.js anthropic): at most PROXY_TURNS at once, each holding
  // its worst case, capped at what's left (so a big request near the end still goes, alone).
  // Nothing left but what other requests hold: 429, wait for them.
  async holdProxy({ usd }, device = null) {
    const want = Number(usd);
    if (!(want >= 0)) throw new ApiError(400, 'bad_request', 'usd must be a number');
    this.held(''); // drop expired holds
    const busy = () => new ApiError(429, 'slow_down', 'Your other AI requests are still running; try again in a moment.', { 'retry-after': '10' });
    if ([...this.holds.values()].filter((h) => h.proxy).length >= PROXY_TURNS) throw busy();
    const allow = await this.allowAi(device, { proxy: true });
    if (!allow.ok) return allow;
    if (!(allow.left > 0)) throw busy();
    const id = crypto.randomUUID();
    this.holds.set(id, { usd: Math.min(want, allow.left), bucket: allow.bucket, until: this.now() + HOLD_MS, pool: null, proxy: true });
    return { ok: true, bucket: allow.bucket, hold: id };
  }

  release({ hold }) {
    this.holds.delete(String(hold || ''));
    return {};
  }

  // `usd`: provider cost. The allowance takes what it still holds; the rest (the account has
  // credits, and it's not a grant's turn) comes off the credits at the user's price. Without
  // credits, the allowance takes all of it, as before. → { charged_usd }: the user's price.
  async spend({ usd, bucket, meta = null }) {
    const cost = Number(usd);
    if (!(cost > 0)) return { charged_usd: 0 };
    // For the owner's dashboard (stats/stats.js): what it cost, on what, never what was said.
    const me = await this.storage.get('account');
    const noted = aiSpend(this.env, { accountId: me && me.id, usd: cost, bucket, meta: meta && typeof meta === 'object' ? meta : {} });
    if (this.ctx && this.ctx.waitUntil) this.ctx.waitUntil(noted);
    const usage = await this.usageNow();
    // "plus|dlg:<id>|<by>": a grant's turn, also counted on its pool (delegates.js grantAllow).
    const [base, pool, by] = String(bucket || '').split('|');
    const plan = await this.planNow();
    const markup = markupFor(plan);
    let charged = 0;
    let fromCredits = 0;
    if (base === 'credits' && !pool) fromCredits = round(cost * markup);
    else {
      const trial = base === 'trial';
      const dare = !trial && !plan.active && Boolean(await this.storage.get('daredevil'));
      const cap = trial ? allowances(this.env).trial : dare ? allowances(this.env).daredevil : await this.plusCap(plan);
      const room = Math.max(0, cap - (trial ? usage.trial_spent : usage.spent));
      let inAllowance = cost;
      if (!pool && cost > room && balanceOf(await creditsOf(this), this.now()) > 0) {
        inAllowance = room;
        fromCredits = round((cost - room) * markup);
      }
      if (trial) usage.trial_spent = round(usage.trial_spent + inAllowance);
      else usage.spent = round(usage.spent + inAllowance);
      await this.storage.put('usage', usage);
      charged = inAllowance;
    }
    if (fromCredits > 0) {
      charged += await spendCredits(this, fromCredits);
      await this.topUpSoon();
    }
    if (pool) await poolSpend(this, pool, by, cost);
    return { charged_usd: round(charged) };
  }

  // Auto top-up (credits.js maybeTopUp) through Stripe (eden/billing.js chargeTopUp); never fails a spend.
  async topUpSoon() {
    try {
      const { chargeTopUp } = await import('../eden/billing.js');
      await maybeTopUp(this, (args) => chargeTopUp(this.env, args));
    } catch (error) {
      console.error('auto top-up failed', error && error.message);
    }
  }

  // ── the Eden Secretary voice, counted per account ──

  async voice({ chars }) {
    const plan = await this.planNow();
    const caps = allowances(this.env);
    const daily = plan.active ? caps.voicePlus : caps.voiceFree;
    const day = today(this.now());
    const voice = (await this.storage.get('voice')) || {};
    const used = voice.day === day ? voice.chars : 0;
    const n = Math.max(0, Number(chars) || 0);
    if (used + n > daily) {
      return {
        ok: false,
        why: plan.active
          ? "Today's Eden Secretary voice allowance is used up; it resets at midnight UTC."
          : "Today's Eden Secretary voice allowance is used up; it resets at midnight UTC. Eden Plus has five times as much.",
      };
    }
    await this.storage.put('voice', { day, chars: used + n });
    return { ok: true, left: daily - used - n };
  }

  // ── pushes through askeden.com's key ──

  async pushCheck({ apns_token, push_type }) {
    const now = this.now();
    this.pushTimes = this.pushTimes.filter((t) => now - t < 60_000);
    if (this.pushTimes.length >= PUSHES_A_MINUTE) {
      throw new ApiError(429, 'slow_down', 'Too many notifications this minute.', { 'retry-after': '60' });
    }
    const token = String(apns_token || '').toLowerCase();
    if (!/^[0-9a-f]{32,200}$/.test(token)) throw new ApiError(400, 'bad_request', "That isn't a push token.");
    if (push_type !== 'liveactivity') {
      const owner = (await this.devices()).find((d) => d.apns_token === token);
      if (!owner) throw new ApiError(403, 'forbidden', "That push token isn't one of this account's devices.");
    }
    this.pushTimes.push(now);
    return { ok: true, token };
  }

  async pushGone({ apns_token }) {
    for (const device of await this.devices()) {
      if (device.apns_token === apns_token) {
        device.apns_token = null;
        device.apns_env = null;
        await this.storage.put(`dev:${device.id}`, device);
      }
    }
    return {};
  }

  // ── sync: sealed items the server can't read ──

  async syncGet(since) {
    const items = [...(await this.storage.list({ prefix: 's:' })).entries()]
      .map(([key, item]) => ({ key: key.slice(2), ...item }))
      .filter((item) => item.rev > since)
      .sort((a, b) => a.rev - b.rev);
    const page = items.slice(0, SYNC_PAGE);
    const more = items.length > page.length;
    const rev = more ? page[page.length - 1].rev : (await this.storage.get('syncrev')) || 0;
    return {
      rev,
      more,
      items: page.map((i) => ({ key: i.key, rev: i.rev, data: i.deleted ? null : i.data, deleted: Boolean(i.deleted), updated: i.updated })),
    };
  }

  async syncWrite(key, base, change) {
    if (!SYNC_KEY.test(String(key))) throw new ApiError(400, 'bad_request', 'That sync key has characters it may not.');
    const current = await this.storage.get(`s:${key}`);
    const currentRev = current ? current.rev : 0;
    if (Number(base) !== currentRev) {
      const item = { key, rev: currentRev, data: current && !current.deleted ? current.data : null, deleted: Boolean(current?.deleted) };
      throw new ApiError(409, 'conflict', 'Something newer is there; merge and try again.', {}, { item });
    }
    let count = (await this.storage.get('synccount')) || 0;
    if (!current || current.deleted) {
      if (!change.deleted && count >= SYNC_MAX_ITEMS) throw new ApiError(413, 'too_big', `Sync keeps at most ${SYNC_MAX_ITEMS} items.`);
      if (!change.deleted) count += 1;
    } else if (change.deleted) {
      count -= 1;
    }
    const rev = ((await this.storage.get('syncrev')) || 0) + 1;
    await this.storage.put({ [`s:${key}`]: { rev, updated: this.now(), ...change }, syncrev: rev, synccount: count });
    return { rev };
  }

  async syncPut({ key, data, base_rev }) {
    if (typeof data !== 'string' || !data || !/^[A-Za-z0-9+/=]+$/.test(data)) throw new ApiError(400, 'bad_request', 'Sync data is sealed base64.');
    if (data.length > SYNC_DATA_CHARS) throw new ApiError(413, 'too_big', 'A sync item is at most 512 KB.');
    return this.syncWrite(key, base_rev ?? 0, { data, deleted: false });
  }

  async syncDelete({ key, base_rev }) {
    return this.syncWrite(key, base_rev ?? 0, { data: null, deleted: true });
  }

  async syncWipe() {
    const keys = [...(await this.storage.list({ prefix: 's:' })).keys()];
    for (let i = 0; i < keys.length; i += 128) await this.storage.delete(keys.slice(i, i + 128));
    // The revision keeps counting, so no device mistakes the new start for what it saw.
    await this.storage.put('synccount', 0);
    return {};
  }

  // ── Eden's artifacts: HTML a browser previews, kept a few hours (never longer) ──
  //
  // arth:<id> → { at, expires, parts }, artc:<id>:<n> → a piece of the HTML (two prefixes, so
  // listing the heads never loads the pieces). Only the account's own browsers reach them
  // (hosted Eden, src/eden/chat.js); an alarm clears what's expired.

  async artifactPut({ html }) {
    if (typeof html !== 'string' || !html) throw new ApiError(400, 'bad_request', 'html must be a non-empty string');
    if (new TextEncoder().encode(html).length > ARTIFACTS.bytes) throw new ApiError(413, 'too_big', 'The artifact is larger than 2 MB.');
    const now = this.now();
    const id = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const parts = Math.ceil(html.length / ARTIFACTS.chunk);
    const expires = now + ARTIFACTS.hours * 3600_000;
    const entries = [];
    for (let i = 0; i < parts; i++) entries.push([`artc:${id}:${i}`, html.slice(i * ARTIFACTS.chunk, (i + 1) * ARTIFACTS.chunk)]);
    entries.push([`arth:${id}`, { at: now, expires, parts }]); // the head last: a half-written one is never found
    for (let i = 0; i < entries.length; i += 100) await this.storage.put(Object.fromEntries(entries.slice(i, i + 100)));
    await this.artifactSweep(now, id);
    return { id, expires };
  }

  async artifactGet({ id }) {
    if (!/^[0-9a-f]{24}$/.test(String(id))) throw new ApiError(404, 'not_found', 'No such artifact.');
    const head = await this.storage.get(`arth:${id}`);
    if (!head || head.expires <= this.now()) throw new ApiError(404, 'not_found', 'This artifact is gone (artifacts are kept for a few hours).');
    const keys = Array.from({ length: head.parts }, (_, i) => `artc:${id}:${i}`);
    let html = '';
    for (let i = 0; i < keys.length; i += 100) {
      const got = await this.storage.get(keys.slice(i, i + 100));
      for (const key of keys.slice(i, i + 100)) html += got.get(key) ?? '';
    }
    return { html };
  }

  // Expired ones go, then the oldest past the limit; the alarm is set for the next expiry.
  async artifactSweep(now = this.now(), keep = null) {
    const heads = [...(await this.storage.list({ prefix: 'arth:' })).entries()]
      .map(([key, head]) => ({ id: key.slice(5), ...head }))
      .sort((a, b) => a.at - b.at);
    const live = heads.filter((h) => h.expires > now);
    const extra = live.filter((h) => h.id !== keep).slice(0, Math.max(0, live.length - ARTIFACTS.max));
    const gone = [...heads.filter((h) => h.expires <= now), ...extra];
    for (const h of gone) {
      const keys = [`arth:${h.id}`, ...Array.from({ length: h.parts }, (_, i) => `artc:${h.id}:${i}`)];
      for (let i = 0; i < keys.length; i += 128) await this.storage.delete(keys.slice(i, i + 128));
    }
    const next = live.filter((h) => !gone.includes(h)).reduce((t, h) => Math.min(t, h.expires), Infinity);
    if (Number.isFinite(next)) await scheduleJob(this, 'artifacts', 'artifacts', next + 1000);
    else await unscheduleJob(this, 'artifacts');
  }

  // The one alarm, shared (schedule.js): artifacts' expiry, scheduled Gmail sends, tasks' checks.
  async alarm() {
    await runAlarms(this, {
      artifacts: () => this.artifactSweep(),
      mail: (job) => mailDue(this, job),
      task: (job) => taskDue(this, job),
      autodraft: () => autodraftDue(this),
      uploads: () => uploadsDue(this), // Gmail attachments uploaded ahead, unused for hours (mail-uploads.js)
      fwatch: () => flightWatchDue(this, { tripOp, notify: notifyOwner }), // a trip's flights: delays, gates, cancellations (travel/watch.js)
      pwatch: () => stayWatchDue(this, { notify: notifyOwner }), // booked hotels cheaper before free cancellation ends (travel/stayops.js)
    });
  }

  // ── the relay: a phone's bytes to its Mac's companion port and back ──

  socketsTagged(tag) {
    return this.ctx.getWebSockets ? this.ctx.getWebSockets(tag) : [];
  }

  tagsOf(ws) {
    return this.ctx.getTags ? this.ctx.getTags(ws) : [];
  }

  closeSockets(tags, code, reason) {
    for (const tag of tags) {
      for (const ws of this.socketsTagged(tag)) {
        try {
          ws.close(code, reason);
        } catch {
          // already closed
        }
      }
    }
  }

  // Overridable in tests: a WebSocket pair, the server end accepted with these tags.
  upgrade(tags) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, tags);
    return { response: new Response(null, { status: 101, webSocket: client }), server };
  }

  async relay(kind, request, url) {
    if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
      throw new ApiError(426, 'bad_request', 'The relay speaks WebSocket.');
    }
    const device = await this.authenticate(request);
    if (device.kind === 'web') throw new ApiError(403, 'forbidden', "A browser can't use the relay.");
    if (kind === 'web') return webListen(this, device);
    if (kind === 'listen') {
      if (device.kind !== 'mac') throw new ApiError(403, 'forbidden', 'Only a Mac listens on the relay.');
      this.closeSockets([`listen:${device.id}`], 4000, 'replaced');
      return this.upgrade(['listen', `listen:${device.id}`]).response;
    }
    if (kind === 'connect') {
      const to = url.searchParams.get('to') || '';
      const mac = validDeviceId(to) ? await this.storage.get(`dev:${to}`) : null;
      if (!mac || mac.kind !== 'mac') throw new ApiError(404, 'not_found', "That Mac isn't on this account.");
      const listener = this.socketsTagged(`listen:${to}`)[0];
      if (!listener) throw new ApiError(404, 'offline', "Your Mac isn't connected to the relay right now.");
      if (this.socketsTagged('phone').length >= RELAY.streams) throw new ApiError(429, 'slow_down', 'Too many connections at once.');
      const stream = crypto.randomUUID().replace(/-/g, '');
      const { response } = this.upgrade(['phone', `p:${stream}`, `from:${device.id}`, `to:${to}`]);
      this.pending.set(stream, { size: 0, chunks: [] });
      listener.send(JSON.stringify({ type: 'open', stream, from: device.id }));
      return response;
    }
    if (kind === 'accept') {
      const stream = url.searchParams.get('stream') || '';
      const phone = /^[0-9a-f]{32}$/.test(stream) ? this.socketsTagged(`p:${stream}`)[0] : null;
      if (!phone || !this.tagsOf(phone).includes(`to:${device.id}`)) throw new ApiError(404, 'not_found', 'That connection is gone.');
      if (this.socketsTagged(`m:${stream}`).length) throw new ApiError(409, 'conflict', 'That connection is already answered.');
      const { response, server } = this.upgrade(['mac', `m:${stream}`, `dev:${device.id}`]);
      const held = this.pending.get(stream);
      this.pending.delete(stream);
      for (const chunk of held?.chunks || []) server.send(chunk);
      return response;
    }
    throw new ApiError(404, 'not_found', 'No such relay door.');
  }

  peerOf(ws) {
    for (const tag of this.tagsOf(ws)) {
      if (tag.startsWith('p:')) return { stream: tag.slice(2), peer: this.socketsTagged(`m:${tag.slice(2)}`)[0], phone: true };
      if (tag.startsWith('m:')) return { stream: tag.slice(2), peer: this.socketsTagged(`p:${tag.slice(2)}`)[0], phone: false };
    }
    return null;
  }

  async webSocketMessage(ws, message) {
    if (this.tagsOf(ws).includes('web')) return webMessage(this, ws, message);
    const route = this.peerOf(ws);
    if (!route) return; // the listen line: nothing to do (its pings answer themselves)
    const size = typeof message === 'string' ? message.length : message.byteLength;
    if (size > RELAY.frame) {
      ws.close(1009, 'frame too big');
      return;
    }
    if (route.peer) {
      route.peer.send(message);
      return;
    }
    if (route.phone) {
      const held = this.pending.get(route.stream) || { size: 0, chunks: [] };
      held.size += size;
      held.chunks.push(message);
      this.pending.set(route.stream, held);
      if (held.size > RELAY.held) ws.close(1013, 'your Mac did not answer');
    } else {
      ws.close(1011, 'the phone is gone');
    }
  }

  async webSocketClose(ws, code) {
    if (this.tagsOf(ws).includes('web')) return webClosed(this, ws);
    const route = this.peerOf(ws);
    if (!route) return;
    this.pending.delete(route.stream);
    if (route.peer) {
      try {
        route.peer.close(code === 1005 || code === 1006 || !code ? 1000 : code, 'closed');
      } catch {
        // already closed
      }
    }
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws, 1011);
  }
}
