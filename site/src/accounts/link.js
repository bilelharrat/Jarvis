// Linking a Mac to an account (docs/accounts.md): one Durable Object per code, named by it.
// The Mac starts it with its name and public key and polls with a secret only it has; the
// signed-in iPhone reads it, then approves (the Worker makes the Mac's device on the account
// and leaves its token here, with the sync key sealed to the Mac) or denies. The first poll
// after that takes the answer and the link is gone; ten minutes after starting it's gone
// anyway (an alarm).
//
// The same class keeps the web sign-in's short-lived one-time values (eden/session.js), each
// in an object of its own named `handoff:<code>` or `oauth:<state>`: `stash { value, seconds }`
// keeps one, `take` hands it over once and forgets it (404 unknown or already taken, 410 late).

import { ApiError, json, sameText, sha256Hex } from './util.js';

export const LINK_SECONDS = 600;
// Crockford's base32 without I, L, O and U: nothing to misread.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const raw = [...bytes].map((b) => ALPHABET[b & 31]).join('');
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

// What a person typed or a QR code said, as the code; null if it can't be one.
export function cleanCode(text) {
  let raw = String(text || '').trim().toUpperCase();
  raw = raw.replace(/^JARVIS-LINK:\/\//, '').replace(/[\s-]/g, '');
  raw = raw.replace(/[IL]/g, '1').replace(/O/g, '0');
  if (raw.length !== 8 || [...raw].some((c) => !ALPHABET.includes(c))) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

// A day's counter (`count { cap, seconds, peek }`, e.g. native sign-ups per network a day, eden/session.js)
// and a deleted account's Stripe subscription still to cancel (`cancel-later { subscription }`, retried
// by the object's alarm and on Stripe's next event for it; `cancel-retry` tries at once if one is pending).
const CANCEL_TRIES = 15; // about two weeks of retries (13.5 days), the gap doubling from 5 minutes up to 2 days
const cancelGap = (tries) => Math.min(2 * 86400_000, 5 * 60_000 * 2 ** tries);

export class Link {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.storage = ctx.storage;
    this.env = env || {};
    this.now = () => Date.now();
  }

  async fetch(request) {
    const op = new URL(request.url).pathname.slice(1);
    const body = await request.json().catch(() => ({}));
    try {
      if (op === 'stash') return json(await this.stash(body));
      if (op === 'take') return json(await this.take());
      if (op === 'count') return json(await this.count(body));
      if (op === 'cancel-later') return json(await this.cancelLater(body));
      if (op === 'cancel-retry') return json(await this.cancelRetry());
      const link = await this.storage.get('link');
      if (op === 'start') return json(await this.start(link, body));
      if (!link || link.expires <= this.now()) {
        if (link) await this.storage.deleteAll();
        throw new ApiError(link ? 410 : 404, link ? 'expired' : 'not_found', link ? 'That code expired. Make a new one on the Mac.' : "That code isn't one we know. Check it on the Mac.");
      }
      if (op === 'peek') return json(this.peek(link));
      if (op === 'approve') return json(await this.settle(link, 'approved', body.result));
      if (op === 'deny') return json(await this.settle(link, 'denied', null));
      if (op === 'poll') return await this.poll(link, body.poll);
      throw new ApiError(404, 'not_found', 'No such thing.');
    } catch (error) {
      if (error instanceof ApiError) return error.response();
      throw error;
    }
  }

  async start(existing, { name, kind, public_key, app_version, poll }) {
    if (existing && existing.expires > this.now()) throw new ApiError(409, 'conflict', 'That code is taken.');
    const expires = this.now() + LINK_SECONDS * 1000;
    await this.storage.put('link', {
      name,
      kind,
      public_key,
      app_version,
      poll_hash: await sha256Hex(poll),
      expires,
      status: 'waiting',
      result: null,
    });
    if (this.storage.setAlarm) await this.storage.setAlarm(expires + 1000);
    return { expires_in: LINK_SECONDS };
  }

  peek(link) {
    if (link.status !== 'waiting') throw new ApiError(410, link.status === 'denied' ? 'denied' : 'expired', 'That code was already used. Make a new one on the Mac.');
    return {
      name: link.name,
      kind: link.kind,
      public_key: link.public_key,
      app_version: link.app_version || '',
      expires_in: Math.max(0, Math.round((link.expires - this.now()) / 1000)),
    };
  }

  async settle(link, status, result) {
    if (link.status !== 'waiting') throw new ApiError(410, 'expired', 'That code was already used. Make a new one on the Mac.');
    link.status = status;
    link.result = result;
    await this.storage.put('link', link);
    return {};
  }

  async poll(link, poll) {
    if (!poll || !sameText(link.poll_hash, await sha256Hex(String(poll)))) throw new ApiError(403, 'forbidden', "That isn't this link's secret.");
    if (link.status === 'waiting') return json({ status: 'waiting' }, 202);
    await this.storage.deleteAll();
    if (link.status === 'denied') throw new ApiError(410, 'denied', 'The link was turned down on the iPhone.');
    return json(link.result);
  }

  async stash({ value, seconds }) {
    if (await this.storage.get('stash')) throw new ApiError(409, 'conflict', 'That one is taken.');
    const expires = this.now() + Math.min(600, Math.max(1, Number(seconds) || 60)) * 1000;
    await this.storage.put('stash', { value, expires });
    if (this.storage.setAlarm) await this.storage.setAlarm(expires + 1000);
    return { expires_in: Math.round((expires - this.now()) / 1000) };
  }

  async take() {
    const kept = await this.storage.get('stash');
    if (!kept) throw new ApiError(404, 'not_found', 'That sign-in is gone. Try again.');
    await this.storage.deleteAll(); // once, whatever happens next
    if (kept.expires <= this.now()) throw new ApiError(410, 'expired', 'That sign-in took too long. Try again.');
    return { value: kept.value };
  }

  async count({ cap, seconds, peek = false }) {
    const now = this.now();
    let c = await this.storage.get('count');
    if (!c || c.expires <= now) c = { n: 0, expires: now + Math.min(2 * 86400, Math.max(60, Number(seconds) || 86400)) * 1000 };
    const max = Math.max(0, Number(cap) || 0);
    if (peek || c.n >= max) return { ok: c.n < max, n: c.n };
    c.n += 1;
    await this.storage.put('count', c);
    if (c.n === 1 && this.storage.setAlarm) await this.storage.setAlarm(c.expires + 1000);
    return { ok: true, n: c.n };
  }

  async cancelLater({ subscription }) {
    if (!/^sub_[A-Za-z0-9]{1,250}$/.test(String(subscription || ''))) throw new ApiError(400, 'bad_request', 'No subscription.');
    const had = await this.storage.get('cancel');
    if (had) return { pending: true };
    const next = this.now() + cancelGap(0);
    await this.storage.put('cancel', { subscription, tries: 0, since: this.now(), next });
    if (this.storage.setAlarm) await this.storage.setAlarm(next);
    return { pending: true };
  }

  /**
   * A pending cancel tried now: gone when Stripe takes it (or has nothing to cancel, or says a lasting no:
   * logged, not retried); otherwise tried again later, then given up loudly.
   */
  async cancelRetry() {
    const was = await this.storage.get('cancel');
    if (!was) return { pending: false };
    const { cancelSubscription } = await import('../eden/billing.js');
    const out = await cancelSubscription(this.env, was.subscription, { tries: was.tries + 1 });
    if (out !== 'failed') {
      await this.storage.deleteAll();
      return { pending: false, cancelled: out === 'cancelled', ...(out === 'cancelled' ? {} : { outcome: out }) };
    }
    // Stripe's call let other events in (the alarm and a webhook's retry at once): one that finished the
    // cancel meanwhile is never brought back (AW2-7)
    const pending = await this.storage.get('cancel');
    if (!pending) return { pending: false };
    pending.tries += 1;
    if (pending.tries >= CANCEL_TRIES) {
      console.error(`stripe: gave up cancelling a deleted account’s subscription ${pending.subscription} after ${pending.tries} tries; cancel it in the Stripe dashboard`);
      await this.storage.deleteAll();
      return { pending: false, cancelled: false, gave_up: true };
    }
    pending.next = this.now() + cancelGap(pending.tries);
    await this.storage.put('cancel', pending);
    if (this.storage.setAlarm) await this.storage.setAlarm(pending.next);
    return { pending: true };
  }

  async alarm() {
    if (await this.storage.get('cancel')) {
      await this.cancelRetry();
      return;
    }
    await this.storage.deleteAll();
  }
}
