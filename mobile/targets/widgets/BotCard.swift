// A Botkin's Live Activity ("activity-bots-v1"; docs/live-cards.md; the mockups in
// design/mockups/widgets-live-activities.html): on the Lock Screen and in the Dynamic Island.
//
// One chat: the Botkin, the model and the chat, how long it has been at it, the last steps as they
// run and the latest sentence of thinking; once done, the reply's first line. A chat that needs the
// person: what it asks, with buttons. Two or three chats: one row each. The words come from the
// sealed part (Sealed.swift); without it (previews off, or no key yet) the card shows what Apple may
// see: phases, counts and times.
import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

enum Tone {
  static let amber = Color(hex: "#F2BA4B")
  static let ok = Color(hex: "#9AD58A")
  static let bad = Color(hex: "#FF9C8A")
  static let risky = Color(hex: "#FF8C78")
  static let muted = Color.white.opacity(0.64)
  static let faint = Color.white.opacity(0.40)
  static let pill = Color.white.opacity(0.15)
}

/// The eyes for a chat's phase: a state's own expression, else the Botkin's own eyes.
func expression(_ phase: String?, own: String) -> String {
  switch phase {
  case "done": return "smile"
  case "needs-you", "thinking": return "curious"
  case "waiting": return "sleepy"
  default: return own.isEmpty ? "oval" : own
  }
}

/// SF Symbols for a step's kind (link-host/cards.mjs, stepKind).
func stepSymbol(_ kind: String) -> String {
  switch kind {
  case "run": return "apple.terminal"
  case "read": return "doc.text"
  case "edit": return "pencil"
  case "search": return "magnifyingglass"
  case "web": return "globe"
  case "helper": return "person.2"
  default: return "wrench.and.screwdriver"
  }
}

/// How long a finished turn took: "42s", "3m 12s", "1h 4m".
func tookWords(_ start: Double, _ end: Double?) -> String? {
  guard let end, end >= start else { return nil }
  let seconds = Int((end - start).rounded())
  if seconds < 60 { return "\(max(1, seconds))s" }
  if seconds < 3600 { return "\(seconds / 60)m \(seconds % 60)s" }
  return "\(seconds / 3600)h \((seconds % 3600) / 60)m"
}

/// A count that runs by itself from `start`, with no updates.
struct Running: View {
  let since: Double
  var body: some View {
    Text(timerInterval: Date(timeIntervalSince1970: since)...Date.distantFuture, countsDown: false)
      .monospacedDigit()
      .multilineTextAlignment(.trailing)
  }
}

/// A model provider's mark (assets/provider-<id>.png). Claude's and Antigravity's keep their colors; the others take the text's.
struct ProviderMark: View {
  let id: String?
  var size: CGFloat = 12
  var body: some View {
    if let id, let picture = UIImage(named: "provider-\(id).png") {
      if id == "claude" || id == "antigravity" {
        Image(uiImage: picture).resizable().interpolation(.high).scaledToFit().frame(width: size, height: size).accessibilityHidden(true)
      } else {
        Image(uiImage: picture).renderingMode(.template).resizable().interpolation(.high).scaledToFit().frame(width: size, height: size).accessibilityHidden(true)
      }
    }
  }
}

/// One of a card's buttons: an answer (an App Intent, iOS 17), or a link into the app.
struct CardButton: View {
  enum Kind { case plain, primary, risky }
  let words: String
  var symbol: String?
  var kind: Kind = .plain
  var fit = false
  var intent: AnswerIntentBox?
  var link: URL?

  var body: some View {
    let label = HStack(spacing: 5) {
      if let symbol { Image(systemName: symbol).font(.system(size: 12, weight: .semibold)) }
      Text(words).lineLimit(1).minimumScaleFactor(0.8)
    }
    .font(.system(size: 13.5, weight: .semibold))
    .foregroundStyle(kind == .plain ? Color.white : kind == .primary ? Color.black : Color(hex: "#2A0D08"))
    .padding(.horizontal, 12)
    .frame(height: 34)
    .frame(maxWidth: fit ? nil : .infinity)
    .background(Capsule().fill(kind == .plain ? Tone.pill : kind == .primary ? Color.white : Tone.risky))

    if #available(iOS 17.0, *) {
      if let intent {
        Button(intent: intent.make()) { label }.buttonStyle(.plain)
      } else if let link {
        Link(destination: link) { label }
      } else {
        label
      }
    } else if let link {
      Link(destination: link) { label }
    } else {
      label
    }
  }
}

/// An answer, made into an App Intent only on a system that has them.
struct AnswerIntentBox {
  let request: String
  let chat: String
  let card: String
  let action: String
  var value = ""
  let words: String
  let host: String?

  @available(iOS 17.0, *)
  func make() -> AnswerIntent {
    AnswerIntent(request: request, chat: chat, card: card, action: action, value: value, words: words, host: host)
  }
}

/// Everything a card's views read, worked out once.
struct CardModel {
  let about: BotkinActivityAttributes
  let state: BotkinActivityAttributes.ContentState
  let detail: CardDetail?
  let host: String?
  let models: [String: String]
  let stale: Bool

  init(_ context: ActivityViewContext<BotkinActivityAttributes>) {
    about = context.attributes
    state = context.state
    let opened = Sealed.open(context.state.sealed)
    detail = opened?.detail
    host = opened?.host
    let snapshot = Snapshot.load()
    models = (opened?.host.flatMap { snapshot?.computers[$0] } ?? snapshot?.current?.computer)?.models ?? [:]
    stale = context.isStale
  }

  var chats: [BotkinActivityAttributes.ContentState.Chat] { state.chats ?? [] }
  var first: BotkinActivityAttributes.ContentState.Chat? { chats.first }
  /// The card shows one chat in full: it has one, or the first needs the person.
  var single: Bool { chats.count == 1 || first?.phase == "needs-you" }
  var working: Int { chats.filter { $0.phase == "working" || $0.phase == "thinking" || $0.phase == "needs-you" }.count }
  var others: Int { max(0, chats.count - 1) + (state.more ?? 0) }

  func words(_ chat: BotkinActivityAttributes.ContentState.Chat) -> CardDetail.Chat? { detail?.chat(chat.id) }
  /// "Fable 5.2 · Fix login refresh", from what the phone can see.
  func subtitle(_ chat: BotkinActivityAttributes.ContentState.Chat) -> String {
    let model = words(chat)?.m.flatMap { models[$0] }
    return [model, words(chat)?.t].compactMap { $0 }.joined(separator: " · ")
  }
  func steps(_ chat: BotkinActivityAttributes.ContentState.Chat) -> String { chat.steps == 1 ? "1 step" : "\(chat.steps) steps" }
  /// What a chat is doing, in a few words: its own when the phone can read them, else the phase's.
  func label(_ chat: BotkinActivityAttributes.ContentState.Chat) -> String {
    if let words = words(chat)?.l { return words }
    switch chat.phase {
    case "needs-you": return "Needs you"
    case "thinking": return "Thinking…"
    case "done": return "Done"
    case "failed": return "Stopped"
    default: return "Working…"
    }
  }
}

// ── The Lock Screen ─────────────────────────────────────────────────────────────────────────

struct BotCardLock: View {
  let model: CardModel

  var body: some View {
    Group {
      if model.single, let first = model.first {
        SingleChat(model: model, chat: first, island: false)
      } else {
        ManyChats(model: model, island: false)
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 14)
    .environment(\.colorScheme, .dark)
  }
}

/// The header: the Botkin, its name, the model and the chat, and the time.
struct CardHeader: View {
  let model: CardModel
  let chat: BotkinActivityAttributes.ContentState.Chat
  var size: CGFloat = 44

  var body: some View {
    HStack(spacing: 11) {
      BotkinFace(look: Look(model.about), expression: expression(chat.phase, own: model.about.eyes), size: size)
        .padding(.leading, -4)
      VStack(alignment: .leading, spacing: 2) {
        Text(model.about.botName).font(.system(size: 16, weight: .semibold)).lineLimit(1)
        HStack(spacing: 5) {
          ProviderMark(id: chat.provider)
          let subtitle = model.subtitle(chat)
          if !subtitle.isEmpty { Text(subtitle).lineLimit(1) }
        }
        .font(.system(size: 12.5))
        .foregroundStyle(Tone.muted)
      }
      Spacer(minLength: 6)
      CardTime(model: model, chat: chat)
    }
  }
}

/// The time on the right: a running count, or how long it took; with the step count or the state under it.
struct CardTime: View {
  let model: CardModel
  let chat: BotkinActivityAttributes.ContentState.Chat

  var body: some View {
    VStack(alignment: .trailing, spacing: 1) {
      switch chat.phase {
      case "needs-you":
        Text("Needs you").font(.system(size: 13, weight: .semibold)).foregroundStyle(Tone.amber)
      case "done", "failed":
        HStack(spacing: 4) {
          if chat.phase == "done" { Image(systemName: "checkmark").font(.system(size: 13, weight: .bold)).foregroundStyle(Tone.ok) }
          if let took = tookWords(chat.startedAt, chat.finishedAt) {
            Text(took).font(.system(size: 16, weight: .semibold)).monospacedDigit().foregroundStyle(chat.phase == "failed" ? Tone.bad : Color.white)
          }
        }
        Text((chat.phase == "done" ? "Done" : model.label(chat)) + " · " + model.steps(chat)).font(.system(size: 11)).foregroundStyle(Tone.faint)
      default:
        Running(since: chat.startedAt).font(.system(size: 16, weight: .semibold)).frame(maxWidth: 64, alignment: .trailing)
        Text(chat.phase == "thinking" && chat.steps == 0 ? "Thinking…" : model.steps(chat)).font(.system(size: 11)).foregroundStyle(chat.phase == "thinking" ? Tone.amber : Tone.faint)
      }
    }
  }
}

/// One chat in full.
struct SingleChat: View {
  let model: CardModel
  let chat: BotkinActivityAttributes.ContentState.Chat
  let island: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if !island { CardHeader(model: model, chat: chat) }
      let words = model.words(chat)
      switch chat.phase {
      case "needs-you":
        AskBlock(model: model, chat: chat).padding(.top, island ? 4 : 9)
        if model.others > 0 {
          Text("+\(model.others) more").font(.system(size: 11)).foregroundStyle(Tone.faint).padding(.top, 6)
        }
      case "done":
        if let reply = words?.r {
          Text(reply).font(.system(size: 13)).foregroundStyle(Color.white.opacity(0.9)).lineLimit(2).padding(.top, 9)
        }
      case "failed":
        HStack(spacing: 8) {
          CardButton(words: "Open chat", symbol: "bubble.left", link: Links.chat(chat.id, host: model.host))
          CardButton(words: "Try again", symbol: "arrow.counterclockwise", kind: .primary, intent: AnswerIntentBox(request: "", chat: chat.id, card: model.about.key, action: "retry", words: "Trying again", host: model.host), link: Links.chat(chat.id, host: model.host))
        }
        .padding(.top, 10)
      default:
        Stream(model: model, chat: chat, island: island)
      }
      if model.stale && chat.phase != "done" && chat.phase != "failed" {
        Text("Open Botkins for the latest").font(.system(size: 11)).foregroundStyle(Tone.faint).padding(.top, 6)
      }
    }
  }
}

/// The last steps as they run, and the latest sentence of thinking.
struct Stream: View {
  let model: CardModel
  let chat: BotkinActivityAttributes.ContentState.Chat
  let island: Bool

  var body: some View {
    let words = model.words(chat)
    let steps = Array((words?.s ?? []).suffix(island ? 1 : 3))
    VStack(alignment: .leading, spacing: 3) {
      if steps.isEmpty {
        if words == nil || chat.phase != "thinking" {
          // Without the words: what Apple may see.
          Text(model.label(chat)).font(.system(size: 13, weight: .semibold)).lineLimit(1)
        }
      }
      ForEach(steps, id: \.self) { step in
        HStack(spacing: 8) {
          Image(systemName: stepSymbol(step.k)).font(.system(size: 11)).frame(width: 14)
          Text(step.l).lineLimit(1)
          Spacer(minLength: 4)
          if step.d == 1 {
            Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Tone.ok)
          } else if step.d == 2 {
            Image(systemName: "xmark").font(.system(size: 11, weight: .bold)).foregroundStyle(Tone.bad)
          } else if let at = step.at {
            Running(since: at).font(.system(size: 12)).foregroundStyle(Tone.muted).frame(maxWidth: 44, alignment: .trailing)
          }
        }
        .font(.system(size: 13, weight: step.d == 0 ? .semibold : .regular))
        .foregroundStyle(step.d == 0 ? Color.white : Tone.muted)
        .frame(height: 18)
      }
      if let thought = words?.th {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
          Image(systemName: "sparkle").font(.system(size: 10)).foregroundStyle(Tone.amber)
          Text(thought).italic().lineLimit(steps.isEmpty && !island ? 3 : 1)
        }
        .font(.system(size: 12.5))
        .foregroundStyle(Tone.muted)
        .padding(.top, steps.isEmpty ? 0 : 5)
      }
    }
    .padding(.top, island ? 6 : 10)
  }
}

/// What a chat asks the person, and the buttons that answer it (docs/live-cards.md, section 4: `ask`).
struct AskBlock: View {
  let model: CardModel
  let chat: BotkinActivityAttributes.ContentState.Chat

  var body: some View {
    let ask = model.words(chat)?.q
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline) {
        Text(ask?.t ?? "Open Botkins to answer").font(.system(size: 14, weight: .semibold)).lineLimit(2)
        Spacer(minLength: 4)
        if chat.ask == "risky" {
          Label("Can't be undone", systemImage: "exclamationmark.triangle").font(.system(size: 11, weight: .semibold)).foregroundStyle(Tone.bad)
        }
      }
      if let preview = ask?.p {
        Text(preview)
          .font(.system(size: 12, design: .monospaced))
          .lineLimit(1)
          .padding(.horizontal, 10)
          .padding(.vertical, 7)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.08)))
          .overlay(RoundedRectangle(cornerRadius: 10).stroke(chat.ask == "risky" ? Tone.bad.opacity(0.45) : Color.clear, lineWidth: 1))
      }
      if let sent = model.state.sent {
        Label("Sent: " + sent, systemImage: "checkmark").font(.system(size: 13, weight: .semibold)).foregroundStyle(Tone.ok).frame(height: 34)
      } else {
        AskButtons(model: model, chat: chat, ask: ask)
      }
    }
  }
}

struct AskButtons: View {
  let model: CardModel
  let chat: BotkinActivityAttributes.ContentState.Chat
  let ask: CardDetail.Ask?

  private func answer(_ action: String, _ words: String, value: String = "") -> AnswerIntentBox? {
    guard let ask else { return nil }
    return AnswerIntentBox(request: ask.id, chat: chat.id, card: model.about.key, action: action, value: value, words: words, host: model.host)
  }

  var body: some View {
    let open = Links.chat(chat.id, host: model.host)
    if let ask, chat.ask == "approve" {
      HStack(spacing: 8) {
        CardButton(words: "Deny", fit: true, intent: answer("deny", "Deny"), link: open)
        CardButton(words: "Allow once", kind: .primary, intent: answer("approve", "Allow once"), link: open)
        if ask.rm == true { CardButton(words: "Allow for this chat", intent: answer("remember", "Allow for this chat"), link: open) }
      }
    } else if let ask, chat.ask == "risky" {
      HStack(spacing: 8) {
        CardButton(words: "Deny", intent: answer("deny", "Deny"), link: open)
        // Never answered from here: the app asks for Face ID first.
        CardButton(words: "Allow once", symbol: "lock.fill", kind: .risky, link: Links.answer(request: ask.id, chat: chat.id, host: model.host))
      }
    } else if let ask, chat.ask == "question" {
      let choices = ask.ch ?? []
      let reply = CardButton(words: "Reply…", symbol: "arrowshape.turn.up.left", fit: true, link: open)
      if choices.count + (ask.free == true ? 1 : 0) <= 3 {
        HStack(spacing: 8) {
          ForEach(choices, id: \.self) { choice in CardButton(words: choice, intent: answer("answer", choice, value: choice), link: open) }
          if ask.free == true { reply }
        }
      } else {
        VStack(spacing: 6) {
          HStack(spacing: 8) {
            ForEach(choices, id: \.self) { choice in CardButton(words: choice, intent: answer("answer", choice, value: choice), link: open) }
          }
          if ask.free == true { HStack { reply; Spacer(minLength: 0) } }
        }
      }
    } else {
      HStack {
        CardButton(words: "Open to answer", symbol: chat.ask == "open" ? "lock.fill" : nil, kind: .primary, fit: true, link: open)
        Spacer(minLength: 0)
      }
    }
  }
}

/// Two or three chats: one row each. A tap on a row opens that chat.
struct ManyChats: View {
  let model: CardModel
  let island: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if !island {
        HStack(spacing: 11) {
          BotkinFace(look: Look(model.about), expression: expression(model.first?.phase, own: model.about.eyes), size: 40).padding(.leading, -4)
          VStack(alignment: .leading, spacing: 2) {
            Text(model.about.botName).font(.system(size: 16, weight: .semibold)).lineLimit(1)
            Text(chatsLine(model)).font(.system(size: 12.5)).foregroundStyle(Tone.muted)
          }
          Spacer(minLength: 0)
        }
      }
      VStack(spacing: 2) {
        ForEach(model.chats, id: \.id) { chat in
          Link(destination: Links.chat(chat.id, host: model.host)) { ChatRow(model: model, chat: chat) }
        }
        if (model.state.more ?? 0) > 0 {
          Text("+\(model.state.more ?? 0) more").font(.system(size: 11)).foregroundStyle(Tone.faint).frame(maxWidth: .infinity, alignment: .leading)
        }
      }
      .padding(.top, island ? 4 : 9)
    }
  }
}

func chatsLine(_ model: CardModel) -> String {
  let total = model.chats.count + (model.state.more ?? 0)
  return model.working > 0 ? "\(total) chats · \(model.working) working" : "\(total) chats"
}

struct ChatRow: View {
  let model: CardModel
  let chat: BotkinActivityAttributes.ContentState.Chat

  var body: some View {
    let over = chat.phase == "done" || chat.phase == "failed"
    HStack(spacing: 8) {
      ProviderMark(id: chat.provider).foregroundStyle(Tone.muted)
      Text(model.words(chat)?.t ?? "Chat").font(.system(size: 13, weight: .semibold)).foregroundStyle(over ? Tone.muted : Color.white).lineLimit(1).layoutPriority(1)
      Text(chat.phase == "done" ? "" : model.label(chat)).font(.system(size: 13)).foregroundStyle(chat.phase == "needs-you" ? Tone.amber : Tone.muted).lineLimit(1)
      Spacer(minLength: 4)
      if chat.phase == "done" {
        HStack(spacing: 3) {
          Image(systemName: "checkmark").font(.system(size: 10, weight: .bold))
          Text(tookWords(chat.startedAt, chat.finishedAt) ?? "Done").monospacedDigit()
        }
        .font(.system(size: 12.5)).foregroundStyle(Tone.ok)
      } else if chat.phase == "failed" {
        Text(tookWords(chat.startedAt, chat.finishedAt) ?? "").font(.system(size: 12.5)).monospacedDigit().foregroundStyle(Tone.bad)
      } else {
        Running(since: chat.startedAt).font(.system(size: 12.5)).foregroundStyle(Tone.muted).frame(maxWidth: 44, alignment: .trailing)
      }
    }
    .frame(height: 24)
  }
}

// ── The Dynamic Island ─────────────────────────────────────────────────────────────────────────

/// The Botkin with a small badge: the provider's mark, or a question mark when it needs the person.
struct IslandFace: View {
  let model: CardModel
  let size: CGFloat

  var body: some View {
    let first = model.first
    BotkinFace(look: Look(model.about), expression: expression(first?.phase, own: model.about.eyes), size: size)
      .overlay(alignment: .bottomTrailing) {
        if first?.phase == "needs-you" {
          Text("?").font(.system(size: size * 0.36, weight: .heavy)).foregroundStyle(.black)
            .frame(width: size * 0.5, height: size * 0.5).background(Circle().fill(Tone.amber)).offset(x: 3, y: 2)
        } else if let provider = first?.provider {
          ProviderMark(id: provider, size: size * 0.34).foregroundStyle(.white)
            .frame(width: size * 0.5, height: size * 0.5).background(Circle().fill(.black)).offset(x: 3, y: 2)
        }
      }
  }
}

struct IslandTrailing: View {
  let model: CardModel
  var body: some View {
    if let first = model.first {
      switch first.phase {
      case "needs-you": Image(systemName: "questionmark.circle.fill").foregroundStyle(Tone.amber)
      case "done": Image(systemName: "checkmark.circle.fill").foregroundStyle(Tone.ok)
      case "failed": Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Tone.bad)
      default: Running(since: first.startedAt).font(.system(size: 14, weight: .semibold)).frame(maxWidth: 46)
      }
    }
  }
}

/// The expanded island's bottom: the same as the Lock Screen, without the header the island draws in its own regions.
struct IslandBottom: View {
  let model: CardModel
  var body: some View {
    Group {
      if model.single, let first = model.first {
        VStack(alignment: .leading, spacing: 0) {
          SingleChat(model: model, chat: first, island: true)
          if first.phase == "working" || first.phase == "thinking" {
            HStack(spacing: 8) {
              CardButton(words: "Stop", symbol: "stop.fill", intent: AnswerIntentBox(request: "", chat: first.id, card: model.about.key, action: "stop", words: "Stopping", host: model.host), link: Links.chat(first.id, host: model.host))
              CardButton(words: "Open chat", kind: .primary, link: Links.chat(first.id, host: model.host))
            }
            .padding(.top, 10)
          }
        }
      } else {
        ManyChats(model: model, island: true)
      }
    }
    .padding(.horizontal, 4)
    .environment(\.colorScheme, .dark)
  }
}

/// The expanded island's middle: the name, and the chat or how many.
struct IslandCenter: View {
  let model: CardModel
  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 6) {
        Text(model.about.botName).font(.system(size: 16, weight: .semibold)).lineLimit(1)
        if model.first?.phase == "needs-you" { Text("Needs you").font(.system(size: 13, weight: .semibold)).foregroundStyle(Tone.amber) }
      }
      Text(model.single ? (model.first.flatMap { model.words($0)?.t } ?? "") : chatsLine(model)).font(.system(size: 12.5)).foregroundStyle(Tone.muted).lineLimit(1)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

struct IslandTime: View {
  let model: CardModel
  var body: some View {
    if model.single, let first = model.first {
      VStack(alignment: .trailing, spacing: 1) {
        HStack(spacing: 4) {
          ProviderMark(id: first.provider)
          if let name = model.words(first)?.m.flatMap({ model.models[$0] }) { Text(name).lineLimit(1) }
        }
        .font(.system(size: 12)).foregroundStyle(Tone.muted)
        if first.phase == "working" || first.phase == "thinking" {
          Running(since: first.startedAt).font(.system(size: 20, weight: .semibold)).frame(maxWidth: 72, alignment: .trailing)
        } else if let took = tookWords(first.startedAt, first.finishedAt) {
          Text(took).font(.system(size: 17, weight: .semibold)).monospacedDigit()
        }
      }
    }
  }
}
