# J.A.R.V.I.S. companion (iPhone + Apple Watch)

Native SwiftUI apps for Jarvis: Apple's craft with Stark's materials (iOS 26+, watchOS 26+).
SF Pro and Apple's layouts; every surface Liquid Glass (`glassCard`, `GlassList`/`GlassForm`)
over a dark night lit by the arc reactor (`SpaceBackground`); reactor blue as the one accent,
Stark gold for what needs you, telemetry in small SF Mono caps (`HUDText`); the reactor is
a glass sphere in a fine-ticked bezel (`ReactorView`). Always dark. Paired with Jarvis on the Mac they reach everything it does;
with no Mac (or when it can't be reached) the iPhone runs Jarvis itself on the owner's own
Claude API key (see Jarvis on iPhone).

- **Tabs:** Jarvis (the orb, the conversation, approvals, a glass composer with the
  microphone and a + menu, where up to four photos or screenshots go with a question:
  Photos, Take Photo, Paste Image), Today (what needs you, weather, calendar, reminders, the Mac),
  Code (Jarvis Code, when paired) and Library (everything else, grouped like Settings).

- **iPhone** (`iOS/`): pair with the Mac (its QR code, or Bonjour / typed address +
  six-digit code), the reactor as tap-to-talk (on-device speech recognition, ends on
  ~1.2 s of silence or a second tap), a live You / JARVIS transcript, approval cards, quick
  actions (Brief me, What's next?, Take notes / Stop notes, Routines, Stop), a status strip
  (Mac state, next event, weather, background tasks, model), spoken replies in Jarvis's
  own voice (`/api/say`), the Jarvis hub (Jarvis Code, conversations, routines, what you
  missed, spending), and Settings (Mac address, Speak replies, notifications, sensors,
  send to Watch, Unpair). Around the app: notifications you can answer, widgets, Live
  Activities, Siri and Shortcuts, the share sheet.
- **Watch** (`Watch/`): gets the Mac's address, token and certificate fingerprint from the
  iPhone over WatchConnectivity, then talks to the Mac on its own. Reactor → dictation →
  reply, spoken (Digital Crown scrolls, haptic on reply), big Allow / Deny approvals and
  No, because…, Brief me, Stop, complications.
- **Shared** (`Shared/`): API client with certificate pinning, lenient Codable models,
  address parsing, Keychain, the outbox, the reactor view, theme.
- **Extensions**: widgets and the Live Activities' views (`Widgets/`), complications
  (`WatchWidgets/`), the share sheet (`Share/`).

Bundle IDs: `com.bshventures.jarvis.companion` and
`com.bshventures.jarvis.companion.watchkitapp`, plus three extensions (see On a device
and TestFlight); team 9ZSY5R8A5C, automatic signing. iOS 26+, watchOS 26+.

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

On a busy Mac, `test` can fail with "The test runner hung before establishing
connection": the process Xcode waited on was the app launched the ordinary way, not as
the test host, so it ran like the real app, talking to the Mac the Simulator is paired
with. `build-for-testing` followed by `test-without-building` gets through.

## On a device and TestFlight

Simulator builds need nothing. For a device or TestFlight, open the project in Xcode
signed in with team 9ZSY5R8A5C; automatic signing registers each target's bundle ID and
capabilities on the first device build (or add them under Identifiers in the developer
portal):

| Target | Bundle ID | Capabilities |
|---|---|---|
| JarvisCompanion (iPhone) | `com.bshventures.jarvis.companion` | Push Notifications, App Groups, HealthKit |
| JarvisCompanionWatch | `com.bshventures.jarvis.companion.watchkitapp` | App Groups |
| JarvisWidgets | `com.bshventures.jarvis.companion.widgets` | App Groups |
| JarvisWatchWidgets | `com.bshventures.jarvis.companion.watchkitapp.widgets` | App Groups |
| JarvisShare | `com.bshventures.jarvis.companion.share` | App Groups |

- The App Group is `group.com.bshventures.jarvis.companion`: the shared container and the
  Keychain access group for the pairing (no Keychain Sharing capability needed).
- `aps-environment` is `development` in the entitlements (the archive is signed for
  development first); the App Store Connect export signs it as `production`, and the app
  tells the Mac which (`sandbox` from Debug builds, `production` from Release).
- Pushes also need an APNs key on the Mac: in the developer portal, Keys › + › Apple Push
  Notifications service; paste the `.p8`'s contents, its Key ID, the team and the iPhone
  app's bundle ID into the Mac's Settings (iPhone & Watch).
- Background Modes (remote notifications, background fetch), Live Activities and the App
  Shortcuts need nothing from the portal: they're Info.plist keys, and App Intents don't
  use the Siri capability.
- HealthKit asks for read access only when the daily health summary is turned on. App
  Review (the App Store, or TestFlight beyond internal testers) will want a privacy
  policy URL, since the app reads Health data and location.
- CarPlay isn't built: a CarPlay app needs an entitlement Apple grants on request, for
  certain kinds of app only.

## TestFlight

What the project already carries for App Store Connect:

- **Version and build.** `MARKETING_VERSION` in `project.yml` is the version testers see;
  `CURRENT_PROJECT_VERSION` is the build number, which `scripts/archive.sh` sets to the time
  (`date +%Y%m%d%H%M`) for each upload, since every upload needs a new one. The app, the
  Watch app and all three extensions read both, so they always match.
- **Privacy manifests.** Each target has a `PrivacyInfo.xcprivacy`: no tracking, no
  tracking domains, no data collected, and the one required-reason API the code uses,
  UserDefaults (the app's own settings, reason CA92.1; no App Group suite). Nothing reads
  file timestamps, the boot time or disk space. "Collected" is Apple's word for data that
  reaches the developer or its partners: everything the app sends (requests, answers to
  cards, the Health summary, location, photos, shares) goes only to your own Mac, over the
  pinned connection. (To declare Health and location anyway, add them to each manifest as
  App Functionality, not linked, no tracking, and answer App Privacy the same way.)
- **Export compliance.** `ITSAppUsesNonExemptEncryption` is `NO` in every Info.plist: the
  app uses only Apple's encryption (HTTPS through URLSession, the Keychain,
  WatchConnectivity), and pinning takes a certificate's SHA-256, a hash, not encryption.
  App Store Connect doesn't ask about encryption for each build.
- **Icons.** One opaque 1024×1024 PNG each for the iPhone and the Watch app (no alpha, as
  the App Store needs); Xcode makes every other size from it. The extensions show the
  app's icon.
- **Push.** The App Store Connect export signs `aps-environment` as `production` (the
  script checks), and a Release build tells the Mac it's `production`.

Upload (never from a Simulator build):

```sh
companion/scripts/archive.sh --dry-run    # print what it runs
companion/scripts/archive.sh              # xcodegen, archive, export and upload
```

It needs xcodegen and Xcode signed in (Settings › Accounts) with an Admin or App Manager
in team 9ZSY5R8A5C. With an App Store Connect API key instead:
`ASC_KEY_PATH=~/keys/AuthKey_ABC123.p8 ASC_KEY_ID=ABC123 ASC_ISSUER_ID=<issuer> companion/scripts/archive.sh`.

In App Store Connect (appstoreconnect.apple.com):

1. **The app record, once.** Apps › + › New App: iOS; a name (it must be unique on the
   App Store; the Home Screen keeps saying J.A.R.V.I.S. whatever the record is called);
   English (U.S.); the bundle ID `com.bshventures.jarvis.companion` (automatic signing
   registers it on the first device build or archive); a SKU such as `jarvis-companion`.
   The Watch app comes inside the iPhone app: it has no record of its own.
2. **Internal testers.** People on your App Store Connect team (Users and Access, up to
   100). TestFlight › Internal Testing › + a group, add them; each build reaches them once
   Apple has processed it (an email says so). No review.
3. **External testers** (anyone with an email address). TestFlight › Test Information:
   a beta description, a feedback email, contact details and a **privacy policy URL**,
   which Beta App Review needs because the app reads Health data and location. The policy
   should say what the app sends to your Mac (requests, approvals, the Health summary,
   location, photos, shared items, contact lookups and calendar events), that none of it goes to BSH Ventures, and that
   Jarvis on the Mac may send requests to Claude under the owner's own account. In the
   review notes, say the app does nothing until it's paired with Jarvis on the tester's
   own Mac, and attach a short screen recording. Then External Testing › + a group › add the
   build: the first build of each version goes to Beta App Review (about a day).
4. **Export compliance** is answered by the Info.plist key above: no question per build.
5. For the App Store later: App Privacy › "Data Not Collected", as the manifests say.

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

## More from your Mac

`/api/state` lists under `features` the groups this Mac answers (`memory`, `goals`,
`timers`, `reminders`, `markets`, `tasks`, `music`, `shortcuts`, `switches`, `journal`,
`meetings`, `research`, `invoices`, `prefs`); a route a Mac doesn't have answers 404, and
the phone hides it. Reads use the `read` budget; anything that changes or runs something on
the Mac uses `act`. Every answer is a JSON object, lists under `items`.

- **Memory**: `GET /api/memory` (`?q=` searches) with the people and promises it knows;
  `POST /api/memory/add` `{text, kind?}`, `POST /api/memory/forget` `{id}` (by id only).
- **Goals**: `GET /api/goals`, ranked, with constraints.
- **Timers**: `GET /api/timers` (`ends_at`, seconds `left`, ringing);
  `POST /api/timers/cancel` `{id}`.
- **Reminders** (Apple Reminders on the Mac): `GET /api/reminders` (`available` false when
  the Mac hasn't allowed it: the phone never puts the question up there);
  `POST /api/reminders/add` `{title, due?, list?, notes?, priority?}`,
  `POST /api/reminders/complete` `{id}` (an open one it listed).
- **Markets**: `GET /api/markets`: what the Mac last fetched, the watchlist and price alerts.
- **Background tasks**: `GET /api/tasks`; `POST /api/tasks/stop` `{id}` (a running one).
- **Music**: `GET /api/music` (now playing, playlists while Music is open);
  `POST /api/music` `{action: play|pause|next|previous|playlist, name?}`.
- **Shortcuts**: `GET /api/shortcuts`; `POST /api/shortcuts/run` `{name}` (a listed name).
- **Switches**: `GET /api/switches`; `POST /api/switches/set` `{name, on}` for dark mode and
  Bluetooth (never Wi-Fi: it may be how the phone reaches the Mac).
- **Journal, meetings, research**: `GET /api/journal`, `/api/meetings`, `/api/research`
  (newest first, with a preview), and one by the id its list gave:
  `/api/journal/item?day=`, `/api/meetings/item?id=`, `/api/research/item?id=`.
- **Invoices**: `GET /api/invoices`: clients and recurring invoices.
- **Settings**: `GET /api/prefs` and `POST /api/prefs` `{changes: {...}}` for a short
  allowlist (language, names, persona, humor, voice, hands-free, briefing, heads-ups,
  quiet hours); any other key refuses the whole change.

## Apple Watch

The Watch app gets its pairing from the iPhone and then talks to the Mac by itself, over
the same pinned connection, polling only while it's in front (wrist raised).

- **Talk**: tap the reactor, then dictate or scribble. The reply shows (the Digital Crown
  scrolls) and is spoken: in Jarvis's own voice when the Mac can make it
  (`POST /api/say`, a WAV), else in the Watch's own voice, in the reply's language
  (Chinese or English). Only replies to what was asked on the Watch are spoken, and only
  while the app is frontmost: a reply finishes with the wrist down, and stops when the
  app leaves, on Stop, or with **Speak replies** (at the bottom) off.
- **Approvals**: Allow, Deny and any choices between, plus **No, because…**, dictated or
  scribbled, which sends `deny` with the reason as `feedback` (a plan's own no when the
  card has no `deny`), as on the iPhone.
- **Brief me** and **Stop**, complications (see Widgets and complications), and the
  iPhone's notifications with their actions (see Notifications).

No model calls on the Watch. Each spoken reply is one `/api/say` clip, which uses the
voice set up on the Mac (a paid voice there costs what one clip costs; the Mac caps a clip
at 1,500 characters and makes a few at a time, and the Watch uses its own voice when the
Mac is busy).

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

## Jarvis on iPhone

`iOS/Brain/`: Claude's Messages API over HTTPS (`ClaudeClient`, streamed, its blocks kept
exactly as they arrive), the phone's own tools (`PhoneTools`: Calendar and Reminders through
EventKit, Contacts, weather from Open-Meteo, location, travel times and places from MapKit,
timers as time-sensitive notifications, the Music library, Apple Home, the Health summary,
facts it remembers, and `ask_mac` while paired), plus Anthropic's web search and fetch.
Texts, emails and calls are only prepared: the system composer or a Call button finishes
them with a tap (`ActionCards`).

- The key is the owner's own (Settings › Jarvis on iPhone), kept in the Keychain, sent only
  to api.anthropic.com. Model: Claude Opus 5.5 by default (Sonnet 5.5, Haiku 4.5 offered),
  effort low for voice-speed answers, `fallbacks: "default"` for declined requests.
- **Who answers** (paired only): Automatic (the Mac when it can be reached, else the
  iPhone), Always my Mac, Always this iPhone. Unpaired, the iPhone always answers.
- Siri's Ask Jarvis and Brief me fall back to it too, when there's no Mac or it can't be
  reached (`IntentRunner.phoneAnswer`).
- Replies are spoken in Jarvis's voice from the Mac when it's there, else the iPhone's best
  installed voice (British, Premium or Enhanced first).

## “Hey Jarvis”, the side button and the Action Button

iOS gives third-party apps no always-on wake word and keeps the side button for Siri
(outside Japan), so Jarvis is reachable every way iOS allows (Library › “Hey Jarvis” walks
through each):

- **In the app** (`WakeWordListener`): on-device speech recognition listening for the name
  while the app is open; optionally on in the background (audio background mode, the orange
  dot) until a call, Siri or another app takes the microphone. "Hey Jarvis, what's next?" in
  one breath sends the request straight away.
- **Anywhere, Lock Screen included:** Vocal Shortcuts (Settings › Accessibility › Vocal
  Shortcuts) trained on "Hey Jarvis" runs the **Talk to Jarvis** shortcut.
- **Talk to Jarvis** (`Activity/TalkToJarvisIntent.swift`) opens the app listening: an App
  Shortcut ("Hey Siri, talk to Jarvis", so holding the side button and saying it works), a
  Control (`TalkToJarvisControl`) for Control Center, the Lock Screen and the Action Button,
  and Back Tap through Shortcuts. `jarvis-companion://listen` does the same.

## More from the Mac's features

Library lists the Mac's feature screens that `/api/state` names in `features` (memory,
goals, timers, reminders, markets, background tasks, music, Shortcuts & Home, Mac
controls, journal, meeting notes, research, invoices; `MacFeatureView`), and Settings ›
Your Mac › Jarvis on Your Mac edits the preferences the Mac allows (`MacPrefsView`).

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

## Share sheet

**J.A.R.V.I.S.** in the share sheet sends a link, some text, a photo or a file to the Mac
(`POST /api/share`), with an optional line for Jarvis ("Summarize this", or anything).
Files and photos land in `~/Documents/Jarvis/Inbox/` on the Mac; with a line, the Mac runs
it as a silent request about the item, and the answer lands in the app. Shared content is
data to Jarvis, never instructions. Files go up to the Mac's 25 MB; a photo too big for
that, or of a kind the Mac doesn't read as a picture (TIFF, RAW, BMP), goes as a JPEG. The
preview is a thumbnail and the upload's base64 is written a slice at a time, since a share
extension has little memory. When the Mac can't be reached it waits in the outbox (the data
in a file beside it) and the app sends it within the hour. The extension uses the pairing
from the App Group's keychain group.

## Sensors (all off until turned on in Settings)

- **Location**: iOS's low-power significant-change updates (about every 500 m; a fix goes
  at most every five minutes unless you've moved 400 m) give the Mac a recent position for
  travel times, and Home and Work (set to "here" in Settings) are 150 m regions watched by
  `CLMonitor`, so arriving and leaving are sent as events (`POST /api/location` with
  `event` and `region`), even when the app isn't open. "Always" location is needed for
  arrivals; Settings says so. Kept in the outbox when the Mac is away (the latest fix
  replaces older ones; arrivals each count).
- **Health**: a read-only daily summary from Apple Health, a few times a day at most:
  yesterday's steps, resting heart rate and workouts, and last night's sleep (asleep
  stages only, 6 pm to noon, overlaps between iPhone and Watch counted once), plus today
  so far (`POST /api/health`). Nothing is written to Health.
- **Show Jarvis** (camera): take a photo, ask about it (`POST /api/photo`, JPEG at most
  2048 px); the answer shows and is spoken. A photo goes only when you send it. (Not kept
  for later: you're waiting for the answer.)
- **Point and ask** (camera, live): a live view in Show Jarvis with "What's this?", "Read
  this", "Translate this" or your own question. The camera shows only on the screen; each
  question takes one still frame and sends it as a photo. Never a video stream; the camera
  stops when the view closes or the app leaves the screen.
- **Contacts**: when the Mac's Contacts don't have someone, its `phone_contact` tool asks
  the phone: the name appears in `/api/state` (`phone_asks`), and a silent push (no name in
  it) wakes a closed app. The phone looks that one name up and answers
  (`POST /api/contacts/answer`) with at most five people: name, job, company, numbers and
  emails. The address book never leaves the phone; the Mac keeps an answer in memory ten
  minutes.
- **Calendar**: for calendars that live only on the phone, the next 14 days of events
  (title, times, place, calendar name; never notes, invitees or links) go to the Mac
  (`POST /api/calendar`) every 30 minutes while it's on (while the app is open and on
  background refresh), and when its `phone_calendar` tool asks for a fresh copy. The Mac
  keeps the latest copy only and forgets it when this is turned off.
- **Notifications** aren't a sensor: iOS doesn't let an app read other apps'
  notifications. Settings says so and points to Focus filters and Shortcuts automations
  (which can run "Ask Jarvis").

Which of contacts and calendar are on is told to the Mac (`POST /api/sensors`); it answers
neither for a phone that hasn't turned it on. Unpairing turns every sensor off.

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
| `-JARVISTestReason "Use the draft"` | (Watch) answer the first approval card with No, because… and this reason |
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
  Speakable.swift           a reply as it should sound, and the language to say it in
  MacAddress.swift          "mac.local:8766" → https://mac.local:8766
  PairingStore.swift        Pairing + Keychain
  WatchLink.swift           what the iPhone hands the Watch
  ReactorView.swift, Theme.swift, DebugLaunch.swift
iOS/                        AppModel (state, polling), Transcript, Intents/, Services/ (speech,
                            voice, Bonjour, Watch bridge, haptics), Views/, Views/Screens/
                            (the hub: Jarvis Code, conversations, routines, digest, spending)
Watch/                      WatchModel, WatchVoice (spoken replies), WatchSessionBridge,
                            WatchNotifications, WatchRefresh, Views/
Widgets/                    the iPhone widget extension (Home Screen, Lock Screen)
WatchWidgets/               the Watch complications extension
WidgetsCommon/              the timeline provider and the glances both extensions show
Activity/                   the Live Activity attributes and plan (app and widget extension)
Share/, ShareKit/           the share extension; reading and sending what was shared
Tests/, UITests/            unit tests; the end-to-end UI test
```
