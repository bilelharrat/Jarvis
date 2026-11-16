# The Eden Creative Suite API (`creative`), v1

askeden.com's door for the Eden Creative Suite apps (Scorsese first; Ansel, Da Vinci, Houdini, Lumière, Scribe and
Aldus use the same door). Eden's thinking runs in the app, which holds the tools. askeden.com checks who is asking,
checks Plus, meters and rate-limits, picks the model with the Model Router, and runs the paid server work (generated
media). It never runs an app's tools.

Code: `site/src/creative/` (Worker routes `api.js`, the model turn `turn.js`, generated media `media.js`, the account
object's side `ops.js`). Tests: `site/test/creative.test.js`.

Status (2026-11-16): built and tested on branch `feat/creative-eden` (`node --test test/creative.test.js`, and a local
`wrangler dev`). **Not deployed.** Everything below is what the code does.

## 1. Conventions

- Base URL: `https://askeden.com`. Local development: `npx wrangler dev` in `site/` (`http://localhost:8787`).
- Every app route takes `Authorization: Bearer <token>`, where the token is the one from §2 (`es1.<account>.<id>.<secret>`).
  Nothing else (cookies, device tokens) works on these routes, and this token works nowhere else on askeden.com.
- Requests are JSON (`content-type: application/json`). Answers are JSON, or `text/event-stream` for the two streamed
  routes.
- **No browsers.** An app route refuses any request that carries an `Origin` header (403 `forbidden`). There is no CORS.
  The native apps send no `Origin`.
- An error is always `{"error": "<words to show a person>", "code": "<code>"}` with the HTTP status below. A 429 also has
  `Retry-After` (seconds). Before a stream starts, errors are JSON with a non-200 status. After the stream started
  (status 200), an error is an `error` event (§5).

| Status | `code` | Meaning, and what the app does |
|---|---|---|
| 400 | `bad_request` | The request is malformed. The `error` says what. A bug in the app. |
| 400 | `invalid_grant` | The ticket is used, expired, or the verifier doesn't match. Start the link again. |
| 401 | `not_connected` | No token, or it was revoked, expired, or is malformed. Forget the token and offer **Link to Eden** again. |
| 402 | `plus_required` | The account has no Plus. Say so, and offer Plus (`https://askeden.com/#settings=account`). Editing goes on. |
| 402 | `no_allowance` | This month's Plus AI allowance (and credits) can't pay for this. The `error` says when it renews. |
| 403 | `forbidden` | A browser `Origin`, or an account that may not use Eden yet. |
| 404 | `not_found` | No such route, job or result. |
| 405 | `bad_request` | Wrong method. |
| 409 | `quote_used` / `quote_expired` | The quote was already used, or is more than 10 minutes old. Ask for a new quote. |
| 413 | `too_big` / `too_long` | Over a size limit (§1 limits). |
| 415 | `bad_request` | Not JSON. |
| 422 | `not_yet` | askeden.com can't make that kind of media yet. Show "Not yet" and keep the feature off. |
| 429 | `slow_down` | Rate limit, or too much running at once. Wait `Retry-After` seconds. |
| 502 | `upstream` | The model or media provider failed or is busy. Offer Try again. |
| 503 | `not_set_up` | askeden.com doesn't have that switched on (a missing key). Keep the feature off. |
| 500 | `server` | Something broke on askeden.com. Offer Try again. |

**Offline** is the app's own case: the request never reached askeden.com (no network, DNS, TLS, or a timeout before
any byte). The app says "You're offline. Editing still works; Eden needs the internet." and never retries in a loop.

**Rate limits** (the site's own bindings, `site/wrangler.toml`): every app route counts on `API_RATE` per account
(600 a minute). `eden`, `eves`, `quote` and `jobs` (POST) also count on `USER_RATE` as `creative:<account>` (600 a
minute). The ticket exchange counts on `AUTH_RATE` per network (20 a minute), and so does approving a link. On top, the
account object allows at most 10 Eden replies at once (the site's `EDEN_TURNS`) and 3 generation jobs running at once.

**Size limits:** `eden` body 8 MiB; `eves` body 256 KiB; `quote` and `jobs` body 6 MiB (a start frame); others 16 KiB.

**Order of checks** on `eden`, `eves`, `quote` and `jobs`: the token's form, `API_RATE`, `USER_RATE`, then the token
itself and Plus in the account's object, and only then the body. So a revoked token always gets 401 and an account
without Plus always gets 402, whatever it sent. `me`, `revoke` and `GET jobs/…` need the token only (a job paid for
stays readable if Plus lapses).

## 2. Link once

The app links to the person's Eden account once, in the browser, with PKCE (RFC 7636), and keeps a long-lived token
for the `creative` service in its own Keychain item. It's the site's scoped-token machinery
(`site/src/accounts/scoped.js`, the same as Eden Messenger's @Eden), with its own client `creative`.

1. The app makes a random `verifier` (43–128 characters of `A–Z a–z 0–9 - . _ ~`) and a random `state` (8–200 of the
   same characters), and opens in the default browser:

   ```
   https://askeden.com/creative/link?app=scorsese&state=<state>&code_challenge=<BASE64URL(SHA256(verifier))>&code_challenge_method=S256&device=<this Mac's name>
   ```

   - `app`: `scorsese`, `ansel`, `davinci`, `houdini`, `lumiere`, `scribe` or `aldus`.
   - `device` (optional, at most 60 characters): shown on the account page, e.g. "Scorsese on Bilel's MacBook Pro".
2. The page asks the person to sign in if they aren't (Apple, Google, a passkey, as the site does), then shows
   "Link Scorsese to your Eden account?" with **Cancel** and **Link**. The form posts to `POST /api/creative/link`
   (askeden.com's own page, its session cookie; not for apps).
3. **Link** sends the browser on to the app's scheme, shared by every suite app:

   ```
   edenstudio://link?ticket=<ticket>&state=<state>&app=scorsese
   ```

   **Cancel** sends `edenstudio://link?error=access_denied&state=<state>&app=scorsese`. The app drops any callback
   whose `state` isn't the one it made. The ticket is `<account id>.<43 characters>`, works once, and only for two
   minutes. askeden.com keeps only its SHA-256.
4. The app exchanges it at once:

   `POST /api/creative/token` (no `Authorization`)

   ```json
   { "ticket": "<ticket>", "verifier": "<verifier>" }
   ```

   → 200

   ```json
   {
     "token": "es1.<account>.<id>.<secret>",
     "token_type": "Bearer",
     "scope": "creative",
     "connection": { "id": "0123456789abcdef", "app": "scorsese", "created": 1795000000000, "expires_at": 1826536000000 }
   }
   ```

   Errors: 400 `invalid_grant` (used, expired, wrong verifier, or another app's ticket), 401 `signed_out` (the browser
   that approved signed out within the two minutes), 429.
   Times are Unix milliseconds. The token lasts 365 days; after that, or once revoked, every route answers 401
   `not_connected` and the app links again. askeden.com keeps only the SHA-256 of its secret.
5. **Revoke.** The app's Sign out: `POST /api/creative/revoke` with the token → 204 (also when it was already gone).
   The person can also revoke it on askeden.com › Account › Connected apps (it's listed there as
   "Eden Creative Suite", with the app and device). Either way it stops at once.

Each suite app on each Mac links on its own and holds its own token (at most 10 creative connections per account; the
11th retires the oldest).

Why a ticket and PKCE: another app could claim `edenstudio://`. A stolen ticket is useless without the verifier, which
never leaves the app that made it.

Later (not v1): an app on a Mac where Eden Code is already linked could get its ticket from Eden Code with no browser,
as Eden Pulse does through `POST /api/hand/service` (`Eden Notes/LINK-ONCE.md`). That route isn't on this branch's
base yet; when it lands, `{service: "creative"}` would mint the same ticket.

## 3. `GET /api/creative/me`

Works without Plus (it says so). → 200

```json
{
  "account": { "id": "<uuid>", "name": "person@example.com", "email": "person@example.com" },
  "plus": true,
  "plan": { "name": "plus", "unlimited": false, "renews": true, "expires": 1797600000000 },
  "allowance": {
    "period_start": 1793491200000,
    "period_end": 1796083200000,
    "budget_usd": 6,
    "used_usd": 1.25,
    "left_usd": 4.75,
    "credits_usd": 0
  },
  "voice": { "today_chars": 1200, "daily_chars": 100000 },
  "connection": { "id": "0123456789abcdef", "app": "scorsese", "created": 1795000000000, "expires_at": 1826536000000, "last_used": 1795000000000 },
  "generation": {
    "video": { "available": true },
    "speech": { "available": true },
    "voice_clone": { "available": false, "why": "Not yet: …" }
  }
}
```

`name` is the account's sign-in email (askeden.com keeps no other name). `allowance` is this month's Plus AI allowance
in US dollars of provider list price, the same figures as askeden.com's account page. `generation` lists every kind in
§6 with whether askeden.com can make it now.

## 4. Which models Eden may use

The Model Router (`site/src/eden/vendor/model-router.js`, rules only, no paid classifier call) picks one model per
turn from the person's last typed message and the conversation's size. It may pick only models that can call tools on
askeden.com's server keys:

| Model | Provider | Needs |
|---|---|---|
| `claude-sonnet-5-5` | Anthropic | `ANTHROPIC_API_KEY` |
| `claude-opus-5-5` | Anthropic | `ANTHROPIC_API_KEY` |
| `gpt-6.1-sol` | OpenAI | `OPENAI_API_KEY` |
| `gemini-4-argon` | Google | `GEMINI_API_KEY` |
| `gemini-3.8-flash` | Google | `GEMINI_API_KEY` |

Each must also be on the site's model list (`EDEN_MODELS`) with its provider switched on. Never picked: Kimi K3 (no
tool path on the server), Gemini 3.5 Flash-Lite (too weak for many-step tool use: agentic score 79.7), DeepSeek, Meta
and Mistral (opt-in or not offered). Claude streams token by token; Gemini and GPT are asked once and their answer
arrives as one burst of events (the site's `service-ai.js` translation). No extended thinking.

## 5. `POST /api/creative/eden`: one model turn, streamed

Request:

```json
{
  "app": "scorsese",
  "messages": [
    { "role": "user", "content": "Cut the long pauses out of the interview" },
    { "role": "assistant", "content": [
      { "type": "text", "text": "I'll find them first." },
      { "type": "tool_use", "id": "toolu_01", "name": "find_silences", "input": { "min_seconds": 1.5 } }
    ] },
    { "role": "user", "content": [
      { "type": "tool_result", "tool_use_id": "toolu_01", "content": "[{\"start\":12.4,\"end\":14.9}]" }
    ] }
  ],
  "tools": [
    { "name": "find_silences", "description": "Find silences in the selected clip.",
      "input_schema": { "type": "object", "properties": { "min_seconds": { "type": "number" } }, "required": ["min_seconds"] } }
  ],
  "tool_choice": { "type": "auto" },
  "context": { "instructions": "You edit video in Scorsese…", "project": { "name": "Interview", "fps": 25 } },
  "max_tokens": 4096
}
```

- `messages` (1–400): Anthropic Messages shape. `role` is `user` or `assistant`; the first is `user`. `content` is a
  string or a list of blocks: `text` `{text}`; `image` `{source: {type: "base64", media_type: "image/png" | "image/jpeg" |
  "image/webp" | "image/gif", data}}` (user only, at most 20 in all); `tool_use` `{id, name, input}` (assistant only, as
  received); `tool_result` `{tool_use_id, content: string | [text and image blocks], is_error?}` (user only).
- `tools` (0–128): `{name, description?, input_schema}`. `name` matches `^[A-Za-z0-9_-]{1,64}$` and is unique;
  `description` at most 4,000 characters; `input_schema` a JSON Schema object (`"type": "object"`), at most 16 KiB each
  and 256 KiB in all. They're passed to the model as they are. **askeden.com never runs them**: a `tool_use` comes back
  to the app, which runs it (asking the person first where it should), then sends the result as a `tool_result` in the
  next request.
- `tool_choice` (optional): `{type: "auto" | "any" | "none"}` or `{type: "tool", name}`.
- `context` (optional, at most 64 KiB as JSON): `instructions` (a string, at most 20,000 characters) is the app's own
  instructions for Eden and goes into the system prompt after askeden.com's short preamble; everything else is put in a
  `<context>` block as data the model must not take instructions from.
- `max_tokens` (optional): 256–16,384, default 4,096.

Before the model is asked: the token, Plus (402 `plus_required`), the rate limits, and a hold on the allowance for the
turn's worst case (input at a token per 3 bytes, images 1,600 tokens each, plus `max_tokens` of output, at the picked
model's list price). Not enough left: 402 `no_allowance`. Afterwards the account pays what the turn really used (the
provider's reported usage; a stopped stream counts what streamed), and the hold goes.

→ 200 `text/event-stream`. Each event is `event: <type>` and `data: <JSON>`; a `: ping` comment comes every 15 s.

| Event | Data |
|---|---|
| `route` | `{"model": "gemini-3.8-flash", "name": "Gemini 3.8 Flash", "provider": "gemini"}`, first, once |
| `text` | `{"text": "…"}`, a piece of the reply's text, in order |
| `tool_use` | `{"id": "toolu_…", "name": "find_silences", "input": {…}}`, one complete call (never partial JSON) |
| `usage` | `{"input_tokens": 5120, "output_tokens": 212, "usd": 0.0046, "left_usd": 4.21}`, once, before `done` |
| `error` | `{"code": "upstream", "message": "…"}` if the turn broke off; then `done` |
| `done` | `{"stop_reason": "end_turn" \| "tool_use" \| "max_tokens" \| "refusal" \| "error"}`, last, once |

To continue after `tool_use`: append the assistant turn exactly as received (`text` blocks, then the `tool_use`
blocks in order) and a user turn with one `tool_result` per `tool_use`, and POST again. The router may pick another
model for the next turn; the history works across providers. Closing the connection stops the turn (what streamed is
still counted).

Errors before the stream: 400, 401 `not_connected`, 402 `plus_required` / `no_allowance`, 403, 413, 429 `slow_down`,
502 `upstream` (the model couldn't be reached or refused the request), 503 `not_set_up` (no model with tools here).

## 6. `POST /api/creative/eves`: check names, places and facts

EVES on askeden.com, unchanged (`site/src/eden/eves.js`, the same run as `POST /api/chat/eves`): up to three models
answer, an agreement check, a judge and web evidence, then a verdict. The app sends the text; askeden.com asks EVES to
check it.

```json
{ "app": "scorsese", "kind": "captions", "text": "Neil Armstrong walked on the Moon in 1968…", "language": "en" }
```

- `kind`: `captions` or `transcript`. `text`: 1–20,000 characters. `language` (optional): a BCP 47 tag.
- Plus is required; the run is held and paid on the allowance exactly as on askeden.com.

→ 200 `text/event-stream`, EVES's own events, passed through unchanged. What the app needs:

| Event | Use |
|---|---|
| `eves` | The run started: `{id, lanes, judge, …}` |
| `eves_stage` | Progress: `{stage, …}` (show "Checking…") |
| `text` with `"lane": "final"` | The checked answer, in pieces: a list of what's wrong or doubtful, with corrections |
| `verification` | The verdict label: `{label: {kind, text}, …}` (e.g. `eves_verified`) |
| `error` | Something failed; `end` still follows |
| `end` | The run is over |

Events for lanes `0`–`2` and `judge` (`text`, `usage`, `done`, `citations`, `checks`, `verdict`) can be ignored or shown
as detail. Errors before the stream as in §5.

## 7. Generated media: quote, then a job

A price first, shown to the person before anything runs; then the job; then its progress and result.
Everything made is labelled **Generated** (`"label": "Generated"` on the job and `X-Eden-Generated: true` on the
result); the app must keep that label on the clip.

| `kind` | What | Made with | Paid from |
|---|---|---|---|
| `video` | B-roll: a 5 or 8 s clip from a prompt, or from a start frame | Google Veo 3 Fast (default), Veo 3 (`quality: "high"`), Veo 2 as fallback, as askeden.com's chat makes videos | The Plus AI allowance, at Veo's per-second list price ($0.15/s Fast, $0.40/s Veo 3), on success only |
| `speech` | Lines read aloud in the Eden voice: narration, or the "Spanish version" from a translated transcript (the app translates with §5) | Fish Audio, the voice askeden.com reads aloud with | The daily voice allowance (characters: 100,000 a day with Plus), no dollars |
| `voice_clone` | Dubbing in the speaker's own voice | — | 422 `not_yet`: needs the speaker's recorded consent flow and a cloning provider, neither built |
| `lipsync`, `music`, `sound_effects`, `image` | — | — | 422 `not_yet` |

### `POST /api/creative/quote`

```json
{ "app": "scorsese", "kind": "video", "prompt": "Slow aerial shot over Lisbon at dawn", "seconds": 8, "aspect": "16:9", "quality": "standard",
  "start_image": { "media_type": "image/jpeg", "data": "<base64>" } }
```

- `video`: `prompt` 1–4,000 characters; `seconds` 5 or 8 (default 5); `aspect` `16:9` or `9:16` (default `16:9`);
  `quality` `standard` or `high`; `start_image` optional (PNG, JPEG or WebP, at most 4 MiB decoded).
- `speech`: `{"kind": "speech", "lines": [{"text": "Hola y bienvenidos."}, …], "language": "es"}`, 1–100 lines,
  each 1–600 characters, at most 20,000 in all.

→ 200

```json
{
  "quote_id": "<24 hex>",
  "kind": "video",
  "model": "veo-3.0-fast-generate-001",
  "model_name": "Veo 3 Fast",
  "seconds": 8,
  "usd": 1.2,
  "allowance_left_usd": 4.75,
  "chars": 0,
  "voice_left_chars": null,
  "expires_at": 1795000600000,
  "label": "Generated"
}
```

For `speech`, `usd` is 0, `chars` is the characters it will take and `voice_left_chars` what's left today. A quote
that can't be paid is refused here (402 `no_allowance`), before the app shows a price. 422 `not_yet` for kinds
askeden.com can't make; 503 `not_set_up` when the provider key is missing.

### `POST /api/creative/jobs`

The same body as the quote, plus `quote_id`. It must match the quote exactly (askeden.com compares a SHA-256 of it),
come from the same connection, within 10 minutes, once.

→ 202 the job (below), whose `status` may already be `failed` (Veo refused the prompt: nothing charged). 409
`quote_used` / `quote_expired`; 400 `bad_request` when the body differs from the quote (the quote stays usable); 402;
429 `slow_down` when 3 jobs are running already (the quote stays usable).

### `GET /api/creative/jobs/:id`

→ 200

```json
{
  "id": "<24 hex>",
  "kind": "video",
  "status": "running",
  "progress": 0.4,
  "created_at": 1795000000000,
  "updated_at": 1795000030000,
  "expires_at": 1795086400000,
  "model": "veo-3.0-fast-generate-001",
  "model_name": "Veo 3 Fast",
  "usd": 1.2,
  "label": "Generated",
  "result": null,
  "error": null
}
```

`status`: `running` → `succeeded` or `failed`. `progress` 0–1 (video: an estimate from the time taken; speech: lines
done). On `succeeded`, `result` is `{"items": [{"index": 0, "url": "/api/creative/jobs/<id>/result?item=0",
"mime": "video/mp4", "bytes": 3145728}]}` (speech: one item per line, `audio/mpeg`). On `failed`, `error` is
`{code, message}` and nothing was charged for a video (a speech job's characters stay counted, as on askeden.com). Poll
every 3–5 s. Jobs and results are kept 24 hours, at most 20 per account.

### `GET /api/creative/jobs/:id/result?item=0`

The file itself, with the token: `Content-Type` as `mime`, `Content-Disposition: attachment`, `X-Eden-Generated:
true`, `Cache-Control: no-store`. 404 when it's gone or not ready.

## 8. What isn't here

- Nothing is stored of what's asked: messages, tools and context go to the model and nowhere else; the logs carry no
  tokens, prompts or keys.
- Transcripts and silence detection run on the Mac (Apple's on-device speech recognition), not here.
- Without Plus or a link, every editing feature works offline and free; the app says plainly what Eden needs.

## 9. Going live (the owner)

- No new secret, D1 database or Durable Object migration: it uses the keys askeden.com already has
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `FISH_API_KEY`), `EDEN_VIDEOS`, and the Account object
  (new storage keys `cquote:`, `cjob:`, `cres:` and alarm kind `creative`).
- Needs: a merge into the live branch and one askeden.com deploy, with the owner's OK.
- Then the suite's URL scheme `edenstudio://` in each app's `project.yml` (the release task).
