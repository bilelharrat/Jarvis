# Signing in to Eden at askeden.com (web auth contract)

The contract between askeden.com's Worker (`site/src/eden/session.js`, `site/src/eden/google.js`,
`site/src/accounts/`), the sign-in page (`site/public/signin/`, served at `/signin`), Eden's account
page (`~/askeden/web/chat/account.js`) and the apps (Eden iOS, J.A.R.V.I.S. iPhone and Mac).
Status: built and tested (2026-10-06; passkeys, Turnstile, /privacy and /terms 2026-10-07), not deployed. Real Apple and Google sign-ins need the owner
steps below before they can be tried end to end.

## One account, many ways in

Every sign-in method lands in the same **Account** Durable Object (`site/src/accounts/account.js`),
so one account works on the web, in Eden for iOS and in the J.A.R.V.I.S. apps.

- **Identity** Durable Object (`site/src/accounts/identity.js`, binding `IDENTITIES`, migration
  `v3`), one per sign-in identity, named `<provider>:<sub hash>`, where the sub hash is the SHA-256
  hex of `"<provider>:<sub>"` (`accounts/index.js` `subHashOf`). No raw Apple or Google user id is
  stored anywhere. It holds `{ account_id, provider, email, added }`, or after an unlink a tombstone
  `{ account_id: null, released }`. Every check-and-set happens inside it, so two sign-ins at once
  make one account, and two accounts can't both link one identity.
- Apple: the account is `Identity(apple).account_id` when it is linked. With no record at all, it is
  (as before, and for every account the iPhone app already made) `accountIdFor(sub)`. With a tombstone
  (unlinked), it is a new account with a random id. The in-app `POST /api/account/apple` resolves the
  same way, so an Apple ID linked to a Google-first account opens that account in the app.
- Google: `Identity(google).account_id`. A Google account seen for the first time, or unlinked
  since, gets a new account (random UUID v4) on the trial allowance.
- A brand-new Apple ID on the web gets a new account on the trial allowance (its id is
  `accountIdFor(sub)`, so the iPhone app opens the same account later).
- Accounts are never matched by email. A Google address that equals an Apple relay address, or
  anything else, links nothing by itself.
- The Account keeps its identities (`identities`: `{ provider, sub_hash, email, added }`, at most
  one per provider) and shows `{ provider, email, added }`. Accounts the iPhone app made before
  this existed list Apple (`sub_hash` unknown until that Apple ID signs in again). Apple's email is
  never asked for or kept (`email: null`). Google's verified address is kept, lowercased, only to
  show which Google account is linked.
- Linking a second method: the signed-in browser opens the provider flow with `?link=1`. The start
  needs a live session and stores `{ account, device }` server-side under the attempt's state
  (`oauth:<state>` in the `LINKS` namespace, 10 minutes, taken once). The callback then attaches the
  identity to that account, if that browser is still signed in. Refused when the identity already
  opens another account (`identity_taken`), including an Apple ID whose own account the iPhone app
  made, and when the account already has that provider (`taken`).
- Unlinking: allowed while at least one other method remains (`409 last_method` otherwise). An
  unlinked identity becomes a tombstone, so it opens a new account next time. Apple on a legacy
  account needs one more Apple sign-in first (`409 needs_proof`), because its sub hash isn't known.
- Passkeys (2026-10-07, `site/src/accounts/webauthn.js`): an identity like the others,
  `passkey:<SHA-256 of "passkey:<credential id>">`, whose Identity record also keeps the public key
  and signature counter (`cred: { alg, jwk, count }`). One per account. `POST /api/web/passkey/options
  { mode: signin | signup | add, turnstile? }` → `{ publicKey }` (RP ID = the request's host:
  askeden.com, www, preview.askeden.com each their own; UV required; attestation `none`; ES256 and
  RS256; discoverable). The challenge (32 random bytes) is stashed server-side as `pk:<challenge>`
  in `LINKS` for 5 minutes, taken once, with its mode, host and (for `add`) the browser.
  `POST /api/web/passkey/verify { credential, return? }` reads the challenge from clientDataJSON,
  takes the stash, then checks type, challenge, origin (no cross-origin frame), rpIdHash, UP and UV
  flags, `fmt: none` with an empty statement, credential id, the COSE key (EC2 P-256 or RSA ≥ 2048),
  the signature (authenticatorData ‖ SHA-256(clientDataJSON)) and that signCount went up whenever
  either side counts (`passkey-count`, checked and set in the Identity object). Sign-in and sign-up set
  `__Host-eden` and answer `{ signed_in, to }`; `add` (signed-in browser only, the same browser that
  asked) answers `{ identities }`. Both endpoints need this site's own Origin. No library: the CBOR
  and COSE reading is ~100 lines, tested in `test/passkey.test.js`.
- Turnstile on sign-up (`site/src/accounts/turnstile.js`): with `TURNSTILE_SITE_KEY` ([vars]) and
  the secret `TURNSTILE_SECRET` set, `/api/web/config` gives the page the site key, `/signin` shows
  the widget, and every new web account needs a passed check, verified once with siteverify and the
  visitor's IP: a passkey sign-up sends the token with its options; Apple and Google from `/signin`
  are form posts (`POST /api/web/apple|google`, `cf-turnstile-response`) whose start checks it and
  stashes `human:<state>` for the callback, which needs it only when it would make a new account
  (plain GET starts still sign existing accounts in; a new one ends at `/signin?error=verify`).
  Unset: no check, logged once per isolate. The Eden iOS app's native Apple sign-in isn't checked.
  `/signin`'s CSP adds `https://challenges.cloudflare.com` to script-src and frame-src (that page
  only) and form-action `'self'` plus Apple's and Google's sign-in hosts.
- Deleting the account (`DELETE /api/account`, apps only) forgets its identities. An Apple ID goes
  back to its derived account id (a fresh account), and a Google account gets a new one.

## Endpoints (all `/api/web/*`; JSON errors `{ error, code }`)

| Method & path | Who | What |
| --- | --- | --- |
| `GET /api/web/config` | anyone | `{ apple: bool, google: bool, code: true, billing: bool, billing_in_app: bool }` (which buttons to show) |
| `GET /api/web/apple[?link=1]` | anyone / signed in for link | 302 to Apple (form_post) |
| `POST /api/web/apple/callback` | Apple | see "Where a sign-in ends" |
| `GET /api/web/google[?link=1]` | anyone / signed in for link | 302 to Google (code + PKCE, `openid email profile` only) |
| `GET /api/web/google/callback` | Google | see "Where a sign-in ends" |
| `POST /api/web/link`, `POST /api/web/link/poll` | anyone | the iPhone/Mac-approved code and QR (unchanged) |
| `POST /api/web/native/apple` | Eden iOS app (no Origin) | `{ identity_token, nonce, authorization_code? }` → `{ handoff, expires_in: 60 }` |
| `GET /api/web/handoff?code=…` | the app's WKWebView | one-time, 60 s: sets `__Host-eden`, 302 to `/` |
| `GET /api/web/session` | signed in | as before, plus `identities` |
| `GET /api/web/account` | signed in | `{ account_id, plan, usage, devices, identities, plus }`; `plus` is `{ web_purchase: true, how: "stripe", price_usd: 20 }` with billing on, else `{ web_purchase: false, how: "ios" }` |
| `POST /api/web/billing/checkout` | signed in, own account | `{ url }` of a Stripe Checkout Session ("Billing on the web") |
| `POST /api/web/billing/portal` | signed in, own account | `{ url }` of a Stripe Customer Portal session |
| `GET /api/web/billing/return?to=success\|cancelled\|portal` | Stripe's redirect | an onward page to `/#account[?billing=…]` |
| `POST /api/stripe/webhook` | Stripe (no Origin) | its signed events; nothing else lives under `/api/stripe` |
| `POST /api/web/devices/<id>/signout` | signed in | 204: sign out one browser (kind `web`) of this account |
| `POST /api/web/signout-everywhere` | signed in | 204: sign out every browser of this account, this one included |
| `POST /api/web/identities/<apple\|google>/unlink` | signed in | 200 `{ identities }`; 409 `last_method` / `needs_proof`, 404 `not_linked` |
| `POST /api/web/signout` | signed in | 204: sign out this browser (and end any delegate's session it held) |
| `GET /api/web/apps` | signed in | `{ connections: [{ id, client, name, scope, created, expires, last_used }] }`: connected apps (Eden Messenger's scoped tokens, `accounts/scoped.js`) |
| `POST /api/web/apps/<id>/revoke` | signed in | `{ revoked: true }`, the app's token stops at once; 404 `not_found` if it's gone |
| `GET/POST /api/web/esync[/<op>]` | signed in | Eden sync, end to end encrypted (docs/accounts.md "Eden sync") |
| `GET/POST /api/web/deleg[/<op>]` | signed in | delegates: invite, accept, use, switch back, revoke (docs/accounts.md "Delegates") |
| `GET/POST /api/web/space[/<op>]` | signed in | team spaces (docs/accounts.md "Team spaces") |

- `usage` is the account's (docs/accounts.md), plus `trial_usd` (the trial's size) and `plus_usd`
  (a month of Plus), for the meters.
- `devices` entries are `{ id, name, kind, created, last_seen, expires?, this }`. A browser may sign
  out browsers. The apps (iPhone, iPad, Watch, Mac) are listed but are removed only from the
  J.A.R.V.I.S. app (403 `forbidden`).
- A sign-out that also signs out this browser clears its cookie in the same answer.
- `native/apple`: the identity token's audience must be the Eden app, `com.askeden.eden` (no
  other endpoint accepts it), and its nonce must be the SHA-256 hex of `nonce`. `authorization_code`
  is accepted and ignored for now. Errors are JSON: 401 `apple_refused`, 403 `not_allowed`, 429.
  The account is the Apple ID's, resolved as above (created on first use).

### Where a sign-in ends

The provider callbacks and the handoff are navigations, so they end on a page, never in JSON:

- **Signed in**: a tiny page of this site that moves on at once to `/` (a meta refresh). A
  redirect straight from Apple's or Google's site would load `/` without the `SameSite=Strict`
  session cookie, so `/` would look signed out.
- **Sign-in failed**: 303 to `/signin?error=<code>&provider=<apple|google>`.
- **Link mode** (success or failure): the same onward page, to `/#account` or
  `/#account?error=<code>&provider=<apple|google>`.
- **Handoff**: 302 to `/` (the web view started the load itself, so the cookie comes along), or
  303 to `/signin?error=<code>`.

**Coming back** (`?return=<path>`): `/signin?return=…` (Eden Messenger's "Connect Eden" page, a
deep link like `/#tasks` opened signed out) sends every way in back there once signed in: the page
passes it to `/api/web/apple|google?return=…`, which keep it in the attempt's own state cookie
(base64url, never read from the callback's query) and end on it instead of `/`; a failure goes to
`/signin?error=…&return=…`; the code flow goes there itself; `/signin` when already signed in
redirects there. Only a path of this site is accepted (`public/signin/return.js`, the one rule for
the page and the server): one leading `/` (not `//` or `/\`), no scheme, no backslash, space or
control character, at most 1,024 characters, never `/api/…` (so a sign-in can't end on the Eden
app's handoff with someone else's code); anything else is `/`. Link mode ignores it.

Destinations are only these fixed paths or that checked return path, never anything from the
provider's callback. Error codes:

| Code | When |
| --- | --- |
| `cancelled` | Apple's `error` (the person cancelled), or another Google error |
| `access_denied` | Google's `error=access_denied` |
| `state` | no or wrong state cookie; the identity token failed a check (signature, issuer, audience, expiry, nonce); Google refused the code; a handoff opened by another site |
| `expired` | link mode's pending attempt is gone or used; a handoff code unknown, used or older than 60 s |
| `taken` | the account already has that provider (link mode) |
| `identity_taken` | that identity already opens another Eden account (link mode) |
| `not_allowed` | `EDEN_ACCOUNTS` doesn't list the account |
| `not_set_up` | Apple or Google isn't configured |
| `rate_limited` | `AUTH_RATE` said no |
| `email` | Google's `email_verified` isn't true |
| `signed_out` | link mode started without a session, or the browser was signed out before the callback |
| `server` | anything else (logged) |

## Cookies and checks

- Session: `__Host-eden`, HttpOnly, Secure, Path=/, SameSite=Strict, 30 days.
- Acting for someone (a delegate's or a team space member's session on another account):
  `__Host-eden-as`, the same flags, as long as the grant lasts (30 days at most). Only hosted
  Eden's `/api/chat/*` and `/artifact/<id>` use it, and only while `__Host-eden` is valid and is
  the grant's own account; `/api/web/session` and `/api/web/account` report it as `acting` (or
  `acting_ended: true` once it ended). Everything else stays the browser's own account.
- Provider state: `__Host-eden-apple` = `state.nonce.<s|l>[.<return>]` (SameSite=None: Apple posts back
  cross-site) and `__Host-eden-google` = `state.nonce.verifier.<s|l>[.<return>]` (SameSite=Lax: Google
  redirects back with a top-level GET). Each holds only that attempt's state, nonce, PKCE verifier
  (Google), mode (`l` = link) and checked return path (base64url; no field for `/`), expires in 10
  minutes, and is cleared on return whatever happened.
  Apple gets SHA-256 hex of the nonce. Google gets the nonce, and the code challenge is S256 of the
  verifier.
- Every `/api` POST from a browser must carry this site's Origin (worker.js `fromElsewhere`).
  The Apple callback is the one exception (Origin `https://appleid.apple.com` or `null`). The
  Google callback and the handoff are GETs. The Eden app sends no Origin, which is allowed.
  Stripe's webhook (`/api/stripe/webhook`) is routed before this rule: Stripe sends no Origin, and
  its signature, not the Origin, is what guards it.
- Sign-out and device removal take effect at once in the account. `currentSession` caches for
  30 s per isolate, so every sign-out also clears this isolate's cache for that account, and
  other isolates re-check within 30 s. Anything that spends (a chat turn's hold) or changes
  something checks the device in the account itself, so the window only affects cached reads.

## Abuse limits (Workers rate-limit bindings, per 60 s)

- `AUTH_RATE` (namespace 1004, 20 per key): `start:<ip>` sign-in starts, `cb:<ip>` callbacks,
  `new:<ip>` new accounts (counted only when a sign-in would make one, in the app's
  `POST /api/account/apple` too), `native:<ip>` app sign-ins, `handoff:<ip>` redemptions.
- `LINK_RATE` (existing, 30 per key): `web:<ip>` web code starts, `start:<ip>` Mac code starts,
  `poll:<code>` polls per code, `look:<account>` code lookups and approvals per approving account.
  The code space is 32^8, so guessing is hopeless at 30 tries a minute per account.
- `EDEN_RATE` (namespace 1005, 20 per key): `turn:<account>` chat turns (`POST /api/chat/send`), on
  top of `API_RATE` and the included-AI allowance, which caps cost.


## Hosted Eden's AI providers

askeden.com's chat routes across every provider it has a key for (docs/accounts.md "Hosted Eden's
providers"). The keys are optional Worker secrets; each one turns its provider's models on in the
model menu, the routing preview, send and compare:

    npx wrangler secret put ANTHROPIC_API_KEY     # the apps' included AI only: never hosted chat (below)
    npx wrangler secret put OPENAI_API_KEY        # GPT
    npx wrangler secret put GEMINI_API_KEY        # Gemini, the Gemini rating, Gemini search
    npx wrangler secret put MOONSHOT_API_KEY      # Kimi

(preview: `scripts/preview-secrets.sh OPENAI_API_KEY GEMINI_API_KEY MOONSHOT_API_KEY`). Every call
counts on the included AI at the registry's list price; with no usable key, the owner's chats go
through their Mac.

Claude is bring-your-own-key only (2026-10-07, `providers.js` `BYOK_ONLY`): hosted chat never uses
a service Anthropic key, for anyone. Claude's models are candidates only with the person's own
Anthropic key (Settings › Models & API keys), or for the owner while their Mac is online (the turn
goes through the Mac). Elsewhere meta lists them `available: false, needsKey: true` with "Add your
Anthropic API key in Settings to use Claude" and `link: "/#settings=keys"`; a Claude pick answers
422 `needs_key`; the router only ever sees the models the person can use. `meta.defaultModel` is
`gemini-3.8-flash` (else the cheapest non-Claude model).

## Billing on the web (Stripe)

Plus ($20 a month of included AI) can be bought on the web with Stripe, **beside** the App Store
purchase in the J.A.R.V.I.S. iPhone app, never instead of it. Built for **test mode** first
(2026-10-06; `site/src/eden/billing.js`, `site/src/accounts/stripe-plan.js`, tests
`site/test/billing.test.js`). Stripe's REST API is called with `fetch`, form-encoded; no SDK.

- **Off until set up.** Billing is on only when `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and
  `STRIPE_PRICE_PLUS` are all set (`/api/web/config` says `billing: false` otherwise and the page
  shows only "Get Plus in the J.A.R.V.I.S. iPhone app"). A live key (`sk_live_…`, `rk_live_…`) is
  refused unless the var `STRIPE_LIVE = "1"`; a `livemode` event is ignored without it too.
- **Get Plus** (`POST /api/web/billing/checkout`): the browser's own session only (409 `acting`
  while it acts for a delegate or a space; a grant's device is refused by the account itself), 409
  `already_plus` when the account has Plus from either channel. Creates a Checkout Session:
  `mode=subscription`, `line_items[0][price]` = the first id in `STRIPE_PRICE_PLUS`,
  `client_reference_id` and `metadata[account_id]` = the account, the same in
  `subscription_data[metadata]` (so every subscription event names the account), `expires_at` an
  hour away, `customer` when the account already has one, and an `Idempotency-Key` the account keeps
  for the first 29 minutes, so a second click gets the same session. Rate limit `EDEN_RATE`
  `billing:<account>`.
- **Coming back.** `success_url` and `cancel_url` are `/api/web/billing/return?to=success|cancelled`:
  Stripe's page is another site, so the `SameSite=Strict` session cookie isn't sent on that
  navigation and `/` would look signed out. That page needs no cookie and moves on with a meta
  refresh (started by this site, so the cookie comes along) to `/#account?billing=success` or
  `?billing=cancelled`, fixed places only. The account page shows a banner for each and, after a
  success, looks again for a few seconds until the webhook has made it Plus.
- **Manage billing** (`POST /api/web/billing/portal`): a Customer Portal session for the account's
  Stripe customer (404 `no_billing` before a purchase), `return_url` the same return page (`to=portal`).
- **Webhook** (`POST /api/stripe/webhook`): `Stripe-Signature` checked first (HMAC-SHA256 of
  `"<t>.<raw body>"` with `STRIPE_WEBHOOK_SECRET`, every `v1` compared in constant time, so a rolled
  secret's two signatures work, `t` within 5 minutes). Handled: `checkout.session.completed` (the
  subscription is read from Stripe), `customer.subscription.created|updated|deleted`,
  `invoice.payment_failed`. Only subscriptions with a `STRIPE_PRICE_PLUS` price are taken on.
  Idempotent: each account keeps the ids of the events it applied (100 at most, 30 days); a late
  event older than what's stored doesn't undo it, and a canceled subscription never comes back.
  Answers 200 for anything it ignores (an unknown account, another product), 400 for a bad
  signature, 5xx only when Stripe should try again.
- **The plan.** The account keeps the App Store's plan and Stripe's apart and has Plus while either
  is active, until the later one ends; the included AI is the same. `plan.source` is `app_store`,
  `stripe` or `both`; `plan.manage` says `{ app_store: <Apple's subscriptions page> | null, stripe:
  "portal" | null }`; `plan.payment_failed` while a payment is failing (a `past_due` subscription
  keeps Plus 3 days while Stripe retries; an active one renewing keeps it a day past its period in
  case the webhook is late). docs/accounts.md "Billing on the web" has the details.
- **Deleting the account** (`DELETE /api/account`, from the apps) cancels its Stripe subscription
  at once (best effort; the deletion goes ahead if Stripe can't be reached). The App Store's stays
  the person's to cancel, as Apple requires.
- **Inside the Eden iOS app** the page offers only "Get Plus in the J.A.R.V.I.S. iPhone app"
  (Apple's in-app purchase rules) and no Manage billing link, unless the var `STRIPE_IN_EDEN_APP =
  "1"` (`billing_in_app: true`), kept for the US link-out later.
- **Dev and tests only:** `STRIPE_API_BASE` points it at a fake Stripe; refused (billing off)
  unless it's a loopback address and the key is a test key.
- **Residual.** Two Checkouts paid in two tabs within the same hour, or a purchase in the App Store
  and one on the web at the same moment, make two subscriptions: the page then says Plus is paid
  twice (`source: both`) and offers both Manage buttons; nothing is refunded automatically. Stripe
  Tax isn't on (a later decision).

## Owner steps

Nothing here needs a private key: Sign in with Apple on the web returns the identity token in the
form post, and Google's client secret is the only secret.

### Turnstile (dash.cloudflare.com › Turnstile)

Add a widget (Managed) for askeden.com, www.askeden.com and preview.askeden.com; put its site key in
`wrangler.toml` `TURNSTILE_SITE_KEY` and `npx wrangler secret put TURNSTILE_SECRET` (preview:
`scripts/preview-secrets.sh TURNSTILE_SECRET`, and the site key in the preview config). Until both are
set, sign-ups aren't checked.

### Privacy and Terms

`/privacy` and `/terms` (`site/public/privacy/`, `site/public/terms/`, effective 2026-10-07, operator
Harrat Global Holdings, Inc., support@askeden.com). The owner should confirm the governing law and venue
(placeholder: Delaware, USA) and have them reviewed before launch. Account deletion is in the apps only
(web devices can't delete); the policy says so and offers email.

### Sign in with Apple on the web (developer.apple.com): done

Registered on 2026-10-06 in team `8CV4X23Y2T` (individual, Bilel Harrat), the team both apps are
signed by. The old `com.bshventures.*` identifiers belong to another team and aren't used.

- App ID `com.askeden.jarvis` (the J.A.R.V.I.S. app): Sign in with Apple, **primary App ID**.
- App ID `com.askeden.eden` (the Eden iOS app, native sign-in): Sign in with Apple **grouped**
  with `com.askeden.jarvis`. Grouping gives one Apple ID the same user id in both apps and on the
  web, so it opens one account.
- Services ID `com.askeden.eden.web`: Sign in with Apple, primary App ID `com.askeden.jarvis`;
  domains `askeden.com`, `www.askeden.com`, `preview.askeden.com`; return URLs
  `https://askeden.com/api/web/apple/callback`, `https://www.askeden.com/api/web/apple/callback`,
  `https://preview.askeden.com/api/web/apple/callback`.
- `site/wrangler.toml`: `APPLE_TEAM_ID = "8CV4X23Y2T"`,
  `WEB_APPLE_SERVICES_ID = "com.askeden.eden.web"` (the preview config copies both).

What remains:

1. Deploy. `/api/web/config` then says `apple: true`. For the preview, `node
   scripts/preview-config.mjs` first, then deploy with `-c wrangler.preview.toml`.
2. Optional, for revoking Apple's grant when an account is deleted: Keys › **+** › Sign in with
   Apple (primary App ID `com.askeden.jarvis`), then `npx wrangler secret put SIWA_KEY` (the `.p8`)
   and `SIWA_KEY_ID`. Web sign-in doesn't need it.
3. If Apple ever asks to verify a domain with an `apple-developer-domain-association.txt` file,
   the Worker doesn't serve one yet. Ask for it to be added at `/.well-known/`.

Apple's user ids are per team, so an Apple ID that signed in through the old J.A.R.V.I.S. app
(team `9ZSY5R8A5C`) opens a new account here (docs/accounts.md "What the owner sets up once").

### Sign in with Google (console.cloud.google.com)

1. Create (or pick) a project, say **Eden**.
2. **Google Auth Platform** (formerly APIs & Services › OAuth consent screen):
   - **Branding**: app name `Eden`, user support email (yours), developer contact email (yours),
     app home page `https://askeden.com`, and privacy policy and terms links. Leave the logo empty
     unless you want brand verification.
   - **Authorized domains**: `askeden.com`.
   - **Audience**: user type **External**. Publishing status: **Publish app** (In production).
     Testing mode allows only listed test users.
   - **Data access** (scopes): `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`
     only. These are non-sensitive, so no Google review is needed. Gmail and Calendar come later
     on the same client (`src/eden/google-data.js`) and do need their own verification.
3. **Clients** (APIs & Services › Credentials) › **Create client** › OAuth client ID ›
   **Web application**, name `askeden.com`:
   - Authorized JavaScript origins: `https://askeden.com`, `https://www.askeden.com`
   - Authorized redirect URIs: `https://askeden.com/api/web/google/callback`,
     `https://www.askeden.com/api/web/google/callback`

   Create, and copy the client id and secret.
4. `cd site && npx wrangler secret put GOOGLE_CLIENT_SECRET` (paste the secret), and in
   `site/wrangler.toml` set `GOOGLE_CLIENT_ID = "<…>.apps.googleusercontent.com"`. Deploy.
   `/api/web/config` then says `google: true`. Google stays off while either one is missing.

### Stripe: Plus on the web, test mode (dashboard.stripe.com)

Done in the test sandbox (2026-10-06, by the coordinator): product "Eden Plus" $20/month, price
`price_1UNkUWRqjDshFbQicaYCqIeb` (already `STRIPE_PRICE_PLUS` in `wrangler.toml`); webhook
destination `eden-preview` → `https://preview.askeden.com/api/stripe/webhook`, snapshot payloads,
API version `2025-03-31.basil` (the subscription's period lives on its items, an invoice's
subscription under `parent.subscription_details`; `billing.js` reads both old and new places), the
five events below; Customer Portal with invoice history, payment methods and "cancel at end of
billing period" (switching plans off). Left for the owner: steps 5 (the two secrets) and 7–8.

1. Create the Stripe account (or sign in) and leave the dashboard in **Test mode** (the toggle at
   the top). Everything below is done in test mode first; live mode repeats it later.
2. **Product catalog** › **Add product**: name `Eden Plus`, **Recurring**, **$20.00 USD**, billing
   period **Monthly**. Save, open the price and copy its id (`price_…`). (Or the coordinator creates
   it in the browser pane while you're signed in.)
3. **Developers** › **Webhooks** › **Add endpoint**: URL `https://preview.askeden.com/api/stripe/webhook`
   (later a second one, `https://askeden.com/api/stripe/webhook`). Select exactly these events:
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`. Add, then **Reveal** the signing
   secret (`whsec_…`). Each endpoint has its own secret.
4. **Settings** › **Billing** › **Customer portal**: turn it on (**Activate test link** / Save),
   allow **Cancel subscriptions** (at the end of the period is fine) and **Update payment methods**.
   Business information: a privacy policy and terms link, and `https://askeden.com` as the
   default redirect.
5. **Developers** › **API keys**: copy the test **Secret key** (`sk_test_…`). Then, from `site/`:

       node scripts/preview-config.mjs
       npx wrangler secret put STRIPE_SECRET_KEY -c wrangler.preview.toml
       npx wrangler secret put STRIPE_WEBHOOK_SECRET -c wrangler.preview.toml

   (without `-c …` for askeden.com itself, with that endpoint's own secret).
6. In `site/wrangler.toml` set `STRIPE_PRICE_PLUS = "price_…"`, run `node scripts/preview-config.mjs`
   again and deploy the preview. `/api/web/config` then says `billing: true`. Try it with Stripe's
   test card `4242 4242 4242 4242`, any future date and CVC.
7. Live mode later: the same steps with the dashboard in live mode, the `sk_live_…` key, the live
   endpoint's `whsec_…`, the live price id, and `STRIPE_LIVE = "1"` (a live key is refused without
   it). **Stripe Tax** (sales tax and VAT on the $20) is a separate decision before going live.
8. Optional, later: `STRIPE_IN_EDEN_APP = "1"` offers the web purchase inside the Eden iOS app
   too, for the US link-out; leave it empty until that's decided against Apple's current rules.

### Deploying

The first deploy with this code applies migration `v3` (the `Identity` class) and the
`IDENTITIES`, `AUTH_RATE` and `EDEN_RATE` bindings. Nothing else to run. Existing accounts need no
migration: each gets its Identity record at its next Apple sign-in.

Eden sync, delegates and team spaces add migration `v4` (the `Space` class, SQLite) and the
`SPACES` binding; no secrets. Keep `v1`–`v4` and every binding in any later `wrangler.toml`:
removing a class needs a `deleted_classes` migration, which destroys its data.

## Security review (2026-10-06)

Reviewed: everything above, `worker.js` `fromElsewhere`, `account.js` (`WEB_FORBIDDEN`, the new
ops), `link.js`, `apple.js`, `google.js`. Fixed in this pass:

1. **Strict cookie after a cross-site callback.** Ending a provider callback with a redirect to
   `/` or `/#account` would lose the session (SameSite=Strict isn't sent along a redirect chain
   started on another site). Success and link-mode endings use a same-site onward page. Only
   sign-in failures, which need no cookie, redirect.
2. **Link-mode account binding.** The callback can't read the Strict session cookie, so the
   account being linked comes from a server-side record taken once under the attempt's state.
   It is never taken from a cookie or the query. Putting the session token in a SameSite=None
   cookie was rejected: it would have weakened the session to cross-site for 10 minutes. At the
   callback, the browser that started must still be signed in.
3. **Takeover by linking.** Linking needs an existing valid session at the start, the attempt's
   state cookie in the same browser, and a fresh provider proof (an id_token carrying this
   attempt's nonce). Identities are never matched by email. Collisions are atomic in the Identity
   object (`409 identity_taken`). An Apple ID whose derived account exists can't be pulled into
   another account. A legacy account's unknown Apple slot can be filled only by the Apple ID its id
   derives from. A refused link rolls its claim back.
4. **Login CSRF.** The provider callbacks need the state cookie (compared in constant time).
   `GET /api/web/handoff` is refused when `Sec-Fetch-Site` says another site started it, so a page
   can't sign a browser in to the attacker's account with the attacker's handoff code. The code is
   256 random bits, single use, 60 s, rate limited, and holds only `{ account_id, sub_hash }` (the
   device and token are made at redemption, not stored).
5. **Timing-safe compares.** State, Google's nonce and now Apple's nonce use `sameText`. It was a
   plain `!==` on the nonce hash before. Device secrets and poll secrets already compared hashes
   in constant time.
6. **Open redirects.** None: every destination is built from fixed paths and a whitelist of
   error codes (`session.js` `target`). The onward page escapes its URL.
7. **Origin checks.** Every new POST (`signout-everywhere`, `devices/<id>/signout`,
   `identities/<p>/unlink`, `native/apple`) is behind `fromElsewhere`, and the session cookie is
   SameSite=Strict as well. `native/apple` from a browser page elsewhere carries that page's Origin
   and is refused. The app sends none.
8. **Session revocation.** `forgetSessions(account)` runs on every sign-out path in this
   isolate. Other isolates may serve cached reads (page assets, chat meta) for up to 30 s. Turns
   and every account op re-check the device secret in the account.
9. **Web device restrictions.** `WEB_FORBIDDEN` is unchanged. The new authenticated ops a browser
   may use are `identity-unlink` (never the last) and `browsers-signout` (`web` devices only). The
   unauthenticated internal ops `exists` and `identity-link` are reachable only by the Worker (DOs
   have no public route). `identity-link` also requires a live `web` device of that account.
10. **Op name collision (found while building).** The Mac relay's dispatch
    (`op.startsWith('web-')` → `webrelay.js`) swallowed the existing `web-signin` op, which made
    every web Apple sign-in fail with 401. `web-signin` is now dispatched before it, and the new
    sign-out op is named `browsers-signout`. Rule: account ops starting with `web-` belong to
    `webrelay.js`.
11. **Google key rotation.** On an unknown `kid` the keys are read again at most once a minute,
    so junk tokens can't make the Worker hammer Google. The cache honours Google's `max-age`
    (capped at an hour). Apple's keys keep their old behaviour (re-read on an unknown kid); the
    callbacks are rate limited.
12. **Privacy.** No raw provider sub is stored (Identity objects are named by a hash; a test
    checks the Account). Apple's sign-in asks for no scope. Google's address is kept only for
    display.

Added with Eden sync, delegates and team spaces (H1, H14, G8; `eden-sync.js`, `delegates.js`,
`space.js`):

13. **No plaintext, no keys.** Conversations, shared conversations and their titles are sealed in
    the browser (AES-256-GCM); the Eden key and space keys reach a browser only sealed to its own
    non-extractable key pair, or (Eden key) wrapped with the recovery passphrase. Tests check the
    stored values hold no text. The server keeps a hash of a key-derived proof, so a session alone
    can't make a device "trusted"; only a trusted device reads, writes or approves.
14. **Swapped keys.** Approving a browser shows six digits derived from its public key on both
    screens, and the approval must echo the key it sealed to; a key changed in between is refused
    (409). This is the defence against a server that swaps keys, so the words say to check it.
15. **The passphrase wrap is offline-crackable by whoever holds the server's data.** Hence
    PBKDF2-SHA256 at 600 000 rounds, at least 12 characters (the suggested one has 125 bits), and a
    server-side floor of 310 000 rounds.
16. **Grants can't escalate.** A grant's device is checked in the owner's object on every op
    (`authenticate` → `grantGuard`), whatever route led there; it is never listed or counted among
    the owner's browsers, never usable as a session cookie (`currentSession` refuses a grant's
    device), and only the person it was made for can use it (its `account` must equal the
    browser's own valid session). Owner-only ops (`deleg-*`, `esync-*`, spaces) refuse it.
17. **Money.** A grant's turns are capped by the owner's allowance and its own pool, with turns in
    flight held; the pool is named in the hold's bucket, so spend is counted there even if the
    object restarts mid-turn. After a revoke, hosted Eden refuses to spend instead of falling back
    to the delegate's own allowance.
18. **Invitations** are 60-bit single-use codes, 7 days, found through index objects named by
    the code's hash; accepting is rate limited (`LINK_RATE`) and needs a signed-in session. No
    email is sent by askeden.com.
19. **Op names.** The new account ops are `esync-*` and `deleg-*`, prefixes no other op uses (see 10).
20. **The apps approving a browser for Eden sync** (iPhone and Mac, docs/accounts.md "The
    J.A.R.V.I.S. apps"). Same rules as a browser approving: only an app that proved Eden's key is
    trusted and sees requests; it shows six digits it computes itself from the request's public
    key, asks askeden.com again before sealing and refuses a key that changed, and the approval
    echoes that key (409 otherwise). The app's private key and Eden's key stay in its Keychain
    (this device only); the recovery passphrase is used on the device and never sent or kept.
    No new route or op: `/api/esync/<op>` already took the apps' bearer tokens.

Added with billing on the web (Stripe, F15; `eden/billing.js`, `accounts/stripe-plan.js`):

21. **The webhook has no session; its signature is checked first**, before the body is
    parsed: HMAC-SHA256 over the raw bytes, constant-time, 5-minute tolerance, every `v1` tried.
    It's routed before the Origin rule (Stripe sends none). An event names an account only through
    metadata askeden.com wrote itself (`client_reference_id`, `metadata`); a deleted or unknown
    account gets nothing stored, and only a `STRIPE_PRICE_PLUS` price makes Plus.
22. **Buying is the browser's own session only**, fresh-checked, same-Origin, `SameSite=Strict`;
    not while acting for someone (409), never a grant's device (the account refuses it). The
    Checkout's `client_reference_id` is the session's account, never anything from the request.
23. **No open redirects**: Stripe's return addresses are one fixed page with three fixed
    destinations; the page opens only the `url` askeden.com's own call to Stripe returned
    (checked to be `checkout.stripe.com` / `billing.stripe.com`, or the dev fake).
24. **Keys**: the secret key and webhook secret are Worker secrets, never logged (errors log only
    Stripe's error type and code). A live key needs `STRIPE_LIVE = "1"`; `STRIPE_API_BASE` (dev and
    tests) only takes a loopback address and a test key.

Added with chat through the Mac and linking a Mac from the browser (`eden/via-mac.js`,
`session.js` `linkMac`, `public/link/`):

25. **A subscription serves only its owner.** With no provider key on the Worker (or
    `EDEN_CHAT_VIA_MAC = "1"`), `POST /api/chat/send`, `POST /api/route` and `GET /api/chat/meta`
    go to Eden on the owner's Mac through the web relay. Refused for a delegate's or a space
    member's session three times: in hosted Eden (`who.grant`, 403 `owner_only`), in the account's
    object (`web-forward` refuses a grant's device), and on the Mac (`eden_link.py` lets a
    non-private turn, the preview or meta through only when the relay marks it `owner: true`, and
    only from a `web` device in the account's own device list, which never lists grants). No
    allowance is held or spent. Compare answers 503 `needs_key`.
26. **Linking a Mac from the browser** (`GET /api/web/mac-link`, `GET /api/web/mac-link/<code>`,
    `POST /api/web/mac-link/<code>/approve|deny`, the page `/link`). The tradeoff: until now only
    an app (iPhone) could add a Mac, so a stolen browser session could never add a device. Now a
    browser session can, so it is limited to sessions **created in the last 10 minutes**
    (`WEB_LINK_MAC_MS`, checked in the Worker and again in `Account.addLinkedDevice`, 403
    `sign_in_again`); an older one must sign in again (fresh Apple, Google or app approval). It is
    the browser's own session and account (never the one it acts for), a code of kind `mac` only
    (403 `not_a_mac`), same-Origin and `SameSite=Strict`, rate limited per account (`LINK_RATE`
    `look:`), and the Mac gets a token with **no sync key** (`sealed_key: null`). The apps' bearer
    route `/api/link/<code>/approve` still refuses every `web` device, and a browser may never add
    a browser or a phone. Residual: a phished owner who approves an attacker's code within 10
    minutes of signing in adds the attacker's Mac (as with the iPhone); the page shows the Mac's
    name and code and says to approve only a code on their own Mac now. The Mac's code rides the
    URL fragment (`/link#CODE`), never a query, so it reaches no server log.

Accepted / residual:

- A session lasts 30 days, and unlinking or signing out everywhere needs only the session.
  Neither grants access (unlink never removes the last method), and adding access (linking)
  always needs fresh provider proof.
- With `EDEN_ACCOUNTS` set, a refused first-time Google sign-in leaves an Identity pointing at an
  account that is never created. This is harmless and consistently refused.
- **Rollback caveat.** Code from before web sign-in treats unknown device kinds, `web` included,
  as iPhones (`deviceKind`). Rolling back that far would give every browser session an iPhone's
  powers (sync, approving links, deleting the account). Any such rollback must be followed by
  signing out every `web` device: delete the `dev:*` entries whose `kind` is `web` in each Account,
  or, simpler, roll forward instead. Rolling back only to before this change (web sign-in present,
  no Identities) is safe for sessions, with three effects. An Apple ID linked to a Google-first
  account opens its derived account again. Google sign-in stops. Unlinked Apple IDs fall back to
  their derived accounts. Keep migration `v3` and the `IDENTITIES` binding in any later
  `wrangler.toml`: removing a class needs a `deleted_classes` migration, which destroys its data.

## Your own API keys on askeden.com (security review, 2026-10-06)

`GET/POST /api/chat/keys` (site/src/accounts/user-keys.js; the Mac's contract, docs/chat-api.md
in askeden, with `source: "account"`, `last4`, `added`, and `check` on a save).

- **Storage.** AES-256-GCM per account under the HKDF key tokens.js derives from `EDEN_TOKEN_KEY`
  and the account id; associated data `ukey:<account>:<provider>`. The Account object holds
  ciphertext, the last 4 characters and the date only. Deleting the account deletes them.
- **Never back to a browser.** No response carries a key: the page sees set, `····1234` and the
  date. A key leaves the Worker only to its own provider: the save's check (list models, 6 s
  timeout, the key in a header, never a URL) and that provider's chats.
- **No logging.** Nothing in user-keys.js logs; `userKeyFor` swallows errors silently; a
  provider's error is passed through `scrub()` (the key and anything key-shaped become `[key]`).
  Tests assert the key is absent from responses, errors and console output.
- **Who.** Only the owner's own devices: the gate refuses delegates and spaces (the route isn't in
  `CHAT_ROUTES`), `keysApi`/`userKeyFor` refuse any `who.grant`, and the object refuses a grant
  device (grantGuard, and `ukeys-*` again).
- **Origin.** POST goes through chat.js's gate: same origin, `X-Jarvis-Chat`, JSON only.
- **Limits.** `API_RATE` per account, `EDEN_RATE` per save, 10 saves an hour in the object.
- **CSP** unchanged: the page talks only to askeden.com.
- **Tests and dev.** `EDEN_FAKE_PROVIDER_BASE` (http on loopback) is honoured only when the page is on
  loopback too; never set it in production.
- **Billing.** A turn on `source: 'user'` (`billsAllowance(source)` is false) holds and spends no
  allowance; the per-model caps, per-account turn limit and abuse limits still apply.
