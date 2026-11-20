/** The notification extension: opens sealed alerts before they are shown (NotificationService.swift). */
/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: "notification-service",
  name: "BotkinsNotify",
  displayName: "Botkins",
  bundleIdentifier: ".notify",
  deploymentTarget: "16.4",
  entitlements: {
    // The group the app saves the key in (modules/botkins-activity).
    "keychain-access-groups": ["$(AppIdentifierPrefix)app.botkins.mobile.shared"],
  },
};
