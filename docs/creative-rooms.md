# Creative rooms: editing one project together (Eden Scorsese, and later Houdini and Aldus)

Status: built on `feat/creative-rooms` (on top of `feat/creative-eden`), **not deployed**. Deploying waits for the
owner's OK (and the launch gate). Code: `site/src/creative/rooms.js` (the room and the Worker's routes),
`site/src/creative/rooms-auth.js` (the token check), tests `site/test/creative-rooms.test.js`.

A room is one shared project. It is a Durable Object (`CreativeRoom`, binding `CREATIVE_ROOMS`), one per project,
named `room:<id>`. The same class also serves small index objects named `idx:acct:<account>` and
`idx:mail:<sha256 hex of the lower-cased email>` that list the rooms an account has, or was invited to by email.

The room never runs or reads the project's commands. It puts them in one order, stores the log, keeps the latest
snapshot for late joiners, relays presence, and keeps the people, the comments and the activity feed. The apps apply
the commands (Scorsese's bridge: `eden/scorsese-core/src/together.rs`, `mac/BRIDGE-API.md`).

## Auth

Every request carries the app's `creative` token (docs/creative-api.md §2): `Authorization: Bearer es1.…`
(WebSockets too; the Mac's `URLSessionWebSocketTask` sends headers). The Worker checks it with
`verifyCreativeToken(request, env)` (`src/creative/rooms-auth.js`), the same check as the rest of `/api/creative/`:
the token parsed (`accounts/scoped.js`), the account allowed on Eden (`webAllowed`), then verified in the account's
own object with `creative-me` (it needs no Plus: editing together is free). It resolves to `{ account, name, email }`
(the name is the account's sign-in email, as `/api/creative/me` has it). No token, a malformed, revoked or expired one:
401 `not_connected` (link again). A token of another app (Messenger's) or an account that may not use Eden yet: 403.

One extra door, for `wrangler dev` only: with `CREATIVE_ROOMS_DEV = "1"` **and** a request to localhost or 127.0.0.1,
the fake people of `wrangler.creative-rooms-dev.toml` (`CREATIVE_ROOMS_DEV_TOKENS`) are taken too, so two apps can try
rooms without real accounts. `wrangler.toml` never sets it, and askeden.com is never localhost.

Like the rest of `/api/creative/`, no browser: any request with an `Origin` header (reads included), or `OPTIONS`, is
refused (403 `forbidden`; no CORS). The apps send no Origin. These routes come before `creativeApi` in `worker.js`.
Every request counts on `API_RATE` per account, as the other Creative Suite routes do.

The Worker forwards to the room with `x-eden-account`, `x-eden-name` and `x-eden-email` (name and email
percent-encoded) set from the verified token. It passes on only the headers a room needs (`content-type`,
`content-length`, `x-seq`, `x-hash` and the WebSocket upgrade's), never one of these from outside, and a Durable Object is
only reachable through the Worker, so they can't be forged. Index objects are never reachable from a path.

## Roles

| Role | Can |
|---|---|
| `owner` | everything: edit, comment, invite, change roles, remove people, rename, delete the room |
| `edit` | send commands, comment, upload snapshots; invite when the room's `settings.invite` is `editors` |
| `comment` | comment, reply, resolve; no commands |
| `view` | watch: the log, presence and comments; sends presence only |

People are invited by their Eden account's email. A pending invite turns into a member the first time someone signs in
with that email (the token's verified email, compared lower-cased). Each member has a **slot**: 0 for the owner, then
1, 2, 3… in invite order, never reused. The app gives every slot its own range of project ids, so ids made on two Macs
never collide (`slot × 2^36` up). Colours are by slot.

## HTTP

All JSON, all under `/api/creative/rooms`. Errors are `{ "error": "<message for a person>", "code": "<code>" }`.

| Call | Who | Does |
|---|---|---|
| `POST /api/creative/rooms` `{name}` | anyone signed in | makes a room; you're its owner (slot 0). `201 {room}` |
| `GET /api/creative/rooms` | anyone | the rooms you own, were invited to, or joined, newest first: `{rooms: [{id, name, role, owner, ownerName, status}]}` (`owner`: the owner's account id; `status` `"in"` or `"pending"`) |
| `GET /api/creative/rooms/:id` | members | `{room}` (below) |
| `PATCH /api/creative/rooms/:id` `{name?, settings?: {invite: "owner"\|"editors"}}` | owner | rename, settings |
| `DELETE /api/creative/rooms/:id` | owner | deletes the room: log, snapshot, comments, activity, every index entry; sockets get `{t:"deleted"}` |
| `POST /api/creative/rooms/:id/invite` `{email, role}` | owner (editors if allowed) | a pending member; `201 {member}` |
| `PATCH /api/creative/rooms/:id/members/:key` `{role}` | owner | changes a role |
| `DELETE /api/creative/rooms/:id/members/:key` | owner; anyone for `me` | removes a person or cancels an invite; their sockets get `{t:"removed"}` |
| `PUT /api/creative/rooms/:id/snapshot` (body: bytes; headers `x-seq`, `x-hash`) | owner, edit | the project at `seq`, for late joiners |
| `GET /api/creative/rooms/:id/snapshot` | members | the bytes, headers `x-seq`, `x-hash`, `x-bytes`; 404 when there's none yet |
| `GET /api/creative/rooms/:id/activity?before=<n>` | members | `{activity}`: up to 100 entries before `n`, newest first |
| `GET /api/creative/rooms/:id/socket` (WebSocket upgrade) | members | the live line, below |

`room`: `{id, name, owner, head, snapshot: {seq, hash, bytes} | null, settings: {invite}, you: member, members: [member]}`.
`member`: `{key, account, name, email, role, slot, status: "in" | "pending", here}`. `key` is the account id once
joined, `mail:<sha256 hex of the email>` while pending (then `account` is null and `name` is the email). Any request
from someone signed in with a pending invite's email (opening the room, its socket, its snapshot or its activity)
makes them a member first; `DELETE …/members/me` from them turns the invite down instead. `members/:key` takes the key
percent-encoded. The owner can't leave (409 `owner`; delete the room) and isn't removed or given another role; the
roles anyone is given are `edit`, `comment` and `view` (invite defaults to `edit`).

Snapshots: `x-seq` must be between the current snapshot's seq (0 before the first) and the head, else 409 `bad_seq`.
When the room has a hash for that seq (from `check` messages, or the current snapshot's) and it differs, the upload is
refused (409, `diverged`): a Mac that fell out of step can't replace the room's copy. Accepting one deletes the log up
to it. Bodies 1 byte to 64 MiB (413 `too_big`), stored in 1 MiB chunks under a new generation; meta then names it, and
the old chunks go.

## The live line (WebSocket, JSON text frames)

From the app:

| `t` | Fields | Does |
|---|---|---|
| `hello` | `since` (the last seq the app has; 0 or absent: none) | answered with `welcome` |
| `op` | `id` (the app's own id for it: a safe integer, or up to 64 of `A–Z a–z 0–9 _ . : -`), `base` (the seq it was made on), `label` (≤ 200), `via` (`"eden"` or null), `note` (≤ 1000, or null), `op` (the command, an opaque string) | edit/owner only. Ordered: seq = head + 1, stored, sent to everyone (the sender takes it as its confirmation). Re-sending an id of yours already in the log answers with that entry again, to that socket only; one the last snapshot already holds answers `error` `in_snapshot` with its `seq` (ids are remembered one snapshot longer than their ops). `base` > head: `error` `bad_base` |
| `presence` | `sequence`, `playhead`, `selection` (clip ids), `lock` (clip id being trimmed, or null), `doing` (`"editing"`/`"viewing"`) | sent to the others with who it is; never stored |
| `comment` | `op: "add"` `{cid, sequence, clip, offset, time, text, mentions}`; `"reply"` `{comment, text, mentions}`; `"resolve"` `{comment, resolved}`; `"delete"` `{comment}` | comment role and up (delete: its author or the owner). Stored, sent to everyone as `{t:"comment", comment, cid}` |
| `check` | `seq`, `hash` | the app's hash of the project at `seq`; a different one from another Mac answers `{t:"diverged", seq}` |
| `note` | `to` (a member key), `text`, `clip` | comment role and up. "Ask Maya": delivered to that person's apps, never stored; `error` `not_here` when none of their apps is in the room |

From the room:

| `t` | Fields |
|---|---|
| `welcome` | `you`, `room`, `ops` (every entry after `since`, oldest first) or `resync: true` when `since` is older than the snapshot (or newer than the head), `presence` (everyone else here), `comments`, `activity` (the latest 200, newest first). When the tail or the comments are too big for one frame (about 900 000 characters each), `more: true` and the rest follow at once, in order, as `op` and then `comment` frames |
| `op` | `seq`, `id`, `by` (member key), `name`, `slot`, `at`, `base`, `label`, `via`, `note`, `op` |
| `presence` | `key`, `name`, `slot` and the presence fields |
| `left` | `key`, when that person's last app leaves |
| `comment`, `activity`, `members` | `{comment, cid}` (a deleted one is `{id, deleted: true}`), `{activity}`, `{members}` |
| `room` | `name`, `settings`, after the owner changes them |
| `note` | `from`, `name`, `text`, `clip` |
| `diverged` | `seq` |
| `snapshot_wanted` | `seq`: the log is long, an editor's app uploads a snapshot (to edit/owner apps, at every 500 ops past the snapshot, and after a `hello` while it's that long) |
| `error` | `code`, `message`, and `id` when it's about an op (`cid` for a comment) |
| `removed`, `deleted` | then the socket closes (codes 4001, 4002) |

`{"t":"ping"}` is answered `{"t":"pong"}` without waking the room. Binary frames, frames that aren't a JSON object with
a `t`, unknown `t`s and malformed fields answer `error` `bad_request` (or `too_big`); nothing is stored for them.

Times (`playhead`, `offset`, `time`) are the engine's ticks (254 016 000 000 a second) and ids are integers; both must
be safe JavaScript integers (ids 0 or more). The room never parses `op`, so its ids keep their precision. Presence
from a viewer or commenter always says `doing: "viewing"` and `lock: null`.

Comments: `{id, by, name, at, sequence, clip, offset, time, text, mentions, replies: [{id, by, name, at, text, mentions}],
resolved, resolvedBy}`. A comment is pinned to a clip and an offset into it, so it stays with the moment when clips move;
`time` is where it was made, for when the clip is gone. Mentions are member keys.

Activity: `{n, at, by, name, kind: "op" | "comment" | "reply" | "resolve" | "member" | "room", text, seq, via}`. An op made
by Eden carries `via: "eden"`: it's credited to whoever asked (the op's author) as "asked Eden: …".

## Limits

20 people a room (members and pending invites); ops up to 512 KiB (UTF-8 bytes); 120 ops per 10 s and 30 presence
messages a second per socket (extra presence is dropped silently); 60 other frames (hello, comment, check, note) per
10 s per socket (`slow_down`); frames up to 1.6 MB; comments up to 4000 characters and 2000 a room (replies count),
200 replies a comment, 20 mentions (people in the room); notes up to 1000 characters; selections up to 64 clips; the
log is asked for a snapshot at 500 ops past the last one and refuses ops at 20 000 (`log_full`); 100 rooms owned per
account (409 `too_many`); 5 apps of one person in a room at once; an index object lists at most 1000 rooms. The
activity feed keeps the last 1000.

## Privacy and safety

- In transit: TLS (https and wss only; the Worker redirects plain http, except localhost for `wrangler dev`).
- At rest: Durable Object storage, encrypted by Cloudflare. The room holds what the apps send: commands, the project
  snapshot (media paths included, never the media), comments, names and emails of the people.
- Deleting a room deletes all of it at once (`storage.deleteAll`) and its index entries.
- Media: originals stay on each Mac. A clip whose file isn't on this Mac shows as on its owner's Mac, and relinks by
  the file's content fingerprint when it turns up. Light proxies in R2 are not built (owner: R2 bucket, limits).

## Local test

```sh
cd site && npx wrangler dev -c wrangler.creative-rooms-dev.toml --port 8788 --ip 127.0.0.1
node scripts/creative-rooms-smoke.mjs     # in another terminal: two fake people, a room, ops, presence, a comment, delete
```

Wrangler 4 needs Node 22 or later (on the owner's Mac `/usr/local/bin/node` is 22; Homebrew's default is 20). The dev
config binds only the rooms (no AI, browser, R2 or routes), so nothing remote opens, no login is asked for and nothing
is billed. Its tokens (`dev-ana`, `dev-maya`, `dev-jon`) are fake and only work on localhost with
`CREATIVE_ROOMS_DEV=1`; real `es1.` tokens can't work there (no accounts are bound).
