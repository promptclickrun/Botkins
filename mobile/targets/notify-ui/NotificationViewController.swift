// A question's notification, held open: its choices as buttons, then Reply… and Open chat
// (docs/live-cards.md, section 6). The notification extension (targets/notify) opened the sealed
// alert and put the choices in its `userInfo`; the buttons are set here, for this one notification.
// The notification's own title and text show as they are: this view draws nothing of its own.
// A tap on a choice is answered by the app without opening it (modules/botkins-activity, AnswerDelegate).
import UIKit
import UserNotifications
import UserNotificationsUI

final class NotificationViewController: UIViewController, UNNotificationContentExtension {
  override func viewDidLoad() {
    super.viewDidLoad()
    preferredContentSize = CGSize(width: view.bounds.width, height: 1)
  }

  func didReceive(_ notification: UNNotification) {
    let info = notification.request.content.userInfo
    let choices = ((info["choices"] as? [String]) ?? []).prefix(3)
    let free = info["free"] as? Bool ?? false
    // Every answer needs the phone unlocked; Open chat opens the app.
    var actions: [UNNotificationAction] = choices.enumerated().map { index, choice in
      UNNotificationAction(identifier: "choice.\(index)", title: choice, options: [.authenticationRequired])
    }
    if free || choices.isEmpty {
      actions.append(UNTextInputNotificationAction(identifier: "reply", title: "Reply…", options: [.authenticationRequired], icon: UNNotificationActionIcon(systemImageName: "arrowshape.turn.up.left"), textInputButtonTitle: "Send", textInputPlaceholder: "Your answer"))
    }
    actions.append(UNNotificationAction(identifier: "open", title: "Open chat", options: [.foreground], icon: UNNotificationActionIcon(systemImageName: "bubble.left")))
    extensionContext?.notificationActions = actions
  }
}
