# askeden.com security review, 2026-10-07

Independent review of the Worker in `site/` (branch `eden-alpha`). Every finding below was checked
by reading the code path; the fixed ones have a test that fails without the fix.

Scope: web sign-in and sessions (`eden/session.js`, `eden/google.js`, `accounts/apple.js`,
`accounts/identity.js`, `accounts/webauthn.js`, `accounts/turnstile.js`, sign-up gate), device
tokens and `Account.authenticate`, Origin/CSRF rule (`worker.js fromElsewhere`, `web.js`), cookie
flags, OAuth/OIDC (state, nonce, PKCE, id_token signature/iss/aud/exp, Apple form_post), WebAuthn,
identity linking and account takeover, account deletion, BYOK keys (`user-keys.js`), Stripe
webhook, rate limits, the Anthropic-compatible proxy (`accounts/proxy.js`, `index.js anthropic`),
the via-Mac relay (`eden/via-mac.js`, `accounts/webrelay.js`, `Account.relay`), published pages
(`/p/*`), Help chat, Eden Messenger connect (`eden/ask.js`, `accounts/scoped.js`), Gmail consent
(`eden/google-data.js`), open redirects (`public/signin/return.js`), outbound fetches (SSRF), CSP
and security headers.

## Findings

| # | Severity | Where | Status |
|---|----------|-------|--------|
| 1 | Medium | `accounts/index.js` `anthropic`, `accounts/account.js` `allowAi` | Fixed |
| 2 | Low | `accounts/apple.js` `verifyIdentityToken` | Fixed |
| 3 | Low | `eden/session.js` `deleteWebAccount` | Open (product decision) |
| 4 | Low | `accounts/proxy.js` `PASS_HEADERS` (`anthropic-beta`) | Fixed |
| 5 | Low | `accounts/turnstile.js` `checkHuman` | Fixed |
| 6 | Low | `eden/web.js` `BASELINE` (HSTS) | Open |
| 7 | Low | `/api/web/link`, `/api/web/native/apple` | Accepted |

### 1. Medium: the apps' AI proxy could spend far past the allowance (fixed)

`POST /api/anthropic/v1/messages` checked `allow-ai` (was anything left?) before the request
and counted the cost only when the reply finished. Nothing was held while it ran, so requests
sent at once all passed the check. Any account can do this, including a new one on the free $1
trial (made with an Apple ID through the apps; no Turnstile there). The only limit was
`API_RATE` (120 a minute). With 120 parallel Opus requests and a large `max_tokens`, one trial
account could cost hundreds of dollars before the first `spend` landed. Hosted Eden already held
each turn's worst case; the raw proxy didn't.

Fix: a new account op, `hold-proxy` (`Account.holdProxy`). Each proxy request holds its worst
case: the body as input at `CHARS_PER_TOKEN` and all of `max_tokens` as output, at list price.
The hold is capped at what's left, and at most `PROXY_TURNS` (8) requests run at once. If
everything left is held by requests in flight, the next request gets 429 `rate_limit_error`
(`retry-after: 10`). The hold is released when the cost is recorded, when upstream errors, or
when `forward` throws; it expires after 15 minutes regardless. Hosted Eden's `EDEN_TURNS` now
counts only its own holds, so the apps can't block it. Worst-case overshoot drops to about one
request. Test: `accounts.test.js` "requests at once hold their worst case…". Documented in
`docs/accounts.md`.

### 2. Low: junk Apple tokens refetched Apple's keys every time (fixed)

When a token's `kid` was unknown, the cached keys were dropped and Apple's keys fetched again,
with no limit (Google already throttles this to once a minute). Anyone could make the Worker
fetch `appleid.apple.com/auth/keys` once per request; the callbacks' rate limit was the only
cap. Now at most once a minute, the same as Google. Test: `auth.test.js` "Apple identity tokens:
an unknown kid…".

### 3. Low: deleting the account from a browser needs no recent sign-in (open)

`POST /api/web/account/delete` asks for a typed `DELETE`, the same Origin and a valid session.
That session can be up to 30 days old. Someone holding a stolen session (the cookie is HttpOnly,
Strict, `__Host-`, so this means malware or a shared computer) can delete the account for good.
Linking a Mac already needs a sign-in within the last 10 minutes (`WEB_LINK_MAC_MS`).
Recommendation: put the same freshness rule on deletion, or ask for a passkey or provider
re-auth. Left open because it changes the product flow.

### 4. Low: the `anthropic-beta` header passes through to Anthropic, but some costs aren't counted (fixed)

The proxy forwards `anthropic-beta`, which lets the apps' token turn on server-side tools.
`costOf` counts tokens and web searches only. A billed extra that isn't tokens, such as
code-execution container time past the free allowance, is never counted against the account.
It's bounded by the rate limit and finding 1's holds. Recommendation: forward only an allowlist
of beta values the apps use, or refuse `tools` of server types other than web search.

**Fixed:** `anthropic-beta` is no longer passed as is. Only the betas in `proxy.js` `BETAS`
(Claude Code's and the iPhone's, all priced in tokens) are forwarded; any other value is dropped.

### 5. Low: Turnstile's answer isn't checked for hostname (fixed)

`checkHuman` accepts any answer with `success: true` and doesn't compare `hostname` (or
`action`) with this site's. Cloudflare already limits a site key to its configured hostnames,
so the remaining risk is small. Recommendation: refuse an answer whose `hostname` isn't the
request's host.

**Fixed:** `checkHuman` takes the request's host and refuses an answer whose `hostname` differs.

### 6. Low: HSTS has no `includeSubDomains` (open)

`strict-transport-security: max-age=31536000` covers only the exact host, not `messenger.` or
`preview.`. The session cookies are `__Host-` and every POST checks the exact Origin, so a
subdomain can't use the session. Recommendation: once every subdomain serves HTTPS, add
`includeSubDomains` (and then preload). Still open on 2026-10-07: not every askeden.com
subdomain could be confirmed HTTPS-only, so it was left out.

### 7. Low: accepted residuals

- A web sign-in code can be phished, as any device code can. An attacker starts
  `/api/web/link` and talks the owner into approving it in the J.A.R.V.I.S. app. The app shows
  the browser's name and rough location; the code lasts 10 minutes.
- `POST /api/web/native/apple` uses a nonce the app picks, so an Apple identity token that
  leaked from the device could be replayed until it expires (about 10 minutes). The same is
  true of the apps' existing `/api/account/apple`.
- A published page (`/p/<id>`) runs in a CSP sandbox: opaque origin, no network, no forms, no
  cookies. Its script can still navigate the tab to another site (a phishing hop that starts
  on askeden.com). Sign-in has no passwords to steal.

## Checked and found sound

- **Google OIDC:** state and nonce compared in constant time; PKCE S256; RS256 only;
  `iss`/`aud`/`azp`/`exp`/`iat` checked; `email_verified` required.
- **Apple form_post:** a state cookie set with SameSite=None just for this; the Origin
  exception covers only Apple's callback; the nonce is sent hashed and compared in constant
  time; `aud` is the Services ID.
- **Identities:** never matched by email. Check-and-set is atomic in the Identity object.
  Linking needs a live session at the start, a server-side `oauth:<state>` record and a fresh
  provider proof. An Apple ID whose derived account exists can't be pulled into another account.
- **WebAuthn:** the challenge is server-side, single use, 5 minutes. Checked: type, origin,
  `crossOrigin`, rpIdHash, UP and UV flags, `fmt: none`, the credential id matches, the
  signature, and the counter goes up (inside the Identity object).
- **Sessions:** `__Host-eden` is HttpOnly, Secure and SameSite=Strict. Every non-GET `/api`
  request needs this exact Origin, or none (the apps). Web devices are restricted by
  `WEB_FORBIDDEN` and a grant's device is never accepted as a session. Sign-out clears this
  isolate's cache; other isolates may serve cached reads for up to 30 s.
- **Redirects:** `safeReturn` allows only same-site paths and never `/api`; the onward pages
  escape the address; billing returns go to fixed places. No open redirect found.
- **Cross-account access:** none found. Each account is its own Durable Object, and the relay,
  BYOK keys, published pages and Google tokens are reached only through the asker's own account.
  A Mac serves only its owner's `web` devices: grants are refused three times, and `MAC_ROUTES`
  is an allowlist that rejects `..`, `%` and `\`.
- **BYOK keys:** AES-GCM sealed under a per-account HKDF key with AAD. Only `last4` ever
  reaches a browser, and provider errors are scrubbed. Grants are refused.
- **Stripe webhook:** HMAC over the raw body, constant time, 5-minute tolerance, every `v1`
  value tried.
- **SSRF:** no fetch goes to a user-supplied URL. The fake provider and Google bases are
  honoured only on loopback.
- **Help chat:** it sees only the static Help pages and the asker's own question, has no tools
  and no account data, and is rate limited with a held worst case.

## What a human reviewer should focus on

1. The proxy hold (finding 1). Check the 429 behaviour is acceptable for the Mac's Claude Code
   and the iPhone's `ClaudeClient`: both retry on 429, but a run near the end of the allowance
   is now serialised.
2. Findings 3 and 4 are product decisions: re-auth before deleting the account, and an
   allowlist for `anthropic-beta`.
3. Before the public launch (separate gate): turn on Turnstile (`TURNSTILE_SITE_KEY`/`_SECRET`)
   and `SIGNUPS = "open"`, set the Anthropic key, and repeat this review against the deployed
   config, not just the code. Pay special attention to `EDEN_ACCOUNTS` and
   `TURNSTILE_OPTIONAL`, which must not be `1` in production.
4. The Durable Objects' unauthenticated ops (`web-signin`, `identity-link`, `spend`,
   `release-ai`, `google-*` by device id, `exists`) are safe only because no public route reaches
   a DO directly. Any new route that forwards an op name taken from the request would break that.
