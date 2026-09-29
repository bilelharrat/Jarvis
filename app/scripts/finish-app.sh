#!/bin/sh
# Give the packaged app its full name and re-sign it (ad hoc) after editing Info.plist.
set -e
APP="dist/J.A.R.V.I.S-darwin-arm64/J.A.R.V.I.S.app"
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName J.A.R.V.I.S." "$APP/Contents/Info.plist"
# CFBundleName stays "J.A.R.V.I.S": Electron finds "J.A.R.V.I.S Helper.app" by it, and a
# mismatch crashes the app at launch. The menu bar name comes from app.setName in main.js.
codesign --force --deep --sign - "$APP"
echo "Finished $APP"
