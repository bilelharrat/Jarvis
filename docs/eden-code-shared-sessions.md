# Eden Code: shared live sessions (F13)

What a teammate can see of a session, how it gets to them, and what's still to build.

## Where it stands (2026-10-13)

| Phase | What | Where | State |
|---|---|---|---|
| 1 | Read-only live view by link, on the Mac's network | `features/code_share.py`, `web/share.*`, `web/features/code_share.*` | Built (Labs: Share live) |
| 2 | Viewers' comments and suggestions, as cards for the owner | same, switch `code_share_comments` (off) | Built, behind its switch |
| 3 | Links that work outside the network, through askeden.com | Worker + Durable Object, viewer page on the site; a relay transport in `code_share.py` | **Design below. Site frozen: not built** |
| 4 | Co-control with roles | | Not started; outline at the end |

### Phase 1, as built

- **Share live** (More › Share live…, a Labs module) makes a link for the open session:
  `https://<mac>.local:8765/share/<token>`, served by the phone companion's own HTTPS server
  (`remote.py`; the companion has to be on). The token is 24 random bytes (`secrets.token_urlsafe`),
  looked up by its SHA-256; it lives in memory only, so every share ends when Eden quits.
- It lasts 15 minutes, an hour (the default), 4 hours or a day, or until **Revoke**. At most 10
  shares live at once and 20 viewers on one; each viewer is a random id the page makes per tab,
  counted while it was heard from in the last 15 seconds. The owner sees "2 watching" on the share.
- The view: the transcript (no thinking), the session's own changes (its Changes view, hunk by
  hunk) and its status. Every string goes through the session's redactors (`tasks.redact`: a
  secret given to it shows as `$NAME`), then share-safe export's (`code_export.redact_secrets`),
  then `code_export.Anonymizer` (project path, home folder, user name). A changed line that
  `secret_scan` flags is withheld whole; credentials and binary files are listed without lines.
- Nothing to act with: three routes (`GET /share/<t>`, `GET /share/<t>/state`, and `POST /share/<t>/comment`,
  which is refused unless phase 2 is on), none under `/api`, none taking a device token. The page
  has a strict CSP (scripts from itself only), `Referrer-Policy: no-referrer` (the token is in the
  address), no framing, and puts everything in with `textContent`.
- Rate limits (`remote.Limiter` buckets per share and viewer): 90 looks a minute, 6 comments.

Known limits of phase 1:
- **LAN only.** The `.local` name and port 8765 have to be reachable from the teammate's machine.
- **Certificate warning.** The companion's certificate is the Mac's own (`companion_tls`), not a
  public one: the teammate's browser warns, and the pane shows the fingerprint to compare. Phones
  don't hit this because they pin it at pairing; a browser has no way to.
- Polling every 2 s; the changes are worked out at most every 3 s per share and only sent when
  they changed (`changes_key`).

### Phase 2, as built

With **Let viewers send suggestions** on (`prefs.features.code_share_comments`, off by default) and
**Suggestions on for this share** ticked when it's made, the viewer page shows a box. A suggestion
(2,000 characters, a name of 40, both cleaned of invisible and bidi characters) arrives as a card in
the Share pane and a caption. The owner can **Copy into the composer** (their own words then, to
edit and send) or **Dismiss**. A suggestion is never a message to the session: there is no code path
from a viewer to `task.inbox`. Turning the switch off stops new ones at once, for every share.

## Phase 3: the askeden.com relay (not built: the site is frozen)

### Why the phone relay can't simply carry viewers

`relay.py` already gets the owner's phone to the Mac from anywhere: the Mac holds a control
WebSocket to `wss://askeden.com/api/relay/listen`; for each phone connection the Worker opens a
stream and the bytes are the companion's own TLS, end to end, pinned by the phone. Two things stop a
teammate's browser using that:

1. A browser can't speak raw TLS over a WebSocket, nor pin a self-signed certificate.
2. Streams are for the account's own devices (the Worker checks the account); a teammate has none.

### The design: end-to-end encrypted snapshots through a Durable Object

**Link.** `https://askeden.com/s/<share_id>#k=<key>`. `share_id` is 16 random bytes (the Worker
routes by it); `key` is a separate 32-byte AES-GCM key made on the Mac. The key is in the
fragment, which browsers never send to a server, and the page sets `no-referrer`. askeden.com relays
ciphertext only.

**Registering.** While linked to the account, the Mac registers a share over the account's existing
auth: `POST /api/share {share_id, expires, max_viewers, comments}`; `DELETE /api/share/<id>` revokes.
The Worker keeps each in a Durable Object (`ShareRoom`, one per share), which deletes itself at
`expires` (an alarm). The account's device token is required; a share can't outlive 24 h or the
Mac's link to the account.

**Content.** The Mac pushes rather than being polled: on each change (debounced, at most every 2 s)
it sends the room the same JSON the LAN view serves (phase 1's `state`, all redaction done on the
Mac first), encrypted with AES-GCM under `key` (a fresh 96-bit nonce each, the share id and a
sequence number as additional data so a frame can't be replayed into another share or out of order).
It goes over the existing control line as new message types, so no new connection:

```
Mac → Worker  {"type": "share_push", "share": id, "seq": n, "blob": base64(nonce|ciphertext)}
Worker → Mac  {"type": "share_viewers", "share": id, "count": n}
Worker → Mac  {"type": "share_comment", "share": id, "blob": base64(...)}   (phase 2)
```

Frames over `relay.MAX_FRAME` (64 KB) are split (`part`, `parts`); the transcript goes as deltas
after the first full snapshot, the changes only when their key changes, as on the LAN.

**Viewers.** `GET /s/<id>` is a static page from the site (served with SRI and a strict CSP). It
takes the key from `location.hash`, opens a WebSocket to the room (`/api/share/<id>/watch`), gets the
latest snapshot and then each push, decrypts in the browser (WebCrypto), and renders with the same
code as `web/share.js` (move its drawing into a shared module). The room counts sockets, enforces
`max_viewers`, and reports the count to the Mac. A comment is encrypted in the browser under the
same key and passed through; the room rate-limits it (6 a minute a socket, and Turnstile before
the first one, as the launch gate already plans for public forms).

**What askeden.com sees.** That a share exists, when, how big its frames are, how many watch and
from which IPs. Never the content or the comments. It could, being the site, serve a changed page
that reads the key: that's the limit of any web E2EE, and the reason to keep the page small,
static and pinned with SRI, and to say so in the Share pane ("the link's key never reaches
askeden.com; the page that reads it does come from askeden.com").

### What changes where

- **Mac** (`features/code_share.py`): a second transport beside the LAN one. A share made while the
  account is linked gets both links (the LAN one stays for the same network: no certificate step
  there, faster). New: register/revoke calls, the push loop (shares the redaction code), and
  `relay.Relay` routing the three new message types to it. Tests with the fake relay that
  `test_relay.py` already uses.
- **Site** (frozen until App Review is through): the `ShareRoom` Durable Object, the two API routes,
  the viewer page at `/s/`, Wrangler config for the DO binding (`wrangler.nor2.toml` has no R2; the DO
  needs a migration entry). Deploy only with the other sessions' agreement, per the shared-tree gate.
- **Owner steps:** none beyond the deploy; it uses the existing account link.

### Tests to write with it

Mac: a pushed frame decrypts with the key and nothing else; a revoked share stops pushing and is
deleted on the Worker; frames over 64 KB split and join; a comment that fails to decrypt (wrong key,
replayed seq) is dropped. Worker (miniflare): expiry alarm, viewer cap, rate limit, a non-owner can't
register or revoke, the room never stores plaintext (it never has the key).

## Phase 4: co-control (outline)

Roles per share: **viewer** (phase 1), **commenter** (phase 2), **driver**. A driver's message is
still not sent straight to the session: it arrives as a card naming who sent it, and the owner's
tap (Touch ID for anything the session would run unattended) sends it as the owner's own. A later
"trusted driver" role can skip the tap for plain messages but never for permission answers, Bypass,
`!` commands, landing, or anything Touch ID guards today. Every driver action goes in the companion's
audit log. Needs teammates to have identities (askeden.com accounts), so it comes after phase 3.
