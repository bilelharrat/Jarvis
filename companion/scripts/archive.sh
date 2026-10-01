#!/bin/bash
# Archives the iPhone app (the Watch app and every extension inside it), then exports and
# uploads it to App Store Connect for TestFlight. Run it on your Mac, signed in to Xcode
# (Settings › Accounts) with a team 9ZSY5R8A5C account that may upload.
#
#   companion/scripts/archive.sh              archive, export and upload
#   companion/scripts/archive.sh --dry-run    print the commands, run nothing
#
# The build number is the time, date +%Y%m%d%H%M (every upload needs a new one); it goes to
# CURRENT_PROJECT_VERSION for this archive only, so project.yml stays as it is. The version
# people see is MARKETING_VERSION in project.yml. To upload with an App Store Connect API
# key instead of the Xcode account, set ASC_KEY_PATH (the .p8), ASC_KEY_ID and ASC_ISSUER_ID.
set -euo pipefail

dry_run=0
for arg in "$@"; do
  case "$arg" in
    -n | --dry-run) dry_run=1 ;;
    -h | --help)
      sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "archive.sh: unknown option $arg (try --help)" >&2
      exit 64
      ;;
  esac
done

companion="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
build="$(date +%Y%m%d%H%M)"
version="$(sed -nE 's/^[[:space:]]*MARKETING_VERSION:[[:space:]]*"?([^"]*)"?[[:space:]]*$/\1/p' "$companion/project.yml" | head -1)"
archive="$companion/build/JarvisCompanion-$build.xcarchive"
export_dir="$companion/build/export-$build"

auth=(-allowProvisioningUpdates)
if [[ -n "${ASC_KEY_PATH:-}${ASC_KEY_ID:-}${ASC_ISSUER_ID:-}" ]]; then
  if [[ -z "${ASC_KEY_PATH:-}" || -z "${ASC_KEY_ID:-}" || -z "${ASC_ISSUER_ID:-}" ]]; then
    echo "archive.sh: set all three of ASC_KEY_PATH, ASC_KEY_ID and ASC_ISSUER_ID, or none" >&2
    exit 64
  fi
  auth+=(-authenticationKeyPath "$ASC_KEY_PATH" -authenticationKeyID "$ASC_KEY_ID"
    -authenticationKeyIssuerID "$ASC_ISSUER_ID")
fi

run() {
  printf '+'
  printf ' %q' "$@"
  printf '\n'
  if [[ $dry_run == 0 ]]; then "$@"; fi
}

echo "J.A.R.V.I.S. $version, build $build"
if [[ $dry_run == 1 ]]; then echo "(dry run: printing the commands only)"; fi
if [[ $dry_run == 0 ]]; then
  command -v xcodegen >/dev/null || { echo "archive.sh: xcodegen isn't installed (brew install xcodegen)" >&2; exit 69; }
fi

cd "$companion"
echo "+ cd $companion"

# App Store Connect refuses an App Intent whose description names an Apple product
# (ITMS-90626: "cannot contain 'mac'"): catch it here, before a 10-minute archive.
if grep -rhoE 'IntentDescription\("[^"]*"' "$companion/iOS" "$companion/Activity" \
    | grep -iwE 'mac|macbook|iphone|ipad|siri|apple|watch|airpods|homepod'; then
  echo "archive.sh: an App Intent description above names an Apple product; App Store Connect rejects that" >&2
  exit 65
fi

# The Xcode project from project.yml, as it is now.
run xcodegen generate

# The iOS scheme: the app, and inside it the Watch app, the widgets and the share sheet.
run xcodebuild archive \
  -project JarvisCompanion.xcodeproj \
  -scheme JarvisCompanion \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$archive" \
  "${auth[@]}" \
  CURRENT_PROJECT_VERSION="$build"

if [[ $dry_run == 0 ]]; then
  # Every bundle in it carries the same version and build, as App Store Connect requires.
  app="$archive/Products/Applications/JarvisCompanion.app"
  [[ -d "$app/Watch/JarvisCompanionWatch.app" ]] || { echo "archive.sh: the Watch app isn't in the archive" >&2; exit 70; }
  while IFS= read -r plist; do
    got="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$plist")"
    shown="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$plist")"
    if [[ "$got" != "$build" || "$shown" != "$version" ]]; then
      echo "archive.sh: $plist says $shown ($got), not $version ($build)" >&2
      exit 70
    fi
  done < <(find "$app" -name Info.plist | grep -E '\.(app|appex)/Info\.plist$')
  echo "Every bundle in the archive is $version ($build)."
fi

# Export for App Store Connect and upload (ExportOptions.plist: team 9ZSY5R8A5C, upload).
run xcodebuild -exportArchive \
  -archivePath "$archive" \
  -exportOptionsPlist "$companion/ExportOptions.plist" \
  -exportPath "$export_dir" \
  "${auth[@]}"

if [[ $dry_run == 0 && -f "$export_dir/DistributionSummary.plist" ]]; then
  # Signed for distribution, pushes go to production APNs.
  if plutil -convert xml1 -o - "$export_dir/DistributionSummary.plist" | grep -A1 'aps-environment' | grep -q production; then
    echo "Push notifications: aps-environment is production."
  else
    echo "archive.sh: warning: the exported app's aps-environment isn't production" >&2
  fi
fi

if [[ $dry_run == 1 ]]; then
  headline="Dry run: nothing was archived or uploaded. After a real run, in App Store Connect"
else
  headline="Uploaded J.A.R.V.I.S. $version ($build). Next, in App Store Connect"
fi
cat <<EOF

$headline (appstoreconnect.apple.com):
  1. Apps › J.A.R.V.I.S. › TestFlight: build $build shows up after processing (Apple
     emails when it's done, usually 10–30 minutes).
  2. Export compliance is answered by the app (it uses only Apple's encryption), so the
     build goes straight to your internal testers: TestFlight › Internal Testing › your
     group › add build $build if the group doesn't get new builds by itself.
  3. For people outside your team: TestFlight › External Testing › add build $build to a
     group. The first external build goes to Beta App Review, which needs the Test
     Information page filled in (description, feedback email, privacy policy URL) and
     review notes saying the app pairs with Jarvis on your own Mac.
  4. Testers install it with the TestFlight app on their iPhone; the Watch app comes with it.
The archive is $archive
(open it in Xcode's Organizer to see or re-upload it).
EOF
