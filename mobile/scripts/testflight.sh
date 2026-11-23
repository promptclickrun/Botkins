#!/bin/sh
# Builds the iPhone app for release and uploads it to TestFlight.
#
#   TEAM_ID=… BOTKINS_BUILD=2 ASC_KEY_ID=… ASC_ISSUER_ID=… sh scripts/testflight.sh
#
# BOTKINS_BUILD   the build number; it has to be higher than the last upload's (app.config.ts reads it).
# ASC_KEY_ID      an App Store Connect API key's id. Its file is ~/.appstoreconnect/private_keys/AuthKey_<id>.p8.
# ASC_ISSUER_ID   the issuer id shown above the keys in App Store Connect › Users and Access › Integrations.
# TEAM_ID         the identifier for the Apple developer team that signs the app.
#
# The upload is signed with the "Apple Distribution" certificate in this Mac's keychain and the
# provisioning profiles named in scripts/ExportOptions.plist: one for the app ("Botkins App Store"),
# one for the embedded Watch app, and one for each extension in targets/. After it uploads,
# Apple takes a few minutes to process the build; the internal TestFlight group gets it by itself.
set -eu
cd "$(dirname "$0")/.."
: "${BOTKINS_BUILD:?Set BOTKINS_BUILD to the new build number}"
: "${ASC_KEY_ID:?Set ASC_KEY_ID}"
: "${ASC_ISSUER_ID:?Set ASC_ISSUER_ID}"
: "${TEAM_ID:?Set TEAM_ID to your Apple developer team ID}"
export TEAM_ID
KEY="$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8"
OUT="${OUT:-$(mktemp -d)}"
mkdir -p "$OUT"
cp scripts/ExportOptions.plist "$OUT/ExportOptions.plist"
/usr/bin/plutil -insert teamID -string "$TEAM_ID" "$OUT/ExportOptions.plist"

npx tsc --noEmit
npm test
# The Live Activity's pictures come from the design kit.
node scripts/build-widget-assets.mjs
# The native project follows app.config.ts (fonts, permissions, the build number, and Apple's
# production notification service, which a TestFlight build must use).
BOTKINS_BUILD="$BOTKINS_BUILD" npx expo prebuild --platform ios

xcodebuild -workspace ios/Botkins.xcworkspace -scheme Botkins -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$OUT/Botkins.xcarchive" -derivedDataPath ios/build-release \
  archive DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic -allowProvisioningUpdates \
  -authenticationKeyPath "$KEY" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID"

xcodebuild -exportArchive -archivePath "$OUT/Botkins.xcarchive" -exportPath "$OUT/upload" \
  -exportOptionsPlist "$OUT/ExportOptions.plist" \
  -authenticationKeyPath "$KEY" -authenticationKeyID "$ASC_KEY_ID" -authenticationKeyIssuerID "$ASC_ISSUER_ID"

echo "Uploaded build $BOTKINS_BUILD. Apple is processing it; it shows in TestFlight in a few minutes."
