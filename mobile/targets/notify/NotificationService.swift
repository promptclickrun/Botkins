// Opens a sealed notification before it is shown.
//
// What Apple carries says only "New message". The real title and text are in `b`, sealed by the
// computer with a key only it and this phone have (link-host/push.mjs):
//   b = base64(nonce(12) + ChaCha20-Poly1305(key, nonce, JSON, aad "botkins-push-v1"))
//   JSON = { t: title, m: text, c: chat id, k: kind, r?: request id, q?: a request's buttons,
//            a?: { b: bot id, r: run id } for a proactive alert that offers to take care of something }
// The key is in a keychain group this extension shares with the app (modules/botkins-activity). A
// phone can be paired with several computers: there is a key for each ("key:<the computer's id>"),
// each is tried, and the id of the computer whose key opened the alert is noted as `host`, so a tap
// opens the chat on the right computer.
// When anything fails the notification is shown as it came, so nothing is lost and nothing leaks.
import CryptoKit
import Foundation
import Security
import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
  private var deliver: ((UNNotificationContent) -> Void)?
  private var best: UNMutableNotificationContent?

  override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
    deliver = contentHandler
    let content = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
    best = content
    if let sealed = request.content.userInfo["b"] as? String, let (opened, host) = open(sealed) {
      if let title = opened["t"] as? String, !title.isEmpty { content.title = title }
      if let text = opened["m"] as? String, !text.isEmpty { content.body = text }
      var info = content.userInfo
      info["b"] = nil
      if let chat = opened["c"] as? String { info["chatId"] = chat }
      if let kind = opened["k"] as? String { info["kind"] = kind }
      if let asked = opened["r"] as? String { info["requestId"] = asked }
      if opened["nj"] as? Bool == true { info["nodeJob"] = true }
      // An alert about a space ("space-alerts-v1") names the space, and the panel when it is about one.
      if let space = opened["s"] as? String { info["spaceId"] = space }
      if let panel = opened["p"] as? String { info["panelId"] = panel }
      if let host { info["host"] = host }
      // A request's buttons (docs/live-cards.md, section 6). Without `q` (previews off, or an older
      // computer) the notification keeps its category and only opens the app.
      if let ask = opened["q"] as? [String: Any], let kind = ask["k"] as? String {
        let choices = (ask["ch"] as? [String]) ?? []
        let free = ask["free"] as? Bool ?? false
        if kind == "permission" {
          content.categoryIdentifier = ask["x"] as? Bool == true ? "botkins_approve_risky" : ask["rm"] as? Bool == true ? "botkins_approve" : "botkins_approve_once"
        } else if kind == "question" && (!choices.isEmpty || free) {
          content.categoryIdentifier = "botkins_question"
          info["choices"] = choices
          info["free"] = free
        } else {
          content.categoryIdentifier = "botkins_open"
        }
      }
      // A proactive alert that offers to take care of something ("proactive-team-v1"): one button,
      // "Take care of it", which opens the app. The ids are all the phone needs to ask the computer.
      if let alert = opened["a"] as? [String: Any], let bot = alert["b"] as? String, let run = alert["r"] as? String {
        info["alertBot"] = bot
        info["alertRun"] = run
        content.categoryIdentifier = "botkins_alert"
      }
      content.userInfo = info
    }
    contentHandler(content)
  }

  override func serviceExtensionTimeWillExpire() {
    if let deliver, let best { deliver(best) }
  }

  /// The alert's contents and the computer it came from: the first key that opens it says which.
  /// The seal is checked as it is opened, so a key of another computer opens nothing.
  private func open(_ sealed: String) -> ([String: Any], String?)? {
    guard let data = Data(base64Encoded: sealed), data.count > 28, let box = try? ChaChaPoly.SealedBox(combined: data) else { return nil }
    for (host, key) in pushKeys() {
      guard let plain = try? ChaChaPoly.open(box, using: SymmetricKey(data: key), authenticating: Data("botkins-push-v1".utf8)),
            let opened = (try? JSONSerialization.jsonObject(with: plain)) as? [String: Any] else { continue }
      return (opened, host)
    }
    return nil
  }

  /// Every key the app keeps: one for each paired computer ("key:<id>"), or the single "key" a
  /// version before several computers saved, which names no computer.
  private func pushKeys() -> [(String?, Data)] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "app.botkins.push",
      kSecReturnAttributes as String: true,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitAll,
    ]
    if let group = Bundle.main.object(forInfoDictionaryKey: "BotkinsKeychainGroup") as? String, !group.isEmpty {
      query[kSecAttrAccessGroup as String] = group
    }
    var found: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let items = found as? [[String: Any]] else { return [] }
    var keys: [(String?, Data)] = []
    for item in items {
      guard let key = item[kSecValueData as String] as? Data, key.count == 32, let account = item[kSecAttrAccount as String] as? String else { continue }
      if account.hasPrefix("key:") { keys.append((String(account.dropFirst(4)), key)) }
      else if account == "key" { keys.append((nil, key)) }
    }
    return keys
  }
}
