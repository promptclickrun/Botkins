#!/bin/sh
# Build a signed APK and send it to the Firebase tester group.
# Export FIREBASE_APP_ID and FIREBASE_PROJECT before you run this script.
# Set BOTKINS_BUILD to the next version code.
#
#   BOTKINS_BUILD=2 sh scripts/android-testers.sh "What changed"
set -eu
cd "$(dirname "$0")/.."

: "${BOTKINS_BUILD:?Set BOTKINS_BUILD to a versionCode higher than the last build}"
: "${FIREBASE_APP_ID:?Set FIREBASE_APP_ID to your Android app ID}"
: "${FIREBASE_PROJECT:?Set FIREBASE_PROJECT to your Firebase project ID}"
NOTES="${1:-Botkins test build $BOTKINS_BUILD}"
export BOTKINS_BUILD
export BOTKINS_UPLOAD_STORE="${BOTKINS_UPLOAD_STORE:-$HOME/.botkins-keys/botkins-upload.jks}"
BOTKINS_UPLOAD_PASSWORD="$(security find-generic-password -a botkins-android -s "Botkins Android upload key" -w)"
export BOTKINS_UPLOAD_PASSWORD
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export JAVA_HOME="${JAVA_HOME:-$(/usr/libexec/java_home -v 17)}"

npx tsc --noEmit
npm test
npx expo prebuild -p android --clean --no-install
(cd android && ./gradlew :app:assembleRelease --console=plain)

APK=android/app/build/outputs/apk/release/app-release.apk
npx --yes firebase-tools appdistribution:distribute "$APK" \
  --app "$FIREBASE_APP_ID" \
  --project "$FIREBASE_PROJECT" \
  --groups testers \
  --release-notes "$NOTES"
