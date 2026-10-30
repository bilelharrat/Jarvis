// Eden News storage: a Durable Object of its own (binding NEWS, class NewsDesk), not the account's, so News never
// touches accounts/account.js. One object per signed-in reader (`reader:<account id>`) keeps their profile; one
// shared object (`stories`) keeps the clustered stories for STORIES_TTL_MS, so the source is asked and the
// stories clustered once for everyone, not per reader.
//
//   POST https://news/profile-get   {}                 → { profile | null }
//   POST https://news/profile-put   { profile }        → { ok }
//   POST https://news/stories-get   { now }            → { stories, provider, sample, fetchedAt } | { stale: true }
//   POST https://news/stories-put   { stories, … }     → { ok }   (kept in chunks of CHUNK stories)
//   POST https://news/search-get    { query, now }     → { articles, at } | { stale: true }   (SEARCH_TTL_MS)
//   POST https://news/search-put    { query, articles } → { ok }
//   POST https://news/erase         {}                 → { ok }   (the reader's own object: Delete account, "Reset News")

export const STORIES_TTL_MS = 10 * 60e3;
export const SEARCH_TTL_MS = 20 * 60e3; // a reader's follow or city, searched
const CHUNK = 40; // stories per stored value
const MAX_PROFILE_BYTES = 64 * 1024;

export class NewsDesk {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.storage = ctx.storage;
    this.env = env;
  }

  async fetch(request) {
    const op = new URL(request.url).pathname.slice(1);
    const body = await request.json().catch(() => ({}));
    switch (op) {
      case 'profile-get':
        return Response.json({ profile: (await this.storage.get('profile')) ?? null });
      case 'profile-put': {
        const text = JSON.stringify(body.profile ?? null);
        if (!body.profile || text.length > MAX_PROFILE_BYTES) return Response.json({ error: 'Profile missing or too big.' }, { status: 400 });
        await this.storage.put('profile', body.profile);
        return Response.json({ ok: true });
      }
      case 'stories-get': {
        const meta = await this.storage.get('stories');
        const now = Number(body.now) || Date.now();
        if (!meta || now - meta.fetchedAt > STORIES_TTL_MS) return Response.json({ stale: true });
        const parts = await this.storage.get(Array.from({ length: meta.chunks || 0 }, (_, i) => `stories:${i}`));
        const stories = Array.from({ length: meta.chunks || 0 }, (_, i) => parts.get(`stories:${i}`) || []).flat();
        return Response.json({ stories, provider: meta.provider, sample: meta.sample, fetchedAt: meta.fetchedAt });
      }
      case 'stories-put': {
        // in chunks: a day of real stories is more than one stored value may hold
        const stories = body.stories || [];
        const chunks = Math.ceil(stories.length / CHUNK);
        const put = {};
        for (let i = 0; i < chunks; i++) put[`stories:${i}`] = stories.slice(i * CHUNK, (i + 1) * CHUNK);
        put.stories = { chunks, provider: body.provider, sample: Boolean(body.sample), fetchedAt: Number(body.fetchedAt) || Date.now() };
        await this.storage.put(put);
        return Response.json({ ok: true });
      }
      case 'search-get': {
        const hit = await this.storage.get(`q:${String(body.query || '').toLowerCase()}`);
        const now = Number(body.now) || Date.now();
        return Response.json(hit && now - hit.at <= SEARCH_TTL_MS ? hit : { stale: true });
      }
      case 'search-put': {
        const at = Number(body.at) || Date.now();
        await this.storage.put(`q:${String(body.query || '').toLowerCase()}`, { articles: (body.articles || []).slice(0, 20), at });
        // what readers follow isn't kept past its cache time
        const stale = [...(await this.storage.list({ prefix: 'q:' }))].filter(([, v]) => at - v.at > SEARCH_TTL_MS).map(([k]) => k);
        for (let i = 0; i < stale.length; i += 128) await this.storage.delete(stale.slice(i, i + 128));
        return Response.json({ ok: true });
      }
      case 'vault-lookup': {
        const hash = String(body.canonicalHash || '');
        if (hash) {
          const exact = await this.storage.get(`v:${hash}`);
          if (exact) return Response.json({ entries: [exact] });
        }
        const map = await this.storage.list({ prefix: 'v:', limit: 25000 });
        return Response.json({ entries: [...map.values()] });
      }
      case 'vault-put': {
        const entry = body.entry;
        if (!entry || typeof entry.canonicalHash !== 'string' || !entry.canonicalHash) {
          return Response.json({ error: 'Invalid vault entry.' }, { status: 400 });
        }
        await this.storage.put(`v:${entry.canonicalHash}`, entry);
        const map = await this.storage.list({ prefix: 'v:' });
        if (map.size > 25000) {
          const sorted = [...map.entries()].sort((a, b) => (a[1]?.createdAt || 0) - (b[1]?.createdAt || 0));
          const toDelete = sorted.slice(0, map.size - 25000).map(([k]) => k);
          for (let i = 0; i < toDelete.length; i += 128) await this.storage.delete(toDelete.slice(i, i + 128));
        }
        return Response.json({ ok: true });
      }
      case 'vault-seed': {
        const seeded = await this.storage.get('vault:seeded_v3');
        if (seeded && !body.force) return Response.json({ ok: true, alreadySeeded: true });
        const entries = Array.isArray(body.entries) ? body.entries : [];
        for (let i = 0; i < entries.length; i += 120) {
          const batch = {};
          for (const e of entries.slice(i, i + 120)) {
            if (e && typeof e.canonicalHash === 'string' && e.canonicalHash) {
              batch[`v:${e.canonicalHash}`] = e;
            }
          }
          if (Object.keys(batch).length > 0) await this.storage.put(batch);
        }
        await this.storage.put('vault:seeded_v3', { at: Date.now(), count: entries.length });
        return Response.json({ ok: true, count: entries.length });
      }
      case 'flag-put': {
        const flag = body.flag;
        if (!flag || typeof flag.id !== 'string' || !flag.id) {
          return Response.json({ error: 'Invalid flag entry.' }, { status: 400 });
        }
        await this.storage.put(`f:${flag.id}`, flag);
        const map = await this.storage.list({ prefix: 'f:' });
        if (map.size > 2000) {
          const sorted = [...map.entries()].sort((a, b) => (a[1]?.at || 0) - (b[1]?.at || 0));
          const toDelete = sorted.slice(0, map.size - 2000).map(([k]) => k);
          for (let i = 0; i < toDelete.length; i += 128) await this.storage.delete(toDelete.slice(i, i + 128));
        }
        return Response.json({ ok: true });
      }
      case 'flag-list': {
        const limit = Math.min(200, Math.max(1, Number(body.limit) || 50));
        const map = await this.storage.list({ prefix: 'f:' });
        const flags = [...map.values()].sort((a, b) => (b?.at || 0) - (a?.at || 0)).slice(0, limit);
        return Response.json({ flags });
      }
      case 'erase':
        await this.storage.deleteAll();
        return Response.json({ ok: true });
      default:
        return Response.json({ error: 'No such thing.' }, { status: 404 });
    }
  }
}

const stub = (env, name) => env.NEWS.get(env.NEWS.idFromName(name));
async function call(env, name, op, body = {}) {
  const r = await stub(env, name).fetch(`https://news/${op}`, { method: 'POST', body: JSON.stringify(body) });
  const out = await r.json();
  if (!r.ok) throw new Error(out.error || `news ${op} failed`);
  return out;
}

export const readerKey = (account) => `reader:${account}`;
export const getProfile = async (env, account) => (await call(env, readerKey(account), 'profile-get')).profile;
export const putProfile = (env, account, profile) => call(env, readerKey(account), 'profile-put', { profile });
export const eraseReader = (env, account) => call(env, readerKey(account), 'erase');
export const getStories = (env, now) => call(env, 'stories', 'stories-get', { now });
export const putStories = (env, value) => call(env, 'stories', 'stories-put', value);
export const getSearch = (env, query, now) => call(env, 'stories', 'search-get', { query, now });
export const putSearch = (env, query, articles) => call(env, 'stories', 'search-put', { query, articles, at: Date.now() });
export const lookupEvesVault = async (env, canonicalHash, fingerprint = null) => {
  const results = [];
  const seen = new Set();
  const push = (e) => {
    if (e && typeof e.canonicalHash === 'string' && e.canonicalHash && !seen.has(e.canonicalHash)) {
      seen.add(e.canonicalHash);
      results.push(e);
    }
  };

  // Tier B.1 — Cloudflare D1 Edge SQLite Index (`env.EVES_VAULT_DB`, 51,000+ verified rows, ~1–2 ms)
  if (env?.EVES_VAULT_DB) {
    try {
      if (canonicalHash) {
        const exactRow = await env.EVES_VAULT_DB.prepare('SELECT entry_json FROM eves_vault WHERE canonical_hash = ? LIMIT 1')
          .bind(String(canonicalHash))
          .first();
        if (exactRow?.entry_json) {
          const parsed = JSON.parse(exactRow.entry_json);
          if (parsed && parsed.canonicalHash) return [parsed];
        }
      }
      if (fingerprint && typeof fingerprint === 'object') {
        const interrogative = String(fingerprint.interrogative || 'what');
        const entities = Array.isArray(fingerprint.entities) ? fingerprint.entities.filter(Boolean).slice(0, 4) : [];
        const primaryEntity = String(entities[0] || '');
        const primaryNumber = String((fingerprint.numbers && fingerprint.numbers[0]) || '');
        const stmts = [];
        if (primaryEntity && primaryNumber) {
          if (entities.length >= 2) {
            const placeholders = entities.map(() => '?').join(', ');
            stmts.push(
              env.EVES_VAULT_DB.prepare(
                `SELECT entry_json FROM eves_vault WHERE interrogative = ? AND primary_entity IN (${placeholders}) AND primary_number = ? LIMIT 80`,
              ).bind(interrogative, ...entities, primaryNumber),
            );
          } else {
            stmts.push(
              env.EVES_VAULT_DB.prepare(
                'SELECT entry_json FROM eves_vault WHERE interrogative = ? AND primary_entity = ? AND primary_number = ? LIMIT 60',
              ).bind(interrogative, primaryEntity, primaryNumber),
            );
          }
        }
        if (entities.length >= 2) {
          const placeholders = entities.map(() => '?').join(', ');
          stmts.push(
            env.EVES_VAULT_DB.prepare(
              `SELECT entry_json FROM eves_vault WHERE primary_entity IN (${placeholders}) AND interrogative = ? LIMIT 80`,
            ).bind(...entities, interrogative),
          );
        } else if (primaryEntity) {
          stmts.push(
            env.EVES_VAULT_DB.prepare('SELECT entry_json FROM eves_vault WHERE primary_entity = ? AND interrogative = ? LIMIT 60').bind(
              primaryEntity,
              interrogative,
            ),
          );
        } else if (primaryNumber) {
          stmts.push(
            env.EVES_VAULT_DB.prepare('SELECT entry_json FROM eves_vault WHERE interrogative = ? AND primary_number = ? LIMIT 60').bind(
              interrogative,
              primaryNumber,
            ),
          );
        }
        for (const stmt of stmts) {
          const { results: rows } = await stmt.all();
          for (const r of rows || []) {
            if (r?.entry_json) {
              try {
                push(JSON.parse(r.entry_json));
              } catch {
                // ignore malformed row
              }
            }
          }
          if (results.length >= 40) break;
        }
      }
    } catch {
      // fall through to Durable Object store if D1 is unavailable
    }
  }

  // Tier B.2 — Durable Object `NewsDesk` fallback
  if (env?.NEWS) {
    try {
      const doEntries = (await call(env, 'eves-vault', 'vault-lookup', { canonicalHash })).entries || [];
      for (const e of doEntries) push(e);
    } catch {
      // ignore DO lookup failure
    }
  }
  return results;
};

export const putEvesVault = async (env, entry) => {
  const tasks = [];
  if (env?.EVES_VAULT_DB && entry && typeof entry.canonicalHash === 'string' && entry.canonicalHash) {
    const fp = entry.fingerprint || {};
    const interrogative = String(fp.interrogative || 'what');
    const primaryEntity = String((fp.entities && fp.entities[0]) || '');
    const primaryNumber = String((fp.numbers && fp.numbers[0]) || '');
    tasks.push(
      env.EVES_VAULT_DB.prepare(
        'INSERT OR REPLACE INTO eves_vault (canonical_hash, interrogative, primary_entity, primary_number, question, answer_text, entry_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
        .bind(
          entry.canonicalHash,
          interrogative,
          primaryEntity,
          primaryNumber,
          String(entry.question || ''),
          String(entry.answerText || ''),
          JSON.stringify(entry),
          Number(entry.createdAt) || Date.now(),
        )
        .run()
        .catch(() => ({ ok: false })),
    );
  }
  if (env?.NEWS) {
    tasks.push(call(env, 'eves-vault', 'vault-put', { entry }).catch(() => ({ ok: false })));
  }
  if (!tasks.length) return { ok: false };
  await Promise.all(tasks);
  return { ok: true };
};

export const seedEvesVault = (env, entries, force = false) => (env.NEWS ? call(env, 'eves-vault', 'vault-seed', { entries, force }) : Promise.resolve({ ok: false }));
export const putEvesFlag = (env, flag) => (env?.NEWS ? call(env, 'eves-vault', 'flag-put', { flag }).catch(() => ({ ok: false })) : Promise.resolve({ ok: false }));
export const listEvesFlags = async (env, limit = 50) => (env?.NEWS ? ((await call(env, 'eves-vault', 'flag-list', { limit }).catch(() => ({})))?.flags || []) : []);
