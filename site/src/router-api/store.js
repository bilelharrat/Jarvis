// Eden Router API's clients, limits and usage (src/router-api/api.js): one Durable Object ("clients",
// binding ROUTER_API) for the private beta's few clients, so the per-minute count and the daily spend
// are exact (a Durable Object handles one storage operation at a time).
//
// Storage, per client id:
//   client:<id>          { id, name, hash, hint, created, revoked, rpm, daily_usd, service_keys }
//   hash:<sha256 of key> id   (the key itself is never stored; it is shown once, at create)
//   rpm:<id>             { minute, count }
//   day:<id>:<YYYY-MM-DD> { requests, errors, usd, tokens_in, tokens_out }
//   seq:<id>             the last log number
//   log:<id>:<seq>       { time, kind, model, provider, effort, tokens_in, tokens_out, reasoning_tokens, cost_usd,
//                          estimated_usd, latency_ms, status, stream, fallback } (never a prompt, answer or key)
// Only the last LOG_KEEP log entries per client are kept.

import { ApiError, json } from '../accounts/util.js';

export const LOG_KEEP = 5000;
export const DEFAULT_RPM = 60;
export const DEFAULT_DAILY_USD = 10;
export const MAX_RPM = 6000;
export const MAX_DAILY_USD = 10000;
const pad = (n) => String(n).padStart(12, '0');
export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const num = (x, fallback, max) => {
  const n = Number(x);
  return x === undefined || x === null || x === '' ? fallback : Number.isFinite(n) && n >= 0 && n <= max ? n : null;
};

/** A client as the admin sees it (no hash). */
const view = (c) => ({ id: c.id, name: c.name, key_hint: c.hint, created: new Date(c.created).toISOString(), revoked: c.revoked ? new Date(c.revoked).toISOString() : null, rpm: c.rpm, daily_usd: c.daily_usd, service_keys: c.service_keys });

/** The limits in a create/update body; ApiError 400 on a bad one. */
function limits(body, base = {}) {
  const rpm = num(body.rpm, base.rpm ?? DEFAULT_RPM, MAX_RPM);
  const daily = num(body.daily_usd, base.daily_usd ?? DEFAULT_DAILY_USD, MAX_DAILY_USD);
  if (rpm === null || !Number.isInteger(rpm) || rpm < 1) throw new ApiError(400, 'bad_request', `rpm is a whole number from 1 to ${MAX_RPM}.`);
  if (daily === null) throw new ApiError(400, 'bad_request', `daily_usd is a number from 0 to ${MAX_DAILY_USD}.`);
  const service = body.service_keys === undefined ? Boolean(base.service_keys) : body.service_keys === true;
  return { rpm, daily_usd: daily, service_keys: service };
}

export class RouterApi {
  constructor(ctx) {
    this.storage = ctx.storage;
    this.now = () => Date.now();
  }

  async fetch(request) {
    const op = new URL(request.url).pathname.slice(1);
    const body = await request.json().catch(() => ({}));
    try {
      if (op === 'create') return json(await this.create(body));
      if (op === 'list') {
        const rows = await this.storage.list({ prefix: 'client:' });
        return json({ clients: [...rows.values()].map(view) });
      }
      if (op === 'update' || op === 'revoke') {
        const c = await this.client(body.id);
        const next = op === 'revoke' ? { ...c, revoked: c.revoked || this.now() } : { ...c, ...limits(body, c), ...(body.name ? { name: String(body.name).slice(0, 80) } : {}) };
        await this.storage.put(`client:${c.id}`, next);
        return json({ client: view(next) });
      }
      if (op === 'admit') return json(await this.admit(body));
      if (op === 'record') return json(await this.record(body));
      if (op === 'usage') return json(await this.usage(body));
      throw new ApiError(404, 'not_found', 'No such operation.');
    } catch (error) {
      if (error instanceof ApiError) return error.response();
      throw error;
    }
  }

  async client(id) {
    const c = typeof id === 'string' && /^[a-f0-9]{16}$/.test(id) ? await this.storage.get(`client:${id}`) : null;
    if (!c) throw new ApiError(404, 'no_client', 'No client with that id.');
    return c;
  }

  /** { id, hash, hint, name, limits }: the api module makes the key and its hash; only the hash lands here. */
  async create(body) {
    if (!/^[a-f0-9]{16}$/.test(String(body.id)) || !/^[a-f0-9]{64}$/.test(String(body.hash))) throw new ApiError(400, 'bad_request', 'id and hash are needed.');
    if (await this.storage.get(`client:${body.id}`)) throw new ApiError(409, 'exists', 'That id exists.');
    const c = { id: body.id, name: String(body.name || 'client').slice(0, 80), hash: body.hash, hint: String(body.hint || ''), created: this.now(), revoked: null, ...limits(body) };
    await this.storage.put({ [`client:${c.id}`]: c, [`hash:${c.hash}`]: c.id });
    return { client: view(c) };
  }

  /** A request's key hash → its client, counted against the minute's limit; with today's spend. */
  async admit({ hash }) {
    const id = typeof hash === 'string' ? await this.storage.get(`hash:${hash}`) : null;
    const c = id ? await this.storage.get(`client:${id}`) : null;
    if (!c) throw new ApiError(401, 'invalid_api_key', 'Invalid API key.');
    if (c.revoked) throw new ApiError(401, 'revoked_api_key', 'This API key has been revoked.');
    const now = this.now();
    const minute = Math.floor(now / 60_000);
    const r = (await this.storage.get(`rpm:${id}`)) || { minute, count: 0 };
    const count = r.minute === minute ? r.count : 0;
    if (count >= c.rpm) {
      const retry = Math.max(1, Math.ceil(((minute + 1) * 60_000 - now) / 1000));
      throw new ApiError(429, 'rate_limit_exceeded', `Rate limit reached: ${c.rpm} requests a minute. Try again in ${retry} s.`, { 'retry-after': String(retry) });
    }
    await this.storage.put(`rpm:${id}`, { minute, count: count + 1 });
    const today = (await this.storage.get(`day:${id}:${dayOf(now)}`)) || { usd: 0 };
    return { client: { id: c.id, name: c.name, rpm: c.rpm, daily_usd: c.daily_usd, service_keys: c.service_keys }, spent_today_usd: round6(today.usd || 0) };
  }

  /** One request's usage line (no content), added to the day's totals; the oldest past LOG_KEEP dropped. */
  async record({ id, entry }) {
    const c = await this.client(id);
    const e = entry || {};
    const now = this.now();
    const line = {
      time: new Date(now).toISOString(),
      kind: ['chat', 'route'].includes(e.kind) ? e.kind : 'chat',
      model: e.model ? String(e.model).slice(0, 64) : null,
      provider: e.provider ? String(e.provider).slice(0, 16) : null,
      effort: e.effort ? String(e.effort).slice(0, 12) : null,
      tokens_in: Math.max(0, Math.round(Number(e.tokens_in) || 0)),
      tokens_out: Math.max(0, Math.round(Number(e.tokens_out) || 0)),
      reasoning_tokens: Math.max(0, Math.round(Number(e.reasoning_tokens) || 0)),
      cost_usd: round6(Math.max(0, Number(e.cost_usd) || 0)),
      estimated_usd: round6(Math.max(0, Number(e.estimated_usd) || 0)),
      latency_ms: Math.max(0, Math.round(Number(e.latency_ms) || 0)),
      status: Math.round(Number(e.status) || 0),
      stream: e.stream === true,
      fallback: e.fallback ? String(e.fallback).slice(0, 64) : null,
    };
    const seq = ((await this.storage.get(`seq:${c.id}`)) || 0) + 1;
    const dayKey = `day:${c.id}:${dayOf(now)}`;
    const d = (await this.storage.get(dayKey)) || { requests: 0, errors: 0, usd: 0, tokens_in: 0, tokens_out: 0 };
    const next = { requests: d.requests + 1, errors: d.errors + (line.status >= 400 ? 1 : 0), usd: round6(d.usd + line.cost_usd), tokens_in: d.tokens_in + line.tokens_in, tokens_out: d.tokens_out + line.tokens_out + line.reasoning_tokens };
    await this.storage.put({ [`seq:${c.id}`]: seq, [`log:${c.id}:${pad(seq)}`]: line, [dayKey]: next });
    if (seq > LOG_KEEP) await this.storage.delete(`log:${c.id}:${pad(seq - LOG_KEEP)}`);
    return { ok: true, spent_today_usd: next.usd };
  }

  /** The client's last `limit` lines (newest first) and its daily totals for `days` days. */
  async usage({ id, limit = 100, days = 7 }) {
    const c = await this.client(id);
    const n = Math.min(1000, Math.max(1, Math.floor(Number(limit) || 100)));
    const span = Math.min(31, Math.max(1, Math.floor(Number(days) || 7)));
    const lines = await this.storage.list({ prefix: `log:${c.id}:`, reverse: true, limit: n });
    const now = this.now();
    const daily = [];
    for (let i = 0; i < span; i++) {
      const day = dayOf(now - i * 86_400_000);
      const d = await this.storage.get(`day:${c.id}:${day}`);
      daily.push({ day, requests: 0, errors: 0, usd: 0, tokens_in: 0, tokens_out: 0, ...(d || {}) });
    }
    return { client: view(c), limits: { rpm: c.rpm, daily_usd: c.daily_usd }, spent_today_usd: daily[0].usd, daily, data: [...lines.values()] };
  }
}
