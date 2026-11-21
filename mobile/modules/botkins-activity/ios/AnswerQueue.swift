// Answers given away from the app (docs/live-cards.md, section 7): a Live Activity's buttons and the
// Dynamic Island's (the App Intents in targets/widgets/_shared/BotkinsIntents.swift) and a
// notification's actions (AnswerDelegate, below). Each is kept in the app's own defaults until
// JavaScript has sent it (src/state/answers.ts), so one given while the app was closed is sent when
// it starts. An answer holds no secret: a secure input is only ever answered in the app.
//
// The App Intents keep their answers in the same place, in the same shape (they are compiled into
// the app, not into this module): keep `key` and the fields the same on both sides.
import ExpoModulesCore
import ExpoNotifications
import Foundation
import UIKit
import UserNotifications

enum AnswerQueue {
  static let key = "botkins.answers.v1"
  /// Posted with the answer as `userInfo` when one is queued while the app runs.
  static let queued = Notification.Name("app.botkins.answer.queued")
  /// Posted with `id` and `ok` when JavaScript has sent one (or the computer refused it).
  static let done = Notification.Name("app.botkins.answer.done")
  private static let lock = NSLock()

  /// Every answer not yet sent, oldest first.
  static func pending() -> [[String: Any]] {
    lock.lock()
    defer { lock.unlock() }
    return (UserDefaults.standard.array(forKey: key) as? [[String: Any]]) ?? []
  }

  /// Queues an answer once (its id names the notification or the button it came from).
  static func add(_ item: [String: Any]) {
    lock.lock()
    defer { lock.unlock() }
    var all = (UserDefaults.standard.array(forKey: key) as? [[String: Any]]) ?? []
    guard let id = item["id"] as? String, !all.contains(where: { ($0["id"] as? String) == id }) else { return }
    all.append(item)
    UserDefaults.standard.set(Array(all.suffix(20)), forKey: key)
  }

  /// Takes an answer out of the queue, and answers it.
  @discardableResult
  static func finish(_ id: String) -> [String: Any]? {
    lock.lock()
    defer { lock.unlock() }
    var all = (UserDefaults.standard.array(forKey: key) as? [[String: Any]]) ?? []
    guard let index = all.firstIndex(where: { ($0["id"] as? String) == id }) else { return nil }
    let item = all.remove(at: index)
    UserDefaults.standard.set(all, forKey: key)
    return item
  }
}

/**
 A notification's answering actions (the categories in src/state/push.ts): Allow once, Allow for
 this chat, Deny, a question's choices and Reply…. They run without opening the app, so the answer is
 queued here at once, and the app is kept awake for a moment while JavaScript sends it.
 */
final class AnswerDelegate: NotificationDelegate {
  static let shared = AnswerDelegate()

  func didReceive(_ response: UNNotificationResponse, completionHandler: @escaping () -> Void) -> Bool {
    let action = response.actionIdentifier
    let info = response.notification.request.content.userInfo
    guard let request = info["requestId"] as? String else { return false }
    var item: [String: Any] = ["id": response.notification.request.identifier + ":" + action, "request": request, "at": Date().timeIntervalSince1970]
    if let chat = info["chatId"] as? String { item["chat"] = chat }
    if let host = info["host"] as? String { item["host"] = host }
    switch action {
    case "approve", "remember", "deny":
      item["action"] = action
    case "reply":
      guard let text = (response as? UNTextInputNotificationResponse)?.userText.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return false }
      item["action"] = "answer"
      item["value"] = text
    default:
      guard action.hasPrefix("choice."), let index = Int(action.dropFirst(7)), let choices = info["choices"] as? [String], choices.indices.contains(index) else { return false }
      item["action"] = "answer"
      item["value"] = choices[index]
    }
    AnswerQueue.add(item)
    stayAwake(item["id"] as! String)
    NotificationCenter.default.post(name: AnswerQueue.queued, object: nil, userInfo: item)
    return true
  }

  /// Keeps the app running until the answer is sent, or 25 seconds at most.
  private func stayAwake(_ id: String) {
    DispatchQueue.main.async {
      var task: UIBackgroundTaskIdentifier = .invalid
      var observer: NSObjectProtocol?
      let end = {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
        if task != .invalid { UIApplication.shared.endBackgroundTask(task) }
        task = .invalid
      }
      task = UIApplication.shared.beginBackgroundTask(withName: "botkins-answer", expirationHandler: end)
      observer = NotificationCenter.default.addObserver(forName: AnswerQueue.done, object: nil, queue: .main) { note in
        if (note.userInfo?["id"] as? String) == id { end() }
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 25, execute: end)
    }
  }
}

/// Registers the notification hook as the app launches, before a notification's action is delivered.
public class BotkinsAnswersAppDelegate: ExpoAppDelegateSubscriber {
  public func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    NotificationCenterManager.shared.addDelegate(AnswerDelegate.shared)
    return false
  }
}
