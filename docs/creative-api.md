# The Eden Creative Suite API (`creative`), v1

askeden.com's door for the Eden Creative Suite apps (Scorsese first; Ansel, Da Vinci, Houdini, Lumière, Scribe and
Aldus use the same door). Eden's thinking runs in the app, which holds the tools. askeden.com checks who is asking,
meters the account's own allowance and rate-limits, picks the model with the Model Router, and runs the paid server
work (generated media). It never runs an app's tools.

**One account, one allowance, one meter** (owner, 2026-11-16, second round): any askeden.com account works in every
suite app, free accounts included, and spends exactly what askeden.com's own chat spends, through the same code
(`account.js` `allowAi`, `holdAi`, `spend`, `voice`): the plan's allowance (by the month, or askeden.com's weekly slices
where it has them), else the free trial (and, where askeden.com has it, the free share), then bought credits. There is
no separate creative allowance and no Plus gate. The apps allow a person's own API keys only when `paying` (§3) is true.

Code: `site/src/creative/` (Worker routes `api.js`, the model turn `turn.js`, EVES `eves.js`, generated media
`media.js`, the account object's side `ops.js`). Tests: `site/test/creative.test.js`. Rooms: `docs/creative-rooms.md`.

Status (2026-11-16): on branch `feat/creative-on-main` (from askeden.com's `main`, without `ios-app-store-prep`'s other
work). askeden.com itself isn't deployed from `main`: the suite goes live as an overlay on the live tree,
`site/scripts/deploy-creative-overlay.sh` (§9), whose `src/creative/eves.js` is `scripts/creative-overlay/eves-live.js`.
**Not deployed.** Everything below is what the code does; where `main` and the live site differ, both are said.
Every change from the first version of this contract is listed in §10.

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
| 402 | `plus_required` | **No longer sent**: any account may use Eden. Kept here so older app builds still read it. |
| 402 | `no_allowance` | The account's allowance (its plan's, else the trial, then credits) can't pay for this. The `error` is askeden.com's own words, e.g. "The free trial of Eden’s AI is used up. Get Plus, or add credits (Settings › Account)." Offer Plus or credits (`https://askeden.com/#settings=account`). Editing goes on. |
| 402 | `over_ask_limit` | New. This one turn would cost more than one ask from an app's token may (`EDEN_APP_ASK_MAX_USD`, $0.50 by default), even made smaller (§5). Show the `error` ("Start a new conversation, or send less of the project"). It isn't about the allowance or Plus. |
| 403 | `forbidden` | A browser `Origin`, or an account that may not use Eden yet. |
| 403 | `wrong_app` | The body names another suite app than the one this token was linked for (a Scorsese token sent `"app": "ansel"`). A bug in the app: each app links on its own. |
| 404 | `not_found` | No such route, job or result. |
| 405 | `bad_request` | Wrong method. |
| 409 | `quote_used` / `quote_expired` | The quote was already used, or is more than 10 minutes old. Ask for a new quote. |
| 413 | `too_big` / `too_long` | Over a size limit (§1 limits). |
| 415 | `bad_request` | Not JSON. |
| 422 | `not_yet` | askeden.com can't make that kind of media yet. Show "Not yet" and keep the feature off. |
| 422 | `model_unavailable` | That video model is shut down (e.g. Veo 2). Pick a live one from the quote's `models`. |
| 429 | `slow_down` | Rate limit, or too much running at once. Wait `Retry-After` seconds. |
| 502 | `upstream` | The model or media provider failed or is busy. Offer Try again. |
| 503 | `not_set_up` | askeden.com doesn't have that switched on (a missing key, or EVES where askeden.com runs none: §6). Keep the feature off. |
| 500 | `server` | Something broke on askeden.com. Offer Try again. |

**Offline** is the app's own case: the request never reached askeden.com (no network, DNS, TLS, or a timeout before
any byte). The app says "You're offline. Editing still works; Eden needs the internet." and never retries in a loop.

**Rate limits** (the site's own bindings, `site/wrangler.toml`), in two steps:
1. **The network, before any token is checked.** Every app route counts on `API_RATE` as `creative-ip:<network>`.
2. **The account, once its token has been checked.** Every route counts on `API_RATE` as `creative:<account>`.

`API_RATE` is 600 a minute on the live site (120 in `main`'s `wrangler.toml`). There is no second per-account limit
(`USER_RATE` isn't on `main`, and the suite doesn't use it live): a turn's cost is bounded by the allowance, the per-ask
ceiling (§5) and the turns at once below.

So a request with a forged token that names someone else's account only counts against the network it came from. It
never counts against that account, and can't rate-limit anyone out of askeden.com. The `creative:` keys are the suite's
own, apart from the site's chat, mail and other routes.

The ticket exchange counts on `AUTH_RATE` per network (20 a minute), and so does approving a link. On top, per account:
- at most **2 of the suite's turns at once** (Eden turns and EVES runs, all suite apps together): a third gets 429
  `slow_down` with `Retry-After: 10` ("Eden is already answering 2 requests from the Creative Suite on this account");
- those also count among askeden.com's own replies at once (`EDEN_TURNS`: 10 live, 2 on `main`), shared with its chat;
- 3 generation jobs running at once. A clip being made doesn't take one of the replies at once.

**Size limits:** `eden` body 8 MiB; `eves` body 256 KiB; `quote` and `jobs` body 6 MiB (a start frame); others 16 KiB.

**Order of checks** on every app route:
1. The token's form.
2. `API_RATE` for the network.
3. The token itself in the account's object, and on `eden`, `quote`, `jobs` (and `eves` where askeden.com runs it)
   that the account's allowance can pay for anything now (402 `no_allowance`, in askeden.com's words).
4. `API_RATE` for the account.
5. Only then the body. A body that names another suite app than the token's gets 403 `wrong_app`. (Where askeden.com
   runs no EVES, `eves` answers 503 here without reading the body.)

So a revoked token always gets 401 and an account with nothing left always gets 402, whatever it sent. `me`, `revoke`
and `GET jobs/…` need the token only, so a job already paid for stays readable when the allowance runs out. `revoke` is
checked in its own op and counts only per network.

**A token is one app's.** It is bound to the suite app it was linked for (`connection.app`). `eden` and `eves` must send
that `app`; `quote` and `jobs` may leave it out, or must send the same one. Jobs and quotes belong to the token that made
them.

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
   "Link Scorsese to your Eden account?" with **Cancel** and **Link**, and says Eden uses the account's included AI, the
   same allowance as askeden.com (no Plus needed). The form posts to `POST /api/creative/link` (askeden.com's own page,
   its session cookie; not for apps).
3. **Link** sends the browser on to **the asking app's own scheme**, `edenstudio-<app>://link`:

   ```
   edenstudio-scorsese://link?ticket=<ticket>&state=<state>
   ```

   One scheme per app, because macOS hands a URL scheme to one app only and the PKCE verifier is in the app that
   started the link. `<app>` is one of the fixed list above (`edenstudio-scorsese`, `edenstudio-ansel`,
   `edenstudio-davinci`, `edenstudio-houdini`, `edenstudio-lumiere`, `edenstudio-scribe`, `edenstudio-aldus`);
   askeden.com builds the scheme from that list and never from the request as sent. Each app registers its own scheme
   in its `project.yml` (`CFBundleURLSchemes`). The page's `form-action` allows only that app's scheme.
   **Cancel** sends `edenstudio-scorsese://link?error=access_denied&state=<state>`. The app drops any callback
   whose `state` isn't the one it made. The ticket is `<account id>.<43 characters>`, works once, and only for two
   minutes. askeden.com keeps only its SHA-256.
4. The app exchanges it at once:

   `POST /api/creative/token` (no `Authorization`)

   ```json
   { "ticket": "<ticket>", "verifier": "<verifier>", "app": "scorsese" }
   ```

   `app` is the app that asked (the same as in step 1); the ticket was made for that app's scheme only.

   → 200

   ```json
   {
     "token": "es1.<account>.<id>.<secret>",
     "token_type": "Bearer",
     "scope": "creative",
     "connection": { "id": "0123456789abcdef", "app": "scorsese", "created": 1795000000000, "expires_at": 1826536000000 },
     "unlinked": []
   }
   ```

   `unlinked` lists this app's links that were retired to make room, oldest first: `{id, app, label, created,
   last_used}`, e.g. `{"id": "…", "app": "scorsese", "label": "Scorsese on Studio Mac", …}`. It's empty unless that
   app was already linked on 10 Macs. When it isn't empty, the app tells the person, e.g. "Linked. Scorsese on Studio Mac
   was unlinked to make room (10 Macs at most)."

   Errors: 400 `invalid_grant` (used, expired, wrong verifier, or a ticket made for another app), 400 `bad_request`
   (`app` missing or not on the list), 401 `signed_out` (the browser
   that approved signed out within the two minutes), 429.
   Times are Unix milliseconds. The token lasts 365 days; after that, or once revoked, every route answers 401
   `not_connected` and the app links again. askeden.com keeps only the SHA-256 of its secret.
5. **Revoke.** The app's Sign out: `POST /api/creative/revoke` with the token → 204 (also when it was already gone).
   The person can also revoke it on askeden.com › Account › Connected apps (it's listed there as
   "Eden Creative Suite", with the app and device). Either way it stops at once.

Each suite app on each Mac links on its own and holds its own token, bound to that app. Each app has its own cap of 10
links per account, so an 11th Scorsese link retires the oldest Scorsese link and never another app's. When Link would
retire one, the approval page says so before the person agrees ("Scorsese can be linked on 10 Macs at most. Linking this
one unlinks the oldest: Scorsese on Studio Mac, linked 3 March 2026."), and the token's answer lists it in `unlinked`.

Why a ticket and PKCE: another app could claim `edenstudio-scorsese://`. A stolen ticket is useless without the
verifier, which never leaves the app that made it.

Later (not v1): an app on a Mac where Eden Code is already linked could get its ticket from Eden Code with no browser,
as Eden Pulse does through `POST /api/hand/service` (`Eden Notes/LINK-ONCE.md`). That route isn't on this branch's
base yet; when it lands, `{service: "creative"}` would mint the same ticket.

## 3. `GET /api/creative/me`

Any plan, free included. → 200

```json
{
  "account": { "id": "<uuid>", "name": "person@example.com", "email": "person@example.com" },
  "plus": true,
  "paying": true,
  "plan": { "name": "plus", "label": "Pro", "tier": "pro", "paying": true, "source": "stripe", "unlimited": false, "renews": true, "expires": 1797600000000 },
  "usage": {
    "meter": "weekly",
    "label": "This week",
    "percent_used": 40,
    "percent_left": 60,
    "used_usd": 1.2,
    "left_usd": 1.8,
    "total_usd": 3,
    "renews_at": 1795600000000,
    "answers_left": 54,
    "period": { "label": "This period", "percent_left": 79, "left_usd": 9.5, "total_usd": 12, "ends_at": 1796083200000 },
    "credits_usd": 0,
    "can_use": true,
    "why": null
  },
  "eves": { "available": true },
  "allowance": {
    "period_start": 1793491200000,
    "period_end": 1796083200000,
    "budget_usd": 12,
    "used_usd": 2.5,
    "left_usd": 9.5,
    "credits_usd": 0
  },
  "voice": { "today_chars": 1200, "daily_chars": 100000 },
  "connection": { "id": "0123456789abcdef", "app": "scorsese", "created": 1795000000000, "expires_at": 1826536000000, "last_used": 1795000000000 },
  "generation": {
    "video": { "available": true, "models": ["gemini-omni-1.2-flash"] },
    "speech": { "available": true },
    "voice_clone": { "available": false, "why": "Not yet: …" }
  }
}
```

- `name` is the account's sign-in email (askeden.com keeps no other name).
- `plus`: any plan is active (Plus, a promo code's free Plus, or any paid tier). Kept for older builds.
- **`paying`**: the person pays for Eden: a plan bought in the App Store, with Stripe or on Google Play (`plan.source`
  `app_store`, `stripe`, `both` or `google_play`), and the owner's own unlimited accounts. A promo code's free Plus is
  `plus: true` but `paying: false`. **The apps allow the person's own API keys only when `paying` is true.**
- `plan`: `name` is askeden.com's own (`plus` for every paid plan, else `free`); `label` is the plan's name as
  askeden.com shows it (`Free`, `Plus`, and on the live site also `Pro`, `Max`, `Ultra`, `Platinum`, `Eden Black`,
  `Unlimited`); `tier` is askeden.com's tier id where it has them (live), else `null`; `source` as above, or `promo`, or
  `null`.
- **`usage`** is the account's meter in the units askeden.com's account page shows (`public/eden/account.js`), from the
  account's own view, so a free account and every plan read exactly as there:

  | `meter` | `label` | When | `renews_at` |
  |---|---|---|---|
  | `weekly` | This week | a plan released in weekly slices (the live site's `ALLOWANCE_V2`); `answers_left` is askeden.com's "~N answers", and `period` is "This period" beside it | when more arrives |
  | `period` | This period | the same, for a plan with no weekly limit (Eden Black's default) | the period's end |
  | `monthly` | Included AI this month | a plan by the calendar month (`main`) | the 1st of next month |
  | `trial` | Trial AI | no plan: the free trial, used once, not monthly | `null` |

  `percent_left` is rounded as the page rounds it, and `percent_used` is 100 minus it. The dollars behind them are list
  price. `credits_usd` is bought credits, apart. `can_use` and `why` are what a turn would meet now: `why` is askeden.com's
  own sentence (e.g. the trial used up). `answers_left` and `period` are `null` except on the weekly meter. Show it as the
  site does: "This week: $1.80 left (~54 answers)", "Trial AI: 75% left".
- `eves`: whether `POST /api/creative/eves` works for this account now, by askeden.com's own rule (§6), with `why` when
  it doesn't. The same for every plan.
- `allowance`: the plan's period in dollars, as before: what the account page calls the period (or the month), its
  budget, used and left. `budget_usd` is 0 without a plan. Kept for older builds; `usage` is the one to show.
- `voice`: today's characters of the Eden voice and the plan's daily characters (20,000 free, 100,000 with Plus; the live
  site's tiers have their own).
- `generation` lists every kind in §7 with whether askeden.com can make it now.

## 4. Which models Eden may use

The Model Router (`site/src/eden/vendor/model-router.js`, rules only, no paid classifier call) picks one model per
turn from the person's last typed message and the conversation's size. Its pool is the Ask Eden apps' (`eden/ext-chat.js`
`appConfig`: askeden.com's own keys only, never the person's, each provider as switched), narrowed to the models that
can call tools:

| Model | Provider | Needs |
|---|---|---|
| `claude-sonnet-5-5` | Anthropic | `ANTHROPIC_API_KEY` |
| `claude-opus-5-5` | Anthropic | `ANTHROPIC_API_KEY` |
| `gpt-6.1-sol` | OpenAI | `OPENAI_API_KEY` |
| `gemini-4-argon` | Google | `GEMINI_API_KEY` |
| `gemini-3.8-flash` | Google | `GEMINI_API_KEY` |

Each must also be on the site's model list (`EDEN_MODELS`) with its provider switched on: `gemini-4-argon` isn't on
`main`'s list, so it's picked only where askeden.com lists it. Never picked: Kimi K3 (no tool path on the server),
Gemini 3.5 Flash-Lite (too weak for many-step tool use: agentic score 79.7), DeepSeek, Meta and Mistral (opt-in or not
offered). Claude streams token by token; Gemini and GPT are asked once and their answer
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
- `context` (optional, at most 64 KiB as JSON):
  - `instructions` (a string, at most 20,000 characters) is the app's own instructions for Eden. It goes into the system
    prompt after askeden.com's preamble. It must be the app's own fixed text, never anything from the project.
  - Everything else (clip and file names, captions, transcripts, comments) is the project's data.
- `max_tokens` (optional): 256–16,384, default 4,096.

**The project's words are data, never instructions.** In a project several people edit, any clip name, caption or
comment could be someone else's words, so askeden.com fences all of it:
- **The context's data** goes last in the system prompt, as JSON inside one `<project_data app="<app>">…</project_data>`
  block.
- **Each tool result's text** is wrapped in `<tool_output tool_use_id="…">…</tool_output>`. Images in a tool result pass
  as they are.
- **Inside a fence there is no `<` or `>`.** In the JSON they become `<` and `>` (and `&` becomes `&`), so
  it's still exactly the same JSON. In tool output they become `&lt;` and `&gt;` (and `&` becomes `&amp;`). So a clip
  named `ignore previous instructions … </project_data>` stays inside its fence and can't open or close one.
- **A system rule** tells the model that only the person's own messages in the chat are requests. What's inside the
  fences is never an instruction, whoever it claims to be from. It may tell the person what the data asks, but never
  acts on it.
- **What the app must do:** send only the person's own typed words as `user` text, and send everything from the project
  through `context` or tool results. It also still confirms destructive tools with the person before running them.

Before the model is asked: the token, that the allowance can pay for anything (402 `no_allowance`), the rate limits,
then the turn's worst case (input at a token per 3 bytes, images 1,600 tokens each, plus `max_tokens` of output, at the
model's list price):

1. **The per-ask ceiling**, as for every Ask Eden app's token (`eden/ask.js` `appAskMax`: `EDEN_APP_ASK_MAX_USD`, $0.50
   by default). Over it, askeden.com makes the turn fit: first a shorter reply on the router's pick (never under 1,024
   tokens, so a tool call still fits), then the other tool models, cheapest first, the same way. **So the model may be
   asked for fewer tokens than the app's `max_tokens`**, and the reply may stop with `max_tokens` sooner; the `route`
   event names the model that answers. Nothing fits: 402 `over_ask_limit`.
2. **A hold** of that worst case on the account's own allowance (`account.js` `holdAi`, as askeden.com's chat holds a
   reply), as one of the suite's 2 turns at once (§1). Not enough left: 402 `no_allowance`.

Afterwards the account pays what the turn really used (the provider's reported usage; a stopped stream counts what
streamed), on the same meter as askeden.com's chat, and the hold goes.

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

Errors before the stream: 400, 401 `not_connected`, 402 `no_allowance` / `over_ask_limit`, 403, 413, 429 `slow_down`
(the suite's 2 turns at once, askeden.com's replies at once, or the rate limits), 502 `upstream` (the model couldn't be
reached or refused the request), 503 `not_set_up` (no model with tools here).

## 6. `POST /api/creative/eves`: check names, places and facts

EVES on askeden.com, unchanged (`site/src/eden/eves.js`, the same run as `POST /api/chat/eves`): up to three models
answer, an agreement check, a judge and web evidence, then a verdict. The app sends the text; askeden.com asks EVES to
check it.

```json
{ "app": "scorsese", "kind": "captions", "text": "Neil Armstrong walked on the Moon in 1968…", "language": "en" }
```

- `kind`: `captions` or `transcript`. `text`: 1–20,000 characters. `language` (optional): a BCP 47 tag.
- **askeden.com's own EVES rules, the same for every plan** (free included): EVES runs when askeden.com has at least two
  models on its own keys (what its chat calls `eves` in `/api/chat/meta`), never on the person's keys. The run is held
  and paid on the account's own allowance exactly as an EVES run on askeden.com (`allow-ai`, then `hold-ai`, as one of
  the suite's 2 turns at once). The owner-only modes (`EVES_STRONG` "owner", the Gemma judge) stay off here: a suite
  token never counts as the owner.
- `GET /api/creative/me`'s `eves` says beforehand whether it would run: `{"available": true}`, or `false` with `why`.
- Where askeden.com doesn't have EVES (`main` today, `site/src/creative/eves.js`), every call is 503 `not_set_up`
  with the words "EVES isn’t on askeden.com yet, on any plan…", and `eves.available` is false with the same `why`. The
  live site has it (`site/src/eden/eves.js`); the overlay (§9) puts `site/scripts/creative-overlay/eves-live.js` in
  `eves.js`'s place there.

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
as detail. Errors before the stream as in §5, and 503 `not_set_up` when askeden.com has fewer than two models.

## 7. Generated media: quote, then a job

A price first, shown to the person before anything runs; then the job; then its progress and result.
Everything made is labelled **Generated** (`"label": "Generated"` on the job and `X-Eden-Generated: true` on the
result); the app must keep that label on the clip. Google's clips also carry an invisible SynthID watermark.

| `kind` | What | Made with | Paid from |
|---|---|---|---|
| `video` | B-roll, a shot extended, a gap filled: 3–15 s from a prompt, or from a frame of the footage | The models in the table below (today: Google's Gemini Omni Flash) | The account's own allowance (any plan's, else the trial, then credits), at the model's per-second list price; exactly the quote, on success only |
| `speech` | Lines read aloud in the Eden voice: narration, or the "Spanish version" from a translated transcript (the app translates with §5) | Fish Audio, the voice askeden.com reads aloud with | The plan's daily voice characters, as askeden.com's read-aloud counts them (20,000 free, 100,000 with Plus; the live site's tiers have their own), no dollars |
| `voice_clone` | Dubbing in the speaker's own voice | — | 422 `not_yet`: needs the speaker's recorded consent flow and a cloning provider, neither built |
| `lipsync`, `music`, `sound_effects`, `image` | — | — | 422 `not_yet` |

### The video models (checked 2026-11-16)

Every video `quote` lists all of them in `models`, so the app can offer a choice; `GET /api/creative/me` lists the live
ones in `generation.video.models`. The app may ask for one with `model`; without it, askeden.com picks the first live
one (the default).

| `model` | Available | Length | Aspect | Resolution and price | Notes |
|---|---|---|---|---|---|
| `gemini-omni-1.2-flash` (Gemini Omni Flash) | yes, with `GEMINI_API_KEY` and `EDEN_VIDEOS` on | 3–15 s, whole seconds, default 8 | `16:9` (default), `9:16` | `360p` $0.023/s; `720p` (default) $0.069504/s; `1080p` (upscaled) $0.104/s | Native audio; a start frame as `start_image`. Google's Interactions API. |
| `veo-3.0-fast-generate-001` (Veo 3 Fast) | no | — | — | — | Google shut it down on June 30, 2026. |
| `veo-3.0-generate-001` (Veo 3) | no | — | — | — | Google shut it down on June 30, 2026. |
| `veo-2.0-generate-001` (Veo 2) | no | — | — | — | Google shut it down on June 30, 2026, on the Gemini API and on Vertex AI. |

Asking for a model that's shut down is 422 `model_unavailable`, never another model in its place. Sources: Google's
deprecations page (aistudio.google.com/docs/deprecations: Veo 2 and 3.0 shut down June 30, 2026; the Veo 3.1 previews
October 22, 2026; replacement `gemini-omni-1.2-flash`), the Omni docs (aistudio.google.com/docs/omni: 3–15 s,
`response_format` duration, aspect ratio and resolution) and the pricing page (aistudio.google.com/docs/pricing: $12 per
million output tokens, 5,792 tokens a second at 720p, about $0.023/s at 360p and $0.104/s at 1080p).

**Higgsfield isn't here** (checked 2026-11-16). Its official API is real and usable (api.higgsfield.ai, docs at
docs.higgsfield.ai, per-second prices at higgsfield.ai/higgsfield-api, Kling, Seedance, MiniMax Hailuo, Wan, LTX and
more), and it allows commercial use of outputs. But its Terms of Use (Oct 23, 2026, §4.4) and Privacy Policy (Oct 31,
2026, §2.3) let Higgsfield train its and its affiliates' models on what's sent and made, with an exclusion only under an
Enterprise Agreement. That would put people's own footage into someone's training data, so it waits for the owner
(TODO.md).

### `POST /api/creative/quote`

```json
{ "app": "scorsese", "kind": "video", "model": "gemini-omni-1.2-flash", "prompt": "Slow aerial shot over Lisbon at dawn",
  "seconds": 8, "aspect": "16:9", "resolution": "720p",
  "start_image": { "media_type": "image/jpeg", "data": "<base64>" } }
```

- `video`: `prompt` 1–4,000 characters; `model` optional (above); `seconds`, `aspect` and `resolution` within that
  model's limits (defaults as above); `start_image` optional (PNG, JPEG or WebP, at most 4 MiB decoded).
- `speech`: `{"kind": "speech", "lines": [{"text": "Hola y bienvenidos."}, …], "language": "es"}`, 1–100 lines,
  each 1–600 characters, at most 20,000 in all.

→ 200

```json
{
  "quote_id": "<24 hex>",
  "kind": "video",
  "model": "gemini-omni-1.2-flash",
  "model_name": "Gemini Omni Flash",
  "seconds": 8,
  "resolution": "720p",
  "usd": 0.556032,
  "allowance_left_usd": 4.75,
  "chars": 0,
  "voice_left_chars": null,
  "expires_at": 1795000600000,
  "label": "Generated",
  "models": [
    { "id": "gemini-omni-1.2-flash", "name": "Gemini Omni Flash", "provider": "google", "available": true,
      "seconds": { "min": 3, "max": 15, "default": 8 }, "aspects": ["16:9", "9:16"],
      "resolutions": [{ "resolution": "360p", "usd_per_second": 0.023 }, { "resolution": "720p", "usd_per_second": 0.069504 },
                      { "resolution": "1080p", "usd_per_second": 0.104 }],
      "default_resolution": "720p", "audio": true, "start_image": true },
    { "id": "veo-2.0-generate-001", "name": "Veo 2", "provider": "google", "available": false,
      "why": "Google shut Veo 2 down on June 30, 2026, on the Gemini API and on Vertex AI." }
  ]
}
```

(`models` lists all four; two are cut here.) For `speech`, `usd` is 0, there's no `models`, `chars` is the characters
it will take and `voice_left_chars` what's left today. For `video`, `allowance_left_usd` is what the account can spend
now (the figure an askeden.com turn is checked against: the plan's left, this week's on a weekly plan, else the trial,
plus credits). A quote that can't be paid is refused here (402 `no_allowance`: "Not enough of your Eden allowance is
left for this clip…"), before the app shows a price. 400 for a value outside the model's limits; 422 `model_unavailable` for a model that's
shut down; 422 `not_yet` for kinds askeden.com can't make; 503 `not_set_up` when the provider key is missing.

### `POST /api/creative/jobs`

The same body as the quote, plus `quote_id`. It must match the quote exactly (askeden.com compares a SHA-256 of it),
come from the same connection, within 10 minutes, once.

→ 202 the job (below), made on the account's alarm within seconds. A video's price is held on the allowance while it's
made (`account.js` `holdMedia`, the same check as `holdAi`); that hold doesn't count as one of askeden.com's replies at
once or the suite's 2 turns, so an Eden turn still runs while clips are made. 409
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
  "model": "gemini-omni-1.2-flash",
  "model_name": "Gemini Omni Flash",
  "seconds": 8,
  "resolution": "720p",
  "usd": 0.556032,
  "label": "Generated",
  "result": null,
  "error": null
}
```

`status`: `running` → `succeeded` or `failed`. `progress` 0–1 (video: an estimate from the time taken, a clip takes
about a minute or two; speech: lines done). A clip not back within 8 minutes has failed. On `succeeded`, `result` is `{"items": [{"index": 0, "url": "/api/creative/jobs/<id>/result?item=0",
"mime": "video/mp4", "bytes": 3145728}]}` (speech: one item per line, `audio/mpeg`). On `failed`, `error` is
`{code, message}` and nothing was charged for a video (a speech job's characters stay counted, as on askeden.com). Poll
every 3–5 s. Jobs and results are kept 24 hours, at most 20 per account.

### `GET /api/creative/jobs/:id/result?item=0`

The file itself, with the token: `Content-Type` as `mime`, `Content-Length` as `bytes`, `Content-Disposition:
attachment`, `X-Eden-Generated: true`, `Cache-Control: no-store`. 404 when it's gone or not ready, or isn't this token's.

The file is streamed, never sent as one base64 JSON value. The account object keeps it in pieces of about 75 KB and
sends them a few at a time as it reads them, and the Worker passes the stream on. So a long 1080p clip is never held
whole in memory on askeden.com. The app should download it to a file (`URLSession` download task) rather than into
memory. If the stream stops short of `Content-Length`, it asks again; a 404 then means the job's 24 hours are up.

## 8. What isn't here

- Nothing is stored of what's asked: messages, tools and context go to the model and nowhere else; the logs carry no
  tokens, prompts or keys.
- Transcripts and silence detection run on the Mac (Apple's on-device speech recognition), not here.
- Without a link, every editing feature works offline and free; the app says plainly what Eden needs.
- No plan of its own: no Creative Suite allowance, price or Plus gate. A free account uses its trial, then credits.

## 9. Going live (the owner)

askeden.com isn't deployed from `main`: each deploy is the live tree plus only that session's files ("live <version> +
only my files … Rollback: <version>"). So the suite goes live as an **overlay** on the live tree, never as a merge of
this branch:

- `site/scripts/creative-overlay/apply.mjs <live site/> <this branch's site/>` lays it on: 9 new files
  (`src/creative/api.js`, `media.js`, `ops.js`, `turn.js`, `rooms.js`, `rooms-auth.js`, `src/creative/eves.js` from
  `scripts/creative-overlay/eves-live.js`, `test/creative.test.js`, `test/creative-rooms.test.js`) and exact,
  once-only edits to 6 (`src/accounts/account.js`, `src/accounts/index.js`, `src/accounts/scoped.js`, `src/worker.js`,
  `src/eden/chat.js` (exports only), `wrangler.toml`). It stops if an anchor isn't found exactly once, if the overlay
  is there already, or if `EDEN_VIDEOS` isn't `"on"` (it is on the live site).
- `site/scripts/deploy-creative-overlay.sh --from <live site/>` copies the live tree twice into a fresh folder (never
  touching it), runs the whole site suite on the plain copy and on the overlaid one (no new failure allowed, every
  creative and rooms test passing), dry-runs both builds and compares them module by module (only the overlay's modules
  may differ). With `--go --expect-live <version>` only, and only if that's still the live version, it deploys with
  the house message ending "live <version> + only my files … Rollback: <version>". Needs the owner's OK.
- One Durable Object migration: `creative-rooms-v1` (new SQLite class `CreativeRoom`, binding `CREATIVE_ROOMS`) for
  rooms (`docs/creative-rooms.md`). Cloudflare may refuse a rollback to a version before it; then redeploy the plain
  live tree with the binding, the migration and the `CreativeRoom` export kept.
- No new secret or D1 database: it uses the keys askeden.com already has (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GEMINI_API_KEY`, `FISH_API_KEY`), `EDEN_VIDEOS` (on), and the Account object (new storage keys `cquote:`, `cjob:`,
  `cres:` and alarm kind `creative`).
- Then each app's own URL scheme, `edenstudio-<app>` (e.g. `edenstudio-scorsese`), in its `project.yml` (the release
  task).
- Before launch, make the longest clip (15 s at 1080p) once on a dev deploy and watch the account object's memory.
  Sending a result is streamed, but making one still holds Google's answer whole for a moment, because the Interactions
  API returns the clip inline as base64.

## 10. What changed from the first version (owner, 2026-11-16)

The first version is `feat/creative-eden` 54c95a7a. Paths, request bodies, event names and every field it had are
unchanged; these are all the differences an app can see.

**Who may use it**
1. No Plus gate. Every route works for any askeden.com account, free included. 402 `plus_required` is no longer sent
   (§1); a free account spends its trial, then credits, and meets 402 `no_allowance` with askeden.com's own words when
   they're used up.
2. The link page no longer says Eden is part of Plus. It says Eden "uses your Eden account’s included AI, the same
   allowance as Eden here" (§2).

**`GET /api/creative/me` (§3)**
3. New `paying` (top level and `plan.paying`): true for a plan bought in the App Store, with Stripe or on Google Play,
   and for the owner's unlimited accounts; false for a promo code's free Plus and for free accounts. The apps gate the
   person's own API keys on it.
4. `plan` gains `label`, `tier` and `source`. `name` stays `plus` or `free`, and `unlimited`, `renews` and `expires`
   stay.
5. New `usage`: the meter askeden.com's account page shows (`weekly`, `period`, `monthly` or `trial`), with
   `percent_used`, `percent_left`, `used_usd`, `left_usd`, `total_usd`, `renews_at`, `answers_left`, `period`,
   `credits_usd`, `can_use` and `why`.
6. New `eves`: `{available, why?}`.
7. `allowance` keeps its fields but now comes from the account's own view: on a weekly plan it's the whole period
   (`usage` has the week). Without a plan, `budget_usd` is 0 as before.
8. `voice.daily_chars` is the plan's own daily characters (the live site's tiers differ), not a fixed Plus figure.

**`POST /api/creative/eden` (§5)**
9. The account's own allowance, any plan, through `holdAi` and `spend` as askeden.com's chat (before: the Plus
   allowance only).
10. The model pool is the Ask Eden apps' (`appConfig`), on askeden.com's keys.
11. New per-ask ceiling (`EDEN_APP_ASK_MAX_USD`, $0.50 by default). Over it, the model may be asked for fewer
    `max_tokens` than the app sent (at least 1,024), or a cheaper tool model may answer (the `route` event says which).
    Nothing fits: new 402 `over_ask_limit`.
12. At most 2 suite turns at once per account (429 `slow_down`, `retry-after: 10`), inside askeden.com's own replies at
    once (`EDEN_TURNS`: 2 on `main`, 10 live).
13. No per-account `USER_RATE` limit any more; `API_RATE` (network, then account) and `AUTH_RATE` stay (§1).

**`POST /api/creative/eves` (§6)**
14. askeden.com's own EVES rules for every plan (at least two models on its keys), on the account's allowance. On
    `main`, where askeden.com has no EVES, it's 503 `not_set_up` with `why`. Live, the overlay runs hosted EVES. Before,
    it was Plus-only and assumed EVES was there.

**Media (§7)**
15. Video is paid from the account's own allowance, any plan (before: Plus only). The 402 words changed to "Not enough
    of your Eden allowance is left for this clip. Make it shorter or smaller, or add credits on askeden.com (Settings ›
    Account)." `allowance_left_usd` is what the account can spend now (on a weekly plan, this week's), plus credits.
16. Speech counts the plan's own daily voice characters (free 20,000, Plus 100,000, live tiers their own). Before, it
    was Plus only.
17. A clip's hold no longer counts against the replies at once, so an Eden turn runs while up to 3 clips are made.
18. `EDEN_VIDEOS` is on (`wrangler.toml`; the live site already had it on), so `generation.video.available` is true
    where `GEMINI_API_KEY` is set.

**Going live (§9)**
19. It goes live as an overlay on the live tree (`scripts/deploy-creative-overlay.sh`), not as a merge. It adds one
    Durable Object migration, `creative-rooms-v1`, for rooms.
