// The Home Screen and Lock Screen widgets (the mockups in design/mockups/widgets-live-activities.html):
//   BotkinWidget  one Botkin; a tap opens its last chat, a new chat, or talking (Edit Widget)
//   CrewWidget    the Botkins at a glance, and what needs the person
//   UsageWidget   what is left of each provider's plan, in the app's own words
// They read the snapshot the app writes (Snapshot.swift). Timers count by themselves; the app asks
// iOS to draw them again when something changes.
import AppIntents
import SwiftUI
import WidgetKit

private let refresh: TimeInterval = 15 * 60
private let ink = Color.primary
private let mutedInk = Color.secondary
private let amberInk = Color(light: "#9A6200", dark: "#F0BE5E")
private let okInk = Color(light: "#2E7D4A", dark: "#8FD0A2")
private let badInk = Color(light: "#B3261E", dark: "#FF9E94")

extension Color {
  init(light: String, dark: String) {
    self.init(UIColor { $0.userInterfaceStyle == .dark ? UIColor(Color(hex: dark)) : UIColor(Color(hex: light)) })
  }
}

/// The eyes a Botkin shows for its state (sessionActivity.ts names them).
private func eyesFor(_ bot: Snapshot.Bot) -> String {
  switch bot.state {
  case "waiting", "thinking", "listening": return "curious"
  case "happy", "completed": return "smile"
  case "sleeping", "pending": return "sleepy"
  default: return bot.eyes
  }
}

private func face(_ bot: Snapshot.Bot, _ size: CGFloat) -> some View {
  BotkinFace(look: Look(head: bot.head, palette: bot.palette, eyes: bot.eyes), expression: eyesFor(bot), size: size)
}

// ── Choosing what a widget shows (Edit Widget) ─────────────────────────────────────────────────

@available(iOS 17.0, *)
struct BotkinEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Botkin"
  static let defaultQuery = BotkinQuery()
  /// "<computer id>|<bot id>"
  let id: String
  let name: String
  let computer: String
  /// The Botkin's character, for a control's symbol.
  let head: String
  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)", subtitle: "\(computer)") }
}

@available(iOS 17.0, *)
struct BotkinQuery: EntityQuery {
  func entities(for identifiers: [String]) async throws -> [BotkinEntity] { all().filter { identifiers.contains($0.id) } }
  func suggestedEntities() async throws -> [BotkinEntity] { all() }
  func defaultResult() async -> BotkinEntity? { all().first }
  private func all() -> [BotkinEntity] {
    guard let snapshot = Snapshot.load() else { return [] }
    return snapshot.ordered.flatMap { id, computer in computer.bots.map { BotkinEntity(id: id + "|" + $0.id, name: $0.name, computer: computer.name, head: $0.head) } }
  }
}

@available(iOS 17.0, *)
enum BotkinOpens: String, AppEnum {
  case last, new, talk
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Opens"
  static let caseDisplayRepresentations: [BotkinOpens: DisplayRepresentation] = [.last: "Last chat", .new: "New chat", .talk: "Talk"]
}

@available(iOS 17.0, *)
struct BotkinConfiguration: WidgetConfigurationIntent {
  static let title: LocalizedStringResource = "Botkin"
  static let description = IntentDescription("Opens one Botkin in a tap.")
  @Parameter(title: "Botkin") var botkin: BotkinEntity?
  @Parameter(title: "Opens", default: .last) var opens: BotkinOpens
  @Parameter(title: "Show its plan", default: false) var plan: Bool
}

@available(iOS 17.0, *)
struct ProviderEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Provider"
  static let defaultQuery = ProviderQuery()
  let id: String
  let name: String
  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

@available(iOS 17.0, *)
struct ProviderQuery: EntityQuery {
  func entities(for identifiers: [String]) async throws -> [ProviderEntity] { all().filter { identifiers.contains($0.id) } }
  func suggestedEntities() async throws -> [ProviderEntity] { all() }
  func defaultResult() async -> ProviderEntity? { all().first }
  private func all() -> [ProviderEntity] {
    (Snapshot.load()?.current?.computer.usage ?? []).map { ProviderEntity(id: $0.provider, name: LimitWords.providerName($0)) }
  }
}

@available(iOS 17.0, *)
struct UsageConfiguration: WidgetConfigurationIntent {
  static let title: LocalizedStringResource = "Plans and limits"
  static let description = IntentDescription("What is left of a provider's plan.")
  @Parameter(title: "Provider") var provider: ProviderEntity?
}

// ── One Botkin ─────────────────────────────────────────────────────────────────────────────────

@available(iOS 17.0, *)
struct BotkinEntry: TimelineEntry {
  let date: Date
  let snapshot: Snapshot?
  let configuration: BotkinConfiguration
}

@available(iOS 17.0, *)
struct BotkinProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> BotkinEntry { BotkinEntry(date: .now, snapshot: nil, configuration: BotkinConfiguration()) }
  func snapshot(for configuration: BotkinConfiguration, in context: Context) async -> BotkinEntry { BotkinEntry(date: .now, snapshot: Snapshot.load(), configuration: configuration) }
  func timeline(for configuration: BotkinConfiguration, in context: Context) async -> Timeline<BotkinEntry> {
    Timeline(entries: [BotkinEntry(date: .now, snapshot: Snapshot.load(), configuration: configuration)], policy: .after(.now.addingTimeInterval(refresh)))
  }
}

@available(iOS 17.0, *)
struct BotkinWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(kind: "BotkinsBot", intent: BotkinConfiguration.self, provider: BotkinProvider()) { entry in
      BotkinWidgetView(entry: entry)
    }
    .configurationDisplayName("Botkin")
    .description("Open one Botkin in a tap.")
    .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
  }
}

@available(iOS 17.0, *)
struct BotkinWidgetView: View {
  let entry: BotkinEntry
  @Environment(\.widgetFamily) private var family

  private var found: (host: String, computer: Snapshot.Computer, bot: Snapshot.Bot)? {
    guard let snapshot = entry.snapshot else { return nil }
    if let id = entry.configuration.botkin?.id { return snapshot.bot(id) }
    guard let current = snapshot.current, let bot = current.computer.bots.first else { return nil }
    return (current.id, current.computer, bot)
  }

  var body: some View {
    Group {
      if let found {
        content(host: found.host, computer: found.computer, bot: found.bot)
          .widgetURL(Links.bot(found.bot.id, host: found.host, opens: entry.configuration.opens.rawValue))
      } else {
        empty
      }
    }
    .containerBackground(for: .widget) { Color(.systemBackground) }
  }

  @ViewBuilder private var empty: some View {
    switch family {
    case .accessoryInline: Text("Choose a Botkin")
    case .accessoryCircular, .accessoryRectangular: ZStack { AccessoryWidgetBackground(); Image(systemName: "plus") }
    default:
      VStack(spacing: 8) {
        Image(systemName: "plus.circle").font(.system(size: 28)).foregroundStyle(mutedInk)
        Text(entry.snapshot == nil ? "Open Botkins to pair" : "Choose a Botkin").font(.system(size: 13)).foregroundStyle(mutedInk).multilineTextAlignment(.center)
      }
      .widgetURL(URL(string: "botkins://"))
    }
  }

  @ViewBuilder private func content(host: String, computer: Snapshot.Computer, bot: Snapshot.Bot) -> some View {
    switch family {
    case .accessoryInline:
      Text(bot.name + " · " + (bot.needsYou ? "Needs you" : bot.label))
    case .accessoryCircular:
      ZStack {
        AccessoryWidgetBackground()
        face(bot, 50)
      }
      .overlay(alignment: .topTrailing) { if bot.needsYou { Image(systemName: "exclamationmark.circle.fill").font(.system(size: 14)) } }
    case .accessoryRectangular:
      VStack(alignment: .leading, spacing: 1) {
        HStack(spacing: 6) {
          face(bot, 28)
          VStack(alignment: .leading, spacing: 0) {
            Text(bot.name).font(.headline).lineLimit(1)
            HStack(spacing: 3) {
              Text(bot.needsYou ? "Needs you" : bot.label).lineLimit(1)
              if bot.working, let since = bot.chat?.startedAt { Running(since: since).frame(maxWidth: 40, alignment: .leading) }
            }
            .font(.caption)
          }
        }
        if let title = bot.chat?.title { Text(title).font(.caption).lineLimit(1).privacySensitive() }
      }
    case .systemMedium:
      MediumBotkin(host: host, computer: computer, bot: bot, plan: entry.configuration.plan)
    default:
      SmallBotkin(computer: computer, bot: bot, opens: entry.configuration.opens, plan: entry.configuration.plan, date: entry.date)
    }
  }
}

@available(iOS 17.0, *)
private struct SmallBotkin: View {
  let computer: Snapshot.Computer
  let bot: Snapshot.Bot
  let opens: BotkinOpens
  let plan: Bool
  let date: Date

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .top) {
        face(bot, 64).padding(.leading, -6).padding(.top, -4)
        Spacer(minLength: 0)
        if bot.needsYou {
          Image(systemName: "questionmark.circle").font(.system(size: 18, weight: .semibold)).foregroundStyle(amberInk)
        } else if bot.working, let since = bot.chat?.startedAt {
          Running(since: since).font(.system(size: 14, weight: .semibold)).frame(maxWidth: 52, alignment: .trailing)
        } else if opens == .talk {
          Image(systemName: "mic.fill").font(.system(size: 14, weight: .semibold)).foregroundStyle(Color(.systemBackground)).frame(width: 32, height: 32).background(Circle().fill(ink))
        } else {
          ProviderMark(id: bot.provider, size: 15).foregroundStyle(ink)
        }
      }
      Spacer(minLength: 0)
      Text(bot.name).font(.system(size: 17, weight: .semibold)).lineLimit(1)
      if bot.needsYou {
        Text("Needs you").font(.system(size: 12.5, weight: .semibold)).foregroundStyle(amberInk)
        if let ask = bot.ask { Text(ask).font(.system(size: 11)).foregroundStyle(.tertiary).lineLimit(1).privacySensitive() }
      } else if bot.working {
        HStack(spacing: 5) {
          Circle().fill(okInk).frame(width: 7, height: 7)
          Text(bot.label).lineLimit(1)
        }
        .font(.system(size: 12.5)).foregroundStyle(mutedInk)
        if let title = bot.chat?.title { Text(title).font(.system(size: 11)).foregroundStyle(.tertiary).lineLimit(1).privacySensitive() }
      } else if plan, let usage = computer.usage?.first(where: { $0.provider == bot.provider }), let limit = LimitWords.primary(usage), let left = limit.percentRemaining {
        Text(LimitWords.percent(left) + " of " + LimitWords.noun(limit) + " left").font(.system(size: 11)).foregroundStyle(LimitWords.low(left) ? badInk : mutedInk).lineLimit(1).padding(.vertical, 3)
        UsageBar(left: left)
      } else {
        Text(opens == .talk ? "Tap to talk" : bot.role).font(.system(size: 12.5)).foregroundStyle(mutedInk).lineLimit(1)
      }
    }
  }
}

@available(iOS 17.0, *)
private struct MediumBotkin: View {
  let host: String
  let computer: Snapshot.Computer
  let bot: Snapshot.Bot
  let plan: Bool

  var body: some View {
    HStack(alignment: .top, spacing: 14) {
      VStack(alignment: .leading, spacing: 2) {
        face(bot, 62).padding(.leading, -6).padding(.top, -4)
        Text(bot.name).font(.system(size: 17, weight: .semibold)).lineLimit(1)
        Spacer(minLength: 0)
        Link(destination: Links.bot(bot.id, host: host, opens: "new")) {
          Label("New chat", systemImage: "plus").font(.system(size: 12.5, weight: .semibold)).foregroundStyle(Color(.systemBackground))
            .padding(.horizontal, 10).frame(height: 28).background(Capsule().fill(ink))
        }
      }
      .frame(width: 96, alignment: .leading)
      VStack(spacing: 0) {
        let chats = computer.chats[bot.id] ?? []
        if chats.isEmpty {
          Text(bot.role).font(.system(size: 13)).foregroundStyle(mutedInk).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
        ForEach(Array(chats.enumerated()), id: \.element.id) { index, chat in
          Link(destination: Links.chat(chat.id, host: host)) {
            HStack(spacing: 9) {
              VStack(alignment: .leading, spacing: 1) {
                Text(chat.title).font(.system(size: 13.5, weight: .semibold)).lineLimit(1).privacySensitive()
                HStack(spacing: 4) {
                  if chat.state == "working" { Circle().fill(okInk).frame(width: 6, height: 6) }
                  Text(chatLine(chat)).lineLimit(1)
                  if chat.state == "working", let since = chat.startedAt { Running(since: since).frame(maxWidth: 40, alignment: .leading).foregroundStyle(.tertiary) }
                }
                .font(.system(size: 11)).foregroundStyle(chat.state == "working" ? okInk : chat.state == "needs-you" ? amberInk : mutedInk)
              }
              Spacer(minLength: 4)
              ProviderMark(id: chat.provider, size: 13).foregroundStyle(ink)
            }
            .padding(.vertical, 6)
          }
          if index < chats.count - 1 { Divider() }
        }
      }
    }
  }

  private func chatLine(_ chat: Snapshot.Chat) -> String {
    if chat.state == "done", let end = chat.finishedAt {
      return "Done · " + Date(timeIntervalSince1970: end).formatted(date: .omitted, time: .shortened)
    }
    return chat.label.isEmpty ? " " : chat.label
  }
}

// ── The crew ───────────────────────────────────────────────────────────────────────────────────

@available(iOS 17.0, *)
struct CrewEntry: TimelineEntry {
  let date: Date
  let snapshot: Snapshot?
}

@available(iOS 17.0, *)
struct CrewProvider: TimelineProvider {
  func placeholder(in context: Context) -> CrewEntry { CrewEntry(date: .now, snapshot: nil) }
  func getSnapshot(in context: Context, completion: @escaping (CrewEntry) -> Void) { completion(CrewEntry(date: .now, snapshot: Snapshot.load())) }
  func getTimeline(in context: Context, completion: @escaping (Timeline<CrewEntry>) -> Void) {
    completion(Timeline(entries: [CrewEntry(date: .now, snapshot: Snapshot.load())], policy: .after(.now.addingTimeInterval(refresh))))
  }
}

@available(iOS 17.0, *)
struct CrewWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "BotkinsCrew", provider: CrewProvider()) { entry in
      CrewView(entry: entry)
    }
    .configurationDisplayName("Botkins")
    .description("Your Botkins at a glance, and what needs you.")
    .supportedFamilies([.systemMedium, .systemLarge])
  }
}

@available(iOS 17.0, *)
private struct CrewView: View {
  let entry: CrewEntry
  @Environment(\.widgetFamily) private var family

  var body: some View {
    Group {
      if let current = entry.snapshot?.current, !current.computer.bots.isEmpty {
        if family == .systemLarge {
          LargeCrew(host: current.id, computer: current.computer, named: (entry.snapshot?.computers.count ?? 0) > 1)
        } else {
          HStack(alignment: .top, spacing: 0) {
            ForEach(current.computer.bots.prefix(4), id: \.id) { bot in
              Link(destination: Links.bot(bot.id, host: current.id)) { CrewMember(bot: bot, size: 62) }
                .frame(maxWidth: .infinity)
            }
          }
        }
      } else {
        Text(entry.snapshot == nil ? "Open Botkins to pair" : "No Botkins yet").font(.system(size: 13)).foregroundStyle(mutedInk)
      }
    }
    .widgetURL(URL(string: "botkins://"))
    .containerBackground(for: .widget) { Color(.systemBackground) }
  }
}

@available(iOS 17.0, *)
private struct CrewMember: View {
  let bot: Snapshot.Bot
  let size: CGFloat

  var body: some View {
    VStack(spacing: 2) {
      face(bot, size)
      Text(bot.name).font(.system(size: 13.5, weight: .semibold)).lineLimit(1).padding(.top, 4)
      Text(bot.needsYou ? "Needs you" : bot.label).font(.system(size: 11, weight: bot.needsYou ? .semibold : .regular))
        .foregroundStyle(bot.needsYou ? amberInk : bot.working ? okInk : mutedInk).lineLimit(1)
      if bot.working, let since = bot.chat?.startedAt {
        Running(since: since).font(.system(size: 11)).foregroundStyle(.tertiary).multilineTextAlignment(.center).frame(maxWidth: 60)
      }
    }
    .multilineTextAlignment(.center)
  }
}

@available(iOS 17.0, *)
private struct LargeCrew: View {
  let host: String
  let computer: Snapshot.Computer
  let named: Bool

  var body: some View {
    let asking = computer.bots.filter { $0.needsYou }.prefix(2)
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text(asking.isEmpty ? "Botkins" : "Needs you").font(.system(size: 13, weight: .semibold))
        Spacer()
        if named { Text(computer.name).font(.system(size: 11)).foregroundStyle(.tertiary) }
      }
      ForEach(Array(asking), id: \.id) { bot in
        Link(destination: bot.chat.map { Links.chat($0.id, host: host) } ?? Links.bot(bot.id, host: host)) {
          HStack(spacing: 10) {
            face(bot, 34)
            VStack(alignment: .leading, spacing: 1) {
              Text(bot.name).font(.system(size: 13.5, weight: .semibold))
              Text(bot.ask ?? "Needs you").font(.system(size: 12.5)).foregroundStyle(mutedInk).lineLimit(1).privacySensitive()
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .semibold)).foregroundStyle(.tertiary)
          }
          .padding(.vertical, 7)
        }
        Divider()
      }
      Spacer(minLength: 8)
      LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 3), spacing: 12) {
        ForEach(computer.bots.prefix(asking.isEmpty ? 9 : 6), id: \.id) { bot in
          Link(destination: Links.bot(bot.id, host: host)) { CrewMember(bot: bot, size: 52) }
        }
      }
      Spacer(minLength: 0)
    }
  }
}

// ── Plans and limits ───────────────────────────────────────────────────────────────────────────

@available(iOS 17.0, *)
struct UsageEntry: TimelineEntry {
  let date: Date
  let snapshot: Snapshot?
  let configuration: UsageConfiguration
}

@available(iOS 17.0, *)
struct UsageProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> UsageEntry { UsageEntry(date: .now, snapshot: nil, configuration: UsageConfiguration()) }
  func snapshot(for configuration: UsageConfiguration, in context: Context) async -> UsageEntry { UsageEntry(date: .now, snapshot: Snapshot.load(), configuration: configuration) }
  func timeline(for configuration: UsageConfiguration, in context: Context) async -> Timeline<UsageEntry> {
    // The words change with the time ("resets 2:10 PM", "updated 5 min ago"), so it is drawn again now and then.
    Timeline(entries: [UsageEntry(date: .now, snapshot: Snapshot.load(), configuration: configuration)], policy: .after(.now.addingTimeInterval(refresh)))
  }
}

@available(iOS 17.0, *)
struct UsageWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(kind: "BotkinsUsage", intent: UsageConfiguration.self, provider: UsageProvider()) { entry in
      UsageView(entry: entry)
    }
    .configurationDisplayName("Plans and limits")
    .description("What is left of your plans.")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular, .accessoryInline])
  }
}

private struct UsageBar: View {
  let left: Double
  var height: CGFloat = 6
  var body: some View {
    GeometryReader { geometry in
      ZStack(alignment: .leading) {
        Capsule().fill(Color.primary.opacity(0.1))
        Capsule().fill(LimitWords.low(left) ? badInk : ink).frame(width: max(height, geometry.size.width * left / 100))
      }
    }
    .frame(height: height)
  }
}

@available(iOS 17.0, *)
private struct UsageView: View {
  let entry: UsageEntry
  @Environment(\.widgetFamily) private var family

  var body: some View {
    let current = entry.snapshot?.current
    let all = current?.computer.usage ?? []
    let chosen = entry.configuration.provider.flatMap { pick in all.first { $0.provider == pick.id } } ?? all.first { LimitWords.primary($0) != nil } ?? all.first
    Group {
      if let chosen {
        switch family {
        case .accessoryInline: inline(chosen)
        case .accessoryCircular: circular(chosen)
        case .accessoryRectangular: rectangular(Array(all.prefix(3)))
        case .systemMedium: medium(Array(all.prefix(3)))
        case .systemLarge: large(Array(all.prefix(3)), computer: current?.computer.name, named: (entry.snapshot?.computers.count ?? 0) > 1)
        default: small(chosen)
        }
      } else {
        VStack(spacing: 6) {
          Image(systemName: "gauge.with.dots.needle.33percent").font(.system(size: 24)).foregroundStyle(mutedInk)
          Text(entry.snapshot == nil ? "Open Botkins to pair" : "Open Botkins to load your plans").font(.system(size: 12.5)).foregroundStyle(mutedInk).multilineTextAlignment(.center)
        }
      }
    }
    .widgetURL(Links.usage(host: current?.id))
    .containerBackground(for: .widget) { Color(.systemBackground) }
  }

  private func header(_ usage: Snapshot.Usage) -> some View {
    HStack(spacing: 6) {
      ProviderMark(id: usage.provider, size: 16).foregroundStyle(ink)
      Text(LimitWords.providerName(usage)).font(.system(size: 13, weight: .semibold)).lineLimit(1)
      Spacer(minLength: 4)
      if let plan = usage.plan { Text(shortPlan(plan, usage)).font(.system(size: 11)).foregroundStyle(.tertiary).lineLimit(1) }
    }
  }

  /// "Claude Max 20x" under Claude's own mark reads "Max 20x".
  private func shortPlan(_ plan: String, _ usage: Snapshot.Usage) -> String {
    for prefix in [LimitWords.providerName(usage) + " ", "GitHub Copilot ", "ChatGPT ", "Claude "] where plan.hasPrefix(prefix) { return String(plan.dropFirst(prefix.count)) }
    return plan
  }

  @ViewBuilder private func small(_ usage: Snapshot.Usage) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      header(usage)
      Spacer(minLength: 0)
      if let limit = LimitWords.primary(usage), let left = limit.percentRemaining {
        Text(LimitWords.percent(left)).font(.system(size: 38, weight: .bold)).tracking(-1).foregroundStyle(LimitWords.low(left) ? badInk : ink).minimumScaleFactor(0.7)
        Text("of " + LimitWords.noun(limit) + " left").font(.system(size: 12.5)).foregroundStyle(mutedInk).lineLimit(1).padding(.bottom, 8)
        UsageBar(left: left)
        let tail = LimitWords.tail(usage, limit, now: entry.date)
        Text(LimitWords.counts(limit) ?? (tail.isEmpty ? " " : tail.prefix(1).uppercased() + tail.dropFirst()))
          .font(.system(size: 11)).foregroundStyle(LimitWords.stale(usage, now: entry.date) ? amberInk : Color.secondary).lineLimit(1).padding(.top, 7)
      } else if usage.account == "api-key" {
        Text("API key").font(.system(size: 15, weight: .semibold))
        Text("Billed by use").font(.system(size: 12.5)).foregroundStyle(mutedInk)
        Spacer(minLength: 0)
      } else {
        Text("Not available").font(.system(size: 15, weight: .semibold)).foregroundStyle(mutedInk)
        Spacer(minLength: 0)
      }
    }
  }

  @ViewBuilder private func medium(_ items: [Snapshot.Usage]) -> some View {
    VStack(spacing: 0) {
      ForEach(Array(items.enumerated()), id: \.element.provider) { index, usage in
        let limit = LimitWords.primary(usage)
        VStack(spacing: 5) {
          HStack(spacing: 8) {
            ProviderMark(id: usage.provider, size: 15).foregroundStyle(ink)
            Text(LimitWords.providerName(usage)).font(.system(size: 13.5, weight: .semibold)).lineLimit(1)
            Spacer(minLength: 4)
            if let left = limit?.percentRemaining {
              Text(LimitWords.percent(left)).font(.system(size: 13.5, weight: .semibold)).foregroundStyle(LimitWords.low(left) ? badInk : ink)
              Text(limit.map { LimitWords.tail(usage, $0, now: entry.date) } ?? "").font(.system(size: 11)).foregroundStyle(LimitWords.stale(usage, now: entry.date) ? amberInk : Color.secondary).frame(width: 96, alignment: .trailing).lineLimit(1)
            } else {
              Text(usage.account == "api-key" ? "API key · billed by use" : "Not available").font(.system(size: 11)).foregroundStyle(mutedInk)
            }
          }
          if let left = limit?.percentRemaining { UsageBar(left: left).padding(.leading, 23) }
        }
        if index < items.count - 1 { Spacer(minLength: 6) }
      }
    }
  }

  @ViewBuilder private func large(_ items: [Snapshot.Usage], computer: String?, named: Bool) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text("Plans and limits").font(.system(size: 15, weight: .semibold))
        Spacer()
        if named, let computer { Text(computer).font(.system(size: 11)).foregroundStyle(.tertiary) }
      }
      ForEach(Array(items.enumerated()), id: \.element.provider) { index, usage in
        VStack(alignment: .leading, spacing: 3) {
          HStack(spacing: 7) {
            ProviderMark(id: usage.provider, size: 15).foregroundStyle(ink)
            Text(usage.plan ?? LimitWords.providerName(usage)).font(.system(size: 13, weight: .semibold)).lineLimit(1)
            Spacer(minLength: 4)
            if LimitWords.stale(usage, now: entry.date), let updatedAt = usage.updatedAt {
              Text(LimitWords.ago(updatedAt, now: entry.date)).font(.system(size: 11)).foregroundStyle(amberInk)
            } else if let credits = usage.credits {
              Text(credits.label + " " + NumberFormatter.localizedString(from: NSNumber(value: credits.amount), number: .decimal)).font(.system(size: 11)).foregroundStyle(.tertiary)
            } else if let limit = LimitWords.primary(usage), let reset = limit.resetAt {
              let words = LimitWords.reset(reset, now: entry.date)
              if !words.isEmpty { Text("resets " + words).font(.system(size: 11)).foregroundStyle(.tertiary) }
            }
          }
          ForEach(usage.limits.prefix(3), id: \.id) { limit in
            HStack(spacing: 8) {
              Text(limit.label).font(.system(size: 12.5)).foregroundStyle(mutedInk).frame(width: 118, alignment: .leading).lineLimit(1)
              if limit.unlimited == true {
                Text("Unlimited").font(.system(size: 12.5)).foregroundStyle(mutedInk)
                Spacer(minLength: 0)
              } else if let left = limit.percentRemaining {
                UsageBar(left: left)
                Text(LimitWords.percent(left)).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(LimitWords.low(left) ? badInk : ink).frame(width: 40, alignment: .trailing)
              } else {
                Text("Not available").font(.system(size: 12.5)).foregroundStyle(mutedInk)
                Spacer(minLength: 0)
              }
            }
            .frame(height: 19)
          }
        }
        if index < items.count - 1 { Divider() }
      }
      Spacer(minLength: 0)
      if let error = items.compactMap({ $0.error }).first { Text(error).font(.system(size: 11)).foregroundStyle(.tertiary).lineLimit(1) }
    }
  }

  @ViewBuilder private func circular(_ usage: Snapshot.Usage) -> some View {
    if let left = LimitWords.primary(usage)?.percentRemaining {
      Gauge(value: left, in: 0...100) {
        ProviderMark(id: usage.provider, size: 14)
      } currentValueLabel: {
        Text(String(Int(left.rounded())))
      }
      .gaugeStyle(.accessoryCircularCapacity)
    } else {
      ZStack { AccessoryWidgetBackground(); ProviderMark(id: usage.provider, size: 22) }
    }
  }

  @ViewBuilder private func rectangular(_ items: [Snapshot.Usage]) -> some View {
    VStack(spacing: 4) {
      ForEach(items, id: \.provider) { usage in
        HStack(spacing: 6) {
          ProviderMark(id: usage.provider, size: 11)
          if let left = LimitWords.primary(usage)?.percentRemaining {
            Gauge(value: left, in: 0...100) { EmptyView() }.gaugeStyle(.accessoryLinearCapacity)
            Text(String(Int(left.rounded()))).font(.system(size: 12, weight: .semibold)).frame(width: 24, alignment: .trailing)
          } else {
            Text("Not available").font(.system(size: 11))
            Spacer(minLength: 0)
          }
        }
      }
    }
  }

  @ViewBuilder private func inline(_ usage: Snapshot.Usage) -> some View {
    if let limit = LimitWords.primary(usage), let left = limit.percentRemaining {
      Text(LimitWords.providerName(usage) + " · " + LimitWords.percent(left) + " of " + LimitWords.noun(limit) + " left")
    } else {
      Text(LimitWords.providerName(usage) + " · Not available")
    }
  }
}
