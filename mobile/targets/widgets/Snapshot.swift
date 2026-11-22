// What the Home Screen and Lock Screen widgets show: the snapshot the app writes to the App Group
// (src/state/widgetData.ts; docs/live-cards.md, section 8), and the words for plans and limits
// (the app's own, src/features/models/limits.ts).
import Foundation

struct Snapshot: Decodable {
  let v: Int
  let at: Double
  let inUse: String?
  let computers: [String: Computer]

  struct Computer: Decodable {
    let name: String
    let at: Double
    let bots: [Bot]
    let chats: [String: [Chat]]
    let usage: [Usage]?
    let usageAt: Double?
    let models: [String: String]
    /// The panels of the person's spaces ("spaces-v1"), pinned spaces first.
    let panels: [Panel]?
  }

  /// A panel of a space, as its widget draws it: its title, the one thing it says, its space and its bot's Botkin.
  struct Panel: Decodable, Hashable {
    let id: String
    let spaceId: String
    let space: String
    let title: String
    let value: String?
    let note: String?
    let head: String
    let palette: String
    let eyes: String
    /// When it last changed, in Unix seconds.
    let at: Double
  }

  struct Bot: Decodable, Hashable {
    let id: String
    let name: String
    let role: String
    let head: String
    let palette: String
    let eyes: String
    let provider: String?
    /// The avatar's state, as the app names it (sessionActivity.ts): idle, thinking, coding, waiting…
    let state: String
    let label: String
    let pinned: Bool?
    let chat: BusyChat?
    let ask: String?

    struct BusyChat: Decodable, Hashable {
      let id: String
      let title: String
      let startedAt: Double?
    }

    /// At work: anything but resting or waiting for the person.
    var working: Bool { !["idle", "waiting", "sleeping", "happy", "completed", "error", "pending"].contains(state) }
    var needsYou: Bool { state == "waiting" }
  }

  struct Chat: Decodable, Hashable {
    let id: String
    let title: String
    let provider: String?
    /// working, needs-you, done, failed or idle
    let state: String
    let label: String
    let startedAt: Double?
    let finishedAt: Double?
  }

  struct Usage: Decodable, Hashable {
    let provider: String
    let name: String?
    let plan: String?
    let account: String?
    let limits: [Limit]
    let updatedAt: Double?
    let error: String?
    let credits: Credits?

    struct Limit: Decodable, Hashable {
      let id: String
      let label: String
      let percentRemaining: Double?
      let resetAt: Double?
      let primary: Bool?
      let window: String?
      let model: String?
      let used: Double?
      let limit: Double?
      let unit: String?
      let unlimited: Bool?
    }

    struct Credits: Decodable, Hashable {
      let label: String
      let amount: Double
      let unit: String
    }
  }

  /// The snapshot the app last wrote, or nil (not paired yet, or the app never ran).
  static func load() -> Snapshot? {
    guard let group = Bundle.main.object(forInfoDictionaryKey: "BotkinsAppGroup") as? String, !group.isEmpty,
          let folder = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group),
          let data = try? Data(contentsOf: folder.appendingPathComponent("widgets.json")) else { return nil }
    return try? JSONDecoder().decode(Snapshot.self, from: data)
  }

  /// The computer in use, and its id.
  var current: (id: String, computer: Computer)? {
    guard let inUse, let computer = computers[inUse] else { return nil }
    return (inUse, computer)
  }

  /// A Botkin by its widget id ("<computer>|<bot>"), with its computer.
  func bot(_ entity: String) -> (host: String, computer: Computer, bot: Bot)? {
    let parts = entity.split(separator: "|", maxSplits: 1).map(String.init)
    guard parts.count == 2, let computer = computers[parts[0]], let bot = computer.bots.first(where: { $0.id == parts[1] }) else { return nil }
    return (parts[0], computer, bot)
  }

  /// A panel by its widget id ("<computer>|<panel>"), with its computer.
  func panel(_ entity: String) -> (host: String, computer: Computer, panel: Panel)? {
    let parts = entity.split(separator: "|", maxSplits: 1).map(String.init)
    guard parts.count == 2, let computer = computers[parts[0]], let panel = computer.panels?.first(where: { $0.id == parts[1] }) else { return nil }
    return (parts[0], computer, panel)
  }

  /// Every paired computer's part, the one in use first.
  var ordered: [(id: String, computer: Computer)] {
    computers.map { ($0.key, $0.value) }.sorted { a, b in a.id == inUse ? true : b.id == inUse ? false : a.computer.name < b.computer.name }
  }
}

// ── Links into the app (src/features/open) ────────────────────────────────────────────────────

enum Links {
  private static func url(_ path: String, _ query: [String: String?]) -> URL {
    var parts = URLComponents()
    parts.scheme = "botkins"
    parts.host = "open"
    parts.path = path
    let items = query.compactMap { key, value in value.map { URLQueryItem(name: key, value: $0) } }
    parts.queryItems = items.isEmpty ? nil : items.sorted { $0.name < $1.name }
    return parts.url ?? URL(string: "botkins://")!
  }

  static func bot(_ id: String, host: String?, opens: String? = nil) -> URL { url("/bot/" + id, ["host": host, "opens": opens]) }
  static func chat(_ id: String, host: String?) -> URL { url("/chat/" + id, ["host": host]) }
  static func answer(request: String, chat: String, host: String?) -> URL { url("/answer", ["request": request, "chat": chat, "host": host]) }
  static func usage(host: String?) -> URL { url("/usage", ["host": host]) }
  static func panel(_ id: String, space: String, host: String?) -> URL { url("/panel", ["id": id, "space": space, "host": host]) }
}

// ── Plans and limits, in the app's words (src/features/models/limits.ts) ──────────────────────

enum LimitWords {
  /// Numbers older than this say their age where they would say when the limit starts again.
  static let old: TimeInterval = 10 * 60

  /// The one limit to show where there is room for one: the one marked, else the first for every model with a number.
  static func primary(_ usage: Snapshot.Usage) -> Snapshot.Usage.Limit? {
    usage.limits.first { $0.primary == true && $0.percentRemaining != nil } ?? usage.limits.first { $0.percentRemaining != nil && $0.model == nil }
  }

  /// "62%", or "99.5%".
  static func percent(_ value: Double) -> String {
    let tenth = (value * 10).rounded() / 10
    return (tenth == tenth.rounded() ? String(Int(tenth)) : String(format: "%.1f", tenth)) + "%"
  }

  /// A limit inside a sentence: a week's limit for every model is "weekly", anything else its own label with a small first letter.
  static func noun(_ limit: Snapshot.Usage.Limit) -> String {
    if limit.window == "week" && limit.model == nil { return "weekly" }
    return limit.label.prefix(1).lowercased() + limit.label.dropFirst()
  }

  /// "2:10 PM" today, "Mon" within a week, else "Dec 1". Empty when it already has.
  static func reset(_ at: Double, now: Date) -> String {
    let date = Date(timeIntervalSince1970: at / 1000)
    guard date > now else { return "" }
    let calendar = Calendar.current
    let format = DateFormatter()
    if calendar.isDate(date, inSameDayAs: now) {
      format.timeStyle = .short
      format.dateStyle = .none
    } else if date.timeIntervalSince(now) < 7 * 24 * 3600 {
      format.setLocalizedDateFormatFromTemplate("EEE")
    } else {
      format.setLocalizedDateFormatFromTemplate("MMM d")
    }
    return format.string(from: date)
  }

  /// "just now", "5 min ago", "3 hr ago", "2 days ago".
  static func ago(_ then: Double, now: Date) -> String {
    let minutes = Int(max(0, now.timeIntervalSince1970 - then / 1000) / 60)
    if minutes < 1 { return "just now" }
    if minutes < 60 { return "\(minutes) min ago" }
    let hours = minutes / 60
    if hours < 24 { return "\(hours) hr ago" }
    let days = hours / 24
    return days == 1 ? "1 day ago" : "\(days) days ago"
  }

  /// The numbers are old (or the last read failed): say how old, not when the limit resets.
  static func stale(_ usage: Snapshot.Usage, now: Date) -> Bool {
    guard let updatedAt = usage.updatedAt else { return false }
    return usage.error != nil || now.timeIntervalSince1970 - updatedAt / 1000 > old
  }

  /// What follows the percent: "resets Mon", or "updated 3 hr ago", or nothing.
  static func tail(_ usage: Snapshot.Usage, _ limit: Snapshot.Usage.Limit, now: Date) -> String {
    if stale(usage, now: now), let updatedAt = usage.updatedAt { return "updated " + ago(updatedAt, now: now) }
    if let resetAt = limit.resetAt { let words = reset(resetAt, now: now); if !words.isEmpty { return "resets " + words } }
    return ""
  }

  /// "570 of 1,500 requests used" ("570 of 1,500 used" without the unit, where room is short).
  static func counts(_ limit: Snapshot.Usage.Limit, unit: Bool = true) -> String? {
    guard let used = limit.used, let most = limit.limit else { return nil }
    let format = NumberFormatter()
    format.numberStyle = .decimal
    format.maximumFractionDigits = 0
    let a = format.string(from: NSNumber(value: used)) ?? "\(Int(used))"
    let b = format.string(from: NSNumber(value: most)) ?? "\(Int(most))"
    return a + " of " + b + (unit ? limit.unit.map { " " + $0 } ?? "" : "") + " used"
  }

  /// A tenth or less is low, nothing is out.
  static func low(_ percent: Double) -> Bool { percent <= 10 }

  /// The provider's own name, as the app shows it.
  static func providerName(_ usage: Snapshot.Usage) -> String {
    usage.name ?? providerNames[usage.provider] ?? usage.provider
  }

  static let providerNames = ["copilot": "Copilot", "codex": "ChatGPT", "claude": "Claude", "opencode": "OpenCode", "grok": "Grok", "kiro": "Kiro", "antigravity": "Antigravity", "fx": "fx", "cursor": "Cursor", "pi": "Pi", "omp": "OMP"]
}
