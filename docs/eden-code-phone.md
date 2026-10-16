# Eden Code on the phone

Start a session at the desk, carry on from the phone. What the Mac serves today (a mobile web page that
needs no app update), the API it uses, and the screens the native iPhone app adds once 1.0 is out of App
Review, on the same API.

## What's built (2026-10-15)

| Piece | Where |
|---|---|
| The API and its checks | `src/jarvis/features/code_phone.py`, `features/_code_phone_routes.py` |
| The mobile page (PWA) | `web/code-phone.html`, `.js`, `.css`, `web/code-phone-sw.js`, served at `/code/` |
| Hand off to phone (the Mac's window) | `web/features/code_phone.js` (More › Hand off to phone, `/phone`, the "On your phone" pane) |
| The handoff push | `companion_push.Notifier.deliver(note, asked=True)`, `Note.extra` |
| Tests | `tests/test_code_phone.py`, `tests/web/code-phone.test.mjs`, `tests/web/code-phone.e2e.cjs` (Electron at 390 × 844) |

**Turning it on.** Eden Code › More › Hand off to phone opens the pane; tick *Eden Code in your phone's
browser* (`prefs.features.code_phone_web`, off by default). The phone companion has to be on (Settings ›
iPhone & Watch). The pane shows the page's address (`https://<mac>.local:8765/code/`) and a QR code. On the
phone: open it, accept Safari's warning about the Mac's own certificate once (the pane shows the fingerprint
to compare), pair with the six-digit code from Settings › iPhone & Watch › Pair a phone, then Share › Add to
Home Screen.

**Where it works.** On the Mac's Wi-Fi, and over Tailscale when away (the companion answers on the
tailnet address too). The encrypted relay through askeden.com (`relay.py`) carries the iPhone app only: it is
the companion's own TLS inside a WebSocket, pinned by the app, which a browser can't speak. So "away from
the Wi-Fi" for the page means Tailscale; for the native app it means the relay, with nothing to set up.

**Hand off to phone.** One click on the Mac pins the session for the phone (the page opens it by itself,
once per handoff; the pin lives in memory, until Unpin, another handoff or a restart) and pushes to every
phone registered for Eden's notifications, now: whatever its settings say, the owner at the Mac or not,
with sound even in quiet hours, still within its push rate limit. The push is the existing path (the owner's
APNs key, or their account), its words the Mac's own ("Carry on from your phone", "In <folder>"), never the
session's. Without a phone registered for notifications (only the web page paired), the pane says to open
the link there.

## The API

All on the companion's server (`remote.py`, port 8765, HTTPS with the Mac's own certificate). Every
`/api/code/phone/*` call goes through `remote.Gate`: `Authorization: Bearer <device token>` (401
otherwise), the device's rate limit for its kind (`read` 240/min, `act` 60/min; 429 with `Retry-After`), a
capped body (413: 20 KB, a message 120 KB). Then the switch: `403 {"error", "off": true}` while
`code_phone_web` is off. Errors are `{"error": "<the owner's language>"}`.

| Call | Kind | Body / query | Answer |
|---|---|---|---|
| `GET /api/code/phone/home` | read | | `{sessions: [Summary], attention: [Card], pinned: {id, title, at} \| null, exterminator: [Run]}` |
| `GET /api/code/phone/options` | read | | `{models: [{ref, name, group, needs_key}], modes: [{id, name}], projects: [{name, branch, running}], defaults: {model, mode}}` |
| `GET /api/code/phone/session` | read | `id, after, seen, v, wait` | `View` (below); 404 when the session is gone |
| `POST /api/code/phone/send` | act | `{id, text}` | `{ok}` (queued as the composer queues it) |
| `POST /api/code/phone/stop` | act | `{id}` | `{ok}` (interrupts the step; the session stays open) |
| `POST /api/code/phone/answer` | act | `{approval, choice, feedback?}` | `{ok}`; 403 for a yes on a Mac-only card; 404 for a card that isn't Eden Code's or is gone |
| `POST /api/code/phone/mode` | act | `{id, mode}` | `{ok, said}`; 400 unless `mode` is `ask` or `edits` |
| `POST /api/code/phone/model` | act | `{id, ref}` | `{ok, said}`; 400 unless `ref` is on the list and has its key |
| `POST /api/code/phone/new` | act | `{directory, prompt, mode?, model?, isolated?}` | `{ok, id}`; `mode` `ask` (default) or `edits`, always named |
| `POST /api/code/phone/land` | act | `{id}` | `{ok, said: "Confirm on its card."}`; 409 while its sessions work; 403 when what it would commit looks like a secret |
| `POST /api/code/phone/discard` | act | `{id}` | `{ok, said}`; 409 while its sessions work |
| `POST /api/code/phone/unpin` | act | `{}` | `{ok}` |
| `GET /api/code/phone/changes` | read | `id, view?, path?` | the Changes pane's payload (`code_hunks.payload`: files, hunks with `id`, `n`, `lines`, `kept`; totals) |
| `POST /api/code/phone/hunk` | act | `{id, hunk \| hunks, action, view?}` | `{ok, said, changes}`; `action` `keep`, `unkeep` or `undo`; `hunks` (≤ 200) is Undo all |
| `POST /api/code/phone/comments` | act | `{id, comments: [{path, line, side?, excerpt?, text}]}` | `{ok}`; one message, worded as the pane's (`code_api.comment_message`) |
| `GET /api/code/phone/receipts` | read | `id, tail?` | `{id, receipts: [{i, at, text, receipt}]}` (newest last, no pictures) |
| `POST /api/code/phone/steer` | act | `{id, text}` | `{ok, steered}`; into the running step (queued when it can't take it) |
| `GET /api/code/phone/todos` | read | | `{cards: [{id, project, directory, title, prompt, model, mode, state, task_id, untrusted}], queues}` |
| `POST /api/code/phone/todo_start` | act | `{card}` | `{ok, id}`; 403 when it would start in Auto or Bypass (its mode, or the default) |
| `GET /api/code/phone/usage` | read | | `{today, day_cap, recent: [{day, total, turns}], by_project, windows}` |

- **Summary**: `{id, title, project, status, mode, mode_label, model, cost_usd, updated_at}`; `status` is
  `working | needs_you | done | failed | idle | resting` (`companion_api.session_status`).
- **Card**: `companion_api.public_approval` (`id, question, detail, choices, source, task_id?, ask_kind?,
  options?, multi?, free_choices?`) plus `mac_only` (only `deny` is taken from the phone) and `copy` (the
  isolated copy's slug, for a Land or Discard card the phone put up).
- **Run** (Exterminator Mode): `{id, project, state, why, round, rounds, step, spent, spend_cap, task_id,
  found, fixed, open, landed}`.
- **View**: `{id, title, project, status, doing, mode, mode_label, model, model_label, live, todos, cards,
  copy: {branch, into, busy} | null, next, seen, v, entries, changed, more}`.

**The live transcript is a long poll.** Ask with what you have: `after` = the last `next`, `seen` = the last
`seen`, `v` = the last `v`, and `wait` (seconds, at most 25). The answer comes at once when there is anything
new (an entry after `after`, an entry up to `after` that changed since `seen`, or a different `v`: the
streamed words, the status, a card, the mode, the model, the to-dos, the copy), else when something moves, else
when `wait` is up. `entries` are new (in order, at most 200; `more` true means ask again at once); `changed`
are ones sent before whose step's outcome came in since (`tasks._tool_result` marks them `updated`: the
round 2 fix, so a step never stays "running" on the phone): replace them by `i`. `live` is the reply being
written (cleared when its entry comes). At most three of one phone's requests wait at once; more answer at
once. Entries are `companion_api._entry`'s: `{i, role: user | assistant | tool | note, text, at, uuid?}`,
4,000 characters, tool output summed up to its first lines, every one already through the session's
redactors.

**The handoff push** (APNs, the `jarvis` key): `{kind: "code_done", id: "handoff:<id>", task_id, handoff:
true, link: "jarvis-companion://code/<id>", url: "https://<mac>.local:8765/code/#s=<id>" | "", at}`. Kind
`code_done` because today's app (`Destination(push:)`) opens a session from a code push; `handoff` tells the
new screen it's a handoff, not a finish.

## Security rules (what the API enforces, whoever calls it)

- **Never Bypass permissions from this API.** New sessions start in Manual or Accept edits, named every
  time, so a project whose default is Bypass doesn't start in it; a mode switch is to one of those two. Plan,
  Auto and Bypass set on the Mac show as they are and can't be picked. The iPhone app's own path into Bypass
  (`/api/code/action` `mode` and `/api/code/new`, behind the app's Face ID: audit S11) is unchanged and is
  not this API's.
- **Mac-only cards**: a card `code_touchid.mac_only` marks (Touch ID, a risky step's, a tap-only one) and a
  Land card that warns of secrets take a "no" from the phone, never a yes.
- **Land and Discard** go through `code_isolation`'s own cards (answered on the phone or the Mac); Land is
  refused first while the copy's sessions work, or when `secret_scan` finds something in what it would
  commit (the Mac's card lists them; landing that is for the Mac).
- **Outside text**: everything from a session or a card is text to the client. The page puts it in with
  `textContent` only, under `default-src 'none'; script-src 'self'` (no inline script), `no-referrer`, no
  framing; ``` fences become `<pre>` blocks, still as text. The token is never in an address.
- Every action is in the companion's audit log (Settings › iPhone & Watch), by device, never its words.

## Eden Code for iPhone (built 2026-10-16, its own App Store app)

`companion/EdenCode` (target `EdenCode`, bundle `com.askeden.jarvis.edencode`, team 8CV4X23Y2T), with its widgets
(`EdenCodeWidgets`: a status widget and the Live Activity) and tests (`EdenCodeTests`). It reuses the companion's
`Shared` (API client, pinning, models, Live Activity attributes) and `iOS/Account`'s router and relay tunnel (the relay
works when this iPhone is signed in to the Eden account in the Eden app: the two apps share the App Group's keychain).
It pairs on its own (its own device token), with several Macs. Screens: Sessions (by project, status dots, Needs you,
the handoff pin, Exterminator runs, usage), Inbox, Queue (to-dos, Start), Settings, a session (live long poll, steps,
Read aloud, Eden chat's composer: attach, mode, model, dictate, send, steer, stop), approvals (Face ID before a
command or an always-allow; Mac-only cards take only a no), Changes (receipt, Keep / Undo / line comments, Undo all,
Open pull request), New session. Debug launch arguments (`EdenCode/Model/Fixtures.swift`): `-EDENCODEFixtures YES`
shows sample data; `-EDENCODEServer host:port -EDENCODECode 123456` pairs with a test server.

## The native iPhone screens (after App Review)

Same API; the app already pairs, pins the certificate and has the relay. Build in `companion/iOS`:

1. **Sessions tab (Eden Code)**: `GET /home` on appear and every 5 s while visible (or on the push). Rows:
   title, status chip (`needs_you` badges the tab, as `codeNeedsYou` does now), project · model · mode. A
   "From your Mac" banner for `pinned`; a "Waiting on you" section of `attention` cards; an Exterminator
   section (`exterminator`: "Round 2 of 3 · fix · 4 found, 1 fixed · $1.50 of $10.00", tap opens its session).
2. **Session screen**: the long poll in a `Task` while on screen (cancel on disappear; back off 1, 2, 4 … 30
   s on errors). A `List` of entries keyed by `i`, `changed` replacing in place, `live` as a last row with a
   typing look; VoiceOver: the list isn't a live region, a separate status line says "Working: Running tests"
   / "Finished". Toolbar: model `Menu` from `options.models` (`needs_key` disabled with "needs a key on the
   Mac"), mode `Menu` (Manual, Accept edits; Bypass stays behind the existing Face ID path until S11 lands),
   Stop (enabled while `working`). Cards inline, Mac-only ones with only their no and "Answer on your Mac".
   Isolated-copy bar with Land / Discard (a confirmation dialog, then the card). Composer at the bottom with
   the photo picker the app already has (`/api/code/send` takes pictures; `/api/code/phone/send` is text).
3. **New session sheet**: project picker (`options.projects`), prompt, mode (Manual / Accept edits), model,
   isolated copy toggle; `POST /new`, then push the session screen with the `id`.
4. **Handoff**: in the notification handler, `kind == code_done && handoff == true` → open the session screen
   (today's `Destination(push:)` already does via `task_id`); on launch, `home.pinned` newer than the last one
   opened opens it once, as the page does.
5. **Later, with S11**: a Secure Enclave key registered at pairing, the Mac's challenge signed after Face ID,
   for Bypass and the Mac-only cards from the phone; until then the API keeps them on the Mac.

## Known limits

- The page is served with the Mac's own certificate: Safari warns once (compare the fingerprint the pane
  shows). A Home Screen web app keeps working after that on iOS; if it doesn't, open it in Safari first.
- No Web Push for the page: the handoff push reaches the iPhone app. A page-only phone gets the pin (it opens
  the session the next time the page is open) but no notification.
- The page doesn't upload pictures yet (the native app does).
- The pin is in memory: it ends when Eden quits.
