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
export const AUDIT_KEEP = 250;
export const DEFAULT_RPM = 60;
export const DEFAULT_DAILY_USD = 10;
export const MAX_RPM = 6000;
export const MAX_DAILY_USD = 10000;
export const MAX_MONTHLY_USD = 250000;
const pad = (n) => String(n).padStart(12, '0');
export const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
export const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const num = (x, fallback, max) => {
  const n = Number(x);
  return x === undefined || x === null || x === '' ? fallback : Number.isFinite(n) && n >= 0 && n <= max ? n : null;
};

const VALID_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const VALID_KINDS = ['chat', 'route', 'failover', 'cascade', 'batch', 'analyze', 'risk'];
const VALID_BREACH = ['failover', 'reject', 'throttle'];

export const DEFAULT_POLICY = {
  daily_pool_cap_usd: 500,
  monthly_pool_cap_usd: 10000,
  slack_alerts_enabled: true,
  webhook_url: '',
  alert_thresholds: [50, 80, 95],
  ttft_breaker_enabled: true,
  ttft_threshold_ms: 2500,
  burst_429_failover: true,
  rotation_grace_24h: true,
  atomic_hold_enabled: true,
  fallback_chain: [
    { rank: 1, provider: 'anthropic', name: 'Anthropic Direct Pool', models: 'Claude 3.5 Sonnet / Haiku', status: 'primary' },
    { rank: 2, provider: 'openai', name: 'OpenAI Scale Pool', models: 'GPT-4o / 4o-mini', status: 'hot_standby' },
    { rank: 3, provider: 'gemini', name: 'Google Gemini 1.5 Pro', models: 'Gemini 1.5 Pro / Flash', status: 'hot_standby' },
    { rank: 4, provider: 'kimi', name: 'Moonshot Kimi K2', models: 'Kimi K2 Long Context', status: 'cold_standby' },
  ],
};

/** A client as the admin sees it (no hash). */
const view = (c) => ({
  id: c.id,
  name: c.name,
  key_hint: c.hint,
  created: new Date(c.created).toISOString(),
  revoked: c.revoked ? new Date(c.revoked).toISOString() : null,
  paused: Boolean(c.paused),
  rpm: c.rpm,
  daily_usd: c.daily_usd,
  ...(c.monthly_usd !== undefined && c.monthly_usd !== null ? { monthly_usd: c.monthly_usd } : {}),
  ...(c.tag ? { tag: c.tag } : {}),
  ...(c.ip_whitelist && c.ip_whitelist.length ? { ip_whitelist: c.ip_whitelist } : {}),
  ...(c.on_cap_breach ? { on_cap_breach: c.on_cap_breach } : {}),
  ...(c.prev_expires && c.prev_expires > Date.now() ? { grace_until: new Date(c.prev_expires).toISOString() } : {}),
  service_keys: c.service_keys,
  ...(c.max_effort ? { max_effort: c.max_effort } : {}),
  ...(c.providers ? { providers: c.providers } : {}),
  ...(c.models ? { models: c.models } : {}),
});

/** The limits in a create/update body; ApiError 400 on a bad one. */
function limits(body, base = {}) {
  const rpm = num(body.rpm, base.rpm ?? DEFAULT_RPM, MAX_RPM);
  const daily = num(body.daily_usd, base.daily_usd ?? DEFAULT_DAILY_USD, MAX_DAILY_USD);
  if (rpm === null || !Number.isInteger(rpm) || rpm < 1) throw new ApiError(400, 'bad_request', `rpm is a whole number from 1 to ${MAX_RPM}.`);
  if (daily === null) throw new ApiError(400, 'bad_request', `daily_usd is a number from 0 to ${MAX_DAILY_USD}.`);
  const monthlyRaw = body.monthly_usd === undefined ? base.monthly_usd ?? null : body.monthly_usd === null || body.monthly_usd === '' ? null : num(body.monthly_usd, null, MAX_MONTHLY_USD);
  if (body.monthly_usd !== undefined && body.monthly_usd !== null && body.monthly_usd !== '' && monthlyRaw === null) {
    throw new ApiError(400, 'bad_request', `monthly_usd is a number from 0 to ${MAX_MONTHLY_USD}.`);
  }
  const service = body.service_keys === undefined ? Boolean(base.service_keys) : body.service_keys === true;
  const paused = body.paused === undefined ? Boolean(base.paused) : body.paused === true;
  const maxEffortRaw = body.max_effort === undefined ? base.max_effort ?? null : body.max_effort;
  if (maxEffortRaw !== null && maxEffortRaw !== undefined && !VALID_EFFORTS.includes(String(maxEffortRaw))) {
    throw new ApiError(400, 'bad_request', `max_effort must be one of ${VALID_EFFORTS.join(', ')}.`);
  }
  const providersRaw = body.providers ?? body.allowed_providers ?? base.providers ?? null;
  const modelsRaw = body.models ?? body.allowed_models ?? base.models ?? null;
  const tagRaw = body.tag === undefined ? base.tag ?? null : body.tag ? String(body.tag).trim().slice(0, 48) : null;
  const ipRaw = body.ip_whitelist === undefined ? base.ip_whitelist ?? null : Array.isArray(body.ip_whitelist) ? body.ip_whitelist.map((s) => String(s).trim()).filter(Boolean).slice(0, 16) : typeof body.ip_whitelist === 'string' && body.ip_whitelist.trim() ? body.ip_whitelist.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean).slice(0, 16) : null;
  const breachRaw = body.on_cap_breach === undefined ? base.on_cap_breach ?? null : VALID_BREACH.includes(String(body.on_cap_breach)) ? String(body.on_cap_breach) : null;
  return {
    rpm,
    daily_usd: daily,
    monthly_usd: monthlyRaw,
    paused,
    tag: tagRaw,
    ip_whitelist: ipRaw && ipRaw.length ? ipRaw : null,
    on_cap_breach: breachRaw,
    service_keys: service,
    ...(maxEffortRaw ? { max_effort: String(maxEffortRaw) } : { max_effort: null }),
    ...(Array.isArray(providersRaw) && providersRaw.length ? { providers: providersRaw.map(String) } : { providers: null }),
    ...(Array.isArray(modelsRaw) && modelsRaw.length ? { models: modelsRaw.map(String) } : { models: null }),
  };
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
      if (op === 'dashboard') return json(await this.dashboard());
      if (op === 'policy') return json(await this.policy(body));
      if (op === 'update' || op === 'revoke' || op === 'pause' || op === 'resume') {
        const c = await this.client(body.id);
        let next;
        if (op === 'revoke') next = { ...c, revoked: c.revoked || this.now() };
        else if (op === 'pause') next = { ...c, paused: true };
        else if (op === 'resume') next = { ...c, paused: false };
        else next = { ...c, ...limits(body, c), ...(body.name ? { name: String(body.name).slice(0, 80) } : {}) };
        await this.storage.put(`client:${c.id}`, next);
        await this.auditLog(op, body.actor, c.id, next.name, op === 'update' ? `daily=$${next.daily_usd}, monthly=${next.monthly_usd ?? 'none'}, rpm=${next.rpm}` : op);
        return json({ client: view(next) });
      }
      if (op === 'rotate') return json(await this.rotate(body));
      if (op === 'admit') return json(await this.admit(body));
      if (op === 'hold') return json(await this.hold(body));
      if (op === 'release') return json(await this.release(body));
      if (op === 'record') return json(await this.record(body));
      if (op === 'usage') return json(await this.usage(body));
      throw new ApiError(404, 'not_found', 'No such operation.');
    } catch (error) {
      if (error instanceof ApiError) return error.response();
      throw error;
    }
  }

  async auditLog(action, actor, targetId, targetName, detail = '') {
    const seq = ((await this.storage.get('audit_seq')) || 0) + 1;
    const entry = {
      seq,
      time: new Date(this.now()).toISOString(),
      action: String(action || ''),
      actor: String(actor || 'admin').slice(0, 80),
      target_id: targetId ? String(targetId) : null,
      target_name: targetName ? String(targetName).slice(0, 80) : null,
      detail: String(detail || '').slice(0, 200),
    };
    await this.storage.put({ audit_seq: seq, [`audit:${pad(seq)}`]: entry });
    if (seq > AUDIT_KEEP) await this.storage.delete(`audit:${pad(seq - AUDIT_KEEP)}`);
  }

  async policy(body = {}) {
    const cur = { ...DEFAULT_POLICY, ...((await this.storage.get('config:policy')) || {}) };
    if (!body || !body.update) return { policy: cur };
    const u = body.update;
    const next = {
      ...cur,
      ...(num(u.daily_pool_cap_usd, null, MAX_MONTHLY_USD) !== null ? { daily_pool_cap_usd: num(u.daily_pool_cap_usd, cur.daily_pool_cap_usd, MAX_MONTHLY_USD) } : {}),
      ...(num(u.monthly_pool_cap_usd, null, MAX_MONTHLY_USD) !== null ? { monthly_pool_cap_usd: num(u.monthly_pool_cap_usd, cur.monthly_pool_cap_usd, MAX_MONTHLY_USD) } : {}),
      ...(typeof u.slack_alerts_enabled === 'boolean' ? { slack_alerts_enabled: u.slack_alerts_enabled } : {}),
      ...(typeof u.webhook_url === 'string' ? { webhook_url: u.webhook_url.trim().slice(0, 256) } : {}),
      ...(Array.isArray(u.alert_thresholds) ? { alert_thresholds: u.alert_thresholds.map(Number).filter((n) => n > 0 && n <= 100).slice(0, 5) } : {}),
      ...(typeof u.ttft_breaker_enabled === 'boolean' ? { ttft_breaker_enabled: u.ttft_breaker_enabled } : {}),
      ...(num(u.ttft_threshold_ms, null, 60000) !== null ? { ttft_threshold_ms: Math.max(200, Math.round(Number(u.ttft_threshold_ms))) } : {}),
      ...(typeof u.burst_429_failover === 'boolean' ? { burst_429_failover: u.burst_429_failover } : {}),
      ...(typeof u.rotation_grace_24h === 'boolean' ? { rotation_grace_24h: u.rotation_grace_24h } : {}),
      ...(typeof u.atomic_hold_enabled === 'boolean' ? { atomic_hold_enabled: u.atomic_hold_enabled } : {}),
      ...(Array.isArray(u.fallback_chain) && u.fallback_chain.length ? { fallback_chain: u.fallback_chain.slice(0, 8) } : {}),
    };
    await this.storage.put('config:policy', next);
    await this.auditLog('policy', body.actor, null, 'Failover & Alert Policy', `Updated failover/alert settings`);
    return { policy: next };
  }

  async dashboard() {
    const now = this.now();
    const todayStr = dayOf(now);
    const monthStr = monthOf(now);
    const [clientRows, auditRows, savedPolicy] = await Promise.all([
      this.storage.list({ prefix: 'client:' }),
      this.storage.list({ prefix: 'audit:', reverse: true, limit: 60 }),
      this.storage.get('config:policy'),
    ]);
    const policy = { ...DEFAULT_POLICY, ...(savedPolicy || {}) };
    const clients = [];
    let activeKeys = 0;
    let pausedKeys = 0;
    let revokedKeys = 0;
    let spentToday = 0;
    let spentMonth = 0;
    let reqToday = 0;
    let reqMonth = 0;
    let errToday = 0;
    for (const c of clientRows.values()) {
      const [d, m] = await Promise.all([
        this.storage.get(`day:${c.id}:${todayStr}`),
        this.storage.get(`month:${c.id}:${monthStr}`),
      ]);
      const dayUsd = round6((d?.usd || 0) + (d?.hold_usd || 0));
      const monthUsd = round6(m?.usd || d?.usd || 0);
      const dayReqs = d?.requests || 0;
      const monthReqs = m?.requests || dayReqs;
      const dayErrs = d?.errors || 0;
      if (c.revoked) revokedKeys++;
      else if (c.paused) pausedKeys++;
      else activeKeys++;
      spentToday = round6(spentToday + dayUsd);
      spentMonth = round6(spentMonth + monthUsd);
      reqToday += dayReqs;
      reqMonth += monthReqs;
      errToday += dayErrs;
      clients.push({
        ...view(c),
        spent_today_usd: dayUsd,
        spent_month_usd: monthUsd,
        requests_today: dayReqs,
        requests_month: monthReqs,
        errors_today: dayErrs,
      });
    }
    clients.sort((a, b) => (a.revoked ? 1 : 0) - (b.revoked ? 1 : 0) || b.created.localeCompare(a.created));
    return {
      clients,
      totals: {
        active_keys: activeKeys,
        paused_keys: pausedKeys,
        revoked_keys: revokedKeys,
        total_keys: clients.length,
        spent_today_usd: spentToday,
        spent_month_usd: spentMonth,
        requests_today: reqToday,
        requests_month: reqMonth,
        errors_today: errToday,
      },
      policy,
      audits: [...auditRows.values()],
    };
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
    await this.auditLog('create', body.actor, c.id, c.name, `${c.hint} · daily=$${c.daily_usd}${c.monthly_usd ? `, monthly=$${c.monthly_usd}` : ''}, rpm=${c.rpm}`);
    return { client: view(c) };
  }

  /** Rotate a client's key hash, with optional grace_period_ms for the old hash. */
  async rotate(body) {
    const c = await this.client(body.id);
    if (c.revoked) throw new ApiError(400, 'revoked_api_key', 'Cannot rotate a revoked client key.');
    if (!/^[a-f0-9]{64}$/.test(String(body.hash))) throw new ApiError(400, 'bad_request', 'hash is needed.');
    const graceMs = Number.isFinite(Number(body.grace_period_ms)) && Number(body.grace_period_ms) > 0 ? Math.floor(Number(body.grace_period_ms)) : 0;
    const oldHash = c.hash;
    const prevOldHash = c.prev_hash;
    const next = {
      ...c,
      hash: body.hash,
      hint: String(body.hint || c.hint),
      prev_hash: graceMs > 0 ? oldHash : null,
      prev_expires: graceMs > 0 ? this.now() + graceMs : null,
    };
    await this.storage.put({ [`client:${c.id}`]: next, [`hash:${next.hash}`]: c.id });
    if (graceMs <= 0 && oldHash && oldHash !== next.hash) {
      await this.storage.delete(`hash:${oldHash}`);
    }
    if (prevOldHash && prevOldHash !== oldHash && prevOldHash !== next.hash) {
      await this.storage.delete(`hash:${prevOldHash}`);
    }
    await this.auditLog('rotate', body.actor, c.id, c.name, `Rotated to ${next.hint} (grace: ${Math.round(graceMs / 3600000)}h)`);
    return { client: view(next), grace_period_ms: graceMs };
  }

  /** A request's key hash → its client, counted against the minute's limit; with today's spend. */
  async admit({ hash }) {
    const id = typeof hash === 'string' ? await this.storage.get(`hash:${hash}`) : null;
    const c = id ? await this.storage.get(`client:${id}`) : null;
    if (!c) throw new ApiError(401, 'invalid_api_key', 'Invalid API key.');
    const now = this.now();
    if (c.hash !== hash) {
      if (c.prev_hash === hash && c.prev_expires && c.prev_expires > now) {
        // Allowed within rotation grace period
      } else {
        await this.storage.delete(`hash:${hash}`);
        throw new ApiError(401, 'invalid_api_key', 'Invalid API key.');
      }
    }
    if (c.revoked) throw new ApiError(401, 'revoked_api_key', 'This API key has been revoked.');
    if (c.paused) throw new ApiError(429, 'key_paused', 'This API key is currently held by the administrator.');
    const minute = Math.floor(now / 60_000);
    const r = (await this.storage.get(`rpm:${id}`)) || { minute, count: 0 };
    const count = r.minute === minute ? r.count : 0;
    if (count >= c.rpm) {
      const retry = Math.max(1, Math.ceil(((minute + 1) * 60_000 - now) / 1000));
      throw new ApiError(429, 'rate_limit_exceeded', `Rate limit reached: ${c.rpm} requests a minute. Try again in ${retry} s.`, { 'retry-after': String(retry) });
    }
    await this.storage.put(`rpm:${id}`, { minute, count: count + 1 });
    const [today, month] = await Promise.all([
      this.storage.get(`day:${id}:${dayOf(now)}`),
      this.storage.get(`month:${id}:${monthOf(now)}`),
    ]);
    const spent = round6(((today && today.usd) || 0) + ((today && today.hold_usd) || 0));
    const spentMonth = round6((month && month.usd) || spent);
    return {
      client: {
        id: c.id,
        name: c.name,
        rpm: c.rpm,
        daily_usd: c.daily_usd,
        ...(c.monthly_usd !== undefined && c.monthly_usd !== null ? { monthly_usd: c.monthly_usd } : {}),
        ...(c.on_cap_breach ? { on_cap_breach: c.on_cap_breach } : {}),
        service_keys: c.service_keys,
        ...(c.max_effort ? { max_effort: c.max_effort } : {}),
        ...(c.providers ? { providers: c.providers } : {}),
        ...(c.models ? { models: c.models } : {}),
      },
      spent_today_usd: spent,
      spent_month_usd: spentMonth,
    };
  }

  /** Atomically reserve estimated spend before calling an upstream provider. */
  async hold({ id, estimated_usd }) {
    const c = await this.client(id);
    const amount = round6(Math.max(0, Number(estimated_usd) || 0));
    const now = this.now();
    const dayKey = `day:${c.id}:${dayOf(now)}`;
    const d = (await this.storage.get(dayKey)) || { requests: 0, errors: 0, usd: 0, hold_usd: 0, tokens_in: 0, tokens_out: 0 };
    const spent = round6(d.usd || 0);
    const held = round6(d.hold_usd || 0);
    if (round6(spent + held + amount) > c.daily_usd) {
      throw new ApiError(429, 'daily_spend_cap', `Daily spend cap reached: $${c.daily_usd} a day (spent $${spent} today, UTC). Ask Eden to raise it, or try again tomorrow.`);
    }
    if (c.monthly_usd !== undefined && c.monthly_usd !== null) {
      const m = (await this.storage.get(`month:${c.id}:${monthOf(now)}`)) || { usd: 0 };
      if (round6((m.usd || 0) + held + amount) > c.monthly_usd && c.on_cap_breach === 'reject') {
        throw new ApiError(429, 'monthly_spend_cap', `Monthly spend cap reached: $${c.monthly_usd} a month (spent $${round6(m.usd || 0)} this month, UTC).`);
      }
    }
    if (amount > 0) {
      await this.storage.put(dayKey, { ...d, hold_usd: round6(held + amount) });
    }
    return { ok: true, held_usd: amount, spent_today_usd: round6(spent + held + amount) };
  }

  /** Release an unrecorded spend hold if a request was aborted before completion. */
  async release({ id, held_usd }) {
    const c = await this.client(id);
    const amount = round6(Math.max(0, Number(held_usd) || 0));
    if (amount <= 0) return { ok: true };
    const dayKey = `day:${c.id}:${dayOf(this.now())}`;
    const d = (await this.storage.get(dayKey)) || { requests: 0, errors: 0, usd: 0, hold_usd: 0, tokens_in: 0, tokens_out: 0 };
    const nextHold = round6(Math.max(0, (d.hold_usd || 0) - amount));
    await this.storage.put(dayKey, { ...d, hold_usd: nextHold });
    return { ok: true };
  }

  /** One request's usage line (no content), added to the day's totals; the oldest past LOG_KEEP dropped. */
  async record({ id, entry, held_usd }) {
    const c = await this.client(id);
    const e = entry || {};
    const now = this.now();
    const line = {
      time: new Date(now).toISOString(),
      kind: VALID_KINDS.includes(e.kind) ? e.kind : 'chat',
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
    const monthKey = `month:${c.id}:${monthOf(now)}`;
    const [dRaw, mRaw] = await Promise.all([
      this.storage.get(dayKey),
      this.storage.get(monthKey),
    ]);
    const d = dRaw || { requests: 0, errors: 0, usd: 0, hold_usd: 0, tokens_in: 0, tokens_out: 0 };
    const m = mRaw || { requests: 0, errors: 0, usd: 0, tokens_in: 0, tokens_out: 0 };
    const releaseAmt = round6(Math.max(0, Number(held_usd) || 0));
    const nextHold = round6(Math.max(0, (d.hold_usd || 0) - releaseAmt));
    const next = {
      requests: d.requests + 1,
      errors: d.errors + (line.status >= 400 ? 1 : 0),
      usd: round6(d.usd + line.cost_usd),
      hold_usd: nextHold,
      tokens_in: d.tokens_in + line.tokens_in,
      tokens_out: d.tokens_out + line.tokens_out + line.reasoning_tokens,
    };
    const nextMonth = {
      requests: m.requests + 1,
      errors: m.errors + (line.status >= 400 ? 1 : 0),
      usd: round6(m.usd + line.cost_usd),
      tokens_in: m.tokens_in + line.tokens_in,
      tokens_out: m.tokens_out + line.tokens_out + line.reasoning_tokens,
    };
    await this.storage.put({ [`seq:${c.id}`]: seq, [`log:${c.id}:${pad(seq)}`]: line, [dayKey]: next, [monthKey]: nextMonth });
    if (seq > LOG_KEEP) await this.storage.delete(`log:${c.id}:${pad(seq - LOG_KEEP)}`);
    return { ok: true, spent_today_usd: next.usd, spent_month_usd: nextMonth.usd };
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
