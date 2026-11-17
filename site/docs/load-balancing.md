# Load balancing for askeden.com (jarvis-download Worker)

Started 2026-11-06. Owner's order: "we need to build a great load balancing system, it's mandatory".

## What exists today (verified 2026-11-06)
- Cloudflare anycast runs the one Worker in every data centre (free, platform). No origin, so a Cloudflare
  Load Balancer has nothing to balance. Smart Placement off.
- Code does ordered **failover** only, never spreading: `serviceKeyList` (src/eden/providers.js ~86) walks
  keys in fixed order; streamCall (~526) moves to the next key only on 402/429/529/quota, or any error on Vertex.
- Many paths use ONE key with no failover: image.js, video.js, chat.js embeddings/video uploads,
  browser-turn.js, memory.js, service-ai.js (Help, Edu OCR), travel/planner.js, router-api/api.js,
  the Gemini rating (providers.js ~325).
- Likely live bug: VERTEX_CREDENTIALS is a live secret and Vertex is first, so those raw-key paths get the
  `vertex://…` string and send it as `x-goog-api-key` (image.js 479/348, Veo 854-857). Images/video probably
  fail for service users without reaching their fallbacks.
- Global single-instance Durable Objects on hot paths: VoiceQuota 'daily' (worker.js ~699, every voice request),
  Help 'help-messages' (help.js ~155), RouterApi 'clients' (router-api/api.js 46/68, every edenrouter.com call,
  even unknown keys), NewsDesk 'stories' (news/store.js 149-152, feed is no-store), NewsDesk 'eves-vault'
  (store.js 69-90: storage.list of up to 25,000 entries on every exact miss and every put).
- D1 vault: no Sessions API, so read replicas could never serve reads.
- Modal Gemma judge: one URL, last known max_containers=1.

## Design (what we build)
1. **Key pool** `src/eden/key-pool.js`, health kept in memory per Worker copy (no new shared object = no new
   choke point).
   - Keys are grouped in **tiers** that keep today's cost order: Vertex (when VERTEX_FIRST, GCP credits) >
     primary keys (`<VAR>` comma list + numbered `<VAR>_2` … `<VAR>_9`) > `<VAR>_FALLBACK_KEYS` > Vertex (if
     not first). Within a tier, requests are **spread** (power-of-two-choices on in-flight + recent errors);
     a lower tier is used only when the tier above is out of credit or quota for its account (fixed after review,
     2026-11-06: it used to be any cooldown, so one model's 429 or a provider-wide 529 sent every model to the
     fallback keys; rate limits are mostly per model).
   - Health: 429/529/402/quota → cooldown (Retry-After, else 15 s doubling to 5 min); 5xx/network → after 3
     in a row the key's circuit opens for 30 s; a success resets. Cooling keys are still tried last, never dropped.
   - Only keys for the SAME provider and model are balanced. Model switches stay failure-only (EVES gate,
     CLAUDE.md). Keys are never logged; the snapshot shows an 8-char SHA-256 fingerprint.
   - Kill switch: `KEY_POOL=off` restores today's fixed order exactly.
   - Generic: the pool also balances endpoint URLs (e.g. several Gemma judge URLs).
2. **Every provider path uses the pool with failover**, and raw-key paths never receive a `vertex://` key
   (they get the plain keys; if none, they behave as "no Gemini" and their fallback chains run).
3. **Hot single objects**: shard VoiceQuota 'daily' and Help 'help-messages' by a hash of the asker
   (`VOICE_QUOTA_SHARDS`, built with default 1 for both, see below; `1` = old behaviour; each shard gets limit/N so the total cap holds);
   edge-cache the public news feed briefly; index 'eves-vault' in memory inside the object so lookups and
   puts stop listing 25,000 entries (same results); short negative cache for unknown Router API keys;
   D1 vault reads through the Sessions API so read replicas serve once the owner turns replication on.
4. **Backends**: Gemma judge accepts several URLs (balanced + failover); Modal judge config allows more than one
   container (owner deploys it); optional voice backup when Fish fails (`VOICE_FALLBACK`, off by default).
5. **Health**: owner-only `GET /api/admin/lb` shows this Worker copy's pool state.

## API (built 2026-11-06: items 1 and 5)

`src/eden/key-pool.js` (no imports; state in memory per Worker copy):
- `order(provider, tiers, { env }) → string[]`: `tiers` is an array of arrays (best first) or a flat array (one
  tier). Healthy keys tier by tier (first of a tier by power-of-two-choices on in-flight + errors in the last 60 s,
  a tie to the first random draw; rest by load, ties in given order; then that tier's cooling/circuit keys,
  soonest-back first), then keys out of account credit/quota by tier, soonest-back first. Registers the keys (only registered keys are tracked/shown; an asker's own keys never are).
  `KEY_POOL=off`: the flattened input, unchanged.
- `withPool(provider, list, fn, { signal, env, ordered }) → Promise<Response|null>`: calls `fn(key, i)` (→ Response,
  or null to skip) in pool order; fails over on 402/429/529, 5xx, a thrown error, 400-403 with quota words; stops
  on anything else. Returns the last Response (body unread), throws the last error if every key threw, stops on an
  aborted `signal`. `ordered: true` keeps the list's order (use for a providerKey entry, already pool-ordered).
  `retryThrown: false`: a thrown error is reported and thrown at once, no next key (paid, non-idempotent calls).
  In-flight counts until fn's Response arrives. The tier shown for a key comes from the widest tier list it was
  ordered in (Vertex-less and flat lists don't flip it); ordering itself uses each call's own tiers.
- `acquire(provider, key) → release()`, `report(provider, key, { kind, status, retryAfter })`,
  `classify(status, body) → 'ok'|'cooldown'|'failure'|'neutral'`, `shouldFailover(kind)`, `retryAfterMs(headers)`:
  for loops that call fetch themselves (streamCall).
- `snapshot(env)`, `fingerprint(key)` (8 hex of SHA-256), `sha256Hex`, `poolOn(env)`, `poolEnabled()` (switch as
  last read, for code without env), `QUOTA_RE`, `resetPool({ now, rand })` (tests).
- Health: cooldown = Retry-After else 15 s doubling, both capped at 5 min; circuit = 3 failures (5xx/network) in a
  row → 30 s; any success resets. Other 4xx (incl. 401/403 without quota words) are 'neutral': no health change.
  `QUOTA_RE` is providers.js `QUOTA_FAILOVER_RE` without the bare word "exceeded", so a request's own error (OpenAI
  `context_length_exceeded`) never parks a healthy key for everyone (streamCall's per-call failover keeps the old regex).
- Which sickness crosses tiers: only an account signal (402; 400-403 with quota words; a 429 whose body says
  `insufficient_quota`, `credit balance`, `out of credit` or `regain access`) moves a key behind the lower tiers. A plain
  429, a 529 and an open circuit move it behind the healthy keys of its own tier only (before any lower tier), so one
  primary key + fallback keys behaves as before: the primary first on each call, the next key per call on failure.
  `report` takes the error text as `body` for this; withPool reads 429 bodies too. An aborted walk cancels the body of
  a failed answer it was holding.
- A `vertex://` key is never moved behind a lower tier when sick (Vertex 429s/5xx are mostly one model's quota;
  moving it would bill every Gemini model to the paid keys). Its health is still recorded and shown; each call
  fails over to the next key as before.

`src/eden/providers.js`:
- `serviceKeyTiers(env, provider) → string[][]`: [Vertex if VERTEX_FIRST] [`<VAR>`, `<VAR>_2`…`_9`]
  [`<VAR>_FALLBACK_KEYS`] [Vertex if not first]; empty tiers dropped, duplicates dropped.
- `serviceKeyList(env, provider)`: the same, flat, fixed order (unchanged contract, now includes `_2`…`_9`).
- `providerKey` returns `{ key, fallbackKeys }` in pool order for service keys (own keys untouched). It reads
  `KEY_POOL` first (before the own-key return), so streamCall and the rating see the switch even on own-key turns.
- `plainKeys(entry | key | list | tiers)`: drops `vertex://` keys, keeps order. `plainServiceKeys(env, provider)`:
  plain service keys in pool order (does not check `EDEN_<P>=off` or the asker's own key; callers do).
- `streamCall` reports every key's outcome, holds in-flight until the stream ends, and also fails over on 5xx and
  network errors when another key exists (KEY_POOL=off: old rule, network failover on Vertex only).
- The Gemini rating (`ratingRouter`) sends only plain keys through `withPool`; with only a Vertex key it returns
  null (as with no Gemini key) instead of sending the `vertex://` string as an API key.

Owner-only `GET /api/admin/lb` (src/stats/admin.js `adminLb`, same ADMIN_EMAILS gate as /api/admin/stats, 404 for
anyone else): `{ colo, on, at, providers: { <p>: [{ fp, kind: 'vertex'|'key'|'url', tier, inFlight, ok, errors,
failsInRow, state: 'ok'|'cooldown'|'circuit', backInMs, lastStatus }] } }`. Lists every configured service key of
this copy; never a key.

## Provider paths (built 2026-11-06: item 2)
Every raw-key call sends only plain keys (never `vertex://`) and goes through `withPool` (next key of the SAME model on
402/429/529, 5xx, network, quota words; a 400/404 stops). With only a Vertex key a path behaves as "no Gemini" and its
own fallback chain runs. Model and provider fallback chains are unchanged.
- `src/accounts/service-ai.js` `envKeyTiers(env, VAR)`: a var's plain keys in tiers ([`VAR` comma list, `VAR_2`…`_9`],
  [`VAR`'s `_FALLBACK_KEYS`]) = providers.js `serviceKeyTiers` without Vertex; no providers.js import (avoids a cycle).
  `parseAnthropicKeys` = its flat Anthropic list (so `ANTHROPIC_API_KEY_2…_9` count, proxy.js included).
  `serviceFetch`: gemini-* (Help, Edu OCR) on the plain Gemini list; the Claude call on `withPool('anthropic')` (now
  also moves on after a 5xx/network error); the stand-in (`serviceFallback` → `{ key, keys }`) on its list.
- `image.js`: Imagen, Gemini Image, GPT Image and Veo/Interactions starts go through the pool; the key that started a
  Veo job polls it and downloads the clip. A network error there is thrown, never sent again on the next key (the
  provider may already have started the paid job); 402/429/529, 5xx and quota words still move on. (Another session's `geminiKey` helper decides "has Gemini".)
- `video.js`: the upload start goes through the pool; the key that starts it owns the file and does the rest.
  `findFile(keys, name)` tries each plain key (a file is readable only from the uploader's Google project; another
  project's key gets 403); `deleteFile` takes a list. `chat.js` video turns: the owner key goes first for the turn
  (same model; the other keys after, as before).
- `chat.js`: Eden Mail embeddings use `pooledFetch(provider, keys)` (embed.js unchanged), a Vertex-only Gemini counts
  as no Gemini there; DeepInfra private turns take `DEEPINFRA_API_KEY` comma list + `_2…_9` through the pool.
- `browser-turn.js`: each step through the pool on the plain keys; `pickBrowserModel(…, { usable })` skips a provider
  whose only key is Vertex (chat.js passes it).
- `memory.js` (extraction), `travel/planner.js` (Gemini + GPT drafts, the sketch): the plain lists through the pool,
  one time limit across the keys tried (a timeout never moves to another key). The planner's model order and hedge
  are untouched.
- `router-api/api.js` `providerKeys`: service keys = `plainServiceKeys` (pool order, no Vertex, as before), the rest as
  `fallbackKeys`, passed to `streamCall`. Unknown-key cache: a well-formed `sk-eden-` key the store answers
  `invalid_api_key` is answered from memory in this Worker copy for 30 s (max 5,000 SHA-256 hashes, expired first,
  then oldest); valid, revoked, paused and rate-limited keys are never cached. Same 401 body as the store's.

### EVES gate (owner's rule, CLAUDE.md)
Every EVES lane goes through `streamCall` (src/eden/eves.js). With more than one key for a provider (numbered keys,
`<VAR>_FALLBACK_KEYS`), a lane that used to fail on a 5xx or network error now retries on the next key of the same
model and can answer, so EVES's quorum and kept answer can differ from the measured baseline. Before an askeden.com
deploy with more than one key per provider: run the paired hard-v1 dev bake-off
(`askeden/eval/halluc/results/2026-10-27-hard-bakeoff/`) with the pool on, or deploy with `KEY_POOL=off` until it passes.
With one plain key per provider (plus Vertex for Gemini, which already failed over on any error) EVES is unchanged.

### Kill switches
| Env | Default | Effect |
|---|---|---|
| `KEY_POOL=off` | on | fixed key order everywhere (providerKey, withPool), and streamCall's old failover rule. withPool still moves to the next key on failure (by design: the Gemma judge's URL list, the Claude stand-in's keys); the Gemini rating sends one call on the first key, no retry, as before |
| `ROUTER_BAD_KEY_CACHE=off` | on | every Router API request with an unknown key asks the `clients` object again |
| `VOICE_QUOTA_SHARDS` | unset: 1 for both | number of quota shards (1..64) for both (voice by account/network, Help questions by network); `1` = the old single objects `daily` / `help-messages` |
| `NEWS_EDGE_CACHE=off` | on | News stories and searches always come from the `stories` object (no `caches.default`) |
| `VAULT_INDEX=off` | on | `eves-vault` lookups/puts/seeds use the old `storage.list` code |
| `D1_SESSIONS=off` | on | D1 vault reads use plain `prepare` on the primary (no `withSession`) |
| `VOICE_FALLBACK` | unset = off | a Workers AI Deepgram Aura model id (`@cf/deepgram/aura-1`, `@cf/deepgram/aura-2-en`) answers when Fish fails; `VOICE_FALLBACK_SPEAKER` picks its voice |
| `GEMMA_JUDGE_URL` with one URL | one URL | today's judge exactly: one POST, no failover. Several URLs (comma list) turn on spreading + failover; `KEY_POOL=off` keeps them in the given order (first URL first, next only on failure) |

## Backends (built 2026-11-06: item 4, voice not included)

### Gemma judge: several URLs
`GEMMA_JUDGE_URL` takes a comma-separated list (src/eden/gemma-judge.js `judgeUrls`). Every URL must serve the **same
model and frozen config** (EVES rule: spreading never changes how EVES judges); the same `GEMMA_JUDGE_KEY` /
`GEMMA_JUDGE_SECRET` go to each as `Modal-Key` / `Modal-Secret`.
- Warmth is tracked per URL in each Worker copy. `judge()` sends only to warm URLs (a cold one would hold the call
  until the timeout), spread by `withPool('gemma-judge', …)`; if none is warm it uses all of them, as with one URL.
- Failover to the next warm URL on 429/402/529, 5xx and network errors; a 400/404 stops (the request's fault). The
  failed URL is marked cold. The timeout (6 s; 2 s for gemma-text) covers the whole walk, not each URL.
- `ping()` pings each cold URL (at most once a minute each, warm ones are skipped). While any URL is warm, a turn
  also pings the cold ones so every copy can take a share. **Cost:** with N URLs and steady traffic, N copies stay
  warm. One URL: no extra pings (same as before).
- Verdicts, thresholds, shadow/owner handling and timeouts are unchanged. gemma-text.js uses the same `judge()`.
- `GET /api/admin/lb` shows the URLs as fingerprints under `gemma-judge`.

### Modal claim-judge: more than one container
The Modal source (`modal_app.py`, the `claim-judge` app) was in a session scratchpad under /private/tmp that has
since been cleared; it is not in this repo. Owner change when redeploying (owner deploys, not the Worker code):
in the `@app.cls(…)` decorator above `class Judge` add `min_containers=0, max_containers=4` (keep
`scaledown_window=300`, `@modal.concurrent(max_inputs=4)` and the live config, `JUDGE_CONFIG_DIR=frozen4_hf`).
Idle cost stays zero; under load Modal starts up to 4 A100-80GB containers (each bills per second while up, plus
up to 300 s idle after its last call, plus its cold start). Check the $20 Modal spend limit against that peak.

### Later: Cloudflare Load Balancer across Modal + a Cloud Run copy (not built)
The Worker list above already spreads and fails over for free (`GEMMA_JUDGE_URL=<modal>,<cloud run>`). A Cloudflare
Load Balancer adds one hostname and active health checks. To build it:
1. **Cloud Run copy**: the same judge server and frozen config in a GPU container, `min-instances 0`. Modal's proxy
   auth is Modal-side, so this copy must check `Modal-Key` / `Modal-Secret` itself. It must answer
   `GET /health` → `{"ok":true,"loaded":true}` like the Modal one.
2. **Cloudflare dashboard → Traffic → Load Balancing** (paid add-on) on askeden.com:
   - **Monitor**: HTTPS `GET /health`, expect 200 and body containing `loaded`, send `Modal-Key` / `Modal-Secret`
     headers. Warning: every check starts a GPU container. An interval under the 300 s scale-down keeps the GPUs
     warm all day (a full-month GPU bill per copy). Use a long interval, or a CPU-only `/live` route that doesn't
     load the model.
   - **Pools**: `judge-modal` (origin `<workspace>--claim-judge-…modal.run`) and `judge-cloudrun` (origin
     `<service>-….run.app`), each with a Host header override set to its own hostname (both route by Host).
   - **Load balancer**: hostname e.g. `judge.askeden.com`, proxied; steering "Off" (failover: Modal first, Cloud Run
     second) or "Random" with weights to spread; no session affinity.
3. Point the Worker at it: `GEMMA_JUDGE_URL=https://judge.askeden.com` (one URL, so the Worker's own spreading is
   off). Roll back by putting the Modal URL back.

## Hot objects and the voice backup (built 2026-11-06: item 3 + voice from item 4)

### Sharded daily quotas (`src/eden/quota-shard.js`)
- `quotaShard(env, base, asker) → { name, n, index }`: shard = first 32 bits of SHA-256(asker) mod N, object name
  `<base>:<i>/<N>` (N in the name, so changing N starts fresh objects instead of reusing counts made under another
  cap); N = 1 → exactly `base`. `shareOf(limit, n)` = ceil(limit / n).
- VoiceQuota semantics (worker.js): one atomic check-and-add over three counters, `i:<asker>`, `n:<network>`, `all`,
  each against its cap, reset at UTC midnight. In a shard, the per-asker and per-network caps stay **whole** and only
  `everyone` is divided, so the shards together grant at most `everyone + N - 1`.
- Voice `daily`: asker = `a:<account>` signed in (only `everyone` counts there; the account's own allowance is in
  the Account object), else the network (IP), so the per-network cap stays exact. An install seen from several
  networks can reach up to N shards; its per-install cap then holds per shard. **Default 1 (not 8)**: the shared
  ceiling is small (400,000 chars) next to one asker's day (20,000 per install, more per account), so an even 8-way
  split (50,000 each) would tell people "used up for everyone" once two or three heavy askers share a shard while
  most of the day's total is unused. The ceiling also caps voice to a few thousand calls a day, which one object
  serves easily. Set `VOICE_QUOTA_SHARDS=8` if that object is ever hot.
- Help `help-messages`: **default 1 (one object, as before)**. Sharded by account (the first build, default 8) let
  one network's new accounts land on up to 8 shards, each granting the full network cap (4 × per account): up to 8×
  the questions from one IP, each reserving from the one `help-budget`, so Help ran dry for everyone sooner. It is
  not hot (20 a minute per account). With `VOICE_QUOTA_SHARDS` > 1 it is sharded by **network** (`ip:<addr>`), so
  the network cap stays exact; an account seen from several networks can then use its own cap once per shard.
  Its `everyone` is unlimited, so nothing is split. `help-budget` (Eden's $ per day) and `help-screenshots` stay
  one object.
- Changing N during a UTC day lets that day pass its caps by what was already used under the old N.

### News edge cache (`src/news/store.js`)
The feed (`GET /api/news/feed`) is per reader (signed in, onboarding, personal ranking), so it is not cached. Its
shared inputs are: `getStories` (the `stories` object's edition) and `getSearch` (a query's search). Each Cloudflare
location keeps a fresh answer 45 s in `caches.default` (keys `https://askeden.com/__edge-cache/news/v1/stories` and
`…/search?q=<lower-cased query>`); a kept answer is used only while the object would still call it fresh (10 / 20 min
rules), a stale answer is never kept, and a put clears that location's key. Other locations may show the previous
edition for up to 45 s after a refresh. On workers.dev and in previews the Cache API does nothing (falls through).

### `eves-vault` index (NewsDesk)
Inside the object: every `v:` key in `storage.list` order (UTF-8 byte order, `byStorageKey`), each entry's
`createdAt` (for the trim) and its JSON. Loaded once per object life with one `storage.list`, kept in step on put,
seed (when loaded), trim and erase; any error drops it (reloads next time). Answers are the same bytes as before:
exact hit, else the first 25,000 entries in key order; the trim removes the same oldest entries (stable sort by
`createdAt` over key order; a single excess is found without sorting). If the entries' JSON passes 12 M characters
(`VAULT_CACHE_CHARS`), the JSON is dropped and whole-vault lookups list as before; puts still never list. The
whole-vault answer (a second copy of that JSON) is kept between lookups only while the JSON is at most 4 M characters
(`VAULT_BODY_CHARS`); past that it is built per lookup, as the old code did. Limits are in characters and a string
with any non-Latin-1 character (curly quote, dash) takes 2 bytes each; the isolate's 128 MB is shared with the
other NewsDesk objects (`stories`, readers), so at most ~24 MB stays held (fixed 2026-11-06 after review: it was
32 M plus an always-kept answer, up to ~128 MB).

### D1 vault reads
`lookupEvesVault` reads through `env.EVES_VAULT_DB.withSession('first-unconstrained')` (Cloudflare: works with
replication off; no compatibility flag listed). Writes stay plain. Missing `withSession`: plain `prepare`. With
replication on, a replica can lag a just-written entry by a moment; the NewsDesk tier below still has it.

### Voice backup
When Fish fails (network error, 5xx, 429) and `VOICE_FALLBACK` is a Deepgram Aura model on Workers AI (verified in
Cloudflare's model docs 2026-11-06: `@cf/deepgram/aura-1`, `@cf/deepgram/aura-2-en`; input `text`, `speaker`,
`encoding`, `container`, `sample_rate`; output a binary audio stream), `env.AI.run(model, { text, encoding:
'linear16', container: 'wav' | 'none', sample_rate: 24000 })` answers in the format the app asked for (wav, or raw
16-bit PCM like Fish's `pcm`), with `x-eden-voice: backup`. Another voice than JARVIS's; billed on Workers AI. Any
other model id, no `AI` binding, or a backup error: today's 502. Fish 4xx (bad request, key): today's 502.

## Not built (owner's call, see TODO.md)
Cloudflare Load Balancer across Modal + a GCP Cloud Run judge copy; Cloudflare AI Gateway (code can point
providers at it via the existing base-URL setting); extra provider keys; turning on D1 read replication;
sharding RouterApi 'clients' (needs a live data migration).
