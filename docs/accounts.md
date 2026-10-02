# Jarvis accounts

An optional account, at askeden.com, for what one person's own devices can't do alone:

1. **Jarvis Plus**: AI included, for people without an Anthropic key or a Claude sign-in.
   A subscription bought in the iPhone app (StoreKit 2, auto-renewable), and a one-time
   trial allowance for every new account.
2. **Push relay**: the Mac's notifications reach the phone through askeden.com's Apple push
   key, so no one needs a `.p8` of their own.
3. **Encrypted relay**: the phone reaches its Mac from anywhere (no shared Wi-Fi, no
   Tailscale). The relay carries the companion's own TLS bytes, pinned to the Mac's
   certificate, so askeden.com sees only ciphertext.
4. **Sync**: memory, settings and phone chats, sealed on the device with a key the server
   never has.

Everything works without an account, exactly as before. The account holds only what those
four need: devices, the plan, usage counts, relay sockets for a moment, and sealed sync
items. No names, no email (Sign in with Apple's email is never stored), no conversation
text outside sealed sync items, which only the account's devices can open.

Sign-in is Sign in with Apple, on the iPhone. A Mac joins the account by **linking**: it
shows a code (and a QR code); the signed-in iPhone approves it, and hands the Mac the sync
key sealed to the Mac's own key on the way. A paired iPhone can do all of it in one tap.

The server is the askeden.com Worker (`site/src/worker.js` routes `/api/…` to
`site/src/accounts/`). Each account is one Durable Object (`Account`), named by the account
id; each pending link is one (`Link`), named by its code. No database beyond those.

---

## Credentials

A device credential is a bearer token:

    jv1.<account id>.<device id>.<secret>

- account id: a UUID, lowercase (`8-4-4-4-12`), derived from the Apple user id:
  the first 16 bytes of SHA-256(`"jarvis-account-v1:" + sub`), formatted as a UUID with the
  version nibble 8 and the RFC 4122 variant. It is also the StoreKit `appAccountToken`.
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
by `https://appleid.apple.com`, for audience `com.bshventures.jarvis.companion`, unexpired,
with `nonce` equal to SHA-256 hex of the raw nonce. `kind` is `iphone`, `ipad`, `watch` or
`mac`. The authorization code, when the server has a Sign in with Apple key, is traded for
Apple's grant so that deleting the account can revoke it (Apple asks for that).

`GET /account` (auth) → 200 `<Account>`:

    { "id": "…uuid…",
      "created": 1790000000000,                       // ms since 1970
      "plan": { "name": "free" | "plus", "active": bool, "product_id": "…" | null,
                "expires": ms | null, "renews": bool | null, "environment": "Production"|"Sandbox"|null },
      "usage": { "period_start": ms, "period_end": ms | null,
                 "spent_usd": 0.42, "budget_usd": 20, "left_usd": 19.58,
                 "trial_left_usd": 1.0,
                 "voice_today": 1200, "voice_daily": 100000 },
      "devices": [ { "id", "name", "kind", "created", "last_seen", "app_version",
                     "push": bool, "relay": bool, "this": bool } ],
      "sync": { "rev": 12, "items": 5 } }

`DELETE /account` (auth) → 204. Everything goes: devices (every token stops working), the
plan record, usage, sync items. The subscription itself is Apple's: the app tells the
person to cancel it in Settings › Subscriptions too (Apple requires both words).

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
`com.bshventures.jarvis.plus.monthly`, `com.bshventures.jarvis.plus.yearly`.

The app buys with `appAccountToken = UUID(account id)`, then `POST /subscription`
`{ "signed_transaction": "<Transaction.jwsRepresentation>" }` → 200 `<Account>`. It also
sends the newest `Transaction.currentEntitlements` at launch and on
`Transaction.updates`. The server checks the JWS's certificate chain up to Apple Root CA –
G3, the bundle id, the product, and that `appAccountToken` is this account.

`POST /appstore/notifications` — App Store Server Notifications V2 (`{signedPayload}`),
same checks; renewals, expiries, refunds and revocations update the plan.

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

## What the owner sets up once

Worker secrets (`cd site && npx wrangler secret put NAME`):
- `ANTHROPIC_API_KEY`: the key Jarvis Plus spends.
- `APNS_KEY` (the `.p8` contents), `APNS_KEY_ID`; team `9ZSY5R8A5C` is a var.
- optional `SIWA_KEY` / `SIWA_KEY_ID`: a Sign in with Apple key, so deleting an account
  also revokes Apple's grant.

App Store Connect: the subscription group "Jarvis Plus" with the two products, the Paid
Applications agreement, and the server notification URL
`https://askeden.com/api/appstore/notifications` (Production and Sandbox).

Apple Developer: the App ID `com.bshventures.jarvis.companion` with Sign in with Apple
(automatic signing turns it on at the next archive).
