// The Live Activities on the Lock Screen and in the Dynamic Island. A Botkin's card
// ("activity-bots-v1") is drawn by BotCard.swift. A chat's card (an older computer's) is drawn here:
// the bot's Botkin, its name, what it is doing in a few words, and how long it has been at it.
// Tapping opens the chat.
//
// The Botkin is drawn the way the app draws it: a picture of the head (assets/<head>-<palette>.png,
// from scripts/build-widget-assets.mjs) with the eyes on top, in the shape that fits the moment.
// A bot with its own colors is shown in its character's original ones here.
import ActivityKit
import SwiftUI
import WidgetKit

@main
struct BotkinsWidgets: WidgetBundle {
  var body: some Widget {
    BotkinLiveActivity()
    // The Home Screen and Lock Screen widgets (HomeWidgets.swift) take App Intents to set up.
    if #available(iOS 17.0, *) {
      BotkinWidget()
      CrewWidget()
      UsageWidget()
      // A panel of a space (PanelWidget.swift).
      PanelWidget()
    }
    // Control Center, the Lock Screen's buttons and the Action button (Controls.swift).
    if #available(iOS 18.0, *) {
      BotkinControl()
    }
  }
}

extension Color {
  /// "#rrggbb"
  init(hex: String) {
    var value: UInt64 = 0
    Scanner(string: hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))).scanHexInt64(&value)
    self.init(red: Double((value >> 16) & 0xff) / 255, green: Double((value >> 8) & 0xff) / 255, blue: Double(value & 0xff) / 255)
  }
}

private typealias Phase = String

private func phaseSymbol(_ phase: Phase) -> String {
  switch phase {
  case "needs-you": return "questionmark.circle.fill"
  case "done": return "checkmark.circle.fill"
  case "failed": return "exclamationmark.triangle.fill"
  case "waiting": return "clock.fill"
  case "working": return "gearshape.fill"
  default: return "ellipsis"
  }
}

private func phaseColor(_ phase: Phase) -> Color {
  switch phase {
  case "needs-you": return Color(hex: "#e0a030")
  case "done": return Color(hex: "#6a9a5b")
  case "failed": return Color(hex: "#c8553d")
  default: return .secondary
  }
}

/// The eyes for a moment: a state's own expression, else the bot's own eyes.
private func eyes(for phase: Phase, own: String) -> String {
  switch phase {
  case "done": return "smile"
  case "needs-you", "thinking": return "curious"
  case "waiting": return "sleepy"
  default: return own.isEmpty ? "oval" : own
  }
}

/// A Botkin's look: its character, palette, eyes and (for a custom palette) its four colors.
struct Look {
  let head: String
  let palette: String
  let eyes: String
  let colors: [String]

  init(head: String, palette: String, eyes: String, colors: [String] = []) {
    self.head = head
    self.palette = palette
    self.eyes = eyes
    self.colors = colors
  }

  init(_ about: BotkinActivityAttributes) {
    self.init(head: about.head, palette: about.palette, eyes: about.eyes, colors: about.colors)
  }
}

/// A Botkin: the head's picture with eyes drawn over it, in `expression` (a style of eyes).
struct BotkinFace: View {
  let look: Look
  let expression: String
  let size: CGFloat

  init(look: Look, expression: String, size: CGFloat) {
    self.look = look
    self.expression = expression
    self.size = size
  }

  /// A chat's card: the eyes for the turn's phase.
  init(about: BotkinActivityAttributes, phase: String, size: CGFloat) {
    self.init(look: Look(about), expression: eyes(for: phase, own: about.eyes), size: size)
  }

  var body: some View {
    let about = look
    let palette = UIImage(named: "\(about.head)-\(about.palette).png") == nil ? "original" : about.palette
    ZStack {
      if let picture = UIImage(named: "\(about.head)-\(palette).png") {
        if #available(iOS 18.0, *) {
          // On a tinted or clear Home Screen a Botkin draws desaturated, so its face still reads.
          Image(uiImage: picture).resizable().interpolation(.high).widgetAccentedRenderingMode(.desaturated).scaledToFit()
        } else {
          Image(uiImage: picture).resizable().interpolation(.high).scaledToFit()
        }
      } else {
        // A character this build doesn't know: a plain round face still reads as a bot.
        Circle().fill(Color(hex: "#d7984b"))
      }
      if let head = botkinHeads[about.head] {
        Canvas { context, canvas in
          let unit = canvas.width / 256
          let ink = Color(hex: about.colors.count == 4 ? about.colors[3] : (botkinPaletteInk[palette] ?? head.ink))
          let style = expression
          func place(_ x: Double, _ y: Double) -> CGPoint {
            CGPoint(x: (head.tx + head.scale * x) * unit, y: (head.ty + head.scale * y) * unit)
          }
          let scale = head.scale * unit
          for (index, x) in [head.left, head.right].enumerated() {
            let arc = style == "smile" || style == "sleepy" || (style == "wink" && index == 1)
            if arc {
              var path = Path()
              path.move(to: place(x - 9, head.y + 3))
              path.addQuadCurve(to: place(x + 9, head.y + 3), control: place(x, head.y + 3 + (style == "sleepy" ? 7 : -11)))
              context.stroke(path, with: .color(ink), style: StrokeStyle(lineWidth: max(1, 5.5 * scale), lineCap: .round))
            } else {
              let ry = style == "button" ? 8.5 : (style == "curious" && index == 1 ? 12.0 : 17.0)
              let center = place(x, style == "curious" && index == 0 ? head.y - 3 : head.y)
              context.fill(Path(ellipseIn: CGRect(x: center.x - 8.5 * scale, y: center.y - ry * scale, width: 17 * scale, height: 2 * ry * scale)), with: .color(ink))
            }
          }
        }
      }
    }
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }
}

/// How long the turn has run, counting by itself. It stops when the turn is over.
private struct Elapsed: View {
  let state: BotkinActivityAttributes.ContentState

  var body: some View {
    if state.phase == "done" || state.phase == "failed" {
      // Over: the mark, and how long it took when the computer says when it ended. Nothing counts on.
      HStack(spacing: 4) {
        if let took = took(state) {
          Text(took).monospacedDigit().foregroundStyle(.secondary)
        }
        Image(systemName: phaseSymbol(state.phase)).foregroundStyle(phaseColor(state.phase))
      }
    } else {
      Text(timerInterval: Date(timeIntervalSince1970: state.startedAt)...Date.distantFuture, countsDown: false)
        .monospacedDigit()
        .multilineTextAlignment(.trailing)
        .foregroundStyle(.secondary)
    }
  }
}

/// How long a finished turn took: "42s", "3m 12s", "1h 4m". Nil when the end isn't known.
private func took(_ state: BotkinActivityAttributes.ContentState) -> String? {
  guard let finishedAt = state.finishedAt, finishedAt >= state.startedAt else { return nil }
  let seconds = Int((finishedAt - state.startedAt).rounded())
  if seconds < 60 { return "\(max(1, seconds))s" }
  if seconds < 3600 { return "\(seconds / 60)m \(seconds % 60)s" }
  return "\(seconds / 3600)h \((seconds % 3600) / 60)m"
}

private func detail(_ state: BotkinActivityAttributes.ContentState) -> String {
  let steps = state.steps == 1 ? "1 step" : "\(state.steps) steps"
  return state.steps > 0 ? "\(state.label) · \(steps)" : state.label
}

struct BotkinLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: BotkinActivityAttributes.self) { context in
      if context.attributes.card == "bot" {
        // A Botkin's card (BotCard.swift).
        let model = CardModel(context)
        BotCardLock(model: model)
          .activityBackgroundTint(Color(white: 0.09).opacity(0.82))
          .activitySystemActionForegroundColor(.white)
          .widgetURL(model.first.map { Links.chat($0.id, host: model.host) } ?? Links.bot(context.attributes.botId, host: model.host))
      } else {
        chatCard(context)
      }
    } dynamicIsland: { context in
      context.attributes.card == "bot" ? botIsland(context) : chatIsland(context)
    }
  }

  // ── A Botkin's card in the Dynamic Island ─────────────────────────────────────────────────

  private func botIsland(_ context: ActivityViewContext<BotkinActivityAttributes>) -> DynamicIsland {
    let model = CardModel(context)
    return DynamicIsland {
      DynamicIslandExpandedRegion(.leading) {
        IslandFace(model: model, size: 48).padding(.leading, 4)
      }
      DynamicIslandExpandedRegion(.center) {
        IslandCenter(model: model)
      }
      DynamicIslandExpandedRegion(.trailing) {
        IslandTime(model: model).padding(.trailing, 4)
      }
      DynamicIslandExpandedRegion(.bottom) {
        IslandBottom(model: model)
      }
    } compactLeading: {
      IslandFace(model: model, size: 24)
    } compactTrailing: {
      IslandTrailing(model: model)
    } minimal: {
      IslandFace(model: model, size: 22)
    }
    .widgetURL(model.first.map { Links.chat($0.id, host: model.host) } ?? Links.bot(context.attributes.botId, host: model.host))
    .keylineTint(model.first?.phase == "needs-you" ? Tone.amber : phaseColor(model.state.phase))
  }

  // ── A chat's card (an older computer's) ───────────────────────────────────────────────────

  private func chatCard(_ context: ActivityViewContext<BotkinActivityAttributes>) -> some View {
      // The Lock Screen, and the banner on phones without a Dynamic Island.
      HStack(spacing: 12) {
        BotkinFace(about: context.attributes, phase: context.state.phase, size: 48)
        VStack(alignment: .leading, spacing: 2) {
          Text(context.attributes.botName).font(.headline).lineLimit(1)
          Text(detail(context.state)).font(.subheadline).foregroundStyle(context.state.phase == "needs-you" ? phaseColor("needs-you") : Color.secondary).lineLimit(1)
        }
        Spacer(minLength: 8)
        Elapsed(state: context.state).font(.subheadline).frame(maxWidth: 96, alignment: .trailing)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 14)
      .activityBackgroundTint(Color(.systemBackground).opacity(0.85))
      .widgetURL(URL(string: "botkins://chat/\(context.attributes.chatId)"))
  }

  private func chatIsland(_ context: ActivityViewContext<BotkinActivityAttributes>) -> DynamicIsland {
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          BotkinFace(about: context.attributes, phase: context.state.phase, size: 44).padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Elapsed(state: context.state).font(.subheadline).frame(maxWidth: 60, alignment: .trailing).padding(.trailing, 4)
        }
        DynamicIslandExpandedRegion(.center) {
          Text(context.attributes.botName).font(.headline).lineLimit(1)
        }
        DynamicIslandExpandedRegion(.bottom) {
          HStack(spacing: 6) {
            Image(systemName: phaseSymbol(context.state.phase)).foregroundStyle(phaseColor(context.state.phase))
            Text(detail(context.state)).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
            Spacer(minLength: 0)
          }
          .padding(.horizontal, 8)
        }
      } compactLeading: {
        BotkinFace(about: context.attributes, phase: context.state.phase, size: 22)
      } compactTrailing: {
        if context.state.phase == "thinking" || context.state.phase == "working" {
          Elapsed(state: context.state).font(.caption2).frame(maxWidth: 40)
        } else {
          Image(systemName: phaseSymbol(context.state.phase)).foregroundStyle(phaseColor(context.state.phase))
        }
      } minimal: {
        BotkinFace(about: context.attributes, phase: context.state.phase, size: 20)
      }
      .widgetURL(URL(string: "botkins://chat/\(context.attributes.chatId)"))
      .keylineTint(phaseColor(context.state.phase))
  }
}
