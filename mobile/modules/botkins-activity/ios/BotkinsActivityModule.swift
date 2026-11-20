// Live Activities for a chat's running turn, and the key sealed notifications are opened with.
//
//   enabled()                          Live Activities are allowed for this app
//   start(about, state) -> id          starts one for a chat (the app must be in front)
//   update(chatId, state), end(chatId, state?, lingerSeconds), running() -> [chatId]
//   tokens() -> [{ chatId, token }]    the address of every activity that has one now
//   setPushKey(base64 | null)          keeps the key where the notification extension can read it
//   setPushKeys([{ host, key }])       keeps one key for each paired computer, in place of all kept before
//   events: token { chatId, token }    Apple's address for one activity's updates
//           startToken { token }       the address that can start an activity from afar (iOS 17.2)
//           ended { chatId }
//
// The views are in targets/widgets. Both sides share BotkinActivityAttributes.
import ActivityKit
import ExpoModulesCore
import Security

struct AboutRecord: Record {
  @Field var chatId: String = ""
  @Field var botId: String = ""
  @Field var botName: String = ""
  @Field var head: String = ""
  @Field var palette: String = "original"
  @Field var eyes: String = "oval"
  @Field var colors: [String] = []
}

struct StateRecord: Record {
  @Field var phase: String = "thinking"
  @Field var label: String = ""
  @Field var steps: Int = 0
  @Field var startedAt: Double = 0
  @Field var finishedAt: Double = 0

  var value: BotkinActivityAttributes.ContentState {
    BotkinActivityAttributes.ContentState(phase: phase, label: label, steps: steps, startedAt: startedAt > 0 ? startedAt : Date().timeIntervalSince1970, finishedAt: finishedAt > 0 ? finishedAt : nil)
  }
}

private let staleAfter: TimeInterval = 15 * 60
private let keyService = "app.botkins.push"
private let keyAccount = "key"

private func hex(_ data: Data) -> String {
  data.map { String(format: "%02x", $0) }.joined()
}

public final class BotkinsActivityModule: Module {
  private let lock = NSLock()
  private var followed = Set<String>()
  private var tasks: [Task<Void, Never>] = []

  public func definition() -> ModuleDefinition {
    Name("BotkinsActivity")

    Events("token", "startToken", "ended")

    Function("enabled") { () -> Bool in
      ActivityAuthorizationInfo().areActivitiesEnabled
    }

    AsyncFunction("start") { (about: AboutRecord, state: StateRecord) -> String in
      guard ActivityAuthorizationInfo().areActivitiesEnabled else {
        throw Exception(name: "E_ACTIVITIES_OFF", description: "Live Activities are off for Botkins in Settings.")
      }
      // One activity for a chat.
      for old in Activity<BotkinActivityAttributes>.activities where old.attributes.chatId == about.chatId {
        await old.end(nil, dismissalPolicy: .immediate)
      }
      let attributes = BotkinActivityAttributes(chatId: about.chatId, botId: about.botId, botName: about.botName, head: about.head, palette: about.palette, eyes: about.eyes, colors: about.colors)
      let content = ActivityContent(state: state.value, staleDate: Date().addingTimeInterval(staleAfter))
      let activity = try Activity.request(attributes: attributes, content: content, pushType: .token)
      self.follow(activity)
      return activity.id
    }

    AsyncFunction("update") { (chatId: String, state: StateRecord) in
      let content = ActivityContent(state: state.value, staleDate: Date().addingTimeInterval(staleAfter))
      for activity in Activity<BotkinActivityAttributes>.activities where activity.attributes.chatId == chatId {
        await activity.update(content)
      }
    }

    AsyncFunction("end") { (chatId: String, state: StateRecord?, lingerSeconds: Double) in
      let content = state.map { ActivityContent(state: $0.value, staleDate: nil) }
      for activity in Activity<BotkinActivityAttributes>.activities where activity.attributes.chatId == chatId {
        await activity.end(content, dismissalPolicy: lingerSeconds > 0 ? .after(Date().addingTimeInterval(lingerSeconds)) : .immediate)
      }
    }

    AsyncFunction("running") { () -> [String] in
      Activity<BotkinActivityAttributes>.activities.filter { $0.activityState == .active || $0.activityState == .stale }.map { $0.attributes.chatId }
    }

    // Asked for when the app starts and when the computer is reached again: an address that came
    // while nothing was listening, or could not be passed on then, is not lost.
    AsyncFunction("tokens") { () -> [[String: String]] in
      Activity<BotkinActivityAttributes>.activities
        .filter { $0.activityState == .active || $0.activityState == .stale }
        .compactMap { activity in
          guard let token = activity.pushToken else { return nil }
          return ["chatId": activity.attributes.chatId, "token": hex(token)]
        }
    }

    AsyncFunction("setPushKey") { (base64: String?) in
      try self.savePushKey(base64)
    }

    AsyncFunction("setPushKeys") { (keys: [[String: String]]) in
      try self.savePushKeys(keys)
    }

    // Tokens are followed only while JavaScript is listening.
    OnStartObserving {
      self.observe()
    }
    OnDestroy {
      self.lock.lock()
      let all = self.tasks
      self.tasks.removeAll()
      self.followed.removeAll()
      self.lock.unlock()
      for task in all { task.cancel() }
    }
  }

  /// Follows every activity of ours, also the ones a push started while the app was closed.
  private func observe() {
    lock.lock()
    let first = tasks.isEmpty
    lock.unlock()
    guard first else { return }
    var started: [Task<Void, Never>] = []
    started.append(Task { [weak self] in
      for await activity in Activity<BotkinActivityAttributes>.activityUpdates {
        // One activity for a chat: a new one (a push started it) takes the place of an earlier one.
        for old in Activity<BotkinActivityAttributes>.activities where old.id != activity.id && old.attributes.chatId == activity.attributes.chatId {
          await old.end(nil, dismissalPolicy: .immediate)
        }
        self?.follow(activity)
      }
    })
    if #available(iOS 17.2, *) {
      started.append(Task { [weak self] in
        for await token in Activity<BotkinActivityAttributes>.pushToStartTokenUpdates {
          self?.sendEvent("startToken", ["token": hex(token)])
        }
      })
    }
    lock.lock()
    tasks.append(contentsOf: started)
    lock.unlock()
    for activity in Activity<BotkinActivityAttributes>.activities { follow(activity) }
  }

  private func follow(_ activity: Activity<BotkinActivityAttributes>) {
    lock.lock()
    let fresh = followed.insert(activity.id).inserted
    lock.unlock()
    guard fresh else { return }
    let chatId = activity.attributes.chatId
    // An activity a push started while the app was closed has its address already, and
    // `pushTokenUpdates` tells only of changes: the address it has now is passed on first.
    if let token = activity.pushToken {
      sendEvent("token", ["chatId": chatId, "token": hex(token)])
    }
    let tokens = Task { [weak self] in
      for await token in activity.pushTokenUpdates {
        self?.sendEvent("token", ["chatId": chatId, "token": hex(token)])
      }
    }
    let states = Task { [weak self] in
      for await state in activity.activityStateUpdates where state == .ended || state == .dismissed {
        self?.sendEvent("ended", ["chatId": chatId])
        break
      }
    }
    lock.lock()
    tasks.append(tokens)
    tasks.append(states)
    lock.unlock()
  }

  /// One key for each paired computer, each in an entry named "key:<the computer's id>". Every key
  /// kept before goes first (the single "key" of a build before several computers too), so a
  /// computer that was unpaired leaves nothing behind. An empty list removes them all.
  private func savePushKeys(_ keys: [[String: String]]) throws {
    var all: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: keyService,
    ]
    let group = Bundle.main.object(forInfoDictionaryKey: "BotkinsKeychainGroup") as? String
    if let group, !group.isEmpty { all[kSecAttrAccessGroup as String] = group }
    SecItemDelete(all as CFDictionary)
    for entry in keys {
      guard let host = entry["host"], !host.isEmpty, let base64 = entry["key"], let key = Data(base64Encoded: base64), key.count == 32 else { continue }
      var item = all
      item[kSecAttrAccount as String] = keyAccount + ":" + host
      item[kSecValueData as String] = key
      // A notification can arrive while the phone is locked.
      item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
      let status = SecItemAdd(item as CFDictionary, nil)
      if status != errSecSuccess {
        throw Exception(name: "E_KEYCHAIN", description: "A notification key could not be saved (\(status)).")
      }
    }
  }

  /// The key lives in a keychain group the notification extension shares (BotkinsKeychainGroup in Info.plist).
  private func savePushKey(_ base64: String?) throws {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: keyService,
      kSecAttrAccount as String: keyAccount,
    ]
    if let group = Bundle.main.object(forInfoDictionaryKey: "BotkinsKeychainGroup") as? String, !group.isEmpty {
      query[kSecAttrAccessGroup as String] = group
    }
    SecItemDelete(query as CFDictionary)
    guard let base64, let key = Data(base64Encoded: base64), key.count == 32 else { return }
    query[kSecValueData as String] = key
    // A notification can arrive while the phone is locked.
    query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(query as CFDictionary, nil)
    if status != errSecSuccess {
      throw Exception(name: "E_KEYCHAIN", description: "The notification key could not be saved (\(status)).")
    }
  }
}
