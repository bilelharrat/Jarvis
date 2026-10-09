#!/bin/sh
# Give the packaged app its full name and re-sign it after editing Info.plist.
#
# Signing with a real certificate (the owner's team, 8CV4X23Y2T) gives the app a
# stable identity, so macOS keeps its permissions (Full Disk Access, microphone,
# location, calendars) across rebuilds; an ad hoc signature changes every build and
# silently voids them. Only team 8CV4X23Y2T (bilel.harrat@icloud.com) signs: JARVIS_SIGN_IDENTITY
# picks one of its certificates, and a signature from any other team is refused; with no
# certificate of the team in the keychain it falls back to ad hoc.
set -e
# APP and DISPLAY_NAME pick another app built from this folder (scripts/eden-code/package.js).
APP="${APP:-dist/J.A.R.V.I.S-darwin-arm64/J.A.R.V.I.S.app}"
DISPLAY_NAME="${DISPLAY_NAME:-J.A.R.V.I.S.}"
TEAM="8CV4X23Y2T"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName $DISPLAY_NAME" "$APP/Contents/Info.plist"
# CFBundleName stays "J.A.R.V.I.S": Electron finds "J.A.R.V.I.S Helper.app" by it, and a
# mismatch crashes the app at launch. The menu bar name comes from app.setName in main.js.

IDENTITY="$JARVIS_SIGN_IDENTITY"
if [ -z "$IDENTITY" ]; then
  # The first code-signing certificate issued to the team (its OU is the team id).
  for hash in $(security find-identity -v -p codesigning | awk '/"/ {print $2}'); do
    if security find-certificate -a -Z -p 2>/dev/null | awk -v h="$hash" '
        /^SHA-1 hash:/ {keep = ($3 == h)} keep' | openssl x509 -noout -subject 2>/dev/null |
        grep -q "OU=$TEAM"; then
      IDENTITY="$hash"
      break
    fi
  done
fi

if [ -n "$IDENTITY" ]; then
  codesign --force --deep --timestamp=none --sign "$IDENTITY" "$APP"
  echo "Signed with $(codesign -dvv "$APP" 2>&1 | awk -F= '/^Authority/ {print $2; exit}')"
else
  codesign --force --deep --sign - "$APP"
  echo "No team $TEAM certificate in the keychain: signed ad hoc (permissions reset each build)"
fi
codesign --verify --deep "$APP"
SIGNED_TEAM="$(codesign -dvv "$APP" 2>&1 | awk -F= '/^TeamIdentifier/ {print $2}')"
if [ -n "$IDENTITY" ] && [ "$SIGNED_TEAM" != "$TEAM" ]; then
  echo "Signed by team $SIGNED_TEAM, not $TEAM: refused" >&2
  exit 1
fi
echo "Finished $APP"
