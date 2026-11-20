#!/bin/sh
# Builds a signed Android App Bundle for Google Play's internal testing track.
#
#   BOTKINS_BUILD=2 sh scripts/android-play.sh
#
# BOTKINS_BUILD is the versionCode and must go up with every upload. The upload key is
# ~/.botkins-keys/botkins-upload.jks (alias "upload"); its password is in the macOS Keychain
# item "Botkins Android upload key". Lose the key and Play support has to reset it; keep a backup.
# The bundle lands in android/app/build/outputs/bundle/release/app-release.aab. The first upload
# to a new Play app has to be made by hand in Play Console; later ones can go through the API.
set -eu
cd "$(dirname "$0")/.."

: "${BOTKINS_BUILD:?Set BOTKINS_BUILD to a versionCode higher than the last upload}"
export BOTKINS_BUILD
export BOTKINS_UPLOAD_STORE="${BOTKINS_UPLOAD_STORE:-$HOME/.botkins-keys/botkins-upload.jks}"
BOTKINS_UPLOAD_PASSWORD="$(security find-generic-password -a botkins-android -s "Botkins Android upload key" -w)"
export BOTKINS_UPLOAD_PASSWORD
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export JAVA_HOME="${JAVA_HOME:-$(/usr/libexec/java_home -v 17)}"

npx tsc --noEmit
npm test
npx expo prebuild -p android --clean --no-install
(cd android && ./gradlew :app:bundleRelease --console=plain)

AAB=android/app/build/outputs/bundle/release/app-release.aab
jarsigner -verify "$AAB" >/dev/null
echo "Signed bundle: $AAB (versionCode $BOTKINS_BUILD)"
