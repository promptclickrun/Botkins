/** The Live Activities, the Home Screen and Lock Screen widgets, and the controls (BotkinLiveActivity.swift, BotCard.swift, HomeWidgets.swift, Controls.swift). */
const { readdirSync } = require("node:fs");
const { join } = require("node:path");

// Each Botkin as a symbol for the controls (scripts/botkin-symbols.py): "botkin.<head>".
const symbols = Object.fromEntries(
  readdirSync(join(__dirname, "symbols"))
    .filter((name) => name.endsWith(".svg"))
    .map((name) => [name.replace(/\.svg$/, ""), "./symbols/" + name]),
);

/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: "widget",
  name: "BotkinsWidgets",
  displayName: "Botkins",
  bundleIdentifier: ".widgets",
  deploymentTarget: "16.4",
  frameworks: ["SwiftUI", "WidgetKit", "ActivityKit", "AppIntents"],
  images: symbols,
  entitlements: {
    // The push keys a Botkin's card is opened with (Sealed.swift), kept by the app (modules/botkins-activity).
    "keychain-access-groups": ["$(AppIdentifierPrefix)app.botkins.mobile.shared"],
    // The snapshot the widgets read (Snapshot.swift).
    "com.apple.security.application-groups": ["group.app.botkins.mobile"],
  },
};
