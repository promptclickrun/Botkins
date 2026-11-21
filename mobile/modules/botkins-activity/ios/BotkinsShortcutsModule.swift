import ExpoModulesCore
import Foundation

/// App Intents and the app's JS run in the same process. Hold work only while Shortcuts is
/// awaiting it. A cold launch can claim a request after registering its listener.
@MainActor
public enum ShortcutRequests {
  fileprivate static let changed = Notification.Name("app.botkins.shortcuts.changed")
  private struct Request {
    let fields: [String: String]
    let completion: CheckedContinuation<String, Error>
    var claimed = false
  }
  private static var requests: [String: Request] = [:]

  public static func run(_ fields: [String: String]) async throws -> String {
    let id = UUID().uuidString
    let timeout = Task {
      try await Task.sleep(nanoseconds: 25_000_000_000)
      guard requests[id]?.claimed == true else {
        finish(id, error: "Botkins could not start this shortcut. Open Botkins and try again.")
        return
      }
      try await Task.sleep(nanoseconds: 600_000_000_000)
      finish(id, error: "The shortcut timed out. Check the chat in Botkins.")
    }
    defer { timeout.cancel() }
    return try await withTaskCancellationHandler {
      try Task.checkCancellation()
      return try await withCheckedThrowingContinuation { continuation in
        var parameters = fields
        parameters["id"] = id
        requests[id] = Request(fields: parameters, completion: continuation)
        NotificationCenter.default.post(name: changed, object: nil)
      }
    } onCancel: {
      Task { @MainActor in finish(id, error: "Shortcut cancelled.") }
    }
  }

  fileprivate static func take(voice: Bool) -> [[String: String]] {
    let pending = requests.filter { !$0.value.claimed && ($0.value.fields["action"] == "voice") == voice }
    for id in pending.keys { requests[id]?.claimed = true }
    return pending.values.map(\.fields)
  }

  fileprivate static func isPending(_ id: String) -> Bool { requests[id] != nil }

  fileprivate static func finish(_ id: String, value: String = "", error: String? = nil) {
    guard let request = requests.removeValue(forKey: id) else { return }
    if let error {
      request.completion.resume(throwing: NSError(domain: "Botkins.Shortcuts", code: 1, userInfo: [NSLocalizedDescriptionKey: error]))
    } else {
      request.completion.resume(returning: value)
    }
    NotificationCenter.default.post(name: changed, object: nil, userInfo: ["finished": id])
  }
}

public final class BotkinsShortcutsModule: Module {
  private var observer: NSObjectProtocol?
  public func definition() -> ModuleDefinition {
    Name("BotkinsShortcuts")
    Events("changed")
    OnCreate {
      self.observer = NotificationCenter.default.addObserver(forName: Notification.Name("app.botkins.shortcuts.changed"), object: nil, queue: .main) { [weak self] note in
        self?.sendEvent("changed", ["finished": note.userInfo?["finished"] as? String ?? ""])
      }
    }
    OnDestroy {
      if let observer = self.observer { NotificationCenter.default.removeObserver(observer) }
    }
    AsyncFunction("take") { (voice: Bool) in await ShortcutRequests.take(voice: voice) }
    AsyncFunction("isPending") { (id: String) in await ShortcutRequests.isPending(id) }
    AsyncFunction("finish") { (id: String, value: String, error: String?) in
      await ShortcutRequests.finish(id, value: value, error: error)
    }
  }
}
