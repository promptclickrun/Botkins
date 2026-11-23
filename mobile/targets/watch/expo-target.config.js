const { readdirSync } = require("node:fs");
const { join } = require("node:path");

const assets = join(__dirname, "../widgets/assets");
const images = Object.fromEntries(
  readdirSync(assets)
    .filter((name) => /^[a-z]+-(original|terracotta|honey|fern|tidepool|bluebell|fig)\.png$/.test(name))
    .map((name) => [name.replace(/\.png$/, ""), "../widgets/assets/" + name]),
);

/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: "watch",
  name: "BotkinsWatch",
  displayName: "Botkins",
  bundleIdentifier: ".watchkitapp",
  deploymentTarget: "11.0",
  icon: "../../assets/images/icon.png",
  frameworks: ["SwiftUI", "WatchKit", "WatchConnectivity", "AVFoundation"],
  images,
};
