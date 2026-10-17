# Releasing Eden Code for Mac

Eden Code is `Eden Code.app`: the same Electron app and embedded Python backend as Eden Secretary,
packaged under its own name (`com.bshventures.edencode`), icon and Info.plist with `flavor.json`
baked in. `docs/distribution.md` describes the build in depth; this is the owner's checklist.

## What the build gives you

`cd app && npm run dist:eden-code` produces, in `app/dist/release-eden-code/`:

- `Eden Code-darwin-arm64/Eden Code.app`: self-contained (CPython 3.12 and every locked dependency
  inside `Contents/Resources/backend`, prebuilt Swift helpers in `Contents/Resources/helpers`, no
  `jarvis-home.json`, no repo or worktree path anywhere: `verify.js` fails the build if one appears);
  hardened runtime, secure timestamp, signed inside-out by `Developer ID Application: Bilel Harrat
  (8CV4X23Y2T)` only (`dist.js` refuses any other team, including Robert Parker's 9ZSY5R8A5C).
- `Eden Code-<version>.dmg` (signed, notarized, stapled), `SHA256SUMS.txt`, and, when
  `EDEN_CODE_UPDATE_URL` is set, `Eden Code-<version>-mac.zip` plus `eden-code-release.json`
  (the update feed; `publish.js` is for Eden Secretary and does not upload these: upload them by hand).

The full build notarizes and needs credentials. To check the build without contacting Apple:

```sh
cd app
JARVIS_SIGN_IDENTITY=4F7A827AEBBB71C12B0A6ED1FF9C3FAE1D31CECB npm run dist:eden-code -- --sign-only
```

`--sign-only` signs like the real build and stops: no notarization, no stapling, no Gatekeeper
verdict, no notary profile needed. Its disk image is `Eden Code-<version>-unnotarized.dmg`
(never give it away; Gatekeeper rejects it with "Unnotarized Developer ID"). It takes about three
minutes. (`--adhoc` is the other check build: ad hoc signed, this Mac only.)

## Owner steps

1. **Version.** Bump `version` in `app/package.json` (now 0.1.8) before building. It is shared with
   Eden Secretary (one package), and goes into the DMG name, Info.plist and the update feed. To call
   Eden Code 1.0.0, set `"version": "1.0.0"` there: the feed's comparison is semver (`update-feed.js`),
   0.1.8 to 1.0.0 is offered as an update, and no test pins the number. It was not bumped here because
   the same change would also renumber Eden Secretary's next build.
2. **Certificate.** The `Developer ID Application: Bilel Harrat (8CV4X23Y2T)` identity is in this
   Mac's login keychain (SHA-1 `4F7A827A…1D31CECB`). The keychain also holds Robert Parker's Developer
   ID; the build never uses it.
3. **Notary credentials.** The keychain profile `jarvis-notary` already exists on this Mac
   (`xcrun notarytool history --keychain-profile jarvis-notary` works). If it is ever missing:
   `xcrun notarytool store-credentials jarvis-notary --apple-id bilel.harrat@icloud.com --team-id 8CV4X23Y2T`
   (an app-specific password) or with an App Store Connect API key (`--key/--key-id/--issuer`).
4. **Build, notarize, staple** (20 to 40 minutes, most of it Apple's two notarizations):

   ```sh
   cd app
   JARVIS_SIGN_IDENTITY="Developer ID Application: Bilel Harrat (8CV4X23Y2T)" \
   JARVIS_NOTARY_PROFILE=jarvis-notary \
   npm run dist:eden-code
   ```

   It submits the app and the DMG to Apple, staples both tickets, then requires Gatekeeper to say
   `source=Notarized Developer ID`. Check afterwards:

   ```sh
   cd app/dist/release-eden-code
   spctl -a -vvv -t install "Eden Code-darwin-arm64/Eden Code.app"
   xcrun stapler validate "Eden Code-<version>.dmg"
   shasum -a 256 -c SHA256SUMS.txt
   ```

   If Apple rejects it, the build prints Apple's log of why and stops.
5. **Update feed.** Updates are off until you give a public https address for the feed:
   `EDEN_CODE_UPDATE_URL=https://<where>/eden-code-release.json` at build time (written to
   `Contents/Resources/update.json`; nothing points anywhere public today). With it set the build also
   writes `Eden Code-<version>-mac.zip` (the notarized, stapled app) and `eden-code-release.json`. Upload
   the zip first, the JSON last, so the feed never points at a missing file. Use a URL you will keep
   serving: it is baked into every build already out. `JARVIS_RELEASE_NOTES="…"` adds a line of notes.
6. **Publish.** Upload the DMG, `SHA256SUMS.txt`, the zip and the feed to wherever downloads live
   (a GitHub release or the site). Nothing in the build uploads. Do not repoint any download page
   at a build that has not been installed and opened on a second Mac first. Keep this out of the
   Ask Eden iOS app's review window: no site or `app/eden` change is part of it.
7. **Windows.** `npm run dist:win` (`app/scripts/release/windows.js --eden-code`) builds the
   installer; Windows CI minutes are exhausted, so cross-build on the Mac and run the public
   `windows-launch-check` repo's install check before linking it (see
   `docs/eden-code-windows-parity.md`). Windows signing and its update feed are separate from the
   steps above.

## What a user sees

- **Needs** Apple silicon and macOS 14 or later (computed from every Mach-O file; `jarvis-hear`
  needs macOS 26 and degrades to Whisper before that).
- **First run, no Claude sign-in.** Not verified in the GUI (the packaged app was not launched). By
  the code: with no key set, nothing is changed and a Mac that already has Claude Code logged in uses
  that login; the downloadable build is meant to take the user's own Anthropic API key
  (Setup's Claude step; console.anthropic.com), kept in their Keychain and used through a loopback key
  proxy, never in an environment variable, file or command line (`src/jarvis/claude_signin.py`).
  Owner check: open the notarized build on a Mac with no Claude login and confirm the Setup step
  explains this and the app stays usable without a key.
- **Crash reporting is off by default and never uploads.** Settings > Health > Diagnostics
  (`features.crash_reports`) turns on local crash files in the data folder's `crash-reports/`;
  Electron's `crashReporter` runs with `uploadToServer: false`.
- **Where data lives** (what to delete to uninstall completely):
  - `Eden Code.app` (drag to Trash);
  - `~/Library/Application Support/Eden Code` (Electron profile, window state, cookies);
  - `~/Library/Application Support/Jarvis` (the backend's data folder, shared with Eden Secretary:
    sessions, prefs, crash reports; delete only if neither app is wanted);
  - Keychain items "Eden Code Safe Storage" and the provider keys the app stored;
  - the app's log folder under `~/Library/Logs` (named by `logName`, "Eden Code") if present.
  Updates only work for a copy in /Applications.

## Findings from the 0.1.8 check build (2026-10-16)

- Built and signed (`--sign-only`): 152 Mach-O files verified, `codesign --verify --deep --strict`
  passes, `spctl` says `rejected, source=Unnotarized Developer ID, origin=Developer ID Application:
  Bilel Harrat (8CV4X23Y2T)` as expected before notarization. App 895 MB, DMG 314 MB.
- No `worktrees/`, repo or home path in the app's resources, `app.asar` or `update.json` (the only
  `worktrees/` strings are Python source that talks about git worktrees).
- The embedded backend (`Resources/backend/python/bin/python3 -m jarvis serve --port <p>`, exactly
  what `backend-launch.js` runs) started with a private HOME and answered `/health` with
  `{"ok":true,"busy":false,"protocol":1}`. The packaged GUI was not launched.
- Entitlements: JIT (V8), audio input, camera, Apple events, calendars, contacts, location. The app is
  not sandboxed, so there are no network client/server entitlements to add (they are sandbox-only).
  Open follow-up: Eden Code gets the same set as Eden Secretary; calendars, contacts and location are
  more than a coding app needs and its Info.plist has no usage strings for the first two. A per-flavor
  trim in `app/scripts/release/sign.js` would be tidier but changes signing for both apps.
- Not tested here: a second Mac's first launch of the notarized build, Squirrel update install, the
  Windows installer.
