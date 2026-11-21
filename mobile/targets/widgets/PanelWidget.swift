// A panel of a space, on the Lock Screen and the Home Screen ("spaces-v1"; the mockup "What brings
// someone back" in design/mockups/spaces.html). It shows the panel's title and the one thing the
// panel says: a number and a short line under it (the app works that out: `panelHeadline` in
// src/state/widgetData.ts). A tap opens the panel in its space. The person picks the panel in Edit
// Widget; until they do, it is the first panel of their first pinned space.
//
// It reads the snapshot the app writes (Snapshot.swift), as the other widgets do, so it is as new as
// the last time the app ran: on the Home Screen it says when the panel last changed.
import AppIntents
import SwiftUI
import WidgetKit

private let refresh: TimeInterval = 30 * 60

@available(iOS 17.0, *)
struct PanelEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Panel"
  static let defaultQuery = PanelQuery()
  /// "<computer id>|<panel id>"
  let id: String
  let title: String
  let space: String
  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(title)", subtitle: "\(space)") }
}

@available(iOS 17.0, *)
struct PanelQuery: EntityQuery {
  func entities(for identifiers: [String]) async throws -> [PanelEntity] { all().filter { identifiers.contains($0.id) } }
  func suggestedEntities() async throws -> [PanelEntity] { all() }
  func defaultResult() async -> PanelEntity? { all().first }
  private func all() -> [PanelEntity] {
    guard let snapshot = Snapshot.load() else { return [] }
    return snapshot.ordered.flatMap { id, computer in (computer.panels ?? []).map { PanelEntity(id: id + "|" + $0.id, title: $0.title, space: $0.space) } }
  }
}

@available(iOS 17.0, *)
struct PanelConfiguration: WidgetConfigurationIntent {
  static let title: LocalizedStringResource = "Panel"
  static let description = IntentDescription("One panel of a space.")
  @Parameter(title: "Panel") var panel: PanelEntity?
}

@available(iOS 17.0, *)
struct PanelEntry: TimelineEntry {
  let date: Date
  let snapshot: Snapshot?
  let configuration: PanelConfiguration
}

@available(iOS 17.0, *)
struct PanelProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> PanelEntry { PanelEntry(date: .now, snapshot: nil, configuration: PanelConfiguration()) }
  func snapshot(for configuration: PanelConfiguration, in context: Context) async -> PanelEntry { PanelEntry(date: .now, snapshot: Snapshot.load(), configuration: configuration) }
  func timeline(for configuration: PanelConfiguration, in context: Context) async -> Timeline<PanelEntry> {
    Timeline(entries: [PanelEntry(date: .now, snapshot: Snapshot.load(), configuration: configuration)], policy: .after(.now.addingTimeInterval(refresh)))
  }
}

@available(iOS 17.0, *)
struct PanelWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(kind: "BotkinsPanel", intent: PanelConfiguration.self, provider: PanelProvider()) { entry in
      PanelWidgetView(entry: entry)
    }
    .configurationDisplayName("Panel")
    .description("One panel of a space, at a glance.")
    .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryInline])
  }
}

/// When a panel last changed, in words that stay true until the widget is drawn again: the time for today ("Updated 9:41 AM"), "Updated yesterday", else the date ("Updated Nov 20").
func updatedWords(_ at: Double, now: Date, calendar: Calendar = .current) -> String {
  let date = Date(timeIntervalSince1970: at)
  if calendar.isDate(date, inSameDayAs: now) { return "Updated " + date.formatted(date: .omitted, time: .shortened) }
  if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "Updated yesterday" }
  return "Updated " + date.formatted(.dateTime.month(.abbreviated).day())
}

@available(iOS 17.0, *)
struct PanelWidgetView: View {
  let entry: PanelEntry
  @Environment(\.widgetFamily) private var shownAs
  /// The size to draw at in a preview; a widget on a screen takes its own.
  var previewFamily: WidgetFamily? = nil
  /// The panel to draw in a preview; a widget on a screen takes the one that was picked.
  var previewPanel: Snapshot.Panel? = nil
  private var family: WidgetFamily { previewFamily ?? shownAs }

  private var found: (host: String?, panel: Snapshot.Panel)? {
    if let previewPanel { return (nil, previewPanel) }
    guard let snapshot = entry.snapshot else { return nil }
    if let id = entry.configuration.panel?.id {
      guard let picked = snapshot.panel(id) else { return nil }
      return (picked.host, picked.panel)
    }
    // Not picked yet: the first panel of the computer in use (pinned spaces come first).
    guard let current = snapshot.current, let panel = current.computer.panels?.first else { return nil }
    return (current.id, panel)
  }

  var body: some View {
    Group {
      if let found {
        content(found.panel).widgetURL(Links.panel(found.panel.id, space: found.panel.spaceId, host: found.host))
      } else {
        empty
      }
    }
    .containerBackground(for: .widget) { Color(.systemBackground) }
  }

  /// Nothing to show: not paired, no panel yet, or the picked panel is gone.
  private var emptyWords: String {
    guard let snapshot = entry.snapshot else { return "Open Botkins to pair" }
    if entry.configuration.panel != nil { return "This panel is gone" }
    return (snapshot.current?.computer.panels ?? []).isEmpty ? "Open a space in Botkins" : "Choose a panel"
  }

  @ViewBuilder private var empty: some View {
    switch family {
    case .accessoryInline: Text(emptyWords)
    case .accessoryRectangular:
      ZStack {
        AccessoryWidgetBackground()
        Text(emptyWords).font(.caption).multilineTextAlignment(.center).padding(.horizontal, 6)
      }
    default:
      VStack(spacing: 8) {
        Image(systemName: "square.grid.2x2").font(.system(size: 26)).foregroundStyle(.secondary)
        Text(emptyWords).font(.system(size: 13)).foregroundStyle(.secondary).multilineTextAlignment(.center)
      }
      .widgetURL(URL(string: "botkins://"))
    }
  }

  @ViewBuilder private func content(_ panel: Snapshot.Panel) -> some View {
    switch family {
    case .accessoryInline:
      // One line: the title, and the number or the line.
      Text([panel.title, panel.value ?? panel.note].compactMap { $0 }.joined(separator: " · ")).privacySensitive()
    case .accessoryRectangular:
      // The Lock Screen: the title, the number, the line under it.
      VStack(alignment: .leading, spacing: 0) {
        Text(panel.title).font(.caption).foregroundStyle(.secondary).lineLimit(1)
        if let value = panel.value {
          Text(value).font(.system(size: 22, weight: .bold)).lineLimit(1).minimumScaleFactor(0.6).privacySensitive()
        }
        if let note = panel.note {
          Text(note).font(.caption).fontWeight(panel.value == nil ? .regular : .semibold).lineLimit(panel.value == nil ? 2 : 1).privacySensitive()
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    default:
      // The Home Screen: whose it is, the title, the number, the line, and when it last changed.
      VStack(alignment: .leading, spacing: 0) {
        HStack(spacing: 6) {
          BotkinFace(look: Look(head: panel.head, palette: panel.palette, eyes: panel.eyes), expression: panel.eyes, size: 24)
          Text(panel.space).font(.system(size: 12, weight: .semibold)).foregroundStyle(.secondary).lineLimit(1)
          Spacer(minLength: 0)
        }
        Spacer(minLength: 4)
        Text(panel.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(.secondary).lineLimit(family == .systemMedium ? 1 : 2)
        if let value = panel.value {
          Text(value).font(.system(size: family == .systemMedium ? 34 : 28, weight: .bold)).lineLimit(1).minimumScaleFactor(0.5).privacySensitive()
        }
        if let note = panel.note {
          Text(note).font(.system(size: 12.5, weight: panel.value == nil ? .regular : .medium)).foregroundStyle(panel.value == nil ? .primary : .secondary).lineLimit(panel.value == nil ? 4 : (family == .systemMedium ? 2 : 1)).privacySensitive()
        }
        Spacer(minLength: 4)
        Text(updatedWords(panel.at, now: entry.date)).font(.system(size: 11)).foregroundStyle(.tertiary).lineLimit(1)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
  }
}
