// Signs Android release builds with the Play upload key when BOTKINS_UPLOAD_STORE and
// BOTKINS_UPLOAD_PASSWORD are set (scripts/android-play.sh sets them). The key and its password
// never land in the generated project; without them a release build keeps the debug signature.
const { withAppBuildGradle } = require("expo/config-plugins");

const MARK = "// botkins-release-signing";

module.exports = function withAndroidRelease(config) {
  return withAppBuildGradle(config, (mod) => {
    let gradle = mod.modResults.contents;
    if (gradle.includes(MARK)) return mod;
    gradle = gradle.replace(
      /signingConfigs\s*\{/,
      `signingConfigs {
        ${MARK}
        if (System.getenv("BOTKINS_UPLOAD_STORE")) {
            upload {
                storeFile file(System.getenv("BOTKINS_UPLOAD_STORE"))
                storePassword System.getenv("BOTKINS_UPLOAD_PASSWORD")
                keyAlias System.getenv("BOTKINS_UPLOAD_ALIAS") ?: "upload"
                keyPassword System.getenv("BOTKINS_UPLOAD_PASSWORD")
            }
        }`,
    );
    gradle = gradle.replace(
      /(release\s*\{[^}]*?)signingConfig\s+signingConfigs\.debug/,
      `$1signingConfig System.getenv("BOTKINS_UPLOAD_STORE") ? signingConfigs.upload : signingConfigs.debug`,
    );
    mod.modResults.contents = gradle;
    return mod;
  });
};
