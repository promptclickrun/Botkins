/** The iOS Share Extension: appears in the native Share Sheet so people can share links, text, photos, videos, or files directly to any Botkin with optional context. */
/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: "share",
  name: "BotkinsShare",
  displayName: "Botkins",
  bundleIdentifier: ".share",
  deploymentTarget: "16.4",
  frameworks: ["SwiftUI", "UniformTypeIdentifiers"],
  entitlements: {
    // Shared with the app and widgets: reads widgets.json for the agent list and writes the staged share bundle.
    "com.apple.security.application-groups": ["group.app.botkins.mobile"],
  },
};
