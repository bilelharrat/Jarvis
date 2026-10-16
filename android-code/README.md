# Eden Code for Android

The Android version of the Eden Code phone app (`companion/EdenCode` is the iPhone one): Kotlin and
Jetpack Compose, the same phone API (`src/jarvis/features/_code_phone_routes.py`), pairing with a
pinned certificate, the Eden relay away from home, and the G design (2026-10-16): a session fills
the screen, ☰ opens the sessions drawer (which also reaches the Inbox, the Queue and Settings), ✎
starts a new session, and a card that waits on you sits in the session as a glass card.

## Build and test

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@17 ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
./gradlew assembleDebug testDebugUnitTest
```

## Look at the screens without a Mac (debug builds only)

```sh
adb shell am start -n com.askeden.edencode/.MainActivity --es EDENCODEFixtures YES --es EDENCODEOpen session:5
```

`EDENCODEOpen`: `new`, `drawer`, `session:<id>`, `changes:<id>`, `ask` (a card in its session),
`approve` (a card over the screen), `inbox`, `queue`, `settings`, `pair`. To pair with a test Mac:
`--es EDENCODEServer 10.0.2.2:8871 --es EDENCODECode 123456` (the emulator's 10.0.2.2 is the Mac).

## Pushes (Firebase Cloud Messaging), off until set up

Without Firebase the app keeps a live connection while it runs and posts its own notifications.
To turn pushes on, put the Firebase project's values in `firebase.properties` next to
`settings.gradle.kts` (git-ignored):

```
projectId=…
appId=…
apiKey=…
senderId=…
```

## Owner steps before a release

- Choose the package name (now `com.askeden.edencode`; it can't change after the first Play upload).
- Create the Play Console app, a release keystore and signing (none is in this repo on purpose).
- Create the Firebase project for that package name and fill `firebase.properties`.
- The Mac side doesn't send FCM yet: it stores the phone's token (`/api/push/register`, platform
  "android") but only sends APNs. Sending needs an FCM HTTP v1 sender with the Firebase service
  account's key, kept in the Mac's Keychain.
