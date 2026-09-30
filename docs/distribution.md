# Giving J.A.R.V.I.S. to other people

`cd app && npm run dist` builds a J.A.R.V.I.S. anyone with an Apple-silicon Mac can download:
a disk image with the app in it, self-contained (no Xcode, uv, Python or repo needed),
signed with BSH Ventures' Developer ID and the hardened runtime, notarized by Apple and
stapled.

Your own install doesn't change: `npm run install-app` still runs the backend from the repo
with uv, and Python and web edits still need no rebuild.

## What testers need

- **An Apple-silicon Mac** (M1 or later). There is no Intel build.
- **macOS 14 Sonoma or later.** That is the highest minimum of the code the app carries:
  numpy 2.5, onnxruntime 1.30 and PyAV 18.1 ship arm64 wheels built for macOS 14 (Electron 44
  and the Claude engine need 13, Python 11). The build computes it from every Mach-O file's
  `LC_BUILD_VERSION` and writes it into `LSMinimumSystemVersion`. Apple's own speech
  recognizer (Settings › Listening) needs macOS 26 (SpeechAnalyzer); before 26, Whisper
  listens, as it does by default.
- **Their own Anthropic API key.** Anthropic's terms don't let another product sign its users
  in with their claude.ai subscription, so the app people download signs in with the user's
  own API key: console.anthropic.com › API keys, pasted once in Setup's Claude step. Claude
  is then billed to their Anthropic account, and the key stays in their Keychain (JARVIS
  and Jarvis Code read it through an apiKeyHelper; it's never in an environment variable or
  a file).
- **Permissions**, as macOS asks for them (Setup's Permissions step lists them with their
  state): Microphone, Calendars, Contacts, Location, Automation (Mail, Calendar, Notes,
  Music), Screen Recording, Accessibility, and optionally Full Disk Access (texts and
  email), Reminders (the second brain's Reminders source), Camera (hand control) and Local
  Network (the iPhone companion).
- **Nothing else.** The voice is the Mac's own until they add an ElevenLabs or Fish Audio key
  in Settings › Speaking. Whisper's speech model (about 150 MB) downloads from Hugging Face
  the first time they talk to it.

To install: open the disk image, drag J.A.R.V.I.S. onto Applications, open it from there.
(Updates only work for a copy in Applications.)

## Your checklist

You run these; the build never signs as you, notarizes or uploads by itself.

The Mac that builds needs Xcode (for swiftc), uv with its own CPython 3.12 and the packages
`uv.lock` pins already in uv's cache (the repo's `uv sync` did both), `app/node_modules`
(`npm install` in `app/`), and git. Only the files git tracks go into the app: commit (or
`git add`) a new file before building; the build names any it had to leave out.

1. **Create the Developer ID Application certificate.** Only the account holder of team
   9ZSY5R8A5C can. In Xcode: Settings › Accounts › your Apple ID › BSH Ventures ›
   Manage Certificates… › + › Developer ID Application. It goes into your login keychain.
   Check it's there:

   ```sh
   security find-identity -v -p codesigning
   # … "Developer ID Application: BSH Ventures … (9ZSY5R8A5C)"
   ```

2. **Make a credential for Apple's notary service**, one of:
   - an app-specific password: account.apple.com › Sign-In and Security › App-Specific
     Passwords › +;
   - or an App Store Connect API key: appstoreconnect.apple.com › Users and Access ›
     Integrations › App Store Connect API › Team Keys › + (Developer access). Download the
     `.p8` once, and note its Key ID and the Issuer ID.

3. **Store it for notarytool, once** (it lives in your keychain under the profile name):

   ```sh
   # with the app-specific password (it asks for it):
   xcrun notarytool store-credentials jarvis-notary --apple-id you@example.com --team-id 9ZSY5R8A5C
   # or with the API key:
   xcrun notarytool store-credentials jarvis-notary --key ~/AuthKey_ABC123DEFG.p8 --key-id ABC123DEFG --issuer 01234567-89ab-cdef-0123-456789abcdef
   ```

4. **Build it.** Bump `version` in `app/package.json` first for every release you publish.

   ```sh
   cd app
   JARVIS_SIGN_IDENTITY="Developer ID Application: BSH Ventures … (9ZSY5R8A5C)" \
   JARVIS_NOTARY_PROFILE=jarvis-notary \
   JARVIS_UPDATE_URL=https://downloads.example.com/jarvis/release.json \
   npm run dist
   ```

   `JARVIS_SIGN_IDENTITY` also takes the certificate's SHA-1 hash from step 1's list.
   `JARVIS_UPDATE_URL` is optional (without it the app doesn't look for updates);
   `JARVIS_RELEASE_NOTES` adds a line of notes to the feed. It takes 20–40 minutes, most
   of it Apple's two notarizations and compressing the disk image. Everything lands in
   `app/dist/release/`; the full log in `app/dist/logs/`.

5. **Check what Gatekeeper will say** (the build does these too, and stops if they fail):

   ```sh
   cd app/dist/release
   spctl -a -vvv -t install J.A.R.V.I.S-darwin-arm64/J.A.R.V.I.S.app   # accepted, source=Notarized Developer ID
   spctl -a -vvv -t open --context context:primary-signature J.A.R.V.I.S.-0.1.0.dmg
   xcrun stapler validate J.A.R.V.I.S.-0.1.0.dmg
   shasum -a 256 -c SHA256SUMS.txt
   node ../../scripts/release/verify.js J.A.R.V.I.S-darwin-arm64/J.A.R.V.I.S.app --notarized
   ```

6. **Publish.** Put `J.A.R.V.I.S.-<version>.dmg` (and `SHA256SUMS.txt`) wherever testers
   download from. For updates, upload `J.A.R.V.I.S.-<version>-mac.zip` and then
   `release.json` into the folder `JARVIS_UPDATE_URL` names (the zip first: the feed points
   at it).

`npm run dist -- --adhoc` builds the same app signed ad hoc, with no credentials, and makes
`J.A.R.V.I.S.-<version>-adhoc.dmg`: for checking the build on your own Mac. Don't give it to
anyone: Gatekeeper refuses ad hoc apps from the internet, and it can't be updated.

## How it's built

`app/scripts/release/dist.js`, step by step:

1. **Package** the app with @electron/packager, as `npm run package` does (same icon,
   Info.plist, bundle id), but without `jarvis-home.json`: nothing in the app points at a
   repo. Electron's release zip comes from Electron's own download cache, or is zipped from
   `node_modules/electron/dist`; nothing is downloaded. `@xterm` and `@mediapipe` stay
   outside `app.asar` (`app.asar.unpacked`): the backend serves them and Python can't read
   inside an asar.
2. **The backend** (`backend.js`) goes to `Contents/Resources/backend/python`:
   - uv's own CPython 3.12 (python-build-standalone), copied from uv's local store;
   - the runtime dependencies `uv.lock` pins (no dev group), installed from uv's cache
     offline: wheels only, hash-checked. A package that isn't cached stops the build;
   - the jarvis package, non-editable: a wheel of the files git tracks (so no untracked file,
     `.env` or cache ships), with every data file (the window, the Chinese, the Swift
     sources, the WhatsApp bridge); every tracked file is checked to be in it;
   - everything precompiled as unchecked-hash `.pyc`;
   - left out: tests, pip, Tk and IDLE, headers, and the entry-point scripts uv writes (their
     `#!` names the build Mac). uv's install folder is taken out of Python's build settings;
   - then, with the bundled Python: every installed package and every jarvis module is
     imported, the `jarvis` entry point is loaded, and the Agent SDK is checked to find its
     bundled Claude engine.

   **The Swift helpers** (`helpers.js`): every `jarvis-*.swift` under `src/jarvis` (globbed:
   a new helper comes along by itself) is compiled with `swiftc -O -target
   arm64-apple-macos<minimum>` into `Contents/Resources/helpers`, each beside a `.sha256` of
   its source. At run time `swift_helper.prebuilt()` uses one only while that is still the
   source's hash; otherwise it builds with swiftc as before. A helper whose APIs need a newer
   macOS gets that as its own target, recorded in `helpers.json` (`jarvis-hear`: macOS 26).
   On an older Mac it can't start, and the backend treats it as unavailable, as it treats
   any helper that doesn't run.
3. **Sign** (`sign.js`), inside-out: every Mach-O file one by one (dylibs, `.so` files, the
   Python executable, the helpers, Electron's libraries and helper tools), then the bundles
   holding them, deepest first, and the app last. Each with `--options runtime --timestamp`
   and its own entitlements; never `--deep`, which would give everything the app's.
   Anthropic's Claude engine (`claude_agent_sdk/_bundled/claude`) is already signed by
   Anthropic's Developer ID with the hardened runtime and a timestamp: it keeps that
   signature. Python and the helpers get identifiers of the app's own
   (`com.bshventures.jarvis.python`, `com.bshventures.jarvis.jarvis-duplex`, …), which is how
   the Keychain and macOS's privacy settings recognize them across updates.
4. **Verify** (`verify.js`): `codesign --verify --strict` on the app and on every Mach-O;
   each has the hardened runtime, a secure timestamp and exactly the entitlements it should;
   nothing is unsigned; the Claude engine still carries Anthropic's signature;
   `LSMinimumSystemVersion` covers every Mach-O (the optional helpers aside); no path of the
   build Mac, no `jarvis-home.json`, no symlink out of the app.
5. **Notarize the app**: zipped with `ditto`, submitted with `notarytool submit --wait`, and
   on a rejection `notarytool log` prints Apple's reasons; then the ticket is stapled.
6. **The disk image**: the app beside a link to Applications, `hdiutil create -format ULMO`.
7. **Sign, notarize and staple the disk image.**
8. **Checksums** in `SHA256SUMS.txt`; with `JARVIS_UPDATE_URL`, the update's zip and
   `release.json` (below); and Gatekeeper's verdict on both.

Sizes of 0.1.0: the app is 875 MB (Electron and the window about 350 MB, the backend 527 MB,
of which the Claude engine alone is 227 MB); the disk image is 300 MB.

### Entitlements (app/build/entitlements)

| Signed item | Entitlements | Why |
| --- | --- | --- |
| J.A.R.V.I.S.app | `cs.allow-jit`, `device.audio-input`, `device.camera`, `automation.apple-events`, `personal-information.location`, `.calendars`, `.addressbook` | V8 compiles JavaScript at run time; the app is the "responsible" process macOS asks the user about for the microphone the backend opens, the camera hand control uses, the location the window asks for, and the Apple Events, calendars and contacts its helpers use. |
| J.A.R.V.I.S Helper.app | `cs.allow-jit`, `device.audio-input`, `device.camera` | Chromium's capture and utility services run here (Electron's own defaults). |
| Helper (Renderer), (GPU), (Plugin) | `cs.allow-jit` | V8 and the GPU process's shader compiler. Electron's defaults also give the plugin helper library-validation and unsigned-memory exceptions for third-party plugins; JARVIS loads none. |
| backend/python/bin/python3.12 | `device.audio-input`, `automation.apple-events`, `personal-information.location`, `.calendars`, `.addressbook` | sounddevice opens the microphone in-process; EventKit (calendars, reminders) and CoreLocation run in Python; the checkup reads the Contacts and Automation permission states in-process. No JIT or unsigned-memory exception: nothing in it needs one (checked: numpy, ctypes callbacks, pyobjc delegates and blocks, onnxruntime, ctranslate2, PyAV run under the hardened runtime). |
| helpers/jarvis-duplex | `device.audio-input` | Talk-over: the echo-cancelled microphone. The build gives this to any helper whose source opens an audio input. |
| every other helper, dylib and `.so` | none | They only need the hardened runtime. |

`cs.disable-library-validation` is in none of them for the Developer ID build: every library
in the app is signed with the same team, so library validation passes. `--adhoc` adds it to
the app, its Electron helpers and Python, because an ad hoc signature has no Team ID and
library validation would then refuse all their own frameworks and extension modules.

### Info.plist (app/build/extend-info.plist)

Usage descriptions for what the code asks macOS for: microphone, camera, calendars (full
access and legacy), reminders (full access and legacy), contacts, location, Apple Events,
and local network with `NSBonjourServices` `_jarvis._tcp` (the iPhone companion finds the Mac
by it). No speech-recognition string: `jarvis-hear` uses SpeechAnalyzer, which asks for no
authorization, and nothing calls `SFSpeechRecognizer.requestAuthorization`. No photo-library
string: nothing uses PhotoKit. Also `LSApplicationCategoryType` (productivity),
`LSMinimumSystemVersion` (set by the build) and the version from `app/package.json`.

### Nothing writes inside the app

A file written inside a signed app breaks its seal, and macOS then calls the app damaged.
So: every `.py` is precompiled, `sitecustomize` turns bytecode writing off even for runs
that ignore the environment (the Keychain helper runs `python -I`), the app starts the
backend with `PYTHONDONTWRITEBYTECODE=1`, from its data folder
(`~/Library/Application Support/Jarvis`, where anything written by a relative path lands),
and with `DISABLE_AUTOUPDATER=1`, so the Claude engine never tries to replace itself. The
Swift helpers are never built into the app (prebuilt; anything built lands in Application
Support/Jarvis/bin), the Whisper model and the hand-tracking model download to caches in
your home folder, and logs go to `~/Library/Logs/Jarvis`. The ad hoc build was checked by
serving the window from the app's own Python and verifying the seal afterwards.

### How the app starts its backend

`app/backend-launch.js`: a packaged app with `Contents/Resources/backend` runs
`backend/python/bin/python3 -m jarvis serve --port …`, with no inherited `PYTHON*` setting,
`PYTHONNOUSERSITE=1`, `JARVIS_HELPERS_DIR` (the helpers), `JARVIS_APP_DIR`
(`app.asar.unpacked`: xterm, MediaPipe, the icon) and the usual PATH additions (git and
other tools are still found where they usually are). Anything else, `npm run install-app`
included, runs uv from the repo as always; `JARVIS_HOME` still overrides.

## Updates

With `JARVIS_UPDATE_URL` set at build time, the feed's address is baked into the app
(`Contents/Resources/update.json`) and the build writes, beside the disk image:

- `J.A.R.V.I.S.-<version>-mac.zip`: the notarized, stapled app, zipped with `ditto`;
- `release.json`: Squirrel.Mac's JSON feed, pointing at that zip (next to the feed).

The app (`app/features/updates.js`, Electron's `autoUpdater` with `serverType: 'json'`)
checks a minute after launch and every 6 hours. It reads the feed itself first and goes on
only when the release is newer than the running version (`app/update-feed.js`), so nothing
older is ever offered; Squirrel then downloads it in the background, and when it's ready the
window offers to restart (Settings › About, and a card). It never restarts unasked.

Squirrel.Mac installs an update only if its code signature satisfies the running app's
designated requirement: the same bundle id, signed by the same Developer ID team
(9ZSY5R8A5C). That is what keeps anyone else from pushing an update. It can't update a copy
that isn't in an Applications folder (a translocated one); the app says so instead.

Builds without a feed (`npm run install-app`, `npm start`, `--adhoc` without the variable)
never look for updates; Settings › About shows the version only.

## What a new install gets

- **No Research Center.** `research_url` is empty by default: Markets shows only the
  markets, isn't a button, and the browser's Research Center button is hidden. Your
  prefs.json keeps its address (a file from before this change is migrated to the hosted
  one if it had none of its own; format version 4).
- **No BSH research desk.** The packaged backend leaves `bsh_dir` unset (JARVIS_BSH_DIR still
  sets it), so its tools and second-brain source stay off; the window then also hides its
  switch and the "How's the portfolio?" chip.
- **Projects in `~/Developer`**, not `~/Investment agent` (JARVIS_PROJECTS_DIR still sets it).
- **Neutral examples** in Settings: "e.g. Lisbon", "Your Company …", "Alex runs a small
  design studio …", `https://research.example.com`.
- **Sign-in by API key** in Setup › Claude; the checkup says plainly when there's no sign-in,
  or Anthropic turned the key down, and doesn't suggest a Terminal login in the packaged app.
- **The Swift compiler check** says the helpers are built in (no Xcode needed).
