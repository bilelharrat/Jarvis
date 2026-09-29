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
**Pair a phone** for a six-digit code (single use, five minutes; five wrong tries lock
pairing for five minutes).

On the iPhone: pick the Mac from the list (once the Mac advertises itself over Bonjour;
see below) or type its address — `192.168.1.20`, `my-mac.local`, `100.x.y.z` (Tailscale),
with `:port` if it isn't 8765 — then the code. The token goes into the Keychain (this
device only) and is never logged. The Watch picks the pairing up from the iPhone
automatically; **Settings › Send pairing to Watch** pushes it again.

Unpair (Settings) forgets the Mac on the iPhone and the Watch. To shut a phone out for good,
also remove it on the Mac under Settings › iPhone & Watch; the app notices (401) and goes
back to pairing.

Traffic is plain HTTP, like the web companion: fine at home, use Tailscale on shared Wi-Fi
or away from home. App Transport Security allows plain HTTP only to local addresses (IPs,
`.local` names), so use the Mac's Tailscale IP (`100.x.y.z`), not its `…ts.net` name, or an
`https://` address from Tailscale Serve. The Watch talks to the same address itself (through the iPhone, or
over Wi-Fi/cellular). watchOS has no Tailscale app, so a 100.x address on the Watch
depends on its traffic going through an iPhone that has Tailscale on; at home the Mac's
LAN address or `.local` name is the safer choice for the Watch.

## What the Mac needs

- **Let my phone connect** on (the companion server on port 8765). Nothing else is
  required: the apps use the existing `/api/pair`, `/api/state`, `/api/ask`,
  `/api/approve`, `/api/command` and `/api/say`.
- **Bonjour** (built in): while the companion is on, the Mac advertises `_jarvis._tcp` on
  its port as "J.A.R.V.I.S. on <LocalHostName>", with a TXT record
  `host=<LocalHostName>.local`, so it shows up in the pairing list and the iPhone stores a
  stable host name instead of the current IP (`remote.Advertiser`).

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
`jarvis.remote.create_remote_app(fake_hub, Devices(tmp))` on port 8766 works (never point
tests at the real Jarvis on 8765). The UI test (`UITests/`) drives the whole flow by
typing and tapping against such a server — pairing, an approval ("Email Pepper…" must
come back with Send / Don't send), the reply, quick actions, routines, settings, unpair:

```sh
TEST_RUNNER_JARVIS_TEST_SERVER=127.0.0.1:8766 TEST_RUNNER_JARVIS_TEST_CODE=123456 \
  xcodebuild -project JarvisCompanion.xcodeproj -scheme JarvisCompanion \
  -destination 'platform=iOS Simulator,name=iPhone 17' test
```

## Layout

```
project.yml                 XcodeGen spec (targets, Info.plist keys, schemes)
Shared/                     both apps
  JarvisAPI.swift           async/await client + JarvisError (the messages people see)
  Models.swift, Decoding.swift   lenient Codable models for the API's JSON
  PendingRequest.swift      follows one request until the Mac has answered it
  MacAddress.swift          "mac.local:8766" → http://mac.local:8766
  PairingStore.swift        Pairing + Keychain
  WatchLink.swift           what the iPhone hands the Watch
  ReactorView.swift, Theme.swift, DebugLaunch.swift
iOS/                        AppModel (state, polling), Transcript, Services/ (speech,
                            voice, Bonjour, Watch bridge, haptics), Views/
Watch/                      WatchModel, WatchSessionBridge, Views/
Tests/, UITests/            unit tests; the end-to-end UI test
```
