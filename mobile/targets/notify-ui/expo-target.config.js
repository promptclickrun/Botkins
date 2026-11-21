/** The notification content extension: a question's choices as buttons on its notification (NotificationViewController.swift). */
/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: "notification-content",
  name: "BotkinsNotifyUI",
  displayName: "Botkins",
  bundleIdentifier: ".notifyui",
  deploymentTarget: "16.4",
  frameworks: ["UserNotifications", "UserNotificationsUI"],
};
