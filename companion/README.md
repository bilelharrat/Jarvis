# J.A.R.V.I.S. companion (iPhone + Apple Watch)

Native SwiftUI companion apps for Jarvis on the Mac. They replace the phone web page
(`/` on the companion server) and the hand-made Watch shortcut, using the same small API.

- **iPhone** (`iOS/`): pair with the Mac (Bonjour or typed address + six-digit code), the
  reactor as tap-to-talk (on-device speech recognition, ends on ~1.2 s of silence or a
  second tap), a live You / JARVIS transcript, approval cards, quick actions (Brief me,
  What's next?, Take notes / Stop notes, Routines, Stop), a status strip (Mac state,
  next event, weather, background tasks, model), spoken replies in Jarvis's own voice
  (`/api/say`), and Settings (Mac address, Speak replies, send to Watch, Unpair).
- **Watch** (`Watch/`): gets the Mac's address and token from the iPhone over
  WatchConnectivity, then talks to the Mac on its own. Reactor → dictation → reply
  (Digital Crown scrolls, haptic on reply), big Allow / Deny approvals, Brief me, Stop.
- **Shared** (`Shared/`): API client, lenient Codable models, address parsing, Keychain,
  the reactor view, theme.

Bundle IDs: `com.bshventures.jarvis.companion` and
`com.bshventures.jarvis.companion.watchkitapp` (team 9ZSY5R8A5C, automatic signing).
iOS 17+, watchOS 10+.

## Build and run

The Xcode project is generated from `project.yml`; regenerate after adding or moving files:

```sh
cd companion
xcodegen generate
open JarvisCompanion.xcodeproj        # scheme JarvisCompanion (iPhone, embeds the Watch app)
```

Command line (Simulator):

```sh
xcodebuild -project JarvisCompanion.xcodeproj -scheme JarvisCompanion \
  -destination 'platform=iOS Simulator,name=iPhone 17' build
xcodebuild -project JarvisCompanion.xcodeproj -scheme JarvisCompanionWatch \
  -destination 'platform=watchOS Simulator,name=Apple Watch Ultra 4 (49mm)' build
xcodebuild -project JarvisCompanion.xcodeproj -scheme JarvisCompanion \
  -destination 'platform=iOS Simulator,name=iPhone 17' test   # unit tests; the UI test skips itself
```

On a device, run the JarvisCompanion scheme from Xcode with your iPhone selected; the
Watch app installs with it (or from the Watch app on the iPhone).

## Pairing

On the Mac: **Jarvis › Settings › iPhone & Watch › Let my phone connect**, then
**Pair a phone**. It shows a QR code and a six-digit code (single use, five minutes; five
wrong tries lock pairing for five minutes), and the short fingerprint of the Mac's
certificate (`a1b2 c3d4 e5f6 0718`).

On the iPhone, either:

- **Scan the pairing code** (top of the pairing screen, or the Camera app: the code is a
  `jarvis-pair://<host>:<port>?code=…&fp=…&name=…` link, and the app asks before using one
  it didn't scan itself). The fingerprint in the code is pinned before the first request,
  so the code only ever goes to the Mac that showed it.
- **Pair by hand**: pick the Mac from the list (Bonjour) or type its address —
  `192.168.1.20`, `my-mac.local`, `100.x.y.z` (Tailscale), with `:port` if it isn't 8765.
  The app connects, reads the certificate the Mac presents (sending nothing) and shows its
  short fingerprint next to the code field; compare it with the Mac's Settings, type the
  code and tap **Pair with Mac** (trust on first use). A fingerprint that disagrees with
  the one the Mac announced over Bonjour gets a warning; the announcement is never trusted.

The pair request carries the pinned fingerprint, and the Mac refuses one that isn't its
own (409). The token and the fingerprint go into the Keychain (this device only, in the
App Group's access group so the share extension can use them) and are never logged. The
Watch picks the pairing up from the iPhone automatically, fingerprint included;
**Settings › Send pairing to Watch** pushes it again. Settings shows the pinned
fingerprint under Your Mac.

Unpair (Settings) forgets the Mac on the iPhone and the Watch. To shut a phone out for good,
also remove it on the Mac under Settings › iPhone & Watch; the app notices (401) and goes
back to pairing. A pairing made before the companion spoke TLS is dropped at launch (its
token only ever travelled in the clear), with the old address filled in to pair again.

**Transport.** Everything is HTTPS to the Mac's self-signed certificate (ECDSA P-256),
trusted only by its SHA-256 fingerprint: a per-request URLSession delegate uses the
credential only when the presented certificate is exactly the pinned one, and refuses
anything else (a different certificate reads as "This isn’t your Mac"). One URLSession per
pinned certificate, so a connection trusted under one pin is never reused under another.
The host name doesn't matter, only the pin, so the Mac's `.local` name, its LAN IP, its
Tailscale IP or MagicDNS name all work. App Transport Security needs no exception at all:
it honours the pinned trust decision (TLS 1.2+, forward secrecy, a P-256/SHA-256
certificate), so `Info.plist` no longer allows plain HTTP anywhere. The Watch talks to the
same address itself (through the iPhone, or over Wi-Fi/cellular). watchOS has no Tailscale
app, so a 100.x address on the Watch depends on its traffic going through an iPhone that
has Tailscale on; at home the Mac's LAN address or `.local` name is the safer choice.

## Beyond the conversation

The grid button in the top bar opens **Jarvis**, a hub like the Settings app (the Routines
quick action and the Jarvis Code module in the status strip open it at their place, and
`jarvis-companion://…` links from widgets, Live Activities and notifications open any of
it; links only ever navigate):

- **Jarvis Code**: sessions that need you, working, and earlier. A session shows its
  transcript's tail (fetched incrementally with `after`, bounded on the phone), its plan,
  the question it's waiting on — the card's own choices and **No, because…**, which sends
  `deny` with the reason (a plan's own no, keep planning, when it has no `deny`) — its
  changes (files, counts, hunks; files that may hold secrets listed without lines), a line
  to send it, and Stop (after a confirmation).
- **Conversations for you** (delegations): who with, the goal, where it stands; Stop after
  a confirmation.
- **Routines**: on/off, run now, change the time and days (0 = Monday, the Mac's way), and
  delete after a confirmation. A Mac without `/api/routines` gets the run-only list.
- **What did I miss**: the last day's texts, emails, calls and voicemails as the Mac
  summarized them, urgent first.
- **Spending**: today against the day's limit, the limits, and what was spent lately.

Every approval card (on Home too) has **No, because…**.

## Notifications

Right after pairing the iPhone asks to send notifications (Settings › Notifications can ask
again or open the system settings), registers for remote notifications, and gives the Mac
its device token (`POST /api/push/register`, `sandbox` from Debug builds, `production`
from Release/TestFlight, with the bundle id) — again whenever the token or the Mac
changes, or `/api/state` says `push.registered` is false. Unpairing unregisters.

The app registers the contract's categories at launch: `JARVIS_APPROVAL` (Allow / Not now
/ No, because…), `JARVIS_CODE_APPROVAL` (Yes / No / No, because…) and `JARVIS_HEADSUP`.
An action goes to `POST /api/approve` from the background — the app isn't opened — with
the answer mapped from the push's own `choices` (see ApprovalResponse), inside a
background task and a 20-second limit. Allow needs an unlocked phone (or a Watch on the
wrist); Not now and No, because… don't. If the Mac can't be reached and the card may still
be open (the Mac waits five minutes), the notification comes back to try again. Tapping a
notification opens where it leads (a Jarvis Code session, conversations, Home). The badge
counts approvals waiting.

On the Watch, iPhone notifications appear by themselves with the same actions (No,
because… by dictation or Scribble). The Watch app registers the same categories and, when
an action is delivered to it, answers the Mac itself with the pairing the iPhone gave it.

## Siri, Shortcuts and the Action Button

App Shortcuts, so they're in Siri, Shortcuts, Spotlight and the Action Button with no
setup ("Jarvis" is an alternative app name, so "Ask Jarvis" works):

| Shortcut | Does | Says back |
|---|---|---|
| **Ask Jarvis** (asks for the request) | `POST /api/ask` | the reply (markdown out, a long one cut at a sentence) |
| **Brief me** | asks for the briefing | the briefing |
| **What did I miss** | `GET /api/digest` | how many, and the top three |
| **Stop Jarvis** | `stop` | "Stopped." |
| **Start / Stop meeting notes** | `meeting_start` / `meeting_stop` | a line |

They run in the background (the app doesn't open) over the pinned pairing, and return
their words as the result too, for Shortcuts. Siri speaks the reply when asked by voice.
Siri waits about 25 seconds: past that the Mac carries on and the answer lands in the app.
A request that needs a yes says so (the card is on the phone); an unreachable Mac keeps a
question for later (the outbox); stop and meeting notes are never kept.

## Widgets and complications

- **Jarvis** (small, medium; Lock Screen circular, rectangular, inline): whether the Mac
  is there, what needs your OK (the question itself only when unlocked), what's next.
- **Jarvis Code** (small, medium; Lock Screen circular, rectangular): sessions that need
  you and the ones working; a session opens where it is.
- **Apple Watch complications** (circular, rectangular, inline, corner): the same glance.

The widgets never talk to the Mac. The app writes a small snapshot into the App Group
container (`WidgetSnapshot`) whenever the Mac answers — in front, on background app
refresh (about every twenty minutes, as iOS allows), and when a push wakes it — and
reloads the widgets only when what they show changed (the Mac thinking or speaking isn't
news for a widget, and reloads are budgeted). When the Mac can't be reached they say so,
with when it was last heard. The Watch keeps its own snapshot: from its own visits to the
Mac, its own background refresh (about every half hour), and what the iPhone passes on
when a complication is on the face. No model calls anywhere: `/api/state` only.

## Live Activities

On the Lock Screen and in the Dynamic Island (compact, minimal and expanded): a Jarvis
Code session working or waiting on you, a conversation held for you, a call, a video
summary. The app starts them in front, from `/api/state` (sessions working or needing
you; conversations, from `/api/delegations`, while the Mac says some are active) and from
a call or video-summary push that arrives while it's open; what needs you goes first, at
most three at once. Each activity's push token goes to the Mac (`POST /api/live/register`
with `"<kind>:<id>"`, the APNs environment and the bundle id), and the Mac updates it by
push with the contract's content state (`{title, status, detail, progress?, needsYou,
updatedAt}`) and ends it with `event: "end"`. The app updates and ends them too, from
every state it gets (also on background refresh): a finished session shows its last word
for ten minutes; a call ends when its outcome push comes. Unpairing ends them all.

## When the Mac can't be reached

Requests that still mean something later wait in an outbox on the iPhone (the App Group
container, so Siri and the share sheet add to the same queue): questions, the briefing,
running a routine, a share, a message to a Jarvis Code session, location and health. They
show in the conversation as "Waiting for your Mac" and in **Waiting to send** (from the
connection banner, or the hub), where one can be dropped. When the Mac answers again they
go oldest first — questions through the conversation, one at a time, so their replies show
and are spoken like any other — and anything still waiting after an hour is let go (and
the app says so). Stop, meeting notes and approvals are about the moment they're made, so
they fail plainly instead. Only requests that never reached the Mac are kept, so nothing
is sent twice.

## What the Mac needs

- **Let my phone connect** on: the companion server on port 8765, speaking TLS with its
  own certificate (the companion contract, `COMPANION_API.md`).
- **Bonjour** (built in): while the companion is on, the Mac advertises `_jarvis._tcp` on
  its port as "J.A.R.V.I.S. on <LocalHostName>", with a TXT record
  `host=<LocalHostName>.local` (plus `tls=1` and `fp=<short fingerprint>`, a hint only),
  so it shows up in the pairing list and the iPhone stores a stable host name instead of
  the current IP (`remote.Advertiser`).

## Trying it against a test server (Debug builds only)

Debug builds read a few launch arguments (see `Shared/DebugLaunch.swift`; none of this is
compiled into Release):

| Argument | Effect |
|---|---|
| `-JARVISResetPairing YES` | forget the pairing at launch |
| `-JARVISTestServer 127.0.0.1:8766` | pre-fill the Mac address (the Watch pairs with it directly) |
| `-JARVISTestCode 123456` | type this code and pair |
| `-JARVISTestAsk "What's next today?"` | send this as a typed request once connected |
| `-JARVISTestApprove allow` | answer the first approval card with this choice after 5 s |
| `-JARVISTestSpeak NO` | don't play spoken replies |

```sh
xcrun simctl launch booted com.bshventures.jarvis.companion \
  -JARVISResetPairing YES -JARVISTestServer 127.0.0.1:8766 -JARVISTestCode 123456
```

The Simulator reaches the Mac's `127.0.0.1`, so a throwaway server built with
`jarvis.remote.create_remote_app(fake_hub, Devices(tmp))` on port 8766, serving TLS with a
throwaway certificate, works (never point tests at the real Jarvis on 8765). With a test
code the app waits for the certificate check, then taps Pair itself. The UI test
(`UITests/`) drives the whole flow by typing and tapping against such a server — pairing
(comparing the fingerprint), an approval ("Email Pepper…" must come back with Send /
Don't send), the reply, quick actions, routines, settings, unpair:

```sh
TEST_RUNNER_JARVIS_TEST_SERVER=127.0.0.1:8766 TEST_RUNNER_JARVIS_TEST_CODE=123456 \
  xcodebuild -project JarvisCompanion.xcodeproj -scheme JarvisCompanion \
  -destination 'platform=iOS Simulator,name=iPhone 17' test
```

## Layout

```
project.yml                 XcodeGen spec (targets, Info.plist keys, schemes)
Shared/                     both apps
  JarvisAPI.swift           async/await client for the whole contract + JarvisError
  Pinning.swift             certificate fingerprints, the pinning delegate, sessions per pin
  PairingLink.swift         the Mac's jarvis-pair:// QR code
  Models.swift, CompanionModels.swift, Decoding.swift   lenient Codable models for the API's JSON
  JSONValue.swift           JSON request bodies
  Outbox.swift              requests kept while the Mac can't be reached, and sending them
  ApprovalResponse.swift    an answer (Allow, Not now, No because…) to the choice the Mac gets
  NotificationActions.swift the categories, and answering from a notification (iPhone and Watch)
  WidgetSnapshot.swift, SnapshotPublisher.swift   what the widgets show, kept in the App Group
  Destination.swift         places in the app and their jarvis-companion:// links
  PendingRequest.swift      follows one request until the Mac has answered it
  MacAddress.swift          "mac.local:8766" → https://mac.local:8766
  PairingStore.swift        Pairing + Keychain
  WatchLink.swift           what the iPhone hands the Watch
  ReactorView.swift, Theme.swift, DebugLaunch.swift
iOS/                        AppModel (state, polling), Transcript, Intents/, Services/ (speech,
                            voice, Bonjour, Watch bridge, haptics), Views/, Views/Screens/
                            (the hub: Jarvis Code, conversations, routines, digest, spending)
Watch/                      WatchModel, WatchSessionBridge, WatchRefresh, Views/
Widgets/                    the iPhone widget extension (Home Screen, Lock Screen)
WatchWidgets/               the Watch complications extension
WidgetsCommon/              the timeline provider and the glances both extensions show
Activity/                   the Live Activity attributes and plan (app and widget extension)
Tests/, UITests/            unit tests; the end-to-end UI test
```
