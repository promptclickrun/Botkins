// The card for all Botkins ("activity-all-v1"; docs/live-cards.md), on the Lock Screen and in the
// Dynamic Island: one row per chat, whichever Botkin it belongs to, each led by its Botkin's face.
// A chat that needs the person goes on top and opens up with its buttons; the rest stay quiet, and
// only a chat that needs the person or stopped gets a colored word. Once every chat has ended, each
// row says how it ended, and the computer ends the card a few minutes later.
//
// The words come from the sealed part (Sealed.swift). A Botkin's name and look come from the card,
// else from the widgets' snapshot (Snapshot.swift), which the app keeps on this phone.
import ActivityKit
import SwiftUI
import WidgetKit

typealias CardChat = BotkinActivityAttributes.ContentState.Chat

extension CardModel {
  /// A row's Botkin: its look on the card, else the snapshot's, else none (a plain face).
  func look(_ chat: CardChat) -> Look? {
    if let head = chat.head, !head.isEmpty { return Look(head: head, palette: chat.palette ?? "original", eyes: chat.eyes ?? "oval", colors: chat.colors ?? []) }
    if let id = chat.bot, let bot = bots[id] { return Look(head: bot.head, palette: bot.palette, eyes: bot.eyes) }
    return nil
  }

  /// A row's Botkin's name: sealed on the card, else the snapshot's.
  func botName(_ chat: CardChat) -> String? { words(chat)?.b ?? chat.bot.flatMap { bots[$0]?.name } }

  var needYou: Int { chats.filter { $0.phase == "needs-you" }.count }
  var atWork: Int { chats.filter { $0.phase == "working" || $0.phase == "thinking" }.count }
  var allEnded: Bool { !chats.isEmpty && chats.allSatisfy { $0.phase == "done" || $0.phase == "failed" } }

  /// The header's left words: who needs you, who is at work, or how it all ended.
  var feedTitle: String {
    if needYou > 0 { return needYou == 1 ? "1 needs you" : "\(needYou) need you" }
    if allEnded { return chats.allSatisfy { $0.phase == "failed" } ? "Stopped" : "All done" }
    let working = chats.filter { $0.phase == "working" || $0.phase == "thinking" }
    let botkins = Set(working.map { $0.bot ?? $0.id })
    if botkins.count == 1, let first = working.first, let name = botName(first) { return name + " is at work" }
    return botkins.count == 1 ? "1 Botkin at work" : "\(botkins.count) Botkins at work"
  }

  /// The header's right words: how many others, or how long it all took.
  var feedNote: String {
    if stale && !allEnded { return "Out of date" }
    let more = state.more ?? 0
    if needYou > 0 { return atWork > 0 ? "\(atWork) still working" : (more > 0 ? "+\(more) more" : "") }
    if allEnded {
      let total = chats.count + more
      let took = tookWords(chats.map(\.startedAt).min() ?? 0, chats.compactMap(\.finishedAt).max())
      return ([total == 1 ? "1 chat" : "\(total) chats", took].compactMap { $0 }).joined(separator: " · ")
    }
    return more > 0 ? "+\(more) more" : ""
  }

  /// A row's second line: the Botkin and what it is doing, or how the chat ended.
  func feedLine(_ chat: CardChat) -> String {
    switch chat.phase {
    // The word on the right already says how it ended.
    case "done", "failed": return words(chat)?.r ?? botName(chat) ?? label(chat)
    case "needs-you": return label(chat)
    default:
      // With its steps shown under it (FeedStream), the row needn't say the current one again.
      if chats.count == 1, words(chat)?.s?.isEmpty == false, let name = botName(chat) { return name }
      return [botName(chat), label(chat)].compactMap { $0 }.joined(separator: " · ")
    }
  }
}

/// A row's Botkin, with an amber ring when its chat needs the person.
struct FeedFace: View {
  let model: CardModel
  let chat: CardChat
  let size: CGFloat

  var body: some View {
    Group {
      if let look = model.look(chat) {
        BotkinFace(look: look, expression: expression(chat.phase, own: look.eyes), size: size)
      } else {
        Circle().fill(Color(hex: "#d7984b")).frame(width: size, height: size)
      }
    }
    .overlay {
      if chat.phase == "needs-you" { Circle().stroke(Tone.amber, lineWidth: 2).padding(-2) }
    }
  }
}

/// The right end of a row: a running count, or a colored word for a chat that needs you, ended or stopped.
struct FeedStatus: View {
  let model: CardModel
  let chat: CardChat

  var body: some View {
    switch chat.phase {
    case "needs-you": chip("Your call", Tone.amber, symbol: nil)
    case "done": chip("Done", Tone.ok, symbol: "checkmark")
    case "failed": chip(model.label(chat), Tone.bad, symbol: nil)
    default: Running(since: chat.startedAt).font(.system(size: 13)).foregroundStyle(Tone.muted).frame(maxWidth: 52, alignment: .trailing)
    }
  }

  private func chip(_ words: String, _ tint: Color, symbol: String?) -> some View {
    HStack(spacing: 3) {
      if let symbol { Image(systemName: symbol).font(.system(size: 9, weight: .heavy)) }
      Text(words).lineLimit(1)
    }
    .font(.system(size: 11.5, weight: .bold))
    .foregroundStyle(tint)
    .padding(.horizontal, 8)
    .frame(height: 20)
    .background(Capsule().fill(tint.opacity(0.18)))
  }
}

/// One chat: its Botkin, its title, what it is doing (or how it ended), and the time or a word.
/// `compact` (the expanded island, which is shorter) keeps it to one line.
struct FeedRow: View {
  let model: CardModel
  let chat: CardChat
  var compact = false

  var body: some View {
    HStack(spacing: compact ? 8 : 10) {
      FeedFace(model: model, chat: chat, size: compact ? 20 : 28)
      VStack(alignment: .leading, spacing: 1) {
        // White, not the tint a Link gives its words.
        Text(model.words(chat)?.t ?? model.botName(chat) ?? "Chat").font(.system(size: 14, weight: .semibold)).foregroundStyle(Color.white).lineLimit(1)
        if !compact { Text(model.feedLine(chat)).font(.system(size: 12)).foregroundStyle(Tone.muted).lineLimit(1) }
      }
      Spacer(minLength: 6)
      FeedStatus(model: model, chat: chat)
    }
    .frame(height: compact ? 24 : 32)
  }
}

struct FeedHeader: View {
  let model: CardModel

  var body: some View {
    HStack {
      Text(model.feedTitle)
        .font(.system(size: 13, weight: .bold))
        .foregroundStyle(model.needYou > 0 ? Tone.amber : model.allEnded ? (model.feedTitle == "Stopped" ? Tone.bad : Tone.ok) : Color.white)
        .lineLimit(1)
      Spacer(minLength: 6)
      Text(model.feedNote).font(.system(size: 12.5)).foregroundStyle(Tone.muted).lineLimit(1)
    }
  }
}

/// The chat that needs the person, opened up: its Botkin and title, what it asks, and the buttons.
struct FeedAsk: View {
  let model: CardModel
  let chat: CardChat

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      // One line, so the card stays within the Lock Screen's 160 points.
      HStack(spacing: 8) {
        FeedFace(model: model, chat: chat, size: 22)
        Text(model.words(chat)?.t ?? "A chat").font(.system(size: 14, weight: .semibold)).foregroundStyle(Color.white).lineLimit(1).layoutPriority(1)
        if let name = model.botName(chat) { Text(name).font(.system(size: 12.5)).foregroundStyle(Tone.muted).lineLimit(1) }
        Spacer(minLength: 0)
      }
      AskBlock(model: model, chat: chat)
    }
  }
}

/// The other chats under a request, in one quiet line.
struct FeedStrip: View {
  let model: CardModel
  let chats: [CardChat]

  var body: some View {
    let others = chats.count + (model.state.more ?? 0)
    HStack(spacing: 6) {
      HStack(spacing: -5) {
        ForEach(Array(chats.prefix(3)), id: \.id) { chat in FeedFace(model: model, chat: chat, size: 16) }
      }
      Text(others == 1 ? (model.words(chats[0])?.t ?? "1 other chat") : "\(others) other chats").lineLimit(1)
      if others == 1, chats[0].phase == "working" || chats[0].phase == "thinking" {
        Text("·")
        Running(since: chats[0].startedAt).frame(maxWidth: 44, alignment: .leading)
      }
      Spacer(minLength: 0)
    }
    .font(.system(size: 12))
    .foregroundStyle(Tone.muted)
  }
}

/// What one chat is doing, under its row when the card has only that chat: its last two steps as
/// they run, and the latest sentence of thinking. Nothing when the phone can't read them.
struct FeedStream: View {
  let model: CardModel
  let chat: CardChat
  let island: Bool

  var body: some View {
    let words = model.words(chat)
    let steps = Array((words?.s ?? []).suffix(island ? 1 : 2))
    VStack(alignment: .leading, spacing: 2) {
      ForEach(steps, id: \.self) { step in
        HStack(spacing: 8) {
          Image(systemName: stepSymbol(step.k)).font(.system(size: 11)).frame(width: 14)
          Text(step.l).lineLimit(1)
          Spacer(minLength: 4)
          if step.d == 1 {
            Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Tone.ok)
          } else if step.d == 2 {
            Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Tone.bad)
          }
        }
        .font(.system(size: 13, weight: step.d == 0 ? .semibold : .regular))
        .foregroundStyle(step.d == 0 ? Color.white : Tone.muted)
        .frame(height: 18)
      }
      if let thought = words?.th {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
          Image(systemName: "sparkle").font(.system(size: 10)).foregroundStyle(Tone.amber)
          Text(thought).italic().lineLimit(1)
        }
        .font(.system(size: 12.5))
        .foregroundStyle(Tone.muted)
      }
    }
    .padding(.leading, 38)
  }
}

/// The rows, or the request and a line for the rest. Shared by the Lock Screen and the expanded
/// island (`island`: one-line rows, and no line for the rest under a request).
struct FeedBody: View {
  let model: CardModel
  var island = false

  var body: some View {
    if let first = model.first, first.phase == "needs-you" {
      VStack(alignment: .leading, spacing: 8) {
        FeedAsk(model: model, chat: first)
        let rest = Array(model.chats.dropFirst())
        if !rest.isEmpty && !island { FeedStrip(model: model, chats: rest) }
      }
    } else {
      VStack(alignment: .leading, spacing: island ? 2 : 4) {
        ForEach(model.chats, id: \.id) { chat in
          Link(destination: Links.chat(chat.id, host: model.host)) { FeedRow(model: model, chat: chat, compact: island) }
        }
        // One chat at work: what it is doing, step by step.
        if model.chats.count == 1, let only = model.first, only.phase == "working" || only.phase == "thinking" {
          FeedStream(model: model, chat: only, island: island)
        }
      }
    }
  }
}

// ── The Lock Screen ─────────────────────────────────────────────────────────────────────────

struct FeedLock: View {
  let model: CardModel

  var body: some View {
    VStack(alignment: .leading, spacing: 7) {
      FeedHeader(model: model)
      FeedBody(model: model)
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 12)
    .environment(\.colorScheme, .dark)
  }
}

@available(iOS 18.0, *)
struct FeedAdaptive: View {
  @Environment(\.activityFamily) private var family
  let model: CardModel

  var body: some View {
    if family == .small {
      FeedSmall(model: model)
    } else {
      FeedLock(model: model)
    }
  }
}

/// A one-chat summary for CarPlay and the Watch Smart Stack. The detailed FeedLock remains on iPhone.
struct FeedSmall: View {
  let model: CardModel

  var body: some View {
    if let chat = model.first {
      HStack(spacing: 10) {
        FeedFace(model: model, chat: chat, size: 38)
        VStack(alignment: .leading, spacing: 2) {
          Text(model.botName(chat) ?? "Botkins").font(.system(size: 15, weight: .semibold)).lineLimit(1)
          Text(model.stale ? "Open Botkins for the latest" : (model.words(chat)?.t ?? model.feedLine(chat))).font(.system(size: 12.5)).foregroundStyle(Tone.muted).lineLimit(1)
        }
        Spacer(minLength: 4)
        FeedStatus(model: model, chat: chat)
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 12)
      .environment(\.colorScheme, .dark)
    } else {
      Text("Open Botkins").font(.system(size: 15, weight: .semibold)).padding(14)
    }
  }
}

// ── The Dynamic Island ──────────────────────────────────────────────────────────────────────

/// The compact island's right side: a word when a chat needs you, a check when all ended, else how many are at work or the time.
struct FeedCompact: View {
  let model: CardModel

  var body: some View {
    if model.needYou > 0 {
      Text("Your call").font(.system(size: 13, weight: .semibold)).foregroundStyle(Tone.amber).lineLimit(1)
    } else if model.allEnded {
      Image(systemName: model.feedTitle == "Stopped" ? "exclamationmark.triangle.fill" : "checkmark.circle.fill").foregroundStyle(model.feedTitle == "Stopped" ? Tone.bad : Tone.ok)
    } else if model.atWork > 1 {
      Text("\(model.atWork)").font(.system(size: 13, weight: .bold)).monospacedDigit().frame(minWidth: 22, minHeight: 22).background(Capsule().fill(Tone.pill))
    } else if let first = model.first {
      Running(since: first.startedAt).font(.system(size: 14, weight: .semibold)).frame(maxWidth: 46)
    }
  }
}

func feedIsland(_ context: ActivityViewContext<BotkinActivityAttributes>) -> DynamicIsland {
  let model = CardModel(context)
  return DynamicIsland {
    DynamicIslandExpandedRegion(.bottom) {
      VStack(alignment: .leading, spacing: 6) {
        FeedHeader(model: model)
        FeedBody(model: model, island: true)
      }
      .padding(.horizontal, 4)
      .environment(\.colorScheme, .dark)
    }
  } compactLeading: {
    if let first = model.first { FeedFace(model: model, chat: first, size: 24) }
  } compactTrailing: {
    FeedCompact(model: model)
  } minimal: {
    if let first = model.first { FeedFace(model: model, chat: first, size: 22) }
  }
  .widgetURL(model.first.map { Links.chat($0.id, host: model.host) })
  .keylineTint(model.needYou > 0 ? Tone.amber : Color.white.opacity(0.4))
}
