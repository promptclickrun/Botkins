// The buttons on a Botkin's Live Activity and in the Dynamic Island (docs/live-cards.md, section 7).
//
// This file is compiled into the app and into the widget extension (targets/widgets/_shared): the
// extension draws the buttons, and the system runs the intent in the app, without opening it. The
// intent puts the answer in the app's queue, in the same shape modules/botkins-activity's
// AnswerQueue keeps (keep the two the same), tells the running app, and waits a moment for
// JavaScript to send it (src/state/answers.ts). An answer given while the app was closed is sent
// when it starts. Every answer needs the phone unlocked.
import AppIntents
import Foundation

@available(iOS 17.0, *)
struct AnswerIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "Answer a bot"
  static let isDiscoverable = false
  static var authenticationPolicy: IntentAuthenticationPolicy { .requiresAuthentication }

  /// The request answered; empty for Stop and Try again.
  @Parameter(title: "Request") var request: String
  @Parameter(title: "Chat") var chat: String
  /// The card's key ("bot:" + the Botkin's id), so it can show the answer at once.
  @Parameter(title: "Card") var card: String
  /// approve, remember, deny, answer, stop or retry
  @Parameter(title: "Action") var action: String
  @Parameter(title: "Answer") var value: String
  /// The words on the button, shown on the card while it is sent.
  @Parameter(title: "Words") var words: String
  /// The computer the card belongs to.
  @Parameter(title: "Computer") var host: String

  init() {}

  init(request: String = "", chat: String, card: String, action: String, value: String = "", words: String, host: String?) {
    self.request = request
    self.chat = chat
    self.card = card
    self.action = action
    self.value = value
    self.words = words
    self.host = host ?? ""
  }

  func perform() async throws -> some IntentResult {
    let id = "card:" + [card, request, action, value].joined(separator: ":")
    var item: [String: Any] = ["id": id, "action": action, "chat": chat, "card": card, "words": words, "at": Date().timeIntervalSince1970]
    if !request.isEmpty { item["request"] = request }
    if !value.isEmpty { item["value"] = value }
    if !host.isEmpty { item["host"] = host }
    QueuedAnswers.add(item)
    NotificationCenter.default.post(name: QueuedAnswers.queued, object: nil, userInfo: item)
    await QueuedAnswers.wait(for: id, seconds: 20)
    return .result()
  }
}

/// The app's answer queue, as modules/botkins-activity/ios/AnswerQueue.swift keeps it.
enum QueuedAnswers {
  static let key = "botkins.answers.v1"
  static let queued = Notification.Name("app.botkins.answer.queued")
  static let done = Notification.Name("app.botkins.answer.done")

  static func add(_ item: [String: Any]) {
    var all = (UserDefaults.standard.array(forKey: key) as? [[String: Any]]) ?? []
    guard let id = item["id"] as? String, !all.contains(where: { ($0["id"] as? String) == id }) else { return }
    all.append(item)
    UserDefaults.standard.set(Array(all.suffix(20)), forKey: key)
  }

  /// Returns when the app has sent the answer (or refused it), or after `seconds`.
  static func wait(for id: String, seconds: Double) async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
      let once = Once(continuation)
      once.observer = NotificationCenter.default.addObserver(forName: done, object: nil, queue: nil) { note in
        if (note.userInfo?["id"] as? String) == id { once.finish() }
      }
      DispatchQueue.global().asyncAfter(deadline: .now() + seconds) { once.finish() }
    }
  }

  /// Resumes a wait once, whichever comes first: the answer, or the time.
  private final class Once: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Never>?
    var observer: NSObjectProtocol?

    init(_ continuation: CheckedContinuation<Void, Never>) { self.continuation = continuation }

    func finish() {
      lock.lock()
      let waiting = continuation
      continuation = nil
      let watching = observer
      observer = nil
      lock.unlock()
      if let watching { NotificationCenter.default.removeObserver(watching) }
      waiting?.resume()
    }
  }
}
