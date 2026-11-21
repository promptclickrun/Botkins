// Live Activities, the key sealed notifications are opened with, answers given away from the app,
// and what the widgets show.
//
//   enabled()                          Live Activities are allowed for this app
//   start(about, state) -> id          starts a chat's card (the app must be in front)
//   update(chatId, state), end(chatId, state?, lingerSeconds), running() -> [key]
//   startCard(about, state, detail, host, relevance) -> id     a Botkin's card ("activity-bots-v1")
//   updateCard(key, state, detail, host, relevance), endCard(key, lingerSeconds)
//   tokens() -> [{ chatId: key, token }]   the address of every activity that has one now
//   setPushKey(base64 | null)          keeps the key where the notification extension can read it
//   setPushKeys([{ host, key }])       keeps one key for each paired computer, in place of all kept before
//   takeAnswers() -> [answer], answered(id, ok)   answers given on a card, the island or a notification
//   setWidgetData(json), getWidgetData() -> json?, installedWidgets() -> [kind]
//   events: token { chatId, token }    Apple's address for one activity's updates (chatId is the card's key)
//           startToken { token }       the address that can start an activity from afar (iOS 17.2)
//           ended { chatId }
//           answer { ...answer }       an answer was given while the app runs
//
// The views are in targets/widgets. Both sides share BotkinActivityAttributes. A card's key is the
// chat's id, or "bot:" and the Botkin's id for a Botkin's card.
import ActivityKit
import CryptoKit
import ExpoModulesCore
import Security
import WidgetKit

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
/// What a card's sealed part is authenticated as (link-host/cards.mjs, CARD_AAD).
private let cardAAD = Data("botkins-card-v1".utf8)

private func hex(_ data: Data) -> String {
  data.map { String(format: "%02x", $0) }.joined()
}

private func live(_ activity: Activity<BotkinActivityAttributes>) -> Bool {
  activity.activityState == .active || activity.activityState == .stale
}

public final class BotkinsActivityModule: Module {
  private let lock = NSLock()
  private var followed = Set<String>()
  private var tasks: [Task<Void, Never>] = []
  private var observer: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("BotkinsActivity")

    Events("token", "startToken", "ended", "answer")

    OnCreate {
      // An answer given while the app runs (an App Intent, a notification's action) goes to JavaScript at once.
      self.observer = NotificationCenter.default.addObserver(forName: AnswerQueue.queued, object: nil, queue: nil) { [weak self] note in
        guard let item = note.userInfo as? [String: Any] else { return }
        self?.sendEvent("answer", item)
        if let card = item["card"] as? String, let words = item["words"] as? String { Task { await markSent(card, words) } }
      }
      // Answers given before the app was running (it was launched to send them) show on their cards too.
      let waiting = AnswerQueue.pending().compactMap { item -> (String, String)? in
        guard let card = item["card"] as? String, let words = item["words"] as? String else { return nil }
        return (card, words)
      }
      if !waiting.isEmpty { Task { for (card, words) in waiting { await markSent(card, words) } } }
    }

    Function("enabled") { () -> Bool in
      ActivityAuthorizationInfo().areActivitiesEnabled
    }

    // ── A chat's card ──────────────────────────────────────────────────────────────────────────

    AsyncFunction("start") { (about: AboutRecord, state: StateRecord) -> String in
      guard ActivityAuthorizationInfo().areActivitiesEnabled else {
        throw Exception(name: "E_ACTIVITIES_OFF", description: "Live Activities are off for Botkins in Settings.")
      }
      // One activity for a chat.
      for old in Activity<BotkinActivityAttributes>.activities where old.attributes.key == about.chatId {
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
      for activity in Activity<BotkinActivityAttributes>.activities where activity.attributes.key == chatId {
        await activity.update(content)
      }
    }

    AsyncFunction("end") { (chatId: String, state: StateRecord?, lingerSeconds: Double) in
      let content = state.map { ActivityContent(state: $0.value, staleDate: nil) }
      for activity in Activity<BotkinActivityAttributes>.activities where activity.attributes.key == chatId {
        await activity.end(content, dismissalPolicy: lingerSeconds > 0 ? .after(Date().addingTimeInterval(lingerSeconds)) : .immediate)
      }
    }

    // ── A Botkin's card ("activity-bots-v1") ───────────────────────────────────────────────────

    AsyncFunction("startCard") { (about: AboutRecord, state: String, detail: String?, host: String?, relevance: Double) -> String in
      guard ActivityAuthorizationInfo().areActivitiesEnabled else {
        throw Exception(name: "E_ACTIVITIES_OFF", description: "Live Activities are off for Botkins in Settings.")
      }
      let key = "bot:" + about.botId
      // One card for a Botkin.
      for old in Activity<BotkinActivityAttributes>.activities where old.attributes.key == key {
        await old.end(nil, dismissalPolicy: .immediate)
      }
      let attributes = BotkinActivityAttributes(chatId: "", botId: about.botId, botName: about.botName, head: about.head, palette: about.palette, eyes: about.eyes, colors: about.colors, card: "bot")
      let content = ActivityContent(state: try cardState(state, detail: detail, host: host), staleDate: Date().addingTimeInterval(staleAfter), relevanceScore: relevance)
      let activity = try Activity.request(attributes: attributes, content: content, pushType: .token)
      self.follow(activity)
      return activity.id
    }

    AsyncFunction("updateCard") { (key: String, state: String, detail: String?, host: String?, relevance: Double) in
      let next = try cardState(state, detail: detail, host: host)
      for activity in Activity<BotkinActivityAttributes>.activities where activity.attributes.key == key && live(activity) {
        // A card that says done stays a while without being shown as out of date.
        let over = (next.chats ?? []).allSatisfy { $0.phase == "done" || $0.phase == "failed" }
        await activity.update(ActivityContent(state: next, staleDate: Date().addingTimeInterval(over ? 31 * 60 : staleAfter), relevanceScore: relevance))
      }
    }

    AsyncFunction("endCard") { (key: String, lingerSeconds: Double) in
      for activity in Activity<BotkinActivityAttributes>.activities where activity.attributes.key == key {
        await activity.end(nil, dismissalPolicy: lingerSeconds > 0 ? .after(Date().addingTimeInterval(lingerSeconds)) : .immediate)
      }
    }

    AsyncFunction("running") { () -> [String] in
      Activity<BotkinActivityAttributes>.activities.filter(live).map { $0.attributes.key }
    }

    // Asked for when the app starts and when the computer is reached again: an address that came
    // while nothing was listening, or could not be passed on then, is not lost.
    AsyncFunction("tokens") { () -> [[String: String]] in
      Activity<BotkinActivityAttributes>.activities
        .filter(live)
        .compactMap { activity in
          guard let token = activity.pushToken else { return nil }
          return ["chatId": activity.attributes.key, "token": hex(token)]
        }
    }

    AsyncFunction("setPushKey") { (base64: String?) in
      try self.savePushKey(base64)
    }

    AsyncFunction("setPushKeys") { (keys: [[String: String]]) in
      try self.savePushKeys(keys)
    }

    // ── Answers given away from the app ────────────────────────────────────────────────────────

    AsyncFunction("takeAnswers") { () -> [[String: Any]] in
      AnswerQueue.pending()
    }

    AsyncFunction("answered") { (id: String, ok: Bool) in
      let item = AnswerQueue.finish(id)
      // Refused or not sent: the card gets its buttons back.
      if !ok, let card = item?["card"] as? String { await markSent(card, nil) }
      NotificationCenter.default.post(name: AnswerQueue.done, object: nil, userInfo: ["id": id, "ok": ok])
    }

    // ── Widgets ────────────────────────────────────────────────────────────────────────────────

    AsyncFunction("setWidgetData") { (json: String) in
      guard let url = widgetFile() else { return }
      try Data(json.utf8).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      WidgetCenter.shared.reloadAllTimelines()
    }

    AsyncFunction("getWidgetData") { () -> String? in
      guard let url = widgetFile(), let data = try? Data(contentsOf: url) else { return nil }
      return String(data: data, encoding: .utf8)
    }

    AsyncFunction("installedWidgets") { (promise: Promise) in
      WidgetCenter.shared.getCurrentConfigurations { result in
        promise.resolve(Array(Set((try? result.get())?.map { $0.kind } ?? [])))
      }
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
      if let observer = self.observer { NotificationCenter.default.removeObserver(observer) }
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
        // One activity for a chat or a Botkin: a new one (a push started it) takes the place of an earlier one.
        for old in Activity<BotkinActivityAttributes>.activities where old.id != activity.id && old.attributes.key == activity.attributes.key {
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
    let key = activity.attributes.key
    // An activity a push started while the app was closed has its address already, and
    // `pushTokenUpdates` tells only of changes: the address it has now is passed on first.
    if let token = activity.pushToken {
      sendEvent("token", ["chatId": key, "token": hex(token)])
    }
    let tokens = Task { [weak self] in
      for await token in activity.pushTokenUpdates {
        self?.sendEvent("token", ["chatId": key, "token": hex(token)])
      }
    }
    let states = Task { [weak self] in
      for await state in activity.activityStateUpdates where state == .ended || state == .dismissed {
        self?.sendEvent("ended", ["chatId": key])
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

// ── A Botkin's card, as the phone draws it ────────────────────────────────────────────────────

/// The card's state from JSON (link-host/cards.d.mts, CardState), with its detail sealed for this phone.
private func cardState(_ json: String, detail: String?, host: String?) throws -> BotkinActivityAttributes.ContentState {
  guard var state = try? JSONDecoder().decode(BotkinActivityAttributes.ContentState.self, from: Data(json.utf8)) else {
    throw Exception(name: "E_CARD", description: "That isn't a card's state.")
  }
  state.sealed = nil
  state.sent = nil
  // The detail is the bot's words: sealed like the computer seals it, so the extension opens
  // whichever side drew the card in one way, and nothing in the clear sits in the system's store.
  if let detail, let key = pushKey(host) {
    let box = try? ChaChaPoly.seal(Data(detail.utf8), using: SymmetricKey(data: key), authenticating: cardAAD)
    state.sealed = box?.combined.base64EncodedString()
  }
  return state
}

/// The push key of computer `host` (or the single key a build before several computers kept).
private func pushKey(_ host: String?) -> Data? {
  var query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: keyService,
    kSecReturnAttributes as String: true,
    kSecReturnData as String: true,
    kSecMatchLimit as String: kSecMatchLimitAll,
  ]
  if let group = Bundle.main.object(forInfoDictionaryKey: "BotkinsKeychainGroup") as? String, !group.isEmpty {
    query[kSecAttrAccessGroup as String] = group
  }
  var found: CFTypeRef?
  guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess, let items = found as? [[String: Any]] else { return nil }
  var single: Data?
  for item in items {
    guard let key = item[kSecValueData as String] as? Data, key.count == 32, let account = item[kSecAttrAccount as String] as? String else { continue }
    if let host, account == keyAccount + ":" + host { return key }
    if account == keyAccount { single = key }
  }
  return single
}

/// Shows on a card that an answer was given ("Sent: Allow once"), or with nil takes that back.
/// Only on this phone: the computer's next update replaces it.
private func markSent(_ card: String, _ words: String?) async {
  for activity in Activity<BotkinActivityAttributes>.activities where activity.attributes.key == card && live(activity) {
    var state = activity.content.state
    state.sent = words
    await activity.update(ActivityContent(state: state, staleDate: activity.content.staleDate, relevanceScore: activity.content.relevanceScore))
  }
}

/// widgets.json in the App Group the widgets read (BotkinsAppGroup in Info.plist).
private func widgetFile() -> URL? {
  guard let group = Bundle.main.object(forInfoDictionaryKey: "BotkinsAppGroup") as? String, !group.isEmpty,
        let folder = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) else { return nil }
  return folder.appendingPathComponent("widgets.json")
}
