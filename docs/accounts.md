# Jarvis accounts

An optional account, at askeden.com, for what one person's own devices can't do alone:

1. **Jarvis Plus**: AI included, for people without an Anthropic key or a Claude sign-in.
   A subscription bought in the iPhone app (StoreKit 2, auto-renewable) or, beside it, on
   the web with Stripe ("Billing on the web" below), and a one-time trial allowance for
   every new account.
2. **Push relay**: the Mac's notifications reach the phone through askeden.com's Apple push
   key, so no one needs a `.p8` of their own.
3. **Encrypted relay**: the phone reaches its Mac from anywhere (no shared Wi-Fi, no
   Tailscale). The relay carries the companion's own TLS bytes, pinned to the Mac's
   certificate, so askeden.com sees only ciphertext.
4. **Sync**: memory, settings and phone chats, sealed on the device with a key the server
   never has.

Everything works without an account, exactly as before. The account holds only what those
four need: devices, the plan, usage counts, relay sockets for a moment, and sealed sync
items. No names, no email from Apple (Sign in with Apple's email is never stored); for a
linked Google sign-in only its verified address, to show which Google account it is. No
raw Apple or Google user id (only SHA-256 hashes), no conversation text outside sealed
sync items, which only the account's devices can open. Eden's own history (Eden sync, below),
its team spaces' shared conversations and their keys are stored the same way: sealed in the
browser, never readable here.

Sign-in is Sign in with Apple, on the iPhone. On the web (askeden.com, Eden) it is also
Sign in with Apple or Google, or a code the iPhone or a linked Mac approves; the browser
becomes a `web` device of the same account (docs/web-auth.md is that contract). A Mac joins
the account by **linking**: it
shows a code (and a QR code); the signed-in iPhone approves it, and hands the Mac the sync
key sealed to the Mac's own key on the way. A paired iPhone can do all of it in one tap.

The server is the askeden.com Worker (`site/src/worker.js` routes `/api/…` to
`site/src/accounts/`). Each account is one Durable Object (`Account`), named by the account
id; each pending link is one (`Link`), named by its code; each sign-in identity (an Apple ID
or Google account that has signed in since identities were kept) is one (`Identity`), named
`<provider>:<SHA-256 hex of "<provider>:<sub>">`, holding the account it opens; each Eden
team space is one (`Space`, binding `SPACES`, migration `v4`), named by its id. No database
beyond those.

---

## Credentials

A device credential is a bearer token:

    jv1.<account id>.<device id>.<secret>

- account id: a UUID, lowercase (`8-4-4-4-12`). For an account first made with Apple
  (every account the iPhone app makes), derived from the Apple user id: the first 16 bytes of
  SHA-256(`"jarvis-account-v1:" + sub`), formatted as a UUID with the version nibble 8 and the
  RFC 4122 variant. For an account first made with Google on the web, or for an Apple ID
  signing in again after it was unlinked, a random UUID v4. Either way it is the StoreKit
  `appAccountToken`.
- device id: 16 lowercase hex characters.
- secret: 43 base64url characters (32 random bytes). The server keeps only its SHA-256.

Sent as `Authorization: Bearer <token>`. The Anthropic-compatible proxy also takes it as
`x-api-key: <token>` (what Claude Code sends for `ANTHROPIC_API_KEY`).

Where it's kept:
- iPhone: Keychain, account `account.v1`, JSON `{"token","accountID","deviceID"}`, in the
  App Group's access group (so the share extension and intents have it). Not synchronizable.
- Mac: the Keychain through `connectors.Vault`, id `jarvis-account`, key `token`.

Errors are JSON `{"error": "<words for a person>", "code": "<machine code>"}` with these
statuses: 400 bad request, 401 `signed_out` (token unknown or revoked: forget it and show
signed out), 402 `no_allowance` (plan or trial spent), 403 `forbidden`, 404 `not_found` /
`offline`, 409 `conflict`, 410 `expired`, 413 `too_big`, 429 `slow_down` (with
`retry-after`), 503 `not_set_up` (a server secret is missing).

## Endpoints

Base: `https://askeden.com/api` (www. works too). JSON in and out unless noted.

### Account

`POST /account/apple` — sign in (or sign up) with Apple. No auth.

    { "identity_token": "<JWT from ASAuthorizationAppleIDCredential.identityToken>",
      "nonce": "<the raw nonce whose SHA-256 hex was set as request.nonce>",
      "authorization_code": "<credential.authorizationCode as UTF-8>",      // optional
      "device": { "name": "Bilel's iPhone", "kind": "iphone", "app_version": "1.0 (2026…)" } }

    → 200 { "token": "jv1.…", "account": <Account>, "device_id": "…", "new": true|false }

The identity token must be signed by Apple (keys at appleid.apple.com/auth/keys), issued
by `https://appleid.apple.com`, for audience `com.askeden.jarvis`, unexpired,
with `nonce` equal to SHA-256 hex of the raw nonce. `kind` is `iphone`, `ipad`, `watch` or
`mac` (a `mac` signing in with Apple is made an `iphone`; Macs link). The account is the one
the Apple ID's `Identity` names (it may have been linked to an account made with Google on
the web), else the account its id derives from; a new one is made on the trial allowance.
New accounts count against `AUTH_RATE` per network. The authorization code, when the server has a Sign in with Apple key, is traded for
Apple's grant so that deleting the account can revoke it (Apple asks for that).

`GET /account` (auth) → 200 `<Account>`:

    { "id": "…uuid…",
      "created": 1790000000000,                       // ms since 1970
      "plan": { "name": "free" | "plus", "active": bool, "product_id": "…" | null,
                "expires": ms | null, "renews": bool | null, "environment": "Production"|"Sandbox"|null,
                "source": "app_store" | "stripe" | "both" | null,
                "manage": { "app_store": "<url>" | null, "stripe": "portal" | null },
                "payment_failed"?: true },
      "usage": { "period_start": ms, "period_end": ms | null,
                 "spent_usd": 0.42, "budget_usd": 20, "left_usd": 19.58,
                 "trial_left_usd": 1.0, "trial_usd": 1, "plus_usd": 20,
                 "voice_today": 1200, "voice_daily": 100000 },
      "devices": [ { "id", "name", "kind", "created", "last_seen", "app_version",
                     "push": bool, "relay": bool, "this": bool, "expires"?: ms } ],
      "identities": [ { "provider": "apple" | "google", "email": "…" | null, "added": ms } ],
      "sync": { "rev": 12, "items": 5 } }

Device `kind`s: `iphone`, `ipad`, `watch`, `mac`, and `web`: a browser signed in to Eden at
askeden.com (by Sign in with Apple or Google, the Eden app's handoff, or a code this account's
iPhone or Mac approved). A `web` device ends after 30 days (`expires`), at most 5 are signed
in at once (a sixth signs out the oldest), and it may use only hosted Eden: not the raw
Anthropic proxy, the relay, the apps' sync, pushes, the voice, the plan, other devices, linking
or deleting the account (403 `forbidden`). It may use Eden's own end-to-end encrypted sync
(`eden/` items, "Eden sync" below) once it holds the key. A delegate's or team space member's
session is a `web` device too, with a `grant` that narrows it further ("Delegates" below); it
isn't listed among the account's devices. The apps list browsers like any device and may
remove them (`DELETE /devices/<id>`). `identities` are the account's ways to sign in (one per
provider; Apple's `email` is always null). Browsers manage both at `/api/web/*`
(docs/web-auth.md).

`DELETE /account` (auth) → 204. Everything goes: devices (every token stops working), the
plan record, usage, sync items, and the account's identities (its Apple ID and Google
account open a new account next time). The subscription itself is Apple's: the app tells the
person to cancel it in Settings › Subscriptions too (Apple requires both words). A Stripe
subscription (Plus bought on the web) is cancelled at once by the server (best effort).

`PUT /devices/me` (auth) → 204. Any of:

    { "name": "…", "app_version": "…",
      "apns_token": "<hex>", "apns_env": "production" | "sandbox" }

`apns_token: null` stops pushes to this device.

`DELETE /devices/<id>` (auth) → 204. Signs that device out (`me` = this one). A Mac unlinked
this way stops relaying and pushing at once.

### Linking a Mac

1. The Mac: `POST /link/start` (no auth)

       { "name": "Bilel's MacBook Air", "kind": "mac", "public_key": "<base64 X25519, 32 bytes>",
         "app_version": "0.1.6" }
       → 200 { "code": "K7QM-4ZTR", "poll": "<secret>", "expires_in": 600 }

   Code: 8 characters of Crockford base32 without I, L, O, U, shown `XXXX-XXXX`; the
   iPhone accepts it with or without the dash, any case. QR: `jarvis-link://K7QM-4ZTR`.

2. The iPhone (auth): `GET /link/<code>` → 200 `{ "name", "kind", "public_key", "expires_in" }`
   (to show "Link “Bilel's MacBook Air”?"), 404 unknown, 410 expired.

3. The iPhone (auth): `POST /link/<code>/approve`

       { "sealed_key": "<base64>" | null, "sender_key": "<base64 X25519, 32>" | null }
       → 200 { "device_id": "…", "name": "…" }

   `sealed_key` is the sync key (32 bytes) sealed to the Mac (below). Null when the phone
   has no sync key yet.

   `POST /link/<code>/deny` (auth) → 204.

4. The Mac polls every 2 s: `POST /link/poll { "code", "poll" }`
   → 202 `{ "status": "waiting" }`
   → 200 `{ "token", "account_id", "device_id", "sealed_key", "sender_key" }` (once; the link is gone after)
   → 410 `{ "code": "expired" | "denied" }`

Wrong codes cost: 30 link starts a minute per network, 30 lookups a minute per account, 30 polls a minute per code.

**Sealing the sync key to the Mac** (and nothing else uses it):

    shared   = X25519(sender private, mac public)
    key      = HKDF-SHA256(ikm = shared, salt = empty, info = "jarvis-link-v1", 32 bytes)
    sealed   = ChaCha20-Poly1305(key, nonce = 12 random bytes, plaintext = sync key,
                                 aad = "jarvis-link-v1")
    wire     = base64(nonce ‖ ciphertext ‖ tag)          // CryptoKit's SealedBox.combined

CryptoKit: `sharedSecret.hkdfDerivedSymmetricKey(using: SHA256.self, salt: Data(),
sharedInfo: Data("jarvis-link-v1".utf8), outputByteCount: 32)`. Python `cryptography`:
`HKDF(SHA256(), 32, salt=None, info=b"jarvis-link-v1")` (an empty salt and no salt are the
same key), `ChaCha20Poly1305(key).decrypt(nonce, ct_and_tag, b"jarvis-link-v1")`.

**One tap from a paired iPhone** (the companion API, on the Mac, paired-device auth):
`POST /api/account/link` → the Mac starts a link and answers `{ "code": "…" }`; the phone
approves it straight away (step 3) and the Mac's poll finishes. `GET /api/account` on the
companion → `{ "linked": bool, "account_id": "…"|null, "device_id": "…"|null }`. The
companion's `/api/state` also carries `"account": { "device_id": "…" }` once linked, so the
phone knows which account device is the Mac it's paired with (for the relay).

### Push relay

`POST /push` (auth: any device, normally a Mac) →

    { "apns_token": "<hex>", "apns_env": "production" | "sandbox",
      "push_type": "alert" | "background" | "liveactivity",
      "priority": 10 | 5, "collapse_id": "…"?, "expiration": seconds?,
      "payload": { "aps": { … }, … } }
    → 200 { "status": 200, "apns_id": "…" }
    → 200 { "status": 410 | 400 | …, "reason": "Unregistered" | "BadDeviceToken" | … }

- `alert` and `background`: the token must be one a device on the same account registered
  (`PUT /devices/me`). An APNs "gone" reason clears it there.
- `liveactivity`: any token (activity tokens aren't registered); topic
  `<bundle>.push-type.liveactivity`.
- Payload at most 4096 bytes. 60 pushes a minute per account.
- 503 `not_set_up` until the APNs key is a Worker secret.

Eden's background tasks push to the account's own iPhone/iPad/Watch themselves
(`site/src/accounts/tasks.js`): `eden: { url: "/#tasks", kind: "task" | "approval", task,
approval? }`, and an approval carries `aps.category` `EDEN_TASK_APPROVAL` (the app's Approve and
Deny). Answering one from the notification:

`POST /tasks/approvals/<approval id>` (auth: the app's own device token, iPhone, iPad or Watch;
a request with an `Origin` is refused, so no page can make it) `{ "decision": "approve" | "deny" }`
→ `200 { "approval": { id, status: "approved" | "denied" | "failed", result, error, … } }`, the
same decision as Eden's Tasks panel (an approve is the owner's tap: `confirm: true`). 404 gone,
409 already answered, 410 expired, 403 from a browser's or a Mac's token.

### Encrypted relay (phone ↔ Mac from anywhere)

Three WebSockets, all `wss://askeden.com/api/relay/…`, auth in the upgrade request's
`Authorization` header:

- `GET /relay/listen` (a Mac): its control line. The server sends text frames:
  `{"type":"open","stream":"<id>","from":"<phone device id>"}` when a phone wants in. The Mac
  keeps it alive: WebSocket protocol pings (the websockets library's default), or the text
  `{"type":"ping"}`, which the server answers `{"type":"pong"}` (without waking up). The Mac
  reconnects with backoff (1, 2, 4 … 60 s) whenever it drops. One per Mac: a new one
  replaces the old.
- `GET /relay/connect?to=<mac device id>` (a phone): binary frames are the raw bytes of
  one TCP connection to the Mac's companion port. 404 `offline` (before the upgrade) when
  that Mac isn't listening.
- `GET /relay/accept?stream=<id>` (the Mac, after an `open`): the other end of that stream.
  The Mac connects it to `127.0.0.1:<companion port>` and copies bytes both ways.

Bytes the phone sends before the Mac accepts are held (up to 256 KiB) and delivered in
order. Either side closing closes the other. Frames at most 64 KiB; at most 16 streams per
account at once; a stream idle 10 minutes is closed.

On the iPhone a loopback listener (`127.0.0.1:<random>`) turns each URLSession connection
into one relay stream, so `JarvisAPI` simply uses `https://127.0.0.1:<port>` with the same
pinned fingerprint: TLS runs end to end, iPhone to Mac.

### Eden web relay (askeden.com's Eden ↔ Eden on the Mac)

Eden at askeden.com runs Claude by itself; Jarvis (notes, memory, calendar, mail), Code mode
and its projects live on the owner's Mac. The Mac holds one WebSocket to the account, and
hosted Eden forwards those requests down it to Eden's own server on the Mac
(`model-router-ui`, `http://127.0.0.1:5174`), streaming the answers back. The browser never
reaches the relay: only the Worker does, for a signed-in `web` device of the same account.

`GET /relay/web` (a Mac; auth in the upgrade's `Authorization` header): the Mac's web
channel. One per Mac (a new one replaces the old); with several Macs, the newest answers.
Pings as for `relay/listen`. 403 for anything but a `mac` device (a phone or a browser).
Code: `site/src/accounts/webrelay.js` (Worker and Account object), `src/jarvis/eden_link.py`
(the Mac, started with the account's other loops; Settings key `account_eden_link`, on unless
turned off).

What goes through (both sides keep the same list; anything else never leaves the Worker):
`GET /api/chat/jarvis/status`, `POST /api/chat/jarvis`, `GET /api/chat/projects`,
`POST /api/chat/code`, `POST /api/chat/code/steer`, `GET /api/chat/code/changes` (the only
one with a query: `project`), `POST /api/chat/brief` (the morning brief and meeting prep: reads
only; the Mac also checks its `kind`). Memory's tools (`memory_list`, `memory_update`,
`memory_delete`, `memory_toggle`, `commitments`) ride `POST /api/chat/jarvis`; each change still
waits for the owner's card in Jarvis. Meetings, browser tasks and undo (`meetings_list`,
`meeting_read`, `commitment_add`, `browser_task`, `browser_task_status`, `browser_task_stop`,
`actions_list`, `action_undo`) ride it too, with `POST /api/chat/meetings/actions` (a meeting's
action items), `GET /api/chat/actions` (the Activity timeline) and `POST /api/chat/actions/undo`
(only Jarvis's own actions, ids `ea-…`; Eden's Google changes are undone on the Mac); a promise,
a browser task and an undo each wait for the owner's card. "Use my Mac" (`files_search`,
`file_read`, `file_summarize`, `screen_context`, `knowledge_add_folder`, `knowledge_list`,
`knowledge_search`) rides it too, all read only (files: a card once per app; the screen: a card on
every look), with `POST /api/chat/mac/send` for a chat turn that reads the Mac's files and project
knowledge (the Mac's own models answer it). Privacy mode (G9): `POST /api/chat/send` only for a
turn with `privacy: true` (hosted Eden forwards no other, and the Mac refuses any other), answered
by a local model on the Mac and never a cloud one, with `GET /api/chat/local` (its local models,
for the page's picker; hosted Eden passes on only their names). Never API keys, adding a project
folder, the router dashboard or `/download`. Gmail and Google Calendar run on the Worker itself.

Frames. Text frames are JSON; binary frames are a stream's id (16 lowercase hex characters,
as ASCII) followed by up to 64 KiB of body.

    Worker → Mac   {"t":"req","id","method","path","headers":{"content-type","accept"},
                    "from":"<the asking web device's id>","size":<body bytes>}
                   binary body frames, then {"t":"end","id"}
                   {"t":"ack","id","n"}       n more answer bytes reached the browser
                   {"t":"cancel","id","why"}  the browser stopped ("stopped"), or a cap ("timeout", "window", "too_big")
    Mac → Worker   {"t":"res","id","status","headers":{"content-type"}}
                   binary body frames, then {"t":"end","id"}
                   {"t":"error","id","status","error","code"}   instead of res (a refusal), or after it (broke off)

The Mac adds `X-Jarvis-Chat: 1` and sends no Origin, cookie or token to Eden's server. It
checks, whatever the Worker did: the route (above); that `from` is a `web` device in this
account's `GET /account` device list (asked again for a browser it doesn't know yet); a body
of at most 10 MiB; Jarvis tools only from its list (a new tool isn't reachable from the web
until it's added there); Code mode never in `bypassPermissions` from the web. Sends and
calendar changes still need `confirm: true` and the owner's card in Jarvis.

Limits: 16 requests at once per account; 10 MiB a request, 64 MiB an answer; the Mac keeps
at most 256 KiB of an answer unacknowledged (a slow browser slows the Mac, not the Worker);
130 s for the Mac to answer (Jarvis may be waiting on its "Let Eden use Jarvis?" card), then
10 minutes between pieces of an answer. A Mac that ignores the window is cut off.

Stop: the browser aborts its fetch; the Worker cancels the stream (with
`enable_request_signal`, `request.signal` says the browser went away), the Account object
sends `cancel`, and the Mac drops its request to Eden, which stops the turn (a Code turn's
`claude` process ends).

What hosted Eden answers: while the Mac is connected, those routes are the Mac's, and
`GET /api/chat/meta` reports `jarvis` (the Mac's own status) and `code` as available. A Mac
linked but not connected: 503 `{"code":"mac_offline","error":"Your Mac is offline. …"}`; no
Mac linked: 503 `needs_mac`, as before. Eden on the Mac not running: 502 `eden_off`.

Not end-to-end encrypted: askeden.com sees the requests and answers as they pass. Nothing is
kept or logged (not bodies, not queries); the Mac logs only the method, the path and the status.

### Included AI (Anthropic-compatible proxy)

`POST /anthropic/v1/messages`, `POST /anthropic/v1/messages/count_tokens` (auth: Bearer or
`x-api-key`). The body and headers are Anthropic's (`anthropic-version`, `anthropic-beta`
pass through); the server swaps in its own key. So:

- the iPhone's `ClaudeClient` points its base URL at `https://askeden.com/api/anthropic`
  with `Authorization: Bearer <token>`;
- the Mac's Claude Code runs with `ANTHROPIC_BASE_URL=https://askeden.com/api/anthropic`
  and `ANTHROPIC_AUTH_TOKEN=<token>` (and no `ANTHROPIC_API_KEY`).

Only `claude-*` models. Before a request: 402 `no_allowance` (in Anthropic's error shape,
`{"type":"error","error":{"type":"billing_error","message":"…"}}`) when the plan's monthly
allowance and the trial are both spent. After it, the cost is counted from the reply's
`usage` (streamed or not) at list prices, web searches included. A request that starts
inside the allowance always finishes.

Allowances (Worker vars): Plus `PLUS_BUDGET_USD` (20) a month, trial `TRIAL_BUDGET_USD` (1)
once per account.

### Plan (StoreKit 2)

Products (one subscription group, "Jarvis Plus"):
`com.askeden.jarvis.plus.monthly`, `com.askeden.jarvis.plus.yearly`.

The app buys with `appAccountToken = UUID(account id)`, then `POST /subscription`
`{ "signed_transaction": "<Transaction.jwsRepresentation>" }` → 200 `<Account>`. It also
sends the newest `Transaction.currentEntitlements` at launch and on
`Transaction.updates`. The server checks the JWS's certificate chain up to Apple Root CA –
G3, the bundle id, the product, and that `appAccountToken` is this account.

`POST /appstore/notifications` — App Store Server Notifications V2 (`{signedPayload}`),
same checks; renewals, expiries, refunds and revocations update the plan.

### Billing on the web (Stripe)

Plus can also be bought at askeden.com with Stripe Checkout (test mode first; ROADMAP F15):
`site/src/eden/billing.js` (the Worker: Checkout, the Customer Portal, the signed webhook) and
`site/src/accounts/stripe-plan.js` (the Account object's side). The endpoints, the webhook's
checks, the owner's steps in the Stripe dashboard and the security notes are in docs/web-auth.md
"Billing on the web (Stripe)" and "Owner steps".

- **Two plans, one Plus.** The App Store's plan stays where it was (`plan`, unchanged); Stripe's is
  kept apart (`stripe_plan`: `{ customer, subscription, status, price, period_end, renews,
  livemode, past_due_since, payment_failed_at, updated }`). The account has Plus while either is
  active, and `expires`, `renews` and `environment` are the later one's (Stripe test mode reads as
  `Sandbox`). `source` says which (`app_store`, `stripe`, `both`), `manage` where each is managed
  (Apple's subscriptions page; `"portal"`: `POST /api/web/billing/portal`). The included AI,
  the voice allowance, delegates and team spaces don't care which one paid.
- **Stripe's statuses.** `active` and `trialing` are Plus until the period ends (a day more while
  it renews, in case the webhook is late); `past_due` stays Plus 3 days from the first failure
  while Stripe retries, with `payment_failed: true`; `canceled`, `unpaid`, `incomplete`,
  `incomplete_expired` aren't Plus. A canceled subscription never comes back; a new Checkout makes
  a new subscription on the same Stripe customer.
- **Ops** (`stripe-` prefix; Worker only): `stripe-checkout` and `stripe-portal` need a device of
  the account that isn't a grant's; `stripe-event` (after the webhook's signature) applies one
  event once (`stripe_seen`: 100 ids, 30 days) and in order (each event's `created`), and never
  to an account that doesn't exist. `stripe_pending` keeps the open Checkout's idempotency key.
- The apps read the same `plan`; a Plus bought on the web shows as Plus in the J.A.R.V.I.S. apps
  too (its `product_id` is null; manage it on the web).

### JARVIS voice

`POST /voice` as before (`X-Jarvis-Install`); with `Authorization: Bearer <token>` it
counts against the account instead: `VOICE_DAILY_FREE` (20 000) characters a day, Plus
`VOICE_DAILY_PLUS` (100 000).

### Sync

Items are sealed on the device:

    sealed = ChaCha20-Poly1305(sync key, nonce = 12 random bytes, plaintext = item JSON (UTF-8),
                               aad = item key (UTF-8))
    data   = base64(nonce ‖ ciphertext ‖ tag)

The sync key is 32 random bytes made by the first iPhone that turns sync on. iPhone:
Keychain account `sync-key.v1`, **synchronizable** (iCloud Keychain), so the person's other
iPhones have it. Mac: from linking (above), in `connectors.Vault` id `jarvis-account`, key
`sync_key`. A device without the key can't read anything; Settings offers "Start sync
over" (`DELETE /sync`, then a new key).

`GET /sync?since=<rev>` → 200 `{ "rev": 14, "items": [ { "key", "rev", "data" | null,
"deleted": bool, "updated": ms } ], "more": bool }` (at most 200 items a page).

`PUT /sync/<key>` `{ "data": "<base64>", "base_rev": <rev the device last saw, 0 for new> }`
→ 200 `{ "rev" }`, or 409 `{ "code": "conflict", "item": { "key", "rev", "data" } }`:
merge with that and try again.

`DELETE /sync/<key>?base_rev=<rev>` → 200 `{ "rev" }` (a tombstone, so others delete it too).
`DELETE /sync` → 204 (everything, for a new key).

Keys: `[A-Za-z0-9._:-]{1,128}`. Data at most 512 KiB. At most 2 000 items.

Items (the plaintext JSON):

- `keycheck`: `{"v":1,"check":"jarvis-sync-v1"}`. Written by whoever makes the key; a device
  that can't open it has the wrong key (say so; don't overwrite anything).
- `memory`: `{"v":1,"facts":[{"id":"<uuid lowercase>","text":"…","category":"…",
  "updated":ms,"deleted":bool}]}`. Categories are the Mac's (`people`, `preferences`,
  `work`, `health`, `places`, `other`) plus `goals` and `corrections`. The iPhone maps its
  kinds: person→people, preference→preferences, goal→goals, correction→corrections,
  fact→other. Merge: union by id; for one id the larger `updated` wins (a delete is a
  tombstone, kept 90 days).
- `settings`: `{"v":1,"updated":ms, "owner_name"?, "address_as"?, "language"?, …}`:
  last writer wins for the whole item; keep fields you don't know.
- `chat:<uuid>`: one iPhone conversation, `{"v":1,"id","title","updated":ms,
  "messages":[{"role":"user"|"assistant","text","at":ms}], "project"?: "…"}`. Last writer
  wins. The Mac neither reads nor deletes these.

Devices sync when something changes (a few seconds later), at launch, and every 5 minutes
while open.

### Eden on the web (askeden.com)

Eden at askeden.com is the same page as on the Mac (`~/askeden/web/chat`, copied into
`site/public/eden` by `scripts/sync-eden.mjs`), behind the web sign-in (docs/web-auth.md). The Worker
runs routed chat itself on the account's included AI (`site/src/eden/chat.js`), and forwards what only
a linked Mac can do through the Eden web relay (above).

What askeden.com keeps for Eden, and for how long:

- **Artifacts** (a reply's HTML or SVG preview): in the account object for **6 hours**, the 30
  newest, 2 MB each (`ARTIFACTS` in `account.js`), shown at `/artifact/<id>` only to the account's
  signed-in browsers, under the artifact sandbox CSP. After that, 404.
- **Published pages** (G10, below): an artifact the owner chose to keep, until they take it down.
- **Chat history**: in the browser, and, with Sync on, as sealed items askeden.com can't open (Eden
  sync, below). The routing profile learned from you, saved workflows and email signatures travel
  the same way (`eden/learn`, `eden/workflows`, `eden/signatures`); with Sync off they stay in that
  browser.
- **Google** (Gmail, Calendar): the tokens, AES-GCM encrypted per account under `EDEN_TOKEN_KEY`
  (`site/src/accounts/tokens.js`), and the connected address. Scheduled sends wait in the owner's
  Gmail Drafts; the account's alarm queue holds only the draft's id and the time.
- **Compose attachments**: uploaded once, in pieces in the account object, for 6 hours after their
  last use at most (100 MB and 100 uploads an account), deleted after the send
  (`site/src/accounts/mail-uploads.js`).
- **Tasks** (G3): each task (its trigger and the owner's plan, in their words), its last 10 runs'
  summaries and its approvals; not the text of the mail or events it read.
- **Usage**: what each turn cost against the allowance (model, tokens, dollars), never its text.

What it never stores: a turn's text (the prompt, the attached context, the reply). It passes
through to Anthropic and back as it streams, and isn't logged. Nor the bodies the Mac relay carries,
files read on the Mac, mail bodies, or any key that opens sealed items (the Eden sync key, a team
space's key).

Refusals: when Claude declines a request (`stop_reason: "refusal"`), the turn ends with "Claude
declined this request." **Refusal fallbacks aren't enabled**: hosted Eden doesn't send a declined
request on to another model. Its one fallback (the router's next choice) is only for a model that
failed before writing anything.

### Published pages (Eden, G10)

`site/src/accounts/published.js`. Eden at askeden.com can keep an artifact as a live page at
`/p/<id>` until its owner takes it down (artifacts themselves are kept 6 hours).

- The id is 16 random bytes (22 base64url characters); the link never carries the account id. The
  page (its HTML in pieces of 60,000 characters, title, access, size, times) lives in the owner's
  account object (`pubh:<id>`, `pubc:<id>:<n>`); an object of its own in the ACCOUNTS namespace,
  named `pub:<id>`, holds only `{ account }` so `/p/<id>` can find it. Deleting the account deletes
  its pages (their `pub:` entries then lead nowhere: 404).
- Access: `private` ("only me": a browser signed in to the owner's account; signed out gets a short
  401 page with "Sign in to Eden", another account a 404) or `link` ("anyone with the link").
  Served under the artifacts' sandbox CSP (scripts in an opaque origin; no network, cookies, forms
  or popups), `cache-control: no-store` (a change or a take-down holds at once), `x-robots-tag:
  noindex`, `referrer-policy: no-referrer`. Views are rate-limited per network (API_RATE).
- Caps: 2 MB a page (in UTF-8 bytes), 20 pages an account.
- Hosted Eden's API (signed-in browser, `X-Jarvis-Chat: 1`, same-origin JSON):
  `POST /api/chat/publish { html, title?, access? }` → page; `GET /api/chat/published` →
  `{ pages, max, bytes }`; `POST /api/chat/published/access { id, access }` → page;
  `POST /api/chat/published/revoke { id }` → `{ id, revoked: true }`. A page is
  `{ id, url: "/p/<id>", title, access, bytes, created, updated }`.
- Account-object ops (internal): `pub-put`, `pub-list`, `pub-access`, `pub-delete` (as a device),
  `pub-read` (the Worker, for `/p/`); on a `pub:<id>` object `pub-index-claim`, `pub-index-get`,
  `pub-index-drop` (refused on a real account's object).

### Eden sync (H1: chat history on every device, end to end encrypted)

`site/src/accounts/eden-sync.js` (server), `~/askeden/web/chat/sync.js` and `eden-crypto.js`
(browser). Eden's conversations sync between the account's browsers through sealed items
askeden.com can't open, in a space of their own in the Account object (`e:eden/<name>`, their
own revision counter `erev` and caps), apart from the apps' items above: the apps' `GET /sync`
never returns them, "Start sync over" in the apps doesn't touch them, and browsers still can't
read or write the apps' items.

**A separate Eden key, not the apps' sync key.** Interoperating was looked at and left out:
Web Crypto has no ChaCha20-Poly1305 (the apps' item cipher), so a browser would need a JS
cipher and could only hold that key in a form its own script can read. And the apps' key opens
Jarvis memory, settings and phone chats, which Eden in a browser doesn't need: a stolen browser
(or a script injected into the page) would expose them all. So Eden has its own 32-byte key,
used with AES-256-GCM (native, non-extractable in the browser), and a browser only ever holds
that one. The J.A.R.V.I.S. apps join with the same protocol, as members of their own (below:
"The J.A.R.V.I.S. apps").

Crypto (`eden-crypto.js`; all base64):

    device key  X25519 (P-256 ECDH where a browser lacks X25519); the private half made
                non-extractable and kept in IndexedDB (`eden-keys`, per account)
    item        nonce(12) ‖ AES-256-GCM(Eden key, aad = "eden-sync-v1:<item key>",
                0x01 ‖ JSON  or  0x02 ‖ gzip(JSON))
    sealed key  nonce(12) ‖ AES-256-GCM(HKDF-SHA256(ECDH(sender, device), salt = "",
                info = "eden-seal-v1"), aad = "eden-seal-v1", Eden key); sender = a fresh key pair
    wrap        { v: 1, kdf: "PBKDF2-SHA256", iterations: 600000, salt(16),
                  data: nonce(12) ‖ AES-256-GCM(PBKDF2(passphrase NFKC), aad = "eden-wrap-v1", Eden key) }
    proof       base64url(HKDF-SHA256(Eden key, salt = "", info = "eden-sync-v1-proof", 32 bytes));
                the server keeps only its SHA-256, so only a holder of the key can mark a device trusted
    code        six digits from SHA-256("eden-trust-v1:" + device public key), shown on both screens
    mac         base64url(HKDF-SHA256(Eden key, salt = "", info = "eden-member-v1:<alg>:<public key>", 32 bytes)):
                a member's public key vouched for by a holder of the key (below: removing a device)
    link        nonce(12) ‖ AES-256-GCM(HKDF-SHA256(new key, salt = "", info = "eden-chain-v1"),
                aad = "eden-chain-v1:<gen>:<new epoch>", old key): a key change's old key under the new one

Getting the key into a browser:
1. The first browser makes it and must choose a **recovery passphrase** (at least 12
   characters, or the 25-character one Eden suggests). PBKDF2-HMAC-SHA256 with 600 000 rounds
   (Argon2 isn't in Web Crypto; the server refuses fewer than 310 000). The wrap is kept here, so
   askeden.com could try passphrases offline: that is why it must be strong.
2. **Trust this browser**: a new browser posts its public key; a device that has the key (a
   browser, or the J.A.R.V.I.S. app on the iPhone or Mac) sees the request with the six digits,
   and approves only if the new browser shows the same; it seals the key to that public key
   (echoed back, so the server can't swap it after the check). The new browser opens it and
   proves it.
3. Or the passphrase, in a browser with no other device at hand.
A browser that signs in again (a new device id) and still has the key proves it again by
itself. "Stop syncing here" forgets the key in that browser; signing out from the account page
forgets every key for that account. "Start over" deletes everything synced and the key.
While Account › Sync is open (and the tab visible), the page asks `GET esync` every 4 s, so a
browser or app asking to join shows up within seconds, and a key change is picked up; it stops
when the page closes or the tab is hidden (the 60 s sync carries on as before).

**Removing a device changes the key** (`rotate`; `sync.js` removeDevice, `eden-crypto.js`
planRotation and followRekey). The key has an **epoch** (1 when sync is turned on; the same
`gen` throughout, which only "Start over" changes). "Remove" in Account › Sync, done by the
browser removing it (which holds the key), makes a new key (epoch + 1) and sends, in one
`rotate`: the epoch it holds (`from_epoch`), proofs of the old key and the new, `prev` (the old
key under the new: the chain askeden.com keeps), the removed device, and every other trusted
device either in `members` (the new key sealed to its public key, and its new `mac`) or in `drop`.
It seals only to a member whose `mac` checks out under the old key: a device vouches for its own
public key when it proves (`prove { mac }`), an approver vouches for the one whose six digits
matched (`approve { mac }`), and members trusted before this get one the next time they open
Eden; a member without one is dropped and must be approved again. So askeden.com can't add a key
of its own to the members (it has no key to vouch with) or hand a member a key it made: a member
picks the new key up (`me.rekey`, sealed to it, waiting on askeden.com while it's offline, through
any number of changes) only if the chain from it leads back to the key it has (`followRekey`), and
proves it. The server compares and sets the epoch in one step: a second removal planned from the
same epoch gets 409 `rotated` (or `stale_key`) and is redone from the new status; a list that
doesn't match who's trusted gets 409 `members_changed`. After the change: the removed device's
trust record goes, and its old proof no longer matches (403 `wrong_key`, so it can't prove the
old key back in the way a browser that signs in again does); a member that hasn't picked the new
key up may read but not write, approve or set a passphrase (409 `stale_key`), so nothing new is
sealed with a key the removed device has; approvals not collected yet (sealed with the old key)
are cancelled (the device asks again). Old keys stay in each browser (non-extractable, in
IndexedDB) to read what they sealed: each item records the epoch it was written under (`epoch`
in `pull`), and a browser seals items from older epochs again under the new key, 20 a sync pass
(the rest as they're written); a browser that joins later gets the older keys from the chain.
The **recovery passphrase** can't follow (only the passphrase opens its wrap, and nobody types it
at "Remove"): the wrap goes, `key.wrap_stale` says so, unwrap answers 404 `no_wrap` with why, and
the account page asks for the passphrase again (the same one is fine), which wraps the new key.
What removing doesn't do, by design: the removed device keeps whatever it already downloaded and
the old key, so it can still read items it fetched, and older items askeden.com still holds under
the old key (it can no longer fetch them, but askeden.com could hand them over); it can't read
anything written after the change. It doesn't protect against askeden.com and the removed device
working together at the moment of the change (the removed device knows the old key, so it could
vouch for a key askeden.com adds then); and signing a browser out under Devices doesn't change the
key (remove it under Sync first). `untrust { device_id }` from another device still works (older
pages) but doesn't change the key.

**The J.A.R.V.I.S. apps** (iPhone: `companion/iOS/Account/EdenSync.swift`, Settings › Account ›
Trust a Browser for Eden Sync; Mac: `src/jarvis/eden_trust.py`, Settings' Jarvis account,
"Trust a browser for Eden sync"). An app is a member like a browser, over its bearer token at
`/api/esync[/<op>]` (no server change): its own X25519 key pair, Eden's key reaching it the same
two ways, then approving browsers. It never reads or writes Eden's conversations; it holds the
key only to hand it on.
1. **Getting the key, once.** "Ask a browser that syncs" posts `request` with the app's public
   key and shows its six digits; a browser that syncs lists the request (its name and kind, e.g.
   `iphone`) and approves it when the digits match; the app polls (every 3 s, 15 minutes), opens
   the sealed key and `prove`s it (`via: "approved"`). Or the recovery passphrase: `unwrap`,
   PBKDF2 on the device (CommonCrypto; `hashlib`), then `prove` (`via: "passphrase"`). The
   passphrase never leaves the device and isn't kept.
2. **Approving a browser.** Trusted, the app sees `requests` in `GET /esync` (asked every 5–6 s
   while its screen is open), each with the six digits computed on the app from the request's
   public key. Approve asks for the status again, refuses when the request is gone or its key
   is no longer the one the digits were made from, seals Eden's key to it (X25519, or P-256 for a
   browser without X25519; a fresh sender key each time) and posts `approve` echoing that key.
   Deny posts `deny { device_id }`.
3. **Kept.** iPhone: Keychain (this device only, not iCloud), `eden-device.v1` (the X25519
   private key, raw) and `eden-key.v1` (`{"account","gen","key","epoch"}`). Mac: `connectors.Vault`
   entry `jarvis-account`, keys `eden_device` and `eden_key` (the same JSON). The key is used
   only for the account it came from and its generation: after "Start over" (a new `gen`) or on
   another account it is dropped; after signing in again (a new device id) the app proves it
   again by itself (a 403 there: dropped). Signing the iPhone out, unlinking the Mac or "Stop
   holding the key here" (`untrust`) removes them.
4. **A device removed.** The app sends its `mac` when it proves, and one for the browser it
   approves. When `key.epoch` is past its own, it opens `me.rekey`, checks the chain leads back
   to its key (else it keeps the old one and says it couldn't check the new one), proves the new
   key and keeps it with its epoch; with no `rekey` (it was the one removed, or nobody vouched for
   it) it drops the old key and asks a browser again. An app from before this (no `mac`, no
   `epoch`) fails safely: it is dropped at the next key change (or, approved by a newer browser,
   kept with a `rekey` it can't use), its old key proves nothing (403, "Eden's sync key changed
   when a device was removed…") and approving with it is refused (409 `stale_key`); it never
   hands a browser a key that works.

The crypto is checked against one test vector made with eden-crypto.js itself
(`site/scripts/eden-sync-vector.mjs` writes `companion/Tests/Fixtures/eden-sync-vector.json`):
the browser's seals open in CryptoKit and `cryptography`, the apps' seals with fixed sender
keys and nonce match it byte for byte (both curves), and the codes, proof, an NFKC passphrase
unwrap and a key change's macs and chain link agree (`companion/Tests/EdenSyncTests.swift`, `tests/test_eden_trust.py`,
`site/test/eden-sync-vector.test.js`). Regenerate it only when the format changes on purpose.

Merging: each conversation is one item (`eden/conv.<id>`) holding Eden's own stored form
(the message tree; image data never, text attachments dropped past ~450 KB, larger ones not
synced). Two copies merge as a union of messages by id (both devices' turns stay as branches),
the newer side's title and pins. A write carries the revision it was based on; a 409 hands back
the other copy, which is merged and written again. A delete is a tombstone. On a browser's first
sync, what it already has is merged with what's there. Other `eden/` items may sit beside
conversations (saved workflows use `eden/workflows`); the sync engine leaves them alone.

Endpoints (signed-in browser, `X-Jarvis-Chat: 1`, same-origin JSON; the apps: the same at
`/api/esync[/<op>]` with their token):

| | |
| --- | --- |
| `GET /api/web/esync` | `{ key: { gen, created, wrap, iterations, epoch, wrap_stale, rotated } \| null, me: { device_id, trusted, request, epoch, mac (bool), rekey: { epoch, sealed_key, sender_key, alg } \| null }, trusted: [{ …, epoch, mac, pending }], requests: [...] and chain: [{ epoch, prev }] (to trusted devices only), rev, items, bytes, caps }` |
| `POST …/init` | `{ gen, proof, keycheck, wrap, public_key, alg, mac? }`: the first device (409 `key_exists`) |
| `POST …/unwrap` | `{ gen, wrap, epoch }` (404 `no_wrap`) |
| `POST …/prove` | `{ proof, public_key, alg, via, mac? }` → `{ trusted, epoch }` (403 `wrong_key`); proving again with the same public key keeps `via` and `added` |
| `POST …/request`, `…/poll` | "Trust this browser": `{ public_key, alg }`; poll → `waiting` \| `approved` (+ `sealed_key`, `sender_key`, `alg`) \| `denied`; 410 after 15 minutes |
| `POST …/approve`, `…/deny` | `{ device_id, public_key, sealed_key, sender_key, mac? }` (trusted only, with the key of now; 409 if the key changed) |
| `POST …/untrust` | `{ device_id? }` (this one, or another from a trusted device; no key change) |
| `POST …/rotate` | `{ from_epoch, proof, new_proof, prev, remove, members: [{ device_id, public_key, sealed_key, sender_key, mac }], drop: [device_id] }` → `{ epoch, dropped, wrap }` (409 `rotated`, `members_changed`, `stale_key`; 403 `wrong_key`) |
| `POST …/wrap` | `{ proof, wrap }`: a new passphrase (with the key of now) |
| `POST …/pull` | `{ since }` → `{ rev, more, items: [{ key, rev, data \| null, deleted, updated, epoch }] }` (100 a page) |
| `POST …/push` | `{ items: [{ key, data, base_rev } \| { key, deleted: true, base_rev }] }` (25 at once; with the key of now, else 409 `stale_key`) → `{ results: [{ key, rev } \| { key, conflict: item } \| { key, error, code }] }` |
| `POST …/wipe` | start over |

Only a trusted device reads, writes or approves (403 `not_trusted`). Keys `eden/` +
`[A-Za-z0-9._:-]{1,120}`; `eden/keycheck` is written once. Caps: 1 000 items, 512 KiB an item
sealed, about 30 MB in all; 5 trust requests at once; `API_RATE` per account, and `LINK_RATE`
(`esync:<account>`) for init, unwrap, request, approve, rotate and wipe; 500 key changes (then
"Start over"). A delegate's session can't use any of it.

### Delegates (H14)

`site/src/accounts/delegates.js`. The owner invites someone (an assistant, family) who signs
in with their own Eden account and uses part of the owner's: a **grant**.

- Invitation: name, "from" (how the owner is shown to them), features (`chat` always; `mail`
  and `calendar` only when ticked: Gmail and Google Calendar on askeden.com), a monthly dollar
  limit ($0–500) out of the owner's allowance, and how long (7, 30, 90 or 365 days). It answers
  a code `XXXX-XXXX-XXXX` (60 bits, single use, 7 days) and a link `/#delegate=<code>` the owner
  passes on (askeden.com sends no email; the page offers a `mailto:`). An object of the ACCOUNTS
  namespace named `dinv:<SHA-256 of the code>` finds the owner from the code alone; the owner's
  object keeps only the code's hash. At most 10 delegates an account.
- The delegate accepts while signed in (never their own account's invitation), then "Use":
  a `web` device on the **owner's** account with `grant: { type: 'delegate', id, account (the
  delegate's), features, label }`, ending with the access (30 days at most), whose token goes into
  a cookie of its own, `__Host-eden-as` (HttpOnly, Secure, SameSite=Strict), beside the delegate's
  own session. Hosted Eden's chat (`/api/chat/*`) uses it only while the delegate's own session is
  valid and is that grant's account; everything else (the account page, sign-in, sync) stays the
  delegate's own. "Switch back" ends it.
- Enforced in the owner's object on every op: a grant's device may only `whoami`, `get` (a view
  of its own limit, nothing of the owner's), `allow-ai`/`hold-ai` (hosted Eden), artifacts, sign
  itself out, and `google-get`/`google-touch` when mail or calendar is granted. Never the
  account, devices, sign-in methods, sync, delegates, spaces, the Mac relay, tasks, published
  pages or the voice (403 `grant_forbidden`). Hosted Eden checks routes first: chat, routing,
  compare, artifacts; Gmail routes with `mail`, Calendar routes with `calendar`.
- Money: the grant's turns spend the owner's allowance, narrowed to its pool (`pool:dlg:<id>`
  `{ cap, month, spent, by }`) less its turns in flight; the hold's bucket names the pool
  (`plus|dlg:<id>|<who>`), so `spend` counts it on the account and the pool. The owner sees each
  delegate's spend this month.
- Revoking deletes the grant's devices at once; acting sessions are checked with the owner's
  account on every request (not cached), and once a grant ended hosted Eden refuses to spend
  (403 `grant_ended`) rather than fall back to the delegate's own allowance; reads go on as the
  delegate, and the page switches back.
- Endpoints (`/api/web/deleg`, the browser's own session): `GET` → `{ delegates, mine, acting,
  features, days, max_cap }`; `POST …/invite`, `…/update { id, cap_usd?, features?, days? }`,
  `…/revoke { id }`, `…/accept { code }`, `…/use { id }` (sets the cookie), `…/leave` (clears it),
  `…/quit { id }` (the delegate gives it up).

### Team spaces (G8)

`site/src/accounts/space.js`, `~/askeden/web/chat/spaces.js`. A shared project across
accounts: members with roles (`owner`, `member`; up to 20), a monthly AI budget ($0–200) out of
the owner's Plus (making one needs Plus; at most 5 owned), and the router level its chats start
from (1–5). Members see each other by the name they chose and an opaque member id, never an
account id.

- The `Space` object keeps members, open invitations (single use, 7 days, through an index object
  `inv:<SHA-256 of the code>` of the same class), the space key's generation and proof hash,
  members' browser keys with the space key sealed to each, and shared conversations as sealed
  blobs (with a sealed title) only: AES-256-GCM with the space key, label `eden-space-v1`, item
  `<space>:<conversation>`; seals use `eden-space-seal-v1`. 200 conversations, 512 KiB each.
  Shared workflows (H9, "Share to a space…" in Eden's Workflows) are the same sealed items with
  `kind: "workflow"` (id `wf-…`; the recipe without its example values), listed apart by `view`.
- The space key: made by the owner's browser the first time it opens the space and sealed to
  itself; a member's browser registers its key and waits, showing six digits; any browser holding
  the key gives it access after checking them. askeden.com never has the key.
- "Chat in this space": a grant on the owner's account (`type: 'space'`, chat only), capped by
  the space's budget (`pool:spc:<id>`) and counted per member; paused while the owner has no Plus.
  Removing a member or deleting the space ends its sessions at once.
- Endpoints (`/api/web/space`, own session): `GET` → `{ spaces, can_create, … }`; `POST
  …/create { name, budget_usd, level, label }` (402 `needs_plus`), `…/view { id }`, `…/update`,
  `…/invite { id }`, `…/join { code, label }`, `…/leave`, `…/remove { id, member }`, `…/delete`,
  `…/use { id }`, `…/key-register|key-init|key-seal|key-mine`, `…/conv-get|conv-put|conv-delete`
  (`conv-put` takes `kind: "conv" | "workflow"`, default `conv`; `view` and `conv-get` return it).

## What the owner sets up once

Worker secrets (`cd site && npx wrangler secret put NAME`):
- `ANTHROPIC_API_KEY`: the key Jarvis Plus spends.
- optional `GOOGLE_CLIENT_SECRET` (with the var `GOOGLE_CLIENT_ID`): Sign in with Google on
  the web. The var `WEB_APPLE_SERVICES_ID` turns on Sign in with Apple on the web. Steps:
  docs/web-auth.md "Owner steps".
- `APNS_KEY` (the `.p8` contents), `APNS_KEY_ID`: a key made in team `8CV4X23Y2T` (the var
  `APPLE_TEAM_ID`). A key from another team can't push to `com.askeden.jarvis`.
- optional `SIWA_KEY` / `SIWA_KEY_ID`: a Sign in with Apple key of team `8CV4X23Y2T`
  (primary App ID `com.askeden.jarvis`), so deleting an account also revokes Apple's grant.
- optional `STRIPE_SECRET_KEY` (`sk_test_…` first) and `STRIPE_WEBHOOK_SECRET` (`whsec_…`), with
  the var `STRIPE_PRICE_PLUS` (the $20/month "Eden Plus" price): Plus on the web. All three or
  billing stays off; a live key also needs `STRIPE_LIVE = "1"`. Steps (product, webhook endpoint
  and its five events, Customer Portal, `wrangler secret put … -c wrangler.preview.toml`):
  docs/web-auth.md "Owner steps" › Stripe. Stripe Tax is a later decision.

App Store Connect (team `8CV4X23Y2T`): the app record for `com.askeden.jarvis`, the subscription
group "Jarvis Plus" with the two products, the Paid Applications agreement, and the server
notification URL `https://askeden.com/api/appstore/notifications` (Production and Sandbox).

Apple Developer (team `8CV4X23Y2T`, done 2026-10-06): the App ID `com.askeden.jarvis` with
Sign in with Apple as the primary App ID, push, App Groups, HealthKit, HomeKit, Time Sensitive
Notifications and In-App Purchase; its extensions' App IDs; `com.askeden.eden` grouped with it.

Apple's user ids are per team: an Apple ID that signed in through the old app (team
`9ZSY5R8A5C`) arrives from the new one with another `sub` and opens a new account. To keep an
old account, sign in to it on askeden.com with a code (approved by its Mac or the old app) and
link Sign in with Apple there before the new app signs in: the web's Apple id is the new team's,
the same as the app's.
