/** The Live Activity: a chat's running turn on the Lock Screen and in the Dynamic Island (BotkinLiveActivity.swift). */
/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: "widget",
  name: "BotkinsWidgets",
  displayName: "Botkins",
  bundleIdentifier: ".widgets",
  deploymentTarget: "16.4",
  frameworks: ["SwiftUI", "WidgetKit", "ActivityKit"],
};
